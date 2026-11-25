from contextlib import ExitStack, redirect_stderr
from io import StringIO
import json
import os
from pathlib import Path
import select
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

from crisper_cli import (Piece, Word, forget_recognizer, preferred_device, recognize_locally, recognizer_on, reconcile,
                         restore_times, save_json, sounding_pieces, whisper_json)
import crisper_cli

try:
    import numpy
except ImportError:
    numpy = None


def stamp(word, start, end):
    return SimpleNamespace(word=word, start=start, end=end)


def steps(*runs):
    """20 ms quiet flags from (seconds, quiet) runs."""
    return [quiet for seconds, quiet in runs for _ in range(round(seconds / 0.02))]


class AdapterTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "macOS model admission")
    def test_admits_two_decoders_and_waits_for_memory_before_loading_a_third(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            wav = home / "input.wav"
            wav.touch()
            memory = home / "memory"

            def set_memory(pressure, anonymous_pages):
                pending = memory.with_suffix(".next")
                pending.write_text(f"{pressure} {anonymous_pages}")
                pending.replace(memory)

            set_memory(1, 1000000)
            adapter = Path(__file__).with_name("crisper_cli.py")
            driver = """
from pathlib import Path
import runpy
import subprocess
import sys
from types import SimpleNamespace

memory = Path(sys.argv[1])
physical_gib = int(sys.argv[2])
def system_memory(command, **kwargs):
    if command[-1] == "hw.memsize":
        return str(physical_gib * 1024**3)
    if command[-1] == "kern.memorystatus_vm_pressure_level":
        return memory.read_text().split()[0]
    if command == ["/usr/bin/vm_stat"]:
        anonymous = memory.read_text().split()[1]
        return f"Anonymous pages: {anonymous}.\\nPages wired down: 500000.\\nPages occupied by compressor: 0.\\n"
    raise AssertionError(command)

def start_model(threads):
    print("model runtime started", flush=True)
    sys.stdin.readline()

subprocess.check_output = system_memory
sys.modules["torch"] = SimpleNamespace(set_num_threads=start_model, set_num_interop_threads=lambda n: None)
sys.modules["crisperwhisper.audio"] = SimpleNamespace(load_audio=lambda path: [])
sys.argv = sys.argv[3:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""

            def read_line(pipe):
                self.assertTrue(select.select([pipe], [], [], 5)[0], "Timed out waiting for the decoder")
                return pipe.readline().strip()

            with ExitStack() as workers:
                def start(library, physical_gib=96):
                    model = home / library / "model/model.safetensors"
                    model.parent.mkdir(parents=True)
                    model.touch()
                    output = model.parent / "words"
                    decoder = workers.enter_context(subprocess.Popen(
                        [sys.executable, "-I", "-B", "-c", driver, str(memory), str(physical_gib), str(adapter),
                         "-m", str(model), "-f", str(wav), "-ojf", "-of", str(output)],
                        env={**os.environ, "HOME": directory}, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
                    workers.callback(lambda: decoder.kill() if decoder.poll() is None else None)
                    return decoder, output.with_suffix(".json")

                first, first_output = start("first-library")
                self.assertEqual(read_line(first.stdout), "model runtime started")
                second, _ = start("second-library")
                self.assertEqual(read_line(second.stdout), "model runtime started")
                third, third_output = start("third-library")
                self.assertIn("waiting for memory", read_line(third.stderr))
                self.assertFalse(select.select([third.stdout], [], [], 0)[0])

                set_memory(2, 1000000)
                first.communicate(input="\n", timeout=5)
                self.assertEqual(first.returncode, 0)
                self.assertTrue(first_output.exists())
                self.assertFalse(select.select([third.stdout], [], [], 1.5)[0])
                self.assertFalse(third_output.exists())

                set_memory(1, (71 * 1024**3) // os.sysconf("SC_PAGE_SIZE"))
                self.assertFalse(select.select([third.stdout], [], [], 1.5)[0])

                set_memory(1, 1000000)
                self.assertEqual(read_line(third.stdout), "model runtime started")
                third.communicate(input="\n", timeout=5)
                self.assertEqual(third.returncode, 0)
                self.assertTrue(third_output.exists())

                small, small_output = start("small-mac-library", physical_gib=16)
                stdout, stderr = small.communicate(timeout=5)
                self.assertEqual(small.returncode, 1)
                self.assertIn("Choose bundled Whisper", stderr)
                self.assertFalse(stdout)
                self.assertFalse(small_output.exists())

    def test_device_follows_the_available_torch_backends(self):
        for mps, cuda, expected in [(True, False, "mps"), (False, True, "cuda"), (False, False, "cpu")]:
            with self.subTest(mps=mps, cuda=cuda):
                torch = Mock()
                torch.backends.mps.is_available.return_value = mps
                torch.cuda.is_available.return_value = cuda
                self.assertEqual(preferred_device(torch), expected)

    @patch("crisper_cli.recognize")
    def test_keeps_a_successful_gpu_result(self, recognize):
        torch = Mock()
        torch.backends.mps.is_available.return_value = True
        args = (object(), Path("model"), Path("cache"), "auto")
        result = recognize_locally(*args, torch, True)
        self.assertIs(result, recognize.return_value)
        recognize.assert_called_once_with(*args, "mps")

    @patch("crisper_cli.recognize")
    def test_restarts_recognition_on_cpu_after_an_unsupported_gpu_operation(self, recognize):
        torch = Mock()
        torch.backends.mps.is_available.return_value = True
        args = (object(), Path("model"), Path("cache"), "auto")
        expected = object()
        recognize.side_effect = [NotImplementedError("missing GPU operation"), expected]
        log = StringIO()
        with redirect_stderr(log):
            self.assertIs(recognize_locally(*args, torch, True), expected)
        torch.mps.empty_cache.assert_called_once_with()
        self.assertEqual([call.args for call in recognize.call_args_list], [(*args, "mps"), (*args, "cpu")])
        self.assertIn("crisperwhisper fallback = mps", log.getvalue().splitlines())
        self.assertIn("progress = 0%", log.getvalue().splitlines())

    @patch("crisper_cli.recognize")
    def test_retries_an_unsupported_mps_dtype_without_progress_when_quiet(self, recognize):
        torch = Mock()
        torch.backends.mps.is_available.return_value = True
        recognize.side_effect = [TypeError("Cannot convert the MPS tensor"), "recognized"]
        log = StringIO()
        with redirect_stderr(log):
            result = recognize_locally([], Path("model"), Path("cache"), "en", torch, False)
        self.assertEqual(result, "recognized")
        self.assertNotIn("progress =", log.getvalue())

    @patch("crisper_cli.recognize")
    def test_reports_a_cpu_failure_without_repeating_it(self, recognize):
        torch = Mock()
        torch.backends.mps.is_available.return_value = False
        torch.cuda.is_available.return_value = False
        recognize.side_effect = RuntimeError("out of memory")
        with self.assertRaisesRegex(RuntimeError, "out of memory"):
            recognize_locally([], Path("model"), Path("cache"), "en", torch, False)
        self.assertEqual(recognize.call_count, 1)

    def test_keeps_native_times_and_fills_a_gap_in_the_timestamp_stream(self):
        timed = [stamp("swim", 0, .2), stamp("swim", .2, .4), stamp("[UH]", .4, .6),
                 stamp("[breath]", .6, .8), stamp("balloon", 1.4, 1.8)]
        words = reconcile("swim swim [UH] [breath] green striped balloon.", timed, 2)
        self.assertEqual([w.text for w in words], ["swim", "swim", "uh", "green", "striped", "balloon."])
        self.assertEqual([(w.start, w.end, w.estimated) for w in words],
                         [(0, 200, False), (200, 400, False), (400, 600, False),
                          (600, 1000, True), (1000, 1400, True), (1400, 1800, False)])
        segment = whisper_json("en", words)["transcription"][0]
        self.assertTrue(all(token["text"].startswith(" ") for token in segment["tokens"]))
        self.assertEqual(segment["offsets"], {"from": 0, "to": 1800})

    def test_skips_acoustic_tags_and_keeps_unaligned_spoken_words(self):
        self.assertEqual(reconcile("[laughter] [breath].", [stamp("[laughter]", 0, .1)], .7), [])
        self.assertEqual([w.text for w in reconcile("[UM] [cough] p- paint", [], 1)], ["um", "p-", "paint"])

    def test_spaceless_language_keeps_native_boundaries_and_surface_punctuation(self):
        timed = [stamp("東京", .1, .4), stamp("です", .6, .9)]
        words = reconcile("東京、です。", timed, 1, "ja")
        self.assertEqual([(w.text, w.start, w.end, w.estimated) for w in words],
                         [("東京、", 100, 400, False), ("です。", 600, 900, False)])
        segment = whisper_json("ja", words)["transcription"][0]
        self.assertEqual(segment["text"], "東京、です。")
        self.assertEqual([token["text"] for token in segment["tokens"]], [" 東京、", " です。"])

    def test_spaceless_language_interpolates_only_missing_surface_text(self):
        timed = [stamp("你好", 0, .3), stamp("世界", .6, .8), stamp("ok", .9, 1)]
        words = reconcile("你好新世界 ok!", timed, 1, "zh")
        self.assertEqual([(w.text, w.start, w.end, w.estimated) for w in words],
                         [("你好", 0, 300, False), ("新", 300, 600, True),
                          ("世界", 600, 800, False), ("ok!", 900, 1000, False)])
        self.assertEqual(whisper_json("zh", words)["transcription"][0]["text"], "你好新世界 ok!")

    def test_clamps_overlapping_and_out_of_bounds_timestamps(self):
        timed = [stamp("blue", -.1, .2), stamp("sky", .16, .7)]
        words = reconcile("blue bright sky", timed, .6)
        self.assertEqual([(w.start, w.end) for w in words], [(0, 160), (160, 160), (160, 600)])

    def test_omits_an_unobservable_suffix_at_eof_and_keeps_the_clipped_word(self):
        timed = [stamp("kite", .1, .4), stamp("flo-", .4, .8),
                 stamp("over", .8, .8), stamp("land", .82, 1.1)]
        words = reconcile("kite bright flo- over land too", timed, .8)
        self.assertEqual([(w.text, w.start, w.end) for w in words],
                         [("kite", 100, 400), ("bright", 400, 400), ("flo-", 400, 800)])

    def test_keeps_a_partial_word_inside_the_last_millisecond(self):
        words = reconcile("a half", [stamp("a", .75, .81), stamp("half", .8, .81)], .80025)
        self.assertEqual([(w.text, w.start, w.end) for w in words],
                         [("a", 750, 800), ("half", 800, 800.25)])

    def test_writes_only_the_path_scarlet_cleans_on_cancellation(self):
        with TemporaryDirectory() as directory:
            prefix = Path(directory) / "transcription"
            save_json({"words": ["空"]}, prefix)
            with self.assertRaises(ValueError):
                save_json({"invalid": float("nan")}, prefix)
            self.assertEqual(list(prefix.parent.iterdir()), [prefix.with_suffix(".json")])
            self.assertEqual(json.loads(prefix.with_suffix(".json").read_text(encoding="utf-8")), {"words": ["空"]})

    def test_names_no_language_for_audio_it_had_nothing_to_read_in(self):
        self.assertEqual(whisper_json("auto", []), {"result": {}, "transcription": []})
        self.assertEqual(whisper_json("en", [])["result"], {"language": "en"})

    def test_shortens_long_quiet_to_half_a_second_beside_sound_and_reads_pauses_as_they_are(self):
        quiet = steps((3, True), (4, False), (1.5, True), (2, False), (10, True), (3, False), (2.5, True))
        pieces = sounding_pieces(quiet, 26)
        # The quiet at the start and end has sound on one side only; the 1.5 s pause stays whole.
        self.assertEqual([(round(p.source, 6), round(p.at, 6), round(p.length, 6)) for p in pieces],
                         [(2.5, 0, 8.5), (20.0, 8.5, 4.0)])
        self.assertEqual([(p.source, p.at, p.length) for p in sounding_pieces(steps((1, True), (3, False), (1.9, True)), 5.9)],
                         [(0.0, 0.0, 5.9)])
        self.assertEqual(sounding_pieces(steps((4, True)), 4), [])
        self.assertEqual(sounding_pieces([], 0), [])

    def test_puts_words_back_on_the_recordings_clock_inside_the_piece_they_start_in(self):
        pieces = [Piece(2.5, 0, 8.5), Piece(20.0, 8.5, 4.0)]
        words = restore_times([Word("a", 100, 400), Word("b", 8600, 8900), Word("c", 8400, 8700)], pieces)
        self.assertEqual([(w.text, round(w.start, 6), round(w.end, 6)) for w in words],
                         [("a", 2600, 2900), ("b", 20100, 20400), ("c", 10900, 11000)])

    @unittest.skipUnless(numpy, "numpy measures the levels")
    def test_counts_audio_under_minus_60_dbfs_as_quiet_in_20_ms_steps(self):
        pcm = numpy.concatenate([numpy.zeros(16000), numpy.full(16000, .1), numpy.full(8000, .0005), numpy.full(100, .1)])
        quiet = crisper_cli.quiet_steps(pcm)
        self.assertEqual(quiet, [True] * 50 + [False] * 50 + [True] * 25 + [False])

    @unittest.skipUnless(numpy, "numpy measures the levels")
    @patch("crisper_cli.recognize_locally")
    def test_reads_only_the_sound_and_times_its_words_on_the_recording(self, recognize):
        pcm = numpy.concatenate([numpy.zeros(5 * 16000), numpy.full(2 * 16000, .1), numpy.zeros(6 * 16000),
                                 numpy.full(16000, .1)]).astype(numpy.float32)
        heard = []

        def read(audio, *args):
            heard.append(len(audio))
            return SimpleNamespace(language="en", text="one two", words=[stamp("one", .6, .9), stamp("two", 3.6, 3.9)])
        recognize.side_effect = read
        with TemporaryDirectory() as directory:
            prefix = Path(directory) / "words"
            log = StringIO()
            with redirect_stderr(log):
                crisper_cli.transcribe_file(Path("a.wav"), prefix, "en", Path("model"), Path("cache"), Mock(), lambda path: pcm)
            output = json.loads(prefix.with_suffix(".json").read_text(encoding="utf-8"))
        # 4.5 s of the 14: half a second either side of each long quiet, and the sound.
        self.assertEqual(heard, [72000])
        self.assertIn("crisperwhisper quiet = 9.5 s of 14.0 s not read", log.getvalue().splitlines())
        self.assertEqual([(t["text"], round(t["offsets"]["from"]), round(t["offsets"]["to"]))
                          for s in output["transcription"] for t in s["tokens"]],
                         [(" one", 5100, 5400), (" two", 13100, 13400)])

    @unittest.skipUnless(numpy, "numpy measures the levels")
    @patch("crisper_cli.recognize_locally")
    def test_reads_nothing_in_audio_that_is_quiet_throughout(self, recognize):
        with TemporaryDirectory() as directory:
            prefix = Path(directory) / "words"
            crisper_cli.transcribe_file(Path("a.wav"), prefix, "auto", Path("model"), Path("cache"), Mock(),
                                        lambda path: numpy.zeros(3 * 16000, dtype=numpy.float32))
            output = json.loads(prefix.with_suffix(".json").read_text(encoding="utf-8"))
        recognize.assert_not_called()
        self.assertEqual(output, {"result": {}, "transcription": []})

    def test_keeps_the_model_loaded_on_its_device_and_loads_it_again_only_on_another(self):
        loaded = Mock(side_effect=lambda *args, device, **kwargs: SimpleNamespace(device=device))
        with patch.dict(sys.modules, {"crisperwhisper": SimpleNamespace(CrisperWhisperModel=loaded)}):
            forget_recognizer()
            model = Path("checkpoint/model.safetensors")
            first = recognizer_on(model, Path("cache"), "mps")
            self.assertIs(recognizer_on(model, Path("cache"), "mps"), first)
            self.assertEqual(recognizer_on(model, Path("cache"), "cpu").device, "cpu")
            self.assertIsNot(recognizer_on(model, Path("cache"), "mps"), first)
            forget_recognizer()
        self.assertEqual([call.kwargs["device"] for call in loaded.call_args_list], ["mps", "cpu", "mps"])

    def test_serves_requests_from_one_process_until_one_fails(self):
        with TemporaryDirectory() as directory:
            home = Path(directory)
            model = home / "checkpoint/model/model.safetensors"
            model.parent.mkdir(parents=True)
            model.touch()
            adapter = Path(__file__).with_name("crisper_cli.py")
            driver = """
import os
import sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import crisper_cli as cli
cli.wait_for_local_asr_slot = lambda: None
torch = SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
                        cuda=SimpleNamespace(is_available=lambda: False))
