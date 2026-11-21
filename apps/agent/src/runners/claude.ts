/** Claude receives task text only on stdin and can call only Scarlet MCP tools. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../private-files.js";
import { briefInput, COMPACTED, CONTROL_DIR, DEFAULT_STALL_MS, isQuestionTool, planEvent, prettyToolName, questionText, workspaceEnv, type RunAgentOptions, type RunAgentResult, type RunnerEvent } from "./types.js";
import { earlyResult, jsonLine, resolveCli, spawnLines, tailSummary } from "./spawn.js";
import { addUsage, claudeUsage, usageWithModel } from "./usage.js";
import type { AgentUsage, PlanStep } from "@scarlet/shared";

/**
 * Claude Code's own to-do tools, which Scarlet reads the agent's plan from and never calls. TaskCreate adds one step
 * and its result names the step's id; TaskUpdate changes one step by id. A Claude Code from before those has
 * TodoWrite, which takes the whole list. `--tools` takes the names a CLI knows and passes over the rest.
 */
const CLAUDE_PLAN_TOOLS = ["TaskCreate", "TaskUpdate", "TodoWrite"];
/** Claude Code's own tools a request's agent has beside Scarlet's: a shell, files and the web. */
export const CLAUDE_WORKSPACE_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];
/** Allowed without asking. `WebFetch(domain:*)` also lets the shell's sandbox reach any web address. */
const CLAUDE_WORKSPACE_ALLOWED = [...CLAUDE_WORKSPACE_TOOLS, "WebFetch(domain:*)"];
const PLAN_READS = new Set(["TaskList", "TaskGet", "TodoRead"]);
const STEP_STATE: Record<string, PlanStep["state"]> = { pending: "pending", in_progress: "in_progress", completed: "done" };

/** Why a run whose Scarlet MCP server failed has failed: Claude Code carries on without it and calls the run a success. */
const MCP_FAILED = "Scarlet's MCP server failed to start, so Claude Code had no editing tools.";

/** The plan as Claude Code's to-do tools have left it, and their calls still waiting for a result. */
interface ClaudePlanState {
  steps: Array<PlanStep & { id: string }>;
  calls: Record<string, { create: string } | { update: { id: string; status?: string; subject?: string } }>;
  /** The plan last passed on. */
  sent?: string;
}

const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Note a call to one of Claude Code's to-do tools. True when the call was one, so it isn't logged as a Scarlet tool. */
function planCall(plan: ClaudePlanState, name: string, id: string, input: unknown): boolean {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === "TaskCreate") plan.calls[id] = { create: str(args.subject) ?? str(args.description) ?? "" };
  else if (name === "TaskUpdate") plan.calls[id] = { update: { id: String(args.taskId ?? ""), status: str(args.status), subject: str(args.subject) } };
  else if (name === "TodoWrite") {
    // The whole list, each with its state. The result only confirms it.
    const todos = Array.isArray(args.todos) ? args.todos as Array<{ content?: unknown; status?: unknown }> : [];
    plan.steps = todos.flatMap((todo, i) => {
      const step = str(todo?.content);
      return step ? [{ id: String(i), text: step, state: STEP_STATE[String(todo.status)] ?? "pending" }] : [];
    });
  } else return PLAN_READS.has(name);
  return true;
}

/** Apply a to-do call's result to the plan. True when the result was one. */
function planResult(plan: ClaudePlanState, id: string, failed: boolean, content: unknown, result: unknown): boolean {
  const call = plan.calls[id];
  if (!call) return false;
  delete plan.calls[id];
  if (failed) return true;
  if ("create" in call) {
    // "Task #3 created successfully: Check the join"; the line's tool_use_result carries the same id.
    const made = /Task #(\S+) created/.exec(flattenToolResult(content))?.[1] ?? str((result as { task?: { id?: unknown } } | undefined)?.task?.id);
    if (made && call.create) plan.steps.push({ id: made, text: call.create, state: "pending" });
    return true;
  }
  const step = plan.steps.find(s => s.id === call.update.id);
  if (!step) return true;
  if (call.update.status === "deleted") plan.steps = plan.steps.filter(s => s !== step);
  else if (call.update.status && STEP_STATE[call.update.status]) step.state = STEP_STATE[call.update.status]!;
  if (call.update.subject) step.text = call.update.subject;
  return true;
}

/** The plan as an event, once it has changed and no step is still being added: several are added in one message. */
function planChange(plan: ClaudePlanState): RunnerEvent[] {
  if (Object.values(plan.calls).some(call => "create" in call)) return [];
  const steps = plan.steps.map(({ text, state }) => ({ text, state }));
  const now = JSON.stringify(steps);
  if (now === (plan.sent ?? "[]")) return [];
  plan.sent = now;
  return [planEvent(steps)];
}

