/**
 * The extra model providers: Ollama and LM Studio, which run models on this computer, and OpenRouter, which routes to
 * many hosted models. None is a harness of its own: each run goes through Claude Code pointed at the provider's
 * Anthropic-compatible endpoint. This file says where each provider is, whether it is up and which models it has,
 * and the environment that points Claude Code at it.
 */
import { AGENT_LABEL, PROVIDER_DEFAULT_URL, sideCheckSlots, type AgentAvailability, type AgentId, type ExtraProvider } from "@scarlet/shared";
import type { ProvidersConfig } from "./config.js";
import { MODEL_ID } from "./modelCatalog.js";

export type FetchFn = typeof fetch;

/** How long one probe of a provider may take, so a provider that is down never holds up the CLI checks. */
export const PROBE_TIMEOUT_MS = 2500;

/** The two providers that run models on this computer. */
export const LOCAL_PROVIDERS = ["ollama", "lmstudio"] as const satisfies readonly ExtraProvider[];

export function isLocalProvider(agent: string): boolean {
  return (LOCAL_PROVIDERS as readonly string[]).includes(agent);
}

/** Where each provider is, as agent.json and the environment set it up. */
export interface ResolvedProviders {
  ollama: { url: string; disabled: boolean };
  lmstudio: { url: string; disabled: boolean };
  openrouter: { url: string; apiKey?: string; disabled: boolean };
}

const DEFAULT_PORT = { ollama: 11434, lmstudio: 1234 } as const;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/**
 * A local server's address as Ollama reads OLLAMA_HOST: `host:port`, a bare host, `0.0.0.0` or a full URL. With no
 * scheme it is http on the default port; `0.0.0.0` (listen everywhere) is reached on 127.0.0.1. Undefined when it
 * isn't an address at all.
 */
export function normalizeHost(value: string | undefined, defaultPort: number): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const candidate = hasScheme ? raw : raw.startsWith(":") ? `http://127.0.0.1${raw}` : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
  // With a scheme the scheme's own port applies, as in Ollama; without one, the provider's.
  if (!hasScheme && !url.port) url.port = String(defaultPort);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${url.origin}${path}`;
}

/** Each provider's address, key and switch: agent.json first, then the environment, then the default. */
export function resolveProviders(config: ProvidersConfig | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedProviders {
  const local = (id: "ollama" | "lmstudio", envVar: string) => {
    const own = config?.[id];
    return {
      url: normalizeHost(own?.url, DEFAULT_PORT[id]) ?? normalizeHost(env[envVar], DEFAULT_PORT[id]) ?? PROVIDER_DEFAULT_URL[id],
      disabled: own?.disabled === true,
    };
  };
  const apiKey = text(config?.openrouter?.apiKey) ?? text(env.OPENROUTER_API_KEY);
  return {
    ollama: local("ollama", "OLLAMA_HOST"),
    lmstudio: local("lmstudio", "LMSTUDIO_HOST"),
    openrouter: { url: PROVIDER_DEFAULT_URL.openrouter, ...(apiKey ? { apiKey } : {}), disabled: config?.openrouter?.disabled === true },
  };
}

// -- detection --------------------------------------------------------------

interface Reply {
  status: number;
  ok: boolean;
  body: unknown;
}

/** One request with its own deadline. Undefined when the server can't be reached or didn't answer in time. */
async function request(fetchFn: FetchFn, url: string, init: RequestInit = {}): Promise<Reply | undefined> {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, ok: res.ok, body };
  } catch {
    return undefined;
  }
}

const list = (body: unknown, key: string): unknown[] => {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value : [];
};
const field = (item: unknown, key: string) => (item && typeof item === "object" ? text((item as Record<string, unknown>)[key]) : undefined);

/** A reachable provider as the host reports it: its models, by the IDs passed to Claude Code, with no effort or speed. */
function ready(id: ExtraProvider, models: Array<{ id: string; label?: string }>, extra: Partial<AgentAvailability> = {}): AgentAvailability {
  const usable = models.filter((m, i) => MODEL_ID.test(m.id) && models.findIndex((n) => n.id === m.id) === i);
  return {
    id,
    installed: true,
    loggedIn: true,
    ...extra,
    models: usable.map((m) => m.id),
    modelLabels: Object.fromEntries(usable.map((m) => [m.id, m.label ?? m.id])),
    modelOptions: Object.fromEntries(usable.map((m) => [m.id, { efforts: [], speeds: [] }])),
  };
}

/** Ollama's models that can call tools; an Ollama from before `capabilities` keeps all but embedding models. */
export async function detectOllama(url: string, fetchFn: FetchFn): Promise<AgentAvailability> {
  const [tags, version] = await Promise.all([request(fetchFn, `${url}/api/tags`), request(fetchFn, `${url}/api/version`)]);
  if (!tags?.ok) return { id: "ollama", installed: false };
  const names = list(tags.body, "models").map((m) => field(m, "name")).filter((n): n is string => !!n);
  const kept = await Promise.all(names.map(async (name) => {
    const show = await request(fetchFn, `${url}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }) });
    const caps = show?.ok ? list(show.body, "capabilities") : undefined;
    const hasCaps = !!show?.ok && Array.isArray((show.body as { capabilities?: unknown } | undefined)?.capabilities);
    return (hasCaps ? caps!.includes("tools") : !/embed/i.test(name)) ? name : undefined;
  }));
  const v = field(version?.body, "version");
  return ready("ollama", kept.filter((n): n is string => !!n).map((id) => ({ id })), v ? { version: v } : {});
}

