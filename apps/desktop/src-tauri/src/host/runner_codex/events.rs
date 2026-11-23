//! Codex's stream, from `codex exec --json` lines and App Server notifications, as the host's runner events.

use serde_json::{json, Value};

use super::CodexState;
use crate::host::runner::parse_json_object;
use crate::host::types::{brief, brief_input, is_question_tool, prune_nulls, question_words, record_plan, trimmed_str, truthy, value_text, PlanStep, RunnerEvent};
use crate::host::usage::{add_usage, codex_app_server_usage, codex_usage};

/// The steps of a `todo_list` item: Codex's `update_plan`, as `codex exec --json` reports it. Each step is its text and
/// whether it is finished. The stream leaves out which step is under way, so none is "in_progress".
fn codex_plan(items: Option<&Value>) -> Option<Vec<PlanStep>> {
    let steps = items?.as_array()?.iter().filter_map(|entry| {
        let text = trimmed_str(entry.get("text"))?;
        let done = entry.get("completed").and_then(Value::as_bool).unwrap_or(false);
        Some(PlanStep { text, state: if done { "done" } else { "pending" } })
    });
    Some(steps.collect())
}

/// Codex reports stream retries and its HTTPS fallback as errors, then usually carries on.
pub(super) fn is_retry_notice(text: &str) -> bool {
    let reconnecting = text.strip_prefix("Reconnecting... ").and_then(|rest| rest.split_once('/')).is_some_and(|(done, rest)| {
        !done.is_empty() && done.chars().all(|c| c.is_ascii_digit()) && rest.starts_with(|c: char| c.is_ascii_digit())
    });
    reconnecting || text.starts_with("Falling back from WebSockets")
}

fn s(v: Option<&Value>) -> Option<String> {
    v.filter(|x| !x.is_null()).map(value_text)
}

fn record_codex_plan(steps: Option<Vec<PlanStep>>, st: &mut CodexState, events: &mut Vec<RunnerEvent>) {
    if let Some(steps) = steps {
        events.extend(record_plan(&mut st.plan, steps, false));
    }
}

/// Parse one JSONL line from `codex exec --json`.
pub(super) fn parse_codex_line(line: &str, st: &mut CodexState) -> Vec<RunnerEvent> {
    let Some(msg) = parse_json_object(line) else {
        return vec![RunnerEvent::new("log", line)];
    };
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    codex_events(kind, &msg, st)
}

