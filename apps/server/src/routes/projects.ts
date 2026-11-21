import { conflict, notFound } from "../errors.js";
import { nameCutRowsByWords } from "../services/cutRowWords.js";
import { cancelTask } from "../services/tasks.js";
import { holdTranscriptions, resumeImportsInBackground } from "../services/ingest.js";
import { recoverSourcePreviews } from "../services/sourcePreviews.js";
import { withActivity } from "../services/projectActivity.js";
import { holdProjectEditing, resumeProjectEditing, resumeProjectTranscriptions } from "../services/taskRecovery.js";
import { Hono } from "hono";
import { z } from "zod/v3";
import { EditReviewRequest, threadTimeline, type ThreadEdit, threadRevision, ThreadDisposition, CreateProjectRequest, UpdateProjectRequest, type ProjectDetail } from "@scarlet/shared";
import { createProject, hasInitialTimeline } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { resolveTimeline } from "../services/timeline.js";
import { jsonBody, requireProject, requireProjectHeader } from "./util.js";
import { actorFor, logActivity, quote } from "../services/activity.js";

export function projectRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  r.post("/projects/:id/edit-reviews", async c => {
    const review = await jsonBody(c, EditReviewRequest, 1024);
    const projectId = c.req.param("id");
    if (ctx.telemetry.active) {
      const change = ctx.db.prepare("SELECT 1 FROM changes WHERE project_id = ? AND id = ?").get(projectId, review.changeId);
      if (!change) throw notFound("reviewed edit");
      ctx.telemetry.recordEditReview(projectId, review);
    }
    return c.body(null, 204);
  });

  r.get("/projects", async (c) => c.json({ projects: await withActivity(ctx, ctx.repos.projects.summaries()) }));

  r.post("/projects", async (c) => {
    const body = await jsonBody(c, CreateProjectRequest);
    const project = ctx.repos.projects.insert(createProject(body.name, body.settings ?? {}), !!body.settings && Object.keys(body.settings).length > 0);
    ctx.paths.ensureProject(project.id);
    ctx.bus.publish({ type: "project.updated", projectId: project.id, project });
    return c.json({ project }, 201);
  });

  r.post("/projects/:id/stop-editing", c => c.json(holdProjectEditing(ctx, c.req.param("id"))));

  r.post("/projects/:id/resume-editing", c => c.json(resumeProjectEditing(ctx, c.req.param("id"))));

  r.get("/projects/:id", (c) => {
    const id = c.req.param("id");
    const view = c.req.query("view");
    if (view === "header") {
      const { head, settings } = requireProjectHeader(ctx, id);
      return c.json({ project: { id, head, settings } });
    }
    if (view === "project") return c.json({ project: requireProject(ctx, id) });
    if (view === "workspace") {
      const snapshot = ctx.db.transaction(() => {
        const header = requireProjectHeader(ctx, id);
        const project = { ...header, media: ctx.repos.projects.listMedia(id) };
        return { project, timeline: project.head ? resolveTimeline(ctx, project, "head") : null };
      })();
      return c.json(snapshot);
    }
    const project = requireProject(ctx, id);
    const detail: ProjectDetail = {
      project,
      summary: ctx.repos.projects.summaries(project.id)[0]!,
      timeline: project.head ? resolveTimeline(ctx, project, "head") : null,
    };
    return c.json(detail);
  });

  function projectThread(projectId: string, id: string) {
    const thread = ctx.repos.projects.threads(projectId).find(t => t.id === id);
    if (!thread) throw notFound("thread");
    return thread;
  }

  /** Read the project's history once for every requested thread, then project each list on its own turn so
   * playback and frame requests run between long histories. A list that fails to project fails alone. */
  async function editLists(projectId: string, ids: string[]) {
    const { project, threads, head, links, media } = ctx.db.transaction(() => {
      const project = requireProjectHeader(ctx, projectId);
      const wanted = new Set(ids);
      const threads = ctx.repos.projects.threads(projectId).filter(thread => wanted.has(thread.id));
      const head = project.head ? ctx.repos.versions.get(projectId, project.head)?.timeline : undefined;
      return { project, threads, head, links: head ? ctx.repos.versions.links(projectId) : [], media: head ? ctx.repos.projects.listMedia(projectId) : [] };
    })();
    // Saved versions are never rewritten or removed, so reading them after the snapshot sees the same history.
    const read = (version: string) => ctx.repos.versions.get(projectId, version)?.timeline;
    const lists: [string, ThreadEdit[]][] = [];
    const failed: [string, Error][] = [];
    for (const [i, thread] of threads.entries()) {
      if (i) await new Promise(resolve => setImmediate(resolve));
      try {
        lists.push([thread.id, head ? nameCutRowsByWords(ctx, projectId, threadTimeline(thread, head, links, read, project.settings.fps, media), read) : []]);
      } catch (error) {
        failed.push([thread.id, error instanceof Error ? error : new Error(String(error))]);
      }
    }
    return { version: project.head, lists: Object.fromEntries(lists), failed: new Map(failed) };
  }

  r.get("/projects/:id/threads/:threadId/edits", async c => {
    const id = c.req.param("threadId");
    const { version, lists, failed } = await editLists(c.req.param("id"), [id]);
    const error = failed.get(id);
    if (error) throw error;
    if (!Object.hasOwn(lists, id)) throw notFound("thread");
    return c.json({ version, edits: lists[id] });
  });

  r.post("/projects/:id/thread-edits", async c => {
    const { threads } = await jsonBody(c, z.object({ threads: z.array(z.string()).min(1).max(64) }));
    const { version, lists, failed } = await editLists(c.req.param("id"), threads);
    for (const [id, error] of failed) ctx.log(`[error] edit list for thread ${id}: ${error.stack ?? error.message}`);
    return c.json({ version, lists, ...(failed.size > 0 && { failed: Object.fromEntries([...failed].map(([id, error]) => [id, error.message || "internal error"])) }) });
  });

  r.post("/projects/:id/threads/:threadId/disposition", async c => {
    const { done, revision } = await jsonBody(c, ThreadDisposition);
    const result = ctx.db.transaction(() => {
      const project = requireProjectHeader(ctx, c.req.param("id"));
      const thread = projectThread(project.id, c.req.param("threadId"));
      if (threadRevision(thread) !== revision || (done && (thread.active || thread.question || thread.status === "working")))
        throw conflict("thread_changed", "This thread is still changing. Try again when its agent finishes.");
      const completed = { ...project.completedThreads };
      if (done) completed[thread.id] = revision;
      else delete completed[thread.id];
      ctx.repos.projects.saveCompletedThreads(project.id, completed);
      const saved = requireProject(ctx, project.id);
      ctx.bus.publish({ type: "project.updated", projectId: project.id, project: saved });
      return { completedThreads: completed, project: saved };
    }, "immediate")();
    return c.json(result);
  });

  r.patch("/projects/:id", async (c) => {
    const { expectedFormat, ...body } = await jsonBody(c, UpdateProjectRequest);
    const project = ctx.db.transaction(() => {
      const previous = requireProjectHeader(ctx, c.req.param("id"));
      if (expectedFormat) {
        const sameHead = previous.head === expectedFormat.head || (expectedFormat.head === null && hasInitialTimeline(previous));
        if (ctx.repos.projects.formatSet(previous.id, true) || !sameHead || JSON.stringify(previous.settings) !== JSON.stringify(expectedFormat.settings))
          return requireProject(ctx, previous.id);
      }
      const updated = ctx.repos.projects.update(previous.id, body);
      ctx.bus.publish({ type: "project.updated", projectId: updated.id, project: updated });
      if (body.mediaPaused !== undefined && body.mediaPaused !== previous.mediaPaused) ctx.db.afterCommit(() => {
        if (body.mediaPaused) {
          ctx.stopMedia(updated.id);
          ctx.renders.stopProject(updated.id, true);
          holdTranscriptions(ctx, updated.id);
        } else {
          recoverSourcePreviews(ctx, updated.id);
          resumeProjectTranscriptions(ctx, updated.id);
        }
      });
      // Unpaused or unarchived: its imports go on. Ones still held by a pause stay held.
      if ((previous.mediaPaused && !updated.mediaPaused) || (previous.archived && !updated.archived)) {
        ctx.db.afterCommit(() => resumeImportsInBackground(ctx, updated.id));
      }
      const what = [
        body.name && body.name !== previous.name ? `renamed it to ${quote(body.name)}` : null,
        body.settings ? "changed the video settings" : null,
        body.archived === undefined ? null : body.archived ? "archived the project" : "unarchived the project",
      ].filter(Boolean);
      if (what.length) logActivity(ctx, { projectId: previous.id, actor: actorFor(c.var.user), type: "project.updated", summary: `${c.var.user.name} ${what.join(", ")}`, data: body });
      return updated;
    }, "immediate")();
    return c.json({ project });
  });

  // Deleting moves the project to the trash; it is purged for good after 30 days.
  r.delete("/projects/:id", (c) => {
    // Trashing, its cancellations and its activity entries commit together.
    ctx.db.transaction(() => {
      const project = requireProjectHeader(ctx, c.req.param("id"));
      ctx.repos.projects.softDelete(project.id);
      // Abort listeners run synchronously and may write; let them see the committed trash.
      ctx.db.afterCommit(() => {
        ctx.stopMedia(project.id, true);
        ctx.renders.stopProject(project.id);
      });
      // The project's own requests that haven't started wait for Restore. A skill's edit only borrows the project to run
      // in, and no host takes a request in the trash: left waiting there, it would hold its skill until the project came back.
      // A transcription isn't cancelled: that would be final, keeping rough word times or no transcript at all. The
      // project's signal stops it as interrupted instead, and it starts again from its saved chunks after Restore.
      for (const task of ctx.repos.tasks.select(`project_id = ? AND ((state IN ('claimed','running') AND kind <> 'transcribe')
          OR (kind = 'skill_edit' AND state IN ('queued','waiting_for_user')))`, [project.id])) {
        cancelTask(ctx, task);
      }
      logActivity(ctx, { projectId: project.id, actor: actorFor(c.var.user), type: "project.deleted", summary: `${c.var.user.name} moved the project to the trash` });
      logActivity(ctx, { projectId: null, actor: actorFor(c.var.user), type: "project.deleted", summary: `${c.var.user.name} moved ${quote(project.name)} to the trash`, data: { projectId: project.id } });
    }, "immediate")();
    return c.json({});
  });

  return r;
}
