//! Engine sidecar lifecycle (solo mode).
//!
//! The engine is `scarlet-engine` (a Node SEA bundled as a Tauri sidecar). The
//! app spawns `scarlet-engine serve --solo --data <dir> --port 0` with stdin as a
//! kept-open pipe (the engine exits when stdin closes: orphan guard and clean
//! shutdown), waits for the single `SCARLET_READY {...}` stdout line, publishes
//! the URL/token to the UI and the agent host, restarts it with backoff if it
//! crashes, and closes stdin (then kills) on app exit.
//!
//! Tauri dev runs `SCARLET_ENGINE_CMD` when set, otherwise
//! `node <repo>/apps/server/dist/cli.js` (same subcommands and flags). The dev
//! engine restarts itself when the compiled server or packages change (run
//! `pnpm desktop:dev`, which keeps `tsc --watch` going), so edits go live
//! without restarting the app.
//!
//! Restarts reuse the previous port, so the open UI keeps working (its session
//! token is stored by the engine and survives the restart).

use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, Result};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use tokio_util::sync::CancellationToken;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{Mutex, Notify};

use crate::config::Paths;
use crate::util::{child_env, hide_console, split_command_line};

pub const READY_PREFIX: &str = "SCARLET_READY ";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadyInfo {
    pub port: u16,
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub data_dir: Option<String>,
}

/// Parse the engine's ready line. Returns None for any other output.
pub fn parse_ready_line(line: &str) -> Option<ReadyInfo> {
    let rest = line.trim_start().strip_prefix(READY_PREFIX.trim_end())?;
    serde_json::from_str::<ReadyInfo>(rest.trim()).ok()
}

/// The level one line of the engine's output is logged at. The engine writes its log to stdout. What reaches stderr
/// is an error or a stack trace.
fn engine_line_level(line: &str, stderr: bool) -> log::Level {
    match (line.starts_with("[error]"), stderr) {
        // A fault, on either stream. One the engine carries on from, such as a request that failed, is written to
        // stdout with the rest of its log, and the uncaught error that stops it to stderr. A search of the app log
        // for ERROR has to find both. The stack under one stays at its stream's level: one ERROR line for each fault.
        (true, _) => log::Level::Error,
        (false, true) => log::Level::Warn,
        (false, false) => log::Level::Info,
    }
}

/// How to launch the engine binary (also used for the MCP server: `<program> <prefix…> mcp …`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineLaunch {
    pub program: String,
    pub prefix_args: Vec<String>,
    /// "sidecar" | "env" | "dev"
    pub kind: String,
}

impl EngineLaunch {
    pub fn describe(&self) -> String {
        let mut parts = vec![self.program.clone()];
        parts.extend(self.prefix_args.iter().cloned());
        parts.join(" ")
    }
}

/// Repo root at compile time (dev fallback only).
pub fn dev_repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

fn sidecar_name() -> &'static str {
    if cfg!(windows) {
        "scarlet-engine.exe"
    } else {
        "scarlet-engine"
    }
}

/// Tauri dev uses the compiled checkout. Packaged builds (including debug bundles) use the sidecar.
pub fn resolve_engine_launch(home: &Path, resources: Option<&Path>) -> Result<EngineLaunch> {
    // The deb installs the private engine, Whisper and native audio libraries together under /usr/lib/Scarlet.
    let sidecar = if cfg!(target_os = "linux") {
        resources.map(|dir| dir.join(sidecar_name()))
    } else {
        std::env::current_exe().ok().map(|exe| exe.with_file_name(sidecar_name()))
    };
    let cli = dev_repo_root().join("apps/server/dist/cli.js");
    select_engine(home, tauri::is_dev(), sidecar.as_deref(), std::env::var("SCARLET_ENGINE_CMD").ok().as_deref(), &cli)
}

