import { afterEach, expect, it, vi } from "vitest";
import { discoverModels } from "./modelCatalog.js";
import { spawnLines, type SpawnHandle } from "./runners/spawn.js";

vi.mock("./runners/spawn.js", () => ({ spawnLines: vi.fn() }));
afterEach(() => vi.clearAllMocks());

/** Drive the same stdin/stdout exchange on platforms with and without these CLIs installed. */
function peer(reply: (request: Record<string, any>) => unknown) {
  const requests: Array<Record<string, any>> = [];
  vi.mocked(spawnLines).mockImplementation((_file, _args, opts) => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const stdin = {
      write(line: string) {
        const request = JSON.parse(line);
        requests.push(request);
        const response = reply(request);
        if (response) queueMicrotask(() => opts.onLine(JSON.stringify(response)));
      },
      end: finish,
    };
    return { child: { stdin }, done, kill: finish } as unknown as SpawnHandle;
  });
  return requests;
}

it("reads every Codex page, preserves CLI IDs and labels, and includes the ones Codex hides from its own picker", async () => {
  const requests = peer(({ id, method, params }) => {
    if (method === "initialized") return;
    const result = method === "initialize" ? {} : params.cursor
      ? { data: [{ model: "other/model:2", displayName: "Other", additionalSpeedTiers: ["turbo"] }], nextCursor: null }
      : { data: [{ model: "first", displayName: "First", isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "ultra", description: "Think longer" }, { reasoningEffort: "--unsafe" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Higher usage" }], additionalSpeedTiers: ["fast"],
        defaultReasoningEffort: "ultra", defaultServiceTier: "priority" }, { model: "private", displayName: "Private", hidden: true }], nextCursor: "page2" };
    return { id, result };
  });
  expect(await discoverModels("codex", "codex", {})).toEqual({
    model: "first", modelOptions: {
      first: { efforts: [{ id: "ultra", description: "Think longer" }], speeds: [{ id: "priority", label: "Fast", description: "Higher usage" }], defaultEffort: "ultra", defaultSpeed: "priority" },
      private: { efforts: [], speeds: [] },
      "other/model:2": { efforts: [], speeds: [{ id: "turbo" }] },
    },
    models: ["first", "private", "other/model:2"], modelLabels: { first: "First", private: "Private", "other/model:2": "Other" },
  });
  expect(requests.map((r) => r.method)).toEqual(["initialize", "initialized", "model/list", "model/list"]);
  expect(requests.filter((r) => r.method === "model/list").map((r) => r.params.includeHidden)).toEqual([true, true]);
});

it("reads Claude picker aliases from the initialization response", async () => {
  peer((r) => ({ type: "control_response", response: { request_id: r.request_id, response: {
    models: [{ value: "default", displayName: "Default", supportedEffortLevels: ["high"] },
      { value: "sonnet", displayName: "Sonnet 5.5", supportsFastMode: true, supportsEffort: false, supportedEffortLevels: ["low"] }],
  } } }));
  expect(await discoverModels("claude", "claude", {})).toEqual({ models: ["sonnet"], modelLabels: { "": "Default", sonnet: "Sonnet 5.5" },
    modelOptions: { "": { efforts: [{ id: "high" }], speeds: [] }, sonnet: { efforts: [], speeds: [{ id: "standard", label: "Standard" }, { id: "fast", label: "Fast" }] } } });
});

it("reads Gemini ACP session choices and distinguishes an empty list from a failed probe", async () => {
  const requests = peer(({ id, method }) => ({ id, result: method === "initialize" ? {} : { models: { availableModels: [{ modelId: "flash", name: "Flash" }] } } }));
  expect(await discoverModels("gemini", "gemini", {})).toEqual({ models: ["flash"], modelLabels: { flash: "Flash" }, modelOptions: { flash: { efforts: [], speeds: [] } } });
  expect(requests.map((r) => r.method)).toEqual(["initialize", "session/new"]);
  peer(({ id, method }) => ({ id, result: method === "initialize" ? {} : { models: { availableModels: [] } } }));
  expect((await discoverModels("gemini", "gemini", {}))?.models).toEqual([]);
  peer(({ id }) => ({ id, error: { code: -1 } }));
  expect(await discoverModels("gemini", "gemini", {})).toBeUndefined();
});
