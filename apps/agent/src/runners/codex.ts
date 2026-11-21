/**
 * Codex CLI runner.
 *
 * The private App Server reports cumulative usage during an ephemeral turn.
 * Keep `exec --json` for CLI versions and authentication modes that cannot use
 * the isolated server. Answers reach a fresh run through the replayed Q&A.
 */
import { lstat, mkdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { apiKeyVars, stripVars } from "../detect.js";
import { privateDirectory, writePrivateFile } from "../private-files.js";
import { briefInput, COMPACTED, DEFAULT_STALL_MS, isQuestionTool, planEvent, questionText, workspaceEnv, type CodexFallbackReason, type RunAgentOptions, type RunAgentResult, type RunnerEvent } from "./types.js";
import { earlyResult, jsonLine, resolveCli, spawnLines, tailSummary } from "./spawn.js";
import { addUsage, codexUsage, tokenCount, usageWithModel } from "./usage.js";
import type { AgentUsage, PlanStep } from "@scarlet/shared";

export interface CodexParseState {
  texts: string[];
  lastMessage?: string;
  question?: string;
  questionPosted: boolean;
  shouldStop: boolean;
  failed?: string;
  /** The latest reconnect notice. Codex recovers from most, so it fails the run only if nothing else explains a failure. */
  retryNotice?: string;
  turnCompleted: boolean;
  usage?: AgentUsage;
  /** The plan last passed on, so one Codex repeats isn't sent twice. */
  plan?: string;
}

/**
 * The steps of a `todo_list` item: Codex's `update_plan`, as `codex exec --json` reports it. Each step is its text and
 * whether it is finished. The stream leaves out which step is under way, so none is "in_progress".
 */
function codexPlan(items: unknown): PlanStep[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((entry): PlanStep[] => {
    const { text, completed } = (entry ?? {}) as { text?: unknown; completed?: unknown };
    return typeof text === "string" && text.trim() ? [{ text: text.trim(), state: completed === true ? "done" : "pending" }] : [];
  });
}

/** Codex reports stream retries and its HTTPS fallback as errors, then usually carries on. */
function isRetryNotice(text: string) {
  return /^Reconnecting\.{3} \d+\/\d+/.test(text) || /^Falling back from WebSockets/.test(text);
}

export function newCodexState(): CodexParseState {
  return { texts: [], questionPosted: false, shouldStop: false, turnCompleted: false };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  changes?: unknown;
  query?: string;
  items?: unknown;
  message?: string;
}

/** Parse one JSONL line from `codex exec --json`. */
export function parseCodexLine(line: string, st: CodexParseState): RunnerEvent[] {
  // Anything that isn't one JSON object (a warning, null, a number, a list) is noise: surface it as a log line.
  const msg = jsonLine(line);
  return msg ? parseCodexEvent(msg, st) : [{ type: "log", text: line }];
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const SERVER_STOP_GRACE_MS = 2000;

function parseCodexEvent(msg: Record<string, unknown>, st: CodexParseState): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  const type = msg.type as string | undefined;
  const item = (msg.item as CodexItem | undefined) ?? undefined;
  const itemText = typeof item?.text === "string" ? item.text : undefined;

  switch (type) {
    case "thread.started":
      events.push({ type: "log", text: `Codex session started${msg.thread_id ? ` (${String(msg.thread_id)})` : ""}`, data: { kind: "init", threadId: msg.thread_id } });
      break;
    case "turn.started":
      break;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      if (!item) break;
      const completed = type === "item.completed";
      switch (item.type) {
        case "agent_message":
          if (completed && itemText?.trim()) {
            st.texts.push(itemText);
            st.lastMessage = itemText;
            events.push({ type: "log", text: itemText });
          }
          break;
        case "reasoning":
          // Summarised reasoning: useful as progress but noisy; keep short.
          if (completed && itemText?.trim()) events.push({ type: "log", text: `(thinking) ${briefInput(itemText, 200)}`, data: { kind: "reasoning" } });
          break;
        case "command_execution":
          if (type === "item.started") {
            events.push({ type: "tool", text: `shell ${briefInput(item.command, 200)}`, data: { tool: "command_execution", command: item.command } });
          } else if (completed && item.exit_code !== undefined && item.exit_code !== 0) {
            events.push({ type: "error", text: `Command exited ${item.exit_code}: ${briefInput(item.command, 120)}\n${briefInput(item.aggregated_output, 400)}` });
          }
          break;
        case "mcp_tool_call": {
          const name = `${item.server ?? "mcp"}.${item.tool ?? "?"}`;
          const text = isQuestionTool(item.tool) ? questionText(item.arguments) : undefined;
          if (text !== undefined) {
            // Held from the start, should the CLI stop before its result, and said once the engine has it.
            if (!completed) st.question = text;
            else if (item.status === "failed" || item.error) {
              // A question Scarlet refused was never asked: the model hears why and carries on, so the run does too.
              st.question = undefined;
              events.push({ type: "error", text: `${name} failed: ${briefInput(item.error ?? item.result, 400)}` });
            } else {
              st.question = text;
              st.questionPosted = true;
              st.shouldStop = true;
              events.push({ type: "question", text, data: { tool: name, itemId: item.id } });
            }
          } else if (type === "item.started") {
            events.push({ type: "tool", text: `${name} ${briefInput(item.arguments)}`.trim(), data: { tool: name, input: item.arguments, itemId: item.id } });
          } else if (completed && (item.status === "failed" || item.error)) {
            events.push({ type: "error", text: `${name} failed: ${briefInput(item.error ?? item.result, 400)}` });
          }
          break;
        }
        case "file_change":
          if (completed) events.push({ type: "tool", text: `edited files ${briefInput(item.changes, 200)}`, data: { tool: "file_change" } });
          break;
        case "web_search":
          if (type === "item.started") events.push({ type: "tool", text: `web search ${briefInput(item.query, 120)}`, data: { tool: "web_search" } });
          break;
        case "todo_list": {
          // The whole plan each time: when the model first makes it, on every update, and once more as the turn ends.
          const steps = codexPlan(item.items);
          const plan = JSON.stringify(steps);
          if (steps && plan !== st.plan) {
            st.plan = plan;
            events.push(planEvent(steps));
          }
          break;
        }
        case "error": {
          const text = item.message ?? briefInput(item, 400);
          events.push(isRetryNotice(text) ? { type: "log", text, data: { kind: "connection" } } : { type: "error", text });
          break;
        }
        default:
          break;
      }
      break;
    }
    case "turn.completed":
      st.turnCompleted = true;
      st.usage = addUsage(st.usage, codexUsage(msg.usage));
      events.push({ type: "result", text: st.lastMessage ?? "done", data: { usage: msg.usage } });
      break;
    case "turn.failed": {
      // An empty message says no more than a missing one: show the error as Codex wrote it, or say only that the turn failed.
      const err = (msg.error as { message?: string } | undefined)?.message || briefInput(msg.error, 400) || "turn failed";
      st.failed = err;
      events.push({ type: "error", text: err });
      break;
    }
    case "error": {
      const err = (msg.message as string | undefined) || briefInput(msg, 400);
      if (isRetryNotice(err)) {
        st.retryNotice = err;
        events.push({ type: "log", text: err, data: { kind: "connection" } });
      } else {
        st.failed = err;
        events.push({ type: "error", text: err });
      }
      break;
    }
    default:
      break;
  }
  return events;
}

