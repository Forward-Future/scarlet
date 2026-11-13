import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useMatch } from "react-router-dom";
import type { ModelOptions } from "@scarlet/shared";
import { isDesktop, type HostStatus } from "../../lib/desktop";
import { AGENT_LABEL, isConfiguredAgent, onlineAgents, useHostsStore } from "../../stores/hosts";
import { modelChoices, selectVisibleModel, useModelPreferences } from "../../stores/modelPicker";
import { ModelProviders, type ModelScope } from "./ModelProviders";
import { FavoriteButton } from "./FavoriteButton";
import { useUiStore } from "../../stores/ui";
import { AgentSignIn, canSignIn, useLocalHost } from "../shell/AgentSignIn";
import { Icon } from "../ui/primitives";
import { MENU_ITEM_CLASS } from "../shell/WorkspaceNavigation";

export const NO_AGENT_REASON = "Sign in with Claude or ChatGPT to let Scarlet edit";

// A provider on two hosts can offer different settings for the same model.
function supportedOptions(profiles: ModelOptions[], effort?: string, serviceTier?: string, preferSpeed = false) {
  const withEffort = profiles.filter(p => p.efforts.some(o => o.id === effort));
  const withSpeed = profiles.filter(p => p.speeds.some(o => o.id === serviceTier));
  if (withEffort.some(p => withSpeed.includes(p))) return { effort, serviceTier };
  if (withEffort.length && !(preferSpeed && withSpeed.length)) return { effort, serviceTier: undefined };
  return { effort: undefined, serviceTier: withSpeed.length ? serviceTier : undefined };
}

function pickerOptions(profiles: ModelOptions[], key: "efforts" | "speeds") {
  return [...new Map(profiles.flatMap(p => p[key]).map(o => [o.id, o])).values()];
}

function defaultSpeedTitle(profiles: ModelOptions[]) {
  const value = profiles[0]?.defaultSpeed;
  return value && profiles.every(p => p.defaultSpeed === value) ? `Provider default (${value})` : "Use provider default";
}

function optionLabel(option: { id: string; label?: string }) {
  return option.label ?? option.id.charAt(0).toUpperCase() + option.id.slice(1);
}

const effortRanks = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** How far up the model's own effort scale an effort sits, from 0 (lowest offered) to 1 (highest). */
function effortLevel(efforts: { id: string }[], effort?: string) {
  if (!effort) return undefined;
  const rank = (id: string) => effortRanks.indexOf(id.toLowerCase());
  const ordered = efforts.every(o => rank(o.id) >= 0) ? [...efforts].sort((a, b) => rank(a.id) - rank(b.id)) : efforts;
  const index = ordered.findIndex(o => o.id === effort);
  if (index < 0) return undefined;
  return ordered.length > 1 ? index / (ordered.length - 1) : 1;
}

const DIAL_SWEEP = 125;
function dialPoint(degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  return `${(8 + 6 * Math.sin(radians)).toFixed(2)} ${(9 - 6 * Math.cos(radians)).toFixed(2)}`;
}

