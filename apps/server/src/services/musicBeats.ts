/**
 * The beats, bars, tempo and energy of a piece of music, measured from its sound, as evidence for cutting to music.
 *
 * Nothing here decides a cut. The onsets are where the sound's spectrum rises (spectral flux on a short-time Fourier
 * transform), the tempo is the period those onsets repeat at (their autocorrelation), the beats are the onsets that
 * best keep that period (dynamic programming, as in Ellis 2007, "Beat Tracking by Dynamic Programming"), the bar is
 * the beat in each group of three or four where the low end hits hardest, and the sections are where the level steps
 * up or down and stays there. The sound is decoded by the bundled FFmpeg; the arithmetic is here, with no model.
 */
import { stat } from "node:fs/promises";
import { fileInDirectoryAsync, LOCAL_MEDIA_INPUT } from "@scarlet/render";
import type { MusicReading, MusicSection } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { ffmpeg, ffmpegPosition } from "../render/ffmpeg.js";
import { AnalysisCache } from "./analysisCache.js";

/** Bump when what a reading says changes: readings are kept by it. */
export const MUSIC_BEATS_VERSION = 1;
export const SAMPLE_RATE = 11025;
const FRAME = 512;
const HOP = 128;
const HOP_SECONDS = HOP / SAMPLE_RATE;
/** The longest stretch read at once. Twenty minutes of decoded sound is about 50 MB. */
export const MAX_MUSIC_SECONDS = 20 * 60;
const MIN_BPM = 40, MAX_BPM = 240;
/** Samples in each step of the fine level envelope a beat is placed on, about 1.5 ms. */
const FINE = 16;

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round1 = (x: number) => Math.round(x * 10) / 10;
const toDb = (power: number) => power > 1e-12 ? 10 * Math.log10(power) : -120;

/** Twiddle factors of a FRAME-point transform, computed once. */
const COS = Float64Array.from({ length: FRAME / 2 }, (_, k) => Math.cos(-2 * Math.PI * k / FRAME));
const SIN = Float64Array.from({ length: FRAME / 2 }, (_, k) => Math.sin(-2 * Math.PI * k / FRAME));

/** In-place radix-2 FFT of FRAME points. */
function fft(re: Float64Array, im: Float64Array) {
  const n = FRAME;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i]!, m = im[i]!;
      re[i] = re[j]!; im[i] = im[j]!;
      re[j] = r; im[j] = m;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * stride]!, wi = SIN[k * stride]!;
        const a = start + k, b = a + half;
        const tr = wr * re[b]! - wi * im[b]!, ti = wr * im[b]! + wi * re[b]!;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
      }
    }
  }
}

/** Spectral flux per frame, over every bin and over the low end alone (under about 200 Hz, where a kick sits). */
function onsetStrength(samples: Float32Array) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME));
  const bins = FRAME / 2 + 1, bass = Math.ceil(200 * FRAME / SAMPLE_RATE);
  const flux = new Float64Array(frames), low = new Float64Array(frames);
  let previous = new Float64Array(bins), current = new Float64Array(bins);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    const at = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = samples[at + i]! * window[i]!; im[i] = 0; }
    fft(re, im);
    let all = 0, under = 0;
    for (let k = 0; k < bins; k++) {
      current[k] = Math.log1p(100 * Math.hypot(re[k]!, im[k]!));
      const rise = f ? Math.max(0, current[k]! - previous[k]!) : 0;
      all += rise;
      if (k > 0 && k <= bass) under += rise;
    }
    flux[f] = all;
    low[f] = under;
    [previous, current] = [current, previous];
  }
  return { flux, low };
}

