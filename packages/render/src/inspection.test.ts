import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as exec from "./exec.js";
import { resolveFfmpeg, runCapture, spawnStats } from "./exec.js";
import { contactSheet, packSheet, pictureActivity, qualityEvents, sampleTimes } from "./inspection.js";
import { extractFrame } from "./frame.js";
import { isStoredAsShown, storedAsShown } from "./probe.js";

it("selects the same original VFR frames and preserves their labels when reusing decoded inspection pictures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-sheet-"));
  try {
    const file = join(dir, "anamorphic.mkv");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2",
      "-vf", "select='not(mod(n,3))+gte(t,1)',setsar=4/3", "-fps_mode", "vfr", "-c:v", "libx264", "-threads", "1", file]);
    for (const mode of ["activity", "scene"] as const) {
      const opts = { origin: 3.25, fps: 30, count: 6, mode };
      const range = { start: .32, end: 1.83 };
      const original = await contactSheet(file, range, opts);
      const decodes = spawnStats.ffmpeg;
      const retained = await contactSheet(file, range, { ...opts, sourceWidth: 1280 });
      expect(spawnStats.ffmpeg - decodes).toBe(2);
      expect(retained.timestamps.length).toBeGreaterThan(2);
      expect(retained).toEqual(original);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("can count a faint change that the default activity threshold leaves out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-faint-"));
  try {
    // The whole picture brightens at 0.5 s by exactly the default threshold, which counts only larger steps.
    const file = join(dir, "faint.mp4");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=0x606060:s=320x180:r=25:d=1",
      "-vf", "format=yuv420p,geq=lum='p(X,Y)+20*gte(T,0.5)':cb='p(X,Y)':cr='p(X,Y)'", "-c:v", "libx264", "-qp", "0", "-threads", "1", file]);
    const opts = { origin: 0, fps: 25, count: 6, mode: "activity" as const };
    await expect(pictureActivity(file, { start: 0, end: 1 }, { ...opts, maxFrames: 4 })).rejects.toThrow("Too many pictures");
    expect((await contactSheet(file, { start: 0, end: 1 }, opts)).changedFrames).toBe(0);
    expect((await contactSheet(file, { start: 0, end: 1 }, { ...opts, activityThreshold: 22 })).changedFrames).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("finds the same frames and motion when the original decodes on the GPU, or falls back to the CPU without one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-gpu-sheet-"));
  try {
    const file = join(dir, "moving.mp4");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", file]);
    for (const mode of ["uniform", "activity", "scene"] as const) {
      const opts = { origin: 0, fps: 30, count: 6, mode, sourceWidth: 1280 };
      const range = { start: .2, end: 1.7 };
      const cpu = await contactSheet(file, range, opts);
      // A machine without CUDA can't run this decoder, and the sheet comes from the CPU instead.
      const gpu = await contactSheet(file, range, { ...opts, decoder: "cuda" });
      expect({ timestamps: gpu.timestamps, columns: gpu.columns, changedFrames: gpu.changedFrames })
        .toEqual({ timestamps: cpu.timestamps, columns: cpu.columns, changedFrames: cpu.changedFrames });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("says why a frame, a sheet and a motion measure were decoded on the CPU when the GPU could not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-gpu-reason-"));
  const capture = exec.runCapture;
  // Every machine fails the same way here: the hardware read is refused and the CPU read runs.
  const refuse = vi.spyOn(exec, "runCapture").mockImplementation((bin, args, opts) => args.includes("-hwaccel")
    ? Promise.reject(new exec.FfmpegError("ffmpeg exited with code 1", bin, args, 1, "[h264 @ 0x1] Cannot load nvcuda.dll\n[vist#0:0/h264 @ 0x2] Error initializing a decoder\nError opening output files: Operation not permitted\n"))
    : capture(bin, args, opts));
  try {
    const file = join(dir, "moving.mp4");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", file]);
    const reasons: string[] = [];
    const onFallback = (reason: string) => { reasons.push(reason); };
    const range = { start: .2, end: 1.7 };
    const sheet = { origin: 0, fps: 30, count: 6, mode: "uniform" as const };
    expect((await extractFrame(file, 1.2, { width: 160, decoder: "cuda", onFallback })).equals(await extractFrame(file, 1.2, { width: 160, onFallback }))).toBe(true);
    expect(await contactSheet(file, range, { ...sheet, decoder: "cuda", onFallback })).toEqual(await contactSheet(file, range, { ...sheet, onFallback }));
    expect(await pictureActivity(file, range, { origin: 0, fps: 30, decoder: "videotoolbox", onFallback }))
      .toEqual(await pictureActivity(file, range, { origin: 0, fps: 30, onFallback }));
    // One line each, and nothing from the reads that never asked for the GPU.
    expect(reasons).toEqual([
      "cuda could not decode this frame ([h264] Cannot load nvcuda.dll; Error opening output files: Operation not permitted); decoded it on the CPU.",
      "cuda could not decode this window ([h264] Cannot load nvcuda.dll; Error opening output files: Operation not permitted); decoded it on the CPU.",
      "videotoolbox could not decode this window ([h264] Cannot load nvcuda.dll; Error opening output files: Operation not permitted); decoded it on the CPU.",
    ]);
  } finally {
    refuse.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("reads a window twice when its pictures cannot be kept from the first read, and says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-two-reads-"));
  const capture = exec.runCapture;
  // Only the read that keeps the pictures writes them out as a NUT stream.
  const refuse = vi.spyOn(exec, "runCapture").mockImplementation((bin, args, opts) => args.includes("nut") && args.includes("pipe:1")
    ? Promise.reject(new exec.FfmpegError("ffmpeg exited with code 1", bin, args, 1, "Incompatible pixel format 'gbrp' for codec 'rawvideo'\n"))
    : capture(bin, args, opts));
  try {
    const file = join(dir, "moving.mp4");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", file]);
    const reasons: string[] = [];
    const opts = { origin: 0, fps: 30, count: 6, mode: "scene" as const };
    const range = { start: .2, end: 1.7 };
    expect(await contactSheet(file, range, { ...opts, sourceWidth: 1280, onFallback: reason => reasons.push(reason) })).toEqual(await contactSheet(file, range, opts));
    expect(reasons).toEqual(["This window's pictures could not be kept from one read (Incompatible pixel format 'gbrp' for codec 'rawvideo'); read it twice."]);
  } finally {
    refuse.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("spreads a sheet's frames evenly, and around scene changes and a point of interest when it has them", () => {
  const near = (times: number[]) => times.map(t => expect.closeTo(t, 9));
  // Uniform: the first and last frame and evenly between, never more frames than the window holds.
  expect(sampleTimes(1, 10, 4, [])).toEqual(near([0, 0.3, 0.6, 0.9]));
  expect(sampleTimes(0.2, 10, 6, [])).toEqual(near([0, 0.1]));
  expect(sampleTimes(0.05, 10, 6, [])).toEqual([0]);
  // Scene changes: both ends, then the changes, then the middle of the widest gap left.
  expect(sampleTimes(10, 10, 4, [2, 6])).toEqual([0, 2, 6, 9.9]);
  expect(sampleTimes(10, 10, 5, [2, 6])).toEqual([0, 2, 4, 6, 9.9]);
  expect(sampleTimes(10, 10, 2, [5])).toEqual([0, 9.9]);
  // More changes than places keeps an even share of them.
  expect(sampleTimes(10, 10, 4, [1, 2, 3, 4, 5, 6])).toEqual([0, 1, 4, 9.9]);
  // A point of interest brings the frame before it and the frame on it, then the gaps fill.
  expect(sampleTimes(10, 10, 4, [], 5)).toEqual([0, 4.9, 5, 9.9]);
  expect(sampleTimes(10, 10, 6, [5], 5)).toEqual(near([0, 2.45, 4.9, 5, 7.45, 9.9]));
  // One outside the window is clamped onto an end, and adds no frame of its own.
  for (const focus of [50, -3]) expect(sampleTimes(10, 10, 4, [], focus)).toEqual(near([0, 2.475, 4.95, 9.9]));
  // A window too short to fill stops when no gap is wider than a frame and a half.
  expect(sampleTimes(0.2, 10, 6, [], 0.1)).toEqual(near([0, 0.1]));
});

it("finds a black stretch, a frozen picture and a jump in level, on the clock the editor sees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-quality-"));
  try {
    // One second of black and silence, one of a moving picture with a tone, then the picture holds still to the end.
    const file = join(dir, "events.mp4");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=1", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-filter_complex",
      "[1:v]tpad=stop_mode=clone:stop_duration=1[moving];[0:v][moving]concat=n=2[v];[2:a]volume='if(lt(t,1),0,1)':eval=frame[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-f", "matroska", file]);
    const events = await qualityEvents(file, { start: 0, end: 3 }, 100);
    const black = events.find(event => event.kind === "black")!;
    expect(black.start).toBeCloseTo(100, 1);
    expect(black.end).toBeCloseTo(101, 1);
    // A freeze still running when the window ends is closed at the window's end.
    const freeze = events.filter(event => event.kind === "freeze").at(-1)!;
    expect(freeze.start).toBeGreaterThan(101.9);
    expect(freeze.end).toBeCloseTo(103, 1);
    // The tone starts inside one 80 ms window, so the step up can span that window and the next.
    const rise = events.filter(event => event.kind === "level-rise");
    expect(rise.length).toBeGreaterThan(0);
    for (const step of rise) {
      expect(Math.abs(step.start - 101)).toBeLessThan(0.1);
      expect(step.end).toBe(step.start);
      expect(step.deltaDb).toBeGreaterThanOrEqual(12);
    }
    expect(events.some(event => event.kind === "level-drop")).toBe(false);
    // The moving, level second on its own has nothing to report.
    expect(await qualityEvents(file, { start: 1.1, end: 1.9 }, 100)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("packs frames it is handed into one labelled sheet, three to a row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-pack-"));
  try {
    const file = join(dir, "moving.mp4");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    const times = [0.1, 0.3, 0.5, 0.7];
    const frames = await Promise.all(times.map(t => extractFrame(file, t, { width: 320 })));
    const four = await packSheet(frames, times, false);
    expect([four.timestamps, four.columns]).toEqual([times, 3]);
    // Two rows of 320x204 cells with a 2-pixel gap between them.
    expect(jpegSize(Buffer.from(four.jpeg, "base64"))).toEqual({ width: 3 * 320 + 4, height: 2 * 204 + 2 });
    const two = await packSheet(frames.slice(0, 2), times.slice(0, 2), false);
    expect(two.columns).toBe(2);
    expect(jpegSize(Buffer.from(two.jpeg, "base64"))).toEqual({ width: 2 * 320 + 2, height: 204 });
    await expect(packSheet([Buffer.from("not a picture")], [0], false)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** Width and height from a baseline JPEG’s frame header. */
function jpegSize(jpeg: Buffer) {
  for (let at = 2; at + 9 < jpeg.length;) {
    const marker = jpeg[at + 1]!;
    if (marker === 0xc0 || marker === 0xc2) return { width: jpeg.readUInt16BE(at + 7), height: jpeg.readUInt16BE(at + 5) };
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
}

it("grabs the same frame size when the original decodes on the GPU, or on the CPU without one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-gpu-frame-"));
  try {
    const file = join(dir, "moving.mp4");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", file]);
    const cpu = await extractFrame(file, 1.2, { width: 320 });
    const gpu = await extractFrame(file, 1.2, { width: 320, decoder: "cuda" });
    expect(jpegSize(gpu)).toEqual(jpegSize(cpu));
    expect(jpegSize(cpu)).toEqual({ width: 320, height: 180 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("counts a file as stored as shown only when its frames need no turning", () => {
  const video = { isStillImage: false, displayMatrix: false };
  for (const rotation of [0, 360, -360]) expect(storedAsShown({ ...video, rotation })).toBe(true);
  for (const rotation of [90, -90, 180, 270]) expect(storedAsShown({ ...video, rotation })).toBe(false);
  // A vertical flip alone reads as no rotation, and a photo keeps its turn in its own tag.
  expect(storedAsShown({ ...video, rotation: 0, displayMatrix: true })).toBe(false);
  expect(storedAsShown({ ...video, rotation: 0, isStillImage: true })).toBe(false);
});

it("keeps a file whose frames need turning on the CPU when the GPU is asked for, so it comes out turned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-gpu-rotated-"));
  try {
    const upright = join(dir, "upright.mp4"), rotated = join(dir, "rotated.mp4"), flipped = join(dir, "flipped.mp4"), photo = join(dir, "photo.png");
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", upright]);
    // A phone's portrait video: the same landscape stream, with a note to show it turned. Then one with a flip alone.
    await runCapture(resolveFfmpeg(), ["-v", "error", "-display_rotation", "90", "-i", upright, "-c", "copy", rotated]);
    await runCapture(resolveFfmpeg(), ["-v", "error", "-display_vflip", "-i", upright, "-c", "copy", flipped]);
    await runCapture(resolveFfmpeg(), ["-v", "error", "-i", upright, "-frames:v", "1", "-update", "1", photo]);
    expect(await isStoredAsShown(upright)).toBe(true);
    for (const file of [rotated, flipped, photo]) expect(await isStoredAsShown(file)).toBe(false);

    // One CPU decode and the same picture, with CUDA or without: frames kept on the GPU would come out unturned,
    // and a machine without CUDA would spend a failed GPU attempt first.
    const runs = async <T>(job: () => Promise<T>) => {
      const before = spawnStats.ffmpeg;
      return { result: await job(), ffmpeg: spawnStats.ffmpeg - before };
    };
    const cpu = await extractFrame(rotated, 1.2, { width: 320 });
    expect(jpegSize(cpu)).toEqual({ width: 320, height: 568 });
    expect(await runs(() => extractFrame(rotated, 1.2, { width: 320, decoder: "cuda" }))).toEqual({ result: cpu, ffmpeg: 1 });
    const still = await extractFrame(photo, 0, { width: 320 });
    expect(await runs(() => extractFrame(photo, 0, { width: 320, decoder: "cuda" }))).toEqual({ result: still, ffmpeg: 1 });

    for (const mode of ["uniform", "activity"] as const) {
      const opts = { origin: 0, fps: 30, count: 6, mode, sourceWidth: 1280 };
      const range = { start: .2, end: 1.7 };
      const plain = await runs(() => contactSheet(rotated, range, opts));
      expect(await runs(() => contactSheet(rotated, range, { ...opts, decoder: "cuda" }))).toEqual(plain);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
