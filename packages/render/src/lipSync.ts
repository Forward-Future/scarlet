/**
 * How far a recording's sound runs ahead of or behind its own picture, measured from a talking face: how much the
 * mouth moves from frame to frame against how loud the sound is over the same frames. Speech is loud while the mouth
 * moves, so the two follow each other, and the shift that lines them up best is how far the sound is off. This is
 * evidence for the model: whether a shift is worth correcting is its call.
 */
import type { TimeRange } from "@scarlet/timeline";
import { FFMPEG_QUIET_ARGS, SOURCE_AUDIO_CLOCK, resolveFfmpeg, runCapture } from "./exec.js";
import { rangeInput } from "./mediaInput.js";

/** The mouth's area of the frame: [left, top, right, bottom] as fractions. */
export type CropBox = readonly [number, number, number, number];

/** Width and height the mouth is shrunk to: enough to see it open and close, small enough to compare quickly. */
const MOUTH_W = 48, MOUTH_H = 32;
/** Sound is read at this rate: loudness per frame needs no more. */
const SOUND_RATE = 8000;

export interface LipSyncReading {
  /** Seconds the sound comes before the picture: positive is heard early, negative late. */
  soundLeads: number;
  /** How closely the mouth's movement follows the sound at that shift, as a correlation (-1..1). */
  match: number;
  /** The same at no shift, as the recording plays now. */
  matchInSync: number;
  /** Frames compared. */
  frames: number;
}

/** The correlation of `a` with `b` shifted `lag` frames: `a[i]` against `b[i + lag]`. */
export function correlationAt(a: ArrayLike<number>, b: ArrayLike<number>, lag: number): number {
  const from = Math.max(0, -lag), to = Math.min(a.length, b.length - lag);
  const n = to - from;
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = from; i < to; i++) { ma += a[i]!; mb += b[i + lag]!; }
  ma /= n; mb /= n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = from; i < to; i++) {
    const x = a[i]! - ma, y = b[i + lag]! - mb;
    ab += x * y; aa += x * x; bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** The correlation of the mouth's movement with the sound's loudness at each shift from `-maxLag` to `maxLag` frames. */
export function shiftCurve(motion: ArrayLike<number>, loudness: ArrayLike<number>, maxLag: number): number[] {
  return Array.from({ length: 2 * maxLag + 1 }, (_, i) => correlationAt(motion, loudness, i - maxLag));
}

/**
 * Where a curve from `shiftCurve` peaks, to a fraction of a frame: the shift that lines the mouth and the sound up
 * best. `soundLeads` is positive when the sound comes first.
 */
export function curvePeak(curve: readonly number[], fps: number, frames: number): LipSyncReading {
  const maxLag = (curve.length - 1) / 2;
  let best = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i]! > curve[best]!) best = i;
  // The peak between frames, from the scores either side of the best whole frame.
  let fine = best;
  const before = curve[best - 1], after = curve[best + 1];
  if (before !== undefined && after !== undefined) {
    const bend = before - 2 * curve[best]! + after;
    if (bend < 0) fine = best + Math.max(-0.5, Math.min(0.5, (before - after) / (2 * bend)));
  }
  const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places + 0;
  // Motion at frame i lines up with the sound at frame i + lag: a negative lag is sound that came first.
  return { soundLeads: round(-(fine - maxLag) / fps, 3), match: round(curve[best]!, 2), matchInSync: round(curve[maxLag]!, 2), frames };
}

/** The shift between the mouth's movement and the sound's loudness that lines them up best, within `maxLag` frames either way. */
export function bestShift(motion: ArrayLike<number>, loudness: ArrayLike<number>, fps: number, maxLag: number): LipSyncReading {
  return curvePeak(shiftCurve(motion, loudness, maxLag), fps, Math.min(motion.length, loudness.length));
}

