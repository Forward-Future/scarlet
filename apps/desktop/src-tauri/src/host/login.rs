//! One-click sign-in for the agent CLIs with the user's own subscription:
//! runs `claude auth login --claudeai` (Claude Pro/Max) or `codex login`
//! (ChatGPT plan) headless. Both CLIs open the system browser themselves and
//! print a fallback URL; Claude also accepts a pasted code on stdin when the
//! browser hand-off doesn't come back. Progress is emitted on
//! `agent-login://status`; on success the agent list is re-detected.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::detect::api_key_vars;
use super::spawn::{build_command, resolve_cli, spawn_spec};
use super::HostManager;
use crate::util::{child_env, kill_tree, lossy_lines};

/// How long a sign-in may wait for the browser round-trip.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub agent: String,
    /// "waiting" | "done" | "failed" | "cancelled"
    pub state: String,
    /// Sign-in page, in case the browser didn't open on its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The CLI accepts a pasted authorization code (Claude's manual fallback).
    pub accepts_code: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// CLI binary and arguments that start a subscription sign-in.
pub fn login_command(agent: &str) -> Option<(&'static str, &'static [&'static str])> {
    match agent {
        "claude" => Some(("claude", &["auth", "login", "--claudeai"])),
        "codex" => Some(("codex", &["login"])),
        _ => None,
    }
}

/// First http(s) URL in a line of CLI output.
pub fn extract_url(line: &str) -> Option<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"https?://[^\s"'<>]+"#).unwrap());
    re.find(line).map(|m| m.as_str().trim_end_matches(['.', ')', ',']).to_string())
}

