import type { Task } from "@scarlet/shared";
import { LEFT_OUT_READING, leftOutJoins, type Change, type Project } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { errorMessage } from "../../util.js";
import { runAttemptIds, runRoot } from "../runAttempts.js";
import { resolveTimeline, storeVersion } from "../timeline.js";
import { putAway, SAVED_AGAIN, STALE_SAVE, threadOfChange } from "./common.js";
import { submitDialogueCuts } from "./dialoguePass.js";

/**
 * A dialogue pass is applied once. Another version of it that still waits is one a revision left behind: the edit has
 * moved past it, so its calls can't be made, and left open it asks the editor for them again and holds the next request
 * (2026-11-09). It is put away as replaced by the version that was applied.
 */
export function retireOtherVersions(ctx: Ctx, applied: Change): Change[] {
  if (applied.intent !== "suggestion" || !applied.cutReasons?.length) return [];
  const thread = threadOfChange(ctx, applied);
  // A version a finished revision replaced stays as it is: it holds nothing, and the applied pass's history reads through it.
  return ctx.repos.changes.select(`project_id = ? AND id != ? AND json_extract(json, '$.intent') = 'suggestion'
    AND json_extract(json, '$.fromVersion') = ? AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) > 0
    AND (state = 'ready' OR (state = 'revising' AND NOT EXISTS (SELECT 1 FROM changes made JOIN tasks rv ON rv.id = json_extract(made.json, '$.taskId')
      WHERE made.project_id = changes.project_id AND rv.kind = 'revise' AND json_extract(rv.json, '$.context.changeId') = changes.id)))`,
    [applied.projectId, applied.id, applied.fromVersion])
    .filter(other => threadOfChange(ctx, other) === thread)
    .map(other => putAway(ctx, other, "Another version of this pass was applied.", applied.id));
}

/**
 * The footage an applied change left out as it built its version, with a version that plays it. A change that only
 * took footage out as cuts says so itself, and nothing is read for it. Never keeps a change from being applied.
 */
