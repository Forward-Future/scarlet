/**
 * The local agent host daemon: registers with the Scarlet server, heartbeats,
 * claims tasks (long-poll + WebSocket wake-ups), runs them through the chosen
 * CLI runner, streams events back and completes them.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, platform, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { AgentAvailability, AgentId, AgentUsage, Task, TaskEvent } from "@scarlet/shared";
import { ScarletClient } from "@scarlet/shared";
import { privateDirectory } from "./private-files.js";
import type { AgentConfig } from "./config.js";
import { CLI_AGENTS, detect as detectAgents, runnerEnv } from "./detect.js";
import { runAgent as defaultRunAgent } from "./runners/index.js";
import { addUsage } from "./runners/usage.js";
import { mcpEnv, nodeExecutable, resolveMcpCliPath } from "./runners/spawn.js";
import { DEFAULT_STALL_MS, type McpSpec, type RunAgentFn, type RunAgentResult, type RunnerEvent } from "./runners/types.js";

export interface HostOptions {
  client: ScarletClient;
  config: AgentConfig;
  /** Persist config changes (hostId). */
  saveConfig?: (cfg: AgentConfig) => Promise<void>;
  runner?: RunAgentFn;
  detect?: () => Promise<AgentAvailability[]>;
  /** Where per-task workspaces live. */
  workRoot: string;
  /** Path to packages/mcp/dist/cli.js (resolved automatically when omitted). */
  mcpCliPath?: string;
  heartbeatMs?: number;
  /** Seconds the server should hold an empty claim (long-poll). */
  claimWaitSeconds?: number;
  /** Delay between empty claims when the server answers immediately. */
  idlePollMs?: number;
  /** Connect the WebSocket for wake-ups (default true). */
  ws?: boolean;
  log?: (msg: string) => void;
  /** Optional cap on one run (overrides config). */
  timeoutMs?: number;
  /** Stop a run whose CLI has written nothing for this long (overrides config). */
  stallMs?: number;
  /** How long a finished run waits for its events to reach the engine (default 30 s). */
  eventFlushMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface RunningTask {
  task: Task;
  controller: AbortController;
  promise: Promise<void>;
}

interface Prepared {
  systemPrompt: string;
  instruction: string;
  /** CLI session to continue with the instruction (the editor's answer). */
  resumeSession?: string;
  /** Launch the CLI with its own to-do tool on. */
  plan?: boolean;
  cwd: string;
  mcp: McpSpec;
}

/** Finished task folders keep their artifacts this long. */
const TASK_DIR_DAYS = 14;

