/** Tokens agent runs reported, and their totals by project, thread, request, agent, model or day. */
import { z } from "zod/v3";

const TokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Tokens one agent run reported, normalized across CLIs. `inputTokens` excludes
 * cache reads and writes. `reasoningTokens` is the part of `outputTokens` spent on
 * reasoning, where the CLI reports it.
 */
export const AgentUsage = z.object({
  model: z.string().min(1).max(200).optional(),
  inputTokens: TokenCount.default(0),
  outputTokens: TokenCount.default(0),
  cacheReadTokens: TokenCount.default(0),
  cacheWriteTokens: TokenCount.default(0),
  reasoningTokens: TokenCount.default(0),
});
export type AgentUsage = z.infer<typeof AgentUsage>;

/**
 * One run of a task, as a cumulative total. `startedAt` is the claim's start, which the engine requires: a report for
 * the same claim replaces a smaller one, so a late snapshot can't undo the final total.
 */
export const RecordTaskUsageRequest = AgentUsage.extend({ startedAt: z.string().datetime().optional() });
export type RecordTaskUsageRequest = z.input<typeof RecordTaskUsageRequest>;

export const UsageGroupBy = z.enum(["project", "thread", "task", "agent", "model", "day"]);
export type UsageGroupBy = z.infer<typeof UsageGroupBy>;

export const UsageTotals = z.object({
  runs: z.number().int().nonnegative(),
  /** Model IDs recorded for the runs of this task. Only included in per-task totals. */
  models: z.array(z.string()).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  /** Input, output and cache tokens together. */
  totalTokens: z.number().int().nonnegative(),
  /** Standard API list-price equivalent for the task's reported usage. Null if any reported tokens cannot be priced. */
  estimatedApiCostUsd: z.number().nonnegative().nullable().optional(),
  /** What couldn't be priced, by model and any speed other than standard ("gpt-6.2-sol at Fast speed"). */
  unpricedModels: z.array(z.string()).optional(),
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageGroup = UsageTotals.extend({ key: z.string().nullable() });
export type UsageGroup = z.infer<typeof UsageGroup>;

export const UsageResponse = z.object({ by: UsageGroupBy, total: UsageTotals, groups: z.array(UsageGroup) });
export type UsageResponse = z.infer<typeof UsageResponse>;
