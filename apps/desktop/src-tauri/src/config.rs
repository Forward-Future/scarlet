//! Persistent desktop configuration (JSON file in the app config dir) and the
//! directory layout under the app data dir.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Task control files may contain the workspace bearer token.
pub fn private_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    anyhow::ensure!(std::fs::symlink_metadata(path)?.is_dir(), "expected a private directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = concat!(
            "$ErrorActionPreference='Stop';$id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
            "$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetOwner($id);$acl.SetAccessRuleProtection($true,$false);",
            "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));",
            "[System.IO.Directory]::SetAccessControl($env:SCARLET_PRIVATE_DIRECTORY,$acl)"
        );
        let status = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("SCARLET_PRIVATE_DIRECTORY", path).creation_flags(0x08000000).status()?;
        anyhow::ensure!(status.success(), "could not restrict workspace permissions");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
/// Fields from older versions (`mode`, `serverUrl`, `teamToken` for the removed
/// team mode) are ignored when loading and dropped on the next save.
pub struct AppConfig {
    /// Host id assigned by the engine, under the engine's address. Only the current one is kept.
    pub host_ids: HashMap<String, String>,
    /// Default model per agent runtime.
    pub models: HashMap<String, String>,
    /// Optional cap on one agent run, in minutes. Unset (the default) or 0, a run continues while its agent works.
    pub timeout_minutes: Option<u64>,
    /// Stop a run whose agent has written nothing for this many minutes (default 10). 0 never stops one for silence.
    pub stall_minutes: Option<u64>,
    /// Tasks each agent runtime may run at once (default 3, max 8).
    #[serde(default)]
    pub max_parallel: Option<usize>,
}

