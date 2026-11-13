//! Gemini runs with only the Scarlet MCP server and no built-in tools.
//! Each run starts fresh: answers replay in the prompt. Google folded Gemini CLI
//! into Antigravity CLI and ended its consumer tiers on June 18, 2026.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::runner::{write_files, RunOptions, RunnerCommand};
use super::runner_claude::stderr_tail;
use super::spawn::{resolve_cli, spawn_lines, SpawnLinesOptions};
use super::usage::{gemini_usage, AgentUsage};
use super::types::{brief, brief_input, is_question_tool, tail_summary, value_text, McpSpec, RunResult, RunnerEvent};

#[derive(Debug, Default, Clone)]
pub struct GeminiState {
    pub texts: Vec<String>,
    /// Accumulated streamed assistant message (delta chunks).
    pub partial: String,
    pub pending_question_id: Option<String>,
    pub question: Option<String>,
    pub question_posted: bool,
    pub should_stop: bool,
    pub result: Option<(String, Option<String>)>,
    pub failed: Option<String>,
    pub model: Option<String>,
    pub usage: Option<AgentUsage>,
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| match p {
                Value::String(s) => s.clone(),
                Value::Object(o) if o.contains_key("text") => value_text(&o["text"]),
                _ => String::new(),
            })
            .collect(),
        Some(Value::Object(o)) if o.contains_key("text") => value_text(&o["text"]),
        _ => String::new(),
    }
}

fn first<'a>(msg: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| msg.get(*k)).filter(|v| !v.is_null())
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        _ => true,
    }
}

