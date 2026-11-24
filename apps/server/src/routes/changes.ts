import { appliedReviewChange, CutAssessment, type Change } from "@scarlet/timeline";
import { Hono } from "hono";
import { z } from "zod/v3";
import { namedTimelineEdits, ApproveRequest, FlagEditRequest, KeepEditsRequest, UnkeepEditsRequest, CutChoicesRequest, ChangeState, DialogueCutsRequest, ProposeChangeRequest, ReviseRequest, StagedCutRevision } from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { approveChange, changeDiff, flagEdit, keepEdits, keptEdits, unkeepEdits, saveCutAssessments, saveCutChoices, prepareCutReview, proposeChange, scheduleSpotCheck, submitDialogueCuts, rejectChange, reopenChange, reviseChange, reviseStagedCut, unapproveChange, withSpotCapability } from "../services/changes.js";
import { jsonBody, requireProjectHeader, requireScoped, TIMELINE_JSON_BYTES } from "./util.js";
import { requestAttempt, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { startDecisionCheck } from "../services/learnings.js";

export function changeRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  const requireChange = (changeId: string, projectId?: string) => requireScoped(ctx.repos.changes, "change", changeId, projectId);

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
      const { id, state, description, reason, fromVersion, toVersion, ranges, timelineEdits } = viewed;
      return c.json({ change: { id, state, description, reason, fromVersion, toVersion, ranges, timelineEdits }, duration: result.duration, diffDescription: result.diffDescription,
        ...(result.onWholeFrames && { onWholeFrames: result.onWholeFrames }), ...(result.notApplied && { notApplied: result.notApplied }) }, 201);
    }
    // The proposal is saved by now, so a failed check must not read as a failed proposal.
    return c.json({ ...result, change: await withSpots(result.change, result.change.state === "ready") }, 201);
  });

  // A run flags an applied edit it doubts, its own or another request's, for the editor to look at.
  r.post("/projects/:id/edit-flags", async c => {
    const body = await jsonBody(c, FlagEditRequest);
    const attempt = requestAttempt(c.req.raw), projectId = c.req.param("id");
    return c.json(ctx.db.transaction(() => {
      const task = requireProjectEditAttempt(ctx, attempt, projectId, body.taskId ?? attempt?.taskId);
      if (!task) throw badRequest("no_task", "Only a request's run flags an edit for the editor.");
      return flagEdit(ctx, projectId, task, body);
    }, "immediate")(), 201);
  });

  // The editor kept edits. The runs of their request hear of it, so a doubt they settled isn't raised again.
  r.post("/projects/:id/kept-edits", async c => {
    const body = await jsonBody(c, KeepEditsRequest);
    const project = requireProjectHeader(ctx, c.req.param("id"));
    ctx.db.transaction(() => {
      // The last Keep of what the request left the editor has its decisions read for a rule.
      if (keepEdits(ctx, project.id, body).added) startDecisionCheck(ctx, project.id, body.threadId);
    }, "immediate")();
    return c.body(null, 204);
  });

  // The editor took a Keep back with ⌘Z: the edits wait on them again, and the runs of their request hear so.
  r.post("/projects/:id/kept-edits/undo", async c => {
    const body = await jsonBody(c, UnkeepEditsRequest);
    const project = requireProjectHeader(ctx, c.req.param("id"));
    ctx.db.transaction(() => unkeepEdits(ctx, project.id, body), "immediate")();
    return c.body(null, 204);
  });

  r.get("/projects/:id/kept-edits", c => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const thread = c.req.query("thread");
    if (!thread) throw badRequest("no_thread", "Name the request with ?thread=.");
    return c.json({ kept: keptEdits(ctx, project.id, thread) });
  });

  r.post("/projects/:id/dialogue-cuts", async c => {
    const body = await jsonBody(c, DialogueCutsRequest);
    const attempt = requestAttempt(c.req.raw), projectId = c.req.param("id");
    body.taskId ??= attempt?.taskId;
    const { changes, carriedForward, editorDecided, heldForReview, alreadyRemoved, joinCrossfades, stagedForEditor, onFrames, droppedFromReview, heldCutsStay, settledApplied } = submitDialogueCuts(ctx, c.var.user, projectId, body,
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
      // Cuts left out because they would have swapped a held staged cut for other edges Scarlet couldn't place either.
      ...(heldCutsStay && { heldCutsStay }),
      // Staged cuts Scarlet checked and settled as cuts, never asked about, that went into the video with this save.
      ...(settledApplied && { settledApplied }),
      // The version to build on next: where the confident cuts left the edit.
      head: ctx.repos.projects.header(c.req.param("id"))?.head }, 201);
  });

  r.get("/projects/:id/changes", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const state = c.req.query("state");
    const changes = ctx.repos.changes.select("project_id = ?" + (state ? " AND state = ?" : ""),
      state ? [project.id, ChangeState.parse(state)] : [project.id], "created_at DESC");
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
      assessments: z.array(CutAssessment.omit({ provisional: true, askOrder: true, revised: true }).extend({ amend: z.boolean().optional() })).min(1).max(500) }));
    return c.json(ctx.db.transaction(() => {
      const change = requireChange(c.req.param("changeId"), c.req.param("projectId"));
      const task = requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), change.projectId);
      return saveCutAssessments(ctx, change, task, body);
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
