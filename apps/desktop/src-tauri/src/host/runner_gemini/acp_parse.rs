//! Pure ACP message parsing, permission allowlisting, and command/config construction
//! for Gemini via Antigravity CLI (`agy acp`).

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::{json, Value};

use super::super::runner::RunnerCommand;
use super::super::types::{
    brief, brief_input, is_question_tool, non_empty_str, pretty_tool_name, question_words, record_plan, trimmed_str,
    McpSpec, PlanStep, RunnerEvent,
};
use super::super::usage::{add_usage, gemini_usage, AgentUsage};

#[derive(Debug, Default, Clone)]
pub struct GeminiState {
    pub texts: Vec<String>,
    pub last_message: Option<String>,
    /// Accumulated streamed assistant message (delta chunks).
    pub partial: String,
    /// Accumulated streamed reasoning/thought chunks.
    pub thought: String,
    /// Tool call names keyed by toolCallId so updates know which tool finished or failed.
    pub tool_names: HashMap<String, String>,
    /// The `task_question` call under way, so an update that doesn't name its tool is known for one.
    pub pending_question_id: Option<String>,
    pub question: Option<String>,
    /// The call `question` came from, which its result settles.
    pub(super) question_id: Option<String>,
    pub question_posted: bool,
    pub should_stop: bool,
    pub completed: bool,
    pub failed: Option<String>,
    pub model: Option<String>,
    pub session_id: Option<String>,
    /// Cumulative authoritative usage from completed `session/prompt` turns in this run.
    pub completed_usage: Option<AgentUsage>,
    /// Live usage observed so far in the active `session/prompt` turn.
    pub turn_usage: Option<AgentUsage>,
    /// Effective total usage for this run (`completed_usage + turn_usage`).
    pub usage: Option<AgentUsage>,
    pub plan: Option<Vec<PlanStep>>,
}

impl GeminiState {
    pub(super) fn sync_usage(&mut self) {
        self.usage = add_usage(self.completed_usage.clone(), self.turn_usage.clone());
    }
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| match p {
                Value::String(s) => s.clone(),
                Value::Object(o) => {
                    if let Some(t) = o.get("text").and_then(Value::as_str) {
                        t.to_string()
                    } else {
                        content_text(o.get("content"))
                    }
                }
                _ => String::new(),
            })
            .collect(),
        Some(Value::Object(o)) => {
            if let Some(t) = o.get("text").and_then(Value::as_str) {
                t.to_string()
            } else {
                content_text(o.get("content"))
            }
        }
        _ => String::new(),
    }
}

pub(super) fn flush_thought(st: &mut GeminiState, events: &mut Vec<RunnerEvent>) {
    let trimmed = st.thought.trim();
    if !trimmed.is_empty() {
        events.push(RunnerEvent::with(
            "log",
            format!("(thinking) {}", brief_input(Some(&Value::String(trimmed.to_string())), 200)),
            json!({ "kind": "reasoning" }),
        ));
    }
    st.thought.clear();
}

pub(super) fn flush_partial(st: &mut GeminiState, events: &mut Vec<RunnerEvent>) {
    let text = st.partial.trim();
    if !text.is_empty() {
        let text = text.to_string();
        st.texts.push(text.clone());
        st.last_message = Some(text.clone());
        events.push(RunnerEvent::new("log", text));
    }
    st.partial.clear();
}

pub(super) fn flush_streams(st: &mut GeminiState, events: &mut Vec<RunnerEvent>) {
    flush_thought(st, events);
    flush_partial(st, events);
}

