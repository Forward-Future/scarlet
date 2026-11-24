/**
 * Pure ACP message parsing, permission allowlisting and command construction for Gemini via Antigravity CLI
 * (`agy acp`). `gemini.ts` drives the session.
 */
import { resolve as resolvePath } from "node:path";
import {
  briefInput,
  isQuestionTool,
  nextPlanEvent,
  prettyToolName,
  questionText,
  type McpSpec,
  type RunnerEvent,
} from "./types.js";
import { holdQuestion, settleQuestion, type QuestionCallState } from "./questionCalls.js";
import { asRecord, asString, jsonLine } from "./spawn.js";
import { addUsage, geminiUsage } from "./usage.js";
import { SCARLET_TOOL_NAMES, type AgentUsage, type PlanStep } from "@scarlet/shared";

export interface GeminiParseState extends QuestionCallState {
  texts: string[];
  lastMessage?: string;
  /** Accumulated streamed assistant message (delta chunks). */
  partial: string;
  /** Accumulated streamed reasoning/thought chunks. */
  thought: string;
  /** Tool call names keyed by toolCallId so updates know which tool finished or failed. */
  toolNames: Map<string, string>;
  pendingQuestionId?: string;
  completed: boolean;
  failed?: string;
  model?: string;
  sessionId?: string;
  completedUsage?: AgentUsage;
  turnUsage?: AgentUsage;
  usage?: AgentUsage;
  plan?: string;
}

export function syncUsage(st: GeminiParseState) {
  st.usage = addUsage(st.completedUsage, st.turnUsage);
}

export function newGeminiState(): GeminiParseState {
  return {
    texts: [],
    partial: "",
    thought: "",
    toolNames: new Map(),
    questionPosted: false,
    shouldStop: false,
    completed: false,
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const rec = asRecord(part);
        if (!rec) return "";
        if (typeof rec.text === "string") return rec.text;
        return contentText(rec.content);
      })
      .join("");
  }
  const rec = asRecord(content);
  if (!rec) return "";
  if (typeof rec.text === "string") return rec.text;
  if (rec.content !== undefined) return contentText(rec.content);
  return "";
}

function flushThought(st: GeminiParseState, events: RunnerEvent[]) {
  if (st.thought.trim()) {
    events.push({ type: "log", text: `(thinking) ${briefInput(st.thought.trim(), 200)}`, data: { kind: "reasoning" } });
  }
  st.thought = "";
}

function flushPartial(st: GeminiParseState, events: RunnerEvent[]) {
  const text = st.partial.trim();
  if (text) {
    st.texts.push(text);
    st.lastMessage = text;
    events.push({ type: "log", text });
  }
  st.partial = "";
}

export function flushStreams(st: GeminiParseState, events: RunnerEvent[]) {
  flushThought(st, events);
  flushPartial(st, events);
}

/** Every tool Scarlet's MCP server can offer, the session-specific ones included. */
const SCARLET_TOOLS = new Set<string>([...SCARLET_TOOL_NAMES, "tool_help", "tool_call", "skill_save_edit", "skill_save_from_change"]);
/** How a harness names a Scarlet tool: agy offers them to the model as `mcp_scarlet_<tool>` (its `mcp_%s_%s`). */
const SCARLET_PREFIX = /^(?:mcp__scarlet__|mcp_scarlet_|scarlet__|scarlet\.|scarlet\/|scarlet:)([a-z0-9_]+)(.?)/;

/** Whether one name is a Scarlet tool's, whole: `scarlet/notes.md` or `scarlet.json` are a file's, not a tool's. */
function namesScarletTool(candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const m = SCARLET_PREFIX.exec(candidate.trim().toLowerCase());
  return !!m && SCARLET_TOOLS.has(m[1]!) && !/[a-z0-9_.\-/\\]/.test(m[2]!);
}

