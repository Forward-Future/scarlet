import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { apiKeyVars, cmdShellArgs, defaultExec, detect, detectClaude, detectCodex, detectGemini, findOnPath, formatAvailability, needsCmdShell, runnerEnv, stripVars, type ExecFn } from "./detect.js";

/** Run the rest of the test as if on another OS. Paths and the file system stay this machine's. */
function onPlatform(platform: NodeJS.Platform) {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  onTestFinished(() => void Object.defineProperty(process, "platform", { value: real, configurable: true }));
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-detect-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("detect", () => {
  it("returns one entry per agent using the real PATH", async () => {
    const agents = await detect();
    expect(agents.map((a) => a.id)).toEqual(["claude", "codex", "gemini"]);
    const claude = agents[0]!;
    // CI machines may not have Claude Code; check the details only where it is.
    if (claude.installed) {
      expect(claude.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(typeof claude.loggedIn).toBe("boolean");
    }
    for (const a of agents) if (!a.installed) expect(a.models).toBeUndefined();
  }, 60_000);

  it("uses heuristics with fake find/exec", async () => {
    const exec: ExecFn = async (file, args) => {
      if (file.endsWith("claude") && args[0] === "--version") return { code: 0, stdout: "2.1.312 (Claude Code)\n", stderr: "" };
      if (file.endsWith("claude") && args[0] === "auth") return { code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
      if (file.endsWith("codex.cmd")) return { code: 0, stdout: "codex-cli 0.50.0\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const find = async (name: string) => (name === "claude" ? "/bin/claude" : name === "codex" ? "C:\\npm\\codex.cmd" : null);
    const agents = await detect({ exec, find, catalog: async () => ({ models: ["test-codex"], modelLabels: { "test-codex": "Test Codex" } }), home: "/nonexistent-home", env: { OPENAI_API_KEY: "sk-x" }, models: { claude: "sonnet" } });
    expect(agents[0]).toMatchObject({ id: "claude", installed: true, version: "2.1.312", loggedIn: false, model: "sonnet" });
    expect(agents[1]).toMatchObject({ id: "codex", installed: true, version: "0.50.0", loggedIn: true, models: ["test-codex"] });
    expect(agents[2]).toMatchObject({ id: "gemini", installed: false });
    expect(formatAvailability(agents)).toContain("gemini  not installed");
  });

  it("findOnPath resolves node on this machine", async () => {
    const env = { PATH: dirname(process.execPath) };
    expect(await findOnPath("node", env)).toBeTruthy();
    expect(await findOnPath("definitely-not-a-real-cli-xyz", env)).toBeNull();
  });

  it("reads subscription sign-in, plan and signed-out exit codes", async () => {
    const script = (claude: [number, string], codex: [number, string]): ExecFn =>
      async (file, args) => {
        if (args[0] === "--version") return { code: 0, stdout: "1.2.3", stderr: "" };
        if (file === "claude" && args[0] === "auth") return { code: claude[0], stdout: claude[1], stderr: "" };
        if (file === "codex" && args[0] === "login") return { code: codex[0], stdout: codex[1], stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      };
    const find = async (name: string) => (name === "gemini" ? null : name);
    const base = { find, catalog: async () => undefined, home: "/nonexistent-home", env: {} };
    let agents = await detect({
      ...base,
      exec: script([0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })], [0, "Logged in using ChatGPT\n"]),
    });
    expect(agents[0]).toMatchObject({ loggedIn: true, auth: "subscription", plan: "max" });
    expect(agents[1]).toMatchObject({ loggedIn: true, auth: "subscription" });
    expect(agents[1]?.models).toBeUndefined();
    expect(formatAvailability(agents)).toContain("subscription: max");

    // Signed out: claude prints JSON but exits 1; codex prints "Not logged in" and exits 1.
    const signedOut = script([1, JSON.stringify({ loggedIn: false, authMethod: "none" })], [1, "Not logged in\n"]);
    agents = await detect({ ...base, exec: signedOut });
    expect(agents[0]!.loggedIn).toBe(false);
    expect(agents[1]!.loggedIn).toBe(false);

    agents = await detect({ ...base, env: { ANTHROPIC_API_KEY: "sk-ant" }, exec: signedOut });
    expect(agents[0]).toMatchObject({ loggedIn: true, auth: "api_key" });
  });

  it("runnerEnv drops API keys only for agents signed in with a subscription", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai", PATH: "/bin" };
    const agents = [
      { id: "claude" as const, installed: true, loggedIn: true, auth: "subscription" as const },
      { id: "codex" as const, installed: true, loggedIn: true, auth: "api_key" as const },
    ];
    expect(runnerEnv("claude", agents, env)).toEqual({ OPENAI_API_KEY: "sk-oai", PATH: "/bin" });
    expect(runnerEnv("codex", agents, env)).toBe(env);
  });

  it("runs a batch shim under a folder with a space in its name", () => {
    const args = cmdShellArgs("C:\\Program Files\\nodejs\\codex.cmd", ["login", "status"]);
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // `cmd /s /c` drops the first and the last quote of the line. What is left has to keep the path in one piece.
    const line = args[3]!;
    const run = line.slice(0, line.indexOf('"')) + line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')) + line.slice(line.lastIndexOf('"') + 1);
    expect(run).toBe('"C:\\Program Files\\nodejs\\codex.cmd" login status');
  });

  it("on Windows, picks npm's .cmd shim over the extensionless shell script beside it", async () => {
    const dir = await tempDir();
    const other = await tempDir();
    // npm writes all three for every global CLI. Only the .cmd can be started from here.
    for (const name of ["codex", "codex.cmd", "codex.ps1"]) await writeFile(join(dir, name), "");
    await writeFile(join(other, "claude"), "");
    onPlatform("win32");
    expect(await findOnPath("codex", { PATH: dir })).toBe(join(dir, "codex.cmd"));
    expect(await findOnPath("codex", { Path: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toBe(join(dir, "codex.cmd"));
    // A name that already has an extension is looked up as written.
    expect(await findOnPath("codex.ps1", { PATH: dir })).toBe(join(dir, "codex.ps1"));
    // A file with no extension is still found when it is all there is.
    expect(await findOnPath("claude", { PATH: [dir, other].join(delimiter) })).toBe(join(other, "claude"));
    expect(await findOnPath("gemini", { PATH: dir })).toBeNull();
  });
});

/** A CLI that answers --version and whatever its sign-in status command prints. */
function cli(status: { code?: number; stdout?: string; stderr?: string } | "throws" = {}): ExecFn {
  return async (_file, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "", stderr: "tool 3.4.5-beta.1\n" };
    if (status === "throws") throw new Error("spawn EPERM");
    return { code: status.code ?? 0, stdout: status.stdout ?? "", stderr: status.stderr ?? "" };
  };
}

describe("sign-in detection without a status command to trust", () => {
  const base = async (exec: ExecFn, env: NodeJS.ProcessEnv = {}) => ({ find: async (name: string) => `/bin/${name}`, exec, env, home: await tempDir() });

  it("claude: falls back to its credential files, then the environment, and assumes signed in when it can't tell", async () => {
    // Status printed as text rather than JSON.
    expect(await detectClaude(await base(cli({ stdout: "Logged in as matt@example.com" })))).toEqual({ id: "claude", installed: true, version: "3.4.5-beta.1", loggedIn: true });
    const unknown = cli({ code: 1, stdout: "Not logged in" });

    const credentials = await base(unknown);
    await mkdir(join(credentials.home, ".claude"));
    await writeFile(join(credentials.home, ".claude", ".credentials.json"), "{}");
    expect(await detectClaude(credentials)).toMatchObject({ loggedIn: true, auth: "subscription" });

    const account = await base(cli("throws"));
    await writeFile(join(account.home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "matt@example.com" } }));
    expect(await detectClaude(account)).toMatchObject({ loggedIn: true, auth: "subscription" });

    const noAccount = await base(unknown);
    await writeFile(join(noAccount.home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
    expect(await detectClaude(noAccount)).toEqual({ id: "claude", installed: true, version: "3.4.5-beta.1", loggedIn: true });

    expect(await detectClaude(await base(unknown, { CLAUDE_CODE_OAUTH_TOKEN: "oauth" }))).toMatchObject({ loggedIn: true, auth: "subscription" });
    expect(await detectClaude(await base(unknown, { ANTHROPIC_AUTH_TOKEN: "gateway" }))).toMatchObject({ loggedIn: true, auth: "api_key" });
    // Signed out for certain: only a key in the environment changes that.
    const signedOut = cli({ code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) });
    expect(await detectClaude(await base(signedOut))).toEqual({ id: "claude", installed: true, version: "3.4.5-beta.1", loggedIn: false });
    // A provider login that is neither the subscription nor "none" bills a key.
    expect(await detectClaude(await base(cli({ stdout: JSON.stringify({ loggedIn: true, authMethod: "bedrock" }) })))).toMatchObject({ loggedIn: true, auth: "api_key" });
    expect(await detectClaude({ ...(await base(unknown)), find: async () => null })).toEqual({ id: "claude", installed: false });
  });

  it("codex: reads how it is signed in from the status text, then auth.json, then the environment; signed out otherwise", async () => {
    expect(await detectCodex(await base(cli({ stderr: "Logged in using an API key - sk-...abc" })))).toMatchObject({ loggedIn: true, auth: "api_key" });
    expect(await detectCodex(await base(cli({ stdout: "Logged in" })))).toEqual({ id: "codex", installed: true, version: "3.4.5-beta.1", loggedIn: true });

    const tokens = await base(cli("throws"));
    await mkdir(join(tokens.home, ".codex"));
    await writeFile(join(tokens.home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: "x" }, OPENAI_API_KEY: null }));
    expect(await detectCodex(tokens)).toMatchObject({ loggedIn: true, auth: "subscription" });

    // CODEX_HOME moves the file.
    const moved = await base(cli({ code: 1 }));
    const codexHome = await tempDir();
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-file" }));
    expect(await detectCodex(moved)).toMatchObject({ loggedIn: false });
    expect(await detectCodex({ ...moved, env: { CODEX_HOME: codexHome } })).toMatchObject({ loggedIn: true, auth: "api_key" });

    const empty = await base(cli({ code: 1 }));
    await mkdir(join(empty.home, ".codex"));
    await writeFile(join(empty.home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "" }));
    expect(await detectCodex(empty)).toEqual({ id: "codex", installed: true, version: "3.4.5-beta.1", loggedIn: false });
    expect(await detectCodex({ ...empty, env: { CODEX_API_KEY: "sk-env" } })).toMatchObject({ loggedIn: true, auth: "api_key" });
    // "Not logged in" wins over a stale file.
    expect(await detectCodex({ ...tokens, exec: cli({ code: 1, stdout: "Not logged in" }) })).toMatchObject({ loggedIn: false });
  });

  it("gemini: signed in with its OAuth file or either API key", async () => {
    const none = await base(cli());
    expect(await detectGemini(none)).toEqual({ id: "gemini", installed: true, version: "3.4.5-beta.1", loggedIn: false });
    expect(await detectGemini({ ...none, env: { GEMINI_API_KEY: "k" } })).toMatchObject({ loggedIn: true });
    expect(await detectGemini({ ...none, env: { GOOGLE_API_KEY: "k" } })).toMatchObject({ loggedIn: true });
    await mkdir(join(none.home, ".gemini"));
    await writeFile(join(none.home, ".gemini", "oauth_creds.json"), "{}");
    expect(await detectGemini(none)).toMatchObject({ loggedIn: true });
    expect(await detectGemini({ ...none, find: async () => null })).toEqual({ id: "gemini", installed: false });
    // A CLI that prints no version is still installed.
    expect(await detectGemini({ ...none, exec: async () => ({ code: 1, stdout: "", stderr: "" }) })).toEqual({ id: "gemini", installed: true, version: undefined, loggedIn: true });
  });
});

describe("detect: model lists", () => {
  const find = async (name: string) => name;
  const exec: ExecFn = async (file, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
    if (file === "claude") return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" };
    if (file === "codex") return { code: 1, stdout: "Not logged in", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  it("asks only signed-in CLIs, with the key variables dropped for a subscription", async () => {
    const asked: Array<[string, string, string[]]> = [];
    const agents = await detect({
      find, exec, home: await tempDir(), env: { ANTHROPIC_API_KEY: "sk-ant", GEMINI_API_KEY: "g", PATH: "/bin" },
      catalog: async (agent, path, env) => {
        asked.push([agent, path, Object.keys(env).sort()]);
        return { models: [`${agent}-1`], model: `${agent}-1` };
      },
      models: { gemini: "gemini-flash" },
    });
    expect(asked).toEqual([["claude", "claude", ["GEMINI_API_KEY", "PATH"]], ["gemini", "gemini", ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "PATH"]]]);
    expect(agents.map((a) => [a.id, a.models, a.model])).toEqual([["claude", ["claude-1"], "claude-1"], ["codex", undefined, undefined], ["gemini", ["gemini-1"], "gemini-flash"]]);
  });

  it("still lists an agent whose model list could not be read, and reports why", async () => {
    const lines: string[] = [];
    const agents = await detect({
      find, exec, home: await tempDir(), env: {}, log: (line) => lines.push(line),
      catalog: async (agent) => {
        if (agent === "claude") throw new Error("Node.js is required to launch the claude npm CLI");
        return undefined;
      },
    });
    expect(agents[0]).toEqual({ id: "claude", installed: true, version: "1.0.0", loggedIn: true, auth: "subscription" });
    expect(lines).toEqual(["could not read the claude model list: Node.js is required to launch the claude npm CLI"]);
  });
});

describe("detect helpers", () => {
  it("formatAvailability words each sign-in state", () => {
    expect(formatAvailability([
      { id: "claude", installed: true, version: "2.1.0", loggedIn: true, auth: "subscription", models: ["opus", "sonnet"], model: "opus" },
      { id: "codex", installed: true, version: "0.50.0", loggedIn: true, auth: "api_key", models: ["gpt-5"] },
      { id: "gemini", installed: true, loggedIn: false },
      { id: "claude", installed: true, version: "2.1.0", loggedIn: true },
      { id: "codex", installed: true, version: "0.50.0" },
    ]).split("\n")).toEqual([
      "claude  2.1.0  logged in (subscription)  model opus  (models: opus, sonnet)",
      "codex   0.50.0  logged in (API key)  (models: gpt-5)",
      // With no model list, only the line up to the sign-in state is settled.
      expect.stringMatching(/^gemini  \?  not logged in( |$)/),
      expect.stringMatching(/^claude  2\.1\.0  logged in( |$)/),
      expect.stringMatching(/^codex   0\.50\.0  login unknown( |$)/),
    ]);
  });

  it("names the key variables per agent and drops them whatever their case", () => {
    expect(apiKeyVars("claude")).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    expect(apiKeyVars("codex")).toEqual(["OPENAI_API_KEY", "CODEX_API_KEY"]);
    expect(apiKeyVars("gemini")).toEqual([]);
    // Windows environment names are case-insensitive.
    expect(stripVars({ Openai_Api_Key: "sk", Path: "C:\\bin", HOME: "/h" }, ["OPENAI_API_KEY"])).toEqual({ Path: "C:\\bin", HOME: "/h" });
  });

  it("only Windows batch shims need cmd.exe", () => {
    expect(needsCmdShell("C:\\npm\\codex.cmd")).toBe(process.platform === "win32");
    onPlatform("win32");
    expect(["C:\\npm\\codex.cmd", "C:\\npm\\run.BAT", "C:\\bin\\claude.exe", "C:\\npm\\codex", "C:\\npm\\codex.ps1"].map(needsCmdShell)).toEqual([true, true, false, false, false]);
  });
});

describe("defaultExec", { timeout: 20_000 }, () => {
  it("captures both streams and the exit code, in the environment it is given", async () => {
    const result = await defaultExec(process.execPath, ["-e", "console.log(process.env.PROBE);console.error('warned');process.exit(3)"], { env: { ...process.env, PROBE: "probed" } });
    expect(result).toEqual({ code: 3, stdout: "probed\n", stderr: "warned\n" });
  });
  it("reports a CLI that can't be started as a result, not an exception", async () => {
    const result = await defaultExec(join(await tempDir(), "no-such-cli"), ["--version"]);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/ENOENT/);
  });
  it("stops a probe that hangs", async () => {
    const started = Date.now();
    const result = await defaultExec(process.execPath, ["-e", "console.log('started');setInterval(()=>{},1000)"], { timeoutMs: 2000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.stdout).toBe("started\n");
    expect(result.code).not.toBe(0);
  });
  it("stops a timed-out probe together with the child holding its output pipe", async () => {
    const ready = join(await tempDir(), "ready");
    const childScript = `
      const fs = require('node:fs');
      const ready = ${JSON.stringify(ready)};
      fs.writeFileSync(ready + '.tmp', String(process.pid));
      fs.renameSync(ready + '.tmp', ready);
      setTimeout(() => console.log('child finished'), 10_000);
    `;
    const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio:'inherit'});setInterval(() => {}, 1000)`;
    // Start the real process tree before firing the probe deadline, even on a busy Windows runner.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const probe = defaultExec(process.execPath, ["-e", script], { timeoutMs: 500 });
    try {
      const startup = AbortSignal.timeout(15_000);
      while (!existsSync(ready)) await delay(10, undefined, { signal: startup });
    } finally {
      vi.advanceTimersByTime(500);
      vi.useRealTimers();
    }
    const result = await probe;
    const childPid = Number(await readFile(ready, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    await expect.poll(() => {
      try { process.kill(childPid, 0); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    }, { timeout: 5_000 }).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.code).not.toBe(0);
  });
});
