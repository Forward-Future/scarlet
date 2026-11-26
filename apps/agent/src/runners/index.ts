import { AgentOptionId, type AgentId, type ExtraProvider } from "@scarlet/shared";
import { MODEL_ID } from "../modelCatalog.js";
import { providerRunEnv, resolveProviders } from "../providers.js";
import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { runGemini } from "./gemini.js";
import { runnerLog } from "./spawn.js";
import type { RunAgentFn, RunAgentOptions, RunAgentResult } from "./types.js";

/**
 * An extra provider's runs: Claude Code pointed at the provider, with the chosen model for every tier. Claude's own
 * effort and fast mode mean nothing to another provider's model, so they are left out.
 */
export function providerRunner(agent: ExtraProvider): RunAgentFn {
  return async (opts) => {
    const base = opts.env ?? process.env;
    const providers = resolveProviders(opts.providers, base);
    const built = providerRunEnv(agent, opts.model, base, providers);
    const runLog = runnerLog(opts, agent);
    if ("error" in built) {
      runLog(`could not start: ${built.error}`);
      return { ok: false, summary: "", error: built.error };
    }
    // The address's host only: a URL typed into agent.json could carry a password.
    let at = "";
    try { at = ` at ${new URL(providers[agent].url).host}`; } catch { /* not an address: said without one */ }
    runLog(`runs through Claude Code${at}`);
    return runClaude({ ...opts, effort: undefined, fast: undefined, serviceTier: undefined, env: built.env, settingsEnv: built.settingsEnv });
  };
}

export const RUNNERS: Record<Exclude<AgentId, "api">, RunAgentFn> = {
  claude: runClaude,
  codex: runCodex,
  gemini: runGemini,
  ollama: providerRunner("ollama"),
  lmstudio: providerRunner("lmstudio"),
  openrouter: providerRunner("openrouter"),
};

export function runnerFor(agent: AgentId): RunAgentFn {
  const r = (RUNNERS as Record<string, RunAgentFn | undefined>)[agent];
  if (!r) throw new Error(`no runner for agent "${agent}"`);
  return r;
}

/** Dispatch on opts.agent. */
export const runAgent: RunAgentFn = async (opts: RunAgentOptions): Promise<RunAgentResult> => {
  // Model and effort are launcher arguments, including on Windows batch shims.
  if ((opts.model && !MODEL_ID.test(opts.model)) ||
      [opts.effort, opts.serviceTier].some(id => id !== undefined && !AgentOptionId.safeParse(id).success)) {
    return { ok: false, summary: "", error: "Invalid model or model option" };
  }
  return runnerFor(opts.agent)(opts);
};

export * from "./types.js";
export { parseClaudeLine, newClaudeState, buildClaudeCommand, runClaude, claudeRunUsage } from "./claude.js";
export { addUsage, claudeUsage, codexUsage, geminiUsage, tokenCount } from "./usage.js";
export { parseCodexLine, newCodexState } from "./codexParse.js";
export { buildCodexCommand, runCodex, tomlString, tomlInlineTable } from "./codex.js";
export { acpMcpServer, buildGeminiCommand, isScarletMcpPermission, newGeminiState, parseGeminiAcpUpdate, parseGeminiLine, permissionOutcome } from "./geminiAcp.js";
export { runGemini } from "./gemini.js";
export { resolveMcpCliPath, nodeExecutable, mcpEnv, quoteForCmd, spawnSpec, spawnLines, resolveCli } from "./spawn.js";
