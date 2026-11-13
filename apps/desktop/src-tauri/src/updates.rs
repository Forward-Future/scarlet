use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn socket_path(app: &AppHandle) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    // A development build can be pointed at a stand-in updater folder to show each state of the update button.
    #[cfg(debug_assertions)]
    if let Some(folder) = std::env::var_os("SCARLET_UPDATER_DIR") {
        return Some(PathBuf::from(folder).join("ready.sock"));
    }
    let config = app.config();
    let bundle = format!("{}.app", config.product_name.as_deref()?);
    let macos = Path::new("/Applications").join(bundle).join("Contents/MacOS");
    if std::env::current_exe().ok()?.parent()? != macos {
        return None;
    }
    // Each separately named review build has its own updater namespace.
    let cache = app.path().app_cache_dir().ok()?;
    Some(cache.with_file_name(format!("{}.main-updater.noindex", config.identifier)).join("ready.sock"))
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

#[cfg(target_os = "macos")]
async fn exchange(app: &AppHandle, message: String) -> Option<String> {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let path = socket_path(app)?;
    let reply = async {
        let mut socket = tokio::net::UnixStream::connect(path).await?;
        socket.write_all(message.as_bytes()).await?;
        let mut response = String::new();
        socket.take(65).read_to_string(&mut response).await?;
        Ok::<_, std::io::Error>(response.trim_end().to_owned())
    };
    tokio::time::timeout(Duration::from_secs(2), reply).await.ok()?.ok()
}

#[cfg(not(target_os = "macos"))]
async fn exchange(_app: &AppHandle, _message: String) -> Option<String> {
    None
}

#[tauri::command]
pub async fn latest_update_revision(app: AppHandle) -> Result<String, String> {
    let mut git = tokio::process::Command::new("git");
    crate::util::hide_console(&mut git);
    git.args(["ls-remote", "--exit-code", "https://github.com/Forward-Future/scarlet.git", "refs/heads/main"])
        .current_dir(std::env::temp_dir())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), git.output()).await
        .map_err(|_| {
            log::warn!("update check: git ls-remote gave no answer in 30 s");
            "The update check timed out. Try again."
        })?
        .map_err(|e| {
            log::warn!("update check: could not run git: {e}");
            "Couldn’t run Git to check for updates. Make sure Git is installed."
        })?;
    if !output.status.success() {
        let said = crate::util::stderr_tail_line(&String::from_utf8_lossy(&output.stderr)).unwrap_or_default();
        log::warn!("update check: git ls-remote failed ({}): {said}", output.status);
        return Err("Couldn’t check for updates. Check your connection and Git access to the Scarlet repository, then try again.".into());
    }
    let revision = main_revision(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        log::warn!("update check: git ls-remote named no revision for main ({} bytes)", output.stdout.len());
        "GitHub returned an unexpected revision. Try again.".to_owned()
    })?;
    // A worker offering an older build can fetch main now, even between its scheduled checks.
    let _ = exchange(&app, format!("check {revision}\n")).await;
    Ok(revision)
}

/// The revision `git ls-remote` printed for main: one line, the revision, a tab and the branch.
fn main_revision(stdout: &str) -> Option<String> {
    stdout.trim_end().split_once('\t')
        .filter(|(revision, name)| valid_revision(revision) && *name == "refs/heads/main")
        .map(|(revision, _)| revision.to_owned())
}

/// A build the updater has under way. `done` and `step` are shares of the whole build: what finished before the
/// current part began, and that part's own share, which is expected to take `step_seconds` from `step_started`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBuild {
    revision: String,
    done: f64,
    step: f64,
    step_started: f64,
    step_seconds: f64,
}

#[derive(serde::Serialize)]
pub struct UpdateStatus {
    /// A verified build that installs on restart.
    ready: Option<String>,
    building: Option<UpdateBuild>,
}

/// The updater writes this file while it builds and removes it when the build ends.
fn building(app: &AppHandle) -> Option<UpdateBuild> {
    let path = socket_path(app)?.with_file_name("status.json");
    // No part of a build runs longer than an hour, so an older file was left by an updater that was killed.
    let age = std::fs::metadata(&path).ok()?.modified().ok()?.elapsed().unwrap_or_default();
    if age > std::time::Duration::from_secs(3600) {
        return None;
    }
    build_status(&std::fs::read(&path).ok()?)
}

