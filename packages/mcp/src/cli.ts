#!/usr/bin/env node
/**
 * scarlet-mcp — run the Scarlet MCP server over stdio.
 *
 *   scarlet-mcp --server http://localhost:4000 --token-file <path> --project <projectId>
 *               [--task <taskId>] [--agent claude|codex|gemini] [--model <m>] [--workdir <dir>]
 *
 * Env fallbacks: SCARLET_SERVER, SCARLET_TOKEN, SCARLET_PROJECT, SCARLET_TASK,
 * SCARLET_AGENT, SCARLET_MODEL, SCARLET_WORKDIR. SCARLET_AGENT_CAPS='{"audio":true}' overrides what the
 * agent's harness is known to deliver (see agentCapabilities).
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCapabilities, ScarletClient } from "@scarlet/shared";
import { createScarletMcpServer } from "./server.js";

export interface CliOptions {
  server: string;
  token?: string;
  project: string;
  task?: string;
  agent?: string;
  model?: string;
  workDir?: string;
}

export function readTokenFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !st.size || st.size > 4096 || (process.platform !== "win32" && (st.mode & 0o077))) {
      throw new Error("Use a private, owner-readable token file.");
    }
    const token = readFileSync(fd, "utf8").trim();
    if (!token || /\s/.test(token)) throw new Error("Invalid token file");
    return token;
  } finally { closeSync(fd); }
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    // A value may hold its own equals signs, as a base64 token does: only the first one divides flag from value.
    const eq = a.indexOf("=");
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq), inline = eq < 0 ? undefined : a.slice(eq + 1);
    const next = argv[i + 1];
    if (inline !== undefined) flags[k] = inline;
    else if (next !== undefined && !next.startsWith("--")) {
      flags[k] = next;
      i++;
    } else flags[k] = "true";
  }
  if ("token" in flags) throw new Error("Use --token-file PATH or SCARLET_TOKEN to supply the workspace token.");
  const server = flags.server ?? env.SCARLET_SERVER;
  const project = flags.project ?? env.SCARLET_PROJECT;
  if (!server) throw new Error("missing --server (or SCARLET_SERVER)");
  if (!project) throw new Error("missing --project (or SCARLET_PROJECT)");
  return {
    server,
    token: flags["token-file"] ? readTokenFile(flags["token-file"]) : env.SCARLET_TOKEN,
    project,
    task: flags.task ?? env.SCARLET_TASK,
    agent: flags.agent ?? env.SCARLET_AGENT,
    model: flags.model ?? env.SCARLET_MODEL,
    workDir: flags.workdir ?? flags.workDir ?? env.SCARLET_WORKDIR,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(
      "usage: scarlet-mcp --server URL [--token-file PATH] --project ID [--task ID] [--agent claude|codex|gemini] [--model M] [--workdir DIR]",
    );
    return;
  }
  const opts = parseArgs(argv);
  const client = new ScarletClient({ baseUrl: opts.server, token: opts.token });
  const [{ settings }, assignment] = await Promise.all([
    client.settings(), opts.task ? client.forProject(opts.project).task(opts.task) : undefined,
  ]);
  const task = assignment?.task;
  if (opts.task && assignment?.checksTaskAttempts !== true) throw new Error("Update the Scarlet engine to use task-scoped editing tools.");
  const taskStartedAt = process.env.SCARLET_TASK_STARTED_AT ?? task?.startedAt;
  if (opts.task && (!task || task.id !== opts.task || task.projectId !== opts.project || !taskStartedAt ||
      task.startedAt !== taskStartedAt || !["claimed", "running"].includes(task.state)))
    throw new Error("This task attempt is no longer active.");
  const server = createScarletMcpServer(client, {
    editingTools: settings.editingTools,
    dialogue: settings.dialogue,
    projectId: opts.project,
    taskId: opts.task,
    taskStartedAt,
    task,
    agent: opts.agent,
    capabilities: agentCapabilities(opts.agent, process.env.SCARLET_AGENT_CAPS),
    workDir: opts.workDir,
    author: { type: "agent", id: opts.agent ?? "agent", name: opts.agent ?? "agent", model: opts.model },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once("end", () => { void server.close().catch(err => console.error("[scarlet-mcp] close:", err)); });
  // Keep stdout clean for the protocol; diagnostics go to stderr.
  console.error(`[scarlet-mcp] connected: project ${opts.project}${opts.task ? ` task ${opts.task}` : ""} -> ${opts.server}`);
}

const isMain = (() => {
  if (process.env.SCARLET_ENGINE_EMBEDDED) return false;
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
    console.error(`[scarlet-mcp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
