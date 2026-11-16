#!/usr/bin/env python3
"""Label frozen pairs of repeated source words with an independent editor audio correlation."""
import argparse
import hashlib
import json
import re
from pathlib import Path

from compare import encoded, private_path, sha
from prepare_take_pairs import check_distinct_recordings
from score_audio_reference import occurrence_evidence, validated_transcript_stream
from take_listening import write_new


def occurrence_state(evidence, length, *, strict):
    kept, cut = len(evidence["keep"]), len(evidence["cut"])
    if kept and cut:
        return "mixed"
    threshold = length if strict else max(2, length // 2 + 1)
    if kept >= threshold:
        return "kept"
    if cut >= threshold:
        return "cut"
    return "unknown"


PERFORMANCES = {("kept", "cut"): "first", ("cut", "kept"): "second",
                ("kept", "kept"): "both", ("cut", "cut"): "neither"}


def token(text):
    return "".join(ch for ch in text.lower() if ch.isalnum())


def label_trial(trial, words, kept, cut, *, complete_map):
    """Indices are inclusive source word indices, independent of candidate playback."""
    (a, end), (b, end2) = trial["occurrences"]
    if not (0 <= a <= end < b <= end2 < len(words) and end - a == end2 - b):
        raise ValueError(f"Invalid pair of occurrence ranges: {trial['id']}")
    n = end - a + 1
    for i in range(n):
        first, second = token(words[a + i]["text"]), token(words[b + i]["text"])
        if not first or first != second:
            raise ValueError(f"Different source words in pair: {trial['id']}")
    choices = {o["action"]: o["id"] for o in trial["options"]}
    if len(choices) != len(trial["options"]) or len(set(choices.values())) != len(choices):
        raise ValueError(f"Duplicate proposed action or option ID: {trial['id']}")

    def label(action):
        return {"targetAction": action, "targetChoice": choices.get(action)}

    evidence = []
    for lo, hi in trial["occurrences"]:
        ids = set(range(lo, hi + 1))
        evidence.append(dict(keep=sorted(ids & kept), cut=sorted(ids & cut)))
    result = {key: trial[key] for key in ("id", "case", "split")}
    result["evidence"] = evidence
    result["negativeEvidenceScope"] = "completeSoundtrack" if complete_map else "localForwardSplice"
    for tier in ("strict", "majority"):
        states = tuple(occurrence_state(side, n, strict=tier == "strict") for side in evidence)
        action = PERFORMANCES.get(states, "mixed" if "mixed" in states else None)
        result[tier] = dict(label(action), states=states)

    # A single *corresponding position* can identify a delivery. No known word
    # from either copy may contradict the claim (e.g. a sentence spliced from both).
    witnesses = {action: [] for action in PERFORMANCES.values()}
    for offset in range(n):
        first, second = a + offset, b + offset
        states = tuple("kept" if i in kept else "cut" if i in cut else "unknown" for i in (first, second))
        if states in PERFORMANCES:
            witnesses[PERFORMANCES[states]].append([first, second])
    left, right = evidence
    compatible = {
        "first": not left["cut"] and not right["keep"],
        "second": not left["keep"] and not right["cut"],
        "both": not left["cut"] and not right["cut"],
        "neither": not left["keep"] and not right["keep"],
    }
    actions = [action for action in witnesses if witnesses[action] and compatible[action]]
    if len(actions) > 1:
        raise ValueError(f"Contradictory occurrence conclusions: {trial['id']}")
    action = actions[0] if actions else None
    if not action and any(side["cut"] and side["keep"] for side in evidence):
        action = "mixed"
    result["provenance"] = dict(label(action), witnesses=witnesses)
    # On an incomplete map an apparently skipped take could reappear in the
    # unexplained audio. Positive evidence for both copies still proves both played.
    for tier in ("strict", "majority", "provenance"):
        local = result[tier]
        global_action = local["targetAction"] if complete_map or local["targetAction"] == "both" else None
        result[tier + "Global"] = label(global_action)
    return result


def reference_binding(record, evidence, reference, ref_file, paths, source_dir):
    """A duration match cannot identify the recording or an audio track within it."""
    identity = reference.get("inputs")
    binding = {"method": "referenceInputs"}
    if identity is None and "replayedReference" in paths:
        # For unbound historical maps, repeat the correlation from the original
        # media with explicit tracks. Every part of the old map must reproduce.
        replay = private_path(source_dir / paths["replayedReference"])
        reproduced = json.loads(replay.read_bytes())
        identity = reproduced.pop("inputs", None)
        if reproduced != reference:
            raise ValueError(f"Replay does not reproduce the historical reference: {record['id']}")
        binding = dict(method="replayedHistoricalMap", replaySha256=sha(replay))
    if not isinstance(identity, dict):
        raise ValueError("Reference lacks input identity. Re-correlate source and editor media and supply replayedReference.")
    for key in ("sourceSha256", "editorSha256"):
        if not isinstance(identity.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", identity[key]):
            raise ValueError(f"Invalid {key} in reference input identity.")
    for key in ("audioStream", "editorAudioStream"):
        if type(identity.get(key)) is not int or identity[key] < 0:
            raise ValueError(f"Invalid {key} in reference input identity.")
    # Schema 1 blind sources used stream zero unless the evidence selected a stream.
    # The manifest's explicit stream on new runs must agree with the transcript's stream.
    stream = validated_transcript_stream(evidence, record["sourceSha256"], record.get("audioStream", 0))
    if stream != identity["audioStream"]:
        raise ValueError(f"Source, transcript and correlation audio streams differ: {record['id']}")
    if identity["sourceSha256"] != record["sourceSha256"]:
        raise ValueError(f"Source and correlation digests differ: {record['id']}")
    if "archiveSource" in paths:
        path = private_path(source_dir / paths["archiveSource"])
        archived = json.loads(path.read_bytes())
        if any(archived[k] != identity[k] for k in ("sourceSha256", "editorSha256")):
            raise ValueError(f"Archive does not identify both reference media files: {record['id']}")
        binding["archiveSourceSha256"] = sha(path)
    if "inventory" in paths:
        inventory = private_path(source_dir / paths["inventory"])
        files = json.loads(inventory.read_bytes())["files"]
        ref_key = str(ref_file.relative_to(inventory.parent))
        expected = {ref_key: sha(ref_file), paths["sourceKey"]: identity["sourceSha256"],
                    paths["editorKey"]: identity["editorSha256"]}
        if any(files.get(key) != value for key, value in expected.items()):
            raise ValueError(f"Frozen inventory does not bind this source, editor and reference: {record['id']}")
        binding["inventorySha256"] = sha(inventory)
    return dict(binding, **identity)


def label_manifest(manifest, sources, source_dir):
    recordings = {record["id"]: record for record in manifest["recordings"]}
    if len(recordings) != len(manifest["recordings"]) or set(sources) != set(recordings):
        raise ValueError("Expected one independent reference per recording.")
    check_distinct_recordings(manifest["recordings"])
    ids = [t["id"] for t in manifest["trials"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate trial ID.")
    inputs, coverage = {}, []
    for name in recordings:
        paths = sources[name]
        # Paths can be absolute or relative to the source index, kept independently of blind requests.
        evidence_file = private_path(source_dir / paths["words"])
        ref_file = private_path(source_dir / paths["reference"])
        evidence = json.loads(evidence_file.read_bytes())
        words = evidence["words"]
        reference = json.loads(ref_file.read_bytes())
        frame = 1 / reference["frameRate"] if "frameRate" in reference else reference["frameDuration"]
        if abs(evidence["duration"] - reference["rawDuration"]) > frame:
            raise ValueError(f"Source and audio correlation durations differ: {name}")
        record = recordings[name]
        word_hash = hashlib.sha256(json.dumps(words, sort_keys=True).encode()).hexdigest()
        if record["transcriptSha256"] != word_hash or len(words) != record["words"]:
            raise ValueError(f"Source words differ from the frozen manifest: {name}")
        binding = reference_binding(record, evidence, reference, ref_file, paths, source_dir)
        inputs[name] = (words, *occurrence_evidence(words, reference), not reference["unmappedFinal"])
        scope = "local forward splice with no other observed playback" if reference["unmappedFinal"] else "fully mapped editor soundtrack"
        coverage.append(dict(case=name, referenceSha256=sha(ref_file),
                             mappedSeconds=sum(s["finalEnd"] - s["finalStart"] for s in reference["segments"]),
                             editorSeconds=reference["finalDuration"], proofScope=scope, binding=binding))
    results = []
    for trial in manifest["trials"]:
        name = trial["case"]
        if name not in inputs or trial["split"] != recordings[name]["split"]:
            raise ValueError(f"Trial does not match its recording: {trial['id']}")
        words, kept, cut, complete = inputs[name]
        results.append(label_trial(trial, words, kept, cut, complete_map=complete))
    return dict(schema=1, trials=results, sources=coverage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path, help="Frozen blind trials with inclusive raw word indices.")
    parser.add_argument("--sources", required=True, type=Path,
                        help='JSON object keyed by recording ID, each with "words" and "reference" file paths.')
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest, sources = map(private_path, (args.manifest, args.sources))
    result = label_manifest(json.loads(manifest.read_bytes()), json.loads(sources.read_bytes()), sources.parent)
    result["hashOfBlindManifest"] = sha(manifest)
    write_new(args.out, encoded(result))


if __name__ == "__main__":
    main()