export interface ClaudeParseState {
  texts: string[];
  result?: string;
  resultIsError?: boolean;
  pendingQuestion?: { id: string; text: string; tool: string };
  question?: string;
  questionPosted: boolean;
  /** Set when the tool_result for the question arrived, or Scarlet's MCP server failed: the runner should stop the process. */
  shouldStop: boolean;
  /** Scarlet's MCP server as the init line reported it ("connected", "failed", …), when it was listed. */
  mcpStatus?: string;
  sessionId?: string;
  /** The CLI opened a session. A resume that finds none fails before this. */
  started?: boolean;
  model?: string;
  /** Totals from the result line (whole session). */
  usage?: AgentUsage;
  /** Per API message, by message id, for a run stopped before its result line. */
  messageUsage: Record<string, AgentUsage>;
  /** The agent's own plan, when the CLI was launched with its to-do tools. */
  plan: ClaudePlanState;
}

export function newClaudeState(): ClaudeParseState {
  return { texts: [], questionPosted: false, shouldStop: false, messageUsage: {}, plan: { steps: [], calls: {} } };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

/** Parse one stream-json line from `claude -p --output-format stream-json --verbose`. */
export function parseClaudeLine(line: string, st: ClaudeParseState): RunnerEvent[] {
  // Anything that isn't one JSON object (a warning, null, a number, a list) is noise: surface it as a log line.
  const msg = jsonLine(line);
  if (!msg) return [{ type: "log", text: line }];
  const events: RunnerEvent[] = [];
  const type = msg.type as string | undefined;
  if ((type === "system" && msg.subtype === "init") || type === "assistant" || type === "user") st.started = true;

  if (type === "system") {
    if (msg.subtype === "init") {
      if (typeof msg.session_id === "string" && msg.session_id) st.sessionId = msg.session_id;
      const servers = (msg.mcp_servers as Array<{ name: string; status: string }> | undefined) ?? [];
      const scarlet = servers.find((s) => s.name === "scarlet");
      st.mcpStatus = scarlet?.status;
      // This runner offers only Scarlet's tools, so nothing useful can follow.
      if (scarlet?.status === "failed") st.shouldStop = true;
      if (typeof msg.model === "string" && msg.model) st.model = msg.model;
      events.push({
        type: "log",
        text: `Claude Code session started${msg.model ? ` (${String(msg.model)})` : ""}${scarlet ? `; Scarlet MCP ${scarlet.status}` : "; Scarlet MCP server not listed"}`,
        // The engine keeps the session id, so a run cut short by a quit can carry on in this session.
        data: { kind: "init", model: msg.model, mcp: servers, ...(st.sessionId && { sessionId: st.sessionId }) },
      });
      if (scarlet && scarlet.status !== "connected") {
        events.push({ type: "error", text: `Scarlet MCP server status: ${scarlet.status}` });
      }
    } else if (msg.subtype === "compact_boundary") {
      // Claude Code compacted the session's context. The engine logs it and keeps it out of the chat.
      const meta = (msg.compact_metadata ?? {}) as { trigger?: unknown; pre_tokens?: unknown; post_tokens?: unknown };
      events.push({ ...COMPACTED, data: { ...COMPACTED.data, ...(typeof meta.trigger === "string" && { trigger: meta.trigger }),
        ...(typeof meta.pre_tokens === "number" && { preTokens: meta.pre_tokens }), ...(typeof meta.post_tokens === "number" && { postTokens: meta.post_tokens }) } });
    }
    return events;
  }

  if (type === "assistant" || type === "user") {
    const message = msg.message as { id?: unknown; model?: unknown; usage?: unknown; content?: ContentBlock[] | string } | undefined;
    const content = message?.content;
    if (type === "assistant" && typeof message?.id === "string") {
      // One API message can arrive as several lines; the last carries its final count.
      const usage = claudeUsage(message.usage, typeof message.model === "string" ? message.model : st.model);
      if (usage) st.messageUsage[message.id] = usage;
    }
    if (typeof content === "string") {
      if (type === "assistant" && content.trim()) {
        st.texts.push(content);
        events.push({ type: "log", text: content });
      }
      return events;
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && type === "assistant") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string" && t.trim()) {
          st.texts.push(t);
          events.push({ type: "log", text: t });
        }
      } else if (block.type === "tool_use") {
        const b = block as { id: string; name: string; input: unknown };
        const pretty = prettyToolName(b.name);
        if (planCall(st.plan, b.name, b.id, b.input)) {
          events.push(...planChange(st.plan));
        } else if (isQuestionTool(b.name) && questionText(b.input)) {
          // A call with no words to ask is no question: Scarlet refuses it, and the model hears why and tries again.
          // Said once posted, as the desktop host says it, so nothing takes a question Scarlet refused for one asked.
          const text = questionText(b.input)!;
          st.pendingQuestion = { id: b.id, text, tool: b.name };
          st.question = text;
        } else {
          events.push({ type: "tool", text: `${pretty} ${briefInput(b.input)}`.trim(), data: { tool: b.name, input: b.input, toolUseId: b.id } });
        }
      } else if (block.type === "tool_result") {
        const b = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
        if (planResult(st.plan, b.tool_use_id, !!b.is_error, b.content, msg.tool_use_result)) {
          events.push(...planChange(st.plan));
        } else if (st.pendingQuestion && b.tool_use_id === st.pendingQuestion.id && !b.is_error) {
          const { text, tool } = st.pendingQuestion;
          st.questionPosted = true;
          st.shouldStop = true;
          events.push({ type: "question", text, data: { tool, toolUseId: b.tool_use_id } });
        } else if (b.is_error) {
          // A question Scarlet refused was never asked: the model hears why and carries on, so the run does too.
          if (st.pendingQuestion && b.tool_use_id === st.pendingQuestion.id) st.pendingQuestion = st.question = undefined;
          events.push({ type: "error", text: `Tool error: ${briefInput(flattenToolResult(b.content), 400)}`, data: { toolUseId: b.tool_use_id } });
        }
      }
    }
    return events;
  }

  if (type === "result") {
    const isError = Boolean(msg.is_error) || (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
    const result = typeof msg.result === "string" ? msg.result : "";
    const detail = Array.isArray(msg.errors) ? msg.errors.find((error) => typeof error === "string" && error.length > 0) : undefined;
    st.result = result || (isError ? String(detail ?? msg.subtype ?? "error") : "");
    st.resultIsError = isError;
    st.usage = claudeUsage(msg.usage, st.model) ?? st.usage;
    events.push({
      type: isError ? "error" : "result",
      text: st.result || (isError ? "Claude Code ended with an error" : "done"),
      data: {
        subtype: msg.subtype,
        durationMs: msg.duration_ms,
        turns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        usage: msg.usage,
      },
    });
    return events;
  }

  // stream_event / partial messages / hooks: ignore quietly.
  return events;
}

