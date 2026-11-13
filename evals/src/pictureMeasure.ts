/**
 * Measure a published video's picture against the recordings it was cut from: at regular moments, where each
 * recording sits in the published frame. Decodes one small frame per moment and recording with ffmpeg, read-only.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Timeline } from "../../packages/timeline/src/index.ts";
import { ffmpegPath } from "./evidence.ts";
import { syncedSources } from "./layout.ts";
import { locate, type Gray, type PictureSample, type Placement } from "./picture.ts";
import type { PublishedPiece } from "./published.ts";

const run = promisify(execFile);
const WIDTH = 320, HEIGHT = 180;

/** One frame as small grayscale. Seeking before the input lands on the exact frame for these codecs. */
export async function grabFrame(file: string, at: number): Promise<Gray> {
  const { stdout } = await run(ffmpegPath(), ["-v", "error", "-nostdin", "-ss", String(Math.max(0, at)), "-i", file, "-frames:v", "1",
    "-vf", `scale=${WIDTH}:${HEIGHT},format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 });
  if (stdout.length < WIDTH * HEIGHT) throw new Error(`No frame at ${at.toFixed(2)} s of ${file}.`);
  return { width: WIDTH, height: HEIGHT, data: Float32Array.from(stdout.subarray(0, WIDTH * HEIGHT)) };
}

export interface MeasureOptions {
  /** Seconds of published video between two moments. */
  every: number;
  /** The raw assembly: it says which second of each recording plays with the presenter's. */
  sync: Timeline;
  /** The original file of each recording. */
  files: ReadonlyMap<string, string>;
  progress?: (done: number, total: number) => void;
}

/**
 * Where each recording sits in the published frame, every `every` seconds of every matched piece. A moment sits at
 * least a third of a second inside its piece, clear of the cut and any transition across it.
 */
export async function measurePicture(video: string, pieces: readonly PublishedPiece[], opts: MeasureOptions): Promise<PictureSample[]> {
  const moments: Array<{ t: number; mediaId: string; source: number }> = [];
  let next = 0;
  for (const p of pieces) {
    for (let t = Math.max(next, p.finalStart + 0.34); t <= p.finalEnd - 0.34; t += opts.every) {
      moments.push({ t, mediaId: p.mediaId, source: p.sourceStart + (t - p.finalStart) * p.rate });
      next = t + opts.every;
    }
  }
  const samples: PictureSample[] = [];
  for (const [i, m] of moments.entries()) {
    const sources = syncedSources(opts.sync, m.mediaId, m.source) ?? { [m.mediaId]: m.source };
    const frame = await grabFrame(video, m.t);
    const layers: Record<string, Placement> = {};
    // The presenter first: where they sit over another picture, that part of the frame is theirs.
    const order = Object.keys(sources).sort((a, b) => Number(b === m.mediaId) - Number(a === m.mediaId));
    for (const id of order) {
      const file = opts.files.get(id);
      if (!file) continue;
      const presenter = layers[m.mediaId];
      const placed = locate(frame, await grabFrame(file, sources[id]!), id === m.mediaId ? { maxScale: 1.8 }
        : { ignore: presenter && presenter.rect.w * presenter.rect.h < 0.6 ? [presenter.rect] : [] });
      if (placed) layers[id] = placed;
    }
    samples.push({ t: Math.round(m.t * 1000) / 1000, mediaId: m.mediaId, source: Math.round(m.source * 1000) / 1000, layers });
    opts.progress?.(i + 1, moments.length);
  }
  return samples;
}
