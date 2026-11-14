import { appliedReviewChange, CutAssessment, isPublishedCall, type Change } from "@scarlet/timeline";
import { Hono } from "hono";
import { z } from "zod/v3";
import { namedTimelineEdits, ApproveRequest, CutChoicesRequest, ChangeState, DialogueCutsRequest, ProposeChangeRequest, ReviseRequest, StagedCutRevision } from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { approveChange, changeDiff, saveCutChoices, prepareCutReview, prepareFirstDecision, proposeChange, recordPlayableDecision, scheduleSpotCheck, submitDialogueCuts, rejectChange, reopenChange, reviseChange, reviseStagedCut, unapproveChange, withSpotCapability } from "../services/changes.js";
import { jsonBody, requireProjectHeader, TIMELINE_JSON_BYTES } from "./util.js";
import { requestAttempt, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { requireUnscopedEdit } from "../services/changes.js";

export function changeRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  function requireChange(changeId: string, projectId?: string) {
    const change = ctx.repos.changes.get(changeId);
    if (!change || (projectId !== undefined && change.projectId !== projectId)) throw notFound(`change ${changeId}`);
    return change;
  }

  /**
   * The edit with the spots that can be approved on their own. When they can't be checked, the saved edit as it is.
   * `logged`: the check proposeChange schedules for a ready edit is this same one, and logs its failure.
   */
  const withSpots = (change: Change, logged = false) => withSpotCapability(ctx, change).catch(error => {
    if (!logged && !ctx.shutdown.aborted) ctx.log(`[review] Could not check spots for ${change.id}: ${error}`);
    return change;
  });

  r.post("/projects/:id/changes", async (c) => {
    const body = await jsonBody(c, ProposeChangeRequest, TIMELINE_JSON_BYTES);
    const attempt = requestAttempt(c.req.raw), projectId = c.req.param("id");
    body.taskId ??= attempt?.taskId;
    const result = proposeChange(ctx, c.var.user, projectId, body, () => requireProjectEditAttempt(ctx, attempt, projectId, body.taskId));
    if (c.req.query("summary") === "true") {
      const viewed = appliedReviewChange(result.change);
      const { id, state, description, fromVersion, toVersion, ranges, timelineEdits } = viewed;
      return c.json({ change: { id, state, description, fromVersion, toVersion, ranges, timelineEdits }, duration: result.duration, diffDescription: result.diffDescription,
        ...(result.onWholeFrames && { onWholeFrames: result.onWholeFrames }) }, 201);
    }
    // The proposal is saved by now, so a failed check must not read as a failed proposal.
    return c.json({ ...result, change: await withSpots(result.change, result.change.state === "ready") }, 201);
  });

  r.post("/projects/:id/dialogue-cuts", async c => {
    const body = await jsonBody(c, DialogueCutsRequest);
    const attempt = requestAttempt(c.req.raw), projectId = c.req.param("id");
    body.taskId ??= attempt?.taskId;
    const { changes, carriedForward, editorDecided, heldForReview, alreadyRemoved, joinCrossfades, stagedForEditor, onFrames, droppedFromReview } = submitDialogueCuts(ctx, c.var.user, projectId, body,
      { checkAttempt: () => requireProjectEditAttempt(ctx, attempt, projectId, body.taskId) });
    return c.json({ changes: changes.map(change => {
      const { id, state, fromVersion, toVersion, description, intent } = change;
      return { id, state, fromVersion, toVersion, description, intent, timelineEdits: namedTimelineEdits(change) };
    }), ...(carriedForward && { carriedForward }),
      // Ranges the editor already called in an earlier part. Their call stands: this part's cuts there were left out, and
      // a staged cut they hadn't called that now sits right against footage they chose to keep is kept with it.
      ...(editorDecided && { editorDecided }), ...(heldForReview && { heldForReview }), ...(alreadyRemoved && { alreadyRemoved }),
      // The requested crossfade on the joins these cuts made: how many got it, and each join left a straight cut with why.
      ...(joinCrossfades && { joinCrossfades }),
      // What Scarlet changed on its own: confident cuts it staged, edges it put on frames, earlier staged cuts it let go.
      ...(stagedForEditor && { stagedForEditor }), ...(onFrames && { onFrames }), ...(droppedFromReview && { droppedFromReview }),
      // The version to build on next: where the confident cuts left the edit.
      head: ctx.repos.projects.get(c.req.param("id"))?.head }, 201);
  });

  r.get("/projects/:id/changes", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const state = c.req.query("state");
    const changes = state
      ? ctx.repos.changes.select("project_id = ? AND state = ?", [project.id, ChangeState.parse(state)], "created_at DESC")
      : ctx.repos.changes.select("project_id = ?", [project.id], "created_at DESC");
    for (const change of changes) scheduleSpotCheck(ctx, change, project.settings.fps);
    return c.json({ changes });
  });

  r.on("GET", ["/changes/:changeId", "/projects/:projectId/changes/:changeId"], async (c) => {
    const record = requireChange(c.req.param("changeId"), c.req.param("projectId"));
    if (c.req.query("view") === "record") {
      requireProjectHeader(ctx, record.projectId);
      return c.json({ change: record });
    }
    const change = await withSpots(record);
    return c.json({ change, diff: changeDiff(ctx, change) });
  });

  r.on("POST", ["/changes/:changeId/cut-review", "/projects/:projectId/changes/:changeId/cut-review"], async (c) => {
    const { restoredCuts, ontoVersion } = await jsonBody(c, z.object({
      restoredCuts: z.array(z.number().int().min(0)).optional(), ontoVersion: z.string().min(1).optional(),
    }));
    const change = requireChange(c.req.param("changeId"), c.req.param("projectId"));
    const result = prepareCutReview(ctx, change, restoredCuts, ontoVersion);
    return c.json(c.req.query("view") === "draft" ? { draft: result.draft, ontoVersion: result.ontoVersion, removed: result.removed } : result);
  });

  r.on("POST", ["/changes/:changeId/cut-assessments", "/projects/:projectId/changes/:changeId/cut-assessments"], async c => {
    const body = await jsonBody(c, z.object({ fromVersion: z.string(), toVersion: z.string(),
      assessments: z.array(CutAssessment.omit({ provisional: true, askOrder: true, revised: true })).min(1).max(500) }));
    return c.json(ctx.db.transaction(() => {
      const change = requireChange(c.req.param("changeId"), c.req.param("projectId"));
      const task = requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), change.projectId);
      const owner = change.taskId && ctx.repos.tasks.get(change.taskId);
      requireUnscopedEdit(ctx, task, !!task && !!owner && (owner.resumeRootId ?? owner.id) === (task.resumeRootId ?? task.id));
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
      // The range guards against a recommendation landing on another cut after the indices shift. Cuts sit on whole
      // frames, so a range within a frame names this one: an agent that copied 18.9667 for 18.96666… was refused,
      // twice in one pass, and one that gave the range it had asked for, 9.59 to 11.33 s for a cut saved a frame
      // inward as 9.6 to 11.3 s, once more. The cut's own range is what gets saved.
      const slack = 1 / (ctx.repos.projects.get(change.projectId)?.settings.fps || 30) + 0.001;
      for (const given of body.assessments) {
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
          if (shown.reason !== item.reason || item.verdict !== shown.verdict) {
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
        return !before || !isPublishedCall(before);
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
      // timeline order. The editor's number for a call goes by it. A pass whose asks aren't numbered yet, as one saved
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
      const called = new Set(change.cutChoices?.map(choice => choice.index));
      const applyWhenDone = cutAssessments.some(a => isPublishedCall(a) && !called.has(a.index)) ? undefined : change.applyWhenDone;
      const assessedForReview = first ? true : change.assessedForReview;
      if (assessedForReview !== change.assessedForReview || firstDecisionPreview !== change.firstDecisionPreview || applyWhenDone !== change.applyWhenDone ||
          cutAssessments.some(a => a !== previous.get(a.index))) {
        const saved = ctx.repos.changes.put({ ...change, cutAssessments, assessedForReview, firstDecisionPreview, applyWhenDone });
        ctx.bus.publish({ type: "change.updated", projectId: change.projectId, change: saved });
        if (firstDecisionPreview && firstDecisionPreview.briefToPlayableMs === undefined) recordPlayableDecision(ctx, saved);
      }
      return { total: review.cuts.length, assessed: cutAssessments.filter(a => !a.provisional).length,
        needsDecision: review.cuts.length - cutAssessments.filter(a => a.verdict !== "ask").length,
        ...(heldCalls.length ? { heldCalls, existingCalls: "These cuts already reached the editor as calls. Their original notes and the editor's choices stand." } : {}),
        ...(heldForEditor.length ? { heldForEditor, editorPreference: "These cuts were staged with the editor’s approval required." } : {}),
        ...(heldRevised.length ? { heldRevised, editorRequest: "The editor sent these cuts back, so each revised cut waits in Needs your call. Its revised note is preserved." } : {}) };
    }, "immediate")());
  });

  r.on("PUT", ["/changes/:changeId/cut-choices", "/projects/:projectId/changes/:changeId/cut-choices"], async c => {
    const body = await jsonBody(c, CutChoicesRequest);
    return c.json({ change: ctx.db.transaction(() =>
      saveCutChoices(ctx, c.var.user, requireChange(c.req.param("changeId"), c.req.param("projectId")), body), "immediate")() });
  });

  r.on("POST", ["/changes/:changeId/staged-cuts/:index", "/projects/:projectId/changes/:changeId/staged-cuts/:index"], async c => {
    const body = await jsonBody(c, StagedCutRevision);
    const index = z.coerce.number().int().nonnegative().parse(c.req.param("index"));
    const attempt = requestAttempt(c.req.raw), change = requireChange(c.req.param("changeId"), c.req.param("projectId"));
    body.taskId ??= attempt?.taskId;
    return c.json(reviseStagedCut(ctx, c.var.user, change, index, body, () => requireProjectEditAttempt(ctx, attempt, change.projectId, body.taskId)), 201);
  });

  r.post("/changes/:changeId/approve", async (c) => {
    const body = await jsonBody(c, ApproveRequest);
    if (body.spots?.length) await withSpotCapability(ctx, requireChange(c.req.param("changeId")));
    return c.json(ctx.db.transaction(() => approveChange(ctx, c.var.user, requireChange(c.req.param("changeId")), body), "immediate")());
  });

  r.post("/changes/:changeId/unapprove", (c) => {
    // Moving the head back is a check-then-write against the head another engine may be moving too.
    return c.json(ctx.db.transaction(() => unapproveChange(ctx, c.var.user, requireChange(c.req.param("changeId"))), "immediate")());
  });

  r.post("/changes/:changeId/reject", async (c) => {
    const body = await jsonBody(c, z.object({ reason: z.string().optional() }));
    const change = ctx.db.transaction(() => rejectChange(ctx, c.var.user, requireChange(c.req.param("changeId")), body.reason), "immediate")();
    return c.json({ change });
  });

  r.post("/changes/:changeId/reopen", (c) => {
    const change = ctx.db.transaction(() => reopenChange(ctx, c.var.user, requireChange(c.req.param("changeId"))), "immediate")();
    return c.json({ change });
  });

  r.post("/changes/:changeId/revise", async (c) => {
    const body = await jsonBody(c, ReviseRequest);
    return c.json(ctx.db.transaction(() => reviseChange(ctx, c.var.user, requireChange(c.req.param("changeId")), body), "immediate")());
  });

  return r;
}
