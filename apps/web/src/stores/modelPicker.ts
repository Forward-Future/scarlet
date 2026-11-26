import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { AgentEffort, AgentId, ModelOptions } from "@scarlet/shared";
import type { OnlineAgent } from "./hosts";

export interface ModelChoice {
  key: string;
  agent: AgentId;
  model?: string;
  name: string;
  label: string;
  custom?: boolean;
  defaultEffort?: string;
  profiles: ModelOptions[];
}

export interface ModelTuning {
  effort?: AgentEffort;
  serviceTier?: string;
}

function modelKey(agent: AgentId, model?: string): string {
  return `${agent}:${model ?? ""}`;
}

export function modelChoices(agents: OnlineAgent[]): ModelChoice[] {
  return agents.flatMap((agent) => {
    // Choose the provider default only when no host offers a named model, before applying visibility preferences.
    const models = !agent.models.length && agent.modelOptions[""] ? [undefined] : agent.models;
    return models.map((model) => {
      // A request without a model can reach hosts with different local defaults.
      const info = model === undefined && agent.hostNames.length > 1 ? undefined : agent.modelLabels[model ?? ""];
      const name = info?.name ?? model ?? "Provider default";
      const profiles = agent.modelOptions[model ?? ""] ?? [];
      const defaultEffort = profiles[0]?.defaultEffort;
      return {
        key: modelKey(agent.id, model),
        agent: agent.id,
        model,
        name,
        label: info?.custom ? `${name} · Custom` : name,
        custom: info?.custom || undefined,
        defaultEffort: profiles.every(p => p?.defaultEffort === defaultEffort) ? defaultEffort : undefined,
        profiles: profiles.filter(p => p !== undefined),
      };
    });
  });
}

const safeStorage: StateStorage = {
  getItem: (name) => {
    try { return globalThis.localStorage?.getItem(name) ?? null; } catch { return null; }
  },
  setItem: (name, value) => {
    try { globalThis.localStorage?.setItem(name, value); } catch { /* WebView storage may be full or unavailable */ }
  },
  removeItem: (name) => {
    try { globalThis.localStorage?.removeItem(name); } catch { /* ignore */ }
  },
};

interface ModelPreferences {
  hidden: string[];
  /** Models of a provider whose list is opt-in (`OPT_IN_PROVIDERS`) that the editor chose to show. */
  shown: string[];
  favorites: string[];
  /** Last remembered effort & speed per model key (`${agent}:${model ?? ""}`). */
  tuningByModel: Record<string, ModelTuning>;
  setVisible(keys: string[], visible: boolean): void;
  toggleFavorite(key: string): void;
  setModelTuning(key: string, tuning: ModelTuning): void;
}

/**
 * Providers that offer hundreds of models: their models stay out of the selector until the editor shows the ones they
 * want in Settings › Models (or stars one).
 */
export const OPT_IN_PROVIDERS: readonly AgentId[] = ["openrouter"];

/**
 * Current frontier models recommended for editing, enabled out of the box for each CLI provider.
 * All other models from these providers stay disabled until turned on in Settings › Models (or starred),
 * unless a provider's catalog has none of these recommended models (e.g. an older CLI).
 */
export const RECOMMENDED_MODELS: Partial<Record<AgentId, readonly string[]>> = {
  claude: ["opus", "fable"],
  codex: ["gpt-6.2-sol", "gpt-6.2-astra"],
  gemini: ["gemini-4-neon"],
};

const agentOfKey = (key: string) => key.slice(0, Math.max(0, key.indexOf(":"))) as AgentId;
const modelOfKey = (key: string) => {
  const sep = key.indexOf(":");
  return sep >= 0 ? key.slice(sep + 1) : "";
};
const optInProvider = (key: string) => OPT_IN_PROVIDERS.includes(agentOfKey(key));

/** Whether a model key matches a provider's recommended frontier defaults (including context-window suffixes like `[1m]`). */
export function isRecommendedModel(key: string): boolean {
  const agent = agentOfKey(key);
  const recommended = RECOMMENDED_MODELS[agent];
  if (!recommended) return false;
  const model = modelOfKey(key);
  if (!model) return true; // Provider default when no named models are advertised.
  const base = model.replace(/\[[^\]]+\]$/, "");
  return recommended.includes(model) || recommended.includes(base);
}

