//! The assistants a host offers: finding them, their model lists and their subscription quota.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use super::catalog::{describe_agents, is_quota_eligible, lacks_models, take_catalog};
use super::types::{AgentAvailability, SubscriptionQuota};
use super::{detect, providers, update, HostRuntime, HostStatus};
use crate::util::child_env;

/// How long cached subscription quota stays fresh before a non-forced refresh re-probes.
const QUOTA_TTL: Duration = Duration::from_secs(60);

impl HostRuntime {
    /// Startup, sign-in and the picker can all request a fresh snapshot. `env` is the host's (`agent_env`): Ollama,
    /// LM Studio and OpenRouter are asked about beside the CLIs, and come after them.
    pub(super) async fn detect_agents(&self, env: &HashMap<String, String>) -> Option<String> {
        let _detecting = self.detecting.lock().await;
        let cli_env = providers::cli_env(env);
        let clis = async {
            let mut found = detect::detect(&cli_env, &self.paths.home, &self.models).await;
            self.mcp.load_catalogs(&mut found, &cli_env, &self.paths.custom_claude_models(), &self.paths.custom_gemini_models()).await;
            found
        };
        let (mut found, extra) = tokio::join!(clis, providers::detect(env, &self.models));
        let claude = found.iter().any(|a| a.id == "claude" && a.installed);
        found.extend(providers::through_claude(extra, claude));
        log::info!("assistants: {}", describe_agents(&found));
        let mut agents = self.agents.write().await;
        let mut failed = Vec::new();
        for agent in found.iter_mut() {
            // The update offered for this version stands until the next lookup (`check_updates`).
            if let Some(old) = agents.iter().find(|a| a.id == agent.id && a.version == agent.version) {
                agent.latest_version = old.latest_version.clone();
            }
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
                failed.push(providers::label(&agent.id).to_string());
            }
        }
        let error = (!failed.is_empty()).then(|| format!("Couldn't refresh models for {}. Try again.", failed.join(", ")));
        *agents = found;
        error
    }

    /// Probe subscription quota for eligible providers (cached with a 60 s TTL unless `force` is true).
    pub(super) async fn refresh_quota(&self, force: bool, only: Option<&[&str]>) -> HostStatus {
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

    /// Look up the newest version of each installed CLI and offer the ones Scarlet can update (`update::offers`).
    pub(super) async fn check_updates(&self) {
        let current = self.agents.read().await.clone();
        let offers = update::offers(&current, &child_env(&self.paths.home)).await;
        if self.cancel.is_cancelled() {
            return;
        }
        let mut changed = false;
        {
            let mut agents = self.agents.write().await;
            for agent in agents.iter_mut() {
                // An assistant detected again meanwhile at another version waits for the next lookup.
                let Some((_, offer)) = offers.iter().find(|(id, _)| *id == agent.id) else { continue };
                let was = current.iter().find(|a| a.id == agent.id).and_then(|a| a.version.clone());
                if agent.version == was && agent.latest_version != *offer {
                    agent.latest_version = offer.clone();
                    changed = true;
                }
            }
        }
        if changed {
            self.emit_status();
        }
    }

    /// Look for newer CLIs at start and every few hours while Scarlet stays open.
    pub(super) async fn update_check_loop(self: Arc<Self>) {
        loop {
            self.check_updates().await;
            tokio::select! {
                _ = self.cancel.cancelled() => return,
                _ = tokio::time::sleep(update::CHECK_EVERY) => {}
            }
        }
    }

    /// Apply a live quota update streamed during an active run (e.g. Codex `account/rateLimits/updated`).
    pub(super) fn apply_live_quota(self: &Arc<Self>, agent_id: &str, quota: SubscriptionQuota) {
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

    /// Ask again for the model list of each assistant that has none. True while one is still without.
    pub(super) async fn load_missing_catalogs(&self) -> bool {
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
    pub(super) async fn catalog_loop(self: Arc<Self>, waits: &'static [Duration]) {
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
}
