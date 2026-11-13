"""Opt-in macOS LaunchAgent that builds Scarlet main for this Mac."""

import contextlib
import ctypes
import fcntl
import json
import os
import platform
import plistlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path


APP_ID = "com.forwardfuture.scarlet"
LABEL = APP_ID + ".main-updater"
REPO = "https://github.com/Forward-Future/scarlet.git"
VERSION_SCRIPT = "apps/desktop/scripts/release-version.mjs"
APP = Path("/Applications/Scarlet.app")
LIBRARY = Path.home() / "Library"
CACHE = LIBRARY / "Caches" / (LABEL + ".noindex")
SOURCE = CACHE / "source"
PENDING = CACHE / "pending"
HELPER = LIBRARY / "Application Support" / LABEL / "update-macos.py"
AGENT = LIBRARY / "LaunchAgents" / (LABEL + ".plist")
LOG = LIBRARY / "Logs" / LABEL
GUI = f"gui/{os.getuid()}"
INTERVAL = 300
# How long a head whose build failed waits before it is built again: after its first failure, its second, and each
# one after that. A new commit on main never waits.
RETRY_SECONDS = (300, 1800, 7200)
# The head whose build last failed, how many times running, and when it may be built again. Lasts as long as the worker.
FAILED = {}
# A stalled step raises TimeoutExpired, so the worker logs it and retries instead of hanging.
BUILD_STEP_TIMEOUT = 3600
# How long each part of a build takes before this Mac has timed one. A finished build records its own times.
STEP_SECONDS = {"source": 5, "install": 10, "engine": 25, "bundle": 15, "media": 2, "app": 240, "verify": 15}
# Self-contained tools in the bundle that other programs on this Mac run by path.
MEDIA_TOOLS = {"ffmpeg", "ffprobe", "whisper-cli"}


class Restarting(Exception):
    """The editor chose to restart into the verified build. Whatever the worker was doing stops for it."""


def log(message):
    print(f"{datetime.now().isoformat(timespec='seconds')} {message}", flush=True)


def output(*args, cwd=None, attend=None):
    """What a command prints. Given an attendant, the app is looked after while the command runs."""
    if attend is None:
        return subprocess.check_output(args, cwd=cwd, text=True, timeout=90).strip()
    with tempfile.TemporaryFile(dir=CACHE) as reply:
        run_step(args, reply, attend, limit=90, stderr=None, cwd=cwd)
        reply.seek(0)
        return reply.read().decode().strip()


def revision(bundle):
    if bundle.is_symlink():
        raise ValueError(f"Unexpected application symlink at {bundle}")
    if not bundle.exists():
        return None
    with (bundle / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleIdentifier") != APP_ID:
        raise ValueError(f"Unexpected application at {bundle}")
    return info.get("ScarletSourceRevision")


def app_processes():
    """What the installed app has running. A media tool that a program outside the bundle started, such as a test
    borrowing its ffmpeg, is that program's: it runs on from the replaced files and doesn't hold up an installation."""
    prefix = str(APP / "Contents") + "/"
    rows = [line.split(None, 2) for line in output("/bin/ps", "-axww", "-o", "pid=,ppid=,comm=").splitlines()]
    ours = {row[0]: (row[1], Path(row[2]).name) for row in rows if len(row) == 3 and row[2].startswith(prefix)}
    return {name for parent, name in ours.values() if name not in MEDIA_TOOLS or parent == "1" or parent in ours}


def busy():
    return bool(app_processes())


def swap_in(candidate, destination):
    """The old bundle stays valid until the new directory takes its place."""
    if not destination.exists():
        candidate.rename(destination)
        return
    rename = ctypes.CDLL(None, use_errno=True).renamex_np
    rename.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
    if rename(os.fsencode(candidate), os.fsencode(destination), 2):  # Darwin RENAME_SWAP
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), str(destination))
    shutil.rmtree(candidate)


def write_status(status):
    """What the desktop app shows about a build under way. No file means no build."""
    path = CACHE / "status.json"
    if status is None:
        path.unlink(missing_ok=True)
        return
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(status))
    temp.replace(path)


