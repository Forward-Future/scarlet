import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { type AddressInfo } from "node:net";
import { ScarletClient, type Task, type TaskEvent } from "@scarlet/shared";
import * as mock from "@scarlet/mcp/mock";
import { AgentHost, claudeProjectDir, humanDuration, promptTimeLimit, pruneTaskDirs, removeClaudeSessions, removeControlFiles, stalledReason, timedOutReason, type HostOptions } from "./host.js";
import { startStamp } from "./orphans.js";
import { DEFAULT_STALL_MS } from "./runners/types.js";
import type { RunAgentFn, RunAgentOptions } from "./runners/types.js";

const task: Task = {
  id: "task_1",
  projectId: "prj_test",
  kind: "edit",
  agent: "claude",
  model: "opus",
  instruction: "Make the first cut",
  context: {},
  state: "queued",
  createdBy: { type: "human", name: "Matt" },
  hostId: null,
  changeIds: [],
  question: null,
  summary: null,
};

interface Srv {
  server: Awaited<ReturnType<typeof mock.startMockServer>>;
  events: EventEmitter;
  taskEvents: TaskEvent[];
  completes: unknown[];
  claims: unknown[];
  queue: Task[];
  prompts: Array<Record<string, string>>;
  questions: Array<Record<string, unknown>>;
  /** CLI session the engine holds for the pending question. */
  session?: string;
  /** Holds a posted event before the engine stores and acknowledges it. */
  eventGate?: (ev: TaskEvent) => Promise<void>;
  /** Holds a claim open, as the engine's long poll does. */
  claimGate?: () => Promise<void>;
  /** One-off failures: the next request to the named route answers with this status. */
  failNext: Partial<Record<"heartbeat" | "claim" | "prompt" | "complete" | "task", number>>;
  /** What the engine says the task's state is. */
  taskState: Task["state"];
}

async function startServer(questionFailures = 0): Promise<Srv> {
  const state = mock.makeState();
  state.skills = [
    { id: "s1", name: "first-cut-dialogue", description: "First cut", content: "---\nname: first-cut-dialogue\n---\n# First cut\nDo it.", scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1 },
  ];
  const srv: Srv = { server: null!, events: new EventEmitter(), taskEvents: [], completes: [], claims: [], queue: [{ ...task }], prompts: [], questions: [], failNext: {}, taskState: "running" };
  state.extra = (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return true;
    };
    const failed = (route: keyof Srv["failNext"]) => {
      const status = srv.failNext[route];
      if (!status) return false;
      delete srv.failNext[route];
      return send(status, { error: { code: status === 404 ? "not_found" : "unavailable", message: `${route} refused` } });
    };
    if (req.method === "POST" && req.path === "/hosts/register") {
      return send(200, { host: { id: "host_1", userId: "u1", name: (req.body as { name: string }).name, platform: "test", agents: (req.body as { agents: unknown }).agents, online: true } });
    }
    if (req.method === "POST" && /^\/hosts\/host_1\/heartbeat$/.test(req.path)) return failed("heartbeat") || send(200, {});
    if (req.method === "POST" && /^\/hosts\/host_1\/claim$/.test(req.path)) {
      srv.claims.push({ query: Object.fromEntries(req.query), body: req.body });
      srv.events.emit("claim");
      if (failed("claim")) return true;
      const answer = () => {
        const t = srv.queue.shift() ?? null;
        if (t) t.state = "claimed";
        return send(200, { task: t });
      };
      return srv.claimGate ? srv.claimGate().then(answer) : answer();
    }
    if (req.method === "GET" && ["/tasks/task_1", "/tasks/resumed"].includes(req.path)) {
      return failed("task") || send(200, { task: { ...task, id: req.path.split("/").pop(), state: srv.taskState }, events: srv.taskEvents });
    }
    const prompt = /^\/tasks\/([^/]+)\/prompt$/.exec(req.path);
    if (req.method === "GET" && prompt) {
      if (failed("prompt")) return true;
      // The engine builds the prompt (see apps/server taskPrompt). The host passes it through.
      const query = Object.fromEntries(req.query);
      srv.prompts.push({ id: prompt[1]!, ...query });
      const last = srv.taskEvents.filter((e) => e.type === "question" || e.type === "answer").at(-1);
      const resumeSession = !query.fresh && last?.type === "answer" ? srv.session : undefined;
      return send(200, resumeSession
        ? { systemPrompt: `SYS ${query.workDir}`, instruction: `The editor answered: "${last!.text}"`, resumeSession }
        : { systemPrompt: `SYS ${query.workDir}`, instruction: task.instruction });
    }
    if (req.method === "POST" && req.path === "/tasks/task_1/events") {
      const store = () => {
        srv.taskEvents.push(req.body as TaskEvent);
        return send(200, {});
      };
      return srv.eventGate ? srv.eventGate(req.body as TaskEvent).then(store) : store();
    }
    if (req.method === "POST" && req.path === "/tasks/task_1/question") {
      if (questionFailures-- > 0) return send(503, { error: { message: "temporarily unavailable" } });
      const body = req.body as { text: string; sessionId?: string | null };
      srv.questions.push(body);
      if (body.sessionId !== undefined) srv.session = body.sessionId ?? undefined;
      srv.taskEvents.push({ type: "question", text: body.text });
      res.once("finish", () => srv.events.emit("question"));
      return send(200, { waiting: true });
    }
    if (req.method === "POST" && ["/tasks/task_1/complete", "/tasks/resumed/complete"].includes(req.path)) {
      if (failed("complete")) return true;
      srv.completes.push(req.body);
      res.once("finish", () => srv.events.emit("complete"));
      return send(200, { task: { ...task, state: (req.body as { state: string }).state } });
    }
    return false;
  };
  srv.server = await mock.startMockServer(state);
  onTestFinished(() => srv.server.close());
  return srv;
}

