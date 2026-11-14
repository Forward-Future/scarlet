import { createHash } from "node:crypto";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { run } from "../render/ffmpeg.js";
import { boundedRippleOps, rippleDrift, cutAnchorOn, cutScope, selectedRange, selectionPlacements, taskDialogueOperation, type DialogueCutsRequest, type JoinCrossfades, reviewItemPath, type StagedCutRevision } from "@scarlet/shared";
import type { ApproveResponse, ProposeChangeRequest, Task, User } from "@scarlet/shared";
import { z } from "zod/v3";
import { ReviseRequest as ReviseRequestSchema } from "@scarlet/shared";
import { frameAligned, frameAlignedRemoval, isPublishedCall, onFrame, makeStagedCutMapper,
  clipEnd,
  crossfadeJoins,
  type JoinFades,
  applyOps,
  historyLineage,
  replayHistoryEdit,
  type ApplyPlan,
  planCutReview,
  cutPlaybackWindow,
  CUT_LEAD_SECONDS,
  CUT_TAIL_SECONDS,
  isolatedReviewCut,
  leftOutJoins,
  applyReviewRemovals,
  appliedCutReview,
  appliedReviewChange,
  reviewedTimeline,
  assignSpots,
  independentCutSpots,
  independentClipSpots,
  type Change,
  type CutAssessment,
  type CutChoice,
  type CutReview,
  makeTimeMap,
  mergeRanges,
  clipById, describeDiff,
  describeDialogueRemovals,
  diffTimelines,
  timelineDuration,
  newId,
  OpError,
  planApply,
  WritableTimeline,
  TimelineOp,
  withHandles,
  type Author,
  type Note,
  type Project,
  type Timeline,
  type TimelineDiff,
  type TimeRange,
} from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import type { BusEvents } from "../events.js";
import { requestCutPlaybackFile, waitForPlayback } from "./playback.js";
import { now } from "../db.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { notify } from "./notify.js";
import { createTask, FINISHED_TASK, parseAssignTo, isDialoguePass, queueRepeatCheck, saveTask } from "./tasks.js";
import { ensureHead, resolveTimeline, storeValidatedVersion, storeVersion } from "./timeline.js";
import { actorFor, authorName, logActivity, quote } from "./activity.js";
import { beginRevision, proposalAfterRevisions, resumeReviewState } from "./revisionState.js";
import { currentCutRanges, placeRevision, reviewedCutsOnHead } from "./stagedCutRecovery.js";
import { removalOutsideSelection, rippleOutsideSelection } from "./selectedRemoval.js";

export function authorFor(user: User, override?: Partial<Author>): Author {
  const base: Author = { type: "human", id: user.id, name: user.name };
  const merged = { ...base, ...Object.fromEntries(Object.entries(override ?? {}).filter(([, v]) => v !== undefined)) } as Author;
  return merged;
}

function saveChange(ctx: Ctx, change: Change): Change {
  const saved = ctx.repos.changes.put({ ...change, updatedAt: now() });
  ctx.bus.publish({ type: "change.updated", projectId: saved.projectId, change: saved });
  // A dialogue pass's staged cuts hold the project's other requests until the editor has decided them. A host waiting
  // for work hears of a request only when one is queued, so it is told when the pass stops holding one too: it would
  // otherwise find out at its next ask, up to 25 s later (2026-11-08: a request began 17 s after the last call).
  if (saved.intent === "suggestion" && saved.cutReasons?.length && saved.state !== "ready" && saved.state !== "revising") {
    const [held] = ctx.repos.tasks.select("project_id = ? AND state = 'queued' AND kind != 'transcribe'", [saved.projectId], "created_at ASC, rowid ASC LIMIT 1");
    if (held) ctx.bus.taskQueued({ taskId: held.id, projectId: saved.projectId });
  }
  return saved;
}

/**
 * The editor sent one call of a dialogue pass back to Scarlet. A pass they had set to apply when Scarlet finishes was
 * scheduled on the calls as they stood, and the request about this one waits behind the run: applied on schedule, the
 * pass would go in with the old cut and leave the request nothing to revise. So the schedule is taken back, the pass
 * waits for the revised cut, and the editor applies it. The request names the pass as it stood when they sent it; when
 * a revision or a later part of the pass has replaced that one, the pass that waits now is the one held. Caller holds
 * the write lock.
 */
export function callSentBack(ctx: Ctx, request: Task): void {
  const { changeId, cutIndex } = request.context;
  const named = changeId && cutIndex !== undefined ? ctx.repos.changes.get(changeId) : undefined;
  if (named?.projectId !== request.projectId) return;
  const pass = passToRevise(ctx, named, request.id, cutIndex!)?.change ?? named;
  if (pass.applyWhenDone && pass.intent === "suggestion" && pass.cutReasons?.length && (pass.state === "ready" || pass.state === "revising"))
    saveChange(ctx, { ...pass, applyWhenDone: undefined });
}

export async function withSpotCapability(ctx: Ctx, change: Change, projectFps?: number): Promise<Change> {
  if (!change.ops?.length || change.ranges.length < 2) return change;
  const fps = projectFps ?? ctx.repos.projects.header(change.projectId)?.settings.fps;
  if (!fps || change.spotAssignment?.fps === fps) return change;
  const key = JSON.stringify([change.projectId, change.id, change.fromVersion, change.toVersion, fps]);
  const signal = ctx.projectSignal(change.projectId);
  const owners = await ctx.track(ctx.spotChecks.get(key, async () => {
    const entry = isSea() ? "review-spots" : fileURLToPath(new URL("./spotWorker.mjs", import.meta.url));
    const result = await run(process.execPath, [entry, ctx.paths.db, change.id, String(fps)], { signal });
    return JSON.parse(result.toString()) as Array<number | null> | null;
  }));
  signal.throwIfAborted();
  return ctx.db.transaction(() => {
    const current = ctx.repos.changes.get(change.id);
    if (!current || current.fromVersion !== change.fromVersion || current.toVersion !== change.toVersion ||
        current.spotAssignment?.fps === fps || ctx.repos.projects.header(change.projectId)?.settings.fps !== fps) return current ?? change;
    const saved = ctx.repos.changes.put({ ...current, canApproveSpots: owners !== null, spotAssignment: { fps, owners } });
    ctx.bus.publish({ type: "change.updated", projectId: saved.projectId, change: saved });
    return saved;
  }, "immediate")();
}

/** Publish the verified capability when ready, without delaying a history snapshot. */
export function scheduleSpotCheck(ctx: Ctx, change: Change, fps: number): void {
  if (change.state !== "ready" || !change.ops?.length || change.ranges.length < 2 || change.spotAssignment?.fps === fps) return;
  ctx.db.afterCommit(() => {
    ctx.track(withSpotCapability(ctx, change, fps)).catch(error => {
      if (!ctx.shutdown.aborted) ctx.log(`[review] Could not check spots for ${change.id}: ${error}`);
    });
  });
}

/** The stretch to play on each side of a spot, padded by the editor's handles and kept inside each version. */
function spotWindows(diff: TimelineDiff, spot: TimelineDiff["spots"][number], handle: number) {
  return { range: withHandles(spot.after, handle, diff.durationAfter), beforeRange: withHandles(spot.before, handle, diff.durationBefore) };
}

function assertMediaExists(project: Project, tl: Timeline) {
  const ids = new Set(project.media.map((m) => m.id));
  for (const t of tl.tracks) {
    for (const c of t.clips) {
      if (c.kind === "media" && !ids.has(c.mediaId)) {
        throw badRequest("unknown_media", `clip ${c.id} references unknown media ${c.mediaId}`, { clipId: c.id, mediaId: c.mediaId });
      }
    }
  }
}

type FadedJoin = { at: number; duration: number };
type CutReason = NonNullable<Change["cutReasons"]>[number];

/** A pre-upgrade dialogue proposal recorded one overlap for all its joins. */
function cutCrossfade(change: Change, range: TimeRange): number {
  const reasons = change.cutReasons ?? [];
  return Math.max(0, ...reasons.filter(r => r.end > range.start + 1e-6 && r.start < range.end - 1e-6)
    .map(r => r.crossfade ?? change.joinFades?.duration ?? 0));
}

/** Adjacent removals make one join. Apply the longer requested overlap once, using real source handles. */
function fadeJoins(project: Project, timeline: Timeline, joins: readonly FadedJoin[]): { timeline: Timeline; joinFades?: JoinFades } {
  const durations = new Map<number, number>();
  for (const { at, duration } of joins) {
    if (duration > 0) durations.set(at, Math.max(durations.get(at) ?? 0, duration));
  }
  if (!durations.size) return { timeline };
  const duration = durations.values().next().value!;
  const faded = crossfadeJoins(timeline, project.media, [...durations.keys()], duration, { durations });
  if (!faded.fades.length && !faded.report.plain.length) return { timeline };
  return { timeline: faded.timeline, joinFades: { duration, fades: faded.fades, plain: faded.report.plain } };
}

/** Reasons are stored in chronological order on the base timeline. */
function proposalJoins(reasons: CutReason[]): FadedJoin[] {
  let shift = 0;
  let previousEnd = -1, previousAt = 0;
  return reasons.map(cut => {
    const at = Math.abs(cut.start - previousEnd) < 1e-6 ? previousAt : cut.start - shift;
    previousAt = at;
    previousEnd = cut.end;
    shift += cut.end - cut.start;
    return { at, duration: cut.crossfade ?? 0 };
  });
}

function reviewedJoins(change: Change, review: CutReview, restored: readonly number[]): FadedJoin[] {
  const kept = new Set(restored);
  // Older passes deferred the fade on an applied cut touching a staged cut. A restored
  // cut can expose that join again on its boundary.
  const legacy = !!change.joinFades && !change.cutReasons?.some(r => r.crossfade !== undefined);
  let shift = 0;
  return review.cuts.flatMap((cut, i) => {
    const at = cut.at + shift;
    const duration = cutCrossfade(change, cut.removed);
    if (!kept.has(i)) return [{ at, duration }];
    shift += cut.removed.end - cut.removed.start;
    return legacy ? [{ at, duration }, { at: at + cut.removed.end - cut.removed.start, duration }] : [];
  });
}

/** What the requested crossfades did on the joins these dialogue changes made, for the agent that made them. */
function joinCrossfadeReport(frames: number, changes: readonly Change[]): JoinCrossfades | undefined {
  if (!changes.length) return;
  let faded = 0;
  const plain: JoinCrossfades["plain"] = [];
  for (const change of changes) {
    const record = change.joinFades;
    if (!record) continue;
    const held = new Set(record.plain.map(p => p.at));
    faded += new Set(record.fades.map(f => f.at).filter(at => !held.has(at))).size;
    plain.push(...record.plain.map(p => ({ version: change.toVersion, ...p })));
  }
  return { frames, faded, plain };
}

export interface ProposeResult {
  duration: number;
  diffDescription: string[];
  change: Change;
  timeline: Timeline;
  /** Removals inside a selected passage that the engine put on whole frames: what was asked and what was removed. */
  onWholeFrames?: Array<{ asked: [number, number]; removed: [number, number] }>;
}

