import { availableParallelism } from "node:os";
import { resolveVideoEncoder, type HwAccel } from "@scarlet/render";
// Whether the machine is too busy to give a CPU decode its cores. The renderer asks it too, for the editor's own pictures.
export { machineBusy } from "@scarlet/render";

/**
 * Decoding pictures from long 4K recordings takes several cores per FFmpeg, and a dialogue pass asks for dozens of
 * contact sheets and frames at once. On 2026-11-06 a pass's 149 picture requests ran many at a time, 30-70 s each,
 * and left the transcript it was waiting for about two cores. Picture decodes take turns, a few at a time per engine,
 * and the editor's own requests (the monitor, a frame being scrubbed) go ahead of the agent's.
 */
/**
 * Whose picture it is. The editor's own (the monitor, a frame being scrubbed) has a slot kept for it; the timeline's
 * stills go ahead of the agent's but take no kept slot, so a scrub still finds one free. On 2026-11-21 a pass's frames
 * held the lane for a whole pass and the timeline's stills, each 1m40s in line, never landed between its saves.
 * "background" is the rest of a recording, read once any of it was asked about: it goes behind everything asked for.
 * On 2026-11-22 a pass's own frames and contact sheets stood in line with eight such readings of two 4K recordings.
 */
export type PicturePriority = boolean | "timeline";
/** A turn in the lane: a request's priority, or "background" for what no request asked for. */
export type LanePriority = PicturePriority | "background";
/** A frame request's `priority`: "interactive" for the editor's own, "timeline" for the timeline's stills. */
export function framePriority(query: string | undefined): PicturePriority {
  return query === "interactive" ? true : query === "timeline" ? "timeline" : false;
}
const rankOf = (priority: LanePriority = false) => priority === true ? 2 : priority === "timeline" ? 1 : priority === "background" ? -1 : 0;

/** How long after the editor's last picture they still count as looking: the gap between two frames of a scrub. */
const EDITOR_LOOKING_MS = 5_000;

export class PictureLane {
  private active = 0;
  /** The agent's decodes let in past `slots` while the editor looks, each on the GPU (`frameDecoder`). */
  private extraActive = 0;
  private readonly waiting: Array<{ rank: number; gpu: boolean; start(extra: boolean): void }> = [];
  private editorRunning = 0;
  private editorLast = -Infinity;

  /**
   * `slots` decodes run at a time, and the editor's own may take `reserved` more. On 2026-11-11 a frame the editor
   * scrubbed to waited two minutes for a slot, each held by a long decode for a pass, and the window's other requests
   * waited behind it.
   */
  constructor(readonly slots: number, readonly reserved = 1, private readonly now = () => performance.now()) {}

  private room(rank: number) { return this.active < this.slots + (rank === 2 ? this.reserved : 0); }

  /**
   * Room past the slots for one agent's decode that goes to the GPU while the editor looks. Each takes a little longer
   * on VideoToolbox than on the CPU and only a little of the cores, so one more at a time keeps the agent's pace: bursts
   * of 24 frames of a 55-minute 4K recording took 7.3 s at the median against 8.9 s, with the editor's frames among them
   * as quick (0.34 s against 0.33 s). As many again as the slots took 6.4 s, but the editor's took 0.46 s against 0.37 s
   * (2026-11-26).
   */
  private extraRoom(gpu: boolean) { return gpu && this.extraActive < 1 && this.editorLooking(); }

  /**
   * Whether the editor is looking at pictures: one of theirs is decoding, or one was in the last few seconds. A decode
   * of the agent's started meanwhile goes to the GPU where it can (`frameDecoder`), leaving the cores to the editor's.
   */
  editorLooking(): boolean {
    return this.editorRunning > 0 || this.now() - this.editorLast < EDITOR_LOOKING_MS;
  }

  /**
   * `gpu`: the job decodes on the GPU while the editor looks, so it may then run past the slots. Only a job that checks
   * `editorLooking()` as it starts and goes to the GPU when it holds should say so.
   */
  async run<T>(job: () => Promise<T>, options: { priority?: LanePriority; signal?: AbortSignal; gpu?: boolean } = {}): Promise<T> {
    const { signal } = options;
    const rank = rankOf(options.priority);
    signal?.throwIfAborted();
    if (rank === 2) {
      this.editorRunning++;
      // The editor has started looking: the agent's waiting GPU decodes can go now.
      this.admit();
    }
    try {
      return await this.take(job, rank, !!options.gpu && rank === 0, signal);
    } finally {
      if (rank === 2) { this.editorRunning--; this.editorLast = this.now(); }
    }
  }

