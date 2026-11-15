//! Updates for an installed release: Scarlet checks the release manifest it was built with, downloads a newer
//! release in the background, verifies its signature and offers to restart into it. Quitting installs it too.
//!
//! Only a release build has a manifest to check: CI writes `plugins.updater` (the manifest's address and the public
//! key releases are signed with) into the build's configuration. A build made from source has none, and is updated the
//! way it was built (`updates.rs`).

use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Long enough after launch that the check doesn't compete with opening the project.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(5 * 60);

/// Whether this build was made with a release manifest to update from.
pub fn configured(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater").is_some_and(|updater| updater.get("pubkey").is_some())
}

/// Why this copy can't replace itself, when it can't. A Mac app opened from its disk image or from Downloads before it
/// was moved runs from a read-only copy that macOS made, and an update would go nowhere.
pub fn cannot_update_in_place(exe: &Path) -> Option<&'static str> {
    let path = exe.to_string_lossy();
    if cfg!(target_os = "macos") && path.contains("/AppTranslocation/") {
        return Some("it runs from a copy macOS made because it wasn't moved to Applications");
    }
    if cfg!(target_os = "macos") && path.starts_with("/Volumes/") && exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .and_then(Path::parent).is_some_and(|parent| tempfile::tempfile_in(parent).is_err()) {
        return Some("it runs from a read-only volume");
    }
    None
}

#[derive(Default)]
struct Inner {
    /// A verified release that installs on restart, and where its package is.
    ready: Option<(Update, Arc<Mutex<File>>)>,
    /// The release being downloaded: its version, the bytes so far and the size the server gave.
    downloading: Option<(String, u64, Option<u64>)>,
    installing: bool,
    /// The editor chose Restart to update on Windows, where the release installs as Scarlet exits.
    relaunch: bool,
}

#[derive(Default)]
pub struct ReleaseUpdates {
    inner: Arc<Mutex<Inner>>,
    wake: tokio::sync::Notify,
    /// One check at a time, whether the timer or the editor asked for it.
    checking: tokio::sync::Mutex<()>,
}

/// What the window shows: the version that installs on restart, and the one under way with how much of it is here.
pub struct Status {
    pub ready: Option<String>,
    pub downloading: Option<(String, f64)>,
}

impl ReleaseUpdates {
    pub fn changelog(&self, version: &str) -> String {
        self.inner.lock().unwrap().ready.as_ref().filter(|(update, _)| update.version == version)
            .and_then(|(update, _)| update.body.clone()).unwrap_or_default()
    }

    pub fn status(&self) -> Status {
        let inner = self.inner.lock().unwrap();
        Status {
            ready: inner.ready.as_ref().map(|(update, _)| update.version.clone()),
            downloading: inner.downloading.as_ref().map(|(version, received, total)| (version.clone(), share(*received, *total))),
        }
    }
}

/// How much of a download is here, as a share. Without a size from the server it stays at the start.
fn share(received: u64, total: Option<u64>) -> f64 {
    match total {
        Some(total) if total > 0 => (received as f64 / total as f64).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

/// Check now and then for as long as the app runs, and download what's newer.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updates = app.state::<ReleaseUpdates>();
        tokio::select! { _ = tokio::time::sleep(FIRST_CHECK) => {}, _ = updates.wake.notified() => {} }
        loop {
            if let Err(error) = check(&app).await {
                log::warn!("release update: {error}");
            }
            tokio::select! { _ = tokio::time::sleep(CHECK_EVERY) => {}, _ = updates.wake.notified() => {} }
        }
    });
}

/// The newest release the manifest offers, when it is newer than this one, downloaded and verified.
async fn check(app: &AppHandle) -> Result<Option<String>, String> {
    let updates = app.state::<ReleaseUpdates>();
    let _one = updates.checking.lock().await;
    let found = app.updater().map_err(|e| format!("no updater: {e}"))?.check().await.map_err(|e| format!("check failed: {e}"))?;
    let Some(update) = found else { return Ok(None) };
    let version = update.version.clone();
    if let Some(ready) = updates.status().ready {
        if ready.parse::<semver::Version>().ok() >= version.parse::<semver::Version>().ok() {
            return Ok(Some(ready));
        }
    }
    log::info!("release update: downloading {version} (running {})", update.current_version);
    updates.inner.lock().unwrap().downloading = Some((version.clone(), 0, None));
    let progress = updates.inner.clone();
    // The package is checked against the release's signature before it comes back.
    let downloaded = update.download(move |chunk, total| {
        if let Some((_, received, size)) = progress.lock().unwrap().downloading.as_mut() {
            *received += chunk as u64;
            *size = total;
        }
    }, || {}).await;
    let kept = downloaded.map_err(|e| format!("download of {version} failed: {e}")).and_then(|bytes| keep(&bytes));
    let mut inner = updates.inner.lock().unwrap();
    inner.downloading = None;
    let file = kept?;
    // The release on offer until now gives way to the newer one.
    if !inner.installing {
        inner.ready = Some((update, file));
    }
    log::info!("release update: {version} is ready to install");
    Ok(Some(version))
}

