import { AgentOptionId, type AgentId } from "@scarlet/shared";
import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { runGemini } from "./gemini.js";
import type { RunAgentFn, RunAgentOptions, RunAgentResult } from "./types.js";

export const RUNNERS: Record<Exclude<AgentId, "api">, RunAgentFn> = {
  claude: runClaude,
  codex: runCodex,
  gemini: runGemini,
};

export function runnerFor(agent: AgentId): RunAgentFn {
  const r = (RUNNERS as Record<string, RunAgentFn | undefined>)[agent];
  if (!r) throw new Error(`no runner for agent "${agent}"`);
  return r;
}

/** Dispatch on opts.agent. */
export const runAgent: RunAgentFn = async (opts: RunAgentOptions): Promise<RunAgentResult> => {
  // Model and effort are launcher arguments, including on Windows batch shims.
  if ((opts.model && !/^[a-z0-9][a-z0-9._:/@+\[\]-]*$/i.test(opts.model)) ||
      [opts.effort, opts.serviceTier].some(id => id !== undefined && !AgentOptionId.safeParse(id).success)) {
    return { ok: false, summary: "", error: "Invalid model or model option" };
  }
  return runnerFor(opts.agent)(opts);
};

export * from "./types.js";
export { parseClaudeLine, newClaudeState, buildClaudeCommand, runClaude, claudeRunUsage } from "./claude.js";
export { addUsage, claudeUsage, codexUsage, geminiUsage, tokenCount } from "./usage.js";
export { parseCodexLine, newCodexState, buildCodexCommand, runCodex, tomlString, tomlInlineTable } from "./codex.js";
export { parseGeminiLine, newGeminiState, buildGeminiCommand, runGemini } from "./gemini.js";
export { resolveMcpCliPath, nodeExecutable, mcpEnv, quoteForCmd, spawnSpec, spawnLines, resolveCli } from "./spawn.js";
