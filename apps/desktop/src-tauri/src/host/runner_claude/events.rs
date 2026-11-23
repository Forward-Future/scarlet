//! Claude Code's `stream-json` lines as the host's runner events, and the state a run keeps from them.

use serde_json::{json, Map, Value};

use super::plan::{plan_call, plan_change, plan_result};
use super::ClaudeState;
use crate::host::runner::parse_json_object;
use crate::host::types::{brief, brief_input, is_question_tool, pretty_tool_name, prune_nulls, question_words, value_text, RunnerEvent};
use crate::host::usage::claude_usage;

pub(super) fn flatten_tool_result(content: Option<&Value>) -> String {
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

/// A compaction Claude Code reports once it has happened: what set it off and the context's size before and after.
fn compaction_event(meta: Option<&Value>) -> RunnerEvent {
    let mut data = Map::new();
    data.insert("kind".into(), json!("compaction"));
    for (from, to) in [("trigger", "trigger"), ("pre_tokens", "preTokens"), ("post_tokens", "postTokens")] {
        data.insert(to.into(), meta.and_then(|m| m.get(from)).cloned().unwrap_or(Value::Null));
    }
    RunnerEvent::with("log", "Context compacted", prune_nulls(data))
}

/// Parse one stream-json line from `claude -p --output-format stream-json --verbose`.
pub fn parse_claude_line(line: &str, st: &mut ClaudeState) -> Vec<RunnerEvent> {
    let Some(msg) = parse_json_object(line) else {
        return vec![RunnerEvent::new("log", line)];
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
            st.mcp_status = status.clone();
            // This runner offers only Scarlet's tools, so nothing useful can follow.
            if status.as_deref() == Some("failed") {
                st.should_stop = true;
            }
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
            events.push(RunnerEvent::with("log", format!("Claude Code session started{model}{mcp}"), prune_nulls(data)));
            if let Some(s) = status {
                if s != "connected" {
                    events.push(RunnerEvent::new("error", format!("Scarlet MCP server status: {s}")));
                }
            }
        } else if msg.get("subtype").and_then(Value::as_str) == Some("status") {
            if msg.get("status").and_then(Value::as_str) == Some("compacting") {
                if !st.compacting {
                    st.compacting = true;
                    events.push(RunnerEvent::with("log", "Compacting context", json!({"kind":"compaction","active":true})));
                }
            } else if st.compacting {
                st.compacting = false;
                events.push(RunnerEvent::with("log", "Compacting context", json!({"kind":"compaction","active":false})));
            }
        } else if msg.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
            // Claude Code compacted the session's context. The engine logs it and keeps it out of the chat.
            st.compacting = false;
            events.push(compaction_event(msg.get("compact_metadata")));
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
                        let question = question_words(input);
                        if plan_call(&mut st.plan, &name, &id, input) {
                            events.extend(plan_change(&mut st.plan));
                        } else if let (true, Some(text)) = (is_question_tool(Some(&name)), question) {
                            st.pending_question = Some((id, name, text.clone()));
                            st.question = Some(text);
                        } else {
                            let text = format!("{pretty} {}", brief(input)).trim().to_string();
                            let mut data = Map::new();
                            data.insert("tool".into(), Value::String(name));
                            data.insert("input".into(), input.cloned().unwrap_or(Value::Null));
                            data.insert("toolUseId".into(), Value::String(id));
                            events.push(RunnerEvent::with("tool", text, prune_nulls(data)));
                        }
                    } else if btype == "tool_result" {
                        let id = block.get("tool_use_id").map(value_text).unwrap_or_default();
                        let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                        if plan_result(&mut st.plan, &id, is_error, block.get("content"), msg.get("tool_use_result")) {
                            events.extend(plan_change(&mut st.plan));
                        } else if !is_error && st.pending_question.as_ref().is_some_and(|(pid, _, _)| pid == &id) {
                            // The question is the editor's now. Said only once posted, so the host never takes a refused
                            // one for a pause.
                            let (_, tool, text) = st.pending_question.take().unwrap_or_default();
                            st.question_posted = true;
                            st.should_stop = true;
                            events.push(RunnerEvent::with("question", text, json!({ "tool": tool, "toolUseId": id })));
                        } else if is_error {
                            // A question the MCP server refused isn't asked: the model hears why and can ask again.
                            if st.pending_question.as_ref().is_some_and(|(pid, _, _)| pid == &id) {
                                st.pending_question = None;
                                st.question = None;
                            }
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
        events.push(RunnerEvent::with(if is_error { "error" } else { "result" }, text, prune_nulls(data)));
        return events;
    }

    // stream_event / partial messages / hooks: ignore quietly.
    events
}
