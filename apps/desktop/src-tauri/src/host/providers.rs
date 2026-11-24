//! Ollama, LM Studio and OpenRouter: model servers the editor's runs reach through Claude Code, pointed at each one's
//! Anthropic-compatible address. Their settings (Settings › Models, kept in `providers.json`), finding them and their
//! models, and the environment a run on one of them gets.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::types::{AgentAvailability, EXTRA_PROVIDERS};
use super::HostRuntime;
use crate::config::Paths;
use crate::util::{child_env, env_get, env_remove_ci};

pub const OLLAMA_DEFAULT_URL: &str = "http://127.0.0.1:11434";
pub const LMSTUDIO_DEFAULT_URL: &str = "http://127.0.0.1:1234";
/// Claude Code adds `/v1/messages` itself.
pub const OPENROUTER_URL: &str = "https://openrouter.ai/api";
const OLLAMA_PORT: u16 = 11434;
const LMSTUDIO_PORT: u16 = 1234;

/// Set in the host's environment when the editor turned a provider off in Settings.
const OLLAMA_OFF: &str = "SCARLET_OLLAMA_DISABLED";
const LMSTUDIO_OFF: &str = "SCARLET_LMSTUDIO_DISABLED";
const OPENROUTER_OFF: &str = "SCARLET_OPENROUTER_DISABLED";
/// Set when OPENROUTER_API_KEY came from Settings rather than the editor's own environment: only an OpenRouter run
/// gets it then.
const KEY_SAVED: &str = "SCARLET_OPENROUTER_KEY_SAVED";

pub const NO_OPENROUTER_KEY: &str = "Add an OpenRouter key in Settings › Models to use OpenRouter.";

/// A Claude Code login or cloud setting that would send a provider's run somewhere else.
const ELSEWHERE: [&str; 6] = [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
];
/// Every model Claude Code might pick for itself, so the whole run stays on the one the editor chose.
const MODEL_VARS: [&str; 6] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

/// Ollama, LM Studio or OpenRouter.
pub fn is_extra_provider(id: &str) -> bool {
    EXTRA_PROVIDERS.contains(&id)
}

/// A server on this computer, sharing its one GPU.
pub fn is_local(id: &str) -> bool {
    matches!(id, "ollama" | "lmstudio")
}

/// The assistant's name as Settings shows it.
pub fn label(id: &str) -> &str {
    match id {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "gemini" => "Gemini",
        "ollama" => "Ollama",
        "lmstudio" => "LM Studio",
        "openrouter" => "OpenRouter",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// What the editor saved in Settings › Models (`providers.json`). The environment fills in what it leaves out.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderSettings {
    pub ollama: LocalSettings,
    pub lmstudio: LocalSettings,
    pub openrouter: KeySettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct KeySettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
}

/// The key is never printed.
impl std::fmt::Debug for KeySettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeySettings").field("api_key", &self.api_key.as_ref().map(|_| "[saved]")).field("disabled", &self.disabled).finish()
    }
}

/// One save at a time, so two quick changes in Settings don't undo each other.
pub static SAVING: StdMutex<()> = StdMutex::new(());

