import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "@scarlet/shared";
import { windowsAclShell } from "../private-files.js";
import { runClaude } from "./claude.js";
import { codexHomeDir, runCodex } from "./codex.js";
import { runGemini } from "./gemini.js";
import { runAgent, runnerFor } from "./index.js";
import type { RunAgentFn, RunAgentOptions, RunnerEvent } from "./types.js";

// A stand-in for an agent CLI: it records what it was started with, writes the lines a test gives it, and exits.
const FAKE_CLI = `#!/bin/sh
if [ "$1" = "app-server" ]; then
  printf '%s' "$CODEX_HOME" > "$FAKE_DIR/app-home"
  if [ -n "$FAKE_APP_UNSUPPORTED" ]; then exit 2; fi
  exec "$FAKE_NODE_BIN" "$FAKE_SERVER_SCRIPT" "$@"
fi
if [ "$1" = "acp" ] && [ -n "$FAKE_ACP" ]; then
  exec "$FAKE_NODE_BIN" "$FAKE_ACP_SCRIPT" "$@"
fi
printf '%s\\n' "$@" > "$FAKE_DIR/args"
cat > "$FAKE_DIR/stdin"
printf '%s' "$SCARLET_SERVER" > "$FAKE_DIR/server"
printf '%s' "$MCP_TOOL_TIMEOUT" > "$FAKE_DIR/tool-timeout"
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ] && [ -n "$FAKE_LAST" ]; then printf '%s' "$FAKE_LAST" > "$a"; fi
  prev="$a"
done
cat "$FAKE_DIR/out"
if [ -n "$FAKE_ERR" ]; then echo "$FAKE_ERR" >&2; fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
exit "\${FAKE_CODE:-0}"
`;

const FAKE_SERVER = `
const { appendFileSync, readdirSync, readFileSync, readlinkSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const dir = process.env.FAKE_DIR;
writeFileSync(dir + "/args", process.argv.slice(2).join("\\n") + "\\n");
writeFileSync(dir + "/server", process.env.SCARLET_SERVER);
writeFileSync(dir + "/app-home-entries", JSON.stringify(readdirSync(process.env.CODEX_HOME)));
writeFileSync(dir + "/app-auth-target", readlinkSync(process.env.CODEX_HOME + "/auth.json"));
writeFileSync(dir + "/app-lock-target", readlinkSync(process.env.CODEX_HOME + "/auth.lock"));
const send = message => console.log(JSON.stringify(message));
const emit = name => process.stdout.write(readFileSync(dir + "/" + name));
createInterface({ input: process.stdin }).on("line", line => {
  appendFileSync(dir + "/stdin", line + "\\n");
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { userAgent: "fake codex" } });
  if (method === "thread/start") send({ id, result: { thread: { id: "t1", ephemeral: params.ephemeral }, model: params.model ?? "default-model", approvalPolicy: "never", activePermissionProfile: { id: "scarlet" } } });
  if (method === "thread/resume") send(params.threadId === "t1"
    ? { id, result: { thread: { id: "t1", ephemeral: false }, model: params.model ?? "default-model", approvalPolicy: "never", activePermissionProfile: { id: "scarlet" } } }
    : { id, error: { code: -32600, message: "no rollout found for thread id " + params.threadId } });
  if (method === "turn/start") {
    if (process.env.FAKE_APP_FAIL_START) return send({ id, error: { code: -32603, message: "Turn rejected" } });
    emit("before-start-out");
    send({ id, result: { turn: { id: "turn1", status: "inProgress" } } });
    emit("out");
  }
  if (method === "turn/interrupt") {
    send({ id, result: {} });
    emit("interrupt-out");
  }
});
`;

const FAKE_ACP = `
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { createInterface } = require("node:readline");
const dir = process.env.FAKE_DIR;
writeFileSync(dir + "/args", process.argv.slice(2).join("\\n") + "\\n");
if (process.env.FAKE_ERR) process.stderr.write(process.env.FAKE_ERR + "\\n");
if (process.env.FAKE_CODE) process.exit(Number(process.env.FAKE_CODE));
const send = message => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const emit = name => process.stdout.write(readFileSync(dir + "/" + name));
let promptId = null;
let prompts = 0;
let pendingReply = null;
const configOptions = [
  { id: "model", category: "model", currentValue: "gemini-2.5-pro", options: [{ value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }, { value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }] },
  { id: "thought_level", category: "thought_level", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
];
const rl = createInterface({ input: process.stdin });
rl.on("line", line => {
  appendFileSync(dir + "/stdin", line + "\\n");
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (!method && pendingReply && id === pendingReply.id) {
    const resume = pendingReply.resume;
    pendingReply = null;
    return resume();
  }
  // agy 1.5 says it takes the session's own system prompt (systemPrompt.append).
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: process.env.FAKE_ACP_NO_PROMPT_META ? {} : { _meta: { antigravity: { systemPrompt: { append: true } } } } } });
  if (method === "authenticate") return send({ id, result: {} });
  if (method === "session/new") return send({ id, result: { sessionId: "g1", configOptions } });
  if (method === "session/resume") {
    if (params.sessionId === "g1") return send({ id, result: { sessionId: "g1", configOptions } });
    return send({ id, error: { code: -32602, message: "session not found: " + params.sessionId } });
  }
  if (method === "session/set_config_option") return send({ id, result: { configOptions } });
  if (method === "session/prompt") {
    promptId = id;
    if (process.env.FAKE_ACP_FAIL_PROMPT) return send({ id, error: { code: -32603, message: process.env.FAKE_ACP_FAIL_PROMPT } });
    if (process.env.FAKE_ACP_SCRIPT_TURNS) {
      const turns = JSON.parse(process.env.FAKE_ACP_SCRIPT_TURNS);
      const turn = turns[prompts++] ?? {};
      const transcriptPath = join(process.env.HOME || process.env.USERPROFILE, ".gemini", "antigravity-cli", "brain", "g1", ".system_generated", "logs", "transcript.jsonl");
      mkdirSync(dirname(transcriptPath), { recursive: true });
      const steps = [...(turn.steps ?? [])];
      const runNext = () => {
        while (steps.length > 0) {
          const step = steps.shift();
          if (step.append) appendFileSync(transcriptPath, step.append);
          if (step.line) process.stdout.write(step.line + "\\n");
          if (step.waitForReplyId !== undefined) {
            pendingReply = { id: step.waitForReplyId, resume: runNext };
            return;
          }
        }
        send({ id, result: { stopReason: "end_turn", ...(turn.usage ? { usage: turn.usage } : {}) } });
      };
      return runNext();
    }
    // A turn after the first is the run carrying on: it says nothing more, unless every turn repeats the first.
    if (prompts++ === 0 || process.env.FAKE_ACP_EVERY_TURN) emit("out");
    if (process.env.FAKE_ACP_STOP_REASON) return send({ id, result: { stopReason: process.env.FAKE_ACP_STOP_REASON } });
    if (!process.env.FAKE_SLEEP) return send({ id, result: { stopReason: "end_turn" } });
  }
  if (method === "session/cancel") {
    if (promptId !== null) send({ id: promptId, result: { stopReason: "cancelled" } });
  }
});
// An agy that stays up once its input is closed, as agy can.
rl.on("close", () => process.env.FAKE_ACP_LINGER ? setInterval(() => {}, 1000) : process.exit(Number(process.env.FAKE_CODE ?? 0)));
`;