class Progress:
    """How far along a build is, judged by how long each of its parts took last time on this Mac."""

    def __init__(self, commit):
        self.commit = commit
        self.expected = dict(STEP_SECONDS)
        try:
            for name, seconds in json.loads((CACHE / "build-times.json").read_text()).items():
                if name in self.expected and 0 < float(seconds) < BUILD_STEP_TIMEOUT:
                    self.expected[name] = float(seconds)
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        self.took = {}
        self.name = None

    def start(self, name):
        now = time.time()
        if self.name:
            self.took[self.name] = now - self.began
        self.name, self.began = name, now
        names, total = list(self.expected), sum(self.expected.values())
        write_status({"state": "building", "revision": self.commit,
                      "done": sum(self.expected[n] for n in names[:names.index(name)]) / total,
                      "step": self.expected[name] / total, "stepStarted": now, "stepSeconds": self.expected[name]})

    def finish(self):
        self.took[self.name] = time.time() - self.began
        temp = CACHE / "build-times.tmp"
        temp.write_text(json.dumps(self.took))
        temp.replace(CACHE / "build-times.json")


class Attendant:
    """Looks after the app for as long as the worker runs, so a verified build is on offer whatever the worker is doing.

    The editor can restart into the verified build from the window. Called between polls of a command, or while the
    worker waits for its next check; raises Restarting once the editor asks. During a build the verified build also
    installs as soon as regular Scarlet closes, so it isn't held up by the next one."""

    def __init__(self):
        self.offer = None
        self.look = 0
        self.check_requested = False

    def __call__(self, timeout, building=True):
        if time.monotonic() >= self.look:
            self.look = time.monotonic() + 3
            try:
                commit = revision(PENDING) if PENDING.exists() else None
                if commit and building and not busy():
                    self.close()
                    install()
                    commit = revision(PENDING) if PENDING.exists() else None
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                log(f"Installation failed. Will retry. {exc}")
                self.look = time.monotonic() + INTERVAL
                commit = None
            if commit != (self.offer and self.offer.commit):
                self.close()
                self.offer = Offer(commit) if commit else None
        if not self.offer:
            time.sleep(max(0, timeout))
            return
        action = self.offer.poll(timeout)
        if action == "check":
            self.check_requested = True
        elif action == "restart":
            self.close()
            raise Restarting()

    def answer(self, timeout):
        """Outside a build the worker installs by itself, once it has asked GitHub about main. Only answer the window."""
        self(timeout, building=False)

    def close(self):
        if self.offer:
            self.offer.close()
            self.offer = None


def run_step(args, transcript, attend, limit=BUILD_STEP_TIMEOUT, **options):
    """Run one command in its own process group, so stopping it also stops what it started."""
    options.setdefault("stderr", subprocess.STDOUT)
    process = subprocess.Popen(args, stdout=transcript, start_new_session=True, **options)
    deadline = time.monotonic() + limit
    try:
        while process.poll() is None:
            if time.monotonic() > deadline:
                raise subprocess.TimeoutExpired(args, limit)
            attend(0.5)
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args)
    finally:
        if process.poll() is None:
            for sign in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sign)
                    process.wait(timeout=5)
                    break
                except ProcessLookupError:
                    break
                except subprocess.TimeoutExpired:
                    continue


def node_bin():
    # The engine embeds Node itself. Homebrew's dynamically linked executable
    # lacks the SEA injection fuse. Pin the standalone distribution used here.
    name = f"node-v24.22.2-darwin-{'arm64' if platform.machine() == 'arm64' else 'x64'}"
    prefix = CACHE / name
    if not (prefix / "bin/node").is_file():
        expected = {"arm64": "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
                    "x86_64": "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52"}[platform.machine()]
        with tempfile.TemporaryDirectory(dir=CACHE) as folder:
            archive = Path(folder) / "node.tar.gz"
            subprocess.run(["/usr/bin/curl", "--fail", "--silent", "--show-error", "--location", "--retry", "2",
                            "--max-time", "180", "-o", archive, f"https://nodejs.org/dist/v24.22.2/{name}.tar.gz"], check=True)
            if output("/usr/bin/shasum", "-a", "256", archive).split()[0] != expected:
                raise ValueError("Node distribution checksum mismatch")
            subprocess.run(["/usr/bin/tar", "-xzf", archive, "-C", folder, name + "/bin/node"], check=True)
            (Path(folder) / name).rename(prefix)
    return prefix / "bin"


