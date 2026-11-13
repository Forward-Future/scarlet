import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "./exec.js";
import { audition } from "./inspection.js";
import { extractFrame } from "./frame.js";
import {
  decodeWaveformCache,
  encodeWaveformCache,
  extractWaveform,
  extractWaveformFull,
  speechActivity,
  speechActivityOf,
  speechActivityStart,
  waveformFromCache,
} from "./waveform.js";

let dir: string;
let tone: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-waveform-"));
  tone = join(dir, "tone.mkv");
  // Two seconds: a full-scale tone on the left for the first, silence for the second. The right channel is silent.
  await runCapture("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=duration=2:size=64x64:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=16000",
    "-filter_complex", "[1:a]volume=8,apad=whole_dur=2,pan=stereo|c0=c0|c1=0*c0[a]", "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", tone]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a cached waveform", () => {
  // Eight samples a second, so every edge below is an exact binary fraction.
  const cache = { pointsPerSecond: 8, peaks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], rms: [0.1, 0.1, 0.3, 0.3, 0, 0, 0.4, 0.4] };

  it("keeps the loudest peak and the RMS of each bucket when it narrows", () => {
    const wf = waveformFromCache(cache, 0, 1, 4);
    expect(wf.peaks).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(wf.rms[0]).toBeCloseTo(0.1);
    expect(wf.rms[1]).toBeCloseTo(0.3);
    expect(wf.rms[2]).toBe(0);
    expect(wf.rms).toHaveLength(4);
    // One bucket over everything: the peak of all, and the RMS of the RMS values.
    const all = waveformFromCache(cache, 0, 1, 1);
    expect(all.peaks).toEqual([0.8]);
    expect(all.rms[0]).toBeCloseTo(Math.sqrt((2 * 0.01 + 2 * 0.09 + 2 * 0.16) / 8));
  });

  it("repeats a sample when asked for more points than it holds, and reads past its end as silence", () => {
    expect(waveformFromCache(cache, 0.25, 0.5, 4).peaks).toEqual([0.3, 0.3, 0.4, 0.4]);
    expect(waveformFromCache(cache, 0.75, 1.5, 3).peaks).toEqual([0.8, 0, 0]);
    // Without stored RMS the peaks still come back.
    expect(waveformFromCache({ pointsPerSecond: 8, peaks: cache.peaks }, 0, 1, 2)).toEqual({ peaks: [0.4, 0.8], rms: [0, 0] });
  });

  it("returns nothing for an empty range or for no points, whatever number says so", () => {
    const empty = { peaks: [], rms: [] };
    for (const points of [0, -1, NaN, 0.5, Infinity, -Infinity]) expect(waveformFromCache(cache, 0, 1, points)).toEqual(empty);
    expect(waveformFromCache(cache, 0.5, 0.5, 4)).toEqual(empty);
    expect(waveformFromCache(cache, 0.5, 0.25, 4)).toEqual(empty);
  });

  it("gives whole buckets for a fractional point count", () => {
    expect(waveformFromCache(cache, 0, 1, 2.9)).toEqual(waveformFromCache(cache, 0, 1, 2));
  });

  it("survives a round trip through its file form", () => {
    const original = { pointsPerSecond: 50, duration: 1.5, peaks: Float32Array.from([0, 0.25, 1]), rms: Float32Array.from([0, 0.125, 0.5]) };
    const file = encodeWaveformCache(original);
    expect(file).toHaveLength(16 + 3 * 8);
    expect(decodeWaveformCache(file)).toEqual(original);
    expect(decodeWaveformCache(encodeWaveformCache({ ...original, peaks: new Float32Array(0), rms: new Float32Array(0) })).peaks).toHaveLength(0);
  });

  it("writes silence for RMS a cache never had", () => {
    const decoded = decodeWaveformCache(encodeWaveformCache({ pointsPerSecond: 50, duration: 1, peaks: Float32Array.from([0.5, 1]), rms: new Float32Array(0) }));
    expect(Array.from(decoded.rms)).toEqual([0, 0]);
  });

  it("refuses a file that is not a waveform, or one cut short", () => {
    const file = encodeWaveformCache({ pointsPerSecond: 50, duration: 1, peaks: Float32Array.from([0.5, 1]), rms: Float32Array.from([0.5, 1]) });
    expect(() => decodeWaveformCache(Buffer.alloc(0))).toThrow("not a waveform cache");
    expect(() => decodeWaveformCache(file.subarray(0, 15))).toThrow("not a waveform cache");
    expect(() => decodeWaveformCache(Buffer.concat([Buffer.from("RIFF"), file.subarray(4)]))).toThrow("not a waveform cache");
    expect(() => decodeWaveformCache(file.subarray(0, file.length - 1))).toThrow("truncated waveform cache");
    expect(() => decodeWaveformCache(file.subarray(0, 16))).toThrow("truncated waveform cache");
  });
});

