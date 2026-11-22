use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::detect::cli_binary;
use super::spawn::{find_on_path, spawn_lines, SpawnLinesOptions};
use crate::util::{assistant_prefix, child_env};

const AGY_INSTALL_SH_URL: &str = "https://antigravity.google/cli/install.sh";
const AGY_INSTALL_PS1_URL: &str = "https://antigravity.google/cli/install.ps1";

// Serialize assistant installs so shared directories/prefixes are never raced.
static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

fn npm_package(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("@anthropic-ai/claude-code"),
        "codex" => Some("@openai/codex"),
        _ => None,
    }
}

fn is_supported(agent: &str) -> bool {
    matches!(agent, "claude" | "codex" | "gemini")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallResult {
    Installed,
    NeedsNode,
}

pub async fn install(agent: &str, home: &Path) -> Result<InstallResult, String> {
    if !is_supported(agent) {
        return Err("This assistant cannot be installed by Scarlet.".into());
    }
    let _guard = INSTALL_LOCK.lock().await;
    let env = child_env(home);
    let binary = cli_binary(agent);
    if find_on_path(binary, &env).is_some() {
        log::info!("{agent} ({binary}) is already installed");
        return Ok(InstallResult::Installed);
    }
    if agent == "gemini" {
        return install_antigravity_cli(home, env).await;
    }
    let package = npm_package(agent).ok_or_else(|| "This assistant cannot be installed by Scarlet.".to_string())?;
    let npm_name = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let Some(npm) = find_on_path(npm_name, &env) else {
        log::warn!("cannot install {agent}: npm is not on PATH");
        return Ok(InstallResult::NeedsNode);
    };
    let prefix = assistant_prefix(home);
    tokio::fs::create_dir_all(&prefix).await.map_err(|e| {
        log::warn!("cannot install {agent}: could not create {}: {e}", prefix.display());
        "Cannot create Scarlet’s assistant folder for this user.".to_string()
    })?;
    log::info!("installing {agent} ({package}) into {}", prefix.display());
    // Run in Scarlet's own directory. The renderer cannot supply a package, registry or command line.
    let install_env = install_env(env, &prefix);
    let args = ["install", "--global", "--registry=https://registry.npmjs.org", "--no-fund", "--no-audit", package].map(String::from);
    let options = install_spawn_options(prefix, install_env, None);
    let outcome = spawn_lines(&npm, &args, options, Box::new(|_| false)).await.map_err(|e| {
        log::warn!("cannot install {agent}: npm did not start: {e:#}");
        "Could not start npm. Check your Node.js installation and try again.".to_string()
    })?;
    let found = find_on_path(binary, &child_env(home)).is_some();
    if outcome.code != Some(0) || !found {
        // npm's own line, just above, has its exit code and the end of what it said.
        log::warn!("{agent} install failed (npm exit code {:?}; {binary} {} on PATH)", outcome.code, if found { "is" } else { "is not" });
        return Err(failure_reason(&outcome).into());
    }
    log::info!("{agent} installed");
    Ok(InstallResult::Installed)
}

/// Install Antigravity CLI (`agy`) via its official HTTPS installer script.
/// `agy` is a standalone native binary and does not require Node.js.
async fn install_antigravity_cli(home: &Path, env: HashMap<String, String>) -> Result<InstallResult, String> {
    let url = if cfg!(windows) { AGY_INSTALL_PS1_URL } else { AGY_INSTALL_SH_URL };
    log::info!("installing gemini (Antigravity CLI) from {url}");
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| {
            log::warn!("cannot install gemini: HTTP client error: {e}");
            "Installation did not finish. Check your connection and try again.".to_string()
        })?;
    let response = client.get(url).send().await.map_err(|e| {
        log::warn!("cannot install gemini: failed to download installer: {e}");
        "Could not download the Gemini installer. Check your connection and try again.".to_string()
    })?;
    if !response.status().is_success() {
        log::warn!("cannot install gemini: installer download returned {}", response.status());
        return Err("Could not download the Gemini installer. Check your connection and try again.".into());
    }
    let script = response.text().await.map_err(|e| {
        log::warn!("cannot install gemini: failed to read installer script: {e}");
        "Could not download the Gemini installer. Check your connection and try again.".to_string()
    })?;
    let prefix = assistant_prefix(home);
    let restricted_env = install_env(env, &prefix);

    let outcome = if cfg!(windows) {
        let mut tmp = tempfile::Builder::new().suffix(".ps1").tempfile().map_err(|e| {
            log::warn!("cannot install gemini: failed to create temp script: {e}");
            "Scarlet could not write the assistant files. Check your folder permissions and try again.".to_string()
        })?;
        std::io::Write::write_all(&mut tmp, script.as_bytes()).map_err(|e| {
            log::warn!("cannot install gemini: failed to write temp script: {e}");
            "Scarlet could not write the assistant files. Check your folder permissions and try again.".to_string()
        })?;
        let script_path = tmp.path().to_string_lossy().into_owned();
        let args = [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path,
        ]
        .map(String::from);
        let options = install_spawn_options(home.to_path_buf(), restricted_env, None);
        spawn_lines("powershell.exe", &args, options, Box::new(|_| false)).await
    } else {
        let shell = find_on_path("bash", &restricted_env).unwrap_or_else(|| "/bin/sh".into());
        let args = ["-s".to_string()];
        let options = install_spawn_options(home.to_path_buf(), restricted_env, Some(script));
        spawn_lines(&shell, &args, options, Box::new(|_| false)).await
    }
    .map_err(|e| {
        log::warn!("cannot install gemini: installer did not start: {e:#}");
        "Could not start the Gemini installer. Try again.".to_string()
    })?;

    let found = find_on_path("agy", &child_env(home)).is_some();
    if outcome.code != Some(0) || !found {
        log::warn!(
            "gemini install failed (exit code {:?}; agy {} on PATH)",
            outcome.code,
            if found { "is" } else { "is not" }
        );
        return Err(gemini_failure_reason(&outcome).into());
    }
    log::info!("gemini (agy) installed");
    Ok(InstallResult::Installed)
}