fn select_engine(home: &Path, development: bool, sidecar: Option<&Path>, override_cmd: Option<&str>, cli: &Path) -> Result<EngineLaunch> {
    if !development {
        if let Some(candidate) = sidecar.filter(|p| p.metadata().is_ok_and(|m| m.is_file() && m.len() > 1024)) {
            return Ok(EngineLaunch { program: candidate.to_string_lossy().into_owned(), prefix_args: vec![], kind: "sidecar".into() });
        }
    }
    if let Some(cmd) = override_cmd {
        let parts = split_command_line(cmd);
        if let Some((program, rest)) = parts.split_first() {
            return Ok(EngineLaunch { program: program.clone(), prefix_args: rest.to_vec(), kind: "env".into() });
        }
    }
    if cli.is_file() {
        let env = child_env(home);
        let node = crate::host::spawn::find_on_path("node", &env).ok_or_else(|| anyhow!("node not found on PATH (needed for the dev engine fallback)"))?;
        let cli = std::fs::canonicalize(cli).unwrap_or_else(|_| cli.to_path_buf());
        let cli = cli.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        return Ok(EngineLaunch { program: node, prefix_args: vec![cli], kind: "dev".into() });
    }
    if development { return Err(anyhow!("Build the development engine with pnpm build, or set SCARLET_ENGINE_CMD")); }
    Err(anyhow!("scarlet-engine sidecar not found (set SCARLET_ENGINE_CMD or build apps/server for the dev fallback)"))
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub user_id: Option<String>,
    /// "starting" | "ready" | "error" | "stopped"
    pub state: String,
    pub error: Option<String>,
    pub data_dir: String,
    pub work_dir: String,
    pub log_dir: String,
    pub engine: Option<String>,
    pub engine_kind: Option<String>,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub version: String,
}

struct Running {
    exit: Shared<BoxFuture<'static, Option<ExitStatus>>>,
    force: CancellationToken,
    stdin: Option<ChildStdin>,
    pid: u32,
}

