//! Minimal typed client for the Scarlet HTTP API (the routes the host uses).

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::usage::AgentUsage;
use super::types::{AgentAvailability, AgentHost, CompleteTaskRequest, Task, TaskEvent, TaskPrompt, TaskWithEvents};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "{} ({} {})", self.message, self.code, s),
            None => write!(f, "{}", self.message),
        }
    }
}
impl std::error::Error for ApiError {}

impl ApiError {
    pub fn is_status(&self, s: u16) -> bool {
        self.status == Some(s)
    }
}

#[derive(Clone)]
pub struct Api {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl Api {
    pub fn new(base_url: &str, token: Option<&str>) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("reqwest client");
        Api { http, base: base_url.trim_end_matches('/').to_string(), token: token.map(str::to_string) }
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}/api{}", self.base, path)
    }

    pub fn ws_url(&self) -> String {
        let mut u = self.base.clone();
        if let Some(rest) = u.strip_prefix("https://") {
            u = format!("wss://{rest}");
        } else if let Some(rest) = u.strip_prefix("http://") {
            u = format!("ws://{rest}");
        }
        // Keep only the origin.
        if let Ok(parsed) = url::Url::parse(&u) {
            u = parsed.origin().ascii_serialization();
        }
        match &self.token {
            Some(t) => format!("{u}/ws?token={}", urlencode(t)),
            None => format!("{u}/ws"),
        }
    }

    async fn request<T: DeserializeOwned>(&self, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Option<Duration>) -> Result<T, ApiError> {
        let mut req = self.http.request(method, self.url(path));
        if let Some(t) = &self.token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        let res = req.send().await.map_err(|e| ApiError { status: None, code: "network_error".into(), message: e.to_string() })?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            #[derive(Deserialize)]
            struct ErrBody {
                error: Option<ErrInner>,
            }
            #[derive(Deserialize)]
            struct ErrInner {
                code: Option<String>,
                message: Option<String>,
            }
            let parsed: Option<ErrBody> = serde_json::from_str(&text).ok();
            let inner = parsed.and_then(|p| p.error);
            return Err(ApiError {
                status: Some(status.as_u16()),
                code: inner.as_ref().and_then(|e| e.code.clone()).unwrap_or_else(|| "http_error".into()),
                message: inner
                    .and_then(|e| e.message)
                    .unwrap_or_else(|| if text.is_empty() { status.canonical_reason().unwrap_or("error").to_string() } else { text.clone() }),
            });
        }
        if text.trim().is_empty() {
            // `{}` style responses map onto unit-like structs; use Value for those callers.
            return serde_json::from_str("null").map_err(|e| ApiError { status: None, code: "decode_error".into(), message: e.to_string() });
        }
        serde_json::from_str(&text).map_err(|e| ApiError { status: Some(status.as_u16()), code: "decode_error".into(), message: format!("{e} in {}", crate::util::js_slice_prefix(&text, 200)) })
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ApiError> {
        self.request(reqwest::Method::GET, path, None, None).await
    }

    pub async fn post<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T, ApiError> {
        self.request(reqwest::Method::POST, path, Some(body), None).await
    }

    // -- hosts ----------------------------------------------------------------

    pub async fn register_host(&self, name: &str, platform: &str, agents: &[AgentAvailability]) -> Result<AgentHost, ApiError> {
        #[derive(Deserialize)]
        struct R {
            host: AgentHost,
        }
        Ok(self.post::<R>("/hosts/register", json!({ "name": name, "platform": platform, "agents": agents })).await?.host)
    }

    pub async fn heartbeat(&self, host_id: &str, agents: &[AgentAvailability], running: &[String]) -> Result<Vec<String>, ApiError> {
        #[derive(Deserialize)]
        struct Heartbeat { #[serde(default)] cancelled: Vec<String> }
        let response: Heartbeat = self.post(&format!("/hosts/{host_id}/heartbeat"), json!({ "agents": agents, "running": running })).await?;
        Ok(response.cancelled)
    }

    /// Long-poll claim: the server holds the request up to `wait` seconds; `agents` are the idle runtimes here.
    pub async fn claim(&self, host_id: &str, wait: u64, agents: &[String]) -> Result<Option<Task>, ApiError> {
        #[derive(Deserialize)]
        struct R {
            task: Option<Task>,
        }
        let r: R = self
            .request(reqwest::Method::POST, &format!("/hosts/{host_id}/claim?wait={wait}"), Some(json!({ "agents": agents, "desktopPid": std::process::id() })), Some(Duration::from_secs(wait + 20)))
            .await?;
        Ok(r.task)
    }

    // -- tasks ----------------------------------------------------------------

    pub async fn task(&self, task_id: &str) -> Result<TaskWithEvents, ApiError> {
        self.get(&format!("/tasks/{task_id}")).await
    }

    pub async fn post_task_event(&self, task_id: &str, started_at: Option<&str>, ev: &TaskEvent) -> Result<(), ApiError> {
        let mut body = serde_json::to_value(ev).unwrap();
        if let Some(start) = started_at { body["startedAt"] = json!(start); }
        let _: Value = self.post(&format!("/tasks/{task_id}/events"), body).await?;
        Ok(())
    }

    /// `session_id` is the CLI session that asked (None: no session), so the answer can continue it.
    pub async fn post_task_question(&self, task: &Task, text: &str, session_id: Option<&str>) -> Result<bool, ApiError> {
        #[derive(Deserialize)]
        struct Ack {
            waiting: bool,
        }
        let mut body = json!({ "text": text, "sessionId": session_id });
        if let Some(started_at) = &task.started_at {
            body["startedAt"] = json!(started_at);
        }
        Ok(self.post::<Ack>(&format!("/tasks/{}/question", task.id), body).await?.waiting)
    }

    /// The engine's prompt for this run. `fresh` skips resuming the CLI session that asked a question.
    /// `time_limit` is the optional cap on this run, so the prompt can say so. Without one the prompt names no limit.
    pub async fn task_prompt(&self, task_id: &str, work_dir: &str, fresh: bool, time_limit: Option<Duration>) -> Result<TaskPrompt, ApiError> {
        self.get(&prompt_path(task_id, work_dir, fresh, time_limit)).await
    }

    pub async fn post_task_usage(&self, task_id: &str, started_at: Option<&str>, usage: &AgentUsage) -> Result<(), ApiError> {
        let mut body = serde_json::to_value(usage).unwrap();
        if let Some(started_at) = started_at {
            body["startedAt"] = json!(started_at);
        }
        let _: Value = self.post(&format!("/tasks/{task_id}/usage"), body).await?;
        Ok(())
    }

    pub async fn complete_task(&self, task_id: &str, body: &CompleteTaskRequest) -> Result<(), ApiError> {
        let _: Value = self.post(&format!("/tasks/{task_id}/complete"), serde_json::to_value(body).unwrap()).await?;
        Ok(())
    }
}

