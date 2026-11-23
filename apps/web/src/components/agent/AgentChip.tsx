import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useMatch } from "react-router-dom";
import type { RunChoice, Task } from "@scarlet/shared";
import { isDesktop, type HostStatus } from "../../lib/desktop";
import { AGENT_LABEL, isConfiguredAgent, onlineAgents, useHostsStore } from "../../stores/hosts";
import { modelChoices, selectVisibleModel, useModelPreferences } from "../../stores/modelPicker";
import { ProviderIcon, type ModelScope } from "./ModelProviders";
import { ModelRefreshButton, ModelRefreshFeedback, useModelRefresh } from "./ModelRefresh";
import { FavoriteButton } from "./FavoriteButton";
import { QuotaDetails } from "./QuotaDetails";
import { moveSelectorFocus, placeModelSelector } from "./modelSelectorLayout";
import { BoltIcon, EffortDial, GaugeIcon, TuneDrawer } from "./ModelControls";
import { STANDARD_SPEEDS, defaultSpeedTitle, effortLevel, normalizeSpeedTier, optionLabel, orderEfforts, pickerOptions, supportedOptions } from "./modelOptions";
import {
  LOW_QUOTA_THRESHOLD, QUOTA_STALE_MS, formatPercent, isSubscriptionProvider, minRemainingPercent, providerShortName, type QuotaAgent,
} from "./subscriptionQuota";
import { useUiStore } from "../../stores/ui";
import { AgentSignIn, AgentUpdate, canSignIn, useLocalHost } from "../shell/AgentSignIn";
import { Icon } from "../ui/primitives";
import { MENU_ITEM_CLASS } from "../shell/WorkspaceNavigation";

export const NO_AGENT_REASON = "Sign in with Claude, ChatGPT or Google to let Scarlet edit";

/** True when `choice` picks a different model, effort, or speed tier than `task` is currently set to run with. */
export function runChoiceDiffers(task: Pick<Task, "agent" | "model" | "effort" | "fast" | "serviceTier">, choice: RunChoice): boolean {
  if (!choice.agent) return false;
  const tier = choice.serviceTier ?? (choice.fast ? "fast" : undefined);
  const taskTier = task.serviceTier ?? (task.fast ? "fast" : undefined);
  return choice.agent !== task.agent || choice.model !== task.model || choice.effort !== task.effort || tier !== taskTier;
}

/**
 * The model choice Resume editing sends: the one picked now when any paused request would run on something else.
 * Resume picks up every paused request in the project, so each is compared, not only the one whose band was pressed.
 */
export function resumeRunChoice(tasks: readonly Pick<Task, "state" | "resumesAfterProjectStop" | "startedAt" | "agent" | "model" | "effort" | "fast" | "serviceTier">[],
  choice: RunChoice | null | undefined): RunChoice | undefined {
  return choice && tasks.some(t => t.state === "queued" && t.resumesAfterProjectStop && !t.startedAt && runChoiceDiffers(t, choice)) ? choice : undefined;
}

/** Which agent, model, effort and speed the next instruction goes to, resolved against what is online. */
export function useAgentAvailability() {
  const hosts = useHostsStore((s) => s.hosts);
  const customOpenaiModels = useHostsStore((s) => s.customOpenaiModels);
  const customClaudeModels = useHostsStore((s) => s.customClaudeModels);
  const customGeminiModels = useHostsStore((s) => s.customGeminiModels);
  const agents = onlineAgents(hosts, customOpenaiModels, customClaudeModels, customGeminiModels);
  const pick = useUiStore((s) => s.agent);
  const hidden = useModelPreferences((s) => s.hidden);
  const tuningByModel = useModelPreferences((s) => s.tuningByModel);
  const available = modelChoices(agents);
  const choices = available.filter((m) => !hidden.includes(m.key));
  const selected = selectVisibleModel(choices, pick, agents);
  const same = pick.agent === selected?.agent && pick.model === selected?.model;
  const remembered = selected ? tuningByModel[selected.key] : undefined;
  const rawEffort = same ? pick.effort : remembered?.effort;
  const rawTier = selected
    ? normalizeSpeedTier(selected.agent, selected.profiles, same ? pick.serviceTier : remembered?.serviceTier)
    : undefined;
  const effective = selected ? {
    agent: selected.agent,
    model: selected.model,
    ...supportedOptions(selected.profiles, rawEffort, rawTier),
  } : null;
  const hasConfiguredHost = hosts.some(h => h.agents.some(isConfiguredAgent));
  // Every model a signed-in agent offers is listed, so one that offers none is one whose list couldn't be read.
  const unavailableReason = available.length ? "Show a model in Settings to start an edit"
    : agents.length ? "Couldn’t read the model list. Refresh models to try again."
    : hasConfiguredHost ? "The model is offline" : NO_AGENT_REASON;
  return { agents, choices, selected, effective, none: !effective, unavailableReason, hasCatalog: available.length > 0, hasConfiguredHost };
}

