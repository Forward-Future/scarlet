import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentId } from "@scarlet/shared";
import { ModelProviders } from "../agent/ModelProviders";
import { Link } from "react-router-dom";
import { ModelRefreshButton, ModelRefreshFeedback, useModelRefresh } from "../agent/ModelRefresh";
import { AGENT_LABEL, onlineAgents, useHostsStore } from "../../stores/hosts";
import { isChoiceHidden, modelChoices, OPT_IN_PROVIDERS, RECOMMENDED_MODELS, useModelPreferences, type ModelChoice } from "../../stores/modelPicker";
import { FavoriteButton } from "../agent/FavoriteButton";
import { Icon, Loading, SectionTitle, Toggle } from "../ui/primitives";

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

/** Where sign-in is managed: the setup dialog's own step when there is one, otherwise Settings. */
export function ManageSignIn({ onSignIn }: { onSignIn?: () => void }) {
  return onSignIn
    ? <button className="underline" onClick={onSignIn}>Manage sign-in</button>
    : <Link to="/settings#hosts" className="underline">Manage sign-in</Link>;
}

export function ModelSettings({ onSignIn }: { onSignIn?: () => void } = {}) {
  const { hosts, customOpenaiModels, customClaudeModels, customGeminiModels, status, error } = useHostsStore();
  const prefs = useModelPreferences();
  const { favorites, setVisible } = prefs;
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
  const isHidden = (choice: ModelChoice) => isChoiceHidden(prefs, choice, choices);
  const visible = catalog.filter(m => !isHidden(m)).length;
  const matches = catalog.filter(m => `${m.label} ${m.model ?? ""}`.toLowerCase().includes(query));

  const favoriteRows = matches.filter(m => !isHidden(m) && favorites.includes(m.key));
  const activeRows = matches.filter(m => !isHidden(m) && !favorites.includes(m.key));
  const hiddenRows = matches.filter(m => isHidden(m));
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
  }, [measureScroll, active, search, matches.length, prefs.hidden, prefs.shown, favorites]);

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

  /** Scroll the list to the top `to` picks for it, then measure what is left below. */
  const scrollList = (to: (el: HTMLDivElement) => number) => {
    const el = listRef.current;
    if (!el) return;
    const top = to(el);
    if (typeof el.scrollTo === "function") el.scrollTo({ top, behavior: scrollBehavior() });
    else el.scrollTop = top;
    measureScroll();
  };

  const scrollMore = () => scrollList(el => {
    const step = Math.max(Math.round(el.clientHeight * 0.8), 160);
    return Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + step);
  });

  const scrollToTop = () => scrollList(() => 0);

  const scrollCueLabel = formatScrollCue(scrollCue.activeBelow, scrollCue.hiddenBelow, hiddenRows.length);

  return (
    <section className="card p-5">
      <SectionTitle right={<ModelRefreshButton action={refresh} />}>Model picker</SectionTitle>
      <ModelRefreshFeedback action={refresh} loadError={error} />
      {!choices.length && (status === "loading" ? <Loading label="Reading models…" /> :
        // Every model a signed-in agent offers is listed, so none at all means its list couldn't be read.
        agents.length ? <p className="mt-4 text-[13px] text-muted">Couldn’t read the model list. Refresh models to try again, and update Claude Code, Codex or Gemini if it still fails.</p> :
        <p className="mt-4 text-[13px] text-muted">Models appear when Claude Code, Codex or Gemini is online. <ManageSignIn onSignIn={onSignIn} /></p>)}
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
        {(OPT_IN_PROVIDERS.includes(active) || Boolean(RECOMMENDED_MODELS[active])) && !visible && !query && <p className="pb-3 text-[13px] text-muted">{AGENT_LABEL[active]} offers {catalog.length} models. Turn on the models you want to see in the selector.</p>}
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
