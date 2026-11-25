import { createHash } from "node:crypto";
import { beginRevision, reviewItemPath, sameRun, type Task, type User } from "@scarlet/shared";
import {
  appliedCutReview,
  appliedReviewChange,
  CUT_LEAD_SECONDS,
  CUT_TAIL_SECONDS,
  cutPlaybackWindow,
  diffTimelines,
  isolatedReviewCut,
  isPublishedCall,
  planCutReview,
  reviewedTimeline,
  timelineDuration,
  newId,
  type Change,
  type CutAssessment,
  type CutChoice,
  type CutReview,
  type JoinFades,
  type Project,
  type Timeline,
  type TimelineDiff,
  type TimeRange,
} from "@scarlet/timeline";
import type { Render } from "@scarlet/shared";
import type { Ctx } from "../../context.js";
import { now } from "../../db.js";
import { badRequest, conflict, HttpError, notFound } from "../../errors.js";
import { logId } from "../../logText.js";
import { errorMessage, rememberLast } from "../../util.js";
import { notify } from "../notify.js";
import { requestCutPlaybackFile, waitForPlayback } from "../playback.js";
import { currentCutRanges, reviewedCutsOnHead } from "../stagedCutRecovery.js";
import { createTask, FINISHED_TASK } from "../tasks.js";
import { resolveTimeline, storeVersion } from "../timeline.js";
import { CARRIED, latestAttempt, REVISED, saveChange, threadOfChange } from "./common.js";
import { cutRevisionReference } from "./cutRevisionPrompts.js";
import { fadeJoins, fadePlaced, reviewedJoins } from "./joinCrossfades.js";
import { approveChange } from "./lifecycle.js";
import { activeStagedCut, requireUnscopedEdit, revisedPass } from "./stagedCutLineage.js";

/** Queue the actual edited media a call will open, including the footage on both sides of the join, as its player asks for it. */
function queueDecisionPlayback(ctx: Ctx, change: Change, review: CutReview, index: number, owner: string): Render | undefined {
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
  return requestCutPlaybackFile(ctx, project, after.version, range, owner);
}

/** Hold `owner`'s claim on a queued file until it is ready, then let it go: the finished file stays for the player. */
function releaseWhenReady(ctx: Ctx, change: Change, render: Render, owner: string, done?: () => void) {
  if (render.state === "done") {
    ctx.renders.release(render.id, owner);
    return done?.();
  }
  ctx.db.afterCommit(() => {
    const signal = ctx.mediaSignal(change.projectId);
    void ctx.track(waitForPlayback(ctx, render, signal).finally(() => { ctx.renders.release(render.id, owner); done?.(); }), change.projectId)
      .catch(error => { if (!signal.aborted) ctx.log(`[review] Could not prepare a file for ${change.id}: ${error}`); });
  });
}

/** Queue the actual edited media the first call will open, including the footage on both sides of the join. */
function prepareFirstDecision(ctx: Ctx, change: Change, review: CutReview, index: number): Change["firstDecisionPreview"] {
  const owner = newId("prep");
  const render = queueDecisionPlayback(ctx, change, review, index, owner);
  if (!render) return;
  releaseWhenReady(ctx, change, render, owner);
  return { index, renderId: render.id, queuedAt: now() };
}

/**
 * The waiting call the editor reaches after deciding `decided`, as Keep moves on For you: the next by number, else
 * the first by number. A call they have decided, or sent back to Scarlet, isn't waiting.
 */
function nextWaitingCall(change: Change, decided?: number, sentBack: ReadonlySet<number> = new Set()): number | undefined {
  const called = new Set(change.cutChoices?.map(c => c.index));
  const waiting = (change.cutAssessments ?? []).filter(a => isPublishedCall(a) && a.index !== decided && !called.has(a.index) && !sentBack.has(a.index))
    .sort((a, b) => (a.askOrder ?? Infinity) - (b.askOrder ?? Infinity) || a.index - b.index);
  const after = change.cutAssessments?.find(a => a.index === decided)?.askOrder;
  return (after === undefined ? undefined : waiting.find(a => (a.askOrder ?? Infinity) > after))?.index ?? waiting[0]?.index;
}

