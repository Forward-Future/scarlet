import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "./app.js";
import { accessToken } from "./auth.js";
import { Db } from "./db.js";
import { createTask } from "./services/tasks.js";

let directory: string;
let workspace: ScarletApp;
let lines: string[];

beforeEach(() => {
  // The engine's housekeeping runs on intervals. Only those are faked: everything else keeps real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  directory = mkdtempSync(join(tmpdir(), "scarlet-background-test-"));
  const said: string[] = lines = [];
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => said.push(line) });
});
const settle = async () => { while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]); };
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

it("keeps the engine running, and the rest of the half-minute recovery, when one step of it throws", () => {
  const { ctx } = workspace;
  // A second engine holds the write lock past the timeout, so the first step can't begin its transaction.
  ctx.db.pragma("busy_timeout = 0");
  const peer = new Db(ctx.paths.db);
  peer.exec("BEGIN IMMEDIATE");
  const renders = vi.spyOn(ctx.renders, "recover").mockImplementation(() => { throw new Error("no such render"); });
  lines.length = 0;
  try {
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
  } finally {
    peer.exec("ROLLBACK");
    peer.close();
  }
  expect(renders).toHaveBeenCalledTimes(1);
  expect(lines).toEqual([
    "[task] recovering interrupted runs failed and will run again: database is locked",
    "[render] recovering interrupted renders failed and will run again: no such render",
  ]);

  // The next round runs as usual once the lock is free.
  renders.mockRestore();
  const again = vi.spyOn(ctx.renders, "recover");
  lines.length = 0;
  vi.advanceTimersByTime(30_000);
  expect(again).toHaveBeenCalledTimes(1);
  expect(lines).toEqual([]);
});

it("keeps the engine running when reacting to another engine's change throws", () => {
  const { ctx } = workspace;
  const project = ctx.repos.projects.insert(createProject("Shared"));
  vi.advanceTimersByTime(1000);
  // Another engine trashes the project in the shared library.
  const peer = new Db(ctx.paths.db);
  peer.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), project.id);
  peer.close();
  const stop = vi.spyOn(ctx.renders, "stopProject").mockImplementationOnce(() => { throw new Error("database is locked"); });
  lines.length = 0;
  expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  expect(stop).toHaveBeenCalledWith(project.id, false);
  expect(lines).toEqual(["[project] reacting to another engine’s change failed and will run again: database is locked"]);
  // The change is taken up on the next tick instead of being forgotten.
  lines.length = 0;
  vi.advanceTimersByTime(1000);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(lines).toEqual([]);
});

it("logs an unfinished import that the half-minute round couldn't pick up", async () => {
  const { ctx } = workspace;
  const project = ctx.repos.projects.insert(createProject("Imports"));
  // An import left unfinished by an engine that has gone.
  ctx.repos.projects.putMedia(project.id, { id: "med_left", kind: "audio", name: "Voice", path: "voice.wav", duration: 3 }, "ingesting");
  ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = 'med_left'").run();
  vi.spyOn(ctx.repos.projects, "getMedia").mockImplementation(() => { throw new Error("database is locked"); });
  lines.length = 0;
  vi.advanceTimersByTime(30_000);
  await settle();
  expect(lines).toEqual(["[ingest] preparing unfinished imports stopped part-way: database is locked"]);
});

