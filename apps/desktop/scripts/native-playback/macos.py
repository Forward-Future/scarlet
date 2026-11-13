#!/usr/bin/env python3
"""Local native Scarlet playback benchmark. Only builds/launches a disposable nonactivating Tauri preview.

prepare SCRATCH stages the shell and renderer. start SCRATCH CLONED_DATA PROJECT runs in the
foreground until interrupted or stopped (the app itself never activates). run SCRATCH CONFIG RESULT
submits the fixed measure.js suite. capture SCRATCH GRIDS samples only this private window while
it is below the wallpaper. stop SCRATCH closes only this benchmark process. Pass --repo
to prepare a specific checkout, and --engine to start with a packaged engine instead of its built JS.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
PORT = 5173


def replace(path, before, after):
    data = path.read_text()
    if data.count(before) != 1:
        raise RuntimeError(f"Unexpected benchmark instrumentation anchor in {path.name}: {before[:32]}")
    path.write_text(data.replace(before, after))


def atomic(path, data):
    tmp = path.with_suffix(".new")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def in_temp(path):
    roots = [Path("/tmp").resolve(), Path(tempfile.gettempdir()).resolve()]
    if not any(root in path.resolve().parents for root in roots):
        raise ValueError(f"Expected a disposable path under a system temp directory: {path}")


def link_installed_modules(repo, tree):
    # pnpm requires a real, private directory for its task locks. Vite also
    # writes its optimization cache here; share only installed dependencies.
    with (tree / "pnpm-workspace.yaml").open("a") as f:
        f.write("\nverifyDepsBeforeRun: false\n")
    for rel in ["node_modules", "apps/web/node_modules", "apps/desktop/node_modules"]:
        dest = tree / rel
        dest.mkdir()
        for entry in (repo / rel).iterdir():
            if entry.name.startswith(".") and entry.name not in (".bin", ".pnpm"):
                continue
            (dest / entry.name).symlink_to(entry)


def prepare(args):
    work, repo = args.scratch, args.repo.resolve()
    in_temp(work)
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any(work.iterdir()):
        raise ValueError("Use an empty, private scratch directory.")
    work.chmod(0o700)
    tree = work / "checkout"
    tree.mkdir()
    subprocess.run(["rsync", "-a", "--exclude=node_modules", "--exclude=target", "--exclude=dist", "--exclude=binaries",
                    "--exclude=.git", "--relative", "./apps/web", "./apps/desktop", "./skills",
                    "./package.json", "./pnpm-lock.yaml", "./pnpm-workspace.yaml", "./tsconfig.base.json", str(tree)], check=True, cwd=repo)
    link_installed_modules(repo, tree)
    # Vite must not reload the private window when a different chat rebuilds
    # a package. Freeze the actual renderer runtime for the entire trial.
    replace(tree/"apps/web/vite.config.ts", "  server: {", "  server: {\n    hmr: false,\n    watch: null,")
    scope = tree/"apps/web/node_modules/@scarlet"
    scope.unlink()
    scope.mkdir()
    for name in ["shared", "timeline"]:
        package = tree/"bench-dependencies"/name
        package.mkdir(parents=True)
        shutil.copy2(repo/"packages"/name/"package.json", package/"package.json")
        shutil.copytree(repo/"packages"/name/"dist", package/"dist")
        dependencies = package/"node_modules"
        dependencies.mkdir()
        for module in (repo/"packages"/name/"node_modules").iterdir():
            if module.name == "@scarlet":
                local_scope = dependencies/module.name
                local_scope.mkdir()
                for dependency in module.iterdir():
                    (local_scope/dependency.name).symlink_to(tree/"bench-dependencies"/dependency.name)
            elif not module.name.startswith("."):
                (dependencies/module.name).symlink_to(module)
        (scope/name).symlink_to(package)
    native = tree / "apps/desktop/src-tauri"
    cfg_file = native / "tauri.conf.json"
    cfg = json.loads(cfg_file.read_text())
    identifier = "com.forwardfuture.scarlet.bench." + uuid.uuid4().hex
    cfg["identifier"] = identifier
    window = cfg["app"]["windows"][0]
    window.update(visible=False, focus=False, focusable=False, backgroundThrottling="disabled", width=1280, height=800)
    cfg["bundle"].update(externalBin=[], resources={})
    cfg_file.write_text(json.dumps(cfg, indent=2))
    for name in ["macos-view.m", "mute.js"]:
        shutil.copyfile(HERE / name, native / name)
    subprocess.run(["xcrun", "clang", "-fobjc-arc", "-Wno-incompatible-pointer-types", "-c", "macos-view.m", "-o", "macos-view.o"], cwd=native, check=True)
    subprocess.run(["ar", "-rcs", "libscarletbench.a", "macos-view.o"], cwd=native, check=True)
    subprocess.run(["xcrun", "clang", "-fobjc-arc", "-framework", "AppKit", "-framework", "ScreenCaptureKit",
                    "-framework", "CoreMedia", "-framework", "CoreVideo", "-framework", "CoreGraphics",
                    "-framework", "Foundation", str(HERE/"macos-pixels.m"), "-o", str(work/"macos-pixels")], check=True)
    replace(native / "build.rs", "fn main() {", '''fn main() {
    println!("cargo:rustc-link-search=native={}", std::env::var("CARGO_MANIFEST_DIR").unwrap());
    println!("cargo:rerun-if-changed=libscarletbench.a");
    println!("cargo:rustc-link-lib=static=scarletbench");''')
    lib = native / "src/lib.rs"
    replace(lib, "tauri::Builder::default()", '''{
        extern "C" { fn scarletBenchPrepare(); }
        unsafe { scarletBenchPrepare() };
        tauri::Builder::default().activate_ignoring_other_apps(false)
    }''')
    replace(lib, "tauri_plugin_window_state::Builder::default().build()", '''tauri::plugin::Builder::<_, ()>::new("bench-mute")
            .js_init_script(include_str!("../mute.js")).build()''')
    replace(lib, "let handle = app.handle().clone();", '''app.get_webview_window("main").unwrap().with_webview(|w| unsafe {
                extern "C" { fn scarletBenchAttach(view: *mut std::ffi::c_void); }
                scarletBenchAttach(w.inner().cast());
            })?;
            let handle = app.handle().clone();''')
    replace(lib, "app.run(|app_handle, event|", "let mut app = app;\n    app.set_activation_policy(tauri::ActivationPolicy::Prohibited);\n    app.run(|app_handle, event|")
    replace(lib, "let data_root = p.app_data_dir()?;", 'let data_root = std::path::PathBuf::from(std::env::var_os("SCARLET_BENCH_CONTROL").expect("isolated benchmark directory"));')
    replace(lib, "let config_root = p.app_config_dir()?;", "let config_root = data_root.clone();")
    replace(lib, 'let log_dir = p.app_log_dir().unwrap_or_else(|_| data_root.join("logs"));',
            'let log_dir = data_root.join("logs");')
    replace(lib, '                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: Some("scarlet-desktop".into()) }),\n', '')
    replace(lib, 'data_dir: data_root.join("data"),', 'data_dir: std::path::PathBuf::from(std::env::var_os("SCARLET_BENCH_LIBRARY").expect("fixture clone")),')
    # The editor uses the normal engine, decoder and router. Do not claim any agent tasks from the copied database.
    replace(native / "src/engine.rs", "tauri::async_runtime::spawn(async move { host.configure(&url, &token).await });",
            "drop((host, url, token));")
    # Skip hot restarts while measuring. Keep the normal desktop:dev entry and embedded renderer.
    desktop = tree / "apps/desktop/package.json"
    package = json.loads(desktop.read_text())
    package["scripts"]["watch"] = "tauri dev --no-watch"
    desktop.write_text(json.dumps(package, indent=2))
    # A copy-on-write dependency cache avoids recompiling WebKit/Tauri for each pre/post checkout.
    source_cache = repo / "apps/desktop/src-tauri/target/debug"
    dest = work / "target/debug"
    dest.mkdir(parents=True)
    for name in [".fingerprint", "build", "deps"]:
        if (source_cache / name).is_dir():
            subprocess.run(["cp", "-cR", source_cache / name, dest / name], check=True)
    atomic(work / "manifest.json", {"repo": str(repo), "identifier": identifier})
    print(f"Prepared nonactivating native Scarlet in {work}", flush=True)


def other_preview():
    listing = subprocess.check_output(["ps", "-Aww", "-o", "pid=,comm="], text=True)
    for line in listing.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and Path(fields[1]).name == "scarlet-desktop" and fields[1] != "/Applications/Scarlet.app/Contents/MacOS/scarlet-desktop":
            return line.strip()
    for port in [5173, 5174]:
        proc = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], capture_output=True, text=True)
        if proc.stdout.strip():
            return f"Scarlet asset server at port {port}, PID {proc.stdout.strip()}"
    return None


def start(args):
    work, data = args.scratch, args.data.resolve()
    in_temp(work)
    in_temp(data)
    if not (data / "scarlet.db").is_file() or not (data / "projects" / args.project).is_dir():
        raise ValueError("Supply a disposable Scarlet library clone containing that project.")
    manifest = json.loads((work / "manifest.json").read_text())
    repo, tree = Path(manifest["repo"]), work / "checkout"
    lock = open(Path(tempfile.gettempdir()) / "scarlet-native-playback-preview.lock", "a+")
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    other = other_preview()
    if other:
        raise RuntimeError(f"Shared preview is in use: {other}")
    for name in ["ready.json", "request.json", "result.json", "fault.json", "stop"]:
        (work / name).unlink(missing_ok=True)
    cfg_file = tree / "apps/desktop/src-tauri/tauri.conf.json"
    cfg = json.loads(cfg_file.read_text())
    from urllib.parse import quote
    cfg["build"]["devUrl"] = f"http://127.0.0.1:{PORT}/p/{quote(args.project, safe='')}"
    config_text = json.dumps(cfg, indent=2)
    if cfg_file.read_text() != config_text:
        cfg_file.write_text(config_text)
    cmd = [str(args.engine.resolve())] if args.engine else [shutil.which("node"), str(repo / "apps/server/dist/cli.js")]
    env = {**os.environ, "CARGO_TARGET_DIR": str(work / "target"), "SCARLET_BENCH_CONTROL": str(work),
           "SCARLET_TELEMETRY_ENABLED": "false", "SCARLET_BENCH_LIBRARY": str(data), "SCARLET_ENGINE_CMD": shlex.join(cmd),
           "SCARLET_BENCH_DRAWABLE": "0" if args.ordered_out else "1",
           "SCARLET_BIN_DIR": os.environ.get("SCARLET_BIN_DIR", "/Applications/Scarlet.app/Contents/MacOS")}
    logfile = open(work / "native.log", "w")
    child = subprocess.Popen(["pnpm", "desktop:dev"], cwd=tree, env=env, stdout=logfile, stderr=subprocess.STDOUT, start_new_session=True)
    stopped = False
    def interrupt(_signum, _frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        print(f"Starting isolated native Scarlet; readiness file {work / 'ready.json'}", flush=True)
        while child.poll() is None and not stopped and not (work / "stop").exists():
            if (work / "fault.json").exists():
                raise RuntimeError((work / "fault.json").read_text())
            time.sleep(.1)
        if child.returncode and not stopped:
            raise RuntimeError(f"Native preview exited ({child.returncode}); see {work / 'native.log'}")
    finally:
        # Gracefully close the app so it owns shutdown of its sidecar, then release the dev command.
        ready = work / "ready.json"
        if ready.exists():
            pid = json.loads(ready.read_text()).get("nativePid")
            proc = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True)
            if str(work) in proc.stdout.strip():
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGTERM)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        logfile.close()
        ready.unlink(missing_ok=True)
        lock.close()


def run(args):
    work = args.scratch
    ready = json.loads((work / "ready.json").read_text())
    if (not (ready.get("nativeHidden") or ready.get("underDesktop")) or ready.get("nativeMain") or ready.get("nativeKey") or
        not ready.get("muted") or ready.get("activationPolicy") != 2):
        raise RuntimeError("The native surface has not certified focus and mute isolation.")
    config = json.loads(args.config.read_text())
    job = uuid.uuid4().hex
    shutil.copyfile(args.measure, work / "measure.js")
    atomic(work / "request.json", {"id": job, "config": config})
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if (work / "fault.json").exists():
            raise RuntimeError((work / "fault.json").read_text())
        path = work / "result.json"
        if path.is_file():
            response = json.loads(path.read_text())
            if response.get("id") == job:
                if response["error"]:
                    if response.get("json"):
                        atomic(args.result, {"surface": ready, "results": json.loads(response["json"]),
                                             "incomplete": True, "error": response["error"]})
                    raise RuntimeError(response["error"])
                result = json.loads(response["json"])
                atomic(args.result, {"surface": ready, "results": result})
                print(args.result)
                return
        time.sleep(.1)
    raise TimeoutError("Native measurement did not complete; stop the preview before retrying.")


def main():
    if sys.platform != "darwin":
        raise SystemExit("macOS only")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ["prepare", "start", "run", "capture", "stop"]:
        sub = commands.add_parser(action)
        sub.add_argument("scratch", type=lambda x: Path(x).resolve())
        if action == "prepare":
            sub.add_argument("--repo", type=Path, default=REPO)
        if action == "start":
            sub.add_argument("data", type=Path)
            sub.add_argument("project")
            sub.add_argument("--engine", type=Path)
            sub.add_argument("--ordered-out", action="store_true", help="Keep the window entirely hidden to test display-link suppression.")
        if action == "run":
            sub.add_argument("config", type=Path)
            sub.add_argument("result", type=Path)
            sub.add_argument("--measure", type=Path, default=HERE / "measure.js")
            sub.add_argument("--timeout", type=int, default=300)
        if action == "capture":
            sub.add_argument("grids", type=Path)
    args = parser.parse_args()
    in_temp(args.scratch)
    if args.action != "prepare":
        manifest = json.loads((args.scratch / "manifest.json").read_text())
        if not manifest.get("identifier", "").startswith("com.forwardfuture.scarlet.bench."):
            raise ValueError("Not a native benchmark scratch directory")
    if args.action == "stop":
        (args.scratch / "stop").touch()
    elif args.action == "capture":
        in_temp(args.grids)
        os.execv(args.scratch/"macos-pixels", [str(args.scratch/"macos-pixels"),
                 str(args.scratch/"ready.json"), str(args.grids)])
    else:
        {"prepare": prepare, "start": start, "run": run}[args.action](args)


if __name__ == "__main__":
    main()
