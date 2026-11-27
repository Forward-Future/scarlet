import { createHash } from "node:crypto";
import { cutAnchorOn, cutScope, selectedRange, taskDialogueOperation, type DialogueCutsRequest, type JoinCrossfades, type Task, type User } from "@scarlet/shared";
import {
  describeDialogueRemovals,
  frameAlignedRemoval,
  historyLineage,
  isPublishedCall,
  makeTimeMap,
  mergeRanges,
  SUMMARY_MAX,
  timelineDuration,
  type Change,
  type CutAssessment,
  type CutChoice,
  type TimeRange,
} from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { badRequest, conflict, notFound } from "../../errors.js";
import { logId } from "../../logText.js";
import { errorMessage, round3 } from "../../util.js";
import { runAttemptIds } from "../runAttempts.js";
import { currentCutRanges } from "../stagedCutRecovery.js";
import { editsDialogue, FINISHED_TASK, saveTask } from "../tasks.js";
import { resolveTimeline } from "../timeline.js";
import { CARRIED, EDITOR_ASKED_MEANWHILE, editorAskedSince, LEFT_OF_STAGED_CUT, putAway, saveChange } from "./common.js";
import { prepareCutReview } from "./cutReview.js";
import { cutCrossfade, joinCrossfadeReport, storeRevisedCutPreview } from "./joinCrossfades.js";
import { persistProposal } from "./propose.js";
import { activeStagedCut, dialogueParts, requireUnscopedEdit } from "./stagedCutLineage.js";

/** What Scarlet did to submitted dialogue cuts on its own, each with why, so the agent reads what was saved. */
export interface DialogueCutsAdjustments {
  /** Confident cuts that wait for the editor instead of applying, and why. */
  stagedForEditor?: { cuts: number; why: string };
  /** Cuts whose edges moved onto whole frames: how many, the largest move in seconds, and why. */
  onFrames?: { cuts: number; largestShift: number; why: string };
  /** Staged cuts of an earlier part that left the review because their footage changed, on the version they were staged on. */
  droppedFromReview?: Array<{ changeId: string; version: string; start: number; end: number; why: string }>;
  /** Cuts left out because they would have replaced a staged cut held for its join with other edges, applied only by unsureJoins cut. */
  heldCutsStay?: Array<{ asked: TimeRange; staged: TimeRange; why: string }>;
  /** Staged cuts Scarlet checked and settled as cuts, never asked about, that went into the video with this save. */
  settledApplied?: { cuts: number; why: string };
}

/**
 * A staged cut Scarlet checked and settled as a cut without asking the editor. The video shows the edit as it will be,
 * so such a cut goes in when the pass next saves instead of waiting for the editor's last call (the editor's decision,
 * 2026-11-23). Calls stay in the review whatever is decided on them, so Needs review keeps every call under its number with
 * its decision; so do a cut no one has checked, one Scarlet would keep, and one an earlier build staged for the
 * editor's approval.
 */
function settledAsCut(r: { legacySuggest?: true }, choice: CutChoice["choice"] | undefined, assessment: CutAssessment | undefined): boolean {
  if (!assessment || assessment.provisional || assessment.verdict === "ask" || assessment.askOrder !== undefined) return false;
  return choice ? choice === "cut" : assessment.verdict === "cut" && !r.legacySuggest;
}

/** Whether a waiting pass holds a cut that is settled as a cut and isn't in the video yet. */
export function hasSettledCut(change: Change): boolean {
  if (change.state !== "ready" || change.intent !== "suggestion" || !change.cutReasons?.length) return false;
  return change.cutReasons.some(r => {
    const choice = change.cutChoices?.find(c => covers(c, r))?.choice;
    return settledAsCut(r, choice, change.cutAssessments?.find(a => covers(a, r)));
  });
}

/** `a` holds all of `r`, give or take a hundredth of a millisecond. */
const covers = (a: TimeRange, r: TimeRange) => r.start >= a.start - 1e-5 && r.end <= a.end + 1e-5;
/** The footage a cut takes: its restorable range when it has one. */
const outer = (c: { start: number; end: number; originalRange?: { start: number; end: number } }) => c.originalRange ?? c;
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end - 1e-6 && a.end > b.start + 1e-6;

/** Why confident cuts wait for the editor here instead of applying, or nothing when they apply. The agent sent them as cuts, so it is told. */
function whyConfidentCutsWait(sourceTask: Task | null | undefined, branch: string | undefined): string | undefined {
  if (!sourceTask) return "No request of the editor's is attached, so every cut waits for them.";
  if (sourceTask.context.reviewAllCuts) return "The editor asked to review every cut.";
  if (sourceTask.createdBy.type !== "human") return "Scarlet started this request, not the editor, so its cuts wait for them.";
  if (!editsDialogue(sourceTask.kind)) return `A ${sourceTask.kind} request stages its cuts for the editor.`;
  if (sourceTask.context.branch !== branch) return "The editor moved to another version of the edit while this request ran.";
  return undefined;
}

/** Refuse a plan whose ranges can't be cut from a timeline of `duration` seconds. */
function assertCutRanges(cuts: readonly TimeRange[], duration: number): void {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  // Say which range is wrong: the agent sees only this message, and a plan it can't place it submits again unchanged.
  const span = (c: TimeRange) => `${c.start.toFixed(2)}–${c.end.toFixed(2)} s`;
  const empty = sorted.find(c => c.end <= c.start), past = sorted.find(c => c.end > duration);
  const second = sorted.findIndex((c, i) => i > 0 && c.start < sorted[i - 1]!.end);
  if (empty) throw badRequest("invalid_cuts", `The range ${span(empty)} is empty. Give each range an end after its start.`);
  if (past) throw badRequest("invalid_cuts", `The range ${span(past)} runs past the end of the timeline at ${duration.toFixed(2)} s.`);
  if (second > 0) throw badRequest("invalid_cuts", `The ranges ${span(sorted[second - 1]!)} and ${span(sorted[second]!)} overlap. End the first where the second starts, or merge them.`);
  if (sorted.reduce((n, c) => n + c.end - c.start, 0) >= duration - 1e-7) throw badRequest("invalid_cuts", "These ranges remove the whole timeline. Retain some footage.");
}

