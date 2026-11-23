use std::path::Path;

use super::catalog::describe_agents;
use super::task_runner::{drain_events, log_completion, outcome, stalled_reason, timed_out_reason, Outcome};
use super::types::{CompleteTaskRequest, RunResult, RunnerEvent};
use super::workspace::{claude_config_dir, claude_project_dir, real_path, remove_claude_sessions, remove_control_files};
use super::*;
use super::manager::{remember_host_id, run_limits, DEFAULT_STALL_MINUTES};
use crate::config::AppConfig;
use crate::util::now_iso;

type EmittedEvents = Arc<StdMutex<Vec<(String, Value)>>>;

/// A host runtime with no window and no CLIs, talking to `server`. The second value is every event it sent
/// to the window.
fn runtime(server: &str, work_root: &Path) -> (Arc<HostRuntime>, EmittedEvents) {
    let sent: EmittedEvents = Arc::new(StdMutex::new(Vec::new()));
    let record = sent.clone();
    let rt = Arc::new(HostRuntime {
        emit: Arc::new(move |event, payload| record.lock().unwrap().push((event.to_string(), payload))),
        api: Api::new(server, Some("sct_test")),
        server: server.to_string(),
        name: "test (desktop)".into(),
        cancel: CancellationToken::new(),
        engine_lost: AtomicBool::new(false),
        agents: RwLock::new(Vec::new()),
        detecting: Mutex::new(()),
        quota_refreshing: Mutex::new(()),
        last_quota_at: StdMutex::new(None),
        running: StdMutex::new(HashMap::new()),
        host_id: StdMutex::new(Some("host_1".into())),
        connected: AtomicBool::new(false),
        wake: Notify::new(),
        subscriptions_changed: Notify::new(),
        paths: Paths {
            config_file: work_root.join("desktop.json"), work_dir: work_root.to_owned(), home: work_root.join("home"),
            data_dir: work_root.join("data"), log_dir: work_root.join("logs"), resource_dir: None,
        },
        // Claude Code's own folder under the test's home, whatever the machine running the tests has set.
        claude_dir: Some(work_root.join("home").join(".claude")),
        mcp: McpLauncher { program: "scarlet-engine".into(), prefix_args: vec![] },
        models: HashMap::new(),
        timeout: None,
        stall: Some(Duration::from_secs(600)),
        max_parallel: 1,
        last_error: StdMutex::new(None),
        on_host_id: Arc::new(|_, _| {}),
        undelivered: Arc::default(),
    });
    (rt, sent)
}