/// Every tool Scarlet's MCP server offers: the tools of `EDITING_TOOL_GROUPS` in packages/shared/src/editingTools.ts,
/// and `tool_help` and `tool_call`, which the server adds for Gemini. A test keeps this list the same as that file's.
pub const SCARLET_TOOLS: &[&str] = &[
    "project_get", "timeline_get", "timeline_at", "timeline_diff", "timeline_propose", "timeline_first_cut",
    "timeline_crossfade_audio", "timeline_transition", "timeline_framing", "timeline_picture_sync",
    "transcript_get", "transcript_search", "timeline_transcript", "timeline_join_audit", "waveform_get", "sound_picture",
    "transcript_fix", "media_profile", "music_beats", "audio_sync", "dialogue_scan", "dialogue_check_join", "dialogue_check_repeats", "dialogue_apply_cuts",
    "dialogue_review_inspect", "dialogue_review_save", "dialogue_revise_cut",
    "screen_text", "screen_reading", "screen_motion",
    "faces", "lip_sync",
    "change_get", "change_list", "edit_flag", "notes_list", "note_reply", "note_resolve", "render_request", "render_status",
    "task_log", "task_question", "hand_off", "skills_list", "learning_suggest", "skill_save_from_change", "skill_save_edit",
    "web_capture", "web_video", "graphic_render", "graphic_get", "style_guide_save", "style_guide_update", "style_guide_preview_render", "style_guide_preview_get", "attachment_read",
    "media_frame", "frame_contact_sheet", "frame_contact_sheet_batch", "screen_area",
    "change_review_cut", "source_audio", "listen",
    "captions_generate",
    "asset_add", "export_otio",
    "tool_help", "tool_call",
];

/// The ways a harness names a tool of the `scarlet` MCP server.
const SCARLET_PREFIXES: [&str; 6] = ["mcp__scarlet__", "mcp_scarlet_", "scarlet__", "scarlet.", "scarlet/", "scarlet:"];

/// Whether `name` is a Scarlet tool's, whole: one of the prefixes, one of Scarlet's tools by its exact name, then
/// nothing or something no path or name goes on with. `scarlet/notes.md` or `scarlet.json` is a file's.
fn names_scarlet_tool(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    SCARLET_PREFIXES.iter().filter_map(|prefix| name.strip_prefix(prefix)).any(|rest| {
        SCARLET_TOOLS.iter().any(|tool| {
            rest.strip_prefix(tool).is_some_and(|after| {
                after.chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || "_.-/\\".contains(c)))
            })
        })
    })
}

/// Whether an ACP `session/request_permission` request targets a Scarlet MCP tool: its meta names the `scarlet`
/// server, or its name or tool name is a Scarlet tool's. A title is display text (agy shows the model's own
/// `toolSummary` there, which a built-in tool's call could fill with a Scarlet tool's name), so it counts only when
/// the request gives no name at all.
pub fn is_scarlet_mcp_permission(params: &Value) -> bool {
    let Some(tc) = params.get("toolCall").and_then(Value::as_object) else {
        return false;
    };
    let meta = tc.get("_meta").and_then(Value::as_object);
    let server_candidates = [
        meta.and_then(|m| m.get("mcpServer")),
        meta.and_then(|m| m.get("server")),
        meta.and_then(|m| m.get("serverName")),
        tc.get("mcpServer"),
        tc.get("server"),
        tc.get("serverName"),
    ];
    if server_candidates.into_iter().flatten().any(|server| server.as_str().is_some_and(|s| s.eq_ignore_ascii_case("scarlet"))) {
        return true;
    }
    let names: Vec<&str> = ["name", "toolName"].iter().filter_map(|key| tc.get(*key).and_then(Value::as_str)).filter(|n| !n.trim().is_empty()).collect();
    if names.is_empty() {
        return tc.get("title").and_then(Value::as_str).is_some_and(names_scarlet_tool);
    }
    names.into_iter().any(names_scarlet_tool)
}

