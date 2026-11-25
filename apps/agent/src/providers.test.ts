import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { detect, formatAvailability, type ExecFn } from "./detect.js";
import { claimableAgents } from "./host.js";
import {
  detectLmStudio, detectOllama, detectOpenRouter, detectProviders, normalizeHost, parallelLimits, providerRunEnv, resolveProviders,
  type FetchFn,
} from "./providers.js";
import { buildClaudeCommand, runAgent, RUNNERS, runnerFor } from "./runners/index.js";
import type { RunAgentOptions } from "./runners/types.js";

/** A stand-in for the network: each route's JSON reply (or status), and a note of every request made. */
function fakeFetch(routes: Record<string, unknown | ((init: RequestInit | undefined) => unknown)>, seen: Array<{ url: string; init?: RequestInit }> = []): FetchFn {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const key = init?.method === "POST" ? `POST ${url} ${String(init.body)}` : url;
    const route = routes[key];
    if (route === undefined) throw new TypeError("fetch failed");
    const reply = typeof route === "function" ? route(init) : route;
    if (typeof reply === "number") return new Response("{}", { status: reply });
    return Response.json(reply);
  }) as FetchFn;
}

const OLLAMA = "http://127.0.0.1:11434";
const LMSTUDIO = "http://127.0.0.1:1234";
const show = (model: string) => `POST ${OLLAMA}/api/show ${JSON.stringify({ model })}`;

describe("resolveProviders", () => {
  it("normalizes Ollama-style host values", () => {
    expect(normalizeHost("0.0.0.0", 11434)).toBe("http://127.0.0.1:11434");
    expect(normalizeHost("0.0.0.0:9000", 11434)).toBe("http://127.0.0.1:9000");
    expect(normalizeHost("gpu-box", 11434)).toBe("http://gpu-box:11434");
    expect(normalizeHost("gpu-box:8080", 1234)).toBe("http://gpu-box:8080");
    expect(normalizeHost(":9000", 11434)).toBe("http://127.0.0.1:9000");
    expect(normalizeHost("http://localhost:1234/v1/", 1234)).toBe("http://localhost:1234");
    expect(normalizeHost("https://ollama.example.com/", 11434)).toBe("https://ollama.example.com");
    expect(normalizeHost("http://localhost:11434/", 11434)).toBe("http://localhost:11434");
    expect(normalizeHost("  ", 11434)).toBeUndefined();
    expect(normalizeHost("ftp://x", 11434)).toBeUndefined();
    expect(normalizeHost(undefined, 11434)).toBeUndefined();
  });

  it("takes agent.json first, then the environment, then the defaults", () => {
    expect(resolveProviders(undefined, {})).toEqual({
      ollama: { url: OLLAMA, disabled: false },
      lmstudio: { url: LMSTUDIO, disabled: false },
      openrouter: { url: "https://openrouter.ai/api", disabled: false },
    });
    const env = { OLLAMA_HOST: "0.0.0.0", LMSTUDIO_HOST: "studio:4321", OPENROUTER_API_KEY: "sk-or-env" };
    expect(resolveProviders(undefined, env)).toMatchObject({
      ollama: { url: OLLAMA }, lmstudio: { url: "http://studio:4321" }, openrouter: { apiKey: "sk-or-env" },
    });
    const file = { ollama: { url: "http://box:11434", disabled: true }, lmstudio: { disabled: false }, openrouter: { apiKey: "sk-or-file" } };
    expect(resolveProviders(file, env)).toMatchObject({
      ollama: { url: "http://box:11434", disabled: true }, lmstudio: { url: "http://studio:4321", disabled: false }, openrouter: { apiKey: "sk-or-file" },
    });
    // An empty key in the file leaves the environment's.
    expect(resolveProviders({ openrouter: { apiKey: " " } }, env).openrouter.apiKey).toBe("sk-or-env");
  });
});

