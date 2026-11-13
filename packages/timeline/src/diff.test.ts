import { describe, expect, it } from "vitest";
import { applyOps, describeDiff, diffTimelines, emptyTimeline, formatTimecode, makeMediaClip, makeTrack, type Timeline } from "./index.js";

function base(): Timeline {
  const tl = emptyTimeline("project");
  tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 10, 0, { id: "a", label: "Intro" }), makeMediaClip("cam", 30, 40, 10, { id: "b" })];
  tl.tracks[1]!.clips = [makeMediaClip("music", 0, 20, 0, { id: "music" })];
  return tl;
}

describe("diffTimelines", () => {
  it("finds nothing between a timeline and its copy, whatever their versions", () => {
    const before = base();
    const d = diffTimelines(before, { ...structuredClone(before), version: "v2", parent: "v1", createdAt: "2026-01-01T00:00:00Z" });
    expect(d).toMatchObject({ clips: [], tracks: [], markersChanged: false, timelineFieldsChanged: [], ranges: [], durationBefore: 20, durationAfter: 20 });
    expect(describeDiff(d)).toEqual([]);
  });

  it("tells a clip added, removed, changed and moved to another track apart", () => {
    const before = base();
    const after = applyOps(before, [
      { op: "addClip", trackId: "v1", clip: makeMediaClip("cam", 50, 55, 20, { id: "new" }) },
      { op: "removeClip", clipId: "b" },
      { op: "updateClip", clipId: "a", patch: { volume: 0.5, transform: { scale: 1.2 } } },
      { op: "moveClip", clipId: "music", timelineIn: 0, trackId: "v1" },
    ]);
    const d = diffTimelines(before, after);
    expect(d.clips.map(c => c.type).sort()).toEqual(["added", "modified", "movedTrack", "removed"]);
    expect(d.clips.find(c => c.type === "modified")).toMatchObject({ trackId: "v1", fields: ["volume", "transform"], before: { volume: 1 }, after: { volume: 0.5 } });
    expect(d.clips.find(c => c.type === "movedTrack")).toMatchObject({ fromTrackId: "a1", toTrackId: "v1" });
    expect(d.clips.find(c => c.type === "removed")).toMatchObject({ trackId: "v1", clip: { id: "b" } });
    expect(d).toMatchObject({ durationBefore: 20, durationAfter: 25 });
    expect(describeDiff(d, t => formatTimecode(t, 30))).toEqual([
      "Changed volume, transform on Intro at 0:00.00",
      "Removed media clip b (0:10.00–0:20.00)",
      "Moved music to track v1",
      "Added media clip new at 0:20.00",
      "Duration 0:20.00 → 0:25.00",
    ]);
  });

  it("does not call a clip changed when its nested values are equal but not the same objects", () => {
    const before = base();
    (before.tracks[0]!.clips[0] as { effects: unknown[] }).effects = [{ type: "blur", enabled: true, params: { radius: 2, mode: { a: 1, b: 2 } } }];
    const after = structuredClone(before);
    (after.tracks[0]!.clips[0] as { effects: unknown[] }).effects = [{ params: { mode: { b: 2, a: 1 }, radius: 2 }, enabled: true, type: "blur" }];
    expect(diffTimelines(before, after).clips).toEqual([]);
  });

  it("reports tracks added, removed, patched and reordered, and clips reordered within one", () => {
    const before = base();
    const after = structuredClone(before);
    after.tracks = [after.tracks[1]!, after.tracks[0]!, makeTrack("video", "B-roll", "v2")];
    after.tracks[0]!.muted = true;
    after.tracks[1]!.clips.reverse();
    const d = diffTimelines(before, after);
    expect(d.tracks).toEqual([
      { type: "trackModified", trackId: "v1", fields: ["track order", "clip order"] },
      { type: "trackModified", trackId: "a1", fields: ["muted", "track order"] },
      { type: "trackAdded", track: after.tracks[2] },
    ]);
    expect(diffTimelines(after, before).tracks.at(-1)).toEqual({ type: "trackRemoved", track: after.tracks[2] });
    expect(describeDiff(diffTimelines(after, before)).at(-1)).toBe("Removed track B-roll");
    expect(describeDiff(d)).toEqual(["Changed track order, clip order on track v1", "Changed muted, track order on track a1", "Added track B-roll"]);
  });

  it("reports changed markers and timeline settings, but never the version, parent or save time", () => {
    const before = base();
    const after = applyOps(before, [{ op: "setTimeline", patch: { name: "Final", background: "#101010" } },
      { op: "addMarker", marker: { id: "m", time: 3, kind: "note", text: "Check", resolved: false } }]);
    const d = diffTimelines(before, { ...after, version: "v9", parent: "v8", createdAt: "2026-01-01T00:00:00Z" });
    expect(d.markersChanged).toBe(true);
    expect(d.timelineFieldsChanged).toEqual(["name", "background"]);
    expect(describeDiff(d)).toEqual(["Changed timeline name", "Changed timeline background", "Markers changed"]);
  });

  it("pairs each changed range on the new cut with its range on the old one", () => {
    const before = base();
    const d = diffTimelines(before, applyOps(before, [{ op: "rippleDelete", start: 4, end: 6 }]));
    expect(d.spots).toHaveLength(1);
    expect(d.ranges).toEqual(d.spots.map(s => s.after));
    expect(d.beforeRanges).toEqual(d.spots.map(s => s.before));
    // The removal is two seconds of the old cut and a join on the new one.
    expect(d.beforeRanges[0]).toEqual({ start: 4, end: 6 });
    expect(d.ranges[0]!.start).toBe(4);
    expect(describeDiff(d).at(-1)).toBe("Duration 20.00 → 18.00");
  });
});