def build(transcript, head, attend):
    # Only this private clone is disposable. Keep the media tools whose hashes
    # are rechecked by fetch-ffmpeg.mjs and build-whisper.mjs on every build.
    if not SOURCE.exists():
        with tempfile.TemporaryDirectory(dir=CACHE) as folder:
            checkout = Path(folder) / "source"
            subprocess.run(["git", "clone", "--branch", "main", "--single-branch", "--no-tags", REPO, checkout],
                           check=True, stdout=transcript, stderr=subprocess.STDOUT, timeout=BUILD_STEP_TIMEOUT)
            checkout.rename(SOURCE)
    if SOURCE.is_symlink() or Path(output("git", "rev-parse", "--show-toplevel", cwd=SOURCE)) != SOURCE:
        raise ValueError("Expected the updater's private checkout")

    env = dict(os.environ, PATH=str(node_bin()) + ":" + os.environ["PATH"])
    progress = Progress(head)

    def run(*args):
        run_step(args, transcript, attend, cwd=SOURCE, env=env)

    try:
        progress.start("source")
        shallow = output("git", "rev-parse", "--is-shallow-repository", cwd=SOURCE) == "true"
        run("git", "fetch", *(["--unshallow"] if shallow else []), "--no-tags", REPO, "refs/heads/main")
        commit = progress.commit = output("git", "rev-parse", "FETCH_HEAD", cwd=SOURCE)
        candidate = CACHE / "target/release/bundle/macos/Scarlet.app"
        assemble(run, progress, commit, candidate)
        attend.look = 0  # The build just verified goes on offer at the next poll, not up to three seconds later.
    finally:
        write_status(None)


def clean_source(run):
    """Restore our own interrupted changes, including the plist left by older installed helpers."""
    old_head = output("git", "rev-parse", "HEAD", cwd=SOURCE)
    journal = CACHE / "build-version.json"
    if journal.exists():
        stamp = json.loads(journal.read_text())
        if stamp["revision"] != old_head or output("git", "diff", "HEAD", "--", VERSION_SCRIPT, cwd=SOURCE):
            raise ValueError("The source checkout changed during the previous build. Its files have been left in place.")
        run("node", VERSION_SCRIPT, "restore-stamp", stamp["version"])
    extra = SOURCE / "apps/desktop/src-tauri/Info.plist"
    if output("git", "diff", "--", "apps/desktop/src-tauri/Info.plist", cwd=SOURCE):
        original = subprocess.check_output(["git", "show", "HEAD:apps/desktop/src-tauri/Info.plist"], cwd=SOURCE)
        older = dict(plistlib.loads(original), ScarletSourceRevision=old_head)
        if extra.read_bytes() == plistlib.dumps(older):
            replacement = CACHE / "build-info.tmp"
            replacement.write_bytes(original)
            replacement.replace(extra)
    if output("git", "status", "--porcelain", "--untracked-files=normal", cwd=SOURCE):
        raise ValueError("The build checkout contains other changes. Its files have been left in place.")
    journal.unlink(missing_ok=True)


