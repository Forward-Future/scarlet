import { expect, it } from "vitest";
import { timelineFromKeepRanges } from "@scarlet/timeline";
import { newClipEdges } from "./timeline-validation.js";

it("lists a cut at a second where another clip of the recording plays straight on", () => {
  // 0-10 and 10-20 are the halves of a split, and 5-10 plays again after them: its end at 10 s is a real cut.
  const next = timelineFromKeepRanges("prj", "cam", [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 5, end: 10 }]);
  const repeat = next.tracks.flatMap(t => t.clips).filter(c => c.kind === "media" && c.sourceIn === 5).map(c => c.id);
  const edges = newClipEdges(null, next, [{ id: "cam", duration: 20 }]);
  expect(edges.map(e => [e.side, e.source])).toEqual([["in", 5], ["out", 10]]);
  expect(repeat).toContain(edges[1]!.clipId);
});
