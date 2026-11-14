//! Process helpers shared by the runners (port of apps/agent/src/runners/spawn.ts):
//! resolve the CLI, spawn it (through cmd.exe for Windows .cmd/.bat shims),
//! stream stdout line by line, enforce a timeout, honour cancellation and stop
//! the whole process tree on request.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::util::{env_get, hide_console, human_duration, kill_tree, lossy_lines, stderr_tail_line, KILL_AFTER};

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

pub struct SpawnLinesOptions {
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    /// Written to stdin then closed (stdin is always closed after this).
    pub stdin: Option<String>,
    pub cancel: CancellationToken,
    /// Stop the process after this long, however busy it is. `None` lets it run.
    pub timeout: Option<Duration>,
    /// Stop the process once it has written nothing to stdout for this long.
    pub stall: Option<Duration>,
    /// The task the process runs for, to name it in its log lines.
    pub task: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SpawnOutcome {
    pub code: Option<i32>,
    /// Stopped by `timeout` or `stall`.
    pub timed_out: bool,
    /// Stopped by `stall`: the process had gone silent.
    pub stalled: bool,
    pub aborted: bool,
    pub killed: bool,
    pub stderr: String,
}

/// Callback per stdout line. Return `true` to stop the process (after a short
/// grace period, like the TS `setTimeout(kill, 250)`).
pub type LineHandler = Box<dyn FnMut(&str) -> bool + Send>;

/// Task arguments must go directly to an executable, never through the batch interpreter.
fn runner_spec(file: &str, args: &[String], env: &HashMap<String, String>) -> Result<SpawnSpec> {
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
fn npm_entry(shim: &Path, name: &str, package: &str) -> Result<PathBuf> {
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

/// Where each running agent CLI's process id is noted, so the next launch can stop one this launch never got to.
static PID_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
/// CLIs told to stop in this launch, and when. For a few seconds after a stop, members of a CLI's process group
/// may still be alive.
static STOPPED: std::sync::Mutex<Vec<(u32, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

fn pid_note(pid: u32) -> Option<PathBuf> {
    PID_DIR.get().map(|dir| dir.join(pid.to_string()))
}

/// Stop agent CLIs an earlier launch left running. A crash or force-quit signals nobody: each CLI is in its own
/// process group and would keep working, and spending, with no app to report to. Runs once per launch.
pub fn stop_orphans(dir: &Path) {
    if PID_DIR.set(dir.to_path_buf()).is_err() {
        return;
    }
    if let Err(e) = crate::config::private_directory(dir) {
        log::warn!("could not prepare {} for noting agent CLIs: {e:#}", dir.display());
    }
    stop_noted(dir);
}

fn stop_noted(dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let note = entry.path();
        let (cli, scarlet) = note_halves(&std::fs::read_to_string(&note).unwrap_or_default());
        // The installed app and a development preview share these notes. A CLI whose Scarlet is still open is
        // that Scarlet's work, and its note stays for the launch after that Scarlet's.
        if scarlet.is_some_and(|(pid, scarlet)| still_runs(pid, &scarlet)) {
            continue;
        }
        if let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) {
            if still_runs(pid, &cli) {
                log::warn!("stopping agent CLI {pid} left running by an earlier session ({})", cli.lines().next().unwrap_or_default());
                kill_group_now(pid);
            }
        }
        let _ = std::fs::remove_file(&note);
    }
}

/// What a note holds: the CLI's program and start time, then the process id, program and start time of the
/// Scarlet that started it. A note from before Scarlet recorded itself holds only the CLI.
fn note_halves(note: &str) -> (String, Option<(u32, String)>) {
    let lines: Vec<&str> = note.lines().collect();
    let pair = |at: usize| lines.iter().skip(at).take(2).copied().collect::<Vec<_>>().join("\n");
    (pair(0), lines.get(2).and_then(|pid| pid.trim().parse().ok()).map(|pid| (pid, pair(3))))
}

/// What a spawn notes, as `note_halves` reads it.
fn note_for(program: &str, pid: u32) -> String {
    let (scarlet_pid, scarlet) = this_scarlet();
    format!("{program}\n{}\n{scarlet_pid}\n{scarlet}", start_stamp(pid))
}

/// This Scarlet, as it is written down for a later launch or another Scarlet to ask about: its process id, then its
/// program and start time as `still_runs` reads them.
pub(crate) fn this_scarlet() -> (u32, String) {
    let scarlet = std::env::current_exe().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
    (std::process::id(), format!("{scarlet}\n{}", own_start()))
}

/// When this Scarlet started, as its notes record it. Windows counts a start time the same way for as long as the
/// process lives, and reading one starts PowerShell, so it is read once there. `ps` prints a start time in the time
/// zone of the moment, so elsewhere it is read for each note, beside the CLI's.
fn own_start() -> String {
    static READ: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if !cfg!(windows) {
        return start_stamp(std::process::id());
    }
    if let Some(read) = READ.get() {
        return read.clone();
    }
    let read = start_stamp(std::process::id());
    if !read.is_empty() {
        let _ = READ.set(read.clone());
    }
    read
}

/// When the process started, as `ps` prints it. Empty when it is gone.
#[cfg(not(windows))]
fn start_stamp(pid: u32) -> String {
    let out = std::process::Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// When the process started, as the file time PowerShell reads for it. Empty when it is gone or can't be read.
/// Asked of .NET directly, which needs no PowerShell module to load.
#[cfg(windows)]
fn start_stamp(pid: u32) -> String {
    use std::os::windows::process::CommandExt;
    let script = format!("try {{ [System.Diagnostics.Process]::GetProcessById({pid}).StartTime.ToFileTimeUtc() }} catch {{ }}");
    let out = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(crate::util::CREATE_NO_WINDOW).output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// The process id may have been reused since. Only the process noted at spawn, by program and start time, is ours.
pub(crate) fn still_runs(pid: u32, note: &str) -> bool {
    noted_program(note, || start_stamp(pid)).is_some_and(|name| runs_program(pid, name))
}

/// The program a note names, when the note carries a start time and the process has that start time now.
fn noted_program(note: &str, started_now: impl FnOnce() -> String) -> Option<&str> {
    let (program, started) = note.split_once('\n').unwrap_or((note, ""));
    let name = Path::new(program.trim()).file_name().and_then(|n| n.to_str()).unwrap_or_default();
    // Older Windows builds noted no start time, and a start time that can't be read is noted as none. Such a note
    // stops nothing: the name alone would also fit an unrelated process that has since been given the id.
    (!name.is_empty() && !started.trim().is_empty() && started_now() == started.trim()).then_some(name)
}

/// Whether the process is running the program, by the command line `ps` prints for it.
#[cfg(not(windows))]
fn runs_program(pid: u32, name: &str) -> bool {
    let out = std::process::Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output();
    out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(name))
}

/// Whether the process is running the program, by the image `tasklist` names for it. Windows file names ignore case.
#[cfg(windows)]
fn runs_program(pid: u32, name: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]).creation_flags(crate::util::CREATE_NO_WINDOW);
    cmd.output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains(&name.to_lowercase()))
}