fn codex_events(kind: &str, msg: &Value, st: &mut CodexState) -> Vec<RunnerEvent> {
    let mut events = Vec::new();
    let item = msg.get("item").filter(|i| i.is_object());

    match kind {
        "thread.started" => {
            let tid = msg.get("thread_id").or_else(|| msg.pointer("/thread/id")).filter(|v| !v.is_null());
            let text = format!("Codex session started{}", tid.map(|t| format!(" ({})", value_text(t))).unwrap_or_default());
            let mut data = serde_json::Map::new();
            data.insert("kind".into(), json!("init"));
            if let Some(t) = tid {
                data.insert("threadId".into(), t.clone());
            }
            events.push(RunnerEvent::with("log", text, Value::Object(data)));
        }
        "turn.started" => {}
        "item.started" | "item.updated" | "item.completed" => {
            let Some(item) = item else { return events };
            let completed = kind == "item.completed";
            let started = kind == "item.started";
            let itype = item.get("type").and_then(Value::as_str).unwrap_or("");
            let text_field = item.get("text").and_then(Value::as_str).map(str::to_string);
            match itype {
                "agent_message" | "agentMessage" => {
                    if completed {
                        if let Some(t) = text_field.filter(|t| !t.trim().is_empty()) {
                            st.texts.push(t.clone());
                            st.last_message = Some(t.clone());
                            if item["phase"] == "final_answer" {
                                st.final_message = Some(t.clone());
                            }
                            events.push(RunnerEvent::new("log", t));
                        }
                    }
                }
                "reasoning" => {
                    if completed {
                        let summary = || item.get("summary")?.as_array().map(|parts| {
                            parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")
                        });
                        if let Some(t) = text_field.or_else(summary).filter(|t| !t.trim().is_empty()) {
                            events.push(RunnerEvent::with("log", format!("(thinking) {}", brief_input(Some(&Value::String(t)), 200)), json!({"kind":"reasoning"})));
                        }
                    }
                }
                "command_execution" | "commandExecution" => {
                    let command = item.get("command");
                    if started {
                        let mut data = serde_json::Map::new();
                        data.insert("tool".into(), json!("command_execution"));
                        if let Some(c) = command {
                            data.insert("command".into(), c.clone());
                        }
                        events.push(RunnerEvent::with("tool", format!("shell {}", brief_input(command, 200)), Value::Object(data)));
                    } else if completed {
                        if let Some(code) = item.get("exit_code").or_else(|| item.get("exitCode")).and_then(Value::as_i64) {
                            if code != 0 {
                                events.push(RunnerEvent::new(
                                    "error",
                                    format!("Command exited {code}: {}\n{}", brief_input(command, 120), brief_input(item.get("aggregated_output").or_else(|| item.get("aggregatedOutput")), 400)),
                                ));
                            }
                        }
                    }
                }
                "mcp_tool_call" | "mcpToolCall" => {
                    let server = s(item.get("server")).unwrap_or_else(|| "mcp".into());
                    let tool = s(item.get("tool"));
                    let name = format!("{server}.{}", tool.clone().unwrap_or_else(|| "?".into()));
                    let arguments = item.get("arguments");
                    let status = item.get("status").and_then(Value::as_str);
                    let has_error = truthy(item.get("error"));
                    if is_question_tool(tool.as_deref()) {
                        // Only a call with words to ask is a question. App Server may withhold the arguments until the
                        // tool finishes, so the words can first come with its result.
                        let id = item.get("id").cloned();
                        if let (None, Some(text)) = (&st.question, question_words(arguments)) {
                            st.question = Some(text);
                            st.question_item = id.clone();
                        }
                        if completed {
                            let refused = status == Some("failed") || has_error || truthy(item.pointer("/result/isError"));
                            let asked = st.question.is_some() && st.question_item == id;
                            if asked && !refused {
                                // The question is the editor's now: said once posted, and the turn stops on it.
                                st.question_posted = true;
                                st.should_stop = true;
                                let mut data = serde_json::Map::new();
                                data.insert("tool".into(), Value::String(name.clone()));
                                if let Some(id) = id {
                                    data.insert("itemId".into(), id);
                                }
                                events.push(RunnerEvent::with("question", st.question.clone().unwrap_or_default(), Value::Object(data)));
                            } else {
                                // A question the MCP server refused, or a call with no words, isn't asked: the model hears
                                // why and carries on, and so does the run.
                                if asked {
                                    st.question = None;
                                    st.question_item = None;
                                }
                                if refused {
                                    let detail = if has_error { item.get("error") } else { item.get("result") };
                                    events.push(RunnerEvent::new("error", format!("{name} failed: {}", brief_input(detail, 400))));
                                }
                            }
                        }
                    } else if started {
                        let text = format!("{name} {}", brief(arguments)).trim().to_string();
                        let mut data = serde_json::Map::new();
                        data.insert("tool".into(), Value::String(name));
                        data.insert("input".into(), arguments.cloned().unwrap_or(Value::Null));
                        if let Some(id) = item.get("id") {
                            data.insert("itemId".into(), id.clone());
                        }
                        events.push(RunnerEvent::with("tool", text, prune_nulls(data)));
                    } else if completed && (status == Some("failed") || has_error) {
                        let detail = if has_error { item.get("error") } else { item.get("result") };
                        events.push(RunnerEvent::new("error", format!("{name} failed: {}", brief_input(detail, 400))));
                    }
                }
                "file_change" | "fileChange" => {
                    if completed {
                        events.push(RunnerEvent::with("tool", format!("edited files {}", brief_input(item.get("changes"), 200)), json!({"tool":"file_change"})));
                    }
                }
                "web_search" | "webSearch" => {
                    if started {
                        events.push(RunnerEvent::with("tool", format!("web search {}", brief_input(item.get("query"), 120)), json!({"tool":"web_search"})));
                    }
                }
                "contextCompaction" | "context_compaction" => {
                    st.compaction_items = true;
                    if started {
                        events.push(RunnerEvent::with("log", "Compacting context", json!({"kind":"compaction","active":true})));
                    } else if completed {
                        events.push(RunnerEvent::with("log", "Context compacted", json!({"kind":"compaction"})));
                    }
                }
                "todo_list" => {
                    // The whole plan each time: when the model first makes it, on every update, and once more as the turn ends.
                    record_codex_plan(codex_plan(item.get("items")), st, &mut events);
                }
                "error" => {
                    let text = item.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| brief_input(Some(item), 400));
                    if is_retry_notice(&text) {
                        events.push(RunnerEvent::with("log", text, json!({"kind":"connection"})));
                    } else {
                        events.push(RunnerEvent::new("error", text));
                    }
                }
                _ => {}
            }
        }
        "turn.completed" => {
            st.turn_completed = true;
            st.usage = add_usage(st.usage.take(), codex_usage(msg.get("usage"), None));
            let mut data = serde_json::Map::new();
            if let Some(u) = msg.get("usage") {
                data.insert("usage".into(), u.clone());
            }
            let summary = st.final_message.as_ref().or(st.last_message.as_ref()).cloned().unwrap_or_else(|| "done".into());
            events.push(RunnerEvent::with("result", summary, Value::Object(data)));
        }
        "turn.failed" => {
            let err = msg
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let b = brief_input(msg.get("error"), 400);
                    if b.is_empty() {
                        "turn failed".into()
                    } else {
                        b
                    }
                });
            st.failed = Some(err.clone());
            events.push(RunnerEvent::new("error", err));
        }
        "error" => {
            let err = msg.get("message").or_else(|| msg.pointer("/error/message")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| brief_input(Some(msg), 400));
            if msg["willRetry"] == true || is_retry_notice(&err) {
                st.retry_notice = Some(err.clone());
                events.push(RunnerEvent::with("log", err, json!({"kind":"connection"})));
            } else {
                st.failed = Some(err.clone());
                events.push(RunnerEvent::new("error", err));
            }
        }
        _ => {}
    }
    events
}

