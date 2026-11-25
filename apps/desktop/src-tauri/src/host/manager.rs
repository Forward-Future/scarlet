//! The host the app runs: started for the engine it connects to, and swapped when the engine or its token changes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;

use super::api::Api;
use super::workspace::claude_config_dir;
use super::{detect, providers, Emit, HostIdSink, HostRuntime, HostStatus, McpLauncher, Undelivered};
use crate::config::{AppConfig, Paths};
use crate::util::human_duration;

fn host_name() -> String {
    let h = hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_else(|_| "scarlet-desktop".into());
    format!("{h} (desktop)")
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
            if tokio::time::timeout(Duration::from_secs(20), self.stop()).await.is_err() {
                log::warn!("[desktop] host-stop-timeout elapsedMs=20000");
            }
        });
    }

    /// Re-detect installed CLIs and push the result to the server.
    pub async fn refresh_agents(&self) -> HostStatus {
        let rt = self.runtime.lock().await.clone();
        let env = providers::host_env(&self.paths);
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
                let bg = rt.clone();
                tauri::async_runtime::spawn(async move { bg.check_updates().await });
                let mut status = rt.full_status().await;
                status.error = status.error.or(catalog_error);
                status
            }
            None => {
                let models = self.config.lock().unwrap().models.clone();
                let mcp = self.mcp.lock().unwrap().clone();
                let cli_env = providers::cli_env(&env);
                let clis = async {
                    let mut agents = detect::detect(&cli_env, &self.paths.home, &models).await;
                    if let Some(launcher) = &mcp { launcher.load_catalogs(&mut agents, &cli_env, &self.paths.custom_claude_models(), &self.paths.custom_gemini_models()).await; }
                    agents
                };
                let (mut agents, extra) = tokio::join!(clis, providers::detect(&env, &models));
                let claude = agents.iter().any(|a| a.id == "claude" && a.installed);
                agents.extend(providers::through_claude(extra, claude));
                HostStatus { agents, mcp_command: mcp.as_ref().map(|m| m.describe()), ..Default::default() }
            }
        };
        if !status.connected && status.error.is_none() {
            status.error = Some("The local agent host is offline. Try again when it connects.".into());
        }
        status
    }

    /// Whether a run is using `agent`'s CLI right now. It isn't updated under it.
    pub async fn is_running(&self, agent: &str) -> bool {
        let rt = self.runtime.lock().await.clone();
        rt.is_some_and(|rt| rt.running.lock().unwrap().values().any(|run| runs_on(&run.agent, agent)))
    }

    /// Look again for newer CLIs now, as after an update.
    pub async fn check_updates(&self) -> HostStatus {
        let rt = self.runtime.lock().await.clone();
        match rt {
            Some(rt) => {
                rt.check_updates().await;
                rt.full_status().await
            }
            None => self.status().await,
        }
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

/// Whether a run for `run_agent` has `cli`'s program running: its own, and Claude Code for a run with Ollama, LM Studio
/// or OpenRouter, which go through it.
pub(super) fn runs_on(run_agent: &str, cli: &str) -> bool {
    run_agent == cli || (cli == "claude" && providers::is_extra_provider(run_agent))
}

/// Five times the longest silence measured across real editing runs (1.9 minutes).
pub(super) const DEFAULT_STALL_MINUTES: u64 = 10;

/// The run limit and the stall limit from desktop.json (`timeoutMinutes`, `stallMinutes`).
/// 0 turns a limit off, as it does in the standalone host.
pub(super) fn run_limits(cfg: &AppConfig) -> (Option<Duration>, Option<Duration>) {
    let minutes = |m: u64| (m > 0).then(|| Duration::from_secs(m.saturating_mul(60)));
    (cfg.timeout_minutes.and_then(minutes), minutes(cfg.stall_minutes.unwrap_or(DEFAULT_STALL_MINUTES)))
}

/// Note the host id the engine assigned. True when desktop.json has to be saved.
/// The engine takes a new port at each launch, so an id filed under another address is never asked for again.
pub(super) fn remember_host_id(cfg: &mut AppConfig, server: &str, id: &str) -> bool {
    if cfg.host_ids.len() == 1 && cfg.host_ids.get(server).map(String::as_str) == Some(id) {
        return false;
    }
    cfg.host_ids.clear();
    cfg.host_ids.insert(server.to_string(), id.to_string());
    true
}
