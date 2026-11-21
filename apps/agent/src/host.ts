/**
 * The local agent host daemon: registers with the Scarlet server, heartbeats,
 * claims tasks (long-poll + WebSocket wake-ups), runs them through the chosen
 * CLI runner, streams events back and completes them.
 */
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, platform, release } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { AgentAvailability, AgentId, AgentUsage, CreateTaskRequest, Task, TaskEvent } from "@scarlet/shared";
import { isSideCheck, ScarletClient, sideCheckSlots, TaskState } from "@scarlet/shared";
import { privateDirectory } from "./private-files.js";
import type { AgentConfig } from "./config.js";
import { CLI_AGENTS, detect as detectAgents, runnerEnv } from "./detect.js";
import { killStoppedNow, stopOrphans } from "./processTree.js";
import { runAgent as defaultRunAgent } from "./runners/index.js";
import { codexHomeDir } from "./runners/codex.js";
import { addUsage } from "./runners/usage.js";
import { mcpEnv, nodeExecutable, resolveMcpCliPath } from "./runners/spawn.js";
import { DEFAULT_STALL_MS, type McpSpec, type RunAgentFn, type RunAgentResult, type RunnerEvent, type Workspace } from "./runners/types.js";
import { workspaceTools } from "./workspaceTools.js";

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
    this.stopController = new AbortController();
    const [agents] = await Promise.all([
      (this.opts.detect ?? (() => detectAgents({ models: this.config.models, log: this.log })))(),
      // An old folder's Claude sessions go with it, wherever Claude Code keeps its files.
      pruneTaskDirs(this.opts.workRoot, undefined, claudeConfigDir(this.opts.env ?? process.env)).catch((err) => this.log(`could not prune old task folders: ${errMsg(err)}`)),
      this.stopOrphans(),
    ]);
    this.agents = agents;
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
    this.agents = await (this.opts.detect ?? (() => detectAgents({ models: this.config.models, log: this.log })))();
    await this.register();
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
        await this.runTask(claimed, signal);
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
    const limit = Math.min(8, Math.max(1, this.config.maxParallel ?? 3));
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

  async runTask(task: Task, signal: AbortSignal): Promise<void> {
    this.log(`task ${task.id} (${task.kind}, ${task.agent}${task.model ? `/${task.model}` : ""})`);
    const started = performance.now();
    const identity = `task=${task.id} attempt=${task.startedAt ?? "unknown"}`;
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
      // The engine handed this attempt's CLI session to the attempt that resumes it, as a pause of the project's editing does.
      let carriesOn = false;
      if (signal.reason === "server-cancelled") {
        // It says so on the task it cancelled. A task that can't be read keeps its session: the prune takes it later.
        carriesOn = await this.client.task(task.id, "none").then(({ task: now }) => sessionCarriesOn(now), () => true);
      } else {
        const body = { state, ifStartedAt: task.startedAt, summary, error, interrupted: (state === "cancelled" && this.stopped) || stopped ? true : undefined };
        // A post the engine misses is tried again. Forgotten here, the task stays running there until the engine
        // calls it interrupted and runs the finished request a second time. A copy does no harm: the engine ignores
        // the completion of an attempt it has already ended.
        landed = false;
        // The engine answers with the changes it holds for the task, for the line below.
        let savedState: TaskState | undefined;
        let superseded = false;
        let changes = 0;
        for (let attempt = 0; attempt < 3 && !landed; attempt++) {
          // One try while the host stops: stopping doesn't wait on an engine that may already be gone. No further
          // try either once the engine cancels the task or hands it out again: it has ended this attempt itself.
          if (attempt && signal.aborted) break;
          try {
            const saved = (await this.client.completeTask(task.id, body))?.task;
            carriesOn = sessionCarriesOn(saved);
            const parsed = TaskState.safeParse(saved?.state);
            if (parsed.success) savedState = parsed.data;
            superseded = !!task.startedAt && !!saved?.startedAt && saved.startedAt !== task.startedAt;
            changes = saved?.changeIds?.length ?? 0;
            landed = true;
          } catch (err) {
            this.log(`complete failed for task ${task.id}: ${errMsg(err)}`);
            if (attempt < 2) await delay(250 * (attempt + 1), undefined, { signal }).catch(() => undefined);
          }
        }
        const outcome = !landed ? "undelivered" : superseded ? "superseded" : !savedState ? "unconfirmed" : savedState === state ? "accepted" : "changed";
        // A failed run's reason stays in the local log: the engine may never have received it.
        const reason = state === "failed" ? ` reason=${JSON.stringify((error ?? "no reason given").slice(0, 300))}` : "";
        this.log(`[host] completion ${identity} requested=${state} state=${savedState ?? "unknown"} outcome=${outcome} elapsedMs=${Math.round(performance.now() - started)} changes=${changes}${reason}`);
      }
      if (cwd) {
        // An attempt the editor stopped can still be winding down when the attempt that resumes it is at work in
        // the folder they share. While another attempt is there, the folder and its CLI session are left to it,
        // to clean when it ends.
        if (this.sharedWithAnotherAttempt(task, signal)) {
          this.log(`task ${task.id}: left its folder to another attempt at the same run`);
          return;
        }
        // Resolve before the folder can go: Claude Code names its project folder after the real path.
        const real = task.agent === "claude" ? await realpath(cwd).catch(() => undefined) : undefined;
        await removeControlFiles(cwd).catch((err) => this.log(`could not clean task folder: ${errMsg(err)}`));
        // A run the host cut short keeps its CLI session: the attempt that resumes it carries on there.
        // So does one whose completion never landed: the engine takes it for interrupted and resumes it.
        // The folder's prune removes it if nothing ever does.
        // So does one the engine handed on to the attempt that resumes it.
        const interrupted = (state === "cancelled" && this.stopped) || stopped || carriesOn;
        if (real && landed && !interrupted) {
          await removeClaudeSessions(real, claudeConfigDir(this.opts.env ?? process.env)).catch((err) => this.log(`could not remove Claude sessions: ${errMsg(err)}`));
        }
        // A Codex run keeps its thread in a home beside the folder, on the same terms.
        if (task.agent === "codex" && landed && !interrupted) {
          await rm(codexHomeDir(cwd), { recursive: true, force: true }).catch((err) => this.log(`could not remove the Codex home: ${errMsg(err)}`));
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
    // The engine replaces repeated usage reports for the same claim. Serialize writes and wait for the
    // in-flight report before persisting the final total so slower requests cannot overwrite it.
    const startedAt = task.startedAt;
    let usageClosed = false;
    let pendingUsage: AgentUsage | undefined;
    let postedUsage: Promise<void> | undefined;
    let nextUsageAt = 0;
    let usageTimer: NodeJS.Timeout | undefined;
    const flushUsage = () => {
      clearTimeout(usageTimer);
      if (usageClosed || signal.aborted || !pendingUsage || postedUsage) return;
      const wait = nextUsageAt - Date.now();
      if (wait > 0) {
        usageTimer = setTimeout(flushUsage, wait).unref();
        return;
      }
      const body = { ...pendingUsage, startedAt };
      pendingUsage = undefined;
      postedUsage = this.client.withResource("tasks", task.id, path => this.client.request<void>(
        "POST", path + "/usage", body, { signal: AbortSignal.timeout(5000) },
      )).catch(err => this.log(`task ${task.id}: live usage report failed: ${errMsg(err)}`)).finally(() => {
        postedUsage = undefined;
        nextUsageAt = Date.now() + 2000;
        flushUsage();
      });
    };
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
      env: runnerEnv(task.agent, this.agents, this.opts.env ?? process.env),
      onUsage: snapshot => {
        if (!startedAt || usageClosed) return;
        pendingUsage = addUsage(priorUsage, snapshot);
        flushUsage();
      },
      onCodexFallback: reason => this.log(`[host] codex-fallback ${identity} reason=${reason}`),
      onEvent: (ev: RunnerEvent) => {
        this.opts.onRunnerEvent?.(task, ev);
        if (ev.type === "question") {
          questionSeen = ev.text;
          return; // Confirm delivery with the engine when the runner stops.
        }
        if (ev.type === "result") return; // summary goes in complete()
        void post({ type: ev.type, text: ev.text, data: ev.data });
      },
    }).catch((err): RunAgentResult => {
      runnerThrew = true;
      return { ok: false, summary: "", error: errMsg(err) };
    });

    // Record tokens for every outcome, including a cancel or a pause for a question.
    const recordUsage = async (usage: AgentUsage | undefined) => {
      usageClosed = true;
      clearTimeout(usageTimer);
      await postedUsage;
      if (usage) await this.client.recordTaskUsage(task.id, { ...usage, startedAt: task.startedAt }).catch(err => this.log(`usage report failed: ${errMsg(err)}`));
    };
    let result = await run(prepared);
    // One report per claim replaces the last, so a failed resume's tokens go with the fresh run's.
    let usage = result.usage;
    if (result.resumeFailed && !signal.aborted) {
      // The CLI no longer has the session. Start over with the answers in the prompt.
      this.log(`task ${task.id}: could not resume the CLI session (${result.error ?? "unknown"}); starting a fresh run`);
      try {
        result = await run(await this.prepare(task, true), usage);
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

    const question = result.question ?? (runnerThrew ? questionSeen : undefined);
    if (question) {
      // The CLI can stop before MCP posts, or lose the reply after the engine commits.
      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
        try {
          const { waiting } = await this.client.postTaskQuestion(task.id, task.startedAt, question, signal, { sessionId: result.sessionId ?? null });
          this.log(`[host] question ${identity} outcome=${waiting ? "waiting" : "not_waiting"}`);
          // The answer may be days away. The run that carries on writes the token file again.
          if (!this.sharedWithAnotherAttempt(task, signal)) await removeTokenFiles(prepared.cwd).catch((err) => this.log(`could not clean task folder: ${errMsg(err)}`));
          return;
        } catch (err) {
          if (signal.aborted) break;
          if (attempt === 2) {
            const error = `Could not deliver the editor question: ${errMsg(err)}`;
            this.log(`[host] question ${identity} outcome=undelivered`);
            this.log(`task ${task.id}: ${error}`);
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
    const workspace = (prompt as { workspace?: unknown }).workspace === true ? await workspaceTools(cwd, this.opts.env ?? process.env) : undefined;

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

/** Whether the engine says this attempt's CLI session carries on in a later attempt. Read with care, as an older engine leaves it out. */
function sessionCarriesOn(task: unknown): boolean {
  return (task as { sessionCarriesOn?: unknown } | undefined)?.sessionCarriesOn === true;
}

/** The files of a run's folder that hold the engine token: Claude Code's MCP config. */
export async function removeTokenFiles(dir: string): Promise<void> {
  await rm(join(dir, ".scarlet", "mcp.json"), { force: true });
}

/** A finished task keeps only its artifacts. The CLI control files include the engine token. */
export async function removeControlFiles(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(entries.filter((name) => name !== "artifacts").map((name) => rm(join(dir, name), { recursive: true, force: true })));
  if (!entries.includes("artifacts")) await rm(dir, { recursive: true, force: true });
}

/** Where Claude Code keeps its files: CLAUDE_CONFIG_DIR when set, else ~/.claude. Undefined for a relative setting, read from each run's own folder. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const set = env.CLAUDE_CONFIG_DIR;
  if (!set) return join(home, ".claude");
  return isAbsolute(set) ? set : undefined;
}

/** Claude Code names a cwd's project folder after its real path, every character other than a letter or digit as "-". */
function claudeProjectName(realCwd: string): string | undefined {
  const name = realCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return /[a-zA-Z0-9]/.test(name) ? name : undefined;
}

/** Claude Code cuts a project folder's name at this many characters and adds a hash of the path to it. */
const CLAUDE_NAME_MAX = 200;

/**
 * Claude Code keeps a cwd's sessions in <its folder>/projects/<project name>. A name over 200 characters is cut there
 * and ends in a hash Scarlet can't reproduce: those are found by `claudeProjectDirs`.
 */
export function claudeProjectDir(realCwd: string, claudeDir = claudeConfigDir()): string | undefined {
  const name = claudeProjectName(realCwd);
  return !claudeDir || !name || name.length > CLAUDE_NAME_MAX ? undefined : join(claudeDir, "projects", name);
}

/**
 * The project folders holding a cwd's Claude sessions. A long path's folder is `<first 200 characters>-<hash>`, and
 * other task folders can share those characters, so one counts only where a session in it was run in this cwd.
 */
export async function claudeProjectDirs(realCwd: string, claudeDir = claudeConfigDir()): Promise<string[]> {
  const name = claudeProjectName(realCwd);
  if (!claudeDir || !name) return [];
  const isDir = async (dir: string) => (await lstat(dir).catch(() => undefined))?.isDirectory() === true;
  if (name.length <= CLAUDE_NAME_MAX) {
    const dir = join(claudeDir, "projects", name);
    return (await isDir(dir)) ? [dir] : [];
  }
  const prefix = `${name.slice(0, CLAUDE_NAME_MAX)}-`;
  const found: string[] = [];
  for (const entry of await readdir(join(claudeDir, "projects")).catch(() => [] as string[])) {
    if (!entry.startsWith(prefix) || !/^[0-9a-zA-Z]+$/.test(entry.slice(prefix.length))) continue;
    const dir = join(claudeDir, "projects", entry);
    if (await isDir(dir) && await sessionsRanIn(dir, realCwd)) found.push(dir);
  }
  return found;
}

/** Whether a session in this project folder records the cwd it ran in as this one. Each message line names it. */
async function sessionsRanIn(dir: string, realCwd: string): Promise<boolean> {
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).slice(0, 5)) {
    const file = await open(join(dir, name), "r").catch(() => undefined);
    if (!file) continue;
    try {
      const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(64 * 1024), position: 0 });
      for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
        let cwd: unknown;
        try {
          cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        } catch {
          continue;
        }
        if (typeof cwd === "string") return cwd === realCwd;
      }
    } finally {
      await file.close();
    }
  }
  return false;
}

/** A folder whose Claude sessions are Scarlet's to remove: a task folder, or a one-shot folder an older `scarlet-agent run` made. */
function scarletRunFolder(realCwd: string): boolean {
  return basename(dirname(realCwd)) === "tasks-v2" || basename(realCwd).startsWith("oneshot-");
}

/**
 * Delete the Claude sessions of one finished Scarlet task: only the project folder named after its task folder,
 * and the to-do list of each session in it.
 */
export async function removeClaudeSessions(realCwd: string, claudeDir = claudeConfigDir()): Promise<void> {
  if (!claudeDir || !scarletRunFolder(realCwd)) return;
  for (const dir of await claudeProjectDirs(realCwd, claudeDir)) {
    // Claude Code keeps a session's to-do list apart from it, in <its folder>/tasks/<session id>, and a session
    // is `<session id>.jsonl` here. Only a name of hex digits and dashes is read as an id: "...jsonl" would
    // name the folder itself. A list that can't be removed is left.
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const id = /^([0-9a-fA-F-]+)\.jsonl$/.exec(name)?.[1];
      const list = id && join(claudeDir, "tasks", id);
      if (list && (await lstat(list).catch(() => undefined))?.isDirectory()) await rm(list, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true });
  }
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

/** Remove task folders unused for TASK_DIR_DAYS, including artifacts. Given where Claude Code keeps its files, a task folder's Claude sessions go with it. */
export async function pruneTaskDirs(workRoot: string, now = Date.now(), claudeDir?: string): Promise<void> {
  const cutoff = now - TASK_DIR_DAYS * 86_400_000;
  const dirs = [
    ...(await readdir(join(workRoot, "tasks-v2")).catch(() => [] as string[])).map((name) => join(workRoot, "tasks-v2", name)),
    ...(await readdir(workRoot).catch(() => [] as string[])).filter((name) => name.startsWith("oneshot-")).map((name) => join(workRoot, name)),
  ];
  await Promise.all(dirs.map(async (dir) => {
    const used = await lastUsed(dir);
    if (used === undefined || used >= cutoff) return;
    // A run that never finished left its Claude sessions behind. Resolve before the folder goes: its real path names them.
    const real = claudeDir === undefined ? undefined : await realpath(dir).catch(() => undefined);
    try {
      if (real) await removeClaudeSessions(real, claudeDir);
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
