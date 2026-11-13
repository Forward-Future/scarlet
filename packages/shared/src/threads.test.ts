import { describe, expect, it } from "vitest";
import { Change, Note } from "@scarlet/timeline";
import { Task } from "./api.js";
import { aboutChange, buildThreads, callNumbers, countReviewDecisions, noteThread, openDialogueReview, requestText, sameRun, taskRunKind } from "./threads.js";
import { threadRevision } from "./threadTimeline.js";

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const task = (id: string, fields: Record<string, unknown> = {}): Task => Task.parse({ id, projectId: "p", kind: "edit", agent: "claude", instruction: `Do ${id}`,
  state: "done", createdBy: { type: "human", name: "Editor" }, createdAt: at(0), ...fields });
const change = (id: string, fields: Record<string, unknown> = {}): Change => Change.parse({ id, projectId: "p", fromVersion: "v0", toVersion: "v1", description: `Change ${id}`,
  author: { type: "agent", name: "Scarlet" }, state: "ready", createdAt: at(1), ...fields });
const pass = (fields: Record<string, unknown> = {}) => change("pass", { intent: "suggestion", threadId: "request", taskId: "run",
  cutReasons: [{ start: 1, end: 2, reason: "Retake" }], ...fields });

describe("noteThread", () => {
  it("is the note's own words and its replies", () => {
    const reply = { text: "Trimmed it.", author: { type: "agent" as const, name: "Scarlet" }, createdAt: at(2) };
    expect(noteThread({ text: "Too long here", replies: [reply] })).toEqual({ text: "Too long here", replies: [reply] });
    expect(noteThread({ text: "Too long here" })).toEqual({ text: "Too long here", replies: [] });
  });

  it("reads replies an older note had appended to its text back out, before any saved since", () => {
    const later = { text: "Shorter still.", author: { type: "agent" as const, name: "Scarlet" } };
    const note = { text: "Too long here\n\n— Matt: Trimmed two seconds: 0:10 to 0:12.\n\n— Scarlet (claude): Done.\nAnd checked.", replies: [later] };
    expect(noteThread(note)).toEqual({ text: "Too long here", replies: [{ text: "Trimmed two seconds: 0:10 to 0:12." }, { text: "Done.\nAnd checked." }, later] });
  });

  it("leaves a dash the author wrote in the note where it is", () => {
    for (const text of ["Cut this\n\n— not the next line", "Two parts\n\n— first\n\n— second", "A — B: C", `x\n\n— ${"n".repeat(81)}: too long to be a name`]) {
      expect(noteThread({ text }), text).toEqual({ text, replies: [] });
    }
  });
});

describe("a dialogue pass that holds the queue", () => {
  it("is open while its staged cuts wait on the editor", () => {
    expect(openDialogueReview(pass(), [])).toBe(true);
    for (const state of ["proposed", "rendering", "approved", "rejected", "failed"]) expect(openDialogueReview(pass({ state }), []), state).toBe(false);
    // Only a pass that staged cuts: not a requested edit, and not a suggestion without them.
    expect(openDialogueReview(pass({ intent: "requested" }), [])).toBe(false);
    expect(openDialogueReview(pass({ cutReasons: [] }), [])).toBe(false);
    expect(openDialogueReview(pass({ cutReasons: undefined }), [])).toBe(false);
  });

  it("stays open while a revision of it is queued or running, and not once that revision has ended", () => {
    const revising = pass({ state: "revising" });
    const revision = (state: string, changeId = "pass") => task("revision", { kind: "revise", state, context: { changeId } });
    for (const state of ["queued", "claimed", "running", "waiting_for_user"]) expect(openDialogueReview(revising, [revision(state)]), state).toBe(true);
    for (const state of ["done", "failed", "cancelled"]) expect(openDialogueReview(revising, [revision(state)]), state).toBe(false);
    expect(openDialogueReview(revising, [revision("running", "another")])).toBe(false);
    expect(openDialogueReview(revising, [])).toBe(false);
  });

  it("doesn't hold a reply in its thread or a revision of it", () => {
    expect(aboutChange(task("reply", { context: { threadId: "request" } }), pass())).toBe(true);
    expect(aboutChange(task("revision", { context: { changeId: "pass", threadId: "elsewhere" } }), pass())).toBe(true);
    // A task with no thread of its own starts one under its id.
    expect(aboutChange(task("request"), pass())).toBe(true);
    expect(aboutChange(task("zoom"), pass())).toBe(false);
    expect(aboutChange(task("zoom", { context: { threadId: "other", changeId: "other" } }), pass())).toBe(false);
  });
});