/** The next call each waiting pass has queued, by pass. One at a time: the editor reaches one call next. */
const nextCalls = new WeakMap<Ctx, Map<string, { index: number; renderId: string; owner: string }>>();

/**
 * After the editor decides a call (Keep, Reject edit or Revise), queue the next waiting call's media as the first
 * call's is, so it plays at once when they reach it. It is queued once the decision is saved, as a speculative render
 * the editor's own playback goes ahead of. A call queued earlier that is no longer next is let go: a render no one
 * else is watching stops, and one the editor opened plays on. Caller holds the write lock.
 */
export function prepareNextDecision(ctx: Ctx, changeId: string, decided?: number) {
  ctx.db.afterCommit(() => {
    const projectId = ctx.repos.changes.get(changeId)?.projectId;
    if (!projectId) return;
    // After the decision's own answer has gone out: the editor waits on that, not on this.
    void ctx.track(new Promise<void>(resolve => setImmediate(resolve)).then(() => ctx.db.transaction(() => {
      const byPass = nextCalls.get(ctx) ?? new Map<string, { index: number; renderId: string; owner: string }>();
      nextCalls.set(ctx, byPass);
      const change = ctx.repos.changes.get(changeId);
      const waiting = change?.intent === "suggestion" && (change.state === "ready" || change.state === "revising") && change.cutReasons?.length;
      // A call the editor sent back to Scarlet plays its revision once that lands, not the version waiting now.
      const sentBack = new Set(waiting ? ctx.repos.tasks.select("project_id = ? AND json_extract(json, '$.context.changeId') = ? AND json_extract(json, '$.context.cutIndex') IS NOT NULL",
        [change.projectId, change.id]).filter(t => !FINISHED_TASK.has(t.state)).map(t => t.context.cutIndex!) : []);
      const index = waiting ? nextWaitingCall(change, decided, sentBack) : undefined;
      const held = byPass.get(changeId);
      if (held && held.index === index && ctx.repos.renders.get(held.renderId)?.state !== "cancelled") return;
      if (held) {
        byPass.delete(changeId);
        ctx.renders.release(held.renderId, held.owner);
      }
      if (index === undefined || !change) return;
      // The first call's file, queued when Scarlet asked, serves it already.
      const first = change.firstDecisionPreview;
      const firstState = first?.index === index ? ctx.repos.renders.get(first.renderId)?.state : undefined;
      if (firstState && firstState !== "failed" && firstState !== "cancelled") return;
      const review = prepareCutReview(ctx, change).review;
      if (!review) return;
      const owner = newId("prep");
      const render = queueDecisionPlayback(ctx, change, review, index, owner);
      if (!render) return;
      const entry = { index, renderId: render.id, owner };
      byPass.set(changeId, entry);
      ctx.db.afterCommit(() => ctx.log(`[review] next_call change=${logId(changeId)} project=${logId(projectId)} cut=${index} render=${logId(render.id)} state=${render.state}`));
      releaseWhenReady(ctx, change, render, owner, () => { if (byPass.get(changeId) === entry) byPass.delete(changeId); });
    }, "immediate")()), projectId).catch(error => ctx.log(`[review] Could not prepare the next call of ${changeId}: ${errorMessage(error)}`));
  });
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
  const project = ctx.repos.projects.header(change.projectId);
  if (!project) throw notFound("project");
  const viewed = appliedReviewChange(change);
  return diffTimelines(resolveTimeline(ctx, project, viewed.fromVersion), resolveTimeline(ctx, project, viewed.toVersion), project.settings.fps);
}

