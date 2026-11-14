//! Tauri build script. Besides the standard `tauri_build::build()`, this makes
//! sure the sidecars declared in `tauri.conf.json` (`bundle.externalBin`) exist
//! so `cargo build` / `tauri dev` work before the Node SEA has been produced or
//! ffmpeg fetched. Zero-byte placeholders are written. The app treats an empty
//! engine as "missing" and falls back to `SCARLET_ENGINE_CMD` /
//! `node apps/server/dist/cli.js`; the engine ignores an empty ffmpeg and uses PATH.
use std::path::PathBuf;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let ext = if target.contains("windows") { ".exe" } else { "" };
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // OUT_DIR includes the actual target/profile, including custom Cargo targets.
    let register = manifest.join("../scripts/register-storage.mjs");
    println!("cargo:rerun-if-changed={}", register.display());
    if std::env::var_os("CI").is_none() {
        if let Some(out) = std::env::var_os("OUT_DIR") {
            if let Some(profile) = std::path::Path::new(&out).ancestors().nth(3) {
                let _ = std::process::Command::new("node").arg(register).arg("cargo").arg(profile).status();
            }
        }
    }
    let dir = manifest.join("binaries");
    let _ = std::fs::create_dir_all(&dir);
    std::fs::create_dir_all(dir.join("uhm-runtime")).expect("create runtime resources directory");
    std::fs::create_dir_all(dir.join("speaker-runtime")).expect("create speaker runtime directory");
    if target == "x86_64-unknown-linux-gnu" {
        let cpu = dir.join("whisper-cpu");
        std::fs::create_dir_all(&cpu).expect("create optimized Whisper runtime directory");
        let program = cpu.join("whisper-cli");
        if !program.exists() {
            std::fs::write(program, b"").expect("create development Whisper placeholder");
        }
    }
    // Windows bundles the GPU builds of whisper-cli and the speaker runtime from these folders (tauri.windows.conf.json),
    // so they are never empty, with or without the GPU builds.
    for (name, note) in [("whisper-gpu", "the Vulkan whisper-cli"), ("speaker-gpu", "the DirectML speaker runtime")] {
        let gpu = dir.join(name);
        std::fs::create_dir_all(&gpu).expect("create GPU runtime directory");
        if std::fs::read_dir(&gpu).map(|mut entries| entries.next().is_none()).unwrap_or(true) {
            let _ = std::fs::write(gpu.join("README.txt"), format!("Scarlet tries {note} in this folder before the CPU one.\n"));
        }
    }
    for name in ["scarlet-engine", "ffmpeg", "ffprobe", "whisper-cli"] {
        let sidecar = dir.join(format!("{name}-{target}{ext}"));
        if !sidecar.exists() {
            println!("cargo:warning=sidecar {} not found; writing an empty placeholder (README.md, Desktop app: `pnpm desktop:ffmpeg` and `build:sea`)", sidecar.display());
            let _ = std::fs::write(&sidecar, b"");
        }
    }
    println!("cargo:rerun-if-changed=binaries");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
