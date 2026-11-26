//! "Export logs…" (Settings → Advanced): one .zip a tester can send to whoever is helping them.
//! It holds the log folder and a short system report. No media, projects or database.
//!
//! "Report a problem…" (Help menu, Settings → Advanced, and the screen a crash leaves) saves the same bundle with the
//! editor's own words in it, straight to Downloads, and hands the window a short summary for the issue it opens.

mod sanitize;
mod zip;

use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::AppState;
use sanitize::{redact, support_log, support_settings};
use zip::Zip;

const README: &str = "Scarlet logs\n\n\
system.json: Scarlet version, OS, engine and CLI status, and desktop settings.\n\
logs/: UTC event times, operations, and allowlisted diagnostic fields from the desktop log.\n\
report.txt (in a problem report): what the editor wrote about the problem.\n\
Search for a task id (tsk_...) to follow an edit, or for a request id to follow a transfer.\n\n\
Not included: videos, projects, transcripts, the project database or sign-in tokens.\n";

/// Lines of the newest warnings and errors a problem report quotes in the issue it opens.
const RECENT_PROBLEMS: usize = 12;
/// A line quoted there is cut to this many characters: the whole line is in the .zip.
const PROBLEM_LINE_CHARS: usize = 300;
/// What the editor wrote is kept to this many characters.
const DESCRIPTION_CHARS: usize = 5000;

/// A dated file name (UTC): `scarlet-logs-2026-11-06-1432.zip`.
fn dated_name(prefix: &str) -> String {
    let (y, mo, d, h, mi, _) = crate::util::civil_from_unix(crate::util::unix_now().as_secs() as i64);
    format!("{prefix}-{y:04}-{mo:02}-{d:02}-{h:02}{mi:02}.zip")
}

/// File name suggested in the Save dialog: `scarlet-logs-2026-11-06-1432.zip` (UTC).
fn suggested_name() -> String {
    dated_name("scarlet-logs")
}

/// Regular files in the log folder, oldest first (rotated logs before the live one).
fn log_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| (meta.modified().unwrap_or(std::time::UNIX_EPOCH), e.path()))
        })
        .collect();
    files.sort();
    files.into_iter().map(|(_, p)| p).collect()
}

/// A bundle, and the newest warning and error lines in it (already cleaned), oldest first.
struct Bundle {
    bytes: Vec<u8>,
    recent_problems: Vec<String>,
}

fn is_problem(line: &str) -> bool {
    line.contains("][ERROR] ") || line.contains("][WARN] ")
}

