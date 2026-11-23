//! Gemini via Antigravity CLI (`agy acp`), speaking Agent Client Protocol (JSON-RPC 2.0) over stdio.
//! Runs with `--sandbox` and an explicit `session/request_permission` handler: a request's agent may use agy's own
//! shell, file and web tools inside its task folder as well as Scarlet's, and a side check only Scarlet's. Supports model selection,
//! thinking level (`thought_level`) and token usage reporting. The runner can open a session again
//! (`session/resume`), but the engine never asks it to: Gemini isn't among the agents it resumes, so an
//! answer or an interruption starts a fresh run with the earlier questions and answers, or the recap.

mod acp_parse;
mod transcript;
#[cfg(test)]
mod tests;

pub use acp_parse::{
    acp_mcp_server, build_gemini_command, is_scarlet_mcp_permission, parse_gemini_acp_update, permission_outcome,
    system_prompt_meta, workspace_permission, GeminiState,
};

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::detect::has_api_key;
use super::runner::{cut_short, exit_error, parse_json_object, report_usage, EventSink, RunOptions, UsageSink};
use super::spawn::spawn_interactive;
use super::types::{brief_input, non_empty_str, tail_summary, RunResult, RunnerEvent};
use super::usage::{add_usage, gemini_usage, AgentUsage};
use acp_parse::{extract_tool_name, flush_streams};
use transcript::TranscriptUsageTailer;

const STOP_GRACE: Duration = Duration::from_secs(2);
/// How many times a run carries on after agy ended Gemini's turn on a tool Scarlet refused.
const MAX_CARRY_ONS: u32 = 4;

/// The name of the tool a permission request is for.
fn permission_tool(params: &Value) -> String {
    params
        .get("toolCall")
        .map(extract_tool_name)
        .unwrap_or_else(|| "tool".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Initialize,
    Authenticate,
    SessionOpen,
    SetModel,
    SetEffort,
    Prompt,
    Done,
}

impl Step {
    fn label(self) -> &'static str {
        match self {
            Step::Initialize => "initialize",
            Step::Authenticate => "authenticate",
            Step::SessionOpen => "session_open",
            Step::SetModel => "set_model",
            Step::SetEffort => "set_effort",
            Step::Prompt => "prompt",
            Step::Done => "done",
        }
    }
}

fn parse_config_options(result: &Value) -> Vec<Value> {
    result
        .get("configOptions")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter(|v| v.is_object()).cloned().collect())
        .unwrap_or_default()
}

/// Default thinking effort Scarlet uses for Gemini runs when the user hasn't picked one.
/// agy defaults `thought_level` to "high" (spending ~20-40 s thinking per tool-loop turn);
/// "medium" matches Codex's default when offered by the session.
const DEFAULT_GEMINI_EFFORT: &str = "medium";

/// Interval for polling `transcript.jsonl` while a prompt turn is active, catching
/// `PLANNER_RESPONSE` writes that flush right after `tool_call` before a slow tool runs.
const TRANSCRIPT_POLL_INTERVAL: Duration = Duration::from_secs(2);

fn config_option_id(opt: &Value) -> Option<&str> {
    non_empty_str(opt.get("id")).or_else(|| non_empty_str(opt.get("configId")))
}

fn config_option_has_value(opt: &Value, value: &str) -> bool {
    let Some(items) = opt.get("options").and_then(Value::as_array) else {
        return false;
    };
    items.iter().any(|item| {
        item.get("value").and_then(Value::as_str) == Some(value)
            || config_option_has_value(item, value)
    })
}

fn find_config_option<'a>(configs: &'a [Value], category: &str, ids: &[&str]) -> Option<&'a Value> {
    configs.iter().find(|c| {
        c.get("category").and_then(Value::as_str) == Some(category)
            || config_option_id(c).is_some_and(|id| ids.contains(&id))
    })
}

struct AcpSession {
    input: Option<mpsc::UnboundedSender<String>>,
    request_id: u64,
    step: Step,
    tried_api_key_auth: bool,
    resume_failed: bool,
    cancel_sent: bool,
    has_api_key: bool,
    cwd: String,
    env: HashMap<String, String>,
    mcp_server: Value,
    model_override: Option<String>,
    effort_override: Option<String>,
    resume_session: Option<String>,
    instruction: String,
    system_prompt: String,
    /// The engine's words for the turn after a refusal, `{tool}` standing for what was refused.
    refused_tool: Option<String>,
    /// Tools Scarlet refused during the turn under way. agy ends Gemini's turn on a refusal.
    refused: Vec<String>,
    /// A request's folders, inside which its agent may use agy's own tools. None for a side check: Scarlet's tools only.
    roots: Option<Vec<String>>,
    carry_ons: u32,
    config_options: Vec<Value>,
    has_legacy_models: bool,
    st: GeminiState,
    transcript: TranscriptUsageTailer,
    sent_usage: Option<AgentUsage>,
    on_event: EventSink,
    on_usage: Option<UsageSink>,
}

