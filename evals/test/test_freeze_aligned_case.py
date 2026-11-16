"""A frozen alignment must preserve lexical indices and bind the inspected source and stream."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from freeze_aligned_case import freeze, original_grading_evidence


class FreezeAlignedCaseTests(unittest.TestCase):
    def test_refuses_other_source_or_stream_before_decoding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = root / "cases/episode"
            (case / "evidence").mkdir(parents=True)
            source, out = root / "camera", root / "aligned"
            source.write_bytes(b"frozen")
            media = dict(id="camera", hash=hashlib.sha256(b"frozen").hexdigest(), audioStream=1)
            (case / "case.json").write_text(json.dumps(dict(id="episode", dialogueMedia=["camera"], media=[media])))
            ev = case / "evidence/camera.json"
            ev.write_text(json.dumps(dict(mediaId="camera", audioStream=0, words=[dict(text="one", start=0, end=1)])))
            before = ev.read_bytes()
            with self.assertRaisesRegex(ValueError, "stream"):
                freeze(case, source, root / "model", out)
            original = dict(mediaId="camera", audioStream=1, words=[dict(text="one", start=0, end=1)])
            ev.write_text(json.dumps(dict(original, sourceSha256="b"*64)))
            with self.assertRaisesRegex(ValueError, "identity"):
                freeze(case, source, root / "model", out)
            ev.write_text(json.dumps(original))
            other = root / "other.json"
            for mismatch in [dict(sourceSha256="b"*64, audioStream=1),
                             dict(sourceSha256=media["hash"], audioStream=0), {}]:
                other.write_text(json.dumps(dict(inputs=mismatch, rawDuration=1)))
                with self.assertRaisesRegex(ValueError, "reference"):
                    freeze(case, source, root / "model", out, reference=other)
            ev.write_bytes(before)
            source.write_bytes(b"other")
            with self.assertRaisesRegex(ValueError, "identity"):
                freeze(case, source, root / "model", out)
            self.assertFalse(out.exists())
            self.assertEqual(ev.read_bytes(), before)

    def test_nested_freeze_keeps_original_grading_bytes_and_refuses_a_missing_or_swapped_pin(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = root / "cases/show"
            (case / "evidence").mkdir(parents=True)
            predict, fixed, manifest = case / "evidence/m.json", case / "grading-evidence.json", case / "case.json"
            source = "c"*64
            def digest(p):
                return hashlib.sha256(p.read_bytes()).hexdigest()
            native = dict(mediaId="m", words=[dict(text="start", start=.5, end=.7)])
            fixed.write_text(json.dumps(native))
            predict.write_text(json.dumps(dict(native, words=[dict(text="start", start=.6, end=.7)])))
            conf = dict(id="show", dialogueMedia=["m"],
                        gradingEvidence=dict(mediaId="m", sourceSha256=source, audioStream=0, sha256=digest(fixed)))
            manifest.write_text(json.dumps(conf))
            lock = dict(schema=1, case="show", files={p.relative_to(root).as_posix(): digest(p) for p in [manifest, predict, fixed]})
            (root / "episode.lock.json").write_text(json.dumps(lock))
            self.assertEqual(original_grading_evidence(case, conf, predict, source, 0), fixed)
            with self.assertRaisesRegex(ValueError, "recording"):
                original_grading_evidence(case, conf, predict, "d"*64, 0)
            fixed.write_bytes(predict.read_bytes())
            with self.assertRaisesRegex(ValueError, "digest"):
                original_grading_evidence(case, conf, predict, source, 0)
            fixed.unlink()
            with self.assertRaisesRegex(ValueError, "Missing"):
                original_grading_evidence(case, conf, predict, source, 0)


if __name__ == "__main__":
    unittest.main()
