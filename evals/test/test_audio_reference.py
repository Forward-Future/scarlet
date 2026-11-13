"""Synthetic source-index, timing and order controls for the waveform-reference scorer."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from score_audio_reference import Piece, reference_pieces, score, timeline_pieces


class AudioReferenceScoreTests(unittest.TestCase):
    def setUp(self):
        self.words = [dict(start=i + .2, end=i + .7, text=f'word{i}.') for i in range(12)]
        self.reference = {
            'rawDuration': 12, 'finalDuration': 8, 'frameDuration': .03, 'unmappedFinal': [],
            'segments': [
                dict(rawStart=8, rawEnd=12, finalStart=0, finalEnd=4),
                dict(rawStart=0, rawEnd=4, finalStart=4, finalEnd=8),
            ],
            'joins': [dict(finalTime=4, earliestFinal=4, latestFinal=4, highBandEarliestFinal=4, highBandLatestFinal=4)],
        }

    def score(self, candidate):
        return score(self.words, self.reference, candidate)

    def test_identity_and_same_words_in_wrong_order(self):
        perfect = self.score(reference_pieces(self.reference))
        for metric in ('removedWords', 'removedTime'):
            self.assertEqual(perfect[metric]['f1'], 1)
        self.assertEqual(perfect['removedWords']['tp'], 4)
        self.assertEqual(perfect['spacing']['sharedJoins'], 1)
        self.assertEqual(perfect['spacing']['medianAbsErrorMs'], 0)
        self.assertEqual(perfect['order']['invertedPairs'], 0)
        by_source_time = self.score([Piece(0, 4, 0), Piece(8, 12, 4)])
        self.assertEqual(by_source_time['removedWords']['f1'], 1)
        self.assertEqual(by_source_time['order']['invertedPairs'], 16)
        self.assertEqual(by_source_time['spacing']['sharedJoins'], 0)

    def test_output_clock_and_missing_content(self):
        extra_gap = self.score([Piece(8, 12, 0), Piece(0, 4, 4.2)])
        self.assertEqual(extra_gap['spacing']['medianErrorMs'], 200)
        missing = self.score([Piece(8, 11, 0)])
        self.assertEqual(missing['requiredLines']['missing'], 5)
        self.assertEqual(missing['removedWords']['fp'], 5)
        self.assertEqual(self.score([Piece(0, 12, 0)])['removedWords']['recall'], 0)

    def test_second_band_excludes_indeterminate_words_and_joins(self):
        self.reference['joins'][0]['highBandLatestFinal'] = 4.6
        guarded = self.score(reference_pieces(self.reference))
        self.assertGreaterEqual(guarded['wordCoverage']['uncertain'], 1)
        self.assertEqual(guarded['spacing']['eligibleJoins'], 0)
        self.assertIsNone(guarded['spacing']['medianErrorMs'])
        self.reference['unmappedFinal'] = [dict(finalStart=2, finalEnd=3)]
        with self.assertRaisesRegex(ValueError, 'unexplained audio'):
            self.score([])

    def test_continuous_split_speed_and_silent_picture(self):
        def clip(at, into, out, media='mic'):
            return dict(kind='media', mediaId=media, sourceIn=into, sourceOut=out, timelineIn=at, speed=2)
        tl = {'tracks': [{'kind': 'video', 'clips': [clip(0, 1, 2), clip(.5, 2, 3), clip(0, 5, 10, 'screen')]}]}
        pieces = timeline_pieces(tl, 'mic', {'screen'})
        self.assertEqual(pieces, [Piece(1, 3, 0, 2)])
        self.assertEqual(pieces[0].playback(2.5), .75)
        with self.assertRaisesRegex(ValueError, 'More than one'):
            timeline_pieces(tl, 'mic')
