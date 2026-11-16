"""Frozen take trials use only the source recording and source transcript."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prepare_take_pairs import prepare
from take_listening import prepare as prepare_requests


class PrepareTakePairsTests(unittest.TestCase):
    def test_rejects_foreign_evidence_and_duplicate_recording_bytes_across_splits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, copy = root / "first.wav", root / "copy.wav"
            first.write_bytes(b"same recording")
            copy.write_bytes(first.read_bytes())
            path = root / "words.json"
            evidence = dict(duration=1, words=[dict(text="hello", start=.1, end=.5)])
            path.write_text(json.dumps(dict(evidence, sourceSha256="b" * 64)))
            with patch("prepare_take_pairs.scarlet", return_value=[]) as finder:
                with self.assertRaisesRegex(ValueError, "source recordings"):
                    prepare([("one", "dev", first, path)], root / "foreign")
                finder.assert_not_called()
                path.write_text(json.dumps(evidence))
                with self.assertRaisesRegex(ValueError, "across the study splits"):
                    prepare([("one", "dev", first, path), ("two", "holdout", copy, path)], root / "pairs")
                self.assertFalse((root / "pairs").exists())

    def test_source_only_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "recording.wav"
            with wave.open(str(media), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(bytes(16000 * 2 * 12))
            # An immediate restart, with six long continuation words on its second delivery.
            tokens = "start goes right goes right through all six of those words today".split()
            starts = [0, .22, .5, .79, 1.0, 1.4, 2.0, 4.0, 6.0, 8.0, 10.0, 11.0]
            words = [dict(text=t, start=s, end=s + .2) for t, s in zip(tokens, starts)]
            evidence = root / "source.json"
            evidence.write_text(json.dumps(dict(duration=12, words=words)))
            episodes = [("clip", "unseen", media, evidence)]
            out = root / "pairs"
            self.assertEqual(prepare(episodes, out), 1)
            recording, = json.loads((out / "cases.json").read_bytes())["recordings"]
            trial, = json.loads((out / "cases.json").read_bytes())["trials"]
            self.assertEqual((recording["finderPairs"], trial["split"], recording["audioStream"]), (1, "unseen", 0))
            self.assertEqual(trial["occurrences"], [[1, 2], [3, 4]])
            self.assertEqual({o["action"]: o["remove"] for o in trial["options"]},
                             {"first": [[3, 4]], "second": [[1, 2]], "both": []})
            earlier, later = trial["windows"]
            self.assertEqual((earlier["from"], earlier["to"], earlier["transcript"]), (.2, .79, "goes right"))
            self.assertEqual((later["from"], later["to"]), (.7, 8.7))
            guide = root / "guide.md"
            guide.write_text("Keep the complete thought.")
            self.assertEqual(prepare_requests(out / "cases.json", [guide], root / "batch", seed=11), 4)
            with self.assertRaisesRegex(ValueError, "new output directory"):
                prepare(episodes, out)


if __name__ == "__main__":
    unittest.main()