/** TOML basic string. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

export function tomlInlineTable(obj: Record<string, string>): string {
  const body = Object.entries(obj)
    .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)}=${tomlString(v)}`)
    .join(",");
  return `{${body}}`;
}

export interface CodexCommand {
  file: string;
  args: string[];
  stdin?: string;
  files: Record<string, string>;
  lastMessagePath: string;
}

export function buildCodexCommand(
  opts: Pick<RunAgentOptions, "model" | "effort" | "fast" | "serviceTier" | "systemPrompt" | "instruction" | "mcp" | "cwd" | "plan" | "workspace">,
  bin: string,
  tmpDir: string,
): CodexCommand {
  const executable = codexExecutable(bin);
  const lastMessagePath = join(tmpDir, "last-message.md");
  return {
    file: executable ?? bin,
    args: ["exec", "--json", "--skip-git-repo-check", "--cd", opts.cwd, "--strict-config", "--ignore-user-config", "--ignore-rules", "--ephemeral",
      // The task folder is the project: an AGENTS.md in a git repository around it (a work root inside a checkout)
      // would otherwise load beside Scarlet's, as App Server is already told.
      ...codexConfig(opts, executable), "-c", "project_root_markers=[]", "--output-last-message", lastMessagePath, ...(opts.model ? ["--model", opts.model] : []), ...codexModelConfig(opts), "-"],
    stdin: opts.instruction,
    files: { [join(opts.cwd, "AGENTS.md")]: opts.systemPrompt },
    lastMessagePath,
  };
}

function codexExecutable(bin: string): string | undefined {
  // Seatbelt must be able to re-execute Codex while loading AGENTS.md. Launch the
  // real file: granting its target alone does not permit a Homebrew symlink.
  let executable: string | undefined;
  if (process.platform === "darwin") {
    try { executable = realpathSync(bin); } catch { /* Keep normal missing-CLI reporting. */ }
  }
  return executable;
}

