//! Claude receives task text only on stdin. A side check can call only Scarlet MCP tools; a request has its shell,
//! file and web tools too.

pub(super) mod command;
mod events;
mod plan;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use super::runner::{cut_short, exit_error, report_usage, write_files, RunOptions};
use super::spawn::spawn_lines;
use super::usage::{add_usage, AgentUsage};
use super::types::{tail_summary, RunResult, CONTROL_DIR};
use command::{build_claude_command, can_run_bare, with_tool_timeout};
use events::parse_claude_line;
use plan::ClaudePlan;

#[derive(Debug, Default, Clone)]
pub struct ClaudeState {
    pub texts: Vec<String>,
    pub result: Option<String>,
    pub result_is_error: bool,
    /// A question call waiting for its result: its tool use id, the tool's name and the words it asks.
    pub pending_question: Option<(String, String, String)>,
    pub question: Option<String>,
    pub question_posted: bool,
    /// Set when the tool_result for the question arrived, or Scarlet's MCP server failed: the runner should stop the process.
    pub should_stop: bool,
    /// Scarlet's MCP server as the init line reported it ("connected", "failed", …), when it was listed.
    pub mcp_status: Option<String>,
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
    /// Whether Claude Code is currently compacting the session's context.
    pub compacting: bool,
}

/// Why a run whose Scarlet MCP server failed has failed: Claude Code carries on without it and calls the run a success.
const MCP_FAILED: &str = "Scarlet's MCP server failed to start, so Claude Code had no editing tools.";

/// The run's usage: the result totals, else the sum of the messages seen before the process stopped.
pub fn claude_run_usage(st: &ClaudeState, model: Option<&str>) -> Option<AgentUsage> {
    st.usage.clone()
        .or_else(|| st.message_usage.values().cloned().fold(None, |sum, u| add_usage(sum, Some(u))))
        .map(|u| u.or_model(model))
}

pub async fn run_claude(opts: RunOptions) -> RunResult {
    let bin = match opts.resolve_bin("claude") {
        Ok(b) => b,
        Err(e) => return RunResult::failed(format!("{e:#}")),
    };
    let tmp_dir = opts.cwd.join(CONTROL_DIR);
    let cmd = build_claude_command(opts.model.as_deref(), opts.effort.as_deref(), opts.service_tier.as_deref(), &opts.system_prompt, &opts.instruction, opts.resume_session.as_deref(), can_run_bare(&opts.env), opts.plan, opts.workspace.as_ref(), &opts.mcp, &bin, &tmp_dir);
    if let Err(e) = write_files(&cmd.files).await {
        return RunResult::failed(format!("{e:#}"));
    }

    let st = Arc::new(Mutex::new(ClaudeState::default()));
    let st2 = st.clone();
    let on_event = opts.on_event.clone();
    let on_usage = opts.on_usage.clone();
    let mut sent_usage = None;
    let model = opts.model.clone();
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
        report_usage(&on_usage, &mut sent_usage, claude_run_usage(&s, model.as_deref()));
        // The question is posted, or there are no tools: stop the agent instead of letting it ramble.
        std::mem::take(&mut s.should_stop)
    });
    let mut spawn = opts.spawn_options(cmd.stdin);
    spawn.env = with_tool_timeout(&opts.env);
    let outcome = match spawn_lines(&cmd.file, &cmd.args, spawn, handler).await {
        Ok(o) => o,
        Err(e) => return RunResult::failed(format!("{e:#}")),
    };

    let s = st.lock().unwrap().clone();
    let session = RunResult {
        session_id: s.session_id.clone().or_else(|| opts.resume_session.clone().filter(|_| s.started)),
        usage: claude_run_usage(&s, opts.model.as_deref()),
        ..Default::default()
    };
    if let Some(result) = cut_short(&s.texts, s.question.as_ref(), s.question_posted, &outcome, &session) {
        return result;
    }
    let mcp_failed = s.mcp_status.as_deref() == Some("failed");
    let ok = !mcp_failed && !s.result_is_error && (outcome.code == Some(0) || s.result.is_some());
    let summary = match s.result.as_deref() {
        Some(r) if !r.is_empty() => r.to_string(),
        _ => tail_summary(&s.texts),
    };
    let error = if ok {
        None
    } else if mcp_failed {
        Some(MCP_FAILED.into())
    } else if s.result_is_error {
        s.result.clone()
    } else {
        Some(exit_error("claude", &outcome))
    };
    RunResult { ok, summary, error, exit_code: outcome.code, resume_failed: !ok && opts.resume_session.is_some() && !s.started, ..session }
}
