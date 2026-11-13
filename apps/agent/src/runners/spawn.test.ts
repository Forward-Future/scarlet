import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { mcpEnv, nodeExecutable, quoteForCmd, resolveCli, resolveMcpCliPath, runnerSpec, spawnLines, spawnSpec, tailSummary, type SpawnLinesOptions } from "./spawn.js";

/** Run the rest of the test as if on another OS. Paths and the file system stay this machine's. */
function onPlatform(platform: NodeJS.Platform) {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  onTestFinished(() => void Object.defineProperty(process, "platform", { value: real, configurable: true }));
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-spawn-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function node(script: string, opts: Partial<SpawnLinesOptions> = {}) {
  const lines: string[] = [];
  const handle = spawnLines(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env, onLine: (line) => lines.push(line), ...opts });
  return { handle, lines, done: handle.done };
}

describe("spawnLines", { timeout: 20_000 }, () => {
  it("delivers whole lines: CRLF trimmed, blank lines dropped, a last line with no newline kept", async () => {
    const { lines, done } = node(String.raw`process.stdout.write("one\r\n\n   \ntw");setTimeout(()=>process.stdout.write("o\nthree"),50)`);
    expect(await done).toMatchObject({ code: 0, signal: null, timedOut: false, stalled: false, aborted: false, killed: false, stderr: "" });
    expect(lines).toEqual(["one", "tw" + "o", "three"]);
  });

  it("writes the given stdin and closes it; with none, the CLI sees end of input at once", async () => {
    const echo = "process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase())).on('end',()=>console.log('\\nclosed'))";
    const fed = node(echo, { stdin: "make the cut" });
    await fed.done;
    expect(fed.lines).toEqual(["MAKE THE CUT", "closed"]);
    const empty = node(echo);
    await empty.done;
    expect(empty.lines).toEqual(["closed"]);
  });

  it("keeps stdin open for a conversation when interactive", async () => {
    const talk = node("process.stdin.on('data',d=>{console.log('got '+String(d).trim());process.exit(0)});console.log('ready')", {
      interactive: true,
      onLine: (line) => {
        talk.lines.push(line);
        if (line === "ready") talk.handle.child.stdin!.write("hello\n");
      },
    });
    expect((await talk.done).code).toBe(0);
    expect(talk.lines).toEqual(["ready", "got hello"]);
  });

  it("stops a CLI that is still talking at the time cap, as timed out and not stalled", async () => {
    const started = Date.now();
    const { done } = node("setInterval(()=>console.log('still working'),50)", { timeoutMs: 400, stallMs: 5000 });
    const outcome = await done;
    expect(outcome).toMatchObject({ timedOut: true, stalled: false, aborted: false, killed: true });
    expect(outcome.code === null || process.platform === "win32").toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops at once when the run was already cancelled before it began", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await node("setInterval(()=>{},1000)", { signal: controller.signal }).done;
    expect(outcome).toMatchObject({ aborted: true, timedOut: false, killed: true });
  });

  it("resolves with the spawn error instead of throwing when the executable can't be started", async () => {
    const lines: string[] = [];
    const outcome = await spawnLines(join(await tempDir(), "no-such-cli"), ["--version"], { cwd: process.cwd(), env: process.env, onLine: (line) => lines.push(line) }).done;
    expect(outcome).toMatchObject({ code: null, signal: null, timedOut: false, aborted: false });
    expect(outcome.stderr).toMatch(/^\nspawn error: spawn .*no-such-cli ENOENT$/);
    expect(lines).toEqual([]);
  });

  it("passes stderr on as it arrives and keeps only its recent end", async () => {
    const chunks: string[] = [];
    const { done } = node("process.stderr.write('first line\\n'+'x'.repeat(70000));setTimeout(()=>process.stderr.write('\\nthe reason it failed'),50);setTimeout(()=>process.exit(2),100)", { onStderr: (chunk) => chunks.push(chunk) });
    const outcome = await done;
    expect(outcome.code).toBe(2);
    expect(chunks.join("")).toHaveLength("first line\n".length + 70_000 + "\nthe reason it failed".length);
    expect(outcome.stderr.length).toBeLessThanOrEqual(64_000);
    expect(outcome.stderr.endsWith("\nthe reason it failed")).toBe(true);
    expect(outcome.stderr).not.toContain("first line");
  });
});

