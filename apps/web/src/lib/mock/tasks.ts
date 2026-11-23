import { AGENT_LABEL, restoredReviewState } from "@scarlet/shared";
import type { Task } from "@scarlet/shared";
import type { Author, Change } from "@scarlet/timeline";
import type { MockDb } from "./fixtures";
import { isFinished, now } from "./util";

/** The agent a demo run speaks as, on what it proposes and the skills it writes. */
export function agentAuthor(task: Task): Author {
  return { type: "agent", id: task.agent, name: AGENT_LABEL[task.agent], model: task.model };
}

/**
 * Puts a proposal back as it was before a revision, once every revision of it has stopped without proposing anything.
 * Returns whether it did.
 */
export function restoreUnreplacedProposal(db: MockDb, change: Change): boolean {
  const prior = change.revisionFrom;
  if (change.state !== "revising" || !prior) return false;
  // The demo inserts new tasks at the front. Ignore revisions from earlier attempts.
  const first = db.tasks.findIndex(t => t.id === prior.taskId);
  if (first < 0) return false;
  const revisions = db.tasks.slice(0, first + 1).filter(t => t.projectId === change.projectId && t.kind === "revise" && t.context.changeId === change.id);
  if (revisions.some(t => !isFinished(t.state))) return false;
  const ids = new Set(revisions.map(t => t.id));
  if (db.changes.some(c => c.projectId === change.projectId && c.taskId && ids.has(c.taskId))) return false;
  change.error = prior.error;
  change.state = restoredReviewState(change, prior.state, id => db.renders.find(r => r.id === id)?.state);
  change.revisionFrom = undefined;
  change.updatedAt = now();
  return true;
}
