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
  /** Per-task workspace. The agent may write temp files here. */
  cwd: string;
  mcp: McpSpec;
  onEvent: (ev: RunnerEvent) => void;
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

/** Five times the longest silence measured across real editing runs (1.9 minutes). */
export const DEFAULT_STALL_MS = 10 * 60 * 1000;

/** Matches the Scarlet question tool however the CLI namespaces it (mcp__scarlet__task_question, scarlet__task_question, task_question). */
export function isQuestionTool(name: string | undefined): boolean {
  return name === "mcp_scarlet_task_question" || (!!name && /(^|__|\.|\/)task_question$/.test(name));
}

/** Strip the MCP namespace prefix for display: mcp__scarlet__timeline_get -> scarlet.timeline_get */
export function prettyToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (m) return `${m[1]}.${m[2]}`;
  return name.replace(/^scarlet__/, "scarlet.");
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
