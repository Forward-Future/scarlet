/**
 * Threads: one request and everything that followed it — the agent's
 * progress, its questions, every attempt at the change, your feedback, and
 * follow-ups. The Review screen is a list of threads, like a list of agent
 * threads in a coding tool.
 *
 * Newer data carries explicit thread ids. Older data is grouped by its links:
 * a task with the changes it produced, a revision task with the change it
 * revises, a feedback note with the attempts before and after it.
 */
import { isThreadDone } from "./threadTimeline.js";
import { isAsideTask, taskRecoveryAction, type Skill, type Task } from "./api.js";
import { cutSummary, isPublishedCall, mergeRanges, type Author, type Change, type Note, type TimeRange } from "@scarlet/timeline";

export type ThreadStatus = "needs_you" | "working" | "done" | "closed";

export interface Thread {
  id: string;
  title: string;
  status: ThreadStatus;
  /** Why it needs you, when it does. */
  needs?: "question" | "decision" | "failed" | "interrupted" | "task_failed";
  tasks: Task[];
  /** Attempts, oldest first. */
  changes: Change[];
  latest?: Change;
  question?: Task;
  active?: Task;
  author?: Author;
  createdAt: string;
  updatedAt: string;
}

interface Source {
  changes: Change[];
  tasks: Task[];
  notes: Note[];
}

const ACTIVE = new Set<Task["state"]>(["queued", "claimed", "running"]);
const WORKING_CHANGE = new Set<Change["state"]>(["proposed", "rendering", "revising"]);
const ts = (x?: string) => Date.parse(x ?? "") || 0;