/// SIGKILL the CLI's whole process group at once. Windows: `taskkill /T /F`.
pub(crate) fn kill_group_now(pid: u32) {
    let quiet = std::process::Stdio::null;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(crate::util::CREATE_NO_WINDOW).stdout(quiet()).stderr(quiet()).status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).stdout(quiet()).stderr(quiet()).status();
        let _ = std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).stdout(quiet()).stderr(quiet()).status();
    }
}

/// The CLIs whose stop is recent enough that the kill after it may not have been sent. An older one is finished,
/// and the system may have given its process id to another program since.
fn still_stopping(stopped: Vec<(u32, std::time::Instant)>, now: std::time::Instant) -> Vec<u32> {
    stopped.into_iter().filter(|(_, at)| now.saturating_duration_since(*at) < KILL_AFTER).map(|(pid, _)| pid).collect()
}

/// At exit, finish off the CLIs this launch has just told to stop. On Unix a polite stop is followed by a kill
/// five seconds later, and the app is usually gone before then. Windows stops a CLI's whole tree at once, so
/// nothing is left to finish there, and killing by a process id that has ended could hit another program.
pub fn kill_stopped_now() {
    let stopped = std::mem::take(&mut *STOPPED.lock().unwrap());
    finish_stops(stopped, std::time::Instant::now());
}

fn finish_stops(stopped: Vec<(u32, std::time::Instant)>, now: std::time::Instant) {
    if cfg!(windows) {
        return;
    }
    // Each CLI's note goes when it ends. A note under one of these ids now is a newer CLI's, and stays.
    for pid in still_stopping(stopped, now) {
        kill_group_now(pid);
    }
}

/// Spawn and stream. Resolves when the process has exited and all stdout has been handled.
pub async fn spawn_lines(file: &str, args: &[String], opts: SpawnLinesOptions, mut on_line: LineHandler) -> Result<SpawnOutcome> {
    let spec = runner_spec(file, args, &opts.env)?;
    let mut cmd = build_command(&spec, Some(&opts.cwd), &opts.env);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().with_context(|| format!("spawn {}", spec.file))?;
    let pid = child.id().ok_or_else(|| anyhow!("no pid"))?;
    let started = std::time::Instant::now();
    let who = log_name(file, pid, opts.task.as_deref());
    // Noted in the background: Windows reads the start time through PowerShell, which can take seconds, and
    // Claude Code waits only a few seconds for the prompt written below.
    let noting = pid_note(pid).map(|note| {
        let program = spec.file.clone();
        tokio::spawn(async move {
            if let Ok(text) = tokio::task::spawn_blocking(move || note_for(&program, pid)).await {
                // No await from here on: once cancelled, this task has either written the note or never will.
                if let Err(e) = std::fs::write(note, text) {
                    // Without its note, the next launch can't stop this CLI if this one crashes.
                    log::warn!("could not note agent CLI {pid} for the next launch: {e}");
                }
            }
        })
    });

    // stdin: write the prompt (if any) and close.
    if let Some(mut stdin) = child.stdin.take() {
        let input = opts.stdin.clone();
        let who = who.clone();
        tokio::spawn(async move {
            if let Some(s) = input {
                if let Err(e) = stdin.write_all(s.as_bytes()).await {
                    log::warn!("{who} did not take its prompt: {e}");
                }
            }
            let _ = stdin.shutdown().await;
            drop(stdin);
        });
    }

    // stderr: keep the tail.
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let stderr_task = child.stderr.take().map(|mut err| {
        let buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut chunk = vec![0u8; 8192];
            loop {
                match err.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut b = buf.lock().await;
                        b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        if b.len() > 64_000 {
                            let cut = b.len() - 32_000;
                            let cut = (cut..b.len()).find(|i| b.is_char_boundary(*i)).unwrap_or(b.len());
                            *b = b[cut..].to_string();
                        }
                    }
                }
            }
        })
    });

    // stdout: lines -> handler. A `true` return schedules a kill. Every line is a sign of life for `stall`.
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let last_line = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    let stdout_task = child.stdout.take().map(|out| {
        let killed = killed.clone();
        let last_line = last_line.clone();
        tokio::spawn(async move {
            let mut lines = lossy_lines(out);
            while let Ok(Some(line)) = lines.next_line().await {
                *last_line.lock().unwrap() = std::time::Instant::now();
                let line = line.strip_suffix('\r').unwrap_or(&line);
                if line.trim().is_empty() {
                    continue;
                }
                if on_line(line) {
                    let killed = killed.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        killed.store(true, std::sync::atomic::Ordering::SeqCst);
                        kill_tree(pid).await;
                    });
                }
            }
        })
    });

    let mut outcome = SpawnOutcome::default();
    let status = tokio::select! {
        s = child.wait() => s,
        _ = opts.cancel.cancelled() => {
            outcome.aborted = true;
            outcome.killed = true;
            kill_tree(pid).await;
            child.wait().await
        }
        verdict = watch(opts.timeout, opts.stall, &last_line, &who) => {
            outcome.timed_out = true;
            outcome.stalled = verdict == Watch::Stalled;
            outcome.killed = true;
            kill_tree(pid).await;
            child.wait().await
        }
    };
    outcome.code = status.ok().and_then(|s| s.code());
    if killed.load(std::sync::atomic::Ordering::SeqCst) {
        outcome.killed = true;
    }
    if outcome.killed {
        let now = std::time::Instant::now();
        let mut stopped = STOPPED.lock().unwrap();
        stopped.retain(|(_, at)| now.saturating_duration_since(*at) < KILL_AFTER);
        stopped.push((pid, now));
    }
    // Cancelled before the note is removed, so a start time that arrives late can't leave a note behind. Waiting for
    // the cancel matters where several workers run tasks at once and the note may be half written; the tests run on
    // one thread and can't see that wait. A note left that way holds this CLI's own start time, so the next launch
    // finds no such process and deletes it.
    if let Some(noting) = noting {
        noting.abort();
        let _ = noting.await;
    }
    if let Some(note) = pid_note(pid) {
        let _ = std::fs::remove_file(note);
    }
    if let Some(t) = stdout_task {
        let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
    }
    if let Some(t) = stderr_task {
        let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
    }
    outcome.stderr = stderr_buf.lock().await.clone();
    log_outcome(&who, started.elapsed(), &opts, &outcome);
    Ok(outcome)
}

