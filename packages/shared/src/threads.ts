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
import { taskRecoveryAction, type Task } from "./api.js";
import { cutSummary, isPublishedCall, type Author, type Change, type Note } from "@scarlet/timeline";
import { editsVideo, openDialogueReview, sameRun } from "./taskQueue.js";
import { waitingCalls } from "./passCalls.js";

export {
  dialogueCommand,
  dialogueShortcut,
  extendsDialoguePass,
  isDialogueGuide,
  skillCommands,
  skillExtends,
  taskDialogueOperation,
  taskRunKind,
  type RunKind,
} from "./skillCommands.js";
export {
  aboutChange,
  openDialogueReview,
  queueAdmission,
  queueBlocker,
  queueOrder,
  queueWait,
  queueWaits,
  requestTargetKey,
  sameRun,
  type QueueChange,
  type QueueTask,
  type QueueWait,
} from "./taskQueue.js";
export { callNumbers } from "./passCalls.js";

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
  /**
   * Other requests' applied changes with an edit this request flagged for the editor (`Change.flags`). The request
   * lists that edit with its own, as one that needs the editor.
   */
  flagged?: Change[];
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

const RUNNING_OR_QUEUED = new Set<Task["state"]>(["queued", "claimed", "running"]);
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
  const tasks = d.tasks.filter(editsVideo);
  const key = (kind: "t" | "c" | "x", id: string) => `${kind}:${id}`;
  // The requests that flagged each change's edits. A request there about one of those edits, such as Revise or Undo
  // from its card, stays in the request that raised the doubt, which lists the edit, and doesn't join the two.
  const raisedIn = new Map<string, Set<string>>();
  const byId = new Map(tasks.map(t => [t.id, t]));
  for (const c of d.changes) for (const flag of c.flags ?? []) {
    const raiser = byId.get(flag.taskId);
    if (raiser) (raisedIn.get(c.id) ?? raisedIn.set(c.id, new Set()).get(c.id)!).add(raiser.context.threadId ?? raiser.id);
  }
  for (const t of tasks) {
    g.add(key("t", t.id));
    if (t.retryTaskId) g.union(key("t", t.id), key("t", t.retryTaskId));
    if (t.context.threadId) g.union(key("x", t.context.threadId), key("t", t.id));
    if (t.context.changeId && !(t.context.threadId && raisedIn.get(t.context.changeId)?.has(t.context.threadId)))
      g.union(key("c", t.context.changeId), key("t", t.id));
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
    const active = b.tasks.find((t) => RUNNING_OR_QUEUED.has(t.state));
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
  // A doubt about an edit goes to the request that raised it, where the editor is looking, not to the one that made it.
  const byTask = new Map(threads.flatMap(thread => thread.tasks.map(task => [task.id, thread] as const)));
  for (const change of d.changes) for (const flag of change.flags ?? []) {
    const thread = byTask.get(flag.taskId);
    if (!thread || thread.changes.includes(change) || thread.flagged?.includes(change)) continue;
    (thread.flagged ??= []).push(change);
  }
  // A later version of a flagged edit, revised or undone from the request that made it, comes too: the request that
  // raised the doubt lists the edit as it is now. Oldest first, so each version follows the one it replaces.
  const byAge = d.changes.toSorted((x, y) => ts(x.createdAt) - ts(y.createdAt));
  for (const thread of threads) {
    const flagged = thread.flagged;
    if (!flagged) continue;
    for (const change of byAge) {
      if (thread.changes.includes(change) || flagged.includes(change)) continue;
      if (change.timelineEdits?.some(e => e.replaces && flagged.some(f => f.id === e.replaces!.changeId))) flagged.push(change);
    }
    flagged.sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
  }
  return threads;
}

export function threadRevision(thread: Thread) {
  return JSON.stringify([thread.tasks.at(-1)?.id, thread.changes.at(-1)?.id, thread.updatedAt]);
}

export function isThreadDone(thread: Thread, completed?: Record<string, string>) {
  return thread.status !== "working" && !thread.active && !thread.question && completed?.[thread.id] === threadRevision(thread);
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
