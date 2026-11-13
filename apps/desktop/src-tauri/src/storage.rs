//! Read-only disk accounting. All project paths are derived from the local library.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io, path::{Component, Path, PathBuf}};
use tauri::State;
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    id: String,
    deleted_at: Option<String>,
    segments: Vec<String>,
}

#[derive(Default, Serialize)]
pub struct Size {
    bytes: u64,
    files: u64,
    estimated: bool,
    #[cfg(unix)]
    #[serde(skip)]
    links: HashMap<(u64, u64), u64>,
}

#[cfg(target_os = "macos")]
fn private_size(path: &Path) -> Option<u64> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut attr = libc::attrlist {
        bitmapcount: 5, reserved: 0, commonattr: libc::ATTR_CMN_RETURNED_ATTRS,
        volattr: 0, dirattr: 0, fileattr: 0, forkattr: libc::ATTR_CMNEXT_PRIVATESIZE,
    };
    // getattrlist packs the returned bitmap and 64-bit private size on 4-byte boundaries.
    let mut data = [0u32; 8];
    let rc = unsafe { libc::getattrlist(path.as_ptr(), (&mut attr as *mut libc::attrlist).cast(),
        data.as_mut_ptr().cast(), std::mem::size_of_val(&data),
        libc::FSOPT_ATTR_CMN_EXTENDED | libc::FSOPT_NOFOLLOW) };
    (rc == 0 && data[0] == 32 && data[5] & libc::ATTR_CMNEXT_PRIVATESIZE != 0)
        .then(|| u64::from(data[6]) | (u64::from(data[7]) << 32))
}

#[cfg(not(target_os = "macos"))]
fn private_size(_: &Path) -> Option<u64> { None }

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))]
    { meta.file_type().is_symlink() }
}

impl Size {
    fn measure(&mut self, path: &Path) -> io::Result<()> {
        let meta = match fs::symlink_metadata(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            other => other?,
        };
        if linked(&meta) { return Ok(()); }
        if meta.is_dir() {
            // The engine may delete files while this runs. A vanished entry is simply not counted.
            let entries = match fs::read_dir(path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
                other => other?,
            };
            for entry in entries {
                match entry {
                    Ok(entry) => self.measure(&entry.path())?,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                }
            }
        } else if meta.is_file() {
            self.files += 1;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.nlink() > 1 {
                    let count = self.links.entry((meta.dev(), meta.ino())).or_default();
                    *count += 1;
                    if *count < meta.nlink() { return Ok(()); }
                }
            }
            match private_size(path) {
                Some(n) => self.bytes += n,
                None => { self.estimated = true; self.bytes += meta.len(); }
            }
        }
        Ok(())
    }
}

