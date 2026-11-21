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
mod codex_app_server;
pub mod detect;
pub mod install;
pub mod login;
pub mod runner;
pub mod runner_claude;
pub mod runner_codex;
pub mod runner_gemini;
pub mod spawn;
pub mod types;
pub mod usage;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;

use crate::config::{AppConfig, Paths};
use crate::engine::EngineLaunch;
use crate::util::{child_env, human_duration, now_iso};
use api::Api;
use runner::{run_agent, RunOptions};
use types::{AgentAvailability, CompleteTaskRequest, McpSpec, RunResult, RunnerEvent, Task, TaskEvent, CLI_AGENTS};

/// The folder under the work folder that holds one folder for each run.
const TASKS_DIR: &str = "tasks-v2";

/// Finished task folders keep their artifacts this long.
const TASK_DIR_DAYS: u64 = 14;

/// How long the host waits before each new try at a model list it could not read at launch: 30 seconds after it
/// registers, then 1, 2 and 5 minutes on.
const CATALOG_RETRY_WAITS: [Duration; 4] = [Duration::from_secs(30), Duration::from_secs(60), Duration::from_secs(120), Duration::from_secs(300)];

/// How to launch the Scarlet MCP stdio server: `<program> <prefix…> mcp --server … --project …`.
#[derive(Debug, Clone)]
pub struct McpLauncher {
    pub program: String,
    pub prefix_args: Vec<String>,
}

impl McpLauncher {
    pub fn from_engine(l: &EngineLaunch) -> Self {
        McpLauncher { program: l.program.clone(), prefix_args: l.prefix_args.clone() }
    }

    pub fn describe(&self) -> String {
        let mut p = vec![self.program.clone()];
        p.extend(self.prefix_args.iter().cloned());
        p.push("mcp".into());
        p.join(" ")
    }

    /// Use the same provider catalog protocol as a standalone Scarlet agent host.
    /// `extra_claude` and `extra_gemini` add model IDs the CLI accepts but does not list, with the default entry's options.
    async fn load_catalogs(&self, agents: &mut [AgentAvailability], env: &HashMap<String, String>, extra_claude: &[String], extra_gemini: &[String]) {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Catalog {
            models: Vec<String>,
            model: Option<String>,
            model_labels: BTreeMap<String, String>,
            model_options: BTreeMap<String, Value>,
        }

        let probes = agents.iter().filter(|a| a.installed && a.logged_in != Some(false)).map(|a| async move {
            let Some(file) = spawn::find_on_path(detect::cli_binary(&a.id), env) else {
                log::warn!("[host] model-catalog provider={} reason=cli_unavailable", a.id);
                return None;
            };
            let mut args = self.prefix_args.clone();
            args.extend(["model-catalog".into(), a.id.clone(), file]);
            let probe_env = detect::runner_env(&a.id, std::slice::from_ref(a), env);
            let result = spawn::exec_capture(&self.program, &args, &probe_env, Duration::from_secs(12)).await;
            if result.code != Some(0) {
                let prefix = format!("[models] {}: ", a.id);
                let reason = result.stderr.lines().filter_map(|line| line.strip_prefix(&prefix))
                    .find(|reason| matches!(*reason, "initialize_failed" | "request_failed" | "invalid_response" | "repeated_cursor" |
                        "timed_out" | "process_failed" | "incomplete_response"))
                    .unwrap_or(if result.stderr.trim() == "timed out" { "timed_out" } else { "process_failed" });
                log::warn!("[host] model-catalog provider={} reason={reason}", a.id);
                return None;
            }
            let catalog = serde_json::from_str::<Catalog>(&result.stdout)
                .map_err(|_| log::warn!("[host] model-catalog provider={} reason=invalid_response", a.id)).ok()?;
            Some((a.id.clone(), catalog))
        });
        for (id, mut catalog) in futures_util::future::join_all(probes).await.into_iter().flatten() {
            let extras = match id.as_str() {
                "claude" => extra_claude,
                "gemini" => extra_gemini,
                _ => &[],
            };
            let default_opts = catalog
                .model_options
                .get("")
                .or_else(|| catalog.model.as_ref().and_then(|m| catalog.model_options.get(m)))
                .cloned();
            for m in extras.iter().filter(|m| !m.is_empty()) {
                if catalog.models.contains(m) { continue; }
                catalog.models.push(m.clone());
                catalog.model_labels.entry(m.clone()).or_insert_with(|| m.clone());
                if let Some(ref o) = default_opts { catalog.model_options.entry(m.clone()).or_insert_with(|| o.clone()); }
            }
            if let Some(a) = agents.iter_mut().find(|a| a.id == id) {
                take_catalog(a, catalog.model, catalog.model_options, Some(catalog.models), catalog.model_labels);
            }
        }
    }

    /// Build the per-task MCP spec written into the CLI's MCP config.
    #[allow(clippy::too_many_arguments)]
    pub fn spec(&self, server: &str, token: &str, project_id: &str, task_id: Option<&str>, agent: &str, model: Option<&str>, work_dir: &str) -> McpSpec {
        let mut args = self.prefix_args.clone();
        args.push("mcp".into());
        let mut env = BTreeMap::new();
        env.insert("SCARLET_SERVER".into(), server.to_string());
        env.insert("SCARLET_TOKEN".into(), token.to_string());
        env.insert("SCARLET_PROJECT".into(), project_id.to_string());
        if let Some(t) = task_id {
            env.insert("SCARLET_TASK".into(), t.to_string());
        }
        env.insert("SCARLET_AGENT".into(), agent.to_string());
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            env.insert("SCARLET_MODEL".into(), m.to_string());
        }
        env.insert("SCARLET_WORKDIR".into(), work_dir.to_string());
        McpSpec { command: self.program.clone(), args, env }
    }
}

/// Give an assistant the model list read for it. A model it already has, from the settings, stays its default.
fn take_catalog(agent: &mut AgentAvailability, model: Option<String>, options: BTreeMap<String, Value>, models: Option<Vec<String>>, labels: BTreeMap<String, String>) {
    if agent.model.is_none() { agent.model = model; }
    agent.model_options = options;
    agent.models = models;
    agent.model_labels = labels;
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

/// A finished task keeps only its artifacts. The CLI control files include the engine token.
pub fn remove_control_files(dir: &Path) -> std::io::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    let mut artifacts = false;
    for entry in entries.flatten() {
        if entry.file_name() == "artifacts" {
            artifacts = true;
        } else if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    if !artifacts {
        std::fs::remove_dir(dir)?;
    }
    Ok(())
}

/// Claude Code keeps a cwd's sessions in ~/.claude/projects/<real cwd with every
/// character other than a letter or digit as "-">. Names over 200 characters get
/// a hash suffix we can't reproduce, so those are left alone.
pub fn claude_project_dir(real_cwd: &Path, home: &Path) -> Option<PathBuf> {
    let name: String = real_cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    (name.len() <= 200 && name.chars().any(|c| c.is_ascii_alphanumeric())).then(|| home.join(".claude").join("projects").join(name))
}

/// Delete the Claude sessions of one finished Scarlet task: only the project folder named after its task folder,
/// and the to-do list of each session in it.
pub fn remove_claude_sessions(real_cwd: &Path, home: &Path) -> std::io::Result<()> {
    if !real_cwd.parent().and_then(Path::file_name).is_some_and(|n| n == TASKS_DIR) {
        return Ok(());
    }
    let Some(dir) = claude_project_dir(real_cwd, home) else { return Ok(()) };
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {
            // Claude Code keeps a session's to-do list apart from it, in ~/.claude/tasks/<session id>, and a session
            // is `<session id>.jsonl` here. Only a name of hex digits and dashes is read as an id: "...jsonl" would
            // name ~/.claude itself. A list that can't be removed is left.
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let name = entry.file_name();
                let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".jsonl")) else { continue };
                if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                    continue;
                }
                let list = home.join(".claude").join("tasks").join(id);
                if std::fs::symlink_metadata(&list).is_ok_and(|m| m.is_dir()) {
                    let _ = std::fs::remove_dir_all(&list);
                }
            }
            std::fs::remove_dir_all(&dir)
        }
        _ => Ok(()),
    }
}

/// The path Claude Code sees as its cwd. Windows canonical paths carry a `\\?\` prefix Claude never shows.
fn real_path(dir: &Path) -> Option<PathBuf> {
    if cfg!(windows) { Some(dir.to_path_buf()) } else { std::fs::canonicalize(dir).ok() }
}

/// Last use of a task folder: the folder, its artifacts folder or a file directly in it.
fn last_used(dir: &Path) -> Option<std::time::SystemTime> {
    let meta = std::fs::metadata(dir).ok().filter(|m| m.is_dir())?;
    let artifacts = dir.join("artifacts");
    let files = std::fs::read_dir(&artifacts).into_iter().flatten().flatten().map(|e| e.path());
    std::iter::once(artifacts.clone()).chain(files).filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok()).chain(meta.modified().ok()).max()
}

/// Remove task folders unused for `TASK_DIR_DAYS`, including artifacts.
pub fn prune_task_dirs(tasks_root: &Path, now: std::time::SystemTime, home: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(tasks_root) else { return };
    let max_age = Duration::from_secs(TASK_DIR_DAYS * 86_400);
    for entry in entries.flatten() {
        let old = last_used(&entry.path()).and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > max_age);
        if old {
            // A run that never finished left its Claude sessions behind. They go with its folder.
            if let (Some(home), Some(real)) = (home, real_path(&entry.path())) {
                if let Err(e) = remove_claude_sessions(&real, home) {
                    log::warn!("could not remove Claude sessions of {}: {e}", entry.path().display());
                }
            }
            if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                log::warn!("could not prune task folder {}: {e}", entry.path().display());
            }
        }
    }
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

/// A short check beside a request that saves nothing to the video (`isSideCheck` in packages/shared/src/api.ts).
fn is_side_check(kind: &str) -> bool {
    matches!(kind, "learning_check" | "area_check")
}

/// Side checks run at once per runtime beside `max_parallel` requests (`sideCheckSlots` in packages/shared/src/api.ts).
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