describe("detecting the providers", () => {
  it("keeps Ollama's models that call tools, and all but embedding models on an Ollama without capabilities", async () => {
    const fetchFn = fakeFetch({
      [`${OLLAMA}/api/tags`]: { models: [{ name: "qwen3:8b" }, { name: "gemma3:4b" }, { name: "nomic-embed-text:latest" }, { name: "llama3.1:8b" }, { name: "old-embed" }] },
      [`${OLLAMA}/api/version`]: { version: "0.12.3" },
      [show("qwen3:8b")]: { capabilities: ["completion", "tools", "thinking"] },
      [show("gemma3:4b")]: { capabilities: ["completion", "vision"] },
      [show("nomic-embed-text:latest")]: { capabilities: ["embedding"] },
      [show("llama3.1:8b")]: { details: {} },
      [show("old-embed")]: { details: {} },
    });
    expect(await detectOllama(OLLAMA, fetchFn)).toEqual({
      id: "ollama", installed: true, loggedIn: true, version: "0.12.3",
      models: ["qwen3:8b", "llama3.1:8b"],
      modelLabels: { "qwen3:8b": "qwen3:8b", "llama3.1:8b": "llama3.1:8b" },
      modelOptions: { "qwen3:8b": { efforts: [], speeds: [] }, "llama3.1:8b": { efforts: [], speeds: [] } },
    });
    expect(await detectOllama(OLLAMA, fakeFetch({}))).toEqual({ id: "ollama", installed: false });
  });

  it("reads LM Studio's own list, else the OpenAI-style one", async () => {
    const own = fakeFetch({ [`${LMSTUDIO}/api/v0/models`]: { data: [{ id: "qwen/qwen3-8b", type: "llm" }, { id: "gemma-3", type: "vlm" }, { id: "text-embedding-nomic", type: "embeddings" }] } });
    expect((await detectLmStudio(LMSTUDIO, own)).models).toEqual(["qwen/qwen3-8b", "gemma-3"]);
    const openai = fakeFetch({ [`${LMSTUDIO}/api/v0/models`]: 404, [`${LMSTUDIO}/v1/models`]: { data: [{ id: "qwen/qwen3-8b" }, { id: "text-embedding-nomic-embed" }] } });
    expect(await detectLmStudio(LMSTUDIO, openai)).toMatchObject({ installed: true, loggedIn: true, models: ["qwen/qwen3-8b"], modelLabels: { "qwen/qwen3-8b": "qwen/qwen3-8b" } });
    expect(await detectLmStudio(LMSTUDIO, fakeFetch({}))).toEqual({ id: "lmstudio", installed: false });
  });

  it("lists OpenRouter's tool models with their names and checks the key, sending it only in the header", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const models = { data: [{ id: "anthropic/claude-sonnet-4", name: "Anthropic: Claude Sonnet 4" }, { id: "qwen/qwen3-coder:free", name: "Qwen3 Coder (free)" }, { id: "bad id", name: "Bad" }] };
    const fetchFn = fakeFetch({ "https://openrouter.ai/api/v1/models?supported_parameters=tools": models, "https://openrouter.ai/api/v1/key": { data: {} } }, seen);
    expect(await detectOpenRouter("sk-or-1", fetchFn)).toEqual({
      id: "openrouter", installed: true, loggedIn: true, auth: "api_key",
      models: ["anthropic/claude-sonnet-4", "qwen/qwen3-coder:free"],
      modelLabels: { "anthropic/claude-sonnet-4": "Anthropic: Claude Sonnet 4", "qwen/qwen3-coder:free": "Qwen3 Coder (free)" },
      modelOptions: { "anthropic/claude-sonnet-4": { efforts: [], speeds: [] }, "qwen/qwen3-coder:free": { efforts: [], speeds: [] } },
    });
    const keyCall = seen.find((s) => s.url.endsWith("/key"))!;
    expect((keyCall.init?.headers as Record<string, string>).authorization).toBe("Bearer sk-or-1");
    expect(seen.filter((s) => s.url.includes("sk-or-1"))).toEqual([]);
    const refused = fakeFetch({ "https://openrouter.ai/api/v1/models?supported_parameters=tools": models, "https://openrouter.ai/api/v1/key": 401 });
    expect(await detectOpenRouter("sk-or-bad", refused)).toMatchObject({ installed: true, loggedIn: false, auth: "api_key" });
  });

  it("reports a provider switched off, without a key, or without Claude Code as not installed", async () => {
    const seen: Array<{ url: string }> = [];
    const fetchFn = fakeFetch({ [`${LMSTUDIO}/api/v0/models`]: { data: [{ id: "m", type: "llm" }] } }, seen);
    const providers = resolveProviders({ ollama: { disabled: true } }, {});
    const found = await detectProviders(providers, fetchFn, true);
    expect(found.map((a) => [a.id, a.installed])).toEqual([["ollama", false], ["lmstudio", true], ["openrouter", false]]);
    expect(seen.map((s) => s.url)).toEqual([`${LMSTUDIO}/api/v0/models`]);
    expect(await detectProviders(providers, fetchFn, false)).toEqual([
      { id: "ollama", installed: false }, { id: "lmstudio", installed: false }, { id: "openrouter", installed: false },
    ]);
  });

  it("adds the providers after the three CLIs, without the CLI model probe", async () => {
    const exec: ExecFn = async (file, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "2.1.0", stderr: "" };
      if (file === "claude") return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" };
      return { code: 1, stdout: "Not logged in", stderr: "" };
    };
    const asked: string[] = [];
    const fetchFn = fakeFetch({
      [`${OLLAMA}/api/tags`]: { models: [{ name: "qwen3:8b" }] },
      [`${OLLAMA}/api/version`]: { version: "0.12.3" },
      [show("qwen3:8b")]: { capabilities: ["tools"] },
    });
    const agents = await detect({
      exec, find: async (name) => (name === "claude" ? "claude" : null), home: "/nonexistent-home", env: {}, fetch: fetchFn,
      catalog: async (agent) => { asked.push(agent); return undefined; }, models: { ollama: "qwen3:8b" },
    });
    expect(agents.map((a) => [a.id, a.installed])).toEqual([
      ["claude", true], ["codex", false], ["gemini", false], ["ollama", true], ["lmstudio", false], ["openrouter", false],
    ]);
    expect(asked).toEqual(["claude"]);
    expect(agents[3]).toMatchObject({ model: "qwen3:8b", models: ["qwen3:8b"] });
    expect(formatAvailability(agents).split("\n").slice(3)).toEqual([
      "ollama  0.12.3  running  model qwen3:8b  (models: qwen3:8b)",
      "lmstudio not available",
      "openrouter not available",
    ]);
  });
});