/** Codex features a side check runs without. A request's agent keeps its shell and its look at pictures it made. */
const CODEX_OFF = ["computer_use", "multi_agent", "plugins", "apps", "hooks"];

function codexConfig(opts: Pick<RunAgentOptions, "mcp" | "plan" | "workspace">, executable: string | undefined): string[] {
  // Forward slashes keep the TOML readable and work for node on Windows.
  const toToml = (p: string) => p.replace(/\\/g, "/");
  const ws = opts.workspace;
  // The programs the shell's links point at: readable, never writable. Everything else outside the task folder stays closed.
  const reads = [...(executable ? [executable] : []), ...(ws?.readDirs ?? [])].map((p) => `,${tomlString(toToml(p))}="read"`).join("");
  return [
    // The legacy Windows sandboxes cannot enforce this profile's denied root reads.
    ...(process.platform === "win32" ? ["-c", 'windows.sandbox="mxc"'] : []),
    ...(ws ? CODEX_OFF : ["shell_tool", "view_image", ...CODEX_OFF]).flatMap((feature) => ["--disable", feature]),
    "-c", 'approval_policy="never"',
    // A request's agent searches the live web; a side check has none.
    "-c", `web_search=${ws ? '"live"' : '"disabled"'}`,
    // Codex otherwise reads only the first 32 KiB of AGENTS.md. The prompt lists every clip ahead of the task, the
    // editor's notes, their earlier answers and their skills, so on a long timeline those would be cut off.
    "-c", "project_doc_max_bytes=4194304",
    // Codex's own to-do tool, which it reports as `todo_list` items. A Codex without this key refuses it under --strict-config.
    ...(opts.plan ? ["-c", "tools.update_plan.enabled=true"] : []),
    "-c", 'default_permissions="scarlet"',
    "-c", `permissions.scarlet.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"}${reads}}`,
    // A request's shell reaches the web, for the pages and clips it brings in. Scarlet's token stays out of the shell
    // (`shell_environment_policy` below), so the engine is no nearer than before.
    "-c", `permissions.scarlet.network.enabled=${ws ? "true" : "false"}`,
    "-c", 'mcp_servers.scarlet.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.scarlet.required=true",
    "-c", "mcp_servers.scarlet.startup_timeout_sec=60",
    // Scarlet's tools wait up to `toolWaitSeconds` (capabilities.ts) for evidence still being measured.
    "-c", "mcp_servers.scarlet.tool_timeout_sec=300",
    "-c",
    `mcp_servers.scarlet.command=${tomlString(toToml(opts.mcp.command))}`,
    "-c",
    `mcp_servers.scarlet.args=[${opts.mcp.args.map((a) => tomlString(toToml(a))).join(",")}]`,
    "-c",
    `mcp_servers.scarlet.env_vars=[${Object.keys(opts.mcp.env).sort().map(tomlString).join(",")}]`,
    "-c",
    'shell_environment_policy.exclude=["SCARLET_*"]',
  ];
}

