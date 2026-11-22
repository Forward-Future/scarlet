//! Engine launch resolution, handshake parsing, log classification, bundled Chrome
//! discovery, and dev-build modification-time polling.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::util::{child_env, env_remove_ci, split_command_line};

pub const READY_PREFIX: &str = "SCARLET_READY";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadyInfo {
    pub port: u16,
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub data_dir: Option<String>,
}

/// Parse the engine's ready line. Returns None for any other output.
pub fn parse_ready_line(line: &str) -> Option<ReadyInfo> {
    let rest = line.trim_start().strip_prefix(READY_PREFIX)?;
    serde_json::from_str::<ReadyInfo>(rest.trim()).ok()
}

/// The level one line of the engine's output is logged at. The engine writes its log to stdout. What reaches stderr
/// is an error or a stack trace.
pub(super) fn engine_line_level(line: &str, stderr: bool) -> log::Level {
    let fault = line.starts_with("[error]");
    let warning = ["[mcp] tool-finished ", "[audio] finished ", "[media] proxy_finished ", "[transfer] file-read "]
        .iter().any(|prefix| line.starts_with(prefix))
        && line.split_ascii_whitespace().any(|field| matches!(field, "outcome=failed" | "outcome=truncated" | "outcome=degraded"));
    match (fault, stderr || warning) {
        // A fault, on either stream. One the engine carries on from, such as a request that failed, is written to
        // stdout with the rest of its log, and the uncaught error that stops it to stderr. A search of the app log
        // for ERROR has to find both. The stack under one stays at its stream's level: one ERROR line for each fault.
        (true, _) => log::Level::Error,
        (false, true) => log::Level::Warn,
        (false, false) => log::Level::Info,
    }
}

/// How to launch the engine binary (also used for the MCP server: `<program> <prefix…> mcp …`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineLaunch {
    pub program: String,
    pub prefix_args: Vec<String>,
    /// "sidecar" | "env" | "dev"
    pub kind: String,
}

impl EngineLaunch {
    pub fn describe(&self) -> String {
        let mut parts = vec![self.program.clone()];
        parts.extend(self.prefix_args.iter().cloned());
        parts.join(" ")
    }
}

/// Repo root at compile time (dev fallback only).
pub fn dev_repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

fn sidecar_name() -> &'static str {
    if cfg!(windows) {
        "scarlet-engine.exe"
    } else {
        "scarlet-engine"
    }
}

/// Tauri dev uses the compiled checkout. Packaged builds (including debug bundles) use the sidecar.
pub fn resolve_engine_launch(home: &Path, resources: Option<&Path>) -> Result<EngineLaunch> {
    // The deb installs the private engine, Whisper and native audio libraries together under /usr/lib/Scarlet.
    let sidecar = if cfg!(target_os = "linux") {
        resources.map(|dir| dir.join(sidecar_name()))
    } else {
        std::env::current_exe().ok().map(|exe| exe.with_file_name(sidecar_name()))
    };
    let cli = dev_repo_root().join("apps/server/dist/cli.js");
    select_engine(home, tauri::is_dev(), sidecar.as_deref(), std::env::var("SCARLET_ENGINE_CMD").ok().as_deref(), &cli)
}

fn select_engine(home: &Path, development: bool, sidecar: Option<&Path>, override_cmd: Option<&str>, cli: &Path) -> Result<EngineLaunch> {
    if !development {
        if let Some(candidate) = sidecar.filter(|p| p.metadata().is_ok_and(|m| m.is_file() && m.len() > 1024)) {
            return Ok(EngineLaunch { program: candidate.to_string_lossy().into_owned(), prefix_args: vec![], kind: "sidecar".into() });
        }
    }
    if let Some(cmd) = override_cmd {
        let parts = split_command_line(cmd);
        if let Some((program, rest)) = parts.split_first() {
            return Ok(EngineLaunch { program: program.clone(), prefix_args: rest.to_vec(), kind: "env".into() });
        }
    }
    if cli.is_file() {
        let env = child_env(home);
        let node = crate::host::spawn::find_on_path("node", &env).ok_or_else(|| anyhow!("node not found on PATH (needed for the dev engine fallback)"))?;
        let cli = std::fs::canonicalize(cli).unwrap_or_else(|_| cli.to_path_buf());
        let cli = cli.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        return Ok(EngineLaunch { program: node, prefix_args: vec![cli], kind: "dev".into() });
    }
    if development { return Err(anyhow!("Build the development engine with pnpm build, or set SCARLET_ENGINE_CMD")); }
    Err(anyhow!("scarlet-engine sidecar not found (set SCARLET_ENGINE_CMD or build apps/server for the dev fallback)"))
}

