"""Joint outgoing/incoming matches from measured source pictures."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

EVALS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EVALS))
from score_frame_pairs import score


def evidence(pairs):
    return {'sourceId': 'recording-a', 'pairs': pairs}


def hits(ref, candidate):
    result = score(evidence(ref), evidence(candidate))
    return [r['matched'] for r in result['byTolerance']]


class FramePairsTests(unittest.TestCase):
    def test_both_pictures_belong_to_the_same_cut(self):
        self.assertEqual(hits([[100, 200]], [[100, 450], [700, 200]]), [0, 0, 0])
        self.assertEqual(hits([[100, 200]], [[105, 195]]), [0, 1, 1])
        self.assertEqual(hits([[100, 200]], [[95, 210]]), [0, 0, 1])
        self.assertEqual(hits([[100, 200]], [[100, 211]]), [0, 0, 0])

    def test_collisions_require_maximum_matching(self):
        reference = [[100, 200], [104, 204]]
        # The candidate at 101/201 matches either cut. Only the first cut can use 96/196.
        self.assertEqual(hits(reference, [[101, 201], [96, 196]]), [0, 2, 2])
        self.assertEqual(hits(reference, [[101, 201]]), [0, 1, 1])
        self.assertEqual(hits([[100, 200]], [[100, 200], [100, 200]]), [1, 1, 1])

    def test_continuous_split_near_reference_and_missing_coverage(self):
        result = score(evidence([[100, 103]]), evidence([[100, 101]]))
        self.assertEqual(result['ignoredContinuousSplits'], 1)
        self.assertEqual(result['candidateCuts'], 0)
        self.assertEqual(result['byTolerance'][-1]['percentOfVerifiedCuts'], 0)
        empty = score(evidence([]), evidence([[3, 2]]))
        self.assertTrue(all(r['percentOfVerifiedCuts'] is None for r in empty['byTolerance']))

    def test_invalid_provenance_or_frame_indices(self):
        with self.assertRaisesRegex(ValueError, 'different source'):
            score(evidence([[9, 20]]), dict(sourceId='recording-b', pairs=[[9, 20]]))
        with self.assertRaisesRegex(ValueError, 'discontinuities'):
            score(evidence([[9, 10]]), evidence([]))
        for pair in ([2.2, 8], [-1, 7], [True, 3], [5]):
            with self.subTest(pair=pair), self.assertRaisesRegex(ValueError, 'integer'):
                score(evidence([]), evidence([pair]))

    def test_json_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'measured.json'
            path.write_text(json.dumps(evidence([[200, 100]])))
            cmd = [sys.executable, '-B', str(EVALS / 'score_frame_pairs.py'), '--reference', str(path), '--candidate', str(path)]
            result = json.loads(subprocess.check_output(cmd))
            self.assertEqual([r['percentOfVerifiedCuts'] for r in result['byTolerance']], [100, 100, 100])
