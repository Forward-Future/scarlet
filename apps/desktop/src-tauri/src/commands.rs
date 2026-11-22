//! Tauri commands exposed to the web UI (apps/web/src/lib/desktop.ts).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

use crate::config::EditorModelSelection;
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
pub async fn host_refresh_quota(state: State<'_, AppState>, force: Option<bool>) -> Result<HostStatus, String> {
    Ok(state.host.refresh_quota(force.unwrap_or(false)).await)
}

#[tauri::command]
pub async fn agent_install(state: State<'_, AppState>, agent: String) -> Result<crate::host::install::InstallResult, String> {
    let result = crate::host::install::install(&agent, &state.paths.home).await?;
    if matches!(result, crate::host::install::InstallResult::Installed) {
        state.host.refresh_agents().await;
    }
    Ok(result)
}

/// One-click subscription sign-in for an agent CLI ("claude", "codex", or "gemini").
/// Progress arrives on `agent-login://status`.
#[tauri::command]
pub async fn agent_login_start(state: State<'_, AppState>, agent: String) -> Result<LoginStatus, String> {
    state.login.start(&agent).await.map_err(|e| format!("{e:#}"))
}

/// Paste the authorization code from the browser (Claude's manual fallback or Gemini's OAuth code).
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
    file: std::sync::OnceLock<PathBuf>,
    paths: std::sync::Mutex<HashMap<u64, ExportDestination>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ExportDestination {
    path: PathBuf,
    /// The partial file a save in progress is writing beside the destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temp: Option<PathBuf>,
    /// The Scarlet writing that file: its process id, then its program and start time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saver: Option<(u32, String)>,
    #[serde(skip)]
    kept: bool,
}

const EXPORT_ALREADY_SAVING: &str = "Export is already saving in another Scarlet window.";

/// The Scarlet writing an export's file: its process id, then its program and start time.
type Saver = (u32, String);

/// Whether that Scarlet is still open. Asking can start `ps`, or PowerShell on Windows for about a second, so it is
/// never asked while the destinations are locked.
fn still_saving(saver: &Saver) -> bool {
    crate::host::spawn::still_runs(saver.0, &saver.1)
}

/// What a save's claim on its destination found.
enum Claim {
    Taken(bool),
    /// Another Scarlet recorded a save. Whether it is still open is asked outside the locks, then the claim is tried again.
    Check(Saver),
}

impl ExportDestination {
    fn clear_partial(&mut self) {
        self.saver = None;
        if let Some(temp) = self.temp.take() {
            // Only ever a temporary file this app created next to the chosen destination.
            let ours = temp.parent() == self.path.parent()
                && temp.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".tmp"));
            if ours {
                match fs::remove_file(&temp) {
                    Ok(()) => log::info!("[export] partial-cleanup outcome=done"),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                    Err(error) => log::warn!("[export] partial-cleanup outcome=failed code={}", error.raw_os_error().unwrap_or(0)),
                }
            }
        }
    }
}

impl ExportDestinations {
    /// Restore the destinations of exports that were in progress at the last quit, and remove what a killed save left behind.
    pub fn load(&self, file: PathBuf) {
        self.load_with(file, still_saving)
    }

    fn load_with(&self, file: PathBuf, still_saving: impl Fn(&Saver) -> bool) {
        let stored = self.file.get_or_init(|| file);
        let loaded = (|| -> io::Result<()> {
            // Which recorded saves have ended, asked before anything is locked.
            let recorded = { let _lock = Self::lock(stored)?; Self::read(stored).unwrap_or_default() };
            let ended: Vec<(u64, Saver)> = recorded.into_iter()
                .filter_map(|(ticket, d)| d.saver.filter(|saver| !still_saving(saver)).map(|saver| (ticket, saver)))
                .collect();
            let mut paths = self.paths.lock().map_err(|_| io::Error::other("export destinations unavailable"))?;
            let _lock = Self::lock(stored)?;
            let mut saved = Self::read_or_reset(stored)?;
            for (ticket, destination) in saved.iter_mut() {
                // A save recorded since was claimed by a Scarlet that is open, and is left to it.
                let over = destination.saver.as_ref().is_none_or(|saver| ended.iter().any(|(t, s)| t == ticket && s == saver));
                if over {
                    destination.clear_partial();
                }
            }
            Self::persist(stored, &saved)?;
            *paths = saved;
            Ok(())
        })();
        if let Err(e) = loaded {
            log::warn!("export destinations in {} could not be read or recovered ({e})", stored.display());
        }
    }

