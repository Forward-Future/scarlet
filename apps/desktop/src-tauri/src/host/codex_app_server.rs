//! Run one Codex turn over the App Server's JSONL stdio protocol, in a new thread or one it resumes.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::spawn::{spawn_interactive, SpawnLinesOptions, SpawnOutcome};
use super::runner::stderr_tail;

const INITIALIZE: u64 = 1;
const START_THREAD: u64 = 2;
const START_TURN: u64 = 3;
const INTERRUPT_TURN: u64 = 4;
const STOP_GRACE: Duration = Duration::from_secs(2);

/// A failed handshake: what the editor reads, and a fixed phase name the log can carry without provider output.
#[derive(Debug)]
struct HandshakeError {
    phase: &'static str,
    message: String,
}
impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.message) }
}
impl std::error::Error for HandshakeError {}

fn handshake(phase: &'static str, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(HandshakeError { phase, message: message.into() })
}

/// Extract the safe handshake phase without exposing provider output from the error chain.
pub fn fallback_reason(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<HandshakeError>().map_or("app_server_unavailable", |error| error.phase)
}

/// Receive one notification for this run. Returning true interrupts the turn.
pub type NotificationHandler = Box<dyn FnMut(&str, &Value) -> bool + Send>;

struct Session {
    input: Option<mpsc::UnboundedSender<String>>,
    thread: Option<String>,
    turn: Option<String>,
    pending_response: Option<u64>,
    pending_events: Vec<Value>,
    interrupted: bool,
    completed: bool,
    error: Option<anyhow::Error>,
    /// `thread/resume` for a thread an earlier run of this task left, otherwise `thread/start`.
    thread_method: &'static str,
}

impl Session {
    fn send(&self, message: Value) -> Result<()> {
        self.input.as_ref().context("Codex App Server input closed")?
            .send(format!("{message}\n")).map_err(|_| anyhow!("Codex App Server stopped taking input"))
    }

    fn request(&self, id: u64, method: &str, params: &Value) -> Result<()> {
        self.send(json!({ "id": id, "method": method, "params": params }))
    }

    fn interrupt(&mut self) -> bool {
        if self.interrupted || self.completed {
            return true;
        }
        let (Some(thread_id), Some(turn_id)) = (&self.thread, &self.turn) else { return false };
        let sent = self.request(INTERRUPT_TURN, "turn/interrupt", &json!({
            "threadId": thread_id, "turnId": turn_id,
        })).is_ok();
        self.interrupted = sent;
        sent
    }

    fn notify(&mut self, method: &str, params: &Value, on_event: &mut NotificationHandler) -> bool {
        let turn = params["turnId"].as_str().or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        if self.completed || turn.is_none() || turn != self.turn.as_deref() {
            return false;
        }
        let stop = on_event(method, params);
        if method == "turn/completed" {
            self.completed = true;
            self.input.take();
            return true;
        }
        if stop && !self.interrupt() {
            self.input.take();
        }
        stop
    }

