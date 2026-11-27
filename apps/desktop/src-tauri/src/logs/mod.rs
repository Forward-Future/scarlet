//! "Export logs…" (Settings → Advanced): one .zip a tester can send to whoever is helping them.
//! It holds the log folder and a short system report. No media, projects or database.
//!
//! "Report a problem" (beside an error where it shows, the Help menu, Settings → Advanced and the screen a crash leaves)
//! sends the same cleaned logs with the editor's own words straight to the Scarlet team (`send.rs`). Should that fail,
//! it saves them as a bundle in Downloads instead.

mod sanitize;
pub mod send;
mod zip;


use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::AppState;
use sanitize::{redact, support_log, support_settings};
use zip::Zip;

const README: &str = "Scarlet logs\n\n\
system.json: Scarlet version, OS, engine and CLI status, and desktop settings.\n\
logs/: UTC event times, operations, and allowlisted diagnostic fields from the desktop log.\n\
report.txt (in a problem report): what the editor wrote about the problem, and what was on screen.\n\
Search for a task id (tsk_...) to follow an edit, or for a request id to follow a transfer.\n\n\
Not included: videos, projects, transcripts, the project database or sign-in tokens.\n";

/// Lines of the newest warnings and errors a problem report quotes on its own, beside the whole log.
const RECENT_PROBLEMS: usize = 12;
/// A line quoted there is cut to this many characters: the whole line is in the log.
const PROBLEM_LINE_CHARS: usize = 300;
/// What the editor wrote is kept to this many characters.
const DESCRIPTION_CHARS: usize = 5000;
/// The error a report was asked about is kept to this many characters.
const ABOUT_CHARS: usize = 2000;
/// The newest errors the window showed that a report carries.
const ON_SCREEN_LINES: usize = 5;

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
}

/// What the editor wrote, and the error they were looking at when they asked to report it.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportWords {
    pub description: String,
    /// The error on screen where the report was asked for ("Couldn't finish: Claude Code stopped responding.").
    pub about: Option<String>,
    /// The page, as the window's log names it: its path and the names of its query parameters.
    pub page: Option<String>,
    /// The newest errors the window showed, oldest first, as its log records them.
    pub on_screen: Vec<String>,
}

impl ReportWords {
    fn description(&self) -> Option<String> {
        Some(self.description.trim()).filter(|w| !w.is_empty()).map(|w| clip(w, DESCRIPTION_CHARS))
    }
    fn about(&self) -> Option<String> {
        self.about.as_deref().map(str::trim).filter(|w| !w.is_empty()).map(|w| clip(w, ABOUT_CHARS))
    }
    fn on_screen(&self) -> Vec<String> {
        let start = self.on_screen.len().saturating_sub(ON_SCREEN_LINES);
        self.on_screen[start..].iter().map(|l| clip(l.trim(), PROBLEM_LINE_CHARS)).filter(|l| !l.is_empty()).collect()
    }
    /// The words as report.txt has them.
    fn text(&self) -> Option<String> {
        let mut parts = Vec::new();
        if let Some(words) = self.description() {
            parts.push(format!("What happened, in the editor's words:\n\n{words}\n"));
        }
        if let Some(about) = self.about() {
            parts.push(format!("The error on screen:\n\n{about}\n"));
        }
        let shown = self.on_screen();
        if !shown.is_empty() {
            parts.push(format!("Errors the window showed before it:\n\n{}\n", shown.join("\n")));
        }
        (!parts.is_empty()).then(|| parts.join("\n"))
    }
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

/// Each log file, oldest first, by name: its cleaned events, or why it couldn't be read.
fn cleaned_logs(log_dir: &Path, token: Option<&str>) -> Vec<(String, Result<String, String>)> {
    log_files(log_dir)
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            let text = std::fs::read(&path).map(|bytes| redact(&support_log(&String::from_utf8_lossy(&bytes)), token)).map_err(|e| e.to_string());
            Some((name, text))
        })
        .collect()
}

/// The newest warning and error lines across the logs, oldest first, each cut to a readable length.
fn recent_problems(logs: &[(String, Result<String, String>)]) -> Vec<String> {
    let mut recent = std::collections::VecDeque::with_capacity(RECENT_PROBLEMS);
    for line in logs.iter().filter_map(|(_, text)| text.as_ref().ok()).flat_map(|t| t.lines()).filter(|l| is_problem(l)) {
        if recent.len() == RECENT_PROBLEMS {
            recent.pop_front();
        }
        recent.push_back(clip(line, PROBLEM_LINE_CHARS));
    }
    recent.into()
}

