import { create } from "zustand";
import type { EditRef, Task } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { appLog, errorName } from "./appLog";
import { api, errorMessage } from "./client";
import { keepEdits, unkeepEdits, type KeptRef } from "./keptEdits";
import { lastAttempt } from "./requestRuns";
import { isActiveTask } from "./taskRun";

/**
 * What ⌘Z takes back, newest last: the editor's Keeps, calls, and the revisions they sent, in this
 * window's session. Each ⌘Z takes back one, so several in a row walk back through them.
 */
export type UndoStep = {
  id: number;
  projectId: string;
  /** The cut or edit it was about, as its tag reads ("Cut at 2:05", "Cut 2"). */
  name?: string;
} & ({
  kind: "keep";
  /** "Keep", or "Done" for a spot marked for the editor. */
  word: "Keep" | "Done";
  threadId: string;
  refs: KeptRef[];
  /** The edit the card was on, opened again once its Keep is taken back. */
  edit: EditRef & { single?: boolean };
} | {
  kind: "revision";
  /** "Reject" for a Reject edit, "Add" for a to-do's Add, "Adjust" for a direct cut-edge drag on the timeline. */
  word?: "Reject" | "Add" | "Adjust";
  /** The request the revision went out as. */
  taskId?: string;
  /** The version a rejection or direct cut adjustment made with no request: ⌘Z takes that version out. */
  version?: string;
  /** The edit the card went on from (Reject edit moves on as Keep does), opened again once it is taken back. */
  threadId?: string;
  edit?: EditRef & { single?: boolean };
} | {
  /** Mark all done / Keep all: Keep on every low-risk edit of the column at once, which may be several requests'. One ⌘Z takes it all back. */
  kind: "keepAll";
  word: "Mark all done" | "Keep all";
  parts: { threadId: string; refs: KeptRef[] }[];
} | {
  /** Taking back a Keep from a kept row's hover control: ⌘Z keeps it again. */
  kind: "unkeep";
  word: "Unkeep";
  threadId: string;
  refs: KeptRef[];
} | {
  /** Keep, Reject edit, or Unkeep on a call of a pass that waits on the editor. */
  kind: "call";
  word: "Keep" | "Reject" | "Unkeep";
  /** The pass the call was made on, and which of its cuts. */
  changeId: string;
  index: number;
  /** What the call was decided as before, when this changed a decision already made: taken back, it is that again. */
  was?: "keep" | "cut";
} | {
  /** Direct edge drag on a call of a pass that waits on the editor. */
  kind: "callAdjust";
  word: "Adjust";
  /** The replacement pass made by the drag, the prior pass it replaced, and the cut's index. */
  changeId: string;
  replacedId: string;
  index: number;
});

/** A call's step, as the page that holds the pass takes it back. */
export type CallStep = Extract<UndoStep, { kind: "call" }>;

/** A step as it is recorded, before it has its place in the list. */
type NewStep = UndoStep extends infer S ? S extends UndoStep ? Omit<S, "id"> : never : never;

interface UndoState {
  steps: UndoStep[];
  /** The step being taken back now. */
  undoing?: number;
  /** Why the last ⌘Z couldn't take its step back, for the project it was in. */
  error?: { projectId: string; text: string };
}

/** Enough to walk back a long review, and no more than a session's worth. */
const LIMIT = 100;
let ids = 0;

export const useUndoStore = create<UndoState>(() => ({ steps: [] }));

/** The editor did something ⌘Z can take back. */
export function recordUndo(step: NewStep) {
  const next = { ...step, id: ++ids } as UndoStep;
  useUndoStore.setState(s => ({
    steps: [...s.steps.filter(other => other.projectId !== step.projectId), ...s.steps.filter(other => other.projectId === step.projectId).slice(-(LIMIT - 1)), next],
    error: s.error?.projectId === step.projectId ? undefined : s.error,
  }));
}

/**
 * No pass waits on the editor any more: a pass that went in holds every cut of it, so none of the calls made on it can
 * be taken back. ⌘Z says so once, and goes on to what came before them.
 */
export function forgetCalls(projectId: string) {
  useUndoStore.setState(s => ({ steps: s.steps.filter(step => step.projectId !== projectId || (step.kind !== "call" && step.kind !== "callAdjust")) }));
}

/** The step the next ⌘Z takes back in this project. */
export function lastStep(steps: readonly UndoStep[], projectId: string) {
  return steps.findLast(step => step.projectId === projectId);
}

const stepWord = (step: UndoStep) => step.kind === "keep" || step.kind === "keepAll" || step.kind === "unkeep" ? step.word : step.word ?? "revision";

/**
 * Take back the newest step in this project. A Keep is taken back here and on the engine, and the edit waits on the
 * editor again. A revision still waiting or under way is
 * stopped; one that landed is taken out again: an applied version is reverted, and a new version of a pass that waits
 * is put away for the one it replaced. A call's Keep or Reject edit is taken back by the page that holds its pass
 * (`uncall`), which throws the reason when it can't be. Says what it took back, or nothing when there was nothing to
 * take back.
 */
