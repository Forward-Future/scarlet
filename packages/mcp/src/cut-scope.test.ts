import { expect, it } from "vitest";
import { emptyTimeline, makeMediaClip } from "@scarlet/timeline";
import { cutScope, selectedRange } from "./cut-scope.js";

it("maps a selected source through playback speed and distinguishes separate placements", () => {
  const tl = emptyTimeline("project");
  tl.tracks[0]!.clips = [makeMediaClip("camera", 10, 14, 3, { speed: 2 }), makeMediaClip("camera", 10, 14, 8)];
  const selected = { mediaId: "camera", time: 11, end: 13 };
  for (const range of [{ start: 3.5, end: 4.5 }, { start: 9, end: 11 }]) {
    expect(cutScope(tl, selected, range)).toEqual(range);
  }
  expect(() => cutScope(tl, selected, { start: 3.5, end: 11 })).toThrow(/source placement/);
  expect(() => cutScope(tl, { mediaId: "camera", time: 11 }, { start: 5, end: 6 }, true)).toThrow(/source placement/);
});

it("reads a request sent from an applied edit as about that edit, not as a selection to stay inside", () => {
  const tl = emptyTimeline("project");
  tl.tracks[0]!.clips = [makeMediaClip("camera", 0, 60, 0)];
  // The message box was aimed at an applied cut. Its context says where the cut plays: the join at 10 s and a moment either side.
  const aimed = { changeId: "change", editIndex: 0, time: 8.5, end: 11.5 };
  expect(cutScope(tl, aimed)).toEqual({ start: 0, end: 60 });
  // "Take out the sentence before this too" removes what plays before that range.
  expect(cutScope(tl, aimed, { start: 3, end: 8.4 })).toEqual({ start: 3, end: 8.4 });
  expect(selectedRange(aimed)).toBeUndefined();
  // /tighten-pauses-here sent from the edit names its own range, around where the edit starts.
  expect(() => cutScope(tl, aimed, undefined, true)).toThrow("Supply the local timeline range for the pause edit.");
  expect(cutScope(tl, aimed, { start: 8, end: 9 }, true)).toEqual({ start: 8, end: 9 });
  expect(() => cutScope(tl, aimed, { start: 3, end: 8.4 }, true)).toThrow("The local range must contain the pinned playhead.");
  // The same times as a range the editor selected, or beside a staged cut, still bound the request.
  for (const selection of [{ time: 8.5, end: 11.5 }, { changeId: "change", cutIndex: 0, time: 8.5, end: 11.5 }]) {
    expect(selectedRange(selection)).toEqual({ start: 8.5, end: 11.5 });
    expect(cutScope(tl, selection)).toEqual({ start: 8.5, end: 11.5 });
    expect(() => cutScope(tl, selection, { start: 3, end: 8.4 })).toThrow("Stay inside the selected timeline range.");
  }
  // A playhead alone selects nothing.
  expect(selectedRange({ time: 8.5 })).toBeUndefined();
  expect(selectedRange(undefined)).toBeUndefined();
});
