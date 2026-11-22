// Scarlet's waveform cache has one bucket per 20 ms. Compare landmarks across
// the recordings with every possible offset on the other source clock.
import { round3 } from "./analysis.js";

export const syncRate = 50;

function rollingVariance(data: Float64Array, count: number, width: number) {
  const values = new Float64Array(count);
  let sum = 0, squares = 0;
  for (let i = 0; i < width; i++) {
    sum += data[i]!;
    squares += data[i]! * data[i]!;
  }
  for (let i = 0; i < count; i++) {
    values[i] = squares - sum * sum / width;
    if (i + width < data.length) {
      const prev = data[i]!, next = data[i + width]!;
      sum += next - prev;
      squares += next * next - prev * prev;
    }
  }
  return values;
}

interface Recording {
  peaks: Float64Array;
  variance: Float64Array;
  scores: Float32Array;
}

function indexRecording(samples: ArrayLike<number>, width: number): Recording {
  const peaks = samples instanceof Float64Array ? samples : Float64Array.from(samples);
  const count = peaks.length - width + 1;
  return { peaks, variance: rollingVariance(peaks, count, width), scores: new Float32Array(count) };
}

/** Start of the one distinct match for this window in the other recording, if there is one. */
function locate(window: Float64Array, { peaks, variance, scores }: Recording): number | undefined {
  const width = window.length, count = variance.length;
  const mean = window.reduce((sum, n) => sum + n, 0) / width;
  const centered = window.map(n => n - mean);
  const energy = centered.reduce((sum, n) => sum + n * n, 0);
  if (energy < 1e-8) return;
  // Independent neighboring offsets can accumulate together. Each correlation
  // retains its original summation order and float32 confidence rounding.
  const score = (dot: number, v: number) => v > 1e-8 ? dot / Math.sqrt(v * energy) : 0;
  let i = 0;
  for (; i + 3 < count; i += 4) {
    let first = 0, second = 0, third = 0, fourth = 0;
    if (variance[i]! > 1e-8 || variance[i + 1]! > 1e-8 || variance[i + 2]! > 1e-8 || variance[i + 3]! > 1e-8) {
      for (let j = 0; j < width; j++) {
        const w = centered[j]!, k = i + j;
        first += w * peaks[k]!;
        second += w * peaks[k + 1]!;
        third += w * peaks[k + 2]!;
        fourth += w * peaks[k + 3]!;
      }
    }
    scores[i] = score(first, variance[i]!);
    scores[i + 1] = score(second, variance[i + 1]!);
    scores[i + 2] = score(third, variance[i + 2]!);
    scores[i + 3] = score(fourth, variance[i + 3]!);
  }
  for (; i < count; i++) {
    let dot = 0;
    for (let j = 0; j < width; j++) dot += centered[j]! * peaks[i + j]!;
    scores[i] = score(dot, variance[i]!);
  }
  let best = 0;
  for (let i = 1; i < count; i++) if (scores[i]! > scores[best]!) best = i;
  if (scores[best]! < 0.78) return;
  let runnerUp = 0;
  for (let i = 0; i < count; i++) {
    if (Math.abs(i - best) > 2) runnerUp = Math.max(runnerUp, scores[i]!);
  }
  if (scores[best]! - runnerUp > 0.08) return best;
}

/** Choose the passage with the most variation in level in each part of the recording. */
function landmarks(source: Recording, width: number) {
  const starts: number[] = [];
  const parts = Math.min(9, Math.floor(source.peaks.length / width));
  for (let part = 0; part < parts; part++) {
    const first = Math.floor(part * source.variance.length / parts);
    const end = Math.floor((part + 1) * source.variance.length / parts) + width - 1;
    let best = first, bestActivity = 0, activity = 0;
    // Sum adjacent level changes inside each window. A window may straddle a part boundary.
    for (let i = first + 1; i < end; i++) {
      activity += (source.peaks[i]! - source.peaks[i - 1]!) ** 2;
      const start = i - width + 1;
      if (start < first) continue;
      if (activity > bestActivity) {
        best = start;
        bestActivity = activity;
      }
      activity -= (source.peaks[start + 1]! - source.peaks[start]!) ** 2;
    }
    if (source.variance[best]! > 1e-8) starts.push(best);
  }
  return starts;
}

