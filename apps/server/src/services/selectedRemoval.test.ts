import { emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { expect, it } from "vitest";
import { rippleOutsideSelection } from "./selectedRemoval.js";

it("accepts a ripple inside the selection that crosses a split between two touching clips", () => {
  const timeline = emptyTimeline("prj_test");
  timeline.tracks[0]!.clips = [makeMediaClip("med_a", 0, 10, 0), makeMediaClip("med_a", 10, 20, 10)];
  // One range per clip, as a selection tied to one recording gives.
  const allowed = [{ start: 5, end: 10 }, { start: 10, end: 15 }];

  expect(rippleOutsideSelection(timeline, [{ op: "rippleDelete", start: 7, end: 12 }], allowed)).toBeUndefined();
  expect(rippleOutsideSelection(timeline, [{ op: "rippleDelete", start: 3, end: 6 }], allowed)).toMatchObject({ start: 3, end: 6 });
  expect(rippleOutsideSelection(timeline, [{ op: "rippleDelete", start: 12, end: 16 }], allowed)).toMatchObject({ start: 12, end: 16 });
});