export function leftOutOf(ctx: Ctx, project: Omit<Project, "media">, change: Change): Change["leftOut"] {
  if (!change.ops?.length || change.cutReasons?.length || change.firstCut) return undefined;
  if (change.ops.every(op => op.op === "rippleDelete")) return undefined;
  try {
    const found = leftOutJoins(resolveTimeline(ctx, project, change.fromVersion), resolveTimeline(ctx, project, change.toVersion), project.settings.fps);
    if (!found) return { joins: [] };
    const original = storeVersion(ctx, project.id, found.original, { parent: change.fromVersion, description: "Footage left out, for review" });
    return { version: original.version, joins: found.joins, reading: LEFT_OUT_READING };
  } catch (err) {
    ctx.log(`[edit] couldn’t read the footage ${change.id} left out: ${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * Read the footage left out by changes an earlier build applied without looking: a video built from the pieces to
 * keep showed none of what it left out as cuts (2026-11-12). Joins an earlier reading found are read again: it took a
 * screen and a camera inset laid over a camera already cut for footage left out, and called every framed demo a Cut
 * (2026-11-20). Runs once as Scarlet starts.
 */
export function recordLeftOutFootage(ctx: Ctx): void {
  const stale = (ctx.db.prepare(`SELECT json FROM changes INDEXED BY changes_left_out_reread WHERE state = 'approved'
    AND json_array_length(json_extract(json, '$.leftOut.joins')) > 0 AND coalesce(json_extract(json, '$.leftOut.reading'), 1) < 2
    ORDER BY created_at`).all() as { json: string }[]).map(row => ctx.repos.changes.parse(row.json));
  for (const change of stale) {
    const project = ctx.repos.projects.header(change.projectId);
    const leftOut = project && leftOutOf(ctx, project, change);
    if (!leftOut) continue;
    ctx.repos.changes.put({ ...change, leftOut });
    const was = change.leftOut!.joins.length;
    if (leftOut.joins.length !== was) ctx.log(`[edit] ${change.id} read again: ${was} stretches of footage were taken for left out, ${leftOut.joins.length} are`);
  }
  // The index holds only the changes still to read. Left to choose, SQLite would read every applied change by its state.
  const built = (ctx.db.prepare(`SELECT json FROM changes INDEXED BY changes_left_out_unread WHERE state = 'approved'
    AND json_extract(json, '$.leftOut') IS NULL AND json_array_length(coalesce(json_extract(json, '$.ops'), '[]')) > 0
    AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) = 0 ORDER BY created_at`).all() as { json: string }[])
    .map(row => ctx.repos.changes.parse(row.json));
  for (const change of built) {
    const project = ctx.repos.projects.header(change.projectId);
    // A first cut, or a change that only rippled footage out, has nothing to read. That is saved as well, so the
    // change isn't picked again at the next start.
    const nothing = change.firstCut || change.ops!.every(op => op.op === "rippleDelete");
    const leftOut = nothing ? { joins: [] } : project && leftOutOf(ctx, project, change);
    if (!leftOut) continue;
    ctx.repos.changes.put({ ...change, leftOut });
    if (leftOut.joins.length) ctx.log(`[edit] ${change.id} left out ${leftOut.joins.length} stretches of footage as it built the video: now shown as cuts`);
  }
}

/** Put away the versions of applied passes that an earlier build left waiting. Runs once as Scarlet starts. */
export function retireLeftoverPasses(ctx: Ctx): void {
  ctx.db.transaction(() => {
    // Only a project with a proposal still waiting can have one: its applied edits alone are read.
    const applied = ctx.repos.changes.select(`state = 'approved' AND project_id IN (SELECT project_id FROM changes WHERE state IN ('ready','revising'))
      AND json_extract(json, '$.intent') = 'suggestion' AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) > 0 AND EXISTS (SELECT 1 FROM changes o WHERE o.project_id = changes.project_id
        AND o.state IN ('ready','revising') AND json_extract(o.json, '$.intent') = 'suggestion' AND json_extract(o.json, '$.fromVersion') = json_extract(changes.json, '$.fromVersion'))`);
    for (const pass of applied) for (const left of retireOtherVersions(ctx, pass)) ctx.log(`[edit] ${left.id} put away: ${pass.id}, another version of the same pass, was applied`);
  }, "immediate")();
}

/**
 * Gather into one review the parts of a dialogue pass that an earlier build left waiting side by side, as the pass's
 * next part would have. Each part's staged cuts waited on its own, out of sight behind the latest, and held the next
 * request for calls nobody was shown (2026-11-10). The review goes on the current edit, under the run's latest part.
 * Runs once as Scarlet starts.
 */
export function foldStrandedPasses(ctx: Ctx): void {
  const runs = new Map<string, Change[]>();
  for (const change of ctx.repos.changes.select(`state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'
      AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) > 0`)) {
    const task = change.id.endsWith("_review") && change.taskId ? ctx.repos.tasks.get(change.taskId) : undefined;
    if (!task) continue;
    const run = JSON.stringify([change.projectId, task.resumeRootId ?? task.id]);
    runs.set(run, [...runs.get(run) ?? [], change]);
  }
  const user = ctx.repos.users.primary();
  for (const parts of runs.values()) {
    if (parts.length < 2 || !user) continue;
    const latest = parts.reduce((a, b) => (b.createdAt ?? "") > (a.createdAt ?? "") ? b : a);
    const project = ctx.repos.projects.get(latest.projectId);
    // A pass made on another cut stays as it is until that cut is the one being edited.
    if (!project?.head || ctx.repos.tasks.get(latest.taskId!)?.context.branch !== project.branch) continue;
    try {
      const { changes } = submitDialogueCuts(ctx, user, project.id, { taskId: latest.taskId, fromVersion: project.head, cuts: [],
        description: latest.description, author: latest.author, noteIds: latest.noteIds }, { fold: true });
      ctx.log(`[edit] ${parts.length} parts of one dialogue pass waited side by side: folded into ${changes.map(c => c.id).join(", ")}`);
    } catch (error) {
      ctx.log(`[edit] Couldn't fold the ${parts.length} waiting parts of the dialogue pass ending in ${latest.id}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Put away a save the video had moved on from, once the run that made it has saved its work again. Such a save is left
 * waiting for the editor in case nothing follows it. A pass whose first whole-video save was refused went on to save
 * the same work on the current video, and the refused one stayed behind as a proposal no one could see or use
 * (2026-11-11). One with nothing applied after it by its run still waits.
 */
export function retireStaleSaves(ctx: Ctx, task: Task): void {
  const attempts = runAttemptIds(task.projectId, runRoot(task));
  const own = ctx.repos.changes.select(`project_id = ? AND json_extract(json, '$.taskId') IN (${attempts.sql})`, [task.projectId, ...attempts.params], "created_at ASC, rowid ASC");
  // In the order they were saved: two saves can share a millisecond, and only one made after the refused save replaces it.
  for (const [at, stale] of own.entries()) {
    if (stale.state !== "ready" || stale.intent !== "requested" || !stale.error?.startsWith(STALE_SAVE)) continue;
    const again = own.slice(at + 1).findLast(c => c.state === "approved" && c.intent === "requested");
    if (!again) continue;
    putAway(ctx, stale, SAVED_AGAIN, again.id);
    ctx.log(`[edit] ${stale.id} put away: its run saved the work again as ${again.id}`);
  }
}
