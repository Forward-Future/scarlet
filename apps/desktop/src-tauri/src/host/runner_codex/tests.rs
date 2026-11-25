use super::*;
use super::command::toml_string;
use super::events::is_retry_notice;
use crate::host::types::{McpSpec, RunnerEvent, Workspace};

fn feed(lines: &[&str], st: &mut CodexState) -> Vec<RunnerEvent> {
    lines.iter().flat_map(|l| parse_codex_line(l, st)).collect()
}

fn mcp() -> McpSpec {
    crate::host::runner::testing::sample_mcp()
}

const FIXTURE: [&str; 9] = [
    r#"{"type":"thread.started","thread_id":"t_1"}"#,
    r#"{"type":"turn.started"}"#,
    r#"{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"Need to read the transcript first."}}"#,
    r#"{"type":"item.started","item":{"id":"i1","type":"mcp_tool_call","server":"scarlet","tool":"transcript_get","arguments":{"mediaId":"m1"},"status":"in_progress"}}"#,
    r#"{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","server":"scarlet","tool":"transcript_get","arguments":{"mediaId":"m1"},"status":"completed","result":{"content":[]}}}"#,
    r#"{"type":"item.started","item":{"id":"i2","type":"command_execution","command":"bash -lc ls","aggregated_output":"","status":"in_progress"}}"#,
    r#"{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"bash -lc ls","aggregated_output":"a\nb","exit_code":0,"status":"completed"}}"#,
    r#"{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Proposed the first cut as chg_2."}}"#,
    r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
];

#[test]
fn maps_items_to_events_and_takes_the_last_agent_message_as_the_result() {
    let mut st = CodexState::default();
    let evs = feed(&FIXTURE, &mut st);
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "tool", "tool", "log", "result"]);
    assert_eq!(evs[2].text, r#"scarlet.transcript_get {"mediaId":"m1"}"#);
    assert_eq!(evs[3].text, "shell bash -lc ls");
    assert_eq!(evs[5].text, "Proposed the first cut as chg_2.");
    assert!(st.turn_completed);
    assert_eq!(st.last_message.as_deref(), Some("Proposed the first cut as chg_2."));
}

#[test]
fn reports_a_compaction_once_whichever_way_codex_says_it() {
    let compacting = RunnerEvent::with("log", "Compacting context", json!({"kind":"compaction","active":true}));
    let compacted = RunnerEvent::with("log", "Context compacted", json!({"kind":"compaction"}));
    let notice = json!({"threadId":"t1","turnId":"u1"});
    // An App Server that reports it only as `thread/compacted`.
    let mut st = CodexState::default();
    assert_eq!(app_server_events("thread/compacted", &notice, &mut st), vec![compacted.clone()]);
    // One that reports it as an item too: start drives the live status line, completion logs once, and the older notice after it doesn't duplicate.
    let mut st = CodexState::default();
    let item = json!({"item":{"id":"c1","type":"contextCompaction"}});
    let mut evs = app_server_events("item/started", &item, &mut st);
    evs.extend(app_server_events("item/completed", &item, &mut st));
    evs.extend(app_server_events("thread/compacted", &notice, &mut st));
    assert_eq!(evs, vec![compacting, compacted]);
}