/** LM Studio's language models, from its own list when it has one, else the OpenAI-style list without embedding models. */
export async function detectLmStudio(url: string, fetchFn: FetchFn): Promise<AgentAvailability> {
  const own = await request(fetchFn, `${url}/api/v0/models`);
  if (own?.ok) {
    const ids = list(own.body, "data").filter((m) => ["llm", "vlm"].includes(field(m, "type") ?? "")).map((m) => field(m, "id"));
    return ready("lmstudio", ids.filter((id): id is string => !!id).map((id) => ({ id })));
  }
  const openai = await request(fetchFn, `${url}/v1/models`);
  if (!openai?.ok) return { id: "lmstudio", installed: false };
  const ids = list(openai.body, "data").map((m) => field(m, "id")).filter((id): id is string => !!id && !/embed/i.test(id));
  return ready("lmstudio", ids.map((id) => ({ id })));
}

/** OpenRouter's models that can call tools, and whether it takes the key. The key goes only in the header. */
export async function detectOpenRouter(apiKey: string, fetchFn: FetchFn): Promise<AgentAvailability> {
  const [models, key] = await Promise.all([
    request(fetchFn, "https://openrouter.ai/api/v1/models?supported_parameters=tools"),
    request(fetchFn, "https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${apiKey}` } }),
  ]);
  if (!models?.ok) return { id: "openrouter", installed: false };
  const entries = list(models.body, "data").flatMap((m) => {
    const id = field(m, "id");
    return id ? [{ id, label: field(m, "name") }] : [];
  });
  const refused = key?.status === 401 || key?.status === 403;
  return ready("openrouter", entries, { auth: "api_key", ...(refused ? { loggedIn: false } : {}) });
}

/**
 * One entry per provider, in order ollama, lmstudio, openrouter, probed together. A provider switched off, out of
 * reach or (OpenRouter) without a key is not installed; so is each when Claude Code, which runs them, is missing.
 */
export async function detectProviders(providers: ResolvedProviders, fetchFn: FetchFn, claudeInstalled: boolean | Promise<boolean>): Promise<AgentAvailability[]> {
  const off = (id: ExtraProvider): AgentAvailability => ({ id, installed: false });
  const { ollama, lmstudio, openrouter } = providers;
  const probes = await Promise.all([
    ollama.disabled ? off("ollama") : detectOllama(ollama.url, fetchFn).catch(() => off("ollama")),
    lmstudio.disabled ? off("lmstudio") : detectLmStudio(lmstudio.url, fetchFn).catch(() => off("lmstudio")),
    openrouter.disabled || !openrouter.apiKey ? off("openrouter") : detectOpenRouter(openrouter.apiKey, fetchFn).catch(() => off("openrouter")),
  ]);
  return (await claudeInstalled) ? probes : probes.map((p) => off(p.id as ExtraProvider));
}

// -- claiming ---------------------------------------------------------------

/**
 * Tasks a runtime may run at once on this host, requests and side checks in their own slots. A model on this computer
 * runs one of each at a time: a second would share the same machine's memory and slow both. Side checks keep a slot of
 * their own so a request waiting on its own check never waits behind itself.
 */
export function parallelLimits(agent: AgentId, maxParallel: number): { tasks: number; checks: number } {
  return isLocalProvider(agent) ? { tasks: 1, checks: 1 } : { tasks: maxParallel, checks: sideCheckSlots(maxParallel) };
}

// -- running ----------------------------------------------------------------

/** Variables that would send Claude Code to Anthropic's own sign-in or to a cloud instead of the provider. */
const ROUTING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
];

/** Claude Code's model variables: every tier and its subagents use the one model the editor chose. */
const MODEL_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/**
 * The environment that points Claude Code at a provider, built on the run's own: the provider's address and token,
 * an empty API key (so `--bare` stays off), no Anthropic sign-in or cloud, and the chosen model for every tier.
 * `settingsEnv` repeats all of it but the token for Claude Code's `--settings` flag, which outranks an `env` block in
 * the user's own settings; the token stays out of it, as the flag is on the command line.
 * An error in plain words when the run can't start: no model chosen, or no OpenRouter key.
 */
export function providerRunEnv(
  agent: ExtraProvider,
  model: string | undefined,
  base: NodeJS.ProcessEnv,
  providers: ResolvedProviders,
): { env: NodeJS.ProcessEnv; settingsEnv: Record<string, string> } | { error: string } {
  const token = agent === "openrouter" ? providers.openrouter.apiKey : agent;
  if (!token) return { error: "Add an OpenRouter key to use OpenRouter." };
  if (!model) return { error: `Choose a model for ${AGENT_LABEL[agent]} first.` };
  const settingsEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: providers[agent].url,
    ANTHROPIC_API_KEY: "",
    ...Object.fromEntries(MODEL_VARS.map((name) => [name, model])),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  };
  const drop = new Set([...ROUTING_VARS, ...MODEL_VARS]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(base).filter(([k]) => !drop.has(k.toUpperCase())));
  Object.assign(env, settingsEnv, { ANTHROPIC_AUTH_TOKEN: token });
  return { env, settingsEnv };
}
