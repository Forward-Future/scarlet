//! Installs the editor's licensed local checkpoint using Scarlet's own setup files.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tauri::State;
use tokio::process::Command;

use crate::{config::Paths, util, AppState};

const NEED_PYTHON: &str = "Install 64-bit CPython 3.12, then choose the model folder again.";

fn setup_file(resources: Option<&Path>, name: &str, development: bool) -> Option<PathBuf> {
    if development {
        // A dev build can run from a custom Cargo target without a Tauri resource directory.
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../integrations/transcription/crisperwhisper").join(name);
        if source.is_file() {
            return Some(source);
        }
    }
    resources.map(|dir| dir.join("crisperwhisper-setup").join(name)).filter(|path| path.is_file())
}

/// Existing libraries keep their verified weights and venv. The desktop release supplies the adapter to new workers.
pub fn set_adapter_env(env: &mut std::collections::HashMap<String, String>, resources: Option<&Path>, development: bool) {
    const KEY: &str = "SCARLET_CRISPER_ADAPTER";
    env.retain(|key, _| !key.eq_ignore_ascii_case(KEY));
    if let Some(adapter) = setup_file(resources, "crisper_cli.py", development) {
        env.insert(KEY.into(), adapter.to_string_lossy().into_owned());
    }
}

fn setup_command(paths: &Paths, directory: &Path) -> Result<Command, String> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("Choose the folder that contains the local CrisperWhisper checkpoint.".into());
    }
    let script = setup_file(paths.resource_dir.as_deref(), "install.py", tauri::is_dev())
        .ok_or("Scarlet’s CrisperWhisper setup files are missing. Reinstall Scarlet and try again.")?;
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

/// How long a setup may run. pip downloads PyTorch with its CUDA libraries, a few gigabytes on Windows, which takes
/// over half an hour on a slow connection, and then installs them. A setup still going after this has hung, on a
/// package index that stopped answering, say.
const SETUP_LIMIT: Duration = Duration::from_secs(45 * 60);

/// The setups under way, by process id, so that quitting Scarlet stops them.
pub struct Setups(Mutex<Vec<u32>>);

static SETUPS: Setups = Setups::new();

impl Setups {
    pub const fn new() -> Self {
        Setups(Mutex::new(Vec::new()))
    }

    #[cfg(test)]
    fn running(&self) -> Vec<u32> {
        self.0.lock().unwrap().clone()
    }

    /// Stop every setup under way, with the pip and Python processes it started.
    fn stop_now(&self) {
        for pid in std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner())) {
            log::info!("stopping CrisperWhisper setup (pid {pid})");
            crate::host::spawn::kill_group_now(pid);
        }
    }
}

/// A setup's place in `Setups` while it runs.
struct Tracked(&'static Setups, Option<u32>);

impl Drop for Tracked {
    fn drop(&mut self) {
        if let Some(pid) = self.1 {
            self.0 .0.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| *p != pid);
        }
    }
}

/// At exit: stop any CrisperWhisper setup under way. Left running, it would install on with no Scarlet to report to.
pub fn stop_setups_now() {
    SETUPS.stop_now();
}

/// Run a setup to its end, or stop it with everything it started once it has run for `limit`.
async fn run_setup(mut cmd: Command, limit: Duration, setups: &'static Setups) -> Result<std::process::Output, String> {
    cmd.stderr(Stdio::piped()).kill_on_drop(true);
    // Its own process group, so a stop also reaches the pip and Python it starts.
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd.spawn().map_err(|e| format!("Could not start CrisperWhisper setup. {e}"))?;
    let pid = child.id();
    if let Some(pid) = pid {
        setups.0.lock().unwrap_or_else(|e| e.into_inner()).push(pid);
    }
    let _tracked = Tracked(setups, pid);
    // The child is held here, past the limit: dropped with the timeout, it would be killed alone, and on Windows
    // `taskkill /T` then finds no tree under it to stop.
    let output = child.wait_with_output();
    tokio::pin!(output);
    match tokio::time::timeout(limit, &mut output).await {
        Ok(result) => result.map_err(|e| format!("CrisperWhisper setup could not be waited for. {e}")),
        Err(_) => {
            log::warn!("CrisperWhisper setup was still running after {} and was stopped", util::human_duration(limit));
            if let Some(pid) = pid {
                util::kill_tree(pid).await;
            }
            let _ = tokio::time::timeout(Duration::from_secs(10), &mut output).await;
            Err(format!("CrisperWhisper setup was still running after {} and was stopped. Check the internet connection, then choose the model folder again.", util::human_duration(limit)))
        }
    }
}

