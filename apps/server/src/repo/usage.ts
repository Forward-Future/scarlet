import type { AgentUsage, Task, UsageGroup, UsageGroupBy, UsageResponse, UsageTotals } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import { now, type Db } from "../db.js";
import { estimateApiTokenCost, priceLabel, speedTier } from "./apiTokenCost.js";
import type { PriceLookup } from "./modelPrices.js";

interface TotalsRow {
  key?: string | null;
  models?: string;
  claims?: string;
  runs: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  first_at: string | null;
  last_at: string | null;
}

/** Fixed SQL per grouping, so a query value never reaches the statement text. */
const GROUP_KEY: Record<UsageGroupBy, string> = {
  project: "project_id",
  thread: "thread_id",
  task: "task_id",
  agent: "agent",
  model: "model",
  day: "substr(at, 1, 10)",
};

const SUMS = `count(*) AS runs,
  sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
  sum(reasoning_tokens) AS reasoning_tokens,
  min(at) AS first_at, max(at) AS last_at`;
const TASK_SUMS = `${SUMS}, json_group_array(DISTINCT model ORDER BY model) FILTER (WHERE model IS NOT NULL) AS models,
  json_group_array(json_array(model, coalesce(run_started_at, at), input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    (SELECT json_extract(t.json, '$.serviceTier') FROM tasks t WHERE t.id = task_usage.task_id),
    (SELECT json_extract(t.json, '$.fast') FROM tasks t WHERE t.id = task_usage.task_id))) AS claims`;

type Claim = [model: string | null, at: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number,
  serviceTier: string | null, fast: number | boolean | null];

/** Price each claim before combining its usage with claims for other models. A run at a speed is priced at that speed. */
function estimateClaims(claims: string, prices?: PriceLookup): { cost: number | null; unpriced: string[] } {
  let total = 0;
  const unpriced = new Set<string>();
  for (const [model, at, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, serviceTier, fast] of JSON.parse(claims) as Claim[]) {
    const tier = speedTier(serviceTier, !!fast);
    const cost = estimateApiTokenCost(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, at, { tier, prices });
    if (cost === undefined) unpriced.add(priceLabel(model, tier));
    else total += cost;
  }
  if (unpriced.size) prices?.missed();
  return { cost: unpriced.size ? null : total, unpriced: [...unpriced] };
}

function toTotals(r: TotalsRow | undefined, prices?: PriceLookup): UsageTotals {
  const estimate = r?.claims !== undefined ? estimateClaims(r.claims, prices) : undefined;
  const input = r?.input_tokens ?? 0;
  const output = r?.output_tokens ?? 0;
  const cacheRead = r?.cache_read_tokens ?? 0;
  const cacheWrite = r?.cache_write_tokens ?? 0;
  return {
    runs: r?.runs ?? 0,
    ...(r?.models !== undefined && { models: JSON.parse(r.models) as string[] }),
    ...(estimate && { estimatedApiCostUsd: estimate.cost }),
    ...(estimate?.unpriced.length && { unpricedModels: estimate.unpriced }),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: r?.reasoning_tokens ?? 0,
    totalTokens: input + output + cacheRead + cacheWrite,
    firstAt: r?.first_at ?? null,
    lastAt: r?.last_at ?? null,
  };
}

/** Agent token usage, one row per run of a task. */
export class UsageRepo {
  constructor(private readonly db: Db, private readonly prices?: PriceLookup) {}

  /**
   * Record one run. A repeated report for the same claim replaces the earlier one when its total is at least as large:
   * reports are cumulative, so a snapshot that arrives after the final total is older, and is dropped.
   */
  record(task: Task, usage: AgentUsage, runStartedAt?: string): void {
    this.db.prepare(`INSERT INTO task_usage (id, task_id, project_id, thread_id, agent, model, run_started_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, run_started_at) DO UPDATE SET model = coalesce(?, task_usage.model, excluded.model),
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens, at = excluded.at
      WHERE excluded.input_tokens + excluded.output_tokens + excluded.cache_read_tokens + excluded.cache_write_tokens
        >= task_usage.input_tokens + task_usage.output_tokens + task_usage.cache_read_tokens + task_usage.cache_write_tokens`).run(
      newId("use"), task.id, task.projectId, task.context.threadId ?? task.id, task.agent,
      usage.model ?? task.model ?? null, runStartedAt ?? null,
      usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, now(),
      usage.model ?? null,
    );
  }

  /** Whether this claim of the task has reported tokens before. */
  reported(taskId: string, runStartedAt: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM task_usage WHERE task_id = ? AND run_started_at = ?").get(taskId, runStartedAt);
  }

  /** One task's totals across its runs. */
  taskTotals(taskId: string): UsageTotals {
    return toTotals(this.db.prepare(`SELECT ${TASK_SUMS} FROM task_usage WHERE task_id = ?`).get(taskId) as TotalsRow | undefined, this.prices);
  }

  /** Totals and groups, most recently used first. Omit `projectId` for every project. */
  summary(by: UsageGroupBy, projectId?: string): UsageResponse {
    const where = projectId === undefined ? "" : " WHERE project_id = ?";
    const params = projectId === undefined ? [] : [projectId];
    const total = this.db.prepare(`SELECT ${SUMS} FROM task_usage${where}`).get(...params) as TotalsRow | undefined;
    const key = GROUP_KEY[by];
    const rows = this.db.prepare(`SELECT ${key} AS key, ${by === "task" ? TASK_SUMS : SUMS} FROM task_usage${where} GROUP BY ${key} ORDER BY last_at DESC, key ASC`)
      .all(...params) as TotalsRow[];
    const groups: UsageGroup[] = rows.map(r => ({ key: r.key ?? null, ...toTotals(r, this.prices) }));
    return { by, total: toTotals(total), groups };
  }
}
