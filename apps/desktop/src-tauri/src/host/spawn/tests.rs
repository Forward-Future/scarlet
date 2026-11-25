use super::*;
use super::command::{npm_entry, quote_for_cmd, SpawnSpec};
use super::watchdog::Watchdog;
use crate::host::process_guard::{PID_DIR, STOPPED};

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

#[test]
fn passes_over_a_copy_it_cannot_launch_for_the_next_one_on_path() {
    // A Scoop or Volta shim Scarlet can't see through, ahead of a native install further down PATH.
    let launchable = |file: &str| -> Result<()> {
        if file.ends_with(".cmd") { anyhow::bail!("{file} runs no copy of @anthropic-ai/claude-code Scarlet can find") }
        Ok(())
    };
    let shim = "C:\\scoop\\shims\\claude.cmd".to_string();
    let native = "C:\\Users\\ed\\.local\\bin\\claude.exe".to_string();
    assert_eq!(first_runnable("claude", [shim.clone(), native.clone()], launchable).unwrap(), native);
    // Only the shim: the run and the assistant check both get the reason, not a bare "not found".
    let refused = first_runnable("claude", [shim], launchable).unwrap_err();
    assert!(format!("{refused:#}").contains("runs no copy of"), "{refused:#}");
    let missing = first_runnable("claude", Vec::<String>::new(), launchable).unwrap_err();
    assert_eq!(missing.to_string(), "claude CLI not found on PATH");
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
