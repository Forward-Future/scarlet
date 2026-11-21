import { z } from "zod/v3";
import { recordHistoryEdit, rejectEdits } from "../services/cutHistory.js";
import { Hono } from "hono";
import { CaptionExportError, captionExportHttpStatus, captionExportRange, clipById, describeDiff, diffTimelines, newId, timelineDuration, toCaptions, toOtio, type Change } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { requestAttempt, requireProjectEditAttempt } from "../services/taskAttempt.js";
import { now } from "../db.js";
import { conflict, HttpError, notFound } from "../errors.js";
import { ensureProjectHead, resolveTimeline } from "../services/timeline.js";
import { jsonBody, optionalNumberParam, requireProject, requireProjectHeader } from "./util.js";
import { actorFor, logActivity, quote } from "../services/activity.js";
import { applyChoicesWhenDone } from "../services/changes.js";
import { buildHandoff } from "../services/handoff.js";

export function timelineRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  r.get("/projects/:id/timeline", (c) => {
    const id = c.req.param("id");
    const version = c.req.query("version");
    const project = requireProjectHeader(ctx, id);
    if (version && version !== "head") return c.json({ timeline: resolveTimeline(ctx, project, version) });
    const row = project.head ? ctx.repos.versions.get(id, project.head) : null;
    return c.json({ timeline: row?.timeline ?? resolveTimeline(ctx, ensureProjectHead(ctx, id)) });
  });

  r.get("/projects/:id/versions", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json({ versions: ctx.repos.versions.summaries(project.id, project.head) });
  });

  r.get("/projects/:id/branches", c => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const branches = ctx.db.prepare("SELECT name, head FROM cut_branches WHERE project_id = ? ORDER BY name").all(project.id);
    return c.json({ branches });
  });

  r.post("/projects/:id/branches", async c => {
    const body = await jsonBody(c, z.object({ name: z.string().trim().min(1).max(80), from: z.string().optional(),
      expectedHead: z.string(), expectedBranch: z.string() }));
    return c.json(ctx.db.transaction(() => {
      const project = ensureProjectHead(ctx, c.req.param("id"));
      const { head } = project;
      if (head !== body.expectedHead || project.branch !== body.expectedBranch) throw conflict("cut_changed", "The edit changed. Check history and try again.");
      if (body.from) {
        if (!ctx.repos.versions.exists(project.id, body.from)) throw notFound("version");
        if (!ctx.db.prepare("INSERT INTO cut_branches VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(project.id, body.name, body.from).changes)
          throw conflict("branch_exists", "A branch with this name already exists.");
      }
      const ref = ctx.db.prepare("SELECT head FROM cut_branches WHERE project_id = ? AND name = ?").get(project.id, body.name) as { head: string } | undefined;
      if (!ref) throw notFound("branch");
      ctx.db.prepare("UPDATE projects SET branch = ?, head = ?, updated_at = ? WHERE id = ?").run(body.name, ref.head, now(), project.id);
      // A pass that finished on this branch while another was open can now honor its pending approval.
      const waiting = ctx.repos.changes.select(`project_id = ? AND state = 'ready' AND json_extract(json, '$.applyWhenDone') IS NOT NULL
        AND json_extract(json, '$.taskId') IN (SELECT id FROM tasks WHERE project_id = ? AND json_extract(json, '$.context.branch') = ?)`,
        [project.id, project.id, body.name]);
      for (const change of waiting) applyChoicesWhenDone(ctx, change);
      const updated = ctx.repos.projects.get(project.id)!;
      ctx.bus.publish({ type: "project.updated", projectId: project.id, project: updated });
      logActivity(ctx, { projectId: project.id, actor: actorFor(c.var.user), type: "version.branch",
        summary: `${body.from ? "Created" : "Switched to"} branch “${body.name}”`,
        data: { branch: body.name, version: ref.head, fromBranch: project.branch, fromVersion: head, ...(body.from && { createdFrom: body.from }) } });
      return { project: updated };
    }, "immediate")());
  });

  for (const action of ["restore", "revert"] as const) {
    r.post(`/projects/:id/versions/:v/${action}`, async c => {
      const body = await jsonBody(c, z.object({ expectedHead: z.string(), branch: z.string() }));
      return c.json(recordHistoryEdit(ctx, c.var.user, c.req.param("id"), c.req.param("v"), action, body.expectedHead, body.branch));
    });
  }

  r.post("/projects/:id/rejected-edits", async c => {
    const range = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() }).refine(r => r.end >= r.start);
    const body = await jsonBody(c, z.object({ expectedHead: z.string(), branch: z.string(), threadId: z.string(),
      edits: z.array(z.object({ changeId: z.string(), spot: z.number().int().nonnegative(), label: z.string().trim().min(1), range, revised: z.boolean().optional(),
        at: z.number().nonnegative().optional(), before: z.object({ version: z.string(), removed: range.refine(r => r.end > r.start) }).optional() })).min(1).max(32) }));
    return c.json(rejectEdits(ctx, c.var.user, c.req.param("id"), body.threadId, body.edits, body.expectedHead, body.branch));
  });

  r.get("/projects/:id/versions/:a/diff/:b", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const a = resolveTimeline(ctx, project, c.req.param("a"));
    const b = resolveTimeline(ctx, project, c.req.param("b"));
    const diff = diffTimelines(a, b, project.settings.fps);
    return c.json({ diff, description: describeDiff(diff, undefined, c.req.query("clipNames") === "id" ? clipById : undefined) });
  });

  r.post("/projects/:id/versions/:v/checkout", (c) => ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, c.req.param("id"));
    const { head } = project;
    const target = c.req.param("v");
    if (!ctx.repos.versions.exists(project.id, target)) throw notFound(`version ${target}`);
    if (target === head) throw conflict("already_head", "that version is already the head");
    const user = c.var.user;
    const change: Change = {
      id: newId("chg"),
      projectId: project.id,
      fromVersion: head,
      toVersion: target,
      description: `Checked out version ${target}`,
      author: actorFor(user),
      noteIds: [],
      ranges: [],
      state: "approved",
      renders: [],
      createdAt: now(),
      updatedAt: now(),
    };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(project.id, { head: target });
    ctx.bus.publish({ type: "change.updated", projectId: project.id, change });
    ctx.bus.publish({ type: "project.updated", projectId: project.id, project: updated });
    const previous = ctx.repos.versions.get(project.id, head);
    const restored = ctx.repos.versions.get(project.id, target);
    logActivity(ctx, {
      projectId: project.id,
      actor: actorFor(user),
      type: "version.restored",
      summary: `${user.name} restored an earlier version of the edit${restored?.description ? `: ${quote(restored.description)}` : ""}`,
      data: {
        changeId: change.id,
        branch: project.branch,
        version: target,
        from: head,
        ...(previous && { durationBefore: timelineDuration(previous.timeline) }),
        ...(restored && { durationAfter: timelineDuration(restored.timeline) }),
      },
    });
    return c.json({ project: updated });
  }, "immediate")());

  r.get("/projects/:id/versions/:v/export.otio", (c) => {
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), c.req.param("id"));
    const project = requireProject(ctx, c.req.param("id"));
    const timeline = resolveTimeline(ctx, project, c.req.param("v"));
    const otio = toOtio(project, timeline, { mediaRoot: ctx.paths.media(project.id) });
    logActivity(ctx, {
      projectId: project.id,
      actor: actorFor(c.var.user),
      type: "export.completed",
      summary: `${c.var.user.name} exported timeline (.otio)`,
      data: { format: "otio", version: timeline.version, duration: timelineDuration(timeline) },
    });
    const safeName = project.name.replace(/[^a-zA-Z0-9-_]+/g, "_");
    return new Response(JSON.stringify(otio, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${safeName}-${timeline.version}.otio"`,
      },
    });
  });

  for (const format of ["srt", "vtt"] as const) {
    r.get(`/projects/:id/versions/:v/export.${format}`, (c) => {
      requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), c.req.param("id"));
      const project = requireProject(ctx, c.req.param("id"));
      const timeline = resolveTimeline(ctx, project, c.req.param("v"));
      const start = optionalNumberParam(c.req.query("start"), "start");
      const end = optionalNumberParam(c.req.query("end"), "end");
      // captionExportRange checks the range, so the engine and the demo refuse the same intervals the same way.
      const trackId = c.req.query("trackId") || undefined;
      let range: ReturnType<typeof captionExportRange>;
      let body: string;
      try {
        range = captionExportRange(start, end);
        body = toCaptions(timeline, format, { trackId, range });
      } catch (err) {
        if (!(err instanceof CaptionExportError)) throw err;
        throw new HttpError(captionExportHttpStatus(err.code), err.code, err.message);
      }
      logActivity(ctx, {
        projectId: project.id,
        actor: actorFor(c.var.user),
        type: "export.completed",
        summary: `${c.var.user.name} exported captions (.${format})`,
        data: { format, version: timeline.version, duration: timelineDuration(timeline), ...(range && { range }), ...(trackId && { trackId }) },
      });
      const safeName = project.name.replace(/[^a-zA-Z0-9-_]+/g, "_");
      const type = format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8";
      return new Response(body, {
        headers: {
          "Content-Type": type,
          "Content-Disposition": `attachment; filename="${safeName}-${timeline.version}.${format}"`,
        },
      });
    });
  }
  r.post("/projects/:id/versions/:v/handoff", async (c) => {
    requireProjectEditAttempt(ctx, requestAttempt(c.req.raw), c.req.param("id"));
    const body = await jsonBody(c, z.object({ folder: z.string().min(1).max(4096) }));
    const project = requireProject(ctx, c.req.param("id"));
    const timeline = resolveTimeline(ctx, project, c.req.param("v"));
    const result = await buildHandoff(ctx, project, timeline, body.folder, c.req.raw.signal);
    logActivity(ctx, {
      projectId: project.id,
      actor: actorFor(c.var.user),
      type: "export.completed",
      summary: `${c.var.user.name} exported a handoff folder`,
      data: { format: "folder", version: timeline.version, duration: timelineDuration(timeline) },
    });
    return c.json(result);
  });

  return r;
}
