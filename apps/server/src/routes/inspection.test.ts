import { expect, it } from "vitest";
import type { CutEvent, InspectionWindow } from "@scarlet/shared";
import { newCutEvents } from "./inspection.js";

const fps = 25;
/** A window around `focus` with what was found in it. Only the parts the comparison reads. */
const window = (label: string, focus: number, events?: CutEvent[]) => ({ label, focus, events }) as InspectionWindow;
const black = (start: number, end: number): CutEvent => ({ kind: "black", start, end });
const level = (at: number, deltaDb: number): CutEvent => ({ kind: deltaDb > 0 ? "level-rise" : "level-drop", start: at, end: at, deltaDb });

it("counts what the edit added, not what the footage already had in the same place", () => {
  // The edit moved the moment at 10 s to 4 s, so what was at 10.5 s is now at 4.5 s.
  const before = [window("Before", 10, [black(10.5, 11)])];
  expect(newCutEvents(before, window("After", 4, [black(4.5, 5)]), fps)).toEqual([]);
  // Black where the original had none is new, whole.
  expect(newCutEvents(before, window("After", 4, [black(3, 3.4)]), fps)).toEqual([black(3, 3.4)]);
  // Black that starts earlier than the original's is new up to a frame before where the original's began.
  expect(newCutEvents(before, window("After", 4, [black(4, 5)]), fps)).toEqual([{ kind: "black", start: 4, end: expect.closeTo(4.46) }]);
  // What is left over when the original accounts for the middle is new on both sides.
  expect(newCutEvents(before, window("After", 4, [black(4, 5.5)]), fps)).toEqual([
    { kind: "black", start: 4, end: expect.closeTo(4.46) }, { kind: "black", start: expect.closeTo(5.04), end: 5.5 },
  ]);
  // A sliver shorter than a frame is not a new event.
  expect(newCutEvents(before, window("After", 4, [black(4.44, 5)]), fps)).toEqual([]);
  // A different kind of event in the same place explains nothing.
  expect(newCutEvents([window("Before", 10, [{ kind: "freeze", start: 10.5, end: 11 }])], window("After", 4, [black(4.5, 5)]), fps)).toEqual([black(4.5, 5)]);
});

it("explains each side of a removal only by the footage kept on that side", () => {
  // 10–13 s was taken out, and the join is at 10 s. The outgoing side keeps what came before 10, the incoming what came after 13.
  const outgoing = (events: CutEvent[]) => window("Before outgoing", 10, events), incoming = (events: CutEvent[]) => window("Before incoming", 13, events);
  const after = (events: CutEvent[]) => window("After", 10, events);
  // Black that ran up to the cut and black that ran on from it meet at the join: both were there before.
  expect(newCutEvents([outgoing([black(9.5, 10.5)]), incoming([black(12.5, 13.5)])], after([black(9.5, 10.5)]), fps)).toEqual([]);
  // Black that was wholly inside the removed passage is gone with it, so black at the join is the edit's doing.
  expect(newCutEvents([outgoing([black(10.2, 10.8)]), incoming([black(12.2, 12.8)])], after([black(10.1, 10.6)]), fps)).toEqual([black(10.1, 10.6)]);
  // Only the kept part of an original event counts: the outgoing black explains up to the join and no further.
  expect(newCutEvents([outgoing([black(9.5, 10.5)]), incoming([])], after([black(9.5, 10.5)]), fps)).toEqual([{ kind: "black", start: expect.closeTo(10.04), end: 10.5 }]);
});

it("counts a step in level as new when it is clearly larger than the one that was there", () => {
  const before = [window("Before", 10, [level(10.05, -4)])];
  // Within a tenth of a second and no more than 6 dB larger: the same step.
  expect(newCutEvents(before, window("After", 10, [level(10, -9)]), fps)).toEqual([]);
  expect(newCutEvents(before, window("After", 10, [level(10, -14)]), fps)).toEqual([level(10, -14)]);
  // Too far from the original step to be it.
  expect(newCutEvents(before, window("After", 10, [level(10.4, -5)]), fps)).toEqual([level(10.4, -5)]);
  // A rise is not a drop.
  expect(newCutEvents(before, window("After", 10, [level(10, 5)]), fps)).toEqual([level(10, 5)]);
});

it("finds nothing new in a window with no events", () => {
  expect(newCutEvents([window("Before", 10, [black(10, 11)])], window("After", 4), fps)).toEqual([]);
  expect(newCutEvents([window("Before", 10)], window("After", 4, [black(4, 5)]), fps)).toEqual([black(4, 5)]);
  expect(newCutEvents([], window("After", 4, [level(4, -8)]), fps)).toEqual([level(4, -8)]);
});
