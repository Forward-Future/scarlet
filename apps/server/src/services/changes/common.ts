import { callNumbers, type AgentId, type Task, type User } from "@scarlet/shared";
import type { Author, Change, Project, Timeline } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { now } from "../../db.js";
import { parseAssignTo } from "../tasks.js";
import { resolveTimeline } from "../timeline.js";

export const REVISED = "Replaced by a later revision of the same cut.";
export const CARRIED = "Carried into a later part of the same dialogue pass.";
export const STALE_SAVE = "The timeline changed while the edit was running.";
export const SAVED_AGAIN = "Scarlet saved this work again on the video as it was by then.";
export const ACTIVE_TASK = new Set(["queued", "claimed", "running", "waiting_for_user"]);

/** A staged cut that a later cut of the same save takes part of has left this much of its footage playing: a syllable or more. */
export const LEFT_OF_STAGED_CUT = 0.15;

/**
 * What to do with a finding about a call the editor holds. The same pass asked "Scarlet has locked edit 5 for your
 * review. May I revise it…?" about a call that already waited on the editor's Approve, Skip and Revise (2026-11-16).
 */
export const CALL_WITH_EDITOR = "The editor decides this call with Approve, Skip or Revise, so don’t ask them about it with task_question. "
  + "If they should know something before deciding, add it to the call’s note with dialogue_review_save and amend:true on that cut.";

export function authorFor(user: User, override?: Partial<Author>): Author {
  const base: Author = { type: "human", id: user.id, name: user.name };
  return { ...base, ...Object.fromEntries(Object.entries(override ?? {}).filter(([, v]) => v !== undefined)) } as Author;
}

export function saveChange(ctx: Ctx, change: Change): Change {
  const saved = ctx.repos.changes.put({ ...change, updatedAt: now() });
  ctx.bus.publish({ type: "change.updated", projectId: saved.projectId, change: saved });
  // A dialogue pass's staged cuts hold the project's other requests until the editor has decided them. A host waiting
  // for work hears of a request only when one is queued, so it is told when the pass stops holding one too: it would
  // otherwise find out at its next ask, up to 25 s later (2026-11-08: a request began 17 s after the last call).
  if (saved.intent === "suggestion" && saved.cutReasons?.length && saved.state !== "ready" && saved.state !== "revising") {
    const [held] = ctx.repos.tasks.select("project_id = ? AND state = 'queued' AND kind != 'transcribe'", [saved.projectId], "created_at ASC, rowid ASC LIMIT 1");
    if (held) ctx.bus.taskQueued({ taskId: held.id, projectId: saved.projectId });
  }
  return saved;
}

/** Close a change that another one has taken the place of. */
export function putAway(ctx: Ctx, change: Change, rejectReason: string, replacedBy: string): Change {
  return saveChange(ctx, { ...change, state: "rejected", rejectedFrom: change.state, rejectReason, replacedBy });
}

/** The thread a task belongs to (its own id when it started one). */
export function threadOf(task: Task): string {
  return task.context.threadId ?? task.id;
}

export function threadOfChange(ctx: Ctx, change: Change): string {
  if (change.threadId) return change.threadId;
  const task = change.taskId ? ctx.repos.tasks.get(change.taskId) : null;
  return task ? threadOf(task) : change.id;
}

/** The task now doing a run's work: a run interrupted when Scarlet quit carries on under a new task. */
export function latestAttempt(ctx: Ctx, taskId: string | undefined): Task | undefined {
  let task = taskId ? ctx.repos.tasks.get(taskId) ?? undefined : undefined;
  for (let hops = 0; task?.retryTaskId && hops < 100; hops++) {
    const next = ctx.repos.tasks.get(task.retryTaskId);
    if (!next) break;
    task = next;
  }
  return task;
}

/** The version a request's selection was made on, when that isn't the one being edited. */
export function anchorOriginal(ctx: Ctx, project: Pick<Project, "id" | "head">, anchor: Task["context"], base: Timeline): Timeline | undefined {
  return anchor.version && anchor.version !== "head" && anchor.version !== base.version ? resolveTimeline(ctx, project, anchor.version) : undefined;
}

/** The agent and model that made a change, to run its next version. An author Scarlet can't place runs on the default agent. */
export function authorsAgent(ctx: Ctx, author: Author): { agent: AgentId; model?: string } {
  try {
    return { ...parseAssignTo(author.id, ctx.settings().defaultAgent), model: author.model };
  } catch {
    return { agent: ctx.settings().defaultAgent, model: undefined };
  }
}

/**
 * A staged cut as the engine's tools number it (its index, from 0) and, once it is a call, as the editor knows it
 * ("Cut 4"). A pass told only "cut 4 … is with the editor" asked the editor about "edit 5", while the window called it
 * Cut 4 (2026-11-16).
 */
export function editorsCut(change: Change, index: number): string {
  const n = callNumbers(change, 0, false).get(index);
  return n ? `cut ${index} (the editor’s “Cut ${n}”)` : `cut ${index}`;
}

export const capitalized = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
