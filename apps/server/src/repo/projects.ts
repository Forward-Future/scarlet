import { MediaAsset, Project, ProjectSettings, Timeline, timelineDuration, type Change, type Note } from "@scarlet/timeline";
import { countReviewDecisions, type ProjectSummary, type Task } from "@scarlet/shared";
import { now, type Db } from "../db.js";
import type { JsonStore } from "./store.js";

export type MediaStatus = "ingesting" | "ready" | "failed";

/** MediaAsset plus server-side ingest status (returned by the media routes). */
export type MediaWithStatus = MediaAsset & { status: MediaStatus; error?: string };

interface ProjectRow {
  completed_threads: string;
  media_paused: number;
  archived: number;
  branch: string;
  id: string;
  name: string;
  settings: string;
  head: string | null;
  created_at: string;
  updated_at: string;
}

interface MediaRow {
  id: string;
  project_id: string;
  status: MediaStatus;
  error: string | null;
  json: string;
  created_at: string;
}

export class ProjectsRepo {
  private readonly reviewCounts = new Map<string, { revision: number; count: number }>();
  constructor(private readonly db: Db, private readonly review: { changes: JsonStore<Change>; tasks: JsonStore<Task>; notes: JsonStore<Note> }) {}

  private reviewCount(projectId: string, revision: number, completed: string): number {
    const cached = this.reviewCounts.get(projectId);
    if (cached?.revision === revision) return cached.count;
    const count = countReviewDecisions({
      changes: this.review.changes.select("project_id = ?", [projectId], "created_at DESC"),
      tasks: this.review.tasks.select("project_id = ? AND kind != 'transcribe'", [projectId], "created_at DESC"),
      notes: this.review.notes.select("project_id = ? AND json_extract(json, '$.changeId') IS NOT NULL", [projectId]),
    }, JSON.parse(completed));
    this.db.afterCommit(() => this.reviewCounts.set(projectId, { revision, count }));
    return count;
  }

  /** A head saved before versions kept their length has none stored: it is worked out from its timeline, once, and kept. */
  private headDuration(projectId: string, head: string): number | undefined {
    const version = this.db.prepare("SELECT json FROM timeline_versions WHERE project_id = ? AND version = ?").get(projectId, head) as { json: string } | undefined;
    if (!version) return undefined;
    const duration = timelineDuration(Timeline.parse(JSON.parse(version.json)));
    this.db.prepare("UPDATE timeline_versions SET duration = ? WHERE project_id = ? AND version = ?").run(duration, projectId, head);
    return duration;
  }

  private rowToProject(row: ProjectRow): Project {
    return {
      ...projectHeader(row),
      media: this.listMedia(row.id).map(({ status: _s, error: _e, ...asset }) => asset),
    };
  }

  header(id: string) {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL").get(id) as ProjectRow | undefined;
    return row ? projectHeader(row) : null;
  }

  get(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL").get(id) as ProjectRow | undefined;
    return row ? this.rowToProject(row) : null;
  }

  /** Move to the trash (kept TRASH_DAYS, then purged). */
  softDelete(id: string) {
    this.reviewCounts.delete(id);
    this.db.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").run(now(), id);
  }

  /** Back from the trash as it went in: restoring is not an edit, so "Last edited" stays where it was. */
  restore(id: string) {
    this.db.prepare("UPDATE projects SET deleted_at = NULL, archived = 0 WHERE id = ?").run(id);
  }

