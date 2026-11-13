import { describe, expect, it } from "vitest";
import type { Clip, TimelineDiff } from "@scarlet/timeline";
import { describeDiff, formatTimecode } from "@scarlet/timeline";
import { diffLines, diffSummary, fieldChanges } from "./diffText";

const clip = (id: string, timelineIn: number, sourceIn: number, sourceOut: number, label?: string): Clip => ({
  id,
  kind: "media",
  mediaId: "m",
  sourceIn,
  sourceOut,
  timelineIn,
  label,
  speed: 1,
  enabled: true,
  opacity: 1,
  volume: 1,
  audioFadeIn: 0,
  audioFadeOut: 0,
  videoFadeIn: 0,
  videoFadeOut: 0,
  effects: [],
});

const diff: TimelineDiff = {
  clips: [
    { type: "added", trackId: "v1", clip: clip("c1", 2, 0, 3, "Intro") },
    { type: "removed", trackId: "v1", clip: clip("c2", 5, 10, 12) },
    { type: "modified", trackId: "v1", before: clip("c3", 7, 0, 5, "Wrap"), after: clip("c3", 7, 0.5, 5, "Wrap"), fields: ["sourceIn"] },
    { type: "movedTrack", fromTrackId: "v1", toTrackId: "v2", before: clip("c4", 9, 0, 1, "Logo"), after: clip("c4", 9, 0, 1, "Logo") },
  ],
  tracks: [{ type: "trackModified", trackId: "a1", fields: ["muted"] }],
  markersChanged: true,
  timelineFieldsChanged: [],
  ranges: [],
  beforeRanges: [],
  spots: [],
  durationBefore: 20,
  durationAfter: 17.5,
};

const fmt = (s: number) => formatTimecode(s, 30);

describe("diffLines", () => {
  it("uses the same wording as describeDiff, in the same order", () => {
    const lines = diffLines(diff, fmt);
    expect(lines.map((l) => l.text)).toEqual(describeDiff(diff, fmt));
  });

  it("tags each line with a kind and jump time", () => {
    const lines = diffLines(diff, fmt);
    expect(lines.map((l) => l.kind)).toEqual(["added", "removed", "modified", "moved", "track", "markers", "duration"]);
    expect(lines[0]).toMatchObject({ at: 2, text: "Added media clip Intro at 0:02.00" });
    expect(lines[1]!.text).toBe("Removed media clip c2 (0:05.00–0:07.00)");
    expect(lines[6]!.text).toBe("Duration 0:20.00 → 0:17.15");
  });

  it("expands modified clips into before/after field values", () => {
    const line = diffLines(diff, fmt)[2]!;
    expect(line.fields).toEqual([{ field: "sourceIn", before: "0", after: "0.5" }]);
  });

  it("omits the duration line when duration is unchanged", () => {
    const same = { ...diff, durationAfter: 20, markersChanged: false, tracks: [] };
    const kinds = diffLines(same, fmt).map((l) => l.kind);
    expect(kinds).toEqual(["added", "removed", "modified", "moved"]);
  });
});

describe("fieldChanges", () => {
  it("formats numbers, strings, booleans and objects compactly", () => {
    const before = { ...clip("x", 0, 0, 1), volume: 1, enabled: true, transform: undefined };
    const after = { ...clip("x", 0, 0, 1), volume: 0.25, enabled: false, transform: { x: 0, y: 0, scale: 1.2, rotation: 0, cropLeft: 0 } };
    expect(fieldChanges(before as Clip, after as Clip, ["volume", "enabled", "transform"])).toEqual([
      { field: "volume", before: "1", after: "0.25" },
      { field: "enabled", before: "yes", after: "no" },
      { field: "transform", before: "–", after: "{x, y, scale, rotation, …}" },
    ]);
  });
});

describe("diffSummary", () => {
  it("counts by type and shows the duration delta", () => {
    expect(diffSummary(diff)).toBe("1 added · 1 removed · 1 changed · 1 moved · 1 track · −2.50s");
  });
  it("has an empty-state string", () => {
    expect(diffSummary({ ...diff, clips: [], tracks: [], durationAfter: 20 })).toBe("No clip changes");
  });
});
