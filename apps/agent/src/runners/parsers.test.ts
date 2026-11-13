import { describe, expect, it } from "vitest";
import { buildClaudeCommand, claudeCanRunBare, claudeRunUsage, newClaudeState, parseClaudeLine } from "./claude.js";
import { buildCodexCommand, newCodexState, parseCodexLine, tomlInlineTable, tomlString } from "./codex.js";
import { buildGeminiCommand, newGeminiState, parseGeminiLine } from "./gemini.js";
import { quoteForCmd, spawnLines, spawnSpec } from "./spawn.js";
import { briefInput, isQuestionTool, prettyToolName, type RunnerEvent } from "./types.js";

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
    expect(st.mcpConnected).toBe(true);
    expect(st.sessionId).toBe("s1");
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
    expect(evs).toEqual([{ type: "question", text: "Keep the cold open?", data: { tool: "mcp__scarlet__task_question", toolUseId: "q1" } }]);
    expect(st.shouldStop).toBe(false);
    feed(['{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}'], st, parseClaudeLine);
    expect(st.question).toBe("Keep the cold open?");
    expect(st.questionPosted).toBe(true);
    expect(st.shouldStop).toBe(true);
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
  it("builds the command line with files for mcp config and system prompt", () => {
    const cmd = buildClaudeCommand({ instruction: "Make the first cut", systemPrompt: "SYS", mcp, model: "opus" }, "claude", "/tmp/t");
    expect(cmd.args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--mcp-config", expect.stringMatching(/mcp\.json$/), "--strict-mcp-config",
      "--restricted", "--disable-slash-commands", "--tools", "", "--allowedTools", "mcp__scarlet__*", "--append-system-prompt-file", expect.stringMatching(/system\.md$/), "--permission-mode", "dontAsk",
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
    expect(planned.args[planned.args.indexOf("--tools") + 1]).toBe("TaskCreate,TaskUpdate,TodoWrite");
    expect(planned.args.filter((a, i) => i !== planned.args.indexOf("--tools") + 1)).toEqual(long.args.filter((a, i) => i !== long.args.indexOf("--tools") + 1));
    expect(long.stdin).toBe("line1\nline2");
    const tuned = buildClaudeCommand({ instruction: "x", systemPrompt: "SYS", mcp, model: "opus", effort: "max", fast: true }, "claude", "/tmp/t");
    expect(tuned.args.slice(-6, -1)).toEqual(["--model", "opus", "--effort", "max", "--settings"]);
    expect(JSON.parse(tuned.args.at(-1)!)).toStrictEqual({ fastMode: true, sandbox: {
      enabled: true, allowUnsandboxedCommands: false, ...(process.platform === "win32" ? {} : { failIfUnavailable: true }),
    } });
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

describe("gemini stream-json parser", () => {
  const fixture = [
    '{"type":"init","session_id":"g1","model":"gemini-2.5-pro"}',
    '{"type":"message","role":"assistant","content":"Reading the ","delta":true}',
    '{"type":"message","role":"assistant","content":"transcript.","delta":true}',
    '{"type":"tool_use","tool_name":"transcript_get","tool_id":"c1","parameters":{"mediaId":"m1"}}',
    '{"type":"tool_result","tool_id":"c1","status":"success","output":"..."}',
    '{"type":"tool_use","tool_name":"task_question","tool_id":"c2","parameters":{"text":"9:16 or 16:9?"}}',
    '{"type":"tool_result","tool_id":"c2","status":"success","output":"Question posted"}',
    '{"type":"result","status":"success","stats":{"total_tokens":100}}',
  ];
  it("accumulates deltas, maps tools and detects the question", () => {
    const st = newGeminiState();
    const evs = feed(fixture, st, parseGeminiLine);
    expect(evs.map((e) => e.type)).toEqual(["log", "log", "tool", "question", "result"]);
    expect(evs[1]!.text).toBe("Reading the transcript.");
    expect(evs[2]!.text).toBe('transcript_get {"mediaId":"m1"}');
    expect(st.question).toBe("9:16 or 16:9?");
    expect(st.questionPosted).toBe(true);
    expect(st.result?.status).toBe("success");
  });
  it("handles errors and non-success results", () => {
    const st = newGeminiState();
    const evs = feed(
      ['{"type":"error","severity":"warning","message":"slow"}', '{"type":"error","message":"quota exceeded"}', '{"type":"result","status":"error"}'],
      st,
      parseGeminiLine,
    );
    expect(evs.map((e) => e.type)).toEqual(["log", "error", "error"]);
    expect(st.failed).toBe("quota exceeded");
  });
  it("builds settings.json + GEMINI.md and the command", () => {
    const cmd = buildGeminiCommand({ instruction: "Add captions", systemPrompt: "SYS", mcp, cwd: "/w", model: "gemini-2.5-flash" }, "gemini");
    expect(cmd.stdin).toBe("Add captions");
    expect(cmd.args).toEqual(["--sandbox", "--skip-trust", "--allowed-mcp-server-names", "scarlet", "--extensions", "none", "--admin-policy", expect.stringMatching(/scarlet-policy\.toml$/), "--output-format", "stream-json", "--model", "gemini-2.5-flash"]);
    const settings = JSON.parse(cmd.files[Object.keys(cmd.files).find((k) => k.endsWith("settings.json"))!]!);
    expect(settings.tools.core).toEqual([]);
    const policy = Object.entries(cmd.files).find(([p]) => p.endsWith("scarlet-policy.toml"))![1];
    expect(policy).toContain('toolName = "*"\ndecision = "deny"');
    expect(policy).toContain('toolName = "*"\nmcpName = "scarlet"\ndecision = "allow"');
    expect(settings.mcpServers.scarlet).toMatchObject({ command: mcp.command, args: mcp.args, env: mcp.env });
    expect(cmd.files[Object.keys(cmd.files).find((k) => k.endsWith("GEMINI.md"))!]).toBe("SYS");
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
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","is_error":true,"content":"no engine"}]}}',
    ], st, parseClaudeLine);
    expect(evs).toEqual([
      { type: "log", text: "Starting on the intro." },
      { type: "error", text: "Tool error: clip not found\n\ntry media_list", data: { toolUseId: "t1" } },
      { type: "error", text: 'Tool error: {"code":"E_RANGE"}', data: { toolUseId: "t2" } },
      { type: "error", text: "Tool error: ", data: { toolUseId: "t3" } },
      { type: "question", text: "", data: { tool: "scarlet__task_question", toolUseId: "q1" } },
    ]);
    expect(st.texts).toEqual(["Starting on the intro."]);
    // The engine never took the question, but the CLI is still stopped: the host posts it itself.
    expect(st).toMatchObject({ questionPosted: false, shouldStop: true, started: true });
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

  it("gemini: whole messages, text held back until the next step, and a result that only says it failed", () => {
    const st = newGeminiState();
    const evs = feed([
      "Loaded cached credentials.",
      '{"type":"message","content":"Looking at the timeline."}',
      '{"type":"message","role":"user","content":"Make the first cut"}',
      '{"type":"message","role":"model","text":"Cutting ","delta":true}',
      '{"type":"message","role":"model","content":{"text":"the pause."},"delta":true}',
      '{"type":"tool_call","tool":{"name":"timeline_propose"},"id":7,"input":{}}',
      '{"type":"tool_result","id":7,"status":"error","output":"Invalid ops"}',
      '{"type":"message","role":"assistant","content":42,"delta":true}',
      '{"type":"message","role":"assistant","content":"Giving up.","delta":true}',
      '{"type":"telemetry"}',
      '{"type":"result","error":{"message":"quota"},"content":"Stopped early."}',
    ], st, parseGeminiLine);
    expect(evs.map((e) => [e.type, e.text])).toEqual([
      ["log", "Loaded cached credentials."],
      ["log", "Looking at the timeline."],
      ["log", "Cutting the pause."],
      ["tool", "timeline_propose"],
      ["error", "Tool error: Invalid ops"],
      ["log", "Giving up."],
      ["error", "Stopped early."],
    ]);
    expect(st.texts).toEqual(["Looking at the timeline.", "Cutting the pause.", "Giving up."]);
    expect(st).toMatchObject({ failed: "Stopped early.", result: { status: "error", text: "Stopped early." }, partial: "" });
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
