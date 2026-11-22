use super::*;
use crate::host::runner::testing::sample_mcp;

fn feed(lines: &[&str], st: &mut GeminiState) -> Vec<RunnerEvent> {
    lines.iter().flat_map(|l| parse_gemini_line(l, st)).collect()
}

const FIXTURE: [&str; 8] = [
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Checking transcript"}}}}"#,
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Reading the "}}}}"#,
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"transcript."}}}}"#,
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call","toolCallId":"c1","name":"mcp__scarlet__transcript_get","rawInput":{"mediaId":"m1"}}}}"#,
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed"}}}"#,
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call","toolCallId":"c2","name":"scarlet:task_question","rawInput":{"text":"9:16 or 16:9?"}}}}"#,
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"tool_call_update","toolCallId":"c2","status":"completed","rawOutput":{"ok":true}}}}"#,
    r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":{"sessionUpdate":"usage_update","usage":{"inputTokens":1200,"outputTokens":300,"cachedReadTokens":1000}}}}"#,
];

#[test]
fn accumulates_acp_deltas_maps_tools_and_detects_the_question() {
    let mut st = GeminiState { model: Some("gemini-3.1-pro".into()), ..Default::default() };
    let evs = feed(&FIXTURE, &mut st);
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["log", "log", "tool", "question"]);
    assert!(evs[0].text.contains("Checking transcript"));
    assert_eq!(evs[1].text, "Reading the transcript.");
    assert_eq!(evs[2].text, r#"scarlet.transcript_get {"mediaId":"m1"}"#);
    assert_eq!(st.question.as_deref(), Some("9:16 or 16:9?"));
    assert!(st.question_posted);
    assert!(st.should_stop);
    let u = st.usage.unwrap();
    assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens), (1200, 300, 1000));
    assert_eq!(u.model.as_deref(), Some("gemini-3.1-pro"));
}

#[test]
fn a_question_the_mcp_server_refused_or_with_no_words_is_no_question() {
    let update = |u: Value| json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"g1","update":u}}).to_string();
    let ask = |id: &str, input: Value| update(json!({"sessionUpdate":"tool_call","toolCallId":id,"name":"mcp_scarlet_task_question","rawInput":input}));
    let ended = |id: &str, end: Value| {
        let mut u = json!({"sessionUpdate":"tool_call_update","toolCallId":id});
        u.as_object_mut().unwrap().extend(end.as_object().unwrap().clone());
        update(u)
    };
    let kinds = |evs: &[RunnerEvent]| evs.iter().map(|e| e.kind.clone()).collect::<Vec<_>>();
    // No words worth asking: an ordinary call, whatever its result. It never becomes the question.
    for input in [json!({"question":"Which take?"}), json!({"text":""}), json!({"text":"  "}), json!({})] {
        let mut st = GeminiState::default();
        let evs = feed(&[&ask("c1", input.clone()), &ended("c1", json!({"status":"completed","rawOutput":{"ok":true}}))], &mut st);
        assert!(evs.is_empty(), "{input}: {evs:?}");
        assert!(st.question.is_none() && !st.should_stop && !st.question_posted, "{input}");
    }
    // Words the server refused, whichever way it says so: dropped, the refusal logged, and the run goes on.
    for end in [json!({"status":"failed","rawOutput":"text: Required"}), json!({"status":"completed","rawOutput":{"isError":true}})] {
        let mut st = GeminiState::default();
        let evs = feed(&[&ask("c2", json!({"text":"Which take?"})), &ended("c2", end.clone())], &mut st);
        assert_eq!(kinds(&evs), ["error"], "{end}");
        assert_eq!(evs[0].data, Some(json!({"toolId":"c2"})));
        assert!(st.question.is_none() && st.pending_question_id.is_none() && !st.should_stop && !st.question_posted, "{end}");
        // The model asks again, its words coming with the update this time, and that one is the editor's.
        let evs = feed(&[&ask("c3", json!({})), &ended("c3", json!({"status":"completed","rawInput":{"text":"Keep the cold open?"}}))], &mut st);
        assert_eq!(evs, vec![RunnerEvent::with("question", "Keep the cold open?", json!({"tool":"scarlet.task_question","toolId":"c3"}))]);
        assert!(st.question_posted && st.should_stop);
    }
}

