use super::*;
use super::command::{build_claude_command, can_run_bare, with_tool_timeout};
use serde_json::{json, Value};
use std::path::Path;
use crate::host::types::{McpSpec, RunnerEvent, Workspace};

fn feed(lines: &[&str], st: &mut ClaudeState) -> Vec<RunnerEvent> {
    lines.iter().flat_map(|l| parse_claude_line(l, st)).collect()
}

fn mcp() -> McpSpec {
    crate::host::runner::testing::sample_mcp()
}

const FIXTURE: [&str; 7] = [
    r#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","tools":["Bash"],"mcp_servers":[{"name":"scarlet","status":"connected"}]}"#,
    r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me look at the project."},{"type":"tool_use","id":"toolu_1","name":"mcp__scarlet__project_get","input":{}}]},"session_id":"s1"}"#,
    r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"{...}"}]}]}}"#,
    r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"mcp__scarlet__timeline_propose","input":{"ops":[{"op":"rippleDelete","start":1,"end":2}],"description":"Cut the pause"}}]}}"#,
    r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","is_error":true,"content":"Invalid ops: ..."}]}}"#,
    "not json at all",
    r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"num_turns":3,"result":"Proposed one change: chg_1.","total_cost_usd":0.05,"usage":{"input_tokens":4,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":12}}"#,
];

#[test]
fn reports_a_compaction_once_it_happens() {
    let mut st = ClaudeState::default();
    let evs = feed(&[
        r#"{"type":"system","subtype":"status","status":"compacting","session_id":"s1"}"#,
        r#"{"type":"system","subtype":"status","status":"compacting","session_id":"s1"}"#,
        r#"{"type":"system","subtype":"compact_boundary","session_id":"s1","compact_metadata":{"trigger":"auto","pre_tokens":161204,"post_tokens":18210}}"#,
        r#"{"type":"system","subtype":"status","status":null,"session_id":"s1"}"#,
    ], &mut st);
    assert_eq!(evs.len(), 2);
    assert_eq!((evs[0].kind.as_str(), evs[0].text.as_str()), ("log", "Compacting context"));
    assert_eq!(evs[0].data, Some(json!({"kind":"compaction","active":true})));
    assert_eq!((evs[1].kind.as_str(), evs[1].text.as_str()), ("log", "Context compacted"));
    assert_eq!(evs[1].data, Some(json!({"kind":"compaction","trigger":"auto","preTokens":161204,"postTokens":18210})));
    assert!(!st.compacting);
    assert!(!st.started);

    // Status returning to null without a boundary (e.g. aborted compaction) still clears the live indicator.
    let cleared = feed(&[
        r#"{"type":"system","subtype":"status","status":"compacting","session_id":"s1"}"#,
        r#"{"type":"system","subtype":"status","status":null,"session_id":"s1"}"#,
    ], &mut st);
    assert_eq!(cleared.len(), 2);
    assert_eq!(cleared[0].data, Some(json!({"kind":"compaction","active":true})));
    assert_eq!(cleared[1].data, Some(json!({"kind":"compaction","active":false})));
    assert!(!st.compacting);
}

#[test]
fn maps_text_tools_errors_and_the_result() {
    let mut st = ClaudeState::default();
    let evs = feed(&FIXTURE, &mut st);
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "tool", "tool", "error", "log", "result"]);
    assert!(evs[0].text.contains("Scarlet MCP connected"));
    assert_eq!(evs[2].text, "scarlet.project_get");
    assert!(evs[3].text.contains("scarlet.timeline_propose {\"ops\""));
    assert!(evs[4].text.contains("Invalid ops"));
    assert_eq!(evs[6].text, "Proposed one change: chg_1.");
    assert_eq!(st.result.as_deref(), Some("Proposed one change: chg_1."));
    assert_eq!(st.mcp_status.as_deref(), Some("connected"));
    assert_eq!(st.session_id.as_deref(), Some("s1"));
}

