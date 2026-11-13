import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ScarletClient, type WsEvent } from "@scarlet/shared";
import { accessToken } from "./auth.js";
import { createApp, type ScarletApp } from "./app.js";
import type { Ctx } from "./context.js";
import { logStateChanges } from "./eventLog.js";

let dir: string, workspace: ScarletApp, api: ScarletClient;
const lines: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-event-log-"));
  workspace = createApp({ dataDir: dir, env: {}, log: line => lines.push(line) });
  const fetch: typeof globalThis.fetch = (input, init) => Promise.resolve(workspace.app.request(input, init));
  api = new ScarletClient({ baseUrl: "https://fixture.test", token: accessToken(workspace.ctx), fetch });
});
beforeEach(() => { lines.length = 0; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => {
  await workspace?.ctx.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("logs each request that changes something, and not a quick read", async () => {
  const { project } = await api.createProject({ name: "Logged" });
  await api.project(project.id);
  const http = lines.filter(line => line.startsWith("[http]"));
  expect(http).toHaveLength(1);
  expect(http[0]).toMatch(/^\[http\] POST \/api\/projects → 20\d in \d+ms$/);
});

it("logs a request that failed with the engine's reason, and repeats of it once", async () => {
  for (let i = 0; i < 3; i++) await api.project("prj_missing").catch(() => {});
  const http = lines.filter(line => line.startsWith("[http]"));
  expect(http).toHaveLength(1);
  expect(http[0]).toMatch(/^\[http\] GET \/api\/projects\/prj_missing → 404 in \d+ms: not_found: /);
});

it("logs an edit, a render and the working edit only when their state changes", () => {
  const bus = new EventEmitter();
  const said: string[] = [];
  logStateChanges({ bus, log: (line: string) => said.push(line) } as unknown as Ctx);
  const publish = (event: unknown) => bus.emit("ws", event as WsEvent);
  const change = { id: "chg_1", projectId: "prj_1", state: "ready", fromVersion: "v1", toVersion: "v2", taskId: "tsk_1",
    description: "Cut the false start", ranges: [{ start: 1, end: 2 }] };
  publish({ type: "change.updated", projectId: "prj_1", change });
  publish({ type: "change.updated", projectId: "prj_1", change });
  publish({ type: "change.updated", projectId: "prj_1", change: { ...change, state: "approved", appliedVersion: "v3", autoApplied: true } });
  publish({ type: "project.updated", projectId: "prj_1", project: { id: "prj_1", head: "v1" } });
  publish({ type: "project.updated", projectId: "prj_1", project: { id: "prj_1", head: "v3" } });
  const render = { id: "rnd_1", projectId: "prj_1", version: "v3", kind: "playback", quality: "preview", range: { start: 4, end: 8 } };
  publish({ type: "render.updated", projectId: "prj_1", render: { ...render, state: "running" } });
  publish({ type: "render.updated", projectId: "prj_1", render: { ...render, state: "failed", error: "ffmpeg exited with code 1" } });
  expect(said).toEqual([
    '[edit] chg_1 ready in prj_1, v1 → v2, from tsk_1, 1 place',
    '[edit] chg_1 ready → approved (applied by Scarlet) in prj_1, v1 → v3, from tsk_1, 1 place',
    "[project] prj_1 working edit v1 → v3",
    expect.stringMatching(/^\[render\] rnd_1 failed after \d+ms: playback preview 4\.00–8\.00 s of v3 in prj_1: ffmpeg exited with code 1$/),
  ]);
});

const http = () => lines.filter(line => line.startsWith("[http]"));
function request(method: string, path: string, body?: string, init: RequestInit = {}) {
  return workspace.app.request("/api" + path, { method, body, ...init,
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
}

it("answers a body that isn't JSON with 400 and says so in the log, without the body", async () => {
  const res = await request("POST", "/projects", "{\"name\": \"Unfinished secret");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: { code: "bad_json", message: "request body is not valid JSON" } });
  expect(lines).toEqual([expect.stringMatching(/^\[http\] POST \/api\/projects → 400 in \d+ms: bad_json: request body is not valid JSON$/)]);
});

it("logs where a request failed validation, and never the value that was sent", async () => {
  const res = await request("PATCH", "/settings", JSON.stringify({ transcription: { provider: "whatever I typed" }, render: { concurrency: "many" } }));
  expect(res.status).toBe(400);
  const { error } = await res.json() as { error: { code: string; details: Array<{ path: string[] }> } };
  expect(error.code).toBe("validation_error");
  expect(error.details.length).toBeGreaterThan(1);
  const first = error.details[0]!.path.join(".");
  expect(http()).toEqual([expect.stringMatching(new RegExp(
    `^\\[http\\] PATCH /api/settings → 400 in \\d+ms: validation_error: request validation failed at ${first.replace(".", "\\.")} \\(\\w+\\), and ${error.details.length - 1} more$`))]);
  expect(lines.join("\n")).not.toContain("whatever I typed");
});

it("answers an engine fault with 500 and writes where it threw to the log", async () => {
  vi.spyOn(workspace.ctx.repos.projects, "insert").mockImplementationOnce(function brokenInsert() { throw new Error("disk I/O error"); });
  const res = await request("POST", "/projects", JSON.stringify({ name: "Unsaved" }));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: { code: "internal_error", message: "disk I/O error" } });
  expect(lines).toEqual([
    expect.stringMatching(/^\[error\] POST \/api\/projects: Error: disk I\/O error\n\s+at .*brokenInsert/),
    expect.stringMatching(/^\[http\] POST \/api\/projects → 500 in \d+ms: internal_error: disk I\/O error$/),
  ]);
  // A fault with nothing to say still gets an answer a client can show.
  vi.spyOn(workspace.ctx.repos.projects, "insert").mockImplementationOnce(() => { throw new Error(""); });
  expect((await (await request("POST", "/projects", JSON.stringify({ name: "Unsaved" }))).json()).error.message).toBe("internal error");
});

// 2026-11-09: the app's log held 15 "[error] … AbortError: aborted" lines with stack traces and as many 500s, each a
// frame preview or a render request the window had simply stopped waiting for.
it("answers work its caller cancelled with 499, and doesn't log it as an engine fault", async () => {
  const { project } = await api.createProject({ name: "Cancelled" });
  lines.length = 0;
  const caller = new AbortController();
  // The frame is being decoded when the caller goes away, which aborts the decode.
  vi.spyOn(workspace.ctx.render, "extractFrame").mockImplementationOnce(async (_file, _at, opts) => {
    caller.abort();
    opts!.signal!.throwIfAborted();
    return Buffer.alloc(0);
  });
  const res = await request("POST", `/projects/${project.id}/media/import-frame`, JSON.stringify({ path: import.meta.filename }), { signal: caller.signal });
  expect(res.status).toBe(499);
  expect(lines).toEqual([expect.stringMatching(/^\[http\] POST \/api\/projects\/prj_\w+\/media\/import-frame → 499 in \d+ms; the caller had already disconnected$/)]);
  // A fault that only happens to follow a disconnect is still a fault.
  vi.spyOn(workspace.ctx.render, "extractFrame").mockImplementationOnce(async function brokenDecode() { throw new Error("no decoder"); });
  expect((await request("POST", `/projects/${project.id}/media/import-frame`, JSON.stringify({ path: import.meta.filename }), { signal: AbortSignal.abort() })).status).toBe(500);
  expect(lines.some(line => /^\[error\] POST .*import-frame: Error: no decoder/.test(line))).toBe(true);
});

it("counts repeats of a failing request into the next line it writes for it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let i = 0; i < 4; i++) await request("GET", "/projects/prj_gone");
  expect(http()).toHaveLength(1);
  // Ten seconds on, the same request is logged again with the three that weren't.
  vi.setSystemTime(Date.now() + 10_000);
  await request("GET", "/projects/prj_gone");
  await request("GET", "/projects/prj_gone");
  expect(http().slice(1)).toEqual([expect.stringMatching(/^\[http\] GET \/api\/projects\/prj_gone → 404 in \d+ms \(and 3 more like it\): not_found: /)]);
  // A different answer to the same request is its own line.
  expect((await workspace.app.request("/api/projects/prj_gone")).status).toBe(401);
  expect(http().at(-1)).toMatch(/→ 401 in \d+ms: unauthorized: missing bearer token$/);
});