export class AgentHost {
  private readonly client: ScarletClient;
  private config: AgentConfig;
  private readonly opts: HostOptions;
  private readonly log: (msg: string) => void;
  private agents: AgentAvailability[] = [];
  private running = new Map<string, RunningTask>(); // taskId -> run
  /** Running task count per runtime; each may run up to maxParallel at once. */
  private busy = new Map<AgentId, number>();
  private stopped = false;
  private wakeResolve: (() => void) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private readonly subscriptions = new Set<string>();
  private wsTimer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.client = opts.client;
    this.config = opts.config;
    this.log = opts.log ?? ((m) => console.error(`[scarlet-agent] ${m}`));
  }

  get hostId(): string | undefined {
    return this.config.hostId;
  }

  get runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  /** Register, start heartbeats, WS and the claim loop. Resolves when the loop ends (after stop()). */
  async start(): Promise<void> {
    this.stopped = false;
    // An old folder's Claude sessions go with it, unless Claude Code was told to keep its files somewhere other than the home.
    const home = (this.opts.env ?? process.env).CLAUDE_CONFIG_DIR ? undefined : homedir();
    await pruneTaskDirs(this.opts.workRoot, undefined, home).catch((err) => this.log(`could not prune old task folders: ${errMsg(err)}`));
    this.agents = await (this.opts.detect ?? (() => detectAgents({ models: this.config.models, log: this.log })))();
    await this.register();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.opts.heartbeatMs ?? 30_000);
    if (this.opts.ws !== false) this.connectWs();
    this.loopPromise = this.claimLoop();
    return this.loopPromise;
  }

  /** Cancel running tasks (complete as cancelled) and stop the loop. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wake();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.ws?.close();
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
  }

  // -- registration & heartbeat ---------------------------------------------

  private async register(): Promise<void> {
    const name = this.config.name ?? "scarlet-agent";
    const { host } = await this.client.registerHost({ name, platform: `${platform()} ${release()}`, agents: this.agents });
    if (host.id !== this.config.hostId) {
      this.config = { ...this.config, hostId: host.id };
      await this.opts.saveConfig?.(this.config);
    }
    this.log(`registered as host ${host.id} (${name}); agents: ${this.agents.filter((a) => a.installed).map((a) => a.id).join(", ") || "none"}`);
  }

  private async heartbeat(): Promise<void> {
    if (!this.config.hostId) return;
    try {
      await this.client.heartbeat(this.config.hostId, this.agents, [...this.running.keys()]);
      await this.checkCancellations();
    } catch (err) {
      this.log(`heartbeat failed: ${errMsg(err)}`);
      // Host may have been forgotten by a restarted server: re-register.
      if (isStatus(err, 404)) await this.register().catch((e) => this.log(`re-register failed: ${errMsg(e)}`));
    }
  }

  // -- websocket wake-ups ---------------------------------------------------

  private connectWs(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.client.wsUrl());
    } catch (err) {
      this.log(`ws connect failed: ${errMsg(err)}`);
      this.scheduleWsReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.log("ws connected");
      this.subscribeRunningProjects();
      void this.checkCancellations();
    });
    ws.on("message", (data) => {
      try {
        const ev = JSON.parse(data.toString()) as { type?: string; task?: Task };
        if (ev.type !== "task.updated" || !ev.task) return;
        if (ev.task.state === "cancelled") this.running.get(ev.task.id)?.controller.abort("server-cancelled");
        if (ev.task.state === "queued") this.wake();
      } catch {
        /* ignore */
      }
    });
    ws.on("error", (err) => this.log(`ws error: ${errMsg(err)}`));
    ws.on("close", () => {
      this.ws = null;
      this.subscriptions.clear();
      this.scheduleWsReconnect();
    });
  }

  private subscribeRunningProjects(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const active = new Set([...this.running.values()].map((r) => r.task.projectId));
    for (const id of active) {
      if (this.subscriptions.has(id)) continue;
      this.ws.send(JSON.stringify({ type: "subscribe", projectId: id }));
      this.subscriptions.add(id);
    }
    for (const id of this.subscriptions) {
      if (active.has(id)) continue;
      this.ws.send(JSON.stringify({ type: "unsubscribe", projectId: id }));
      this.subscriptions.delete(id);
    }
  }

  /** Recover cancellations missed before subscribing or while disconnected. */
  private async checkCancellations(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map(async (run) => {
      const { task } = await this.client.task(run.task.id);
      if (task.state === "cancelled") run.controller.abort("server-cancelled");
    }));
  }

  private scheduleWsReconnect(): void {
    if (this.stopped) return;
    this.wsTimer = setTimeout(() => this.connectWs(), 5000);
    this.wsTimer.unref?.();
  }

  private wake(): void {
    const r = this.wakeResolve;
    this.wakeResolve = null;
    r?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, ms);
      this.wakeResolve = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  // -- claim loop -----------------------------------------------------------

  private async claimLoop(): Promise<void> {
    const limit = Math.min(8, Math.max(1, this.config.maxParallel ?? 3));
    while (!this.stopped) {
      const available = this.agents.filter(a => a.installed && a.loggedIn !== false && (CLI_AGENTS as string[]).includes(a.id));
      const idle = available.filter(a => (this.busy.get(a.id) ?? 0) < limit).map(a => a.id);
      // A long poll cannot gain another runtime when one of our workers finishes.
      const wait = idle.length === available.length ? this.opts.claimWaitSeconds ?? 25 : 0;
      if (!idle.length) {
        await this.sleep(5000);
        continue;
      }
      let task: Task | null = null;
      try {
        // `wait` makes the server hold the request until a task is queued (long-poll);
        // `agents` restricts the claim to runtimes that are idle here.
        const res = await this.client.post<{ task: Task | null }>(`/hosts/${this.config.hostId}/claim?wait=${wait}`, { agents: idle });
        task = res?.task ?? null;
      } catch (err) {
        if (this.stopped) break;
        this.log(`claim failed: ${errMsg(err)}`);
        if (isStatus(err, 404)) await this.register().catch((e) => this.log(`re-register failed: ${errMsg(e)}`));
        await this.sleep(5000);
        continue;
      }
      if (!task) {
        if (!this.stopped) await this.sleep(this.opts.idlePollMs ?? 1000);
        continue;
      }
      if (this.stopped) {
        await this.client.completeTask(task.id, { state: "cancelled", interrupted: true })
          .catch((err) => this.log(`could not hand back task ${task.id}, claimed while shutting down: ${errMsg(err)}`));
        break;
      }
      this.launch(task);
    }
  }

  private launch(task: Task): void {
    const controller = new AbortController();
    this.running.get(task.id)?.controller.abort("superseded");
    const agent = task.agent;
    this.busy.set(agent, (this.busy.get(agent) ?? 0) + 1);
    const promise = this.runTask(task, controller.signal)
      .catch((err) => this.log(`task ${task.id} crashed: ${errMsg(err)}`))
      .finally(() => {
        if (this.running.get(task.id)?.controller === controller) this.running.delete(task.id);
        this.subscribeRunningProjects();
        this.busy.set(agent, Math.max(0, (this.busy.get(agent) ?? 1) - 1));
        this.wake();
      });
    this.running.set(task.id, { task, controller, promise });
    this.subscribeRunningProjects();
  }

  // -- running one task -----------------------------------------------------

  async runTask(task: Task, signal: AbortSignal): Promise<void> {
    this.log(`task ${task.id} (${task.kind}, ${task.agent}${task.model ? `/${task.model}` : ""})`);
    const started = Date.now();
    // One request at a time, so the engine gets the events in the order the CLI wrote them.
    let posting: Promise<void> = Promise.resolve();
    const post = (ev: TaskEvent): Promise<void> => {
      const at = new Date().toISOString();
      return (posting = posting.then(async () => {
        if (signal.aborted) return;
        try {
          await this.client.postTaskEvent(task.id, { ...ev, taskId: task.id, at }, task.startedAt);
        } catch (err) {
          this.log(`task ${task.id}: post event failed: ${errMsg(err)}`);
        }
      }));
    };
    // Completion waits for the forwarded events, but not for an engine that has stopped answering.
    const flushEvents = async () => {
      const limit = this.opts.eventFlushMs ?? 30_000;
      const timer = new AbortController();
      const late = await Promise.race([posting.then(() => false), delay(limit, true, { signal: timer.signal }).catch(() => false)]);
      timer.abort();
      if (!late) return;
      this.log(`task ${task.id}: events still posting after ${humanDuration(limit)}; finishing without waiting for them`);
      posting = Promise.resolve(); // What follows is not queued behind a request that hangs.
    };
    let cwd: string | undefined;
    // `stopped`: the host stopped the run before it finished. The editor can resume it from what it saved.
    const complete = async (state: "done" | "failed" | "cancelled", summary?: string, error?: string, stopped = false) => {
      // A newer claim of this task may be using the folder.
      if (signal.reason === "superseded") return;
      // Whether the engine has the completion. A task it cancelled itself is owed none.
      let landed = true;
      if (signal.reason !== "server-cancelled") {
        const body = { state, ifStartedAt: task.startedAt, summary, error, interrupted: (state === "cancelled" && this.stopped) || stopped ? true : undefined };
        // A post the engine misses is tried again. Forgotten here, the task stays running there until the engine
        // calls it interrupted and runs the finished request a second time. A copy does no harm: the engine ignores
        // the completion of an attempt it has already ended.
        landed = false;
        // The engine answers with the changes it holds for the task, for the line below.
        let changeIds: string[] = [];
        for (let attempt = 0; attempt < 3 && !landed; attempt++) {
          // One try while the host stops: stopping doesn't wait on an engine that may already be gone. No further
          // try either once the engine cancels the task or hands it out again: it has ended this attempt itself.
          if (attempt && signal.aborted) break;
          try {
            changeIds = (await this.client.completeTask(task.id, body))?.task?.changeIds ?? [];
            landed = true;
          } catch (err) {
            this.log(`complete failed for task ${task.id}: ${errMsg(err)}`);
            if (attempt < 2) await delay(250 * (attempt + 1), undefined, { signal }).catch(() => undefined);
          }
        }
        const changes = changeIds.length ? ` (${changeIds.length} changes: ${changeIds.join(", ")})` : "";
        const reason = error ?? (state === "failed" ? "no reason given" : undefined);
        this.log(`task ${task.id} ${state} after ${humanDuration(Date.now() - started)}${reason ? `: ${reason}` : ""}${changes}`);
      }
      if (cwd) {
        // An attempt the editor stopped can still be winding down when the attempt that resumes it is at work in
        // the folder they share. While another attempt is there, the folder and its CLI session are left to it,
        // to clean when it ends.
        const root = task.resumeRootId ?? task.id;
        if ([...this.running.values()].some((r) => r.controller.signal !== signal && r.task.projectId === task.projectId && (r.task.resumeRootId ?? r.task.id) === root)) {
          this.log(`task ${task.id}: left its folder to another attempt at the same run`);
          return;
        }
        // Resolve before the folder can go: Claude Code names its project folder after the real path.
        const real = task.agent === "claude" ? await realpath(cwd).catch(() => undefined) : undefined;
        await removeControlFiles(cwd).catch((err) => this.log(`could not clean task folder: ${errMsg(err)}`));
        // A run the host cut short keeps its CLI session: the attempt that resumes it carries on there.
        // So does one whose completion never landed: the engine takes it for interrupted and resumes it.
        // The folder's prune removes it if nothing ever does.
        const interrupted = (state === "cancelled" && this.stopped) || stopped;
        if (real && landed && !interrupted && !(this.opts.env ?? process.env).CLAUDE_CONFIG_DIR) {
          await removeClaudeSessions(real).catch((err) => this.log(`could not remove Claude sessions: ${errMsg(err)}`));
        }
      }
    };

    if (signal.aborted) return complete("cancelled", undefined, "host shutting down");

    let prepared: Prepared;
    try {
      prepared = await this.prepare(task);
      cwd = prepared.cwd;
    } catch (err) {
      await post({ type: "error", text: `Could not prepare task: ${errMsg(err)}` });
      return complete("failed", undefined, errMsg(err));
    }

    if (signal.aborted) return complete("cancelled", undefined, "cancelled");
    const runner = this.opts.runner ?? defaultRunAgent;
    const timeoutMs = this.runTimeoutMs;
    const stallMs = this.opts.stallMs ?? (this.config.stallMinutes ?? DEFAULT_STALL_MS / 60_000) * 60_000;
    let questionSeen: string | undefined;
    const run = (p: Prepared) => runner({
      agent: task.agent,
      model: task.model ?? this.config.models?.[task.agent],
      effort: task.effort,
      fast: task.fast,
      serviceTier: task.serviceTier,
      systemPrompt: p.systemPrompt,
      instruction: p.instruction,
      resumeSession: p.resumeSession,
      plan: p.plan,
      cwd: p.cwd,
      mcp: p.mcp,
      signal,
      timeoutMs,
      stallMs,
      env: runnerEnv(task.agent, this.agents, this.opts.env ?? process.env),
      onEvent: (ev: RunnerEvent) => {
        if (ev.type === "question") {
          questionSeen = ev.text;
          return; // Confirm delivery with the engine when the runner stops.
        }
        if (ev.type === "result") return; // summary goes in complete()
        void post({ type: ev.type, text: ev.text, data: ev.data });
      },
    }).catch((err): RunAgentResult => ({ ok: false, summary: "", error: errMsg(err) }));

    // Record tokens for every outcome, including a cancel or a pause for a question.
    const recordUsage = async (usage: AgentUsage | undefined) => {
      if (usage) await this.client.recordTaskUsage(task.id, { ...usage, startedAt: task.startedAt }).catch(err => this.log(`usage report failed: ${errMsg(err)}`));
    };
    let result = await run(prepared);
    // One report per claim replaces the last, so a failed resume's tokens go with the fresh run's.
    let usage = result.usage;
    if (result.resumeFailed && !signal.aborted) {
      // The CLI no longer has the session. Start over with the answers in the prompt.
      this.log(`task ${task.id}: could not resume the CLI session (${result.error ?? "unknown"}); starting a fresh run`);
      try {
        result = await run(await this.prepare(task, true));
      } catch (err) {
        await flushEvents();
        await recordUsage(usage);
        await post({ type: "error", text: `Could not prepare task: ${errMsg(err)}` });
        return complete("failed", undefined, errMsg(err));
      }
      usage = addUsage(usage, result.usage);
    }
    await flushEvents();
    await recordUsage(usage);

    if (signal.aborted || result.aborted) return complete("cancelled", result.summary || undefined, "cancelled");

    const question = result.question ?? questionSeen;
    if (question) {
      // The CLI can stop before MCP posts, or lose the reply after the engine commits.
      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
        try {
          await this.client.postTaskQuestion(task.id, task.startedAt, question, signal, { sessionId: result.sessionId ?? null });
          return;
        } catch (err) {
          if (signal.aborted) break;
          if (attempt === 2) {
            const error = `Could not deliver the editor question: ${errMsg(err)}`;
            this.log(error);
            return complete("failed", undefined, error);
          }
          await delay(250 * (attempt + 1), undefined, { signal }).catch(() => undefined);
        }
      }
      return; // On shutdown, the engine recovers any claim still without a durable question.
    }
    if (result.ok) return complete("done", result.summary || "Done.");
    // Say why the host stopped it: a bare "timed out" reads like a stalled tool or network call.
    const error = result.stalled ? stalledReason(stallMs)
      : result.timedOut && timeoutMs !== undefined ? timedOutReason(timeoutMs) : result.error ?? "agent failed";
    await post({ type: "error", text: error });
    return complete("failed", result.summary || undefined, error, !!result.timedOut);
  }

  /** The optional cap on one run: the host's option, or else the config's minutes. None by default. */
  private get runTimeoutMs(): number | undefined {
    return this.opts.timeoutMs ?? (this.config.timeoutMinutes ? this.config.timeoutMinutes * 60_000 : undefined);
  }

  /** Prepare the task folder, fetch the engine's prompt and build the MCP spec. `fresh` skips resuming the CLI session. */
  async prepare(task: Task, fresh = false): Promise<Prepared> {
    const { task: current } = await this.client.task(task.id);
    if (current.state === "cancelled") {
      this.running.get(task.id)?.controller.abort("server-cancelled");
      throw new Error("Task cancelled");
    }

    // Every attempt at an interrupted run shares the first attempt's folder, so the attempt that resumes it
    // finds its CLI session and artifacts there. Each attempt gets its own MCP identity.
    const workspaceFor = (id: string) => {
      const scope = JSON.stringify([new URL(this.config.server).href, task.projectId, id]);
      return join(this.opts.workRoot, "tasks-v2", createHash("sha256").update(scope).digest("hex"));
    };
    const cwd = workspaceFor(task.resumeRootId ?? task.id);
    await privateDirectory(cwd);
    const artifacts = join(cwd, "artifacts");
    await privateDirectory(artifacts);
    // The run is stopped at its time cap, so the prompt says so: the agent is told it will be cut off.
    const { systemPrompt, instruction, resumeSession, plan } = await this.client.taskPrompt(task.id, { workDir: artifacts, fresh, timeLimitMinutes: promptTimeLimit(this.runTimeoutMs) });

    const mcp: McpSpec = {
      command: nodeExecutable(),
      args: [this.opts.mcpCliPath ?? resolveMcpCliPath()],
      env: mcpEnv({
        SCARLET_SERVER: this.config.server,
        SCARLET_TOKEN: this.config.token,
        SCARLET_PROJECT: task.projectId,
        SCARLET_TASK: task.id,
        SCARLET_TASK_STARTED_AT: task.startedAt,
        SCARLET_AGENT: task.agent,
        SCARLET_MODEL: task.model ?? this.config.models?.[task.agent],
        SCARLET_WORKDIR: artifacts,
      }),
    };
    return { systemPrompt, instruction, resumeSession, plan, cwd, mcp };
  }
}

