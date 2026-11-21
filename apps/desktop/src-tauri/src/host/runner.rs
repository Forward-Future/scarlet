//! Runner plumbing shared by the three CLI runners (RunOptions, file writing, dispatch).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio_util::sync::CancellationToken;

use super::spawn::SpawnOutcome;
use super::types::{tail_summary, McpSpec, RunResult, RunnerEvent};

pub type EventSink = Arc<dyn Fn(RunnerEvent) + Send + Sync>;
/// Takes the run's token count so far each time it changes, for a live count while the agent works.
pub type UsageSink = Arc<dyn Fn(super::usage::AgentUsage) + Send + Sync>;

pub struct RunOptions {
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub system_prompt: String,
    pub instruction: String,
    /// Continue this CLI session (it asked the question `instruction` answers).
    pub resume_session: Option<String>,
    /// Launch the CLI with its own to-do tool on. The engine decides (`plan` in the task's prompt).
    pub plan: bool,
    /// The engine's words for a run to carry on with after Scarlet refused one of its harness's own tools, `{tool}`
    /// standing for the tool (`refusedTool` in the task's prompt). Only agy needs telling.
    pub refused_tool: Option<String>,
    /// Per-task workspace. The agent may write temp files here.
    pub cwd: PathBuf,
    /// The harness's own shell, file and web tools, beside Scarlet's, for a request. None for a side check or a skill's
    /// edit, whose runs have Scarlet's tools only.
    pub workspace: Option<super::types::Workspace>,
    pub mcp: McpSpec,
    pub on_event: EventSink,
    pub on_usage: Option<UsageSink>,
    pub cancel: CancellationToken,
    /// Optional cap on the whole run. None lets a working agent take as long as it needs.
    pub timeout: Option<Duration>,
    /// Stop the CLI once it has gone this long without writing anything.
    pub stall: Option<Duration>,
    /// Override the CLI executable (tests, or a non-PATH install).
    pub bin: Option<String>,
    pub env: HashMap<String, String>,
    /// The task this run is for, to name it in the CLI's log lines.
    pub task: Option<String>,
}