/** Apply a proposed change: store the new version, diff, record the review windows without encoding footage. */
function selectedStagedCut(ctx: Ctx, task?: Task | null) {
  if (!task || (task.kind !== "revise" && task.kind !== "edit") || !task.context.changeId || task.context.cutIndex === undefined) return;
  const change = ctx.repos.changes.get(task.context.changeId);
  if (!change || change.projectId !== task.projectId) throw badRequest("wrong_cut", "The selected cut is unavailable.");
  let staged = task.stagedCutRevision ?? (task.kind === "revise" || change.intent === "suggestion" &&
    (["ready", "revising"].includes(change.state) || !!change.replacedBy));
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

export function proposeChange(ctx: Ctx, user: User, projectId: string, body: ProposeChangeRequest, checkAttempt?: () => void): ProposeResult {
  // Recovery, review and subscribers must see the proposal and its task link together.
  return ctx.db.transaction(() => {
    checkAttempt?.();
    requireUnscopedEdit(ctx, body.taskId ? ctx.repos.tasks.get(body.taskId) : undefined);
    const aligned = opsOnWholeFrames(ctx, projectId, body);
    const result = persistProposal(ctx, user, projectId, aligned);
    // Inside a selected passage the engine places each removal itself, so the agent is told each one it moved.
    if (!aligned.range || !body.ops || aligned.ops?.length !== body.ops.length) return result;
    const round3 = (t: number) => Math.round(t * 1000) / 1000;
    const onWholeFrames = body.ops.flatMap((op, i) => {
      const saved = aligned.ops![i]!;
      if (op.op !== "rippleDelete" || saved.op !== "rippleDelete") return [];
      return Math.abs(op.start - saved.start) > 1e-6 || Math.abs(op.end - saved.end) > 1e-6
        ? [{ asked: [op.start, op.end] as [number, number], removed: [round3(saved.start), round3(saved.end)] as [number, number] }] : [];
    });
    return onWholeFrames.length ? { ...result, onWholeFrames } : result;
  }, "immediate")();
}

/**
 * An agent's ripple removals land on whole frames, as its dialogue cuts do. A removal that ends between two frames
 * leaves the tracks after it a fraction of a frame apart, which shows as one black frame at the join: twice an agent
 * found that by inspecting frames, and redoing its cuts by hand took one pass seven minutes (2026-11-07). A removal
 * that runs to the end of the edit keeps its end, which need not be on a frame.
 *
 * Every other time an agent gives within a millisecond of a frame is that frame. Tools print times to four decimals,
 * so a gap opened at 1248.7667 s for frame 37,463 put every later clip 33 microseconds off the frames, and each
 * removal after it left a clip that long behind (2026-11-08).
 */
function opsOnWholeFrames(ctx: Ctx, projectId: string, body: ProposeChangeRequest): ProposeChangeRequest {
  const task = body.taskId ? ctx.repos.tasks.get(body.taskId) : undefined;
  if (!task && !body.range) return body;
  const project = ctx.repos.projects.header(projectId);
  const version = body.fromVersion ?? project?.head;
  if (!project || !version) return body;
  if (body.range || (selectedRange(task?.context) && body.ops?.every(op => op.op === "rippleDelete" && !op.trackIds))) {
    const base = resolveTimeline(ctx, project, version);
    const anchor = task?.context ?? {};
    const original = anchor.version && anchor.version !== "head" && anchor.version !== base.version ? resolveTimeline(ctx, project, anchor.version) : undefined;
    try {
      const range = cutScope(base, cutAnchorOn(anchor, base, original), body.range);
      if (!body.ops?.length || body.timeline) throw new Error("A bounded ripple edit takes synchronized ripple removals on an existing timeline.");
      return { ...body, range, ops: boundedRippleOps(body.ops, range, project.settings.fps, timelineDuration(base)) };
    } catch (error) {
      throw badRequest("cut_scope", (error as Error).message);
    }
  }
  if (!body.ops?.length) return body;
  const row = ctx.db.prepare("SELECT duration FROM timeline_versions WHERE project_id = ? AND version = ?")
    .get(projectId, version) as { duration: number | null } | undefined;
  if (!row) return body;
  const fps = project.settings.fps;
  // Old versions may lack the duration saved with the timeline. Only a removal needs its end.
  let duration = row.duration;
  const near = <T extends object>(o: T, keys: string[]): T => {
    const values = o as Record<string, unknown>;
    const moved = keys.filter(k => typeof values[k] === "number" && onFrame(values[k], fps) !== values[k]);
    return moved.length ? { ...o, ...Object.fromEntries(moved.map(k => [k, onFrame(values[k] as number, fps)])) } : o;
  };
  const clipTimes = ["timelineIn", "sourceIn", "sourceOut"];
  // Each removal is written on the edit the earlier ones leave as asked. One that went onto frames took out a little
  // less, so a later one moves by that before it goes onto frames, or it lands early on the footage (rippleDrift).
  const drift = rippleDrift();
  return { ...body, ops: body.ops.map(op => {
    if (op.op === "rippleDelete" && typeof op.start === "number" && typeof op.end === "number") {
      duration ??= timelineDuration(resolveTimeline(ctx, project, version));
      const placed = drift.place(op);
      const aligned = selectedRange(task?.context) ? frameAlignedRemoval(placed, fps, placed) : frameAligned(placed, fps);
      const removed = { start: aligned.start, end: placed.end >= duration - 1e-6 ? placed.end : aligned.end };
      if (!op.trackIds) drift.removed(op, removed);
      return { ...op, ...removed };
    }
    if (op.op === "rippleInsertGap") return near(op, ["at", "duration"]);
    if (op.op === "moveClip") return near(op, ["timelineIn"]);
    if (op.op === "splitClip") return near(op, ["at"]);
    if (op.op === "addClip" && op.clip && typeof op.clip === "object") return { ...op, clip: near(op.clip, clipTimes) };
    if (op.op === "updateClip" && op.patch && typeof op.patch === "object") return { ...op, patch: near(op.patch, clipTimes) };
    return op;
  }) };
}

// A resumed run still owns its earlier parts. A cut the editor sent back can be in a successor made by its own task.
function dialogueParts(projectId: string, rootId: string) {
  const ids = `WITH RECURSIVE parts(id) AS (
    SELECT id FROM changes WHERE project_id = ? AND json_extract(json, '$.taskId') IN
      (SELECT id FROM tasks WHERE id = ? OR json_extract(json, '$.resumeRootId') = ?)
    UNION SELECT c.id FROM parts JOIN tasks t ON json_extract(t.json, '$.context.changeId') = parts.id
      JOIN changes c ON json_extract(c.json, '$.taskId') = t.id
      WHERE c.project_id = ? AND t.project_id = ? AND json_extract(t.json, '$.context.cutIndex') IS NOT NULL
    UNION SELECT json_extract(c.json, '$.replacedBy') FROM parts JOIN changes c ON c.id = parts.id
      WHERE json_extract(c.json, '$.rejectReason') = ? AND json_extract(c.json, '$.replacedBy') IS NOT NULL
  ) SELECT id FROM parts`;
  return { ids, args: [projectId, projectId, rootId, rootId, projectId, projectId, REVISED] };
}

/**
 * Both writes commit together; optional ranges start on the kept version. Stable IDs make response-loss retries safe.
 * `fold` gathers the waiting parts of a run that has finished, with no cuts of its own: only Scarlet's own repair saves under such a run.
 */
export function submitDialogueCuts(ctx: Ctx, user: User, projectId: string, body: DialogueCutsRequest, { fold = false, checkAttempt }: { fold?: boolean; checkAttempt?: () => void } = {}): {
  changes: Change[]; carriedForward?: number; editorDecided?: TimeRange[]; heldForReview?: TimeRange[];
  alreadyRemoved?: { changeId: string; index: number; version: string; at: number }[];
  /** The requested crossfade on the joins these cuts made. Absent when nothing was saved. */
  joinCrossfades?: JoinCrossfades;
} & DialogueCutsAdjustments {
  return ctx.db.transaction(() => ctx.bus.asSaved(() => {
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
    const project = ctx.repos.projects.get(projectId);
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
        throw badRequest("cut_scope", (error as Error).message);
      }
    }
    // The editor or another request can change the edit while a part is being decided. Its cuts are anchored in
    // the footage, so they move onto the current version unless footage inside one of them changed.
    const toHead = head === fromVersion ? undefined : makeTimeMap(base, resolveTimeline(ctx, project, head), fps);
    // A pass saved in parts: the run's previous parts left their staged cuts waiting. They join this part's review so
    // they stay reviewable once this part's cuts apply. A run resumed after an interruption still owns its earlier parts.
    const rootId = taskId && (ctx.repos.tasks.get(taskId)?.resumeRootId ?? taskId);
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
    const covers = (a: TimeRange, r: TimeRange) => r.start >= a.start - 1e-5 && r.end <= a.end + 1e-5;
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
        const frames = Math.round((r.end - r.start) * fps);
        let start: number | null = null, end: number | null = null;
        for (let i = 0; i < frames && start === null; i++) start = map(i ? r.start + i / fps : r.start, "right");
        for (let i = 0; i < frames && end === null; i++) end = map(i ? r.end - i / fps : r.end, "left");
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
        const parts = change.cutReasons!.filter(r => r.start >= cut.removed.start - 1e-5 && r.end <= cut.removed.end + 1e-5);
        if (!parts.length) throw conflict("cut_changed", "The previous part's cut no longer matches its recorded range. Its review is still saved.",
          { changeId: change.id, index });
        for (const reason of parts) {
          const move = (r: TimeRange) => check(locate(index, { version: change.fromVersion, range: r }));
          const range = edited ? placed : move(reason);
          if (!range) continue;
          const originalRange = !edited && reason.originalRange ? move(reason.originalRange) : undefined;
          const slotFade = edited ? cutCrossfade(change, cut.removed) : reason.crossfade;
          const entry = { ...reason, ...range, originalRange, ...(slotFade !== undefined && { crossfade: slotFade }),
            ...(edited && parts.some(part => part.legacySuggest) && { legacySuggest: true as const }) };
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
    const outer = (c: { start: number; end: number; originalRange?: { start: number; end: number } }) => c.originalRange ?? c;
    const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end - 1e-6 && a.end > b.start + 1e-6;
    /** `asked` is where the plan put a cut the editor hasn't called, before it is moved onto the frame grid and the current version. */
    type Planned = DialogueCutsRequest["cuts"][number] & { crossfade?: number; legacySuggest?: true; assessment?: CutAssessment; choice?: CutChoice["choice"]; asked?: TimeRange;
      submitted?: true; recovered?: boolean; preserveEdges?: boolean; protectedSlot?: string; lapsed?: true };
    // The editor's call on a staged cut stands: a later part doesn't decide that range again.
    const moveToHead = (r: TimeRange) => {
      if (!toHead) return r;
      const start = toHead(r.start, "right"), end = toHead(r.end, "left");
      if (start === null || end === null || Math.abs(end - start - (r.end - r.start)) > 1 / fps) {
        throw conflict("cut_changed", `The edit changed around ${r.start.toFixed(1)} s while this part was decided. Reread the current timeline and map that passage again.`);
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
        else if ((!call || call.provisional) && !editorChoice(change, r)) {
          const slot = inherited.find(span => covers(span, r));
          if (slot) protectedCuts.set(r, `${change.id}:pending:${slot.start}`);
        }
      }
    }
    const heldRanges = [...protectedCuts.keys()];
    const task = taskId && ctx.repos.tasks.get(taskId);
    const requested = task && task.createdBy.type === "human" && ["edit", "revise", "note"].includes(task.kind) &&
      task.context.branch === project.branch && !task.context.reviewAllCuts;
    // Why confident cuts wait for the editor here instead of applying. The agent sent them as cuts, so it is told.
    const stagedWhy = requested ? undefined : !task ? "No request of the editor's is attached, so every cut waits for them."
      : task.context.reviewAllCuts ? "The editor asked to review every cut."
      : task.createdBy.type !== "human" ? "Scarlet started this request, not the editor, so its cuts wait for them."
      : !["edit", "revise", "note"].includes(task.kind) ? `A ${task.kind} request stages its cuts for the editor.`
      : "The editor moved to another version of the edit while this request ran.";
    const candidates = body.cuts.map(c => ({ ...c, crossfade: frames / fps, ...(current && { ...moveToHead(c), ...(c.originalRange && { originalRange: moveToHead(c.originalRange) }) }),
      asked: { start: c.start, end: c.end } }));
    const overruled = candidates.filter(c => decided.some(d => overlaps(outer(c), d)));
    const held = candidates.filter(c => !overruled.includes(c) && heldRanges.some(r => overlaps(outer(c), outer(r)) ||
      ((c.review || !requested) && (Math.abs(c.start - r.end) < 1e-5 || Math.abs(c.end - r.start) < 1e-5))));
    const planned = candidates.filter(c => !overruled.includes(c) && !held.includes(c));
    const carried: Planned[] = [];
    // A note on staged cuts that touch is about all of them: how many staged cuts each note covers.
    const noted = new Map<CutAssessment, number>();
    for (const change of earlier) for (const r of change.cutReasons!) {
      const choice = editorChoice(change, r), lapsed = choice === "cut" && changed.has(r);
      const assessment = assessmentOf(change, r);
      if (assessment) noted.set(assessment, (noted.get(assessment) ?? 0) + 1);
      // Touching ranges in one call can have overlapping original trim boundaries.
      const protectedSlot = protectedCuts.get(r);
      const clashes = carried.some(c => (!protectedSlot || c.protectedSlot !== protectedSlot) && overlaps(outer(c), outer(r)));
      if (protectedSlot && clashes)
        throw conflict("cut_changed", "Two earlier review slots now cover the same footage. Their existing reviews are still saved.");
      if (!choice && (clashes || planned.some(c => overlaps(outer(c), outer(r))))) continue;
      carried.push({ start: r.start, end: r.end, review: true, reason: r.reason, crossfade: r.crossfade ?? change.joinFades?.duration, ...(r.originalRange && { originalRange: r.originalRange }),
        ...(r.kind && { kind: r.kind }), ...(r.legacySuggest && { legacySuggest: true }), ...((current || protectedSlot) && { preserveEdges: true }), protectedSlot, ...(recoveredCuts.has(r) && { recovered: true }),
        ...(assessment && { assessment }), ...(choice && !lapsed ? { choice } : { asked: { start: r.start, end: r.end }, ...(lapsed && { lapsed }) }) });
    }
    let cuts: Planned[] = [...planned.map(c => ({ ...c, submitted: true as const })), ...carried].sort((a, b) => a.start - b.start);
    let duration = timelineDuration(base);
    const sorted = [...body.cuts].sort((a, b) => a.start - b.start);
    // Say which range is wrong: the agent sees only this message, and a plan it can't place it submits again unchanged.
    const span = (c: TimeRange) => `${c.start.toFixed(2)}–${c.end.toFixed(2)} s`;
    const empty = sorted.find(c => c.end <= c.start), past = sorted.find(c => c.end > duration);
    const second = sorted.findIndex((c, i) => i > 0 && c.start < sorted[i-1]!.end);
    if (empty) throw badRequest("invalid_cuts", `The range ${span(empty)} is empty. Give each range an end after its start.`);
    if (past) throw badRequest("invalid_cuts", `The range ${span(past)} runs past the end of the timeline at ${duration.toFixed(2)} s.`);
    if (second > 0) throw badRequest("invalid_cuts", `The ranges ${span(sorted[second-1]!)} and ${span(sorted[second]!)} overlap. End the first where the second starts, or merge them.`);
    if (sorted.reduce((n, c) => n + c.end - c.start, 0) >= duration - 1e-7) throw badRequest("invalid_cuts", "These ranges remove the whole timeline. Retain some footage.");
    // A pass that repeats only calls already on this version has nothing to save or announce.
    if (!planned.length && held.length && waiting.length === 1 && !alreadyRemoved.length && waiting[0]!.fromVersion === head) {
      return { changes: waiting, carriedForward: carried.length, heldForReview: held.map(c => c.asked),
        ...(droppedFromReview.length && { droppedFromReview }),
        ...(overruled.length && { editorDecided: overruled.map(c => c.asked) }) };
    }
    if (toHead) {
      if (!current) cuts = cuts.map(c => ({ ...c, ...moveToHead(c), ...(c.originalRange && { originalRange: moveToHead(c.originalRange) }) }));
      duration = timelineDuration(resolveTimeline(ctx, project, head));
    }
    // Whole frames: a cut of a whole number of frames moves everything after it by whole frames, so the cached preview
    // sections after it still match. Rounding inward never removes more than the plan; a sub-frame cut rounds to the nearest
    // frame, and stops at the end of an edit that ends between two frames: a cut past the end has no review.
    const bounded = !!body.range || kept.length > 0;
    const asPlanned = cuts.map(c => ({ start: c.start, end: c.end }));
    const beforeFrames = cuts;
    cuts = cuts.map((c, i) => {
      if (c.preserveEdges) return c; // A manual trim can put the same source frames between project frames.
      // The submitted limits refer to the submitted version. When rebasing, round within the
      // mapped removal itself so a nearby frame on the new timeline cannot escape those limits.
      const scope = c.submitted ? (bounded && toHead ? c : body.range) : undefined;
      const retained = c.submitted && !toHead ? kept : [];
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
    const onFrames = shifts.length ? { cuts: shifts.length, largestShift: Math.round(Math.max(...shifts) * 1000) / 1000,
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
    const onto = head;
    const satisfied = { ...(alreadyRemoved.length && { alreadyRemoved }), ...(droppedFromReview.length && { droppedFromReview }) };
    if (!cuts.length) return { changes: [], ...satisfied };
    const applied = cuts.filter(c => requested && !c.review);
    const stagedConfident = stagedWhy ? cuts.filter(c => c.submitted && !c.review).length : 0;
    const adjusted = { ...satisfied, ...(onFrames && { onFrames }), ...(stagedConfident && { stagedForEditor: { cuts: stagedConfident, why: stagedWhy! } }) };
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
    const onFrame = (t: number) => { const frame = Math.round(t * fps) / fps; return Math.abs(frame - t) < 1e-6 ? frame : t; };
    const optional = cuts.flatMap(c => {
      if (requested && !c.review) { shift += c.end - c.start; return []; }
      return [{ ...c, start: onFrame(c.start - shift), end: onFrame(c.end - shift),
        originalRange: c.originalRange && { start: onFrame(c.originalRange.start - shift), end: onFrame(c.originalRange.end - shift) } }];
    });
    let version = onto;
    const changes: Change[] = [];
    if (applied.length) {
      const { change } = persistProposal(ctx, user, projectId, { fromVersion: onto, intent: "requested", ops: ops(applied),
        description: whole && own ? own : describeDialogueRemovals(applied), taskId, author, noteIds }, ids[0], applied.map(({ start, end, reason, kind, crossfade, check }) => ({ start, end, reason, ...(kind && { kind }), ...(crossfade && { crossfade }), ...(check && { check }) })));
      if (change.state !== "approved") throw conflict("cut_changed", "The confident cuts could not be applied to this version.");
      changes.push(change);
      version = change.appliedVersion ?? change.toVersion;
    }
    // Staged cuts the editor hasn't called that now sit against footage they chose to keep. Their call covers them.
    const joined: TimeRange[] = [];
    if (optional.length) {
      const reasons = optional.map(({ start, end, reason, originalRange, kind, crossfade, legacySuggest }) => ({ start, end, reason, originalRange, ...(kind && { kind }), ...(crossfade && { crossfade }), ...(legacySuggest && { legacySuggest }) }));
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
      const ask = (index: number, { start, end }: TimeRange): CutAssessment => ({
        index, start, end, verdict: "ask", provisional: true,
        reason: [...new Set(within({ start, end }).map(c => c.reason))].join(" ").slice(0, 800).trim() || "Staged for a closer look.",
      });
      for (const [index, { removed: { start, end } }] of listed.entries()) {
        const inside = within({ start, end });
        if (inside.some(c => c.recovered)) {
          const source = resolveTimeline(ctx, project, version);
          const previewVersion = storeVersion(ctx, project.id, fadeJoins(project, applyReviewRemovals(source, [{ start, end }], change.toVersion), [{ at: start, duration: cutCrossfade(change, { start, end }) }]).timeline,
            { parent: version, description: "Preview this revised cut" }).version;
          cutEdits.push({ index, version, range: { start, end }, previewVersion });
        }
        const assessment = inside[0]?.assessment;
        const kept = inside.some(c => c.choice === "keep"), approved = inside.length > 0 && inside.every(c => c.choice === "cut");
        const lapsed = !kept && !approved && inside.some(c => c.choice || c.lapsed);
        if (assessment && noted.get(assessment) === inside.length && inside.every(c => c.assessment === assessment)) cutAssessments.push({ ...assessment, index, start, end });
        else if (assessed && (lapsed || inside.some(c => c.assessment))) {
          cutAssessments.push(ask(index, { start, end }));
          if (!kept && !approved) reopened = true;
        }
        if (kept || approved) cutChoices.push({ index, start, end, choice: kept ? "keep" : "cut" });
        else if (lapsed) reopened = true;
        if (kept) joined.push(...inside.flatMap(c => c.asked ?? []));
      }
      // Every note went with cuts this part decided again. A pass without notes reads as unassessed, where Approve takes
      // every cut, also one a later part stages. So each cut left gets the note: a cut the editor has called keeps their
      // call, and the others wait for them.
      if (assessed && !cutAssessments.length) {
        cutAssessments.push(...listed.map(({ removed }, index) => ask(index, removed)));
        if (!listed.length || listed.some((_, index) => !cutChoices.some(c => c.index === index))) reopened = true;
      }
      const applyWhenDone = reopened ? undefined : earlier.find(c => c.applyWhenDone)?.applyWhenDone;
      const kept = { ...(cutEdits.length && { cutEdits }), ...(cutAssessments.length && { cutAssessments }), ...(cutChoices.length && { cutChoices }), ...(applyWhenDone && { applyWhenDone }) };
      changes.push(Object.keys(kept).length ? saveChange(ctx, { ...change, ...kept }) : change);
    }
    // The previous part's review now lives in this one, or this part's cuts moved the edit past it.
    if (changes.length) for (const change of waiting) {
      saveChange(ctx, { ...change, state: "rejected", rejectedFrom: change.state, rejectReason: CARRIED,
        replacedBy: (changes.find(c => c.intent === "suggestion") ?? changes[0]!).id });
    }
    const editorDecided = [...overruled.map(c => c.asked), ...joined].sort((a, b) => a.start - b.start);
    return { changes, ...adjusted, ...(held.length && { heldForReview: held.map(c => c.asked) }), ...(carried.length && { carriedForward: carried.length }), ...(editorDecided.length && { editorDecided }),
      joinCrossfades: joinCrossfadeReport(frames, changes) };
  }), "immediate")();
}

/** What Scarlet did to submitted dialogue cuts on its own, each with why, so the agent reads what was saved. */
export interface DialogueCutsAdjustments {
  /** Confident cuts that wait for the editor instead of applying, and why. */
  stagedForEditor?: { cuts: number; why: string };
  /** Cuts whose edges moved onto whole frames: how many, the largest move in seconds, and why. */
  onFrames?: { cuts: number; largestShift: number; why: string };
  /** Staged cuts of an earlier part that left the review because their footage changed, on the version they were staged on. */
  droppedFromReview?: Array<{ changeId: string; version: string; start: number; end: number; why: string }>;
}

const REVISED = "Replaced by a later revision of the same cut.";
const CARRIED = "Carried into a later part of the same dialogue pass.";

/**
 * The pass that holds a named pass's staged cuts now that revisions have replaced the named one. A request about one
 * cut names the pass as it stood when the editor sent it, and each revision ahead of it in the queue makes a new pass.
 * A revision keeps every cut's place in the list, so the request's cut has the same index in the pass returned.
 * Undefined when nothing that replaced the named pass waits for the editor.
 */
function revisedPass(ctx: Ctx, named: Change, stopAt?: string): Change | undefined {
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
function activeStagedCut(ctx: Ctx, project: Project, named: Change, index: number, stopAt?: string) {
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
  const project = ctx.repos.projects.get(named.projectId);
  if (!project) return;
  try {
    const slot = activeStagedCut(ctx, project, named, index);
    if (slot.change.id !== named.id) return slot;
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== "cut_review_moved") throw error;
  }
}

/**
 * Move one staged cut of a pending dialogue pass. Every other cut and its review note carries over into a
 * replacement pass from the same version, so the editor's other calls stay valid. The moved cut waits for
 * the editor again.
 */
export function reviseStagedCut(ctx: Ctx, user: User, named: Change, namedIndex: number, body: StagedCutRevision, checkAttempt?: () => void) {
  // The pass is saved bare, then with its notes and the editor's calls: a window is told of it once, complete.
  const result = ctx.db.transaction(() => ctx.bus.asSaved(() => {
    const { reason, taskId, author, noteIds } = body;
    checkAttempt?.();
    let project = ctx.repos.projects.get(named.projectId);
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
      throw conflict("cut_with_editor", `Cut ${index} at ${old.start}–${old.end} s is with the editor. Only a revision they request can change this cut.`);
    const placement = placeRevision(ctx, project, change, review, index, body, range, task, scoped, named.fromVersion);
    if ("conflict" in placement) {
      const { reason, range } = placement.conflict;
      const currentVersion = project.head!;
      if (task && scoped) {
        const last = task.cutConflict;
        const samePassage = last?.version === currentVersion && last.range?.start === range?.start && last.range?.end === range?.end;
        saveTask(ctx, { ...task, cutConflict: { version: currentVersion, range, ...((target.carried || currentTaskCut) && { changeId: change.id, index }), approved: last?.approved,
          ...(samePassage && { answered: last?.answered, retried: last?.retried }) } });
      }
      // Commit the location before returning the error. A restarted agent or an editor answering its question needs it.
      return conflict("cut_review_stale", reason, { changeId: change.id, index, currentVersion, range });
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
    cutReasons.push({ start, end, reason, ...(kind && { kind }), ...(crossfade && { crossfade }), ...(legacySuggest && { legacySuggest }) });
    cutReasons.sort((a, b) => a.start - b.start);
    const { change: revised } = persistProposal(ctx, user, change.projectId, { fromVersion: change.fromVersion, intent: "suggestion", autoApprove: false,
      ops: [...ranges].reverse().map(r => ({ op: "rippleDelete" as const, start: r.start, end: r.end })),
      description: change.description, taskId, author, noteIds: [...new Set([...change.noteIds, ...(noteIds ?? [])])] }, id, cutReasons);
    // A later attempt from the same run replaces an earlier one, so only one pass waits for the editor.
    if (taskId) for (const earlier of ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.taskId') = ? AND id != ?",
      [change.projectId, taskId, id])) {
      if (earlier.fromVersion === change.fromVersion && earlier.intent === "suggestion")
        saveChange(ctx, { ...earlier, state: "rejected", rejectedFrom: earlier.state, rejectReason: REVISED, replacedBy: revised.id });
    }
    // The editor's calls on the other cuts carry over, including ones made while this revision ran. The revised cut
    // needs a new call.
    const latest = ctx.repos.changes.get(change.id) ?? change;
    if (latest.state === "ready") {
      saveChange(ctx, { ...latest, state: "rejected", rejectedFrom: latest.state, rejectReason: REVISED, replacedBy: revised.id });
    } else if (latest.state === "revising" && !selected && taskId && latest.revisionFrom?.taskId === taskId) {
      // A pass-wide revision can move several slots. Keep its review state and let the
      // next move find this successor with the preceding move and the editor’s calls.
      saveChange(ctx, { ...latest, replacedBy: revised.id });
    }
    const cutChoices = (latest.cutChoices ?? []).filter(c => c.index !== index);
    const approved = task?.cutConflict?.approved && scoped;
    if (placement.keep || approved) cutChoices.push({ index, start, end, choice: placement.keep ? "keep" : "cut" });
    const cutEdits = (latest.cutEdits ?? []).filter(e => e.index !== index);
    const edit = placement.edit;
    if (edit) {
      let previewVersion = edit.previewVersion;
      if (!placement.keep && edit.range.end > edit.range.start) {
        const source = resolveTimeline(ctx, project, edit.version);
        previewVersion = storeVersion(ctx, project.id, fadeJoins(project, applyReviewRemovals(source, [edit.range], revised.toVersion), [{ at: edit.range.start, duration: crossfade }]).timeline,
          { parent: source.version, description: "Preview this revised cut" }).version;
      }
      cutEdits.push({ ...edit, previewVersion });
    }
    const carried = { ...(cutChoices.length && { cutChoices }), ...(cutEdits.length && { cutEdits }) };
    const updatedTask = scoped && task?.cutConflict && ctx.repos.tasks.get(task.id);
    if (updatedTask) saveTask(ctx, { ...updatedTask, cutConflict: undefined });
    if (!change.cutAssessments?.length && !placement.keep) return receipt(Object.keys(carried).length ? saveChange(ctx, { ...revised, ...carried }) : revised, target);
    // Seeding a first assessment must preserve the implicit "cut" decisions of an unassessed pass.
    const assessments: CutAssessment[] = change.cutAssessments?.length ? change.cutAssessments : cuts.map((c, i) => ({
      index: i, ...c, verdict: "cut" as const, reason: change.cutReasons?.find(r => r.start >= c.start - 1e-6 && r.start < c.end)?.reason ?? change.description }));
    const verdict: CutAssessment["verdict"] = placement.keep ? "keep" : approved ? "cut" : "ask";
    const sentBack = scoped || was?.revised;
    // Moving an unchecked candidate invalidates its assessment. Only a recommendation on the new footage publishes it.
    const provisional = verdict === "ask" && autonomous;
    const updated: CutAssessment = { index, start, end, verdict, reason, ...(provisional && { provisional: true }),
      ...(verdict === "ask" && sentBack && { revised: true }), ...(was?.askOrder && { askOrder: was.askOrder }) };
    const cutAssessments = [...assessments.filter(a => a.index !== index), updated].sort((a, b) => a.index - b.index);
    const decided = new Set(cutChoices.map(c => c.index));
    const done = cuts.every((_, i) => decided.has(i) || cutAssessments.some(a => a.index === i && a.verdict !== "ask"));
    const applyWhenDone = (placement.keep || approved) && done && scoped ? { userId: user.id, at: now() } : undefined;
    return receipt(saveChange(ctx, { ...revised, cutAssessments, ...carried, applyWhenDone }), target);
  }), "immediate")();
  if (result instanceof HttpError) throw result;
  return result;
}

/**
 * A dialogue pass is applied once. Another version of it that still waits is one a revision left behind: the edit has
 * moved past it, so its calls can't be made, and left open it asks the editor for them again and holds the next request
 * (2026-11-09). It is put away as replaced by the version that was applied.
 */
function retireOtherVersions(ctx: Ctx, applied: Change): Change[] {
  if (applied.intent !== "suggestion" || !applied.cutReasons?.length) return [];
  const thread = threadOfChange(ctx, applied);
  // A version a finished revision replaced stays as it is: it holds nothing, and the applied pass's history reads through it.
  return ctx.repos.changes.select(`project_id = ? AND id != ? AND json_extract(json, '$.intent') = 'suggestion'
    AND json_extract(json, '$.fromVersion') = ? AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) > 0
    AND (state = 'ready' OR (state = 'revising' AND NOT EXISTS (SELECT 1 FROM changes made JOIN tasks rv ON rv.id = json_extract(made.json, '$.taskId')
      WHERE made.project_id = changes.project_id AND rv.kind = 'revise' AND json_extract(rv.json, '$.context.changeId') = changes.id)))`,
    [applied.projectId, applied.id, applied.fromVersion])
    .filter(other => threadOfChange(ctx, other) === thread)
    .map(other => saveChange(ctx, { ...other, state: "rejected", rejectedFrom: other.state, rejectReason: "Another version of this pass was applied.", replacedBy: applied.id }));
}

/**
 * The footage an applied change left out as it built its version, with a version that plays it. A change that only
 * took footage out as cuts says so itself, and nothing is read for it. Never keeps a change from being applied.
 */
function leftOutOf(ctx: Ctx, project: Project, change: Change): Change["leftOut"] {
  if (!change.ops?.length || change.cutReasons?.length || change.firstCut) return undefined;
  if (change.ops.every(op => op.op === "rippleDelete")) return undefined;
  try {
    const found = leftOutJoins(resolveTimeline(ctx, project, change.fromVersion), resolveTimeline(ctx, project, change.toVersion), project.settings.fps);
    if (!found) return { joins: [] };
    const original = storeVersion(ctx, project.id, found.original, { parent: change.fromVersion, description: "Footage left out, for review" });
    return { version: original.version, joins: found.joins };
  } catch (err) {
    ctx.log(`[edit] couldn’t read the footage ${change.id} left out: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Read the footage left out by changes an earlier build applied without looking: a video built from the pieces to
 * keep showed none of what it left out as cuts (2026-11-12). Runs once as Scarlet starts.
 */
export function recordLeftOutFootage(ctx: Ctx): void {
  const built = ctx.repos.changes.select(`state = 'approved' AND json_extract(json, '$.leftOut') IS NULL
    AND json_array_length(coalesce(json_extract(json, '$.ops'), '[]')) > 0
    AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) = 0`);
  for (const change of built) {
    const project = ctx.repos.projects.get(change.projectId);
    const leftOut = project && leftOutOf(ctx, project, change);
    if (!leftOut) continue;
    ctx.repos.changes.put({ ...change, leftOut });
    if (leftOut.joins.length) ctx.log(`[edit] ${change.id} left out ${leftOut.joins.length} stretches of footage as it built the video: now shown as cuts`);
  }
}

/** Put away the versions of applied passes that an earlier build left waiting. Runs once as Scarlet starts. */
export function retireLeftoverPasses(ctx: Ctx): void {
  ctx.db.transaction(() => {
    const applied = ctx.repos.changes.select(`state = 'approved' AND json_extract(json, '$.intent') = 'suggestion'
      AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) > 0 AND EXISTS (SELECT 1 FROM changes o WHERE o.project_id = changes.project_id
        AND o.state IN ('ready','revising') AND json_extract(o.json, '$.intent') = 'suggestion' AND json_extract(o.json, '$.fromVersion') = json_extract(changes.json, '$.fromVersion'))`);
    for (const pass of applied) for (const left of retireOtherVersions(ctx, pass)) ctx.log(`[edit] ${left.id} put away: ${pass.id}, another version of the same pass, was applied`);
  }, "immediate")();
}

/**
 * Gather into one review the parts of a dialogue pass that an earlier build left waiting side by side, as the pass's
 * next part would have. Each part's staged cuts waited on its own, out of sight behind the latest, and held the next
 * request for calls nobody was shown (2026-11-10). The review goes on the current edit, under the run's latest part.
 * Runs once as Scarlet starts.
 */
export function foldStrandedPasses(ctx: Ctx): void {
  const runs = new Map<string, Change[]>();
  for (const change of ctx.repos.changes.select(`state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'
      AND json_array_length(coalesce(json_extract(json, '$.cutReasons'), '[]')) > 0`)) {
    const task = change.id.endsWith("_review") && change.taskId ? ctx.repos.tasks.get(change.taskId) : undefined;
    if (!task) continue;
    const run = JSON.stringify([change.projectId, task.resumeRootId ?? task.id]);
    runs.set(run, [...runs.get(run) ?? [], change]);
  }
  const user = ctx.repos.users.primary();
  for (const parts of runs.values()) {
    if (parts.length < 2 || !user) continue;
    const latest = parts.reduce((a, b) => (b.createdAt ?? "") > (a.createdAt ?? "") ? b : a);
    const project = ctx.repos.projects.get(latest.projectId);
    // A pass made on another cut stays as it is until that cut is the one being edited.
    if (!project?.head || ctx.repos.tasks.get(latest.taskId!)?.context.branch !== project.branch) continue;
    try {
      const { changes } = submitDialogueCuts(ctx, user, project.id, { taskId: latest.taskId, fromVersion: project.head, cuts: [],
        description: latest.description, author: latest.author, noteIds: latest.noteIds }, { fold: true });
      ctx.log(`[edit] ${parts.length} parts of one dialogue pass waited side by side: folded into ${changes.map(c => c.id).join(", ")}`);
    } catch (error) {
      ctx.log(`[edit] Couldn't fold the ${parts.length} waiting parts of the dialogue pass ending in ${latest.id}: ${(error as Error).message}`);
    }
  }
}

/** Later saves by the producing run can move a published call on the timeline but must preserve its footage and edges. */
function assertStagedCallsStand(ctx: Ctx, project: Project, task: Task, base: Timeline, next: Timeline): void {
  const parts = dialogueParts(project.id, task.resumeRootId ?? task.id);
  const waiting = ctx.repos.changes.select(`project_id = ? AND state IN ('ready','revising') AND json_extract(json, '$.intent') = 'suggestion'
    AND json_array_length(json, '$.cutReasons') > 0 AND id IN (${parts.ids})`, parts.args);
  if (!waiting.length) return;
  const place = makeStagedCutMapper(base, next, project.settings.fps);
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
        throw conflict("cut_with_editor", `This edit would change cut ${index} in ${change.id}, which is with the editor. Leave its footage in place.`);
      located.push({ index, range: moved.range });
    }
    if (taken.length) {
      const named = taken.slice(0, 12).map(c => `cut ${c.index} at ${c.start.toFixed(2)}–${c.end.toFixed(2)} s`).join(", ");
      throw conflict("staged_cuts_changed", `This edit takes away the footage of ${taken.length === 1 ? "a staged cut" : `${taken.length} staged cuts`} that `
        + `${taken.length === 1 ? "waits" : "wait"} for the editor’s call in ${change.id} (${named}${taken.length > 12 ? ", …" : ""}; times on version ${base.version}). `
        + "Nothing was saved. Leave that footage in this edit. Use dialogue_apply_cuts to update a staged cut Scarlet hasn't asked the editor about.");
    }
    located.sort((a, b) => a.range.start - b.range.start);
    for (let i = 1; i < located.length; i++) {
      const a = located[i - 1]!, b = located[i]!;
      if (b.range.start < a.range.end + 1e-6 && (published.has(a.index) || published.has(b.index)))
        throw conflict("cut_with_editor", `This edit would join cuts ${a.index} and ${b.index} in ${change.id}. Leave footage between them to preserve the editor’s call.`);
    }
  }
}

