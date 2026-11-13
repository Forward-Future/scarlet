import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildThreads, threadRevision } from "@scarlet/shared";
import { MockClient } from "./MockClient";
import { PRJ } from "./fixtures";

let api: MockClient;
beforeEach(() => {
  vi.useFakeTimers();
  api = new MockClient(() => "mock");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function finish<T>(request: Promise<T>, ms = 350) {
  await vi.advanceTimersByTimeAsync(ms);
  return request;
}

it("previews a pending demo cut on the named working edit after an unrelated overlay was added", async () => {
  await finish(api.checkout(PRJ, "ver_5"));
  const restored = [0, 1, 3, 4, 5];
  await expect(api.cutReviewDraft("chg_fillers", restored, "ver_3")).rejects.toMatchObject({ code: "cut_review_stale" });
  const preview = await api.cutReviewDraft("chg_fillers", restored, "ver_5");
  expect(preview).toMatchObject({ ontoVersion: "ver_5", removed: [{ start: 6.4, end: 6.8 }] });
  expect(preview.draft?.tracks.find(t => t.id === "v2")?.clips[0]?.id).toBe("clip_logo");
  expect((await api.cutReviewDraft("chg_fillers", restored, "ver_5")).draft?.version).toBe(preview.draft?.version);
  expect((await finish(api.timeline(PRJ))).timeline.version).toBe("ver_5");
});

it("returns a stopped, unreplaced demo revision to preview, apply and done", async () => {
  const { task } = await finish(api.reviseChange("chg_ready", { text: "Try a longer pause" }));
  await finish(api.cancelTask(task!.id));
  const [{ changes }, { tasks }, { notes }] = await finish(Promise.all([api.changes(PRJ), api.tasks(PRJ), api.notes(PRJ)]));
  const thread = buildThreads({ changes, tasks, notes }).find(t => t.tasks.some(t => t.id === task!.id))!;
  expect(thread).toMatchObject({ needs: "decision", latest: { id: "chg_ready", state: "ready" } });
  const { change } = await finish(api.change("chg_ready"));
  expect(change.renders[0]!.after).toBeTruthy();
  expect(change.revisionFrom).toBeUndefined();
  const filed = await api.setThreadDone(PRJ, thread.id, true, threadRevision(thread));
  expect(filed.completedThreads[thread.id]).toBe(threadRevision(thread));
  expect((await finish(api.approveChange(change.id))).outcome).toBe("applied");
});

it("waits for sibling revisions and preserves a failed proposal and its error", async () => {
  const original = await finish(api.change("chg_failed"));
  const error = original.change.error;
  const [one, two] = await finish(Promise.all([
    api.reviseChange("chg_failed", { text: "Retry one" }), api.reviseChange("chg_failed", { text: "Retry two" }),
  ]));
  await finish(api.cancelTask(one.task!.id));
  expect((await finish(api.change("chg_failed"))).change.state).toBe("revising");
  await finish(api.cancelTask(two.task!.id));
  expect((await finish(api.change("chg_failed"))).change).toMatchObject({ state: "failed", error });
});

it("preserves an explicit rejection during cancellation and can reopen the original proposal", async () => {
  const { task } = await finish(api.reviseChange("chg_ready", { text: "Try a different cut" }));
  await finish(api.rejectChange("chg_ready", "Keep the original"));
  await finish(api.cancelTask(task!.id));
  expect((await finish(api.change("chg_ready"))).change.state).toBe("rejected");
  expect((await api.reopenChange("chg_ready")).change.state).toBe("ready");
});

it("keeps the words the app sends for the editor apart from what it asks of Scarlet, as the engine does", async () => {
  const [{ changes }, { tasks }, { notes }] = await finish(Promise.all([api.changes(PRJ), api.tasks(PRJ), api.notes(PRJ)]));
  const threadId = buildThreads({ changes, tasks, notes }).find(t => t.changes.some(c => c.id === "chg_approved_2"))!.id;
  // Undo edit, pressed on an edit's card: the request reads "Undo", and the instruction says which edit to put back.
  const undo = await finish(api.createTask(PRJ, { kind: "edit", agent: "claude", context: { threadId, changeId: "chg_approved_2", editIndex: 1, message: "Undo" },
    instruction: "Undo edit 2, “captions”. Put back exactly what this edit changed and leave every other edit as it is." }));
  expect([undo.task.context.message, undo.task.instruction.slice(0, 12)]).toEqual(["Undo", "Undo edit 2,"]);
  // A request in the editor's own words is what they said.
  const typed = await finish(api.createTask(PRJ, { kind: "edit", agent: "claude", instruction: "Make the captions bigger.", context: { threadId } }));
  expect(typed.task.context.message).toBe("Make the captions bigger.");
});