export async function undoLast(projectId: string, project: { changes: readonly Change[]; tasks: readonly Task[] },
  revert: (version: string) => Promise<void>, uncall?: (step: CallStep) => void): Promise<UndoStep | undefined> {
  const state = useUndoStore.getState();
  if (state.undoing !== undefined) { appLog("action", "undo-skipped", { project: projectId, reason: "busy" }); return; }
  const step = lastStep(state.steps, projectId);
  if (!step) { appLog("action", "undo-skipped", { project: projectId, reason: "empty" }); return; }
  useUndoStore.setState({ undoing: step.id, error: undefined });
  try {
    if (step.kind === "keep") unkeepEdits(projectId, step.threadId, step.refs);
    else if (step.kind === "unkeep") keepEdits(projectId, step.threadId, step.refs);
    else if (step.kind === "keepAll") for (const part of step.parts) unkeepEdits(projectId, part.threadId, part.refs);
    else if (step.kind === "call") {
      if (!uncall) throw new Error("its pass isn’t open here.");
      uncall(step);
    }
    else if (step.kind === "callAdjust") {
      const made = project.changes.find(c => c.id === step.changeId);
      if (made?.state === "approved") throw new Error("its pass has been applied since.");
      if (made && (made.state === "ready" || made.state === "revising" || made.state === "failed")) {
        await api.rejectChange(made.id, "Taken back with Undo.");
      }
      const prior = project.changes.find(c => c.id === step.replacedId);
      if (prior?.state === "rejected") await api.reopenChange(prior.id);
    }
    else if (step.version) await revert(step.version);
    else if (step.taskId) await undoRevision(step.taskId, project, revert);
    appLog("action", "undo", { project: projectId, kind: step.kind, ...(step.kind === "keep" && { change: step.edit.changeId }),
      ...(step.kind === "unkeep" && { count: step.refs.length }),
      ...(step.kind === "keepAll" && { count: step.parts.reduce((n, part) => n + part.refs.length, 0) }) });
    useUndoStore.setState(s => ({ steps: s.steps.filter(other => other.id !== step.id) }));
    return step;
  } catch (error) {
    appLog("action", "undo-failed", { project: projectId, kind: step.kind, name: errorName(error) }, { level: "warn" });
    // It goes from the list all the same: pressed again, ⌘Z goes on to the step before it rather than failing again.
    useUndoStore.setState(s => ({ steps: s.steps.filter(other => other.id !== step.id),
      error: { projectId, text: `Couldn’t undo ${step.kind === "keep" || step.kind === "keepAll" || step.kind === "unkeep" || step.word ? stepWord(step) : "the revision"}: ${reason(error)}` } }));
  } finally {
    useUndoStore.setState(s => s.undoing === step.id ? { undoing: undefined } : s);
  }
}

async function undoRevision(taskId: string, project: { changes: readonly Change[]; tasks: readonly Task[] }, revert: (version: string) => Promise<void>) {
  const first = project.tasks.find(t => t.id === taskId);
  if (!first) throw new Error("that revision isn’t in this project any more.");
  // A revision picked up again runs as a new attempt: every attempt is the same request.
  const attempts = new Set([taskId]);
  for (let task = first, hops = 0; task.retryTaskId && hops < 50; hops++) {
    attempts.add(task.retryTaskId);
    const next = project.tasks.find(t => t.id === task.retryTaskId);
    if (!next) break;
    task = next;
  }
  const latest = lastAttempt(first, project.tasks) ?? first;
  const made = project.changes.filter(c => c.taskId && attempts.has(c.taskId))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  // A revision of a pass or a suggestion made a new version of it. Once that went into the video it carries the whole
  // pass with it: taking it out would take every cut of the pass out, not the one revision. Refused, nothing is touched:
  // a run still at work on it carries on.
  const named = first.context.changeId ? project.changes.find(c => c.id === first.context.changeId) : undefined;
  if (named && named.state !== "approved" && made.some(c => c.state === "approved")) throw new Error("the version it made has been applied since.");
  // Taken back, the request's words are withdrawn: the check reading them for a rule stops too, which Stop doesn't do.
  if (isActiveTask(latest.state)) await api.cancelTask(latest.id, false, true);
  // Newest first, so each revert lands on the version it was made on.
  for (const change of made) {
    if (change.state === "approved") await revert(change.appliedVersion ?? change.toVersion);
    else if (change.state === "ready" || change.state === "revising" || change.state === "failed") await api.rejectChange(change.id, "Taken back with Undo.");
  }
  // The version of a pass or suggestion that a landed revision replaced waits for the editor again. It may be a later
  // version than the one the revision was sent about, when another revision landed ahead of it.
  const replaced = project.changes.find(c => c.state === "rejected" && !!c.replacedBy && made.some(m => m.id === c.replacedBy && m.state !== "approved"));
  if (replaced) await api.reopenChange(replaced.id);
}

function reason(error: unknown) {
  const text = errorMessage(error);
  // The reason follows a colon, so it starts small. A name keeps its capital.
  return text.startsWith("Scarlet") ? text : text.charAt(0).toLowerCase() + text.slice(1);
}
