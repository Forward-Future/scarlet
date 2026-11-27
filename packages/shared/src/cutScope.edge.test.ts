import { describe, expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, type Clip, type Timeline } from "@scarlet/timeline";
import { cutAnchorOn, cutScope, rippleDrift, selectionPlacements } from "./cutScope.js";

/** One video track of the given clips, saved as `version`. */
const timeline = (version: string, clips: Clip[]): Timeline => {
  const tl = emptyTimeline("project");
  tl.version = version;
  tl.tracks[0]!.clips = clips;
  return tl;
};
const camera = (sourceIn: number, sourceOut: number, timelineIn: number, id: string) => makeMediaClip("camera", sourceIn, sourceOut, timelineIn, { id });

// A minute of one take, and the version after 10–20 s was taken out.
const original = timeline("v1", [camera(0, 60, 0, "c1")]);
const cut = timeline("v2", [camera(0, 10, 0, "c1"), camera(20, 60, 10, "c1b")]);

describe("cutAnchorOn", () => {
  it("keeps the anchor as it was when there is nothing to translate", () => {
    const anchor = { time: 25, end: 30 };
    expect(cutAnchorOn(anchor, cut)).toBe(anchor);
    expect(cutAnchorOn(anchor, cut, { ...cut })).toBe(anchor);
    const source = { mediaId: "camera", time: 25, end: 30 };
    expect(cutAnchorOn(source, cut, original)).toBe(source);
    const playheadless = { changeId: "chg" };
    expect(cutAnchorOn(playheadless, cut, original)).toBe(playheadless);
  });

  it("moves a selection after a removal by what was taken out", () => {
    expect(cutAnchorOn({ time: 25, end: 30 }, cut, original)).toEqual({ time: 15, end: 20 });
    expect(cutAnchorOn({ time: 5, end: 8 }, cut, original)).toEqual({ time: 5, end: 8 });
  });

  it("moves a pinned playhead with no end", () => {
    expect(cutAnchorOn({ time: 40 }, cut, original)).toEqual({ time: 30, end: undefined });
  });

  it("puts an edge whose frame was taken out at the join it now sits on", () => {
    expect(cutAnchorOn({ time: 12, end: 30 }, cut, original)).toEqual({ time: 10, end: 20 });
    expect(cutAnchorOn({ time: 5, end: 15 }, cut, original)).toEqual({ time: 5, end: 10 });
  });

  it("reads an edge at the end of the edit from the clip ending there", () => {
    expect(cutAnchorOn({ time: 60, end: 60 }, cut, original)).toEqual({ time: 50, end: 50 });
  });

  it("uses the passage the first save established, on the edit and not on a source or change", () => {
    const anchor = { mediaId: "camera", changeId: "chg", time: 1, end: 2, dialogueRange: { version: "v1", start: 30, end: 40 } };
    expect(cutAnchorOn(anchor, cut, original)).toEqual({ ...anchor, mediaId: undefined, changeId: undefined, time: 20, end: 30 });
    expect(cutAnchorOn(anchor, cut)).toEqual({ ...anchor, mediaId: undefined, changeId: undefined, time: 30, end: 40 });
  });

  it("doesn't follow the same footage into another copy of the clip", () => {
    // The take plays twice; the first copy is taken out. Its footage survives in the second copy, which isn't the
    // editor's placement, so the selection moves to where the first copy joined.
    const twice = timeline("v1", [camera(0, 10, 0, "first"), camera(0, 10, 10, "second")]);
    const once = timeline("v2", [camera(0, 10, 0, "second")]);
    expect(cutAnchorOn({ time: 5, end: 15 }, once, twice)).toEqual({ time: 0, end: 5 });
  });

  it("asks for the passage again when it is no longer on the edit at all", () => {
    const replaced = timeline("v2", [makeMediaClip("other", 0, 60, 0, { id: "o1" })]);
    expect(() => cutAnchorOn({ time: 5, end: 8 }, replaced, original)).toThrow(/The selected passage changed/);
  });
});

