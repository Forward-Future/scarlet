/**
 * What each harness actually delivers to its model and allows in its workspace.
 * Scarlet shapes its tools and prompt from this table instead of asking the
 * model to judge its own abilities ("only if you can play WAV").
 *
 * Keep entries conservative: claim a capability only after checking that the
 * harness forwards that content type from MCP tool results in headless mode.
 * Power users can override per run with SCARLET_AGENT_CAPS='{"audio":true}'. `plan` is read by the engine, which
 * tells each host how to launch the CLI, so set it where the engine runs: SCARLET_AGENT_CAPS='{"plan":true}'.
 */
export interface AgentCapabilities {
  /** Image content blocks in MCP tool results reach the model. */
  images: boolean;
  /** Audio content blocks (WAV) in MCP tool results reach the model. */
  audio: boolean;
  /** The agent can write files in its task artifact directory (needed before `asset_add`). */
  files: boolean;
  /** Character target for paging long MCP text responses. Configurable per harness. */
  resultChars?: number;
  /**
   * Scarlet can launch the harness with its own to-do tool on, and the plan its model keeps there reaches Scarlet as
   * `plan` task events. Off, the model has no such tool and the chat shows no plan. The tool and its description are
   * the harness's. Where it is on, the engine launches a run with the tool, and asks for the steps, only when the
   * chat will show them (`taskPrompt` in `apps/server/src/services/tasks.ts`).
   */
  plan: boolean;
  /** Prefix the harness uses when it exposes Scarlet's MCP tools to the model. */
  toolPrefix?: string;
}

// A 58-minute transcript exceeded Claude Code's result window and was saved to a file its
// file-disabled session couldn't read. Leave headroom below its 50,000-character spill point.
export const DEFAULT_RESULT_CHARS = 40_000;

// `plan` is off for every harness. On 2026-11-08 Claude Code, given the tool and one sentence asking for its steps, laid
// them out within twelve seconds in each of eleven real requests, at a median of about 15 seconds a request. Since
// 2026-11-10 the chat shows only what Scarlet is doing this moment, not a plan, so no run pays for one.
// SCARLET_AGENT_CAPS='{"plan":true}' still turns Claude Code's on. Codex's has not been measured.
const KNOWN: Record<string, AgentCapabilities> = {
  // claude -p runs with --tools "" (no file tools); Claude models take images but not audio.
  // Plan: Claude Code 2.1.316 has TaskCreate and TaskUpdate (TodoWrite before it) only when --tools names them.
  claude: { images: true, audio: false, files: false, plan: false, toolPrefix: "mcp__scarlet__" },
  // codex exec has a writable workspace; MCP audio blocks are not forwarded to the model.
  // Plan: Codex 0.166 has update_plan only with tools.update_plan.enabled, and reports it as `todo_list` items.
  codex: { images: true, audio: false, files: true, plan: false },
  // gemini runs with tools.core = [] (no file tools); audio forwarding from MCP is unverified. Its runner reads no plan.
  gemini: { images: true, audio: false, files: false, plan: false },
};

// An agent Scarlet didn't launch is someone's own MCP client, such as Claude Code or Claude Desktop pointed at Scarlet,
// and each of those shows the model the images a tool returns. Turning images off here would take the frame tools away
// from the one way to run Scarlet without a host. A client that drops images gets them as unreadable content, not a
// wrong measurement: every tool also answers in text.
const UNKNOWN: AgentCapabilities = { images: true, audio: false, files: false, plan: false };

export function agentCapabilities(agent: string | undefined, override?: Partial<AgentCapabilities> | string): AgentCapabilities {
  const base = (agent && Object.hasOwn(KNOWN, agent) && KNOWN[agent]) || UNKNOWN;
  let extra: Partial<AgentCapabilities> = {};
  if (typeof override === "string" && override.trim()) {
    try {
      const parsed = JSON.parse(override) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      for (const key of ["images", "audio", "files", "plan"] as const) if (typeof parsed[key] === "boolean") extra[key] = parsed[key] as boolean;
      if (typeof parsed.resultChars === "number") extra.resultChars = parsed.resultChars;
    } catch {
      extra = {};
      // The value is the user's own text, so it stays out of the log.
      console.warn('[scarlet] SCARLET_AGENT_CAPS ignored: it must be a JSON object such as {"audio":true}');
    }
  } else if (override && typeof override === "object") extra = override;
  const resultChars = extra.resultChars;
  return { ...base, ...extra, resultChars: resultChars !== undefined && Number.isSafeInteger(resultChars) && resultChars >= 2_000
    ? resultChars : DEFAULT_RESULT_CHARS };
}