pub(super) fn app_server_events(method: &str, params: &Value, st: &mut CodexState) -> Vec<RunnerEvent> {
    match method {
        "thread/started" => {
            st.model = params["model"].as_str().map(str::to_string);
            st.thread_id = params.pointer("/thread/id").and_then(Value::as_str).map(str::to_string);
            let mut events = codex_events("thread.started", params, st);
            // The engine keeps an App Server thread as the run's session, which an answer or a resume after a quit
            // carries on in. `codex exec` threads are ephemeral and aren't named.
            if let (Some(id), Some(Value::Object(data))) = (&st.thread_id, events.first_mut().and_then(|e| e.data.as_mut())) {
                data.insert("sessionId".into(), json!(id));
            }
            events
        }
        "turn/requested" => {
            st.turn_requested = true;
            Vec::new()
        }
        "thread/tokenUsage/updated" => {
            // `total` is the thread's, from its first turn. On a resumed thread the first count's `total` less its
            // `last`, the call it is about, is what the earlier runs used; a Codex that starts the count again has
            // nothing there to take off. Without a `last` the whole first count is taken for theirs.
            if let Some(total) = codex_app_server_usage(params.pointer("/tokenUsage/total"), st.model.as_deref()) {
                if st.resumed && st.usage_base.is_none() {
                    let last = codex_app_server_usage(params.pointer("/tokenUsage/last"), None);
                    st.usage_base = Some(last.map_or_else(|| total.clone(), |last| total.clone().less(&last)));
                }
                st.usage = Some(match &st.usage_base {
                    Some(base) => total.less(base),
                    None => total,
                });
            }
            Vec::new()
        }
        "turn/plan/updated" => {
            let mut events = Vec::new();
            let steps = params["plan"].as_array().map(|plan| plan.iter().filter_map(|entry| {
                let text = entry["step"].as_str()?.trim();
                let state = match entry["status"].as_str() {
                    Some("completed") => "done",
                    Some("inProgress") => "in_progress",
                    _ => "pending",
                };
                (!text.is_empty()).then(|| PlanStep { text: text.into(), state })
            }).collect());
            record_codex_plan(steps, st, &mut events);
            events
        }
        // Codex compacted the thread's context. Newer versions report it as an item too, and that one counts.
        "thread/compacted" if !st.compaction_items => vec![RunnerEvent::with("log", "Context compacted", json!({"kind":"compaction"}))],
        "item/started" => codex_events("item.started", params, st),
        "item/updated" => codex_events("item.updated", params, st),
        "item/completed" => codex_events("item.completed", params, st),
        "turn/completed" => match params["turn"]["status"].as_str() {
            Some("completed") => codex_events("turn.completed", &Value::Null, st),
            Some("interrupted") if st.question.is_some() => Vec::new(),
            Some("interrupted") => codex_events("turn.failed", &json!({ "error": { "message": "Codex interrupted the turn" } }), st),
            _ => codex_events("turn.failed", &params["turn"], st),
        },
        "error" => codex_events("error", params, st),
        _ => Vec::new(),
    }
}