export function prepareCutReview(ctx: Ctx, change: Change, restoredCuts?: number[], ontoVersion?: string): {
  review: CutReview | null; draft?: Timeline; ontoVersion?: string; removed?: TimeRange[];
  /** The requested crossfades on the draft's joins when it differs from the proposal. */
  joinFades?: JoinFades;
} {
  const project = ctx.repos.projects.header(change.projectId);
  if (!project) throw notFound("project");
  if (ontoVersion && !restoredCuts) throw badRequest("invalid_cut_selection", "Choose the cuts to preview.");
  if (ontoVersion && project.head !== ontoVersion)
    throw conflict("cut_review_stale", "The video changed while this cut was open. Open it again.", { currentVersion: project.head });
  const base = resolveTimeline(ctx, project, change.fromVersion);
  const proposed = resolveTimeline(ctx, project, change.toVersion);
  // Only an opening assembly needs source durations. Its populated tracks each use a single source.
  const sources = new Set<string>();
  if (!change.ops?.length) for (const track of proposed.tracks) {
    const first = track.clips[0];
    if (first?.kind === "media") sources.add(first.mediaId);
  }
  const review = planCutReview(base, proposed, ctx.repos.projects.assets(project.id, sources), change.ops, change.firstCut);
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
    const { timeline, joinFades } = fadePlaced(ctx, change, review, placed, head);
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
  catch (err) { throw badRequest("invalid_cut_selection", errorMessage(err)); }
  // Some cuts applied and some put back: the proposal's fades were on other joins, so these joins get their own. With
  // none put back the draft is the proposal, faded already; with all put back nothing was cut.
  let joinFades: JoinFades | undefined;
  if (restoredCuts.length && restoredCuts.length < review.cuts.length && !review.firstCut)
    ({ timeline: result, joinFades } = fadeJoins(ctx, project.id, result, reviewedJoins(change, review, restoredCuts)));
  const draft = storeVersion(ctx, project.id, result, { parent: change.fromVersion, author: change.author, changeId: change.id,
    description: `${change.description} · ${restoredCuts.length} restored` });
  ctx.db.afterCommit(() => {
    rememberLast(ctx.reviewDrafts, draftKey, { version: draft.version, joinFades }, 32);
  });
  return { review, draft, joinFades, ...placement };
}

/** The editor's call on each staged cut, or what Approve does without one: Scarlet's verdict once it has assessed the pass, else cut. */
function cutDecision(change: Change, index: number): CutChoice["choice"] {
  const chosen = change.cutChoices?.find(c => c.index === index)?.choice;
  if (chosen) return chosen;
  if (!change.cutAssessments?.length) return "cut";
  return change.cutAssessments.find(a => a.index === index)?.verdict === "cut" ? "cut" : "keep";
}

/** The cuts Approve puts back: those decided as keep. */
export function keptCuts(change: Change, review: CutReview): number[] {
  return review.cuts.flatMap((_, i) => cutDecision(change, i) === "keep" ? [i] : []);
}

export interface SaveCutChoicesBody {
  fromVersion: string;
  toVersion: string;
  choices: Array<{ index: number; choice: CutChoice["choice"] }>;
  applyWhenDone?: boolean;
}

/** Forward choices sent against a replaced pass onto its live successor, keeping newer decisions intact. */
function forwardChoicesToLivePass(ctx: Ctx, user: User, change: Change, body: SaveCutChoicesBody): Change {
  const project = ctx.repos.projects.header(change.projectId);
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
  throw conflict("cut_review_moved", "This pass has changed since. Open the call again from For you.");
}

/**
 * Save the editor's calls on a dialogue pass as they make them, and whether to apply them once the pass finishes.
 * While one cut is being revised the editor can keep calling the others, and the revision carries those calls.
 */
