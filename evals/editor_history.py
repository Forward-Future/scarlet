#!/usr/bin/env python3
"""Build optional take suggestions from other recordings edited by the same editor (offline experiment)."""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import re

import numpy as np
from sklearn import __version__ as sklearn_version
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction import DictVectorizer

from compare import encoded, private_path, sha
import score_audio_reference as referee
from take_listening import write_new


def take_features(words):
    """Describe each occurrence using the current recording alone."""
    tokens = ["".join(c for c in w["text"].casefold() if c.isalnum()) for w in words]
    gaps = [max(0, w["start"] - (words[i-1]["end"] if i else 0)) for i, w in enumerate(words)]
    # Length, offset, remaining length, index/time distance and count of nearby exact performances.
    earlier = np.zeros((len(words), 6))
    later = np.zeros_like(earlier)
    positions = defaultdict(list)
    for i, token in enumerate(tokens):
        if not token:
            continue
        for j in reversed(positions[token]):
            elapsed = words[i]["start"] - words[j]["start"]
            if elapsed > 50:
                break
            if j > 0 and i - 1 > j and tokens[i-1] == tokens[j-1]:
                continue
            length = 0
            while (i + length < len(words) and j + length < i and tokens[i+length]
                   and tokens[i+length] == tokens[j+length]
                   and (length == 0 or max(gaps[i+length], gaps[j+length]) < 2)):
                length += 1
            if length < 2:
                continue
            for offset in range(length):
                for table, index in ((earlier, i+offset), (later, j+offset)):
                    row = table[index]
                    row[5] += 1
                    if length > row[0] or (length == row[0] and elapsed < row[4]):
                        row[:5] = [length, offset+1, length-offset, i-j, elapsed]
        positions[token].append(i)

    result = []
    for i, (token, word) in enumerate(zip(tokens, words)):
        ending = word["text"][-1:]
        row = dict(pos=i/max(1, len(words)-1), start=min(12, word["start"]),
                   tail=min(12, words[-1]["end"]-word["end"]), duration=word["end"]-word["start"],
                   letters=len(token), digit=bool(re.search(r"\d", token)),
                   piece=bool(re.search("[-–…]$", word["text"])), punct=ending if ending in ".?!," else "",
                   filler=token in {"uh", "um", "erm", "ah", "oh"},
                   lastword=bool(i and words[i-1]["text"].rstrip('”"').endswith((".", "?", "!"))))
        for offset in (-2, -1, 0, 1, 2):
            j = min(len(words)-1, max(0, i+offset))
            row[f"gap{offset}"] = min(6, gaps[j])
            row[f"word{offset}"] = tokens[j] if offset == 0 else tokens[j] in {"i","the","and","but","so","to","um","uh"}
            # The original experiment names a feature for the position of the current word in the pair.
            for key, table in (("later", earlier), ("earlier", later)):
                row[f"{key}/len{offset}"] = table[j, 0]
                if offset == 0:
                    for k, value in enumerate(table[j, 1:]):
                        row[f"{key}/{k}"] = value
        for width in (6, 15):
            for key, table in (("later", earlier), ("earlier", later)):
                row[f"{key}prev{width}"] = table[max(i-width, 0):i+1, 0].max()
                row[f"{key}next{width}"] = table[i:i+width+1, 0].max()
        result.append(row)
    return result


def train(examples, include_markers=False):
    rows, labels, weights = [], [], []
    for words, reference in examples:
        kept, skipped = referee.occurrence_evidence(words, reference)
        if not include_markers:
            skipped = {i for i in skipped if referee.spoken_word(words[i])}
        indices = sorted(kept | skipped)
        if not indices:
            raise ValueError("A training recording has no labeled word occurrences.")
        features = take_features(words)
        rows.extend(features[i] for i in indices)
        labels.extend(i in skipped for i in indices)
        weights.extend([1 / math.sqrt(len(indices))] * len(indices))
    if len(set(labels)) != 2:
        raise ValueError("The training set needs both kept and skipped words.")
    features = DictVectorizer(sparse=False)
    classifier = HistGradientBoostingClassifier(max_iter=80, max_leaf_nodes=12, l2_regularization=1.5,
                                               min_samples_leaf=20, early_stopping=False, random_state=606)
    classifier.fit(features.fit_transform(rows), labels, sample_weight=np.array(weights) / np.mean(weights))
    return features, classifier