/// Save one event of a run with the engine, which shows it in the window.
async fn send_event(api: &Api, task_id: &str, started_at: Option<&str>, ev: &TaskEvent) {
    if let Err(e) = api.post_task_event(task_id, started_at, ev).await {
        log::warn!("task {task_id}: post event failed: {e}");
    }
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
    running: RunningTasks,
    host_id: StdMutex<Option<String>>,
    connected: AtomicBool,
    wake: Notify,
    subscriptions_changed: Notify,
    paths: Paths,
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
        for agent in found.iter_mut().filter(|a| lacks_models(a)) {
            // A successful empty list replaces the old one. A failed probe keeps the last catalog the editor could use.
            if let Some(old) = agents.iter().find(|a| a.id == agent.id && a.models.is_some()) {
                take_catalog(agent, old.model.clone(), old.model_options.clone(), old.models.clone(), old.model_labels.clone());
            }
            failed.push(match agent.id.as_str() {
                "claude" => "Claude Code", "codex" => "Codex", "gemini" => "Gemini", id => id,
            });
        }
        let error = (!failed.is_empty()).then(|| format!("Couldn't refresh models for {}. Try again.", failed.join(", ")));
        *agents = found;
        error
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

    async fn heartbeat_loop(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
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
            me.run_task_attempt(task, cancel, Some(run.clone())).await;
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
        });
    }

    // -- running one task -----------------------------------------------------

    async fn post_event(&self, task: &Task, kind: &str, text: String, data: Option<Value>) {
        let task_id = &task.id;
        let ev = TaskEvent { task_id: Some(task_id.to_string()), at: Some(now_iso()), kind: kind.to_string(), text, data };
        send_event(&self.api, task_id, task.started_at.as_deref(), &ev).await;
    }

    /// Where a run's events go: the sink its runner writes to, the task that sends them on in order to the
    /// engine, and a question the CLI's output carried.
    /// An event's time is taken as the CLI writes it, not when its turn to be sent comes. Behind a slow engine a
    /// backlog would otherwise carry the one instant it was sent at, later than events the engine saved meanwhile.
    fn forward_events(&self, task_id: &str, started_at: Option<String>) -> (runner::EventSink, tokio::task::JoinHandle<()>, Arc<StdMutex<Option<String>>>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, RunnerEvent)>();
        let question_seen: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let consumer = {
            let api = self.api.clone();
            let task_id = task_id.to_string();
            let qs = question_seen.clone();
            tokio::spawn(async move {
                while let Some((at, ev)) = rx.recv().await {
                    if ev.kind == "question" {
                        *qs.lock().unwrap() = Some(ev.text.clone());
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
        (sink, consumer, question_seen)
    }

    #[cfg(test)]
    async fn complete(&self, task: &Task, state: &str, summary: Option<String>, error: Option<String>) {
        self.finish_attempt(task, state, summary, error, false, None).await
    }

    #[cfg(test)]
    async fn finish(&self, task: &Task, state: &str, summary: Option<String>, error: Option<String>, stopped: bool) {
        self.finish_attempt(task, state, summary, error, stopped, None).await
    }

    async fn complete_attempt(&self, task: &Task, state: &str, summary: Option<String>, error: Option<String>, run: Option<&Arc<RunningTask>>) {
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
        let dir = self.run_dir(task);
        // An attempt the editor stopped can still be winding down when the attempt that resumes it is at work in
        // the folder they share. The folder and its CLI session are then the newer attempt's, to clean when it ends.
        let newer = {
            let running = self.running.lock().unwrap();
            match run {
                Some(mine) => {
                    mine.superseded.load(Ordering::SeqCst)
                        || running.values().any(|other| !Arc::ptr_eq(other, mine) && other.run_dir == dir && other.seq > mine.seq)
                }
                None => running
                    .get(task_id)
                    .is_some_and(|mine| running.values().any(|other| other.run_dir == dir && other.seq > mine.seq)),
            }
        };
        if newer {
            log::info!("task {task_id}: left its folder to a newer attempt at the same run");
            if let Some(body) = handover {
                self.undelivered.hand_over(task_id, body);
            }
            return;
        }
        // Resolve before the folder can go: Claude Code names its project folder after the real path.
        let real = if task.agent == "claude" { real_path(&dir) } else { None };
        if let Err(e) = remove_control_files(&dir) {
            log::warn!("task {task_id}: could not clean its folder: {e}");
        }
        // A run the host cut short keeps its CLI session: the attempt that resumes it carries on there.
        // So does one whose completion never landed: the engine takes it for interrupted and resumes it.
        // The folder's prune removes it if nothing ever does.
        if let Some(real) = real.filter(|_| landed && !interrupted && !child_env(&self.paths.home).contains_key("CLAUDE_CONFIG_DIR")) {
            if let Err(e) = remove_claude_sessions(&real, &self.paths.home) {
                log::warn!("task {task_id}: could not remove its Claude sessions: {e}");
            }
        }
        // A Codex run keeps its thread in a home beside the folder, on the same terms.
        let codex_home = runner_codex::codex_home_dir(&dir);
        if landed && !interrupted && std::fs::symlink_metadata(&codex_home).is_ok_and(|m| m.is_dir()) {
            if let Err(e) = std::fs::remove_dir_all(&codex_home) {
                log::warn!("task {task_id}: could not remove its Codex home: {e}");
            }
        }
        // Handed over once its folder is clean: the attempt that resumes the run works in the same folder.
        if let Some(body) = handover {
            self.undelivered.hand_over(task_id, body);
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
    fn run_dir(&self, task: &Task) -> PathBuf {
        self.task_dir(&task.project_id, task.resume_root_id.as_deref().unwrap_or(&task.id))
    }

    /// One folder per task id, so a task resumed after a question finds its CLI session again.
    /// The native host only connects to its own engine data directory. Its
    /// loopback port may change when the app restarts between task attempts.
    fn task_dir(&self, project_id: &str, task_id: &str) -> PathBuf {
        let scope = serde_json::to_vec(&[project_id, task_id]).expect("task scope");
        self.paths.work_dir.join(TASKS_DIR).join(format!("{:x}", Sha256::digest(scope)))
    }

    pub async fn run_task(&self, task: Task, cancel: CancellationToken) {
        self.run_task_attempt(task, cancel, None).await
    }

    async fn run_task_attempt(&self, task: Task, cancel: CancellationToken, run: Option<Arc<RunningTask>>) {
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
        let (sink, consumer, question_seen) = self.forward_events(&task.id, task.started_at.clone());

        let env = detect::runner_env(&task.agent, &self.agents.read().await, &child_env(&self.paths.home));
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
            cwd: p.cwd,
            mcp: p.mcp,
            on_event: sink.clone(),
            on_usage: Some(live.sink()),
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

        let question_seen = question_seen.lock().unwrap().clone();
        match outcome(&result, cancel.is_cancelled(), question_seen, self.timeout, self.stall) {
            Outcome::Cancelled { summary } => self.complete_attempt(&task, "cancelled", summary, Some("cancelled".into()), run.as_ref()).await,
            Outcome::Question(q) => {
                // Confirm with the engine even when a provider reported tool success.
                for attempt in 1..=3 {
                    let posted = tokio::select! {
                        _ = cancel.cancelled() => return,
                        r = self.api.post_task_question(&task, &q, result.session_id.as_deref()) => r,
                    };
                    match posted {
                        Ok(waiting) => {
                            log_question(&task, if waiting { "waiting" } else { "not_waiting" });
                            return;
                        }
                        Err(e) if attempt == 3 => {
                            let error = format!("Could not deliver the editor question: {e}");
                            log_question(&task, "undelivered");
                            log::warn!("task {}: {error}", task.id);
                            return self.complete_attempt(&task, "failed", None, Some(error), run.as_ref()).await;
                        }
                        Err(_) => tokio::time::sleep(Duration::from_millis(250 * attempt)).await,
                    }
                }
            }
            Outcome::Done { summary } => self.complete_attempt(&task, "done", Some(summary), None, run.as_ref()).await,
            Outcome::Failed { error, summary, stopped } => {
                self.post_event(&task, "error", error.clone(), None).await;
                self.finish_attempt(&task, "failed", summary, Some(error), stopped, run.as_ref()).await
            }
        }
    }

    /// Prepare the task folder, fetch the engine's prompt and build the MCP spec (mirrors host.ts `prepare`).
    /// `fresh` skips resuming the CLI session that asked a question.
    async fn prepare(&self, task: &Task, fresh: bool) -> anyhow::Result<Prepared> {
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
        Ok(Prepared { system_prompt: prompt.system_prompt, instruction: prompt.instruction, resume_session: prompt.resume_session, plan: prompt.plan, cwd, mcp })
    }

    async fn run(self: Arc<Self>) {
        let tasks_root = self.paths.work_dir.join(TASKS_DIR);
        let pids = self.paths.work_dir.join("agent-pids");
        let home = (!child_env(&self.paths.home).contains_key("CLAUDE_CONFIG_DIR")).then(|| self.paths.home.clone());
        let cleanup = tokio::task::spawn_blocking(move || {
            spawn::stop_orphans(&pids);
            prune_task_dirs(&tasks_root, std::time::SystemTime::now(), home.as_deref());
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
        tauri::async_runtime::spawn(self.clone().heartbeat_loop());
        tauri::async_runtime::spawn(self.clone().ws_loop());
        tauri::async_runtime::spawn(self.clone().catalog_loop(&CATALOG_RETRY_WAITS));
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

fn log_completion(task_id: &str, request: &CompleteTaskRequest, ack: Option<&api::CompletionAck>, elapsed_ms: u128) {
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
enum Outcome {
    Cancelled { summary: Option<String> },
    /// The agent asked the editor something: the task pauses, it doesn't complete.
    Question(String),
    Done { summary: String },
    /// `stopped`: the host cut the run short, so the editor can resume it from what it saved.
    Failed { error: String, summary: Option<String>, stopped: bool },
}

/// Read it off the runner's result. `cancelled`: the task or the host was stopped while it ran.
/// `question_seen`: a question the CLI's output carried that the result does not.
fn outcome(result: &RunResult, cancelled: bool, question_seen: Option<String>, timeout: Option<Duration>, stall: Option<Duration>) -> Outcome {
    let summary = (!result.summary.is_empty()).then(|| result.summary.clone());
    if cancelled || result.aborted {
        return Outcome::Cancelled { summary };
    }
    if let Some(question) = result.question.clone().or(question_seen) {
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
async fn drain_events(task_id: &str, consumer: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(Duration::from_secs(30), consumer).await.is_err() {
        log::warn!("task {task_id}: its events were still being sent after 30 s; completing without the rest");
    }
}

/// An assistant that could run a task and has no model list: the picker offers no model for it, so nothing can be
/// sent to it.
fn lacks_models(agent: &AgentAvailability) -> bool {
    agent.installed && agent.logged_in != Some(false) && agent.models.is_none()
}

/// What detection found, on one log line: "claude 2.1.3 (signed in, subscription, 4 models); codex not installed".
fn describe_agents(agents: &[AgentAvailability]) -> String {
    let one = |a: &AgentAvailability| {
        if !a.installed {
            return format!("{} not installed", a.id);
        }
        let version = a.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default();
        let signed = if a.logged_in == Some(false) { "signed out" } else { "signed in" };
        let auth = a.auth.as_deref().map(|auth| format!(", {auth}")).unwrap_or_default();
        let models = a.models.as_ref().map(|m| format!(", {} models", m.len())).unwrap_or_else(|| ", no model list".into());
        format!("{}{version} ({signed}{auth}{models})", a.id)
    };
    agents.iter().map(one).collect::<Vec<_>>().join("; ")
}

struct Prepared {
    system_prompt: String,
    instruction: String,
    resume_session: Option<String>,
    plan: bool,
    cwd: PathBuf,
    mcp: McpSpec,
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
            (cfg.models.clone(), run_limits(&cfg), cfg.max_parallel.unwrap_or(3).clamp(1, 8))
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
            running: StdMutex::new(HashMap::new()),
            host_id: StdMutex::new(None),
            connected: AtomicBool::new(false),
            wake: Notify::new(),
            subscriptions_changed: Notify::new(),
            paths: self.paths.clone(),
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

fn minutes(d: Duration) -> String {
    let m = d.as_secs().div_ceil(60).max(1);
    format!("{m} minute{}", if m == 1 { "" } else { "s" })
}

/// The task error for a run stopped at the optional `timeout_minutes` cap. The app reads the minutes from it.
fn timed_out_reason(limit: Duration) -> String {
    format!("timed out after {}, the limit for one agent run", minutes(limit))
}

/// The task error for a run stopped because its agent went silent. The app reads the minutes from it.
fn stalled_reason(stall: Duration) -> String {
    format!("stalled: the agent wrote nothing for {}", minutes(stall))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host runtime with no window and no CLIs, talking to `server`. The second value is every event it sent
    /// to the window.
    fn runtime(server: &str, work_root: &Path) -> (Arc<HostRuntime>, Arc<StdMutex<Vec<(String, Value)>>>) {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let record = sent.clone();
        let rt = Arc::new(HostRuntime {
            emit: Arc::new(move |event, payload| record.lock().unwrap().push((event.to_string(), payload))),
            api: Api::new(server, Some("sct_test")),
            server: server.to_string(),
            name: "test (desktop)".into(),
            cancel: CancellationToken::new(),
            engine_lost: AtomicBool::new(false),
            agents: RwLock::new(Vec::new()),
            detecting: Mutex::new(()),
            running: StdMutex::new(HashMap::new()),
            host_id: StdMutex::new(Some("host_1".into())),
            connected: AtomicBool::new(false),
            wake: Notify::new(),
            subscriptions_changed: Notify::new(),
            paths: Paths {
                config_file: work_root.join("desktop.json"), work_dir: work_root.to_owned(), home: work_root.join("home"),
                data_dir: work_root.join("data"), log_dir: work_root.join("logs"), resource_dir: None,
            },
            mcp: McpLauncher { program: "scarlet-engine".into(), prefix_args: vec![] },
            models: HashMap::new(),
            timeout: None,
            stall: Some(Duration::from_secs(600)),
            max_parallel: 1,
            last_error: StdMutex::new(None),
            on_host_id: Arc::new(|_, _| {}),
            undelivered: Arc::default(),
        });
        (rt, sent)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refreshes_model_catalogs_and_keeps_only_the_catalogs_that_failed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (mut rt, _) = runtime("http://127.0.0.1:1", dir.path());
        Arc::get_mut(&mut rt).unwrap().mcp = McpLauncher {
            program: "/bin/sh".into(), prefix_args: vec!["-c".into(), r#"/bin/cat "$2.catalog""#.into()],
        };
        let env = HashMap::from([("PATH".to_string(), dir.path().to_string_lossy().into_owned())]);
        let put = |name: &str, text: &str| std::fs::write(dir.path().join(name), text).unwrap();
        for id in ["claude", "codex"] {
            put(id, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.2.3; else /bin/cat \"$0.status\"; fi\n");
            std::fs::set_permissions(dir.path().join(id), std::fs::Permissions::from_mode(0o700)).unwrap();
            put(&format!("{id}.catalog"), r#"{"models":["example"],"model":"example","modelLabels":{"example":"Example"},"modelOptions":{"example":{"efforts":[],"speeds":[]}}}"#);
        }
        put("claude.status", r#"{"loggedIn":true,"authMethod":"claude.ai"}"#);
        put("codex.status", "Logged in using ChatGPT");
        put("custom-claude-models.json", r#"["first-custom"]"#);
        assert_eq!(rt.detect_agents(&env).await, None);
        let first = rt.agents.read().await.clone();
        assert_eq!(first[0].models.as_ref().unwrap(), &["example", "first-custom"]);
        assert_eq!(first[1].model.as_deref(), Some("example"));

        put("custom-claude-models.json", r#"["next-custom"]"#);
        put("codex.catalog", "null"); // The engine received no catalog from this CLI.
        assert_eq!(rt.detect_agents(&env).await.as_deref(), Some("Couldn't refresh models for Codex. Try again."));
        let second = rt.agents.read().await.clone();
        assert_eq!(second[0].models.as_ref().unwrap(), &["example", "next-custom"]);
        assert_eq!(second[1], first[1]); // Retain its IDs, labels, options and default.

        put("codex.catalog", r#"{"models":[],"modelLabels":{},"modelOptions":{}}"#);
        put("claude.status", r#"{"loggedIn":false}"#);
        assert_eq!(rt.detect_agents(&env).await, None);
        let third = rt.agents.read().await.clone();
        assert_eq!((third[0].logged_in, &third[0].models), (Some(false), &None));
        assert_eq!(third[1].models, Some(Vec::new()));
        assert!(third[1].model.is_none() && third[1].model_options.is_empty() && third[1].model_labels.is_empty());

        std::fs::remove_file(dir.path().join("codex")).unwrap();
        assert_eq!(rt.detect_agents(&env).await, None);
        let removed = &rt.agents.read().await[1];
        assert!(!removed.installed && removed.models.is_none());
    }

    #[tokio::test]
    async fn a_heartbeat_that_gets_through_clears_the_error_a_failed_call_left() {
        let engine = api::fake::engine(|_, _| (200, r#"{"cancelled":[]}"#.into())).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, sent) = runtime(&engine.url, dir.path());
        // A claim failed a moment ago: Settings shows the host as disconnected, with the reason.
        rt.set_error(Some("claim failed: connection refused".into()));
        rt.heartbeat().await;
        let status = rt.status();
        assert!(status.connected);
        assert_eq!(status.error, None, "a stale error stayed beside a connected host");
        // The window is told, so Settings drops the error without being reopened.
        let sent = sent.lock().unwrap();
        let (event, last) = sent.last().unwrap();
        assert_eq!(event, "host://status");
        assert_eq!((&last["connected"], &last["error"]), (&json!(true), &Value::Null));
        drop(sent);
        // An error left beside a host that already shows as connected goes the same way: the other loop's call
        // got through between this one failing and saying so.
        rt.set_error(Some("claim failed: connection refused".into()));
        rt.heartbeat().await;
        assert_eq!(rt.status().error, None);
    }

    fn task(id: &str) -> Task {
        serde_json::from_value(json!({ "id": id, "projectId": "prj_1", "agent": "claude", "instruction": "Cut the pauses", "startedAt": "2026-11-08T10:00:00.000Z" })).unwrap()
    }

    /// A task for an assistant this host has no runner for. Run to the end, it fails there: no test of the run
    /// loop can start a real CLI on the machine it runs on.
    fn unrunnable(id: &str) -> Task {
        Task { agent: "storyboard".into(), ..task(id) }
    }

    /// What a Claude run has on disk: the file with the engine token in its folder, beside its artifacts, and its
    /// session in Claude Code's own store. Gives the folder and the session.
    fn claude_run_files(rt: &HostRuntime, task: &Task) -> (PathBuf, PathBuf) {
        let folder = rt.run_dir(task);
        std::fs::create_dir_all(folder.join(".scarlet")).unwrap();
        std::fs::create_dir_all(folder.join("artifacts")).unwrap();
        std::fs::write(folder.join(".scarlet").join("mcp.json"), "sct_test").unwrap();
        let session = claude_project_dir(&real_path(&folder).unwrap(), &rt.paths.home).unwrap();
        std::fs::create_dir_all(&session).unwrap();
        (folder, session)
    }

    /// Whether a finished run's Claude session went. Scarlet leaves another Claude store alone, so where the tests
    /// run with one set (CLAUDE_CONFIG_DIR) the session staying is right.
    fn session_gone(session: &Path) -> bool {
        !session.exists() || crate::util::env_map().contains_key("CLAUDE_CONFIG_DIR")
    }

    /// Wait for something another task is about to do.
    async fn until(what: &str, done: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn a_host_the_engine_forgot_registers_again_on_its_next_heartbeat() {
        crate::util::test_log::capture();
        let engine = api::fake::engine(|route, _| match route {
            "POST /api/hosts/host_1/heartbeat" => (404, r#"{"error":{"code":"not_found","message":"No such host"}}"#.into()),
            "POST /api/hosts/register" => (200, r#"{"host":{"id":"host_2","name":"test (desktop)"}}"#.into()),
            _ => (500, String::new()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (mut rt, _) = runtime(&engine.url, dir.path());
        let saved = Arc::new(StdMutex::new(Vec::new()));
        let record = saved.clone();
        Arc::get_mut(&mut rt).unwrap().on_host_id = Arc::new(move |server, id| record.lock().unwrap().push((server.to_string(), id.to_string())));
        rt.connected.store(true, Ordering::SeqCst);
        rt.heartbeat().await;
        // Registered under the new id, connected, and with no error left from the heartbeat that failed.
        let status = rt.status();
        assert_eq!((status.host_id.as_deref(), status.connected, status.error), (Some("host_2"), true, None));
        assert_eq!(*saved.lock().unwrap(), [(engine.url.clone(), "host_2".to_string())]);
        assert_eq!(engine.bodies("POST /api/hosts/register")[0]["name"], json!("test (desktop)"));
        let (level, _) = crate::util::test_log::find(&["heartbeat failed: No such host (not_found 404)"]).expect("the failed heartbeat was not logged");
        assert_eq!(level, log::Level::Warn);

        // A heartbeat that fails for another reason leaves the host as it was, with the reason on show.
        let (rt, _) = runtime(&format!("{}/nowhere", engine.url), dir.path());
        rt.connected.store(true, Ordering::SeqCst);
        rt.heartbeat().await;
        let status = rt.status();
        assert_eq!((status.host_id.as_deref(), status.connected), (Some("host_1"), false));
        assert!(status.error.as_deref().unwrap().starts_with("heartbeat failed: "), "{:?}", status.error);
    }

    #[tokio::test]
    async fn completes_a_task_with_the_changes_it_made_and_clears_its_control_files() {
        crate::util::test_log::capture();
        let engine = api::fake::engine(|route, body| match route {
            // The engine answers with the changes it holds for the task.
            "POST /api/tasks/tsk_finish/complete" => (200, json!({
                "task": { "state": serde_json::from_str::<Value>(body).unwrap()["state"], "changeIds": ["chg_1", "chg_2", "chg_3"] }
            }).to_string()),
            _ => (200, "{}".into()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());
        let task = task("tsk_finish");
        let folder = rt.run_dir(&task);
        std::fs::create_dir_all(folder.join(".scarlet")).unwrap();
        std::fs::create_dir_all(folder.join("artifacts")).unwrap();
        std::fs::write(folder.join(".scarlet").join("mcp.json"), "sct_test").unwrap();
        std::fs::write(folder.join("artifacts").join("cut.otio"), "kept").unwrap();

        rt.complete(&task, "done", Some("Cut two pauses.".into()), None).await;
        let sent = &engine.bodies("POST /api/tasks/tsk_finish/complete")[0];
        assert_eq!(sent, &json!({ "state": "done", "ifStartedAt": "2026-11-08T10:00:00.000Z", "interrupted": false, "summary": "Cut two pauses." }));
        // The file with the engine token is gone. What the run made stays.
        assert!(!folder.join(".scarlet").exists() && folder.join("artifacts").join("cut.otio").exists());
        let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_finish", "requested=done state=done outcome=accepted", "changes=3"]).expect("no completion line");
        assert_eq!(level, log::Level::Info);

        // A run the host cut short is marked as one the editor can resume, and its failure is a warning.
        rt.finish(&task, "failed", None, Some("stalled: the agent wrote nothing for 10 minutes".into()), true).await;
        let sent = &engine.bodies("POST /api/tasks/tsk_finish/complete")[1];
        assert_eq!((&sent["state"], &sent["interrupted"], &sent["error"]), (&json!("failed"), &json!(true), &json!("stalled: the agent wrote nothing for 10 minutes")));
        assert!(sent.get("summary").is_none());
        let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_finish", "requested=failed state=failed outcome=accepted"]).expect("no failure line");
        assert_eq!(level, log::Level::Warn);

        // Cancelled by the editor is not an interruption. Cancelled because the app is quitting is.
        rt.complete(&task, "cancelled", None, Some("cancelled".into())).await;
        rt.cancel.cancel();
        rt.complete(&task, "cancelled", None, Some("host shutting down".into())).await;
        let sent = engine.bodies("POST /api/tasks/tsk_finish/complete");
        assert_eq!((&sent[2]["interrupted"], &sent[3]["interrupted"]), (&json!(false), &json!(true)));
    }

    #[tokio::test]
    async fn completes_a_task_without_reading_it_again() {
        crate::util::test_log::capture();
        let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());
        rt.complete(&task("tsk_noread"), "done", Some("Done.".into()), None).await;
        // The engine already has the run's changes: the completion is all the host sends.
        let routes: Vec<String> = engine.seen.lock().unwrap().iter().map(|(route, _)| route.clone()).collect();
        assert_eq!(routes, ["POST /api/tasks/tsk_noread/complete"]);
        assert_eq!(engine.bodies("POST /api/tasks/tsk_noread/complete")[0], json!({ "state": "done", "ifStartedAt": "2026-11-08T10:00:00.000Z", "interrupted": false, "summary": "Done." }));
        // An answer without a state confirms delivery without claiming it was saved as done.
        let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_noread", "requested=done state=unknown outcome=unconfirmed", "changes=0"]).expect("no completion line");
        assert_eq!(level, log::Level::Info);
    }

    #[test]
    fn logs_the_engine_state_when_it_differs_from_the_host_outcome() {
        crate::util::test_log::capture();
        let ack = api::CompletionAck { state: Some("queued".into()), ..Default::default() };
        let request = CompleteTaskRequest { state: "done".into(), if_started_at: None, summary: None,
            error: None, interrupted: false, engine_lost: false };
        log_completion("tsk_changed", &request, Some(&ack), 12);
        assert!(crate::util::test_log::find(&["[host] completion task=tsk_changed", "requested=done state=queued outcome=changed elapsedMs=12"]).is_some());
    }

    #[tokio::test]
    async fn a_completion_the_engine_misses_is_posted_again() {
        crate::util::test_log::capture();
        let posts = std::sync::atomic::AtomicUsize::new(0);
        let engine = api::fake::engine(move |route, _| match route {
            // The engine times out on the first completion it is sent for this task and takes the next.
            "POST /api/tasks/tsk_again/complete" if posts.fetch_add(1, Ordering::SeqCst) == 0 => (408, String::new()),
            // It takes none of these.
            "POST /api/tasks/tsk_lost/complete" | "POST /api/tasks/tsk_closing/complete" => (503, String::new()),
            _ => (200, "{}".into()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());

        let again = task("tsk_again");
        let (folder, session) = claude_run_files(&rt, &again);
        rt.complete(&again, "done", Some("Cut two pauses.".into()), None).await;
        // Forgotten after the one post, the task stays running at the engine, which then calls it interrupted and
        // runs the finished request a second time.
        let sent = engine.bodies("POST /api/tasks/tsk_again/complete");
        assert_eq!(sent.len(), 2, "the completion the engine missed was not posted again");
        // The same completion, tied to its attempt: the engine ignores a copy of one it already has.
        assert_eq!((&sent[1], &sent[1]["ifStartedAt"]), (&sent[0], &json!("2026-11-08T10:00:00.000Z")));
        let (level, _) = crate::util::test_log::find(&["complete failed for task tsk_again: Request Timeout (http_error 408)"]).expect("the missed post was not logged");
        assert_eq!(level, log::Level::Warn);
        // It landed, so the run is over: the file with the token and the session both go.
        assert!(!folder.join(".scarlet").exists() && session_gone(&session));

        // Three tries, then the host lets the task go. The file with the token still goes. The session stays, as
        // an interrupted run's does: the engine takes the run for interrupted and resumes it there.
        let lost = task("tsk_lost");
        let (folder, session) = claude_run_files(&rt, &lost);
        rt.complete(&lost, "done", Some("Cut two pauses.".into()), None).await;
        assert_eq!(engine.bodies("POST /api/tasks/tsk_lost/complete").len(), 3);
        assert!(!folder.join(".scarlet").exists() && folder.join("artifacts").exists());
        assert!(session.exists(), "the session the engine's resume carries on in was removed");

        // While the app quits, one try: quitting doesn't wait on an engine that may already be gone.
        rt.cancel.cancel();
        rt.complete(&task("tsk_closing"), "cancelled", None, Some("host shutting down".into())).await;
        assert_eq!(engine.bodies("POST /api/tasks/tsk_closing/complete").len(), 1);
    }

    #[tokio::test]
    async fn a_run_the_engine_crash_cut_short_is_reported_to_the_engine_that_comes_back() {
        crate::util::test_log::capture();
        // The engine has crashed: nothing answers at its address.
        let gone = format!("http://{}", std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap());
        let dir = tempfile::tempdir().unwrap();
        let (stopping, _) = runtime(&gone, dir.path());
        // The host stops with it, and its run ends as interrupted. The one try finds no engine.
        stopping.cancel.cancel();
        stopping.complete(&task("tsk_crash"), "cancelled", None, Some("cancelled".into())).await;

        // The engine is started again, and a host with it. Once registered, it tells the engine the run stopped, so
        // the engine resumes it now instead of after 90 seconds of silence.
        let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
        let (mut started, _) = runtime(&engine.url, dir.path());
        Arc::get_mut(&mut started).unwrap().undelivered = stopping.undelivered.clone();
        let delivering = tokio::spawn(started.clone().deliver_loop());
        until("the interruption to reach the engine", || !engine.bodies("POST /api/tasks/tsk_crash/complete").is_empty()).await;
        let sent = &engine.bodies("POST /api/tasks/tsk_crash/complete")[0];
        assert_eq!((&sent["state"], &sent["interrupted"], &sent["ifStartedAt"]), (&json!("cancelled"), &json!(true), &json!("2026-11-08T10:00:00.000Z")));
        // As a lost worker's: a run that crashes the engine each time it runs stops resuming by itself.
        assert_eq!(sent["engineLost"], json!(true));

        // A run of the old host that ends after the new host registered is reported as it ends.
        stopping.complete(&task("tsk_late"), "cancelled", None, Some("cancelled".into())).await;
        until("the late interruption to reach the engine", || !engine.bodies("POST /api/tasks/tsk_late/complete").is_empty()).await;
        assert_eq!(engine.bodies("POST /api/tasks/tsk_crash/complete").len(), 1, "the interruption was sent twice");
        started.cancel.cancel();
        delivering.await.unwrap();
    }

    #[tokio::test]
    async fn an_attempt_that_ends_beside_a_newer_one_leaves_their_folder_to_it() {
        let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());
        // The editor stopped a run and resumed it before its CLI had wound down: two attempts at work in one folder.
        let stopped = task("tsk_stopped");
        let resumed = Task { resume_root_id: Some("tsk_stopped".into()), ..task("tsk_resumed") };
        assert_eq!(rt.run_dir(&resumed), rt.run_dir(&stopped));
        for attempt in [&stopped, &resumed] {
            let run = RunningTask::new(attempt.project_id.clone(), attempt.agent.clone(), CancellationToken::new(), rt.run_dir(attempt));
            rt.running.lock().unwrap().insert(attempt.id.clone(), Arc::new(run));
        }
        // The resumed attempt has written its control files, and carries on in the session the first one opened.
        let (folder, session) = claude_run_files(&rt, &resumed);

        // The stopped attempt ends, and reports it as ever. Cleaning up as if alone, it would take the files the
        // resumed one runs on: its CLI starts with no Scarlet tools, or its next resume finds no session.
        rt.complete(&stopped, "cancelled", None, Some("cancelled".into())).await;
        assert_eq!(engine.bodies("POST /api/tasks/tsk_stopped/complete")[0]["state"], json!("cancelled"));
        assert!(folder.join(".scarlet").join("mcp.json").exists(), "the newer attempt's control files were removed");
        assert!(session.exists(), "the session the newer attempt works in was removed");

        // The folder is the newer attempt's to clean when it ends, whether or not the older one is still listed.
        rt.complete(&resumed, "done", Some("Cut two pauses.".into()), None).await;
        assert!(!folder.join(".scarlet").exists() && session_gone(&session) && folder.join("artifacts").exists());
    }

    #[tokio::test]
    async fn a_reclaimed_attempt_for_the_same_task_leaves_its_folder_to_the_newer_one() {
        let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());
        let first = Task { started_at: Some("2026-04-01T10:00:00Z".into()), ..task("tsk_same") };
        let second = Task { started_at: Some("2026-04-01T10:01:00Z".into()), ..task("tsk_same") };
        let first_run = Arc::new(RunningTask::new(first.project_id.clone(), first.agent.clone(), CancellationToken::new(), rt.run_dir(&first)));
        let second_run = Arc::new(RunningTask::new(second.project_id.clone(), second.agent.clone(), CancellationToken::new(), rt.run_dir(&second)));
        // Simulate launch() inserting the second attempt for the same task id while the first is still winding down.
        rt.running.lock().unwrap().insert(first.id.clone(), first_run.clone());
        if let Some(previous) = rt.running.lock().unwrap().insert(second.id.clone(), second_run.clone()) {
            previous.superseded.store(true, Ordering::SeqCst);
            previous.cancel.cancel();
        }
        assert!(first_run.cancel.is_cancelled(), "replacing a running attempt cancels the prior one");
        let (folder, session) = claude_run_files(&rt, &second);

        // The superseded first attempt finishes and must not delete the second attempt's control files or session.
        rt.complete_attempt(&first, "cancelled", None, Some("cancelled".into()), Some(&first_run)).await;
        assert!(folder.join(".scarlet").join("mcp.json").exists(), "superseded attempt removed the newer attempt's control files");
        assert!(session.exists(), "superseded attempt removed the newer attempt's Claude session");

        // When the newer attempt finishes, it owns cleanup of the shared folder.
        rt.complete_attempt(&second, "done", Some("Done.".into()), None, Some(&second_run)).await;
        assert!(!folder.join(".scarlet").exists() && session_gone(&session) && folder.join("artifacts").exists());
    }

    #[tokio::test]
    async fn a_task_claimed_as_the_app_quits_is_handed_back_without_starting_a_cli() {
        let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());
        let cancel = rt.cancel.child_token();
        rt.cancel.cancel();
        rt.run_task(unrunnable("tsk_quit"), cancel).await;
        let sent = &engine.bodies("POST /api/tasks/tsk_quit/complete")[0];
        assert_eq!((&sent["state"], &sent["error"], &sent["interrupted"]), (&json!("cancelled"), &json!("host shutting down"), &json!(true)));
        // Nothing was prepared for it: no prompt asked for, no folder made.
        assert!(!engine.seen.lock().unwrap().iter().any(|(route, _)| route.contains("/prompt")));
        assert!(!rt.run_dir(&task("tsk_quit")).exists());
    }

    #[tokio::test]
    async fn a_task_whose_prompt_cannot_be_fetched_fails_with_the_reason() {
        let engine = api::fake::engine(|route, _| match route {
            r if r.starts_with("GET /api/tasks/tsk_noprompt/prompt") => (409, r#"{"error":{"code":"conflict","message":"The project is closed"}}"#.into()),
            _ => (200, "{}".into()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _sent) = runtime(&engine.url, dir.path());
        let task = unrunnable("tsk_noprompt");
        rt.run_task(task.clone(), CancellationToken::new()).await;
        // The prompt was asked for with the run's own artifacts folder.
        let asked = engine.seen.lock().unwrap().iter().find(|(route, _)| route.contains("/prompt")).unwrap().0.clone();
        assert!(asked.contains(&format!("workDir={}", api::urlencode(&rt.run_dir(&task).join("artifacts").to_string_lossy()))), "{asked}");
        // The editor sees why, in the task's events and on the task.
        let event = &engine.bodies("POST /api/tasks/tsk_noprompt/events")[0];
        assert_eq!((&event["type"], &event["text"]), (&json!("error"), &json!("Could not prepare task: The project is closed (conflict 409)")));
        let done = &engine.bodies("POST /api/tasks/tsk_noprompt/complete")[0];
        assert_eq!((&done["state"], &done["error"]), (&json!("failed"), &json!("The project is closed (conflict 409)")));
        // None of the CLI's control files is left in the folder made for it.
        let left = std::fs::read_dir(rt.run_dir(&task)).map(|dir| dir.flatten().filter(|e| e.file_name() != "artifacts").count()).unwrap_or(0);
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn a_run_reports_its_start_its_failure_and_its_end_in_that_order() {
        crate::util::test_log::capture();
        let engine = api::fake::engine(|route, _| match route {
            r if r.starts_with("GET /api/tasks/tsk_flow/prompt") => (200, r#"{"systemPrompt":"SYSTEM","instruction":"Cut the pauses"}"#.into()),
            "POST /api/tasks/tsk_flow/complete" => (200, r#"{"task":{"state":"failed"}}"#.into()),
            _ => (200, "{}".into()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _sent) = runtime(&engine.url, dir.path());
        rt.run_task(unrunnable("tsk_flow"), CancellationToken::new()).await;
        let routes: Vec<String> = engine.seen.lock().unwrap().iter().map(|(route, _)| route.split('?').next().unwrap().to_string()).collect();
        assert_eq!(routes, [
            "GET /api/tasks/tsk_flow/prompt",
            // Saved before the CLI could do anything, so a claim that never started can be told from one that did.
            "POST /api/tasks/tsk_flow/events",
            "POST /api/tasks/tsk_flow/events",
            "POST /api/tasks/tsk_flow/complete",
        ]);
        let events = engine.bodies("POST /api/tasks/tsk_flow/events");
        assert_eq!((&events[0]["type"], &events[0]["text"]), (&json!("log"), &json!("Starting the editing agent.")));
        assert_eq!((&events[1]["type"], &events[1]["text"]), (&json!("error"), &json!("no runner for agent \"storyboard\"")));
        let done = &engine.bodies("POST /api/tasks/tsk_flow/complete")[0];
        assert_eq!((&done["state"], &done["error"], &done["interrupted"]), (&json!("failed"), &json!("no runner for agent \"storyboard\""), &json!(false)));
        // Both ends of the run are in the log under the task's id.
        assert!(crate::util::test_log::find(&["task tsk_flow: storyboard ended (exit code None)"]).is_some());
        let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_flow", "requested=failed state=failed outcome=accepted"]).expect("no failure line");
        assert_eq!(level, log::Level::Warn);
    }

    #[tokio::test]
    async fn a_run_whose_start_cannot_be_saved_never_starts_its_cli() {
        let engine = api::fake::engine(|route, _| match route {
            r if r.starts_with("GET /api/tasks/tsk_nostart/prompt") => (200, r#"{"systemPrompt":"SYSTEM","instruction":"Cut the pauses"}"#.into()),
            "POST /api/tasks/tsk_nostart/events" => (409, r#"{"error":{"code":"conflict","message":"The task was cancelled"}}"#.into()),
            _ => (200, "{}".into()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());
        rt.run_task(unrunnable("tsk_nostart"), CancellationToken::new()).await;
        // One event tried, and the task failed with the engine's reason. A run that got as far as its CLI
        // would have posted a second event.
        assert_eq!(engine.bodies("POST /api/tasks/tsk_nostart/events").len(), 1);
        let done = &engine.bodies("POST /api/tasks/tsk_nostart/complete")[0];
        assert_eq!((&done["state"], &done["error"]), (&json!("failed"), &json!("The task was cancelled (conflict 409)")));
    }

    #[tokio::test]
    async fn an_event_carries_the_time_the_cli_wrote_it_not_the_time_it_was_sent() {
        // A slow engine: it takes 300 ms to answer the first event it is sent.
        let slow = AtomicBool::new(true);
        let engine = api::fake::engine(move |route, _| {
            if route == "POST /api/tasks/tsk_late/events" && slow.swap(false, Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(300));
            }
            (200, "{}".into())
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _sent) = runtime(&engine.url, dir.path());
        let (sink, consumer, question) = rt.forward_events("tsk_late", Some("2026-11-08T10:00:00.000Z".into()));
        // The CLI writes two lines back to back, then asks its question and ends.
        let before = now_iso();
        sink(RunnerEvent::new("tool", "scarlet.timeline_get"));
        sink(RunnerEvent::new("log", "Read the timeline."));
        let after = now_iso();
        sink(RunnerEvent::new("question", "Which take?"));
        sink(RunnerEvent::new("result", "Done."));
        drop(sink);
        drain_events("tsk_late", consumer).await;
        // The question and the result reach the engine another way. The rest is sent on in the order written.
        let posted = engine.bodies("POST /api/tasks/tsk_late/events");
        assert!(posted.iter().all(|event| event["startedAt"] == "2026-11-08T10:00:00.000Z"));
        assert_eq!(posted.iter().map(|event| event["text"].as_str().unwrap()).collect::<Vec<_>>(), ["scarlet.timeline_get", "Read the timeline."]);
        assert_eq!(question.lock().unwrap().as_deref(), Some("Which take?"));
        // Each carries the moment it was written. The second waited behind the first for its turn to be sent: stamped
        // then, a backlog would bunch at one instant, later than events the engine saved meanwhile.
        let stamped: Vec<&str> = posted.iter().map(|event| event["at"].as_str().unwrap()).collect();
        assert!(stamped.iter().all(|at| before.as_str() <= *at && *at <= after.as_str()), "written between {before} and {after}, stamped {stamped:?}");
    }

    #[tokio::test]
    async fn prepares_a_private_folder_and_an_mcp_identity_for_each_attempt() {
        let engine = api::fake::engine(|route, _| match route {
            r if r.contains("/prompt") => (200, r#"{"systemPrompt":"SYSTEM","instruction":"The editor said yes","resumeSession":"s1"}"#.into()),
            _ => (200, "{}".into()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (mut rt, _) = runtime(&engine.url, dir.path());
        {
            let rt = Arc::get_mut(&mut rt).unwrap();
            rt.timeout = Some(Duration::from_secs(45 * 60));
            rt.models = HashMap::from([("claude".to_string(), "opus".to_string())]);
        }
        // A second attempt at an interrupted run: it works in the first attempt's folder, under its own id.
        let attempt = Task { resume_root_id: Some("tsk_first".into()), ..task("tsk_second") };
        let prepared = rt.prepare(&attempt, true).await.unwrap();
        assert_eq!(prepared.cwd, rt.task_dir("prj_1", "tsk_first"));
        assert_ne!(prepared.cwd, rt.task_dir("prj_1", "tsk_second"));
        assert_eq!((prepared.system_prompt.as_str(), prepared.instruction.as_str(), prepared.resume_session.as_deref()), ("SYSTEM", "The editor said yes", Some("s1")));
        let artifacts = prepared.cwd.join("artifacts");
        assert!(artifacts.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&prepared.cwd).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // The MCP server it starts speaks for this attempt, with the model from settings when the task names none.
        let env = &prepared.mcp.env;
        let value = |key: &str| env.get(key).map(String::as_str);
        assert_eq!((value("SCARLET_TASK"), value("SCARLET_PROJECT"), value("SCARLET_MODEL")), (Some("tsk_second"), Some("prj_1"), Some("opus")));
        assert_eq!((value("SCARLET_TASK_STARTED_AT"), value("SCARLET_TOKEN")), (Some("2026-11-08T10:00:00.000Z"), Some("sct_test")));
        assert_eq!((value("SCARLET_SERVER"), value("SCARLET_WORKDIR")), (Some(engine.url.as_str()), Some(artifacts.to_string_lossy().as_ref())));
        // The engine is asked for a fresh prompt, and told the cap on the run so the prompt can say so.
        let asked = engine.seen.lock().unwrap()[0].0.clone();
        assert!(asked.starts_with("GET /api/tasks/tsk_second/prompt?workDir=") && asked.ends_with("&fresh=1&timeLimit=45"), "{asked}");
        // Task folders are named by a hash, so neither id can steer a path.
        let hostile = rt.task_dir("../../prj", "../tsk");
        assert_eq!(hostile.parent(), Some(dir.path().join("tasks-v2").as_path()));
        assert!(hostile.file_name().unwrap().to_string_lossy().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn the_claim_loop_registers_again_when_forgotten_and_runs_what_it_claims() {
        let claims = std::sync::atomic::AtomicUsize::new(0);
        let engine = api::fake::engine(move |route, _| match route {
            "POST /api/hosts/host_1/claim?wait=25" => (404, r#"{"error":{"code":"not_found","message":"No such host"}}"#.into()),
            "POST /api/hosts/register" => (200, r#"{"host":{"id":"host_2","name":"test (desktop)"}}"#.into()),
            // The first claim under the new id gets a task, the ones after it nothing.
            "POST /api/hosts/host_2/claim?wait=25" | "POST /api/hosts/host_2/claim?wait=0" if claims.fetch_add(1, Ordering::SeqCst) == 0 => {
                (200, json!({ "task": { "id": "tsk_claimed", "projectId": "prj_1", "agent": "storyboard", "instruction": "x" } }).to_string())
            }
            r if r.contains("/claim?") => (200, r#"{"task":null}"#.into()),
            r if r.contains("/prompt") => (500, r#"{"error":{"code":"internal","message":"no prompt"}}"#.into()),
            _ => (200, "{}".into()),
        }).await;
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime(&engine.url, dir.path());
        *rt.agents.write().await = vec![
            AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), ..Default::default() },
            AgentAvailability { id: "codex".into(), installed: true, logged_in: Some(false), ..Default::default() },
            AgentAvailability { id: "gemini".into(), installed: false, ..Default::default() },
        ];
        let looping = tokio::spawn(rt.clone().claim_loop());
        until("the host to register again", || rt.host_id.lock().unwrap().as_deref() == Some("host_2")).await;
        // Only an installed, signed-in assistant is offered for work.
        let first = &engine.bodies("POST /api/hosts/host_1/claim?wait=25")[0];
        assert_eq!((&first["agents"], &first["desktopPid"]), (&json!(["claude"]), &json!(std::process::id())));
        // It waits five seconds after a failed claim unless something wakes it.
        rt.wake.notify_one();
        until("the claimed task to be completed", || !engine.bodies("POST /api/tasks/tsk_claimed/complete").is_empty()).await;
        until("the task to leave the running list", || rt.running.lock().unwrap().is_empty()).await;
        let status = rt.status();
        assert_eq!((status.connected, status.error, status.running.len()), (true, None, 0));
        rt.cancel.cancel();
        tokio::time::timeout(Duration::from_secs(10), looping).await.expect("the loop did not stop").unwrap();
    }

    #[tokio::test]
    async fn offers_only_assistants_with_a_free_slot() {
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime("http://127.0.0.1:1", dir.path());
        let ready = |id: &str| AgentAvailability { id: id.into(), installed: true, logged_in: Some(true), ..Default::default() };
        // "cursor" is not a CLI this host can run, whatever detection says.
        *rt.agents.write().await = vec![ready("claude"), ready("codex"), ready("cursor")];
        assert_eq!(rt.idle_agents().await, (vec!["claude".to_string(), "codex".to_string()], false));
        // One task per assistant here: claude is full, and the loop is told so it claims without a long wait.
        let run = Arc::new(RunningTask::new("prj_1".into(), "claude".into(), CancellationToken::new(), PathBuf::new()));
        rt.running.lock().unwrap().insert("tsk_1".into(), run);
        assert_eq!(rt.idle_agents().await, (vec!["codex".to_string()], true));
        // A full request slot leaves claude's side checks free: an edit's own checks never wait behind it.
        assert_eq!(rt.check_agents().await, (vec!["claude".to_string(), "codex".to_string()], false));
    }

    #[tokio::test]
    async fn side_checks_run_in_slots_of_their_own() {
        let dir = tempfile::tempdir().unwrap();
        let (rt, _) = runtime("http://127.0.0.1:1", dir.path());
        let ready = |id: &str| AgentAvailability { id: id.into(), installed: true, logged_in: Some(true), ..Default::default() };
        *rt.agents.write().await = vec![ready("gemini")];
        let check = || Arc::new(RunningTask::new("prj_1".into(), "gemini".into(), CancellationToken::new(), PathBuf::new()).side_check(true));
        // One request slot and two check slots here (max_parallel 1). Checks never take the request's slot.
        assert_eq!(side_check_slots(1), 2);
        rt.running.lock().unwrap().insert("chk_1".into(), check());
        assert_eq!(rt.idle_agents().await, (vec!["gemini".to_string()], false));
        assert_eq!(rt.check_agents().await, (vec!["gemini".to_string()], false));
        rt.running.lock().unwrap().insert("chk_2".into(), check());
        assert_eq!(rt.idle_agents().await, (vec!["gemini".to_string()], false));
        assert_eq!(rt.check_agents().await, (vec![], true));
        // And a request doesn't take a check's slot.
        let run = Arc::new(RunningTask::new("prj_1".into(), "gemini".into(), CancellationToken::new(), PathBuf::new()));
        rt.running.lock().unwrap().insert("tsk_1".into(), run);
        assert_eq!(rt.idle_agents().await, (vec![], true));
        rt.running.lock().unwrap().remove("chk_1");
        assert_eq!(rt.check_agents().await, (vec!["gemini".to_string()], false));
    }

    #[test]
    fn side_check_kinds_and_slots_match_the_engine() {
        assert!(is_side_check("area_check") && is_side_check("learning_check"));
        assert!(!is_side_check("skill_edit") && !is_side_check("edit") && !is_side_check("revise"));
        assert_eq!((side_check_slots(1), side_check_slots(3), side_check_slots(8)), (2, 6, 12));
    }

    /// The engine's `model-catalog` as a script, on a host that finds every assistant on its PATH: it prints the
    /// list in `<script>.<assistant>.json` and fails while there is none. It notes each assistant it is asked
    /// about in `<script>.asked`, and waits for as long as `<script>.hold` is there. Gives the script.
    #[cfg(unix)]
    fn catalog_script(rt: &mut Arc<HostRuntime>) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let rt = Arc::get_mut(rt).unwrap();
        // Scarlet's own folder of assistants is on every child's PATH, so these are found where none is installed.
        // They are only looked up: the script never starts the assistant it is asked about.
        let bin = crate::util::assistant_prefix(&rt.paths.home).join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for cli in CLI_AGENTS {
            std::fs::write(bin.join(cli), "").unwrap();
            std::fs::set_permissions(bin.join(cli), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let script = rt.paths.work_dir.join("engine.sh");
        std::fs::write(&script, "echo \"$2\" >> \"$0.asked\"\nwhile [ -e \"$0.hold\" ]; do sleep 0.05; done\nexec cat \"$0.$2.json\"\n").unwrap();
        rt.mcp = McpLauncher { program: "/bin/sh".into(), prefix_args: vec![script.to_string_lossy().into_owned()] };
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn asks_again_for_a_model_list_it_could_not_read() {
        crate::util::test_log::capture();
        let engine = api::fake::engine(|_, _| (200, r#"{"cancelled":[]}"#.into())).await;
        let dir = tempfile::tempdir().unwrap();
        let (mut rt, sent) = runtime(&engine.url, dir.path());
        let script = catalog_script(&mut rt);
        let beside = |name: &str| PathBuf::from(format!("{}.{name}", script.display()));
        let asked = || std::fs::read_to_string(beside("asked")).unwrap_or_default();
        let heartbeats = || engine.bodies("POST /api/hosts/host_1/heartbeat");
        let ready = |id: &str| AgentAvailability { id: id.into(), installed: true, logged_in: Some(true), ..Default::default() };
        // At launch Claude's list could not be read. ChatGPT's was, and Gemini is signed out: neither is asked about.
        let at_launch = || vec![ready("claude"), AgentAvailability { models: Some(vec!["gpt-5.5".into()]), ..ready("codex") }, AgentAvailability { logged_in: Some(false), ..ready("gemini") }];
        *rt.agents.write().await = at_launch();

        // It still can't be read: Claude is left without a list, and neither the engine nor the window is told anything.
        assert!(rt.load_missing_catalogs().await);
        assert_eq!(asked(), "claude\n", "the model list was not asked for again");
        assert!(heartbeats().is_empty() && sent.lock().unwrap().is_empty());

        // Now it can. Claude has its models, so the picker has one to offer.
        std::fs::write(beside("claude.json"), r#"{"models":["opus","sonnet"],"model":"opus","modelLabels":{"opus":"Opus"},"modelOptions":{"opus":{"efforts":[]}}}"#).unwrap();
        assert!(!rt.load_missing_catalogs().await);
        let claude = rt.agents.read().await[0].clone();
        assert_eq!((claude.models, claude.model.as_deref()), (Some(vec!["opus".to_string(), "sonnet".to_string()]), Some("opus")));
        assert_eq!((claude.model_labels.get("opus").map(String::as_str), claude.model_options.contains_key("opus")), (Some("Opus"), true));
        // The engine is sent the list at once, and the window is told.
        assert_eq!(heartbeats()[0]["agents"][0]["models"], json!(["opus", "sonnet"]));
        let (event, status) = sent.lock().unwrap().last().cloned().unwrap();
        assert_eq!((event.as_str(), &status["agents"][0]["models"]), ("host://status", &json!(["opus", "sonnet"])));
        let (level, _) = crate::util::test_log::find(&["model list read on a later try", "claude (signed in, 2 models)"]).expect("no log line for the list");
        assert_eq!(level, log::Level::Info);
        // With none missing, nobody is asked.
        assert!(!rt.load_missing_catalogs().await);
        assert_eq!((asked().as_str(), heartbeats().len()), ("claude\nclaude\n", 1));

        // A refresh that finishes while a list is being asked for has the newer answer, and keeps it.
        *rt.agents.write().await = at_launch();
        std::fs::write(beside("hold"), "").unwrap();
        let asking = tokio::spawn({
            let rt = rt.clone();
            async move { rt.load_missing_catalogs().await }
        });
        until("the list to be asked for", || asked().lines().count() == 3).await;
        rt.agents.write().await[0].models = Some(vec!["haiku".into()]);
        std::fs::remove_file(beside("hold")).unwrap();
        assert!(!asking.await.unwrap());
        assert_eq!(rt.agents.read().await[0].models, Some(vec!["haiku".to_string()]));
        assert_eq!(heartbeats().len(), 1, "a list nobody took was sent to the engine");

        // A host that has stopped tells nobody: its engine may be gone, and the window shows the host after it.
        *rt.agents.write().await = at_launch();
        let told = sent.lock().unwrap().len();
        rt.cancel.cancel();
        assert!(!rt.load_missing_catalogs().await);
        assert_eq!((heartbeats().len(), sent.lock().unwrap().len()), (1, told));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_asking_for_a_missing_model_list_until_it_is_read_or_the_host_stops() {
        const SOON: [Duration; 3] = [Duration::from_millis(20); 3];
        const NEVER: [Duration; 1] = [Duration::from_secs(3600)];
        let engine = api::fake::engine(|_, _| (200, r#"{"cancelled":[]}"#.into())).await;
        let dir = tempfile::tempdir().unwrap();
        let (mut rt, _) = runtime(&engine.url, dir.path());
        let script = catalog_script(&mut rt);
        let beside = |name: &str| PathBuf::from(format!("{}.{name}", script.display()));
        let tries = || std::fs::read_to_string(beside("asked")).unwrap_or_default().lines().count();
        let without_a_list = || vec![AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), ..Default::default() }];
        let run = |waits: &'static [Duration]| tokio::time::timeout(Duration::from_secs(30), rt.clone().catalog_loop(waits));
        *rt.agents.write().await = without_a_list();

        // The list can't be read: it is asked for after each wait, and then no more.
        run(&SOON).await.expect("the loop did not end");
        assert_eq!(tries(), 3, "the model list was not asked for again");
        assert!(rt.agents.read().await[0].models.is_none());

        // Once it is read nothing is left to ask for, and the loop ends there.
        std::fs::write(beside("claude.json"), r#"{"models":["opus"],"modelLabels":{},"modelOptions":{}}"#).unwrap();
        run(&SOON).await.expect("the loop did not end");
        assert_eq!((tries(), rt.agents.read().await[0].models.clone()), (4, Some(vec!["opus".to_string()])));
        assert_eq!(engine.bodies("POST /api/hosts/host_1/heartbeat").len(), 1);
        // One that starts with nothing missing asks nobody.
        run(&SOON).await.expect("the loop did not end");
        assert_eq!(tries(), 4);

        // A host that stops is not kept waiting for the next try.
        *rt.agents.write().await = without_a_list();
        rt.cancel.cancel();
        run(&NEVER).await.expect("the loop outlived the host");
        assert_eq!(tries(), 4);
    }

    #[test]
    fn reads_what_to_do_with_a_run_off_its_result() {
        let ten = Some(Duration::from_secs(600));
        let read = |result: &RunResult| outcome(result, false, None, None, ten);
        let said = RunResult { summary: "Cut two pauses.".into(), ..Default::default() };

        // Finished: its summary, or a plain "Done." when it said nothing.
        assert_eq!(read(&RunResult { ok: true, ..said.clone() }), Outcome::Done { summary: "Cut two pauses.".into() });
        assert_eq!(read(&RunResult { ok: true, ..Default::default() }), Outcome::Done { summary: "Done.".into() });

        // Cancelled wins over everything, whether the runner saw it or only the host did.
        assert_eq!(read(&RunResult { aborted: true, ok: true, question: Some("Keep?".into()), ..said.clone() }), Outcome::Cancelled { summary: Some("Cut two pauses.".into()) });
        assert_eq!(outcome(&RunResult { ok: true, ..Default::default() }, true, None, None, ten), Outcome::Cancelled { summary: None });

        // A question pauses the task, from the result or from the stream when the result lost it. Even a run
        // that failed after asking pauses: the editor's answer starts the next attempt.
        assert_eq!(read(&RunResult { ok: true, question: Some("Keep the cold open?".into()), ..Default::default() }), Outcome::Question("Keep the cold open?".into()));
        assert_eq!(outcome(&RunResult { ok: true, ..Default::default() }, false, Some("Which take?".into()), None, ten), Outcome::Question("Which take?".into()));
        assert_eq!(outcome(&RunResult { question: Some("From the result".into()), ..Default::default() }, false, Some("From the stream".into()), None, ten), Outcome::Question("From the result".into()));
        assert_eq!(outcome(&RunResult { error: Some("exited 1".into()), ..Default::default() }, false, Some("Which take?".into()), None, ten), Outcome::Question("Which take?".into()));

        // Failed on its own: the runner's reason, and nothing to resume.
        assert_eq!(read(&RunResult { error: Some("claude exited with code 1".into()), ..said.clone() }), Outcome::Failed { error: "claude exited with code 1".into(), summary: Some("Cut two pauses.".into()), stopped: false });
        assert_eq!(read(&RunResult::default()), Outcome::Failed { error: "agent failed".into(), summary: None, stopped: false });

        // Stopped by the host: the reason names the limit, and the editor can resume.
        let stalled = RunResult { timed_out: true, stalled: true, error: Some("stalled".into()), ..Default::default() };
        assert_eq!(read(&stalled), Outcome::Failed { error: "stalled: the agent wrote nothing for 10 minutes".into(), summary: None, stopped: true });
        let capped = RunResult { timed_out: true, error: Some("timed out".into()), ..Default::default() };
        assert_eq!(outcome(&capped, false, None, Some(Duration::from_secs(45 * 60)), ten), Outcome::Failed { error: "timed out after 45 minutes, the limit for one agent run".into(), summary: None, stopped: true });
        // A timeout with no cap set here keeps the runner's own word for it.
        assert_eq!(read(&capped), Outcome::Failed { error: "timed out".into(), summary: None, stopped: true });
    }

    #[test]
    fn describes_the_assistants_it_found_on_one_line() {
        let found = [
            AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), auth: Some("subscription".into()), version: Some("2.1.316".into()), models: Some(vec!["opus".into(), "sonnet".into()]), ..Default::default() },
            AgentAvailability { id: "codex".into(), installed: true, logged_in: Some(false), ..Default::default() },
            AgentAvailability { id: "gemini".into(), installed: false, ..Default::default() },
        ];
        assert_eq!(describe_agents(&found), "claude 2.1.316 (signed in, subscription, 2 models); codex (signed out, no model list); gemini not installed");
    }

    #[test]
    fn keeps_one_host_id_however_many_ports_the_engine_has_had() {
        // The engine takes a new port at each launch, and the id is filed under its address.
        let mut cfg = AppConfig::default();
        for port in 50_000..50_003 {
            cfg.host_ids.insert(format!("http://127.0.0.1:{port}"), "host_old".into());
        }
        assert!(remember_host_id(&mut cfg, "http://127.0.0.1:51000", "host_new"));
        assert_eq!(cfg.host_ids, HashMap::from([("http://127.0.0.1:51000".to_string(), "host_new".to_string())]));
        // Nothing to save when it is already the only one.
        assert!(!remember_host_id(&mut cfg, "http://127.0.0.1:51000", "host_new"));
        // A file from an older version is pruned even when this launch's entry is already there.
        cfg.host_ids.insert("http://127.0.0.1:50000".into(), "host_old".into());
        assert!(remember_host_id(&mut cfg, "http://127.0.0.1:51000", "host_new"));
        assert_eq!(cfg.host_ids.len(), 1);
    }

    #[test]
    fn zero_minutes_turns_a_limit_off() {
        let limits = |timeout, stall| run_limits(&AppConfig { timeout_minutes: timeout, stall_minutes: stall, ..Default::default() });
        let minutes = |m: u64| Some(Duration::from_secs(m * 60));
        // Unset: no cap on a working agent, and the default stall window.
        assert_eq!(limits(None, None), (None, minutes(DEFAULT_STALL_MINUTES)));
        assert_eq!(limits(Some(45), Some(3)), (minutes(45), minutes(3)));
        // The standalone host reads 0 as "off". Here it used to mean one minute.
        assert_eq!(limits(Some(0), Some(0)), (None, None));
        // A number too large to count in seconds is a limit that never comes, not a crash.
        assert_eq!(limits(Some(u64::MAX), None).0, Some(Duration::from_secs(u64::MAX)));
    }

    #[test]
    fn stop_reasons_name_the_limit() {
        assert_eq!(timed_out_reason(Duration::from_secs(45 * 60)), "timed out after 45 minutes, the limit for one agent run");
        assert_eq!(timed_out_reason(Duration::from_secs(30)), "timed out after 1 minute, the limit for one agent run");
        assert_eq!(stalled_reason(Duration::from_secs(DEFAULT_STALL_MINUTES * 60)), "stalled: the agent wrote nothing for 10 minutes");
    }

    #[tokio::test]
    async fn missed_cancellation_stops_only_the_cancelled_cli_on_heartbeat() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = Api::new(&format!("http://{}", listener.local_addr().unwrap()), None);
        let engine = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = [0u8; 2048];
            assert!(stream.read(&mut received).await.unwrap() > 0);
            let body = r#"{"cancelled":["stopped"]}"#;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let worker = || Arc::new(RunningTask::new("new".into(), "codex".into(), CancellationToken::new(), PathBuf::new()));
        let (stopped, active) = (worker(), worker());
        let running = StdMutex::new(HashMap::from([("stopped".into(), stopped.clone()), ("active".into(), active.clone())]));
        heartbeat_workers(&api, "host", &[], &running).await.unwrap();
        engine.await.unwrap();
        assert!(stopped.cancel.is_cancelled());
        assert!(!active.cancel.is_cancelled());
    }

    #[test]
    fn finished_task_folders_keep_only_artifacts_and_old_ones_are_pruned() {
        let root = tempfile::tempdir().unwrap();
        let task = root.path().join("tasks-v2").join("t1");
        std::fs::create_dir_all(task.join(".scarlet")).unwrap();
        std::fs::create_dir_all(task.join("artifacts")).unwrap();
        std::fs::write(task.join(".scarlet").join("mcp.json"), "token").unwrap();
        std::fs::write(task.join("AGENTS.md"), "SYS").unwrap();
        std::fs::write(task.join("artifacts").join("cut.otio"), "kept").unwrap();
        remove_control_files(&task).unwrap();
        let names: Vec<_> = std::fs::read_dir(&task).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["artifacts"]);
        // A resumed attempt's own folder has no artifacts and goes away entirely.
        let attempt = root.path().join("tasks-v2").join("t2");
        std::fs::create_dir_all(attempt.join(".scarlet")).unwrap();
        remove_control_files(&attempt).unwrap();
        assert!(!attempt.exists());

        let tasks_root = root.path().join("tasks-v2");
        let day = Duration::from_secs(86_400);
        let now = std::time::SystemTime::now();
        // A later retry rewrote an artifact; the folders themselves look old.
        let in_use = tasks_root.join("t3");
        std::fs::create_dir_all(in_use.join("artifacts")).unwrap();
        let edit = std::fs::File::create(in_use.join("artifacts").join("edit.otio")).unwrap();
        edit.set_modified(now + 10 * day).unwrap();
        prune_task_dirs(&tasks_root, now + 13 * day, None);
        assert!(task.exists());
        prune_task_dirs(&tasks_root, now + 15 * day, None);
        assert!(!task.exists());
        assert!(in_use.exists());
    }

    #[test]
    fn removes_only_the_claude_project_folder_named_after_the_task_folder() {
        let home = tempfile::tempdir().unwrap();
        // Escaping checked against Claude Code 2.1.316: real path, every non-alphanumeric character as "-".
        let cwd = Path::new("/Users/me/Library/Application Support/com.forwardfuture.scarlet/work/tasks-v2/ab12");
        let name = "-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-ab12";
        assert_eq!(claude_project_dir(cwd, home.path()), Some(home.path().join(".claude").join("projects").join(name)));
        assert_eq!(claude_project_dir(&Path::new("/").join("x".repeat(250)), home.path()), None);
        let projects = home.path().join(".claude").join("projects");
        for n in [name, "-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-cd34", "-Users-me-project"] {
            std::fs::create_dir_all(projects.join(n)).unwrap();
        }
        // Claude Code 2.1.316 keeps a session's to-do list apart from its transcript, in ~/.claude/tasks/<session id>.
        let (run, other) = ("3f1c2b9e-0000-4000-8000-000000000000", "9a8b7c6d-1111-4000-8000-000000000000");
        std::fs::write(projects.join(name).join(format!("{run}.jsonl")), "{}").unwrap();
        std::fs::write(projects.join("-Users-me-project").join(format!("{other}.jsonl")), "{}").unwrap();
        // Two files in the task's project folder that are no session. Read as an id, the second would name ~/.claude.
        for stray in ["notes.jsonl", "...jsonl"] {
            std::fs::write(projects.join(name).join(stray), "{}").unwrap();
        }
        let lists = home.path().join(".claude").join("tasks");
        for list in [run, other, "notes"] {
            std::fs::create_dir_all(lists.join(list)).unwrap();
            std::fs::write(lists.join(list).join("1.json"), "{}").unwrap();
        }
        remove_claude_sessions(Path::new("/Users/me/project"), home.path()).unwrap(); // not a task folder
        remove_claude_sessions(cwd, home.path()).unwrap();
        let names = |dir: &Path| {
            let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            names.sort();
            names
        };
        assert_eq!(names(&projects), ["-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-cd34", "-Users-me-project"]);
        // The run's list goes with its session. Another session's stays, and so does a folder that isn't named by a session id.
        assert_eq!(names(&lists), [other, "notes"]);
    }

    #[test]
    fn mcp_spec_points_at_the_engine_mcp_subcommand() {
        let sidecar = McpLauncher { program: "C:\\Scarlet\\scarlet-engine.exe".into(), prefix_args: vec![] };
        let spec = sidecar.spec("http://127.0.0.1:5123", "sct_t", "prj_1", Some("task_1"), "claude", Some("opus"), "C:\\work\\task_1");
        assert_eq!(spec.command, "C:\\Scarlet\\scarlet-engine.exe");
        assert_eq!(spec.args, ["mcp"]);
        assert_eq!(spec.env.get("SCARLET_SERVER").map(String::as_str), Some("http://127.0.0.1:5123"));
        assert_eq!(spec.env.get("SCARLET_TOKEN").map(String::as_str), Some("sct_t"));
        assert_eq!(spec.env.get("SCARLET_TASK").map(String::as_str), Some("task_1"));
        assert_eq!(spec.env.get("SCARLET_MODEL").map(String::as_str), Some("opus"));
        assert_eq!(spec.env.get("SCARLET_WORKDIR").map(String::as_str), Some("C:\\work\\task_1"));

        // Dev fallback: node + cli.js, then the same `mcp …` flags; no task/model when absent.
        let dev = McpLauncher { program: "node".into(), prefix_args: vec!["C:/repo/apps/server/dist/cli.js".into()] };
        let spec = dev.spec("http://127.0.0.1:4000", "t", "p", None, "codex", None, "/w");
        assert_eq!(&spec.args[..2], &["C:/repo/apps/server/dist/cli.js", "mcp"]);
        assert!(!spec.args.contains(&"--task".to_string()));
        assert!(!spec.args.contains(&"--model".to_string()));
        assert!(!spec.env.contains_key("SCARLET_TASK"));
        // The generated Claude MCP config embeds exactly this spec.
        let cfg: Value = serde_json::from_str(&runner_claude::mcp_config_json(&spec)).unwrap();
        assert_eq!(cfg["mcpServers"]["scarlet"]["command"], json!("node"));
        assert_eq!(cfg["mcpServers"]["scarlet"]["args"][1], json!("mcp"));
        assert_eq!(cfg["mcpServers"]["scarlet"]["env"]["SCARLET_PROJECT"], json!("p"));
        let gem = runner_gemini::acp_mcp_server(&spec);
        assert_eq!(gem["args"], json!(spec.args));
    }
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
