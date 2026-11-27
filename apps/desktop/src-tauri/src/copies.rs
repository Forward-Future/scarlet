//! One log every copy of Scarlet on this computer shares: the regular app, a review or test build, the demo and
//! development builds. Each copy keeps its own log under its own identifier, and a temporary copy's log can be gone
//! with it, so "where did my message go" has no answer from the regular log alone. Here each copy says when it
//! starts and stops, under which identifier, with its data and its own log; and the `[request]` lines its window
//! writes (a message sent, ignored, refused or failed, and the request it made) are copied here too. Never the
//! words of a message: those lines carry only lengths, ids and kinds.
//!
//! The file is `scarlet-copies.log` in the regular app's log folder, kept to about a megabyte with one older file.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The regular app's identifier, whose log folder holds the shared file.
pub const REGULAR_IDENTIFIER: &str = "com.forwardfuture.scarlet";
const FILE_NAME: &str = "scarlet-copies.log";
const MAX_BYTES: u64 = 1_000_000;

struct Copy {
    identifier: String,
    file: PathBuf,
}

static COPY: OnceLock<Copy> = OnceLock::new();

/// The shared file for a copy whose own log folder is `log_dir`: the same place with the regular app's identifier in
/// place of this copy's (`~/Library/Logs/<id>` on macOS, `…/<id>/logs` on Windows and Linux).
pub fn shared_file(log_dir: &Path, identifier: &str) -> PathBuf {
    let mut swapped = false;
    let dir: PathBuf = log_dir
        .components()
        .map(|part| match part {
            Component::Normal(name) if !swapped && name == identifier => {
                swapped = true;
                std::ffi::OsStr::new(REGULAR_IDENTIFIER).to_owned()
            }
            other => other.as_os_str().to_owned(),
        })
        .collect();
    dir.join(FILE_NAME)
}

/// UTC to the millisecond, as the other logs write it.
fn timestamp(now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs() as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

fn append(file: &Path, line: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        if let Err(e) = std::fs::rename(file, file.with_extension("1.log")) {
            // Once per launch: every later line would try, and fail, again.
            static NOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !NOTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                log::warn!("couldn't rotate the shared copies log {}: {e}", file.display());
            }
        }
    }
    let mut out = OpenOptions::new().create(true).append(true).open(file)?;
    out.write_all(line.as_bytes())
}

fn write(copy: &Copy, what: &str) {
    let line = format!("{} id={} pid={} {what}\n", timestamp(SystemTime::now()), copy.identifier, std::process::id());
    if let Err(e) = append(&copy.file, &line) {
        log::warn!("couldn't write to the shared copies log {}: {e}", copy.file.display());
    }
}

/// Say this copy started, with what tells it apart from the others. Later lines go to the same file.
pub fn started(identifier: &str, log_dir: &Path, data_dir: &Path, version: &str, kind: &str) {
    let copy = Copy { identifier: identifier.to_string(), file: shared_file(log_dir, identifier) };
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    write(
        &copy,
        &format!("start version={version} build={kind} exe={exe:?} data={:?} log={:?}", data_dir.display().to_string(), log_dir.display().to_string()),
    );
    log::info!("shared copies log: {}", copy.file.display());
    let _ = COPY.set(copy);
}

/// Say this copy is closing.
pub fn stopped() {
    if let Some(copy) = COPY.get() {
        write(copy, "exit");
    }
}

/// Copy a `[request]` line from this copy's window into the shared log.
pub fn request_line(line: &str) {
    if let Some(copy) = COPY.get() {
        write(copy, line);
    }
}

/// The renderer lines that belong in the shared log too.
pub fn is_request_line(line: &str) -> bool {
    line.starts_with("[request] ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_shares_the_regular_apps_log_folder() {
        let mac = shared_file(Path::new("/Users/me/Library/Logs/com.forwardfuture.scarlet.review"), "com.forwardfuture.scarlet.review");
        assert_eq!(mac, Path::new("/Users/me/Library/Logs/com.forwardfuture.scarlet/scarlet-copies.log"));
        let linux = shared_file(Path::new("/home/me/.local/share/com.forwardfuture.scarlet.demo/logs"), "com.forwardfuture.scarlet.demo");
        assert_eq!(linux, Path::new("/home/me/.local/share/com.forwardfuture.scarlet/logs/scarlet-copies.log"));
        let regular = shared_file(Path::new("/Users/me/Library/Logs/com.forwardfuture.scarlet"), REGULAR_IDENTIFIER);
        assert_eq!(regular, Path::new("/Users/me/Library/Logs/com.forwardfuture.scarlet/scarlet-copies.log"));
        // A folder that doesn't name the copy keeps the file beside its own log.
        let other = shared_file(Path::new("/tmp/shot/logs"), "com.forwardfuture.scarlet.shot");
        assert_eq!(other, Path::new("/tmp/shot/logs/scarlet-copies.log"));
    }

    #[test]
    fn writes_utc_to_the_millisecond() {
        let at = UNIX_EPOCH + std::time::Duration::from_millis(1_795_565_603_123);
        assert_eq!(timestamp(at), "2026-11-25T00:13:23.123Z");
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let leap = UNIX_EPOCH + std::time::Duration::from_secs(951_782_400);
        assert_eq!(timestamp(leap), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn appends_and_keeps_one_older_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join(FILE_NAME);
        append(&file, "one\n").unwrap();
        append(&file, "two\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\ntwo\n");
        std::fs::write(&file, vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();
        append(&file, "three\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "three\n");
        assert!(file.with_extension("1.log").exists());
    }

    #[test]
    fn only_request_lines_are_shared() {
        assert!(is_request_line("[request] 00:13:26.908 +0ms send how=typed"));
        assert!(!is_request_line("[action] 00:13:26.908 +0ms click"));
    }
}
