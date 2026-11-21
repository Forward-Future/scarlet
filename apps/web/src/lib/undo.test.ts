// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { api } from "./client";
import { lastStep, recordUndo, undoLast, undoWords, useUndoStore } from "./undo";

beforeEach(() => {
  vi.spyOn(api, "cancelTask").mockImplementation(async id => ({ task: { id } as Task }));
  vi.spyOn(api, "rejectChange").mockImplementation(async id => ({ change: { id } as Change }));
  vi.spyOn(api, "reopenChange").mockImplementation(async id => ({ change: { id } as Change }));
  vi.spyOn(api, "unkeepEdits").mockResolvedValue(undefined);
});
afterEach(() => {
  useUndoStore.setState({ steps: [], undoing: undefined, error: undefined });
  vi.restoreAllMocks();
  localStorage.clear();
});

const task = (id: string, state: Task["state"], context: Task["context"] = {}, more: Partial<Task> = {}) =>
  ({ id, state, context, ...more }) as Task;
const change = (id: string, state: Change["state"], more: Partial<Change> = {}) =>
  ({ id, state, toVersion: `ver_${id}`, createdAt: "2026-11-18T10:00:00Z", ...more }) as Change;
const noRevert = () => { throw new Error("Nothing should be reverted."); };

it("takes back the newest step first, one per press, and only in its own project", async () => {
  recordUndo({ kind: "revision", projectId: "prj", taskId: "task_a" });
  recordUndo({ kind: "revision", projectId: "other", taskId: "task_x" });
  recordUndo({ kind: "keep", word: "Keep", projectId: "prj", threadId: "thr", refs: [{ changeId: "chg", spot: 1 }], edit: { changeId: "chg", spot: 1 }, name: "Cut at 0:09" });
  const steps = () => useUndoStore.getState().steps;
  expect(undoWords(lastStep(steps(), "prj")!).label).toBe("Undo Keep");
  expect(await undoLast("prj", { changes: [], tasks: [] }, noRevert)).toMatchObject({ kind: "keep" });
  expect(api.unkeepEdits).toHaveBeenCalledWith("prj", { threadId: "thr", edits: [{ changeId: "chg", spot: 1 }] });
  expect(undoWords(lastStep(steps(), "prj")!)).toMatchObject({ label: "Undo revision" });
  expect(await undoLast("prj", { changes: [], tasks: [task("task_a", "queued")] }, noRevert)).toMatchObject({ taskId: "task_a" });
  expect(api.cancelTask).toHaveBeenCalledWith("task_a", false, true);
  expect(lastStep(steps(), "prj")).toBeUndefined();
  expect(lastStep(steps(), "other")).toMatchObject({ taskId: "task_x" });
});

it("stops a revision under way, and takes out what it already put in the video, newest first", async () => {
  recordUndo({ kind: "revision", projectId: "prj", taskId: "task_r" });
  const revert = vi.fn(async () => {});
  const changes = [change("first", "approved", { taskId: "task_r", appliedVersion: "ver_1" }),
    change("second", "approved", { taskId: "task_r2", appliedVersion: "ver_2", createdAt: "2026-11-18T10:05:00Z" }),
    change("edit", "approved", { taskId: "task_other" })];
  // It was picked up again as a second attempt, which is still running.
  const tasks = [task("task_r", "failed", { changeId: "edit" }, { retryTaskId: "task_r2" }), task("task_r2", "running", { changeId: "edit" })];
  await undoLast("prj", { changes, tasks }, revert);
  expect(api.cancelTask).toHaveBeenCalledWith("task_r2", false, true);
  expect(revert.mock.calls).toEqual([["ver_2"], ["ver_1"]]);
});

it("puts away the new version a call's revision made, and the pass it replaced waits for the editor again", async () => {
  recordUndo({ kind: "revision", projectId: "prj", taskId: "task_call" });
  const changes = [change("pass", "rejected", { replacedBy: "pass_v2" }), change("pass_v2", "ready", { taskId: "task_call" })];
  await undoLast("prj", { changes, tasks: [task("task_call", "done", { changeId: "pass", cutIndex: 3 })] }, noRevert);
  expect(api.cancelTask).not.toHaveBeenCalled();
  expect(api.rejectChange).toHaveBeenCalledWith("pass_v2", "Taken back with Undo.");
  expect(api.reopenChange).toHaveBeenCalledWith("pass");
});

it("says why a revision can't be taken back once the pass it made went in, and moves on to the step before", async () => {
  recordUndo({ kind: "keep", word: "Keep", projectId: "prj", threadId: "thr", refs: [{ changeId: "chg", spot: 0 }], edit: { changeId: "chg", spot: 0 } });
  recordUndo({ kind: "revision", projectId: "prj", taskId: "task_call" });
  const changes = [change("pass", "rejected", { replacedBy: "pass_v2" }), change("pass_v2", "approved", { taskId: "task_call" })];
  expect(await undoLast("prj", { changes, tasks: [task("task_call", "done", { changeId: "pass", cutIndex: 3 })] }, noRevert)).toBeUndefined();
  expect(useUndoStore.getState().error).toEqual({ projectId: "prj", text: "Couldn’t undo the revision: the version it made has been applied since." });
  expect(api.rejectChange).not.toHaveBeenCalled();
  expect(lastStep(useUndoStore.getState().steps, "prj")).toMatchObject({ kind: "keep" });
  // The next press takes back the Keep, and the reason goes.
  await undoLast("prj", { changes, tasks: [] }, noRevert);
  expect(useUndoStore.getState().error).toBeUndefined();
});
