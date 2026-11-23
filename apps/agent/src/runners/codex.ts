/**
 * Codex CLI runner.
 *
 * The private App Server reports cumulative usage during an ephemeral turn.
 * Keep `exec --json` for CLI versions and authentication modes that cannot use
 * the isolated server. Answers reach a fresh run through the replayed Q&A.
 *
 * This module builds both command lines and the run's Codex home; `codexAppServer.ts` drives an App Server turn, and
 * `codexParse.ts` reads the events both report.
 */
import { lstat, mkdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hasApiKey } from "../detect.js";
import { privateDirectory, writePrivateFile } from "../private-files.js";
import { DEFAULT_STALL_MS, workspaceEnv, type CodexFallbackReason, type RunAgentOptions, type RunAgentResult } from "./types.js";
import { resolveCli, spawnLines } from "./spawn.js";
import { codexResult, newCodexState, parseCodexLine } from "./codexParse.js";
import { runCodexServer } from "./codexAppServer.js";

/** TOML basic string. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

export function tomlInlineTable(obj: Record<string, string>): string {
  const body = Object.entries(obj)
    .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)}=${tomlString(v)}`)
    .join(",");
  return `{${body}}`;
}

export interface CodexCommand {
  file: string;
  args: string[];
  stdin?: string;
  files: Record<string, string>;
  lastMessagePath: string;
}

export function buildCodexCommand(
  opts: Pick<RunAgentOptions, "model" | "effort" | "fast" | "serviceTier" | "systemPrompt" | "instruction" | "mcp" | "cwd" | "plan" | "workspace">,
  bin: string,
  tmpDir: string,
): CodexCommand {
  const executable = codexExecutable(bin);
  const lastMessagePath = join(tmpDir, "last-message.md");
  return {
    file: executable ?? bin,
    args: ["exec", "--json", "--skip-git-repo-check", "--cd", opts.cwd, "--strict-config", "--ignore-user-config", "--ignore-rules", "--ephemeral",
      // The task folder is the project: an AGENTS.md in a git repository around it (a work root inside a checkout)
      // would otherwise load beside Scarlet's, as App Server is already told.
      ...codexConfig(opts, executable), "-c", "project_root_markers=[]", "--output-last-message", lastMessagePath, ...(opts.model ? ["--model", opts.model] : []), ...codexModelConfig(opts), "-"],
    stdin: opts.instruction,
    files: { [join(opts.cwd, "AGENTS.md")]: opts.systemPrompt },
    lastMessagePath,
  };
}

function codexExecutable(bin: string): string | undefined {
  // Seatbelt must be able to re-execute Codex while loading AGENTS.md. Launch the
  // real file: granting its target alone does not permit a Homebrew symlink.
  let executable: string | undefined;
  if (process.platform === "darwin") {
    try { executable = realpathSync(bin); } catch { /* Keep normal missing-CLI reporting. */ }
  }
  return executable;
}

/** Codex features a side check runs without. A request's agent keeps its shell and its look at pictures it made. */
const CODEX_OFF = ["computer_use", "multi_agent", "plugins", "apps", "hooks"];

function codexConfig(opts: Pick<RunAgentOptions, "mcp" | "plan" | "workspace">, executable: string | undefined): string[] {
  // Forward slashes keep the TOML readable and work for node on Windows.
  const toToml = (p: string) => p.replace(/\\/g, "/");
  const ws = opts.workspace;
  // The programs the shell's links point at: readable, never writable. Everything else outside the task folder stays closed.
  const reads = [...(executable ? [executable] : []), ...(ws?.readDirs ?? [])].map((p) => `,${tomlString(toToml(p))}="read"`).join("");
  return [
    // The legacy Windows sandboxes cannot enforce this profile's denied root reads.
    ...(process.platform === "win32" ? ["-c", 'windows.sandbox="mxc"'] : []),
    ...(ws ? CODEX_OFF : ["shell_tool", "view_image", ...CODEX_OFF]).flatMap((feature) => ["--disable", feature]),
    "-c", 'approval_policy="never"',
    // A request's agent searches the live web; a side check has none.
    "-c", `web_search=${ws ? '"live"' : '"disabled"'}`,
    // Codex otherwise reads only the first 32 KiB of AGENTS.md. The prompt lists every clip ahead of the task, the
    // editor's notes, their earlier answers and their skills, so on a long timeline those would be cut off.
    "-c", "project_doc_max_bytes=4194304",
    // Codex's own to-do tool, which it reports as `todo_list` items. A Codex without this key refuses it under --strict-config.
    ...(opts.plan ? ["-c", "tools.update_plan.enabled=true"] : []),
    "-c", 'default_permissions="scarlet"',
    "-c", `permissions.scarlet.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"}${reads}}`,
    // A request's shell reaches the web, for the pages and clips it brings in. Scarlet's token stays out of the shell
    // (`shell_environment_policy` below), so the engine is no nearer than before.
    "-c", `permissions.scarlet.network.enabled=${ws ? "true" : "false"}`,
    "-c", 'mcp_servers.scarlet.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.scarlet.required=true",
    "-c", "mcp_servers.scarlet.startup_timeout_sec=60",
    // Scarlet's tools wait up to `toolWaitSeconds` (capabilities.ts) for evidence still being measured.
    "-c", "mcp_servers.scarlet.tool_timeout_sec=300",
    "-c",
    `mcp_servers.scarlet.command=${tomlString(toToml(opts.mcp.command))}`,
    "-c",
    `mcp_servers.scarlet.args=[${opts.mcp.args.map((a) => tomlString(toToml(a))).join(",")}]`,
    "-c",
    `mcp_servers.scarlet.env_vars=[${Object.keys(opts.mcp.env).sort().map(tomlString).join(",")}]`,
    "-c",
    'shell_environment_policy.exclude=["SCARLET_*"]',
  ];
}

