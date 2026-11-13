//! "Export logs…" (Settings → Advanced): one .zip a tester can send to whoever is helping them.
//! It holds the log folder and a short system report. No media, projects or database.

use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use tauri::{AppHandle, State};

use crate::AppState;

const README: &str = "Scarlet logs\n\n\
system.json: Scarlet version, OS, engine and AI assistant status, and desktop settings.\n\
logs/: UTC event times, components, task and media states, and HTTP results from the desktop log.\n\
Search for a task id (tsk_...) to follow one edit.\n\n\
Not included: videos, projects, transcripts, the project database or sign-in tokens.\n";

/// File name suggested in the Save dialog: `scarlet-logs-2026-11-06-1432.zip` (UTC).
fn suggested_name() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let (y, mo, d, h, mi, _) = crate::util::civil_from_unix(secs);
    format!("scarlet-logs-{y:04}-{mo:02}-{d:02}-{h:02}{mi:02}.zip")
}

/// Replace the engine token and anything shaped like one, in case a log line ever carried it.
fn redact(text: &str, token: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(t) = token.filter(|t| t.len() >= 8) {
        out = out.replace(t, "[redacted]");
    }
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = PATTERN.get_or_init(|| regex::Regex::new(r"\b(sct|sk|sk-ant|ghp|gho)[_-][A-Za-z0-9_\-]{8,}").expect("valid regex"));
    re.replace_all(&out, "[redacted]").into_owned()
}

/// Older logs put requests, filenames, replies and provider errors in free-form messages.
/// Export operational fields only. Continuation lines have no record header.
fn support_log(text: &str) -> String {
    use regex::Regex;
    static PATTERNS: std::sync::OnceLock<[Regex; 5]> = std::sync::OnceLock::new();
    let [record_pattern, engine_pattern, entity_pattern, http_pattern, ui_pattern] = PATTERNS.get_or_init(|| [
        r"^(\[\d{4}-\d\d-\d\d\]\[\d\d:\d\d:\d\d\])\[[\w:.-]+\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\] (.*)$",
        r"^\[engine\] \[(activity|cleanup|edit|error|http|ingest|inspection|media|model|project|render|review|skills|speakers|storage|task|transcribe|trash|voice-note)\] (.*)$",
        r"^((?:tsk|med|prj|rnd|chg)_[a-z0-9]{12})\b(?: (queued|claimed|running|waiting_for_user|done|failed|cancelled|approved|rejected|ready|ingesting|started|interrupted)\b)?(?: → (running|waiting_for_user|queued|ready|approved|rejected|failed)\b)?(?: after (\d+(?:ms|s|m|h)(?: \d+[sm])?))?",
        r"^(?:slow request: )?(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \S+ → (\d{3}) (?:in|after) (\d+(?:ms|s|m|h)(?: \d+[sm])?)\b",
        r"^\[ui\] \[(app|nav|action|api|realtime|playback|window|error)\] \d\d:\d\d:\d\d\.\d{3} \+\d+ms ([a-zA-Z0-9_.-]{1,40})\b",
    ].map(|pattern| Regex::new(pattern).expect("valid support log pattern")));
    let mut out = String::new();
    for line in text.lines() {
        let Some(record) = record_pattern.captures(line) else { continue };
        let message = &record[3];
        out.push_str(&record[1]);
        out.push_str(&format!("[{}] ", &record[2]));
        let (component, detail) = if let Some(engine) = engine_pattern.captures(message) {
            (engine.get(1).unwrap().as_str(), engine.get(2).unwrap().as_str())
        } else if let Some(task) = message.strip_prefix("task ") {
            ("host", task)
        } else if let Some(ui) = ui_pattern.captures(message) {
            out.push_str(&format!("[ui] [{}] {}\n", &ui[1], &ui[2]));
            continue;
        } else {
            (if message.starts_with("[engine]") { "engine" } else { "desktop" }, "")
        };
        out.push_str(&format!("[{component}]"));
        if component == "http" {
            if let Some(fields) = http_pattern.captures(detail) {
                out.push_str(&format!(" {} {} in {}", &fields[1], &fields[2], &fields[3]));
            }
        } else if let Some(entity) = entity_pattern.find(detail) {
            out.push(' ');
            out.push_str(entity.as_str());
        }
        out.push('\n');
    }
    out
}