describe("claiming provider tasks", () => {
  it("claims an extra provider only when it is up and takes its key", () => {
    const claimable = claimableAgents([
      { id: "claude", installed: true, loggedIn: true },
      { id: "codex", installed: true },
      { id: "gemini", installed: true, loggedIn: false },
      { id: "ollama", installed: true, loggedIn: true, models: ["qwen3:8b"] },
      { id: "lmstudio", installed: true, loggedIn: true, models: [] },
      { id: "openrouter", installed: true, loggedIn: false, models: ["openai/gpt-5"] },
    ]);
    expect(claimable.map((a) => a.id)).toEqual(["claude", "codex", "ollama"]);
  });

  it("runs one task at a time on a model on this computer, and the host's limit elsewhere", () => {
    expect(parallelLimits("ollama", 4)).toEqual({ tasks: 1, checks: 1 });
    expect(parallelLimits("lmstudio", 8)).toEqual({ tasks: 1, checks: 1 });
    expect(parallelLimits("openrouter", 4)).toEqual({ tasks: 4, checks: 8 });
    expect(parallelLimits("claude", 4)).toEqual({ tasks: 4, checks: 8 });
  });
});

describe("running through a provider", () => {
  const providers = resolveProviders({ openrouter: { apiKey: "sk-or-1" } }, {});
  const base = {
    PATH: "/bin", HOME: "/h",
    ANTHROPIC_API_KEY: "sk-ant", anthropic_auth_token: "tok", CLAUDE_CODE_OAUTH_TOKEN: "oauth", Claude_Code_Use_Bedrock: "1",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_BEDROCK_BASE_URL: "b", ANTHROPIC_VERTEX_BASE_URL: "v", ANTHROPIC_MODEL: "opus",
  };

  it("points Claude Code at the provider with the chosen model for every tier and no Anthropic sign-in", () => {
    const built = providerRunEnv("openrouter", "anthropic/claude-sonnet-4", base, providers);
    expect("env" in built && built.env).toEqual({
      PATH: "/bin", HOME: "/h",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-1",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_SMALL_FAST_MODEL: "anthropic/claude-sonnet-4",
      CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/claude-sonnet-4",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    });
    // The same but the token, for Claude Code's --settings flag, which outranks the user's own settings files.
    expect("settingsEnv" in built && built.settingsEnv).toEqual({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_SMALL_FAST_MODEL: "anthropic/claude-sonnet-4",
      CLAUDE_CODE_SUBAGENT_MODEL: "anthropic/claude-sonnet-4",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    });
    const local = providerRunEnv("ollama", "qwen3:8b", base, providers);
    expect("env" in local && local.env).toMatchObject({ ANTHROPIC_BASE_URL: OLLAMA, ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" });
    const studio = providerRunEnv("lmstudio", "qwen/qwen3-8b", base, providers);
    expect("env" in studio && studio.env).toMatchObject({ ANTHROPIC_BASE_URL: LMSTUDIO, ANTHROPIC_AUTH_TOKEN: "lmstudio" });
  });

  it("says what is missing: a model, or OpenRouter's key", () => {
    expect(providerRunEnv("ollama", undefined, {}, providers)).toEqual({ error: "Choose a model for Ollama first." });
    expect(providerRunEnv("lmstudio", undefined, {}, providers)).toEqual({ error: "Choose a model for LM Studio first." });
    expect(providerRunEnv("openrouter", "m", {}, resolveProviders(undefined, {}))).toEqual({ error: "Add an OpenRouter key to use OpenRouter." });
  });

  it("dispatches each provider to its own runner", async () => {
    expect(Object.keys(RUNNERS)).toEqual(["claude", "codex", "gemini", "ollama", "lmstudio", "openrouter"]);
    const opts: RunAgentOptions = { agent: "openrouter", model: "anthropic/claude-sonnet-4", systemPrompt: "SYS", instruction: "x", cwd: tmpdir(), mcp: { command: "node", args: [], env: {} }, onEvent: () => {}, env: {} };
    expect(await runAgent(opts)).toEqual({ ok: false, summary: "", error: "Add an OpenRouter key to use OpenRouter." });
    expect(await runnerFor("ollama")({ ...opts, agent: "ollama", model: undefined })).toEqual({ ok: false, summary: "", error: "Choose a model for Ollama first." });
  });

  it.skipIf(process.platform === "win32")("runs Claude Code with the provider's environment and without Claude's effort or fast mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scarlet-provider-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\nenv > "${dir}/env"\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > /dev/null\necho '{"type":"result","subtype":"success","result":"Done."}'\n`);
    await chmod(bin, 0o755);
    const result = await runAgent({
      agent: "ollama", model: "qwen3:8b", effort: "high", fast: true, serviceTier: "fast", systemPrompt: "SYS", instruction: "x", cwd: dir, bin,
      mcp: { command: "node", args: [], env: {} }, onEvent: () => {}, env: { ...base, PATH: process.env.PATH }, providers: { ollama: { url: "http://box:11434" } },
    });
    expect(result).toMatchObject({ ok: true, summary: "Done." });
    const env = Object.fromEntries((await readFile(join(dir, "env"), "utf8")).trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: "http://box:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "qwen3:8b", CLAUDE_CODE_SUBAGENT_MODEL: "qwen3:8b" });
    for (const gone of ["CLAUDE_CODE_OAUTH_TOKEN", "Claude_Code_Use_Bedrock", "CLAUDE_CODE_USE_VERTEX", "anthropic_auth_token"]) expect(env).not.toHaveProperty(gone);
    const args = (await readFile(join(dir, "args"), "utf8")).split("\n");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--effort");
    expect(args).toContain("--model");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { env?: Record<string, string>; fastMode?: boolean };
    expect(settings.fastMode).toBeUndefined();
    expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://box:11434", ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "qwen3:8b", CLAUDE_CODE_ATTRIBUTION_HEADER: "0" });
    expect(settings.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("keeps OpenRouter's key off the command line, and plain Claude runs without a settings env", () => {
    const built = providerRunEnv("openrouter", "anthropic/claude-sonnet-4", base, providers);
    if (!("settingsEnv" in built)) throw new Error(built.error);
    const opts = { systemPrompt: "SYS", instruction: "x", mcp: { command: "node", args: [], env: {} } };
    const routed = buildClaudeCommand({ ...opts, settingsEnv: built.settingsEnv }, "claude", "/tmp/ctl");
    expect(routed.args.join(" ")).not.toContain("sk-or-1");
    expect(JSON.parse(routed.args[routed.args.indexOf("--settings") + 1]!).env).toEqual(built.settingsEnv);
    const plain = buildClaudeCommand(opts, "claude", "/tmp/ctl");
    expect(JSON.parse(plain.args[plain.args.indexOf("--settings") + 1]!)).not.toHaveProperty("env");
  });
});
