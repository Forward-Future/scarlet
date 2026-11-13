import { Author, Timeline, timelineDuration } from "@scarlet/timeline";
import type { VersionSummary } from "@scarlet/shared";
import type { Db } from "../db.js";

export interface VersionRow {
  version: string;
  projectId: string;
  parent: string | null;
  timeline: Timeline;
  author?: Author;
  changeId: string | null;
  description?: string;
  createdAt: string;
}

interface Raw {
  version: string;
  project_id: string;
  parent: string | null;
  json: string;
  author: string | null;
  change_id: string | null;
  description: string | null;
  created_at: string;
}

const toRow = (r: Raw, timeline = Timeline.parse(JSON.parse(r.json))): VersionRow => ({
  version: r.version,
  projectId: r.project_id,
  parent: r.parent,
  timeline,
  author: r.author ? Author.parse(JSON.parse(r.author)) : undefined,
  changeId: r.change_id,
  description: r.description ?? undefined,
  createdAt: r.created_at,
});

/** Immutable, content-addressed timeline versions. */
export class VersionsRepo {
  // Keep validated JSON rather than shared mutable timelines. Every caller still
  // owns its copy, and a rollback, purge or peer write is reflected in the SQL row.
  private static readonly budget = 8 * 1024 * 1024;
  private readonly validated = new Map<string, { raw: string; normalized?: string; bytes: number }>();
  private cachedBytes = 0;

  constructor(private readonly db: Db) {}

  private readTimeline(row: Raw): Timeline {
    const key = JSON.stringify([row.project_id, row.version]);
    const previous = this.validated.get(key);
    if (previous) {
      this.validated.delete(key);
      if (previous.raw === row.json) {
        this.validated.set(key, previous);
        return JSON.parse(previous.normalized ?? previous.raw) as Timeline;
      }
      this.cachedBytes -= previous.bytes;
    }
    const timeline = Timeline.parse(JSON.parse(row.json));
    if (row.json.length * 2 > VersionsRepo.budget) return timeline;
    const json = JSON.stringify(timeline);
    const normalized = json === row.json ? undefined : json;
    const bytes = (key.length + row.json.length + (normalized?.length ?? 0)) * 2;
    if (bytes <= VersionsRepo.budget) {
      this.validated.set(key, { raw: row.json, normalized, bytes });
      this.cachedBytes += bytes;
      for (const [oldKey, entry] of this.validated) {
        if (this.cachedBytes <= VersionsRepo.budget && this.validated.size <= 32) break;
        this.validated.delete(oldKey);
        this.cachedBytes -= entry.bytes;
      }
    }
    return timeline;
  }

  get(projectId: string, version: string): VersionRow | null {
    const row = this.db
      .prepare("SELECT * FROM timeline_versions WHERE project_id = ? AND version = ?")
      .get(projectId, version) as Raw | undefined;
    return row ? toRow(row, this.readTimeline(row)) : null;
  }

  exists(projectId: string, version: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM timeline_versions WHERE project_id = ? AND version = ?")
      .get(projectId, version);
  }

  /** Whether any version of the project names this file: the working video, one in its history, or one still proposed. */
  usesMedia(projectId: string, mediaId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM timeline_versions WHERE project_id = ? AND instr(json, ?) LIMIT 1")
      .get(projectId, JSON.stringify(mediaId));
  }

  insert(row: VersionRow): VersionRow {
    const result = this.db
      .prepare(
        `INSERT INTO timeline_versions (version, project_id, parent, json, author, change_id, description, created_at, timeline_name, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version) DO NOTHING`,
      )
      .run(
        row.version,
        row.projectId,
        row.parent,
        JSON.stringify(row.timeline),
        row.author ? JSON.stringify(row.author) : null,
        row.changeId,
        row.description ?? null,
        row.createdAt,
        row.timeline.name,
        timelineDuration(row.timeline),
      );
    return result.changes ? row : this.get(row.projectId, row.version)!;
  }

  setChangeId(projectId: string, version: string, changeId: string) {
    this.db
      .prepare("UPDATE timeline_versions SET change_id = ? WHERE project_id = ? AND version = ? AND change_id IS NULL")
      .run(changeId, projectId, version);
  }

  list(projectId: string): VersionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM timeline_versions WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as Raw[];
    return rows.map(row => toRow(row));
  }

  links(projectId: string) {
    return this.db.prepare(`SELECT v.version, v.parent, v.change_id AS changeId, v.description,
      json_extract(c.json, '$.revertsVersion') AS revertsVersion
      FROM timeline_versions v LEFT JOIN changes c ON c.id = v.change_id WHERE v.project_id = ?`)
      .all(projectId) as Array<{ version: string; parent: string | null; changeId: string | null; description?: string; revertsVersion?: string }>;
  }

  summaries(projectId: string, head: string | null): VersionSummary[] {
    const rows = this.db.prepare(`SELECT v.version, v.parent, v.author, v.change_id, v.description, v.created_at, v.timeline_name, v.duration,
      json_extract(c.json, '$.revertsVersion') AS reverts_version
      FROM timeline_versions v LEFT JOIN changes c ON c.id = v.change_id WHERE v.project_id = ? ORDER BY v.created_at DESC, v.rowid DESC`).all(projectId) as Array<
      Omit<Raw, "json" | "project_id"> & { timeline_name: string | null; duration: number | null; reverts_version: string | null }
    >;
    const legacy = rows.filter(r => r.duration === null || r.timeline_name === null);
    if (legacy.length) this.db.transaction(() => {
      const save = this.db.prepare("UPDATE timeline_versions SET timeline_name = ?, duration = ? WHERE project_id = ? AND version = ?");
      for (const row of legacy) {
        const timeline = this.get(projectId, row.version)!.timeline;
        row.timeline_name = timeline.name;
        row.duration = timelineDuration(timeline);
        save.run(row.timeline_name, row.duration, projectId, row.version);
      }
    }, "immediate")();
    return rows.map(r => ({
      revertsVersion: r.reverts_version ?? undefined, version: r.version, parent: r.parent, name: r.timeline_name!, duration: r.duration!,
      author: r.author ? Author.parse(JSON.parse(r.author)) : undefined, changeId: r.change_id,
      description: r.description ?? undefined, createdAt: r.created_at, isHead: r.version === head,
    }));
  }
}
