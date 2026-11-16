#!/usr/bin/env python3
"""Freeze a derived English eval case using Scarlet's production CTC alignment on its original source words."""
import argparse
import math
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from compare import EVALS, REPO, encoded, private_path, sha


def original_grading_evidence(case_dir, conf, input_evidence, source_hash, stream):
    """Preserve the first grading transcript, even when deriving from another aligned case."""
    fixed = case_dir / "grading-evidence.json"
    lock_path = case_dir.parent.parent / "episode.lock.json"
    declared = "gradingEvidence" in conf
    if declared or fixed.exists() or lock_path.exists():
        root = lock_path.parent
        lock = json.loads(lock_path.read_bytes())
        if lock.get("schema") != 1 or lock.get("case") != conf["id"]:
            raise ValueError("The input case does not match its episode lock.")
        if fixed.exists() != declared or (fixed.relative_to(root).as_posix() in lock["files"]) != declared:
            raise ValueError("Missing or undeclared fixed grading evidence.")
        for path in [case_dir / "case.json", input_evidence, *([fixed] if declared else [])]:
            if lock["files"].get(path.relative_to(root).as_posix()) != sha(path):
                raise ValueError("Input differs from its frozen digest: " + path.name)
    if not declared:
        return input_evidence
    identity = dict(mediaId=conf["dialogueMedia"][0], sourceSha256=source_hash, audioStream=stream, sha256=sha(fixed))
    binding = conf["gradingEvidence"]
    evidence = json.loads(fixed.read_bytes())
    if (not isinstance(binding, dict) or type(binding.get("audioStream")) is not int or binding != identity or
            evidence.get("mediaId") != identity["mediaId"] or evidence.get("sourceSha256", source_hash) != source_hash or
            type(evidence.get("audioStream", stream)) is not int or evidence.get("audioStream", stream) != stream):
        raise ValueError("Fixed grading evidence identifies another source recording or stream.")
    return fixed


