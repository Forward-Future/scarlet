//! Small helpers shared across the app: JavaScript-compatible string slicing
//! (runner summaries match the TypeScript host), command-line splitting, PATH
//! augmentation for GUI launches and hidden child processes on Windows.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// JavaScript `String.prototype.length` (UTF-16 code units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript `s.slice(0, n)` in UTF-16 code units.
pub fn js_slice_prefix(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// JavaScript `s.slice(-n)` in UTF-16 code units.
pub fn js_slice_suffix(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let start = units.len().saturating_sub(n);
    String::from_utf16_lossy(&units[start..])
}

/// Split a command line the way a shell would for the simple cases we need
/// (`SCARLET_ENGINE_CMD="node C:/path with spaces/cli.js"`): whitespace
/// separated, double or single quotes group, backslash escapes inside double quotes.
pub fn split_command_line(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_token = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            '\\' if in_double => {
                if let Some(&n) = chars.peek() {
                    if n == '"' || n == '\\' {
                        cur.push(n);
                        chars.next();
                        continue;
                    }
                }
                cur.push('\\');
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    out.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        out.push(cur);
    }
    out
}

/// Current environment as a map (Windows keys are case-insensitive; we keep the
/// original case but look `PATH` up case-insensitively where it matters).
/// Entries that are not valid Unicode are skipped: `std::env::vars` would panic on them.
pub fn env_map() -> HashMap<String, String> {
    std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect()
}

pub fn env_get<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    if let Some(v) = env.get(key) {
        return Some(v.as_str());
    }
    if cfg!(windows) {
        let lk = key.to_ascii_lowercase();
        return env.iter().find(|(k, _)| k.to_ascii_lowercase() == lk).map(|(_, v)| v.as_str());
    }
    None
}

pub fn assistant_prefix(home: &Path) -> PathBuf {
    home.join(".scarlet").join("assistants")
}

/// The PATH a GUI app inherits on macOS/Linux is minimal; add the places the
/// agent CLIs and node are usually installed so detection and spawning work
/// when Scarlet is launched from the Dock/Finder.
pub fn augmented_path(env: &HashMap<String, String>, home: &Path) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let current = env_get(env, "PATH").unwrap_or("").to_string();
    let mut parts: Vec<String> = current.split(sep).filter(|p| !p.is_empty()).map(String::from).collect();
    let prefix = assistant_prefix(home);
    let assistant_bin = if cfg!(windows) { prefix } else { prefix.join("bin") };
    let mut extra: Vec<PathBuf> = vec![assistant_bin, home.join(".local/bin"), home.join(".claude").join("local")];
    if cfg!(windows) {
        if let Some(appdata) = env_get(env, "APPDATA") {
            extra.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = env_get(env, "LOCALAPPDATA") {
            extra.push(PathBuf::from(local).join("pnpm"));
            extra.push(PathBuf::from(local).join("Programs").join("nodejs"));
            extra.push(PathBuf::from(local).join("Volta").join("bin"));
        }
        extra.push(home.join(".bun").join("bin"));
        extra.push(PathBuf::from("C:\\Program Files\\nodejs"));
    } else {
        for p in ["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/local/bin"] {
            extra.push(PathBuf::from(p));
        }
        extra.push(home.join(".npm-global/bin"));
        extra.push(home.join(".volta/bin"));
        extra.push(home.join(".bun/bin"));
        extra.push(home.join(".local/share/pnpm"));
        extra.push(home.join("Library/pnpm"));
        extra.push(home.join(".cargo/bin"));
        // The ChatGPT desktop app includes a Codex CLI even without a separate CLI installation.
        #[cfg(target_os = "macos")]
        for apps in [home.join("Applications"), PathBuf::from("/Applications")] {
            extra.push(apps.join("ChatGPT.app/Contents/Resources/codex-cli/bin"));
            extra.push(apps.join("Codex.app/Contents/Resources"));
        }
        // nvm / fnm: newest installed node first.
        for base in [home.join(".nvm/versions/node"), home.join(".local/share/fnm/node-versions")] {
            if let Ok(rd) = std::fs::read_dir(&base) {
                let mut versions: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                versions.sort();
                versions.reverse();
                for v in versions.into_iter().take(3) {
                    let bin = if v.join("bin").is_dir() { v.join("bin") } else { v.join("installation/bin") };
                    extra.push(bin);
                }
            }
        }
    }
    for e in extra {
        if !e.is_dir() {
            continue;
        }
        let s = e.to_string_lossy().to_string();
        let present = parts.iter().any(|p| {
            if cfg!(windows) {
                p.trim_end_matches(['\\', '/']).eq_ignore_ascii_case(s.trim_end_matches(['\\', '/']))
            } else {
                p.trim_end_matches('/') == s.trim_end_matches('/')
            }
        });
        if !present {
            parts.push(s);
        }
    }
    parts.join(&sep.to_string())
}

