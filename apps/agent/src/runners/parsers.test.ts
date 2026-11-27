import { describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCommand, claudeCanRunBare, claudeRunUsage, newClaudeState, parseClaudeLine } from "./claude.js";
import { buildCodexCommand, tomlInlineTable, tomlString } from "./codex.js";
import { newCodexState, parseCodexLine } from "./codexParse.js";
import { acpMcpServer, buildGeminiCommand, geminiDir, isScarletMcpPermission, namesPath, newGeminiState, parseGeminiLine, permissionOutcome, workspacePermission } from "./geminiAcp.js";
import { quoteForCmd, spawnLines, spawnSpec } from "./spawn.js";
import { briefInput, isQuestionTool, prettyToolName, workspaceEnv, type RunnerEvent } from "./types.js";
import { holdQuestion, settleQuestion, type QuestionCallState } from "./questionCalls.js";

function feed<S>(lines: string[], st: S, parse: (l: string, s: S) => RunnerEvent[]): RunnerEvent[] {
  const out: RunnerEvent[] = [];
  for (const l of lines) out.push(...parse(l, st));
  return out;
}

const mcp = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\scarlet\\packages\\mcp\\dist\\cli.js"], env: { SCARLET_SERVER: "http://localhost:4000", SCARLET_TOKEN: 'a"b' } };

