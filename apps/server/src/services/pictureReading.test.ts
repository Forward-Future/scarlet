import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../context.js";
import { ffmpeg } from "../render/ffmpeg.js";
import { pictureReader, rememberLast, withFrames, type VideoMedia } from "./pictureReading.js";

let root: string;
let live: AbortController, media: AbortController;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "picture-reading-"));
  mkdirSync(join(root, "media"));
  writeFileSync(join(root, "media", "clip.mp4"), "not a video: the reading under test never decodes it");
  live = new AbortController();
  media = new AbortController();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctx = () => ({
  paths: { root, tmp: join(root, "tmp"), waveforms: () => join(root, "waveforms"), media: () => join(root, "media") },
  log: () => {}, track: <T>(p: Promise<T>) => p, settings: () => ({ render: { hwaccel: "none" } }),
  projectSignal: () => live.signal, mediaSignal: () => media.signal,
}) as unknown as Ctx;
const video = (over: Partial<VideoMedia> = {}): VideoMedia =>
  ({ id: "med_1", projectId: "prj_1", kind: "video", path: "clip.mp4", duration: 150, hash: "h1", ...over }) as VideoMedia;

/** A reading that records each window it reads and answers with the window's bounds. */
function counting(version = 1, fail?: number) {
  const reads: number[] = [];
  const reader = pictureReader<{ start: number; end: number }>({ name: "test-reading", window: 60, identity: m => `${version}:${m.hash}`,
    async read(_ctx, _media, _file, { index, start, end }) {
      reads.push(index);
      if (index === fail) throw new Error("the decoder stopped");
      return { start, end };
    } });
  return { reads, reader };
}

describe("reading a video's picture a window at a time", () => {
  it("reads the windows asked for, then the rest, keeps them, and answers again from what it kept", async () => {
    const { reads, reader } = counting();
    const first = await reader.read(ctx(), video(), { from: 70, to: 100 });
    expect(first).toMatchObject({ from: 70, to: 100, readSeconds: 30, done: true });
    expect(first.ready.map(w => w.value)).toEqual([{ start: 60, end: 120 }]);
    // The rest of the video is read in the background, in order.
    await expect.poll(() => reads).toEqual([1, 0, 2]);
    expect(JSON.parse(readFileSync(join(root, "waveforms", "med_1.test-reading.json"), "utf8")).chunks[2]).toEqual({ start: 120, end: 150 });
    const whole = await reader.read(ctx(), video(), {});
    expect(whole.all.map(w => [w.index, w.start, w.end])).toEqual([[0, 0, 60], [1, 60, 120], [2, 120, 150]]);
    expect(reads).toEqual([1, 0, 2]);
    // A new engine reads what was kept rather than the video.
    const again = counting();
    expect((await again.reader.read(ctx(), video(), {})).done).toBe(true);
    expect(again.reads).toEqual([]);
  });

  it("reads again what was kept under another reading", async () => {
    await counting(1).reader.read(ctx(), video(), {});
    const changed = counting(2);
    await changed.reader.read(ctx(), video(), { to: 10 });
    expect(changed.reads[0]).toBe(0);
  });

  it("answers with what is ready when it can't wait, and says why reading stopped", async () => {
    const { reader } = counting(1, 1);
    const partial = await reader.read(ctx(), video(), {}, { waitMs: 0 });
    expect(partial.done).toBe(false);
    // Asked again, the window is read again, and the answer waits for it to stop.
    expect(await reader.read(ctx(), video(), { from: 60, to: 120 }, { waitMs: 5000 })).toMatchObject({ done: false, readSeconds: 0, error: "the decoder stopped" });
  });

  it("holds what nobody asked for while the project's media work is paused", async () => {
    media.abort();
    const { reads, reader } = counting();
    expect((await reader.read(ctx(), video(), { to: 30 })).done).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toEqual([0]);
  });

  it("refuses what has no picture to read, or no file", async () => {
    const { reader } = counting();
    await expect(reader.read(ctx(), video({ kind: "audio" } as Partial<VideoMedia>), {})).rejects.toThrow("Only a video has a picture to read.");
    await expect(reader.read(ctx(), video({ duration: 0 }), {})).rejects.toThrow("still being prepared");
    await expect(reader.read(ctx(), video({ path: "gone.mp4" }), {})).rejects.toThrow("file is missing");
    await expect(reader.read(ctx(), video(), { from: 200 })).rejects.toThrow("Choose a range inside the recording's 150.00 s.");
  });
});

describe("decoding frames for a reading", () => {
  it("decodes a range in one pass and hands its frames over a batch at a time, with their seconds, then removes them", async () => {
    const clip = join(root, "media", "bars.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "250", "-y", clip]);
    const handed: Array<{ times: number[]; bytes: number }> = [];
    const results = await withFrames(ctx(), video({ path: "bars.mp4" }), clip, "test-frames",
      { start: 0.5, end: 3, fps: 4, width: 160, height: 90, signal: live.signal, batch: 4 },
      at => at !== 1.5, async (path, times) => {
        handed.push({ times, bytes: statSync(path).size });
        return times.length;
      });
    expect(handed.map(h => h.times)).toEqual([[0.5, 0.75, 1, 1.25], [1.75, 2, 2.25, 2.5], [2.75]]);
    expect(handed.map(h => h.bytes)).toEqual([4, 4, 1].map(n => n * 160 * 90 * 3));
    expect(results).toEqual([4, 4, 1]);
    expect(existsSync(join(root, "tmp")) ? readdirSync(join(root, "tmp")) : []).toEqual([]);
  });
});

describe("what a reader keeps in memory", () => {
  it("keeps the 32 recordings asked about last, and reads one let go back from what it saved", async () => {
    const { reads, reader } = counting();
    for (let i = 0; i < 40; i++) await reader.read(ctx(), video({ id: `med_${i}`, duration: 30 }), {});
    expect(reader.kept()).toBe(32);
    expect(reads).toHaveLength(40);
    // The first was let go, and comes back from disk without reading its picture again.
    expect((await reader.read(ctx(), video({ id: "med_0", duration: 30 }), {})).done).toBe(true);
    expect(reads).toHaveLength(40);
    expect(reader.kept()).toBe(32);
  });

  it("lets go of the least recently used entry first, and never one in use", () => {
    const map = new Map<string, { busy: boolean }>();
    for (const key of ["a", "b", "c"]) rememberLast(map, key, { busy: key === "a" }, 3, v => v.busy);
    rememberLast(map, "b", map.get("b")!, 3);
    rememberLast(map, "d", { busy: false }, 3, v => v.busy);
    // "a" is in use, so "c", now the least recently used of the rest, goes.
    expect([...map.keys()]).toEqual(["a", "b", "d"]);
  });
});