impl AcpSession {
    fn send(&self, mut message: Value) -> bool {
        if let Some(obj) = message.as_object_mut() {
            obj.insert("jsonrpc".into(), json!("2.0"));
        }
        let Some(ref tx) = self.input else {
            return false;
        };
        tx.send(format!("{message}\n")).is_ok()
    }

    fn send_request(&mut self, method: &str, params: Value) -> bool {
        self.request_id += 1;
        let id = self.request_id;
        self.send(json!({ "id": id, "method": method, "params": params }))
    }

    fn cancel_turn(&mut self) -> bool {
        if self.cancel_sent || self.step == Step::Done {
            return false;
        }
        let Some(ref session_id) = self.st.session_id else {
            return false;
        };
        self.cancel_sent = self.send(json!({
            "method": "session/cancel",
            "params": { "sessionId": session_id }
        }));
        self.cancel_sent
    }

    fn stop_session(&mut self) {
        self.step = Step::Done;
        self.input.take();
    }

    fn fail_session(&mut self, message: impl Into<String>) {
        let msg = message.into();
        self.st.failed = Some(msg.clone());
        (self.on_event)(RunnerEvent::new("error", msg));
        self.stop_session();
    }

    fn emit_usage(&mut self) {
        let now = self
            .st
            .usage
            .clone()
            .map(|u| u.or_model(self.model_override.as_deref()));
        report_usage(&self.on_usage, &mut self.sent_usage, now);
    }

    fn poll_transcript_usage(&mut self) {
        let model = self.st.model.as_deref().or(self.model_override.as_deref());
        if let Some(live) = self.transcript.poll(model) {
            self.st.turn_usage = Some(live);
            self.st.sync_usage();
        }
    }

    fn send_open_session(&mut self) {
        self.step = Step::SessionOpen;
        let mcp_servers = vec![self.mcp_server.clone()];
        let meta = system_prompt_meta(&self.system_prompt);
        if let Some(ref resume_id) = self.resume_session {
            self.send_request(
                "session/resume",
                json!({ "sessionId": resume_id, "cwd": self.cwd, "mcpServers": mcp_servers, "_meta": meta }),
            );
        } else {
            self.send_request(
                "session/new",
                json!({ "cwd": self.cwd, "mcpServers": mcp_servers, "_meta": meta }),
            );
        }
    }

    fn send_prompt(&mut self) {
        let text = self.instruction.clone();
        self.send_turn(text);
    }

