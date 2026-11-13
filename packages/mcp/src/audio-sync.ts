// Scarlet's waveform cache has one bucket per 20 ms. Compare landmarks across
// the recordings with every possible offset on the other source clock.
export const syncRate = 50;

function rollingVariance(data: number[], count: number, width: number) {
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
  peaks: number[];
  variance: Float64Array;
  scores: Float32Array;
}

function indexRecording(peaks: number[], width: number): Recording {
  const count = peaks.length - width + 1;
  return { peaks, variance: rollingVariance(peaks, count, width), scores: new Float32Array(count) };
}

/** Start of the one distinct match for this window in the other recording, if there is one. */
function locate(window: number[], { peaks, variance, scores }: Recording): number | undefined {
  const width = window.length, count = variance.length;
  const mean = window.reduce((sum, n) => sum + n, 0) / width;
  const centered = window.map(n => n - mean);
  const energy = centered.reduce((sum, n) => sum + n * n, 0);
  if (energy < 1e-8) return;
  // Independent neighboring offsets can accumulate together. Each correlation
  // retains its original summation order and float32 confidence rounding.
  const score = (dot: number, v: number) => v > 1e-8 ? dot / Math.sqrt(v * energy) : 0;
  let i = 0;
  for (; i + 1 < count; i += 2) {
    let left = 0, right = 0;
    if (variance[i]! > 1e-8 || variance[i + 1]! > 1e-8) {
      for (let j = 0; j < width; j++) {
        const w = centered[j]!, k = i + j;
        left += w * peaks[k]!;
        right += w * peaks[k + 1]!;
      }
    }
    scores[i] = score(left, variance[i]!);
    scores[i + 1] = score(right, variance[i + 1]!);
  }
  if (i < count) {
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

export function matchAudio(reference: number[], secondary: number[]) {
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
    const found = locate(short.peaks.slice(start, start + width), long);
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
      const found = locate(source.peaks.slice(start, start + width), target);
      if (found === undefined) continue;
      const back = locate(target.peaks.slice(found, found + width), source);
      if (back === undefined || Math.abs(back - start) > 1) continue;
      matches.push(source === short ? { shortStart: start, longStart: found } : { shortStart: found, longStart: start });
    }
  }
  return result(matches);
}
