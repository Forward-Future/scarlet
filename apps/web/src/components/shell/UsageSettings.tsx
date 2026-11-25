import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentId, UsageGroup, UsageResponse } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { plural, relTime, tokenBreakdown, tokenLabel } from "../../lib/format";
import { AGENT_LABEL, onlineAgents, useHostsStore } from "../../stores/hosts";
import { useUiStore } from "../../stores/ui";
import { ProviderIcon } from "../agent/ModelProviders";
import {
  LOW_QUOTA_THRESHOLD,
  QUOTA_STALE_MS,
  formatPercent,
  formatRelativeAge,
  formatResetCountdown,
  isSubscriptionProvider,
  minRemainingPercent,
  providerShortName,
  type QuotaAgent,
} from "../agent/subscriptionQuota";
import { Icon, InlineError, Toggle } from "../ui/primitives";

type BreakdownTab = "project" | "agent" | "model";

interface ProjectMeta {
  name: string;
  trashed: boolean;
}

interface UsageState {
  byProject: UsageResponse;
  byAgent: UsageResponse;
  byModel: UsageResponse;
  byDay: UsageResponse | null;
  projects: Map<string, ProjectMeta>;
}

const INITIAL_ROWS = 6;
const ACTIVITY_DAYS = 14;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_PROVIDERS = new Set<string>(["claude", "codex", "gemini", "ollama", "lmstudio", "openrouter", "api"]);

