//! The command lines Codex runs with: `codex exec` and `codex app-server`, and the configuration both share.

use std::collections::BTreeMap;
use std::path::Path;

use crate::host::runner::{RunOptions, RunnerCommand};
use crate::host::types::{McpSpec, Workspace};

/// TOML basic string.
pub(super) fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t"))
}

pub(super) struct CodexCommand {
    pub(super) cmd: RunnerCommand,
    pub(super) last_message_path: std::path::PathBuf,
}

// Seatbelt re-executes Codex to load AGENTS.md. Launch the real file and
// grant only that file, since a Homebrew symlink is not covered by the grant.
pub(super) fn codex_executable(bin: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    return std::fs::canonicalize(bin).ok().map(|path| path.to_string_lossy().into_owned());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bin;
        None
    }
}

/// Codex features a side check runs without. A request's agent keeps its shell and its look at pictures it made.
const CODEX_OFF: [&str; 5] = ["computer_use", "multi_agent", "plugins", "apps", "hooks"];

fn codex_tool_args(mcp: &McpSpec, executable: Option<&str>, workspace: Option<&Workspace>) -> Vec<String> {
    // Forward slashes keep the TOML readable and work for node on Windows.
    let to_toml = |p: &str| p.replace('\\', "/");
    // The programs the shell's launchers point at: readable, never writable. Everything else outside the task folder stays closed.
    let reads: String = executable.map(str::to_string).into_iter()
        .chain(workspace.iter().flat_map(|w| w.read_dirs.iter().map(|d| d.to_string_lossy().into_owned())))
        .map(|path| format!(",{}=\"read\"", toml_string(&to_toml(&path)))).collect();
    let mut args = Vec::new();
    // The legacy Windows sandboxes cannot enforce this profile's denied root reads.
    #[cfg(windows)]
    args.extend(["-c".into(), r#"windows.sandbox="mxc""#.into()]);
    let off: Vec<&str> = if workspace.is_some() { CODEX_OFF.to_vec() } else { ["shell_tool", "view_image"].into_iter().chain(CODEX_OFF).collect() };
    for feature in off {
        args.extend(["--disable".into(), feature.into()]);
    }
    args.extend([
        "-c".into(), r#"approval_policy="never""#.into(),
        // Codex's own usage metrics to OpenAI stay off. Its private home drops the editor's own config.toml, so an
        // opt-out there wouldn't reach it otherwise.
        "-c".into(), "analytics.enabled=false".into(),
        // A request's agent searches the live web; a side check has none.
        "-c".into(), format!("web_search={}", if workspace.is_some() { r#""live""# } else { r#""disabled""# }),
        // Long edit prompts include the timeline, editor's notes and earlier answers.
        "-c".into(), "project_doc_max_bytes=4194304".into(),
        "-c".into(), r#"default_permissions="scarlet""#.into(),
        "-c".into(), format!(r#"permissions.scarlet.filesystem={{":root"="deny",":minimal"="read",":workspace_roots"={{"."="write"}}{reads}}}"#),
        // A request's shell reaches the web, for the pages and clips it brings in. Scarlet's token stays out of the shell
        // (`shell_environment_policy` below), so the engine is no nearer than before.
        "-c".into(), format!("permissions.scarlet.network.enabled={}", workspace.is_some()),
        "-c".into(), r#"mcp_servers.scarlet.default_tools_approval_mode="approve""#.into(),
        "-c".into(), "mcp_servers.scarlet.required=true".into(),
        "-c".into(), "mcp_servers.scarlet.startup_timeout_sec=60".into(),
        // Scarlet's tools wait up to `toolWaitSeconds` (capabilities.ts) for evidence still being measured.
        "-c".into(), "mcp_servers.scarlet.tool_timeout_sec=300".into(),
        "-c".into(),
        format!("mcp_servers.scarlet.command={}", toml_string(&to_toml(&mcp.command))),
        "-c".into(),
        format!("mcp_servers.scarlet.args=[{}]", mcp.args.iter().map(|a| toml_string(&to_toml(a))).collect::<Vec<_>>().join(",")),
        "-c".into(),
        format!("mcp_servers.scarlet.env_vars=[{}]", mcp.env.keys().map(|k| toml_string(k)).collect::<Vec<_>>().join(",")),
        "-c".into(),
        r#"shell_environment_policy.exclude=["SCARLET_*"]"#.into(),
    ]);
    args
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_codex_command(model: Option<&str>, effort: Option<&str>, service_tier: Option<&str>, system_prompt: &str, instruction: &str, plan: bool, workspace: Option<&Workspace>, mcp: &McpSpec, cwd: &Path, bin: &str, tmp_dir: &Path) -> CodexCommand {
    let last_message_path = tmp_dir.join("last-message.md");
    let mut args: Vec<String> = vec![
        "exec".into(),
        "--json".into(),
        "--skip-git-repo-check".into(),
        "--cd".into(),
        cwd.to_string_lossy().to_string(),
        "--strict-config".into(),
        "--ignore-user-config".into(),
        "--ignore-rules".into(),
        "--ephemeral".into(),
        // As App Server: the task folder is the project's root, so Codex reads no AGENTS.md or project config from a
        // folder above it.
        "-c".into(),
        "project_root_markers=[]".into(),
    ];
    let executable = codex_executable(bin);
    args.extend(codex_tool_args(mcp, executable.as_deref(), workspace));
    args.extend([
        "--output-last-message".into(),
        last_message_path.to_string_lossy().to_string(),
    ]);
    // Codex's own to-do tool, which it reports as `todo_list` items. A Codex without this key refuses it under --strict-config.
    if plan {
        args.extend(["-c".into(), "tools.update_plan.enabled=true".into()]);
    }
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(e) = effort {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort={}", toml_string(e)));
    }
    if let Some(tier) = service_tier {
        args.push("-c".into());
        args.push(format!("service_tier={}", toml_string(tier)));
    }
    args.push("-".to_string());
    let mut files = BTreeMap::new();
    files.insert(cwd.join("AGENTS.md"), system_prompt.to_string());
    CodexCommand { cmd: RunnerCommand { file: executable.unwrap_or_else(|| bin.into()), args, stdin: Some(instruction.to_string()), files }, last_message_path }
}

pub(super) fn app_server_args(opts: &RunOptions, executable: Option<&str>) -> Vec<String> {
    let mut args = vec!["app-server".into(), "--strict-config".into()];
    args.extend(codex_tool_args(&opts.mcp, executable, opts.workspace.as_ref()));
    args.extend([
        "--disable".into(), "goals".into(),
        "-c".into(), "project_root_markers=[]".into(),
        "-c".into(), r#"cli_auth_credentials_store="file""#.into(),
        "-c".into(), "tools.experimental_request_user_input.enabled=false".into(),
        "-c".into(), format!("tools.update_plan.enabled={}", opts.plan),
    ]);
    if let Some(effort) = &opts.effort {
        args.extend(["-c".into(), format!("model_reasoning_effort={}", toml_string(effort))]);
    }
    args
}
