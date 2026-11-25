//! Single-task execution lifecycle on `HostRuntime`: workspace preparation, event
//! forwarding, live token reporting, completion retries, question delivery, and cleanup.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::api::{self, Api};
use super::detect;
use super::runner::{self, run_agent, RunOptions};
use super::runner_codex;
use super::runner_gemini;
use super::types::{self, CompleteTaskRequest, McpSpec, RunResult, RunnerEvent, Task, TaskEvent};
use super::usage;
use super::workspace::{self, real_path, remove_claude_sessions, remove_control_files, remove_token_file, TASKS_DIR};
use super::{HostRuntime, RunningTask};
use crate::util::{child_env, now_iso};

/// Save one event of a run with the engine, which shows it in the window.
async fn send_event(api: &Api, task_id: &str, started_at: Option<&str>, ev: &TaskEvent) {
    if let Err(e) = api.post_task_event(task_id, started_at, ev).await {
        log::warn!("task {task_id}: post event failed: {e}");
    }
}

pub(super) struct Prepared {
    pub(super) system_prompt: String,
    pub(super) instruction: String,
    pub(super) resume_session: Option<String>,
    pub(super) plan: bool,
    pub(super) refused_tool: Option<String>,
    /// The harness's own shell, file and web tools, for a request (`workspace` on the engine's prompt).
    pub(super) workspace: Option<types::Workspace>,
    pub(super) cwd: PathBuf,
    pub(super) mcp: McpSpec,
}

impl HostRuntime {
    async fn post_event(&self, task: &Task, kind: &str, text: String, data: Option<Value>) {
        let task_id = &task.id;
        let ev = TaskEvent { task_id: Some(task_id.to_string()), at: Some(now_iso()), kind: kind.to_string(), text, data };
        send_event(&self.api, task_id, task.started_at.as_deref(), &ev).await;
    }

