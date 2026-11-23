//! The local agent host (port of apps/agent/src/host.ts) running inside the app:
//! registers with the Scarlet server, heartbeats every 30 s, listens on the
//! WebSocket for `task.updated` wake-ups, long-polls `POST /hosts/:id/claim`
//! with the idle runtimes, runs each task through the matching CLI runner,
//! streams events to `POST /tasks/:id/events` and completes the task.
//! Up to `max_parallel` tasks per runtime (claude/codex/gemini) at once, so
//! several threads progress in parallel, and side checks (area and learning
//! checks) in slots of their own (`side_check_slots`), so a request never waits
//! behind itself for its checks; a run is stopped when its CLI goes
//! silent for `stall_minutes` (10), never for being slow unless `timeout_minutes` is set;
//! running tasks are cancelled (completed as `cancelled`) on app exit.
//! The engine builds the prompt (`GET /tasks/:id/prompt`); this host only runs it.

pub mod api;
mod catalog;
mod codex_app_server;
pub mod detect;
pub mod install;
pub mod login;
mod process_guard;
pub mod runner;
pub mod runner_claude;
pub mod runner_codex;
pub mod runner_gemini;
pub mod spawn;
mod task_runner;
#[cfg(test)]
mod tests;
pub mod types;
pub mod usage;
mod workspace;

pub use catalog::McpLauncher;
pub use workspace::{
    claude_config_dir, claude_project_dir, prune_task_dirs, remove_claude_sessions, remove_control_files,
    remove_token_file,
};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;

use crate::config::{AppConfig, Paths};
use crate::util::{child_env, human_duration};
use api::Api;
use catalog::{describe_agents, lacks_models, take_catalog, CATALOG_RETRY_WAITS};
use task_runner::log_completion;
use types::{AgentAvailability, CompleteTaskRequest, SubscriptionQuota, Task, CLI_AGENTS};
use workspace::TASKS_DIR;

/// How long cached subscription quota stays fresh before a non-forced refresh re-probes.
const QUOTA_TTL: Duration = Duration::from_secs(60);

/// How often the host sends a heartbeat to the engine.
const HEARTBEAT_EVERY: Duration = Duration::from_secs(30);

/// Subscriptions only: omit quota when a provider is signed in via API key or not signed in.
fn is_quota_eligible(agent: &AgentAvailability) -> bool {
    CLI_AGENTS.contains(&agent.id.as_str())
        && agent.installed
        && agent.logged_in != Some(false)
        && agent.auth.as_deref() != Some("api_key")
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub host_id: Option<String>,
    pub agents: Vec<AgentAvailability>,
    pub running: Vec<String>,
    pub connected: bool,
    pub server_url: Option<String>,
    pub name: Option<String>,
    pub error: Option<String>,
    pub mcp_command: Option<String>,
    pub configured: bool,
}

fn platform_string() -> String {
    format!("{} {} (Scarlet desktop)", std::env::consts::OS, std::env::consts::ARCH)
}

fn host_name() -> String {
    let h = hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_else(|_| "scarlet-desktop".into());
    format!("{h} (desktop)")
}

/// Persists the host id the server assigned for a given server URL.
pub type HostIdSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Completions a stopping host couldn't give the engine because the engine had gone. A crashed engine is started
/// again, and the host started for it sends them once it has registered, so a run the crash cut short carries on at
/// once. Left unsent, the engine takes the run for still under way until its worker has been silent for 90 seconds.
#[derive(Default)]
struct Undelivered {
    completions: StdMutex<Vec<(String, CompleteTaskRequest)>>,
    added: Notify,
}

impl Undelivered {
    fn hand_over(&self, task_id: &str, body: CompleteTaskRequest) {
        log::info!("task {task_id}: its completion waits for the engine to come back");
        self.completions.lock().unwrap().push((task_id.to_string(), body));
        self.added.notify_one();
    }
}

/// Sends an event to the window. A closure, so the run loop can be tested without a window.
type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

static NEXT_RUN_SEQ: AtomicU64 = AtomicU64::new(1);

struct RunningTask {
    project_id: String,
    agent: String,
    cancel: CancellationToken,
    /// For the run time in the completion log line.
    started: std::time::Instant,
    /// Monotonic claim order so overlapping attempts in the same folder do not depend on timer resolution.
    seq: u64,
    /// Set when a newer claim for the same task id replaces this attempt in `running`.
    superseded: AtomicBool,
    /// The folder it works in. Every attempt at one run shares it.
    run_dir: PathBuf,
    /// A side check, counted in the side-check slots rather than the request slots.
    side_check: bool,
}

