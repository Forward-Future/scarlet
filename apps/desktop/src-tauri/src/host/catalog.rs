//! MCP stdio launcher and CLI model-catalog discovery/merging.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use serde_json::Value;

use super::detect;
use super::spawn;
use super::types::{AgentAvailability, McpSpec, SubscriptionQuota, CLI_AGENTS};
use crate::engine::EngineLaunch;

/// Subscriptions only: omit quota when a provider is signed in via API key or not signed in.
pub(super) fn is_quota_eligible(agent: &AgentAvailability) -> bool {
    CLI_AGENTS.contains(&agent.id.as_str())
        && agent.installed
        && agent.logged_in != Some(false)
        && agent.auth.as_deref() != Some("api_key")
}

/// How long the host waits before each new try at a model list it could not read at launch: 30 seconds after it
/// registers, then 1, 2 and 5 minutes on.
pub(super) const CATALOG_RETRY_WAITS: [Duration; 4] = [
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
];

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
    pub(super) async fn load_catalogs(&self, agents: &mut [AgentAvailability], env: &HashMap<String, String>, extra_claude: &[String], extra_gemini: &[String]) {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Catalog {
            models: Vec<String>,
            model: Option<String>,
            #[serde(default)]
            plan: Option<String>,
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
                if a.plan.is_none() {
                    a.plan = catalog.plan;
                }
                take_catalog(a, catalog.model, catalog.model_options, Some(catalog.models), catalog.model_labels);
            }
        }
    }

    /// Query zero-token subscription quota for eligible providers via the engine CLI.
    pub(super) async fn load_quotas(&self, agents: &[AgentAvailability], env: &HashMap<String, String>) -> Vec<(String, SubscriptionQuota)> {
        let probes = agents.iter().filter(|a| is_quota_eligible(a)).map(|a| async move {
            let file = spawn::find_on_path(detect::cli_binary(&a.id), env)?;
            let mut args = self.prefix_args.clone();
            args.extend(["subscription-quota".into(), a.id.clone(), file]);
            let probe_env = detect::runner_env(&a.id, std::slice::from_ref(a), env);
            let result = spawn::exec_capture(&self.program, &args, &probe_env, Duration::from_secs(18)).await;
            if result.code != Some(0) {
                log::debug!("[host] subscription-quota provider={} code={:?}", a.id, result.code);
                return None;
            }
            let trimmed = result.stdout.trim();
            if trimmed.is_empty() || trimmed == "null" {
                return None;
            }
            let quota = serde_json::from_str::<SubscriptionQuota>(trimmed).ok()?;
            Some((a.id.clone(), quota))
        });
        futures_util::future::join_all(probes).await.into_iter().flatten().collect()
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
pub(super) fn take_catalog(agent: &mut AgentAvailability, model: Option<String>, options: BTreeMap<String, Value>, models: Option<Vec<String>>, labels: BTreeMap<String, String>) {
    if agent.model.is_none() { agent.model = model; }
    agent.model_options = options;
    agent.models = models;
    agent.model_labels = labels;
}

/// An assistant that could run a task and has no model list: the picker offers no model for it, so nothing can be
/// sent to it.
pub(super) fn lacks_models(agent: &AgentAvailability) -> bool {
    agent.installed && agent.logged_in != Some(false) && agent.models.is_none()
}

/// What detection found, on one log line: "claude 2.1.3 (signed in, subscription, 4 models); codex not installed".
pub(super) fn describe_agents(agents: &[AgentAvailability]) -> String {
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
