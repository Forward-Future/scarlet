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

  constructor(readonly slots: number) {}

  async run<T>(job: () => Promise<T>, options: { priority?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const { priority = false, signal } = options;
    signal?.throwIfAborted();
    if (this.active >= this.slots) {
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
    } else this.active++;
    try {
      signal?.throwIfAborted();
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next.start();
      else this.active--;
    }
  }

  /** Requests waiting for a turn. */
  get queued() { return this.waiting.length; }
}

const lanes = new Map<string, PictureLane>();

/** The engine's picture lane: one per data directory, two to four decodes at a time with the machine's size. */
export function pictureLane(ctx: { paths: { root: string } }): PictureLane {
  let lane = lanes.get(ctx.paths.root);
  if (!lane) lanes.set(ctx.paths.root, lane = new PictureLane(Math.max(2, Math.min(4, Math.floor(availableParallelism() / 8)))));
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