it("logs a request that held its caller for half a minute, and whether the caller had gone", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { project } = await api.createProject({ name: "Slow" });
  lines.length = 0;
  // The time passes inside the request, as it does while media work holds it.
  const read = workspace.ctx.repos.projects.get.bind(workspace.ctx.repos.projects);
  const held = (ms: number) => vi.spyOn(workspace.ctx.repos.projects, "get").mockImplementationOnce(id => { vi.setSystemTime(Date.now() + ms); return read(id); });
  held(31_000);
  expect((await request("GET", `/projects/${project.id}`)).status).toBe(200);
  held(45_000);
  await request("GET", `/projects/${project.id}`, undefined, { signal: AbortSignal.abort() });
  // A long poll asks to wait, so it is a slow read like any other and not a held request.
  held(31_000);
  await request("GET", `/projects/${project.id}?wait=30`);
  // A read that took over a second is logged even though it worked.
  held(1500);
  await request("GET", `/projects/${project.id}`);
  held(200);
  await request("GET", `/projects/${project.id}`);
  expect(lines).toEqual([
    `[http] slow request: GET /api/projects/${project.id} → 200 after 31s`,
    `[http] slow request: GET /api/projects/${project.id} → 200 after 45s; the caller had already disconnected`,
    `[http] GET /api/projects/${project.id} → 200 in 31s`,
    `[http] GET /api/projects/${project.id} → 200 in 1s`,
  ]);
});