/** A finished task keeps only its artifacts. The CLI control files include the engine token. */
export async function removeControlFiles(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(entries.filter((name) => name !== "artifacts").map((name) => rm(join(dir, name), { recursive: true, force: true })));
  if (!entries.includes("artifacts")) await rm(dir, { recursive: true, force: true });
}

/**
 * Claude Code keeps a cwd's sessions in ~/.claude/projects/<real cwd with every
 * character other than a letter or digit as "-">. Names over 200 characters get
 * a hash suffix we can't reproduce, so those are left alone.
 */
export function claudeProjectDir(realCwd: string, home = homedir()): string | undefined {
  const name = realCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length > 200 || !/[a-zA-Z0-9]/.test(name) ? undefined : join(home, ".claude", "projects", name);
}

/**
 * Delete the Claude sessions of one finished Scarlet task: only the project folder named after its task folder,
 * and the to-do list of each session in it.
 */
export async function removeClaudeSessions(realCwd: string, home = homedir()): Promise<void> {
  if (basename(dirname(realCwd)) !== "tasks-v2") return;
  const dir = claudeProjectDir(realCwd, home);
  if (!dir || !(await lstat(dir).catch(() => undefined))?.isDirectory()) return;
  // Claude Code keeps a session's to-do list apart from it, in ~/.claude/tasks/<session id>, and a session
  // is `<session id>.jsonl` here. Only a name of hex digits and dashes is read as an id: "...jsonl" would
  // name ~/.claude itself. A list that can't be removed is left.
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const id = /^([0-9a-fA-F-]+)\.jsonl$/.exec(name)?.[1];
    const list = id && join(home, ".claude", "tasks", id);
    if (list && (await lstat(list).catch(() => undefined))?.isDirectory()) await rm(list, { recursive: true, force: true }).catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true });
}