/// A run with Ollama, LM Studio or OpenRouter reaches most tools through tool_call: each call reads as the call it
/// makes, named as Claude Code names that tool, with that tool's arguments. A question asked through it, which the
/// MCP server refuses, stays a tool_call and never becomes the editor's question.
#[test]
fn a_call_through_tool_call_reads_as_the_tool_it_calls() {
    let mut st = ClaudeState::default();
    let evs = feed(&[
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"mcp__scarlet__tool_call","input":{"name":"transcript_get","arguments":{"mediaId":"m1"}}}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":true,"content":"no such media"}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"mcp__scarlet__tool_call","input":{"name":"mcp__scarlet__timeline_get"}}]}}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"mcp__scarlet__tool_call","input":{"name":"task_question","arguments":{"text":"Which take?"}}}]}}"#,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_3","is_error":true,"content":"Ask with task_question itself."}]}}"#,
    ], &mut st);
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["tool", "error", "tool", "tool", "error"]);
    assert_eq!(evs[0], RunnerEvent::with("tool", r#"scarlet.transcript_get {"mediaId":"m1"}"#, json!({"tool":"mcp__scarlet__transcript_get","input":{"mediaId":"m1"},"toolUseId":"toolu_1"})));
    assert_eq!(evs[2], RunnerEvent::with("tool", "scarlet.timeline_get", json!({"tool":"mcp__scarlet__timeline_get","input":{},"toolUseId":"toolu_2"})));
    assert_eq!(evs[3].data.as_ref().unwrap()["tool"], "mcp__scarlet__tool_call");
    assert_eq!(evs[3].data.as_ref().unwrap()["input"], json!({"name":"task_question","arguments":{"text":"Which take?"}}));
    assert!(st.question.is_none() && st.pending_question.is_none() && !st.should_stop && !st.question_posted);
}

#[test]
fn sees_a_resume_that_found_no_session_as_never_started() {
    // Recorded from claude 2.1.316 with --resume <unknown id>.
    let mut st = ClaudeState::default();
    feed(&[r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"3f1c2b9e-0000-4000-8000-000000000000","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"errors":["No conversation found with session ID: 3f1c2b9e-0000-4000-8000-000000000000"]}"#], &mut st);
    assert!(!st.started);
    assert_eq!(st.session_id, None);
    assert!(st.result.as_deref().unwrap().contains("No conversation found"));
}

#[test]
fn turns_task_question_into_a_question_and_stops_after_its_tool_result() {
    let mut st = ClaudeState::default();
    let evs = feed(&[r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}"#], &mut st);
    assert!(evs.is_empty(), "{evs:?}");
    assert_eq!(st.question.as_deref(), Some("Keep the cold open?"));
    assert!(!st.should_stop);
    let evs = feed(&[r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}"#], &mut st);
    // Said once the MCP server has posted it.
    assert_eq!(evs, vec![RunnerEvent::with("question", "Keep the cold open?", json!({"tool":"mcp__scarlet__task_question","toolUseId":"q1"}))]);
    assert_eq!(st.question.as_deref(), Some("Keep the cold open?"));
    assert!(st.question_posted);
    assert!(st.should_stop);
}

#[test]
fn a_question_the_mcp_server_refused_is_no_question_and_the_model_carries_on() {
    let ask = |id: &str, input: Value| json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"mcp__scarlet__task_question","input":input}]}}).to_string();
    let refused = |id: &str| json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":true,"content":"InputValidationError: text is required"}]}}).to_string();
    let posted = |id: &str| json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"Question posted"}]}}).to_string();
    let mut st = ClaudeState::default();
    // Words under another key: an ordinary call, which the schema refuses. Its raw input never becomes the question.
    let evs = feed(&[&ask("q1", json!({"question":"Keep the cold open?"})), &refused("q1")], &mut st);
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["tool", "error"]);
    assert!(st.question.is_none() && !st.should_stop && !st.question_posted);
    // Empty words, or words that aren't text, are no question either.
    for input in [json!({"text":""}), json!({"text":"   "}), json!({"text":42})] {
        let evs = feed(&[&ask("q2", input.clone())], &mut st);
        assert_eq!(evs[0].kind, "tool", "{input}");
        assert!(st.question.is_none() && st.pending_question.is_none(), "{input}");
    }
    // A question with words that the server still refused: dropped, and the run goes on so the model can ask again.
    let evs = feed(&[&ask("q3", json!({"text":"Keep it?","choices":"bad"})), &refused("q3")], &mut st);
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["error"]);
    assert!(st.question.is_none() && st.pending_question.is_none() && !st.should_stop && !st.question_posted);
    // It asks again, and that one is the editor's.
    let evs = feed(&[&ask("q4", json!({"text":"Keep the cold open?"})), &posted("q4")], &mut st);
    assert_eq!(evs, vec![RunnerEvent::with("question", "Keep the cold open?", json!({"tool":"mcp__scarlet__task_question","toolUseId":"q4"}))]);
    assert!(st.question_posted && st.should_stop);
}

