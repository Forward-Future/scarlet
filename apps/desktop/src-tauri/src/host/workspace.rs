//! The programs a request's shell is given (workspaceTools.ts in apps/agent): ffmpeg and ffprobe,
//! as launchers in the task folder put first on its PATH.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::types::Workspace;

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
