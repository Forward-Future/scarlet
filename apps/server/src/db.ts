import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

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
  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

/** Versioned migrations; `PRAGMA user_version` tracks how many have been applied. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    created_by TEXT NOT NULL,
    used_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    settings TEXT NOT NULL,
    head TEXT,
    review_state TEXT NOT NULL DEFAULT 'editing',
    reviewer_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    error TEXT,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX media_project ON media(project_id);
  CREATE TABLE transcripts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX transcripts_media ON transcripts(media_id);
  CREATE TABLE timeline_versions (
    version TEXT NOT NULL,
    project_id TEXT NOT NULL,
    parent TEXT,
    json TEXT NOT NULL,
    author TEXT,
    change_id TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, version)
  );
  CREATE TABLE changes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX changes_project_state ON changes(project_id, state);
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX notes_project_state ON notes(project_id, state);
  CREATE TABLE renders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    version TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX renders_key ON renders(key);
  CREATE INDEX renders_project ON renders(project_id, kind, version);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent TEXT NOT NULL,
    state TEXT NOT NULL,
    host_id TEXT,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project_state ON tasks(project_id, state);
  CREATE INDEX tasks_state ON tasks(state, created_at);
  CREATE TABLE task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    json TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX task_events_task ON task_events(task_id, at);
  CREATE TABLE agent_hosts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    json TEXT NOT NULL,
    last_seen_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    owner_id TEXT,
    project_id TEXT,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX skills_scope ON skills(scope, owner_id, project_id);
  CREATE TABLE skill_versions (
    skill_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    author TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (skill_id, version)
  );
  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    json TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX notifications_user ON notifications(user_id, read);
  `,
  `
  CREATE TABLE quick_actions (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    owner_id TEXT,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX quick_actions_scope ON quick_actions(scope, owner_id);
  `,
  `
  ALTER TABLE projects ADD COLUMN deleted_at TEXT;
  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    type TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX activity_project ON activity(project_id, created_at);
  `,
  "ALTER TABLE media ADD COLUMN ingest_pid INTEGER;",
  `ALTER TABLE tasks ADD COLUMN worker_pid INTEGER;
   ALTER TABLE tasks ADD COLUMN worker_seen_at TEXT;
   UPDATE tasks SET worker_seen_at = (SELECT last_seen_at FROM agent_hosts WHERE id = tasks.host_id)
    WHERE state IN ('claimed','running');`,
  `ALTER TABLE timeline_versions ADD COLUMN timeline_name TEXT;
   ALTER TABLE timeline_versions ADD COLUMN duration REAL;
   CREATE INDEX media_first_video ON media(project_id, created_at) WHERE json_extract(json, '$.kind') = 'video';`,
  `CREATE INDEX tasks_thread_pending ON tasks(project_id, coalesce(json_extract(json, '$.context.threadId'), id), created_at)
     WHERE state IN ('claimed','running','waiting_for_user','queued');`,
  `CREATE INDEX renders_completed_preview ON renders(json_extract(json, '$.previewContentKey'), created_at)
     WHERE state = 'done';`,
  "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
  `ALTER TABLE projects ADD COLUMN branch TEXT NOT NULL DEFAULT 'main';
   CREATE TABLE cut_branches (
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL, head TEXT, PRIMARY KEY (project_id, name)
   );
   INSERT INTO cut_branches SELECT id, branch, head FROM projects;
   CREATE TRIGGER create_main_branch AFTER INSERT ON projects BEGIN
     INSERT INTO cut_branches VALUES (NEW.id, NEW.branch, NEW.head);
   END;
   CREATE TRIGGER advance_cut_branch AFTER UPDATE OF head ON projects BEGIN
     UPDATE cut_branches SET head = NEW.head WHERE project_id = NEW.id AND name = NEW.branch;
   END;`,
  // Older recovery marked partial edits as done using this fixed message.
  `UPDATE tasks SET state = 'failed',
     json = json_set(json, '$.state', 'failed', '$.interrupted', json('true'), '$.summary', NULL,
       '$.error', 'The agent was interrupted after saving changes.')
   WHERE state = 'done' AND host_id IS NULL AND json_array_length(json, '$.changeIds') > 0
     AND json_extract(json, '$.summary') = 'The agent was interrupted after saving its proposed changes. You can review them here.';`,
  `CREATE TABLE IF NOT EXISTS storage_purges (project_id TEXT PRIMARY KEY);`,
  // Badge counts depend on task state and links between changes and feedback.
  // Invalidate across all engine processes, including restores and SQL recovery.
  ["ALTER TABLE projects ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 0;",
    ...["changes", "tasks", "notes"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(action => {
      const rows = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
      const operation = action === "UPDATE" ? "UPDATE OF json, project_id, state" : action;
      const relevant = table === "tasks" ? rows.map(row => `${row}.kind != 'transcribe'`) :
        table === "notes" ? rows.map(row => `json_extract(${row}.json, '$.changeId') IS NOT NULL`) : [];
      return `CREATE TRIGGER review_revision_${table}_${action} AFTER ${operation} ON ${table}
        ${relevant.length ? "WHEN " + relevant.join(" OR ") : ""}
        BEGIN UPDATE projects SET review_revision = review_revision + 1 WHERE id IN (${rows.map(row => row + ".project_id").join(",")}); END;`;
    })),
  ].join("\n"),
  "CREATE INDEX renders_pending ON renders(state) WHERE state IN ('queued','running');",
  `CREATE TABLE dialogue_scan_pages (
     media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
     fingerprint TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, result TEXT NOT NULL,
     PRIMARY KEY (media_id, fingerprint, start, end)
   ) WITHOUT ROWID;`,
  `ALTER TABLE projects ADD COLUMN media_paused INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE source_cache_requests (media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE, worker_pid INTEGER);`,
  "ALTER TABLE projects ADD COLUMN completed_threads TEXT NOT NULL DEFAULT '{}';",
  `ALTER TABLE settings ADD COLUMN transcription_revision INTEGER NOT NULL DEFAULT 0;
   CREATE TRIGGER transcription_provider_changed AFTER UPDATE OF json ON settings
   WHEN json_extract(OLD.json, '$.transcription.provider') IS NOT json_extract(NEW.json, '$.transcription.provider')
   BEGIN UPDATE settings SET transcription_revision = transcription_revision + 1 WHERE id = NEW.id; END;`,
  // One row per agent run. A resumed or retried edit adds a run; the claim's start keeps a repeated report idempotent.
  `CREATE TABLE task_usage (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     agent TEXT NOT NULL,
     model TEXT,
     run_started_at TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     reasoning_tokens INTEGER NOT NULL DEFAULT 0,
     at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX task_usage_run ON task_usage(task_id, run_started_at);
   CREATE INDEX task_usage_project ON task_usage(project_id, at);`,
  // Skills Scarlet comes with are ordinary skills. One the editor had edited becomes their own; nothing merges into it again.
  `UPDATE skills SET json = json_remove(json, '$.source') WHERE json_extract(json, '$.source') IN ('seed', 'bundled')
     AND json_extract(json, '$.stockBase') IS NOT json_extract(json, '$.content');
   UPDATE skills SET json = json_remove(json, '$.stockBase', '$.stockUpdate');`,
  // Rules Scarlet picked up from the editor's requests, waiting for them to approve or decline.
  `CREATE TABLE learnings (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     state TEXT NOT NULL,
     json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX learnings_project_state ON learnings(project_id, state);`,
  // When each engine began, beside its process id, from its start until it quits. An import, a source cache and a
  // render name the engine working on them by that id alone, and an id goes to another program once its engine is gone.
  "CREATE TABLE engines (pid INTEGER PRIMARY KEY, started_at REAL NOT NULL);",
  `CREATE UNIQUE INDEX IF NOT EXISTS media_import_request ON media(project_id, json_extract(json, '$.importId'))
     WHERE json_extract(json, '$.importId') IS NOT NULL;`,
  // An older Scarlet can update this recording's transcript or status while it shares the library.
  // It serializes the media fields it knows, so preserve the request that already imported this original.
  `CREATE TRIGGER IF NOT EXISTS media_keep_import_request AFTER UPDATE OF json ON media
     WHEN json_extract(OLD.json, '$.importId') IS NOT NULL AND json_extract(NEW.json, '$.importId') IS NULL
     BEGIN
       UPDATE media SET json = json_set(NEW.json, '$.importId', json_extract(OLD.json, '$.importId')) WHERE id = NEW.id;
     END;`,
  // Imports and dialogue jobs hold this revision while queued. Switching local runtimes revokes that work too.
  `DROP TRIGGER transcription_provider_changed;
   CREATE TRIGGER transcription_provider_changed AFTER UPDATE OF json ON settings
   WHEN json_extract(OLD.json, '$.transcription.provider') IS NOT json_extract(NEW.json, '$.transcription.provider')
     OR (json_extract(NEW.json, '$.transcription.provider') = 'whispercpp' AND (
       json_extract(OLD.json, '$.transcription.localModel') IS NOT json_extract(NEW.json, '$.transcription.localModel') OR
       (COALESCE(json_extract(NEW.json, '$.transcription.localModel'), 'custom') = 'custom' AND (
         json_extract(OLD.json, '$.transcription.whisperCppPath') IS NOT json_extract(NEW.json, '$.transcription.whisperCppPath') OR
         json_extract(OLD.json, '$.transcription.whisperModelPath') IS NOT json_extract(NEW.json, '$.transcription.whisperModelPath')
       ))
     ))
   BEGIN UPDATE settings SET transcription_revision = transcription_revision + 1 WHERE id = NEW.id; END;`,
  // Older recordings have a finish time on the successful job. The earliest releases saved it on the raw
  // transcript alone. A speaker-labelled copy has its own creation date, and a failed job can leave partial words.
  // Backfill the media rows once so opening a project never has to load a transcript to show its history.
  `WITH attempts AS (
     SELECT project_id, json_extract(json, '$.context.mediaId') AS media_id, state,
       json_extract(json, '$.finishedAt') AS finished, json_extract(json, '$.context.localModel') AS preset,
       min(created_at) OVER recording AS first_attempt,
       row_number() OVER (recording ORDER BY (state = 'done') DESC, json_extract(json, '$.finishedAt') DESC, rowid DESC) AS n
     FROM tasks WHERE kind = 'transcribe' AND json_extract(json, '$.context.mediaId') IS NOT NULL
     WINDOW recording AS (PARTITION BY project_id, json_extract(json, '$.context.mediaId'))
   ), history AS MATERIALIZED (
     SELECT m.id, CASE WHEN a.state = 'done' THEN a.finished
       WHEN (a.first_attempt IS NULL OR t.created_at < a.first_attempt)
         AND json_extract(t.json, '$.speakerAnalysis') IS NULL AND json_extract(t.json, '$.aligning') IS NULL
         THEN json_extract(t.json, '$.createdAt') END AS finished,
       CASE WHEN a.state = 'done' THEN coalesce(a.preset, json_extract(t.json, '$.localModel'))
         WHEN (a.first_attempt IS NULL OR t.created_at < a.first_attempt) AND json_extract(t.json, '$.aligning') IS NULL
         THEN json_extract(t.json, '$.localModel') END AS preset
     FROM media m LEFT JOIN attempts a ON a.project_id = m.project_id AND a.media_id = m.id AND a.n = 1
     LEFT JOIN transcripts t ON (a.state IS NOT 'done' OR a.preset IS NULL) AND t.media_id = m.id AND t.project_id = m.project_id
       AND t.id = coalesce(json_extract(m.json, '$.transcriptId'),
         (SELECT id FROM transcripts WHERE project_id = m.project_id AND media_id = m.id ORDER BY created_at DESC LIMIT 1))
     WHERE json_extract(m.json, '$.lastTranscription') IS NULL
   ), summary AS (
     SELECT id, CASE WHEN finished GLOB '????-??-??[ T]??:??:??*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', finished) END AS finished,
       CASE preset WHEN 'crisperwhisper' THEN 'CrisperWhisper 2.0 large'
       WHEN 'whispercpp' THEN 'Whisper large-v3-turbo' END AS model FROM history
   ) UPDATE media AS m SET json = json_set(m.json, '$.lastTranscription',
     json_patch('{}', json_object('completedAt', s.finished, 'model', s.model)))
     FROM summary s WHERE s.id = m.id AND (s.finished IS NOT NULL OR s.model IS NOT NULL);
   CREATE TRIGGER IF NOT EXISTS media_keep_transcription_history AFTER UPDATE OF json ON media
     WHEN json_extract(OLD.json, '$.lastTranscription') IS NOT NULL AND json_extract(NEW.json, '$.lastTranscription') IS NULL
       AND json_extract(OLD.json, '$.transcriptId') IS NOT NULL
       AND json_extract(OLD.json, '$.transcriptId') = json_extract(NEW.json, '$.transcriptId')
     BEGIN
       UPDATE media SET json = json_set(json, '$.lastTranscription', json_extract(OLD.json, '$.lastTranscription')) WHERE id = NEW.id;
     END;`,
  // An engine can miss a brief opt-out in another engine. Its buffered events still belong to the old preference.
  `ALTER TABLE settings ADD COLUMN telemetry_revision INTEGER NOT NULL DEFAULT 0;
   CREATE TRIGGER telemetry_preference_changed AFTER UPDATE OF json ON settings
   WHEN coalesce(json_extract(OLD.json, '$.telemetryEnabled'), 1) != coalesce(json_extract(NEW.json, '$.telemetryEnabled'), 1)
   BEGIN
     -- Older engines write only the settings they understand. Preserve an opt-out across such a save.
     UPDATE settings SET json = json_set(NEW.json, '$.telemetryEnabled', json('false'))
       WHERE id = NEW.id AND json_type(NEW.json, '$.telemetryEnabled') IS NULL;
     UPDATE settings SET telemetry_revision = telemetry_revision + 1
       WHERE id = NEW.id AND json_type(NEW.json, '$.telemetryEnabled') IS NOT NULL;
   END;`,
];

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
  return db;
}

export function migrate(db: Db, throughVersion = MIGRATIONS.length): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < throughVersion; i++) {
    db.transaction(() => {
      // Another engine opening this library may have applied it since the version was read. Look again with the write lock held.
      if ((db.pragma("user_version", { simple: true }) as number) > i) return;
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    }, "immediate")();
  }
  if (throughVersion === MIGRATIONS.length) ensureProjectFormat(db);
}

/** A release with later numbered migrations can share this library. Install the format flag once on either schema. */
function ensureProjectFormat(db: Db): void {
  const installed = db.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name = 'format_set'");
  if (installed.get()) return;
  db.transaction(() => {
    if (installed.get()) return;
    // Older engines can still create a project here. Their first-video handshake can finish for a NULL flag.
    db.exec(`ALTER TABLE projects ADD COLUMN format_set INTEGER;
      UPDATE projects SET format_set = 0 WHERE NOT EXISTS (SELECT 1 FROM media WHERE project_id = projects.id
        AND json_extract(json, '$.kind') = 'video' AND json_extract(json, '$.width') > 0 AND json_extract(json, '$.height') > 0);
      UPDATE projects SET format_set = 1 WHERE EXISTS (SELECT 1 FROM activity
        WHERE project_id = projects.id AND type = 'project.updated' AND json_type(json, '$.data.settings') = 'object');`);
  }, "immediate")();
}

