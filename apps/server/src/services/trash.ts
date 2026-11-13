import { rmSync } from "node:fs";
import type { StorageSelection } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { checkedProjectDir, projectBusy, validateSelection } from "./storage.js";

export const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** When a project moved to the Trash at `deletedAt` is removed for good. */
export const purgeDate = (deletedAt: string) => new Date(Date.parse(deletedAt) + TRASH_DAYS * DAY).toISOString();

/** Keep a durable removal intent so an interruption can never erase a restorable project. */
export function removeTrashed(ctx: Ctx, selected: StorageSelection[], expired = false) {
  ctx.db.transaction(() => {
    for (const project of selected) {
      if (!project.deletedAt) throw new Error("Expected a trashed project");
      validateSelection(ctx, project, expired);
      const id = project.id;
      ctx.db.prepare("INSERT INTO storage_purges VALUES (?)").run(id);
      ctx.db.prepare("DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)").run(id);
      ctx.db.prepare("DELETE FROM notifications WHERE json_extract(json, '$.projectId') = ?").run(id);
      for (const table of ["changes", "notes", "renders", "tasks", "task_usage", "transcripts", "timeline_versions", "activity"]) {
        ctx.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
      }
      ctx.repos.projects.remove(id);
    }
  }, "immediate")();
  if (selected.length) {
    ctx.log(`[trash] removed ${selected.length} ${selected.length === 1 ? "project" : "projects"} for good${expired ? ` after ${TRASH_DAYS} days in the trash` : ""}: ${selected.map(p => p.id).join(", ")}`);
  }
  finishPurges(ctx);
}

function finishPurges(ctx: Ctx) {
  const pending = ctx.db.prepare("SELECT project_id FROM storage_purges").all() as {project_id: string}[];
  for (const {project_id: id} of pending) {
    ctx.db.transaction(() => {
      if (!ctx.db.prepare("SELECT 1 FROM projects WHERE id=?").get(id)) {
        rmSync(checkedProjectDir(ctx,id), { recursive: true, force: true });
      }
      ctx.db.prepare("DELETE FROM storage_purges WHERE project_id=?").run(id);
    }, "immediate")();
  }
}

export function purgeTrash(ctx: Ctx, nowMs = Date.now()): number {
  const cutoff = new Date(nowMs - TRASH_DAYS * DAY).toISOString();
  const expired = ctx.repos.projects.listDeleted().filter(p => p.deletedAt < cutoff && !projectBusy(ctx, p.id, true));
  removeTrashed(ctx, expired, true);
  return expired.length;
}

export function scheduleTrashPurge(ctx: Ctx): () => void {
  ctx.db.exec("DELETE FROM task_events WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_events.task_id)");
  const run = () => {
    try { purgeTrash(ctx); } catch (error) { ctx.log(`[trash] cleanup will retry: ${error}`); }
  };
  run();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
