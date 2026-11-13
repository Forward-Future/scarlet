import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentId, ModelOptions } from "@scarlet/shared";
import type { OnlineAgent } from "./hosts";

export interface ModelChoice {
  key: string;
  agent: AgentId;
  model?: string;
  name: string;
  label: string;
  defaultEffort?: string;
  profiles: ModelOptions[];
}

export function modelChoices(agents: OnlineAgent[]): ModelChoice[] {
  return agents.flatMap((agent) => {
    return agent.models.map((model) => {
      const info = agent.modelLabels[model ?? ""];
      const name = info?.name ?? model ?? "Provider default";
      const profiles = agent.modelOptions[model ?? ""] ?? [];
      const defaultEffort = profiles[0]?.defaultEffort;
      return {
        key: `${agent.id}:${model ?? ""}`,
        agent: agent.id,
        model,
        name,
        label: info?.custom ? `${name} · Custom` : name,
        defaultEffort: profiles.every(p => p?.defaultEffort === defaultEffort) ? defaultEffort : undefined,
        profiles: profiles.filter(p => p !== undefined),
      };
    });
  });
}

interface ModelPreferences {
  hidden: string[];
  favorites: string[];
  setVisible(keys: string[], visible: boolean): void;
  toggleFavorite(key: string): void;
}

/** Local to this editor's profile. Newly discovered models are visible by default. */
export const useModelPreferences = create<ModelPreferences>()(persist((set) => ({
  hidden: [],
  favorites: [],
  setVisible: (keys, visible) => set((state) => ({
    hidden: visible ? state.hidden.filter((k) => !keys.includes(k)) : [...new Set([...state.hidden, ...keys])],
    favorites: visible ? state.favorites : state.favorites.filter((k) => !keys.includes(k)),
  })),
  toggleFavorite: (key) => set((state) => ({
    favorites: state.favorites.includes(key) ? state.favorites.filter((k) => k !== key) : [...state.favorites, key],
    hidden: state.hidden.filter((k) => k !== key),
  })),
}), { name: "scarlet.modelPicker.v1" }));

export function selectVisibleModel(choices: ModelChoice[], pick: { agent: AgentId; model?: string }, agents: OnlineAgent[]) {
  const forAgent = choices.filter((m) => m.agent === pick.agent);
  const pool = forAgent.length ? forAgent : choices;
  const preferredDefault = agents.find((a) => a.id === pool[0]?.agent)?.defaultModel;
  return forAgent.find((m) => m.model === pick.model)
    ?? pool.find((m) => m.agent === pool[0]?.agent && m.model === preferredDefault)
    ?? pool[0];
}
