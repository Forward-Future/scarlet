#!/usr/bin/env python3
"""Measure the native Windows Scarlet shell on an isolated, never-selected desktop.

Build the shell with windows-tauri.conf.json, stage a disposable local library with
prepare-playback-fixture.mjs, then run this script on that Windows machine. The
sidecars directory must contain the matching engine, ffmpeg and ffprobe. No
installer, system audio change, browser launch or physical input is used.
"""
import argparse
import ctypes as C
from ctypes import wintypes as W
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
BENCH_ID = "com.forwardfuture.scarlet.playbackbench.portable.v1"


class StartupInfo(C.Structure):
    _fields_ = [("cb", W.DWORD), ("reserved", W.LPWSTR), ("lpDesktop", W.LPWSTR), ("title", W.LPWSTR),
                ("x", W.DWORD), ("y", W.DWORD), ("width", W.DWORD), ("height", W.DWORD),
                ("cols", W.DWORD), ("rows", W.DWORD), ("fill", W.DWORD), ("flags", W.DWORD),
                ("show", W.WORD), ("reservedSize", W.WORD), ("reservedBytes", C.c_void_p),
                ("stdin", W.HANDLE), ("stdout", W.HANDLE), ("stderr", W.HANDLE)]


class ProcessInfo(C.Structure):
    _fields_ = [("process", W.HANDLE), ("thread", W.HANDLE), ("pid", W.DWORD), ("tid", W.DWORD)]


class BasicLimits(C.Structure):
    _fields_ = [("processTime", C.c_int64), ("jobTime", C.c_int64), ("flags", W.DWORD),
                ("minWorking", C.c_size_t), ("maxWorking", C.c_size_t), ("active", W.DWORD),
                ("affinity", C.c_size_t), ("priority", W.DWORD), ("scheduling", W.DWORD)]


class JobLimits(C.Structure):
    _fields_ = [("basic", BasicLimits), ("io", C.c_uint64 * 6), ("processMemory", C.c_size_t),
                ("jobMemory", C.c_size_t), ("peakProcess", C.c_size_t), ("peakJob", C.c_size_t)]


def checked(value):
    if not value:
        raise C.WinError(C.get_last_error())
    return value