describe("runs and requests", () => {
  it("treats a run and the task that resumed it as one run", () => {
    const first = task("run"), resumed = task("again", { resumeRootId: "run" }), third = task("third", { resumeRootId: "run" });
    expect(sameRun(first, resumed)).toBe(true);
    expect(sameRun(resumed, third)).toBe(true);
    expect(sameRun(first, first)).toBe(true);
    expect(sameRun(first, task("other"))).toBe(false);
    expect(sameRun(first, undefined)).toBe(false);
  });

  it("knows what a request is when it is sent: a dialogue pass, a request about one staged cut, or neither", () => {
    expect(taskRunKind(task("t", { instruction: "/dialogue-pass" }))).toBe("pass");
    expect(taskRunKind(task("t", { instruction: "/first-cut-dialogue" }))).toBe("pass");
    expect(taskRunKind(task("t", { instruction: "History…\nRequest: /first-cut-dialogue keep it tight", context: { message: "/first-cut-dialogue keep it tight" } }))).toBe("pass");
    expect(taskRunKind(task("t", { instruction: "/first-cut-dialogue", context: { dialogueOperation: "none", skillIds: ["custom"] } }))).toBeUndefined();
    expect(taskRunKind(task("t", { instruction: "Run the pass", context: { skillIds: ["skl_dialogue"] } }))).toBeUndefined();
    // A request about one staged cut is that, even when it carries the pass's skill.
    expect(taskRunKind(task("t", { instruction: "Start it later.", context: { changeId: "c1", cutIndex: 0, skillIds: ["skl_dialogue"] } }))).toBe("cut");
    // The command anywhere in the request runs the skill, as the message box sends it, and so does its alias for pauses:
    // either is a pass before the skill's id is known, and when it can't be.
    expect(taskRunKind(task("t", { instruction: "Keep it tight /first-cut-dialogue" }))).toBe("pass");
    expect(taskRunKind(task("t", { instruction: "Redo what /first-cut-dialogue did to the intro" }))).toBe("pass");
    expect(taskRunKind(task("t", { instruction: "/tighten-pauses-here around the demo" }))).toBe("pass");
    // Anything else has no kind: a plain request, a command that is part of a longer word or path, one about an applied edit.
    expect(taskRunKind(task("t", { instruction: "Add captions" }))).toBeUndefined();
    expect(taskRunKind(task("t", { instruction: "Look in skills/first-cut-dialogue for the rule" }))).toBeUndefined();
    expect(taskRunKind(task("t", { instruction: "Make it bigger", context: { editIndex: 2 } }))).toBeUndefined();
  });

  it("shows what the person said, not the instruction Scarlet expanded it into", () => {
    expect(requestText(task("t", { instruction: "History…\nRequest: tighter", context: { message: "tighter" } }))).toBe("tighter");
    expect(requestText(task("t", { instruction: "Tighten the intro" }))).toBe("Tighten the intro");
  });
});