impl RunningTask {
    fn new(project_id: String, agent: String, cancel: CancellationToken, run_dir: PathBuf) -> Self {
        Self {
            project_id,
            agent,
            cancel,
            started: std::time::Instant::now(),
            seq: NEXT_RUN_SEQ.fetch_add(1, Ordering::SeqCst),
            superseded: AtomicBool::new(false),
            run_dir,
            side_check: false,
        }
    }

    fn side_check(mut self, yes: bool) -> Self {
        self.side_check = yes;
        self
    }
}

/// A short check beside a request that saves nothing to the video (`isSideCheck` in packages/shared/src/tasks.ts).
fn is_side_check(kind: &str) -> bool {
    matches!(kind, "learning_check" | "area_check" | "listen_check")
}

/// Side checks run at once per runtime beside `max_parallel` requests (`sideCheckSlots` in packages/shared/src/tasks.ts).
fn side_check_slots(max_parallel: usize) -> usize {
    (2 * max_parallel.max(1)).min(12)
}

type RunningTasks = StdMutex<HashMap<String, Arc<RunningTask>>>;

async fn heartbeat_workers(api: &Api, host_id: &str, agents: &[AgentAvailability], running: &RunningTasks) -> Result<(), api::ApiError> {
    let ids: Vec<_> = running.lock().unwrap().keys().cloned().collect();
    let cancelled = api.heartbeat(host_id, agents, &ids).await?;
    let workers = running.lock().unwrap();
    for id in cancelled {
        if let Some(run) = workers.get(&id) { run.cancel.cancel(); }
    }
    Ok(())
}

pub struct HostRuntime {
    emit: Emit,
    api: Api,
    server: String,
    name: String,
    cancel: CancellationToken,
    /// The host is stopping because its engine went away, not because Scarlet quits. A run it cuts short is then a
    /// lost worker's, also when the engine is back in time to hear so from this host.
    engine_lost: AtomicBool,
    agents: RwLock<Vec<AgentAvailability>>,
    detecting: Mutex<()>,
    quota_refreshing: Mutex<()>,
    last_quota_at: StdMutex<Option<std::time::Instant>>,
    running: RunningTasks,
    host_id: StdMutex<Option<String>>,
    connected: AtomicBool,
    wake: Notify,
    subscriptions_changed: Notify,
    paths: Paths,
    /// Where Claude Code keeps its sessions (`claude_config_dir`). None: nowhere Scarlet can tell, so they are left.
    claude_dir: Option<PathBuf>,
    mcp: McpLauncher,
    models: HashMap<String, String>,
    /// Optional cap on one run. None: a working agent takes as long as it needs.
    timeout: Option<Duration>,
    /// A run whose CLI writes nothing for this long is stopped, and can be resumed.
    stall: Option<Duration>,
    /** How many tasks each agent runtime may run at once. */
    max_parallel: usize,
    last_error: StdMutex<Option<String>>,
    on_host_id: HostIdSink,
    /// Shared by every runtime the manager starts: one stopping hands its completions to the next.
    undelivered: Arc<Undelivered>,
}

impl HostRuntime {
    fn status(&self) -> HostStatus {
        HostStatus {
            host_id: self.host_id.lock().unwrap().clone(),
            agents: self.agents.try_read().map(|a| a.clone()).unwrap_or_default(),
            running: self.running.lock().unwrap().keys().cloned().collect(),
            connected: self.connected.load(Ordering::SeqCst),
            server_url: Some(self.server.clone()),
            name: Some(self.name.clone()),
            error: self.last_error.lock().unwrap().clone(),
            mcp_command: Some(self.mcp.describe()),
            configured: true,
        }
    }

    /// The status with the assistants as they are now. `status` gives none while they are being written.
    async fn full_status(&self) -> HostStatus {
        let mut s = self.status();
        s.agents = self.agents.read().await.clone();
        s
    }

    fn emit_status(&self) {
        (self.emit)("host://status", serde_json::to_value(self.status()).unwrap_or_default());
    }

    fn set_error(&self, e: Option<String>) {
        *self.last_error.lock().unwrap() = e;
        self.emit_status();
    }

    /// The engine answered. The error an earlier call left in Settings is over, whichever call that was.
    fn reached(&self) {
        let was = self.connected.swap(true, Ordering::SeqCst);
        // A call that failed at the same moment may have left its error after this one last cleared it.
        let stale = self.last_error.lock().unwrap().is_some();
        if !was || stale {
            self.set_error(None);
        }
    }