class PrivateDesktop:
    """The job is assigned before the suspended process can create any children."""
    def __init__(self):
        kernel = C.WinDLL("kernel32", use_last_error=True)
        user = C.WinDLL("user32", use_last_error=True)

        def bind(dll, name, result, *args):
            fn = getattr(dll, name)
            fn.restype, fn.argtypes = result, args
            setattr(self, name, fn)

        self.enum_callback = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        bind(user, "CreateDesktopW", W.HANDLE, W.LPCWSTR, C.c_void_p, C.c_void_p, W.DWORD, W.DWORD, C.c_void_p)
        bind(user, "CloseDesktop", W.BOOL, W.HANDLE)
        bind(user, "GetThreadDesktop", W.HANDLE, W.DWORD)
        bind(user, "SetThreadDesktop", W.BOOL, W.HANDLE)
        bind(user, "EnumDesktopWindows", W.BOOL, W.HANDLE, self.enum_callback, W.LPARAM)
        bind(user, "GetWindowThreadProcessId", W.DWORD, W.HWND, C.POINTER(W.DWORD))
        bind(user, "PostMessageW", W.BOOL, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
        bind(kernel, "GetCurrentThreadId", W.DWORD)
        bind(kernel, "CreateMutexW", W.HANDLE, C.c_void_p, W.BOOL, W.LPCWSTR)
        bind(kernel, "CreateJobObjectW", W.HANDLE, C.c_void_p, W.LPCWSTR)
        bind(kernel, "SetInformationJobObject", W.BOOL, W.HANDLE, C.c_int, C.c_void_p, W.DWORD)
        bind(kernel, "CreateProcessW", W.BOOL, W.LPCWSTR, W.LPWSTR, C.c_void_p, C.c_void_p, W.BOOL,
             W.DWORD, C.c_void_p, W.LPCWSTR, C.POINTER(StartupInfo), C.POINTER(ProcessInfo))
        bind(kernel, "AssignProcessToJobObject", W.BOOL, W.HANDLE, W.HANDLE)
        bind(kernel, "TerminateJobObject", W.BOOL, W.HANDLE, W.UINT)
        bind(kernel, "IsProcessInJob", W.BOOL, W.HANDLE, W.HANDLE, C.POINTER(W.BOOL))
        bind(kernel, "OpenProcess", W.HANDLE, W.DWORD, W.BOOL, W.DWORD)
        bind(kernel, "ResumeThread", W.DWORD, W.HANDLE)
        bind(kernel, "TerminateProcess", W.BOOL, W.HANDLE, W.UINT)
        bind(kernel, "WaitForSingleObject", W.DWORD, W.HANDLE, W.DWORD)
        bind(kernel, "CloseHandle", W.BOOL, W.HANDLE)
        self.name = "ScarletPlayback-" + uuid.uuid4().hex
        self.desktop = self.job = self.process = self.preview_lock = None
        self.pid = None

    def __enter__(self):
        # The named object's lifetime spans this preview. Two concurrent drivers
        # cannot both pass the ordinary preflight before either window appears.
        C.set_last_error(0)
        self.preview_lock = checked(self.CreateMutexW(None, False, "Local\\ScarletNativePlaybackBenchmark"))
        try:
            if C.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                raise RuntimeError("Another private Scarlet benchmark is already running.")
            previous = checked(self.GetThreadDesktop(self.GetCurrentThreadId()))
            # This handle has no DESKTOP_SWITCHDESKTOP right. SetThreadDesktop
            # restores the worker thread's association, never the input desktop.
            self.desktop = checked(self.CreateDesktopW(self.name, None, None, 0, 0x0043, None))
            checked(self.SetThreadDesktop(previous))
            self.job = checked(self.CreateJobObjectW(None, None))
            limits = JobLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            checked(self.SetInformationJobObject(self.job, 9, C.byref(limits), C.sizeof(limits)))
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def start(self, exe, env):
        info, process = StartupInfo(), ProcessInfo()
        info.cb, info.lpDesktop = C.sizeof(info), self.name
        info.flags, info.show = 1, 4  # STARTF_USESHOWWINDOW, SW_SHOWNOACTIVATE
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(exe), "--mute-audio"]))
        block = C.create_unicode_buffer("\0".join(f"{k}={v}" for k, v in sorted(env.items(), key=lambda x: x[0].upper())) + "\0\0")
        checked(self.CreateProcessW(str(exe), command, None, None, False,
                                    0x00000004 | 0x00000400 | 0x08000000,  # suspended, Unicode env, no console
                                    block, str(exe.parent), C.byref(info), C.byref(process)))
        self.process, self.pid = process.process, process.pid
        try:
            checked(self.AssignProcessToJobObject(self.job, process.process))
            if self.ResumeThread(process.thread) == 0xFFFFFFFF:
                raise C.WinError(C.get_last_error())
        except BaseException:
            self.TerminateProcess(process.process, 1)
            raise
        finally:
            self.CloseHandle(process.thread)

    def contains(self, pid):
        handle = self.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            member = W.BOOL()
            checked(self.IsProcessInJob(handle, self.job, C.byref(member)))
            return bool(member.value)
        finally:
            self.CloseHandle(handle)

    def app_windows(self):
        windows = []

        @self.enum_callback
        def collect(window, _):
            pid = W.DWORD()
            self.GetWindowThreadProcessId(window, C.byref(pid))
            if pid.value == self.pid:
                windows.append(window)
            return True

        self.EnumDesktopWindows(self.desktop, collect, 0)
        return windows

    def __exit__(self, *_):
        if self.process and self.desktop:
            for window in self.app_windows():
                self.PostMessageW(window, 0x0010, 0, 0)  # WM_CLOSE, private Scarlet only
            self.WaitForSingleObject(self.process, 5000)
        if self.job:
            self.TerminateJobObject(self.job, 1)
            self.CloseHandle(self.job)
        if self.process:
            self.WaitForSingleObject(self.process, 10000)
            self.CloseHandle(self.process)
        if self.desktop:
            self.CloseDesktop(self.desktop)
        if self.preview_lock:
            self.CloseHandle(self.preview_lock)


def powershell(script):
    exe = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(exe), "-NoProfile", "-NonInteractive", "-Command",
                             "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script],
                            capture_output=True, encoding="utf8",
                            check=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
    return result.stdout.strip()


def local_path(path):
    location = path.resolve()
    if str(location).startswith("\\\\"):
        return False
    get_drive_type = C.WinDLL("kernel32").GetDriveTypeW
    get_drive_type.argtypes, get_drive_type.restype = [W.LPCWSTR], W.UINT
    return get_drive_type(location.anchor) in (2, 3, 6)  # removable, fixed, RAM


def arguments(command):
    shell = C.WinDLL("shell32", use_last_error=True)
    parse = shell.CommandLineToArgvW
    parse.argtypes, parse.restype = [W.LPCWSTR, C.POINTER(C.c_int)], C.POINTER(W.LPWSTR)
    n = C.c_int()
    values = checked(parse(command, C.byref(n)))
    try:
        return list(values[:n.value])
    finally:
        free = C.WinDLL("kernel32").LocalFree
        free.argtypes, free.restype = [C.c_void_p], C.c_void_p
        free(values)