/// Every path a permission request names: its locations, and any absolute path among its input's values, or any that
/// climbs out of the folder it is read from (`../`).
fn named_paths(params: &Value) -> Vec<String> {
    fn absolute(v: &str) -> bool {
        let v = v.trim();
        v.starts_with('/') || v.starts_with("~/") || drive(v)
    }
    fn climbs(v: &str) -> bool {
        v.trim().split(['/', '\\']).any(|part| part == "..")
    }
    fn visit(value: &Value, depth: usize, out: &mut Vec<String>) {
        if depth > 4 { return; }
        match value {
            Value::String(v) if (absolute(v) || climbs(v)) && v.len() < 4096 => out.push(v.trim().to_string()),
            Value::Array(items) => items.iter().for_each(|v| visit(v, depth + 1, out)),
            Value::Object(map) => map.values().for_each(|v| visit(v, depth + 1, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    let Some(tc) = params.get("toolCall") else { return out };
    if let Some(locations) = tc.get("locations").and_then(Value::as_array) {
        out.extend(locations.iter().filter_map(|l| l.get("path").and_then(Value::as_str)).map(str::to_string));
    }
    if let Some(input) = tc.get("rawInput") { visit(input, 0, &mut out); }
    out
}

/// A path with `.` and `..` worked out, as text, the way Node's `path.resolve` reads an absolute one.
fn resolved(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let unified = path.replace('\\', "/");
    let (prefix, rest) = match unified.find(':') { Some(1) => unified.split_at(2), _ => ("", unified.as_str()) };
    for part in rest.split('/') {
        match part { "" | "." => {}, ".." => { parts.pop(); }, p => parts.push(p) }
    }
    format!("{prefix}/{}", parts.join("/"))
}

/// A Windows path from a drive's root: `C:\` or `C:/`.
fn drive(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// Whether a request's agent may use one of agy's own tools: yes unless it names a path outside the folders it works in
/// (its task folder, and those its programs live in). agy's sandbox restricts its terminal; its file tools reach as far
/// as the user's files do, the library that holds Scarlet's token among them. A relative path is read from the task
/// folder, the first of them, as agy reads it.
pub fn workspace_permission(params: &Value, roots: &[String]) -> bool {
    if is_scarlet_mcp_permission(params) {
        return true;
    }
    let task_folder = roots.iter().find(|r| !r.trim().is_empty()).cloned();
    let roots: Vec<String> = roots.iter().map(|r| resolved(r)).collect();
    named_paths(params).iter().all(|path| {
        if path.starts_with('~') { return false; }
        let relative = !path.starts_with(['/', '\\']) && !drive(path);
        let p = match (relative, &task_folder) {
            (false, _) => resolved(path),
            (true, Some(folder)) => resolved(&format!("{folder}/{path}")),
            (true, None) => return false,
        };
        roots.iter().any(|root| p == *root || p.starts_with(&format!("{}/", root.trim_end_matches('/'))))
    })
}

/// Pick the best ACP permission outcome for allow vs reject.
pub fn permission_outcome(params: &Value, allow: bool) -> Value {
    let options = params.get("options").and_then(Value::as_array);
    let preferred = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    if let Some(options) = options {
        for kind in preferred {
            if let Some(id) = options.iter().find_map(|o| {
                (o.get("kind").and_then(Value::as_str) == Some(kind))
                    .then(|| o.get("optionId").and_then(Value::as_str))
                    .flatten()
            }) {
                return json!({ "outcome": "selected", "optionId": id });
            }
        }
    }
    json!({ "outcome": "cancelled" })
}

fn first<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| obj.get(*k)).filter(|v| !v.is_null())
}

/// A call through `tool_call`, which the MCP server offers a Gemini run for the tools it doesn't list on their own, as
/// the call it makes: the tool it names, with that tool's arguments, so the run's history says what Scarlet did. A
/// question stays as it is: the server refuses one asked through `tool_call`, so it was never asked.
pub(super) fn through_tool_call(raw_name: String, input: Option<&Value>) -> (String, Option<Value>) {
    if pretty_tool_name(&raw_name) != "scarlet.tool_call" {
        return (raw_name, input.cloned());
    }
    let named = input.and_then(|i| i.get("name")).and_then(Value::as_str).map(|n| n.trim().to_ascii_lowercase());
    let tool = named.map(|n| {
        ["mcp__scarlet__", "mcp_scarlet_", "scarlet__", "scarlet.", "scarlet/", "scarlet:"]
            .iter()
            .find_map(|prefix| n.strip_prefix(prefix).map(str::to_string))
            .unwrap_or(n)
    });
    match tool {
        Some(tool) if !tool.is_empty() && tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !is_question_tool(Some(&tool)) => {
            let args = input.and_then(|i| i.get("arguments")).cloned().unwrap_or_else(|| json!({}));
            (format!("scarlet.{tool}"), Some(args))
        }
        _ => (raw_name, input.cloned()),
    }
}

pub(super) fn extract_tool_name(update: &Value) -> String {
    non_empty_str(update.get("name"))
        .or_else(|| non_empty_str(update.get("toolName")))
        .or_else(|| non_empty_str(update.get("title")))
        .unwrap_or("tool")
        .to_string()
}

fn is_failed_output(raw_output: Option<&Value>, content: Option<&Value>) -> bool {
    if let Some(out) = raw_output.and_then(Value::as_object) {
        if out.get("isError").and_then(Value::as_bool) == Some(true)
            || out.get("is_error").and_then(Value::as_bool) == Some(true)
            || out.get("error").is_some_and(|v| !v.is_null() && v != &Value::Bool(false) && v != &Value::String(String::new()))
        {
            return true;
        }
    }
    if let Some(c) = content.and_then(Value::as_object) {
        if c.get("isError").and_then(Value::as_bool) == Some(true)
            || c.get("is_error").and_then(Value::as_bool) == Some(true)
        {
            return true;
        }
    }
    false
}

/// A `task_question` call, or an update to one: its words are the question once it has some. Only a call whose `text`
/// has something in it is a question; the words can come with the call or with an update to it.
fn note_question(st: &mut GeminiState, id: &Option<String>, input: Option<&Value>) {
    if let (None, Some(text)) = (&st.question, question_words(input)) {
        st.question = Some(text);
        st.question_id = id.clone();
    }
}

/// A `task_question` call has finished. Posted, the question is the editor's and the turn stops on it. Refused, or
/// with no words, it isn't asked: the model hears why and carries on, and so does the run.
fn settle_question(st: &mut GeminiState, id: &Option<String>, name: &str, update: &Value, events: &mut Vec<RunnerEvent>) {
    let status = update.get("status").and_then(Value::as_str);
    let refused = status != Some("completed") || is_failed_output(update.get("rawOutput"), update.get("content"));
    let asked = st.question.is_some() && st.question_id == *id;
    if st.pending_question_id == *id {
        st.pending_question_id = None;
    }
    let mut data = serde_json::Map::new();
    if let Some(call_id) = id {
        data.insert("toolId".into(), Value::String(call_id.clone()));
    }
    if asked && !refused {
        st.question_posted = true;
        st.should_stop = true;
        data.insert("tool".into(), Value::String(name.to_string()));
        events.push(RunnerEvent::with("question", st.question.clone().unwrap_or_default(), Value::Object(data)));
        return;
    }
    if asked {
        st.question = None;
        st.question_id = None;
    }
    if refused {
        let detail = first(update, &["rawOutput", "content", "error"]);
        events.push(RunnerEvent::with("error", format!("{name} failed: {}", brief_input(detail, 400)).trim().to_string(), Value::Object(data)));
    }
}

/// Parse one ACP `session/update` payload (`params.update`).
pub fn parse_gemini_acp_update(update: &Value, st: &mut GeminiState) -> Vec<RunnerEvent> {
    if !update.is_object() {
        return Vec::new();
    }
    let mut events = Vec::new();
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");

    match kind {
        "agent_message_chunk" => {
            flush_thought(st, &mut events);
            let text = content_text(update.get("content").or_else(|| update.get("text")));
            if !text.is_empty() {
                st.partial.push_str(&text);
            }
        }
        "agent_thought_chunk" => {
            let text = content_text(update.get("content").or_else(|| update.get("text")));
            if !text.is_empty() {
                st.thought.push_str(&text);
            }
        }
        "tool_call" => {
            flush_streams(st, &mut events);
            let (raw_name, input) = through_tool_call(extract_tool_name(update), first(update, &["rawInput", "parameters", "input", "arguments"]));
            let input = input.as_ref();
            let name = pretty_tool_name(&raw_name);
            let id = non_empty_str(update.get("toolCallId"))
                .or_else(|| non_empty_str(update.get("id")))
                .map(String::from);
            if let Some(ref call_id) = id {
                st.tool_names.insert(call_id.clone(), raw_name.clone());
            }
            let status = update.get("status").and_then(Value::as_str);
            if is_question_tool(Some(&raw_name)) {
                st.pending_question_id = id.clone();
                note_question(st, &id, input);
                if matches!(status, Some("completed" | "failed" | "error")) {
                    settle_question(st, &id, &name, update, &mut events);
                }
            } else {
                let text = format!("{name} {}", brief(input)).trim().to_string();
                let mut data = serde_json::Map::new();
                data.insert("tool".into(), Value::String(name));
                if let Some(i) = input {
                    data.insert("input".into(), i.clone());
                }
                if let Some(ref call_id) = id {
                    data.insert("toolId".into(), Value::String(call_id.clone()));
                }
                events.push(RunnerEvent::with("tool", text, Value::Object(data)));
            }
        }
        "tool_call_update" => {
            let id = non_empty_str(update.get("toolCallId"))
                .or_else(|| non_empty_str(update.get("id")))
                .map(String::from);
            let raw_name = id
                .as_ref()
                .and_then(|cid| st.tool_names.get(cid).cloned())
                .or_else(|| {
                    non_empty_str(update.get("name"))
                        .or_else(|| non_empty_str(update.get("toolName")))
                        .or_else(|| non_empty_str(update.get("title")))
                        .map(String::from)
                });
            let name = raw_name.as_deref().map(pretty_tool_name).unwrap_or_else(|| "tool".into());
            let status = update.get("status").and_then(Value::as_str);
            let input = first(update, &["rawInput", "parameters", "input", "arguments"]);
            let is_question = (id.is_some() && st.pending_question_id == id) || is_question_tool(raw_name.as_deref());
            if is_question {
                note_question(st, &id, input);
                if matches!(status, Some("completed" | "failed" | "error")) {
                    settle_question(st, &id, &name, update, &mut events);
                }
            } else if matches!(status, Some("failed" | "error")) {
                let detail = first(update, &["rawOutput", "content", "error"]);
                let text = format!("{name} failed: {}", brief_input(detail, 400)).trim().to_string();
                if let Some(call_id) = id {
                    events.push(RunnerEvent::with("error", text, json!({ "toolId": call_id })));
                } else {
                    events.push(RunnerEvent::new("error", text));
                }
            }
        }
        "plan" => {
            if let Some(entries) = update.get("entries").and_then(Value::as_array) {
                let steps = entries
                    .iter()
                    .filter_map(|entry| {
                        let text = trimmed_str(entry.get("content"))?;
                        let state = match entry.get("status").and_then(Value::as_str) {
                            Some("completed") => "done",
                            Some("in_progress") => "in_progress",
                            _ => "pending",
                        };
                        Some(PlanStep { text, state })
                    })
                    .collect();
                events.extend(record_plan(&mut st.plan, steps, false));
            }
        }
        "usage_update" => {
            let source = update.get("usage").unwrap_or(update);
            if let Some(usage) = gemini_usage(Some(source), st.model.as_deref()) {
                st.turn_usage = Some(usage);
                st.sync_usage();
            }
        }
        _ => {}
    }

    events
}

/// Convert Scarlet's `McpSpec` to an ACP stdio MCP server entry.
pub fn acp_mcp_server(mcp: &McpSpec) -> Value {
    let env: Vec<Value> = mcp
        .env
        .iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    json!({
        "name": "scarlet",
        "command": mcp.command,
        "args": mcp.args,
        "env": env,
    })
}

/// agy reads Scarlet's prompt from the session's own system prompt, not a `GEMINI.md`: it cuts a rule file off at
/// 24,000 bytes, and a pass's prompt with the editor's skill runs past that (28.5 KB on 2026-11-19, losing the skill's
/// pace, demo and punch-in sections).
///
/// `--gemini-dir` gives agy the run's own folder for its settings, rules, plugins and sessions (`gemini_dir`), so the
/// editor's personal `~/.gemini/GEMINI.md` and plugin rules, written for their own chats with Gemini, don't reach
/// Scarlet's runs, as they don't for Claude Code (`--restricted`) or Codex (its own `CODEX_HOME`). The sign-in stays:
/// agy keeps it in the system keychain.
pub fn build_gemini_command(bin: &str, gemini_dir: Option<&Path>) -> RunnerCommand {
    let mut args: Vec<String> = vec!["acp".into(), "--sandbox".into(), "--disable-telemetry".into()];
    if let Some(dir) = gemini_dir {
        args.extend(["--gemini-dir".into(), dir.to_string_lossy().into_owned()]);
    }
    RunnerCommand {
        file: bin.to_string(),
        args,
        stdin: None,
        files: BTreeMap::new(),
    }
}

/// `session/new` and `session/resume` meta that appends Scarlet's prompt to agy's system prompt, which agy's
/// `initialize` offers as `_meta.antigravity.systemPrompt.append`.
pub fn system_prompt_meta(system_prompt: &str) -> Value {
    json!({ "antigravity": { "systemPrompt": { "append": system_prompt } } })
}
