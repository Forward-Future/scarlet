"""Local CrisperWhisper 2.0 adapter for Scarlet's whisper.cpp JSON interface."""
import argparse
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from difflib import SequenceMatcher
from itertools import accumulate
import json
import logging
import math
import os
from pathlib import Path
import re
import sys
import unicodedata


# Upstream word_timing groups these languages at Unicode token boundaries.
SPACELESS_LANGUAGES = {"zh", "ja", "th", "lo", "my", "yue"}
TAG = re.compile(r"\[(UH|UM|breath|cough|crying|fart|laughter|lipsmack|noise|scream|sigh|sneeze|sniff|throatclearing|yawn|(?:verbatim|intended)_\d+)\]", re.I)


def key(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text.casefold()) if c.isalnum() or unicodedata.category(c).startswith("M"))


def spoken_tokens(text):
    def clean_tag(match):
        name = match[1].lower()
        return f" {name} " if name in {"uh", "um"} else " "

    words = []
    for token in TAG.sub(clean_tag, text).split():
        if key(token):
            words.append(token)
        elif words:
            words[-1] += token
    return words


@dataclass
class Word:
    text: str
    start: float
    end: float
    estimated: bool = False
    space_before: bool = True


def intervals(wanted, start, end):
    """Approximate only words missing a native time, within the neighboring anchors."""
    span = max(0, end - start)
    count = len(wanted)
    return [Word(t, round(start + span * i / count, 6), round(start + span * (i + 1) / count, 6), True)
            for i, t in enumerate(wanted)]


def refine_spaceless_tokens(surface, native):
    """Project native token boundaries onto the original unspaced, punctuated text."""
    keys = [key(w.text) for w in native]
    source = "".join(keys)
    target = "".join(key(w) for w in surface)
    edges = list(accumulate(map(len, keys), initial=0))
    if source == target:
        cuts = set(edges)
    else:
        cuts = set()
        for src, dst, size in SequenceMatcher(None, source, target).get_matching_blocks():
            if size:
                begin = bisect_left(edges, src)
                end = bisect_right(edges, src + size)
                cuts.update(dst + edge - src for edge in edges[begin:end])

    words, joined = [], []
    offset = 0
    for token in surface:
        start = 0
        for i, char in enumerate(token):
            units = key(char)
            if not units:
                continue
            if i and offset in cuts and key(token[start:i]):
                words.append(token[start:i])
                joined.append(len(words))
                start = i
            offset += len(units)
        words.append(token[start:])
    return words, joined


def reconcile(surface, stamps, duration, language="en"):
    wanted = spoken_tokens(surface)
    if not wanted:
        return []
    limit = round(duration * 1000, 6)
    native = []
    for item in stamps:
        tokens = spoken_tokens(item.word)
        if not tokens or item.start is None or item.end is None:
            continue
        if not (math.isfinite(item.start) and math.isfinite(item.end)):
            continue
        previous_start = native[-1].start if native else 0
        a = min(limit, max(previous_start, round(item.start * 1000, 6)))
        b = min(limit, max(a, round(item.end * 1000, 6)))
        if native and native[-1].end > a:
            # Keep the next observed onset, including a partial word before EOF.
            native[-1].end = a
        if len(tokens) == 1:
            native.append(Word(tokens[0], a, b))
        else:
            native.extend(intervals(tokens, a, b))

    joined = []
    if language in SPACELESS_LANGUAGES and native:
        wanted, joined = refine_spaceless_tokens(wanted, native)
    left, right = [key(w.text) for w in native], [key(w) for w in wanted]
    if left == right:
        actions = [("equal", 0, len(left), 0, len(right))]
    else:
        actions = SequenceMatcher(None, left, right, autojunk=False).get_opcodes()
    out = []
    for action, i, j, a, b in actions:
        if action == "equal":
            out.extend(Word(t, w.start, w.end, w.estimated) for t, w in zip(wanted[a:b], native[i:j]))
        elif a < b:
            if i < j:
                start, end = native[i].start, native[j - 1].end
            else:
                start = native[i - 1].end if i else 0
                end = native[i].start if i < len(native) else limit
            out.extend(intervals(wanted[a:b], start, end))
    for i in joined:
        out[i].space_before = False
    # At a clipped ending the decoder may continue after the last input sample.
    # Keep zero-length internal estimates, but no suffix at (or beyond) audio EOF.
    return [word for word in out if word.start < limit]


