import { expect, it } from "vitest";
import type { Change } from "@scarlet/timeline";
import { queueOrder, queueWait } from "./threads.js";
import type { Task } from "./api.js";

const task = (id: string, state: Task["state"], minute: number, context: Partial<Task["context"]> = {}): Task => ({
  id, projectId: "p", kind: "edit", agent: "codex", instruction: id, state, changeIds: [], question: null,
  createdBy: { type: "human", name: "Editor" }, createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  context: { threadId: id, branch: "main", ...context },
} as Task);
const review = { id: "chg_pass", projectId: "p", state: "ready", intent: "suggestion", taskId: "pass", threadId: "pass",
  cutReasons: [{ start: 1, end: 2, reason: "retake" }] } as Change;

it("explains the engine's one-request-at-a-time order", () => {
  const pass = task("pass", "running", 0);
  const zoom = task("zoom", "queued", 1);
  const captions = task("captions", "queued", 2);
  expect(queueWait(zoom, [pass, zoom, captions], [])).toEqual({ kind: "run", task: pass });
  const done = { ...pass, state: "done" as const };
  expect(queueWait(captions, [done, zoom, captions], [])).toEqual({ kind: "ahead", count: 1 });
  expect(queueWait(zoom, [done, zoom, captions], [])).toBeUndefined();
  // A pass whose staged cuts need the editor holds requests about other things, not replies to it.
  expect(queueWait(zoom, [done, zoom], [review])).toEqual({ kind: "review", change: review });
  // One the editor started anyway isn't held by the calls. It still takes its turn, and the next request is held as before.
  const started = { ...zoom, startsBeforeCalls: true };
  expect(queueWait(started, [done, started, captions], [review])).toBeUndefined();
  expect(queueWait(captions, [done, started, captions], [review])).toEqual({ kind: "ahead", count: 1 });
  expect(queueWait(captions, [done, { ...started, state: "done" as const }, captions], [review])).toEqual({ kind: "review", change: review });
  expect(queueWait(started, [pass, started], [review])).toEqual({ kind: "run", task: pass });
  expect(queueOrder([done, captions, started], [review]).map(t => t.id)).toEqual(["zoom", "captions"]);
  const reply = task("reply", "queued", 3, { threadId: "pass" });
  expect(queueWait(reply, [done, zoom, reply], [review])).toBeUndefined();
  // A pass on another branch doesn't hold this one.
  expect(queueWait(task("other", "queued", 4, { branch: "alt" }), [done], [review])).toBeUndefined();
  expect(queueWait(task("asked", "queued", 5), [{ ...pass, state: "waiting_for_user" as const }], [])?.kind).toBe("question");
});

it("keeps a resumed run's place in line ahead of requests asked while it worked", () => {
  const interrupted = { ...task("pass", "failed", 0), interrupted: true, retryTaskId: "again" } as Task;
  const revision = task("revision", "queued", 1, { threadId: "pass", changeId: "chg_pass", cutIndex: 0 });
  const again = { ...task("again", "queued", 2, { threadId: "pass" }), resumeRootId: "pass" } as Task;
  const all = [interrupted, revision, again];
  expect(queueWait(again, all, [review])).toBeUndefined();
  expect(queueWait(revision, all, [review])).toEqual({ kind: "ahead", count: 1 });
});

it("keeps a resumed run ahead of a request asked in the same millisecond as the run it continues", () => {
  const interrupted = { ...task("pass", "failed", 0), interrupted: true, retryTaskId: "again" } as Task;
  const follow = task("follow", "queued", 0, { threadId: "pass" });
  const again = { ...task("again", "queued", 2, { threadId: "pass" }), resumeRootId: "pass" } as Task;
  expect(follow.createdAt).toBe(interrupted.createdAt);
  const all = [interrupted, follow, again];
  expect(queueWait(again, all, [])).toBeUndefined();
  expect(queueWait(follow, all, [])).toEqual({ kind: "ahead", count: 1 });
});

it("stops holding the queue for a pass version that a finished revision replaced", () => {
  const pass = task("pass", "done", 0);
  const replaced = { ...review, state: "revising" } as Change;
  const zoom = task("zoom", "queued", 1);
  // While the revision waits its turn, the pass is still the editor's to decide, and the revision goes first.
  const revision = task("revision", "queued", 2, { threadId: "pass", changeId: "chg_pass", cutIndex: 0 });
  expect(queueWait(zoom, [pass, zoom, revision], [replaced])).toEqual({ kind: "review", change: replaced });
  expect(queueWait(revision, [pass, zoom, revision], [replaced])).toBeUndefined();
  // The revision ran and the editor applied its new version. The old version is still marked revising.
  const applied = { ...review, id: "chg_pass_v2", state: "approved", taskId: "revision" } as Change;
  expect(queueWait(zoom, [pass, zoom, { ...revision, state: "done" as const }], [replaced, applied])).toBeUndefined();
  // Until they do, the new version holds the queue.
  const waiting = { ...applied, state: "ready" } as Change;
  expect(queueWait(zoom, [pass, zoom, { ...revision, state: "done" as const }], [replaced, waiting])).toEqual({ kind: "review", change: waiting });
});

