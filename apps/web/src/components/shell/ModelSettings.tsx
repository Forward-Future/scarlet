import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chooseListener, hearingModels, listenerKey, type AgentId, type Listener } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { PreferenceSelect } from "../ui/PreferenceSelect";
import { ModelProviders } from "../agent/ModelProviders";
import { Link } from "react-router-dom";
import { ModelRefreshButton, ModelRefreshFeedback, useModelRefresh } from "../agent/ModelRefresh";
import { AGENT_LABEL, onlineAgents, useHostsStore } from "../../stores/hosts";
import { modelChoices, useModelPreferences, type ModelChoice } from "../../stores/modelPicker";
import { FavoriteButton } from "../agent/FavoriteButton";
import { Icon, InlineError, Loading, SectionTitle, Toggle } from "../ui/primitives";

interface ScrollCue {
  canScrollUp: boolean;
  canScrollDown: boolean;
  activeBelow: number;
  hiddenBelow: number;
}

const EMPTY_SCROLL_CUE: ScrollCue = {
  canScrollUp: false,
  canScrollDown: false,
  activeBelow: 0,
  hiddenBelow: 0,
};

function formatScrollCue(activeBelow: number, hiddenBelow: number, totalHidden: number): string {
  const totalBelow = activeBelow + hiddenBelow;
  if (totalBelow > 0) {
    if (activeBelow > 0 && hiddenBelow > 0) {
      return `${totalBelow} more ${totalBelow === 1 ? "model" : "models"} below · ${hiddenBelow} hidden`;
    }
    if (hiddenBelow > 0) {
      const someHiddenVisible = hiddenBelow < totalHidden;
      return `${hiddenBelow}${someHiddenVisible ? " more" : ""} hidden ${hiddenBelow === 1 ? "model" : "models"} below`;
    }
    return `${activeBelow} more ${activeBelow === 1 ? "model" : "models"} below`;
  }
  if (totalHidden > 0) {
    return `${totalHidden} hidden ${totalHidden === 1 ? "model" : "models"} below`;
  }
  return "More models below";
}

