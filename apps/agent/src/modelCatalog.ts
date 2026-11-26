import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v3";
import { AgentOptionId, type AgentAvailability, type ModelOptions } from "@scarlet/shared";
import { hasApiKey } from "./detect.js";
import { DEFAULT_GEMINI_EFFORT, findAcpEffortOption, findAcpModelOption, isAcpAuthError } from "./runners/acp.js";
import { stderrTail } from "./logText.js";
import { spawnLines } from "./runners/spawn.js";

export type CliAgent = "claude" | "codex" | "gemini";
/** A model id that is safe to pass to a CLI as a launcher argument. */
export const MODEL_ID = /^[a-z0-9][a-z0-9._:/@+\[\]-]*$/i;
type Catalog = Pick<AgentAvailability, "models" | "model" | "modelLabels" | "modelOptions" | "plan">;

const claudeEnvelope = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.literal("catalog"),
    subtype: z.string().optional(),
    response: z.unknown(),
  }),
});
const claudeCatalog = z.object({ models: z.array(z.object({
  value: z.string(), displayName: z.string(),
  supportsEffort: z.boolean().optional(), supportedEffortLevels: z.array(z.string()).optional(),
  supportsFastMode: z.boolean().optional(),
})) });
const codexPage = z.object({
  data: z.array(z.object({
    model: z.string(), displayName: z.string(), isDefault: z.boolean().optional(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string(), description: z.string().optional() })).optional(),
    defaultReasoningEffort: z.string().nullish(),
    serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })).optional(),
    additionalSpeedTiers: z.array(z.string()).optional(), defaultServiceTier: z.string().nullish(),
  })),
  nextCursor: z.string().nullish(),
});
const acpOptionValue = z.object({
  value: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});
const acpOptionGroup = z.object({
  options: z.array(acpOptionValue),
});
const acpConfigOption = z.object({
  id: z.string().optional(),
  configId: z.string().optional(),
  category: z.string().optional(),
  currentValue: z.string().optional(),
  options: z.array(z.union([acpOptionValue, acpOptionGroup])).optional(),
});
const geminiSession = z.object({
  configOptions: z.array(acpConfigOption).optional(),
  models: z.object({
    currentModelId: z.string().optional(),
    availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })),
  }).optional(),
  _meta: z.object({
    antigravity: z.object({
      tier: z.union([z.string(), z.object({ name: z.string().optional() })]).optional(),
    }).optional(),
  }).optional(),
});
const rpcResponse = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).or(z.unknown()).optional(),
});

function flattenAcpOptions(options: Array<z.infer<typeof acpOptionValue> | z.infer<typeof acpOptionGroup>> | undefined) {
  const flat: Array<z.infer<typeof acpOptionValue>> = [];
  for (const entry of options ?? []) {
    if ("options" in entry) flat.push(...entry.options);
    else flat.push(entry);
  }
  return flat;
}

type ProbeFailure = "initialize_failed" | "request_failed" | "invalid_response" | "repeated_cursor" | "timed_out" | "process_failed" | "incomplete_response";

export class ModelCatalogError extends Error {
  /** How the CLI exited and what it last said on stderr, when it failed: for the host's log. */
  constructor(readonly reason: ProbeFailure, readonly detail?: string) {
    super(reason);
  }
}

