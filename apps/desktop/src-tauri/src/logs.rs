//! "Export logs…" (Settings → Advanced): one .zip a tester can send to whoever is helping them.
//! It holds the log folder and a short system report. No media, projects or database.

use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use tauri::{AppHandle, State};

use crate::AppState;

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

/// Private values are quoted by the renderer. Tokenize whole fields so a field-looking word inside
/// a label or error message can never be exported as operational metadata.
fn write_fields(out: &mut String, fields: &str) {
    let mut start = 0;
    let (mut quoted, mut escaped, mut depth) = (false, false, 0usize);
    for (i, byte) in fields.bytes().chain([b' ']).enumerate() {
        if quoted {
            if escaped { escaped = false; }
            else if byte == b'\\' { escaped = true; }
            else if byte == b'"' { quoted = false; }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => depth += 1,
                b']' | b'}' => depth = depth.saturating_sub(1),
                b' ' if depth == 0 => {
                    if let Some((key, value)) = fields[start..i].split_once('=') {
                        if let Some(value) = support_field(key, value) {
                            out.push_str(&format!(" {key}={value}"));
                        }
                    }
                    start = i + 1;
                }
                _ => {}
            }
        }
    }
}

fn numeric(value: &str) -> bool {
    value.len() <= 24 && value.parse::<f64>().is_ok_and(f64::is_finite)
}

fn entity_id(value: &str) -> bool {
    let id = value.split(':').next().unwrap_or("");
    let Some((kind, suffix)) = id.split_once('_') else { return false };
    let generated = matches!(kind, "tsk" | "med" | "prj" | "rnd" | "chg" | "host" | "evt" | "nt" | "att" | "imp" | "thr")
        && suffix.len() == 12 && suffix.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let dialogue = kind == "chg" && suffix.split_once('_').is_some_and(|(hash, role)| {
        hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            && matches!(role, "applied" | "review")
    });
    (generated || dialogue) && (id == value || log_state(value.strip_prefix(id).unwrap_or("").trim_start_matches(':')))
}

fn log_state(value: &str) -> bool {
    matches!(value, "queued" | "claimed" | "running" | "waiting_for_user" | "done" | "failed" | "cancelled" |
        "approved" | "rejected" | "ready" | "ingesting" | "started" | "interrupted" | "revising" | "unknown")
}

fn request_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i, c)| {
        if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() }
    })
}

/// Only route vocabulary and narrowly shaped generated IDs cross the support boundary. The query
/// and fragment can hold filenames or credentials. A dynamic or unknown path segment becomes a slot.
fn support_path(value: &str) -> Option<String> {
    let value = value.split(['?', '#']).next()?;
    if !value.starts_with('/') || value.starts_with("//") || value.len() > 512 { return None; }
    let parts = value.split('/').skip(1).filter(|part| !part.is_empty()).map(|part| {
        if entity_id(part) || matches!(part,
            "api" | "p" | "project" | "projects" | "settings" | "storage" | "usage" | "auth" | "me" | "hosts" |
            "register" | "heartbeat" | "claim" | "task" | "tasks" | "prompt" | "events" | "answer" | "question" |
            "complete" | "cancel" | "retry" | "reword" | "hold" | "start-now" | "continue-when-ready" | "repeat-audit" |
            "usage-snapshot" | "media" | "prepare" | "proxy" | "playback-cache" | "playback-caches" | "prepare-playback" |
            "cut-playback-file" | "preview" | "transcribe" | "transcript" | "realign" | "voice-roles" | "waveform" |
            "loudness" | "other-input" | "retakes" | "faces" | "screen-text" | "frame" | "filmstrip" | "renders" | "owners" |
            "file" | "import" | "import-frame" | "otio" | "export.otio" | "handoff" | "exports" | "learn" | "learnings" |
            "versions" | "branches" | "checkout" | "timeline" | "diff" | "changes" | "approve" | "unapprove" | "reject" |
            "reopen" | "revise" | "cut-choices" | "cut-review" | "cut-assessments" | "staged-cuts" | "notes" | "reply" | "voice" |
            "review-cut" | "review-decisions" | "threads" | "disposition" | "edits" | "edit-reviews" | "edit-flags" | "activity" |
            "contact-sheet" | "source-audio" | "sound-picture" | "picture-activity" | "dialogue-scan" | "dialogue-detections" |
            "dialogue-acoustic-words" | "dialogue-cuts" | "dialogue-checkpoints" | "restore" | "trash" | "cleanup" | "under-way" |
            "attachments" | "graphics" | "templates" | "documents" | "read" | "style-guide" | "speech" |
            "decline" | "skills" | "skill" | "skill-edit" | "from-change" | "local-model" | "tool-diagnostic" | "health" | "ws" |
            ":id" | ":projectId" | ":taskId" | ":changeId" | ":mediaId" | ":attachmentId" | ":noteId" | ":version" | ":v" |
            ":renderId" | ":owner" | ":hostId" | ":index" | ":threadId" | ":skillId" | ":templateId" | ":learningId" | ":a" | ":b") {
            part
        } else { ":value" }
    }).collect::<Vec<_>>();
    Some(format!("/{}", parts.join("/")))
}

