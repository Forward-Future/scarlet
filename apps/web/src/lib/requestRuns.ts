import { requestText, type Task } from "@scarlet/shared";
import { cutSummary, type Change } from "@scarlet/timeline";
import { isRedo, type Thread, type ThreadEntry } from "./threads";

/** The latest attempt at a run: one that was interrupted carries on under a new task. */
export function lastAttempt(task: Task | undefined, tasks: readonly Task[]) {
  for (let hops = 0; task?.retryTaskId && hops < 50; hops++) {
    const next = tasks.find(t => t.id === task!.retryTaskId);
    if (!next) break;
    task = next;
  }
  return task;
}

/**
 * A request the editor took out of the queue before Scarlet began it. Nothing ran, so there is nothing to show or
 * resume: it isn't in the conversation, and the timeline never takes it for the latest request. A run picked up again
 * and then taken out keeps its card, which says it stopped.
 */
export const takenFromQueue = (task: Task) => task.state === "cancelled" && !task.startedAt && !task.resumeRootId;
/** The attempts made by Retry or Resume on an earlier one. Such an attempt belongs to that request, whatever became of it. */
export const laterAttempts = (tasks: readonly Task[]) => new Set(tasks.flatMap(t => t.retryTaskId ? [t.retryTaskId] : []));
/** The attempt that made the suggestion a redo of Scarlet's makes again. The redo carries that request on. */
const redoOf = (redo: Task, tasks: readonly Task[]) => isRedo(redo) && redo.context.changeId
  ? tasks.find(t => t.id !== redo.id && t.changeIds.includes(redo.context.changeId!)) : undefined;
/**
 * What Scarlet's redo of a suggestion waits under in the tray: the words of the request it carries on, or the
 * suggestion's own when no request made it. Never the engine's name for the task ("Redo on the current edit").
 */
export function redoWords(redo: Task, tasks: readonly Task[], changes: readonly Change[]) {
  let made = redoOf(redo, tasks);
  for (let hops = 0; made && isRedo(made) && hops < 50; hops++) made = redoOf(made, tasks);
  return made ? requestText(made) : cutSummary(changes.find(c => c.id === redo.context.changeId)?.description ?? "") || requestText(redo);
}
/**
 * The request each attempt belongs to, by its first attempt. A run picked up after an interruption names it. One tried
 * again from the start doesn't, so it is found through the attempt whose Retry made it: the request keeps its one
 * block, instead of leaving the failed block behind and starting a second. Scarlet's own redo of a suggestion is found
 * through the attempt that made the suggestion, once Scarlet has started on it: the request goes back to work under
 * its own heading, as it does on Retry. Until then the redo waits its turn in the tray, as every request does.
 */
export function requestRoots(tasks: readonly Task[]) {
  const madeBy = new Map(tasks.flatMap(t => t.retryTaskId ? [[t.retryTaskId, t] as const] : []));
  for (const redo of tasks) {
    const made = waitingToStart(redo) ? undefined : redoOf(redo, tasks);
    if (made) madeBy.set(redo.id, made);
  }
  return (task: Task) => {
    let id = task.resumeRootId ?? task.id;
    for (let hops = 0; hops < 50; hops++) {
      const before = madeBy.get(id);
      if (!before || before.id === id) break;
      id = before.resumeRootId ?? before.id;
    }
    return id;
  };
}
/**
 * A request that hasn't begun: it waits in the tray. One Scarlet already began and that is in line again, after the
 * editor answered its question or Scarlet reopened, has its place in the conversation and keeps it.
 */
export const waitingToStart = (task: Task) => task.state === "queued" && !task.startedAt;
/** The notes without what those requests said: a revision's words are saved as a note, which would stay as a message with nothing under it. */
export function notesStillAsked<N extends { id: string }>(notes: N[], tasks: readonly Task[]): N[] {
  const again = laterAttempts(tasks);
  const gone = new Set(tasks.filter(t => takenFromQueue(t) && !again.has(t.id)).flatMap(t => t.context.noteIds ?? []));
  return gone.size ? notes.filter(n => !gone.has(n.id)) : notes;
}

/**
 * The run that staged a pass. Revising one cut replaces the pass with a new one made by the revision's own request, so
 * from there it is found through the pass each revision replaced.
 */
export function stagingTask(pass: Change, changes: readonly Change[], tasks: readonly Task[]) {
  let task = tasks.find(t => t.id === pass.taskId);
  for (let hops = 0; task && task.context.cutIndex !== undefined && task.context.changeId && hops < 50; hops++) {
    const replaced = changes.find(c => c.id === task!.context.changeId);
    const before = replaced && replaced.taskId !== task.id ? tasks.find(t => t.id === replaced.taskId) : undefined;
    if (!before) break;
    task = before;
  }
  return task;
}

/** A request and the attempts that carried it on after an interruption: one run, one block in the chat. */
export interface Run { root: string; task: Task; attempts: Task[] }

/** A thread's requests that are in the conversation. One that hasn't started waits in the tray, not in the chat. */
export function threadRuns(thread: Thread): Run[] {
  const byRoot = new Map<string, Task[]>();
  const rootOf = requestRoots(thread.tasks);
  for (const t of thread.tasks) {
    const root = rootOf(t);
    byRoot.set(root, [...(byRoot.get(root) ?? []), t]);
  }
  const all = [...byRoot].map(([root, attempts]): Run => ({ root, attempts, task: attempts.at(-1)! }));
  return all.filter(run => run.attempts.some(t => !waitingToStart(t)));
}

/** Scarlet's closing words on a change it applied, which draw with the request they answer. */
export const closingReply = (entry: ThreadEntry): entry is Extract<ThreadEntry, { kind: "agent" }> => entry.kind === "agent" && !entry.taskId && !!entry.replyTo;
const namesOne = (task: Task) => task.context.cutIndex !== undefined || task.context.editIndex !== undefined;
/**
 * The attempt that says which cut or edit a request is about. Scarlet's redo of what the request suggested names
 * neither, so it is the latest of the request's own attempts that does.
 */
export const aimOf = (run: Run) => run.attempts.findLast(namesOne) ?? run.task;
/** A request about one cut or one edit: a revision, or an undo. It is named for that cut or edit, not numbered as an edit of its own. */
export const aboutOne = (run: Run) => namesOne(aimOf(run));
