//! The command a CLI is started with: through cmd.exe for a Windows batch shim, or, for a run, straight at the
//! program or script the shim would launch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::find_on_path;
use crate::util::{env_get, hide_console};

/// True for Windows batch shims that must be run through cmd.exe.
pub fn needs_cmd_shell(file: &str) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let lower = file.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// Quote one argument for a cmd.exe command string.
pub fn quote_for_cmd(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".into();
    }
    if !arg.chars().any(|c| c.is_whitespace() || "\"&|<>^()%!".contains(c)) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\"\""))
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpawnSpec {
    pub file: String,
    pub args: Vec<String>,
    /// The last argument is a pre-quoted cmd.exe command line (`raw_arg`).
    pub verbatim: bool,
}

/// Build the spawn file/args for an executable, wrapping .cmd/.bat shims in cmd.exe.
pub fn spawn_spec(file: &str, args: &[String], env: &HashMap<String, String>) -> SpawnSpec {
    if needs_cmd_shell(file) {
        let mut all = vec![file.to_string()];
        all.extend(args.iter().cloned());
        let line = all.iter().map(|a| quote_for_cmd(a)).collect::<Vec<_>>().join(" ");
        SpawnSpec {
            file: env_get(env, "ComSpec").unwrap_or("cmd.exe").to_string(),
            args: vec!["/d".into(), "/s".into(), "/c".into(), format!("\"{line}\"")],
            verbatim: true,
        }
    } else {
        SpawnSpec { file: file.to_string(), args: args.to_vec(), verbatim: false }
    }
}

pub fn build_command(spec: &SpawnSpec, cwd: Option<&Path>, env: &HashMap<String, String>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(&spec.file);
    if spec.verbatim {
        let (head, last) = spec.args.split_at(spec.args.len() - 1);
        cmd.args(head);
        #[cfg(windows)]
        {
            cmd.raw_arg(&last[0]);
        }
        #[cfg(not(windows))]
        {
            cmd.arg(&last[0]);
        }
    } else {
        cmd.args(&spec.args);
    }
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.env_clear();
    cmd.envs(env);
    hide_console(&mut cmd);
    // Own process group, so stopping a run also stops what the CLI started.
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

/// Task arguments must go directly to an executable, never through the batch interpreter.
pub(super) fn runner_spec(file: &str, args: &[String], env: &HashMap<String, String>) -> Result<SpawnSpec> {
    if !needs_cmd_shell(file) {
        return Ok(spawn_spec(file, args, env));
    }
    let shim = Path::new(file);
    let name = shim.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    let package = match name.as_str() {
        "claude" => "@anthropic-ai/claude-code",
        "codex" => "@openai/codex",
        "gemini" => "@google/gemini-cli",
        // Not an agent: installing one runs npm itself, with a command line Scarlet wrote.
        "npm" => "npm",
        _ => anyhow::bail!("use a native or npm agent CLI instead of a batch launcher"),
    };
    let target = npm_entry(shim, &name, package)?;
    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    let target = target.to_string_lossy().into_owned();
    let mut arguments = args.to_vec();
    let program = match ext.as_str() {
        "exe" => target,
        "js" | "cjs" | "mjs" => {
            arguments.insert(0, target);
            find_on_path("node.exe", env).context("Node is required for this npm agent CLI")?
        }
        _ => anyhow::bail!("unsupported npm agent executable"),
    };
    Ok(SpawnSpec { file: program, args: arguments, verbatim: false })
}

/// The script or program a Windows package-manager shim for `package` runs, from the package's own manifest.
pub(super) fn npm_entry(shim: &Path, name: &str, package: &str) -> Result<PathBuf> {
    let root = package_root(shim, package).with_context(|| format!("{} runs no copy of {package} Scarlet can find; use a native or npm agent CLI instead of a batch launcher", shim.display()))?;
    let manifest = root.join("package.json");
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).with_context(|| format!("read {}", manifest.display()))?)?;
    let bin = &manifest["bin"];
    let entry = bin.as_str().or_else(|| bin[name].as_str()).context("missing npm CLI entry point")?;
    Ok(root.join(entry))
}

/// The folder `package` is installed in, for the shim that launches it. npm keeps it beside its shim, in
/// `node_modules`. pnpm keeps global packages under its home (`global\5\node_modules`) and Yarn under `Data\global`,
/// and their shims name the path, so the shim is read for it. Only a folder holding the package's manifest is taken.
fn package_root(shim: &Path, package: &str) -> Option<PathBuf> {
    let dir = shim.parent()?;
    let is_package = |root: &Path| root.join("package.json").is_file();
    let beside = dir.join("node_modules").join(package);
    if is_package(&beside) {
        return Some(beside);
    }
    let text = std::fs::read(shim).ok()?;
    let text = String::from_utf8_lossy(&text);
    // Each quoted path in the shim, relative to the shim's folder (`%~dp0`, or npm's `%dp0%`) or in full. Some name
    // the script, Yarn's names another shim in the `.bin` beside the package; either way a `node_modules` folder
    // above it holds the package.
    let quoted = text.lines().flat_map(|line| line.split('"').skip(1).step_by(2));
    for quoted in quoted {
        let windows = quoted.replace('\\', std::path::MAIN_SEPARATOR_STR);
        let path = match windows.strip_prefix("%~dp0").or_else(|| windows.strip_prefix("%dp0%")) {
            Some(rest) => dir.join(rest.trim_start_matches(['\\', '/'])),
            None if Path::new(&windows).is_absolute() => PathBuf::from(&windows),
            None => continue,
        };
        if path.to_string_lossy().contains('%') {
            continue;
        }
        let path = lexical(&path);
        let found = path.ancestors()
            .filter(|folder| folder.file_name().is_some_and(|n| n.eq_ignore_ascii_case("node_modules")))
            .map(|modules| modules.join(package))
            .find(|root| is_package(root));
        if found.is_some() {
            return found;
        }
    }
    None
}

/// The path with each `..` taken off the folder before it, as Windows reads a path in a shim.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            part => out.push(part),
        }
    }
    out
}