it("logs an import whose preparation broke off without being marked failed", async () => {
  const { ctx } = workspace;
  const project = ctx.repos.projects.insert(createProject("Imports"));
  const source = join(directory, "voice.wav");
  writeFileSync(source, "fixture");
  vi.spyOn(ctx.render, "probeMedia").mockResolvedValue({ duration: 1, hasAudio: true, kind: "audio" });
  vi.spyOn(ctx.render, "hashFile").mockResolvedValue("a".repeat(64));
  // The import is saved as it arrives. After that the library can't be written to, so neither can its outcome.
  const save = ctx.repos.projects.putMedia.bind(ctx.repos.projects);
  vi.spyOn(ctx.repos.projects, "putMedia").mockImplementationOnce(save).mockImplementation(() => { throw new Error("database is locked"); });
  const res = await workspace.app.request(`/api/projects/${project.id}/media/import`, { method: "POST", body: JSON.stringify({ path: source }),
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" } });
  expect(res.status).toBe(201);
  const { media } = await res.json() as { media: { id: string } };
  await settle();
  expect(lines.filter(line => line.startsWith("[ingest]"))).toEqual([
    `[ingest] ${media.id} failed: database is locked`,
    `[ingest] ${media.id} stopped part-way and stays unfinished until Scarlet restarts: database is locked`,
  ]);
  expect(ctx.repos.projects.getMedia(media.id)?.status).toBe("ingesting");
});

/** The same engine with its clock faked as well as its rounds, so a test can make a round come late. */
async function withClock() {
  await workspace.ctx.close();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const said = lines;
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: line => said.push(line) });
  const { ctx } = workspace;
  const project = ctx.repos.projects.insert(createProject("Asleep"));
  const { id } = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Tighten the intro", state: "running",
    createdBy: { type: "human", name: "Editor" } });
  return {
    /** The half-minute round, this much later than it was due: the computer slept or the engine stalled meanwhile. */
    round(late = 0) {
      vi.setSystemTime(Date.now() + late);
      vi.advanceTimersByTime(30_000);
    },
    /** The run's worker is alive, and last said so this long ago. */
    heard: (ago: number) => ctx.db.prepare("UPDATE tasks SET worker_pid = ?, worker_seen_at = ? WHERE id = ?")
      .run(process.pid, new Date(Date.now() - ago).toISOString(), id),
    /** Whether the run still stands, and how old its worker's last word is. */
    run: () => ({ state: ctx.repos.tasks.get(id)!.state,
      heard: Date.now() - Date.parse((ctx.db.prepare("SELECT worker_seen_at FROM tasks WHERE id = ?").get(id) as { worker_seen_at: string }).worker_seen_at) }),
  };
}

it("gives a live run its window again when a round comes late enough to make it look lost", async () => {
  const { round, heard, run } = await withClock();
  heard(25_000);
  // 40 s late, as after a short sleep: the last word is 95 s old by then, and nothing could have renewed it.
  round(40_000);
  expect(run()).toEqual({ state: "running", heard: 0 });
  // The window is one window. A worker that says nothing through it is lost.
  round();
  round();
  expect(run().state).toBe("running");
  round();
  expect(run().state).toBe("failed");
});

it("leaves a live run alone when a round comes a quarter of a minute late or less", async () => {
  const { round, heard, run } = await withClock();
  heard(29_000);
  round(15_000);
  // No window was given, and none was needed: the word is 74 s old.
  expect(run()).toEqual({ state: "running", heard: 74_000 });
});

it("adds up the lateness of rounds that come late one after another", async () => {
  const { round, heard, run } = await withClock();
  heard(12_000);
  // Asleep 38 s, awake 5 s, asleep 38 s: two rounds 43 s apart, and a worker that had no half minute awake to speak in.
  round(13_000);
  expect(run()).toEqual({ state: "running", heard: 55_000 });
  round(13_000);
  expect(run()).toEqual({ state: "running", heard: 0 });
  // The count starts again from there.
  round(13_000);
  expect(run()).toEqual({ state: "running", heard: 43_000 });
});

it("forgets a late round once the next one comes on time", async () => {
  const { round, heard, run } = await withClock();
  heard(0);
  round(13_000);
  heard(0);
  // On time, as a real round is: a little late.
  round(900);
  heard(25_000);
  round(13_000);
  expect(run()).toEqual({ state: "running", heard: 68_000 });
});

it("gives up a run whose worker has said nothing for 90 s while every round came on time", async () => {
  const { round, heard, run } = await withClock();
  heard(31_000);
  round();
  expect(run()).toEqual({ state: "running", heard: 61_000 });
  round();
  expect(run().state).toBe("failed");
  expect(workspace.ctx.repos.tasks.select("state = 'failed'")[0]).toMatchObject({ interrupted: true });
});