/// How often a run's watchdog looks at the clock.
const WATCH_TICK: Duration = Duration::from_secs(1);
/// A look this late means the computer was asleep since the last one. Windows' clock counts on through a suspend,
/// so a run would otherwise wake up stalled, or past its limit. A busy machine is late by seconds, not this.
const ASLEEP_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq)]
enum Watch {
    Running,
    /// The computer slept for this long (the gap between two looks): the stall clock starts again.
    Slept(Duration),
    /// The run has been awake for its whole time limit.
    TimedOut,
    /// The process has written no stdout line for the stall window. The agent CLIs stream an event for every step,
    /// tool call and message, so a long silence means a hang, not a slow edit.
    Stalled,
}

/// What a run's time limit and stall window make of the time since the last look.
struct Watchdog {
    limit: Option<Duration>,
    stall: Option<Duration>,
    /// Time the run has been going, without the time the computer slept.
    awake: Duration,
}

impl Watchdog {
    /// One look at the clock: `gap` since the last look, `quiet` since the process last wrote a line.
    fn look(&mut self, gap: Duration, quiet: Duration) -> Watch {
        if gap >= ASLEEP_AFTER {
            return Watch::Slept(gap);
        }
        self.awake += gap;
        if self.limit.is_some_and(|limit| self.awake >= limit) {
            Watch::TimedOut
        } else if self.stall.is_some_and(|stall| quiet >= stall) {
            Watch::Stalled
        } else {
            Watch::Running
        }
    }
}

/// Resolves when the run should be stopped, for its time limit or for going quiet. Never, with neither.
async fn watch(limit: Option<Duration>, stall: Option<Duration>, last_line: &std::sync::Mutex<std::time::Instant>, who: &str) -> Watch {
    if limit.is_none() && stall.is_none() {
        return std::future::pending().await;
    }
    let mut dog = Watchdog { limit, stall, awake: Duration::ZERO };
    let mut looked = std::time::Instant::now();
    loop {
        tokio::time::sleep(WATCH_TICK).await;
        let now = std::time::Instant::now();
        let gap = now.saturating_duration_since(looked);
        looked = now;
        let quiet = now.saturating_duration_since(*last_line.lock().unwrap());
        match dog.look(gap, quiet) {
            Watch::Running => {}
            Watch::Slept(slept) => {
                *last_line.lock().unwrap() = now;
                log::info!("{who}: the computer was asleep for about {}; its stall and time limits don't count that", human_duration(slept));
            }
            stop => return stop,
        }
    }
}

/// How a CLI is named in the log: its task when it runs for one, then the program and its process id.
fn log_name(file: &str, pid: u32, task: Option<&str>) -> String {
    let name = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or(file);
    match task {
        Some(task) => format!("task {task}: {name} (pid {pid})"),
        None => format!("{name} (pid {pid})"),
    }
}

/// One line per CLI run, so the app log says how each agent process ended and what it last said on stderr.
fn log_outcome(who: &str, elapsed: Duration, opts: &SpawnLinesOptions, outcome: &SpawnOutcome) {
    let ran = human_duration(elapsed);
    let stderr = stderr_tail_line(&outcome.stderr).map(|t| format!("; stderr: {t}")).unwrap_or_default();
    if outcome.stalled {
        let quiet = opts.stall.map(human_duration).unwrap_or_default();
        log::warn!("{who} wrote nothing for {quiet} and was stopped after {ran}{stderr}");
    } else if outcome.timed_out {
        let limit = opts.timeout.map(human_duration).unwrap_or_default();
        log::warn!("{who} hit its {limit} run limit and was stopped after {ran}{stderr}");
    } else if outcome.aborted {
        log::info!("{who} was cancelled after {ran}");
    } else if outcome.code == Some(0) || outcome.killed {
        // `killed` here means Scarlet stopped it on purpose after a final line, such as a question.
        log::info!("{who} exited with code {:?} after {ran}", outcome.code);
    } else {
        log::warn!("{who} exited with code {:?} after {ran}{stderr}", outcome.code);
    }
}

/// Locate a CLI on PATH (PATHEXT-aware on Windows). `which` honours the given PATH.
pub fn find_on_path(name: &str, env: &HashMap<String, String>) -> Option<String> {
    let path = env_get(env, "PATH").map(std::ffi::OsString::from);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // A relative PATH component is resolved here; each runner later starts in its own task folder.
    let found = which::which_in(name, path, &cwd).ok()?;
    Some(cwd.join(found).to_string_lossy().into_owned())
}

pub fn resolve_cli(name: &str, env: &HashMap<String, String>) -> Result<String> {
    find_on_path(name, env).ok_or_else(|| anyhow!("{name} CLI not found on PATH"))
}