impl AppConfig {
    pub fn load(path: &Path) -> AppConfig {
        match std::fs::read_to_string(path) {
            // Files edited by PowerShell/Notepad may carry a UTF-8 BOM.
            Ok(txt) => serde_json::from_str(txt.trim_start_matches('\u{feff}')).unwrap_or_else(|e| {
                // The next save writes the defaults over this file. What was typed is kept beside it.
                let mut kept = path.as_os_str().to_owned();
                kept.push(".invalid");
                let kept = PathBuf::from(kept);
                match std::fs::write(&kept, &txt) {
                    Ok(()) => log::warn!("config {} unreadable ({e}); using defaults. Its text is kept as {}", path.display(), kept.display()),
                    Err(copy) => log::warn!("config {} unreadable ({e}); using defaults. Its text could not be kept: {copy}", path.display()),
                }
                AppConfig::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppConfig::default(),
            Err(e) => {
                log::warn!("config {} could not be read ({e}); using defaults", path.display());
                AppConfig::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)? + "\n")?;
        std::fs::rename(&tmp, path).or_else(|_| {
            std::fs::copy(&tmp, path).map(|_| ())?;
            std::fs::remove_file(&tmp)
        })?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct Paths {
    pub config_file: PathBuf,
    /// Engine data (SQLite, media, renders).
    pub data_dir: PathBuf,
    /// Per-task workspaces for the agent CLIs.
    pub work_dir: PathBuf,
    pub log_dir: PathBuf,
    /// Bundled resources (ffmpeg etc. under `bin/` when shipped).
    pub resource_dir: Option<PathBuf>,
    pub home: PathBuf,
}

impl Paths {
    /// Kept outside desktop.json so older releases can save their settings without dropping this list.
    pub fn custom_openai_models(&self) -> Vec<String> {
        self.custom_models("custom-openai-models.json")
    }

    /// Claude model IDs the CLI accepts but leaves out of its picker catalog (early-access models).
    pub fn custom_claude_models(&self) -> Vec<String> {
        self.custom_models("custom-claude-models.json")
    }

    fn custom_models(&self, file: &str) -> Vec<String> {
        let path = self.config_file.with_file_name(file);
        let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
        serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap_or_else(|e| {
            log::warn!("invalid custom model list {}: {e}", path.display());
            Vec::new()
        })
    }

    pub fn ensure(&self) -> Result<()> {
        // This also protects runner configs left by older versions.
        private_directory(&self.work_dir)?;
        for d in [&self.data_dir, &self.log_dir] {
            std::fs::create_dir_all(d).with_context(|| format!("create {}", d.display()))?;
        }
        if let Some(p) = self.config_file.parent() {
            std::fs::create_dir_all(p)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips() {
        let dir = std::env::temp_dir().join(format!("scarlet-desktop-cfg-{}", std::process::id()));
        let file = dir.join("desktop.json");
        let mut c = AppConfig::default();
        c.host_ids.insert("http://127.0.0.1:5123".into(), "host_1".into());
        c.models.insert("claude".into(), "opus".into());
        c.save(&file).unwrap();
        let back = AppConfig::load(&file);
        assert_eq!(back.host_ids.get("http://127.0.0.1:5123").map(String::as_str), Some("host_1"));
        assert_eq!(back.models.get("claude").map(String::as_str), Some("opus"));
        let _ = std::fs::remove_dir_all(dir);
        assert!(AppConfig::load(Path::new("/definitely/missing.json")).host_ids.is_empty());
        // A BOM and team-mode settings from older versions still load.
        let bom = std::env::temp_dir().join(format!("scarlet-desktop-bom-{}.json", std::process::id()));
        std::fs::write(&bom, "\u{feff}{\"mode\":\"team\",\"serverUrl\":\"http://x\",\"teamToken\":\"sca_x\",\"timeoutMinutes\":30}").unwrap();
        assert_eq!(AppConfig::load(&bom).timeout_minutes, Some(30));
        let _ = std::fs::remove_file(bom);
    }

    #[test]
    fn keeps_a_settings_file_it_cannot_read_before_defaults_replace_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("desktop.json");
        // A hand edit with a trailing comma.
        let typed = "{\"models\":{\"claude\":\"opus\"},\"timeoutMinutes\":45,}";
        std::fs::write(&file, typed).unwrap();
        let loaded = AppConfig::load(&file);
        assert!(loaded.models.is_empty() && loaded.timeout_minutes.is_none());
        // The host saves its id soon after, which writes the defaults over the file.
        loaded.save(&file).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("desktop.json.invalid")).unwrap(), typed);
        // A file that reads fine leaves no copy behind.
        let fine = dir.path().join("fine.json");
        std::fs::write(&fine, "{\"stallMinutes\":5}").unwrap();
        assert_eq!(AppConfig::load(&fine).stall_minutes, Some(5));
        assert!(!dir.path().join("fine.json.invalid").exists());
    }

    #[cfg(unix)]
    #[test]
    fn says_so_when_the_settings_file_is_there_but_cannot_be_read() {
        use std::os::unix::fs::PermissionsExt;
        crate::util::test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("locked-desktop.json");
        std::fs::write(&file, "{\"timeoutMinutes\":45}").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads any file, so there is nothing to see there.
        if std::fs::read_to_string(&file).is_ok() {
            return;
        }
        assert!(AppConfig::load(&file).timeout_minutes.is_none());
        let (level, _) = crate::util::test_log::find(&["locked-desktop.json could not be read"]).expect("the unreadable file was not logged");
        assert_eq!(level, log::Level::Warn);
        // A file that isn't there is the ordinary first launch, and says nothing.
        AppConfig::load(&dir.path().join("first-launch-desktop.json"));
        assert!(crate::util::test_log::find(&["first-launch-desktop.json"]).is_none());
    }

    #[test]
    fn saves_into_a_folder_that_does_not_exist_yet_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config").join("nested").join("desktop.json");
        let config = AppConfig { stall_minutes: Some(0), max_parallel: Some(2), ..Default::default() };
        config.save(&file).unwrap();
        config.save(&file).unwrap();
        let names: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["desktop.json"]);
        let text = std::fs::read_to_string(&file).unwrap();
        // camelCase on disk, as the README names the settings.
        assert!(text.contains("\"stallMinutes\": 0") && text.contains("\"maxParallel\": 2") && text.ends_with("}\n"), "{text}");
        let back = AppConfig::load(&file);
        assert_eq!((back.stall_minutes, back.max_parallel, back.timeout_minutes), (Some(0), Some(2), None));
    }

    fn paths(root: &Path) -> Paths {
        Paths {
            config_file: root.join("config").join("desktop.json"),
            data_dir: root.join("data"),
            work_dir: root.join("work"),
            log_dir: root.join("logs"),
            resource_dir: None,
            home: root.join("home"),
        }
    }

    #[test]
    fn reads_custom_model_lists_kept_beside_the_settings() {
        crate::util::test_log::capture();
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        // Neither file exists on a new install.
        assert!(paths.custom_openai_models().is_empty() && paths.custom_claude_models().is_empty());
        std::fs::create_dir_all(dir.path().join("config")).unwrap();
        std::fs::write(dir.path().join("config").join("custom-openai-models.json"), "\u{feff}[\"gpt-5.5-preview\", \"o9\"]").unwrap();
        std::fs::write(dir.path().join("config").join("custom-claude-models.json"), "{\"models\":[\"claude-next\"]}").unwrap();
        // A list saved by Notepad, with its byte order mark, reads. Each list has its own file.
        assert_eq!(paths.custom_openai_models(), ["gpt-5.5-preview", "o9"]);
        // A file that isn't a list of names is ignored, and says so.
        assert!(paths.custom_claude_models().is_empty());
        let (level, _) = crate::util::test_log::find(&["invalid custom model list", "custom-claude-models.json"]).expect("the bad list was not logged");
        assert_eq!(level, log::Level::Warn);
    }

    #[test]
    fn makes_the_work_folder_private_and_refuses_a_file_in_its_place() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        paths.ensure().unwrap();
        for made in [&paths.work_dir, &paths.data_dir, &paths.log_dir, &dir.path().join("config")] {
            assert!(made.is_dir(), "{}", made.display());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&paths.work_dir), 0o700);
            // A folder an older version made for everyone to read is closed, with what is in it left alone.
            let open = dir.path().join("open");
            std::fs::create_dir(&open).unwrap();
            std::fs::write(open.join("mcp.json"), "sct").unwrap();
            std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
            private_directory(&open).unwrap();
            assert_eq!(mode(&open), 0o700);
            assert_eq!(std::fs::read_to_string(open.join("mcp.json")).unwrap(), "sct");
            // A link to a folder elsewhere is not a private folder of ours.
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&open, &link).unwrap();
            assert!(private_directory(&link).is_err());
        }
        // A file where the folder should be is an error, not something to write through.
        let file = dir.path().join("a-file");
        std::fs::write(&file, "").unwrap();
        assert!(private_directory(&file).is_err());
        assert!(private_directory(&file.join("under-a-file")).is_err());
        assert!(Paths { work_dir: file, ..paths }.ensure().is_err());
    }
}
