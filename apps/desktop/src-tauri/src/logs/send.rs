//! Sending a problem report to the Scarlet team, from where the editor saw the problem.
//!
//! The report goes to the same PostHog project as Scarlet's usage reports, as one `bug.reported` event, the moment the
//! editor presses Send: what they wrote, the error on screen, the page, the system report and the newest part of the
//! cleaned log (the same allowlist and redaction as Export logs). It is sent only when the editor asks, whether or not
//! usage reports are on. docs/telemetry.md says what is in it.

use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::State;

use super::{cleaned_logs, clip, recent_problems, redact, system_report, ReportWords};
use crate::AppState;

/// Public, write-only token for the Scarlet project in PostHog US Cloud. The same as `DEFAULT_POSTHOG_KEY` in
/// `apps/server/src/telemetry/config.ts`; a test keeps the two the same.
const DEFAULT_POSTHOG_KEY: &str = "phc_xWw7KkqDL4iYF6fd4E4bm7WDNADN2AsAd5nzDUjh8d7N";
const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";
/// PostHog takes events up to 1 MB. The newest part of the log that fits well under that goes with the report.
const LOG_TAIL_BYTES: usize = 300_000;
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// Where a report goes: the project and host the engine's usage reports use, with the same overrides.
#[derive(Debug, Clone, PartialEq)]
struct Destination {
    key: String,
    host: String,
    /// `release` only for a public package reporting with the built-in key, as the engine decides it.
    channel: &'static str,
}

fn destination(env: impl Fn(&str) -> Option<String>, release_build: bool) -> Destination {
    let set = |name: &str| env(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let supplied = set("SCARLET_POSTHOG_KEY");
    let release = release_build && supplied.is_none() && set("SCARLET_TELEMETRY_CHANNEL").map(|c| c.to_lowercase()) != Some("dev".into());
    Destination {
        key: supplied.unwrap_or_else(|| DEFAULT_POSTHOG_KEY.to_string()),
        host: set("SCARLET_POSTHOG_HOST").unwrap_or_else(|| DEFAULT_POSTHOG_HOST.to_string()).trim_end_matches('/').to_string(),
        channel: if release { "release" } else { "dev" },
    }
}

/// The install id usage reports carry: the SHA-256 of the random id in `telemetry-id`, so a report can be read beside
/// what that install did. None when the engine never made one (usage reports off from the start).
fn install_id(data_dir: &Path) -> Option<String> {
    let id = std::fs::read_to_string(data_dir.join("telemetry-id")).ok()?;
    let id = id.trim();
    let uuid = id.len() == 36 && id.bytes().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() && !c.is_ascii_uppercase() });
    uuid.then(|| Sha256::digest(id.as_bytes()).iter().map(|b| format!("{b:02x}")).collect())
}

/// The newest part of the cleaned logs, starting on a whole line, and whether anything older was left out.
fn log_tail(logs: &[(String, Result<String, String>)], max: usize) -> (String, bool) {
    let mut all = String::new();
    for (name, text) in logs {
        match text {
            Ok(events) => all.push_str(events),
            Err(e) => all.push_str(&format!("[{name} couldn't be read: {e}]\n")),
        }
    }
    if all.len() <= max {
        return (all, false);
    }
    let mut start = all.len() - max;
    while !all.is_char_boundary(start) {
        start += 1;
    }
    let start = all[start..].find('\n').map_or(start, |at| start + at + 1);
    (all[start..].to_string(), true)
}

/// The short code the editor can quote: the start of the report's id, `3F2A-91BC`.
fn reference(id: &uuid::Uuid) -> String {
    let hex = id.simple().to_string().to_uppercase();
    format!("{}-{}", &hex[..4], &hex[4..8])
}

struct Report<'a> {
    id: uuid::Uuid,
    at: String,
    install: Option<String>,
    words: &'a ReportWords,
    system: serde_json::Value,
    recent: Vec<String>,
    log: (String, bool),
}