fn support_field(key: &str, value: &str) -> Option<String> {
    static WORD: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_-]{0,47}$").unwrap());
    static TIME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$").unwrap());
    let safe = match key {
        "path" | "route" | "to" | "from" => {
            if value.starts_with('/') { return support_path(value); }
            numeric(value) || (key == "route" && value == "unmatched") || (key == "to" && matches!(value, "edit" | "call"))
        }
        "request" => request_id(value),
        "import" => request_id(value),
        "task" | "project" | "media" | "render" | "change" | "host" | "blocker" | "thread" =>
            entity_id(value) || matches!(value, "unknown" | "none"),
        "id" | "el" => entity_id(value) || (value.len() <= 9 && matches!(value.as_bytes().first(), Some(b'v' | b's')) && value[1..].bytes().all(|c| c.is_ascii_digit())),
        "attempt" => numeric(value) || TIME.is_match(value) || value == "unknown",
        "version" | "revision" => value.len() >= 7 && value.len() <= 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
            || value.len() <= 20 && value.split('.').count() == 3 && value.split('.').all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())),
        "method" => matches!(value, "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"),
        "state" => log_state(value) || matches!(value, "idle" | "loading" | "offline"),
        "requested" => log_state(value),
        "name" => matches!(value, "Error" | "AbortError" | "DataError" | "EncodingError" | "EvalError" | "IndexSizeError" |
            "InvalidAccessError" | "InvalidStateError" | "NetworkError" | "NotAllowedError" | "NotFoundError" | "NotReadableError" |
            "NotSupportedError" | "OperationError" | "QuotaExceededError" | "RangeError" | "ReferenceError" | "SecurityError" |
            "SyntaxError" | "TimeoutError" | "TypeError" | "UnknownError" | "ValidationError" | "ScarletApiError" | "unknown" |
            "InvalidShape" | "InvalidEntry" | "invalid-json" | "invalid-entries" | "invalid-record"),
        "reason" => matches!(value,
            "active_run" | "api_key" | "app_server_unavailable" | "auth_unavailable" | "branch_changed" | "cached_preview" |
            "capability" | "connect" | "cut_changed" | "decode_retry" | "earlier_request" | "editor" | "engine_stopped" |
            "higher_priority" | "home_unavailable" | "initialize_failed" | "invalid_reply" | "invalid_status" | "isolation_unavailable" |
            "media-error" | "media_paused" | "media_stopped" | "missing-entry" | "new_call" | "no-picture" | "out-of-range" |
            "project_config" | "project_unavailable" | "question" | "read" | "retry-limit" | "review" | "revision" | "rewording" |
            "shutdown" | "stale" | "thread_policy_mismatch" | "thread_start_failed" | "timeout" | "transcripts" | "unsettled" |
            "viewer_gone" | "worker_gone" | "worker_lost" | "write" | "cli_unavailable" | "request_failed" | "invalid_response" |
            "repeated_cursor" | "timed_out" | "process_failed" | "incomplete_response"),
        "provider" => matches!(value, "claude" | "codex" | "gemini" | "api" | "whispercpp" | "openai"),
        "control" => matches!(value,
            "transcript-word" | "send-request" | "save-queued-request" | "approve-call" | "skip-call" | "revise-call" |
            "toggle-transcript" | "toggle-before" | "undo-edit" | "revise-edit" | "keep-edit" | "mark-done" | "apply-edit" |
            "export" | "reveal-export" | "open-pass-item" | "open-edit" | "button" | "a" | "tab" | "option" | "menuitem" |
            "menuitemradio" | "switch" | "checkbox" | "radio" | "summary" | "input" | "select" | "textarea" | "label" | "video"),
        "cmd" | "operation" | "code" | "stage" | "phase" | "origin" | "event" | "outcome" | "failure" |
        "tool" | "lane" | "work" | "blocker_work" | "kind" | "choice" | "encoder" | "format" => WORD.is_match(value) || numeric(value),
        "range" | "buf" | "between" | "loop" | "ready" | "staged" | "loading" | "approvedCuts" | "skippedCuts" | "clearedCuts" if value.starts_with('[') =>
            value.len() <= 120 && value.bytes().all(|c| c.is_ascii_digit() || b"[].,-".contains(&c)),
        "frames" => numeric(value) || value.split_once('/').is_some_and(|(a, b)| numeric(a) && numeric(b)),
        "clean" | "paused" | "seeking" | "muted" | "playing" | "flagged" | "repeat" | "hidden" | "first" | "have" | "legacy" | "resumed" =>
            matches!(value, "true" | "false") || numeric(value),
        "elapsedMs" | "wait_ms" | "elapsed_ms" | "evidenceMisses" | "ms" | "unlogged" | "count" | "status" | "exitCode" | "signal" | "pid" |
        "changes" | "left" | "cut" | "call" | "edit" | "of" | "at" | "across" | "ahead" | "blocked" | "remaining" | "attempts" |
        "approved" | "skipped" | "cleared" | "startByte" | "endByte" | "readBytes" | "expectedBytes" | "bytes" |
        "width" | "height" | "scale" | "ready" | "net" | "t" | "for" | "after" | "offset" | "duration" | "start" |
        "section" | "sections" | "appending" | "frame" | "files" | "links" | "uploads" | "interruptions" | "replay" | "matched" |
        "raw_os_error" | "waited" | "vol" | "rate" | "adec" | "vdec" | "reset" => numeric(value),
        _ => false,
    };
    safe.then(|| value.to_owned())
}