const mcp = { command: "node", args: ["/scarlet/mcp/cli.js"], env: { SCARLET_SERVER: "http://localhost:4000", SCARLET_TOKEN: "agent-token" } };

// The same stand-in in Node, installed on Windows as npm installs each CLI: a .cmd shim beside its package. The shim
// only fails. Scarlet starts the package's own entry with Node, so the request never passes through cmd.exe. As the
// shell stand-in does, it hands `acp` to the ACP stand-in, which answers each request as it comes.
const FAKE_NODE = `import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const dir = process.env.FAKE_DIR, args = process.argv.slice(2), NL = String.fromCharCode(10);
if (args[0] === "acp" && process.env.FAKE_ACP) {
  createRequire(import.meta.url)(process.env.FAKE_ACP_SCRIPT);
} else {
writeFileSync(dir + "/args", args.map(a => a + NL).join(""));
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
writeFileSync(dir + "/stdin", Buffer.concat(input));
writeFileSync(dir + "/server", process.env.SCARLET_SERVER ?? "");
writeFileSync(dir + "/tool-timeout", process.env.MCP_TOOL_TIMEOUT ?? "");
args.forEach((a, i) => { if (args[i - 1] === "--output-last-message" && process.env.FAKE_LAST) writeFileSync(a, process.env.FAKE_LAST); });
process.stdout.write(readFileSync(dir + "/out"));
if (process.env.FAKE_ERR) process.stderr.write(process.env.FAKE_ERR + NL);
if (process.env.FAKE_SLEEP) await new Promise(r => setTimeout(r, Number(process.env.FAKE_SLEEP) * 1000));
process.exitCode = Number(process.env.FAKE_CODE ?? 0);
}
`;
const NPM_PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", gemini: "@google/gemini-cli" } as const;

/**
 * Who can open a file: its permission bits on POSIX, and on Windows each access rule on it, by account, rights and
 * kind. A private file is the current user's alone.
 */
const OWNER_ONLY = process.platform === "win32" ? ["current-user:FullControl:Allow"] : ["0600"];
async function whoCanOpen(path: string): Promise<string[]> {
  if (process.platform !== "win32") return [((await stat(path)).mode & 0o777).toString(8).padStart(4, "0")];
  const script = [
    "$ErrorActionPreference='Stop'",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl=[System.IO.File]::GetAccessControl($env:SCARLET_CHECKED_FILE)",
    "$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {" +
      " $who = if ($_.IdentityReference -eq $me) { 'current-user' } else { $_.IdentityReference.Value };" +
      " $who + ':' + $_.FileSystemRights + ':' + $_.AccessControlType }",
  ].join(";");
  const shell = windowsAclShell();
  const { stdout } = await promisify(execFile)(shell.executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...shell.env, SCARLET_CHECKED_FILE: path },
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

let root: string;
let bin: string;
let fakeServer: string;
let fakeAcp: string;
const bins = new Map<unknown, string>();
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "scarlet-run-"));
  bin = join(root, "fake-cli");
  await writeFile(bin, FAKE_CLI);
  await chmod(bin, 0o755);
  fakeServer = join(root, "fake-server.cjs");
  await writeFile(fakeServer, FAKE_SERVER);
  fakeAcp = join(root, "fake-acp.cjs");
  await writeFile(fakeAcp, FAKE_ACP);
  if (process.platform === "win32") {
    for (const [name, pkg] of Object.entries(NPM_PACKAGES)) {
      const dir = join(root, "npm", "node_modules", ...pkg.split("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: pkg, bin: { [name]: "cli.mjs" } }));
      await writeFile(join(dir, "cli.mjs"), FAKE_NODE);
      await writeFile(join(root, "npm", `${name}.cmd`), "@echo off\r\nexit /b 1\r\n");
    }
    bins.set(runClaude, join(root, "npm", "claude.cmd")).set(runCodex, join(root, "npm", "codex.cmd")).set(runGemini, join(root, "npm", "gemini.cmd"));
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Fake {
  lines?: string[];
  code?: number;
  stderr?: string;
  /** Seconds the CLI stays alive after writing its lines. */
  sleep?: number;
  /** What Codex writes to its --output-last-message file. */
  last?: string;
  appServer?: true | "unsupported" | "reject-turn";
  acp?: true | { failPrompt?: string; stopReason?: string; everyTurn?: true };
  beforeStartResponse?: string[];
  afterInterrupt?: string[];
}

let seq = 0;
async function run(runner: RunAgentFn, fake: Fake, opts: Partial<RunAgentOptions> = {}) {
  const dir = join(root, `run-${++seq}`);
  const cwd = join(dir, "cwd");
  const codexHome = join(dir, "codex-home");
  await mkdir(cwd, { recursive: true });
  await mkdir(codexHome);
  await writeFile(join(dir, "out"), (fake.lines ?? []).map((line) => `${line}\n`).join(""));
  await writeFile(join(dir, "before-start-out"), (fake.beforeStartResponse ?? []).map((line) => `${line}\n`).join(""));
  await writeFile(join(dir, "interrupt-out"), (fake.afterInterrupt ?? []).map((line) => `${line}\n`).join(""));
  if (fake.appServer) {
    await writeFile(join(codexHome, "auth.json"), "fake credentials", { mode: 0o600 });
    await writeFile(join(codexHome, "config.toml"), "[mcp_servers.unrelated]\ncommand = 'unrelated'\n");
  }
  const events: RunnerEvent[] = [];
  const result = await runner({
    agent: "claude",
    systemPrompt: "SYS",
    instruction: "Make the first cut",
    cwd,
    mcp,
    bin: bins.get(runner) ?? bin,
    onEvent: (ev) => events.push(ev),
    ...opts,
    env: {
      PATH: process.env.PATH,
      CODEX_HOME: codexHome,
      FAKE_DIR: dir,
      FAKE_SERVER_SCRIPT: fakeServer,
      FAKE_ACP_SCRIPT: fakeAcp,
      ...(fake.acp ? { FAKE_ACP: "1" } : {}),
      ...(typeof fake.acp === "object" && fake.acp.failPrompt ? { FAKE_ACP_FAIL_PROMPT: fake.acp.failPrompt } : {}),
      ...(typeof fake.acp === "object" && fake.acp.stopReason ? { FAKE_ACP_STOP_REASON: fake.acp.stopReason } : {}),
      ...(typeof fake.acp === "object" && fake.acp.everyTurn ? { FAKE_ACP_EVERY_TURN: "1" } : {}),
      ...(fake.appServer === "unsupported" ? { FAKE_APP_UNSUPPORTED: "1" } : {}),
      ...(fake.appServer === "reject-turn" ? { FAKE_APP_FAIL_START: "1" } : {}),
      FAKE_NODE_BIN: process.execPath,
      ...(fake.code === undefined ? {} : { FAKE_CODE: String(fake.code) }),
      ...(fake.stderr ? { FAKE_ERR: fake.stderr } : {}),
      ...(fake.sleep ? { FAKE_SLEEP: String(fake.sleep) } : {}),
    ...(fake.last ? { FAKE_LAST: fake.last } : {}),
    ...opts.env,
    },
  });
  const read = (name: string) => readFile(join(dir, name), "utf8");
  return { result, events, cwd, read, args: async () => (await read("args")).split("\n").slice(0, -1), stdin: () => read("stdin"), server: () => read("server") };
}

const claudeInit = '{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","mcp_servers":[{"name":"scarlet","status":"connected"}]}';
const claudeText = (id: string, text: string) => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }], usage: { input_tokens: 3, output_tokens: 7 } } });
const claudeQuestion = [
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}',
];