export function saveCutChoices(ctx: Ctx, user: User, change: Change, body: SaveCutChoicesBody): Change {
  if (change.intent !== "suggestion" || !change.cutReasons?.length || change.fromVersion !== body.fromVersion || change.toVersion !== body.toVersion)
    throw conflict("cut_review_stale", "This pass isn’t waiting on your calls any more.");
  const replaced = change.rejectReason === CARRIED || change.rejectReason === REVISED ||
    change.state === "revising" && !!revisedPass(ctx, change);
  if (replaced) return forwardChoicesToLivePass(ctx, user, change, body);
  if (change.state !== "ready" && change.state !== "revising")
    throw conflict("cut_review_stale", "This pass isn’t waiting on your calls any more.");
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
  const previous = new Map(change.cutChoices?.map(c => [c.index, c.choice]));
  const approved: number[] = [], skipped: number[] = [], cleared: number[] = [];
  for (const [index, { choice }] of byIndex) {
    if (previous.get(index) === choice) continue;
    (choice === "cut" ? approved : skipped).push(index);
  }
  for (const index of previous.keys()) if (!byIndex.has(index)) cleared.push(index);
  const target = `change=${logId(change.id)} project=${logId(change.projectId)}${change.taskId ? ` task=${logId(change.taskId)}` : ""}`;
  if (approved.length || skipped.length || cleared.length) ctx.db.afterCommit(() => {
    const slots = (cuts: number[]) => JSON.stringify(cuts.sort((a, b) => a - b).slice(0, 20));
    ctx.log(`[review] choices ${target} approved=${approved.length} approvedCuts=${slots(approved)} skipped=${skipped.length}` +
      ` skippedCuts=${slots(skipped)} cleared=${cleared.length} clearedCuts=${slots(cleared)}`);
  });
  if (!!applyWhenDone !== !!change.applyWhenDone) ctx.db.afterCommit(() => ctx.log(`[review] schedule ${target} outcome=${applyWhenDone ? "set" : "cleared"} reason=editor`));
  // The call the editor reaches next plays at once too. Of several decided together, the latest by number leads.
  const decided = [...approved, ...skipped].map(index => change.cutAssessments?.find(a => a.index === index) ?? { index, askOrder: undefined })
    .sort((a, b) => (b.askOrder ?? -1) - (a.askOrder ?? -1))[0]?.index;
  if (decided !== undefined) prepareNextDecision(ctx, change.id, decided);
  return recheckMovedCalls(ctx, saved, change, review) ?? applyChoicesWhenDone(ctx, saved) ?? saved;
}

export interface SaveCutAssessmentsBody {
  fromVersion: string;
  toVersion: string;
  assessments: Array<Omit<CutAssessment, "provisional" | "askOrder" | "revised"> & { amend?: boolean }>;
}

