import { describe, expect, it } from "vitest";
import { applyOps, type Timeline } from "@scarlet/timeline";
import { besides, removedSince } from "./removedSince";

const clip = (id: string, timelineIn: number, sourceIn: number, sourceOut: number) => ({
  id, kind: "media" as const, mediaId: "med_a", timelineIn, sourceIn, sourceOut, speed: 1, opacity: 1, volume: 1, enabled: true, effects: [],
});
const base = {
  version: "v1", projectId: "prj", name: "Cut", markers: [], background: "#000", createdAt: "2026-11-13T00:00:00.000Z",
  tracks: [
    { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [clip("a", 0, 100, 160)] },
    { id: "a1", kind: "audio", name: "A1", muted: false, hidden: false, clips: [clip("b", 0, 100, 160)] },
  ],
} as unknown as Timeline;

describe("removedSince", () => {
  it("finds every passage a later version jumps over, in the earlier clock, with its join", () => {
    const now = applyOps(base, [
      { op: "rippleDelete", start: 40, end: 45 },
      { op: "rippleDelete", start: 20, end: 22.5 },
      { op: "rippleDelete", start: 0, end: 1 },
    ]);
    expect(removedSince(base, now, 30).map(r => [r.removed.start, r.removed.end, r.at])).toEqual([
      [0, 1, 0], [20, 22.5, 19], [40, 45, 36.5],
    ]);
  });

  it("finds a passage taken off the end, and nothing when the versions hold the same footage", () => {
    const now = applyOps(base, [{ op: "rippleDelete", start: 55, end: 60 }]);
    expect(removedSince(base, now, 30).map(r => r.removed)).toEqual([{ start: 55, end: 60 }]);
    expect(removedSince(base, { ...base, version: "v2" }, 30)).toEqual([]);
  });
});

describe("besides", () => {
  it("leaves out the passages already shown, and the slivers they leave", () => {
    const removals = [{ removed: { start: 10, end: 20 }, at: 10 }, { removed: { start: 30, end: 31 }, at: 20 }];
    expect(besides(removals, [{ start: 12, end: 19.95 }, { start: 30, end: 31 }], 30)).toEqual([
      { removed: { start: 10, end: 12 }, at: 10 },
    ]);
  });
});
