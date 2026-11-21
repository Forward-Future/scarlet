import { create } from "zustand";
import type { EditRef, Task } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { appLog, errorName } from "./appLog";
import { api } from "./client";
import { unkeepEdits, type KeptRef } from "./keptEdits";
import { lastAttempt } from "./requestRuns";

/**
 * What ⌘Z takes back, newest last: the editor's Keeps and the revisions they sent, in this window's session. Each
 * ⌘Z takes back one, so several in a row walk back through them.
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
  /** "Reject" for a Reject edit, which asks Scarlet to put the edit back as a revision does. */
  word?: "Reject";
  /** The request the revision went out as. */
  taskId?: string;
  /** The version a rejection made when the engine put the cut back itself, with no request: ⌘Z takes that version out. */
  version?: string;
  /** The edit the card went on from (Reject edit moves on as Keep does), opened again once it is taken back. */
  threadId?: string;
  edit?: EditRef & { single?: boolean };
});

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

/** The step the next ⌘Z takes back in this project. */
export function lastStep(steps: readonly UndoStep[], projectId: string) {
  return steps.findLast(step => step.projectId === projectId);
}

/** The key that takes a step back, as this computer writes it. */
export function undoKey() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘Z" : "Ctrl+Z";
}

/** What the label and its hover say the next ⌘Z takes back: "Undo Keep", and "Undo Keep of Cut at 2:05 (⌘Z)". */
export function undoWords(step: UndoStep) {
  const what = stepWord(step);
  return { label: `Undo ${what}`, title: `Undo ${what}${step.name ? ` of ${step.name}` : ""} (${undoKey()})` };
}

const stepWord = (step: UndoStep) => step.kind === "keep" ? step.word : step.word ?? "revision";

const working = new Set<Task["state"]>(["queued", "claimed", "running", "waiting_for_user"]);

/**
 * Take back the newest step in this project. A Keep is taken back here and on the engine, and the edit waits on the
 * editor again. A revision still waiting or under way is stopped; one that landed is taken out again: an applied
 * version is reverted, and a new version of a pass that waits is put away for the one it replaced. Says what it took
 * back, or nothing when there was nothing to take back.
 */
export async function undoLast(projectId: string, project: { changes: readonly Change[]; tasks: readonly Task[] },
  revert: (version: string) => Promise<void>): Promise<UndoStep | undefined> {
  const state = useUndoStore.getState();
  if (state.undoing !== undefined) return;
  const step = lastStep(state.steps, projectId);
  if (!step) return;
  useUndoStore.setState({ undoing: step.id, error: undefined });
  try {
    if (step.kind === "keep") unkeepEdits(projectId, step.threadId, step.refs);
    else if (step.version) await revert(step.version);
    else if (step.taskId) await undoRevision(step.taskId, project, revert);
    appLog("action", "undo", { project: projectId, kind: step.kind, ...(step.kind === "keep" && { change: step.edit.changeId }) });
    useUndoStore.setState(s => ({ steps: s.steps.filter(other => other.id !== step.id) }));
    return step;
  } catch (error) {
    appLog("action", "undo-failed", { project: projectId, kind: step.kind, name: errorName(error) }, { level: "warn" });
    // It goes from the list all the same: pressed again, ⌘Z goes on to the step before it rather than failing again.
    useUndoStore.setState(s => ({ steps: s.steps.filter(other => other.id !== step.id),
      error: { projectId, text: `Couldn’t undo ${step.kind === "keep" || step.word ? stepWord(step) : "the revision"}: ${reason(error)}` } }));
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
  // Taken back, the request's words are withdrawn: the check reading them for a rule stops too, which Stop doesn't do.
  if (working.has(latest.state)) await api.cancelTask(latest.id, false, true);
  const made = project.changes.filter(c => c.taskId && attempts.has(c.taskId))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  // A revision of a pass or a suggestion made a new version of it. Once that went into the video it carries the whole
  // pass with it: taking it out would take every cut of the pass out, not the one revision.
  const named = first.context.changeId ? project.changes.find(c => c.id === first.context.changeId) : undefined;
  if (named && named.state !== "approved" && made.some(c => c.state === "approved")) throw new Error("the version it made has been applied since.");
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
  const text = error instanceof Error ? error.message : String(error);
  return text.charAt(0).toLowerCase() + text.slice(1);
}
