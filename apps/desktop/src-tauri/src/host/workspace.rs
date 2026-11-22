//! Per-task workspace cleanup, token-file removal, Claude Code session cleanup,
//! and aged task directory pruning.
//! The programs a request's shell is given (workspaceTools.ts in apps/agent): ffmpeg and ffprobe,
//! as launchers in the task folder put first on its PATH.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use super::types::Workspace;

/// The folder under the work folder that holds one folder for each run.
pub(super) const TASKS_DIR: &str = "tasks-v2";

/// Finished task folders keep their artifacts this long.
const TASK_DIR_DAYS: u64 = 14;

/// Remove the control file in a run's folder that holds the engine token, if the run left one: Claude Code's MCP
/// config. Codex and agy take the token in their environment and session instead.
pub fn remove_token_file(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(dir.join(".scarlet").join("mcp.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// A finished task keeps only its artifacts. The CLI control files include the engine token.
pub fn remove_control_files(dir: &Path) -> std::io::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    let mut artifacts = false;
    for entry in entries.flatten() {
        if entry.file_name() == "artifacts" {
            artifacts = true;
        } else if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    if !artifacts {
        std::fs::remove_dir(dir)?;
    }
    Ok(())
}

/// Where Claude Code keeps its sessions and their to-do lists: CLAUDE_CONFIG_DIR when it is set, else ~/.claude.
/// A relative CLAUDE_CONFIG_DIR is read from each CLI's own folder, which Scarlet can't speak for, so it is left alone.
pub fn claude_config_dir(env: &HashMap<String, String>, home: &Path) -> Option<PathBuf> {
    match crate::util::env_get(env, "CLAUDE_CONFIG_DIR") {
        None => Some(home.join(".claude")),
        Some(dir) => Some(PathBuf::from(dir)).filter(|dir| dir.is_absolute()),
    }
}

/// Claude Code keeps a cwd's sessions in <its folder>/projects/<real cwd with every character other than a letter or
/// digit as "-">. A name over 200 characters keeps its first 200 and ends in a hash of the path Scarlet can't
/// reproduce, so that folder is found by its first 200 characters and by its sessions, which name the cwd.
pub fn claude_project_dir(real_cwd: &Path, claude_dir: &Path) -> Option<PathBuf> {
    let name: String = real_cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    if !name.chars().any(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let projects = claude_dir.join("projects");
    if name.len() <= 200 {
        return Some(projects.join(name));
    }
    let prefix = format!("{}-", &name[..200]);
    // Another folder that long can share those 200 characters: only the one whose sessions name this cwd is its.
    std::fs::read_dir(&projects).ok()?.flatten().map(|entry| entry.path()).find(|dir| {
        let hashed = dir.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix(&prefix))
            .is_some_and(|hash| !hash.is_empty() && hash.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        hashed && sessions_name_cwd(dir, real_cwd)
    })
}

/// Whether a Claude project folder's sessions were held in `real_cwd`: each session's messages carry their `cwd`,
/// within its first lines.
fn sessions_name_cwd(dir: &Path, real_cwd: &Path) -> bool {
    use std::io::BufRead;
    let cwd = real_cwd.to_string_lossy();
    std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter(|entry| entry.path().extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|entry| std::fs::File::open(entry.path()).ok())
        .any(|file| {
            std::io::BufReader::new(file).lines().take(20).map_while(Result::ok)
                .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
                .find_map(|message| message.get("cwd").and_then(Value::as_str).map(|said| said == cwd))
                .unwrap_or(false)
        })
}

/// Delete the Claude sessions of one finished Scarlet task: only the project folder named after its task folder,
/// and the to-do list of each session in it. `claude_dir` is where Claude Code keeps them (`claude_config_dir`).
pub fn remove_claude_sessions(real_cwd: &Path, claude_dir: &Path) -> std::io::Result<()> {
    if !real_cwd.parent().and_then(Path::file_name).is_some_and(|n| n == TASKS_DIR) {
        return Ok(());
    }
    let Some(dir) = claude_project_dir(real_cwd, claude_dir) else { return Ok(()) };
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {
            // Claude Code keeps a session's to-do list apart from it, in <its folder>/tasks/<session id>, and a session
            // is `<session id>.jsonl` here. Only a name of hex digits and dashes is read as an id: "...jsonl" would
            // name its folder itself. A list that can't be removed is left.
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let name = entry.file_name();
                let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".jsonl")) else { continue };
                if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                    continue;
                }
                let list = claude_dir.join("tasks").join(id);
                if std::fs::symlink_metadata(&list).is_ok_and(|m| m.is_dir()) {
                    let _ = std::fs::remove_dir_all(&list);
                }
            }
            std::fs::remove_dir_all(&dir)
        }
        _ => Ok(()),
    }
}