fn clip(line: &str, max: usize) -> String {
    match line.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

fn build_bundle(log_dir: &Path, system: &serde_json::Value, token: Option<&str>, description: Option<&str>) -> std::io::Result<Bundle> {
    let mut zip = Zip::new();
    let mut recent_problems = std::collections::VecDeque::with_capacity(RECENT_PROBLEMS);
    zip.add("README.txt", README.as_bytes())?;
    let report = serde_json::to_string_pretty(system).unwrap_or_default();
    zip.add("system.json", redact(&report, token).as_bytes())?;
    if let Some(words) = description.map(str::trim).filter(|w| !w.is_empty()) {
        let text = format!("What happened, in the editor's words:\n\n{}\n", clip(words, DESCRIPTION_CHARS));
        zip.add("report.txt", redact(&text, token).as_bytes())?;
    }
    for path in log_files(log_dir) {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        match std::fs::read(&path) {
            Ok(bytes) => {
                let events = redact(&support_log(&String::from_utf8_lossy(&bytes)), token);
                for line in events.lines().filter(|l| is_problem(l)) {
                    if recent_problems.len() == RECENT_PROBLEMS {
                        recent_problems.pop_front();
                    }
                    recent_problems.push_back(clip(line, PROBLEM_LINE_CHARS));
                }
                zip.add(&format!("logs/{name}"), events.as_bytes())?;
            }
            Err(e) => zip.add(&format!("logs/{name}.unreadable.txt"), e.to_string().as_bytes())?,
        }
    }
    Ok(Bundle { bytes: zip.finish(), recent_problems: recent_problems.into() })
}

/// The system report both bundles carry, and the engine token to take out of everything in them.
async fn system_report(state: &AppState, exported_at: &str) -> (serde_json::Value, Option<String>) {
    let mut engine = state.engine.status();
    let token = engine.token.take();
    let host = state.host.status().await;
    let config = std::fs::read_to_string(&state.paths.config_file).ok().and_then(|t| support_settings(&t));
    let system = serde_json::json!({
        "exportedAt": exported_at,
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": os_version(),
        "engine": { "state": engine.state, "kind": engine.engine_kind, "pid": engine.pid, "restarts": engine.restarts },
        "agentHost": { "connected": host.connected, "configured": host.configured, "running": host.running,
            "agents": host.agents.iter().map(|a| serde_json::json!({ "id": a.id, "installed": a.installed, "loggedIn": a.logged_in })).collect::<Vec<_>>() },
        "desktopConfig": config,
    });
    (system, token)
}

/// Ask where to save, then write the bundle there. Returns the saved path, or None when cancelled.
#[tauri::command]
pub async fn export_logs(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let Some(path) = crate::commands::pick_destination(&app, "Export logs", &suggested_name()).await? else { return Ok(None) };
    let (system, token) = system_report(&state, &crate::util::now_iso()).await;
    let log_dir = state.paths.log_dir.clone();
    // Never where to: the editor typed the file's name.
    log::info!("exporting logs");
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bundle = build_bundle(&log_dir, &system, token.as_deref(), None).map_err(|e| e.to_string())?;
        if path.parent().is_none() {
            return Err("Unsupported save destination".to_string());
        }
        crate::util::write_file_atomic(&path, &bundle.bytes, false).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|saved| saved);
    match &saved {
        Ok(_) => log::info!("logs exported"),
        // A file that couldn't be written is named after " at path ", with the folder the editor chose.
        Err(e) => log::warn!("log export failed: {}", e.split(" at path ").next().unwrap_or(e)),
    }
    saved.map(Some)
}

/// What the window needs to open the issue: where the .zip went, and a short summary to quote.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemReport {
    path: String,
    version: &'static str,
    os: &'static str,
    os_version: Option<String>,
    arch: &'static str,
    recent_problems: Vec<String>,
}

/// Where a problem report is saved: Downloads, where the editor looks for a file to attach, else Scarlet's data folder.
fn report_folder(data_dir: &Path) -> PathBuf {
    dirs::download_dir().filter(|d| d.is_dir()).unwrap_or_else(|| data_dir.join("reports"))
}

/// Save a problem report (the log bundle with the editor's words) without asking where, and say what's in it.
#[tauri::command]
pub async fn report_problem(state: State<'_, AppState>, description: String) -> Result<ProblemReport, String> {
    let (system, token) = system_report(&state, &crate::util::now_iso()).await;
    let os_version = system["osVersion"].as_str().map(str::to_string);
    let log_dir = state.paths.log_dir.clone();
    let folder = report_folder(&state.paths.data_dir);
    // Never the words: they are the editor's own, and they are in the .zip.
    log::info!("saving a problem report ({} characters written)", description.trim().chars().count());
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<(String, Vec<String>), String> {
        let bundle = build_bundle(&log_dir, &system, token.as_deref(), Some(&description)).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let path = folder.join(dated_name("scarlet-report"));
        crate::util::write_file_atomic(&path, &bundle.bytes, false).map_err(|e| e.to_string())?;
        Ok((path.to_string_lossy().into_owned(), bundle.recent_problems))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|saved| saved);
    match &saved {
        Ok((_, recent)) => log::info!("problem report saved with {} recent warnings and errors", recent.len()),
        Err(e) => log::warn!("problem report failed: {}", e.split(" at path ").next().unwrap_or(e)),
    }
    let (path, recent_problems) = saved?;
    Ok(ProblemReport { path, version: env!("CARGO_PKG_VERSION"), os: std::env::consts::OS, os_version, arch: std::env::consts::ARCH, recent_problems })
}

fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    let out = std::process::Command::new("sw_vers").arg("-productVersion").output().ok()?;
    #[cfg(windows)]
    let out = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd").args(["/C", "ver"]).creation_flags(crate::util::CREATE_NO_WINDOW).output().ok()?
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let out = std::process::Command::new("uname").arg("-sr").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Crc;

    const RECORD: &str = "[2026-11-05][02:03:04][scarlet_desktop_lib::engine][INFO]";

    /// The names in a bundle's central directory, in order.
    fn entry_names(bytes: &[u8]) -> Vec<String> {
        let eocd = &bytes[bytes.len() - 22..];
        let count = u16::from_le_bytes([eocd[10], eocd[11]]) as usize;
        let mut at = u32::from_le_bytes(eocd[16..20].try_into().unwrap()) as usize;
        (0..count).map(|_| {
            let name_len = u16::from_le_bytes([bytes[at + 28], bytes[at + 29]]) as usize;
            let name = String::from_utf8_lossy(&bytes[at + 46..at + 46 + name_len]).into_owned();
            at += 46 + name_len;
            name
        }).collect()
    }

    /// One entry of a bundle, unpacked.
    fn entry(bytes: &[u8], name: &str) -> String {
        let at = bytes.windows(name.len()).position(|w| w == name.as_bytes()).unwrap() - 30;
        let packed = u32::from_le_bytes(bytes[at + 18..at + 22].try_into().unwrap()) as usize;
        let data = &bytes[at + 30 + name.len()..at + 30 + name.len() + packed];
        let mut text = String::new();
        std::io::Read::read_to_string(&mut flate2::read::DeflateDecoder::new(data), &mut text).unwrap();
        text
    }

    #[test]
    fn bundles_every_log_file_into_a_readable_zip() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("scarlet-desktop.log"), format!("{RECORD} [engine] [task] tsk_123456789abc running → queued · “spoken request sct_secret12345”\nprivate continuation\n").repeat(100)).unwrap();
        std::fs::write(dir.path().join("scarlet-desktop_2026-11-05.log"), format!("{RECORD} [engine] [activity] note.added by editor: private note\n{RECORD} task tsk_123456789abc (edit, codex): historical request\n{RECORD} [ui] [error] 02:03:04.123 +2ms alert message=\"private edit\"")).unwrap();
        let bytes = build_bundle(dir.path(), &serde_json::json!({ "version": "test" }), None, None).unwrap().bytes;
        // End of central directory: 4 entries (README, system.json, two logs).
        let eocd = &bytes[bytes.len() - 22..];
        assert_eq!(&eocd[..4], &0x06054b50u32.to_le_bytes());
        assert_eq!(u16::from_le_bytes([eocd[10], eocd[11]]), 4);
        // Walk the central directory the way an unzip tool does: every entry must start where the last one ended.
        let mut at = u32::from_le_bytes(eocd[16..20].try_into().unwrap()) as usize;
        for _ in 0..4 {
            assert_eq!(&bytes[at..at + 4], &0x02014b50u32.to_le_bytes());
            let name_len = u16::from_le_bytes([bytes[at + 28], bytes[at + 29]]) as usize;
            at += 46 + name_len;
        }
        assert_eq!(at, bytes.len() - 22);
        // Unpack the live log and check it round-trips with the secret removed.
        let name = b"logs/scarlet-desktop.log";
        let at = bytes.windows(name.len()).position(|w| w == name).unwrap() - 30;
        assert_eq!(&bytes[at..at + 4], &0x04034b50u32.to_le_bytes());
        let packed = u32::from_le_bytes(bytes[at + 18..at + 22].try_into().unwrap()) as usize;
        let data = &bytes[at + 30 + name.len()..at + 30 + name.len() + packed];
        let mut text = String::new();
        std::io::Read::read_to_string(&mut flate2::read::DeflateDecoder::new(data), &mut text).unwrap();
        assert_eq!(text, "[2026-11-05][02:03:04][INFO] [task] tsk_123456789abc running → queued\n".repeat(100));
        let old = entry(&bytes, "logs/scarlet-desktop_2026-11-05.log");
        assert!(old.contains("[host] tsk_123456789abc") && old.contains("[ui] [error] 02:03:04.123 +2ms alert"));
        assert!(!old.contains("private") && !old.contains("historical request"));
        let mut crc = Crc::new();
        crc.update(text.as_bytes());
        assert_eq!(u32::from_le_bytes(bytes[at + 14..at + 18].try_into().unwrap()), crc.sum());
    }

    #[test]
    fn puts_the_oldest_log_first_and_leaves_folders_out() {
        let dir = tempfile::tempdir().unwrap();
        let day = std::time::Duration::from_secs(86_400);
        let now = std::time::SystemTime::now();
        // Written newest first, so the order can't come from the folder listing.
        for (name, age) in [("scarlet-desktop.log", 0), ("scarlet-desktop_2026-11-07.log", 1), ("scarlet-desktop_2026-11-05.log", 3)] {
            let file = std::fs::File::create(dir.path().join(name)).unwrap();
            file.set_modified(now - day * age).unwrap();
        }
        std::fs::create_dir(dir.path().join("crashes")).unwrap();
        let names: Vec<_> = log_files(dir.path()).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["scarlet-desktop_2026-11-05.log", "scarlet-desktop_2026-11-07.log", "scarlet-desktop.log"]);
        assert!(log_files(&dir.path().join("no-such-folder")).is_empty());
    }

    #[test]
    fn a_bundle_without_logs_still_has_the_report_with_the_token_removed() {
        let dir = tempfile::tempdir().unwrap();
        let system = serde_json::json!({ "version": "test", "engine": { "url": "http://127.0.0.1:5123/?token=abcdefgh1234" }, "desktopConfig": null });
        let bytes = build_bundle(&dir.path().join("no-logs-yet"), &system, Some("abcdefgh1234"), None).unwrap().bytes;
        assert_eq!(entry_names(&bytes), ["README.txt", "system.json"]);
        let report = entry(&bytes, "system.json");
        assert!(report.contains("\"version\": \"test\"") && report.contains("token=[redacted]") && !report.contains("abcdefgh1234"), "{report}");
        assert!(entry(&bytes, "README.txt").starts_with("Scarlet logs"));
        assert!(entry(&bytes, "README.txt").contains("engine and CLI status"));
    }

    #[cfg(unix)]
    #[test]
    fn a_log_that_cannot_be_read_is_named_in_the_bundle_with_the_reason() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("scarlet-desktop.log"), format!("{RECORD} [engine] [http] GET /api/projects → 200 in 1ms\n")).unwrap();
        let locked = dir.path().join("scarlet-desktop_2026-11-05.log");
        std::fs::write(&locked, "locked").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads any file, so there is nothing to see there.
        if std::fs::read(&locked).is_ok() {
            return;
        }
        let bytes = build_bundle(dir.path(), &serde_json::json!({}), None, None).unwrap().bytes;
        let mut names = entry_names(&bytes);
        names.sort();
        assert_eq!(names, ["README.txt", "logs/scarlet-desktop.log", "logs/scarlet-desktop_2026-11-05.log.unreadable.txt", "system.json"]);
        assert!(entry(&bytes, "logs/scarlet-desktop_2026-11-05.log.unreadable.txt").to_lowercase().contains("permission denied"));
        assert!(entry(&bytes, "logs/scarlet-desktop.log").ends_with("[http] GET 200 in 1ms path=/api/projects\n"));
    }

    #[test]
    fn redacts_keys_of_each_provider_and_leaves_short_or_ordinary_words() {
        // A token too short to be one is not searched for: it would blank ordinary words.
        assert_eq!(redact("port 1234 open", Some("1234")), "port 1234 open");
        assert_eq!(redact("key sk-ant-api03-AbCdEfGh1234 used", None), "key [redacted] used");
        assert_eq!(redact("ghp_AbCdEfGh1234 and gho_AbCdEfGh1234", None), "[redacted] and [redacted]");
        assert_eq!(redact("OPENAI sk-AbCdEfGh1234", None), "OPENAI [redacted]");
        assert_eq!(redact("OpenRouter sk-or-v1-0123456789abcdef", None), "OpenRouter [redacted]");
        // Words that only begin like a key, and ids of Scarlet's own, stay readable.
        for plain in ["ask-anything-you-like-here", "risk_assessment_done", "prj_01abcdefghijk host_ngrdk4g9fmfq", "sk-short"] {
            assert_eq!(redact(plain, None), plain);
        }
        // Invalid UTF-8 and unstructured output from an older process are omitted.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("scarlet-desktop.log"), b"before \xff\xfe after sct_secret12345\n").unwrap();
        let text = entry(&build_bundle(dir.path(), &serde_json::json!({}), None, None).unwrap().bytes, "logs/scarlet-desktop.log");
        assert!(text.is_empty());
    }

    #[test]
    fn suggests_a_dated_file_name() {
        let name = suggested_name();
        let shape = regex::Regex::new(r"^scarlet-logs-20\d\d-[01]\d-[0-3]\d-[0-2]\d[0-5]\d\.zip$").unwrap();
        assert!(shape.is_match(&name), "{name}");
    }

    #[test]
    fn a_problem_report_carries_the_editors_words_and_quotes_the_newest_problems() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = String::new();
        for i in 0..20 {
            log += &format!("[2026-11-05][02:03:{i:02}][scarlet_desktop_lib::engine][WARN] [engine] [render] render failed code={i}\n");
            log += &format!("[2026-11-05][02:03:{i:02}][scarlet_desktop_lib::engine][INFO] [engine] [http] GET /api/projects → 200 in 1ms\n");
        }
        log += "[2026-11-05][02:04:00][scarlet_desktop_lib::engine][ERROR] [ui] [error] 02:04:00.123 +2ms uncaught name=TypeError\n";
        std::fs::write(dir.path().join("scarlet-desktop.log"), log).unwrap();
        let words = "The export froze at 80% with key sk-ant-api03-AbCdEfGh1234 pasted";
        let bundle = build_bundle(dir.path(), &serde_json::json!({ "version": "test" }), None, Some(words)).unwrap();
        assert_eq!(entry_names(&bundle.bytes), ["README.txt", "system.json", "report.txt", "logs/scarlet-desktop.log"]);
        let report = entry(&bundle.bytes, "report.txt");
        assert!(report.contains("The export froze at 80%") && report.contains("[redacted]") && !report.contains("AbCdEfGh1234"), "{report}");
        // Only warnings and errors, the newest twelve, oldest first, and never an ordinary request.
        assert_eq!(bundle.recent_problems.len(), RECENT_PROBLEMS);
        assert!(bundle.recent_problems.iter().all(|l| l.contains("[WARN]") || l.contains("[ERROR]")));
        assert!(bundle.recent_problems[0].starts_with("[2026-11-05][02:03:09][WARN] [render]"), "{:?}", bundle.recent_problems);
        assert!(bundle.recent_problems.last().unwrap().contains("[ui] [error] 02:04:00.123 +2ms uncaught"));
        // Nothing written leaves report.txt out, and an export of logs never has one.
        let blank = build_bundle(dir.path(), &serde_json::json!({}), None, Some("   ")).unwrap();
        assert!(!entry_names(&blank.bytes).contains(&"report.txt".to_string()));
    }

    #[test]
    fn a_quoted_line_is_cut_on_a_character_boundary() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("ééééé", 3), "ééé…");
    }

    #[test]
    fn suggests_a_dated_report_name() {
        let shape = regex::Regex::new(r"^scarlet-report-20\d\d-[01]\d-[0-3]\d-[0-2]\d[0-5]\d\.zip$").unwrap();
        assert!(shape.is_match(&dated_name("scarlet-report")));
    }
}
