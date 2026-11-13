import type { Change, ChangeState } from "@scarlet/timeline";
import type { Render, Task } from "./api.js";

export function beginRevision(change: Change, task: Task): Change {
  return { ...change, state: "revising", revisionFrom: change.state === "revising" ? change.revisionFrom :
    { state: change.state, error: change.error, taskId: task.id } };
}

/** Previews can finish while a proposal is rejected or being revised. */
export function restoredReviewState(change: Change, state: ChangeState | undefined, renderState: (id: string) => Render["state"] | undefined): ChangeState {
  if (state && state !== "rendering" && state !== "proposed") return state;
  const states = change.renders.flatMap(pair => [pair.before, pair.after]).filter((id): id is string => !!id).map(renderState);
  if (change.error || states.some(s => !s || s === "failed" || s === "cancelled")) return "failed";
  return states.every(s => s === "done") ? "ready" : "rendering";
}
