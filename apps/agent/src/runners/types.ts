import { planText, type AgentEffort, type AgentId, type AgentUsage, type PlanStep } from "@scarlet/shared";

export type RunnerEventType = "log" | "tool" | "question" | "plan" | "result" | "error";

export interface RunnerEvent {
  type: RunnerEventType;
  text: string;
  data?: Record<string, unknown>;
}

export interface McpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type CodexFallbackReason = "api_key" | "project_config" | "home_unavailable" | "auth_unavailable" | "isolation_unavailable" |
  "initialize_failed" | "thread_start_failed" | "thread_resume_failed" | "thread_policy_mismatch" | "app_server_unavailable";

/**
 * What a request's agent works with beyond Scarlet's tools: its harness's shell (sandboxed to the task folder,
 * writing only there and reaching the web), file tools and web search. The editor chose this for every model and every
 * request (2026-11-21).
 */
export interface Workspace {
  /** Links to ffmpeg, ffprobe and a headless Chrome, put first on the shell's PATH. Absent when the host has none. */
  binDir?: string;
  /** Folders outside the task folder the shell must read to run those programs. */
  readDirs: string[];
}

/** The task folder's subfolder of CLI control files, which hold Scarlet's access token: never readable by the agent. */
export const CONTROL_DIR = ".scarlet";

/** A CLI's environment for a run: without Scarlet's own variables (the token among them), its links first on PATH. */
export function workspaceEnv(env: NodeJS.ProcessEnv, workspace: Workspace | undefined, keep: readonly string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!/^SCARLET_/i.test(key) || keep.includes(key)) out[key] = value;
  if (workspace?.binDir) {
    const pathKey = Object.keys(out).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    out[pathKey] = [workspace.binDir, out[pathKey]].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
  }
  return out;
}

export interface RunAgentOptions {
  agent: AgentId;
  model?: string;
  effort?: AgentEffort;
  /** Fast mode (Claude fast mode / Codex fast service tier). */
  fast?: boolean;
  serviceTier?: string;
  systemPrompt: string;
  instruction: string;
  /** Continue this CLI session (it asked the question `instruction` answers). */
  resumeSession?: string;
  /** Launch the CLI with its own to-do tool on. The engine decides (`plan` in the task's prompt). */
  plan?: boolean;
  /** The engine's words for the turn after Scarlet refused a tool, `{tool}` standing for its name (`refusedTool`). */
  refusedTool?: string;
  /** Per-task workspace. The agent may write temp files here. */
  cwd: string;
  /**
   * The harness's own shell, file and web tools, beside Scarlet's, for a request. Absent for a side check or a skill's
   * edit, whose runs have Scarlet's tools only.
   */
  workspace?: Workspace;
  mcp: McpSpec;
  onEvent: (ev: RunnerEvent) => void;
  onCodexFallback?: (reason: CodexFallbackReason) => void;
  /** Cumulative tokens observed so far in this CLI invocation. */
  onUsage?: (usage: AgentUsage) => void;
  signal?: AbortSignal;
  /** Optional cap on the whole run. None by default: a working agent takes as long as it needs. */
  timeoutMs?: number;
  /** Stop the CLI once it has written nothing for this long. Default `DEFAULT_STALL_MS`. */
  stallMs?: number;
  /** Override the CLI executable (tests, or a non-PATH install). */
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunAgentResult {
  ok: boolean;
  summary: string;
  /** Set when the agent called task_question: the host must not complete the task. */
  question?: string;
  /** Provider-reported success. The engine acknowledges the durable pause. */
  questionPosted?: boolean;
  error?: string;
  exitCode?: number | null;
  /** The run was stopped: at its `timeoutMs` cap, or because it went silent (`stalled`). */
  timedOut?: boolean;
  stalled?: boolean;
  aborted?: boolean;
  /** The CLI session this run used, for resuming after a question. */
  sessionId?: string;
  /** The CLI could not open `resumeSession`. Nothing ran; start a fresh run. */
  resumeFailed?: boolean;
  /** Tokens the CLI reported for this run, when it reported any. */
  usage?: AgentUsage;
}

export type RunAgentFn = (opts: RunAgentOptions) => Promise<RunAgentResult>;

/** The agent's plan as its harness just reported it, whole. The engine records it only when it changed. */
export function planEvent(steps: PlanStep[]): RunnerEvent {
  return { type: "plan", text: planText(steps), data: { steps } };
}

/** The harness compacted the run's context. The engine logs it, with the task, and keeps it out of the chat. */
export const COMPACTED = { type: "log", text: "Context compacted", data: { kind: "compaction" } } as const satisfies RunnerEvent;

/** Five times the longest silence measured across real editing runs (1.9 minutes). */
export const DEFAULT_STALL_MS = 10 * 60 * 1000;

/** Matches the Scarlet question tool however the CLI namespaces it (mcp__scarlet__task_question, scarlet__task_question, scarlet:task_question, task_question). */
export function isQuestionTool(name: string | undefined): boolean {
  return name === "mcp_scarlet_task_question" || (!!name && /(^|__|\.|\/|:)task_question$/.test(name));
}

/**
 * The words of a task_question call, when it has any. Only such a call is a question: one with no words is refused by
 * Scarlet's MCP server, and the model hears why and tries again. Taken for a question, it put the call's raw input
 * before the editor. The desktop host reads it the same way.
 */
export function questionText(input: unknown): string | undefined {
  const text = input && typeof input === "object" ? (input as { text?: unknown }).text : undefined;
  return typeof text === "string" && text.trim() ? text : undefined;
}

/** Strip the MCP namespace prefix for display: mcp__scarlet__timeline_get -> scarlet.timeline_get */
export function prettyToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (m) return `${m[1]}.${m[2]}`;
  if (name.startsWith("mcp_scarlet_")) return `scarlet.${name.slice("mcp_scarlet_".length)}`;
  return name.replace(/^scarlet(?:__|\/|:)/, "scarlet.");
}

export function briefInput(input: unknown, max = 160): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "object" && !Array.isArray(input) && Object.keys(input as object).length === 0) return "";
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