#[test]
fn gives_scarlets_tools_at_least_their_wait_whatever_the_user_set() {
    let timeout = |set: Option<&str>| {
        let env: std::collections::HashMap<String, String> = set.map(|v| ("MCP_TOOL_TIMEOUT".to_string(), v.to_string())).into_iter().collect();
        with_tool_timeout(&env)["MCP_TOOL_TIMEOUT"].clone()
    };
    assert_eq!(timeout(None), "300000");
    // A shorter deadline would cut Scarlet's waits off.
    assert_eq!(timeout(Some("60000")), "300000");
    assert_eq!(timeout(Some("not a number")), "300000");
    // A longer one stays.
    assert_eq!(timeout(Some("900000")), "900000");
}

#[test]
fn reports_error_results_and_a_failed_mcp_server() {
    let mut st = ClaudeState::default();
    let evs = feed(
        &[r#"{"type":"system","subtype":"init","mcp_servers":[{"name":"scarlet","status":"failed"}]}"#, r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#],
        &mut st,
    );
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "error", "error"]);
    assert!(st.result_is_error);
    assert_eq!(st.result.as_deref(), Some("error_max_turns"));
    let details = parse_claude_line(r#"{"type":"result","subtype":"error_during_execution","errors":["Sandbox unavailable"]}"#, &mut st);
    assert_eq!(details[0].text, "Sandbox unavailable");
}

#[test]
fn builds_the_command_line_with_files_for_mcp_config_and_system_prompt() {
    let mcp = mcp();
    let cmd = build_claude_command(Some("opus"), None, None, "SYS", "Make the first cut", None, false, false, None, &mcp, "claude", Path::new("/tmp/t"));
    assert_eq!(cmd.args[0], "-p");
    assert_eq!(cmd.stdin.as_deref(), Some("Make the first cut"));
    assert!(cmd.args.windows(2).any(|a| a == ["--tools", "ToolSearch"]));
    assert!(cmd.args.windows(2).any(|a| a == ["--allowedTools", "mcp__scarlet__*,ToolSearch"]));
    assert!(cmd.args.windows(2).any(|a| a == ["--permission-mode", "dontAsk"]));
    assert!(cmd.args.iter().any(|a| a == "--restricted"));
    let option = "--settings={}";
    let hostile = build_claude_command(None, None, None, "SYS", option, None, false, false, None, &mcp, "claude", Path::new("/tmp/t"));
    assert_eq!(hostile.stdin.as_deref(), Some(option));
    assert!(!hostile.args.iter().any(|a| a == option));
    let tuned = build_claude_command(Some("opus"), Some("max"), Some("fast"), "SYS", "x", None, false, false, None, &mcp, "claude", Path::new("/tmp/t"));
    assert_eq!(&tuned.args[tuned.args.len() - 6..tuned.args.len() - 1], &["--model", "opus", "--effort", "max", "--settings"]);
    let settings: Value = serde_json::from_str(tuned.args.last().unwrap()).unwrap();
    assert_eq!(settings["fastMode"], json!(true));
    assert_eq!(settings["sandbox"]["enabled"], json!(true));
    assert_eq!(settings["sandbox"]["allowUnsandboxedCommands"], json!(false));
    // With no shell tool the sandbox guards nothing, so a machine where it can't start still runs.
    assert_eq!(settings["sandbox"].get("failIfUnavailable"), None);
    let (_, mcp_json) = cmd.files.iter().find(|(k, _)| k.ends_with("mcp.json")).unwrap();
    let parsed: Value = serde_json::from_str(mcp_json).unwrap();
    assert_eq!(parsed["mcpServers"]["scarlet"], json!({"command": mcp.command, "args": mcp.args, "env": mcp.env}));
    let long = build_claude_command(None, None, None, "SYS", "line1\nline2", None, false, false, None, &mcp, "claude", Path::new("/tmp/t"));
    assert_eq!(long.args[1], "--output-format");
    assert_eq!(long.stdin.as_deref(), Some("line1\nline2"));
    assert!(!cmd.args.iter().any(|a| a == "--no-session-persistence"));
    // Asked for the agent's plan, the CLI gets its own to-do tools and still nothing else of its own.
    let planned = build_claude_command(None, None, None, "SYS", "line1\nline2", None, false, true, None, &mcp, "claude", Path::new("/tmp/t"));
    assert!(planned.args.windows(2).any(|a| a == ["--tools", "ToolSearch,TaskCreate,TaskUpdate,TodoWrite"]));
    assert_eq!(planned.args.len(), long.args.len());
    let resumed = build_claude_command(None, None, None, "SYS", "The editor answered", Some("s1"), true, false, None, &mcp, "claude", Path::new("/tmp/t"));
    assert_eq!(&resumed.args[..2], &["-p", "--bare"]);
    assert!(resumed.args.join(" ").contains("--permission-mode dontAsk --resume s1 --settings"));
    assert_eq!(resumed.stdin.as_deref(), Some("The editor answered"));
    let key = std::collections::HashMap::from([("ANTHROPIC_API_KEY".to_string(), "sk-ant".to_string())]);
    assert!(can_run_bare(&key));
    assert!(!can_run_bare(&std::collections::HashMap::new()));
}

