import type { AgentId, SubscriptionQuota } from "@scarlet/shared";
import { AGENT_LABEL, type OnlineAgent } from "../../stores/hosts";

export const LOW_QUOTA_THRESHOLD = 20;
export const QUOTA_STALE_MS = 60_000;

export type QuotaAgent = OnlineAgent & { quota: SubscriptionQuota };

export function isSubscriptionProvider(agent: Pick<OnlineAgent, "id" | "auth">): boolean {
  return (agent.id === "claude" || agent.id === "codex" || agent.id === "gemini") && agent.auth !== "api_key";
}

export function minRemainingPercent(quota?: SubscriptionQuota): number | undefined {
  if (!quota) return undefined;
  if (quota.buckets.length > 0) return Math.min(...quota.buckets.map((b) => b.remainingPercent));
  return quota.unlimited ? 100 : undefined;
}

export function formatPercent(pct: number): string {
  return `${Math.round(pct)}%`;
}

export function formatResetCountdown(resetsAt?: string, nowMs = Date.now()): string | undefined {
  if (!resetsAt) return undefined;
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return undefined;
  const diffMins = Math.round((ms - nowMs) / 60_000);
  if (diffMins <= 0) return "soon";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffMins < 24 * 60) {
    const h = Math.floor(diffMins / 60);
    const m = diffMins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(diffMins / 1440);
  const h = Math.floor((diffMins % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

export function formatRelativeAge(iso?: string, nowMs = Date.now()): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const diffSec = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 3600) return `${Math.max(1, Math.round(diffSec / 60))}m ago`;
  if (diffSec < 86_400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86_400)}d ago`;
}

/** The provider's name without its tool suffix, like "Claude" for Claude Code. */
export function providerShortName(id: AgentId): string {
  return AGENT_LABEL[id]?.replace(/ (Code|CLI)$/, "") ?? id;
}
