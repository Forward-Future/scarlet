import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Task } from "@scarlet/shared";
import { Change, createProject, timelineFromKeepRanges } from "@scarlet/timeline";
import { openDb, type Db } from "../db.js";
import { createRepos, type Repos } from "./index.js";

let db: Db;
let repos: Repos;

beforeEach(() => {
  db = openDb(":memory:");
  repos = createRepos(db);
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

it("moves Last edited only when the video changes, and lists a renamed, archived, paused or restored project where it was", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-07T09:00:00Z"));
  const older = repos.projects.insert(createProject("Older"));
  vi.setSystemTime(new Date("2030-01-09T09:00:00Z"));
  const newer = repos.projects.insert(createProject("Newer"));
  const listed = () => repos.projects.summaries().map(p => [p.name, p.updatedAt]);
  const start = [["Newer", "2030-01-09T09:00:00.000Z"], ["Older", "2030-01-07T09:00:00.000Z"]];
  expect(listed()).toEqual(start);

  vi.setSystemTime(new Date("2030-01-10T12:00:00Z"));
  expect(repos.projects.update(older.id, { archived: true })).toMatchObject({ archived: true, updatedAt: older.updatedAt });
  repos.projects.update(older.id, { archived: false });
  repos.projects.update(older.id, { mediaPaused: true });
  repos.projects.update(older.id, { mediaPaused: false });
  // A setting sent back as it already is changes nothing in the video.
  repos.projects.update(older.id, { settings: { fps: older.settings.fps } });
  repos.projects.update(older.id, { head: null });
  repos.projects.softDelete(older.id);
  repos.projects.restore(older.id);
  expect(listed()).toEqual(start);
  expect(repos.projects.update(older.id, { name: "Renamed" })).toMatchObject({ name: "Renamed", updatedAt: older.updatedAt });
  expect(listed()).toEqual([start[0], ["Renamed", "2030-01-07T09:00:00.000Z"]]);

  // A setting that changes the video is an edit, and so is a new head.
  expect(repos.projects.update(older.id, { settings: { fps: 24 } }).updatedAt).toBe("2030-01-10T12:00:00.000Z");
  expect(listed().map(([name]) => name)).toEqual(["Renamed", "Newer"]);
  vi.setSystemTime(new Date("2030-01-11T12:00:00Z"));
  expect(repos.projects.update(newer.id, { head: "ver_1" })).toMatchObject({ head: "ver_1", updatedAt: "2030-01-11T12:00:00.000Z" });
  expect(listed().map(([name]) => name)).toEqual(["Newer", "Renamed"]);
});

it("counts for the library what the project's chat counts: a pass's calls that still wait, and a question as one", () => {
  const project = repos.projects.insert(createProject("Interview"));
  const count = () => repos.projects.summaries()[0]!.pendingChanges;
  const task = (id: string, fields: Record<string, unknown> = {}) => repos.tasks.put(Task.parse({ id, projectId: project.id, kind: "edit", agent: "claude",
    instruction: "/first-cut-dialogue", state: "done", createdBy: { type: "human", name: "Editor" }, createdAt: new Date(0).toISOString(), ...fields }));
  expect(count()).toBe(0);

  // A pass that staged eight cuts and asks about five of them.
  task("run");
  const cuts = Array.from({ length: 8 }, (_, i) => ({ start: i * 10, end: i * 10 + 1, reason: "Retake" }));
  const pass = repos.changes.put(Change.parse({ id: "pass", projectId: project.id, threadId: "run", taskId: "run", intent: "suggestion", description: "Dialogue pass",
    fromVersion: "v0", toVersion: "v1", author: { type: "agent", name: "Scarlet" }, state: "ready", createdAt: new Date(1000).toISOString(), cutReasons: cuts,
    cutAssessments: cuts.map((cut, index) => ({ index, ...cut, verdict: index < 5 ? "ask" : "cut" })) }));
  expect(count()).toBe(5);
  repos.changes.put({ ...pass, cutChoices: [{ index: 0, start: 0, end: 1, choice: "cut" }, { index: 1, start: 10, end: 11, choice: "keep" }] });
  expect(count()).toBe(3);

  // One call sent back: no proposal is ready while Scarlet revises it, and the pass's other calls still wait.
  repos.changes.put({ ...pass, state: "revising" });
  const revision = task("revision", { kind: "revise", state: "queued", context: { threadId: "run", changeId: "pass", cutIndex: 4 }, createdAt: new Date(2000).toISOString() });
  expect(count()).toBe(4);
  repos.tasks.put({ ...revision, state: "cancelled" });
  expect(count()).toBe(0);

  // A question waits with nothing proposed at all.
  task("ask", { instruction: "Add a title card for each guest.", state: "waiting_for_user", question: "Which guests?", createdAt: new Date(3000).toISOString() });
  expect(count()).toBe(1);
});

it("sends how long each project's video runs with the library, and works out a head saved before lengths were kept", () => {
  const cut = repos.projects.insert(createProject("Cut"));
  const fresh = repos.projects.insert(createProject("Fresh"));
  const timeline = { ...timelineFromKeepRanges(cut.id, "camera", [{ start: 0, end: 1002 }]), version: "ver_cut" };
  repos.versions.insert({ version: "ver_cut", projectId: cut.id, parent: null, timeline, changeId: null, createdAt: new Date(0).toISOString() });
  repos.projects.update(cut.id, { head: "ver_cut" });
  const lengths = () => Object.fromEntries(repos.projects.summaries().map(p => [p.name, p.duration]));
  // A project with no video yet has no length.
  expect(lengths()).toEqual({ Cut: 1002, Fresh: undefined });
  db.prepare("UPDATE timeline_versions SET duration = NULL WHERE version = 'ver_cut'").run();
  expect(lengths()).toEqual({ Cut: 1002, Fresh: undefined });
  expect(db.prepare("SELECT duration FROM timeline_versions WHERE version = 'ver_cut'").get()).toEqual({ duration: 1002 });
  // A head the library holds no version for has none either.
  repos.projects.update(fresh.id, { head: "ver_gone" });
  expect(lengths()).toEqual({ Cut: 1002, Fresh: undefined });
});