    fn send_turn(&mut self, text: String) {
        let Some(session_id) = self.st.session_id.clone() else {
            self.fail_session("Gemini session returned no sessionId");
            return;
        };
        self.step = Step::Prompt;
        self.refused.clear();
        self.send_request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }],
            }),
        );
    }

    /// agy ends Gemini's turn as soon as Scarlet refuses one of its tools, before the model hears why, and reports the
    /// turn ended as if it were finished. Tell the model what was refused and let it carry on.
    fn carry_on_after_refusal(&mut self) -> bool {
        if self.refused.is_empty() {
            return false;
        }
        let mut names: Vec<String> = Vec::new();
        for name in self.refused.drain(..) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let names = names.join(", ");
        if self.carry_ons >= MAX_CARRY_ONS {
            self.fail_session(format!(
                "Gemini stopped after Scarlet refused {names}, a tool that doesn't run in Scarlet, {} times.",
                self.carry_ons + 1
            ));
            return true;
        }
        // The words are the engine's (`refusedTool`): a host writes nothing the model reads.
        let Some(text) = self.refused_tool.as_deref().filter(|words| !words.trim().is_empty()).map(|words| words.replace("{tool}", &names)) else {
            self.fail_session(format!(
                "Gemini stopped after Scarlet refused {names}, and this engine gave no words to carry on with. Update Scarlet's engine."
            ));
            return true;
        };
        self.carry_ons += 1;
        (self.on_event)(RunnerEvent::with(
            "log",
            format!("Scarlet refused {names}: only Scarlet's tools run here. Gemini carries on."),
            json!({ "kind": "tool_refused", "harnessTool": names }),
        ));
        self.send_turn(text);
        true
    }

    fn maybe_set_effort_then_prompt(&mut self) {
        if let Some(thought_opt) = find_config_option(
            &self.config_options,
            "thought_level",
            &["thought_level", "reasoning_effort", "thinking_level"],
        ) {
            let target_effort = self.effort_override.clone().or_else(|| {
                let current = thought_opt.get("currentValue").and_then(Value::as_str);
                (current != Some(DEFAULT_GEMINI_EFFORT)
                    && config_option_has_value(thought_opt, DEFAULT_GEMINI_EFFORT))
                    .then(|| DEFAULT_GEMINI_EFFORT.to_string())
            });
            if let (Some(effort), Some(config_id), Some(session_id)) = (
                target_effort,
                config_option_id(thought_opt).map(String::from),
                self.st.session_id.clone(),
            ) {
                self.step = Step::SetEffort;
                self.send_request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": config_id, "value": effort }),
                );
                return;
            }
        }
        self.send_prompt();
    }

    /// Handle one stdout line. Returns `true` when the runner should stop the child (after grace).
    fn on_line(&mut self, line: &str) -> bool {
        let Some(msg) = parse_json_object(line) else {
            (self.on_event)(RunnerEvent::new("log", line));
            return false;
        };

        // Incoming agent -> client request or notification
        if let Some(method) = msg.get("method").and_then(Value::as_str) {
            if let Some(id) = msg.get("id") {
                if method == "session/request_permission" {
                    let params = msg.get("params").unwrap_or(&Value::Null);
                    // A request's agent has agy's own tools inside its folders; a side check has Scarlet's only.
                    let allow = match &self.roots { Some(roots) => workspace_permission(params, roots), None => is_scarlet_mcp_permission(params) };
                    if !allow {
                        self.refused.push(permission_tool(params));
                    }
                    self.send(json!({
                        "id": id,
                        "result": { "outcome": permission_outcome(params, allow) }
                    }));
                } else {
                    self.send(json!({
                        "id": id,
                        "error": { "code": -32601, "message": "Unsupported by Scarlet" }
                    }));
                }
                return false;
            }
            if method == "session/update" {
                if let Some(update) = msg.pointer("/params/update") {
                    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
                    for ev in parse_gemini_acp_update(update, &mut self.st) {
                        (self.on_event)(ev);
                    }
                    if matches!(kind, "usage_update" | "tool_call" | "tool_call_update" | "agent_message_chunk") {
                        self.poll_transcript_usage();
                    }
                    self.emit_usage();
                    if self.st.should_stop {
                        self.st.should_stop = false;
                        self.cancel_turn();
                        return true;
                    }
                }
            }
            return false;
        }

        // Response to our pending request
        if msg.get("id").and_then(Value::as_u64) != Some(self.request_id) || self.step == Step::Done {
            return false;
        }

        if let Some(err) = msg.get("error").filter(|v| v.is_object()) {
            let detail = non_empty_str(err.get("message"))
                .map(String::from)
                .unwrap_or_else(|| brief_input(Some(err), 400));
            let detail = if detail.is_empty() { "unknown error".to_string() } else { detail };
            let code = err.get("code").and_then(Value::as_i64);
            if self.step == Step::SessionOpen
                && !self.tried_api_key_auth
                && self.has_api_key
                && (code == Some(-32000) || detail.to_ascii_lowercase().contains("auth"))
            {
                self.tried_api_key_auth = true;
                self.step = Step::Authenticate;
                self.send_request("authenticate", json!({ "methodId": "gemini-api-key" }));
                return false;
            }
            if self.step == Step::SessionOpen && self.resume_session.is_some() {
                self.resume_failed = true;
                self.st.failed = Some(format!("Gemini could not resume session: {detail}"));
                self.stop_session();
                return true;
            }
            self.fail_session(format!("Gemini {} failed: {detail}", self.step.label()));
            return true;
        }

        let result = msg.get("result").unwrap_or(&Value::Null);
        match self.step {
            Step::Initialize => {
                // Scarlet's prompt reaches Gemini only as an addition to agy's system prompt. An agy that doesn't offer
                // that would drop it without a word, and Gemini would edit with no instructions.
                if result.pointer("/agentCapabilities/_meta/antigravity/systemPrompt/append") != Some(&Value::Bool(true)) {
                    let version = non_empty_str(result.pointer("/agentInfo/version")).map(|v| format!(" {v}")).unwrap_or_default();
                    self.fail_session(format!(
                        "This agy{version} doesn't take Scarlet's instructions (its initialize result lists no systemPrompt.append), so Gemini would edit without them. Update agy."
                    ));
                    return true;
                }
                self.send_open_session();
            }
            Step::Authenticate => {
                self.send_open_session();
            }
            Step::SessionOpen => {
                let session_id = non_empty_str(result.get("sessionId"))
                    .map(String::from)
                    .or_else(|| self.resume_session.clone());
                let Some(session_id) = session_id else {
                    self.fail_session("Gemini session returned no sessionId");
                    return true;
                };
                self.st.session_id = Some(session_id.clone());
                self.transcript.open(&self.env, &session_id, self.resume_session.is_some());
                self.config_options = parse_config_options(result);
                let legacy_models = result.get("models").filter(|v| v.is_object());
                self.has_legacy_models = legacy_models.is_some();
                let model_opt = find_config_option(&self.config_options, "model", &["model"]);
                self.st.model = self
                    .model_override
                    .clone()
                    .or_else(|| model_opt.and_then(|o| non_empty_str(o.get("currentValue"))).map(String::from))
                    .or_else(|| legacy_models.and_then(|m| non_empty_str(m.get("currentModelId"))).map(String::from));

                let mut init_data = serde_json::Map::new();
                init_data.insert("kind".into(), json!("init"));
                if let Some(ref m) = self.st.model {
                    init_data.insert("model".into(), json!(m));
                }
                init_data.insert("sessionId".into(), json!(session_id));
                let init_text = format!(
                    "Gemini session started{}",
                    self.st.model.as_deref().map(|m| format!(" ({m})")).unwrap_or_default()
                );
                (self.on_event)(RunnerEvent::with("log", init_text, Value::Object(init_data)));

                if let Some(model) = self.model_override.clone() {
                    if let Some(config_id) = model_opt.and_then(config_option_id).map(String::from) {
                        self.step = Step::SetModel;
                        self.send_request(
                            "session/set_config_option",
                            json!({ "sessionId": session_id, "configId": config_id, "value": model }),
                        );
                        return false;
                    }
                    if self.has_legacy_models {
                        self.step = Step::SetModel;
                        self.send_request(
                            "session/set_model",
                            json!({ "sessionId": session_id, "modelId": model }),
                        );
                        return false;
                    }
                }
                self.maybe_set_effort_then_prompt();
            }
            Step::SetModel => {
                if let Some(ref m) = self.model_override {
                    self.st.model = Some(m.clone());
                }
                let refreshed = parse_config_options(result);
                if !refreshed.is_empty() {
                    self.config_options = refreshed;
                }
                self.maybe_set_effort_then_prompt();
            }
            Step::SetEffort => {
                let refreshed = parse_config_options(result);
                if !refreshed.is_empty() {
                    self.config_options = refreshed;
                }
                self.send_prompt();
            }
            Step::Prompt => {
                let mut flush_evs = Vec::new();
                flush_streams(&mut self.st, &mut flush_evs);
                for ev in flush_evs {
                    (self.on_event)(ev);
                }
                self.poll_transcript_usage();
                let model = self.st.model.as_deref().or(self.model_override.as_deref());
                let finished_turn = gemini_usage(result.get("usage"), model)
                    .or_else(|| self.st.turn_usage.clone());
                if let Some(turn_usage) = finished_turn {
                    self.st.completed_usage = add_usage(self.st.completed_usage.take(), Some(turn_usage));
                }
                self.st.turn_usage = None;
                self.transcript.reset_turn();
                self.st.sync_usage();
                self.emit_usage();
                let stop_reason = non_empty_str(result.get("stopReason")).unwrap_or("end_turn");
                // A turn Scarlet cancelled itself (a question to stop on, a stall, a time limit, Stop this edit) ended
                // as asked: the host says why the run stopped, so it isn't reported as an error of Gemini's first.
                if stop_reason == "cancelled" && (self.st.question.is_some() || self.cancel_sent) {
                    self.stop_session();
                    return true;
                }
                if stop_reason == "end_turn" && self.carry_on_after_refusal() {
                    return self.step == Step::Done;
                }
                if matches!(stop_reason, "end_turn" | "max_tokens" | "stop_sequence") {
                    self.st.completed = true;
                    let summary = self.st.last_message.clone().unwrap_or_else(|| "done".to_string());
                    if let Some(usage) = result.get("usage").filter(|v| !v.is_null()) {
                        (self.on_event)(RunnerEvent::with("result", summary, json!({ "usage": usage })));
                    } else {
                        (self.on_event)(RunnerEvent::new("result", summary));
                    }
                    self.stop_session();
                    return true;
                }
                self.fail_session(format!("Gemini ended with stopReason {stop_reason}"));
                return true;
            }
            Step::Done => {}
        }
        false
    }
}

