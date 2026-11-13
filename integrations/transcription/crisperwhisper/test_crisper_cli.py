import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from types import SimpleNamespace

from crisper_cli import reconcile, save_json, whisper_json


def stamp(word, start, end):
    return SimpleNamespace(word=word, start=start, end=end)


class AdapterTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
