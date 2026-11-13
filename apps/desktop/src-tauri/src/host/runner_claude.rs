//! Claude receives task text only on stdin and can call only Scarlet MCP tools.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use super::runner::{write_files, RunOptions, RunnerCommand};
use super::spawn::{resolve_cli, spawn_lines, SpawnLinesOptions};
use super::usage::{add_usage, claude_usage, AgentUsage};
use super::types::{brief, brief_input, is_question_tool, plan_event, pretty_tool_name, tail_summary, value_text, McpSpec, PlanStep, RunResult, RunnerEvent};

#[derive(Debug, Default, Clone)]
pub struct ClaudeState {
    pub texts: Vec<String>,
    pub result: Option<String>,
    pub result_is_error: bool,
    pub pending_question: Option<(String, String)>,
    pub question: Option<String>,
    pub question_posted: bool,
    /// Set when the tool_result for the question arrived: the runner should stop the process.
    pub should_stop: bool,
    pub mcp_connected: Option<bool>,
    pub session_id: Option<String>,
    /// The CLI opened a session. A resume that finds none fails before this.
    pub started: bool,
    pub model: Option<String>,
    /// Totals from the result line (whole session).
    pub usage: Option<AgentUsage>,
    /// Per API message, by message id, for a run stopped before its result line.
    pub message_usage: BTreeMap<String, AgentUsage>,
    /// The agent's own plan, when the CLI was launched with its to-do tools.
    pub plan: ClaudePlan,
}

/// Claude Code's own to-do tools, which Scarlet reads the agent's plan from and never calls. TaskCreate adds one step
/// and its result names the step's id; TaskUpdate changes one step by id. A Claude Code from before those has
/// TodoWrite, which takes the whole list. `--tools` takes the names a CLI knows and passes over the rest.
pub const CLAUDE_PLAN_TOOLS: &str = "TaskCreate,TaskUpdate,TodoWrite";

/// The plan as Claude Code's to-do tools have left it, and their calls still waiting for a result.
#[derive(Debug, Default, Clone)]
pub struct ClaudePlan {
    steps: Vec<(String, PlanStep)>,
    calls: BTreeMap<String, PlanCall>,
    /// The plan last passed on.
    sent: Option<Vec<PlanStep>>,
}

#[derive(Debug, Clone)]
enum PlanCall {
    Create(String),
    Update { id: String, status: Option<String>, subject: Option<String> },
}

fn step_state(status: &str) -> Option<&'static str> {
    match status {
        "pending" => Some("pending"),
        "in_progress" => Some("in_progress"),
        "completed" => Some("done"),
        _ => None,
    }
}

fn words(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Note a call to one of Claude Code's to-do tools. True when the call was one, so it isn't logged as a Scarlet tool.
fn plan_call(plan: &mut ClaudePlan, name: &str, id: &str, input: Option<&Value>) -> bool {
    let arg = |key: &str| words(input.and_then(|i| i.get(key)));
    match name {
        "TaskCreate" => {
            plan.calls.insert(id.to_string(), PlanCall::Create(arg("subject").or_else(|| arg("description")).unwrap_or_default()));
        }
        "TaskUpdate" => {
            let task = input.and_then(|i| i.get("taskId")).map(value_text).unwrap_or_default();
            plan.calls.insert(id.to_string(), PlanCall::Update { id: task, status: arg("status"), subject: arg("subject") });
        }
        "TodoWrite" => {
            // The whole list, each with its state. The result only confirms it.
            let todos = input.and_then(|i| i.get("todos")).and_then(Value::as_array).cloned().unwrap_or_default();
            plan.steps = todos.iter().enumerate().filter_map(|(i, todo)| {
                let state = todo.get("status").and_then(Value::as_str).and_then(step_state).unwrap_or("pending");
                Some((i.to_string(), PlanStep { text: words(todo.get("content"))?, state }))
            }).collect();
        }
        "TaskList" | "TaskGet" | "TodoRead" => {}
        _ => return false,
    }
    true
}

/// Apply a to-do call's result to the plan. True when the result was one.
fn plan_result(plan: &mut ClaudePlan, id: &str, failed: bool, content: Option<&Value>, result: Option<&Value>) -> bool {
    let Some(call) = plan.calls.remove(id) else { return false };
    if failed {
        return true;
    }
    match call {
        PlanCall::Create(text) => {
            // "Task #3 created successfully: Check the join"; the line's tool_use_result carries the same id.
            let said = flatten_tool_result(content);
            let made = said.split_once("Task #").and_then(|(_, rest)| rest.split_once(" created")).map(|(id, _)| id.to_string())
                .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace))
                .or_else(|| words(result.and_then(|r| r.get("task")).and_then(|t| t.get("id"))));
            if let (Some(made), false) = (made, text.is_empty()) {
                plan.steps.push((made, PlanStep { text, state: "pending" }));
            }
        }
        PlanCall::Update { id, status, subject } => {
            if status.as_deref() == Some("deleted") {
                plan.steps.retain(|(step, _)| step != &id);
            } else if let Some((_, step)) = plan.steps.iter_mut().find(|(step, _)| step == &id) {
                if let Some(state) = status.as_deref().and_then(step_state) {
                    step.state = state;
                }
                if let Some(subject) = subject {
                    step.text = subject;
                }
            }
        }
    }
    true
}

