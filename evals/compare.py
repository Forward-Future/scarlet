#!/usr/bin/env python3
"""Compare two prepared Scarlet checkouts on a frozen, private episode. No engine or model calls."""
import argparse
from bisect import bisect_left, bisect_right
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from score_frame_pairs import score as score_pictures

EVALS = Path(__file__).resolve().parent
REPO = EVALS.parent
REQUIRED = {"reference-audio.json", "waveforms.json", "pictures.json", "source-pts.json",
            "media/presenter.mp4", "media/published.mp4"}


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode()


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def private_path(path, checkouts=()):
    path = path.expanduser().resolve()
    # This repo can itself be a worktree nested in another checkout.
    if any((parent / ".git").exists() or parent in checkouts for parent in (path, *path.parents)):
        raise ValueError("Store episode files and results outside Git checkouts.")
    return path


def case_files(root, case):
    if not case or case in (".", "..") or Path(case).name != case or "\\" in case:
        raise ValueError("Invalid case ID.")
    directory = root / "cases" / case
    case_file = json.loads((directory / "case.json").read_bytes())
    if case_file["id"] != case or len(case_file["dialogueMedia"]) != 1:
        raise ValueError("Expected one named dialogue case.")
    names = set(REQUIRED)
    names.update(str(p.relative_to(root)) for p in directory.rglob("*") if p.is_file())
    names.update(str(p.relative_to(root)) for p in (root / "media").glob("*.mp4"))
    if (root / "provenance.json").is_file():
        names.add("provenance.json")
    for name in names:
        path = root / name
        if not path.is_file() or path.resolve() != path:
            raise ValueError(f"Missing or linked episode input: {name}")
    return sorted(names)


def verify_reference_recordings(reference, source_hash, published_hash, audio_stream=None):
    # Older frozen episodes predate recording identities in their audio maps.
    if "inputs" not in reference:
        return
    inputs = reference["inputs"]
    if not isinstance(inputs, dict) or inputs.get("sourceSha256") != source_hash or inputs.get("editorSha256") != published_hash:
        raise ValueError("The audio reference identifies different source footage or a different published edit.")
    if audio_stream is not None and (type(inputs.get("audioStream")) is not int or inputs["audioStream"] != audio_stream):
        raise ValueError("The audio reference identifies a different source audio stream.")


def inventory(root, case):
    files = {name: sha(root / name) for name in case_files(root, case)}
    meta = json.loads((root / "cases" / case / "case.json").read_bytes())
    asset = next((a for a in meta["media"] if a["id"] == meta["dialogueMedia"][0]), None)
    if not asset or asset.get("hash") != files["media/presenter.mp4"]:
        raise ValueError("The frozen recording does not match the case's dialogue asset.")
    pictures = json.loads((root / "pictures.json").read_bytes())
    if pictures.get("publishedSha256") and pictures["publishedSha256"] != files["media/published.mp4"]:
        raise ValueError("The verified pictures came from a different published edit.")
    verify_reference_recordings(json.loads((root / "reference-audio.json").read_bytes()), asset["hash"],
                                files["media/published.mp4"], asset.get("audioStream", 0))
    return files


def git(checkout, *args):
    return subprocess.check_output(["git", "-C", str(checkout), *args], text=True).strip()


