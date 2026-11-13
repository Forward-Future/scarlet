import importlib.util
import json
import os
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


if sys.platform == "darwin":
    spec = importlib.util.spec_from_file_location("updater", Path(__file__).with_name("update-macos.py"))
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)


class Clock:
    """Stands in for the updater's clock, so hours of its five-minute checks take no time."""

    def __init__(self):
        self.now = 0.0
        self.reads = 0

    def monotonic(self):
        self.reads += 1
        if self.reads > 100000:
            raise AssertionError("The updater keeps going around without waiting")
        return self.now

    def sleep(self, seconds):
        if seconds < 0:
            raise ValueError("sleep length must be non-negative")
        self.now += seconds


class Timed:
    """The real clock, for a run of the worker's loop that must end even when the test goes wrong."""

    def __init__(self, seconds):
        self.until = time.monotonic() + seconds
        self.time, self.sleep = time.time, time.sleep

    def monotonic(self):
        now = time.monotonic()
        if now > self.until:
            raise AssertionError("The updater's loop was still running when the test should have been over")
        return now


@unittest.skipUnless(sys.platform == "darwin", "uses macOS code signing and directory exchange")
class UpdateTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        replacements = patch.multiple(updater, APP=root / "Scarlet.app", PENDING=root / "pending", LOG=root, CACHE=root,
                                      FAILED={})
        replacements.start()
        self.addCleanup(replacements.stop)
        for bundle, commit in [(updater.APP, "a" * 40), (updater.PENDING, "b" * 40)]:
            contents = bundle / "Contents"
            (contents / "MacOS").mkdir(parents=True)
            info = {"CFBundleIdentifier": "com.forwardfuture.scarlet", "CFBundleExecutable": "scarlet-desktop",
                    "CFBundlePackageType": "APPL", "ScarletSourceRevision": commit}
            (contents / "Info.plist").write_bytes(plistlib.dumps(info))
            shutil.copy("/usr/bin/true", contents / "MacOS/scarlet-desktop")
            subprocess.run(["codesign", "--force", "--sign", "-", bundle], check=True, stderr=subprocess.DEVNULL)

    def watch(self):
        """The worker's loop, kept from taking over this process's signals and environment."""
        with patch.object(updater.signal, "signal"), patch.dict(os.environ):
            updater.watch()

    def test_waits_for_regular_helpers_but_review_can_stay_open(self):
        review = str(updater.APP.with_name("Scarlet Episode Review.app") / "Contents/MacOS/scarlet-desktop")
        helper = str(updater.APP / "Contents/MacOS/ffmpeg")
        engine = str(updater.APP / "Contents/MacOS/scarlet-engine")

        def running(*rows):
            return patch.object(updater, "output", return_value="\n".join(f"{pid:>5} {parent:>5} {path}" for pid, parent, path in rows))

        with running((10, 1, review)):
            self.assertFalse(updater.busy())
        with running((10, 1, review), (20, 1, engine), (21, 20, helper)):
            self.assertEqual(updater.app_processes(), {"scarlet-engine", "ffmpeg"})
        with running((21, 1, helper)):  # Its engine is gone, and it may still be writing the editor's media.
            self.assertTrue(updater.busy())

    def test_a_media_tool_another_program_borrowed_does_not_hold_up_installation(self):
        helper = str(updater.APP / "Contents/MacOS/ffmpeg")
        engine = str(updater.APP / "Contents/MacOS/scarlet-engine")
        rows = "  300     1 /opt/homebrew/bin/node\n  301   300 " + helper
        with patch.object(updater, "output", return_value=rows):
            self.assertFalse(updater.busy())
        # The app and its engine always count, however they were started.
        with patch.object(updater, "output", return_value=rows + "\n  302   300 " + engine):
            self.assertEqual(updater.app_processes(), {"scarlet-engine"})

    def test_quit_installs_at_same_path_and_cleans_candidate(self):
        with patch.object(updater, "busy", return_value=True):
            updater.install()
        self.assertEqual(updater.revision(updater.APP), "a" * 40)
        self.assertTrue(updater.PENDING.exists())
        with patch.object(updater, "busy", return_value=False):
            updater.install()
        self.assertEqual(updater.revision(updater.APP), "b" * 40)
        self.assertEqual(list(updater.APP.parent.iterdir()), [updater.APP])
        subprocess.run(["codesign", "--verify", "--deep", "--strict", updater.APP], check=True)

    def test_damaged_update_preserves_installation(self):
        (updater.PENDING / "Contents/MacOS/scarlet-desktop").write_bytes(b"damaged")
        with self.assertRaisesRegex(ValueError, "damaged update"):
            updater.install()
        self.assertFalse(updater.PENDING.exists())
        self.assertEqual(updater.revision(updater.APP), "a" * 40)

    def test_click_claims_only_the_offered_revision_then_installs_and_reopens(self):
        commit = "b" * 40
        address = updater.CACHE / "ready.sock"
        intent = updater.CACHE / "restart"

        def exchange(message):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(2)
                client.connect(str(address))
                client.sendall((message + "\n").encode())
                return client.recv(64).decode().strip()

        with patch.object(updater, "busy", return_value=True):
            worker = threading.Thread(target=updater.offer_update, args=(updater.Attendant(), time.monotonic() + 5))
            worker.start()
            try:
                for _ in range(100):
                    if address.exists():
                        break
                    time.sleep(0.01)
                self.assertEqual(exchange("ready"), commit)
                self.assertEqual(exchange("restart " + "c" * 40), "stale")
                self.assertFalse(intent.exists())
                with patch.object(updater, "app_processes", return_value={"ffmpeg", "whisper-cli"}):
                    self.assertEqual(exchange("restart " + commit), "accepted")
            finally:
                worker.join(6)
        self.assertFalse(address.exists())
        self.assertEqual(intent.read_text(), commit)
        run = subprocess.run
        opened = []

        def capture_open(args, **kwargs):
            if args[0] == "/usr/bin/open":
                opened.append((args[1], updater.revision(updater.APP)))
                return subprocess.CompletedProcess(args, 0)
            return run(args, **kwargs)

        with patch.object(updater, "busy", return_value=False), patch.object(subprocess, "run", side_effect=capture_open):
            updater.finish_restart(intent)
        self.assertEqual(opened, [(str(updater.APP), commit)])
        self.assertFalse(intent.exists())

    def test_new_head_keeps_the_verified_build_until_a_newer_one_is(self):
        head = "c" * 40
        with patch.object(updater, "output", return_value=head + "\trefs/heads/main"), \
                patch.object(updater, "build", side_effect=OSError("failed build")) as build, self.assertRaises(OSError):
            updater.check(updater.Attendant())
        self.assertEqual(build.call_args.args[1], head)
        self.assertEqual(updater.revision(updater.PENDING), "b" * 40)
        self.assertEqual(updater.revision(updater.APP), "a" * 40)
        # Once main is installed, a build it has moved past is of no use.
        with patch.object(updater, "output", return_value="a" * 40 + "\trefs/heads/main"):
            self.assertFalse(updater.check(updater.Attendant()))
        self.assertFalse(updater.PENDING.exists())

    def test_a_head_that_failed_to_build_waits_longer_each_time_and_a_new_head_builds_at_once(self):
        clock = Clock()
        attend = updater.Attendant()
        main, outcomes, built, said = ["c" * 40], [], [], []
        failure = subprocess.CalledProcessError(1, "pnpm")

        def build(transcript, head, worker):
            self.assertIs(worker, attend)
            built.append((head[0], int(clock.now / 60)))
            outcome = outcomes.pop(0) if outcomes else failure
            if outcome:
                raise outcome

        def check_every_five_minutes(times):
            for _ in range(times):
                try:
                    updater.check(attend)
                except (subprocess.CalledProcessError, updater.Restarting):
                    pass
                clock.now += 300

        with patch.object(updater, "time", clock), patch.object(updater, "log", side_effect=said.append), \
                patch.object(updater, "output", side_effect=lambda *args, **_: main[0] + "\trefs/heads/main"), \
                patch.object(updater, "build", side_effect=build):
            # Six hours with main at a head that fails: built again after 5 minutes, then 30, then every 2 hours.
            check_every_five_minutes(72)
            self.assertEqual(built, [("c", 0), ("c", 5), ("c", 35), ("c", 155), ("c", 275)])
            # Each wait is said once, however many checks pass during it.
            waits = [line for line in said if "again in" in line]
            self.assertEqual(len(waits), 4)
            self.assertIn("c" * 40, waits[0])
            self.assertIn("again in 25 minutes", waits[0])
            # A new head builds at the next check, and its failures are counted from one.
            main[0] = "d" * 40
            del built[:]
            check_every_five_minutes(2)
            self.assertEqual(built, [("d", 360), ("d", 365)])
            # A build that succeeds leaves nothing to wait for: the next failure is the first again.
            main[0] = "e" * 40
            del built[:]
            outcomes[:] = [failure, failure, None]
            check_every_five_minutes(2)
            clock.now += 1800
            check_every_five_minutes(3)
            self.assertEqual(built, [("e", 370), ("e", 375), ("e", 410), ("e", 415), ("e", 420)])
            # A build the editor stopped to restart is no failure: it starts again at the next check.
            main[0] = "f" * 40
            del built[:]
            outcomes[:] = [failure, updater.Restarting()]
            check_every_five_minutes(3)
            self.assertEqual(built, [("f", 425), ("f", 430), ("f", 435)])
            self.assertEqual(len([line for line in said if line.startswith("Stopped the build to restart Scarlet")]), 1)
            # Nor is GitHub not answering: the head is built when its half hour is over.
            with patch.object(updater, "output", side_effect=subprocess.CalledProcessError(128, "git")):
                check_every_five_minutes(5)
            check_every_five_minutes(1)
            self.assertEqual(built, [("f", 425), ("f", 430), ("f", 435), ("f", 465)])

    def test_settings_finding_a_new_head_wakes_the_worker_while_an_update_is_showing(self):
        ready, newer = "b" * 40, "c" * 40
        requests = iter([("ready", ready), ("check " + ready, "ok"), ("check " + newer, "ok")])
        poll = updater.Offer.poll

        def from_window(offer, timeout):
            message, reply = next(requests)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(2)
                client.connect(str(offer.address))
                client.sendall((message + "\n").encode())
                action = poll(offer, timeout)
                self.assertEqual(client.recv(64).decode().strip(), reply)
                return action

        class BuildStarted(Exception):
            pass

        with patch.object(updater.time, "sleep", side_effect=AssertionError("worker went back to sleep")), \
                patch.object(updater, "busy", return_value=True), patch.object(updater.Offer, "poll", from_window), \
                patch.object(updater, "output", side_effect=[ready + "\trefs/heads/main", newer + "\trefs/heads/main"]), \
                patch.object(updater, "build", side_effect=BuildStarted) as build, self.assertRaises(BuildStarted):
            self.watch()
        self.assertEqual(list(requests), [])
        self.assertEqual(build.call_args.args[1], newer)
        self.assertEqual(updater.revision(updater.PENDING), ready)
        self.assertFalse((updater.CACHE / "restart").exists())

    def test_build_reports_how_far_along_it_is_from_the_last_build_times(self):
        status = updater.CACHE / "status.json"
        first = updater.Progress("c" * 40)
        first.start("source")
        report = json.loads(status.read_text())
        self.assertEqual((report["state"], report["revision"], report["done"]), ("building", "c" * 40, 0))
        total = sum(updater.STEP_SECONDS.values())
        first.start("app")
        report = json.loads(status.read_text())
        self.assertAlmostEqual(report["done"], sum(v for k, v in updater.STEP_SECONDS.items() if k in ("source", "install", "engine", "bundle", "media")) / total)
        self.assertAlmostEqual(report["step"], updater.STEP_SECONDS["app"] / total)
        self.assertEqual(report["stepSeconds"], updater.STEP_SECONDS["app"])
        # The next build expects each part to take as long as it did this time.
        first.began -= 100
        first.finish()
        second = updater.Progress("d" * 40)
        self.assertAlmostEqual(second.expected["app"], 100, delta=1)
        self.assertEqual(second.expected["verify"], updater.STEP_SECONDS["verify"])
        (updater.CACHE / "build-times.json").write_text("not json")
        self.assertEqual(updater.Progress("d" * 40).expected, updater.STEP_SECONDS)
        updater.write_status(None)
        self.assertFalse(status.exists())

    def test_restart_during_a_build_stops_it_and_keeps_the_verified_build(self):
        commit = "b" * 40
        address = updater.CACHE / "ready.sock"
        marker = updater.CACHE / "finished"
        replies = []

        def click():
            for _ in range(200):
                if address.exists():
                    break
                time.sleep(0.01)
            for message in ("ready", "restart " + commit):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(2)
                    client.connect(str(address))
                    client.sendall((message + "\n").encode())
                    replies.append(client.recv(64).decode().strip())

        attend = updater.Attendant()
        window = threading.Thread(target=click)
        with patch.object(updater, "busy", return_value=True), (updater.CACHE / "build.log").open("w") as transcript:
            window.start()
            started = time.monotonic()
            try:
                with self.assertRaises(updater.Restarting):
                    updater.run_step(["/bin/sh", "-c", f"sleep 30.125; touch {marker}"], transcript, attend)
            finally:
                attend.close()
                window.join(5)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(replies, [commit, "accepted"])
        self.assertEqual((updater.CACHE / "restart").read_text(), commit)
        self.assertFalse(address.exists())
        self.assertEqual(updater.revision(updater.PENDING), commit)
        # What the command started stops with it.
        for _ in range(100):
            left = [line for line in subprocess.run(["/bin/ps", "-axww", "-o", "args="], capture_output=True, text=True).stdout.splitlines()
                    if line.strip() == "sleep 30.125"]
            if not left:
                break
            time.sleep(0.05)
        self.assertEqual(left, [])
        self.assertFalse(marker.exists())

    def test_quit_during_a_build_installs_the_verified_build_and_the_build_goes_on(self):
        marker = updater.CACHE / "finished"
        attend = updater.Attendant()
        with patch.object(updater, "busy", return_value=False), (updater.CACHE / "build.log").open("w") as transcript:
            try:
                updater.run_step(["/bin/sh", "-c", f"sleep 1; touch {marker}"], transcript, attend)
            finally:
                attend.close()
        self.assertTrue(marker.exists())
        self.assertEqual(updater.revision(updater.APP), "b" * 40)
        self.assertFalse(updater.PENDING.exists())
        with (updater.CACHE / "build.log").open("w") as transcript, self.assertRaises(subprocess.CalledProcessError):
            updater.run_step(["/usr/bin/false"], transcript, attend)

    def test_a_command_run_while_the_window_is_answered_gives_only_what_it_printed(self):
        looked = []

        def attend(timeout):
            looked.append(timeout)
            time.sleep(0.01)

        # What it warns of goes where the worker's own words do, to its log, and not into the answer.
        with tempfile.TemporaryFile() as log:
            stderr = os.dup(2)
            os.dup2(log.fileno(), 2)
            try:
                answer = updater.output("/bin/sh", "-c", "sleep 0.1; echo main; echo warning >&2", attend=attend)
            finally:
                os.dup2(stderr, 2)
                os.close(stderr)
            log.seek(0)
            self.assertEqual((answer, log.read()), ("main", b"warning\n"))
        self.assertTrue(looked)
        with self.assertRaises(subprocess.CalledProcessError):
            updater.output("/usr/bin/false", attend=attend)
        # A command that gives no answer in its time is stopped.
        started = time.monotonic()
        with (updater.CACHE / "build.log").open("w") as transcript, self.assertRaises(subprocess.TimeoutExpired):
            updater.run_step(["/bin/sleep", "5.375"], transcript, attend, limit=0.2)
        self.assertLess(time.monotonic() - started, 10)

    def test_outside_a_build_the_attendant_offers_the_build_and_leaves_installing_it_to_the_worker(self):
        def output(*args, attend, **options):
            attend(0.01)  # The window is answered while git waits on GitHub.
            return "b" * 40 + "\trefs/heads/main"

        # Scarlet is closed. The build is on offer while GitHub is asked, and doesn't go in before the answer.
        attend = updater.Attendant()
        self.addCleanup(attend.close)
        with patch.object(updater, "busy", return_value=False) as busy, patch.object(updater, "output", side_effect=output):
            self.assertFalse(updater.check(attend))
        self.assertTrue((updater.CACHE / "ready.sock").exists())
        busy.assert_not_called()
        # Nor does it go in while the worker waits for its next check: Scarlet closing ends the wait.
        waiting = updater.Attendant()
        self.addCleanup(waiting.close)
        with patch.object(updater, "busy", side_effect=[True, False]):
            updater.offer_update(waiting, time.monotonic() + 0.05)
        self.assertEqual((updater.revision(updater.APP), updater.revision(updater.PENDING)), ("a" * 40, "b" * 40))
        # With nothing to offer, a wait that ran out while it was measured is no wait.
        shutil.rmtree(updater.PENDING)
        updater.Attendant().answer(-0.01)

    def test_build_migrates_a_shallow_clone_to_full_main_history(self):
        root = updater.CACHE.resolve()
        origin, source = root / "upstream", root / "source"

        def git(*args, cwd=origin):
            return subprocess.check_output(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", *args],
                                           cwd=cwd, stderr=subprocess.DEVNULL, text=True).strip()

        origin.mkdir()
        git("init", "-b", "main")
        git("commit", "--allow-empty", "-m", "First")
        previous = git("rev-parse", "HEAD")
        git("commit", "--allow-empty", "-m", "Second")
        expected = git("rev-parse", "HEAD")
        git("clone", "--depth=1", origin.as_uri(), str(source))
        self.assertEqual(git("rev-parse", "--is-shallow-repository", cwd=source), "true")

        def assemble(run, progress, commit, candidate):
            self.assertEqual(expected, commit)
            self.assertEqual(git("rev-parse", "--is-shallow-repository", cwd=source), "false")
            self.assertEqual(git("rev-parse", "FETCH_HEAD^", cwd=source), previous)

        with patch.multiple(updater, REPO=origin.as_uri(), SOURCE=source, node_bin=lambda: source, assemble=assemble), \
                (root / "build.log").open("w") as transcript:
            updater.build(transcript, expected, lambda seconds: time.sleep(min(0.02, seconds)))

    def test_assemble_verifies_stamped_version_and_keeps_the_clean_checkout(self):
        root = updater.CACHE.resolve()
        source = root / "source"
        def git(*args):
            return subprocess.check_output(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", *args],
                                           cwd=source, stderr=subprocess.DEVNULL, text=True).strip()

        fixture_root = Path(__file__).resolve().parents[3]
        files = ["package.json", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock",
                 "apps/desktop/src-tauri/Info.plist", "apps/desktop/src-tauri/tauri.conf.json",
                 "apps/server/src/telemetry/config.ts", "apps/agent/src/modelCatalog.ts", "packages/mcp/src/server.ts",
                 updater.VERSION_SCRIPT]
        files += [str(pack.relative_to(fixture_root)) for scope in ("packages", "apps")
                  for pack in (fixture_root / scope).glob("*/package.json")]
        for file in files:
            destination = source / file
            destination.parent.mkdir(exist_ok=True, parents=True)
            shutil.copy(fixture_root / file, destination)
        git("init", "-b", "main")
        git("add", ".")
        git("commit", "-m", "Baseline")
        git("commit", "--allow-empty", "-m", "Release")
        rev = git("rev-parse", "HEAD")
        node = Path(shutil.which("node"))
        version = subprocess.check_output([node, updater.VERSION_SCRIPT, "for-commit"], cwd=source, text=True).strip()
        candidate = root / "candidate.app"
        progress = updater.Progress(rev)
        info = source / "apps/desktop/src-tauri/Info.plist"
        info.write_bytes(plistlib.dumps(dict(plistlib.loads(info.read_bytes()), ScarletSourceRevision=rev)))
        def run(*args):
            if args[0] == "git" or args[:2] == ("node", updater.VERSION_SCRIPT):
                subprocess.run(args, cwd=source, check=True, stdout=subprocess.DEVNULL)
            elif "tauri" in args:
                config = json.loads((source / "apps/desktop/src-tauri/tauri.conf.json").read_text())
                self.assertEqual(config["version"], version)
                (candidate / "Contents").mkdir(parents=True)
                metadata = dict(plistlib.loads(info.read_bytes()), CFBundleIdentifier=updater.APP_ID,
                                CFBundleShortVersionString=version)
                (candidate / "Contents/Info.plist").write_bytes(plistlib.dumps(metadata))

        with patch.multiple(updater, SOURCE=source, node_bin=lambda: node.parent, swap_in=lambda a, b: a.rename(root / "done.app")):
            updater.assemble(run, progress, rev, candidate)
            self.assertEqual(git("status", "--porcelain"), "")
            self.assertFalse((updater.CACHE / "build-version.json").exists())
            (source / "personal.txt").write_text("save this")
            with self.assertRaisesRegex(ValueError, "other changes"):
                updater.assemble(run, progress, rev, candidate)
            self.assertEqual((source / "personal.txt").read_text(), "save this")

    def test_a_build_runs_under_the_workers_attendant_and_leaves_the_verified_build_on_offer(self):
        address = updater.CACHE / "ready.sock"
        source = updater.CACHE / "source"
        source.mkdir()
        attend = updater.Attendant()
        self.addCleanup(attend.close)
        steps = []

        def run_step(args, transcript, attendant, **options):
            steps.append(args[1])
            attendant(0.01)

        def output(*args, cwd=None):
            return str(source) if "--show-toplevel" in args else "c" * 40

        def assemble(run, progress, commit, candidate):
            """The first build is verified and takes the place of the one that was waiting. The next one fails."""
            if steps[1:]:
                raise OSError("failed build")
            info = updater.PENDING / "Contents/Info.plist"
            info.write_bytes(plistlib.dumps(dict(plistlib.loads(info.read_bytes()), ScarletSourceRevision=commit)))

        with patch.multiple(updater, SOURCE=source, run_step=run_step, output=output, node_bin=lambda: source,
                            busy=lambda: True, assemble=assemble), \
                (updater.CACHE / "build.log").open("w") as transcript:
            updater.build(transcript, "c" * 40, attend)
            self.assertEqual((steps, attend.offer.commit), (["fetch"], "b" * 40))
            # The new build is the one on offer from the next poll, not three seconds later.
            attend.answer(0.01)
            self.assertEqual(attend.offer.commit, "c" * 40)
            # A build that fails leaves the verified one on offer as well.
            with self.assertRaises(OSError):
                updater.build(transcript, "d" * 40, attend)
            self.assertTrue(address.exists())
        self.assertFalse((updater.CACHE / "status.json").exists())
        # It is the worker's attendant that holds the offer.
        attend.close()
        self.assertFalse(address.exists())

    def test_quit_installs_the_verified_build_while_github_cannot_be_reached(self):
        class Idle(Exception):
            """Nothing is left for the worker to do until its next check."""

        clock = Clock()
        said, naps = [], []

        def check(*attend):
            clock.now += 90  # How long git waits for GitHub before it gives up.
            raise subprocess.CalledProcessError(128, "git")

        def sleep(seconds):
            naps.append(seconds)
            raise Idle()

        clock.sleep = sleep
        with patch.object(updater, "time", clock), patch.object(updater, "log", side_effect=said.append), \
                patch.object(updater, "check", side_effect=check), patch.object(updater, "busy", return_value=False), \
                self.assertRaises(Idle):
            self.watch()
        self.assertEqual(updater.revision(updater.APP), "b" * 40)
        self.assertFalse(updater.PENDING.exists())
        self.assertEqual([line.split()[0] for line in said], ["Update", "Update", "Installed"])
        # GitHub is asked again a whole interval later, however long the failed check took.
        self.assertEqual(naps, [updater.INTERVAL])

    def test_worker_checks_builds_offers_and_installs_in_turn(self):
        class Done(Exception):
            pass

        clock = Clock()
        did, offers = [], []
        # What the build will make. Main moves to it five minutes in, and Scarlet is open until 950 seconds in.
        made = updater.CACHE / "made"
        updater.PENDING.rename(made)

        def output(*args, **options):
            if args[0] == "/bin/ps":
                return f"  100     1 {updater.APP}/Contents/MacOS/scarlet-desktop" if clock.now < 950 else ""
            did.append(f"{clock.now:g} asks GitHub")
            if len([line for line in did if line.endswith("asks GitHub")]) == 7:
                raise Done()
            return ("b" if clock.now >= 300 else "a") * 40 + "\trefs/heads/main"

        def build(transcript, head, *attend):
            clock.now += 200
            made.rename(updater.PENDING)

        def sleep(seconds):
            did.append(f"{clock.now:g} sleeps {seconds:g}")
            Clock.sleep(clock, seconds)

        class Offer:
            """Stands in for the socket: no window asks, and each poll takes its time on the clock."""

            def __init__(self, commit):
                self.commit = commit
                offers.append(f"{clock.now:g} opens for {commit[0]}")

            def poll(self, timeout):
                if not did[-1].endswith("offers " + self.commit[0]):
                    did.append(f"{clock.now:g} offers {self.commit[0]}")
                clock.now += max(0.01, timeout)
                return False

            def close(self):
                offers.append(f"{clock.now:g} closes with {updater.revision(updater.APP)[0]} installed")

        clock.sleep = sleep
        with patch.object(updater, "time", clock), patch.object(updater, "output", side_effect=output), \
                patch.object(updater, "build", side_effect=build), patch.object(updater, "Offer", Offer), \
                patch.object(updater, "log", side_effect=lambda message: did.append(f"{clock.now:g} {message.split()[0]}")), \
                self.assertRaises(Done):
            self.watch()
        self.assertEqual(did, [
            "0 asks GitHub", "0 sleeps 300",  # Main is what is installed.
            "300 asks GitHub", "300 Building",  # Main has moved.
            "500 asks GitHub", "500 offers b",  # Verified. Main may have moved during the build, and Scarlet is open.
            "800 asks GitHub", "800 offers b",
            "950 asks GitHub", "950 Installed", "950 sleeps 150",  # The editor quit. Main may have moved since the last check.
            "1100 asks GitHub", "1100 sleeps 300", "1400 asks GitHub"])
        self.assertEqual(updater.revision(updater.APP), "b" * 40)
        self.assertFalse(updater.PENDING.exists())
        # The build stays on offer from when it is verified, also each time GitHub is asked, until it is about to go in.
        self.assertEqual(offers, ["500 opens for b", "950 closes with a installed"])

    def test_nothing_stays_on_offer_while_the_worker_rests_or_once_it_stops(self):
        class Rest(Exception):
            pass

        address = updater.CACHE / "ready.sock"
        clock = Clock()
        offered = []

        def output(*args, attend, **options):
            attend(0.01)  # The window is answered while git waits on GitHub, so the build is on offer by now.
            offered.append(address.exists())
            return "b" * 40 + "\trefs/heads/main"

        def sleep(seconds):
            offered.append(address.exists())
            raise Rest()

        def worker(busy, ends):
            del offered[:]
            with patch.object(updater, "time", clock), patch.object(updater, "log"), \
                    patch.object(updater, "busy", side_effect=busy), patch.object(updater, "output", side_effect=output), \
                    self.assertRaises(ends):
                self.watch()
            return offered + [address.exists()]

        clock.sleep = sleep
        # It can't tell whether Scarlet is open, and waits five minutes to look again.
        self.assertEqual(worker(subprocess.CalledProcessError(1, "ps"), Rest), [True, False, False])
        # launchd stops the worker.
        self.assertEqual(worker([True, SystemExit(0)], SystemExit), [True, False])
        # The build turns out to be installed already, and is cleared away.
        shutil.rmtree(updater.APP)
        shutil.copytree(updater.PENDING, updater.APP)
        self.assertEqual(worker([], Rest), [True, False, False])
        self.assertFalse(updater.PENDING.exists())

    def test_restart_stays_on_offer_while_github_is_asked(self):
        class Reopened(Exception):
            pass

        commit = "b" * 40
        address = updater.CACHE / "ready.sock"
        intent = updater.CACHE / "restart"
        # A git that takes its time to say main is at the verified build, as GitHub does on a poor connection.
        # It writes a line when it is asked and another when it answers.
        tools = updater.CACHE / "tools"
        tools.mkdir()
        asked = updater.CACHE / "asked"
        (tools / "git").write_text(f"#!/bin/sh\necho asked >> '{asked}'\nsleep 0.4\necho answered >> '{asked}'\n"
                                   f"printf '{commit}\\trefs/heads/main\\n'\n")
        (tools / "git").chmod(0o755)
        during, between, clicks, opened, said = [], [], [], [], []
        run = subprocess.run

        def lines():
            return len(asked.read_text().splitlines()) if asked.exists() else 0

        def ask(message):
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(2)
                    client.connect(str(address))
                    client.sendall((message + "\n").encode())
                    return client.recv(64).decode().strip()
            except OSError:
                return "no answer"

        def window():
            """Keeps asking whether an update is ready, into the worker's second check of GitHub, then clicks Restart."""
            deadline = time.monotonic() + 20
            while ask("ready") != commit and time.monotonic() < deadline:
                time.sleep(0.01)
            second = 0
            while second < 3 and time.monotonic() < deadline:
                written = lines()
                answer = ask("ready")
                # An odd count that hasn't moved: git was waiting on GitHub from before the question until after its answer.
                checking = written % 2 == 1 and lines() == written
                (during if checking else between).append(answer)
                if checking and written >= 3:
                    second += 1
                time.sleep(0.03)
            while clicks[-1:] != ["accepted"] and time.monotonic() < deadline:
                clicks.append(ask("restart " + commit))
                time.sleep(0.03)

        def capture_open(args, **kwargs):
            if args[0] == "/usr/bin/open":
                opened.append((args[1], updater.revision(updater.APP)))
                raise Reopened()
            return run(args, **kwargs)

        scarlet = threading.Thread(target=window)
        # Scarlet stays open until its restart is accepted. Main is at the verified build, so there is nothing to build.
        with patch.object(updater, "time", Timed(30)), patch.object(updater, "INTERVAL", 0.4), \
                patch.object(updater, "log", side_effect=said.append), \
                patch.object(updater, "busy", side_effect=lambda: not intent.exists()), \
                patch.object(updater, "build", side_effect=AssertionError("Nothing to build")), \
                patch.object(subprocess, "run", side_effect=capture_open), \
                patch.dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}"):
            scarlet.start()
            try:
                with self.assertRaises(Reopened):
                    self.watch()
            finally:
                scarlet.join(25)
        self.assertGreaterEqual(len(during), 3)
        self.assertEqual([answer for answer in during if answer != commit], [])
        self.assertEqual([answer for answer in between if answer != commit], [])
        self.assertEqual(clicks, ["accepted"])
        self.assertEqual(opened, [(str(updater.APP), commit)])
        self.assertFalse(address.exists())
        # No build was under way to stop.
        self.assertEqual([line.split()[0] for line in said], ["Installed"])


if __name__ == "__main__":
    unittest.main()