/** Compact numeric token count without unit word: 900, 48.2K, 1.3M, 1.2B. */
function compactNumber(n: number): string {
  if (n < 1000) return n.toLocaleString();
  const [value, unit] =
    n < 999_500 ? [n / 1000, "K"] :
    n < 999_500_000 ? [n / 1_000_000, "M"] :
    [n / 1_000_000_000, "B"];
  const shown = value >= 100 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${shown}${unit}`;
}

/** Share of total as a compact percentage label ("84%", "<1%", "0%"). */
function shareLabel(part: number, total: number): string {
  if (!total || !part) return "0%";
  const pct = (part / total) * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** Format a YYYY-MM-DD UTC date key as a short label like "Nov 22". */
function shortDayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Format an ISO timestamp as a clean calendar date like "Nov 1, 2026". */
function sinceDateLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Human-friendly model label from known hosts or versioned Claude IDs. */
function formatModelId(id: string): string {
  const [, family, major, minor] = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)-(\d+)$/.exec(id) ?? [];
  return family ? `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}` : id;
}

/** Best-effort provider icon match for a model ID when no live host reports it. */
function inferProviderFromModel(id: string): AgentId | null {
  const lower = id.toLowerCase();
  if (lower.startsWith("claude") || lower === "opus" || lower === "sonnet" || lower === "haiku") return "claude";
  if (lower.startsWith("gemini")) return "gemini";
  if (/^(gpt|o[1-9]|codex)/.test(lower)) return "codex";
  return null;
}

/** Compact single-line breakdown for a breakdown row (full exact figures stay on hover). */
function compactBreakdown(g: UsageGroup): string {
  const cache = g.cacheReadTokens + g.cacheWriteTokens;
  const parts = [
    `${compactNumber(g.inputTokens)} input`,
    `${compactNumber(g.outputTokens)} output`,
    cache ? `${compactNumber(cache)} cached` : "",
    g.runs > 0 ? plural(g.runs, "run") : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Build a contiguous 14-day UTC series ending on today (or the latest recorded day if ahead). */
function buildDailySeries(groups: UsageGroup[]) {
  const valid = groups.filter((g): g is UsageGroup & { key: string } => typeof g.key === "string" && DAY_KEY_RE.test(g.key));
  if (!valid.length) return null;
  const byKey = new Map(valid.map(g => [g.key, g]));
  const todayKey = new Date().toISOString().slice(0, 10);
  const latestKey = valid.map(g => g.key).sort().at(-1)!;
  const endKey = latestKey > todayKey ? latestKey : todayKey;
  const [ey, em, ed] = endKey.split("-").map(Number) as [number, number, number];
  const endUtc = Date.UTC(ey, em - 1, ed);
  const days = Array.from({ length: ACTIVITY_DAYS }, (_, i) => {
    const key = new Date(endUtc - (ACTIVITY_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const hit = byKey.get(key);
    return {
      key,
      label: key === todayKey ? "Today" : shortDayLabel(key),
      totalTokens: hit?.totalTokens ?? 0,
      runs: hit?.runs ?? 0,
    };
  });
  const maxTokens = Math.max(...days.map(d => d.totalTokens), 0);
  const totalTokens = days.reduce((sum, d) => sum + d.totalTokens, 0);
  const totalRuns = days.reduce((sum, d) => sum + d.runs, 0);
  return { days, maxTokens, totalTokens, totalRuns };
}

/** Live remaining limits for signed-in subscription plans (omitted for API keys and local models). */
function SubscriptionLimits() {
  const hosts = useHostsStore(s => s.hosts);
  const customOpenaiModels = useHostsStore(s => s.customOpenaiModels);
  const customClaudeModels = useHostsStore(s => s.customClaudeModels);
  const customGeminiModels = useHostsStore(s => s.customGeminiModels);
  const refreshingQuota = useHostsStore(s => s.refreshingQuota);
  const refreshQuota = useHostsStore(s => s.refreshQuota);

  const subscriptionAgents = useMemo(
    () => onlineAgents(hosts, customOpenaiModels, customClaudeModels, customGeminiModels).filter(isSubscriptionProvider),
    [hosts, customOpenaiModels, customClaudeModels, customGeminiModels],
  );
  const quotaProviders = useMemo(
    () => subscriptionAgents.filter((a): a is QuotaAgent => Boolean(a.quota)),
    [subscriptionAgents],
  );

  const checkedQuotaRef = useRef(false);

  // Quietly check stale subscription quota once per mount, after subscription agents load.
  useEffect(() => {
    if (checkedQuotaRef.current || !subscriptionAgents.length) return;
    checkedQuotaRef.current = true;
    const stale = subscriptionAgents.some(a => {
      if (!a.quota) return true;
      const ms = Date.parse(a.quota.fetchedAt);
      return !Number.isFinite(ms) || Date.now() - ms > QUOTA_STALE_MS;
    });
    if (stale) void refreshQuota({ force: false });
  }, [subscriptionAgents, refreshQuota]);

  if (!quotaProviders.length) return null;

  const latestFetchedAt = quotaProviders
    .map(a => a.quota.fetchedAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  return (
    <section className="card usage-card" aria-label="Subscription limits">
      <div className="usage-band">
        <div className="usage-head">
          <div className="usage-head-title">
            <h3>Plan limits</h3>
            {latestFetchedAt && <span className="usage-head-meta">Updated {formatRelativeAge(latestFetchedAt)}</span>}
          </div>
          <button
            type="button"
            className="btn-quiet usage-refresh"
            disabled={refreshingQuota}
            onClick={() => void refreshQuota({ force: true })}
          >
            <span className={refreshingQuota ? "inline-flex animate-spin" : "inline-flex"}>
              <Icon name="refresh" size={13} />
            </span>
            <span>{refreshingQuota ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>

        <div className="usage-quota-grid">
          {quotaProviders.map(agent => {
            const minPct = minRemainingPercent(agent.quota);
            const isLow = minPct !== undefined && minPct < LOW_QUOTA_THRESHOLD;
            const planBadge = agent.quota.plan ?? agent.plan;
            return (
              <div key={agent.id} className="usage-quota-tile" data-low={isLow ? "true" : "false"}>
                <div className="usage-quota-tile-head">
                  <div className="usage-quota-provider">
                    <ProviderIcon id={agent.id} size={15} />
                    <span className="truncate text-[13px] font-medium text-fg">{providerShortName(agent.id)}</span>
                    {planBadge && <span className="usage-pill">{planBadge}</span>}
                  </div>
                  {isLow && <span className="text-[11px] font-medium text-warn">Low</span>}
                </div>

                {agent.quota.buckets.length > 0 ? (
                  <div className="usage-quota-buckets">
                    {agent.quota.buckets.map(bucket => {
                      const bucketLow = bucket.remainingPercent < LOW_QUOTA_THRESHOLD;
                      const countdown = formatResetCountdown(bucket.resetsAt);
                      return (
                        <div key={bucket.id}>
                          <div className="usage-quota-bucket-row">
                            <span className="truncate text-muted">{bucket.label}</span>
                            <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                              <span className={`font-medium ${bucketLow ? "text-warn" : "text-fg"}`}>
                                {formatPercent(bucket.remainingPercent)}
                              </span>
                              {countdown && (
                                <span className="text-dim" title={`Resets in ${countdown}`}>
                                  · {countdown}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="usage-meter" aria-hidden="true">
                            <div
                              className={`usage-meter-fill ${bucketLow ? "is-warn" : ""}`}
                              style={{ width: `${Math.max(2, Math.min(100, bucket.remainingPercent))}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : agent.quota.unlimited ? (
                  <p className="mt-2.5 text-[12px] text-muted">Unlimited credits</p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Tokens the models reported using, across every project on this computer. */
export function UsageSettings() {
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<BreakdownTab>("project");
  const [expanded, setExpanded] = useState<Partial<Record<BreakdownTab, boolean>>>({});
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);

  const hosts = useHostsStore(s => s.hosts);
  const showRunTokens = useUiStore(s => s.showRunTokens);
  const setShowRunTokens = useUiStore(s => s.setShowRunTokens);

  // Map model IDs to friendly display labels and owning providers from known hosts.
  const modelCatalog = useMemo(() => {
    const labels = new Map<string, string>();
    const owners = new Map<string, AgentId>();
    for (const h of hosts) {
      for (const a of h.agents) {
        for (const [id, label] of Object.entries(a.modelLabels ?? {})) {
          if (id && label && !labels.has(id)) labels.set(id, label);
        }
        for (const id of a.models ?? []) {
          if (id && !owners.has(id)) owners.set(id, a.id);
        }
      }
    }
    return { labels, owners };
  }, [hosts]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [byProject, byAgent, byModel, byDay, projects, trash] = await Promise.all([
        api.usage("project"),
        api.usage("agent"),
        api.usage("model"),
        api.usage("day").catch(() => null),
        api.projects().catch(() => ({ projects: [] })),
        api.trash().catch(() => ({ projects: [] })),
      ]);
      const projectMap = new Map<string, ProjectMeta>();
      for (const p of trash.projects) projectMap.set(p.id, { name: p.name, trashed: true });
      for (const p of projects.projects) projectMap.set(p.id, { name: p.name, trashed: false });
      setUsage({ byProject, byAgent, byModel, byDay, projects: projectMap });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  const total = usage?.byProject.total;
  const heroLabel = total ? tokenLabel(total.totalTokens) : "";
  const [heroCount, heroUnit] = heroLabel ? heroLabel.split(" ") : ["—", ""];
  const since = total ? sinceDateLabel(total.firstAt) : "";

  const mixSegments = useMemo(() => {
    if (!total || !total.totalTokens) return [];
    const items = [
      { id: "input", label: "Input", value: total.inputTokens, alwaysShow: true, tone: "is-input" },
      { id: "output", label: "Output", value: total.outputTokens, alwaysShow: true, tone: "is-output" },
      { id: "cacheWrite", label: "Cache write", value: total.cacheWriteTokens, alwaysShow: false, tone: "is-cache-write" },
      { id: "cacheRead", label: "Cache read", value: total.cacheReadTokens, alwaysShow: false, tone: "is-cache-read" },
    ];
    return items.filter(item => item.alwaysShow || item.value > 0);
  }, [total]);

  const daily = useMemo(
    () => (usage?.byDay && total?.totalTokens ? buildDailySeries(usage.byDay.groups) : null),
    [usage?.byDay, total?.totalTokens],
  );
  const activeDay = daily && hoveredDay ? daily.days.find(d => d.key === hoveredDay) ?? null : null;

  const tabs: { id: BreakdownTab; label: string; title: string; empty: string; groups: UsageGroup[] }[] = usage
    ? [
        { id: "project", label: "Projects", title: "By project", empty: "No projects have used tokens yet.", groups: usage.byProject.groups },
        { id: "agent", label: "Providers", title: "By provider", empty: "No providers have used tokens yet.", groups: usage.byAgent.groups },
        { id: "model", label: "Models", title: "By model", empty: "No models have used tokens yet.", groups: usage.byModel.groups },
      ]
    : [];

  const activeTab = tabs.find(t => t.id === tab) ?? tabs[0];
  const sortedRows = useMemo(() => {
    if (!activeTab) return [];
    return [...activeTab.groups].sort((a, b) =>
      b.totalTokens - a.totalTokens || (Date.parse(b.lastAt ?? "") || 0) - (Date.parse(a.lastAt ?? "") || 0),
    );
  }, [activeTab]);

  const isExpanded = Boolean(expanded[tab]);
  const visibleRows = isExpanded ? sortedRows : sortedRows.slice(0, INITIAL_ROWS);
  const hiddenCount = Math.max(0, sortedRows.length - visibleRows.length);
  const grandTotal = total?.totalTokens || sortedRows.reduce((sum, g) => sum + g.totalTokens, 0);

  const hasBreakdown = Boolean(
    usage && (
      (total?.runs ?? 0) > 0 ||
      usage.byProject.groups.length > 0 ||
      usage.byAgent.groups.length > 0 ||
      usage.byModel.groups.length > 0
    ),
  );

  return (
    <div className="usage-stack">
      <SubscriptionLimits />

      <section className="card usage-card" aria-label="Token usage">
        <div className="usage-band">
          <div className="usage-head">
            <h3>Tokens</h3>
            <button type="button" className="btn-quiet usage-refresh" disabled={loading} onClick={() => void refresh()}>
              <span className={loading ? "inline-flex animate-spin" : "inline-flex"}>
                <Icon name="refresh" size={13} />
              </span>
              <span>{loading ? "Loading…" : "Refresh"}</span>
            </button>
          </div>

          <div className={`usage-hero ${daily ? "has-chart" : ""}`}>
            <div className="usage-hero-main">
              <div className="usage-figure" title={total ? `${total.totalTokens.toLocaleString()} tokens` : undefined}>
                <span>{heroCount}</span>
                {heroUnit && <span className="usage-figure-unit"> {heroUnit}</span>}
              </div>

              {total ? (
                <p className="usage-meta">
                  {total.runs
                    ? `${total.runs === 1 ? "1 run" : `${total.runs.toLocaleString()} runs`}${since ? ` since ${since}` : ""}`
                    : "No runs have reported tokens yet."}
                </p>
              ) : loading ? (
                <p className="usage-meta">Reading token history…</p>
              ) : null}

              {mixSegments.length > 0 && total && (
                <div className="usage-mix">
                  <div className="usage-mix-bar" aria-hidden="true">
                    {mixSegments
                      .filter(seg => seg.value > 0)
                      .map(seg => (
                        <span
                          key={seg.id}
                          className={`usage-mix-seg ${seg.tone}`}
                          style={{ flexGrow: seg.value }}
                          title={`${seg.label}: ${seg.value.toLocaleString()} tokens (${shareLabel(seg.value, total.totalTokens)})`}
                        />
                      ))}
                  </div>
                  <div className="usage-mix-legend">
                    {mixSegments.map(seg => {
                      const extra = seg.id === "output" && total.reasoningTokens > 0
                        ? ` (${total.reasoningTokens.toLocaleString()} reasoning)`
                        : "";
                      return (
                        <span
                          key={seg.id}
                          className="usage-legend-item"
                          title={`${seg.label}: ${seg.value.toLocaleString()} tokens${extra}`}
                        >
                          <span className={`usage-legend-dot ${seg.tone}`} aria-hidden="true" />
                          <span className="text-muted">{seg.label}</span>
                          <span className="font-medium text-fg tabular-nums">{compactNumber(seg.value)}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {daily && (
              <div className="usage-activity" aria-label="Daily token activity">
                <div className="usage-activity-head">
                  <span className={activeDay ? "font-medium text-fg" : "text-muted"}>
                    {activeDay ? activeDay.label : "Last 14 days"}
                  </span>
                  <span className="tabular-nums text-dim">
                    {activeDay
                      ? activeDay.totalTokens
                        ? `${tokenLabel(activeDay.totalTokens)} · ${plural(activeDay.runs, "run")}`
                        : "No activity"
                      : daily.totalRuns
                        ? `${tokenLabel(daily.totalTokens)} · ${plural(daily.totalRuns, "run")}`
                        : "No recent activity"}
                  </span>
                </div>

                <div className="usage-bars" onMouseLeave={() => setHoveredDay(null)}>
                  {daily.days.map(day => {
                    const heightPct = day.totalTokens && daily.maxTokens
                      ? Math.max(8, Math.round((day.totalTokens / daily.maxTokens) * 100))
                      : 0;
                    const active = hoveredDay === day.key;
                    return (
                      <button
                        key={day.key}
                        type="button"
                        className="usage-bar-col"
                        data-active={active || undefined}
                        aria-label={`${day.label}: ${day.totalTokens ? `${tokenLabel(day.totalTokens)}, ${plural(day.runs, "run")}` : "No activity"}`}
                        onMouseEnter={() => setHoveredDay(day.key)}
                        onFocus={() => setHoveredDay(day.key)}
                        onBlur={() => setHoveredDay(curr => (curr === day.key ? null : curr))}
                      >
                        <span
                          className={`usage-bar-fill ${day.totalTokens ? "" : "is-empty"}`}
                          style={heightPct ? { height: `${heightPct}%` } : undefined}
                        />
                      </button>
                    );
                  })}
                </div>

                <div className="usage-activity-axis" aria-hidden="true">
                  <span>{daily.days[0]?.label}</span>
                  <span>{daily.days.at(-1)?.label}</span>
                </div>
              </div>
            )}
          </div>

          {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
        </div>

        {hasBreakdown && usage && activeTab && (
          <div className="usage-band">
            <div className="usage-breakdown-head">
              <div className="control-tabs" role="tablist" aria-label="Token breakdown">
                {tabs.map((t, idx) => {
                  const selected = t.id === activeTab.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setTab(t.id)}
                      onKeyDown={e => {
                        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                        e.preventDefault();
                        const next = tabs[(idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
                        setTab(next.id);
                        (e.currentTarget.parentElement?.children[(idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length] as HTMLElement | undefined)?.focus();
                      }}
                      className={`usage-tab ${selected ? "is-active" : ""}`}
                    >
                      <span>{t.label}</span>
                      {t.groups.length > 0 && <span className="usage-tab-count">{t.groups.length}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            <div role="tabpanel" aria-label={activeTab.title} className="usage-list">
              {!sortedRows.length ? (
                <p className="usage-empty">{activeTab.empty}</p>
              ) : (
                <>
                  {visibleRows.map(g => {
                    const share = grandTotal > 0 ? g.totalTokens / grandTotal : 0;
                    const barPct = share > 0 ? Math.max(1.5, Math.min(100, share * 100)) : 0;
                    const lastUsed = relTime(g.lastAt ?? undefined);

                    let primary = "";
                    let secondaryCode = "";
                    let tag = "";
                    let mutedTitle = false;
                    let providerIconId: AgentId | null = null;

                    if (activeTab.id === "project") {
                      const meta = g.key ? usage.projects.get(g.key) : undefined;
                      primary = meta?.name || "Deleted project";
                      mutedTitle = !meta;
                      if (meta?.trashed) tag = "Trash";
                    } else if (activeTab.id === "agent") {
                      primary = (g.key && AGENT_LABEL[g.key as AgentId]) || g.key || "Unknown provider";
                      if (g.key && KNOWN_PROVIDERS.has(g.key)) providerIconId = g.key as AgentId;
                    } else {
                      if (!g.key) {
                        primary = "Default model";
                      } else {
                        const friendly = modelCatalog.labels.get(g.key) ?? formatModelId(g.key);
                        primary = friendly;
                        if (friendly !== g.key) secondaryCode = g.key;
                        providerIconId = inferProviderFromModel(g.key) ?? modelCatalog.owners.get(g.key) ?? null;
                      }
                    }

                    return (
                      <div key={g.key ?? ""} className="usage-row">
                        <div className="usage-row-top">
                          {activeTab.id !== "project" && (
                            <span className="usage-row-icon" aria-hidden="true">
                              {providerIconId ? <ProviderIcon id={providerIconId} size={14} /> : <Icon name="stack" size={13} />}
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="usage-row-title">
                              <span className={`truncate font-medium ${mutedTitle ? "text-muted" : "text-fg"}`}>{primary}</span>
                              {tag && <span className="usage-pill">{tag}</span>}
                              {secondaryCode && <span className="usage-row-code">{secondaryCode}</span>}
                            </div>
                            <div className="usage-row-sub" title={tokenBreakdown(g)}>
                              {compactBreakdown(g)}
                            </div>
                          </div>
                          <div className="usage-row-right">
                            <div className="text-[13px] font-medium text-fg tabular-nums" title={`${g.totalTokens.toLocaleString()} tokens`}>
                              {tokenLabel(g.totalTokens)}
                            </div>
                            <div className="text-[11px] text-dim tabular-nums">
                              {shareLabel(g.totalTokens, grandTotal)}
                              {lastUsed ? ` · ${lastUsed}` : ""}
                            </div>
                          </div>
                        </div>
                        <div className="usage-row-bar" aria-hidden="true">
                          <span className="usage-row-bar-fill" style={{ width: `${barPct}%` }} />
                        </div>
                      </div>
                    );
                  })}

                  {(hiddenCount > 0 || isExpanded) && sortedRows.length > INITIAL_ROWS && (
                    <button
                      type="button"
                      className="usage-expand-btn"
                      onClick={() => setExpanded(prev => ({ ...prev, [tab]: !prev[tab] }))}
                    >
                      {isExpanded ? "Show fewer" : `Show all ${sortedRows.length}`}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div className="usage-band usage-footer" aria-label="Token counts in edits">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-fg">Show tokens in the chat</div>
              <p className="mt-0.5 text-[12px] text-muted">Display token counts beside active requests and on hover.</p>
            </div>
            <Toggle checked={showRunTokens} onChange={setShowRunTokens} label="Show tokens in the chat" />
          </div>
        </div>
      </section>
    </div>
  );
}
