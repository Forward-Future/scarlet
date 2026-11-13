import { useEffect, useState } from "react";
import type { AgentId, UsageGroup, UsageResponse } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { tokenBreakdown, tokenLabel } from "../../lib/format";
import { AGENT_LABEL } from "../../stores/hosts";
import { useUiStore } from "../../stores/ui";
import { InlineError, SectionTitle, Toggle } from "../ui/primitives";

interface Usage {
  byProject: UsageResponse;
  byAgent: UsageResponse;
  byModel: UsageResponse;
  names: Map<string, string>;
}

function UsageRows({ title, groups, label, empty }: { title: string; groups: UsageGroup[]; label(key: string | null): string; empty: string }) {
  return <section className="card p-5 space-y-3" aria-label={title}>
    <SectionTitle>{title}</SectionTitle>
    {!groups.length && <p className="text-sm text-muted">{empty}</p>}
    {groups.map(g => <div key={g.key ?? ""} className="flex items-center gap-3 border-t border-line py-2">
      <div className="min-w-0 flex-1"><div className="break-words text-sm font-medium">{label(g.key)}</div>
        <span className="text-xs text-muted">{tokenBreakdown(g)}</span></div>
      <span className="text-sm tabular-nums" title={`${g.totalTokens.toLocaleString()} tokens`}>{tokenLabel(g.totalTokens)}</span>
    </div>)}
  </section>;
}

/** Tokens the models reported using, across every project on this computer. */
export function UsageSettings() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const showRunTokens = useUiStore(s => s.showRunTokens);
  const setShowRunTokens = useUiStore(s => s.setShowRunTokens);

  async function refresh() {
    setLoading(true); setError("");
    try {
      const [byProject, byAgent, byModel, projects, trash] = await Promise.all([
        api.usage("project"), api.usage("agent"), api.usage("model"),
        api.projects().catch(() => ({ projects: [] })), api.trash().catch(() => ({ projects: [] })),
      ]);
      const names = new Map<string, string>([...trash.projects, ...projects.projects].map(p => [p.id, p.name]));
      setUsage({ byProject, byAgent, byModel, names });
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  const total = usage?.byProject.total;
  return <div className="space-y-4">
    <section className="card p-5" aria-label="Token usage">
      <div className="flex items-center justify-between gap-3"><SectionTitle>Tokens</SectionTitle>
        <button className="btn-quiet" disabled={loading} onClick={() => void refresh()}>{loading ? "Loading…" : "Refresh"}</button></div>
      <div className="text-3xl font-semibold tabular-nums" title={total ? `${total.totalTokens.toLocaleString()} tokens` : undefined}>
        {total ? tokenLabel(total.totalTokens) : "—"}</div>
      {/* The runs are counted once, in the sentence: the breakdown would add "· 42 runs" before it. */}
      {total && <p className="text-sm text-muted">{total.runs
        ? `${tokenBreakdown({ ...total, runs: undefined })}. ${total.runs === 1 ? "1 run" : `${total.runs.toLocaleString()} runs`} since ${new Date(total.firstAt!).toLocaleDateString()}.`
        : "No runs have reported tokens yet."}</p>}
    </section>
    <section className="card p-5" aria-label="Token counts in edits">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">Show tokens in the chat</div>
        <Toggle checked={showRunTokens} onChange={setShowRunTokens} label="Show tokens in the chat" />
      </div>
    </section>
    {error && <InlineError>{error}</InlineError>}
    {usage && <>
      <UsageRows title="By project" groups={usage.byProject.groups} empty="No projects have used tokens yet."
        label={key => (key && usage.names.get(key)) || "Deleted project"} />
      <UsageRows title="By provider" groups={usage.byAgent.groups} empty="No providers have used tokens yet."
        label={key => (key && AGENT_LABEL[key as AgentId]) || key || "Unknown provider"} />
      <UsageRows title="By model" groups={usage.byModel.groups} empty="No models have used tokens yet."
        label={key => key ?? "Default model"} />
    </>}
  </div>;
}