    /// Claim the destination for this save. Blocks: run it off the async runtime.
    fn start_save(&self, ticket: u64, temp: &Path, saver: Saver) -> Result<bool, String> {
        self.start_save_with(ticket, temp, saver, still_saving)
    }

    fn start_save_with(&self, ticket: u64, temp: &Path, saver: Saver, still_saving: impl Fn(&Saver) -> bool) -> Result<bool, String> {
        // The recorded saver last asked about, and whether it was still open.
        let mut checked: Option<(Saver, bool)> = None;
        // Each round asks about a save that started since the last one. A record that keeps changing is a save under way.
        for _ in 0..4 {
            let claim = self.change(|paths| match paths.get_mut(&ticket) {
                None => (Err("Export destination expired".to_owned()), false),
                Some(destination) if !destination.kept => (Ok(Claim::Taken(false)), false),
                Some(destination) => {
                    if let Some(recorded) = &destination.saver {
                        match &checked {
                            Some((asked, true)) if asked == recorded => return (Err(EXPORT_ALREADY_SAVING.to_owned()), false),
                            Some((asked, false)) if asked == recorded => {}
                            _ => return (Ok(Claim::Check(recorded.clone())), false),
                        }
                    }
                    destination.clear_partial();
                    (destination.temp, destination.saver) = (Some(temp.to_path_buf()), Some(saver.clone()));
                    (Ok(Claim::Taken(true)), true)
                }
            })??;
            match claim {
                Claim::Taken(kept) => return Ok(kept),
                Claim::Check(recorded) => {
                    let open = still_saving(&recorded);
                    checked = Some((recorded, open));
                }
            }
        }
        Err(EXPORT_ALREADY_SAVING.to_owned())
    }

    fn finish_save(&self, ticket: u64, temp: &Path, kept: bool, saved: bool) -> Result<(), String> {
        self.change(|paths| {
            let Some(destination) = paths.get_mut(&ticket) else { return ((), false) };
            if kept && destination.temp.as_deref() != Some(temp) { return ((), false) }
            if kept && !saved {
                (destination.temp, destination.saver) = (None, None);
                return ((), true);
            }
            paths.remove(&ticket);
            ((), kept)
        })
    }

    // Lock a separate file that stays put while the destinations record is atomically replaced.
    fn lock(file: &Path) -> io::Result<File> {
        let dir = file.parent().ok_or_else(|| io::Error::other("no folder"))?;
        fs::create_dir_all(dir)?;
        let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(file.with_extension("lock"))?;
        lock.lock()?;
        Ok(lock)
    }

