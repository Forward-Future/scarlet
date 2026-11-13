import { Hono } from "hono";
import { z } from "zod/v3";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { clearSegments, storageProjects, validateSelection } from "../services/storage.js";
import { purgeDate, removeTrashed } from "../services/trash.js";
import { jsonBody } from "./util.js";

export function storageRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  // A trashed project's row says when it goes for good, so Settings words it as the Trash does.
  r.get("/storage", async c => c.json({
    projects: (await storageProjects(ctx)).map(p => p.deletedAt ? { ...p, purgeAt: purgeDate(p.deletedAt) } : p),
  }));
  r.post("/storage/cleanup", async c => {
    const {kind, projects} = await jsonBody(c, z.object({
      kind: z.enum(["cache","trash"]),
      projects: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), deletedAt: z.string().datetime().nullable() })).min(1),
    }));
    if (new Set(projects.map(p => p.id)).size !== projects.length ||
        projects.some(p => (kind === "trash") !== (p.deletedAt !== null))) {
      throw badRequest("storage_selection", "Invalid storage selection.");
    }
    if (kind === "trash") removeTrashed(ctx, projects);
    else {
      ctx.db.transaction(() => {
        for (const p of projects) validateSelection(ctx, p);
        for (const p of projects) clearSegments(ctx, p.id);
      }, "immediate")();
      ctx.log(`[storage] cleared the cached renders of ${projects.length} ${projects.length === 1 ? "project" : "projects"}: ${projects.map(p => p.id).join(", ")}`);
    }
    return c.json({ projects: projects.length });
  });
  return r;
}