fn plain_dir(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(m.is_dir() && !linked(&m)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn single_name(s: &str) -> bool {
    let mut parts = Path::new(s).components();
    matches!(parts.next(), Some(Component::Normal(n)) if n == s) && parts.next().is_none()
}

fn measure_projects(data: &Path, projects: Vec<ProjectFiles>) -> io::Result<HashMap<String,Size>> {
    let base = data.join("projects");
    let library_exists = plain_dir(&base)?;
    let mut out = HashMap::new();
    for p in projects {
        if !single_name(&p.id) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid project ID")); }
        let dir = base.join(&p.id);
        let mut size = Size::default();
        if library_exists && plain_dir(&dir)? {
            if p.deleted_at.is_some() {
                size.measure(&dir)?;
            } else {
                let segments = dir.join("segments");
                if plain_dir(&segments)? {
                    for name in p.segments {
                        if !single_name(&name) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid segment name")); }
                        let file = segments.join(name);
                        // A replaced file must never expand the scope of this scan.
                        if file.symlink_metadata().is_ok_and(|m| m.is_file()) { size.measure(&file)?; }
                    }
                }
            }
        }
        out.insert(p.id,size);
    }
    Ok(out)
}

#[tauri::command]
pub async fn measure_project_storage(state: State<'_, AppState>, projects: Vec<ProjectFiles>) -> Result<HashMap<String,Size>, String> {
    let data = state.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || measure_projects(&data, projects))
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[derive(Deserialize, Serialize)]
pub struct RegisteredRoot { kind: String, path: PathBuf }

#[derive(Serialize)]
pub struct DeveloperStorage { #[serde(flatten)] root: RegisteredRoot, #[serde(flatten)] size: Size }

fn registered_storage() -> io::Result<Vec<DeveloperStorage>> {
    if !cfg!(debug_assertions) { return Ok(Vec::new()); }
    let Some(cache) = dirs::cache_dir() else { return Ok(Vec::new()); };
    registered_in(&cache.join("com.forwardfuture.scarlet.development/storage"))
}

/// The build and test folders recorded in `registry`, largest first.
fn registered_in(registry: &Path) -> io::Result<Vec<DeveloperStorage>> {
    let mut out = Vec::new();
    if !plain_dir(registry)? { return Ok(out); }
    for record in fs::read_dir(registry)? {
        let record = record?;
        if !record.file_type()?.is_file() || record.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let Ok(text) = fs::read(record.path()) else { continue; };
        let Ok(root) = serde_json::from_slice::<RegisteredRoot>(&text) else { continue; };
        if !root.path.is_absolute() || !plain_dir(&root.path)? { continue; }
        let mut size = Size::default();
        match root.kind.as_str() {
            "cargo" => {
                // Keep packaged apps, sidecars and release bundles outside this total.
                for name in ["build","deps","incremental",".fingerprint","examples"] {
                    size.measure(&root.path.join(name))?;
                }
            }
            "scratch" => size.measure(&root.path)?,
            _ => continue,
        }
        out.push(DeveloperStorage { root, size });
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.size.bytes));
    Ok(out)
}

#[tauri::command]
pub async fn developer_storage() -> Result<Vec<DeveloperStorage>, String> {
    tauri::async_runtime::spawn_blocking(registered_storage).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn counts_hardlinked_files_only_when_the_last_link_is_selected() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        fs::write(&a, vec![42; 32768]).unwrap();
        // A file takes no space of its own until its data is written out, which the system otherwise does in its own time.
        fs::File::open(&a).unwrap().sync_all().unwrap();
        fs::hard_link(&a, &b).unwrap();
        let mut size = Size::default();
        size.measure(&a).unwrap();
        assert_eq!(size.bytes, 0);
        size.measure(&b).unwrap();
        assert!(size.bytes > 0);
    }

    #[test]
    fn separates_cache_from_project_trash_and_rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("projects/prj_test");
        fs::create_dir_all(project.join("segments")).unwrap();
        fs::write(project.join("source.mp4"), b"original").unwrap();
        fs::write(project.join("segments/file.mp4"), b"render").unwrap();
        let scan = |id: &str, deleted_at| measure_projects(tmp.path(),vec![ProjectFiles {
            id:id.into(), deleted_at, segments: vec!["file.mp4".into()],
        }]);
        assert_eq!(scan("prj_test",None).unwrap()["prj_test"].files,1);
        assert_eq!(scan("prj_test",Some("now".into())).unwrap()["prj_test"].files,2);
        assert!(scan("../",None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_link_out_of_the_library() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("big.mov"), vec![1; 4096]).unwrap();
        let project = tmp.path().join("projects/prj_test");
        fs::create_dir_all(project.join("segments")).unwrap();
        fs::write(project.join("segments/file.mp4"), b"render").unwrap();
        // Inside a deleted project: a linked folder and a linked file, beside one real file.
        std::os::unix::fs::symlink(&outside, project.join("linked-folder")).unwrap();
        std::os::unix::fs::symlink(outside.join("big.mov"), project.join("linked.mov")).unwrap();
        let scan = |id: &str, deleted_at: Option<&str>, segments: &[&str]| {
            let files = ProjectFiles { id: id.into(), deleted_at: deleted_at.map(String::from), segments: segments.iter().map(|s| s.to_string()).collect() };
            measure_projects(tmp.path(), vec![files])
        };
        assert_eq!(scan("prj_test", Some("now"), &[]).unwrap()["prj_test"].files, 1);
        // A segment that was replaced by a link is not counted, and neither is one that is missing.
        std::os::unix::fs::symlink(outside.join("big.mov"), project.join("segments/swapped.mp4")).unwrap();
        assert_eq!(scan("prj_test", None, &["file.mp4", "swapped.mp4", "missing.mp4"]).unwrap()["prj_test"].files, 1);
        // A segment name that reaches out of the folder is refused outright.
        for name in ["../source.mp4", "a/b.mp4", "/etc/passwd", "..", ""] {
            assert!(scan("prj_test", None, &[name]).is_err(), "{name:?}");
        }
        // A project folder that is itself a link, or a segments folder that is, counts as nothing.
        std::os::unix::fs::symlink(&outside, tmp.path().join("projects/prj_link")).unwrap();
        let linked = scan("prj_link", Some("now"), &[]).unwrap();
        assert_eq!((linked["prj_link"].files, linked["prj_link"].bytes), (0, 0));
        fs::remove_dir_all(project.join("segments")).unwrap();
        std::os::unix::fs::symlink(&outside, project.join("segments")).unwrap();
        assert_eq!(scan("prj_test", None, &["big.mov"]).unwrap()["prj_test"].files, 0);
    }

    #[test]
    fn a_project_with_no_folder_yet_measures_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let scan = |id: &str| measure_projects(tmp.path(), vec![ProjectFiles { id: id.into(), deleted_at: None, segments: vec!["file.mp4".into()] }]);
        // No library at all, then a library without this project, then a project without renders.
        assert_eq!(scan("prj_new").unwrap()["prj_new"].files, 0);
        fs::create_dir_all(tmp.path().join("projects")).unwrap();
        assert_eq!(scan("prj_new").unwrap()["prj_new"].files, 0);
        fs::create_dir_all(tmp.path().join("projects/prj_new")).unwrap();
        let size = &scan("prj_new").unwrap()["prj_new"];
        assert_eq!((size.files, size.bytes, size.estimated), (0, 0, false));
        for id in ["", ".", "..", "a/b", "/abs"] {
            assert!(scan(id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn lists_registered_build_folders_largest_first_and_skips_bad_records() {
        use std::io::Write;

        let tmp = tempfile::tempdir().unwrap();
        let registry = tmp.path().join("registry");
        // No registry yet: nothing registered, not an error.
        assert!(registered_in(&registry).unwrap().is_empty());
        fs::create_dir_all(&registry).unwrap();
        // Written out before it is measured: a file takes no space of its own until then.
        let write = |file: PathBuf, bytes: usize| {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            let mut output = fs::File::create(file).unwrap();
            output.write_all(&vec![7; bytes]).unwrap();
            output.sync_all().unwrap();
        };
        let cargo = tmp.path().join("target-debug");
        for (folder, bytes) in [("deps", 300), ("build", 200), ("bundle", 1_000_000)] {
            write(cargo.join(folder).join("blob"), bytes);
        }
        let scratch = tmp.path().join("scratch");
        write(scratch.join("nested").join("clip.mp4"), 100_000);
        let record = |name: &str, text: String| fs::write(registry.join(name), text).unwrap();
        record("a.json", serde_json::json!({ "kind": "cargo", "path": cargo }).to_string());
        record("b.json", serde_json::json!({ "kind": "scratch", "path": scratch }).to_string());
        // Skipped: an unknown kind, a path that is relative or gone, a record that isn't JSON or isn't a .json file.
        record("c.json", serde_json::json!({ "kind": "docker", "path": scratch }).to_string());
        record("d.json", serde_json::json!({ "kind": "scratch", "path": "relative/folder" }).to_string());
        record("e.json", serde_json::json!({ "kind": "scratch", "path": tmp.path().join("deleted") }).to_string());
        record("f.json", "{\"kind\":".into());
        record("g.txt", serde_json::json!({ "kind": "scratch", "path": scratch }).to_string());
        fs::create_dir(registry.join("h.json")).unwrap();

        let listed = registered_in(&registry).unwrap();
        assert_eq!(listed.iter().map(|r| (r.root.kind.as_str(), r.root.path.clone())).collect::<Vec<_>>(), [("scratch", scratch.clone()), ("cargo", cargo.clone())]);
        // A scratch folder counts whole. A cargo folder counts its build output, not the packaged app beside it.
        assert_eq!((listed[0].size.files, listed[1].size.files), (1, 2));
        assert!(listed[1].size.bytes < 100_000, "counted the bundle: {} bytes", listed[1].size.bytes);
        // The window reads one flat object per folder.
        let shown = serde_json::to_value(&listed[1]).unwrap();
        assert_eq!((&shown["kind"], &shown["files"]), (&serde_json::json!("cargo"), &serde_json::json!(2)));
        assert!(shown.get("path").is_some() && shown.get("bytes").is_some() && shown.get("links").is_none());
    }
}