/** How much the picture inside `box` changes from each frame to the next: mean grey difference, 0 for the first frame. */
export async function mouthMotion(file: string, range: TimeRange, opts: {
  box: CropBox; width: number; height: number; fps: number; decoder?: "videotoolbox" | "cuda"; signal?: AbortSignal;
}): Promise<Float32Array> {
  const { box, width, height, fps } = opts;
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const left = even(Math.max(0, box[0]) * width), top = even(Math.max(0, box[1]) * height);
  const w = even(Math.min(width - left, (Math.min(1, box[2]) - Math.max(0, box[0])) * width));
  const h = even(Math.min(height - top, (Math.min(1, box[3]) - Math.max(0, box[1])) * height));
  // The mouth is a few hundred pixels: decoded frames come back to memory either way, so CUDA doesn't keep them.
  const hardware = opts.decoder ? ["-hwaccel", opts.decoder] : [];
  const { stdout } = await runCapture(resolveFfmpeg(), [...FFMPEG_QUIET_ARGS, "-loglevel", "error", ...hardware, ...rangeInput(file, range),
    "-map", "0:v:0", "-an", "-vf", `fps=${fps},crop=${w}:${h}:${left}:${top},scale=${MOUTH_W}:${MOUTH_H}:flags=area,format=gray`,
    "-f", "rawvideo", "-"], { signal: opts.signal, maxStderr: 64 * 1024 });
  const size = MOUTH_W * MOUTH_H, count = Math.floor(stdout.length / size);
  const motion = new Float32Array(count);
  for (let f = 1; f < count; f++) {
    let sum = 0;
    for (let p = 0, a = (f - 1) * size, b = f * size; p < size; p++) sum += Math.abs(stdout[b + p]! - stdout[a + p]!);
    motion[f] = sum / size;
  }
  return motion;
}

/** The sound's loudness over each frame of `range` at `fps`, as the log of its RMS level. */
export async function frameLoudness(file: string, range: TimeRange, opts: { fps: number; frames: number; stream?: number; signal?: AbortSignal }): Promise<Float32Array> {
  const { stdout } = await runCapture(resolveFfmpeg(), [...FFMPEG_QUIET_ARGS, "-loglevel", "error", ...rangeInput(file, range),
    "-map", `0:a:${opts.stream ?? 0}`, "-vn", "-af", SOURCE_AUDIO_CLOCK, "-ac", "1", "-ar", String(SOUND_RATE), "-f", "s16le", "-"],
    { signal: opts.signal, maxStderr: 64 * 1024 });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const loudness = new Float32Array(opts.frames);
  for (let f = 0; f < opts.frames; f++) {
    const a = Math.floor(f / opts.fps * SOUND_RATE), b = Math.min(samples.length, Math.floor((f + 1) / opts.fps * SOUND_RATE));
    let sum = 0;
    for (let i = a; i < b; i++) sum += (samples[i]! / 32768) ** 2;
    loudness[f] = Math.log(1e-4 + Math.sqrt(b > a ? sum / (b - a) : 0));
  }
  return loudness;
}

/** Measure one stretch of a recording: the mouth in `box` against the sound, shifted up to `maxShift` seconds either way. `curve` is the match at each shift, a frame apart. */
export async function lipSyncStretch(file: string, range: TimeRange, opts: {
  box: CropBox; width: number; height: number; fps: number; maxShift: number; decoder?: "videotoolbox" | "cuda"; signal?: AbortSignal;
}): Promise<LipSyncReading & { curve: number[] }> {
  let motion: Float32Array;
  try { motion = await mouthMotion(file, range, opts); }
  catch (error) {
    opts.signal?.throwIfAborted();
    if (!opts.decoder) throw error;
    motion = await mouthMotion(file, range, { ...opts, decoder: undefined });
  }
  const loudness = await frameLoudness(file, range, { fps: opts.fps, frames: motion.length, signal: opts.signal });
  const curve = shiftCurve(motion, loudness, Math.max(1, Math.round(opts.maxShift * opts.fps)));
  return { ...curvePeak(curve, opts.fps, Math.min(motion.length, loudness.length)), curve: curve.map(n => Math.round(n * 1e4) / 1e4) };
}