/** Persist Scarlet's cut assessments on a waiting dialogue pass, numbering calls and prefetching the first decision. Caller holds the write lock. */
export function saveCutAssessments(ctx: Ctx, change: Change, task: Task | undefined, body: SaveCutAssessmentsBody) {
  const owner = change.taskId && ctx.repos.tasks.get(change.taskId);
  requireUnscopedEdit(ctx, task, !!task && !!owner && sameRun(task, owner));
  // A recommendation describes the proposal itself, so it still holds after the edit moves on: approval carries the cuts across.
  if (change.state !== "ready" || change.intent !== "suggestion" || change.fromVersion !== body.fromVersion || change.toVersion !== body.toVersion)
    throw conflict("cut_review_stale", "Reopen the proposal for the current edit.");
  const review = prepareCutReview(ctx, change).review;
  if (!review) throw badRequest("cuts_unsupported", "This edit has no individual cuts.");
  const previous = new Map(change.cutAssessments?.map(a => [a.index, a]));
  const byIndex = new Map(previous);
  // A cut the editor sent back waits for their call on the revised version, whatever Scarlet recommends on it.
  const heldRevised: number[] = [];
  const heldForEditor: number[] = [];
  const heldCalls: number[] = [];
  const amended: number[] = [];
  const called = new Set(change.cutChoices?.map(choice => choice.index));
  // The range guards against a recommendation landing on another cut after the indices shift. Cuts sit on whole
  // frames, so a range within a frame names this one: an agent that copied 18.9667 for 18.96666… was refused,
  // twice in one pass, and one that gave the range it had asked for, 9.59 to 11.33 s for a cut saved a frame
  // inward as 9.6 to 11.3 s, once more. The cut's own range is what gets saved.
  const slack = 1 / (ctx.repos.projects.header(change.projectId)?.settings.fps || 30) + 0.001;
  for (const { amend, ...given } of body.assessments) {
    const span = review.cuts[given.index]?.removed;
    if (!span) throw badRequest("wrong_cut", `This pass has no cut ${given.index}. Its cuts are numbered 0 to ${review.cuts.length - 1}.`);
    if (Math.abs(span.start - given.start) > slack || Math.abs(span.end - given.end) > slack) {
      throw badRequest("wrong_cut", `Cut ${given.index} of this pass is ${span.start.toFixed(3)}–${span.end.toFixed(3)} s, not ${given.start.toFixed(3)}–${given.end.toFixed(3)} s. Give its range, or the index of the cut you mean.`);
    }
    const item = { ...given, start: span.start, end: span.end };
    const suggestOnly = item.verdict === "cut" && change.cutReasons?.some(r => r.legacySuggest &&
      r.start >= span.start - 0.00001 && r.start < span.end);
    if (suggestOnly) heldForEditor.push(item.index);
    const shown = previous.get(item.index);
    if (shown && (isPublishedCall(shown) || shown.askOrder !== undefined)) {
      // A call still waiting on the editor takes a new note when Scarlet means to change it: something found after
      // asking that the editor should know before deciding, such as a join that clips a word. Its number, footage
      // and verdict stay. A pass that couldn't, asked the editor a separate question about the call (2026-11-16).
      if (amend && isPublishedCall(shown) && item.verdict === "ask" && !called.has(item.index)) {
        if (shown.reason !== item.reason || item.summary && shown.summary !== item.summary) {
          byIndex.set(item.index, { ...shown, reason: item.reason, ...(item.summary && { summary: item.summary }), inspected: shown.inspected || item.inspected });
          amended.push(item.index);
        }
        continue;
      }
      if (shown.reason !== item.reason || shown.summary !== item.summary || item.verdict !== shown.verdict) {
        if (shown.revised && item.verdict !== "ask") heldRevised.push(item.index);
        else heldCalls.push(item.index);
      } else if (item.inspected && !shown.inspected) {
        byIndex.set(item.index, { ...shown, inspected: true });
      }
      continue;
    }
    byIndex.set(item.index, { ...item, verdict: suggestOnly ? "ask" : item.verdict });
  }
  const cutAssessments = [...byIndex.values()].sort((a, b) => a.index - b.index);
  // An ask's note is the one line the editor reads on that call, in the list and on its card. Asks that all carry
  // the same words can't be told apart there: a pass whose four calls each read "The restart should come out; the
  // measured edge needs a listening check." left the editor to open every one to learn what it was (2026-11-11).
  // The save is refused with the cuts named, so each gets a note of its own. Cuts the editor has already been
  // shown under one note aren't held against a save that doesn't touch them.
  const newCall = (index: number) => {
    const before = previous.get(index);
    return !before || !isPublishedCall(before) || amended.includes(index);
  };
  const byNote = new Map<string, number[]>();
  for (const a of cutAssessments) {
    if (!isPublishedCall(a)) continue;
    const words = a.reason.toLowerCase().replace(/\s+/g, " ").trim();
    byNote.set(words, [...(byNote.get(words) ?? []), a.index]);
  }
  const repeated = [...byNote.values()].find(cuts => cuts.length > 1 && cuts.some(newCall));
  if (repeated) {
    throw badRequest("same_note", `Cuts ${repeated.join(", ")} would reach the editor with the same note: “${byIndex.get(repeated[0]!)!.reason.slice(0, 120)}”. `
      + "The note is the one line the editor reads on each call, so they couldn’t tell these apart. Nothing was saved. "
      + "Give each its own: the words this cut takes out or keeps, and what to listen for at its join.");
  }
  // Each new ask is numbered after every ask before it: in the order Scarlet makes them, and within one save in
  // timeline order. The calls keep that order. A pass whose asks aren't numbered yet, as one saved
  // before the engine numbered them, numbers the asks it already has first, in timeline order, so none of the calls
  // the editor has seen moves. Once a pass numbers its asks, one left without a number is a cut no one checked that
  // the editor sent back, and it stays with those.
  let order = Math.max(0, ...cutAssessments.map(a => a.askOrder ?? 0));
  const unnumbered = (a: CutAssessment) => isPublishedCall(a) && a.askOrder === undefined;
  const shown = !order && cutAssessments.some(a => unnumbered(a) && newCall(a.index)) ? cutAssessments.filter(a => unnumbered(a) && !newCall(a.index)) : [];
  for (const a of [...shown, ...cutAssessments.filter(a => unnumbered(a) && newCall(a.index))]) {
    cutAssessments[cutAssessments.indexOf(a)] = { ...a, askOrder: ++order };
  }
  let firstDecisionPreview = change.firstDecisionPreview;
  if (firstDecisionPreview && firstDecisionPreview.briefToPlayableMs === undefined) {
    const item = byIndex.get(firstDecisionPreview.index);
    const state = ctx.repos.renders.get(firstDecisionPreview.renderId)?.state;
    if (!item || !isPublishedCall(item) || !state || state === "failed" || state === "cancelled") firstDecisionPreview = undefined;
  }
  // A later assessment can land earlier on the timeline while media preparation is paused.
  // Cue the first call in the order the editor sees when preparation resumes.
  const calls = cutAssessments.filter(isPublishedCall);
  const first = calls.reduce<CutAssessment | undefined>((earliest, item) =>
    !earliest || (item.askOrder ?? Infinity) < (earliest.askOrder ?? Infinity) ? item : earliest, undefined);
  if (!firstDecisionPreview && first) {
    try {
      firstDecisionPreview = prepareFirstDecision(ctx, change, review, first.index);
    } catch (error) {
      ctx.log(`[review] Could not prefetch the first decision for ${change.id}: ${error}`);
    }
  }
  // A pass set to apply when the run finishes was scheduled on the calls made so far. A cut Scarlet now asks about,
  // with no call from the editor, waits for them: applying on schedule would skip it unseen.
  const applyWhenDone = cutAssessments.some(a => isPublishedCall(a) && !called.has(a.index)) ? undefined : change.applyWhenDone;
  const assessedForReview = first ? true : change.assessedForReview;
  if (assessedForReview !== change.assessedForReview || firstDecisionPreview !== change.firstDecisionPreview || applyWhenDone !== change.applyWhenDone ||
      cutAssessments.some(a => a !== previous.get(a.index))) {
    const saved = ctx.repos.changes.put({ ...change, cutAssessments, assessedForReview, firstDecisionPreview, applyWhenDone });
    ctx.bus.publish({ type: "change.updated", projectId: change.projectId, change: saved });
    const published = calls.filter(a => !previous.has(a.index) || !isPublishedCall(previous.get(a.index)!)).length;
    if (published || (change.applyWhenDone && !applyWhenDone)) ctx.db.afterCommit(() => {
      const target = `change=${logId(change.id)} project=${logId(change.projectId)}${change.taskId ? ` task=${logId(change.taskId)}` : ""}`;
      if (published) ctx.log(`[review] calls_published ${target} count=${published}`);
      if (change.applyWhenDone && !applyWhenDone) ctx.log(`[review] schedule ${target} outcome=cleared reason=new_call`);
    });
    if (firstDecisionPreview && firstDecisionPreview.briefToPlayableMs === undefined) recordPlayableDecision(ctx, saved);
  }
  return { total: review.cuts.length, assessed: cutAssessments.filter(a => !a.provisional).length,
    needsDecision: review.cuts.length - cutAssessments.filter(a => a.verdict !== "ask").length,
    ...(heldCalls.length ? { heldCalls, existingCalls: "These cuts already reached the editor as calls. Their original notes and the editor's choices stand. "
      + "To change the note of one still waiting on the editor, save it as an ask with amend:true." } : {}),
    ...(amended.length ? { amended, amendedCalls: "These calls show their new note to the editor." } : {}),
    ...(heldForEditor.length ? { heldForEditor, editorPreference: "These cuts were staged with the editor’s approval required." } : {}),
    ...(heldRevised.length ? { heldRevised, editorRequest: "The editor sent these cuts back, so each revised cut waits in Needs your call. Its revised note is preserved." } : {}) };
}

