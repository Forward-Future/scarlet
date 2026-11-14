//! Scarlet desktop (Tauri 2): wraps the web UI, runs the engine sidecar in solo
//! mode and hosts the local agent runner (Claude Code / Codex / Gemini).

pub mod commands;
pub mod config;
pub mod engine;
pub mod host;
pub mod util;
mod crisper;
mod updates;
mod storage;
mod logs;
mod quit;
#[cfg(target_os = "linux")]
mod linux;

use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent};

use config::{AppConfig, Paths};
use engine::EngineManager;
use host::login::LoginManager;
use host::{HostManager, McpLauncher};

pub struct AppState {
    pub paths: Paths,
    pub config: Arc<Mutex<AppConfig>>,
    pub engine: Arc<EngineManager>,
    pub host: Arc<HostManager>,
    pub login: Arc<LoginManager>,
}

fn resolve_paths(app: &tauri::AppHandle) -> anyhow::Result<Paths> {
    let p = app.path();
    let data_root = p.app_data_dir()?;
    let config_root = p.app_config_dir()?;
    let log_dir = p.app_log_dir().unwrap_or_else(|_| data_root.join("logs"));
    let resource_dir = p.resource_dir().ok();
    Ok(Paths {
        config_file: config_root.join("desktop.json"),
        data_dir: data_root.join("data"),
        work_dir: data_root.join("work"),
        log_dir,
        resource_dir,
        home: util::home_dir(),
    })
}

/// Write a panic to the log before the default hook prints it. A release build aborts on a panic, so this is
/// the only place one is written down.
fn log_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // On one line, as every record is: where it happened, then the message.
        log::error!("panic: {}", info.to_string().replace('\n', " "));
        previous(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_panics();
    let log_level = if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info };
    let builder = tauri::Builder::default();
    // The standard Quit ends Scarlet at once, with whatever is under way. Scarlet's own asks first.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(quit::menu).on_menu_event(|app, event| {
        if event.id() == quit::QUIT_MENU_ID {
            quit::ask_before_quitting(app);
        }
    });
    let app = builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("tungstenite", log::LevelFilter::Warn)
                .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                // The default keeps one 40 KB file, a few minutes of a busy edit. Keep enough to diagnose a long run.
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("scarlet-desktop".into()) }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(commands::ExportDestinations::default())
        // Closing the window quits Scarlet: ⌘W, the close button and Alt+F4 ask first when that would stop work.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                quit::ask_before_quitting(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_status,
            commands::host_status,
            commands::host_refresh_agents,
            commands::agent_install,
            crisper::install_crisper_model,
            commands::agent_login_start,
            commands::agent_login_code,
            commands::agent_login_cancel,
            commands::agent_login_status,
            commands::open_url,
            commands::open_path,
            commands::choose_video_export,
            commands::keep_video_export,
            commands::discard_video_export,
            commands::finish_video_export,
            commands::reveal_path,
            commands::pick_files,
            commands::desktop_log,
            commands::desktop_info,
            logs::export_logs,
            storage::measure_project_storage,
            storage::developer_storage,
            updates::update_status,
            updates::latest_update_revision,
            updates::restart_for_update,
        ])
        .setup(|app| {
            // Read the login shell's PATH off the main thread before anything needs it.
            #[cfg(target_os = "macos")]
            std::thread::spawn(|| {
                let found = util::login_shell_path().is_some();
                log::info!("login shell PATH {}", if found { "loaded" } else { "unavailable; using the built-in search paths" });
            });
            let handle = app.handle().clone();
            #[cfg(target_os = "linux")]
            if let Some(window) = handle.get_webview_window("main") {
                linux::enable_voice_input(&window)?;
            }
            let paths = resolve_paths(&handle)?;
            if let Ok(root) = handle.path().app_data_dir() {
                handle.state::<commands::ExportDestinations>().load(root.join("export-destinations.json"));
            }
            let config = Arc::new(Mutex::new(AppConfig::load(&paths.config_file)));
            log::info!("Scarlet desktop {} starting; data {}; config {}", env!("CARGO_PKG_VERSION"), paths.data_dir.display(), paths.config_file.display());

            let mcp = match engine::resolve_engine_launch(&paths.home, paths.resource_dir.as_deref()) {
                Ok(l) => {
                    log::info!("engine command: {} ({})", l.describe(), l.kind);
                    Some(McpLauncher::from_engine(&l))
                }
                Err(e) => {
                    log::error!("engine not available: {e}");
                    None
                }
            };
            let engine = Arc::new(EngineManager::new(handle.clone(), paths.clone()));
            let host = Arc::new(HostManager::new(handle.clone(), paths.clone(), config.clone(), mcp));
            let login = Arc::new(LoginManager::new(handle.clone(), paths.home.clone(), host.clone()));
            app.manage(AppState { paths: paths.clone(), config: config.clone(), engine: engine.clone(), host: host.clone(), login });

            // The native interview demo uses in-memory fixtures and has no engine jobs.
            if !(cfg!(debug_assertions) && handle.config().identifier == "com.forwardfuture.scarlet.demo") {
                engine.start_solo();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Scarlet desktop app");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                log::info!("exiting: cancelling tasks and stopping the engine");
                state.login.cancel_all();
                state.host.stop_blocking();
                state.engine.stop_blocking();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn writes_a_panic_to_the_log_and_still_reports_it() {
        use std::sync::atomic::{AtomicBool, Ordering};
        crate::util::test_log::capture();
        // The hook in place before this one notes the test's own panic, and hands every panic on as it was.
        static REPORTED: AtomicBool = AtomicBool::new(false);
        let before = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if info.to_string().contains("test 7f3a") {
                REPORTED.store(true, Ordering::SeqCst);
            }
            before(info);
        }));
        super::log_panics();
        let panicked = std::thread::spawn(|| panic!("the timeline went missing\n(test 7f3a)")).join();
        assert!(panicked.is_err());
        assert!(REPORTED.load(Ordering::SeqCst), "the hook before it was not called");
        let (level, line) = crate::util::test_log::find(&["panic:", "the timeline went missing (test 7f3a)"]).expect("the panic was not logged");
        assert_eq!(level, log::Level::Error);
        // Where it happened is on the line too, and it is one line.
        assert!(line.contains("lib.rs") && !line.contains('\n'), "{line}");
    }
}