describe("claude stream-json parser", () => {
  const fixture = [
    '{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","tools":["Bash"],"mcp_servers":[{"name":"scarlet","status":"connected"}]}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me look at the project."},{"type":"tool_use","id":"toolu_1","name":"mcp__scarlet__project_get","input":{}}]},"session_id":"s1"}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"{...}"}]}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"mcp__scarlet__timeline_propose","input":{"ops":[{"op":"rippleDelete","start":1,"end":2}],"description":"Cut the pause"}}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","is_error":true,"content":"Invalid ops: ..."}]}}',
    'not json at all',
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":3,"result":"Proposed one change: chg_1.","total_cost_usd":0.05,"usage":{"input_tokens":4,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":12}}',
  ];
  it("maps text, tools, errors and the result", () => {
    const st = newClaudeState();
    const evs = feed(fixture, st, parseClaudeLine);
    expect(evs.map((e) => e.type)).toEqual(["log", "log", "tool", "tool", "error", "log", "result"]);
    expect(evs[0]!.text).toContain("Scarlet MCP connected");
    expect(evs[2]!.text).toBe("scarlet.project_get");
    expect(evs[3]!.text).toContain("scarlet.timeline_propose {\"ops\"");
    expect(evs[4]!.text).toContain("Invalid ops");
    expect(evs[6]!.text).toBe("Proposed one change: chg_1.");
    expect(st.result).toBe("Proposed one change: chg_1.");
    expect(st.mcpStatus).toBe("connected");
    expect(st.sessionId).toBe("s1");
  });
  it("reports a compaction while it runs and once it happens", () => {
    const st = newClaudeState();
    const evs = feed([
      '{"type":"system","subtype":"status","status":"compacting","session_id":"s1"}',
      '{"type":"system","subtype":"status","status":"compacting","session_id":"s1"}',
      '{"type":"system","subtype":"compact_boundary","session_id":"s1","compact_metadata":{"trigger":"auto","pre_tokens":161204}}',
      '{"type":"system","subtype":"status","status":null,"session_id":"s1"}',
    ], st, parseClaudeLine);
    expect(evs).toEqual([
      { type: "log", text: "Compacting context", data: { kind: "compaction", active: true } },
      { type: "log", text: "Context compacted", data: { kind: "compaction", trigger: "auto", preTokens: 161204 } },
    ]);
    const cleared = feed([
      '{"type":"system","subtype":"status","status":"compacting","session_id":"s1"}',
      '{"type":"system","subtype":"status","status":null,"session_id":"s1"}',
    ], st, parseClaudeLine);
    expect(cleared).toEqual([
      { type: "log", text: "Compacting context", data: { kind: "compaction", active: true } },
      { type: "log", text: "Compacting context", data: { kind: "compaction", active: false } },
    ]);
  });
  it("sees a resume that found no session as never started", () => {
    // Recorded from claude 2.1.316 with --resume <unknown id>.
    const st = newClaudeState();
    feed(['{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"3f1c2b9e-0000-4000-8000-000000000000","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"errors":["No conversation found with session ID: 3f1c2b9e-0000-4000-8000-000000000000"]}'], st, parseClaudeLine);
    expect(st.started).toBeFalsy();
    expect(st.sessionId).toBeUndefined();
    expect(st.result).toContain("No conversation found");
  });
  it("turns task_question into a question and stops after its tool_result", () => {
    const st = newClaudeState();
    const evs = feed(
      [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}',
      ],
      st,
      parseClaudeLine,
    );
    // Nothing is said until the engine has the question; the run still holds it, should the CLI stop before then.
    expect(evs).toEqual([]);
    expect(st.question).toBe("Keep the cold open?");
    expect(st.shouldStop).toBe(false);
    expect(feed(['{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}'], st, parseClaudeLine))
      .toEqual([{ type: "question", text: "Keep the cold open?", data: { tool: "mcp__scarlet__task_question", toolUseId: "q1" } }]);
    expect(st.question).toBe("Keep the cold open?");
    expect(st.questionPosted).toBe(true);
    expect(st.shouldStop).toBe(true);
  });
  it("names the tool a call through tool_call makes, with that tool's arguments, and leaves a question asked that way unasked", () => {
    // Ollama, LM Studio and OpenRouter run through Claude Code with brief tools, so most of Scarlet's tools are reached through tool_call.
    const use = (id: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__scarlet__tool_call", input }] } });
    const st = newClaudeState();
    expect(feed([use("t1", { name: "transcript_get", arguments: { mediaId: "m1" } }), use("t2", { name: " MCP__Scarlet__Timeline_Get " })], st, parseClaudeLine)).toEqual([
      { type: "tool", text: 'scarlet.transcript_get {"mediaId":"m1"}', data: { tool: "mcp__scarlet__transcript_get", input: { mediaId: "m1" }, toolUseId: "t1" } },
      { type: "tool", text: "scarlet.timeline_get", data: { tool: "mcp__scarlet__timeline_get", input: {}, toolUseId: "t2" } },
    ]);
    // The server refuses a question asked through tool_call, and a call that names no tool is shown as it was made.
    const asked = { name: "task_question", arguments: { text: "Which take?" } };
    expect(feed([use("t3", asked), use("t4", { name: "../x" })], st, parseClaudeLine).map((e) => e.data)).toEqual([
      { tool: "mcp__scarlet__tool_call", input: asked, toolUseId: "t3" }, { tool: "mcp__scarlet__tool_call", input: { name: "../x" }, toolUseId: "t4" }]);
    expect(st.question).toBeUndefined();
  });
  it("reports error results and a failed MCP server", () => {
    const st = newClaudeState();
    const evs = feed(
      [
        '{"type":"system","subtype":"init","mcp_servers":[{"name":"scarlet","status":"failed"}]}',
        '{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}',
      ],
      st,
      parseClaudeLine,
    );
    expect(evs.map((e) => e.type)).toEqual(["log", "error", "error"]);
    expect(st.resultIsError).toBe(true);
    expect(st.result).toBe("error_max_turns");
    const details = parseClaudeLine('{"type":"result","subtype":"error_during_execution","errors":["Sandbox unavailable"]}', st);
    expect(details[0]?.text).toBe("Sandbox unavailable");
  });
  // Recorded from claude 2.1.316 launched with --tools "TaskCreate,TaskUpdate": its own to-do list, one call a step.
  const use = (id: string, name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] } });
  const done = (id: string, content: string, result: unknown) => JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content }] }, tool_use_result: result });
  const created = (id: string, n: string, subject: string) => done(id, `Task #${n} created successfully: ${subject}`, { task: { id: n, subject } });
  const updated = (id: string, n: string, to: string) => done(id, `Updated task #${n} status`, { success: true, taskId: n, updatedFields: ["status"], statusChange: { to } });
  it("reads the agent's plan from Claude Code's to-do tools, a step at a time", () => {
    const st = newClaudeState();
    const steps = (evs: RunnerEvent[]) => evs.map(e => [e.type, (e.data as { steps: { text: string; state: string }[] }).steps.map(s => `${s.state} ${s.text}`)]);
    // Three steps added in one message: the plan is passed on once every one of them has its id.
    const made = feed([
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: ["Read the scene", "Trim the pause", "Check the join"].map((subject, i) => (
        { type: "tool_use", id: `c${i + 1}`, name: "TaskCreate", input: { subject, description: subject } })) } }),
      created("c1", "1", "Read the scene"), created("c2", "2", "Trim the pause"), created("c3", "3", "Check the join"),
    ], st, parseClaudeLine);
    expect(steps(made)).toEqual([["plan", ["pending Read the scene", "pending Trim the pause", "pending Check the join"]]]);
    expect(made[0]!.text).toBe("[ ] Read the scene\n[ ] Trim the pause\n[ ] Check the join");
    // A step changes when the tool says it did, not when the model asks.
    expect(feed([use("u1", "TaskUpdate", { taskId: "1", status: "in_progress" })], st, parseClaudeLine)).toEqual([]);
    expect(steps(feed([updated("u1", "1", "in_progress")], st, parseClaudeLine)))
      .toEqual([["plan", ["in_progress Read the scene", "pending Trim the pause", "pending Check the join"]]]);
    const next = feed([
      use("u2", "TaskUpdate", { taskId: "1", status: "completed" }), updated("u2", "1", "completed"),
      use("u3", "TaskUpdate", { taskId: "2", status: "in_progress", subject: "Trim the long pause" }), updated("u3", "2", "in_progress"),
      use("u4", "TaskUpdate", { taskId: "3", status: "deleted" }), done("u4", "Updated task #3 deleted", { success: true, taskId: "3" }),
    ], st, parseClaudeLine);
    expect(steps(next).at(-1)).toEqual(["plan", ["done Read the scene", "in_progress Trim the long pause"]]);
    expect(next.at(-1)!.text).toBe("[x] Read the scene\n[>] Trim the long pause");
    // A refused update, a look at the list and a step it doesn't know change nothing, and none is logged as a Scarlet tool.
    expect(feed([
      use("u5", "TaskUpdate", { taskId: "2", status: "completed" }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "u5", type: "tool_result", is_error: true, content: "No such task" }] } }),
      use("l1", "TaskList", {}), done("l1", "#1 [completed] Read the scene", undefined),
      use("u6", "TaskUpdate", { taskId: "9", status: "completed" }), updated("u6", "9", "completed"),
    ], st, parseClaudeLine)).toEqual([]);
  });
  it("reads the whole list from an older Claude Code's TodoWrite", () => {
    // The shape Claude Code documents for TodoWrite. 2.1.316 no longer has the tool, so this one isn't a recording.
    const st = newClaudeState();
    const todos = [{ content: "Read the scene", status: "completed", activeForm: "Reading the scene" }, { content: "Trim the pause", status: "in_progress", activeForm: "Trimming the pause" }, { content: "Check the join", status: "pending", activeForm: "Checking the join" }];
    const evs = feed([use("t1", "TodoWrite", { todos }), done("t1", "Todos have been modified successfully", undefined), use("t2", "TodoWrite", { todos })], st, parseClaudeLine);
    expect(evs).toEqual([{ type: "plan", text: "[x] Read the scene\n[>] Trim the pause\n[ ] Check the join",
      data: { steps: [{ text: "Read the scene", state: "done" }, { text: "Trim the pause", state: "in_progress" }, { text: "Check the join", state: "pending" }] } }]);
  });
  it("gives a request's Claude Code its own shell, file and web tools, the shell sandboxed and the control files closed", () => {
    const workspace = { binDir: "/w/.tools", readDirs: ["/Applications/Google Chrome.app"] };
    const cmd = buildClaudeCommand({ instruction: "x", systemPrompt: "SYS", mcp, workspace }, "claude", "/w/.scarlet");
    const after = (flag: string) => cmd.args[cmd.args.indexOf(flag) + 1];
    expect(after("--tools")).toBe("ToolSearch,Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
    expect(after("--allowedTools")).toBe("mcp__scarlet__*,ToolSearch,Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,WebFetch(domain:*)");
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(JSON.parse(after("--settings"))).toEqual({
      sandbox: { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
        network: { allowedDomains: ["*"] },
        filesystem: { denyRead: ["/w/.scarlet"], allowRead: ["/Applications/Google Chrome.app"] } },
      permissions: { blockReadsOutsideWorkingDirectories: true, allow: ["WebFetch(domain:*)"], deny: ["Read(//w/.scarlet/**)", "Edit(//w/.scarlet/**)"] },
    });
    // With its plan asked for too, both.
    const planned = buildClaudeCommand({ instruction: "x", systemPrompt: "SYS", mcp, workspace, plan: true }, "claude", "/w/.scarlet");
    expect(planned.args[planned.args.indexOf("--tools") + 1]).toBe("ToolSearch,Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TaskCreate,TaskUpdate,TodoWrite");
  });
  it("runs a CLI without Scarlet's own variables, the workspace's launchers first on its PATH", () => {
    const env = workspaceEnv({ PATH: "/usr/bin", SCARLET_TOKEN: "secret", scarlet_server: "http://x", HOME: "/h" }, { binDir: "/w/.tools", readDirs: [] });
    expect(env).toEqual({ PATH: `/w/.tools${process.platform === "win32" ? ";" : ":"}/usr/bin`, HOME: "/h" });
    expect(workspaceEnv({ PATH: "/usr/bin", SCARLET_TOKEN: "secret" }, undefined)).toEqual({ PATH: "/usr/bin" });
  });
  it("builds the command line with files for mcp config and system prompt", () => {
    const cmd = buildClaudeCommand({ instruction: "Make the first cut", systemPrompt: "SYS", mcp, model: "opus" }, "claude", "/tmp/t");
    expect(cmd.args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--mcp-config", expect.stringMatching(/mcp\.json$/), "--strict-mcp-config",
      "--restricted", "--disable-slash-commands", "--tools", "ToolSearch", "--allowedTools", "mcp__scarlet__*,ToolSearch", "--append-system-prompt-file", expect.stringMatching(/system\.md$/), "--permission-mode", "dontAsk",
      "--model", "opus", "--settings", expect.any(String),
    ]);
    const resumed = buildClaudeCommand({ instruction: "The editor answered", systemPrompt: "SYS", mcp, resumeSession: "s1" }, "claude", "/tmp/t", true);
    expect(resumed.args.slice(0, 2)).toEqual(["-p", "--bare"]);
    expect(resumed.args.join(" ")).toContain("--permission-mode dontAsk --resume s1 --settings");
    expect(resumed.stdin).toBe("The editor answered");
    expect(claudeCanRunBare({ ANTHROPIC_API_KEY: "sk-ant" })).toBe(true);
    expect(claudeCanRunBare({ PATH: "/bin" })).toBe(false);
    expect(cmd.stdin).toBe("Make the first cut");
    const hostile = buildClaudeCommand({ instruction: "--settings={}", systemPrompt: "SYS", mcp }, "claude", "/tmp/t");
    expect(hostile.stdin).toBe("--settings={}");
    expect(hostile.args).not.toContain("--settings={}");
    const mcpJson = JSON.parse(Object.entries(cmd.files).find(([k]) => k.endsWith("mcp.json"))![1]);
    expect(mcpJson.mcpServers.scarlet).toEqual(mcp);
    const long = buildClaudeCommand({ instruction: "line1\nline2", systemPrompt: "SYS", mcp }, "claude", "/tmp/t");
    expect(long.args[1]).toBe("--output-format");
    // Asked for the agent's plan, the CLI gets its own to-do tools and still nothing else of its own.
    const planned = buildClaudeCommand({ instruction: "x", systemPrompt: "SYS", mcp, plan: true }, "claude", "/tmp/t");
    expect(planned.args[planned.args.indexOf("--tools") + 1]).toBe("ToolSearch,TaskCreate,TaskUpdate,TodoWrite");
    expect(planned.args.filter((a, i) => i !== planned.args.indexOf("--tools") + 1)).toEqual(long.args.filter((a, i) => i !== long.args.indexOf("--tools") + 1));
    expect(long.stdin).toBe("line1\nline2");
    const tuned = buildClaudeCommand({ instruction: "x", systemPrompt: "SYS", mcp, model: "opus", effort: "max", fast: true }, "claude", "/tmp/t");
    expect(tuned.args.slice(-6, -1)).toEqual(["--model", "opus", "--effort", "max", "--settings"]);
    // No shell tool runs here for the sandbox to wrap, so a machine that can't start it still runs the edit.
    expect(JSON.parse(tuned.args.at(-1)!)).toStrictEqual({ fastMode: true, sandbox: { enabled: true, allowUnsandboxedCommands: false } });
  });
});

