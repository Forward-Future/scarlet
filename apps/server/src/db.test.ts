import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createRepos } from "./repo/index.js";
import { createApp } from "./app.js";
import { Db, migrate, openDb } from "./db.js";

let directory: string;
let db: Db;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-db-test-"));
  db = new Db(join(directory, "plain.db"));
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, pinned INTEGER)");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

const bodies = () => (db.prepare("SELECT body FROM notes ORDER BY id").all() as { body: string | null }[]).map(row => row.body);

it("stores a missing value as NULL and a boolean as 0 or 1", () => {
  db.prepare("INSERT INTO notes (body, pinned) VALUES (?, ?), (?, ?)").run(undefined, true, "kept", false);
  expect(db.prepare("SELECT body, pinned FROM notes ORDER BY id").all()).toEqual([{ body: null, pinned: 1 }, { body: "kept", pinned: 0 }]);
  expect(db.prepare("SELECT body FROM notes WHERE pinned = ?").get(false)).toEqual({ body: "kept" });
  expect([...db.prepare("SELECT pinned FROM notes ORDER BY id").iterate()]).toEqual([{ pinned: 1 }, { pinned: 0 }]);
});

it("reads a pragma as a row or its one value, and sets one", () => {
  expect(db.pragma("user_version = 7")).toBeUndefined();
  expect(db.pragma("user_version")).toEqual({ user_version: 7 });
  expect(db.pragma("user_version", { simple: true })).toBe(7);
  // A pragma with nothing to report has no row.
  expect(db.pragma("table_info(nothing_by_this_name)")).toBeUndefined();
});

it("undoes a transaction that throws, and runs none of the effects it scheduled", () => {
  const effects: string[] = [];
  const write = db.transaction((body: string, fail: boolean) => {
    db.prepare("INSERT INTO notes (body) VALUES (?)").run(body);
    expect(db.inTransaction).toBe(true);
    db.afterCommit(() => effects.push(`${body} announced with ${bodies().length} saved`));
    if (fail) throw new Error("changed my mind");
    return body.length;
  }, "immediate");
  expect(() => write("lost", true)).toThrow("changed my mind");
  expect(db.inTransaction).toBe(false);
  expect(bodies()).toEqual([]);
  expect(effects).toEqual([]);
  // The effect waits for the commit: it sees the row as saved.
  expect(write("kept", false)).toBe(4);
  expect(effects).toEqual(["kept announced with 1 saved"]);
  // Outside a transaction the write is already visible, so an effect runs at once.
  db.afterCommit(() => effects.push("now"));
  expect(effects.at(-1)).toBe("now");
});

it("keeps a committed write and the effects after it when one effect throws, and reports the one that threw", () => {
  const reported: unknown[] = [], ran: string[] = [];
  db.onEffectError = error => reported.push(error);
  const failure = new Error("listener broke");
  const result = db.transaction(() => {
    db.prepare("INSERT INTO notes (body) VALUES ('saved')").run();
    db.afterCommit(() => ran.push("first"));
    db.afterCommit(() => { throw failure; });
    db.afterCommit(() => ran.push("third"));
    return "returned";
  })();
  expect(result).toBe("returned");
  expect(bodies()).toEqual(["saved"]);
  expect(ran).toEqual(["first", "third"]);
  expect(reported).toEqual([failure]);
});

it("warns the process about a failed effect when nothing else is listening", () => {
  const warned = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  db.transaction(() => { db.afterCommit(() => { throw "not even an error"; }); })();
  expect(warned).toHaveBeenCalledWith("not even an error");
});

it("writes a failed after-commit listener to the engine log with where it threw", async () => {
  const lines: string[] = [];
  const { ctx } = createApp({ dataDir: join(directory, "engine"), skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => lines.push(line) });
  try {
    lines.length = 0;
    ctx.db.transaction(() => {
      ctx.bus.on("ws", function brokenListener() { throw new Error("listener broke"); });
      ctx.bus.publish({ type: "render.settings.updated" });
    })();
    expect(lines).toEqual([expect.stringMatching(/^\[error\] after-commit listener failed: Error: listener broke\n\s+at .*brokenListener/)]);
  } finally { await ctx.close(); }
});

