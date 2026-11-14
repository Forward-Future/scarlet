import { availableParallelism } from "node:os";
import { resolveVideoEncoder, type HwAccel } from "@scarlet/render";

/**
 * Decoding pictures from long 4K recordings takes several cores per FFmpeg, and a dialogue pass asks for dozens of
 * contact sheets and frames at once. On 2026-11-06 a pass's 149 picture requests ran many at a time, 30-70 s each,
 * and left the transcript it was waiting for about two cores. Picture decodes take turns, a few at a time per engine,
 * and the editor's own requests (the monitor, a frame being scrubbed) go ahead of the agent's.
 */
export class PictureLane {
  private active = 0;
  private readonly waiting: Array<{ priority: boolean; start(): void }> = [];

  /**
   * `slots` decodes run at a time, and the editor's own may take `reserved` more. On 2026-11-11 a frame the editor
   * scrubbed to waited two minutes for a slot, each held by a long decode for a pass, and the window's other requests
   * waited behind it.
   */
  constructor(readonly slots: number, readonly reserved = 1) {}

  private room(priority: boolean) { return this.active < this.slots + (priority ? this.reserved : 0); }

  async run<T>(job: () => Promise<T>, options: { priority?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const { priority = false, signal } = options;
    signal?.throwIfAborted();
    if (this.room(priority)) this.active++;
    else {
      await new Promise<void>((resolve, reject) => {
        const entry = { priority, start: () => { signal?.removeEventListener("abort", cancel); resolve(); } };
        const cancel = () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal!.reason);
        };
        // The editor's requests go after earlier ones of their own, ahead of the agent's.
        const index = priority ? this.waiting.findIndex(w => !w.priority) : -1;
        this.waiting.splice(index < 0 ? this.waiting.length : index, 0, entry);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    try {
      signal?.throwIfAborted();
      return await job();
    } finally {
      this.active--;
      // The first in line that has room: the editor's while any slot is free, the agent's while one of its own is.
      for (let index; (index = this.waiting.findIndex(w => this.room(w.priority))) >= 0;) {
        this.active++;
        this.waiting.splice(index, 1)[0]!.start();
      }
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
