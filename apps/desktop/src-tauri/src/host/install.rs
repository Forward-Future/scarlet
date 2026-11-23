use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::detect::cli_binary;
use super::spawn::{find_on_path, spawn_lines, SpawnLinesOptions};
use crate::util::{assistant_prefix, child_env};

struct NativeInstaller {
    label: &'static str,
    sh_url: &'static str,
    ps1_url: &'static str,
}

fn native_installer(agent: &str) -> Option<NativeInstaller> {
    match agent {
        "claude" => Some(NativeInstaller {
            label: "Claude Code",
            sh_url: "https://claude.ai/install.sh",
            ps1_url: "https://claude.ai/install.ps1",
        }),
        "codex" => Some(NativeInstaller {
            label: "Codex",
            sh_url: "https://chatgpt.com/codex/install.sh",
            ps1_url: "https://chatgpt.com/codex/install.ps1",
        }),
        "gemini" => Some(NativeInstaller {
            label: "Gemini",
            sh_url: "https://antigravity.google/cli/install.sh",
            ps1_url: "https://antigravity.google/cli/install.ps1",
        }),
        _ => None,
    }
}

// Serialize assistant installs so shared directories/prefixes are never raced.
static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

fn npm_package(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("@anthropic-ai/claude-code"),
        "codex" => Some("@openai/codex"),
        _ => None,
    }
}

#[cfg(test)]
fn is_supported(agent: &str) -> bool {
    native_installer(agent).is_some()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallResult {
    Installed,
    NeedsNode,
}

pub async fn install(agent: &str, home: &Path) -> Result<InstallResult, String> {
    let Some(native) = native_installer(agent) else {
        return Err("This assistant cannot be installed by Scarlet.".into());
    };
    let _guard = INSTALL_LOCK.lock().await;
    let env = child_env(home);
    let binary = cli_binary(agent);
    if find_on_path(binary, &env).is_some() {
        log::info!("{agent} ({binary}) is already installed");
        return Ok(InstallResult::Installed);
    }
    match install_via_script(agent, binary, native, home, env.clone()).await {
        Ok(result) => return Ok(result),
        Err(native_err) => {
            // Claude Code and Codex ship standalone native binaries, so non-developers don't need Node.js.
            // If the standalone install fails on a machine that already has npm, try the npm package as a fallback.
            if let Some(package) = npm_package(agent) {
                let npm_name = if cfg!(windows) { "npm.cmd" } else { "npm" };
                if let Some(npm) = find_on_path(npm_name, &env) {
                    log::warn!("{agent} standalone install failed ({native_err}); falling back to npm ({package})");
                    return install_via_npm(agent, binary, package, &npm, home, env).await;
                }
            }
            Err(native_err)
        }
    }
}

async fn install_via_npm(
    agent: &str,
    binary: &str,
    package: &str,
    npm: &str,
    home: &Path,
    env: HashMap<String, String>,
) -> Result<InstallResult, String> {
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
    let outcome = spawn_lines(npm, &args, options, Box::new(|_| false)).await.map_err(|e| {
        log::warn!("cannot install {agent}: npm did not start: {e:#}");
        "Could not start npm. Check your Node.js installation and try again.".to_string()
    })?;
    let found = find_on_path(binary, &child_env(home)).is_some();
    if outcome.code != Some(0) || !found {
        // npm's own line, just above, has its exit code and the end of what it said.
        log::warn!("{agent} install failed (npm exit code {:?}; {binary} {} on PATH)", outcome.code, if found { "is" } else { "is not" });
        return Err(failure_reason(&outcome).into());
    }
    log::info!("{agent} installed via npm");
    Ok(InstallResult::Installed)
}

/// Install a standalone native assistant CLI via its official HTTPS installer script (no Node.js required).
async fn install_via_script(
    agent: &str,
    binary: &str,
    installer: NativeInstaller,
    home: &Path,
    env: HashMap<String, String>,
) -> Result<InstallResult, String> {
    let url = if cfg!(windows) { installer.ps1_url } else { installer.sh_url };
    let label = installer.label;
    log::info!("installing {agent} ({label}) from {url}");
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| {
            log::warn!("cannot install {agent}: HTTP client error: {e}");
            "Installation did not finish. Check your connection and try again.".to_string()
        })?;
    let response = client.get(url).send().await.map_err(|e| {
        log::warn!("cannot install {agent}: failed to download installer: {e}");
        format!("Could not download the {label} installer. Check your connection and try again.")
    })?;
    if !response.status().is_success() {
        log::warn!("cannot install {agent}: installer download returned {}", response.status());
        return Err(format!("Could not download the {label} installer. Check your connection and try again."));
    }
    let script = response.text().await.map_err(|e| {
        log::warn!("cannot install {agent}: failed to read installer script: {e}");
        format!("Could not download the {label} installer. Check your connection and try again.")
    })?;
    let prefix = assistant_prefix(home);
    let restricted_env = install_env(env, &prefix);

    let outcome = if cfg!(windows) {
        let mut tmp = tempfile::Builder::new().suffix(".ps1").tempfile().map_err(|e| {
            log::warn!("cannot install {agent}: failed to create temp script: {e}");
            "Scarlet could not write the assistant files. Check your folder permissions and try again.".to_string()
        })?;
        std::io::Write::write_all(&mut tmp, script.as_bytes()).map_err(|e| {
            log::warn!("cannot install {agent}: failed to write temp script: {e}");
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
        log::warn!("cannot install {agent}: installer did not start: {e:#}");
        format!("Could not start the {label} installer. Try again.")
    })?;

    let found = find_on_path(binary, &child_env(home)).is_some();
    if outcome.code != Some(0) || !found {
        log::warn!(
            "{agent} install failed (exit code {:?}; {binary} {} on PATH)",
            outcome.code,
            if found { "is" } else { "is not" }
        );
        return Err(native_failure_reason(&outcome).into());
    }
    log::info!("{agent} ({binary}) installed");
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

/// What to tell the editor when a standalone native installer did not finish.
fn native_failure_reason(outcome: &super::spawn::SpawnOutcome) -> &'static str {
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
        for agent in ["claude", "codex", "gemini"] {
            let native = native_installer(agent).expect("all supported assistants have standalone native installers");
            assert!(native.sh_url.starts_with("https://"), "{agent} sh_url must be https");
            assert!(native.ps1_url.starts_with("https://"), "{agent} ps1_url must be https");
        }
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