#[cfg(unix)]
#[tokio::test]
async fn refreshes_model_catalogs_and_keeps_only_the_catalogs_that_failed() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, _) = runtime("http://127.0.0.1:1", dir.path());
    Arc::get_mut(&mut rt).unwrap().mcp = McpLauncher {
        program: "/bin/sh".into(), prefix_args: vec!["-c".into(), r#"/bin/cat "$2.catalog""#.into()],
    };
    let env = HashMap::from([("PATH".to_string(), dir.path().to_string_lossy().into_owned())]);
    let put = |name: &str, text: &str| std::fs::write(dir.path().join(name), text).unwrap();
    for id in ["claude", "codex"] {
        put(id, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.2.3; else /bin/cat \"$0.status\"; fi\n");
        std::fs::set_permissions(dir.path().join(id), std::fs::Permissions::from_mode(0o700)).unwrap();
        put(&format!("{id}.catalog"), r#"{"models":["example"],"model":"example","modelLabels":{"example":"Example"},"modelOptions":{"example":{"efforts":[],"speeds":[]}}}"#);
    }
    put("claude.status", r#"{"loggedIn":true,"authMethod":"claude.ai"}"#);
    put("codex.status", "Logged in using ChatGPT");
    put("custom-claude-models.json", r#"["first-custom"]"#);
    assert_eq!(rt.detect_agents(&env).await, None);
    let first = rt.agents.read().await.clone();
    assert_eq!(first[0].models.as_ref().unwrap(), &["example", "first-custom"]);
    assert_eq!(first[1].model.as_deref(), Some("example"));

    put("custom-claude-models.json", r#"["next-custom"]"#);
    put("codex.catalog", "null"); // The engine received no catalog from this CLI.
    assert_eq!(rt.detect_agents(&env).await.as_deref(), Some("Couldn't refresh models for Codex. Try again."));
    let second = rt.agents.read().await.clone();
    assert_eq!(second[0].models.as_ref().unwrap(), &["example", "next-custom"]);
    assert_eq!(second[1], first[1]); // Retain its IDs, labels, options and default.

    put("codex.catalog", r#"{"models":[],"modelLabels":{},"modelOptions":{}}"#);
    put("claude.status", r#"{"loggedIn":false}"#);
    assert_eq!(rt.detect_agents(&env).await, None);
    let third = rt.agents.read().await.clone();
    assert_eq!((third[0].logged_in, &third[0].models), (Some(false), &None));
    assert_eq!(third[1].models, Some(Vec::new()));
    assert!(third[1].model.is_none() && third[1].model_options.is_empty() && third[1].model_labels.is_empty());

    std::fs::remove_file(dir.path().join("codex")).unwrap();
    assert_eq!(rt.detect_agents(&env).await, None);
    let removed = &rt.agents.read().await[1];
    assert!(!removed.installed && removed.models.is_none());
}

#[tokio::test]
async fn a_heartbeat_that_gets_through_clears_the_error_a_failed_call_left() {
    let engine = api::fake::engine(|_, _| (200, r#"{"cancelled":[]}"#.into())).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, sent) = runtime(&engine.url, dir.path());
    // A claim failed a moment ago: Settings shows the host as disconnected, with the reason.
    rt.set_error(Some("claim failed: connection refused".into()));
    rt.heartbeat().await;
    let status = rt.status();
    assert!(status.connected);
    assert_eq!(status.error, None, "a stale error stayed beside a connected host");
    // The window is told, so Settings drops the error without being reopened.
    {
        let sent = sent.lock().unwrap();
        let (event, last) = sent.last().unwrap();
        assert_eq!(event, "host://status");
        assert_eq!((&last["connected"], &last["error"]), (&json!(true), &Value::Null));
    }
    // An error left beside a host that already shows as connected goes the same way: the other loop's call
    // got through between this one failing and saying so.
    rt.set_error(Some("claim failed: connection refused".into()));
    rt.heartbeat().await;
    assert_eq!(rt.status().error, None);
}

#[tokio::test]
async fn a_delayed_heartbeat_loop_sends_one_catch_up_heartbeat_not_a_burst() {
    let every = Duration::from_millis(150);
    let times = Arc::new(StdMutex::new(Vec::<std::time::Instant>::new()));
    let record = times.clone();
    let slow = AtomicBool::new(true);
    let engine = api::fake::engine(move |route, _| {
        if route == "POST /api/hosts/host_1/heartbeat" {
            record.lock().unwrap().push(std::time::Instant::now());
            // Hold the first heartbeat across four missed ticks, the way a wake after sleep finds the interval far behind.
            if slow.swap(false, Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(650));
            }
        }
        (200, r#"{"cancelled":[]}"#.into())
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    let looping = tokio::spawn(rt.clone().heartbeat_loop(every));
    until("three heartbeats", || times.lock().unwrap().len() >= 3).await;
    rt.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(10), looping).await.expect("the loop did not stop").unwrap();
    let times = times.lock().unwrap();
    // After the stalled call returns, one catch-up heartbeat runs and the next waits a full interval.
    let gap = times[2].duration_since(times[1]);
    assert!(gap >= Duration::from_millis(100), "missed ticks burst back to back: gap between 2nd and 3rd heartbeat was {gap:?}");
}

fn task(id: &str) -> Task {
    serde_json::from_value(json!({ "id": id, "projectId": "prj_1", "agent": "claude", "instruction": "Cut the pauses", "startedAt": "2026-11-08T10:00:00.000Z" })).unwrap()
}

/// A task for an assistant this host has no runner for. Run to the end, it fails there: no test of the run
/// loop can start a real CLI on the machine it runs on.
fn unrunnable(id: &str) -> Task {
    Task { agent: "storyboard".into(), ..task(id) }
}

/// What a Claude run has on disk: the file with the engine token in its folder, beside its artifacts, and its
/// session in Claude Code's own store. Gives the folder and the session.
fn claude_run_files(rt: &HostRuntime, task: &Task) -> (PathBuf, PathBuf) {
    let folder = rt.run_dir(task);
    std::fs::create_dir_all(folder.join(".scarlet")).unwrap();
    std::fs::create_dir_all(folder.join("artifacts")).unwrap();
    std::fs::write(folder.join(".scarlet").join("mcp.json"), "sct_test").unwrap();
    let session = claude_project_dir(&real_path(&folder).unwrap(), rt.claude_dir.as_deref().unwrap()).unwrap();
    std::fs::create_dir_all(&session).unwrap();
    (folder, session)
}

/// Whether a finished run's Claude session went.
fn session_gone(session: &Path) -> bool {
    !session.exists()
}

/// Wait for something another task is about to do.
async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_host_the_engine_forgot_registers_again_on_its_next_heartbeat() {
    crate::util::test_log::capture();
    let engine = api::fake::engine(|route, _| match route {
        "POST /api/hosts/host_1/heartbeat" => (404, r#"{"error":{"code":"not_found","message":"No such host"}}"#.into()),
        "POST /api/hosts/register" => (200, r#"{"host":{"id":"host_2","name":"test (desktop)"}}"#.into()),
        _ => (500, String::new()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, _) = runtime(&engine.url, dir.path());
    let saved = Arc::new(StdMutex::new(Vec::new()));
    let record = saved.clone();
    Arc::get_mut(&mut rt).unwrap().on_host_id = Arc::new(move |server, id| record.lock().unwrap().push((server.to_string(), id.to_string())));
    rt.connected.store(true, Ordering::SeqCst);
    rt.heartbeat().await;
    // Registered under the new id, connected, and with no error left from the heartbeat that failed.
    let status = rt.status();
    assert_eq!((status.host_id.as_deref(), status.connected, status.error), (Some("host_2"), true, None));
    assert_eq!(*saved.lock().unwrap(), [(engine.url.clone(), "host_2".to_string())]);
    assert_eq!(engine.bodies("POST /api/hosts/register")[0]["name"], json!("test (desktop)"));
    let (level, _) = crate::util::test_log::find(&["heartbeat failed: No such host (not_found 404)"]).expect("the failed heartbeat was not logged");
    assert_eq!(level, log::Level::Warn);

    // A heartbeat that fails for another reason leaves the host as it was, with the reason on show.
    let (rt, _) = runtime(&format!("{}/nowhere", engine.url), dir.path());
    rt.connected.store(true, Ordering::SeqCst);
    rt.heartbeat().await;
    let status = rt.status();
    assert_eq!((status.host_id.as_deref(), status.connected), (Some("host_1"), false));
    assert!(status.error.as_deref().unwrap().starts_with("heartbeat failed: "), "{:?}", status.error);
}

#[tokio::test]
async fn completes_a_task_with_the_changes_it_made_and_clears_its_control_files() {
    crate::util::test_log::capture();
    let engine = api::fake::engine(|route, body| match route {
        // The engine answers with the changes it holds for the task.
        "POST /api/tasks/tsk_finish/complete" => (200, json!({
            "task": { "state": serde_json::from_str::<Value>(body).unwrap()["state"], "changeIds": ["chg_1", "chg_2", "chg_3"] }
        }).to_string()),
        _ => (200, "{}".into()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    let task = task("tsk_finish");
    let folder = rt.run_dir(&task);
    std::fs::create_dir_all(folder.join(".scarlet")).unwrap();
    std::fs::create_dir_all(folder.join("artifacts")).unwrap();
    std::fs::write(folder.join(".scarlet").join("mcp.json"), "sct_test").unwrap();
    std::fs::write(folder.join("artifacts").join("cut.otio"), "kept").unwrap();

    rt.complete(&task, "done", Some("Cut two pauses.".into()), None).await;
    let sent = &engine.bodies("POST /api/tasks/tsk_finish/complete")[0];
    assert_eq!(sent, &json!({ "state": "done", "ifStartedAt": "2026-11-08T10:00:00.000Z", "interrupted": false, "summary": "Cut two pauses." }));
    // The file with the engine token is gone. What the run made stays.
    assert!(!folder.join(".scarlet").exists() && folder.join("artifacts").join("cut.otio").exists());
    let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_finish", "requested=done state=done outcome=accepted", "changes=3"]).expect("no completion line");
    assert_eq!(level, log::Level::Info);

    // A run the host cut short is marked as one the editor can resume, and its failure is a warning.
    rt.finish(&task, "failed", None, Some("stalled: the agent wrote nothing for 10 minutes".into()), true).await;
    let sent = &engine.bodies("POST /api/tasks/tsk_finish/complete")[1];
    assert_eq!((&sent["state"], &sent["interrupted"], &sent["error"]), (&json!("failed"), &json!(true), &json!("stalled: the agent wrote nothing for 10 minutes")));
    assert!(sent.get("summary").is_none());
    let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_finish", "requested=failed state=failed outcome=accepted"]).expect("no failure line");
    assert_eq!(level, log::Level::Warn);

    // Cancelled by the editor is not an interruption. Cancelled because the app is quitting is.
    rt.complete(&task, "cancelled", None, Some("cancelled".into())).await;
    rt.cancel.cancel();
    rt.complete(&task, "cancelled", None, Some("host shutting down".into())).await;
    let sent = engine.bodies("POST /api/tasks/tsk_finish/complete");
    assert_eq!((&sent[2]["interrupted"], &sent[3]["interrupted"]), (&json!(false), &json!(true)));
}

#[tokio::test]
async fn completes_a_task_without_reading_it_again() {
    crate::util::test_log::capture();
    let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    rt.complete(&task("tsk_noread"), "done", Some("Done.".into()), None).await;
    // The engine already has the run's changes: the completion is all the host sends.
    let routes: Vec<String> = engine.seen.lock().unwrap().iter().map(|(route, _)| route.clone()).collect();
    assert_eq!(routes, ["POST /api/tasks/tsk_noread/complete"]);
    assert_eq!(engine.bodies("POST /api/tasks/tsk_noread/complete")[0], json!({ "state": "done", "ifStartedAt": "2026-11-08T10:00:00.000Z", "interrupted": false, "summary": "Done." }));
    // An answer without a state confirms delivery without claiming it was saved as done.
    let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_noread", "requested=done state=unknown outcome=unconfirmed", "changes=0"]).expect("no completion line");
    assert_eq!(level, log::Level::Info);
}

#[tokio::test]
async fn a_run_the_engine_hands_to_a_later_attempt_keeps_its_session() {
    let engine = api::fake::engine(|route, _| match route {
        // Paused: the engine ends this attempt and hands its session to the one that resumes the run.
        "POST /api/tasks/tsk_paused/complete" => (200, json!({ "task": { "state": "cancelled", "sessionCarriesOn": true } }).to_string()),
        _ => (200, json!({ "task": { "state": "cancelled" } }).to_string()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    let with_codex_home = |task: &Task| {
        let (folder, session) = claude_run_files(&rt, task);
        let codex_home = runner_codex::codex_home_dir(&folder);
        std::fs::create_dir_all(&codex_home).unwrap();
        (folder, session, codex_home)
    };
    let paused = task("tsk_paused");
    let (folder, session, codex_home) = with_codex_home(&paused);
    rt.complete(&paused, "cancelled", None, Some("cancelled".into())).await;
    // The host didn't cut it short, and says so; the file with the token goes as ever.
    assert_eq!(engine.bodies("POST /api/tasks/tsk_paused/complete")[0]["interrupted"], json!(false));
    assert!(!folder.join(".scarlet").exists());
    // The CLI sessions stay for the attempt that carries on in them.
    assert!(session.exists(), "the Claude session the resumed attempt carries on in was removed");
    assert!(codex_home.exists(), "the Codex home the resumed attempt carries on in was removed");

    // The same completion with no hand-over is the run's end: they go.
    let stopped = task("tsk_stopped");
    let (_, session, codex_home) = with_codex_home(&stopped);
    rt.complete(&stopped, "cancelled", None, Some("cancelled".into())).await;
    assert!(session_gone(&session) && !codex_home.exists());
}

#[tokio::test]
async fn a_run_paused_on_a_question_keeps_its_session_and_drops_the_file_with_its_token() {
    let engine = api::fake::engine(|route, _| match route {
        "POST /api/tasks/tsk_ask/question" | "POST /api/tasks/tsk_older/question" => (200, r#"{"waiting":true}"#.into()),
        _ => (500, String::new()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    let ask = task("tsk_ask");
    let (folder, session) = claude_run_files(&rt, &ask);
    std::fs::write(folder.join(".scarlet").join("system.md"), "SYS").unwrap();
    rt.ask_editor(&ask, "Keep the cold open?", Some("s1"), &CancellationToken::new(), None).await;
    assert_eq!(engine.bodies("POST /api/tasks/tsk_ask/question"), [json!({ "text": "Keep the cold open?", "sessionId": "s1", "startedAt": "2026-11-08T10:00:00.000Z" })]);
    // Paused, not over: nothing is completed, and the session and folder stay for the answer.
    assert!(engine.bodies("POST /api/tasks/tsk_ask/complete").is_empty());
    assert!(session.exists() && folder.join("artifacts").exists() && folder.join(".scarlet").join("system.md").exists());
    // The file with the engine token doesn't wait two weeks for the folder's prune. The resumed run writes its own.
    assert!(!folder.join(".scarlet").join("mcp.json").exists(), "the token stayed on disk through the pause");

    // An attempt that pauses beside a newer one at the same run leaves the newer one's file alone.
    let older = task("tsk_older");
    let newer = Task { resume_root_id: Some("tsk_older".into()), ..task("tsk_newer") };
    for attempt in [&older, &newer] {
        let run = RunningTask::new(attempt.project_id.clone(), attempt.agent.clone(), CancellationToken::new(), rt.run_dir(attempt));
        rt.running.lock().unwrap().insert(attempt.id.clone(), Arc::new(run));
    }
    let (folder, _) = claude_run_files(&rt, &newer);
    rt.ask_editor(&older, "Which take?", None, &CancellationToken::new(), None).await;
    assert!(folder.join(".scarlet").join("mcp.json").exists(), "the newer attempt's control file was removed");
}

#[test]
fn logs_the_engine_state_when_it_differs_from_the_host_outcome() {
    crate::util::test_log::capture();
    let ack = api::CompletionAck { state: Some("queued".into()), ..Default::default() };
    let request = CompleteTaskRequest { state: "done".into(), if_started_at: None, summary: None,
        error: None, interrupted: false, engine_lost: false };
    log_completion("tsk_changed", &request, Some(&ack), 12);
    assert!(crate::util::test_log::find(&["[host] completion task=tsk_changed", "requested=done state=queued outcome=changed elapsedMs=12"]).is_some());
}

#[tokio::test]
async fn a_completion_the_engine_misses_is_posted_again() {
    crate::util::test_log::capture();
    let posts = std::sync::atomic::AtomicUsize::new(0);
    let engine = api::fake::engine(move |route, _| match route {
        // The engine times out on the first completion it is sent for this task and takes the next.
        "POST /api/tasks/tsk_again/complete" if posts.fetch_add(1, Ordering::SeqCst) == 0 => (408, String::new()),
        // It takes none of these.
        "POST /api/tasks/tsk_lost/complete" | "POST /api/tasks/tsk_closing/complete" => (503, String::new()),
        _ => (200, "{}".into()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());

    let again = task("tsk_again");
    let (folder, session) = claude_run_files(&rt, &again);
    rt.complete(&again, "done", Some("Cut two pauses.".into()), None).await;
    // Forgotten after the one post, the task stays running at the engine, which then calls it interrupted and
    // runs the finished request a second time.
    let sent = engine.bodies("POST /api/tasks/tsk_again/complete");
    assert_eq!(sent.len(), 2, "the completion the engine missed was not posted again");
    // The same completion, tied to its attempt: the engine ignores a copy of one it already has.
    assert_eq!((&sent[1], &sent[1]["ifStartedAt"]), (&sent[0], &json!("2026-11-08T10:00:00.000Z")));
    let (level, _) = crate::util::test_log::find(&["complete failed for task tsk_again: Request Timeout (http_error 408)"]).expect("the missed post was not logged");
    assert_eq!(level, log::Level::Warn);
    // It landed, so the run is over: the file with the token and the session both go.
    assert!(!folder.join(".scarlet").exists() && session_gone(&session));

    // Three tries, then the host lets the task go. The file with the token still goes. The session stays, as
    // an interrupted run's does: the engine takes the run for interrupted and resumes it there.
    let lost = task("tsk_lost");
    let (folder, session) = claude_run_files(&rt, &lost);
    rt.complete(&lost, "done", Some("Cut two pauses.".into()), None).await;
    assert_eq!(engine.bodies("POST /api/tasks/tsk_lost/complete").len(), 3);
    assert!(!folder.join(".scarlet").exists() && folder.join("artifacts").exists());
    assert!(session.exists(), "the session the engine's resume carries on in was removed");

    // While the app quits, one try: quitting doesn't wait on an engine that may already be gone.
    rt.cancel.cancel();
    rt.complete(&task("tsk_closing"), "cancelled", None, Some("host shutting down".into())).await;
    assert_eq!(engine.bodies("POST /api/tasks/tsk_closing/complete").len(), 1);
}

#[tokio::test]
async fn a_run_the_engine_crash_cut_short_is_reported_to_the_engine_that_comes_back() {
    crate::util::test_log::capture();
    // The engine has crashed: nothing answers at its address.
    let gone = format!("http://{}", std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let (stopping, _) = runtime(&gone, dir.path());
    // The host stops with it, and its run ends as interrupted. The one try finds no engine.
    stopping.cancel.cancel();
    stopping.complete(&task("tsk_crash"), "cancelled", None, Some("cancelled".into())).await;

    // The engine is started again, and a host with it. Once registered, it tells the engine the run stopped, so
    // the engine resumes it now instead of after 90 seconds of silence.
    let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
    let (mut started, _) = runtime(&engine.url, dir.path());
    Arc::get_mut(&mut started).unwrap().undelivered = stopping.undelivered.clone();
    let delivering = tokio::spawn(started.clone().deliver_loop());
    until("the interruption to reach the engine", || !engine.bodies("POST /api/tasks/tsk_crash/complete").is_empty()).await;
    let sent = &engine.bodies("POST /api/tasks/tsk_crash/complete")[0];
    assert_eq!((&sent["state"], &sent["interrupted"], &sent["ifStartedAt"]), (&json!("cancelled"), &json!(true), &json!("2026-11-08T10:00:00.000Z")));
    // As a lost worker's: a run that crashes the engine each time it runs stops resuming by itself.
    assert_eq!(sent["engineLost"], json!(true));

    // A run of the old host that ends after the new host registered is reported as it ends.
    stopping.complete(&task("tsk_late"), "cancelled", None, Some("cancelled".into())).await;
    until("the late interruption to reach the engine", || !engine.bodies("POST /api/tasks/tsk_late/complete").is_empty()).await;
    assert_eq!(engine.bodies("POST /api/tasks/tsk_crash/complete").len(), 1, "the interruption was sent twice");
    started.cancel.cancel();
    delivering.await.unwrap();
}

#[tokio::test]
async fn an_attempt_that_ends_beside_a_newer_one_leaves_their_folder_to_it() {
    let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    // The editor stopped a run and resumed it before its CLI had wound down: two attempts at work in one folder.
    let stopped = task("tsk_stopped");
    let resumed = Task { resume_root_id: Some("tsk_stopped".into()), ..task("tsk_resumed") };
    assert_eq!(rt.run_dir(&resumed), rt.run_dir(&stopped));
    for attempt in [&stopped, &resumed] {
        let run = RunningTask::new(attempt.project_id.clone(), attempt.agent.clone(), CancellationToken::new(), rt.run_dir(attempt));
        rt.running.lock().unwrap().insert(attempt.id.clone(), Arc::new(run));
    }
    // The resumed attempt has written its control files, and carries on in the session the first one opened.
    let (folder, session) = claude_run_files(&rt, &resumed);

    // The stopped attempt ends, and reports it as ever. Cleaning up as if alone, it would take the files the
    // resumed one runs on: its CLI starts with no Scarlet tools, or its next resume finds no session.
    rt.complete(&stopped, "cancelled", None, Some("cancelled".into())).await;
    assert_eq!(engine.bodies("POST /api/tasks/tsk_stopped/complete")[0]["state"], json!("cancelled"));
    assert!(folder.join(".scarlet").join("mcp.json").exists(), "the newer attempt's control files were removed");
    assert!(session.exists(), "the session the newer attempt works in was removed");

    // The folder is the newer attempt's to clean when it ends, whether or not the older one is still listed.
    rt.complete(&resumed, "done", Some("Cut two pauses.".into()), None).await;
    assert!(!folder.join(".scarlet").exists() && session_gone(&session) && folder.join("artifacts").exists());
}

#[tokio::test]
async fn a_reclaimed_attempt_for_the_same_task_leaves_its_folder_to_the_newer_one() {
    let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    let first = Task { started_at: Some("2026-04-01T10:00:00Z".into()), ..task("tsk_same") };
    let second = Task { started_at: Some("2026-04-01T10:01:00Z".into()), ..task("tsk_same") };
    let first_run = Arc::new(RunningTask::new(first.project_id.clone(), first.agent.clone(), CancellationToken::new(), rt.run_dir(&first)));
    let second_run = Arc::new(RunningTask::new(second.project_id.clone(), second.agent.clone(), CancellationToken::new(), rt.run_dir(&second)));
    // Simulate launch() inserting the second attempt for the same task id while the first is still winding down.
    rt.running.lock().unwrap().insert(first.id.clone(), first_run.clone());
    if let Some(previous) = rt.running.lock().unwrap().insert(second.id.clone(), second_run.clone()) {
        previous.superseded.store(true, Ordering::SeqCst);
        previous.cancel.cancel();
    }
    assert!(first_run.cancel.is_cancelled(), "replacing a running attempt cancels the prior one");
    let (folder, session) = claude_run_files(&rt, &second);

    // The superseded first attempt finishes and must not delete the second attempt's control files or session.
    rt.complete_attempt(&first, "cancelled", None, Some("cancelled".into()), Some(&first_run)).await;
    assert!(folder.join(".scarlet").join("mcp.json").exists(), "superseded attempt removed the newer attempt's control files");
    assert!(session.exists(), "superseded attempt removed the newer attempt's Claude session");

    // When the newer attempt finishes, it owns cleanup of the shared folder.
    rt.complete_attempt(&second, "done", Some("Done.".into()), None, Some(&second_run)).await;
    assert!(!folder.join(".scarlet").exists() && session_gone(&session) && folder.join("artifacts").exists());
}

#[tokio::test]
async fn a_task_claimed_as_the_app_quits_is_handed_back_without_starting_a_cli() {
    let engine = api::fake::engine(|_, _| (200, "{}".into())).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    let cancel = rt.cancel.child_token();
    rt.cancel.cancel();
    rt.run_task(unrunnable("tsk_quit"), cancel).await;
    let sent = &engine.bodies("POST /api/tasks/tsk_quit/complete")[0];
    assert_eq!((&sent["state"], &sent["error"], &sent["interrupted"]), (&json!("cancelled"), &json!("host shutting down"), &json!(true)));
    // Nothing was prepared for it: no prompt asked for, no folder made.
    assert!(!engine.seen.lock().unwrap().iter().any(|(route, _)| route.contains("/prompt")));
    assert!(!rt.run_dir(&task("tsk_quit")).exists());
}

#[tokio::test]
async fn a_task_whose_prompt_cannot_be_fetched_fails_with_the_reason() {
    let engine = api::fake::engine(|route, _| match route {
        r if r.starts_with("GET /api/tasks/tsk_noprompt/prompt") => (409, r#"{"error":{"code":"conflict","message":"The project is closed"}}"#.into()),
        _ => (200, "{}".into()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _sent) = runtime(&engine.url, dir.path());
    let task = unrunnable("tsk_noprompt");
    rt.run_task(task.clone(), CancellationToken::new()).await;
    // The prompt was asked for with the run's own artifacts folder.
    let asked = engine.seen.lock().unwrap().iter().find(|(route, _)| route.contains("/prompt")).unwrap().0.clone();
    assert!(asked.contains(&format!("workDir={}", api::urlencode(&rt.run_dir(&task).join("artifacts").to_string_lossy()))), "{asked}");
    // The editor sees why, in the task's events and on the task.
    let event = &engine.bodies("POST /api/tasks/tsk_noprompt/events")[0];
    assert_eq!((&event["type"], &event["text"]), (&json!("error"), &json!("Could not prepare task: The project is closed (conflict 409)")));
    let done = &engine.bodies("POST /api/tasks/tsk_noprompt/complete")[0];
    assert_eq!((&done["state"], &done["error"]), (&json!("failed"), &json!("The project is closed (conflict 409)")));
    // None of the CLI's control files is left in the folder made for it.
    let left = std::fs::read_dir(rt.run_dir(&task)).map(|dir| dir.flatten().filter(|e| e.file_name() != "artifacts").count()).unwrap_or(0);
    assert_eq!(left, 0);
}

#[tokio::test]
async fn a_run_reports_its_start_its_failure_and_its_end_in_that_order() {
    crate::util::test_log::capture();
    let engine = api::fake::engine(|route, _| match route {
        r if r.starts_with("GET /api/tasks/tsk_flow/prompt") => (200, r#"{"systemPrompt":"SYSTEM","instruction":"Cut the pauses"}"#.into()),
        "POST /api/tasks/tsk_flow/complete" => (200, r#"{"task":{"state":"failed"}}"#.into()),
        _ => (200, "{}".into()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _sent) = runtime(&engine.url, dir.path());
    rt.run_task(unrunnable("tsk_flow"), CancellationToken::new()).await;
    let routes: Vec<String> = engine.seen.lock().unwrap().iter().map(|(route, _)| route.split('?').next().unwrap().to_string()).collect();
    assert_eq!(routes, [
        "GET /api/tasks/tsk_flow/prompt",
        // Saved before the CLI could do anything, so a claim that never started can be told from one that did.
        "POST /api/tasks/tsk_flow/events",
        "POST /api/tasks/tsk_flow/events",
        "POST /api/tasks/tsk_flow/complete",
    ]);
    let events = engine.bodies("POST /api/tasks/tsk_flow/events");
    assert_eq!((&events[0]["type"], &events[0]["text"]), (&json!("log"), &json!("Starting the editing agent.")));
    assert_eq!((&events[1]["type"], &events[1]["text"]), (&json!("error"), &json!("no runner for agent \"storyboard\"")));
    let done = &engine.bodies("POST /api/tasks/tsk_flow/complete")[0];
    assert_eq!((&done["state"], &done["error"], &done["interrupted"]), (&json!("failed"), &json!("no runner for agent \"storyboard\""), &json!(false)));
    // Both ends of the run are in the log under the task's id.
    assert!(crate::util::test_log::find(&["task tsk_flow: storyboard ended (exit code None)"]).is_some());
    let (level, _) = crate::util::test_log::find(&["[host] completion task=tsk_flow", "requested=failed state=failed outcome=accepted"]).expect("no failure line");
    assert_eq!(level, log::Level::Warn);
}

#[tokio::test]
async fn a_run_whose_start_cannot_be_saved_never_starts_its_cli() {
    let engine = api::fake::engine(|route, _| match route {
        r if r.starts_with("GET /api/tasks/tsk_nostart/prompt") => (200, r#"{"systemPrompt":"SYSTEM","instruction":"Cut the pauses"}"#.into()),
        "POST /api/tasks/tsk_nostart/events" => (409, r#"{"error":{"code":"conflict","message":"The task was cancelled"}}"#.into()),
        _ => (200, "{}".into()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    rt.run_task(unrunnable("tsk_nostart"), CancellationToken::new()).await;
    // One event tried, and the task failed with the engine's reason. A run that got as far as its CLI
    // would have posted a second event.
    assert_eq!(engine.bodies("POST /api/tasks/tsk_nostart/events").len(), 1);
    let done = &engine.bodies("POST /api/tasks/tsk_nostart/complete")[0];
    assert_eq!((&done["state"], &done["error"]), (&json!("failed"), &json!("The task was cancelled (conflict 409)")));
}

#[tokio::test]
async fn an_event_carries_the_time_the_cli_wrote_it_not_the_time_it_was_sent() {
    // A slow engine: it takes 300 ms to answer the first event it is sent.
    let slow = AtomicBool::new(true);
    let engine = api::fake::engine(move |route, _| {
        if route == "POST /api/tasks/tsk_late/events" && slow.swap(false, Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(300));
        }
        (200, "{}".into())
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _sent) = runtime(&engine.url, dir.path());
    let (sink, consumer) = rt.forward_events("tsk_late", Some("2026-11-08T10:00:00.000Z".into()));
    // The CLI writes two lines back to back, then asks its question and ends.
    let before = now_iso();
    sink(RunnerEvent::new("tool", "scarlet.timeline_get"));
    sink(RunnerEvent::new("log", "Read the timeline."));
    let after = now_iso();
    sink(RunnerEvent::new("question", "Which take?"));
    sink(RunnerEvent::new("result", "Done."));
    drop(sink);
    drain_events("tsk_late", consumer).await;
    // The question and the result reach the engine another way. The rest is sent on in the order written.
    let posted = engine.bodies("POST /api/tasks/tsk_late/events");
    assert!(posted.iter().all(|event| event["startedAt"] == "2026-11-08T10:00:00.000Z"));
    assert_eq!(posted.iter().map(|event| event["text"].as_str().unwrap()).collect::<Vec<_>>(), ["scarlet.timeline_get", "Read the timeline."]);
    // Each carries the moment it was written. The second waited behind the first for its turn to be sent: stamped
    // then, a backlog would bunch at one instant, later than events the engine saved meanwhile.
    let stamped: Vec<&str> = posted.iter().map(|event| event["at"].as_str().unwrap()).collect();
    assert!(stamped.iter().all(|at| before.as_str() <= *at && *at <= after.as_str()), "written between {before} and {after}, stamped {stamped:?}");
}

#[tokio::test]
async fn prepares_a_private_folder_and_an_mcp_identity_for_each_attempt() {
    let engine = api::fake::engine(|route, _| match route {
        r if r.contains("/prompt") => (200, r#"{"systemPrompt":"SYSTEM","instruction":"The editor said yes","resumeSession":"s1"}"#.into()),
        _ => (200, "{}".into()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, _) = runtime(&engine.url, dir.path());
    {
        let rt = Arc::get_mut(&mut rt).unwrap();
        rt.timeout = Some(Duration::from_secs(45 * 60));
        rt.models = HashMap::from([("claude".to_string(), "opus".to_string())]);
    }
    // A second attempt at an interrupted run: it works in the first attempt's folder, under its own id.
    let attempt = Task { resume_root_id: Some("tsk_first".into()), ..task("tsk_second") };
    let prepared = rt.prepare(&attempt, true).await.unwrap();
    assert_eq!(prepared.cwd, rt.task_dir("prj_1", "tsk_first"));
    assert_ne!(prepared.cwd, rt.task_dir("prj_1", "tsk_second"));
    assert_eq!((prepared.system_prompt.as_str(), prepared.instruction.as_str(), prepared.resume_session.as_deref()), ("SYSTEM", "The editor said yes", Some("s1")));
    let artifacts = prepared.cwd.join("artifacts");
    assert!(artifacts.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&prepared.cwd).unwrap().permissions().mode() & 0o777, 0o700);
    }
    // The MCP server it starts speaks for this attempt, with the model from settings when the task names none.
    let env = &prepared.mcp.env;
    let value = |key: &str| env.get(key).map(String::as_str);
    assert_eq!((value("SCARLET_TASK"), value("SCARLET_PROJECT"), value("SCARLET_MODEL")), (Some("tsk_second"), Some("prj_1"), Some("opus")));
    assert_eq!((value("SCARLET_TASK_STARTED_AT"), value("SCARLET_TOKEN")), (Some("2026-11-08T10:00:00.000Z"), Some("sct_test")));
    assert_eq!((value("SCARLET_SERVER"), value("SCARLET_WORKDIR")), (Some(engine.url.as_str()), Some(artifacts.to_string_lossy().as_ref())));
    // The engine is asked for a fresh prompt, and told the cap on the run so the prompt can say so.
    let asked = engine.seen.lock().unwrap()[0].0.clone();
    assert!(asked.starts_with("GET /api/tasks/tsk_second/prompt?workDir=") && asked.ends_with("&fresh=1&timeLimit=45"), "{asked}");
    // Task folders are named by a hash, so neither id can steer a path.
    let hostile = rt.task_dir("../../prj", "../tsk");
    assert_eq!(hostile.parent(), Some(dir.path().join("tasks-v2").as_path()));
    assert!(hostile.file_name().unwrap().to_string_lossy().chars().all(|c| c.is_ascii_hexdigit()));
}

#[tokio::test]
async fn the_claim_loop_registers_again_when_forgotten_and_runs_what_it_claims() {
    let claims = std::sync::atomic::AtomicUsize::new(0);
    let engine = api::fake::engine(move |route, _| match route {
        "POST /api/hosts/host_1/claim?wait=25" => (404, r#"{"error":{"code":"not_found","message":"No such host"}}"#.into()),
        "POST /api/hosts/register" => (200, r#"{"host":{"id":"host_2","name":"test (desktop)"}}"#.into()),
        // The first claim under the new id gets a task, the ones after it nothing.
        "POST /api/hosts/host_2/claim?wait=25" | "POST /api/hosts/host_2/claim?wait=0" if claims.fetch_add(1, Ordering::SeqCst) == 0 => {
            (200, json!({ "task": { "id": "tsk_claimed", "projectId": "prj_1", "agent": "storyboard", "instruction": "x" } }).to_string())
        }
        r if r.contains("/claim?") => (200, r#"{"task":null}"#.into()),
        r if r.contains("/prompt") => (500, r#"{"error":{"code":"internal","message":"no prompt"}}"#.into()),
        _ => (200, "{}".into()),
    }).await;
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime(&engine.url, dir.path());
    *rt.agents.write().await = vec![
        AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), ..Default::default() },
        AgentAvailability { id: "codex".into(), installed: true, logged_in: Some(false), ..Default::default() },
        AgentAvailability { id: "gemini".into(), installed: false, ..Default::default() },
    ];
    let looping = tokio::spawn(rt.clone().claim_loop());
    until("the host to register again", || rt.host_id.lock().unwrap().as_deref() == Some("host_2")).await;
    // Only an installed, signed-in assistant is offered for work.
    let first = &engine.bodies("POST /api/hosts/host_1/claim?wait=25")[0];
    assert_eq!((&first["agents"], &first["desktopPid"]), (&json!(["claude"]), &json!(std::process::id())));
    // It waits five seconds after a failed claim unless something wakes it.
    rt.wake.notify_one();
    until("the claimed task to be completed", || !engine.bodies("POST /api/tasks/tsk_claimed/complete").is_empty()).await;
    until("the task to leave the running list", || rt.running.lock().unwrap().is_empty()).await;
    let status = rt.status();
    assert_eq!((status.connected, status.error, status.running.len()), (true, None, 0));
    rt.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(10), looping).await.expect("the loop did not stop").unwrap();
}

#[tokio::test]
async fn offers_only_assistants_with_a_free_slot() {
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime("http://127.0.0.1:1", dir.path());
    let ready = |id: &str| AgentAvailability { id: id.into(), installed: true, logged_in: Some(true), ..Default::default() };
    // "cursor" is not a CLI this host can run, whatever detection says.
    *rt.agents.write().await = vec![ready("claude"), ready("codex"), ready("cursor")];
    assert_eq!(rt.idle_agents().await, (vec!["claude".to_string(), "codex".to_string()], false));
    // One task per assistant here: claude is full, and the loop is told so it claims without a long wait.
    let run = Arc::new(RunningTask::new("prj_1".into(), "claude".into(), CancellationToken::new(), PathBuf::new()));
    rt.running.lock().unwrap().insert("tsk_1".into(), run);
    assert_eq!(rt.idle_agents().await, (vec!["codex".to_string()], true));
    // A full request slot leaves claude's side checks free: an edit's own checks never wait behind it.
    assert_eq!(rt.check_agents().await, (vec!["claude".to_string(), "codex".to_string()], false));
}

#[tokio::test]
async fn side_checks_run_in_slots_of_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let (rt, _) = runtime("http://127.0.0.1:1", dir.path());
    let ready = |id: &str| AgentAvailability { id: id.into(), installed: true, logged_in: Some(true), ..Default::default() };
    *rt.agents.write().await = vec![ready("gemini")];
    let check = || Arc::new(RunningTask::new("prj_1".into(), "gemini".into(), CancellationToken::new(), PathBuf::new()).side_check(true));
    // One request slot and two check slots here (max_parallel 1). Checks never take the request's slot.
    assert_eq!(side_check_slots(1), 2);
    rt.running.lock().unwrap().insert("chk_1".into(), check());
    assert_eq!(rt.idle_agents().await, (vec!["gemini".to_string()], false));
    assert_eq!(rt.check_agents().await, (vec!["gemini".to_string()], false));
    rt.running.lock().unwrap().insert("chk_2".into(), check());
    assert_eq!(rt.idle_agents().await, (vec!["gemini".to_string()], false));
    assert_eq!(rt.check_agents().await, (vec![], true));
    // And a request doesn't take a check's slot.
    let run = Arc::new(RunningTask::new("prj_1".into(), "gemini".into(), CancellationToken::new(), PathBuf::new()));
    rt.running.lock().unwrap().insert("tsk_1".into(), run);
    assert_eq!(rt.idle_agents().await, (vec![], true));
    rt.running.lock().unwrap().remove("chk_1");
    assert_eq!(rt.check_agents().await, (vec!["gemini".to_string()], false));
}

#[test]
fn side_check_kinds_and_slots_match_the_engine() {
    assert!(is_side_check("area_check") && is_side_check("learning_check"));
    assert!(!is_side_check("skill_edit") && !is_side_check("edit") && !is_side_check("revise"));
    assert_eq!((side_check_slots(1), side_check_slots(3), side_check_slots(8)), (2, 6, 12));
}

/// The engine's `model-catalog` as a script, on a host that finds every assistant on its PATH: it prints the
/// list in `<script>.<assistant>.json` and fails while there is none. It notes each assistant it is asked
/// about in `<script>.asked`, and waits for as long as `<script>.hold` is there. Gives the script.
#[cfg(unix)]
fn catalog_script(rt: &mut Arc<HostRuntime>) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let rt = Arc::get_mut(rt).unwrap();
    // Scarlet's own folder of assistants is on every child's PATH, so these are found where none is installed.
    // They are only looked up: the script never starts the assistant it is asked about.
    let bin = crate::util::assistant_prefix(&rt.paths.home).join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for cli in CLI_AGENTS {
        std::fs::write(bin.join(cli), "").unwrap();
        std::fs::set_permissions(bin.join(cli), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let script = rt.paths.work_dir.join("engine.sh");
    std::fs::write(&script, "echo \"$2\" >> \"$0.asked\"\nwhile [ -e \"$0.hold\" ]; do sleep 0.05; done\nexec cat \"$0.$2.json\"\n").unwrap();
    rt.mcp = McpLauncher { program: "/bin/sh".into(), prefix_args: vec![script.to_string_lossy().into_owned()] };
    script
}

#[cfg(unix)]
#[tokio::test]
async fn asks_again_for_a_model_list_it_could_not_read() {
    crate::util::test_log::capture();
    let engine = api::fake::engine(|_, _| (200, r#"{"cancelled":[]}"#.into())).await;
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, sent) = runtime(&engine.url, dir.path());
    let script = catalog_script(&mut rt);
    let beside = |name: &str| PathBuf::from(format!("{}.{name}", script.display()));
    let asked = || std::fs::read_to_string(beside("asked")).unwrap_or_default();
    let heartbeats = || engine.bodies("POST /api/hosts/host_1/heartbeat");
    let ready = |id: &str| AgentAvailability { id: id.into(), installed: true, logged_in: Some(true), ..Default::default() };
    // At launch Claude's list could not be read. ChatGPT's was, and Gemini is signed out: neither is asked about.
    let at_launch = || vec![ready("claude"), AgentAvailability { models: Some(vec!["gpt-5.5".into()]), ..ready("codex") }, AgentAvailability { logged_in: Some(false), ..ready("gemini") }];
    *rt.agents.write().await = at_launch();

    // It still can't be read: Claude is left without a list, and neither the engine nor the window is told anything.
    assert!(rt.load_missing_catalogs().await);
    assert_eq!(asked(), "claude\n", "the model list was not asked for again");
    assert!(heartbeats().is_empty() && sent.lock().unwrap().is_empty());

    // Now it can. Claude has its models, so the picker has one to offer.
    std::fs::write(beside("claude.json"), r#"{"models":["opus","sonnet"],"model":"opus","modelLabels":{"opus":"Opus"},"modelOptions":{"opus":{"efforts":[]}}}"#).unwrap();
    assert!(!rt.load_missing_catalogs().await);
    let claude = rt.agents.read().await[0].clone();
    assert_eq!((claude.models, claude.model.as_deref()), (Some(vec!["opus".to_string(), "sonnet".to_string()]), Some("opus")));
    assert_eq!((claude.model_labels.get("opus").map(String::as_str), claude.model_options.contains_key("opus")), (Some("Opus"), true));
    // The engine is sent the list at once, and the window is told.
    assert_eq!(heartbeats()[0]["agents"][0]["models"], json!(["opus", "sonnet"]));
    let (event, status) = sent.lock().unwrap().last().cloned().unwrap();
    assert_eq!((event.as_str(), &status["agents"][0]["models"]), ("host://status", &json!(["opus", "sonnet"])));
    let (level, _) = crate::util::test_log::find(&["model list read on a later try", "claude (signed in, 2 models)"]).expect("no log line for the list");
    assert_eq!(level, log::Level::Info);
    // With none missing, nobody is asked.
    assert!(!rt.load_missing_catalogs().await);
    assert_eq!((asked().as_str(), heartbeats().len()), ("claude\nclaude\n", 1));

    // A refresh that finishes while a list is being asked for has the newer answer, and keeps it.
    *rt.agents.write().await = at_launch();
    std::fs::write(beside("hold"), "").unwrap();
    let asking = tokio::spawn({
        let rt = rt.clone();
        async move { rt.load_missing_catalogs().await }
    });
    until("the list to be asked for", || asked().lines().count() == 3).await;
    rt.agents.write().await[0].models = Some(vec!["haiku".into()]);
    std::fs::remove_file(beside("hold")).unwrap();
    assert!(!asking.await.unwrap());
    assert_eq!(rt.agents.read().await[0].models, Some(vec!["haiku".to_string()]));
    assert_eq!(heartbeats().len(), 1, "a list nobody took was sent to the engine");

    // A host that has stopped tells nobody: its engine may be gone, and the window shows the host after it.
    *rt.agents.write().await = at_launch();
    let told = sent.lock().unwrap().len();
    rt.cancel.cancel();
    assert!(!rt.load_missing_catalogs().await);
    assert_eq!((heartbeats().len(), sent.lock().unwrap().len()), (1, told));
}

#[cfg(unix)]
#[tokio::test]
async fn keeps_asking_for_a_missing_model_list_until_it_is_read_or_the_host_stops() {
    const SOON: [Duration; 3] = [Duration::from_millis(20); 3];
    const NEVER: [Duration; 1] = [Duration::from_secs(3600)];
    let engine = api::fake::engine(|_, _| (200, r#"{"cancelled":[]}"#.into())).await;
    let dir = tempfile::tempdir().unwrap();
    let (mut rt, _) = runtime(&engine.url, dir.path());
    let script = catalog_script(&mut rt);
    let beside = |name: &str| PathBuf::from(format!("{}.{name}", script.display()));
    let tries = || std::fs::read_to_string(beside("asked")).unwrap_or_default().lines().count();
    let without_a_list = || vec![AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), ..Default::default() }];
    let run = |waits: &'static [Duration]| tokio::time::timeout(Duration::from_secs(30), rt.clone().catalog_loop(waits));
    *rt.agents.write().await = without_a_list();

    // The list can't be read: it is asked for after each wait, and then no more.
    run(&SOON).await.expect("the loop did not end");
    assert_eq!(tries(), 3, "the model list was not asked for again");
    assert!(rt.agents.read().await[0].models.is_none());

    // Once it is read nothing is left to ask for, and the loop ends there.
    std::fs::write(beside("claude.json"), r#"{"models":["opus"],"modelLabels":{},"modelOptions":{}}"#).unwrap();
    run(&SOON).await.expect("the loop did not end");
    assert_eq!((tries(), rt.agents.read().await[0].models.clone()), (4, Some(vec!["opus".to_string()])));
    assert_eq!(engine.bodies("POST /api/hosts/host_1/heartbeat").len(), 1);
    // One that starts with nothing missing asks nobody.
    run(&SOON).await.expect("the loop did not end");
    assert_eq!(tries(), 4);

    // A host that stops is not kept waiting for the next try.
    *rt.agents.write().await = without_a_list();
    rt.cancel.cancel();
    run(&NEVER).await.expect("the loop outlived the host");
    assert_eq!(tries(), 4);
}

#[test]
fn reads_what_to_do_with_a_run_off_its_result() {
    let ten = Some(Duration::from_secs(600));
    let read = |result: &RunResult| outcome(result, false, None, ten);
    let said = RunResult { summary: "Cut two pauses.".into(), ..Default::default() };

    // Finished: its summary, or a plain "Done." when it said nothing.
    assert_eq!(read(&RunResult { ok: true, ..said.clone() }), Outcome::Done { summary: "Cut two pauses.".into() });
    assert_eq!(read(&RunResult { ok: true, ..Default::default() }), Outcome::Done { summary: "Done.".into() });

    // Cancelled wins over everything, whether the runner saw it or only the host did.
    assert_eq!(read(&RunResult { aborted: true, ok: true, question: Some("Keep?".into()), ..said.clone() }), Outcome::Cancelled { summary: Some("Cut two pauses.".into()) });
    assert_eq!(outcome(&RunResult { ok: true, ..Default::default() }, true, None, ten), Outcome::Cancelled { summary: None });

    // A question the result carries pauses the task. Even a run that failed after asking pauses: the editor's answer
    // starts the next attempt.
    assert_eq!(read(&RunResult { ok: true, question: Some("Keep the cold open?".into()), ..Default::default() }), Outcome::Question("Keep the cold open?".into()));
    assert_eq!(read(&RunResult { error: Some("exited 1".into()), question: Some("Which take?".into()), ..Default::default() }), Outcome::Question("Which take?".into()));

    // Failed on its own: the runner's reason, and nothing to resume.
    assert_eq!(read(&RunResult { error: Some("claude exited with code 1".into()), ..said.clone() }), Outcome::Failed { error: "claude exited with code 1".into(), summary: Some("Cut two pauses.".into()), stopped: false });
    assert_eq!(read(&RunResult::default()), Outcome::Failed { error: "agent failed".into(), summary: None, stopped: false });

    // Stopped by the host: the reason names the limit, and the editor can resume.
    let stalled = RunResult { timed_out: true, stalled: true, error: Some("stalled".into()), ..Default::default() };
    assert_eq!(read(&stalled), Outcome::Failed { error: "stalled: the agent wrote nothing for 10 minutes".into(), summary: None, stopped: true });
    let capped = RunResult { timed_out: true, error: Some("timed out".into()), ..Default::default() };
    assert_eq!(outcome(&capped, false, Some(Duration::from_secs(45 * 60)), ten), Outcome::Failed { error: "timed out after 45 minutes, the limit for one agent run".into(), summary: None, stopped: true });
    // A timeout with no cap set here keeps the runner's own word for it.
    assert_eq!(read(&capped), Outcome::Failed { error: "timed out".into(), summary: None, stopped: true });
}

#[test]
fn describes_the_assistants_it_found_on_one_line() {
    let found = [
        AgentAvailability { id: "claude".into(), installed: true, logged_in: Some(true), auth: Some("subscription".into()), version: Some("2.1.316".into()), models: Some(vec!["opus".into(), "sonnet".into()]), ..Default::default() },
        AgentAvailability { id: "codex".into(), installed: true, logged_in: Some(false), ..Default::default() },
        AgentAvailability { id: "gemini".into(), installed: false, ..Default::default() },
    ];
    assert_eq!(describe_agents(&found), "claude 2.1.316 (signed in, subscription, 2 models); codex (signed out, no model list); gemini not installed");
}

#[test]
fn keeps_one_host_id_however_many_ports_the_engine_has_had() {
    // The engine takes a new port at each launch, and the id is filed under its address.
    let mut cfg = AppConfig::default();
    for port in 50_000..50_003 {
        cfg.host_ids.insert(format!("http://127.0.0.1:{port}"), "host_old".into());
    }
    assert!(remember_host_id(&mut cfg, "http://127.0.0.1:51000", "host_new"));
    assert_eq!(cfg.host_ids, HashMap::from([("http://127.0.0.1:51000".to_string(), "host_new".to_string())]));
    // Nothing to save when it is already the only one.
    assert!(!remember_host_id(&mut cfg, "http://127.0.0.1:51000", "host_new"));
    // A file from an older version is pruned even when this launch's entry is already there.
    cfg.host_ids.insert("http://127.0.0.1:50000".into(), "host_old".into());
    assert!(remember_host_id(&mut cfg, "http://127.0.0.1:51000", "host_new"));
    assert_eq!(cfg.host_ids.len(), 1);
}

#[test]
fn zero_minutes_turns_a_limit_off() {
    let limits = |timeout, stall| run_limits(&AppConfig { timeout_minutes: timeout, stall_minutes: stall, ..Default::default() });
    let minutes = |m: u64| Some(Duration::from_secs(m * 60));
    // Unset: no cap on a working agent, and the default stall window.
    assert_eq!(limits(None, None), (None, minutes(DEFAULT_STALL_MINUTES)));
    assert_eq!(limits(Some(45), Some(3)), (minutes(45), minutes(3)));
    // The standalone host reads 0 as "off". Here it used to mean one minute.
    assert_eq!(limits(Some(0), Some(0)), (None, None));
    // A number too large to count in seconds is a limit that never comes, not a crash.
    assert_eq!(limits(Some(u64::MAX), None).0, Some(Duration::from_secs(u64::MAX)));
}

#[test]
fn stop_reasons_name_the_limit() {
    assert_eq!(timed_out_reason(Duration::from_secs(45 * 60)), "timed out after 45 minutes, the limit for one agent run");
    assert_eq!(timed_out_reason(Duration::from_secs(30)), "timed out after 1 minute, the limit for one agent run");
    assert_eq!(stalled_reason(Duration::from_secs(DEFAULT_STALL_MINUTES * 60)), "stalled: the agent wrote nothing for 10 minutes");
}

#[tokio::test]
async fn missed_cancellation_stops_only_the_cancelled_cli_on_heartbeat() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api = Api::new(&format!("http://{}", listener.local_addr().unwrap()), None);
    let engine = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut received = [0u8; 2048];
        assert!(stream.read(&mut received).await.unwrap() > 0);
        let body = r#"{"cancelled":["stopped"]}"#;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let worker = || Arc::new(RunningTask::new("new".into(), "codex".into(), CancellationToken::new(), PathBuf::new()));
    let (stopped, active) = (worker(), worker());
    let running = StdMutex::new(HashMap::from([("stopped".into(), stopped.clone()), ("active".into(), active.clone())]));
    heartbeat_workers(&api, "host", &[], &running).await.unwrap();
    engine.await.unwrap();
    assert!(stopped.cancel.is_cancelled());
    assert!(!active.cancel.is_cancelled());
}

#[test]
fn finished_task_folders_keep_only_artifacts_and_old_ones_are_pruned() {
    let root = tempfile::tempdir().unwrap();
    let task = root.path().join("tasks-v2").join("t1");
    std::fs::create_dir_all(task.join(".scarlet")).unwrap();
    std::fs::create_dir_all(task.join("artifacts")).unwrap();
    std::fs::write(task.join(".scarlet").join("mcp.json"), "token").unwrap();
    std::fs::write(task.join("AGENTS.md"), "SYS").unwrap();
    std::fs::write(task.join("artifacts").join("cut.otio"), "kept").unwrap();
    remove_control_files(&task).unwrap();
    let names: Vec<_> = std::fs::read_dir(&task).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["artifacts"]);
    // A resumed attempt's own folder has no artifacts and goes away entirely.
    let attempt = root.path().join("tasks-v2").join("t2");
    std::fs::create_dir_all(attempt.join(".scarlet")).unwrap();
    remove_control_files(&attempt).unwrap();
    assert!(!attempt.exists());

    let tasks_root = root.path().join("tasks-v2");
    let day = Duration::from_secs(86_400);
    let now = std::time::SystemTime::now();
    // A later retry rewrote an artifact; the folders themselves look old.
    let in_use = tasks_root.join("t3");
    std::fs::create_dir_all(in_use.join("artifacts")).unwrap();
    let edit = std::fs::File::create(in_use.join("artifacts").join("edit.otio")).unwrap();
    edit.set_modified(now + 10 * day).unwrap();
    prune_task_dirs(&tasks_root, now + 13 * day, None);
    assert!(task.exists());
    prune_task_dirs(&tasks_root, now + 15 * day, None);
    assert!(!task.exists());
    assert!(in_use.exists());
}

#[test]
fn removes_only_the_claude_project_folder_named_after_the_task_folder() {
    let home = tempfile::tempdir().unwrap();
    // Escaping checked against Claude Code 2.1.316: real path, every non-alphanumeric character as "-".
    let cwd = Path::new("/Users/me/Library/Application Support/com.forwardfuture.scarlet/work/tasks-v2/ab12");
    let name = "-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-ab12";
    let claude = home.path().join(".claude");
    assert_eq!(claude_project_dir(cwd, &claude), Some(claude.join("projects").join(name)));
    let projects = home.path().join(".claude").join("projects");
    for n in [name, "-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-cd34", "-Users-me-project"] {
        std::fs::create_dir_all(projects.join(n)).unwrap();
    }
    // Claude Code 2.1.316 keeps a session's to-do list apart from its transcript, in ~/.claude/tasks/<session id>.
    let (run, other) = ("3f1c2b9e-0000-4000-8000-000000000000", "9a8b7c6d-1111-4000-8000-000000000000");
    std::fs::write(projects.join(name).join(format!("{run}.jsonl")), "{}").unwrap();
    std::fs::write(projects.join("-Users-me-project").join(format!("{other}.jsonl")), "{}").unwrap();
    // Two files in the task's project folder that are no session. Read as an id, the second would name ~/.claude.
    for stray in ["notes.jsonl", "...jsonl"] {
        std::fs::write(projects.join(name).join(stray), "{}").unwrap();
    }
    let lists = home.path().join(".claude").join("tasks");
    for list in [run, other, "notes"] {
        std::fs::create_dir_all(lists.join(list)).unwrap();
        std::fs::write(lists.join(list).join("1.json"), "{}").unwrap();
    }
    remove_claude_sessions(Path::new("/Users/me/project"), &claude).unwrap(); // not a task folder
    remove_claude_sessions(cwd, &claude).unwrap();
    let names = |dir: &Path| {
        let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        names
    };
    assert_eq!(names(&projects), ["-Users-me-Library-Application-Support-com-forwardfuture-scarlet-work-tasks-v2-cd34", "-Users-me-project"]);
    // The run's list goes with its session. Another session's stays, and so does a folder that isn't named by a session id.
    assert_eq!(names(&lists), [other, "notes"]);
}

#[test]
fn finds_claude_sessions_wherever_claude_code_keeps_them() {
    let home = Path::new("/Users/me");
    let env = |dir: Option<&str>| dir.map(|d| ("CLAUDE_CONFIG_DIR".to_string(), d.to_string())).into_iter().collect::<HashMap<_, _>>();
    assert_eq!(claude_config_dir(&env(None), home), Some(home.join(".claude")));
    // A folder of the user's own: its sessions are removed there, not left for ever.
    let own = std::env::temp_dir().join("claude-config");
    assert_eq!(claude_config_dir(&env(Some(own.to_str().unwrap())), home), Some(own));
    // One named from wherever the CLI starts, or empty, is nowhere Scarlet can speak for.
    assert_eq!(claude_config_dir(&env(Some("relative/claude")), home), None);
    assert_eq!(claude_config_dir(&env(Some("")), home), None);

    // Removing and pruning both look in that folder.
    let root = tempfile::tempdir().unwrap();
    let claude = root.path().join("my-claude");
    let task = root.path().join("tasks-v2").join("t1");
    std::fs::create_dir_all(&task).unwrap();
    let real = real_path(&task).unwrap();
    let session = claude_project_dir(&real, &claude).unwrap();
    assert!(session.starts_with(claude.join("projects")));
    std::fs::create_dir_all(&session).unwrap();
    remove_claude_sessions(&real, &claude).unwrap();
    assert!(!session.exists());
    std::fs::create_dir_all(&session).unwrap();
    prune_task_dirs(&root.path().join("tasks-v2"), std::time::SystemTime::now() + Duration::from_secs(15 * 86_400), Some(&claude));
    assert!(!session.exists() && !task.exists());
}

#[test]
fn finds_the_claude_project_folder_of_a_path_too_long_to_name_whole() {
    let root = tempfile::tempdir().unwrap();
    let claude = root.path().join(".claude");
    let projects = claude.join("projects");
    // Two task folders deep enough that Claude Code's names keep only their first 200 characters, which they share.
    let deep = Path::new("/").join("w".repeat(190)).join("tasks-v2");
    let (mine, other) = (deep.join("aaaa1111"), deep.join("aaaa2222"));
    let full: String = mine.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    assert!(full.len() > 200);
    let prefix = &full[..200];
    // Claude Code adds a hash of the path. Each folder's sessions name the cwd they ran in.
    let session = |hash: &str, cwd: &Path| {
        let dir = projects.join(format!("{prefix}-{hash}"));
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [json!({"type":"summary","summary":"Trim"}), json!({"type":"user","cwd": cwd.to_string_lossy(),"sessionId":"s"})];
        std::fs::write(dir.join("3f1c2b9e-0000-4000-8000-000000000000.jsonl"), lines.map(|l| l.to_string()).join("\n")).unwrap();
        dir
    };
    let theirs = session("1x2y3z", &other);
    let ours = session("9q8r7s", &mine);
    // A folder with no session to say whose it is, and one whose name goes on past a hash, are no one's.
    std::fs::create_dir_all(projects.join(format!("{prefix}-abc"))).unwrap();
    std::fs::create_dir_all(projects.join(format!("{prefix}-abc.d"))).unwrap();
    assert_eq!(claude_project_dir(&mine, &claude), Some(ours.clone()));
    assert_eq!(claude_project_dir(&other, &claude), Some(theirs.clone()));
    assert_eq!(claude_project_dir(&deep.join("aaaa3333"), &claude), None);
    remove_claude_sessions(&mine, &claude).unwrap();
    assert!(!ours.exists() && theirs.exists());
}

#[test]
fn mcp_spec_points_at_the_engine_mcp_subcommand() {
    let sidecar = McpLauncher { program: "C:\\Scarlet\\scarlet-engine.exe".into(), prefix_args: vec![] };
    let spec = sidecar.spec("http://127.0.0.1:5123", "sct_t", "prj_1", Some("task_1"), "claude", Some("opus"), "C:\\work\\task_1");
    assert_eq!(spec.command, "C:\\Scarlet\\scarlet-engine.exe");
    assert_eq!(spec.args, ["mcp"]);
    assert_eq!(spec.env.get("SCARLET_SERVER").map(String::as_str), Some("http://127.0.0.1:5123"));
    assert_eq!(spec.env.get("SCARLET_TOKEN").map(String::as_str), Some("sct_t"));
    assert_eq!(spec.env.get("SCARLET_TASK").map(String::as_str), Some("task_1"));
    assert_eq!(spec.env.get("SCARLET_MODEL").map(String::as_str), Some("opus"));
    assert_eq!(spec.env.get("SCARLET_WORKDIR").map(String::as_str), Some("C:\\work\\task_1"));

    // Dev fallback: node + cli.js, then the same `mcp …` flags; no task/model when absent.
    let dev = McpLauncher { program: "node".into(), prefix_args: vec!["C:/repo/apps/server/dist/cli.js".into()] };
    let spec = dev.spec("http://127.0.0.1:4000", "t", "p", None, "codex", None, "/w");
    assert_eq!(&spec.args[..2], &["C:/repo/apps/server/dist/cli.js", "mcp"]);
    assert!(!spec.args.contains(&"--task".to_string()));
    assert!(!spec.args.contains(&"--model".to_string()));
    assert!(!spec.env.contains_key("SCARLET_TASK"));
    // The generated Claude MCP config embeds exactly this spec.
    let cfg: Value = serde_json::from_str(&runner_claude::command::mcp_config_json(&spec)).unwrap();
    assert_eq!(cfg["mcpServers"]["scarlet"]["command"], json!("node"));
    assert_eq!(cfg["mcpServers"]["scarlet"]["args"][1], json!("mcp"));
    assert_eq!(cfg["mcpServers"]["scarlet"]["env"]["SCARLET_PROJECT"], json!("p"));
    let gem = runner_gemini::acp_mcp_server(&spec);
    assert_eq!(gem["args"], json!(spec.args));
}
