/** The agent runtimes Scarlet runs requests on, the hosts that run them, and the model options the editor picks. */
import { z } from "zod/v3";
import { Id } from "@scarlet/timeline";

/** Provider option IDs are also passed as CLI arguments on Windows. */
export const AgentOptionId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
export const AgentEffort = AgentOptionId;

export const ModelTuning = z.object({
  effort: AgentEffort.optional(),
  serviceTier: AgentOptionId.optional(),
});

/** Known agent runtimes. Hosts report which are installed and logged in. */
export const AgentId = z.enum(["claude", "codex", "gemini", "api"]);
export type AgentId = z.infer<typeof AgentId>;

/** What each agent is called, in the interface and in the sentences the engine keeps in a project's history. */
export const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  api: "API",
};

/** Note assignments accept an agent alone or an agent and an exact CLI model ID. */
export function agentTarget(agent: AgentId, model?: string): string {
  return model ? `${agent}:${model}` : agent;
}

export function splitAgentTarget(value: string) {
  const sep = value.search(/[:/]/);
  return sep < 0 ? { agent: value, model: undefined } : { agent: value.slice(0, sep), model: value.slice(sep + 1) || undefined };
}

const ModelOption = z.object({ id: AgentOptionId, label: z.string().optional(), description: z.string().optional() });
export const ModelOptions = z.object({
  efforts: z.array(ModelOption),
  speeds: z.array(ModelOption),
  defaultEffort: AgentOptionId.optional(),
  defaultSpeed: AgentOptionId.optional(),
});
export type ModelOptions = z.infer<typeof ModelOptions>;
export type AgentEffort = z.infer<typeof AgentEffort>;

export const QuotaBucket = z.object({
  id: z.string(),
  /** Short human label for the bucket (e.g. "5-hour", "Weekly", "Gemini · 5h"). */
  label: z.string(),
  /** Window identifier when known (e.g. "5h", "weekly"). */
  window: z.string().optional(),
  /** Percentage of quota remaining, 0..100. */
  remainingPercent: z.number().min(0).max(100),
  /** ISO-8601 timestamp when this bucket resets, if reported. */
  resetsAt: z.string().optional(),
});
export type QuotaBucket = z.infer<typeof QuotaBucket>;

export const SubscriptionQuota = z.object({
  /** Subscription plan/tier label when reported by the CLI (e.g. "Max", "Pro", "Google AI Ultra"). */
  plan: z.string().optional(),
  /** Remaining quota buckets for this subscription provider. */
  buckets: z.array(QuotaBucket),
  /** True when the provider reports unlimited credits instead of metered buckets. */
  unlimited: z.boolean().optional(),
  /** ISO-8601 timestamp when this snapshot was read. */
  fetchedAt: z.string(),
});
export type SubscriptionQuota = z.infer<typeof SubscriptionQuota>;

export const AgentAvailability = z.object({
  id: AgentId,
  installed: z.boolean(),
  loggedIn: z.boolean().optional(),
  /** How the CLI is signed in: its own subscription (Claude Pro/Max, ChatGPT plan) or an API key. */
  auth: z.enum(["subscription", "api_key"]).optional(),
  /** Subscription tier when the CLI reports it (e.g. "max", "pro"). */
  plan: z.string().optional(),
  version: z.string().optional(),
  /** A newer published version of the CLI that the desktop app can update it to in place. */
  latestVersion: z.string().optional(),
  /** Model override the host will pass to the CLI (e.g. "opus", "gpt-5-codex"). */
  model: z.string().optional(),
  models: z.array(z.string()).optional(),
  /** Provider display names keyed by the model ID passed to the CLI. */
  modelLabels: z.record(z.string()).optional(),
  modelOptions: z.record(ModelOptions).optional(),
  /** Live subscription quota remaining. Omitted when using API-key auth or unavailable. */
  quota: SubscriptionQuota.optional(),
});
export type AgentAvailability = z.infer<typeof AgentAvailability>;

export const AgentHost = z.object({
  id: Id,
  userId: Id,
  name: z.string(),
  platform: z.string(),
  agents: z.array(AgentAvailability),
  online: z.boolean(),
  lastSeenAt: z.string().datetime().optional(),
});
export type AgentHost = z.infer<typeof AgentHost>;

export const RegisterHostRequest = z.object({
  name: z.string(),
  platform: z.string(),
  agents: z.array(AgentAvailability),
});
export type RegisterHostRequest = z.infer<typeof RegisterHostRequest>;

/** The agent and model the editor chose for a run, as the message box sends it. */
export const RunChoice = z.object({
  agent: AgentId.optional(),
  model: z.string().optional(),
  effort: AgentEffort.optional(),
  fast: z.boolean().optional(),
  serviceTier: AgentOptionId.optional(),
});
export type RunChoice = z.infer<typeof RunChoice>;
