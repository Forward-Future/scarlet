import { useState } from "react";
import type { AgentId } from "@scarlet/shared";
import { ModelProviders } from "../agent/ModelProviders";
import { Link } from "react-router-dom";
import { errorMessage, IS_MOCK } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { AGENT_LABEL, onlineAgents, useHostsStore } from "../../stores/hosts";
import { modelChoices, useModelPreferences } from "../../stores/modelPicker";
import { FavoriteButton } from "../agent/FavoriteButton";
import { Icon, InlineError, Loading, SectionTitle, Toggle } from "../ui/primitives";

export function ModelSettings({ onSignIn }: { onSignIn?: () => void } = {}) {
  const { hosts, customOpenaiModels, customClaudeModels, status, load, error } = useHostsStore();
  const { hidden, favorites, setVisible } = useModelPreferences();
  const [provider, setProvider] = useState<AgentId>();
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshed, setRefreshed] = useState(false);
  const agents = onlineAgents(hosts, customOpenaiModels, customClaudeModels);
  const choices = modelChoices(agents);
  const query = search.trim().toLowerCase();
  const providers = agents.filter(a => choices.some(m => m.agent === a.id)).map(a => a.id);
  const active = providers.find(id => id === provider) ?? providers[0];
  const catalog = choices.filter(m => m.agent === active);
  const visible = catalog.filter(m => !hidden.includes(m.key)).length;
  const matches = catalog.filter(m => `${m.label} ${m.model ?? ""}`.toLowerCase().includes(query));

  async function refresh() {
    setRefreshed(false);
    setRefreshing(true);
    setRefreshError("");
    try {
      if (!IS_MOCK) {
        const host = await desktop.hostRefreshAgents();
        if (host.error) throw new Error(host.error);
      }
      await load();
      setRefreshed(useHostsStore.getState().status === "ready");
    } catch (e) {
      setRefreshError(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="card p-5">
      <SectionTitle right={<div className="flex items-center gap-2">
        <span role="status" className="inline-flex items-center gap-1 text-xs text-muted">
          {refreshed && !error && <><Icon name="check" /> Models refreshed</>}
        </span>
        <button className="btn-quiet" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh models"}</button></div>}>Model picker</SectionTitle>
      {(refreshError || error) && <InlineError>{refreshError || error}</InlineError>}
      {!choices.length && (status === "loading" ? <Loading label="Reading models…" /> :
        // Every model a signed-in agent offers is listed, so none at all means its list couldn't be read.
        agents.length ? <p className="mt-4 text-[13px] text-muted">Couldn’t read the model list. Refresh models to try again, and update Claude Code or Codex if it still fails.</p> :
        <p className="mt-4 text-[13px] text-muted">Models appear when Claude Code or Codex is online. {onSignIn
          ? <button className="underline" onClick={onSignIn}>Manage sign-in</button>
          : <Link to="/settings#hosts" className="underline">Manage sign-in</Link>}</p>)}
      {active && <div className="mt-4">
        <ModelProviders providers={providers} active={active} onChange={id => { setProvider(id); setSearch(""); }} />
        <div className="flex flex-wrap items-center gap-2 py-3">
          <label className="field flex min-w-32 flex-1 items-center gap-2 text-muted">
            <Icon name="search" />
            <input type="search" className="min-w-0 flex-1 bg-transparent text-fg outline-none" aria-label="Filter models" placeholder={`Filter ${AGENT_LABEL[active]} models…`} value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          <span className="text-xs text-dim">{visible} of {catalog.length} shown</span>
          <button className="btn-quiet" aria-label={`${visible ? "Hide" : "Show"} all ${AGENT_LABEL[active]} models`} onClick={() => setVisible(catalog.map(m => m.key), visible === 0)}>{visible ? "Hide all" : "Show all"}</button>
        </div>
        {!matches.length && <p className="py-4 text-[13px] text-muted">No matching models.</p>}
        <div className="max-h-[46vh] overflow-auto">
          {[true, false].map(starred => {
            const rows = matches.filter(m => favorites.includes(m.key) === starred);
            if (!rows.length) return null;
            return <section key={String(starred)}>
              <h4 className="eyebrow border-b border-line py-2">{starred ? "Favorites" : "Models"}</h4>
              <ul className="divide-y divide-line/60">{rows.map((m) => (
                <li key={m.key} className="flex items-center gap-2 py-1.5">
                  <FavoriteButton choice={m} />
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-[13px] ${hidden.includes(m.key) ? "text-dim" : "text-fg"}`}>{m.label}</div>
                    {m.model && m.model !== m.label && <div className="truncate font-mono text-[11px] text-dim">{m.model}</div>}
                  </div>
                  <Toggle checked={!hidden.includes(m.key)} label={`Show ${AGENT_LABEL[m.agent]} · ${m.label} in selector`} onChange={(v) => setVisible([m.key], v)} />
                </li>
              ))}</ul>
            </section>;
          })}
        </div>
      </div>}
    </section>
  );
}
