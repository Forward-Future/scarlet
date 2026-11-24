/**
 * The local agent host daemon: registers with the Scarlet server, heartbeats,
 * claims tasks (long-poll + WebSocket wake-ups), runs them through the chosen
 * CLI runner, streams events back and completes them.
 */
import { createHash } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { platform, release } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { AgentAvailability, AgentId, AgentUsage, CreateTaskRequest, SubscriptionQuota, Task } from "@scarlet/shared";
import { isSideCheck, ScarletClient, sideCheckSlots, TaskState } from "@scarlet/shared";
import { privateDirectory } from "./private-files.js";
import type { AgentConfig } from "./config.js";
import { CLI_AGENTS, cliBinary, detect as detectAgents, findOnPath, runnerEnv } from "./detect.js";
import type { CliAgent } from "./modelCatalog.js";
import { isQuotaEligible, probeSubscriptionQuota } from "./quota.js";
import { killStoppedNow, stopOrphans } from "./processTree.js";
import { runAgent as defaultRunAgent } from "./runners/index.js";
import { codexHomeDir } from "./runners/codex.js";
import { geminiDir } from "./runners/geminiAcp.js";
import { addUsage } from "./runners/usage.js";
import { errMsg, mcpEnv, nodeExecutable, resolveMcpCliPath } from "./runners/spawn.js";
import { DEFAULT_STALL_MS, type McpSpec, type RunAgentFn, type RunAgentResult, type RunnerEvent, type Workspace } from "./runners/types.js";
import { promptTimeLimit, stalledReason, timedOutReason } from "./runLimits.js";
import { claudeConfigDir, pruneTaskDirs, removeClaudeSessions, removeControlFiles, removeTokenFiles } from "./taskDirs.js";
import { createEventForwarder, createLiveUsageReporter } from "./taskReports.js";
import { workspaceTools } from "./workspaceTools.js";

const QUOTA_TTL_MS = 60_000;

export interface HostOptions {
  client: ScarletClient;
  config: AgentConfig;
  /** Persist config changes (hostId). */
  saveConfig?: (cfg: AgentConfig) => Promise<void>;
  runner?: RunAgentFn;
  detect?: () => Promise<AgentAvailability[]>;
  probeQuota?: (agent: CliAgent, file: string, env: NodeJS.ProcessEnv) => Promise<SubscriptionQuota | undefined>;
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
  /** Each event a run's CLI reports, as it is passed on to the engine (`scarlet-agent run` prints them). */
  onRunnerEvent?: (task: Task, ev: RunnerEvent) => void;
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
  /** The engine's words for the turn after a refused tool (`refusedTool`). */
  refusedTool?: string;
  /** The harness's own shell, file and web tools, for a request (`workspace` on the engine's prompt). */
  workspace?: Workspace;
  cwd: string;
  mcp: McpSpec;
}

/** How a run ended, as the host completes it. `stopped`: the host stopped the run before it finished. The editor can resume it from what it saved. */
interface Completion {
  state: "done" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  stopped: boolean;
}

/**
 * Whether the engine has a run's completion, and whether it handed the attempt's CLI session to the attempt that
 * resumes it, as a pause of the project's editing does.
 */
interface Delivery {
  landed: boolean;
  carriesOn: boolean;
}

export class AgentHost {
  private readonly client: ScarletClient;
  private config: AgentConfig;
  private readonly opts: HostOptions;
  private readonly log: (msg: string) => void;
  private agents: AgentAvailability[] = [];
  private running = new Map<string, RunningTask>(); // taskId -> run
  private beating = false;
  private beatAgain = false;
  /** Running task count per runtime; each may run up to maxParallel at once. */
  private busy = new Map<AgentId, number>();
  /** Running side checks per runtime, in slots of their own (`sideCheckSlots`), so a request never waits for its own checks behind itself. */
  private checking = new Map<AgentId, number>();
  private stopped = false;
  private stopController = new AbortController();
  private wakeResolve: (() => void) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private readonly subscriptions = new Set<string>();
  private wsTimer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;
  private quotaRefreshPromise: Promise<void> | null = null;
  private quotaQueued: { agents: Set<AgentId> | null; promise: Promise<void> } | null = null;
  private lastQuotaAt = 0;

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

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  private get heartbeatMs(): number {
    return this.opts.heartbeatMs ?? 30_000;
  }

