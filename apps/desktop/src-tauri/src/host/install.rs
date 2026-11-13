use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::spawn::{find_on_path, spawn_lines, SpawnLinesOptions};
use crate::util::{assistant_prefix, child_env};

// Both supported agents share one user-local npm prefix.
static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

fn package(agent: &str) -> Result<&'static str, String> {
    match agent {
        "claude" => Ok("@anthropic-ai/claude-code"),
        "codex" => Ok("@openai/codex"),
        _ => Err("This assistant cannot be installed by Scarlet.".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallResult {
    Installed,
    NeedsNode,
}

pub async fn install(agent: &str, home: &Path) -> Result<InstallResult, String> {
    let package = package(agent)?;
    let _guard = INSTALL_LOCK.lock().await;
    let env = child_env(home);
    if find_on_path(agent, &env).is_some() {
        log::info!("{agent} is already installed");
        return Ok(InstallResult::Installed);
    }
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
    let options = SpawnLinesOptions {
        cwd: prefix,
        env: install_env,
        stdin: None,
        cancel: CancellationToken::new(),
        timeout: Some(Duration::from_secs(300)),
        stall: None,
        task: None,
    };
    let outcome = spawn_lines(&npm, &args, options, Box::new(|_| false)).await.map_err(|e| {
        log::warn!("cannot install {agent}: npm did not start: {e:#}");
        "Could not start npm. Check your Node.js installation and try again.".to_string()
    })?;
    let found = find_on_path(agent, &child_env(home)).is_some();
    if outcome.code != Some(0) || !found {
        // npm's own line, just above, has its exit code and the end of what it said.
        log::warn!("{agent} install failed (npm exit code {:?}; {agent} {} on PATH)", outcome.code, if found { "is" } else { "is not" });
        return Err(failure_reason(&outcome).into());
    }
    log::info!("{agent} installed");
    Ok(InstallResult::Installed)
}

/// What npm runs with: Scarlet's own prefix and the few variables an install needs. Nothing else the app
/// inherited reaches it, so no token or registry setting from the environment does.
fn install_env(env: HashMap<String, String>, prefix: &Path) -> HashMap<String, String> {
    let mut install_env: HashMap<_, _> = env.into_iter().filter(|(k, _)| matches!(
        k.to_ascii_uppercase().as_str(),
        "PATH" | "HOME" | "USERPROFILE" | "SYSTEMROOT" | "COMSPEC" | "PATHEXT" | "TEMP" | "TMP" | "TMPDIR"
        | "APPDATA" | "LOCALAPPDATA" | "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY" | "NODE_EXTRA_CA_CERTS"
    )).collect();
    install_env.insert("npm_config_prefix".into(), prefix.to_string_lossy().into_owned());
    install_env
}

/// What to tell the editor when an install did not finish.
fn failure_reason(outcome: &super::spawn::SpawnOutcome) -> &'static str {
    if outcome.timed_out {
        "Installation timed out. Check your connection and try again."
    } else if outcome.stderr.contains("ENOSPC") {
        "Free some disk space and try installing again."
    } else if outcome.stderr.contains("EACCES") || outcome.stderr.contains("EPERM") {
        "Scarlet could not write the assistant files. Check your folder permissions and try again."
    } else {
        "Installation did not finish. Check your connection and Node.js installation, then try again."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_installs_the_two_supported_provider_packages() {
        assert_eq!(package("codex").unwrap(), "@openai/codex");
        assert_eq!(package("claude").unwrap(), "@anthropic-ai/claude-code");
        assert!(package("file:/other/package").is_err());
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
        let refused = install("gemini", dir.path()).await;
        assert_eq!(refused.err().as_deref(), Some("This assistant cannot be installed by Scarlet."));
        assert!(install("@openai/codex", dir.path()).await.is_err());
        // No assistant folder was made for a request that was never going to install anything.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