/** A log listening to a bus of its own, and a way to publish to it. */
function listening() {
  const bus = new EventEmitter();
  const said: string[] = [];
  const stop = logStateChanges({ bus, log: (line: string) => said.push(line) } as unknown as Ctx);
  return { said, stop, publish: (event: unknown) => bus.emit("ws", event as WsEvent) };
}

it("logs footage becoming ready or failing with its reason, and not progress or a change of preview", () => {
  const { said, publish } = listening();
  const media = { id: "med_1", name: "Interview   A-cam.mov" };
  const update = (extra: object) => publish({ type: "media.updated", projectId: "prj_1", media: { ...media, ...extra } });
  update({ status: "ingesting" });
  update({ status: "ingesting", preparation: { stage: "fingerprint", fraction: 0.5 } });
  update({ status: "ready" });
  // The same state with another way of previewing it is not a change of state.
  update({ status: "ready", previewMode: "on-demand" });
  update({ status: "failed", error: "ffprobe could not read the file:\n moov atom not found" });
  update({ status: "failed" });
  // Media saved before it had a status is ready.
  publish({ type: "media.updated", projectId: "prj_1", media: { id: "med_old", name: "Old" } });
  publish({ type: "media.updated", projectId: "prj_1", media: { id: "med_bad", name: "Bad", status: "failed" } });
  expect(said).toEqual([
    '[media] med_1 ingesting in prj_1: "Interview A-cam.mov"',
    '[media] med_1 ingesting → ready in prj_1: "Interview A-cam.mov"',
    '[media] med_1 ready → failed in prj_1: "Interview A-cam.mov": ffprobe could not read the file: moov atom not found',
    '[media] med_old ready in prj_1: "Old"',
    '[media] med_bad failed in prj_1: "Bad": no reason given',
  ]);
});

it("logs each entry of the history, and media processing pausing and resuming", () => {
  const { said, publish } = listening();
  const entry = { type: "change.approved", actor: { type: "human", name: "Matt" }, summary: "Matt approved   “Cut the false start”" };
  publish({ type: "activity.added", projectId: "prj_1", entry: { ...entry, projectId: "prj_1" } });
  publish({ type: "activity.added", projectId: null, entry: { ...entry, type: "skill.deleted", projectId: null, summary: "x".repeat(200) } });
  const project = (extra: object) => publish({ type: "project.updated", projectId: "prj_1", project: { id: "prj_1", head: "v1", ...extra } });
  // The first sight of a project is where it stands, not a change.
  project({});
  project({ mediaPaused: true });
  project({ mediaPaused: true, name: "Renamed" });
  project({ mediaPaused: false });
  project({ head: null });
  expect(said).toEqual([
    "[activity] change.approved in prj_1",
    "[activity] skill.deleted",
    "[project] prj_1 media processing paused",
    "[project] prj_1 media processing resumed",
    "[project] prj_1 working edit v1 → none",
  ]);
});

