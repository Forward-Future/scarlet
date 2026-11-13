import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";

interface SentEvent {
  event: string;
  properties: Record<string, unknown>;
}

interface Batch {
  api_key: string;
  batch: SentEvent[];
}

interface Booted {
  app: ScarletApp;
  dataDir: string;
  /** Every request the engine made to the ingest host. */
  requests: Batch[];
  events(name?: string): SentEvent[];
  api<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

const booted: Booted[] = [];

afterEach(async () => {
  for (const engine of booted.splice(0)) {
    await engine.close();
    rmSync(engine.dataDir, { recursive: true, force: true });
  }
});

function boot(options: { env?: NodeJS.ProcessEnv; key?: string } = {}): Booted {
  const dataDir = mkdtempSync(join(tmpdir(), "scarlet-telemetry-app-"));
  const requests: Batch[] = [];
  const fakeFetch = async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    requests.push(JSON.parse(String(init!.body)) as Batch);
    return new Response(null, { status: 200 });
  };
  const app = createApp({
    dataDir,
    skillsSeedDir: join(dataDir, "empty-seed"),
    env: options.env ?? {},
    log: () => {},
    telemetry: { posthogKey: options.key, fetch: fakeFetch as typeof fetch },
  });
  let closed = false;
  const engine: Booted = {
    app,
    dataDir,
    requests,
    events: name => requests.flatMap(request => request.batch).filter(event => name === undefined || event.event === name),
    async api<T>(method: string, path: string, body?: unknown, token = accessToken(app.ctx)) {
      const headers = new Headers({ Authorization: `Bearer ${token}` });
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const res = await app.app.request("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => undefined) as T };
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.ctx.close();
    },
  };
  booted.push(engine);
  return engine;
}

it("reports that the engine started", async () => {
  const engine = boot({ key: "phc_test" });
  expect(engine.app.ctx.telemetry.active).toBe(true);
  await engine.app.ctx.telemetry.flush();

  expect(engine.requests[0]!.api_key).toBe("phc_test");
  expect(engine.events()).toEqual([
    { event: "server.boot.heartbeat", properties: expect.objectContaining({ projectCount: 0 }) },
  ].map(event => expect.objectContaining(event)));
  expect(existsSync(join(engine.dataDir, "telemetry-id"))).toBe(true);
});

it("counts a listed request once it succeeds, and nothing else", async () => {
  const engine = boot({ key: "phc_test" });
  expect((await engine.api("POST", "/projects", { name: "" })).status).toBeGreaterThanOrEqual(400);
  expect((await engine.api("POST", "/projects", { name: "Secret film" }, "wrong-token")).status).toBe(401);
  expect((await engine.api("GET", "/projects")).status).toBe(200);
  expect((await engine.api("POST", "/projects", { name: "Secret film" })).status).toBeLessThan(300);
  await engine.app.ctx.telemetry.flush();

  expect(engine.events("feature.used").map(event => event.properties.feature)).toEqual(["project.create"]);
});

it("reports a request from start to finish without what it says", async () => {
  const engine = boot({ key: "phc_test" });
  const { project } = (await engine.api<{ project: { id: string } }>("POST", "/projects", { name: "Secret film" })).body;
  const queued = await engine.api<{ task: Task }>("POST", `/projects/${project.id}/tasks`, {
    kind: "edit",
    agent: "codex",
    instruction: "Cut the secret scene",
  });
  expect(queued.status).toBeLessThan(300);
  const { task } = queued.body;
  expect((await engine.api("POST", `/tasks/${task.id}/cancel`)).status).toBeLessThan(300);
  await engine.app.ctx.telemetry.flush();

  expect(engine.events("task.requested").map(event => event.properties)).toEqual([
    expect.objectContaining({ kind: "edit", agent: "codex", fast: false }),
  ]);
  expect(engine.events("task.finished").map(event => event.properties)).toEqual([
    expect.objectContaining({
      kind: "edit",
      agent: "codex",
      state: "cancelled",
      changeCount: 0,
      interrupted: false,
      durationMs: expect.any(Number),
    }),
  ]);
  expect(engine.events("feature.used").map(event => event.properties.feature)).toEqual(["project.create", "task.cancel"]);

  const everything = JSON.stringify(engine.requests);
  for (const secret of ["Secret film", "Cut the secret scene", project.id, task.id]) expect(everything).not.toContain(secret);
});

it("sends only the decision and a stable installation-specific code for each reviewed edit", async () => {
  const first = boot({ key: "phc_test" });
  const second = boot({ key: "phc_test" });
  const disabled = boot({ key: "phc_test", env: { SCARLET_TELEMETRY_ENABLED: "false" } });
  const project = "prj_private";
  const change = "chg_private";
  const path = `/projects/${project}/edit-reviews`;
  const keep = { changeId: change, spot: 0, decision: "keep" };
  for (const engine of [first, second, disabled]) {
    engine.app.ctx.db.prepare("INSERT INTO changes (id, project_id, state, json, created_at) VALUES (?, ?, 'approved', '{}', ?)").run(change, project, new Date().toISOString());
    expect((await engine.api("POST", path, keep)).status).toBe(204);
  }
  for (const decision of ["revise", "undo"]) expect((await first.api("POST", path, { ...keep, decision })).status).toBe(204);
  expect((await first.api("POST", path, { ...keep, spot: 1 })).status).toBe(204);
  expect((await first.api("POST", path, { ...keep, text: "private words" })).status).toBe(400);
  expect((await first.api("POST", path, { ...keep, decision: "private words" })).status).toBe(400);
  expect((await first.api("POST", path, { ...keep, changeId: "wrong" })).status).toBe(404);
  await Promise.all([first, second, disabled].map(engine => engine.app.ctx.telemetry.flush()));
  const events = first.events("edit.reviewed");
  expect(events.map(e => e.properties.decision)).toEqual(["keep", "revise", "undo", "keep"]);
  const ids = events.map(e => e.properties.editId);
  expect(ids[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(ids.slice(1, 3)).toEqual([ids[0], ids[0]]);
  expect(ids[3]).not.toBe(ids[0]);
  expect(second.events("edit.reviewed")[0]!.properties.editId).not.toBe(ids[0]);
  const common = Object.keys(first.events("server.boot.heartbeat")[0]!.properties).filter(k => k !== "projectCount");
  expect(Object.keys(events[0]!.properties).sort()).toEqual([...common, "editId", "decision"].sort());
  for (const privateValue of [project, change, "private words"]) expect(JSON.stringify(first.requests)).not.toContain(privateValue);
  expect(disabled.requests).toEqual([]);
});

it("sends what is queued when the engine closes", async () => {
  const engine = boot({ key: "phc_test" });
  await engine.api("POST", "/projects", { name: "Secret film" });
  expect(engine.requests).toEqual([]);
  await engine.close();

  expect(engine.events().map(event => event.event)).toEqual(["server.boot.heartbeat", "feature.used"]);
});

it("sends nothing and keeps no id without a project key", async () => {
  const engine = boot();
  expect(engine.app.ctx.telemetry.active).toBe(false);
  await engine.api("POST", "/projects", { name: "Secret film" });
  await engine.close();

  expect(engine.requests).toEqual([]);
  expect(existsSync(join(engine.dataDir, "telemetry-id"))).toBe(false);
});

it("sends nothing when turned off", async () => {
  const engine = boot({ key: "phc_test", env: { SCARLET_TELEMETRY_ENABLED: "false" } });
  expect(engine.app.ctx.telemetry.active).toBe(false);
  await engine.api("POST", "/projects", { name: "Secret film" });
  await engine.close();

  expect(engine.requests).toEqual([]);
  expect(existsSync(join(engine.dataDir, "telemetry-id"))).toBe(false);
});

it("reports to the project key in the environment", async () => {
  const engine = boot({ env: { SCARLET_POSTHOG_KEY: "phc_env" } });
  await engine.app.ctx.telemetry.flush();

  expect(engine.requests.map(request => request.api_key)).toEqual(["phc_env"]);
});
