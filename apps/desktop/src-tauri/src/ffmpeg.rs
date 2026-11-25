//! Checksum-verified in-app installation of FFmpeg and FFprobe so editors never need to open a terminal.
//! Public installers do not bundle FFmpeg; instead Scarlet downloads the same pinned upstream archives
//! used by `scripts/Install-Scarlet-FFmpeg-macOS.sh` and `scripts/fetch-ffmpeg.mjs` into `~/.local/bin`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::host::spawn::find_on_path;
use crate::util::child_env;

#[derive(Debug, Clone, Copy)]
struct PinnedArchive {
    url: &'static str,
    sha256: &'static str,
}

const MACOS_ARM64_ARCHIVES: &[PinnedArchive] = &[
    PinnedArchive {
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
    },
    PinnedArchive {
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
        sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
    },
];

const MACOS_X86_64_ARCHIVES: &[PinnedArchive] = &[
    PinnedArchive {
        url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
        sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
    },
    PinnedArchive {
        url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffprobe.zip",
        sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
    },
];

const WINDOWS_X86_64_ARCHIVES: &[PinnedArchive] = &[PinnedArchive {
    url: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip",
    sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
}];

static INSTALL_LOCK: Mutex<()> = Mutex::const_new(());

fn platform_archives() -> Option<&'static [PinnedArchive]> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some(MACOS_ARM64_ARCHIVES),
        ("macos", "x86_64") => Some(MACOS_X86_64_ARCHIVES),
        ("windows", "x86_64") => Some(WINDOWS_X86_64_ARCHIVES),
        _ => None,
    }
}

pub fn install_dir(home: &Path) -> PathBuf {
    home.join(".local").join("bin")
}

fn exe_name(tool: &str) -> String {
    if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    }
}

fn is_usable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

pub fn find_tool(tool: &str, home: &Path, resources: Option<&Path>) -> Option<PathBuf> {
    let file = exe_name(tool);
    // 1. Explicit environment override
    let env_keys = match tool {
        "ffmpeg" => ["SCARLET_FFMPEG", "FFMPEG_PATH"],
        "ffprobe" => ["SCARLET_FFPROBE", "FFPROBE_PATH"],
        _ => ["", ""],
    };
    for key in env_keys {
        if key.is_empty() {
            continue;
        }
        if let Ok(val) = std::env::var(key) {
            let p = PathBuf::from(val);
            if is_usable_file(&p) {
                return Some(p);
            }
        }
    }
    // 2. Bundled dev/local tools in resource_dir/bin
    if let Some(res) = resources {
        let candidate = res.join("bin").join(&file);
        if is_usable_file(&candidate) {
            return Some(candidate);
        }
    }
    // 3. Scarlet's own in-app install directory (~/.local/bin)
    let local = install_dir(home).join(&file);
    if is_usable_file(&local) {
        return Some(local);
    }
    // 4. Anything already installed on the user's augmented PATH
    let env = child_env(home);
    find_on_path(tool, &env)
        .map(PathBuf::from)
        .filter(|p| is_usable_file(p))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub installed: bool,
    pub can_install: bool,
    pub install_dir: String,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
}

pub fn status(home: &Path, resources: Option<&Path>) -> FfmpegStatus {
    let ffmpeg_path = find_tool("ffmpeg", home, resources);
    let ffprobe_path = find_tool("ffprobe", home, resources);
    FfmpegStatus {
        installed: ffmpeg_path.is_some() && ffprobe_path.is_some(),
        can_install: platform_archives().is_some(),
        install_dir: install_dir(home).to_string_lossy().into_owned(),
        ffmpeg_path: ffmpeg_path.map(|p| p.to_string_lossy().into_owned()),
        ffprobe_path: ffprobe_path.map(|p| p.to_string_lossy().into_owned()),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual != expected {
        return Err(format!("FFmpeg download checksum did not match (got {actual})."));
    }
    Ok(())
}

fn find_file_recursive(dir: &Path, target_name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(hit) = find_file_recursive(&path, target_name) {
                return Some(hit);
            }
        } else if path.file_name().and_then(|n| n.to_str()) == Some(target_name) {
            return Some(path);
        }
    }
    None
}

async fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dest)
        .await
        .map_err(|e| format!("Could not prepare temporary FFmpeg folder: {e}"))?;
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("tar.exe");
        c.args(["-xf"]).arg(archive).arg("-C").arg(dest);
        c
    } else {
        let mut c = tokio::process::Command::new("/usr/bin/unzip");
        c.args(["-q", "-o"]).arg(archive).arg("-d").arg(dest);
        c
    };
    crate::util::hide_console(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Could not unpack FFmpeg archive: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("ffmpeg archive extraction failed: {}", stderr.trim());
        return Err("Could not unpack the downloaded FFmpeg archive.".into());
    }
    Ok(())
}

async fn verify_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Could not mark {} executable: {e}", path.display()))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = tokio::process::Command::new("/usr/bin/xattr")
            .args(["-c"])
            .arg(path)
            .output()
            .await;
    }
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("-version");
    crate::util::hide_console(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Downloaded tool did not start: {e}"))?;
    if !output.status.success() {
        return Err("Downloaded FFmpeg failed its startup check.".into());
    }
    Ok(())
}

/// Copy an unpacked tool next to its final place. A copy that fails part-way, on a full disk, leaves no half-written file.
async fn copy_to_staging(extracted: &Path, staging: &Path, name: &str) -> Result<(), String> {
    tokio::fs::copy(extracted, staging).await.map(|_| ()).map_err(|e| {
        let _ = std::fs::remove_file(staging);
        log::warn!("failed copying {name} to {}: {e}", staging.display());
        "Could not write FFmpeg to disk. Check your free space and permissions.".to_string()
    })
}

