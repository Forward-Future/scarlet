import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentId } from "@scarlet/shared";
import { AGENT_LABEL, type OnlineAgent } from "../../stores/hosts";
import { useModelPreferences, type ModelChoice } from "../../stores/modelPicker";
import { Icon } from "../ui/primitives";
import { ProviderIcon, type ModelScope } from "./ModelProviders";
import { ModelRow, ModelScopeBar, ModelSearch, scopeModels } from "./ModelSelectorParts";
import { moveSelectorFocus, placeModelSelector } from "./modelSelectorLayout";

/** "same", or a model as "agent:model". */
export type TaskModelValue = string;

/**
 * The model selector the chat's model button opens, for choosing which model does a kind of work in Task models: the
 * same providers, search, rows and stars, with "Same as chat" first. Effort and speed stay the chat's.
 */
export function TaskModelPicker({ id, label, value, choices, agents, missing, onChange }: {
  id: string;
  /** The field's name for screen readers, such as "Model for Motion graphics". */
  label: string;
  value: TaskModelValue;
  /** The models signed in now that the editor shows in the selector. */
  choices: ModelChoice[];
  agents: OnlineAgent[];
  /** The model saved for this work when it isn't signed in now: it stays chosen and says so. */
  missing?: { agent: string; model?: string; name: string };
  onChange(value: TaskModelValue): void;
}) {
  const favorites = useModelPreferences((s) => s.favorites);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [scope, setScope] = useState<ModelScope>();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const chosen = choices.find((m) => m.key === value);
  const providers = agents.filter(a => choices.some(m => m.agent === a.id)).map(a => a.id);
  const active: ModelScope = scope === "all" || scope === "favorites" ? scope : providers.find(p => p === scope) ?? providers[0] ?? "all";
  const { query, favRows, otherRows, scoped, multiProvider } = scopeModels(choices, favorites, search, active);
  const shown = value === "same" ? "Same as chat" : chosen?.label ?? (missing ? `${missing.name} (not signed in)` : value);
  const shownAgent = value === "same" ? undefined : (chosen?.agent ?? missing?.agent) as AgentId | undefined;

  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const menu = panel.current, anchor = trigger.current;
    const place = () => placeModelSelector(menu, anchor, "down", false);
    place();
    (searchField.current ?? menu).focus();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  useEffect(() => { if (open && searchOpen) searchField.current?.focus(); }, [open, searchOpen]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    // Esc closes the search first, then the selector, and nothing behind it: Settings stays open.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (searchOpen) { setSearch(""); setSearchOpen(false); panel.current?.focus(); }
      else { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", onMouseDown); window.removeEventListener("keydown", esc, true); };
  }, [open, searchOpen]);

  const pick = (next: TaskModelValue) => {
    setOpen(false);
    trigger.current?.focus();
    if (next !== value) onChange(next);
  };
  const row = (m: ModelChoice) => <ModelRow key={m.key} choice={m} selected={m.key === value} multiProvider={multiProvider} onPick={() => pick(m.key)} />;
  // "Same as chat" leads every list but a search's, and a saved model that isn't signed in follows it.
  const lead = !query;

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        id={id}
        type="button"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        title={shownAgent ? `${AGENT_LABEL[shownAgent] ?? shownAgent} · ${shown}` : shown}
        onClick={() => {
          if (!open) { setScope(chosen?.agent ?? "all"); setSearch(""); setSearchOpen(false); }
          setOpen(!open);
        }}
        className={`task-model-trigger inline-flex w-full min-w-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] hover:border-dim hover:text-fg aria-expanded:bg-raised aria-expanded:text-fg ${value === "same" ? "text-muted" : "text-fg"}`}
      >
        {shownAgent && <span className="shrink-0 opacity-85"><ProviderIcon id={shownAgent} size={12} /></span>}
        <span className="min-w-0 flex-1 truncate text-left">{shown}</span>
        <Icon name="down" size={11} />
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Model selector"
          data-shortcut-overlay
          tabIndex={-1}
          onKeyDown={event => {
            const target = event.target as HTMLElement;
            // Type to search, as in the chat's selector.
            if (choices.length > 0 && !searchOpen && event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey
              && target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
              event.preventDefault();
              setSearchOpen(true);
              setSearch(event.key);
              return;
            }
            moveSelectorFocus(event, panel.current, searchField.current);
          }}
          className="fixed z-50 w-[22rem] !max-w-[calc(100vw-16px)] overflow-auto card shadow-2xl outline-none"
        >
          {choices.length > 0 && (
            <div className="flex h-[39px] items-center gap-1 border-b border-line/60 px-2">
              {searchOpen
                ? <ModelSearch inputRef={searchField} value={search} onChange={setSearch} onClose={() => { setSearch(""); setSearchOpen(false); panel.current?.focus(); }} />
                : <ModelScopeBar providers={providers} agents={agents} active={active} onScope={setScope} onSearch={() => setSearchOpen(true)} />}
            </div>
          )}
          <div role="radiogroup" aria-label="Models" className="min-h-28 max-h-[min(40vh,17rem)] overflow-y-auto p-1.5">
            {lead && <>
              <div className="group flex items-center rounded-md pr-1 hover:bg-raised">
                <button type="button" role="radio" aria-checked={value === "same"} onClick={() => pick("same")}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2.5 pr-1 text-left text-[13px] focus-visible:-outline-offset-2 ${value === "same" ? "font-medium text-fg" : "text-muted group-hover:text-fg"}`}>
                  <span className="flex w-3 shrink-0 items-center justify-center">{value === "same" && <Icon name="check" size={12} />}</span>
                  <span className="truncate">Same as chat</span>
                  <span className="ml-auto shrink-0 pr-1 text-[11.5px] text-dim">The chat’s model does it</span>
                </button>
              </div>
              {missing && <ModelRow choice={{ agent: missing.agent as AgentId, label: missing.name }} label={`${missing.name} (not signed in)`}
                selected multiProvider favorite={false} onPick={() => pick(value)} />}
              {scoped.length > 0 && <div className="mx-2 my-1 border-t border-line/50" aria-hidden />}
            </>}
            {favRows.map(row)}
            {favRows.length > 0 && otherRows.length > 0 && <div className="mx-2 my-1 border-t border-line/50" aria-hidden />}
            {otherRows.map(row)}
            {!scoped.length && (query || active === "favorites") && (
              <p className="px-2.5 py-3 text-[13px] text-muted">
                {!query && active === "favorites" ? "Star a model to find it here." : "No matching models."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