/** Whether a model key is disabled by default until explicitly shown or starred. */
function defaultHiddenKey(key: string): boolean {
  if (optInProvider(key)) return true;
  const agent = agentOfKey(key);
  return Boolean(RECOMMENDED_MODELS[agent]) && !isRecommendedModel(key);
}

/** Whether `choices` for `agent` includes at least one recommended frontier model. */
export function providerHasRecommendedModels(choices: readonly Pick<ModelChoice, "agent" | "key">[], agent: AgentId): boolean {
  if (!RECOMMENDED_MODELS[agent]) return false;
  return choices.some(c => c.agent === agent && isRecommendedModel(c.key));
}

/** Whether the model with this key is left out of the selector. */
export function isModelHidden(
  prefs: Pick<ModelPreferences, "hidden" | "shown" | "favorites">,
  key: string,
  opts?: { custom?: boolean; providerHasRecommended?: boolean },
): boolean {
  if (prefs.favorites.includes(key)) return false;
  if (prefs.hidden.includes(key)) return true;
  if (prefs.shown.includes(key)) return false;
  if (opts?.custom) return false;
  if (optInProvider(key)) return true;
  if (RECOMMENDED_MODELS[agentOfKey(key)]) {
    if (isRecommendedModel(key)) return false;
    if (opts?.providerHasRecommended === false) return false;
    return true;
  }
  return false;
}

/** Whether a model choice is hidden, accounting for custom models and whether its provider advertises recommended defaults. */
export function isChoiceHidden(
  prefs: Pick<ModelPreferences, "hidden" | "shown" | "favorites">,
  choice: Pick<ModelChoice, "agent" | "key" | "custom">,
  allChoices: readonly Pick<ModelChoice, "agent" | "key">[],
): boolean {
  return isModelHidden(prefs, choice.key, {
    custom: choice.custom,
    providerHasRecommended: providerHasRecommendedModels(allChoices, choice.agent),
  });
}

/** Local to this editor's profile. Frontier defaults and local models show by default; other models are opt-in. */
export const useModelPreferences = create<ModelPreferences>()(persist((set) => ({
  hidden: [],
  shown: [],
  favorites: [],
  tuningByModel: {},
  setVisible: (keys, visible) => set((state) => {
    const shownKeys = keys.filter(defaultHiddenKey);
    const hideableKeys = keys.filter(k => !optInProvider(k));
    return {
      hidden: visible ? state.hidden.filter((k) => !keys.includes(k)) : [...new Set([...state.hidden, ...hideableKeys])],
      shown: visible ? [...new Set([...state.shown, ...shownKeys])] : state.shown.filter((k) => !keys.includes(k)),
      favorites: visible ? state.favorites : state.favorites.filter((k) => !keys.includes(k)),
    };
  }),
  toggleFavorite: (key) => set((state) => ({
    favorites: state.favorites.includes(key) ? state.favorites.filter((k) => k !== key) : [...state.favorites, key],
    hidden: state.hidden.filter((k) => k !== key),
  })),
  setModelTuning: (key, tuning) => set((state) => {
    const clean: ModelTuning = {};
    if (tuning.effort) clean.effort = tuning.effort;
    if (tuning.serviceTier) clean.serviceTier = tuning.serviceTier;
    return { tuningByModel: { ...state.tuningByModel, [key]: clean } };
  }),
}), { name: "scarlet.modelPicker.v1", storage: createJSONStorage(() => safeStorage) }));

export function selectVisibleModel(choices: ModelChoice[], pick: { agent: AgentId; model?: string }, agents: OnlineAgent[]) {
  const forAgent = choices.filter((m) => m.agent === pick.agent);
  const pool = forAgent.length ? forAgent : choices;
  const preferredDefault = agents.find((a) => a.id === pool[0]?.agent)?.defaultModel;
  return forAgent.find((m) => m.model === pick.model)
    ?? pool.find((m) => m.agent === pool[0]?.agent && m.model === preferredDefault)
    ?? pool[0];
}
