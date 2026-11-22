import { taskDialogueOperation, type Task } from "@scarlet/shared";
import { isPublishedCall, makeStagedCutMapper, type Change, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { badRequest, conflict, HttpError } from "../../errors.js";
import { logId } from "../../logText.js";
import { runAttemptIds, runRoot } from "../runAttempts.js";
import { currentCutRanges } from "../stagedCutRecovery.js";
import { stagesCut } from "../tasks.js";
import { CALL_WITH_EDITOR, CARRIED, editorsCut, REVISED, saveChange } from "./common.js";
import { prepareCutReview } from "./cutReview.js";

// A resumed run still owns its earlier parts. A cut the editor sent back can be in a successor made by its own task.
// Walk from each linked id. Removing column affinity keeps JSON string references indexable.
export function dialogueParts(projectId: string, rootId: string) {
  const attempts = runAttemptIds(projectId, rootId);
  const ids = `WITH RECURSIVE parts(id) AS (
    SELECT id FROM changes WHERE project_id = ? AND json_extract(json, '$.taskId') IN (${attempts.sql})
    UNION SELECT c.id FROM parts CROSS JOIN tasks t ON json_extract(t.json, '$.context.changeId') = +parts.id
      CROSS JOIN changes c ON json_extract(c.json, '$.taskId') = +t.id
      WHERE c.project_id = ? AND t.project_id = ? AND json_extract(t.json, '$.context.cutIndex') IS NOT NULL
    UNION SELECT json_extract(c.json, '$.replacedBy') FROM parts JOIN changes c ON c.id = parts.id
      WHERE json_extract(c.json, '$.rejectReason') = ? AND json_extract(c.json, '$.replacedBy') IS NOT NULL
  ) SELECT id FROM parts`;
  // The first parameter is the caller's own `project_id = ?`, which comes before these ids in each query.
  return { ids, args: [projectId, projectId, ...attempts.params, projectId, projectId, REVISED] };
}

/**
 * The pass that holds a named pass's staged cuts now that revisions have replaced the named one. A request about one
 * cut names the pass as it stood when the editor sent it, and each revision ahead of it in the queue makes a new pass.
 * A revision keeps every cut's place in the list, so the request's cut has the same index in the pass returned.
 * Undefined when nothing that replaced the named pass waits for the editor.
 */
export function revisedPass(ctx: Ctx, named: Change, stopAt?: string): Change | undefined {
  const seen = new Set([named.id]);
  let waiting: Change | undefined;
  let carried: Change | undefined;
  for (const from = [named]; from.length;) {
    const at = from.pop()!;
    // What replaced it: the pass a revision put in its place, and what a revision started from its card made of it.
    const made = ctx.repos.changes.select(`project_id = ? AND json_extract(json, '$.intent') = 'suggestion' AND json_extract(json, '$.fromVersion') = ?
      AND (id = ? OR json_extract(json, '$.taskId') IN (SELECT id FROM tasks WHERE project_id = ? AND kind IN ('edit','revise','note')
        AND json_extract(json, '$.context.changeId') = ? AND json_extract(json, '$.context.cutIndex') IS NOT NULL))`,
      [named.projectId, named.fromVersion, at.rejectReason === REVISED || at.state === "revising" ? at.replacedBy ?? "" : "", named.projectId, at.id]);
    for (const next of made) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      from.push(next);
      if (next.id === stopAt || next.state === "approved") return next;
      // Opening a successor's cut to revise it changes that pass from ready to revising. Its other cuts still stand.
      if ((next.state === "ready" || next.state === "revising") && (!waiting || (next.createdAt ?? "") > (waiting.createdAt ?? ""))) waiting = next;
      if (next.rejectReason === CARRIED && (!carried || (next.createdAt ?? "") > (carried.createdAt ?? ""))) carried = next;
    }
  }
  return waiting ?? carried;
}