  /** Register, start heartbeats, WS and the claim loop. Resolves when the loop ends (after stop()). */
  async start(): Promise<void> {
    this.stopped = false;
    this.stopController = new AbortController();
    const [agents] = await Promise.all([
      this.detectAgents(),
      // An old folder's Claude sessions go with it, wherever Claude Code keeps its files.
      pruneTaskDirs(this.opts.workRoot, undefined, claudeConfigDir(this.env)).catch((err) => this.log(`could not prune old task folders: ${errMsg(err)}`)),
      this.stopOrphans(),
    ]);
    this.agents = agents;
    await this.register();
    void this.refreshQuotas();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatMs);
    if (this.opts.ws !== false) this.connectWs();
    this.loopPromise = this.claimLoop();
    return this.loopPromise;
  }

  /** Cancel running tasks (complete as cancelled) and stop the loop. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    this.wake();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.ws?.close();
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
    // The kill that follows each CLI's polite stop doesn't go out once the host has exited: finish them now.
    killStoppedNow();
  }

  /** Stop agent CLIs an earlier launch of a host on this folder left running when it crashed. */
  async stopOrphans(): Promise<void> {
    await stopOrphans(join(this.opts.workRoot, "agent-pids"), this.log).catch((err) => this.log(`could not stop agent CLIs an earlier launch left: ${errMsg(err)}`));
  }

  /**
   * Ask the engine for one request and run it here, as `start` runs each it claims: with the engine's prompt, in a
   * task folder, cleaned up and completed the same way (`scarlet-agent run`). The request waits its turn in the
   * project's queue, and another host may take it first: then this one follows it to its end. Resolves with the
   * task as it ended, or as it waits for the editor's answer.
   */
  async runOne(projectId: string, request: CreateTaskRequest, signal: AbortSignal = new AbortController().signal, pollMs = 2000): Promise<Task> {
    this.agents = await this.detectAgents();
    await this.register();
    // The engine counts a host without heartbeats as gone, and hands its run on: a tool call longer than that
    // would leave this run's saves refused. `start` beats for its own runs; this one beats until it returns.
    const beating = setInterval(() => void this.heartbeat(), this.heartbeatMs);
    try {
      return await this.followOne(projectId, request, signal, pollMs);
    } finally {
      clearInterval(beating);
    }
  }

  private async followOne(projectId: string, request: CreateTaskRequest, signal: AbortSignal, pollMs: number): Promise<Task> {
    const { task } = await this.client.createTask(projectId, request);
    this.log(`asked the engine for task ${task.id}`);
    for (;;) {
      if (signal.aborted) {
        await this.client.cancelTask(task.id).catch((err) => this.log(`could not cancel task ${task.id}: ${errMsg(err)}`));
        break;
      }
      let claimed: Task | null = null;
      try {
        claimed = (await this.client.request<{ task: Task | null }>("POST", `/hosts/${this.config.hostId}/claim?wait=0`, { taskId: task.id, agents: [task.agent] }))?.task ?? null;
      } catch (err) {
        // No longer queued: another host has it, or it has ended.
        if (!isStatus(err, 409)) throw err;
        break;
      }
      if (claimed) {
        // Listed as running and named in a heartbeat, as `launch` does: the engine takes a claimed run that no
        // heartbeat names for 90 s as lost, fails it and queues a resume, while this CLI works on.
        const controller = new AbortController();
        const follow = () => controller.abort(signal.reason);
        if (signal.aborted) follow();
        else signal.addEventListener("abort", follow, { once: true });
        const promise = this.runTask(claimed, controller.signal);
        this.running.set(claimed.id, { task: claimed, controller, promise });
        const beat = setInterval(() => void this.heartbeat(), this.heartbeatMs);
        try {
          await promise;
        } finally {
          clearInterval(beat);
          signal.removeEventListener("abort", follow);
          if (this.running.get(claimed.id)?.controller === controller) this.running.delete(claimed.id);
        }
        break;
      }
      // Held behind the project's other requests.
      await delay(pollMs, undefined, { signal }).catch(() => undefined);
    }
    for (;;) {
      const { task: now } = await this.client.task(task.id, "none");
      if (!["queued", "claimed", "running"].includes(now.state) || signal.aborted) return now;
      await delay(pollMs, undefined, { signal }).catch(() => undefined);
    }
  }

  // -- registration & heartbeat ---------------------------------------------

  private detectAgents(): Promise<AgentAvailability[]> {
    return this.opts.detect ? this.opts.detect() : detectAgents({ models: this.config.models, log: this.log });
  }

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
    // One at a time: an engine that is slow to answer isn't sent a burst when it comes back. What was asked for
    // meanwhile (a new quota to report, the next tick) goes in one heartbeat after it.
    if (this.beating) {
      this.beatAgain = true;
      return;
    }
    this.beating = true;
    try {
      const reply = await this.client.heartbeat(this.config.hostId, this.agents, [...this.running.keys()]);
      // The reply names the runs cancelled before this host subscribed, or while it was disconnected. An engine
      // from before that reply is asked about each run.
      if (reply?.cancelled) for (const id of reply.cancelled) this.running.get(id)?.controller.abort("server-cancelled");
      else await this.checkCancellations();
    } catch (err) {
      this.log(`heartbeat failed: ${errMsg(err)}`);
      // Host may have been forgotten by a restarted server: re-register.
      if (isStatus(err, 404)) await this.register().catch((e) => this.log(`re-register failed: ${errMsg(e)}`));
    } finally {
      this.beating = false;
      if (this.beatAgain && !this.stopped) {
        this.beatAgain = false;
        void this.heartbeat();
      }
    }
  }

  /** Refresh subscription quota in the background without blocking task claims or picker opens. */
  async refreshQuotas(opts: { force?: boolean; agents?: readonly AgentId[] } = {}): Promise<void> {
    if (this.stopped) return;
    // Skip real CLI probing when tests supply a mocked `detect` without an explicit `probeQuota`.
    if (this.opts.detect && !this.opts.probeQuota) return;
    const force = Boolean(opts.force);
    if (!force && this.lastQuotaAt > 0 && Date.now() - this.lastQuotaAt < QUOTA_TTL_MS) return;
    if (this.quotaRefreshPromise) {
      if (!force) return this.quotaRefreshPromise;
      // Runs that finish together share the one refresh that follows the probe in flight, rather than a CLI each.
      const queued = this.quotaQueued;
      if (queued) {
        if (!opts.agents) queued.agents = null;
        else for (const id of opts.agents) queued.agents?.add(id);
        return queued.promise;
      }
      const next: { agents: Set<AgentId> | null; promise: Promise<void> } = { agents: opts.agents ? new Set(opts.agents) : null, promise: Promise.resolve() };
      next.promise = this.quotaRefreshPromise.catch(() => undefined).then(() => {
        this.quotaQueued = null;
        return this.refreshQuotas({ force: true, ...(next.agents && { agents: [...next.agents] }) });
      });
      this.quotaQueued = next;
      return next.promise;
    }
    const probe = this.opts.probeQuota ?? probeSubscriptionQuota;
    const env = this.env;
    const only = opts.agents ? new Set(opts.agents) : null;
    const run = (async () => {
      const targets = this.agents.filter((a) => isQuotaEligible(a) && (!only || only.has(a.id)));
      if (!targets.length) return;
      const results = await Promise.all(targets.map(async (agent) => {
        const file = this.opts.probeQuota ? cliBinary(agent.id) : await findOnPath(cliBinary(agent.id), env);
        if (!file) return null;
        try {
          const quota = await probe(agent.id as CliAgent, file, runnerEnv(agent.id, this.agents, env));
          return quota ? { id: agent.id, quota } : null;
        } catch {
          return null;
        }
      }));
      if (this.stopped) return;
      let changed = false;
      const next = this.agents.map((agent) => {
        if (agent.auth === "api_key" && agent.quota) {
          changed = true;
          const { quota: _drop, ...rest } = agent;
          return rest;
        }
        const hit = results.find((r) => r?.id === agent.id);
        if (!hit) return agent;
        changed = true;
        return withQuota(agent, hit.quota);
      });
      this.lastQuotaAt = Date.now();
      if (changed) {
        this.agents = next;
        await this.heartbeat();
      }
    })().finally(() => {
      if (this.quotaRefreshPromise === run) this.quotaRefreshPromise = null;
    });
    this.quotaRefreshPromise = run;
    return run;
  }

  private applyLiveQuota(agentId: AgentId, quota: SubscriptionQuota): void {
    if (this.stopped) return;
    const idx = this.agents.findIndex((a) => a.id === agentId);
    if (idx < 0 || !isQuotaEligible(this.agents[idx]!)) return;
    const updated = withQuota(this.agents[idx]!, quota);
    this.agents = this.agents.map((a, i) => (i === idx ? updated : a));
    void this.heartbeat();
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
        const ev = JSON.parse(data.toString()) as { type?: string; task?: Task; force?: boolean };
        if (ev.type === "host.quota_refresh") {
          void this.refreshQuotas({ force: Boolean(ev.force) });
          return;
        }
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
      const { task } = await this.client.task(run.task.id, "none");
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
    const limit = Math.min(8, Math.max(1, this.config.maxParallel ?? 4));
    const checkLimit = sideCheckSlots(limit);
    while (!this.stopped) {
      const available = this.agents.filter(a => a.installed && a.loggedIn !== false && (CLI_AGENTS as string[]).includes(a.id));
      const idle = available.filter(a => (this.busy.get(a.id) ?? 0) < limit).map(a => a.id);
      const checkIdle = available.filter(a => (this.checking.get(a.id) ?? 0) < checkLimit).map(a => a.id);
      // A long poll cannot gain another runtime when one of our workers finishes.
      const wait = idle.length === available.length && checkIdle.length === available.length ? this.opts.claimWaitSeconds ?? 25 : 0;
      if (!idle.length && !checkIdle.length) {
        await this.sleep(5000);
        continue;
      }
      let task: Task | null = null;
      try {
        // `wait` makes the server hold the request until a task is queued (long-poll);
        // `agents` restricts the claim to runtimes that are idle here.
        const res = await this.client.request<{ task: Task | null }>(
          "POST",
          `/hosts/${this.config.hostId}/claim?wait=${wait}`,
          { agents: idle, checkAgents: checkIdle },
          { signal: this.stopController.signal },
        );
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
        await this.client.completeTask(task.id, { state: "cancelled", interrupted: true, ifStartedAt: task.startedAt })
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
    // A side check counts in its own slots, whichever pool the engine handed it from.
    const slots = isSideCheck(task) ? this.checking : this.busy;
    slots.set(agent, (slots.get(agent) ?? 0) + 1);
    const promise = this.runTask(task, controller.signal)
      .catch((err) => this.log(`task ${task.id} crashed: ${errMsg(err)}`))
      .finally(() => {
        if (this.running.get(task.id)?.controller === controller) this.running.delete(task.id);
        this.subscribeRunningProjects();
        slots.set(agent, Math.max(0, (slots.get(agent) ?? 1) - 1));
        this.wake();
      });
    this.running.set(task.id, { task, controller, promise });
    this.subscribeRunningProjects();
  }

  // -- running one task -----------------------------------------------------

  /** Clean up control files and CLI sessions for a completed task attempt unless handed on to a resume. */
  private async cleanupTaskWorkspace(task: Task, cwd: string, signal: AbortSignal, landed: boolean, interrupted: boolean): Promise<void> {
    if (this.sharedWithAnotherAttempt(task, signal)) {
      this.log(`task ${task.id}: left its folder to another attempt at the same run`);
      return;
    }
    // Resolve before the folder can go: Claude Code names its project folder after the real path.
    const real = task.agent === "claude" ? await realpath(cwd).catch(() => undefined) : undefined;
    await removeControlFiles(cwd).catch((err) => this.log(`could not clean task folder: ${errMsg(err)}`));
    if (real && landed && !interrupted) {
      await removeClaudeSessions(real, claudeConfigDir(this.env)).catch((err) => this.log(`could not remove Claude sessions: ${errMsg(err)}`));
    }
    if (task.agent === "codex" && landed && !interrupted) {
      await rm(codexHomeDir(cwd), { recursive: true, force: true }).catch((err) => this.log(`could not remove the Codex home: ${errMsg(err)}`));
    }
    if (task.agent === "gemini" && landed && !interrupted) {
      await rm(geminiDir(cwd), { recursive: true, force: true }).catch((err) => this.log(`could not remove the Gemini folder: ${errMsg(err)}`));
    }
  }

  async runTask(task: Task, signal: AbortSignal): Promise<void> {
    this.log(`task ${task.id} (${task.kind}, ${task.agent}${task.model ? `/${task.model}` : ""})`);
    const started = performance.now();
    const identity = `task=${task.id} attempt=${task.startedAt ?? "unknown"}`;
    const events = createEventForwarder(this.client, task, signal, this.log, this.opts.eventFlushMs ?? 30_000);
    let cwd: string | undefined;
    const complete = async (state: Completion["state"], summary?: string, error?: string, stopped = false) => {
      // A newer claim of this task may be using the folder.
      if (signal.reason === "superseded") return;
      let delivery: Delivery;
      if (signal.reason === "server-cancelled") {
        // A task the engine cancelled itself is owed no completion. It says on the task whether the session carries on.
        // A task that can't be read keeps its session: the prune takes it later.
        delivery = { landed: true, carriesOn: await this.client.task(task.id, "none").then(({ task: now }) => sessionCarriesOn(now), () => true) };
      } else {
        delivery = await this.postCompletion(task, signal, { state, summary, error, stopped }, identity, started);
      }
      const { landed, carriesOn } = delivery;
      if (cwd) {
        const interrupted = (state === "cancelled" && this.stopped) || stopped || carriesOn;
        await this.cleanupTaskWorkspace(task, cwd, signal, landed, interrupted);
      }
      // A side check is small and many finish together: the request they belong to reads the quota when it ends.
      if (!this.stopped && state !== "cancelled" && !isSideCheck(task)) {
        void this.refreshQuotas({ force: true, agents: [task.agent] });
      }
    };

    if (signal.aborted) return complete("cancelled", undefined, "host shutting down");

    let prepared: Prepared;
    try {
      prepared = await this.prepare(task);
      cwd = prepared.cwd;
    } catch (err) {
      await events.post({ type: "error", text: `Could not prepare task: ${errMsg(err)}` });
      return complete("failed", undefined, errMsg(err));
    }

    if (signal.aborted) return complete("cancelled", undefined, "cancelled");
    const runner = this.opts.runner ?? defaultRunAgent;
    const timeoutMs = this.runTimeoutMs;
    const stallMs = this.opts.stallMs ?? (this.config.stallMinutes ?? DEFAULT_STALL_MS / 60_000) * 60_000;
    const liveUsage = createLiveUsageReporter(this.client, task, signal, this.log);
    let questionSeen: string | undefined;
    // A runner that returns says whether its run ended on a question. Only one that threw leaves the question it saw.
    let runnerThrew = false;
    const run = (p: Prepared, priorUsage?: AgentUsage) => runner({
      agent: task.agent,
      model: task.model ?? this.config.models?.[task.agent],
      effort: task.effort,
      fast: task.fast,
      serviceTier: task.serviceTier,
      systemPrompt: p.systemPrompt,
      instruction: p.instruction,
      resumeSession: p.resumeSession,
      plan: p.plan,
      refusedTool: p.refusedTool,
      workspace: p.workspace,
      cwd: p.cwd,
      mcp: p.mcp,
      signal,
      timeoutMs,
      stallMs,
      env: runnerEnv(task.agent, this.agents, this.env),
      onUsage: snapshot => liveUsage.update(snapshot, priorUsage),
      onQuota: quota => this.applyLiveQuota(task.agent, quota),
      onCodexFallback: reason => this.log(`[host] codex-fallback ${identity} reason=${reason}`),
      onEvent: (ev: RunnerEvent) => {
        this.opts.onRunnerEvent?.(task, ev);
        if (ev.type === "question") {
          questionSeen = ev.text;
          return; // Confirm delivery with the engine when the runner stops.
        }
        if (ev.type === "result") return; // summary goes in complete()
        void events.post({ type: ev.type, text: ev.text, data: ev.data });
      },
    }).catch((err): RunAgentResult => {
      runnerThrew = true;
      return { ok: false, summary: "", error: errMsg(err) };
    });

    let result = await run(prepared);
    // One report per claim replaces the last, so a failed resume's tokens go with the fresh run's.
    let usage = result.usage;
    if (result.resumeFailed && !signal.aborted) {
      // The CLI no longer has the session. Start over with the answers in the prompt.
      this.log(`task ${task.id}: could not resume the CLI session (${result.error ?? "unknown"}); starting a fresh run`);
      try {
        result = await run(await this.prepare(task, true), usage);
      } catch (err) {
        await events.flush();
        await liveUsage.recordFinal(usage);
        await events.post({ type: "error", text: `Could not prepare task: ${errMsg(err)}` });
        return complete("failed", undefined, errMsg(err));
      }
      usage = addUsage(usage, result.usage);
    }
    await events.flush();
    await liveUsage.recordFinal(usage);

    if (signal.aborted || result.aborted) return complete("cancelled", result.summary || undefined, "cancelled");

    const question = result.question ?? (runnerThrew ? questionSeen : undefined);
    if (question) {
      // The CLI can stop before MCP posts, or lose the reply after the engine commits.
      let deliveryError: unknown;
      const delivered = await retryBackoff(3, signal, {
        run: async () => {
          const { waiting } = await this.client.postTaskQuestion(task.id, task.startedAt, question, signal, { sessionId: result.sessionId ?? null });
          this.log(`[host] question ${identity} outcome=${waiting ? "waiting" : "not_waiting"}`);
          // The answer may be days away. The run that carries on writes the token file again.
          if (!this.sharedWithAnotherAttempt(task, signal)) await removeTokenFiles(prepared.cwd).catch((err) => this.log(`could not clean task folder: ${errMsg(err)}`));
        },
        onError: (err) => { deliveryError = err; },
      });
      if (!delivered && !signal.aborted) {
        const error = `Could not deliver the editor question: ${errMsg(deliveryError)}`;
        this.log(`[host] question ${identity} outcome=undelivered`);
        this.log(`task ${task.id}: ${error}`);
        return complete("failed", undefined, error);
      }
      return; // On shutdown, the engine recovers any claim still without a durable question.
    }
    if (result.ok) return complete("done", result.summary || "Done.");
    // Say why the host stopped it: a bare "timed out" reads like a stalled tool or network call.
    const error = result.stalled ? stalledReason(stallMs)
      : result.timedOut && timeoutMs !== undefined ? timedOutReason(timeoutMs) : result.error ?? "agent failed";
    await events.post({ type: "error", text: error });
    return complete("failed", result.summary || undefined, error, !!result.timedOut);
  }

  /**
   * Post a run's completion and log how the engine took it. A post the engine misses is tried again. Forgotten here,
   * the task stays running there until the engine calls it interrupted and runs the finished request a second time. A
   * copy does no harm: the engine ignores the completion of an attempt it has already ended.
   */
  private async postCompletion(task: Task, signal: AbortSignal, { state, summary, error, stopped }: Completion, identity: string, started: number): Promise<Delivery> {
    const body = { state, ifStartedAt: task.startedAt, summary, error, interrupted: (state === "cancelled" && this.stopped) || stopped ? true : undefined };
    let landed = false;
    let carriesOn = false;
    let savedState: TaskState | undefined;
    let superseded = false;
    let changes = 0;
    // One try while the host stops or once the engine cancels/supersedes the task.
    await retryBackoff(3, signal, {
      stopOnAbortAfterFirst: true,
      run: async () => {
        const saved = (await this.client.completeTask(task.id, body))?.task;
        carriesOn = sessionCarriesOn(saved);
        const parsed = TaskState.safeParse(saved?.state);
        if (parsed.success) savedState = parsed.data;
        superseded = !!task.startedAt && !!saved?.startedAt && saved.startedAt !== task.startedAt;
        changes = saved?.changeIds?.length ?? 0;
        landed = true;
      },
      onError: (err) => this.log(`complete failed for task ${task.id}: ${errMsg(err)}`),
    });
    const outcome = !landed ? "undelivered" : superseded ? "superseded" : !savedState ? "unconfirmed" : savedState === state ? "accepted" : "changed";
    // A failed run's reason stays in the local log: the engine may never have received it.
    const reason = state === "failed" ? ` reason=${JSON.stringify((error ?? "no reason given").slice(0, 300))}` : "";
    this.log(`[host] completion ${identity} requested=${state} state=${savedState ?? "unknown"} outcome=${outcome} elapsedMs=${Math.round(performance.now() - started)} changes=${changes}${reason}`);
    return { landed, carriesOn };
  }

  /** Whether another attempt at the same run is at work in the folder this one shares with it. */
  private sharedWithAnotherAttempt(task: Task, signal: AbortSignal): boolean {
    const root = task.resumeRootId ?? task.id;
    return [...this.running.values()].some((r) => r.controller.signal !== signal && r.task.projectId === task.projectId && (r.task.resumeRootId ?? r.task.id) === root);
  }

  /** The optional cap on one run: the host's option, or else the config's minutes. None by default. */
  private get runTimeoutMs(): number | undefined {
    return this.opts.timeoutMs ?? (this.config.timeoutMinutes ? this.config.timeoutMinutes * 60_000 : undefined);
  }

  /** Prepare the task folder, fetch the engine's prompt and build the MCP spec. `fresh` skips resuming the CLI session. */
  async prepare(task: Task, fresh = false): Promise<Prepared> {
    const { task: current } = await this.client.task(task.id, "none");
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
    const prompt = await this.client.taskPrompt(task.id, { workDir: artifacts, fresh, timeLimitMinutes: promptTimeLimit(this.runTimeoutMs) });
    const { systemPrompt, instruction, resumeSession, plan } = prompt;
    // Read with care: an engine from before it had the words leaves them out.
    const refused = (prompt as { refusedTool?: unknown }).refusedTool;
    const refusedTool = typeof refused === "string" && refused.trim() ? refused : undefined;
    // An engine from before the full toolset leaves it out: the run then has Scarlet's tools only, as it did.
    const workspace = (prompt as { workspace?: unknown }).workspace === true ? await workspaceTools(cwd, this.env) : undefined;

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
    return { systemPrompt, instruction, resumeSession, plan, refusedTool, workspace, cwd, mcp };
  }
}

/** The agent with a fresh subscription quota, which names the agent's plan when detection didn't. */
function withQuota(agent: AgentAvailability, quota: SubscriptionQuota): AgentAvailability {
  const plan = quota.plan ?? agent.plan;
  return { ...agent, ...(plan && !agent.plan ? { plan } : {}), quota: { ...quota, ...(plan ? { plan } : {}) } };
}

/** Whether the engine says this attempt's CLI session carries on in a later attempt. Read with care, as an older engine leaves it out. */
function sessionCarriesOn(task: unknown): boolean {
  return (task as { sessionCarriesOn?: unknown } | undefined)?.sessionCarriesOn === true;
}

/** Run `run` up to `attempts` times with 250ms linear backoff, respecting `signal`. Returns true on success. */
async function retryBackoff(
  attempts: number,
  signal: AbortSignal,
  opts: { run: () => Promise<void>; onError?: (err: unknown) => void; stopOnAbortAfterFirst?: boolean },
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted && (!opts.stopOnAbortAfterFirst || attempt > 0)) return false;
    try {
      await opts.run();
      return true;
    } catch (err) {
      if (signal.aborted && !opts.stopOnAbortAfterFirst) return false;
      opts.onError?.(err);
      if (attempt < attempts - 1) await delay(250 * (attempt + 1), undefined, { signal }).catch(() => undefined);
    }
  }
  return false;
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === status;
}
