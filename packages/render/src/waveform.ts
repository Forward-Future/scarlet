/**
 * Waveforms: decode audio to 16 kHz mono PCM and bucket it into peak/RMS
 * arrays normalized to 0..1. The agent reads these to find pauses and
 * breaths; the UI draws them.
 *
 * 16 kHz keeps sibilants and breaths (most of their energy sits above 4 kHz).
 * At 8 kHz a cut edge on an "s" read as silence. Bump WAVEFORM_CACHE_VERSION
 * whenever the decode changes so cached waveforms are rebuilt.
 */
import { LOCAL_MEDIA_INPUT, SOURCE_AUDIO_CLOCK, ffSeconds, resolveFfmpeg, runCapture } from "./exec.js";

const DECODE_RATE = 16000;
export const WAVEFORM_CACHE_VERSION = 4;
// 24 hours at the engine's 50 points/second. The binary file holds two float32s per point.
export const MAX_WAVEFORM_POINTS = 24 * 60 * 60 * 50;
export const MAX_WAVEFORM_CACHE_BYTES = 16 + MAX_WAVEFORM_POINTS * 8;

export interface WaveformOptions {
  /** Source seconds. */
  from: number;
  to: number;
  /** Number of output buckets. */
  points: number;
  /** Zero-based channel to analyse; mixed down to mono when omitted. */
  channel?: number;
  ffmpegPath?: string;
  signal?: AbortSignal;
}

export interface Waveform {
  /** Peak absolute amplitude per bucket, 0..1. */
  peaks: number[];
  /** Root-mean-square amplitude per bucket, 0..1. */
  rms: number[];
}

/** A whole-file waveform at a fixed resolution, suitable for caching on disk. */
export interface WaveformCache {
  pointsPerSecond: number;
  duration: number;
  peaks: Float32Array;
  rms: Float32Array;
}

function pcmArgs(file: string, opts: { from?: number; to?: number; channel?: number }): string[] {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  if (opts.from !== undefined) args.push("-ss", ffSeconds(opts.from));
  if (opts.to !== undefined) args.push("-t", String(Math.max(0, opts.to - (opts.from ?? 0))));
  args.push(...LOCAL_MEDIA_INPUT, "-i", file, "-vn", "-map", "0:a:0");
  const filters = opts.channel === undefined ? SOURCE_AUDIO_CLOCK : `${SOURCE_AUDIO_CLOCK},pan=mono|c0=c${opts.channel}`;
  args.push("-af", filters, "-ac", "1", "-ar", String(DECODE_RATE), "-f", "s16le", "-");
  return args;
}

async function decodePcm(file: string, opts: { from?: number; to?: number; channel?: number; ffmpegPath?: string; signal?: AbortSignal }, onStdoutBytes?: (total: number) => void): Promise<Int16Array> {
  const { stdout } = await runCapture(resolveFfmpeg(opts.ffmpegPath), pcmArgs(file, opts), { signal: opts.signal, onStdoutBytes });
  // Align to 2 bytes; the Int16Array view needs an even byte offset/length.
  const len = stdout.byteLength - (stdout.byteLength % 2);
  return new Int16Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + len));
}

/** Bucket PCM samples into `points` peak/rms values. Missing samples read as silence. */
function bucket(samples: Int16Array, count: number, totalSamples = samples.length): Waveform {
  // Whole buckets only: an array cannot be -1, 2.5, NaN or endlessly long.
  const points = Math.floor(count);
  if (!Number.isFinite(points) || points <= 0) return { peaks: [], rms: [] };
  const peaks = new Array<number>(points).fill(0);
  const rms = new Array<number>(points).fill(0);
  const per = totalSamples / points;
  for (let i = 0; i < points; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    let peak = 0;
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < samples.length; j++) {
      const v = Math.abs(samples[j]!) / 32768;
      if (v > peak) peak = v;
      sum += v * v;
      n++;
    }
    peaks[i] = Math.min(1, peak);
    rms[i] = n ? Math.min(1, Math.sqrt(sum / n)) : 0;
  }
  return { peaks, rms };
}

/** Waveform for a source range, `points` buckets wide. */
export async function extractWaveform(file: string, opts: WaveformOptions): Promise<Waveform> {
  const samples = await decodePcm(file, opts);
  const expected = Math.round(Math.max(0, opts.to - opts.from) * DECODE_RATE);
  return bucket(samples, opts.points, Math.max(expected, samples.length));
}