    /// Startup, sign-in and the picker can all request a fresh snapshot.
    async fn detect_agents(&self, env: &HashMap<String, String>) -> Option<String> {
        let _detecting = self.detecting.lock().await;
        let mut found = detect::detect(env, &self.paths.home, &self.models).await;
        self.mcp.load_catalogs(&mut found, env, &self.paths.custom_claude_models(), &self.paths.custom_gemini_models()).await;
        log::info!("assistants: {}", describe_agents(&found));
        let mut agents = self.agents.write().await;
        let mut failed = Vec::new();
        for agent in found.iter_mut() {
            if is_quota_eligible(agent) {
                if let Some(old) = agents.iter().find(|a| a.id == agent.id) {
                    agent.quota = old.quota.clone();
                    if agent.plan.is_none() {
                        agent.plan = old.plan.clone();
                    }
                }
            } else {
                agent.quota = None;
            }
            if lacks_models(agent) {
                // A successful empty list replaces the old one. A failed probe keeps the last catalog the editor could use.
                if let Some(old) = agents.iter().find(|a| a.id == agent.id && a.models.is_some()) {
                    take_catalog(agent, old.model.clone(), old.model_options.clone(), old.models.clone(), old.model_labels.clone());
                }
                failed.push(match agent.id.as_str() {
                    "claude" => "Claude Code", "codex" => "Codex", "gemini" => "Gemini", id => id,
                });
            }
        }
        let error = (!failed.is_empty()).then(|| format!("Couldn't refresh models for {}. Try again.", failed.join(", ")));
        *agents = found;
        error
    }

    /// Probe subscription quota for eligible providers (cached with a 60 s TTL unless `force` is true).
    async fn refresh_quota(&self, force: bool, only: Option<&[&str]>) -> HostStatus {
        let _refreshing = self.quota_refreshing.lock().await;
        if self.cancel.is_cancelled() {
            return self.full_status().await;
        }
        let current = self.agents.read().await.clone();
        let targets: Vec<AgentAvailability> = current
            .iter()
            .filter(|a| is_quota_eligible(a) && only.is_none_or(|ids| ids.contains(&a.id.as_str())))
            .cloned()
            .collect();
        if !force && only.is_none() {
            let fresh = self.last_quota_at.lock().unwrap().is_some_and(|at| at.elapsed() < QUOTA_TTL);
            let all_loaded = targets.iter().all(|a| a.quota.is_some());
            if fresh && all_loaded {
                return self.full_status().await;
            }
        }
        if targets.is_empty() {
            return self.full_status().await;
        }
        let env = child_env(&self.paths.home);
        let results = self.mcp.load_quotas(&targets, &env).await;
        if self.cancel.is_cancelled() {
            return self.full_status().await;
        }
        let mut changed = false;
        {
            let mut agents = self.agents.write().await;
            for agent in agents.iter_mut() {
                if !is_quota_eligible(agent) {
                    if agent.quota.take().is_some() {
                        changed = true;
                    }
                    continue;
                }
                if let Some((_, quota)) = results.iter().find(|(id, _)| id == &agent.id) {
                    if agent.plan.is_none() {
                        agent.plan = quota.plan.clone();
                    }
                    agent.quota = Some(quota.clone());
                    changed = true;
                }
            }
        }
        if only.is_none() {
            *self.last_quota_at.lock().unwrap() = Some(std::time::Instant::now());
        }
        if changed {
            self.heartbeat().await;
            self.emit_status();
        }
        self.full_status().await
    }

    /// Apply a live quota update streamed during an active run (e.g. Codex `account/rateLimits/updated`).
    fn apply_live_quota(self: &Arc<Self>, agent_id: &str, quota: SubscriptionQuota) {
        let me = self.clone();
        let id = agent_id.to_string();
        tauri::async_runtime::spawn(async move {
            if me.cancel.is_cancelled() {
                return;
            }
            let updated = {
                let mut agents = me.agents.write().await;
                let Some(agent) = agents.iter_mut().find(|a| a.id == id && is_quota_eligible(a)) else {
                    return;
                };
                if agent.plan.is_none() {
                    agent.plan = quota.plan.clone();
                }
                agent.quota = Some(quota);
                true
            };
            if updated {
                me.heartbeat().await;
                me.emit_status();
            }
        });
    }