#[test]
fn handles_questions_failed_turns_and_bare_errors() {
    let mut st = CodexState::default();
    let evs = feed(
        &[
            r#"{"type":"item.started","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"completed"}}"#,
        ],
        &mut st,
    );
    assert_eq!(evs, vec![RunnerEvent::with("question", "Which take?", json!({"tool":"scarlet.task_question","itemId":"q"}))]);
    assert_eq!(st.question.as_deref(), Some("Which take?"));
    assert!(st.question_posted);
    assert!(st.should_stop);

    let mut st2 = CodexState::default();
    let e2 = feed(&[r#"{"type":"turn.failed","error":{"message":"rate limited"}}"#, r#"{"type":"error","message":"boom"}"#], &mut st2);
    assert_eq!(e2.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect::<Vec<_>>(), [("error", "rate limited"), ("error", "boom")]);
    assert_eq!(st2.failed.as_deref(), Some("boom"));
}

#[test]
fn a_question_the_mcp_server_refused_or_with_no_words_is_no_question() {
    let call = |kind: &str, args: Value, end: Value| {
        let mut item = json!({"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":args});
        item.as_object_mut().unwrap().extend(end.as_object().unwrap().clone());
        json!({"type":kind,"item":item}).to_string()
    };
    let kinds = |evs: &[RunnerEvent]| evs.iter().map(|e| e.kind.clone()).collect::<Vec<_>>();
    // Words under another key, or none worth asking: an ordinary call. Its raw input never becomes the question.
    for args in [json!({"question":"Which take?"}), json!({"text":""}), json!({"text":"  "}), json!({"text":7})] {
        let mut st = CodexState::default();
        let evs = feed(&[&call("item.started", args.clone(), json!({"status":"in_progress"})), &call("item.completed", args.clone(), json!({"status":"failed","error":{"message":"text: Required"}}))], &mut st);
        assert_eq!(kinds(&evs), ["error"], "{args}");
        assert!(st.question.is_none() && !st.should_stop && !st.question_posted, "{args}");
    }
    // A question with words that the server refused, whichever way it says so: dropped, and the run goes on.
    for end in [json!({"status":"failed"}), json!({"status":"completed","error":"busy"}), json!({"status":"completed","result":{"isError":true,"content":[]}})] {
        let mut st = CodexState::default();
        let evs = feed(&[&call("item.started", json!({"text":"Which take?"}), json!({"status":"in_progress"})), &call("item.completed", json!({"text":"Which take?"}), end.clone())], &mut st);
        assert_eq!(kinds(&evs), ["error"], "{end}");
        assert!(st.question.is_none() && !st.should_stop && !st.question_posted, "{end}");
        // The model asks again, and that one is the editor's.
        let evs = feed(&[&call("item.completed", json!({"text":"Keep the cold open?"}), json!({"status":"completed"}))], &mut st);
        assert_eq!(evs, vec![RunnerEvent::with("question", "Keep the cold open?", json!({"tool":"scarlet.task_question","itemId":"q"}))]);
        assert!(st.question_posted && st.should_stop);
    }
    // App Server can withhold the words until the call finishes: they arrive with its result.
    let mut st = CodexState::default();
    let started = json!({"item":{"id":"q1","type":"mcpToolCall","server":"scarlet","tool":"task_question","status":"inProgress"}});
    let done = json!({"item":{"id":"q1","type":"mcpToolCall","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"completed"}});
    let mut evs = app_server_events("item/started", &started, &mut st);
    assert!(evs.is_empty() && st.question.is_none());
    evs.extend(app_server_events("item/completed", &done, &mut st));
    assert_eq!(evs, vec![RunnerEvent::with("question", "Which take?", json!({"tool":"scarlet.task_question","itemId":"q1"}))]);
    assert!(st.question_posted && st.should_stop);
    // And a finished call with no words at all is still no question.
    let mut st = CodexState::default();
    let bare = json!({"item":{"id":"q2","type":"mcpToolCall","server":"scarlet","tool":"task_question","status":"completed"}});
    assert!(app_server_events("item/completed", &bare, &mut st).is_empty());
    assert!(st.question.is_none() && !st.should_stop);
}

#[test]
fn carries_on_after_codex_recovers_from_a_dropped_stream() {
    let drop = "stream disconnected before completion: websocket closed by server before response.completed";
    let mut st = CodexState::default();
    let evs = feed(
        &[
            &format!(r#"{{"type":"error","message":"Reconnecting... 2/5 ({drop})"}}"#),
            &format!(r#"{{"type":"item.completed","item":{{"id":"w","type":"error","message":"Falling back from WebSockets to HTTPS transport. {drop}"}}}}"#),
            r#"{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Saved all 119 recommendations."}}"#,
            r#"{"type":"turn.completed","usage":{}}"#,
        ],
        &mut st,
    );
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["log", "log", "log", "result"]);
    assert!(st.failed.is_none());
    assert!(st.retry_notice.as_deref().unwrap().starts_with("Reconnecting... 2/5"));
    assert!(st.turn_completed);
    // A retry that never recovers still fails the turn.
    let mut gave_up = CodexState::default();
    feed(&[&format!(r#"{{"type":"error","message":"Reconnecting... 5/5 ({drop})"}}"#), &format!(r#"{{"type":"turn.failed","error":{{"message":"{drop}"}}}}"#)], &mut gave_up);
    assert_eq!(gave_up.failed.as_deref(), Some(drop));
    assert!(!is_retry_notice("Reconnecting... soon"));
}

#[test]
fn passes_on_the_plan_codex_keeps_once_for_each_change() {
    // Recorded from codex-cli 0.166.0-alpha.5.1 run with tools.update_plan.enabled=true: the whole list each time, and
    // the last one again as the turn ends. A step is finished or not; nothing says which is under way.
    let list = |kind: &str, first: bool| json!({"type": kind, "item": {"id": "item_1", "type": "todo_list", "items": [
        {"text": "Step 1", "completed": first}, {"text": "Step 2", "completed": false}, {"text": "Step 3", "completed": false}]}}).to_string();
    let mut st = CodexState::default();
    let evs = feed(
        &[
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll make the two plan updates now."}}"#,
            &list("item.started", false),
            &list("item.updated", true),
            r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}"#,
            &list("item.completed", true),
        ],
        &mut st,
    );
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["log", "plan", "plan", "log"]);
    assert_eq!(evs[1], RunnerEvent::with("plan", "[ ] Step 1\n[ ] Step 2\n[ ] Step 3", json!({"steps": [
        {"text": "Step 1", "state": "pending"}, {"text": "Step 2", "state": "pending"}, {"text": "Step 3", "state": "pending"}]})));
    assert_eq!(evs[2].text, "[x] Step 1\n[ ] Step 2\n[ ] Step 3");
    // A list Scarlet can't read is passed over.
    assert!(feed(&[r#"{"type":"item.updated","item":{"id":"item_1","type":"todo_list"}}"#], &mut st).is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn grants_only_the_resolved_codex_executable() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("codex \"native\"");
    let link = dir.path().join("codex");
    std::fs::write(&target, "fixture").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let resolved = std::fs::canonicalize(&target).unwrap().to_string_lossy().into_owned();
    let cmd = build_codex_command(None, None, None, "SYS", "x", false, None, &mcp(), Path::new("/w"), link.to_str().unwrap(), Path::new("/w/.scarlet")).cmd;
    assert_eq!(cmd.file, resolved);
    assert!(cmd.args.contains(&format!("permissions.scarlet.filesystem={{\":root\"=\"deny\",\":minimal\"=\"read\",\":workspace_roots\"={{\".\"=\"write\"}},{path}=\"read\"}}", path = toml_string(&resolved))));
    assert!(cmd.args.contains(&"permissions.scarlet.network.enabled=false".to_string()));
    assert!(!cmd.args.iter().any(|arg| arg.contains("danger-full-access")));
    let (opts, _) = crate::host::runner::testing::options("codex", dir.path(), None);
    let args = app_server_args(&opts, Some(&resolved));
    assert!(args.contains(&format!("permissions.scarlet.filesystem={{\":root\"=\"deny\",\":minimal\"=\"read\",\":workspace_roots\"={{\".\"=\"write\"}},{path}=\"read\"}}", path = toml_string(&resolved))));
    assert!(args.contains(&"project_doc_max_bytes=4194304".to_string()));
}

#[test]
fn builds_c_overrides_as_valid_toml() {
    assert_eq!(toml_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
    let mcp = mcp();
    let built = build_codex_command(Some("gpt-5-codex"), None, None, "SYS", "Cut it", false, None, &mcp, Path::new("C:\\work\\t1"), "codex.cmd", Path::new("C:\\work\\t1\\.scarlet"));
    let cmd = built.cmd;
    assert_eq!(&cmd.args[..5], &["exec", "--json", "--skip-git-repo-check", "--cd", "C:\\work\\t1"]);
    assert!(cmd.args.windows(2).any(|p| p == ["--disable", "shell_tool"]));
    assert!(cmd.args.contains(&r#"default_permissions="scarlet""#.to_string()));
    assert_eq!(cmd.args.contains(&r#"windows.sandbox="mxc""#.to_string()), cfg!(windows));
    assert!(cmd.args.contains(&r#"mcp_servers.scarlet.default_tools_approval_mode="approve""#.to_string()));
    assert!(cmd.args.contains(&"mcp_servers.scarlet.command=\"C:/Program Files/nodejs/node.exe\"".to_string()));
    assert!(cmd.args.contains(&"mcp_servers.scarlet.args=[\"C:/scarlet/packages/mcp/dist/cli.js\"]".to_string()));
    assert!(cmd.args.contains(&"mcp_servers.scarlet.env_vars=[\"SCARLET_SERVER\",\"SCARLET_TOKEN\"]".to_string()));
    assert!(cmd.args.contains(&"mcp_servers.scarlet.required=true".to_string()));
    assert!(cmd.args.windows(2).any(|p| p == ["-c", "project_doc_max_bytes=4194304"]));
    assert_eq!(&cmd.args[cmd.args.len() - 3..], &["--model", "gpt-5-codex", "-"]);
    let tuned = build_codex_command(None, Some("ultra"), Some("priority"), "SYS", "x", false, None, &mcp, Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
    assert_eq!(&tuned.args[tuned.args.len() - 5..], &["-c", "model_reasoning_effort=\"ultra\"", "-c", "service_tier=\"priority\"", "-"]);
    assert!(cmd.files.keys().next().unwrap().ends_with("AGENTS.md"));
    let long = build_codex_command(None, None, None, "SYS", "a\nb", false, None, &mcp, Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
    assert_eq!(long.args.last().unwrap(), "-");
    assert_eq!(long.stdin.as_deref(), Some("a\nb"));
    // Codex's to-do tool is switched on only when the engine asks for the agent's plan.
    assert!(!long.args.iter().any(|a| a == "tools.update_plan.enabled=true"));
    let planned = build_codex_command(None, None, None, "SYS", "a\nb", true, None, &mcp, Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
    assert_eq!(planned.args.iter().filter(|a| !long.args.contains(a)).collect::<Vec<_>>(), ["tools.update_plan.enabled=true"]);
    // Ephemeral: Scarlet runs stay out of the user's Codex thread list.
    assert!(cmd.args.iter().any(|a| a == "--ephemeral"));
    assert!(!cmd.args.iter().any(|a| a == "resume"));
    // The task folder is the project's root, as for App Server: nothing above it lends AGENTS.md or config.
    assert!(cmd.args.windows(2).any(|p| p == ["-c", "project_root_markers=[]"]));
}

#[test]
fn counts_only_this_runs_tokens_on_a_thread_it_resumed() {
    let update = |total: u64, last: u64| json!({"tokenUsage": {
        "total": {"inputTokens": total, "cachedInputTokens": total / 2, "outputTokens": total / 10, "reasoningOutputTokens": total / 20},
        "last": {"inputTokens": last, "cachedInputTokens": last / 2, "outputTokens": last / 10, "reasoningOutputTokens": last / 20},
    }});
    let counts = |st: &CodexState| st.usage.as_ref().map(|u| (u.input_tokens, u.cache_read_tokens, u.output_tokens, u.reasoning_tokens));
    // A resumed thread that kept the earlier runs' 10,000 tokens: this run counts from its own first call.
    let mut resumed = CodexState { resumed: true, ..Default::default() };
    app_server_events("thread/tokenUsage/updated", &update(12_000, 2_000), &mut resumed);
    assert_eq!(counts(&resumed), Some((1_000, 1_000, 200, 100)));
    app_server_events("thread/tokenUsage/updated", &update(15_000, 3_000), &mut resumed);
    assert_eq!(counts(&resumed), Some((2_500, 2_500, 500, 250)));
    // A Codex that starts the count again on a resumed thread: nothing to take off.
    let mut fresh_count = CodexState { resumed: true, ..Default::default() };
    app_server_events("thread/tokenUsage/updated", &update(2_000, 2_000), &mut fresh_count);
    app_server_events("thread/tokenUsage/updated", &update(5_000, 3_000), &mut fresh_count);
    assert_eq!(counts(&fresh_count), Some((2_500, 2_500, 500, 250)));
    // A count that doesn't say which call it is about: all of it is taken for the earlier runs', and this run's
    // own count starts from there.
    let mut unsure = CodexState { resumed: true, ..Default::default() };
    let without_last = |total: u64| json!({"tokenUsage": {"total": {"inputTokens": total, "cachedInputTokens": total / 2, "outputTokens": total / 10, "reasoningOutputTokens": total / 20}}});
    app_server_events("thread/tokenUsage/updated", &without_last(12_000), &mut unsure);
    assert_eq!(counts(&unsure), Some((0, 0, 0, 0)));
    app_server_events("thread/tokenUsage/updated", &update(15_000, 3_000), &mut unsure);
    assert_eq!(counts(&unsure), Some((1_500, 1_500, 300, 150)));
    // A new thread's total is all this run's.
    let mut started = CodexState::default();
    app_server_events("thread/tokenUsage/updated", &update(12_000, 2_000), &mut started);
    assert_eq!(counts(&started), Some((6_000, 6_000, 1_200, 600)));
}

#[test]
fn sums_usage_across_turns_and_separates_cached_input() {
    let mut st = CodexState::default();
    feed(&[
        r#"{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50,"reasoning_output_tokens":20}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
    ], &mut st);
    let u = st.usage.unwrap();
    assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens, u.reasoning_tokens), (210, 55, 800, 20));
}

#[test]
fn parses_live_codex_rate_limits_notification() {
    let params = json!({
        "rateLimits": {
            "planType": "pro",
            "primary": { "usedPercent": 86, "windowDurationMins": 300, "resetsAt": 1763790000 },
            "secondary": { "usedPercent": 24, "windowDurationMins": 10080, "resetsAt": 1764300000 },
            "credits": { "hasCredits": true, "unlimited": false }
        }
    });
    let parsed = parse_codex_rate_limits_notification(&params, "2026-11-22T00:00:00.000Z").expect("quota");
    assert_eq!(parsed.plan.as_deref(), Some("Pro"));
    assert_eq!(parsed.unlimited, None);
    assert_eq!(parsed.buckets.len(), 2);
    assert_eq!(parsed.buckets[0].label, "5-hour");
    assert_eq!(parsed.buckets[0].remaining_percent, 14.0);
    assert!(parsed.buckets[0].resets_at.as_deref().unwrap().ends_with(".000Z"));
    assert_eq!(parsed.buckets[1].label, "Weekly");
    assert_eq!(parsed.buckets[1].remaining_percent, 76.0);
}

#[cfg(unix)]
mod runs {
    use super::super::*;
    use crate::host::types::RunnerEvent;
    use crate::host::runner::testing::{fake_cli, options as runner_options};

    fn options(agent: &str, cwd: &Path, bin: Option<String>) -> (RunOptions, Arc<Mutex<Vec<RunnerEvent>>>) {
        let (mut opts, events) = runner_options(agent, cwd, bin);
        // Fixtures choose their credential store independently of the developer running the tests.
        env_remove_ci(&mut opts.env, &["CODEX_HOME"]);
        env_remove_ci(&mut opts.env, crate::host::detect::api_key_vars("codex"));
        opts.env.insert("CODEX_HOME".into(), cwd.join("empty-codex-home").to_string_lossy().into_owned());
        (opts, events)
    }

    const STARTED: &str = r#"{"type":"thread.started","thread_id":"t_1"}"#;
    const MESSAGE: &str = r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Proposed the first cut."}}"#;
    const DONE: &str = r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#;

    #[tokio::test]
    async fn app_server_reports_cumulative_usage_before_the_edit_finishes() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let auth_home = tempfile::tempdir().unwrap();
        let auth = auth_home.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        let bin = dir.path().join("fake-app-server");
        std::fs::write(&bin, r#"#!/bin/sh
set -eu
test "$1" = app-server
test -L "$CODEX_HOME/auth.json"
test -L "$CODEX_HOME/auth.lock"
test -z "${CODEX_SQLITE_HOME:-}"
read -r request
printf '%s\n' '{"id":1,"result":{}}'
read -r request
read -r request
printf '%s\n' '{"id":2,"result":{"thread":{"id":"t1","ephemeral":false},"model":"resolved-model","approvalPolicy":"never","activePermissionProfile":{"id":"scarlet"}}}'
read -r request
case "$request" in *'"text":"Cut the pauses"'*'"text_elements":[]'*) ;; *) exit 4 ;; esac
cat <<'EVENTS'
{"id":3,"result":{"turn":{"id":"turn1"}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t1","turnId":"turn1","tokenUsage":{"total":{"inputTokens":100,"cachedInputTokens":40,"cacheWriteInputTokens":30,"outputTokens":10,"reasoningOutputTokens":5}}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t1","turnId":"turn1","tokenUsage":{"total":{"inputTokens":100,"cachedInputTokens":40,"cacheWriteInputTokens":30,"outputTokens":10,"reasoningOutputTokens":5}}}}
{"method":"item/completed","params":{"threadId":"t1","turnId":"turn1","item":{"type":"agentMessage","phase":"final_answer","text":"Cut the pauses."}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"t1","turnId":"turn1","tokenUsage":{"total":{"inputTokens":210,"cachedInputTokens":50,"cacheWriteInputTokens":40,"outputTokens":20,"reasoningOutputTokens":8}}}}
{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn1","status":"completed"}}}
EVENTS
cat >/dev/null
"#).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (mut opts, _) = options("codex", dir.path(), Some(bin.to_string_lossy().into_owned()));
        opts.env.insert("CODEX_HOME".into(), auth_home.path().to_string_lossy().into_owned());
        opts.env.insert("CODEX_SQLITE_HOME".into(), auth_home.path().to_string_lossy().into_owned());
        opts.timeout = Some(std::time::Duration::from_secs(10));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let live = reports.clone();
        opts.on_usage = Some(Arc::new(move |usage| live.lock().unwrap().push(usage)));
        let live = reports.clone();
        opts.on_event = Arc::new(move |event| {
            if event.text == "Cut the pauses." && event.kind == "log" {
                assert_eq!(live.lock().unwrap().len(), 1, "the first count must arrive during the turn");
            }
        });
        let result = run_codex(opts).await;
        assert!(result.ok, "{result:?}");
        assert_eq!(result.summary, "Cut the pauses.");
        let reports = reports.lock().unwrap();
        assert_eq!(reports.len(), 2);
        assert_eq!((reports[0].input_tokens, reports[0].cache_read_tokens, reports[0].cache_write_tokens), (30, 40, 30));
        assert_eq!((reports[1].input_tokens, reports[1].output_tokens, reports[1].reasoning_tokens), (120, 20, 8));
        assert_eq!(reports[1].model.as_deref(), Some("resolved-model"));
        assert_eq!(result.usage.as_ref(), reports.last());
        assert_eq!(std::fs::read_to_string(auth).unwrap(), "{}");
        // The thread is the run's session, kept in a home beside the task folder for the next run to resume.
        assert_eq!(result.session_id.as_deref(), Some("t1"));
        let home = codex_home_dir(dir.path());
        assert!(std::fs::symlink_metadata(home.join("auth.json")).unwrap().file_type().is_symlink());
        std::fs::remove_dir_all(home).unwrap();
    }

    #[tokio::test]
    async fn resumes_the_thread_a_run_left_and_asks_for_a_fresh_run_when_it_is_gone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let auth_home = tempfile::tempdir().unwrap();
        std::fs::write(auth_home.path().join("auth.json"), "{}").unwrap();
        let bin = dir.path().join("fake-app-server");
        std::fs::write(&bin, r#"#!/bin/sh
set -eu
test "$1" = app-server
read -r request
printf '%s\n' '{"id":1,"result":{}}'
read -r request
read -r request
case "$request" in *'"method":"thread/resume"'*'"threadId":"t1"'*) ;; *) printf '%s\n' '{"id":2,"error":{"code":-32600,"message":"no rollout found"}}'; exit 0 ;; esac
printf '%s\n' '{"id":2,"result":{"thread":{"id":"t1","ephemeral":false},"model":"m","approvalPolicy":"never","activePermissionProfile":{"id":"scarlet"}}}'
read -r request
case "$request" in *'"text":"The editor answered'*) ;; *) exit 4 ;; esac
cat <<'EVENTS'
{"id":3,"result":{"turn":{"id":"turn2"}}}
{"method":"item/completed","params":{"threadId":"t1","turnId":"turn2","item":{"type":"agentMessage","phase":"final_answer","text":"Kept the take."}}}
{"method":"turn/completed","params":{"threadId":"t1","turn":{"id":"turn2","status":"completed"}}}
EVENTS
cat >/dev/null
"#).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = |session: &str| {
            let (mut opts, _) = options("codex", dir.path(), Some(bin.to_string_lossy().into_owned()));
            opts.env.insert("CODEX_HOME".into(), auth_home.path().to_string_lossy().into_owned());
            opts.timeout = Some(std::time::Duration::from_secs(10));
            opts.instruction = "The editor answered: \"keep it\"".into();
            opts.resume_session = Some(session.into());
            run_codex(opts)
        };
        let resumed = run("t1").await;
        assert!(resumed.ok && !resumed.resume_failed, "{resumed:?}");
        assert_eq!((resumed.summary.as_str(), resumed.session_id.as_deref()), ("Kept the take.", Some("t1")));
        // A thread Codex no longer has runs nothing, and no `codex exec` fallback: the host starts afresh.
        let gone = run("t0").await;
        assert!(gone.resume_failed && !gone.ok, "{gone:?}");
        std::fs::remove_dir_all(codex_home_dir(dir.path())).unwrap();
    }

    #[tokio::test]
    async fn reports_a_finished_run_and_prefers_the_last_message_file() {
        let dir = tempfile::tempdir().unwrap();
        let (opts, events) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE, DONE], "exit 0")));
        let run = run_codex(opts).await;
        assert!(run.ok, "{run:?}");
        assert_eq!((run.summary.as_str(), run.error.as_deref(), run.exit_code), ("Proposed the first cut.", None, Some(0)));
        assert_eq!(run.usage.as_ref().map(|u| (u.input_tokens, u.output_tokens)), Some((10, 5)));
        assert_eq!(events.lock().unwrap().iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "result"]);
        // Codex reads its instructions from the task folder.
        assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "SYSTEM");

        // What Codex wrote to --output-last-message is the summary, over the last message in the stream. It also
        // gets the engine's address and token in its environment, where its MCP server reads them.
        let writes = r#"while [ $# -gt 1 ]; do if [ "$1" = "--output-last-message" ]; then printf 'Server %s, token %s.\n' "$SCARLET_SERVER" "$SCARLET_TOKEN" > "$2"; fi; shift; done"#;
        let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE, DONE], writes)));
        assert_eq!(run_codex(opts).await.summary, "Server http://127.0.0.1:4000, token sct_test.");
    }

    #[tokio::test]
    async fn gives_the_reason_a_run_failed() {
        let dir = tempfile::tempdir().unwrap();
        // A failed turn is the reason, even with a clean exit.
        let failed = r#"{"type":"turn.failed","error":{"message":"model overloaded"}}"#;
        let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, failed], "exit 0")));
        let run = run_codex(opts).await;
        assert_eq!((run.ok, run.error.as_deref()), (false, Some("model overloaded")));
        // Died with nothing but a reconnect notice: the notice explains it.
        let retry = r#"{"type":"error","message":"Reconnecting... 5/5"}"#;
        let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, retry], "exit 1")));
        assert_eq!(run_codex(opts).await.error.as_deref(), Some("Reconnecting... 5/5"));
        // Died with nothing at all: the exit code and stderr.
        let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED], "echo 'not signed in' >&2; exit 2")));
        let run = run_codex(opts).await;
        assert_eq!((run.error.as_deref(), run.exit_code), (Some("codex exited with code 2: not signed in"), Some(2)));
        // A turn that completed counts, whatever the exit code.
        let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE, DONE], "exit 1")));
        assert!(run_codex(opts).await.ok);
    }

    #[tokio::test]
    async fn finishes_a_run_whose_question_was_refused_without_asking_the_editor() {
        let dir = tempfile::tempdir().unwrap();
        let refused = r#"{"type":"item.completed","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":""},"status":"failed","error":{"message":"text must not be empty"}}}"#;
        let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, refused, MESSAGE, DONE], "exit 0")));
        let run = run_codex(opts).await;
        assert!(run.ok && run.question.is_none() && !run.question_posted, "{run:?}");
        assert_eq!(run.summary, "Proposed the first cut.");
    }

    #[tokio::test]
    async fn pauses_on_a_question_and_reports_a_stall_or_a_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let ask = r#"{"type":"item.completed","item":{"id":"q","type":"mcp_tool_call","server":"scarlet","tool":"task_question","arguments":{"text":"Which take?"},"status":"completed"}}"#;
        let (opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, ask], "sleep 30")));
        let run = run_codex(opts).await;
        assert!(run.ok && run.question_posted, "{run:?}");
        assert_eq!(run.question.as_deref(), Some("Which take?"));

        let (mut opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE], "sleep 30")));
        // Long enough for the stand-in to start and speak on a busy machine.
        opts.stall = Some(std::time::Duration::from_secs(8));
        let run = run_codex(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.timed_out, run.stalled), (false, Some("stalled"), true, true));
        assert_eq!(run.summary, "Proposed the first cut.");

        let (mut opts, _) = options("codex", dir.path(), Some(fake_cli(dir.path(), &[STARTED, MESSAGE], "sleep 30")));
        let cancel = opts.cancel.clone();
        opts.on_event = Arc::new(move |_| cancel.cancel());
        let run = run_codex(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.aborted), (false, Some("cancelled"), true));
    }
}

