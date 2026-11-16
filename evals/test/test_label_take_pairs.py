"""A matched copy, an editor splice, and a hole in the soundtrack prove different things."""
from pathlib import Path
import json
import tempfile
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from label_take_pairs import label_manifest, label_trial, occurrence_evidence, reference_binding


class LabelTakePairsTests(unittest.TestCase):
    def test_partial_soundtrack_needs_anchored_skip(self):
        words = [dict(text="a", start=.2, end=.4), dict(text="b", start=1.3, end=1.5),
                 dict(text="c", start=2.2, end=2.5), dict(text="d", start=5.2, end=5.5),
                 dict(text="e", start=7.2, end=7.5), dict(text="f", start=2, end=2.3)]
        ref = dict(frameRate=30, finalDuration=5, unmappedFinal=[[2, 4]], mappedFraction=.6,
                   segments=[dict(rawStart=0, rawEnd=1, finalStart=0, finalEnd=1),
                             dict(rawStart=2, rawEnd=3, finalStart=1, finalEnd=2),
                             dict(rawStart=7, rawEnd=8, finalStart=4, finalEnd=5)],
                   joins=[dict(finalTime=1, earliestFinal=.98, latestFinal=1.02)])
        kept, cut = occurrence_evidence(words, ref)
        self.assertEqual(kept, {0, 2, 4})
        self.assertEqual(cut, {1})

    def test_input_and_stream_binding_including_historical_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ref_file = root / "old-map.json"
            old = {"rawDuration": 42.0}
            ref_file.write_text(json.dumps(old))
            identity = dict(sourceSha256="a" * 64, editorSha256="b" * 64, audioStream=1, editorAudioStream=0)
            record = dict(id="camera", sourceSha256=identity["sourceSha256"], audioStream=1)
            inputs = {"reference": str(ref_file)}
            evidence = {"audioStream": 1}

            def bind(ref, options=inputs):
                return reference_binding(record, evidence, ref, ref_file, options, root)
            with self.assertRaisesRegex(ValueError, "lacks input identity"):
                bind(old)
            self.assertEqual(bind(dict(old, inputs=identity))["audioStream"], 1)
            for wrong in ({"sourceSha256": "c" * 64}, {"audioStream": 0}, {"audioStream": True}):
                with self.assertRaises(ValueError):
                    bind(dict(old, inputs=dict(identity, **wrong)))

            evidence["sourceSha256"] = "c" * 64
            with self.assertRaisesRegex(ValueError, "source recordings"):
                bind(dict(old, inputs=identity))
            evidence["sourceSha256"] = identity["sourceSha256"]

            replay = root / "replay.json"
            replay.write_text(json.dumps(dict(old, inputs=identity)))
            metadata = root / "archive.json"
            metadata.write_text(json.dumps({k: identity[k] for k in ("sourceSha256", "editorSha256")}))
            options = dict(inputs, replayedReference=replay.name, archiveSource=metadata.name)
            self.assertEqual(bind(old, options)["method"], "replayedHistoricalMap")
            with self.assertRaisesRegex(ValueError, "does not reproduce"):
                bind({"rawDuration": 41}, options)
            metadata.write_text(json.dumps(dict(sourceSha256=identity["sourceSha256"], editorSha256="d" * 64)))
            with self.assertRaisesRegex(ValueError, "Archive"):
                bind(old, options)

    def test_frozen_manifest_cannot_label_the_same_recording_as_held_out(self):
        recordings = [dict(id=name, split=name, sourceSha256="a" * 64) for name in ("dev", "holdout")]
        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "across the study splits"):
            label_manifest(dict(recordings=recordings, trials=[]), {"dev": {}, "holdout": {}}, Path(tmp))

    def test_matching_positions_and_mixed_copies(self):
        words = [dict(text=t) for t in ("a", "b", "c", "A", "b.", "C!")]
        trial = dict(id="pair", case="raw", split="held", occurrences=[[0, 2], [3, 5]],
                     options=[dict(action=s, id=v) for s, v in zip(("first", "second", "both"), "CAB")])
        label = label_trial(trial, words, {4}, {1}, complete_map=False)
        self.assertIsNone(label["strict"]["targetChoice"])
        self.assertEqual(label["provenance"]["targetChoice"], "A")
        self.assertIsNone(label["provenanceGlobal"]["targetChoice"])
        self.assertEqual(label["negativeEvidenceScope"], "localForwardSplice")
        global_label = label_trial(trial, words, {4}, {1}, complete_map=True)
        self.assertEqual(global_label["provenanceGlobal"]["targetChoice"], "A")
        self.assertEqual(label["provenance"]["witnesses"]["second"], [[1, 4]])
        self.assertIsNone(label_trial(trial, words, {5}, {1}, complete_map=False)["provenance"]["targetChoice"])
        mixed = label_trial(trial, words, {0, 4}, {1}, complete_map=False)
        self.assertEqual(mixed["provenance"]["targetAction"], "mixed")
        self.assertIsNone(mixed["provenance"]["targetChoice"])
        both = label_trial(trial, words, set(range(6)), set(), complete_map=False)
        self.assertEqual(both["strict"]["targetChoice"], "B")
        self.assertEqual(both["provenance"]["targetChoice"], "B")
        self.assertEqual(both["strictGlobal"]["targetChoice"], "B")


if __name__ == "__main__":
    unittest.main()
