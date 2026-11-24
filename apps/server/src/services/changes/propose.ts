import { boundedRippleOps, cutAnchorOn, cutScope, reviewItemPath, rippleDrift, selectedRange, selectionPlacements, type ProposeChangeRequest, type User } from "@scarlet/shared";
import {
  applyOps,
  assignSpots,
  clipById,
  describeDiff,
  diffTimelines,
  frameAligned,
  frameAlignedRemoval,
  independentClipSpots,
  independentCutSpots,
  newId,
  onFrame,
  OpError,
  timelineDuration,
  WritableTimeline,
  type Change,
  type JoinFades,
  type Timeline,
} from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { now } from "../../db.js";
import { badRequest, conflict } from "../../errors.js";
import { errorMessage, round3 } from "../../util.js";
import { authorName, logActivity, quote } from "../activity.js";
import { notify } from "../notify.js";
import { removalOutsideSelection, rippleOutsideSelection } from "../selectedRemoval.js";
import { editsDialogue, FINISHED_TASK } from "../tasks.js";
import { ensureProjectHead, resolveTimeline, storeValidatedVersion } from "../timeline.js";
import { anchorOriginal, authorFor, editorAskedSince, putAway, saveChange, threadOf, threadOfChange } from "./common.js";
import { fadeJoins, proposalJoins } from "./joinCrossfades.js";
import { alternativeAlreadyChosen, approveChange, rejectChange } from "./lifecycle.js";
import { scheduleSpotCheck, spotWindows } from "./spotChecks.js";
import { assertStagedCallsStand, requireUnscopedEdit } from "./stagedCutLineage.js";

export interface ProposeResult {
  duration: number;
  diffDescription: string[];
  change: Change;
  timeline: Timeline;
  /** Removals inside a selected passage that the engine put on whole frames: what was asked and what was removed. */
  onWholeFrames?: Array<{ asked: [number, number]; removed: [number, number] }>;
  /**
   * A requested edit that could not go onto the video: it was written on `fromVersion`, and since then something else
   * changed the same footage. `reason` says what met and where, and `currentVersion` is the video as it is now.
   */
  notApplied?: { reason: string; currentVersion: string; editorAsked?: string[] };
}

const WITHDRAWN = "Replaced by a later option from the same request.";

function assertMediaExists(ctx: Ctx, timeline: Timeline) {
  const clips = new Map<string, string>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind === "media" && !clips.has(clip.mediaId)) clips.set(clip.mediaId, clip.id);
  }
  if (!clips.size) return;
  const missing = ctx.db.prepare(`SELECT src.value AS id FROM json_each(?) src WHERE NOT EXISTS
    (SELECT 1 FROM media WHERE id = src.value AND project_id = ?) ORDER BY src.key LIMIT 1`)
    .get(JSON.stringify([...clips.keys()]), timeline.projectId) as { id: string } | undefined;
  if (missing) {
    const clipId = clips.get(missing.id)!;
    throw badRequest("unknown_media", `clip ${clipId} references unknown media ${missing.id}`, { clipId, mediaId: missing.id });
  }
}

export function proposeChange(ctx: Ctx, user: User, projectId: string, body: ProposeChangeRequest, checkAttempt?: () => void): ProposeResult {
  // Recovery, review and subscribers must see the proposal and its task link together.
  return ctx.db.transaction(() => {
    checkAttempt?.();
    requireUnscopedEdit(ctx, body.taskId ? ctx.repos.tasks.get(body.taskId) : undefined);
    const withdrawn = withdrawable(ctx, projectId, body);
    const aligned = opsOnWholeFrames(ctx, projectId, body);
    const result = persistProposal(ctx, user, projectId, aligned);
    for (const earlier of withdrawn) putAway(ctx, earlier, WITHDRAWN, result.change.id);
    // Inside a selected passage the engine places each removal itself, so the agent is told each one it moved.
    if (!aligned.range || !body.ops || aligned.ops?.length !== body.ops.length) return result;
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
 * The earlier options a proposal withdraws. An agent sees how a suggestion or an alternative looks only once it is
 * saved, so it saves drafts; with no way to take one back, a cold-open request left the editor six options to play,
 * three of them drafts, where it meant to offer three (2026-11-15). Only the request's own options that still wait for
 * the editor can go: anything they have decided, and anything another request made, stays as it is.
 */
function withdrawable(ctx: Ctx, projectId: string, body: ProposeChangeRequest): Change[] {
  return [...new Set(body.withdraws ?? [])].map(id => {
    const earlier = ctx.repos.changes.get(id);
    if (!body.taskId || !earlier || earlier.projectId !== projectId || earlier.taskId !== body.taskId || earlier.state !== "ready" ||
        !["suggestion", "alternative"].includes(earlier.intent ?? "")) {
      throw badRequest("invalid_withdrawal", `${id} isn't a suggestion or alternative of this request that is waiting for the editor, so it can't be withdrawn.`);
    }
    return earlier;
  });
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
    const original = anchorOriginal(ctx, project, anchor, base);
    try {
      const range = cutScope(base, cutAnchorOn(anchor, base, original), body.range);
      if (!body.ops?.length || body.timeline) throw new Error("A bounded ripple edit takes synchronized ripple removals on an existing timeline.");
      return { ...body, range, ops: boundedRippleOps(body.ops, range, project.settings.fps, timelineDuration(base)) };
    } catch (error) {
      throw badRequest("cut_scope", errorMessage(error));
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
      if (!op.trackIds) {
        drift.removed(op, removed);
        const cut = Math.max(0, Math.min(duration, removed.end) - Math.min(duration, removed.start));
        duration = Math.max(0, duration - cut);
      }
      return { ...op, ...removed };
    }
    if (op.op === "rippleInsertGap") {
      const snapped = near(op, ["at", "duration"]);
      if (!snapped.trackIds && duration != null && typeof snapped.duration === "number" && snapped.duration > 0) {
        duration += snapped.duration;
      }
      return snapped;
    }
    if (op.op === "moveClip") return near(op, ["timelineIn"]);
    if (op.op === "splitClip") return near(op, ["at"]);
    if (op.op === "addClip" && op.clip && typeof op.clip === "object") return { ...op, clip: near(op.clip, clipTimes) };
    if (op.op === "updateClip" && op.patch && typeof op.patch === "object") return { ...op, patch: near(op.patch, clipTimes) };
    return op;
  }) };
}

