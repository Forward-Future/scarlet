//! Detect installed AI CLIs (Claude Code, Codex, Gemini) and whether they look
//! logged in (port of apps/agent/src/detect.ts). Heuristics only: a CLI is
//! reported as loggedIn=true when it is installed and we cannot tell otherwise.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use super::spawn::{exec_capture, find_on_path, ExecResult};
use super::types::AgentAvailability;
use crate::util::env_get;

/// Process/file access used by detection; swapped out in tests.
pub trait DetectIo: Send + Sync {
    fn exec(&self, file: &str, args: &[&str]) -> impl Future<Output = ExecResult> + Send;
    fn find(&self, name: &str) -> impl Future<Output = Option<String>> + Send;
    fn exists(&self, p: &Path) -> bool {
        p.exists()
    }
    fn read(&self, p: &Path) -> Option<String> {
        std::fs::read_to_string(p).ok()
    }
}

pub struct RealIo {
    pub env: HashMap<String, String>,
}

impl DetectIo for RealIo {
    async fn exec(&self, file: &str, args: &[&str]) -> ExecResult {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        exec_capture(file, &args, &self.env, Duration::from_secs(15)).await
    }
    async fn find(&self, name: &str) -> Option<String> {
        find_on_path(name, &self.env)
    }
}

pub struct DetectOptions<'a> {
    pub env: &'a HashMap<String, String>,
    pub home: PathBuf,
    /// Model override per agent (from config).
    pub models: &'a HashMap<String, String>,
}

fn parse_version(s: &str) -> Option<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(\d+\.\d+\.\d+(?:[-+.][\w.]+)?)").unwrap());
    re.captures(s).map(|c| c[1].to_string())
}

fn env_truthy(env: &HashMap<String, String>, key: &str) -> bool {
    env_get(env, key).map(|v| !v.is_empty()).unwrap_or(false)
}

pub const SUBSCRIPTION: &str = "subscription";
pub const API_KEY: &str = "api_key";

/// Env vars that make a CLI bill an API key instead of the signed-in subscription.
pub fn api_key_vars(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude" => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        "codex" => &["OPENAI_API_KEY", "CODEX_API_KEY"],
        _ => &[],
    }
}

