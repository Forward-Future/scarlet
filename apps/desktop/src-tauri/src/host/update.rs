//! Keep the editor's Claude Code, Codex and Gemini (Antigravity CLI) current, as T3 Code does. Now and then Scarlet
//! looks up the newest published version of each installed CLI, and Settings offers to update one that is behind.
//! An update goes the way the CLI was installed, in place, so it never leaves a second copy behind the first on PATH:
//!
//! - Claude Code and the Antigravity CLI update themselves (`claude update`, `agy update`), whichever way they came.
//! - Codex installed with npm is updated by npm in the folder it is in (Scarlet's own or the editor's).
//! - Codex installed with Homebrew is updated by Homebrew.
//! - Any other Codex (the one inside the ChatGPT app, say) updates with whatever brought it, and Scarlet offers nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use super::detect::cli_binary;
use super::install::{install_env, install_failure_reason, install_spawn_options, npm_package, INSTALL_LOCK};
use super::spawn::{find_on_path, spawn_lines, SpawnLinesOptions};
use super::types::{AgentAvailability, CLI_AGENTS};
use crate::util::child_env;

/// How often Scarlet looks for newer versions while it stays open.
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// A lookup that failed (offline, say) is tried again this much sooner.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(30 * 60);
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
/// Where the Antigravity CLI's own installer reads the newest build for each platform.
const AGY_MANIFESTS: &str = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

/// How a CLI that is installed gets its update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Updater {
    /// The CLI updates itself, whichever way it was installed.
    SelfUpdate,
    /// An npm install, updated by npm in the prefix it is in.
    Npm { prefix: PathBuf },
    /// A Homebrew formula or cask.
    Homebrew,
}

/// How the CLI at `binary` can be updated, or None when Scarlet can't do it in place.
pub fn updater_for(agent: &str, binary: &Path) -> Option<Updater> {
    match agent {
        "claude" | "gemini" => Some(Updater::SelfUpdate),
        "codex" => {
            let package = npm_package(agent)?;
            if let Some(prefix) = npm_prefix(binary, package) {
                return Some(Updater::Npm { prefix });
            }
            let real = std::fs::canonicalize(binary).ok()?;
            real.components().any(|c| matches!(c.as_os_str().to_str(), Some("Cellar" | "Caskroom"))).then_some(Updater::Homebrew)
        }
        _ => None,
    }
}

/// The npm prefix `binary` was installed into, when npm put it there: on Windows the `.cmd` sits in the prefix beside
/// `node_modules`; elsewhere `prefix/bin/codex` links to `prefix/lib/node_modules/@openai/codex/…`. pnpm, bun and Volta
/// keep their own layouts and are left to themselves.
fn npm_prefix(binary: &Path, package: &str) -> Option<PathBuf> {
    let beside = binary.parent()?;
    if beside.join("node_modules").join(package).join("package.json").is_file() {
        return Some(beside.to_path_buf());
    }
    let real = std::fs::canonicalize(binary).ok()?;
    let package_dir = real.ancestors().find(|p| p.ends_with(Path::new("node_modules").join(package)))?;
    let mut node_modules = package_dir.to_path_buf();
    for _ in Path::new(package).components() {
        node_modules.pop();
    }
    let lib = node_modules.parent()?;
    (lib.file_name()? == "lib").then(|| lib.parent().map(Path::to_path_buf)).flatten()
}

/// Whether `latest` is a newer version than `installed`. A version that can't be read is never newer.
pub fn is_newer(latest: &str, installed: &str) -> bool {
    match (semver::Version::parse(latest), semver::Version::parse(installed)) {
        (Ok(l), Ok(i)) => l > i,
        _ => false,
    }
}

struct Lookup {
    at: Instant,
    latest: Option<String>,
}

/// The last lookup per agent, so a refresh or a second window doesn't ask the registry again.
static LATEST: LazyLock<StdMutex<HashMap<String, Lookup>>> = LazyLock::new(Default::default);
/// The newest version an agent's own updater ran for and left as it was: its channel or tap is behind the registry,
/// and offering the same update again would do nothing. A newer version is offered as usual.
static ALREADY_TRIED: LazyLock<StdMutex<HashMap<String, String>>> = LazyLock::new(Default::default);