fn payload(to: &Destination, report: &Report, token: Option<&str>) -> serde_json::Value {
    let clean = |text: String| redact(&text, token);
    let id = report.id.to_string();
    serde_json::json!({
        "api_key": to.key,
        "batch": [{
            "uuid": id,
            "event": "bug.reported",
            // A report from an install with no usage id still needs one; it is the report's own.
            "distinct_id": report.install.clone().unwrap_or_else(|| format!("report-{id}")),
            "timestamp": report.at,
            "properties": {
                "reference": reference(&report.id),
                "description": report.words.description().map(clean),
                "about": report.words.about().map(clean),
                "page": report.words.page.as_deref().map(|p| clip(p, 200)),
                "onScreen": report.words.on_screen().into_iter().map(clean).collect::<Vec<_>>(),
                "system": report.system,
                "recentProblems": report.recent,
                "log": report.log.0,
                "logTruncated": report.log.1,
                "installId": report.install,
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "scarletVersion": env!("CARGO_PKG_VERSION"),
                "channel": to.channel,
                "$process_person_profile": false,
                "$geoip_disable": true,
            },
        }],
    })
}

async fn deliver(to: &Destination, body: &serde_json::Value) -> Result<(), String> {
    let client = reqwest::Client::builder().timeout(SEND_TIMEOUT).build().map_err(|e| e.to_string())?;
    let response = client.post(format!("{}/batch/", to.host)).json(body).send().await.map_err(|e| {
        if e.is_timeout() { "The connection timed out.".to_string() } else if e.is_connect() { "Scarlet couldn't reach the internet.".to_string() } else { e.to_string() }
    })?;
    let status = response.status();
    if status.is_success() { Ok(()) } else { Err(format!("The report service answered {}.", status.as_u16())) }
}

/// What the window says once a report is sent, and the id details added later are tied to.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentReport {
    id: String,
    reference: String,
}

/// What the editor added to a report already sent with one click.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDetails {
    report_id: String,
    description: String,
}

/// Send a problem report now. Fails with a plain reason when it can't go, and the window offers to save it instead.
#[tauri::command]
pub async fn send_problem_report(state: State<'_, AppState>, report: ReportWords) -> Result<SentReport, String> {
    let to = destination(|name| std::env::var(name).ok(), option_env!("SCARLET_RELEASE_CHANNEL").is_some_and(|c| !c.is_empty()));
    send(&state, &to, report).await
}

async fn send(state: &AppState, to: &Destination, words: ReportWords) -> Result<SentReport, String> {
    let at = crate::util::now_iso();
    let (system, token) = system_report(state, &at).await;
    let system = serde_json::from_str(&redact(&system.to_string(), token.as_deref())).unwrap_or(serde_json::Value::Null);
    let (log_dir, data_dir) = (state.paths.log_dir.clone(), state.paths.data_dir.clone());
    let read_token = token.clone();
    let (recent, log, install) = tauri::async_runtime::spawn_blocking(move || {
        let logs = cleaned_logs(&log_dir, read_token.as_deref());
        (recent_problems(&logs), log_tail(&logs, LOG_TAIL_BYTES), install_id(&data_dir))
    })
    .await
    .map_err(|e| e.to_string())?;
    let report = Report { id: uuid::Uuid::new_v4(), at, install, words: &words, system, recent, log };
    let reference = reference(&report.id);
    // Never the words: they are the editor's own, and they are in the report.
    log::info!("sending problem report {reference} ({} characters written, {} log bytes)", words.description.trim().chars().count(), report.log.0.len());
    match deliver(to, &payload(to, &report, token.as_deref())).await {
        Ok(()) => {
            log::info!("problem report {reference} sent");
            Ok(SentReport { id: report.id.to_string(), reference })
        }
        Err(e) => {
            log::warn!("problem report {reference} couldn't be sent: {e}");
            Err(e)
        }
    }
}

fn details_payload(to: &Destination, report: &uuid::Uuid, description: &str, install: Option<String>, token: Option<&str>) -> serde_json::Value {
    let id = report.to_string();
    serde_json::json!({
        "api_key": to.key,
        "batch": [{
            "uuid": uuid::Uuid::new_v4().to_string(),
            "event": "bug.details",
            "distinct_id": install.clone().unwrap_or_else(|| format!("report-{id}")),
            "timestamp": crate::util::now_iso(),
            "properties": {
                "reportId": id,
                "reference": reference(report),
                "description": redact(&clip(description.trim(), super::DESCRIPTION_CHARS), token),
                "installId": install,
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "scarletVersion": env!("CARGO_PKG_VERSION"),
                "channel": to.channel,
                "$process_person_profile": false,
                "$geoip_disable": true,
            },
        }],
    })
}