/// Export operational fields only. Legacy messages use fixed prefixes, and quoted messages, user
/// text, paths and stack traces stay in the local log.
fn support_log(text: &str) -> String {
    use regex::Regex;
    static PATTERNS: std::sync::LazyLock<[Regex; 8]> = std::sync::LazyLock::new(|| [
        r"^(\[\d{4}-\d\d-\d\d\]\[\d\d:\d\d:\d\d\])\[[\w:.-]+\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\] (.*)$",
        r"^\[engine\] \[(activity|align|audio|cleanup|dialogue|dialogue-scan|edit|error|http|ingest|inspection|log|mcp|media|model|models|project|render|review|skills|speakers|storage|task|transcribe|transfer|trash|voice-note|whisper|ws)\] (.*)$",
        r"^((?:tsk|med|prj|rnd|chg)_[a-z0-9]{12}|chg_[a-f0-9]{64}_(?:applied|review))\b(?: (queued|claimed|running|waiting_for_user|done|failed|cancelled|approved|rejected|ready|ingesting|started|interrupted|revising)\b)?(?: → (running|waiting_for_user|queued|ready|approved|rejected|failed|revising)\b)?(?: after (\d+(?:ms|s|m|h)(?: \d+[sm])?))?",
        r"^(slow request: )?(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\S+) → (\d{3}) (?:in|after) (\d+(?:ms|s|m|h)(?: \d+[sm])?)\b(.*)$",
        r"^\[ui\] \[(app|nav|action|api|realtime|playback|window|error|import|review)\] (\d\d:\d\d:\d\d\.\d{3} \+\d+ms) ([a-zA-Z0-9_.-]{1,40})\b(.*)$",
        r"^([a-z][a-z0-9_-]{0,47})(?: +|$)(.*)$",
        r"^a client disconnected with code (\d{1,4}) \((\d+) open\)$",
        r"^\[(desktop|host|update|export)\] (.*)$",
    ].map(|pattern| Regex::new(pattern).expect("valid support log pattern")));
    let [record_pattern, engine_pattern, entity_pattern, http_pattern, ui_pattern, event_pattern, ws_closed, native_pattern] = &*PATTERNS;
    let mut out = String::new();
    for line in text.lines() {
        let Some(record) = record_pattern.captures(line) else { continue };
        let message = &record[3];
        out.push_str(&format!("{}[{}] ", &record[1], &record[2]));
        if let Some(ui) = ui_pattern.captures(message) {
            let (event, mut fields) = (&ui[3], &ui[4]);
            out.push_str(&format!("[ui] [{}] {} {event}", &ui[1], &ui[2]));
            if matches!(event, "stream" | "transport" | "timeline" | "monitor" | "source") {
                let candidate = fields.trim_start();
                let word = candidate.split(' ').next().unwrap_or("");
                if !word.is_empty() && word.len() <= 40 && word.bytes().all(|c| c.is_ascii_lowercase() || c == b'-') {
                    out.push_str(&format!(" {word}"));
                    fields = &candidate[word.len()..];
                }
            }
            write_fields(&mut out, fields);
        } else if let Some(engine) = engine_pattern.captures(message) {
            let (component, detail) = (&engine[1], &engine[2]);
            out.push_str(&format!("[{component}]"));
            if let Some(http) = (component == "http").then(|| http_pattern.captures(detail)).flatten() {
                out.push_str(&format!(" {} {} in {}", &http[2], &http[4], &http[5]));
                if http.get(1).is_some() { out.push_str(" slow=true"); }
                let fields = http[6].split(": ").next().unwrap_or("");
                write_fields(&mut out, fields);
                let raw_path = &http[3];
                let has_entity = raw_path.split(['?', '#']).next().is_some_and(|path| path.split('/').any(entity_id));
                if has_entity || !fields.contains(" route=") || fields.contains(" route=unmatched") {
                    if let Some(path) = support_path(raw_path) { out.push_str(&format!(" path={path}")); }
                }
            } else if let Some(entity) = entity_pattern.find(detail) {
                out.push_str(&format!(" {}", entity.as_str()));
            } else if let Some(event) = event_pattern.captures(detail).filter(|e| e[2].split_whitespace().next().is_some_and(|f| f.contains('='))) {
                out.push_str(&format!(" {}", &event[1]));
                write_fields(&mut out, &event[2]);
            } else if component == "ws" {
                if let Some(code) = ws_closed.captures(detail) {
                    out.push_str(&format!(" disconnected code={} count={}", &code[1], &code[2]));
                } else if detail.starts_with("refused a connection:") { out.push_str(" refused"); }
                else if detail.starts_with("a client stopped answering") { out.push_str(" heartbeat-timeout"); }
                else if detail.starts_with("a client connected (") { out.push_str(" connected"); }
                else if detail.starts_with("a client’s connection failed:") { out.push_str(" connection-failed"); }
                else if detail.starts_with("dropped a connection:") { out.push_str(" dropped"); }
            } else if component == "whisper" {
                if detail.starts_with("A run failed on the GPU build") { out.push_str(" cpu-fallback"); }
                else if detail.starts_with("That run finished on the CPU build") { out.push_str(" cpu-fallback-finished"); }
            } else if component == "error" {
                if detail.starts_with("engine stopped on an uncaught error:") { out.push_str(" uncaught"); }
                else if detail.starts_with("engine stopped on an unhandled rejection:") { out.push_str(" unhandled-rejection"); }
            }
        } else if let Some(native) = native_pattern.captures(message) {
            out.push_str(&format!("[{}]", &native[1]));
            if let Some(event) = event_pattern.captures(&native[2]) {
                out.push_str(&format!(" {}", &event[1]));
                write_fields(&mut out, &event[2]);
            }
        } else if let Some(task) = message.strip_prefix("task ") {
            out.push_str("[host]");
            if let Some(entity) = entity_pattern.find(task) { out.push_str(&format!(" {}", entity.as_str())); }
        } else {
            out.push_str(match message {
                m if m.starts_with("panic:") => "[desktop] panic",
                m if m.starts_with("[ui] startup failed:") => "[ui] [app] startup-failed",
                m if m.starts_with("[ui] uncaught error:") => "[ui] [error] uncaught",
                m if m.starts_with("[ui] unhandled rejection:") => "[ui] [error] unhandled-rejection",
                m if m.starts_with("[engine]") => "[engine]",
                _ => "[desktop]",
            });
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
        let (y, mo, d, h, mi, s) = crate::util::civil_from_unix(crate::util::unix_now().as_secs() as i64);
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
        assert!(old.contains("[host] tsk_123456789abc") && old.contains("[ui] [error] 02:03:04.123 +2ms alert"));
        assert!(!old.contains("private") && !old.contains("historical request"));
        let mut crc = Crc::new();
        crc.update(text.as_bytes());
        assert_eq!(u32::from_le_bytes(bytes[at + 14..at + 18].try_into().unwrap()), crc.sum());
    }

    #[test]
    fn exports_the_correlated_outcome_without_labels_credentials_or_file_paths() {
        let request = "992e35e1-058b-4c25-9996-172afb4916e9";
        let task = "tsk_123456789abc";
        let raw = [
            format!("[ui] [playback] 02:03:04.321 +8ms stream load id=s1 section=2 range=[30,45]"),
            format!("[ui] [playback] 02:03:04.421 +100ms stream append id=s1 section=2 bytes=1920"),
            format!(r#"[ui] [playback] 02:03:04.521 +100ms stream failed id=s1 error="rain on the set \" phase=private cue" paused=true"#),
            format!(r#"[ui] [action] 02:03:04.532 +3ms click on="Someone's words control=hidden" control=approve-call"#),
            format!("[engine] [http] slow request: POST /api/projects/secret-folder/renders?token=secret → 504 after 31s request={request} route=/api/projects/:id/renders code=bad_range: bad_range: the user's private text"),
            format!("[engine] [transfer] file-read request={request} route=/api/renders/:renderId/file outcome=failed expectedBytes=400 readBytes=240 code=EIO"),
            format!("[engine] [mcp] tool-finished task={task} attempt=2026-11-05T02:03:04.532Z tool=transcript_search outcome=degraded elapsedMs=450 evidenceMisses=1"),
            format!("[engine] [audio] waiting work=transcript media=med_123456789abc lane=audio wait_ms=1000"),
            "[engine] [ws] a client disconnected with code 1006 (0 open)".into(),
            "panic: user content".into(),
            "[ui] startup failed: private text".into(),
        ].map(|line| format!("{RECORD} {line}\n")).concat();
        let safe = support_log(&raw);
        for expected in [
            "stream load id=s1 section=2 range=[30,45]", "stream append id=s1 section=2 bytes=1920", "stream failed id=s1 paused=true",
            "click control=approve-call", "POST 504 in 31s slow=true request=", "route=/api/projects/:id/renders code=bad_range",
            "route=/api/renders/:renderId/file outcome=failed expectedBytes=400 readBytes=240 code=EIO",
            "tool=transcript_search outcome=degraded elapsedMs=450 evidenceMisses=1", "[audio] waiting work=transcript", "[ws] disconnected code=1006 count=0",
            "[desktop] panic", "[ui] [app] startup-failed",
        ] {
            assert!(safe.contains(expected), "missing {expected:?} in {safe}");
        }
        assert_eq!(safe.matches(request).count(), 2);
        for private in ["rain", "hidden", "private", "secret", "user content", "Someone's words"] {
            assert!(!safe.contains(private), "unexpected {private:?} in {safe}");
        }
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
        assert!(entry(&bytes, "README.txt").contains("engine and CLI status"));
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
        assert!(entry(&bytes, "logs/scarlet-desktop.log").ends_with("[http] GET 200 in 1ms path=/api/projects\n"));
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