fn build_bundle(log_dir: &Path, system: &serde_json::Value, token: Option<&str>, words: Option<&ReportWords>) -> std::io::Result<Bundle> {
    let mut zip = Zip::new();
    zip.add("README.txt", README.as_bytes())?;
    let report = serde_json::to_string_pretty(system).unwrap_or_default();
    zip.add("system.json", redact(&report, token).as_bytes())?;
    if let Some(text) = words.and_then(ReportWords::text) {
        zip.add("report.txt", redact(&text, token).as_bytes())?;
    }
    for (name, text) in cleaned_logs(log_dir, token) {
        match text {
            Ok(events) => zip.add(&format!("logs/{name}"), events.as_bytes())?,
            Err(e) => zip.add(&format!("logs/{name}.unreadable.txt"), e.as_bytes())?,
        }
    }
    Ok(Bundle { bytes: zip.finish() })
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

/// Where a saved problem report goes: Downloads, where the editor looks for a file to send, else Scarlet's data folder.
fn report_folder(data_dir: &Path) -> PathBuf {
    dirs::download_dir().filter(|d| d.is_dir()).unwrap_or_else(|| data_dir.join("reports"))
}

/// Save a problem report (the log bundle with the editor's words) to Downloads without asking where, when it couldn't
/// be sent. Returns where it went.
#[tauri::command]
pub async fn save_problem_report(state: State<'_, AppState>, report: ReportWords) -> Result<String, String> {
    let (system, token) = system_report(&state, &crate::util::now_iso()).await;
    let log_dir = state.paths.log_dir.clone();
    let folder = report_folder(&state.paths.data_dir);
    // Never the words: they are the editor's own, and they are in the .zip.
    log::info!("saving a problem report ({} characters written)", report.description.trim().chars().count());
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bundle = build_bundle(&log_dir, &system, token.as_deref(), Some(&report)).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let path = folder.join(dated_name("scarlet-report"));
        crate::util::write_file_atomic(&path, &bundle.bytes, false).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|saved| saved);
    match &saved {
        Ok(_) => log::info!("problem report saved"),
        Err(e) => log::warn!("problem report couldn't be saved: {}", e.split(" at path ").next().unwrap_or(e)),
    }
    saved
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
    fn includes_sanitized_shared_copies_logs_in_the_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let copies_raw = concat!(
            "2026-11-25T01:23:42.365Z id=com.forwardfuture.scarlet.review pid=1428890 start version=0.1.500 build=release exe=\"/Users/me/Applications/Scarlet.app/Contents/MacOS/scarlet\" data=\"/Users/me/Movies/private data\" log=\"/Users/me/Library/Logs/com.forwardfuture.scarlet.review\"\n",
            "2026-11-25T01:23:42.365Z id=com.forwardfuture.scarlet.review pid=1428891 start version=0.1.501 build=debug exe=\"/Users/me/Scarlet\" count=4\n",
            "2026-11-25T01:23:42.365Z id=com.forwardfuture.scarlet.review pid=1428890 [request] 00:13:26.908 +0ms send how=typed dest=new-edit chars=4 aim=whole project=prj_123456789abc error=\"Someone's private words\"\n",
            "2026-11-25T01:23:42.365Z id=com.forwardfuture.scarlet.review pid=1428890 [request] private words\n",
            "2026-11-25T01:23:42.365Z id=com.forwardfuture.scarlet.review pid=1428890 exit\n",
            "2026-11-25T01:23:42.365Z id=com.example.me pid=1428890 start version=0.1.500 build=release\n",
            "2026-11-25T01:23:42.365Z id=com.forwardfuture.scarlet.review pid=1428890 note private words\n",
        );
        let rotated_raw = concat!(
            "2026-11-24T22:10:00.000Z id=com.forwardfuture.scarlet pid=99 start version=0.1.499 build=demo exe=\"/Users/me/Applications/Scarlet.app\" data=\"/Users/me/Movies/private\" log=\"/Users/me/Library/Logs/scarlet\"\n",
            "2026-11-24T22:15:00.000Z id=com.forwardfuture.scarlet pid=99 exit\n",
        );
        std::fs::write(dir.path().join("scarlet-copies.log"), copies_raw).unwrap();
        std::fs::write(dir.path().join("scarlet-copies.1.log"), rotated_raw).unwrap();

        let bytes = build_bundle(dir.path(), &serde_json::json!({ "version": "test" }), None, None).unwrap().bytes;
        let copies = entry(&bytes, "logs/scarlet-copies.log");
        assert!(!copies.is_empty(), "scarlet-copies.log entry should not be empty");
        for expected in [
            "[2026-11-25][01:23:42][INFO] [copy] id=com.forwardfuture.scarlet.review pid=1428890 start version=0.1.500 build=release",
            "[2026-11-25][01:23:42][INFO] [copy] id=com.forwardfuture.scarlet.review pid=1428891 start version=0.1.501 build=debug",
            "[2026-11-25][01:23:42][INFO] [copy] id=com.forwardfuture.scarlet.review pid=1428890 [ui] [request] 00:13:26.908 +0ms send how=typed dest=new-edit chars=4 aim=whole project=prj_123456789abc",
            "[2026-11-25][01:23:42][INFO] [copy] id=com.forwardfuture.scarlet.review pid=1428890 exit",
        ] {
            assert!(copies.contains(expected), "missing {expected:?} in {copies}");
        }
        assert_eq!(copies.matches(" exit").count(), 1, "{copies}");
        for forbidden in ["/Users/me", "exe=", "data=", "log=", "count=", "private", "Someone", "com.example", "note"] {
            assert!(!copies.contains(forbidden), "unexpected {forbidden:?} in {copies}");
        }

        let rotated = entry(&bytes, "logs/scarlet-copies.1.log");
        assert!(!rotated.is_empty(), "scarlet-copies.1.log entry should not be empty");
        assert!(rotated.contains("[2026-11-24][22:10:00][INFO] [copy] id=com.forwardfuture.scarlet pid=99 start version=0.1.499 build=demo"), "{rotated}");
        assert!(rotated.contains("[2026-11-24][22:15:00][INFO] [copy] id=com.forwardfuture.scarlet pid=99 exit"), "{rotated}");
        for forbidden in ["/Users/me", "exe=", "data=", "log=", "private"] {
            assert!(!rotated.contains(forbidden), "unexpected {forbidden:?} in {rotated}");
        }
    }

    #[test]
    fn suggests_a_dated_file_name() {
        let name = suggested_name();
        let shape = regex::Regex::new(r"^scarlet-logs-20\d\d-[01]\d-[0-3]\d-[0-2]\d[0-5]\d\.zip$").unwrap();
        assert!(shape.is_match(&name), "{name}");
    }

    #[test]
    fn a_saved_report_carries_the_editors_words_and_what_was_on_screen() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = String::new();
        for i in 0..20 {
            log += &format!("[2026-11-05][02:03:{i:02}][scarlet_desktop_lib::engine][WARN] [engine] [render] render failed code={i}\n");
            log += &format!("[2026-11-05][02:03:{i:02}][scarlet_desktop_lib::engine][INFO] [engine] [http] GET /api/projects → 200 in 1ms\n");
        }
        log += "[2026-11-05][02:04:00][scarlet_desktop_lib::engine][ERROR] [ui] [error] 02:04:00.123 +2ms uncaught name=TypeError\n";
        std::fs::write(dir.path().join("scarlet-desktop.log"), log).unwrap();
        let words = ReportWords {
            description: "The export froze at 80% with key sk-ant-api03-AbCdEfGh1234 pasted".into(),
            about: Some("Export stopped: ffmpeg exited".into()),
            page: Some("/p/prj_demo?thread".into()),
            on_screen: (0..8).map(|i| format!("alert {i}")).collect(),
        };
        let bundle = build_bundle(dir.path(), &serde_json::json!({ "version": "test" }), None, Some(&words)).unwrap();
        assert_eq!(entry_names(&bundle.bytes), ["README.txt", "system.json", "report.txt", "logs/scarlet-desktop.log"]);
        let report = entry(&bundle.bytes, "report.txt");
        assert!(report.contains("The export froze at 80%") && report.contains("[redacted]") && !report.contains("AbCdEfGh1234"), "{report}");
        assert!(report.contains("The error on screen:\n\nExport stopped: ffmpeg exited"), "{report}");
        // Only the newest five errors the window showed.
        assert!(report.contains("alert 3\nalert 4") && report.contains("alert 7") && !report.contains("alert 2"), "{report}");
        // Only warnings and errors, the newest twelve, oldest first, and never an ordinary request.
        let recent = recent_problems(&cleaned_logs(dir.path(), None));
        assert_eq!(recent.len(), RECENT_PROBLEMS);
        assert!(recent.iter().all(|l| l.contains("[WARN]") || l.contains("[ERROR]")));
        assert!(recent[0].starts_with("[2026-11-05][02:03:09][WARN] [render]"), "{recent:?}");
        assert!(recent.last().unwrap().contains("[ui] [error] 02:04:00.123 +2ms uncaught"));
        // Nothing written leaves report.txt out, and an export of logs never has one.
        let blank = build_bundle(dir.path(), &serde_json::json!({}), None, Some(&ReportWords { description: "   ".into(), ..Default::default() })).unwrap();
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