    /// Where a run's events go: the sink its runner writes to, and the task that sends them on in order to the engine.
    /// An event's time is taken as the CLI writes it, not when its turn to be sent comes. Behind a slow engine a
    /// backlog would otherwise carry the one instant it was sent at, later than events the engine saved meanwhile.
    pub(super) fn forward_events(&self, task_id: &str, started_at: Option<String>) -> (runner::EventSink, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, RunnerEvent)>();
        let consumer = {
            let api = self.api.clone();
            let task_id = task_id.to_string();
            tokio::spawn(async move {
                while let Some((at, ev)) = rx.recv().await {
                    if ev.kind == "question" {
                        continue; // the MCP server posts the question event itself
                    }
                    if ev.kind == "result" {
                        continue; // summary goes in complete()
                    }
                    let tev = TaskEvent { task_id: Some(task_id.clone()), at: Some(at), kind: ev.kind.clone(), text: ev.text.clone(), data: ev.data.clone() };
                    send_event(&api, &task_id, started_at.as_deref(), &tev).await;
                }
            })
        };
        let sink: runner::EventSink = Arc::new(move |ev| {
            let _ = tx.send((now_iso(), ev));
        });
        (sink, consumer)
    }

    #[cfg(test)]
    pub(super) async fn complete(&self, task: &Task, state: &str, summary: Option<String>, error: Option<String>) {
        self.finish_attempt(task, state, summary, error, false, None).await
    }

    #[cfg(test)]
    pub(super) async fn finish(&self, task: &Task, state: &str, summary: Option<String>, error: Option<String>, stopped: bool) {
        self.finish_attempt(task, state, summary, error, stopped, None).await
    }

    pub(super) async fn complete_attempt(&self, task: &Task, state: &str, summary: Option<String>, error: Option<String>, run: Option<&Arc<RunningTask>>) {
        self.finish_attempt(task, state, summary, error, false, run).await
    }

    /// `stopped`: the host stopped the run before it finished. The editor can resume it from what it saved.
    async fn finish_attempt(&self, task: &Task, state: &str, summary: Option<String>, error: Option<String>, stopped: bool, run: Option<&Arc<RunningTask>>) {
        let task_id = &task.id;
        let interrupted = stopped || (state == "cancelled" && self.cancel.is_cancelled());
        let body = CompleteTaskRequest { state: state.into(), if_started_at: task.started_at.clone(), summary, error, interrupted, engine_lost: interrupted && self.engine_lost.load(Ordering::SeqCst) };
        // A post the engine misses is tried again. Forgotten here, the task stays running there until the engine
        // calls it interrupted and runs the finished request a second time. A copy does no harm: the engine ignores
        // the completion of an attempt it has already ended.
        let mut ack = None;
        for attempt in 1..=3 {
            match self.api.complete_task(task_id, &body).await {
                Ok(response) => {
                    ack = Some(response);
                    break;
                }
                Err(e) => log::warn!("complete failed for task {task_id}: {e}"),
            }
            if attempt == 3 {
                break;
            }
            // One try while the host stops: quitting doesn't wait on an engine that may already be gone.
            tokio::select! {
                _ = self.cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(250 * attempt)) => {}
            }
        }
        // A host stops when its engine goes. One started again stops it too, and the host started for it sends what
        // this one couldn't, as the work of a lost worker: a run whose own work crashes the engine stops resuming after
        // a few tries. When Scarlet quits there is none, and the engine recovers the run at the next launch.
        let landed = ack.is_some();
        let elapsed_ms = run
            .map(|r| r.started.elapsed().as_millis())
            .or_else(|| self.running.lock().unwrap().get(task_id).map(|r| r.started.elapsed().as_millis()))
            .unwrap_or_default();
        log_completion(task_id, &body, ack.as_ref(), elapsed_ms);
        let handover = (!landed && self.cancel.is_cancelled()).then_some(CompleteTaskRequest { engine_lost: true, ..body });
        let carries_on = ack.as_ref().is_some_and(|ack| ack.session_carries_on == Some(true));
        let dir = self.run_dir(task);
        if self.newer_attempt(task, run) {
            log::info!("task {task_id}: left its folder to a newer attempt at the same run");
            if let Some(body) = handover {
                self.undelivered.hand_over(task_id, body);
            }
            return;
        }
        // Resolve before the folder can go: Claude Code names its project folder after the real path.
        let real = if task.agent == "claude" || super::providers::is_extra_provider(&task.agent) { real_path(&dir) } else { None };
        if let Err(e) = remove_control_files(&dir) {
            log::warn!("task {task_id}: could not clean its folder: {e}");
        }
        // A run the host cut short keeps its CLI session: the attempt that resumes it carries on there.
        // So does one whose completion never landed: the engine takes it for interrupted and resumes it.
        // So does one the engine handed to a later attempt, as a pause does, though the host never stopped it.
        // The folder's prune removes it if nothing ever does.
        let session_stays = !landed || interrupted || carries_on;
        if let (Some(real), Some(claude_dir), false) = (real, self.claude_dir.as_deref(), session_stays) {
            if let Err(e) = remove_claude_sessions(&real, claude_dir) {
                log::warn!("task {task_id}: could not remove its Claude sessions: {e}");
            }
        }
        // A Codex run keeps its thread in a home beside the folder, on the same terms.
        let codex_home = runner_codex::codex_home_dir(&dir);
        if !session_stays && std::fs::symlink_metadata(&codex_home).is_ok_and(|m| m.is_dir()) {
            if let Err(e) = std::fs::remove_dir_all(&codex_home) {
                log::warn!("task {task_id}: could not remove its Codex home: {e}");
            }
        }
        // So does a Gemini run, in its own Gemini folder.
        let gemini_dir = runner_gemini::gemini_dir(&dir);
        if !session_stays && std::fs::symlink_metadata(&gemini_dir).is_ok_and(|m| m.is_dir()) {
            if let Err(e) = std::fs::remove_dir_all(&gemini_dir) {
                log::warn!("task {task_id}: could not remove its Gemini folder: {e}");
            }
        }
        // Handed over once its folder is clean: the attempt that resumes the run works in the same folder.
        if let Some(body) = handover {
            self.undelivered.hand_over(task_id, body);
        }
    }

    /// An attempt the editor stopped can still be winding down when the attempt that resumes it is at work in the
    /// folder they share. The folder and its CLI session are then the newer attempt's, to clean when it ends.
    fn newer_attempt(&self, task: &Task, run: Option<&Arc<RunningTask>>) -> bool {
        let dir = self.run_dir(task);
        let running = self.running.lock().unwrap();
        match run {
            Some(mine) => {
                mine.superseded.load(Ordering::SeqCst)
                    || running.values().any(|other| !Arc::ptr_eq(other, mine) && other.run_dir == dir && other.seq > mine.seq)
            }
            None => running
                .get(&task.id)
                .is_some_and(|mine| running.values().any(|other| other.run_dir == dir && other.seq > mine.seq)),
        }
    }

    /// Hand the editor the question the run stopped on. Once the engine has it the run is paused, not over: its
    /// folder and CLI session stay for the attempt that carries on with the answer, which writes its control files
    /// again. The file holding the engine token goes now, rather than at the folder's prune two weeks on.
    pub(super) async fn ask_editor(&self, task: &Task, question: &str, session_id: Option<&str>, cancel: &CancellationToken, run: Option<&Arc<RunningTask>>) {
        // Confirm with the engine even when a provider reported tool success.
        for attempt in 1..=3 {
            let posted = tokio::select! {
                _ = cancel.cancelled() => return,
                r = self.api.post_task_question(task, question, session_id) => r,
            };
            match posted {
                Ok(waiting) => {
                    log_question(task, if waiting { "waiting" } else { "not_waiting" });
                    if !self.newer_attempt(task, run) {
                        if let Err(e) = remove_token_file(&self.run_dir(task)) {
                            log::warn!("task {}: could not remove the file with its token: {e}", task.id);
                        }
                    }
                    return;
                }
                Err(e) if attempt == 3 => {
                    let error = format!("Could not deliver the editor question: {e}");
                    log_question(task, "undelivered");
                    log::warn!("task {}: {error}", task.id);
                    return self.complete_attempt(task, "failed", None, Some(error), run).await;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(250 * attempt)).await,
            }
        }
    }

    /// Record tokens for every outcome, including a cancel or a pause for a question.
    async fn record_usage(&self, task: &Task, usage: Option<&usage::AgentUsage>) {
        if let Some(usage) = usage {
            if let Err(e) = self.api.post_task_usage(&task.id, task.started_at.as_deref(), usage).await {
                log::warn!("task {}: usage report failed: {e}", task.id);
            }
        }
    }

    /// The folder a run works in. Every attempt at an interrupted run shares the first attempt's folder,
    /// so the attempt that resumes it finds its CLI session and artifacts there.
    pub(super) fn run_dir(&self, task: &Task) -> PathBuf {
        self.task_dir(&task.project_id, task.resume_root_id.as_deref().unwrap_or(&task.id))
    }

    /// One folder per task id, so a task resumed after a question finds its CLI session again.
    /// The native host only connects to its own engine data directory. Its
    /// loopback port may change when the app restarts between task attempts.
    pub(super) fn task_dir(&self, project_id: &str, task_id: &str) -> PathBuf {
        let scope = serde_json::to_vec(&[project_id, task_id]).expect("task scope");
        self.paths.work_dir.join(TASKS_DIR).join(format!("{:x}", Sha256::digest(scope)))
    }

    #[cfg(test)]
    pub async fn run_task(&self, task: Task, cancel: CancellationToken) {
        self.run_task_attempt(task, cancel, None, None).await
    }

    pub(super) async fn run_task_attempt(&self, task: Task, cancel: CancellationToken, run: Option<Arc<RunningTask>>, on_quota: Option<runner::QuotaSink>) {
        log::info!(
            "task {} ({}, {}{})",
            task.id,
            task.kind,
            task.agent,
            task.model.as_ref().map(|m| format!("/{m}")).unwrap_or_default()
        );
        if cancel.is_cancelled() {
            return self.complete_attempt(&task, "cancelled", None, Some("host shutting down".into()), run.as_ref()).await;
        }

        let prepared = match self.prepare(&task, false).await {
            Ok(p) => p,
            Err(e) => {
                self.post_event(&task, "error", format!("Could not prepare task: {e}"), None).await;
                return self.complete_attempt(&task, "failed", None, Some(e.to_string()), run.as_ref()).await;
            }
        };

        // Events: forwarded in order by a consumer task so completion waits for them.
        let (sink, consumer) = self.forward_events(&task.id, task.started_at.clone());

        let env = detect::runner_env(&task.agent, &self.agents.read().await, &self.agent_env());
        let model = task.model.clone().or_else(|| self.models.get(&task.agent).cloned());
        // Persist the start before the CLI can have side effects. A dead desktop's unstarted claim can be resumed.
        let start = TaskEvent { task_id: Some(task.id.clone()), at: Some(now_iso()), kind: "log".into(), text: "Starting the editing agent.".into(), data: None };
        if let Err(e) = self.api.post_task_event(&task.id, task.started_at.as_deref(), &start).await {
            return self.complete_attempt(&task, "failed", None, Some(e.to_string()), run.as_ref()).await;
        }
        // Tokens so far, sent to the engine while the agent works, for the count beside Stop.
        let live = LiveUsage::start(self.api.clone(), task.id.clone(), task.started_at.clone());
        let options = |p: Prepared| RunOptions {
            agent: task.agent.clone(),
            model: model.clone(),
            effort: task.effort.clone(),
            service_tier: task.service_tier.clone().or_else(|| task.fast.filter(|f| *f).map(|_| "fast".into())),
            system_prompt: p.system_prompt,
            instruction: p.instruction,
            resume_session: p.resume_session,
            plan: p.plan,
            refused_tool: p.refused_tool,
            workspace: p.workspace,
            cwd: p.cwd,
            mcp: p.mcp,
            on_event: sink.clone(),
            on_usage: Some(live.sink()),
            on_quota: on_quota.clone(),
            cancel: cancel.clone(),
            timeout: self.timeout,
            stall: self.stall,
            bin: None,
            env: env.clone(),
            task: Some(task.id.clone()),
        };
        let mut result = run_agent(options(prepared)).await;
        log::info!("task {}: {} ended (exit code {:?})", task.id, task.agent, result.exit_code);
        // One report per claim replaces the last, so a failed resume's tokens go with the fresh run's.
        let mut usage = result.usage.clone();
        if result.resume_failed && !cancel.is_cancelled() {
            // The CLI no longer has the session. Start over with the answers in the prompt.
            log::info!("task {}: could not resume the CLI session ({}); starting a fresh run", task.id, result.error.as_deref().unwrap_or("unknown"));
            match self.prepare(&task, true).await {
                Ok(p) => {
                    live.set_base(usage.clone());
                    result = run_agent(options(p)).await;
                    log::info!("task {}: {} ended (exit code {:?})", task.id, task.agent, result.exit_code);
                }
                Err(e) => {
                    drop(sink);
                    drain_events(&task.id, consumer).await;
                    live.stop().await;
                    self.record_usage(&task, usage.as_ref()).await;
                    self.post_event(&task, "error", format!("Could not prepare task: {e}"), None).await;
                    return self.complete_attempt(&task, "failed", None, Some(e.to_string()), run.as_ref()).await;
                }
            }
            usage = usage::add_usage(usage, result.usage.clone());
        }
        // Completion waits for the forwarded events.
        drop(sink);
        drain_events(&task.id, consumer).await;
        // The final report comes after the last live one, so it is the one the engine keeps.
        live.stop().await;
        // Record tokens for every outcome, including a cancel or a pause for a question.
        self.record_usage(&task, usage.as_ref()).await;

        match outcome(&result, cancel.is_cancelled(), self.timeout, self.stall) {
            Outcome::Cancelled { summary } => self.complete_attempt(&task, "cancelled", summary, Some("cancelled".into()), run.as_ref()).await,
            Outcome::Question(q) => self.ask_editor(&task, &q, result.session_id.as_deref(), &cancel, run.as_ref()).await,
            Outcome::Done { summary } => self.complete_attempt(&task, "done", Some(summary), None, run.as_ref()).await,
            Outcome::Failed { error, summary, stopped } => {
                self.post_event(&task, "error", error.clone(), None).await;
                self.finish_attempt(&task, "failed", summary, Some(error), stopped, run.as_ref()).await
            }
        }
    }

    /// Prepare the task folder, fetch the engine's prompt and build the MCP spec (mirrors host.ts `prepare`).
    /// `fresh` skips resuming the CLI session that asked a question.
    pub(super) async fn prepare(&self, task: &Task, fresh: bool) -> anyhow::Result<Prepared> {
        // Resumed attempts share the folder, its artifacts and its CLI session. Each gets its own MCP identity.
        let cwd = self.run_dir(task);
        crate::config::private_directory(&cwd)?;
        let artifacts = cwd.join("artifacts");
        crate::config::private_directory(&artifacts)?;
        let work_dir = artifacts.to_string_lossy().to_string();
        let prompt = self.api.task_prompt(&task.id, &work_dir, fresh, self.timeout).await?;

        let model = task.model.clone().or_else(|| self.models.get(&task.agent).cloned());
        let mut mcp = self.mcp.spec(&self.server, self.api.token().unwrap_or(""), &task.project_id, Some(&task.id), &task.agent, model.as_deref(), &work_dir);
        if let Some(started_at) = &task.started_at {
            mcp.env.insert("SCARLET_TASK_STARTED_AT".into(), started_at.clone());
        }
        // A request's agent gets its harness's own tools, and launchers for the programs this machine has. An engine from
        // before them leaves `workspace` out, and the run has Scarlet's tools only, as it did.
        let workspace = if prompt.workspace {
            Some(workspace::workspace_tools(&cwd, self.paths.resource_dir.as_deref(), &child_env(&self.paths.home))?)
        } else {
            None
        };
        Ok(Prepared { system_prompt: prompt.system_prompt, instruction: prompt.instruction, resume_session: prompt.resume_session, plan: prompt.plan, refused_tool: prompt.refused_tool, workspace, cwd, mcp })
    }
}

