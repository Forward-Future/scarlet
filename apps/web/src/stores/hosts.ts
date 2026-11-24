import { create } from "zustand";
import { AGENT_LABEL, type AgentAvailability, type AgentHost, type AgentId, type ModelOptions, type SubscriptionQuota } from "@scarlet/shared";
import { api, errorMessage, IS_MOCK } from "../lib/client";
import { desktop, isDesktop } from "../lib/desktop";
import { changedDuringLoad } from "./changedDuringLoad";

interface HostsState {
  hosts: AgentHost[];
  customOpenaiModels: string[];
  customClaudeModels: string[];
  customGeminiModels: string[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refreshingModels: boolean;
  refreshingQuota: boolean;
  load(): Promise<void>;
  refreshModels(): Promise<void>;
  refreshQuota(opts?: { force?: boolean }): Promise<void>;
  apply(host: AgentHost): void;
}

/** Hosts the socket reported while a read of the list was on its way: they are newer than that read. */
const reports = changedDuringLoad<AgentHost>();
/** Reads overlap (a refresh while the first read is out): the latest one started says how the list stands, and an older one finishing late changes nothing once a newer one has. */
let started = 0;
let shown = 0;
/** A failed read tries again by itself a few times, so one hiccup at launch doesn't leave the Model row connecting. */
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pendingRefresh: Promise<void> | undefined;
let pendingQuotaRefresh: Promise<void> | undefined;

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  customOpenaiModels: [],
  customClaudeModels: [],
  customGeminiModels: [],
  status: "idle",
  error: null,
  refreshingModels: false,
  refreshingQuota: false,
  async load() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    // A list already read stays ready while it is read again, so what waits on it doesn't close and reopen.
    if (get().status !== "ready") set({ status: "loading" });
    const read = reports.begin();
    const seq = ++started;
    try {
      const { hosts } = await api.hosts();
      if (seq < shown) return;
      shown = seq;
      retries = 0;
      set({ hosts: read.merge(hosts), status: "ready", error: null });
    } catch (err) {
      // Only the latest read's failure is the list's: an older one's is stale, and a newer one is still on its way.
      if (seq !== started) return;
      set({ status: "error", error: errorMessage(err) });
      const wait = RETRY_MS[retries++];
      if (wait !== undefined) retryTimer = setTimeout(() => { retryTimer = undefined; if (get().status === "error") void get().load(); }, wait);
    } finally {
      read.end();
    }
  },
  refreshModels() {
    if (pendingRefresh) return pendingRefresh;
    set({ refreshingModels: true });
    pendingRefresh = (async () => {
      let hostError: string | null = null;
      if (!IS_MOCK) {
        const host = await desktop.hostRefreshAgents();
        hostError = host.error;
        const { customOpenaiModels, customClaudeModels, customGeminiModels } = await desktop.info();
        set({
          customOpenaiModels: customOpenaiModels ?? [],
          customClaudeModels: customClaudeModels ?? [],
          customGeminiModels: customGeminiModels ?? [],
        });
      }
      // A provider can fail while other providers publish new models.
      await get().load();
      const error = hostError ?? get().error;
      if (error) throw new Error(error);
    })().finally(() => {
      pendingRefresh = undefined;
      set({ refreshingModels: false });
    });
    return pendingRefresh;
  },
  refreshQuota(opts) {
    if (IS_MOCK) return Promise.resolve();
    const force = Boolean(opts?.force);
    if (pendingQuotaRefresh) return pendingQuotaRefresh;
    set({ refreshingQuota: true });
    pendingQuotaRefresh = (async () => {
      try {
        if (isDesktop()) {
          const status = await desktop.hostRefreshQuota(force);
          if (status?.hostId && Array.isArray(status.agents)) {
            const hosts = get().hosts;
            if (hosts.some((h) => h.id === status.hostId)) {
              set({
                hosts: hosts.map((h) => (h.id === status.hostId ? { ...h, agents: status.agents } : h)),
              });
            }
          }
        } else {
          await api.refreshHostQuota(force);
        }
      } catch {
        // Quota refresh is strictly best-effort and never blocks or errors the picker.
      }
    })().finally(() => {
      pendingQuotaRefresh = undefined;
      set({ refreshingQuota: false });
    });
    return pendingQuotaRefresh;
  },
  apply(host) {
    reports.set(host.id, host);
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
  auth?: AgentAvailability["auth"];
  plan?: string;
  quota?: SubscriptionQuota;
}

export const isConfiguredAgent = (agent: AgentAvailability) => agent.id !== "api" && agent.installed && agent.loggedIn !== false;

function isNewerQuota(next: SubscriptionQuota, prev?: SubscriptionQuota): boolean {
  if (!prev) return true;
  const nextMs = Date.parse(next.fetchedAt);
  const prevMs = Date.parse(prev.fetchedAt);
  if (!Number.isFinite(nextMs)) return false;
  if (!Number.isFinite(prevMs)) return true;
  return nextMs >= prevMs;
}

/** Agents that are installed and logged in on at least one online host. */
export function onlineAgents(
  hosts: AgentHost[],
  customOpenaiModels: readonly string[] = [],
  customClaudeModels: readonly string[] = [],
  customGeminiModels: readonly string[] = [],
): OnlineAgent[] {
  // Every model a CLI offers is listed, including ones its own picker hides.
  const map = new Map<AgentId, OnlineAgent>();
  for (const h of hosts) {
    if (!h.online) continue;
    for (const a of h.agents) {
      if (!isConfiguredAgent(a)) continue;
      const cur: OnlineAgent = map.get(a.id) ?? { id: a.id, models: [], modelLabels: Object.create(null), modelOptions: Object.create(null), hostNames: [] };
      for (const id of a.models ?? []) {
        const label = a.modelLabels?.[id] ?? id;
        const custom =
          (a.id === "codex" && customOpenaiModels.includes(id))
          || (a.id === "claude" && customClaudeModels.includes(id))
          || (a.id === "gemini" && customGeminiModels.includes(id));
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
      if (a.auth === "subscription") cur.auth = "subscription";
      else if (a.auth && !cur.auth) cur.auth = a.auth;
      if (a.auth !== "api_key") {
        const plan = a.plan ?? a.quota?.plan;
        if (plan && !cur.plan) cur.plan = plan;
        if (a.quota && isNewerQuota(a.quota, cur.quota)) cur.quota = a.quota;
      }
      cur.hostNames.push(h.name);
      map.set(a.id, cur);
    }
  }
  return [...map.values()];
}

export { AGENT_LABEL };
