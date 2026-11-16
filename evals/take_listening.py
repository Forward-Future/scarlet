#!/usr/bin/env python3
"""Prepare blind text/audio comparisons and decode model choices for the episode grader."""
import argparse
import hashlib
import json
import os
from collections import Counter, defaultdict
from pathlib import Path
import random
import re
import tempfile

from compare import encoded, private_path, sha


def write_new(path, data):
    path = private_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # A second invocation must never replace choices that have already been scored.
    with tempfile.NamedTemporaryFile(dir=path.parent) as file:
        file.write(data)
        file.flush()
        os.link(file.name, path)


def source_windows(root, trial):
    result = []
    for window in trial["windows"]:
        path = (root / window["path"]).resolve()
        if not path.is_relative_to(root) or sha(path) != window["sha256"]:
            raise ValueError(f"Source window changed or lies outside the case: {trial['id']}")
        result.append(path)
    if len(result) != 2:
        raise ValueError("Each comparison needs two original performances.")
    return result


def make_prompt(guide, trial, windows, options):
    text = [guide.rstrip(), "Choose the edit you would make to this passage of a presenter recording.",
            f"Source passage, in chronological order:\n{trial['transcript']}", "Excerpts from that passage, in presentation order:"]
    for position, source_index in enumerate(windows, 1):
        which = ("earlier", "later")[source_index]
        text.append(f"Excerpt {position}, {which} source occurrence: {trial['windows'][source_index]['transcript']}")
    text.append("Each option gives the dialogue that would play. Select one option.")
    for letter, option in options:
        text.append(f"{letter}. {option['description']}\n{option['text']}")
    text.append("Reply with the one option letter only.")
    return "\n\n".join(text)


def blind_request_id(number, batch, spec):
    # The runner echoes this opaque commitment without seeing the private decoder key.
    return number + "." + hashlib.sha256(encoded([number, batch, spec])).hexdigest()


def prepare(manifest, guide_files, out, seed):
    manifest = private_path(manifest)
    trials = json.loads(manifest.read_bytes())["trials"]
    trial_ids = [trial["id"] for trial in trials]
    if not all(trial_ids) or not trials or len(set(trial_ids)) != len(trials):
        raise ValueError("Expected distinct, nonempty comparison cases.")
    guides = {path.stem: path.read_text() for path in guide_files}
    if len(guides) != len(guide_files):
        raise ValueError("Choose distinct guide filenames.")
    out = private_path(out)
    if out.exists():
        raise ValueError("Choose a new output directory.")
    out.parent.mkdir(parents=True, exist_ok=True)
    # Prepare all files before publishing the batch.
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        stage = Path(tmp) / "study"
        stage.mkdir(mode=0o700)
        rows, key = [], {}
        header = dict(manifest=sha(manifest), seed=seed, temperature=0, guides={p.stem: sha(p) for p in guide_files})
        for trial in trials:
            paths = source_windows(manifest.parent, trial)
            opts = list(trial["options"])
            ids = [o["id"] for o in opts]
            if not 2 <= len(opts) <= 26 or len(set(ids)) != len(ids):
                raise ValueError(f"Invalid candidate options: {trial['id']}")
            rng = random.Random(f"{seed}/{trial['id']}")
            rng.shuffle(opts)
            for order in (0, 1):
                windows = [order, 1 - order]
                # Rotate all letters so no answer retains its first presentation's label.
                options = opts[order:] + opts[:order]
                labeled = [(chr(ord("A") + i), opt) for i, opt in enumerate(options)]
                for name, guide in guides.items():
                    prompt = make_prompt(guide, trial, windows, labeled)
                    for modality in ("text", "audio"):
                        attached = [paths[i] for i in windows] if modality == "audio" else []
                        spec = dict(trial=trial["id"], case=trial["case"], split=trial["split"],
                                    guide=name, modality=modality, order=order,
                                    options={letter: opt["id"] for letter, opt in labeled},
                                    promptSha256=hashlib.sha256(prompt.encode()).hexdigest(),
                                    audioSha256=[trial["windows"][i]["sha256"] for i in windows] if attached else [])
                        request_id = blind_request_id(f"{len(rows):06d}", header, spec)
                        key[request_id] = spec
                        rows.append(dict(id=request_id, prompt=prompt, audio=list(map(str, attached)),
                                         seed=seed, max_tokens=24))
        write_new(stage / "requests.jsonl", b"".join((json.dumps(r, ensure_ascii=False) + "\n").encode() for r in rows))
        write_new(stage / "key.json", encoded(dict(header, requests=key)))
        stage.rename(out)
    return len(rows)


def receipt_path(responses):
    return responses.with_name(responses.name + ".receipt.json")


