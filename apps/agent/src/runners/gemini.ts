/**
 * Gemini runs with only the Scarlet MCP server and no built-in tools.
 * Each run starts fresh: answers replay in the prompt. Google folded Gemini CLI
 * into Antigravity CLI and ended its consumer tiers on June 18, 2026.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../private-files.js";
import { briefInput, DEFAULT_STALL_MS, isQuestionTool, type RunAgentOptions, type RunAgentResult, type RunnerEvent } from "./types.js";
import { resolveCli, spawnLines, tailSummary } from "./spawn.js";
import { geminiUsage } from "./usage.js";
import type { AgentUsage } from "@scarlet/shared";

export interface GeminiParseState {
  texts: string[];
  /** Accumulated streamed assistant message (delta chunks). */
  partial: string;
  pendingQuestionId?: string;
  question?: string;
  questionPosted: boolean;
  shouldStop: boolean;
  result?: { status: string; text?: string };
  failed?: string;
  model?: string;
  usage?: AgentUsage;
}

export function newGeminiState(): GeminiParseState {
  return { texts: [], partial: "", questionPosted: false, shouldStop: false };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  }
  if (content && typeof content === "object" && "text" in content) return String((content as { text: unknown }).text);
  return "";
}

/** Parse one JSONL line from `gemini -p --output-format stream-json`. */
export function parseGeminiLine(line: string, st: GeminiParseState): RunnerEvent[] {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ type: "log", text: line }];
  }
  // The CLIs write one JSON object per line. Anything else that parses (null, a number, a list) is noise too.
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return [{ type: "log", text: line }];
  const events: RunnerEvent[] = [];
  const type = msg.type as string | undefined;
  const flushPartial = () => {
    if (st.partial.trim()) {
      st.texts.push(st.partial);
      events.push({ type: "log", text: st.partial });
    }
    st.partial = "";
  };

  switch (type) {
    case "init":
      if (typeof msg.model === "string" && msg.model) st.model = msg.model;
      events.push({ type: "log", text: `Gemini session started${msg.model ? ` (${String(msg.model)})` : ""}`, data: { kind: "init", model: msg.model, sessionId: msg.session_id } });
      break;
    case "message": {
      const role = (msg.role as string | undefined) ?? "assistant";
      if (role !== "assistant" && role !== "model") break;
      const text = contentText(msg.content ?? msg.text);
      if (msg.delta === true) st.partial += text;
      else {
        st.partial += text;
        flushPartial();
      }
      break;
    }
    case "tool_use":
    case "tool_call": {
      flushPartial();
      const name = String(msg.tool_name ?? msg.name ?? (msg.tool as { name?: string } | undefined)?.name ?? "tool");
      const id = msg.tool_id ?? msg.id ?? msg.call_id;
      const input = msg.parameters ?? msg.args ?? msg.input ?? msg.arguments;
      if (isQuestionTool(name)) {
        const text = String((input as { text?: unknown })?.text ?? briefInput(input));
        st.question = text;
        st.pendingQuestionId = id !== undefined ? String(id) : undefined;
        events.push({ type: "question", text, data: { tool: name, toolId: id } });
      } else {
        events.push({ type: "tool", text: `${name} ${briefInput(input)}`.trim(), data: { tool: name, input, toolId: id } });
      }
      break;
    }
    case "tool_result": {
      const id = msg.tool_id ?? msg.id ?? msg.call_id;
      const failed = msg.status === "error" || msg.is_error === true || Boolean(msg.error);
      if (st.question && (st.pendingQuestionId === undefined || String(id) === st.pendingQuestionId)) {
        st.questionPosted = !failed;
        st.shouldStop = true;
      } else if (failed) {
        events.push({ type: "error", text: `Tool error: ${briefInput(msg.error ?? msg.output, 400)}`, data: { toolId: id } });
      }
      break;
    }
    case "error": {
      const text = String(msg.message ?? briefInput(msg, 400));
      const severity = String(msg.severity ?? "error");
      if (severity === "warning") events.push({ type: "log", text: `warning: ${text}` });
      else {
        st.failed = text;
        events.push({ type: "error", text });
      }
      break;
    }
    case "result": {
      flushPartial();
      const status = String(msg.status ?? (msg.error ? "error" : "success"));
      const text = contentText(msg.response ?? msg.text ?? msg.content) || undefined;
      st.result = { status, text };
      st.usage = geminiUsage(msg.stats, st.model) ?? st.usage;
      if (status === "success") events.push({ type: "result", text: text ?? st.texts[st.texts.length - 1] ?? "done", data: { stats: msg.stats } });
      else {
        st.failed = st.failed ?? text ?? `Gemini ended with status ${status}`;
        events.push({ type: "error", text: st.failed, data: { stats: msg.stats } });
      }
      break;
    }
    default:
      break;
  }
  return events;
}