fn support_settings(text: &str) -> Option<serde_json::Value> {
    let config: crate::config::AppConfig = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    Some(serde_json::json!({
        "timeoutMinutes": config.timeout_minutes, "stallMinutes": config.stall_minutes, "maxParallel": config.max_parallel
    }))
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

/// Minimal zip writer: deflated entries, UTF-8 names, no zip64 (a support bundle stays far below 4 GB).
struct Zip {
    out: Vec<u8>,
    central: Vec<u8>,
    entries: u16,
    dos_time: u16,
    dos_date: u16,
}

impl Zip {
    fn new() -> Self {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let (y, mo, d, h, mi, s) = crate::util::civil_from_unix(secs);
        Zip {
            out: Vec::new(),
            central: Vec::new(),
            entries: 0,
            dos_time: ((h as u16) << 11) | ((mi as u16) << 5) | ((s as u16) / 2),
            dos_date: (((y.clamp(1980, 2107) - 1980) as u16) << 9) | ((mo as u16) << 5) | d as u16,
        }
    }

    fn add(&mut self, name: &str, data: &[u8]) -> std::io::Result<()> {
        let mut crc = Crc::new();
        crc.update(data);
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data)?;
        let packed = enc.finish()?;
        let too_big = || std::io::Error::other("log bundle too large");
        let (size, packed_size) = (u32::try_from(data.len()).map_err(|_| too_big())?, u32::try_from(packed.len()).map_err(|_| too_big())?);
        let offset = u32::try_from(self.out.len()).map_err(|_| too_big())?;
        let name_len = name.len() as u16;
        // Fields shared by the local header and the central directory entry, from "version needed" to "extra length".
        let mut common = Vec::with_capacity(26);
        common.extend_from_slice(&20u16.to_le_bytes()); // version needed: 2.0 (deflate)
        common.extend_from_slice(&0x0800u16.to_le_bytes()); // flags: UTF-8 names
        common.extend_from_slice(&8u16.to_le_bytes()); // method: deflate
        common.extend_from_slice(&self.dos_time.to_le_bytes());
        common.extend_from_slice(&self.dos_date.to_le_bytes());
        common.extend_from_slice(&crc.sum().to_le_bytes());
        common.extend_from_slice(&packed_size.to_le_bytes());
        common.extend_from_slice(&size.to_le_bytes());
        common.extend_from_slice(&name_len.to_le_bytes());
        common.extend_from_slice(&0u16.to_le_bytes()); // extra length

        self.out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        self.out.extend_from_slice(&common);
        self.out.extend_from_slice(name.as_bytes());
        self.out.extend_from_slice(&packed);

        self.central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        self.central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        self.central.extend_from_slice(&common);
        self.central.extend_from_slice(&[0; 6]); // comment length, disk, internal attributes
        self.central.extend_from_slice(&[0; 4]); // external attributes
        self.central.extend_from_slice(&offset.to_le_bytes());
        self.central.extend_from_slice(name.as_bytes());
        self.entries += 1;
        Ok(())
    }

    fn finish(mut self) -> Vec<u8> {
        let (cd_offset, cd_size) = (self.out.len() as u32, self.central.len() as u32);
        self.out.append(&mut self.central);
        self.out.extend_from_slice(&0x06054b50u32.to_le_bytes());
        self.out.extend_from_slice(&[0; 4]); // disk numbers
        self.out.extend_from_slice(&self.entries.to_le_bytes());
        self.out.extend_from_slice(&self.entries.to_le_bytes());
        self.out.extend_from_slice(&cd_size.to_le_bytes());
        self.out.extend_from_slice(&cd_offset.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // comment length
        self.out
    }
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
        let parent = path.parent().ok_or("Unsupported save destination")?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.persist(&path).map_err(|e| e.to_string())?;
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
        std::process::Command::new("cmd").args(["/C", "ver"]).creation_flags(0x08000000).output().ok()?
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let out = std::process::Command::new("uname").arg("-sr").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    const RECORD: &str = "[2026-11-05][02:03:04][scarlet_desktop_lib::engine][INFO]";

    #[test]
    fn redacts_the_engine_token_and_token_shaped_strings() {
        let text = "ready token=abcdef123456 url ok; other sct_zzzzzzzzzzzz end";
        let out = redact(text, Some("abcdef123456"));
        assert!(!out.contains("abcdef123456"));
        assert!(!out.contains("sct_zzzzzzzzzzzz"));
        assert!(out.contains("url ok"));
        assert_eq!(redact("task tsk_01abcdefghijk failed", None), "task tsk_01abcdefghijk failed");
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
        assert!(old.contains("[host] tsk_123456789abc") && old.contains("[ui] [error] alert"));
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
    fn a_bundle_without_logs_still_has_the_report_with_the_token_removed() {
        let dir = tempfile::tempdir().unwrap();
        let system = serde_json::json!({ "version": "test", "engine": { "url": "http://127.0.0.1:5123/?token=abcdefgh1234" }, "desktopConfig": null });
        let bytes = build_bundle(&dir.path().join("no-logs-yet"), &system, Some("abcdefgh1234")).unwrap();
        assert_eq!(entry_names(&bytes), ["README.txt", "system.json"]);
        let report = entry(&bytes, "system.json");
        assert!(report.contains("\"version\": \"test\"") && report.contains("token=[redacted]") && !report.contains("abcdefgh1234"), "{report}");
        assert!(entry(&bytes, "README.txt").starts_with("Scarlet logs"));
    }

    #[test]
    fn exports_only_recognized_diagnostic_settings_from_older_desktop_configs() {
        let old = r#"{"teamToken":"opaque fixture credential","serverUrl":"private address","hostIds":{"private address":"private host"},"maxParallel":3,"stallMinutes":10,"nested":{"key":"secret"}}"#;
        let settings = support_settings(old).unwrap();
        assert_eq!(settings, serde_json::json!({"timeoutMinutes": null, "stallMinutes": 10, "maxParallel": 3}));
        assert!(support_settings("invalid configuration").is_none());
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
        assert!(entry(&bytes, "logs/scarlet-desktop.log").ends_with("[http] GET 200 in 1ms\n"));
    }

    #[test]
    fn redacts_keys_of_each_provider_and_leaves_short_or_ordinary_words() {
        // A token too short to be one is not searched for: it would blank ordinary words.
        assert_eq!(redact("port 1234 open", Some("1234")), "port 1234 open");
        assert_eq!(redact("key sk-ant-api03-AbCdEfGh1234 used", None), "key [redacted] used");
        assert_eq!(redact("ghp_AbCdEfGh1234 and gho_AbCdEfGh1234", None), "[redacted] and [redacted]");
        assert_eq!(redact("OPENAI sk-AbCdEfGh1234", None), "OPENAI [redacted]");
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
    fn suggests_a_dated_file_name() {
        let name = suggested_name();
        let shape = regex::Regex::new(r"^scarlet-logs-20\d\d-[01]\d-[0-3]\d-[0-2]\d[0-5]\d\.zip$").unwrap();
        assert!(shape.is_match(&name), "{name}");
    }
}