function persistProposal(ctx: Ctx, user: User, projectId: string, body: ProposeChangeRequest, changeId = newId("chg"), cutReasons?: Change["cutReasons"],
  { fold = false }: { fold?: boolean } = {}): ProposeResult {
  const sourceTask = body.taskId ? ctx.repos.tasks.get(body.taskId) : null;
  if (body.taskId && sourceTask?.projectId !== projectId) throw badRequest("invalid_task", "task must belong to this project");
  if (sourceTask && !fold && FINISHED_TASK.has(sourceTask.state)) throw conflict("task_finished", "this task has already finished");
  for (const id of body.noteIds ?? []) {
    if (ctx.repos.notes.get(id)?.projectId !== projectId) throw badRequest("invalid_note", "notes must belong to this project");
  }
  const { project, head, timeline: headTl } = ensureHead(ctx, projectId);
  const fromVersion = body.fromVersion ?? head;
  const base = fromVersion === head ? headTl : resolveTimeline(ctx, project, fromVersion);
  let next: Timeline;

  if (body.ops && body.ops.length) {
    try {
      next = applyOps({ ...base, projectId }, body.ops);
    } catch (e) {
      if (e instanceof OpError) throw badRequest("invalid_ops", e.message, { op: e.op });
      throw badRequest("invalid_ops", (e as Error).message);
    }
  } else if (body.timeline) {
    next = WritableTimeline.parse({ ...body.timeline, projectId: project.id });
  } else {
    throw badRequest("missing_change", "provide `ops` or `timeline`");
  }
  assertMediaExists(project, next);
  if (!cutReasons && !fold && !body.range && sourceTask && selectedRange(sourceTask.context) && base.tracks.some(t => t.clips.length)) {
    const anchor = sourceTask.context;
    const original = anchor.version && anchor.version !== "head" && anchor.version !== base.version ? resolveTimeline(ctx, project, anchor.version) : undefined;
    try {
      const allowed = selectionPlacements(base, cutAnchorOn(anchor, base, original));
      const outside = (body.ops && rippleOutsideSelection(base, body.ops, allowed)) ?? removalOutsideSelection(base, next, allowed);
      if (outside) throw new Error(`The proposal removes footage at ${outside.start.toFixed(3)}–${outside.end.toFixed(3)} s outside the selected passage.`);
    } catch (error) {
      throw badRequest("cut_scope", (error as Error).message);
    }
  }
  // A pass's own later save can't take a staged cut away from the editor. Only its dialogue cuts, which carry their
  // reasons and decide a staged range again in the open, replace one.
  if (sourceTask && !cutReasons && !fold && body.intent === "requested" && !sourceTask.context.reviewAllCuts) assertStagedCallsStand(ctx, project, sourceTask, base, next);
  // Dialogue cuts get their requested crossfade on each join they make, staged ones too, so review plays what approving
  // keeps. The ops stay the removals the plan asked for; `joinFades` records the fades on top of them.
  let joinFades: JoinFades | undefined;
  // Keep explicit straight joins in a review that also carries fades. Older changes stored one duration
  // for the whole proposal and have no crossfade on any of their reasons.
  if (cutReasons?.some(c => c.crossfade)) cutReasons = cutReasons.map(c => ({ ...c, crossfade: c.crossfade ?? 0 }));
  if (cutReasons?.length && body.ops?.length && body.ops.every(op => op.op === "rippleDelete" && op.trackIds === undefined)) {
    ({ timeline: next, joinFades } = fadeJoins(project, next, proposalJoins(cutReasons)));
  }

  const author = authorFor(user, body.author);
  const stored = storeValidatedVersion(ctx, next, { parent: fromVersion, author, changeId, description: body.description }, base);
  const diff = diffTimelines(base, stored, project.settings.fps);
  // A range says where to look. One that starts on the timeline and runs past its end means "to the end"; refusing it
  // cost a pass a turn spent guessing the timeline's length.
  const ends = diff.durationAfter;
  if (body.timelineEdits?.some(({ range }) => range.end > ends + 1e-6 && range.start < ends)) {
    body = { ...body, timelineEdits: body.timelineEdits.map(e => e.range.end > ends && e.range.start < ends ? { ...e, range: { ...e.range, end: ends } } : e) };
  }
  const off = body.timelineEdits?.find(({ range }) => range.end < range.start || range.end > ends + 1e-6);
  if (off) {
    throw badRequest("invalid_edit_range", `Edit ranges must lie on the resulting timeline, which is ${ends.toFixed(3)} s long. ` +
      `"${off.label}" is ${off.range.start}-${off.range.end} s.`);
  }
  const threadId = sourceTask ? threadOf(sourceTask) : changeId;
  const replacements = new Set<string>();
  for (const { replaces } of body.timelineEdits ?? []) {
    if (!replaces) continue;
    const previous = ctx.repos.changes.get(replaces.changeId);
    // An empty list names no edit. The editor's list then shows the change by its cuts or ranges, as with no list at all.
    const count = previous && (previous.appliedReview?.joins.length ?? previous.approvedSpots?.length ??
      (previous.timelineEdits?.length ? previous.timelineEdits.length + (previous.leftOut?.joins.length ?? 0) : undefined) ??
      previous.cutReasons?.length ?? previous.ranges.length);
    const key = JSON.stringify([replaces.changeId, replaces.spot]);
    if (!previous || previous.projectId !== projectId || previous.state !== "approved" || threadOfChange(ctx, previous) !== threadId ||
        replaces.spot >= (count ?? 0) || replacements.has(key)) {
      throw badRequest("invalid_replacement", "Choose an individual edit in this thread to revise.");
    }
    replacements.add(key);
  }
  const requested = body.intent === "requested" && sourceTask?.createdBy.type === "human"
    && ["edit", "revise", "note"].includes(sourceTask.kind) && sourceTask.context.branch === project.branch;
  const autoApply = (requested && !sourceTask.context.reviewAllCuts && body.autoApprove !== false) || (!sourceTask && body.autoApprove === true
    && author.type === "human" && !["suggestion", "alternative"].includes(body.intent ?? ""));

  const handle = ctx.settings().render.handleSeconds;
  const multiple = !!body.ops?.length && diff.ranges.length > 1;
  // Ordinary small edits finish inline; expensive checks run outside this transaction.
  const cost = (body.ops?.length ?? 0) * diff.ranges.length * base.tracks.reduce((n, track) => n + track.clips.length, 0);
  const owners = multiple ? independentCutSpots(base, body.ops!, diff.spots, project.settings.fps)
    ?? independentClipSpots(base, body.ops!, diff.ranges, 0.3, project.settings.fps, diff.spots) : undefined;
  const spotAssignment = owners ? { fps: project.settings.fps, owners } : multiple && cost <= 300 ? {
    fps: project.settings.fps, owners: assignSpots(base, body.ops!, diff.ranges, undefined, project.settings.fps),
  } : undefined;
  let change: Change = {
    id: changeId,
    projectId: project.id,
    fromVersion,
    toVersion: stored.version,
    intent: sourceTask?.context.reviewAllCuts && body.intent === "requested" ? "suggestion" : body.intent,
    firstCut: body.firstCut,
    cutReasons,
    joinFades,
    description: body.description,
    author,
    noteIds: body.noteIds ?? [],
    ranges: diff.ranges,
    timelineEdits: body.timelineEdits,
    state: "ready",
    renders: body.skipRender ? [] : diff.spots.map((spot) => ({ ...spotWindows(diff, spot, handle), before: null, after: null })),
    taskId: body.taskId,
    threadId,
    ops: body.ops && body.ops.length ? (body.ops as Array<Record<string, unknown>>) : undefined,
    spotAssignment,
    canApproveSpots: multiple && !spotAssignment ? undefined : !!spotAssignment?.owners,
    createdAt: now(),
  };

  change = saveChange(ctx, change);
  logActivity(ctx, {
    projectId: project.id,
    actor: author,
    type: "change.proposed",
    summary: `${authorName(author)} proposed ${quote(change.description)}${change.ranges.length > 1 ? ` (${change.ranges.length} spots)` : ""}`,
    data: { changeId: change.id, threadId: change.threadId, version: change.toVersion },
  });

  // Nothing above writes the task, so the row read at the top is still current.
  if (sourceTask && !sourceTask.changeIds.includes(change.id)) {
    const saved = ctx.repos.tasks.put({ ...sourceTask, changeIds: [...sourceTask.changeIds, change.id] });
    ctx.bus.publish({ type: "task.updated", projectId: saved.projectId, task: saved });
  }

  if (alternativeAlreadyChosen(ctx, change, head)) change = rejectChange(ctx, user, change, "Another alternative was chosen");
  if (autoApply) {
    change = approveChange(ctx, user, change, { automatic: requested }).change;
  }
  if (change.state === "ready") {
    scheduleSpotCheck(ctx, change, project.settings.fps);
    // Announce dialogue review when the first assessed question has playable footage.
    if (!cutReasons?.length || !sourceTask) notifyReady(ctx, change);
  }
  if (change.state === "approved" && change.appliedVersion && change.appliedVersion !== stored.version) {
    const timeline = resolveTimeline(ctx, project, change.appliedVersion);
    const applied = diffTimelines(resolveTimeline(ctx, project, change.appliedOnto), timeline, project.settings.fps);
    return { change, timeline, duration: applied.durationAfter, diffDescription: describeDiff(applied, undefined, clipById) };
  }
  return { change, timeline: stored, duration: diff.durationAfter, diffDescription: describeDiff(diff, undefined, clipById) };
}

