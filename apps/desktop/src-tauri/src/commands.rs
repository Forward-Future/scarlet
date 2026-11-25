//! Tauri commands exposed to the web UI (apps/web/src/lib/desktop.ts).

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

use crate::config::EditorModelSelection;
use crate::engine::EngineStatus;
use crate::host::login::LoginStatus;
use crate::host::HostStatus;
use crate::AppState;

pub use crate::export::{ExportChoice, ExportDestinations, HandoffFile};
pub(crate) use crate::export::pick_destination;

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

/// Ollama, LM Studio and OpenRouter as Settings › Models shows them. Whether there is an OpenRouter key, never the key.
#[tauri::command]
pub async fn provider_settings(state: State<'_, AppState>) -> Result<crate::host::providers::SettingsView, String> {
    let home = state.paths.home.clone();
    // The editor's environment may wait on their login shell.
    let env = tokio::task::spawn_blocking(move || crate::util::child_env(&home)).await.map_err(|e| e.to_string())?;
    Ok(crate::host::providers::view(&state.paths.provider_settings(), &env))
}

/// Save one provider's settings: `{ provider, url?, apiKey?, disabled? }`, where a field left out stays as it was and
/// null or empty text clears it. Then look for the assistants again, as Refresh models does, and return the host.
/// The arguments are read whole, since whether a field is there at all matters.
#[tauri::command]
pub async fn save_provider_settings(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<HostStatus, String> {
    use crate::host::providers::{SettingsPatch, SAVING};
    let tauri::ipc::InvokeBody::Json(args) = request.body() else {
        return Err("expected the settings as JSON".into());
    };
    let patch = SettingsPatch::from_args(args)?;
    {
        let _saving = SAVING.lock().unwrap_or_else(|e| e.into_inner());
        let mut settings = state.paths.provider_settings();
        patch.apply(&mut settings);
        state.paths.save_provider_settings(&settings).map_err(|e| format!("Could not save the settings: {e:#}"))?;
    }
    log::info!("{} settings saved", crate::host::providers::label(&patch.provider));
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

/// Update an installed agent CLI ("claude", "codex" or "gemini") the way it was installed, then detect it again.
/// Returns the version it is at afterwards.
#[tauri::command]
pub async fn agent_update(state: State<'_, AppState>, agent: String) -> Result<Option<String>, String> {
    if state.host.is_running(&agent).await {
        return Err("Scarlet is editing with it right now. Update it once that edit is done.".into());
    }
    let version_of = |status: &HostStatus| status.agents.iter().find(|a| a.id == agent).and_then(|a| a.version.clone());
    let before = version_of(&state.host.status().await);
    crate::host::update::update(&agent, &state.paths.home).await?;
    let after = version_of(&state.host.refresh_agents().await);
    if after == before {
        crate::host::update::note_unchanged(&agent, after.as_deref());
    }
    state.host.check_updates().await;
    Ok(after)
}

#[tauri::command]
pub async fn ffmpeg_status(state: State<'_, AppState>) -> Result<crate::ffmpeg::FfmpegStatus, String> {
    let home = state.paths.home.clone();
    let resources = state.paths.resource_dir.clone();
    tokio::task::spawn_blocking(move || crate::ffmpeg::status(&home, resources.as_deref()))
        .await
        .map_err(|e| format!("Could not check FFmpeg status: {e}"))
}

#[tauri::command]
pub async fn ffmpeg_install(state: State<'_, AppState>) -> Result<crate::ffmpeg::FfmpegStatus, String> {
    crate::ffmpeg::install(&state.paths.home, state.paths.resource_dir.as_deref()).await
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

#[tauri::command]
pub async fn choose_video_export(app: AppHandle, destinations: State<'_, ExportDestinations>, file_name: String) -> Result<Option<ExportChoice>, String> {
    crate::export::choose_video_export(&app, &destinations, &file_name).await
}

/// An export has taken this destination. Remember it until the export is saved or discarded.
#[tauri::command]
pub fn keep_video_export(destinations: State<'_, ExportDestinations>, ticket: u64) -> Result<(), String> {
    destinations.keep(ticket)
}

#[tauri::command]
pub fn discard_video_export(destinations: State<'_, ExportDestinations>, ticket: u64) -> Result<(), String> {
    destinations.discard(ticket)
}

#[tauri::command]
pub async fn finish_video_export(app: AppHandle, state: State<'_, AppState>, destinations: State<'_, ExportDestinations>, ticket: u64, url: String) -> Result<String, String> {
    crate::export::finish_video_export(&app, &state, &destinations, ticket, &url).await
}

/// Save the folder for finishing the edit in another app where the editor chose, then forget the destination.
#[tauri::command]
pub async fn finish_folder_export(app: AppHandle, state: State<'_, AppState>, destinations: State<'_, ExportDestinations>, ticket: u64, files: Vec<HandoffFile>) -> Result<String, String> {
    crate::export::finish_folder_export(&app, &state, &destinations, ticket, files).await
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
    use super::*;

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