/// The newest published version of the agent's CLI, from the last lookup while it is fresh.
pub async fn latest_version(agent: &str) -> Option<String> {
    if let Some(l) = LATEST.lock().unwrap().get(agent) {
        let fresh_for = if l.latest.is_some() { CHECK_EVERY } else { RETRY_AFTER_FAILURE };
        if l.at.elapsed() < fresh_for {
            return l.latest.clone();
        }
    }
    let latest = fetch_latest(agent).await;
    match &latest {
        Some(v) => log::info!("{agent}: the newest published version is {v}"),
        None => log::info!("{agent}: could not look up the newest published version"),
    }
    LATEST.lock().unwrap().insert(agent.to_string(), Lookup { at: Instant::now(), latest: latest.clone() });
    latest
}

async fn fetch_latest(agent: &str) -> Option<String> {
    let url = match agent {
        "claude" | "codex" => format!("{NPM_REGISTRY}/{}/latest", npm_package(agent)?),
        "gemini" => format!("{AGY_MANIFESTS}/{}.json", agy_platform()?),
        _ => return None,
    };
    let client = reqwest::Client::builder().https_only(true).timeout(Duration::from_secs(15)).build().ok()?;
    let body: serde_json::Value = client.get(&url).send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
    let version = body.get("version")?.as_str()?.trim();
    semver::Version::parse(version).ok().map(|_| version.to_string())
}

/// The Antigravity CLI's name for this platform in its release manifests.
fn agy_platform() -> Option<String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(format!("{os}_{arch}"))
}

/// The update to offer for `agent`: the newest published version, when it is newer than the one installed, Scarlet
/// can install it the way this copy was installed, and the CLI's own updater hasn't already left that version alone.
pub fn offer(agent: &AgentAvailability, latest: Option<&str>, binary: Option<&Path>) -> Option<String> {
    let latest = latest?;
    let installed = agent.version.as_deref()?;
    if !agent.installed || !is_newer(latest, installed) {
        return None;
    }
    if ALREADY_TRIED.lock().unwrap().get(&agent.id).map(String::as_str) == Some(latest) {
        return None;
    }
    updater_for(&agent.id, binary?)?;
    Some(latest.to_string())
}

/// The update to offer for each installed agent in `agents`, by id, looked up as needed.
pub async fn offers(agents: &[AgentAvailability], env: &HashMap<String, String>) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for agent in agents {
        // Ollama, LM Studio and OpenRouter aren't CLIs Scarlet updates.
        let offer = if agent.installed && agent.version.is_some() && CLI_AGENTS.contains(&agent.id.as_str()) {
            let latest = latest_version(&agent.id).await;
            let binary = find_on_path(cli_binary(&agent.id), env).map(PathBuf::from);
            offer(agent, latest.as_deref(), binary.as_deref())
        } else {
            None
        };
        out.push((agent.id.clone(), offer));
    }
    out
}

/// The update ran and the CLI is still at `installed`: don't offer `latest` again (see `ALREADY_TRIED`).
pub fn note_unchanged(agent: &str, installed: Option<&str>) {
    let Some(latest) = LATEST.lock().unwrap().get(agent).and_then(|l| l.latest.clone()) else { return };
    if installed.is_some_and(|v| is_newer(&latest, v)) {
        log::info!("{agent}: its updater left it at {} with {latest} published; not offering {latest} again", installed.unwrap_or("?"));
        ALREADY_TRIED.lock().unwrap().insert(agent.to_string(), latest);
    }
}

