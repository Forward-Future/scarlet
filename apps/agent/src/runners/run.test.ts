import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { runGemini } from "./gemini.js";
import { runAgent, runnerFor } from "./index.js";
import type { RunAgentFn, RunAgentOptions, RunnerEvent } from "./types.js";

// A stand-in for an agent CLI: it records what it was started with, writes the lines a test gives it, and exits.
const FAKE_CLI = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/args"
cat > "$FAKE_DIR/stdin"
printf '%s' "$SCARLET_SERVER" > "$FAKE_DIR/server"
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

const mcp = { command: "node", args: ["/scarlet/mcp/cli.js"], env: { SCARLET_SERVER: "http://localhost:4000", SCARLET_TOKEN: "agent-token" } };

let root: string;
let bin: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "scarlet-run-"));
  bin = join(root, "fake-cli");
  await writeFile(bin, FAKE_CLI);
  await chmod(bin, 0o755);
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
}

let seq = 0;
async function run(runner: RunAgentFn, fake: Fake, opts: Partial<RunAgentOptions> = {}) {
  const dir = join(root, `run-${++seq}`);
  const cwd = join(dir, "cwd");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(dir, "out"), (fake.lines ?? []).map((line) => `${line}\n`).join(""));
  const events: RunnerEvent[] = [];
  const result = await runner({
    agent: "claude",
    systemPrompt: "SYS",
    instruction: "Make the first cut",
    cwd,
    mcp,
    bin,
    onEvent: (ev) => events.push(ev),
    env: {
      PATH: process.env.PATH,
      FAKE_DIR: dir,
      ...(fake.code === undefined ? {} : { FAKE_CODE: String(fake.code) }),
      ...(fake.stderr ? { FAKE_ERR: fake.stderr } : {}),
      ...(fake.sleep ? { FAKE_SLEEP: String(fake.sleep) } : {}),
      ...(fake.last ? { FAKE_LAST: fake.last } : {}),
    },
    ...opts,
  });
  const read = (name: string) => readFile(join(dir, name), "utf8");
  return { result, events, cwd, args: async () => (await read("args")).split("\n").slice(0, -1), stdin: () => read("stdin"), server: () => read("server") };
}

const claudeInit = '{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","mcp_servers":[{"name":"scarlet","status":"connected"}]}';
const claudeText = (id: string, text: string) => JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }], usage: { input_tokens: 3, output_tokens: 7 } } });
const claudeQuestion = [
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}',
];