    /// The record, or none when it can't be parsed: a crash cut it off mid-write, or it was damaged. The exports it
    /// listed are forgotten and the log says so, and the record is usable again at once.
    fn read_or_reset(file: &Path) -> io::Result<HashMap<u64, ExportDestination>> {
        match Self::read(file) {
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                log::warn!("export destinations in {} unreadable ({e}); the exports it listed are forgotten", file.display());
                Ok(HashMap::new())
            }
            read => read,
        }
    }

    fn read(file: &Path) -> io::Result<HashMap<u64, ExportDestination>> {
        let raw = match fs::read(file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(e),
        };
        let mut saved: HashMap<u64, ExportDestination> = serde_json::from_slice(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        for destination in saved.values_mut() { destination.kept = true; }
        Ok(saved)
    }

    fn persist(file: &Path, paths: &HashMap<u64, ExportDestination>) -> io::Result<()> {
        let kept: HashMap<_, _> = paths.iter().filter(|(_, d)| d.kept).collect();
        let dir = file.parent().ok_or_else(|| io::Error::other("no folder"))?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut temp, &kept)?;
        temp.as_file().sync_all()?;
        temp.persist(file)?;
        Ok(())
    }

    fn change<T>(&self, change: impl FnOnce(&mut HashMap<u64, ExportDestination>) -> (T, bool)) -> Result<T, String> {
        let mut paths = self.paths.lock().map_err(|_| "Export unavailable")?;
        let Some(file) = self.file.get() else { return Ok(change(&mut paths).0) };
        let changed = (|| -> io::Result<T> {
            let _lock = Self::lock(file)?;
            let mut current = Self::read_or_reset(file)?;
            // Only uncommitted picker selections belong exclusively to this instance.
            current.extend(paths.iter().filter(|(_, d)| !d.kept).map(|(ticket, d)| (*ticket, d.clone())));
            let (value, durable) = change(&mut current);
            if durable { Self::persist(file, &current)?; }
            *paths = current;
            Ok(value)
        })();
        changed.map_err(|e| {
            log::warn!("could not access export destinations: {e}");
            "Export destinations could not be saved or read.".to_string()
        })
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
    } else if file_name.ends_with(".srt") {
        picker = picker.add_filter("SubRip captions", &["srt"]);
    } else if file_name.ends_with(".vtt") {
        picker = picker.add_filter("WebVTT captions", &["vtt"]);
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

fn decode_data_url_payload(encoded: &str, empty: &str) -> Result<String, String> {
    let raw = format!("body={}", encoded.replace('+', "%2B"));
    Ok(url::form_urlencoded::parse(raw.as_bytes()).next().ok_or(empty)?.1.into_owned())
}

/// Isolated demo downloads: OTIO JSON and caption text carried as data URLs.
fn demo_data_url_bytes(url: &str) -> Result<Option<Vec<u8>>, String> {
    if let Some(encoded) = url.strip_prefix("data:application/json;charset=utf-8,") {
        let json = decode_data_url_payload(encoded, "Empty timeline")?;
        serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "Invalid timeline")?;
        return Ok(Some(json.into_bytes()));
    }
    for prefix in ["data:text/plain;charset=utf-8,", "data:text/vtt;charset=utf-8,"] {
        if let Some(encoded) = url.strip_prefix(prefix) {
            return Ok(Some(decode_data_url_payload(encoded, "Empty captions")?.into_bytes()));
        }
    }
    Ok(None)
}

struct ExportTransfer {
    request: uuid::Uuid,
    stage: &'static str,
    status: u16,
    bytes: u64,
    render: Option<String>,
}