/// Update the installed CLI for `agent` in place. The caller detects the CLIs again afterwards to read the new version.
pub async fn update(agent: &str, home: &Path) -> Result<(), String> {
    if !matches!(agent, "claude" | "codex" | "gemini") {
        return Err("Scarlet can't update this assistant.".into());
    }
    let _guard = INSTALL_LOCK.lock().await;
    let env = child_env(home);
    let Some(binary) = find_on_path(cli_binary(agent), &env) else {
        return Err("It isn't installed on this computer anymore. Install it again from Settings.".into());
    };
    let Some(updater) = updater_for(agent, Path::new(&binary)) else {
        return Err("Scarlet can't update this copy. Update it the way you installed it.".into());
    };
    log::info!("updating {agent} at {binary} ({updater:?})");
    let options = |cwd: PathBuf, env: HashMap<String, String>| -> SpawnLinesOptions { install_spawn_options(cwd, env, None) };
    let outcome = match &updater {
        Updater::SelfUpdate => spawn_lines(&binary, &["update".to_string()], options(home.to_path_buf(), env), Box::new(log_line(agent))).await,
        Updater::Npm { prefix } => {
            let npm_name = if cfg!(windows) { "npm.cmd" } else { "npm" };
            // The npm beside the install first (nvm and Homebrew keep one per Node), then whichever is on PATH.
            let own = if cfg!(windows) { prefix.join(npm_name) } else { prefix.join("bin").join(npm_name) };
            let npm = own.is_file().then(|| own.to_string_lossy().into_owned()).or_else(|| find_on_path(npm_name, &env));
            let Some(npm) = npm else {
                return Err("Updating Codex needs Node.js, which isn't on this computer anymore.".into());
            };
            let package = format!("{}@latest", npm_package(agent).unwrap_or_default());
            let args = ["install", "--global", "--registry=https://registry.npmjs.org", "--no-fund", "--no-audit", &package].map(String::from);
            spawn_lines(&npm, &args, options(prefix.clone(), install_env(env, prefix)), Box::new(log_line(agent))).await
        }
        Updater::Homebrew => {
            let Some(brew) = find_on_path("brew", &env) else {
                return Err("Codex came from Homebrew, which Scarlet can't find. Update it with Homebrew.".into());
            };
            let args = ["upgrade", "codex"].map(String::from);
            spawn_lines(&brew, &args, options(home.to_path_buf(), env), Box::new(log_line(agent))).await
        }
    }
    .map_err(|e| {
        log::warn!("cannot update {agent}: the updater did not start: {e:#}");
        "The update couldn't start. Try again.".to_string()
    })?;
    if outcome.code != Some(0) {
        log::warn!("{agent} update failed (exit code {:?})", outcome.code);
        return Err(install_failure_reason(&outcome, "The update didn't finish. Check your connection and try again.").into());
    }
    log::info!("{agent} updater finished");
    Ok(())
}

