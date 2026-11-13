import { recoverIngestInBackground } from "../services/ingest.js";
import { recoverSourcePreviews } from "../services/sourcePreviews.js";
import { Hono } from "hono";
import { z } from "zod/v3";
import { fromOtio, OtioImportError, otioSourceVersion } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { actorFor, logActivity } from "../services/activity.js";
import { proposeChange } from "../services/changes.js";
import { ensureHead, resolveTimeline } from "../services/timeline.js";
import { purgeDate } from "../services/trash.js";
import { jsonBody, requireProjectHeader, TIMELINE_JSON_BYTES } from "./util.js";

/** The permanent activity log, the project trash, and bringing edits back from DaVinci. */
export function historyRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  const page = (c: { req: { query(k: string): string | undefined } }) => ({
    before: c.req.query("before") ?? null,
    beforeId: c.req.query("beforeId") ?? null,
    limit: Math.min(500, Math.max(1, Math.floor(Number(c.req.query("limit") ?? 200) || 200))),
    type: c.req.query("type") ?? null,
  });

  r.get("/projects/:id/activity", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const q = page(c);
    const where = ["project_id = ?"];
    const params: unknown[] = [project.id];
    if (q.before) {
      where.push(q.beforeId ? "(created_at, id) < (?, ?)" : "created_at < ?");
      params.push(q.before);
      if (q.beforeId) params.push(q.beforeId);
    }
    if (q.type) {
      where.push("type LIKE ?");
      params.push(`${q.type}%`);
    }
    const activity = ctx.repos.activity.select(where.join(" AND "), [...params, q.limit], "created_at DESC, id DESC LIMIT ?");
    return c.json({ activity });
  });

  r.get("/activity", (c) => {
    const q = page(c);
    const activity = ctx.repos.activity
      .select(q.before ? "project_id IS NULL AND created_at < ?" : "project_id IS NULL",
        q.before ? [q.before, q.limit] : [q.limit], "created_at DESC LIMIT ?");
    return c.json({ activity });
  });

  r.get("/trash", (c) => {
    const projects = ctx.repos.projects
      .listDeleted()
      .map((p) => ({ id: p.id, name: p.name, deletedAt: p.deletedAt, purgeAt: purgeDate(p.deletedAt) }));
    return c.json({ projects });
  });

  r.post("/projects/:id/restore", (c) => {
    const id = c.req.param("id");
    if (!ctx.db.prepare("SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NOT NULL").get(id)) throw notFound(`project ${id} in the trash`);
    const user = c.var.user;
    ctx.repos.projects.restore(id);
    recoverIngestInBackground(ctx, id);
    recoverSourcePreviews(ctx, id);
    const project = ctx.repos.projects.get(id)!;
    logActivity(ctx, { projectId: id, actor: actorFor(user), type: "project.restored", summary: `${user.name} restored the project from the trash` });
    return c.json({ project });
  });

  /**
   * A timeline edited by hand in DaVinci Resolve comes back as a change by
   * the person who imported it: reviewed with before/after clips like any
   * other change, and recorded in the history.
   */
  r.post("/projects/:id/import/otio", async (c) => {
    const body = await jsonBody(c, z.object({ otio: z.unknown(), autoApprove: z.boolean().optional() }), TIMELINE_JSON_BYTES);
    const { project, head } = ensureHead(ctx, c.req.param("id"));
    const exported = otioSourceVersion(body.otio);
    const fromVersion = exported && ctx.repos.versions.exists(project.id, exported) ? exported : head;
    const base = resolveTimeline(ctx, project, fromVersion);
    let timeline;
    try {
      timeline = fromOtio(body.otio, project, base);
    } catch (e) {
      if (e instanceof OtioImportError) throw badRequest("otio_import", e.message, { missing: e.missing });
      throw badRequest("otio_import", `Couldn't read that timeline: ${(e as Error).message}`);
    }
    const user = c.var.user;
    const result = proposeChange(ctx, c.var.user, project.id, {
      fromVersion,
      timeline,
      description: "Hand edits from DaVinci Resolve",
      author: actorFor(user),
      autoApprove: body.autoApprove,
    });
    logActivity(ctx, {
      projectId: project.id,
      actor: actorFor(user),
      type: "import.davinci",
      summary: `${user.name} brought back hand edits from DaVinci Resolve${fromVersion !== head ? " (exported from an earlier version)" : ""}`,
      data: { changeId: result.change.id, fromVersion },
    });
    return c.json(result, 201);
  });

  return r;
}