def assemble(run, progress, commit, candidate):
    clean_source(run)
    run("git", "reset", "--hard", commit)
    keep = []
    for name in ("ffmpeg-*", "ffprobe-*", ".pinned-media-*", "whisper-cli-*"):
        keep.extend(["-e", "/apps/desktop/src-tauri/binaries/" + name])
    # Other untracked files were rejected above; the -e patterns preserve verified media tool caches.
    run("git", "clean", "-ffdx", *keep)
    native = SOURCE / "apps/desktop/src-tauri"
    run("node", VERSION_SCRIPT, "check")
    version = output(str(node_bin() / "node"), VERSION_SCRIPT, "for-commit", cwd=SOURCE)
    journal = CACHE / "build-version.json"
    temp = journal.with_suffix(".tmp")
    temp.write_text(json.dumps({"revision": commit, "version": version}))
    temp.replace(journal)
    try:
        try:
            run("node", VERSION_SCRIPT, "set", version)
            build_app(run, progress, commit, candidate, native, version)
        finally:
            clean_source(run)
        # The old build stays available until both the bundle and its sources have been checked.
        progress.finish()
        swap_in(candidate, PENDING)
        log(f"Verified {commit}. Waiting for regular Scarlet to close before installation.")
    finally:
        if candidate.exists():
            shutil.rmtree(candidate)


def build_app(run, progress, commit, candidate, native, version):
    extra = native / "Info.plist"
    info = plistlib.loads(extra.read_bytes())
    info["ScarletSourceRevision"] = commit
    pending_info = CACHE / "build-info.tmp"
    pending_info.write_bytes(plistlib.dumps(info))
    pending_info.replace(extra)
    triple = {"arm64": "aarch64-apple-darwin", "x86_64": "x86_64-apple-darwin"}[platform.machine()]
    if candidate.exists():
        shutil.rmtree(candidate)
    progress.start("install")
    run("pnpm", "install", "--frozen-lockfile")
    progress.start("engine")
    run("pnpm", "--filter", "@scarlet/server...", "run", "build")
    progress.start("bundle")
    run("pnpm", "--filter", "@scarlet/server", "build:sea", "--out", native / "binaries" / ("scarlet-engine-" + triple))
    progress.start("media")
    run("pnpm", "desktop:ffmpeg")
    progress.start("app")
    run("pnpm", "--filter", "@scarlet/desktop", "exec", "tauri", "build", "--bundles", "app", "--config", "src-tauri/tauri.local-media.conf.json")
    progress.start("verify")
    if revision(candidate) != commit:
        raise ValueError("The finished app does not identify the requested main commit")
    packaged = plistlib.loads((candidate / "Contents/Info.plist").read_bytes())
    if packaged.get("CFBundleShortVersionString") != version:
        raise ValueError(f"The finished app does not identify the requested release {version}")
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", candidate)
    run("node", "apps/desktop/scripts/smoke-engine.mjs", candidate / "Contents/MacOS")


def check(attend):
    # GitHub answers in a second, or on a poor connection not for a minute and a half. The window is answered meanwhile.
    head = output("git", "ls-remote", "--exit-code", REPO, "refs/heads/main", attend=attend.answer).split()[0]
    if not re.fullmatch("[0-9a-f]{40}", head):
        raise ValueError("Unexpected main revision")
    current = revision(APP)
    if PENDING.exists() and current == head:
        shutil.rmtree(PENDING)
    # A verified build that main has moved past stays installable until the newer one is verified.
    if current != head and not (PENDING.exists() and revision(PENDING) == head):
        # A head that fails to build would otherwise be built every five minutes for as long as main stays on it.
        if FAILED.get("head") == head and time.monotonic() < FAILED["due"]:
            if not FAILED["said"]:
                FAILED["said"] = True
                count = "once" if FAILED["times"] == 1 else f"{FAILED['times']} times running"
                minutes = max(1, round((FAILED["due"] - time.monotonic()) / 60))
                log(f"Main is still at {head}, which has failed to build {count}. Building it again in {minutes} minutes, "
                    "or a newer commit as soon as main has one.")
            return False
        log(f"Building main at {head}. See {LOG / 'build.log'}")
        try:
            with (LOG / "build.log").open("w") as transcript:
                build(transcript, head, attend)
        except Restarting:
            log("Stopped the build to restart Scarlet into the verified one.")
            raise
        except (OSError, ValueError, subprocess.SubprocessError):
            times = FAILED["times"] + 1 if FAILED.get("head") == head else 1
            wait = RETRY_SECONDS[min(times, len(RETRY_SECONDS)) - 1]
            FAILED.update(head=head, times=times, due=time.monotonic() + wait, said=False)
            raise
        FAILED.clear()
        return True
    return False


