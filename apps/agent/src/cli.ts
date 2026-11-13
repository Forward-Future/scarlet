#!/usr/bin/env node
/**
 * scarlet-agent — local agent host CLI.
 *
 *   scarlet-agent connect --server URL [--token-file PATH] [--name NAME]
 *   scarlet-agent start                      run the daemon
 *   scarlet-agent auth claude|codex          sign the CLI in with your subscription (opens the browser)
 *   scarlet-agent status                     show detected CLIs
 *   scarlet-agent run --project ID --agent claude|codex|gemini [--model M] "instruction"
 *
 * Env overrides: SCARLET_SERVER, SCARLET_TOKEN, SCARLET_HOME.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { agentCapabilities, ScarletClient } from "@scarlet/shared";
import type { AgentId } from "@scarlet/shared";
import { buildSystemPrompt } from "@scarlet/mcp/prompt";
import { readTokenFile } from "@scarlet/mcp/cli";
import { loadConfig, requireConfig, sameServer, saveConfig, workRoot } from "./config.js";
import { apiKeyVars, cmdShellArgs, detect, findOnPath, formatAvailability, needsCmdShell, runnerEnv, stripVars } from "./detect.js";
import { privateDirectory } from "./private-files.js";
import { AgentHost, removeControlFiles } from "./host.js";
import { runAgent } from "./runners/index.js";
import { mcpEnv, nodeExecutable, resolveMcpCliPath } from "./runners/spawn.js";

interface Parsed {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

export function parseArgv(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      // Not split("=", 2): that drops whatever follows a second "=", as in a base64 token or a URL with a query.
      const eq = a.indexOf("=");
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const next = rest[i + 1];
      if (eq >= 0) flags[k] = a.slice(eq + 1);
      else if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = "true";
    } else positional.push(a);
  }
  return { command, flags, positional };
}

const USAGE = `scarlet-agent <command>

  connect --server URL [--token-file PATH] [--name NAME]
                                   use the destination engine's private token file or SCARLET_TOKEN
  start                            run the host daemon (claims tasks, runs your CLIs)
  auth    claude|codex             sign in with your Claude or ChatGPT subscription (opens the browser)
  status                           show detected agent CLIs
  run     --project ID --agent claude|codex|gemini [--model M] "instruction"
                                   one-shot run against a project (no server task)
`;

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function cmdConnect(flags: Record<string, string>): Promise<void> {
  if ("token" in flags || flags.data) throw new Error("Use --token-file PATH or SCARLET_TOKEN for the destination engine.");
  const existing = await loadConfig();
  const server = flags.server ?? existing.server ?? (await prompt("Server URL: "));
  if (!server) throw new Error("--server is required");
  const name = flags.name ?? existing.name ?? hostname();
  // An unpaired environment token can initialize a fresh host. A configured token follows only its own engine.
  const destinationToken = !existing.server ? process.env.SCARLET_TOKEN : sameServer(existing.server, server) ? existing.token : undefined;
  const token = flags["token-file"] ? readTokenFile(flags["token-file"]) : destinationToken ||
    (process.stdin.isTTY ? readTokenFile(await prompt("Destination server token file: ")) : undefined);
  if (!token) throw new Error("Use --token-file PATH or SCARLET_TOKEN for the destination engine.");
  const me = await new ScarletClient({ baseUrl: server, token }).me();
  console.log(`Connected to ${server} as ${me.user.name}.`);
  await saveConfig({ ...existing, hostId: sameServer(existing.server, server) ? existing.hostId : undefined, server, token, name });
  console.log(`Saved ${join(process.env.SCARLET_HOME ?? "~/.scarlet", "agent.json")}.`);
}


/** Subscription sign-in commands; each CLI opens the browser itself. */
export const SIGN_IN: Record<string, { bin: string; args: string[]; label: string }> = {
  claude: { bin: "claude", args: ["auth", "login", "--claudeai"], label: "Claude Pro/Max subscription" },
  codex: { bin: "codex", args: ["login"], label: "ChatGPT plan" },
};

