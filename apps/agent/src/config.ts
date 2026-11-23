/**
 * Local host configuration: ~/.scarlet/agent.json plus env overrides.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { privateDirectory, privateFile, writePrivateFile } from "./private-files.js";

export function sameServer(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, "");
}

export interface AgentConfig {
  server: string;
  token: string;
  hostId?: string;
  name?: string;
  /** Optional cap on one agent run, in minutes. Unset (the default), a run continues while its agent works. */
  timeoutMinutes?: number;
  /** Stop a run whose agent has written nothing for this many minutes (default 10). */
  stallMinutes?: number;
  /** Tasks each agent runtime may run at once (default 4, max 8): a request about the whole video and three revisions beside it. */
  maxParallel?: number;
  /** Default model per agent runtime. */
  models?: Partial<Record<string, string>>;
}

export function scarletHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCARLET_HOME ?? join(homedir(), ".scarlet");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(scarletHome(env), "agent.json");
}

export function workRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(scarletHome(env), "work");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Partial<AgentConfig>> {
  let file: Partial<AgentConfig> = {};
  const path = configPath(env);
  // Windows has no O_NOFOLLOW: there the path is compared with what was opened, before and after its ACL is reset.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return undefined;
  });
  if (handle) {
    try {
      const stat = await handle.stat({ bigint: true });
      const opened = async () => {
        const named = await lstat(path, { bigint: true });
        return named.isFile() && named.dev === stat.dev && named.ino === stat.ino;
      };
      if (!stat.isFile() || stat.nlink !== 1n || !(await opened())) throw new Error("Expected a private agent config file");
      if (process.platform === "win32") {
        await privateFile(path);
        if (!(await opened())) throw new Error("Expected a private agent config file");
      } else {
        await privateDirectory(scarletHome(env));
        if ((stat.mode & 0o777n) !== 0o600n) await handle.chmod(0o600);
      }
      file = JSON.parse(await handle.readFile("utf8")) as Partial<AgentConfig>;
    } finally {
      await handle.close();
    }
  }
  return {
    ...file,
    ...(env.SCARLET_SERVER && !sameServer(env.SCARLET_SERVER, file.server) ? { server: env.SCARLET_SERVER, token: undefined, hostId: undefined } : {}),
    ...(env.SCARLET_TOKEN ? { token: env.SCARLET_TOKEN } : {}),
  };
}

export async function saveConfig(cfg: Partial<AgentConfig>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const p = configPath(env);
  await writePrivateFile(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function requireConfig(cfg: Partial<AgentConfig>): AgentConfig {
  if (!cfg.server) throw new Error("No server configured. Run `scarlet-agent connect --server URL` or set SCARLET_SERVER.");
  if (!cfg.token) throw new Error("No token configured. Run `scarlet-agent connect` or set SCARLET_TOKEN.");
  return { ...cfg, server: cfg.server, token: cfg.token, name: cfg.name ?? hostname() };
}