/**
 * Send one cut the editor approved back to Scarlet: its footage changed on the working cut, so it can't go in as it
 * was staged. The other calls keep their decisions (`choices`); this one asks again until the recheck lands.
 */
export function recheckApprovedCut(
  ctx: Ctx,
  project: Omit<Project, "media">,
  change: Change,
  review: CutReview,
  at: { index: number; range?: TimeRange; reason: string },
  head: string,
  choices: CutChoice[],
) {
  const { index, range, reason } = at;
  const removed = review.cuts[index]!.removed;
  const former = change.cutAssessments?.find(a => a.index === index);
  const proposed = change.cutReasons?.find(c => c.start >= removed.start - 1e-6 && c.start < removed.end);
  const assessments = [...(change.cutAssessments ?? []).filter(a => a.index !== index), {
    index, ...removed, verdict: "ask" as const, ...(former?.revised && { revised: true }), ...(former?.proposes && { proposes: former.proposes }), ...(former?.askOrder && { askOrder: former.askOrder }),
    summary: former?.summary ?? proposed?.summary,
    reason: former?.reason ?? proposed?.reason ?? "No note was saved for this cut." }];
  const checked = { ...change, cutChoices: choices.filter(c => c.index !== index), cutAssessments: assessments.sort((a, b) => a.index - b.index) };
  const prior = change.taskId ? ctx.repos.tasks.get(change.taskId) : undefined;
  const task = createTask(ctx, { projectId: project.id, kind: "revise", agent: prior?.agent ?? ctx.settings().defaultAgent,
    model: prior?.model, effort: prior?.effort, serviceTier: prior?.serviceTier, createdBy: { type: "scarlet", name: "Scarlet" },
    context: { changeId: change.id, threadId: threadOfChange(ctx, change), cutIndex: index, version: head, time: range?.start, end: range?.end,
      noteIds: change.noteIds, message: "Recheck this cut" }, cutConflict: { version: head, range, approved: true },
    instruction: `The editor approved this cut. The passage changed before it could apply. Recheck the current footage and preserve the intended edit. ${reason}` +
      cutRevisionReference(change, { cutIndex: index, time: removed.start, end: removed.end, clipIds: [] }) });
  return { change: saveChange(ctx, beginRevision(checked, task)), task };
}