/// The local callback server Codex announces is not the sign-in page.
fn is_sign_in_url(url: &str) -> bool {
    !(url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1"))
}

struct Session {
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    cancel: CancellationToken,
    status: LoginStatus,
}

impl Session {
    fn report(&mut self, attempt: &CancellationToken, mut status: LoginStatus) -> bool {
        if &self.cancel != attempt || self.status.state != "waiting" {
            return false;
        }
        if attempt.is_cancelled() {
            if status.state == "waiting" { return false; }
            status.state = "cancelled".into();
            status.url = None;
            status.message = None;
        }
        if status.state != "waiting" {
            self.stdin = None;
        }
        self.status = status;
        true
    }
}

pub struct LoginManager {
    app: AppHandle,
    home: PathBuf,
    host: Arc<HostManager>,
    sessions: StdMutex<HashMap<String, Session>>,
}

impl LoginManager {
    pub fn new(app: AppHandle, home: PathBuf, host: Arc<HostManager>) -> Self {
        LoginManager { app, home, host, sessions: StdMutex::new(HashMap::new()) }
    }

    fn report(&self, attempt: &CancellationToken, status: LoginStatus) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&status.agent) {
            if session.report(attempt, status) {
                let _ = self.app.emit("agent-login://status", &session.status);
            }
        }
    }

    pub fn status(&self, agent: &str) -> Option<LoginStatus> {
        self.sessions.lock().unwrap().get(agent).map(|s| s.status.clone())
    }

    /// Start (or restart) the sign-in for `agent`. Returns once the CLI is running.
    pub async fn start(self: &Arc<Self>, agent: &str) -> Result<LoginStatus> {
        let (name, args) = login_command(agent).ok_or_else(|| anyhow!("{agent} has no one-click sign-in"))?;
        self.cancel(agent).await;

        let mut env = child_env(&self.home);
        // An API key in the environment would make the CLI skip the subscription flow.
        env.retain(|k, _| !api_key_vars(agent).iter().any(|v| k.eq_ignore_ascii_case(v)));
        let bin = resolve_cli(name, &env).with_context(|| format!("install the {name} CLI first"))?;
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let spec = spawn_spec(&bin, &args, &env);
        let mut cmd = build_command(&spec, Some(&self.home), &env);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().with_context(|| format!("start {name} sign-in"))?;
        let pid = child.id().ok_or_else(|| anyhow!("no pid"))?;
        let stdin = child.stdin.take().map(|pipe| Arc::new(Mutex::new(pipe)));
        let cancel = CancellationToken::new();

        let accepts_code = agent == "claude";
        let waiting = LoginStatus { agent: agent.to_string(), state: "waiting".into(), url: None, accepts_code, message: None };
        {
            let mut sessions = self.sessions.lock().unwrap();
            let session = Session { stdin, cancel: cancel.clone(), status: waiting.clone() };
            if let Some(previous) = sessions.insert(agent.to_string(), session) {
                previous.cancel.cancel();
            }
            let _ = self.app.emit("agent-login://status", &waiting);
        }
        log::info!("{agent} sign-in started (pid {pid})");

        let tail: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let url_seen = Arc::new(std::sync::OnceLock::new());
        let readers: Vec<_> = [child.stdout.take().map(|s| Box::new(s) as Box<dyn AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)]
            .into_iter()
            .flatten()
            .map(|r| {
                let me = self.clone();
                let attempt = cancel.clone();
                let tail = tail.clone();
                let url_seen = url_seen.clone();
                let agent = agent.to_string();
                tokio::spawn(async move {
                    let mut lines = lossy_lines(r);
                    while let Ok(Some(line)) = lines.next_line().await {
                        let line = line.trim().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        {
                            let mut t = tail.lock().unwrap();
                            t.push(line.clone());
                            if t.len() > 8 {
                                t.remove(0);
                            }
                        }
                        if let Some(url) = extract_url(&line).filter(|u| is_sign_in_url(u)) {
                            if url_seen.set(url.clone()).is_ok() {
                                me.report(&attempt, LoginStatus { agent: agent.clone(), state: "waiting".into(), url: Some(url), accepts_code, message: None });
                            }
                        }
                    }
                })
            })
            .collect();

        let me = self.clone();
        let agent_s = agent.to_string();
        tauri::async_runtime::spawn(async move {
            let outcome = tokio::select! {
                r = child.wait() => Some(r.ok().and_then(|s| s.code())),
                _ = tokio::time::sleep(LOGIN_TIMEOUT) => None,
                _ = cancel.cancelled() => Some(None),
            };
            let cancelled = cancel.is_cancelled();
            if (outcome.is_none() || cancelled) && child.id().is_some() {
                kill_tree(pid).await;
            }
            for mut reader in readers {
                if tokio::time::timeout(Duration::from_secs(2), &mut reader).await.is_err() {
                    reader.abort();
                }
            }
            let url = url_seen.get().cloned();
            let st = match outcome {
                _ if cancelled => LoginStatus { agent: agent_s.clone(), state: "cancelled".into(), url, accepts_code, message: None },
                None => LoginStatus { agent: agent_s.clone(), state: "failed".into(), url, accepts_code, message: Some("Sign-in timed out. Try again.".into()) },
                Some(Some(0)) => LoginStatus { agent: agent_s.clone(), state: "done".into(), url: None, accepts_code, message: None },
                Some(code) => {
                    let detail = tail.lock().unwrap().join("\n");
                    let message = if detail.is_empty() { format!("sign-in exited with code {code:?}") } else { detail };
                    LoginStatus { agent: agent_s.clone(), state: "failed".into(), url, accepts_code, message: Some(message) }
                }
            };
            // Only how it ended: what the CLI printed can hold the sign-in address.
            match outcome {
                _ if cancelled => log::info!("{agent_s} sign-in cancelled"),
                None => log::warn!("{agent_s} sign-in timed out after {}", crate::util::human_duration(LOGIN_TIMEOUT)),
                Some(Some(0)) => log::info!("{agent_s} sign-in done"),
                Some(code) => log::warn!("{agent_s} sign-in failed (exit code {code:?})"),
            }
            if st.state != "cancelled" {
                // Re-detect so the new sign-in shows up (and reaches the server) right away.
                me.host.refresh_agents().await;
            }
            me.report(&cancel, st);
        });
        Ok(waiting)
    }

    /// Paste the authorization code shown by the browser (Claude's manual fallback).
    pub async fn submit_code(&self, agent: &str, code: &str) -> Result<()> {
        let stdin = self.sessions.lock().unwrap().get(agent).and_then(|s| s.stdin.clone()).ok_or_else(|| anyhow!("no {agent} sign-in in progress"))?;
        let mut pipe = stdin.lock().await;
        pipe.write_all(format!("{}\n", code.trim()).as_bytes()).await?;
        pipe.flush().await?;
        Ok(())
    }

    pub async fn cancel(&self, agent: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(agent).filter(|s| s.status.state == "waiting") {
            session.cancel.cancel();
            session.stdin = None;
        }
    }

    pub fn cancel_all(&self) {
        for (_, s) in self.sessions.lock().unwrap().drain() {
            s.cancel.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_restarted_sign_in_ignores_the_old_address_and_result() {
        let old = CancellationToken::new();
        let current = CancellationToken::new();
        let status = |state: &str, url: Option<&str>| LoginStatus {
            agent: "codex".into(), state: state.into(), url: url.map(String::from), accepts_code: false, message: None,
        };
        let waiting = status("waiting", None);
        let mut session = Session { cancel: current.clone(), stdin: None, status: waiting.clone() };
        for stale in [status("waiting", Some("https://example.com/old")), status("cancelled", None), status("done", None)] {
            assert!(!session.report(&old, stale));
            assert_eq!(session.status, waiting);
        }
        assert!(session.report(&current, status("waiting", Some("https://example.com/new"))));
        let done = status("done", None);
        assert!(session.report(&current, done.clone()));
        assert!(!session.report(&current, status("waiting", Some("https://example.com/late"))));
        assert_eq!(session.status, done);

        // The user can cancel after the CLI exits, while the agent list is still refreshing.
        let mut session = Session { cancel: current.clone(), stdin: None, status: waiting };
        current.cancel();
        assert!(!session.report(&current, status("waiting", Some("https://example.com/late"))));
        assert!(session.report(&current, done));
        assert_eq!(session.status, status("cancelled", None));
    }

    #[test]
    fn picks_the_sign_in_url_from_cli_output() {
        let claude = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=x";
        assert_eq!(extract_url(claude).as_deref(), Some("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=x"));
        let codex_server = "Starting local login server on http://localhost:1455.";
        assert!(extract_url(codex_server).filter(|u| is_sign_in_url(u)).is_none());
        let codex = "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback";
        assert_eq!(extract_url(codex).filter(|u| is_sign_in_url(u)).as_deref(), Some(codex));
        assert!(extract_url("Paste code here if prompted >").is_none());
    }

    #[test]
    fn takes_the_address_out_of_the_punctuation_around_it() {
        assert_eq!(extract_url("Open (https://example.com/a).").as_deref(), Some("https://example.com/a"));
        assert_eq!(extract_url("see <https://example.com/x>, then paste").as_deref(), Some("https://example.com/x"));
        assert_eq!(extract_url("url=\"https://example.com/q?a=1\" next").as_deref(), Some("https://example.com/q?a=1"));
        // The first address on a line is the one shown.
        assert_eq!(extract_url("http://one.example/ or https://two.example/").as_deref(), Some("http://one.example/"));
        assert!(extract_url("ftp://example.com and example.com").is_none());
        // Codex's own callback server, by either name, is never offered as the sign-in page.
        assert!(!is_sign_in_url("http://127.0.0.1:1455/auth/callback") && !is_sign_in_url("http://localhost:1455"));
        assert!(is_sign_in_url("https://localhost.example.com/login"));
    }

    #[test]
    fn a_status_goes_to_the_window_without_fields_it_has_no_value_for() {
        let waiting = LoginStatus { agent: "claude".into(), state: "waiting".into(), url: None, accepts_code: true, message: None };
        assert_eq!(serde_json::to_value(&waiting).unwrap(), serde_json::json!({ "agent": "claude", "state": "waiting", "acceptsCode": true }));
        let failed = LoginStatus { url: Some("https://claude.com/x".into()), state: "failed".into(), message: Some("Sign-in timed out. Try again.".into()), ..waiting };
        let sent = serde_json::to_value(&failed).unwrap();
        assert_eq!((&sent["url"], &sent["message"]), (&serde_json::json!("https://claude.com/x"), &serde_json::json!("Sign-in timed out. Try again.")));
    }

    #[test]
    fn only_claude_and_codex_have_one_click_sign_in() {
        assert_eq!(login_command("claude").unwrap().1, &["auth", "login", "--claudeai"]);
        assert_eq!(login_command("codex").unwrap(), ("codex", &["login"][..]));
        assert!(login_command("gemini").is_none());
    }
}