async fn save_engine_file(app: &AppHandle, state: &AppState, url: &str, path: &Path, temp: tempfile::NamedTempFile, transfer: &mut ExportTransfer) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let (file, temp_path) = temp.into_parts();
    let mut file = tokio::io::BufWriter::with_capacity(1024 * 1024, tokio::fs::File::from_std(file));

    // The isolated native demo has no engine. Its only downloadable assets are the sample video, OTIO JSON, and caption text.
    let mut demo_content = false;
    if crate::is_demo(app) {
        if url.split('#').next() == Some("/sample.mp4") {
            file.write_all(include_bytes!("../../../web/public/sample.mp4")).await.map_err(|e| e.to_string())?;
            demo_content = true;
        } else if let Some(bytes) = demo_data_url_bytes(url)? {
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
            demo_content = true;
        }
    }
    if !demo_content {
        transfer.stage = "connect";
        let base = state.engine.status().url.ok_or("Not connected to the engine")?;
        let source = engine_file(&base, url)?;
        transfer.render = source.path().strip_prefix("/api/renders/").and_then(|path| path.strip_suffix("/file"))
            .filter(|id| id.strip_prefix("rnd_").is_some_and(|value| value.len() == 12 && value.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())))
            .map(str::to_owned);
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        let mut res = client.get(source).header("x-scarlet-download", "1").header("x-scarlet-request-id", transfer.request.to_string())
            .send().await.map_err(|e| e.without_url().to_string())?;
        transfer.stage = "headers";
        transfer.status = res.status().as_u16();
        if !res.status().is_success() { return Err(format!("The engine could not deliver the file ({})", res.status())); }
        loop {
            transfer.stage = "read";
            let Some(chunk) = res.chunk().await.map_err(|e| e.without_url().to_string())? else { break };
            transfer.bytes += chunk.len() as u64;
            transfer.stage = "write";
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
    }
    transfer.stage = "sync";
    file.flush().await.map_err(|e| e.to_string())?;
    // On the disk before it takes the chosen name: after a power cut the file there is whole or isn't there, and an
    // export that isn't there is still owed and saved again at the next launch.
    file.get_ref().sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    transfer.stage = "publish";
    temp_path.persist(path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn finish_video_export(app: AppHandle, state: State<'_, AppState>, destinations: State<'_, ExportDestinations>, ticket: u64, url: String) -> Result<String, String> {
    let started = std::time::Instant::now();
    let mut transfer = ExportTransfer { request: uuid::Uuid::new_v4(), stage: "destination", status: 0, bytes: 0, render: None };
    let mut chosen: Option<PathBuf> = None;
    let saved: Result<String, String> = async {
        let path = destinations.change(|paths| (paths.get(&ticket).map(|d| d.path.clone()), false))?.ok_or("Export destination expired")?;
        chosen = Some(path.clone());
        let parent = path.parent().ok_or("Unsupported save destination")?;
        let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("Could not write to the chosen folder ({})", e.kind()))?;
        let partial = temp.path().to_path_buf();
        // Process inspection can start PowerShell on Windows. Claim the destination off the runtime before writing.
        transfer.stage = "claim";
        let (handle, claimed) = (app.clone(), partial.clone());
        let kept = tauri::async_runtime::spawn_blocking(move || {
            handle.state::<ExportDestinations>().start_save(ticket, &claimed, crate::host::spawn::this_scarlet())
        }).await.map_err(|e| e.to_string())??;
        log::info!("[export] save-started request={} stage=claim", transfer.request);
        let saved = save_engine_file(&app, &state, &url, &path, temp, &mut transfer).await;
        // A failed save keeps the ticket available for retry. A ledger error is separate from the file outcome.
        if destinations.finish_save(ticket, &partial, kept, saved.is_ok()).is_err() {
            log::warn!("[export] ledger-failed request={} stage=finish", transfer.request);
        }
        saved
    }.await;
    let (level, outcome) = if saved.is_ok() { (log::Level::Info, "done") } else { (log::Level::Warn, "failed") };
    log::log!(level, "[export] save-finished request={} outcome={outcome} stage={} status={} bytes={} elapsedMs={} render={}",
        transfer.request, transfer.stage, transfer.status, transfer.bytes, started.elapsed().as_millis(), transfer.render.as_deref().unwrap_or("none"));
    // Why it failed stays in the local log, never where it went: the editor typed the file's name.
    if let Err(error) = &saved {
        let reason = match &chosen { Some(path) => {
                let named = error.replace(&*path.to_string_lossy(), "…");
                match path.parent() { Some(folder) if !folder.as_os_str().is_empty() => named.replace(&*folder.to_string_lossy(), "…"), _ => named }
            } None => error.clone() };
        log::warn!("[export] save-failed request={} reason={:?}", transfer.request, reason);
    }
    saved
}

/// One file of the folder an editor takes to another app: its text, or a copy of a file in Scarlet's library.
#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum HandoffFile {
    Text { path: String, text: String },
    Copy { path: String, source: String },
}

/// A path inside the folder: relative, with no step out of it.
fn inside_folder(path: &str) -> Result<std::path::PathBuf, String> {
    let mut out = std::path::PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return Err("The export named a file outside its folder".into());
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() { return Err("The export named a file outside its folder".into()) }
    Ok(out)
}