describe("codex exec --json parser", () => {
  const fixture = [
    '{"type":"thread.started","thread_id":"t_1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"Need to read the transcript first."}}',
    '{"type":"item.started","item":{"id":"i1","type":"mcp_tool_call","server":"scarlet","tool":"transcript_get","arguments":{"mediaId":"m1"},"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","server":"scarlet","tool":"transcript_get","arguments":{"mediaId":"m1"},"status":"completed","result":{"content":[]}}}',
    '{"type":"item.started","item":{"id":"i2","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"bash -lc ls","aggregated_output":"a\\nb","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Proposed the first cut as chg_2."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
  ];
  it("maps items to events and takes the last agent message as the result", () => {
    const st = newCodexState();
    const evs = feed(fixture, st, parseCodexLine);
    expect(evs.map((e) => e.type)).toEqual(["log", "log", "tool", "tool", "log", "result"]);
    expect(evs[2]!.text).toBe('scarlet.transcript_get {"mediaId":"m1"}');
    expect(evs[3]!.text).toBe("shell bash -lc ls");
    expect(evs[5]!.text).toBe("Proposed the first cut as chg_2.");
    expect(st.turnCompleted).toBe(true);
    expect(st.lastMessage).toBe("Proposed the first cut as chg_2.");
  });
  it("reports a compaction while it runs and once it completes", () => {
    const st = newCodexState();
    const evs = feed([
      '{"type":"item.started","item":{"id":"c1","type":"contextCompaction"}}',
      '{"type":"item.completed","item":{"id":"c1","type":"contextCompaction"}}',
    ], st, parseCodexLine);
    expect(evs).toEqual([
      { type: "log", text: "Compacting context", data: { kind: "compaction", active: true } },
      { type: "log", text: "Context compacted", data: { kind: "compaction" } },
    ]);
  });
  it("handles questions, failed turns and bare errors", () => {
    const st = newCodexState();
    const evs = feed(
      [
        '{"type":"item.started","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"completed"}}',
      ],
      st,
      parseCodexLine,
    );
    expect(evs).toEqual([{ type: "question", text: "Which take?", data: { tool: "scarlet.task_question", itemId: "q" } }]);
    expect(st.question).toBe("Which take?");
    expect(st.questionPosted).toBe(true);
    expect(st.shouldStop).toBe(true);

    // Held while it runs, should the CLI stop before its result; refused, it was never asked, and the run goes on.
    const ask = (type: string, args: object, extra: object = {}) => JSON.stringify({ type, item: { id: "r", type: "mcp_tool_call", server: "scarlet", tool: "task_question", arguments: args, ...extra } });
    const held = newCodexState();
    expect(feed([ask("item.started", { text: "Which take?" })], held, parseCodexLine)).toEqual([]);
    expect(held.question).toBe("Which take?");
    feed([ask("item.completed", { text: "Which take?", options: "a" }, { status: "failed", error: { message: "options: Expected array" } })], held, parseCodexLine);
    expect(held.question).toBeUndefined();
    expect(held).toMatchObject({ questionPosted: false, shouldStop: false });
    const empty = newCodexState();
    expect(feed([ask("item.started", {}), ask("item.completed", {}, { status: "failed", error: { message: "text: Required" } })], empty, parseCodexLine).map((e) => e.type)).toEqual(["tool", "error"]);
    expect(empty.question).toBeUndefined();
    // The MCP server's own refusal comes as a completed call whose result is an error, as the desktop host reads it.
    const refused = newCodexState();
    expect(feed([ask("item.started", { text: "Which take?" }), ask("item.completed", { text: "Which take?" }, { status: "completed", result: { isError: true, content: [{ type: "text", text: "Answer the last one first" }] } })], refused, parseCodexLine).map((e) => e.type)).toEqual(["error"]);
    expect(refused).toMatchObject({ questionPosted: false, shouldStop: false });
    expect(refused.question).toBeUndefined();
    // The question is the call that asked it: a second call Scarlet refuses doesn't clear the one still held.
    const two = newCodexState();
    const other = JSON.stringify({ type: "item.completed", item: { id: "s", type: "mcp_tool_call", server: "scarlet", tool: "task_question", arguments: { text: "And the music?" }, status: "failed", error: { message: "one at a time" } } });
    expect(feed([ask("item.started", { text: "Which take?" }), other], two, parseCodexLine).map((e) => e.type)).toEqual(["error"]);
    expect(two.question).toBe("Which take?");
    expect(feed([ask("item.completed", { text: "Which take?" }, { status: "completed" })], two, parseCodexLine)).toEqual([{ type: "question", text: "Which take?", data: { tool: "scarlet.task_question", itemId: "r" } }]);
    expect(empty.shouldStop).toBe(false);

    const st2 = newCodexState();
    const e2 = feed(['{"type":"turn.failed","error":{"message":"rate limited"}}', '{"type":"error","message":"boom"}'], st2, parseCodexLine);
    expect(e2.map((e) => [e.type, e.text])).toEqual([["error", "rate limited"], ["error", "boom"]]);
    expect(st2.failed).toBe("boom");
  });
  it("carries on after Codex recovers from a dropped stream", () => {
    const st = newCodexState();
    const drop = "stream disconnected before completion: websocket closed by server before response.completed";
    const evs = feed([
      `{"type":"error","message":"Reconnecting... 2/5 (${drop})"}`,
      `{"type":"item.completed","item":{"id":"w","type":"error","message":"Falling back from WebSockets to HTTPS transport. ${drop}"}}`,
      '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Saved all 119 recommendations."}}',
      '{"type":"turn.completed","usage":{}}',
    ], st, parseCodexLine);
    expect(evs.map((e) => e.type)).toEqual(["log", "log", "log", "result"]);
    expect(st.failed).toBeUndefined();
    expect(st.retryNotice).toContain("Reconnecting... 2/5");
    expect(st.turnCompleted).toBe(true);
    // A retry that never recovers still fails the turn.
    const gaveUp = newCodexState();
    feed([`{"type":"error","message":"Reconnecting... 5/5 (${drop})"}`, `{"type":"turn.failed","error":{"message":"${drop}"}}`], gaveUp, parseCodexLine);
    expect(gaveUp.failed).toBe(drop);
  });
  it("passes on the plan Codex keeps, once for each change", () => {
    // Recorded from codex-cli 0.166.0-alpha.5.1 run with tools.update_plan.enabled=true: the whole list each time, and
    // the last one again as the turn ends. A step is finished or not; nothing says which is under way.
    const list = (kind: string, ...completed: boolean[]) => JSON.stringify({ type: kind, item: { id: "item_1", type: "todo_list",
      items: completed.map((c, i) => ({ text: `Step ${i + 1}`, completed: c })) } });
    const st = newCodexState();
    const evs = feed([
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll make the two plan updates now."}}',
      list("item.started", false, false, false), list("item.updated", true, false, false),
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}',
      list("item.completed", true, false, false),
    ], st, parseCodexLine);
    expect(evs.map(e => e.type)).toEqual(["log", "plan", "plan", "log"]);
    expect(evs[1]).toEqual({ type: "plan", text: "[ ] Step 1\n[ ] Step 2\n[ ] Step 3",
      data: { steps: [{ text: "Step 1", state: "pending" }, { text: "Step 2", state: "pending" }, { text: "Step 3", state: "pending" }] } });
    expect(evs[2]!.text).toBe("[x] Step 1\n[ ] Step 2\n[ ] Step 3");
    // A list Scarlet can't read is passed over.
    expect(parseCodexLine('{"type":"item.updated","item":{"id":"item_1","type":"todo_list"}}', st)).toEqual([]);
  });
  it("gives a request's Codex its shell, a look at pictures, the live web and reads of its programs' folders", () => {
    const workspace = { binDir: "/w/.tools", readDirs: ["/Applications/Google Chrome.app", "/opt/ffmpeg/bin"] };
    const cmd = buildCodexCommand({ instruction: "x", systemPrompt: "SYS", mcp, cwd: "/w", workspace }, "codex", "/w/.scarlet");
    const disabled = cmd.args.flatMap((a, i) => cmd.args[i - 1] === "--disable" ? [a] : []);
    expect(disabled).toEqual(["computer_use", "multi_agent", "plugins", "apps", "hooks"]);
    expect(cmd.args).toContain('web_search="live"');
    expect(cmd.args).toContain("permissions.scarlet.network.enabled=true");
    expect(cmd.args).toContain(`permissions.scarlet.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"},"/Applications/Google Chrome.app"="read","/opt/ffmpeg/bin"="read"}`);
    // The token stays out of the shell, which has the network now.
    expect(cmd.args).toContain('shell_environment_policy.exclude=["SCARLET_*"]');
    // A side check has none of it.
    const side = buildCodexCommand({ instruction: "x", systemPrompt: "SYS", mcp, cwd: "/w" }, "codex", "/w/.scarlet");
    expect(side.args.flatMap((a, i) => side.args[i - 1] === "--disable" ? [a] : [])).toEqual(["shell_tool", "view_image", ...disabled]);
    expect(side.args).toContain('web_search="disabled"');
    expect(side.args).toContain("permissions.scarlet.network.enabled=false");
  });
  it.skipIf(process.platform !== "darwin")("allows the resolved Codex executable without opening its installation directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "scarlet-codex-"));
    try {
      const target = join(dir, 'codex "native"');
      const link = join(dir, "codex");
      writeFileSync(target, "fixture");
      symlinkSync(target, link);
      const cmd = buildCodexCommand({ instruction: "x", systemPrompt: "SYS", mcp, cwd: "/w" }, link, "/w/.scarlet");
      const resolved = realpathSync(target);
      expect(cmd.file).toBe(resolved);
      expect(cmd.args).toContain(`permissions.scarlet.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"},${tomlString(resolved)}="read"}`);
      expect(cmd.args).toContain("permissions.scarlet.network.enabled=false");
      expect(cmd.args).not.toContain("danger-full-access");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("builds -c overrides as valid TOML", () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlInlineTable({ A: "1", B: 'x"y' })).toBe('{A="1",B="x\\"y"}');
    const cmd = buildCodexCommand({ instruction: "Cut it", systemPrompt: "SYS", mcp, cwd: "C:\\work\\t1", model: "gpt-5-codex" }, "codex.cmd", "C:\\work\\t1\\.scarlet");
    expect(cmd.args.slice(0, 5)).toEqual(["exec", "--json", "--skip-git-repo-check", "--cd", "C:\\work\\t1"]);
    expect(cmd.args).toContain('default_permissions="scarlet"');
    expect(cmd.args.includes('windows.sandbox="mxc"')).toBe(process.platform === "win32");
    expect(cmd.args).toContain('mcp_servers.scarlet.default_tools_approval_mode="approve"');
    expect(cmd.args).toContain("shell_tool");
    expect(cmd.args).not.toContain(mcp.env.SCARLET_TOKEN);
    expect(cmd.args).toContain('mcp_servers.scarlet.command="C:/Program Files/nodejs/node.exe"');
    expect(cmd.args).toContain('mcp_servers.scarlet.args=["C:/scarlet/packages/mcp/dist/cli.js"]');
    expect(cmd.args).toContain('mcp_servers.scarlet.env_vars=["SCARLET_SERVER","SCARLET_TOKEN"]');
    expect(cmd.args).toContain("mcp_servers.scarlet.required=true");
    // The whole prompt reaches Codex. Left alone it reads only the first 32 KiB of AGENTS.md, and a long timeline's
    // prompt runs past that. Checked against codex-cli 0.166.0-alpha.5.1: it takes the key under --strict-config, and
    // `codex debug prompt-input` shows a 40 KB AGENTS.md whole with it and cut at 32,768 bytes without.
    expect(cmd.args.join(" ")).toContain("-c project_doc_max_bytes=4194304 ");
    expect(cmd.stdin).toBe("Cut it");
    expect(cmd.args.slice(-3)).toEqual(["--model", "gpt-5-codex", "-"]);
    expect(Object.keys(cmd.files)[0]).toMatch(/AGENTS\.md$/);
    const long = buildCodexCommand({ instruction: "a\nb", systemPrompt: "SYS", mcp, cwd: "/w" }, "codex", "/w/.scarlet");
    expect(long.args[long.args.length - 1]).toBe("-");
    // Codex's to-do tool is switched on only when the engine asks for the agent's plan.
    expect(long.args).not.toContain("tools.update_plan.enabled=true");
    const planned = buildCodexCommand({ instruction: "a\nb", systemPrompt: "SYS", mcp, cwd: "/w", plan: true }, "codex", "/w/.scarlet");
    expect(planned.args.filter(a => !long.args.includes(a))).toEqual(["tools.update_plan.enabled=true"]);
    expect(long.stdin).toBe("a\nb");
    const tuned = buildCodexCommand({ instruction: "x", systemPrompt: "SYS", mcp, cwd: "/w", effort: "ultra", serviceTier: "priority" }, "codex", "/w/.scarlet");
    expect(tuned.args.slice(-5)).toEqual(["-c", 'model_reasoning_effort="ultra"', "-c", 'service_tier="priority"', "-"]);
    // Ephemeral: Scarlet runs stay out of the user's Codex thread list.
    expect(cmd.args).toContain("--ephemeral");
    expect(cmd.args).not.toContain("resume");
  });
});

