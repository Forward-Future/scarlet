import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ScarletApiError, ScarletClient, type WsEvent } from "@scarlet/shared";
import { accessToken } from "./auth.js";
import { createApp, type ScarletApp } from "./app.js";
import { removeTrashed } from "./services/trash.js";

let dir: string, workspace: ScarletApp, api: ScarletClient;
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-usage-"));
  workspace = createApp({ dataDir: dir, env: {}, log: () => {} });
  const fetch: typeof globalThis.fetch = (input, init) => Promise.resolve(workspace.app.request(input, init));
  api = new ScarletClient({ baseUrl: "https://fixture.test", token: accessToken(workspace.ctx), fetch });
});

afterAll(async () => {
  await workspace?.ctx.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A claim of the task starting at `at`, as a host's claim starts one. Tokens are reported for a claim. */
function claimAt(taskId: string, at = new Date().toISOString()): string {
  workspace.ctx.repos.tasks.put({ ...workspace.ctx.repos.tasks.get(taskId)!, startedAt: at });
  return at;
}

it("records each run and totals an edit with its follow-ups, by agent and across projects", async () => {
  const project = (await api.createProject({ name: "Usage" })).project.id;
  const other = (await api.createProject({ name: "Other" })).project.id;
  const { task: edit } = await api.createTask(project, { instruction: "First cut", kind: "edit", agent: "claude", model: "opus" });
  const { task: followUp } = await api.createTask(project, { instruction: "Tighten it", kind: "edit", agent: "codex", context: { threadId: edit.id } });
  const { task: elsewhere } = await api.createTask(other, { instruction: "Captions", kind: "edit", agent: "gemini" });

  // The first run paused for a question; the resumed run is a second report for the same task.
  await api.recordTaskUsage(edit.id, { inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50, startedAt: claimAt(edit.id, "2026-11-05T10:00:00.000Z") });
  await api.recordTaskUsage(edit.id, { inputTokens: 5, outputTokens: 20, startedAt: claimAt(edit.id, "2026-11-05T10:05:00.000Z") });
  // A lost response is retried with the same claim and replaces the first report.
  await api.recordTaskUsage(edit.id, { inputTokens: 5, outputTokens: 30, startedAt: "2026-11-05T10:05:00.000Z" });
  await api.recordTaskUsage(followUp.id, { model: "gpt-5.5-codex", inputTokens: 200, outputTokens: 40, cacheReadTokens: 800, reasoningTokens: 15, startedAt: claimAt(followUp.id) });
  await api.recordTaskUsage(elsewhere.id, { inputTokens: 7, outputTokens: 3, startedAt: claimAt(elsewhere.id) });

  const byThread = await api.projectUsage(project);
  expect(byThread.by).toBe("thread");
  expect(byThread.total).toMatchObject({
    runs: 3, inputTokens: 215, outputTokens: 170, cacheReadTokens: 1800, cacheWriteTokens: 50, reasoningTokens: 15,
    totalTokens: 2235,
  });
  expect(byThread.total).not.toHaveProperty("costUsd");
  expect(byThread.groups).toEqual([expect.objectContaining({ key: edit.id, runs: 3, totalTokens: 2235 })]);

  const byAgent = await api.projectUsage(project, "agent");
  expect(Object.fromEntries(byAgent.groups.map(g => [g.key, g.totalTokens]))).toEqual({ claude: 1195, codex: 1040 });
  const byModel = await api.projectUsage(project, "model");
  expect(byModel.groups.map(g => g.key).sort()).toEqual(["gpt-5.5-codex", "opus"]);

  const all = await api.usage();
  expect(Object.fromEntries(all.groups.map(g => [g.key, g.totalTokens]))).toEqual({ [project]: 2235, [other]: 10 });
  expect((await api.usage("day")).groups).toEqual([expect.objectContaining({ key: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), runs: 4 })]);
});

it("prices each run at its model's API rates and tells open windows the new totals", async () => {
  const project = (await api.createProject({ name: "Live" })).project.id;
  const { task } = await api.createTask(project, { instruction: "x", kind: "edit", agent: "codex" });
  const seen: WsEvent[] = [];
  const listen = (event: WsEvent) => void seen.push(event);
  workspace.ctx.bus.on("ws", listen);
  try {
    await api.recordTaskUsage(task.id, { model: "gpt-5.4", inputTokens: 10, outputTokens: 5, reasoningTokens: 2,
      startedAt: claimAt(task.id, "2026-11-05T10:00:00.000Z") });
    await api.recordTaskUsage(task.id, { model: "gpt-6.1-sol", inputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 20,
      startedAt: claimAt(task.id, "2026-11-05T10:05:00.000Z") });
    await api.recordTaskUsage(task.id, { inputTokens: 1, cacheReadTokens: 200, cacheWriteTokens: 20,
      startedAt: "2026-11-05T10:05:00.000Z" });
    expect((await api.projectUsage(project, "task")).groups).toEqual([
      expect.objectContaining({ key: task.id, totalTokens: 236, models: ["gpt-5.4", "gpt-6.1-sol"], estimatedApiCostUsd: expect.closeTo(0.000172, 12) }),
    ]);
    await api.recordTaskUsage(task.id, { model: "halo-alpha", outputTokens: 1, startedAt: claimAt(task.id, "2026-11-05T10:06:00.000Z") });
  } finally {
    workspace.ctx.bus.off("ws", listen);
  }
  const updates = seen.filter(e => e.type === "task.usage");
  expect(updates.map(e => [e.projectId, e.taskId, e.usage.runs, e.usage.totalTokens, e.usage.models, e.usage.estimatedApiCostUsd])).toEqual([
    [project, task.id, 1, 15, ["gpt-5.4"], expect.closeTo(0.0001, 12)],
    [project, task.id, 2, 136, ["gpt-5.4", "gpt-6.1-sol"], expect.closeTo(0.000162, 12)],
    [project, task.id, 2, 236, ["gpt-5.4", "gpt-6.1-sol"], expect.closeTo(0.000172, 12)],
    [project, task.id, 3, 237, ["gpt-5.4", "gpt-6.1-sol", "halo-alpha"], null],
  ]);
  expect((await api.projectUsage(project, "task")).groups).toEqual([
    expect.objectContaining({ key: task.id, totalTokens: 237, estimatedApiCostUsd: null, unpricedModels: ["halo-alpha"] }),
  ]);
});

it("prices a run at the speed its edit was asked at, and names a speed it has no price for", async () => {
  const project = (await api.createProject({ name: "Speeds" })).project.id;
  const fast = (await api.createTask(project, { instruction: "x", kind: "edit", agent: "codex", model: "gpt-6.2-sol", serviceTier: "priority" })).task;
  const ultra = (await api.createTask(project, { instruction: "x", kind: "edit", agent: "codex", model: "gpt-6.2-sol", serviceTier: "warp" })).task;
  for (const task of [fast, ultra]) await api.recordTaskUsage(task.id, { model: "gpt-6.2-sol", inputTokens: 1_000_000, outputTokens: 1_000_000, startedAt: claimAt(task.id) });
  const groups = Object.fromEntries((await api.projectUsage(project, "task")).groups.map(g => [g.key, g]));
  expect(groups[fast.id]).toMatchObject({ estimatedApiCostUsd: expect.closeTo(24, 9) });
  expect(groups[fast.id]?.unpricedModels).toBeUndefined();
  expect(groups[ultra.id]).toMatchObject({ estimatedApiCostUsd: null, unpricedModels: ["gpt-6.2-sol at warp speed"] });
});

it("rejects bad counts, unknown tasks and unknown groupings, and is empty for a new project", async () => {
  const project = (await api.createProject({ name: "Empty" })).project.id;
  expect((await api.projectUsage(project)).total).toMatchObject({ ...zero, runs: 0, totalTokens: 0, firstAt: null });
  const { task } = await api.createTask(project, { instruction: "x", kind: "edit", agent: "claude" });
  await expect(api.recordTaskUsage(task.id, { inputTokens: -1 })).rejects.toBeInstanceOf(ScarletApiError);
  await expect(api.recordTaskUsage(task.id, { inputTokens: 1.5 })).rejects.toBeInstanceOf(ScarletApiError);
  await expect(api.recordTaskUsage("task_missing", { inputTokens: 1 })).rejects.toMatchObject({ status: 404 });
  await expect(api.usage("week" as never)).rejects.toMatchObject({ status: 400 });
});

it("keeps a claim's largest total, so a late snapshot can't undo the final one, and takes tokens only for a claim of the task", async () => {
  const project = (await api.createProject({ name: "Late" })).project.id;
  const { task } = await api.createTask(project, { instruction: "x", kind: "edit", agent: "codex" });
  const first = claimAt(task.id, "2026-11-05T10:00:00.000Z");
  // The final total, then a live snapshot of the same claim that was still on its way.
  await api.recordTaskUsage(task.id, { inputTokens: 50, outputTokens: 20, cacheReadTokens: 4000, startedAt: first });
  await api.recordTaskUsage(task.id, { inputTokens: 30, outputTokens: 5, cacheReadTokens: 1000, startedAt: first });
  expect((await api.projectUsage(project)).total).toMatchObject({ runs: 1, totalTokens: 4070 });
  // The next claim's tokens are its own; the earlier claim can still finish reporting once it's over.
  const second = claimAt(task.id, "2026-11-05T10:05:00.000Z");
  await api.recordTaskUsage(task.id, { inputTokens: 1, startedAt: second });
  await api.recordTaskUsage(task.id, { inputTokens: 60, outputTokens: 20, cacheReadTokens: 4000, startedAt: first });
  expect((await api.projectUsage(project)).total).toMatchObject({ runs: 2, totalTokens: 4081 });
  // A report must say which claim it is: without one, each snapshot was counted as a run of its own.
  await expect(api.recordTaskUsage(task.id, { inputTokens: 9 })).rejects.toMatchObject({ status: 400 });
  await expect(api.recordTaskUsage(task.id, { inputTokens: 9, startedAt: "2026-11-05T09:00:00.000Z" })).rejects.toMatchObject({ status: 409 });
  expect((await api.projectUsage(project)).total).toMatchObject({ runs: 2, totalTokens: 4081 });
});

it("still records a cancelled run, and removes usage with its project from the trash", async () => {
  const project = (await api.createProject({ name: "Trashed" })).project.id;
  const { task } = await api.createTask(project, { instruction: "x", kind: "edit", agent: "claude" });
  const startedAt = claimAt(task.id);
  await api.cancelTask(task.id);
  await api.recordTaskUsage(task.id, { inputTokens: 4, outputTokens: 2, startedAt });
  expect((await api.projectUsage(project)).total.runs).toBe(1);

  await api.deleteProject(project);
  const trashed = workspace.ctx.repos.projects.listDeleted().filter(p => p.id === project);
  removeTrashed(workspace.ctx, trashed);
  expect(workspace.ctx.db.prepare("SELECT count(*) AS n FROM task_usage WHERE project_id = ?").get(project)).toEqual({ n: 0 });
});