#[tauri::command]
pub async fn install_crisper_model(state: State<'_, AppState>, directory: PathBuf) -> Result<(), String> {
    let cmd = setup_command(&state.paths, &directory)?;
    let output = run_setup(cmd, SETUP_LIMIT, &SETUPS).await?;
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
    fn packaged_workers_use_the_adapter_supplied_by_the_app_update() {
        let temp = tempfile::tempdir().unwrap();
        let resources = temp.path().join("Release resources");
        let installed = resources.join("crisperwhisper-setup/crisper_cli.py");
        let mut env = std::collections::HashMap::from([
            ("scarlet_crisper_adapter".into(), "inherited.py".into()),
            ("SCARLET_CRISPER_ADAPTER".into(), "old.py".into()),
        ]);
        set_adapter_env(&mut env, Some(&resources), false);
        assert!(env.is_empty());
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::write(&installed, "release adapter").unwrap();
        set_adapter_env(&mut env, Some(&resources), false);
        assert_eq!(Path::new(&env["SCARLET_CRISPER_ADAPTER"]), installed);
    }

    #[cfg(unix)]
    fn alive(pid: &str) -> bool {
        std::process::Command::new("kill").args(["-0", pid]).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_setup_that_runs_past_its_limit_is_stopped_with_what_it_started() {
        static SETUPS: Setups = Setups::new();
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        // The installer and the pip it starts note their process ids, and both hang.
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(format!("echo $$ >> '{0}'; sh -c 'echo $$ >> \"{0}\"; sleep 60' & wait", pids.display()));
        cmd.stdin(Stdio::null()).stdout(Stdio::null());
        let started = std::time::Instant::now();
        let error = run_setup(cmd, Duration::from_secs(3), &SETUPS).await.unwrap_err();
        assert!(error.contains("still running after 3s"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(20), "gave up after {:?}", started.elapsed());
        assert!(SETUPS.running().is_empty());
        let noted: Vec<String> = std::fs::read_to_string(&pids).unwrap().lines().map(String::from).collect();
        assert_eq!(noted.len(), 2, "{noted:?}");
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while noted.iter().any(|pid| alive(pid)) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(noted.iter().all(|pid| !alive(pid)), "still running: {noted:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn quitting_stops_a_setup_under_way() {
        static SETUPS: Setups = Setups::new();
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(format!("sh -c 'echo $$ >> \"{0}\"; sleep 60' & wait", pids.display()));
        cmd.stdin(Stdio::null()).stdout(Stdio::null());
        let setup = tokio::spawn(run_setup(cmd, Duration::from_secs(3600), &SETUPS));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !pids.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(SETUPS.running().len(), 1);
        // Scarlet quits: the setup and the pip it started stop at once.
        SETUPS.stop_now();
        let output = tokio::time::timeout(Duration::from_secs(10), setup).await.expect("the setup kept running").unwrap().unwrap();
        assert!(!output.status.success());
        let pip = std::fs::read_to_string(&pids).unwrap().trim().to_string();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while alive(&pip) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!alive(&pip), "pip outlived the quit");
        assert!(SETUPS.running().is_empty());
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
        let script = setup_file(paths.resource_dir.as_deref(), "install.py", tauri::is_dev()).unwrap();
        assert_ne!(script, snapshot.join("install.py"));
        assert!(args.ends_with(&[
            "-I".as_ref(), "-B".as_ref(), script.as_os_str(), "--model".as_ref(),
            snapshot.as_os_str(), "--data-dir".as_ref(), paths.data_dir.as_os_str(),
        ]));
    }
}