it("logs how each render ended: done, cancelled, failed, or already on disk", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { said, publish } = listening();
  const render = (id: string, state: string, extra: object = {}) =>
    publish({ type: "render.updated", projectId: "prj_1", render: { id, projectId: "prj_1", version: "v3", kind: "full", state, ...extra } });
  render("rnd_1", "queued", { quality: "delivery" });
  vi.setSystemTime(Date.now() + 2000);
  render("rnd_1", "running", { quality: "delivery" });
  render("rnd_1", "running", { quality: "delivery", progress: 0.5 });
  vi.setSystemTime(Date.now() + 62_000);
  render("rnd_1", "done", { quality: "delivery" });
  // Its time runs from when it was queued, and the same end isn't logged twice.
  render("rnd_1", "done", { quality: "delivery" });
  render("rnd_2", "queued");
  render("rnd_2", "cancelled");
  // A request answered by a file made earlier never ran.
  render("rnd_3", "done", { kind: "segment", quality: "preview", range: { start: 1, end: 2.5 } });
  // A playback section says nothing when it starts.
  render("rnd_4", "running", { kind: "playback" });
  render("rnd_4", "failed", { kind: "playback" });
  // One first seen as it ends, with no start to measure from.
  render("rnd_5", "cancelled");
  expect(said).toEqual([
    "[render] rnd_1 started: full delivery of v3 in prj_1",
    "[render] rnd_1 done after 1m 4s: full delivery of v3 in prj_1",
    "[render] rnd_2 cancelled after 0ms: full of v3 in prj_1",
    "[render] rnd_3 done from a saved file: segment preview 1.00–2.50 s of v3 in prj_1",
    "[render] rnd_4 failed after 0ms: playback of v3 in prj_1: no reason given",
    "[render] rnd_5 cancelled: full of v3 in prj_1",
  ]);
});

it("records edit states and versions without logging editorial descriptions or rejection reasons", () => {
  const { said, publish } = listening();
  const change = { id: "chg_1", projectId: "prj_1", state: "ready", fromVersion: "v1", toVersion: "v2", description: "Tighten", ranges: [{ start: 1, end: 2 }, { start: 4, end: 5 }] };
  const update = (extra: object) => publish({ type: "change.updated", projectId: "prj_1", change: { ...change, ...extra } });
  update({});
  update({ toVersion: "v2b" });
  update({ toVersion: "v2b", state: "rejected", rejectReason: "Too tight" });
  update({ toVersion: "v2b", state: "rejected" });
  update({ id: "chg_2", state: "failed", error: "render failed" });
  update({ id: "chg_3", state: "failed" });
  update({ id: "chg_4", state: "rejected" });
  expect(said).toEqual([
    '[edit] chg_1 ready in prj_1, v1 → v2, 2 places',
    '[edit] chg_1 ready, new version in prj_1, v1 → v2b, 2 places',
    '[edit] chg_1 ready → rejected in prj_1, v1 → v2b, 2 places',
    '[edit] chg_2 failed in prj_1, v1 → v2, 2 places',
    '[edit] chg_3 failed in prj_1, v1 → v2, 2 places',
    '[edit] chg_4 rejected in prj_1, v1 → v2, 2 places',
  ]);
});

it("remembers the last 4000 things it logged about, and no more", () => {
  const { said, publish } = listening();
  const media = (n: number) => publish({ type: "media.updated", projectId: "prj_1", media: { id: `med_${n}`, name: "Clip", status: "ready" } });
  for (let n = 0; n <= 4000; n++) media(n);
  expect(said).toHaveLength(4001);
  // The newest are remembered, so saying the same again writes nothing. The oldest was let go, and reads as new.
  media(4000);
  media(1);
  expect(said).toHaveLength(4001);
  media(0);
  expect(said.at(-1)).toBe('[media] med_0 ready in prj_1: "Clip"');
});

it("writes that it couldn't describe an event instead of breaking what announced it, and stops when told to", () => {
  const { said, publish, stop } = listening();
  // An event without the part the line is built from.
  expect(() => publish({ type: "change.updated", projectId: "prj_1" })).not.toThrow();
  expect(said).toEqual([expect.stringMatching(/^\[log\] couldn’t describe change\.updated: .+/)]);
  // Events the log has no line for are left alone.
  publish({ type: "task.updated", projectId: "prj_1", task: { id: "tsk_1" } });
  publish({ type: "render.settings.updated" });
  expect(said).toHaveLength(1);
  stop();
  publish({ type: "media.updated", projectId: "prj_1", media: { id: "med_1", name: "After", status: "ready" } });
  expect(said).toHaveLength(1);
});