    // -- registration & heartbeat -------------------------------------------

    async fn register(&self) -> Result<(), api::ApiError> {
        let agents = self.agents.read().await.clone();
        let host = self.api.register_host(&self.name, &platform_string(), &agents).await?;
        *self.host_id.lock().unwrap() = Some(host.id.clone());
        (self.on_host_id)(&self.server, &host.id);
        self.connected.store(true, Ordering::SeqCst);
        log::info!(
            "host registered as {} ({}); agents: {}",
            host.id,
            self.name,
            agents.iter().filter(|a| a.installed).map(|a| a.id.as_str()).collect::<Vec<_>>().join(", ")
        );
        self.set_error(None);
        Ok(())
    }

    async fn heartbeat(&self) {
        let Some(id) = self.host_id.lock().unwrap().clone() else { return };
        let agents = self.agents.read().await.clone();
        match heartbeat_workers(&self.api, &id, &agents, &self.running).await {
            Ok(()) => self.reached(),
            Err(e) => self.lost("heartbeat", &e).await,
        }
    }

    /// A call to the engine failed: say so in Settings, and register again when the engine no longer knows this host.
    async fn lost(&self, what: &str, e: &api::ApiError) {
        log::warn!("{what} failed: {e}");
        self.connected.store(false, Ordering::SeqCst);
        self.set_error(Some(format!("{what} failed: {e}")));
        // Host may have been forgotten by a restarted server: re-register.
        if e.is_status(404) {
            if let Err(e2) = self.register().await {
                log::warn!("re-register failed: {e2}");
            }
        }
    }

    /// Send the completions the host before this one couldn't, as soon as this one has registered, and those it
    /// hands over later, as its runs wind down. The engine resumes a run cut short as soon as it hears of it.
    async fn deliver_loop(self: Arc<Self>) {
        loop {
            if self.cancel.is_cancelled() {
                return;
            }
            let completions = std::mem::take(&mut *self.undelivered.completions.lock().unwrap());
            for (task_id, body) in completions {
                match self.api.complete_task(&task_id, &body).await {
                    Ok(ack) => log_completion(&task_id, &body, Some(&ack), 0),
                    // Gone again: the host started for the next engine sends it.
                    Err(e) if e.status.is_none() => {
                        log::warn!("complete failed for task {task_id}: {e}");
                        self.undelivered.completions.lock().unwrap().push((task_id, body));
                    }
                    Err(e) => log::warn!("complete failed for task {task_id}: {e}"),
                }
            }
            tokio::select! {
                _ = self.cancel.cancelled() => return,
                _ = self.undelivered.added.notified() => {}
            }
        }
    }