/// The path Claude Code sees as its cwd. Windows canonical paths carry a `\\?\` prefix Claude never shows.
pub(super) fn real_path(dir: &Path) -> Option<PathBuf> {
    if cfg!(windows) { Some(dir.to_path_buf()) } else { std::fs::canonicalize(dir).ok() }
}

/// Last use of a task folder: the folder, its artifacts folder or a file directly in it.
fn last_used(dir: &Path) -> Option<std::time::SystemTime> {
    let meta = std::fs::metadata(dir).ok().filter(|m| m.is_dir())?;
    let artifacts = dir.join("artifacts");
    let files = std::fs::read_dir(&artifacts).into_iter().flatten().flatten().map(|e| e.path());
    std::iter::once(artifacts.clone()).chain(files).filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok()).chain(meta.modified().ok()).max()
}

/// Remove task folders unused for `TASK_DIR_DAYS`, including artifacts, and the Claude sessions they left in
/// `claude_dir` (`claude_config_dir`).
pub fn prune_task_dirs(tasks_root: &Path, now: std::time::SystemTime, claude_dir: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(tasks_root) else { return };
    let max_age = Duration::from_secs(TASK_DIR_DAYS * 86_400);
    for entry in entries.flatten() {
        let old = last_used(&entry.path()).and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > max_age);
        if old {
            // A run that never finished left its Claude sessions behind. They go with its folder.
            if let (Some(claude_dir), Some(real)) = (claude_dir, real_path(&entry.path())) {
                if let Err(e) = remove_claude_sessions(&real, claude_dir) {
                    log::warn!("could not remove Claude sessions of {}: {e}", entry.path().display());
                }
            }
            if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                log::warn!("could not prune task folder {}: {e}", entry.path().display());
            }
        }
    }
}

/// Where a request's shell finds its programs, in the task folder.
pub const TOOLS_DIR: &str = ".tools";

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

fn runnable(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0)
}

fn env_path(env: &HashMap<String, String>, key: &str) -> Option<PathBuf> {
    env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| PathBuf::from(v.trim())).filter(|p| p.is_absolute() && runnable(p))
}

fn on_path(env: &HashMap<String, String>, name: &str) -> Option<PathBuf> {
    let path = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH"))?.1;
    std::env::split_paths(path).map(|dir| dir.join(exe(name))).find(|p| runnable(p))
}

/// A launcher for one program, by its full path.
pub fn launcher(target: &str) -> String {
    format!("#!/bin/sh\nexec '{}' \"$@\"\n", target.replace('\'', r"'\''"))
}

/// The folder a program needs to read to run: its whole app bundle on a Mac, else the folder it sits in.
pub fn program_folder(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.find(".app/") {
        Some(at) => PathBuf::from(&text[..at + 4]),
        None => path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf()),
    }
}

/// Where the desktop app's own media tools are: its resources' `bin`, else beside its executable.
fn bundled_tool(resources: Option<&Path>, name: &str) -> Option<PathBuf> {
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(exe(name))));
    resources.map(|r| r.join("bin").join(exe(name))).into_iter().chain(beside).find(|p| runnable(p))
}