#[test]
fn maps_plan_updates_and_tool_failures() {
    let mut st = GeminiState::default();
    let evs = feed(
        &[
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[{"content":"Inspect timeline","status":"completed"},{"content":"Trim intro","status":"in_progress"}]}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","name":"scarlet__clip_cut"}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"failed","rawOutput":"clip missing"}}}"#,
        ],
        &mut st,
    );
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["plan", "tool", "error"]);
    assert!(evs[0].text.contains("[x] Inspect timeline"));
    assert!(evs[0].text.contains("[>] Trim intro"));
    assert!(evs[2].text.contains("scarlet.clip_cut failed"));
}

#[test]
fn allows_only_scarlet_mcp_permissions() {
    assert!(is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "mcp__scarlet__timeline_get" } })));
    assert!(is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "scarlet:task_question" } })));
    assert!(is_scarlet_mcp_permission(&json!({ "toolCall": { "_meta": { "mcpServer": "scarlet" }, "name": "timeline_get" } })));
    assert!(!is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "run_shell_command" } })));
    assert!(!is_scarlet_mcp_permission(&json!({ "toolCall": { "name": "write_file" } })));
    // agy names Scarlet's tools `mcp_scarlet_<tool>` to the model (its transcript.jsonl, agy 1.5.13). A request that
    // names no tool is read by its title, which may say more after the name.
    for call in [
        json!({ "name": "mcp_scarlet_project_get" }),
        json!({ "toolName": "mcp_scarlet_dialogue_apply_cuts" }),
        json!({ "title": "mcp_scarlet_timeline_get" }),
        json!({ "title": "scarlet/timeline_propose (2 ops)" }),
        json!({ "title": "  Scarlet.Frame_Contact_Sheet_Batch  " }),
        json!({ "name": "scarlet__tool_help" }),
        json!({ "name": "mcp__scarlet__skill_save_edit" }),
        json!({ "name": " ", "title": "scarlet:task_question" }),
    ] {
        assert!(is_scarlet_mcp_permission(&json!({ "toolCall": call })), "{call}");
    }
    // A title is display text: a built-in tool on a file that merely starts with "scarlet" is not Scarlet's, and nor
    // is a built-in tool whose title the model filled with a Scarlet tool's name.
    for call in [
        json!({ "title": "scarlet/notes.md" }),
        json!({ "title": "scarlet.json" }),
        json!({ "title": "scarlet/timeline_get.md" }),
        json!({ "title": "scarlet:project_get/../../.ssh/id_rsa" }),
        json!({ "title": "Write scarlet/timeline_get" }),
        json!({ "name": "scarlet__timeline_getter" }),
        json!({ "name": "mcp_scarlet_run_shell_command" }),
        json!({ "title": "scarlet/" }),
        json!({ "name": "write_file", "title": "mcp_scarlet_timeline_get" }),
        json!({ "_meta": { "mcpServer": "scarlet-notes" }, "title": "scarlet/notes.md" }),
    ] {
        assert!(!is_scarlet_mcp_permission(&json!({ "toolCall": call })), "{call}");
    }

    let params = json!({
        "options": [
            { "optionId": "allow_1", "kind": "allow_once" },
            { "optionId": "reject_1", "kind": "reject_once" }
        ]
    });
    assert_eq!(permission_outcome(&params, true), json!({ "outcome": "selected", "optionId": "allow_1" }));
    assert_eq!(permission_outcome(&params, false), json!({ "outcome": "selected", "optionId": "reject_1" }));
    assert_eq!(permission_outcome(&json!({}), false), json!({ "outcome": "cancelled" }));
}

