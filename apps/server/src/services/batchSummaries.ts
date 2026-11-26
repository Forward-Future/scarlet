/**
 * AI-generated short titles for collapsed edit batches in the beta edits list.
 *
 * Summaries are cached permanently in SQLite (`batch_summaries`) keyed by a deterministic hash of each batch's
 * contents so each batch is summarized at most once. When an API key is configured, Scarlet calls a fast model
 * directly over HTTP (~300–600 ms); otherwise it runs a silent, zero-tool `batch_summary` side-check on an online
 * signed-in CLI host so desktop users without raw API keys still get AI summaries.
 */
import { type AgentId, type BatchSummariesResponse, type BatchSummaryItem, type Task } from "@scarlet/shared";
import { BATCH_SUMMARY_SYSTEM } from "@scarlet/mcp/prompt";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { taskFailureReason } from "../telemetry/failureReason.js";
import { createTask } from "./tasks.js";

const HOST_ONLINE_MS = 90_000;
const DIRECT_TIMEOUT_MS = 15_000;
const DIRECT_WAIT_MS = 2_500;
const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const RECENT_ASSISTANT_FAILURE_MS = 15 * 60 * 1000;
const MAX_TITLE_CHARS = 72;

const DIRECT_DEFAULT_MODEL = {
  anthropic: "claude-haiku-4-5",
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
} as const;

const PERSISTENT_ASSISTANT_FAILURES: ReadonlySet<string> = new Set([
  "agent_not_installed",
  "agent_not_signed_in",
  "agent_incompatible",
  "model_unavailable",
  "rate_limited",
]);