    async fn heartbeat_loop(self: Arc<Self>, every: Duration) {
        let mut tick = tokio::time::interval(every);
        // After sleep (where Windows' monotonic clock keeps counting) or a stalled call, send one wake heartbeat
        // and resume the cadence instead of bursting every missed tick back to back.
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => return,
                _ = tick.tick() => self.heartbeat().await,
            }
        }
    }

    /// Ask again for the model list of each assistant that has none. True while one is still without.
    async fn load_missing_catalogs(&self) -> bool {
        let mut asked: Vec<AgentAvailability> = self.agents.read().await.iter().filter(|a| lacks_models(a)).cloned().collect();
        if asked.is_empty() {
            return false;
        }
        self.mcp.load_catalogs(&mut asked, &child_env(&self.paths.home), &self.paths.custom_claude_models(), &self.paths.custom_gemini_models()).await;
        let (read, left, assistants) = {
            let mut agents = self.agents.write().await;
            let mut read = false;
            for found in asked.into_iter().filter(|a| a.models.is_some()) {
                // A refresh or a sign-in that finished meanwhile has the newer answer. Only an assistant still
                // without a list takes this one.
                let Some(agent) = agents.iter_mut().find(|a| a.id == found.id && lacks_models(a)) else { continue };
                take_catalog(agent, found.model, found.model_options, found.models, found.model_labels);
                read = true;
            }
            (read, agents.iter().any(lacks_models), describe_agents(&agents))
        };
        // A host that has stopped tells nobody: its engine may be gone, and the window shows the host after it.
        if read && !self.cancel.is_cancelled() {
            log::info!("model list read on a later try; assistants: {assistants}");
            self.heartbeat().await;
            self.wake.notify_one();
            self.emit_status();
        }
        left
    }

    /// A model list that could not be read at launch is asked for again after each of `waits`. With none, the
    /// picker offers no model for the assistant, and nothing can be sent to it until Refresh models or a restart.
    /// Ends once no assistant is without a list, or when the host stops.
    async fn catalog_loop(self: Arc<Self>, waits: &'static [Duration]) {
        for wait in waits {
            tokio::select! {
                _ = self.cancel.cancelled() => return,
                _ = tokio::time::sleep(*wait) => {}
            }
            if !self.load_missing_catalogs().await {
                return;
            }
        }
    }

    // -- websocket wake-ups ---------------------------------------------------

    async fn ws_loop(self: Arc<Self>) {
        loop {
            if self.cancel.is_cancelled() {
                return;
            }
            match tokio_tungstenite::connect_async(self.api.ws_url()).await {
                Ok((mut ws, _)) => {
                    log::info!("host ws connected");
                    // Watch the projects claimed by this host, including claims made after connecting.
                    let mut subscribed = HashSet::<String>::new();
                    let mut refresh = true;
                    'socket: loop {
                        if refresh {
                            let active: HashSet<String> = self.running.lock().unwrap().values().map(|run| run.project_id.clone()).collect();
                            for (action, ids) in [("subscribe", active.difference(&subscribed)), ("unsubscribe", subscribed.difference(&active))] {
                                for id in ids {
                                    let message = json!({"type": action, "projectId": id}).to_string();
                                    if ws.send(tokio_tungstenite::tungstenite::Message::Text(message.into())).await.is_err() { break 'socket; }
                                }
                            }
                            subscribed = active;
                            refresh = false;
                        }
                        tokio::select! {
                            _ = self.cancel.cancelled() => { let _ = ws.close(None).await; return; }
                            _ = self.subscriptions_changed.notified() => refresh = true,
                            msg = ws.next() => {
                                match msg {
                                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                                        if let Ok(v) = serde_json::from_str::<Value>(t.as_ref()) {
                                            let kind = v.get("type").and_then(Value::as_str);
                                            if kind == Some("project.subscribed") {
                                                // The subscription is live. Recover any cancellation that preceded it.
                                                self.heartbeat().await;
                                            } else if kind == Some("host.quota_refresh") {
                                                let force = v.get("force").and_then(Value::as_bool).unwrap_or(false);
                                                let me = self.clone();
                                                tauri::async_runtime::spawn(async move {
                                                    let _ = me.refresh_quota(force, None).await;
                                                });
                                            } else if kind == Some("task.updated") {
                                                let task = v.get("task");
                                                let state = task.and_then(|t| t.get("state")).and_then(Value::as_str);
                                                let id = task.and_then(|t| t.get("id")).and_then(Value::as_str);
                                                match state {
                                                    Some("queued") => self.wake.notify_one(),
                                                    // Cancelled from the UI while running here: stop the CLI (completes as cancelled).
                                                    Some("cancelled") => {
                                                        if let Some(id) = id {
                                                            if let Some(run) = self.running.lock().unwrap().get(id) { run.cancel.cancel(); }
                                                        }
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        }
                                    }
                                    Some(Ok(_)) => {}
                                    Some(Err(e)) => { log::warn!("host ws error: {e}"); break; }
                                    None => break,
                                }
                            }
                        }
                    }
                    log::info!("host ws closed");
                }
                Err(e) => log::warn!("host ws connect failed: {e}"),
            }
            tokio::select! {
                _ = self.cancel.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        }
    }

    // -- claim loop -----------------------------------------------------------

    /// Runtimes with a free request slot (fewer than `max_parallel` requests running), and whether any is full.
    async fn idle_agents(&self) -> (Vec<String>, bool) {
        self.free_slots(false, self.max_parallel).await
    }

    /// Runtimes with a free side-check slot, and whether any is full.
    async fn check_agents(&self) -> (Vec<String>, bool) {
        self.free_slots(true, side_check_slots(self.max_parallel)).await
    }

    async fn free_slots(&self, side_check: bool, limit: usize) -> (Vec<String>, bool) {
        let mut running: HashMap<String, usize> = HashMap::new();
        for r in self.running.lock().unwrap().values().filter(|r| r.side_check == side_check) {
            *running.entry(r.agent.clone()).or_default() += 1;
        }
        let agents = self.agents.read().await;
        let mut idle = Vec::new();
        let mut saturated = false;
        for agent in agents.iter().filter(|a| a.installed && a.logged_in != Some(false) && CLI_AGENTS.contains(&a.id.as_str())) {
            if running.get(&agent.id).copied().unwrap_or(0) < limit {
                idle.push(agent.id.clone());
            } else {
                saturated = true;
            }
        }
        (idle, saturated)
    }

    async fn sleep_or_wake(&self, d: Duration) {
        tokio::select! {
            _ = self.cancel.cancelled() => {}
            _ = self.wake.notified() => {}
            _ = tokio::time::sleep(d) => {}
        }
    }

    async fn claim_loop(self: Arc<Self>) {
        const WAIT: u64 = 25;
        while !self.cancel.is_cancelled() {
            let (idle, saturated) = self.idle_agents().await;
            let (checks, checks_full) = self.check_agents().await;
            let saturated = saturated || checks_full;
            if idle.is_empty() && checks.is_empty() {
                self.sleep_or_wake(Duration::from_secs(5)).await;
                continue;
            }
            let Some(host_id) = self.host_id.lock().unwrap().clone() else {
                self.sleep_or_wake(Duration::from_secs(5)).await;
                continue;
            };
            let claimed = tokio::select! {
                _ = self.cancel.cancelled() => break,
                // When a runtime is full, wait locally so its worker can wake us with fresh capacity.
                r = self.api.claim(&host_id, if saturated { 0 } else { WAIT }, &idle, &checks) => r,
            };
            match claimed {
                Ok(Some(task)) => {
                    self.reached();
                    self.clone().launch(task);
                }
                Ok(None) => {
                    self.reached();
                    self.sleep_or_wake(Duration::from_secs(1)).await;
                }
                Err(e) => {
                    if self.cancel.is_cancelled() {
                        break;
                    }
                    self.lost("claim", &e).await;
                    self.sleep_or_wake(Duration::from_secs(5)).await;
                }
            }
        }
    }

    fn launch(self: Arc<Self>, task: Task) {
        let cancel = self.cancel.child_token();
        let run = Arc::new(RunningTask::new(task.project_id.clone(), task.agent.clone(), cancel.clone(), self.run_dir(&task))
            .side_check(is_side_check(&task.kind)));
        if let Some(previous) = self.running.lock().unwrap().insert(task.id.clone(), run.clone()) {
            previous.superseded.store(true, Ordering::SeqCst);
            previous.cancel.cancel();
        }
        self.subscriptions_changed.notify_one();
        self.emit_status();
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let id = task.id.clone();
            let agent = task.agent.clone();
            let live_host = me.clone();
            let live_agent = agent.clone();
            let on_quota: runner::QuotaSink = Arc::new(move |quota| {
                live_host.apply_live_quota(&live_agent, quota);
            });
            me.run_task_attempt(task, cancel, Some(run.clone()), Some(on_quota)).await;
            // An immediate editor answer can launch the next claim before this run has returned.
            {
                let mut running = me.running.lock().unwrap();
                if running.get(&id).is_some_and(|active| Arc::ptr_eq(active, &run)) {
                    running.remove(&id);
                }
            }
            me.subscriptions_changed.notify_one();
            me.wake.notify_one();
            me.emit_status();
            // A side check is small and many finish together: the request they belong to reads the quota when it ends.
            if !me.cancel.is_cancelled() && !run.side_check {
                let bg = me.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = bg.refresh_quota(true, Some(&[agent.as_str()])).await;
                });
            }
        });
    }

    async fn run(self: Arc<Self>) {
        let tasks_root = self.paths.work_dir.join(TASKS_DIR);
        let pids = self.paths.work_dir.join("agent-pids");
        let claude_dir = self.claude_dir.clone();
        let cleanup = tokio::task::spawn_blocking(move || {
            spawn::stop_orphans(&pids);
            prune_task_dirs(&tasks_root, std::time::SystemTime::now(), claude_dir.as_deref());
        });
        let env = child_env(&self.paths.home);
        let _ = tokio::join!(self.detect_agents(&env), cleanup);
        self.emit_status();
        // Register (retry until it works or we are stopped).
        let mut delay = 2u64;
        loop {
            if self.cancel.is_cancelled() {
                return;
            }
            match self.register().await {
                Ok(()) => break,
                Err(e) => {
                    log::warn!("host register failed: {e}");
                    self.connected.store(false, Ordering::SeqCst);
                    self.set_error(Some(format!("register failed: {e}")));
                    tokio::select! {
                        _ = self.cancel.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                    }
                    delay = (delay * 2).min(30);
                }
            }
        }
        self.emit_status();
        tauri::async_runtime::spawn(self.clone().deliver_loop());
        tauri::async_runtime::spawn(self.clone().heartbeat_loop(HEARTBEAT_EVERY));
        tauri::async_runtime::spawn(self.clone().ws_loop());
        tauri::async_runtime::spawn(self.clone().catalog_loop(&CATALOG_RETRY_WAITS));
        {
            let bg = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = bg.refresh_quota(false, None).await;
            });
        }
        self.clone().claim_loop().await;
    }

    /// Cancel running tasks (they complete as cancelled) and stop the loops.
    async fn stop(&self) {
        log::info!("agent host stopping ({} running)", self.running.lock().unwrap().len());
        self.cancel.cancel();
        self.wake.notify_one();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !self.running.lock().unwrap().is_empty() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let left: Vec<String> = self.running.lock().unwrap().keys().cloned().collect();
        if !left.is_empty() {
            log::warn!("still running 15 s after the stop: {}; ending their CLIs", left.join(", "));
        }
        // Nothing an agent started may outlive the app.
        let _ = tokio::task::spawn_blocking(spawn::kill_stopped_now).await;
        self.connected.store(false, Ordering::SeqCst);
    }
}

