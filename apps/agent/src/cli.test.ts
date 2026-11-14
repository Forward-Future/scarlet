import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as mock from "@scarlet/mcp/mock";
import { main, parseArgv } from "./cli.js";
import * as host from "./host.js";
import * as runners from "./runners/index.js";
import { configPath, loadConfig, saveConfig } from "./config.js";

describe("parseArgv", () => {
  it("defaults to help and splits the command from flags and positionals", () => {
    expect(parseArgv([])).toEqual({ command: "help", flags: {}, positional: [] });
    expect(parseArgv(["run", "--project", "prj_1", "--agent=codex", "Make", "the first cut"])).toEqual({
      command: "run", flags: { project: "prj_1", agent: "codex" }, positional: ["Make", "the first cut"],
    });
  });
  it("keeps everything after the first = of an inline value", () => {
    expect(parseArgv(["connect", "--token=abc=def==", "--server=http://localhost:4000/?a=b"]).flags).toEqual({ token: "abc=def==", server: "http://localhost:4000/?a=b" });
    expect(parseArgv(["connect", "--name="]).flags).toEqual({ name: "" });
  });
  it("reads a flag with no value as true, and never takes another flag as its value", () => {
    expect(parseArgv(["start", "--verbose"])).toEqual({ command: "start", flags: { verbose: "true" }, positional: [] });
    expect(parseArgv(["run", "--dry", "--project", "p", "-x", "--timeout", "-5"])).toEqual({
      command: "run", flags: { dry: "true", project: "p", timeout: "-5" }, positional: ["-x"],
    });
  });
});

/** A scratch SCARLET_HOME, with no server or token from the environment. */
async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-cli-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  vi.stubEnv("SCARLET_HOME", dir);
  vi.stubEnv("SCARLET_SERVER", "");
  vi.stubEnv("SCARLET_TOKEN", "");
  return dir;
}

/** What the command printed, one entry per console call. */
function output() {
  const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const text = (spy: typeof out) => spy.mock.calls.map((call) => call.join(" "));
  return { out: () => text(out), err: () => text(err) };
}

// A stand-in for Claude Code, signed in with a subscription. FAKE_CLAUDE picks what a run does.
const FAKE_CLAUDE = `#!/bin/sh
case "$*" in
  --version) echo "2.1.0 (Claude Code)" ;;
  "auth status") echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' ;;
  "auth login --claudeai") exit "\${FAKE_CLAUDE_LOGIN:-0}" ;;
  *--input-format*) cat > /dev/null ;;
  *)
    cat > /dev/null
    echo '{"type":"system","subtype":"init","session_id":"s1","mcp_servers":[{"name":"scarlet","status":"connected"}]}'
    if [ "$FAKE_CLAUDE" = "fails" ]; then
      echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Rate limited"}'
    else
      echo '{"type":"result","subtype":"success","is_error":false,"result":"Proposed chg_1."}'
    fi ;;
esac
`;

/** Put only the stand-in CLI (or nothing) ahead of the system tools on PATH. */
async function pathWith(cli?: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-cli-bin-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  if (cli) {
    await writeFile(join(dir, "claude"), cli);
    await chmod(join(dir, "claude"), 0o755);
  }
  vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
}