/// The headless shell motion graphics render in: the packaged resource, or in development the copy
/// `pnpm desktop:chrome` fetched. Before that fetch the folder holds only a note.
pub(super) fn bundled_chrome(resources: Option<&Path>, development: bool) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" };
    let checkout = development.then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    checkout.into_iter().chain(resources.map(Path::to_path_buf))
        .map(|dir| dir.join("chrome-headless-shell").join(exe))
        .find(|path| path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0))
}

/// Points the engine at the bundled browser. A SCARLET_CHROME the editor set wins; without either, the engine
/// looks for an installed Chrome.
pub(super) fn set_chrome_env(env: &mut HashMap<String, String>, chrome: Option<&Path>) {
    const KEY: &str = "SCARLET_CHROME";
    if env.iter().any(|(key, value)| key.eq_ignore_ascii_case(KEY) && !value.trim().is_empty()) {
        return;
    }
    env_remove_ci(env, &[KEY]);
    if let Some(chrome) = chrome {
        env.insert(KEY.into(), chrome.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    }
}

/// Newest modification time of any file under `dirs` (None if none exist).
pub(super) fn newest_mtime(dirs: &[PathBuf]) -> Option<SystemTime> {
    fn walk(dir: &Path, best: &mut Option<SystemTime>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                walk(&e.path(), best);
            } else if let Ok(m) = meta.modified() {
                if best.is_none_or(|b| m > b) {
                    *best = Some(m);
                }
            }
        }
    }
    let mut best = None;
    for d in dirs {
        walk(d, &mut best);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn newest_mtime_sees_new_files() {
        let dir = std::env::temp_dir().join(format!("scarlet-mtime-{}", std::process::id()));
        let nested = dir.join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(newest_mtime(std::slice::from_ref(&dir)), None);
        std::fs::write(nested.join("x.js"), "1").unwrap();
        let first = newest_mtime(std::slice::from_ref(&dir));
        assert!(first.is_some());
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("y.js"), "2").unwrap();
        assert!(newest_mtime(&[dir.clone(), dir.join("missing")]) > first);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_the_ready_line() {
        let line = r#"SCARLET_READY {"port":51234,"url":"http://127.0.0.1:51234","token":"sct_abc","userId":"usr_1","dataDir":"C:\\data"}"#;
        let info = parse_ready_line(line).unwrap();
        assert_eq!(info.port, 51234);
        assert_eq!(info.url, "http://127.0.0.1:51234");
        assert_eq!(info.token, "sct_abc");
        assert_eq!(info.user_id.as_deref(), Some("usr_1"));
        assert_eq!(info.data_dir.as_deref(), Some("C:\\data"));
        assert!(parse_ready_line("[skills] seeded 8 skill(s) from the bundled set").is_none());
        assert!(parse_ready_line("SCARLET_READY not json").is_none());
        assert!(parse_ready_line("").is_none());
        // Minimal payload still parses.
        assert!(parse_ready_line(r#"SCARLET_READY {"port":1,"url":"http://127.0.0.1:1","token":"t"}"#).is_some());
    }

    #[test]
    fn dev_prefers_checkout_even_when_a_packaged_engine_is_present() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join(sidecar_name());
        let cli = dir.path().join("cli.js");
        std::fs::write(&sidecar, vec![1; 2048]).unwrap();
        std::fs::write(&cli, "// fixture").unwrap();
        let home = crate::util::home_dir();
        let resolve = |dev, cmd| select_engine(&home, dev, Some(&sidecar), cmd, &cli);
        assert_eq!(resolve(true, None).unwrap().kind, "dev");
        assert_eq!(resolve(true, Some("custom-engine")).unwrap().program, "custom-engine");
        assert_eq!(resolve(false, None).unwrap().program, sidecar.to_string_lossy());
        std::fs::remove_file(&cli).unwrap();
        assert!(resolve(true, None).is_err());
    }

    #[test]
    fn dev_fallback_resolves_on_this_checkout() {
        // In this repo apps/server/dist exists, so the fallback must resolve to node + cli.js
        // (unless SCARLET_ENGINE_CMD is set in the environment).
        let l = resolve_engine_launch(&crate::util::home_dir(), None).unwrap();
        assert!(!l.program.is_empty());
        if l.kind == "dev" {
            assert!(l.prefix_args[0].replace('\\', "/").ends_with("apps/server/dist/cli.js"));
        }
    }

    #[test]
    fn a_packaged_app_runs_its_sidecar_unless_the_sidecar_is_a_placeholder() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::util::home_dir();
        let sidecar = dir.path().join(sidecar_name());
        let cli = dir.path().join("missing-cli.js");
        // The build script writes an empty file where the engine was never built.
        std::fs::write(&sidecar, "").unwrap();
        let packaged = |cmd| select_engine(&home, false, Some(&sidecar), cmd, &cli);
        let error = packaged(None).unwrap_err().to_string();
        assert!(error.starts_with("scarlet-engine sidecar not found"), "{error}");
        // SCARLET_ENGINE_CMD stands in for it, split the way a shell would.
        let env = packaged(Some(r#"node "/repo with space/cli.js" --inspect"#)).unwrap();
        assert_eq!((env.kind.as_str(), env.program.as_str(), env.prefix_args.as_slice()), ("env", "node", &["/repo with space/cli.js".to_string(), "--inspect".to_string()][..]));
        assert_eq!(env.describe(), "node /repo with space/cli.js --inspect");
        // Set to nothing, it is no command at all.
        assert!(packaged(Some("   ")).is_err());
        // A real sidecar wins over the variable in a packaged app, and a folder of that name is not one.
        std::fs::write(&sidecar, vec![0; 4096]).unwrap();
        assert_eq!(packaged(Some("node cli.js")).unwrap().kind, "sidecar");
        std::fs::remove_file(&sidecar).unwrap();
        std::fs::create_dir(&sidecar).unwrap();
        assert!(packaged(None).is_err());
        assert!(select_engine(&home, false, None, None, &cli).is_err());
        // In development the message says how to get an engine.
        let error = select_engine(&home, true, None, None, &cli).unwrap_err().to_string();
        assert!(error.contains("pnpm build"), "{error}");
    }

    #[test]
    fn the_engine_renders_graphics_with_the_bundled_browser_unless_the_editor_chose_one() {
        let dir = tempfile::tempdir().unwrap();
        let exe = if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" };
        let folder = dir.path().join("chrome-headless-shell");
        std::fs::create_dir(&folder).unwrap();
        // An unfetched folder holds only the build script's note.
        std::fs::write(folder.join("README.txt"), "fetch me").unwrap();
        assert_eq!(bundled_chrome(Some(dir.path()), false), None);
        std::fs::write(folder.join(exe), vec![1; 64]).unwrap();
        let packaged = bundled_chrome(Some(dir.path()), false).unwrap();
        assert_eq!(packaged, folder.join(exe));
        assert_eq!(bundled_chrome(None, false), None);

        let mut env = HashMap::new();
        set_chrome_env(&mut env, Some(&packaged));
        assert_eq!(env["SCARLET_CHROME"], packaged.to_string_lossy());
        let mut env = HashMap::from([("SCARLET_CHROME".to_string(), "/opt/chrome".to_string())]);
        set_chrome_env(&mut env, Some(&packaged));
        assert_eq!(env["SCARLET_CHROME"], "/opt/chrome");
        // Set to nothing, it is not a choice.
        let mut env = HashMap::from([("SCARLET_CHROME".to_string(), String::new())]);
        set_chrome_env(&mut env, None);
        assert!(!env.contains_key("SCARLET_CHROME"));
        set_chrome_env(&mut env, Some(&packaged));
        assert_eq!(env["SCARLET_CHROME"], packaged.to_string_lossy());
    }

    #[test]
    fn reads_the_ready_line_only_in_the_engines_own_shape() {
        // Indented, as a wrapped launcher may print it.
        assert!(parse_ready_line(r#"   SCARLET_READY {"port":1,"url":"http://127.0.0.1:1","token":"t"}  "#).is_some());
        // Without a port, an address or a token there is nothing to connect to.
        for partial in [r#"{"url":"http://127.0.0.1:1","token":"t"}"#, r#"{"port":1,"token":"t"}"#, r#"{"port":1,"url":"http://127.0.0.1:1"}"#, r#"{"port":70000,"url":"u","token":"t"}"#] {
            assert!(parse_ready_line(&format!("SCARLET_READY {partial}")).is_none(), "{partial}");
        }
        // A line that only mentions it is log output.
        assert!(parse_ready_line(r#"[engine] printed SCARLET_READY {"port":1,"url":"u","token":"t"}"#).is_none());
    }

    #[test]
    fn an_engine_line_tagged_as_an_error_is_logged_as_one_from_either_stream() {
        use log::Level::{Error, Info, Warn};
        // A route that failed is written to stdout with the rest of the engine's log. A search of the app log for
        // ERROR has to find it.
        assert_eq!(engine_line_level("[error] POST /api/projects/prj_1/changes: Error: database is locked", false), Error);
        // The stack under it stays at the stream's level: one ERROR line for each fault.
        assert_eq!(engine_line_level("    at submitChange (file:///app/dist/services/changes.js:120:11)", false), Info);
        assert_eq!(engine_line_level("[skills] seeded 8 skill(s) from the bundled set", false), Info);
        // The uncaught error that stops the engine is written to stderr.
        assert_eq!(engine_line_level("[error] engine stopped on an uncaught error: Error: out of memory", true), Error);
        assert_eq!(engine_line_level("    at main (file:///app/dist/cli.js:96:5)", true), Warn);
        // The tag is the engine's own, at the start of a line. A line that only holds the word is log output.
        assert_eq!(engine_line_level("[transcribe] whisper-cli wrote: [error] no model", false), Info);
    }
}
