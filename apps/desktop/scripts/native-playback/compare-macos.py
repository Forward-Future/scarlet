#!/usr/bin/env python3
"""Compare two completed private macOS cohorts after native pixel verification."""
import argparse
import json
import math
from pathlib import Path
import statistics


def load_trial(path):
    def read(name):
        return json.loads((path / name).read_text())

    rows = read("suite/combined.json")["results"]
    pixels = {r["frame"]: r["nativePixelMs"] for r in read("pixel-verification.json") if r["nativePixelMs"] is not None}
    return rows, pixels, read("post-start-stalls.json")


def latency(values):
    if not values:
        return None
    return {
        "n": len(values), "p50Ms": round(statistics.median(values), 1),
        "p95Ms": round(sorted(values)[math.ceil(0.95 * len(values)) - 1], 1),
    }


def waits(records):
    closed = [r for r in records if r["sameMediaOnResume"]]
    open_waits = [r for r in records if r["rightCensored"]]
    nearby = [r for r in records if r["savedCutOffsetSeconds"] is not None and abs(r["savedCutOffsetSeconds"]) <= 0.15]
    return {
        "closed": len(closed), "closedTotalMs": round(sum(r["durationMs"] for r in closed), 1),
        "worstClosedMs": round(max((r["durationMs"] for r in closed), default=0), 1),
        "nearCutClosed": sum(r["sameMediaOnResume"] for r in nearby),
        "open": len(open_waits), "nearCutOpen": sum(r["rightCensored"] for r in nearby),
        "longestOpenLowerBoundMs": round(max((r["durationMs"] for r in open_waits), default=0), 1),
        "unchangedWindowPixelsDuringClosedHold": sum(r["identicalNativePixels"] for r in closed),
        "unchangedWindowPixelsDuringOpenHold": sum(r["identicalNativePixels"] for r in open_waits),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    args = parser.parse_args()
    before, after = map(load_trial, (args.before, args.after))
    bs, aset = before[0]["scrub"], after[0]["scrub"]
    if [r["frame"] for r in bs] != [r["frame"] for r in aset]:
        raise ValueError("Scrub coordinates differ")
    sets = {"verifiedBothArms": [], "matchingStillPixelsBothArms": [], "uncensored12sCohortVerifiedBothArms": []}
    for a, b in zip(bs, aset):
        samples = []
        for row, lookup in [(a, before[1]), (b, after[1])]:
            native = lookup.get(row["frame"])
            if native is None and row["endpoint"] in ("video", "videoCallback"):
                native = row["latencyMs"]
            samples.append(native)
        if None in samples:
            continue
        sets["verifiedBothArms"].append(samples)
        if all(row["endpoint"] in ("stillPaintUpperBound", "stillPaintEstimate") for row in (a, b)):
            sets["matchingStillPixelsBothArms"].append(samples)
        if a["timeoutMs"] == 12000 and b["timeoutMs"] == 12000:
            sets["uncensored12sCohortVerifiedBothArms"].append(samples)
    result = {
        "attemptedInEachArm": len(bs),
        "nativeSeek": {k: {"before": latency([v[0] for v in vals]), "after": latency([v[1] for v in vals])}
                       for k, vals in sets.items()},
        "postStartWaits": {"before": waits(before[2]), "after": waits(after[2])},
    }
    (args.after / "native-pair-summary.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
