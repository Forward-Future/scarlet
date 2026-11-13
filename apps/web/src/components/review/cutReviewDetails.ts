import { cutSummary, dialogueReceipt, type Change, type TimeRange } from "@scarlet/timeline";
import { lengthLabel, plural } from "../../lib/format";
import { editConfirmation } from "../../lib/taskActivity";

export { cutSummary, reviewReasons } from "@scarlet/timeline";

export interface CutAudition { range: TimeRange; excerpt?: TimeRange }

/** Describe the selection that actually landed, even if the proposal included more. */
export function appliedEditSummary(change: Change): string {
  const receipt = dialogueReceipt(change);
  if (receipt) return receipt;
  if (change.appliedReview) {
    const { joins } = change.appliedReview;
    if (!joins.length) return "Kept all the reviewed footage.";
    const seconds = joins.reduce((sum, { removed }) => sum + removed.end - removed.start, 0);
    return `Removed ${lengthLabel(seconds)} of footage in ${plural(joins.length, "cut")}.`;
  }
  const summary = cutSummary(change.description);
  if (change.approvedSpots) {
    const scope = `Applied ${change.approvedSpots.length} of ${change.ranges.length} proposed spots`;
    return summary.trim() ? `${scope} from “${summary.trim().replace(/\.$/, "")}”.` : scope + ".";
  }
  if (summary !== change.description) return "Trimmed dialogue from the timeline.";
  return (editConfirmation(summary) ?? summary.trim()) || "No description was saved for this edit.";
}