/// Parse one JSONL line from `gemini -p --output-format stream-json`.
pub fn parse_gemini_line(line: &str, st: &mut GeminiState) -> Vec<RunnerEvent> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v @ Value::Object(_)) => v,
        _ => return vec![RunnerEvent::new("log", line)],
    };
    let mut events = Vec::new();
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    let flush_partial = |st: &mut GeminiState, events: &mut Vec<RunnerEvent>| {
        if !st.partial.trim().is_empty() {
            st.texts.push(st.partial.clone());
            events.push(RunnerEvent::new("log", st.partial.clone()));
        }
        st.partial.clear();
    };

    match kind {
        "init" => {
            let model = msg.get("model").filter(|m| !m.is_null());
            if let Some(m) = model.and_then(Value::as_str).filter(|m| !m.is_empty()) {
                st.model = Some(m.to_string());
            }
            let text = format!("Gemini session started{}", model.map(|m| format!(" ({})", value_text(m))).unwrap_or_default());
            let mut data = serde_json::Map::new();
            data.insert("kind".into(), json!("init"));
            if let Some(m) = model {
                data.insert("model".into(), m.clone());
            }
            if let Some(s) = msg.get("session_id").filter(|v| !v.is_null()) {
                data.insert("sessionId".into(), s.clone());
            }
            events.push(RunnerEvent::with("log", text, Value::Object(data)));
        }
        "message" => {
            let role = msg.get("role").and_then(Value::as_str).unwrap_or("assistant");
            if role != "assistant" && role != "model" {
                return events;
            }
            let text = content_text(first(&msg, &["content", "text"]));
            if msg.get("delta") == Some(&Value::Bool(true)) {
                st.partial.push_str(&text);
            } else {
                st.partial.push_str(&text);
                flush_partial(st, &mut events);
            }
        }
        "tool_use" | "tool_call" => {
            flush_partial(st, &mut events);
            let name = first(&msg, &["tool_name", "name"])
                .map(value_text)
                .or_else(|| msg.get("tool").and_then(|t| t.get("name")).filter(|v| !v.is_null()).map(value_text))
                .unwrap_or_else(|| "tool".into());
            let id = first(&msg, &["tool_id", "id", "call_id"]).cloned();
            let input = first(&msg, &["parameters", "args", "input", "arguments"]);
            if is_question_tool(Some(&name)) {
                let text = input.and_then(|i| i.get("text")).filter(|t| !t.is_null()).map(value_text).unwrap_or_else(|| brief(input));
                st.question = Some(text.clone());
                st.pending_question_id = id.as_ref().map(value_text);
                let mut data = serde_json::Map::new();
                data.insert("tool".into(), Value::String(name));
                if let Some(i) = &id {
                    data.insert("toolId".into(), i.clone());
                }
                events.push(RunnerEvent::with("question", text, Value::Object(data)));
            } else {
                let text = format!("{name} {}", brief(input)).trim().to_string();
                let mut data = serde_json::Map::new();
                data.insert("tool".into(), Value::String(name));
                if let Some(i) = input {
                    data.insert("input".into(), i.clone());
                }
                if let Some(i) = &id {
                    data.insert("toolId".into(), i.clone());
                }
                events.push(RunnerEvent::with("tool", text, Value::Object(data)));
            }
        }
        "tool_result" => {
            let id = first(&msg, &["tool_id", "id", "call_id"]).map(value_text);
            let failed = msg.get("status").and_then(Value::as_str) == Some("error") || msg.get("is_error") == Some(&Value::Bool(true)) || truthy(msg.get("error"));
            let matches = st.pending_question_id.is_none() || st.pending_question_id == id;
            if st.question.is_some() && matches {
                st.question_posted = !failed;
                st.should_stop = true;
            } else if failed {
                let detail = if truthy(msg.get("error")) { msg.get("error") } else { msg.get("output") };
                let mut data = serde_json::Map::new();
                if let Some(i) = first(&msg, &["tool_id", "id", "call_id"]) {
                    data.insert("toolId".into(), i.clone());
                }
                events.push(RunnerEvent::with("error", format!("Tool error: {}", brief_input(detail, 400)), Value::Object(data)));
            }
        }
        "error" => {
            let text = msg.get("message").filter(|m| !m.is_null()).map(value_text).unwrap_or_else(|| brief_input(Some(&msg), 400));
            let severity = msg.get("severity").filter(|m| !m.is_null()).map(value_text).unwrap_or_else(|| "error".into());
            if severity == "warning" {
                events.push(RunnerEvent::new("log", format!("warning: {text}")));
            } else {
                st.failed = Some(text.clone());
                events.push(RunnerEvent::new("error", text));
            }
        }
        "result" => {
            flush_partial(st, &mut events);
            let status = msg
                .get("status")
                .filter(|s| !s.is_null())
                .map(value_text)
                .unwrap_or_else(|| if truthy(msg.get("error")) { "error".into() } else { "success".into() });
            let text = {
                let t = content_text(first(&msg, &["response", "text", "content"]));
                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            };
            st.result = Some((status.clone(), text.clone()));
            if let Some(usage) = gemini_usage(msg.get("stats"), st.model.as_deref()) {
                st.usage = Some(usage);
            }
            let mut data = serde_json::Map::new();
            if let Some(s) = msg.get("stats") {
                data.insert("stats".into(), s.clone());
            }
            if status == "success" {
                let t = text.or_else(|| st.texts.last().cloned()).unwrap_or_else(|| "done".into());
                events.push(RunnerEvent::with("result", t, Value::Object(data)));
            } else {
                let f = st.failed.clone().or(text).unwrap_or_else(|| format!("Gemini ended with status {status}"));
                st.failed = Some(f.clone());
                events.push(RunnerEvent::with("error", f, Value::Object(data)));
            }
        }
        _ => {}
    }
    events
}

/// `.gemini/settings.json` content.
pub fn gemini_settings_json(mcp: &McpSpec) -> String {
    let v = json!({
        "mcpServers": { "scarlet": { "command": mcp.command, "args": mcp.args, "env": mcp.env, "timeout": 600000, "trust": true } },
        "tools": { "core": [] },
        "hooksConfig": { "enabled": false }
    });
    serde_json::to_string_pretty(&v).unwrap()
}