async function cmdAuth(positional: string[]): Promise<void> {
  const agent = positional[0] ?? "claude";
  const sign = SIGN_IN[agent];
  if (!sign) throw new Error(`usage: scarlet-agent auth claude|codex`);
  const bin = await findOnPath(sign.bin);
  if (!bin) throw new Error(`${sign.bin} is not installed (npm i -g ${agent === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex"})`);
  console.log(`Signing in to ${agent} with your ${sign.label}. A browser window will open…`);
  // An API key in the environment would make the CLI skip the subscription flow.
  const env = stripVars(process.env, apiKeyVars(agent));
  const useShell = needsCmdShell(bin);
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(useShell ? "cmd.exe" : bin, useShell ? cmdShellArgs(bin, sign.args) : sign.args, {
      stdio: "inherit",
      env,
      windowsVerbatimArguments: useShell,
    });
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  const cfg = await loadConfig();
  const a = (await detect({ models: cfg.models })).find((x) => x.id === agent);
  if (a) console.log(`\n${formatAvailability([a])}`);
  if (code !== 0) process.exitCode = 1;
  else if (cfg.server) console.log("Restart `scarlet-agent start` (if running) so the server sees the new sign-in.");
}
async function cmdStatus(): Promise<void> {
  const cfg = await loadConfig();
  const agents = await detect({ models: cfg.models });
  console.log(formatAvailability(agents));
  if (cfg.server) console.log(`\nserver: ${cfg.server}${cfg.hostId ? `  host: ${cfg.hostId}` : ""}`);
  else console.log("\nnot connected (scarlet-agent connect --server URL)");
}

async function cmdStart(): Promise<void> {
  const cfg = requireConfig(await loadConfig());
  const client = new ScarletClient({ baseUrl: cfg.server, token: cfg.token });
  const root = workRoot();
  await privateDirectory(root);
  const host = new AgentHost({
    client,
    config: cfg,
    saveConfig: (c) => saveConfig(c),
    workRoot: root,
  });
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[scarlet-agent] ${sig}: cancelling ${host.runningTaskIds.length} running task(s) and shutting down…`);
    await host.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await host.start();
}

async function cmdRun(flags: Record<string, string>, positional: string[]): Promise<void> {
  const cfg = requireConfig(await loadConfig());
  const projectId = flags.project;
  const agent = (flags.agent ?? "claude") as AgentId;
  const instruction = positional.join(" ").trim();
  if (!projectId) throw new Error("--project is required");
  if (!instruction) throw new Error("instruction is required");
  const client = new ScarletClient({ baseUrl: cfg.server, token: cfg.token });
  const detail = await client.project(projectId);
  const { skills } = await client.skills({ projectId, view: "prompt" }).catch((err) => {
    console.error(`[scarlet-agent] could not load the project's skills; running without them: ${err instanceof Error ? err.message : String(err)}`);
    return { skills: [] };
  });
  await privateDirectory(workRoot());
  const cwd = await mkdtemp(join(workRoot(), "oneshot-"));
  await privateDirectory(cwd);
  const artifacts = join(cwd, "artifacts");
  await mkdir(artifacts, { mode: 0o700 });
  const systemPrompt = buildSystemPrompt({
    project: { project: detail.project, timeline: detail.timeline },
    task: { kind: "edit", instruction, agent, context: {} },
    skills: skills.filter((s) => s.enabled),
    workDir: artifacts,
    capabilities: agentCapabilities(agent),
  });
  const model = flags.model ?? cfg.models?.[agent];
  const result = await runAgent({
    agent,
    model,
    systemPrompt,
    instruction,
    cwd,
    mcp: {
      command: nodeExecutable(),
      args: [resolveMcpCliPath()],
      env: mcpEnv({ SCARLET_SERVER: cfg.server, SCARLET_TOKEN: cfg.token, SCARLET_PROJECT: projectId, SCARLET_AGENT: agent, SCARLET_MODEL: model, SCARLET_WORKDIR: artifacts }),
    },
    timeoutMs: flags.timeout ? Number(flags.timeout) * 60_000 : undefined,
    env: runnerEnv(agent, await detect({ models: cfg.models }), process.env),
    onEvent: (ev) => console.log(`[${ev.type}] ${ev.text}`),
  }).finally(() => removeControlFiles(cwd).catch(error => {
    console.error(`[scarlet-agent] could not clean one-shot folder ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
  }));
  console.log(`\n${result.ok ? "OK" : "FAILED"}${result.question ? ` (question: ${result.question})` : ""}\n${result.summary}${result.error ? `\nerror: ${result.error}` : ""}`);
  process.exitCode = result.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, flags, positional } = parseArgv(argv);
  switch (command) {
    case "connect":
    case "login": // older name
      return cmdConnect(flags);
    case "start":
      return cmdStart();
    case "auth":
      return cmdAuth(positional);
    case "status":
      return cmdStatus();
    case "run":
      return cmdRun(flags, positional);
    default:
      console.log(USAGE);
  }
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(`[scarlet-agent] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