    fn receive(
        &mut self, message: &Value, thread_params: &Value, turn_params: &mut Value,
        on_event: &mut NotificationHandler,
    ) -> Result<bool> {
        if self.completed || self.error.is_some() {
            return Ok(false);
        }
        if let Some(method) = message["method"].as_str() {
            if let Some(id) = message.get("id") {
                // There is no interactive approval or input from this client. Scarlet's MCP tools
                // implement questions and record them before an edit pauses.
                self.send(json!({ "id": id, "error": { "code": -32601, "message": "Unsupported by Scarlet" } }))?;
                return Ok(false);
            }
            let params = &message["params"];
            if method == "account/rateLimits/updated" {
                on_event(method, params);
                return Ok(false);
            }
            if self.thread.is_none() || params["threadId"].as_str() != self.thread.as_deref() {
                return Ok(false);
            }
            // Events can arrive ahead of the turn/start response. Wait for its ID before using them.
            if self.pending_response == Some(START_TURN) {
                self.pending_events.push(message.clone());
                return Ok(false);
            }
            return Ok(self.notify(method, params, on_event));
        }

        let Some(id) = message["id"].as_u64() else { return Ok(false) };
        if self.pending_response != Some(id) {
            // An interrupt can race a turn already ending. The completion notification
            // or the stop deadline will close the process regardless of its response.
            return Ok(false);
        }
        let resuming = self.thread_method == "thread/resume";
        let method = match id {
            INITIALIZE => "initialize",
            START_THREAD => self.thread_method,
            START_TURN => "turn/start",
            _ => unreachable!(),
        };
        let phase = match id {
            INITIALIZE => "initialize_failed",
            START_THREAD if resuming => "thread_resume_failed",
            START_THREAD => "thread_start_failed",
            _ => "turn_start_failed",
        };
        if let Some(error) = message.get("error") {
            let detail = error["message"].as_str().unwrap_or("unknown error");
            return Err(handshake(phase, format!("Codex App Server {method} failed: {detail}")));
        }
        let result = message.get("result").ok_or_else(|| handshake(phase, format!("Codex App Server {method} returned no result")))?;
        match id {
            INITIALIZE => {
                self.send(json!({ "method": "initialized" }))?;
                self.pending_response = Some(START_THREAD);
                self.request(START_THREAD, self.thread_method, thread_params)?;
            }
            START_THREAD => {
                // The thread is kept in the run's private Codex home so a run cut short can resume it.
                if result.pointer("/thread/ephemeral").and_then(Value::as_bool) != Some(false) {
                    return Err(handshake("thread_policy_mismatch", "Codex App Server did not keep the thread"));
                }
                if resuming && result.pointer("/thread/id").and_then(Value::as_str) != thread_params["threadId"].as_str() {
                    return Err(handshake("thread_resume_failed", "Codex App Server resumed another thread"));
                }
                if result["approvalPolicy"].as_str() != Some("never") {
                    return Err(handshake("thread_policy_mismatch", "Codex App Server did not apply Scarlet's approval policy"));
                }
                if result.pointer("/activePermissionProfile/id").and_then(Value::as_str) != Some("scarlet") {
                    return Err(handshake("thread_policy_mismatch", "Codex App Server did not apply Scarlet's permission profile"));
                }
                let thread_id = result.pointer("/thread/id").and_then(Value::as_str).ok_or_else(|| handshake("thread_start_failed", "Codex App Server returned no thread ID"))?;
                self.thread = Some(thread_id.into());
                on_event("thread/started", result);
                turn_params["threadId"] = json!(thread_id);
                self.pending_response = Some(START_TURN);
                on_event("turn/requested", turn_params);
                self.request(START_TURN, "turn/start", turn_params)?;
            }
            START_TURN => {
                let turn_id = result.pointer("/turn/id").and_then(Value::as_str).context("Codex App Server returned no turn ID")?;
                self.turn = Some(turn_id.into());
                self.pending_response = None;
                let mut stop = false;
                for event in std::mem::take(&mut self.pending_events) {
                    stop |= self.notify(event["method"].as_str().unwrap_or_default(), &event["params"], on_event);
                }
                return Ok(stop);
            }
            _ => unreachable!(),
        }
        Ok(false)
    }
}