/// Owns the current runtime; `configure` swaps it when the server/token change.
pub struct HostManager {
    app: AppHandle,
    paths: Paths,
    config: Arc<StdMutex<AppConfig>>,
    mcp: StdMutex<Option<McpLauncher>>,
    runtime: Mutex<Option<Arc<HostRuntime>>>,
    undelivered: Arc<Undelivered>,
}

impl HostManager {
    pub fn new(app: AppHandle, paths: Paths, config: Arc<StdMutex<AppConfig>>, mcp: Option<McpLauncher>) -> Self {
        HostManager { app, paths, config, mcp: StdMutex::new(mcp), runtime: Mutex::new(None), undelivered: Arc::default() }
    }

    pub async fn status(&self) -> HostStatus {
        match self.runtime.lock().await.as_ref() {
            Some(rt) => rt.full_status().await,
            None => HostStatus { mcp_command: self.mcp.lock().unwrap().as_ref().map(|m| m.describe()), ..Default::default() },
        }
    }

    /// Start (or restart) the host against the local engine at `server` with its access `token`.
    pub async fn configure(&self, server: &str, token: &str) {
        let server = server.trim_end_matches('/').to_string();
        let token = token.to_string();
        {
            let guard = self.runtime.lock().await;
            if let Some(rt) = guard.as_ref() {
                if rt.server == server && rt.api.token() == Some(token.as_str()) && !rt.cancel.is_cancelled() {
                    return; // unchanged
                }
            }
        }
        self.stop().await;
        let Some(mcp) = self.mcp.lock().unwrap().clone() else {
            log::error!("host not started: no MCP launcher (engine binary missing)");
            let _ = self.app.emit("host://status", &HostStatus { error: Some("engine binary missing; agent host disabled".into()), ..Default::default() });
            return;
        };
        let (models, (timeout, stall), max_parallel) = {
            let cfg = self.config.lock().unwrap();
            (cfg.models.clone(), run_limits(&cfg), cfg.max_parallel.unwrap_or(4).clamp(1, 8))
        };
        let config = self.config.clone();
        let cfg_path = self.paths.config_file.clone();
        let on_host_id: HostIdSink = Arc::new(move |server: &str, id: &str| {
            let mut cfg = config.lock().unwrap();
            if remember_host_id(&mut cfg, server, id) {
                if let Err(e) = cfg.save(&cfg_path) {
                    log::warn!("could not save {}: {e:#}", cfg_path.display());
                }
            }
        });
        let app = self.app.clone();
        let emit: Emit = Arc::new(move |event, payload| {
            let _ = app.emit(event, payload);
        });
        let rt = Arc::new(HostRuntime {
            emit,
            api: Api::new(&server, Some(&token)),
            server: server.clone(),
            name: host_name(),
            cancel: CancellationToken::new(),
            engine_lost: AtomicBool::new(false),
            agents: RwLock::new(Vec::new()),
            detecting: Mutex::new(()),
            quota_refreshing: Mutex::new(()),
            last_quota_at: StdMutex::new(None),
            running: StdMutex::new(HashMap::new()),
            host_id: StdMutex::new(None),
            connected: AtomicBool::new(false),
            wake: Notify::new(),
            subscriptions_changed: Notify::new(),
            paths: self.paths.clone(),
            claude_dir: claude_config_dir(&crate::util::env_map(), &self.paths.home),
            mcp,
            models,
            timeout,
            stall,
            max_parallel,
            last_error: StdMutex::new(None),
            on_host_id,
            undelivered: self.undelivered.clone(),
        });
        let limit = |d: Option<Duration>| d.map(human_duration).unwrap_or_else(|| "off".into());
        log::info!("agent host starting for {server} ({max_parallel} at once per assistant; stall limit {}; run limit {})", limit(stall), limit(timeout));
        *self.runtime.lock().await = Some(rt.clone());
        rt.emit_status();
        tauri::async_runtime::spawn(rt.run());
    }