/** Tell the editor when an agent's change is ready for a decision. */
function notifyReady(ctx: Ctx, change: Change) {
  if (change.author.type !== "agent") return;
  notify(ctx, `Change ready for review: ${change.description.slice(0, 80)}`, {
    body: `${change.author.name} proposed a change with ${change.ranges.length} affected range(s).`,
    projectId: change.projectId,
    link: reviewItemPath(change.projectId, change.id),
  });
}

/** Hook render completion → change state (rendering → ready | failed). */
export function wireChangeRenderCompletion(ctx: Ctx) {
  const settle = ({ renderId, projectId, state }: BusEvents["render.finished"][0]) => {
    if (state === "done") {
      const previews = ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.firstDecisionPreview.renderId') = ?", [projectId, renderId]);
      for (const change of previews) recordPlayableDecision(ctx, change);
    }
    const candidates = ctx.repos.changes.select("project_id = ? AND state = 'rendering' AND json LIKE ?", [projectId, `%${renderId}%`]);
    for (const change of candidates) {
      const ids = change.renders.flatMap((r) => [r.before, r.after]).filter((x): x is string => !!x);
      const renders = ids.map((id) => ctx.repos.renders.get(id));
      const failed = renders.find((r) => !r || r.state === "failed" || r.state === "cancelled");
      if (failed !== undefined) {
        saveChange(ctx, { ...change, state: "failed", error: failed?.error ?? "render failed" });
        continue;
      }
      if (renders.every((r) => r!.state === "done")) {
        const saved = saveChange(ctx, { ...change, state: "ready" });
        notifyReady(ctx, saved);
      }
    }
  };
  ctx.bus.on("render.finished", event => {
    // The render queue announces a finished render from inside its own run. A throw here would reach it there,
    // and it would mark the render it just finished as failed and remove its file.
    try {
      settle(event);
    } catch (error) {
      ctx.log(`[review] couldn’t update the edits waiting on render ${event.renderId} (${event.state}): ${(error as Error).message}`);
    }
  });
}