/** A revision keeps slot numbers. A later part may change them and their timeline, so match the surviving footage. */
export function activeStagedCut(ctx: Ctx, project: Omit<Project, "media">, named: Change, index: number, stopAt?: string) {
  let change = named, carried = false;
  const seen = new Set<string>();
  while (!seen.has(change.id)) {
    seen.add(change.id);
    if (change.id === stopAt) return { change, index, carried };
    if (change.rejectReason === CARRIED && change.replacedBy) {
      const next = ctx.repos.changes.get(change.replacedBy);
      if (!next || next.projectId !== project.id || next.intent !== "suggestion" || !next.cutReasons?.length)
        throw conflict("cut_review_moved", "The later part of this pass no longer lists this cut.");
      const before = prepareCutReview(ctx, change).review, after = prepareCutReview(ctx, next).review;
      if (!before?.cuts[index] || !after) throw conflict("cut_review_moved", "The later part has no matching staged cut.");
      const moved = currentCutRanges(ctx, project, change, before, after.original)(index);
      const match = moved.kind === "exact" || moved.kind === "shortened"
        ? after.cuts.findIndex(({ removed }) => Math.abs(removed.start - moved.range.start) < 1e-5 && Math.abs(removed.end - moved.range.end) < 1e-5) : -1;
      if (match === -1) throw conflict("cut_review_moved", moved.kind === "gone"
        ? "The later part already removed this passage and no longer lists the cut."
        : "The later part changed this review slot. Its original footage no longer matches a single staged cut.",
        { changeId: next.id, version: next.fromVersion, ...(moved.kind !== "gone" && moved.range && { range: moved.range }) });
      change = next;
      index = match;
      carried = true;
      continue;
    }
    const revised = change.state === "revising" || change.rejectReason === REVISED ? revisedPass(ctx, change, stopAt) : undefined;
    if (!revised) return { change, index, carried };
    change = revised;
  }
  throw conflict("cut_review_moved", "This cut's replacement history cannot be followed.");
}

/** The current pass and call to include in a queued request’s prompt. */
export function passToRevise(ctx: Ctx, named: Change, taskId: string | undefined, index: number): { change: Change; index: number } | undefined {
  if (named.intent !== "suggestion" || !named.cutReasons?.length || named.state === "ready" ||
      named.state === "revising" && named.revisionFrom?.taskId === taskId) return;
  const project = ctx.repos.projects.header(named.projectId);
  if (!project) return;
  try {
    const slot = activeStagedCut(ctx, project, named, index);
    if (slot.change.id !== named.id) return slot;
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "cut_review_moved") throw error;
  }
}

/**
 * The editor sent one call of a dialogue pass back to Scarlet. A pass they had set to apply when Scarlet finishes was
 * scheduled on the calls as they stood, and the request about this one waits behind the run: applied on schedule, the
 * pass would go in with the old cut and leave the request nothing to revise. So the schedule is taken back, the pass
 * waits for the revised cut, and the editor applies it. The request names the pass as it stood when they sent it; when
 * a revision or a later part of the pass has replaced that one, the pass that waits now is the one held. Caller holds
 * the write lock.
 */
export function callSentBack(ctx: Ctx, request: Task): { changeId: string; index: number } {
  const { changeId, cutIndex } = request.context;
  const named = changeId && cutIndex !== undefined ? ctx.repos.changes.get(changeId) : undefined;
  if (named?.projectId !== request.projectId) return { changeId: changeId!, index: cutIndex! };
  const slot = passToRevise(ctx, named, request.id, cutIndex!) ?? { change: named, index: cutIndex! };
  const pass = slot.change;
  if (pass.applyWhenDone && pass.intent === "suggestion" && pass.cutReasons?.length && (pass.state === "ready" || pass.state === "revising")) {
    saveChange(ctx, { ...pass, applyWhenDone: undefined });
    ctx.db.afterCommit(() => ctx.log(`[review] schedule change=${logId(pass.id)} project=${logId(pass.projectId)} task=${logId(request.id)} outcome=cleared reason=revision`));
  }
  return { changeId: pass.id, index: slot.index };
}

