//! Data model shared with the Scarlet server (subset of packages/shared/src/api.ts)
//! plus the runner event types from apps/agent/src/runners/types.ts.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::util::{js_len, js_slice_prefix};

pub const CLI_AGENTS: [&str; 3] = ["claude", "codex", "gemini"];

// ---------------------------------------------------------------------------
// Agents & hosts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAvailability {
    pub id: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_in: Option<bool>,
    /// How the CLI is signed in: "subscription" (Claude Pro/Max, ChatGPT plan) or "api_key".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// Subscription tier when the CLI reports it (e.g. "max", "pro").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub model_labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub model_options: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHost {
    pub id: String,
    #[serde(default)]
    pub user_id: String,
    pub name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub agents: Vec<AgentAvailability>,
    #[serde(default)]
    pub online: bool,
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_root_id: Option<String>,
    pub project_id: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// low | medium | high | xhigh | max
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Fast mode (Claude fast mode / Codex fast service tier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub change_ids: Vec<String>,
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

fn default_kind() -> String {
    "edit".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaskWithEvents {
    pub task: Task,
    #[serde(default)]
    pub events: Vec<TaskEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteTaskRequest {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_started_at: Option<String>,
    pub interrupted: bool,
    /// Sent by the host started for the engine after the one the run lost. It counts as a lost worker, so a run whose
    /// own work keeps crashing the engine stops resuming by itself.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub engine_lost: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the engine tells the agent (GET /tasks/:id/prompt).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPrompt {
    pub system_prompt: String,
    pub instruction: String,
    /// Continue this CLI session with `instruction` (the editor's answer).
    #[serde(default)]
    pub resume_session: Option<String>,
    /// Launch the CLI with its own to-do tool on, so the plan it keeps reaches Scarlet.
    #[serde(default)]
    pub plan: bool,
}

// ---------------------------------------------------------------------------
// Runner events (apps/agent/src/runners/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RunnerEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RunnerEvent {
    pub fn new(kind: &str, text: impl Into<String>) -> Self {
        RunnerEvent { kind: kind.into(), text: text.into(), data: None }
    }
    pub fn with(kind: &str, text: impl Into<String>, data: Value) -> Self {
        RunnerEvent { kind: kind.into(), text: text.into(), data: Some(data) }
    }
}

/// One step of the agent's own plan, in its words: `state` is "pending", "in_progress" or "done" (PlanStep in @scarlet/shared).
#[derive(Debug, Clone, PartialEq)]
pub struct PlanStep {
    pub text: String,
    pub state: &'static str,
}

/// The agent's plan as its harness just reported it, whole. The engine records it only when it changed.
pub fn plan_event(steps: &[PlanStep]) -> RunnerEvent {
    let mark = |state: &str| match state {
        "done" => "[x]",
        "in_progress" => "[>]",
        _ => "[ ]",
    };
    let text = if steps.is_empty() { "Plan cleared".to_string() } else { steps.iter().map(|s| format!("{} {}", mark(s.state), s.text)).collect::<Vec<_>>().join("\n") };
    let list: Vec<Value> = steps.iter().map(|s| serde_json::json!({ "text": s.text, "state": s.state })).collect();
    RunnerEvent::with("plan", text, serde_json::json!({ "steps": list }))
}

/// How to launch the Scarlet MCP stdio server for one task.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct McpSpec {
    pub command: String,
    pub args: Vec<String>,
    /// BTreeMap so the generated configs are deterministic.
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct RunResult {
    pub ok: bool,
    pub summary: String,
    /// Set when the agent called task_question: the host must not complete the task.
    pub question: Option<String>,
    /// Provider-reported success. The engine acknowledges the durable pause.
    pub question_posted: bool,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    /// The host stopped the run: at its time cap, or because it had gone silent (`stalled`).
    pub timed_out: bool,
    pub stalled: bool,
    pub aborted: bool,
    /// The CLI session this run used, for resuming after a question.
    pub session_id: Option<String>,
    /// The CLI could not open the requested session. Nothing ran; start a fresh run.
    pub resume_failed: bool,
    /// Tokens the CLI reported for this run, when it reported any.
    pub usage: Option<super::usage::AgentUsage>,
}

/// Matches the Scarlet question tool however the CLI namespaces it
/// (mcp__scarlet__task_question, scarlet__task_question, task_question).
pub fn is_question_tool(name: Option<&str>) -> bool {
    let Some(n) = name else { return false };
    if n.is_empty() {
        return false;
    }
    if n == "task_question" || n == "mcp_scarlet_task_question" {
        return true;
    }
    if let Some(prefix) = n.strip_suffix("task_question") {
        return prefix.ends_with("__") || prefix.ends_with('.') || prefix.ends_with('/');
    }
    false
}

/// Strip the MCP namespace prefix for display: mcp__scarlet__timeline_get -> scarlet.timeline_get
pub fn pretty_tool_name(name: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"^mcp__([^_]+(?:_[^_]+)*?)__(.+)$").unwrap());
    if let Some(m) = re.captures(name) {
        return format!("{}.{}", &m[1], &m[2]);
    }
    match name.strip_prefix("scarlet__") {
        Some(rest) => format!("scarlet.{rest}"),
        None => name.to_string(),
    }
}

