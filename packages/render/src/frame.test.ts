import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveFfmpeg, runCapture } from "./exec.js";
import { extractFrame, percentGrid } from "./frame.js";

/** A JPEG's pixels as RGB, with its size read from how many there are at the width asked for. */
async function pixels(jpeg: Buffer, width: number) {
  const { stdout } = await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdin: jpeg });
  const height = stdout.length / 3 / width;
  return { height, at: (x: number, y: number) => [...stdout.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)] };
}

it("labels lines at round percents of the whole picture, closer together over a smaller area", () => {
  const labels = (filters: string[]) => filters.flatMap(f => /text='([^']+)'/.exec(f)?.[1] ?? []);
  const whole = percentGrid([0, 0, 1, 1], 1920, 1080);
  expect(labels(whole)).toEqual(["10", "20", "30", "40", "50", "60", "70", "80", "90", "10", "20", "30", "40", "50", "60", "70", "80", "90"]);
  expect(whole.find(f => f.startsWith("drawbox=x=960:"))).toBeDefined();
  // A fifth of the picture across: lines every 5 percent, placed where those percents fall in the area.
  const part = percentGrid([0.4, 0.2, 0.6, 0.5], 1000, 844);
  expect(labels(part).slice(0, 3)).toEqual(["45", "50", "55"]);
  expect(part.find(f => f.startsWith("drawbox=x=500:"))).toBeDefined();
  expect(labels(part).slice(3)).toEqual(["25", "30", "35", "40", "45"]);
});

it("draws one area of a frame at the width asked for, with the grid over it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-frame-"));
  try {
    const file = join(dir, "halves.mp4");
    // Red on the left half, blue on the right.
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=1,drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", file]);
    const right = await pixels(await extractFrame(file, 0.5, { width: 320, area: [0.5, 0, 1, 1] }), 320);
    expect(right.height).toBe(360);
    const [r, , b] = right.at(20, 180);
    expect(b! - r!).toBeGreaterThan(100);
    const gridded = await pixels(await extractFrame(file, 0.5, { width: 640, grid: { width: 640, height: 360 } }), 640);
    expect(gridded.height).toBe(360);
    // The 30 percent line is lighter than the red beside it.
    expect(gridded.at(192, 300)[1]!).toBeGreaterThan(gridded.at(180, 300)[1]! + 40);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("gives the frame on screen at a time inside a frame, at a frame's start and inside the last frame", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-frame-"));
  try {
    const fine = join(dir, "red-blue.mp4"), coarse = join(dir, "red-blue-coarse.mp4");
    // 48 frames at 24 fps: red before 1 s, blue from 1 s. The last red frame starts at 0.958 s, the last blue one at 1.958 s.
    // Then the same on a clock that counts whole frames, which rounds any time between them.
    for (const [file, clock] of [[fine, []], [coarse, ["-video_track_timescale", "24"]]] as const) {
      await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:r=24:d=2",
        "-vf", "drawbox=color=blue:t=fill:enable=gte(t\\,1)", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", ...clock, file]);
    }
    const colour = async (file: string, t: number, fps?: number) => {
      const [r, , b] = (await pixels(await extractFrame(file, t, { width: 32, fps }), 32)).at(16, 9);
      return r! > b! ? "red" : "blue";
    };
    for (const [file, fps] of [[fine, 24], [fine, undefined], [coarse, 24]] as const) {
      // Inside the last red frame, just before the change, and right at its end.
      expect(await Promise.all([0, 0.96, 0.98, 0.999].map(t => colour(file, t, fps)))).toEqual(["red", "red", "red", "red"]);
      // Exactly on a frame's start, and on it as written to the millisecond.
      expect(await colour(file, 1, fps)).toBe("blue");
      expect(await colour(file, 0.958, fps)).toBe("red");
      // Inside the last frame, and at the video's end.
      expect(await Promise.all([1.96, 1.98, 1.999, 2].map(t => colour(file, t, fps)))).toEqual(["blue", "blue", "blue", "blue"]);
    }
    // Two times inside one frame give the same picture.
    expect((await extractFrame(fine, 0.96, { width: 32, fps: 24 })).equals(await extractFrame(fine, 0.99, { width: 32, fps: 24 }))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("gives the first frame for a time before the video's first frame", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-frame-"));
  try {
    const file = join(dir, "late.mp4");
    // The picture starts half a second into the file, after its sound.
    await runCapture(resolveFfmpeg(), ["-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:r=24:d=1", "-f", "lavfi", "-i", "anullsrc=d=1.5",
      "-vf", "setpts=PTS+0.5/TB", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "1", file]);
    const [r, , b] = (await pixels(await extractFrame(file, 0.1, { width: 32, fps: 24 }), 32)).at(16, 9);
    expect(r! - b!).toBeGreaterThan(100);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