def whisper_json(language, words):
    groups = []
    current = []
    for word in words:
        if current and (word.start - current[-1].end >= 1000 or word.end - current[0].start > 30000):
            groups.append(current)
            current = []
        current.append(word)
        if re.search(r'[.!?。！？]["“”’\)]*$', word.text):
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    segments = []
    for group in groups:
        tokens = []
        for word in group:
            token = {"text": " " + word.text, "offsets": {"from": word.start, "to": word.end}}
            if word.estimated:
                token["timing_source"] = "interpolated"
            tokens.append(token)
        text = "".join((" " if i and w.space_before else "") + w.text for i, w in enumerate(group))
        segments.append({"text": text,
                         "offsets": {"from": group[0].start, "to": group[-1].end}, "tokens": tokens})
    return {"result": {"language": language}, "transcription": segments}


class ChunkProgress(logging.Handler):
    def emit(self, record):
        found = re.match(r"Chunk (\d+)/(\d+):", record.getMessage())
        if found:
            done, total = map(int, found.groups())
            if total:
                print(f"progress = {min(99, int(100 * done / total))}%", file=sys.stderr, flush=True)


def save_json(data, prefix):
    destination = Path(str(prefix) + ".json")
    # Scarlet assigns a unique prefix, waits for the process, and removes this exact
    # path on cancellation. A separate temporary name can leak when the child is killed.
    payload = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    with destination.open("wb") as stream:
        stream.write(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version="CrisperWhisper 2.0 local Scarlet adapter")
    parser.add_argument("-m", required=True, type=Path, metavar="MODEL_SAFETENSORS")
    parser.add_argument("-f", required=True, type=Path, metavar="WAV")
    parser.add_argument("-of", required=True, type=Path, metavar="OUTPUT_PREFIX")
    parser.add_argument("-ojf", action="store_true", required=True)
    parser.add_argument("-np", action="store_true")
    parser.add_argument("-l", default="auto", metavar="LANGUAGE")
    parser.add_argument("-t", type=int, default=8, metavar="THREADS")
    parser.add_argument("-mc", type=int, choices=[0], metavar="0")
    parser.add_argument("--prompt", help="Scarlet’s disfluency-style prompt uses native verbatim mode.")
    parser.add_argument("-pp", action="store_true", help="Print Scarlet-compatible progress to stderr.")
    args = parser.parse_args()

    if args.t < 1:
        parser.error("The thread count must be positive.")
    model = args.m.expanduser().resolve()
    if model.name != "model.safetensors" or not model.is_file():
        parser.error("Select this local model's model.safetensors file.")
    if not args.f.is_file():
        parser.error(f"Input audio does not exist: {args.f}")
    if not args.of.parent.is_dir():
        parser.error(f"Output folder does not exist: {args.of.parent}")
    cache = Path(__file__).resolve().parent / "cache"
    cache.mkdir(exist_ok=True)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      HF_HOME=str(cache / "hf"), XDG_CACHE_HOME=str(cache), TORCH_HOME=str(cache / "torch"),
                      MPLCONFIGDIR=str(cache / "matplotlib"), TOKENIZERS_PARALLELISM="false")
    import torch
    from crisperwhisper import CrisperWhisperModel
    from crisperwhisper.audio import load_audio

    torch.set_num_threads(args.t)
    torch.set_num_interop_threads(1)
    if args.pp:
        logger = logging.getLogger("crisperwhisper.longform.continuation")
        logger.setLevel(logging.INFO)
        logger.addHandler(ChunkProgress())
        logger.propagate = False

    pcm = load_audio(str(args.f))
    recognizer = CrisperWhisperModel(str(model.parent), backend="transformers", device="cpu",
                                     compute_type="float32", cache_dir=str(cache))
    language = args.l.lower()
    if language == "auto" and len(pcm):
        engine = recognizer._engine
        with torch.inference_mode():
            detected = engine.model.detect_language(input_features=engine.extract_features(pcm[:480_000]))
        language = engine.tokenizer.convert_ids_to_tokens(int(detected.item()))[2:-2]
    if not len(pcm):
        save_json(whisper_json(language, []), args.of)
    else:
        if recognizer._engine.get_language_id(language) is None:
            parser.error(f"Unsupported CrisperWhisper language code: {language}")
        result = recognizer.transcribe(pcm, sr=16000, language=language, mode="verbatim", word_timestamps=True)
        words = reconcile(result.text, result.words, len(pcm) / 16000, result.language)
        save_json(whisper_json(result.language, words), args.of)
    if args.pp:
        print("progress = 100%", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
