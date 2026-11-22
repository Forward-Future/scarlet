//! Orphan-process guard for spawned agent CLIs: records each CLI's program,
//! start time, and owning Scarlet process so crashes never leave orphaned CLIs
//! running, and finishes recent graceful stops at app exit.

use std::path::{Path, PathBuf};

use crate::util::KILL_AFTER;

/// Where each running agent CLI's process id is noted, so the next launch can stop one this launch never got to.
pub(super) static PID_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
/// CLIs told to stop in this launch, and when. For a few seconds after a stop, members of a CLI's process group
/// may still be alive.
pub(super) static STOPPED: std::sync::Mutex<Vec<(u32, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

pub(super) fn pid_note(pid: u32) -> Option<PathBuf> {
    PID_DIR.get().map(|dir| dir.join(pid.to_string()))
}

pub(super) fn record_stopped(pid: u32) {
    let now = std::time::Instant::now();
    let mut stopped = STOPPED.lock().unwrap();
    stopped.retain(|(_, at)| now.saturating_duration_since(*at) < KILL_AFTER);
    stopped.push((pid, now));
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
pub(super) fn note_for(program: &str, pid: u32) -> String {
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
/// process lives, so it is read once there. `ps` prints a start time in the time
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

/// When the process started, as a file time: the count PowerShell's `StartTime.ToFileTimeUtc()` printed for older
/// notes, so those still compare. Empty when it is gone or can't be read.
#[cfg(windows)]
fn start_stamp(pid: u32) -> String {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: the handle is checked before use and closed before returning; the out-parameters are locals.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return String::new();
        }
        let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let mut code = 0u32;
        // A process that has ended still opens while anyone holds a handle to it, but it is gone.
        let running = GetExitCodeProcess(process, &mut code) != 0 && code == STILL_ACTIVE as u32;
        let read = running && GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0;
        CloseHandle(process);
        if !read {
            return String::new();
        }
        ((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)).to_string()
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use crate::host::spawn::find_on_path;

    #[cfg(not(windows))]
    #[test]
    fn recognises_only_the_process_it_noted_as_an_orphan() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        let note = format!("/bin/sleep\n{}", start_stamp(pid));
        assert!(still_runs(pid, &note));
        // The same id running another program, or started at another time, is someone else's process.
        assert!(!still_runs(pid, &format!("/usr/local/bin/claude\n{}", start_stamp(pid))));
        assert!(!still_runs(pid, "/bin/sleep\nMon Jan  1 00:00:00 2001"));
        assert!(!still_runs(pid, "/bin/sleep"));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!still_runs(pid, &note));
    }

    #[test]
    fn never_calls_a_process_an_orphan_on_its_name_alone() {
        // Cargo names the test binary after the crate, so this test's own process runs the program these notes name.
        // The second is what older Windows builds wrote.
        let program = env!("CARGO_CRATE_NAME");
        assert!(!still_runs(std::process::id(), program));
        assert!(!still_runs(std::process::id(), &format!("{program}\n")));
        // The start time is all they lack. Noted with it, the process is recognised.
        assert!(still_runs(std::process::id(), &format!("{program}\n{}", start_stamp(std::process::id()))));
        // Where the start time can't be read at all, a note without one still names nothing to stop.
        assert_eq!(noted_program(program, String::new), None);
        assert_eq!(noted_program(&format!("{program}\n"), String::new), None);
        assert_eq!(noted_program(&format!("/usr/local/bin/{program}\n1700000000"), || "1700000000".into()), Some(program));
    }

    #[test]
    fn finishes_only_a_stop_from_the_last_few_seconds_at_exit() {
        let now = std::time::Instant::now();
        let Some(earlier) = now.checked_sub(Duration::from_secs(60)) else { return };
        // A CLI stopped a minute ago has had its kill, and its process id may belong to another program by now.
        assert_eq!(still_stopping(vec![(11, earlier), (12, now)], now), vec![12]);
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
        let Some(earlier) = now.checked_sub(Duration::from_secs(60)) else { return };
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
}