/// Download, verify, unpack, and install FFmpeg and FFprobe into `~/.local/bin`.
pub async fn install(home: &Path, resources: Option<&Path>) -> Result<FfmpegStatus, String> {
    let _guard = INSTALL_LOCK.lock().await;
    let current = status(home, resources);
    if current.installed {
        return Ok(current);
    }
    let archives = platform_archives().ok_or_else(|| {
        "Install FFmpeg with your system’s package manager, then restart Scarlet.".to_string()
    })?;

    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| {
            log::warn!("cannot install ffmpeg: HTTP client error: {e}");
            "Could not start the FFmpeg download. Check your connection and try again.".to_string()
        })?;

    let work = tempfile::Builder::new()
        .prefix("scarlet-ffmpeg-")
        .tempdir()
        .map_err(|e| format!("Could not create temporary download folder: {e}"))?;

    for (idx, archive) in archives.iter().enumerate() {
        log::info!("downloading FFmpeg archive from {}", archive.url);
        let response = client.get(archive.url).send().await.map_err(|e| {
            log::warn!("cannot download {}: {e}", archive.url);
            "Could not download FFmpeg. Check your internet connection and try again.".to_string()
        })?;
        if !response.status().is_success() {
            log::warn!("FFmpeg download returned HTTP {}", response.status());
            return Err("Could not download FFmpeg. Check your internet connection and try again.".into());
        }
        let bytes = response.bytes().await.map_err(|e| {
            log::warn!("failed reading FFmpeg response body: {e}");
            "FFmpeg download was interrupted. Check your connection and try again.".to_string()
        })?;
        verify_sha256(&bytes, archive.sha256)?;

        let zip_path = work.path().join(format!("archive-{idx}.zip"));
        let mut f = std::fs::File::create(&zip_path)
            .map_err(|e| format!("Could not save temporary FFmpeg archive: {e}"))?;
        f.write_all(&bytes)
            .map_err(|e| format!("Could not write temporary FFmpeg archive: {e}"))?;
        drop(f);

        extract_zip(&zip_path, &work.path().join(format!("extract-{idx}"))).await?;
    }

    let dest = install_dir(home);
    tokio::fs::create_dir_all(&dest).await.map_err(|e| {
        log::warn!("cannot create {}: {e}", dest.display());
        "Could not create the folder for FFmpeg. Check your folder permissions and try again.".to_string()
    })?;

    for tool in ["ffmpeg", "ffprobe"] {
        let name = exe_name(tool);
        let extracted = find_file_recursive(work.path(), &name)
            .ok_or_else(|| format!("Downloaded archive did not contain {name}."))?;
        verify_executable(&extracted).await?;
        let target = dest.join(&name);
        let staging = dest.join(format!(".{name}.scarlet-tmp"));
        copy_to_staging(&extracted, &staging, &name).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755)) {
                log::warn!("could not mark {name} executable: {e}");
            }
        }
        tokio::fs::rename(&staging, &target).await.map_err(|e| {
            let _ = std::fs::remove_file(&staging);
            log::warn!("failed moving {name} into {}: {e}", target.display());
            "Could not finish installing FFmpeg. Check your folder permissions and try again.".to_string()
        })?;
        log::info!("installed {tool} to {}", target.display());
    }

    let final_status = status(home, resources);
    if !final_status.installed {
        return Err("FFmpeg was installed, but Scarlet could not verify it. Restart Scarlet and try again.".into());
    }
    Ok(final_status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_archives_use_https_and_valid_sha256_digests() {
        for list in [MACOS_ARM64_ARCHIVES, MACOS_X86_64_ARCHIVES, WINDOWS_X86_64_ARCHIVES] {
            assert!(!list.is_empty());
            for item in list {
                assert!(item.url.starts_with("https://"), "archive URL must be HTTPS: {}", item.url);
                assert_eq!(item.sha256.len(), 64, "digest must be 64 hex chars");
                assert!(item.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
            }
        }
    }

    #[test]
    fn verifies_sha256_and_rejects_mismatches() {
        let payload = b"scarlet-ffmpeg-test";
        let expected = sha256_hex(payload);
        assert!(verify_sha256(payload, &expected).is_ok());
        assert!(verify_sha256(b"tampered", &expected).is_err());
    }

    #[test]
    fn finds_nested_extracted_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("ffmpeg-9.0.2-essentials_build").join("bin");
        std::fs::create_dir_all(&nested).unwrap();
        let ff = nested.join("ffmpeg.exe");
        std::fs::write(&ff, b"binary").unwrap();
        assert_eq!(find_file_recursive(dir.path(), "ffmpeg.exe"), Some(ff));
        assert_eq!(find_file_recursive(dir.path(), "missing.exe"), None);
    }

    #[test]
    fn ignores_zero_byte_placeholders_and_detects_installed_tools() {
        let home = tempfile::tempdir().unwrap();
        let bin = install_dir(home.path());
        std::fs::create_dir_all(&bin).unwrap();
        let placeholder = bin.join(exe_name("ffmpeg"));
        std::fs::write(&placeholder, b"").unwrap();
        assert!(!is_usable_file(&placeholder));

        std::fs::write(&placeholder, b"#!/bin/sh\necho ok\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&placeholder, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(is_usable_file(&placeholder));
        assert_eq!(find_tool("ffmpeg", home.path(), None), Some(placeholder));
    }

    #[tokio::test]
    async fn failed_copy_leaves_no_staging_file_behind() {
        let home = tempfile::tempdir().unwrap();
        let bin = install_dir(home.path());
        std::fs::create_dir_all(&bin).unwrap();
        let name = exe_name("ffmpeg");
        let staging = bin.join(format!(".{name}.scarlet-tmp"));
        // What a copy cut short leaves: part of the file at the staging path.
        std::fs::write(&staging, b"partial").unwrap();
        let missing = home.path().join("gone").join(&name);
        assert!(copy_to_staging(&missing, &staging, &name).await.is_err());
        assert!(!staging.exists(), "the half-written staging file should be removed");
    }
}