/// Sends the run's count to `sink` when it differs from the one sent last.
pub fn report_usage(sink: &Option<UsageSink>, last: &mut Option<super::usage::AgentUsage>, now: Option<super::usage::AgentUsage>) {
    if let (Some(sink), Some(now)) = (sink, now) {
        if last.as_ref() != Some(&now) {
            *last = Some(now.clone());
            sink(now);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunnerCommand {
    pub file: String,
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub files: BTreeMap<PathBuf, String>,
}

pub async fn write_files(files: &BTreeMap<PathBuf, String>) -> Result<()> {
    for (p, content) in files {
        let parent = p.parent().ok_or_else(|| anyhow::anyhow!("missing runner directory"))?;
        tokio::fs::create_dir_all(parent).await?;
        // The task directory has a private ACL on Windows. On Unix tempfile
        // creates the new inode with 0600 even if an older config was public.
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(content.as_bytes())?;
        tmp.persist(p)?;
    }
    Ok(())
}

/// What a run that paused on a question, or that the host stopped, reports. None when the CLI ended by itself.
/// `base` carries what the run has either way: its tokens, and its session where the CLI keeps one.
pub fn cut_short(texts: &[String], question: Option<&String>, question_posted: bool, outcome: &SpawnOutcome, base: &RunResult) -> Option<RunResult> {
    let base = base.clone();
    if let Some(q) = question {
        return Some(RunResult { ok: true, summary: tail_summary(texts), question: Some(q.clone()), question_posted, exit_code: outcome.code, ..base });
    }
    if outcome.timed_out {
        return Some(RunResult { ok: false, summary: tail_summary(texts), error: Some(if outcome.stalled { "stalled" } else { "timed out" }.into()), timed_out: true, stalled: outcome.stalled, exit_code: outcome.code, ..base });
    }
    if outcome.aborted {
        return Some(RunResult { ok: false, summary: tail_summary(texts), error: Some("cancelled".into()), aborted: true, exit_code: outcome.code, ..base });
    }
    None
}

/// The error of a CLI that ended without saying why: its exit code, then the end of what it wrote to stderr.
pub fn exit_error(cli: &str, outcome: &SpawnOutcome) -> String {
    format!("{cli} exited with code {}{}", outcome.code.map(|c| c.to_string()).unwrap_or("null".into()), stderr_tail(&outcome.stderr))
}

pub(super) fn stderr_tail(stderr: &str) -> String {
    let t = stderr.trim();
    if t.is_empty() {
        String::new()
    } else {
        format!(": {}", crate::util::js_slice_suffix(t, 800))
    }
}

/// Dispatch on `opts.agent`.
/// A CLI's environment for a run: without Scarlet's own variables (the token among them), the workspace's launchers
/// first on its PATH. Codex reads its MCP server's variables from its own, and adds them back itself.
pub fn workspace_env(env: &HashMap<String, String>, workspace: Option<&super::types::Workspace>) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = env.iter().filter(|(k, _)| !k.to_ascii_uppercase().starts_with("SCARLET_")).map(|(k, v)| (k.clone(), v.clone())).collect();
    if let Some(bin) = workspace.and_then(|w| w.bin_dir.as_ref()) {
        let key = out.keys().find(|k| k.eq_ignore_ascii_case("PATH")).cloned().unwrap_or_else(|| "PATH".into());
        let sep = if cfg!(windows) { ";" } else { ":" };
        let joined = match out.get(&key).filter(|p| !p.is_empty()) {
            Some(path) => format!("{}{sep}{path}", bin.to_string_lossy()),
            None => bin.to_string_lossy().into_owned(),
        };
        out.insert(key, joined);
    }
    out
}

pub async fn run_agent(mut opts: RunOptions) -> RunResult {
    // Scarlet's own variables stay out of every CLI, so its shell never holds the token.
    opts.env = workspace_env(&opts.env, opts.workspace.as_ref());
    let invalid_model = opts.model.as_deref().is_some_and(|m|
        !m.starts_with(|c: char| c.is_ascii_alphanumeric()) || !m.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@+[]-".contains(c)));
    let invalid_option = [opts.effort.as_deref(), opts.service_tier.as_deref()].into_iter().flatten().any(|id|
        !id.starts_with(|c: char| c.is_ascii_alphanumeric()) || !id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)));
    if invalid_model || invalid_option {
        return RunResult::failed("Invalid model or model option");
    }
    match opts.agent.as_str() {
        "claude" => super::runner_claude::run_claude(opts).await,
        "codex" => super::runner_codex::run_codex(opts).await,
        "gemini" => super::runner_gemini::run_gemini(opts).await,
        other => RunResult::failed(format!("no runner for agent \"{other}\"")),
    }
}

/// Stand-ins for the tests of the three runners: a CLI that prints what a real one would, and the options to run it.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::sync::Mutex;

    /// A shell script that takes its prompt on stdin, prints `lines` and then runs `then` ("exit 1", "sleep 30").
    #[cfg(unix)]
    pub fn fake_cli(dir: &std::path::Path, lines: &[&str], then: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake-cli");
        std::fs::write(&script, format!("#!/bin/sh\ncat > /dev/null\ncat <<'SCARLET_LINES'\n{}\nSCARLET_LINES\n{then}\n", lines.join("\n"))).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    }

    /// Options for one run in `cwd`, and the events the run reports.
    pub fn options(agent: &str, cwd: &std::path::Path, bin: Option<String>) -> (RunOptions, Arc<Mutex<Vec<RunnerEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let mcp = McpSpec {
            command: "scarlet-engine".into(),
            args: vec!["mcp".into()],
            env: BTreeMap::from([("SCARLET_SERVER".to_string(), "http://127.0.0.1:4000".to_string()), ("SCARLET_TOKEN".to_string(), "sct_test".to_string())]),
        };
        let opts = RunOptions {
            agent: agent.into(),
            model: None,
            effort: None,
            service_tier: None,
            system_prompt: "SYSTEM".into(),
            instruction: "Cut the pauses".into(),
            resume_session: None,
            cwd: cwd.to_path_buf(),
            mcp,
            on_event: Arc::new(move |ev| seen.lock().unwrap().push(ev)),
            on_usage: None,
            cancel: CancellationToken::new(),
            timeout: None,
            stall: None,
            bin,
            env: crate::util::env_map(),
            task: None,
            plan: false,
            refused_tool: None,
            workspace: None,
        };
        (opts, events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_usage_only_when_the_count_changes() {
        use super::super::usage::AgentUsage;
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: Option<UsageSink> = Some({ let seen = seen.clone(); Arc::new(move |u: AgentUsage| seen.lock().unwrap().push(u.output_tokens)) });
        let mut last = None;
        let at = |n| Some(AgentUsage { output_tokens: n, ..Default::default() });
        for now in [None, at(5), at(5), at(9), None, at(9)] {
            report_usage(&sink, &mut last, now);
        }
        assert_eq!(*seen.lock().unwrap(), vec![5, 9]);
    }

    #[tokio::test]
    async fn refuses_a_model_or_option_that_could_pass_for_a_cli_flag() {
        let dir = tempfile::tempdir().unwrap();
        let run = |agent: &str, model: Option<&str>, effort: Option<&str>, tier: Option<&str>| {
            let (mut opts, _) = testing::options(agent, dir.path(), None);
            (opts.model, opts.effort, opts.service_tier) = (model.map(String::from), effort.map(String::from), tier.map(String::from));
            // No CLI can be found, so a run that gets past the check ends there.
            opts.env = HashMap::from([("PATH".to_string(), dir.path().to_string_lossy().into_owned())]);
            run_agent(opts)
        };
        for model in ["--settings={}", "-m", "", "opus 4", "opus;rm", "$(id)", "opus\n--bare"] {
            let result = run("claude", Some(model), None, None).await;
            assert_eq!((result.ok, result.error.as_deref()), (false, Some("Invalid model or model option")), "model {model:?}");
        }
        for option in ["--max", "hi gh", "", "x/y", "a:b"] {
            assert_eq!(run("codex", None, Some(option), None).await.error.as_deref(), Some("Invalid model or model option"), "effort {option:?}");
            assert_eq!(run("codex", None, None, Some(option)).await.error.as_deref(), Some("Invalid model or model option"), "tier {option:?}");
        }
        // Real ids pass the check and reach the runner, which then finds no CLI.
        for (agent, model) in [("claude", "claude-opus-4-1[1m]"), ("codex", "gpt-5.5"), ("gemini", "models/gemini-2.5-pro"), ("claude", "us.anthropic.claude-sonnet-4@20250514")] {
            let result = run(agent, Some(model), Some("xhigh"), Some("fast")).await;
            let bin = crate::host::detect::cli_binary(agent);
            assert_eq!(result.error, Some(format!("{bin} CLI not found on PATH")), "{model}");
        }
        let unknown = run("cursor", None, None, None).await;
        assert_eq!((unknown.ok, unknown.error.as_deref()), (false, Some("no runner for agent \"cursor\"")));
    }

    #[tokio::test]
    async fn writes_runner_files_into_new_folders_for_the_owner_alone() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("task").join(".scarlet").join("mcp.json");
        let beside = dir.path().join("task").join("AGENTS.md");
        // An older version left a config anyone could read.
        std::fs::create_dir_all(beside.parent().unwrap()).unwrap();
        std::fs::write(&beside, "old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&beside, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_files(&BTreeMap::from([(nested.clone(), "{\"token\":\"sct\"}".to_string()), (beside.clone(), "SYSTEM".to_string())])).await.unwrap();
        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "{\"token\":\"sct\"}");
        assert_eq!(std::fs::read_to_string(&beside).unwrap(), "SYSTEM");
        #[cfg(unix)]
        for file in [&nested, &beside] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600, "{}", file.display());
        }
        // Nothing is left beside them from the write.
        let mut names: Vec<_> = std::fs::read_dir(dir.path().join("task")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, [".scarlet", "AGENTS.md"]);
        // A path with no folder to write into is refused, and a folder that is a file fails.
        assert!(write_files(&BTreeMap::from([(PathBuf::new(), String::new())])).await.is_err());
        assert!(write_files(&BTreeMap::from([(beside.join("under-a-file.json"), String::new())])).await.is_err());
    }
}
