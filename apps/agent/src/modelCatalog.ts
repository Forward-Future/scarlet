import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v3";
import { AgentOptionId, type AgentAvailability, type ModelOptions } from "@scarlet/shared";
import { spawnLines } from "./runners/spawn.js";

export type CliAgent = "claude" | "codex" | "gemini";
type Catalog = Pick<AgentAvailability, "models" | "model" | "modelLabels" | "modelOptions">;

const claudeResponse = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.literal("catalog"),
    response: z.object({ models: z.array(z.object({
      value: z.string(), displayName: z.string(),
      supportsEffort: z.boolean().optional(), supportedEffortLevels: z.array(z.string()).optional(),
      supportsFastMode: z.boolean().optional(),
    })) }),
  }),
});
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
const geminiSession = z.object({
  models: z.object({ currentModelId: z.string().optional(), availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })) }),
});
const rpcResponse = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });

/** Ask the installed CLI for its picker catalog without sending a user turn. */
export async function discoverModels(agent: CliAgent, file: string, env: NodeJS.ProcessEnv): Promise<Catalog | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), "scarlet-models-"));
  const names = new Map<string, string>();
  const modelOptions = new Map<string, ModelOptions>();
  let defaultModel: string | undefined;
  const add = (id: string, name: string, options: ModelOptions = { efforts: [], speeds: [] }) => {
    if (id && !/^[a-z0-9][a-z0-9._:/@+\[\]-]*$/i.test(id)) return;
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
    codex: ["app-server"],
    gemini: ["--acp", "--extensions", "none", "--allowed-mcp-server-names", "scarlet-catalog"],
  };
  let requestId = 1;
  let complete = false;
  const cursors = new Set<string>();
  try {
    const proc = spawnLines(file, args[agent], { cwd, env, timeoutMs: 8000, interactive: true, onLine(line) {
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return; }
      if (agent === "claude") {
        const response = claudeResponse.safeParse(msg);
        if (!response.success) return;
        for (const m of response.data.response.response.models) {
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
        if (rpc.data.error || !rpc.data.result) return proc.kill();
        if (requestId === 1) {
          if (agent === "codex") send({ method: "initialized" });
          // Codex leaves some models out of its own picker. Scarlet lists every model the CLI offers.
          request(agent === "codex" ? "model/list" : "session/new", agent === "codex" ? { includeHidden: true } : { cwd, mcpServers: [] });
          return;
        }
        if (agent === "gemini") {
          const session = geminiSession.safeParse(rpc.data.result);
          if (!session.success) return proc.kill();
          for (const m of session.data.models.availableModels) if (m.modelId) add(m.modelId, m.name);
          defaultModel = session.data.models.currentModelId;
        } else {
          const page = codexPage.safeParse(rpc.data.result);
          if (!page.success) return proc.kill();
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
            if (cursors.has(cursor)) return proc.kill();
            cursors.add(cursor);
            request("model/list", { cursor, includeHidden: true });
            return;
          }
        }
      }
      complete = true;
      proc.child.stdin?.end();
    } });
    function send(message: object) {
      proc.child.stdin?.write(JSON.stringify(agent === "gemini" ? { jsonrpc: "2.0", ...message } : message) + "\n");
    }
    function request(method: string, params: object) { send({ id: ++requestId, method, params }); }
    if (agent === "claude") {
      send({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } });
      proc.child.stdin?.end();
    } else {
      const params = agent === "codex"
        ? { clientInfo: { name: "scarlet", version: "0.1.0" }, capabilities: { experimentalApi: true } }
        : { protocolVersion: 1, clientCapabilities: {} };
      send({ id: requestId, method: "initialize", params });
    }
    await proc.done;
    if (complete) return {
      models: [...names.keys()].filter(Boolean), modelLabels: Object.fromEntries(names), modelOptions: Object.fromEntries(modelOptions),
      ...(defaultModel && names.has(defaultModel) ? { model: defaultModel } : {}),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