describe("buildThreads", () => {
  const only = (source: Partial<Parameters<typeof buildThreads>[0]>) => {
    const threads = buildThreads({ tasks: [], changes: [], notes: [], ...source });
    expect(threads).toHaveLength(1);
    return threads[0]!;
  };

  it("joins a request with the changes it made, its retry, its revision and the feedback between attempts", () => {
    const request = task("request", { changeIds: ["first"], retryTaskId: "retry", createdAt: at(0) });
    const retry = task("retry", { createdAt: at(3) });
    const revision = task("revision", { kind: "revise", context: { changeId: "first" }, createdAt: at(4) });
    const first = change("first", { state: "revising", createdAt: at(1) });
    const second = change("second", { noteIds: ["feedback"], createdAt: at(5), updatedAt: at(6) });
    const feedback = Note.parse({ id: "feedback", projectId: "p", version: "v1", time: 3, text: "Shorter", author: { type: "human", name: "Editor" }, changeId: "first" });
    const thread = only({ tasks: [revision, retry, request], changes: [second, first], notes: [feedback] });
    expect(thread).toMatchObject({ id: "request", title: "Do request", status: "needs_you", needs: "decision", createdAt: at(0), updatedAt: at(6),
      author: { type: "human", name: "Editor" } });
    expect(thread.tasks.map(t => t.id)).toEqual(["request", "retry", "revision"]);
    expect(thread.changes.map(c => c.id)).toEqual(["first", "second"]);
    expect(thread.latest?.id).toBe("second");
  });

  it("keeps transcriptions and skill edits out, and unrelated requests apart", () => {
    const threads = buildThreads({ notes: [], changes: [change("a", { taskId: "one" })],
      tasks: [task("one"), task("two"), task("words", { kind: "transcribe" }), task("skill", { kind: "skill_edit" })] });
    expect(threads.map(t => [t.id, t.tasks.map(x => x.id), t.changes.map(x => x.id)])).toEqual([["one", ["one"], ["a"]], ["two", ["two"], []]]);
  });

  it("names a thread by what was asked, a first cut as the first edit, and an older proposal by its description", () => {
    expect(only({ tasks: [task("t", { context: { message: "Make first cut" } })] }).title).toBe("First edit");
    expect(only({ tasks: [task("t", { instruction: "Expanded", context: { message: "tighter" } })] }).title).toBe("tighter");
    expect(only({ changes: [change("c", { description: "Optional dialogue cuts · 1.00 s: Retake" })] })).toMatchObject({ id: "c", title: "Optional dialogue cuts are ready to review." });
    // A proposal that predates its first linked task, the editor's revision, keeps its own id and title.
    const legacy = only({ changes: [change("c", { createdAt: at(0) })], tasks: [task("rev", { kind: "revise", context: { changeId: "c" }, createdAt: at(2) })] });
    expect(legacy).toMatchObject({ id: "c", title: "Change c" });
  });

  it("says what a thread is waiting on", () => {
    const status = (source: Partial<Parameters<typeof buildThreads>[0]>) => { const t = only(source); return t.needs ? `${t.status}:${t.needs}` : t.status; };
    const made = (state: string, fields: Record<string, unknown> = {}) => change("c", { taskId: "t", state, ...fields });
    expect(status({ tasks: [task("t", { state: "waiting_for_user", question: "Keep the intro?" })] })).toBe("needs_you:question");
    expect(status({ tasks: [task("t", { state: "running" })] })).toBe("working");
    expect(status({ tasks: [task("t", { state: "queued" })] })).toBe("working");
    expect(status({ tasks: [task("t")], changes: [made("rendering")] })).toBe("working");
    expect(status({ tasks: [task("t")], changes: [made("ready")] })).toBe("needs_you:decision");
    expect(status({ tasks: [task("t")], changes: [made("failed")] })).toBe("needs_you:failed");
    expect(status({ tasks: [task("t")], changes: [made("approved")] })).toBe("done");
    expect(status({ tasks: [task("t")], changes: [made("rejected")] })).toBe("closed");
    expect(status({ tasks: [task("t")] })).toBe("closed");
    // A run that failed before saving anything, or was stopped, can be picked up again.
    expect(status({ tasks: [task("t", { state: "failed" })] })).toBe("needs_you:task_failed");
    expect(status({ tasks: [task("t", { state: "failed", interrupted: true })] })).toBe("needs_you:interrupted");
    // One that was already retried is the retry's to report.
    expect(status({ tasks: [task("t", { state: "failed", retryTaskId: "again", createdAt: at(0) }), task("again", { state: "running", createdAt: at(1) })] })).toBe("working");
    // A stopped pass whose staged cuts are ready asks for the decision, not a resume.
    expect(status({ tasks: [task("t", { state: "failed", interrupted: true })], changes: [made("ready")] })).toBe("needs_you:decision");
    // A change left marked as revising after its revision ended is no longer being worked on.
    const revision = (state: string) => task("rev", { kind: "revise", state, context: { changeId: "c" }, createdAt: at(2) });
    expect(status({ tasks: [task("t"), revision("running")], changes: [made("revising")] })).toBe("working");
    expect(status({ tasks: [task("t"), revision("done")], changes: [made("revising")] })).toBe("closed");
  });

  it("asks for a decision while a pass still runs, once it has a cut to call or a staged cut it hasn't checked", () => {
    const running = task("t", { state: "running" });
    const staged = (fields: Record<string, unknown>) => change("c", { taskId: "t", intent: "suggestion", ...fields });
    const reasons = [{ start: 1, end: 2, reason: "Retake" }, { start: 5, end: 6, reason: "Pause" }];
    const assessed = (verdict: string, index: number) => ({ index, start: 1, end: 2, verdict, reason: "Looked" });
    const needs = (fields: Record<string, unknown>, run = running) => only({ tasks: [run], changes: [staged(fields)] }).needs;
    expect(needs({ cutReasons: reasons, cutAssessments: [assessed("cut", 0), assessed("ask", 1)] })).toBe("decision");
    expect(needs({ cutReasons: reasons, cutAssessments: [assessed("cut", 0)] })).toBe("decision");
    expect(needs({ cutReasons: reasons, cutAssessments: [assessed("cut", 0), assessed("keep", 1)] })).toBeUndefined();
    // A run asked to review every cut itself doesn't hand any to the editor until it is done.
    expect(needs({ cutReasons: reasons }, task("t", { state: "running", context: { reviewAllCuts: true } }))).toBeUndefined();
    expect(needs({ cutReasons: reasons, intent: "requested" })).toBeUndefined();
  });

  it("counts one decision per thread that hasn't been filed since it last changed", () => {
    const source = { notes: [], tasks: [task("one"), task("two"), task("three", { state: "running" })],
      changes: [change("a", { taskId: "one" }), change("a2", { taskId: "one", createdAt: at(2) }), change("b", { taskId: "two" }), change("c", { taskId: "three", state: "rendering" })] };
    expect(countReviewDecisions(source)).toBe(2);
    const [one] = buildThreads(source);
    expect(countReviewDecisions(source, { [one!.id]: threadRevision(one!) })).toBe(1);
    // Filed before its latest attempt arrived: it counts again.
    expect(countReviewDecisions(source, { [one!.id]: threadRevision({ ...one!, changes: one!.changes.slice(0, 1) }) })).toBe(2);
  });

  it("counts what the chat counts: a pass's calls that still wait, and a question as one", () => {
    const reasons = Array.from({ length: 8 }, (_, i) => ({ start: i * 10, end: i * 10 + 1, reason: "Retake" }));
    const looked = (index: number, verdict: string) => ({ index, start: index * 10, end: index * 10 + 1, verdict, reason: "Looked" });
    const called = (index: number, choice: string) => ({ index, start: index * 10, end: index * 10 + 1, choice });
    // Scarlet asks about five of the eight staged cuts and is sure of the rest.
    const assessed = reasons.map((_, i) => looked(i, i < 5 ? "ask" : "cut"));
    const run = (fields: Record<string, unknown> = {}) => task("run", fields);
    const count = (staging: Task, fields: Record<string, unknown> = {}, more: Task[] = []) =>
      countReviewDecisions({ notes: [], tasks: [staging, ...more], changes: [pass({ cutReasons: reasons, cutAssessments: assessed, ...fields })] });
    expect(count(run())).toBe(5);
    // A call the editor has made, or sent back for revision, no longer waits on them.
    expect(count(run(), { cutChoices: [called(0, "cut"), called(3, "keep")] })).toBe(3);
    const revision = (state: string) => task("revision", { kind: "revise", state, context: { threadId: "request", changeId: "pass", cutIndex: 1 }, createdAt: at(3) });
    expect(count(run(), { cutChoices: [called(0, "cut")] }, [revision("queued")])).toBe(3);
    // A revision sent while the pass still ran names the part the editor saw then. The pass has saved its next part
    // since, which took that one's place: the revision is about the same cut there, so that call waits on Scarlet.
    const earlier = change("part1", { intent: "suggestion", threadId: "request", taskId: "run", state: "rejected", replacedBy: "pass", cutReasons: reasons.slice(0, 5), createdAt: at(0) });
    const sentEarlier = task("revision", { kind: "edit", state: "queued", context: { threadId: "request", changeId: "part1", cutIndex: 2 }, createdAt: at(3) });
    expect(countReviewDecisions({ notes: [], tasks: [run(), sentEarlier], changes: [earlier, pass({ cutReasons: reasons, cutAssessments: assessed })] })).toBe(4);
    // The pass stays open, with its other calls, while that revision runs.
    expect(count(run(), { state: "revising" }, [revision("running")])).toBe(4);
    // While Scarlet still works on the pass, a staged cut it hasn't checked isn't a call yet.
    expect(count(run({ state: "running" }), { cutAssessments: assessed.slice(0, 2) })).toBe(2);
    expect(count(run({ state: "running" }), { cutAssessments: [] })).toBe(0);
    // A pass that stopped early hands over the staged cuts it never checked.
    expect(count(run({ state: "failed", interrupted: true }), { cutAssessments: assessed.slice(0, 2) })).toBe(8);
    expect(count(run({ state: "cancelled" }), { cutAssessments: [looked(0, "ask"), looked(1, "cut")], cutChoices: [called(5, "keep")] })).toBe(6);
    // So does a pass that finished without checking them: nobody else will.
    expect(count(run(), { cutAssessments: assessed.slice(0, 2) })).toBe(8);
    expect(count(run(), { cutAssessments: [] })).toBe(8);
    // The run is found through a revision that replaced the pass, and at its latest attempt.
    const replaced = change("first", { intent: "suggestion", threadId: "request", taskId: "run", state: "revising", cutReasons: reasons, createdAt: at(0) });
    const revised = task("revision", { kind: "revise", context: { threadId: "request", changeId: "first", cutIndex: 1 }, changeIds: ["pass"], createdAt: at(3) });
    const stoppedThenRevised = (staging: Task[]) => countReviewDecisions({ notes: [], tasks: [...staging, revised],
      changes: [replaced, pass({ taskId: "revision", cutReasons: reasons, cutAssessments: assessed.slice(0, 2), createdAt: at(4) })] });
    expect(stoppedThenRevised([run({ state: "failed", interrupted: true })])).toBe(8);
    const again = (state: string) => task("again", { state, context: { threadId: "request" }, createdAt: at(2) });
    expect(stoppedThenRevised([run({ state: "failed", interrupted: true, retryTaskId: "again" }), again("running")])).toBe(2);
    expect(stoppedThenRevised([run({ state: "failed", interrupted: true, retryTaskId: "again" }), again("done")])).toBe(8);
    // Every call made and the pass not applied yet: the one decision to apply it, as for any other suggestion.
    expect(count(run(), { cutChoices: [0, 1, 2, 3, 4].map(i => called(i, "cut")) })).toBe(1);
    // A question counts as one, beside the calls.
    const question = task("ask", { state: "waiting_for_user", question: "Keep the intro?", createdAt: at(5) });
    expect(countReviewDecisions({ notes: [], changes: [], tasks: [question] })).toBe(1);
    expect(count(run(), {}, [question])).toBe(6);
  });
});