def install():
    commit = revision(PENDING)
    if not commit or not re.fullmatch("[0-9a-f]{40}", commit):
        raise ValueError("Pending build has no main revision")
    if revision(APP) == commit:  # A previous installation finished before cleanup.
        shutil.rmtree(PENDING)
        return
    # Stage on the destination volume, including when the home is on another disk.
    with tempfile.TemporaryDirectory(prefix=".scarlet-update-", dir=APP.parent) as folder:
        staged = Path(folder) / "candidate"
        subprocess.run(["/usr/bin/ditto", PENDING, staged], check=True)
        if subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", staged]).returncode:
            shutil.rmtree(PENDING)
            raise ValueError("Discarded a damaged update. The next check will rebuild it.")
        if busy():
            return
        swap_in(staged, APP)
    shutil.rmtree(PENDING)
    log(f"Installed {commit} at {APP}.")


class Offer:
    """Only a verified pending build can accept a restart from the desktop UI."""

    def __init__(self, commit):
        self.commit = commit
        self.address = CACHE / "ready.sock"
        self.address.unlink(missing_ok=True)
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.listener.bind(str(self.address))
            self.listener.listen(4)
        except OSError:
            self.close()
            raise

    def poll(self, timeout):
        """Answer one window. Return the action that needs the worker's attention, if any."""
        self.listener.settimeout(max(0.01, timeout))
        try:
            client, _ = self.listener.accept()
        except socket.timeout:
            return None
        with client:
            client.settimeout(2)
            try:
                with client.makefile("rb") as stream:
                    message = stream.readline(64)
                if message == b"ready\n":
                    client.sendall((self.commit + "\n").encode())
                elif re.fullmatch(rb"check [0-9a-f]{40}\n", message):
                    client.sendall(b"ok\n")
                    if message != f"check {self.commit}\n".encode():
                        return "check"
                elif message == f"restart {self.commit}\n".encode() and revision(PENDING) == self.commit:
                    intent = CACHE / "restart"
                    temp = intent.with_suffix(".tmp")
                    temp.write_text(self.commit)
                    temp.replace(intent)
                    try:
                        client.sendall(b"accepted\n")
                    except OSError:
                        intent.unlink(missing_ok=True)
                        raise
                    return "restart"
                else:
                    client.sendall(b"stale\n")
            except OSError:
                pass  # A window may close while its status check is in flight.
        return None

    def close(self):
        self.listener.close()
        self.address.unlink(missing_ok=True)


def offer_update(attend, deadline):
    """Wait for the next check with the verified build on offer, for as long as regular Scarlet stays open."""
    try:
        while not attend.check_requested and time.monotonic() < deadline and busy():
            attend.answer(min(3, deadline - time.monotonic()))
    except Restarting:
        pass  # The worker's loop finds the accepted restart and finishes it.


def finish_restart(intent):
    """Resume the accepted handoff even if launchd restarted the worker."""
    commit = intent.read_text()
    age = time.time() - intent.stat().st_mtime
    if age > 600 or not re.fullmatch("[0-9a-f]{40}", commit):
        intent.unlink(missing_ok=True)
        return
    if revision(APP) != commit and busy() and age < 90:
        time.sleep(1)
        return
    try:
        if not busy() and revision(APP) != commit and revision(PENDING) == commit:
            install()
        if revision(APP) != commit:
            log("Restart handoff could not install the requested build. Reopening the current installation.")
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        log(f"Restart handoff failed: {exc}")
    # A failed swap still leaves the previous application available to reopen.
    if APP.exists() and subprocess.run(["/usr/bin/open", str(APP)]).returncode == 0:
        intent.unlink(missing_ok=True)
    else:
        time.sleep(3)


