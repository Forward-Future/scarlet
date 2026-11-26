//! "Export logs…" (Settings → Advanced): one .zip a tester can send to whoever is helping them.
//! It holds the log folder and a short system report. No media, projects or database.

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
Search for a task id (tsk_...) to follow an edit, or for a request id to follow a transfer.\n\n\
Not included: videos, projects, transcripts, the project database or sign-in tokens.\n";

/// File name suggested in the Save dialog: `scarlet-logs-2026-11-06-1432.zip` (UTC).
fn suggested_name() -> String {
    let (y, mo, d, h, mi, _) = crate::util::civil_from_unix(crate::util::unix_now().as_secs() as i64);
    format!("scarlet-logs-{y:04}-{mo:02}-{d:02}-{h:02}{mi:02}.zip")
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

fn build_bundle(log_dir: &Path, system: &serde_json::Value, token: Option<&str>) -> std::io::Result<Vec<u8>> {
    let mut zip = Zip::new();
    zip.add("README.txt", README.as_bytes())?;
    let report = serde_json::to_string_pretty(system).unwrap_or_default();
    zip.add("system.json", redact(&report, token).as_bytes())?;
    for path in log_files(log_dir) {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        match std::fs::read(&path) {
            Ok(bytes) => {
                let events = support_log(&String::from_utf8_lossy(&bytes));
                zip.add(&format!("logs/{name}"), redact(&events, token).as_bytes())?;
            }
            Err(e) => zip.add(&format!("logs/{name}.unreadable.txt"), e.to_string().as_bytes())?,
        }
    }
    Ok(zip.finish())
}

/// Ask where to save, then write the bundle there. Returns the saved path, or None when cancelled.
#[tauri::command]
pub async fn export_logs(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let Some(path) = crate::commands::pick_destination(&app, "Export logs", &suggested_name()).await? else { return Ok(None) };
    let mut engine = state.engine.status();
    let token = engine.token.take();
    let host = state.host.status().await;
    let config = std::fs::read_to_string(&state.paths.config_file).ok().and_then(|t| support_settings(&t));
    let system = serde_json::json!({
        "exportedAt": crate::util::now_iso(),
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": os_version(),
        "engine": { "state": engine.state, "kind": engine.engine_kind, "pid": engine.pid, "restarts": engine.restarts },
        "agentHost": { "connected": host.connected, "configured": host.configured, "running": host.running,
            "agents": host.agents.iter().map(|a| serde_json::json!({ "id": a.id, "installed": a.installed, "loggedIn": a.logged_in })).collect::<Vec<_>>() },
        "desktopConfig": config,
    });
    let log_dir = state.paths.log_dir.clone();
    // Never where to: the editor typed the file's name.
    log::info!("exporting logs");
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bytes = build_bundle(&log_dir, &system, token.as_deref()).map_err(|e| e.to_string())?;
        if path.parent().is_none() {
            return Err("Unsupported save destination".to_string());
        }
        crate::util::write_file_atomic(&path, &bytes, false).map_err(|e| e.to_string())?;
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
        let bytes = build_bundle(dir.path(), &serde_json::json!({ "version": "test" }), None).unwrap();
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
        let bytes = build_bundle(&dir.path().join("no-logs-yet"), &system, Some("abcdefgh1234")).unwrap();
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
        let bytes = build_bundle(dir.path(), &serde_json::json!({}), None).unwrap();
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
        let text = entry(&build_bundle(dir.path(), &serde_json::json!({}), None).unwrap(), "logs/scarlet-desktop.log");
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

        let bytes = build_bundle(dir.path(), &serde_json::json!({ "version": "test" }), None).unwrap();
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
}