describe("a decoded waveform", () => {
  it("places a late microphone on the recording clock in the cache, a seek and an audition", async () => {
    const file = join(dir, "late-mic.mkv");
    await runCapture("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=64x64:r=20:d=2",
      "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
      "-c:v", "libx264", "-c:a", "pcm_s16le", file]);
    const cache = await extractWaveformFull(file, 2, 4);
    const heard = (rms: ArrayLike<number>) => Array.from(rms, level => level > 0.05);
    expect(heard(cache.rms).slice(0, 6)).toEqual([false, false, true, true, true, true]);
    const range = { start: 0.25, end: 1 };
    const window = await extractWaveform(file, { from: range.start, to: range.end, points: 3 });
    expect(heard(window.rms)).toEqual([false, true, true]);
    const wav = Buffer.from(await audition(file, range), "base64").subarray(44);
    expect(wav).toHaveLength(0.75 * 16000 * 2);
    expect(wav.subarray(0, 0.25 * 16000 * 2).every(byte => byte === 0)).toBe(true);
    expect(wav.subarray(0.25 * 16000 * 2).some(byte => byte !== 0)).toBe(true);
    for (const start of [0.125, 1.625]) {
      // The picture runs through both windows. The microphone has no samples in either.
      const silent = Buffer.from(await audition(file, { start, end: start + 0.25 }), "base64").subarray(44);
      expect(silent).toHaveLength(0.25 * 16000 * 2);
      expect(silent.every(byte => byte === 0)).toBe(true);
    }
  });

  it("reads one channel when asked, and the mix otherwise", async () => {
    const window = { from: 0, to: 2, points: 2 };
    const left = await extractWaveform(tone, { ...window, channel: 0 });
    const right = await extractWaveform(tone, { ...window, channel: 1 });
    const mix = await extractWaveform(tone, window);
    expect(left.peaks[0]).toBeGreaterThan(0.9);
    expect(left.rms[0]).toBeGreaterThan(0.6);
    expect(left.peaks[1]).toBe(0);
    expect(right.peaks).toEqual([0, 0]);
    // A mix halves a tone that only one side carries.
    expect(mix.peaks[0]! / left.peaks[0]!).toBeCloseTo(0.5, 1);
  });

  it("reads a range past the end of the sound as silence", async () => {
    const wf = await extractWaveform(tone, { from: 1.5, to: 3.5, points: 4 });
    expect(wf.peaks).toEqual([0, 0, 0, 0]);
    expect(wf.rms).toEqual([0, 0, 0, 0]);
  });

  it("returns nothing for no points, and whole buckets for a fractional count", async () => {
    for (const points of [0, -1, NaN, Infinity]) expect(await extractWaveform(tone, { from: 0, to: 1, points })).toEqual({ peaks: [], rms: [] });
    expect(await extractWaveform(tone, { from: 0, to: 2, points: 2.5 })).toEqual(await extractWaveform(tone, { from: 0, to: 2, points: 2 }));
  });

  it("takes a start a hair off zero, as a subtraction leaves it", async () => {
    const hair = 0.1 + 0.2 - 0.3;
    expect(hair).toBeGreaterThan(0);
    expect(await extractWaveform(tone, { from: hair, to: 1, points: 4 })).toEqual(await extractWaveform(tone, { from: 0, to: 1, points: 4 }));
    expect((await extractFrame(tone, hair, { width: 64 })).equals(await extractFrame(tone, 0, { width: 64 }))).toBe(true);
    expect(await audition(tone, { start: hair, end: 0.5 })).toBe(await audition(tone, { start: 0, end: 0.5 }));
  });

  it("refuses a window narrower than a microsecond, which ffmpeg would read as the rest of the file", async () => {
    const instant = { start: 0.3, end: 0.1 + 0.2 };
    expect(instant.end - instant.start).toBeGreaterThan(0);
    await expect(extractWaveform(tone, { from: instant.start, to: instant.end, points: 3 })).rejects.toThrow(/Invalid duration/);
    await expect(audition(tone, instant)).rejects.toThrow(/Invalid duration/);
  });

  it("measures a whole file without a known duration from the samples it decodes", async () => {
    const cache = await extractWaveformFull(tone, 0, 10);
    expect(cache.duration).toBeCloseTo(2, 2);
    expect(cache.peaks).toHaveLength(20);
    expect(Math.min(...cache.peaks.subarray(0, 10))).toBeGreaterThan(0.4);
    expect(Math.max(...cache.peaks.subarray(10))).toBe(0);
  });

  it("sizes the cache from decoded samples and stops when they exceed its budget", async () => {
    const cache = await extractWaveformFull(tone, 100, 10, { maxPoints: 20 });
    expect(cache.duration).toBeCloseTo(2, 2);
    expect(encodeWaveformCache(cache)).toHaveLength(16 + 20 * 8);
    await expect(extractWaveformFull(tone, 1, 10, { maxPoints: 8 })).rejects.toThrow("waveform cache budget");
  });

  it("reports progress to the end while it streams a whole file", async () => {
    const seen: number[] = [];
    const cache = await extractWaveformFull(tone, 2, 10, { channel: 0, onProgress: fraction => seen.push(fraction) });
    expect(cache.peaks).toHaveLength(20);
    expect(cache.peaks[0]).toBeGreaterThan(0.9);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe("speech activity", () => {
  it("starts its decode a little early so the detector has warmed up, never before the file", () => {
    expect(speechActivityStart(5)).toBeCloseTo(4.7);
    expect(speechActivityStart(0.1)).toBe(0);
  });

  it("refuses a window that is empty, backwards, negative or over a minute", async () => {
    for (const [from, to] of [[1, 1], [2, 1], [-1, 1], [0, 60.5]] as const) {
      await expect(speechActivity(tone, from, to)).rejects.toThrow("Choose a speech window up to 60 seconds.");
      await expect(speechActivityOf(new Int16Array(0), 0, from, to)).rejects.toThrow("Choose a speech window up to 60 seconds.");
    }
  });

  it("finds no speech in silence, and keeps what it finds inside the window asked for", async () => {
    expect(await speechActivityOf(new Int16Array(16000), 0, 0, 1)).toEqual([]);
    const spans = await speechActivity(tone, 0.5, 1.5);
    for (const span of spans) {
      expect(span.start).toBeGreaterThanOrEqual(0.5);
      expect(span.end).toBeLessThanOrEqual(1.5);
      expect(span.end).toBeGreaterThan(span.start);
    }
  });
});
