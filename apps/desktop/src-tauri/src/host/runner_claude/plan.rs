//! The agent's plan, read from Claude Code's own to-do tools.

use std::collections::BTreeMap;

use serde_json::Value;

use super::events::flatten_tool_result;
use crate::host::types::{record_plan, trimmed_str, value_text, PlanStep, RunnerEvent};

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

/// Note a call to one of Claude Code's to-do tools. True when the call was one, so it isn't logged as a Scarlet tool.
pub(super) fn plan_call(plan: &mut ClaudePlan, name: &str, id: &str, input: Option<&Value>) -> bool {
    let arg = |key: &str| trimmed_str(input.and_then(|i| i.get(key)));
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
                Some((i.to_string(), PlanStep { text: trimmed_str(todo.get("content"))?, state }))
            }).collect();
        }
        "TaskList" | "TaskGet" | "TodoRead" => {}
        _ => return false,
    }
    true
}

/// Apply a to-do call's result to the plan. True when the result was one.
pub(super) fn plan_result(plan: &mut ClaudePlan, id: &str, failed: bool, content: Option<&Value>, result: Option<&Value>) -> bool {
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
                .or_else(|| trimmed_str(result.and_then(|r| r.get("task")).and_then(|t| t.get("id"))));
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
pub(super) fn plan_change(plan: &mut ClaudePlan) -> Option<RunnerEvent> {
    if plan.calls.values().any(|call| matches!(call, PlanCall::Create(_))) {
        return None;
    }
    let steps: Vec<PlanStep> = plan.steps.iter().map(|(_, step)| step.clone()).collect();
    record_plan(&mut plan.sent, steps, true)
}