/// SIGKILL everything in the engine's process group. The engine leads its own group, and the ffmpeg children it
/// starts stay in it.
#[cfg(unix)]
async fn kill_group(pid: u32) {
    // No engine has process id 0, and to `kill` group 0 is the caller's own: Scarlet's.
    if pid == 0 {
        return;
    }
    // Usually nothing is left in the group, and `kill` only has that to say.
    let _ = tokio::process::Command::new("/bin/kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(Stdio::null()).status().await;
}

impl Running {
    fn track(mut child: Child, stdin: Option<ChildStdin>, pid: u32) -> Self {
        let force = CancellationToken::new();
        let stop = force.clone();
        let exit = async move {
            tokio::select! {
                biased;
                status = child.wait() => {
                    // An engine that ends by itself signals nobody. The media tools it had started would work on
                    // beside the engine that replaces it, which starts the same jobs again.
                    #[cfg(unix)]
                    kill_group(pid).await;
                    status.ok()
                }
                _ = stop.cancelled() => {
                    #[cfg(windows)]
                    crate::util::kill_tree(pid).await;
                    #[cfg(unix)]
                    kill_group(pid).await;
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
            }
        }.boxed().shared();
        Self { exit, force, stdin, pid }
    }

    async fn shutdown(&mut self, grace: Duration) {
        drop(self.stdin.take());
        if tokio::time::timeout(grace, self.exit.clone()).await.is_err() {
            log::warn!("engine did not exit after stdin close; killing");
            self.force.cancel();
            self.exit.clone().await;
        }
    }
}

async fn ready_before_exit(
    ready: tokio::sync::oneshot::Receiver<ReadyInfo>,
    exit: impl std::future::Future<Output = Option<ExitStatus>>,
) -> Option<ReadyInfo> {
    tokio::select! {
        biased;
        _ = exit => None,
        info = ready => info.ok(),
    }
}

/// Failed starts in a row after which the window says Scarlet couldn't start, and why. The engine is still started
/// again after each, and the window comes back when a start gets through.
const FAILED_STARTS_SHOWN: u32 = 3;

/// The status while a crashed engine waits to be started again, after `failed_starts` failed starts in a row.
fn restarting(s: &mut EngineStatus, failed_starts: u32) {
    s.state = if failed_starts >= FAILED_STARTS_SHOWN { "error" } else { "starting" }.into();
    s.restarts += 1;
    s.url = None;
    s.token = None;
}

/// The status once the engine the window was using has ended. `asked`: Scarlet stopped it, to quit or to load a dev
/// rebuild, which is over before anything notices. An engine that ends by itself has crashed, and the error says so:
/// the window then shows that Scarlet is reconnecting, where each action would otherwise fail without a word.
fn ended(s: &mut EngineStatus, quitting: bool, asked: bool, code: Option<i32>) {
    s.pid = None;
    if s.state != "ready" {
        return;
    }
    s.state = if quitting { "stopped" } else { "starting" }.into();
    s.url = None;
    s.token = None;
    if !asked {
        let code = code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
        s.error = Some(format!("Scarlet’s engine stopped unexpectedly{code}. Starting it again…"));
    }
}

pub struct EngineManager {
    app: AppHandle,
    paths: Paths,
    status: Arc<std::sync::Mutex<EngineStatus>>,
    running: Arc<Mutex<Option<Running>>>,
    stopped: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    /// Port of the last healthy run (0 = let the engine pick).
    port: Arc<AtomicU16>,
    /// Set when the dev watcher asks for a restart (not a crash: no backoff).
    reload: Arc<AtomicBool>,
    reload_now: Arc<Notify>,
}

impl EngineManager {
    pub fn new(app: AppHandle, paths: Paths) -> Self {
        let status = EngineStatus {
            state: "stopped".into(),
            data_dir: paths.data_dir.to_string_lossy().to_string(),
            work_dir: paths.work_dir.to_string_lossy().to_string(),
            log_dir: paths.log_dir.to_string_lossy().to_string(),
            version: env!("CARGO_PKG_VERSION").into(),
            ..Default::default()
        };
        EngineManager {
            app,
            paths,
            status: Arc::new(std::sync::Mutex::new(status)),
            running: Arc::new(Mutex::new(None)),
            stopped: Arc::new(AtomicBool::new(true)),
            generation: Arc::new(AtomicU64::new(0)),
            port: Arc::new(AtomicU16::new(0)),
            reload: Arc::new(AtomicBool::new(false)),
            reload_now: Arc::new(Notify::new()),
        }
    }

    pub fn status(&self) -> EngineStatus {
        self.status.lock().unwrap().clone()
    }

    fn update(&self, f: impl FnOnce(&mut EngineStatus)) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = self.app.emit("engine://status", &snapshot);
    }

    /// Spawn the engine and supervise it until `stop()`.
    pub fn start_solo(self: &Arc<Self>) {
        if !self.stopped.swap(false, Ordering::SeqCst) {
            return; // already running
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let launch = match resolve_engine_launch(&self.paths.home, self.paths.resource_dir.as_deref()) {
            Ok(l) => l,
            Err(e) => {
                self.update(|s| {
                    s.state = "error".into();
                    s.error = Some(e.to_string());
                });
                self.stopped.store(true, Ordering::SeqCst);
                return;
            }
        };
        self.update(|s| {
            s.state = "starting".into();
            s.url = None;
            s.token = None;
            s.error = None;
            s.engine = Some(launch.describe());
            s.engine_kind = Some(launch.kind.clone());
        });
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            // On Windows this applies the workspace ACL with PowerShell. Let the
            // window paint while it runs, but never start the engine or host on failure.
            let paths = me.paths.clone();
            let prepared = tauri::async_runtime::spawn_blocking(move || paths.ensure()).await;
            if me.generation.load(Ordering::SeqCst) != generation { return; }
            if let Err(error) = prepared.map_err(anyhow::Error::from).and_then(|result| result) {
                log::error!("preparing the Scarlet workspace: {error:#}");
                me.update(|s| {
                    s.state = "error".into();
                    s.error = Some(format!("Could not prepare the Scarlet workspace: {error:#}"));
                });
                return;
            }
            if launch.kind == "dev" {
                let watcher = me.clone();
                tauri::async_runtime::spawn(async move { watcher.watch_dev_build(generation).await });
            }
            me.supervise(launch, generation).await;
        });
    }

    /// Dev engine only: restart it when the compiled server or packages change.
    async fn watch_dev_build(self: Arc<Self>, generation: u64) {
        let root = dev_repo_root();
        let dirs: Vec<PathBuf> = ["apps/server/dist", "packages/shared/dist", "packages/timeline/dist", "packages/render/dist"].iter().map(|d| root.join(d)).collect();
        let mut seen = newest_mtime(&dirs);
        log::info!("engine: dev reload on; watching {}", dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", "));
        loop {
            tokio::time::sleep(Duration::from_millis(700)).await;
            if self.stopped.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let now = newest_mtime(&dirs);
            if now == seen {
                continue;
            }
            // tsc writes many files; wait until the output settles.
            let mut settled = now;
            loop {
                tokio::time::sleep(Duration::from_millis(400)).await;
                let next = newest_mtime(&dirs);
                if next == settled {
                    break;
                }
                settled = next;
            }
            seen = settled;
            log::info!("engine: build changed; restarting engine");
            self.reload.store(true, Ordering::SeqCst);
            self.reload_now.notify_one();
            self.shutdown_child().await;
        }
    }

    async fn supervise(self: Arc<Self>, launch: EngineLaunch, generation: u64) {
        let mut attempt: u32 = 0;
        let mut failed_starts: u32 = 0;
        loop {
            if self.stopped.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let started = Instant::now();
            match self.run_once(&launch, generation).await {
                Ok(()) => failed_starts = 0,
                Err(e) => {
                    failed_starts += 1;
                    log::error!("engine: {e}");
                    self.update(|s| {
                        s.state = "error".into();
                        s.error = Some(e.to_string());
                        s.pid = None;
                    });
                }
            }
            if self.stopped.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation {
                self.update(|s| {
                    s.state = "stopped".into();
                    s.pid = None;
                    s.url = None;
                    s.token = None;
                });
                return;
            }
            // Code changed (dev): restart right away, same port.
            if self.reload.swap(false, Ordering::SeqCst) {
                self.update(|s| {
                    s.state = "starting".into();
                    s.url = None;
                    s.token = None;
                });
                continue;
            }
            // Crash: restart with backoff (reset after a healthy run).
            if started.elapsed() > Duration::from_secs(60) {
                attempt = 0;
            }
            attempt += 1;
            let delay = Duration::from_millis((1000u64 * 2u64.pow(attempt.min(5))).min(30_000));
            log::warn!("engine exited; restarting in {delay:?} (attempt {attempt})");
            self.update(|s| restarting(s, failed_starts));
            // A dev rebuild (e.g. fixing the crash) cuts the wait short.
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.reload_now.notified() => { self.reload.store(false, Ordering::SeqCst); }
            }
        }
    }

    async fn run_once(&self, launch: &EngineLaunch, generation: u64) -> Result<()> {
        let mut env = child_env(&self.paths.home);
        crate::crisper::set_adapter_env(&mut env, self.paths.resource_dir.as_deref(), tauri::is_dev());
        if let Some(res) = &self.paths.resource_dir {
            let bin = res.join("bin");
            let ff = bin.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
            if ff.is_file() {
                env.insert("SCARLET_BIN_DIR".into(), bin.to_string_lossy().to_string());
            }
        }
        if launch.kind == "dev" {
            // Tauri places the media tools beside the desktop executable. The dev engine runs under Node elsewhere.
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    env.entry("SCARLET_BIN_DIR".into()).or_insert_with(|| dir.to_string_lossy().into_owned());
                }
            }
            let skills = dev_repo_root().join("skills");
            if skills.is_dir() && !env.contains_key("SCARLET_SKILLS_SEED") {
                env.insert("SCARLET_SKILLS_SEED".into(), skills.to_string_lossy().to_string());
            }
        }
        env.insert("SCARLET_DATA".into(), self.paths.data_dir.to_string_lossy().to_string());

        let mut cmd = tokio::process::Command::new(&launch.program);
        cmd.args(&launch.prefix_args);
        let port = self.port.load(Ordering::SeqCst).to_string();
        cmd.args(["serve", "--solo", "--data", &self.paths.data_dir.to_string_lossy(), "--port", &port]);
        cmd.env_clear().envs(&env);
        // The engine protects its working directory from library permission changes.
        cmd.current_dir(&self.paths.work_dir);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        hide_console(&mut cmd);
        let mut running = self.running.lock().await;
        if self.stopped.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        log::info!("engine: spawning {} serve --solo --data {} --port {port}", launch.describe(), self.paths.data_dir.display());
        let mut child = cmd.spawn().map_err(|e| anyhow!("spawn engine ({}): {e}", launch.program))?;
        let pid = child.id().ok_or_else(|| anyhow!("engine has no process id"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("engine stdout not captured"))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    log::log!(engine_line_level(&l, true), "[engine] {l}");
                }
            });
        }
        let tracked = Running::track(child, stdin, pid);
        let exit = tracked.exit.clone();
        *running = Some(tracked);
        drop(running);
        self.update(|s| s.pid = Some(pid));

        // Wait for the ready line (other log lines may precede it).
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<ReadyInfo>();
        let reader = tokio::spawn(async move {
            let mut tx = Some(ready_tx);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if let Some(info) = parse_ready_line(&l) {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(info);
                    }
                    continue;
                }
                log::log!(engine_line_level(&l, false), "[engine] {l}");
            }
        });

        let ready = tokio::time::timeout(Duration::from_secs(60), ready_before_exit(ready_rx, exit.clone())).await;
        match ready {
            Ok(Some(info)) => {
                if self.generation.load(Ordering::SeqCst) != generation {
                    // stop() owns the child. A late ready line must not restart the host.
                    return Ok(());
                }
                log::info!("engine ready on {} (user {})", info.url, info.user_id.as_deref().unwrap_or("?"));
                self.port.store(info.port, Ordering::SeqCst);
                self.update(|s| {
                    s.state = "ready".into();
                    s.url = Some(info.url.clone());
                    s.token = Some(info.token.clone());
                    s.user_id = info.user_id.clone();
                    s.error = None;
                });
                // Hand the solo session to the agent host.
                if let Some(state) = self.app.try_state::<crate::AppState>() {
                    let host = state.host.clone();
                    let (url, token) = (info.url.clone(), info.token.clone());
                    tauri::async_runtime::spawn(async move { host.configure(&url, &token).await });
                }
            }
            Ok(None) => {
                self.shutdown_child().await;
                let _ = reader.await;
                if self.reload.load(Ordering::SeqCst) {
                    return Ok(()); // the dev watcher stopped it mid-start
                }
                // stdout closed before ready: the process died. Maybe the port
                // was taken; let the next attempt pick a fresh one.
                self.port.store(0, Ordering::SeqCst);
                return Err(anyhow!("engine exited before reporting ready (see log for its output)"));
            }
            Err(_) => {
                self.shutdown_child().await;
                let _ = reader.await;
                return Err(anyhow!("engine did not report ready within 60 s"));
            }
        }

        let status = exit.await;
        let _ = reader.await;
        let mut guard = self.running.lock().await;
        if guard.as_ref().is_some_and(|r| r.pid == pid) {
            *guard = None;
        }
        drop(guard);
        let code = status.and_then(|s| s.code());
        // Quitting and a dev reload stop the engine on purpose.
        let quitting = self.stopped.load(Ordering::SeqCst);
        let asked = quitting || self.reload.load(Ordering::SeqCst);
        if asked {
            log::info!("engine stopped (exit code {code:?})");
        } else {
            log::warn!("engine exited with {code:?}");
        }
        self.update(|s| ended(s, quitting, asked, code));
        if !self.stopped.load(Ordering::SeqCst) {
            if let Some(state) = self.app.try_state::<crate::AppState>() {
                let host = state.host.clone();
                tauri::async_runtime::spawn(async move { host.stop().await });
            }
        }
        Ok(())
    }

    /// Both the supervisor and shutdown await the same real child.
    async fn shutdown_child(&self) {
        let mut guard = self.running.lock().await;
        if let Some(r) = guard.as_mut() {
            r.shutdown(Duration::from_secs(3)).await;
        }
        *guard = None;
    }

    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.shutdown_child().await;
        self.update(|s| {
            s.state = "stopped".into();
            s.pid = None;
            s.url = None;
            s.token = None;
        });
    }

    /// Synchronous best-effort stop for process exit paths.
    pub fn stop_blocking(&self) {
        tauri::async_runtime::block_on(async { let _ = tokio::time::timeout(Duration::from_secs(8), self.stop()).await; });
    }
}

