#!/usr/bin/env python3
"""Compare measured outgoing/incoming source-frame pairs for one recording."""
import argparse
from bisect import bisect_left, bisect_right
from collections import deque
import json
from pathlib import Path


def frame_pairs(document):
    if not isinstance(document, dict) or not isinstance(document.get('sourceId'), str) or not document['sourceId'].strip():
        raise ValueError('Each input needs a nonempty sourceId identifying its original recording.')
    pairs = document.get('pairs')
    if not isinstance(pairs, list):
        raise ValueError('Expected a pairs array of [outgoingFrame, incomingFrame].')
    for pair in pairs:
        if not isinstance(pair, list) or len(pair) != 2 or any(type(i) is not int or i < 0 for i in pair):
            raise ValueError('Frame pairs must contain two nonnegative integer source-frame indices.')
    return pairs


def count_matches(reference, candidates, tolerance):
    # Narrow by outgoing frame before comparing the incoming side of the same cut.
    ordered = sorted(candidates)
    outgoing = [left for left, _ in ordered]
    neighbors = []
    for left, right in reference:
        start = bisect_left(outgoing, left - tolerance)
        end = bisect_right(outgoing, left + tolerance)
        neighbors.append([i for i in range(start, end) if abs(ordered[i][1] - right) <= tolerance])

    # Augment a one-to-one matching. A nearby reference may need to give up its
    # first candidate so that two cuts can both be matched.
    owner = {}
    assigned = {}

    def augment(start):
        queue = deque([start])
        parent = {}
        while queue:
            ref = queue.popleft()
            for candidate in neighbors[ref]:
                if candidate in parent:
                    continue
                parent[candidate] = ref
                if candidate in owner:
                    queue.append(owner[candidate])
                    continue
                while candidate is not None:
                    ref = parent[candidate]
                    previous = assigned.get(ref)
                    assigned[ref] = candidate
                    owner[candidate] = ref
                    candidate = previous
                return

    for start in range(len(reference)):
        augment(start)
    return len(assigned)


def score(reference, candidate):
    refs = frame_pairs(reference)
    supplied = frame_pairs(candidate)
    if reference['sourceId'] != candidate['sourceId']:
        raise ValueError('The inputs identify different source recordings.')
    if any(right == left + 1 for left, right in refs):
        raise ValueError('Verified reference cuts must be discontinuities in the source frame sequence.')
    cuts = [pair for pair in supplied if pair[1] != pair[0] + 1]
    rates = []
    for tolerance in (0, 5, 10):
        hits = count_matches(refs, cuts, tolerance)
        rates.append(dict(toleranceFrames=tolerance, matched=hits,
                          percentOfVerifiedCuts=100 * hits / len(refs) if refs else None))
    return dict(sourceId=reference['sourceId'], verifiedReferenceCuts=len(refs),
                candidateCuts=len(cuts), ignoredContinuousSplits=len(supplied) - len(cuts), byTolerance=rates)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True, help='Verified cut pairs from the human edit')
    parser.add_argument('--candidate', type=Path, required=True, help='Observed frame pairs from the candidate edit')
    args = parser.parse_args()
    try:
        result = score(json.loads(args.reference.read_bytes()), json.loads(args.candidate.read_bytes()))
    except (OSError, ValueError) as exc:
        parser.exit(2, f'Cannot score source-frame pairs: {exc}\n')
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