/** Disjoint sets over task/change ids. */
class Groups {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

export function buildThreads(d: Source): Thread[] {
  const g = new Groups();
  const tasks = d.tasks.filter((t) => t.kind !== "transcribe" && !isAsideTask(t));
  const key = (kind: "t" | "c" | "x", id: string) => `${kind}:${id}`;
  for (const t of tasks) {
    g.add(key("t", t.id));
    if (t.retryTaskId) g.union(key("t", t.id), key("t", t.retryTaskId));
    if (t.context.threadId) g.union(key("x", t.context.threadId), key("t", t.id));
    if (t.context.changeId) g.union(key("c", t.context.changeId), key("t", t.id));
    for (const c of t.changeIds) g.union(key("t", t.id), key("c", c));
  }
  const feedbackChanges = new Map<string, string>();
  for (const note of d.notes) {
    if (note.changeId) feedbackChanges.set(note.id, note.changeId);
  }
  for (const c of d.changes) {
    g.add(key("c", c.id));
    if (c.threadId) g.union(key("x", c.threadId), key("c", c.id));
    if (c.taskId) g.union(key("t", c.taskId), key("c", c.id));
    for (const noteId of c.noteIds) {
      const previousChange = feedbackChanges.get(noteId);
      if (previousChange) g.union(key("c", previousChange), key("c", c.id));
    }
  }

  const byRoot = new Map<string, { tasks: Task[]; changes: Change[]; explicit?: string }>();
  const bucket = (k: string) => {
    const r = g.find(k);
    let b = byRoot.get(r);
    if (!b) byRoot.set(r, (b = { tasks: [], changes: [] }));
    return b;
  };
  for (const t of tasks) {
    const b = bucket(key("t", t.id));
    b.tasks.push(t);
    b.explicit ??= t.context.threadId;
  }
  for (const c of d.changes) {
    const b = bucket(key("c", c.id));
    b.changes.push(c);
    b.explicit ??= c.threadId;
  }

  const threads: Thread[] = [];
  for (const b of byRoot.values()) {
    b.tasks.sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
    b.changes.sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
    const first = b.tasks[0];
    // Legacy proposals can predate their first linked task, which is the editor's revision.
    const originalChange = first?.kind === "revise" || first?.context.changeId ? b.changes[0] : undefined;
    const id = b.explicit ?? originalChange?.id ?? first?.id ?? b.changes[0]!.id;
    const lastProposal = b.changes.at(-1);
    const latest = b.changes.findLast(c => (c.intent === "alternative" || c.intent === "suggestion") && c.state === "ready")
      ?? (lastProposal?.intent === "alternative" ? b.changes.findLast(c => c.taskId === lastProposal.taskId && c.state === "approved") : undefined)
      ?? lastProposal;
    const question = b.tasks.find((t) => t.state === "waiting_for_user" && !!t.question);
    const active = b.tasks.find((t) => ACTIVE.has(t.state));
    const lastTask = b.tasks.at(-1);
    const recovery = lastTask && !lastTask.retryTaskId && taskRecoveryAction(lastTask, b.changes.some(c => c.taskId === lastTask.id));
    const finishedRevision = latest?.state === "revising" && b.tasks.some(t => t.kind === "revise" &&
      t.context.changeId === latest.id && ["done", "failed", "cancelled"].includes(t.state));
    let status: ThreadStatus;
    let needs: Thread["needs"];
    if (question) {
      status = "needs_you";
      needs = "question";
    } else if (!active && lastTask?.state === "failed" && recovery && !(recovery === "resume" && latest?.state === "ready")) {
      status = "needs_you";
      needs = lastTask.interrupted ? "interrupted" : "task_failed";
    } else if (active && latest && sameRun(active, b.tasks.find(t => t.id === latest.taskId)) && latest.state === "ready" && latest.intent === "suggestion" &&
        !active.context.reviewAllCuts && latest.cutAssessments?.some(a => isPublishedCall(a) && !latest.cutChoices?.some(c => c.index === a.index))) {
      status = "needs_you";
      needs = "decision";
    } else if (active || (latest && WORKING_CHANGE.has(latest.state) && !finishedRevision)) {
      status = "working";
    } else if (latest && (latest.state === "ready" || latest.state === "failed")) {
      status = "needs_you";
      needs = latest.state === "failed" ? "failed" : "decision";
    } else if (latest?.state === "approved") {
      status = "done";
    } else {
      status = "closed";
    }
    const createdAt = [first?.createdAt, b.changes[0]?.createdAt].filter(Boolean).sort()[0] ?? "";
    const updatedAt =
      [...b.tasks.map((t) => t.finishedAt ?? t.startedAt ?? t.createdAt), ...b.changes.map((c) => c.updatedAt ?? c.createdAt)]
        .filter((x): x is string => !!x)
        .sort()
        .pop() ?? createdAt;
    threads.push({
      id,
      title: first && !originalChange ? (first.context.message === "Make first cut" ? "First edit" : requestText(first)) : cutSummary((originalChange ?? b.changes[0]!).description),
      status,
      needs,
      tasks: b.tasks,
      changes: b.changes,
      latest,
      question,
      active,
      author: first?.createdBy ?? b.changes[0]?.author,
      createdAt,
      updatedAt,
    });
  }
  return threads;
}

/** A run that was interrupted carries on under a new task. Both are the same run. */
export function sameRun(a: Task, b: Task | undefined): boolean {
  return !!b && (a.resumeRootId ?? a.id) === (b.resumeRootId ?? b.id);
}

/**
 * A note's own words, and what was said back about it. Replies used to be appended to the note's text as
 * "\n\n— name: reply", under the name of whoever was signed in, which made the agent's reply read as the editor's and
 * the note no longer match the request it was sent as. Those are read back out of an older note here.
 */
export function noteThread(note: Pick<Note, "text" | "replies">): { text: string; replies: { text: string; author?: Author; createdAt?: string }[] } {
  const [own = "", ...appended] = note.text.split(/\n\n— (?=[^\n:]{1,80}: )/);
  return { text: own, replies: [...appended.map(part => ({ text: part.slice(part.indexOf(": ") + 2) })), ...(note.replies ?? [])] };
}

/** What the person asked, without the history Scarlet adds for the agent. */
export function requestText(t: Task): string {
  return t.context.message ?? t.instruction;
}

/**
 * What a request is, known when it is sent: a dialogue pass, or a request about one staged cut of a pass. It sets what
 * the chat shows while Scarlet works. A pass shows the stages Scarlet measures and a request about one cut its own two;
 * any other request has no kind, and shows the plan its agent lays out.
 */
export type RunKind = "pass" | "cut";

/** Whole whitespace-delimited tokens, also used to locate commands in the composer. */
export function skillCommands(draft: string) {
  return Array.from(draft.matchAll(/(?:^|\s)(\/([a-z0-9][a-z0-9-]*)?)(?=\s|$)/gi), match => {
    const end = match.index + match[0].length;
    return { start: end - match[1]!.length, end, name: (match[2] ?? "").toLowerCase() };
  });
}

export function isDialogueGuide(skill: Skill) {
  return (skill.name === "dialogue-pass" || skill.name === "first-cut-dialogue") && (skill.bundledName === skill.name ||
    (!skill.bundledName && (skill.source === "bundled" || skill.source === "seed")));
}

type DialogueOperation = NonNullable<Task["context"]["dialogueOperation"]>;

/** A custom entry owns its command name even when disabled. The shipped guide is optional advice for the product shortcut. */
export function dialogueShortcut(name: string, library: readonly Skill[]): DialogueOperation | undefined {
  if (name !== "dialogue-pass" && name !== "first-cut-dialogue" && name !== "tighten-pauses-here") return;
  const entry = library.find(skill => skill.name === name);
  if (entry && !isDialogueGuide(entry)) return;
  return name === "tighten-pauses-here" ? "local-pauses" : "first-cut";
}

/** Resolve the last explicit product shortcut against the library at the time the editor sent it. */
export function dialogueCommand(text: string, library: readonly Skill[] = []): DialogueOperation | undefined {
  let chosen: DialogueOperation | undefined;
  for (const { name } of skillCommands(text)) chosen = dialogueShortcut(name, library) ?? chosen;
  return chosen;
}

/** Older tasks can lack a recorded operation. Their message and subsequent editor answers identify the shortcut. */
export function taskDialogueOperation(task: Pick<Task, "context" | "instruction">, answers: readonly string[] = [], library: readonly Skill[] = []): DialogueOperation {
  if (task.context.dialogueOperation !== undefined) return task.context.dialogueOperation;
  let chosen = dialogueCommand(task.context.message ?? task.instruction, library) ?? "none";
  for (const answer of answers) chosen = dialogueCommand(answer, library) ?? chosen;
  return chosen;
}

export function taskRunKind(task: Pick<Task, "context" | "instruction">): RunKind | undefined {
  if (task.context.cutIndex !== undefined) return "cut";
  if (task.context.editIndex === undefined && taskDialogueOperation(task) !== "none") return "pass";
}

const ACTIVE_STATES = new Set(["claimed", "running", "waiting_for_user"]);

const PENDING_STATES = new Set(["queued", ...ACTIVE_STATES]);

/**
 * A dialogue pass whose staged cuts still need the editor. A request built on the edit before those cuts are
 * decided could block applying them, so new requests wait for it, except ones about the pass itself. A pass with one
 * cut sent back for revision is still open while that revision is queued or running: an earlier request let through
 * then would move the edit on, and the revision would be refused as out of date. Once the revision has run, its new
 * version is the pass that waits. The version it replaced stays marked as revising, and holds nothing.
 */
export function openDialogueReview(change: Change, tasks: readonly Task[]): boolean {
  if (change.intent !== "suggestion" || !change.cutReasons?.length) return false;
  return change.state === "ready"
    || (change.state === "revising" && tasks.some(t => PENDING_STATES.has(t.state) && t.context.changeId === change.id));
}

/** A reply in the pass's thread or a revision of it works on the pass, so the pass doesn't hold it back. */
export function aboutChange(task: Task, change: Change): boolean {
  return (task.context.threadId ?? task.id) === change.threadId || task.context.changeId === change.id;
}

export type QueueWait =
  | { kind: "question"; task: Task }
  | { kind: "run"; task: Task }
  | { kind: "ahead"; count: number }
  | { kind: "review"; change: Change };

/** The requests that take turns with one: the others in its project that edit the video. */
const takingTurns = (task: Task, tasks: readonly Task[]) =>
  tasks.filter(t => t.projectId === task.projectId && t.id !== task.id && t.kind !== "transcribe" && !isAsideTask(t));

/** The dialogue passes waiting on the editor on a request's branch. */
function openReviews(task: Task, tasks: readonly Task[], changes: readonly Change[]): Change[] {
  const branchOf = (c: Change) => tasks.find(t => t.id === c.taskId)?.context.branch;
  return changes.filter(c => c.projectId === task.projectId && openDialogueReview(c, tasks) && branchOf(c) === task.context.branch);
}

/**
 * A pass a run is still making: the run saved it, and every earlier save it took the place of, as a pass does part by
 * part. A request about a call of a pass that already waited saves the pass again under its own run, in place of the
 * one another run staged. That pass waited on the editor before the request began and waits on them still.
 */
function stillMaking(pass: Change, run: Task, tasks: readonly Task[], changes: readonly Change[], hops = 0): boolean {
  if (!sameRun(run, tasks.find(t => t.id === pass.taskId))) return false;
  return hops > 50 || changes.every(c => c.replacedBy !== pass.id || !c.cutReasons?.length || stillMaking(c, run, tasks, changes, hops + 1));
}

/**
 * The pass whose calls hold a queued request back: one waiting on the editor that the request isn't about. A pass the
 * run Scarlet is on is still making has asked for nothing yet, so what waits behind it waits for that run. A request
 * the editor started anyway (`startsBeforeCalls`) is held by none.
 */
function heldBy(task: Task, tasks: readonly Task[], changes: readonly Change[]): Change | undefined {
  // The editor said not to wait for their calls.
  if (task.startsBeforeCalls) return undefined;
  const active = takingTurns(task, tasks).find(t => ACTIVE_STATES.has(t.state));
  return openReviews(task, tasks, changes).find(c => !aboutChange(task, c) && !(active && stillMaking(c, active, tasks, changes)));
}

/** A request about an open pass goes ahead of requests that are waiting for that pass. */
const goesAhead = (task: Task, of: Task, tasks: readonly Task[], changes: readonly Change[]) =>
  openReviews(task, tasks, changes).some(c => aboutChange(task, c) && !aboutChange(of, c));

/** Whether one request is before another in line. A resumed run keeps the place of the run it continues, down to a request asked in the same millisecond. */
function inLine(tasks: readonly Task[]) {
  const order = (t: Task) => {
    const root = tasks.find(r => r.id === t.resumeRootId) ?? t;
    return [root.createdAt ?? "", tasks.indexOf(root), tasks.indexOf(t)] as const;
  };
  return (a: Task, b: Task) => {
    const x = order(a), y = order(b);
    return x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2];
  };
}

