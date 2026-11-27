import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "@scarlet/timeline";
import type { AgentAvailability, BatchSummaryItem, Task, WsEvent } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { localUser } from "../auth.js";
import type { Ctx } from "../context.js";
import { buildBatchSummaryPrompt, finishBatchSummaryTask, saveBatchSummary, summarizeBatches } from "./batchSummaries.js";
import { createTask } from "./tasks.js";

const dirs: string[] = [];
const apps: ScarletApp[] = [];

function startApp(env: Record<string, string> = {}): ScarletApp {
  const dir = mkdtempSync(join(tmpdir(), "scarlet-batch-summary-edge-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, skillsSeedDir: join(dir, "empty-seed"), env, log: () => {} });
  apps.push(app);
  return app;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.ctx.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function batch(over: Partial<BatchSummaryItem> = {}): BatchSummaryItem {
  return { key: "bs_edge", kind: "zoom", count: 2, samples: [{ label: "Zoom on the chart" }, { label: "Zoom on the code" }], ...over };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function stubFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => answer(String(url), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const sent = (fetchMock: ReturnType<typeof stubFetch>, call = 0) => {
  const [url, init] = fetchMock.mock.calls[call]!;
  return { url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) as Record<string, any> };
};
const titles = (ctx: Ctx) => ctx.db.prepare("SELECT batch_key, title FROM batch_summaries ORDER BY batch_key").all();

describe("the prompt for a batch", () => {
  it("names a batch by its kind, an unknown kind by its own word, and no kind as edits", () => {
    expect(buildBatchSummaryPrompt(batch({ kind: "speed", samples: [] }))).toBe("Batch: 2 speed changes");
    expect(buildBatchSummaryPrompt(batch({ kind: "wipe", samples: [] }))).toBe("Batch: 2 wipe edits");
    expect(buildBatchSummaryPrompt(batch({ kind: undefined, samples: [] }))).toBe("Batch: 2 edits");
  });

  it("writes the footage taken out as seconds, minutes or hours, and nothing when none was", () => {
    const removed = (seconds: number | undefined) => buildBatchSummaryPrompt(batch({ kind: "cut", samples: [], removedSeconds: seconds }));
    expect(removed(4.24)).toBe("Batch: 2 cuts (total cut: 4.2 s)");
    expect(removed(12.6)).toBe("Batch: 2 cuts (total cut: 13 s)");
    expect(removed(59.4)).toBe("Batch: 2 cuts (total cut: 59 s)");
    expect(removed(59.6)).toBe("Batch: 2 cuts (total cut: 1:00)");
    expect(removed(605)).toBe("Batch: 2 cuts (total cut: 10:05)");
    expect(removed(3725)).toBe("Batch: 2 cuts (total cut: 1:02:05)");
    expect(removed(0)).toBe("Batch: 2 cuts");
    expect(removed(undefined)).toBe("Batch: 2 cuts");
  });

  it("lists the change summaries, the breakdown by size and every edit when all of them are sampled", () => {
    const prompt = buildBatchSummaryPrompt(batch({
      request: "   ", breakdown: { small: 1, large: 5 }, descriptions: ["Zoomed in on the chart", "Zoomed in on the code"],
      samples: [{ label: "Zoom on the chart", reason: "Shows the figure" }, { label: "Zoom on the code" }],
    }));
    expect(prompt.split("\n")).toEqual([
      "Batch: 2 zooms",
      "Breakdown: 5 large, 1 small",
      "Change summaries:",
      "- Zoomed in on the chart",
      "- Zoomed in on the code",
      "Edits in this batch (2):",
      "- Zoom on the chart — Shows the figure",
      "- Zoom on the code",
    ]);
    // An empty breakdown and no descriptions add nothing.
    expect(buildBatchSummaryPrompt(batch({ breakdown: {}, descriptions: [], samples: [] }))).toBe("Batch: 2 zooms");
  });
});

describe("summaries over a provider's API", () => {
  it("asks Gemini when only its key is set, and leaves out its thoughts", async () => {
    const app = startApp({ GEMINI_API_KEY: "g-key" });
    const project = app.ctx.repos.projects.insert(createProject("Gemini"));
    const fetchMock = stubFetch(() => json({ candidates: [{ content: { parts: [{ text: "Thinking about zooms", thought: true }, { text: "Two zooms on " }, { text: "the demo" }] } }] }));
    expect(await summarizeBatches(app.ctx, project.id, [batch()])).toEqual({ summaries: { bs_edge: "Two zooms on the demo" }, pending: [] });
    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(headers["x-goog-api-key"]).toBe("g-key");
    expect(body.contents[0].parts[0].text).toContain("Batch: 2 zooms");
  });

  it("asks OpenAI when only its key is set, with the model the environment names", async () => {
    const app = startApp({ OPENAI_API_KEY: "o-key", SCARLET_CLEANUP_OPENAI_MODEL: "gpt-test" });
    const project = app.ctx.repos.projects.insert(createProject("OpenAI"));
    const fetchMock = stubFetch(() => json({ choices: [{ message: { content: "Two zooms on the demo." } }] }));
    expect(await summarizeBatches(app.ctx, project.id, [batch()])).toEqual({ summaries: { bs_edge: "Two zooms on the demo" }, pending: [] });
    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer o-key");
    expect(body.model).toBe("gpt-test");
  });

  it("asks the provider chosen for note cleanup first, with the batch model the environment names over any other", async () => {
    const app = startApp({ ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key", GEMINI_API_KEY: "g-key", SCARLET_BATCH_SUMMARY_MODEL: "fast-one", SCARLET_CLEANUP_OPENAI_MODEL: "ignored" });
    app.ctx.repos.settings.update({ noteCleanup: { provider: "openai" } });
    const project = app.ctx.repos.projects.insert(createProject("Preferred"));
    const fetchMock = stubFetch(() => json({ choices: [{ message: { content: "Two zooms" } }] }));
    await summarizeBatches(app.ctx, project.id, [batch()]);
    expect(sent(fetchMock)).toMatchObject({ url: "https://api.openai.com/v1/chat/completions", body: { model: "fast-one" } });
  });

  it("takes Anthropic's model from the cleanup setting in the environment, and Gemini's too", async () => {
    const anthropic = startApp({ ANTHROPIC_API_KEY: "a-key", SCARLET_CLEANUP_ANTHROPIC_MODEL: "claude-test" });
    const one = anthropic.ctx.repos.projects.insert(createProject("A"));
    let fetchMock = stubFetch(() => json({ content: [{ type: "text", text: "Two zooms" }] }));
    await summarizeBatches(anthropic.ctx, one.id, [batch()]);
    expect(sent(fetchMock).body.model).toBe("claude-test");

    const gemini = startApp({ GEMINI_API_KEY: "g-key", SCARLET_CLEANUP_GEMINI_MODEL: "gemini-test" });
    const two = gemini.ctx.repos.projects.insert(createProject("G"));
    fetchMock = stubFetch(() => json({ candidates: [] }));
    expect(await summarizeBatches(gemini.ctx, two.id, [batch()])).toEqual({ summaries: {}, pending: [] });
    expect(sent(fetchMock).url).toContain("/models/gemini-test:generateContent");
  });

  it("keeps no title for a refusal, an answer that isn't one, or a provider's error, and says why in the log", async () => {
    const logs: string[] = [];
    const app = startApp({ ANTHROPIC_API_KEY: "a-key" });
    vi.spyOn(app.ctx, "log").mockImplementation(line => { logs.push(line); });
    const project = app.ctx.repos.projects.insert(createProject("Refusals"));
    const answers = [
      json({ stop_reason: "refusal", content: [{ type: "text", text: "Two zooms" }] }),
      json({ content: [{ type: "tool_use" }, { type: "text" }] }),
      json({}),
      new Response("overloaded", { status: 529 }),
    ];
    stubFetch(() => answers.shift()!);
    for (const key of ["bs_1", "bs_2", "bs_3", "bs_4"]) {
      expect(await summarizeBatches(app.ctx, project.id, [batch({ key })])).toEqual({ summaries: {}, pending: [] });
    }
    expect(titles(app.ctx)).toEqual([]);
    expect(logs).toContain("[batch-summary] direct anthropic failed: anthropic 529: overloaded");
  });

  it("says why Gemini and OpenAI failed, and what a network error was", async () => {
    const logs: string[] = [];
    for (const [env, provider] of [[{ GEMINI_API_KEY: "g" }, "gemini"], [{ OPENAI_API_KEY: "o" }, "openai"]] as const) {
      const app = startApp(env);
      vi.spyOn(app.ctx, "log").mockImplementation(line => { logs.push(line); });
      const project = app.ctx.repos.projects.insert(createProject("Failing"));
      stubFetch(() => new Response("bad key", { status: 401 }));
      expect(await summarizeBatches(app.ctx, project.id, [batch()])).toEqual({ summaries: {}, pending: [] });
      stubFetch(() => { throw "socket hang up"; });
      expect(await summarizeBatches(app.ctx, project.id, [batch({ key: "bs_net" })])).toEqual({ summaries: {}, pending: [] });
      expect(logs).toContain(`[batch-summary] direct ${provider} failed: ${provider} 401: bad key`);
      expect(logs).toContain(`[batch-summary] direct ${provider} failed: socket hang up`);
    }
  });

  it("answers at once with what is pending when asked not to wait, and asks the provider once for a batch already being summarized", async () => {
    const app = startApp({ ANTHROPIC_API_KEY: "a-key" });
    const project = app.ctx.repos.projects.insert(createProject("Pending"));
    let answer!: (res: Response) => void;
    const fetchMock = stubFetch(() => new Promise<Response>(resolve => { answer = resolve; }));
    const events: WsEvent[] = [];
    app.ctx.bus.on("ws", (ev: WsEvent) => { events.push(ev); });
    expect(await summarizeBatches(app.ctx, project.id, [batch()], { waitMs: 0 })).toEqual({ summaries: {}, pending: ["bs_edge"] });
    expect(await summarizeBatches(app.ctx, project.id, [batch()], { waitMs: 0 })).toEqual({ summaries: {}, pending: ["bs_edge"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer(json({ content: [{ type: "text", text: "Two zooms" }] }));
    await vi.waitFor(() => expect(events.some(e => e.type === "batch_summary.updated" && e.key === "bs_edge")).toBe(true));
    expect(await summarizeBatches(app.ctx, project.id, [batch()], { waitMs: 0 })).toEqual({ summaries: { bs_edge: "Two zooms" }, pending: [] });
  });

  it("stops waiting for a slow provider after the time given, and leaves the batch pending", async () => {
    const app = startApp({ ANTHROPIC_API_KEY: "a-key" });
    const project = app.ctx.repos.projects.insert(createProject("Slow"));
    // The request never answers; the engine's shutdown aborts it.
    stubFetch((_, init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const asked = summarizeBatches(app.ctx, project.id, [batch()], { waitMs: 2500 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(await asked).toEqual({ summaries: {}, pending: ["bs_edge"] });
  });
});

describe("summaries by a signed-in assistant on a host", () => {
  function hostWith(ctx: Ctx, agents: AgentAvailability[], seenAgo = 0) {
    return ctx.repos.hosts.put({ id: "hst_local", userId: localUser(ctx).id, name: "Mac", platform: "darwin", online: true, agents,
      lastSeenAt: new Date(Date.now() - seenAgo).toISOString() });
  }
  const queued = (ctx: Ctx, projectId: string) => ctx.repos.tasks.select("project_id = ? AND kind = 'batch_summary'", [projectId], "created_at ASC, rowid ASC");
  function summaryTask(ctx: Ctx, projectId: string, key: string, over: Partial<Task>) {
    const task = createTask(ctx, { projectId, kind: "batch_summary", agent: "claude", instruction: "Summarize", context: { batchSummary: { key, prompt: "Summarize" } },
      createdBy: { type: "scarlet", name: "Scarlet" } });
    return ctx.repos.tasks.put({ ...task, ...over });
  }

  it("leaves batches unsummarized when no host has been seen lately or none has a signed-in assistant", async () => {
    const app = startApp();
    const project = app.ctx.repos.projects.insert(createProject("Offline"));
    expect(await summarizeBatches(app.ctx, project.id, [batch()])).toEqual({ summaries: {}, pending: [] });
    hostWith(app.ctx, [{ id: "claude", installed: true }], 5 * 60_000);
    expect(await summarizeBatches(app.ctx, project.id, [batch()])).toEqual({ summaries: {}, pending: [] });
    hostWith(app.ctx, [{ id: "claude", installed: true, loggedIn: false }, { id: "api", installed: true }, { id: "gemini", installed: false }]);
    expect(await summarizeBatches(app.ctx, project.id, [batch()])).toEqual({ summaries: {}, pending: [] });
    expect(queued(app.ctx, project.id)).toEqual([]);
  });

  it("prefers Claude, then Gemini, and picks each assistant's fast model or its own", async () => {
    const app = startApp();
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Fast models"));
    const cases: Array<[AgentAvailability[], string, string | undefined]> = [
      [[{ id: "codex", installed: true, models: ["gpt-5", "gpt-5-mini"] }, { id: "gemini", installed: true, models: ["gemini-3-pro", "gemini-3-flash"] }], "gemini", "gemini-3-flash"],
      [[{ id: "codex", installed: true, models: ["gpt-5", "gpt-5-nano"] }], "codex", "gpt-5-nano"],
      [[{ id: "claude", installed: true, models: ["claude-opus-4-6", "claude-sonnet-4-6"] }], "claude", "claude-sonnet-4-6"],
      [[{ id: "ollama", installed: true, model: "llama3", models: ["llama3", "qwen"] }], "ollama", "llama3"],
      [[{ id: "lmstudio", installed: true }, { id: "openrouter", installed: true }], "openrouter", undefined],
    ];
    for (const [i, [agents, agent, model]] of cases.entries()) {
      hostWith(ctx, agents);
      await summarizeBatches(ctx, project.id, [batch({ key: `bs_${i}` })]);
      const task = queued(ctx, project.id).at(-1)!;
      expect(task).toMatchObject({ agent, context: { batchSummary: { key: `bs_${i}` } } });
      expect(task.model).toBe(model);
    }
  });

  it("passes over an assistant whose last run failed lately for a lasting reason, and not for a passing one", async () => {
    const app = startApp();
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Broken assistant"));
    hostWith(ctx, [{ id: "claude", installed: true }, { id: "gemini", installed: true }]);
    const other = ctx.repos.projects.insert(createProject("Other"));
    const edit = createTask(ctx, { projectId: other.id, kind: "edit", agent: "claude", instruction: "Cut it", context: {}, createdBy: { type: "human", name: "Editor" } });
    ctx.repos.tasks.put({ ...edit, state: "failed", error: "Claude is not logged in. Please run /login.", finishedAt: new Date().toISOString() });
    await summarizeBatches(ctx, project.id, [batch({ key: "bs_a" })]);
    expect(queued(ctx, project.id).at(-1)).toMatchObject({ agent: "gemini" });

    // A failure long ago, one that passes, or a run that went well since don't count against it.
    ctx.repos.tasks.put({ ...edit, state: "failed", error: "Claude is not logged in.", finishedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    await summarizeBatches(ctx, project.id, [batch({ key: "bs_b" })]);
    expect(queued(ctx, project.id).at(-1)).toMatchObject({ agent: "claude" });
    ctx.repos.tasks.put({ ...edit, state: "failed", error: "The network dropped.", finishedAt: new Date().toISOString() });
    await summarizeBatches(ctx, project.id, [batch({ key: "bs_c" })]);
    expect(queued(ctx, project.id).at(-1)).toMatchObject({ agent: "claude" });
    ctx.repos.tasks.put({ ...edit, state: "done", finishedAt: new Date().toISOString() });
    await summarizeBatches(ctx, project.id, [batch({ key: "bs_e" })]);
    expect(queued(ctx, project.id).at(-1)).toMatchObject({ agent: "claude" });
  });

  it("keeps the title of a summary that finished, and asks again for one it can't use", async () => {
    const app = startApp();
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Recovered"));
    hostWith(ctx, [{ id: "claude", installed: true }]);
    summaryTask(ctx, project.id, "bs_done", { state: "done", summary: "Two zooms on the demo." });
    summaryTask(ctx, project.id, "bs_refused", { state: "done", summary: "Sorry, I can't." });
    summaryTask(ctx, project.id, "bs_cancelled", { state: "cancelled" });
    const result = await summarizeBatches(ctx, project.id, [batch({ key: "bs_done" }), batch({ key: "bs_refused" }), batch({ key: "bs_cancelled" })]);
    expect(result).toEqual({ summaries: { bs_done: "Two zooms on the demo" }, pending: ["bs_refused", "bs_cancelled"] });
    expect(titles(ctx)).toEqual([{ batch_key: "bs_done", title: "Two zooms on the demo" }]);
    expect(queued(ctx, project.id).filter(t => t.state === "queued").map(t => t.context.batchSummary?.key)).toEqual(["bs_refused", "bs_cancelled"]);
  });

  it("waits ten minutes after a failed summary before asking again", async () => {
    const app = startApp();
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Cooldown"));
    hostWith(ctx, [{ id: "claude", installed: true }]);
    summaryTask(ctx, project.id, "bs_recent", { state: "failed", error: "crashed", finishedAt: new Date(Date.now() - 60_000).toISOString() });
    summaryTask(ctx, project.id, "bs_old", { state: "failed", error: "crashed", finishedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    summaryTask(ctx, project.id, "bs_unknown", { state: "failed", error: "crashed", finishedAt: undefined });
    const result = await summarizeBatches(ctx, project.id, [batch({ key: "bs_recent" }), batch({ key: "bs_old" }), batch({ key: "bs_unknown" })]);
    expect(result).toEqual({ summaries: {}, pending: ["bs_old", "bs_unknown"] });
  });

  it("waits on a summary already claimed or running", async () => {
    const app = startApp();
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Running"));
    hostWith(ctx, [{ id: "claude", installed: true }]);
    summaryTask(ctx, project.id, "bs_claimed", { state: "claimed" });
    summaryTask(ctx, project.id, "bs_running", { state: "running" });
    expect(await summarizeBatches(ctx, project.id, [batch({ key: "bs_claimed" }), batch({ key: "bs_running" })])).toEqual({ summaries: {}, pending: ["bs_claimed", "bs_running"] });
    expect(queued(ctx, project.id)).toHaveLength(2);
  });
});

describe("saving a summary", () => {
  it("saves a finished summary run's title, and nothing for a run that isn't one, isn't done, has no key or no usable title", () => {
    const app = startApp();
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Finish"));
    const base = createTask(ctx, { projectId: project.id, kind: "batch_summary", agent: "claude", instruction: "Summarize",
      context: { batchSummary: { key: "bs_k", prompt: "Summarize" } }, createdBy: { type: "scarlet", name: "Scarlet" } });
    finishBatchSummaryTask(ctx, { ...base, kind: "edit", state: "done", summary: "Two zooms" });
    finishBatchSummaryTask(ctx, { ...base, state: "failed", summary: "Two zooms" });
    finishBatchSummaryTask(ctx, { ...base, state: "done", context: {}, summary: "Two zooms" });
    finishBatchSummaryTask(ctx, { ...base, state: "done", summary: "ok" });
    finishBatchSummaryTask(ctx, { ...base, state: "done", summary: null });
    expect(titles(ctx)).toEqual([]);
    finishBatchSummaryTask(ctx, { ...base, state: "done", summary: "Two zooms\nand why" });
    expect(titles(ctx)).toEqual([{ batch_key: "bs_k", title: "Two zooms" }]);
  });

  it("saves nothing for a project that is gone or in the Trash", () => {
    const app = startApp();
    const { ctx } = app;
    const events: WsEvent[] = [];
    ctx.bus.on("ws", (ev: WsEvent) => { events.push(ev); });
    saveBatchSummary(ctx, "prj_missing", "bs_x", "Two zooms");
    const project = ctx.repos.projects.insert(createProject("Trashed"));
    ctx.db.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), project.id);
    saveBatchSummary(ctx, project.id, "bs_x", "Two zooms");
    expect(titles(ctx)).toEqual([]);
    expect(events.filter(e => e.type === "batch_summary.updated")).toEqual([]);
  });

  it("answers from the cache alone when nothing is asked for", async () => {
    const app = startApp({ ANTHROPIC_API_KEY: "a-key" });
    const fetchMock = stubFetch(() => json({}));
    const project = app.ctx.repos.projects.insert(createProject("Empty"));
    expect(await summarizeBatches(app.ctx, project.id, [])).toEqual({ summaries: {}, pending: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
