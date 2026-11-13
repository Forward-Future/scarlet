import type { ZodType, ZodTypeDef } from "zod/v3";
import type { Db } from "../db.js";

/**
 * Generic JSON-document table: the full validated document lives in `json`,
 * plus a few denormalized columns for indexing/filtering. Every table using
 * it has at least `id TEXT PRIMARY KEY, json TEXT, created_at TEXT`.
 */
export class JsonStore<T extends { id: string }> {
  constructor(
    private readonly db: Db,
    readonly table: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly schema: ZodType<T, ZodTypeDef, any>,
    private readonly index: (doc: T) => Record<string, string | number | null>,
  ) {}

  parse(json: string): T {
    return this.schema.parse(JSON.parse(json));
  }

  get(id: string): T | null {
    const row = this.db.prepare(`SELECT json FROM ${this.table} WHERE id = ?`).get(id) as { json: string } | undefined;
    return row ? this.parse(row.json) : null;
  }

  /** Insert or replace (by id). Returns the stored (validated) document. */
  put(doc: T): T {
    const parsed = this.schema.parse(doc);
    const cols = this.index(parsed);
    const names = ["id", "json", ...Object.keys(cols)];
    const values = [parsed.id, JSON.stringify(parsed), ...Object.values(cols)];
    const updates = names
      .filter((n) => n !== "id")
      .map((n) => `${n} = excluded.${n}`)
      .join(", ");
    this.db
      .prepare(
        `INSERT INTO ${this.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
         ON CONFLICT(id) DO UPDATE SET ${updates}`,
      )
      .run(...values);
    return parsed;
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
  }

  select(where = "1=1", params: unknown[] = [], orderBy = "created_at ASC"): T[] {
    const rows = this.db
      .prepare(`SELECT json FROM ${this.table} WHERE ${where} ORDER BY ${orderBy}`)
      .all(...params) as Array<{ json: string }>;
    return rows.map((r) => this.parse(r.json));
  }

  count(where = "1=1", params: unknown[] = []): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table} WHERE ${where}`).get(...params) as {
      n: number;
    };
    return row.n;
  }
}