/**
 * Why a queued request hasn't started. Scarlet runs one request at a time in a project, in the order they were
 * asked, so two agents never edit the same video at once. The engine's claim query applies the same rule.
 * A request held for the editor's calls says so while Scarlet is on something else too, such as a revision of one of
 * those calls: it won't start when that ends.
 */
export function queueWait(task: Task, tasks: readonly Task[], changes: readonly Change[]): QueueWait | undefined {
  if (task.state !== "queued" || task.kind === "transcribe" || isAsideTask(task)) return undefined;
  const others = takingTurns(task, tasks);
  const active = others.find(t => ACTIVE_STATES.has(t.state));
  if (active?.state === "waiting_for_user") return { kind: "question", task: active };
  const review = heldBy(task, tasks, changes);
  if (active) return review ? { kind: "review", change: review } : { kind: "run", task: active };
  const before = inLine(tasks);
  const ahead = others.filter(t => t.state === "queued" && before(t, task) && !goesAhead(task, t, tasks, changes));
  if (ahead.length) return { kind: "ahead", count: ahead.length };
  return review ? { kind: "review", change: review } : undefined;
}

/**
 * The queued requests in the order Scarlet will start them, as the engine's claim query picks them: the first in line
 * that no pass holds back and that nothing ahead of it must run before. Requests about a pass that waits on the editor
 * so go ahead of the ones that pass holds back, whichever were asked first; those follow, in line, once the calls are made.
 */
