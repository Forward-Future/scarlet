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

function emptyUsage(model?: string): AgentUsage {
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

/** A run's usage, named for the model the run asked for when the CLI didn't say which model it used. */
export function usageWithModel(usage: AgentUsage | undefined, model: string | undefined): AgentUsage | undefined {
  return usage && !usage.model && model ? { ...usage, model } : usage;
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
  if (!has(u, "input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens")) return undefined;
  const cached = tokenCount(u!.cached_input_tokens);
  const written = tokenCount(u!.cache_write_input_tokens);
  return {
    ...emptyUsage(model),
    inputTokens: Math.max(0, tokenCount(u!.input_tokens) - cached - written),
    outputTokens: tokenCount(u!.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    reasoningTokens: tokenCount(u!.reasoning_output_tokens),
  };
}

/**
 * Gemini usage: ACP `PromptResponse.usage` (camelCase) or legacy `result.stats` (snake_case).
 * In `agy acp`, `inputTokens` already excludes cached reads and writes (`inputTokens + cachedReadTokens +
 * cachedWriteTokens + outputTokens == totalTokens`). When `totalTokens` instead matches `inputTokens + outputTokens`,
 * subtract cache counts so `inputTokens` stays uncached.
 */
export function geminiUsage(raw: unknown, model?: string): AgentUsage | undefined {
  const s = record(raw);
  if (has(s, "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens")) {
    const rawInput = tokenCount(s!.inputTokens);
    const output = tokenCount(s!.outputTokens);
    const cached = tokenCount(s!.cachedReadTokens);
    const written = tokenCount(s!.cachedWriteTokens);
    const cache = cached + written;
    const total = tokenCount(s!.totalTokens);
    const inputIncludesCache =
      total > 0 &&
      cache > 0 &&
      rawInput >= cache &&
      Math.abs(rawInput + output - total) < Math.abs(rawInput + cache + output - total);
    const input = inputIncludesCache ? Math.max(0, rawInput - cache) : rawInput;
    // `reasoningTokens` is part of `outputTokens`. In agy's own reports `totalTokens` adds up without the thoughts, so
    // its output holds them already. Where they are reported apart (the total counts them on top of the output, or the
    // output is smaller than they are), they are added to it.
    const thought = tokenCount(s!.thoughtTokens);
    const thoughtApart = thought > 0 && (output < thought ||
      (total > 0 && Math.abs(input + cache + output + thought - total) < Math.abs(input + cache + output - total)));
    return {
      ...emptyUsage(model),
      inputTokens: input,
      outputTokens: thoughtApart ? output + thought : output,
      cacheReadTokens: cached,
      cacheWriteTokens: written,
      reasoningTokens: thought,
    };
  }
  if (!has(s, "input_tokens", "output_tokens", "input", "cached")) return undefined;
  const cached = tokenCount(s!.cached);
  return {
    ...emptyUsage(model),
    inputTokens: typeof s!.input === "number" ? tokenCount(s!.input) : Math.max(0, tokenCount(s!.input_tokens) - cached),
    outputTokens: tokenCount(s!.output_tokens),
    cacheReadTokens: cached,
  };
}

/** One `PLANNER_RESPONSE` step from `agy`'s `transcript.jsonl`: `input_tokens` already excludes cache reads. */
export function geminiTranscriptStepUsage(raw: unknown, model?: string): AgentUsage | undefined {
  const s = record(raw);
  if (s?.type !== "PLANNER_RESPONSE") return undefined;
  if (!has(s, "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "thought_tokens", "reasoning_tokens")) return undefined;
  const usage: AgentUsage = {
    ...emptyUsage(model),
    inputTokens: tokenCount(s.input_tokens),
    outputTokens: tokenCount(s.output_tokens),
    cacheReadTokens: tokenCount(s.cache_read_tokens),
    cacheWriteTokens: tokenCount(s.cache_write_tokens),
    reasoningTokens: tokenCount(s.thought_tokens ?? s.reasoning_tokens),
  };
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheWriteTokens === 0 &&
    usage.reasoningTokens === 0
  ) {
    return undefined;
  }
  return usage;
}
