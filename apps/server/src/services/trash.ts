import { rm } from "node:fs/promises";
import type { StorageSelection } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { checkedProjectDir, projectBusy, validateSelection } from "./storage.js";

export const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

/** When a project moved to the Trash at `deletedAt` is removed for good. */
export const purgeDate = (deletedAt: string) => new Date(Date.parse(deletedAt) + TRASH_DAYS * DAY).toISOString();

/**
 * Keep a durable removal intent so an interruption can never erase a restorable project. The projects' rows go at once;
 * the returned promise settles once their folders have been deleted, or have failed to and wait for the next try.
 */
export function removeTrashed(ctx: Ctx, selected: StorageSelection[], expired = false): Promise<void> {
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
  return finishPurges(ctx);
}

/** Folders being deleted now, so two sweeps never delete the same one at once. */
const deleting = new Map<string, Promise<void>>();

/**
 * Delete the folders of projects removed for good. Which ones is decided in the database; the deleting happens outside
 * any transaction and without blocking the engine. Each folder goes on its own: one that can't be deleted yet, such as
 * a file in use on Windows, keeps its purge row for the next try and holds up no other.
 */
function finishPurges(ctx: Ctx): Promise<void> {
  const pending = ctx.db.prepare("SELECT project_id FROM storage_purges").all() as {project_id: string}[];
  return ctx.track(Promise.all(pending.map(({ project_id: id }) => {
    let folder: string;
    try {
      // A project still in the library keeps its folder; only the purge row was left.
      if (ctx.db.prepare("SELECT 1 FROM projects WHERE id=?").get(id)) {
        ctx.db.prepare("DELETE FROM storage_purges WHERE project_id=?").run(id);
        return;
      }
      folder = checkedProjectDir(ctx, id);
    } catch (error) {
      ctx.log(`[trash] couldn't remove the folder of ${id} yet and will try again: ${(error as Error).message}`);
      return;
    }
    const running = deleting.get(folder);
    if (running) return running;
    const job = (async () => {
      try {
        await rm(folder, { recursive: true, force: true });
        ctx.db.prepare("DELETE FROM storage_purges WHERE project_id=?").run(id);
      } catch (error) {
        ctx.log(`[trash] couldn't remove the folder of ${id} yet and will try again: ${(error as Error).message}`);
      } finally {
        deleting.delete(folder);
      }
    })();
    deleting.set(folder, job);
    return job;
  })).then(() => {}));
}

/** How many projects were removed for good. Their folders are deleted in the background (`ctx.pending`). */
export function purgeTrash(ctx: Ctx, nowMs = Date.now()): number {
  const cutoff = new Date(nowMs - TRASH_DAYS * DAY).toISOString();
  const expired = ctx.repos.projects.listDeleted().filter(p => p.deletedAt < cutoff && !projectBusy(ctx, p.id, true));
  void removeTrashed(ctx, expired, true);
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
