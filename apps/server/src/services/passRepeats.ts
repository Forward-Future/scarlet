import { taskDialogueOperation, RepeatAuditRequest, type Task } from "@scarlet/shared";
import { makeTimeMap, TimeRange } from "@scarlet/timeline";
import type { z } from "zod/v3";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { auditDialogueAudio } from "./dialogueRepeatAudit.js";
import { prepareCutReview } from "./changes.js";
import { appendTaskEvent, editsDialogue, saveTask } from "./tasks.js";
import { resolveTimeline } from "./timeline.js";
import { runAttempts, runRoot } from "./runAttempts.js";

export async function readPassRepeats(ctx: Ctx, task: Task, request: z.output<typeof RepeatAuditRequest>, signal: AbortSignal) {
  if (taskDialogueOperation(task) === "local-pauses") throw badRequest("local_pauses", "This request only tightens local pauses.");
  const { projectId } = task;
  // A check that keeps nothing reads the edit as it is now. A pass named a version a save or a review had moved on from
  // 27 times in eight runs, and each refusal cost a round trip to learn the version (2026-11-15). Kept repeats are
  // decisions about what the pass heard on the version it names, so they still need that version.
  const head = ctx.repos.projects.header(projectId)?.head;
  const named = request.version;
  if (!request.keep.length && head && head !== named) request = { ...request, version: head };
  function current() {
    const owner = ctx.repos.tasks.get(task.id);
    if (!owner || owner.startedAt !== task.startedAt || (request.startedAt && owner.startedAt !== request.startedAt) ||
        !editsDialogue(owner.kind) || !["claimed", "running"].includes(owner.state))
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
  // What the picture does is read by Scarlet's MCP server on the version it names. Read on another, it would count
  // findings this playback doesn't have.
  if (request.pictures && request.pictures.version !== tl.version) throw conflict("cut_changed", "Read the current edit and check its audio again.");
  const pictureFindings = request.pictures?.findings ?? [];
  const check = await ctx.track(auditDialogueAudio(ctx, project, tl, task, AbortSignal.any([signal, ctx.projectSignal(projectId)]), request.silencesFrom), projectId);
  return ctx.db.transaction(() => {
    const owner = current();
    const root = runRoot(owner);
    const run = runAttempts(projectId, root);
    const attempts = ctx.repos.tasks.select(run.where, run.params);
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
    // A pending ripple already covers this hearing. It belongs to the pass's review.
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
    if (request.keep.some(k => !check.repeats.some(r => r.id === k.id) && !check.silences.some(s => s.id === k.id) && !check.fragments.some(f => f.id === k.id) &&
        !pictureFindings.some(p => p.id === k.id)))
      throw badRequest("unknown_repeat", "A kept id must match a repeat, a silence, a divided sentence or a picture found on this version.");
    if (request.keep.length) {
      const fresh = request.keep.filter(k => !kept.has(k.id));
      if (fresh.length) appendTaskEvent(ctx, owner, { type: "log", text: "", data: { kind: "repeat_kept", version: tl.version,
        ids: fresh.map(k => k.id), decisions: fresh } });
      for (const k of fresh) kept.add(k.id);
    }
    const overlaps = (word: TimeRange, ranges: TimeRange[]) => ranges.some(p => p.start < word.end && p.end > word.start);
    // The proposal lives on the picture frame grid. Its first or last speech frame can straddle that grid.
    const frame = 1 / project.settings.fps;
    const staged = check.repeats.filter(r => [r.first, r.second].some(w => stagedRanges.some(p =>
      p.start < w.end && p.end > w.start && p.start <= w.start + frame && p.end >= w.end - frame)));
    const pending = new Set(staged.map(r => r.id));
    const repeats = check.repeats.flatMap(r => {
      if (kept.has(r.id) || pending.has(r.id)) return [];
      const first = overlaps(r.first, protectedRanges), second = overlaps(r.second, protectedRanges);
      if (first && second) return [];
      return [{ ...r, occurrences: { first: first ? undefined : r.occurrences.first, second: second ? undefined : r.occurrences.second },
        ...(first || second ? { protected: first ? "first" : "second" } : {}) }];
    });
    // A wordless stretch the pass kept on purpose, or one a cut staged for review takes out, is settled.
    const within = (s: TimeRange, ranges: TimeRange[]) => ranges.some(p => p.start <= s.start + frame && p.end >= s.end - frame);
    const silences = check.silences.filter(s => !kept.has(s.id) && !within(s, protectedRanges) &&
      !stagedRanges.some(p => p.start < s.end - frame && p.end > s.start + frame));
    // A count and a range per recording, however long the pass: timeline_join_audit reads the range a page at a time.
    // One inside a range staged for review isn't played yet, as below.
    const unheardJoins = check.unheardJoins.flatMap(({ at, ...u }) => {
      const times = [...at].filter(t => !stagedRanges.some(r => r.start - frame <= t && t <= r.end + frame));
      return times.length ? [{ ...u, joins: times.length, from: Math.min(...times), to: Math.max(...times) }] : [];
    });
    // A join that divides a sentence is settled once the pass has read it and kept it with its reason. One a cut
    // staged for review makes isn't played yet.
    const fragments = check.fragments.filter(f => !kept.has(f.id) && !stagedRanges.some(r => r.start - frame <= f.at && f.at <= r.end + frame));
    const unavailable = check.unavailable.map(u => `Couldn’t check ${u.mediaId}: ${u.reason}`);
    const last = owner.repeatAudit;
    // A picture finding is settled once the pass keeps it with its reason, or changes the picture there.
    const pictures = pictureFindings.filter(p => !kept.has(p.id));
    const remaining = repeats.length + silences.length + fragments.length + pictures.length;
    const returns = last?.version === tl.version && (last.remaining === undefined || remaining >= last.remaining) ? last.returns : 0;
    // A join inside a range staged for review isn't played yet; the review reads it.
    const joins = check.joins.filter(j => !stagedRanges.some(r => r.start - frame <= j.at && j.at <= r.end + frame));
    const noFindings = !check.repeats.length && !check.silences.length && !check.fragments.length && !joins.length && !unheardJoins.length && !unavailable.length &&
      !pictureFindings.length;
    // How many times in all the pass went back for this check, and when it last did, go on whatever this reading finds.
    saveTask(ctx, { ...owner, state: "running", repeatAudit: { version: tl.version, remaining, unavailable, returns, noFindings,
      ...(last?.totalReturns !== undefined && { totalReturns: last.totalReturns }), ...(last?.queuedAt && { queuedAt: last.queuedAt }) } });
    return { version: tl.version, ...(named !== tl.version && { readInsteadOf: named }), heard: check.repeats.length, staged: staged.length, remaining,
      // One offset pages the repeats and the divided sentences together: a pass asked for the next pages of both at once.
      repeats: repeats.slice(request.offset, request.offset + 25),
      ...(request.offset + 25 < Math.max(repeats.length, fragments.length) && { nextOffset: request.offset + 25 }),
      ...(silences.length && { silences: silences.slice(0, 25) }),
      ...(fragments.length && { fragments: fragments.slice(request.offset, request.offset + 25) }),
      ...(pictures.length && { pictures: pictures.slice(0, 25) }),
      ...(check.unavailable.length && { unavailable: check.unavailable }),
      ...(check.joins.length && { joins }), ...(unheardJoins.length && { unheardJoins }) };
  }, "immediate")();
}
