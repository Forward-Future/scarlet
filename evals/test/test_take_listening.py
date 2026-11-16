"""A model's first answer must still identify the same take after the excerpts move."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from take_listening import decode, prepare, score, seal_responses


class TakeListeningTests(unittest.TestCase):
    def test_paired_prompts_swapped_excerpts_and_receipt_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            guide = root / "guide.md"
            guide.write_text("Keep the complete line.")
            windows = []
            for name in ("earlier", "later"):
                snippet = root / name
                snippet.write_text(name)
                windows.append({"path": name, "transcript": name, "sha256": hashlib.sha256(snippet.read_bytes()).hexdigest()})
            options = [{"id": name, "description": name, "text": name} for name in ("first", "second", "both")]
            trial = {"id": "passage", "case": "example", "split": "test", "windows": windows,
                     "options": options, "transcript": "source passage", "editorChoice": "hidden-answer"}
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"trials": [trial]}))
            batch = root / "batch"
            self.assertEqual(prepare(manifest, [guide], batch, 11), 4)
            requests = [json.loads(line) for line in (batch / "requests.jsonl").read_text().splitlines()]
            specs = json.loads((batch / "key.json").read_text())["requests"]
            self.assertEqual(requests[0]["prompt"], requests[1]["prompt"])
            self.assertEqual(requests[2]["prompt"], requests[3]["prompt"])
            self.assertNotIn("hidden-answer", str(requests))
            self.assertEqual(requests[1]["audio"], requests[3]["audio"][::-1])
            self.assertEqual(requests[0]["audio"], [])
            answers = []
            for r in requests:
                spec = specs[r["id"]]
                letter = next(k for k, v in spec["options"].items() if v == "second")
                answers.append({"id": r["id"], "prompt_sha256": hashlib.sha256(r["prompt"].encode()).hexdigest(),
                                "decoder": "greedy_choice", "choice_logits": dict.fromkeys("ABC", 0),
                                "seed": 11, "temperature": 0, "audio_count": len(r["audio"]), "audio_tokens": 100 * len(r["audio"]), "audio_sha256": spec["audioSha256"], "text": letter})
            self.assertNotEqual(answers[1]["text"], answers[3]["text"])
            responses = root / "responses.jsonl"
            responses.write_text("\n".join(map(json.dumps, answers)))
            runtime = dict(adapter_sha256="a" * 64, files_sha256={"weights": "b" * 64}, packages={"model-runtime": "1"})
            seal_responses(batch / "requests.jsonl", responses, runtime)
            decoded = root / "choices.json"
            decode(batch, responses, decoded)
            self.assertEqual([r["choice"] for r in json.loads(decoded.read_text())], ["second"] * 4)
            # Reversing the decoder mappings must not change an answer from the same sealed run.
            key_path = batch / "key.json"
            original_key = key_path.read_bytes()
            altered = json.loads(original_key)
            for spec in altered["requests"].values():
                spec["options"]["A"], spec["options"]["B"] = spec["options"]["B"], spec["options"]["A"]
            key_path.write_text(json.dumps(altered))
            with self.assertRaisesRegex(ValueError, "Decoder key"):
                decode(batch, responses, root / "swapped.json")
            key_path.write_bytes(original_key)
            rows = json.loads(decoded.read_bytes())
            labels = [{"id": "passage", "case": "example", "split": "test", "exact": {"targetChoice": "second"}}]
            # Old numeric IDs can be decoded only against an independently preserved key digest.
            legacy = root / "legacy"
            legacy.mkdir()
            old_key = json.loads(original_key)
            old_key["requests"] = {rid.partition(".")[0]: spec for rid, spec in old_key["requests"].items()}
            key_bytes = json.dumps(old_key).encode()
            (legacy / "key.json").write_bytes(key_bytes)
            old_requests = legacy / "requests.jsonl"
            old_responses = root / "old-responses.jsonl"
            for source, destination in [(requests, old_requests), (answers, old_responses)]:
                destination.write_text("\n".join(json.dumps(dict(row, id=row["id"].partition(".")[0])) for row in source))
            seal_responses(old_requests, old_responses, runtime)
            with self.assertRaisesRegex(ValueError, "independent archive"):
                decode(legacy, old_responses, root / "unverified.json")
            digest = hashlib.sha256(key_bytes).hexdigest()
            decode(legacy, old_responses, root / "old-choices.json", legacy_key_sha256=digest)
            self.assertEqual([r["choice"] for r in json.loads((root / "old-choices.json").read_bytes())], ["second"] * 4)
            with self.assertRaisesRegex(ValueError, "independent archive"):
                decode(legacy, old_responses, root / "wrong-digest.json", legacy_key_sha256="b" * 64)
            rows[0]["choice"] = None
            results = {r["modality"]: r for r in score(rows, labels, "exact")}
            self.assertEqual(results["audio"]["bothOrdersCorrect"], 1)
            self.assertEqual(results["text"]["validAnswers"], 1)
            self.assertEqual(results["text"]["bothOrdersCorrect"], 0)
            self.assertEqual(results["text"]["reverseOrderCorrect"], 1)
            labels[0]["exact"]["targetChoice"] = None
            self.assertEqual(score(rows, labels, "exact")[0]["scorable"], 0)
            with self.assertRaisesRegex(ValueError, "Missing a presentation"):
                score(rows[:-1], labels, "exact")
            with self.assertRaisesRegex(ValueError, "Missing an arm"):
                score([r for r in rows if r["modality"] == "text"], labels, "exact")
            answers[1]["audio_sha256"].reverse()
            responses.write_text("\n".join(map(json.dumps, answers)))
            with self.assertRaisesRegex(ValueError, "Sealed batch"):
                decode(batch, responses, root / "bad.json")
            malformed = root / "different.jsonl"
            answers[1]["runtime_sha256"] = "c" * 64
            malformed.write_text("\n".join(map(json.dumps, answers)))
            with self.assertRaisesRegex(ValueError, "Different model"):
                seal_responses(batch / "requests.jsonl", malformed, runtime)
            del answers[1]["runtime_sha256"]
            del answers[1]["decoder"]
            malformed.write_text("\n".join(map(json.dumps, answers)))
            with self.assertRaisesRegex(ValueError, "Missing decoder"):
                seal_responses(batch / "requests.jsonl", malformed, runtime)


if __name__ == "__main__":
    unittest.main()
