import { expect, it } from "vitest";
import type { Change, ReviewCut } from "@scarlet/timeline";
import { appliedEditSummary, reviewReasons } from "./cutReviewDetails";

it("maps rounded legacy labels to the original ranges, retaining both reasons at a merged join", () => {
  const change = {
    description: "Optional dialogue cuts · 5.12 s: First attempt. · 6.00 s: Restart. · 12.92 s: Hesitation.",
    ops: [
      { op: "rippleDelete", start: 12.923, end: 14 },
      { op: "rippleDelete", start: 6, end: 8 },
      { op: "rippleDelete", start: 5.124, end: 6 },
    ],
  };
  const cuts = [
    { beforeClip: 1, at: 5.124, removed: { start: 5.124, end: 8 } },
    { beforeClip: 2, at: 10.047, removed: { start: 12.923, end: 14 } },
  ] satisfies ReviewCut[];
  expect(reviewReasons(change, cuts)).toEqual([["First attempt.", "Restart."], ["Hesitation."]]);
});

it("says how much the applied cuts took out as a cut's own length reads, not to the hundredth of a second", () => {
  const applied = (...removed: Array<[number, number]>) => appliedEditSummary({ description: "Dialogue pass", appliedReview: { originalVersion: "v1", originalDuration: 600, duration: 500,
    joins: removed.map(([start, end]) => ({ at: start, removed: { start, end } })) } } as Change);
  expect(applied([5.124, 8], [12.923, 22.387])).toBe("Removed 12 s of footage in 2 cuts.");
  expect(applied([5.124, 8])).toBe("Removed 2.9 s of footage in 1 cut.");
  expect(applied([10, 141])).toBe("Removed 2:11 of footage in 1 cut.");
  expect(applied()).toBe("Kept all the reviewed footage.");
});