#[test]
fn reads_the_agents_plan_from_claude_codes_to_do_tools() {
    // Recorded from claude 2.1.316 launched with --tools "TaskCreate,TaskUpdate": its own to-do list, one call a step.
    let use_ = |id: &str, name: &str, input: Value| json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":name,"input":input,"caller":{"type":"direct"}}]}}).to_string();
    let done = |id: &str, content: &str, result: Value| json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":id,"type":"tool_result","content":content}]},"tool_use_result":result}).to_string();
    let created = |id: &str, n: &str, subject: &str| done(id, &format!("Task #{n} created successfully: {subject}"), json!({"task":{"id":n,"subject":subject}}));
    let updated = |id: &str, n: &str, to: &str| done(id, &format!("Updated task #{n} status"), json!({"success":true,"taskId":n,"updatedFields":["status"],"statusChange":{"to":to}}));
    let steps = |ev: &RunnerEvent| ev.data.as_ref().unwrap()["steps"].as_array().unwrap().iter()
        .map(|s| format!("{} {}", s["state"].as_str().unwrap(), s["text"].as_str().unwrap())).collect::<Vec<_>>();
    let mut st = ClaudeState::default();
    // Three steps added in one message: the plan is passed on once every one of them has its id.
    let three = json!({"type":"assistant","message":{"role":"assistant","content":[
        {"type":"tool_use","id":"c1","name":"TaskCreate","input":{"subject":"Read the scene","description":"Read the scene"}},
        {"type":"tool_use","id":"c2","name":"TaskCreate","input":{"subject":"Trim the pause","description":"Trim the pause"}},
        {"type":"tool_use","id":"c3","name":"TaskCreate","input":{"subject":"Check the join","description":"Check the join"}}]}}).to_string();
    let made = feed(&[&three, &created("c1", "1", "Read the scene"), &created("c2", "2", "Trim the pause"), &created("c3", "3", "Check the join")], &mut st);
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].kind, "plan");
    assert_eq!(made[0].text, "[ ] Read the scene\n[ ] Trim the pause\n[ ] Check the join");
    assert_eq!(steps(&made[0]), ["pending Read the scene", "pending Trim the pause", "pending Check the join"]);
    // A step changes when the tool says it did, not when the model asks.
    assert!(feed(&[&use_("u1", "TaskUpdate", json!({"taskId":"1","status":"in_progress"}))], &mut st).is_empty());
    let began = feed(&[&updated("u1", "1", "in_progress")], &mut st);
    assert_eq!(steps(&began[0]), ["in_progress Read the scene", "pending Trim the pause", "pending Check the join"]);
    let next = feed(&[
        &use_("u2", "TaskUpdate", json!({"taskId":"1","status":"completed"})), &updated("u2", "1", "completed"),
        &use_("u3", "TaskUpdate", json!({"taskId":"2","status":"in_progress","subject":"Trim the long pause"})), &updated("u3", "2", "in_progress"),
        &use_("u4", "TaskUpdate", json!({"taskId":"3","status":"deleted"})), &done("u4", "Updated task #3 deleted", json!({"success":true,"taskId":"3"})),
    ], &mut st);
    assert_eq!(next.last().unwrap().text, "[x] Read the scene\n[>] Trim the long pause");
    // A refused update, a look at the list and a step it doesn't know change nothing, and none is logged as a Scarlet tool.
    let refused = json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":"u5","type":"tool_result","is_error":true,"content":"No such task"}]}}).to_string();
    assert!(feed(&[
        &use_("u5", "TaskUpdate", json!({"taskId":"2","status":"completed"})), &refused,
        &use_("l1", "TaskList", json!({})), &done("l1", "#1 [completed] Read the scene", Value::Null),
        &use_("u6", "TaskUpdate", json!({"taskId":"9","status":"completed"})), &updated("u6", "9", "completed"),
    ], &mut st).is_empty());

    // The shape Claude Code documents for an older CLI's TodoWrite: the whole list in one call. Not a recording.
    let mut old = ClaudeState::default();
    let todos = json!({"todos":[{"content":"Read the scene","status":"completed"},{"content":"Trim the pause","status":"in_progress"},{"content":"Check the join","status":"pending"}]});
    let evs = feed(&[&use_("t1", "TodoWrite", todos.clone()), &done("t1", "Todos have been modified successfully", Value::Null), &use_("t2", "TodoWrite", todos)], &mut old);
    assert_eq!(evs, vec![RunnerEvent::with("plan", "[x] Read the scene\n[>] Trim the pause\n[ ] Check the join", json!({"steps": [
        {"text":"Read the scene","state":"done"},{"text":"Trim the pause","state":"in_progress"},{"text":"Check the join","state":"pending"}]}))]);
}