/** The envelope less its local mean, kept where it rises above it, in units of its spread. */
function normalized(envelope: Float64Array) {
  const n = envelope.length, half = Math.round(0.2 / HOP_SECONDS);
  const out = new Float64Array(n);
  let sum = 0, count = 0;
  for (let i = 0; i < Math.min(n, half); i++) { sum += envelope[i]!; count++; }
  for (let i = 0; i < n; i++) {
    if (i + half < n) { sum += envelope[i + half]!; count++; }
    if (i - half - 1 >= 0) { sum -= envelope[i - half - 1]!; count--; }
    out[i] = Math.max(0, envelope[i]! - sum / count);
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= n || 1;
  let spread = 0;
  for (const v of out) spread += (v - mean) ** 2;
  spread = Math.sqrt(spread / (n || 1)) || 1;
  for (let i = 0; i < n; i++) out[i] = out[i]! / spread;
  return out;
}

/** The beat period in frames, by autocorrelation weighted towards moderate tempos, with how clearly it repeats. */
function beatPeriod(onsets: Float64Array): { period: number; confidence: number; alternatives: number[] } | undefined {
  const n = onsets.length;
  const shortest = Math.floor(60 / MAX_BPM / HOP_SECONDS), longest = Math.ceil(60 / MIN_BPM / HOP_SECONDS);
  if (n < longest * 4) return;
  // About its mean, so steady noise, whose rises are all positive too, doesn't read as repeating at every lag.
  let mean = 0;
  for (let t = 0; t < n; t++) mean += onsets[t]!;
  mean /= n;
  const centred = onsets.map(v => v - mean);
  let zero = 0;
  for (let t = 0; t < n; t++) zero += centred[t]! * centred[t]!;
  if (!zero) return;
  const ac = new Float64Array(2 * longest + 2);
  for (let lag = 1; lag < ac.length && lag < n; lag++) {
    let s = 0;
    for (let t = 0; t + lag < n; t++) s += centred[t]! * centred[t + lag]!;
    ac[lag] = s / (n - lag) / (zero / n);
  }
  // A tempo's own lag and twice it both repeat; the prior (log-normal round 120 BPM) leans to the one a listener taps.
  const score = (lag: number) => {
    const bpm = 60 / (lag * HOP_SECONDS);
    return Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2) * (ac[lag]! + 0.5 * (ac[2 * lag] ?? 0));
  };
  let best = shortest;
  for (let lag = shortest; lag <= longest; lag++) if (score(lag) > score(best)) best = lag;
  // The peak between frames, from the parabola through it and its neighbours.
  const [a, b, c] = [ac[best - 1] ?? 0, ac[best]!, ac[best + 1] ?? 0];
  const shift = a - 2 * b + c < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / (a - 2 * b + c))) : 0;
  const period = best + shift;
  const bpm = 60 / (period * HOP_SECONDS);
  return { period, confidence: Math.max(0, Math.min(1, b)), alternatives: [bpm / 2, bpm * 2].filter(x => x >= MIN_BPM / 2 && x <= MAX_BPM * 2) };
}

/** The frames that best keep `period` while landing on onsets (Ellis's dynamic programme). */
function trackBeats(onsets: Float64Array, period: number) {
  const n = onsets.length, tightness = 100;
  const score = new Float64Array(n), from = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(2 * period);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, link = -1;
    for (let back = lo; back <= hi && t - back >= 0; back++) {
      const s = score[t - back]! - tightness * Math.log(back / period) ** 2;
      if (s > best) { best = s; link = t - back; }
    }
    score[t] = onsets[t]! + (link >= 0 ? Math.max(0, best) : 0);
    from[t] = best > 0 ? link : -1;
  }
  // End on the strongest of the last period's frames.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) if (score[t]! > score[end]!) end = t;
  const frames: number[] = [];
  for (let t = end; t >= 0; t = from[t]!) frames.push(t);
  frames.reverse();
  // A beat with no onset under it at the very start or end is the programme filling in time, not the music: trim those.
  const strong = (f: number) => onsets[f]! > 0.5;
  while (frames.length && !strong(frames[0]!)) frames.shift();
  while (frames.length && !strong(frames.at(-1)!)) frames.pop();
  return frames;
}

