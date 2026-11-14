#!/usr/bin/env python3
"""Score an actual Scarlet timeline against an audio-correlated reference, using only the raw transcript."""
import argparse
from bisect import bisect_left
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import math
import re

EPS = 1e-7


@dataclass(frozen=True)
class Piece:
    start: float
    end: float
    at: float
    speed: float = 1.0
    # Plausible shifts, in source seconds, of this piece's first and last edges.
    in_shift: tuple = (0.0, 0.0)
    out_shift: tuple = (0.0, 0.0)

    def playback(self, t):
        return self.at + (min(max(t, self.start), self.end) - self.start) / self.speed


def union(ranges):
    result = []
    for a, b in sorted(ranges):
        if b <= a:
            continue
        if result and result[-1][1] >= a - EPS:
            result[-1][1] = max(b, result[-1][1])
        else:
            result.append([a, b])
    return result


def intersect_len(pairs, other):
    return sum(max(0, min(b, y) - max(a, x)) for a, b in pairs for x, y in other)


def stats(tp, fp, fn):
    return dict(tp=tp, fp=fp, fn=fn,
                precision=tp / (tp + fp) if tp + fp else None,
                recall=tp / (tp + fn) if tp + fn else None,
                f1=2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None)


def reference_pieces(ref):
    if ref['unmappedFinal']:
        raise ValueError('The final contains unexplained audio. Source-wide cut labels require complete mapping.')
    if ref.get('externalFinal') or ref.get('uncertainRetainedSource') or ref.get('excludeJoinsTouchingFinalIntervals'):
        raise ValueError('This single-source scorer does not interpret external passages or annotated source/join exclusions.')
    frame = 1 / ref['frameRate'] if 'frameRate' in ref else ref['frameDuration']
    shifts = {}
    for j in ref['joins']:
        t = j['finalTime']
        early = min(j['earliestFinal'], j.get('highBandEarliestFinal', t), j.get('highBandFinal', t))
        late = max(j['latestFinal'], j.get('highBandLatestFinal', t), j.get('highBandFinal', t))
        shifts[t] = (early - t - frame, late - t + frame)
    result = []
    for s in ref['segments']:
        a, b = s['finalStart'], s['finalEnd']
        if abs((s['rawEnd'] - s['rawStart']) - (b - a)) > .002:
            raise ValueError('Reference piece speed differs from the expected correlation model.')
        if result and abs(a - result[-1].playback(result[-1].end)) > .002:
            raise ValueError('Gap or overlap in reference playback.')
        result.append(Piece(s['rawStart'], s['rawEnd'], a, 1, shifts.get(a, (0, 0)), shifts.get(b, (0, 0))))
    if not result or abs(result[0].at) > .002 or abs(result[-1].playback(result[-1].end) - ref['finalDuration']) > .002:
        raise ValueError('Reference does not cover the full program.')
    return result


def timeline_pieces(tl, media, silent_media=()):
    result = []
    for track in tl['tracks']:
        if track.get('muted') or track['kind'] == 'caption':
            continue
        for c in track['clips']:
            if c['kind'] != 'media' or not c.get('enabled', True) or c.get('volume', 1) <= 0:
                continue
            if c['mediaId'] in silent_media:
                continue
            if c['mediaId'] != media:
                raise ValueError('More than one audible recording. Supply a single-source cut and its evidence.')
            if c['sourceOut'] <= c['sourceIn'] or c.get('speed', 1) <= 0:
                raise ValueError('Invalid source range or clip speed.')
            result.append(Piece(c['sourceIn'], c['sourceOut'], c['timelineIn'], c.get('speed', 1)))
    merged = []
    for s in sorted(result, key=lambda p: p.at):
        p = merged[-1] if merged else None
        if p and s.at < p.playback(p.end) - .001:
            raise ValueError('Overlapping audible clips need multitrack scoring.')
        if p and p.speed == s.speed and abs(p.end - s.start) < .001 and abs(p.playback(p.end) - s.at) < .001:
            merged[-1] = Piece(p.start, s.end, p.at, p.speed)
        else:
            merged.append(s)
    return merged


def by_piece(words, pieces):
    # Word inclusion uses the source midpoint. Fixed raw occurrence indices distinguish retakes.
    return [[i for i, w in enumerate(words) if s.start <= (w['start'] + w['end']) / 2 < s.end] for s in pieces]


def stable_limiting_id(words, piece, side, expect):
    # The innermost and outermost plausible extents must identify the same word.
    for start_shift, end_shift in ((piece.in_shift[1], piece.out_shift[0]), (piece.in_shift[0], piece.out_shift[1])):
        a, b = piece.start + start_shift, piece.end + end_shift
        ids = [i for i, w in enumerate(words) if a <= (w['start'] + w['end']) / 2 < b]
        if not ids or (ids[-1] if side == 'out' else ids[0]) != expect:
            return False
    return True


def quant(values, q):
    if not values:
        return None
    xs = sorted(values)
    x = (len(xs) - 1) * q
    lo = int(x)
    return round(xs[lo] + (xs[min(lo + 1, len(xs) - 1)] - xs[lo]) * (x - lo), 2)


