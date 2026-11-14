import { conflict, notFound } from "../errors.js";
import { cancelTask } from "../services/tasks.js";
import { holdTranscriptions, recoverIngestInBackground } from "../services/ingest.js";
import { recoverSourcePreviews } from "../services/sourcePreviews.js";
import { withActivity } from "../services/projectActivity.js";
import { recoverTasks } from "../services/taskRecovery.js";
import { Hono } from "hono";
import { buildThreads, EditReviewRequest, threadTimeline, threadRevision, ThreadDisposition, CreateProjectRequest, UpdateProjectRequest, type ProjectDetail } from "@scarlet/shared";
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

  r.get("/projects/:id", (c) => {
    const id = c.req.param("id");
    if (c.req.query("view") === "workspace") {
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
    const thread = buildThreads({
      changes: ctx.repos.changes.select("project_id = ?", [projectId]),
      tasks: ctx.repos.tasks.select("project_id = ? AND kind != 'transcribe'", [projectId]),
      notes: ctx.repos.notes.select("project_id = ? AND json_extract(json, '$.changeId') IS NOT NULL", [projectId]),
    }).find(t => t.id === id);
    if (!thread) throw notFound("thread");
    return thread;
  }

  r.get("/projects/:id/threads/:threadId/edits", c => {
    const result = ctx.db.transaction(() => {
      const project = requireProjectHeader(ctx, c.req.param("id"));
      const thread = projectThread(project.id, c.req.param("threadId"));
      const read = (version: string) => ctx.repos.versions.get(project.id, version)?.timeline;
      const head = project.head && read(project.head);
      return { version: project.head, edits: head
        ? threadTimeline(thread, head, ctx.repos.versions.links(project.id), read, project.settings.fps) : [] };
    })();
    return c.json(result);
  });

  r.post("/projects/:id/threads/:threadId/disposition", async c => {
    const { done, revision } = await jsonBody(c, ThreadDisposition);
    const completedThreads = ctx.db.transaction(() => {
      const project = requireProjectHeader(ctx, c.req.param("id"));
      const thread = projectThread(project.id, c.req.param("threadId"));
      if (threadRevision(thread) !== revision || (done && (thread.active || thread.question || thread.status === "working")))
        throw conflict("thread_changed", "This thread is still changing. Try again when its agent finishes.");
      const completed = { ...project.completedThreads };
      if (done) completed[thread.id] = revision;
      else delete completed[thread.id];
      ctx.repos.projects.saveCompletedThreads(project.id, completed);
      ctx.bus.publish({ type: "project.updated", projectId: project.id, project: requireProject(ctx, project.id) });
      return completed;
    }, "immediate")();
    return c.json({ completedThreads });
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
          recoverIngestInBackground(ctx, updated.id);
          recoverSourcePreviews(ctx, updated.id);
          // The pause cut this project's transcriptions off. They start again now, not at the next 30 s sweep.
          recoverTasks(ctx);
        }
      });
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