export function ModelSettings({ onSignIn }: { onSignIn?: () => void } = {}) {
  const { hosts, customOpenaiModels, customClaudeModels, customGeminiModels, status, error } = useHostsStore();
  const { hidden, favorites, setVisible } = useModelPreferences();
  const [provider, setProvider] = useState<AgentId>();
  const [search, setSearch] = useState("");
  const [scrollCue, setScrollCue] = useState<ScrollCue>(EMPTY_SCROLL_CUE);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const refresh = useModelRefresh();
  const agents = onlineAgents(hosts, customOpenaiModels, customClaudeModels, customGeminiModels);
  const choices = modelChoices(agents);
  const query = search.trim().toLowerCase();
  const providers = agents.filter(a => choices.some(m => m.agent === a.id)).map(a => a.id);
  const active = providers.find(id => id === provider) ?? providers[0];
  const catalog = choices.filter(m => m.agent === active);
  const visible = catalog.filter(m => !hidden.includes(m.key)).length;
  const matches = catalog.filter(m => `${m.label} ${m.model ?? ""}`.toLowerCase().includes(query));

  const favoriteRows = matches.filter(m => !hidden.includes(m.key) && favorites.includes(m.key));
  const activeRows = matches.filter(m => !hidden.includes(m.key) && !favorites.includes(m.key));
  const hiddenRows = matches.filter(m => hidden.includes(m.key));
  const sections: { id: "favorites" | "models" | "hidden"; label: string; count?: number; rows: ModelChoice[] }[] = [
    { id: "favorites" as const, label: "Favorites", rows: favoriteRows },
    { id: "models" as const, label: "Models", rows: activeRows },
    { id: "hidden" as const, label: "Hidden", count: hiddenRows.length, rows: hiddenRows },
  ].filter(section => section.rows.length > 0);

  const measureScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) {
      setScrollCue(prev => (prev === EMPTY_SCROLL_CUE ? prev : EMPTY_SCROLL_CUE));
      return;
    }
    const canScrollUp = el.scrollTop > 2;
    const canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    let activeBelow = 0;
    let hiddenBelow = 0;
    if (canScrollDown) {
      const box = el.getBoundingClientRect();
      if (box.height > 0) {
        for (const row of el.querySelectorAll<HTMLLIElement>("li[data-model-state]")) {
          const rect = row.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom > box.bottom + 4) {
            if (row.dataset.modelState === "hidden") hiddenBelow++;
            else activeBelow++;
          }
        }
      }
    }
    setScrollCue(prev =>
      prev.canScrollUp === canScrollUp &&
      prev.canScrollDown === canScrollDown &&
      prev.activeBelow === activeBelow &&
      prev.hiddenBelow === hiddenBelow
        ? prev
        : { canScrollUp, canScrollDown, activeBelow, hiddenBelow },
    );
  }, []);

  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [active]);

  useLayoutEffect(() => {
    measureScroll();
  }, [measureScroll, active, search, matches.length, hidden, favorites]);

  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list) return;
    window.addEventListener("resize", measureScroll);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measureScroll) : null;
    observer?.observe(list);
    if (content) observer?.observe(content);
    return () => {
      window.removeEventListener("resize", measureScroll);
      observer?.disconnect();
    };
  }, [measureScroll, active, matches.length]);

  const scrollBehavior = (): ScrollBehavior =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

  const scrollMore = () => {
    const el = listRef.current;
    if (!el) return;
    const step = Math.max(Math.round(el.clientHeight * 0.8), 160);
    const nextTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + step);
    if (typeof el.scrollTo === "function") el.scrollTo({ top: nextTop, behavior: scrollBehavior() });
    else el.scrollTop = nextTop;
    measureScroll();
  };

  const scrollToTop = () => {
    const el = listRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: 0, behavior: scrollBehavior() });
    else el.scrollTop = 0;
    measureScroll();
  };

  const scrollCueLabel = formatScrollCue(scrollCue.activeBelow, scrollCue.hiddenBelow, hiddenRows.length);

  return (
    <section className="card p-5">
      <SectionTitle right={<ModelRefreshButton action={refresh} />}>Model picker</SectionTitle>
      <ModelRefreshFeedback action={refresh} loadError={error} />
      {!choices.length && (status === "loading" ? <Loading label="Reading models…" /> :
        // Every model a signed-in agent offers is listed, so none at all means its list couldn't be read.
        agents.length ? <p className="mt-4 text-[13px] text-muted">Couldn’t read the model list. Refresh models to try again, and update Claude Code, Codex or Gemini if it still fails.</p> :
        <p className="mt-4 text-[13px] text-muted">Models appear when Claude Code, Codex or Gemini is online. {onSignIn
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
        {matches.length > 0 && <>
          <div className="relative">
            <div
              ref={listRef}
              onScroll={measureScroll}
              className="model-list-scroll max-h-[46vh] overflow-y-auto pr-2"
            >
              <div ref={contentRef}>
                {sections.map((section, index) => (
                  <section key={section.id} className={index > 0 ? "mt-2" : undefined}>
                    <h4 className="eyebrow flex items-center gap-1.5 border-b border-line py-2">
                      <span>{section.label}</span>
                      {section.count != null && <span className="tnum">· {section.count}</span>}
                    </h4>
                    <ul className="divide-y divide-line/60">
                      {section.rows.map((m) => {
                        const isHidden = section.id === "hidden";
                        return (
                          <li key={m.key} data-model-state={isHidden ? "hidden" : "active"} className="flex items-center gap-2 py-1">
                            <FavoriteButton choice={m} />
                            <div className="flex min-w-0 flex-1 items-baseline gap-2">
                              <span className={`truncate text-[13px] ${isHidden ? "text-dim" : "text-fg"}`}>{m.label}</span>
                              {m.model && m.model !== m.label && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">{m.model}</span>}
                            </div>
                            <Toggle checked={!isHidden} label={`Show ${AGENT_LABEL[m.agent]} · ${m.label} in selector`} onChange={(v) => setVisible([m.key], v)} />
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
            {scrollCue.canScrollUp && (
              <div aria-hidden className="pointer-events-none absolute left-0 right-2 top-0 h-5 bg-gradient-to-b from-panel to-transparent" />
            )}
            {scrollCue.canScrollDown && (
              <div aria-hidden className="pointer-events-none absolute left-0 right-2 bottom-0 h-8 bg-gradient-to-t from-panel via-panel/80 to-transparent" />
            )}
          </div>
          {(scrollCue.canScrollDown || scrollCue.canScrollUp) && (
            <div className="mt-1 border-t border-line/70 pt-2">
              <button
                type="button"
                onClick={scrollCue.canScrollDown ? scrollMore : scrollToTop}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-bg/50 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-raised hover:text-fg"
              >
                <span className={scrollCue.canScrollDown ? "inline-flex" : "inline-flex rotate-180"}>
                  <Icon name="down" size={12} />
                </span>
                <span>{scrollCue.canScrollDown ? scrollCueLabel : "Back to top"}</span>
              </button>
            </div>
          )}
        </>}
      </div>}
    </section>
  );
}

/**
 * Which model listens to cuts for the models that can't hear (Claude, most of Codex's): Automatic, the best one signed
 * in; one the editor picks; or Off. Saved for every project, as Checking with you is.
 */
export function ListeningSettings({ onSignIn }: { onSignIn?: () => void } = {}) {
  const { hosts, status } = useHostsStore();
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api.settings().then(r => { if (current) setValue(r.settings.listening); }).catch(e => { if (current) setError(errorMessage(e)); });
    return () => { current = false; };
  }, []);
  if (!value) return error ? <InlineError>{error}</InlineError> : null;
  const agents = hosts.filter(h => h.online).flatMap(h => h.agents);
  const nameOf = (l: Listener) => l.agent === "gemini" && !l.model ? "Gemini"
    : agents.find(a => a.id === l.agent)?.modelLabels?.[l.model ?? ""] ?? l.model ?? AGENT_LABEL[l.agent as AgentId];
  const models = hearingModels(agents);
  const picked = value !== "auto" && value !== "off" ? value : undefined;
  const missing = picked && !models.some(l => listenerKey(l) === picked);
  const pickedName = picked && (missing ? picked.split(":").slice(1).join(":") : nameOf(models.find(l => listenerKey(l) === picked)!));
  const options = [
    { value: "auto", label: "Automatic" },
    ...models.map(l => ({ value: listenerKey(l) as string, label: nameOf(l) })),
    ...(missing ? [{ value: picked, label: `${pickedName} (not signed in)` }] : []),
    { value: "off", label: "Off" },
  ];
  const listener = chooseListener(agents, value);
  const choose = async (next: string) => {
    const previous = value;
    setValue(next);
    setError("");
    setBusy(true);
    try {
      setValue((await api.updateSettings({ listening: next })).settings.listening);
    } catch (e) {
      setValue(previous);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const signIn = onSignIn
    ? <button className="underline" onClick={onSignIn}>Manage sign-in</button>
    : <Link to="/settings#hosts" className="underline">Manage sign-in</Link>;
  const catches = "so Scarlet catches a stumble or a clipped word the transcript misses.";
  return (
    <section className="card transcription-preferences check-in-preferences" aria-labelledby="listening-heading">
      <div className="transcription-header">
        <div className="transcription-heading">
          <span className="transcription-glyph"><Icon name="audio" size={22} /></span>
          <div>
            <h2 id="listening-heading">Listening</h2>
            <p>Which model listens to cuts for models that can’t hear.</p>
          </div>
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor="listening-model">Listening model</label>
          <PreferenceSelect id="listening-model" value={value} disabled={busy} options={options} onChange={next => void choose(next)}
            valueLabel={value === "auto" && listener ? `Automatic · ${nameOf(listener)}` : undefined} />
        </div>
      </div>
      {/* One span: the status line lays its children out side by side, and this is one sentence. */}
      <p className="transcription-status text-muted"><span>{
        value === "off" ? "Off: models that can’t hear read the transcript and a picture of the sound instead."
        : missing ? <>{pickedName} isn’t signed in, so nothing listens for now. Sign in again or choose another model. {signIn}</>
        : listener ? <>{nameOf(listener)} listens to cuts for models that can’t hear, {catches}</>
        : status === "loading" ? "Looking for models that can hear…"
        : <>No model here can hear. Sign in to Gemini so Scarlet listens to cuts instead of only reading the transcript. {signIn}</>
      }</span></p>
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
}