fn strip_vars(env: &HashMap<String, String>, vars: &[&str]) -> HashMap<String, String> {
    env.iter().filter(|(k, _)| !vars.iter().any(|v| k.eq_ignore_ascii_case(v))).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// The env a runner should use: when the CLI is signed in with a subscription,
/// drop API-key variables so a stray key in the environment can't silently
/// switch the run to pay-per-token billing.
pub fn runner_env(agent: &str, agents: &[AgentAvailability], env: &HashMap<String, String>) -> HashMap<String, String> {
    let on_subscription = agents.iter().any(|a| a.id == agent && a.auth.as_deref() == Some(SUBSCRIPTION));
    if on_subscription {
        strip_vars(env, api_key_vars(agent))
    } else {
        env.clone()
    }
}

pub async fn detect_claude<I: DetectIo>(io: &I, o: &DetectOptions<'_>) -> AgentAvailability {
    let Some(path) = io.find("claude").await else {
        return AgentAvailability { id: "claude".into(), installed: false, ..Default::default() };
    };
    let v = io.exec(&path, &["--version"]).await;
    let version = parse_version(&format!("{}{}", v.stdout, v.stderr));
    let mut logged_in: Option<bool> = None;
    let mut auth: Option<String> = None;
    let mut plan: Option<String> = None;
    // Preferred: `claude auth status` prints JSON (exit 1 when signed out). The
    // probe runs without API-key vars so it reports the subscription login.
    let st = io.exec(&path, &["auth", "status"]).await;
    match serde_json::from_str::<Value>(st.stdout.trim()) {
        Ok(j) => {
            if let Some(b) = j.get("loggedIn").and_then(Value::as_bool) {
                logged_in = Some(b);
            }
            match j.get("authMethod").and_then(Value::as_str) {
                None | Some("none") => {}
                Some("claude.ai") | Some("oauth_token") => auth = Some(SUBSCRIPTION.into()),
                Some(_) => auth = Some(API_KEY.into()),
            }
            plan = j.get("subscriptionType").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        }
        Err(_) if st.code == Some(0) => {
            let lower = st.stdout.to_lowercase();
            if lower.contains("logged in") && !lower.contains("not logged in") {
                logged_in = Some(true);
            }
        }
        Err(_) => {}
    }
    if logged_in.is_none() {
        if io.exists(&o.home.join(".claude").join(".credentials.json")) {
            logged_in = Some(true);
            auth = Some(SUBSCRIPTION.into());
        } else if let Some(txt) = io.read(&o.home.join(".claude.json")) {
            if let Ok(j) = serde_json::from_str::<Value>(&txt) {
                let acct = j.get("oauthAccount");
                if matches!(acct, Some(v) if !v.is_null() && v != &Value::Bool(false)) {
                    logged_in = Some(true);
                    auth = Some(SUBSCRIPTION.into());
                }
            }
        }
    }
    if logged_in != Some(true) {
        if env_truthy(o.env, "CLAUDE_CODE_OAUTH_TOKEN") {
            logged_in = Some(true);
            auth = Some(SUBSCRIPTION.into());
        } else if api_key_vars("claude").iter().any(|k| env_truthy(o.env, k)) {
            logged_in = Some(true);
            auth = Some(API_KEY.into());
        }
    }
    AgentAvailability {
        id: "claude".into(),
        installed: true,
        version,
        logged_in: Some(logged_in.unwrap_or(true)),
        auth,
        plan,
        ..Default::default()
    }
}

pub async fn detect_codex<I: DetectIo>(io: &I, o: &DetectOptions<'_>) -> AgentAvailability {
    let Some(path) = io.find("codex").await else {
        return AgentAvailability { id: "codex".into(), installed: false, ..Default::default() };
    };
    let v = io.exec(&path, &["--version"]).await;
    let version = parse_version(&format!("{}{}", v.stdout, v.stderr));
    let mut logged_in: Option<bool> = None;
    let mut auth: Option<String> = None;
    // `codex login status`: "Logged in using ChatGPT" / "Logged in using an API key ..." / "Not logged in" (exit 1).
    let st = io.exec(&path, &["login", "status"]).await;
    let out = format!("{}\n{}", st.stdout, st.stderr).to_lowercase();
    if out.contains("not logged in") {
        logged_in = Some(false);
    } else if out.contains("logged in") {
        logged_in = Some(true);
        if out.contains("chatgpt") {
            auth = Some(SUBSCRIPTION.into());
        } else if out.contains("api key") {
            auth = Some(API_KEY.into());
        }
    }
    if logged_in.is_none() {
        // Older CLIs: read auth.json (ChatGPT login stores `tokens`, key login stores `OPENAI_API_KEY`).
        let codex_home = env_get(o.env, "CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| o.home.join(".codex"));
        if let Some(j) = io.read(&codex_home.join("auth.json")).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            if j.get("tokens").map(|t| !t.is_null()).unwrap_or(false) {
                logged_in = Some(true);
                auth = Some(SUBSCRIPTION.into());
            } else if j.get("OPENAI_API_KEY").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false) {
                logged_in = Some(true);
                auth = Some(API_KEY.into());
            }
        }
    }
    if logged_in != Some(true) && api_key_vars("codex").iter().any(|k| env_truthy(o.env, k)) {
        logged_in = Some(true);
        auth = Some(API_KEY.into());
    }
    AgentAvailability {
        id: "codex".into(),
        installed: true,
        version,
        logged_in: Some(logged_in.unwrap_or(false)),
        auth,
        ..Default::default()
    }
}

pub async fn detect_gemini<I: DetectIo>(io: &I, o: &DetectOptions<'_>) -> AgentAvailability {
    let Some(path) = io.find("gemini").await else {
        return AgentAvailability { id: "gemini".into(), installed: false, ..Default::default() };
    };
    let v = io.exec(&path, &["--version"]).await;
    let version = parse_version(&format!("{}{}", v.stdout, v.stderr));
    let logged_in = io.exists(&o.home.join(".gemini").join("oauth_creds.json")) || env_truthy(o.env, "GEMINI_API_KEY") || env_truthy(o.env, "GOOGLE_API_KEY");
    AgentAvailability { id: "gemini".into(), installed: true, version, logged_in: Some(logged_in), ..Default::default() }
}