/// Run a short command (version checks, auth status) with a timeout and capture its output.
pub async fn exec_capture(file: &str, args: &[String], env: &HashMap<String, String>, timeout: Duration) -> ExecResult {
    let spec = spawn_spec(file, args, env);
    let mut cmd = build_command(&spec, None, env);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let name = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or(file);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("could not start {name}: {e}");
            return ExecResult { code: None, stdout: String::new(), stderr: e.to_string() };
        }
    };
    let pid = child.id();
    // The child is held here, past a timeout. Dropped with the timeout, it would be killed on the spot, and on
    // Windows `taskkill /T` then finds no tree under it to stop.
    let output = child.wait_with_output();
    tokio::pin!(output);
    match tokio::time::timeout(timeout, &mut output).await {
        Ok(Ok(out)) => {
            if out.status.code().is_none() {
                log::warn!("{name} ended without an exit code ({})", out.status);
            }
            ExecResult {
                code: out.status.code(),
                stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            }
        }
        Ok(Err(e)) => {
            log::warn!("{name} could not be waited for: {e}");
            ExecResult { code: None, stdout: String::new(), stderr: e.to_string() }
        }
        Err(_) => {
            log::warn!("{name} {} gave no answer in {} and was stopped", args.join(" "), human_duration(timeout));
            if let Some(pid) = pid {
                kill_tree(pid).await;
            }
            ExecResult { code: None, stdout: String::new(), stderr: "timed out".into() }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    #[test]
    fn recognises_only_the_process_it_noted_as_an_orphan() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        let note = format!("/bin/sleep\n{}", super::start_stamp(pid));
        assert!(super::still_runs(pid, &note));
        // The same id running another program, or started at another time, is someone else's process.
        assert!(!super::still_runs(pid, &format!("/usr/local/bin/claude\n{}", super::start_stamp(pid))));
        assert!(!super::still_runs(pid, "/bin/sleep\nMon Jan  1 00:00:00 2001"));
        assert!(!super::still_runs(pid, "/bin/sleep"));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!super::still_runs(pid, &note));
    }

    #[test]
    fn never_calls_a_process_an_orphan_on_its_name_alone() {
        // Cargo names the test binary after the crate, so this test's own process runs the program these notes name.
        // The second is what older Windows builds wrote.
        let program = env!("CARGO_CRATE_NAME");
        assert!(!super::still_runs(std::process::id(), program));
        assert!(!super::still_runs(std::process::id(), &format!("{program}\n")));
        // The start time is all they lack. Noted with it, the process is recognised.
        assert!(super::still_runs(std::process::id(), &format!("{program}\n{}", super::start_stamp(std::process::id()))));
        // Where the start time can't be read at all, a note without one still names nothing to stop.
        assert_eq!(super::noted_program(program, String::new), None);
        assert_eq!(super::noted_program(&format!("{program}\n"), String::new), None);
        assert_eq!(super::noted_program(&format!("/usr/local/bin/{program}\n1700000000"), || "1700000000".into()), Some(program));
    }

    #[test]
    fn finishes_only_a_stop_from_the_last_few_seconds_at_exit() {
        let now = std::time::Instant::now();
        let Some(earlier) = now.checked_sub(std::time::Duration::from_secs(60)) else { return };
        // A CLI stopped a minute ago has had its kill, and its process id may belong to another program by now.
        assert_eq!(super::still_stopping(vec![(11, earlier), (12, now)], now), vec![12]);
    }

    /// A process that stays up until it is killed, as a stand-in for a CLI or for another Scarlet. It has no part
    /// in the test's output, so a failed test isn't kept waiting for one that is still up.
    fn idler() -> (String, std::process::Child) {
        let node = find_on_path("node", &crate::util::env_map()).expect("node");
        let quiet = std::process::Stdio::null;
        let child = std::process::Command::new(&node).args(["-e", "setTimeout(() => {}, 120000)"]).stdin(quiet()).stdout(quiet()).stderr(quiet()).spawn().unwrap();
        (node, child)
    }

    #[test]
    fn reads_the_cli_and_its_scarlet_from_a_note() {
        assert_eq!(note_halves("claude\nMon"), ("claude\nMon".to_string(), None));
        assert_eq!(note_halves("claude\nMon\n42\n/Applications/Scarlet\nTue"), ("claude\nMon".to_string(), Some((42, "/Applications/Scarlet\nTue".to_string()))));
        // An empty start time keeps its line, so the Scarlet after it is still read.
        assert_eq!(note_halves("claude\n\n42\nScarlet.exe"), ("claude\n".to_string(), Some((42, "Scarlet.exe".to_string()))));
        // What a spawn writes reads back as this Scarlet, which is running.
        let (_, scarlet) = note_halves(&note_for("claude", std::process::id()));
        assert!(scarlet.is_some_and(|(pid, scarlet)| pid == std::process::id() && still_runs(pid, &scarlet)));
    }

    #[test]
    fn finishes_a_stop_at_exit_only_while_it_is_fresh_and_never_on_windows() {
        let now = std::time::Instant::now();
        let Some(earlier) = now.checked_sub(std::time::Duration::from_secs(60)) else { return };
        let (_, mut cli) = idler();
        // The id of a CLI stopped a minute ago may be another program's by now. Here it is this live process's.
        finish_stops(vec![(cli.id(), earlier)], now);
        assert!(cli.try_wait().unwrap().is_none());
        // A stop from this moment is finished off, except on Windows, where the stop itself ended the whole tree.
        finish_stops(vec![(cli.id(), now)], now);
        if cfg!(windows) {
            // A kill on Windows lands a moment after it is sent, so one would show by now.
            std::thread::sleep(Duration::from_millis(500));
            assert!(cli.try_wait().unwrap().is_none());
            cli.kill().unwrap();
        }
        assert!(!cli.wait().unwrap().success());
    }

    #[test]
    fn stops_an_orphan_and_leaves_a_cli_whose_scarlet_is_still_open() {
        let dir = tempfile::tempdir().unwrap();
        let (node, mut app) = idler();
        let (mut ours, mut kept, mut orphan) = (idler().1, idler().1, idler().1);
        let stamped = |child: &std::process::Child| format!("{node}\n{}", start_stamp(child.id()));
        let note = |pid: u32| dir.path().join(pid.to_string());
        // Two CLIs belong to a Scarlet that is still open: this process, noted as a spawn notes it, and another.
        let spawned = note_for(&node, ours.id());
        assert!(still_runs(ours.id(), &note_halves(&spawned).0));
        std::fs::write(note(ours.id()), spawned).unwrap();
        std::fs::write(note(kept.id()), format!("{}\n{}\n{}", stamped(&kept), app.id(), stamped(&app))).unwrap();
        // One was noted before Scarlet recorded itself, so nobody is left to ask. One note's id now belongs to
        // another process.
        std::fs::write(note(orphan.id()), stamped(&orphan)).unwrap();
        std::fs::write(note(app.id()), format!("{node}\nan earlier start")).unwrap();
        stop_noted(dir.path());
        // Killed, not left to run out.
        assert!(!orphan.wait().unwrap().success());
        assert!(ours.try_wait().unwrap().is_none() && kept.try_wait().unwrap().is_none() && app.try_wait().unwrap().is_none());
        assert!(note(ours.id()).exists() && note(kept.id()).exists() && !note(orphan.id()).exists() && !note(app.id()).exists());
        // Once that Scarlet has gone, its CLI is an orphan too.
        app.kill().unwrap();
        app.wait().unwrap();
        stop_noted(dir.path());
        assert!(!kept.wait().unwrap().success());
        assert!(ours.try_wait().unwrap().is_none() && note(ours.id()).exists() && !note(kept.id()).exists());
        ours.kill().unwrap();
        ours.wait().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn tells_a_windows_process_from_a_later_one_with_its_id() {
        let (node, mut child) = idler();
        let pid = child.id();
        let note = format!("{node}\n{}", start_stamp(pid));
        assert!(still_runs(pid, &note));
        // The same id and program started at another time is another process.
        assert!(!still_runs(pid, &format!("{node}\n1")));
        child.kill().unwrap();
        child.wait().unwrap();
        // Ended, though this test still holds its handle.
        assert!(!still_runs(pid, &note));
    }

    use super::*;

    #[test]
    fn quotes_cmd_exe_arguments_and_wraps_shims() {
        assert_eq!(quote_for_cmd("plain"), "plain");
        assert_eq!(quote_for_cmd("C:\\Program Files\\x"), "\"C:\\Program Files\\x\"");
        assert_eq!(quote_for_cmd("say \"hi\""), "\"say \"\"hi\"\"\"");
        let env = HashMap::new();
        let direct = spawn_spec("/usr/bin/claude", &["-p".to_string()], &env);
        assert_eq!(direct, SpawnSpec { file: "/usr/bin/claude".into(), args: vec!["-p".into()], verbatim: false });
        if cfg!(windows) {
            let shim = spawn_spec("C:\\npm\\codex.cmd", &["exec".into(), "--cd".into(), "C:\\my work".into()], &env);
            assert!(shim.verbatim);
            assert_eq!(&shim.args[..3], &["/d", "/s", "/c"]);
            assert_eq!(shim.args[3], "\"C:\\npm\\codex.cmd exec --cd \"C:\\my work\"\"");
        }
    }

    #[cfg(windows)]
    #[test]
    fn runs_npm_for_an_install_without_the_batch_interpreter() {
        let dir = tempfile::tempdir().unwrap();
        let npm = dir.path().join("node_modules").join("npm");
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::write(npm.join("package.json"), r#"{"bin":{"npm":"bin/npm-cli.js","npx":"bin/npx-cli.js"}}"#).unwrap();
        let env = crate::util::env_map();
        let shim = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        let spec = runner_spec(&shim("npm.cmd"), &["install".to_string()], &env).unwrap();
        let entry = npm.join("bin/npm-cli.js").to_string_lossy().into_owned();
        assert_eq!(spec, SpawnSpec { file: find_on_path("node.exe", &env).unwrap(), args: vec![entry, "install".into()], verbatim: false });
        // Any other batch launcher is still refused.
        assert!(runner_spec(&shim("other.cmd"), &[], &env).is_err());
    }

    #[test]
    fn finds_the_cli_a_pnpm_yarn_or_npm_shim_launches() {
        let dir = tempfile::tempdir().unwrap();
        let install = |root: &Path, package: &str, bin: &str| {
            let package = root.join(package);
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(package.join("package.json"), format!(r#"{{"bin":{bin}}}"#)).unwrap();
            package
        };
        let shim = |path: &Path, text: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
            path.to_path_buf()
        };
        let claude = "@anthropic-ai/claude-code";

        // pnpm keeps global packages under its home's global folder, and its shim names the script there.
        let pnpm = dir.path().join("pnpm");
        let package = install(&pnpm.join("global/5/node_modules"), claude, r#"{"claude":"cli.js"}"#);
        let pnpm_shim = shim(&pnpm.join("claude.CMD"), concat!(
            "@SETLOCAL\r\n",
            "@IF NOT DEFINED NODE_PATH (\r\n",
            "  @SET \"NODE_PATH=C:\\Users\\ed\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules\"\r\n",
            ") ELSE (\r\n",
            "  @SET \"NODE_PATH=%NODE_PATH%;C:\\Users\\ed\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules\"\r\n",
            ")\r\n",
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n",
            "  \"%~dp0\\node.exe\"  \"%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n",
            ") ELSE (\r\n",
            "  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n",
            "  node  \"%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n",
            ")\r\n",
        ));
        assert_eq!(npm_entry(&pnpm_shim, "claude", claude).unwrap(), package.join("cli.js"));

        // Yarn's shim calls the one in its global folder's .bin, beside the package.
        let yarn = dir.path().join("Yarn");
        let package = install(&yarn.join("Data/global/node_modules"), claude, r#""bin/claude.js""#);
        let yarn_shim = shim(&yarn.join("bin/claude.cmd"), "@\"%~dp0\\..\\Data\\global\\node_modules\\.bin\\claude.cmd\"   %*\r\n");
        assert_eq!(npm_entry(&yarn_shim, "claude", claude).unwrap(), package.join("bin/claude.js"));

        // npm keeps the package beside its shim, and a shim may also name the script by its full path.
        let npm = dir.path().join("npm");
        let package = install(&npm.join("node_modules"), "@openai/codex", r#"{"codex":"bin/codex.js"}"#);
        let npm_shim = shim(&npm.join("codex.cmd"), "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n");
        assert_eq!(npm_entry(&npm_shim, "codex", "@openai/codex").unwrap(), package.join("bin/codex.js"));
        let elsewhere = dir.path().join("tools");
        let package = install(&elsewhere.join("node_modules"), "@openai/codex", r#"{"codex":"bin/codex.js"}"#);
        let full = shim(&dir.path().join("bin/codex.cmd"), &format!("node \"{}\" %*\r\n", package.join("bin/codex.js").display()));
        assert_eq!(npm_entry(&full, "codex", "@openai/codex").unwrap(), package.join("bin/codex.js"));

        // A shim that names no copy of the package is refused with the advice Scarlet gives for any batch launcher.
        let other = shim(&dir.path().join("other/claude.cmd"), "@\"%~dp0\\somewhere\\else.exe\" %*\r\n");
        let error = format!("{:#}", npm_entry(&other, "claude", claude).unwrap_err());
        assert!(error.contains("use a native or npm agent CLI"), "{error}");
        // A shim that is gone is too.
        assert!(npm_entry(&dir.path().join("missing/claude.cmd"), "claude", claude).is_err());
    }

    #[test]
    fn finds_node_on_this_machine() {
        let env = crate::util::env_map();
        assert!(find_on_path("node", &env).is_some());
        assert!(find_on_path("definitely-not-a-real-cli-xyz", &env).is_none());
    }

    async fn run_node(script: &str, stall: Duration) -> (SpawnOutcome, Duration) {
        let env = crate::util::env_map();
        let node = find_on_path("node", &env).expect("node");
        let opts = SpawnLinesOptions { cwd: std::env::temp_dir(), env, stdin: None, cancel: CancellationToken::new(), timeout: None, stall: Some(stall), task: None };
        let started = std::time::Instant::now();
        let outcome = spawn_lines(&node, &["-e".to_string(), script.to_string()], opts, Box::new(|_| false)).await.unwrap();
        (outcome, started.elapsed())
    }

    #[cfg(unix)]
    #[test]
    fn launches_a_cli_from_a_relative_path_entry_inside_a_different_task_folder() {
        use std::os::unix::fs::PermissionsExt;
        let cwd = std::env::current_dir().unwrap();
        let tools = tempfile::tempdir_in(&cwd).unwrap();
        let task = tempfile::tempdir().unwrap();
        let cli = tools.path().join("scarlet-test-cli");
        std::fs::write(&cli, "#!/bin/sh\necho from-cli\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let relative = tools.path().strip_prefix(&cwd).unwrap().to_string_lossy().into_owned();
        let env = HashMap::from([("PATH".to_string(), relative)]);
        let found = resolve_cli("scarlet-test-cli", &env).unwrap();
        assert!(Path::new(&found).is_absolute(), "found {found}");
        let output = std::process::Command::new(found).current_dir(task.path()).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"from-cli\n");
    }

    #[tokio::test]
    async fn keeps_a_run_that_keeps_talking_past_the_stall_window() {
        // Talks every 200 ms for 4 s: longer than the 3 s stall window, but never quiet for it. The window also has
        // to cover node starting, which took more than a second on a busy Windows runner.
        let (outcome, _) = run_node("let n=0;const t=setInterval(()=>{console.log(n);if(++n===20)clearInterval(t)},200)", Duration::from_secs(3)).await;
        assert!(!outcome.stalled && !outcome.timed_out, "{outcome:?}");
        assert_eq!(outcome.code, Some(0));
    }

    #[tokio::test]
    async fn stops_a_run_that_goes_quiet() {
        let (outcome, elapsed) = run_node("console.log('started');setTimeout(()=>{},30000)", Duration::from_secs(1)).await;
        assert!(outcome.stalled && outcome.timed_out, "{outcome:?}");
        assert!(elapsed < Duration::from_secs(10), "stopped after {elapsed:?}");
        // A stop is recorded, so that quitting in the next few seconds still finishes it off.
        assert!(!STOPPED.lock().unwrap().is_empty(), "the stop was not recorded for exit");
    }

    #[cfg(not(windows))]
    #[test]
    fn hands_the_cli_its_prompt_without_waiting_for_its_start_time() {
        // One thread, and one more for blocking work: while the test keeps that one busy, no start time can be read.
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(1).build().unwrap();
        runtime.block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let notes = dir.path().join("notes");
            std::fs::create_dir(&notes).unwrap();
            PID_DIR.set(notes.clone()).expect("only this test sets the note directory");
            // No other test runs `sh` or `cat` through `spawn_lines`, so a note that names one is this test's.
            let noted = |program: &str| std::fs::read_dir(&notes).unwrap().flatten().any(|e| std::fs::read_to_string(e.path()).is_ok_and(|note| note.starts_with(&format!("{program}\n"))));
            let options = || SpawnLinesOptions { cwd: std::env::temp_dir(), env: crate::util::env_map(), stdin: Some("the prompt\n".into()), cancel: CancellationToken::new(), timeout: Some(Duration::from_secs(30)), stall: None, task: None };

            // The blocking thread is busy until the CLI has repeated its prompt, so the prompt can't have waited for a
            // start time read there. The CLI isn't noted by then either, so none was read on the way. It then waits
            // until it is noted, and repeats its note and the start time `ps` gives it for itself.
            let (heard_prompt, held) = std::sync::mpsc::channel::<()>();
            let hold = tokio::task::spawn_blocking(move || held.recv_timeout(Duration::from_secs(10)).is_ok());
            let args = ["-c", "cat; until [ -s \"$0/$$\" ]; do sleep 0.05; done; cat \"$0/$$\"; echo; ps -o lstart= -p $$", notes.to_str().unwrap()].map(String::from);
            let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
            let noted_early = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (heard, early, folder) = (lines.clone(), noted_early.clone(), notes.clone());
            let on_line = Box::new(move |line: &str| {
                heard.lock().unwrap().push(line.to_string());
                if line == "the prompt" {
                    let already = std::fs::read_dir(&folder).unwrap().flatten().any(|e| std::fs::read_to_string(e.path()).is_ok_and(|note| note.starts_with("/bin/sh\n")));
                    early.store(already, std::sync::atomic::Ordering::SeqCst);
                    let _ = heard_prompt.send(());
                }
                false
            });
            let mut run = Box::pin(spawn_lines("/bin/sh", &args, options(), on_line));
            // The first poll starts the CLI and queues its prompt and its note. Nothing queued has run yet, so a note
            // here would have been written on the way, ahead of the prompt.
            assert!(futures_util::poll!(&mut run).is_pending());
            assert!(!noted("/bin/sh"));
            let outcome = run.await.unwrap();
            assert!(hold.await.unwrap(), "the prompt waited for the start time");
            assert!(!noted_early.load(std::sync::atomic::Ordering::SeqCst), "the CLI was noted before it was handed its prompt");
            assert_eq!(outcome.code, Some(0), "{outcome:?}");
            {
                // The prompt, the note's five lines, and the start time the CLI read for itself: the note names this
                // program and this process, which is what the next launch looks for, then the Scarlet that ran it.
                let lines = lines.lock().unwrap();
                assert_eq!(lines.len(), 7, "{lines:?}");
                assert_eq!(lines[..2], ["the prompt", "/bin/sh"], "{lines:?}");
                assert_eq!(lines[2].trim(), lines[6].trim(), "noted with another start time: {lines:?}");
                assert_eq!(lines[3], std::process::id().to_string(), "{lines:?}");
            }
            assert!(!noted("/bin/sh"));

            // A CLI that has ended before its start time is read leaves no note, however late the read comes back.
            // On this one thread a cancelled task never runs again, so this can't tell whether the cancel is also
            // waited for. That only matters when the note is being written on another worker at that moment.
            let (ended, held) = std::sync::mpsc::channel::<()>();
            let hold = tokio::task::spawn_blocking(move || held.recv_timeout(Duration::from_secs(10)).is_ok());
            let outcome = spawn_lines("/bin/cat", &[], options(), Box::new(|_| false)).await.unwrap();
            assert_eq!(outcome.code, Some(0), "{outcome:?}");
            ended.send(()).unwrap();
            assert!(hold.await.unwrap());
            // The blocking thread reads the start time next and then runs this, so by now the read is done.
            tokio::task::spawn_blocking(|| ()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!noted("/bin/cat"));
            // Runs in other tests note themselves here too. Renamed, the folder takes no more notes and can be removed.
            std::fs::rename(&notes, dir.path().join("closed")).unwrap();
        });
    }

    /// Run a node script through `spawn_lines` under a task id, and return what it wrote line by line.
    async fn run_script(script: &str, task: &str, change: impl FnOnce(&mut SpawnLinesOptions), stop_on: Option<&'static str>) -> (SpawnOutcome, Vec<String>, Duration) {
        crate::util::test_log::capture();
        let env = crate::util::env_map();
        let node = find_on_path("node", &env).expect("node");
        let mut opts = SpawnLinesOptions { cwd: std::env::temp_dir(), env, stdin: None, cancel: CancellationToken::new(), timeout: None, stall: None, task: Some(task.into()) };
        change(&mut opts);
        let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
        let heard = lines.clone();
        let on_line = Box::new(move |line: &str| {
            heard.lock().unwrap().push(line.to_string());
            stop_on == Some(line)
        });
        let started = std::time::Instant::now();
        let outcome = spawn_lines(&node, &["-e".to_string(), script.to_string()], opts, on_line).await.unwrap();
        let lines = lines.lock().unwrap().clone();
        (outcome, lines, started.elapsed())
    }

    const WAITS: &str = "console.log('started');setTimeout(()=>{},30000)";

    #[tokio::test]
    async fn hands_over_whole_lines_without_line_endings_or_blanks() {
        let (outcome, lines, _) = run_script(r#"process.stdout.write('first\r\n\r\n   \n{"type":"x"}\nlast, with no newline')"#, "tsk_lines", |_| {}, None).await;
        assert_eq!(lines, ["first", r#"{"type":"x"}"#, "last, with no newline"]);
        assert_eq!((outcome.code, outcome.killed, outcome.timed_out, outcome.aborted), (Some(0), false, false, false));
        // Its line in the log is under the task's id, at INFO for a clean exit.
        let (level, line) = crate::util::test_log::find(&["task tsk_lines: node (pid ", "exited with code Some(0)"]).expect("no log line for the run");
        assert_eq!(level, log::Level::Info, "{line}");
    }

    #[test]
    fn a_computer_that_slept_neither_stalls_a_run_nor_spends_its_time_limit() {
        let secs = Duration::from_secs;
        let mut dog = Watchdog { limit: Some(secs(3600)), stall: Some(secs(600)), awake: Duration::ZERO };
        // Ticking along while the CLI is quiet: a stall only once it has been quiet for the whole window.
        assert_eq!(dog.look(secs(1), secs(599)), Watch::Running);
        assert_eq!(dog.look(secs(1), secs(600)), Watch::Stalled);
        // Windows counts on through a suspend, so the first tick after waking comes hours late and the last line
        // looks hours old. That is sleep: the stall clock starts again, and none of it counts toward the limit.
        let mut dog = Watchdog { limit: Some(secs(3600)), stall: Some(secs(600)), awake: secs(3590) };
        assert_eq!(dog.look(secs(2 * 3600), secs(2 * 3600 + 30)), Watch::Slept(secs(2 * 3600)));
        assert_eq!(dog.awake, secs(3590));
        assert_eq!(dog.look(secs(1), secs(1)), Watch::Running);
        // The limit still comes, after the time the computer was awake.
        for _ in 0..8 {
            assert_eq!(dog.look(secs(1), secs(1)), Watch::Running);
        }
        assert_eq!(dog.look(secs(1), secs(1)), Watch::TimedOut);
        // A tick a few seconds late is a busy machine, not sleep: it counts, and a quiet CLI still stalls.
        let mut dog = Watchdog { limit: None, stall: Some(secs(10)), awake: Duration::ZERO };
        assert_eq!(dog.look(secs(5), secs(5)), Watch::Running);
        assert_eq!(dog.look(secs(6), secs(11)), Watch::Stalled);
        assert_eq!(dog.awake, secs(11));
    }

    #[tokio::test]
    async fn reads_on_past_a_line_that_is_not_utf8() {
        // cmd.exe on a non-English Windows writes its messages in the console's code page. One such line is passed on
        // with the unknown byte replaced, and the lines after it still arrive.
        let script = "process.stdout.write(Buffer.from([0x41,0x63,0x63,0xe8,0x73,0x0d,0x0a]));console.log('after')";
        let (outcome, lines, _) = run_script(script, "tsk_bytes", |_| {}, None).await;
        assert_eq!(lines, ["Acc\u{fffd}s", "after"]);
        assert_eq!(outcome.code, Some(0));
    }

    #[tokio::test]
    async fn stops_a_cancelled_run_at_once() {
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        // Cancelled a moment after it starts, with no limit that could stop it instead.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stop.cancel();
        });
        let (outcome, _, elapsed) = run_script(WAITS, "tsk_cancel", |opts| opts.cancel = cancel, None).await;
        assert!(outcome.aborted && outcome.killed && !outcome.timed_out && !outcome.stalled, "{outcome:?}");
        assert!(elapsed < Duration::from_secs(10), "stopped after {elapsed:?}");
        let (level, _) = crate::util::test_log::find(&["task tsk_cancel: node", "was cancelled after"]).expect("no log line for the cancel");
        assert_eq!(level, log::Level::Info);
    }

    #[tokio::test]
    async fn stops_a_run_at_its_time_limit_however_busy_it_is() {
        // It talks the whole time, so only the cap can stop it: a stall window would not.
        let chatty = "setInterval(()=>console.log('working'),100)";
        // The cap also has to cover node starting and speaking, which takes seconds on a busy machine.
        let (outcome, lines, elapsed) = run_script(chatty, "tsk_limit", |opts| (opts.timeout, opts.stall) = (Some(Duration::from_secs(8)), Some(Duration::from_secs(60))), None).await;
        assert!(outcome.timed_out && outcome.killed && !outcome.stalled && !outcome.aborted, "{outcome:?}");
        assert!(elapsed >= Duration::from_secs(8) && elapsed < Duration::from_secs(18), "stopped after {elapsed:?}");
        assert!(!lines.is_empty());
        let (level, line) = crate::util::test_log::find(&["task tsk_limit: node", "hit its 8s run limit"]).expect("no log line for the limit");
        assert_eq!(level, log::Level::Warn, "{line}");
    }

    #[tokio::test]
    async fn stops_the_process_when_a_line_asks_for_it() {
        // The line that ends a run, such as a posted question: the process is stopped, not waited for.
        let (outcome, lines, elapsed) = run_script("console.log('ask');setTimeout(()=>console.log('late'),30000)", "tsk_ask", |_| {}, Some("ask")).await;
        assert!(outcome.killed && !outcome.aborted && !outcome.timed_out, "{outcome:?}");
        assert!(elapsed < Duration::from_secs(10), "stopped after {elapsed:?}");
        assert_eq!(lines, ["ask"]);
        // A stop Scarlet chose is not a failure in the log.
        let (level, line) = crate::util::test_log::find(&["task tsk_ask: node", "exited with code"]).expect("no log line for the stop");
        assert_eq!(level, log::Level::Info, "{line}");
    }

    #[tokio::test]
    async fn keeps_the_end_of_a_long_stderr_and_logs_a_failed_exit() {
        // 200 KB of stderr, then the line that says what went wrong.
        let script = "process.stderr.write('é'.repeat(100000));process.stderr.write('\\nfatal: out of credits\\n',()=>process.exit(3))";
        let (outcome, _, _) = run_script(script, "tsk_stderr", |_| {}, None).await;
        assert_eq!(outcome.code, Some(3));
        assert!(outcome.stderr.len() <= 64_000, "kept {} bytes", outcome.stderr.len());
        assert!(outcome.stderr.trim_end().ends_with("fatal: out of credits"));
        let (level, line) = crate::util::test_log::find(&["task tsk_stderr: node", "exited with code Some(3)"]).expect("no log line for the failure");
        assert_eq!(level, log::Level::Warn);
        assert!(line.ends_with("fatal: out of credits"), "{line}");
    }

    #[tokio::test]
    async fn reports_a_program_that_cannot_be_started() {
        let opts = SpawnLinesOptions { cwd: std::env::temp_dir(), env: crate::util::env_map(), stdin: None, cancel: CancellationToken::new(), timeout: None, stall: None, task: None };
        let missing = std::env::temp_dir().join("scarlet-no-such-cli").to_string_lossy().into_owned();
        let error = spawn_lines(&missing, &[], opts, Box::new(|_| false)).await.unwrap_err();
        assert!(format!("{error:#}").starts_with(&format!("spawn {missing}")), "{error:#}");
    }

    #[tokio::test]
    async fn captures_a_short_command_and_gives_up_on_one_that_hangs() {
        crate::util::test_log::capture();
        let env = crate::util::env_map();
        let node = find_on_path("node", &env).expect("node");
        let script = |script: &str| ["-e".to_string(), script.to_string()];
        let said = exec_capture(&node, &script("console.log('2.1.3');console.error('warned');process.exit(4)"), &env, Duration::from_secs(30)).await;
        assert_eq!((said.code, said.stdout.trim(), said.stderr.trim()), (Some(4), "2.1.3", "warned"));

        // Asked for its version, it prints its process id and never answers.
        let started = std::time::Instant::now();
        let hung = exec_capture(&node, &script("console.log(process.pid);setTimeout(()=>{},60000)"), &env, Duration::from_secs(2)).await;
        assert_eq!((hung.code, hung.stdout.as_str(), hung.stderr.as_str()), (None, "", "timed out"));
        assert!(started.elapsed() < Duration::from_secs(12), "gave up after {:?}", started.elapsed());
        let (level, _) = crate::util::test_log::find(&["node -e console.log(process.pid)", "gave no answer in 2s"]).expect("no log line for the probe");
        assert_eq!(level, log::Level::Warn);

        // A program that isn't there has no exit code, and the system's reason.
        let missing = std::env::temp_dir().join("scarlet-no-such-probe").to_string_lossy().into_owned();
        let none = exec_capture(&missing, &[], &env, Duration::from_secs(5)).await;
        assert!(none.code.is_none() && !none.stderr.is_empty() && none.stderr != "timed out", "{none:?}");
        assert!(crate::util::test_log::find(&["could not start scarlet-no-such-probe"]).is_some());

        // One ended by a signal has no exit code either, and the log says what ended it.
        #[cfg(unix)]
        {
            let ended = exec_capture("/bin/sh", &["-c".to_string(), "kill -9 $$".to_string()], &env, Duration::from_secs(30)).await;
            assert_eq!(ended.code, None);
            let (level, _) = crate::util::test_log::find(&["sh ended without an exit code", "signal: 9"]).expect("no log line for the signal");
            assert_eq!(level, log::Level::Warn);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaves_nothing_running_under_a_probe_that_hung() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        // A CLI behind a launcher: the shell starts a child, and both note their process ids. The probe waits long
        // enough for both to have started on a busy machine.
        let script = format!("echo $$ >> '{0}'; sh -c 'echo $$ >> \"{0}\"; sleep 60' & wait", pids.display());
        let hung = exec_capture("/bin/sh", &["-c".to_string(), script], &crate::util::env_map(), Duration::from_secs(8)).await;
        assert_eq!((hung.code, hung.stderr.as_str()), (None, "timed out"));
        let noted: Vec<String> = std::fs::read_to_string(&pids).unwrap().lines().map(String::from).collect();
        assert_eq!(noted.len(), 2, "{noted:?}");
        // Both are gone within a moment: the launcher and what it started.
        let alive = |pid: &str| std::process::Command::new("kill").args(["-0", pid]).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while noted.iter().any(|pid| alive(pid)) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(noted.iter().all(|pid| !alive(pid)), "still running: {noted:?}");
    }

    #[test]
    fn names_a_cli_in_the_log_by_its_task_program_and_process() {
        assert_eq!(log_name("/usr/local/bin/claude", 41, Some("tsk_1")), "task tsk_1: claude (pid 41)");
        assert_eq!(log_name("C:\\npm\\codex.cmd", 7, None), if cfg!(windows) { "codex (pid 7)" } else { "C:\\npm\\codex (pid 7)" });
        assert_eq!(log_name("npm", 9, None), "npm (pid 9)");
    }
}