describe("gemini ACP parser", () => {
  const upd = (update: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "g1", update } });
  const fixture = [
    upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking transcript first." } }),
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the " } }),
    upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "transcript." } }),
    upd({ sessionUpdate: "tool_call", toolCallId: "c1", name: "mcp__scarlet__transcript_get", rawInput: { mediaId: "m1" } }),
    upd({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { text: "ok" } }),
    upd({ sessionUpdate: "tool_call", toolCallId: "c2", name: "mcp__scarlet__task_question", rawInput: { text: "9:16 or 16:9?" } }),
    upd({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed", rawOutput: "Question posted" }),
  ];

  it("accumulates thought and text deltas, maps tools and detects the question", () => {
    const st = newGeminiState();
    const evs = feed(fixture, st, parseGeminiLine);
    expect(evs.map((e) => e.type)).toEqual(["log", "log", "tool", "question"]);
    expect(evs[0]!.text).toBe("(thinking) Checking transcript first.");
    expect(evs[1]!.text).toBe("Reading the transcript.");
    expect(evs[2]!.text).toBe('scarlet.transcript_get {"mediaId":"m1"}');
    expect(st.question).toBe("9:16 or 16:9?");
    expect(st.questionPosted).toBe(true);
    expect(st.shouldStop).toBe(true);
    expect(st.lastMessage).toBe("Reading the transcript.");
  });

  it("trims flushed assistant messages and keeps the latest one as lastMessage", () => {
    const st = newGeminiState();
    const evs = feed([
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nChecking the transitions.\n" } }),
      upd({ sessionUpdate: "tool_call", toolCallId: "c1", name: "mcp__scarlet__timeline_get", rawInput: {} }),
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nFraming the demo." } }),
      upd({ sessionUpdate: "tool_call", toolCallId: "c2", name: "mcp__scarlet__timeline_propose", rawInput: {} }),
    ], st, parseGeminiLine);
    expect(evs.filter((e) => e.type === "log").map((e) => e.text)).toEqual(["Checking the transitions.", "Framing the demo."]);
    expect(st.texts).toEqual(["Checking the transitions.", "Framing the demo."]);
    expect(st.lastMessage).toBe("Framing the demo.");
  });

  it("maps ACP plan updates and failed tool calls", () => {
    const st = newGeminiState();
    const evs = feed([
      upd({ sessionUpdate: "plan", entries: [{ content: "Inspect footage", status: "completed" }, { content: "Cut pauses", status: "in_progress" }] }),
      upd({ sessionUpdate: "tool_call", toolCallId: "c1", name: "mcp__scarlet__timeline_propose", rawInput: {} }),
      upd({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", rawOutput: { error: "Invalid ops" } }),
    ], st, parseGeminiLine);
    expect(evs.map((e) => e.type)).toEqual(["plan", "tool", "error"]);
    expect(evs[0]!.data).toEqual({ steps: [{ text: "Inspect footage", state: "done" }, { text: "Cut pauses", state: "in_progress" }] });
    expect(evs[2]!.text).toContain("Invalid ops");
  });

  it("reads what a file holds as text, not as a path, and still checks every path", () => {
    const roots = ["/w"];
    const write = (rawInput: object) => workspacePermission({ toolCall: { name: "write_file", rawInput } }, roots);
    // A file's content that opens with a comment starts with a slash, and one that imports from a folder above has `../`: neither is where the file is.
    expect(write({ file_path: "/w/artifacts/title.js", content: "// The title card\nconst title = 'Ana';\n" })).toBe(true);
    expect(write({ file_path: "artifacts/title.css", content: "/* The look */\r\n@import '../base.css';\n" })).toBe(true);
    // The path itself is checked as before, with or without a break at its ends, and so is content of one line that reads as a path.
    expect(write({ file_path: "/etc/hosts", content: "// The title card\nconst title = 'Ana';\n" })).toBe(false);
    expect(write({ file_path: "/etc/hosts\n", content: "x" })).toBe(false);
    expect(write({ file_path: "\n../outside.txt", content: "x" })).toBe(false);
    expect(write({ file_path: "artifacts/a.txt", content: "/etc/hosts" })).toBe(false);
    // On Windows a path that starts with a backslash is from the drive's root, or a share: it is checked, not waved through.
    expect([namesPath("\\Users\\me\\secret.txt", true), namesPath("\\\\server\\share\\x", true)]).toEqual([true, true]);
    expect([namesPath("\\d+\\.jpg", false), namesPath("artifacts\\a.txt", true), namesPath("C:\\Users\\me", false)]).toEqual([false, false, true]);
    expect([namesPath("// a comment\ncode", true), namesPath("/w/a.txt", false), namesPath("~/x", false), namesPath("a/../b", false)]).toEqual([false, true, true, true]);
  });

  it("enforces Scarlet MCP-only permissions and builds the agy acp command", () => {
    // A request's agent may use agy's own tools inside its folders; a path outside them, or one in the home, is refused.
    const roots = ["/w"];
    expect(workspacePermission({ toolCall: { name: "mcp__scarlet__timeline_get" } }, roots)).toBe(true);
    expect(workspacePermission({ toolCall: { name: "run_shell_command", rawInput: { command: "ffmpeg -version" } } }, roots)).toBe(true);
    expect(workspacePermission({ toolCall: { name: "write_file", locations: [{ path: "/w/artifacts/page.html" }] } }, roots)).toBe(true);
    expect(workspacePermission({ toolCall: { name: "web_fetch", rawInput: { url: "https://example.com/story" } } }, roots)).toBe(true);
    expect(workspacePermission({ toolCall: { name: "read_file", rawInput: { absolute_path: "/Users/me/Library/Application Support/com.forwardfuture.scarlet/data/access-token" } } }, roots)).toBe(false);
    expect(workspacePermission({ toolCall: { name: "read_file", locations: [{ path: "/w/../etc/passwd" }] } }, roots)).toBe(false);
    expect(workspacePermission({ toolCall: { name: "read_file", rawInput: { path: "~/.ssh/id_rsa" } } }, roots)).toBe(false);
    expect(workspacePermission({ toolCall: { name: "list_dir", rawInput: { paths: ["/w/artifacts", "/w2"] } } }, roots)).toBe(false);
    expect(isScarletMcpPermission({ toolCall: { name: "mcp__scarlet__timeline_get" } })).toBe(true);
    expect(isScarletMcpPermission({ toolCall: { _meta: { mcpServer: "scarlet" }, title: "read" } })).toBe(true);
    expect(isScarletMcpPermission({ toolCall: { name: "bash", title: "Run shell" } })).toBe(false);
    expect(isScarletMcpPermission({ toolCall: { name: "read_file", _meta: { mcpServer: "other" } } })).toBe(false);
    // agy names Scarlet's tools `mcp_scarlet_<tool>`; its titles are the model's own words for the call.
    expect(isScarletMcpPermission({ toolCall: { name: "mcp_scarlet_timeline_get", title: "Check the timeline" } })).toBe(true);
    expect(isScarletMcpPermission({ toolCall: { toolName: "scarlet/dialogue_apply_cuts" } })).toBe(true);
    expect(isScarletMcpPermission({ toolCall: { title: "scarlet.tool_help (read a tool)" } })).toBe(true);
    expect(isScarletMcpPermission({ toolCall: { name: "mcp_scarlet_tool_call", title: "Read the dialogue" } })).toBe(true);
    // A path or file that starts like a Scarlet tool is not one.
    for (const name of ["scarlet/notes.md", "scarlet.json", "scarlet/timeline_get.md", "scarlet:timeline_getx", "mcp_scarlet_rm", "scarlet/../etc"]) {
      expect(isScarletMcpPermission({ toolCall: { name } })).toBe(false);
      expect(isScarletMcpPermission({ toolCall: { title: name } })).toBe(false);
    }
    // A built-in tool stays refused whatever its title says.
    expect(isScarletMcpPermission({ toolCall: { name: "run_command", title: "mcp_scarlet_timeline_get" } })).toBe(false);
    expect(isScarletMcpPermission({ toolCall: { name: "write_to_file", title: "scarlet/notes.md" } })).toBe(false);

    const opts = [{ optionId: "a1", kind: "allow_once" }, { optionId: "r1", kind: "reject_once" }];
    expect(permissionOutcome({ options: opts }, true)).toEqual({ outcome: "selected", optionId: "a1" });
    expect(permissionOutcome({ options: opts }, false)).toEqual({ outcome: "selected", optionId: "r1" });
    expect(permissionOutcome({ options: [] }, false)).toEqual({ outcome: "cancelled" });

    expect(buildGeminiCommand("agy")).toEqual({ file: "agy", args: ["acp", "--sandbox", "--disable-telemetry"] });
    // The run's own Gemini folder keeps the user's personal GEMINI.md and plugin rules out.
    expect(geminiDir("/w/tasks-v2/tsk_1/")).toBe("/w/tasks-v2/tsk_1.gemini");
    expect(buildGeminiCommand("agy", "/w/tasks-v2/tsk_1.gemini").args).toEqual(["acp", "--sandbox", "--disable-telemetry", "--gemini-dir", "/w/tasks-v2/tsk_1.gemini"]);
    expect(acpMcpServer(mcp)).toEqual({
      name: "scarlet",
      command: mcp.command,
      args: mcp.args,
      env: [
        { name: "SCARLET_SERVER", value: "http://localhost:4000" },
        { name: "SCARLET_TOKEN", value: 'a"b' },
      ],
    });
  });

  it("reads a relative path from the task folder, so one that climbs out of it is refused", () => {
    const roots = ["/w"];
    const allow = (toolCall: Record<string, unknown>) => workspacePermission({ toolCall }, roots, ["/Applications/Google Chrome.app"]);
    // Three folders up from a task folder is Scarlet's own, where its token is kept.
    expect(allow({ name: "read_file", rawInput: { path: "../../../agent.json" } })).toBe(false);
    expect(allow({ name: "read_file", rawInput: { file_path: "artifacts/../../secret" } })).toBe(false);
    expect(allow({ name: "read_file", locations: [{ path: "../secret" }] })).toBe(false);
    // Inside the task folder, a relative path is fine, as are words that only look like one.
    expect(allow({ name: "write_file", rawInput: { file_path: "artifacts/page.html", content: "<a href=\"../index.html\">back</a>" } })).toBe(true);
    expect(allow({ name: "read_file", rawInput: { path: "artifacts/../notes.md" } })).toBe(true);
    expect(allow({ name: "read_file", locations: [{ path: "artifacts/page.html" }] })).toBe(true);
    expect(allow({ name: "run_shell_command", rawInput: { command: "cd .. && ls" } })).toBe(true);
    // With no folder to read it from, a relative path is refused.
    expect(workspacePermission({ toolCall: { name: "read_file", locations: [{ path: "notes.md" }] } }, [""])).toBe(false);
  });

  it("normalizes unnormalized workspace roots and ignores empty roots", () => {
    expect(workspacePermission({ toolCall: { name: "write_file", locations: [{ path: "/w/artifacts/page.html" }] } }, ["/w/sub/.."])).toBe(true);
    expect(workspacePermission({ toolCall: { name: "read_file", locations: [{ path: "/w/../etc/passwd" }] } }, ["/w/sub/.."])).toBe(false);
    expect(workspacePermission({ toolCall: { name: "list_dir", rawInput: { paths: ["/w/artifacts", "/w2"] } } }, ["/w/sub/.."])).toBe(false);
    expect(workspacePermission({ toolCall: { name: "read_file", locations: [{ path: process.cwd() }] } }, [""])).toBe(false);
    expect(workspacePermission({ toolCall: { name: "read_file", locations: [{ path: "/etc/passwd" }] } }, ["", "   "])).toBe(false);
  });

  it("follows links and hard links out of the task folder, so a link the shell made there leads nowhere else", () => {
    const base = mkdtempSync(join(tmpdir(), "scarlet-perm-"));
    try {
      const task = join(base, "work", "tsk_1");
      mkdirSync(task, { recursive: true });
      writeFileSync(join(base, "agent.json"), "{\"token\":\"secret\"}");
      writeFileSync(join(task, "notes.md"), "notes");
      symlinkSync(join(base, "agent.json"), join(task, "a.json"));
      symlinkSync(join(task, "notes.md"), join(task, "b.md"));
      symlinkSync(join(base, "nowhere.txt"), join(task, "c.txt"));
      linkSync(join(base, "agent.json"), join(task, "d.json"));
      const allow = (toolCall: Record<string, unknown>) => workspacePermission({ toolCall }, [task]);
      // A link to a file outside, by its full path, by its plain name, or under any key a file tool names a file with.
      expect(allow({ name: "read_file", locations: [{ path: join(task, "a.json") }] })).toBe(false);
      expect(allow({ name: "read_file", rawInput: { path: "a.json" } })).toBe(false);
      expect(allow({ name: "write_file", rawInput: { file_path: "a.json", content: "x" } })).toBe(false);
      expect(allow({ name: "list_dir", rawInput: { paths: ["notes.md", "a.json"] } })).toBe(false);
      // A link to nowhere, which a write would make the file at the far end of, and a second hard link to a file.
      expect(allow({ name: "write_file", rawInput: { file_path: "c.txt", content: "x" } })).toBe(false);
      expect(allow({ name: "read_file", rawInput: { absolute_path: join(task, "d.json") } })).toBe(false);
      // A real file, a new one, one in a new folder, and a link that stays inside are all fine.
      expect(allow({ name: "read_file", rawInput: { path: "notes.md" } })).toBe(true);
      expect(allow({ name: "write_file", locations: [{ path: join(task, "artifacts", "page.html") }], rawInput: { file_path: "artifacts/page.html" } })).toBe(true);
      expect(allow({ name: "read_file", rawInput: { path: "b.md" } })).toBe(true);
      expect(allow({ name: "list_dir", rawInput: { dir_path: "." } })).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("lets a call only read, never write, the folders a request's programs live in", () => {
    const allow = (toolCall: Record<string, unknown>) => workspacePermission({ toolCall }, ["/w"], ["/opt/scarlet-fixture/bin"]);
    expect(allow({ name: "write_file", kind: "edit", rawInput: { file_path: "/opt/scarlet-fixture/bin/ffmpeg", content: "x" } })).toBe(false);
    expect(allow({ name: "write_file", kind: "edit", locations: [{ path: "/opt/scarlet-fixture/bin/new" }] })).toBe(false);
    expect(allow({ name: "move", kind: "move", rawInput: { source: "/w/a", destination: "/opt/scarlet-fixture/bin/ffmpeg" } })).toBe(false);
    expect(allow({ name: "write_file", rawInput: { file_path: "/opt/scarlet-fixture/bin/ffmpeg" } })).toBe(false);
    expect(allow({ name: "read_file", kind: "read", rawInput: { file_path: "/opt/scarlet-fixture/bin/ffmpeg" } })).toBe(true);
    expect(allow({ name: "run_shell_command", kind: "execute", rawInput: { command: "/opt/scarlet-fixture/bin/ffmpeg -version" } })).toBe(true);
    // And when agy omits `kind`, read/search/shell tool names still get readRoots, while edit/write tools do not.
    expect(allow({ name: "read_file", rawInput: { Path: "/opt/scarlet-fixture/bin/ffmpeg" } })).toBe(true);
    expect(allow({ name: "run_command", rawInput: { CommandLine: "/opt/scarlet-fixture/bin/ffmpeg -version" } })).toBe(true);
    expect(allow({ name: "edit_file", rawInput: { Path: "/opt/scarlet-fixture/bin/ffmpeg", Target: "a", Replacement: "b" } })).toBe(false);
    // `edit_file`'s `Target` is the text snippet to replace, not a file path (`~50ms` is not a home path).
    expect(allow({ name: "edit_file", kind: "edit", rawInput: { Path: "/w/artifacts/page.css", Target: "~50ms fade", Replacement: "100ms fade" } })).toBe(true);
    expect(allow({ name: "write_file", kind: "edit", rawInput: { file_path: "/w/artifacts/page.html" } })).toBe(true);
    expect(allow({ name: "read_file", kind: "read", rawInput: { file_path: "/etc/passwd" } })).toBe(false);
  });

  it("refuses a path it can't look at, rather than throwing and leaving agy without an answer", () => {
    // A name longer than any file system takes, in a folder that is there: both looks at it fail with ENAMETOOLONG.
    const task = mkdtempSync(join(tmpdir(), "scarlet-perm-"));
    try {
      const long = { toolCall: { name: "read_file", kind: "read", rawInput: { path: join(task, "a".repeat(300), "b.txt") } } };
      expect(() => workspacePermission(long, [task])).not.toThrow();
      // Windows takes long names, so there it is only a file not written yet, inside the task folder.
      expect(workspacePermission(long, [task])).toBe(process.platform === "win32");
    } finally {
      rmSync(task, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("recognises the question tool in every namespace style", () => {
    expect(isQuestionTool("mcp__scarlet__task_question")).toBe(true);
    expect(isQuestionTool("scarlet__task_question")).toBe(true);
    expect(isQuestionTool("task_question")).toBe(true);
    expect(isQuestionTool("mcp_scarlet_task_question")).toBe(true);
    expect(isQuestionTool("mcp__scarlet__task_log")).toBe(false);
    expect(prettyToolName("mcp__scarlet__timeline_get")).toBe("scarlet.timeline_get");
  });
  it("quotes cmd.exe arguments and wraps .cmd shims", () => {
    expect(quoteForCmd("plain")).toBe("plain");
    expect(quoteForCmd("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
    const direct = spawnSpec("/usr/bin/claude", ["-p"]);
    expect(direct).toEqual({ file: "/usr/bin/claude", args: ["-p"], verbatim: false });
    if (process.platform === "win32") {
      const shim = spawnSpec("C:\\npm\\codex.cmd", ["exec", "--cd", "C:\\my work"]);
      expect(shim.verbatim).toBe(true);
      expect(shim.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(shim.args[3]).toBe('"C:\\npm\\codex.cmd exec --cd "C:\\my work""');
    }
  });
});

describe("less common lines", () => {
  it("claude: plain-string messages, tool errors in every shape, a refused question, and lines it has no use for", () => {
    const st = newClaudeState();
    const evs = feed([
      '{"type":"assistant","message":{"content":"Starting on the intro."}}',
      '{"type":"user","message":{"content":"a tool result as plain text"}}',
      '{"type":"assistant","message":{"content":"   "}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"clip not found"},{"type":"image"},{"type":"text","text":"try media_list"}]}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":{"code":"E_RANGE"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","is_error":true}]}}',
      '{"type":"stream_event","event":{"type":"content_block_delta"}}',
      '{"type":"system","subtype":"hook_started"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"scarlet__task_question","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","is_error":true,"content":"text: Required"}]}}',
    ], st, parseClaudeLine);
    expect(evs).toEqual([
      { type: "log", text: "Starting on the intro." },
      { type: "error", text: "Tool error: clip not found\n\ntry media_list", data: { toolUseId: "t1" } },
      { type: "error", text: 'Tool error: {"code":"E_RANGE"}', data: { toolUseId: "t2" } },
      { type: "error", text: "Tool error: ", data: { toolUseId: "t3" } },
      // A question with no words is a call Scarlet refuses, not a question for the editor.
      { type: "tool", text: "scarlet.task_question", data: { tool: "scarlet__task_question", input: {}, toolUseId: "q1" } },
      { type: "error", text: "Tool error: text: Required", data: { toolUseId: "q1" } },
    ]);
    expect(st.texts).toEqual(["Starting on the intro."]);
    // The model hears why and tries again: nothing is asked, and the run goes on.
    expect(st.question).toBeUndefined();
    expect(st).toMatchObject({ questionPosted: false, shouldStop: false, started: true });
  });

  it("claude: a question Scarlet refused isn't asked, and the run goes on until one is", () => {
    const st = newClaudeState();
    const ask = (id: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__scarlet__task_question", input }] } });
    const answer = (id: string, isError: boolean, content: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] } });
    // Refused for its options' shape: the editor never sees the call's arguments.
    const evs = feed([ask("q1", { text: "Keep the intro?", options: "yes" }), answer("q1", true, "options: Expected array"), ask("q2", { text: "   " })], st, parseClaudeLine);
    expect(evs.map((e) => e.type)).toEqual(["error", "tool"]);
    expect([st.question, st.pendingQuestion]).toEqual([undefined, undefined]);
    expect(st).toMatchObject({ questionPosted: false, shouldStop: false });
    // A question is said once the engine has it, as the desktop host says it.
    expect(feed([ask("q3", { text: "Keep the intro?" })], st, parseClaudeLine)).toEqual([]);
    expect(feed([answer("q3", false, "Question posted")], st, parseClaudeLine)).toEqual([
      { type: "question", text: "Keep the intro?", data: { tool: "mcp__scarlet__task_question", toolUseId: "q3" } },
    ]);
    expect(st).toMatchObject({ question: "Keep the intro?", questionPosted: true, shouldStop: true });
  });

  it("claude: counts each API message once, and prefers the result's own totals", () => {
    const st = newClaudeState();
    const message = (id: string, output: number, model?: string) => JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: 10, output_tokens: output }, content: [] } });
    feed([message("m1", 1, "claude-sonnet-4-5"), message("m1", 5, "claude-sonnet-4-5"), message("m2", 7), '{"type":"assistant","message":{"usage":{"input_tokens":99},"content":[]}}'], st, parseClaudeLine);
    expect(claudeRunUsage(st)).toEqual({ model: "claude-sonnet-4-5", inputTokens: 20, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    expect(claudeRunUsage(newClaudeState(), "opus")).toBeUndefined();
    const unnamed = newClaudeState();
    feed([message("m1", 3)], unnamed, parseClaudeLine);
    expect(claudeRunUsage(unnamed, "opus")?.model).toBe("opus");
    feed(['{"type":"result","subtype":"success","result":"Done.","usage":{"input_tokens":40,"output_tokens":30}}'], st, parseClaudeLine);
    expect(claudeRunUsage(st)).toMatchObject({ inputTokens: 40, outputTokens: 30 });
  });

  it("codex: shell commands, failed tools, file edits, searches and the item types it ignores", () => {
    const st = newCodexState();
    const item = (type: string, body: object) => JSON.stringify({ type, item: body });
    const evs = feed([
      "Warning: config.toml is deprecated",
      '{"type":"turn.started"}',
      item("item.started", { type: "command_execution", command: "ls media" }),
      item("item.completed", { type: "command_execution", command: "ls media", exit_code: 0, aggregated_output: "a.mp4" }),
      item("item.completed", { type: "command_execution", command: "ffprobe x.mov", exit_code: 1, aggregated_output: "x.mov: No such file" }),
      item("item.started", { type: "mcp_tool_call", server: "scarlet", tool: "timeline_propose", arguments: { ops: [] } }),
      item("item.completed", { type: "mcp_tool_call", server: "scarlet", tool: "timeline_propose", status: "failed", error: { message: "Invalid ops" } }),
      item("item.completed", { type: "mcp_tool_call", tool: "media_list", status: "completed", result: { media: [] } }),
      item("item.updated", { type: "file_change", changes: [{ path: "notes.md" }] }),
      item("item.completed", { type: "file_change", changes: [{ path: "notes.md" }] }),
      item("item.started", { type: "web_search", query: "j-cut" }),
      item("item.completed", { type: "web_search", query: "j-cut" }),
      item("item.completed", { type: "error", message: "Falling back from WebSockets to HTTPS" }),
      item("item.completed", { type: "error", message: "sandbox denied the write" }),
      item("item.completed", { type: "error" }),
      item("item.completed", { type: "hologram" }),
      item("item.completed", { type: "reasoning", text: "Weighing the two takes." }),
      '{"type":"session.heartbeat"}',
    ], st, parseCodexLine);
    expect(evs.map((e) => [e.type, e.text])).toEqual([
      ["log", "Warning: config.toml is deprecated"],
      ["tool", "shell ls media"],
      ["error", "Command exited 1: ffprobe x.mov\nx.mov: No such file"],
      ["tool", 'scarlet.timeline_propose {"ops":[]}'],
      ["error", 'scarlet.timeline_propose failed: {"message":"Invalid ops"}'],
      ["tool", 'edited files [{"path":"notes.md"}]'],
      ["tool", "web search j-cut"],
      ["log", "Falling back from WebSockets to HTTPS"],
      ["error", "sandbox denied the write"],
      ["error", '{"type":"error"}'],
      ["log", "(thinking) Weighing the two takes."],
    ]);
    // An item-level error is shown, but only a turn or stream error fails the run.
    expect(st.failed).toBeUndefined();
    expect(st.texts).toEqual([]);
  });

  it("codex: adds up the tokens of every turn and words a failure that carries no message", () => {
    const st = newCodexState();
    const evs = feed([
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":5,"reasoning_output_tokens":2}}',
      '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":0,"output_tokens":1}}',
      '{"type":"turn.failed","error":{"code":"context_length_exceeded"}}',
      '{"type":"error"}',
    ], st, parseCodexLine);
    expect(st.usage).toEqual({ model: undefined, inputTokens: 26, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 2 });
    expect(evs.map((e) => [e.type, e.text])).toEqual([["result", "done"], ["result", "done"], ["error", '{"code":"context_length_exceeded"}'], ["error", '{"type":"error"}']]);
    expect(st.failed).toBe('{"type":"error"}');
  });

  it("codex: gives a failure that says nothing words of its own, so it still counts as one", () => {
    const failure = (line: string) => {
      const st = newCodexState();
      return [parseCodexLine(line, st).map((e) => [e.type, e.text]), st.failed];
    };
    expect(failure('{"type":"turn.failed"}')).toEqual([[["error", "turn failed"]], "turn failed"]);
    expect(failure('{"type":"turn.failed","error":{}}')).toEqual([[["error", "turn failed"]], "turn failed"]);
    // An empty message is no reason: the error is shown as Codex wrote it.
    expect(failure('{"type":"turn.failed","error":{"message":""}}')).toEqual([[["error", '{"message":""}']], '{"message":""}']);
    expect(failure('{"type":"error","message":""}')).toEqual([[["error", '{"type":"error","message":""}']], '{"type":"error","message":""}']);
  });

  it("gemini: non-JSON lines, partial chunks held until a tool call, and failed question updates", () => {
    const st = newGeminiState();
    const upd = (update: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "g1", update } });
    const evs = feed([
      "Loaded cached credentials.",
      upd({ sessionUpdate: "agent_message_chunk", content: [{ text: "Cutting " }, "the pause."] }),
      upd({ sessionUpdate: "tool_call", toolCallId: "t1", title: "timeline_propose", rawInput: {} }),
      upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "error", rawOutput: { error: "Invalid ops" } }),
      upd({ sessionUpdate: "tool_call", toolCallId: "q1", name: "mcp__scarlet__task_question" }),
      upd({ sessionUpdate: "tool_call_update", toolCallId: "q1", status: "failed", rawInput: { text: "Keep intro?" }, rawOutput: { error: "offline" } }),
      upd({ sessionUpdate: "unknown_event" }),
    ], st, parseGeminiLine);
    expect(evs.map((e) => [e.type, e.text])).toEqual([
      ["log", "Loaded cached credentials."],
      ["log", "Cutting the pause."],
      ["tool", "timeline_propose"],
      ["error", 'timeline_propose failed: {"error":"Invalid ops"}'],
      // A question Scarlet refused was never asked: no question, and the run goes on.
      ["error", 'scarlet.task_question failed: {"error":"offline"}'],
    ]);
    expect(st.texts).toEqual(["Cutting the pause."]);
    expect(st.question).toBeUndefined();
    expect(st).toMatchObject({ questionPosted: false, shouldStop: false, partial: "" });
    // Words that arrive with an update are held until the engine has the question, then said.
    const later = newGeminiState();
    expect(feed([upd({ sessionUpdate: "tool_call", toolCallId: "q2", name: "mcp__scarlet__task_question" }),
      upd({ sessionUpdate: "tool_call_update", toolCallId: "q2", status: "in_progress", rawInput: { text: "Keep intro?" } })], later, parseGeminiLine)).toEqual([]);
    expect(later.question).toBe("Keep intro?");
    expect(feed([upd({ sessionUpdate: "tool_call_update", toolCallId: "q2", status: "completed", rawOutput: "Question posted" })], later, parseGeminiLine).map((e) => [e.type, e.text]))
      .toEqual([["question", "Keep intro?"]]);
    expect(later).toMatchObject({ questionPosted: true, shouldStop: true });
    // The question is the call that asked it: a second call Scarlet refuses doesn't clear the one still held.
    const two = newGeminiState();
    expect(feed([upd({ sessionUpdate: "tool_call", toolCallId: "q3", name: "mcp__scarlet__task_question", rawInput: { text: "Keep intro?" } }),
      upd({ sessionUpdate: "tool_call", toolCallId: "q4", name: "mcp__scarlet__task_question", rawInput: { text: "And the music?" } }),
      upd({ sessionUpdate: "tool_call_update", toolCallId: "q4", status: "failed", rawOutput: { error: "one at a time" } })], two, parseGeminiLine).map((e) => e.type)).toEqual(["error"]);
    expect(two.question).toBe("Keep intro?");
    expect(feed([upd({ sessionUpdate: "tool_call_update", toolCallId: "q3", status: "completed", rawOutput: "Question posted" })], two, parseGeminiLine).map((e) => [e.type, e.text]))
      .toEqual([["question", "Keep intro?"]]);
  });

  it("shortens what it shows of a tool's input, and shows nothing for an empty one", () => {
    expect([undefined, null, {}, "", []].map((input) => briefInput(input))).toEqual(["", "", "", "", "[]"]);
    expect(briefInput("x".repeat(200))).toBe(`${"x".repeat(159)}…`);
    expect(briefInput({ a: "b".repeat(20) }, 10)).toBe('{"a":"bbb…');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(briefInput(loop)).toBe("[object Object]");
    expect(prettyToolName("scarlet__timeline_get")).toBe("scarlet.timeline_get");
    expect(prettyToolName("mcp__my_server__do_thing")).toBe("my_server.do_thing");
    expect(prettyToolName("Bash")).toBe("Bash");
    expect(isQuestionTool(undefined)).toBe(false);
    expect(isQuestionTool("scarlet.task_question")).toBe(true);
    expect(isQuestionTool("my_task_question")).toBe(false);
  });
});

describe("lines a CLI should never write", () => {
  it("reads JSON that is not an object as a plain log line, in every parser", () => {
    for (const line of ["null", "42", '"text"', "[1,2]"]) {
      expect(parseClaudeLine(line, newClaudeState())).toEqual([{ type: "log", text: line }]);
      expect(parseCodexLine(line, newCodexState())).toEqual([{ type: "log", text: line }]);
      expect(parseGeminiLine(line, newGeminiState())).toEqual([{ type: "log", text: line }]);
    }
  });
  it("skips a text block or an agent message whose text is missing or not a string", () => {
    const claude = newClaudeState();
    expect(feed([
      '{"type":"assistant","message":{"content":[{"type":"text"},null,{"type":"text","text":7},{"type":"text","text":"Kept."}]}}',
      '{"type":"assistant","message":{"content":{"type":"text","text":"not a list"}}}',
    ], claude, parseClaudeLine)).toEqual([{ type: "log", text: "Kept." }]);
    expect(claude.texts).toEqual(["Kept."]);
    const codex = newCodexState();
    expect(feed([
      '{"type":"item.completed","item":{"type":"agent_message","text":7}}',
      '{"type":"item.completed","item":{"type":"reasoning","text":{"summary":"x"}}}',
      '{"type":"item.completed","item":null}',
    ], codex, parseCodexLine)).toEqual([]);
    expect(codex.lastMessage).toBeUndefined();
  });
  it("survives a line handler that throws: the run goes on and the failure is in its stderr", async () => {
    const seen: string[] = [];
    const notes: string[] = [];
    const outcome = await spawnLines(process.execPath, ["-e", "console.log('first');console.log('second');process.stdout.write('last')"], {
      cwd: process.cwd(), env: process.env,
      onLine: (line) => {
        seen.push(line);
        if (line !== "second") throw new Error(`cannot read ${line}`);
      },
      onStderr: (chunk) => notes.push(chunk),
    }).done;
    expect(seen).toEqual(["first", "second", "last"]);
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain("line handler failed: cannot read first");
    expect(outcome.stderr).toContain("line handler failed: cannot read last");
    expect(notes.join("")).toBe(outcome.stderr);
  });
});

it("lets a CLI that keeps talking run past the stall window, and stops one that goes quiet", async () => {
  const run = (script: string) => spawnLines(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env, stallMs: 1000, onLine: () => {} }).done;
  // Talks every 200 ms for 2.4 s: longer than the window, but never quiet for it.
  const talking = await run("let n=0;const t=setInterval(()=>{console.log(n);if(++n===12)clearInterval(t)},200)");
  expect(talking).toMatchObject({ code: 0, timedOut: false, stalled: false });
  const started = Date.now();
  const quiet = await run("console.log('started');setTimeout(()=>{},30000)");
  expect(quiet).toMatchObject({ timedOut: true, stalled: true });
  expect(Date.now() - started).toBeLessThan(10_000);
}, 30_000);

it("cancels the whole CLI process tree", async () => {
  const controller = new AbortController();
  const script = [
    'const {spawn}=require("node:child_process")',
    'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]})',
    'child.on("spawn",()=>console.log(child.pid))',
    'setInterval(()=>{},1000)',
  ].join(";");
  let descendant: number | undefined;
  const run = spawnLines(process.execPath, ["-e", script], {
    cwd: process.cwd(), env: process.env, signal: controller.signal, timeoutMs: 5000,
    onLine: (line) => { descendant = Number(line); controller.abort(); },
  });
  let deadline: NodeJS.Timeout | undefined;
  try {
    // A surviving grandchild would hold the inherited stdout pipe open.
    const outcome = await Promise.race([
      run.done,
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("CLI descendants did not exit")), 4000); }),
    ]);
    expect(descendant).toBeGreaterThan(0);
    expect(outcome.aborted).toBe(true);
    expect(outcome.timedOut).toBe(false);
  } catch (error) {
    if (descendant) {
      try { process.kill(descendant, "SIGKILL"); } catch { /* already stopped */ }
    }
    run.kill();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}, 8000);