def watch():
    CACHE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.environ.update(CARGO_TARGET_DIR=str(CACHE / "target"), GIT_TERMINAL_PROMPT="0", CI="true")
    # One attendant for as long as the worker runs: a verified build stays on offer while GitHub is asked and from one
    # build to the next, not only between checks. It is closed where the worker installs or rests, answering no one.
    with (CACHE / "worker.lock").open("w") as lock, contextlib.closing(Attendant()) as attend:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # A build runs in its own process group. Leave through its cleanup when launchd stops the worker.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        write_status(None)
        next_check = 0
        intent = CACHE / "restart"
        while True:
            if intent.exists():
                attend.close()
                finish_restart(intent)
                continue
            if time.monotonic() >= next_check or attend.check_requested:
                attend.check_requested = False
                try:
                    if check(attend):
                        continue  # main can advance during a long build.
                except Restarting:
                    continue
                except (OSError, ValueError, subprocess.SubprocessError) as exc:
                    log(f"Update check failed. Will retry. {exc}")
                next_check = time.monotonic() + INTERVAL
            if PENDING.exists():
                try:
                    if busy():
                        offer_update(attend, next_check)
                        continue
                    # The user may quit between polls, after main has moved.
                    try:
                        if check(attend):
                            continue
                    except (OSError, ValueError, subprocess.SubprocessError) as exc:
                        # The verified build needs nothing from GitHub to install.
                        log(f"Update check failed. Will retry. {exc}")
                        next_check = time.monotonic() + INTERVAL
                    if PENDING.exists():
                        attend.close()
                        install()
                except Restarting:
                    continue
                except (OSError, ValueError, subprocess.SubprocessError) as exc:
                    attend.close()
                    log(f"Installation failed. Will retry. {exc}")
                    time.sleep(INTERVAL)
                    continue
            # No build is waiting, or Scarlet opened as one was about to go in.
            attend.close()
            wait = max(1, next_check - time.monotonic())
            time.sleep(min(wait, 3) if PENDING.exists() else wait)


def stop_service():
    service = GUI + "/" + LABEL
    if subprocess.run(["launchctl", "print", service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        subprocess.run(["launchctl", "bootout", service], check=True)


def configure(enable):
    if not enable:
        stop_service()
        AGENT.unlink(missing_ok=True)
        log("Automatic main updates are disabled.")
        return
    HELPER.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    AGENT.parent.mkdir(parents=True, exist_ok=True)
    LOG.mkdir(mode=0o700, parents=True, exist_ok=True)
    if Path(__file__).resolve() != HELPER:
        shutil.copyfile(__file__, HELPER.with_suffix(".tmp"))
        HELPER.with_suffix(".tmp").replace(HELPER)
    # A GUI login has a minimal PATH. Record the build tools selected at enrollment.
    paths = [str(Path(shutil.which(tool) or sys.exit(f"Missing required tool: {tool}")).parent)
             for tool in ("node", "pnpm", "cargo", "rustc", "cmake", "git")]
    paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    plist = {"Label": LABEL, "ProgramArguments": ["/usr/bin/python3", "-u", str(HELPER), "watch"],
             "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 60, "ProcessType": "Background",
             "EnvironmentVariables": {"PATH": ":".join(dict.fromkeys(paths))},
             "StandardOutPath": str(LOG / "updater.log"), "StandardErrorPath": str(LOG / "updater.log")}
    AGENT.with_suffix(".tmp").write_bytes(plistlib.dumps(plist))
    AGENT.with_suffix(".tmp").replace(AGENT)
    stop_service()
    subprocess.run(["launchctl", "bootstrap", GUI, AGENT], check=True)
    log(f"Automatic main updates enabled. Log: {LOG / 'updater.log'}")


if __name__ == "__main__":
    if sys.platform != "darwin" or sys.argv[1:] not in (["enable"], ["disable"], ["watch"]):
        sys.exit("Usage on macOS: update-macos.py enable | disable | watch")
    os.umask(0o022)
    if sys.argv[1] == "watch":
        watch()
    else:
        configure(sys.argv[1] == "enable")
