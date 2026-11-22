import { z } from "zod/v3";
import { beginRevision, type ApproveResponse, type Task, type User } from "@scarlet/shared";
import {
  appliedCutReview,
  diffTimelines,
  historyLineage,
  makeTimeMap,
  planApply,
  replayHistoryEdit,
  timelineDuration,
  TimelineOp,
  type ApplyPlan,
  type Change,
  type JoinFades,
  type Project,
  type Timeline,
} from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { now } from "../../db.js";
import { badRequest, conflict, notFound } from "../../errors.js";
import type { BusEvents } from "../../events.js";
import { errorMessage } from "../../util.js";
import { actorFor, authorName, logActivity, quote } from "../activity.js";
import { proposalAfterRevisions, resumeReviewState } from "../revisionState.js";
import { reviewedCutsOnHead } from "../stagedCutRecovery.js";
import { createTask } from "../tasks.js";
import { ensureProjectHead, resolveTimeline, storeVersion } from "../timeline.js";
import { ACTIVE_TASK, authorsAgent, latestAttempt, saveChange, STALE_SAVE, threadOfChange } from "./common.js";
import { keptCuts, prepareCutReview, recheckApprovedCut, recordPlayableDecision } from "./cutReview.js";
import { fadeJoins, fadePlaced, noFades } from "./joinCrossfades.js";
import { leftOutOf, retireOtherVersions } from "./leftOutAndRepairs.js";
import { notifyReady } from "./propose.js";
import { spotWindows } from "./spotChecks.js";
import { assertStagedCallsStand } from "./stagedCutLineage.js";

export type ApproveResult = Omit<ApproveResponse, "task"> & { task?: Task };

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
      ctx.log(`[review] couldn’t update the edits waiting on render ${event.renderId} (${event.state}): ${errorMessage(error)}`);
    }
  });
}