/// Scarlet's tools as editingTools.ts lists them, so the copy agy's permission check uses can't drift from them.
#[test]
fn knows_every_tool_scarlet_offers_and_no_other() {
    let source = include_str!("../../../../../../packages/shared/src/editingTools.ts");
    let groups = regex::Regex::new(r"tools:\s*\[([^\]]*)\]").unwrap();
    let names = regex::Regex::new(r#""([a-z0-9_]+)""#).unwrap();
    let mut listed: Vec<&str> = groups.captures_iter(source)
        .flat_map(|group| names.captures_iter(group.get(1).unwrap().as_str()).map(|n| n.get(1).unwrap().as_str()).collect::<Vec<_>>())
        .collect();
    assert!(listed.len() > 40, "read {} tools from editingTools.ts", listed.len());
    // The MCP server adds tool_help, which gives Gemini a tool's whole description.
    listed.push("tool_help");
    listed.sort_unstable();
    let mut ours = SCARLET_TOOLS.to_vec();
    ours.sort_unstable();
    assert_eq!(ours, listed, "SCARLET_TOOLS differs from packages/shared/src/editingTools.ts");
}

#[test]
fn builds_acp_command_prompt_meta_and_mcp_server_entry() {
    let mcp = sample_mcp();
    let cmd = build_gemini_command("agy");
    assert_eq!(cmd.file, "agy");
    assert_eq!(cmd.args, ["acp", "--sandbox", "--disable-telemetry"]);
    assert_eq!(cmd.stdin, None);
    // No GEMINI.md: agy cuts a rule file off at 24,000 bytes.
    assert!(cmd.files.is_empty());
    assert_eq!(
        system_prompt_meta("SYS"),
        json!({ "antigravity": { "systemPrompt": { "append": "SYS" } } })
    );

    let server = acp_mcp_server(&mcp);
    assert_eq!(server["name"], json!("scarlet"));
    assert_eq!(server["command"], json!(mcp.command));
    assert_eq!(server["args"], json!(mcp.args));
    assert_eq!(
        server["env"],
        json!([
            { "name": "SCARLET_SERVER", "value": "http://localhost:4000" },
            { "name": "SCARLET_TOKEN", "value": "a\"b" }
        ])
    );
}

/// A fake `agy acp` that logs what it is sent. Its first turn asks to run a shell command, which Scarlet refuses,
/// and ends there, as agy does. Unless `refuses_always`, the turn after says what it did.
#[cfg(unix)]
fn fake_agy(dir: &std::path::Path, refuses_always: bool) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let log_path = dir.join("requests.jsonl");
    let script = dir.join("fake-agy");
    let carry_on = if refuses_always { "never-sent" } else { "Scarlet refused" };
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  id=$(printf '%s' "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  case "$line" in
    *'"method":"initialize"'*)
      echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"_meta":{{"antigravity":{{"systemPrompt":{{"append":true}}}}}}}}}}}}'
      ;;
    *'"method":"session/new"'*)
      echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s-1","configOptions":[{{"id":"model","category":"model","currentValue":"gemini-3-flash"}},{{"id":"thought_level","category":"thought_level","currentValue":"medium"}}]}} }}'
      ;;
    *'"method":"session/set_config_option"'*'"configId":"model"'*)
      echo '{{"jsonrpc":"2.0","id":3,"result":{{"configOptions":[{{"id":"model","category":"model","currentValue":"gemini-3.1-pro"}},{{"id":"thought_level","category":"thought_level","currentValue":"medium"}}]}} }}'
      ;;
    *'"method":"session/set_config_option"'*'"configId":"thought_level"'*)
      echo '{{"jsonrpc":"2.0","id":4,"result":{{}}}}'
      ;;
    *'"method":"session/prompt"'*'{}'*)
      echo '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"Trimmed clip."}}}}}} }}'
      echo "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\",\"usage\":{{\"inputTokens\":500,\"outputTokens\":100,\"cachedReadTokens\":200,\"totalTokens\":800}}}}}}"
      ;;
    *'"method":"session/prompt"'*)
      echo '{{"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{{"toolCall":{{"name":"mcp__scarlet__timeline_get"}},"options":[{{"optionId":"yes","kind":"allow_once"}},{{"optionId":"no","kind":"reject_once"}}]}} }}'
      echo '{{"jsonrpc":"2.0","id":100,"method":"session/request_permission","params":{{"toolCall":{{"name":"run_shell_command"}},"options":[{{"optionId":"yes","kind":"allow_once"}},{{"optionId":"no","kind":"reject_once"}}]}} }}'
      echo "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\",\"usage\":{{\"inputTokens\":150,\"outputTokens\":40,\"cachedReadTokens\":800,\"totalTokens\":990}}}}}}"
      ;;
  esac