let workRoot: string;
beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "scarlet-host-"));
});
afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function makeHost(srv: Srv, runner: RunAgentFn, wsUrl?: string, options: Partial<HostOptions> = {}) {
  const client = new ScarletClient({ baseUrl: srv.server.url, token: "agent-token" });
  if (wsUrl) client.wsUrl = () => wsUrl;
  const saved: unknown[] = [];
  const host = new AgentHost({
    client,
    config: { server: srv.server.url, token: "agent-token", name: "test-host" },
    saveConfig: async (c) => void saved.push(c),
    runner,
    detect: async () => [
      { id: "claude", installed: true, loggedIn: true, version: "2.1.0", models: ["opus"] },
      { id: "codex", installed: false },
      { id: "gemini", installed: false },
    ],
    workRoot,
    mcpCliPath: "C:/fake/mcp/cli.js",
    ws: Boolean(wsUrl),
    heartbeatMs: 60_000,
    claimWaitSeconds: 1,
    idlePollMs: 50,
    log: () => undefined,
    ...options,
  });
  return { host, saved, client };
}

async function startHostAndWait(host: AgentHost, ready: Promise<unknown>) {
  const started = host.start();
  onTestFinished(async () => {
    await host.stop();
    await started;
  });
  await Promise.race([ready, started]);
}

/** An empty home folder for the length of a test, so what a host does with Claude Code's folders there can be seen. Ask for it before starting the host. */
async function claudeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "scarlet-home-"));
  // Node reads the home folder from the environment each time it is asked: HOME, or USERPROFILE on Windows.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // Claude Code keeps its files in the home unless this names another place, as it may where the tests are run.
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

/** What a Claude run has in its folder and in the home while it works: the control file with the engine token, and its session folder. */
async function claudeRunFiles(cwd: string, home: string): Promise<string> {
  await mkdir(join(cwd, ".scarlet"), { recursive: true });
  await writeFile(join(cwd, ".scarlet", "mcp.json"), "token");
  const session = claudeProjectDir(await realpath(cwd), home)!;
  await mkdir(session, { recursive: true });
  return session;
}

