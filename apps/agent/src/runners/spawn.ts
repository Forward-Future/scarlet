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
import { forgetCli, KILL_AFTER_MS, killCliTree, noteCli, repeatStop, stopCliTree } from "../processTree.js";
import type { RunAgentResult } from "./types.js";

export interface SpawnLinesOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin then closed. */
  stdin?: string;
  /** Keep stdin open for a metadata protocol handshake. */
  interactive?: boolean;
  signal?: AbortSignal;
  /** Ask a protocol client to stop, with a short period to drain its final events. */
  interrupt?: () => boolean;
  /** Stop the process after this long, however busy it is. Omitted: no cap. */
  timeoutMs?: number;
  /** Stop the process once it has written nothing to stdout for this long. */
  stallMs?: number;
  /** How long a stopped process has to finish before its group is killed. Default `KILL_AFTER_MS`. */
  killAfterMs?: number;
  onLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

interface SpawnOutcome {
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

/** How often a run's watchdog looks at the clock. Matches the desktop host. */
const WATCH_TICK_MS = 1000;
/**
 * A look this late means the computer was asleep since the last one: its stall and time limits don't count that. A busy
 * machine is late by seconds, not this. Matches the desktop host.
 */
export const ASLEEP_AFTER_MS = 30_000;
/** The watchdog's clock. A monotonic one, as the desktop host's: the wall clock jumps when it is set. Tests replace it. */
export const watchClock = { now: (): number => performance.now() };

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
  let settled = false;
  let stderr = "";
  let interruptTimer: NodeJS.Timeout | undefined;
  const killAfterMs = opts.killAfterMs ?? KILL_AFTER_MS;
  const kill = () => {
    // Once the CLI and its output are gone, the system may give its process id to another program.
    if (killed || settled || !child.pid) return;
    killed = true;
    // Asked first, so Claude Code can write its session for the attempt that resumes it; killed if it doesn't end.
    stopCliTree(child, killAfterMs);
    // A process the CLI was starting as the stop went out can miss it, and keep the output open: stop it again. On
    // POSIX that is a kill after the CLI's time to finish; Windows stops the whole tree at once, so a second later.
    const windows = process.platform === "win32";
    setTimeout(() => {
      if (settled) return;
      if (repeatStop(child) === "kill-tree") return windows ? stopCliTree(child) : killCliTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, windows ? 1000 : killAfterMs + 1000).unref();
  };
  const stop = () => {
    if (opts.interrupt?.()) interruptTimer ??= setTimeout(kill, 2000).unref();
    else kill();
  };
  // The agent CLIs stream an event for every step, tool call and message, so a long silence means a hang. Neither the
  // silence nor the run's time counts while the computer sleeps: Windows' clock counts on through a suspend, so a run
  // would otherwise wake up stalled, or past its limit.
  let lastOutput = watchClock.now();
  let stalled = false;
  let watchTimer: NodeJS.Timeout | undefined;
  let looked = lastOutput;
  let awake = 0;
  const tick = Math.max(10, Math.min(WATCH_TICK_MS, opts.stallMs || Infinity, opts.timeoutMs ?? Infinity));
  const watch = () => {
    const now = watchClock.now();
    const gap = now - looked;
    looked = now;
    if (gap >= ASLEEP_AFTER_MS) {
      lastOutput = now;
    } else {
      awake += gap;
      if (opts.timeoutMs !== undefined && awake >= opts.timeoutMs) {
        timedOut = true;
        return stop();
      }
      if (opts.stallMs && now - lastOutput >= opts.stallMs) {
        stalled = timedOut = true;
        return stop();
      }
    }
    watchTimer = setTimeout(watch, tick);
  };
  if (opts.timeoutMs !== undefined || opts.stallMs) watchTimer = setTimeout(watch, tick);
  const onAbort = () => {
    aborted = true;
    stop();
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
    lastOutput = watchClock.now();
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

  // Noted for the next launch, which stops a CLI this one left running when it crashed. In the background: `ps` is slow
  // beside a CLI that reads its prompt at once.
  const noting = child.pid ? noteCli(child.pid, spec.file).catch((err) => addStderr(`could not note the CLI for the next launch: ${err instanceof Error ? err.message : String(err)}\n`)) : undefined;
  const done = new Promise<SpawnOutcome>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchTimer);
      clearTimeout(interruptTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) emitLine(buf.replace(/\r$/, ""));
      const outcome = { code, signal, timedOut, stalled, aborted, killed, stderr };
      const pid = child.pid;
      if (!noting || !pid) return resolve(outcome);
      // After the note is written, so one written late isn't left behind.
      void noting.then(() => forgetCli(pid)).catch(() => undefined).finally(() => resolve(outcome));
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

/** The one JSON object a CLI wrote on a line of its stream. Undefined for anything else: a warning, null, a number, a list. */
export function jsonLine(line: string): Record<string, unknown> | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  return msg && typeof msg === "object" && !Array.isArray(msg) ? msg as Record<string, unknown> : undefined;
}

/**
 * How a run ended when it stopped short of the CLI's own end: on a question for the editor, at the host's time or
 * stall limit, or cancelled. Undefined when the CLI ran to its end, which each runner reads from its own stream.
 */
export function earlyResult(st: { texts: string[]; question?: string; questionPosted: boolean }, outcome: SpawnOutcome,
  rest: Pick<RunAgentResult, "sessionId" | "usage">): RunAgentResult | undefined {
  const summary = tailSummary(st.texts);
  if (st.question) return { ok: true, summary, question: st.question, questionPosted: st.questionPosted, exitCode: outcome.code, ...rest };
  if (outcome.timedOut) return { ok: false, summary, error: outcome.stalled ? "stalled" : "timed out", timedOut: true, stalled: outcome.stalled, exitCode: outcome.code, ...rest };
  if (outcome.aborted) return { ok: false, summary, error: "cancelled", aborted: true, exitCode: outcome.code, ...rest };
  return undefined;
}

/** Last-resort extraction of a summary from stream output when the CLI printed no result. */
export function tailSummary(texts: string[], max = 2000): string {
  const joined = texts.filter(Boolean).join("\n").trim();
  return joined.length > max ? `…${joined.slice(-max)}` : joined;
}
