import { describe, expect, it } from "vitest";
import type { MediaAsset, MediaClip } from "@scarlet/timeline";
import {
  hasAnimatedTransform,
  proxyHeightForClip,
  resolveTransform,
  smoothTransformStages,
  smoothWorkingSize,
} from "./graphTransform.js";

it("asks for a full-size picture, not a negative one, when a clip's crops add up past the whole frame", () => {
  const asset = { id: "a", kind: "video", name: "A", path: "a.mp4", width: 1920, height: 1080 } as MediaAsset;
  const clip = (crop: Partial<NonNullable<MediaClip["transform"]>>) => ({ kind: "media", effects: [],
    transform: { x: 0, y: 0, scale: 1, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, ...crop } }) as unknown as MediaClip;
  expect(proxyHeightForClip(clip({}), asset, 1920, 1080)).toBe(1080);
  // Drawn as a sliver of the frame (the render keeps at least 1 percent each way), so it needs the most detail.
  for (const crop of [{ cropLeft: 0.7, cropRight: 0.6 }, { cropTop: 0.5, cropBottom: 0.5 }, { cropTop: 1, cropBottom: 1 }]) {
    expect(proxyHeightForClip(clip(crop), asset, 1920, 1080)).toBeGreaterThanOrEqual(1080);
  }
});