/// The plan as an event, once it has changed and no step is still being added: several are added in one message.
fn plan_change(plan: &mut ClaudePlan) -> Option<RunnerEvent> {
    if plan.calls.values().any(|call| matches!(call, PlanCall::Create(_))) {
        return None;
    }
    let steps: Vec<PlanStep> = plan.steps.iter().map(|(_, step)| step.clone()).collect();
    if plan.sent.as_ref().map_or(steps.is_empty(), |sent| sent == &steps) {
        return None;
    }
    plan.sent = Some(steps.clone());
    Some(plan_event(&steps))
}

fn flatten_tool_result(content: Option<&Value>) -> String {
    match content {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|c| match c {
                Value::Object(o) if o.contains_key("text") => value_text(&o["text"]),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn prune(mut m: Map<String, Value>) -> Value {
    m.retain(|_, v| !v.is_null());
    Value::Object(m)
}

/// Parse one stream-json line from `claude -p --output-format stream-json --verbose`.
pub fn parse_claude_line(line: &str, st: &mut ClaudeState) -> Vec<RunnerEvent> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(Value::Object(m)) => Value::Object(m),
        _ => return vec![RunnerEvent::new("log", line)],
    };
    let mut events = Vec::new();
    let kind = msg.get("type").and_then(Value::as_str);
    let init = kind == Some("system") && msg.get("subtype").and_then(Value::as_str) == Some("init");
    if init || kind == Some("assistant") || kind == Some("user") {
        st.started = true;
    }

    if kind == Some("system") {
        if init {
            if let Some(id) = msg.get("session_id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
                st.session_id = Some(id.to_string());
            }
            let servers: Vec<Value> = msg.get("mcp_servers").and_then(Value::as_array).cloned().unwrap_or_default();
            let scarlet = servers.iter().find(|s| s.get("name").and_then(Value::as_str) == Some("scarlet"));
            let status = scarlet.and_then(|s| s.get("status")).map(value_text);
            st.mcp_connected = scarlet.map(|_| status.as_deref() == Some("connected"));
            if let Some(m) = msg.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                st.model = Some(m.to_string());
            }
            let model = msg.get("model").filter(|m| !m.is_null()).map(|m| format!(" ({})", value_text(m))).unwrap_or_default();
            let mcp = match &status {
                Some(s) => format!("; Scarlet MCP {s}"),
                None => "; Scarlet MCP server not listed".to_string(),
            };
            let mut data = Map::new();
            data.insert("kind".into(), json!("init"));
            // The engine keeps it, so a run cut short by a quit can carry on in this session.
            if let Some(id) = &st.session_id {
                data.insert("sessionId".into(), json!(id));
            }
            data.insert("model".into(), msg.get("model").cloned().unwrap_or(Value::Null));
            data.insert("mcp".into(), Value::Array(servers.clone()));
            events.push(RunnerEvent::with("log", format!("Claude Code session started{model}{mcp}"), prune(data)));
            if let Some(s) = status {
                if s != "connected" {
                    events.push(RunnerEvent::new("error", format!("Scarlet MCP server status: {s}")));
                }
            }
        }
        return events;
    }

    if kind == Some("assistant") || kind == Some("user") {
        let is_assistant = kind == Some("assistant");
        let message = msg.get("message");
        let content = message.and_then(|m| m.get("content"));
        if let (true, Some(id)) = (is_assistant, message.and_then(|m| m.get("id")).and_then(Value::as_str)) {
            // One API message can arrive as several lines; the last carries its final count.
            let model = message.and_then(|m| m.get("model")).and_then(Value::as_str).or(st.model.as_deref());
            if let Some(usage) = claude_usage(message.and_then(|m| m.get("usage")), model) {
                st.message_usage.insert(id.to_string(), usage);
            }
        }
        match content {
            Some(Value::String(s)) => {
                if is_assistant && !s.trim().is_empty() {
                    st.texts.push(s.clone());
                    events.push(RunnerEvent::new("log", s.clone()));
                }
                return events;
            }
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
                    if btype == "text" && is_assistant {
                        let t = block.get("text").map(value_text).unwrap_or_default();
                        if !t.trim().is_empty() {
                            st.texts.push(t.clone());
                            events.push(RunnerEvent::new("log", t));
                        }
                    } else if btype == "tool_use" {
                        let id = block.get("id").map(value_text).unwrap_or_default();
                        let name = block.get("name").map(value_text).unwrap_or_default();
                        let input = block.get("input");
                        let pretty = pretty_tool_name(&name);
                        if plan_call(&mut st.plan, &name, &id, input) {
                            events.extend(plan_change(&mut st.plan));
                        } else if is_question_tool(Some(&name)) {
                            let text = input.and_then(|i| i.get("text")).map(value_text).unwrap_or_else(|| brief(input));
                            st.pending_question = Some((id.clone(), text.clone()));
                            st.question = Some(text.clone());
                            events.push(RunnerEvent::with("question", text, json!({ "tool": name, "toolUseId": id })));
                        } else {
                            let text = format!("{pretty} {}", brief(input)).trim().to_string();
                            let mut data = Map::new();
                            data.insert("tool".into(), Value::String(name));
                            data.insert("input".into(), input.cloned().unwrap_or(Value::Null));
                            data.insert("toolUseId".into(), Value::String(id));
                            events.push(RunnerEvent::with("tool", text, prune(data)));
                        }
                    } else if btype == "tool_result" {
                        let id = block.get("tool_use_id").map(value_text).unwrap_or_default();
                        let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                        if plan_result(&mut st.plan, &id, is_error, block.get("content"), msg.get("tool_use_result")) {
                            events.extend(plan_change(&mut st.plan));
                        } else if st.pending_question.as_ref().map(|(pid, _)| pid == &id).unwrap_or(false) {
                            st.question_posted = !is_error;
                            st.should_stop = true;
                        } else if is_error {
                            let flat = flatten_tool_result(block.get("content"));
                            events.push(RunnerEvent::with(
                                "error",
                                format!("Tool error: {}", brief_input(Some(&Value::String(flat)), 400)),
                                json!({ "toolUseId": id }),
                            ));
                        }
                    }
                }
                return events;
            }
            _ => return events,
        }
    }

    if kind == Some("result") {
        let subtype = msg.get("subtype").and_then(Value::as_str).map(str::to_string);
        let is_error = msg.get("is_error").and_then(Value::as_bool).unwrap_or(false) || subtype.as_deref().map(|s| s.starts_with("error")).unwrap_or(false);
        let result = msg.get("result").and_then(Value::as_str).unwrap_or("").to_string();
        st.result = Some(if !result.is_empty() {
            result
        } else if is_error {
            msg.get("errors").and_then(Value::as_array)
                .and_then(|errors| errors.iter().filter_map(Value::as_str).find(|error| !error.is_empty()))
                .or(subtype.as_deref()).unwrap_or("error").to_string()
        } else {
            String::new()
        });
        st.result_is_error = is_error;
        if let Some(usage) = claude_usage(msg.get("usage"), st.model.as_deref()) {
            st.usage = Some(usage);
        }
        let text = match st.result.as_deref() {
            Some(r) if !r.is_empty() => r.to_string(),
            _ => {
                if is_error {
                    "Claude Code ended with an error".into()
                } else {
                    "done".into()
                }
            }
        };
        let mut data = Map::new();
        data.insert("subtype".into(), msg.get("subtype").cloned().unwrap_or(Value::Null));
        data.insert("durationMs".into(), msg.get("duration_ms").cloned().unwrap_or(Value::Null));
        data.insert("turns".into(), msg.get("num_turns").cloned().unwrap_or(Value::Null));
        data.insert("costUsd".into(), msg.get("total_cost_usd").cloned().unwrap_or(Value::Null));
        data.insert("usage".into(), msg.get("usage").cloned().unwrap_or(Value::Null));
        events.push(RunnerEvent::with(if is_error { "error" } else { "result" }, text, prune(data)));
        return events;
    }

    // stream_event / partial messages / hooks: ignore quietly.
    events
}