def suggest_ranges(probabilities, transition_cost=1.25):
    """Most likely continuous keep/cut labels with a cost for each state change."""
    emission = np.log(np.maximum(np.column_stack((1 - probabilities, probabilities)), 1e-7))
    best = emission[0].copy()
    previous = np.zeros((len(emission), 2), dtype=int)
    for i in range(1, len(emission)):
        for state in (0, 1):
            previous[i, state] = state if best[state] >= best[1-state] - transition_cost else 1-state
        parents = previous[i]
        best = emission[i] + best[parents] - transition_cost * (parents != np.arange(2))
    state = int(np.argmax(best))
    selected = []
    for i in reversed(range(len(emission))):
        if state:
            selected.append(i)
        state = previous[i, state]
    ranges = []
    for i in reversed(selected):
        if ranges and i == ranges[-1][1] + 1:
            ranges[-1][1] = i
        else:
            ranges.append([i, i])
    return ranges


def read_case(directory):
    directory = private_path(directory)
    case = json.loads((directory / "case.json").read_bytes())
    media_id, = case["dialogueMedia"]
    if Path(media_id).name != media_id or media_id in ("", ".", "..") or "\\" in media_id:
        raise ValueError("Invalid dialogue media ID.")
    asset, = [media for media in case["media"] if media["id"] == media_id]
    digest = asset.get("hash", "")
    if not re.fullmatch("[a-f0-9]{64}", digest):
        raise ValueError("A frozen source SHA-256 is required.")
    evidence_path = directory / "evidence" / (media_id + ".json")
    evidence = json.loads(evidence_path.read_bytes())
    if evidence["mediaId"] != media_id or not evidence["words"]:
        raise ValueError("The case needs a transcript for its dialogue recording.")
    track = referee.validated_transcript_stream(evidence, digest, asset.get("audioStream"))
    words = evidence["words"]
    for word in words:
        if (not isinstance(word.get("text"), str) or not all(type(word.get(k)) in (float,int) and math.isfinite(word[k])
                                                             for k in ("start","end")) or not 0 <= word["start"] <= word["end"]):
            raise ValueError("Invalid source word interval.")
    info = dict(case=case["id"], project=case["projectId"], sourceSha256=digest, audioStream=track, evidenceSha256=sha(evidence_path))
    return words, info


def build(history, target, include_markers=False):
    words, source = read_case(target)
    training = json.loads(history.read_bytes())
    seen = {source["sourceSha256"]}
    projects = {source["project"]}
    editors = set()
    examples, receipts = [], []
    for row in training:
        past, info = read_case(history.parent / row["caseDir"])
        if info["sourceSha256"] in seen or info["sourceSha256"] in editors or info["project"] in projects:
            raise ValueError("Training recordings must be distinct from each other and the target.")
        seen.add(info["sourceSha256"])
        projects.add(info["project"])
        ref_path = private_path(history.parent / row["reference"])
        reference = json.loads(ref_path.read_bytes())
        binding = reference.get("inputs", {})
        if (binding.get("sourceSha256") != info["sourceSha256"] or type(binding.get("audioStream")) is not int
                or binding["audioStream"] != info["audioStream"] or not re.fullmatch("[a-f0-9]{64}", binding.get("editorSha256", ""))
                or type(binding.get("editorAudioStream")) is not int or binding["editorAudioStream"] < 0):
            raise ValueError("A training correlation must identify its source and editor audio streams and recordings.")
        if binding["editorSha256"] in seen or binding["editorSha256"] in editors:
            raise ValueError("A reference export overlaps the target or another history recording.")
        editors.add(binding["editorSha256"])
        examples.append((past, reference))
        receipts.append(dict(info, referenceSha256=sha(ref_path), editorSha256=binding["editorSha256"],
                             editorAudioStream=binding["editorAudioStream"]))
    features, model = train(examples, include_markers)
    probability = model.predict_proba(features.transform(take_features(words)))[:, 1]
    def excerpt(window):
        return " ".join(w["text"] for w in window)

    suggestions = []
    for first, last in suggest_ranges(probability):
        suggestions.append(dict(first=first, last=last, remove=excerpt(words[first:last+1]),
                                before=excerpt(words[max(0, first-6):first]), after=excerpt(words[last+1:last+10])))
    return dict(schema=1, source=source, training=receipts, historySha256=sha(history),
                trainingInventory="allTimedOccurrences" if include_markers else "spokenWords",
                estimatorSourceSha256=sha(Path(__file__)), scorerSha256=sha(Path(referee.__file__)), sklearn=sklearn_version, numpy=np.__version__,
                suggestions=suggestions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-markers", action="store_true",
                        help="Reproduce the all-timed-token training arm, including removed decoder annotations.")
    parser.add_argument("--history", type=Path, required=True, help="Private ordered JSON list of {caseDir, reference}.")
    parser.add_argument("--case-dir", type=Path, required=True, help="Target case with source transcript.")
    parser.add_argument("--out", type=Path, required=True, help="New private suggestions JSON.")
    args = parser.parse_args()
    dest = private_path(args.out)
    if dest.exists():
        parser.error("Choose a new output file.")
    write_new(dest, encoded(build(private_path(args.history), args.case_dir, args.include_markers)))


if __name__ == "__main__":
    main()