describe("runClaude", { timeout: 20_000 }, () => {
  it("writes its private control files, sends the request on stdin and reports the result with its session and tokens", async () => {
    const { result, events, cwd, args, stdin } = await run(runClaude, {
      lines: [
        claudeInit,
        claudeText("m1", "Reading the transcript."),
        '{"type":"result","subtype":"success","is_error":false,"result":"Proposed chg_1.","usage":{"input_tokens":4,"cache_read_input_tokens":300,"output_tokens":12}}',
      ],
    }, { model: "opus" });
    expect(result).toEqual({
      ok: true, summary: "Proposed chg_1.", error: undefined, exitCode: 0, resumeFailed: undefined, sessionId: "s1",
      usage: { model: "claude-opus-4-1", inputTokens: 4, outputTokens: 12, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 0 },
    });
    expect(events.map((e) => e.type)).toEqual(["log", "log", "result"]);
    expect(await stdin()).toBe("Make the first cut");
    expect(await args()).toEqual(expect.arrayContaining(["-p", "--model", "opus", "--mcp-config", join(cwd, ".scarlet", "mcp.json")]));
    expect(await args()).not.toContain("Make the first cut");
    expect(await readFile(join(cwd, ".scarlet", "system.md"), "utf8")).toBe("SYS");
    // The MCP config holds the engine token.
    expect(JSON.parse(await readFile(join(cwd, ".scarlet", "mcp.json"), "utf8")).mcpServers.scarlet.env.SCARLET_TOKEN).toBe("agent-token");
    expect(await whoCanOpen(join(cwd, ".scarlet", "mcp.json"))).toEqual(OWNER_ONLY);
  });

  it("takes the last messages as the summary and their tokens as the usage when the CLI exits cleanly without a result line", async () => {
    const { result } = await run(runClaude, { lines: [claudeInit, claudeText("m1", "Cut the pause."), claudeText("m1", "Cut the pause."), claudeText("m2", "Tightened the intro.")] });
    expect(result).toMatchObject({ ok: true, summary: "Cut the pause.\nCut the pause.\nTightened the intro.", sessionId: "s1" });
    // The same API message can arrive twice; it counts once.
    expect(result.usage).toMatchObject({ inputTokens: 6, outputTokens: 14 });
  });

  it("fails with the CLI's own error when the result says so, even on exit code 0", async () => {
    const { result, events } = await run(runClaude, { lines: [claudeInit, '{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}'] });
    expect(result).toMatchObject({ ok: false, summary: "error_max_turns", error: "error_max_turns", exitCode: 0 });
    expect(result.resumeFailed).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "error", text: "error_max_turns" });
  });

  it("fails with the exit code and the end of stderr when the CLI dies without a result", async () => {
    const { result } = await run(runClaude, { lines: ["warming up"], code: 3, stderr: "Sandbox unavailable" });
    expect(result).toMatchObject({ ok: false, summary: "", error: "claude exited with code 3: Sandbox unavailable", exitCode: 3 });
    expect(result.sessionId).toBeUndefined();
  });

  it("reports a resume that found no session as resumeFailed, and keeps its error out of the task log", async () => {
    const gone = '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: gone"]}';
    const { result, events, args } = await run(runClaude, { lines: [gone], code: 1 }, { resumeSession: "gone" });
    expect(result).toMatchObject({ ok: false, resumeFailed: true, error: "No conversation found with session ID: gone" });
    expect(result.sessionId).toBeUndefined();
    expect(events).toEqual([]);
    expect(await args()).toEqual(expect.arrayContaining(["--resume", "gone"]));
  });

  it("keeps the resumed session id when the CLI carries on without announcing one, and shows its errors", async () => {
    const { result, events } = await run(runClaude, {
      lines: [claudeText("m1", "Carrying on."), '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Rate limited"}'],
      code: 1,
    }, { resumeSession: "s9" });
    expect(result).toMatchObject({ ok: false, error: "Rate limited", sessionId: "s9" });
    expect(result.resumeFailed).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["log", "error"]);
  });

  it("stops the CLI once its question is posted and reports the question, not a failure", async () => {
    const started = Date.now();
    const { result, events } = await run(runClaude, { lines: [claudeInit, ...claudeQuestion], sleep: 30 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: true, question: "Keep the cold open?", questionPosted: true, sessionId: "s1" });
    expect(events.map((e) => e.type)).toEqual(["log", "question"]);
  });

  it("carries on after a question Scarlet refused, and asks the editor nothing", async () => {
    const ask = (id: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__scarlet__task_question", input }] } });
    const refuse = (id: string, why: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: why }] } });
    // Refused for its shape: the editor never sees the call's arguments, and the model finishes the edit.
    const shape = await run(runClaude, { lines: [claudeInit, ask("q1", { text: "Keep the cold open?", options: "yes" }), refuse("q1", "options: Expected array"),
      '{"type":"result","subtype":"success","is_error":false,"result":"Kept the cold open."}'] });
    expect(shape.result).toMatchObject({ ok: true, summary: "Kept the cold open.", exitCode: 0 });
    expect(shape.result.question).toBeUndefined();
    // A call with no words isn't a question at all: the CLI isn't stopped for it, and carries on to its own end.
    const empty = await run(runClaude, { lines: [claudeInit, ask("q2", { text: "" }), refuse("q2", "text: Required")], sleep: 1 });
    expect(empty.result).toMatchObject({ ok: true, exitCode: 0 });
    expect(empty.result.question).toBeUndefined();
  });

  it("reports the run's tokens as they grow, and the result's totals at the end", async () => {
    const snapshots: AgentUsage[] = [];
    const { result } = await run(runClaude, {
      lines: [claudeInit, claudeText("m1", "Reading."), claudeText("m1", "Reading."), claudeText("m2", "Cutting."),
        '{"type":"result","subtype":"success","is_error":false,"result":"Done.","usage":{"input_tokens":9,"output_tokens":20,"cache_read_input_tokens":300}}'],
    }, { onUsage: (usage) => snapshots.push(usage) });
    // One API message seen twice counts once; nothing is sent again until the count changes.
    expect(snapshots.map((u) => [u.inputTokens, u.outputTokens, u.cacheReadTokens])).toEqual([[3, 7, 0], [6, 14, 0], [9, 20, 300]]);
    expect(snapshots.at(-1)).toEqual(result.usage);
  });

  it("gives Claude Code the tool deadline Scarlet's waits assume, or the user's own when it is longer", async () => {
    const result = '{"type":"result","subtype":"success","is_error":false,"result":"Done."}';
    for (const [theirs, given] of [[undefined, "300000"], ["60000", "300000"], ["soon", "300000"], ["900000", "900000"]] as const) {
      const { read } = await run(runClaude, { lines: [claudeInit, result] }, { env: theirs ? { MCP_TOOL_TIMEOUT: theirs } : {} });
      expect(await read("tool-timeout")).toBe(given);
    }
  });

  it("fails a run whose Scarlet MCP server failed to start, and stops the CLI instead of letting it write without tools", async () => {
    const mcpFailed = "Scarlet's MCP server failed to start, so Claude Code had no editing tools.";
    // Recorded from claude 2.1.325: the server failed, and Claude answered without tools and called it a success.
    const failed = '{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","mcp_servers":[{"name":"scarlet","status":"failed","source":"dynamic"}]}';
    const success = '{"type":"result","subtype":"success","is_error":false,"result":"I can\'t reach the project\'s tools."}';
    const { result, events } = await run(runClaude, { lines: [failed, success] });
    expect(result).toMatchObject({ ok: false, error: mcpFailed, summary: "I can't reach the project's tools.", exitCode: 0, sessionId: "s1" });
    expect(result).not.toHaveProperty("aborted");
    expect(result.resumeFailed).toBeUndefined();
    expect(events[1]).toMatchObject({ type: "error", text: "Scarlet MCP server status: failed" });

    // Nothing useful can follow, so the CLI is stopped instead of left to write for minutes.
    const started = Date.now();
    const stopped = await run(runClaude, { lines: [failed, claudeText("m1", "Writing it all out.")], sleep: 30 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stopped.result).toMatchObject({ ok: false, error: mcpFailed });
    expect(stopped.result).not.toHaveProperty("aborted");
    expect(stopped.result).not.toHaveProperty("timedOut");

    // The server's failure is the cause, whatever the CLI made of it afterwards.
    expect((await run(runClaude, { lines: [failed, '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Ran out of turns."}'] })).result.error).toBe(mcpFailed);
    expect((await run(runClaude, { lines: [failed], code: 3 })).result.error).toBe(mcpFailed);

    // A resumed session is the same.
    const resumed = await run(runClaude, { lines: [failed, success] }, { resumeSession: "s1" });
    expect(resumed.result).toMatchObject({ ok: false, error: mcpFailed, sessionId: "s1" });
    expect(resumed.result.resumeFailed).toBeUndefined();

    // A question it posted is still a question, and a cancel is still a cancel.
    expect((await run(runClaude, { lines: [failed, ...claudeQuestion], sleep: 30 })).result).toMatchObject({ ok: true, question: "Keep the cold open?", questionPosted: true });
    // The cancel lands just after the first line, before the stop, once the stand-in has started its sleep: a group
    // kill sent while the shell is still forking can miss the new process, which then holds the output open.
    const controller = new AbortController();
    const cancelled = await run(runClaude, { lines: [failed], sleep: 30 }, { signal: controller.signal, onEvent: () => setTimeout(() => controller.abort(), 100) });
    expect(cancelled.result).toMatchObject({ ok: false, error: "cancelled", aborted: true });

    // Only a failed server fails the run: one still starting, or not listed at all, keeps today's result.
    const noChange = '{"type":"result","subtype":"success","is_error":false,"result":"Nothing to change."}';
    for (const status of ["connected", "pending", undefined]) {
      const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s1", mcp_servers: status ? [{ name: "scarlet", status }] : [] });
      expect((await run(runClaude, { lines: [init, noChange] })).result, String(status)).toMatchObject({ ok: true, error: undefined, summary: "Nothing to change." });
    }
  });

  it("tells a run that went silent from one at its time cap and one the host cancelled", async () => {
    const stalled = await run(runClaude, { lines: [claudeInit, claudeText("m1", "Reading.")], sleep: 30 }, { stallMs: 1500 });
    expect(stalled.result).toMatchObject({ ok: false, error: "stalled", timedOut: true, stalled: true, summary: "Reading.", sessionId: "s1" });
    // What it used before it was stopped is still reported.
    expect(stalled.result.usage).toMatchObject({ inputTokens: 3, outputTokens: 7 });

    const capped = await run(runClaude, { lines: [claudeInit], sleep: 30 }, { timeoutMs: 300 });
    expect(capped.result).toMatchObject({ ok: false, error: "timed out", timedOut: true, stalled: false });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const cancelled = await run(runClaude, { lines: [claudeInit], sleep: 30 }, { signal: controller.signal });
    expect(cancelled.result).toMatchObject({ ok: false, error: "cancelled", aborted: true });
    expect(cancelled.result.timedOut).toBeUndefined();
  });

  it("refuses to start when the CLI is not installed", async () => {
    const empty = await mkdtemp(join(root, "empty-path-"));
    await expect(runClaude({ agent: "claude", systemPrompt: "SYS", instruction: "x", cwd: empty, mcp, onEvent: () => {}, env: { PATH: empty } }))
      .rejects.toThrow("claude CLI not found on PATH");
  });
});