describe("smooth animated transforms", () => {
  it("detects when keyframes actually animate x, y or scale", () => {
    expect(hasAnimatedTransform({})).toBe(false);
    expect(hasAnimatedTransform({
      keyframes: [
        { time: 0, transform: { scale: 1.1 }, ease: "linear" },
        { time: 2, transform: { scale: 1.1 }, ease: "linear" },
      ],
    })).toBe(false);
    expect(hasAnimatedTransform({
      keyframes: [
        { time: 0, transform: { scale: 1 }, ease: "linear" },
        { time: 4.5, transform: { scale: 1.065 }, ease: "linear" },
      ],
    })).toBe(true);
    expect(hasAnimatedTransform({
      keyframes: [
        { time: 0, transform: { x: 0 }, ease: "linear" },
        { time: 2, transform: { x: -0.02 }, ease: "linear" },
      ],
    })).toBe(true);
  });

  it("picks an aspect-exact working canvas that preserves source detail without exceeding 4K or 2x", () => {
    // Subtle 1.065x zoom on 4K source in 540p preview: snaps to aspect-exact 1024x576 (16:9).
    const subtle540 = smoothWorkingSize(960, 540, 1.065, { width: 3840, height: 2160 });
    expect(subtle540).toEqual({ width: 1024, height: 576, sRel: 1 });
    expect(subtle540.width * 540).toBe(subtle540.height * 960);

    // 4K export on a 4K source has headroom 1x: stays at 3840x2160.
    expect(smoothWorkingSize(3840, 2160, 1.2, { width: 3840, height: 2160 })).toEqual({
      width: 3840, height: 2160, sRel: 1,
    });

    // Deep 3x zoom on 4K source in 540p preview caps at 2x (1920x1080).
    expect(smoothWorkingSize(960, 540, 3, { width: 3840, height: 2160 })).toEqual({
      width: 1920, height: 1080, sRel: 1,
    });

    // Zoomed-out sliding inset stays at canvas size and pre-scales down cleanly.
    expect(smoothWorkingSize(960, 540, 0.35, { width: 1920, height: 1080 })).toEqual({
      width: 960, height: 540, sRel: 0.35,
    });
  });

  it("uses the fast unpadded yuva420p perspective path for opaque full-canvas zooms", () => {
    const tf = resolveTransform({
      id: "broll",
      keyframes: [
        { time: 0, transform: { x: 0, y: 0, scale: 1 }, ease: "linear" },
        { time: 4.5, transform: { x: -0.012, y: 0.006, scale: 1.065 }, ease: "easeInOut" },
      ],
    }, () => {});
    const stages = smoothTransformStages(tf, 960, 540, {
      fps: 30,
      startTime: 0,
      source: { width: 3840, height: 2160, hasAlpha: false },
    });
    expect(stages.prepare.some((f) => f.includes("format=yuva420p"))).toBe(true);
    expect(stages.prepare.some((f) => f.startsWith("pad="))).toBe(false);
    expect(stages.animate[0]).toMatch(/^perspective=.*:interpolation=cubic:sense=source:eval=frame$/);
    expect(stages.animate).toContain("scale=960:540:flags=bicubic");
  });

  it("fits non-square pixels by their displayed shape on the perspective path", () => {
    const tf = resolveTransform({
      id: "dv",
      keyframes: [
        { time: 0, transform: { scale: 1 }, ease: "linear" },
        { time: 2, transform: { scale: 1.05 }, ease: "linear" },
      ],
    }, () => {});
    // 720x480 at SAR 8:9 shows 640x480, so on a 720x480 canvas it leaves bars and needs the transparent pad.
    const narrow = smoothTransformStages(tf, 720, 480, { fps: 30, startTime: 0, source: { width: 720, height: 480, hasAlpha: false, sar: 8 / 9 } });
    expect(narrow.prepare[0]).toBe("scale=w='max(2,trunc(iw*sar*min(720/(iw*sar),480/ih)/2+1e-9)*2)':h='max(2,trunc(ih*min(720/(iw*sar),480/ih)/2+1e-9)*2)':flags=bicubic");
    expect(narrow.prepare.some((f) => f.startsWith("pad="))).toBe(true);
    // 720x480 at SAR 32:27 shows 16:9, so it fills a 960x540 canvas and keeps the fast unpadded path.
    const wide = smoothTransformStages(tf, 960, 540, { fps: 30, startTime: 0, source: { width: 720, height: 480, hasAlpha: false, sar: 32 / 27 } });
    expect(wide.prepare.some((f) => f.startsWith("pad="))).toBe(false);
  });

  it("uses premultiplied transparent padding when edges, alpha, portrait aspect, corners or rotation can show", () => {
    const cases: Array<{ name: string; clip: Parameters<typeof resolveTransform>[0]; source?: { width?: number; height?: number; hasAlpha?: boolean } }> = [
      {
        name: "portrait source on 16:9 canvas",
        clip: { id: "p", keyframes: [{ time: 0, transform: { scale: 1 }, ease: "linear" }, { time: 2, transform: { scale: 1.1 }, ease: "linear" }] },
        source: { width: 1080, height: 1920, hasAlpha: false },
      },
      {
        name: "pan exposing canvas edge",
        clip: { id: "pan", keyframes: [{ time: 0, transform: { x: 0, scale: 1 }, ease: "linear" }, { time: 2, transform: { x: 0.1, scale: 1.05 }, ease: "linear" }] },
        source: { width: 1920, height: 1080, hasAlpha: false },
      },
      {
        name: "source with alpha",
        clip: { id: "a", keyframes: [{ time: 0, transform: { scale: 1 }, ease: "linear" }, { time: 2, transform: { scale: 1.1 }, ease: "linear" }] },
        source: { width: 1920, height: 1080, hasAlpha: true },
      },
      {
        name: "rounded corners",
        clip: { id: "r", transform: { x: 0, y: 0, scale: 1, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, cornerRadius: 0.1 }, keyframes: [{ time: 0, transform: { scale: 1 }, ease: "linear" }, { time: 2, transform: { scale: 1.1 }, ease: "linear" }] },
        source: { width: 1920, height: 1080, hasAlpha: false },
      },
    ];
    for (const c of cases) {
      const tf = resolveTransform(c.clip, () => {});
      const stages = smoothTransformStages(tf, 960, 540, { fps: 30, startTime: 1.25, source: c.source });
      expect(stages.prepare, c.name).toContain("format=gbrap");
      expect(stages.prepare.some((f) => f.startsWith("pad=")), c.name).toBe(true);
      expect(stages.prepare, c.name).toContain("premultiply=inplace=1");
      expect(stages.animate[0], c.name).toContain("1.25+(on-1)/30");
      expect(stages.animate, c.name).toContain("unpremultiply=inplace=1");
      expect(stages.animate.at(-1), c.name).toBe("format=yuva420p");
    }
  });
});