  private async take<T>(job: () => Promise<T>, rank: number, gpu: boolean, signal: AbortSignal | undefined): Promise<T> {
    let extra = false;
    if (this.room(rank)) this.active++;
    else if (this.extraRoom(gpu)) { this.extraActive++; extra = true; }
    else {
      extra = await new Promise<boolean>((resolve, reject) => {
        const entry = { rank, gpu, start: (past: boolean) => { signal?.removeEventListener("abort", cancel); resolve(past); } };
        const cancel = () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal!.reason);
        };
        // Each request goes after earlier ones of its own rank, ahead of lower ones: the editor's, the timeline's, the
        // agent's, then what nobody asked for.
        const index = this.waiting.findIndex(w => w.rank < rank);
        this.waiting.splice(index < 0 ? this.waiting.length : index, 0, entry);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    try {
      signal?.throwIfAborted();
      return await job();
    } finally {
      if (extra) this.extraActive--; else this.active--;
      this.admit();
    }
  }

  /** Start what has room: the editor's while any slot is free, the others' while one of their own is, then GPU decodes past them. */
  private admit() {
    for (let index; (index = this.waiting.findIndex(w => this.room(w.rank))) >= 0;) {
      this.active++;
      this.waiting.splice(index, 1)[0]!.start(false);
    }
    for (let index; (index = this.waiting.findIndex(w => this.extraRoom(w.gpu))) >= 0;) {
      this.extraActive++;
      this.waiting.splice(index, 1)[0]!.start(true);
    }
  }

  /** Requests waiting for a turn. */
  get queued() { return this.waiting.length; }
}

const lanes = new Map<string, PictureLane>();

/**
 * The engine's picture lane: one per data directory, two to four decodes at a time with the machine's size. Reading
 * 24 frames spread over a 58-minute 4K recording took 3.1 s two at a time and 2.5 s three at a time on 18 cores
 * (2026-11-14).
 */
export function pictureLane(ctx: { paths: { root: string } }): PictureLane {
  let lane = lanes.get(ctx.paths.root);
  if (!lane) lanes.set(ctx.paths.root, lane = new PictureLane(Math.max(2, Math.min(4, Math.floor(availableParallelism() / 6)))));
  return lane;
}

/**
 * The hardware decoder for sampling pictures, the same one previews use: VideoToolbox on a Mac, and CUDA wherever
 * NVENC works, which means an NVIDIA GPU and driver are present. Callers retry on the CPU when it fails.
 */
export async function pictureDecoder(accel: HwAccel): Promise<"cuda" | "videotoolbox" | undefined> {
  if (accel === "none") return;
  if (accel === "videotoolbox" || (accel === "auto" && process.platform === "darwin")) return "videotoolbox";
  if (accel === "nvenc" || (accel === "auto" && await resolveVideoEncoder("auto").catch(() => "libx264") === "h264_nvenc")) return "cuda";
}

/**
 * The decoder for one source frame. An NVIDIA GPU decodes every frame, as `pictureDecoder` finds it. On a Mac the CPU
 * is quickest for one frame alone, but a frame of the agent's started while the editor looks at pictures goes to
 * VideoToolbox: the same JPEG, byte for byte, with the cores left to the editor's. While an agent asked for bursts of
 * 24 frames of a 55-minute 4K recording (a keyframe every 8 s), the editor's own frames took 1.0 s at the median and
 * 2.0 s at p95 with every frame on the CPU, and 0.51 s and 1.2 s with the agent's on VideoToolbox (0.4 s alone;
 * 2026-11-26). Each of the agent's takes a little longer there, so they go back to the CPU once the editor has looked
 * away. An HDR file's frame stays on the CPU, which tone-maps it.
 */
export async function frameDecoder(accel: HwAccel, priority: PicturePriority, lane: PictureLane, hdr?: unknown): Promise<"cuda" | "videotoolbox" | undefined> {
  const gpu = await pictureDecoder(accel);
  if (gpu === "cuda") return gpu;
  if (gpu === "videotoolbox" && priority === false && !hdr && lane.editorLooking()) return gpu;
}

/** Whether `frameDecoder` sends this frame to a Mac's media engine while the editor looks: the lane's `gpu` option. */
export async function frameGoesToGpu(accel: HwAccel, priority: PicturePriority, hdr?: unknown): Promise<boolean> {
  return priority === false && !hdr && await pictureDecoder(accel) === "videotoolbox";
}