export function alternativeAlreadyChosen(ctx: Ctx, change: Change, head: string) {
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

type ResolvedTarget =
  | { early: ApproveResult }
  | { target: string; outcome: ApproveResult["outcome"]; appliedReview?: Change["appliedReview"]; appliedJoinFades?: JoinFades };

function resolveRestoredCutsTarget(
  ctx: Ctx,
  project: Omit<Project, "media"> & { head: string },
  headTl: Timeline,
  change: Change,
  restoredCuts: number[],
): ResolvedTarget {
  const { head } = project;
  if (change.state !== "ready") throw conflict("cut_review_stale", "The edit changed during review. Review a proposal for the current edit.");
  const unchanged = head === change.fromVersion && !change.cutEdits?.length;
  const { review, draft, joinFades } = prepareCutReview(ctx, change, unchanged ? restoredCuts : undefined);
  if (!review) throw badRequest("cuts_unsupported", "This proposal has no individually restorable cuts.");
  if (unchanged) {
    if (!draft) throw badRequest("cuts_unsupported", "This proposal has no individually restorable cuts.");
    const appliedReview = appliedCutReview(review, restoredCuts, !!change.timelineEdits?.length);
    const target = draft.version;
    // With every cut applied the draft is the proposal, faded as `joinFades` says.
    const appliedJoinFades = target !== change.toVersion ? joinFades ?? (restoredCuts.length ? noFades() : change.joinFades) : undefined;
    if (target !== head && target !== change.toVersion && !ctx.repos.versions.get(project.id, target)?.changeId) ctx.repos.versions.setChangeId(project.id, target, change.id);
    return { target, outcome: "applied", appliedReview, appliedJoinFades };
  }
  // The edit moved during review: the editor's own edit, or a request that finished meanwhile. The chosen cuts
  // are anchored in the footage, so they carry onto the current edit unless one touches footage that changed.
  if (review.firstCut) throw conflict("cut_review_stale", "The opening assembly changed during review.");
  const placed = reviewedCutsOnHead(ctx, project, change, review, headTl, restoredCuts);
  if ("conflict" in placed) {
    const { index, range, reason } = placed.conflict;
    const savedChoices = new Map(change.cutChoices?.map(c => [c.index, c]));
    const restored = new Set(restoredCuts);
    for (const [i, cut] of review.cuts.entries()) {
      if (i === index) savedChoices.delete(i);
      else savedChoices.set(i, { index: i, ...cut.removed, choice: restored.has(i) ? "keep" : "cut" });
    }
    const { change: pending, task } = recheckApprovedCut(ctx, project, { ...change, applyWhenDone: undefined }, review, { index, range, reason }, head,
      [...savedChoices.values()]);
    return { early: { change: pending, project: ctx.repos.projects.withMedia(project), task, reason, outcome: "sent_back" } };
  }
  const faded = fadePlaced(ctx, change, review, placed, headTl);
  const target = faded.timeline === headTl ? head : storeVersion(ctx, project.id, faded.timeline, {
    parent: head, changeId: change.id, author: change.author, description: change.description }).version;
  return { target, outcome: "rebased", appliedReview: placed.applied, appliedJoinFades: faded.joinFades ?? noFades() };
}

function resolvePlanApplyTarget(
  ctx: Ctx,
  user: User,
  project: Omit<Project, "media"> & { head: string },
  headTl: Timeline,
  change: Change,
  spots: number[] | undefined,
  allSpots: boolean,
  automatic?: boolean,
): ResolvedTarget {
  const { head } = project;
  const from = head === change.fromVersion ? headTl : resolveTimeline(ctx, project, change.fromVersion);
  const to = resolveTimeline(ctx, project, change.toVersion);
  const ops = change.ops ? z.array(TimelineOp).parse(change.ops) : undefined;
  if (!allSpots && ops?.length && change.spotAssignment?.fps !== project.settings.fps)
    throw conflict("review_spots_changed", "The project format changed. Reopen the proposal to review its spots.");
  let plan: ApplyPlan = planApply({ from, to, head: headTl, ops, spots, changeRanges: change.ranges, fps: project.settings.fps },
    change.spotAssignment?.owners);
  if (automatic && plan.kind !== "conflict" && head !== change.fromVersion) {
    // Check the recorded delta as well as the visible footage. Markers, track
    // settings and timeline names can conflict without changing a single frame.
    try { plan = { kind: "rebased", timeline: replayHistoryEdit(from, to, headTl, change, project.settings.fps) }; }
    catch (e) { plan = { kind: "conflict", reason: errorMessage(e) }; }
  }
  if (plan.kind === "conflict") {
    if (plan.spotsUnsupported || (spots && head === change.fromVersion)) throw badRequest("spots_unsupported", `Can't approve spots one by one: ${plan.reason}.`);
    if (automatic) {
      const pending = saveChange(ctx, { ...change, error: `${STALE_SAVE} Review this version: ${plan.reason}.` });
      return { early: { change: pending, project: ctx.repos.projects.withMedia(project), outcome: "conflict", reason: plan.reason } };
    }
    return { early: sendBack(ctx, user, { ...change, threadId: threadOfChange(ctx, change) }, ctx.repos.projects.withMedia(project), plan.reason) };
  }
  if (plan.kind === "fast-forward") return { target: change.toVersion, outcome: "applied" };
  const partial = plan.kind === "partial";
  let timeline = plan.timeline;
  let appliedJoinFades: JoinFades | undefined;
  if (change.joinFades?.fades.length) {
    // The removals landed on a cut that moved: each join they made gets the crossfade there, as far as it can.
    const map = makeTimeMap(to, timeline, project.settings.fps);
    const record = change.joinFades;
    const joins = record.fades.flatMap(f => {
      const at = map(f.at, "right");
      return at === null ? [] : [{ at, duration: f.duration ?? record.duration }];
    });
    const faded = fadeJoins(ctx, project.id, timeline, joins);
    timeline = faded.timeline;
    appliedJoinFades = faded.joinFades;
  }
  appliedJoinFades ??= noFades();
  const stored = storeVersion(ctx, project.id, timeline, {
    parent: head,
    changeId: change.id,
    author: change.author,
    description: partial ? `${change.description} (${spots!.length} of ${change.ranges.length})` : change.description,
  });
  ctx.repos.versions.setChangeId(project.id, stored.version, change.id);
  return { target: stored.version, outcome: plan.kind, appliedJoinFades };
}

/**
 * Put an approved change into the cut. If the cut moved since the agent
 * started (another change was approved), the change's edits are re-applied
 * onto it through the footage; if they touch the same moments, the change goes
 * back to its agent to redo on the current cut instead of failing.
 */
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
  const project = ensureProjectHead(ctx, change.projectId);
  const head = project.head;
  const headTl = resolveTimeline(ctx, project);
  if (alternativeAlreadyChosen(ctx, change, head)) throw conflict("alternative_chosen", "Undo the chosen alternative before applying another on this branch.");
  // Older assessments recorded the first preview as their only indication that the pass had published a call.
  const reviewTask = change.assessedForReview || change.firstDecisionPreview ? latestAttempt(ctx, change.taskId) : undefined;
  if (change.state === "revising" && change.revisionFrom) {
    const checking = ctx.repos.tasks.get(change.revisionFrom.taskId);
    if (checking?.cutConflict && ACTIVE_TASK.has(checking.state))
      return { change, project: ctx.repos.projects.withMedia(project), outcome: "sent_back", task: checking };
  }
  if (reviewTask && ["running", "claimed", "queued"].includes(reviewTask.state))
    throw conflict("review_in_progress", "Your choices can be staged while Scarlet checks the remaining cuts.");
  if (change.cutAssessments?.length && !opts.restoredCuts) {
    const review = prepareCutReview(ctx, change).review;
    if (!review || opts.spots || change.cutAssessments.length !== review.cuts.length || change.cutAssessments.some(a => a.verdict === "ask"))
      throw conflict("review_decisions_needed", "Open Needs your call to finish the outstanding decisions.");
    // The editor's call on a cut stands over Scarlet's verdict, as when the pass is applied once it finishes.
    opts = { ...opts, restoredCuts: keptCuts(change, review) };
  }
  if (change.cutEdits?.length && !opts.restoredCuts) {
    if (opts.spots) throw badRequest("spots_unsupported", "Review this pass by its individual cuts.");
    opts = { ...opts, restoredCuts: (change.cutChoices ?? []).filter(c => c.choice === "keep").map(c => c.index) };
  }
  const spots = opts.spots?.filter((i) => i >= 0 && i < change.ranges.length);
  if (opts.spots && !spots?.length) throw badRequest("no_spots", "pick at least one spot to approve, or reject the change");

  const allSpots = !spots || change.ranges.every((_, i) => spots.includes(i));
  let resolved: ResolvedTarget;
  if (opts.restoredCuts) {
    resolved = resolveRestoredCutsTarget(ctx, project, headTl, change, opts.restoredCuts);
  } else if (head === change.toVersion) {
    if (!allSpots) throw badRequest("spots_unsupported", "All spots are already present in the current edit");
    resolved = { target: change.toVersion, outcome: "applied" };
  } else if (allSpots && head === change.fromVersion && ctx.repos.versions.exists(project.id, change.toVersion)) {
    resolved = { target: change.toVersion, outcome: "applied" };
  } else {
    resolved = resolvePlanApplyTarget(ctx, user, project, headTl, change, spots, allSpots, opts.automatic);
  }
  if ("early" in resolved) return resolved.early;
  let { target } = resolved;
  const { outcome, appliedReview, appliedJoinFades } = resolved;

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
  // A finished pass whose calls the editor has just made stays finished: each call played its join for them as they
  // decided it. Checking the video again afterwards once started the pass back up after the editor's last Approve and
  // re-cut that join three times (2026-11-17), and since 2026-11-21 no repeat check sends a finished pass back at all.
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
    data: {
      changeId: saved.id,
      threadId: saved.threadId,
      ...(saved.taskId && { taskId: saved.taskId }),
      branch: project.branch,
      author: saved.author,
      outcome,
      version: target,
      onto: head,
      durationBefore: timelineDuration(headTl),
      durationAfter: timelineDuration(snapshot.timeline),
      editCount: saved.timelineEdits?.length ?? saved.ranges.length,
      rangesCount: saved.ranges.length,
      ...(saved.ops?.length && { opsCount: saved.ops.length }),
      ...(saved.approvedSpots && { approvedSpots: saved.approvedSpots }),
      ...(saved.restoredCuts?.length && { restoredCuts: saved.restoredCuts }),
    },
  });
  return { change: saved, project: updated, outcome };
}

/** The cut moved under this change in a way it can't absorb: ask its agent to redo it, in the same thread. */
function sendBack(ctx: Ctx, user: User, change: Change, project: Project, reason: string): ApproveResult {
  if (change.author.type !== "agent") {
    throw conflict("needs_redo", `This change can't be merged: ${reason}. Make it again on the current edit.`);
  }
  const target = authorsAgent(ctx, change.author);
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
  const project = ctx.repos.projects.header(change.projectId);
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
    data: {
      changeId: change.id,
      threadId: change.threadId,
      ...(change.taskId && { taskId: change.taskId }),
      branch: project.branch,
      version: onto,
      from: applied,
      durationBefore: timelineDuration(resolveTimeline(ctx, project, applied)),
      durationAfter: timelineDuration(resolveTimeline(ctx, project, onto)),
    },
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