export interface GeminiCommand {
  file: string;
  args: string[];
  stdin?: string;
  files: Record<string, string>;
}

export function buildGeminiCommand(
  opts: Pick<RunAgentOptions, "model" | "systemPrompt" | "instruction" | "mcp" | "cwd">,
  bin: string,
): GeminiCommand {
  const settings = {
    mcpServers: { scarlet: { command: opts.mcp.command, args: opts.mcp.args, env: opts.mcp.env, timeout: 600000, trust: true } },
    tools: { core: [] },
    hooksConfig: { enabled: false },
  };
  const args = ["--sandbox", "--skip-trust", "--allowed-mcp-server-names", "scarlet", "--extensions", "none", "--admin-policy", join(opts.cwd, ".gemini", "scarlet-policy.toml"), "--output-format", "stream-json", ...(opts.model ? ["--model", opts.model] : [])];
  return {
    file: bin,
    args,
    stdin: opts.instruction,
    files: {
      [join(opts.cwd, ".gemini", "scarlet-policy.toml")]: '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 900\n\n[[rule]]\ntoolName = "*"\nmcpName = "scarlet"\ndecision = "allow"\npriority = 999\n',
      [join(opts.cwd, ".gemini", "settings.json")]: JSON.stringify(settings, null, 2),
      [join(opts.cwd, "GEMINI.md")]: opts.systemPrompt,
    },
  };
}

export async function runGemini(opts: RunAgentOptions): Promise<RunAgentResult> {
  const env = { ...(opts.env ?? process.env) };
  const bin = await resolveCli("gemini", opts.bin, env);
  await mkdir(join(opts.cwd, ".gemini"), { recursive: true });
  const cmd = buildGeminiCommand(opts, bin);
  for (const [p, content] of Object.entries(cmd.files)) await writePrivateFile(p, content);

  const st = newGeminiState();
  const handle = spawnLines(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env,
    stdin: cmd.stdin,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    stallMs: opts.stallMs ?? DEFAULT_STALL_MS,
    onLine: (line) => {
      for (const ev of parseGeminiLine(line, st)) opts.onEvent(ev);
      if (st.shouldStop) {
        st.shouldStop = false;
        setTimeout(() => handle.kill(), 250).unref();
      }
    },
  });
  const outcome = await handle.done;

  const usage = st.usage && !st.usage.model && opts.model ? { ...st.usage, model: opts.model } : st.usage;
  if (st.question) {
    return { ok: true, summary: tailSummary(st.texts), question: st.question, questionPosted: st.questionPosted, exitCode: outcome.code, usage };
  }
  if (outcome.timedOut) return { ok: false, summary: tailSummary(st.texts), error: outcome.stalled ? "stalled" : "timed out", timedOut: true, stalled: outcome.stalled, exitCode: outcome.code, usage };
  if (outcome.aborted) return { ok: false, summary: tailSummary(st.texts), error: "cancelled", aborted: true, exitCode: outcome.code, usage };
  const ok = !st.failed && (outcome.code === 0 || st.result?.status === "success");
  return {
    ok,
    summary: st.result?.text ?? tailSummary(st.texts),
    error: ok ? undefined : st.failed ?? `gemini exited with code ${outcome.code}${outcome.stderr ? `: ${outcome.stderr.trim().slice(-800)}` : ""}`,
    exitCode: outcome.code,
    usage,
  };
}