/// Write the hand-off folder at `dest`: built beside it under a hidden name and renamed into place once whole, so the
/// chosen name never holds half a folder. Copies come only from Scarlet's library. On an APFS volume a copy is a clone.
pub(crate) fn write_handoff_folder(dest: &std::path::Path, files: &[HandoffFile], library: &std::path::Path, demo: bool) -> Result<(), String> {
    if dest.symlink_metadata().is_ok() {
        return Err("Something with that name is already there. Export again and choose another name.".into());
    }
    let parent = dest.parent().ok_or("Unsupported save destination")?;
    let library = library.canonicalize().map_err(|e| format!("Scarlet's library is unavailable ({})", e.kind()))?;
    let stem = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let staging = tempfile::Builder::new().prefix(&format!(".{stem}.scarlet-")).tempdir_in(parent)
        .map_err(|e| format!("Could not write to the chosen folder ({})", e.kind()))?;
    for file in files {
        let path = match file { HandoffFile::Text { path, .. } | HandoffFile::Copy { path, .. } => path };
        let target = staging.path().join(inside_folder(path)?);
        if let Some(dir) = target.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("Could not write the folder ({})", e.kind()))?; }
        match file {
            HandoffFile::Text { text, .. } => std::fs::write(&target, text).map_err(|e| format!("Could not write the folder ({})", e.kind()))?,
            HandoffFile::Copy { source, .. } if demo && source == "/sample.mp4" => {
                std::fs::write(&target, include_bytes!("../../../web/public/sample.mp4")).map_err(|e| format!("Could not copy the footage ({})", e.kind()))?
            }
            HandoffFile::Copy { source, .. } => {
                let from = std::path::Path::new(source).canonicalize().map_err(|e| format!("Could not copy the footage ({})", e.kind()))?;
                if !from.starts_with(&library) { return Err("The export named a file outside Scarlet's library".into()) }
                std::fs::copy(&from, &target).map_err(|e| format!("Could not copy the footage ({})", e.kind()))?;
            }
        }
    }
    let staged = staging.keep();
    std::fs::rename(&staged, dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staged);
        format!("Could not save the folder ({})", e.kind())
    })
}

