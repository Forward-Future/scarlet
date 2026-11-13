//! Installs the editor's licensed local checkpoint using Scarlet's own setup files.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::State;
use tokio::process::Command;

use crate::{config::Paths, util, AppState};

const NEED_PYTHON: &str = "Install 64-bit CPython 3.12, then choose the model folder again.";

fn installer(resources: Option<&Path>) -> Result<PathBuf, String> {
    // A dev build can run from a custom Cargo target without a Tauri resource directory.
    #[cfg(debug_assertions)]
    {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../integrations/transcription/crisperwhisper/install.py");
        if source.is_file() {
            return Ok(source);
        }
    }
    resources.map(|dir| dir.join("crisperwhisper-setup/install.py")).filter(|path| path.is_file())
        .ok_or_else(|| "Scarlet’s CrisperWhisper setup files are missing. Reinstall Scarlet and try again.".into())
}

fn setup_command(paths: &Paths, directory: &Path) -> Result<Command, String> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("Choose the folder that contains the local CrisperWhisper checkpoint.".into());
    }
    let script = installer(paths.resource_dir.as_deref())?;
    let script_dir = script.parent().expect("installer path includes a directory");
    let inherited = util::env_map();
    let path = util::augmented_path(&inherited, &paths.home);
    // Resolve executables independently of the chosen model directory. Dock launches
    // have a sparse PATH, and python.org's framework and Homebrew's keg may be unlinked.
    let name = if cfg!(windows) { "py.exe" } else { "python3.12" };
    let program = which::which_in(name, Some(&path), script_dir).ok();
    #[cfg(target_os = "macos")]
    let program = program.or_else(|| [
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
        "/opt/homebrew/opt/python@3.12/bin/python3.12",
        "/usr/local/opt/python@3.12/bin/python3.12",
    ].into_iter().map(PathBuf::from).find(|path| path.is_file()));
    #[cfg(windows)]
    let program = program.or_else(|| util::env_get(&inherited, "LOCALAPPDATA").and_then(|dir| {
        let base = Path::new(dir);
        [base.join("Programs/Python/Launcher/py.exe"), base.join("Microsoft/WindowsApps/py.exe")]
            .into_iter().find(|path| path.is_file())
    }));
    let mut cmd = Command::new(program.ok_or(NEED_PYTHON)?);
    if cfg!(windows) {
        cmd.arg("-3.12");
    }
    cmd.current_dir(script_dir).args(["-I", "-B"]).arg(&script)
        .arg("--model").arg(directory).arg("--data-dir").arg(&paths.data_dir);
    // Keep proxies and certificate configuration for the public dependency indexes.
    // Claude/engine/API credentials and user Python startup settings stay in Scarlet.
    let cache = paths.data_dir.join("models/crisperwhisper/cache");
    cmd.env_clear().envs(inherited.into_iter().filter(|(k, _)| matches!(k.to_ascii_uppercase().as_str(),
        "HOME" | "USERPROFILE" | "SYSTEMROOT" | "WINDIR" | "COMSPEC" | "PATHEXT"
        | "TEMP" | "TMP" | "TMPDIR" | "APPDATA" | "LOCALAPPDATA" | "HTTP_PROXY" | "HTTPS_PROXY"
        | "NO_PROXY" | "REQUESTS_CA_BUNDLE" | "SSL_CERT_FILE" | "LANG" | "LC_ALL"
    ))).env("PATH", path).env("PIP_NO_INPUT", "1").env("PIP_CACHE_DIR", cache.join("pip"))
        .env("HF_HUB_OFFLINE", "1").env("HF_HUB_DISABLE_TELEMETRY", "1").env("HF_HOME", cache.join("hf"))
        .env("PIP_CONFIG_FILE", if cfg!(windows) { "NUL" } else { "/dev/null" });
    if cfg!(windows) {
        cmd.env("PYTHON_MANAGER_AUTOMATIC_INSTALL", "false");
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null());
    util::hide_console(&mut cmd);
    Ok(cmd)
}

#[tauri::command]
pub async fn install_crisper_model(state: State<'_, AppState>, directory: PathBuf) -> Result<(), String> {
    let mut cmd = setup_command(&state.paths, &directory)?;
    let output = cmd.output().await.map_err(|e| format!("Could not start CrisperWhisper setup. {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let reason = util::stderr_tail_line(&stderr).unwrap_or_else(|| output.status.to_string());
    if cfg!(windows) && (matches!(output.status.code(), Some(101 | 103 | 106 | 107))
        || stderr.contains("No suitable Python runtime") || stderr.contains("No runtime installed")) {
        return Err(format!("{reason}. {NEED_PYTHON}"));
    }
    Err(reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> Paths {
        Paths {
            data_dir: root.join("Scarlet data"),
            log_dir: root.join("logs"),
            work_dir: root.join("work"),
            config_file: root.join("settings.json"),
            resource_dir: Some(root.join("Resources")),
            home: root.join("home"),
        }
    }

    #[test]
    fn requires_an_existing_absolute_snapshot_folder() {
        let temp = tempfile::tempdir().unwrap();
        let paths = fixture(temp.path());
        for invalid in [Path::new("."), &temp.path().join("missing")] {
            assert!(setup_command(&paths, invalid).unwrap_err().contains("Choose the folder"));
        }
    }

    #[test]
    fn only_the_snapshot_argument_comes_from_the_file_picker() {
        let temp = tempfile::tempdir().unwrap();
        let paths = fixture(temp.path());
        let snapshot = temp.path().join("Model & config");
        std::fs::create_dir(&snapshot).unwrap();
        std::fs::write(snapshot.join("install.py"), "not the bundled installer").unwrap();
        let bin = paths.home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let executable = bin.join(if cfg!(windows) { "py.exe" } else { "python3.12" });
        std::fs::write(&executable, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let resources = paths.resource_dir.as_ref().unwrap().join("crisperwhisper-setup");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(resources.join("install.py"), "").unwrap();
        let cmd = setup_command(&paths, &snapshot).unwrap();
        let args: Vec<_> = cmd.as_std().get_args().collect();
        let script = installer(paths.resource_dir.as_deref()).unwrap();
        assert_ne!(script, snapshot.join("install.py"));
        assert!(args.ends_with(&[
            "-I".as_ref(), "-B".as_ref(), script.as_os_str(), "--model".as_ref(),
            snapshot.as_os_str(), "--data-dir".as_ref(), paths.data_dir.as_os_str(),
        ]));
    }
}