/** Queue the actual edited media the first call will open, including the footage on both sides of the join. */
export function prepareFirstDecision(ctx: Ctx, change: Change, review: CutReview, index: number): Change["firstDecisionPreview"] {
  const project = ctx.repos.projects.header(change.projectId);
  const call = review.cuts[index];
  if (!project?.head || project.mediaPaused || !call) return;
  const revised = change.cutEdits?.find(edit => edit.index === index);
  let after: Timeline, join: number;
  if (revised) {
    if (!revised.previewVersion) return;
    after = resolveTimeline(ctx, project, revised.previewVersion);
    join = revised.range.start;
  } else if (project.head === review.original.version && isolatedReviewCut(review, call.removed, {
    start: call.removed.start - CUT_LEAD_SECONDS, end: call.removed.end + CUT_TAIL_SECONDS,
  })) {
    after = review.proposed;
    join = call.at;
  } else {
    const restored = review.cuts.flatMap((_, i) => i === index ? [] : [i]);
    const selected = prepareCutReview(ctx, change, restored, project.head);
    if (!selected.draft || selected.removed?.length !== 1) return;
    after = selected.draft;
    join = selected.removed[0]!.start;
  }
  const range = cutPlaybackWindow(join - CUT_LEAD_SECONDS, join + CUT_TAIL_SECONDS, timelineDuration(after), project.settings.fps);
  if (!range) return;
  const owner = newId("prep");
  const render = requestCutPlaybackFile(ctx, project, after.version, range, owner);
  if (render.state !== "done") ctx.db.afterCommit(() => {
    const signal = ctx.mediaSignal(project.id);
    void ctx.track(waitForPlayback(ctx, render, signal).finally(() => ctx.renders.release(render.id, owner)))
      .catch(error => { if (!signal.aborted) ctx.log(`[review] Could not prepare a file for ${change.id}: ${error}`); });
  });
  return { index, renderId: render.id, queuedAt: now() };
}

export function recordPlayableDecision(ctx: Ctx, change: Change) {
  const preview = change.firstDecisionPreview;
  if (!preview || preview.briefToPlayableMs !== undefined || !change.taskId) return;
  const render = ctx.repos.renders.get(preview.renderId);
  const task = ctx.repos.tasks.get(change.taskId);
  if (render?.state !== "done" || !render.finishedAt || !task?.createdAt) return;
  const ready = Math.max(Date.parse(preview.queuedAt), Date.parse(render.finishedAt));
  saveChange(ctx, { ...change, firstDecisionPreview: { ...preview, briefToPlayableMs: Math.max(0, ready - Date.parse(task.createdAt)) } });
  const first = change.cutAssessments?.find(a => a.index === preview.index && isPublishedCall(a));
  if (first && ctx.repos.projects.header(change.projectId)?.head === change.fromVersion)
    notify(ctx, "An edit is ready for review", { projectId: change.projectId, link: reviewItemPath(change.projectId, change.id), body: first.reason });
}

export function changeDiff(ctx: Ctx, change: Change): TimelineDiff {
  const project = ctx.repos.projects.get(change.projectId);
  if (!project) throw notFound("project");
  const viewed = appliedReviewChange(change);
  return diffTimelines(resolveTimeline(ctx, project, viewed.fromVersion), resolveTimeline(ctx, project, viewed.toVersion), project.settings.fps);
}

/** The thread a task belongs to (its own id when it started one). */
export function threadOf(task: Task): string {
  return task.context.threadId ?? task.id;
}