/// What Settings shows. The key itself never leaves this process.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub ollama: LocalView,
    pub lmstudio: LocalView,
    pub openrouter: KeyView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalView {
    pub url: Option<String>,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyView {
    pub has_key: bool,
    pub key_from_env: bool,
    pub disabled: bool,
}

/// What Settings shows, from the saved settings and the editor's own environment (`child_env`).
pub fn view(s: &ProviderSettings, env: &HashMap<String, String>) -> SettingsView {
    let saved_key = s.openrouter.api_key.as_deref().is_some_and(|k| !k.trim().is_empty());
    let env_key = env_get(env, "OPENROUTER_API_KEY").is_some_and(|k| !k.trim().is_empty());
    let local = |l: &LocalSettings| LocalView { url: l.url.clone(), disabled: l.disabled };
    SettingsView {
        ollama: local(&s.ollama),
        lmstudio: local(&s.lmstudio),
        openrouter: KeyView { has_key: saved_key || env_key, key_from_env: !saved_key && env_key, disabled: s.openrouter.disabled },
    }
}

/// One field of a save: left as it was, cleared, or set.
#[derive(Debug, Clone, PartialEq)]
pub enum Change<T> {
    Keep,
    Clear,
    Set(T),
}

/// A save from Settings: `{ provider, url?, apiKey?, disabled? }`. A field left out stays as it was; null or empty
/// text clears it.
#[derive(Clone, PartialEq)]
pub struct SettingsPatch {
    pub provider: String,
    pub url: Change<String>,
    pub api_key: Change<String>,
    pub disabled: Option<bool>,
}

impl SettingsPatch {
    /// Read the arguments the window sent, as they came: whether a field is there at all matters.
    pub fn from_args(args: &Value) -> Result<Self, String> {
        let provider = args.get("provider").and_then(Value::as_str).filter(|p| is_extra_provider(p)).ok_or("Unknown provider.")?;
        let text = |key: &str| -> Result<Change<String>, String> {
            match args.get(key) {
                None => Ok(Change::Keep),
                Some(Value::Null) => Ok(Change::Clear),
                Some(Value::String(s)) if s.trim().is_empty() => Ok(Change::Clear),
                Some(Value::String(s)) => Ok(Change::Set(s.trim().to_string())),
                Some(_) => Err(format!("{key} must be text.")),
            }
        };
        let url = match text("url")? {
            Change::Set(raw) => {
                let default_port = if provider == "ollama" { OLLAMA_PORT } else { LMSTUDIO_PORT };
                Change::Set(normalize_host(&raw, default_port).ok_or("Enter an address with http:// or https://, or host:port.")?)
            }
            other => other,
        };
        let api_key = text("apiKey")?;
        let disabled = match args.get("disabled") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err("disabled must be true or false.".into()),
        };
        if provider == "openrouter" && url != Change::Keep {
            return Err("OpenRouter's address can't be changed.".into());
        }
        if provider != "openrouter" && api_key != Change::Keep {
            return Err(format!("{} takes no key.", label(provider)));
        }
        Ok(SettingsPatch { provider: provider.to_string(), url, api_key, disabled })
    }

    pub fn apply(&self, s: &mut ProviderSettings) {
        fn change(field: &mut Option<String>, c: &Change<String>) {
            match c {
                Change::Keep => {}
                Change::Clear => *field = None,
                Change::Set(v) => *field = Some(v.clone()),
            }
        }
        match self.provider.as_str() {
            "ollama" | "lmstudio" => {
                let local = if self.provider == "ollama" { &mut s.ollama } else { &mut s.lmstudio };
                change(&mut local.url, &self.url);
                if let Some(d) = self.disabled {
                    local.disabled = d;
                }
            }
            "openrouter" => {
                change(&mut s.openrouter.api_key, &self.api_key);
                if let Some(d) = self.disabled {
                    s.openrouter.disabled = d;
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Where each one is
// ---------------------------------------------------------------------------

/// A server address as Ollama reads OLLAMA_HOST: `host:port`, a bare host, `0.0.0.0` (which means this computer) or a
/// full address. Without a scheme it is http, on `default_port` unless it names one. A trailing `/v1` is dropped:
/// Claude Code adds it. None for an address that isn't http(s).
pub fn normalize_host(raw: &str, default_port: u16) -> Option<String> {
    let raw = raw.trim();
    let has_scheme = raw.contains("://");
    let raw = if has_scheme { raw } else { raw.trim_end_matches('/') };
    if raw.is_empty() {
        return None;
    }
    let text = match (has_scheme, raw.starts_with(':')) {
        (true, _) => raw.to_string(),
        (false, true) => format!("http://127.0.0.1{raw}"),
        (false, false) => format!("http://{raw}"),
    };
    let mut url = reqwest::Url::parse(&text).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if matches!(url.host_str()?, "0.0.0.0" | "[::]") {
        url.set_host(Some("127.0.0.1")).ok()?;
    }
    if !has_scheme && url.port().is_none() && default_port != 0 {
        url.set_port(Some(default_port)).ok()?;
    }
    url.set_query(None);
    url.set_fragment(None);
    let mut out = url.to_string();
    while out.ends_with('/') {
        out.pop();
    }
    if let Some(base) = out.strip_suffix("/v1") {
        out = base.to_string();
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Local {
    pub url: String,
    pub disabled: bool,
}

#[derive(Clone, PartialEq)]
pub struct Remote {
    pub key: Option<String>,
    pub disabled: bool,
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remote").field("key", &self.key.as_ref().map(|_| "[set]")).field("disabled", &self.disabled).finish()
    }
}

/// Where each provider is and whether it is on, as the host's environment (`with_settings`) says.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub ollama: Local,
    pub lmstudio: Local,
    pub openrouter: Remote,
}

pub fn resolve(env: &HashMap<String, String>) -> Resolved {
    let off = |k: &str| env_get(env, k).is_some_and(|v| !v.is_empty() && v != "0");
    let host = |var: &str, port: u16, default: &str| env_get(env, var).and_then(|v| normalize_host(v, port)).unwrap_or_else(|| default.to_string());
    Resolved {
        ollama: Local { url: host("OLLAMA_HOST", OLLAMA_PORT, OLLAMA_DEFAULT_URL), disabled: off(OLLAMA_OFF) },
        lmstudio: Local { url: host("LMSTUDIO_HOST", LMSTUDIO_PORT, LMSTUDIO_DEFAULT_URL), disabled: off(LMSTUDIO_OFF) },
        openrouter: Remote {
            key: env_get(env, "OPENROUTER_API_KEY").map(str::trim).filter(|k| !k.is_empty()).map(str::to_string),
            disabled: off(OPENROUTER_OFF),
        },
    }
}

fn set_var(env: &mut HashMap<String, String>, key: &str, value: &str) {
    env_remove_ci(env, &[key]);
    env.insert(key.to_string(), value.to_string());
}

/// The environment with the saved settings in it. They win over the editor's own variables.
pub fn with_settings(mut env: HashMap<String, String>, s: &ProviderSettings) -> HashMap<String, String> {
    for (host, off, local) in [("OLLAMA_HOST", OLLAMA_OFF, &s.ollama), ("LMSTUDIO_HOST", LMSTUDIO_OFF, &s.lmstudio)] {
        if let Some(url) = local.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            set_var(&mut env, host, url);
        }
        if local.disabled {
            set_var(&mut env, off, "1");
        }
    }
    if let Some(key) = s.openrouter.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        set_var(&mut env, "OPENROUTER_API_KEY", key);
        set_var(&mut env, KEY_SAVED, "1");
    }
    if s.openrouter.disabled {
        set_var(&mut env, OPENROUTER_OFF, "1");
    }
    env
}

/// The environment for the three CLIs: a key saved in Settings is OpenRouter's alone.
pub fn cli_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = env.clone();
    if env_get(&out, KEY_SAVED).is_some() {
        env_remove_ci(&mut out, &["OPENROUTER_API_KEY", KEY_SAVED]);
    }
    out
}

/// The host's environment for its assistants: `child_env` with the saved provider settings in it.
pub fn host_env(paths: &Paths) -> HashMap<String, String> {
    with_settings(child_env(&paths.home), &paths.provider_settings())
}

impl HostRuntime {
    /// The environment detection and runs start from (`host_env`).
    pub(super) fn agent_env(&self) -> HashMap<String, String> {
        host_env(&self.paths)
    }
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

/// Claude Code's environment for a run on `agent`: pointed at the provider, with its token and the chosen model for
/// everything Claude Code does.
pub fn run_env(agent: &str, model: Option<&str>, env: &HashMap<String, String>) -> Result<HashMap<String, String>, String> {
    let r = resolve(env);
    let (base, token) = match agent {
        "ollama" => (r.ollama.url, "ollama".to_string()),
        "lmstudio" => (r.lmstudio.url, "lmstudio".to_string()),
        "openrouter" => (OPENROUTER_URL.to_string(), r.openrouter.key.ok_or(NO_OPENROUTER_KEY)?),
        other => return Err(format!("no runner for agent \"{other}\"")),
    };
    let model = model.filter(|m| !m.is_empty()).ok_or_else(|| format!("Choose a model for {} first.", label(agent)))?;
    let mut out = env.clone();
    env_remove_ci(&mut out, &ELSEWHERE);
    env_remove_ci(&mut out, &MODEL_VARS);
    env_remove_ci(&mut out, &["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", KEY_SAVED]);
    out.insert("ANTHROPIC_BASE_URL".into(), base);
    out.insert("ANTHROPIC_AUTH_TOKEN".into(), token);
    // There but empty, so Claude Code takes the token and no key of the editor's.
    out.insert("ANTHROPIC_API_KEY".into(), String::new());
    for var in MODEL_VARS {
        out.insert(var.into(), model.to_string());
    }
    out.insert("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into());
    // The same prompt start on every turn, so a local server can reuse what it has already read.
    out.insert("CLAUDE_CODE_ATTRIBUTION_HEADER".into(), "0".into());
    Ok(out)
}

/// What a provider's run also puts in Claude Code's `--settings`, so an `env` block in the editor's own
/// ~/.claude/settings.json can't send it elsewhere. Never a key: the command line can be read by other programs.
const SETTINGS_VARS: [&str; 10] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_ATTRIBUTION_HEADER",
];

/// The `env` for Claude Code's `--settings` on a provider's run (`run_env` made `env`). None for Claude's own runs.
pub fn settings_env(agent: &str, env: &HashMap<String, String>) -> Option<BTreeMap<String, String>> {
    if !is_extra_provider(agent) {
        return None;
    }
    Some(SETTINGS_VARS.iter().filter_map(|k| env.get(*k).map(|v| (k.to_string(), v.clone()))).collect())
}

// ---------------------------------------------------------------------------
// Finding them
// ---------------------------------------------------------------------------

/// What a server answered: its models (id and name), its version, and whether it took the key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Found {
    pub models: Vec<(String, String)>,
    pub version: Option<String>,
    pub signed_in: bool,
}

/// The same check a run makes on its model (`run_agent`).
pub fn valid_model_id(m: &str) -> bool {
    m.starts_with(|c: char| c.is_ascii_alphanumeric()) && m.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@+[]-".contains(c))
}

/// Ollama's `/api/tags`: the name of each model it has.
pub fn ollama_names(tags: &Value) -> Vec<String> {
    let list = tags.get("models").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    list.iter().filter_map(|m| m.get("name").or_else(|| m.get("model")).and_then(Value::as_str)).map(str::to_string).collect()
}

/// Whether a model can edit: Ollama's `/api/show` lists `tools` among its capabilities. An older Ollama lists none,
/// and then only an embedding model is left out.
pub fn ollama_keeps(name: &str, show: Option<&Value>) -> bool {
    match show.and_then(|s| s.get("capabilities")).and_then(Value::as_array) {
        Some(caps) => caps.iter().any(|c| c.as_str() == Some("tools")),
        None => !name.to_ascii_lowercase().contains("embed"),
    }
}

/// LM Studio's `/api/v0/models`: its language and vision models. None when the answer has no list.
pub fn lmstudio_models(v0: &Value) -> Option<Vec<String>> {
    let list = v0.get("data")?.as_array()?;
    Some(list.iter()
        .filter(|m| matches!(m.get("type").and_then(Value::as_str), Some("llm" | "vlm")))
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

/// An OpenAI-style `/v1/models`, without embedding models.
pub fn openai_models(v1: &Value) -> Vec<String> {
    let list = v1.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    list.iter().filter_map(|m| m.get("id").and_then(Value::as_str)).filter(|id| !id.to_ascii_lowercase().contains("embed")).map(str::to_string).collect()
}

/// OpenRouter's `/v1/models`: each model's id and name.
pub fn openrouter_models(v: &Value) -> Vec<(String, String)> {
    let list = v.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    list.iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(Value::as_str)?;
            let name = m.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or(id);
            Some((id.to_string(), name.to_string()))
        })
        .collect()
}

/// The assistant entry for what a provider answered. One that didn't answer is not installed.
pub fn availability(id: &str, found: Option<Found>, model: Option<&String>) -> AgentAvailability {
    let Some(found) = found else {
        return AgentAvailability { id: id.into(), ..Default::default() };
    };
    let mut ids = Vec::new();
    let mut labels = BTreeMap::new();
    let mut options = BTreeMap::new();
    for (m, name) in found.models {
        if !valid_model_id(&m) || labels.contains_key(&m) {
            continue;
        }
        ids.push(m.clone());
        options.insert(m.clone(), json!({ "efforts": [], "speeds": [] }));
        labels.insert(m, name);
    }
    AgentAvailability {
        id: id.into(),
        installed: true,
        logged_in: Some(found.signed_in),
        auth: (id == "openrouter").then(|| super::detect::API_KEY.to_string()),
        version: found.version,
        model: model.cloned(),
        models: Some(ids),
        model_labels: labels,
        model_options: options,
        ..Default::default()
    }
}

fn client(local: bool) -> Option<reqwest::Client> {
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(3)).connect_timeout(Duration::from_secs(2));
    // A proxy set for the internet has nothing to do with a server on this computer.
    let builder = if local { builder.no_proxy() } else { builder.https_only(true) };
    builder.build().ok()
}

/// The JSON a request answered with, or the status it failed with (None when it got no answer).
async fn fetch(request: reqwest::RequestBuilder) -> Result<Value, Option<u16>> {
    let response = request.send().await.map_err(|_| None)?;
    let status = response.status();
    if !status.is_success() {
        return Err(Some(status.as_u16()));
    }
    response.json().await.map_err(|_| None)
}

pub async fn probe_ollama(url: &str) -> Option<Found> {
    let client = client(true)?;
    let (tags, version) = tokio::join!(fetch(client.get(format!("{url}/api/tags"))), fetch(client.get(format!("{url}/api/version"))));
    let names = ollama_names(&tags.ok()?);
    let shows = futures_util::future::join_all(names.iter().map(|name| fetch(client.post(format!("{url}/api/show")).json(&json!({ "model": name }))))).await;
    let models = names.into_iter().zip(shows).filter(|(name, show)| ollama_keeps(name, show.as_ref().ok())).map(|(name, _)| (name.clone(), name)).collect();
    let version = version.ok().and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string));
    Some(Found { models, version, signed_in: true })
}

