import { describe, expect, it } from "vitest";
import { frameAligned, type TimelineOp } from "@scarlet/timeline";
import { boundedRippleOps, rippleDrift } from "./cutScope.js";

const ripple = (start: number, end: number): TimelineOp => ({ op: "rippleDelete", start, end });

describe("rippleDrift", () => {
  it("moves a later removal by what an earlier one, put on whole frames, left in", () => {
    // At 30 fps the first removal comes out as 10.0333–12.0: 1.9667 s, not the 2.010 s asked. The second was written
    // on the edit with 2.010 s out, so the footage it meant now sits 0.0433 s later.
    const drift = rippleDrift();
    const first = drift.place({ start: 10.01, end: 12.02 });
    expect(first).toEqual({ start: 10.01, end: 12.02 });
    const removed = frameAligned(first, 30);
    drift.removed({ start: 10.01, end: 12.02 }, removed);
    const second = drift.place({ start: 20, end: 21 });
    expect(second.start).toBeCloseTo(20.0433, 4);
    expect(second.end).toBeCloseTo(21.0433, 4);
    // Before the earlier removal nothing moved, and an end at its join is the footage before it.
    expect(drift.place({ start: 5, end: 10.01 })).toEqual({ start: 5, end: 10.01 });
    // A start at the join is the first footage kept after it.
    expect(drift.place({ start: 10.01, end: 11 }).start).toBeCloseTo(10.0533, 4);
  });

  it("follows each earlier removal in the edit it was written on", () => {
    const drift = rippleDrift();
    // 1 s asked, 0.9 s made; the next removal is written after that one, 2 s asked and 1.8 s made.
    drift.removed({ start: 10, end: 11 }, { start: 10.05, end: 10.95 });
    const placed = drift.place({ start: 4, end: 6 });
    expect(placed).toEqual({ start: 4, end: 6 });
    drift.removed({ start: 4, end: 6 }, { start: 4.1, end: 5.9 });
    // 10 s on the edit as asked is past both removals, so 0.1 + 0.2 s later on the edit as made.
    const after = drift.place({ start: 10, end: 12 });
    expect(after.start).toBeCloseTo(10.3, 9);
    expect(after.end).toBeCloseTo(12.3, 9);
    // 7 s is past the second removal but, with its 2 s back, still before the first: only the second's 0.2 s applies.
    expect(drift.place({ start: 7, end: 7.9 }).start).toBeCloseTo(7.2, 9);
  });
});

describe("boundedRippleOps", () => {
  it("places each later removal on the footage it was written for, not a frame earlier per cut before it", () => {
    const fps = 30;
    const placed = boundedRippleOps([ripple(10.01, 12.02), ripple(20, 21)], { start: 0, end: 60 }, fps, 60);
    expect(placed[0]!.start).toBeCloseTo(301 / 30, 9);
    expect(placed[0]!.end).toBeCloseTo(12, 9);
    // 20–21 s on the edit as asked is 20.0433–21.0433 s on the edit as made, and goes inward onto frames from there.
    expect(placed[1]!.start).toBeCloseTo(602 / 30, 9);
    expect(placed[1]!.end).toBeCloseTo(631 / 30, 9);
  });

  it("keeps the end of a removal that runs to the end of the selection as the earlier removals left it", () => {
    // 60 s selected to the edit's end; the first removal takes out 1.9667 s of the 2.010 asked.
    const placed = boundedRippleOps([ripple(10.01, 12.02), ripple(50, 60 - 2.01)], { start: 0, end: 60 }, 30, 60);
    expect(placed[1]!.end).toBeCloseTo(60 - (12 - 301 / 30), 9);
  });

  it("still refuses a removal outside the selection as it shortens", () => {
    expect(() => boundedRippleOps([ripple(1, 2), ripple(3, 9.5)], { start: 0, end: 10 }, 30, 20)).toThrow(/inside the selected timeline range/);
  });
});
