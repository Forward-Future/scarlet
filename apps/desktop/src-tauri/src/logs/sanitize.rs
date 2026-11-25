//! Privacy-preserving redaction and allowlist filtering for exported support logs.

use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::Regex;

/// Replace the engine token and anything shaped like one, in case a log line ever carried it.
pub(super) fn redact(text: &str, token: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(t) = token.filter(|t| t.len() >= 8) {
        out = out.replace(t, "[redacted]");
    }
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(sct|sk|sk-ant|ghp|gho)[_-][A-Za-z0-9_\-]{8,}").expect("valid regex"));
    PATTERN.replace_all(&out, "[redacted]").into_owned()
}

/// Private values are quoted by the renderer. Tokenize whole fields so a field-looking word inside
/// a label or error message can never be exported as operational metadata.
fn write_fields(out: &mut String, fields: &str) {
    let mut start = 0;
    let (mut quoted, mut escaped, mut depth) = (false, false, 0usize);
    for (i, byte) in fields.bytes().chain(*b" ").enumerate() {
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
                            let _ = write!(out, " {key}={value}");
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
    static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9_-]{0,47}$").unwrap());
    static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$").unwrap());
    let safe = match key {
        "path" | "route" | "to" | "from" => {
            if value.starts_with('/') { return support_path(value); }
            numeric(value) || (key == "route" && value == "unmatched") || (key == "to" && matches!(value, "edit" | "call"))
                // A task's state change (`[task] state from=queued to=claimed`).
                || (matches!(key, "to" | "from") && log_state(value))
        }
        "request" | "import" => request_id(value),
        "task" | "project" | "media" | "render" | "change" | "host" | "blocker" | "thread" | "question" | "note" | "retryOf" =>
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
            "repeated_cursor" | "timed_out" | "process_failed" | "incomplete_response" |
            // Why a press of send, a recording or an undo did nothing (`[ui] [request]`, `[voice]`, `[action]`).
            "empty" | "slash-only" | "time-only" | "still-sending" | "listening" | "no-model" | "no-question" | "busy" |
            "unsupported" | "send" | "discard" | "cap" | "too-short" | "before-start" | "unmount" | "failed"),
        // A key by its name and modifiers ("Escape", "mod+z", "alt+x"), never a typed character run.
        "key" => value.len() <= 24 && value.split('+').all(|part| WORD.is_match(part)),
        "provider" => matches!(value, "claude" | "codex" | "gemini" | "ollama" | "lmstudio" | "openrouter" | "api" | "whispercpp" | "openai"),
        "control" => matches!(value,
            "transcript-word" | "send-request" | "save-queued-request" | "approve-call" | "skip-call" | "revise-call" |
            "toggle-transcript" | "toggle-before" | "undo-edit" | "revise-edit" | "keep-edit" | "mark-done" | "apply-edit" |
            "export" | "reveal-export" | "open-pass-item" | "open-edit" | "button" | "a" | "tab" | "option" | "menuitem" |
            "menuitemradio" | "switch" | "checkbox" | "radio" | "summary" | "input" | "select" | "textarea" | "label" | "video"),
        "cmd" | "operation" | "code" | "stage" | "phase" | "origin" | "event" | "outcome" | "failure" |
        "tool" | "lane" | "work" | "blocker_work" | "kind" | "choice" | "encoder" | "format" | "how" | "dest" | "aim" | "via" | "did" =>
            WORD.is_match(value) || numeric(value),
        "range" | "buf" | "between" | "loop" | "ready" | "staged" | "loading" | "approvedCuts" | "skippedCuts" | "clearedCuts" if value.starts_with('[') =>
            value.len() <= 120 && value.bytes().all(|c| c.is_ascii_digit() || b"[].,-".contains(&c)),
        "frames" => numeric(value) || value.split_once('/').is_some_and(|(a, b)| numeric(a) && numeric(b)),
        "clean" | "paused" | "seeking" | "muted" | "playing" | "flagged" | "repeat" | "hidden" | "first" | "have" | "legacy" | "resumed" |
        "voice" | "queuedOnly" =>
            matches!(value, "true" | "false") || numeric(value),
        "elapsedMs" | "wait_ms" | "elapsed_ms" | "evidenceMisses" | "ms" | "unlogged" | "count" | "status" | "exitCode" | "signal" | "pid" |
        "changes" | "left" | "cut" | "call" | "edit" | "of" | "at" | "across" | "ahead" | "blocked" | "remaining" | "attempts" |
        "approved" | "skipped" | "cleared" | "startByte" | "endByte" | "readBytes" | "expectedBytes" | "bytes" |
        "width" | "height" | "scale" | "ready" | "net" | "t" | "for" | "after" | "offset" | "duration" | "start" |
        "section" | "sections" | "appending" | "frame" | "files" | "links" | "uploads" | "interruptions" | "replay" | "matched" |
        "raw_os_error" | "waited" | "vol" | "rate" | "adec" | "vdec" | "reset" | "chars" | "marks" | "otherDrafts" | "seconds" |
        "recordings" | "end" => numeric(value),
        _ => false,
    };
    safe.then(|| value.to_owned())
}

