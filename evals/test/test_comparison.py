"""Regression checks for comparison coverage, frozen evidence and blind examples."""
import tempfile
import unittest
from pathlib import Path
import sys
import json
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import compare
from compare import arm_score, encoded, pause_ms, private_path, rate, seal
from listen import choices
from score_audio_reference import Piece, timeline_pieces, verified_keeps


class ComparisonTests(unittest.TestCase):
    def test_freeze_checks_recordings_and_stream_when_the_audio_map_identifies_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            for name in compare.REQUIRED:
                path = root / name
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(encoded({}))
            source = compare.sha(root / "media/presenter.mp4")
            (root / "media/published.mp4").write_bytes(b"published")
            editor = compare.sha(root / "media/published.mp4")
            case = root / "cases" / "sample"
            case.mkdir(parents=True)
            (case / "case.json").write_bytes(encoded(dict(id="sample", dialogueMedia=["cam"],
                media=[dict(id="cam", hash=source, audioStream=1)])))
            (root / "pictures.json").write_bytes(encoded(dict(sourceId=source, publishedSha256=editor)))
            self.assertIn("reference-audio.json", compare.inventory(root, "sample"))  # Pre-identity map.
            binding = dict(sourceSha256=source, editorSha256=editor, audioStream=1)
            (root / "reference-audio.json").write_bytes(encoded({"inputs": binding}))
            self.assertIn("reference-audio.json", compare.inventory(root, "sample"))
            for changed in (dict(sourceSha256=editor), dict(editorSha256=source), dict(audioStream=0)):
                (root / "reference-audio.json").write_bytes(encoded({"inputs": {**binding, **changed}}))
                with self.assertRaisesRegex(ValueError, "audio reference"):
                    compare.inventory(root, "sample")

    def test_unmapped_publication_cannot_be_used_to_label_source_removals(self):
        words = [{"text": "again", "start": t, "end": t + .2} for t in (1, 3, 5)]
        ref = {"frameRate": 30, "mappedFraction": .5, "unmappedFinal": [{"finalStart": 2, "finalEnd": 4}],
               "joins": [], "segments": [{"rawStart": 0, "rawEnd": 2, "finalStart": 0, "finalEnd": 2},
                                         {"rawStart": 4, "rawEnd": 6, "finalStart": 4, "finalEnd": 6}]}
        score = verified_keeps(words, ref, [Piece(.5, 1.5, 0), Piece(2.5, 3.5, 1)])
        self.assertEqual(score["verifiedPublishedWords"], 2)
        self.assertEqual([w["index"] for w in score["missing"]], [2])
        self.assertEqual(score["verifiedWordRecall"], .5)
        clip = {"kind": "media", "mediaId": "cam", "sourceIn": .5, "sourceOut": 1.5, "timelineIn": 0}
        timeline = {"tracks": [{"kind": "audio", "clips": [clip, dict(clip, sourceIn=2.5, sourceOut=3.5, timelineIn=.95),
                                                            dict(clip, mediaId="screen")]}]}
        crossfaded = timeline_pieces(timeline, "cam", source_coverage_only=True)
        self.assertEqual(verified_keeps(words, ref, crossfaded)["missing"], score["missing"])

    def test_pause_counts_use_strict_bounds_and_no_fabricated_empty_mean(self):
        self.assertEqual(rate([200, -200, 200.01, -200.01])["longerByOver200Ms"], 1)
        self.assertEqual(rate([200, -200, 200.01, -200.01])["shorterByOver200Ms"], 1)
        self.assertIsNone(rate([])["meanAbsoluteErrorMs"])
        words = [{"end": 1.1}, {"start": 4.8}]
        self.assertAlmostEqual(pause_ms(words, 0, 1, 1, 4.6), 200)

    def test_source_clock_and_real_denominators(self):
        words = [{"start": .1, "end": .8}, {"start": 1.3, "end": 1.5}, {"start": 2.1, "end": 2.3}]
        placement = {"start": 1., "end": 2., "wrongWords": 0, "wrongWordIndices": []}
        audio = {"joins": [{"finalTime": 1., "rawOut": 1., "rawIn": 2.},
                           {"finalTime": 3., "rawOut": .85, "rawIn": 1.1}]}
        rows = [{"index": 0, "outcome": "review", "fromWord": 1, "toWord": 1, "frameAligned": placement},
                {"index": 1, "outcome": "untrimmed", "afterWord": 0,
                 "frameAligned": dict(placement, start=.85, end=.85, untouched=True)}]
        report = arm_score({"rows": rows}, words, audio, {"sourceId": "id", "pairs": [[3, 8]]},
                           [n * .25 for n in range(12)])
        self.assertEqual(report["pacing"], dict(joins=2, longerByOver200Ms=1, shorterByOver200Ms=0, meanAbsoluteErrorMs=125))
        self.assertEqual(report["pictures"]["candidateCuts"], 1)
        self.assertEqual(report["pictures"]["byTolerance"][0]["matched"], 1)
        self.assertEqual(report["outcomes"], {"review": 1, "untrimmed": 1})
        self.assertEqual(report["joinsTrimmingFurtherIntoKeptWords"], 0)
        clipped = dict(placement, end=2.16)
        clipped_rows = [dict(rows[0], frameAligned=clipped)]
        clipped_report = arm_score({"rows": clipped_rows}, words, audio, {"sourceId": "id", "pairs": []},
                                   [n * .25 for n in range(12)])
        self.assertEqual(clipped_report["placements"][0]["extraKeptWordTrimMs"], {"incoming": 60})
        rows[0]["frameAligned"] = dict(placement, wrongWords=1, wrongWordIndices=[0])
        changed = arm_score({"rows": rows}, words, audio, {"sourceId": "id", "pairs": []}, [n * .25 for n in range(12)])
        self.assertEqual(changed["pacing"]["joins"], 1)
        self.assertEqual(changed["joinsChangingWords"], 1)
        self.assertEqual(changed["placements"][0]["wrongWordIndices"], [0])
        self.assertIsNone(changed["pictures"]["byTolerance"][0]["percentOfVerifiedCuts"])

    def test_freezing_is_idempotent_and_rejects_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock.json"
            seal(path, encoded({"v": 1}))
            seal(path, encoded({"v": 1}))
            with self.assertRaises(ValueError):
                seal(path, encoded({"v": 2}))
            self.assertEqual(path.read_bytes(), encoded({"v": 1}))
            (Path(directory) / ".git").mkdir()
            with self.assertRaises(ValueError):
                private_path(path)

    def test_accepted_result_reproduces_after_reading_the_pinned_settings_from_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = {"media/presenter.mp4": "frozen"}
            (root / "episode.lock.json").write_bytes(encoded({"schema": 1, "case": "sample", "files": files}))
            args = SimpleNamespace(episode=root, freeze=None, baseline=root, candidate=root,
                                   baseline_leave=.25, candidate_leave=.15, accept_baseline=True, check_baseline=False)
            with (patch.object(compare, "inventory", return_value=files), patch.object(compare, "checkout_version", return_value={}),
                  patch.object(compare, "build_checkouts"), patch.object(compare, "replay"),
                  patch.object(compare, "assemble", side_effect=lambda *args: {"case": "sample"}),
                  patch.object(compare, "score_text", return_value="sample"), patch("builtins.print")):
                compare.execute(args)
                original = (root / "expected.json").read_bytes()
                args.accept_baseline, args.check_baseline = False, True
                args.baseline_leave = args.candidate_leave = None
                compare.execute(args)
                self.assertEqual((root / "expected.json").read_bytes(), original)
                self.assertEqual(json.loads(original)["leaveSeconds"], [.25, .15])
                args.candidate_leave = .10
                with self.assertRaisesRegex(ValueError, "differs from the accepted baseline"):
                    compare.execute(args)

    def test_examples_only_use_changed_matched_joins(self):
        left = [{"index": i, "start": 1, "end": 2, "errorMs": 100} for i in range(4)]
        right = [dict(r, start=1.1, errorMs=e) for r, e in zip(left, (0, 205, 95, 550))]
        q = {"baseline": {"placements": left}, "candidate": {"placements": right}, "paired": {"indices": [0, 1, 2]}}
        self.assertEqual([row[1] for row in choices(q)], [0, 1, 2])
        q["paired"]["indices"] = []
        self.assertEqual(choices(q), [])
