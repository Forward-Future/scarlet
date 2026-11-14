import { create } from "zustand";
import { AGENT_LABEL, type AgentAvailability, type AgentHost, type AgentId, type ModelOptions } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";

interface HostsState {
  hosts: AgentHost[];
  customOpenaiModels: string[];
  customClaudeModels: string[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load(): Promise<void>;
  apply(host: AgentHost): void;
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  customOpenaiModels: [],
  customClaudeModels: [],
  status: "idle",
  error: null,
  async load() {
    set({ status: "loading" });
    try {
      const { hosts } = await api.hosts();
      set({ hosts, status: "ready", error: null });
    } catch (err) {
      set({ status: "error", error: errorMessage(err) });
    }
  },
  apply(host) {
    const hosts = get().hosts.filter((h) => h.id !== host.id);
    set({ hosts: [...hosts, host] });
  },
}));

export interface OnlineAgent {
  id: AgentId;
  models: string[];
  modelLabels: Record<string, { name: string; custom: boolean }>;
  modelOptions: Record<string, (ModelOptions | undefined)[]>;
  defaultModel?: string;
  hostNames: string[];
}

export const isConfiguredAgent = (agent: AgentAvailability) => agent.id !== "api" && agent.installed && agent.loggedIn !== false;

/** Agents that are installed and logged in on at least one online host. */
export function onlineAgents(hosts: AgentHost[], customOpenaiModels: readonly string[] = [], customClaudeModels: readonly string[] = []): OnlineAgent[] {
  // Every model a CLI offers is listed, including ones its own picker hides.
  const map = new Map<AgentId, OnlineAgent>();
  for (const h of hosts) {
    if (!h.online) continue;
    for (const a of h.agents) {
      if (!isConfiguredAgent(a)) continue;
      const cur: OnlineAgent = map.get(a.id) ?? { id: a.id, models: [], modelLabels: Object.create(null), modelOptions: Object.create(null), hostNames: [] };
      for (const id of a.models ?? []) {
        const label = a.modelLabels?.[id] ?? id;
        const custom = (a.id === "codex" && customOpenaiModels.includes(id)) || (a.id === "claude" && customClaudeModels.includes(id));
        if (!cur.models.includes(id)) cur.models.push(id);
        cur.modelLabels[id] ??= { name: label, custom };
        (cur.modelOptions[id] ??= []).push(a.modelOptions?.[id]);
      }
      // Either the CLI advertised its default or the host confirmed sign-in without a named catalog.
      if (a.id === "claude" && !a.models?.length && (a.loggedIn || a.modelOptions?.[""] || a.modelLabels?.[""])) {
        // With no model in the request, the host uses its configured model or the CLI default.
        const model = a.model ?? "";
        const label = a.modelLabels?.[model];
        if (label) cur.modelLabels[""] ??= { name: label, custom: false };
        (cur.modelOptions[""] ??= []).push(a.modelOptions?.[model]);
      }
      if (a.model && cur.models.includes(a.model)) cur.defaultModel ??= a.model;
      cur.hostNames.push(h.name);
      map.set(a.id, cur);
    }
  }
  return [...map.values()];
}

export { AGENT_LABEL };
