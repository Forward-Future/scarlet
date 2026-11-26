import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "@scarlet/timeline";
import type { BatchSummaryItem, WsEvent } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken, localUser } from "../auth.js";
import { proposeChange } from "./changes.js";
import { buildBatchSummaryPrompt, sanitizeBatchTitle, summarizeBatches } from "./batchSummaries.js";
import { completeTask } from "./tasks.js";
import { claimTask } from "./taskQueue.js";

const dirs: string[] = [];
const apps: ScarletApp[] = [];

function startApp(env: Record<string, string> = {}): ScarletApp {
  const dir = mkdtempSync(join(tmpdir(), "scarlet-batch-summary-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, skillsSeedDir: join(dir, "empty-seed"), env, log: () => {} });
  apps.push(app);
  return app;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.ctx.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sampleBatch(over: Partial<BatchSummaryItem> = {}): BatchSummaryItem {
  return {
    key: "bs_0123456789abcdef",
    kind: "cut",
    isDialoguePass: true,
    count: 110,
    removedSeconds: 252,
    request: "Do a full dialogue cleanup",
    breakdown: { pauses: 60, "false starts": 32, "filler words": 18 },
    samples: [
      { label: "Cut “I can only compare this…”", reason: "False start before second take" },
      { label: "Shortened a pause", reason: "Long silence between sentences" },
    ],
    ...over,
  };
}

describe("batchSummaries", () => {
  it("sanitizes model outputs and rejects empty, overly long, or refusal text", () => {
    expect(sanitizeBatchTitle('  "110 dialogue cuts: pauses & retakes."  ')).toBe("110 dialogue cuts: pauses & retakes");
    expect(sanitizeBatchTitle("- Title: 3 model title cards\nExtra explanation")).toBe("3 model title cards");
    expect(sanitizeBatchTitle("Sorry, I cannot summarize this batch.")).toBeUndefined();
    expect(sanitizeBatchTitle("Here is a title: 2 cuts")).toBeUndefined();
    expect(sanitizeBatchTitle("a".repeat(80))).toBeUndefined();
    expect(sanitizeBatchTitle("ok")).toBeUndefined();
  });

  it("summarizes via direct HTTP API, caches in SQLite, and broadcasts batch_summary.updated", async () => {
    const app = startApp({ ANTHROPIC_API_KEY: "test-key" });
    const project = app.ctx.repos.projects.insert(createProject("AI Summaries"));
    const events: WsEvent[] = [];
    const onWs = (ev: WsEvent) => { events.push(ev); };
    app.ctx.bus.on("ws", onWs);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "110 dialogue cuts: pauses & retakes" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const headers = { Authorization: `Bearer ${accessToken(app.ctx)}`, "Content-Type": "application/json" };
    const batch = sampleBatch();
    const res1 = await app.app.request(`/api/projects/${project.id}/batch-summaries`, {
      method: "POST",
      headers,
      body: JSON.stringify({ batches: [batch] }),
    });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({
      summaries: { [batch.key]: "110 dialogue cuts: pauses & retakes" },
      pending: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === "batch_summary.updated" && e.key === batch.key && e.title === "110 dialogue cuts: pauses & retakes")).toBe(true);

    // Second call hits SQLite cache without calling fetch again.
    const res2 = await summarizeBatches(app.ctx, project.id, [batch]);
    expect(res2).toEqual({
      summaries: { [batch.key]: "110 dialogue cuts: pauses & retakes" },
      pending: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    app.ctx.bus.off("ws", onWs);
  });

  it("falls back to a silent batch_summary side-check on an online CLI host when no direct API key is configured", async () => {
    const app = startApp({});
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Host Fallback"));
    const host = ctx.repos.hosts.put({
      id: "hst_local",
      userId: localUser(ctx).id,
      name: "Mac",
      platform: "darwin",
      online: true,
      agents: [{ id: "claude", installed: true, loggedIn: true, model: "claude-opus-4-6", models: ["claude-opus-4-6", "claude-haiku-4-5"] }],
      lastSeenAt: new Date().toISOString(),
    });
    const events: WsEvent[] = [];
    const onWs = (ev: WsEvent) => { events.push(ev); };
    ctx.bus.on("ws", onWs);

    const batch = sampleBatch({ key: "bs_host_1", isDialoguePass: false, kind: "graphic", count: 3, removedSeconds: undefined, breakdown: undefined, samples: [{ label: "Haiku 5.5 title" }, { label: "Sonnet 5.5 title" }, { label: "Hydrogen title" }] });
    const first = await summarizeBatches(ctx, project.id, [batch]);
    expect(first).toEqual({ summaries: {}, pending: [batch.key] });

    // Calling again while queued does not duplicate the task.
    const second = await summarizeBatches(ctx, project.id, [batch]);
    expect(second).toEqual({ summaries: {}, pending: [batch.key] });
    const queued = ctx.repos.tasks.select("project_id = ? AND kind = 'batch_summary'", [project.id]);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.model).toBe("claude-haiku-4-5");

    // Excluded from the project's conversation task list, and direct user POST is rejected.
    const headers = { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" };
    const listed = await (await app.app.request(`/api/projects/${project.id}/tasks`, { headers })).json() as { tasks: unknown[] };
    expect(listed.tasks).toEqual([]);
    const directPost = await app.app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "batch_summary", agent: "claude", instruction: "Summarize" }),
    });
    expect(directPost.status).toBe(400);

    // Claimed in side-check slot, prompt has no workspace tools, and completion caches + broadcasts the title.
    const claimed = claimTask(ctx, host, undefined, [], undefined, ["claude"]);
    expect(claimed?.id).toBe(queued[0]!.id);
    const promptRes = await (await app.app.request(`/api/tasks/${claimed!.id}/prompt`, { headers })).json() as { systemPrompt: string; workspace?: boolean };
    expect(promptRes.systemPrompt).toContain("grouped batch of video edits");
    expect(promptRes.workspace).toBeUndefined();

    completeTask(ctx, claimed!, { state: "done", summary: "3 model title cards" });
    expect(events.some(e => e.type === "batch_summary.updated" && e.key === batch.key && e.title === "3 model title cards")).toBe(true);

    const cached = await summarizeBatches(ctx, project.id, [batch]);
    expect(cached).toEqual({ summaries: { [batch.key]: "3 model title cards" }, pending: [] });
    ctx.bus.off("ws", onWs);
  });

  it("persists AI-authored batchTitle on saved changes", () => {
    const app = startApp({});
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Authored Title"));
    ctx.repos.projects.putMedia(project.id, { id: "m1", name: "clip.mp4", path: "clip.mp4", kind: "video", duration: 20, hasAudio: true }, "ready");
    const saved = proposeChange(ctx, localUser(ctx), project.id, {
      intent: "requested",
      autoApprove: true,
      description: "Added model title cards.",
      batchTitle: "3 model title cards",
      ops: [{ op: "addClip", trackId: "v1", clip: { id: "c1", kind: "media", mediaId: "m1", timelineIn: 0, sourceIn: 0, sourceOut: 10 } }],
    });
    expect(saved.change.batchTitle).toBe("3 model title cards");
    expect(ctx.repos.changes.get(saved.change.id)?.batchTitle).toBe("3 model title cards");
  });

  it("formats clear prompts for non-cut batch kinds (zooms, graphics, B-roll, music dips, general edits)", () => {
    const zoomPrompt = buildBatchSummaryPrompt(sampleBatch({
      key: "bs_zooms",
      kind: "zoom",
      isDialoguePass: false,
      count: 4,
      removedSeconds: undefined,
      breakdown: undefined,
      request: "Punch in on each demo screen",
      samples: [{ label: "Zoom on editor", reason: "Highlight code diff" }, { label: "Zoom on chart" }],
    }));
    expect(zoomPrompt).toContain("Batch: 4 zooms");
    expect(zoomPrompt).toContain('Editor\'s request: "Punch in on each demo screen"');

    const dipPrompt = buildBatchSummaryPrompt(sampleBatch({
      key: "bs_dips",
      kind: "dip",
      isDialoguePass: false,
      count: 3,
      removedSeconds: undefined,
      breakdown: undefined,
      samples: [{ label: "Dip music under intro" }, { label: "Dip music under outro" }],
    }));
    expect(dipPrompt).toContain("Batch: 3 music dips");

    const brollPrompt = buildBatchSummaryPrompt(sampleBatch({
      key: "bs_broll",
      kind: "broll",
      isDialoguePass: false,
      count: 5,
      removedSeconds: undefined,
      breakdown: undefined,
      samples: [{ label: "Studio desk cutaway" }],
    }));
    expect(brollPrompt).toContain("Batch: 5 B-roll shots");
  });
});