pub(super) fn log_completion(task_id: &str, request: &CompleteTaskRequest, ack: Option<&api::CompletionAck>, elapsed_ms: u128) {
    let state = ack.and_then(|ack| ack.state.as_deref()).filter(|state| {
        matches!(*state, "queued" | "claimed" | "running" | "waiting_for_user" | "done" | "failed" | "cancelled")
    });
    let superseded = request.if_started_at.as_deref().zip(ack.and_then(|ack| ack.started_at.as_deref()))
        .is_some_and(|(requested, saved)| requested != saved);
    let outcome = match (ack, state) {
        (None, _) => "undelivered",
        _ if superseded => "superseded",
        (Some(_), None) => "unconfirmed",
        (_, Some(state)) if state == request.state => "accepted",
        _ => "changed",
    };
    let level = if outcome == "undelivered" || state == Some("failed") { log::Level::Warn } else { log::Level::Info };
    let attempt = request.if_started_at.as_deref().unwrap_or("unknown");
    let changes = ack.map_or(0, |ack| ack.change_ids.len());
    // A failed run's reason stays in the local log: the engine may never have received it.
    let reason = if request.state == "failed" {
        let text = request.error.as_deref().unwrap_or("no reason given");
        format!(" reason={:?}", text.chars().take(300).collect::<String>())
    } else { String::new() };
    log::log!(level, "[host] completion task={task_id} attempt={attempt} requested={} state={} outcome={outcome} elapsedMs={elapsed_ms} changes={changes}{reason}",
        request.state, state.unwrap_or("unknown"));
}