/** A grid, so that why a sign-in failed, which AgentSignIn draws after its button, is a row under the name and the button. */
function SignInRows({ agents }: { agents: HostStatus["agents"] }) {
  return agents.map((a) => (
    <div key={a.id} className="px-3 py-2 grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 border-t border-line/60">
      <span className="text-[13px] text-muted">{AGENT_LABEL[a.id]}</span>
      <AgentSignIn agent={a} compact />
    </div>
  ));
}

/**
 * Scarlet is still finding its models: the list of hosts hasn't arrived, this computer's host hasn't said what is
 * installed, or it hasn't reached the engine yet. That passes by itself, so nothing is marked for it.
 */
function stillConnecting(hostsReady: boolean, localHost: HostStatus | null) {
  return !hostsReady || (isDesktop() && !localHost?.agents.length) || (!!localHost && !localHost.connected && !localHost.error);
}

/**
 * The selected model and effort, with model settings and local sign-in in the menu.
 * `variant="header"` draws it as a quiet header button that marks itself when no model is ready.
 * `variant="menu"` draws it as a row of a menu: "Model", then the one in use, opening the selector beside the row.
 */
export function AgentChip({ direction = "up", threadInput, variant = "chip" }: { direction?: "up" | "down"; threadInput?: "reply" | "answer"; variant?: "chip" | "menu" | "header" | "icon" }) {
  const inProject = !!useMatch("/p/:id/*");
  const setSetupOpen = useUiStore((s) => s.setAgentSetupOpen);
  const { agents, choices, selected, effective, none, unavailableReason, hasCatalog, hasConfiguredHost } = useAgentAvailability();
  const hostsReady = useHostsStore(s => s.status === "ready");
  const refreshingQuota = useHostsStore((s) => s.refreshingQuota);
  const refreshQuota = useHostsStore((s) => s.refreshQuota);
  const favorites = useModelPreferences((s) => s.favorites);
  const tuningByModel = useModelPreferences((s) => s.tuningByModel);
  const setModelTuning = useModelPreferences((s) => s.setModelTuning);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [gearOpen, setGearOpen] = useState(false);
  const [drawer, setDrawer] = useState<"none" | "tune" | "quota">("none");
  const pick = useUiStore((s) => s.agent);
  const setAgent = useUiStore((s) => s.setAgent);
  const localHost = useLocalHost();
  const modelRefresh = useModelRefresh();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const gearButton = useRef<HTMLButtonElement>(null);
  const gearMenu = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<ModelScope>();
  const providers = agents.filter(a => choices.some(m => m.agent === a.id)).map(a => a.id);
  const active: ModelScope = scope === "all" || scope === "favorites"
    ? scope
    : providers.find(id => id === scope) ?? providers[0] ?? "all";

  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const menu = panel.current;
    const anchor = trigger.current;
    const place = () => placeModelSelector(menu, anchor, direction, variant === "menu");
    place();
    (searchField.current ?? menu).focus();
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
    if (open && searchOpen) searchField.current?.focus();
  }, [open, searchOpen]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target)) {
        setOpen(false);
        return;
      }
      if (gearOpen && !gearMenu.current?.contains(target) && !gearButton.current?.contains(target)) {
        setGearOpen(false);
      }
    };
    // Esc closes layered menus first (gear -> search -> picker) and nothing behind the picker:
    // left to go on, the same press also cancels the dialog the picker sits in, such as a note.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (gearOpen) {
        setGearOpen(false);
        gearButton.current?.focus();
      } else if (searchOpen) {
        setSearch("");
        setSearchOpen(false);
        panel.current?.focus();
      } else {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", esc);
    };
  }, [open, gearOpen, searchOpen]);

  // Installed on this computer but not signed in yet: offer the one-click sign-in.
  const needsSignIn = (localHost?.agents ?? []).filter((a) => a.installed && canSignIn(a.id) && a.loggedIn === false && !agents.some((x) => x.id === a.id));

  // A newer Claude Code, Codex or Gemini the app can update in place: the header's button carries the amber dot and the
  // selector offers the update, as Settings does.
  const updates = (localHost?.agents ?? []).filter((a) => a.installed && a.latestVersion && canSignIn(a.id));
  const updateNote = updates.length ? `A newer ${updates.map((a) => AGENT_LABEL[a.id]).join(" and ")} is available` : undefined;
  const updateRows = updates.map((a) => (
    <div key={a.id} className="px-3 py-2 grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 border-t border-line/60" data-agent-update={a.id}>
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted"><span className="truncate">{AGENT_LABEL[a.id]}</span><span className="menu-dot" aria-hidden /></span>
      <AgentUpdate agent={a} compact />
    </div>
  ));

  // An empty or offline catalog doesn't establish that the editor needs to sign in.
  const checkingLocalAgents = isDesktop() && !localHost?.agents.length;
  const needsSetup = hostsReady && !checkingLocalAgents && !hasConfiguredHost && !localHost?.agents.some(isConfiguredAgent);
  const inMenu = variant === "menu";
  const inHeader = variant === "header";
  const iconOnly = variant === "icon";
  const emptyCatalog = agents.length > 0 && !hasCatalog;
  if (!open && !iconOnly && !agents.length && !needsSetup) {
    // The menu row and header button stay and say why no request can run. Still connecting needs nothing from the editor.
    // A host that was signed in and is offline does: the control carries the amber mark and opens sign-in, which says why.
    const connecting = stillConnecting(hostsReady, localHost);
    if (inMenu) return <button type="button" role="menuitem" className={`${MENU_ITEM_CLASS} text-fg`} onClick={() => setSetupOpen(true)}>
      <EffortDial level={0} />Model<span className="menu-value">{connecting ? "Connecting…" : "Offline"}</span>{!connecting && <span className="menu-dot" aria-hidden />}</button>;
    if (inHeader) {
      const warning = connecting ? undefined : "No model is ready";
      return <button type="button" className={`btn-quiet simple-model${warning ? " needs-you" : ""}`} aria-haspopup="dialog"
        aria-description={warning} title={warning ?? "Connecting to model"} onClick={() => setSetupOpen(true)}>
        <span className="truncate">{connecting ? "Connecting…" : "Offline"}</span>
        {warning && <span className="menu-dot" role="img" aria-label={warning} />}
      </button>;
    }
    return threadInput ? <button type="button" className="btn-quiet" onClick={() => setSetupOpen("models")}>Models</button> : null;
  }

  if (!open && !iconOnly && none && !emptyCatalog && (inProject || inHeader)) {
    const setUp = agents.length ? "Choose visible models" : "Set up a model";
    return inMenu
      ? <button type="button" role="menuitem" className={`${MENU_ITEM_CLASS} text-fg`} onClick={() => setSetupOpen(agents.length ? "models" : true)}>
        <EffortDial level={0} />{setUp}<span className="menu-dot" aria-hidden /></button>
      : inHeader
        ? <button type="button" className="btn-quiet simple-model needs-you" aria-haspopup="dialog"
          aria-description={unavailableReason} title={unavailableReason} onClick={() => setSetupOpen(agents.length ? "models" : true)}>
          <span className="truncate">{setUp}</span>
          <span className="menu-dot" role="img" aria-label="No model is ready" />
        </button>
      : <button type="button" className="btn-quiet" onClick={() => setSetupOpen(agents.length ? "models" : true)}>{setUp}</button>;
  }
  if (!open && !iconOnly && none && !emptyCatalog && (agents.length || !needsSignIn.length)) {
    return (
      <Link to={agents.length ? "/settings#models" : "/settings#hosts"} className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 px-3 py-1.5 text-[12px] text-warn hover:bg-warn/10" title={unavailableReason}>
        <span className="size-1.5 rounded-full bg-warn" /> {agents.length ? "Choose visible models" : isDesktop() ? "Set up a model" : "No model is ready"}
      </Link>
    );
  }

  const choose = (next: Partial<typeof pick>) => {
    const base = effective ?? pick;
    const targetAgent = next.agent ?? base.agent;
    const targetModel = "model" in next ? next.model : base.model;
    const switchingModel = targetAgent !== base.agent || targetModel !== base.model;
    const choice = choices.find(m => m.agent === targetAgent && m.model === targetModel);

    if (switchingModel) {
      // Capture the outgoing model's explicit tuning before switching away if not stored yet.
      if (selected && effective && !(selected.key in tuningByModel) && (effective.effort || effective.serviceTier)) {
        setModelTuning(selected.key, { effort: effective.effort, serviceTier: effective.serviceTier });
      }
      const remembered = choice ? tuningByModel[choice.key] : undefined;
      const rawEffort = "effort" in next ? next.effort : remembered?.effort;
      const rawTier = choice
        ? normalizeSpeedTier(choice.agent, choice.profiles, "serviceTier" in next ? next.serviceTier : remembered?.serviceTier)
        : next.serviceTier;
      const resolved = supportedOptions(choice?.profiles ?? [], rawEffort, rawTier, Boolean(next.serviceTier));
      setAgent({ agent: targetAgent, model: targetModel, ...resolved });
      return;
    }

    const merged = { ...base, ...next };
    const normalizedTier = choice ? normalizeSpeedTier(choice.agent, choice.profiles, merged.serviceTier) : merged.serviceTier;
    const resolved = supportedOptions(choice?.profiles ?? [], merged.effort, normalizedTier, Boolean(next.serviceTier));
    if (choice) {
      setModelTuning(choice.key, { effort: resolved.effort, serviceTier: resolved.serviceTier });
    }
    setAgent({ ...merged, ...resolved });
  };
  const profiles = selected?.profiles ?? [];
  const efforts = orderEfforts(pickerOptions(profiles, "efforts").filter(o => o.id.toLowerCase() !== "auto"));
  const speeds = pickerOptions(profiles, "speeds");
  // A model that names its own standard speed (Claude's) is offered it in place of the provider-default row, so Standard shows once.
  const standardSpeed = speeds.find(o => STANDARD_SPEEDS.has(o.id.toLowerCase()) || optionLabel(o).toLowerCase() === "standard");
  const speedOptions = speeds.length > 0 ? [
    ...(standardSpeed ? [] : [{ id: "", label: "Standard", title: defaultSpeedTitle(profiles) }]),
    ...speeds.map(o => ({ id: o.id, label: optionLabel(o), title: o.description })),
  ] : [];
  const effort = efforts.find(o => o.id === effective?.effort);
  const dialEffort = effort ?? efforts.find(o => o.id === selected?.defaultEffort);
  const effortLabel = dialEffort ? optionLabel(dialEffort) + (effort ? "" : " (provider default)") : "Provider default";
  const effortSummary = dialEffort ? optionLabel(dialEffort) : "Default";
  const effortTitle = `Thinking effort: ${effortLabel}`;
  const hasOptions = efforts.length > 0 || speedOptions.length > 0;
  const activeSpeedId = effective?.serviceTier ?? standardSpeed?.id ?? "";
  const speed = speeds.find(o => o.id === effective?.serviceTier);
  const speedSummary = (speedOptions.find(o => o.id === activeSpeedId) ?? speedOptions[0])?.label ?? "Standard";
  const label = selected?.name ?? (emptyCatalog ? "Refresh models" : "Sign in to start");
  const details = effective ? `${providerShortName(effective.agent)} · ${label}. ${effortTitle}${speed ? `, speed: ${optionLabel(speed)}` : ""}` : label;

  // Subscription quota (strictly omitted for API-key providers).
  const subscriptionAgents = agents.filter(isSubscriptionProvider);
  const quotaProviders = subscriptionAgents.filter((a): a is QuotaAgent => Boolean(a.quota));
  const activeQuotaProvider = quotaProviders.find((a) => a.id === selected?.agent)
    ?? quotaProviders.reduce<QuotaAgent | undefined>((lowest, cur) => {
      const curMin = minRemainingPercent(cur.quota) ?? 100;
      const lowMin = lowest ? (minRemainingPercent(lowest.quota) ?? 100) : Infinity;
      return curMin < lowMin ? cur : lowest;
    }, undefined);
  const activeQuotaMin = minRemainingPercent(activeQuotaProvider?.quota);
  const activeQuotaLow = activeQuotaMin !== undefined && activeQuotaMin < LOW_QUOTA_THRESHOLD;
  const quotaPillText = activeQuotaProvider?.quota.unlimited && !activeQuotaProvider.quota.buckets.length
    ? "∞"
    : activeQuotaMin !== undefined
      ? formatPercent(activeQuotaMin)
      : undefined;
  const hasDock = Boolean((effective && hasOptions) || quotaProviders.length > 0);

  const query = search.trim().toLowerCase();
  const matches = choices.filter((m) => `${AGENT_LABEL[m.agent]} ${m.label} ${m.model ?? ""}`.toLowerCase().includes(query));
  const scoped = query
    ? matches
    : active === "all"
      ? matches
      : active === "favorites"
        ? matches.filter((m) => favorites.includes(m.key))
        : matches.filter((m) => m.agent === active);
  const favRows = scoped.filter((m) => favorites.includes(m.key));
  const otherRows = scoped.filter((m) => !favorites.includes(m.key));
  const multiProvider = Boolean(query) || active === "all" || active === "favorites";
  const selectedInView = Boolean(selected && scoped.some((m) => m.key === selected.key));

  const renderModelRow = (m: (typeof choices)[number]) => (
    <div key={m.key} className="group flex items-center rounded-md pr-1 hover:bg-raised">
      <button
        type="button"
        role="radio"
        aria-checked={selected?.key === m.key}
        aria-label={`${AGENT_LABEL[m.agent]} · ${m.label}`}
        onClick={() => choose({ agent: m.agent, model: m.model })}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2.5 pr-1 text-left text-[13px] focus-visible:-outline-offset-2 ${selected?.key === m.key ? "font-medium text-fg" : "text-muted group-hover:text-fg"}`}
      >
        <span className="flex w-3 shrink-0 items-center justify-center">
          {selected?.key === m.key && <Icon name="check" size={12} />}
        </span>
        {multiProvider && <span className="shrink-0 opacity-85"><ProviderIcon id={m.agent} size={13} /></span>}
        <span className="truncate">{m.label}</span>
      </button>
      <FavoriteButton choice={m} revealOnHover />
    </div>
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={iconOnly ? "Choose model" : emptyCatalog ? "Refresh models" : `Model: ${details}. Change model, effort or speed`}
        aria-description={iconOnly && selected ? details : inHeader && emptyCatalog ? unavailableReason : inHeader ? updateNote : undefined}
        title={iconOnly ? (selected ? `Model: ${details}` : "Choose model") : inHeader ? (emptyCatalog ? unavailableReason : selected ? `Model: ${details}` : undefined) : emptyCatalog ? unavailableReason : selected ? effortTitle : undefined}
        onClick={() => {
          if (!open) {
            setScope(selected?.agent ?? "all");
            setSearch("");
            setSearchOpen(false);
            setGearOpen(false);
            setDrawer("none");
            modelRefresh.clear();
            if (emptyCatalog && !iconOnly) void modelRefresh.refresh();
            // Stale-while-revalidate: trigger a non-blocking background quota check when missing or >60s old.
            if (subscriptionAgents.length > 0) {
              const now = Date.now();
              const needsQuotaRefresh = subscriptionAgents.some((a) => {
                if (!a.quota) return true;
                const ts = Date.parse(a.quota.fetchedAt);
                return !Number.isFinite(ts) || now - ts >= QUOTA_STALE_MS;
              });
              if (needsQuotaRefresh) void refreshQuota({ force: false });
            }
          }
          setOpen(!open);
        }}
        {...(inMenu && { role: "menuitem" })}
        className={inMenu ? `${MENU_ITEM_CLASS} text-fg`
          : iconOnly ? "btn-icon aria-expanded:bg-raised aria-expanded:text-fg"
          : inHeader ? `btn-quiet simple-model aria-expanded:bg-raised aria-expanded:text-fg${none || updateNote ? " needs-you" : ""}`
          : `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] hover:text-fg ${none ? "border-warn/40 text-warn" : "border-line text-muted hover:border-dim"}`}
      >
        {iconOnly ? <EffortDial level={effortLevel(efforts, dialEffort?.id)} /> : inMenu ? <>
          <EffortDial level={selected ? effortLevel(efforts, dialEffort?.id) : 0} />
          {emptyCatalog ? label : <>Model<span className="menu-value truncate">{label}</span></>}
          {none && <span className="menu-dot" aria-hidden />}
        </> : inHeader ? <>
          <span className="truncate">{label}</span>
          {selected ? <EffortDial level={effortLevel(efforts, dialEffort?.id)} /> : <span className="menu-dot" role="img" aria-label={unavailableReason} />}
          {selected && updateNote && <span className="menu-dot" role="img" aria-label={updateNote} />}
        </> : <>
          {none && <span className="size-1.5 rounded-full bg-warn" aria-hidden />}
          <span className="truncate">{label}</span>
          {selected ? <EffortDial level={effortLevel(efforts, dialEffort?.id)} /> : <Icon name="down" size={11} />}
        </>}
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
            // Type any printable character while the selector is focused to jump straight into search.
            if (
              choices.length > 0 && !searchOpen && !gearOpen &&
              event.key.length === 1 && event.key !== " " &&
              !event.ctrlKey && !event.metaKey && !event.altKey &&
              target.tagName !== "INPUT" && target.tagName !== "TEXTAREA"
            ) {
              event.preventDefault();
              setSearchOpen(true);
              setSearch(event.key);
              return;
            }
            moveSelectorFocus(event, panel.current, searchField.current);
          }}
          className="fixed z-50 w-[22rem] !max-w-[calc(100vw-16px)] overflow-auto card shadow-2xl outline-none"
        >
          {!choices.length ? (
            <>
              <p className="px-3 py-3 text-[13px] text-muted">{unavailableReason}</p>
              <SignInRows agents={needsSignIn} />
              {updateRows}
              <div className="border-t border-line/60 px-3 py-1.5">
                <div className="flex flex-wrap items-center justify-between gap-x-3">
                  <ModelRefreshButton action={modelRefresh} />
                  {inProject ? <>
                    <button type="button" className="text-[12px] text-muted hover:text-fg" onClick={() => { setOpen(false); setSetupOpen("models"); }}>Manage models…</button>
                    <button type="button" className="text-[12px] text-dim hover:text-muted" onClick={() => { setOpen(false); setSetupOpen(true); }}>Manage sign-in…</button>
                  </> : <>
                    <Link to="/settings#models" className="text-[12px] text-muted hover:text-fg" onClick={() => setOpen(false)}>Manage models…</Link>
                    <Link to="/settings#hosts" className="text-[12px] text-dim hover:text-muted" onClick={() => setOpen(false)}>Manage sign-in…</Link>
                  </>}
                </div>
                <ModelRefreshFeedback action={modelRefresh} />
              </div>
            </>
          ) : (
            <>
              <div className="flex h-[39px] items-center gap-1 border-b border-line/60 px-2">
                {searchOpen ? (
                  <label className="flex min-w-0 flex-1 items-center gap-2 pl-1 text-muted">
                    <Icon name="search" size={13} />
                    <input
                      type="search"
                      ref={searchField}
                      aria-label="Search models"
                      placeholder="Search models…"
                      className="min-w-0 flex-1 border-b-0 bg-transparent text-[13px] text-fg outline-none placeholder:text-dim"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label="Close search"
                      title="Close search"
                      onClick={() => { setSearch(""); setSearchOpen(false); panel.current?.focus(); }}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </label>
                ) : (
                  <>
                    <div role="group" aria-label="Providers" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                      <button
                        type="button"
                        aria-pressed={active === "all"}
                        onClick={() => { setScope("all"); setGearOpen(false); }}
                        className={`flex h-[26px] shrink-0 items-center rounded-md px-2 text-[11.5px] font-medium transition-colors ${active === "all" ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        aria-label="Favorites"
                        title="Favorites"
                        aria-pressed={active === "favorites"}
                        onClick={() => { setScope("favorites"); setGearOpen(false); }}
                        className={`flex size-[26px] shrink-0 items-center justify-center rounded-md transition-colors ${active === "favorites" ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
                      >
                        <Icon name="star" size={12} />
                      </button>
                      {providers.map((id) => {
                        const agentInfo = agents.find((a) => a.id === id);
                        const minPct = agentInfo && isSubscriptionProvider(agentInfo) ? minRemainingPercent(agentInfo.quota) : undefined;
                        const isLow = minPct !== undefined && minPct < LOW_QUOTA_THRESHOLD;
                        const pillTitle = minPct !== undefined
                          ? `${AGENT_LABEL[id]} · ${formatPercent(minPct)} remaining`
                          : AGENT_LABEL[id];
                        return (
                          <button
                            key={id}
                            type="button"
                            aria-label={AGENT_LABEL[id]}
                            title={pillTitle}
                            aria-pressed={active === id}
                            onClick={() => { setScope(id); setGearOpen(false); }}
                            className={`relative flex size-[26px] shrink-0 items-center justify-center rounded-md transition-colors ${active === id ? "bg-raised text-fg" : "text-muted opacity-75 hover:bg-raised/60 hover:opacity-100"}`}
                          >
                            <ProviderIcon id={id} size={14} />
                            {minPct !== undefined && (
                              <span
                                data-quota-bar={id}
                                data-low={isLow ? "true" : "false"}
                                className="pointer-events-none absolute bottom-[2px] left-[4px] right-[4px] h-[2px] overflow-hidden rounded-full bg-line/70"
                                aria-hidden="true"
                              >
                                <span
                                  className={`block h-full rounded-full ${isLow ? "bg-warn" : "bg-fg/55"}`}
                                  style={{ width: `${Math.max(4, Math.min(100, minPct))}%` }}
                                />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5 pl-1">
                      <button
                        type="button"
                        aria-label="Search models"
                        title="Search models"
                        onClick={() => { setGearOpen(false); setSearchOpen(true); }}
                        className="flex size-[26px] items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
                      >
                        <Icon name="search" size={13} />
                      </button>
                      <button
                        ref={gearButton}
                        type="button"
                        aria-label="Model actions"
                        aria-haspopup="menu"
                        aria-expanded={gearOpen}
                        title="Model settings"
                        onClick={() => setGearOpen((v) => !v)}
                        className={`flex size-[26px] items-center justify-center rounded-md transition-colors ${gearOpen ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}
                      >
                        <Icon name="settings" size={13} />
                      </button>
                    </div>
                  </>
                )}
              </div>

              {gearOpen && (
                <div
                  ref={gearMenu}
                  role="menu"
                  aria-label="Model actions"
                  className="absolute right-2 top-[38px] z-20 w-44 rounded-lg border border-line bg-panel p-1 shadow-xl"
                >
                  {inProject ? (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-fg hover:bg-raised"
                        onClick={() => { setGearOpen(false); setOpen(false); setSetupOpen("models"); }}
                      >
                        Manage models…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-raised hover:text-fg"
                        onClick={() => { setGearOpen(false); setOpen(false); setSetupOpen(true); }}
                      >
                        Manage sign-in…
                      </button>
                    </>
                  ) : (
                    <>
                      <Link
                        to="/settings#models"
                        role="menuitem"
                        className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-fg hover:bg-raised"
                        onClick={() => { setGearOpen(false); setOpen(false); }}
                      >
                        Manage models…
                      </Link>
                      <Link
                        to="/settings#hosts"
                        role="menuitem"
                        className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-raised hover:text-fg"
                        onClick={() => { setGearOpen(false); setOpen(false); }}
                      >
                        Manage sign-in…
                      </Link>
                    </>
                  )}
                  <div className="my-1 border-t border-line/60" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={modelRefresh.busy}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
                    onClick={() => void modelRefresh.refresh()}
                  >
                    <span className={modelRefresh.busy ? "inline-flex animate-spin" : "inline-flex"}>
                      <Icon name="refresh" size={12} />
                    </span>
                    {modelRefresh.busy ? "Refreshing…" : "Refresh models"}
                  </button>
                </div>
              )}

              <div role="radiogroup" aria-label="Models" className="min-h-28 max-h-[min(40vh,17rem)] overflow-y-auto p-1.5">
                {favRows.map(renderModelRow)}
                {favRows.length > 0 && otherRows.length > 0 && (
                  <div className="mx-2 my-1 border-t border-line/50" aria-hidden />
                )}
                {otherRows.map(renderModelRow)}
                {!scoped.length && (
                  <p className="px-2.5 py-3 text-[13px] text-muted">
                    {!query && active === "favorites" ? "Star a model to find it here." : "No matching models."}
                  </p>
                )}
              </div>

              {hasDock && (
                <div className="border-t border-line bg-bg/50">
                  {drawer !== "quota" && effective && hasOptions && !selectedInView && selected && (
                    <div className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-dim">
                      <ProviderIcon id={selected.agent} size={11} />
                      <span className="truncate">{selected.label}</span>
                    </div>
                  )}
                  {drawer === "none" ? (
                    <div className="flex items-center">
                      {effective && hasOptions ? (
                        <button
                          type="button"
                          aria-expanded={false}
                          aria-label={`Tune ${selected?.label ?? "model"} options`}
                          title={efforts.length > 0 ? effortTitle : undefined}
                          onClick={() => { setGearOpen(false); setDrawer("tune"); }}
                          className="group flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-raised/60"
                        >
                          <span className="flex min-w-0 items-center gap-2 text-[12px]">
                            {efforts.length > 0 && (
                              <span className="inline-flex min-w-0 items-center gap-1.5 text-fg/90">
                                <EffortDial level={effortLevel(efforts, dialEffort?.id)} size={13} />
                                <span className="truncate">{effortSummary}</span>
                              </span>
                            )}
                            {efforts.length > 0 && speedOptions.length > 0 && (
                              <span className="text-dim" aria-hidden>·</span>
                            )}
                            {speedOptions.length > 0 && (
                              <span className="inline-flex min-w-0 items-center gap-1 text-muted">
                                <BoltIcon />
                                <span className="truncate">{speedSummary}</span>
                              </span>
                            )}
                          </span>
                          <span className="inline-flex shrink-0 items-center text-muted group-hover:text-fg">
                            <Icon name="down" size={10} />
                          </span>
                        </button>
                      ) : (
                        <span className="flex-1" />
                      )}
                      {effective && hasOptions && quotaPillText && (
                        <span className="my-1.5 w-px self-stretch bg-line/70" aria-hidden="true" />
                      )}
                      {quotaPillText && (
                        <button
                          type="button"
                          aria-expanded={false}
                          aria-label="Subscription quota"
                          data-low={activeQuotaLow ? "true" : "false"}
                          title={activeQuotaProvider ? `${providerShortName(activeQuotaProvider.id)} quota remaining` : "Subscription quota"}
                          onClick={() => { setGearOpen(false); setDrawer("quota"); }}
                          className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-2 text-[11.5px] font-medium tabular-nums transition-colors ${
                            activeQuotaLow
                              ? "bg-warn/10 text-warn hover:bg-warn/15"
                              : "text-muted hover:bg-raised/60 hover:text-fg"
                          }`}
                        >
                          <GaugeIcon size={12} />
                          <span>{quotaPillText}</span>
                          <Icon name="down" size={10} />
                        </button>
                      )}
                    </div>
                  ) : drawer === "tune" && effective && hasOptions ? (
                    // Called, not mounted: the drawer's <div> and its Done button must stay the same elements as the
                    // dock's <div> and Tune button, so React keeps the focused button and only flips aria-expanded.
                    TuneDrawer({
                      efforts,
                      dialEffort,
                      effortSummary,
                      effortValue: effective.effort,
                      speedOptions,
                      activeSpeedId,
                      onEffortChange: (effort) => choose({ effort }),
                      onSpeedChange: (v) => choose({ serviceTier: v || undefined }),
                      onDone: () => setDrawer("none"),
                    })
                  ) : quotaProviders.length > 0 ? (
                    QuotaDetails({
                      quotaProviders,
                      refreshingQuota,
                      onRefresh: () => void refreshQuota({ force: true }),
                      onDone: () => setDrawer("none"),
                    })
                  ) : null}
                </div>
              )}

              <SignInRows agents={needsSignIn} />
              {updateRows}

              {modelRefresh.result !== null && (
                <div className="border-t border-line/60 px-3 py-1.5">
                  <ModelRefreshFeedback action={modelRefresh} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