describe.skipIf(process.platform === "win32")("runClaude", { timeout: 20_000 }, () => {
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
    expect((await stat(join(cwd, ".scarlet", "mcp.json"))).mode & 0o777).toBe(0o600);
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

describe.skipIf(process.platform === "win32")("runCodex", { timeout: 20_000 }, () => {
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

  it("stops after the question's tool call completes, and says whether the engine took it", async () => {
    const call = (type: string, extra: object = {}) => JSON.stringify({ type, item: { id: "q", type: "mcp_tool_call", server: "scarlet", tool: "task_question", arguments: { text: "Vertical or wide?" }, ...extra } });
    const posted = await run(runCodex, { lines: [call("item.started"), call("item.completed", { status: "completed" })], sleep: 30 });
    expect(posted.result).toMatchObject({ ok: true, question: "Vertical or wide?", questionPosted: true });
    expect(posted.events.map((e) => e.type)).toEqual(["question"]);
    const refused = await run(runCodex, { lines: [call("item.completed", { status: "failed", error: { message: "no engine" } })], sleep: 30 });
    expect(refused.result).toMatchObject({ ok: true, question: "Vertical or wide?", questionPosted: false });
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

describe.skipIf(process.platform === "win32")("runGemini", { timeout: 20_000 }, () => {
  const init = '{"type":"init","session_id":"g1","model":"gemini-2.5-pro"}';

  it("writes its settings, policy and prompt into the task folder and reports the result with its tokens", async () => {
    const { result, events, cwd, stdin, args } = await run(runGemini, {
      lines: [init, '{"type":"message","role":"assistant","content":"Adding ","delta":true}', '{"type":"message","role":"assistant","content":"captions.","delta":true}',
        '{"type":"result","status":"success","response":"Captions added.","stats":{"input_tokens":100,"cached":40,"output_tokens":9}}'],
    });
    expect(result).toEqual({
      ok: true, summary: "Captions added.", error: undefined, exitCode: 0,
      usage: { model: "gemini-2.5-pro", inputTokens: 60, outputTokens: 9, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 0 },
    });
    expect(events.map((e) => [e.type, e.text])).toEqual([["log", "Gemini session started (gemini-2.5-pro)"], ["log", "Adding captions."], ["result", "Captions added."]]);
    expect(await stdin()).toBe("Make the first cut");
    expect(await readFile(join(cwd, "GEMINI.md"), "utf8")).toBe("SYS");
    expect(JSON.parse(await readFile(join(cwd, ".gemini", "settings.json"), "utf8")).tools.core).toEqual([]);
    expect(await args()).toEqual(expect.arrayContaining(["--admin-policy", join(cwd, ".gemini", "scarlet-policy.toml")]));
  });

  it("uses what the model said as the summary when the result carries no text", async () => {
    const { result } = await run(runGemini, { lines: ['{"type":"message","role":"model","content":[{"text":"Trimmed "},"the intro."]}', '{"type":"message","role":"user","content":"ignored"}', '{"type":"result","status":"success"}'] });
    expect(result).toMatchObject({ ok: true, summary: "Trimmed the intro." });
    expect(result.usage).toBeUndefined();
  });

  it("fails on an error line, a non-success result or a bad exit, and treats a warning as a log line", async () => {
    const warned = await run(runGemini, { lines: ['{"type":"error","severity":"warning","message":"slow network"}', '{"type":"result","status":"success","response":"Done."}'] });
    expect(warned.result).toMatchObject({ ok: true, summary: "Done." });
    expect(warned.events[0]).toEqual({ type: "log", text: "warning: slow network" });
    const errored = await run(runGemini, { lines: ['{"type":"error","message":"quota exceeded"}', '{"type":"result","status":"success","response":"Done."}'] });
    expect(errored.result).toMatchObject({ ok: false, error: "quota exceeded" });
    const status = await run(runGemini, { lines: ['{"type":"result","status":"max_turns"}'] });
    expect(status.result).toMatchObject({ ok: false, error: "Gemini ended with status max_turns" });
    const died = await run(runGemini, { code: 41, stderr: "Please set an Auth method" });
    expect(died.result).toMatchObject({ ok: false, summary: "", error: "gemini exited with code 41: Please set an Auth method", exitCode: 41 });
    const quiet = await run(runGemini, { code: 1 });
    expect(quiet.result.error).toBe("gemini exited with code 1");
  });

  it("stops after the question's result, reports a failed tool, and names the tool however the CLI spells the call", async () => {
    const asked = await run(runGemini, {
      lines: [
        '{"type":"tool_call","name":"transcript_get","call_id":"c1","args":{"mediaId":"m1"}}',
        '{"type":"tool_result","call_id":"c1","is_error":true,"error":"no such media"}',
        '{"type":"tool_use","tool_name":"mcp_scarlet_task_question","tool_id":"c2","parameters":{"text":"9:16 or 16:9?"}}',
        '{"type":"tool_result","tool_id":"c2","status":"error","error":"engine unreachable"}',
      ],
      sleep: 30,
    });
    expect(asked.result).toMatchObject({ ok: true, question: "9:16 or 16:9?", questionPosted: false });
    expect(asked.events.map((e) => [e.type, e.text])).toEqual([
      ["tool", 'transcript_get {"mediaId":"m1"}'],
      ["error", "Tool error: no such media"],
      ["question", "9:16 or 16:9?"],
    ]);
  });

  it("reports a run at its time cap as timed out, not stalled", async () => {
    const capped = await run(runGemini, { lines: [init], sleep: 30 }, { timeoutMs: 300 });
    expect(capped.result).toMatchObject({ ok: false, error: "timed out", timedOut: true, stalled: false });
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

  it.skipIf(process.platform === "win32")("lets through the model names the CLIs really use", async () => {
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