pub async fn probe_lmstudio(url: &str) -> Option<Found> {
    let client = client(true)?;
    let native = fetch(client.get(format!("{url}/api/v0/models"))).await.ok().and_then(|v| lmstudio_models(&v));
    let ids = match native {
        Some(ids) => ids,
        None => openai_models(&fetch(client.get(format!("{url}/v1/models"))).await.ok()?),
    };
    Some(Found { models: ids.into_iter().map(|id| (id.clone(), id)).collect(), version: None, signed_in: true })
}

/// `base` is OPENROUTER_URL outside tests.
pub async fn probe_openrouter(base: &str, key: &str) -> Option<Found> {
    let client = if base == OPENROUTER_URL { client(false)? } else { client(true)? };
    let (models, account) = tokio::join!(
        fetch(client.get(format!("{base}/v1/models?supported_parameters=tools"))),
        fetch(client.get(format!("{base}/v1/key")).bearer_auth(key)),
    );
    let models = openrouter_models(&models.ok()?);
    Some(Found { models, version: None, signed_in: !matches!(account, Err(Some(401 | 403))) })
}

/// One entry per provider, in the order Ollama, LM Studio, OpenRouter. Each asks its server at once, briefly, and one
/// that doesn't answer is just not installed.
pub async fn detect(env: &HashMap<String, String>, models: &HashMap<String, String>) -> Vec<AgentAvailability> {
    let r = resolve(env);
    let ollama = async { if r.ollama.disabled { None } else { probe_ollama(&r.ollama.url).await } };
    let lmstudio = async { if r.lmstudio.disabled { None } else { probe_lmstudio(&r.lmstudio.url).await } };
    let openrouter = async {
        match (&r.openrouter.key, r.openrouter.disabled) {
            (Some(key), false) => probe_openrouter(OPENROUTER_URL, key).await,
            _ => None,
        }
    };
    let (o, l, x) = tokio::join!(ollama, lmstudio, openrouter);
    [("ollama", o), ("lmstudio", l), ("openrouter", x)].into_iter().map(|(id, found)| availability(id, found, models.get(id))).collect()
}