/// Detect all three CLIs in parallel. Always returns one entry per agent, in order claude, codex, gemini.
pub async fn detect_with<I: DetectIo>(io: &I, o: &DetectOptions<'_>) -> Vec<AgentAvailability> {
    let (c, x, g) = tokio::join!(detect_claude(io, o), detect_codex(io, o), detect_gemini(io, o));
    [c, x, g]
        .into_iter()
        .map(|mut a| {
            if let Some(m) = o.models.get(&a.id) {
                a.model = Some(m.clone());
            }
            a
        })
        .collect()
}

/// Detect with the real environment (augmented PATH) and home directory.
pub async fn detect(env: &HashMap<String, String>, home: &Path, models: &HashMap<String, String>) -> Vec<AgentAvailability> {
    // Probe the CLIs without API-key vars so their status reflects the subscription sign-in.
    let mut keys: Vec<&str> = api_key_vars("claude").to_vec();
    keys.extend_from_slice(api_key_vars("codex"));
    let io = RealIo { env: strip_vars(env, &keys) };
    detect_with(&io, &DetectOptions { env, home: home.to_path_buf(), models }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeIo;
    impl DetectIo for FakeIo {
        async fn exec(&self, file: &str, args: &[&str]) -> ExecResult {
            if file.ends_with("claude") && args[0] == "--version" {
                return ExecResult { code: Some(0), stdout: "2.1.312 (Claude Code)\n".into(), stderr: String::new() };
            }
            if file.ends_with("claude") && args[0] == "auth" {
                return ExecResult { code: Some(0), stdout: r#"{"loggedIn":false}"#.into(), stderr: String::new() };
            }
            if file.ends_with("codex.cmd") {
                return ExecResult { code: Some(0), stdout: "codex-cli 0.50.0\n".into(), stderr: String::new() };
            }
            ExecResult { code: Some(1), stdout: String::new(), stderr: String::new() }
        }
        async fn find(&self, name: &str) -> Option<String> {
            match name {
                "claude" => Some("/bin/claude".into()),
                "codex" => Some("C:\\npm\\codex.cmd".into()),
                _ => None,
            }
        }
        fn exists(&self, _p: &Path) -> bool {
            false
        }
        fn read(&self, _p: &Path) -> Option<String> {
            None
        }
    }

    #[tokio::test]
    async fn uses_heuristics_with_fake_find_exec() {
        let mut env = HashMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "sk-x".to_string());
        let mut models = HashMap::new();
        models.insert("claude".to_string(), "sonnet".to_string());
        let agents = detect_with(&FakeIo, &DetectOptions { env: &env, home: PathBuf::from("/nonexistent-home"), models: &models }).await;
        assert_eq!(agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["claude", "codex", "gemini"]);
        assert!(agents[0].installed);
        assert_eq!(agents[0].version.as_deref(), Some("2.1.312"));
        assert_eq!(agents[0].logged_in, Some(false));
        assert_eq!(agents[0].model.as_deref(), Some("sonnet"));
        assert!(agents[1].installed);
        assert_eq!(agents[1].version.as_deref(), Some("0.50.0"));
        assert_eq!(agents[1].logged_in, Some(true));
        assert!(!agents[2].installed);
        assert_eq!(agents[2].models, None);
    }

    #[tokio::test]
    async fn returns_one_entry_per_agent_using_the_real_path() {
        let env = crate::util::child_env(&crate::util::home_dir());
        let agents = detect(&env, &crate::util::home_dir(), &HashMap::new()).await;
        assert_eq!(agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["claude", "codex", "gemini"]);
        for a in &agents {
            assert!(a.models.is_none(), "model discovery runs after CLI detection");
        }
        // claude is installed on this machine; the other two may not be.
        if agents[0].installed {
            assert!(agents[0].version.as_deref().map(|v| v.split('.').count() >= 3).unwrap_or(false));
            assert!(agents[0].logged_in.is_some());
        }
    }

    /// Scripted CLI outputs for the auth-status probes.
    struct ScriptIo {
        claude_status: (i32, &'static str),
        codex_status: (i32, &'static str),
    }
    impl DetectIo for ScriptIo {
        async fn exec(&self, file: &str, args: &[&str]) -> ExecResult {
            let (code, out) = match (file, args) {
                (_, ["--version"]) => (0, "1.2.3"),
                ("claude", ["auth", "status"]) => self.claude_status,
                ("codex", ["login", "status"]) => self.codex_status,
                _ => (1, ""),
            };
            ExecResult { code: Some(code), stdout: out.into(), stderr: String::new() }
        }
        async fn find(&self, name: &str) -> Option<String> {
            (name != "gemini").then(|| name.to_string())
        }
        fn exists(&self, _p: &Path) -> bool {
            false
        }
        fn read(&self, _p: &Path) -> Option<String> {
            None
        }
    }

    #[tokio::test]
    async fn reads_subscription_sign_in_and_signed_out_exit_codes() {
        let env = HashMap::new();
        let models = HashMap::new();
        let o = DetectOptions { env: &env, home: PathBuf::from("/nonexistent-home"), models: &models };
        let io = ScriptIo {
            claude_status: (0, r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}"#),
            codex_status: (0, "Logged in using ChatGPT\n"),
        };
        let c = detect_claude(&io, &o).await;
        assert_eq!((c.logged_in, c.auth.as_deref(), c.plan.as_deref()), (Some(true), Some(SUBSCRIPTION), Some("max")));
        let x = detect_codex(&io, &o).await;
        assert_eq!((x.logged_in, x.auth.as_deref()), (Some(true), Some(SUBSCRIPTION)));

        // Signed out: claude prints JSON but exits 1; codex prints "Not logged in" and exits 1.
        let io = ScriptIo { claude_status: (1, r#"{"loggedIn":false,"authMethod":"none"}"#), codex_status: (1, "Not logged in\n") };
        assert_eq!(detect_claude(&io, &o).await.logged_in, Some(false));
        assert_eq!(detect_codex(&io, &o).await.logged_in, Some(false));

        // Signed out but an API key is in the environment.
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "sk-ant".to_string());
        let o = DetectOptions { env: &env, home: PathBuf::from("/nonexistent-home"), models: &models };
        let c = detect_claude(&io, &o).await;
        assert_eq!((c.logged_in, c.auth.as_deref()), (Some(true), Some(API_KEY)));
    }

    #[test]
    fn runner_env_drops_api_keys_only_on_subscription() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "sk-ant".to_string());
        env.insert("OPENAI_API_KEY".to_string(), "sk-oai".to_string());
        env.insert("PATH".to_string(), "/bin".to_string());
        let agents = vec![
            AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), auth: Some(SUBSCRIPTION.into()), ..Default::default() },
            AgentAvailability { id: "codex".into(), installed: true, logged_in: Some(true), auth: Some(API_KEY.into()), ..Default::default() },
        ];
        let claude = runner_env("claude", &agents, &env);
        assert!(!claude.contains_key("ANTHROPIC_API_KEY"));
        assert!(claude.contains_key("OPENAI_API_KEY") && claude.contains_key("PATH"));
        assert_eq!(runner_env("codex", &agents, &env), env);
    }

    /// CLIs from before the status commands could be trusted: the sign-in is read from files and the environment.
    struct FilesIo {
        /// What `claude auth status` and `codex login status` print, and their exit code.
        status: (i32, &'static str),
        files: Vec<(PathBuf, &'static str)>,
    }
    impl DetectIo for FilesIo {
        async fn exec(&self, _file: &str, args: &[&str]) -> ExecResult {
            let (code, out) = if args == ["--version"] { (0, "v9.8.7-beta.1\n") } else { self.status };
            ExecResult { code: Some(code), stdout: out.into(), stderr: String::new() }
        }
        async fn find(&self, name: &str) -> Option<String> {
            Some(name.to_string())
        }
        fn exists(&self, p: &Path) -> bool {
            self.files.iter().any(|(file, _)| file == p)
        }
        fn read(&self, p: &Path) -> Option<String> {
            self.files.iter().find(|(file, _)| file == p).map(|(_, text)| text.to_string())
        }
    }

    fn sign_in(a: &AgentAvailability) -> (Option<bool>, Option<&str>) {
        (a.logged_in, a.auth.as_deref())
    }

    #[tokio::test]
    async fn falls_back_to_claudes_files_and_environment_when_its_status_says_nothing() {
        let home = PathBuf::from("/home/editor");
        let models = HashMap::new();
        let none = HashMap::new();
        let unknown = (1, "error: unknown command 'auth'");
        let with = |status, files: Vec<(PathBuf, &'static str)>| FilesIo { status, files };
        let o = DetectOptions { env: &none, home: home.clone(), models: &models };

        // The credentials file of a subscription sign-in.
        let claude = detect_claude(&with(unknown, vec![(home.join(".claude").join(".credentials.json"), "{}")]), &o).await;
        assert_eq!(sign_in(&claude), (Some(true), Some(SUBSCRIPTION)));
        assert_eq!(claude.version.as_deref(), Some("9.8.7-beta.1"));
        // An account in ~/.claude.json. An empty one is no sign-in, and neither is a file that isn't JSON.
        let account = detect_claude(&with(unknown, vec![(home.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"e@example.com"}}"#)]), &o).await;
        assert_eq!(sign_in(&account), (Some(true), Some(SUBSCRIPTION)));
        for text in [r#"{"oauthAccount":null}"#, r#"{"oauthAccount":false}"#, "{}", "not json"] {
            let nothing = detect_claude(&with(unknown, vec![(home.join(".claude.json"), text)]), &o).await;
            // Nothing says it is signed out either, so it is offered: the run itself will say.
            assert_eq!(sign_in(&nothing), (Some(true), None), "{text}");
        }
        // An older CLI that answers in words.
        assert_eq!(sign_in(&detect_claude(&with((0, "Logged in as e@example.com"), vec![]), &o).await), (Some(true), None));

        // Signed out by its own account, with a token or a key in the environment: the token is a subscription.
        let signed_out = (1, r#"{"loggedIn":false,"authMethod":"none"}"#);
        let token = HashMap::from([("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "tok".to_string()), ("ANTHROPIC_API_KEY".to_string(), "sk-ant".to_string())]);
        let o = DetectOptions { env: &token, home: home.clone(), models: &models };
        assert_eq!(sign_in(&detect_claude(&with(signed_out, vec![]), &o).await), (Some(true), Some(SUBSCRIPTION)));
        let auth_token = HashMap::from([("ANTHROPIC_AUTH_TOKEN".to_string(), "tok".to_string())]);
        let o = DetectOptions { env: &auth_token, home: home.clone(), models: &models };
        assert_eq!(sign_in(&detect_claude(&with(signed_out, vec![]), &o).await), (Some(true), Some(API_KEY)));
        // A variable set to nothing is not a key.
        let empty = HashMap::from([("ANTHROPIC_API_KEY".to_string(), String::new())]);
        let o = DetectOptions { env: &empty, home: home.clone(), models: &models };
        assert_eq!(sign_in(&detect_claude(&with(signed_out, vec![]), &o).await), (Some(false), None));
        // Signed in with a key the CLI itself reports.
        let o = DetectOptions { env: &none, home, models: &models };
        let keyed = detect_claude(&with((0, r#"{"loggedIn":true,"authMethod":"api_key","subscriptionType":""}"#), vec![]), &o).await;
        assert_eq!((sign_in(&keyed), keyed.plan.as_deref()), ((Some(true), Some(API_KEY)), None));
    }

    #[tokio::test]
    async fn falls_back_to_codexs_auth_file_and_environment_when_its_status_says_nothing() {
        let home = PathBuf::from("/home/editor");
        let models = HashMap::new();
        let none = HashMap::new();
        let unknown = (2, "error: unrecognized subcommand 'status'");
        let with = |files: Vec<(PathBuf, &'static str)>| FilesIo { status: unknown, files };
        let o = DetectOptions { env: &none, home: home.clone(), models: &models };
        let auth = home.join(".codex").join("auth.json");

        assert_eq!(sign_in(&detect_codex(&with(vec![(auth.clone(), r#"{"tokens":{"id_token":"x"}}"#)]), &o).await), (Some(true), Some(SUBSCRIPTION)));
        assert_eq!(sign_in(&detect_codex(&with(vec![(auth.clone(), r#"{"tokens":null,"OPENAI_API_KEY":"sk-x"}"#)]), &o).await), (Some(true), Some(API_KEY)));
        // No tokens, an empty key, a broken file or no file: signed out, unlike Claude, whose default is to try.
        for text in [r#"{"tokens":null,"OPENAI_API_KEY":""}"#, "{}", "not json"] {
            assert_eq!(sign_in(&detect_codex(&with(vec![(auth.clone(), text)]), &o).await), (Some(false), None), "{text}");
        }
        assert_eq!(sign_in(&detect_codex(&with(vec![]), &o).await), (Some(false), None));

        // CODEX_HOME moves the file, and the default place is then not read.
        let moved = HashMap::from([("CODEX_HOME".to_string(), "/srv/codex".to_string())]);
        let o = DetectOptions { env: &moved, home: home.clone(), models: &models };
        assert_eq!(sign_in(&detect_codex(&with(vec![(PathBuf::from("/srv/codex").join("auth.json"), r#"{"tokens":{}}"#)]), &o).await), (Some(true), Some(SUBSCRIPTION)));
        assert_eq!(sign_in(&detect_codex(&with(vec![(auth, r#"{"tokens":{}}"#)]), &o).await), (Some(false), None));
        // A key in the environment signs in a CLI that has no sign-in of its own.
        let key = HashMap::from([("CODEX_API_KEY".to_string(), "sk-x".to_string())]);
        let o = DetectOptions { env: &key, home, models: &models };
        assert_eq!(sign_in(&detect_codex(&with(vec![]), &o).await), (Some(true), Some(API_KEY)));
        // "Logged in using an API key", in the CLI's own words.
        let io = FilesIo { status: (0, "Logged in using an API key - sk-...abc"), files: vec![] };
        assert_eq!(sign_in(&detect_codex(&io, &o).await), (Some(true), Some(API_KEY)));
    }

    #[tokio::test]
    async fn reads_geminis_sign_in_from_its_credentials_file_or_a_key() {
        let home = PathBuf::from("/home/editor");
        let models = HashMap::from([("gemini".to_string(), "gemini-2.5-pro".to_string())]);
        let none = HashMap::new();
        let o = DetectOptions { env: &none, home: home.clone(), models: &models };
        let signed_out = detect_gemini(&FilesIo { status: (0, ""), files: vec![] }, &o).await;
        assert_eq!((signed_out.installed, signed_out.logged_in, signed_out.version.as_deref()), (true, Some(false), Some("9.8.7-beta.1")));
        let creds = FilesIo { status: (0, ""), files: vec![(home.join(".gemini").join("oauth_creds.json"), "{}")] };
        assert_eq!(detect_gemini(&creds, &o).await.logged_in, Some(true));
        for key in ["GEMINI_API_KEY", "GOOGLE_API_KEY"] {
            let env = HashMap::from([(key.to_string(), "k".to_string())]);
            let o = DetectOptions { env: &env, home: home.clone(), models: &models };
            assert_eq!(detect_gemini(&FilesIo { status: (0, ""), files: vec![] }, &o).await.logged_in, Some(true), "{key}");
        }
        // The model chosen in settings is carried on the entry, for every assistant that has one.
        let all = detect_with(&FilesIo { status: (0, ""), files: vec![] }, &o).await;
        assert_eq!(all.iter().map(|a| a.model.as_deref()).collect::<Vec<_>>(), [None, None, Some("gemini-2.5-pro")]);
    }

    #[test]
    fn reads_a_version_wherever_the_cli_prints_it() {
        assert_eq!(parse_version("codex-cli 0.50.0").as_deref(), Some("0.50.0"));
        assert_eq!(parse_version("2.1.312 (Claude Code)").as_deref(), Some("2.1.312"));
        assert_eq!(parse_version("v1.2.3-nightly.20261108+abc").as_deref(), Some("1.2.3-nightly.20261108"));
        assert_eq!(parse_version("command not found"), None);
        assert_eq!(parse_version("version 2.1"), None);
        // No key variables for an assistant with no key sign-in, so nothing is stripped from its runs.
        assert!(api_key_vars("gemini").is_empty());
        let env = HashMap::from([("anthropic_api_key".to_string(), "k".to_string()), ("PATH".to_string(), "/bin".to_string())]);
        assert_eq!(strip_vars(&env, api_key_vars("claude")).keys().collect::<Vec<_>>(), ["PATH"]);
    }
}
