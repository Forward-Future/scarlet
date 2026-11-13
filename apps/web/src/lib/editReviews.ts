import type { EditRef, EditReviewRequest, ThreadEdit } from "@scarlet/shared";
import type { AgentContext } from "../stores/ui";
import { api } from "./client";

/** One identity across revisions and places on the same row, even if their timeline order changes. */
export function originalReviewRef(row: readonly ThreadEdit[]): EditRef {
  let first = row[0]!.previous[0] ?? row[0]!;
  for (const edit of row) {
    const ref = edit.previous[0] ?? edit;
    if (ref.changeId < first.changeId || (ref.changeId === first.changeId && ref.spot < first.spot)) first = ref;
  }
  return { changeId: first.changeId, spot: first.spot };
}

/** The engine's editorial request receives only the editor's actual target. */
export function requestPosition({ reviewRef: _local, ...position }: AgentContext) {
  return position;
}

export function recordEditReview(projectId: string, target: AgentContext | null | undefined, decision: EditReviewRequest["decision"]) {
  if (!target?.changeId || target.editIndex === undefined) return;
  // A draft saved before review telemetry still has its original local edit coordinates.
  const { changeId, spot } = target.reviewRef ?? { changeId: target.changeId, spot: target.editIndex };
  void api.recordEditReview(projectId, { changeId, spot, decision }).catch(() => {});
}