/**
 * A call through `tool_call`, which the MCP server offers a Gemini run for the tools it doesn't list on their own, as the
 * call it makes: the tool it names, with that tool's arguments, so the run's history says what Scarlet did. A question
 * stays as it is: the server refuses one asked through `tool_call`, so it was never asked.
 */
function throughToolCall(rawName: string, input: unknown): { rawName: string; input: unknown } {
  if (prettyToolName(rawName) !== "scarlet.tool_call") return { rawName, input };
  const call = asRecord(input);
  const name = asString(call?.name)?.trim().toLowerCase().replace(/^(?:mcp__scarlet__|mcp_scarlet_|scarlet__|scarlet[./:])/, "");
  if (!name || !/^[a-z0-9_]+$/.test(name) || isQuestionTool(name)) return { rawName, input };
  return { rawName: `scarlet.${name}`, input: call!.arguments ?? {} };
}

/**
 * Whether an ACP `session/request_permission` request targets a Scarlet MCP tool: agy names the scarlet server, or
 * the tool's name is a Scarlet tool's. A title is display text (agy shows the model's own `toolSummary` there), so it
 * counts only when the request gives no name at all.
 */
export function isScarletMcpPermission(params: unknown): boolean {
  const p = asRecord(params);
  const tc = asRecord(p?.toolCall);
  if (!tc) return false;
  const meta = asRecord(tc._meta);
  for (const server of [meta?.mcpServer, meta?.server, meta?.serverName, tc.mcpServer, tc.server, tc.serverName]) {
    if (typeof server === "string" && server.toLowerCase() === "scarlet") return true;
  }
  const names = [tc.name, tc.toolName].filter((name) => typeof name === "string" && name.trim());
  return (names.length ? names : [tc.title]).some(namesScarletTool);
}

/** Every path a permission request names: its locations, and any absolute path among its input's values. */
function namedPaths(params: unknown): string[] {
  const tc = asRecord(asRecord(params)?.toolCall);
  const out: string[] = [];
  const absolute = (v: string) => /^(?:\/|[a-zA-Z]:[\\/]|~\/)/.test(v.trim());
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === "string") { if (absolute(value) && value.length < 4096) out.push(value.trim()); return; }
    if (Array.isArray(value)) { for (const v of value) visit(v, depth + 1); return; }
    const rec = asRecord(value);
    if (rec) for (const v of Object.values(rec)) visit(v, depth + 1);
  };
  if (Array.isArray(tc?.locations)) for (const loc of tc.locations) { const path = asString(asRecord(loc)?.path); if (path) out.push(path); }
  visit(tc?.rawInput, 0);
  return out;
}

/**
 * Whether a request's agent may use one of agy's own tools: yes unless it names a path outside the folders it works in
 * (its task folder, and those its programs live in). agy's sandbox restricts its terminal; its file tools reach as far
 * as the user's files do, the library that holds Scarlet's token among them.
 */
export function workspacePermission(params: unknown, roots: string[]): boolean {
  if (isScarletMcpPermission(params)) return true;
  const norm = (p: string) => resolvePath(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const within = roots.filter((r) => r.trim()).map(norm);
  return namedPaths(params).every((path) => {
    if (path.startsWith("~")) return false;
    const p = norm(path);
    return within.some((root) => p === root || p.startsWith(`${root}/`));
  });
}

/** Pick the best ACP permission outcome for allow vs reject. */
export function permissionOutcome(params: unknown, allow: boolean): Record<string, unknown> {
  const p = asRecord(params);
  const options = Array.isArray(p?.options) ? p.options.map(asRecord).filter((o): o is Record<string, unknown> => Boolean(o)) : [];
  const preferredKinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const match = options.find((o) => o.kind === kind && typeof o.optionId === "string");
    if (match) return { outcome: "selected", optionId: match.optionId };
  }
  return { outcome: "cancelled" };
}

/** The tool a call, an update to it or a permission request names, when it names one. */
function namedTool(update: Record<string, unknown>): string | undefined {
  return asString(update.name) ?? asString(update.toolName) ?? asString(update.title);
}