/// What an updater prints goes to the log, so a failed update can be read there.
fn log_line(agent: &str) -> impl FnMut(&str) -> bool + Send + 'static {
    let agent = agent.to_string();
    move |line: &str| {
        if !line.trim().is_empty() {
            log::info!("{agent} update: {}", line.trim());
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(id: &str, version: &str) -> AgentAvailability {
        AgentAvailability { id: id.into(), installed: true, version: Some(version.into()), ..Default::default() }
    }

    #[test]
    fn a_newer_version_is_one_semver_puts_after_the_installed_one() {
        assert!(is_newer("2.1.330", "2.1.329"));
        assert!(is_newer("0.171.0", "0.50.0"));
        assert!(!is_newer("2.1.329", "2.1.329"));
        assert!(!is_newer("0.171.0", "0.172.0-alpha.1"));
        assert!(is_newer("1.0.0", "1.0.0-beta.2"));
        assert!(!is_newer("not a version", "1.0.0"));
        assert!(!is_newer("1.0.1", "unknown"));
    }

    #[test]
    fn claude_and_gemini_update_themselves_wherever_they_are() {
        let anywhere = Path::new("/nowhere/claude");
        assert_eq!(updater_for("claude", anywhere), Some(Updater::SelfUpdate));
        assert_eq!(updater_for("gemini", Path::new("/nowhere/agy")), Some(Updater::SelfUpdate));
        assert_eq!(updater_for("other", anywhere), None);
    }

    #[test]
    fn codex_from_npm_updates_in_the_prefix_it_is_in() {
        let dir = tempfile::tempdir().unwrap();
        let prefix = std::fs::canonicalize(dir.path()).unwrap();
        // Windows: the shim sits in the prefix beside node_modules.
        std::fs::create_dir_all(prefix.join("node_modules/@openai/codex")).unwrap();
        std::fs::write(prefix.join("node_modules/@openai/codex/package.json"), "{}").unwrap();
        std::fs::write(prefix.join("codex.cmd"), "").unwrap();
        assert_eq!(updater_for("codex", &prefix.join("codex.cmd")), Some(Updater::Npm { prefix: prefix.clone() }));

        #[cfg(unix)]
        {
            // Elsewhere: prefix/bin/codex links into prefix/lib/node_modules.
            let package = prefix.join("lib/node_modules/@openai/codex/bin");
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(package.join("codex.js"), "").unwrap();
            std::fs::create_dir_all(prefix.join("bin")).unwrap();
            std::os::unix::fs::symlink(package.join("codex.js"), prefix.join("bin/codex")).unwrap();
            assert_eq!(updater_for("codex", &prefix.join("bin/codex")), Some(Updater::Npm { prefix: prefix.clone() }));

            // Homebrew's cask, and a copy inside an app, which Scarlet leaves to what brought it.
            let cask = prefix.join("Caskroom/codex/0.171.0");
            std::fs::create_dir_all(&cask).unwrap();
            std::fs::write(cask.join("codex-aarch64-apple-darwin"), "").unwrap();
            std::fs::create_dir_all(prefix.join("homebrew/bin")).unwrap();
            std::os::unix::fs::symlink(cask.join("codex-aarch64-apple-darwin"), prefix.join("homebrew/bin/codex")).unwrap();
            assert_eq!(updater_for("codex", &prefix.join("homebrew/bin/codex")), Some(Updater::Homebrew));
            let app = prefix.join("ChatGPT.app/Contents/Resources/codex-cli/bin");
            std::fs::create_dir_all(&app).unwrap();
            std::fs::write(app.join("codex"), "").unwrap();
            assert_eq!(updater_for("codex", &app.join("codex")), None);
            // pnpm's global store has node_modules without npm's lib/ layout.
            let pnpm = prefix.join("pnpm/global/5/node_modules/@openai/codex/bin");
            std::fs::create_dir_all(&pnpm).unwrap();
            std::fs::write(pnpm.join("codex.js"), "").unwrap();
            assert_eq!(updater_for("codex", &pnpm.join("codex.js")), None);
        }
    }

    #[test]
    fn offers_a_newer_version_only_when_scarlet_can_install_it_and_not_one_its_updater_left_alone() {
        let claude = installed("claude", "2.1.329");
        let path = Path::new("/home/editor/.local/bin/claude");
        assert_eq!(offer(&claude, Some("2.1.330"), Some(path)).as_deref(), Some("2.1.330"));
        assert_eq!(offer(&claude, Some("2.1.329"), Some(path)), None);
        assert_eq!(offer(&claude, None, Some(path)), None);
        assert_eq!(offer(&claude, Some("2.1.330"), None), None);
        assert_eq!(offer(&AgentAvailability { version: None, ..claude.clone() }, Some("2.1.330"), Some(path)), None);
        // A Codex Scarlet can't update in place is never offered one.
        assert_eq!(offer(&installed("codex", "0.50.0"), Some("0.171.0"), Some(Path::new("/nowhere/codex"))), None);

        // The updater ran and left Gemini where it was: the same version isn't offered again, a newer one is.
        let gemini = installed("gemini", "1.5.14");
        let agy = Path::new("/home/editor/.local/bin/agy");
        LATEST.lock().unwrap().insert("gemini".into(), Lookup { at: Instant::now(), latest: Some("1.5.15".into()) });
        note_unchanged("gemini", Some("1.5.14"));
        assert_eq!(offer(&gemini, Some("1.5.15"), Some(agy)), None);
        assert_eq!(offer(&gemini, Some("1.5.16"), Some(agy)).as_deref(), Some("1.5.16"));
        ALREADY_TRIED.lock().unwrap().remove("gemini");
    }

    #[tokio::test]
    async fn refuses_an_assistant_it_does_not_update() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(update("@openai/codex", dir.path()).await.err().as_deref(), Some("Scarlet can't update this assistant."));
    }
}
