/**
 * Codex CLI runner.
 *
 *   codex exec --json --skip-git-repo-check --cd <cwd>
 *         -c 'mcp_servers.scarlet.command="node"'
 *         -c 'mcp_servers.scarlet.args=["<path>/cli.js"]'
 *         -c 'mcp_servers.scarlet.env_vars=["SCARLET_SERVER","SCARLET_TOKEN",...]'
 *         --output-last-message <cwd>/.scarlet/last-message.md
 *         [--model m] [-c model_reasoning_effort="e"] [-c service_tier="fast"]
 *         -  (instruction on stdin)
 *
 * Runs are ephemeral: Codex sessions show up in the user's Codex app thread list.
 * After a question, the answer reaches a fresh run through the replayed Q&A.
 *
 * Codex has no system-prompt flag; the system prompt is written to AGENTS.md in
 * the task workspace (Codex reads it from cwd) and the instruction is the prompt.
 * Events are JSONL on stdout (thread.started, turn.started, item.started,
 * item.updated, item.completed, turn.completed, turn.failed, error).
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../private-files.js";
import { briefInput, DEFAULT_STALL_MS, isQuestionTool, planEvent, type RunAgentOptions, type RunAgentResult, type RunnerEvent } from "./types.js";
import { resolveCli, spawnLines, tailSummary } from "./spawn.js";
import { addUsage, codexUsage } from "./usage.js";
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
export function codexPlan(items: unknown): PlanStep[] | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((entry): PlanStep[] => {
    const { text, completed } = (entry ?? {}) as { text?: unknown; completed?: unknown };
    return typeof text === "string" && text.trim() ? [{ text: text.trim(), state: completed === true ? "done" : "pending" }] : [];
  });
}

/** Codex reports stream retries and its HTTPS fallback as errors, then usually carries on. */
export function isRetryNotice(text: string) {
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
          if (isQuestionTool(item.tool)) {
            const text = String((item.arguments as { text?: unknown })?.text ?? briefInput(item.arguments));
            if (type === "item.started" || (!st.question && completed)) {
              st.question = text;
              events.push({ type: "question", text, data: { tool: name, itemId: item.id } });
            }
            if (completed) {
              st.questionPosted = item.status !== "failed" && !item.error;
              st.shouldStop = true;
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
  opts: Pick<RunAgentOptions, "model" | "effort" | "fast" | "serviceTier" | "systemPrompt" | "instruction" | "mcp" | "cwd" | "plan">,
  bin: string,
  tmpDir: string,
): CodexCommand {
  const lastMessagePath = join(tmpDir, "last-message.md");
  // Forward slashes keep the TOML readable and work for node on Windows.
  const toToml = (p: string) => p.replace(/\\/g, "/");
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--cd",
    opts.cwd,
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    // The legacy Windows sandboxes cannot enforce this profile's denied root reads.
    ...(process.platform === "win32" ? ["-c", 'windows.sandbox="mxc"'] : []),
    ...["shell_tool", "view_image", "computer_use", "multi_agent", "plugins", "apps", "hooks"].flatMap((feature) => ["--disable", feature]),
    "-c", 'approval_policy="never"',
    "-c", 'web_search="disabled"',
    // Codex otherwise reads only the first 32 KiB of AGENTS.md. The prompt lists every clip ahead of the task, the
    // editor's notes, their earlier answers and their skills, so on a long timeline those would be cut off.
    "-c", "project_doc_max_bytes=4194304",
    // Codex's own to-do tool, which it reports as `todo_list` items. A Codex without this key refuses it under --strict-config.
    ...(opts.plan ? ["-c", "tools.update_plan.enabled=true"] : []),
    "-c", 'default_permissions="scarlet"',
    "-c", 'permissions.scarlet.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"}}',
    "-c", 'permissions.scarlet.network.enabled=false',
    "-c", 'mcp_servers.scarlet.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.scarlet.required=true",
    "-c", "mcp_servers.scarlet.startup_timeout_sec=60",
    "-c",
    `mcp_servers.scarlet.command=${tomlString(toToml(opts.mcp.command))}`,
    "-c",
    `mcp_servers.scarlet.args=[${opts.mcp.args.map((a) => tomlString(toToml(a))).join(",")}]`,
    "-c",
    `mcp_servers.scarlet.env_vars=[${Object.keys(opts.mcp.env).sort().map(tomlString).join(",")}]`,
    "-c",
    'shell_environment_policy.exclude=["SCARLET_*"]',
    "--output-last-message",
    lastMessagePath,
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort ? ["-c", `model_reasoning_effort=${tomlString(opts.effort)}`] : []),
    ...(opts.serviceTier || opts.fast ? ["-c", `service_tier=${tomlString(opts.serviceTier ?? "fast")}`] : []),
    "-",
  ];
  return {
    file: bin,
    args,
    stdin: opts.instruction,
    files: { [join(opts.cwd, "AGENTS.md")]: opts.systemPrompt },
    lastMessagePath,
  };
}

export async function runCodex(opts: RunAgentOptions): Promise<RunAgentResult> {
  const env = { ...(opts.env ?? process.env), ...opts.mcp.env };
  const bin = await resolveCli("codex", opts.bin, env);
  const tmpDir = join(opts.cwd, ".scarlet");
  await mkdir(tmpDir, { recursive: true });
  const cmd = buildCodexCommand(opts, bin, tmpDir);
  for (const [p, content] of Object.entries(cmd.files)) await writePrivateFile(p, content);

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
  const usage = st.usage && !st.usage.model && opts.model ? { ...st.usage, model: opts.model } : st.usage;
  if (st.question) {
    return { ok: true, summary: tailSummary(st.texts), question: st.question, questionPosted: st.questionPosted, exitCode: outcome.code, usage };
  }
  if (outcome.timedOut) return { ok: false, summary: tailSummary(st.texts), error: outcome.stalled ? "stalled" : "timed out", timedOut: true, stalled: outcome.stalled, exitCode: outcome.code, usage };
  if (outcome.aborted) return { ok: false, summary: tailSummary(st.texts), error: "cancelled", aborted: true, exitCode: outcome.code, usage };
  // A failure line fails the run whatever it says, an empty reason included.
  const ok = st.failed === undefined && (outcome.code === 0 || st.turnCompleted);
  return {
    ok,
    summary: last ?? tailSummary(st.texts),
    error: ok ? undefined : st.failed ?? st.retryNotice ?? `codex exited with code ${outcome.code}${outcome.stderr ? `: ${outcome.stderr.trim().slice(-800)}` : ""}`,
    exitCode: outcome.code,
    usage,
  };
}
