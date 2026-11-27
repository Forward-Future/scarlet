import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, makeMediaClip, type Timeline } from "@scarlet/timeline";
import { buildFilterGraph } from "./graph.js";
import { FFMPEG_BASE_ARGS, resolveFfmpeg, runCapture } from "./exec.js";
import { segmentKey } from "./segmentKey.js";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scarlet-smooth-zoom-"));
  // Generate a high-detail 640x360 still image (test pattern with fine edges & gradients) so any pixel-stepping
  // during a slow zoom immediately shows up in frame-to-frame luminance differences.
  await runCapture(resolveFfmpeg(), [
    ...FFMPEG_BASE_ARGS, "-y",
    "-f", "lavfi", "-i", "testsrc2=s=640x360:d=0.1",
    "-frames:v", "1", "-update", "1", path.join(dir, "still.png"),
  ]);
  await runCapture(resolveFfmpeg(), [
    ...FFMPEG_BASE_ARGS, "-y",
    "-f", "lavfi", "-i", "color=c=white:s=160x160:d=0.1",
    "-frames:v", "1", "-update", "1", path.join(dir, "white.png"),
  ]);
});

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

function frameMads(rawGray: Buffer, w: number, h: number): number[] {
  const size = w * h;
  const count = Math.floor(rawGray.length / size);
  const mads: number[] = [];
  for (let f = 1; f < count; f++) {
    let sum = 0;
    const prev = (f - 1) * size;
    const cur = f * size;
    for (let i = 0; i < size; i++) sum += Math.abs(rawGray[cur + i]! - rawGray[prev + i]!);
    mads.push(sum / size);
  }
  return mads;
}

