import { taskDialogueOperation, RepeatAuditRequest, type Task } from "@scarlet/shared";
import { makeTimeMap, TimeRange } from "@scarlet/timeline";
import type { z } from "zod/v3";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { auditDialogueAudio } from "./dialogueRepeatAudit.js";
import { prepareCutReview } from "./changes.js";
import { appendTaskEvent, saveTask } from "./tasks.js";
import { resolveTimeline } from "./timeline.js";

export async function readPassRepeats(ctx: Ctx, task: Task, request: z.output<typeof RepeatAuditRequest>, signal: AbortSignal) {
  if (taskDialogueOperation(task) === "local-pauses") throw badRequest("local_pauses", "This request only tightens local pauses.");
  const { projectId } = task;
  function current() {
    const owner = ctx.repos.tasks.get(task.id);
    if (!owner || owner.startedAt !== task.startedAt || (request.startedAt && owner.startedAt !== request.startedAt) ||
        !["edit", "revise", "note"].includes(owner.kind) || !["claimed", "running"].includes(owner.state))
      throw conflict("edit_inactive", "This edit is no longer running.");
    const project = ctx.repos.projects.header(projectId);
    if (!project || project.head !== request.version || (owner.context.branch && owner.context.branch !== project.branch))
      throw conflict("cut_changed", "Read the current edit and check its audio again.");
    return owner;
  }
  current();
  const project = ctx.repos.projects.get(projectId);
  if (!project) throw notFound("project");
  const tl = resolveTimeline(ctx, project, request.version);
  const check = await ctx.track(auditDialogueAudio(ctx, project, tl, task, AbortSignal.any([signal, ctx.projectSignal(projectId)])));
  return ctx.db.transaction(() => {
    const owner = current();
    const root = owner.resumeRootId ?? owner.id;
    const attempts = ctx.repos.tasks.select("project_id = ? AND (id = ? OR json_extract(json,'$.resumeRootId') = ?)", [projectId, root, root]);
    const ids = JSON.stringify(attempts.map(t => t.id));
    const rows = ctx.db.prepare(`SELECT json_extract(json,'$.data') AS data FROM task_events
      WHERE task_id IN (SELECT value FROM json_each(?)) AND json_extract(json,'$.data.kind') IN ('dialogue_preserved','repeat_kept')`).all(ids) as { data: string }[];
    const kept = new Set<string>();
    const protectedRanges: TimeRange[] = [];
    const stagedRanges: TimeRange[] = [];
    const mapRanges = (version: string, ranges: TimeRange[], into: TimeRange[]) => {
      if (version === tl.version) { into.push(...ranges); return; }
      const earlier = ctx.repos.versions.get(projectId, version);
      if (!earlier) return;
      const map = makeTimeMap(earlier.timeline, tl, project.settings.fps);
      for (const r of ranges) {
        const start = map(r.start, "right"), end = map(r.end, "left");
        if (start !== null && end !== null && end > start) into.push({ start, end });
      }
    };
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (data.kind === "repeat_kept" && Array.isArray(data.ids)) for (const id of data.ids) kept.add(id);
      if (data.kind === "dialogue_preserved" && typeof data.version === "string") {
        const ranges = TimeRange.array().safeParse(data.ranges);
        if (ranges.success) mapRanges(data.version, ranges.data, protectedRanges);
      }
    }
    // A pending ripple already covers this hearing. It belongs to the pass's review and obeys the retake setting there.
    const changes = ctx.repos.changes.select(`project_id = ? AND (json_extract(json,'$.taskId') IN (SELECT value FROM json_each(?)) OR json_extract(json,'$.threadId') = ?)
      AND (state = 'ready' OR json_array_length(json_extract(json,'$.restoredCuts')) > 0)`, [projectId, ids, owner.context.threadId ?? root]);
    for (const change of changes) {
      if (change.state === "ready") {
        const ranges = (change.ops ?? []).flatMap(op => {
          const parsed = op.op === "rippleDelete" && TimeRange.safeParse(op);
          return parsed && parsed.success ? [parsed.data] : [];
        });
        mapRanges(change.fromVersion, ranges, stagedRanges);
      } else if (change.restoredCuts?.length) {
        const { review } = prepareCutReview(ctx, change);
        if (review) mapRanges(review.original.version, change.restoredCuts.flatMap(i => review.cuts[i]?.removed ?? []), protectedRanges);
      }
    }
    if (request.keep.some(k => !check.repeats.some(r => r.id === k.id))) throw badRequest("unknown_repeat", "A kept id must match a repeat heard on this version.");
    if (request.keep.length) {
      const fresh = request.keep.filter(k => !kept.has(k.id));
      if (fresh.length) appendTaskEvent(ctx, owner, { type: "log", text: "", data: { kind: "repeat_kept", version: tl.version,
        ids: fresh.map(k => k.id), decisions: fresh } });
      for (const k of fresh) kept.add(k.id);
    }
    const retakes = ctx.settings().dialogue.aiCuts.retake;
    const off = retakes === "off";
    const overlaps = (word: TimeRange, ranges: TimeRange[]) => ranges.some(p => p.start < word.end && p.end > word.start);
    // The proposal lives on the picture frame grid. Its first or last speech frame can straddle that grid.
    const frame = 1 / project.settings.fps;
    const staged = check.repeats.filter(r => [r.first, r.second].some(w => stagedRanges.some(p =>
      p.start < w.end && p.end > w.start && p.start <= w.start + frame && p.end >= w.end - frame)));
    const pending = new Set(staged.map(r => r.id));
    const repeats = check.repeats.flatMap(r => {
      if (off || kept.has(r.id) || pending.has(r.id)) return [];
      const first = overlaps(r.first, protectedRanges), second = overlaps(r.second, protectedRanges);
      if (first && second) return [];
      return [{ ...r, occurrences: { first: first ? undefined : r.occurrences.first, second: second ? undefined : r.occurrences.second },
        ...(first || second ? { protected: first ? "first" : "second" } : {}) }];
    });
    const unavailable = check.unavailable.map(u => `Couldn’t check ${u.mediaId}: ${u.reason}`);
    const last = owner.repeatAudit;
    const returns = last?.version === tl.version && (last.remaining === undefined || repeats.length >= last.remaining) ? last.returns : 0;
    // A join inside a range staged for review isn't played yet; the review reads it.
    const joins = check.joins.filter(j => !stagedRanges.some(r => r.start - frame <= j.at && j.at <= r.end + frame));
    const noFindings = !check.repeats.length && !joins.length && !unavailable.length;
    saveTask(ctx, { ...owner, state: "running", repeatAudit: { version: tl.version, remaining: repeats.length, retakes, unavailable, returns, noFindings } });
    return { version: tl.version, heard: check.repeats.length, staged: staged.length, remaining: repeats.length,
      repeats: repeats.slice(request.offset, request.offset + 25), ...(request.offset + 25 < repeats.length && { nextOffset: request.offset + 25 }),
      ...(off && { retakes: "off" }), ...(check.unavailable.length && { unavailable: check.unavailable }),
      ...(check.joins.length && { joins }) };
  }, "immediate")();
}