/// `briefInput(input, max)`: compact JSON (or the string itself), truncated in UTF-16 units.
pub fn brief_input(input: Option<&Value>, max: usize) -> String {
    let Some(v) = input else { return String::new() };
    let s = match v {
        Value::Null => return String::new(),
        Value::Object(m) if m.is_empty() => return String::new(),
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| other.to_string()),
    };
    if js_len(&s) > max {
        format!("{}…", js_slice_prefix(&s, max.saturating_sub(1)))
    } else {
        s
    }
}

pub fn brief(input: Option<&Value>) -> String {
    brief_input(input, 160)
}

/// Last-resort extraction of a summary from stream output when the CLI printed no result.
pub fn tail_summary(texts: &[String]) -> String {
    tail_summary_max(texts, 2000)
}

pub fn tail_summary_max(texts: &[String], max: usize) -> String {
    let joined = texts.iter().filter(|t| !t.is_empty()).cloned().collect::<Vec<_>>().join("\n");
    let joined = joined.trim();
    if js_len(joined) > max {
        format!("…{}", crate::util::js_slice_suffix(joined, max))
    } else {
        joined.to_string()
    }
}

/// `String(x)` for a JSON value in a `text` position: strings verbatim, else JSON.
pub fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognises_the_question_tool_in_every_namespace_style() {
        assert!(is_question_tool(Some("mcp__scarlet__task_question")));
        assert!(is_question_tool(Some("scarlet__task_question")));
        assert!(is_question_tool(Some("task_question")));
        assert!(is_question_tool(Some("scarlet.task_question")));
        assert!(!is_question_tool(Some("mcp__scarlet__task_log")));
        assert!(!is_question_tool(Some("xtask_question")));
        assert!(!is_question_tool(None));
        assert_eq!(pretty_tool_name("mcp__scarlet__timeline_get"), "scarlet.timeline_get");
        assert_eq!(pretty_tool_name("scarlet__x"), "scarlet.x");
        assert_eq!(pretty_tool_name("Bash"), "Bash");
    }

    #[test]
    fn brief_input_shapes() {
        assert_eq!(brief(None), "");
        assert_eq!(brief(Some(&json!({}))), "");
        assert_eq!(brief(Some(&json!("hi"))), "hi");
        assert_eq!(brief(Some(&json!({"mediaId":"m1"}))), r#"{"mediaId":"m1"}"#);
        let long = "x".repeat(200);
        let b = brief(Some(&json!(long)));
        assert_eq!(js_len(&b), 160);
        assert!(b.ends_with('…'));
    }

    #[test]
    fn reads_a_task_from_the_least_the_engine_sends() {
        let task: Task = serde_json::from_value(json!({ "id": "tsk_1", "projectId": "prj_1", "agent": "claude", "instruction": "Cut the pauses" })).unwrap();
        assert_eq!((task.kind.as_str(), task.state.as_str()), ("edit", ""));
        assert!(task.model.is_none() && task.effort.is_none() && task.fast.is_none() && task.service_tier.is_none());
        assert!(task.started_at.is_none() && task.resume_root_id.is_none() && task.change_ids.is_empty() && task.question.is_none());
        // Fields this host doesn't know are ignored, and the ones it does keep their camelCase names.
        let full: Task = serde_json::from_value(json!({
            "id": "tsk_2", "resumeRootId": "tsk_1", "projectId": "prj_1", "kind": "revise", "agent": "codex", "model": "gpt-5.5", "effort": "high",
            "fast": true, "serviceTier": "fast", "instruction": "x", "startedAt": "2026-11-08T10:00:00.000Z", "state": "running",
            "changeIds": ["chg_1"], "question": null, "summary": null, "createdBy": "usr_1", "needsTranscripts": ["m1"]
        })).unwrap();
        assert_eq!((full.resume_root_id.as_deref(), full.kind.as_str(), full.service_tier.as_deref(), full.fast), (Some("tsk_1"), "revise", Some("fast"), Some(true)));
        assert_eq!((full.started_at.as_deref(), full.change_ids.as_slice()), (Some("2026-11-08T10:00:00.000Z"), &["chg_1".to_string()][..]));
        // Without an id, a project or an instruction it is not a task this host can run.
        for missing in ["id", "projectId", "agent", "instruction"] {
            let mut partial = json!({ "id": "t", "projectId": "p", "agent": "claude", "instruction": "x" });
            partial.as_object_mut().unwrap().remove(missing);
            assert!(serde_json::from_value::<Task>(partial).is_err(), "accepted a task without {missing}");
        }
    }

    #[test]
    fn reads_a_prompt_a_task_with_events_and_a_host() {
        let prompt: TaskPrompt = serde_json::from_str(r#"{"systemPrompt":"SYS","instruction":"Do it"}"#).unwrap();
        assert_eq!((prompt.system_prompt.as_str(), prompt.instruction.as_str(), prompt.resume_session), ("SYS", "Do it", None));
        let resumed: TaskPrompt = serde_json::from_str(r#"{"systemPrompt":"SYS","instruction":"The editor said yes","resumeSession":"s1"}"#).unwrap();
        assert_eq!(resumed.resume_session.as_deref(), Some("s1"));
        assert!(serde_json::from_str::<TaskPrompt>(r#"{"instruction":"no system prompt"}"#).is_err());

        let bare: TaskWithEvents = serde_json::from_str(r#"{"task":{"id":"t","projectId":"p","agent":"claude","instruction":"x"}}"#).unwrap();
        assert!(bare.events.is_empty());
        let with: TaskWithEvents = serde_json::from_str(r#"{"task":{"id":"t","projectId":"p","agent":"claude","instruction":"x"},"events":[{"type":"change","text":"Cut","data":{"changeId":"chg_1"},"at":"now","seq":4}]}"#).unwrap();
        assert_eq!((with.events[0].kind.as_str(), with.events[0].data.as_ref().unwrap()["changeId"].as_str()), ("change", Some("chg_1")));

        let host: AgentHost = serde_json::from_str(r#"{"id":"host_1","name":"Mac (desktop)"}"#).unwrap();
        assert_eq!((host.id.as_str(), host.online, host.agents.len()), ("host_1", false, 0));
    }

    #[test]
    fn sends_events_and_completions_in_the_engines_shape() {
        let event = TaskEvent { task_id: Some("t".into()), at: None, kind: "tool".into(), text: "scarlet.timeline_get".into(), data: None };
        assert_eq!(serde_json::to_value(&event).unwrap(), json!({ "taskId": "t", "type": "tool", "text": "scarlet.timeline_get" }));
        let done = CompleteTaskRequest { state: "done".into(), if_started_at: None, interrupted: false, engine_lost: false, summary: None, error: None };
        assert_eq!(serde_json::to_value(&done).unwrap(), json!({ "state": "done", "interrupted": false }));
        // An assistant that isn't installed says only that. Empty catalogs are left out.
        let missing = AgentAvailability { id: "gemini".into(), ..Default::default() };
        assert_eq!(serde_json::to_value(&missing).unwrap(), json!({ "id": "gemini", "installed": false }));
        let found = AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), model_labels: BTreeMap::from([("opus".to_string(), "Opus".to_string())]), ..Default::default() };
        assert_eq!(serde_json::to_value(&found).unwrap(), json!({ "id": "claude", "installed": true, "loggedIn": true, "modelLabels": { "opus": "Opus" } }));
        assert_eq!(serde_json::to_value(RunnerEvent::new("log", "hi")).unwrap(), json!({ "type": "log", "text": "hi" }));
    }

    #[test]
    fn keeps_the_end_of_a_long_summary_and_names_tools_plainly() {
        let texts = vec![String::new(), "first".to_string(), "second".to_string()];
        assert_eq!(tail_summary(&texts), "first\nsecond");
        assert_eq!(tail_summary(&[]), "");
        // Over the limit, the end is what's kept, counted the way the TypeScript host counts.
        assert_eq!(tail_summary_max(&["abcdef".to_string(), "ghij".to_string()], 6), "…f\nghij");
        assert_eq!(tail_summary_max(&["  padded  ".to_string()], 6), "padded");
        assert_eq!((value_text(&json!("text")), value_text(&Value::Null), value_text(&json!({"a":1})), value_text(&json!(4))), ("text".into(), "null".into(), r#"{"a":1}"#.into(), "4".into()));
        // A server name may hold single underscores. The tool is what follows the last double one before it.
        assert_eq!(pretty_tool_name("mcp__my_server__timeline_get"), "my_server.timeline_get");
        assert_eq!(pretty_tool_name("mcp__scarlet__task__sub"), "scarlet.task__sub");
        assert!(!is_question_tool(Some("")));
        assert!(is_question_tool(Some("mcp_scarlet_task_question")) && is_question_tool(Some("scarlet/task_question")));
        // Brief input: null says nothing, and a number or a list is shown as JSON.
        assert_eq!((brief(Some(&Value::Null)), brief(Some(&json!([1, 2]))), brief_input(Some(&json!("abcdef")), 4)), (String::new(), "[1,2]".into(), "abc…".into()));
    }
}