/** Decode the whole file once at `pointsPerSecond` resolution for caching. */
export async function extractWaveformFull(
  file: string,
  duration: number,
  pointsPerSecond = 50,
  opts: { channel?: number; ffmpegPath?: string; signal?: AbortSignal; onProgress?: (fraction: number) => void; maxPoints?: number } = {},
): Promise<WaveformCache> {
  if (!Number.isInteger(pointsPerSecond) || pointsPerSecond < 1 || pointsPerSecond > DECODE_RATE) {
    throw new Error("Invalid waveform resolution.");
  }
  const maxPoints = Math.min(opts.maxPoints ?? MAX_WAVEFORM_POINTS, MAX_WAVEFORM_POINTS);
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1) throw new Error("Invalid waveform cache budget.");
  // Grow in pages as samples arrive. A container's duration is a progress estimate only.
  const pageSize = Math.min(maxPoints, 4096);
  const pages: Array<{ peaks: Float32Array; rms: Float32Array }> = [];
  let points = 0, samples = 0, count = 0, peak = 0, squares = 0;
  let end = Math.floor(DECODE_RATE / pointsPerSecond);
  let carry: number | undefined;
  const flush = () => {
    if (points >= maxPoints) throw new Error("Recording exceeds the waveform cache budget.");
    const offset = points % pageSize;
    if (!offset) pages.push({ peaks: new Float32Array(pageSize), rms: new Float32Array(pageSize) });
    const page = pages[pages.length - 1]!;
    page.peaks[offset] = peak / 32768;
    page.rms[offset] = count ? Math.sqrt(squares / count) / 32768 : 0;
    points++;
    count = peak = squares = 0;
    end = Math.floor((points + 1) * DECODE_RATE / pointsPerSecond);
  };
  const add = (value: number) => {
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
    count++;
    if (++samples === end) flush();
  };
  await runCapture(resolveFfmpeg(opts.ffmpegPath), pcmArgs(file, opts), {
    signal: opts.signal,
    onStdoutBytes: opts.onProgress && duration > 0 ? bytes => opts.onProgress!(Math.min(1, bytes / (2 * duration * DECODE_RATE))) : undefined,
    onStdoutChunk(chunk) {
      let i = 0;
      if (carry !== undefined && chunk.length) {
        add((carry | (chunk[0]! << 8)) << 16 >> 16);
        carry = undefined;
        i++;
      }
      for (; i + 1 < chunk.length; i += 2) add(chunk.readInt16LE(i));
      if (i < chunk.length) carry = chunk[i];
    },
  });
  if (count || !points) flush();
  const decoded = samples / DECODE_RATE;
  // Some AAC decoders return the rest of their final packet after the presentation has ended.
  // Only trim to a declared end within one bucket of the measured end; never pad a cache to an estimate.
  const measured = duration > 0 && duration < decoded && decoded - duration < 1 / pointsPerSecond ? duration : decoded;
  const size = Math.min(points, Math.max(1, Math.ceil(measured * pointsPerSecond)));
  const peaks = new Float32Array(size), rms = new Float32Array(size);
  for (const [i, page] of pages.entries()) {
    const at = i * pageSize;
    if (at >= size) break;
    peaks.set(page.peaks.subarray(0, size - at), at);
    rms.set(page.rms.subarray(0, size - at), at);
  }
  opts.onProgress?.(1);
  return { pointsPerSecond, duration: measured, peaks, rms };
}

/**
 * Resample a cached waveform to `points` buckets over [from, to]. Downsampling
 * keeps the max peak and the RMS of RMS values; upsampling repeats samples.
 */
export function waveformFromCache(cache: { pointsPerSecond: number; peaks: ArrayLike<number>; rms?: ArrayLike<number> }, from: number, to: number, count: number): Waveform {
  const points = Math.floor(count);
  if (!Number.isFinite(points) || points <= 0 || to <= from) return { peaks: [], rms: [] };
  const peaks = new Array<number>(points).fill(0);
  const rms = new Array<number>(points).fill(0);
  const pps = cache.pointsPerSecond;
  const per = (to - from) / points;
  for (let i = 0; i < points; i++) {
    const t0 = from + i * per;
    const t1 = t0 + per;
    const i0 = Math.max(0, Math.floor(t0 * pps));
    const i1 = Math.min(cache.peaks.length, Math.max(i0 + 1, Math.ceil(t1 * pps)));
    let peak = 0;
    let sum = 0;
    let n = 0;
    for (let j = i0; j < i1; j++) {
      const p = cache.peaks[j]!;
      if (p > peak) peak = p;
      const r = cache.rms?.[j] ?? 0;
      sum += r * r;
      n++;
    }
    peaks[i] = peak;
    rms[i] = n ? Math.sqrt(sum / n) : 0;
  }
  return { peaks, rms };
}