#[test]
fn keeps_result_usage_or_sums_messages_when_stopped_early() {
    let mut st = ClaudeState::default();
    feed(&[
        r#"{"type":"system","subtype":"init","model":"claude-opus-5-5","mcp_servers":[{"name":"scarlet","status":"connected"}]}"#,
        r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":3,"output_tokens":1}}}"#,
        r#"{"type":"result","subtype":"success","is_error":false,"result":"Done","total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":200,"cache_read_input_tokens":3000,"cache_creation_input_tokens":400}}"#,
    ], &mut st);
    let u = claude_run_usage(&st, None).unwrap();
    assert_eq!((u.model.as_deref(), u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens), (Some("claude-opus-5-5"), 10, 200, 3000, 400));

    let mut st = ClaudeState::default();
    feed(&[
        r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":100}}}"#,
        r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"t1","name":"mcp__scarlet__task_question","input":{"text":"Keep?"}}],"usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":100}}}"#,
        r#"{"type":"assistant","message":{"id":"msg_2","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":2,"output_tokens":4,"cache_creation_input_tokens":50}}}"#,
    ], &mut st);
    let u = claude_run_usage(&st, Some("opus")).unwrap();
    assert_eq!((u.model.as_deref(), u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens), (Some("opus"), 7, 13, 100, 50));
    assert_eq!(claude_run_usage(&ClaudeState::default(), Some("opus")), None);
}

#[cfg(unix)]
mod runs {
    use super::super::*;
    use serde_json::{json, Value};
    use crate::host::runner::testing::{fake_cli, options};

    const INIT: &str = r#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","mcp_servers":[{"name":"scarlet","status":"connected"}]}"#;
    const TEXT: &str = r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Looking at the cut."}],"usage":{"input_tokens":3,"output_tokens":2}}}"#;