def checkout_version(checkout):
    if Path(git(checkout, "rev-parse", "--show-toplevel")).resolve() != checkout:
        raise ValueError(f"Choose the root of a Scarlet checkout: {checkout}")
    revision = git(checkout, "rev-parse", "HEAD")
    # Include uncommitted engine work in its identity for pre-commit hill climbing.
    paths = ["packages", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"]
    diff = subprocess.check_output(["git", "-C", str(checkout), "diff", "--binary", "HEAD", "--", *paths])
    extra = subprocess.check_output(["git", "-C", str(checkout), "ls-files", "--others", "--exclude-standard",
                                     "-z", "--", *paths]).decode().split("\0")
    h = hashlib.sha256(diff)
    for name in sorted(filter(None, extra)):
        h.update(encoded([name, sha(checkout / name)]))
    return {"commit": revision, "workingChanges": h.hexdigest() if diff or any(extra) else None}


def build_checkouts(checkouts):
    for checkout in dict.fromkeys(checkouts):
        for package in ("@scarlet/timeline", "@scarlet/shared"):
            subprocess.run(["pnpm", "--filter", package, "build"], cwd=checkout, stdout=sys.stderr, check=True)


def replay(root, case, arm, leave, checkout, temp):
    command = ["node", "--import", "tsx", str(EVALS / "src/wordEdges.ts"),
               "--checkout", str(checkout), "--case", case, "--reference-map", str(root / "reference-audio.json"),
               "--waveforms", str(root / "waveforms.json"), "--out", str(temp / (arm + ".json"))]
    if leave is not None:
        command.extend(["--leave", str(leave)])
    subprocess.run(command, cwd=REPO, env=dict(os.environ, SCARLET_EVAL_DATA=str(root)), stdout=subprocess.DEVNULL, check=True)
    return json.loads((temp / (arm + ".json")).read_bytes())


def matched_words(row):
    if "fromWord" in row:
        return row["fromWord"] - 1, row["toWord"] + 1
    if "afterWord" in row:
        return row["afterWord"], row["afterWord"] + 1
    raise ValueError("Placed join has no identifiable neighboring words.")


def pause_ms(words, before, after, outgoing, incoming):
    return 1000 * (max(0, outgoing - words[before]["end"]) + max(0, words[after]["start"] - incoming))


def rate(errors):
    return {"joins": len(errors), "longerByOver200Ms": sum(e > 200 for e in errors),
            "shorterByOver200Ms": sum(e < -200 for e in errors),
            "meanAbsoluteErrorMs": round(sum(map(abs, errors)) / len(errors), 2) if errors else None}


def arm_score(result, words, audio, pictures, pts):
    measured = []
    pairs = []
    for row in result["rows"]:
        placement = row.get("frameAligned")
        if not placement:
            continue
        index = row["index"]
        join = audio["joins"][index]
        start, end = placement["start"], placement["end"]
        # A source picture displays until the next source timestamp. At an exact cut boundary
        # the outgoing picture is the one immediately before it, and the incoming picture plays at it.
        pair = [bisect_left(pts, start - 1e-7) - 1, bisect_right(pts, end + 1e-7) - 1]
        if min(pair) < 0 or end > pts[-1] + (pts[-1] - pts[-2]) + 1e-7 or start > end:
            raise ValueError("Placement lies outside the source picture clock.")
        if not placement.get("untouched"):
            pairs.append(pair)
        left, right = matched_words(row)
        if not (0 <= left < right < len(words)):
            raise ValueError("Placed join refers to missing source words.")
        reference = pause_ms(words, left, right, join["rawOut"], join["rawIn"])
        actual = pause_ms(words, left, right, start, end)
        # Timed-word overlap is a listening cue. Keep it separate from losing an entire occurrence.
        extra_trim = {}
        for flank, word in (("outgoing", words[left]), ("incoming", words[right])):
            trim = max(0, min(word["end"], end) - max(word["start"], start))
            published = max(0, min(word["end"], join["rawIn"]) - max(word["start"], join["rawOut"]))
            if round((trim - published) * 1000, 2) > 20:
                extra_trim[flank] = round((trim - published) * 1000, 2)
        measured.append({"index": index, "finalAt": join["finalTime"], "afterWord": left, "beforeWord": right,
                         "removedWordRange": [row["fromWord"], row["toWord"]] if "fromWord" in row else None,
                         "start": start, "end": end, "tier": row["outcome"], "frames": None if placement.get("untouched") else pair,
                         "wrongWords": placement["wrongWords"], "wrongWordIndices": placement["wrongWordIndices"],
                         "extraKeptWordTrimMs": extra_trim,
                         "referenceMs": round(reference, 2), "candidateMs": round(actual, 2),
                         "errorMs": round(actual - reference, 2)})
    image_scores = score_pictures(pictures, {"sourceId": pictures["sourceId"], "pairs": pairs})
    correct = [r for r in measured if not r["wrongWords"]]
    return {"outcomes": dict(Counter(r["outcome"] for r in result["rows"])), "placements": measured,
            "excluded": [r for r in result["rows"] if not r.get("frameAligned")],
            "joinsChangingWords": len(measured) - len(correct),
            "joinsTrimmingFurtherIntoKeptWords": sum(bool(r["extraKeptWordTrimMs"]) for r in measured),
            "pacing": rate([r["errorMs"] for r in correct]), "pictures": image_scores}


def assemble(root, case, reference_hash, base, cand):
    if base["inputs"] != cand["inputs"] or base["caseId"] != case or cand["caseId"] != case:
        raise ValueError("The two runs used different evidence.")
    case_dir = root / "cases" / case
    meta = json.loads((case_dir / "case.json").read_bytes())
    media = meta["dialogueMedia"][0]
    words = json.loads((case_dir / "evidence" / (media + ".json")).read_bytes())["words"]
    audio = json.loads((root / "reference-audio.json").read_bytes())
    pts = json.loads((root / "source-pts.json").read_bytes())
    pictures = json.loads((root / "pictures.json").read_bytes())
    if (pictures["sourceId"] != reference_hash or len(pts) < 2 or not all(math.isfinite(p) for p in pts)
            or any(a >= b for a, b in zip(pts, pts[1:]))):
        raise ValueError("The verified pictures must identify the frozen presenter on a monotonic PTS clock.")
    if len(base["rows"]) != len(audio["joins"]) or len(cand["rows"]) != len(base["rows"]):
        raise ValueError("The runs do not cover the same reference joins.")
    for i, (a, b) in enumerate(zip(base["rows"], cand["rows"])):
        if a["index"] != i or b["index"] != i or any(a.get(k) != b.get(k) for k in ("fromWord", "toWord", "afterWord")):
            raise ValueError("The two runs were given different word selections.")
    scored = [arm_score(run, words, audio, pictures, pts) for run in (base, cand)]
    sides = [{r["index"]: r for r in s["placements"] if not r["wrongWords"]} for s in scored]
    common = sorted(sides[0].keys() & sides[1].keys())
    paired = [rate([side[i]["errorMs"] for i in common]) for side in sides]
    return {"case": case, "referenceJoins": len(audio["joins"]), "mappedFraction": audio["mappedFraction"],
            "unmappedFinal": audio["unmappedFinal"], "baseline": scored[0], "candidate": scored[1],
            "paired": {"indices": common, "baseline": paired[0], "candidate": paired[1]}}


def score_text(report):
    sides = ("baseline", "candidate")
    sizes = [f"{round(1000*v)} ms" if v is not None else "engine default" for v in report["leaveSeconds"]]
    lines = [f"# {report['case']}", "", f"The recordings match across {100 * report['mappedFraction']:.1f}% of the "
             f"published soundtrack, yielding {report['referenceJoins']} reference joins.", "",
             f"| Measure | Baseline ({sizes[0]}) | Candidate ({sizes[1]}) |", "|---|---:|---:|"]

    def row(label, values):
        lines.append(f"| {label} | {values[0]} | {values[1]} |")

    paired = [report["paired"][side] for side in sides]
    for label, key in [("Joins with the same kept words in both versions", "joins"),
                       ("Pauses more than 200 ms long", "longerByOver200Ms"),
                       ("Pauses more than 200 ms short", "shorterByOver200Ms"),
                       ("Mean absolute pause error (ms)", "meanAbsoluteErrorMs")]:
        row(label, [p[key] if p[key] is not None else "—" for p in paired])
    row("Placements changing a word occurrence", [report[s]["joinsChangingWords"] for s in sides])
    row("Joins trimming over 20 ms more of a kept word than the published cut",
        [report[s]["joinsTrimmingFurtherIntoKeptWords"] for s in sides])
    for label, key in [("Automatically applicable", "applied"), ("Held for editor review", "review"),
                       ("Sent back for revision", "needsRevision"), ("Original pause left intact", "untrimmed")]:
        row(label, [report[s]["outcomes"].get(key, 0) for s in sides])
    row("Reference joins without a placement", [len(report[s]["excluded"]) for s in sides])
    for i, tolerance in enumerate((0, 5, 10)):
        frames = [report[s]["pictures"] for s in sides]
        row(f"Both sides within {tolerance} source frames", [
            f"{p['byTolerance'][i]['matched']}/{p['verifiedReferenceCuts']}" if p["verifiedReferenceCuts"] else "Unmeasured"
            for p in frames])
    lines += ["", "Pacing includes proposed cuts held for review and unchanged pauses that play the same words. "
              "Picture scores count every independently verified cut. Source-word indices, omitted joins, unmapped "
              "published intervals and checkout revisions are in [the full comparison](comparison.json)."]
    return "\n".join(lines) + "\n"


def seal(path, data):
    # Publish only complete locks, including when two preparers finish at once.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        temp = Path(f.name)
    try:
        with temp.open("wb") as f:
            f.write(data)
        try:
            os.link(temp, path)
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError("Frozen inputs or scores differ. Choose a new episode version.")
    finally:
        temp.unlink(missing_ok=True)


def execute(args):
    root = private_path(args.episode)
    lock = root / "episode.lock.json"
    if args.freeze:
        manifest = {"schema": 1, "case": args.freeze, "files": inventory(root, args.freeze)}
        seal(lock, encoded(manifest))
        print(lock)
        return
    manifest = json.loads(lock.read_bytes())
    if manifest.get("schema") != 1 or inventory(root, manifest["case"]) != manifest["files"]:
        raise ValueError("Frozen input inventory or hashes changed.")
    accepted = json.loads((root / "expected.json").read_bytes()) if args.check_baseline else None
    if accepted is not None and args.baseline_leave is None and args.candidate_leave is None:
        args.baseline_leave, args.candidate_leave = accepted["leaveSeconds"]
    checkouts = [p.expanduser().resolve() for p in (args.baseline, args.candidate)]
    versions = [checkout_version(c) for c in checkouts]
    build_checkouts(checkouts)
    settings = [args.baseline_leave, args.candidate_leave]
    if (settings[0] is None) != (settings[1] is None):
        raise ValueError("Specify both pause durations, or omit both to compare word cuts at engine defaults.")
    if any(v is not None and (not math.isfinite(v) or v < 0) for v in settings):
        raise ValueError("Pacing durations must be finite and nonnegative.")
    with tempfile.TemporaryDirectory(prefix="scarlet-compare-") as scratch:
        runs = [replay(root, manifest["case"], side, leave, checkout, Path(scratch))
                for side, leave, checkout in zip(("baseline", "candidate"), settings, checkouts)]
    if versions != [checkout_version(c) for c in checkouts]:
        raise ValueError("A checkout changed during comparison. Run again on a stable revision.")
    report = assemble(root, manifest["case"], manifest["files"]["media/presenter.mp4"], *runs)
    report.update(schema=1, episodeSha256=sha(lock), revisions=versions, leaveSeconds=settings,
                  graderSha256={p.name: sha(p) for p in (Path(__file__), EVALS / "src/wordEdges.ts", EVALS / "score_frame_pairs.py")})
    digest = hashlib.sha256(encoded(report)).hexdigest()
    expectation = root / "expected.json"
    if args.accept_baseline or args.check_baseline:
        spec = {"schema": 1, "case": manifest["case"], "reportSha256": digest, "episodeSha256": sha(lock),
                "revisions": versions, "leaveSeconds": settings, "graderSha256": report["graderSha256"]}
        if args.accept_baseline:
            seal(expectation, encoded(spec))
        elif accepted != spec:
            raise ValueError("Comparison differs from the accepted baseline. Compare the case, revisions, settings and grader.")
    out = root / "results" / digest
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    seal(out / "comparison.json", encoded(report))
    summary = score_text(report)
    seal(out / "summary.md", summary.encode())
    print(summary)
    print(out / "summary.md")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("episode", type=Path, help="Private portable episode directory")
    parser.add_argument("--freeze", metavar="CASE", help="Create the content lock for an assembled episode")
    parser.add_argument("--baseline", type=Path, default=REPO, help="Baseline checkout with dependencies installed")
    parser.add_argument("--candidate", type=Path, default=REPO, help="Candidate checkout with dependencies installed")
    parser.add_argument("--baseline-leave", type=float, help="Requested baseline word-to-word pause, seconds")
    parser.add_argument("--candidate-leave", type=float, help="Requested candidate word-to-word pause, seconds")
    gate = parser.add_mutually_exclusive_group()
    gate.add_argument("--accept-baseline", action="store_true", help="Pin the result and its provenance for this version of the episode")
    gate.add_argument("--check-baseline", action="store_true", help="Require the exact previously pinned comparison")
    try:
        execute(parser.parse_args())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as err:
        parser.exit(1, f"Evaluation failed: {err}\n")


if __name__ == "__main__":
    main()
