/**
 * Codex's event stream, as `codex exec --json` writes it and the App Server's notifications are turned into it, and
 * the result a Codex run ends with.
 */
import { briefInput, COMPACTED, COMPACTING, isQuestionTool, nextPlanEvent, questionText, type RunAgentResult, type RunnerEvent } from "./types.js";
import { holdQuestion, settleQuestion, type QuestionCallState } from "./questionCalls.js";
import { asRecord, earlyResult, exitError, jsonLine, tailSummary, type SpawnOutcome } from "./spawn.js";
import { addUsage, codexUsage, usageWithModel } from "./usage.js";
import type { AgentUsage, PlanStep } from "@scarlet/shared";

export interface CodexParseState extends QuestionCallState {
  texts: string[];
  lastMessage?: string;
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

export interface CodexItem {
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

export function parseCodexEvent(msg: Record<string, unknown>, st: CodexParseState): RunnerEvent[] {
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
            holdQuestion(st, item.id, text);
            if (completed) {
              const refused = item.status === "failed" || Boolean(item.error) || asRecord(item.result)?.isError === true;
              const posted = settleQuestion(st, item.id, refused);
              if (posted !== undefined) events.push({ type: "question", text: posted, data: { tool: name, itemId: item.id } });
              else if (refused) events.push({ type: "error", text: `${name} failed: ${briefInput(item.error ?? item.result, 400)}` });
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
        case "contextCompaction":
        case "context_compaction":
          if (type === "item.started") events.push(COMPACTING);
          else if (completed) events.push(COMPACTED);
          break;
        case "todo_list": {
          // The whole plan each time: when the model first makes it, on every update, and once more as the turn ends.
          const steps = codexPlan(item.items);
          const next = steps && nextPlanEvent(steps, st.plan);
          if (next) {
            st.plan = next.serialized;
            events.push(next.event);
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

export function codexResult(st: CodexParseState, outcome: SpawnOutcome, last: string | undefined, model: string | undefined, completed: boolean, sessionId?: string): RunAgentResult {
  const usage = usageWithModel(st.usage, model);
  // A question carries the thread with it, so the answer resumes it.
  const early = earlyResult(st, outcome, { usage, ...(sessionId && { sessionId }) });
  if (early) return early;
  // A failure line fails the run whatever it says, an empty reason included.
  const ok = st.failed === undefined && completed;
  return {
    ok,
    summary: last ?? tailSummary(st.texts),
    error: ok ? undefined : st.failed ?? st.retryNotice ?? exitError("codex", outcome),
    exitCode: outcome.code,
    usage,
    ...(sessionId && { sessionId }),
  };
}