    #[tokio::test]
    async fn reports_a_finished_run_with_its_result_session_and_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let result = r#"{"type":"result","subtype":"success","is_error":false,"result":"Cut two pauses.","usage":{"input_tokens":10,"output_tokens":20}}"#;
        let (opts, events) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, TEXT, result], "exit 0")));
        let run = run_claude(opts).await;
        assert!(run.ok, "{run:?}");
        assert_eq!((run.summary.as_str(), run.error.as_deref(), run.exit_code), ("Cut two pauses.", None, Some(0)));
        assert_eq!(run.session_id.as_deref(), Some("s1"));
        assert_eq!(run.usage.as_ref().map(|u| (u.input_tokens, u.output_tokens)), Some((10, 20)));
        assert!(!run.resume_failed && run.question.is_none());
        // Every line reached the host, in order.
        assert_eq!(events.lock().unwrap().iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "result"]);
        // The CLI's own files hold the engine token and the prompt.
        let mcp: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join(".scarlet/mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["scarlet"]["env"]["SCARLET_TOKEN"], json!("sct_test"));
        assert_eq!(std::fs::read_to_string(dir.path().join(".scarlet/system.md")).unwrap(), "SYSTEM");
    }

    #[tokio::test]
    async fn tells_a_cli_that_died_from_one_that_reported_an_error() {
        let dir = tempfile::tempdir().unwrap();
        // Died without a result: the exit code and what it wrote to stderr are the reason.
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, TEXT], "echo 'API Error: 529 overloaded' >&2; exit 3")));
        let run = run_claude(opts).await;
        assert_eq!((run.ok, run.exit_code), (false, Some(3)));
        assert_eq!(run.error.as_deref(), Some("claude exited with code 3: API Error: 529 overloaded"));
        // What it said before it died is kept as the summary, and its tokens are counted from the messages.
        assert_eq!(run.summary, "Looking at the cut.");
        assert_eq!(run.usage.as_ref().map(|u| (u.input_tokens, u.output_tokens)), Some((3, 2)));

        // An error result is the reason, whatever the exit code.
        let failed = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Ran out of turns."}"#;
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, failed], "exit 0")));
        let run = run_claude(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.resume_failed), (false, Some("Ran out of turns."), false));

        // A result with a failing exit code still counts: the CLI finished its work.
        let done = r#"{"type":"result","subtype":"success","is_error":false,"result":"Done."}"#;
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, done], "exit 1")));
        assert!(run_claude(opts).await.ok);
    }

    #[tokio::test]
    async fn a_resume_that_finds_no_session_asks_for_a_fresh_run_and_keeps_its_error_to_itself() {
        let dir = tempfile::tempdir().unwrap();
        let gone = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: gone"]}"#;
        let (mut opts, events) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[gone], "exit 1")));
        opts.resume_session = Some("gone".into());
        let run = run_claude(opts).await;
        assert!(!run.ok && run.resume_failed, "{run:?}");
        assert_eq!(run.session_id, None);
        assert!(run.error.as_deref().unwrap().contains("No conversation found"));
        assert!(events.lock().unwrap().is_empty(), "the failed resume showed in the task log");

        // A resumed session that did open, then failed, is an ordinary failure in that session.
        let failed = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Tool crashed"}"#;
        let (mut opts, events) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[TEXT, failed], "exit 1")));
        opts.resume_session = Some("s9".into());
        let run = run_claude(opts).await;
        assert_eq!((run.resume_failed, run.session_id.as_deref()), (false, Some("s9")));
        assert_eq!(events.lock().unwrap().iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "error"]);
    }

    #[tokio::test]
    async fn stops_the_cli_once_its_question_is_posted() {
        let dir = tempfile::tempdir().unwrap();
        let ask = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}"#;
        let posted = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}"#;
        // A real CLI would carry on talking. This one would for 30 seconds.
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, ask, posted], "sleep 30")));
        let started = std::time::Instant::now();
        let run = run_claude(opts).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(15), "waited {:?} for a CLI that had asked", started.elapsed());
        assert!(run.ok && run.question_posted, "{run:?}");
        assert_eq!((run.question.as_deref(), run.session_id.as_deref()), (Some("Keep the cold open?"), Some("s1")));
    }

    #[tokio::test]
    async fn finishes_a_run_whose_question_was_refused_without_asking_the_editor() {
        let dir = tempfile::tempdir().unwrap();
        let ask = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep it?","choices":"bad"}}]}}"#;
        let refused = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","is_error":true,"content":"InputValidationError: choices must be an array"}]}}"#;
        let done = r#"{"type":"result","subtype":"success","is_error":false,"result":"Kept both takes."}"#;
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[INIT, ask, refused, done], "exit 0")));
        let run = run_claude(opts).await;
        assert!(run.ok && run.question.is_none() && !run.question_posted, "{run:?}");
        assert_eq!(run.summary, "Kept both takes.");
    }

    #[tokio::test]
    async fn fails_a_run_whose_scarlet_mcp_server_failed_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let mcp_failed = "Scarlet's MCP server failed to start, so Claude Code had no editing tools.";
        // Recorded from claude 2.1.325: the server failed, and Claude answered without tools and called it a success.
        let failed = r#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-1","mcp_servers":[{"name":"scarlet","status":"failed","source":"dynamic"}]}"#;
        let success = r#"{"type":"result","subtype":"success","is_error":false,"result":"I can't reach the project's tools."}"#;
        let (opts, events) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[failed, success], "exit 0")));
        let run = run_claude(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.aborted, run.timed_out, run.resume_failed), (false, Some(mcp_failed), false, false, false), "{run:?}");
        assert_eq!((run.summary.as_str(), run.session_id.as_deref()), ("I can't reach the project's tools.", Some("s1")));
        assert_eq!(events.lock().unwrap()[1].text, "Scarlet MCP server status: failed");

        // Nothing useful can follow, so the CLI is stopped instead of left to write for minutes.
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[failed, TEXT], "sleep 30")));
        let started = std::time::Instant::now();
        let run = run_claude(opts).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(15), "waited {:?} for a CLI with no tools", started.elapsed());
        assert_eq!((run.ok, run.error.as_deref(), run.aborted, run.timed_out, run.stalled), (false, Some(mcp_failed), false, false, false), "{run:?}");

        // The server's failure is the cause, whatever the CLI made of it afterwards.
        let errored = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Ran out of turns."}"#;
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[failed, errored], "exit 0")));
        assert_eq!(run_claude(opts).await.error.as_deref(), Some(mcp_failed));
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[failed], "exit 3")));
        assert_eq!(run_claude(opts).await.error.as_deref(), Some(mcp_failed));

        // A resumed session is the same.
        let (mut opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[failed, success], "exit 0")));
        opts.resume_session = Some("s1".into());
        let run = run_claude(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.resume_failed, run.session_id.as_deref()), (false, Some(mcp_failed), false, Some("s1")), "{run:?}");

        // A question it posted is still a question, and a cancel is still a cancel.
        let ask = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"q1","name":"mcp__scarlet__task_question","input":{"text":"Keep the cold open?"}}]}}"#;
        let posted = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Question posted"}]}}"#;
        let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[failed, ask, posted], "sleep 30")));
        let run = run_claude(opts).await;
        assert!(run.ok && run.question_posted, "{run:?}");
        let (mut opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[failed, TEXT], "sleep 30")));
        let cancel = opts.cancel.clone();
        opts.on_event = Arc::new(move |_| cancel.cancel());
        let run = run_claude(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.aborted), (false, Some("cancelled"), true), "{run:?}");

        // Only a failed server fails the run: one still starting, or not listed at all, keeps today's result.
        let pending = r#"{"type":"system","subtype":"init","session_id":"s1","mcp_servers":[{"name":"scarlet","status":"pending"}]}"#;
        let unlisted = r#"{"type":"system","subtype":"init","session_id":"s1","mcp_servers":[]}"#;
        let no_change = r#"{"type":"result","subtype":"success","is_error":false,"result":"Nothing to change."}"#;
        for init in [INIT, pending, unlisted] {
            let (opts, _) = options("claude", dir.path(), Some(fake_cli(dir.path(), &[init, no_change], "exit 0")));
            let run = run_claude(opts).await;
            assert_eq!((run.ok, run.error.as_deref(), run.summary.as_str()), (true, None, "Nothing to change."), "{init}");
        }
    }

    #[tokio::test]
    async fn says_whether_the_host_or_the_editor_stopped_a_run() {
        let dir = tempfile::tempdir().unwrap();
        let waits = || fake_cli(dir.path(), &[INIT, TEXT], "sleep 30");
        // Silent past the stall window.
        let (mut opts, _) = options("claude", dir.path(), Some(waits()));
        // Long enough for the stand-in to start and speak on a busy machine.
        opts.stall = Some(std::time::Duration::from_secs(8));
        let run = run_claude(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.timed_out, run.stalled, run.aborted), (false, Some("stalled"), true, true, false));
        assert_eq!((run.summary.as_str(), run.session_id.as_deref()), ("Looking at the cut.", Some("s1")));
        // Past the optional cap on a whole run.
        let (mut opts, _) = options("claude", dir.path(), Some(waits()));
        opts.timeout = Some(std::time::Duration::from_secs(1));
        let run = run_claude(opts).await;
        assert_eq!((run.error.as_deref(), run.timed_out, run.stalled), (Some("timed out"), true, false));
        // Cancelled by the editor as soon as the CLI spoke.
        let (mut opts, _) = options("claude", dir.path(), Some(waits()));
        let cancel = opts.cancel.clone();
        opts.on_event = Arc::new(move |_| cancel.cancel());
        let run = run_claude(opts).await;
        assert_eq!((run.ok, run.error.as_deref(), run.aborted, run.timed_out), (false, Some("cancelled"), true, false));
        assert_eq!(run.usage.as_ref().map(|u| u.output_tokens), Some(2), "a cancelled run's tokens still count");
    }

    #[tokio::test]
    async fn fails_before_starting_when_the_cli_or_its_folder_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let (opts, _) = options("claude", dir.path(), Some(dir.path().join("no-such-cli").to_string_lossy().into_owned()));
        let run = run_claude(opts).await;
        assert!(!run.ok && run.error.as_deref().unwrap().starts_with("spawn "), "{run:?}");
        // The task folder is a file: the CLI's own files can't be written.
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, "").unwrap();
        let (opts, _) = options("claude", &blocked, Some(fake_cli(dir.path(), &[INIT], "exit 0")));
        let run = run_claude(opts).await;
        assert!(!run.ok && run.error.is_some() && run.exit_code.is_none(), "{run:?}");
    }
}