/// Save the folder for finishing the edit in another app where the editor chose, then forget the destination.
#[tauri::command]
pub async fn finish_folder_export(app: AppHandle, state: State<'_, AppState>, destinations: State<'_, ExportDestinations>, ticket: u64, files: Vec<HandoffFile>) -> Result<String, String> {
    let path = destinations.change(|paths| (paths.get(&ticket).map(|d| d.path.clone()), false))?.ok_or("Export destination expired")?;
    let (dest, library, demo) = (path.clone(), state.paths.data_dir.clone(), crate::is_demo(&app));
    let saved = tauri::async_runtime::spawn_blocking(move || write_handoff_folder(&dest, &files, &library, demo)).await.map_err(|e| e.to_string())?;
    // Never where it went: the editor typed the folder's name.
    match &saved {
        Ok(()) => log::info!("export folder saved"),
        Err(e) => log::warn!("export folder could not be saved: {e}"),
    }
    // A ledger error is separate from the folder's outcome, as for a video: `change` logs it.
    let _ = destinations.change(|paths| { let kept = paths.remove(&ticket).is_some_and(|d| d.kept); ((), kept) });
    saved.map(|()| path.to_string_lossy().into_owned())
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
/// asks the engine to import them by path.
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
    /// Where this copy gets its updates, when it gets any.
    pub updates: Option<crate::updates::Source>,
    pub custom_openai_models: Vec<String>,
    pub custom_claude_models: Vec<String>,
    pub custom_gemini_models: Vec<String>,
    pub editor_model: Option<EditorModelSelection>,
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
        updates: tauri::Manager::try_state::<crate::updates::Source>(&app).map(|source| *source),
        custom_openai_models: state.paths.custom_openai_models(),
        custom_claude_models: state.paths.custom_claude_models(),
        custom_gemini_models: state.paths.custom_gemini_models(),
        editor_model: state.paths.editor_model(),
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        config_file: state.paths.config_file.to_string_lossy().to_string(),
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        work_dir: state.paths.work_dir.to_string_lossy().to_string(),
        log_dir: state.paths.log_dir.to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn save_editor_model(state: State<'_, AppState>, selection: EditorModelSelection) -> Result<(), String> {
    state.paths.save_editor_model(&selection).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn writes_a_handoff_folder_from_the_library_only() {
        use super::{write_handoff_folder, HandoffFile};
        let library = tempfile::tempdir().unwrap();
        std::fs::write(library.path().join("cam.mov"), b"footage").unwrap();
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Interview");
        let files = vec![
            HandoffFile::Text { path: "Interview.fcpxml".into(), text: "<fcpxml/>".into() },
            HandoffFile::Copy { path: "Media/cam.mov".into(), source: library.path().join("cam.mov").to_string_lossy().into_owned() },
        ];
        write_handoff_folder(&dest, &files, library.path(), false).unwrap();
        assert_eq!(std::fs::read(dest.join("Media/cam.mov")).unwrap(), b"footage");
        assert_eq!(std::fs::read_to_string(dest.join("Interview.fcpxml")).unwrap(), "<fcpxml/>");
        // Never over something already there, never from outside the library, never outside the folder.
        assert!(write_handoff_folder(&dest, &files, library.path(), false).is_err());
        let outside = out.path().join("secret.txt");
        std::fs::write(&outside, b"no").unwrap();
        let stray = vec![HandoffFile::Copy { path: "Media/x".into(), source: outside.to_string_lossy().into_owned() }];
        assert!(write_handoff_folder(&out.path().join("Two"), &stray, library.path(), false).is_err());
        let escape = vec![HandoffFile::Text { path: "../escape.txt".into(), text: "x".into() }];
        assert!(write_handoff_folder(&out.path().join("Three"), &escape, library.path(), false).is_err());
        assert!(!out.path().join("escape.txt").exists());
        // A failed export leaves nothing behind: no folder, no hidden staging folder.
        let names: Vec<_> = std::fs::read_dir(out.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!({ let mut n = names; n.sort(); n }, vec!["Interview".to_string(), "secret.txt".to_string()]);
    }

    use super::*;

    #[test]
    fn two_instances_keep_both_exports_and_do_not_restore_a_discarded_ticket() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let first = ExportDestinations::default();
        let second = ExportDestinations::default();
        first.load(record.clone());
        second.load(record.clone());

        let keep = |app: &ExportDestinations, ticket| {
            app.change(|paths| {
                paths.insert(ticket, ExportDestination {
                    path: dir.path().join(format!("Cut{ticket}.mp4")),
                    temp: None, saver: None, kept: true,
                });
                ((), true)
            }).unwrap();
        };
        let together = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| { together.wait(); keep(&first, 1); });
            together.wait();
            keep(&second, 2);
        });
        let reopened = ExportDestinations::default();
        reopened.load(record.clone());
        for ticket in [1, 2] {
            assert!(reopened.paths.lock().unwrap().contains_key(&ticket));
        }
        reopened.change(|paths| { paths.remove(&1); ((), true) }).unwrap();
        keep(&first, 3);
        let reopened_again = ExportDestinations::default();
        reopened_again.load(record);
        let kept = reopened_again.paths.lock().unwrap();
        assert!(!kept.contains_key(&1));
        assert!(kept.contains_key(&2) && kept.contains_key(&3));
    }

    #[test]
    fn a_second_instance_cannot_take_over_an_active_save() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let first = ExportDestinations::default();
        let second = ExportDestinations::default();
        first.load(record.clone());
        second.load(record);
        first.change(|paths| {
            paths.insert(1, ExportDestination {
                path: dir.path().join("Cut.mp4"), temp: None, saver: None, kept: true,
            });
            ((), true)
        }).unwrap();

        let a = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let b = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let saver = crate::host::spawn::this_scarlet();
        assert!(first.start_save(1, a.path(), saver.clone()).unwrap());
        assert_eq!(second.start_save(1, b.path(), saver.clone()).unwrap_err(), EXPORT_ALREADY_SAVING);
        second.finish_save(1, b.path(), true, true).unwrap();
        assert!(a.path().exists());
        first.finish_save(1, a.path(), true, false).unwrap();
        assert!(second.start_save(1, b.path(), saver).unwrap());
        second.finish_save(1, b.path(), true, true).unwrap();
        assert_eq!(first.change(|paths| (paths.contains_key(&1), false)), Ok(false));
    }

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
    fn writes_demo_caption_and_timeline_data_urls() {
        let json = demo_data_url_bytes("data:application/json;charset=utf-8,%7B%22ok%22%3Atrue%7D").unwrap().unwrap();
        assert_eq!(json, br#"{"ok":true}"#);
        let srt = demo_data_url_bytes("data:text/plain;charset=utf-8,1%0A00%3A00%3A00%2C200%20--%3E%2000%3A00%3A02%2C400%0AWelcome%20back%0A").unwrap().unwrap();
        assert!(String::from_utf8(srt).unwrap().contains("Welcome back"));
        let vtt = demo_data_url_bytes("data:text/vtt;charset=utf-8,WEBVTT%0A%0A00%3A00%3A00.200%20--%3E%2000%3A00%3A02.400%0AWelcome%20back%0A").unwrap().unwrap();
        assert!(String::from_utf8(vtt).unwrap().starts_with("WEBVTT"));
        assert!(demo_data_url_bytes("/sample.mp4").unwrap().is_none());
        assert_eq!(demo_data_url_bytes("data:application/json;charset=utf-8,not-json").unwrap_err(), "Invalid timeline");
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

    /// Whether another Scarlet is still saving is asked of the system, which can take a second on Windows. Nothing is
    /// locked meanwhile: not this process's destinations, and not the record other Scarlets share.
    #[test]
    fn asks_whether_another_save_is_under_way_with_nothing_locked() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let partial = dir.path().join(".tmpOther");
        std::fs::write(&partial, "partial").unwrap();
        let other: Saver = (1, "another Scarlet".into());
        let saved = serde_json::json!({ "1": { "path": dir.path().join("Cut.mp4"), "temp": partial, "saver": other } });
        std::fs::write(&record, saved.to_string()).unwrap();
        let app = ExportDestinations::default();
        let unlocked = |gone: bool| {
            let shared = OpenOptions::new().read(true).write(true).open(record.with_extension("lock")).unwrap();
            let free = app.paths.try_lock().is_ok() && shared.try_lock().is_ok();
            assert!(free, "the destinations were locked while a process was looked up");
            !gone
        };
        // At launch the other Scarlet is still open: its partial file is left.
        app.load_with(record.clone(), |_| unlocked(false));
        assert!(partial.exists());
        // While it is open, a save can't take the destination.
        let mine = dir.path().join(".tmpMine");
        assert_eq!(app.start_save_with(1, &mine, (2, "this Scarlet".into()), |_| unlocked(false)).unwrap_err(), EXPORT_ALREADY_SAVING);
        // Once it has quit, its partial file goes and this save takes the destination.
        assert!(app.start_save_with(1, &mine, (2, "this Scarlet".into()), |_| unlocked(true)).unwrap());
        assert!(!partial.exists());
        let kept: serde_json::Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        assert_eq!(kept["1"]["saver"], serde_json::json!([2, "this Scarlet"]));
    }

    /// A save another Scarlet claimed while this one asked about the save before it is a new save, asked about in turn.
    #[test]
    fn asks_again_about_a_save_claimed_while_it_asked() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("export-destinations.json");
        let (app, other) = (ExportDestinations::default(), ExportDestinations::default());
        app.load(record.clone());
        other.load(record);
        app.change(|paths| {
            paths.insert(1, ExportDestination { path: dir.path().join("Cut.mp4"), temp: None, saver: Some((1, "quit".into())), kept: true });
            ((), true)
        }).unwrap();
        let asked = std::cell::RefCell::new(Vec::new());
        let result = app.start_save_with(1, &dir.path().join(".tmpMine"), (3, "this Scarlet".into()), |saver| {
            asked.borrow_mut().push(saver.1.clone());
            if saver.1 == "quit" {
                other.change(|paths| { paths.get_mut(&1).unwrap().saver = Some((2, "open".into())); ((), true) }).unwrap();
                return false;
            }
            true
        });
        assert_eq!(result.unwrap_err(), EXPORT_ALREADY_SAVING);
        assert_eq!(*asked.borrow(), ["quit", "open"]);
    }

    #[test]
    fn carries_on_when_its_record_is_damaged_while_it_runs() {
        crate::util::test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("damaged-later-export-destinations.json");
        let app = ExportDestinations::default();
        app.load(record.clone());
        std::fs::write(&record, "{\"1\":{\"path\":\"/Users/me/Cut.mp").unwrap();
        // Every export command goes on working, as it does when the record is damaged before launch, and the log says so.
        app.change(|paths| {
            paths.insert(7, ExportDestination { path: dir.path().join("Cut.mp4"), temp: None, saver: None, kept: true });
            ((), true)
        }).unwrap();
        let (level, _) = crate::util::test_log::find(&["export destinations in", "damaged-later-export-destinations.json", "unreadable"]).expect("the damaged record was not logged");
        assert_eq!(level, log::Level::Warn);
        let again = ExportDestinations::default();
        again.load(record);
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