/// Their runs go through Claude Code: without it none of them can run.
pub fn through_claude(found: Vec<AgentAvailability>, claude_installed: bool) -> Vec<AgentAvailability> {
    if claude_installed {
        return found;
    }
    found.into_iter().map(|a| AgentAvailability { id: a.id, ..Default::default() }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn reads_a_server_address_the_way_ollama_does() {
        let n = |raw: &str| normalize_host(raw, 11434);
        assert_eq!(n("127.0.0.1:11500").as_deref(), Some("http://127.0.0.1:11500"));
        assert_eq!(n("localhost").as_deref(), Some("http://localhost:11434"));
        assert_eq!(n("0.0.0.0").as_deref(), Some("http://127.0.0.1:11434"));
        assert_eq!(n("0.0.0.0:9000").as_deref(), Some("http://127.0.0.1:9000"));
        assert_eq!(n(":9000").as_deref(), Some("http://127.0.0.1:9000"));
        assert_eq!(n("[::]").as_deref(), Some("http://127.0.0.1:11434"));
        assert_eq!(n("gpu-box.local:8080/").as_deref(), Some("http://gpu-box.local:8080"));
        // A full address keeps its own port, or the scheme's.
        assert_eq!(n("https://ollama.example.com").as_deref(), Some("https://ollama.example.com"));
        assert_eq!(n("http://10.0.0.5:11434/").as_deref(), Some("http://10.0.0.5:11434"));
        // Claude Code adds /v1 itself.
        assert_eq!(normalize_host("http://localhost:1234/v1", 1234).as_deref(), Some("http://localhost:1234"));
        for bad in ["", "  ", "ftp://host", "file:///etc", "http://"] {
            assert_eq!(n(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn saved_settings_win_over_the_environment() {
        let base = env(&[("OLLAMA_HOST", "0.0.0.0"), ("LMSTUDIO_HOST", "studio:4321"), ("OPENROUTER_API_KEY", "sk-or-env"), ("PATH", "/bin")]);
        // Nothing saved: the environment, read as Ollama reads it.
        let r = resolve(&with_settings(base.clone(), &ProviderSettings::default()));
        assert_eq!(r.ollama, Local { url: "http://127.0.0.1:11434".into(), disabled: false });
        assert_eq!(r.lmstudio.url, "http://studio:4321");
        assert_eq!(r.openrouter.key.as_deref(), Some("sk-or-env"));
        // Nothing anywhere: the defaults.
        let none = resolve(&HashMap::new());
        assert_eq!((none.ollama.url.as_str(), none.lmstudio.url.as_str(), none.openrouter.key.as_deref()), (OLLAMA_DEFAULT_URL, LMSTUDIO_DEFAULT_URL, None));
        // Saved values replace them.
        let saved = ProviderSettings {
            ollama: LocalSettings { url: Some("http://gpu:11434".into()), disabled: false },
            lmstudio: LocalSettings { url: None, disabled: true },
            openrouter: KeySettings { api_key: Some("sk-or-saved".into()), disabled: true },
        };
        let merged = with_settings(base, &saved);
        let r = resolve(&merged);
        assert_eq!(r.ollama.url, "http://gpu:11434");
        assert_eq!(r.lmstudio, Local { url: "http://studio:4321".into(), disabled: true });
        assert_eq!((r.openrouter.key.as_deref(), r.openrouter.disabled), (Some("sk-or-saved"), true));
        // A saved key stays out of the three CLIs. One from the editor's own environment is theirs already.
        let cli = cli_env(&merged);
        assert!(!cli.contains_key("OPENROUTER_API_KEY") && !cli.contains_key(KEY_SAVED) && cli.contains_key("PATH"));
        assert_eq!(cli_env(&env(&[("OPENROUTER_API_KEY", "sk-or-env")])).get("OPENROUTER_API_KEY").map(String::as_str), Some("sk-or-env"));
        // Nothing prints the key.
        assert!(!format!("{saved:?} {r:?}").contains("sk-or-saved"));
    }

    #[test]
    fn settings_show_whether_there_is_a_key_and_never_the_key() {
        let saved = ProviderSettings { openrouter: KeySettings { api_key: Some("sk-or-saved".into()), disabled: false }, ..Default::default() };
        let shown = serde_json::to_value(view(&saved, &env(&[("OPENROUTER_API_KEY", "sk-or-env")]))).unwrap();
        assert_eq!(shown, json!({
            "ollama": { "url": null, "disabled": false },
            "lmstudio": { "url": null, "disabled": false },
            "openrouter": { "hasKey": true, "keyFromEnv": false, "disabled": false },
        }));
        let from_env = view(&ProviderSettings::default(), &env(&[("OPENROUTER_API_KEY", "sk-or-env")]));
        assert_eq!(from_env.openrouter, KeyView { has_key: true, key_from_env: true, disabled: false });
        assert_eq!(view(&ProviderSettings::default(), &HashMap::new()).openrouter, KeyView { has_key: false, key_from_env: false, disabled: false });
    }

    #[test]
    fn a_save_changes_only_the_fields_it_sends() {
        let mut s = ProviderSettings {
            ollama: LocalSettings { url: Some("http://gpu:11434".into()), disabled: false },
            openrouter: KeySettings { api_key: Some("sk-or-old".into()), disabled: false },
            ..Default::default()
        };
        // Turned off: the address stays.
        SettingsPatch::from_args(&json!({ "provider": "ollama", "disabled": true })).unwrap().apply(&mut s);
        assert_eq!(s.ollama, LocalSettings { url: Some("http://gpu:11434".into()), disabled: true });
        // An address, trimmed and read; then cleared with null, and with empty text.
        SettingsPatch::from_args(&json!({ "provider": "lmstudio", "url": " http://studio:1234/v1/ " })).unwrap().apply(&mut s);
        assert_eq!(s.lmstudio.url.as_deref(), Some("http://studio:1234"));
        SettingsPatch::from_args(&json!({ "provider": "ollama", "url": "localhost:11500" })).unwrap().apply(&mut s);
        assert_eq!(s.ollama.url.as_deref(), Some("http://localhost:11500"));
        SettingsPatch::from_args(&json!({ "provider": "lmstudio", "url": null })).unwrap().apply(&mut s);
        assert_eq!(s.lmstudio.url, None);
        SettingsPatch::from_args(&json!({ "provider": "ollama", "url": "", "disabled": null })).unwrap().apply(&mut s);
        assert_eq!(s.ollama, LocalSettings { url: None, disabled: true });
        // A key, replaced and cleared.
        SettingsPatch::from_args(&json!({ "provider": "openrouter", "apiKey": "sk-or-new" })).unwrap().apply(&mut s);
        assert_eq!(s.openrouter.api_key.as_deref(), Some("sk-or-new"));
        SettingsPatch::from_args(&json!({ "provider": "openrouter", "apiKey": "  " })).unwrap().apply(&mut s);
        assert_eq!(s.openrouter.api_key, None);
        // What can't be saved is refused, and nothing changes.
        for bad in [
            json!({ "provider": "claude", "disabled": true }),
            json!({ "disabled": true }),
            json!({ "provider": "ollama", "url": "http://" }),
            json!({ "provider": "ollama", "url": "ftp://box" }),
            json!({ "provider": "ollama", "url": 5 }),
            json!({ "provider": "ollama", "disabled": "yes" }),
            json!({ "provider": "ollama", "apiKey": "x" }),
            json!({ "provider": "openrouter", "url": "https://elsewhere.example" }),
        ] {
            assert!(SettingsPatch::from_args(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_run_goes_to_the_provider_with_its_model_and_nothing_else() {
        let base = env(&[
            ("PATH", "/bin"),
            ("OLLAMA_HOST", "gpu:11500"),
            ("ANTHROPIC_API_KEY", "sk-ant-mine"),
            ("anthropic_base_url", "https://proxy.example"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "oauth"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("ANTHROPIC_VERTEX_BASE_URL", "https://vertex"),
            ("OPENROUTER_API_KEY", "sk-or-secret"),
            (KEY_SAVED, "1"),
        ]);
        let run = run_env("ollama", Some("qwen3:30b"), &base).unwrap();
        assert_eq!(run.get("ANTHROPIC_BASE_URL").map(String::as_str), Some("http://gpu:11500"));
        assert_eq!(run.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str), Some("ollama"));
        assert_eq!(run.get("ANTHROPIC_API_KEY").map(String::as_str), Some(""));
        for var in MODEL_VARS {
            assert_eq!(run.get(var).map(String::as_str), Some("qwen3:30b"), "{var}");
        }
        assert_eq!((run["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"].as_str(), run["CLAUDE_CODE_ATTRIBUTION_HEADER"].as_str()), ("1", "0"));
        for gone in ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_VERTEX_BASE_URL", "anthropic_base_url", "OPENROUTER_API_KEY", KEY_SAVED] {
            assert!(!run.contains_key(gone), "{gone}");
        }
        // No key of the editor's, OpenRouter's or Anthropic's, reaches a local model.
        assert!(!run.values().any(|v| v.contains("sk-or-secret") || v.contains("sk-ant-mine")));
        assert_eq!(run_env("lmstudio", Some("qwen/qwen3-8b"), &HashMap::new()).unwrap()["ANTHROPIC_BASE_URL"], LMSTUDIO_DEFAULT_URL);

        let routed = run_env("openrouter", Some("anthropic/claude-sonnet-4"), &base).unwrap();
        assert_eq!((routed["ANTHROPIC_BASE_URL"].as_str(), routed["ANTHROPIC_AUTH_TOKEN"].as_str()), ("https://openrouter.ai/api", "sk-or-secret"));
        assert!(!routed.contains_key("OPENROUTER_API_KEY"));
        // Without a key or a model there is no run.
        assert_eq!(run_env("openrouter", Some("x/y"), &HashMap::new()).unwrap_err(), NO_OPENROUTER_KEY);
        assert_eq!(run_env("ollama", None, &base).unwrap_err(), "Choose a model for Ollama first.");
        assert_eq!(run_env("lmstudio", Some(""), &base).unwrap_err(), "Choose a model for LM Studio first.");
    }

    #[test]
    fn reads_each_servers_model_list() {
        let tags = json!({ "models": [{ "name": "qwen3:30b" }, { "name": "nomic-embed-text:latest" }, { "model": "llama3.2:3b" }, { "size": 1 }] });
        assert_eq!(ollama_names(&tags), ["qwen3:30b", "nomic-embed-text:latest", "llama3.2:3b"]);
        assert!(ollama_names(&json!({})).is_empty());
        assert!(ollama_keeps("qwen3:30b", Some(&json!({ "capabilities": ["completion", "tools", "thinking"] }))));
        assert!(!ollama_keeps("gemma3:4b", Some(&json!({ "capabilities": ["completion", "vision"] }))));
        // An older Ollama says nothing of capabilities.
        assert!(ollama_keeps("llama3.2:3b", Some(&json!({ "modelfile": "" }))));
        assert!(!ollama_keeps("nomic-embed-text:latest", None));

        let v0 = json!({ "data": [
            { "id": "qwen/qwen3-8b", "type": "llm" }, { "id": "text-embedding-nomic", "type": "embeddings" }, { "id": "gemma-3-12b", "type": "vlm" },
        ] });
        assert_eq!(lmstudio_models(&v0).unwrap(), ["qwen/qwen3-8b", "gemma-3-12b"]);
        assert_eq!(lmstudio_models(&json!({ "error": "nope" })), None);
        assert_eq!(openai_models(&json!({ "data": [{ "id": "qwen/qwen3-8b" }, { "id": "text-embedding-nomic" }] })), ["qwen/qwen3-8b"]);

        let routed = json!({ "data": [{ "id": "anthropic/claude-sonnet-4", "name": "Anthropic: Claude Sonnet 4" }, { "id": "x-ai/grok-4" }] });
        assert_eq!(openrouter_models(&routed), [("anthropic/claude-sonnet-4".to_string(), "Anthropic: Claude Sonnet 4".to_string()), ("x-ai/grok-4".to_string(), "x-ai/grok-4".to_string())]);
    }

    #[test]
    fn an_entry_keeps_the_servers_order_and_only_ids_a_run_accepts() {
        let found = Found {
            models: [("zeta:1b", "zeta:1b"), ("--bare", "--bare"), ("alpha:7b", "Alpha"), ("zeta:1b", "again"), ("has space", "x")]
                .iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            version: Some("0.12.3".into()),
            signed_in: true,
        };
        let entry = availability("ollama", Some(found), None);
        assert_eq!(entry.models.as_deref(), Some(&["zeta:1b".to_string(), "alpha:7b".to_string()][..]));
        assert_eq!(serde_json::to_value(&entry).unwrap(), json!({
            "id": "ollama", "installed": true, "loggedIn": true, "version": "0.12.3", "models": ["zeta:1b", "alpha:7b"],
            "modelLabels": { "zeta:1b": "zeta:1b", "alpha:7b": "Alpha" },
            "modelOptions": { "zeta:1b": { "efforts": [], "speeds": [] }, "alpha:7b": { "efforts": [], "speeds": [] } },
        }));
        let routed = availability("openrouter", Some(Found { signed_in: false, ..Default::default() }), Some(&"x/y".to_string()));
        assert_eq!((routed.auth.as_deref(), routed.logged_in, routed.model.as_deref(), routed.models), (Some("api_key"), Some(false), Some("x/y"), Some(vec![])));
        assert_eq!(serde_json::to_value(availability("lmstudio", None, None)).unwrap(), json!({ "id": "lmstudio", "installed": false }));
        // Without Claude Code none of them can run.
        let ready = vec![availability("ollama", Some(Found::default()), None)];
        assert!(through_claude(ready.clone(), true)[0].installed);
        assert_eq!(through_claude(ready, false), [AgentAvailability { id: "ollama".into(), ..Default::default() }]);
    }

    #[tokio::test]
    async fn asks_ollama_which_models_can_use_tools() {
        let server = super::super::api::fake::engine(|route, body| match route {
            "GET /api/tags" => (200, json!({ "models": [{ "name": "qwen3:30b" }, { "name": "gemma3:4b" }, { "name": "old:7b" }] }).to_string()),
            "GET /api/version" => (200, r#"{"version":"0.12.3"}"#.into()),
            "POST /api/show" if body.contains("qwen3") => (200, r#"{"capabilities":["completion","tools"]}"#.into()),
            "POST /api/show" if body.contains("gemma3") => (200, r#"{"capabilities":["completion","vision"]}"#.into()),
            "POST /api/show" => (200, "{}".into()),
            _ => (404, "{}".into()),
        }).await;
        let found = probe_ollama(&server.url).await.unwrap();
        assert_eq!(found.models.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["qwen3:30b", "old:7b"]);
        assert_eq!((found.version.as_deref(), found.signed_in), (Some("0.12.3"), true));
        // Nothing listening: not installed, and quickly.
        let started = std::time::Instant::now();
        assert_eq!(probe_ollama("http://127.0.0.1:1").await, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn falls_back_to_lm_studios_openai_list() {
        let native = super::super::api::fake::engine(|route, _| match route {
            "GET /api/v0/models" => (200, json!({ "data": [{ "id": "qwen/qwen3-8b", "type": "llm" }, { "id": "nomic-embed", "type": "embeddings" }] }).to_string()),
            _ => (404, "{}".into()),
        }).await;
        assert_eq!(probe_lmstudio(&native.url).await.unwrap().models, [("qwen/qwen3-8b".to_string(), "qwen/qwen3-8b".to_string())]);
        let older = super::super::api::fake::engine(|route, _| match route {
            "GET /v1/models" => (200, json!({ "data": [{ "id": "mistral-7b" }, { "id": "text-embedding-3" }] }).to_string()),
            _ => (404, "{}".into()),
        }).await;
        assert_eq!(probe_lmstudio(&older.url).await.unwrap().models, [("mistral-7b".to_string(), "mistral-7b".to_string())]);
    }

    #[tokio::test]
    async fn a_refused_openrouter_key_is_signed_out() {
        let server = super::super::api::fake::engine(|route, _| match route {
            "GET /v1/models?supported_parameters=tools" => (200, json!({ "data": [{ "id": "openai/gpt-5", "name": "OpenAI: GPT-5" }] }).to_string()),
            "GET /v1/key" => (401, r#"{"error":{"message":"No auth credentials found"}}"#.into()),
            _ => (404, "{}".into()),
        }).await;
        let found = probe_openrouter(&server.url, "sk-or-bad").await.unwrap();
        assert_eq!((found.models.len(), found.signed_in), (1, false));
    }

    #[tokio::test]
    async fn detection_skips_a_provider_that_is_off_or_has_no_key() {
        let off = env(&[(OLLAMA_OFF, "1"), (LMSTUDIO_OFF, "1"), ("OPENROUTER_API_KEY", "sk-or-x"), (OPENROUTER_OFF, "1")]);
        let found = detect(&off, &HashMap::new()).await;
        assert_eq!(found.iter().map(|a| (a.id.as_str(), a.installed)).collect::<Vec<_>>(), [("ollama", false), ("lmstudio", false), ("openrouter", false)]);
        // Nowhere to reach and no key: none installed, and none of it is an error.
        let nowhere = env(&[("OLLAMA_HOST", "127.0.0.1:1"), ("LMSTUDIO_HOST", "127.0.0.1:1")]);
        assert!(detect(&nowhere, &HashMap::new()).await.iter().all(|a| !a.installed));
    }
}