/// Environment for child processes: inherited env with an augmented PATH and
/// without the variables that make Claude Code refuse to start inside Claude Code.
pub fn child_env(home: &Path) -> HashMap<String, String> {
    let mut env = env_map();
    let key = env.keys().find(|k| k.eq_ignore_ascii_case("PATH")).cloned().unwrap_or_else(|| "PATH".into());
    #[cfg(target_os = "macos")]
    if let Some(login) = login_shell_path() {
        let inherited = env.get(&key).cloned().unwrap_or_default();
        env.insert(key.clone(), if inherited.is_empty() { login.to_string() } else { format!("{login}:{inherited}") });
    }
    let path = augmented_path(&env, home);
    env.insert(key, path);
    env.remove("CLAUDECODE");
    env.remove("CLAUDE_CODE_ENTRYPOINT");
    env
}

/// Apps opened from the Dock or Finder get launchd's minimal PATH, not the one
/// the user's shell builds (Homebrew, nvm, asdf, mise, custom installs), so
/// `claude` or `codex` would look missing. Ask the login shell once, the way
/// Terminal sees it. Gives up after 5 s (a shell waiting on input, say).
#[cfg(target_os = "macos")]
pub fn login_shell_path() -> Option<&'static str> {
    use std::io::Read;
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            const MARK: &str = "__SCARLET_PATH__";
            let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
            let mut child = std::process::Command::new(&shell)
                .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            let mut out = child.stdout.take()?;
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut s = String::new();
                let _ = out.read_to_string(&mut s);
                let _ = tx.send(s);
            });
            let text = rx.recv_timeout(std::time::Duration::from_secs(5)).ok();
            let _ = child.kill();
            let _ = child.wait();
            let text = text?;
            let start = text.find(MARK)? + MARK.len();
            let end = start + text[start..].find(MARK)?;
            let path = text[start..end].trim();
            (!path.is_empty()).then(|| path.to_string())
        })
        .as_deref()
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `CREATE_NO_WINDOW` so console children never flash a window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn hide_console(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Windows: a job object holding a process and every process it starts, which ends whatever is still in it when it
/// is dropped. A process that ends on Windows leaves its children running, and `taskkill /T` can no longer find them
/// under it. Nothing in the job may break away from it.
#[cfg(windows)]
pub struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a job object's handle may be used and closed from any thread.
#[cfg(windows)]
unsafe impl Send for ProcessJob {}

#[cfg(windows)]
impl ProcessJob {
    /// Put the process in a new job that ends everything in it when closed. The process should have started nothing
    /// yet: what it started before is not in the job.
    pub fn hold(process: std::os::windows::io::RawHandle) -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: plain Win32 calls on a handle this owns, with a limit structure of the size given.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            // Closed on every return from here.
            let job = ProcessJob(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &limits as *const _ as *const std::ffi::c_void, size) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if AssignProcessToJobObject(job.0, process as windows_sys::Win32::Foundation::HANDLE) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        // SAFETY: the handle is this job's own, and is closed once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// How long a Unix process group gets between `kill_tree`'s SIGTERM and its SIGKILL.
pub const KILL_AFTER: std::time::Duration = std::time::Duration::from_secs(5);

/// Stop a process and everything it spawned (cmd.exe shims start node as a
/// grandchild). Windows: `taskkill /T /F`. Unix: SIGTERM to the process group
/// (agent CLIs start their own MCP servers and node children; `build_command`
/// puts each in its own group) and the process, then SIGKILL after 5 s.
pub async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console(&mut cmd);
        cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let _ = cmd.status().await;
    }
    #[cfg(not(windows))]
    {
        async fn signal(sig: &str, pid: u32) {
            let quiet = || std::process::Stdio::null();
            let _ = tokio::process::Command::new("kill").args([sig, "--", &format!("-{pid}")]).stderr(quiet()).status().await;
            let _ = tokio::process::Command::new("kill").args([sig, &pid.to_string()]).stderr(quiet()).status().await;
        }
        signal("-TERM", pid).await;
        tokio::spawn(async move {
            tokio::time::sleep(KILL_AFTER).await;
            signal("-KILL", pid).await;
        });
    }
}