describe.skipIf(process.platform === "win32")("runCodex App Server", { timeout: 20_000 }, () => {
  const message = (text: string) => JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text } });
  const completed = '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":5}}';
  const notification = (method: string, params: object = {}) => JSON.stringify({ method, params: { threadId: "t1", turnId: "turn1", ...params } });
  const count = (inputTokens: number, route?: object) => notification("thread/tokenUsage/updated", {
    tokenUsage: { total: { inputTokens, cachedInputTokens: 4, cacheWriteInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 },
      last: { inputTokens: 1, outputTokens: 1 } }, ...route,
  });

  it("shows cumulative App Server counts during an edit and keeps the final total", async () => {
    const snapshots: AgentUsage[] = [];
    const observed: (number | string)[] = [];
    const { result, args, stdin, server, cwd, read } = await run(runCodex, {
      appServer: true,
      beforeStartResponse: [count(888, { turnId: "other" }), count(10)],
      lines: [
        count(10), count(999, { threadId: "other" }), count(999, { turnId: "other" }),
        notification("item/started", { item: { type: "mcpToolCall", id: "mcp1", server: "scarlet", tool: "transcript_get" } }),
        notification("turn/plan/updated", { plan: [{ step: "Read the transcript", status: "inProgress" }] }),
        count(20), notification("item/completed", { item: { type: "agentMessage", id: "msg1", phase: "final_answer", text: "Cut the pause." } }),
        notification("item/completed", { item: { type: "agentMessage", id: "msg2", phase: "commentary", text: "Saving." } }),
        notification("turn/completed", { turn: { id: "turn1", status: "completed" } }),
      ],
    }, { model: "gpt-5", serviceTier: "fast", plan: true, onUsage(usage) { snapshots.push(usage); observed.push(usage.inputTokens); },
      onEvent(event) { observed.push(event.type); } });
    expect(observed).toEqual(["log", 4, "tool", "plan", 14, "log", "log", "result"]);
    expect(snapshots).toEqual([4, 14].map(inputTokens => ({ model: "gpt-5", inputTokens, cacheReadTokens: 4, cacheWriteTokens: 2,
      outputTokens: 5, reasoningTokens: 1 })));
    expect(result).toMatchObject({ ok: true, summary: "Cut the pause.", exitCode: 0, usage: snapshots[1] });
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe("SYS");
    const requests = (await stdin()).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(r => r.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(requests[0].params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
    expect(requests[2].params).toEqual({ ephemeral: false, model: "gpt-5", serviceTier: "fast" });
    expect(result.sessionId).toBe("t1");
    expect(requests[3].params).toEqual({ threadId: "t1", input: [{ type: "text", text: "Make the first cut", text_elements: [] }] });
    expect(await server()).toBe("http://localhost:4000");
    expect(await args()).toEqual(expect.arrayContaining(["app-server", "project_root_markers=[]", "tools.update_plan.enabled=true", 'default_permissions="scarlet"']));
    expect((await args()).join("\n")).not.toContain("agent-token");
    expect(JSON.parse(await read("app-home-entries"))).toEqual(["auth.json", "auth.lock"]);
    expect(await read("app-auth-target")).toMatch(/\/codex-home\/auth\.json$/);
    expect(await read("app-lock-target")).toMatch(/\/codex-home\/auth\.lock$/);
    expect(await read("app-home")).not.toBe(join(cwd, "..", "codex-home"));
    // The run's Codex home is beside its folder, outside what the agent may write, and stays for a resume.
    expect(await read("app-home")).toBe(codexHomeDir(cwd));
    expect((await stat(codexHomeDir(cwd))).isDirectory()).toBe(true);
  });

  it("resumes the thread a run left, and asks for a fresh run when Codex no longer has it", async () => {
    const { result, stdin } = await run(runCodex, { appServer: true, lines: [
      notification("item/completed", { item: { type: "agentMessage", id: "msg1", phase: "final_answer", text: "Kept the take." } }),
      notification("turn/completed", { turn: { id: "turn1", status: "completed" } }),
    ] }, { resumeSession: "t1", instruction: 'The editor answered: "keep it"' });
    expect(result).toMatchObject({ ok: true, summary: "Kept the take.", sessionId: "t1" });
    const requests = (await stdin()).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(r => r.method)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    expect(requests[2].params).toMatchObject({ threadId: "t1" });
    const fallback = vi.fn();
    const gone = await run(runCodex, { appServer: true }, { resumeSession: "t0", onCodexFallback: fallback });
    // Nothing ran, and no `codex exec` fallback, which keeps no thread: the host starts afresh.
    expect(gone.result).toMatchObject({ ok: false, resumeFailed: true });
    expect(fallback).toHaveBeenCalledWith("thread_resume_failed");
  });

  it("counts only this run's tokens on a resumed thread, whether or not Codex carries the thread's total over", async () => {
    const usage = (total: [number, number], last: [number, number]) => notification("thread/tokenUsage/updated", {
      tokenUsage: { total: { inputTokens: total[0], outputTokens: total[1] }, last: { inputTokens: last[0], outputTokens: last[1] } } });
    const finish = notification("turn/completed", { turn: { id: "turn1", status: "completed" } });
    const counts = async (lines: string[]) => {
      const seen: number[][] = [];
      const { result } = await run(runCodex, { appServer: true, lines: [...lines, finish] }, { resumeSession: "t1", onUsage: (u) => seen.push([u.inputTokens, u.outputTokens]) });
      return { seen, total: [result.usage?.inputTokens, result.usage?.outputTokens] };
    };
    // The thread had counted 1,000 and 100 before: the engine already has those from the attempt that made them.
    expect(await counts([usage([1010, 105], [10, 5]), usage([1030, 112], [20, 7])])).toEqual({ seen: [[10, 5], [30, 12]], total: [30, 12] });
    // A Codex that starts a resumed thread's count afresh needs nothing taken off.
    expect(await counts([usage([10, 5], [10, 5]), usage([30, 12], [20, 7])])).toEqual({ seen: [[10, 5], [30, 12]], total: [30, 12] });
  });

  it("drains the usage reported when an edit stops for a question", async () => {
    const question = { type: "mcpToolCall", id: "q1", server: "scarlet", tool: "task_question", arguments: { text: "Keep it?" } };
    const { result, stdin } = await run(runCodex, {
      appServer: true,
      lines: [notification("item/started", { item: question }), notification("item/completed", { item: { ...question, status: "completed" } })],
      afterInterrupt: [count(10), notification("turn/completed", { turn: { id: "turn1", status: "interrupted" } })],
    });
    expect(result).toMatchObject({ ok: true, question: "Keep it?", questionPosted: true, usage: { inputTokens: 4, model: "default-model" } });
    expect(await stdin()).toContain('"method":"turn/interrupt"');
  });

  it("carries on after a question Scarlet refused, without interrupting the turn", async () => {
    const question = { type: "mcpToolCall", id: "q1", server: "scarlet", tool: "task_question", arguments: { text: "Keep it?", options: "yes" } };
    const { result, stdin } = await run(runCodex, {
      appServer: true,
      lines: [notification("item/started", { item: question }), notification("item/completed", { item: { ...question, status: "failed", error: { message: "options: Expected array" } } }),
        notification("item/completed", { item: { type: "agentMessage", id: "msg1", phase: "final_answer", text: "Kept it." } }),
        notification("turn/completed", { turn: { id: "turn1", status: "completed" } })],
    });
    expect(result).toMatchObject({ ok: true, summary: "Kept it." });
    expect(result.question).toBeUndefined();
    expect(await stdin()).not.toContain('"method":"turn/interrupt"');
  });

  it("drains the last App Server usage after the host cancels the edit", async () => {
    const controller = new AbortController();
    const { result, stdin } = await run(runCodex, {
      appServer: true, lines: [count(10)],
      afterInterrupt: [count(20), notification("turn/completed", { turn: { id: "turn1", status: "interrupted" } })],
    }, { signal: controller.signal, onUsage: () => controller.abort() });
    expect(result).toMatchObject({ ok: false, aborted: true, error: "cancelled", usage: { inputTokens: 14 } });
    expect((await stdin()).match(/turn\/interrupt/g)).toHaveLength(1);
  });

  it("falls back only before an App Server turn is sent", async () => {
    const fallback = vi.fn();
    const old = await run(runCodex, { appServer: "unsupported", lines: [message("Old CLI finished."), completed] }, { onCodexFallback: fallback });
    expect(old.result).toMatchObject({ ok: true, summary: "Old CLI finished." });
    expect((await old.args())[0]).toBe("exec");
    expect(fallback).toHaveBeenCalledExactlyOnceWith("app_server_unavailable");
    fallback.mockClear();
    const rejected = await run(runCodex, { appServer: "reject-turn" }, { onCodexFallback: fallback });
    expect(rejected.result).toMatchObject({ ok: false, error: "Turn rejected" });
    expect((await rejected.args())[0]).toBe("app-server");
    expect(fallback).not.toHaveBeenCalled();
  });

});