/** Which beat of each group of three or four the low end accents, and how clearly. */
function barPhase(beats: number[], low: Float64Array, flux: Float64Array) {
  const accent = beats.map(f => {
    let peak = 0;
    for (let d = -2; d <= 2; d++) peak = Math.max(peak, (low[f + d] ?? 0) + 0.25 * (flux[f + d] ?? 0));
    return peak;
  });
  const mean = accent.reduce((s, v) => s + v, 0) / (accent.length || 1);
  const spread = Math.sqrt(accent.reduce((s, v) => s + (v - mean) ** 2, 0) / (accent.length || 1));
  let best: { beatsPerBar: number; phase: number; contrast: number } | undefined;
  for (const beatsPerBar of [4, 3]) {
    if (beats.length < beatsPerBar * 4) continue;
    for (let phase = 0; phase < beatsPerBar; phase++) {
      let on = 0, onCount = 0, off = 0, offCount = 0;
      accent.forEach((v, i) => { if ((i - phase) % beatsPerBar === 0) { on += v; onCount++; } else { off += v; offCount++; } });
      const contrast = spread ? (on / onCount - off / offCount) / spread : 0;
      // A bar of four whose accents every second beat also fit is told apart by the first beat leading; three needs more.
      if (!best || contrast > best.contrast * (beatsPerBar === 3 ? 1.25 : 1)) best = { beatsPerBar, phase, contrast };
    }
  }
  return best;
}

/** Mean power over each step, from the samples. */
function levelSteps(samples: Float32Array, step: number) {
  const size = Math.max(1, Math.round(step * SAMPLE_RATE));
  const out: number[] = [];
  for (let at = 0; at < samples.length; at += size) {
    let sum = 0;
    const end = Math.min(samples.length, at + size);
    for (let i = at; i < end; i++) sum += samples[i]! * samples[i]!;
    out.push(sum / (end - at));
  }
  return out;
}

/**
 * The level as straight stretches: the fewest lines through the levels (dB) that fit them to within their own
 * spread, found exactly by dynamic programming. A stretch that holds is flat, a build rises, and where one line ends
 * and the next starts higher or lower is a step. Each boundary goes on the beat (or bar) nearest it within a step.
 */
function energySections(power: number[], step: number, from: number, snap: number[], levelDb: (start: number, end: number) => number, bar = 2): MusicSection[] {
  const n = power.length;
  if (!n) return [];
  // Music pulses within each bar; over a bar its level is what a listener hears as loud or quiet. A window at either
  // end stays a bar long, inside the music.
  const width = Math.min(n, Math.max(1, Math.round(bar / step)));
  const y = power.map((_, i) => {
    const a = Math.max(0, Math.min(n - width, i - (width >> 1)));
    return toDb(power.slice(a, a + width).reduce((sum, v) => sum + v, 0) / width);
  });
  // Prefix sums for a least-squares line over any stretch in constant time.
  const P = (f: (i: number) => number) => { const out = new Float64Array(n + 1); for (let i = 0; i < n; i++) out[i + 1] = out[i]! + f(i); return out; };
  const sx = P(i => i), sy = P(i => y[i]!), sxx = P(i => i * i), sxy = P(i => i * y[i]!), syy = P(i => y[i]! * y[i]!);
  const line = (a: number, b: number) => {
    const m = b - a, X = sx[b]! - sx[a]!, Y = sy[b]! - sy[a]!, XX = sxx[b]! - sxx[a]!, XY = sxy[b]! - sxy[a]!, YY = syy[b]! - syy[a]!;
    const den = m * XX - X * X, slope = den ? (m * XY - X * Y) / den : 0, icept = (Y - slope * X) / m;
    const sse = Math.max(0, YY - 2 * slope * XY - 2 * icept * Y + slope * slope * XX + 2 * slope * icept * X + m * icept * icept);
    return { slope, icept, sse };
  };
  // The spread of the level from one step to the next, as steady music has it, sets what a new stretch must explain.
  const diffs = y.slice(1).map((v, i) => Math.abs(v - y[i]!)).sort((a, b) => a - b);
  const spread = Math.max(1, (diffs[Math.floor(diffs.length / 2)] ?? 0) / 0.6745 / Math.SQRT2);
  const penalty = 6 * spread * spread * Math.log(Math.max(2, n));
  const shortest = Math.max(2, Math.round(3 / step));
  const cost = new Float64Array(n + 1).fill(Infinity), back = new Int32Array(n + 1);
  cost[0] = 0;
  for (let b = 1; b <= n; b++) {
    for (let a = 0; a < b; a++) {
      if ((b - a < shortest && !(a === 0 && b === n)) || !Number.isFinite(cost[a]!)) continue;
      const c = cost[a]! + line(a, b).sse + penalty;
      if (c < cost[b]!) { cost[b] = c; back[b] = a; }
    }
    // Too short for a stretch of its own: the recording ends inside the shortest one.
    if (!Number.isFinite(cost[b]!) && b === n) { cost[b] = line(0, n).sse; back[b] = 0; }
  }
  const edges = [n];
  for (let b = n; b > 0; b = back[b]!) edges.push(back[b]!);
  edges.reverse();
  const at = (i: number) => {
    const t = from + i * step, reach = Math.max(step, bar / 2);
    return snap.reduce<number | undefined>((best, s) => Math.abs(s - t) <= reach && (best === undefined || Math.abs(s - t) < Math.abs(best - t)) ? s : best, undefined) ?? t;
  };
  const fits = edges.slice(0, -1).map((a, k) => ({ a, b: edges[k + 1]!, ...line(a, edges[k + 1]!) }));
  const end = from + n * step;
  const starts = fits.map(({ a }, k) => k ? at(a) : from);
  return fits.map(({ b, slope, a }, k) => {
    const start = starts[k]!, stop = starts[k + 1] ?? end;
    // The step at the start, on the level as it was: the bar after the boundary against the bar before it.
    const jump = k ? levelDb(start, Math.min(end, start + bar)) - levelDb(Math.max(from, start - bar), start) : undefined;
    return { start: round3(start), end: round3(stop), levelDb: round1(levelDb(start, stop)),
      changeDb: round1(slope * (b - a - 1)), ...(jump !== undefined && { jumpDb: round1(jump) }) };
  });
}

