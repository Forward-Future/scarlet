//! Tauri commands exposed to the web UI (apps/web/src/lib/desktop.ts).

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

use crate::engine::EngineStatus;
use crate::host::login::LoginStatus;
use crate::host::HostStatus;
use crate::AppState;

#[tauri::command]
pub async fn engine_status(state: State<'_, AppState>) -> Result<EngineStatus, String> {
    Ok(state.engine.status())
}

#[tauri::command]
pub async fn host_status(state: State<'_, AppState>) -> Result<HostStatus, String> {
    Ok(state.host.status().await)
}

#[tauri::command]
pub async fn host_refresh_agents(state: State<'_, AppState>) -> Result<HostStatus, String> {
    Ok(state.host.refresh_agents().await)
}

#[tauri::command]
pub async fn agent_install(state: State<'_, AppState>, agent: String) -> Result<crate::host::install::InstallResult, String> {
    let result = crate::host::install::install(&agent, &state.paths.home).await?;
    if matches!(result, crate::host::install::InstallResult::Installed) {
        state.host.refresh_agents().await;
    }
    Ok(result)
}

/// One-click subscription sign-in for an agent CLI ("claude" or "codex"). The CLI
/// opens the browser; progress arrives on `agent-login://status`.
#[tauri::command]
pub async fn agent_login_start(state: State<'_, AppState>, agent: String) -> Result<LoginStatus, String> {
    state.login.start(&agent).await.map_err(|e| format!("{e:#}"))
}

/// Paste the code from the browser when the automatic hand-off didn't complete (Claude).
#[tauri::command]
pub async fn agent_login_code(state: State<'_, AppState>, agent: String, code: String) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err("empty code".into());
    }
    state.login.submit_code(&agent, &code).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_login_cancel(state: State<'_, AppState>, agent: String) -> Result<(), String> {
    state.login.cancel(&agent).await;
    Ok(())
}

#[tauri::command]
pub fn agent_login_status(state: State<'_, AppState>, agent: String) -> Option<LoginStatus> {
    state.login.status(&agent)
}