/// A child's output, line by line. Each line is decoded on its own, with any byte that isn't UTF-8 replaced: cmd.exe
/// on a non-English Windows writes its messages in the console's code page, and one such line must not end the
/// reading. Lines end at `\n`, a `\r` before it is dropped, and a last line without an ending is still a line.
pub struct LossyLines<R> {
    reader: tokio::io::BufReader<R>,
    buf: Vec<u8>,
}

pub fn lossy_lines<R: tokio::io::AsyncRead + Unpin>(reader: R) -> LossyLines<R> {
    LossyLines { reader: tokio::io::BufReader::new(reader), buf: Vec::new() }
}

impl<R: tokio::io::AsyncRead + Unpin> LossyLines<R> {
    /// The next line, or None at the end of the output.
    pub async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        use tokio::io::AsyncBufReadExt;
        self.buf.clear();
        if self.reader.read_until(b'\n', &mut self.buf).await? == 0 {
            return Ok(None);
        }
        let mut line = self.buf.as_slice();
        if let Some(rest) = line.strip_suffix(b"\n") {
            line = rest.strip_suffix(b"\r").unwrap_or(rest);
        }
        Ok(Some(String::from_utf8_lossy(line).into_owned()))
    }
}

pub fn now_iso() -> String {
    // RFC 3339 UTC with milliseconds, like `new Date().toISOString()`.
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let (y, mo, da, h, mi, s) = civil_from_unix(secs);
    format!("{y:04}-{mo:02}-{da:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Elapsed time for log lines: "850ms", "12s", "45m 2s", "1h 3m".
pub fn human_duration(d: std::time::Duration) -> String {
    let secs = d.as_secs();
    if secs == 0 {
        return format!("{}ms", d.as_millis());
    }
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    match (h, m, s) {
        (0, 0, s) => format!("{s}s"),
        (0, m, 0) => format!("{m}m"),
        (0, m, s) => format!("{m}m {s}s"),
        (h, 0, _) => format!("{h}h"),
        (h, m, _) => format!("{h}h {m}m"),
    }
}

/// The last few lines a CLI wrote to stderr, on one log line.
pub fn stderr_tail_line(stderr: &str) -> Option<String> {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    let tail = lines[lines.len().saturating_sub(5)..].join(" | ");
    Some(if js_len(&tail) > 800 { format!("…{}", js_slice_suffix(&tail, 800)) } else { tail })
}

pub(crate) fn civil_from_unix(t: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = t.div_euclid(86_400);
    let rem = t.rem_euclid(86_400);
    let (h, mi, s) = ((rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d, h, mi, s)
}

/// What the code under test logged, for the tests that check a log line. Every test shares one process and one
/// logger, so a test looks for a line that only it could have caused.
#[cfg(test)]
pub(crate) mod test_log {
    use std::sync::Mutex;

    static LINES: Mutex<Vec<(log::Level, String)>> = Mutex::new(Vec::new());

    struct Capture;

    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            LINES.lock().unwrap_or_else(|e| e.into_inner()).push((record.level(), record.args().to_string()));
        }
        fn flush(&self) {}
    }

    /// Start keeping log lines. Call it before the code that logs.
    pub fn capture() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            log::set_logger(&Capture).expect("no other test logger");
            log::set_max_level(log::LevelFilter::Info);
        });
    }

    /// The first line kept that holds every one of `parts`, with its level.
    pub fn find(parts: &[&str]) -> Option<(log::Level, String)> {
        LINES.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(_, line)| parts.iter().all(|p| line.contains(p))).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slices_count_utf16_units() {
        assert_eq!(js_len("a😀"), 3);
        assert_eq!(js_slice_prefix("abcd", 3), "abc");
        assert_eq!(js_slice_suffix("abcd", 2), "cd");
    }

    #[test]
    fn splits_command_lines() {
        assert_eq!(split_command_line(r#"node "C:\with space\cli.js" --x"#), vec!["node", r"C:\with space\cli.js", "--x"]);
        assert_eq!(split_command_line("  a   b "), vec!["a", "b"]);
        assert!(split_command_line("").is_empty());
    }

    #[test]
    fn iso_timestamp_shape() {
        let s = now_iso();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z'));
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil_from_unix(1_761_782_400), (2025, 10, 30, 0, 0, 0));
    }

    #[test]
    fn formats_durations_and_stderr_for_logs() {
        use std::time::Duration;
        assert_eq!(human_duration(Duration::from_millis(850)), "850ms");
        assert_eq!(human_duration(Duration::from_secs(12)), "12s");
        assert_eq!(human_duration(Duration::from_secs(45 * 60)), "45m");
        assert_eq!(human_duration(Duration::from_secs(45 * 60 + 2)), "45m 2s");
        assert_eq!(human_duration(Duration::from_secs(3780)), "1h 3m");
        assert_eq!(stderr_tail_line("  \n"), None);
        assert_eq!(stderr_tail_line("a\n\nb\nc\nd\ne\nf\n").as_deref(), Some("b | c | d | e | f"));
    }

    #[test]
    fn slices_never_split_a_character_in_two() {
        // An emoji is two UTF-16 units. Cut through, the half is replaced, as JavaScript shows a lone surrogate.
        assert_eq!(js_slice_prefix("a😀b", 3), "a😀");
        assert_eq!(js_slice_prefix("a😀b", 2), "a\u{fffd}");
        assert_eq!(js_slice_suffix("a😀b", 2), "\u{fffd}b");
        assert_eq!(js_slice_prefix("abc", 10), "abc");
        assert_eq!(js_slice_suffix("abc", 10), "abc");
        assert_eq!((js_slice_prefix("abc", 0), js_slice_suffix("abc", 0)), (String::new(), String::new()));
    }

    #[test]
    fn splits_quoted_command_lines_the_way_a_shell_would() {
        // Single quotes group and keep everything inside as typed, a double quote and a backslash included.
        assert_eq!(split_command_line(r#"node '/repo with space/cli.js' 'say "hi"' 'C:\dir'"#), vec!["node", "/repo with space/cli.js", r#"say "hi""#, r"C:\dir"]);
        // Inside double quotes a backslash escapes a quote or itself, and is literal before anything else.
        assert_eq!(split_command_line(r#""a \"quoted\" word" "back\\slash" "C:\new""#), vec![r#"a "quoted" word"#, r"back\slash", r"C:\new"]);
        // A single quote inside double quotes is a character, and quotes join onto the word beside them.
        assert_eq!(split_command_line(r#""it's" --flag="two words" a'b c'd"#), vec!["it's", "--flag=two words", "ab cd"]);
        // An empty pair of quotes is an empty argument, not nothing.
        assert_eq!(split_command_line(r#"engine "" ''"#), vec!["engine", "", ""]);
        // Tabs and newlines separate, and a quote left open runs to the end.
        assert_eq!(split_command_line("a\tb\nc"), vec!["a", "b", "c"]);
        assert_eq!(split_command_line(r#"node "unterminated path"#), vec!["node", "unterminated path"]);
        assert!(split_command_line("   \t ").is_empty());
    }

    #[test]
    fn looks_a_variable_up_by_its_exact_name_except_on_windows() {
        let env = HashMap::from([("Path".to_string(), "C:\\bin".to_string()), ("HOME".to_string(), "/home/editor".to_string())]);
        assert_eq!(env_get(&env, "HOME"), Some("/home/editor"));
        assert_eq!(env_get(&env, "Path"), Some("C:\\bin"));
        assert_eq!(env_get(&env, "PATH"), if cfg!(windows) { Some("C:\\bin") } else { None });
        assert_eq!(env_get(&env, "MISSING"), None);
    }

    #[test]
    fn adds_only_install_folders_that_exist_after_the_inherited_path() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let home = tempfile::tempdir().unwrap();
        let assistants = if cfg!(windows) { assistant_prefix(home.path()) } else { assistant_prefix(home.path()).join("bin") };
        let local = home.path().join(".local").join("bin");
        let inherited = home.path().join("inherited");
        for dir in [&assistants, &local, &inherited] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let text = |p: &Path| p.to_string_lossy().into_owned();
        // The inherited PATH names a folder twice over: once as is, once with a trailing separator that Scarlet
        // would otherwise add again.
        let env = HashMap::from([("PATH".to_string(), [text(&inherited), String::new(), format!("{}{}", text(&local), std::path::MAIN_SEPARATOR)].join(sep))]);
        let path = augmented_path(&env, home.path());
        let parts: Vec<&str> = path.split(sep).collect();
        // What was inherited stays first and in order, with the empty entry dropped.
        assert_eq!(parts[0], text(&inherited));
        assert_eq!(parts[1].trim_end_matches(std::path::MAIN_SEPARATOR), text(&local));
        // Scarlet's own assistant folder is added once. One that doesn't exist is not added.
        assert_eq!(parts.iter().filter(|p| **p == text(&assistants)).count(), 1);
        assert_eq!(parts.iter().filter(|p| p.trim_end_matches(std::path::MAIN_SEPARATOR) == text(&local)).count(), 1);
        assert!(!parts.contains(&text(&home.path().join(".claude").join("local")).as_str()));
        assert!(parts.iter().all(|p| !p.is_empty()));
        // With no PATH at all it is still built from the install folders.
        let bare = augmented_path(&HashMap::new(), home.path());
        assert!(bare.split(sep).any(|p| p == text(&assistants)), "{bare}");
        // nvm's newest node comes before its older ones.
        if !cfg!(windows) {
            for version in ["v18.20.0", "v22.11.0", "v20.9.0", "v16.0.0"] {
                std::fs::create_dir_all(home.path().join(".nvm/versions/node").join(version).join("bin")).unwrap();
            }
            let path = augmented_path(&HashMap::new(), home.path());
            let nodes: Vec<&str> = path.split(sep).filter(|p| p.contains(".nvm")).map(|p| p.rsplit('/').nth(1).unwrap()).collect();
            assert_eq!(nodes, ["v22.11.0", "v20.9.0", "v18.20.0"], "three newest, newest first");
        }
    }

    #[test]
    fn a_child_never_inherits_the_markers_of_a_claude_code_session() {
        let home = tempfile::tempdir().unwrap();
        let local = home.path().join(".local/bin");
        std::fs::create_dir_all(&local).unwrap();
        let env = child_env(home.path());
        // This test may itself run inside Claude Code, which sets both.
        assert!(!env.contains_key("CLAUDECODE") && !env.contains_key("CLAUDE_CODE_ENTRYPOINT"));
        // One PATH, under the name the system used, holding what was inherited and the install folders.
        let names: Vec<&String> = env.keys().filter(|k| k.eq_ignore_ascii_case("PATH")).collect();
        assert_eq!(names.len(), 1);
        let sep = if cfg!(windows) { ';' } else { ':' };
        let path: Vec<&str> = env[names[0]].split(sep).collect();
        assert!(path.contains(&local.to_string_lossy().as_ref()));
        for inherited in std::env::var("PATH").unwrap_or_default().split(sep).filter(|p| !p.is_empty()) {
            assert!(path.contains(&inherited), "dropped {inherited}");
        }
    }

    #[test]
    fn formats_long_durations_and_keeps_the_end_of_a_long_stderr() {
        use std::time::Duration;
        assert_eq!(human_duration(Duration::ZERO), "0ms");
        assert_eq!(human_duration(Duration::from_millis(999)), "999ms");
        assert_eq!(human_duration(Duration::from_secs(60)), "1m");
        assert_eq!(human_duration(Duration::from_secs(3600)), "1h");
        // Past an hour the seconds are dropped.
        assert_eq!(human_duration(Duration::from_secs(2 * 3600 + 59)), "2h");
        assert_eq!(human_duration(Duration::from_secs(26 * 3600 + 5 * 60 + 9)), "26h 5m");
        // Five lines at most, and 800 characters at most, from the end.
        let long = format!("first line\n{}\nfatal: the real reason", "x".repeat(2000));
        let tail = stderr_tail_line(&long).unwrap();
        assert!(tail.starts_with('…') && tail.ends_with(" | fatal: the real reason"), "{tail}");
        assert_eq!(js_len(&tail), 801);
        assert_eq!(stderr_tail_line("  only line \r\n").as_deref(), Some("only line"));
        assert_eq!(stderr_tail_line(""), None);
    }

    #[tokio::test]
    async fn reads_every_line_of_a_child_however_it_is_encoded() {
        // A line in a Windows code page, then UTF-8, then a last line with no ending.
        let bytes: &[u8] = b"first\r\nAcc\xe8s refus\xe9\r\n\xff\n\ncaf\xc3\xa9\nlast";
        let mut lines = lossy_lines(bytes);
        let mut read = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            read.push(line);
        }
        assert_eq!(read, ["first", "Acc\u{fffd}s refus\u{fffd}", "\u{fffd}", "", "café", "last"]);
        // At the end it keeps saying so.
        assert_eq!(lines.next_line().await.unwrap(), None);
    }

    #[test]
    fn reads_dates_before_1970_and_leap_days() {
        assert_eq!(civil_from_unix(-1), (1969, 12, 31, 23, 59, 59));
        assert_eq!(civil_from_unix(951_782_400), (2000, 2, 29, 0, 0, 0));
        assert_eq!(civil_from_unix(1_709_251_199), (2024, 2, 29, 23, 59, 59));
        assert_eq!(civil_from_unix(4_102_444_800), (2100, 1, 1, 0, 0, 0));
    }
}