/** A cut of a plan as it goes onto the frame grid. */
type FrameCut = TimeRange & { submitted?: true; review?: boolean; preserveEdges?: boolean; originalRange?: TimeRange };

/**
 * Whole frames: a cut of a whole number of frames moves everything after it by whole frames, so the cached preview
 * sections after it still match. Rounding inward never removes more than the plan; a sub-frame cut rounds to the nearest
 * frame, and stops at the end of an edit that ends between two frames: a cut past the end has no review.
 * `rebasing`: the plan moves onto the current version, so the submitted range and kept footage no longer apply as given.
 */
function onWholeFrames<C extends FrameCut>(planned: C[], fps: number, duration: number, { range, kept, rebasing }: { range?: TimeRange; kept: readonly TimeRange[]; rebasing: boolean }):
  { cuts: C[]; onFrames?: DialogueCutsAdjustments["onFrames"] } {
  const bounded = !!range || kept.length > 0;
  let cuts = planned;
  const asPlanned = cuts.map(c => ({ start: c.start, end: c.end }));
  const beforeFrames = cuts;
  cuts = cuts.map((c, i) => {
    if (c.preserveEdges) return c; // A manual trim can put the same source frames between project frames.
    // The submitted limits refer to the submitted version. When rebasing, round within the
    // mapped removal itself so a nearby frame on the new timeline cannot escape those limits.
    const scope = c.submitted ? (bounded && rebasing ? c : range) : undefined;
    const retained = c.submitted && !rebasing ? kept : [];
    const before = asPlanned[i - 1], after = asPlanned[i + 1];
    const gaps = [...retained];
    if (before && c.start > before.end && c.start - before.end < 1 / fps) gaps.push({ start: before.end, end: c.start });
    if (after && c.end < after.start && after.start - c.end < 1 / fps) gaps.push({ start: c.end, end: after.start });
    const { start, end } = frameAlignedRemoval(c, fps, scope, gaps);
    return { ...c, start, end: Math.min(end, duration) };
  });
  // Two cuts that met at one instant still meet. Rounded inward each, they would leave a frame of footage between
  // them that nobody decided to keep, so their shared edge goes to the nearest frame instead.
  for (let i = 1; i < cuts.length; i++) {
    const before = cuts[i - 1]!, after = cuts[i]!;
    if (Math.abs(asPlanned[i]!.start - asPlanned[i - 1]!.end) > 1e-9 || after.start - before.end < 1e-9) continue;
    if (before.preserveEdges && after.preserveEdges) continue;
    const shared = before.preserveEdges ? before.end : after.preserveEdges ? after.start : Math.round(asPlanned[i]!.start * fps) / fps;
    if (shared <= before.start || shared >= after.end) continue;
    cuts[i - 1] = { ...before, end: shared };
    cuts[i] = { ...after, start: shared };
  }
  const frame = 1 / fps;
  // What putting the agent's cuts on whole frames moved, so it reads the saved ranges and not its own.
  const shifts = cuts.flatMap((c, i) => {
    const was = beforeFrames[i]!;
    if (!c.submitted) return [];
    const moved = Math.max(Math.abs(c.start - was.start), Math.abs(c.end - was.end));
    return moved > 1e-6 ? [moved] : [];
  });
  const onFrames = shifts.length ? { cuts: shifts.length, largestShift: round3(Math.max(...shifts)),
    why: `Cuts are saved on whole frames at ${fps} fps, rounded inward and never past the timeline's end; timelineEdits has the saved ranges.` } : undefined;
  if (cuts.some((c, i) => i > 0 && (c.preserveEdges || cuts[i - 1]!.preserveEdges) && overlaps(c, cuts[i - 1]!)))
    throw conflict("cut_changed", "A new range reaches into a carried cut after frame alignment. Check their shared edge.");
  // A staged cut carries the range the editor can restore. Moving the cut beside it onto a frame can carry that
  // cut's edge a few milliseconds into the range: a removal that met a staged retake at 265.46 s ended on frame
  // 7,964 at 265.4667 s, and the whole plan was refused. The range gives way by that much; a real overlap is still refused.
  cuts = cuts.map(c => {
    if (!c.originalRange || c.preserveEdges) return c;
    let { start, end } = c.originalRange;
    for (const other of cuts) {
      if (other === c || other.review) continue;
      if (other.start < start && other.end > start && other.end - start <= frame + 1e-9) start = other.end;
      if (other.end > end && other.start < end && end - other.start <= frame + 1e-9) end = other.start;
    }
    return start === c.originalRange.start && end === c.originalRange.end ? c : { ...c, originalRange: { start, end } };
  });
  return { cuts, onFrames };
}

/**
 * Both writes commit together; optional ranges start on the kept version. Stable IDs make response-loss retries safe.
 * `fold` gathers the waiting parts of a run that has finished, with no cuts of its own: only Scarlet's own repair saves under such a run.
 */
type DialogueCutsResult = {
  changes: Change[]; carriedForward?: number; editorDecided?: TimeRange[]; heldForReview?: TimeRange[];
  alreadyRemoved?: { changeId: string; index: number; version: string; at: number }[];
  /** The requested crossfade on the joins these cuts made. Absent when nothing was saved. */
  joinCrossfades?: JoinCrossfades;
} & DialogueCutsAdjustments;