export function matchAudio(reference: ArrayLike<number>, secondary: ArrayLike<number>) {
  const swapped = reference.length < secondary.length;
  const width = Math.min(150, Math.floor(Math.min(reference.length, secondary.length) / 3));
  if (width < 30) return null;
  const short = indexRecording(swapped ? reference : secondary, width);
  const long = indexRecording(swapped ? secondary : reference, width);

  type Match = { shortStart: number; longStart: number };
  function result(matches: Match[]) {
    if (matches.length < 2) return null;
    const offsets = matches.map(({ shortStart, longStart }) => longStart - shortStart).sort((a, b) => a - b);
    if (offsets.at(-1)! - offsets[0]! > 1) return null;
    // The same passage found from both directions is still only one piece of evidence.
    let end = -1, matchedWindows = 0;
    for (const { shortStart } of matches.sort((a, b) => a.shortStart - b.shortStart)) {
      if (shortStart < end) continue;
      matchedWindows++;
      end = shortStart + width;
    }
    if (matchedWindows < 2) return null;
    const offset = offsets[Math.floor(offsets.length / 2)]!;
    return { secondaryStartRelativeToReference: (swapped ? -offset : offset) / syncRate,
      matchedWindows, resolutionSeconds: 1 / syncRate };
  }

  const sampled: Match[] = [];
  const stride = Math.max(width, Math.floor((short.peaks.length - width) / 8));
  for (let start = 0; start + width <= short.peaks.length; start += stride) {
    const found = locate(short.peaks.subarray(start, start + width), long);
    if (found !== undefined) sampled.push({ shortStart: start, longStart: found });
  }
  if (sampled.length >= 2) return result(sampled);

  // A screen track can be silent at every sample while carrying shared sound between them.
  // Either track may be the sparse one. Check each candidate back against its source as well,
  // so a repeated passage in the longer recording cannot acquire a sync point in reverse.
  const matches: Match[] = [];
  for (const [source, target] of [[short, long], [long, short]] as const) {
    const starts = new Set(landmarks(source, width));
    if (source === short && sampled[0]) starts.add(sampled[0].shortStart);
    for (const start of starts) {
      const found = locate(source.peaks.subarray(start, start + width), target);
      if (found === undefined) continue;
      const back = locate(target.peaks.subarray(found, found + width), source);
      if (back === undefined || Math.abs(back - start) > 1) continue;
      matches.push(source === short ? { shortStart: start, longStart: found } : { shortStart: found, longStart: start });
    }
  }
  return result(matches);
}

/** One passage of the secondary recording found in the reference: `at` in secondary seconds, `offset` as matchAudio's. */
export interface SyncPoint { at: number; offset: number }

export type SyncFit =
  | { kind: "constant"; offset: number }
  /** The offset grows steadily: the secondary's clock runs at a different rate (a variable frame rate recording, a camera's own clock). */
  | { kind: "drift"; offsetAtStart: number; msPerMinute: number; secondarySpeed: number }
  /** The offset holds, then jumps: a dropout or a pause in one recording. Each part is in secondary seconds; a jump lies between one part's `to` and the next part's `from`. */
  | { kind: "steps"; parts: Array<{ from: number; to: number; offset: number; points: number }> }
  | { kind: "unclear"; reason: string };

/** Matched passages are 20 ms buckets apart at best; a slip of 1.5 buckets is the smallest this tells from noise. */
const TOLERANCE = 1.5 / syncRate;