function codexModelConfig(opts: Pick<RunAgentOptions, "effort" | "serviceTier" | "fast">): string[] {
  return [
    ...(opts.effort ? ["-c", `model_reasoning_effort=${tomlString(opts.effort)}`] : []),
    ...(opts.serviceTier || opts.fast ? ["-c", `service_tier=${tomlString(opts.serviceTier ?? "fast")}`] : []),
  ];
}

async function isolatedCodexHome(cwd: string, env: NodeJS.ProcessEnv): Promise<{ home: string } | { reason: CodexFallbackReason }> {
  // App Server cannot skip the user's config, rules or MCP servers. Share only
  // file-backed login, with a symlink so Codex can still refresh that login.
  const keyNames = apiKeyVars("codex");
  if (Object.entries(env).some(([name, value]) => value && keyNames.includes(name.toUpperCase()))) return { reason: "api_key" };
  const projectConfig = await lstat(join(cwd, ".codex")).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  if (projectConfig) return { reason: "project_config" };
  const configuredHome = Object.entries(env).find(([name]) => name.toUpperCase() === "CODEX_HOME")?.[1];
  const originalHome = await realpath(resolve(cwd, configuredHome || join(homedir(), ".codex"))).catch(() => undefined);
  if (!originalHome) return { reason: "home_unavailable" };
  const authFile = join(originalHome, "auth.json");
  const auth = await stat(authFile).catch(() => undefined);
  if (!auth?.isFile() || !auth.size) return { reason: "auth_unavailable" };
  const home = codexHomeDir(cwd);
  try {
    await privateDirectory(home);
    // Only Scarlet writes configuration here. Codex's own state (its threads and their database) stays.
    for (const config of ["config.toml", "managed_config.toml"]) {
      if (await lstat(join(home, config)).catch(() => undefined)) return { reason: "isolation_unavailable" };
    }
    // Linked again on each run: the login may have moved since the last one. The store locks around refresh commits,
    // so the lock is the ordinary CLI's too.
    for (const [from, name] of [[authFile, "auth.json"], [join(originalHome, "auth.lock"), "auth.lock"]] as const) {
      await rm(join(home, name), { force: true });
      await symlink(from, join(home, name), "file");
    }
    return { home };
  } catch {
    return { reason: "isolation_unavailable" };
  }
}

/**
 * The run's own Codex home, beside its task folder: outside the folder the agent may write to, and the same for every
 * attempt at the task (the folder is keyed by the run's first task id), so a run cut short or paused on a question
 * resumes its thread. The host removes it once the task lands; the task folders' prune takes one left behind.
 */
