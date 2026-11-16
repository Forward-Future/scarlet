#!/usr/bin/env python3
"""Render blind, fixed-word clips for the largest gain, loss and a changed near-neutral join."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile

from compare import encoded, private_path, sha


def choices(report):
    arms = [{r["index"]: r for r in report[s]["placements"]} for s in ("baseline", "candidate")]
    changes = []
    for index in report["paired"]["indices"]:
        a, b = (side[index] for side in arms)
        if max(abs(a[k] - b[k]) for k in ("start", "end")) < .001:
            continue
        changes.append((abs(a["errorMs"]) - abs(b["errorMs"]), index, a, b))
    if not changes:
        return []
    picks = [max(changes), min(changes), min(changes, key=lambda x: (abs(x[0]), x[1]))]
    return list({p[1]: p for p in picks}.values())


def render(raw, out, left, start, end, right):
    # Seek both inputs to the same source word windows. No processing that could mask the splice.
    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-ss", str(left), "-t", str(start - left),
                    "-i", str(raw), "-ss", str(end), "-t", str(right - end), "-i", str(raw),
                    "-filter_complex", "[0:a:0]asetpts=PTS-STARTPTS[a];[1:a:0]asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1[x]",
                    "-map", "[x]", "-vn", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1", str(out)], check=True)


def make_pairs(episode, report_file):
    lock = episode / "episode.lock.json"
    report = json.loads(report_file.read_bytes())
    if report["episodeSha256"] != sha(lock):
        raise ValueError("The comparison belongs to a different frozen episode.")
    raw = episode / "media/presenter.mp4"
    if sha(raw) != json.loads(lock.read_bytes())["files"]["media/presenter.mp4"]:
        raise ValueError("Source recording changed.")
    folder = private_path(report_file.parent / "listening")
    if folder.exists():
        key = json.loads((folder / "answer-key.json").read_bytes())
        if key["report"] != sha(report_file) or any(sha(folder / f) != h for f, h in key["audio"].items()):
            raise ValueError("Existing listening files differ from their saved receipt.")
        return folder
    pairs = choices(report)
    if not pairs:
        raise ValueError("No changed, word-preserving joins to audition.")
    secrets.SystemRandom().shuffle(pairs)
    case = episode / "cases" / report["case"]
    media = json.loads((case / "case.json").read_bytes())["dialogueMedia"][0]
    evidence = json.loads((case / "evidence" / (media + ".json")).read_bytes())
    words = evidence["words"]
    receipt = {"report": sha(report_file), "audio": {}, "pairs": []}
    scratch = Path(tempfile.mkdtemp(dir=folder.parent, prefix=".listening-"))
    try:
        for n, (gain, index, baseline, candidate) in enumerate(pairs, 1):
            sides = [("baseline", baseline), ("candidate", candidate)]
            secrets.SystemRandom().shuffle(sides)
            # Common source anchors keep the context identical. End on word boundaries where possible.
            left = max(0, min(words[max(0, baseline["afterWord"] - 6)]["start"] - .1,
                              min(r["start"] for _, r in sides) - .5))
            right = min(evidence["duration"], max(words[min(len(words)-1, baseline["beforeWord"] + 6)]["end"] + .1,
                                                  max(r["end"] for _, r in sides) + .5))
            receipt["pairs"].append({"pair": n, "join": index, "gainMs": gain, "A": sides[0][0], "B": sides[1][0]})
            for label, (_, row) in zip(("A", "B"), sides):
                name = f"pair-{n:02d}-{label}.wav"
                render(raw, scratch / name, left, row["start"], row["end"], right)
                receipt["audio"][name] = sha(scratch / name)
        (scratch / "answer-key.json").write_bytes(encoded(receipt))
        os.rename(scratch, folder)
    finally:
        if scratch.exists():
            shutil.rmtree(scratch)
    return folder


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("episode", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    try:
        print(make_pairs(private_path(args.episode), private_path(args.report)))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as err:
        parser.exit(1, f"Listening examples could not be prepared: {err}\n")
