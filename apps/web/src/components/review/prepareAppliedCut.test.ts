// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { timelineFromKeepRanges, type Change, type TimeRange } from "@scarlet/timeline";
import type { ThreadEdit } from "@scarlet/shared";
import { appliedCutClock } from "../../lib/appliedCutPlayback";
import { cutAudition } from "../../lib/cutAudition";
import { api } from "../../lib/client";
import { editToPrepare, prepareCut } from "./usePrepareNextCut";

const project = "project";
const timeline = (version: string, kept: TimeRange[]) => ({ ...timelineFromKeepRanges(project, "camera", kept), version });
const before = timeline("before", [{ start: 0, end: 30 }]);
const removed = { start: 10, end: 12 };
const neighbor = { start: 8.5, end: 9 };
const edit = (spot: number, range: TimeRange, version = before.version): ThreadEdit => ({ changeId: "change", spot,
  label: "Take", range, beforeCut: { version, removed: range }, previous: [], check: "Check the join." });

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("prepares the edited version only when it includes the neighboring removal (covered: %s)", async covered => {
  const after = timeline("after", [...(covered ? [{ start: 0, end: neighbor.start }, { start: neighbor.end, end: removed.start }]
    : [{ start: 0, end: removed.start }]), { start: removed.end, end: 30 }]);
  const change: Change = { id: "change", projectId: project, author: { name: "Scarlet", type: "scarlet" }, description: "Cut a take.",
    state: "approved", noteIds: [], ranges: [], renders: [], fromVersion: before.version, toVersion: after.version,
    ops: (covered ? [removed, neighbor] : [removed]).map(r => ({ op: "rippleDelete", ...r })) };
  const selected = edit(0, removed);
  const otherEdits = [selected, edit(1, neighbor), edit(2, { start: 12.5, end: 13 }, "different-version"),
    edit(3, { start: 22, end: 23 })];
  const target = editToPrepare(selected, change, otherEdits)!;
  expect(target.nearby).toEqual([neighbor]);
  vi.spyOn(api, "timeline").mockImplementation(async (_project, version) => ({ timeline: version === before.version ? before : after }));
  const prepare = vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
  await prepareCut(project, 30, target, new AbortController().signal);
  expect(prepare.mock.calls.map(([, version, times]) => [version, times])).toEqual([
    ...(covered ? [["after", [8, 9.5, 12.5 - 1 / 30]]] : []), ["before", [8, 12, 10]],
  ]);
});

it("prepares the same neighboring cuts that will be heard in the extended tail", () => {
  const selected = edit(0, removed);
  const first = { start: 13, end: 19 };
  const second = { start: 20, end: 22 };
  const later = { start: 24, end: 25 };
  const target = editToPrepare(selected, undefined, [selected, edit(1, first), edit(2, second), edit(3, later)]);
  expect(target?.nearby).toEqual([first, second]);
});

it("prepares just the playable positions at an unaligned final frame", async () => {
  const prepare = vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
  const signal = new AbortController().signal;
  const original = timeline("before", [{ start: 0, end: 10.01 }]);
  const cut = { start: 9, end: 10.005 };
  const edited = timeline("after", [{ start: 0, end: cut.start }, { start: cut.end, end: 10.01 }]);
  await prepareCut(project, 30, { cut, before: original, after: { version: edited, removed: [cut] } }, signal);
  expect(prepare.mock.calls).toEqual([[project, edited.version, [7], signal], [project, original.version, [7, 9], signal]]);

  prepare.mockClear();
  const short = timeline("subframe", [{ start: 0, end: 0.01 }]);
  await prepareCut(project, 30, { cut: { start: 0.001, end: 0.009 }, before: short }, signal);
  expect(prepare).not.toHaveBeenCalled();
});

it("prepares a rebased applied cut on its saved version, including the changed placement before the listen", async () => {
  // The version the editor approved removed 2 seconds at the start while the pass waited,
  // then removed this cut. The pass's original proposal removed another call the editor skipped.
  const after = timeline("applied", [{ start: 2, end: removed.start }, { start: removed.end, end: 30 }]);
  const change: Change = { id: "change", projectId: project, author: { name: "Scarlet", type: "scarlet" }, description: "Take",
    state: "approved", noteIds: [], ranges: [], renders: [], fromVersion: before.version, toVersion: "staged", appliedOnto: "trimmed",
    appliedVersion: after.version, restoredCuts: [1], ops: [{ op: "rippleDelete", start: 21, end: 22 }, { op: "rippleDelete", ...removed }] };
  const selected = edit(0, removed);
  const target = editToPrepare(selected, change, [selected])!;
  const read = vi.spyOn(api, "timeline").mockImplementation(async (_project, version) => ({ timeline: version === before.version ? before : after }));
  const warm = vi.spyOn(api, "preparePlayback").mockResolvedValue(undefined);
  await prepareCut(project, 30, target, new AbortController().signal);
  expect(read.mock.calls.map(([, version]) => version)).toEqual([before.version, after.version]);
  expect(warm.mock.calls.map(([, version, times]) => [version, times])).toEqual([
    [after.version, [6, 8, 11 - 1 / 30]], [before.version, [8, 12, 10]],
  ]);
});

it("rejects a saved version that takes extra footage or leaves in a neighboring removal inside the listen", () => {
  const wanted = cutAudition(removed, "after", 30);
  const extra = timeline("extra", [{ start: 0, end: 8.5 }, { start: 9, end: 10 }, { start: 12, end: 30 }]);
  expect(appliedCutClock(before, extra, undefined, 30, removed, wanted)).toBeUndefined();
  const onlyThis = timeline("one", [{ start: 0, end: 10 }, { start: 12, end: 30 }]);
  const both = cutAudition(removed, "after", 30, { others: [{ start: 8.5, end: 9 }] });
  expect(appliedCutClock(before, onlyThis, undefined, 30, removed, both)).toBeUndefined();
  expect(appliedCutClock(before, extra, undefined, 30, removed, both)?.toMedia(13)).toBe(10.5);
});

it("rejects an equal-duration replacement inside the lead-in even when both ends and the selected join match", () => {
  const edited = timeline("replacement", [{ start: 0, end: 8.5 }, { start: 40, end: 41 }, { start: 9.5, end: 10 }, { start: 12, end: 30 }]);
  expect(appliedCutClock(before, edited, undefined, 30, removed, cutAudition(removed, "after", 30))).toBeUndefined();
});

it("restores the right source clock at a saved cut on the very first or last frame", () => {
  for (const [cut, after, join] of [
    [{ start: 0, end: 2 }, timeline("trim-start", [{ start: 2, end: 30 }]), 0],
    [{ start: 28, end: 30 }, timeline("trim-end", [{ start: 0, end: 28 }]), 28],
  ] as const) {
    const clock = appliedCutClock(before, after, undefined, 30, cut, cutAudition(cut, "after", 30));
    expect(clock?.toMedia((cut.start + cut.end) / 2)).toBe(join);
    expect(clock?.toView(join)).toBe(cut.end);
  }
});
