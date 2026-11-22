import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  ensureColumn,
  ensureGraphics,
  ensureLookupIndexes,
  ensureProjectRowRevision,
  ensureReadIndexes,
  migrate,
} from "./dbMigrations.js";

export { ensureColumn, ensureGraphics, migrate } from "./dbMigrations.js";

/**
 * Thin wrapper over Node's built-in SQLite (no native addon, so the engine can
 * ship as a single executable). Exposes the small better-sqlite3-shaped API the
 * repos use: prepare().run/get/all, exec, pragma, transaction, close.
 */
type Bindable = null | number | bigint | string | Uint8Array;
type Param = unknown;

/** node:sqlite refuses undefined and booleans; map them the way SQLite users expect. */
function coerce(params: Param[]): Bindable[] {
  return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as Bindable)));
}

export class Statement {
  constructor(private readonly stmt: StatementSync) {}
  run(...params: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...coerce(params));
  }
  get(...params: Param[]): unknown {
    return this.stmt.get(...coerce(params));
  }
  all(...params: Param[]): unknown[] {
    return this.stmt.all(...coerce(params));
  }
  iterate(...params: Param[]) {
    return this.stmt.iterate(...coerce(params));
  }
}

export class Db {
  private readonly raw: DatabaseSync;
  private readonly cache = new Map<string, Statement>();
  private commitEffects?: Array<() => void>;
  /** Told when an effect scheduled with afterCommit throws. The engine writes it to its log. */
  onEffectError: (error: unknown) => void = error => process.emitWarning(error instanceof Error ? error : String(error));

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
  }
  prepare(sql: string): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = new Statement(this.raw.prepare(sql));
      this.cache.set(sql, s);
    }
    return s;
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  pragma(text: string, opts: { simple?: boolean } = {}): unknown {
    if (text.includes("=")) {
      this.raw.exec(`PRAGMA ${text}`);
      return undefined;
    }
    const row = this.raw.prepare(`PRAGMA ${text}`).get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return opts.simple ? Object.values(row)[0] : row;
  }
  get inTransaction(): boolean { return this.commitEffects !== undefined; }

  /** Schedule an observable effect after durable commit. Outside a transaction the write is already visible. */
  afterCommit(effect: () => void): void {
    if (this.commitEffects) this.commitEffects.push(effect);
    else effect();
  }

  /** Returns a function that runs `fn` inside BEGIN/COMMIT (ROLLBACK on throw). */
  transaction<A extends unknown[], R>(fn: (...args: A) => R, mode: "deferred" | "immediate" = "deferred"): (...args: A) => R {
    return (...args: A) => {
      this.raw.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
      const effects: Array<() => void> = [];
      this.commitEffects = effects;
      let result: R;
      try {
        result = fn(...args);
        this.raw.exec("COMMIT");
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      } finally {
        this.commitEffects = undefined;
      }
      for (const effect of effects) {
        try {
          effect();
        } catch (error) {
          // A listener cannot roll back the committed write or prevent later notifications.
          this.onEffectError(error);
        }
      }
      return result;
    };
  }
  /**
   * Run `fn` as a part of the open transaction that can fail by itself: what it wrote is undone and what it would
   * have announced is dropped, and the rest of the transaction stands. Outside a transaction it is one of its own.
   */
  savepoint<R>(fn: () => R): R {
    const effects = this.commitEffects;
    if (!effects) return this.transaction(fn, "immediate")();
    const announced = effects.length;
    this.raw.exec("SAVEPOINT part");
    try {
      const result = fn();
      this.raw.exec("RELEASE part");
      return result;
    } catch (e) {
      this.raw.exec("ROLLBACK TO part");
      this.raw.exec("RELEASE part");
      effects.length = announced;
      throw e;
    }
  }
  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Db(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  // These private in-flight results can coexist with a newer library schema used by another Scarlet build.
  db.exec(`CREATE TABLE IF NOT EXISTS transcription_work (
    media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    task_id TEXT UNIQUE NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    identity TEXT, alignment TEXT, transcript_id TEXT, result TEXT
  );
  CREATE TABLE IF NOT EXISTS transcription_chunks (
    media_id TEXT NOT NULL REFERENCES transcription_work(media_id) ON DELETE CASCADE,
    through REAL NOT NULL, fraction REAL, result TEXT NOT NULL, PRIMARY KEY (media_id, through)
  ) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS transcription_work_finished AFTER UPDATE OF state ON tasks
    WHEN NEW.kind = 'transcribe' AND (NEW.state IN ('done','cancelled') OR
      (NEW.state = 'failed' AND json_extract(NEW.json, '$.interrupted') IS NOT 1))
    BEGIN DELETE FROM transcription_work WHERE task_id = NEW.id; END;`);
  ensureReadIndexes(db);
  ensureLookupIndexes(db);
  ensureGraphics(db);
  db.exec(`CREATE TABLE IF NOT EXISTS show_areas (
    media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE, at REAL NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (media_id, at)
  );`);
  ensureProjectRowRevision(db);
  ensureColumn(db, "projects", "editing_paused", "ALTER TABLE projects ADD COLUMN editing_paused INTEGER NOT NULL DEFAULT 0;");
  return db;
}

export const now = () => new Date().toISOString();
