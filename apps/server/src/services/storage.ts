import { lstatSync, readdirSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StorageProject, StorageSelection } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { conflict } from "../errors.js";

export function checkedProjectDir(ctx: Ctx, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw conflict("storage_path", "Invalid project directory.");
  const parent = join(ctx.paths.root, "projects");
  const folder = ctx.paths.project(id);
  for (const dir of [parent, folder]) {
    const info = lstatSync(dir, { throwIfNoEntry: false });
    if (info && !info.isDirectory()) throw conflict("storage_path", "Project storage has moved. Cleanup stopped.");
  }
  return folder;
}

function cacheDir(ctx: Ctx, id: string): string | undefined {
  const dir = join(checkedProjectDir(ctx, id), "segments");
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
}

export function projectBusy(ctx: Ctx, id: string, expired = false): boolean {
  // Other engine instances also publish their jobs to this database.
  // Trashed projects cannot claim queued work. Preserve it for Restore, but
  // only an actual worker needs to delay permanently removing the project.
  return !!((!expired && ctx.pending.size) || ctx.db.prepare(`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM renders WHERE project_id=? AND state IN ('queued','running')) OR
    EXISTS (SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.project_id=?
      AND (t.state IN ('claimed','running') OR (p.deleted_at IS NULL AND t.state IN ('queued','waiting_for_user')))) OR
    EXISTS (SELECT 1 FROM media m JOIN projects p ON p.id=m.project_id
      WHERE m.project_id=? AND m.status NOT IN ('ready','failed')
      AND (m.ingest_pid IS NOT NULL OR (p.deleted_at IS NULL AND p.media_paused=0)))`).get(id, id, id));
}

function missingSource(ctx: Ctx, id: string): boolean {
  const media = ctx.db.prepare("SELECT json_extract(json,'$.path') AS path FROM media WHERE project_id=?").all(id) as { path: string }[];
  const dir = ctx.paths.media(id);
  if (media.length && !lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return true;
  return media.some(asset => {
    if (!asset.path || basename(asset.path) !== asset.path) return true;
    const file = lstatSync(join(dir, asset.path), { throwIfNoEntry: false });
    return !file?.isFile() || file.size === 0;
  });
}

const segmentName = /^(?:[a-f0-9]{64}\.mp4|(?:mix|program)-[a-f0-9]{64}\.m4a)$/;

export async function storageProjects(ctx: Ctx): Promise<StorageProject[]> {
  const rows = ctx.db.prepare("SELECT id,name,deleted_at AS deletedAt FROM projects ORDER BY name COLLATE NOCASE,id").all() as (StorageSelection & { name: string })[];
  const result: StorageProject[] = [];
  for (const row of rows) {
    const dir = !row.deletedAt && cacheDir(ctx, row.id);
    const files = dir ? await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    }) : [];
    const segments = files.filter(f => f.isFile() && segmentName.test(f.name)).map(f => f.name);
    result.push({ ...row, segments, busy: projectBusy(ctx, row.id), missingSource: segments.length > 0 && missingSource(ctx, row.id) });
  }
  return result;
}

export function validateSelection(ctx: Ctx, selected: StorageSelection, expired = false) {
  const current = ctx.db.prepare("SELECT deleted_at FROM projects WHERE id=?").get(selected.id) as { deleted_at: string | null } | undefined;
  if (!current || current.deleted_at !== selected.deletedAt) throw conflict("storage_changed", "The project changed. Rescan storage.");
  if (projectBusy(ctx, selected.id, expired)) throw conflict("storage_busy", "Scarlet is working. Try again after the current jobs finish.");
  checkedProjectDir(ctx, selected.id);
  if (!selected.deletedAt && missingSource(ctx, selected.id)) {
    throw conflict("storage_source_missing", "Reconnect missing project media before clearing its cache.");
  }
}

/** The cached renders `clearSegments` would delete. Read while the selection is checked, so both see the same state. */
export function segmentFiles(ctx: Ctx, id: string): string[] {
  const dir = cacheDir(ctx, id);
  if (!dir) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(file => file.isFile() && segmentName.test(file.name)).map(file => join(dir, file.name));
}

/**
 * Delete a project's cached renders, listed by `segmentFiles`, outside any transaction and without blocking the engine.
 * A file that can't be deleted, such as one in use on Windows, stays for the next clear and stops no other.
 */
export async function clearSegments(ctx: Ctx, id: string, files = segmentFiles(ctx, id)): Promise<void> {
  const failed: string[] = [];
  await Promise.all(files.map(file => unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") failed.push(`${basename(file)}: ${error.message}`);
  })));
  if (failed.length) ctx.log(`[storage] couldn't clear ${failed.length} cached ${failed.length === 1 ? "render" : "renders"} of ${id}: ${failed[0]}`);
}
