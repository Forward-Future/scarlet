import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { AGENT_LABEL, PROVIDER_DEFAULT_URL, type AgentAvailability, type ExtraProvider } from "@scarlet/shared";
import { desktop, isDesktop, type ProviderSettingsView } from "../../lib/desktop";
import { useHostsStore } from "../../stores/hosts";
import { ProviderIcon } from "../agent/ModelProviders";
import { useLocalHost } from "./AgentSignIn";
import { InlineError, SectionTitle, Toggle } from "../ui/primitives";

const ROWS: ExtraProvider[] = ["ollama", "lmstudio", "openrouter"];

/** What one provider's row says about it, from what this computer's host found. */
export function providerStatus(id: ExtraProvider, agent: AgentAvailability | undefined, claude: AgentAvailability | undefined,
  settings: ProviderSettingsView | null): string {
  const view = settings?.[id];
  if (view?.disabled) return "Off";
  if (claude && !claude.installed) return "Needs Claude Code, which runs the edit. Install it under General.";
  if (id === "openrouter" && settings && !settings.openrouter.hasKey) return "Add your OpenRouter key to use its models.";
  const customUrl = id !== "openrouter" ? settings?.[id].url : null;
  if (!agent?.installed) {
    if (id === "openrouter") return "Couldn’t reach OpenRouter.";
    if (customUrl) return `Couldn’t reach ${AGENT_LABEL[id]} at ${customUrl}.`;
    return `Not running. Start ${AGENT_LABEL[id]}${id === "lmstudio" ? "’s local server" : ""} on this computer.`;
  }
  if (agent.loggedIn === false) return "OpenRouter didn’t accept this key.";
  const n = agent.models?.length ?? 0;
  if (!n) return "Running, but none of its models can use tools, which editing needs.";
  const count = `${n} ${n === 1 ? "model" : "models"}`;
  return id === "openrouter" ? `${count}. Turn on the ones you want in Model picker above.` : `${count} ready${customUrl ? ` · ${customUrl}` : ""}`;
}

/**
 * Ollama, LM Studio and OpenRouter: models beside the three plans, set up here and nowhere else in the interface. Each
 * shows up in the model selector only once it has models ready, and Claude Code runs the edit with them. One row each:
 * what it found, a switch to leave it out, and its address or key behind a button.
 */
export function ProviderSettings() {
  const liveHost = useLocalHost();
  const [savedHost, setSavedHost] = useState<typeof liveHost>(null);
  const host = savedHost ?? liveHost;
  const [settings, setSettings] = useState<ProviderSettingsView | null>(null);
  const [editing, setEditing] = useState<ExtraProvider | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSavedHost(null), [liveHost]);
  useEffect(() => {
    if (!isDesktop()) return;
    desktop.providerSettings().then(setSettings, () => setSettings(null));
  }, []);
  if (!isDesktop()) return null;

  const agentOf = (id: string) => host?.agents.find(a => a.id === id);
  const save = async (change: Parameters<typeof desktop.saveProviderSettings>[0]) => {
    setBusy(true);
    setError(null);
    try {
      setSavedHost(await desktop.saveProviderSettings(change));
      setSettings(await desktop.providerSettings());
      setEditing(null);
      setDraft("");
      void useHostsStore.getState().load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const open = (id: ExtraProvider) => {
    setEditing(editing === id ? null : id);
    setError(null);
    setDraft(id === "openrouter" ? "" : settings?.[id].url ?? "");
  };
  const cancel = () => {
    setEditing(null);
    setError(null);
  };
  const onFormKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const submit = (id: ExtraProvider) => (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    void save(id === "openrouter" ? { provider: id, apiKey: value || null } : { provider: id, url: value || null });
  };

  return (
    <section className="card p-5" aria-labelledby="providers-heading">
      <SectionTitle><span id="providers-heading">Other providers</span></SectionTitle>
      <p className="text-[13px] text-muted mb-3">Models on this computer through Ollama or LM Studio, or hosted ones through OpenRouter. Each appears in the model selector once it’s ready.</p>
      <ul className="divide-y divide-line/60">
        {ROWS.map(id => {
          const view = settings?.[id];
          const on = !view?.disabled;
          const isKey = id === "openrouter";
          const hasKey = !!settings?.openrouter.hasKey;
          const customUrl = !isKey ? settings?.[id].url : null;
          return (
            <li key={id} className="py-2.5" data-provider={id}>
              <div className="flex items-center gap-3">
                <ProviderIcon id={id} size={16} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]">{AGENT_LABEL[id]}</div>
                  <div className="text-[12px] text-muted">{providerStatus(id, agentOf(id), agentOf("claude"), settings)}</div>
                </div>
                {on && <button type="button" className="btn-quiet text-[12px]" aria-expanded={editing === id} onClick={() => open(id)}>
                  {isKey ? (hasKey ? "Change key" : "Add key") : "Address"}
                </button>}
                <Toggle checked={on} disabled={busy || !settings} label={`Use ${AGENT_LABEL[id]}`} onChange={v => void save({ provider: id, disabled: !v })} />
              </div>
              {editing === id && (
                <form className="mt-2 flex flex-wrap items-center gap-2 pl-7" onSubmit={submit(id)} onKeyDown={onFormKeyDown}>
                  <input className="field min-w-48 flex-1 text-[13px]" autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                    type={isKey ? "password" : "text"} inputMode={isKey ? undefined : "url"} autoComplete="off" spellCheck={false}
                    aria-label={isKey ? "OpenRouter key" : `${AGENT_LABEL[id]} address`}
                    placeholder={isKey ? "sk-or-…" : PROVIDER_DEFAULT_URL[id]} />
                  <button type="submit" className="btn-quiet text-[12px]" disabled={busy || (isKey && !draft.trim())}>{busy ? "Checking…" : "Save"}</button>
                  {isKey && hasKey && !settings?.openrouter.keyFromEnv && (
                    <button type="button" className="btn-quiet text-[12px] text-muted" disabled={busy} onClick={() => void save({ provider: id, apiKey: null })}>Remove key</button>
                  )}
                  {!isKey && customUrl && (
                    <button type="button" className="btn-quiet text-[12px] text-muted" disabled={busy} onClick={() => void save({ provider: id, url: null })}>Use default</button>
                  )}
                  <button type="button" className="btn-quiet text-[12px] text-muted" disabled={busy} onClick={cancel}>Cancel</button>
                  {isKey && settings?.openrouter.keyFromEnv && <p className="w-full text-[12px] text-dim">Using OPENROUTER_API_KEY from your environment until you save one here.</p>}
                  {!isKey && <p className="w-full text-[12px] text-dim">Leave empty for {PROVIDER_DEFAULT_URL[id]}.</p>}
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}
