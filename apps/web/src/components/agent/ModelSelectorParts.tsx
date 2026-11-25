/**
 * The pieces of the model selector that every place choosing a model shares: the bar of providers with search, the
 * search field, and a model's row. The chat's model button (`AgentChip`) and Task models in Settings
 * (`TaskModelPicker`) draw the same selector from them.
 */
import type { Ref } from "react";
import type { AgentId } from "@scarlet/shared";
import { AGENT_LABEL, type OnlineAgent } from "../../stores/hosts";
import type { ModelChoice } from "../../stores/modelPicker";
import { Icon } from "../ui/primitives";
import { FavoriteButton } from "./FavoriteButton";
import { ProviderIcon, type ModelScope } from "./ModelProviders";
import { LOW_QUOTA_THRESHOLD, formatPercent, isSubscriptionProvider, minRemainingPercent } from "./subscriptionQuota";

/** The rows a scope and a search show, favorites first. A search looks across every provider. */
export function scopeModels(choices: ModelChoice[], favorites: readonly string[], search: string, active: ModelScope) {
  const query = search.trim().toLowerCase();
  const matches = choices.filter((m) => `${AGENT_LABEL[m.agent]} ${m.label} ${m.model ?? ""}`.toLowerCase().includes(query));
  const scoped = query || active === "all" ? matches
    : active === "favorites" ? matches.filter((m) => favorites.includes(m.key))
    : matches.filter((m) => m.agent === active);
  return {
    query,
    scoped,
    favRows: scoped.filter((m) => favorites.includes(m.key)),
    otherRows: scoped.filter((m) => !favorites.includes(m.key)),
    multiProvider: Boolean(query) || active === "all" || active === "favorites",
  };
}

/** The selector's top bar: All, Favorites and a button for each provider, then search, then `children` (the chat's gear). */
export function ModelScopeBar({ providers, agents, active, onScope, onSearch, children }: {
  providers: AgentId[];
  agents: OnlineAgent[];
  active: ModelScope;
  onScope(scope: ModelScope): void;
  onSearch(): void;
  children?: React.ReactNode;
}) {
  return <>
    <div role="group" aria-label="Providers" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      <button
        type="button"
        aria-pressed={active === "all"}
        onClick={() => onScope("all")}
        className={`flex h-[26px] shrink-0 items-center rounded-md px-2 text-[11.5px] font-medium transition-colors ${active === "all" ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
      >
        All
      </button>
      <button
        type="button"
        aria-label="Favorites"
        title="Favorites"
        aria-pressed={active === "favorites"}
        onClick={() => onScope("favorites")}
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
            onClick={() => onScope(id)}
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
        onClick={onSearch}
        className="flex size-[26px] items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
      >
        <Icon name="search" size={13} />
      </button>
      {children}
    </div>
  </>;
}

/** The search that takes the bar's place while it's open. */
export function ModelSearch({ inputRef, value, onChange, onClose }: {
  inputRef: Ref<HTMLInputElement>;
  value: string;
  onChange(value: string): void;
  onClose(): void;
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-2 pl-1 text-muted">
      <Icon name="search" size={13} />
      <input
        type="search"
        ref={inputRef}
        aria-label="Search models"
        placeholder="Search models…"
        className="min-w-0 flex-1 border-b-0 bg-transparent text-[13px] text-fg outline-none placeholder:text-dim"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-label="Close search"
        title="Close search"
        onClick={onClose}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg"
      >
        <Icon name="x" size={12} />
      </button>
    </label>
  );
}

/** One model in the selector: a check when it's the one chosen, its provider's mark across providers, and its star. */
export function ModelRow({ choice, selected, multiProvider, onPick, label, favorite = true }: {
  choice: Pick<ModelChoice, "agent" | "label"> & Partial<ModelChoice>;
  selected: boolean;
  multiProvider: boolean;
  onPick(): void;
  /** What the row says, when it isn't the model's own name. */
  label?: string;
  /** Whether the row has its star. A model that isn't signed in has none. */
  favorite?: boolean;
}) {
  return (
    <div className="group flex items-center rounded-md pr-1 hover:bg-raised">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={`${AGENT_LABEL[choice.agent]} · ${label ?? choice.label}`}
        onClick={onPick}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2.5 pr-1 text-left text-[13px] focus-visible:-outline-offset-2 ${selected ? "font-medium text-fg" : "text-muted group-hover:text-fg"}`}
      >
        <span className="flex w-3 shrink-0 items-center justify-center">
          {selected && <Icon name="check" size={12} />}
        </span>
        {multiProvider && <span className="shrink-0 opacity-85"><ProviderIcon id={choice.agent} size={13} /></span>}
        <span className="truncate">{label ?? choice.label}</span>
      </button>
      {favorite && choice.key && <FavoriteButton choice={choice as ModelChoice} revealOnHover />}
    </div>
  );
}