/// Newest modification time of any file under `dirs` (None if none exist).
fn newest_mtime(dirs: &[PathBuf]) -> Option<SystemTime> {
    fn walk(dir: &Path, best: &mut Option<SystemTime>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                walk(&e.path(), best);
            } else if let Ok(m) = meta.modified() {
                if best.map_or(true, |b| m > b) {
                    *best = Some(m);
                }
            }
        }
    }
    let mut best = None;
    for d in dirs {
        walk(d, &mut best);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_waits_for_and_kills_the_real_child() {
        let mut cmd = tokio::process::Command::new("/bin/sleep");
        cmd.arg("30").stdin(Stdio::piped()).process_group(0);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdin = child.stdin.take();
        let mut tracked = Running::track(child, stdin, pid);
        let supervisor = tokio::spawn(tracked.exit.clone());
        tokio::time::timeout(Duration::from_secs(2), tracked.shutdown(Duration::from_millis(20))).await.unwrap();
        let status = supervisor.await.unwrap().unwrap();
        assert!(!status.success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_engine_that_ends_by_itself_takes_the_media_tools_it_started_with_it() {
        // An engine in its own process group starts a media tool and ends without stopping it, as it does on an
        // uncaught error. `sleep` stands in for ffmpeg, and the engine says its process id as it goes.
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & echo $!"]).stdin(Stdio::piped()).stdout(Stdio::piped()).process_group(0);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdin = child.stdin.take();
        let mut said = BufReader::new(child.stdout.take().unwrap()).lines();
        let tracked = Running::track(child, stdin, pid);
        let status = tokio::time::timeout(Duration::from_secs(10), tracked.exit.clone()).await.expect("the engine did not end");
        assert!(status.is_some_and(|s| s.success()));
        let tool = said.next_line().await.unwrap().expect("the media tool's process id");
        // The tool is gone within a moment. Left running, it would work on beside the engine that replaces this
        // one, which starts the same job again.
        let alive = || std::process::Command::new("kill").args(["-0", &tool]).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let outlived = alive();
        if outlived {
            let _ = std::process::Command::new("kill").args(["-KILL", &tool]).status();
        }
        assert!(!outlived, "the media tool outlived the engine that started it");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_crash_before_ready_does_not_wait_for_an_inherited_output_pipe() {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.args(["-c", "sleep 8 & exit 1"]).stdout(Stdio::piped()).process_group(0);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let (sender, ready) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            let line = output.next_line().await.unwrap();
            assert!(line.is_none());
            drop(sender);
        });
        let running = Running::track(child, None, pid);
        let result = tokio::time::timeout(Duration::from_secs(2), ready_before_exit(ready, running.exit)).await;
        if result.is_err() { kill_group(pid).await; }
        reader.await.unwrap();
        assert!(matches!(result, Ok(None)), "the startup handshake waited for the dead engine's media helper");
    }

    #[test]
    fn tells_the_window_its_engine_crashed_and_when_it_keeps_failing_to_start() {
        let ready = EngineStatus { state: "ready".into(), url: Some("http://127.0.0.1:4100".into()), token: Some("sct_t".into()), pid: Some(7), ..Default::default() };
        // A crash: the window is told the engine it was using has gone, so it says Scarlet is reconnecting.
        let mut crashed = ready.clone();
        ended(&mut crashed, false, false, Some(1));
        assert_eq!((crashed.state.as_str(), crashed.url.as_deref(), crashed.token.as_deref(), crashed.pid), ("starting", None, None, None));
        assert_eq!(crashed.error.as_deref(), Some("Scarlet’s engine stopped unexpectedly (exit code 1). Starting it again…"));
        let mut killed = ready.clone();
        ended(&mut killed, false, false, None);
        assert_eq!(killed.error.as_deref(), Some("Scarlet’s engine stopped unexpectedly. Starting it again…"));
        // A dev rebuild's restart and a quit are Scarlet's own doing, and carry no error.
        for (quitting, state) in [(false, "starting"), (true, "stopped")] {
            let mut asked = ready.clone();
            ended(&mut asked, quitting, true, Some(0));
            assert_eq!((asked.state.as_str(), asked.error.as_deref()), (state, None));
        }
        // Started again and failing: a wait at first. Failing on, the window says Scarlet couldn't start, with why,
        // while the engine is still started again.
        let mut failing = EngineStatus { state: "error".into(), error: Some("engine exited before reporting ready".into()), ..Default::default() };
        for (failed, state) in [(0, "starting"), (1, "starting"), (2, "starting"), (3, "error"), (4, "error")] {
            restarting(&mut failing, failed);
            assert_eq!(failing.state, state, "after {failed} failed starts in a row");
        }
        assert_eq!((failing.restarts, failing.error.as_deref()), (5, Some("engine exited before reporting ready")));
    }

    #[test]
    fn newest_mtime_sees_new_files() {
        let dir = std::env::temp_dir().join(format!("scarlet-mtime-{}", std::process::id()));
        let nested = dir.join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(newest_mtime(&[dir.clone()]), None);
        std::fs::write(nested.join("x.js"), "1").unwrap();
        let first = newest_mtime(&[dir.clone()]);
        assert!(first.is_some());
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("y.js"), "2").unwrap();
        assert!(newest_mtime(&[dir.clone(), dir.join("missing")]) > first);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_the_ready_line() {
        let line = r#"SCARLET_READY {"port":51234,"url":"http://127.0.0.1:51234","token":"sct_abc","userId":"usr_1","dataDir":"C:\\data"}"#;
        let info = parse_ready_line(line).unwrap();
        assert_eq!(info.port, 51234);
        assert_eq!(info.url, "http://127.0.0.1:51234");
        assert_eq!(info.token, "sct_abc");
        assert_eq!(info.user_id.as_deref(), Some("usr_1"));
        assert_eq!(info.data_dir.as_deref(), Some("C:\\data"));
        assert!(parse_ready_line("[skills] seeded 8 skill(s) from the bundled set").is_none());
        assert!(parse_ready_line("SCARLET_READY not json").is_none());
        assert!(parse_ready_line("").is_none());
        // Minimal payload still parses.
        assert!(parse_ready_line(r#"SCARLET_READY {"port":1,"url":"http://127.0.0.1:1","token":"t"}"#).is_some());
    }

    #[test]
    fn dev_prefers_checkout_even_when_a_packaged_engine_is_present() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join(sidecar_name());
        let cli = dir.path().join("cli.js");
        std::fs::write(&sidecar, vec![1; 2048]).unwrap();
        std::fs::write(&cli, "// fixture").unwrap();
        let home = crate::util::home_dir();
        let resolve = |dev, cmd| select_engine(&home, dev, Some(&sidecar), cmd, &cli);
        assert_eq!(resolve(true, None).unwrap().kind, "dev");
        assert_eq!(resolve(true, Some("custom-engine")).unwrap().program, "custom-engine");
        assert_eq!(resolve(false, None).unwrap().program, sidecar.to_string_lossy());
        std::fs::remove_file(&cli).unwrap();
        assert!(resolve(true, None).is_err());
    }

    #[test]
    fn dev_fallback_resolves_on_this_checkout() {
        // In this repo apps/server/dist exists, so the fallback must resolve to node + cli.js
        // (unless SCARLET_ENGINE_CMD is set in the environment).
        let l = resolve_engine_launch(&crate::util::home_dir(), None).unwrap();
        assert!(!l.program.is_empty());
        if l.kind == "dev" {
            assert!(l.prefix_args[0].replace('\\', "/").ends_with("apps/server/dist/cli.js"));
        }
    }

    #[test]
    fn a_packaged_app_runs_its_sidecar_unless_the_sidecar_is_a_placeholder() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::util::home_dir();
        let sidecar = dir.path().join(sidecar_name());
        let cli = dir.path().join("missing-cli.js");
        // The build script writes an empty file where the engine was never built.
        std::fs::write(&sidecar, "").unwrap();
        let packaged = |cmd| select_engine(&home, false, Some(&sidecar), cmd, &cli);
        let error = packaged(None).unwrap_err().to_string();
        assert!(error.starts_with("scarlet-engine sidecar not found"), "{error}");
        // SCARLET_ENGINE_CMD stands in for it, split the way a shell would.
        let env = packaged(Some(r#"node "/repo with space/cli.js" --inspect"#)).unwrap();
        assert_eq!((env.kind.as_str(), env.program.as_str(), env.prefix_args.as_slice()), ("env", "node", &["/repo with space/cli.js".to_string(), "--inspect".to_string()][..]));
        assert_eq!(env.describe(), "node /repo with space/cli.js --inspect");
        // Set to nothing, it is no command at all.
        assert!(packaged(Some("   ")).is_err());
        // A real sidecar wins over the variable in a packaged app, and a folder of that name is not one.
        std::fs::write(&sidecar, vec![0; 4096]).unwrap();
        assert_eq!(packaged(Some("node cli.js")).unwrap().kind, "sidecar");
        std::fs::remove_file(&sidecar).unwrap();
        std::fs::create_dir(&sidecar).unwrap();
        assert!(packaged(None).is_err());
        assert!(select_engine(&home, false, None, None, &cli).is_err());
        // In development the message says how to get an engine.
        let error = select_engine(&home, true, None, None, &cli).unwrap_err().to_string();
        assert!(error.contains("pnpm build"), "{error}");
    }

    #[test]
    fn reads_the_ready_line_only_in_the_engines_own_shape() {
        // Indented, as a wrapped launcher may print it.
        assert!(parse_ready_line(r#"   SCARLET_READY {"port":1,"url":"http://127.0.0.1:1","token":"t"}  "#).is_some());
        // Without a port, an address or a token there is nothing to connect to.
        for partial in [r#"{"url":"http://127.0.0.1:1","token":"t"}"#, r#"{"port":1,"token":"t"}"#, r#"{"port":1,"url":"http://127.0.0.1:1"}"#, r#"{"port":70000,"url":"u","token":"t"}"#] {
            assert!(parse_ready_line(&format!("SCARLET_READY {partial}")).is_none(), "{partial}");
        }
        // A line that only mentions it is log output.
        assert!(parse_ready_line(r#"[engine] printed SCARLET_READY {"port":1,"url":"u","token":"t"}"#).is_none());
    }

    #[test]
    fn an_engine_line_tagged_as_an_error_is_logged_as_one_from_either_stream() {
        use log::Level::{Error, Info, Warn};
        // A route that failed is written to stdout with the rest of the engine's log. A search of the app log for
        // ERROR has to find it.
        assert_eq!(engine_line_level("[error] POST /api/projects/prj_1/changes: Error: database is locked", false), Error);
        // The stack under it stays at the stream's level: one ERROR line for each fault.
        assert_eq!(engine_line_level("    at submitChange (file:///app/dist/services/changes.js:120:11)", false), Info);
        assert_eq!(engine_line_level("[skills] seeded 8 skill(s) from the bundled set", false), Info);
        // The uncaught error that stops the engine is written to stderr.
        assert_eq!(engine_line_level("[error] engine stopped on an uncaught error: Error: out of memory", true), Error);
        assert_eq!(engine_line_level("    at main (file:///app/dist/cli.js:96:5)", true), Warn);
        // The tag is the engine's own, at the start of a line. A line that only holds the word is log output.
        assert_eq!(engine_line_level("[transcribe] whisper-cli wrote: [error] no model", false), Info);
    }
}
