#!/usr/bin/env node
/**
 * scarlet-agent — local agent host CLI.
 *
 *   scarlet-agent connect --server URL [--token-file PATH] [--name NAME]
 *   scarlet-agent start                      run the daemon
 *   scarlet-agent auth claude|codex|gemini   sign the CLI in with your subscription (opens the browser)
 *   scarlet-agent status                     show detected CLIs
 *   scarlet-agent run --project ID --agent claude|codex|gemini [--model M] "instruction"
 *
 * Env overrides: SCARLET_SERVER, SCARLET_TOKEN, SCARLET_HOME.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ScarletClient } from "@scarlet/shared";
import type { AgentId } from "@scarlet/shared";
import { readTokenFile } from "@scarlet/mcp/cli";
import { loadConfig, requireConfig, sameServer, saveConfig, workRoot } from "./config.js";
import { apiKeyVars, cmdShellArgs, detect, findOnPath, formatAvailability, needsCmdShell, stripVars } from "./detect.js";
import { privateDirectory } from "./private-files.js";
import { AgentHost } from "./host.js";
import { killStoppedNow } from "./processTree.js";

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
  auth    claude|codex|gemini      sign in with your Claude, ChatGPT or Google account (opens the browser)
  status                           show detected agent CLIs
  run     --project ID --agent claude|codex|gemini [--model M] "instruction"
                                   ask the engine for one request and run it here
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


/** Subscription sign-in commands; each CLI opens the browser or prints a sign-in link. */
export const SIGN_IN: Record<string, { bin: string; args: string[]; label: string; installHint: string }> = {
  claude: { bin: "claude", args: ["auth", "login", "--claudeai"], label: "Claude Pro/Max subscription", installHint: "npm i -g @anthropic-ai/claude-code" },
  codex: { bin: "codex", args: ["login"], label: "ChatGPT plan", installHint: "npm i -g @openai/codex" },
  gemini: { bin: "agy", args: ["acp", "--login"], label: "Google account", installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
};

async function cmdAuth(positional: string[]): Promise<void> {
  const agent = positional[0] ?? "claude";
  const sign = SIGN_IN[agent];
  if (!sign) throw new Error(`usage: scarlet-agent auth claude|codex|gemini`);
  const bin = await findOnPath(sign.bin);
  if (!bin) throw new Error(`${sign.bin} is not installed (${sign.installHint})`);
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
  // Closing the terminal is a quit too: the runs are handed back to be resumed, not left running with no host.
  if (process.platform !== "win32") process.on("SIGHUP", () => void shutdown("SIGHUP"));
  await host.start();
}

async function cmdRun(flags: Record<string, string>, positional: string[]): Promise<void> {
  const cfg = requireConfig(await loadConfig());
  const projectId = flags.project;
  const agent = (flags.agent ?? "claude") as AgentId;
  const instruction = positional.join(" ").trim();
  if (!projectId) throw new Error("--project is required");
  if (!instruction) throw new Error("instruction is required");
  if (flags.timeout && !(Number(flags.timeout) > 0)) throw new Error("--timeout takes a number of minutes");
  const client = new ScarletClient({ baseUrl: cfg.server, token: cfg.token });
  const root = workRoot();
  await privateDirectory(root);
  // A request like any other: the engine builds its prompt, and the host runs it in a task folder it cleans up.
  const host = new AgentHost({
    client,
    config: cfg,
    saveConfig: (c) => saveConfig(c),
    workRoot: root,
    timeoutMs: flags.timeout ? Number(flags.timeout) * 60_000 : undefined,
    log: (msg) => console.error(`[scarlet-agent] ${msg}`),
    onRunnerEvent: (_task, ev) => console.log(`[${ev.type}] ${ev.text}`),
  });
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once("SIGINT", cancel);
  let task;
  try {
    await host.stopOrphans();
    task = await host.runOne(projectId, { kind: "edit", agent, model: flags.model ?? cfg.models?.[agent], instruction }, stop.signal);
  } finally {
    process.off("SIGINT", cancel);
    killStoppedNow();
  }
  const ok = task.state === "done";
  const question = task.state === "waiting_for_user" ? task.question : null;
  console.log(`\n${ok ? "OK" : question ? "WAITING" : "FAILED"}${question ? ` (question: ${question})` : ""}\n${task.summary ?? ""}${task.error ? `\nerror: ${task.error}` : ""}`);
  process.exitCode = ok || question ? 0 : 1;
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
