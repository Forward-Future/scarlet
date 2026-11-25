import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { WsEvent } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";

let dataDir: string;
let app: ScarletApp;
let told: WsEvent[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "scarlet-hosts-"));
  app = createApp({ dataDir, skillsSeedDir: join(dataDir, "none"), env: {}, log: () => {} });
  told = [];
  app.ctx.bus.on("ws", event => { if (event.type === "host.updated") told.push(event); });
});
afterEach(async () => {
  await app.ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await app.app.request(`/api${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken(app.ctx)}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  expect(res.status).toBeLessThan(300);
  return res.json() as Promise<T>;
}

it("tells the window of a heartbeat only when the host's assistants change or it comes back online", async () => {
  const agents = [{ id: "claude", installed: true }];
  const { host } = await post<{ host: { id: string } }>("/hosts/register", { name: "Mac", platform: "darwin", agents });
  expect(told).toHaveLength(1);

  // The same assistants, still online: saved, and nothing sent.
  await post(`/hosts/${host.id}/heartbeat`, { agents, running: [] });
  await post(`/hosts/${host.id}/heartbeat`, { running: [] });
  expect(told).toHaveLength(1);
  expect(Date.now() - Date.parse(app.ctx.repos.hosts.get(host.id)!.lastSeenAt!)).toBeLessThan(5_000);

  // A new model list is something the window shows.
  await post(`/hosts/${host.id}/heartbeat`, { agents: [{ id: "claude", installed: true, models: ["sonnet"] }], running: [] });
  expect(told).toHaveLength(2);

  // A host silent long enough to read as offline is announced as online again.
  const saved = app.ctx.repos.hosts.get(host.id)!;
  app.ctx.repos.hosts.put({ ...saved, lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  await post(`/hosts/${host.id}/heartbeat`, { running: [] });
  expect(told).toHaveLength(3);
  expect(told.at(-1)).toMatchObject({ host: { id: host.id, online: true } });
});