export function selectedStagedCut(ctx: Ctx, task?: Task | null) {
  if (!task || (task.kind !== "revise" && task.kind !== "edit") || !task.context.changeId || task.context.cutIndex === undefined) return;
  const change = ctx.repos.changes.get(task.context.changeId);
  if (!change || change.projectId !== task.projectId) throw badRequest("wrong_cut", "The selected cut is unavailable.");
  let staged = task.stagedCutRevision ?? stagesCut(task.kind, change);
  if (task.stagedCutRevision === undefined && !staged && change.intent === "suggestion" && change.updatedAt && task.createdAt && change.updatedAt >= task.createdAt) {
    // For an older request, a later render or metadata update does not turn an already approved edit back into a staged cut.
    const prior = ctx.db.prepare(`SELECT type FROM activity WHERE project_id = ? AND created_at <= ?
      AND type IN ('change.approved','change.applied','change.rejected','change.undone','change.reopened')
      AND json_extract(json, '$.data.changeId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(task.projectId, task.createdAt, change.id) as { type: string } | undefined;
    staged = !prior || prior.type === "change.undone" || prior.type === "change.reopened";
  }
  if (staged) return { change, index: task.context.cutIndex };
}

export function requireUnscopedEdit(ctx: Ctx, task?: Task | null, localDialogue = false) {
  if (task && taskDialogueOperation(task) === "local-pauses" && !localDialogue)
    throw badRequest("local_pauses", "This request only tightens local pauses. Save classified pauses with dialogue_apply_cuts.");
  if (selectedStagedCut(ctx, task)) throw badRequest("wrong_cut", "This request revises one staged cut. Save its new range with dialogue_revise_cut.");
}

/**
 * What a timeline plays on the tracks `base` has. A staged cut keeps its footage when a later save lays a picture over
 * it: passes that reframed the presenter were refused 18 times in eight runs for "taking away" cuts whose footage they
 * left in place (2026-11-15). The mapper itself doesn't count how a clip is framed.
 */
function footageOf(timeline: Timeline, base: Timeline): Timeline {
  const kept = new Set(base.tracks.map(t => `${t.kind}:${t.id}`));
  return { ...timeline, tracks: timeline.tracks.filter(t => kept.has(`${t.kind}:${t.id}`)) };
}

/** Later saves by the producing run can move a published call on the timeline but must preserve its footage and edges. */
export function assertStagedCallsStand(ctx: Ctx, project: Omit<Project, "media">, task: Task, base: Timeline, next: Timeline): void {
  const parts = dialogueParts(project.id, runRoot(task));
  const waiting = ctx.repos.changes.select(`project_id = ? AND state IN ('ready','revising') AND json_extract(json, '$.intent') = 'suggestion'
    AND json_array_length(json, '$.cutReasons') > 0 AND id IN (${parts.ids})`, parts.args);
  if (!waiting.length) return;
  const place = makeStagedCutMapper(footageOf(base, base), footageOf(next, base), project.settings.fps);
  for (const change of waiting) {
    const review = prepareCutReview(ctx, change).review;
    if (!review) continue;
    const before = currentCutRanges(ctx, project, change, review, base);
    const published = new Set([...(change.cutAssessments ?? []).filter(a => isPublishedCall(a) || a.askOrder !== undefined),
      ...(change.cutChoices ?? [])].map(c => c.index));
    const taken: Array<{ index: number } & TimeRange> = [];
    const located: Array<{ index: number; range: TimeRange }> = [];
    for (const index of review.cuts.keys()) {
      const earlier = before(index);
      if (earlier.kind === "gone" || earlier.kind === "conflict") continue;
      const moved = place(earlier.range);
      // A few remaining frames give the editor nothing to judge, even for a cut the pass has yet to check.
      const least = Math.max(3 / project.settings.fps, (earlier.range.end - earlier.range.start) / 10);
      if (moved.kind !== "exact" && (moved.kind !== "shortened" || moved.range.end - moved.range.start < least)) {
        taken.push({ index, ...earlier.range });
        continue;
      }
      if (moved.kind !== "exact" && published.has(index))
        throw conflict("cut_with_editor", `This edit would change ${editorsCut(change, index)} in ${change.id}, which is with the editor. Leave its footage in place. ${CALL_WITH_EDITOR}`);
      located.push({ index, range: moved.range });
    }
    if (taken.length) {
      const named = taken.slice(0, 12).map(c => `${editorsCut(change, c.index)} at ${c.start.toFixed(2)}–${c.end.toFixed(2)} s`).join(", ");
      throw conflict("staged_cuts_changed", `This edit takes away the footage of ${taken.length === 1 ? "a staged cut" : `${taken.length} staged cuts`} that `
        + `${taken.length === 1 ? "waits" : "wait"} for the editor’s call in ${change.id} (${named}${taken.length > 12 ? ", …" : ""}; times on version ${base.version}). `
        // A pass sent the same edit here three times before it moved the cut with dialogue_revise_cut (2026-11-18).
        + `Nothing was saved. Leave that footage in this edit. To move a staged cut's edges, use dialogue_revise_cut with changeId ${change.id} and its index (${taken.slice(0, 12).map(c => c.index).join(", ")}). `
        + "dialogue_apply_cuts updates a staged cut Scarlet hasn't asked the editor about.");
    }
    located.sort((a, b) => a.range.start - b.range.start);
    for (let i = 1; i < located.length; i++) {
      const a = located[i - 1]!, b = located[i]!;
      if (b.range.start < a.range.end + 1e-6 && (published.has(a.index) || published.has(b.index)))
        throw conflict("cut_with_editor", `This edit would join ${editorsCut(change, a.index)} and ${editorsCut(change, b.index)} in ${change.id}. Leave footage between them to preserve the editor’s call. ${CALL_WITH_EDITOR}`);
    }
  }
}