export function queueOrder(tasks: readonly Task[], changes: readonly Change[]): Task[] {
  const before = inLine(tasks);
  let waiting = tasks.filter(t => t.state === "queued" && t.kind !== "transcribe" && !isAsideTask(t)).sort((a, b) => before(a, b) ? -1 : before(b, a) ? 1 : 0);
  const order: Task[] = [];
  for (;;) {
    const next = waiting.find(q => !heldBy(q, tasks, changes)
      && !waiting.some(r => r !== q && r.projectId === q.projectId && before(r, q) && !goesAhead(q, r, tasks, changes)));
    if (!next) return [...order, ...waiting];
    order.push(next);
    waiting = waiting.filter(t => t !== next);
  }
}

/**
 * The number of each call of a dialogue pass, by its cut's index: the order the calls reached the editor in, as the
 * window shows it ("Cut 2"). Anything else that names a call by its number uses this too, so the two can't disagree.
 * Scarlet's asks go in the order it made them, as the engine numbers them (`askOrder`). The cuts it never checked
 * follow in timeline order once its run is over (`over`). A later ask about a cut earlier in the video, or the cuts
 * a pass hands over when it ends, never renumber the calls the editor has seen. A pass whose asks aren't numbered, as one saved before the engine
 * numbered them, has them all in timeline order, as every call was then. Once it numbers them, an ask without a number
 * is a cut no one checked that the editor sent back, and it stays among those. `cuts` is how many cuts the pass's
 * review lists: staged cuts that touch are one.
 */