fn log_question(task: &Task, outcome: &str) {
    let level = if outcome == "undelivered" { log::Level::Warn } else { log::Level::Info };
    let attempt = task.started_at.as_deref().unwrap_or("unknown");
    log::log!(level, "[host] question task={} attempt={attempt} outcome={outcome}", task.id);
}

/// What the host does with a run that has ended.
#[derive(Debug, PartialEq)]
pub(super) enum Outcome {
    Cancelled { summary: Option<String> },
    /// The agent asked the editor something: the task pauses, it doesn't complete.
    Question(String),
    Done { summary: String },
    /// `stopped`: the host cut the run short, so the editor can resume it from what it saved.
    Failed { error: String, summary: Option<String>, stopped: bool },
}

/// Read it off the runner's result. `cancelled`: the task or the host was stopped while it ran.
/// A question is the result's alone: the runner drops one the MCP server refused or that had no words, and a copy
/// kept from the CLI's output would post it to the editor all the same.
pub(super) fn outcome(result: &RunResult, cancelled: bool, timeout: Option<Duration>, stall: Option<Duration>) -> Outcome {
    let summary = (!result.summary.is_empty()).then(|| result.summary.clone());
    if cancelled || result.aborted {
        return Outcome::Cancelled { summary };
    }
    if let Some(question) = result.question.clone() {
        return Outcome::Question(question);
    }
    if result.ok {
        return Outcome::Done { summary: summary.unwrap_or_else(|| "Done.".into()) };
    }
    // Say why the host stopped it: a bare "timed out" reads like a stalled tool or network call.
    let error = match (result.stalled, result.timed_out, timeout) {
        (true, _, _) => stalled_reason(stall.unwrap_or_default()),
        (false, true, Some(limit)) => timed_out_reason(limit),
        _ => result.error.clone().unwrap_or_else(|| "agent failed".into()),
    };
    Outcome::Failed { error, summary, stopped: result.timed_out }
}

