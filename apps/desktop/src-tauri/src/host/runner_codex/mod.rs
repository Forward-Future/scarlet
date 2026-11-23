//! Run a Codex edit over App Server stdio, in a thread kept in the run's private Codex home so an answer or a resume
//! after a quit carries on in it. `codex exec --json`, whose threads are ephemeral, remains available when App Server
//! cannot use Scarlet's isolated configuration.

mod command;
mod events;
mod quota;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::util::{env_get, env_remove_ci, home_dir, now_iso};
use super::codex_app_server::run_app_server;
use super::detect::has_api_key;
use super::runner::{cut_short, exit_error, report_usage, write_files, RunOptions};
use super::spawn::spawn_lines;
use super::usage::AgentUsage;
use super::types::{tail_summary, PlanStep, RunResult};
use command::{app_server_args, build_codex_command, codex_executable};
use events::{app_server_events, parse_codex_line};
use quota::parse_codex_rate_limits_notification;

#[derive(Debug, Default, Clone)]
pub struct CodexState {
    pub texts: Vec<String>,
    pub last_message: Option<String>,
    final_message: Option<String>,
    pub question: Option<String>,
    /// The item of the question call `question` came from, which its result settles.
    question_item: Option<Value>,
    pub question_posted: bool,
    pub should_stop: bool,
    pub failed: Option<String>,
    /// The latest reconnect notice. Codex recovers from most, so it fails the run only if nothing else explains a failure.
    pub retry_notice: Option<String>,
    pub turn_completed: bool,
    pub usage: Option<AgentUsage>,
    turn_requested: bool,
    model: Option<String>,
    /// The thread this run works in: the session a later run of the same task resumes.
    thread_id: Option<String>,
    /// The plan last passed on, so one Codex repeats isn't sent twice.
    pub plan: Option<Vec<PlanStep>>,
    /// Whether this Codex reports a compaction as an item, so its older `thread/compacted` notice isn't a second one.
    compaction_items: bool,
    /// The run carries on in a thread an earlier run left (`thread/resume`).
    resumed: bool,
    /// What a resumed thread had counted before this run, taken off each count it reports: the engine adds one count
    /// per run, so a total that carried the earlier runs' tokens would count them twice.
    usage_base: Option<AgentUsage>,
}

/// The run's own Codex home, beside its task folder: outside the folder the agent may write to, and the same for every
/// attempt at the task (the folder is keyed by the run's first task id), so a run cut short or paused on a question
/// resumes its thread. The host removes it with the run's other leftovers once the task lands, and the task folders'
/// prune takes one left behind.
pub fn codex_home_dir(run_dir: &Path) -> std::path::PathBuf {
    let name = run_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    run_dir.with_file_name(format!("{name}.codex"))
}