def certify(surface, profile, port):
    # Inspect command-line flags only after establishing that the listener belongs
    # to this process tree. Other apps' WebViews and user profiles are out of scope.
    rows = json.loads(powershell(f"ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort {port} | Select-Object LocalAddress,OwningProcess)"))
    if not rows or not all(ipaddress.ip_address(r["LocalAddress"]).is_loopback for r in rows):
        raise RuntimeError("Benchmark CDP is not bound exclusively to loopback.")
    owners = {int(row["OwningProcess"]) for row in rows}
    if len(owners) != 1 or not surface.contains(next(iter(owners))):
        raise RuntimeError("The listener does not belong to the isolated Scarlet job.")
    pid = owners.pop()
    row = json.loads(powershell(f"Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress"))
    flags = arguments(row["CommandLine"])
    udf = next((Path(s.split("=", 1)[1]).resolve() for s in flags if s.startswith("--user-data-dir=")), None)
    if row["Name"].lower() != "msedgewebview2.exe" or "--mute-audio" not in flags:
        raise RuntimeError("The isolated WebView2 browser process did not confirm --mute-audio.")
    if not udf or not (udf == profile or profile in udf.parents):
        raise RuntimeError("WebView2 is not using the disposable profile.")
    if not surface.app_windows():
        raise RuntimeError("The Scarlet window was not found on its private desktop.")
    return pid


def require_fixture(root):
    temp = Path(tempfile.gettempdir()).resolve()
    if temp not in root.parents or str(root).startswith("\\\\"):
        raise ValueError("Use a disposable local fixture under the Windows temp directory.")
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8-sig"))
    if not (root / "data/scarlet.db").is_file() or manifest.get("cache", {}).get("pausedInitially") is not True:
        raise ValueError("Use a fixture created by prepare-playback-fixture.mjs.")
    if (root / "data").resolve().parent != root or (root / "data/scarlet.db").resolve().parent != root / "data":
        raise ValueError("The fixture database must be owned by the disposable root.")
    # The public driver may also receive an already staged local fixture.
    # Windows directory junctions must not redirect engine writes to a real project.
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(folder) / name
            if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
                raise ValueError("Refusing a fixture containing a symbolic link or reparse point.")
    with sqlite3.connect((root / "data/scarlet.db").as_uri() + "?mode=ro", uri=True) as db:
        projects = db.execute("SELECT id FROM projects").fetchall()
        if projects != [(manifest["projectId"],)]:
            raise ValueError("Expected the one-project playback fixture.")
        if db.execute("SELECT 1 FROM tasks WHERE state NOT IN ('done','failed','cancelled') LIMIT 1").fetchone():
            raise ValueError("Refusing to start a benchmark with runnable agent tasks.")
    return manifest


def stage_binary(exe, engine, media_tools, destination):
    # The portable identifier is embedded only by windows-tauri.conf.json.
    # A regular Scarlet installation must never be launched as a test.
    if BENCH_ID.encode() not in exe.read_bytes():
        raise ValueError("Build the separate shell with windows-tauri.conf.json first.")
    if not engine.is_file() or engine.stat().st_size < 1024:
        raise ValueError("Supply the matched Windows engine.")
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        if not (media_tools / name).is_file() or (media_tools / name).stat().st_size < 1024:
            raise ValueError(f"The local sidecars directory lacks {name}.")
    app = destination / "scarlet-desktop.exe"
    shutil.copy2(exe, app)
    shutil.copy2(engine, destination / "scarlet-engine.exe")
    for name in ("ffmpeg.exe", "ffprobe.exe", "whisper-cli.exe"):
        if (media_tools / name).is_file():
            shutil.copy2(media_tools / name, destination / name)
    for src in sorted(media_tools.glob("*.dll")) + sorted(exe.parent.glob("*.dll")):
        shutil.copy2(src, destination / src.name)
    return app


