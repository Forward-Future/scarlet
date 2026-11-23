//! The command line Claude Code runs with: its tools, settings, MCP configuration and environment.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::json;

use crate::host::runner::RunnerCommand;
use crate::host::types::{McpSpec, Workspace};

/// Claude Code's own to-do tools, which Scarlet reads the agent's plan from and never calls. TaskCreate adds one step
/// and its result names the step's id; TaskUpdate changes one step by id. A Claude Code from before those has
/// TodoWrite, which takes the whole list. `--tools` takes the names a CLI knows and passes over the rest.
pub const CLAUDE_PLAN_TOOLS: &str = "TaskCreate,TaskUpdate,TodoWrite";
/// Claude Code's own tools a request's agent has beside Scarlet's: a shell, files and the web.
pub const CLAUDE_WORKSPACE_TOOLS: [&str; 8] = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];
/// Claude Code's tool search: Scarlet's tools are listed by name and each one's definition loads, whole, when the model
/// looks it up. Without it every definition is sent on every turn and a description is cut at 4,096 characters
/// (`CLAUDE_TOOL_SEARCH` in the TypeScript runner says more).
pub const CLAUDE_TOOL_SEARCH: &str = "ToolSearch";

/// MCP config JSON for Claude Code (`--mcp-config`).
pub fn mcp_config_json(mcp: &McpSpec) -> String {
    let v = json!({ "mcpServers": { "scarlet": { "command": mcp.command, "args": mcp.args, "env": mcp.env } } });
    serde_json::to_string_pretty(&v).unwrap()
}

/// Claude Code's MCP deadline for Scarlet's tools, in milliseconds.
const TOOL_TIMEOUT_MS: u64 = 300_000;

/// Scarlet's tools wait up to `toolWaitSeconds` (capabilities.ts) for evidence still being measured, a margin under
/// 300 s, past Claude Code's default MCP deadline. A longer deadline the user set stays; a shorter one would cut those
/// waits off, so it is raised.
pub(super) fn with_tool_timeout(env: &std::collections::HashMap<String, String>) -> std::collections::HashMap<String, String> {
    let mut env = env.clone();
    let theirs = env.get("MCP_TOOL_TIMEOUT").and_then(|v| v.trim().parse::<f64>().ok()).filter(|ms| ms.is_finite() && *ms > 0.0);
    let ms = theirs.map(|ms| (ms.floor() as u64).max(TOOL_TIMEOUT_MS)).unwrap_or(TOOL_TIMEOUT_MS);
    env.insert("MCP_TOOL_TIMEOUT".into(), ms.to_string());
    env
}

/// `--bare` reads only ANTHROPIC_API_KEY or a cloud provider, never a subscription login, so it is added only where
/// one of those is set. On a subscription run it is `--restricted`, which every run has, that keeps the user's hooks,
/// plugins and CLAUDE.md out.
pub fn can_run_bare(env: &std::collections::HashMap<String, String>) -> bool {
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].iter().any(|k| env.get(*k).is_some_and(|v| !v.is_empty()))
}

/// Build the exact command line (pure, for tests and for reporting).
#[allow(clippy::too_many_arguments)]
pub fn build_claude_command(model: Option<&str>, effort: Option<&str>, service_tier: Option<&str>, system_prompt: &str, instruction: &str, resume_session: Option<&str>, bare: bool, plan: bool, workspace: Option<&Workspace>, mcp: &McpSpec, bin: &str, tmp_dir: &Path) -> RunnerCommand {
    let mcp_config_path = tmp_dir.join("mcp.json");
    let system_path = tmp_dir.join("system.md");
    // Tool search, a request's own shell, file and web tools, and Claude Code's to-do list when the engine asks for the
    // agent's plan. A side check has only tool search.
    let mut tools: Vec<&str> = vec![CLAUDE_TOOL_SEARCH];
    if workspace.is_some() { tools.extend(CLAUDE_WORKSPACE_TOOLS); }
    if plan { tools.extend(CLAUDE_PLAN_TOOLS.split(',')); }
    let tools = tools.join(",");
    let mut allowed = vec!["mcp__scarlet__*", CLAUDE_TOOL_SEARCH];
    if workspace.is_some() { allowed.extend(CLAUDE_WORKSPACE_TOOLS); allowed.push("WebFetch(domain:*)"); }
    let allowed = allowed.join(",");
    let mut args: Vec<String> = vec!["-p".into()];
    if bare {
        args.push("--bare".into());
    }
    args.extend(
        [
            "--output-format",
            "stream-json",
            "--verbose",
            "--mcp-config",
            &mcp_config_path.to_string_lossy(),
            "--strict-mcp-config",
            "--restricted",
            "--disable-slash-commands",
            "--tools",
            &tools,
            "--allowedTools",
            &allowed,
            "--append-system-prompt-file",
            &system_path.to_string_lossy(),
            "--permission-mode",
            "dontAsk",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    // Sessions persist so a run paused on a question can continue with the answer.
    if let Some(id) = resume_session {
        args.extend(["--resume".into(), id.to_string()]);
    }
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(e) = effort {
        args.push("--effort".into());
        args.push(e.to_string());
    }
    // A request's shell runs in Claude Code's sandbox, writing only in the task folder; it reaches any web address
    // (`WebFetch(domain:*)` opens the sandbox's proxy to every host) and reads nothing outside the task folder but the
    // programs its launchers point at. The control files, which hold Scarlet's token, are closed to every tool.
    // Insisting on the sandbox (`failIfUnavailable`) failed every run on a machine where it can't start, so where it
    // can't, the run goes on without it.
    let mut settings = json!({ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false } });
    if let Some(ws) = workspace {
        let control = tmp_dir.to_string_lossy().replace('\\', "/");
        settings["sandbox"]["autoAllowBashIfSandboxed"] = json!(true);
        // A shell's `curl` was refused every host until the sandbox's own list named them all (2026-11-21).
        settings["sandbox"]["network"] = json!({ "allowedDomains": ["*"] });
        settings["sandbox"]["filesystem"] = json!({ "denyRead": [tmp_dir.to_string_lossy()] });
        if !ws.read_dirs.is_empty() {
            settings["sandbox"]["filesystem"]["allowRead"] = json!(ws.read_dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect::<Vec<_>>());
        }
        let rule = format!("//{}/**", control.trim_start_matches('/'));
        settings["permissions"] = json!({ "blockReadsOutsideWorkingDirectories": true, "allow": ["WebFetch(domain:*)"], "deny": [format!("Read({rule})"), format!("Edit({rule})")] });
    }
    if let Some(tier) = service_tier { settings["fastMode"] = json!(tier == "fast"); }
    args.extend(["--settings".into(), settings.to_string()]);
    let mut files = BTreeMap::new();
    files.insert(mcp_config_path, mcp_config_json(mcp));
    files.insert(system_path, system_prompt.to_string());
    RunnerCommand { file: bin.to_string(), args, stdin: Some(instruction.to_string()), files }
}
