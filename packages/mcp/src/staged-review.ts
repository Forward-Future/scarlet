import type { Change } from "@scarlet/timeline";

/** The latest staged pass of a run, and how many of its cuts still have no recommendation. */
export interface StagedReview { changeId: string; total: number; unchecked: number }
export interface StagedReviewState {
  stagedReview: Promise<StagedReview | undefined> | undefined;
  stageWithoutAppliedCuts: string | undefined;
}

/** How many of a pass's cuts have a recommendation that isn't provisional. */
export const assessedCuts = (change: Change) => change.cutAssessments?.filter(a => !a.provisional).length ?? 0;

/** dialogue_scan's note while staged cuts wait for a recommendation, which the editor needs before they can call them. */
export function reviewReminderText({ changeId, total, unchecked }: StagedReview) {
  const cuts = unchecked === 1 ? "1 cut" : `${unchecked} cuts`;
  return `${cuts} you staged on ${changeId} ${unchecked === 1 ? "has" : "have"} no recommendation yet${unchecked < total ? ` (of ${total})` : ""}. The editor sees a staged cut as a call only once it has one, so they have nothing to decide while you read on. Record them with dialogue_review_inspect and dialogue_review_save, then continue.`;
}