/** Fine level envelope: mean power in steps of FINE samples. */
function fineEnvelope(samples: Float32Array) {
  const out = new Float64Array(Math.ceil(samples.length / FINE));
  for (let i = 0; i < samples.length; i++) out[(i / FINE) | 0] = out[(i / FINE) | 0]! + samples[i]! * samples[i]!;
  return out;
}

/** The mean level between two source seconds, dBFS, from the fine envelope's running sum. */
function levelReader(envelope: Float64Array, from: number) {
  const sum = new Float64Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) sum[i + 1] = sum[i]! + envelope[i]!;
  const index = (t: number) => Math.max(0, Math.min(envelope.length, Math.round((t - from) * SAMPLE_RATE / FINE)));
  return (start: number, end: number) => {
    const a = index(start), b = index(end);
    return b > a ? toDb((sum[b]! - sum[a]!) / ((b - a) * FINE)) : -120;
  };
}

/**
 * Put a beat where its sound starts: the steepest rise of the fine level within a hop or two of where the flux put it.
 * The flux of a 46 ms window peaks while a hit is still entering it, about 20 ms early, and only to the nearest hop.
 */
function placeOnAttack(envelope: Float64Array, frame: number) {
  const guess = (frame * HOP + FRAME / 2) / FINE;
  const lo = Math.max(1, Math.floor(guess - 0.03 * SAMPLE_RATE / FINE)), hi = Math.min(envelope.length - 2, Math.ceil(guess + 0.04 * SAMPLE_RATE / FINE));
  let best = Math.round(guess), rise = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const r = envelope[i + 1]! - envelope[i - 1]!;
    if (r > rise) { rise = r; best = i; }
  }
  return (best * FINE) / SAMPLE_RATE;
}