/// The prompt request for one run. A time limit goes in whole minutes, rounded up.
/// The engine takes a limit of up to a day and refuses the request over that, so a longer one is left out: the host
/// still stops the run at it, and the prompt names no limit rather than a shorter one nothing enforces.
fn prompt_path(task_id: &str, work_dir: &str, fresh: bool, time_limit: Option<Duration>) -> String {
    let minutes = time_limit.map(|t| t.as_secs().div_ceil(60).max(1)).filter(|m| *m <= 24 * 60);
    let limit = minutes.map(|m| format!("&timeLimit={m}")).unwrap_or_default();
    format!("/tasks/{task_id}/prompt?workDir={}{}{limit}", urlencode(work_dir), if fresh { "&fresh=1" } else { "" })
}

pub fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A stand-in engine for tests: answers each request from a closure and keeps what it was asked.
#[cfg(test)]
pub(crate) mod fake {
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub struct Engine {
        pub url: String,
        /// Each request as its method and path ("POST /api/hosts/register") and its body.
        pub seen: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl Engine {
        /// The bodies sent to one route, in order.
        pub fn bodies(&self, route: &str) -> Vec<serde_json::Value> {
            self.seen.lock().unwrap().iter().filter(|(r, _)| r == route).map(|(_, body)| serde_json::from_str(body).unwrap_or_default()).collect()
        }
    }

    /// `answer` gets a request's method and path and its body, and gives the status and body to send back.
    pub async fn engine(answer: impl Fn(&str, &str) -> (u16, String) + Send + Sync + 'static) -> Engine {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (record, answer) = (seen.clone(), Arc::new(answer));
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (record, answer) = (record.clone(), answer.clone());
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 4096];
                    // The head, then as much body as it announces.
                    let (body_at, length) = loop {
                        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&raw[..at]).to_lowercase();
                            let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok());
                            break (at + 4, length.unwrap_or(0));
                        }
                        match stream.read(&mut chunk).await {
                            Ok(n) if n > 0 => raw.extend_from_slice(&chunk[..n]),
                            _ => return,
                        }
                    };
                    while raw.len() < body_at + length {
                        match stream.read(&mut chunk).await {
                            Ok(n) if n > 0 => raw.extend_from_slice(&chunk[..n]),
                            _ => return,
                        }
                    }
                    let head = String::from_utf8_lossy(&raw[..body_at]).into_owned();
                    let route = head.lines().next().and_then(|l| l.rsplit_once(' ')).map(|(route, _)| route.to_string()).unwrap_or_default();
                    let body = String::from_utf8_lossy(&raw[body_at..body_at + length]).into_owned();
                    record.lock().unwrap().push((route.clone(), body.clone()));
                    let (status, reply) = answer(&route, &body);
                    let head = format!("HTTP/1.1 {status} -\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len());
                    let _ = stream.write_all(format!("{head}{reply}").as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Engine { url, seen }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_urls() {
        let api = Api::new("http://127.0.0.1:4321/", Some("sct_a b"));
        assert_eq!(api.url("/hosts/register"), "http://127.0.0.1:4321/api/hosts/register");
        assert_eq!(api.ws_url(), "ws://127.0.0.1:4321/ws?token=sct_a%20b");
        let https = Api::new("https://scarlet.example.com/base", None);
        assert_eq!(https.ws_url(), "wss://scarlet.example.com/ws");
    }

    #[test]
    fn tells_the_engine_the_run_limit() {
        assert_eq!(prompt_path("tsk_1", "C:\\work dir", false, Some(Duration::from_secs(45 * 60))), "/tasks/tsk_1/prompt?workDir=C%3A%5Cwork%20dir&timeLimit=45");
        assert_eq!(prompt_path("tsk_1", "/w", true, Some(Duration::from_secs(61))), "/tasks/tsk_1/prompt?workDir=%2Fw&fresh=1&timeLimit=2");
        assert_eq!(prompt_path("tsk_1", "/w", false, None), "/tasks/tsk_1/prompt?workDir=%2Fw");
        // The engine takes a limit of up to a day and refuses the whole request over that. A longer one is left out:
        // the run is still stopped at it here, and the prompt names no limit.
        let day = 24 * 60 * 60;
        assert_eq!(prompt_path("tsk_1", "/w", false, Some(Duration::from_secs(day))), "/tasks/tsk_1/prompt?workDir=%2Fw&timeLimit=1440");
        assert_eq!(prompt_path("tsk_1", "/w", false, Some(Duration::from_secs(day + 60))), "/tasks/tsk_1/prompt?workDir=%2Fw");
        assert_eq!(prompt_path("tsk_1", "/w", true, Some(Duration::from_secs(day + 1))), "/tasks/tsk_1/prompt?workDir=%2Fw&fresh=1");
        // `timeoutMinutes` too large to count in seconds: a limit that never comes.
        assert_eq!(prompt_path("tsk_1", "/w", false, Some(Duration::from_secs(u64::MAX))), "/tasks/tsk_1/prompt?workDir=%2Fw");
    }

    #[tokio::test]
    async fn reads_the_engines_reason_from_a_failed_request() {
        let engine = fake::engine(|route, _| match route {
            "GET /api/tasks/tsk_gone" => (404, r#"{"error":{"code":"not_found","message":"No such task"}}"#.into()),
            "GET /api/tasks/tsk_plain" => (502, "upstream went away".into()),
            "GET /api/tasks/tsk_empty" => (503, String::new()),
            "GET /api/tasks/tsk_partial" => (400, r#"{"error":{"message":"Bad id"}}"#.into()),
            _ => (200, "{}".into()),
        }).await;
        let api = Api::new(&engine.url, Some("sct_test"));
        let gone = api.task("tsk_gone").await.unwrap_err();
        assert!(gone.is_status(404) && !gone.is_status(500));
        assert_eq!((gone.code.as_str(), gone.message.as_str(), gone.to_string().as_str()), ("not_found", "No such task", "No such task (not_found 404)"));
        // Not the engine's JSON: the text itself, or the status's own name when there is none.
        let plain = api.task("tsk_plain").await.unwrap_err();
        assert_eq!((plain.status, plain.code.as_str(), plain.message.as_str()), (Some(502), "http_error", "upstream went away"));
        let empty = api.task("tsk_empty").await.unwrap_err();
        assert_eq!((empty.status, empty.message.as_str()), (Some(503), "Service Unavailable"));
        let partial = api.task("tsk_partial").await.unwrap_err();
        assert_eq!((partial.code.as_str(), partial.message.as_str()), ("http_error", "Bad id"));
    }

    #[tokio::test]
    async fn tells_an_unreachable_engine_from_an_answer_it_cannot_read() {
        let engine = fake::engine(|route, _| match route {
            "GET /api/tasks/tsk_html" => (200, format!("<html>{}</html>", "x".repeat(400))),
            "POST /api/tasks/tsk_1/events" => (200, String::new()),
            "POST /api/hosts/h/heartbeat" => (200, "  ".into()),
            _ => (200, "{}".into()),
        }).await;
        let api = Api::new(&engine.url, None);
        // A 200 that isn't the JSON asked for names what was wrong and shows where the answer began.
        let html = api.task("tsk_html").await.unwrap_err();
        assert_eq!((html.status, html.code.as_str()), (Some(200), "decode_error"));
        assert!(html.message.contains(" in <html>xxx") && html.message.len() < 300, "{}", html.message);
        // An empty answer is fine where nothing is read from it, and an error where something is.
        let event = TaskEvent { task_id: None, at: None, kind: "log".into(), text: "hi".into(), data: None };
        api.post_task_event("tsk_1", Some("2026-11-08T10:00:00.000Z"), &event).await.unwrap();
        assert_eq!(engine.bodies("POST /api/tasks/tsk_1/events")[0], json!({ "type": "log", "text": "hi", "startedAt": "2026-11-08T10:00:00.000Z" }));
        assert_eq!(api.heartbeat("h", &[], &[]).await.unwrap_err().code, "decode_error");

        // Nothing listening: no status, so it is never mistaken for a host the engine forgot.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let nowhere = Api::new(&format!("http://{}", closed.local_addr().unwrap()), None);
        drop(closed);
        let down = nowhere.task("tsk_1").await.unwrap_err();
        assert_eq!((down.status, down.code.as_str()), (None, "network_error"));
        assert!(!down.is_status(404) && !down.to_string().contains("network_error"));
    }

    #[tokio::test]
    async fn claims_a_task_or_nothing_and_says_what_it_can_run() {
        let engine = fake::engine(|route, _| match route {
            "POST /api/hosts/host_1/claim?wait=25" => (200, r#"{"task":null}"#.into()),
            "POST /api/hosts/host_1/claim?wait=0" => (200, r#"{"task":{"id":"tsk_1","projectId":"prj_1","agent":"codex","instruction":"Trim the intro"}}"#.into()),
            "POST /api/hosts/host_1/heartbeat" => (200, "{}".into()),
            "POST /api/hosts/host_2/heartbeat" => (200, r#"{"cancelled":["tsk_9"]}"#.into()),
            _ => (500, String::new()),
        }).await;
        let api = Api::new(&engine.url, None);
        assert!(api.claim("host_1", 25, &["claude".to_string()]).await.unwrap().is_none());
        let task = api.claim("host_1", 0, &["codex".to_string()]).await.unwrap().unwrap();
        assert_eq!((task.id.as_str(), task.agent.as_str(), task.kind.as_str()), ("tsk_1", "codex", "edit"));
        let asked = engine.bodies("POST /api/hosts/host_1/claim?wait=25");
        assert_eq!(asked[0], json!({ "agents": ["claude"], "desktopPid": std::process::id() }));
        // An engine from before cancellations were reported on the heartbeat reports none.
        assert!(api.heartbeat("host_1", &[], &["tsk_1".to_string()]).await.unwrap().is_empty());
        assert_eq!(api.heartbeat("host_2", &[], &[]).await.unwrap(), ["tsk_9"]);
        assert_eq!(engine.bodies("POST /api/hosts/host_1/heartbeat")[0], json!({ "agents": [], "running": ["tsk_1"] }));
    }

    #[tokio::test]
    async fn ties_a_question_and_a_usage_report_to_the_attempt_that_made_them() {
        let engine = fake::engine(|route, _| match route {
            r if r.ends_with("/question") => (200, r#"{"waiting":true}"#.into()),
            _ => (200, "{}".into()),
        }).await;
        let api = Api::new(&engine.url, None);
        let mut task: Task = serde_json::from_value(json!({ "id": "tsk_1", "projectId": "p", "agent": "claude", "instruction": "x", "startedAt": "2026-11-08T10:00:00.000Z" })).unwrap();
        assert!(api.post_task_question(&task, "Keep the cold open?", Some("s1")).await.unwrap());
        task.started_at = None;
        api.post_task_question(&task, "Which take?", None).await.unwrap();
        let asked = engine.bodies("POST /api/tasks/tsk_1/question");
        assert_eq!(asked[0], json!({ "text": "Keep the cold open?", "sessionId": "s1", "startedAt": "2026-11-08T10:00:00.000Z" }));
        assert_eq!(asked[1], json!({ "text": "Which take?", "sessionId": null }));

        let usage = AgentUsage { input_tokens: 10, output_tokens: 4, ..Default::default() };
        api.post_task_usage("tsk_1", Some("2026-11-08T10:00:00.000Z"), &usage).await.unwrap();
        api.post_task_usage("tsk_1", None, &usage).await.unwrap();
        let reported = engine.bodies("POST /api/tasks/tsk_1/usage");
        assert_eq!((&reported[0]["startedAt"], &reported[0]["inputTokens"], &reported[0]["outputTokens"]), (&json!("2026-11-08T10:00:00.000Z"), &json!(10), &json!(4)));
        assert!(reported[1].get("startedAt").is_none());
    }

    #[test]
    fn encodes_everything_but_unreserved_characters() {
        assert_eq!(urlencode("AZaz09-_.~"), "AZaz09-_.~");
        assert_eq!(urlencode("a b&c=d/é?#"), "a%20b%26c%3Dd%2F%C3%A9%3F%23");
        // A local engine keeps its port in the socket address, and a token-less client asks for no token.
        assert_eq!(Api::new("http://127.0.0.1:4321", None).ws_url(), "ws://127.0.0.1:4321/ws");
        assert_eq!(Api::new("http://127.0.0.1:4321", None).token(), None);
    }
}