function EffortDial({ level }: { level?: number }) {
  const start = -DIAL_SWEEP;
  const end = level === undefined ? undefined : start + 2 * DIAL_SWEEP * level;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="shrink-0" aria-hidden="true">
      <path d={`M${dialPoint(start)}A6 6 0 1 1 ${dialPoint(DIAL_SWEEP)}`} opacity="0.3" />
      {end !== undefined && end > start && <path d={`M${dialPoint(start)}A6 6 0 ${end - start > 180 ? 1 : 0} 1 ${dialPoint(end)}`} />}
      {end !== undefined && <path d="M8 9V4.5" strokeWidth="1.5" transform={`rotate(${end.toFixed(1)} 8 9)`} />}
      <circle cx="8" cy="9" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Which agent, model, effort and speed the next instruction goes to, resolved against what is online. */
export function useAgentAvailability() {
  const hosts = useHostsStore((s) => s.hosts);
  const customOpenaiModels = useHostsStore((s) => s.customOpenaiModels);
  const customClaudeModels = useHostsStore((s) => s.customClaudeModels);
  const agents = onlineAgents(hosts, customOpenaiModels, customClaudeModels);
  const pick = useUiStore((s) => s.agent);
  const hidden = useModelPreferences((s) => s.hidden);
  const available = modelChoices(agents);
  const choices = available.filter((m) => !hidden.includes(m.key));
  const selected = selectVisibleModel(choices, pick, agents);
  const same = pick.agent === selected?.agent && pick.model === selected?.model;
  // Older profiles saved Codex Fast as a boolean. Modern catalogs call the tier "priority".
  let tier = pick.serviceTier;
  if (same && tier === "fast" && selected?.agent === "codex") {
    const speeds = pickerOptions(selected.profiles, "speeds");
    if (!speeds.some(o => o.id === "fast") && speeds.some(o => o.id === "priority")) tier = "priority";
  }
  const effective = selected ? {
    agent: selected.agent,
    model: selected.model,
    ...supportedOptions(selected.profiles, same ? pick.effort : undefined, same ? tier : undefined),
  } : null;
  const hasConfiguredHost = hosts.some(h => h.agents.some(isConfiguredAgent));
  // Every model a signed-in agent offers is listed, so one that offers none is one whose list couldn't be read.
  const unavailableReason = available.length ? "Show a model in Settings to start an edit"
    : agents.length ? "Couldn’t read the model list. Refresh models in Settings to try again."
    : hasConfiguredHost ? "The model is offline" : NO_AGENT_REASON;
  return { agents, choices, selected, effective, none: !effective, unavailableReason, hasCatalog: available.length > 0, hasConfiguredHost };
}

/** Short label like "Claude · opus". */
export function agentShort(agent: string, model?: string): string {
  const name = (AGENT_LABEL as Record<string, string>)[agent]?.replace(/ (Code|CLI)$/, "") ?? agent;
  return model ? `${name} · ${model}` : name;
}

function OptionList<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ id: T; label: string; title?: string; icon?: ReactNode }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="px-3 py-2">
      <div className="eyebrow mb-1.5">{label}</div>
      <div className="flex flex-col gap-0.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={`flex-1 inline-flex items-center justify-between gap-1 rounded px-1.5 py-1 text-[12px] ${value === o.id ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
          >
            {o.icon}
            {o.label}{value === o.id && <Icon name="check" size={12} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Scarlet is still finding its models: the list of hosts hasn't arrived, this computer's host hasn't said what is
 * installed, or it hasn't reached the engine yet. That passes by itself, so nothing is marked for it.
 */
function stillConnecting(hostsReady: boolean, localHost: HostStatus | null) {
  return !hostsReady || (isDesktop() && !localHost?.agents.length) || (!!localHost && !localHost.connected && !localHost.error);
}

/** The selected model and effort, with model settings and local sign-in in the menu. */
/**
 * No model can run a request, and waiting won't change that: there is something to set up, or a host that was signed
 * in is offline. The simple view marks its menu for this.
 */
export function useModelNeedsYou(): boolean {
  const { agents, none, hasConfiguredHost } = useAgentAvailability();
  const hostsReady = useHostsStore(s => s.status === "ready");
  const localHost = useLocalHost();
  const checkingLocalAgents = isDesktop() && !localHost?.agents.length;
  const needsSetup = hostsReady && !checkingLocalAgents && !hasConfiguredHost && !localHost?.agents.some(isConfiguredAgent);
  return none && (agents.length > 0 || needsSetup || !stillConnecting(hostsReady, localHost));
}

/**
 * `variant="menu"` draws it as a row of a menu: "Model", then the one in use. The selector opens beside the row.
 */
export function AgentChip({ direction = "up", threadInput, variant = "chip" }: { direction?: "up" | "down"; threadInput?: "reply" | "answer"; variant?: "chip" | "menu" }) {
  const inProject = !!useMatch("/p/:id/*");
  const setSetupOpen = useUiStore((s) => s.setAgentSetupOpen);
  const { agents, choices, selected, effective, none, unavailableReason, hasCatalog, hasConfiguredHost } = useAgentAvailability();
  const hostsReady = useHostsStore(s => s.status === "ready");
  const favorites = useModelPreferences((s) => s.favorites);
  const [search, setSearch] = useState("");
  const pick = useUiStore((s) => s.agent);
  const setAgent = useUiStore((s) => s.setAgent);
  const localHost = useLocalHost();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<ModelScope>();
  const providers = agents.filter(a => choices.some(m => m.agent === a.id)).map(a => a.id);
  const active = scope === "favorites" ? scope : providers.find(id => id === scope) ?? providers[0];

  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const menu = panel.current;
    const anchor = trigger.current;
    function place() {
      const rect = anchor.getBoundingClientRect();
      // A menu's row opens the selector beside the menu, level with the row, so it covers none of the menu's rows:
      // on the side that has room for it. A window too narrow for either side opens it under the row.
      const rows = variant === "menu" ? anchor.closest('[role="menu"]')?.getBoundingClientRect() : undefined;
      const width = menu.offsetWidth;
      const beside = !rows ? undefined : window.innerWidth - rows.right - 14 >= width ? rows.right + 6 : rows.left - 14 >= width ? rows.left - width - 6 : undefined;
      if (beside !== undefined) {
        menu.style.maxHeight = `${window.innerHeight - 16}px`;
        menu.style.left = `${beside}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - menu.offsetHeight - 8))}px`;
        menu.style.right = "auto";
        return;
      }
      const above = rect.top - 12;
      const below = window.innerHeight - rect.bottom - 12;
      const up = direction === "up" ? above >= Math.min(300, below) : below < Math.min(300, above);
      menu.style.maxHeight = `${Math.max(80, up ? above : below)}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${up ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6}px`;
      menu.style.right = "auto";
    }
    place();
    searchField.current?.focus();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, direction, variant]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // Esc closes this menu and nothing behind it: left to go on, the same press also cancels the dialog the picker
    // sits in, such as a note, and what was typed there is lost.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  // Installed on this computer but not signed in yet: offer the one-click sign-in.
  const needsSignIn = (localHost?.agents ?? []).filter((a) => a.installed && canSignIn(a.id) && a.loggedIn === false && !agents.some((x) => x.id === a.id));

  // An empty or offline catalog doesn't establish that the editor needs to sign in.
  const checkingLocalAgents = isDesktop() && !localHost?.agents.length;
  const needsSetup = hostsReady && !checkingLocalAgents && !hasConfiguredHost && !localHost?.agents.some(isConfiguredAgent);
  const inMenu = variant === "menu";
  if (!agents.length && !needsSetup) {
    // The menu's row stays and says why no request can run. Still connecting needs nothing from the editor. A host
    // that was signed in and is offline does: the row carries the menu's mark, and opens the sign-in, which says why.
    const connecting = stillConnecting(hostsReady, localHost);
    if (inMenu) return <button type="button" role="menuitem" className={`${MENU_ITEM_CLASS} text-fg`} onClick={() => setSetupOpen(true)}>
      <EffortDial level={0} />Model<span className="menu-value">{connecting ? "Connecting…" : "Offline"}</span>{!connecting && <span className="menu-dot" aria-hidden />}</button>;
    return threadInput ? <button type="button" className="btn-quiet" onClick={() => setSetupOpen("models")}>Models</button> : null;
  }

  if (none && inProject) {
    const setUp = agents.length ? (hasCatalog ? "Choose visible models" : "Refresh models") : "Set up a model";
    return inMenu
      ? <button type="button" role="menuitem" className={`${MENU_ITEM_CLASS} text-fg`} onClick={() => setSetupOpen(agents.length ? "models" : true)}>
        <EffortDial level={0} />{setUp}<span className="menu-dot" aria-hidden /></button>
      : <button type="button" className="btn-quiet" onClick={() => setSetupOpen(agents.length ? "models" : true)}>{setUp}</button>;
  }
  if (none && (agents.length || !needsSignIn.length)) {
    return (
      <Link to={agents.length ? "/settings#models" : "/settings#hosts"} className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 px-3 py-1.5 text-[12px] text-warn hover:bg-warn/10" title={unavailableReason}>
        <span className="size-1.5 rounded-full bg-warn" /> {agents.length ? (hasCatalog ? "Choose visible models" : "Refresh models") : isDesktop() ? "Set up a model" : "No model is ready"}
      </Link>
    );
  }

  const choose = (next: Partial<typeof pick>) => {
    const merged = { ...(effective ?? pick), ...next };
    const choice = choices.find(m => m.agent === merged.agent && m.model === merged.model);
    setAgent({ ...merged, ...supportedOptions(choice?.profiles ?? [], merged.effort, merged.serviceTier, !!next.serviceTier) });
  };
  const profiles = selected?.profiles ?? [];
  const efforts = pickerOptions(profiles, "efforts").filter(o => o.id.toLowerCase() !== "auto");
  const speeds = pickerOptions(profiles, "speeds");
  const effort = efforts.find(o => o.id === effective?.effort);
  const dialEffort = effort ?? efforts.find(o => o.id === selected?.defaultEffort);
  const effortLabel = dialEffort ? optionLabel(dialEffort) + (effort ? "" : " (provider default)") : "Provider default";
  const effortTitle = `Thinking effort: ${effortLabel}`;
  const hasOptions = efforts.length > 0 || speeds.length > 0;
  const speed = speeds.find(o => o.id === effective?.serviceTier);
  const label = selected?.name ?? "Sign in to start";
  const details = effective ? `${agentShort(effective.agent)} · ${label}. ${effortTitle}${speed ? `, speed: ${optionLabel(speed)}` : ""}` : label;

  const query = search.trim().toLowerCase();
  const matches = choices.filter((m) => `${AGENT_LABEL[m.agent]} ${m.label} ${m.model ?? ""}`.toLowerCase().includes(query));
  const scoped = query ? matches : matches.filter(m => active === "favorites" ? favorites.includes(m.key) : m.agent === active);
  const groups = [
    { name: "Favorites", favorite: true, rows: scoped.filter((m) => favorites.includes(m.key)) },
    ...agents.map((a) => ({ name: AGENT_LABEL[a.id], favorite: false, rows: scoped.filter((m) => m.agent === a.id && !favorites.includes(m.key)) })),
  ];
  const answerHint = threadInput === "answer" ? "This model is for your next edit. Your answer goes to the model that asked." : undefined;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${details}. Change model, effort or speed`}
        aria-description={answerHint}
        title={answerHint ?? (selected ? effortTitle : undefined)}
        onClick={() => { setScope(selected?.agent); setSearch(""); setOpen((o) => !o); }}
        {...(inMenu && { role: "menuitem" })}
        className={inMenu ? `${MENU_ITEM_CLASS} text-fg`
          : `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] hover:text-fg ${none ? "border-warn/40 text-warn" : "border-line text-muted hover:border-dim"}`}
      >
        {inMenu ? <>
          <EffortDial level={selected ? effortLevel(efforts, dialEffort?.id) : 0} />Model
          <span className="menu-value truncate">{label}</span>{none && <span className="menu-dot" aria-hidden />}
        </> : <>
          {none && <span className="size-1.5 rounded-full bg-warn" aria-hidden />}
          <span className="truncate">{label}</span>
          {selected ? <EffortDial level={effortLevel(efforts, dialEffort?.id)} /> : <Icon name="down" size={11} />}
        </>}
      </button>
      {open && (
        <div ref={panel} role="dialog" aria-label="Model selector" data-shortcut-overlay
          onKeyDown={event => {
            const target = event.target as HTMLElement;
            if (target === searchField.current && event.key === "ArrowLeft" && !search) {
              event.preventDefault();
              panel.current?.querySelector<HTMLButtonElement>('[aria-label="Providers"] [aria-pressed="true"]')?.focus();
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const group = target === searchField.current ? panel.current?.querySelector('[aria-label="Models"]') : target.closest('[role="radiogroup"], [aria-label="Providers"]');
            const selector = group?.getAttribute("role") === "radiogroup" ? 'button[role="radio"]' : "button";
            const buttons = Array.from(group?.querySelectorAll<HTMLButtonElement>(selector) ?? []);
            if (!buttons.length) return;
            event.preventDefault();
            const index = buttons.indexOf(target as HTMLButtonElement);
            const next = index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
          className={`fixed z-50 !max-w-[calc(100vw-16px)] overflow-auto card shadow-2xl ${hasOptions ? "w-[30rem]" : "w-[22rem]"}`}>
          {answerHint && <p className="border-b border-line px-3 py-2 text-xs text-muted">{answerHint}</p>}
          <div className="flex">
            {choices.length > 0 && <ModelProviders compact providers={["favorites", ...providers]} active={query ? undefined : active}
              onChange={id => { setScope(id); setSearch(""); searchField.current?.focus(); }} />}
            <div className="min-w-0 flex-1">
              {choices.length > 0 && <label className="flex items-center gap-2 border-b border-line/60 px-3 py-2 text-muted">
                <Icon name="search" />
                <input type="search" ref={searchField} aria-label="Search models" placeholder="Search all models…" className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>}
              <div role="radiogroup" aria-label="Models" className="min-h-28 max-h-[min(40vh,19rem)] overflow-y-auto">
                {groups.filter((group) => group.rows.length > 0).map((group) => (
                  <div key={group.name} className="py-1">
                    <div className="px-3 py-1 eyebrow">{group.name}</div>
                    {group.rows.map((m) => (
                      <div key={m.key} className="flex items-center pr-2">
                        <button type="button" role="radio" aria-checked={selected?.key === m.key}
                          aria-label={`${AGENT_LABEL[m.agent]} · ${m.label}`}
                          onClick={() => choose({ agent: m.agent, model: m.model })}
                          className={`flex flex-1 min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-raised focus-visible:-outline-offset-2 ${selected?.key === m.key ? "text-fg" : "text-muted"}`}>
                          <span className="w-3 shrink-0">{selected?.key === m.key && <Icon name="check" size={12} />}</span>
                          <span className="truncate">{m.label}</span>
                          {group.favorite && <span className="ml-auto pl-1 text-[11px] text-dim">{agentShort(m.agent)}</span>}
                        </button>
                        <FavoriteButton choice={m} />
                      </div>
                    ))}
                  </div>
                ))}
                {choices.length > 0 && !scoped.length && <p className="px-3 py-3 text-[13px] text-muted">{!query && active === "favorites" ? "Star a model to find it here." : "No matching models."}</p>}
              </div>
            </div>
            {effective && hasOptions && (
              <div className="w-32 shrink-0 border-l border-line bg-bg/40 pb-1">
                <div className="truncate border-b border-line/60 px-3 py-2 text-xs font-medium" title={selected?.label}>{selected?.label}</div>
                {efforts.length > 0 && (
                  <OptionList
                    label="Effort"
                    value={effective.effort ?? ""}
                    onChange={(effort) => choose({ effort })}
                    options={efforts.map(e => ({ id: e.id, label: optionLabel(e), title: e.description }))}
                  />
                )}
                {speeds.length > 0 && (
                  <OptionList
                    label="Speed"
                    value={effective.serviceTier ?? ""}
                    onChange={(v) => choose({ serviceTier: v || undefined })}
                    options={[
                      { id: "", label: "Auto", title: defaultSpeedTitle(profiles) },
                      ...speeds.map(o => ({ id: o.id, label: optionLabel(o), title: o.description })),
                    ]}
                  />
                )}
              </div>
            )}
          </div>
          {/* A grid, so that why a sign-in failed, which AgentSignIn draws after its button, is a row under the name and the button. */}
          {needsSignIn.map((a) => (
            <div key={a.id} className="px-3 py-2 grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 border-t border-line/60 first:border-t-0">
              <span className="text-[13px] text-muted">{AGENT_LABEL[a.id]}</span>
              <AgentSignIn agent={a} compact />
            </div>
          ))}
          <div className="flex justify-between border-t border-line/60 mt-1 px-3 pt-2 pb-1.5">
            {inProject ? <>
              <button type="button" className="text-[12px] text-muted hover:text-fg" onClick={() => { setOpen(false); setSetupOpen("models"); }}>Manage models…</button>
              <button type="button" className="text-[12px] text-dim hover:text-muted" onClick={() => { setOpen(false); setSetupOpen(true); }}>Manage sign-in…</button>
            </> : <>
              <Link to="/settings#models" className="text-[12px] text-muted hover:text-fg" onClick={() => setOpen(false)}>Manage models…</Link>
              <Link to="/settings#hosts" className="text-[12px] text-dim hover:text-muted" onClick={() => setOpen(false)}>Manage sign-in…</Link>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}
