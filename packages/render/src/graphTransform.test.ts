import { expect, it } from "vitest";
import type { MediaAsset, MediaClip } from "@scarlet/timeline";
import { proxyHeightForClip } from "./graphTransform.js";

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
