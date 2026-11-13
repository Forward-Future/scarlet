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

it("records each run and totals an edit with its follow-ups, by agent and across projects", async () => {
  const project = (await api.createProject({ name: "Usage" })).project.id;
  const other = (await api.createProject({ name: "Other" })).project.id;
  const { task: edit } = await api.createTask(project, { instruction: "First cut", kind: "edit", agent: "claude", model: "opus" });
  const { task: followUp } = await api.createTask(project, { instruction: "Tighten it", kind: "edit", agent: "codex", context: { threadId: edit.id } });
  const { task: elsewhere } = await api.createTask(other, { instruction: "Captions", kind: "edit", agent: "gemini" });

  // The first run paused for a question; the resumed run is a second report for the same task.
  await api.recordTaskUsage(edit.id, { inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50, startedAt: "2026-11-05T10:00:00.000Z" });
  await api.recordTaskUsage(edit.id, { inputTokens: 5, outputTokens: 20, startedAt: "2026-11-05T10:05:00.000Z" });
  // A lost response is retried with the same claim and replaces the first report.
  await api.recordTaskUsage(edit.id, { inputTokens: 5, outputTokens: 30, startedAt: "2026-11-05T10:05:00.000Z" });
  await api.recordTaskUsage(followUp.id, { model: "gpt-5.5-codex", inputTokens: 200, outputTokens: 40, cacheReadTokens: 800, reasoningTokens: 15 });
  await api.recordTaskUsage(elsewhere.id, { inputTokens: 7, outputTokens: 3 });

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

it("tells open windows the task's new totals after each run", async () => {
  const project = (await api.createProject({ name: "Live" })).project.id;
  const { task } = await api.createTask(project, { instruction: "x", kind: "edit", agent: "claude" });
  const seen: WsEvent[] = [];
  const listen = (event: WsEvent) => void seen.push(event);
  workspace.ctx.bus.on("ws", listen);
  try {
    await api.recordTaskUsage(task.id, { inputTokens: 10, outputTokens: 5, startedAt: "2026-11-05T10:00:00.000Z" });
    await api.recordTaskUsage(task.id, { inputTokens: 1, cacheReadTokens: 100, startedAt: "2026-11-05T10:05:00.000Z" });
  } finally {
    workspace.ctx.bus.off("ws", listen);
  }
  const updates = seen.filter(e => e.type === "task.usage");
  expect(updates.map(e => e.type === "task.usage" && [e.projectId, e.taskId, e.usage.runs, e.usage.totalTokens])).toEqual([
    [project, task.id, 1, 15],
    [project, task.id, 2, 116],
  ]);
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

it("still records a cancelled run, and removes usage with its project from the trash", async () => {
  const project = (await api.createProject({ name: "Trashed" })).project.id;
  const { task } = await api.createTask(project, { instruction: "x", kind: "edit", agent: "claude" });
  await api.cancelTask(task.id);
  await api.recordTaskUsage(task.id, { inputTokens: 4, outputTokens: 2 });
  expect((await api.projectUsage(project)).total.runs).toBe(1);

  await api.deleteProject(project);
  const trashed = workspace.ctx.repos.projects.listDeleted().filter(p => p.id === project);
  removeTrashed(workspace.ctx, trashed);
  expect(workspace.ctx.db.prepare("SELECT count(*) AS n FROM task_usage WHERE project_id = ?").get(project)).toEqual({ n: 0 });
});
