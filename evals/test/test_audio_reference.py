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

    def test_signed_pause_rates_use_the_same_word_occurrences_and_strict_threshold(self):
        # All words sound alike but keep their source occurrence identity.
        for word in self.words:
            word['text'] = 'again'
        for shift_ms, longer, shorter in [(200, 0, 0), (201, 1, 0), (-200, 0, 0), (-201, 0, 1)]:
            with self.subTest(shift=shift_ms):
                end = 12 + min(0, shift_ms / 1000)
                result = self.score([Piece(8, end, 0), Piece(0, 4, 4 + shift_ms / 1000)])['spacing']
                self.assertEqual((result['eligibleJoins'], result['sharedJoins']), (1, 1))
                self.assertEqual([result['longerByOver200Ms'], result['shorterByOver200Ms']], [longer, shorter])
                self.assertEqual([result['longerByOver200MsPct'], result['shorterByOver200MsPct']], [100 * longer, 100 * shorter])
        wrong_take = self.score([Piece(4, 8, 0), Piece(0, 4, 4)])['spacing']
        self.assertEqual((wrong_take['eligibleJoins'], wrong_take['sharedJoins']), (1, 0))
        self.assertIsNone(wrong_take['longerByOver200MsPct'])
        self.assertIsNone(wrong_take['shorterByOver200MsPct'])

    def test_unmatched_eligible_cut_is_excluded_from_both_rate_denominators(self):
        self.reference.update(finalDuration=6, segments=[
            dict(rawStart=0, rawEnd=2, finalStart=0, finalEnd=2),
            dict(rawStart=4, rawEnd=6, finalStart=2, finalEnd=4),
            dict(rawStart=8, rawEnd=10, finalStart=4, finalEnd=6),
        ], joins=[dict(finalTime=t, earliestFinal=t, latestFinal=t) for t in (2, 4)])
        spacing = self.score([Piece(0, 2, 0), Piece(4, 6, 2.3)])['spacing']
        self.assertEqual((spacing['eligibleJoins'], spacing['sharedJoins']), (2, 1))
        self.assertEqual((spacing['longerByOver200Ms'], spacing['longerByOver200MsPct']), (1, 100))

    def test_wordless_piece_between_flanks_is_two_candidate_cuts(self):
        candidate = [Piece(8, 12, 0), Piece(5.75, 6.15, 4), Piece(0, 4, 4.4)]
        spacing = self.score(candidate)['spacing']
        self.assertEqual((spacing['eligibleJoins'], spacing['candidateJoins']), (1, 2))
        self.assertEqual((spacing['sharedJoins'], spacing['sameWordsUnedited']), (0, 0))
        self.assertEqual(spacing['matched'], [])
        self.assertIsNone(spacing['longerByOver200MsPct'])

    def test_retained_word_fragments_stop_and_start_at_the_splice(self):
        # Source word 11 ends at 11.70 and word 0 starts at 0.20. Both midpoints
        # survive, but only their clipped portions play, separated by 0.10 s.
        spacing = self.score([Piece(8, 11.55, 0), Piece(.35, 4, 3.65)])['spacing']
        self.assertEqual(spacing['sharedJoins'], 1)
        matched = spacing['matched'][0]
        self.assertEqual((matched['afterWord'], matched['beforeWord']), (11, 0))
        self.assertEqual((matched['referenceMs'], matched['candidateMs'], matched['errorMs']), (500, 100, -400))

    def test_second_band_excludes_indeterminate_words_and_joins(self):
        self.reference['joins'][0]['highBandLatestFinal'] = 4.6
        guarded = self.score(reference_pieces(self.reference))
        self.assertGreaterEqual(guarded['wordCoverage']['uncertain'], 1)
        self.assertEqual(guarded['spacing']['eligibleJoins'], 0)
        self.assertIsNone(guarded['spacing']['medianErrorMs'])
        self.reference['unmappedFinal'] = [dict(finalStart=2, finalEnd=3)]
        with self.assertRaisesRegex(ValueError, 'unexplained audio'):
            self.score([])

    def test_annotated_exclusions_are_not_silently_scored(self):
        for field in ('externalFinal', 'uncertainRetainedSource', 'excludeJoinsTouchingFinalIntervals'):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'annotated'):
                reference_pieces(dict(self.reference, **{field: [[1, 2]]}))

    def test_continuous_split_speed_and_silent_picture(self):
        def clip(at, into, out, media='mic'):
            return dict(kind='media', mediaId=media, sourceIn=into, sourceOut=out, timelineIn=at, speed=2)
        tl = {'tracks': [{'kind': 'video', 'clips': [clip(0, 1, 2), clip(.5, 2, 3), clip(0, 5, 10, 'screen')]}]}
        pieces = timeline_pieces(tl, 'mic', {'screen'})
        self.assertEqual(pieces, [Piece(1, 3, 0, 2)])
        self.assertEqual(pieces[0].playback(2.5), .75)
        with self.assertRaisesRegex(ValueError, 'More than one'):
            timeline_pieces(tl, 'mic')