def pair_gap(words, a, b, left, right):
    # playback() clamps a partially retained word to the edge of its piece.
    return 1000 * max(0, b.playback(words[right]['start']) - a.playback(words[left]['end']))


def join_spacing(words, reference, candidate):
    rpages, cpages = by_piece(words, reference), by_piece(words, candidate)
    rseq = [(n, i) for n, page in enumerate(rpages) for i in page]
    cseq = [(n, i) for n, page in enumerate(cpages) for i in page]
    pairs = {}
    for (a, left), (b, right) in zip(cseq, cseq[1:]):
        pairs.setdefault((left, right), []).append((a, b))
    rkeys = Counter((left, right) for (a, left), (b, right) in zip(rseq, rseq[1:]) if a != b)
    lexical_known = shared_words_uncut = 0
    matched = []
    for (a, left), (b, right) in zip(rseq, rseq[1:]):
        if a == b or b != a + 1:
            continue
        p, q = reference[a], reference[b]
        if not stable_limiting_id(words, p, 'out', left) or not stable_limiting_id(words, q, 'in', right):
            continue
        if rkeys[(left, right)] != 1:
            continue
        lexical_known += 1
        where = pairs.get((left, right), [])
        if len(where) != 1:
            continue
        i, j = where[0]
        if i == j:
            shared_words_uncut += 1
            continue
        if j != i + 1:
            continue
        ref_gap = pair_gap(words, p, q, left, right)
        cand_gap = pair_gap(words, candidate[i], candidate[j], left, right)
        matched.append(dict(after=words[left]['text'], before=words[right]['text'], afterWord=left, beforeWord=right,
                            finalAt=round(q.at, 4), referenceMs=round(ref_gap, 2), candidateMs=round(cand_gap, 2),
                            errorMs=round(cand_gap - ref_gap, 2)))
    errors = [m['errorMs'] for m in matched]
    absolute = [abs(e) for e in errors]
    longer = sum(e > 200 for e in errors)
    shorter = sum(e < -200 for e in errors)
    return dict(referenceJoins=max(len(reference) - 1, 0), eligibleJoins=lexical_known,
                candidateJoins=max(len(candidate) - 1, 0), sharedJoins=len(matched), sameWordsUnedited=shared_words_uncut,
                longerByOver200Ms=longer, shorterByOver200Ms=shorter,
                longerByOver200MsPct=100 * longer / len(errors) if errors else None,
                shorterByOver200MsPct=100 * shorter / len(errors) if errors else None,
                referenceMedianMs=quant([m['referenceMs'] for m in matched], .5),
                candidateMedianMs=quant([m['candidateMs'] for m in matched], .5),
                medianErrorMs=quant(errors, .5), medianAbsErrorMs=quant(absolute, .5),
                p90AbsErrorMs=quant(absolute, .9), matched=matched)


def word_order(words, refpes, candpes, certain):
    ref = [i for p in by_piece(words, refpes) for i in p if certain[i] == 'keep']
    cand = [i for p in by_piece(words, candpes) for i in p if certain[i] == 'keep']
    cr, cc = Counter(ref), Counter(cand)
    rank = {i: j for j, i in enumerate(ref) if cr[i] == cc[i] == 1}
    seq = [rank[i] for i in cand if i in rank]
    seen, inversions = [], 0
    for index in seq:
        position = bisect_left(seen, index)
        inversions += len(seen) - position
        seen.insert(position, index)
    pairs = len(seq) * (len(seq) - 1) // 2
    return dict(sharedUniqueWords=len(seq), referenceUniqueKeptWords=len(cr), comparablePairs=pairs,
                invertedPairs=inversions, invertedFraction=inversions / pairs if pairs else None,
                ambiguousRepeatedSourceWords=sum(cr[i] > 1 or cc[i] > 1 for i in set(cr) & set(cc)))