/// The build a status file describes, when it describes one under way.
fn build_status(raw: &[u8]) -> Option<UpdateBuild> {
    let status: serde_json::Value = serde_json::from_slice(raw).ok()?;
    if status.get("state")?.as_str()? != "building" {
        return None;
    }
    let build: UpdateBuild = serde_json::from_value(status).ok()?;
    let shares = [build.done, build.step, build.step_started, build.step_seconds];
    (valid_revision(&build.revision) && shares.iter().all(|n| n.is_finite() && *n >= 0.0)).then_some(build)
}

#[tauri::command]
pub async fn update_status(app: AppHandle) -> UpdateStatus {
    let ready = exchange(&app, "ready\n".into()).await.filter(|s| valid_revision(s));
    UpdateStatus { ready, building: building(&app) }
}

#[tauri::command]
pub async fn restart_for_update(app: AppHandle, revision: String) -> Result<(), String> {
    if !valid_revision(&revision) {
        log::warn!("restart for an update refused: not a revision");
        return Err("Invalid update revision.".into());
    }
    match exchange(&app, format!("restart {revision}\n")).await.as_deref() {
        Some("accepted") => {}
        answer => {
            log::warn!("restart to install {revision} refused: the updater answered {answer:?}");
            return Err("This update is no longer ready. Scarlet will check again.".into());
        }
    }
    log::info!("restarting to install {revision}");
    // Normal exit stops the host and engine. The external worker reopens the installed app.
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REVISION: &str = "2221674a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";

    #[test]
    fn takes_only_a_full_lowercase_revision() {
        assert!(valid_revision(REVISION));
        for bad in ["", "2221674", &REVISION[..39], &format!("{REVISION}0"), &REVISION.to_uppercase(), &REVISION.replace('a', "g"), &format!("{} ", &REVISION[..39]), "restart 22216\naccepted"] {
            assert!(!valid_revision(bad), "accepted {bad:?}");
        }
    }

    #[test]
    fn reads_mains_revision_from_what_git_prints() {
        assert_eq!(main_revision(&format!("{REVISION}\trefs/heads/main\n")).as_deref(), Some(REVISION));
        assert_eq!(main_revision(&format!("{REVISION}\trefs/heads/main")).as_deref(), Some(REVISION));
        // Another branch, a tag, a second line, an abbreviated revision or no answer at all is not main's revision.
        assert_eq!(main_revision(&format!("{REVISION}\trefs/heads/maintenance\n")), None);
        assert_eq!(main_revision(&format!("{REVISION}\trefs/tags/main\n")), None);
        assert_eq!(main_revision(&format!("{REVISION}\trefs/heads/main\n{REVISION}\trefs/heads/other\n")), None);
        assert_eq!(main_revision(&format!("{REVISION} refs/heads/main\n")), None);
        assert_eq!(main_revision("2221674\trefs/heads/main\n"), None);
        assert_eq!(main_revision(""), None);
    }

    #[test]
    fn reads_a_build_under_way_from_the_updaters_status_file() {
        let status = |change: &dyn Fn(&mut serde_json::Value)| {
            let mut status = serde_json::json!({ "state": "building", "revision": REVISION, "done": 0.25, "step": 0.5, "stepStarted": 1_762_600_000.5, "stepSeconds": 240 });
            change(&mut status);
            build_status(status.to_string().as_bytes())
        };
        let build = status(&|_| {}).expect("a build under way");
        assert_eq!((build.revision.as_str(), build.done, build.step, build.step_started, build.step_seconds), (REVISION, 0.25, 0.5, 1_762_600_000.5, 240.0));
        // The window gets it under the names the updater wrote.
        assert_eq!(serde_json::to_value(&build).unwrap()["stepSeconds"], serde_json::json!(240.0));
        // Any other state, a revision that isn't one, a share below zero or a missing figure is no build to show.
        assert!(status(&|s| s["state"] = "failed".into()).is_none());
        assert!(status(&|s| s["state"] = serde_json::Value::Null).is_none());
        assert!(status(&|s| s["revision"] = "main".into()).is_none());
        assert!(status(&|s| s["done"] = (-0.1).into()).is_none());
        assert!(status(&|s| s["step"] = "half".into()).is_none());
        assert!(status(&|s| { s.as_object_mut().unwrap().remove("stepSeconds"); }).is_none());
        assert!(build_status(b"").is_none());
        assert!(build_status(b"{\"state\":\"building\"").is_none());
        assert!(build_status(b"[]").is_none());
    }
}