/** Apply a proposed change: store the new version, diff, record the review windows without encoding footage. */
export function persistProposal(ctx: Ctx, user: User, projectId: string, body: ProposeChangeRequest, changeId = newId("chg"), cutReasons?: Change["cutReasons"],
  { fold = false }: { fold?: boolean } = {}): ProposeResult {
  const sourceTask = body.taskId ? ctx.repos.tasks.get(body.taskId) : null;
  if (body.taskId && sourceTask?.projectId !== projectId) throw badRequest("invalid_task", "task must belong to this project");
  if (sourceTask && !fold && FINISHED_TASK.has(sourceTask.state)) throw conflict("task_finished", "this task has already finished");
  for (const id of body.noteIds ?? []) {
    if (ctx.repos.notes.get(id)?.projectId !== projectId) throw badRequest("invalid_note", "notes must belong to this project");
  }
  const project = ensureProjectHead(ctx, projectId);
  const fromVersion = body.fromVersion ?? project.head;
  const base = resolveTimeline(ctx, project, fromVersion);
  let next: Timeline;

  if (body.ops && body.ops.length) {
    try {
      next = applyOps({ ...base, projectId }, body.ops);
    } catch (e) {
      if (e instanceof OpError) throw badRequest("invalid_ops", e.message, { op: e.op });
      throw badRequest("invalid_ops", errorMessage(e));
    }
  } else if (body.timeline) {
    next = WritableTimeline.parse({ ...body.timeline, projectId: project.id });
  } else {
    throw badRequest("missing_change", "provide `ops` or `timeline`");
  }
  assertMediaExists(ctx, next);
  if (!cutReasons && !fold && !body.range && sourceTask && selectedRange(sourceTask.context) && base.tracks.some(t => t.clips.length)) {
    const anchor = sourceTask.context;
    const original = anchorOriginal(ctx, project, anchor, base);
    try {
      const allowed = selectionPlacements(base, cutAnchorOn(anchor, base, original));
      const outside = (body.ops && rippleOutsideSelection(base, body.ops, allowed)) ?? removalOutsideSelection(base, next, allowed);
      if (outside) throw new Error(`The proposal removes footage at ${outside.start.toFixed(3)}–${outside.end.toFixed(3)} s outside the selected passage.`);
    } catch (error) {
      throw badRequest("cut_scope", errorMessage(error));
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
    ({ timeline: next, joinFades } = fadeJoins(ctx, project.id, next, proposalJoins(cutReasons)));
  }

  const author = authorFor(user, body.author);
  const stored = storeValidatedVersion(ctx, next, { parent: fromVersion, author, changeId, description: body.description }, base);
  const diff = diffTimelines(base, stored, project.settings.fps);
  // A range says where to look. One that starts on the timeline and runs past its end means "to the end"; refusing it
  // cost a pass a turn spent guessing the timeline's length.
  const ends = diff.durationAfter;
  // A save that only leaves to-dos for the editor is one edit a to-do, however the model named them: each is the
  // editor's to add, park or reject. Named none, the save changed no stretch of the video, so the request listed nothing and its
  // 27 B-roll ideas could be reached from nowhere in the chat; named once for all 33, they were one row (2026-11-23).
  // A name the model gave one to-do alone stays; any other row is the start of its to-do, and its card says it in full.
  const todos = body.ops?.length ? body.ops.flatMap(op =>
    op.op === "addMarker" && op.marker.kind === "todo" && !op.marker.resolved && op.marker.text.trim() ? [op.marker] : []) : [];
  if (todos.length && todos.length === body.ops?.length) {
    const named = body.timelineEdits ?? [];
    const holds = (edit: (typeof named)[number], time: number) => edit.range.start - 1e-6 <= time && time <= edit.range.end + 1e-6;
    const own = todos.map(marker => {
      const on = named.filter(edit => holds(edit, marker.time));
      return on.length === 1 && todos.filter(other => holds(on[0]!, other.time)).length === 1 ? on[0] : undefined;
    });
    if (named.length !== todos.length || own.some(edit => !edit)) {
      body = { ...body, timelineEdits: todos.map((marker, i) => own[i] ?? { label: rowWords(marker.text), range: { start: marker.time, end: marker.time } }) };
    }
  }
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
    // An edit another request made counts as this thread's while this thread flagged it: the editor revises it from here.
    const ownOrFlagged = previous && (threadOfChange(ctx, previous) === threadId ||
      (previous.flags ?? []).some(flag => { const raiser = ctx.repos.tasks.get(flag.taskId); return !!raiser && threadOf(raiser) === threadId; }));
    if (!previous || previous.projectId !== projectId || previous.state !== "approved" || !ownOrFlagged ||
        replaces.spot >= (count ?? 0) || replacements.has(key)) {
      throw badRequest("invalid_replacement", "Choose an individual edit in this thread to revise.");
    }
    replacements.add(key);
  }
  const requested = body.intent === "requested" && sourceTask?.createdBy.type === "human"
    && editsDialogue(sourceTask.kind) && sourceTask.context.branch === project.branch;
  const autoApply = (requested && !sourceTask.context.reviewAllCuts && body.autoApprove !== false) || (!sourceTask && body.autoApprove === true
    && author.type === "human" && !["suggestion", "alternative"].includes(body.intent ?? ""));

  const handle = ctx.settings().render.handleSeconds;
  const multiple = !!body.ops?.length && diff.ranges.length > 1;
  // Ordinary small edits finish inline; expensive checks run outside this transaction.
  const cost = (body.ops?.length ?? 0) * diff.ranges.length * base.tracks.reduce((n, track) => n + track.clips.length, 0);
  const owners = multiple ? independentCutSpots(base, body.ops!, diff.spots, project.settings.fps)
    ?? independentClipSpots(base, body.ops!, diff.ranges, 0.3, project.settings.fps, diff.spots) : undefined;
  const spotAssignment = owners ? { fps: project.settings.fps, owners } : multiple && cost <= 300 ? {
    fps: project.settings.fps, owners: assignSpots(base, body.ops!, diff.ranges, project.settings.fps),
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
    reason: body.reason,
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

  if (alternativeAlreadyChosen(ctx, change, project.head)) change = rejectChange(ctx, user, change, "Another alternative was chosen");
  // Another request may have changed the video since this one read it. An edit that meets none of those changes goes
  // onto the video as it is now. One that does isn't applied, and its agent is told what met and where.
  let notApplied: ProposeResult["notApplied"];
  if (autoApply) {
    const applied = approveChange(ctx, user, change, { automatic: requested });
    change = applied.change;
    const current = ctx.repos.projects.header(projectId)?.head;
    if (applied.outcome === "conflict" && applied.reason && current) {
      const editorAsked = editorAskedSince(ctx, projectId, fromVersion, current);
      notApplied = { reason: applied.reason, currentVersion: current, ...(editorAsked.length && { editorAsked }) };
      ctx.log(`[edit] ${change.id} not applied: the video moved from ${fromVersion} to ${current} under it (${applied.reason})`);
    }
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
  return { change, timeline: stored, duration: diff.durationAfter, diffDescription: describeDiff(diff, undefined, clipById), ...(notApplied && { notApplied }) };
}

/** Tell the editor when an agent's change is ready for a decision. */
export function notifyReady(ctx: Ctx, change: Change) {
  if (change.author.type !== "agent") return;
  notify(ctx, `Change ready for review: ${change.description.slice(0, 80)}`, {
    body: `${change.author.name} proposed a change with ${change.ranges.length} affected range(s).`,
    projectId: change.projectId,
    link: reviewItemPath(change.projectId, change.id),
  });
}

/** A to-do's words as its row's: whole when they fit on a row's two lines in the chat, else up to the last word that does. */
function rowWords(text: string, max = 72): string {
  const words = text.trim().replace(/\s+/g, " ");
  if (words.length <= max) return words;
  const cut = words.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max >> 1)).replace(/[\s,;:.]+$/, "")}…`;
}