done
"#,
            log_path.display(),
            carry_on
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script, log_path)
}

#[cfg(unix)]
#[tokio::test]
async fn runs_acp_session_with_model_effort_permissions_and_usage() {
    let dir = tempfile::tempdir().unwrap();
    let (script, log_path) = fake_agy(dir.path(), false);
    let (mut opts, events) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
    opts.model = Some("gemini-3.1-pro".into());
    opts.effort = Some("high".into());
    opts.instruction = "Trim the clip".into();
    opts.system_prompt = "You are editing a video in Scarlet".into();

    let res = run_gemini(opts).await;
    assert!(res.ok, "unexpected error: {:?}", res.error);
    assert_eq!(res.summary, "Trimmed clip.");
    assert_eq!(res.session_id.as_deref(), Some("s-1"));
    let u = res.usage.unwrap();
    // Both the refused first turn (150 in, 40 out, 800 cache) and the carry-on turn (500 in, 100 out, 200 cache) count.
    assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens), (650, 140, 1000));
    assert_eq!(u.model.as_deref(), Some("gemini-3.1-pro"));

    let sent = std::fs::read_to_string(&log_path).unwrap();
    assert!(sent.contains(r#""systemPrompt":{"append":"You are editing a video in Scarlet"}"#));
    assert!(!dir.path().join("GEMINI.md").exists());
    assert!(sent.contains(r#""configId":"model""#));
    assert!(sent.contains(r#""value":"gemini-3.1-pro""#));
    assert!(sent.contains(r#""configId":"thought_level""#));
    assert!(sent.contains(r#""value":"high""#));
    assert!(sent.contains(r#""id":99"#) && sent.contains(r#""optionId":"yes""#));
    assert!(sent.contains(r#""id":100"#) && sent.contains(r#""optionId":"no""#));
    // agy ended the first turn on the refused shell command: the run carried on, and was told why.
    assert_eq!(sent.matches(r#""method":"session/prompt""#).count(), 2);
    assert!(sent.contains("Scarlet refused run_shell_command: only Scarlet's own tools"));
    let events = events.lock().unwrap();
    assert!(events.iter().any(|e| e.kind == "log"
        && e.data.as_ref().is_some_and(|d| d["kind"] == "tool_refused" && d["harnessTool"] == "run_shell_command")));
    assert_eq!(events.iter().filter(|e| e.kind == "result").count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn finishes_a_run_whose_question_was_refused_without_asking_the_editor() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake-agy-refused-question");
    let init = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"_meta":{"antigravity":{"systemPrompt":{"append":true}}}}}}"#;
    let ask = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"q1","name":"mcp_scarlet_task_question","rawInput":{"text":""}}}}"#;
    let refused = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"q1","status":"failed","rawOutput":"text must not be empty"}}}"#;
    let said = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Kept both takes."}}}}"#;
    std::fs::write(&script, format!(r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{init}' ;;
    *'"method":"session/new"'*) echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s-q"}}}}' ;;
    *'"method":"session/prompt"'*)
      echo '{ask}'
      echo '{refused}'
      echo '{said}'
      echo '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn"}}}}'
      ;;
  esac
done
"#)).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (opts, _) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
    let res = run_gemini(opts).await;
    assert!(res.ok && res.question.is_none() && !res.question_posted, "{res:?}");
    assert_eq!(res.summary, "Kept both takes.");
}

#[cfg(unix)]
#[tokio::test]
async fn carries_on_after_a_refusal_in_the_engines_words() {
    let dir = tempfile::tempdir().unwrap();
    let (script, log_path) = fake_agy(dir.path(), false);
    let (mut opts, _) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
    opts.refused_tool = Some("Scarlet refused {tool} here. Carry on with Scarlet's tools only.".into());
    let res = run_gemini(opts).await;
    assert!(res.ok, "{:?}", res.error);
    let sent = std::fs::read_to_string(&log_path).unwrap();
    assert!(sent.contains("Scarlet refused run_shell_command here. Carry on with Scarlet's tools only."), "{sent}");
    assert!(!sent.contains("the scarlet MCP server"), "the host's own words went too: {sent}");
}

#[cfg(unix)]
#[tokio::test]
async fn fails_clearly_with_an_agy_that_wont_take_scarlets_instructions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("requests.jsonl");
    let script = dir.path().join("fake-agy-old");
    // An agy whose initialize offers no systemPrompt.append: it would open the session and drop Scarlet's prompt.
    std::fs::write(&script, format!(r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  case "$line" in
    *'"method":"initialize"'*) echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"loadSession":true}},"agentInfo":{{"name":"Antigravity ACP Server","version":"1.4.0"}}}}}}' ;;
    *'"method":"session/new"'*) echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s-old"}}}}' ;;
    *'"method":"session/prompt"'*) echo '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn"}}}}' ;;
  esac