describe("runCodex", { timeout: 20_000 }, () => {
  const message = (text: string) => JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text } });
  const completed = '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":5}}';

  it("puts the system prompt in AGENTS.md, passes the MCP variables by environment and prefers the last-message file", async () => {
    const { result, cwd, args, stdin, server } = await run(runCodex, { lines: ['{"type":"thread.started","thread_id":"t1"}', message("Proposed chg_2."), completed], last: "Proposed chg_2, with notes.\n" }, { model: "gpt-5" });
    expect(result).toEqual({
      ok: true, summary: "Proposed chg_2, with notes.", error: undefined, exitCode: 0,
      usage: { model: "gpt-5", inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 0 },
    });
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe("SYS");
    expect(await stdin()).toBe("Make the first cut");
    expect(await server()).toBe("http://localhost:4000");
    // Only the names of the MCP variables are on the command line.
    expect((await args()).join("\n")).not.toContain("agent-token");
    expect(await args()).toEqual(expect.arrayContaining(['mcp_servers.scarlet.env_vars=["SCARLET_SERVER","SCARLET_TOKEN"]', "--model", "gpt-5"]));
    // No AGENTS.md from a repository around the task folder loads beside Scarlet's, as App Server is told too.
    const given = await args();
    expect(given[given.indexOf("project_root_markers=[]") - 1]).toBe("-c");
  });

  it("falls back to the last agent message, and counts a completed turn as success whatever the exit code", async () => {
    const { result } = await run(runCodex, { lines: [message("First."), message("Proposed chg_3."), completed], code: 1 });
    expect(result).toMatchObject({ ok: true, summary: "Proposed chg_3.", exitCode: 1 });
    expect(result.usage?.model).toBeUndefined();
  });

  it("fails with the turn's error, then a reconnect notice, then the exit code, in that order of preference", async () => {
    const failed = await run(runCodex, { lines: ['{"type":"error","message":"Reconnecting... 1/5"}', '{"type":"turn.failed","error":{"message":"model overloaded"}}'], code: 1 });
    expect(failed.result).toMatchObject({ ok: false, error: "model overloaded" });
    const dropped = await run(runCodex, { lines: ['{"type":"error","message":"Reconnecting... 5/5"}'], code: 1, stderr: "stream closed" });
    expect(dropped.result).toMatchObject({ ok: false, error: "Reconnecting... 5/5" });
    expect(dropped.events).toEqual([{ type: "log", text: "Reconnecting... 5/5", data: { kind: "connection" } }]);
    const died = await run(runCodex, { code: 2, stderr: "not signed in" });
    expect(died.result).toMatchObject({ ok: false, summary: "", error: "codex exited with code 2: not signed in", exitCode: 2 });
    // A turn that completed after an error line is still a failure.
    const late = await run(runCodex, { lines: ['{"type":"error","message":"quota exceeded"}', completed] });
    expect(late.result).toMatchObject({ ok: false, error: "quota exceeded", exitCode: 0 });
  });

  it("fails a turn Codex says failed without a reason, even on exit code 0", async () => {
    const silent = await run(runCodex, { lines: ['{"type":"turn.failed"}'] });
    expect(silent.result).toMatchObject({ ok: false, error: "turn failed", exitCode: 0 });
    const empty = await run(runCodex, { lines: ['{"type":"turn.failed","error":{"message":""}}'] });
    expect(empty.result).toMatchObject({ ok: false, error: '{"message":""}', exitCode: 0 });
    // The same for a stream error with an empty message, whatever the turn did after it.
    const stream = await run(runCodex, { lines: ['{"type":"error","message":""}', completed] });
    expect(stream.result).toMatchObject({ ok: false, error: '{"type":"error","message":""}', exitCode: 0 });
  });

  it("stops once the engine has the question, and carries on after one Scarlet refused or one with no words", async () => {
    const call = (type: string, extra: object = {}, args: object = { text: "Vertical or wide?" }) =>
      JSON.stringify({ type, item: { id: "q", type: "mcp_tool_call", server: "scarlet", tool: "task_question", arguments: args, ...extra } });
    const posted = await run(runCodex, { lines: [call("item.started"), call("item.completed", { status: "completed" })], sleep: 30 });
    expect(posted.result).toMatchObject({ ok: true, question: "Vertical or wide?", questionPosted: true });
    expect(posted.events.map((e) => e.type)).toEqual(["question"]);
    // Refused (the engine was unreachable, or the call's shape was wrong): the editor isn't asked, and the run goes on to its end.
    const refused = await run(runCodex, { lines: [call("item.started"), call("item.completed", { status: "failed", error: { message: "no engine" } }), message("Kept both takes."), completed], sleep: 1 });
    expect(refused.result).toMatchObject({ ok: true, summary: "Kept both takes." });
    expect(refused.result.question).toBeUndefined();
    expect(refused.events.map((e) => [e.type, e.text])).toEqual([["error", 'scarlet.task_question failed: {"message":"no engine"}'], ["log", "Kept both takes."], ["result", "Kept both takes."]]);
    // No words is no question: an ordinary call, which Scarlet refuses.
    const empty = await run(runCodex, { lines: [call("item.started", {}, { text: " " }), call("item.completed", { status: "failed", error: { message: "text: Required" } }, { text: " " }), completed], sleep: 1 });
    expect(empty.result).toMatchObject({ ok: true });
    expect(empty.result.question).toBeUndefined();
    expect(empty.events.map((e) => e.type)).toEqual(["tool", "error", "result"]);
  });

  it("reports a silent run as stalled and a cancelled one as cancelled", async () => {
    const stalled = await run(runCodex, { lines: [message("Reading.")], sleep: 30 }, { stallMs: 1500 });
    expect(stalled.result).toMatchObject({ ok: false, error: "stalled", timedOut: true, stalled: true, summary: "Reading." });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await run(runCodex, { sleep: 30 }, { signal: controller.signal });
    expect(cancelled.result).toMatchObject({ ok: false, error: "cancelled", aborted: true });
  });
});