it("brings a new library up to date once, and leaves an up-to-date one alone", () => {
  const file = join(directory, "library.db");
  const library = openDb(file);
  const version = library.pragma("user_version", { simple: true }) as number;
  expect(version).toBeGreaterThanOrEqual(20);
  expect(library.prepare("SELECT count(*) AS runs FROM task_usage").get()).toEqual({ runs: 0 });
  expect(library.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(library.pragma("foreign_keys", { simple: true })).toBe(1);
  library.prepare("INSERT INTO settings (id, json) VALUES (1, '{}')").run();
  library.close();
  const again = openDb(file);
  expect(again.pragma("user_version", { simple: true })).toBe(version);
  expect(again.prepare("SELECT json FROM settings").get()).toEqual({ json: "{}" });
  again.close();
});

it("recovers first-video format decisions in a library with a newer schema version", () => {
  const file = join(directory, "formats.db");
  const library = openDb(file);
  const repos = createRepos(library);
  const fresh = repos.projects.insert(createProject("Audio first"));
  repos.projects.putMedia(fresh.id, { id: "mic", kind: "audio", name: "Voice", path: "voice.wav" }, "ready");
  const imported = repos.projects.insert(createProject("Existing video"));
  repos.projects.putMedia(imported.id, { id: "camera", kind: "video", name: "Phone", path: "phone.mov", width: 1080, height: 1920 }, "ready");
  const chosen = repos.projects.insert(createProject("Explicit landscape"));
  repos.activity.put({ id: "choice", projectId: chosen.id, type: "project.updated", actor: { type: "human", name: "Editor" },
    summary: "Set project format", data: { settings: chosen.settings }, createdAt: chosen.createdAt! });
  library.exec("ALTER TABLE projects DROP COLUMN format_set");
  const newerVersion = (library.pragma("user_version", { simple: true }) as number) + 8;
  library.pragma(`user_version = ${newerVersion}`);
  library.close();

  const reopened = openDb(file);
  try {
    expect(reopened.pragma("user_version", { simple: true })).toBe(newerVersion);
    const { projects } = createRepos(reopened);
    expect(projects.formatSet(fresh.id)).toBe(false);
    expect(projects.formatSet(imported.id)).toBe(true);
    expect(projects.formatSet(imported.id, true)).toBe(false);
    expect(projects.formatSet(chosen.id)).toBe(true);
    expect(projects.formatSet(chosen.id, true)).toBe(true);
  } finally { reopened.close(); }
});

it("doesn't run a migration again when another engine applied it after the version was read", () => {
  const file = join(directory, "shared.db");
  const first = openDb(file);
  const version = first.pragma("user_version", { simple: true });
  // A second engine opening the same library read the version before the first finished migrating it.
  const second = new Db(file);
  const read = second.pragma.bind(second);
  let stale = true;
  vi.spyOn(second, "pragma").mockImplementation((text, opts) => {
    if (text === "user_version" && stale) { stale = false; return 0; }
    return read(text, opts);
  });
  expect(() => migrate(second)).not.toThrow();
  expect(read("user_version", { simple: true })).toBe(version);
  first.close();
  second.close();
});

it("backfills only successful transcriptions and preserves them across old writers updating the same transcript", () => {
  const library = new Db(":memory:");
  try {
    migrate(library, 25); // Last release before media stored transcription history.
    const sourceAt = "2026-01-01T00:00:00.000Z", successAt = "2026-01-02T00:00:00.000Z", later = "2026-01-03T00:00:00.000Z";
    library.prepare("INSERT INTO projects(id,name,settings,created_at,updated_at) VALUES ('p','test','{}',?,?)").run(sourceAt, sourceAt);
    const file = (id: string, doc: Record<string, unknown>) => {
      const fields = { transcriptId: "trs_" + id, importId: "import_" + id };
      library.prepare("INSERT INTO media(id,project_id,status,json,created_at) VALUES (?,'p','ready',?,?)").run(id, JSON.stringify(fields), sourceAt);
      library.prepare("INSERT INTO transcripts(id,media_id,project_id,json,created_at) VALUES (?,?,'p',?,?)")
        .run(fields.transcriptId, id, JSON.stringify(doc), doc.createdAt);
    };
    const task = (mediaId: string, state: string, at: string, localModel?: string) => {
      const doc = { context: { mediaId, localModel }, finishedAt: at };
      library.prepare("INSERT INTO tasks(id,project_id,kind,agent,state,json,created_at) VALUES (?,'p','transcribe','api',?,?,?)")
        .run(mediaId + state, state, JSON.stringify(doc), sourceAt);
    };
    file("labelled", { speakerAnalysis: { version: 1 }, createdAt: later });
    task("labelled", "done", successAt, "crisperwhisper");
    task("labelled", "failed", later, "custom");
    file("raw", { provider: "whispercpp", createdAt: sourceAt });
    file("custom", { provider: "whispercpp", localModel: "custom", createdAt: later });
    task("custom", "done", successAt, "custom");
    file("orphan-labels", { localModel: "whispercpp", speakerAnalysis: { version: 1 }, createdAt: later });
    file("partial", { createdAt: later });
    task("partial", "failed", later);
    file("invalid-date", { createdAt: "date unknown" });
    migrate(library);
    const fields = (id: string) => JSON.parse((library.prepare("SELECT json FROM media WHERE id=?").get(id) as { json: string }).json);
    const original = { completedAt: successAt, model: "CrisperWhisper 2.0 large" };
    expect(fields("labelled").lastTranscription).toEqual(original);
    expect(fields("raw").lastTranscription).toEqual({ completedAt: sourceAt });
    expect(fields("custom").lastTranscription).toEqual({ completedAt: successAt });
    expect(fields("orphan-labels").lastTranscription).toEqual({ model: "Whisper large-v3-turbo" });
    expect(fields("partial").lastTranscription).toBeUndefined();
    expect(fields("invalid-date").lastTranscription).toBeUndefined();
    const olderSave = library.prepare("UPDATE media SET json = ? WHERE id = 'labelled'");
    olderSave.run(JSON.stringify({ transcriptId: "trs_labelled" }));
    expect(fields("labelled")).toMatchObject({ lastTranscription: original, importId: "import_labelled" });
    olderSave.run(JSON.stringify({ transcriptId: "new" }));
    expect(fields("labelled").lastTranscription).toBeUndefined();
  } finally { library.close(); }
});