def score(words, ref, candidate):
    reference = reference_pieces(ref)
    duration = ref['rawDuration']
    sure = union((max(0, p.start + p.in_shift[1]), min(duration, p.end + p.out_shift[0])) for p in reference)
    possible = union((max(0, p.start + p.in_shift[0]), min(duration, p.end + p.out_shift[1])) for p in reference)
    kept = union((max(0, p.start), min(duration, p.end)) for p in candidate)
    sure_seconds = sum(b - a for a, b in sure)
    possible_seconds = sum(b - a for a, b in possible)
    kept_seconds = sum(b - a for a, b in kept)
    # Ground truth is three-valued in the uncertainty band. Only definite reference labels enter P/R.
    certainty, pred = [], []
    for w in words:
        wrange = [(w['start'], w['end'])]
        half = (w['end'] - w['start']) / 2
        if intersect_len(wrange, sure) >= half:
            certainty.append('keep')
        elif intersect_len(wrange, possible) < half:
            certainty.append('cut')
        else:
            certainty.append(None)
        pred.append('keep' if intersect_len(wrange, kept) >= half else 'cut')
    tp = sum(a == b == 'cut' for a, b in zip(certainty, pred))
    fp = sum(a == 'keep' and b == 'cut' for a, b in zip(certainty, pred))
    fn = sum(a == 'cut' and b == 'keep' for a, b in zip(certainty, pred))
    cuts_kept = kept_seconds - intersect_len(kept, possible)
    secs = stats(duration - possible_seconds - cuts_kept, sure_seconds - intersect_len(kept, sure), cuts_kept)

    lines, current = [], []
    for i, w in enumerate(words):
        if current and w['start'] - words[current[-1]]['end'] > 1.5:
            lines.append(current)
            current = []
        current.append(i)
        if re.search(r"""[.?!]["'”’)\]]*$""", w['text'].strip()):
            lines.append(current)
            current = []
    if current:
        lines.append(current)
    required = [s for s in lines if sum(certainty[i] == 'keep' for i in s) >= .8 * len(s)]
    missing = [s for s in required if sum(pred[i] == 'cut' for i in s) >= .5 * len(s)]
    return dict(reference='frame-level audio correlation, union of available boundary bounds plus one video frame',
                wordCoverage=dict(rawTranscriptWords=len(words), definite=len(words) - certainty.count(None), uncertain=certainty.count(None)),
                timeCoverage=dict(rawSeconds=duration, definiteSeconds=duration - possible_seconds + sure_seconds,
                                  mappedFinalSeconds=ref['finalDuration'], uncertainSourceSeconds=possible_seconds - sure_seconds),
                removedWords=stats(tp, fp, fn), removedTime=secs,
                requiredLines=dict(required=len(required), missing=len(missing),
                                   missingLines=[' '.join(words[i]['text'] for i in s) for s in missing]),
                order=word_order(words, reference, candidate, certainty), spacing=join_spacing(words, reference, candidate),
                falseCuts=[dict(i=i, **w) for i, w in enumerate(words) if certainty[i] == 'keep' and pred[i] == 'cut'],
                falseKeeps=[dict(i=i, **w) for i, w in enumerate(words) if certainty[i] == 'cut' and pred[i] == 'keep'])


def read_json(path):
    return json.loads(path.read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True, help='JSON source-to-final audio correlation map')
    parser.add_argument('--case-dir', type=Path, help='Stored Scarlet eval case directory')
    parser.add_argument('--evidence', type=Path, help='Raw media evidence JSON (mediaId, words in source seconds, optional duration)')
    selected = parser.add_mutually_exclusive_group(required=True)
    selected.add_argument('--timeline', type=Path, help='Scarlet timeline JSON')
    selected.add_argument('--evaluation', type=Path, help='evaluation.json referencing a timeline stored in --case-dir')
    parser.add_argument('--tier', default='applied', choices=['applied', 'proposed'])
    args = parser.parse_args()
    case = read_json(args.case_dir / 'case.json') if args.case_dir else None
    if args.evidence:
        evidence = read_json(args.evidence)
    elif case and len(case['dialogueMedia']) == 1:
        evidence = read_json(args.case_dir / 'evidence' / (case['dialogueMedia'][0] + '.json'))
    else:
        parser.error('Supply --evidence or --case-dir with evidence for a single dialogue recording.')
    if args.evaluation:
        if not case:
            parser.error('--evaluation needs --case-dir to resolve the version of its timeline.')
        evaluation = read_json(args.evaluation)
        if case['projectId'] != evaluation['projectId']:
            parser.error('The evaluation and case refer to different projects.')
        version = evaluation['score']['versions'][args.tier]
        path = args.case_dir / 'timelines' / (version + '.json')
        if not path.is_file():
            parser.error('The scored version is absent from this case. Export that version and use --timeline.')
        candidate = read_json(path)
    else:
        candidate = read_json(args.timeline)
    if case and (candidate['projectId'] != case['projectId'] or evidence['mediaId'] not in case['dialogueMedia']):
        parser.error('The timeline or raw evidence does not belong to this case.')
    words = sorted((w for w in evidence['words'] if w['end'] > w['start'] and re.search(r'\w', w['text'])
                    and not re.fullmatch(r'\[.*\]', w['text'].strip())), key=lambda w: w['start'])
    if not words:
        parser.error('No timed spoken words in raw media evidence.')
    reference = read_json(args.reference)
    frame = 1 / reference['frameRate'] if 'frameRate' in reference else reference['frameDuration']
    if evidence.get('duration') is not None and not math.isclose(evidence['duration'], reference['rawDuration'],
                                                                abs_tol=max(.25, frame * 2)):
        parser.error('Raw duration in the waveform map differs from the media evidence.')
    silent = {m['id'] for m in case['media'] if m['kind'] not in ('audio', 'video') or m.get('hasAudio') is False} if case else set()
    result = score(words, reference, timeline_pieces(candidate, evidence['mediaId'], silent))
    result.update(mediaId=evidence['mediaId'], timeline=candidate['version'],
                  referenceSha256=hashlib.sha256(args.reference.read_bytes()).hexdigest())
    print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