/** Measure beats, bars, tempo and sections of mono samples at SAMPLE_RATE that start at source second `from`. */
export function analyzeMusic(samples: Float32Array, from = 0): MusicReading {
  const to = round3(from + samples.length / SAMPLE_RATE);
  const step = samples.length / SAMPLE_RATE > 10 * 60 ? 1 : 0.5;
  const power = levelSteps(samples, step);
  const levels = { stepSeconds: step, db: power.map(p => round1(toDb(p))) };
  const { flux, low } = onsetStrength(samples);
  const envelope = fineEnvelope(samples);
  const level = levelReader(envelope, from);
  const onsets = normalized(flux);
  const found = beatPeriod(onsets);
  const time = (frame: number) => round3(from + placeOnAttack(envelope, frame));
  if (!found || found.confidence < 0.1) {
    return { from, to, tempo: { unclear: found ? "The onsets don't repeat at one period: the music has no steady beat here." : "Too short, or too quiet, to read a beat: give a stretch of at least 8 seconds of music." },
      beats: [], sections: energySections(power, step, from, [], level), levels };
  }
  const frames = trackBeats(onsets, found.period);
  const beats = frames.map(time);
  // Read the tempo back from the beats kept, which follow the music where the autocorrelation's period is a little off.
  const span = frames.length > 1 ? (frames.at(-1)! - frames[0]!) / (frames.length - 1) : found.period;
  const bpm = 60 / (span * HOP_SECONDS);
  const bar = barPhase(frames, normalized(low), onsets);
  const meter = !bar ? { unclear: "Too few beats to tell the bars." }
    : bar.contrast < 0.5 ? { unclear: "No beat of each group stands out in the low end: the bars can't be told from the sound." }
      : { beatsPerBar: bar.beatsPerBar, confidence: round3(Math.min(1, bar.contrast / 2)) };
  const barsClear = !!bar && !("unclear" in meter);
  const beatsPerBar = barsClear ? bar!.beatsPerBar : 4;
  const downbeats = barsClear ? beats.filter((_, i) => (i - bar!.phase) % beatsPerBar === 0) : undefined;
  return { from, to, tempo: { bpm: round1(bpm), confidence: round3(found.confidence), alternatives: found.alternatives.map(round1) },
    beatSeconds: round3(span * HOP_SECONDS), beats, meter, ...(downbeats && { downbeats }),
    sections: energySections(power, step, from, downbeats ?? beats, level,
      Math.min(4, Math.max(1, span * HOP_SECONDS * beatsPerBar))), levels };
}

/** Decode a stretch of a file's first audio stream as mono floats at SAMPLE_RATE. */
async function decode(file: string, from: number, to: number | undefined, signal: AbortSignal) {
  const pcm = await ffmpeg(["-ss", ffmpegPosition(from), ...LOCAL_MEDIA_INPUT, "-i", file, ...(to !== undefined ? ["-t", String(to - from)] : []),
    "-vn", "-map", "0:a:0", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"],
  { signal, maxStdout: Math.ceil(MAX_MUSIC_SECONDS * SAMPLE_RATE * 4 * 1.01) });
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength - pcm.byteLength % 4));
}

const readings = new WeakMap<Ctx, AnalysisCache<MusicReading>>();

/** A recording's music measured over from–to (source seconds), read once for the file as it is now. */
export async function musicBeats(ctx: Ctx, media: MediaAsset & { projectId: string }, range: { from?: number; to?: number }, signal?: AbortSignal) {
  if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "This media has no sound to read beats from.");
  const from = range.from ?? 0;
  const end = Math.min(range.to ?? media.duration ?? Infinity, media.duration ?? Infinity);
  if (Number.isFinite(end) && end <= from) throw badRequest("bad_range", `Choose a range inside 0–${(media.duration ?? 0).toFixed(2)} s.`);
  if ((Number.isFinite(end) ? end : from + MAX_MUSIC_SECONDS + 1) - from > MAX_MUSIC_SECONDS)
    throw badRequest("range_too_long", `Beats are read ${MAX_MUSIC_SECONDS / 60} minutes at a time. Give from/to inside that.`);
  const file = await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path);
  if (!file) throw notFound("source file");
  const info = await stat(file);
  let cache = readings.get(ctx);
  if (!cache) readings.set(ctx, cache = new AnalysisCache<MusicReading>(r => 400 + r.beats.length * 24 + r.levels.db.length * 16, 8 * 1024 * 1024, 2));
  const key = JSON.stringify([MUSIC_BEATS_VERSION, file, info.size, info.ctimeMs, info.mtimeMs, from, Number.isFinite(end) ? end : null]);
  // A reading someone asked for isn't stopped by a pause of the project's media work. Trash and a quit do.
  const stop = ctx.projectSignal(media.projectId);
  return cache.get(key, async work => analyzeMusic(await decode(file, from, Number.isFinite(end) ? end : undefined, AbortSignal.any([work, stop])), from),
    { signal: signal ? AbortSignal.any([signal, stop]) : stop });
}
