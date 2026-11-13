import type { Change, ChangeState } from "@scarlet/timeline";
import { restoredReviewState, type Task } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { now } from "../db.js";

export { beginRevision } from "@scarlet/shared";

/** Renders can finish while a proposal is rejected or being revised. */
export function resumeReviewState(ctx: Ctx, change: Change, state?: ChangeState): ChangeState {
  return restoredReviewState(change, state, id => ctx.repos.renders.get(id)?.state);
}

/** Caller holds the write lock. Old revisions did not record a reliable prior state. */
export function proposalAfterRevisions(ctx: Ctx, change: Change): Change {
  if (change.state !== "revising" || !change.revisionFrom) return change;
  const { taskId, state, error } = change.revisionFrom;
  const pendingOrReplaced = ctx.db.prepare(`WITH revisions AS (
    SELECT id, state FROM tasks WHERE project_id = ? AND kind = 'revise' AND json_extract(json, '$.context.changeId') = ?
      AND rowid >= (SELECT rowid FROM tasks WHERE id = ?)
  ) SELECT 1 FROM revisions WHERE state IN ('queued','claimed','running','waiting_for_user')
    UNION ALL SELECT 1 FROM changes WHERE project_id = ? AND json_extract(json, '$.taskId') IN (SELECT id FROM revisions)
    LIMIT 1`).get(change.projectId, change.id, taskId, change.projectId);
  if (pendingOrReplaced) return change;
  const restored = { ...change, error, revisionFrom: undefined, updatedAt: now() };
  return { ...restored, state: resumeReviewState(ctx, restored, state) };
}

export function restoreUnreplacedProposal(ctx: Ctx, task: Task) {
  const change = task.context.changeId && ctx.repos.changes.get(task.context.changeId);
  if (!change || change.projectId !== task.projectId) return;
  const restored = proposalAfterRevisions(ctx, change);
  if (restored === change) return;
  const saved = ctx.repos.changes.put(restored);
  ctx.bus.publish({ type: "change.updated", projectId: saved.projectId, change: saved });
}