export function callNumbers(pass: Pick<Change, "cutAssessments" | "cutChoices">, cuts: number, over: boolean): Map<number, number> {
  const assessed = pass.cutAssessments?.filter(a => !a.provisional) ?? [];
  const decided = new Set(pass.cutChoices?.map(c => c.index));
  const calls: Array<{ index: number; askOrder?: number }> = assessed.filter(a => isPublishedCall(a) || (a.askOrder !== undefined && decided.has(a.index)));
  if (over) {
    const checked = new Set(assessed.map(a => a.index));
    for (let index = 0; index < cuts; index++) if (!checked.has(index)) calls.push({ index });
  }
  calls.sort((a, b) => (a.askOrder ?? Infinity) - (b.askOrder ?? Infinity) || a.index - b.index);
  return new Map(calls.map((call, i) => [call.index, i + 1]));
}

/**
 * The run that staged a pass is over: it finished, or stopped before it did. Revising one cut replaces the pass under
 * the revision's own request, so the run is found back through the passes each revision replaced, and then at its
 * latest attempt.
 */
export function passRunOver(pass: Change, changes: readonly Change[], tasks: readonly Task[]): boolean {
  let run = tasks.find(t => t.id === pass.taskId);
  for (let hops = 0; run?.context.cutIndex !== undefined && run.context.changeId && hops < 50; hops++) {
    const replaced = changes.find(c => c.id === run!.context.changeId);
    const before = replaced && replaced.taskId !== run.id ? tasks.find(t => t.id === replaced.taskId) : undefined;
    if (!before) break;
    run = before;
  }
  for (let hops = 0; run?.retryTaskId && hops < 50; hops++) {
    const next = tasks.find(t => t.id === run!.retryTaskId);
    if (!next) break;
    run = next;
  }
  return run?.state === "done" || run?.state === "failed" || run?.state === "cancelled";
}

/**
 * Which of this pass's cuts a request about one cut means. A request sent while the pass ran waits its turn naming the
 * proposal the editor saw then, which later parts of the pass have replaced: the cut is followed from part to part by
 * its range, as the chat follows it, so the request is counted against the same call there. Undefined when the request
 * isn't about a cut of this pass, or its cut is no longer in it.
 */