export function extractToolName(update: Record<string, unknown>): string {
  return namedTool(update) ?? "tool";
}

/** The id agy gives a tool call, on the call and on each update to it. */
function toolCallId(update: Record<string, unknown>): string | undefined {
  return asString(update.toolCallId) ?? asString(update.id);
}

/** A tool call's input, under whichever name agy reports it. */
function toolInput(update: Record<string, unknown>): unknown {
  return update.rawInput ?? update.parameters ?? update.input ?? update.arguments;
}

/** The error a tool call that failed, or that Scarlet refused, is reported as. */
function toolFailed(name: string, update: Record<string, unknown>, id: string | undefined): RunnerEvent {
  return { type: "error", text: `${name} failed: ${briefInput(update.rawOutput ?? update.content ?? update.error, 400)}`.trim(), data: id ? { toolId: id } : undefined };
}

/**
 * A task_question call's words, as they arrive with the call or an update to it. Held from then on, should agy stop
 * before the call's result, and said once the engine has the question. One Scarlet refused, or one with no words, was
 * never asked: the model hears why and carries on, so the run does too.
 */
function questionUpdate(st: GeminiParseState, update: Record<string, unknown>, id: string | undefined, name: string, input: unknown, events: RunnerEvent[]) {
  if (id) st.pendingQuestionId = id;
  holdQuestion(st, id, questionText(input));
  const status = asString(update.status);
  if (status !== "completed" && status !== "failed" && status !== "error") return;
  if (st.pendingQuestionId === id) st.pendingQuestionId = undefined;
  const refused = status !== "completed" || isFailedOutput(update.rawOutput, update.content);
  const posted = settleQuestion(st, id, refused);
  if (posted !== undefined) events.push({ type: "question", text: posted, data: { tool: name, ...(id ? { toolId: id } : {}) } });
  else if (refused) events.push(toolFailed(name, update, id));
}

function isFailedOutput(rawOutput: unknown, content: unknown): boolean {
  const out = asRecord(rawOutput);
  if (out && (out.isError === true || out.is_error === true || Boolean(out.error))) return true;
  const c = asRecord(content);
  if (c && (c.isError === true || c.is_error === true)) return true;
  return false;
}

/** Parse one ACP `session/update` payload (`params.update`). */
export function parseGeminiAcpUpdate(rawUpdate: unknown, st: GeminiParseState): RunnerEvent[] {
  const update = asRecord(rawUpdate);
  if (!update) return [];
  const events: RunnerEvent[] = [];
  const kind = asString(update.sessionUpdate);

  switch (kind) {
    case "agent_message_chunk": {
      flushThought(st, events);
      const text = contentText(update.content ?? update.text);
      if (text) st.partial += text;
      break;
    }
    case "agent_thought_chunk": {
      const text = contentText(update.content ?? update.text);
      if (text) st.thought += text;
      break;
    }
    case "tool_call": {
      flushStreams(st, events);
      const { rawName, input } = throughToolCall(extractToolName(update), toolInput(update));
      const name = prettyToolName(rawName);
      const id = toolCallId(update);
      if (id) st.toolNames.set(id, rawName);
      if (isQuestionTool(rawName)) {
        // A question with no words is an ordinary call, which Scarlet refuses.
        if (input !== undefined && !questionText(input)) events.push({ type: "tool", text: `${name} ${briefInput(input)}`.trim(), data: { tool: name, input, ...(id ? { toolId: id } : {}) } });
        questionUpdate(st, update, id, name, input, events);
      } else {
        events.push({
          type: "tool",
          text: `${name} ${briefInput(input)}`.trim(),
          data: { tool: name, ...(input !== undefined ? { input } : {}), ...(id ? { toolId: id } : {}) },
        });
      }
      break;
    }
    case "tool_call_update": {
      const id = toolCallId(update);
      const rawName = (id ? st.toolNames.get(id) : undefined) ?? namedTool(update);
      const name = rawName ? prettyToolName(rawName) : "tool";
      const status = asString(update.status);
      const isQuestion = (id !== undefined && st.pendingQuestionId === id) || isQuestionTool(rawName);
      if (isQuestion) {
        questionUpdate(st, update, id, name, toolInput(update), events);
      } else if (status === "failed" || status === "error") {
        events.push(toolFailed(name, update, id));
      }
      break;
    }
    case "plan": {
      if (!Array.isArray(update.entries)) break;
      const steps: PlanStep[] = [];
      for (const entry of update.entries) {
        const rec = asRecord(entry);
        const text = asString(rec?.content)?.trim();
        if (!text) continue;
        const status = asString(rec?.status);
        const state: PlanStep["state"] = status === "completed" ? "done" : status === "in_progress" ? "in_progress" : "pending";
        steps.push({ text, state });
      }
      const next = nextPlanEvent(steps, st.plan);
      if (next) {
        st.plan = next.serialized;
        events.push(next.event);
      }
      break;
    }
    case "usage_update": {
      const parsed = geminiUsage(update.usage ?? update, st.model);
      if (parsed) {
        st.turnUsage = parsed;
        syncUsage(st);
      }
      break;
    }
    default:
      break;
  }
  return events;
}

