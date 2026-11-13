"""Synthetic audio regression tests. Run with python -B -m unittest discover -s evals/test -p test_match_audio.py."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from match_audio import RATE, map_audio


class AudioMatchTest(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(752)
        self.raw = self.rng.normal(0, .1, 8 * RATE).astype('f')

    def match(self, raw, final):
        return map_audio(raw, final, len(raw) / RATE, len(final) / RATE, 25)

    def test_reordered_and_reused_audio_under_gain_and_noise(self):
        chunks = [self.raw[5*RATE:7*RATE], self.raw[RATE:2*RATE], self.raw[5*RATE:7*RATE]]
        final = .6 * np.concatenate(chunks) + self.rng.normal(0, .005, 5*RATE)
        result = self.match(self.raw, final)
        self.assertEqual(result['unmappedFinal'], [])
        self.assertEqual(result['keptSource'], [[1., 2.], [5., 7.]])
        self.assertEqual(result['removedSource'], [[0., 1.], [2., 5.], [7., 8.]])
        self.assertEqual([seg['rawStart'] for seg in result['segments']], [5., 1., 5.])
        self.assertEqual([join['finalTime'] for join in result['joins']], [2., 3.])

    def test_foreign_insert_stays_unmapped(self):
        foreign = self.rng.normal(0, .1, RATE)
        final = np.concatenate([self.raw[:2*RATE], foreign, self.raw[3*RATE:5*RATE]])
        result = self.match(self.raw, final)
        self.assertIsNone(result['removedSource'])
        self.assertTrue(any(gap['finalStart'] <= 2.1 and gap['finalEnd'] >= 2.9 for gap in result['unmappedFinal']))

    def test_duplicate_source_material_has_no_unique_origin(self):
        final = self.raw[RATE:2*RATE]
        ambiguous = np.concatenate([self.raw, final])
        result = self.match(ambiguous, final)
        self.assertEqual(result['segments'], [])
        self.assertEqual(result['unmappedFinal'], [{'finalStart': 0., 'finalEnd': 1.}])

    def test_silence_and_foreign_audio_supply_no_removal_labels(self):
        for final in [np.zeros(RATE, dtype='f'), self.rng.normal(0, .1, RATE)]:
            result = self.match(self.raw, final)
            self.assertIsNone(result['removedSource'])
            self.assertEqual(result['mappedFraction'], 0.)


if __name__ == '__main__':
    unittest.main()