describe("runGemini", { timeout: 20_000 }, () => {
  const upd = (update: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "g1", update } });

  it("runs an ACP session with Scarlet's prompt, model/effort config, MCP-only permissions, and usage", async () => {
    const { result, events, cwd, stdin, args } = await run(runGemini, {
      acp: true,
      lines: [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "session/request_permission",
          params: {
            toolCall: { name: "mcp__scarlet__timeline_get" },
            options: [{ optionId: "allow1", kind: "allow_once" }, { optionId: "deny1", kind: "reject_once" }],
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 100,
          method: "session/request_permission",
          params: {
            toolCall: { name: "bash" },
            options: [{ optionId: "allow2", kind: "allow_once" }, { optionId: "deny2", kind: "reject_once" }],
          },
        }),
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Adding " } }),
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "captions." } }),
        upd({ sessionUpdate: "usage_update", usage: { inputTokens: 100, cachedReadTokens: 40, outputTokens: 9 } }),
      ],
    }, { agent: "gemini", model: "gemini-2.5-flash", effort: "high" });

    expect(result).toEqual({
      ok: true,
      summary: "Adding captions.",
      error: undefined,
      exitCode: 0,
      sessionId: "g1",
      usage: { model: "gemini-2.5-flash", inputTokens: 100, outputTokens: 9, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 0 },
    });
    // agy ended the first turn on the refused bash tool: the run carried on, and was told why.
    expect(events.map((e) => [e.type, e.text])).toEqual([
      ["log", "Gemini session started (gemini-2.5-flash)"],
      ["log", "Adding captions."],
      ["log", "Scarlet refused bash: only Scarlet's tools run here. Gemini carries on."],
      ["result", "Adding captions."],
    ]);
    expect(events[2]!.data).toEqual({ kind: "tool_refused", harnessTool: "bash" });
    expect(await args()).toEqual(["acp", "--sandbox", "--disable-telemetry"]);
    // No GEMINI.md: agy cuts a rule file off at 24,000 bytes. The prompt is the session's own.
    await expect(readFile(join(cwd, "GEMINI.md"), "utf8")).rejects.toThrow();

    const sent = (await stdin()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(sent.filter((m) => m.method).map((m) => m.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
      "session/prompt",
    ]);
    expect(sent.find((m) => m.method === "session/new")?.params).toMatchObject({ _meta: { antigravity: { systemPrompt: { append: "SYS" } } } });
    expect(JSON.stringify(sent.filter((m) => m.method === "session/prompt").at(-1))).toContain("Scarlet refused bash: only Scarlet's own tools");
    // Allowed Scarlet MCP tool, denied built-in bash tool.
    expect(sent.find((m) => m.id === 99)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "allow1" } } });
    expect(sent.find((m) => m.id === 100)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "deny2" } } });
  });

  it("tells Gemini what was refused in the engine's words when it gives them", async () => {
    const bash = JSON.stringify({ jsonrpc: "2.0", id: 100, method: "session/request_permission",
      params: { toolCall: { name: "run_command" }, options: [{ optionId: "deny", kind: "reject_once" }] } });
    const { result, stdin } = await run(runGemini, { acp: true, lines: [bash] },
      { agent: "gemini", refusedTool: "{tool} isn't one of Scarlet's tools ({tool} refused). Carry on." });
    expect(result).toMatchObject({ ok: true });
    const prompts = (await stdin()).trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.method === "session/prompt");
    expect(prompts.at(-1).params.prompt).toEqual([{ type: "text", text: "run_command isn't one of Scarlet's tools (run_command refused). Carry on." }]);
  });

  it("ends a finished run promptly when agy stays up after its input closes", async () => {
    const started = Date.now();
    const { result } = await run(runGemini, { acp: true, lines: [upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } })] },
      { agent: "gemini", stallMs: 8000, env: { FAKE_ACP_LINGER: "1" } });
    expect(result).toMatchObject({ ok: true, summary: "Done." });
    expect(result.stalled).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("refuses to run Gemini without Scarlet's instructions when agy doesn't say it takes them", async () => {
    const { result, stdin } = await run(runGemini, { acp: true }, { agent: "gemini", env: { FAKE_ACP_NO_PROMPT_META: "1" } });
    expect(result).toMatchObject({ ok: false, error: "This agy doesn't take Scarlet's instructions (its initialize result lists no systemPrompt.append), so Gemini would edit without them. Update agy." });
    expect(await stdin()).not.toContain("session/new");
  });

  it("resumes an existing ACP session and reports sessionNotFound when gone", async () => {
    const resumed = await run(runGemini, {
      acp: true,
      lines: [upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Trimmed." } })],
    }, { agent: "gemini", resumeSession: "g1" });
    expect(resumed.result).toMatchObject({ ok: true, summary: "Trimmed.", sessionId: "g1" });
    expect((await resumed.stdin()).includes('"method":"session/resume"')).toBe(true);

    const missing = await run(runGemini, { acp: true }, { agent: "gemini", resumeSession: "gone" });
    expect(missing.result).toMatchObject({ ok: false, resumeFailed: true });
  });

  it("stops a run whose turns keep ending on refused tools", async () => {
    const bash = JSON.stringify({ jsonrpc: "2.0", id: 100, method: "session/request_permission",
      params: { toolCall: { name: "bash" }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
    const { result, stdin } = await run(runGemini, { acp: { everyTurn: true }, lines: [bash] }, { agent: "gemini" });
    expect(result).toMatchObject({ ok: false, error: "Gemini stopped after Scarlet refused bash, a tool that doesn't run in Scarlet, 5 times." });
    expect((await stdin()).match(/"method":"session\/prompt"/g)).toHaveLength(5);
  });

  it("fails on a prompt error, refusal stopReason, or non-zero exit", async () => {
    const errored = await run(runGemini, { acp: { failPrompt: "quota exceeded" } }, { agent: "gemini" });
    expect(errored.result).toMatchObject({ ok: false, error: "Gemini prompt failed: quota exceeded" });

    const refused = await run(runGemini, { acp: { stopReason: "refusal" } }, { agent: "gemini" });
    expect(refused.result).toMatchObject({ ok: false, error: "Gemini ended with stopReason refusal" });

    const died = await run(runGemini, { acp: true, code: 41, stderr: "Authentication required" }, { agent: "gemini" });
    expect(died.result).toMatchObject({ ok: false, summary: "", error: "agy exited with code 41: Authentication required", exitCode: 41 });

    const quiet = await run(runGemini, { acp: true, code: 1 }, { agent: "gemini" });
    expect(quiet.result.error).toBe("agy exited with code 1");
  });

  it("stops once the engine has the question, and carries on after one Scarlet refused or one with no words", async () => {
    const ask = (id: string, input: object, status: string, rawOutput: unknown) => [
      upd({ sessionUpdate: "tool_call", toolCallId: id, name: "mcp_scarlet_task_question", rawInput: input }),
      upd({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawOutput }),
    ];
    const asked = await run(runGemini, {
      acp: true,
      lines: [
        upd({ sessionUpdate: "tool_call", toolCallId: "c1", name: "mcp__scarlet__transcript_get", rawInput: { mediaId: "m1" } }),
        upd({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", rawOutput: { error: "no such media" } }),
        ...ask("c2", { text: "9:16 or 16:9?" }, "completed", "Question posted"),
      ],
      sleep: 30,
    }, { agent: "gemini" });
    expect(asked.result).toMatchObject({ ok: true, question: "9:16 or 16:9?", questionPosted: true });
    expect(asked.events.map((e) => [e.type, e.text])).toEqual([
      ["log", "Gemini session started (gemini-2.5-pro)"],
      ["tool", 'scarlet.transcript_get {"mediaId":"m1"}'],
      ["error", 'scarlet.transcript_get failed: {"error":"no such media"}'],
      ["question", "9:16 or 16:9?"],
    ]);
    // Refused, or with no words: the editor isn't asked, and the turn runs to its end.
    const refused = await run(runGemini, {
      acp: true,
      lines: [...ask("c3", { text: "9:16 or 16:9?" }, "failed", { error: "engine unreachable" }), ...ask("c4", { text: "" }, "failed", { error: "text: Required" }),
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Went with 16:9." } })],
    }, { agent: "gemini" });
    expect(refused.result).toMatchObject({ ok: true, summary: "Went with 16:9." });
    expect(refused.result.question).toBeUndefined();
    expect(refused.events.map((e) => [e.type, e.text])).toEqual([
      ["log", "Gemini session started (gemini-2.5-pro)"],
      ["error", 'scarlet.task_question failed: {"error":"engine unreachable"}'],
      ["tool", 'scarlet.task_question {"text":""}'],
      ["error", 'scarlet.task_question failed: {"error":"text: Required"}'],
      ["log", "Went with 16:9."],
      ["result", "Went with 16:9."],
    ]);
  });

  it("uses only the trimmed final assistant message as the summary, without prior progress chatter or truncation", async () => {
    const earlier = `\n\n${"Checking transition areas. ".repeat(90)}and checking the last transition areas.`;
    const progress = "\n\nFraming the benchmark graph demo cleanly inside the Kimi window.";
    const finalReply = `Synced and tightened the video.\n\n${"Detailed follow-up note. ".repeat(100)}All cuts are ready.`;
    expect(finalReply.length).toBeGreaterThan(2000);
    const { result, events } = await run(runGemini, {
      acp: true,
      lines: [
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: earlier } }),
        upd({ sessionUpdate: "tool_call", toolCallId: "t1", name: "mcp__scarlet__timeline_get", rawInput: {} }),
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: progress } }),
        upd({ sessionUpdate: "tool_call", toolCallId: "t2", name: "mcp__scarlet__timeline_propose", rawInput: {} }),
        upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${finalReply}\n` } }),
      ],
    }, { agent: "gemini" });
    expect(result).toMatchObject({ ok: true, summary: finalReply });
    expect(events.find((e) => e.type === "result")?.text).toBe(finalReply);
    expect(events.filter((e) => e.type === "log").map((e) => e.text)).toEqual([
      "Gemini session started (gemini-2.5-pro)",
      earlier.trim(),
      progress.trim(),
      finalReply,
    ]);
  });

  it("reports a run at its time cap as timed out, not stalled", async () => {
    const capped = await run(runGemini, { acp: true, sleep: 30 }, { agent: "gemini", timeoutMs: 300 });
    expect(capped.result).toMatchObject({ ok: false, error: "timed out", timedOut: true, stalled: false });
  });

  it("streams live token counts from agy's transcript.jsonl, sums carry-on turns, and skips prior steps on resume", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "scarlet-agy-home-"));
    try {
      const bash = JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "session/request_permission",
        params: { toolCall: { name: "bash" }, options: [{ optionId: "deny", kind: "reject_once" }] },
      });
      const turns = [
        {
          steps: [
            {
              append:
                JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", input_tokens: 1000, cache_read_tokens: 0, output_tokens: 50 }) +
                "\n" +
                '{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":200,',
              line: upd({ sessionUpdate: "usage_update", used: 1050, size: 1048576 }),
            },
            {
              line: JSON.stringify({
                jsonrpc: "2.0",
                id: 77,
                method: "session/request_permission",
                params: { toolCall: { name: "mcp__scarlet__timeline_get" }, options: [{ optionId: "yes", kind: "allow_once" }] },
              }),
              waitForReplyId: 77,
            },
            {
              append: '"cache_read_tokens":1000,"output_tokens":30}\n',
              line: upd({ sessionUpdate: "usage_update", used: 1230, size: 1048576 }),
            },
            { line: bash },
          ],
          usage: { inputTokens: 1200, outputTokens: 80, cachedReadTokens: 1000, thoughtTokens: 60, totalTokens: 2280 },
        },
        {
          steps: [
            {
              append: JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", input_tokens: 400, cache_read_tokens: 2000, output_tokens: 20 }) + "\n",
              line: upd({ sessionUpdate: "usage_update", used: 2420, size: 1048576 }),
            },
          ],
          usage: { inputTokens: 400, outputTokens: 20, cachedReadTokens: 2000, thoughtTokens: 10, totalTokens: 2420 },
        },
      ];
      const live: AgentUsage[] = [];
      const first = await run(
        runGemini,
        { acp: true },
        {
          agent: "gemini",
          model: "gemini-4-neon",
          env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, FAKE_ACP_SCRIPT_TURNS: JSON.stringify(turns) },
          onUsage: (u) => live.push(u),
        },
      );
      expect(first.result.ok).toBe(true);
      expect(live).toEqual([
        { model: "gemini-4-neon", inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        { model: "gemini-4-neon", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 0 },
        { model: "gemini-4-neon", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 60 },
        { model: "gemini-4-neon", inputTokens: 1600, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 0, reasoningTokens: 60 },
        { model: "gemini-4-neon", inputTokens: 1600, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 0, reasoningTokens: 70 },
      ]);
      expect(first.result.usage).toEqual(live.at(-1));

      // Resuming the same session skips earlier claims' lines in transcript.jsonl.
      const resumedLive: AgentUsage[] = [];
      const resumedTurns = [
        {
          steps: [
            {
              append: JSON.stringify({ step_index: 10, type: "PLANNER_RESPONSE", status: "DONE", input_tokens: 300, cache_read_tokens: 5000, output_tokens: 40 }) + "\n",
              line: upd({ sessionUpdate: "usage_update", used: 5340, size: 1048576 }),
            },
          ],
          usage: { inputTokens: 300, outputTokens: 40, cachedReadTokens: 5000, thoughtTokens: 25, totalTokens: 5340 },
        },
      ];
      const resumed = await run(
        runGemini,
        { acp: true },
        {
          agent: "gemini",
          model: "gemini-4-neon",
          resumeSession: "g1",
          env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, FAKE_ACP_SCRIPT_TURNS: JSON.stringify(resumedTurns) },
          onUsage: (u) => resumedLive.push(u),
        },
      );
      expect(resumed.result.ok).toBe(true);
      expect(resumedLive).toEqual([
        { model: "gemini-4-neon", inputTokens: 300, outputTokens: 40, cacheReadTokens: 5000, cacheWriteTokens: 0, reasoningTokens: 0 },
        { model: "gemini-4-neon", inputTokens: 300, outputTokens: 40, cacheReadTokens: 5000, cacheWriteTokens: 0, reasoningTokens: 25 },
      ]);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("runAgent", () => {
  const base: RunAgentOptions = { agent: "claude", systemPrompt: "SYS", instruction: "x", cwd: tmpdir(), mcp, onEvent: () => {}, bin: "/nonexistent/scarlet-test-cli" };

  it("refuses a model or option that could be read as a launcher argument, before anything is started", async () => {
    const refused = { ok: false, summary: "", error: "Invalid model or model option" };
    for (const model of ["--settings={}", "opus;rm -rf", "opus sonnet", "-m", "opus\n"]) expect(await runAgent({ ...base, model })).toEqual(refused);
    expect(await runAgent({ ...base, effort: "high --dangerously" })).toEqual(refused);
    expect(await runAgent({ ...base, serviceTier: "fast&calc" })).toEqual(refused);
    expect(await runAgent({ ...base, model: "opus", effort: "" })).toEqual(refused);
  });

  it("lets through the model names the CLIs really use", async () => {
    for (const model of ["opus", "claude-opus-4-1[1m]", "gpt-5.1-codex", "us.anthropic.claude-sonnet-4-5:0", "models/gemini-2.5-pro", "org/model@v2+exp"]) {
      // Past validation the fake CLI is started, and fails because it doesn't exist.
      const result = await runAgent({ ...base, model, effort: "high", serviceTier: "fast" });
      expect(result.error).toMatch(/^claude exited with code null/);
    }
  });

  it("has a runner for each CLI agent and none for the API agent", async () => {
    expect([runnerFor("claude"), runnerFor("codex"), runnerFor("gemini")]).toEqual([runClaude, runCodex, runGemini]);
    expect(() => runnerFor("api")).toThrow('no runner for agent "api"');
    await expect(runAgent({ ...base, agent: "api" })).rejects.toThrow('no runner for agent "api"');
  });
});
