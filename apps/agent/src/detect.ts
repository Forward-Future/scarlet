/**
 * Detect installed AI CLIs (Claude Code, Codex, Gemini) and whether they look
 * logged in. Heuristics only: a CLI is reported as loggedIn=true when it is
 * installed and we cannot tell otherwise.
 */
import { discoverModels, type CliAgent } from "./modelCatalog.js";
import { stopCliTree } from "./processTree.js";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";
import type { AgentAvailability, AgentId } from "@scarlet/shared";

export const CLI_AGENTS: Array<Exclude<AgentId, "api">> = ["claude", "codex", "gemini"];

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (file: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

const WIN_EXTS = [".exe", ".cmd", ".bat", ".com"];

/** Find an executable on PATH. On Windows also tries PATHEXT-style suffixes (.exe, .cmd, .bat). */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const isWin = process.platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = isWin ? (env.PATHEXT ? env.PATHEXT.split(";").map((e) => e.toLowerCase()) : WIN_EXTS) : [""];
  // npm puts an extensionless shell script beside each .cmd shim. Windows can't start it, so it comes last.
  const candidates = isWin ? (extname(name) ? [name] : [...exts.map((e) => name + e), name]) : [name];
  for (const dir of dirs) {
    for (const c of candidates) {
      // Runners launch in the task workspace, even for a relative PATH entry.
      const p = resolve(dir, c);
      try {
        if (!(await stat(p)).isFile()) continue;
        if (!isWin) await access(p, constants.X_OK);
        return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** True for Windows batch shims that must be run through cmd.exe. */
export function needsCmdShell(file: string): boolean {
  return process.platform === "win32" && [".cmd", ".bat"].includes(extname(file).toLowerCase());
}

/** cmd.exe arguments that run a batch shim. `/s` drops the outer pair of quotes and keeps the pair around the path. */
export function cmdShellArgs(file: string, args: string[]): string[] {
  return ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`];
}

export const defaultExec: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const useShell = needsCmdShell(file);
    const child = spawn(useShell ? "cmd.exe" : file, useShell ? cmdShellArgs(file, args) : args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      ...(opts.env ? { env: opts.env } : {}),
      windowsVerbatimArguments: useShell,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      stopCliTree(child);
      // A launcher that already exited can leave a descendant holding these pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
    }, opts.timeoutMs ?? 15000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function parseVersion(s: string): string | undefined {
  const m = /(\d+\.\d+\.\d+(?:[-+.][\w.]+)?)/.exec(s);
  return m?.[1];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exec?: ExecFn;
  catalog?: typeof discoverModels;
  /** Resolve a CLI path; defaults to PATH lookup. */
  find?: (name: string) => Promise<string | null>;
  /** Model override per agent (from config). */
  models?: Partial<Record<string, string>>;
  /** Where a failed probe is reported; defaults to stderr. */
  log?: (msg: string) => void;
}

export const SUBSCRIPTION = "subscription" as const;
export const API_KEY = "api_key" as const;

/** Env vars that make a CLI bill an API key instead of the signed-in subscription. */
export function apiKeyVars(agent: string): string[] {
  if (agent === "claude") return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  if (agent === "codex") return ["OPENAI_API_KEY", "CODEX_API_KEY"];
  return [];
}

export function stripVars(env: NodeJS.ProcessEnv, vars: string[]): NodeJS.ProcessEnv {
  const drop = new Set(vars.map((v) => v.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k.toUpperCase())));
}

/**
 * The env a runner should use: when the CLI is signed in with a subscription,
 * drop API-key variables so a stray key in the environment can't silently
 * switch the run to pay-per-token billing.
 */
export function runnerEnv(agent: string, agents: AgentAvailability[], env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const onSubscription = agents.some((a) => a.id === agent && a.auth === SUBSCRIPTION);
  return onSubscription ? stripVars(env, apiKeyVars(agent)) : env;
}

type DetectCtx = Required<Pick<DetectOptions, "env" | "home" | "exec" | "find">>;

export async function detectClaude(o: DetectCtx): Promise<AgentAvailability> {
  const path = await o.find("claude");
  if (!path) return { id: "claude", installed: false };
  const v = await o.exec(path, ["--version"]);
  const version = parseVersion(v.stdout + v.stderr);
  let loggedIn: boolean | undefined;
  let auth: AgentAvailability["auth"];
  let plan: string | undefined;
  // Preferred: `claude auth status` prints JSON (exit 1 when signed out).
  const st = await o.exec(path, ["auth", "status"]).catch(() => null);
  if (st) {
    try {
      const j = JSON.parse(st.stdout.trim()) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (typeof j.loggedIn === "boolean") loggedIn = j.loggedIn;
      if (j.authMethod === "claude.ai" || j.authMethod === "oauth_token") auth = SUBSCRIPTION;
      else if (j.authMethod && j.authMethod !== "none") auth = API_KEY;
      if (j.subscriptionType) plan = j.subscriptionType;
    } catch {
      if (st.code === 0 && /logged in/i.test(st.stdout) && !/not logged in/i.test(st.stdout)) loggedIn = true;
    }
  }
  if (loggedIn === undefined) {
    if (await exists(join(o.home, ".claude", ".credentials.json"))) {
      loggedIn = true;
      auth = SUBSCRIPTION;
    } else {
      try {
        const j = JSON.parse(await readFile(join(o.home, ".claude.json"), "utf8")) as { oauthAccount?: unknown };
        if (j.oauthAccount) {
          loggedIn = true;
          auth = SUBSCRIPTION;
        }
      } catch {
        /* no file */
      }
    }
  }
  if (loggedIn !== true) {
    if (o.env.CLAUDE_CODE_OAUTH_TOKEN) {
      loggedIn = true;
      auth = SUBSCRIPTION;
    } else if (apiKeyVars("claude").some((k) => o.env[k])) {
      loggedIn = true;
      auth = API_KEY;
    }
  }
  return { id: "claude", installed: true, version, loggedIn: loggedIn ?? true, ...(auth ? { auth } : {}), ...(plan ? { plan } : {}) };
}

export async function detectCodex(o: DetectCtx): Promise<AgentAvailability> {
  const path = await o.find("codex");
  if (!path) return { id: "codex", installed: false };
  const v = await o.exec(path, ["--version"]);
  const version = parseVersion(v.stdout + v.stderr);
  let loggedIn: boolean | undefined;
  let auth: AgentAvailability["auth"];
  // `codex login status`: "Logged in using ChatGPT" / "Logged in using an API key ..." / "Not logged in" (exit 1).
  const st = await o.exec(path, ["login", "status"]).catch(() => null);
  const out = st ? `${st.stdout}\n${st.stderr}`.toLowerCase() : "";
  if (out.includes("not logged in")) loggedIn = false;
  else if (out.includes("logged in")) {
    loggedIn = true;
    if (out.includes("chatgpt")) auth = SUBSCRIPTION;
    else if (out.includes("api key")) auth = API_KEY;
  }
  if (loggedIn === undefined) {
    // Older CLIs: read auth.json (ChatGPT login stores `tokens`, key login stores `OPENAI_API_KEY`).
    const codexHome = o.env.CODEX_HOME ?? join(o.home, ".codex");
    try {
      const j = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as { tokens?: unknown; OPENAI_API_KEY?: unknown };
      if (j.tokens) {
        loggedIn = true;
        auth = SUBSCRIPTION;
      } else if (typeof j.OPENAI_API_KEY === "string" && j.OPENAI_API_KEY) {
        loggedIn = true;
        auth = API_KEY;
      }
    } catch {
      /* no file */
    }
  }
  if (loggedIn !== true && apiKeyVars("codex").some((k) => o.env[k])) {
    loggedIn = true;
    auth = API_KEY;
  }
  return { id: "codex", installed: true, version, loggedIn: loggedIn ?? false, ...(auth ? { auth } : {}) };
}

export async function detectGemini(o: DetectCtx): Promise<AgentAvailability> {
  const path = await o.find("gemini");
  if (!path) return { id: "gemini", installed: false };
  const v = await o.exec(path, ["--version"]);
  const version = parseVersion(v.stdout + v.stderr);
  const loggedIn =
    (await exists(join(o.home, ".gemini", "oauth_creds.json"))) || Boolean(o.env.GEMINI_API_KEY) || Boolean(o.env.GOOGLE_API_KEY);
  return { id: "gemini", installed: true, version, loggedIn };
}

/** Detect all three CLIs in parallel. Always returns one entry per agent, in order claude, codex, gemini. */
export async function detect(opts: DetectOptions = {}): Promise<AgentAvailability[]> {
  const env = opts.env ?? process.env;
  // Probe the CLIs without API-key vars so their status reflects the subscription sign-in.
  const probeEnv = stripVars(env, [...apiKeyVars("claude"), ...apiKeyVars("codex")]);
  const o = {
    env,
    home: opts.home ?? homedir(),
    exec: opts.exec ?? ((file: string, args: string[], x?: { timeoutMs?: number }) => defaultExec(file, args, { ...x, env: probeEnv })),
    find: opts.find ?? ((name: string) => findOnPath(name, env)),
  };
  const log = opts.log ?? ((msg: string) => console.error(`[scarlet-agent] ${msg}`));
  const results = await Promise.all([detectClaude(o), detectCodex(o), detectGemini(o)]);
  return Promise.all(results.map(async (r) => {
    const path = r.installed && r.loggedIn !== false ? await o.find(r.id) : null;
    const catalog = path ? await (opts.catalog ?? discoverModels)(r.id as CliAgent, path, runnerEnv(r.id, results, env)).catch((err) => {
      log(`could not read the ${r.id} model list: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }) : undefined;
    return { ...r, ...catalog, ...(opts.models?.[r.id] ? { model: opts.models[r.id] } : {}) };
  }));
}

function loginLabel(a: AgentAvailability): string {
  if (a.loggedIn === false) return "not logged in";
  if (!a.loggedIn) return "login unknown";
  if (a.auth === SUBSCRIPTION) return a.plan ? `logged in (subscription: ${a.plan})` : "logged in (subscription)";
  if (a.auth === API_KEY) return "logged in (API key)";
  return "logged in";
}

export function formatAvailability(agents: AgentAvailability[]): string {
  return agents
    .map((a) => {
      if (!a.installed) return `${a.id.padEnd(7)} not installed`;
      const login = loginLabel(a);
      return `${a.id.padEnd(7)} ${a.version ?? "?"}  ${login}${a.model ? `  model ${a.model}` : ""}  (models: ${a.models?.join(", ")})`;
    })
    .join("\n");
}