describe("resolveMcpCliPath", () => {
  it("finds packages/mcp/dist/cli.js through the ESM-only exports map", async () => {
    const { resolveMcpCliPath } = await import("./spawn.js");
    const { access } = await import("node:fs/promises");
    const p = resolveMcpCliPath();
    expect(p.replace(/\\/g, "/").endsWith("packages/mcp/dist/cli.js")).toBe(true);
    await expect(access(p)).resolves.toBeUndefined();
  });
});

describe("question calls", () => {
  const fresh = (): QuestionCallState => ({ questionPosted: false, shouldStop: false });

  it("holds the first call's words and posts them when that call succeeds", () => {
    const st = fresh();
    holdQuestion(st, "q1", "Keep the cold open?");
    expect(st).toMatchObject({ question: "Keep the cold open?", questionCall: "q1", questionPosted: false, shouldStop: false });
    expect(settleQuestion(st, "q1", false)).toBe("Keep the cold open?");
    expect(st).toMatchObject({ question: "Keep the cold open?", questionPosted: true, shouldStop: true });
  });

  it("holds nothing for a call with no words", () => {
    const st = fresh();
    holdQuestion(st, "q1", undefined);
    expect(st.question).toBeUndefined();
    expect(settleQuestion(st, "q1", false)).toBeUndefined();
    expect(st.questionPosted).toBe(false);
  });

  it("lets the asking call update its words, but not a later call take its place", () => {
    const st = fresh();
    holdQuestion(st, "q1", "First?");
    holdQuestion(st, "q1", "First, reworded?");
    holdQuestion(st, "q2", "Second?");
    expect(st).toMatchObject({ question: "First, reworded?", questionCall: "q1" });
    expect(settleQuestion(st, "q2", false)).toBeUndefined();
    expect(st.questionPosted).toBe(false);
  });

  it("clears a question its own call had refused, and keeps one a later refused call didn't ask", () => {
    const st = fresh();
    holdQuestion(st, "q1", "First?");
    expect(settleQuestion(st, "q2", true)).toBeUndefined();
    expect(st).toMatchObject({ question: "First?", questionCall: "q1" });
    expect(settleQuestion(st, "q1", true)).toBeUndefined();
    expect(st.question).toBeUndefined();
    expect(st.questionCall).toBeUndefined();
    expect(st).toMatchObject({ questionPosted: false, shouldStop: false });
  });
});