  listDeleted(): Array<{ id: string; name: string; deletedAt: string }> {
    return (this.db.prepare("SELECT id, name, deleted_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all() as Array<{ id: string; name: string; deleted_at: string }>).map((r) => ({
      id: r.id,
      name: r.name,
      deletedAt: r.deleted_at,
    }));
  }

  insert(project: Project, formatSet = false): Project {
    const p = Project.parse(project);
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, settings, head, archived, created_at, updated_at, format_set)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, JSON.stringify(p.settings), p.head, Number(p.archived ?? false), p.createdAt ?? ts, p.updatedAt ?? ts, Number(formatSet));
    return this.get(p.id)!;
  }

  /** Older engines leave this unset. Their saved settings and footage establish whether a fresh import can match. */
  formatSet(id: string, resumingMatch = false): boolean {
    const row = this.db.prepare("SELECT format_set FROM projects WHERE id = ?").get(id) as { format_set: number | null };
    if (row.format_set !== null) return !!row.format_set;
    const chosen = this.db.prepare(`SELECT 1 FROM activity WHERE project_id = ? AND type = 'project.updated'
      AND json_type(json, '$.data.settings') = 'object' LIMIT 1`).get(id);
    if (chosen || resumingMatch) return !!chosen;
    return !!this.db.prepare(`SELECT 1 FROM media WHERE project_id = ? AND json_extract(json, '$.kind') = 'video'
      AND json_extract(json, '$.width') > 0 AND json_extract(json, '$.height') > 0 LIMIT 1`).get(id);
  }

  /**
   * Update name/settings/head (media is managed through the media methods). "Last edited" moves only when the video
   * does: a new head, or a setting that changes it. A new name, archiving and pausing its media leave it where it was.
   */
  update(id: string, patch: { mediaPaused?: boolean; name?: string; archived?: boolean; settings?: Partial<ProjectSettings>; head?: string | null }): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    if (!row) throw new Error(`project ${id} not found`);
    const before = ProjectSettings.parse(JSON.parse(row.settings));
    const settings = ProjectSettings.parse({ ...before, ...(patch.settings ?? {}) });
    const edited = (patch.head !== undefined && patch.head !== row.head) || JSON.stringify(settings) !== JSON.stringify(before);
    this.db
      .prepare(
        `UPDATE projects SET name = coalesce(?, name), settings = coalesce(?, settings),
           head = CASE WHEN ? THEN ? ELSE head END, archived = coalesce(?, archived), media_paused = coalesce(?, media_paused),
           format_set = CASE WHEN ? THEN 1 ELSE format_set END, updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?`,
      )
      .run(
        patch.name ?? null,
        patch.settings ? JSON.stringify(settings) : null,
        Number(patch.head !== undefined), patch.head ?? null,
        patch.archived === undefined ? null : Number(patch.archived),
        patch.mediaPaused === undefined ? null : Number(patch.mediaPaused),
        Number(patch.settings !== undefined || !!patch.head), Number(edited), now(),
        id,
      );
    return this.get(id)!;
  }

  saveCompletedThreads(id: string, threads: Record<string, string>) {
    this.db.prepare("UPDATE projects SET completed_threads = ?, review_revision = review_revision + 1 WHERE id = ?").run(JSON.stringify(threads), id);
  }

  /** Repair a missing head only if another engine hasn't set a new one since the read. */
  initializeHead(id: string, expected: string | null, version: string): void {
    this.db.prepare("UPDATE projects SET head = ?, updated_at = ? WHERE id = ? AND head IS ? AND deleted_at IS NULL")
      .run(version, now(), id, expected);
  }

  touch(id: string) {
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  remove(id: string) {
    this.reviewCounts.delete(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  summaries(id?: string): ProjectSummary[] {
    const rows = this.db.prepare(`SELECT p.*, poster.id AS poster_id, json_extract(poster.json, '$.duration') AS poster_duration,
        (SELECT count(*) FROM media WHERE project_id = p.id) AS media_count,
        (SELECT duration FROM timeline_versions WHERE project_id = p.id AND version = p.head) AS head_duration,
        (EXISTS(SELECT 1 FROM changes WHERE project_id = p.id AND state = 'ready') OR EXISTS(SELECT 1 FROM tasks
          WHERE project_id = p.id AND kind != 'transcribe' AND state IN ('claimed','running','waiting_for_user','queued'))) AS may_wait,
        (SELECT count(*) FROM notes WHERE project_id = p.id AND state IN ('open','in_progress')) AS open_notes
      FROM projects p LEFT JOIN media poster ON poster.rowid = (
        SELECT rowid FROM media WHERE project_id = p.id AND json_extract(json, '$.kind') = 'video' ORDER BY created_at, rowid LIMIT 1
      ) WHERE p.deleted_at IS NULL ${id === undefined ? "" : "AND p.id = ?"} ORDER BY p.updated_at DESC`)
      .all(...(id === undefined ? [] : [id])) as Array<ProjectRow & {
        poster_id: string | null; poster_duration: number | null; media_count: number; head_duration: number | null; may_wait: number; open_notes: number; review_revision: number;
      }>;
    // Nothing waits on the editor without a proposal that is ready, a question, or a request still to run: a pass with
    // one cut sent back for revision keeps its other calls open while that revision is. Only then is the project read.
    // The task states are listed as the tasks_thread_pending index lists them, so that lookup uses it.
    return rows.map(row => ({
      ...projectHeader(row), mediaCount: row.media_count, pendingChanges: row.may_wait ? this.reviewCount(row.id, row.review_revision, row.completed_threads) : 0, openNotes: row.open_notes,
      poster: row.poster_id ? { mediaId: row.poster_id, time: Math.min(2, (row.poster_duration ?? 4) / 2) } : null,
      duration: row.head_duration ?? (row.head ? this.headDuration(row.id, row.head) : undefined),
    }));
  }

  // -- media -----------------------------------------------------------------

  private rowToMedia(r: MediaRow): MediaWithStatus {
    return { ...MediaAsset.parse(JSON.parse(r.json)), status: r.status, error: r.error ?? undefined };
  }

  listMedia(projectId: string): MediaWithStatus[] {
    const rows = this.db.prepare("SELECT * FROM media WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as MediaRow[];
    return rows.map((r) => this.rowToMedia(r));
  }

  importedMedia(projectId: string, importId: string): MediaWithStatus | null {
    const row = this.db.prepare("SELECT * FROM media WHERE project_id = ? AND json_extract(json, '$.importId') = ? LIMIT 1")
      .get(projectId, importId) as MediaRow | undefined;
    return row ? this.rowToMedia(row) : null;
  }

  /** A render reads original metadata for the sources that can contribute to its window. */
  assets(projectId: string, ids: ReadonlySet<string>): MediaAsset[] {
    if (!ids.size) return [];
    const rows = this.db.prepare(`SELECT m.json FROM json_each(?) wanted CROSS JOIN media m
      WHERE m.id = wanted.value AND m.project_id = ? ORDER BY m.created_at ASC`).all(JSON.stringify([...ids]), projectId) as { json: string }[];
    return rows.map(row => {
      const { status: _s, error: _e, ...asset } = MediaAsset.parse(JSON.parse(row.json));
      return asset;
    });
  }

  getMedia(mediaId: string): (MediaWithStatus & { projectId: string }) | null {
    const row = this.db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId) as MediaRow | undefined;
    return row ? { ...this.rowToMedia(row), projectId: row.project_id } : null;
  }

  /** Adding a file to the project is an edit and moves "Last edited". Its import, transcript and labels being saved are not. */
  putMedia(projectId: string, asset: MediaAsset, status: MediaStatus, error?: string): MediaWithStatus {
    const parsed = MediaAsset.parse(asset);
    const added = !this.db.prepare("SELECT 1 FROM media WHERE id = ?").get(parsed.id);
    this.db
      .prepare(
        `INSERT INTO media (id, project_id, status, error, json, created_at, ingest_pid) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error, json = excluded.json,
           ingest_pid = CASE WHEN excluded.status = 'ingesting' THEN media.ingest_pid END`,
      )
      .run(parsed.id, projectId, status, error ?? null, JSON.stringify(parsed), now(), status === "ingesting" ? process.pid : null);
    if (added) this.touch(projectId);
    return { ...parsed, status, error };
  }

  /** Take a file out of its project. Its scan pages and its cache request go with the row; its files are the caller's. */
  removeMedia(mediaId: string) {
    this.db.prepare("DELETE FROM media WHERE id = ?").run(mediaId);
  }
}

const Header = Project.omit({ media: true });
function projectHeader(row: ProjectRow): Omit<Project, "media"> {
  return Header.parse({ id: row.id, completedThreads: JSON.parse(row.completed_threads), name: row.name, mediaPaused: !!row.media_paused, archived: Boolean(row.archived), branch: row.branch, settings: JSON.parse(row.settings), head: row.head,
    createdAt: row.created_at, updatedAt: row.updated_at });
}