/// Send what the editor added to a report already sent, tied to it by its id.
#[tauri::command]
pub async fn send_problem_details(state: State<'_, AppState>, details: ReportDetails) -> Result<(), String> {
    let to = destination(|name| std::env::var(name).ok(), option_env!("SCARLET_RELEASE_CHANNEL").is_some_and(|c| !c.is_empty()));
    let report = uuid::Uuid::parse_str(&details.report_id).map_err(|_| "That report can't be found.".to_string())?;
    if details.description.trim().is_empty() {
        return Err("Write what happened first.".into());
    }
    let token = state.engine.status().token;
    let install = install_id(&state.paths.data_dir);
    let reference = reference(&report);
    log::info!("sending details for problem report {reference} ({} characters written)", details.description.trim().chars().count());
    let sent = deliver(&to, &details_payload(&to, &report, &details.description, install, token.as_deref())).await;
    match &sent {
        Ok(()) => log::info!("details for problem report {reference} sent"),
        Err(e) => log::warn!("details for problem report {reference} couldn't be sent: {e}"),
    }
    sent
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::api::fake;

    fn words() -> ReportWords {
        ReportWords {
            description: "Export froze at 80%".into(),
            about: Some("Couldn’t finish: Claude Code stopped responding. key sk-ant-api03-AbCdEfGh1234".into()),
            page: Some("/p/prj_demo?thread".into()),
            on_screen: vec!["Couldn’t open the project".into()],
        }
    }

    fn report(words: &ReportWords) -> Report<'_> {
        Report {
            id: uuid::Uuid::parse_str("3f2a91bc-0000-4000-8000-000000000000").unwrap(),
            at: "2026-11-26T15:14:00.000Z".into(),
            install: Some("ab".repeat(32)),
            words,
            system: serde_json::json!({ "version": "test" }),
            recent: vec!["[2026-11-26][15:13:59][ERROR] [ui] [error] 15:13:59.000 +0ms uncaught".into()],
            log: ("[2026-11-26][15:13:59][INFO] [task] tsk_123456789abc running\n".into(), false),
        }
    }

    #[test]
    fn the_built_in_key_is_the_engines() {
        let config = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/src/telemetry/config.ts")).unwrap();
        assert!(config.contains(&format!("DEFAULT_POSTHOG_KEY = \"{DEFAULT_POSTHOG_KEY}\"")));
        assert!(config.contains(&format!("DEFAULT_POSTHOG_HOST = \"{DEFAULT_POSTHOG_HOST}\"")));
    }

    #[test]
    fn goes_where_usage_reports_go_with_the_same_overrides() {
        let none = |_: &str| None;
        assert_eq!(destination(none, true), Destination { key: DEFAULT_POSTHOG_KEY.into(), host: DEFAULT_POSTHOG_HOST.into(), channel: "release" });
        assert_eq!(destination(none, false).channel, "dev");
        let own = |name: &str| match name {
            "SCARLET_POSTHOG_KEY" => Some(" phc_own ".into()),
            "SCARLET_POSTHOG_HOST" => Some("http://127.0.0.1:9/".into()),
            _ => None,
        };
        assert_eq!(destination(own, true), Destination { key: "phc_own".into(), host: "http://127.0.0.1:9".into(), channel: "dev" });
        let team = |name: &str| (name == "SCARLET_TELEMETRY_CHANNEL").then(|| "DEV".to_string());
        assert_eq!(destination(team, true).channel, "dev");
    }

    #[test]
    fn carries_the_install_id_usage_reports_use_and_none_without_one() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(install_id(dir.path()), None);
        std::fs::write(dir.path().join("telemetry-id"), "0f8fad5b-d9cb-469f-a165-70867728950e\n").unwrap();
        // The engine's installId: SHA-256 of the id, in hex.
        let id = install_id(dir.path()).unwrap();
        assert_eq!(id.len(), 64);
        assert_eq!(id, Sha256::digest(b"0f8fad5b-d9cb-469f-a165-70867728950e").iter().map(|b| format!("{b:02x}")).collect::<String>());
        std::fs::write(dir.path().join("telemetry-id"), "not an id").unwrap();
        assert_eq!(install_id(dir.path()), None);
    }

    #[test]
    fn keeps_the_newest_whole_lines_of_the_log() {
        let logs = vec![("a.log".to_string(), Ok("one\ntwo\n".to_string())), ("b.log".to_string(), Err("denied".to_string())), ("c.log".to_string(), Ok("three\nfour\n".to_string()))];
        assert_eq!(log_tail(&logs, 1000), ("one\ntwo\n[b.log couldn't be read: denied]\nthree\nfour\n".to_string(), false));
        assert_eq!(log_tail(&logs, 13), ("three\nfour\n".to_string(), true));
        assert_eq!(log_tail(&[("é.log".into(), Ok("ééé\nok\n".into()))], 5), ("ok\n".to_string(), true));
    }

    #[test]
    fn the_event_holds_the_words_the_error_and_the_cleaned_log() {
        let words = words();
        let to = destination(|_| None, true);
        let body = payload(&to, &report(&words), None);
        assert_eq!(body["api_key"], DEFAULT_POSTHOG_KEY);
        let event = &body["batch"][0];
        assert_eq!(event["event"], "bug.reported");
        assert_eq!(event["uuid"], "3f2a91bc-0000-4000-8000-000000000000");
        assert_eq!(event["distinct_id"], "ab".repeat(32));
        let p = &event["properties"];
        assert_eq!(p["reference"], "3F2A-91BC");
        assert_eq!(p["description"], "Export froze at 80%");
        assert_eq!(p["about"], "Couldn’t finish: Claude Code stopped responding. key [redacted]");
        assert_eq!(p["page"], "/p/prj_demo?thread");
        assert_eq!(p["onScreen"], serde_json::json!(["Couldn’t open the project"]));
        assert_eq!(p["recentProblems"][0], "[2026-11-26][15:13:59][ERROR] [ui] [error] 15:13:59.000 +0ms uncaught");
        assert!(p["log"].as_str().unwrap().contains("tsk_123456789abc running"));
        assert_eq!(p["channel"], "release");
        assert_eq!(p["$process_person_profile"], false);
        assert_eq!(p["$geoip_disable"], true);
        // Without a usage id, the report has an id of its own.
        let mut alone = report(&words);
        alone.install = None;
        assert_eq!(payload(&to, &alone, None)["batch"][0]["distinct_id"], "report-3f2a91bc-0000-4000-8000-000000000000");
    }

    #[test]
    fn details_are_tied_to_the_report_they_add_to() {
        let to = destination(|_| None, false);
        let id = uuid::Uuid::parse_str("3f2a91bc-0000-4000-8000-000000000000").unwrap();
        let body = details_payload(&to, &id, "  I pressed Export twice. key sk-ant-api03-AbCdEfGh1234 ", None, None);
        let event = &body["batch"][0];
        assert_eq!(event["event"], "bug.details");
        assert_ne!(event["uuid"], "3f2a91bc-0000-4000-8000-000000000000");
        assert_eq!(event["distinct_id"], "report-3f2a91bc-0000-4000-8000-000000000000");
        let p = &event["properties"];
        assert_eq!(p["reportId"], "3f2a91bc-0000-4000-8000-000000000000");
        assert_eq!(p["reference"], "3F2A-91BC");
        assert_eq!(p["description"], "I pressed Export twice. key [redacted]");
        assert_eq!(p["channel"], "dev");
    }

    #[tokio::test]
    async fn posts_the_report_and_says_why_it_couldnt() {
        let host = fake::engine(|route, _| match route {
            "POST /batch/" => (200, r#"{"status":"Ok"}"#.into()),
            _ => (404, String::new()),
        })
        .await;
        let to = Destination { key: "phc_test".into(), host: host.url.clone(), channel: "dev" };
        let words = words();
        deliver(&to, &payload(&to, &report(&words), None)).await.unwrap();
        let sent = host.bodies("POST /batch/");
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["batch"][0]["properties"]["description"], "Export froze at 80%");
        let refused = fake::engine(|_, _| (413, String::new())).await;
        let to = Destination { host: refused.url.clone(), ..to };
        assert_eq!(deliver(&to, &serde_json::json!({})).await.unwrap_err(), "The report service answered 413.");
        let gone = format!("http://{}", std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap());
        assert_eq!(deliver(&Destination { host: gone, ..to }, &serde_json::json!({})).await.unwrap_err(), "Scarlet couldn't reach the internet.");
    }
}