it("says the editor's calls hold a request while Scarlet revises one of them, and lists the queue in the order it will run", () => {
  const pass = task("pass", "done", 0);
  // One call of the pass was sent back and Scarlet is on it: the pass still waits on the editor.
  const revising = { ...review, state: "revising" } as Change;
  const revision = task("revision", "running", 1, { threadId: "pass", changeId: "chg_pass", cutIndex: 0 });
  // Asked next: a new edit, then a note on another call of the pass.
  const lower = task("lower", "queued", 2);
  const note = task("note", "queued", 3, { threadId: "pass", changeId: "chg_pass", cutIndex: 1 });
  const all = [pass, revision, lower, note];
  // The new edit doesn't start when the revision ends: it waits for the calls. The note waits only for the run.
  expect(queueWait(lower, all, [revising])).toEqual({ kind: "review", change: revising });
  expect(queueWait(note, all, [revising])).toEqual({ kind: "run", task: revision });
  // So the note runs first, though it was asked second.
  expect(queueOrder(all, [revising]).map(t => t.id)).toEqual(["note", "lower"]);
  // The same order once the revision has finished and its new version waits.
  const waiting = { ...review, id: "chg_pass_v2", taskId: "revision" } as Change;
  const done = [pass, { ...revision, state: "done" as const }, lower, note];
  expect(queueOrder(done, [revising, waiting]).map(t => t.id)).toEqual(["note", "lower"]);
  expect(queueWait(note, done, [revising, waiting])).toBeUndefined();
  expect(queueWait(lower, done, [revising, waiting])?.kind).toBe("review");
  // Once the note has run too and the calls are made, nothing holds the new edit.
  const applied = { ...waiting, state: "approved" } as Change;
  const after = [pass, { ...revision, state: "done" as const }, lower, { ...note, state: "done" as const }];
  expect(queueWait(lower, after, [revising, applied])).toBeUndefined();
  expect(queueOrder(after, [revising, applied]).map(t => t.id)).toEqual(["lower"]);
});

it("goes on saying the editor's calls hold a request once a note on one call has saved the pass again", () => {
  const pass = task("pass", "done", 0);
  // A note on one call waited its turn as a request of its own, and Scarlet is on it. Asked since: a new edit, then a
  // note on another call.
  const note = task("note", "running", 1, { threadId: "pass", changeId: "chg_pass", cutIndex: 0 });
  const lower = task("lower", "queued", 2);
  const second = task("second", "queued", 3, { threadId: "pass", changeId: "chg_pass", cutIndex: 1 });
  const all = [pass, note, lower, second];
  expect(queueWait(lower, all, [review])).toEqual({ kind: "review", change: review });
  // The note saves its cut: the engine marks the pass it revised as replaced by the one the note's run made. That
  // pass waits on the editor as the first did, so nothing changes for the queue until the note's run ends
  // (2026-11-09: the new edit read as next, behind the run, and went ahead of the second note).
  const replaced = { ...review, state: "rejected", replacedBy: "chg_pass_v2" } as Change;
  const revised = { ...review, id: "chg_pass_v2", taskId: "note" } as Change;
  expect(queueWait(lower, all, [replaced, revised])).toEqual({ kind: "review", change: revised });
  expect(queueWait(second, all, [replaced, revised])).toEqual({ kind: "run", task: note });
  expect(queueOrder(all, [replaced, revised]).map(t => t.id)).toEqual(["second", "lower"]);
  // The same when the note's run saves its cut a second time, in place of its own first attempt.
  const first = { ...revised, state: "rejected", replacedBy: "chg_pass_v3" } as Change;
  const again = { ...review, id: "chg_pass_v3", taskId: "note" } as Change;
  expect(queueWait(lower, all, [replaced, first, again])).toEqual({ kind: "review", change: again });
  expect(queueOrder(all, [replaced, first, again]).map(t => t.id)).toEqual(["second", "lower"]);
});

it("holds nothing for a pass that is still being made: what is queued behind it waits for the run, in the order asked", () => {
  const pass = task("pass", "running", 0);
  const zoom = task("zoom", "queued", 1);
  const note = task("note", "queued", 2, { threadId: "pass", changeId: "chg_pass", cutIndex: 0 });
  // The pass has staged cuts and hasn't finished: it has asked for no calls yet.
  expect(queueWait(zoom, [pass, zoom, note], [review])).toEqual({ kind: "run", task: pass });
  expect(queueOrder([pass, zoom, note], [review]).map(t => t.id)).toEqual(["zoom", "note"]);
  // The same once it has saved its next part, which takes the place of the part before it.
  const part = { ...review, state: "rejected", replacedBy: "chg_pass_2" } as Change;
  const whole = { ...review, id: "chg_pass_2" } as Change;
  expect(queueWait(zoom, [pass, zoom, note], [part, whole])).toEqual({ kind: "run", task: pass });
  expect(queueOrder([pass, zoom, note], [part, whole]).map(t => t.id)).toEqual(["zoom", "note"]);
  // A resumed run keeps the place of the run it continues.
  const interrupted = { ...task("pass", "failed", 0), interrupted: true, retryTaskId: "again" } as Task;
  const again = { ...task("again", "queued", 3, { threadId: "pass" }), resumeRootId: "pass" } as Task;
  expect(queueOrder([interrupted, zoom, again], []).map(t => t.id)).toEqual(["again", "zoom"]);
});
