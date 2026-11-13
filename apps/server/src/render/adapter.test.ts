import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip, makeTrack, type Project, type Timeline } from "@scarlet/timeline";
import { fallbackAdapter as adapter } from "./adapter.js";
import { ffmpeg } from "./ffmpeg.js";

let root: string;
let project: Project;
const file = (name: string) => join(root, name);
const lavfi = (source: string) => ["-f", "lavfi", "-i", source];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "scarlet-adapter-test-"));
  // Two seconds each. Red has a loud tone for its first second and silence after; blue is silent throughout.
  await ffmpeg([...lavfi("color=red:size=320x180:rate=25:duration=2"), ...lavfi("aevalsrc=0.5*sin(2*PI*440*t)*lt(t\\,1):d=2:s=48000"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", file("red.mp4")]);
  await ffmpeg([...lavfi("color=blue:size=320x180:rate=25:duration=2"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file("blue.mp4")]);
  await ffmpeg([...lavfi("aevalsrc=0.5*sin(2*PI*440*t)*lt(t\\,1):d=2:s=48000"), "-c:a", "pcm_s16le", "-y", file("voice.wav")]);
  await ffmpeg([...lavfi("color=green@0.5:size=64x36,format=rgba"), "-frames:v", "1", "-y", file("logo.png")]);
  writeFileSync(file("notes.txt"), "not media");
  project = createProject("Fallback", { width: 320, height: 180, fps: 25 });
  project.media.push(
    { id: "red", kind: "video", name: "Red", path: "red.mp4", duration: 2, hasAudio: true },
    { id: "blue", kind: "video", name: "Blue", path: "blue.mp4", duration: 2, hasAudio: false },
    { id: "voice", kind: "audio", name: "Voice", path: "voice.wav", duration: 2 },
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The colour of a file's picture at a time, as [r, g, b], and whether it has sound there. */
async function at(path: string, t: number) {
  const pixel = await ffmpeg(["-ss", String(t), "-i", path, "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  const pcm = await ffmpeg(["-ss", String(t), "-t", "0.2", "-i", path, "-vn", "-ac", "1", "-f", "s16le", "pipe:1"]);
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  const [r, g, b] = pixel;
  const colour = r! > 150 && b! < 100 ? "red" : b! > 150 && r! < 100 ? "blue" : r! < 40 && g! < 40 && b! < 40 ? "black" : `${r},${g},${b}`;
  return `${colour}, ${peak > 2000 ? "sound" : "silent"}`;
}

/** A file's length, to the tenth of a second an encoder's padding can add. */
async function lasts(path: string, seconds: number) {
  const { duration } = await adapter.probeMedia(path);
  expect(Math.abs(duration - seconds)).toBeLessThan(0.1);
}

it("probes what a file is: footage, sound, or a still picture", async () => {
  expect(await adapter.probeMedia(file("red.mp4"))).toEqual({ duration: expect.closeTo(2, 1), fps: 25, width: 320, height: 180, hasAudio: true, hasAlpha: false,
    kind: "video", originalPlaybackType: 'video/mp4; codecs="avc1,mp4a.40.2"' });
  expect(await adapter.probeMedia(file("blue.mp4"))).toMatchObject({ kind: "video", hasAudio: false, originalPlaybackType: 'video/mp4; codecs="avc1"' });
  expect(await adapter.probeMedia(file("voice.wav"))).toEqual({ duration: expect.closeTo(2, 1), fps: undefined, width: undefined, height: undefined, hasAudio: true, hasAlpha: undefined,
    kind: "audio", originalPlaybackType: "audio/wav" });
  // A still has no length, and no rate to play at.
  expect(await adapter.probeMedia(file("logo.png"))).toEqual({ duration: 0, fps: undefined, width: 64, height: 36, hasAudio: false, hasAlpha: true, kind: "image", originalPlaybackType: undefined });
  await expect(adapter.probeMedia(file("notes.txt"))).rejects.toThrow(/exited with code/);
  await expect(adapter.probeMedia(file("missing.mp4"), AbortSignal.abort())).rejects.toThrow();
});

it("reads a recording's whole waveform at the asked resolution, reporting progress", async () => {
  const progress: number[] = [];
  const { peaks, rms } = await adapter.extractWaveformFull(file("voice.wav"), 2, 10, p => progress.push(p)) as { peaks: number[]; rms: number[] };
  expect(peaks).toHaveLength(20);
  // The tone fills the first second at half of full scale: its peak is 0.5 and its RMS 0.5/√2. The second second is silent.
  for (const p of peaks.slice(0, 10)) expect(p).toBeCloseTo(0.5, 1);
  for (const r of rms!.slice(0, 10)) expect(r).toBeCloseTo(0.354, 1);
  expect([...peaks.slice(11), ...rms!.slice(11)].every(v => v < 0.01)).toBe(true);
  expect(progress.at(-1)).toBe(1);
  expect(progress.every((p, i) => p > 0 && p <= 1 && (i === 0 || p >= progress[i - 1]!))).toBe(true);
  // A catalog estimate cannot extend the audio waveform.
  expect((await adapter.extractWaveformFull(file("voice.wav"), 3, 10)).peaks).toHaveLength(20);
});

it("draws a stretch of a saved waveform in as many points as asked", () => {
  const cache = { pointsPerSecond: 2, duration: 4, peaks: [0.1, 0.9, 0.2, 0.2, 0.6, 0.4, 0, 0], rms: [0.1, 0.5, 0.1, 0.1, 0.3, 0.3, 0, 0] };
  // Each point shows the loudest peak in its share of the stretch, and the average of the RMS there.
  expect(adapter.waveformFromCache(cache, 0, 4, 4)).toEqual({ peaks: [0.9, 0.2, 0.6, 0], rms: [0.3, 0.1, 0.3, 0] });
  expect(adapter.waveformFromCache(cache, 1, 3, 2)).toEqual({ peaks: [0.2, 0.6], rms: [0.1, 0.3] });
  // More points than samples repeats the sample each point falls in, and one past the end is empty.
  expect(adapter.waveformFromCache(cache, 0, 1, 4).peaks).toEqual([0.1, 0.1, 0.9, 0.9]);
  expect(adapter.waveformFromCache(cache, 3.5, 6, 2)).toEqual({ peaks: [0, 0], rms: [0, 0] });
  // At least one point, and no RMS when the cache has none.
  expect(adapter.waveformFromCache({ ...cache, rms: undefined }, 0, 4, 0.5)).toEqual({ peaks: [0.9], rms: undefined });
});

it("takes a still from footage at a time, at the asked width", async () => {
  const size = async (jpeg: Buffer) => {
    writeFileSync(file("frame.jpg"), jpeg);
    const { width, height } = await adapter.probeMedia(file("frame.jpg"));
    return [jpeg.subarray(0, 2).toString("hex"), width, height];
  };
  expect(await size(await adapter.extractFrame(file("red.mp4"), 1, { width: 160 }))).toEqual(["ffd8", 160, 90]);
  // A time before the start is the first frame, and so is one too small to write as a decimal. No picture is narrower than 16 pixels.
  expect(await size(await adapter.extractFrame(file("red.mp4"), -3, { width: 4 }))).toEqual(["ffd8", 16, 10]);
  expect(await size(await adapter.extractFrame(file("red.mp4"), 1e-9, { width: 64.4 }))).toEqual(["ffd8", 64, 36]);
});

it("makes a smaller copy for playback, of the whole file or a part of it", async () => {
  const progress: number[] = [];
  await adapter.makeProxy(file("red.mp4"), file("proxy.mp4"), { height: 91, onProgress: p => progress.push(p) });
  // An odd height is made even, since the encoder needs one.
  expect(await adapter.probeMedia(file("proxy.mp4"))).toMatchObject({ width: 164, height: 92, hasAudio: true });
  await lasts(file("proxy.mp4"), 2);
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.every(p => p >= 0 && p <= 0.99)).toBe(true);
  // Never larger than the original.
  await adapter.makeProxy(file("red.mp4"), file("upscaled.mp4"), { height: 720 });
  expect(await adapter.probeMedia(file("upscaled.mp4"))).toMatchObject({ width: 320, height: 180 });
  await adapter.makeProxy(file("red.mp4"), file("part.mp4"), { height: 90, range: { start: 0.1 + 0.2 - 0.3, end: 0.5 } });
  await lasts(file("part.mp4"), 0.5);
  const stopped = new AbortController();
  stopped.abort();
  await expect(adapter.makeProxy(file("red.mp4"), file("never.mp4"), { height: 90, signal: stopped.signal })).rejects.toThrow();
});

/** Red for a second, a gap, then blue over the voice: the common case of straight cuts across two kinds of track. */
function cut(): Timeline {
  const tl = emptyTimeline(project.id);
  tl.tracks[0]!.clips = [makeMediaClip("red", 0, 1, 0), makeMediaClip("blue", 0, 1, 1.5)];
  tl.tracks[1]!.clips = [makeMediaClip("voice", 0, 0.5, 1.5)];
  return tl;
}

it("renders straight cuts: each clip's picture and sound in its place, and black silence in a gap", async () => {
  const progress: number[] = [];
  const opts = { mediaRoot: root, quality: "preview" as const, height: 90, onProgress: (p: number) => progress.push(p) };
  await adapter.renderRange(project, cut(), { start: 0, end: 2.5 }, file("cut.mp4"), opts);
  expect(await adapter.probeMedia(file("cut.mp4"))).toMatchObject({ width: 160, height: 90, fps: 25, hasAudio: true });
  await lasts(file("cut.mp4"), 2.5);
  expect(await at(file("cut.mp4"), 0.4)).toBe("red, sound");
  expect(await at(file("cut.mp4"), 1.2)).toBe("black, silent");
  // Blue has no sound of its own: what is heard there is the voice on the audio track.
  expect(await at(file("cut.mp4"), 1.6)).toBe("blue, sound");
  expect(await at(file("cut.mp4"), 2.2)).toBe("blue, silent");
  expect(progress.at(-1)).toBe(1);

  // A part of the edit renders alone, from where it starts.
  await adapter.renderRange(project, cut(), { start: 1.5, end: 2 }, file("part-of-cut.mp4"), { mediaRoot: root, quality: "delivery" });
  expect(await adapter.probeMedia(file("part-of-cut.mp4"))).toMatchObject({ width: 320, height: 180 });
  await lasts(file("part-of-cut.mp4"), 0.5);
  expect(await at(file("part-of-cut.mp4"), 0.1)).toBe("blue, sound");
  // A range with nothing in it is black and silent, not an error.
  await adapter.renderRange(project, emptyTimeline(project.id), { start: 0, end: 0.4 }, file("empty.mp4"), { mediaRoot: root, quality: "preview", height: 90 });
  expect(await at(file("empty.mp4"), 0.1)).toBe("black, silent");
});

it("shows the topmost visible track, and leaves out what is muted, hidden, disabled or turned down", async () => {
  const tl = emptyTimeline(project.id);
  const over = makeTrack("video", "V2"), hidden = makeTrack("video", "V3");
  hidden.hidden = true;
  tl.tracks.push(over, hidden);
  // Red plays under everything. Blue covers it for the second half, and a hidden track covers both.
  tl.tracks[0]!.clips = [makeMediaClip("red", 0, 1, 0)];
  over.clips = [makeMediaClip("blue", 0, 0.5, 0.5), makeMediaClip("blue", 0, 0.5, 0, { enabled: false })];
  hidden.clips = [makeMediaClip("blue", 0, 1, 0)];
  tl.tracks[1]!.clips = [makeMediaClip("voice", 0, 0.5, 0.5, { volume: 0 })];
  const opts = { mediaRoot: root, quality: "preview" as const, height: 90 };
  await adapter.renderFullCached(project, tl, file("unused-cache"), file("layers.mp4"), opts);
  await lasts(file("layers.mp4"), 1);
  expect(await at(file("layers.mp4"), 0.2)).toBe("red, sound");
  // Under blue, red's own sound is no longer heard, and the voice there is turned all the way down.
  expect(await at(file("layers.mp4"), 0.7)).toBe("blue, silent");

  tl.tracks[0]!.muted = true;
  await adapter.renderFullCached(project, tl, file("unused-cache"), file("muted.mp4"), { ...opts, exportRange: { start: 0, end: 0.5 } });
  await lasts(file("muted.mp4"), 0.5);
  expect(await at(file("muted.mp4"), 0.2)).toBe("red, silent");
});

it("plays a clip at its speed, picture and sound together", async () => {
  const tl = emptyTimeline(project.id);
  // Two seconds of source in one: the tone, which ends a second into the source, ends half a second into the edit.
  tl.tracks[0]!.clips = [makeMediaClip("red", 0, 2, 0, { speed: 2 })];
  await adapter.renderRange(project, tl, { start: 0, end: 1 }, file("fast.mp4"), { mediaRoot: root, quality: "preview", height: 90 });
  await lasts(file("fast.mp4"), 1);
  expect(await at(file("fast.mp4"), 0.15)).toBe("red, sound");
  expect(await at(file("fast.mp4"), 0.75)).toBe("red, silent");
});