/// Completion waits for the events still on their way to the engine, but not for ever.
pub(super) async fn drain_events(task_id: &str, consumer: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(Duration::from_secs(30), consumer).await.is_err() {
        log::warn!("task {task_id}: its events were still being sent after 30 s; completing without the rest");
    }
}

fn minutes(d: Duration) -> String {
    let m = d.as_secs().div_ceil(60).max(1);
    format!("{m} minute{}", if m == 1 { "" } else { "s" })
}

/// The task error for a run stopped at the optional `timeout_minutes` cap. The app reads the minutes from it.
pub(super) fn timed_out_reason(limit: Duration) -> String {
    format!("timed out after {}, the limit for one agent run", minutes(limit))
}

/// The task error for a run stopped because its agent went silent. The app reads the minutes from it.
pub(super) fn stalled_reason(stall: Duration) -> String {
    format!("stalled: the agent wrote nothing for {}", minutes(stall))
}

/// A run's token count so far, sent to the engine at most every two seconds while the agent works. Each report
/// replaces the last for the same claim, as the final one does.
struct LiveUsage {
    base: Arc<StdMutex<Option<usage::AgentUsage>>>,
    latest: Arc<StdMutex<Option<usage::AgentUsage>>>,
    changed: Arc<tokio::sync::Notify>,
    done: CancellationToken,
    sender: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

impl LiveUsage {
    fn start(api: api::Api, task_id: String, started_at: Option<String>) -> Self {
        let latest: Arc<StdMutex<Option<usage::AgentUsage>>> = Arc::default();
        let changed = Arc::new(tokio::sync::Notify::new());
        let done = CancellationToken::new();
        let sender = {
            let (latest, changed, done) = (latest.clone(), changed.clone(), done.clone());
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = changed.notified() => {}
                        _ = done.cancelled() => break,
                    }
                    let Some(now) = latest.lock().unwrap().take() else { continue };
                    if let Err(e) = api.post_task_usage(&task_id, started_at.as_deref(), &now).await {
                        log::debug!("task {task_id}: live usage report failed: {e}");
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                        _ = done.cancelled() => break,
                    }
                }
            })
        };
        LiveUsage { base: Arc::default(), latest, changed, done, sender: StdMutex::new(Some(sender)) }
    }

    /// What the runner reports, added to the tokens of an earlier attempt in the same claim.
    fn sink(&self) -> runner::UsageSink {
        let (base, latest, changed) = (self.base.clone(), self.latest.clone(), self.changed.clone());
        Arc::new(move |u| {
            *latest.lock().unwrap() = usage::add_usage(base.lock().unwrap().clone(), Some(u));
            changed.notify_one();
        })
    }

    fn set_base(&self, base: Option<usage::AgentUsage>) {
        *self.base.lock().unwrap() = base;
    }

    /// Waits for a report in flight, so none lands after the final one.
    async fn stop(&self) {
        self.done.cancel();
        let sender = self.sender.lock().unwrap().take();
        if let Some(sender) = sender {
            let _ = sender.await;
        }
    }
}