describe("selectionPlacements", () => {
  it("places nothing without a playhead or selection", () => {
    expect(selectionPlacements(original, {})).toEqual([]);
    expect(selectionPlacements(original, { mediaId: "camera" })).toEqual([]);
  });

  it("places a timeline selection or playhead as it is", () => {
    expect(selectionPlacements(original, { time: 3, end: 5 })).toEqual([{ start: 3, end: 5 }]);
    expect(selectionPlacements(original, { time: 3 })).toEqual([{ start: 3, end: 3 }]);
  });

  it("places a source playhead on every enabled copy of its footage", () => {
    const tl = timeline("v1", [
      camera(0, 10, 0, "a"),
      camera(0, 10, 20, "b"),
      makeMediaClip("camera", 0, 10, 40, { id: "off", enabled: false }),
      makeMediaClip("other", 0, 10, 50, { id: "o" }),
      camera(6, 9, 60, "late"),
    ]);
    expect(selectionPlacements(tl, { mediaId: "camera", time: 4 })).toEqual([{ start: 4, end: 4 }, { start: 24, end: 24 }]);
  });

  it("places a source selection on the part of each copy it overlaps", () => {
    const tl = timeline("v1", [camera(0, 10, 0, "a"), camera(8, 20, 30, "b"), camera(15, 20, 50, "c")]);
    expect(selectionPlacements(tl, { mediaId: "camera", time: 6, end: 12 })).toEqual([{ start: 6, end: 10 }, { start: 30, end: 34 }]);
  });
});

describe("cutScope", () => {
  const tl = timeline("v1", [camera(0, 60, 0, "c1")]);

  it("runs over the whole edit when nothing bounds it", () => {
    expect(cutScope(tl, undefined)).toEqual({ start: 0, end: 60 });
    expect(cutScope(tl, {})).toEqual({ start: 0, end: 60 });
  });

  it("refuses an empty range or one outside the edit", () => {
    for (const range of [{ start: -1, end: 5 }, { start: 5, end: 5 }, { start: 6, end: 5 }, { start: 50, end: 61 }])
      expect(() => cutScope(tl, undefined, range)).toThrow("Choose a nonempty range inside the timeline.");
  });

  it("asks for timeline seconds for a selection in a recording's own seconds", () => {
    expect(() => cutScope(tl, { mediaId: "camera", time: 3, end: 5 })).toThrow("Map the selected source range to timeline seconds.");
    expect(() => cutScope(tl, { mediaId: "camera", time: 3, end: 5 }, undefined, true)).toThrow("Supply the local timeline range for the pause edit.");
  });

  it("lets a source playhead's request reach anywhere unless it is a local pause edit", () => {
    expect(cutScope(tl, { mediaId: "camera", time: 3 }, { start: 30, end: 40 })).toEqual({ start: 30, end: 40 });
    expect(cutScope(tl, { mediaId: "camera", time: 3 }, { start: 2, end: 4 }, true)).toEqual({ start: 2, end: 4 });
    expect(cutScope(tl, { mediaId: "camera", time: 3 }, { start: 3, end: 4 }, true)).toEqual({ start: 3, end: 4 });
  });

  it("lets a local pause edit around a timeline playhead contain it", () => {
    expect(cutScope(tl, { time: 10 }, { start: 9, end: 11 }, true)).toEqual({ start: 9, end: 11 });
    expect(() => cutScope(tl, { time: 10 }, { start: 11, end: 12 }, true)).toThrow("The local range must contain the pinned playhead.");
    expect(cutScope(tl, {}, { start: 11, end: 12 }, true)).toEqual({ start: 11, end: 12 });
  });

  it("uses a timeline selection for a local pause edit with no range of its own", () => {
    expect(cutScope(tl, { time: 10, end: 12 }, undefined, true)).toEqual({ start: 10, end: 12 });
  });
});

describe("rippleDrift", () => {
  it("brings an earlier join inside a later removal to that removal's start", () => {
    const drift = rippleDrift();
    // 10–11 s comes out 0.1 s short: the join at 10 s is followed by 0.1 s more than asked.
    drift.removed({ start: 10, end: 11 }, { start: 10.05, end: 10.95 });
    // 8–12 s on the edit as asked now covers that join; it moves to 8 s.
    drift.removed({ start: 8, end: 12 }, { start: 8, end: 12 });
    expect(drift.place({ start: 7, end: 8 })).toEqual({ start: 7, end: 8 });
    const after = drift.place({ start: 8, end: 9 });
    expect(after.start).toBeCloseTo(8.1, 9);
    expect(after.end).toBeCloseTo(9.1, 9);
  });

  it("adds no mark for a removal made exactly as asked", () => {
    const drift = rippleDrift();
    drift.removed({ start: 1, end: 2 }, { start: 1, end: 2 });
    expect(drift.place({ start: 5, end: 6 })).toEqual({ start: 5, end: 6 });
  });
});