/** These derived lookups can coexist with any library that has task events and transcripts.
 * A checkout and a newer release can share them without taking each other's migration numbers. */
function ensureReadIndexes(db: Db): void {
  const installed = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'transcript_revisions'");
  if (installed.get()) return;
  db.transaction(() => {
    if (installed.get()) return;
    db.exec(`
      ALTER TABLE task_events ADD COLUMN event_kind TEXT GENERATED ALWAYS AS (
        CASE WHEN json_extract(json, '$.type') IN ('question','answer','plan') THEN json_extract(json, '$.type')
          WHEN json_extract(json, '$.type') = 'log' AND json_extract(json, '$.data.kind') IN ('editor_progress','media_wait')
            THEN 'log:' || json_extract(json, '$.data.kind') END
      ) VIRTUAL;
      CREATE INDEX task_events_kind ON task_events(task_id, event_kind, at) WHERE event_kind IS NOT NULL;
      CREATE TABLE transcript_revisions (
        transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id) ON DELETE CASCADE ON UPDATE CASCADE,
        revision TEXT NOT NULL DEFAULT (hex(randomblob(16)))
      ) WITHOUT ROWID;
    `);
    // Updating the stamp in a separate table avoids rewriting the large transcript document twice.
    // Existing transcripts keep a null stamp until their first write.
    for (const [name, operation] of Object.entries({ insert: "INSERT", update: "UPDATE OF json" })) {
      db.exec(`CREATE TRIGGER transcript_revision_${name} AFTER ${operation} ON transcripts
        BEGIN INSERT INTO transcript_revisions(transcript_id) VALUES (NEW.id)
          ON CONFLICT(transcript_id) DO UPDATE SET revision = excluded.revision; END;`);
    }
  }, "immediate")();
}

export const now = () => new Date().toISOString();
