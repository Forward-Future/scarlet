import { expect, it } from "vitest";
import type { Change } from "@scarlet/timeline";
import { queueOrder, queueWait, queueWaits, requestTargetKey } from "./threads.js";
import type { Task } from "./tasks.js";

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

it("puts edits interrupted by the project's Stop ahead of ordinary queued work", () => {
  const waiting = task("waiting", "queued", 0);
  const first = task("first", "cancelled", 1);
  const second = task("second", "cancelled", 2);
  const resumeFirst = { ...task("resume-first", "queued", 4), resumeRootId: first.id, resumesAfterProjectStop: true };
  const resumeSecond = { ...task("resume-second", "queued", 3), resumeRootId: second.id, resumesAfterProjectStop: true };
  const all = [waiting, first, second, resumeSecond, resumeFirst];
  expect(queueOrder(all, []).map(t => t.id)).toEqual([resumeFirst.id, resumeSecond.id, waiting.id]);
  expect(queueWait(waiting, all, [])).toEqual({ kind: "ahead", count: 2 });
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

it("follows insertion order when a project snapshot lists same-millisecond requests in reverse", () => {
  const root = { ...task("root", "failed", 0), queueSequence: 40 };
  const first = { ...task("first", "queued", 0), queueSequence: 41 };
  const second = { ...task("second", "queued", 0), queueSequence: 42 };
  const resumed = { ...task("resumed", "queued", 2), resumeRootId: root.id, queueSequence: 43 };
  const snapshot = [resumed, second, first, root];

  expect(queueOrder(snapshot, []).map(t => t.id)).toEqual([resumed.id, first.id, second.id]);
  expect(queueWait(resumed, snapshot, [])).toBeUndefined();
  expect(queueWait(second, snapshot, [])).toEqual({ kind: "ahead", count: 2 });
});

it("never ranks a request without an engine number by its place in the list", () => {
  // The window lists a project's requests newest first. One the engine didn't number (as the demo's are) used to be
  // ranked by its index in that list, a smaller figure than any row number, and so went ahead of requests asked before it.
  const numbered = { ...task("numbered", "queued", 0), queueSequence: 40 };
  const unnumbered = task("unnumbered", "queued", 0);
  const later = task("later", "queued", 1);
  expect(queueOrder([later, unnumbered, numbered], []).map(t => t.id)).toEqual(["numbered", "unnumbered", "later"]);
  expect(queueWait(unnumbered, [later, unnumbered, numbered], [])).toEqual({ kind: "ahead", count: 1 });
  // Requests from different times keep their times, whatever order the list is in.
  const first = task("first", "queued", 0), second = task("second", "queued", 1), third = task("third", "queued", 2);
  expect(queueOrder([third, second, first], []).map(t => t.id)).toEqual(["first", "second", "third"]);
  expect(queueWait(first, [third, second, first], [])).toBeUndefined();
  expect(queueWait(third, [third, second, first], [])).toEqual({ kind: "ahead", count: 2 });
});

it("answers why each queued request waits from one reading of the snapshot", () => {
  const pass = task("pass", "running", 0);
  const zoom = task("zoom", "queued", 1);
  const captions = task("captions", "queued", 2);
  const fix = task("fix", "queued", 3, { threadId: "t", changeId: "A", editIndex: 0 });
  const all = [pass, zoom, captions, fix];
  const wait = queueWaits(all, []);
  for (const t of all) expect(wait(t)).toEqual(queueWait(t, all, []));
  expect(wait(pass)).toBeUndefined();
  expect(wait(captions)).toEqual({ kind: "run", task: pass });
  // A revision of an applied edit starts beside the pass, ahead of the whole-video requests asked before it.
  expect(wait(fix)).toBeUndefined();
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
  // The new edit doesn't start when the revision ends: it waits for the calls. The note is about another call, so
  // it waits for nothing: Scarlet works on both at once.
  expect(queueWait(lower, all, [revising])).toEqual({ kind: "review", change: revising });
  expect(queueWait(note, all, [revising])).toBeUndefined();
  // A second note on the call being revised waits for that run.
  const same = task("same", "queued", 4, { threadId: "pass", changeId: "chg_pass", cutIndex: 0 });
  expect(queueWait(same, [...all, same], [revising])).toEqual({ kind: "run", task: revision });
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
  // The second note is about another call, so it starts beside the first.
  expect(queueWait(second, all, [replaced, revised])).toBeUndefined();
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

it("lets requests about different cuts or edits run at once, and keeps every other request in turn", () => {
  const pass = task("pass", "done", 0);
  const call = (id: string, state: Task["state"], minute: number, cutIndex: number) => task(id, state, minute, { threadId: "pass", changeId: "chg_pass", cutIndex });
  const first = call("first", "running", 1, 2);
  const second = call("second", "queued", 2, 5);
  // A revision of another call doesn't wait for the one Scarlet is on, or for one ahead of it in line.
  expect(queueWait(second, [pass, first, second], [review])).toBeUndefined();
  expect(queueWait(second, [pass, { ...first, state: "queued" }, second], [review])).toBeUndefined();
  expect(queueOrder([pass, { ...first, state: "queued" }, second], [review]).map(t => t.id)).toEqual(["first", "second"]);
  // Nor for that one's question, which is about its own cut.
  expect(queueWait(second, [pass, { ...first, state: "waiting_for_user" }, second], [review])).toBeUndefined();
  // A second request about the same call keeps the order it was asked in.
  const again = call("again", "queued", 3, 2);
  expect(queueWait(again, [pass, first, again], [review])).toEqual({ kind: "run", task: first });
  expect(queueWait(again, [pass, { ...first, state: "queued" }, again], [review])).toEqual({ kind: "ahead", count: 1 });
  expect(queueWait(again, [pass, { ...first, state: "waiting_for_user" }, again], [review])).toEqual({ kind: "question", task: { ...first, state: "waiting_for_user" } });
  // An applied edit's revision works beside another edit's, in the same thread or another.
  const zoomFix = task("zoomFix", "queued", 4, { threadId: "zoom", changeId: "chg_zoom", editIndex: 0 });
  const titleFix = task("titleFix", "running", 3, { threadId: "zoom", changeId: "chg_zoom", editIndex: 1 });
  expect(queueWait(zoomFix, [titleFix, zoomFix], [])).toBeUndefined();
  // A request about the whole video works beside an applied edit's revision, either way round: the revision lands on
  // the video through the footage, and a save that meets what the other changed is told so and made again.
  const captions = task("captions", "queued", 5);
  expect(queueWait(captions, [titleFix, captions], [])).toBeUndefined();
  const later = task("later", "queued", 6, { threadId: "zoom", changeId: "chg_zoom", editIndex: 2 });
  expect(queueWait(later, [titleFix, captions, later], [])).toBeUndefined();
  expect(queueWait(later, [{ ...captions, state: "running" }, later], [])).toBeUndefined();
  // Two requests about the whole video still take turns.
  const music = task("music", "queued", 7);
  expect(queueWait(music, [{ ...captions, state: "running" }, music], [])).toEqual({ kind: "run", task: { ...captions, state: "running" } });
  expect(queueWait(music, [titleFix, captions, music], [])).toEqual({ kind: "ahead", count: 1 });
  // A pass's calls don't hold a revision of an applied edit: the pass's cuts carry onto the video it leaves.
  expect(queueWait(zoomFix, [pass, first, zoomFix], [review])).toBeUndefined();
});

it("revises an edit the pass already applied while the pass goes on, and keeps its calls for after", () => {
  // 2026-11-22: a pass had applied its cut at 2:38 and was still working when the editor asked to extend that cut. The
  // revision waited 30 minutes in the tray for the pass to finish.
  const pass = task("pass", "running", 0);
  const extend = task("extend", "queued", 30, { threadId: "pass", changeId: "chg_applied", editIndex: 7 });
  const zoom = task("zoom", "queued", 31);
  const call = task("call", "queued", 32, { threadId: "pass", changeId: "chg_pass", cutIndex: 1 });
  const all = [pass, extend, zoom, call];
  expect(queueWait(extend, all, [review])).toBeUndefined();
  // A new request about the whole video and a call of the pass being made still wait for the pass.
  expect(queueWait(zoom, all, [review])).toEqual({ kind: "run", task: pass });
  expect(queueWait(call, all, [review])).toEqual({ kind: "run", task: pass });
  expect(queueOrder(all, [review]).map(t => t.id)).toEqual(["extend", "zoom", "call"]);
  // So does a second request about the same edit, behind the first.
  const again = task("again", "queued", 33, { threadId: "pass", changeId: "chg_applied", editIndex: 7 });
  expect(queueWait(again, [pass, { ...extend, state: "running" }, again], [review])).toEqual({ kind: "run", task: { ...extend, state: "running" } });
  // A resumed pass keeps its thread: a call of it still waits for the run that continues it.
  const resumed = { ...task("again2", "running", 40), resumeRootId: "pass", context: { branch: "main" } } as Task;
  expect(queueWait(call, [resumed, call], [review])).toEqual({ kind: "run", task: resumed });
});

// The engine claims through the same rules (queueAdmission in claimNext); tasks.test.ts runs these cases there.
it.each([
  { name: "two edits of one change in one thread", a: { threadId: "t", changeId: "A", editIndex: 0 }, b: { threadId: "t", changeId: "A", editIndex: 1 }, beside: true },
  { name: "the first edits of two changes in one thread", a: { threadId: "t", changeId: "A", editIndex: 0 }, b: { threadId: "t", changeId: "B", editIndex: 0 }, beside: true },
  { name: "one edit, sent from its own thread and from the request that flagged it", a: { threadId: "t", changeId: "A", editIndex: 0 }, b: { threadId: "flagger", changeId: "A", editIndex: 0 }, beside: false },
  { name: "one edit, sent about its first version and about its revision", a: { threadId: "t", changeId: "A", editIndex: 0 }, b: { threadId: "t", changeId: "A3", editIndex: 0 }, beside: false },
  { name: "a revised edit and another edit of the change it was first made in", a: { threadId: "t", changeId: "A", editIndex: 1 }, b: { threadId: "t", changeId: "A3", editIndex: 0 }, beside: true },
  { name: "two calls of one pass", a: { threadId: "pass", changeId: "P", cutIndex: 1 }, b: { threadId: "pass", changeId: "P", cutIndex: 2 }, beside: true },
  { name: "one call, sent about two versions of its pass", a: { threadId: "pass", changeId: "P", cutIndex: 2 }, b: { threadId: "pass", changeId: "P2", cutIndex: 2 }, beside: false },
  { name: "a call and an applied edit", a: { threadId: "pass", changeId: "P", cutIndex: 0 }, b: { threadId: "pass", changeId: "P", editIndex: 0 }, beside: true },
  { name: "an edit and the whole video", a: { threadId: "t", changeId: "A", editIndex: 0 }, b: { threadId: "t" }, beside: true },
  { name: "an edit and the whole video in another thread", a: { threadId: "t", changeId: "A", editIndex: 0 }, b: { threadId: "u" }, beside: true },
  { name: "a call and the run of its pass's thread", a: { threadId: "pass", changeId: "P", cutIndex: 0 }, b: { threadId: "pass" }, beside: false },
  { name: "a call and the whole video in another thread", a: { threadId: "pass", changeId: "P", cutIndex: 0 }, b: { threadId: "u" }, beside: true },
])("keys a request by the cut or edit it is about: $name", ({ a, b, beside }) => {
  // A2 revises A's edit 0 at its spot 1, and A3 revises that at its spot 0.
  const changes = [{ id: "A" }, { id: "A2", timelineEdits: [{ label: "Other", range: { start: 0, end: 1 } }, { label: "Zoom", range: { start: 2, end: 3 }, replaces: { changeId: "A", spot: 0 } }] },
    { id: "A3", timelineEdits: [{ label: "Zoom", range: { start: 2, end: 3 }, replaces: { changeId: "A2", spot: 1 } }] }] as Change[];
  const x = task("x", "queued", 1, a), y = task("y", "running", 0, b);
  const kx = requestTargetKey(x, changes), ky = requestTargetKey(y, changes);
  if (kx !== undefined && ky !== undefined) expect(kx !== ky).toBe(beside);
  expect(queueWait(x, [y, x], changes)).toEqual(beside ? undefined : { kind: "run", task: y });
  const yx = task("y", "queued", 1, b), xy = task("x", "running", 0, a);
  expect(queueWait(yx, [xy, yx], changes)).toEqual(beside ? undefined : { kind: "run", task: xy });
  // Queued together, the later one starts beside the earlier one only when they are about different things.
  const later = task("later", "queued", 2, b);
  expect(queueOrder([later, x], changes).map(t => t.id)).toEqual(["x", "later"]);
  expect(queueWait(later, [later, x], changes)).toEqual(beside ? undefined : { kind: "ahead", count: 1 });
});

it("names an applied edit by where it was first made, a call by its pass's thread", () => {
  const changes = [{ id: "A2", timelineEdits: [{ label: "Zoom", range: { start: 2, end: 3 }, replaces: { changeId: "A", spot: 0 } }] }] as Change[];
  expect(requestTargetKey(task("x", "queued", 1, { changeId: "A2", editIndex: 0 }), changes)).toBe(JSON.stringify(["edit", "A", 0]));
  expect(requestTargetKey(task("x", "queued", 1, { changeId: "A2", editIndex: 0 }))).toBe(JSON.stringify(["edit", "A2", 0]));
  expect(requestTargetKey(task("x", "queued", 1, { threadId: "pass", changeId: "P", cutIndex: 3 }))).toBe(JSON.stringify(["call", "pass", 3]));
  expect(requestTargetKey(task("x", "queued", 1, { cutIndex: 3 }))).toBeUndefined();
  expect(requestTargetKey(task("x", "queued", 1))).toBeUndefined();
});