#[test]
fn gives_a_request_its_own_tools_with_the_shell_sandboxed_and_the_control_files_closed() {
    let mcp = McpSpec { command: "node".into(), args: vec![], env: BTreeMap::new() };
    let ws = Workspace { bin_dir: Some("/w/.tools".into()), read_dirs: vec!["/Applications/Google Chrome.app".into()] };
    let cmd = build_claude_command(None, None, None, "SYS", "x", None, false, false, Some(&ws), &mcp, "claude", Path::new("/w/.scarlet"));
    let after = |flag: &str| cmd.args[cmd.args.iter().position(|a| a == flag).unwrap() + 1].clone();
    assert_eq!(after("--tools"), "ToolSearch,Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
    assert_eq!(after("--allowedTools"), "mcp__scarlet__*,ToolSearch,Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,WebFetch(domain:*)");
    let settings: Value = serde_json::from_str(&after("--settings")).unwrap();
    assert_eq!(settings, json!({
        "sandbox": { "enabled": true, "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": true,
            "network": { "allowedDomains": ["*"] },
            "filesystem": { "denyRead": ["/w/.scarlet"], "allowRead": ["/Applications/Google Chrome.app"] } },
        "permissions": { "blockReadsOutsideWorkingDirectories": true, "allow": ["WebFetch(domain:*)"], "deny": ["Read(//w/.scarlet/**)", "Edit(//w/.scarlet/**)"] },
    }));
    let planned = build_claude_command(None, None, None, "SYS", "x", None, false, true, Some(&ws), &mcp, "claude", Path::new("/w/.scarlet"));
    assert_eq!(planned.args[planned.args.iter().position(|a| a == "--tools").unwrap() + 1], "ToolSearch,Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TaskCreate,TaskUpdate,TodoWrite");
}