/**
 * A call the editor just approved whose footage changed on the working cut since the pass staged it goes back to
 * Scarlet now, while the editor makes the other calls, instead of when the last call applies the pass (2026-11-14:
 * every such recheck waited for the last call, one after another). One recheck at a time: while the pass is being
 * revised, applying it finds the rest.
 */
function recheckMovedCalls(ctx: Ctx, saved: Change, before: Change, review: CutReview): Change | undefined {
  if (saved.state !== "ready" || review.firstCut) return;
  const project = ctx.repos.projects.header(saved.projectId);
  const head = project?.head;
  if (!project || !head || head === saved.fromVersion) return;
  const was = new Map(before.cutChoices?.map(c => [c.index, c.choice]));
  const approved = (saved.cutChoices ?? []).filter(c => c.choice === "cut" && was.get(c.index) !== "cut");
  if (!approved.length) return;
  const place = currentCutRanges(ctx, project, saved, review, resolveTimeline(ctx, project, head));
  for (const { index } of approved) {
    const at = place(index);
    if (at.kind === "conflict") return recheckApprovedCut(ctx, project, saved, review, { index, range: at.range, reason: at.reason }, head, saved.cutChoices ?? []).change;
  }
}

/**
 * Apply a dialogue pass with the editor's calls once its run has finished, when the editor asked for that.
 * Cuts the editor didn't call follow Scarlet's verdict. Null while the run is still going, nothing was asked, or a cut
 * still waits on the editor.
 *
 * A pass whose staged cuts Scarlet settled itself, every one, asking the editor nothing, goes in the same way when its
 * run finishes. The window used to be what applied it, once it saw the finished run: with the window closed, or a run
 * no window watches, the cuts Scarlet had held and then decided stayed out of the video, waits of ten seconds among
 * them (2026-11-15).
 */