const CACHE_MAGIC = 0x31465753; // "SWF1" little-endian

/**
 * Compact binary form: 16-byte header (magic, pointsPerSecond, duration, count)
 * followed by float32 peaks then float32 rms. ~400 bytes/second at 50 pps.
 */
export function encodeWaveformCache(cache: WaveformCache): Buffer {
  const n = cache.peaks.length;
  if (n > MAX_WAVEFORM_POINTS) throw new Error("Recording exceeds the waveform cache budget.");
  const buf = Buffer.alloc(16 + n * 8);
  buf.writeUInt32LE(CACHE_MAGIC, 0);
  buf.writeUInt32LE(cache.pointsPerSecond, 4);
  buf.writeFloatLE(cache.duration, 8);
  buf.writeUInt32LE(n, 12);
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(cache.peaks[i]!, 16 + i * 4);
    buf.writeFloatLE(cache.rms[i] ?? 0, 16 + (n + i) * 4);
  }
  return buf;
}

export function decodeWaveformCache(buf: Buffer): WaveformCache {
  if (buf.length < 16 || buf.readUInt32LE(0) !== CACHE_MAGIC) throw new Error("not a waveform cache");
  const pointsPerSecond = buf.readUInt32LE(4);
  const duration = buf.readFloatLE(8);
  const n = buf.readUInt32LE(12);
  if (n > MAX_WAVEFORM_POINTS) throw new Error("Recording exceeds the waveform cache budget.");
  if (buf.length < 16 + n * 8) throw new Error("truncated waveform cache");
  const peaks = new Float32Array(n);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    peaks[i] = buf.readFloatLE(16 + i * 4);
    rms[i] = buf.readFloatLE(16 + (n + i) * 4);
  }
  return { pointsPerSecond, duration, peaks, rms };
}

let vadFactory: ReturnType<typeof loadVad> | undefined;
async function loadVad() {
  const { default: create, VADMode, VADEvent } = await import("@ozymandiasthegreat/vad/lib/embedded.js");
  return { Detector: await create(), mode: VADMode.NORMAL, voice: VADEvent.VOICE };
}

/** WebRTC VAD over 20 ms frames. Warm up on the preceding audio, then return
 * source-time speech spans for this window only. Each decode has independent state. */
export async function speechActivity(file: string, from: number, to: number, signal?: AbortSignal) {
  if (from < 0 || to <= from || to > from + 60) throw new Error("Choose a speech window up to 60 seconds.");
  const start = speechActivityStart(from);
  return speechActivityOf(await decodePcm(file, { from: start, to, signal }), start, from, to);
}

/** Where the audio for a speech window starts: the detector warms up on the 0.3 s before it. */
export function speechActivityStart(from: number) {
  return Math.max(0, from - 0.3);
}

/** The same from audio already decoded: `pcm` is 16 kHz mono from `start` (see `speechActivityStart`) to `to`. */
export async function speechActivityOf(pcm: Int16Array, start: number, from: number, to: number) {
  if (from < 0 || to <= from || to > from + 60) throw new Error("Choose a speech window up to 60 seconds.");
  const { Detector, mode, voice } = await (vadFactory ??= loadVad());
  const detector = new Detector(mode, DECODE_RATE);
  const frame = new Int16Array(DECODE_RATE / 50);
  const spans: Array<{ start: number; end: number }> = [];
  let active: { start: number; end: number } | undefined;
  try {
    for (let i = 0; i < pcm.length; i += frame.length) {
      frame.fill(0);
      frame.set(pcm.subarray(i, i + frame.length));
      const result = detector.processFrame(frame);
      if (result < 0) throw new Error("Speech detector could not classify this audio.");
      const a = Math.max(from, start + i / DECODE_RATE);
      const b = Math.min(to, start + Math.min(pcm.length, i + frame.length) / DECODE_RATE);
      if (result !== voice) { active = undefined; continue; }
      if (a >= b) continue;
      if (active) active.end = b;
      else { active = { start: a, end: b }; spans.push(active); }
    }
  } finally { detector.destroy(); }
  return spans;
}