/// The programs a request's shell is given, as launchers in the task folder: the app's own ffmpeg and ffprobe (else
/// FFMPEG_PATH and FFPROBE_PATH, else the PATH's). Pages are drawn and captured in Scarlet's own Chrome (`graphic_render`,
/// `web_capture`): in every harness's sandbox Chrome either crashed at start or couldn't reach the web (2026-11-21).
/// What the host lacks is left out; the shell keeps its PATH as it was.
pub fn workspace_tools(cwd: &Path, resources: Option<&Path>, env: &HashMap<String, String>) -> std::io::Result<Workspace> {
    let programs: Vec<(&str, PathBuf)> = [
        ("ffmpeg", bundled_tool(resources, "ffmpeg").or_else(|| env_path(env, "FFMPEG_PATH")).or_else(|| on_path(env, "ffmpeg"))),
        ("ffprobe", bundled_tool(resources, "ffprobe").or_else(|| env_path(env, "FFPROBE_PATH")).or_else(|| on_path(env, "ffprobe"))),
    ].into_iter().filter_map(|(name, path)| path.map(|p| (name, p))).collect();
    if programs.is_empty() {
        return Ok(Workspace { bin_dir: None, read_dirs: certificate_folders(env) });
    }
    let bin_dir = cwd.join(TOOLS_DIR);
    std::fs::create_dir_all(&bin_dir)?;
    for (name, target) in &programs {
        let target = target.to_string_lossy();
        if cfg!(windows) {
            std::fs::write(bin_dir.join(format!("{name}.cmd")), format!("@\"{target}\" %*\r\n"))?;
        } else {
            let file = bin_dir.join(name);
            std::fs::write(&file, launcher(&target))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))?;
            }
        }
    }
    let mut read_dirs: Vec<PathBuf> = Vec::new();
    for (_, target) in &programs {
        let folder = program_folder(target);
        if !read_dirs.contains(&folder) {
            read_dirs.push(folder);
        }
    }
    for folder in certificate_folders(env) {
        if !read_dirs.contains(&folder) {
            read_dirs.push(folder);
        }
    }
    Ok(Workspace { bin_dir: Some(bin_dir), read_dirs })
}

/// Where the certificates the machine's own settings point TLS at are kept (`SSL_CERT_FILE`, `CURL_CA_BUNDLE` and the
/// like), so a shell that reads only its folder can still check a site's certificate: on one machine `curl` pointed at
/// a Python package's bundle, and failed every https address in Codex's sandbox (2026-11-21).
fn certificate_folders(env: &HashMap<String, String>) -> Vec<PathBuf> {
    ["SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"].iter()
        .filter_map(|key| env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| PathBuf::from(v.trim())))
        .filter(|p| p.is_absolute())
        .filter_map(|p| p.metadata().ok().map(|m| if m.is_dir() { p.clone() } else { p.parent().map(Path::to_path_buf).unwrap_or(p.clone()) }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_mac_app_whole_and_any_other_program_by_its_folder() {
        assert_eq!(program_folder(Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")), PathBuf::from("/Applications/Google Chrome.app"));
        assert_eq!(program_folder(Path::new("/opt/ff/bin/ffmpeg")), PathBuf::from("/opt/ff/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn writes_a_launcher_for_each_program_it_finds_and_none_for_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("it's bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("ffmpeg"), "#!/bin/sh\n").unwrap();
        let env = HashMap::from([("PATH".to_string(), bin.to_string_lossy().into_owned())]);
        let cwd = dir.path().join("task");
        let ws = workspace_tools(&cwd, Some(&dir.path().join("no-resources")), &env).unwrap();
        let tools = cwd.join(TOOLS_DIR);
        assert_eq!(ws.bin_dir.as_deref(), Some(tools.as_path()));
        assert_eq!(std::fs::read_to_string(tools.join("ffmpeg")).unwrap(), launcher(&bin.join("ffmpeg").to_string_lossy()));
        assert!(launcher("/a/it's/ffmpeg").contains(r"exec '/a/it'\''s/ffmpeg' "));
        assert!(!tools.join("ffprobe").exists());
        assert_eq!(ws.read_dirs, vec![bin]);
    }
}