/// App Server reads user configuration from CODEX_HOME. Give it a private directory
/// with the existing login and its write lock linked so Codex still owns token refreshes.
fn isolated_codex_home(opts: &RunOptions) -> std::result::Result<std::path::PathBuf, &'static str> {
    if has_api_key("codex", &opts.env) {
        return Err("api_key");
    }
    // A task must not be able to supply its own App Server configuration or MCP servers.
    match std::fs::symlink_metadata(opts.cwd.join(".codex")) {
        Ok(_) => return Err("project_config"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("isolation_unavailable"),
    }
    let codex_home = env_get(&opts.env, "CODEX_HOME").filter(|home| !home.is_empty()).map(std::path::PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"));
    let codex_home = opts.cwd.join(codex_home).canonicalize().map_err(|_| "home_unavailable")?;
    let auth = codex_home.join("auth.json");
    let metadata = auth.metadata().map_err(|_| "auth_unavailable")?;
    if !metadata.is_file() || metadata.len() == 0 { return Err("auth_unavailable"); }
    let home = codex_home_dir(&opts.cwd);
    crate::config::private_directory(&home).map_err(|_| "isolation_unavailable")?;
    // Only Scarlet writes configuration here. Codex's own state (its threads and their database) stays.
    for config in ["config.toml", "managed_config.toml"] {
        if std::fs::symlink_metadata(home.join(config)).is_ok() { return Err("isolation_unavailable"); }
    }
    #[cfg(unix)]
    use std::os::unix::fs::symlink as link_file;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_file as link_file;
    // Linked again on each run: the login may have moved since the last one.
    for (from, name) in [(auth, "auth.json"), (codex_home.join("auth.lock"), "auth.lock")] {
        let link = home.join(name);
        if std::fs::symlink_metadata(&link).is_ok() { std::fs::remove_file(&link).map_err(|_| "isolation_unavailable")?; }
        link_file(from, link).map_err(|_| "isolation_unavailable")?;
    }
    Ok(home)
}

async fn try_app_server(opts: &RunOptions, bin: &str, home: &Path) -> Option<RunResult> {
    let mut spawn = opts.spawn_options(None);
    env_remove_ci(&mut spawn.env, &["CODEX_HOME", "CODEX_SQLITE_HOME"]);
    spawn.env.insert("CODEX_HOME".into(), home.to_string_lossy().into_owned());
    // The child already starts in the task directory. Passing cwd explicitly on thread/start
    // can make Codex trust a project and load its local configuration.
    let thread = json!({ "model": opts.model, "serviceTier": opts.service_tier });
    let turn = json!({ "input": [{ "type": "text", "text": opts.instruction, "text_elements": [] }] });
    let st = Arc::new(Mutex::new(CodexState { resumed: opts.resume_session.is_some(), ..Default::default() }));
    let live_state = st.clone();
    let (on_event, on_usage, on_quota) = (opts.on_event.clone(), opts.on_usage.clone(), opts.on_quota.clone());
    let requested_model = opts.model.clone();
    let show_plan = opts.plan;
    let mut sent_usage = None;
    let executable = codex_executable(bin);
    let outcome = run_app_server(executable.as_deref().unwrap_or(bin), &app_server_args(opts, executable.as_deref()), spawn, thread, turn, Box::new(move |method, params| {
        if method == "account/rateLimits/updated" {
            if let (Some(sink), Some(quota)) = (&on_quota, parse_codex_rate_limits_notification(params, &now_iso())) {
                sink(quota);
            }
            return false;
        }
        let mut state = live_state.lock().unwrap();
        for event in app_server_events(method, params, &mut state) {
            if show_plan || event.kind != "plan" { on_event(event); }
        }
        report_usage(&on_usage, &mut sent_usage, state.usage.clone().map(|usage| usage.or_model(requested_model.as_deref())));
        std::mem::take(&mut state.should_stop)
    }), opts.resume_session.as_deref()).await;
    let mut state = std::mem::take(&mut *st.lock().unwrap());
    let outcome = match outcome {
        Ok(outcome) => outcome,
        // A thread that can't be resumed, here or by the fallback, which keeps none: the host starts a fresh run.
        Err(error) if opts.resume_session.is_some() && !state.turn_requested && !opts.cancel.is_cancelled() => {
            log_fallback(opts, super::codex_app_server::fallback_reason(&error));
            return Some(RunResult { resume_failed: true, error: Some(format!("{error:#}")), ..Default::default() });
        }
        Err(error) if !state.turn_requested && !opts.cancel.is_cancelled() => {
            log_fallback(opts, super::codex_app_server::fallback_reason(&error));
            return None;
        }
        Err(error) => {
            if state.failed.is_none() { state.failed = Some(format!("{error:#}")); }
            super::spawn::SpawnOutcome { aborted: opts.cancel.is_cancelled(), ..Default::default() }
        }
    };
    let last = state.final_message.take().or_else(|| state.last_message.take());
    Some(codex_result(state, opts.model.as_deref(), &outcome, last, false))
}

fn log_fallback(opts: &RunOptions, reason: &str) {
    let task = opts.task.as_deref().unwrap_or("none");
    let attempt = opts.mcp.env.get("SCARLET_TASK_STARTED_AT").map(String::as_str).unwrap_or("unknown");
    let level = if reason == "api_key" { log::Level::Info } else { log::Level::Warn };
    log::log!(level, "[host] codex-fallback task={task} attempt={attempt} reason={reason}");
}

pub async fn run_codex(mut opts: RunOptions) -> RunResult {
    opts.env.extend(opts.mcp.env.clone());
    let bin = match opts.resolve_bin("codex") {
        Ok(b) => b,
        Err(e) => return RunResult::failed(e.to_string()),
    };
    let tmp_dir = opts.cwd.join(".scarlet");
    let _ = tokio::fs::create_dir_all(&tmp_dir).await;
    let built = build_codex_command(opts.model.as_deref(), opts.effort.as_deref(), opts.service_tier.as_deref(), &opts.system_prompt, &opts.instruction, opts.plan, opts.workspace.as_ref(), &opts.mcp, &opts.cwd, &bin, &tmp_dir);
    if let Err(e) = write_files(&built.cmd.files).await {
        return RunResult::failed(e.to_string());
    }
    match isolated_codex_home(&opts) {
        Ok(home) => {
            if let Some(result) = try_app_server(&opts, &bin, &home).await {
                return result;
            }
        }
        Err(reason) => {
            log_fallback(&opts, reason);
            // `codex exec` keeps no thread to resume.
            if opts.resume_session.is_some() {
                return RunResult { resume_failed: true, error: Some(format!("Codex could not resume here: {reason}")), ..Default::default() };
            }
        }
    }
    let st = Arc::new(Mutex::new(CodexState::default()));
    let st2 = st.clone();
    let on_event = opts.on_event.clone();
    let on_usage = opts.on_usage.clone();
    let mut sent_usage = None;
    let handler = Box::new(move |line: &str| -> bool {
        let mut s = st2.lock().unwrap();
        for ev in parse_codex_line(line, &mut s) {
            on_event(ev);
        }
        report_usage(&on_usage, &mut sent_usage, s.usage.clone());
        std::mem::take(&mut s.should_stop)
    });
    let outcome = match spawn_lines(
        &built.cmd.file,
        &built.cmd.args,
        opts.spawn_options(built.cmd.stdin),
        handler,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return RunResult::failed(e.to_string()),
    };
    let s = st.lock().unwrap().clone();
    let mut last = s.last_message.clone();
    if let Ok(from_file) = tokio::fs::read_to_string(&built.last_message_path).await {
        let t = from_file.trim();
        if !t.is_empty() {
            last = Some(t.to_string());
        }
    }
    codex_result(s, opts.model.as_deref(), &outcome, last, true)
}

fn codex_result(s: CodexState, model: Option<&str>, outcome: &super::spawn::SpawnOutcome, last: Option<String>, allow_clean_exit: bool) -> RunResult {
    let usage = s.usage.map(|usage| usage.or_model(model));
    // A question carries the thread with it, so the answer resumes it.
    if let Some(result) = cut_short(&s.texts, s.question.as_ref(), s.question_posted, outcome, &RunResult { usage: usage.clone(), session_id: s.thread_id.clone(), ..Default::default() }) {
        return result;
    }
    let ok = s.failed.is_none() && (s.turn_completed || (allow_clean_exit && outcome.code == Some(0)));
    RunResult {
        ok,
        summary: last.unwrap_or_else(|| tail_summary(&s.texts)),
        error: if ok {
            None
        } else {
            Some(s.failed.clone().or_else(|| s.retry_notice.clone()).unwrap_or_else(|| exit_error("codex", outcome)))
        },
        exit_code: outcome.code,
        usage,
        session_id: s.thread_id.clone(),
        ..Default::default()
    }
}
