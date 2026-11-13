// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { timelineFromKeepRanges, type Change, type TimeRange } from "@scarlet/timeline";
import type { ThreadEdit } from "@scarlet/shared";
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
    ...(covered ? [["after", [8, 9.5]]] : []), ["before", [8, 12, 10]],
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