/** Ask the installed CLI for its picker catalog without sending a user turn. */
export async function discoverModels(agent: CliAgent, file: string, env: NodeJS.ProcessEnv): Promise<Catalog | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), "scarlet-models-"));
  const names = new Map<string, string>();
  const modelOptions = new Map<string, ModelOptions>();
  let defaultModel: string | undefined;
  let plan: string | undefined;
  const add = (id: string, name: string, options: ModelOptions = { efforts: [], speeds: [] }) => {
    if (id && !MODEL_ID.test(id)) return;
    names.set(id, name || id);
    const efforts = options.efforts.filter(o => AgentOptionId.safeParse(o.id).success);
    const speeds = options.speeds.filter(o => AgentOptionId.safeParse(o.id).success);
    modelOptions.set(id, {
      efforts, speeds,
      defaultEffort: efforts.find(o => o.id === options.defaultEffort)?.id,
      defaultSpeed: speeds.find(o => o.id === options.defaultSpeed)?.id,
    });
  };
  const args = {
    claude: ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"],
    codex: ["app-server", "-c", "analytics.enabled=false"],
    gemini: ["acp", "--disable-telemetry"],
  };
  let requestId = 1;
  let pendingStep: "initialize" | "authenticate" | "session_new" | "model_list" = "initialize";
  let triedApiKeyAuth = false;
  let complete = false;
  let failure: ProbeFailure | undefined;
  const cursors = new Set<string>();
  const hasGeminiApiKey = hasApiKey("gemini", env);
  try {
    const fail = (reason: ProbeFailure) => {
      failure = reason;
      proc.kill();
    };
    const proc = spawnLines(file, args[agent], { cwd, env, timeoutMs: 8000, interactive: true, onLine(line) {
      if (complete || failure) return;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return; }
      if (agent === "claude") {
        const envelope = claudeEnvelope.safeParse(msg);
        if (!envelope.success) return;
        if (envelope.data.response.subtype === "error") return fail("initialize_failed");
        const catalog = claudeCatalog.safeParse(envelope.data.response.response);
        if (!catalog.success) return fail("invalid_response");
        for (const m of catalog.data.models) {
          if (!m.value) continue;
          // Claude's default alias means omitting --model, and has its own capabilities.
          add(m.value === "default" ? "" : m.value, m.displayName, {
            efforts: (m.supportsEffort === false ? [] : m.supportedEffortLevels ?? []).map(id => ({ id })),
            speeds: m.supportsFastMode ? [{ id: "standard", label: "Standard" }, { id: "fast", label: "Fast" }] : [],
          });
        }
      } else {
        const rpc = rpcResponse.safeParse(msg);
        if (!rpc.success || rpc.data.id !== requestId) return;
        if (rpc.data.error || !rpc.data.result) {
          if (agent === "gemini" && pendingStep === "session_new" && !triedApiKeyAuth && hasGeminiApiKey) {
            const errObj = rpc.data.error && typeof rpc.data.error === "object" ? rpc.data.error as { code?: number; message?: string } : undefined;
            if (isAcpAuthError(errObj?.code, String(errObj?.message ?? ""))) {
              triedApiKeyAuth = true;
              pendingStep = "authenticate";
              request("authenticate", { methodId: "gemini-api-key" });
              return;
            }
          }
          return fail(pendingStep === "initialize" ? "initialize_failed" : "request_failed");
        }
        if (pendingStep === "initialize") {
          if (agent === "codex") {
            send({ method: "initialized" });
            pendingStep = "model_list";
            // Codex leaves some models out of its own picker. Scarlet lists every model the CLI offers.
            request("model/list", { includeHidden: true });
          } else {
            pendingStep = "session_new";
            request("session/new", { cwd, mcpServers: [] });
          }
          return;
        }
        if (agent === "gemini" && pendingStep === "authenticate") {
          pendingStep = "session_new";
          request("session/new", { cwd, mcpServers: [] });
          return;
        }
        if (agent === "gemini") {
          const session = geminiSession.safeParse(rpc.data.result);
          if (!session.success) return fail("invalid_response");
          const configs = session.data.configOptions ?? [];
          const modelConfig = findAcpModelOption(configs);
          const thoughtConfig = findAcpEffortOption(configs);
          const thoughtOptions = flattenAcpOptions(thoughtConfig?.options);
          const sharedOptions: ModelOptions = {
            efforts: thoughtOptions.map(o => ({
              id: o.value,
              ...(o.name ? { label: o.name } : {}),
              ...(o.description ? { description: o.description } : {}),
            })),
            speeds: [],
            defaultEffort: thoughtOptions.some(o => o.value === DEFAULT_GEMINI_EFFORT)
              ? DEFAULT_GEMINI_EFFORT
              : thoughtConfig?.currentValue,
          };
          const tier = session.data._meta?.antigravity?.tier;
          const tierName = typeof tier === "string" ? tier : tier?.name;
          if (tierName?.trim()) plan = tierName.trim();
          const configModels = flattenAcpOptions(modelConfig?.options);
          if (configModels.length > 0) {
            for (const m of configModels) if (m.value) add(m.value, m.name ?? m.value, sharedOptions);
            defaultModel = modelConfig?.currentValue;
          } else if (session.data.models) {
            for (const m of session.data.models.availableModels) if (m.modelId) add(m.modelId, m.name, sharedOptions);
            defaultModel = session.data.models.currentModelId;
          } else {
            return fail("invalid_response");
          }
        } else {
          const page = codexPage.safeParse(rpc.data.result);
          if (!page.success) return fail("invalid_response");
          for (const m of page.data.data) {
            if (!m.model) continue;
            add(m.model, m.displayName, {
              efforts: (m.supportedReasoningEfforts ?? []).map(e => ({ id: e.reasoningEffort, description: e.description })),
              speeds: m.serviceTiers?.map(t => ({ id: t.id, label: t.name, description: t.description }))
                ?? (m.additionalSpeedTiers ?? []).map(id => ({ id })),
              defaultEffort: m.defaultReasoningEffort ?? undefined, defaultSpeed: m.defaultServiceTier ?? undefined,
            });
            if (m.isDefault) defaultModel = m.model;
          }
          const cursor = page.data.nextCursor;
          if (cursor) {
            if (cursors.has(cursor)) return fail("repeated_cursor");
            cursors.add(cursor);
            request("model/list", { cursor, includeHidden: true });
            return;
          }
        }
      }
      complete = true;
      proc.child.stdin?.end();
      // The list is read. agy can stay up after its input closes, and would hold detection for the whole time limit.
      proc.kill();
    } });
    function send(message: object) {
      proc.child.stdin?.write(JSON.stringify(agent === "gemini" ? { jsonrpc: "2.0", ...message } : message) + "\n");
    }
    function request(method: string, params: object) { send({ id: ++requestId, method, params }); }
    if (agent === "claude") {
      send({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } });
      proc.child.stdin?.end();
    } else {
      const base = { clientInfo: { name: "scarlet", version: "0.1.4" } };
      const params = agent === "codex"
        ? { ...base, capabilities: { experimentalApi: true } }
        : { protocolVersion: 1, clientCapabilities: {}, ...base };
      send({ id: requestId, method: "initialize", params });
    }
    const outcome = await proc.done;
    if (!complete) {
      const reason = failure ?? (outcome?.timedOut ? "timed_out" : outcome?.code !== 0 ? "process_failed" : "incomplete_response");
      const tail = stderrTail(outcome?.stderr ?? "", 200);
      throw new ModelCatalogError(reason, reason === "process_failed" ? `exit code ${outcome?.code}${outcome?.signal ? ` (signal ${outcome.signal})` : ""}${tail ? `; stderr: ${tail}` : ""}` : undefined);
    }
    return {
      models: [...names.keys()].filter(Boolean), modelLabels: Object.fromEntries(names), modelOptions: Object.fromEntries(modelOptions),
      ...(defaultModel && names.has(defaultModel) ? { model: defaultModel } : {}),
      ...(plan ? { plan } : {}),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