/** Last use of a task folder: the folder, its artifacts folder or a file directly in it. */
async function lastUsed(dir: string): Promise<number | undefined> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  const artifacts = join(dir, "artifacts");
  const files = await readdir(artifacts).catch(() => [] as string[]);
  const times = await Promise.all([artifacts, ...files.map((f) => join(artifacts, f))].map((p) => stat(p).then((s) => s.mtimeMs, () => 0)));
  return Math.max(info.mtimeMs, ...times);
}

/** Remove task folders unused for TASK_DIR_DAYS, including artifacts. Given the user's home, a task folder's Claude sessions go with it. */
export async function pruneTaskDirs(workRoot: string, now = Date.now(), home?: string): Promise<void> {
  const cutoff = now - TASK_DIR_DAYS * 86_400_000;
  const dirs = [
    ...(await readdir(join(workRoot, "tasks-v2")).catch(() => [] as string[])).map((name) => join(workRoot, "tasks-v2", name)),
    ...(await readdir(workRoot).catch(() => [] as string[])).filter((name) => name.startsWith("oneshot-")).map((name) => join(workRoot, name)),
  ];
  await Promise.all(dirs.map(async (dir) => {
    const used = await lastUsed(dir);
    if (used === undefined || used >= cutoff) return;
    // A run that never finished left its Claude sessions behind. Resolve before the folder goes: its real path names them.
    const real = home === undefined ? undefined : await realpath(dir).catch(() => undefined);
    try {
      if (real) await removeClaudeSessions(real, home);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Elapsed time for log lines: "850ms", "12s", "45m 2s", "1h 3m". Matches the desktop host. */
export function humanDuration(ms: number): string {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs === 0) return `${Math.max(0, Math.round(ms))}ms`;
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/**
 * A run's time cap as the prompt request takes it: whole minutes, rounded up as the stop reason rounds them.
 * The engine takes a limit of up to a day and refuses the request over that, so a longer one is left out: the host
 * still stops the run at it, and the prompt names no limit rather than a shorter one nothing enforces. Matches the desktop host.
 */
export function promptTimeLimit(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  const limit = Math.max(1, Math.ceil(timeoutMs / 60_000));
  return limit <= 24 * 60 ? limit : undefined;
}

/** The task error for a run stopped at the optional time cap. The app reads the minutes from it. Matches the desktop host. */
export function timedOutReason(limitMs: number): string {
  return `timed out after ${minutes(limitMs)}, the limit for one agent run`;
}

/** The task error for a run stopped because its agent went silent. The app reads the minutes from it. Matches the desktop host. */
export function stalledReason(stallMs: number): string {
  return `stalled: the agent wrote nothing for ${minutes(stallMs)}`;
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === status;
}