def seal_responses(requests, responses, runtime):
    """Bind an independently recorded runtime identity to one complete inference batch."""
    requests, responses = map(private_path, (requests, responses))
    model_files = runtime.get("files_sha256", {})
    if ((not model_files and not runtime.get("revision")) or not isinstance(model_files, dict)
            or not runtime.get("packages") or not all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
                                                       for value in [*model_files.values(), runtime.get("adapter_sha256")])):
        raise ValueError("Expected runtime versions, model artifact hashes or a pinned revision, and runner SHA-256.")
    requested = [json.loads(line)["id"] for line in requests.read_text().splitlines()]
    identity = hashlib.sha256(encoded(runtime)).hexdigest()
    seen, settings = set(), set()
    for line in responses.read_text().splitlines():
        row = json.loads(line)
        if row["id"] in seen:
            raise ValueError(f"Repeated inference receipt: {row['id']}")
        seen.add(row["id"])
        letters = row.get("allowed_letters")
        if letters is None:
            # The original runner stored the logits for every allowed letter in command-line order.
            letters = "".join(row.get("choice_logits", {}))
        if not row.get("decoder") or len(set(letters)) != len(letters) or (row["decoder"] == "greedy_choice" and not letters):
            raise ValueError("Missing decoder or allowed choices in the inference receipt.")
        settings.add((row["decoder"], letters, row["seed"], row["temperature"]))
        if "runtime_sha256" in row and row["runtime_sha256"] != identity:
            raise ValueError("Different model or execution environment within one batch.")
    if seen != set(requested) or len(seen) != len(requested) or not seen or len(settings) != 1:
        raise ValueError("Seal one complete batch run with identical decoding settings.")
    decoder, letters, seed, temperature = settings.pop()
    receipt = dict(runtime=runtime, decoder=decoder, allowedLetters=letters, seed=seed, temperature=temperature,
                   requestsSha256=sha(requests), responsesSha256=sha(responses))
    write_new(receipt_path(responses), encoded(receipt))


def decode(batch, response_file, output, *, legacy_key_sha256=None):
    batch, response_file = map(private_path, (batch, response_file))
    key_bytes = (batch / "key.json").read_bytes()
    key = json.loads(key_bytes)
    key_digest = hashlib.sha256(key_bytes).hexdigest()
    receipt = json.loads(private_path(receipt_path(response_file)).read_bytes())
    if sha(response_file) != receipt["responsesSha256"] or sha(batch / "requests.jsonl") != receipt["requestsSha256"]:
        raise ValueError("Sealed batch requests or responses changed.")
    if not receipt.get("decoder") or (receipt["seed"], receipt["temperature"]) != (key["seed"], key["temperature"]):
        raise ValueError("Decoder or sampling settings differ from the batch receipt.")
    identity = hashlib.sha256(encoded(receipt["runtime"])).hexdigest()
    specs = key["requests"]
    if all(rid.isdecimal() for rid in specs):
        if legacy_key_sha256 != key_digest:
            raise ValueError("Legacy requests have no key commitment. Supply the key SHA-256 from an independent archive.")
    else:
        header = {name: value for name, value in key.items() if name != "requests"}
        for rid, spec in specs.items():
            if rid != blind_request_id(rid.partition(".")[0], header, spec):
                raise ValueError("Decoder key differs from the prepared request IDs.")
    decisions = {}
    for line in private_path(response_file).read_text().splitlines():
        row = json.loads(line)
        rid = row["id"]
        if rid not in specs or rid in decisions:
            raise ValueError(f"Unknown or repeated response: {rid}")
        spec = specs[rid]
        if row["prompt_sha256"] != spec["promptSha256"] or row["audio_sha256"] != spec["audioSha256"]:
            raise ValueError(f"Mismatched inference receipt: {rid}")
        if (row["audio_count"] != len(spec["audioSha256"]) or row["audio_tokens"] < 0
                or bool(row["audio_tokens"]) != bool(spec["audioSha256"])):
            raise ValueError(f"Unexpected number of audio input tokens: {rid}")
        if row["seed"] != key["seed"] or row["temperature"] != key["temperature"]:
            raise ValueError(f"Unexpected sampling settings: {rid}")
        if row.get("decoder") != receipt["decoder"] or row.get("runtime_sha256", identity) != identity:
            raise ValueError(f"Model or decoder differs from the batch receipt: {rid}")
        if receipt["allowedLetters"] and set(receipt["allowedLetters"]) != set(spec["options"]):
            raise ValueError(f"Allowed choices differ from the presented options: {rid}")
        answer = re.fullmatch(r"\s*([A-Z])\.?\s*", row.get("text", ""))
        decisions[rid] = spec["options"].get(answer.group(1)) if answer else None
    if decisions.keys() != specs.keys():
        raise ValueError(f"Missing {len(specs) - len(decisions)} responses")
    provenance = dict(manifestSha256=key["manifest"], runtimeSha256=identity, keySha256=key_digest,
                      inferenceReceiptSha256=sha(receipt_path(response_file)))
    write_new(output, encoded([{**spec, **provenance, "request": rid, "choice": decisions[rid]}
                               for rid, spec in specs.items()]))
    return len(decisions)