function codexModelConfig(opts: Pick<RunAgentOptions, "effort" | "serviceTier" | "fast">): string[] {
  return [
    ...(opts.effort ? ["-c", `model_reasoning_effort=${tomlString(opts.effort)}`] : []),
    ...(opts.serviceTier || opts.fast ? ["-c", `service_tier=${tomlString(opts.serviceTier ?? "fast")}`] : []),
  ];
}

/** The `app-server` command line `runCodexServer` launches. */
function codexServerArgs(opts: RunAgentOptions, executable: string | undefined): string[] {
  return ["app-server", "--strict-config", ...codexConfig({ mcp: opts.mcp, workspace: opts.workspace }, executable),
    "-c", "project_root_markers=[]", "-c", 'cli_auth_credentials_store="file"',
    "-c", `tools.update_plan.enabled=${!!opts.plan}`, "-c", "tools.experimental_request_user_input.enabled=false", "--disable", "goals",
    ...codexModelConfig({ effort: opts.effort })];
}

async function isolatedCodexHome(cwd: string, env: NodeJS.ProcessEnv): Promise<{ home: string } | { reason: CodexFallbackReason }> {
  // App Server cannot skip the user's config, rules or MCP servers. Share only
  // file-backed login, with a symlink so Codex can still refresh that login.
  if (hasApiKey("codex", env)) return { reason: "api_key" };
  const projectConfig = await lstat(join(cwd, ".codex")).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  if (projectConfig) return { reason: "project_config" };
  const configuredHome = Object.entries(env).find(([name]) => name.toUpperCase() === "CODEX_HOME")?.[1];
  const originalHome = await realpath(resolve(cwd, configuredHome || join(homedir(), ".codex"))).catch(() => undefined);
  if (!originalHome) return { reason: "home_unavailable" };
  const authFile = join(originalHome, "auth.json");
  const auth = await stat(authFile).catch(() => undefined);
  if (!auth?.isFile() || !auth.size) return { reason: "auth_unavailable" };
  const home = codexHomeDir(cwd);
  try {
    await privateDirectory(home);
    // Only Scarlet writes configuration here. Codex's own state (its threads and their database) stays.
    for (const config of ["config.toml", "managed_config.toml"]) {
      if (await lstat(join(home, config)).catch(() => undefined)) return { reason: "isolation_unavailable" };
    }
    // Linked again on each run: the login may have moved since the last one. The store locks around refresh commits,
    // so the lock is the ordinary CLI's too.
    for (const [from, name] of [[authFile, "auth.json"], [join(originalHome, "auth.lock"), "auth.lock"]] as const) {
      await rm(join(home, name), { force: true });
      await symlink(from, join(home, name), "file");
    }
    return { home };
  } catch {
    return { reason: "isolation_unavailable" };
  }
}

/**
 * The run's own Codex home, beside its task folder: outside the folder the agent may write to, and the same for every
 * attempt at the task (the folder is keyed by the run's first task id), so a run cut short or paused on a question
 * resumes its thread. The host removes it once the task lands; the task folders' prune takes one left behind.
 */
export function codexHomeDir(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}.codex`;
}

export async function runCodex(opts: RunAgentOptions): Promise<RunAgentResult> {
  // Scarlet's server reads its variables from Codex's; the shell never gets them (`shell_environment_policy`).
  const env = { ...workspaceEnv(opts.env ?? process.env, opts.workspace), ...opts.mcp.env };
  const bin = await resolveCli("codex", opts.bin, env);
  await writePrivateFile(join(opts.cwd, "AGENTS.md"), opts.systemPrompt);
  const isolation = await isolatedCodexHome(opts.cwd, env).catch(() => ({ reason: "isolation_unavailable" as const }));
  if ("home" in isolation) {
    const executable = codexExecutable(bin);
    const result = await runCodexServer(opts, env, executable ?? bin, codexServerArgs(opts, executable), isolation.home);
    if (result) return result;
  } else {
    opts.onCodexFallback?.(isolation.reason);
    if (opts.resumeSession) return { ok: false, summary: "", resumeFailed: true, error: `Codex could not resume here (${isolation.reason})` };
  }

  const tmpDir = join(opts.cwd, ".scarlet");
  await mkdir(tmpDir, { recursive: true });
  const cmd = buildCodexCommand(opts, bin, tmpDir);

  const st = newCodexState();
  const handle = spawnLines(cmd.file, cmd.args, {
    cwd: opts.cwd,
    env,
    stdin: cmd.stdin,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    stallMs: opts.stallMs ?? DEFAULT_STALL_MS,
    onLine: (line) => {
      for (const ev of parseCodexLine(line, st)) opts.onEvent(ev);
      if (st.shouldStop) {
        st.shouldStop = false;
        setTimeout(() => handle.kill(), 250).unref();
      }
    },
  });
  const outcome = await handle.done;

  let last = st.lastMessage;
  try {
    const fromFile = (await readFile(cmd.lastMessagePath, "utf8")).trim();
    if (fromFile) last = fromFile;
  } catch {
    /* not written */
  }
  return codexResult(st, outcome, last, opts.model, outcome.code === 0 || st.turnCompleted);
}
