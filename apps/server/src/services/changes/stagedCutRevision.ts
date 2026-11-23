import { createHash } from "node:crypto";
import { taskDialogueOperation, type StagedCutRevision, type User } from "@scarlet/shared";
import { frameAligned, isPublishedCall, type Change, type CutAssessment } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { now } from "../../db.js";
import { badRequest, conflict, HttpError, notFound } from "../../errors.js";
import { currentCutRanges, placeRevision } from "../stagedCutRecovery.js";
import { FINISHED_TASK, saveTask } from "../tasks.js";
import { resolveTimeline } from "../timeline.js";
import { CALL_WITH_EDITOR, capitalized, editorsCut, putAway, REVISED, saveChange } from "./common.js";
import { prepareCutReview } from "./cutReview.js";
import { cutCrossfade, storeRevisedCutPreview } from "./joinCrossfades.js";
import { persistProposal } from "./propose.js";
import { activeStagedCut, revisedPass, selectedStagedCut } from "./stagedCutLineage.js";

/**
 * Move one staged cut of a pending dialogue pass. Every other cut and its review note carries over into a
 * replacement pass from the same version, so the editor's other calls stay valid. The moved cut waits for
 * the editor again.
 */
export function reviseStagedCut(ctx: Ctx, user: User, named: Change, namedIndex: number, body: StagedCutRevision, checkAttempt?: () => void) {
  // The pass is saved bare, then with its notes and the editor's calls: a window is told of it once, complete.
  const result = ctx.db.transaction(() => ctx.bus.asSaved(() => {
    const { reason, summary, taskId, author, noteIds } = body;
    checkAttempt?.();
    let project = ctx.repos.projects.header(named.projectId);
    if (!project) throw notFound("project");
    const task = taskId ? ctx.repos.tasks.get(taskId) : null;
    if (taskId && task?.projectId !== named.projectId) throw badRequest("invalid_task", "Task must belong to this project.");
    if (task?.context.branch && task.context.branch !== project.branch) {
      const branch = ctx.db.prepare("SELECT head FROM cut_branches WHERE project_id = ? AND name = ?")
        .get(project.id, task.context.branch) as { head: string | null } | undefined;
      if (!branch?.head) throw conflict("cut_review_stale", "The branch containing this cut is no longer available.");
      project = { ...project, branch: task.context.branch, head: branch.head };
    }
    const selected = selectedStagedCut(ctx, task);
    const local = task && taskDialogueOperation(task) === "local-pauses";
    if (local && !selected) throw badRequest("local_pauses", "Only the staged pause selected by the editor can be revised here.");
    if (selected && (selected.change.id !== named.id || selected.index !== namedIndex)) {
      // A queued request can name a predecessor. Only its original slot or the same slot in its live successor is writable.
      const current = activeStagedCut(ctx, project, selected.change, selected.index);
      const requested = activeStagedCut(ctx, project, named, namedIndex);
      if (current.change.id !== requested.change.id || current.index !== requested.index)
        throw badRequest("wrong_cut", "Choose the staged cut selected for this request.");
    }
    const range = frameAligned(body, project.settings.fps);
    const write = ["staged-cut", named.id, taskId, namedIndex, range.start, range.end,
      ...(body.version ? [body.version] : []), ...(body.keep ? ["keep"] : []), ...(body.crossfadeFrames !== undefined ? [{ crossfadeFrames: body.crossfadeFrames }] : [])];
    const idFor = (attempt: number) => `chg_${createHash("sha256").update(JSON.stringify(attempt ? [...write, attempt] : write)).digest("hex")}_review`;
    let attempt = 0, id = idFor(attempt);
    let saved: Change | null = null;
    for (let prior; (prior = ctx.repos.changes.get(id)); id = idFor(++attempt)) saved = prior;
    const receipt = (change: Change, slot: { index: number; carried: boolean; change: Change }) =>
      ({ change, index: slot.index, ...(slot.carried && { carried: true as const }),
        ...(slot.change.id !== named.id && slot.change.taskId !== taskId && { replaced: slot.change.id }) });
    if (saved) {
      const recorded = activeStagedCut(ctx, project, named, namedIndex, saved.id);
      const successor = saved.rejectReason === REVISED && task && !FINISHED_TASK.has(task.state) ? revisedPass(ctx, saved) : undefined;
      if (!successor || successor.state !== "ready" || successor.taskId !== taskId) return receipt(saved, recorded);
      // The same run can move one cut twice, then decide its first boundary played better.
      // A repeated batch needs its original receipt to identify the next move in the batch.
      const sameSlot = (c: Change) => {
        const span = prepareCutReview(ctx, c).review?.cuts[recorded.index]?.removed;
        return JSON.stringify([span, span && cutCrossfade(c, span), c.cutEdits?.find(e => e.index === recorded.index),
          c.cutChoices?.find(choice => choice.index === recorded.index)?.choice]);
      };
      if (sameSlot(saved) === sameSlot(successor)) return receipt(saved, recorded);
    }
    // Queued requests identify the pass as it was when they were sent. Use its latest waiting revision
    // so a second cut keeps the footage and the decisions already recovered for the first.
    const target = activeStagedCut(ctx, project, named, namedIndex);
    const { change, index } = target;
    if (body.requireCurrentCut && change.id !== named.id)
      throw conflict("cut_review_moved", "The staged cut changed while measuring its pause. Repeat the word-based trim on the current cut.",
        { changeId: change.id, index });
    if (change.intent !== "suggestion" || !change.ops?.length || (change.state !== "ready" && change.state !== "revising"))
      throw conflict("invalid_state", "Only a pending dialogue pass has staged cuts to revise.");
    if (task && FINISHED_TASK.has(task.state)) throw conflict("task_finished", "This task has already finished.");
    const review = prepareCutReview(ctx, change).review;
    if (!review || review.firstCut) throw badRequest("cuts_unsupported", "This edit has no individual cuts.");
    if (change !== named && !target.carried && prepareCutReview(ctx, named).review?.cuts.length !== review.cuts.length)
      throw conflict("cut_review_moved", `Change ${named.id} was replaced by ${change.id}, which lists its cuts differently. Find this cut there and revise it on that change.`);
    const cuts = review.cuts.map(c => c.removed);
    const old = cuts[index];
    if (!old) throw badRequest("wrong_cut", "Choose a staged cut in this pass.");
    if (selected && !body.keep) {
      const selectedReview = selected.change.id === change.id ? review : prepareCutReview(ctx, selected.change).review;
      if (!selectedReview?.cuts[selected.index]) throw badRequest("wrong_cut", "The selected cut is unavailable.");
      const version = body.version ?? named.fromVersion;
      const input = version === selectedReview.original.version ? selectedReview.original : resolveTimeline(ctx, project, version);
      const location = currentCutRanges(ctx, project, selected.change, selectedReview, input)(selected.index);
      const anchor = location.kind === "gone" ? undefined : location.range;
      if (local) {
        const prior = change.cutReasons?.filter(c => c.start < old.end && c.end > old.start);
        if (!prior?.length || prior.some(c => c.kind !== "pause") || !anchor || range.start < anchor.start || range.end > anchor.end)
          throw badRequest("local_pauses", "Stay inside the selected, classified pause when revising it.");
      }
      const frame = 1 / project.settings.fps;
      // Every move stays attached to the passage the editor chose, even after several overlapping moves or a rebase.
      // An unlocatable passage goes through the existing conflict and editor-answer flow in placeRevision.
      if (anchor && (range.start >= anchor.end + frame - 1e-6 || range.end <= anchor.start - frame + 1e-6))
        throw badRequest("wrong_cut", "The new range must touch the passage selected for revision.");
    }
    const namedByTask = task?.context.changeId && task.context.cutIndex !== undefined && task.context.changeId !== named.id
      ? ctx.repos.changes.get(task.context.changeId) : undefined;
    const currentTaskCut = namedByTask?.projectId === project.id && task?.context.cutIndex !== undefined
      ? activeStagedCut(ctx, project, namedByTask, task.context.cutIndex, change.id) : undefined;
    const scoped = !!selected || !!task && (currentTaskCut?.change.id === change.id && currentTaskCut.index === index ||
      task.context.changeId === named.id && task.context.cutIndex === namedIndex ||
      task.context.changeId === change.id && task.context.cutIndex === index ||
      task.cutConflict?.changeId === change.id && task.cutConflict.index === index);
    const was = change.cutAssessments?.find(a => a.index === index);
    const autonomous = !scoped && (!!task || body.author?.type === "agent");
    if (autonomous && (was && (isPublishedCall(was) || was.askOrder !== undefined) || change.cutChoices?.some(c => c.index === index)))
      throw conflict("cut_with_editor", `${capitalized(editorsCut(change, index))} at ${old.start}–${old.end} s is with the editor. Only a revision they request can change this cut. ${CALL_WITH_EDITOR}`);
    // A cut staged on a same-word join (`unheard`) couldn't be moved by the pass (`cut_unheard`, 2026-11-17). Since
    // 2026-11-21 the pass moves it as any staged cut: the model decides, and the default is in the skill. The mark
    // stays only on a cut left where Scarlet placed it, since a moved cut has another join.
    const unheard = !!change.cutReasons?.some(r => r.unheard && r.start < old.end - 1e-6 && r.end > old.start + 1e-6);
    const aFrame = 1 / project.settings.fps;
    const moves = Math.abs(range.start - old.start) > aFrame + 1e-6 || Math.abs(range.end - old.end) > aFrame + 1e-6;
    const placement = placeRevision(ctx, project, change, review, index, body, range, task, scoped, named.fromVersion);
    if ("conflict" in placement) {
      const { reason: conflictReason, range: conflictRange } = placement.conflict;
      const currentVersion = project.head!;
      if (task && scoped) {
        const last = task.cutConflict;
        const samePassage = last?.version === currentVersion && last.range?.start === conflictRange?.start && last.range?.end === conflictRange?.end;
        saveTask(ctx, { ...task, cutConflict: { version: currentVersion, range: conflictRange, ...((target.carried || currentTaskCut) && { changeId: change.id, index }), approved: last?.approved,
          ...(samePassage && { answered: last?.answered, retried: last?.retried }) } });
      }
      // Commit the location before returning the error. A restarted agent or an editor answering its question needs it.
      return conflict("cut_review_stale", conflictReason, { changeId: change.id, index, currentVersion, range: conflictRange });
    }
    const { start, end } = placement.slot;
    const ranges = cuts.map((c, i) => i === index ? { start, end } : c);
    const overlapsOld = (r: { start: number; end: number }) => r.start < old.end - 1e-6 && r.end > old.start + 1e-6;
    const kind = (change.cutReasons ?? []).find(r => overlapsOld(r) && r.kind)?.kind;
    const crossfade = body.crossfadeFrames !== undefined ? body.crossfadeFrames / project.settings.fps : cutCrossfade(change, old);
    const legacySuggest = change.cutReasons?.some(r => overlapsOld(r) && r.legacySuggest);
    const cutReasons = (change.cutReasons ?? []).filter(r => !overlapsOld(r)).map(r => {
      const duration = r.crossfade ?? change.joinFades?.duration;
      return duration ? { ...r, crossfade: duration } : r;
    });
    cutReasons.push({ start, end, reason, summary, ...(kind && { kind }), ...(crossfade && { crossfade }), ...(legacySuggest && { legacySuggest }), ...(unheard && !moves && { unheard: true as const }) });
    cutReasons.sort((a, b) => a.start - b.start);
    const { change: revised } = persistProposal(ctx, user, change.projectId, { fromVersion: change.fromVersion, intent: "suggestion", autoApprove: false,
      ops: [...ranges].reverse().map(r => ({ op: "rippleDelete" as const, start: r.start, end: r.end })),
      description: change.description, taskId, author, noteIds: [...new Set([...change.noteIds, ...(noteIds ?? [])])] }, id, cutReasons);
    // A later attempt from the same run replaces an earlier one, so only one pass waits for the editor.
    if (taskId) for (const earlier of ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.taskId') = ? AND id != ?",
      [change.projectId, taskId, id])) {
      if (earlier.fromVersion === change.fromVersion && earlier.intent === "suggestion")
        putAway(ctx, earlier, REVISED, revised.id);
    }
    // The editor's calls on the other cuts carry over, including ones made while this revision ran. The revised cut
    // needs a new call.
    const latest = ctx.repos.changes.get(change.id) ?? change;
    if (latest.state === "ready") {
      putAway(ctx, latest, REVISED, revised.id);
    } else if (latest.state === "revising" && !selected && taskId && latest.revisionFrom?.taskId === taskId) {
      // A pass-wide revision can move several slots. Keep its review state and let the
      // next move find this successor with the preceding move and the editor’s calls.
      saveChange(ctx, { ...latest, replacedBy: revised.id });
    }
    const cutChoices = (latest.cutChoices ?? []).filter(c => c.index !== index);
    const approved = task?.cutConflict?.approved && scoped;
    // A cut the editor sent back stays theirs to call once revised, even when the revision leaves its footage in: it
    // waits for them to approve the new version, and doesn't apply the pass by itself (2026-11-14).
    const keepsForEditor = !!placement.keep && scoped && !approved;
    if ((placement.keep && !keepsForEditor) || approved) cutChoices.push({ index, start, end, choice: placement.keep ? "keep" : "cut" });
    const cutEdits = (latest.cutEdits ?? []).filter(e => e.index !== index);
    const edit = placement.edit;
    if (edit) {
      let previewVersion = edit.previewVersion;
      if (!placement.keep && edit.range.end > edit.range.start) {
        const source = resolveTimeline(ctx, project, edit.version);
        previewVersion = storeRevisedCutPreview(ctx, project.id, source, edit.range, revised.toVersion, crossfade, source.version);
      }
      cutEdits.push({ ...edit, previewVersion });
    }
    const carried = { ...(cutChoices.length && { cutChoices }), ...(cutEdits.length && { cutEdits }) };
    const updatedTask = scoped && task?.cutConflict && ctx.repos.tasks.get(task.id);
    if (updatedTask) saveTask(ctx, { ...updatedTask, cutConflict: undefined });
    if (!change.cutAssessments?.length && !placement.keep) return receipt(Object.keys(carried).length ? saveChange(ctx, { ...revised, ...carried }) : revised, target);
    const verdict: CutAssessment["verdict"] = keepsForEditor ? "ask" : placement.keep ? "keep" : approved ? "cut" : "ask";
    const sentBack = scoped || was?.revised;
    // Moving an unchecked candidate invalidates its assessment. Only a recommendation on the new footage publishes it.
    const provisional = verdict === "ask" && autonomous;
    const updated: CutAssessment = { index, start, end, verdict, reason, summary, ...(provisional && { provisional: true }),
      ...(verdict === "ask" && sentBack && { revised: true }), ...(keepsForEditor && { proposes: "keep" as const }), ...(was?.askOrder && { askOrder: was.askOrder }) };
    // The cuts Scarlet never checked stay unassessed: they are the editor's calls ("Not checked yet."), and keeping one
    // of them doesn't settle the rest (2026-11-15).
    const cutAssessments = [...(change.cutAssessments ?? []).filter(a => a.index !== index), updated].sort((a, b) => a.index - b.index);
    const decided = new Set(cutChoices.map(c => c.index));
    const done = cuts.every((_, i) => decided.has(i) || cutAssessments.some(a => a.index === i && a.verdict !== "ask"));
    const applyWhenDone = (placement.keep || approved) && done && scoped ? { userId: user.id, at: now() } : undefined;
    return receipt(saveChange(ctx, { ...revised, cutAssessments, ...carried, applyWhenDone }), target);
  }), "immediate")();
  if (result instanceof HttpError) throw result;
  return result;
}