function threadOfChange(ctx: Ctx, change: Change): string {
  if (change.threadId) return change.threadId;
  const task = change.taskId ? ctx.repos.tasks.get(change.taskId) : null;
  return task ? threadOf(task) : change.id;
}

type ApproveResult = Omit<ApproveResponse, "task"> & { task?: Task };

/**
 * Put an approved change into the cut. If the cut moved since the agent
 * started (another change was approved), the change's edits are re-applied
 * onto it through the footage; if they touch the same moments, the change goes
 * back to its agent to redo on the current cut instead of failing.
 */
export function prepareCutReview(ctx: Ctx, change: Change, restoredCuts?: number[], ontoVersion?: string): {
  review: CutReview | null; draft?: Timeline; ontoVersion?: string; removed?: TimeRange[];
  /** The requested crossfades on the draft's joins when it differs from the proposal. */
  joinFades?: JoinFades } {
  const project = ctx.repos.projects.get(change.projectId);
  if (!project) throw notFound("project");
  if (ontoVersion && !restoredCuts) throw badRequest("invalid_cut_selection", "Choose the cuts to preview.");
  if (ontoVersion && project.head !== ontoVersion)
    throw conflict("cut_review_stale", "The working edit changed during review.", { currentVersion: project.head });
  const base = resolveTimeline(ctx, project, change.fromVersion);
  const proposed = resolveTimeline(ctx, project, change.toVersion);
  const review = planCutReview(base, proposed, project.media, change.ops, change.firstCut);
  if (!review) return { review: null };
  // The first cut starts with an empty project. Its Before monitor needs the actual uncut source.
  if (review.firstCut) review.original = storeVersion(ctx, project.id, review.original, {
    parent: change.fromVersion, description: "Original footage for cut review",
  });
  if (!restoredCuts) return { review };
  if (change.cutEdits?.length || (ontoVersion && ontoVersion !== change.fromVersion)) {
    if (ontoVersion && review.firstCut) throw conflict("cut_review_stale", "The opening assembly changed during review.");
    const head = resolveTimeline(ctx, project);
    const placed = reviewedCutsOnHead(ctx, project, change, review, head, restoredCuts);
    if ("conflict" in placed) throw conflict("cut_review_stale", placed.conflict.reason, { currentVersion: head.version, ...placed.conflict });
    const { timeline, joinFades } = placed.timeline === head ? { timeline: head, joinFades: undefined }
      : fadeJoins(project, placed.timeline, placed.applied.joins.map(j => ({ at: j.at, duration: cutCrossfade(change, review.cuts[j.reviewIndex!]!.removed) })));
    const draft = timeline === head ? head : storeVersion(ctx, project.id, timeline, {
      parent: head.version, description: "Preview the reviewed cuts" });
    return { review, draft, joinFades, ...(ontoVersion && { ontoVersion, removed: placed.applied.joins.map(j => j.removed) }) };
  }
  const placement = ontoVersion && { ontoVersion, removed: appliedCutReview(review, restoredCuts).joins.map(j => j.removed) };
  // Preview and Approve often request the same selection. Keep only its saved
  // version ID. Include the saved per-cut overlaps and the single duration on older proposals.
  const fadeSettings = change.cutReasons?.map(({ start, end, crossfade }) => [start, end, crossfade]);
  const draftKey = createHash("sha256").update(JSON.stringify([project.id, change.id, change.fromVersion,
    review.original.version, change.toVersion, review.firstCut, review.cuts, [...restoredCuts].sort((a, b) => a - b),
    fadeSettings, change.joinFades?.duration])).digest("hex");
  const cachedDraft = ctx.reviewDrafts.get(draftKey);
  if (cachedDraft) {
    const cached = ctx.repos.versions.get(project.id, cachedDraft.version);
    if (cached) return { review, draft: cached.timeline, joinFades: cachedDraft.joinFades, ...placement };
  }
  let result: Timeline;
  try { result = reviewedTimeline(review, restoredCuts); }
  catch (err) { throw badRequest("invalid_cut_selection", (err as Error).message); }
  // Some cuts applied and some put back: the proposal's fades were on other joins, so these joins get their own. With
  // none put back the draft is the proposal, faded already; with all put back nothing was cut.
  let joinFades: JoinFades | undefined;
  if (restoredCuts.length && restoredCuts.length < review.cuts.length && !review.firstCut)
    ({ timeline: result, joinFades } = fadeJoins(project, result, reviewedJoins(change, review, restoredCuts)));
  const draft = storeVersion(ctx, project.id, result, { parent: change.fromVersion, author: change.author, changeId: change.id,
    description: `${change.description} · ${restoredCuts.length} restored` });
  ctx.db.afterCommit(() => {
    ctx.reviewDrafts.set(draftKey, { version: draft.version, joinFades });
    if (ctx.reviewDrafts.size > 32) ctx.reviewDrafts.delete(ctx.reviewDrafts.keys().next().value!);
  });
  return { review, draft, joinFades, ...placement };
}

/** The editor's call on each staged cut, or what Approve does without one: Scarlet's verdict once it has assessed the pass, else cut. */
export function cutDecision(change: Change, index: number): CutChoice["choice"] {
  const chosen = change.cutChoices?.find(c => c.index === index)?.choice;
  if (chosen) return chosen;
  if (!change.cutAssessments?.length) return "cut";
  return change.cutAssessments.find(a => a.index === index)?.verdict === "cut" ? "cut" : "keep";
}

const ACTIVE_TASK = new Set(["queued", "claimed", "running", "waiting_for_user"]);

/**
 * Save the editor's calls on a dialogue pass as they make them, and whether to apply them once the pass finishes.
 * While one cut is being revised the editor can keep calling the others, and the revision carries those calls.
 */
export function saveCutChoices(ctx: Ctx, user: User, change: Change, body: {
  fromVersion: string; toVersion: string; choices: Array<{ index: number; choice: CutChoice["choice"] }>; applyWhenDone?: boolean;
}): Change {
  if (change.intent !== "suggestion" || !change.cutReasons?.length || change.fromVersion !== body.fromVersion || change.toVersion !== body.toVersion)
    throw conflict("cut_review_stale", "This proposal is no longer waiting for review.");
  const replaced = change.rejectReason === CARRIED || change.rejectReason === REVISED ||
    change.state === "revising" && !!revisedPass(ctx, change);
  if (replaced) {
    const project = ctx.repos.projects.get(change.projectId);
    if (!project) throw notFound("project");
    const original = prepareCutReview(ctx, change).review;
    if (!original) throw badRequest("cuts_unsupported", "This edit has no individual cuts.");
    // A click can arrive just after Scarlet adds a part or revises another call. Merge only the
    // choices made since the named pass. An old form must never erase a newer decision.
    const previous = new Map(change.cutChoices?.map(c => [c.index, c.choice]));
    const incoming = body.choices.filter(c => previous.get(c.index) !== c.choice);
    let live: Change | undefined;
    const decided = new Map<number, CutChoice["choice"]>();
    const mappers = new Map<string, ReturnType<typeof currentCutRanges>>();
    let review: ReturnType<typeof prepareCutReview>["review"] | undefined;
    for (const { index, choice } of incoming) {
      if (!original.cuts[index]) throw badRequest("wrong_cut", "This pass has no such cut.");
      const slot = activeStagedCut(ctx, project, change, index);
      if (slot.change.id === change.id || !["ready", "revising"].includes(slot.change.state)) break;
      live = slot.change;
      review ??= prepareCutReview(ctx, live).review;
      const liveChoice = live.cutChoices?.find(c => c.index === slot.index)?.choice;
      if (liveChoice && liveChoice !== previous.get(index)) continue;
      const edit = live.cutEdits?.find(e => e.index === slot.index);
      const range = edit?.range ?? review?.cuts[slot.index]?.removed;
      if (!range) continue;
      const version = edit?.version ?? live.fromVersion;
      let map = mappers.get(version);
      if (!map) {
        map = currentCutRanges(ctx, project, change, original, resolveTimeline(ctx, project, version));
        mappers.set(version, map);
      }
      const placed = map(index);
      if ((placed.kind === "exact" || placed.kind === "shortened") && Math.abs(placed.range.start - range.start) < 1e-5 &&
          Math.abs(placed.range.end - range.end) < 1e-5) decided.set(slot.index, choice);
    }
    if (!incoming.length && body.choices.length === previous.size) {
      const slot = activeStagedCut(ctx, project, change, body.choices[0]?.index ?? 0);
      if (slot.change.id !== change.id && ["ready", "revising"].includes(slot.change.state)) {
        live = slot.change;
        review = prepareCutReview(ctx, live).review;
      }
    }
    if (live && review) {
      const choices = new Map(live.cutChoices?.map(c => [c.index, c.choice]));
      for (const [i, choice] of decided) choices.set(i, choice);
      const assessed = new Set(live.cutAssessments?.filter(c => c.verdict !== "ask").map(c => c.index));
      const allDecided = review.cuts.every((_, i) => choices.has(i) || assessed.has(i));
      const schedule = body.applyWhenDone && allDecided ? true
        : body.applyWhenDone === false && change.applyWhenDone && change.applyWhenDone.at === live.applyWhenDone?.at ? false : undefined;
      if (!decided.size && schedule === undefined) return live;
      return saveCutChoices(ctx, user, live, { fromVersion: live.fromVersion, toVersion: live.toVersion,
        choices: [...choices].map(([index, choice]) => ({ index, choice })), applyWhenDone: schedule });
    }
    throw conflict("cut_review_moved", "This review has already moved on.");
  }
  if (change.state !== "ready" && change.state !== "revising")
    throw conflict("cut_review_stale", "This proposal is no longer waiting for review.");
  const review = prepareCutReview(ctx, change).review;
  if (!review) throw badRequest("cuts_unsupported", "This edit has no individual cuts.");
  const byIndex = new Map<number, CutChoice>();
  for (const { index, choice } of body.choices) {
    const removed = review.cuts[index]?.removed;
    if (!removed) throw badRequest("wrong_cut", `This proposal has no cut ${index}.`);
    byIndex.set(index, { index, start: removed.start, end: removed.end, choice });
  }
  const applyWhenDone = body.applyWhenDone === undefined ? change.applyWhenDone
    : body.applyWhenDone ? change.applyWhenDone ?? { userId: user.id, at: now() } : undefined;
  const saved = saveChange(ctx, { ...change, cutChoices: [...byIndex.values()].sort((a, b) => a.index - b.index), applyWhenDone, error: undefined });
  return applyChoicesWhenDone(ctx, saved) ?? saved;
}

/** The task now doing a run's work: a run interrupted when Scarlet quit carries on under a new task. */
export function latestAttempt(ctx: Ctx, taskId: string | undefined): Task | undefined {
  let task = taskId ? ctx.repos.tasks.get(taskId) ?? undefined : undefined;
  for (let hops = 0; task?.retryTaskId && hops < 100; hops++) {
    const next = ctx.repos.tasks.get(task.retryTaskId);
    if (!next) break;
    task = next;
  }
  return task;
}

const STALE_SAVE = "The timeline changed while the edit was running.";
const SAVED_AGAIN = "Scarlet saved this work again on the video as it was by then.";

/**
 * Put away a save the video had moved on from, once the run that made it has saved its work again. Such a save is left
 * waiting for the editor in case nothing follows it. A pass whose first whole-video save was refused went on to save
 * the same work on the current video, and the refused one stayed behind as a proposal no one could see or use
 * (2026-11-11). One with nothing applied after it by its run still waits.
 */
export function retireStaleSaves(ctx: Ctx, task: Task): void {
  const rootId = task.resumeRootId ?? task.id;
  const own = ctx.repos.changes.select(`project_id = ? AND json_extract(json, '$.taskId') IN
    (SELECT id FROM tasks WHERE id = ? OR json_extract(json, '$.resumeRootId') = ?)`, [task.projectId, rootId, rootId], "created_at ASC, rowid ASC");
  // In the order they were saved: two saves can share a millisecond, and only one made after the refused save replaces it.
  for (const [at, stale] of own.entries()) {
    if (stale.state !== "ready" || stale.intent !== "requested" || !stale.error?.startsWith(STALE_SAVE)) continue;
    const again = own.slice(at + 1).findLast(c => c.state === "approved" && c.intent === "requested");
    if (!again) continue;
    saveChange(ctx, { ...stale, state: "rejected", rejectedFrom: stale.state, rejectReason: SAVED_AGAIN, replacedBy: again.id });
    ctx.log(`[edit] ${stale.id} put away: its run saved the work again as ${again.id}`);
  }
}

/**
 * Apply a dialogue pass with the editor's calls once its run has finished, when the editor asked for that.
 * Cuts the editor didn't call follow Scarlet's verdict. Null while the run is still going, nothing was asked, or a cut
 * still waits on the editor.
 */
