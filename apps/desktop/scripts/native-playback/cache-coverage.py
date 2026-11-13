#!/usr/bin/env python3
"""Join matched native playback samples to prior cache state without publishing private fixture identifiers.

python3 cache-coverage.py <before-trial-root> <after-trial-root> > coverage.json
"""
import bisect
import collections
import datetime
import json
import statistics
import sqlite3
import sys
from pathlib import Path


def latency(values):
    completed = [v for v in values if v is not None]
    return {"completed": len(completed), "censored": len(values) - len(completed),
            "completedMedianMs": round(statistics.median(completed), 1) if completed else None}


def inspect(root):
    manifest = json.loads((root / "manifest.json").read_text())
    native = json.loads((root / "suite" / "combined.json").read_text())["results"]
    db = sqlite3.connect((root / "data" / "scarlet.db").as_uri() + "?mode=ro", uri=True)
    try:
        done = [json.loads(s) for s, in db.execute("""SELECT json FROM renders WHERE version=? AND state='done'
            AND kind IN ('full','playback','segment') AND project_id=?""", (manifest["version"], manifest["projectId"]))]
    finally:
        db.close()
    files = [(datetime.datetime.fromisoformat(row["finishedAt"].replace("Z", "+00:00")).timestamp() * 1000, row.get("range"))
             for row in done if row.get("finishedAt") and row.get("quality") == "preview"]
    samples, ready_ranges = [], []
    for s in map(json.loads, (root / "cache-load.jsonl").read_text().splitlines()):
        if s["event"] == "sample":
            ready_ranges = s.get("completedRanges", ready_ranges)
            samples.append({**s, "ranges": ready_ranges})
    assert samples, "No independent cache samples"
    epochs = [s["wallMs"] for s in samples]

    def prepared(t, wall):
        i = bisect.bisect_right(epochs, wall) - 1
        if i < 0 or wall > epochs[-1]:
            return None
        s = samples[i]
        return (s.get("fullEdit") == "done" or any(a <= t < b for a, b in s["ranges"]) or
                any(time <= wall and (r is None or r["start"] <= t < r["end"]) for time, r in files))

    def cut_state(row, wall):
        fps = native["fps"]
        states = [prepared(t, wall) for t in (row["start"], max(0, row["cut"] - .55/fps), row["cut"] + .45/fps)]
        if None in states:
            return "unknown"
        return "prepared" if all(states) else "mixed" if any(states) else "cold"

    windows, enclosed, active = 0, 0, 0
    for kind in ("scrub", "cuts", "sustained"):
        for row in native.get(kind, []):
            origin = row.get("timeOrigin", native["timeOrigin"])
            wall, end = origin + row["wallStart"], origin + row["wallEnd"]
            lo, hi = bisect.bisect_right(epochs, wall)-1, bisect.bisect_left(epochs, end)
            windows += 1
            if lo >= 0 and hi < len(samples):
                enclosed += 1
                active += all(s["source"] == "caching" and s["claimed"] for s in samples[lo:hi+1])
            if kind == "scrub":
                present = prepared(row["frame"] / native["fps"], wall)
                row["atInput"] = "unknown" if present is None else "prepared" if present else "cold"
            elif kind == "cuts":
                row["atPlay"] = cut_state(row, wall)
                if row.get("primerInput") is not None:
                    primer_epoch = origin + row["primerInput"]
                    row["atRecordedPrimer"] = cut_state(row, primer_epoch)
                    before = bisect.bisect_right(epochs, primer_epoch) - 1
                    sample = samples[before] if before >= 0 else {}
                    row["pressureAtPrimer"] = {
                        "sources": sample.get("sources"), "claimed": sample.get("claimed"), "fullEdit": sample.get("fullEdit"),
                        "publishedSeconds": sample.get("completedSeconds"), "ffmpegProcessCount": (sample.get("encoders") or {}).get("processes"),
                    }
                primer = row.get("primerMs")
                row["beforePrimerApprox"] = cut_state(row, wall-primer-50) if primer is not None else "unknown"
    progress = [s["sourceProgress"] for s in samples if s.get("sourceProgress") is not None]
    completed = [s["completedSeconds"] for s in samples if s.get("completedSeconds") is not None]
    workers = [s["encoders"] for s in samples if s.get("encoders")]
    stats = {"samples": len(samples), "wallSeconds": round((epochs[-1]-epochs[0])/1000, 1),
             "sourceClaimedSamples": sum(s["source"] == "caching" and s["claimed"] for s in samples),
             "sourceProgressStartEnd": [progress[0], progress[-1]] if progress else None,
             "fullRenderRunningSamples": sum(s.get("fullEdit") == "running" for s in samples),
             "lastPublishedCutSeconds": round(completed[-1], 2) if completed else None,
             "windows": windows, "windowsBracketed": enclosed, "windowsWithContinuousSourceClaim": active}
    if workers:
        stats.update({"medianFFmpegProcesses": statistics.median(s["processes"] for s in workers),
                      "medianSampledFFmpegCpuPercent": statistics.median(s["cpuPercent"] for s in workers),
                      "samplesWithSourceProxyProcess": sum(bool(s["outputs"]["sourceProxies"]) for s in workers),
                      "samplesWithSegmentProcess": sum(bool(s["outputs"]["editSegments"]) for s in workers)})
    return native, stats