#[test]
fn gives_a_request_its_shell_a_look_at_pictures_the_live_web_and_reads_of_its_programs_folders() {
    let ws = Workspace { bin_dir: Some("/w/.tools".into()), read_dirs: vec!["/Applications/Google Chrome.app".into(), "/opt/ff/bin".into()] };
    let cmd = build_codex_command(None, None, None, "SYS", "x", false, Some(&ws), &mcp(), Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
    let disabled = |args: &[String]| args.windows(2).filter(|p| p[0] == "--disable").map(|p| p[1].clone()).collect::<Vec<_>>();
    assert_eq!(disabled(&cmd.args), ["computer_use", "multi_agent", "plugins", "apps", "hooks"]);
    assert!(cmd.args.contains(&r#"web_search="live""#.to_string()));
    assert!(cmd.args.contains(&"permissions.scarlet.network.enabled=true".to_string()));
    assert!(cmd.args.contains(&r#"permissions.scarlet.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"},"/Applications/Google Chrome.app"="read","/opt/ff/bin"="read"}"#.to_string()));
    assert!(cmd.args.contains(&r#"shell_environment_policy.exclude=["SCARLET_*"]"#.to_string()));
    let side = build_codex_command(None, None, None, "SYS", "x", false, None, &mcp(), Path::new("/w"), "codex", Path::new("/w/.scarlet")).cmd;
    assert_eq!(disabled(&side.args)[..2], ["shell_tool", "view_image"]);
    assert!(side.args.contains(&r#"web_search="disabled""#.to_string()));
    assert!(side.args.contains(&"permissions.scarlet.network.enabled=false".to_string()));
}

#[test]
fn links_codex_auth_files_into_an_isolated_home_and_replaces_stale_links() {
    let dir = tempfile::tempdir().unwrap();
    let user_home = dir.path().join("user");
    let run_home = dir.path().join("run");
    std::fs::create_dir_all(&user_home).unwrap();
    std::fs::create_dir_all(&run_home).unwrap();
    let auth = user_home.join("auth.json");
    std::fs::write(&auth, r#"{"token":"first"}"#).unwrap();

    link_codex_auth_file(&auth, &run_home.join("auth.json"), false, false).unwrap();
    link_codex_auth_file(&user_home.join("auth.lock"), &run_home.join("auth.lock"), true, false).unwrap();
    assert_eq!(std::fs::read_to_string(run_home.join("auth.json")).unwrap(), r#"{"token":"first"}"#);

    // Updating the user's auth file is immediately visible in the run's isolated home, and re-linking replaces cleanly.
    std::fs::write(&auth, r#"{"token":"refreshed"}"#).unwrap();
    assert_eq!(std::fs::read_to_string(run_home.join("auth.json")).unwrap(), r#"{"token":"refreshed"}"#);
    link_codex_auth_file(&auth, &run_home.join("auth.json"), false, true).unwrap();
    assert_eq!(std::fs::read_to_string(run_home.join("auth.json")).unwrap(), r#"{"token":"refreshed"}"#);
}