pub fn build_gemini_command(model: Option<&str>, system_prompt: &str, instruction: &str, mcp: &McpSpec, cwd: &Path, bin: &str) -> RunnerCommand {
    let policy = cwd.join(".gemini").join("scarlet-policy.toml");
    let mut args = ["--sandbox", "--skip-trust", "--allowed-mcp-server-names", "scarlet", "--extensions", "none", "--admin-policy", &policy.to_string_lossy(), "--output-format", "stream-json"]
        .iter().map(|s| s.to_string()).collect::<Vec<_>>();
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    let mut files = BTreeMap::new();
    files.insert(policy, "[[rule]]\ntoolName = \"*\"\ndecision = \"deny\"\npriority = 900\n\n[[rule]]\ntoolName = \"*\"\nmcpName = \"scarlet\"\ndecision = \"allow\"\npriority = 999\n".to_string());
    files.insert(cwd.join(".gemini").join("settings.json"), gemini_settings_json(mcp));
    files.insert(cwd.join("GEMINI.md"), system_prompt.to_string());
    RunnerCommand { file: bin.to_string(), args, stdin: Some(instruction.to_string()), files }
}

pub async fn run_gemini(opts: RunOptions) -> RunResult {
    let bin = match opts.bin.clone().map(Ok).unwrap_or_else(|| resolve_cli("gemini", &opts.env)) {
        Ok(b) => b,
        Err(e) => return RunResult { ok: false, error: Some(e.to_string()), ..Default::default() },
    };
    let cmd = build_gemini_command(opts.model.as_deref(), &opts.system_prompt, &opts.instruction, &opts.mcp, &opts.cwd, &bin);
    if let Err(e) = write_files(&cmd.files).await {
        return RunResult { ok: false, error: Some(e.to_string()), ..Default::default() };
    }
    let st = Arc::new(Mutex::new(GeminiState::default()));
    let st2 = st.clone();
    let on_event = opts.on_event.clone();
    let handler = Box::new(move |line: &str| -> bool {
        let mut s = st2.lock().unwrap();
        for ev in parse_gemini_line(line, &mut s) {
            on_event(ev);
        }
        if s.should_stop {
            s.should_stop = false;
            return true;
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
    let usage = s.usage.clone().map(|u| u.or_model(opts.model.as_deref()));
    if let Some(q) = s.question.clone() {
        return RunResult { ok: true, summary: tail_summary(&s.texts), question: Some(q), question_posted: s.question_posted, exit_code: outcome.code, usage: usage.clone(), ..Default::default() };
    }
    if outcome.timed_out {
        return RunResult { ok: false, summary: tail_summary(&s.texts), error: Some(if outcome.stalled { "stalled" } else { "timed out" }.into()), timed_out: true, stalled: outcome.stalled, exit_code: outcome.code, usage: usage.clone(), ..Default::default() };
    }
    if outcome.aborted {
        return RunResult { ok: false, summary: tail_summary(&s.texts), error: Some("cancelled".into()), aborted: true, exit_code: outcome.code, usage: usage.clone(), ..Default::default() };
    }
    let success = s.result.as_ref().map(|(st, _)| st == "success").unwrap_or(false);
    let ok = s.failed.is_none() && (outcome.code == Some(0) || success);
    RunResult {
        ok,
        summary: s.result.as_ref().and_then(|(_, t)| t.clone()).unwrap_or_else(|| tail_summary(&s.texts)),
        error: if ok {
            None
        } else {
            Some(s.failed.clone().unwrap_or_else(|| format!("gemini exited with code {}{}", outcome.code.map(|c| c.to_string()).unwrap_or("null".into()), stderr_tail(&outcome.stderr))))
        },
        exit_code: outcome.code,
        usage,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str], st: &mut GeminiState) -> Vec<RunnerEvent> {
        lines.iter().flat_map(|l| parse_gemini_line(l, st)).collect()
    }

    fn mcp() -> McpSpec {
        let mut env = BTreeMap::new();
        env.insert("SCARLET_SERVER".to_string(), "http://localhost:4000".to_string());
        env.insert("SCARLET_TOKEN".to_string(), "a\"b".to_string());
        McpSpec { command: "C:\\Program Files\\nodejs\\node.exe".into(), args: vec!["C:\\scarlet\\packages\\mcp\\dist\\cli.js".into()], env }
    }

    const FIXTURE: [&str; 8] = [
        r#"{"type":"init","session_id":"g1","model":"gemini-2.5-pro"}"#,
        r#"{"type":"message","role":"assistant","content":"Reading the ","delta":true}"#,
        r#"{"type":"message","role":"assistant","content":"transcript.","delta":true}"#,
        r#"{"type":"tool_use","tool_name":"transcript_get","tool_id":"c1","parameters":{"mediaId":"m1"}}"#,
        r#"{"type":"tool_result","tool_id":"c1","status":"success","output":"..."}"#,
        r#"{"type":"tool_use","tool_name":"task_question","tool_id":"c2","parameters":{"text":"9:16 or 16:9?"}}"#,
        r#"{"type":"tool_result","tool_id":"c2","status":"success","output":"Question posted"}"#,
        r#"{"type":"result","status":"success","stats":{"total_tokens":100}}"#,
    ];

    #[test]
    fn accumulates_deltas_maps_tools_and_detects_the_question() {
        let mut st = GeminiState::default();
        let evs = feed(&FIXTURE, &mut st);
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "tool", "question", "result"]);
        assert_eq!(evs[1].text, "Reading the transcript.");
        assert_eq!(evs[2].text, r#"transcript_get {"mediaId":"m1"}"#);
        assert_eq!(st.question.as_deref(), Some("9:16 or 16:9?"));
        assert!(st.question_posted);
        assert_eq!(st.result.as_ref().map(|r| r.0.as_str()), Some("success"));
    }

    #[test]
    fn handles_errors_and_non_success_results() {
        let mut st = GeminiState::default();
        let evs = feed(
            &[r#"{"type":"error","severity":"warning","message":"slow"}"#, r#"{"type":"error","message":"quota exceeded"}"#, r#"{"type":"result","status":"error"}"#],
            &mut st,
        );
        assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "error", "error"]);
        assert_eq!(st.failed.as_deref(), Some("quota exceeded"));
    }

    #[test]
    fn builds_settings_json_gemini_md_and_the_command() {
        let mcp = mcp();
        let cmd = build_gemini_command(Some("gemini-2.5-flash"), "SYS", "Add captions", &mcp, Path::new("/w"), "gemini");
        assert_eq!(cmd.stdin.as_deref(), Some("Add captions"));
        assert!(cmd.args.iter().any(|s| s == "--sandbox"));
        assert!(cmd.args.windows(2).any(|a| a == ["--allowed-mcp-server-names", "scarlet"]));
        assert!(cmd.args.iter().any(|s| s == "--admin-policy"));
        let (_, policy) = cmd.files.iter().find(|(k, _)| k.ends_with("scarlet-policy.toml")).unwrap();
        assert!(policy.contains("toolName = \"*\"\ndecision = \"deny\""));
        assert!(policy.contains("toolName = \"*\"\nmcpName = \"scarlet\"\ndecision = \"allow\""));
        let (_, settings) = cmd.files.iter().find(|(k, _)| k.ends_with("settings.json")).unwrap();
        let parsed: Value = serde_json::from_str(settings).unwrap();
        assert_eq!(parsed["mcpServers"]["scarlet"]["command"], json!(mcp.command));
        assert_eq!(parsed["mcpServers"]["scarlet"]["args"], json!(mcp.args));
        assert_eq!(parsed["mcpServers"]["scarlet"]["env"], json!(mcp.env));
        assert_eq!(parsed["mcpServers"]["scarlet"]["trust"], json!(true));
        assert_eq!(parsed["tools"]["core"], json!([]));
        let (_, md) = cmd.files.iter().find(|(k, _)| k.ends_with("GEMINI.md")).unwrap();
        assert_eq!(md, "SYS");
    }

    #[test]
    fn reads_usage_from_result_stats_with_the_session_model() {
        let mut st = GeminiState::default();
        feed(&[
            r#"{"type":"init","session_id":"g1","model":"gemini-3-pro"}"#,
            r#"{"type":"result","status":"success","stats":{"total_tokens":1500,"input_tokens":1200,"output_tokens":300,"cached":1000,"input":200}}"#,
        ], &mut st);
        let u = st.usage.unwrap();
        assert_eq!((u.model.as_deref(), u.input_tokens, u.output_tokens, u.cache_read_tokens), (Some("gemini-3-pro"), 200, 300, 1000));
    }

    #[cfg(unix)]
    mod runs {
        use super::super::*;
        use crate::host::runner::testing::{fake_cli, options};

        const INIT: &str = r#"{"type":"init","session_id":"g1","model":"gemini-2.5-pro"}"#;
        const MESSAGE: &str = r#"{"type":"message","role":"assistant","content":"Reading the transcript."}"#;

        #[tokio::test]
        async fn reports_a_finished_run_with_its_answer_and_tokens() {
            let dir = tempfile::tempdir().unwrap();
            let result = r#"{"type":"result","status":"success","response":"Trimmed the intro.","stats":{"input_tokens":7,"output_tokens":3}}"#;
            let (opts, events) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT, MESSAGE, result], "exit 0")));
            let run = run_gemini(opts).await;
            assert!(run.ok, "{run:?}");
            assert_eq!((run.summary.as_str(), run.error.as_deref(), run.exit_code), ("Trimmed the intro.", None, Some(0)));
            assert_eq!(run.usage.as_ref().and_then(|u| u.model.as_deref()), Some("gemini-2.5-pro"));
            assert_eq!(events.lock().unwrap().iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "result"]);
            // Its settings allow the Scarlet MCP server and nothing else.
            let settings: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join(".gemini/settings.json")).unwrap()).unwrap();
            assert_eq!(settings["mcpServers"]["scarlet"]["command"], json!("scarlet-engine"));
            assert_eq!(std::fs::read_to_string(dir.path().join("GEMINI.md")).unwrap(), "SYSTEM");
            assert!(std::fs::read_to_string(dir.path().join(".gemini/scarlet-policy.toml")).unwrap().contains("decision = \"deny\""));

            // No result line, a clean exit: what it last said is the summary.
            let (opts, _) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT, MESSAGE], "exit 0")));
            let run = run_gemini(opts).await;
            assert_eq!((run.ok, run.summary.as_str()), (true, "Reading the transcript."));
        }

        #[tokio::test]
        async fn gives_the_reason_a_run_failed() {
            let dir = tempfile::tempdir().unwrap();
            let quota = r#"{"type":"error","message":"quota exceeded"}"#;
            let (opts, _) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT, quota], "exit 0")));
            let run = run_gemini(opts).await;
            assert_eq!((run.ok, run.error.as_deref()), (false, Some("quota exceeded")));
            // A result that isn't a success names its status.
            let ended = r#"{"type":"result","status":"max_turns"}"#;
            let (opts, _) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT, ended], "exit 0")));
            assert_eq!(run_gemini(opts).await.error.as_deref(), Some("Gemini ended with status max_turns"));
            // Died with nothing: the exit code and stderr.
            let (opts, _) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT], "echo 'no credentials' >&2; exit 41")));
            let run = run_gemini(opts).await;
            assert_eq!((run.error.as_deref(), run.exit_code), (Some("gemini exited with code 41: no credentials"), Some(41)));
        }

        #[tokio::test]
        async fn pauses_on_a_question_and_reports_a_stall_or_a_cancel() {
            let dir = tempfile::tempdir().unwrap();
            let ask = r#"{"type":"tool_use","tool_name":"task_question","tool_id":"c2","parameters":{"text":"9:16 or 16:9?"}}"#;
            let posted = r#"{"type":"tool_result","tool_id":"c2","status":"success","output":"Question posted"}"#;
            let (opts, _) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT, ask, posted], "sleep 30")));
            let run = run_gemini(opts).await;
            assert!(run.ok && run.question_posted, "{run:?}");
            assert_eq!(run.question.as_deref(), Some("9:16 or 16:9?"));

            let (mut opts, _) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT, MESSAGE], "sleep 30")));
            opts.timeout = Some(std::time::Duration::from_secs(1));
            let run = run_gemini(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.timed_out, run.stalled), (false, Some("timed out"), true, false));

            let (mut opts, _) = options("gemini", dir.path(), Some(fake_cli(dir.path(), &[INIT, MESSAGE], "sleep 30")));
            let cancel = opts.cancel.clone();
            opts.on_event = Arc::new(move |_| cancel.cancel());
            let run = run_gemini(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.aborted), (false, Some("cancelled"), true));
        }
    }
}