export function applyChoicesWhenDone(ctx: Ctx, change: Change): Change | null {
  if (change.state !== "ready") return null;
  const unasked = !change.applyWhenDone && change.intent === "suggestion" && !!change.cutReasons?.length && !!change.cutAssessments?.length
    && change.cutAssessments.every(a => a.verdict !== "ask" && !a.provisional) && !change.error;
  if (!change.applyWhenDone && !unasked) return null;
  const task = latestAttempt(ctx, change.taskId);
  // Only a run that finished applies it. One still going isn't done, and one that stopped early left staged cuts
  // unchecked: those are the editor's calls now, and applying on their next call would skip the rest unasked.
  if (task && task.state !== "done") return null;
  if (task?.context.branch && task.context.branch !== ctx.repos.projects.header(change.projectId)?.branch) {
    ctx.db.afterCommit(() => ctx.log(`[review] apply_deferred change=${logId(change.id)} project=${logId(change.projectId)} task=${logId(task.id)} reason=branch_changed`));
    return null;
  }
  const asked = change.applyWhenDone?.userId;
  const user = (asked && ctx.repos.users.get(asked)) || ctx.repos.users.primary() || { id: asked ?? "editor", name: "Editor" };
  // Never let this stop the run from finishing: on any problem the calls stay saved for the editor to apply.
  try {
    const review = prepareCutReview(ctx, change).review;
    if (!review) throw new Error("This edit has no individual cuts");
    // A run can finish, or pause for its transcripts, without checking every staged cut. Those are the editor's calls
    // now ("Not checked yet."), as a cut Scarlet asked about is, and applying would settle them unseen (2026-11-10).
    // The schedule stands: the editor's call on the last of them applies the pass.
    const settled = new Set([...change.cutChoices ?? [], ...(change.cutAssessments ?? []).filter(a => a.verdict !== "ask")].map(c => c.index));
    const remaining = review.cuts.reduce((count, _, index) => count + Number(!settled.has(index)), 0);
    if (remaining) {
      if (!task || task.id === change.taskId) ctx.db.afterCommit(() => ctx.log(`[review] apply_deferred change=${logId(change.id)} project=${logId(change.projectId)} reason=unsettled remaining=${remaining}`));
      return null;
    }
    return approveChange(ctx, user, { ...change, applyWhenDone: undefined }, { restoredCuts: keptCuts(change, review) }).change;
  } catch (error) {
    ctx.log(`[review] Could not apply ${change.id} when its pass finished: ${error}`);
    // Nobody asked for this one: it stays as it was, for the window to apply or to say why it can't.
    if (unasked) return null;
    // A video that moved under the pass names the cut it moved under. Anything else is in the log.
    const moved = error instanceof HttpError && error.code === "cut_review_stale";
    return saveChange(ctx, { ...change, applyWhenDone: undefined,
      error: moved ? error.message : "This pass wasn’t applied when Scarlet finished, but your calls are saved: press Retry to try again." });
  }
}
