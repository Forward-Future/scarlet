/**
 * Process helpers shared by the runners: resolve the CLI, spawn it (through
 * cmd.exe for Windows .cmd shims), stream stdout line by line, enforce a
 * timeout and honour an AbortSignal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { findOnPath, needsCmdShell } from "../detect.js";
import { noteCli } from "../orphans.js";
import { stopCliTree } from "../processTree.js";

export interface SpawnLinesOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin then closed. */
  stdin?: string;
  /** Keep stdin open for a metadata protocol handshake. */
  interactive?: boolean;
  signal?: AbortSignal;
  /** Stop the process after this long, however busy it is. Omitted: no cap. */
  timeoutMs?: number;
  /** Stop the process once it has written nothing to stdout for this long. */
  stallMs?: number;
  onLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Stopped by `timeoutMs` or `stallMs`. */
  timedOut: boolean;
  /** Stopped by `stallMs`: the process had gone silent. */
  stalled: boolean;
  aborted: boolean;
  killed: boolean;
  stderr: string;
}

export interface SpawnHandle {
  child: ChildProcess;
  done: Promise<SpawnOutcome>;
  /** Stop the process (used after a question has been posted). */
  kill: () => void;
}

/** Quote one argument for a cmd.exe command string. */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  // Double quotes inside are escaped by doubling; cmd special chars are safe inside quotes.
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Build the spawn file/args for an executable, wrapping .cmd/.bat shims in cmd.exe. */
export function spawnSpec(file: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (needsCmdShell(file)) {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${[file, ...args].map(quoteForCmd).join(" ")}"`],
      verbatim: true,
    };
  }
  return { file, args, verbatim: false };
}

/** Resolve a Windows npm CLI shim without interpreting any task arguments in cmd.exe. */
export function runnerSpec(file: string, args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; verbatim: boolean } {
  if (!needsCmdShell(file)) return { file, args, verbatim: false };
  const name = basename(file, extname(file)).toLowerCase();
  const packages: Record<string, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", gemini: "@google/gemini-cli" };
  const pkg = packages[name];
  if (!pkg) throw new Error("Batch launchers are unsupported for agent tasks. Use the native or npm CLI.");
  const root = join(dirname(file), "node_modules", pkg);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin: string | Record<string, string> };
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[name];
  if (!entry) throw new Error(`No npm entry point for ${name}`);
  const target = join(root, entry);
  if (/\.exe$/i.test(target)) return { file: target, args, verbatim: false };
  if (!/\.[cm]?js$/i.test(target)) throw new Error("Unsupported npm agent executable");
  // A packaged engine's execPath launches Scarlet itself. npm's JS entry needs Node.
  let node = process.execPath;
  if (isSea()) {
    const dirs = [dirname(file), ...(env.PATH ?? env.Path ?? "").split(delimiter)];
    const runtime = dirs.filter(isAbsolute).map(dir => join(dir, "node.exe")).find(existsSync);
    if (!runtime) throw new Error(`Node.js is required to launch the ${name} npm CLI`);
    node = runtime;
  }
  return { file: node, args: [target, ...args], verbatim: false };
}

export function spawnLines(file: string, args: string[], opts: SpawnLinesOptions): SpawnHandle {
  const spec = runnerSpec(file, args, opts.env);
  const child = spawn(spec.file, spec.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32", // own process group, including tool subprocesses
    windowsVerbatimArguments: spec.verbatim,
  });
  let timedOut = false;
  let aborted = false;
  let killed = false;
  let stderr = "";
  const kill = () => {
    if (killed || !child.pid) return;
    killed = true;
    stopCliTree(child);
  };
  const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  // The agent CLIs stream an event for every step, tool call and message, so a long silence means a hang.
  let lastOutput = Date.now();
  let stalled = false;
  let stallTimer: NodeJS.Timeout | undefined;
  const watchStall = () => {
    if (!opts.stallMs) return;
    const quiet = Date.now() - lastOutput;
    if (quiet >= opts.stallMs) {
      stalled = timedOut = true;
      kill();
      return;
    }
    stallTimer = setTimeout(watchStall, opts.stallMs - quiet);
  };
  watchStall();
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const addStderr = (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    opts.onStderr?.(chunk);
  };
  // A handler that throws inside a stream listener is an uncaught exception: it would take the whole host down.
  const emitLine = (line: string) => {
    try {
      opts.onLine(line);
    } catch (err) {
      addStderr(`line handler failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    lastOutput = Date.now();
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.trim()) emitLine(line);
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", addStderr);

  let forget: (() => void) | undefined;
  const done = new Promise<SpawnOutcome>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      forget?.();
      clearTimeout(timer);
      clearTimeout(stallTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) emitLine(buf.replace(/\r$/, ""));
      resolve({ code, signal, timedOut, stalled, aborted, killed, stderr });
    };
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null, null);
    });
    child.on("close", finish);
  });

  if (child.stdin) {
    child.stdin.on("error", () => {
      /* EPIPE when the CLI exits early */
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else if (!opts.interactive) child.stdin.end();
  }
  // Noted after the prompt is handed over: reading a start time takes seconds on Windows, and Claude Code waits only
  // a few seconds for its prompt. The note goes when the CLI ends.
  if (child.pid) forget = noteCli(child.pid, spec.file);
  return { child, done, kill };
}

/** Locate a CLI: explicit override, then PATH. */
export async function resolveCli(name: string, override?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (override) return override;
  const p = await findOnPath(name, env);
  if (!p) throw new Error(`${name} CLI not found on PATH`);
  return p;
}

/** Absolute path of the Scarlet MCP stdio server (packages/mcp/dist/cli.js). */
export function resolveMcpCliPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SCARLET_MCP_CLI) return env.SCARLET_MCP_CLI;
  // The package only exports an "import" condition, so resolve as ESM first.
  try {
    return join(dirname(fileURLToPath(import.meta.resolve("@scarlet/mcp"))), "cli.js");
  } catch {
    /* import.meta.resolve unavailable (bundlers, vitest) */
  }
  const req = createRequire(import.meta.url);
  for (const dir of req.resolve.paths("@scarlet/mcp") ?? []) {
    const candidate = join(dir, "@scarlet", "mcp", "dist", "cli.js");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("cannot locate @scarlet/mcp dist/cli.js (build packages/mcp or set SCARLET_MCP_CLI)");
}

/** Node executable used to run the MCP server. */
export function nodeExecutable(): string {
  return process.execPath;
}

/** Compose the MCP server env: inherit PATH etc., add SCARLET_* vars. */
export function mcpEnv(vars: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

/** Last-resort extraction of a summary from stream output when the CLI printed no result. */
export function tailSummary(texts: string[], max = 2000): string {
  const joined = texts.filter(Boolean).join("\n").trim();
  return joined.length > max ? `…${joined.slice(-max)}` : joined;
}