/** Find passages of the secondary across its whole length in the reference, each searched near the last offset first. */
export function syncPoints(reference: number[] | Float64Array, secondary: number[] | Float64Array, spacingSeconds = 30): SyncPoint[] {
  const width = Math.min(150, Math.floor(Math.min(reference.length, secondary.length) / 3));
  if (width < 30) return [];
  const full = indexRecording(reference, width);
  const secondaryPeaks = secondary instanceof Float64Array ? secondary : Float64Array.from(secondary);
  const radius = 5 * syncRate;
  const spacing = Math.max(width, Math.round(spacingSeconds * syncRate));
  const points: SyncPoint[] = [];
  let last: number | undefined;
  for (let start = 0; start + width <= secondary.length; start += spacing) {
    const window = secondaryPeaks.subarray(start, start + width);
    let found: number | undefined;
    if (last !== undefined) {
      const from = Math.max(0, start + last - radius);
      const slice = full.peaks.subarray(from, Math.min(reference.length, start + last + radius + width));
      if (slice.length >= width) {
        const near = locate(window, indexRecording(slice, width));
        if (near !== undefined) found = from + near;
      }
    }
    found ??= locate(window, full);
    if (found === undefined) continue;
    last = found - start;
    points.push({ at: start / syncRate, offset: last / syncRate });
  }
  return points;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** Describe how the offset behaves across the recording: constant, a steady drift, or jumps between steady parts. */
export function fitSync(found: SyncPoint[]): SyncFit & { mismatched?: number } {
  // A passage that agrees with neither neighbour matched the wrong place: a sound that happens twice, or noise.
  const points = found.filter((p, i) => [found[i - 1], found[i + 1]].some(q => q && Math.abs(q.offset - p.offset) <= 2 * TOLERANCE));
  const mismatched = found.length - points.length;
  const fit = fitPoints(points);
  return mismatched ? { ...fit, mismatched } : fit;
}

function fitPoints(points: SyncPoint[]): SyncFit {
  if (points.length < 2) return { kind: "unclear", reason: points.length ? "Only one passage matched." : "No passage matched." };
  const offsets = points.map(p => p.offset);
  if (Math.max(...offsets) - Math.min(...offsets) <= 2 / syncRate) return { kind: "constant", offset: round3(median(offsets)) };

  // A straight line through every point: least squares, then the worst point's distance from it.
  const n = points.length;
  const meanAt = points.reduce((s, p) => s + p.at, 0) / n, meanOffset = offsets.reduce((s, o) => s + o, 0) / n;
  const spread = points.reduce((s, p) => s + (p.at - meanAt) ** 2, 0);
  if (n >= 3 && spread > 0) {
    const slope = points.reduce((s, p) => s + (p.at - meanAt) * (p.offset - meanOffset), 0) / spread;
    const intercept = meanOffset - slope * meanAt;
    if (points.every(p => Math.abs(intercept + slope * p.at - p.offset) <= TOLERANCE)) {
      return { kind: "drift", offsetAtStart: round3(intercept), msPerMinute: Math.round(slope * 60_000 * 10) / 10,
        secondarySpeed: Math.round(1e6 / (1 + slope)) / 1e6 };
    }
  }

  // Runs of agreeing points.
  const runs: SyncPoint[][] = [];
  for (const p of points) {
    const run = runs.at(-1);
    if (run && Math.abs(p.offset - median(run.map(q => q.offset))) <= TOLERANCE) run.push(p);
    else runs.push([p]);
  }
  const steady = runs.filter(r => r.length >= 2);
  if (steady.length >= 2 && steady.length <= 4 && steady.length === runs.length) {
    return { kind: "steps", parts: steady.map(r => ({ from: r[0]!.at, to: r.at(-1)!.at, offset: round3(median(r.map(q => q.offset))), points: r.length })) };
  }
  return { kind: "unclear", reason: "The matched passages disagree without a steady drift or a few steady parts." };
}
