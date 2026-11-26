/**
 * Run one Codex turn over the App Server's JSONL stdio protocol, in a new thread or one it resumes. Its notifications
 * are read as `codex exec --json` events (`parseCodexEvent`), and its cumulative token counts are reported live.
 */
import { stripVars } from "../detect.js";
import { parseCodexQuota } from "../quota.js";
import { COMPACTED, COMPACTING, DEFAULT_STALL_MS, nextPlanEvent, type CodexFallbackReason, type RunAgentOptions, type RunAgentResult } from "./types.js";
import { asRecord, jsonLine, runnerLog, spawnLines } from "./spawn.js";
import { clip } from "../logText.js";
import { codexUsage, createUsageReporter, tokenCount } from "./usage.js";
import { codexResult, newCodexState, parseCodexEvent, type CodexItem } from "./codexParse.js";
import type { AgentUsage, PlanStep } from "@scarlet/shared";

const string = (value: unknown) => typeof value === "string" ? value : undefined;
const SERVER_STOP_GRACE_MS = 2000;

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
  const counts = asRecord(value);
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
  const total = breakdown(asRecord(value)?.total);
  return total && minus(total, breakdown(asRecord(value)?.last));
}

/** The thread's tokens as App Server counts them, less what it had counted before this run. */
function serverUsage(value: unknown, model?: string, baseline?: Breakdown): AgentUsage | undefined {
  const all = breakdown(asRecord(value)?.total);
  const total = all && minus(all, baseline);
  return total && codexUsage({ input_tokens: total.inputTokens, cached_input_tokens: total.cachedInputTokens,
    cache_write_input_tokens: total.cacheWriteInputTokens, output_tokens: total.outputTokens, reasoning_output_tokens: total.reasoningOutputTokens }, model);
}

function serverPlan(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): PlanStep[] => {
    const step = asRecord(entry);
    const text = string(step?.step)?.trim();
    const status = step?.status;
    if (!text) return [];
    return [{ text, state: status === "completed" ? "done" : status === "inProgress" ? "in_progress" : "pending" }];
  });
}

function serverError(value: unknown) {
  const error = asRecord(value);
  const message = string(error?.message);
  const detail = string(error?.additionalDetails);
  return message && detail ? `${message} (${detail})` : message;
}

/**
 * Run the turn through `file args` (an `app-server` command line, `codexServerArgs`) with `home` as its Codex home.
 * Undefined when App Server couldn't start the turn and nothing ran, so `codex exec` may run it instead.
 */
export async function runCodexServer(opts: RunAgentOptions, env: NodeJS.ProcessEnv, file: string, args: string[], home: string): Promise<RunAgentResult | undefined> {
  const state = newCodexState();
  const runLog = runnerLog(opts, "codex");
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
  const reportUsage = createUsageReporter(opts.onUsage, opts.model);
  const notify = (method: string, params: Record<string, unknown>) => {
    const eventTurn = string(params.turnId) ?? string(asRecord(params.turn)?.id);
    if (completed || !eventTurn || eventTurn !== turnId) return;
    switch (method) {
      case "thread/tokenUsage/updated": {
        if (opts.resumeSession) baseline ??= resumedBaseline(params.tokenUsage);
        const usage = serverUsage(params.tokenUsage, model, baseline);
        if (!usage) break;
        state.usage = usage;
        reportUsage(usage);
        break;
      }
      // Codex compacted the thread's context. Newer versions report it as an item too, and that one counts.
      case "thread/compacted":
        if (!compactionItems) opts.onEvent(COMPACTED);
        break;
      case "item/started":
      case "item/completed": {
        const item = asRecord(params.item);
        if (!item) break;
        if (item.type === "contextCompaction") {
          compactionItems = true;
          if (method === "item/started") opts.onEvent(COMPACTING);
          else if (method === "item/completed") opts.onEvent(COMPACTED);
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
        const next = opts.plan && steps ? nextPlanEvent(steps, state.plan) : undefined;
        if (next) {
          state.plan = next.serialized;
          opts.onEvent(next.event);
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
        const turn = asRecord(params.turn);
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
  // For the host's log: lines that weren't JSON, and the requests of Codex's own Scarlet turned down, by method name.
  let notJson = 0;
  const refusedRequests = new Set<string>();
  const handle = spawnLines(file, args, {
    cwd: opts.cwd, env: { ...stripVars(env, ["CODEX_HOME", "CODEX_SQLITE_HOME"]), CODEX_HOME: home }, interactive: true, signal: opts.signal,
    timeoutMs: opts.timeoutMs, stallMs: opts.stallMs ?? DEFAULT_STALL_MS, interrupt, log: opts.log, task: opts.task,
    onLine(line) {
      if (completed) return;
      const message = jsonLine(line);
      if (!message) {
        notJson++;
        return;
      }
      const id = message.id;
      const method = string(message.method);
      if (method) {
        if (id !== undefined) {
          // This client never authorizes Codex's built-in approval or input requests.
          if (!refusedRequests.has(method)) {
            refusedRequests.add(method);
            runLog(`asked for ${clip(method, 60)}, which Scarlet turns down`);
          }
          send({ id, error: { code: -32601, message: "This request is unavailable in Scarlet" } });
          return;
        }
        const params = asRecord(message.params);
        if (method === "account/rateLimits/updated" && params) {
          const quota = parseCodexQuota(params);
          if (quota) opts.onQuota?.(quota);
          return;
        }
        if (!turnRequested || !params || params.threadId !== threadId) return;
        // A notification can be queued before the turn/start response confirms which turn is ours.
        if (pending === 3) pendingEvents.push([method, params]);
        else notify(method, params);
        return;
      }
      if (id !== pending) return;
      const result = asRecord(message.result);
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
        const thread = asRecord(result?.thread);
        threadId = string(thread?.id);
        const profile = result?.activePermissionProfile;
        const approval = result?.approvalPolicy;
        if (!threadId || thread?.ephemeral !== false || asRecord(profile)?.id !== "scarlet" || approval !== "never" || (opts.resumeSession && threadId !== opts.resumeSession)) {
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
        turnId = string(asRecord(result?.turn)?.id);
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
  if (notJson) runLog(`app-server wrote ${notJson} output line${notJson === 1 ? "" : "s"} that weren't JSON`);
  // Startup can fail on older CLIs. Never retry a turn that may already have edited the project.
  if (!turnRequested && !outcome.aborted && !outcome.timedOut) {
    opts.onCodexFallback?.(startupFailure ?? "app_server_unavailable");
    // A thread that can't be resumed, here or by `codex exec`, which keeps none: the host starts a fresh run.
    if (opts.resumeSession) return { ok: false, summary: "", resumeFailed: true, error: `Codex could not resume its thread (${startupFailure ?? "app_server_unavailable"})` };
    return undefined;
  }
  return codexResult(state, outcome, state.lastMessage, model, state.turnCompleted, threadId);
}