@contextmanager
def private_runtime(root):
    runtime = tempfile.TemporaryDirectory(prefix="playback-runtime-", dir=root)
    try:
        yield Path(runtime.name).resolve()
    finally:
        # WebView2 children may hold UDF files briefly after terminating their job.
        for attempt in range(10):
            try:
                runtime.cleanup()
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.25)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True, help="Portable benchmark build of scarlet-desktop.exe")
    parser.add_argument("--engine", type=Path, help="Matching SEA for this variant; defaults to the sidecars directory")
    parser.add_argument("--sidecars", type=Path, required=True, help="Matching local packaged engine and media tools")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--config", type=Path, help="Optional shared measure.js configuration JSON")
    parser.add_argument("--project-id", help="Defaults to the fixture's projectId")
    parser.add_argument("--project-url", help="Optional native /p/<projectId> route")
    parser.add_argument("--cache-stage", choices=["current", "during", "after"], default="current")
    parser.add_argument("--cache-target", help="Local fixture video used for the measured cache job")
    parser.add_argument("--timeout", type=int, default=900, help="Measurement wall-time limit in seconds")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Run on the Windows machine containing the footage.")
    root, out = args.fixture.resolve(), args.out.resolve()
    if not all(local_path(path) for path in (root, out, args.app, args.sidecars, args.engine or args.sidecars)):
        raise ValueError("Use local Windows volumes for all fixture, binary and result paths.")
    manifest = require_fixture(root)
    project = args.project_id or manifest["projectId"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", project) or project != manifest["projectId"] or not (root / "data/projects" / project).is_dir():
        raise ValueError("Project must match the selected disposable fixture.")
    if out.exists() or root in out.parents or not out.parent.is_dir():
        raise ValueError("Provide a new output file outside the fixture in an existing directory.")
    node = shutil.which("node.exe")
    if not node:
        raise RuntimeError("Node 22+ is required for the embedded WebView2 telemetry connection.")
    config = json.loads(args.config.read_text(encoding="utf-8-sig")) if args.config else {
        "fps": manifest["settings"]["fps"], "scrubTimes": manifest["scrubTimes"], "cutTimes": manifest["cutTimes"]}
    config["projectId"] = project
    target = args.cache_target or manifest["cache"].get("target")
    if args.cache_target and not any(a.get("id")==target and a.get("kind")=="video" for a in manifest["assets"]):
        raise ValueError("The measured cache target must be a video in this disposable fixture.")
    config.setdefault("cacheMediaIds", [target] if target else [])
    if args.cache_stage != "current" and not target:
        raise ValueError("This fixture has no missing proxy to build or verify.")
    with socket.socket() as lease:
        lease.bind(("127.0.0.1", 0))
        port = lease.getsockname()[1]
    # Keep one native preview per Windows user; do not touch an existing editor.
    if powershell("Get-CimInstance Win32_Process -Filter \"Name='scarlet-desktop.exe'\" | Select-Object -ExpandProperty ProcessId"):
        raise RuntimeError("Another Scarlet window is running. Wait for it to close before testing.")
    gpu = json.loads(powershell("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion)"))
    with private_runtime(root) as folder:
        engine = (args.engine or args.sidecars / "scarlet-engine.exe").resolve()
        app = stage_binary(args.app.resolve(), engine, args.sidecars.resolve(), folder)
        profile = folder / "webview-profile"
        profile.mkdir()
        options = folder / "measurement.json"
        options.write_text(json.dumps({"config": config, "data": str(root / "data"), "stage": args.cache_stage,
                                       "enginePath": str(folder / "scarlet-engine.exe"),
                                       "cacheTarget": target, "projectUrl": args.project_url,
                                       "timeoutMs": args.timeout * 1000}), encoding="utf8")
        env = {**os.environ, "SCARLET_FFMPEG": str(folder / "ffmpeg.exe"), "SCARLET_FFPROBE": str(folder / "ffprobe.exe"),
               "SCARLET_TELEMETRY_ENABLED": "false", "WEBVIEW2_USER_DATA_FOLDER": str(profile),
               "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": f"--mute-audio --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"}
        with PrivateDesktop() as surface:
            surface.start(app, env)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if surface.WaitForSingleObject(surface.process, 0) == 0:
                    raise RuntimeError("Scarlet exited before its private WebView2 could be verified.")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=.25):
                        break
                except OSError:
                    time.sleep(.2)
            else:
                raise TimeoutError("No isolated WebView2 listener; no measurements were attempted.")
            browser_pid = certify(surface, profile, port)
            result = folder / "telemetry.json"
            subprocess.run([node, str(HERE / "windows-cdp.mjs"), str(port), str(options), str(result)],
                           creationflags=subprocess.CREATE_NO_WINDOW, check=True, timeout=args.timeout + 60)
            if certify(surface, profile, port) != browser_pid:
                raise RuntimeError("The isolated WebView2 restarted during measurement.")
            report = {"surface": {"platform": "windows", "nativeWebView2": True, "isolatedDesktop": True,
                                  "windowsBuild": sys.getwindowsversion().build, "installedAdapters": gpu,
                                  "verifiedMuteFlag": True, "disposableProfile": True,
                                  "desktopSha256": hashlib.sha256(app.read_bytes()).hexdigest(),
                                  "engineSha256": hashlib.sha256((folder / "scarlet-engine.exe").read_bytes()).hexdigest()},
                      "cacheStage": args.cache_stage, "results": json.loads(result.read_text(encoding="utf8"))}
            with out.open("x", encoding="utf8") as file:
                json.dump(report, file, indent=2)
    print(out)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
