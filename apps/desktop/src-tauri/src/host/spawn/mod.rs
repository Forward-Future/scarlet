//! Process helpers shared by the runners (port of apps/agent/src/runners/spawn.ts):
//! resolve the CLI, spawn it (through cmd.exe for Windows .cmd/.bat shims),
//! stream stdout line by line, enforce a timeout, honour cancellation and stop
//! the whole process tree on request.

pub(super) mod command;
#[cfg(test)]
mod tests;
mod watchdog;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::util::{env_get, human_duration, kill_tree, lossy_lines, stderr_tail_line};

pub use super::process_guard::{kill_stopped_now, stop_orphans};
pub(crate) use super::process_guard::{kill_group_now, still_runs, this_scarlet};
use super::process_guard::{note_for, pid_note, record_stopped};
use command::{build_command, runner_spec, spawn_spec};
use watchdog::{watch, Watch};

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

/// Spawn and stream. Resolves when the process has exited and all stdout has been handled.
pub async fn spawn_lines(file: &str, args: &[String], opts: SpawnLinesOptions, on_line: LineHandler) -> Result<SpawnOutcome> {
    let input = ProcessInput::Once(opts.stdin.clone());
    spawn_stream(file, args, opts, input, Duration::from_millis(250), None, on_line).await
}

/// Keep stdin open for a line protocol. Dropping the last sender closes it.
pub async fn spawn_interactive(
    file: &str, args: &[String], opts: SpawnLinesOptions, input: mpsc::UnboundedReceiver<String>,
    stop_grace: Duration, interrupt: InterruptHandler, on_line: LineHandler,
) -> Result<SpawnOutcome> {
    spawn_stream(file, args, opts, ProcessInput::Stream(input), stop_grace, Some(interrupt), on_line).await
}

/// Start a protocol-level interrupt. Return whether it could be sent and needs a grace period.
pub type InterruptHandler = Box<dyn FnOnce() -> bool + Send>;

enum ProcessInput {
    Once(Option<String>),
    Stream(mpsc::UnboundedReceiver<String>),
}

async fn spawn_stream(
    file: &str, args: &[String], opts: SpawnLinesOptions, input: ProcessInput,
    stop_grace: Duration, interrupt: Option<InterruptHandler>, mut on_line: LineHandler,
) -> Result<SpawnOutcome> {
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

    let stdin_task = child.stdin.take().map(|mut stdin| {
        let who = who.clone();
        tokio::spawn(async move {
            match input {
                ProcessInput::Once(Some(prompt)) => {
                    if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
                        log::warn!("{who} did not take its prompt: {e}");
                    }
                }
                ProcessInput::Once(None) => {}
                ProcessInput::Stream(mut lines) => {
                    while let Some(line) = lines.recv().await {
                        if let Err(e) = stdin.write_all(line.as_bytes()).await {
                            log::warn!("{who} stopped accepting input: {e}");
                            break;
                        }
                    }
                }
            }
            let _ = stdin.shutdown().await;
        })
    });

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

    // Every stdout line is a sign of life for `stall`.
    let stop_requested = CancellationToken::new();
    let last_line = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    let stdout_task = child.stdout.take().map(|out| {
        let stop_requested = stop_requested.clone();
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
                    stop_requested.cancel();
                }
            }
        })
    });

    let mut outcome = SpawnOutcome::default();
    let status = tokio::select! {
        s = child.wait() => s,
        _ = opts.cancel.cancelled() => {
            outcome.aborted = true;
            stop_child(&mut child, pid, &mut outcome, stop_grace, interrupt).await
        }
        verdict = watch(opts.timeout, opts.stall, &last_line, &who) => {
            outcome.timed_out = true;
            outcome.stalled = verdict == Watch::Stalled;
            stop_child(&mut child, pid, &mut outcome, stop_grace, interrupt).await
        }
        _ = async {
            stop_requested.cancelled().await;
            tokio::time::sleep(stop_grace).await;
        } => {
            outcome.killed = true;
            kill_tree(pid).await;
            child.wait().await
        }
    };
    outcome.code = status.ok().and_then(|s| s.code());
    if let Some(task) = stdin_task {
        task.abort();
    }
    if outcome.killed {
        record_stopped(pid);
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
    for mut task in [stdout_task, stderr_task].into_iter().flatten() {
        if tokio::time::timeout(Duration::from_secs(5), &mut task).await.is_err() {
            task.abort();
        }
    }
    outcome.stderr = stderr_buf.lock().await.clone();
    log_outcome(&who, started.elapsed(), &opts, &outcome);
    Ok(outcome)
}

async fn stop_child(
    child: &mut tokio::process::Child, pid: u32, outcome: &mut SpawnOutcome,
    grace: Duration, interrupt: Option<InterruptHandler>,
) -> std::io::Result<std::process::ExitStatus> {
    if interrupt.is_some_and(|interrupt| interrupt()) {
        if let Ok(status) = tokio::time::timeout(grace, child.wait()).await {
            return status;
        }
    }
    outcome.killed = true;
    kill_tree(pid).await;
    child.wait().await
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

/// The copy of a CLI a run starts: the first on PATH that Scarlet can launch. A Windows batch shim Scarlet can't see
/// through to its program (`runner_spec`) is passed over for the next copy, so the assistant check and the runs agree
/// on one program instead of the check finding a shim every run then fails on.
pub fn resolve_cli(name: &str, env: &HashMap<String, String>) -> Result<String> {
    let path = env_get(env, "PATH").map(std::ffi::OsString::from);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidates: Vec<String> = which::which_in_all(name, path, &cwd)
        .map(|found| found.map(|file| cwd.join(file).to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    first_runnable(name, candidates, |file| runner_spec(file, &[], env).map(|_| ()))
}

/// The first candidate `launchable` accepts. None accepted: why the first was refused, or not found when none exist.
fn first_runnable(name: &str, candidates: impl IntoIterator<Item = String>, launchable: impl Fn(&str) -> Result<()>) -> Result<String> {
    let mut refused = None;
    for file in candidates {
        match launchable(&file) {
            Ok(()) => return Ok(file),
            Err(e) => {
                log::info!("{name}: passed over {file}: {e:#}");
                refused.get_or_insert(e);
            }
        }
    }
    Err(refused.unwrap_or_else(|| anyhow!("{name} CLI not found on PATH")))
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