pub async fn run_gemini(opts: RunOptions) -> RunResult {
    let bin = match opts.resolve_bin("agy") {
        Ok(b) => b,
        Err(e) => return RunResult::failed(e.to_string()),
    };
    let cmd = build_gemini_command(&bin);

    let (input, lines) = mpsc::unbounded_channel();
    let has_api_key = has_api_key("gemini", &opts.env);

    let session = AcpSession {
        input: Some(input),
        request_id: 1,
        step: Step::Initialize,
        tried_api_key_auth: false,
        resume_failed: false,
        cancel_sent: false,
        has_api_key,
        cwd: opts.cwd.to_string_lossy().into_owned(),
        env: opts.env.clone(),
        mcp_server: acp_mcp_server(&opts.mcp),
        model_override: opts.model.clone(),
        effort_override: opts.effort.clone(),
        resume_session: opts.resume_session.clone(),
        instruction: opts.instruction.clone(),
        system_prompt: opts.system_prompt.clone(),
        refused_tool: opts.refused_tool.clone(),
        refused: Vec::new(),
        roots: opts.workspace.as_ref().map(|ws| std::iter::once(opts.cwd.to_string_lossy().into_owned())
            .chain(ws.read_dirs.iter().map(|d| d.to_string_lossy().into_owned())).collect()),
        carry_ons: 0,
        config_options: Vec::new(),
        has_legacy_models: false,
        st: GeminiState::default(),
        transcript: TranscriptUsageTailer::default(),
        sent_usage: None,
        on_event: opts.on_event.clone(),
        on_usage: opts.on_usage.clone(),
    };

    // Start the ACP handshake immediately so the first request is queued on stdin.
    session.send(json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": { "name": "scarlet", "version": env!("CARGO_PKG_VERSION") }
        }
    }));

    let state = Arc::new(Mutex::new(session));
    let interrupt_state = state.clone();
    let interrupt = Box::new(move || interrupt_state.lock().unwrap().cancel_turn());
    let line_state = state.clone();
    let handler = Box::new(move |line: &str| line_state.lock().unwrap().on_line(line));

    let poll_state = state.clone();
    let poll_handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(TRANSCRIPT_POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let mut sess = poll_state.lock().unwrap();
            if sess.step == Step::Done {
                break;
            }
            if sess.step == Step::Prompt {
                sess.poll_transcript_usage();
                sess.emit_usage();
            }
        }
    });

    let spawn_res = spawn_interactive(
        &cmd.file,
        &cmd.args,
        opts.spawn_options(None),
        lines,
        STOP_GRACE,
        interrupt,
        handler,
    )
    .await;
    poll_handle.abort();
    let outcome = match spawn_res {
        Ok(o) => o,
        Err(e) => return RunResult::failed(e.to_string()),
    };

    let (st, resume_failed) = {
        let mut sess = state.lock().unwrap();
        let mut remaining = Vec::new();
        flush_streams(&mut sess.st, &mut remaining);
        for ev in remaining {
            (sess.on_event)(ev);
        }
        sess.poll_transcript_usage();
        sess.emit_usage();
        (sess.st.clone(), sess.resume_failed)
    };

    let usage = st.usage.clone().map(|u| u.or_model(opts.model.as_deref()));
    if resume_failed {
        return RunResult {
            ok: false,
            summary: String::new(),
            error: st.failed,
            resume_failed: true,
            exit_code: outcome.code,
            usage,
            ..Default::default()
        };
    }
    let base = RunResult {
        session_id: st.session_id.clone(),
        usage: usage.clone(),
        ..Default::default()
    };
    if let Some(result) = cut_short(&st.texts, st.question.as_ref(), st.question_posted, &outcome, &base) {
        return result;
    }
    let ok = st.failed.is_none() && st.completed;
    RunResult {
        ok,
        summary: st.last_message.unwrap_or_else(|| tail_summary(&st.texts)),
        error: if ok {
            None
        } else {
            Some(st.failed.clone().unwrap_or_else(|| exit_error("agy", &outcome)))
        },
        exit_code: outcome.code,
        session_id: st.session_id,
        usage,
        ..Default::default()
    }
}