fn install_spawn_options(cwd: std::path::PathBuf, env: HashMap<String, String>, stdin: Option<String>) -> SpawnLinesOptions {
    SpawnLinesOptions {
        cwd,
        env,
        stdin,
        cancel: CancellationToken::new(),
        timeout: Some(Duration::from_secs(300)),
        stall: None,
        task: None,
    }
}

/// What npm / installers run with: Scarlet's own prefix and the few variables an install needs. Nothing else the app
/// inherited reaches it, so no token or registry setting from the environment does.
fn install_env(env: HashMap<String, String>, prefix: &Path) -> HashMap<String, String> {
    const ALLOWED: &[&str] = &[
        "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
        "APPDATA", "LOCALAPPDATA", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
    ];
    let mut install_env = crate::util::env_filter_allowlist(env, ALLOWED);
    install_env.insert("npm_config_prefix".into(), prefix.to_string_lossy().into_owned());
    install_env
}

fn install_failure_reason(outcome: &super::spawn::SpawnOutcome, fallback: &'static str) -> &'static str {
    if outcome.timed_out {
        "Installation timed out. Check your connection and try again."
    } else if outcome.stderr.contains("No space left") || outcome.stderr.contains("ENOSPC") {
        "Free some disk space and try installing again."
    } else if outcome.stderr.contains("Permission denied") || outcome.stderr.contains("EACCES") || outcome.stderr.contains("EPERM") {
        "Scarlet could not write the assistant files. Check your folder permissions and try again."
    } else {
        fallback
    }
}

/// What to tell the editor when an npm install did not finish.
fn failure_reason(outcome: &super::spawn::SpawnOutcome) -> &'static str {
    install_failure_reason(outcome, "Installation did not finish. Check your connection and Node.js installation, then try again.")
}

/// What to tell the editor when the Antigravity CLI install did not finish.
fn gemini_failure_reason(outcome: &super::spawn::SpawnOutcome) -> &'static str {
    install_failure_reason(outcome, "Installation did not finish. Check your connection and try again.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_installs_supported_providers() {
        assert!(is_supported("codex"));
        assert!(is_supported("claude"));
        assert!(is_supported("gemini"));
        assert!(!is_supported("file:/other/package"));
        assert_eq!(npm_package("codex"), Some("@openai/codex"));
        assert_eq!(npm_package("claude"), Some("@anthropic-ai/claude-code"));
        assert_eq!(npm_package("gemini"), None);
    }

    #[test]
    fn gives_npm_only_what_an_install_needs_from_the_environment() {
        let inherited = HashMap::from(
            [
                ("Path", "/usr/bin"),
                ("HOME", "/home/editor"),
                ("https_proxy", "http://proxy:8080"),
                ("NODE_EXTRA_CA_CERTS", "/etc/ca.pem"),
                // None of these may reach npm: a token, another registry, another prefix, a script to preload.
                ("NPM_TOKEN", "npm_secret"),
                ("ANTHROPIC_API_KEY", "sk-ant"),
                ("GEMINI_API_KEY", "AIza-secret"),
                ("npm_config_registry", "https://registry.example.com"),
                ("NPM_CONFIG_PREFIX", "/somewhere/else"),
                ("NODE_OPTIONS", "--require /tmp/x.js"),
                ("PATHS", "not PATH"),
            ]
            .map(|(k, v)| (k.to_string(), v.to_string())),
        );
        let env = install_env(inherited, Path::new("/home/editor/.scarlet/assistants"));
        let mut names: Vec<&str> = env.keys().map(String::as_str).collect();
        names.sort();
        assert_eq!(names, ["HOME", "NODE_EXTRA_CA_CERTS", "Path", "https_proxy", "npm_config_prefix"]);
        assert_eq!(env["npm_config_prefix"], "/home/editor/.scarlet/assistants");
    }

    #[test]
    fn tells_the_editor_why_an_install_did_not_finish() {
        use crate::host::spawn::SpawnOutcome;
        let said = |stderr: &str| failure_reason(&SpawnOutcome { code: Some(1), stderr: stderr.into(), ..Default::default() });
        assert!(said("npm ERR! code ENOSPC\nnpm ERR! nospc no space left on device").starts_with("Free some disk space"));
        assert!(said("npm ERR! code EACCES\nnpm ERR! syscall mkdir").starts_with("Scarlet could not write the assistant files"));
        assert!(said("npm error code EPERM").starts_with("Scarlet could not write the assistant files"));
        assert!(said("npm ERR! code ETIMEDOUT").starts_with("Installation did not finish"));
        assert!(said("").starts_with("Installation did not finish"));
        // A timeout is the reason whatever npm had printed by then.
        let timed_out = SpawnOutcome { timed_out: true, killed: true, stderr: "npm ERR! code EACCES".into(), ..Default::default() };
        assert!(failure_reason(&timed_out).starts_with("Installation timed out"));
    }

    #[tokio::test]
    async fn refuses_an_assistant_it_does_not_install_before_touching_anything() {
        let dir = tempfile::tempdir().unwrap();
        let refused = install("unknown-agent", dir.path()).await;
        assert_eq!(refused.err().as_deref(), Some("This assistant cannot be installed by Scarlet."));
        assert!(install("@openai/codex", dir.path()).await.is_err());
        // No assistant folder was made for a request that was never going to install anything.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
