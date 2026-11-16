#!/usr/bin/env python3
"""Build take-listening trials from original recordings and their source-word evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import tempfile
import wave

from compare import EVALS, REPO, private_path, sha
from score_audio_reference import validated_transcript_stream


def scarlet(operation, payload):
    result = subprocess.run(["node", "--import", "tsx", str(EVALS / "src/takePairEvidence.ts"), operation],
                            input=json.dumps(payload), cwd=REPO, text=True, stdout=subprocess.PIPE, check=True)
    if result.stdout:
        return json.loads(result.stdout)


def word_text(words, start, stop):
    return " ".join(word["text"] for word in words[start:stop])


def excerpt(words, duration, start, last, stop, case):
    # The first excerpt may include continuation words but ends before the second delivery begins.
    before = words[start - 1]["end"] if start else 0
    after = words[stop]["start"] if stop < len(words) else duration
    begin = round(max(0, words[start]["start"] - .13, before), 3)
    end = round(min(duration, begin + 8, after, words[min(last + 6, stop - 1)]["end"] + .13), 3)
    heard = [i for i, word in enumerate(words) if word["start"] < end and word["end"] > begin]
    if end <= begin or not heard:
        raise ValueError(f"Empty source excerpt in {case} at word {start}.")
    path = f"windows/{case}/{start}-{last}-{begin:.3f}-{end:.3f}.wav"
    return {"path": path, "from": begin, "to": end, "transcript": word_text(words, heard[0], heard[-1] + 1),
            "phrase": word_text(words, start, last + 1), "wordRange": [start, last], "heardWordRange": [heard[0], heard[-1]]}


def make_trial(case, split, words, duration, a, end1, b, end2):
    if not (a <= end1 < b <= end2 and end1 - a == end2 - b):
        raise ValueError(f"Repeated phrase did not map to two matching word spans in {case}.")
    pair_id = f"{case}.{a}-{b}"
    start, stop = max(0, a - 8), min(len(words), end2 + 10)
    # Keeping the first delivery splices its shared phrase into the later continuation.
    actions = [
        ("first", [[end1 + 1, end2]], "Keep the first occurrence of the shared phrase and continue into the later take."),
        ("second", [[a, b - 1]], "Resume on the second occurrence of the shared phrase."),
        ("both", [], "Keep the whole passage as recorded."),
    ]
    random.Random(int.from_bytes(hashlib.sha256(pair_id.encode()).digest(), "big")).shuffle(actions)
    options = []
    for letter, (action, remove, description) in zip("ABC", actions):
        kept = " ".join(words[i]["text"] for i in range(start, stop) if not any(lo <= i <= hi for lo, hi in remove))
        options.append(dict(id=letter, action=action, remove=remove, text=kept, description=description))
    return dict(id=pair_id, case=case, split=split, phrase=word_text(words, a, end1 + 1),
                occurrences=[[a, end1], [b, end2]], contextWordRange=[start, stop - 1],
                transcript=word_text(words, start, stop),
                windows=[excerpt(words, duration, a, end1, b, case), excerpt(words, duration, b, end2, len(words), case)],
                options=options)


def prepare_episode(case, split, source, evidence_file, stage):
    evidence = json.loads(evidence_file.read_bytes())
    words, duration = evidence["words"], evidence["duration"]
    source_digest = sha(source)
    stream = validated_transcript_stream(evidence, source_digest)
    repeats = scarlet("repeats", words)
    starts = {word["start"]: i for i, word in enumerate(words)}
    ends = {word["end"]: i for i, word in enumerate(words)}
    pairs = {(starts[r["first"]["start"]], ends[r["first"]["end"]], starts[r["next"]["start"]], ends[r["next"]["end"]])
             for r in repeats}
    trials = [make_trial(case, split, words, duration, *pair) for pair in sorted(pairs)]
    windows = {w["path"]: w for trial in trials for w in trial["windows"]}
    if windows:
        (stage / "windows" / case).mkdir(parents=True)
        scarlet("audio", {"source": str(source), "stream": stream, "windows": [
            {"path": str(stage / path), "from": w["from"], "to": w["to"]} for path, w in windows.items()]})
    hashes = {}
    for path, window in windows.items():
        with wave.open(str(stage / path), "rb") as audio:
            duration_read = audio.getnframes() / audio.getframerate()
            if ((audio.getnchannels(), audio.getframerate(), audio.getsampwidth()) != (1, 16000, 2)
                    or not audio.getnframes() or abs(duration_read - (window["to"] - window["from"])) >= .025):
                raise ValueError(f"Unexpected source audio encoding or duration: {path}")
        hashes[path] = sha(stage / path)
    for trial in trials:
        for w in trial["windows"]:
            w["sha256"] = hashes[w["path"]]
    recording = dict(id=case, split=split, words=len(words), sourceSha256=source_digest, audioStream=stream,
                     transcriptSha256=hashlib.sha256(json.dumps(words, sort_keys=True).encode()).hexdigest(), finderPairs=len(repeats))
    return recording, trials


def check_distinct_recordings(recordings):
    if len({r["sourceSha256"] for r in recordings}) != len(recordings):
        raise ValueError("Each source recording must appear only once across the study splits.")


def prepare(episodes, out):
    out = private_path(out)
    if out.exists():
        raise ValueError("Choose a new output directory.")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        stage = Path(tmp) / "pairs"
        stage.mkdir(mode=0o700)
        manifest = dict(schema=1, recordings=[], trials=[])
        ids = set()
        for case, split, source, evidence in episodes:
            if not case or case in (".", "..") or Path(case).name != case or "\\" in case or case in ids:
                raise ValueError(f"Invalid or duplicate episode ID: {case}")
            if not split.strip():
                raise ValueError("Each episode needs a split name.")
            ids.add(case)
            record, trials = prepare_episode(case, split, Path(source).expanduser().resolve(),
                                             Path(evidence).expanduser().resolve(), stage)
            manifest["recordings"].append(record)
            manifest["trials"].extend(trials)
        check_distinct_recordings(manifest["recordings"])
        (stage / "cases.json").write_text(json.dumps(manifest, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
        stage.rename(out)
    return len(manifest["trials"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--episode", nargs=4, action="append", required=True,
                        metavar=("ID", "SPLIT", "RECORDING", "EVIDENCE_JSON"),
                        help="Repeat for each case. Evidence contains duration (seconds) and timed source words.")
    parser.add_argument("--out", required=True, type=Path, help="New private directory for cases.json and source WAVs.")
    args = parser.parse_args()
    print(f"Prepared {prepare(args.episode, args.out)} source pairs in {args.out / 'cases.json'}.")


if __name__ == "__main__":
    main()
