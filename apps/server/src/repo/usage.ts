import type { AgentUsage, Task, UsageGroup, UsageGroupBy, UsageResponse, UsageTotals } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import { now, type Db } from "../db.js";

interface TotalsRow {
  key?: string | null;
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

function toTotals(r: TotalsRow | undefined): UsageTotals {
  const input = r?.input_tokens ?? 0;
  const output = r?.output_tokens ?? 0;
  const cacheRead = r?.cache_read_tokens ?? 0;
  const cacheWrite = r?.cache_write_tokens ?? 0;
  return {
    runs: r?.runs ?? 0,
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
  constructor(private readonly db: Db) {}

  /** Record one run. A repeated report for the same claim replaces the earlier one. */
  record(task: Task, usage: AgentUsage, runStartedAt?: string): void {
    this.db.prepare(`INSERT INTO task_usage (id, task_id, project_id, thread_id, agent, model, run_started_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, run_started_at) DO UPDATE SET model = excluded.model,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens, at = excluded.at`).run(
      newId("use"), task.id, task.projectId, task.context.threadId ?? task.id, task.agent,
      usage.model ?? task.model ?? null, runStartedAt ?? null,
      usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, now(),
    );
  }

  /** One task's totals across its runs. */
  taskTotals(taskId: string): UsageTotals {
    return toTotals(this.db.prepare(`SELECT ${SUMS} FROM task_usage WHERE task_id = ?`).get(taskId) as TotalsRow | undefined);
  }

  /** Totals and groups, most recently used first. Omit `projectId` for every project. */
  summary(by: UsageGroupBy, projectId?: string): UsageResponse {
    const where = projectId === undefined ? "" : " WHERE project_id = ?";
    const params = projectId === undefined ? [] : [projectId];
    const total = this.db.prepare(`SELECT ${SUMS} FROM task_usage${where}`).get(...params) as TotalsRow | undefined;
    const key = GROUP_KEY[by];
    const rows = this.db.prepare(`SELECT ${key} AS key, ${SUMS} FROM task_usage${where} GROUP BY ${key} ORDER BY last_at DESC, key ASC`)
      .all(...params) as TotalsRow[];
    const groups: UsageGroup[] = rows.map(r => ({ key: r.key ?? null, ...toTotals(r) }));
    return { by, total: toTotals(total), groups };
  }
}
