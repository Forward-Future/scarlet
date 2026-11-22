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
    owner_only(path)?;
    Ok(())
}

/// Give the folder to the current user alone: they own it, and its access list holds only them, with full control
/// that its files and folders inherit. Nothing is inherited from the folder above.
#[cfg(windows)]
fn owner_only(path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // The user this process runs as.
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the pseudo-handle of this process needs no closing; the token handle is closed below.
    anyhow::ensure!(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0, "could not read the current user: {}", std::io::Error::last_os_error());
    let mut len = 0u32;
    // SAFETY: the first call only asks for the size; the buffer is u64s, aligned for TOKEN_USER.
    let user = unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        let mut user = vec![0u64; (len as usize).div_ceil(8)];
        let read = GetTokenInformation(token, TokenUser, user.as_mut_ptr().cast(), len, &mut len);
        let failed = std::io::Error::last_os_error();
        CloseHandle(token);
        anyhow::ensure!(read != 0, "could not read the current user: {failed}");
        user
    };
    // SAFETY: GetTokenInformation filled the buffer with a TOKEN_USER whose SID points inside the same buffer.
    let sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };

    let access = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid.cast(),
        },
    };
    let mut acl: *mut ACL = std::ptr::null_mut();
    // SAFETY: one entry whose SID outlives the call; the new list is freed with LocalFree below.
    let made = unsafe { SetEntriesInAclW(1, &access, std::ptr::null(), &mut acl) };
    anyhow::ensure!(made == ERROR_SUCCESS, "could not restrict workspace permissions: {}", std::io::Error::from_raw_os_error(made as i32));
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    // SAFETY: the path is NUL-terminated, and the SID and list live until after the call.
    let set = unsafe {
        let set = SetNamedSecurityInfoW(wide.as_ptr(), SE_FILE_OBJECT, info, sid, std::ptr::null_mut(), acl, std::ptr::null());
        LocalFree(acl.cast());
        set
    };
    anyhow::ensure!(set == ERROR_SUCCESS, "could not restrict workspace permissions: {}", std::io::Error::from_raw_os_error(set as i32));
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
    /// Tasks each agent runtime may run at once (default 4, max 8): a request about the whole video and three revisions beside it.
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorModelSelection {
    agent: EditorAgent,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_tier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum EditorAgent {
    Claude,
    Codex,
    Gemini,
    Api,
}

impl Paths {
    fn editor_model_file(&self) -> PathBuf {
        self.config_file.with_file_name("editor-model.json")
    }

    /// Share the editor's selection across renderer origins. Older releases may still write desktop.json.
    pub fn editor_model(&self) -> Option<EditorModelSelection> {
        let path = self.editor_model_file();
        let saved = match std::fs::read(&path) {
            Ok(saved) => saved,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                log::warn!("could not read editor model preference: {e}");
                return None;
            }
        };
        serde_json::from_slice(&saved).unwrap_or_else(|e| {
            log::warn!("invalid editor model preference: {e}");
            None
        })
    }

    pub fn save_editor_model(&self, selection: &EditorModelSelection) -> Result<()> {
        let path = self.editor_model_file();
        let dir = path.parent().context("missing desktop config directory")?;
        std::fs::create_dir_all(dir)?;
        let bytes = serde_json::to_vec(selection)?;
        crate::util::write_file_atomic(&path, &bytes, false)?;
        Ok(())
    }

    /// Kept outside desktop.json so older releases can save their settings without dropping this list.
    pub fn custom_openai_models(&self) -> Vec<String> {
        self.custom_models("custom-openai-models.json")
    }

    /// Claude model IDs the CLI accepts but leaves out of its picker catalog (early-access models).
    pub fn custom_claude_models(&self) -> Vec<String> {
        self.custom_models("custom-claude-models.json")
    }

    /// Gemini model IDs the CLI accepts but leaves out of its picker catalog (early-access models).
    pub fn custom_gemini_models(&self) -> Vec<String> {
        self.custom_models("custom-gemini-models.json")
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
    fn remembers_the_latest_editor_model_across_launches() {
        let dir = tempfile::tempdir().unwrap();
        let first = paths(dir.path());
        assert!(first.editor_model().is_none());
        let selection = serde_json::json!({"agent": "codex", "model": "example-model", "effort": "high", "serviceTier": "priority"});
        first.save_editor_model(&serde_json::from_value(selection.clone()).unwrap()).unwrap();
        AppConfig::default().save(&first.config_file).unwrap();

        let next = paths(dir.path());
        assert_eq!(serde_json::to_value(next.editor_model()).unwrap(), selection);
        let replacement = serde_json::json!({"agent": "claude", "model": "opus"});
        next.save_editor_model(&serde_json::from_value(replacement.clone()).unwrap()).unwrap();
        assert_eq!(serde_json::to_value(first.editor_model()).unwrap(), replacement);
    }

    #[test]
    fn ignores_an_unreadable_editor_model_preference() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        let file = paths.editor_model_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"agent":"unknown","model":"example-model"}"#).unwrap();
        assert!(paths.editor_model().is_none());
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

    /// Whether the user owns the path, whether its access list is protected, then how many rules it holds and the
    /// first one: whether it is the user's, its rights and inheritance, and whether it was inherited.
    #[cfg(windows)]
    fn access(path: &Path) -> String {
        use std::os::windows::process::CommandExt;
        let script = concat!(
            "$ErrorActionPreference='Stop';$sid=[System.Security.Principal.SecurityIdentifier];",
            "$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$p=$env:SCARLET_TEST_PATH;",
            "$a=if([System.IO.Directory]::Exists($p)){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)};",
            "$r=@($a.GetAccessRules($true,$true,$sid));",
            "'{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f ($a.GetOwner($sid) -eq $u),$a.AreAccessRulesProtected,$r.Count,($r[0].IdentityReference -eq $u),",
            "$r[0].FileSystemRights,$r[0].InheritanceFlags,$r[0].IsInherited"
        );
        let out = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("SCARLET_TEST_PATH", path).creation_flags(crate::util::CREATE_NO_WINDOW).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
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
        #[cfg(windows)]
        {
            // A folder made under the temp folder inherits access for others. Made private, it is the user's alone,
            // and what is made in it later is theirs alone too.
            let open = dir.path().join("open");
            std::fs::create_dir(&open).unwrap();
            std::fs::write(open.join("mcp.json"), "sct").unwrap();
            private_directory(&open).unwrap();
            std::fs::write(open.join("later.json"), "").unwrap();
            assert_eq!(access(&open), "True|True|1|True|FullControl|ContainerInherit, ObjectInherit|False");
            // Its owner is whoever the system makes the owner of new files, which for an administrator may be their group.
            assert!(access(&open.join("later.json")).ends_with("|False|1|True|FullControl|None|True"));
            assert_eq!(std::fs::read_to_string(open.join("mcp.json")).unwrap(), "sct");
        }
        // A file where the folder should be is an error, not something to write through.
        let file = dir.path().join("a-file");
        std::fs::write(&file, "").unwrap();
        assert!(private_directory(&file).is_err());
        assert!(private_directory(&file.join("under-a-file")).is_err());
        assert!(Paths { work_dir: file, ..paths }.ensure().is_err());
    }
}