/** The run's usage: the result totals, else the sum of the messages seen before the process stopped. */
export function claudeRunUsage(st: ClaudeParseState, model?: string): AgentUsage | undefined {
  const usage = st.usage ?? Object.values(st.messageUsage).reduce<AgentUsage | undefined>(addUsage, undefined);
  return usageWithModel(usage, model);
}

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

export interface ClaudeCommand {
  file: string;
  args: string[];
  stdin?: string;
  files: Record<string, string>;
}

/**
 * `--bare` keeps the user's hooks, plugins and CLAUDE.md out of Scarlet runs, but
 * it reads only ANTHROPIC_API_KEY or a cloud provider, never a subscription login.
 */
export function claudeCanRunBare(env: NodeJS.ProcessEnv): boolean {
  return ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((k) => !!env[k]);
}

/** Build the exact command line (pure, for tests and for reporting). */
export function buildClaudeCommand(
  opts: Pick<RunAgentOptions, "model" | "effort" | "fast" | "serviceTier" | "systemPrompt" | "instruction" | "mcp" | "resumeSession" | "plan" | "workspace">,
  bin: string,
  tmpDir: string,
  bare = false,
): ClaudeCommand {
  const mcpConfigPath = join(tmpDir, "mcp.json");
  const systemPath = join(tmpDir, "system.md");
  const mcpConfig = { mcpServers: { scarlet: { command: opts.mcp.command, args: opts.mcp.args, env: opts.mcp.env } } };
  const ws = opts.workspace;
  // A request's agent has Claude Code's own shell, file and web tools beside Scarlet's. Its shell runs in Claude Code's
  // sandbox, writing only in the task folder; it reaches any web address (`WebFetch(domain:*)` opens the sandbox's
  // proxy to every host), and reads nothing outside the task folder but the programs its links point at. The control
  // files, which hold Scarlet's token, are closed to every tool. Where the sandbox can't start (native Windows, a Linux
  // without bubblewrap) the run goes on without it, as before.
  // A shell's `curl` was refused every host until the sandbox's own list named them all (2026-11-21).
  const sandbox = ws
    ? { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
        network: { allowedDomains: ["*"] },
        filesystem: { denyRead: [tmpDir], ...(ws.readDirs.length && { allowRead: ws.readDirs }) } }
    : { enabled: true, allowUnsandboxedCommands: false };
  const control = `//${tmpDir.replace(/\\/g, "/").replace(/^\/+/, "")}/**`;
  const permissions = ws ? { blockReadsOutsideWorkingDirectories: true, allow: ["WebFetch(domain:*)"], deny: [`Read(${control})`, `Edit(${control})`] } : undefined;
  const tools = [...(ws ? CLAUDE_WORKSPACE_TOOLS : []), ...(opts.plan ? CLAUDE_PLAN_TOOLS : [])];
  const args = [
    "-p",
    ...(bare ? ["--bare"] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--restricted",
    "--disable-slash-commands",
    "--tools",
    // A request's own shell, file and web tools, and Claude Code's to-do list when the engine asks for the agent's plan.
    // A side check has neither.
    tools.join(","),
    "--allowedTools",
    ["mcp__scarlet__*", ...(ws ? CLAUDE_WORKSPACE_ALLOWED : [])].join(","),
    "--append-system-prompt-file",
    systemPath,
    "--permission-mode",
    "dontAsk",
    // Sessions persist so a run paused on a question can continue with the answer.
    ...(opts.resumeSession ? ["--resume", opts.resumeSession] : []),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--settings",
    JSON.stringify({ sandbox, ...(permissions && { permissions }), ...(opts.serviceTier ? { fastMode: opts.serviceTier === "fast" } : opts.fast ? { fastMode: true } : {}) }),
  ];
  return {
    file: bin,
    args,
    stdin: opts.instruction,
    files: { [mcpConfigPath]: JSON.stringify(mcpConfig, null, 2), [systemPath]: opts.systemPrompt },
  };
}

/** Scarlet's tools wait up to `toolWaitSeconds` (capabilities.ts) for evidence still being measured, under this deadline. */
const TOOL_DEADLINE_MS = 300_000;

/** Claude Code's MCP tool deadline: the user's own when it is longer, never shorter than the one Scarlet's waits assume. */
export function mcpToolTimeout(user: string | undefined): string {
  const theirs = Number(user);
  return Number.isFinite(theirs) && theirs > TOOL_DEADLINE_MS ? String(Math.floor(theirs)) : String(TOOL_DEADLINE_MS);
}

export async function runClaude(opts: RunAgentOptions): Promise<RunAgentResult> {
  // Scarlet's own variables stay out of the run, so its shell never holds the token.
  const env = workspaceEnv(opts.env ?? process.env, opts.workspace);
  const bin = await resolveCli("claude", opts.bin, env);
  const tmpDir = join(opts.cwd, CONTROL_DIR);
  await mkdir(tmpDir, { recursive: true });
  const cmd = buildClaudeCommand(opts, bin, tmpDir, claudeCanRunBare(env));
  for (const [p, content] of Object.entries(cmd.files)) await writePrivateFile(p, content);

  const st = newClaudeState();
  // Avoid nested-session refusal when the host itself runs under Claude Code.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.MCP_TOOL_TIMEOUT = mcpToolTimeout(env.MCP_TOOL_TIMEOUT);
  let sentUsage: string | undefined;

  const handle = spawnLines(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env,
    stdin: cmd.stdin,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    stallMs: opts.stallMs ?? DEFAULT_STALL_MS,
    onLine: (line) => {
      for (const ev of parseClaudeLine(line, st)) {
        // A resume that finds no session falls back to a fresh run. Keep its error out of the task log.
        if (opts.resumeSession && !st.started && ev.type === "error") continue;
        opts.onEvent(ev);
      }
      // The run's tokens so far, each time they grow, as the other runners and the desktop host report them.
      const usage = claudeRunUsage(st, opts.model);
      const seen = usage && JSON.stringify(usage);
      if (usage && seen !== sentUsage) {
        sentUsage = seen;
        opts.onUsage?.(usage);
      }
      if (st.shouldStop) {
        st.shouldStop = false;
        // The question is posted, or there are no tools; stop the agent instead of letting it ramble.
        setTimeout(() => handle.kill(), 250).unref();
      }
    },
  });
  const outcome = await handle.done;
  const session = { sessionId: st.sessionId ?? (st.started ? opts.resumeSession : undefined), usage: claudeRunUsage(st, opts.model) };
  const early = earlyResult(st, outcome, session);
  if (early) return early;
  const mcpFailed = st.mcpStatus === "failed";
  const ok = !mcpFailed && !st.resultIsError && (outcome.code === 0 || st.result !== undefined);
  return {
    ok,
    summary: st.result || tailSummary(st.texts),
    error: ok ? undefined : mcpFailed ? MCP_FAILED : st.resultIsError ? st.result : `claude exited with code ${outcome.code}${outcome.stderr ? `: ${outcome.stderr.trim().slice(-800)}` : ""}`,
    exitCode: outcome.code,
    resumeFailed: !ok && !!opts.resumeSession && !st.started || undefined,
    ...session,
  };
}