done
"#, log_path.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let (opts, events) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
    let res = run_gemini(opts).await;
    assert!(!res.ok);
    let error = res.error.unwrap_or_default();
    assert_eq!(error, "This agy 1.4.0 doesn't take Scarlet's instructions (its initialize result lists no systemPrompt.append), so Gemini would edit without them. Update agy.");
    assert!(!std::fs::read_to_string(&log_path).unwrap().contains("session/new"), "a session was opened without Scarlet's prompt");
    assert!(events.lock().unwrap().iter().any(|e| e.kind == "error" && e.text == error));
}

#[cfg(unix)]
#[tokio::test]
async fn uses_only_the_trimmed_final_message_as_summary() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fake-agy-multi");
    let earlier = format!("{}and checking the last transition areas.", "Checking transition areas. ".repeat(90));
    let progress = "Framing the benchmark graph demo cleanly inside the Kimi window.";
    let final_reply = format!("Synced and tightened the video.\n\n{}All cuts are ready.", "Detailed follow-up note. ".repeat(100));
    assert!(final_reply.len() > 2000);
    let u1 = serde_json::to_string(&json!({
        "jsonrpc": "2.0", "method": "session/update",
        "params": { "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": format!("\n\n{earlier}") } } }
    }))
    .unwrap();
    let t1 = serde_json::to_string(&json!({
        "jsonrpc": "2.0", "method": "session/update",
        "params": { "update": { "sessionUpdate": "tool_call", "toolCallId": "t1", "name": "mcp__scarlet__timeline_get", "rawInput": {} } }
    }))
    .unwrap();
    let u2 = serde_json::to_string(&json!({
        "jsonrpc": "2.0", "method": "session/update",
        "params": { "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": format!("\n\n{progress}") } } }
    }))
    .unwrap();
    let t2 = serde_json::to_string(&json!({
        "jsonrpc": "2.0", "method": "session/update",
        "params": { "update": { "sessionUpdate": "tool_call", "toolCallId": "t2", "name": "mcp__scarlet__timeline_propose", "rawInput": {} } }
    }))
    .unwrap();
    let u3 = serde_json::to_string(&json!({
        "jsonrpc": "2.0", "method": "session/update",
        "params": { "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": format!("\n\n{final_reply}\n") } } }
    }))
    .unwrap();
    let lines_path = dir.path().join("updates.jsonl");
    std::fs::write(&lines_path, format!("{u1}\n{t1}\n{u2}\n{t2}\n{u3}\n")).unwrap();
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  case "$line" in
    *'"method":"initialize"'*) echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"_meta":{{"antigravity":{{"systemPrompt":{{"append":true}}}}}}}}}}}}' ;;
    *'"method":"session/new"'*) echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s-2"}}}}' ;;
    *'"method":"session/prompt"'*)
      cat '{}'
      echo "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\"}}}}"
      ;;
  esac