export function applyChoicesWhenDone(ctx: Ctx, change: Change): Change | null {
  if (!change.applyWhenDone || change.state !== "ready") return null;
  const task = latestAttempt(ctx, change.taskId);
  // Only a run that finished applies it. One still going isn't done, and one that stopped early left staged cuts
  // unchecked: those are the editor's calls now, and applying on their next call would skip the rest unasked.
  if (task && task.state !== "done") return null;
  if (task?.context.branch && task.context.branch !== ctx.repos.projects.header(change.projectId)?.branch) return null;
  const user = ctx.repos.users.get(change.applyWhenDone.userId) ?? ctx.repos.users.primary() ?? { id: change.applyWhenDone.userId, name: "Editor" };
  // Never let this stop the run from finishing: on any problem the calls stay saved for the editor to apply.
  try {
    const review = prepareCutReview(ctx, change).review;
    if (!review) throw new Error("This edit has no individual cuts");
    // A run can finish, or pause for its transcripts, without checking every staged cut. Those are the editor's calls
    // now ("Not checked yet."), as a cut Scarlet asked about is, and applying would settle them unseen (2026-11-10).
    // The schedule stands: the editor's call on the last of them applies the pass.
    const settled = new Set([...change.cutChoices ?? [], ...(change.cutAssessments ?? []).filter(a => a.verdict !== "ask")].map(c => c.index));
    if (review.cuts.some((_, i) => !settled.has(i))) return null;
    const restoredCuts = review.cuts.flatMap((_, i) => cutDecision(change, i) === "keep" ? [i] : []);
    return approveChange(ctx, user, { ...change, applyWhenDone: undefined }, { restoredCuts }).change;
  } catch (error) {
    ctx.log(`[review] Could not apply ${change.id} when its pass finished: ${error}`);
    // A video that moved under the pass names the cut it moved under. Anything else is in the log.
    const moved = error instanceof HttpError && error.code === "cut_review_stale";
    return saveChange(ctx, { ...change, applyWhenDone: undefined,
      error: moved ? error.message : "This pass wasn’t applied when Scarlet finished, but your calls are saved: press Retry to try again." });
  }
}

function alternativeAlreadyChosen(ctx: Ctx, change: Change, head: string) {
  if (change.intent !== "alternative" || !change.taskId) return false;
  const choices = ctx.repos.changes.select(
    "project_id = ? AND state = 'approved' AND json_extract(json, '$.taskId') = ? AND json_extract(json, '$.intent') = 'alternative'",
    [change.projectId, change.taskId]);
  if (!choices.length) return false;
  const { lineage, undone } = historyLineage(ctx.repos.versions.links(change.projectId), head);
  return choices.some(c => {
    const version = c.appliedVersion ?? c.toVersion;
    return c.id !== change.id && lineage.has(version) && !undone.has(version);
  });
}

export function approveChange(ctx: Ctx, user: User, change: Change, opts: { spots?: number[]; restoredCuts?: number[]; automatic?: boolean }): ApproveResult {
  if (change.state === "approved") {
    const projectRow = ctx.repos.projects.get(change.projectId);
    if (!projectRow) throw notFound("project");
    if (opts.restoredCuts && [...opts.restoredCuts].sort().join(",") !== change.restoredCuts?.slice().sort().join(",")) {
      throw conflict("cut_review_decided", "This proposal was already approved with different choices.");
    }
    return { change, project: projectRow, outcome: "applied" };
  }
  if (change.state === "rejected" || change.state === "failed") {
    if (!ctx.repos.projects.header(change.projectId)) throw notFound("project");
    throw conflict("invalid_state", `cannot approve a ${change.state} change`);
  }
  const { project, head, timeline: headTl } = ensureHead(ctx, change.projectId);
  if (alternativeAlreadyChosen(ctx, change, head)) throw conflict("alternative_chosen", "Undo the chosen alternative before applying another on this branch.");
  // Older assessments recorded the first preview as their only indication that the pass had published a call.
  const reviewTask = change.assessedForReview || change.firstDecisionPreview ? latestAttempt(ctx, change.taskId) : undefined;
  if (change.state === "revising" && change.revisionFrom) {
    const checking = ctx.repos.tasks.get(change.revisionFrom.taskId);
    if (checking?.cutConflict && ACTIVE_TASK.has(checking.state))
      return { change, project, outcome: "sent_back", task: checking };
  }
  if (reviewTask && ["running", "claimed", "queued"].includes(reviewTask.state))
    throw conflict("review_in_progress", "Your choices can be staged while Scarlet checks the remaining cuts.");
  if (change.cutAssessments?.length && !opts.restoredCuts) {
    const review = prepareCutReview(ctx, change).review;
    if (!review || opts.spots || change.cutAssessments.length !== review.cuts.length || change.cutAssessments.some(a => a.verdict === "ask"))
      throw conflict("review_decisions_needed", "Open Needs your call to finish the outstanding decisions.");
    // The editor's call on a cut stands over Scarlet's verdict, as when the pass is applied once it finishes.
    opts = { ...opts, restoredCuts: review.cuts.flatMap((_, i) => cutDecision(change, i) === "keep" ? [i] : []) };
  }
  if (change.cutEdits?.length && !opts.restoredCuts) {
    if (opts.spots) throw badRequest("spots_unsupported", "Review this pass by its individual cuts.");
    opts = { ...opts, restoredCuts: (change.cutChoices ?? []).filter(c => c.choice === "keep").map(c => c.index) };
  }
  const spots = opts.spots?.filter((i) => i >= 0 && i < change.ranges.length);
  if (opts.spots && !spots?.length) throw badRequest("no_spots", "pick at least one spot to approve, or reject the change");

  let target: string;
  let appliedReview: Change["appliedReview"];
  /** The crossfade on the applied version's joins, when that version isn't `toVersion`, which `joinFades` describes. */
  let appliedJoinFades: JoinFades | undefined;
  let outcome: ApproveResult["outcome"] = "applied";
  const allSpots = !spots || change.ranges.every((_, i) => spots.includes(i));
  if (opts.restoredCuts) {
    if (change.state !== "ready") throw conflict("cut_review_stale", "The edit changed during review. Review a proposal for the current edit.");
    const unchanged = head === change.fromVersion && !change.cutEdits?.length;
    const { review, draft, joinFades } = prepareCutReview(ctx, change, unchanged ? opts.restoredCuts : undefined);
    if (!review) throw badRequest("cuts_unsupported", "This proposal has no individually restorable cuts.");
    if (unchanged) {
      if (!draft) throw badRequest("cuts_unsupported", "This proposal has no individually restorable cuts.");
      appliedReview = appliedCutReview(review, opts.restoredCuts);
      target = draft.version;
      // With every cut applied the draft is the proposal, faded as `joinFades` says.
      if (target !== change.toVersion) appliedJoinFades = joinFades ?? (opts.restoredCuts.length ? { duration: 0, fades: [], plain: [] } : change.joinFades);
      if (target !== head && target !== change.toVersion && !ctx.repos.versions.get(project.id, target)?.changeId) ctx.repos.versions.setChangeId(project.id, target, change.id);
    } else {
      // The edit moved during review: the editor's own edit, or a request that finished meanwhile. The chosen cuts
      // are anchored in the footage, so they carry onto the current edit unless one touches footage that changed.
      if (review.firstCut) throw conflict("cut_review_stale", "The opening assembly changed during review.");
      const placed = reviewedCutsOnHead(ctx, project, change, review, headTl, opts.restoredCuts);
      if ("conflict" in placed) {
        const { index, range, reason } = placed.conflict;
        const savedChoices = new Map(change.cutChoices?.map(c => [c.index, c]));
        const restored = new Set(opts.restoredCuts);
        for (const [i, cut] of review.cuts.entries()) {
          if (i === index) savedChoices.delete(i);
          else savedChoices.set(i, { index: i, ...cut.removed, choice: restored.has(i) ? "keep" : "cut" });
        }
        const former = change.cutAssessments?.find(a => a.index === index);
        const assessments = [...(change.cutAssessments ?? []).filter(a => a.index !== index), {
          index, ...review.cuts[index]!.removed, verdict: "ask" as const, ...(former?.revised && { revised: true }), ...(former?.askOrder && { askOrder: former.askOrder }),
          reason: former?.reason ?? change.cutReasons?.find(c => c.start >= review.cuts[index]!.removed.start - 1e-6 && c.start < review.cuts[index]!.removed.end)?.reason ?? "Check this passage." }];
        const checked = { ...change, cutChoices: [...savedChoices.values()], cutAssessments: assessments.sort((a, b) => a.index - b.index), applyWhenDone: undefined };
        const prior = change.taskId ? ctx.repos.tasks.get(change.taskId) : undefined;
        const task = createTask(ctx, { projectId: project.id, kind: "revise", agent: prior?.agent ?? ctx.settings().defaultAgent,
          model: prior?.model, effort: prior?.effort, serviceTier: prior?.serviceTier, createdBy: { type: "scarlet", name: "Scarlet" },
          context: { changeId: change.id, threadId: threadOfChange(ctx, change), cutIndex: index, version: head, time: range?.start, end: range?.end,
            noteIds: change.noteIds, message: "Recheck this cut" }, cutConflict: { version: head, range, approved: true },
          instruction: `The editor approved this cut. The passage changed before it could apply. Recheck the current footage and preserve the intended edit. ${reason}` +
            cutRevisionReference(change, { cutIndex: index, time: review.cuts[index]!.removed.start, end: review.cuts[index]!.removed.end, clipIds: [] }) });
        const pending = saveChange(ctx, beginRevision(checked, task));
        return { change: pending, project, task, reason, outcome: "sent_back" };
      }
      appliedReview = placed.applied;
      const faded = placed.timeline === headTl ? { timeline: headTl, joinFades: undefined }
        : fadeJoins(project, placed.timeline, placed.applied.joins.map(j => ({ at: j.at, duration: cutCrossfade(change, review.cuts[j.reviewIndex!]!.removed) })));
      appliedJoinFades = faded.joinFades ?? { duration: 0, fades: [], plain: [] };
      target = faded.timeline === headTl ? head : storeVersion(ctx, project.id, faded.timeline, {
        parent: head, changeId: change.id, author: change.author, description: change.description }).version;
      outcome = "rebased";
    }
  } else if (head === change.toVersion) {
    if (!allSpots) {
      throw badRequest("spots_unsupported", "All spots are already present in the current edit");
    }
    target = change.toVersion;
  } else if (allSpots && head === change.fromVersion && ctx.repos.versions.exists(project.id, change.toVersion)) {
    target = change.toVersion;
  } else {
    const from = head === change.fromVersion ? headTl : resolveTimeline(ctx, project, change.fromVersion);
    const to = resolveTimeline(ctx, project, change.toVersion);
    const ops = change.ops ? z.array(TimelineOp).parse(change.ops) : undefined;
    if (!allSpots && ops?.length && change.spotAssignment?.fps !== project.settings.fps)
      throw conflict("review_spots_changed", "The project format changed. Reopen the proposal to review its spots.");
    let plan: ApplyPlan = planApply({ from, to, head: headTl, ops, spots, changeRanges: change.ranges, fps: project.settings.fps },
      change.spotAssignment?.owners);
    if (opts.automatic && plan.kind !== "conflict" && head !== change.fromVersion) {
      // Check the recorded delta as well as the visible footage. Markers, track
      // settings and timeline names can conflict without changing a single frame.
      try { plan = { kind: "rebased", timeline: replayHistoryEdit(from, to, headTl, change, project.settings.fps) }; }
      catch (e) { plan = { kind: "conflict", reason: (e as Error).message }; }
    }
    if (plan.kind === "conflict") {
      if (plan.spotsUnsupported || (spots && head === change.fromVersion)) throw badRequest("spots_unsupported", `Can't approve spots one by one: ${plan.reason}.`);
      if (opts.automatic) {
        const pending = saveChange(ctx, { ...change, error: `${STALE_SAVE} Review this version: ${plan.reason}.` });
        return { change: pending, project, outcome: "conflict", reason: plan.reason };
      }
      return sendBack(ctx, user, { ...change, threadId: threadOfChange(ctx, change) }, project, plan.reason);
    }
    if (plan.kind === "fast-forward") {
      target = change.toVersion;
    } else {
      const partial = plan.kind === "partial";
      let timeline = plan.timeline;
      if (change.joinFades?.fades.length) {
        // The removals landed on a cut that moved: each join they made gets the crossfade there, as far as it can.
        const map = makeTimeMap(to, timeline, project.settings.fps);
        const record = change.joinFades;
        const joins = record.fades.flatMap(f => {
          const at = map(f.at, "right");
          return at === null ? [] : [{ at, duration: f.duration ?? record.duration }];
        });
        const faded = fadeJoins(project, timeline, joins);
        timeline = faded.timeline;
        appliedJoinFades = faded.joinFades;
      }
      appliedJoinFades ??= { duration: 0, fades: [], plain: [] };
      const stored = storeVersion(ctx, project.id, timeline, {
        parent: head,
        changeId: change.id,
        author: change.author,
        description: partial ? `${change.description} (${spots!.length} of ${change.ranges.length})` : change.description,
      });
      ctx.repos.versions.setChangeId(project.id, stored.version, change.id);
      target = stored.version;
      outcome = plan.kind;
    }
  }

  const snapshot = ctx.repos.versions.get(project.id, target)!;
  if (opts.automatic && head !== change.fromVersion && target !== head && !change.cutReasons?.length && change.taskId) {
    const task = ctx.repos.tasks.get(change.taskId);
    if (task) assertStagedCallsStand(ctx, project, task, headTl, snapshot.timeline);
  }
  if (target !== head && (snapshot.parent !== head || snapshot.changeId !== change.id)) {
    target = storeVersion(ctx, project.id, snapshot.timeline, {
      parent: head, changeId: change.id, author: change.author, description: change.description,
    }).version;
  }
  let appliedWindows: Change["appliedWindows"];
  if (!appliedReview && (head !== change.fromVersion || target !== change.toVersion)) {
    const diff = diffTimelines(headTl, snapshot.timeline, project.settings.fps);
    const handle = ctx.settings().render.handleSeconds;
    appliedWindows = diff.spots.map(spot => ({ spot: spot.after, ...spotWindows(diff, spot, handle) }));
  }
  const updated = ctx.repos.projects.update(project.id, { head: target });
  const saved = saveChange(ctx, {
    ...change,
    state: "approved",
    threadId: threadOfChange(ctx, change),
    error: undefined,
    autoApplied: opts.automatic || undefined,
    decidedBy: opts.automatic ? { type: "scarlet", name: "Scarlet" } : actorFor(user),
    appliedVersion: target,
    appliedOnto: head,
    appliedWindows,
    approvedSpots: outcome === "partial" ? spots : undefined,
    restoredCuts: opts.restoredCuts,
    appliedReview,
    appliedJoinFades,
    leftOut: appliedReview ? undefined : leftOutOf(ctx, project, change),
  });
  if (saved.intent === "suggestion" && saved.cutReasons?.length && target !== head && appliedReview?.joins.length !== 0) {
    const pass = latestAttempt(ctx, saved.taskId);
    const owner = pass?.repeatAudit ? pass : latestAttempt(ctx, saved.threadId);
    if (owner?.state === "done" && owner.finishedAt && owner.repeatAudit && owner.repeatAudit.version !== target && isDialoguePass(owner)) {
      queueRepeatCheck(ctx, owner, target);
    }
  }
  retireOtherVersions(ctx, saved);
  if (saved.intent === "alternative" && saved.taskId) {
    const alternatives = ctx.repos.changes.select(
      "project_id = ? AND state = 'ready' AND json_extract(json, '$.taskId') = ? AND json_extract(json, '$.intent') = 'alternative'",
      [saved.projectId, saved.taskId]);
    for (const option of alternatives) rejectChange(ctx, user, option, "Another alternative was chosen");
  }
  for (const noteId of saved.noteIds) {
    const note = ctx.repos.notes.get(noteId);
    if (note?.projectId === change.projectId && note.state !== "resolved") {
      const n = ctx.repos.notes.put({ ...note, state: "resolved", updatedAt: now() });
      ctx.bus.publish({ type: "note.updated", projectId: n.projectId, note: n });
    }
  }
  ctx.bus.publish({ type: "project.updated", projectId: updated.id, project: updated });
  logActivity(ctx, {
    projectId: project.id,
    actor: actorFor(user),
    type: opts.automatic ? "change.applied" : "change.approved",
    summary: opts.automatic ? `Applied ${quote(saved.description)}` :
      outcome === "partial"
        ? `${user.name} approved ${spots!.length} of ${change.ranges.length} spots of ${quote(saved.description)}`
        : `${user.name} approved ${quote(saved.description)}${outcome === "rebased" ? " (merged into the latest edit)" : ""}`,
    data: { changeId: saved.id, threadId: saved.threadId, outcome, version: target, onto: head },
  });
  return { change: saved, project: updated, outcome };
}

