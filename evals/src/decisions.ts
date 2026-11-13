/**
 * Per-cut review decisions for dialogue suggestions. Mirrors apps/server/src/routes/evalExport.ts so
 * engines that predate that route can still be evaluated from ordinary reads.
 */
import { planCutReview, reviewReasons, type Change, type MediaAsset, type Timeline } from "../../packages/timeline/src/index.ts";
import type { EditorDecision, Engine, ReviewChangeExport, ReviewDecisionExport } from "./engine.ts";
import { timelineRangeToSource } from "./timeline.ts";

export function editorDecision(change: Pick<Change, "state" | "restoredCuts" | "approvedSpots">, index: number): EditorDecision {
  if (change.state === "rejected") return "skipped";
  if (change.state !== "approved") return "pending";
  if (change.restoredCuts) return change.restoredCuts.includes(index) ? "skipped" : "approved";
  return change.approvedSpots ? "unknown" : "approved";
}

export function reviewExport(change: Change, base: Timeline, proposed: Timeline, media: MediaAsset[]): ReviewChangeExport | undefined {
  const review = planCutReview(base, proposed, media, change.ops, change.firstCut);
  if (!review) return undefined;
  const reasons = reviewReasons(change, review.cuts);
  const assessments = new Map(change.cutAssessments?.map(a => [a.index, a]));
  return {
    id: change.id, taskId: change.taskId, intent: change.intent, state: change.state,
    fromVersion: change.fromVersion, toVersion: change.toVersion, appliedVersion: change.appliedVersion,
    restoredCuts: change.restoredCuts, decidedBy: change.decidedBy, updatedAt: change.updatedAt, firstCut: review.firstCut,
    cuts: review.cuts.map((cut, index) => {
      const a = assessments.get(index);
      return {
        index, removed: cut.removed,
        sources: timelineRangeToSource(review.original, media, cut.removed),
        reasons: reasons[index] ?? [],
        ...(a && { assessment: { verdict: a.verdict, reason: a.reason, inspected: a.inspected } }),
        decision: editorDecision(change, index),
      };
    }),
  };
}

/** Prefer the engine's export; otherwise derive the same records from the changes and timelines. */
export async function reviewDecisions(engine: Engine, projectId: string, changes: Change[], timeline: (v: string) => Promise<Timeline>,
  media: MediaAsset[], taskId?: string): Promise<{ source: "engine" | "local"; changes: ReviewChangeExport[] }> {
  const exported: ReviewDecisionExport | undefined = await engine.reviewDecisions(projectId, taskId);
  const ids = new Set(changes.map(c => c.id));
  if (exported) return { source: "engine", changes: exported.changes.filter(c => ids.has(c.id)) };
  const out: ReviewChangeExport[] = [];
  for (const change of changes) {
    if (change.intent !== "suggestion" || !change.ops?.length) continue;
    const item = reviewExport(change, await timeline(change.fromVersion), await timeline(change.toVersion), media);
    if (item) out.push(item);
  }
  return { source: "local", changes: out };
}