done
"#,
            lines_path.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let (opts, events) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
    let res = run_gemini(opts).await;
    assert!(res.ok, "unexpected error: {:?}", res.error);
    assert_eq!(res.summary, final_reply);
    let events = events.lock().unwrap();
    assert_eq!(events.iter().find(|e| e.kind == "result").map(|e| e.text.as_str()), Some(final_reply.as_str()));
    let logs: Vec<&str> = events.iter().filter(|e| e.kind == "log").map(|e| e.text.as_str()).collect();
    assert_eq!(logs, vec!["Gemini session started", earlier.as_str(), progress, final_reply.as_str()]);
}

#[cfg(unix)]
#[tokio::test]
async fn stops_a_run_whose_turns_keep_ending_on_refused_tools() {
    let dir = tempfile::tempdir().unwrap();
    let (script, log_path) = fake_agy(dir.path(), true);
    let (opts, events) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));

    let res = run_gemini(opts).await;
    assert!(!res.ok);
    assert_eq!(
        res.error.as_deref(),
        Some("Gemini stopped after Scarlet refused run_shell_command, a tool that doesn't run in Scarlet, 5 times.")
    );
    let sent = std::fs::read_to_string(&log_path).unwrap();
    assert_eq!(sent.matches(r#""method":"session/prompt""#).count(), 5);
    assert!(!events.lock().unwrap().iter().any(|e| e.kind == "result"));
}

#[cfg(unix)]
#[tokio::test]
async fn streams_live_token_usage_from_agy_transcript_and_skips_prior_steps_on_resume() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let transcript = home.join(".gemini/antigravity-cli/brain/s-live/.system_generated/logs/transcript.jsonl");
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    let script = dir.path().join("fake-agy-live");
    std::fs::write(
        &script,
        format!(
            r#"#!/bin/sh
TRANSCRIPT='{}'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  case "$line" in
    *'"method":"initialize"'*)
      echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"_meta":{{"antigravity":{{"systemPrompt":{{"append":true}}}}}}}}}}}}'
      ;;
    *'"method":"session/new"'*)
      echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s-live"}}}}'
      ;;
    *'"method":"session/resume"'*)
      echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s-live"}}}}'
      ;;
    *'"method":"session/prompt"'*'resumed'*)
      printf '%s\n' '{{"step_index":10,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":300,"cache_read_tokens":5000,"output_tokens":40}}' >> "$TRANSCRIPT"
      echo '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"usage_update","used":5340,"size":1048576}}}}}}'
      echo "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\",\"usage\":{{\"inputTokens\":300,\"outputTokens\":40,\"cachedReadTokens\":5000,\"thoughtTokens\":25,\"totalTokens\":5340}}}}}}"
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{{"step_index":1,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":1000,"cache_read_tokens":0,"output_tokens":50}}' >> "$TRANSCRIPT"
      printf '%s' '{{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":200,' >> "$TRANSCRIPT"
      echo '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"usage_update","used":1050,"size":1048576}}}}}}'
      echo '{{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{{"toolCall":{{"name":"mcp__scarlet__timeline_get"}},"options":[{{"optionId":"yes","kind":"allow_once"}}]}} }}'
      IFS= read -r _perm_reply
      printf '%s\n' '"cache_read_tokens":1000,"output_tokens":30}}' >> "$TRANSCRIPT"
      echo '{{"jsonrpc":"2.0","method":"session/update","params":{{"update":{{"sessionUpdate":"usage_update","used":1230,"size":1048576}}}}}}'
      echo "{{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{{\"stopReason\":\"end_turn\",\"usage\":{{\"inputTokens\":1200,\"outputTokens\":80,\"cachedReadTokens\":1000,\"thoughtTokens\":60,\"totalTokens\":2280}}}}}}"
      ;;
  esac
done
"#,
            transcript.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let (mut opts, _) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
    opts.model = Some("gemini-4-neon".into());
    opts.env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let reports: Arc<Mutex<Vec<AgentUsage>>> = Arc::default();
    let reports_sink = reports.clone();
    opts.on_usage = Some(Arc::new(move |u| reports_sink.lock().unwrap().push(u)));

    let res = run_gemini(opts).await;
    assert!(res.ok, "{:?}", res.error);
    let seen = reports.lock().unwrap().clone();
    assert_eq!(seen.len(), 3, "expected 2 live step reports + final authoritative report, got {seen:?}");
    assert_eq!((seen[0].input_tokens, seen[0].cache_read_tokens, seen[0].output_tokens, seen[0].reasoning_tokens), (1000, 0, 50, 0));
    assert_eq!((seen[1].input_tokens, seen[1].cache_read_tokens, seen[1].output_tokens, seen[1].reasoning_tokens), (1200, 1000, 80, 0));
    assert_eq!((seen[2].input_tokens, seen[2].cache_read_tokens, seen[2].output_tokens, seen[2].reasoning_tokens), (1200, 1000, 80, 60));
    assert_eq!(res.usage.as_ref().map(|u| (u.input_tokens, u.cache_read_tokens, u.output_tokens, u.reasoning_tokens)), Some((1200, 1000, 80, 60)));

    // Resuming the same session must skip the earlier claim's steps in transcript.jsonl.
    let (mut resume_opts, _) = crate::host::runner::testing::options("gemini", dir.path(), Some(script.to_string_lossy().into_owned()));
    resume_opts.model = Some("gemini-4-neon".into());
    resume_opts.instruction = "resumed turn".into();
    resume_opts.resume_session = Some("s-live".into());
    resume_opts.env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let resume_reports: Arc<Mutex<Vec<AgentUsage>>> = Arc::default();
    let resume_sink = resume_reports.clone();
    resume_opts.on_usage = Some(Arc::new(move |u| resume_sink.lock().unwrap().push(u)));

    let resumed = run_gemini(resume_opts).await;
    assert!(resumed.ok, "{:?}", resumed.error);
    let resumed_seen = resume_reports.lock().unwrap().clone();
    assert_eq!(resumed_seen.len(), 2, "expected 1 live report + 1 final report, got {resumed_seen:?}");
    assert_eq!((resumed_seen[0].input_tokens, resumed_seen[0].cache_read_tokens, resumed_seen[0].output_tokens), (300, 5000, 40));
    assert_eq!((resumed_seen[1].input_tokens, resumed_seen[1].cache_read_tokens, resumed_seen[1].output_tokens, resumed_seen[1].reasoning_tokens), (300, 5000, 40, 25));
}

#[test]
fn lets_a_request_use_agys_own_tools_inside_its_folders_only() {
    let roots = vec!["/w".to_string(), "/Applications/Google Chrome.app".to_string()];
    let allow = |call: Value| workspace_permission(&json!({ "toolCall": call }), &roots);
    assert!(allow(json!({ "name": "mcp__scarlet__timeline_get" })));
    assert!(allow(json!({ "name": "run_shell_command", "rawInput": { "command": "ffmpeg -version" } })));
    assert!(allow(json!({ "name": "write_file", "locations": [{ "path": "/w/artifacts/page.html" }] })));
    assert!(allow(json!({ "name": "web_fetch", "rawInput": { "url": "https://example.com/story" } })));
    assert!(!allow(json!({ "name": "read_file", "rawInput": { "absolute_path": "/Users/me/Library/Application Support/com.forwardfuture.scarlet/data/access-token" } })));
    assert!(!allow(json!({ "name": "read_file", "locations": [{ "path": "/w/../etc/passwd" }] })));
    assert!(!allow(json!({ "name": "read_file", "rawInput": { "path": "~/.ssh/id_rsa" } })));
    assert!(!allow(json!({ "name": "list_dir", "rawInput": { "paths": ["/w/artifacts", "/w2"] } })));
}