const REFUSAL_PREFIX = /^(?:sorry\b|i(?:'m| am)?\s+(?:sorry|unable|not able|cannot)|i can(?:'t|not)\b|cannot\b|here(?:'s| is)\b|sure[,!:\s])/i;

const inFlight = new WeakMap<Ctx, Map<string, Promise<string | null>>>();

function inflightMap(ctx: Ctx): Map<string, Promise<string | null>> {
  let map = inFlight.get(ctx);
  if (!map) {
    map = new Map();
    inFlight.set(ctx, map);
  }
  return map;
}

/** Clean up a model's one-line batch title and reject empty, multi-sentence, or refusal outputs. */
export function sanitizeBatchTitle(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const firstLine = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  let text = firstLine
    .replace(/^[-*•]\s+/, "")
    .replace(/^["'“”`]+|["'“”`]+$/g, "")
    .replace(/^(?:title|summary)\s*:\s*/i, "")
    .replace(/^["'“”`]+|["'“”`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?:;]+$/, "")
    .trim();
  if (text.length < 3 || text.length > MAX_TITLE_CHARS) return undefined;
  if (REFUSAL_PREFIX.test(text)) return undefined;
  return text;
}

function formatDuration(seconds: number): string {
  if (seconds < 59.5) {
    const tenths = Math.round(seconds * 10) / 10;
    return `${tenths < 10 ? tenths.toFixed(1) : Math.round(seconds)} s`;
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const KIND_LABEL: Record<string, string> = {
  cut: "cuts",
  restore: "restored passages",
  insert: "inserts",
  audio: "audio edits",
  dip: "music dips",
  voice: "voice cleanups",
  zoom: "zooms",
  reframe: "reframes",
  text: "text/caption edits",
  broll: "B-roll shots",
  overlay: "overlays",
  graphic: "motion graphics",
  speed: "speed changes",
  transition: "transitions",
  split: "split edits",
};

/** Structured plain-text input sent to the AI summarizer for one collapsed batch. */
export function buildBatchSummaryPrompt(item: BatchSummaryItem): string {
  const kindWord = item.isDialoguePass ? "dialogue cuts" : (item.kind ? KIND_LABEL[item.kind] ?? `${item.kind} edits` : "edits");
  const removed = item.removedSeconds && item.removedSeconds > 0 ? ` (total cut: ${formatDuration(item.removedSeconds)})` : "";
  const lines = [`Batch: ${item.count} ${kindWord}${removed}`];
  if (item.request?.trim()) lines.push(`Editor's request: "${item.request.trim()}"`);
  if (item.breakdown && Object.keys(item.breakdown).length > 0) {
    const parts = Object.entries(item.breakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`);
    lines.push(`Breakdown: ${parts.join(", ")}`);
  }
  if (item.descriptions?.length) {
    lines.push("Change summaries:");
    for (const d of item.descriptions) lines.push(`- ${d}`);
  }
  if (item.samples.length) {
    const heading = item.samples.length < item.count
      ? `Sample edits (${item.samples.length} of ${item.count}):`
      : `Edits in this batch (${item.samples.length}):`;
    lines.push(heading);
    for (const s of item.samples) {
      lines.push(s.reason ? `- ${s.label} — ${s.reason}` : `- ${s.label}`);
    }
  }
  return lines.join("\n");
}

function readCachedSummaries(ctx: Ctx, projectId: string, keys: readonly string[]): Record<string, string> {
  if (!keys.length) return {};
  const rows = ctx.db.prepare(
    "SELECT batch_key, title FROM batch_summaries WHERE project_id = ? AND batch_key IN (SELECT value FROM json_each(?))",
  ).all(projectId, JSON.stringify(keys)) as Array<{ batch_key: string; title: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.batch_key] = row.title;
  return out;
}

export function saveBatchSummary(ctx: Ctx, projectId: string, key: string, title: string): void {
  const exists = ctx.db.prepare("SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL").get(projectId);
  if (!exists) return;
  ctx.db.prepare(
    "INSERT OR REPLACE INTO batch_summaries (project_id, batch_key, title, created_at) VALUES (?, ?, ?, ?)",
  ).run(projectId, key, title, now());
  ctx.bus.publish({ type: "batch_summary.updated", projectId, key, title });
}

type DirectProvider = "anthropic" | "gemini" | "openai";

function pickDirectProvider(ctx: Ctx): { provider: DirectProvider; model: string } | undefined {
  const env = ctx.options.env ?? process.env;
  const preferred = ctx.settings().noteCleanup.provider;
  const keyOf = (p: DirectProvider) =>
    p === "anthropic" ? ctx.env.anthropicKey : p === "gemini" ? ctx.env.geminiKey : ctx.env.openaiKey;
  const order: DirectProvider[] = preferred !== "none"
    ? [preferred, ...(["anthropic", "gemini", "openai"] as const).filter(p => p !== preferred)]
    : ["anthropic", "gemini", "openai"];
  const provider = order.find(p => !!keyOf(p));
  if (!provider) return undefined;
  const envModel = env.SCARLET_BATCH_SUMMARY_MODEL
    || (provider === "anthropic" ? env.SCARLET_CLEANUP_ANTHROPIC_MODEL
      : provider === "gemini" ? env.SCARLET_CLEANUP_GEMINI_MODEL
      : env.SCARLET_CLEANUP_OPENAI_MODEL);
  const model = envModel || DIRECT_DEFAULT_MODEL[provider];
  return { provider, model };
}

async function callDirectAi(ctx: Ctx, provider: DirectProvider, model: string, userPrompt: string): Promise<string | null> {
  const signal = AbortSignal.any([AbortSignal.timeout(DIRECT_TIMEOUT_MS), ctx.shutdown]);
  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ctx.env.anthropicKey!,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 80,
          fallbacks: "default",
          system: BATCH_SUMMARY_SYSTEM,
          messages: [{ role: "user", content: userPrompt }],
        }),
        signal,
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
      if (json.stop_reason === "refusal") return null;
      const text = (json.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();
      return sanitizeBatchTitle(text) ?? null;
    }
    if (provider === "gemini") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": ctx.env.geminiKey! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: BATCH_SUMMARY_SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { maxOutputTokens: 80 },
        }),
        signal,
      });
      if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      };
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .filter(p => !p.thought)
        .map(p => p.text ?? "")
        .join("")
        .trim();
      return sanitizeBatchTitle(text) ?? null;
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.env.openaiKey!}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: BATCH_SUMMARY_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 80,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return sanitizeBatchTitle(json.choices?.[0]?.message?.content) ?? null;
  } catch (err) {
    ctx.log(`[batch-summary] direct ${provider} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function assistantRecentlyBroken(ctx: Ctx, agent: string): boolean {
  const latest = ctx.repos.tasks.select(
    "agent = ? AND state IN ('done', 'failed') AND kind != 'transcribe'",
    [agent],
    "json_extract(json, '$.finishedAt') DESC, rowid DESC LIMIT 1",
  )[0];
  if (!latest || latest.state !== "failed") return false;
  const finishedAt = Date.parse(latest.finishedAt ?? "");
  if (!Number.isFinite(finishedAt) || Date.now() - finishedAt > RECENT_ASSISTANT_FAILURE_MS) return false;
  return PERSISTENT_ASSISTANT_FAILURES.has(taskFailureReason(latest));
}

function pickFastModel(agent: string, models?: readonly string[]): string | undefined {
  if (!models?.length) return undefined;
  const prefer = agent === "claude"
    ? [/haiku/i, /sonnet/i]
    : agent === "gemini"
    ? [/flash/i]
    : [/mini/i, /nano/i];
  for (const re of prefer) {
    const match = models.find(m => re.test(m));
    if (match) return match;
  }
  return undefined;
}

function pickOnlineSummaryAgent(ctx: Ctx): { agent: AgentId; model?: string } | undefined {
  const online = ctx.repos.hosts.select().filter(h => h.lastSeenAt && Date.now() - Date.parse(h.lastSeenAt) < HOST_ONLINE_MS);
  const candidates = online.flatMap(h => h.agents).filter(a => a.installed && a.loggedIn !== false && a.id !== "api");
  const preference = ["claude", "gemini", "codex", "openrouter", "ollama", "lmstudio"];
  candidates.sort((a, b) => {
    const ia = preference.indexOf(a.id), ib = preference.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const cand of candidates) {
    if (assistantRecentlyBroken(ctx, cand.id)) continue;
    const fast = pickFastModel(cand.id, cand.models);
    return { agent: cand.id as AgentId, ...(fast ? { model: fast } : cand.model ? { model: cand.model } : {}) };
  }
  return undefined;
}

/**
 * Return cached AI titles for `batches` and trigger AI summarization for any missing ones.
 * Waits briefly for fast direct HTTP calls so titles often arrive in the same response; slower calls and
 * CLI-host side checks finish asynchronously and push `batch_summary.updated` over WebSocket.
 */
export async function summarizeBatches(
  ctx: Ctx,
  projectId: string,
  batches: readonly BatchSummaryItem[],
  opts: { waitMs?: number } = {},
): Promise<BatchSummariesResponse> {
  const keys = batches.map(b => b.key);
  const summaries = readCachedSummaries(ctx, projectId, keys);
  const missing = batches.filter(b => !summaries[b.key]);
  if (!missing.length) return { summaries, pending: [] };

  const direct = pickDirectProvider(ctx);
  const pending: string[] = [];

  if (direct) {
    const flights = inflightMap(ctx);
    const runs: Array<{ key: string; promise: Promise<string | null> }> = [];
    for (const item of missing) {
      const flightKey = `${projectId}:${item.key}`;
      let run = flights.get(flightKey);
      if (!run) {
        const prompt = buildBatchSummaryPrompt(item);
        run = callDirectAi(ctx, direct.provider, direct.model, prompt).then(title => {
          if (title) saveBatchSummary(ctx, projectId, item.key, title);
          return title;
        }).finally(() => {
          if (flights.get(flightKey) === run) flights.delete(flightKey);
        });
        flights.set(flightKey, run);
        ctx.track(run, projectId).catch(() => {});
      }
      runs.push({ key: item.key, promise: run });
    }
    const waitMs = opts.waitMs ?? DIRECT_WAIT_MS;
    if (waitMs > 0) {
      await Promise.race([
        Promise.allSettled(runs.map(r => r.promise)),
        new Promise<void>(resolve => setTimeout(resolve, waitMs).unref()),
      ]);
    }
    const refreshed = readCachedSummaries(ctx, projectId, missing.map(m => m.key));
    Object.assign(summaries, refreshed);
    for (const item of missing) {
      if (!summaries[item.key] && flights.has(`${projectId}:${item.key}`)) pending.push(item.key);
    }
    return { summaries, pending };
  }

  // No direct API key: fall back to a silent zero-tool CLI side-check on any online signed-in host.
  const hostAgent = pickOnlineSummaryAgent(ctx);
  if (!hostAgent) return { summaries, pending: [] };

  const existing = ctx.repos.tasks.select(
    "project_id = ? AND kind = 'batch_summary'",
    [projectId],
    "created_at DESC, rowid DESC",
  );
  for (const item of missing) {
    const prior = existing.find(t => t.context.batchSummary?.key === item.key && t.state !== "cancelled");
    if (prior) {
      if (prior.state === "queued" || prior.state === "claimed" || prior.state === "running") {
        pending.push(item.key);
        continue;
      }
      if (prior.state === "done") {
        const recovered = sanitizeBatchTitle(prior.summary);
        if (recovered) {
          saveBatchSummary(ctx, projectId, item.key, recovered);
          summaries[item.key] = recovered;
          continue;
        }
      }
      if (prior.state === "failed" && prior.finishedAt && Date.now() - Date.parse(prior.finishedAt) < FAILED_COOLDOWN_MS) {
        continue;
      }
    }
    const prompt = buildBatchSummaryPrompt(item);
    createTask(ctx, {
      projectId,
      kind: "batch_summary",
      agent: hostAgent.agent,
      model: hostAgent.model,
      instruction: prompt,
      context: { batchSummary: { key: item.key, prompt } },
      createdBy: { type: "scarlet", name: "Scarlet" },
    });
    pending.push(item.key);
  }
  return { summaries, pending };
}

/** Save and broadcast the AI summary produced by a completed `batch_summary` side-check task. */
export function finishBatchSummaryTask(ctx: Ctx, task: Task): void {
  if (task.kind !== "batch_summary" || task.state !== "done") return;
  const key = task.context.batchSummary?.key;
  if (!key) return;
  const title = sanitizeBatchTitle(task.summary);
  if (!title) return;
  saveBatchSummary(ctx, task.projectId, key, title);
}
