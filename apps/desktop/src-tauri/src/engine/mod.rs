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

mod launch;

pub use launch::{dev_repo_root, parse_ready_line, resolve_engine_launch, EngineLaunch, ReadyInfo, READY_PREFIX};

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::config::Paths;
use crate::util::{engine_env, env_remove_ci, hide_console, lossy_lines};
use launch::{bundled_chrome, dev_whisper_cli, engine_line_level, newest_mtime, set_chrome_env, set_dev_whisper_env};

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
    // Usually nothing is left in the group, and `kill` only has that to say. Not starting it would leave the group running.
    if let Err(e) = tokio::process::Command::new("/bin/kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(Stdio::null()).status().await {
        log::warn!("[desktop] engine-group-kill-failed pid={pid} code={}", e.raw_os_error().unwrap_or(0));
    }
}

impl Running {
    fn track(mut child: Child, stdin: Option<ChildStdin>, pid: u32) -> Self {
        let force = CancellationToken::new();
        let stop = force.clone();
        // Windows: the engine and every media tool it starts are held in a job, which ends what is left of them when
        // this instance of the engine is over. Called right after the spawn, before the engine has started anything.
        #[cfg(windows)]
        let job = match child.raw_handle().map(crate::util::ProcessJob::hold) {
            Some(Ok(job)) => Some(job),
            Some(Err(e)) => {
                log::warn!("engine: could not hold its processes in a job, so a crash may leave media tools running: {e}");
                None
            }
            None => None,
        };
        let exit = async move {
            let status = tokio::select! {
                biased;
                status = child.wait() => {
                    // An engine that ends by itself signals nobody. The media tools it had started would work on
                    // beside the engine that replaces it, which starts the same jobs again.
                    #[cfg(unix)]
                    kill_group(pid).await;
                    status
                }
                _ = stop.cancelled() => {
                    #[cfg(windows)]
                    crate::util::kill_tree(pid).await;
                    #[cfg(unix)]
                    kill_group(pid).await;
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            // Closing the job ends whatever the engine left in it. On Windows `taskkill /T` can't find a tree under
            // an engine that has already ended.
            #[cfg(windows)]
            drop(job);
            status.inspect_err(|error| {
                log::warn!("[desktop] engine-wait-failed pid={pid} code={}", error.raw_os_error().unwrap_or(0));
            }).ok()
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

fn log_engine_exit(status: Option<ExitStatus>, pid: u32, stage: &str, outcome: &str, level: log::Level) {
    let code = status.and_then(|status| status.code()).map(|code| format!(" exitCode={code}")).unwrap_or_default();
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.and_then(|status| status.signal()).map(|signal| format!(" signal={signal}")).unwrap_or_default()
    };
    #[cfg(not(unix))]
    let signal = "";
    log::log!(level, "[desktop] engine-exit pid={pid} stage={stage} outcome={outcome}{code}{signal}");
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

/// The status once Scarlet has stopped the engine for good.
fn stopped(s: &mut EngineStatus) {
    s.state = "stopped".into();
    s.pid = None;
    s.url = None;
    s.token = None;
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

    /// Stopped, or started again since `generation`: whatever belongs to that start has nothing left to do.
    fn superseded(&self, generation: u64) -> bool {
        self.stopped.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation
    }

    fn update(&self, f: impl FnOnce(&mut EngineStatus)) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        crate::util::note_emit("engine://status", self.app.emit("engine://status", &snapshot));
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
                log::error!("engine: cannot start, no engine to run: {e:#}");
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
            if self.superseded(generation) {
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
            if self.superseded(generation) {
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
            if self.superseded(generation) {
                self.update(stopped);
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
            backoff(&self.reload, &self.reload_now, delay).await;
        }
    }

    /// The engine's environment: the user's, with the media tools, browser, data folder and dev seeds it runs with.
    fn launch_env(&self, launch: &EngineLaunch) -> HashMap<String, String> {
        let mut env = engine_env(&self.paths.home);
        // Node's 4 default threads serve every file read, stat and streamed range, so a playing video
        // and a cache scan queue behind each other. Respect a value the user set.
        env.entry("UV_THREADPOOL_SIZE".into()).or_insert_with(|| "16".into());
        crate::crisper::set_adapter_env(&mut env, self.paths.resource_dir.as_deref(), tauri::is_dev());
        if let Some(res) = &self.paths.resource_dir {
            let bin = res.join("bin");
            let ff = bin.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
            if ff.is_file() {
                env.insert("SCARLET_BIN_DIR".into(), bin.to_string_lossy().to_string());
            }
        }
        if launch.kind != "sidecar" {
            // Tauri places the media tools, whisper-cli among them, beside the desktop executable. A dev engine, or one
            // from SCARLET_ENGINE_CMD, runs under Node elsewhere and would otherwise find no local transcription runtime.
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    env.entry("SCARLET_BIN_DIR".into()).or_insert_with(|| dir.to_string_lossy().into_owned());
                }
            }
            // Fresh dev worktrees carry a zero-byte whisper-cli placeholder; reuse the main checkout's or installed app's.
            set_dev_whisper_env(&mut env, || dev_whisper_cli(&dev_repo_root(), env!("SCARLET_BUILD_TARGET"), &self.paths.home));
        }
        if launch.kind == "dev" {
            let skills = dev_repo_root().join("skills");
            if skills.is_dir() && !env.contains_key("SCARLET_SKILLS_SEED") {
                env.insert("SCARLET_SKILLS_SEED".into(), skills.to_string_lossy().to_string());
            }
        }
        set_chrome_env(&mut env, bundled_chrome(self.paths.resource_dir.as_deref(), tauri::is_dev()).as_deref());
        env.insert("SCARLET_DATA".into(), self.paths.data_dir.to_string_lossy().to_string());
        // Only the public packages are built for a release feed. The engine reports usage under the `release` channel
        // only with it, so source, local-main and review builds count as `dev` (docs/telemetry.md).
        apply_release_channel(&mut env, option_env!("SCARLET_RELEASE_CHANNEL"));
        env
    }

    async fn run_once(&self, launch: &EngineLaunch, generation: u64) -> Result<()> {
        let env = self.launch_env(launch);

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
        if self.superseded(generation) {
            return Ok(());
        }
        log::info!("engine: spawning {} serve --solo --data {} --port {port}", launch.describe(), self.paths.data_dir.display());
        let spawned = Instant::now();
        let mut child = cmd.spawn().map_err(|e| anyhow!("spawn engine ({}): {e}", launch.program))?;
        let pid = child.id().ok_or_else(|| anyhow!("engine has no process id"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("engine stdout not captured"))?;
        if let Some(stderr) = child.stderr.take() {
            log_stderr(stderr, pid);
        }
        let tracked = Running::track(child, stdin, pid);
        let exit = tracked.exit.clone();
        *running = Some(tracked);
        drop(running);
        self.update(|s| s.pid = Some(pid));

        // Wait for the ready line (other log lines may precede it).
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<ReadyInfo>();
        let reader = read_stdout(stdout, pid, ready_tx);

        let ready = tokio::time::timeout(Duration::from_secs(60), ready_before_exit(ready_rx, exit.clone())).await;
        match ready {
            Ok(Some(info)) => {
                if self.generation.load(Ordering::SeqCst) != generation {
                    // stop() owns the child. A late ready line must not restart the host.
                    return Ok(());
                }
                log::info!("[desktop] engine-ready pid={pid} stage=startup kind={} elapsedMs={}", launch.kind, spawned.elapsed().as_millis());
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
                    let (url, token) = (info.url, info.token);
                    tauri::async_runtime::spawn(async move { host.configure(&url, &token).await });
                }
            }
            Ok(None) => {
                self.shutdown_child().await;
                let _ = reader.await;
                if self.reload.load(Ordering::SeqCst) {
                    return Ok(()); // the dev watcher stopped it mid-start
                }
                log_engine_exit(exit.await, pid, "startup", "early_exit", log::Level::Warn);
                // stdout closed before ready: the process died. Maybe the port
                // was taken; let the next attempt pick a fresh one.
                self.port.store(0, Ordering::SeqCst);
                return Err(anyhow!("engine exited before reporting ready (see log for its output)"));
            }
            Err(_) => {
                self.shutdown_child().await;
                let _ = reader.await;
                log_engine_exit(exit.await, pid, "startup", "timeout", log::Level::Warn);
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
            log_engine_exit(status, pid, "running", if quitting { "quit" } else { "reload" }, log::Level::Info);
        } else {
            log_engine_exit(status, pid, "running", "unexpected", log::Level::Warn);
        }
        self.update(|s| ended(s, quitting, asked, code));
        if !self.stopped.load(Ordering::SeqCst) {
            if let Some(state) = self.app.try_state::<crate::AppState>() {
                let host = state.host.clone();
                tauri::async_runtime::spawn(async move { if asked { host.stop().await } else { host.stop_for_lost_engine().await } });
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
        self.update(stopped);
    }

    /// Synchronous best-effort stop for process exit paths.
    pub fn stop_blocking(&self) {
        tauri::async_runtime::block_on(async {
            if tokio::time::timeout(Duration::from_secs(8), self.stop()).await.is_err() {
                log::warn!("[desktop] engine-stop-timeout elapsedMs=8000");
            }
        });
    }
}

/// Set or strip `SCARLET_RELEASE_CHANNEL` case-insensitively so Windows environment maps cannot keep a differently
/// cased inherited entry beside it.
fn apply_release_channel(env: &mut HashMap<String, String>, channel: Option<&str>) {
    env_remove_ci(env, &["SCARLET_RELEASE_CHANNEL"]);
    if let Some(channel) = channel.map(str::trim).filter(|channel| !channel.is_empty()) {
        env.insert("SCARLET_RELEASE_CHANNEL".into(), channel.into());
    }
}

/// Log each line the engine writes to stderr.
fn log_stderr(stderr: ChildStderr, pid: u32) {
    tokio::spawn(async move {
        let mut lines = lossy_lines(stderr);
        loop {
            match lines.next_line().await {
                Ok(Some(l)) => log::log!(engine_line_level(&l, true), "[engine] {l}"),
                Ok(None) => break,
                Err(error) => {
                    log::warn!("[desktop] engine-output-failed pid={pid} stage=stderr code={}", error.raw_os_error().unwrap_or(0));
                    break;
                }
            }
        }
    });
}

/// Read the engine's stdout to its end: log each line, and send the ready line's details once.
fn read_stdout(stdout: ChildStdout, pid: u32, ready_tx: tokio::sync::oneshot::Sender<ReadyInfo>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tx = Some(ready_tx);
        let mut lines = lossy_lines(stdout);
        loop {
            let l = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    log::warn!("[desktop] engine-output-failed pid={pid} stage=stdout code={}", error.raw_os_error().unwrap_or(0));
                    break;
                }
            };
            if l.trim_start().starts_with(READY_PREFIX) {
                if let Some(info) = parse_ready_line(&l) {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(info);
                    }
                } else {
                    // A partial or malformed handshake can still carry the session credential.
                    log::warn!("[desktop] engine-handshake-invalid pid={pid} stage=startup");
                }
                continue;
            }
            log::log!(engine_line_level(&l, false), "[engine] {l}");
        }
    })
}

/// The wait before a crashed engine starts again. A dev rebuild (e.g. fixing the crash) cuts it short, but only one
/// that set `reload`: the permit an earlier rebuild left on `notify` while the engine ran doesn't skip the wait.
async fn backoff(reload: &AtomicBool, notify: &Notify, delay: Duration) {
    let deadline = tokio::time::Instant::now() + delay;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            _ = notify.notified() => if reload.swap(false, Ordering::SeqCst) { break },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[tokio::test]
    async fn a_rebuild_signal_left_over_from_a_healthy_run_does_not_skip_the_crash_backoff() {
        let (reload, notify) = (AtomicBool::new(false), Notify::new());
        // A rebuild while the engine ran: its reload was handled through the flag, its permit is still stored.
        notify.notify_one();
        let started = Instant::now();
        backoff(&reload, &notify, Duration::from_millis(300)).await;
        assert!(started.elapsed() >= Duration::from_millis(300));
    }

    #[tokio::test]
    async fn a_rebuild_during_the_crash_backoff_cuts_it_short() {
        let state = Arc::new((AtomicBool::new(false), Notify::new()));
        let rebuild = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            rebuild.0.store(true, Ordering::SeqCst);
            rebuild.1.notify_one();
        });
        let started = Instant::now();
        backoff(&state.0, &state.1, Duration::from_secs(10)).await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!state.0.load(Ordering::SeqCst));
    }

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

    #[cfg(windows)]
    #[tokio::test]
    async fn an_engine_that_ends_by_itself_on_windows_takes_the_media_tools_it_started_with_it() {
        // Node stands in for the engine. It starts a media tool apart from itself, as one started through a shell
        // or a launcher is, says its process id and ends without stopping it, as it does on an uncaught error.
        let node = crate::host::spawn::find_on_path("node", &crate::util::env_map()).expect("node");
        let script = "const t=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});t.unref();console.log(t.pid)";
        let mut cmd = tokio::process::Command::new(&node);
        cmd.args(["-e", script]).stdin(Stdio::piped()).stdout(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdin = child.stdin.take();
        let mut said = lossy_lines(child.stdout.take().unwrap());
        let tracked = Running::track(child, stdin, pid);
        let tool = said.next_line().await.unwrap().expect("the media tool's process id");
        let status = tokio::time::timeout(Duration::from_secs(10), tracked.exit.clone()).await.expect("the engine did not end");
        assert!(status.is_some_and(|s| s.success()));
        let alive = || {
            let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {tool}"), "/FO", "CSV", "/NH"]).output();
            out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{tool}\"")))
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let outlived = alive();
        if outlived {
            let _ = std::process::Command::new("taskkill").args(["/PID", &tool, "/F"]).output();
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
    fn sets_or_clears_release_channel_case_insensitively() {
        let mut env = HashMap::from([("scarlet_release_channel".to_string(), "".to_string())]);
        apply_release_channel(&mut env, Some("stable"));
        assert_eq!(env.len(), 1);
        assert_eq!(env.get("SCARLET_RELEASE_CHANNEL").map(String::as_str), Some("stable"));

        let mut dev_env = HashMap::from([("Scarlet_Release_Channel".to_string(), "stable".to_string())]);
        apply_release_channel(&mut dev_env, None);
        assert!(dev_env.is_empty());
    }
}
