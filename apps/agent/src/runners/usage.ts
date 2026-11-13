/**
 * Token usage from each CLI's final report, normalized to Scarlet's AgentUsage.
 * `inputTokens` never includes cache reads or writes, so totals add up the same
 * way for every agent. Mirrors apps/desktop/src-tauri/src/host/usage.rs.
 */
import type { AgentUsage } from "@scarlet/shared";

type Raw = Record<string, unknown> | undefined;

const record = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** A finite, nonnegative whole count, else 0. */
export function tokenCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER) : 0;
}

const has = (o: Raw, ...keys: string[]) => !!o && keys.some(k => typeof o[k] === "number");
const modelName = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);

export function emptyUsage(model?: string): AgentUsage {
  return { model: modelName(model), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export function addUsage(a: AgentUsage | undefined, b: AgentUsage | undefined): AgentUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    model: a.model ?? b.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** Claude Code `usage` (result or per-message): input already excludes the cache. */
export function claudeUsage(raw: unknown, model?: string): AgentUsage | undefined {
  const u = record(raw);
  if (!has(u, "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")) return undefined;
  return {
    ...emptyUsage(model),
    inputTokens: tokenCount(u!.input_tokens),
    outputTokens: tokenCount(u!.output_tokens),
    cacheReadTokens: tokenCount(u!.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(u!.cache_creation_input_tokens),
  };
}

/** Codex `turn.completed.usage`: input includes cached input; output includes reasoning. */
export function codexUsage(raw: unknown, model?: string): AgentUsage | undefined {
  const u = record(raw);
  if (!has(u, "input_tokens", "output_tokens", "cached_input_tokens")) return undefined;
  const cached = tokenCount(u!.cached_input_tokens);
  return {
    ...emptyUsage(model),
    inputTokens: Math.max(0, tokenCount(u!.input_tokens) - cached),
    outputTokens: tokenCount(u!.output_tokens),
    cacheReadTokens: cached,
    reasoningTokens: tokenCount(u!.reasoning_output_tokens),
  };
}

/** Gemini `result.stats`: `input_tokens` includes `cached`; `input` (newer CLIs) is the uncached part. */
export function geminiUsage(raw: unknown, model?: string): AgentUsage | undefined {
  const s = record(raw);
  if (!has(s, "input_tokens", "output_tokens", "input", "cached")) return undefined;
  const cached = tokenCount(s!.cached);
  return {
    ...emptyUsage(model),
    inputTokens: typeof s!.input === "number" ? tokenCount(s!.input) : Math.max(0, tokenCount(s!.input_tokens) - cached),
    outputTokens: tokenCount(s!.output_tokens),
    cacheReadTokens: cached,
  };
}