/** Parse one JSON-RPC notification line from `agy acp` (or non-JSON output as a log line). */
export function parseGeminiLine(line: string, st: GeminiParseState): RunnerEvent[] {
  const msg = jsonLine(line);
  if (!msg) return [{ type: "log", text: line }];
  if (msg.method === "session/update") {
    const params = asRecord(msg.params);
    return parseGeminiAcpUpdate(params?.update, st);
  }
  return [];
}

/** Convert Scarlet's McpSpec to an ACP stdio MCP server entry. */
export function acpMcpServer(mcp: McpSpec): Record<string, unknown> {
  return {
    name: "scarlet",
    command: mcp.command,
    args: mcp.args,
    env: Object.keys(mcp.env)
      .sort()
      .map((name) => ({ name, value: mcp.env[name]! })),
  };
}

export interface GeminiCommand {
  file: string;
  args: string[];
}

/**
 * agy reads Scarlet's prompt from the session's own system prompt (`systemPromptMeta`), not a `GEMINI.md`: it cuts a
 * rule file off at 24,000 bytes, and a pass's prompt with the editor's skill runs past that.
 */
export function buildGeminiCommand(bin: string, geminiDir?: string): GeminiCommand {
  return { file: bin, args: ["acp", "--sandbox", "--disable-telemetry", ...(geminiDir ? ["--gemini-dir", geminiDir] : [])] };
}

/**
 * The run's own folder for agy's settings, rules, plugins and sessions (`--gemini-dir`), beside its task folder: outside
 * the folder the agent may write to, and the same for every attempt at the task, so a resumed session is still there.
 * It keeps the editor's personal `~/.gemini/GEMINI.md` and plugin rules, written for their own chats with Gemini, out
 * of Scarlet's runs, as they are kept out of Claude Code's (`--restricted`) and Codex's (its own `CODEX_HOME`). The
 * sign-in stays: agy keeps it in the system keychain.
 */
export function geminiDir(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}.gemini`;
}

/** `session/new` and `session/resume` meta that appends Scarlet's prompt to agy's system prompt. */
export function systemPromptMeta(systemPrompt: string) {
  return { antigravity: { systemPrompt: { append: systemPrompt } } };
}

/**
 * Whether agy says, in its `initialize` result, that it takes `systemPromptMeta`. agy 1.5 does
 * (`agentCapabilities._meta.antigravity.systemPrompt.append`); one that doesn't would run Gemini without Scarlet's prompt.
 */
export function takesSystemPrompt(result: unknown): boolean {
  const meta = asRecord(asRecord(asRecord(result)?.agentCapabilities)?._meta);
  return asRecord(asRecord(meta?.antigravity)?.systemPrompt)?.append === true;
}
