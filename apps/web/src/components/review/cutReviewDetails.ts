import { cutSummary, dialogueReceipt, type Change } from "@scarlet/timeline";
import { lengthLabel, plural } from "../../lib/format";
import { editConfirmation } from "../../lib/taskActivity";

/**
 * Where a pass that isn't in the video stands, in the chat's words. The engine's receipt for these is also what Scarlet
 * reads back in its next request, so it keeps its own wording there.
 */
const PASS_STANDS: Partial<Record<Change["state"], string>> = {
  ready: "The pass is waiting on your calls.",
  rejected: "The pass was rejected.",
  revising: "Scarlet is revising the pass.",
  failed: "Scarlet couldn’t prepare the pass.",
};

/** A dialogue pass's receipt as the chat says it: what it took out once applied, and where it stands until then. */
export function passReceipt(change: Change): string | undefined {
  const receipt = dialogueReceipt(change);
  return receipt === undefined || change.state === "approved" ? receipt : PASS_STANDS[change.state] ?? receipt;
}

/** Describe the selection that actually landed, even if the proposal included more. */
export function appliedEditSummary(change: Change): string {
  const receipt = passReceipt(change);
  if (receipt) return receipt;
  if (change.appliedReview) {
    const { joins } = change.appliedReview;
    if (!joins.length) return "Kept all the reviewed footage.";
    const seconds = joins.reduce((sum, { removed }) => sum + removed.end - removed.start, 0);
    return `Took out ${lengthLabel(seconds)} of footage in ${plural(joins.length, "cut")}.`;
  }
  const summary = cutSummary(change.description);
  if (change.approvedSpots) {
    const scope = `Applied ${change.approvedSpots.length} of ${change.ranges.length} proposed spots`;
    return summary.trim() ? `${scope} from “${summary.trim().replace(/\.$/, "")}”.` : scope + ".";
  }
  if (summary !== change.description) return "Trimmed dialogue from the timeline.";
  return (editConfirmation(summary) ?? summary.trim()) || "No description was saved for this edit.";
}