/** The cut moved under this change in a way it can't absorb: ask its agent to redo it, in the same thread. */
function sendBack(ctx: Ctx, user: User, change: Change, project: Project, reason: string): ApproveResult {
  if (change.author.type !== "agent") {
    throw conflict("needs_redo", `This change can't be merged: ${reason}. Make it again on the current edit.`);
  }
  let target = { agent: ctx.settings().defaultAgent, model: undefined as string | undefined };
  try {
    target = { ...parseAssignTo(change.author.id, ctx.settings().defaultAgent), model: change.author.model };
  } catch {
    /* keep the default agent */
  }
  const head = project.head ?? undefined;
  const task = createTask(ctx, {
    projectId: change.projectId,
    kind: "revise",
    agent: target.agent,
    model: target.model,
    instruction: [
      `Redo this change on the current edit: "${change.description}".`,
      `It was approved, but the timeline changed while you worked and the edit no longer fits: ${reason}.`,
      `Make the same edit on the current timeline.`,
    ].join(" "),
    context: { changeId: change.id, noteIds: change.noteIds, version: head, threadId: change.threadId, message: "Redo on the current edit" },
    createdBy: { type: "scarlet", name: "Scarlet" },
  });
  const saved = saveChange(ctx, { ...beginRevision(change, task), error: `Sent back: ${reason}` });
  logActivity(ctx, {
    projectId: project.id,
    actor: actorFor(user),
    type: "change.sent_back",
    summary: `${user.name} approved ${quote(change.description)}, but it couldn’t be merged (${reason}); it went back to ${authorName(change.author)} to redo`,
    data: { changeId: change.id, threadId: change.threadId, taskId: task.id },
  });
  return { change: saved, project, outcome: "sent_back", reason, task };
}

/** Undo an approval, as long as nothing was approved on top of it. */
export function unapproveChange(ctx: Ctx, user: User, change: Change): { change: Change; project: Project } {
  const project = ctx.repos.projects.get(change.projectId);
  if (!project) throw notFound("project");
  if (change.state !== "approved") throw conflict("invalid_state", "only approved changes can be undone");
  const applied = change.appliedVersion ?? change.toVersion;
  const onto = change.appliedOnto ?? change.fromVersion;
  if (project.head !== applied) {
    throw conflict("not_latest", "Other changes were approved after this one. Restore an earlier version from the Changelog instead.");
  }
  const updated = ctx.repos.projects.update(project.id, { head: onto });
  const saved = saveChange(ctx, {
    ...change,
    state: "ready",
    appliedVersion: undefined,
    appliedOnto: undefined,
    appliedWindows: undefined,
    autoApplied: undefined,
    approvedSpots: undefined,
    restoredCuts: undefined,
    appliedReview: undefined,
    leftOut: undefined,
    appliedJoinFades: undefined,
    decidedBy: undefined,
  });
  ctx.bus.publish({ type: "project.updated", projectId: updated.id, project: updated });
  logActivity(ctx, {
    projectId: project.id,
    actor: actorFor(user),
    type: "change.undone",
    summary: `${user.name} undid the approval of ${quote(change.description)}${change.decidedBy && change.decidedBy.id !== user.id ? ` (approved by ${change.decidedBy.name})` : ""}`,
    data: { changeId: change.id, threadId: change.threadId, version: onto, from: applied },
  });
  return { change: saved, project: updated };
}

export function rejectChange(ctx: Ctx, user: User, change: Change, reason?: string): Change {
  if (change.state === "approved") throw conflict("invalid_state", "cannot reject an approved change");
  if (change.state === "rejected") return change;
  const saved = saveChange(ctx, {
    ...change,
    state: "rejected",
    rejectedFrom: change.state,
    rejectReason: reason,
    decidedBy: actorFor(user),
  });
  logActivity(ctx, {
    projectId: saved.projectId,
    actor: actorFor(user),
    type: "change.rejected",
    summary: `${user.name} rejected ${quote(saved.description)}${reason ? `: ${quote(reason, 120)}` : ""}`,
    data: { changeId: saved.id, threadId: saved.threadId },
  });
  return saved;
}

/** Reopening a proposal changes its review state only. Rendering may have finished since rejection. */
export function reopenChange(ctx: Ctx, user: User, change: Change): Change {
  if (change.state !== "rejected") throw conflict("invalid_state", "Only a rejected edit can be reopened.");
  const state = resumeReviewState(ctx, change, change.rejectedFrom);
  const saved = saveChange(ctx, proposalAfterRevisions(ctx, { ...change, state, rejectedFrom: undefined, rejectReason: undefined, replacedBy: undefined, decidedBy: undefined }));
  logActivity(ctx, { projectId: saved.projectId, actor: actorFor(user), type: "change.reopened",
    summary: `${user.name} reopened ${quote(saved.description)} for review`, data: { changeId: saved.id, threadId: saved.threadId } });
  return saved;
}

type ReviseRequest = z.output<typeof ReviseRequestSchema>;

/** Name the one staged cut a revision is about, with why it was proposed and how it was assessed. */
export function cutRevisionReference(change: Change, position: ReviseRequest["position"]): string {
  const index = position?.cutIndex;
  if (index === undefined) return "";
  const assessment = change.cutAssessments?.find(a => a.index === index);
  const staged = mergeRanges((change.cutReasons ?? []).map(({ start, end }) => ({ start, end })));
  const start = assessment?.start ?? staged[index]?.start ?? position?.time;
  const end = assessment?.end ?? staged[index]?.end ?? position?.end;
  const edit = change.cutEdits?.find(e => e.index === index);
  const span = edit ? `, at ${edit.range.start.toFixed(2)}–${edit.range.end.toFixed(2)} s on version ${edit.version}`
    : start !== undefined && end !== undefined ? `, removing ${start.toFixed(2)}–${end.toFixed(2)} s` : "";
  const proposed = start !== undefined && end !== undefined
    ? change.cutReasons?.find(r => r.start < end + 0.01 && r.end > start - 0.01)?.reason : undefined;
  const lines = [`This feedback is about one staged cut only: cut index ${index} of change ${change.id}${span}. Leave the other cuts as they are.`];
  if (proposed) lines.push(`Why this cut was proposed: "${proposed.trim()}"`);
  if (assessment) lines.push(`Review note on this cut (${assessment.verdict}): "${assessment.reason.trim()}"`);
  return `\n\n${lines.join("\n")}`;
}

export function reviseChange(ctx: Ctx, user: User, change: Change, body: ReviseRequest): { change: Change; note: Note; task: Task } {
  if (change.state === "approved") throw conflict("invalid_state", "cannot revise an approved change");
  const position = body.position;
  if (position?.version && !ctx.repos.versions.exists(change.projectId, position.version)) throw badRequest("unknown_version", "The selected version does not belong to this project.");
  if (position?.mediaId && ctx.repos.projects.getMedia(position.mediaId)?.projectId !== change.projectId) throw badRequest("unknown_media", "The selected footage does not belong to this project.");
  const first = change.ranges[0];
  const ts = now();
  const target = body.assignTo
    ? parseAssignTo(body.assignTo, ctx.settings().defaultAgent)
    : change.author.type === "agent" && change.author.id
      ? (() => {
          try {
            return { ...parseAssignTo(change.author.id, ctx.settings().defaultAgent), model: change.author.model };
          } catch {
            return { agent: ctx.settings().defaultAgent, model: undefined };
          }
        })()
      : { agent: ctx.settings().defaultAgent, model: undefined };
  const assignedTo = target.model ? `${target.agent}:${target.model}` : target.agent;
  const note = ctx.repos.notes.put({
    id: newId("note"),
    projectId: change.projectId,
    version: position?.version ?? change.toVersion,
    time: position?.time ?? first?.start ?? 0,
    end: position ? position.end : first?.end,
    clipIds: position?.clipIds ?? [],
    text: body.text,
    voiceTranscript: body.voiceTranscript,
    author: actorFor(user),
    assignedTo,
    changeId: change.id,
    state: "in_progress",
    createdAt: ts,
    updatedAt: ts,
  });
  ctx.bus.publish({ type: "note.updated", projectId: note.projectId, note });
  const task = createTask(ctx, {
    projectId: change.projectId,
    kind: "revise",
    agent: target.agent,
    model: target.model,
    effort: body.effort,
    serviceTier: body.serviceTier,
    instruction: body.text + cutRevisionReference(change, position),
    context: { skillIds: body.skillIds, changeId: change.id, noteIds: [note.id], ...position, version: note.version, time: note.time, end: note.end, threadId: threadOfChange(ctx, change), message: body.text },
    createdBy: actorFor(user),
  });
  const saved = saveChange(ctx, { ...beginRevision(change, task), noteIds: [...change.noteIds, note.id] });
  logActivity(ctx, {
    projectId: saved.projectId,
    actor: actorFor(user),
    type: "change.revise_requested",
    summary: `${user.name} asked for a new version of ${quote(change.description)}: ${quote(body.text, 120)}`,
    data: { changeId: change.id, threadId: saved.threadId, taskId: task.id },
  });
  return { change: saved, note, task };
}