def cut_summary(rows):
    quality = [r for r in rows if r.get("dropped") is not None and r.get("total") is not None]
    return {"playToFirst": latency([r.get("firstPlaybackFrameMs") for r in rows]), "primer": latency([r.get("primerMs") for r in rows]),
            "finished": sum(r["finished"] for r in rows), "consecutiveCrossings": sum(r["consecutive"] for r in rows),
            "qualityWindows": len(quality), "dropped": sum(r["dropped"] for r in quality), "totalFrames": sum(r["total"] for r in quality)}


def compare(a, b, kind, state, target):
    assert [r[target] for r in a[kind]] == [r[target] for r in b[kind]], "Native schedules differ"
    groups, ordinals = collections.defaultdict(list), []
    for left, right in zip(a[kind], b[kind]):
        key = left[state] + "-" + right[state]
        groups[key].append((left, right))
        ordinals.append(key)
    summary = {}
    for key, paired in sorted(groups.items()):
        left, right = zip(*paired)
        measure = cut_summary if kind == "cuts" else lambda rows: latency([r.get("latencyMs") for r in rows])
        summary[key] = {"attempts": len(paired), "before": measure(left), "after": measure(right)}
    return {"cohorts": summary, "stateByScheduleOrdinal": ordinals}


if __name__ == "__main__":
    (a, sa), (b, sb) = [inspect(Path(r).resolve()) for r in sys.argv[1:3]]
    report = {"method": "Prepared means the last prior independent sample covered the target, or its project already had a finished preview file. "
              "A join is prepared only if the primer and the frames on both sides of the boundary were prepared. "
              "Play uses the actual button timestamp. Before-primer uses play time minus observed primer duration and a 50ms guard. "
              "Cache sampling is approximately once per second. CPU is an OS process sample. Ordinals follow the native measurement order.",
              "before": sa, "after": sb, "scrub": compare(a, b, "scrub", "atInput", "requested"),
              "cutsAtPlay": compare(a, b, "cuts", "atPlay", "cut"),
              "cutsBeforePrimerApprox": compare(a, b, "cuts", "beforePrimerApprox", "cut")}
    if a["cuts"] and all("atRecordedPrimer" in row for run in (a, b) for row in run["cuts"]):
        report["cutsAtRecordedPrimer"] = compare(a, b, "cuts", "atRecordedPrimer", "cut")
        report["pressureAtRecordedPrimer"] = {label: [row["pressureAtPrimer"] for row in run["cuts"]]
                                             for label, run in (("before", a), ("after", b))}
    print(json.dumps(report, indent=2, allow_nan=False))
