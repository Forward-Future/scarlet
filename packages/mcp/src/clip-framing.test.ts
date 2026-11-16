import { describe, expect, it } from "vitest";
import { applyOps, emptyTimeline } from "@scarlet/timeline";
import { unframedBeside } from "./clip-framing.js";

const inset = { x: 0.35, y: 0.315, scale: 0.32, rotation: 0, cropLeft: 0.15, cropRight: 0.15, cropTop: 0.09, cropBottom: 0.09 };

function base() {
  return applyOps(emptyTimeline("p"), [
    { op: "addTrack", track: { id: "cam", kind: "video", name: "Camera", clips: [] } },
    { op: "addClip", trackId: "cam", clip: { id: "a", kind: "media", mediaId: "camera", sourceIn: 0, sourceOut: 10, timelineIn: 0, transform: inset } },
    { op: "addClip", trackId: "cam", clip: { id: "b", kind: "media", mediaId: "camera", sourceIn: 30, sourceOut: 40, timelineIn: 10, transform: inset } },
  ]);
}

describe("unframedBeside", () => {
  it("names a clip put back full frame between framed clips of the same recording", () => {
    const before = base();
    const after = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "back", kind: "media", mediaId: "camera", sourceIn: 10, sourceOut: 30, timelineIn: 10, speed: 4 } },
    ]);
    expect(unframedBeside(before, after)).toEqual([{ clipId: "back", trackId: "cam", at: 10, beside: { clipId: "a", transform: expect.objectContaining({ scale: 0.32 }) } }]);
  });

  it("says nothing when the added clip is framed, or its neighbours are another recording or unframed too", () => {
    const before = base();
    const framed = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "back", kind: "media", mediaId: "camera", sourceIn: 10, sourceOut: 15, timelineIn: 10, transform: inset } },
    ]);
    expect(unframedBeside(before, framed)).toEqual([]);
    const other = applyOps(before, [
      { op: "rippleInsertGap", at: 10, duration: 5 },
      { op: "addClip", trackId: "cam", clip: { id: "still", kind: "media", mediaId: "photo", sourceIn: 0, sourceOut: 5, timelineIn: 10 } },
    ]);
    expect(unframedBeside(before, other)).toEqual([]);
    // A split keeps the framing on both halves, so nothing it makes is new and unframed.
    expect(unframedBeside(before, applyOps(before, [{ op: "splitClip", clipId: "a", at: 5, newClipId: "a2" }]))).toEqual([]);
  });
});