// Windows starts PowerShell for each private directory. A resumed task can require five calls across two preparations.
describe("AgentHost", { timeout: 30_000 }, () => {
  it("registers, claims, runs, streams events and completes with change ids", async ({ signal }) => {
    const srv = await startServer();
    const seen: RunAgentOptions[] = [];
    const runner: RunAgentFn = async (opts) => {
      seen.push(opts);
      opts.onEvent({ type: "log", text: "Reading transcript" });
      opts.onEvent({ type: "tool", text: "scarlet.timeline_first_cut {...}" });
      // Simulate what the MCP server does when timeline_propose succeeds, some time after the CLI wrote the lines above.
      await vi.waitFor(() => expect(srv.taskEvents).toHaveLength(2));
      await new ScarletClient({ baseUrl: opts.mcp.env.SCARLET_SERVER!, token: opts.mcp.env.SCARLET_TOKEN }).postTaskEvent(opts.mcp.env.SCARLET_TASK!, {
        type: "change",
        text: "Proposed change chg_7",
        data: { changeId: "chg_7" },
      });
      opts.onEvent({ type: "result", text: "First cut proposed." });
      await writeFile(join(opts.mcp.env.SCARLET_WORKDIR!, "cut.otio"), "kept");
      await writeFile(join(opts.cwd, "mcp.json"), "token");
      return { ok: true, summary: "First cut proposed as chg_7.", usage: { model: "opus", inputTokens: 12, outputTokens: 34, cacheReadTokens: 560, cacheWriteTokens: 78, reasoningTokens: 0 } };
    };
    const { host, saved } = makeHost(srv, runner);
    await startHostAndWait(host, once(srv.events, "complete", { signal }));

    // Sequence: register -> claim -> (task fetch, engine prompt) -> events -> complete
    const paths = srv.server.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths[0]).toBe("POST /hosts/register");
    expect(paths[1]).toBe("POST /hosts/host_1/claim");
    expect(paths.indexOf("POST /tasks/task_1/events")).toBeGreaterThan(paths.indexOf("GET /tasks/task_1/prompt"));
    expect(paths).not.toContain("GET /projects/prj_test");
    expect(paths.indexOf("POST /tasks/task_1/complete")).toBeGreaterThan(paths.lastIndexOf("POST /tasks/task_1/events"));
    expect(paths.indexOf("POST /tasks/task_1/usage")).toBeGreaterThan(paths.lastIndexOf("POST /tasks/task_1/events"));
    expect(paths.indexOf("POST /tasks/task_1/usage")).toBeLessThan(paths.indexOf("POST /tasks/task_1/complete"));
    expect(srv.server.requests.find(r => r.path === "/tasks/task_1/usage")?.body).toEqual({ model: "opus", inputTokens: 12, outputTokens: 34, cacheReadTokens: 560, cacheWriteTokens: 78, reasoningTokens: 0 });
    expect(srv.claims[0]).toMatchObject({ query: { wait: "1" }, body: { agents: ["claude"] } });
    expect(saved[0]).toMatchObject({ hostId: "host_1" });

    expect(srv.taskEvents.map((e) => e.type)).toEqual(["log", "tool", "change"]);
    expect(srv.completes).toEqual([{ state: "done", summary: "First cut proposed as chg_7.", error: undefined, changeIds: ["chg_7"] }]);

    // Runner inputs
    const run = seen[0]!;
    expect(run.agent).toBe("claude");
    expect(run.model).toBe("opus");
    expect(run.instruction).toBe("Make the first cut");
    expect(run.resumeSession).toBeUndefined();
    expect(run.cwd.startsWith(join(workRoot, "tasks-v2"))).toBe(true);
    expect(run.mcp.env.SCARLET_WORKDIR).toBe(join(run.cwd, "artifacts"));
    expect(srv.prompts).toEqual([{ id: "task_1", workDir: run.mcp.env.SCARLET_WORKDIR }]);
    expect(run.systemPrompt).toBe(`SYS ${run.mcp.env.SCARLET_WORKDIR}`);
    // The finished task keeps only its artifacts.
    await vi.waitFor(async () => expect(await readdir(run.cwd)).toEqual(["artifacts"]));
    expect(await readFile(join(run.cwd, "artifacts", "cut.otio"), "utf8")).toBe("kept");
    expect(run.mcp.args).toEqual(["C:/fake/mcp/cli.js"]);
    expect(run.mcp.env).toMatchObject({ SCARLET_SERVER: srv.server.url, SCARLET_TOKEN: "agent-token", SCARLET_PROJECT: "prj_test", SCARLET_TASK: "task_1", SCARLET_AGENT: "claude", SCARLET_MODEL: "opus" });
  });

  it("confirms a provider-reported question after a transient failure, and resumes with the answer", async ({ signal }) => {
    const srv = await startServer(1);
    const runs: RunAgentOptions[] = [];
    const runner: RunAgentFn = async (opts) => {
      runs.push(opts);
      if (runs.length === 1) {
        await writeFile(join(opts.mcp.env.SCARLET_WORKDIR!, "first.otio"), "first attempt");
        await writeFile(join(opts.cwd, "mcp.json"), "token");
        opts.onEvent({ type: "question", text: "Keep the intro?" });
        return { ok: true, summary: "", question: "Keep the intro?", questionPosted: true, sessionId: "sess-1", usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      }
      expect(await readFile(join(opts.mcp.env.SCARLET_WORKDIR!, "first.otio"), "utf8")).toBe("first attempt");
      return { ok: true, summary: "Done after answer." };
    };
    const { host } = makeHost(srv, runner);
    await startHostAndWait(host, once(srv.events, "question", { signal }));
    // The question response can arrive before the host releases the original claim.
    while (host.runningTaskIds.includes(task.id)) await once(srv.events, "claim", { signal });
    expect(srv.completes).toHaveLength(0);
    // A run that pauses for a question still reports its tokens.
    expect(srv.server.requests.filter(req => req.path === "/tasks/task_1/usage").map(req => req.body)).toEqual([{ inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }]);
    expect(srv.server.requests.filter(req => req.path.endsWith("/question"))).toHaveLength(2);
    expect(srv.taskEvents).toEqual([expect.objectContaining({ type: "question", text: "Keep the intro?" })]);
    expect(srv.questions.at(-1)).toEqual({ startedAt: undefined, text: "Keep the intro?", sessionId: "sess-1" });
    // A paused task keeps its CLI files for the resumed session.
    expect(await readFile(join(runs[0]!.cwd, "mcp.json"), "utf8")).toBe("token");

    // The editor answers; the server re-queues the task and the host continues the CLI session that asked.
    const completed = once(srv.events, "complete", { signal });
    srv.taskEvents.push({ type: "answer", text: "Yes, keep it" });
    srv.queue.push({ ...task });
    await completed;
    expect(runs[1]!.resumeSession).toBe("sess-1");
    expect(runs[1]!.instruction).toBe('The editor answered: "Yes, keep it"');
    expect(runs[1]!.cwd).toBe(runs[0]!.cwd);
    expect(srv.completes).toMatchObject([{ state: "done", summary: "Done after answer." }]);
  });

  it("starts a fresh run with the answers in the prompt when the CLI session is gone", async ({ signal }) => {
    const srv = await startServer();
    srv.session = "gone";
    srv.taskEvents.push({ type: "question", text: "Keep the intro?" }, { type: "answer", text: "Yes" });
    const runs: RunAgentOptions[] = [];
    const { host } = makeHost(srv, async (opts) => {
      runs.push(opts);
      return opts.resumeSession
        ? { ok: false, summary: "", error: "No conversation found with session ID: gone", resumeFailed: true, usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }
        : { ok: true, summary: "Done fresh.", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0 } };
    });
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(runs.map((r) => [r.resumeSession, r.instruction])).toEqual([["gone", 'The editor answered: "Yes"'], [undefined, "Make the first cut"]]);
    expect(srv.prompts.map((p) => p.fresh)).toEqual([undefined, "1"]);
    expect(srv.completes).toMatchObject([{ state: "done", summary: "Done fresh." }]);
    // One report per claim, with the failed resume's tokens included.
    expect(srv.server.requests.filter(req => req.path === "/tasks/task_1/usage").map(req => req.body))
      .toEqual([{ inputTokens: 105, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0 }]);
  });

  it("opens the original folder and artifacts with a fresh MCP identity on resume, so the CLI session is found again", async () => {
    const srv = await startServer();
    const { host } = makeHost(srv, async () => ({ ok: true, summary: "" }));
    const first = await host.prepare(task);
    await writeFile(join(first.mcp.env.SCARLET_WORKDIR!, "edit.otio"), "saved edit");
    const resumed = await host.prepare({ ...task, id: "resumed", resumeRootId: task.id });
    expect(resumed.cwd).toBe(first.cwd);
    expect(resumed.mcp.env.SCARLET_TASK).toBe("resumed");
    expect(await readFile(join(resumed.mcp.env.SCARLET_WORKDIR!, "edit.otio"), "utf8")).toBe("saved edit");
  });

  it("fails only the original claim if the engine keeps refusing the question", async ({ signal }) => {
    const srv = await startServer(Infinity);
    const startedAt = "2026-04-01T12:00:00.000Z";
    srv.queue[0]!.startedAt = startedAt;
    const { host } = makeHost(srv, async () => ({ ok: true, summary: "", question: "Keep the intro?" }));
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(srv.completes).toMatchObject([{ state: "failed", ifStartedAt: startedAt, error: expect.stringContaining("question") }]);
    expect(srv.taskEvents).toHaveLength(0);
  });

  it("subscribes to the task project and aborts its run on server cancellation", async ({ signal }) => {
    const srv = await startServer();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    onTestFinished(() => new Promise<void>((resolve, reject) => wss.close(err => err ? reject(err) : resolve())));
    await once(wss, "listening", { signal });
    let socket: WebSocket | undefined;
    wss.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (msg) => {
        const { type, projectId } = JSON.parse(msg.toString());
        if (projectId === task.projectId) srv.events.emit(type);
      });
    });
    let runSignal: AbortSignal | undefined;
    const { host, client } = makeHost(srv, async (opts) => {
      runSignal = opts.signal!;
      const aborted = once(runSignal, "abort");
      srv.events.emit("runnerStarted");
      await aborted;
      opts.onEvent({ type: "log", text: "late" });
      return { ok: true, summary: "late" };
    }, `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    const postTaskEvent = vi.spyOn(client, "postTaskEvent");
    await startHostAndWait(host, Promise.all([
      once(srv.events, "runnerStarted", { signal }),
      once(srv.events, "subscribe", { signal }),
    ]));
    const unsubscribed = once(srv.events, "unsubscribe", { signal });
    socket!.send(JSON.stringify({ type: "task.updated", task: { ...task, state: "cancelled" } }));
    await unsubscribed;
    expect(runSignal?.aborted).toBe(true);
    expect(postTaskEvent).not.toHaveBeenCalled();
    expect(srv.completes).toEqual([]);
    expect(srv.taskEvents).toEqual([]);
  });

  it("completes cancelled on stop()", async ({ signal }) => {
    const srv = await startServer();
    const { host } = makeHost(srv, async (opts) => {
      const aborted = once(opts.signal!, "abort");
      srv.events.emit("runnerStarted");
      await aborted;
      return { ok: false, summary: "partial", aborted: true, error: "cancelled" };
    });
    await startHostAndWait(host, once(srv.events, "runnerStarted", { signal }));
    await host.stop();
    expect(srv.completes).toMatchObject([{ state: "cancelled", interrupted: true, summary: "partial" }]);
  });

  it("posts a run's events one at a time, in the order written, and completes only after the last has landed", async ({ signal }) => {
    const srv = await startServer();
    let inFlight = 0;
    let most = 0;
    // The first event is the slowest to land: requests sent side by side would overtake it.
    srv.eventGate = async (ev) => {
      most = Math.max(most, ++inFlight);
      await delay(ev.text === "one" ? 150 : 10);
      inFlight--;
    };
    const { host } = makeHost(srv, async (opts) => {
      for (const text of ["one", "two", "three"]) opts.onEvent({ type: "log", text });
      return { ok: true, summary: "Done." };
    });
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(srv.taskEvents.map((e) => e.text)).toEqual(["one", "two", "three"]);
    expect(most).toBe(1);
  });

  it("finishes a run whose events the engine never acknowledges, and says so", async ({ signal }) => {
    const srv = await startServer();
    const release = new AbortController();
    srv.eventGate = async (ev) => {
      if (ev.text === "never lands") await delay(60_000, undefined, { signal: release.signal }).catch(() => undefined);
    };
    const lines: string[] = [];
    const { host } = makeHost(srv, async (opts) => {
      opts.onEvent({ type: "log", text: "never lands" });
      return { ok: false, summary: "", error: "claude exited with code 1" };
    }, undefined, { eventFlushMs: 100, log: (line) => lines.push(line) });
    try {
      await startHostAndWait(host, once(srv.events, "complete", { signal }));
      // The error that follows is not queued behind the request that hangs.
      expect(srv.taskEvents).toMatchObject([{ type: "error", text: "claude exited with code 1" }]);
      expect(srv.completes).toMatchObject([{ state: "failed", error: "claude exited with code 1" }]);
      expect(lines).toContain("task task_1: events still posting after 100ms; finishing without waiting for them");
    } finally {
      release.abort();
    }
  });

  it("completes failed on runner error", async ({ signal }) => {
    const srv = await startServer();
    const { host } = makeHost(srv, async () => ({ ok: false, summary: "", error: "claude exited with code 1" }));
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(srv.completes).toMatchObject([{ state: "failed", error: "claude exited with code 1" }]);
    expect(srv.taskEvents.at(-1)).toMatchObject({ type: "error", text: "claude exited with code 1" });
  });
});

describe("AgentHost when a run or the engine misbehaves", { timeout: 30_000 }, () => {
  const logging = () => {
    const lines: string[] = [];
    return { lines, log: (line: string) => void lines.push(line) };
  };

  it("passes the configured limits to the runner: no time cap and the default stall window unless set", async ({ signal }) => {
    const seen: RunAgentOptions[] = [];
    const runner: RunAgentFn = async (opts) => {
      seen.push(opts);
      return { ok: true, summary: "" };
    };
    const plain = await startServer();
    await startHostAndWait(makeHost(plain, runner).host, once(plain.events, "complete", { signal }));
    const set = await startServer();
    const config = { server: set.server.url, token: "agent-token", name: "test-host", timeoutMinutes: 2, stallMinutes: 1, models: { claude: "sonnet" } };
    await startHostAndWait(makeHost(set, runner, undefined, { config }).host, once(set.events, "complete", { signal }));
    expect(seen.map((run) => [run.timeoutMs, run.stallMs])).toEqual([[undefined, DEFAULT_STALL_MS], [120_000, 60_000]]);
    // The engine is told the time cap, so the prompt says the run stops at it. With no cap the prompt names none.
    expect([plain, set].map((srv) => srv.prompts.map((p) => p.timeLimit))).toEqual([[undefined], ["2"]]);
    // The task names its model; the configured default is only for a task that doesn't.
    expect(seen[1]!.model).toBe("opus");
    // An empty summary still completes with something to show.
    expect(plain.completes).toMatchObject([{ state: "done", summary: "Done." }]);
  });

  it("says why it stopped a silent run or one at its time cap, and marks both as interrupted so they can be resumed", async ({ signal }) => {
    const outcome = async (result: Awaited<ReturnType<RunAgentFn>>, options: Partial<HostOptions>) => {
      const srv = await startServer();
      await startHostAndWait(makeHost(srv, async () => result, undefined, options).host, once(srv.events, "complete", { signal }));
      return { complete: srv.completes[0], lastEvent: srv.taskEvents.at(-1) };
    };
    const stalled = await outcome({ ok: false, summary: "Read the transcript.", error: "stalled", timedOut: true, stalled: true }, { stallMs: 120_000 });
    expect(stalled.complete).toEqual({ state: "failed", summary: "Read the transcript.", error: "stalled: the agent wrote nothing for 2 minutes", changeIds: [], interrupted: true });
    expect(stalled.lastEvent).toMatchObject({ type: "error", text: "stalled: the agent wrote nothing for 2 minutes" });

    const capped = await outcome({ ok: false, summary: "", error: "timed out", timedOut: true }, { timeoutMs: 90_000 });
    expect(capped.complete).toEqual({ state: "failed", error: "timed out after 2 minutes, the limit for one agent run", changeIds: [], interrupted: true });

    // A failure the host didn't cause keeps the runner's words and is not resumable.
    const crashed = await outcome({ ok: false, summary: "" }, {});
    expect(crashed.complete).toEqual({ state: "failed", error: "agent failed", changeIds: [] });
  });

  it("fails the task with the reason when the runner itself throws", async ({ signal }) => {
    const srv = await startServer();
    const { host } = makeHost(srv, async () => {
      throw new Error("claude CLI not found on PATH");
    });
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(srv.completes).toMatchObject([{ state: "failed", error: "claude CLI not found on PATH" }]);
  });

  it("fails a task it could not prepare, with the engine's reason in the task log", async ({ signal }) => {
    const srv = await startServer();
    srv.failNext.prompt = 503;
    let ran = false;
    const { host } = makeHost(srv, async () => {
      ran = true;
      return { ok: true, summary: "" };
    });
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(ran).toBe(false);
    expect(srv.taskEvents).toMatchObject([{ type: "error", text: "Could not prepare task: prompt refused" }]);
    expect(srv.completes).toMatchObject([{ state: "failed", error: "prompt refused" }]);
  });

  it("leaves alone a task the engine cancelled before the run began", async ({ signal }) => {
    const srv = await startServer();
    srv.taskState = "cancelled";
    let ran = false;
    const { host } = makeHost(srv, async () => {
      ran = true;
      return { ok: true, summary: "" };
    });
    await startHostAndWait(host, once(srv.events, "claim", { signal }));
    // The host asks for the task before it prepares the run, and drops it from its running set once done with it.
    await vi.waitFor(() => expect(srv.server.requests.some((r) => r.method === "GET" && r.path === "/tasks/task_1")).toBe(true));
    await vi.waitFor(() => expect(host.runningTaskIds).toEqual([]));
    expect(ran).toBe(false);
    expect(srv.completes).toEqual([]);
    expect(srv.taskEvents).toEqual([]);
  });

  it("lets a newer claim of the same task take over: the older run stops without completing it", async ({ signal }) => {
    const srv = await startServer();
    const reasons: unknown[] = [];
    let runs = 0;
    const { host } = makeHost(srv, async (opts) => {
      if (++runs === 1) {
        // The engine hands the same task out again while this run is still going.
        srv.queue.push({ ...task });
        await once(opts.signal!, "abort");
        reasons.push(opts.signal!.reason);
        return { ok: false, summary: "older", aborted: true, error: "cancelled" };
      }
      return { ok: true, summary: "newer" };
    });
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    await vi.waitFor(() => expect(host.runningTaskIds).toEqual([]));
    expect(reasons).toEqual(["superseded"]);
    expect(srv.completes).toMatchObject([{ state: "done", summary: "newer" }]);
  });

  it("leaves a run's folder to another attempt still at work in it, which cleans it when it ends", async ({ signal }) => {
    const srv = await startServer();
    const home = await claudeHome();
    const sessions = () => readdir(join(home, ".claude", "projects"));
    // The editor stopped a run and resumed it before its CLI had wound down: two attempts at work in one folder.
    srv.queue.push({ ...task, id: "resumed", resumeRootId: task.id });
    let cwd = "";
    const { host } = makeHost(srv, async (opts) => {
      const id = opts.mcp.env.SCARLET_TASK!;
      // The resumed attempt has written its control files, and carries on in the session the first one opened.
      if (id === "resumed") await claudeRunFiles((cwd = opts.cwd), home);
      const ended = once(srv.events, `end ${id}`, { signal: opts.signal });
      srv.events.emit(`started ${id}`);
      await ended;
      return id === "resumed" ? { ok: true, summary: "Cut two pauses." } : { ok: false, summary: "", aborted: true, error: "cancelled" };
    });
    await startHostAndWait(host, Promise.all([once(srv.events, "started task_1", { signal }), once(srv.events, "started resumed", { signal })]));

    // The stopped attempt ends, and reports it as ever. Cleaning up as if alone, it would take the files the
    // resumed one runs on: its CLI starts with no Scarlet tools, or its next resume finds no session.
    srv.events.emit("end task_1");
    await vi.waitFor(() => expect(host.runningTaskIds).toEqual(["resumed"]), { timeout: 5_000 });
    expect(srv.completes).toMatchObject([{ state: "cancelled" }]);
    expect((await readdir(cwd)).sort()).toEqual([".scarlet", "artifacts"]);
    expect(await sessions()).toHaveLength(1);

    // The folder is the resumed attempt's to clean when it ends.
    srv.events.emit("end resumed");
    await vi.waitFor(() => expect(host.runningTaskIds).toEqual([]), { timeout: 5_000 });
    expect(srv.completes).toMatchObject([{ state: "cancelled" }, { state: "done", summary: "Cut two pauses." }]);
    expect(await readdir(cwd)).toEqual(["artifacts"]);
    expect(await sessions()).toEqual([]);
  });

  it("registers again when the engine has forgotten the host, on a heartbeat or a claim", async ({ signal }) => {
    const registrations = (srv: Srv) => srv.server.requests.filter((r) => r.path === "/hosts/register").length;
    const beat = await startServer();
    beat.queue.length = 0;
    beat.failNext.heartbeat = 404;
    const beatLog = logging();
    await startHostAndWait(makeHost(beat, async () => ({ ok: true, summary: "" }), undefined, { heartbeatMs: 20, log: beatLog.log }).host, once(beat.events, "claim", { signal }));
    await vi.waitFor(() => expect(registrations(beat)).toBe(2));
    expect(beatLog.lines).toContain("heartbeat failed: heartbeat refused");

    const claim = await startServer();
    claim.failNext.claim = 404;
    const claimLog = logging();
    await startHostAndWait(makeHost(claim, async () => ({ ok: true, summary: "" }), undefined, { log: claimLog.log }).host, once(claim.events, "claim", { signal }));
    await vi.waitFor(() => expect(registrations(claim)).toBe(2));
    expect(claimLog.lines).toContain("claim failed: claim refused");
    // An engine that merely failed is not asked to register the host again.
    const down = await startServer();
    down.queue.length = 0;
    down.failNext.heartbeat = 503;
    const downLog = logging();
    await startHostAndWait(makeHost(down, async () => ({ ok: true, summary: "" }), undefined, { heartbeatMs: 20, log: downLog.log }).host, once(down.events, "claim", { signal }));
    await vi.waitFor(() => expect(downLog.lines).toContain("heartbeat failed: heartbeat refused"));
    // A registration sent by mistake would land before the heartbeats that follow.
    const beats = () => down.server.requests.filter((r) => r.path === "/hosts/host_1/heartbeat").length;
    const seen = beats();
    await vi.waitFor(() => expect(beats()).toBeGreaterThanOrEqual(seen + 2));
    expect(registrations(down)).toBe(1);
  });

  it("hands back a task it claimed while shutting down, and logs it when the engine refuses", async ({ signal }) => {
    const stopDuringClaim = async (refuse: boolean) => {
      const srv = await startServer();
      const release = new AbortController();
      srv.claimGate = () => delay(60_000, undefined, { signal: release.signal }).catch(() => undefined);
      if (refuse) srv.failNext.complete = 503;
      const { lines, log } = logging();
      let ran = false;
      const { host } = makeHost(srv, async () => {
        ran = true;
        return { ok: true, summary: "" };
      }, undefined, { log });
      try {
        await startHostAndWait(host, once(srv.events, "claim", { signal }));
        const stopping = host.stop();
        release.abort();
        await stopping;
      } finally {
        release.abort();
      }
      expect(ran).toBe(false);
      return { srv, lines };
    };
    const handed = await stopDuringClaim(false);
    expect(handed.srv.completes).toEqual([{ state: "cancelled", interrupted: true }]);
    expect(handed.lines.filter((line) => line.includes("hand back"))).toEqual([]);

    const refused = await stopDuringClaim(true);
    expect(refused.srv.completes).toEqual([]);
    expect(refused.lines).toContain("could not hand back task task_1, claimed while shutting down: complete refused");
  });

  it("posts a completion the engine missed again, and leaves a run it could not complete for the engine to resume", async ({ signal }) => {
    const home = await claudeHome();
    const sessions = () => readdir(join(home, ".claude", "projects"));
    const startedAt = "2026-04-01T12:00:00.000Z";
    // A Claude run that finishes its work, for an engine that times out on the first completion it is sent and
    // takes the next, or one that answers none (`lost`).
    const finish = async (lost: boolean) => {
      const srv = await startServer();
      srv.queue[0]!.startedAt = startedAt;
      const { lines, log } = logging();
      const made: { cwd?: string; session?: string } = {};
      const { host, client } = makeHost(srv, async (opts) => {
        made.cwd = opts.cwd;
        made.session = await claudeRunFiles(opts.cwd, home);
        srv.events.emit("ran");
        return { ok: true, summary: "Cut two pauses." };
      }, undefined, { log });
      const completeTask = vi.spyOn(client, "completeTask");
      if (lost) completeTask.mockRejectedValue(new Error("fetch failed"));
      else srv.failNext.complete = 408;
      await startHostAndWait(host, once(srv.events, "ran", { signal }));
      // The host has let the task go once it is out of its running set.
      await vi.waitFor(() => expect(host.runningTaskIds).toEqual([]), { timeout: 5_000 });
      // What reached the engine, whether or not it took it.
      const sent = srv.server.requests.filter((r) => r.path === "/tasks/task_1/complete").map((r) => r.body);
      return { srv, lines, sent, tries: completeTask.mock.calls.length, cwd: made.cwd!, session: made.session! };
    };
    const completion = { state: "done", ifStartedAt: startedAt, summary: "Cut two pauses.", changeIds: [] };

    const again = await finish(false);
    // Forgotten after the one post, the task stays running at the engine, which then calls it interrupted and
    // runs the finished request a second time. The second post is the same completion, tied to its attempt: the
    // engine ignores a copy of one it already has.
    expect(again.sent).toEqual([completion, completion]);
    expect(again.srv.completes).toEqual([completion]);
    expect(again.lines).toContain("complete failed for task task_1: complete refused");
    // It landed, so the run is over: the file with the token and the session both go.
    expect(await readdir(again.cwd)).toEqual(["artifacts"]);
    expect(await sessions()).toEqual([]);

    // Three tries, then the host lets the task go. The file with the token still goes. The session stays, as an
    // interrupted run's does: the engine takes the run for interrupted and resumes it there.
    const lost = await finish(true);
    expect(lost.tries).toBe(3);
    expect(lost.lines.filter((line) => line === "complete failed for task task_1: fetch failed")).toHaveLength(3);
    expect(await readdir(lost.cwd)).toEqual(["artifacts"]);
    expect(await sessions()).toEqual([basename(lost.session)]);

    // While the host stops, one try: stopping doesn't wait on an engine that may already be gone.
    const srv = await startServer();
    const { host, client } = makeHost(srv, async (opts) => {
      const aborted = once(opts.signal!, "abort");
      srv.events.emit("runnerStarted");
      await aborted;
      return { ok: false, summary: "", aborted: true, error: "cancelled" };
    });
    const completeTask = vi.spyOn(client, "completeTask").mockRejectedValue(new Error("fetch failed"));
    await startHostAndWait(host, once(srv.events, "runnerStarted", { signal }));
    await host.stop();
    expect(completeTask).toHaveBeenCalledTimes(1);
  });

  it("completes without change ids, and says so, when the engine can't be asked for them", async ({ signal }) => {
    const srv = await startServer();
    const { lines, log } = logging();
    const { host } = makeHost(srv, async () => {
      srv.failNext.task = 503;
      return { ok: true, summary: "Cut made." };
    }, undefined, { log });
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(srv.completes).toEqual([{ state: "done", summary: "Cut made.", changeIds: [] }]);
    expect(lines).toContain("task task_1: could not read its change ids: task refused");
    await vi.waitFor(() => expect(lines).toContainEqual(expect.stringMatching(/^task task_1 done after \d+(ms|s)$/)));
  });

  it("logs an event the engine refused with its task, and keeps the run going", async ({ signal }) => {
    const srv = await startServer();
    const { lines, log } = logging();
    srv.eventGate = async (ev) => {
      if (ev.text === "refused") throw new Error("engine dropped the connection");
    };
    const { host } = makeHost(srv, async (opts) => {
      for (const text of ["refused", "kept"]) opts.onEvent({ type: "log", text });
      return { ok: true, summary: "" };
    }, undefined, { log });
    await startHostAndWait(host, once(srv.events, "complete", { signal }));
    expect(srv.taskEvents.map((e) => e.text)).toEqual(["kept"]);
    expect(lines.filter((line) => line.startsWith("task task_1: post event failed: "))).toHaveLength(1);
    expect(srv.completes).toMatchObject([{ state: "done" }]);
  });
});

describe("host log wording", () => {
  it("writes elapsed time the way the desktop host does", () => {
    expect([-5, 0, 850, 999, 1000, 12_400, 60_000, 2_702_000, 3_600_000, 3_780_000, 90_061_000].map(humanDuration))
      .toEqual(["0ms", "0ms", "850ms", "999ms", "1s", "12s", "1m", "45m 2s", "1h", "1h 3m", "25h 1m"]);
  });
  it("rounds a limit up to whole minutes in the reason the app reads", () => {
    expect(timedOutReason(30_000)).toBe("timed out after 1 minute, the limit for one agent run");
    expect(timedOutReason(90_000)).toBe("timed out after 2 minutes, the limit for one agent run");
    expect(stalledReason(0)).toBe("stalled: the agent wrote nothing for 1 minute");
    expect(stalledReason(DEFAULT_STALL_MS)).toBe("stalled: the agent wrote nothing for 10 minutes");
  });
  it("gives the prompt a run's time cap in the same whole minutes, and none where the engine would refuse it", () => {
    expect([undefined, 30_000, 60_000, 90_000, 45 * 60_000, 1440 * 60_000].map(promptTimeLimit)).toEqual([undefined, 1, 1, 2, 45, 1440]);
    // The engine takes a limit of up to a day and refuses the whole request over that. A longer one is left out:
    // the run is still stopped at it here, and the prompt names no limit.
    expect([1440 * 60_000 + 1, 1441 * 60_000, Number.MAX_VALUE, Infinity, NaN].map(promptTimeLimit)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("removeControlFiles", () => {
  it("keeps only the artifacts folder, and removes a task folder that has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "scarlet-control-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const [kept, empty] = [join(root, "kept"), join(root, "empty")];
    await mkdir(join(kept, "artifacts"), { recursive: true });
    await mkdir(join(kept, ".scarlet"), { recursive: true });
    await mkdir(empty);
    for (const file of [join(kept, "artifacts", "cut.otio"), join(kept, ".scarlet", "mcp.json"), join(kept, "AGENTS.md"), join(empty, "mcp.json")]) await writeFile(file, "x");
    await removeControlFiles(kept);
    await removeControlFiles(empty);
    await removeControlFiles(join(root, "never-made"));
    expect(await readdir(kept)).toEqual(["artifacts"]);
    expect(await readdir(join(kept, "artifacts"))).toEqual(["cut.otio"]);
    expect(await readdir(root)).toEqual(["kept"]);
  });
});

describe("pruneTaskDirs", () => {
  it("removes task folders unused for 14 days, judging use by the folder, its artifacts and their files", async () => {
    const root = await mkdtemp(join(tmpdir(), "scarlet-prune-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const tasks = join(root, "tasks-v2");
    const [old, recent, inUse, oneshot] = [join(tasks, "old"), join(tasks, "recent"), join(tasks, "in-use"), join(root, "oneshot-x")];
    for (const dir of [old, recent, inUse, oneshot]) await mkdir(join(dir, "artifacts"), { recursive: true });
    await writeFile(join(inUse, "artifacts", "edit.otio"), "x");
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000);
    for (const p of [old, join(old, "artifacts"), oneshot, join(oneshot, "artifacts"), inUse, join(inUse, "artifacts")]) await utimes(p, daysAgo(20), daysAgo(20));
    for (const p of [recent, join(recent, "artifacts")]) await utimes(p, daysAgo(13), daysAgo(13));
    // A later retry rewrote this file; the folders themselves look old.
    await utimes(join(inUse, "artifacts", "edit.otio"), daysAgo(2), daysAgo(2));
    await pruneTaskDirs(root, now);
    expect((await readdir(tasks)).sort()).toEqual(["in-use", "recent"]);
    expect(await readdir(root)).toEqual(["tasks-v2"]);
  });

  it("removes a pruned task folder's Claude sessions with it, when told the home Claude Code keeps them in", async () => {
    // Claude Code names a project folder after the real path, and macOS's temp folder is a link.
    const root = await realpath(await mkdtemp(join(tmpdir(), "scarlet-prune-")));
    const home = await mkdtemp(join(tmpdir(), "scarlet-home-"));
    onTestFinished(async () => {
      for (const dir of [root, home]) await rm(dir, { recursive: true, force: true });
    });
    const tasks = join(root, "tasks-v2");
    // Each is a run that was cut short and never resumed: its session was kept for the attempt that would carry on in it.
    const [first, old, recent] = [join(tasks, "first"), join(tasks, "old"), join(tasks, "recent")];
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000);
    for (const [dir, days] of [[first, 20], [old, 12], [recent, 2]] as const) {
      await mkdir(claudeProjectDir(dir, home)!, { recursive: true });
      await mkdir(join(dir, "artifacts"), { recursive: true });
      for (const p of [dir, join(dir, "artifacts")]) await utimes(p, daysAgo(days), daysAgo(days));
    }
    const sessions = async () => (await readdir(join(home, ".claude", "projects"))).sort();
    const sessionsOf = (...dirs: string[]) => dirs.map((dir) => basename(claudeProjectDir(dir, home)!)).sort();
    // Told no home, as when Claude Code keeps its files elsewhere, it leaves every session where it is.
    await pruneTaskDirs(root, now);
    expect((await readdir(tasks)).sort()).toEqual(["old", "recent"]);
    expect(await sessions()).toEqual(sessionsOf(first, old, recent));
    // Five days on, the second folder is old too. Its sessions go with it, and the recent folder keeps its own.
    await pruneTaskDirs(root, now + 5 * 86_400_000, home);
    expect(await readdir(tasks)).toEqual(["recent"]);
    expect(await sessions()).toEqual(sessionsOf(first, recent));
  });

  it("is given the user's home when the host starts, and none when Claude Code keeps its files elsewhere", async ({ signal }) => {
    const home = await claudeHome();
    // A host started over one old task folder, whose run was cut short and left its session in the home.
    const startOver = async (env?: NodeJS.ProcessEnv) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "scarlet-prune-")));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const old = join(root, "tasks-v2", "old");
      await mkdir(old, { recursive: true });
      await utimes(old, new Date(Date.now() - 20 * 86_400_000), new Date(Date.now() - 20 * 86_400_000));
      await mkdir(claudeProjectDir(old, home)!, { recursive: true });
      const srv = await startServer();
      srv.queue.length = 0;
      // The host prunes before it registers, so by its first claim it is done.
      await startHostAndWait(makeHost(srv, async () => ({ ok: true, summary: "" }), undefined, { workRoot: root, env }).host, once(srv.events, "claim", { signal }));
      return { folders: await readdir(join(root, "tasks-v2")), session: basename(claudeProjectDir(old, home)!) };
    };
    const sessions = () => readdir(join(home, ".claude", "projects"));

    const plain = await startOver();
    expect(plain.folders).toEqual([]);
    expect(await sessions()).toEqual([]);

    // CLAUDE_CONFIG_DIR moves Claude Code's files out of the home, so nothing there is the run's to remove.
    const elsewhere = await startOver({ ...process.env, CLAUDE_CONFIG_DIR: join(home, "claude-config") });
    expect(elsewhere.folders).toEqual([]);
    expect(await sessions()).toEqual([elsewhere.session]);
  });
});

describe("AgentHost launch sweep", { timeout: 30_000 }, () => {
  it("stops an agent CLI an earlier launch left running before it claims anything, whatever the engine says of its task", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "scarlet-sweep-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    // The CLI a crashed host left behind: in its own process group, and noted with its program and start time.
    const cli = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
    const exited = once(cli, "exit");
    onTestFinished(() => void (cli.exitCode === null && cli.signalCode === null && cli.kill()));
    const note = join(root, "agent-pids", String(cli.pid));
    await mkdir(join(root, "agent-pids"));
    await writeFile(note, `${process.execPath}\n${await startStamp(cli.pid!)}`);
    const srv = await startServer();
    srv.queue.length = 0;
    let notedAtClaim: boolean | undefined;
    srv.claimGate = async () => void (notedAtClaim ??= existsSync(note));
    await startHostAndWait(makeHost(srv, async () => ({ ok: true, summary: "" }), undefined, { workRoot: root }).host, once(srv.events, "claim", { signal }));
    await vi.waitFor(() => expect(notedAtClaim).toBe(false));
    expect((await exited)[0]).not.toBe(0);
  });
});

describe("removeClaudeSessions", () => {
  it("deletes only the Claude project folder named after the task folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "scarlet-home-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    // Escaping checked against Claude Code 2.1.316: real path, every non-alphanumeric character as "-".
    const cwd = "/Users/me/Library/Application Support/com.forwardfuture.scarlet/work/tasks-v2/ab12";
    expect(claudeProjectDir(cwd, home)).toBe(join(home, ".claude", "projects", "-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-ab12"));
    expect(claudeProjectDir("/" + "x".repeat(250), home)).toBeUndefined();
    const projects = join(home, ".claude", "projects");
    for (const name of ["-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-ab12", "-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-cd34", "-Users-me-project"]) {
      await mkdir(join(projects, name), { recursive: true });
    }
    // Claude Code 2.1.316 keeps a session's to-do list apart from its transcript, in ~/.claude/tasks/<session id>.
    const [run, other] = ["3f1c2b9e-0000-4000-8000-000000000000", "9a8b7c6d-1111-4000-8000-000000000000"];
    await writeFile(join(claudeProjectDir(cwd, home)!, `${run}.jsonl`), "{}");
    await writeFile(join(projects, "-Users-me-project", `${other}.jsonl`), "{}");
    // Two files in the task's project folder that are no session. Read as an id, the second would name ~/.claude.
    for (const stray of ["notes.jsonl", "...jsonl"]) await writeFile(join(claudeProjectDir(cwd, home)!, stray), "{}");
    const lists = join(home, ".claude", "tasks");
    for (const list of [run, other, "notes"]) {
      await mkdir(join(lists, list), { recursive: true });
      await writeFile(join(lists, list, "1.json"), "{}");
    }
    await removeClaudeSessions("/Users/me/project", home); // not a task folder
    await removeClaudeSessions(cwd, home);
    expect((await readdir(projects)).sort()).toEqual(["-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-cd34", "-Users-me-project"]);
    // The run's list goes with its session. Another session's stays, and so does a folder that isn't named by a session id.
    expect((await readdir(lists)).sort()).toEqual([other, "notes"]);
  });
});
