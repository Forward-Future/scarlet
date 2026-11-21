import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { killStoppedNow, repeatStop, stopOrphans, stillRuns } from "../processTree.js";
import { ASLEEP_AFTER_MS, mcpEnv, nodeExecutable, quoteForCmd, resolveCli, resolveMcpCliPath, runnerSpec, spawnLines, spawnSpec, tailSummary, watchClock, type SpawnLinesOptions } from "./spawn.js";

// The stop goes through as usual unless a test asks to lose the next one, as a process being forked at that moment would.
const stops = vi.hoisted(() => ({ calls: 0, kills: 0, lose: 0 }));
vi.mock("../processTree.js", async (real) => {
  const actual = await real<typeof import("../processTree.js")>();
  return { ...actual, stopCliTree: (...args: Parameters<typeof actual.stopCliTree>) => {
    stops.calls++;
    if (stops.lose > 0) { stops.lose--; return; }
    actual.stopCliTree(...args);
  }, killCliTree: (...args: Parameters<typeof actual.killCliTree>) => {
    stops.kills++;
    actual.killCliTree(...args);
  } };
});

/** Wait until `check` holds, or fail after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  it.skipIf(process.platform === "win32")("kills the group when the first stop is missed, and sends nothing once the CLI is gone", async () => {
    stops.calls = 0;
    stops.kills = 0;
    stops.lose = 1;
    const started = Date.now();
    const { handle, done } = node("console.log('up');setTimeout(()=>{},30000)", { killAfterMs: 300, onLine: () => handle.kill() });
    expect(await done).toMatchObject({ killed: true, signal: "SIGKILL" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect([stops.calls, stops.kills]).toEqual([1, 1]);

    stops.calls = 0;
    stops.kills = 0;
    const quick = node("console.log('done')", { killAfterMs: 100 });
    await quick.done;
    quick.handle.kill();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect([stops.calls, stops.kills]).toEqual([0, 0]);
  });

  it.skipIf(process.platform === "win32")("asks a CLI to stop and lets it finish (Claude Code writes its session then), killing it only once its time is up", async () => {
    const dir = await tempDir();
    const polite = join(dir, "polite");
    // A CLI that tidies up when asked to stop, as Claude Code does: SIGKILL would give it no chance.
    const tidy = node(`process.on("SIGTERM",()=>{require("fs").writeFileSync(${JSON.stringify(polite)},"saved");process.exit(0)});console.log("up");setInterval(()=>{},1000)`,
      { onLine: () => tidy.handle.kill() });
    expect(await tidy.done).toMatchObject({ killed: true, code: 0, signal: null });
    expect(await readFile(polite, "utf8")).toBe("saved");

    // One that ignores the request is killed after its time to finish, with whatever it started.
    const started = Date.now();
    const deaf = node(`process.on("SIGTERM",()=>{});console.log("up");setInterval(()=>{},1000)`, { killAfterMs: 400, onLine: () => deaf.handle.kill() });
    expect(await deaf.done).toMatchObject({ killed: true, signal: "SIGKILL" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it.skipIf(process.platform === "win32")("at exit, kills the group of a CLI it has just asked to stop", async () => {
    const dir = await tempDir();
    const pids = join(dir, "pids");
    // The CLI leaves at once when asked; the process it started ignores the request and holds on.
    const script = `const c=require("child_process").spawn("sh",["-c","trap '' TERM; echo $$ > ${pids}; while :; do sleep 0.1; done"],{stdio:"ignore"});` +
      `process.on("SIGTERM",()=>process.exit(0));console.log("up");setInterval(()=>{},1000)`;
    const run = node(script, { killAfterMs: 60_000, onLine: () => void until(async () => !!(await readFile(pids, "utf8").catch(() => ""))).then(() => run.handle.kill()) });
    await run.done;
    const straggler = Number((await readFile(pids, "utf8")).trim());
    onTestFinished(() => { try { process.kill(straggler, "SIGKILL"); } catch { /* gone */ } });
    expect(alive(straggler)).toBe(true);
    killStoppedNow();
    await until(() => !alive(straggler));
  });

  it.skipIf(process.platform === "win32")("doesn't count time the computer slept toward a run's stall or time limit", async () => {
    // The computer sleeps for an hour a moment into each run: both the watchdog's clock and the wall clock jump.
    const sleepFor = (ms: number) => {
      const [clock, wall] = [watchClock.now, Date.now];
      const at = clock() + 300;
      vi.spyOn(watchClock, "now").mockImplementation(() => clock() + (clock() >= at ? ms : 0));
      vi.spyOn(Date, "now").mockImplementation(() => wall() + (clock() >= at ? ms : 0));
      onTestFinished(() => { vi.restoreAllMocks(); });
    };
    sleepFor(60 * 60_000);
    const quiet = await node("setTimeout(()=>{},2500)", { stallMs: 2000 }).done;
    expect(quiet).toMatchObject({ code: 0, stalled: false, timedOut: false, killed: false });
    vi.restoreAllMocks();
    sleepFor(60 * 60_000);
    const busy = await node("setInterval(()=>console.log('working'),100);setTimeout(()=>process.exit(0),2500)", { timeoutMs: 2000 }).done;
    expect(busy).toMatchObject({ code: 0, timedOut: false, killed: false });
    vi.restoreAllMocks();
    // A clock a few seconds late is a busy machine, not sleep: it counts, and a quiet CLI still stalls.
    sleepFor(ASLEEP_AFTER_MS / 6);
    expect(await node("setTimeout(()=>{},5000)", { stallMs: 2000 }).done).toMatchObject({ stalled: true, timedOut: true, killed: true });
  });

  it("on Windows, sends the tree kill again only while the CLI lives, and after that stops waiting on its output", () => {
    const live = { exitCode: null, signalCode: null };
    const exited = { exitCode: 1, signalCode: null };
    const killed = { exitCode: null, signalCode: "SIGTERM" as const };
    expect(repeatStop(live, "win32")).toBe("kill-tree");
    expect(repeatStop(exited, "win32")).toBe("release-output");
    expect(repeatStop(killed, "win32")).toBe("release-output");
    // POSIX kills the whole group again, leader or not.
    for (const child of [live, exited, killed]) expect(repeatStop(child, "darwin")).toBe("kill-tree");
  });

  it.skipIf(process.platform === "win32")("on Windows, settles a stopped run whose CLI died while a process it started keeps the output open", async () => {
    // The CLI starts a straggler on the same stdout and stays up until stopped.
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore','inherit','inherit']});console.log('pid '+c.pid);setTimeout(()=>{},30000)";
    let straggler = 0;
    const { handle, done } = node(script, { onLine: line => { straggler = Number(line.slice(4)); onPlatform("win32"); handle.kill(); } });
    onTestFinished(() => { try { process.kill(straggler, "SIGKILL"); } catch { /* gone */ } });
    const started = Date.now();
    // taskkill isn't here, so the first stop falls back to killing the CLI alone, as a tree walk that missed the straggler would.
    expect(await done).toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(() => process.kill(straggler, 0)).not.toThrow();
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

describe.skipIf(process.platform === "win32")("CLIs an earlier launch left running", { timeout: 20_000 }, () => {
  /** A process that stays up until stopped, as a CLI would. */
  function idler() {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    onTestFinished(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } });
    return child;
  }
  const stamp = async (pid: number) => (await new Promise<string>((resolve) => {
    let out = "";
    spawn("ps", ["-o", "lstart=", "-p", String(pid)]).stdout.on("data", (d) => (out += d)).on("end", () => resolve(out));
  })).trim();

  it("recognises a noted CLI only by its id, program and start time", async () => {
    const child = idler();
    await until(async () => !!(await stamp(child.pid!)));
    const started = await stamp(child.pid!);
    expect(await stillRuns(child.pid!, `/bin/sleep\n${started}`)).toBe(true);
    // The id given to another program, or the same program started at another time, is someone else's process.
    expect(await stillRuns(child.pid!, `/usr/bin/vim\n${started}`)).toBe(false);
    expect(await stillRuns(child.pid!, "/bin/sleep\nMon Jan  1 00:00:00 2001")).toBe(false);
    expect(await stillRuns(child.pid!, "/bin/sleep")).toBe(false);
  });

  it("stops a CLI a crashed host left, leaves one whose host is still open, and notes each CLI it starts until it ends", async () => {
    const dir = join(await tempDir(), "agent-pids");
    await mkdir(dir, { recursive: true });
    const [orphan, kept] = [idler(), idler()];
    await until(async () => !!(await stamp(orphan.pid!)) && !!(await stamp(kept.pid!)));
    const gone = spawn("true");
    await new Promise((resolve) => gone.on("close", resolve));
    // The crashed host is gone; the other is this process, still open.
    await writeFile(join(dir, String(orphan.pid)), `/bin/sleep\n${await stamp(orphan.pid!)}\n${gone.pid}\nnode\nMon Jan  1 00:00:00 2001`);
    await writeFile(join(dir, String(kept.pid)), `/bin/sleep\n${await stamp(kept.pid!)}\n${process.pid}\n${process.execPath}\n${await stamp(process.pid)}`);
    // A note whose process has ended, or whose id now belongs to another program, stops nothing and goes.
    await writeFile(join(dir, "999999"), "/bin/sleep\nMon Jan  1 00:00:00 2001");
    const logged: string[] = [];
    await stopOrphans(dir, (msg) => logged.push(msg));
    await until(() => !alive(orphan.pid!));
    expect(alive(kept.pid!)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([String(kept.pid)]);
    expect(logged).toEqual([`stopping agent CLI ${orphan.pid} left running by an earlier launch (/bin/sleep)`]);

    const run = node("console.log('up');setTimeout(()=>{},800)", {
      onLine: () => void until(async () => (await readdir(dir)).includes(String(run.handle.child.pid))).then(() => noted.push("yes")),
    });
    const noted: string[] = [];
    await run.done;
    expect(noted).toEqual(["yes"]);
    expect(await readdir(dir)).toEqual([String(kept.pid)]);
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