export function codexHomeDir(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}.codex`;
}

const serverItemTypes: Record<string, string> = {
  agentMessage: "agent_message", reasoning: "reasoning", commandExecution: "command_execution",
  mcpToolCall: "mcp_tool_call", fileChange: "file_change", webSearch: "web_search",
};

function serverItem(item: Record<string, unknown>): CodexItem {
  return {
    ...item,
    type: serverItemTypes[string(item.type) ?? ""],
    text: string(item.text) ?? (Array.isArray(item.summary) ? item.summary.filter(part => typeof part === "string").join("\n") : undefined),
    aggregated_output: string(item.aggregatedOutput),
    exit_code: typeof item.exitCode === "number" ? item.exitCode : undefined,
  };
}

const BREAKDOWN = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
type Breakdown = Record<typeof BREAKDOWN[number], number>;

/** One of App Server's token counts (`total`, the thread's, or `last`, the latest model call's). */
function breakdown(value: unknown): Breakdown | undefined {
  const counts = object(value);
  return counts && Object.fromEntries(BREAKDOWN.map(key => [key, tokenCount(counts[key])])) as Breakdown;
}

function minus(a: Breakdown, b: Breakdown | undefined): Breakdown {
  return Object.fromEntries(BREAKDOWN.map(key => [key, Math.max(0, a[key] - (b?.[key] ?? 0))])) as Breakdown;
}

/**
 * What a thread resumed in this run had counted before it: its total on the first update, less the call that update
 * is about. The engine adds up each claim's report, so the earlier attempt's tokens must not count again here. Zero
 * when Codex starts a resumed thread's count afresh.
 */
function resumedBaseline(value: unknown): Breakdown | undefined {
  const total = breakdown(object(value)?.total);
  return total && minus(total, breakdown(object(value)?.last));
}

/** The thread's tokens as App Server counts them, less what it had counted before this run. */
function serverUsage(value: unknown, model?: string, baseline?: Breakdown): AgentUsage | undefined {
  const all = breakdown(object(value)?.total);
  const total = all && minus(all, baseline);
  return total && codexUsage({ input_tokens: total.inputTokens, cached_input_tokens: total.cachedInputTokens,
    cache_write_input_tokens: total.cacheWriteInputTokens, output_tokens: total.outputTokens, reasoning_output_tokens: total.reasoningOutputTokens }, model);
}

function serverPlan(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): PlanStep[] => {
    const step = object(entry);
    const text = string(step?.step)?.trim();
    const status = step?.status;
    if (!text) return [];
    return [{ text, state: status === "completed" ? "done" : status === "inProgress" ? "in_progress" : "pending" }];
  });
}

function serverError(value: unknown) {
  const error = object(value);
  const message = string(error?.message);
  const detail = string(error?.additionalDetails);
  return message && detail ? `${message} (${detail})` : message;
}

async function runCodexServer(opts: RunAgentOptions, env: NodeJS.ProcessEnv, bin: string, home: string): Promise<RunAgentResult | undefined> {
  const executable = codexExecutable(bin);
  const args = ["app-server", "--strict-config", ...codexConfig({ mcp: opts.mcp, workspace: opts.workspace }, executable),
    "-c", "project_root_markers=[]", "-c", 'cli_auth_credentials_store="file"',
    "-c", `tools.update_plan.enabled=${!!opts.plan}`, "-c", "tools.experimental_request_user_input.enabled=false", "--disable", "goals",
    ...codexModelConfig({ effort: opts.effort })];
  const state = newCodexState();
  const serviceTier = opts.serviceTier ?? (opts.fast ? "fast" : undefined);
  let threadId: string | undefined;
  let turnId: string | undefined;
  let turnRequested = false;
  let startupFailure: CodexFallbackReason | undefined;
  let interrupted = false;
  let completed = false;
  let model = opts.model;
  let finalMessage: string | undefined;
  let planText: string | undefined;
  let stopTimer: NodeJS.Timeout | undefined;
  const pendingEvents: [string, Record<string, unknown>][] = [];
  const send = (message: Record<string, unknown>) => handle.child.stdin?.write(`${JSON.stringify(message)}\n`);
  const complete = () => {
    completed = true;
    handle.child.stdin?.end();
    stopTimer ??= setTimeout(handle.kill, SERVER_STOP_GRACE_MS).unref();
  };
  const interrupt = () => {
    if (completed || interrupted) return true;
    if (!threadId || !turnId) return false;
    interrupted = true;
    send({ id: 4, method: "turn/interrupt", params: { threadId, turnId } });
    return true;
  };
  const emit = (event: Record<string, unknown>) => {
    for (const e of parseCodexEvent(event, state)) opts.onEvent(e);
  };

  let compactionItems = false;
  let baseline: Breakdown | undefined;
  const notify = (method: string, params: Record<string, unknown>) => {
    const eventTurn = string(params.turnId) ?? string(object(params.turn)?.id);
    if (completed || !eventTurn || eventTurn !== turnId) return;
    switch (method) {
      case "thread/tokenUsage/updated": {
        if (opts.resumeSession) baseline ??= resumedBaseline(params.tokenUsage);
        const usage = serverUsage(params.tokenUsage, model, baseline);
        if (!usage || JSON.stringify(usage) === JSON.stringify(state.usage)) break;
        state.usage = usage;
        opts.onUsage?.(usage);
        break;
      }
      // Codex compacted the thread's context. Newer versions report it as an item too, and that one counts.
      case "thread/compacted":
        if (!compactionItems) opts.onEvent(COMPACTED);
        break;
      case "item/started":
      case "item/completed": {
        const item = object(params.item);
        if (!item) break;
        if (item.type === "contextCompaction") {
          compactionItems = true;
          if (method === "item/completed") opts.onEvent(COMPACTED);
          break;
        }
        if (method === "item/completed") {
          const text = string(item.text)?.trim();
          if (item.type === "agentMessage" && item.phase === "final_answer" && text) finalMessage = text;
          if (item.type === "plan" && text) planText = text;
        }
        emit({ type: method.replace("/", "."), item: serverItem(item) });
        if (state.shouldStop) {
          state.shouldStop = false;
          // Codex can publish a final count while finishing the interrupted turn.
          interrupt();
          stopTimer ??= setTimeout(handle.kill, SERVER_STOP_GRACE_MS).unref();
        }
        break;
      }
      case "turn/plan/updated": {
        const steps = serverPlan(params.plan);
        const plan = JSON.stringify(steps);
        if (opts.plan && steps && plan !== state.plan) {
          state.plan = plan;
          opts.onEvent(planEvent(steps));
        }
        break;
      }
      case "error": {
        const text = serverError(params.error) ?? "Codex reported an error";
        if (params.willRetry === true) {
          state.retryNotice = text;
          opts.onEvent({ type: "log", text, data: { kind: "connection" } });
        } else emit({ type: "error", message: text });
        break;
      }
      case "turn/completed": {
        const turn = object(params.turn);
        if (!turn || turnId !== turn.id) break;
        if (turn.status === "completed") {
          state.lastMessage = finalMessage ?? state.lastMessage ?? planText;
          emit({ type: "turn.completed" });
        } else if (!state.question) {
          emit({ type: "turn.failed", error: { message: serverError(turn.error) ?? state.failed ?? `Codex turn ${turn.status ?? "failed"}` } });
        }
        complete();
        break;
      }
    }
  };

  let pending = 1;
  const handle = spawnLines(executable ?? bin, args, {
    cwd: opts.cwd, env: { ...stripVars(env, ["CODEX_HOME", "CODEX_SQLITE_HOME"]), CODEX_HOME: home }, interactive: true, signal: opts.signal,
    timeoutMs: opts.timeoutMs, stallMs: opts.stallMs ?? DEFAULT_STALL_MS, interrupt,
    onLine(line) {
      if (completed) return;
      const message = jsonLine(line);
      if (!message) return;
      const id = message.id;
      const method = string(message.method);
      if (method) {
        if (id !== undefined) {
          // This client never authorizes Codex's built-in approval or input requests.
          send({ id, error: { code: -32601, message: "This request is unavailable in Scarlet" } });
          return;
        }
        const params = object(message.params);
        if (!turnRequested || !params || params.threadId !== threadId) return;
        // A notification can be queued before the turn/start response confirms which turn is ours.
        if (pending === 3) pendingEvents.push([method, params]);
        else notify(method, params);
        return;
      }
      if (id !== pending) return;
      const result = object(message.result);
      if (id === 1) {
        if (!result) {
          startupFailure = "initialize_failed";
          return complete();
        }
        send({ method: "initialized" });
        pending = 2;
        // The thread is kept in the run's private Codex home, so a run cut short or paused on a question resumes it.
        send(opts.resumeSession
          ? { id: 2, method: "thread/resume", params: { threadId: opts.resumeSession, model, serviceTier } }
          : { id: 2, method: "thread/start", params: { ephemeral: false, model, serviceTier } });
      } else if (id === 2) {
        const thread = object(result?.thread);
        threadId = string(thread?.id);
        const profile = result?.activePermissionProfile;
        const approval = result?.approvalPolicy;
        if (!threadId || thread?.ephemeral !== false || object(profile)?.id !== "scarlet" || approval !== "never" || (opts.resumeSession && threadId !== opts.resumeSession)) {
          startupFailure = opts.resumeSession ? "thread_resume_failed" : threadId ? "thread_policy_mismatch" : "thread_start_failed";
          return complete();
        }
        model = string(result?.model) ?? model;
        // The engine keeps the thread as the run's session, which an answer or a resume after a quit carries on in.
        opts.onEvent({ type: "log", text: `Codex session started (${threadId})`, data: { kind: "init", threadId, sessionId: threadId } });
        turnRequested = true;
        pending = 3;
        send({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: opts.instruction, text_elements: [] }] } });
      } else if (id === 3) {
        turnId = string(object(result?.turn)?.id);
        if (!turnId) {
          emit({ type: "error", message: serverError(message.error) ?? "Codex could not start the turn" });
          return complete();
        }
        pending = 0;
        for (const [method, params] of pendingEvents.splice(0)) notify(method, params);
      }
    },
  });
  send({ id: 1, method: "initialize", params: { clientInfo: { name: "scarlet", title: "Scarlet", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false } } });
  const outcome = await handle.done;
  clearTimeout(stopTimer);
  // Startup can fail on older CLIs. Never retry a turn that may already have edited the project.
  if (!turnRequested && !outcome.aborted && !outcome.timedOut) {
    opts.onCodexFallback?.(startupFailure ?? "app_server_unavailable");
    // A thread that can't be resumed, here or by `codex exec`, which keeps none: the host starts a fresh run.
    if (opts.resumeSession) return { ok: false, summary: "", resumeFailed: true, error: `Codex could not resume its thread (${startupFailure ?? "app_server_unavailable"})` };
    return undefined;
  }
  return codexResult(state, outcome, state.lastMessage, model, state.turnCompleted, threadId);
}

export async function runCodex(opts: RunAgentOptions): Promise<RunAgentResult> {
  // Scarlet's server reads its variables from Codex's; the shell never gets them (`shell_environment_policy`).
  const env = { ...workspaceEnv(opts.env ?? process.env, opts.workspace), ...opts.mcp.env };
  const bin = await resolveCli("codex", opts.bin, env);
  await writePrivateFile(join(opts.cwd, "AGENTS.md"), opts.systemPrompt);
  const isolation = await isolatedCodexHome(opts.cwd, env).catch(() => ({ reason: "isolation_unavailable" as const }));
  if ("home" in isolation) {
    const result = await runCodexServer(opts, env, bin, isolation.home);
    if (result) return result;
  } else {
    opts.onCodexFallback?.(isolation.reason);
    if (opts.resumeSession) return { ok: false, summary: "", resumeFailed: true, error: `Codex could not resume here (${isolation.reason})` };
  }

  const tmpDir = join(opts.cwd, ".scarlet");
  await mkdir(tmpDir, { recursive: true });
  const cmd = buildCodexCommand(opts, bin, tmpDir);

  const st = newCodexState();
  const handle = spawnLines(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env,
    stdin: cmd.stdin,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    stallMs: opts.stallMs ?? DEFAULT_STALL_MS,
    onLine: (line) => {
      for (const ev of parseCodexLine(line, st)) opts.onEvent(ev);
      if (st.shouldStop) {
        st.shouldStop = false;
        setTimeout(() => handle.kill(), 250).unref();
      }
    },
  });
  const outcome = await handle.done;

  let last = st.lastMessage;
  try {
    const fromFile = (await readFile(cmd.lastMessagePath, "utf8")).trim();
    if (fromFile) last = fromFile;
  } catch {
    /* not written */
  }
  return codexResult(st, outcome, last, opts.model, outcome.code === 0 || st.turnCompleted);
}

function codexResult(st: CodexParseState, outcome: Awaited<ReturnType<typeof spawnLines>["done"]>, last: string | undefined, model: string | undefined, completed: boolean, sessionId?: string): RunAgentResult {
  const usage = usageWithModel(st.usage, model);
  // A question carries the thread with it, so the answer resumes it.
  const early = earlyResult(st, outcome, { usage, ...(sessionId && { sessionId }) });
  if (early) return early;
  // A failure line fails the run whatever it says, an empty reason included.
  const ok = st.failed === undefined && completed;
  return {
    ok,
    summary: last ?? tailSummary(st.texts),
    error: ok ? undefined : st.failed ?? st.retryNotice ?? `codex exited with code ${outcome.code}${outcome.stderr ? `: ${outcome.stderr.trim().slice(-800)}` : ""}`,
    exitCode: outcome.code,
    usage,
    ...(sessionId && { sessionId }),
  };
}