export function submitDialogueCuts(ctx: Ctx, user: User, projectId: string, body: DialogueCutsRequest, options: { fold?: boolean; checkAttempt?: () => void } = {}): DialogueCutsResult {
  try {
    return saveDialogueCuts(ctx, user, projectId, body, { ...options, settle: true });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    ctx.log(`[edit] settled-cuts-left-out project=${logId(projectId)} reason=${typeof code === "string" ? code : "error"}`);
    // Settled cuts go in with the save only when that is all it changes: one that would bring two waiting calls together,
    // or anything else the save refuses with them in, stays in the review as before and the save goes ahead without it.
    // A save refused for its own reasons is refused again here, as it was before.
    return saveDialogueCuts(ctx, user, projectId, body, { ...options, settle: false });
  }
}

function saveDialogueCuts(ctx: Ctx, user: User, projectId: string, body: DialogueCutsRequest,
  { fold = false, checkAttempt, settle }: { fold?: boolean; checkAttempt?: () => void; settle: boolean }): DialogueCutsResult {
  // Its own transaction, or a part of the one open: putting settled cuts in follows the editor's call inside its save.
  return ctx.db.savepoint(() => ctx.bus.asSaved(() => {
    const { fromVersion, taskId, author, noteIds } = body;
    checkAttempt?.();
    const sourceTask = taskId ? ctx.repos.tasks.get(taskId) : undefined;
    requireUnscopedEdit(ctx, sourceTask, true);
    const local = !!sourceTask && taskDialogueOperation(sourceTask) === "local-pauses";
    if (local && body.noteIds?.some(id => !sourceTask!.context.noteIds?.includes(id)))
      throw badRequest("invalid_note", "Choose a note attached to this request.");
    if (local && body.cuts.some(cut => cut.kind !== "pause"))
      throw badRequest("local_pauses", "Only classified pause removals belong to this request.");
    const frames = body.crossfadeFrames ?? 0;
    const token = createHash("sha256").update(JSON.stringify([projectId, user.id, taskId, fromVersion, [...body.cuts].sort((a, b) => a.start - b.start),
      ...(body.range || body.kept?.length ? [body.range, body.kept] : []), ...(frames ? [{ crossfadeFrames: frames }] : [])])).digest("hex");
    const ids = ["applied", "review"].map(s => `chg_${token}_${s}`);
    const saved = ids.flatMap(id => ctx.repos.changes.get(id) ?? []);
    if (saved.length) {
      // Older submissions used the same ID as a straight cut but read the overlap from Settings.
      // A stored receipt from that engine describes the fade those cuts actually made.
      const old = body.crossfadeFrames === undefined && saved.find(c => c.joinFades && !c.cutReasons?.some(r => r.crossfade !== undefined));
      const savedFrames = old && old.joinFades ? Math.round(old.joinFades.duration * (ctx.repos.projects.header(projectId)?.settings.fps ?? 0)) : frames;
      return { changes: saved, joinCrossfades: joinCrossfadeReport(savedFrames, saved) };
    }
    const project = ctx.repos.projects.header(projectId);
    if (!project) throw notFound("project");
    if (!project.head) throw conflict("cut_changed", "Reread the current timeline and map the candidates again.");
    const head = project.head;
    const fps = project.settings.fps;
    const base = resolveTimeline(ctx, project, fromVersion);
    if (local || body.range || selectedRange(sourceTask?.context)) {
      const anchor = sourceTask?.context ?? {};
      const originalVersion = anchor.dialogueRange?.version ?? anchor.version;
      const original = originalVersion && originalVersion !== "head" && originalVersion !== base.version ? resolveTimeline(ctx, project, originalVersion) : undefined;
      try {
        const range = cutScope(base, cutAnchorOn(anchor, base, original), body.range, local);
        if (body.cuts.some(c => (c.originalRange ?? c).start < range.start || (c.originalRange ?? c).end > range.end))
          throw new Error("Stay inside the selected passage when saving dialogue cuts.");
        body = { ...body, range };
        if (local && sourceTask && !anchor.dialogueRange) saveTask(ctx, { ...sourceTask, context: { ...anchor, dialogueRange: { ...range, version: fromVersion } } });
      } catch (error) {
        throw badRequest("cut_scope", errorMessage(error));
      }
    }
    // The editor or another request can change the edit while a part is being decided. Its cuts are anchored in
    // the footage, so they move onto the current version unless footage inside one of them changed.
    const toHead = head === fromVersion ? undefined : makeTimeMap(base, resolveTimeline(ctx, project, head), fps);
    // A pass saved in parts: the run's previous parts left their staged cuts waiting. They join this part's review so
    // they stay reviewable once this part's cuts apply. A run resumed after an interruption still owns its earlier parts.
    const rootId = taskId && (sourceTask?.resumeRootId ?? taskId);
    const parts = rootId && dialogueParts(projectId, rootId);
    const pending = new Map<string, Set<number>>();
    if (parts) for (const task of ctx.repos.tasks.select(`project_id = ? AND kind IN ('edit','revise','note') AND state IN ('queued','claimed','running','waiting_for_user')
      AND json_extract(json, '$.context.cutIndex') IS NOT NULL AND json_extract(json, '$.context.changeId') IN (${parts.ids})`, parts.args)) {
      const origin = ctx.repos.changes.get(task.context.changeId!)!;
      const slot = activeStagedCut(ctx, project, origin, task.context.cutIndex!);
      const indices = pending.get(slot.change.id) ?? new Set<number>();
      indices.add(slot.index);
      pending.set(slot.change.id, indices);
    }
    const waiting = parts ? ctx.repos.changes.select(`project_id = ? AND state IN ('ready','revising') AND id IN (${parts.ids})`, parts.args)
      .filter(c => c.intent === "suggestion" && c.id.endsWith("_review") && c.cutReasons?.length &&
        (pending.has(c.id) || c.state === "ready")) : [];
    const recovering = waiting.some(c => c.cutEdits?.length || pending.has(c.id));
    const current = recovering ? resolveTimeline(ctx, project, head) : undefined;
    const protectedCuts = new Map<TimeRange, string>();
    const recoveredCuts = new Set<TimeRange>();
    const alreadyRemoved: { changeId: string; index: number; version: string; at: number }[] = [];
    if (recovering) {
      const branch = ctx.repos.tasks.get(rootId!)?.context.branch;
      const { lineage } = historyLineage(ctx.repos.versions.links(projectId), head);
      if (branch && branch !== project.branch || !lineage.has(fromVersion) || waiting.some(c => !lineage.has(c.fromVersion)))
        throw conflict("cut_changed", "The recovered review belongs to a different edit. Continue the pass on its original cut.");
    }
    const editorChoice = (change: Change, r: TimeRange) => change.cutChoices?.find(c => covers(c, r))?.choice;
    const assessmentOf = (change: Change, r: TimeRange) => change.cutAssessments?.find(a => covers(a, r));
    const changed = new Set<TimeRange>();
    // Staged cuts from an earlier part that nobody called and whose footage a later edit broke up. They leave the review,
    // and the agent is told which, so it can stage them again if it still means them.
    const droppedFromReview: NonNullable<DialogueCutsAdjustments["droppedFromReview"]> = [];
    const drop = (change: Change, r: TimeRange, why: string) => { droppedFromReview.push({ changeId: change.id, version: change.fromVersion, start: r.start, end: r.end, why }); return []; };
    // Ordinary earlier parts retain their existing decisions when they move onto this part’s input.
    const earlier = !current ? waiting.map(change => {
      if (change.fromVersion === fromVersion) return change;
      const map = makeTimeMap(resolveTimeline(ctx, project, change.fromVersion), base, fps);
      const move = <T extends TimeRange>(r: T): T | undefined => {
        const start = map(r.start, "right"), end = map(r.end, "left");
        return start === null || end === null || Math.abs(end - start - (r.end - r.start)) > 1 / fps ? undefined : { ...r, start, end };
      };
      // What is left of a range's footage, from its first frame still in the video to its last.
      const left = <T extends TimeRange>(r: T): T | undefined => {
        const framesCount = Math.round((r.end - r.start) * fps);
        let start: number | null = null, end: number | null = null;
        for (let i = 0; i < framesCount && start === null; i++) start = map(i ? r.start + i / fps : r.start, "right");
        for (let i = 0; i < framesCount && end === null; i++) end = map(i ? r.end - i / fps : r.end, "left");
        // Footage the edit put in between, or clips it reordered, would stretch the range over footage nobody called.
        if (start === null || end === null || end - start < 1 / fps - 1e-6 || end - start > r.end - r.start + 1 / fps) return undefined;
        return { ...r, start, end };
      };
      const cutReasons = change.cutReasons!.flatMap(r => {
        const moved = move(r), range = r.originalRange && move(r.originalRange);
        if (moved && (!r.originalRange || range)) return [{ ...moved, ...(range && { originalRange: range }) }];
        if (!r.legacySuggest && !editorChoice(change, r) && assessmentOf(change, r)?.verdict !== "ask")
          return drop(change, r, "A later edit changed the footage inside this staged cut, and nobody had called it.");
        const rest = left(r), around = r.originalRange && left(r.originalRange);
        if (!rest || (r.originalRange && !around)) return drop(change, r, "None of this staged cut's footage is left in one piece on the new version.");
        const placed = { ...rest, ...(around && { originalRange: around }) };
        changed.add(placed);
        return [placed];
      });
      const cutAssessments = change.cutAssessments?.flatMap(a => {
        const exact = move(a);
        if (exact) return [exact];
        const shortened = a.verdict === "ask" && left(a);
        return shortened ? [{ ...shortened, inspected: undefined }] : [];
      });
      return { ...change, cutReasons, cutAssessments,
        cutChoices: change.cutChoices?.flatMap(c => move(c) ?? left(c) ?? []) };
    }) : waiting.map(change => {
      const review = prepareCutReview(ctx, change).review;
      if (!review) throw conflict("cut_changed", "The previous part's cut list is unavailable. Its review is still saved.");
      const locate = currentCutRanges(ctx, project, change, review, current);
      const reasons: NonNullable<Change["cutReasons"]> = [], assessments: CutAssessment[] = [], choices: CutChoice[] = [];
      for (const [index, cut] of review.cuts.entries()) {
        const moved = locate(index);
        const check = (result: typeof moved) => {
          if (result.kind === "conflict") throw conflict("cut_changed", `The previous part's staged cut at ${cut.removed.start.toFixed(2)} s needs a new look: ${result.reason}`,
            { changeId: change.id, index, currentVersion: head, range: result.range });
          return result.kind === "gone" ? undefined : result.range;
        };
        const edited = change.cutEdits?.find(e => e.index === index);
        if (moved.kind === "gone") {
          const version = edited && edited.range.start === edited.range.end ? edited.version : head;
          alreadyRemoved.push({ changeId: change.id, index, version, at: moved.at });
          continue; // Its original decision stays in the historical review.
        }
        const placed = check(moved)!;
        const cutParts = change.cutReasons!.filter(r => r.start >= cut.removed.start - 1e-5 && r.end <= cut.removed.end + 1e-5);
        if (!cutParts.length) throw conflict("cut_changed", "The previous part's cut no longer matches its recorded range. Its review is still saved.",
          { changeId: change.id, index });
        for (const reason of cutParts) {
          const move = (r: TimeRange) => check(locate(index, { version: change.fromVersion, range: r }));
          const range = edited ? placed : move(reason);
          if (!range) continue;
          const originalRange = !edited && reason.originalRange ? move(reason.originalRange) : undefined;
          const slotFade = edited ? cutCrossfade(change, cut.removed) : reason.crossfade;
          const entry = { ...reason, ...range, originalRange, ...(slotFade !== undefined && { crossfade: slotFade }),
            ...(edited && cutParts.some(part => part.legacySuggest) && { legacySuggest: true as const }) };
          reasons.push(entry);
          if (edited || pending.get(change.id)?.has(index)) protectedCuts.set(entry, `${change.id}:${index}`);
          if (edited) {
            recoveredCuts.add(entry);
            break; // A recovered slot covers the reinspected cut, even if it originally joined several.
          }
        }
        const assessment = change.cutAssessments?.find(a => a.index === index);
        const choice = change.cutChoices?.find(c => c.index === index);
        if (assessment) assessments.push({ ...assessment, ...placed });
        if (choice) choices.push({ ...choice, ...placed });
      }
      return { ...change, cutReasons: reasons, cutAssessments: assessments, cutChoices: choices };
    });
    /** `asked` is where the plan put a cut the editor hasn't called, before it is moved onto the frame grid and the current version. */
    type Planned = DialogueCutsRequest["cuts"][number] & { crossfade?: number; legacySuggest?: true; assessment?: CutAssessment; choice?: CutChoice["choice"]; asked?: TimeRange;
      submitted?: true; recovered?: boolean; preserveEdges?: boolean; protectedSlot?: string; lapsed?: true; settled?: true };
    // The editor's call on a staged cut stands: a later part doesn't decide that range again.
    const moveToHead = (r: TimeRange) => {
      if (!toHead) return r;
      const start = toHead(r.start, "right"), end = toHead(r.end, "left");
      if (start === null || end === null || Math.abs(end - start - (r.end - r.start)) > 1 / fps) {
        const asked = editorAskedSince(ctx, projectId, fromVersion, head);
        throw conflict("cut_changed", `The edit changed around ${r.start.toFixed(1)} s while this part was decided. Reread the current timeline and map that passage again.` +
          (asked.length ? ` ${EDITOR_ASKED_MEANWHILE} ${asked.map(words => JSON.stringify(words)).join(", ")}.` : ""));
      }
      return { start, end };
    };
    const kept = body.kept ?? [];
    if (body.cuts.some(c => kept.some(k => (c.originalRange ?? c).start < k.end && k.start < (c.originalRange ?? c).end)))
      throw badRequest("invalid_cuts", "A removal reaches into footage marked to keep, including its restorable range.");
    const decided = earlier.flatMap(change => change.cutReasons!.filter(r => editorChoice(change, r)).map(outer));
    // A call belongs to the editor as soon as Scarlet asks. Bulk plans often repeat the same
    // footage as a new staged or confident cut. Carry the call and its number in either case.
    for (const change of earlier) {
      const reasons = change.cutReasons!;
      // A migrated Suggest obligation belongs to the full review slot, including any touching reasons.
      const inherited = reasons.some(r => r.legacySuggest) ? mergeRanges(reasons, 1e-5).filter(span =>
        reasons.some(r => r.legacySuggest && covers(span, r))) : [];
      for (const r of reasons) {
        const call = assessmentOf(change, r);
        if (call && (isPublishedCall(call) || call.askOrder !== undefined)) protectedCuts.set(r, `${change.id}:${call.index}`);
        // A cut staged on a same-word join (`unheard`) was the editor's from the moment it was staged, and no later cut
        // could take its place (2026-11-17). Since 2026-11-21 it is a staged cut like any other until the model asks the
        // editor about it: the model decides, and the default is in the skill. A later cut over its footage takes it out
        // of the review, and the save says so when part of it plays on (`droppedFromReview`).
        else if ((!call || call.provisional) && !editorChoice(change, r)) {
          const slot = inherited.find(span => covers(span, r));
          if (slot) protectedCuts.set(r, `${change.id}:pending:${slot.start}`);
        }
      }
    }
    const heldRanges = [...protectedCuts.keys()];
    const stagedWhy = whyConfidentCutsWait(sourceTask, project.branch);
    const requested = !stagedWhy;
    const candidates = body.cuts.map(c => ({ ...c, crossfade: frames / fps, ...(current && { ...moveToHead(c), ...(c.originalRange && { originalRange: moveToHead(c.originalRange) }) }),
      asked: { start: c.start, end: c.end } }));
    const overruled = candidates.filter(c => decided.some(d => overlaps(outer(c), d)));
    const held = candidates.filter(c => !overruled.includes(c) && heldRanges.some(r => overlaps(outer(c), outer(r)) ||
      ((c.review || !requested) && (Math.abs(c.start - r.end) < 1e-5 || Math.abs(c.end - r.start) < 1e-5))));
    // A staged cut Scarlet held for how its join measured is the model's to settle where it placed it: cut there, keep
    // it, or ask. A cut that takes its place with other edges, and applies only because the model sent unsureJoins cut,
    // swaps one join Scarlet couldn't place for another and changes what the line says, with no one hearing either:
    // held at "thing. ‖ And so in this video", a closing save cut "And so" as well and applied it (2026-11-18). The
    // staged cut stays, and the model is told.
    const heldCutsStay: NonNullable<DialogueCutsAdjustments["heldCutsStay"]> = [];
    const replacesHeld = candidates.filter(c => {
      if (c.review || !c.appliedAsPlaced || overruled.includes(c) || held.includes(c)) return false;
      const staged = earlier.flatMap(change => change.cutReasons!.filter(r => r.held && !editorChoice(change, r) &&
        overlaps(outer(c), outer(r)) && (Math.abs(outer(c).start - outer(r).start) >= LEFT_OF_STAGED_CUT || Math.abs(outer(c).end - outer(r).end) >= LEFT_OF_STAGED_CUT)));
      for (const r of staged) heldCutsStay.push({ asked: c.asked, staged: { start: r.start, end: r.end },
        why: `This cut takes the place of the staged cut at ${r.start.toFixed(2)}–${r.end.toFixed(2)} s with other edges, and Scarlet couldn't place its join either, so it applied only as unsureJoins cut. Moving a held cut onto other words changes what the line says. The staged cut stays as you first placed it: cut it there with unsureJoins cut, record keep, or ask the editor.` });
      return staged.length > 0;
    });
    const planned = candidates.filter(c => !overruled.includes(c) && !held.includes(c) && !replacesHeld.includes(c));
    const carried: Planned[] = [];
    let settledCount = 0;
    // A cut Scarlet settled goes in under what it found when it checked it.
    const settledWords = (r: { reason: string; summary?: string }, assessment: CutAssessment | undefined) =>
      assessment ? { reason: assessment.reason, summary: assessment.summary ?? r.summary } : { reason: r.reason, summary: r.summary };
    // A note on staged cuts that touch is about all of them: how many staged cuts each note covers.
    const noted = new Map<CutAssessment, number>();
    // A note settles its staged cuts only while it still covers them all: once this save decides one of them again, the
    // join the note was about is gone, and the rest wait for a new look as before.
    const decidedAgain = new Set<CutAssessment>();
    for (const change of earlier) for (const r of change.cutReasons!) {
      const assessment = assessmentOf(change, r);
      if (assessment && !editorChoice(change, r) && planned.some(c => overlaps(outer(c), outer(r)))) decidedAgain.add(assessment);
    }
    for (const change of earlier) for (const r of change.cutReasons!) {
      const choice = editorChoice(change, r), lapsed = choice === "cut" && changed.has(r);
      const assessment = assessmentOf(change, r);
      const settled = settle && requested && !lapsed && !decidedAgain.has(assessment!) && settledAsCut(r, choice, assessment);
      if (assessment) noted.set(assessment, (noted.get(assessment) ?? 0) + 1);
      // Touching ranges in one call can have overlapping original trim boundaries.
      const protectedSlot = protectedCuts.get(r);
      const clashes = carried.some(c => (!protectedSlot || c.protectedSlot !== protectedSlot) && overlaps(outer(c), outer(r)));
      if (protectedSlot && clashes)
        throw conflict("cut_changed", "Two earlier review slots now cover the same footage. Their existing reviews are still saved.");
      if (!choice && (clashes || planned.some(c => overlaps(outer(c), outer(r))))) {
        // A cut this save sends over the same footage takes a staged cut's place: a plan often sends a staged cut again.
        // One that takes only part of it leaves the rest playing with nothing staged there, and the agent is told.
        const over = planned.filter(c => overlaps(outer(c), outer(r)));
        const taken = mergeRanges(over.map(outer), 1e-6).reduce((n, c) => n + Math.max(0, Math.min(c.end, outer(r).end) - Math.max(c.start, outer(r).start)), 0);
        // An edge moved a few frames is the same cut. A syllable or more left over is footage nobody decided.
        const left = outer(r).end - outer(r).start - taken;
        if (over.length && left >= LEFT_OF_STAGED_CUT) drop(change, r, `A cut in this save (${over.map(c => `${c.asked.start.toFixed(2)}–${c.asked.end.toFixed(2)} s`).join(", ")}) takes part of this staged cut's footage, so it left the review, and ${left.toFixed(2)} s of what it would have removed plays on.`);
        continue;
      }
      if (settled) settledCount++;
      carried.push({ start: r.start, end: r.end, review: !settled, ...(settled ? settledWords(r, assessment) : { reason: r.reason, summary: r.summary }), ...(r.held && { held: r.held }), ...(r.unheard && { unheard: true as const }), crossfade: r.crossfade ?? change.joinFades?.duration, ...(r.originalRange && !settled && { originalRange: r.originalRange }), ...(settled && { settled: true as const }),
        ...(r.kind && { kind: r.kind }), ...(r.legacySuggest && { legacySuggest: true }), ...((current || protectedSlot) && { preserveEdges: true }), protectedSlot, ...(recoveredCuts.has(r) && { recovered: true }),
        ...(assessment && { assessment }), ...(choice && !lapsed ? { choice } : { asked: { start: r.start, end: r.end }, ...(lapsed && { lapsed }) }) });
    }
    let cuts: Planned[] = [...planned.map(c => ({ ...c, submitted: true as const })), ...carried].sort((a, b) => a.start - b.start);
    let duration = timelineDuration(base);
    assertCutRanges(body.cuts, duration);
    // A pass that repeats only calls already on this version has nothing to save or announce.
    if (!planned.length && !settledCount && (held.length || heldCutsStay.length) && waiting.length === 1 && !alreadyRemoved.length && waiting[0]!.fromVersion === head) {
      return { changes: waiting, carriedForward: carried.length, ...(held.length && { heldForReview: held.map(c => c.asked) }),
        ...(droppedFromReview.length && { droppedFromReview }), ...(heldCutsStay.length && { heldCutsStay }),
        ...(overruled.length && { editorDecided: overruled.map(c => c.asked) }) };
    }
    if (toHead) {
      if (!current) cuts = cuts.map(c => ({ ...c, ...moveToHead(c), ...(c.originalRange && { originalRange: moveToHead(c.originalRange) }) }));
      duration = timelineDuration(resolveTimeline(ctx, project, head));
    }
    const aligned = onWholeFrames(cuts, fps, duration, { range: body.range, kept, rebasing: !!toHead });
    cuts = aligned.cuts;
    const onFrames = aligned.onFrames;
    const satisfied = { ...(alreadyRemoved.length && { alreadyRemoved }), ...(droppedFromReview.length && { droppedFromReview }), ...(heldCutsStay.length && { heldCutsStay }) };
    if (!cuts.length) return { changes: [], ...satisfied };
    const applied = cuts.filter(c => requested && !c.review);
    const stagedConfident = stagedWhy ? cuts.filter(c => c.submitted && !c.review).length : 0;
    const adjusted = { ...satisfied, ...(onFrames && { onFrames }), ...(stagedConfident && { stagedForEditor: { cuts: stagedConfident, why: stagedWhy! } }),
      ...(settledCount && { settledApplied: { cuts: settledCount, why: "Staged cuts you checked and settled as cuts went into the video with this save. They left the review." } }) };
    if (protectedCuts.size) {
      let prior: Planned | undefined, removedBetween = 0;
      for (const cut of cuts) {
        if (requested && !cut.review) { removedBetween += cut.end - cut.start; continue; }
        if (prior && prior.protectedSlot !== cut.protectedSlot && cut.start - removedBetween < prior.end + 1e-5)
          throw conflict("cut_changed", "These edits would merge a cut waiting for review with another cut. Its previous review is still saved.");
        prior = cut;
        removedBetween = 0;
      }
    }
    // A staged cut's restorable range stops where a settled neighbor now goes in: that footage is out of the video.
    cuts = cuts.map(c => {
      if (!c.review || !c.originalRange) return c;
      let { start, end } = c.originalRange;
      for (const other of applied) {
        if (!other.settled || !overlaps(other, { start, end })) continue;
        if (other.end <= c.start + 1e-6) start = Math.max(start, other.end);
        else if (other.start >= c.end - 1e-6) end = Math.min(end, other.start);
      }
      return start === c.originalRange.start && end === c.originalRange.end ? c : { ...c, originalRange: { start, end } };
    });
    if (cuts.some(c => c.originalRange && (c.originalRange.end > duration + 1e-6 || applied.some(other => overlaps(other, c.originalRange!))))) {
      throw badRequest("invalid_cuts", "A staged cut's original boundaries reach into a range this plan removes. Keep them within the footage that stays for review.");
    }
    const ops = (ranges: typeof cuts) => [...ranges].reverse().map(({ start, end }) => ({ op: "rippleDelete" as const, start, end }));
    // The agent's sentence describes its whole plan. It names a change only when that change carries the whole plan;
    // a split plan gets a generated receipt for each part so neither part claims the other's cuts.
    const own = body.description?.trim();
    const whole = !carried.length && cuts.length === body.cuts.length && (applied.length === 0 || applied.length === cuts.length);
    let shift = 0;
    // Taking away what came out ahead can leave an edge a rounding error off its frame. Put back on it, staged cuts
    // that an applied cut brought together are listed as one cut by this part's review, not only by the next one's.
    const snapFrame = (t: number) => { const f = Math.round(t * fps) / fps; return Math.abs(f - t) < 1e-6 ? f : t; };
    const optional = cuts.flatMap(c => {
      if (requested && !c.review) { shift += c.end - c.start; return []; }
      return [{ ...c, start: snapFrame(c.start - shift), end: snapFrame(c.end - shift),
        originalRange: c.originalRange && { start: snapFrame(c.originalRange.start - shift), end: snapFrame(c.originalRange.end - shift) } }];
    });
    let version = head;
    const changes: Change[] = [];
    if (applied.length) {
      const { change } = persistProposal(ctx, user, projectId, { fromVersion: head, intent: "requested", ops: ops(applied),
        description: whole && own ? own : describeDialogueRemovals(applied), ...(body.batchTitle && { batchTitle: body.batchTitle }), taskId, author, noteIds }, ids[0], applied.map(({ start, end, reason, summary, kind, crossfade, check }) => ({ start, end, reason, summary, ...(kind && { kind }), ...(crossfade && { crossfade }), ...(check && { check }) })), { fold });
      if (change.state !== "approved") throw conflict("cut_changed", "The confident cuts could not be applied to this version.");
      changes.push(change);
      version = change.appliedVersion ?? change.toVersion;
    }
    // Staged cuts the editor hasn't called that now sit against footage they chose to keep. Their call covers them.
    const joined: TimeRange[] = [];
    if (optional.length) {
      const reasons = optional.map(({ start, end, reason, summary, originalRange, kind, crossfade, legacySuggest, held, unheard }) => ({ start, end, reason, summary, originalRange, ...(kind && { kind }), ...(crossfade && { crossfade }), ...(legacySuggest && { legacySuggest }), ...(held && { held }), ...(unheard && { unheard }) }));
      const { change } = persistProposal(ctx, user, projectId, { fromVersion: version, intent: "suggestion", autoApprove: false,
        ops: ops(optional), description: whole && own ? own : `Review ${optional.length} optional dialogue ${optional.length === 1 ? "cut" : "cuts"}`,
        taskId, author, noteIds }, ids[1], reasons, { fold });
      // A carried cut keeps the recommendation and the editor's call recorded on it, under its number and range in this
      // review's own cut list. A note carries only onto a cut made of the same staged cuts. An approval carries onto any
      // cut whose staged cuts were all approved, so cuts that came apart each keep the call made on them. Footage the
      // editor chose to keep stays kept, with whatever joined it, until they say otherwise.
      // In a pass Scarlet has assessed, a cut that lost its note or the editor's approval waits for the editor, as a
      // revised cut does: the pass still reads as assessed, so nothing unchecked applies. Scarlet's next note on that cut
      // replaces this one. The pass doesn't apply itself while a cut waits for the editor because of this carry, or
      // over an approval that no longer holds.
      const assessed = earlier.some(c => c.cutAssessments?.length);
      const cutAssessments: CutAssessment[] = [], cutChoices: CutChoice[] = [];
      const cutEdits: NonNullable<Change["cutEdits"]> = [];
      let reopened = false;
      const listed = assessed || optional.some(c => c.choice || c.recovered || c.lapsed) ? prepareCutReview(ctx, change).review?.cuts ?? [] : [];
      const within = ({ start, end }: TimeRange) => optional.filter(c => covers({ start, end }, c));
      // A replaced assessment still needs a recommendation on its new footage before the editor sees it.
      const ask = (index: number, { start, end }: TimeRange): CutAssessment => {
        const cutParts = within({ start, end });
        const summaries = [...new Set(cutParts.map(c => c.summary))];
        return { index, start, end, verdict: "ask", provisional: true,
          summary: summaries.every(Boolean) ? summaries.join(" ").slice(0, SUMMARY_MAX).trim() || undefined : undefined,
          reason: [...new Set(cutParts.map(c => c.reason))].join(" ").slice(0, 800).trim() || "No note was saved for this cut." };
      };
      for (const [index, { removed: { start, end } }] of listed.entries()) {
        const inside = within({ start, end });
        if (inside.some(c => c.recovered)) {
          const source = resolveTimeline(ctx, project, version);
          const previewVersion = storeRevisedCutPreview(ctx, project.id, source, { start, end }, { reviewId: change.toVersion, crossfade: cutCrossfade(change, { start, end }), parent: version });
          cutEdits.push({ index, version, range: { start, end }, previewVersion });
        }
        const assessment = inside[0]?.assessment;
        const keptSlot = inside.some(c => c.choice === "keep"), approved = inside.length > 0 && inside.every(c => c.choice === "cut");
        const lapsed = !keptSlot && !approved && inside.some(c => c.choice || c.lapsed);
        if (assessment && noted.get(assessment) === inside.length && inside.every(c => c.assessment === assessment)) cutAssessments.push({ ...assessment, index, start, end });
        else if (assessed && (lapsed || inside.some(c => c.assessment))) {
          cutAssessments.push(ask(index, { start, end }));
          if (!keptSlot && !approved) reopened = true;
        }
        if (keptSlot || approved) cutChoices.push({ index, start, end, choice: keptSlot ? "keep" : "cut" });
        else if (lapsed) reopened = true;
        if (keptSlot) joined.push(...inside.flatMap(c => c.asked ?? []));
      }
      // Every note went with cuts this part decided again. A pass without notes reads as unassessed, where Approve takes
      // every cut, also one a later part stages. So each cut left gets the note: a cut the editor has called keeps their
      // call, and the others wait for them.
      if (assessed && !cutAssessments.length) {
        cutAssessments.push(...listed.map(({ removed }, index) => ask(index, removed)));
        if (!listed.length || listed.some((_, index) => !cutChoices.some(c => c.index === index))) reopened = true;
      }
      const applyWhenDone = reopened ? undefined : earlier.find(c => c.applyWhenDone)?.applyWhenDone;
      const keptFields = { ...(cutEdits.length && { cutEdits }), ...(cutAssessments.length && { cutAssessments }), ...(cutChoices.length && { cutChoices }), ...(applyWhenDone && { applyWhenDone }) };
      changes.push(Object.keys(keptFields).length ? saveChange(ctx, { ...change, ...keptFields }) : change);
    }
    // The previous part's review now lives in this one, or this part's cuts moved the edit past it.
    if (changes.length) for (const change of waiting) {
      putAway(ctx, change, CARRIED, (changes.find(c => c.intent === "suggestion") ?? changes[0]!).id);
    }
    const editorDecided = [...overruled.map(c => c.asked), ...joined].sort((a, b) => a.start - b.start);
    return { changes, ...adjusted, ...(held.length && { heldForReview: held.map(c => c.asked) }), ...(carried.length && { carriedForward: carried.length }), ...(editorDecided.length && { editorDecided }),
      joinCrossfades: joinCrossfadeReport(frames, changes) };
  }));
}