audio = {"speech.wav": [.1] * 16000, "broken.wav": [.1] * 3, "empty.wav": []}
cli.prepare_runtime = lambda model, threads: (model.parent.parent / "cache", torch, lambda path: audio[os.path.basename(path)])
cli.quiet_steps = lambda pcm: [False] * (len(pcm) // 320 or 1)
def recognize_locally(pcm, model, cache, language, torch, progress):
    print("a library writing to stdout")
    os.write(1, b"and one writing to its descriptor\\n")
    if len(pcm) == 3:
        raise RuntimeError("the decoder broke\\nwith detail")
    return SimpleNamespace(language="en", text="hello there", words=[SimpleNamespace(word="hello", start=.1, end=.4),
                                                                      SimpleNamespace(word="there", start=.5, end=.9)])
cli.recognize_locally = recognize_locally
sys.argv = ["crisper_cli.py", "--serve", "-m", sys.argv[2]]
cli.main()
"""
            requests = "".join(json.dumps({"id": i, "wav": str(home / name), "out": str(home / f"out{i}"),
                                           "language": "en", "progress": i == 1}) + "\n"
                               for i, name in enumerate(["speech.wav", "empty.wav", "speech.wav", "broken.wav", "speech.wav"]))
            worker = subprocess.run([sys.executable, "-I", "-B", "-c", driver, str(adapter.parent), str(model)],
                                    input=requests, capture_output=True, text=True, timeout=30)
            replies = [json.loads(line) for line in worker.stdout.splitlines()]
            self.assertEqual(replies, [{"id": 0, "ok": True, "stderr_end": True}, {"id": 1, "ok": True, "stderr_end": True},
                                       {"id": 2, "ok": True, "stderr_end": True},
                                       {"id": 3, "error": "the decoder broke", "stderr_end": True}])
            self.assertEqual(worker.returncode, 1)
            # Each request's stderr ends with its own marker, after everything written for it.
            ends = [line for line in worker.stderr.splitlines() if line.startswith("scarlet-crisper-end")]
            self.assertEqual(ends, [f"scarlet-crisper-end {i}" for i in range(4)])
            self.assertLess(worker.stderr.index("progress = 100%"), worker.stderr.index("scarlet-crisper-end 1"))
            self.assertGreater(worker.stderr.index("progress = 100%"), worker.stderr.index("scarlet-crisper-end 0"))
            self.assertIn("a library writing to stdout", worker.stderr)
            self.assertIn("and one writing to its descriptor", worker.stderr)
            # Progress only for the request that asked for it.
            self.assertEqual(worker.stderr.count("progress = 100%"), 1)
            words = json.loads((home / "out0.json").read_text(encoding="utf-8"))["transcription"][0]["tokens"]
            self.assertEqual([(t["text"], t["offsets"]) for t in words],
                             [(" hello", {"from": 100, "to": 400}), (" there", {"from": 500, "to": 900})])
            self.assertEqual(json.loads((home / "out1.json").read_text(encoding="utf-8")),
                             {"result": {"language": "en"}, "transcription": []})
            self.assertFalse((home / "out4.json").exists())


if __name__ == "__main__":
    unittest.main()