/// Export operational fields only. Legacy messages use fixed prefixes, and quoted messages, user
/// text, paths and stack traces stay in the local log.
pub(super) fn support_log(text: &str) -> String {
    static PATTERNS: LazyLock<[Regex; 8]> = LazyLock::new(|| [
        r"^(\[\d{4}-\d\d-\d\d\]\[\d\d:\d\d:\d\d\])\[[\w:.-]+\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\] (.*)$",
        r"^\[engine\] \[(activity|align|audio|cleanup|dialogue|dialogue-scan|edit|error|http|ingest|inspection|lifecycle|graphics|log|mcp|media|model|models|project|render|review|skills|speakers|storage|task|transcribe|transfer|trash|voice-note|whisper|ws)\] (.*)$",
        r"^((?:tsk|med|prj|rnd|chg)_[a-z0-9]{12}|chg_[a-f0-9]{64}_(?:applied|review))\b(?: (queued|claimed|running|waiting_for_user|done|failed|cancelled|approved|rejected|ready|ingesting|started|interrupted|revising)\b)?(?: → (running|waiting_for_user|queued|ready|approved|rejected|failed|revising)\b)?(?: after (\d+(?:ms|s|m|h)(?: \d+[sm])?))?",
        r"^(slow request: )?(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\S+) → (\d{3}) (?:in|after) (\d+(?:ms|s|m|h)(?: \d+[sm])?)\b(.*)$",
        r"^\[ui\] \[(app|nav|action|api|realtime|playback|window|error|import|review|request|voice|marks|timeline|export)\] (\d\d:\d\d:\d\d\.\d{3} \+\d+ms) ([a-zA-Z0-9_.-]{1,40})\b(.*)$",
        r"^([a-z][a-z0-9_-]{0,47})(?: +|$)(.*)$",
        r"^a client disconnected with code (\d{1,4}) \((\d+) open\)$",
        r"^\[(desktop|host|update|export)\] (.*)$",
    ].map(|pattern| Regex::new(pattern).expect("valid support log pattern")));
    let [record_pattern, engine_pattern, entity_pattern, http_pattern, ui_pattern, event_pattern, ws_closed, native_pattern] = &*PATTERNS;
    let mut out = String::new();
    for line in text.lines() {
        let Some(record) = record_pattern.captures(line) else { continue };
        let message = &record[3];
        let _ = write!(out, "{}[{}] ", &record[1], &record[2]);
        if let Some(ui) = ui_pattern.captures(message) {
            let (event, mut fields) = (&ui[3], &ui[4]);
            let _ = write!(out, "[ui] [{}] {} {event}", &ui[1], &ui[2]);
            if matches!(event, "stream" | "transport" | "timeline" | "monitor" | "source") {
                let candidate = fields.trim_start();
                let word = candidate.split(' ').next().unwrap_or("");
                if !word.is_empty() && word.len() <= 40 && word.bytes().all(|c| c.is_ascii_lowercase() || c == b'-') {
                    let _ = write!(out, " {word}");
                    fields = &candidate[word.len()..];
                }
            }
            write_fields(&mut out, fields);
        } else if let Some(engine) = engine_pattern.captures(message) {
            let (component, detail) = (&engine[1], &engine[2]);
            let _ = write!(out, "[{component}]");
            if let Some(http) = (component == "http").then(|| http_pattern.captures(detail)).flatten() {
                let _ = write!(out, " {} {} in {}", &http[2], &http[4], &http[5]);
                if http.get(1).is_some() { out.push_str(" slow=true"); }
                let fields = http[6].split(": ").next().unwrap_or("");
                write_fields(&mut out, fields);
                let raw_path = &http[3];
                let has_entity = raw_path.split(['?', '#']).next().is_some_and(|path| path.split('/').any(entity_id));
                if has_entity || !fields.contains(" route=") || fields.contains(" route=unmatched") {
                    if let Some(path) = support_path(raw_path) { let _ = write!(out, " path={path}"); }
                }
            } else if let Some(entity) = entity_pattern.find(detail) {
                let _ = write!(out, " {}", entity.as_str());
            } else if let Some(event) = event_pattern.captures(detail).filter(|e| e[2].split_whitespace().next().is_some_and(|f| f.contains('='))) {
                let _ = write!(out, " {}", &event[1]);
                write_fields(&mut out, &event[2]);
            } else if component == "ws" {
                if let Some(code) = ws_closed.captures(detail) {
                    let _ = write!(out, " disconnected code={} count={}", &code[1], &code[2]);
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
            let _ = write!(out, "[{}]", &native[1]);
            if let Some(event) = event_pattern.captures(&native[2]) {
                let _ = write!(out, " {}", &event[1]);
                write_fields(&mut out, &event[2]);
            }
        } else if let Some(task) = message.strip_prefix("task ") {
            out.push_str("[host]");
            if let Some(entity) = entity_pattern.find(task) { let _ = write!(out, " {}", entity.as_str()); }
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

pub(super) fn support_settings(text: &str) -> Option<serde_json::Value> {
    let config: crate::config::AppConfig = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    Some(serde_json::json!({
        "timeoutMinutes": config.timeout_minutes, "stallMinutes": config.stall_minutes, "maxParallel": config.max_parallel
    }))
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
    fn exports_the_correlated_outcome_without_labels_credentials_or_file_paths() {
        let request = "992e35e1-058b-4c25-9996-172afb4916e9";
        let task = "tsk_123456789abc";
        let raw = [
            "[ui] [playback] 02:03:04.321 +8ms stream load id=s1 section=2 range=[30,45]".to_string(),
            "[ui] [playback] 02:03:04.421 +100ms stream append id=s1 section=2 bytes=1920".to_string(),
            r#"[ui] [playback] 02:03:04.521 +100ms stream failed id=s1 error="rain on the set \" phase=private cue" paused=true"#.to_string(),
            r#"[ui] [action] 02:03:04.532 +3ms click on="Someone's words control=hidden" control=approve-call"#.to_string(),
            format!("[engine] [http] slow request: POST /api/projects/secret-folder/renders?token=secret → 504 after 31s request={request} route=/api/projects/:id/renders code=bad_range: bad_range: the user's private text"),
            format!("[engine] [transfer] file-read request={request} route=/api/renders/:renderId/file outcome=failed expectedBytes=400 readBytes=240 code=EIO"),
            format!("[engine] [mcp] tool-finished task={task} attempt=2026-11-05T02:03:04.532Z tool=transcript_search outcome=degraded elapsedMs=450 evidenceMisses=1"),
            "[engine] [audio] waiting work=transcript media=med_123456789abc lane=audio wait_ms=1000".to_string(),
            "[engine] [ws] a client disconnected with code 1006 (0 open)".into(),
            r#"[ui] [request] 02:03:04.600 +5ms send-failed how=typed dest=new-edit chars=36 aim=whole project=prj_123456789abc name=TypeError error="Couldn't reach the private engine""#.to_string(),
            "[ui] [request] 02:03:04.700 +5ms send-ignored reason=time-only how=typed chars=4".into(),
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
            "[ui] [request] 02:03:04.600 +5ms send-failed how=typed dest=new-edit chars=36 aim=whole project=prj_123456789abc name=TypeError",
            "send-ignored reason=time-only how=typed chars=4",
        ] {
            assert!(safe.contains(expected), "missing {expected:?} in {safe}");
        }
        assert_eq!(safe.matches(request).count(), 2);
        for private in ["rain", "hidden", "private", "secret", "user content", "Someone's words"] {
            assert!(!safe.contains(private), "unexpected {private:?} in {safe}");
        }
    }

    #[test]
    fn exports_only_recognized_diagnostic_settings_from_older_desktop_configs() {
        let old = r#"{"teamToken":"opaque fixture credential","serverUrl":"private address","hostIds":{"private address":"private host"},"maxParallel":3,"stallMinutes":10,"nested":{"key":"secret"}}"#;
        let settings = support_settings(old).unwrap();
        assert_eq!(settings, serde_json::json!({"timeoutMinutes": null, "stallMinutes": 10, "maxParallel": 3}));
        assert!(support_settings("invalid configuration").is_none());
    }
}