/**
 * Put a waiting pass's settled cuts into the video outside a save of its run's own, once the run has finished. While the
 * run still works they go in with its next save instead, so the review it is checking doesn't move under it. Returns the pass's review as it stands after, or nothing when nothing went in.
 */
export function applySettledCuts(ctx: Ctx, change: Change): Change | undefined {
  if (!change.id.endsWith("_review") || !change.taskId || !hasSettledCut(change)) return;
  const task = ctx.repos.tasks.get(change.taskId);
  const project = ctx.repos.projects.header(change.projectId);
  if (!task || !project?.head || (task.context.branch && task.context.branch !== project.branch)) return;
  const attempts = runAttemptIds(project.id, task.resumeRootId ?? task.id);
  if (ctx.repos.tasks.select(`project_id = ? AND id IN (${attempts.sql})`, [project.id, ...attempts.params]).some(t => !FINISHED_TASK.has(t.state))) return;
  const user = (task.createdBy.id && ctx.repos.users.get(task.createdBy.id)) || ctx.repos.users.primary();
  if (!user) return;
  try {
    const { changes, settledApplied } = submitDialogueCuts(ctx, user, project.id, { taskId: change.taskId, fromVersion: project.head, cuts: [],
      description: change.description, author: change.author, noteIds: change.noteIds }, { fold: true });
    if (!settledApplied) return;
    ctx.db.afterCommit(() => ctx.log(`[review] settled_applied change=${logId(change.id)} project=${logId(project.id)} cuts=${settledApplied.cuts}`));
    return changes.find(c => c.intent === "suggestion") ?? changes[0];
  } catch (error) {
    ctx.log(`[review] Could not put the settled cuts of ${change.id} into the video: ${errorMessage(error)}`);
  }
}