describe("smooth subpixel static-image zooms", () => {
  it("zooms and pans a static image smoothly on every frame with zero frozen steps", async () => {
    const project = createProject("SmoothZoom", { width: 320, height: 180, fps: 30, aspect: "16:9" });
    project.media = [{
      id: "m1", kind: "image", name: "still.png", path: "still.png",
      width: 640, height: 360, hasAudio: false, hasAlpha: false,
    }];
    const clip = makeMediaClip("m1", 0, 2, 0, {
      keyframes: [
        { time: 0, transform: { x: 0, y: 0, scale: 1 }, ease: "linear" },
        { time: 2, transform: { x: -0.012, y: 0.006, scale: 1.065 }, ease: "easeInOut" },
      ],
    });
    const timeline: Timeline = {
      version: "v1", parent: null, projectId: project.id, name: "Main", background: "#000000", markers: [],
      tracks: [{ id: "v0", kind: "video", name: "Video", muted: false, hidden: false, clips: [clip] }],
    };

    const graph = await buildFilterGraph(project, timeline, { start: 0, end: 2 }, { mediaRoot: dir, pictureOnly: true });
    try {
      // Static image with animated transform reads once and uses `perspective` instead of `-loop 1` + `scale:eval=frame`.
      expect(graph.args.includes("-loop")).toBe(false);
      expect(graph.graph).toContain("trim=end_frame=1");
      expect(graph.graph).toContain("perspective=");
      expect(graph.graph).not.toContain(":eval=frame:flags=");

      const { stdout } = await runCapture(resolveFfmpeg(), [
        ...FFMPEG_BASE_ARGS, ...graph.args, "-pix_fmt", "gray", "-f", "rawvideo", "-",
      ], { maxStdout: 16 * 1024 * 1024 });
      const mads = frameMads(stdout, 320, 180);
      expect(mads.length).toBe(59);
      const mean = mads.reduce((a, b) => a + b, 0) / mads.length;
      const std = Math.sqrt(mads.reduce((a, b) => a + (b - mean) ** 2, 0) / mads.length);
      // Every single frame advances smoothly (old integer scale froze >70% of frames with CV > 1.3).
      expect(mads.filter((m) => m < 0.05)).toHaveLength(0);
      expect(std / mean).toBeLessThan(0.25);
    } finally {
      await graph.cleanup();
    }
  });

  it("stays continuous across a segment boundary even when a still starts off the frame grid at 29.97 fps", async () => {
    const fps = 29.970037204161414;
    const project = createProject("Seam", { width: 320, height: 180, fps, aspect: "16:9" });
    project.media = [{
      id: "m1", kind: "image", name: "still.png", path: "still.png",
      width: 640, height: 360, hasAudio: false, hasAlpha: false,
    }];
    const clip = makeMediaClip("m1", 0, 4, 0.378295, {
      keyframes: [
        { time: 0, transform: { x: 0, y: 0, scale: 1 }, ease: "linear" },
        { time: 4, transform: { x: -0.012, y: 0.006, scale: 1.065 }, ease: "linear" },
      ],
    });
    const timeline: Timeline = {
      version: "v1", parent: null, projectId: project.id, name: "Main", background: "#000000", markers: [],
      tracks: [{ id: "v0", kind: "video", name: "Video", muted: false, hidden: false, clips: [clip] }],
    };

    const split = 60 / fps;
    const decodeRange = async (start: number, end: number) => {
      const g = await buildFilterGraph(project, timeline, { start, end }, { mediaRoot: dir, pictureOnly: true });
      try {
        const { stdout } = await runCapture(resolveFfmpeg(), [
          ...FFMPEG_BASE_ARGS, ...g.args, "-pix_fmt", "gray", "-f", "rawvideo", "-",
        ], { maxStdout: 16 * 1024 * 1024 });
        return stdout;
      } finally {
        await g.cleanup();
      }
    };

    const segA = await decodeRange(0, split);
    const segB = await decodeRange(split, 90 / fps);
    const size = 320 * 180;
    const lastA = segA.subarray(segA.length - size);
    const prevA = segA.subarray(segA.length - 2 * size, segA.length - size);
    const firstB = segB.subarray(0, size);
    const secondB = segB.subarray(size, 2 * size);

    const mad = (a: Buffer, b: Buffer) => {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += Math.abs(a[i]! - b[i]!);
      return sum / size;
    };
    const interiorBefore = mad(prevA, lastA);
    const seam = mad(lastA, firstB);
    const interiorAfter = mad(firstB, secondB);
    expect(seam).toBeGreaterThan(interiorBefore * 0.7);
    expect(seam).toBeLessThan(interiorBefore * 1.35);
    expect(seam).toBeGreaterThan(interiorAfter * 0.7);
    expect(seam).toBeLessThan(interiorAfter * 1.35);
  });

  it("keeps transparent edges halo-free when animating a scaled-down inset with rounded corners", async () => {
    const project = createProject("Inset", { width: 160, height: 160, fps: 30, aspect: "custom" });
    project.media = [{
      id: "w1", kind: "image", name: "white.png", path: "white.png",
      width: 160, height: 160, hasAudio: false, hasAlpha: false,
    }];
    const clip = makeMediaClip("w1", 0, 1, 0, {
      transform: { x: 0, y: 0, scale: 0.5, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, cornerRadius: 0.15 },
      keyframes: [
        { time: 0, transform: { x: -0.05, y: 0, scale: 0.5 }, ease: "linear" },
        { time: 1, transform: { x: 0.05, y: 0, scale: 0.55 }, ease: "linear" },
      ],
    });
    const timeline: Timeline = {
      version: "v1", parent: null, projectId: project.id, name: "Main", background: "#FFFFFF", markers: [],
      tracks: [{ id: "v0", kind: "video", name: "Video", muted: false, hidden: false, clips: [clip] }],
    };
    const graph = await buildFilterGraph(project, timeline, { start: 0, end: 0.2 }, { mediaRoot: dir, pictureOnly: true });
    try {
      const { stdout } = await runCapture(resolveFfmpeg(), [
        ...FFMPEG_BASE_ARGS, ...graph.args, "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
      ], { maxStdout: 16 * 1024 * 1024 });
      // White rounded inset sliding over a white canvas must stay pure white with no dark premultiply fringe.
      let minChannel = 255;
      for (let i = 0; i < stdout.length; i++) if (stdout[i]! < minChannel) minChannel = stdout[i]!;
      expect(minChannel).toBeGreaterThanOrEqual(248);
    } finally {
      await graph.cleanup();
    }
  });

  it("changes the segment key for animated clips while keeping static clip keys unchanged", () => {
    const project = createProject("Keys", { width: 320, height: 180, fps: 30, aspect: "16:9" });
    project.media = [{
      id: "m1", kind: "image", name: "still.png", path: "still.png", hash: "abc",
      width: 640, height: 360, hasAudio: false, hasAlpha: false,
    }];
    const mk = (keyframes?: ReturnType<typeof makeMediaClip>["keyframes"]): Timeline => ({
      version: "v1", parent: null, projectId: project.id, name: "Main", background: "#000000", markers: [],
      tracks: [{ id: "v0", kind: "video", name: "Video", muted: false, hidden: false, clips: [makeMediaClip("m1", 0, 2, 0, { keyframes })] }],
    });
    const staticKey = segmentKey(project, mk(), { start: 0, end: 2 }, { quality: "preview", height: 180 });
    const animatedKey = segmentKey(project, mk([
      { time: 0, transform: { scale: 1 }, ease: "linear" },
      { time: 2, transform: { scale: 1.06 }, ease: "linear" },
    ]), { start: 0, end: 2 }, { quality: "preview", height: 180 });
    expect(animatedKey).not.toBe(staticKey);
  });
});