def score(decoded, labels, tier):
    """Count each source pair once. Two presentations test stability of the same decision."""
    if len({row["runtimeSha256"] for row in decoded}) != 1:
        raise ValueError("Compare one model runtime at a time.")
    gold = {row["id"]: row for row in labels}
    if len(gold) != len(labels) or set(gold) != {row["trial"] for row in decoded}:
        raise ValueError("Label every source pair once, including unresolved pairs.")
    groups = defaultdict(dict)
    for row in decoded:
        label = gold[row["trial"]]
        if (row["case"], row["split"]) != (label["case"], label["split"]):
            raise ValueError(f"Label refers to a different recording: {row['trial']}")
        key = (row["split"], row["guide"], row["modality"], row["trial"])
        if row["order"] in groups[key]:
            raise ValueError(f"Duplicate presentation: {key}")
        if label[tier]["targetChoice"] is not None and label[tier]["targetChoice"] not in row["options"].values():
            raise ValueError(f"Reference choice missing from candidates: {row['trial']}")
        groups[key][row["order"]] = row["choice"]
    guides = {guide for _, guide, _, _ in groups}
    arms = [(guide, modality) for guide in guides for modality in ("text", "audio")]
    if any((label["split"], guide, modality, tid) not in groups
           for tid, label in gold.items() for guide, modality in arms):
        raise ValueError("Missing an arm for one or more passages.")
    totals = defaultdict(Counter)
    for (split, guide, modality, trial), choices in groups.items():
        if set(choices) != {0, 1}:
            raise ValueError(f"Missing a presentation: {trial}")
        a, b = choices[0], choices[1]
        target = gold[trial][tier]["targetChoice"]
        counts = totals[(split, guide, modality)]
        counts["passages"] += 1
        counts["validAnswers"] += (a is not None) + (b is not None)
        counts["sameChoice"] += a is not None and a == b
        if target is not None:
            counts["scorable"] += 1
            counts["firstOrderCorrect"] += a == target
            counts["reverseOrderCorrect"] += b == target
            counts["bothOrdersCorrect"] += a == b == target
    fields = ["passages", "validAnswers", "sameChoice", "scorable", "firstOrderCorrect",
              "reverseOrderCorrect", "bothOrdersCorrect"]
    return [dict(split=split, guide=guide, modality=modality, **{f: counts[f] for f in fields})
            for (split, guide, modality), counts in sorted(totals.items())]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--manifest", type=Path, required=True)
    prep.add_argument("--guide", type=Path, action="append", required=True)
    prep.add_argument("--out", type=Path, required=True)
    prep.add_argument("--seed", type=int, default=11)
    seal = sub.add_parser("seal", help="Bind a completed run to its independently captured runtime manifest.")
    seal.add_argument("--requests", type=Path, required=True)
    seal.add_argument("--responses", type=Path, required=True)
    seal.add_argument("--runtime", type=Path, required=True, help="Model file hashes, package versions and runner SHA-256.")
    seal.add_argument("--runner", type=Path, required=True, help="Exact runner script used by the completed run.")
    read = sub.add_parser("decode")
    read.add_argument("--batch", type=Path, required=True)
    read.add_argument("--responses", type=Path, required=True)
    read.add_argument("--out", type=Path, required=True)
    read.add_argument("--legacy-key-sha256", help="For older numeric request IDs, keySha256 from independently archived choices or a frozen inventory.")
    grade = sub.add_parser("score")
    grade.add_argument("--choices", type=Path, required=True)
    grade.add_argument("--labels", type=Path, required=True)
    grade.add_argument("--tier", required=True, help="Name of the reference evidence tier in the label file.")
    grade.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        print(f"Prepared {prepare(args.manifest, args.guide, args.out, args.seed)} blind requests.")
    elif args.command == "seal":
        runtime = json.loads(private_path(args.runtime).read_bytes())
        if runtime.get("adapter_sha256") != sha(args.runner):
            raise ValueError("Runner differs from the independently captured runtime manifest.")
        seal_responses(args.requests, args.responses, runtime)
        print(receipt_path(args.responses))
    elif args.command == "decode":
        print(f"Decoded {decode(args.batch, args.responses, args.out, legacy_key_sha256=args.legacy_key_sha256)} model responses.")
    else:
        decoded = json.loads(private_path(args.choices).read_bytes())
        reference = json.loads(private_path(args.labels).read_bytes())
        if {r["manifestSha256"] for r in decoded} != {reference["hashOfBlindManifest"]}:
            raise ValueError("Labels and choices refer to different manifests.")
        write_new(args.out, encoded(score(decoded, reference["trials"], args.tier)))


if __name__ == "__main__":
    main()