function cutInPass(pass: Change, { changeId, cutIndex }: Task["context"], changes: readonly Change[], tasks: readonly Task[]): number | undefined {
  if (!changeId || cutIndex === undefined) return undefined;
  if (changeId === pass.id) return cutIndex;
  const same = (a: TimeRange, b: TimeRange) => Math.abs(a.start - b.start) < 0.05 && Math.abs(a.end - b.end) < 0.05;
  const overlaps = (a: TimeRange, b: TimeRange) => a.start < b.end && a.end > b.start;
  const staged = (c: Change) => mergeRanges((c.cutReasons ?? []).map(({ start, end }) => ({ start, end })));
  // The proposal that took one's place: the one named on it, or the one a revision of one of its cuts made from it.
  const after = (from: Change) => changes.find(c => c.id === from.replacedBy) ?? changes.find(c => c.id !== from.id && !!c.cutReasons
    && tasks.some(t => t.id === c.taskId && t.kind === "revise" && t.context.changeId === from.id && t.context.cutIndex !== undefined));
  let change = changes.find(c => c.id === changeId);
  let cut = change && staged(change)[cutIndex];
  let index = cutIndex;
  for (let hops = 0; change && cut && hops < 500; hops++) {
    if (change.id === pass.id) return index;
    const next = after(change);
    if (!next?.cutReasons) return undefined;
    const cuts = staged(next);
    let found = cuts.findIndex(r => same(r, cut!));
    if (found < 0) {
      // The next part can stage a cut that touches this one, and the review then lists the two as one.
      const ranges = [cut, ...(change.cutReasons ?? []).filter(r => r.start >= cut!.start && r.end <= cut!.end)];
      const carried = next.cutReasons.filter(r => ranges.some(range => same(r, range)));
      found = cuts.findIndex(r => overlaps(r, cut!) && carried.some(kept => kept.start >= r.start && kept.end <= r.end));
    }
    const at = found >= 0 ? found : index;
    const moved = cuts[at];
    if (!moved || !overlaps(moved, cut)) return undefined;
    change = next; index = at; cut = moved;
  }
  return undefined;
}

/**
 * A dialogue pass's calls that still wait on the editor: the cuts Scarlet asked about, less the ones already called
 * or sent back for revision. Once the run is over, a staged cut it never checked is the editor's call too, whether the
 * run stopped early or finished without getting to it: nobody else will check it (2026-11-10). Staged cuts that touch
 * are one cut, as the pass's review numbers them.
 */
function waitingCalls(pass: Change, { changes, tasks }: Pick<Source, "changes" | "tasks">): number {
  const called = new Set(pass.cutChoices?.map(choice => choice.index));
  const sentBack = new Set(tasks.flatMap(t => {
    if (!PENDING_STATES.has(t.state)) return [];
    const index = cutInPass(pass, t.context, changes, tasks);
    return index === undefined ? [] : [index];
  }));
  const waits = (index: number) => !called.has(index) && !sentBack.has(index);
  const asked = pass.cutAssessments?.filter(a => isPublishedCall(a) && waits(a.index)).length ?? 0;
  if (!passRunOver(pass, changes, tasks)) return asked;
  const checked = new Set(pass.cutAssessments?.filter(a => !a.provisional).map(a => a.index));
  return asked + mergeRanges(pass.cutReasons ?? []).filter((_, index) => !checked.has(index) && waits(index)).length;
}

/**
 * What waits on the editor in a project, counted as its chat counts it ("N need you"): each call of a dialogue pass
 * that is still open, and one for each question Scarlet asked. A suggestion with no call left to make, whether a pass
 * or any other, waits on the one decision to apply it, unless its thread was filed since it last changed. While
 * Scarlet is still at work on a request, only the calls it has already asked for wait. A flagged edit the editor
 * hasn't kept is not counted: which edits were kept is saved in the window, not here.
 */
export function countReviewDecisions(source: Source, completed?: Record<string, string>): number {
  let count = 0;
  for (const thread of buildThreads(source)) {
    if (thread.question) count++;
    const pass = thread.changes.findLast(c => openDialogueReview(c, source.tasks));
    const calls = pass ? waitingCalls(pass, source) : 0;
    if (calls) count += calls;
    else if (!thread.active && thread.needs === "decision" && !isThreadDone(thread, completed)) count++;
  }
  return count;
}