/// Open an https link in the system browser (sign-in page fallback).
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_https(&url) {
        return Err("only https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Open Scarlet's data folder or its log folder in Finder / Explorer (Settings, and the page for a Scarlet that can't start).
#[tauri::command]
pub async fn open_path(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    if !is_own_folder(&path, &state.paths) {
        return Err("only Scarlet's data and log folders can be opened".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

fn is_https(url: &str) -> bool {
    url.starts_with("https://")
}

/// The window opens two folders and nothing else: the data folder and the log folder, by the names Scarlet gave it.
/// Whatever else it sends is refused: the system would open a file in its app, run an app or a script, or follow a link.
fn is_own_folder(path: &str, paths: &crate::config::Paths) -> bool {
    [&paths.data_dir, &paths.log_dir].iter().any(|folder| folder.to_string_lossy() == path)
}

/// The address to download, when it is a file of the engine at `base` and nothing else.
fn engine_file(base: &str, url: &str) -> Result<url::Url, String> {
    let engine = url::Url::parse(base).map_err(|_| "Invalid engine address")?;
    let source = url::Url::parse(url).map_err(|_| "Invalid export address")?;
    if source.origin() != engine.origin() || !source.username().is_empty() || source.password().is_some() || !source.path().starts_with("/api/") {
        return Err("Only files from the Scarlet engine can be saved".into());
    }
    Ok(source)
}

/// The renderer receives a ticket for a user-selected file, never permission to write an arbitrary path.
/// A ticket an export has taken is also saved to disk, so the export can finish after a restart.
#[derive(Default)]
pub struct ExportDestinations {
    file: std::sync::OnceLock<std::path::PathBuf>,
    paths: std::sync::Mutex<std::collections::HashMap<u64, ExportDestination>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ExportDestination {
    path: std::path::PathBuf,
    /// The partial file a save in progress is writing beside the destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temp: Option<std::path::PathBuf>,
    /// The Scarlet writing that file: its process id, then its program and start time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saver: Option<(u32, String)>,
    #[serde(skip)]
    kept: bool,
}

impl ExportDestinations {
    /// Restore the destinations of exports that were in progress at the last quit, and remove what a killed save left behind.
    pub fn load(&self, file: std::path::PathBuf) {
        let saved = match std::fs::read(&file) {
            Ok(raw) => serde_json::from_slice::<std::collections::HashMap<u64, ExportDestination>>(&raw).unwrap_or_else(|e| {
                log::warn!("export destinations in {} unreadable ({e}); an export under way at the last quit is forgotten", file.display());
                Default::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(e) => {
                log::warn!("export destinations in {} could not be read ({e})", file.display());
                Default::default()
            }
        };
        let _ = self.file.set(file);
        let Ok(mut paths) = self.paths.lock() else { return };
        for (ticket, mut destination) in saved {
            // The installed app and a development preview share this record. A save whose Scarlet is still open is
            // that Scarlet's work: its partial file stays, and so does the record of who is writing it.
            let saving = destination.saver.as_ref().is_some_and(|(pid, scarlet)| crate::host::spawn::still_runs(*pid, scarlet));
            if !saving {
                destination.saver = None;
                if let Some(temp) = destination.temp.take() {
                    // Only ever a temporary file this app created next to the chosen destination.
                    let ours = temp.parent() == destination.path.parent()
                        && temp.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".tmp"));
                    if ours && std::fs::remove_file(&temp).is_ok() { log::info!("removed a partial export at {}", temp.display()); }
                }
            }
            destination.kept = true;
            paths.insert(ticket, destination);
        }
        Self::persist(self.file.get(), &paths);
    }

    fn persist(file: Option<&std::path::PathBuf>, paths: &std::collections::HashMap<u64, ExportDestination>) {
        let Some(file) = file else { return };
        let kept: std::collections::HashMap<&u64, &ExportDestination> = paths.iter().filter(|(_, d)| d.kept).collect();
        let written = (|| -> Result<(), String> {
            let dir = file.parent().ok_or("no folder")?;
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut temp, &kept).map_err(|e| e.to_string())?;
            temp.persist(file).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(e) = written { log::warn!("could not record export destinations: {e}"); }
    }

    fn change<T>(&self, change: impl FnOnce(&mut std::collections::HashMap<u64, ExportDestination>) -> (T, bool)) -> Result<T, String> {
        let mut paths = self.paths.lock().map_err(|_| "Export unavailable")?;
        let (value, durable) = change(&mut paths);
        if durable { Self::persist(self.file.get(), &paths); }
        Ok(value)
    }
}

pub(crate) async fn pick_destination(app: &AppHandle, title: &str, file_name: &str) -> Result<Option<std::path::PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    let mut picker = app.dialog().file().set_title(title).set_file_name(file_name);
    if file_name.ends_with(".mp4") {
        picker = picker.add_filter("MP4 video", &["mp4"]);
    } else if file_name.ends_with(".zip") {
        picker = picker.add_filter("Zip archive", &["zip"]);
    } else if file_name.ends_with(".otio") {
        picker = picker.add_filter("OpenTimelineIO timeline", &["otio"]);
    }
    picker.save_file(move |p| { let _ = tx.send(p); });
    rx.await.map_err(|e| e.to_string())?.map(|picked| picked.into_path().map_err(|e| e.to_string())).transpose()
}

#[derive(serde::Serialize)]
pub struct ExportChoice { ticket: u64, path: String }

#[tauri::command]
pub async fn choose_video_export(app: AppHandle, destinations: State<'_, ExportDestinations>, file_name: String) -> Result<Option<ExportChoice>, String> {
    use std::hash::{BuildHasher, Hasher};
    let Some(path) = pick_destination(&app, "Export", &file_name).await? else { return Ok(None) };
    // Random, so a ticket recorded before a restart never names a later choice. 53 bits survive JavaScript.
    let ticket = std::collections::hash_map::RandomState::new().build_hasher().finish() >> 11;
    let shown = path.to_string_lossy().into_owned();
    destinations.change(|paths| { paths.insert(ticket, ExportDestination { path, temp: None, saver: None, kept: false }); ((), false) })?;
    Ok(Some(ExportChoice { ticket, path: shown }))
}

/// An export has taken this destination. Remember it until the export is saved or discarded.
#[tauri::command]
pub fn keep_video_export(destinations: State<'_, ExportDestinations>, ticket: u64) -> Result<(), String> {
    destinations.change(|paths| match paths.get_mut(&ticket) {
        Some(destination) => { destination.kept = true; (Ok(()), true) }
        None => (Err("Export destination expired".to_string()), false),
    })?
}

#[tauri::command]
pub fn discard_video_export(destinations: State<'_, ExportDestinations>, ticket: u64) -> Result<(), String> {
    destinations.change(|paths| { let kept = paths.remove(&ticket).is_some_and(|d| d.kept); ((), kept) })
}

async fn save_engine_file(app: &AppHandle, state: &AppState, url: &str, path: &std::path::Path, started: impl FnOnce(&std::path::Path)) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let parent = path.parent().ok_or("Unsupported save destination")?;
    // The error names the folder it could not write in. The editor chose it, so only the kind of failure is kept.
    let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("Could not write to the chosen folder ({})", e.kind()))?;
    let (file, temp_path) = temp.into_parts();
    started(&temp_path);
    let mut file = tokio::io::BufWriter::with_capacity(1024 * 1024, tokio::fs::File::from_std(file));

    // The isolated native demo has no engine. Its only downloadable assets are the sample video and OTIO JSON.
    let mut demo_content = false;
    if cfg!(debug_assertions) && app.config().identifier == "com.forwardfuture.scarlet.demo" {
        if url.split('#').next() == Some("/sample.mp4") {
            file.write_all(include_bytes!("../../../web/public/sample.mp4")).await.map_err(|e| e.to_string())?;
            demo_content = true;
        } else if let Some(encoded) = url.strip_prefix("data:application/json;charset=utf-8,") {
            let raw = format!("json={}", encoded.replace('+', "%2B"));
            let json = url::form_urlencoded::parse(raw.as_bytes()).next().ok_or("Empty timeline")?.1;
            serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "Invalid timeline")?;
            file.write_all(json.as_bytes()).await.map_err(|e| e.to_string())?;
            demo_content = true;
        }
    }
    if !demo_content {
        let base = state.engine.status().url.ok_or("Not connected to the engine")?;
        let source = engine_file(&base, url)?;
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        let mut res = client.get(source).header("x-scarlet-download", "1").send().await.map_err(|e| e.without_url().to_string())?;
        if !res.status().is_success() { return Err(format!("The engine could not deliver the file ({})", res.status())); }
        while let Some(chunk) = res.chunk().await.map_err(|e| e.without_url().to_string())? {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    temp_path.persist(path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn finish_video_export(app: AppHandle, state: State<'_, AppState>, destinations: State<'_, ExportDestinations>, ticket: u64, url: String) -> Result<String, String> {
    let path = destinations.change(|paths| (paths.get(&ticket).map(|d| d.path.clone()), false))?.ok_or("Export destination expired")?;
    // Recorded with the partial file, so another Scarlet that opens on this library leaves it alone while this one
    // is still open. Read off the async threads: on Windows it starts PowerShell.
    let saver = tauri::async_runtime::spawn_blocking(crate::host::spawn::this_scarlet).await.ok();
    // A quit during the save leaves the destination on record, with the partial file to remove at the next launch.
    let saved = save_engine_file(&app, &state, &url, &path, |temp| {
        let _ = destinations.change(|paths| match paths.get_mut(&ticket) {
            Some(destination) if destination.kept => { (destination.temp, destination.saver) = (Some(temp.to_path_buf()), saver); ((), true) }
            _ => ((), false),
        });
    }).await;
    // Never where it went: the editor typed the file's name.
    match &saved {
        Ok(_) => log::info!("export saved"),
        Err(e) => log::warn!("export could not be saved: {}", e.replace(&*path.to_string_lossy(), "…")),
    }
    // A save cut short by quitting is retried at the next launch. Otherwise the renderer discards the ticket.
    let retry = saved.is_err();
    destinations.change(|paths| {
        if retry && paths.get(&ticket).is_some_and(|d| d.kept) { return ((), false) }
        let kept = paths.remove(&ticket).is_some_and(|d| d.kept);
        ((), kept)
    })?;
    saved
}

/// Show a saved file in Finder / Explorer.
#[tauri::command]
pub async fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// The filters Add files offers. A drop takes any file, and the engine reads whatever ffmpeg can. The Mac's panel
/// folds every filter into one list of allowed types, where "*" is a type no file has, so any filter there greys out
/// footage a drop takes (.MTS, .MXF, .aiff, …). On a Mac the picker offers every file, as a drop does. Elsewhere Media,
/// the filter it opens on, names the camera, broadcast, audio and still formats the engine reads, and All files the rest.
fn media_filters(mac: bool) -> &'static [(&'static str, &'static [&'static str])] {
    if mac {
        return &[];
    }
    &[
        ("Media", &[
            "mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "ts", "mxf", "3gp", "3g2", "wmv", "asf", "mpg", "mpeg", "flv", "ogv",
            "wav", "mp3", "aac", "m4a", "flac", "aif", "aiff", "caf", "ogg", "opus", "wma", "ac3", "eac3", "amr",
            "png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "avif", "bmp", "tif", "tiff",
        ]),
        ("All files", &["*"]),
    ]
}

/// Native multi-select for media import. Returns absolute paths; the UI then
/// uploads them (or, in solo mode, asks the engine to import by path).
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<FilePath>>>();
    let mut picker = app.dialog().file().set_title("Add files");
    for (name, extensions) in media_filters(cfg!(target_os = "macos")) {
        picker = picker.add_filter(*name, extensions);
    }
    picker.pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let paths = rx.await.map_err(|e| e.to_string())?.unwrap_or_default();
    Ok(paths
        .into_iter()
        .filter_map(|p| match p {
            FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
            FilePath::Url(u) => u.to_file_path().ok().map(|p| p.to_string_lossy().to_string()),
        })
        .collect())
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum UiLogMessage {
    Line(String),
    Batch(Vec<String>),
}

/// A renderer flush crosses the native bridge once. Keep each line a separate log record.
#[tauri::command]
pub fn desktop_log(level: Option<String>, message: UiLogMessage) {
    let write = |message: &str| match level.as_deref() {
        Some("error") => log::error!("[ui] {message}"),
        Some("warn") => log::warn!("[ui] {message}"),
        Some("debug") => log::debug!("[ui] {message}"),
        _ => log::info!("[ui] {message}"),
    };
    match message {
        UiLogMessage::Line(line) => write(&line),
        UiLogMessage::Batch(lines) => lines.iter().for_each(|line| write(line)),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub local_updates: bool,
    pub custom_openai_models: Vec<String>,
    pub custom_claude_models: Vec<String>,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub config_file: String,
    pub data_dir: String,
    pub work_dir: String,
    pub log_dir: String,
}

#[tauri::command]
pub fn desktop_info(app: AppHandle, state: State<'_, AppState>) -> DesktopInfo {
    DesktopInfo {
        local_updates: crate::updates::socket_path(&app).is_some(),
        custom_openai_models: state.paths.custom_openai_models(),
        custom_claude_models: state.paths.custom_claude_models(),
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        config_file: state.paths.config_file.to_string_lossy().to_string(),
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        work_dir: state.paths.work_dir.to_string_lossy().to_string(),
        log_dir: state.paths.log_dir.to_string_lossy().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_an_exports_destination_across_a_restart_and_removes_a_killed_saves_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let chosen = dir.path().join("Cut.mp4");
        let partial = dir.path().join(".tmpAbC123");
        let unrelated = dir.path().join("notes.txt");
        std::fs::write(&partial, "partial").unwrap();
        std::fs::write(&unrelated, "keep").unwrap();

        let first = ExportDestinations::default();
        first.load(record.clone());
        first.change(|paths| {
            paths.insert(1, ExportDestination { path: chosen.clone(), temp: Some(partial.clone()), saver: None, kept: true });
            paths.insert(2, ExportDestination { path: dir.path().join("Other.mp4"), temp: Some(unrelated.clone()), saver: None, kept: true });
            paths.insert(3, ExportDestination { path: dir.path().join("Unused.mp4"), temp: None, saver: None, kept: false });
            ((), true)
        }).unwrap();

        let next = ExportDestinations::default();
        next.load(record.clone());
        let paths = next.paths.lock().unwrap();
        assert_eq!(paths.get(&1).map(|d| d.path.clone()), Some(chosen));
        assert!(paths.get(&1).unwrap().temp.is_none());
        assert!(paths.contains_key(&2));
        assert!(!paths.contains_key(&3), "a destination no export took is forgotten");
        assert!(!partial.exists());
        assert!(unrelated.exists(), "only this app's temporary files are removed");
    }

    #[test]
    fn saves_only_files_of_the_running_engine() {
        let engine = "http://127.0.0.1:51234";
        let ok = engine_file(engine, "http://127.0.0.1:51234/api/projects/prj_1/export/final.mp4?token=t").unwrap();
        assert_eq!(ok.path(), "/api/projects/prj_1/export/final.mp4");
        // Another port, host or scheme is another origin, however alike it looks.
        for other in [
            "http://127.0.0.1:51235/api/x",
            "http://localhost:51234/api/x",
            "https://127.0.0.1:51234/api/x",
            "http://127.0.0.1.example.com:51234/api/x",
            "http://127.0.0.1:51234@example.com/api/x",
            "file:///api/x",
        ] {
            assert_eq!(engine_file(engine, other).unwrap_err(), "Only files from the Scarlet engine can be saved", "{other}");
        }
        // The engine's own address with credentials in it, or a path outside its API. A dot segment is resolved
        // before the check, so it can't climb out of /api/.
        for inside in ["http://user@127.0.0.1:51234/api/x", "http://user:pw@127.0.0.1:51234/api/x", "http://127.0.0.1:51234/", "http://127.0.0.1:51234/apix", "http://127.0.0.1:51234/api/../secret"] {
            assert_eq!(engine_file(engine, inside).unwrap_err(), "Only files from the Scarlet engine can be saved", "{inside}");
        }
        assert_eq!(engine_file(engine, "/api/x").unwrap_err(), "Invalid export address");
        assert_eq!(engine_file("not an address", "http://127.0.0.1:51234/api/x").unwrap_err(), "Invalid engine address");
    }

    #[test]
    fn opens_only_https_links() {
        assert!(is_https("https://claude.ai/oauth/authorize?code=true"));
        for other in ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", " https://example.com", "HTTPS://example.com", "", "scarlet://open", "https:/example.com"] {
            assert!(!is_https(other), "{other:?}");
        }
    }

    #[test]
    fn opens_only_scarlets_own_data_and_log_folders() {
        let root = std::path::Path::new("/Users/me/Library/Application Support/com.forwardfuture.scarlet");
        let paths = crate::config::Paths {
            config_file: root.join("desktop.json"),
            data_dir: root.join("data"),
            work_dir: root.join("work"),
            log_dir: "/Users/me/Library/Logs/com.forwardfuture.scarlet".into(),
            resource_dir: None,
            home: "/Users/me".into(),
        };
        let named = |path: &std::path::Path| path.to_string_lossy().into_owned();
        // The two folders the window opens, by the names Scarlet gave it: Settings shows both, and the page for a
        // Scarlet that can't start offers the logs.
        for folder in [&paths.data_dir, &paths.log_dir] {
            assert!(is_own_folder(&named(folder), &paths), "{}", folder.display());
        }
        // Nothing else: a file inside one, a folder above or beside them, another way to spell one, an app, a
        // script, a link.
        let data = named(&paths.data_dir);
        for other in [
            format!("{data}/scarlet.db"), named(root), named(&paths.work_dir), named(&paths.config_file), named(&paths.home),
            format!("{data}/"), format!("{data}/../data"), format!(" {data}"),
            "/Applications/Calculator.app".into(), "/Users/me/Downloads/run.command".into(),
            format!("file://{data}"), "https://example.com".into(), String::new(), " ".into(),
        ] {
            assert!(!is_own_folder(&other, &paths), "{other:?}");
        }
    }

    #[test]
    fn starts_with_no_exports_when_its_record_is_missing_or_damaged() {
        crate::util::test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        // First launch: no record, nothing to say.
        let missing = dir.path().join("first-launch").join("export-destinations.json");
        let fresh = ExportDestinations::default();
        fresh.load(missing.clone());
        assert!(fresh.paths.lock().unwrap().is_empty());
        assert!(crate::util::test_log::find(&["export destinations in", "first-launch"]).is_none());
        // The record is written from then on, in a folder made for it.
        assert_eq!(std::fs::read_to_string(&missing).unwrap(), "{}");

        // Cut off mid-write by a crash: the exports it listed are forgotten, and the log says so.
        let damaged = dir.path().join("damaged-export-destinations.json");
        std::fs::write(&damaged, "{\"1\":{\"path\":\"/Users/me/Cut.mp").unwrap();
        let next = ExportDestinations::default();
        next.load(damaged.clone());
        assert!(next.paths.lock().unwrap().is_empty());
        let (level, _) = crate::util::test_log::find(&["export destinations in", "damaged-export-destinations.json", "unreadable"]).expect("the damaged record was not logged");
        assert_eq!(level, log::Level::Warn);
        // It is usable again at once: a destination an export takes is recorded over the damage.
        next.change(|paths| {
            paths.insert(7, ExportDestination { path: dir.path().join("Cut.mp4"), temp: None, saver: None, kept: true });
            ((), true)
        }).unwrap();
        let again = ExportDestinations::default();
        again.load(damaged);
        assert!(again.paths.lock().unwrap().contains_key(&7));
    }

    #[test]
    fn never_removes_a_recorded_partial_file_that_is_not_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        // A record that was tampered with names a file in another folder, and one beside the destination that
        // this app would never have named.
        let other_folder = elsewhere.path().join(".tmpAbC123");
        let other_name = dir.path().join("Cut-final.mp4");
        std::fs::write(&other_folder, "theirs").unwrap();
        std::fs::write(&other_name, "theirs").unwrap();
        let saved = serde_json::json!({
            "1": { "path": dir.path().join("Cut.mp4"), "temp": other_folder },
            "2": { "path": dir.path().join("Cut.mp4"), "temp": other_name },
        });
        std::fs::write(&record, saved.to_string()).unwrap();
        let loaded = ExportDestinations::default();
        loaded.load(record);
        assert!(other_folder.exists() && other_name.exists());
        assert_eq!(loaded.paths.lock().unwrap().len(), 2);
    }

    #[test]
    fn leaves_the_partial_file_of_a_save_another_open_scarlet_has_under_way() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let (saving, killed) = (dir.path().join(".tmpSaving"), dir.path().join(".tmpKilled"));
        std::fs::write(&saving, "partial").unwrap();
        std::fs::write(&killed, "partial").unwrap();
        // The installed app and a development preview share this record. One save is under way in a Scarlet that
        // is still open, which this process stands in for. The other was cut short when its Scarlet was killed,
        // and its process id has since gone to a process started at another time.
        let (pid, open) = crate::host::spawn::this_scarlet();
        let gone = format!("{}\nMon Jan  1 00:00:00 2001", open.lines().next().unwrap());
        let saved = serde_json::json!({
            "1": { "path": dir.path().join("Cut.mp4"), "temp": saving, "saver": [pid, open] },
            "2": { "path": dir.path().join("Other.mp4"), "temp": killed, "saver": [pid, gone] },
        });
        std::fs::write(&record, saved.to_string()).unwrap();

        let second = ExportDestinations::default();
        second.load(record.clone());
        assert!(saving.exists(), "the partial file of a save still under way was removed");
        assert!(!killed.exists());
        // Both destinations are taken up: the window lets go of an export whose destination has expired.
        assert_eq!(second.paths.lock().unwrap().len(), 2);
        // The record still says who is writing the partial file, for the launch after this one.
        let kept: serde_json::Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        assert_eq!((&kept["1"]["temp"], &kept["1"]["saver"]), (&saved["1"]["temp"], &saved["1"]["saver"]));
        assert!(kept["2"].get("temp").is_none() && kept["2"].get("saver").is_none());
    }

    /// Whether a file can be chosen under these filters as the Mac's panel reads them: every filter's extensions merged
    /// into one list of allowed types, compared without case, with "*" one more extension, not any. Given one filter,
    /// it is also whether the Windows panel shows the file under that filter.
    fn panel_takes(filters: &[(&str, &[&str])], name: &str) -> bool {
        let ext = std::path::Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        filters.is_empty() || filters.iter().any(|(_, extensions)| extensions.iter().any(|allowed| allowed.to_lowercase() == ext))
    }

    #[test]
    fn add_files_takes_every_file_a_drop_takes() {
        // Camera and broadcast footage, audio and stills the engine reads, and that a drop on the window takes.
        let footage = ["A001.MTS", "clip.m2ts", "camera.MXF", "phone.3gp", "stream.ts", "old.wmv", "voice.aif", "voice.aiff", "surround.eac3", "photo.heic", "photo.avif", "interview.mp4"];
        for name in footage.iter().chain(&["README"]) {
            assert!(panel_takes(media_filters(true), name), "Add files greys out {name} on a Mac");
        }
        // Elsewhere the panel lists each filter on its own and opens on the first, Media, which takes the same footage.
        // All files is there for the rest.
        let others = media_filters(false);
        for name in footage {
            assert!(panel_takes(&others[..1], name), "Media hides {name}");
        }
        assert!(others.iter().any(|(name, extensions)| *name == "All files" && *extensions == ["*"]));
    }
}