describe("scarlet-agent", { timeout: 30_000 }, () => {
  const exitCode = process.exitCode;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });

  it("prints the usage for no command or one it doesn't know", async () => {
    const { out } = output();
    await main([]);
    await main(["frobnicate"]);
    expect(out()).toHaveLength(2);
    for (const usage of out()) expect(usage).toMatch(/^scarlet-agent <command>\n[\s\S]*connect --server URL[\s\S]*\n  start /);
  });

  it("says what is missing before a host or a run can start", async () => {
    const dir = await home();
    await expect(main(["start"])).rejects.toThrow("No server configured. Run `scarlet-agent connect --server URL` or set SCARLET_SERVER.");
    await saveConfig({ server: "http://localhost:4000" }, { SCARLET_HOME: dir });
    await expect(main(["run", "--project", "p", "cut it"])).rejects.toThrow("No token configured.");
    await saveConfig({ server: "http://localhost:4000", token: "agent-token" }, { SCARLET_HOME: dir });
    await expect(main(["run", "cut it"])).rejects.toThrow("--project is required");
    await expect(main(["run", "--project", "p", "  "])).rejects.toThrow("instruction is required");
    await expect(main(["auth", "gemini"])).rejects.toThrow("usage: scarlet-agent auth claude|codex");
  });

  it.skipIf(process.platform === "win32")("names the package to install when the CLI to sign in to is missing", async () => {
    await home();
    await pathWith();
    output();
    await expect(main(["auth"])).rejects.toThrow("claude is not installed (npm i -g @anthropic-ai/claude-code)");
    await expect(main(["auth", "codex"])).rejects.toThrow("codex is not installed (npm i -g @openai/codex)");
  });

  it.skipIf(process.platform === "win32")("status lists every agent and where the host is connected", async () => {
    const dir = await home();
    await pathWith(FAKE_CLAUDE);
    const { out } = output();
    await main(["status"]);
    expect(out()).toEqual([
      expect.stringMatching(/^claude  2\.1\.0  logged in \(subscription: max\).*\ncodex   not installed\ngemini  not installed$/),
      "\nnot connected (scarlet-agent connect --server URL)",
    ]);
    await saveConfig({ server: "http://localhost:4000", token: "agent-token", hostId: "host_9", models: { claude: "opus" } }, { SCARLET_HOME: dir });
    await main(["status"]);
    expect(out()[2]).toContain("logged in (subscription: max)  model opus  ");
    expect(out()[3]).toBe("\nserver: http://localhost:4000  host: host_9");
  });

  it.skipIf(process.platform === "win32")("auth runs the CLI's own sign-in, shows the result and fails when the sign-in did", async () => {
    const dir = await home();
    await pathWith(FAKE_CLAUDE);
    const { out } = output();
    await main(["auth", "claude"]);
    expect(out()).toEqual([
      "Signing in to claude with your Claude Pro/Max subscription. A browser window will open…",
      expect.stringMatching(/^\nclaude  2\.1\.0  logged in \(subscription: max\).*$/),
    ]);
    expect(process.exitCode).toBe(exitCode);

    await saveConfig({ server: "http://localhost:4000", token: "agent-token" }, { SCARLET_HOME: dir });
    await main(["auth", "claude"]);
    expect(out().at(-1)).toBe("Restart `scarlet-agent start` (if running) so the server sees the new sign-in.");

    vi.stubEnv("FAKE_CLAUDE_LOGIN", "1");
    await main(["auth", "claude"]);
    expect(process.exitCode).toBe(1);
    expect(out().at(-1)).not.toContain("Restart");
  });

  it("connect checks the token with the engine, saves it, and keeps the host id only for the same engine", async () => {
    const dir = await home();
    const state = mock.makeState();
    const tokens: Array<string | undefined> = [];
    state.extra = (req, res) => {
      if (req.path !== "/auth/me") return false;
      tokens.push(req.headers.authorization);
      const ok = req.headers.authorization === "Bearer good-token";
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { user: { id: "u1", name: "Matt" } } : { error: { code: "unauthorized", message: "Bad token" } }));
      return true;
    };
    const server = await mock.startMockServer(state);
    onTestFinished(() => server.close());
    const { out } = output();
    const saved = () => loadConfig({ SCARLET_HOME: dir });

    await expect(main(["connect", "--server", server.url, "--token", "bad-token"])).rejects.toThrow("--token-file");
    expect(tokens).toHaveLength(0);
    expect(await readdir(dir)).toEqual([]);

    vi.stubEnv("SCARLET_TOKEN", "bad-token");
    await expect(main(["connect", "--server", server.url])).rejects.toThrow("Bad token");
    expect(tokens).toEqual(["Bearer bad-token"]);
    vi.stubEnv("SCARLET_TOKEN", "");
    const file = join(dir, "token");
    await writeFile(file, "bad-token", { mode: 0o600 });
    await expect(main(["connect", "--server", server.url, "--token-file", file])).rejects.toThrow("Bad token");
    await writeFile(file, "good-token");
    await main(["connect", "--server", server.url, "--token-file", file, "--name", "edit-bay"]);
    expect(out()[0]).toBe(`Connected to ${server.url} as Matt.`);
    expect(await saved()).toEqual({ server: server.url, token: "good-token", name: "edit-bay" });

    // The same engine again, written differently: the saved token and the host's registration carry over.
    await saveConfig({ ...(await saved()), hostId: "host_1" }, { SCARLET_HOME: dir });
    await main(["login", "--server", `${server.url}/`]);
    expect(tokens.at(-1)).toBe("Bearer good-token");
    expect(await saved()).toEqual({ server: `${server.url}/`, token: "good-token", name: "edit-bay", hostId: "host_1" });

    // Another engine: neither is sent or kept.
    const other = await mock.startMockServer(state);
    onTestFinished(() => other.close());
    await main(["connect", "--server", other.url, "--token-file", file]);
    expect(await saved()).toEqual({ server: other.url, token: "good-token", name: "edit-bay" });
    expect(JSON.parse(await readFile(configPath({ SCARLET_HOME: dir }), "utf8"))).not.toHaveProperty("hostId");
  });

  describe.skipIf(process.platform === "win32")("run", () => {
    async function engine(skillsStatus = 200) {
      const state = mock.makeState();
      state.skills = [
        { id: "s1", name: "first-cut-dialogue", description: "First cut", content: "---\nname: first-cut-dialogue\n---\n# First cut\nDo it.", scope: "team", ownerId: null, projectId: null, agents: [], enabled: true, version: 1 },
      ];
      state.extra = (req, res) => {
        if (req.path !== "/skills" || skillsStatus === 200) return false;
        res.writeHead(skillsStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "unavailable", message: "skills are being reindexed" } }));
        return true;
      };
      const server = await mock.startMockServer(state);
      onTestFinished(() => server.close());
      const dir = await home();
      await saveConfig({ server: server.url, token: "agent-token" }, { SCARLET_HOME: dir });
      await pathWith(FAKE_CLAUDE);
      return { server, dir };
    }

    it("runs one instruction against a project in a private one-shot folder and prints what the agent did", async () => {
      const { server, dir } = await engine();
      const { out, err } = output();
      const launch = vi.spyOn(runners, "runAgent");
      await main(["run", "--project", "prj_test", "Make", "the first cut"]);
      expect(out()).toEqual(["[log] Claude Code session started; Scarlet MCP connected", "[result] Proposed chg_1.", "\nOK\nProposed chg_1."]);
      expect(err()).toEqual([]);
      expect(process.exitCode).toBe(0);
      expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /projects/prj_test", "GET /skills"]);
      expect(Object.fromEntries(server.requests[1]!.query)).toEqual({ projectId: "prj_test", view: "prompt" });
      const [oneshot] = await readdir(join(dir, "work"));
      expect(oneshot).toMatch(/^oneshot-/);
      const folder = join(dir, "work", oneshot!);
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      // The project's skills reach the prompt, and the MCP server is pointed at the project and the folder's artifacts.
      const options = launch.mock.calls[0]![0];
      expect(options.systemPrompt).toContain("first-cut-dialogue");
      expect(options.mcp.env).toEqual({
        SCARLET_SERVER: server.url, SCARLET_TOKEN: "agent-token", SCARLET_PROJECT: "prj_test", SCARLET_AGENT: "claude", SCARLET_WORKDIR: join(folder, "artifacts"),
      });
      expect(await readdir(folder)).toEqual(["artifacts"]);
    });

    it("still runs, and says so, when the project's skills can't be loaded", async () => {
      await engine(503);
      const { out, err } = output();
      const launch = vi.spyOn(runners, "runAgent");
      await main(["run", "--project", "prj_test", "Make the first cut"]);
      expect(err()).toEqual(["[scarlet-agent] could not load the project's skills; running without them: skills are being reindexed"]);
      expect(out().at(-1)).toBe("\nOK\nProposed chg_1.");
      expect(launch.mock.calls[0]![0].systemPrompt).not.toContain("first-cut-dialogue");
    });

    it("exits 1 with the agent's error when the run fails", async () => {
      const { dir } = await engine();
      vi.stubEnv("FAKE_CLAUDE", "fails");
      const { out } = output();
      await main(["run", "--project", "prj_test", "--agent", "claude", "Make the first cut"]);
      expect(out().at(-1)).toBe("\nFAILED\nRate limited\nerror: Rate limited");
      expect(process.exitCode).toBe(1);
      const [oneshot] = await readdir(join(dir, "work"));
      expect(await readdir(join(dir, "work", oneshot!))).toEqual(["artifacts"]);
    });

    it("reports a cleanup failure alongside the completed run", async () => {
      await engine();
      const { out, err } = output();
      vi.spyOn(host, "removeControlFiles").mockRejectedValueOnce(new Error("file is busy"));
      await main(["run", "--project", "prj_test", "Make the first cut"]);
      expect(process.exitCode).toBe(0);
      expect(out().at(-1)).toBe("\nOK\nProposed chg_1.");
      expect(err()).toEqual([expect.stringContaining("file is busy")]);
    });
  });
});