describe("callNumbers", () => {
  const ask = (index: number, askOrder?: number) => ({ index, start: index, end: index + 0.5, verdict: "ask" as const, reason: "Check it.", ...(askOrder && { askOrder }) });
  const numbers = (map: Map<number, number>) => [...map].sort(([a], [b]) => a - b);

  it("numbers Scarlet's asks in the order it made them, so a later ask earlier in the video comes after", () => {
    expect(numbers(callNumbers({ cutAssessments: [ask(3, 1), ask(7, 2)] }, 9, false))).toEqual([[3, 1], [7, 2]]);
    expect(numbers(callNumbers({ cutAssessments: [ask(1, 3), ask(3, 1), ask(7, 2)] }, 9, false))).toEqual([[1, 3], [3, 1], [7, 2]]);
  });

  it("numbers the cuts a pass never checked after its asks, in timeline order, once its run is over or one of them is open", () => {
    const pass = { cutAssessments: [ask(3, 1), { ...ask(5), verdict: "cut" as const }, ask(7, 2)] };
    expect(numbers(callNumbers(pass, 9, false))).toEqual([[3, 1], [7, 2]]);
    expect(numbers(callNumbers(pass, 9, false, 8))).toEqual([[3, 1], [7, 2], [8, 3]]);
    expect(numbers(callNumbers(pass, 9, true))).toEqual([[0, 3], [1, 4], [2, 5], [3, 1], [4, 6], [6, 7], [7, 2], [8, 8]]);
  });

  it("numbers asks saved before the engine numbered them by their place in the video, after the ones it did", () => {
    expect(numbers(callNumbers({ cutAssessments: [ask(2), ask(4, 1), ask(6)] }, 7, false))).toEqual([[2, 2], [4, 1], [6, 3]]);
  });
});