// Anonymous packages disappear when the process exits, including after the Windows installer takes over.
fn keep(bytes: &[u8]) -> Result<Arc<Mutex<File>>, String> {
    let mut file = tempfile::tempfile().map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| format!("couldn’t stage the update: {e}"))?;
    Ok(Arc::new(Mutex::new(file)))
}

fn install(update: Update, package: &Mutex<File>) -> Result<(), String> {
    let mut file = package.lock().unwrap();
    file.rewind().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    update.install(bytes).map_err(|e| e.to_string())
}

/// The editor asked whether there is an update. Answers with the newest version there is, which then downloads if it
/// isn't here yet, or none when this one is the newest.
pub async fn check_now(app: &AppHandle) -> Result<Option<String>, String> {
    let updates = app.state::<ReleaseUpdates>();
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| {
        log::warn!("release update: check failed: {e}");
        "Couldn’t check for updates. Check your connection, then try again.".to_owned()
    })?;
    let status = updates.status();
    match found.map(|update| update.version) {
        Some(version) => {
            if status.ready.as_deref() != Some(version.as_str()) && status.downloading.map(|(v, _)| v).as_deref() != Some(version.as_str()) {
                updates.wake.notify_one();
            }
            Ok(Some(version))
        }
        // The manifest has nothing newer than this version, though one may already be here from earlier.
        None => Ok(status.ready),
    }
}

/// Install the release that is ready and restart into it. `version` is the one the window offered.
pub fn restart(app: &AppHandle, version: &str) -> Result<(), String> {
    let updates = app.state::<ReleaseUpdates>();
    let (update, file) = {
        let mut inner = updates.inner.lock().unwrap();
        let offered = inner.ready.clone().filter(|(update, _)| update.version == version && !inner.installing);
        match offered {
            Some(ready) => {
                inner.installing = true;
                ready
            }
            None => {
                log::warn!("restart to install {version} refused: it is no longer the release that's ready");
                return Err("This update is no longer ready. Scarlet will check again.".into());
            }
        }
    };
    log::info!("restarting to install {version}");
    if cfg!(windows) {
        // The installer replaces the engine too, so it runs once the exit has stopped the host and engine. The exit
        // ends in `install_on_quit`, which starts it and reopens Scarlet when it's done.
        updates.inner.lock().unwrap().relaunch = true;
        app.exit(0);
        return Ok(());
    }
    let installed = install(update, &file);
    if let Err(error) = installed {
        log::error!("release update: installing {version} failed: {error}");
        updates.inner.lock().unwrap().installing = false;
        return Err("Couldn’t install the update. Try again, or quit Scarlet to install it.".into());
    }
    // The exit stops the host and engine, then the new version opens in this one's place.
    app.request_restart();
    Ok(())
}

/// Quitting installs a release that is ready, and leaves Scarlet closed unless the editor chose Restart to update.
/// Called on exit, once the host and engine have stopped.
pub fn install_on_quit(app: &AppHandle) {
    let Some(updates) = app.try_state::<ReleaseUpdates>() else { return };
    let (update, file, relaunch) = {
        let mut inner = updates.inner.lock().unwrap();
        let relaunch = inner.relaunch;
        // On a Mac, Restart to update installed it already.
        if inner.installing && !relaunch {
            return;
        }
        let Some((update, file)) = inner.ready.clone() else { return };
        inner.installing = true;
        (update, file, relaunch)
    };
    let version = update.version.clone();
    // On Windows a successful install ends the app here, and the installer reopens it when the editor asked to restart.
    let installed = install(update.restart_after_install(relaunch), &file);
    match installed {
        Ok(()) => log::info!("release update: installed {version} on quit"),
        Err(error) => {
            log::error!("release update: installing {version} on quit failed: {error}");
            if relaunch {
                // The editor asked to come back: they come back to the version they had.
                tauri::process::restart(&app.env());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_download_only_against_the_size_the_server_gave() {
        assert_eq!(share(0, Some(200)), 0.0);
        assert_eq!(share(50, Some(200)), 0.25);
        assert_eq!(share(250, Some(200)), 1.0);
        assert_eq!(share(50, None), 0.0);
        assert_eq!(share(50, Some(0)), 0.0);
    }

    #[test]
    fn a_mac_copy_that_macos_moved_or_mounted_cannot_replace_itself() {
        let translocated = Path::new("/private/var/folders/x/AppTranslocation/ABC/d/Scarlet.app/Contents/MacOS/scarlet-desktop");
        let mounted = Path::new("/Volumes/Scarlet/Scarlet.app/Contents/MacOS/scarlet-desktop");
        let installed = Path::new("/Applications/Scarlet.app/Contents/MacOS/scarlet-desktop");
        assert_eq!(cannot_update_in_place(translocated).is_some(), cfg!(target_os = "macos"));
        assert_eq!(cannot_update_in_place(mounted).is_some(), cfg!(target_os = "macos"));
        assert!(cannot_update_in_place(installed).is_none());
        assert!(cannot_update_in_place(Path::new(r"C:\Users\me\AppData\Local\Scarlet\scarlet-desktop.exe")).is_none());
    }
}