/// `resume`: the id of a thread an earlier run of this task left in the same Codex home, to carry on in.
pub async fn run_app_server(
    file: &str, args: &[String], opts: SpawnLinesOptions,
    mut thread_params: Value, mut turn_params: Value, mut on_event: NotificationHandler, resume: Option<&str>,
) -> Result<SpawnOutcome> {
    let thread_method = match resume {
        Some(id) => { thread_params["threadId"] = json!(id); "thread/resume" }
        None => { thread_params["ephemeral"] = json!(false); "thread/start" }
    };
    let (input, lines) = mpsc::unbounded_channel();
    let session = Session {
        input: Some(input), thread: None, turn: None, pending_response: Some(INITIALIZE),
        pending_events: Vec::new(), interrupted: false, completed: false, error: None, thread_method,
    };
    session.request(INITIALIZE, "initialize", &json!({
        "clientInfo": { "name": "scarlet", "title": "Scarlet", "version": env!("CARGO_PKG_VERSION") },
        // The named permission profile is only returned to experimental clients.
        "capabilities": { "experimentalApi": true, "requestAttestation": false },
    }))?;

    let state = Arc::new(Mutex::new(session));
    let interrupt_state = state.clone();
    let interrupt = Box::new(move || interrupt_state.lock().unwrap().interrupt());
    let line_state = state.clone();
    let read_line = Box::new(move |line: &str| {
        let Ok(message) = serde_json::from_str(line) else { return false };
        let mut session = line_state.lock().unwrap();
        match session.receive(&message, &thread_params, &mut turn_params, &mut on_event) {
            Ok(stop) => stop,
            Err(error) => {
                session.error = Some(error);
                session.input.take();
                true
            }
        }
    });
    let outcome = spawn_interactive(file, args, opts, lines, STOP_GRACE, interrupt, read_line).await?;
    let mut session = state.lock().unwrap();
    if let Some(error) = session.error.take() {
        if !outcome.aborted && !outcome.timed_out {
            // The editor reads the failure first and the stderr after it, as before; a handshake keeps its phase.
            let tail = stderr_tail(&outcome.stderr);
            let mut error = error;
            if let Some(handshake) = error.downcast_mut::<HandshakeError>() {
                handshake.message.push_str(&tail);
                return Err(error);
            }
            bail!("{error}{tail}");
        }
    }
    if !session.completed && !session.interrupted && !outcome.aborted && !outcome.timed_out {
        bail!("Codex App Server exited before completing the turn (exit code {:?}){}", outcome.code, stderr_tail(&outcome.stderr));
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn process_options(cancel: CancellationToken) -> (String, SpawnLinesOptions) {
        let env = crate::util::env_map();
        let node = super::super::spawn::resolve_cli("node", &env).unwrap();
        let opts = SpawnLinesOptions {
            cwd: std::env::temp_dir(),
            env,
            stdin: None,
            cancel,
            timeout: Some(Duration::from_secs(10)),
            stall: None,
            task: None,
        };
        (node, opts)
    }

    const FAKE_SERVER: &str = r#"
const assert = require('node:assert/strict');
const lines = require('node:readline').createInterface({input: process.stdin});
const send = message => console.log(JSON.stringify(message));
const notify = (method, params) => send({method, params});
const usage = (n, threadId='thread', turnId='turn') => notify('thread/tokenUsage/updated', {
    threadId, turnId, tokenUsage: {total: {inputTokens: n}}
});
let initialized = false;
let interrupted = false;
let declined = false;
lines.on('line', line => {
    const {id, method, params, error} = JSON.parse(line);
    const reply = result => send({id, result});
    switch (method) {
    case 'initialize':
        assert.equal(params.clientInfo.name, 'scarlet');
        assert.equal(params.capabilities.experimentalApi, true);
        reply({});
        break;
    case 'initialized':
        initialized = true;
        break;
    case 'thread/start':
        assert.equal(initialized, true);
        assert.equal(params.ephemeral, false);
        reply({thread: {id: 'thread', ephemeral: false}, model: 'fake-model', approvalPolicy: 'never', activePermissionProfile: {id: 'scarlet'}});
        break;
    case 'thread/resume':
        assert.equal(initialized, true);
        assert.equal(params.ephemeral, undefined);
        if (params.threadId !== 'thread') { send({id, error: {code: -32600, message: `no rollout found for thread id ${params.threadId}`}}); break; }
        reply({thread: {id: 'thread', ephemeral: false}, model: 'fake-model', approvalPolicy: 'never', activePermissionProfile: {id: 'scarlet'}});
        break;
    case 'turn/start':
        assert.equal(params.threadId, 'thread');
        assert.equal(params.input[0].text, 'Make the edit');
        assert.deepEqual(params.input[0].text_elements, []);
        notify('turn/started', {threadId: 'thread', turn: {id: 'other-turn'}});
        notify('turn/started', {threadId: 'thread', turn: {id: 'turn'}});
        usage(9999, 'other-thread');
        usage(8888, 'thread', 'other-turn');
        send({id: 'interactive', method: 'item/tool/requestUserInput', params: {}});
        usage(50);
        reply({turn: {id: 'turn'}});
        break;
    case 'turn/interrupt':
        assert.deepEqual(params, {threadId: 'thread', turnId: 'turn'});
        assert.equal(interrupted, false);
        interrupted = true;
        usage(60);
        notify('turn/completed', {threadId: 'thread', turn: {id: 'turn', status: 'interrupted'}});
        reply({});
        break;
    default:
        assert.equal(id, 'interactive');
        assert.equal(error.code, -32601);
        declined = true;
    }
});
lines.on('close', () => {
    assert.equal(interrupted, true);
    assert.equal(declined, true);
});
"#;

    #[tokio::test]
    async fn sends_one_interrupt_and_collects_matching_usage_until_completion() {
        #[derive(Clone, Copy, PartialEq)]
        enum Stop { Question, Cancel, Stall }
        for stop in [Stop::Question, Stop::Cancel, Stop::Stall] {
            let cancel = CancellationToken::new();
            let reported = Arc::new(Mutex::new(Vec::new()));
            let on_event = {
                let cancel = cancel.clone();
                let reported = reported.clone();
                Box::new(move |method: &str, params: &Value| {
                    let Some(tokens) = params.pointer("/tokenUsage/total/inputTokens").and_then(Value::as_u64) else {
                        return false;
                    };
                    assert_eq!(method, "thread/tokenUsage/updated");
                    reported.lock().unwrap().push(tokens);
                    if tokens == 50 && stop == Stop::Cancel {
                        cancel.cancel();
                    }
                    tokens == 50 && stop == Stop::Question
                })
            };
            let (node, mut opts) = process_options(cancel);
            if stop == Stop::Stall {
                opts.stall = Some(Duration::from_secs(2));
            }
            // A question stops a resumed thread the same way.
            let resume = (stop == Stop::Question).then_some("thread");
            let result = run_app_server(
                &node, &["-e".into(), FAKE_SERVER.into()], opts, json!({}),
                json!({"input": [{"type": "text", "text": "Make the edit", "text_elements": []}]}), on_event, resume,
            ).await.unwrap();
            assert_eq!(result.code, Some(0), "{result:?}");
            assert_eq!(result.aborted, stop == Stop::Cancel);
            assert_eq!(result.stalled, stop == Stop::Stall);
            assert_eq!(*reported.lock().unwrap(), [50, 60]);
        }
    }

    #[tokio::test]
    async fn reports_request_failure_with_rpc_context() {
        let script = r#"const lines = require('node:readline').createInterface({input: process.stdin});
lines.on('line', line => console.log(JSON.stringify({id: JSON.parse(line).id, error: {code: -32603, message: 'Connection failed'}})));"#;
        let (node, opts) = process_options(CancellationToken::new());
        let error = run_app_server(&node, &["-e".into(), script.into()], opts, json!({}), json!({}), Box::new(|_, _| false), None)
            .await.unwrap_err();
        assert!(error.to_string().starts_with("Codex App Server initialize failed: Connection failed"), "{error:#}");
        assert_eq!(fallback_reason(&error), "initialize_failed");
    }

    #[tokio::test]
    async fn names_a_thread_codex_no_longer_has_as_a_failed_resume() {
        let (node, opts) = process_options(CancellationToken::new());
        let error = run_app_server(&node, &["-e".into(), FAKE_SERVER.into()], opts, json!({}), json!({}), Box::new(|_, _| false), Some("gone"))
            .await.unwrap_err();
        assert!(error.to_string().starts_with("Codex App Server thread/resume failed: no rollout found"), "{error:#}");
        assert_eq!(fallback_reason(&error), "thread_resume_failed");
    }
}