/// The run's usage: the result totals, else the sum of the messages seen before the process stopped.
pub fn claude_run_usage(st: &ClaudeState, model: Option<&str>) -> Option<AgentUsage> {
    st.usage.clone()
        .or_else(|| st.message_usage.values().cloned().fold(None, |sum, u| add_usage(sum, Some(u))))
        .map(|u| u.or_model(model))
}

/// MCP config JSON for Claude Code (`--mcp-config`).
pub fn mcp_config_json(mcp: &McpSpec) -> String {
    let v = json!({ "mcpServers": { "scarlet": { "command": mcp.command, "args": mcp.args, "env": mcp.env } } });
    serde_json::to_string_pretty(&v).unwrap()
}

/// `--bare` keeps the user's hooks, plugins and CLAUDE.md out of Scarlet runs, but
/// it reads only ANTHROPIC_API_KEY or a cloud provider, never a subscription login.
pub fn can_run_bare(env: &std::collections::HashMap<String, String>) -> bool {
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].iter().any(|k| env.get(*k).is_some_and(|v| !v.is_empty()))
}

/// Build the exact command line (pure, for tests and for reporting).
#[allow(clippy::too_many_arguments)]
pub fn build_claude_command(model: Option<&str>, effort: Option<&str>, service_tier: Option<&str>, system_prompt: &str, instruction: &str, resume_session: Option<&str>, bare: bool, plan: bool, mcp: &McpSpec, bin: &str, tmp_dir: &Path) -> RunnerCommand {
    let mcp_config_path = tmp_dir.join("mcp.json");
    let system_path = tmp_dir.join("system.md");
    let mut args: Vec<String> = vec!["-p".into()];
    if bare {
        args.push("--bare".into());
    }
    args.extend(
        [
            "--output-format",
            "stream-json",
            "--verbose",
            "--mcp-config",
            &mcp_config_path.to_string_lossy(),
            "--strict-mcp-config",
            "--restricted",
            "--disable-slash-commands",
            "--tools",
            // No built-in tools, or only Claude Code's own to-do list when the engine asks for the agent's plan.
            if plan { CLAUDE_PLAN_TOOLS } else { "" },
            "--allowedTools",
            "mcp__scarlet__*",
            "--append-system-prompt-file",
            &system_path.to_string_lossy(),
            "--permission-mode",
            "dontAsk",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    // Sessions persist so a run paused on a question can continue with the answer.
    if let Some(id) = resume_session {
        args.extend(["--resume".into(), id.to_string()]);
    }
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(e) = effort {
        args.push("--effort".into());
        args.push(e.to_string());
    }
    let mut settings = json!({ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false } });
    // Native Windows can lack Claude's shell sandbox. This MCP-only runner exposes no shell tools.
    if !cfg!(windows) { settings["sandbox"]["failIfUnavailable"] = json!(true); }
    if let Some(tier) = service_tier { settings["fastMode"] = json!(tier == "fast"); }
    args.extend(["--settings".into(), settings.to_string()]);
    let mut files = BTreeMap::new();
    files.insert(mcp_config_path, mcp_config_json(mcp));
    files.insert(system_path, system_prompt.to_string());
    RunnerCommand { file: bin.to_string(), args, stdin: Some(instruction.to_string()), files }
}

pub async fn run_claude(opts: RunOptions) -> RunResult {
    let bin = match opts.bin.clone().map(Ok).unwrap_or_else(|| resolve_cli("claude", &opts.env)) {
        Ok(b) => b,
        Err(e) => return RunResult { ok: false, error: Some(e.to_string()), ..Default::default() },
    };
    let tmp_dir = opts.cwd.join(".scarlet");
    let cmd = build_claude_command(opts.model.as_deref(), opts.effort.as_deref(), opts.service_tier.as_deref(), &opts.system_prompt, &opts.instruction, opts.resume_session.as_deref(), can_run_bare(&opts.env), opts.plan, &opts.mcp, &bin, &tmp_dir);
    if let Err(e) = write_files(&cmd.files).await {
        return RunResult { ok: false, error: Some(e.to_string()), ..Default::default() };
    }

    let st = Arc::new(Mutex::new(ClaudeState::default()));
    let st2 = st.clone();
    let on_event = opts.on_event.clone();
    let resuming = opts.resume_session.is_some();
    let handler = Box::new(move |line: &str| -> bool {
        let mut s = st2.lock().unwrap();
        for ev in parse_claude_line(line, &mut s) {
            // A resume that finds no session falls back to a fresh run. Keep its error out of the task log.
            if resuming && !s.started && ev.kind == "error" {
                continue;
            }
            on_event(ev);
        }
        if s.should_stop {
            s.should_stop = false;
            return true; // the question is posted; stop the agent instead of letting it ramble.
        }
        false
    });
    let outcome = match spawn_lines(
        &cmd.file,
        &cmd.args,
        SpawnLinesOptions { cwd: opts.cwd.clone(), env: opts.env.clone(), stdin: cmd.stdin.clone(), cancel: opts.cancel.clone(), timeout: opts.timeout, stall: opts.stall, task: opts.task.clone() },
        handler,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return RunResult { ok: false, error: Some(e.to_string()), ..Default::default() },
    };

    let s = st.lock().unwrap().clone();
    let session = RunResult {
        session_id: s.session_id.clone().or_else(|| opts.resume_session.clone().filter(|_| s.started)),
        usage: claude_run_usage(&s, opts.model.as_deref()),
        ..Default::default()
    };
    if let Some(q) = s.question.clone() {
        return RunResult { ok: true, summary: tail_summary(&s.texts), question: Some(q), question_posted: s.question_posted, exit_code: outcome.code, ..session };
    }
    if outcome.timed_out {
        return RunResult { ok: false, summary: tail_summary(&s.texts), error: Some(if outcome.stalled { "stalled" } else { "timed out" }.into()), timed_out: true, stalled: outcome.stalled, exit_code: outcome.code, ..session };
    }
    if outcome.aborted {
        return RunResult { ok: false, summary: tail_summary(&s.texts), error: Some("cancelled".into()), aborted: true, exit_code: outcome.code, ..session };
    }
    let ok = !s.result_is_error && (outcome.code == Some(0) || s.result.is_some());
    let summary = match s.result.as_deref() {
        Some(r) if !r.is_empty() => r.to_string(),
        _ => tail_summary(&s.texts),
    };
    let error = if ok {
        None
    } else if s.result_is_error {
        s.result.clone()
    } else {
        Some(format!("claude exited with code {}{}", outcome.code.map(|c| c.to_string()).unwrap_or("null".into()), stderr_tail(&outcome.stderr)))
    };
    RunResult { ok, summary, error, exit_code: outcome.code, resume_failed: !ok && opts.resume_session.is_some() && !s.started, ..session }
}

pub fn stderr_tail(stderr: &str) -> String {
    let t = stderr.trim();
    if t.is_empty() {
        String::new()
    } else {
        format!(": {}", crate::util::js_slice_suffix(t, 800))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str], st: &mut ClaudeState) -> Vec<RunnerEvent> {
        lines.iter().flat_map(|l| parse_claude_line(l, st)).collect()
    }

    fn mcp() -> McpSpec {
        let mut env = BTreeMap::new();
        env.insert("SCARLET_SERVER".to_string(), "http://localhost:4000".to_string());
        env.insert("SCARLET_TOKEN".to_string(), "a\"b".to_string());
        McpSpec { command: "C:\\Program Files\\nodejs\\node.exe".into(), args: vec!["C:\\scarlet\\packages\\mcp\\dist\\cli.js".into()], env }
    }

    const FIXTURE: [&str; 7] = [
        r#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","tools":["Bash"],"mcp_servers":[{"name":"scarlet","status":"connected"}]}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me look at the project."},{"type":"tool_use","id":"toolu_1","name":"mcp__scarlet__project_get","input":{}}]},"session_id":"s1"}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"{...}"}]}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"mcp__scarlet__timeline_propose","input":{"ops":[{"op":"rippleDelete","start":1,"end":2}],"description":"Cut the pause"}}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","is_error":true,"content":"Invalid ops: ..."}]}}"#,
        "not json at all",
        r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":3,"result":"Proposed one change: chg_1.","total_cost_usd":0.05,"usage":{"input_tokens":4,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":12}}"#,
    ];

    #[test]
    fn maps_text_tools_errors_and_the_result() {
        let mut st = ClaudeState::default();
        let evs = feed(&FIXTURE, &mut st);
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "tool", "tool", "error", "log", "result"]);
        assert!(evs[0].text.contains("Scarlet MCP connected"));
        assert_eq!(evs[2].text, "scarlet.project_get");
        assert!(evs[3].text.contains("scarlet.timeline_propose {\"ops\""));
        assert!(evs[4].text.contains("Invalid ops"));
        assert_eq!(evs[6].text, "Proposed one change: chg_1.");
        assert_eq!(st.result.as_deref(), Some("Proposed one change: chg_1."));
        assert_eq!(st.mcp_connected, Some(true));
        assert_eq!(st.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn sees_a_resume_that_found_no_session_as_never_started() {
        // Recorded from claude 2.1.316 with --resume <unknown id>.
        let mut st = ClaudeState::default();
        feed(&[r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"3f1c2b9e-0000-4000-8000-000000000000","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"errors":["No conversation found with session ID: 3f1c2b9e-0000-4000-8000-000000000000"]}"#], &mut st);
        assert!(!st.started);
        assert_eq!(st.session_id, None);
        assert!(st.result.as_deref().unwrap().contains("No conversation found"));
    }

    #[test]
    fn turns_task_question_into_a_question_and_stops_after_its_tool_result() {
        let mut st = ClaudeState::default();
        let evs = feed(&[r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}"#], &mut st);
        assert_eq!(evs, vec![RunnerEvent::with("question", "Keep the cold open?", json!({"tool":"mcp__scarlet__task_question","toolUseId":"q1"}))]);
        assert!(!st.should_stop);
        feed(&[r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}"#], &mut st);
        assert_eq!(st.question.as_deref(), Some("Keep the cold open?"));
        assert!(st.question_posted);
        assert!(st.should_stop);
    }

    #[test]
    fn reports_error_results_and_a_failed_mcp_server() {
        let mut st = ClaudeState::default();
        let evs = feed(
            &[r#"{"type":"system","subtype":"init","mcp_servers":[{"name":"scarlet","status":"failed"}]}"#, r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#],
            &mut st,
        );
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "error", "error"]);
        assert!(st.result_is_error);
        assert_eq!(st.result.as_deref(), Some("error_max_turns"));
        let details = parse_claude_line(r#"{"type":"result","subtype":"error_during_execution","errors":["Sandbox unavailable"]}"#, &mut st);
        assert_eq!(details[0].text, "Sandbox unavailable");
    }

    #[test]
    fn builds_the_command_line_with_files_for_mcp_config_and_system_prompt() {
        let mcp = mcp();
        let cmd = build_claude_command(Some("opus"), None, None, "SYS", "Make the first cut", None, false, false, &mcp, "claude", Path::new("/tmp/t"));
        assert_eq!(cmd.args[0], "-p");
        assert_eq!(cmd.stdin.as_deref(), Some("Make the first cut"));
        assert!(cmd.args.windows(2).any(|a| a == ["--tools", ""]));
        assert!(cmd.args.windows(2).any(|a| a == ["--allowedTools", "mcp__scarlet__*"]));
        assert!(cmd.args.windows(2).any(|a| a == ["--permission-mode", "dontAsk"]));
        assert!(cmd.args.iter().any(|a| a == "--restricted"));
        let option = "--settings={}";
        let hostile = build_claude_command(None, None, None, "SYS", option, None, false, false, &mcp, "claude", Path::new("/tmp/t"));
        assert_eq!(hostile.stdin.as_deref(), Some(option));
        assert!(!hostile.args.iter().any(|a| a == option));
        let tuned = build_claude_command(Some("opus"), Some("max"), Some("fast"), "SYS", "x", None, false, false, &mcp, "claude", Path::new("/tmp/t"));
        assert_eq!(&tuned.args[tuned.args.len() - 6..tuned.args.len() - 1], &["--model", "opus", "--effort", "max", "--settings"]);
        let settings: Value = serde_json::from_str(tuned.args.last().unwrap()).unwrap();
        assert_eq!(settings["fastMode"], json!(true));
        assert_eq!(settings["sandbox"]["enabled"], json!(true));
        assert_eq!(settings["sandbox"]["allowUnsandboxedCommands"], json!(false));
        assert_eq!(settings["sandbox"].get("failIfUnavailable"), if cfg!(windows) { None } else { Some(&Value::Bool(true)) });
        let (_, mcp_json) = cmd.files.iter().find(|(k, _)| k.ends_with("mcp.json")).unwrap();
        let parsed: Value = serde_json::from_str(mcp_json).unwrap();
        assert_eq!(parsed["mcpServers"]["scarlet"], json!({"command": mcp.command, "args": mcp.args, "env": mcp.env}));
        let long = build_claude_command(None, None, None, "SYS", "line1\nline2", None, false, false, &mcp, "claude", Path::new("/tmp/t"));
        assert_eq!(long.args[1], "--output-format");
        assert_eq!(long.stdin.as_deref(), Some("line1\nline2"));
        assert!(!cmd.args.iter().any(|a| a == "--no-session-persistence"));
        // Asked for the agent's plan, the CLI gets its own to-do tools and still nothing else of its own.
        let planned = build_claude_command(None, None, None, "SYS", "line1\nline2", None, false, true, &mcp, "claude", Path::new("/tmp/t"));
        assert!(planned.args.windows(2).any(|a| a == ["--tools", "TaskCreate,TaskUpdate,TodoWrite"]));
        assert_eq!(planned.args.len(), long.args.len());
        let resumed = build_claude_command(None, None, None, "SYS", "The editor answered", Some("s1"), true, false, &mcp, "claude", Path::new("/tmp/t"));
        assert_eq!(&resumed.args[..2], &["-p", "--bare"]);
        assert!(resumed.args.join(" ").contains("--permission-mode dontAsk --resume s1 --settings"));
        assert_eq!(resumed.stdin.as_deref(), Some("The editor answered"));
        let key = std::collections::HashMap::from([("ANTHROPIC_API_KEY".to_string(), "sk-ant".to_string())]);
        assert!(can_run_bare(&key));
        assert!(!can_run_bare(&std::collections::HashMap::new()));
    }

    #[test]
    fn reads_the_agents_plan_from_claude_codes_to_do_tools() {
        // Recorded from claude 2.1.316 launched with --tools "TaskCreate,TaskUpdate": its own to-do list, one call a step.
        let use_ = |id: &str, name: &str, input: Value| json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":name,"input":input,"caller":{"type":"direct"}}]}}).to_string();
        let done = |id: &str, content: &str, result: Value| json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":id,"type":"tool_result","content":content}]},"tool_use_result":result}).to_string();
        let created = |id: &str, n: &str, subject: &str| done(id, &format!("Task #{n} created successfully: {subject}"), json!({"task":{"id":n,"subject":subject}}));
        let updated = |id: &str, n: &str, to: &str| done(id, &format!("Updated task #{n} status"), json!({"success":true,"taskId":n,"updatedFields":["status"],"statusChange":{"to":to}}));
        let steps = |ev: &RunnerEvent| ev.data.as_ref().unwrap()["steps"].as_array().unwrap().iter()
            .map(|s| format!("{} {}", s["state"].as_str().unwrap(), s["text"].as_str().unwrap())).collect::<Vec<_>>();
        let mut st = ClaudeState::default();
        // Three steps added in one message: the plan is passed on once every one of them has its id.
        let three = json!({"type":"assistant","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"c1","name":"TaskCreate","input":{"subject":"Read the scene","description":"Read the scene"}},
            {"type":"tool_use","id":"c2","name":"TaskCreate","input":{"subject":"Trim the pause","description":"Trim the pause"}},
            {"type":"tool_use","id":"c3","name":"TaskCreate","input":{"subject":"Check the join","description":"Check the join"}}]}}).to_string();
        let made = feed(&[&three, &created("c1", "1", "Read the scene"), &created("c2", "2", "Trim the pause"), &created("c3", "3", "Check the join")], &mut st);
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].kind, "plan");
        assert_eq!(made[0].text, "[ ] Read the scene\n[ ] Trim the pause\n[ ] Check the join");
        assert_eq!(steps(&made[0]), ["pending Read the scene", "pending Trim the pause", "pending Check the join"]);
        // A step changes when the tool says it did, not when the model asks.
        assert!(feed(&[&use_("u1", "TaskUpdate", json!({"taskId":"1","status":"in_progress"}))], &mut st).is_empty());
        let began = feed(&[&updated("u1", "1", "in_progress")], &mut st);
        assert_eq!(steps(&began[0]), ["in_progress Read the scene", "pending Trim the pause", "pending Check the join"]);
        let next = feed(&[
            &use_("u2", "TaskUpdate", json!({"taskId":"1","status":"completed"})), &updated("u2", "1", "completed"),
            &use_("u3", "TaskUpdate", json!({"taskId":"2","status":"in_progress","subject":"Trim the long pause"})), &updated("u3", "2", "in_progress"),
            &use_("u4", "TaskUpdate", json!({"taskId":"3","status":"deleted"})), &done("u4", "Updated task #3 deleted", json!({"success":true,"taskId":"3"})),
        ], &mut st);
        assert_eq!(next.last().unwrap().text, "[x] Read the scene\n[>] Trim the long pause");
        // A refused update, a look at the list and a step it doesn't know change nothing, and none is logged as a Scarlet tool.
        let refused = json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":"u5","type":"tool_result","is_error":true,"content":"No such task"}]}}).to_string();
        assert!(feed(&[
            &use_("u5", "TaskUpdate", json!({"taskId":"2","status":"completed"})), &refused,
            &use_("l1", "TaskList", json!({})), &done("l1", "#1 [completed] Read the scene", Value::Null),
            &use_("u6", "TaskUpdate", json!({"taskId":"9","status":"completed"})), &updated("u6", "9", "completed"),
        ], &mut st).is_empty());

        // The shape Claude Code documents for an older CLI's TodoWrite: the whole list in one call. Not a recording.
        let mut old = ClaudeState::default();
        let todos = json!({"todos":[{"content":"Read the scene","status":"completed"},{"content":"Trim the pause","status":"in_progress"},{"content":"Check the join","status":"pending"}]});
        let evs = feed(&[&use_("t1", "TodoWrite", todos.clone()), &done("t1", "Todos have been modified successfully", Value::Null), &use_("t2", "TodoWrite", todos)], &mut old);
        assert_eq!(evs, vec![RunnerEvent::with("plan", "[x] Read the scene\n[>] Trim the pause\n[ ] Check the join", json!({"steps": [
            {"text":"Read the scene","state":"done"},{"text":"Trim the pause","state":"in_progress"},{"text":"Check the join","state":"pending"}]}))]);
    }

    #[test]
    fn keeps_result_usage_or_sums_messages_when_stopped_early() {
        let mut st = ClaudeState::default();
        feed(&[
            r#"{"type":"system","subtype":"init","model":"claude-opus-5-5","mcp_servers":[{"name":"scarlet","status":"connected"}]}"#,
            r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":3,"output_tokens":1}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Done","total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":200,"cache_read_input_tokens":3000,"cache_creation_input_tokens":400}}"#,
        ], &mut st);
        let u = claude_run_usage(&st, None).unwrap();
        assert_eq!((u.model.as_deref(), u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens), (Some("claude-opus-5-5"), 10, 200, 3000, 400));

        let mut st = ClaudeState::default();
        feed(&[
            r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":100}}}"#,
            r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"t1","name":"mcp__scarlet__task_question","input":{"text":"Keep?"}}],"usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":100}}}"#,
            r#"{"type":"assistant","message":{"id":"msg_2","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":2,"output_tokens":4,"cache_creation_input_tokens":50}}}"#,
        ], &mut st);
        let u = claude_run_usage(&st, Some("opus")).unwrap();
        assert_eq!((u.model.as_deref(), u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens), (Some("opus"), 7, 13, 100, 50));
        assert_eq!(claude_run_usage(&ClaudeState::default(), Some("opus")), None);
    }

    #[cfg(unix)]
    mod runs {
        use super::super::*;
        use crate::host::runner::testing::{fake_cli, options};

        const INIT: &str = r#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","mcp_servers":[{"name":"scarlet","status":"connected"}]}"#;
        const TEXT: &str = r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Looking at the cut."}],"usage":{"input_tokens":3,"output_tokens":2}}}"#;

        #[tokio::test]
        async fn reports_a_finished_run_with_its_result_session_and_tokens() {
            let dir = tempfile::tempdir().unwrap();
            let result = r#"{"type":"result","subtype":"success","is_error":false,"result":"Cut two pauses.","usage":{"input_tokens":10,"output_tokens":20}}"#;
            let (opts, events) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, TEXT, result], "exit 0")));
            let run = run_claude(opts).await;
            assert!(run.ok, "{run:?}");
            assert_eq!((run.summary.as_str(), run.error.as_deref(), run.exit_code), ("Cut two pauses.", None, Some(0)));
            assert_eq!(run.session_id.as_deref(), Some("s1"));
            assert_eq!(run.usage.as_ref().map(|u| (u.input_tokens, u.output_tokens)), Some((10, 20)));
            assert!(!run.resume_failed && run.question.is_none());
            // Every line reached the host, in order.
            assert_eq!(events.lock().unwrap().iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "result"]);
            // The CLI's own files hold the engine token and the prompt.
            let mcp: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join(".scarlet/mcp.json")).unwrap()).unwrap();
            assert_eq!(mcp["mcpServers"]["scarlet"]["env"]["SCARLET_TOKEN"], json!("sct_test"));
            assert_eq!(std::fs::read_to_string(dir.path().join(".scarlet/system.md")).unwrap(), "SYSTEM");
        }

        #[tokio::test]
        async fn tells_a_cli_that_died_from_one_that_reported_an_error() {
            let dir = tempfile::tempdir().unwrap();
            // Died without a result: the exit code and what it wrote to stderr are the reason.
            let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, TEXT], "echo 'API Error: 529 overloaded' >&2; exit 3")));
            let run = run_claude(opts).await;
            assert_eq!((run.ok, run.exit_code), (false, Some(3)));
            assert_eq!(run.error.as_deref(), Some("claude exited with code 3: API Error: 529 overloaded"));
            // What it said before it died is kept as the summary, and its tokens are counted from the messages.
            assert_eq!(run.summary, "Looking at the cut.");
            assert_eq!(run.usage.as_ref().map(|u| (u.input_tokens, u.output_tokens)), Some((3, 2)));

            // An error result is the reason, whatever the exit code.
            let failed = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Ran out of turns."}"#;
            let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, failed], "exit 0")));
            let run = run_claude(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.resume_failed), (false, Some("Ran out of turns."), false));

            // A result with a failing exit code still counts: the CLI finished its work.
            let done = r#"{"type":"result","subtype":"success","is_error":false,"result":"Done."}"#;
            let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, done], "exit 1")));
            assert!(run_claude(opts).await.ok);
        }

        #[tokio::test]
        async fn a_resume_that_finds_no_session_asks_for_a_fresh_run_and_keeps_its_error_to_itself() {
            let dir = tempfile::tempdir().unwrap();
            let gone = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: gone"]}"#;
            let (mut opts, events) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[gone], "exit 1")));
            opts.resume_session = Some("gone".into());
            let run = run_claude(opts).await;
            assert!(!run.ok && run.resume_failed, "{run:?}");
            assert_eq!(run.session_id, None);
            assert!(run.error.as_deref().unwrap().contains("No conversation found"));
            assert!(events.lock().unwrap().is_empty(), "the failed resume showed in the task log");

            // A resumed session that did open, then failed, is an ordinary failure in that session.
            let failed = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Tool crashed"}"#;
            let (mut opts, events) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[TEXT, failed], "exit 1")));
            opts.resume_session = Some("s9".into());
            let run = run_claude(opts).await;
            assert_eq!((run.resume_failed, run.session_id.as_deref()), (false, Some("s9")));
            assert_eq!(events.lock().unwrap().iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "error"]);
        }

        #[tokio::test]
        async fn stops_the_cli_once_its_question_is_posted() {
            let dir = tempfile::tempdir().unwrap();
            let ask = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}"#;
            let posted = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}"#;
            // A real CLI would carry on talking. This one would for 30 seconds.
            let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, ask, posted], "sleep 30")));
            let started = std::time::Instant::now();
            let run = run_claude(opts).await;
            assert!(started.elapsed() < std::time::Duration::from_secs(15), "waited {:?} for a CLI that had asked", started.elapsed());
            assert!(run.ok && run.question_posted, "{run:?}");
            assert_eq!((run.question.as_deref(), run.session_id.as_deref()), (Some("Keep the cold open?"), Some("s1")));
        }

        #[tokio::test]
        async fn says_whether_the_host_or_the_editor_stopped_a_run() {
            let dir = tempfile::tempdir().unwrap();
            let waits = || fake_cli(dir.path(), &[INIT, TEXT], "sleep 30");
            // Silent past the stall window.
            let (mut opts, _) = options("claude", dir.path(), Some(waits()));
            // Long enough for the stand-in to start and speak on a busy machine.
            opts.stall = Some(std::time::Duration::from_secs(8));
            let run = run_claude(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.timed_out, run.stalled, run.aborted), (false, Some("stalled"), true, true, false));
            assert_eq!((run.summary.as_str(), run.session_id.as_deref()), ("Looking at the cut.", Some("s1")));
            // Past the optional cap on a whole run.
            let (mut opts, _) = options("claude", dir.path(), Some(waits()));
            opts.timeout = Some(std::time::Duration::from_secs(1));
            let run = run_claude(opts).await;
            assert_eq!((run.error.as_deref(), run.timed_out, run.stalled), (Some("timed out"), true, false));
            // Cancelled by the editor as soon as the CLI spoke.
            let (mut opts, _) = options("claude", dir.path(), Some(waits()));
            let cancel = opts.cancel.clone();
            opts.on_event = Arc::new(move |_| cancel.cancel());
            let run = run_claude(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.aborted, run.timed_out), (false, Some("cancelled"), true, false));
            assert_eq!(run.usage.as_ref().map(|u| u.output_tokens), Some(2), "a cancelled run's tokens still count");
        }

        #[tokio::test]
        async fn fails_before_starting_when_the_cli_or_its_folder_is_missing() {
            let dir = tempfile::tempdir().unwrap();
            let (opts, _) = options("claude", dir.path(), Some(dir.path().join("no-such-cli").to_string_lossy().into_owned()));
            let run = run_claude(opts).await;
            assert!(!run.ok && run.error.as_deref().unwrap().starts_with("spawn "), "{run:?}");
            // The task folder is a file: the CLI's own files can't be written.
            let blocked = dir.path().join("blocked");
            std::fs::write(&blocked, "").unwrap();
            let (opts, _) = options("claude", &blocked, Some(fake_cli(dir.path(), &[INIT], "exit 0")));
            let run = run_claude(opts).await;
            assert!(!run.ok && run.error.is_some() && run.exit_code.is_none(), "{run:?}");
        }
    }
}