describe("Windows launchers", () => {
  it("only batch shims go through cmd.exe, wrapped so a path with a space survives", () => {
    onPlatform("win32");
    const comspec = process.env.ComSpec;
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    onTestFinished(() => void (comspec === undefined ? delete process.env.ComSpec : (process.env.ComSpec = comspec)));
    expect(spawnSpec("C:\\Program Files\\nodejs\\codex.CMD", ["exec", "--cd", "C:\\my work", ""])).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\codex.CMD" exec --cd "C:\\my work" """'],
      verbatim: true,
    });
    expect(spawnSpec("C:\\tools\\run.bat", []).args[3]).toBe('"C:\\tools\\run.bat"');
    expect(spawnSpec("C:\\Program Files\\claude\\claude.exe", ["-p"])).toEqual({ file: "C:\\Program Files\\claude\\claude.exe", args: ["-p"], verbatim: false });
    expect(quoteForCmd("")).toBe('""');
    for (const risky of ["a&b", "a|b", "a<b", "a>b", "a^b", "(a)", "100%", "wow!"]) expect(quoteForCmd(risky)).toBe(`"${risky}"`);
  });

  /** An npm global install: the .cmd shim, and the package with its manifest beside it. */
  async function npmInstall(shim: string, pkg: string, manifest: object): Promise<string> {
    const dir = await tempDir();
    await mkdir(join(dir, "node_modules", pkg), { recursive: true });
    await writeFile(join(dir, "node_modules", pkg, "package.json"), JSON.stringify(manifest));
    return join(dir, shim);
  }

  it("starts an npm CLI's own entry point with Node, so no task argument is ever read by cmd.exe", async () => {
    onPlatform("win32");
    const codex = await npmInstall("codex.cmd", "@openai/codex", { bin: { codex: "bin/codex.js" } });
    expect(runnerSpec(codex, ["exec", "a & b"], {})).toEqual({
      file: process.execPath, args: [join(dirname(codex), "node_modules", "@openai/codex", "bin/codex.js"), "exec", "a & b"], verbatim: false,
    });
    // A manifest can name its one entry point as a string, and the shim's name is matched whatever its case.
    const claude = await npmInstall("Claude.CMD", "@anthropic-ai/claude-code", { bin: "cli.mjs" });
    expect(runnerSpec(claude, ["-p"], {}).args).toEqual([join(dirname(claude), "node_modules", "@anthropic-ai/claude-code", "cli.mjs"), "-p"]);
    // A package that ships a native binary is started directly.
    const native = await npmInstall("gemini.cmd", "@google/gemini-cli", { bin: { gemini: "bin/gemini.exe" } });
    expect(runnerSpec(native, ["--sandbox"], {})).toEqual({ file: join(dirname(native), "node_modules", "@google/gemini-cli", "bin/gemini.exe"), args: ["--sandbox"], verbatim: false });
  });

  it("refuses a batch launcher it can't resolve to an npm entry point", async () => {
    onPlatform("win32");
    expect(() => runnerSpec("C:\\tools\\my-agent.bat", [], {})).toThrow("Batch launchers are unsupported for agent tasks. Use the native or npm CLI.");
    expect(() => runnerSpec(join(tmpdir(), "scarlet-no-such-dir", "codex.cmd"), [], {})).toThrow(/ENOENT/);
    const renamed = await npmInstall("codex.cmd", "@openai/codex", { bin: { "codex-helper": "helper.js" } });
    expect(() => runnerSpec(renamed, [], {})).toThrow("No npm entry point for codex");
    const script = await npmInstall("codex.cmd", "@openai/codex", { bin: { codex: "bin/codex.sh" } });
    expect(() => runnerSpec(script, [], {})).toThrow("Unsupported npm agent executable");
  });

  it("leaves everything that isn't a batch shim as it is", () => {
    expect(runnerSpec("/usr/local/bin/claude", ["-p", "a b"], {})).toEqual({ file: "/usr/local/bin/claude", args: ["-p", "a b"], verbatim: false });
    onPlatform("win32");
    expect(runnerSpec("C:\\Program Files\\claude\\claude.exe", ["-p"], {})).toEqual({ file: "C:\\Program Files\\claude\\claude.exe", args: ["-p"], verbatim: false });
  });
});

describe("spawn helpers", () => {
  it("resolveCli takes an explicit path as given, else the first match on PATH, else says the CLI is missing", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "codex"), "", { mode: 0o755 });
    expect(await resolveCli("codex", "/opt/custom/codex", { PATH: dir })).toBe("/opt/custom/codex");
    expect(await resolveCli("codex", undefined, { PATH: [await tempDir(), dir].join(delimiter) })).toBe(join(dir, "codex"));
    await expect(resolveCli("gemini", undefined, { PATH: dir })).rejects.toThrow("gemini CLI not found on PATH");
    await expect(resolveCli("gemini", "", {})).rejects.toThrow("gemini CLI not found on PATH");
  });

  it.skipIf(process.platform === "win32")("finds a runnable CLI past directories and non-executable files of the same name", async () => {
    const directory = await tempDir(), plain = await tempDir(), installed = await tempDir();
    await mkdir(join(directory, "codex"));
    await writeFile(join(plain, "codex"), "", { mode: 0o644 });
    await writeFile(join(installed, "codex"), "", { mode: 0o755 });
    for (const shadow of [directory, plain]) {
      const path = [shadow, relative(process.cwd(), installed)].join(delimiter);
      expect(await resolveCli("codex", undefined, { PATH: path })).toBe(join(installed, "codex"));
    }
  });

  it("resolveMcpCliPath honours SCARLET_MCP_CLI, and the MCP server runs under this Node", () => {
    expect(resolveMcpCliPath({ SCARLET_MCP_CLI: "/opt/scarlet/mcp-cli.js" })).toBe("/opt/scarlet/mcp-cli.js");
    expect(nodeExecutable()).toBe(process.execPath);
  });

  it("mcpEnv keeps only the variables that have a value", () => {
    expect(mcpEnv({ SCARLET_SERVER: "http://localhost:4000", SCARLET_TASK: undefined, SCARLET_MODEL: "", SCARLET_AGENT: "claude" }))
      .toEqual({ SCARLET_SERVER: "http://localhost:4000", SCARLET_AGENT: "claude" });
  });

  it("tailSummary joins what the agent said and keeps the end when it is long", () => {
    expect(tailSummary([])).toBe("");
    expect(tailSummary(["", "Read the transcript.", "", "Cut the pause.\n"])).toBe("Read the transcript.\nCut the pause.");
    expect(tailSummary(["a".repeat(30), "the end"], 10)).toBe("…aa\nthe end");
    expect(tailSummary(["exactly ten"], 11)).toBe("exactly ten");
  });
});