def freeze(case_dir, source, model, out, segments=None, reference=None):
    case_dir, out = private_path(case_dir), private_path(out)
    source, model = source.expanduser().resolve(), model.expanduser().resolve()
    if out.exists() or out.is_relative_to(case_dir):
        raise ValueError("Choose a new output directory outside the input case.")
    conf = json.loads((case_dir / "case.json").read_bytes())
    case, media_ids = conf["id"], conf["dialogueMedia"]
    if case != case_dir.name or len(media_ids) != 1:
        raise ValueError("Expected a named, single-recording case.")
    media, = [m for m in conf["media"] if m["id"] == media_ids[0]]
    if Path(media["id"]).name != media["id"] or "\\" in media["id"] or media["id"] in (".", ".."):
        raise ValueError("Invalid media ID.")
    if any(f.is_symlink() for f in case_dir.rglob("*")):
        raise ValueError("Linked inputs inside a case cannot be frozen.")
    input_evidence = case_dir / "evidence" / f'{media["id"]}.json'
    input_hash = sha(input_evidence)
    evidence = json.loads(input_evidence.read_bytes())
    raw_hash = sha(source)
    if media.get("hash") != raw_hash or evidence.get("sourceSha256", raw_hash) != raw_hash or evidence["mediaId"] != media["id"]:
        raise ValueError("Source recording and case identity differ.")
    stream, words = evidence.get("audioStream", media.get("audioStream", 0)), evidence["words"]
    if "audioStream" in media and (type(media["audioStream"]) is not int or stream != media["audioStream"]):
        raise ValueError("Case audio stream and transcript stream differ.")
    if type(stream) is not int or stream < 0 or not words:
        raise ValueError("Expected a source audio stream and source words.")
    if any(not all(isinstance(w.get(k), (float, int)) and math.isfinite(w[k]) for k in ("start", "end"))
           or w["start"] < 0 or w["end"] < w["start"] or not isinstance(w.get("text"), str) for w in words):
        raise ValueError("Expected finite, ordered word intervals and source text.")
    original = original_grading_evidence(case_dir, conf, input_evidence, raw_hash, stream)
    original_hash = sha(original)
    if reference:
        reference_bytes = reference.read_bytes()
        binding = json.loads(reference_bytes).get("inputs") or {}
        if (binding.get("sourceSha256") != raw_hash or type(binding.get("audioStream")) is not int or
                binding["audioStream"] != stream):
            raise ValueError("The editor audio reference must identify this exact source recording and stream.")
    model_hash = sha(model)
    if model_hash != "e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d":
        raise ValueError("Choose Scarlet's English wav2vec2 alignment weights.")
    out.parent.mkdir(exist_ok=True, parents=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as scratch:
        work = Path(scratch)
        wav = work / "source.wav"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", source, "-map", f"0:a:{stream}", "-vn",
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], check=True)
        payload = dict(words=words, wav=str(wav), model=str(model), scratch=str(work))
        if segments:
            payload["segments"] = str(segments.resolve())
        result = json.loads(subprocess.check_output(
            ["node", "--import", "tsx", EVALS / "src/alignCaseEvidence.ts"],
            input=json.dumps(payload).encode(), cwd=REPO))
        aligned, placed = result["words"], result["placedWordIndices"]
        if [w["text"] for w in aligned] != [w["text"] for w in words]:
            raise ValueError("Alignment changed the frozen lexical indices.")
        if sha(input_evidence) != input_hash:
            raise ValueError("Candidate source evidence changed during alignment.")
        stage = work / "derived"
        target = stage / "cases" / case
        shutil.copytree(case_dir, target)
        fixed = target / "grading-evidence.json"
        shutil.copyfile(original, fixed)
        if sha(fixed) != original_hash:
            raise ValueError("Original grading evidence changed during alignment.")
        conf["gradingEvidence"] = dict(mediaId=media["id"], sourceSha256=raw_hash, audioStream=stream, sha256=original_hash)
        media["audioStream"] = stream
        (target / "case.json").write_bytes(encoded(conf))
        receipt = dict(schema=1, case=case, mediaId=media["id"], audioStream=stream, sourceSha256=raw_hash,
                       gradingEvidenceSha256=original_hash,
                       inputEvidenceSha256=input_hash, inputTimingSource=evidence.get("wordsSource", "unspecified"),
                       alignmentVersion=result["alignmentVersion"], modelSha256=model_hash, wordCount=len(words),
                       placedWordIndices=placed, placedWords=len(placed), estimatedWords=len(words)-len(placed),
                       status="aligned" if placed else "provisional", segmentSource="decoder" if segments else "frozen words",
                       decoderSegmentsSha256=sha(segments) if segments else None)
        evidence.update(words=aligned, timingStatus=receipt["status"], sourceSha256=raw_hash, audioStream=stream)
        output_evidence = target / input_evidence.relative_to(case_dir)
        output_evidence.write_bytes(encoded(evidence))
        receipt["outputEvidenceSha256"] = sha(output_evidence)
        (stage / "alignment.json").write_bytes(encoded(receipt))
        if reference:
            (stage / "reference-audio.json").write_bytes(reference_bytes)
        files = {path.relative_to(stage).as_posix(): sha(path) for path in stage.rglob("*") if path.is_file()}
        (stage / "episode.lock.json").write_bytes(encoded(dict(schema=1, case=case, files=files)))
        stage.rename(out)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("case-dir", "source", "model", "out"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--segments", type=Path, help="Optional original Whisper or Crisper decoder JSON, preserving segment grouping.")
    parser.add_argument("--reference", type=Path, help="Optionally include a source/stream-bound audio reference for live scoring.")
    args = parser.parse_args()
    result = freeze(args.case_dir, args.source, args.model, args.out, args.segments, args.reference)
    print(f"{result['case']}: placed {result['placedWords']}/{result['wordCount']} frozen words.")


if __name__ == "__main__":
    main()