    pub async fn stop(&self) {
        self.stop_as(false).await
    }

    /// Stop because the engine went away by itself. A run cut short by that counts as a lost worker: an engine back
    /// before the run's CLI has stopped would otherwise take it for a quit, and a run whose own work brings the
    /// engine down would carry on without end.
    pub async fn stop_for_lost_engine(&self) {
        self.stop_as(true).await
    }

    async fn stop_as(&self, engine_lost: bool) {
        let rt = self.runtime.lock().await.take();
        if let Some(rt) = rt {
            rt.engine_lost.store(engine_lost, Ordering::SeqCst);
            rt.stop().await;
            // A host started for the next engine while this one wound down has already said how it stands.
            if self.runtime.lock().await.is_none() {
                let _ = self.app.emit("host://status", &HostStatus { mcp_command: Some(rt.mcp.describe()), ..Default::default() });
            }
        }
    }

    pub fn stop_blocking(&self) {
        tauri::async_runtime::block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(20), self.stop()).await;
        });
    }

    /// Re-detect installed CLIs and push the result to the server.
    pub async fn refresh_agents(&self) -> HostStatus {
        let rt = self.runtime.lock().await.clone();
        let env = child_env(&self.paths.home);
        let mut status = match rt {
            Some(rt) => {
                let catalog_error = rt.detect_agents(&env).await;
                rt.heartbeat().await;
                rt.wake.notify_one();
                rt.emit_status();
                let bg = rt.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = bg.refresh_quota(true, None).await;
                });
                let mut status = rt.full_status().await;
                status.error = status.error.or(catalog_error);
                status
            }
            None => {
                let models = self.config.lock().unwrap().models.clone();
                let mut agents = detect::detect(&env, &self.paths.home, &models).await;
                let mcp = self.mcp.lock().unwrap().clone();
                if let Some(launcher) = &mcp { launcher.load_catalogs(&mut agents, &env, &self.paths.custom_claude_models(), &self.paths.custom_gemini_models()).await; }
                HostStatus { agents, mcp_command: mcp.as_ref().map(|m| m.describe()), ..Default::default() }
            }
        };
        if !status.connected && status.error.is_none() {
            status.error = Some("The local agent host is offline. Try again when it connects.".into());
        }
        status
    }

    /// Refresh subscription quota for eligible providers (non-blocking cache unless `force` is true).
    pub async fn refresh_quota(&self, force: bool) -> HostStatus {
        let rt = self.runtime.lock().await.clone();
        match rt {
            Some(rt) => rt.refresh_quota(force, None).await,
            None => self.status().await,
        }
    }
}

/// Five times the longest silence measured across real editing runs (1.9 minutes).
const DEFAULT_STALL_MINUTES: u64 = 10;

/// The run limit and the stall limit from desktop.json (`timeoutMinutes`, `stallMinutes`).
/// 0 turns a limit off, as it does in the standalone host.
fn run_limits(cfg: &AppConfig) -> (Option<Duration>, Option<Duration>) {
    let minutes = |m: u64| (m > 0).then(|| Duration::from_secs(m.saturating_mul(60)));
    (cfg.timeout_minutes.and_then(minutes), minutes(cfg.stall_minutes.unwrap_or(DEFAULT_STALL_MINUTES)))
}

/// Note the host id the engine assigned. True when desktop.json has to be saved.
/// The engine takes a new port at each launch, so an id filed under another address is never asked for again.
fn remember_host_id(cfg: &mut AppConfig, server: &str, id: &str) -> bool {
    if cfg.host_ids.len() == 1 && cfg.host_ids.get(server).map(String::as_str) == Some(id) {
        return false;
    }
    cfg.host_ids.clear();
    cfg.host_ids.insert(server.to_string(), id.to_string());
    true
}
