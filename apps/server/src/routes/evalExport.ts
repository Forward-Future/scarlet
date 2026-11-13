import { Hono } from "hono";
import { clipDuration, planCutReview, reviewReasons, type Change, type MediaClip, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { resolveTimeline } from "../services/timeline.js";
import { requireProject } from "./util.js";

type Decision = "approved" | "skipped" | "pending" | "unknown";

function decision(change: Change, index: number): Decision {
  if (change.state === "rejected") return "skipped";
  if (change.state !== "approved") return "pending";
  if (change.restoredCuts) return change.restoredCuts.includes(index) ? "skipped" : "approved";
  return change.approvedSpots ? "unknown" : "approved";
}

/** Source seconds of each recording the viewer hears during a timeline range. */
function sources(project: Project, tl: Timeline, range: TimeRange) {
  const audible = new Set(project.media.filter(m => m.kind === "audio" || (m.kind === "video" && m.hasAudio !== false)).map(m => m.id));
  return tl.tracks.filter(t => t.kind !== "caption" && !t.muted).flatMap(t => t.clips)
    .filter((c): c is MediaClip => c.kind === "media" && c.enabled && c.volume > 0 && audible.has(c.mediaId))
    .flatMap(c => {
      const start = Math.max(range.start, c.timelineIn), end = Math.min(range.end, c.timelineIn + clipDuration(c));
      return end - start > 1e-6 ? [{ mediaId: c.mediaId, start: c.sourceIn + (start - c.timelineIn) * c.speed, end: c.sourceIn + (end - c.timelineIn) * c.speed }] : [];
    });
}

/**
 * Read-only export of the editor's approve/skip decisions on dialogue review cuts, with the AI's
 * second-pass recommendation and the source range of each cut. Used by the offline evals (evals/).
 * Pending choices staged in the review UI are not stored by the engine and appear as "pending".
 */
export function evalExportRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  r.get("/projects/:id/review-decisions", c => {
    const project = requireProject(ctx, c.req.param("id"));
    const taskId = c.req.query("taskId");
    const changes = ctx.repos.changes.select(
      "project_id = ? AND json_extract(json, '$.intent') = 'suggestion'" + (taskId ? " AND json_extract(json, '$.taskId') = ?" : ""),
      taskId ? [project.id, taskId] : [project.id], "created_at ASC");
    const exported = changes.flatMap(change => {
      let base: Timeline, proposed: Timeline;
      try {
        base = resolveTimeline(ctx, project, change.fromVersion);
        proposed = resolveTimeline(ctx, project, change.toVersion);
      } catch {
        return [];
      }
      // Compute the review plan without storing the reconstructed original of a first cut.
      const review = planCutReview(base, proposed, project.media, change.ops, change.firstCut);
      if (!review) return [];
      const reasons = reviewReasons(change, review.cuts);
      const assessments = new Map(change.cutAssessments?.map(a => [a.index, a]));
      return [{
        id: change.id, taskId: change.taskId, intent: change.intent, state: change.state,
        fromVersion: change.fromVersion, toVersion: change.toVersion, appliedVersion: change.appliedVersion,
        restoredCuts: change.restoredCuts, decidedBy: change.decidedBy, updatedAt: change.updatedAt, firstCut: review.firstCut,
        cuts: review.cuts.map((cut, index) => {
          const a = assessments.get(index);
          return { index, removed: cut.removed, sources: sources(project, review.original, cut.removed), reasons: reasons[index] ?? [],
            ...(a && { assessment: { verdict: a.verdict, reason: a.reason, inspected: a.inspected } }), decision: decision(change, index) };
        }),
      }];
    });
    return c.json({ projectId: project.id, changes: exported });
  });

  return r;
}
