"""Local CrisperWhisper 2.0 adapter for Scarlet's whisper.cpp JSON interface."""
import argparse
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from difflib import SequenceMatcher
import gc
from itertools import accumulate
import json
import logging
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unicodedata


# Upstream word_timing groups these languages at Unicode token boundaries.
SPACELESS_LANGUAGES = {"zh", "ja", "th", "lo", "my", "yue"}
TAG = re.compile(r"\[(UH|UM|breath|cough|crying|fart|laughter|lipsmack|noise|scream|sigh|sneeze|sniff|throatclearing|yawn|(?:verbatim|intended)_\d+)\]", re.I)

GIB = 1024**3
# Leave margin above the observed ~19 GiB peak of a long CrisperWhisper decode.
ASR_WORKER_BUDGET = 22 * GIB
ASR_MIN_HEADROOM = 8 * GIB


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
    # Audio that held nothing to read has no language of its own: "auto" is the request, not an answer.
    result = {"language": language} if language and language != "auto" else {}
    return {"result": result, "transcription": segments}


# Scarlet takes out any line whose loudest moment is under -60 dBFS, whatever the recording (UNHEARD_DBFS in
# transcriptHoles.ts): nothing said that quietly stays in a transcript. A long stretch that quiet is no use to the
# model, and it costs. On a gated microphone track (digital silence whenever its speaker was quiet, 2026-11-23) every
# thirty seconds of silence came back as the last sentence said, again and again: "I'm using the one that you're
# using." a hundred times over, each window decoding to its token limit, and the next window carrying it on as context.
QUIET_DBFS = -60
QUIET_STEP = 0.02
# Shorter quiet is a pause between words and is read as it is.
LONG_QUIET = 2.0
# A long quiet keeps this much at each end beside sound, so a word's soft edge stays and the model hears a pause.
QUIET_KEPT = 0.5


@dataclass
class Piece:
    """Audio the model reads: `length` seconds from `source` in the recording, at `at` in what the model hears."""
    source: float
    at: float
    length: float


def quiet_steps(pcm, rate=16000):
    """Whether each 20 ms of the audio is under QUIET_DBFS."""
    import numpy as np

    size = round(QUIET_STEP * rate)
    samples = np.asarray(pcm, dtype=np.float32)
    count = -(-len(samples) // size)
    padded = np.zeros(count * size, dtype=np.float32)
    padded[:len(samples)] = samples
    power = np.square(padded.reshape(count, size), dtype=np.float64).mean(axis=1)
    return (power < (10 ** (QUIET_DBFS / 20)) ** 2).tolist()


def sounding_pieces(quiet, duration):
    """The audio with every quiet stretch of LONG_QUIET or more shortened to QUIET_KEPT beside the sound either side.
    Empty when nothing in it is louder than quiet. One piece, the whole of it, when nothing is that long."""
    steps = len(quiet)
    if not steps or all(quiet):
        return []
    kept = []
    start = 0.0
    i = 0
    while i < steps:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < steps and quiet[j]:
            j += 1
        begin, end = i * QUIET_STEP, min(duration, j * QUIET_STEP)
        if end - begin >= LONG_QUIET:
            # Quiet at the very start or end has sound on one side only.
            if begin > 0:
                kept.append((start, begin + QUIET_KEPT))
            start = end - QUIET_KEPT if j < steps else duration
        i = j
    if start < duration:
        kept.append((start, duration))
    pieces = []
    at = 0.0
    for source, until in kept:
        pieces.append(Piece(source, at, until - source))
        at += until - source
    return pieces


def compacted(pcm, pieces, rate=16000):
    """The samples of `pieces`, one after another."""
    import numpy as np

    return np.concatenate([pcm[round(p.source * rate):round((p.source + p.length) * rate)] for p in pieces])


def restore_times(words, pieces):
    """Words timed on the pieces laid end to end, back on the recording's clock. A word stays inside the piece it
    starts in: the quiet between two pieces was at least a second long, and nobody said anything in it."""
    starts = [p.at * 1000 for p in pieces]
    for word in words:
        piece = pieces[max(0, bisect_right(starts, word.start) - 1)]
        at, length, source = piece.at * 1000, piece.length * 1000, piece.source * 1000
        start = min(length, max(0, word.start - at))
        word.start = round(source + start, 6)
        word.end = round(source + min(length, max(start, word.end - at)), 6)
    return words


progress_wanted = False


class ChunkProgress(logging.Handler):
    def emit(self, record):
        found = re.match(r"Chunk (\d+)/(\d+):", record.getMessage())
        if found and progress_wanted:
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


def preferred_device(torch):
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def macos_asr_headroom(physical_memory):
    pressure = subprocess.check_output(
        ["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], text=True)
    if int(pressure) != 1:
        return 0
    stats = subprocess.check_output(["/usr/bin/vm_stat"], text=True, env={**os.environ, "LC_ALL": "C"})
    pages = dict(re.findall(r"^([^:\n]+):\s+(\d+)\.$", stats, re.MULTILINE))
    # File-backed cache can be reclaimed for inference. Anonymous, wired and compressed pages still count.
    occupied = sum(int(pages[key]) for key in ("Anonymous pages", "Pages wired down", "Pages occupied by compressor"))
    return physical_memory - occupied * os.sysconf("SC_PAGE_SIZE")


def claim_local_asr_slot(directory, slot_count, worker_budget, reserve, physical_memory):
    import fcntl

    with (directory / "local-asr-admission.lock").open("a") as admission:
        fcntl.flock(admission, fcntl.LOCK_EX)
        free_slots = []
        try:
            for index in range(slot_count):
                name = "local-asr.lock" if index == 0 else f"local-asr-{index + 1}.lock"
                fd = os.open(directory / name, os.O_CREAT | os.O_RDWR, 0o600)
                free_slots.append(fd)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    os.close(free_slots.pop())
            if free_slots:
                # Reserve the full estimate for every admitted worker. Some may still be loading weights.
                occupied_slots = slot_count - len(free_slots)
                needed = reserve + (occupied_slots + 1) * worker_budget
                if macos_asr_headroom(physical_memory) >= needed:
                    return free_slots.pop(0)
        finally:
            for fd in free_slots:
                os.close(fd)


def wait_for_local_asr_slot():
    if sys.platform != "darwin":
        return

    # Metal and CPU share memory. Allow extra workers only within half the Mac's RAM.
    physical_memory = int(subprocess.check_output(["/usr/sbin/sysctl", "-n", "hw.memsize"], text=True))
    reserve = min(ASR_MIN_HEADROOM, physical_memory // 8)
    if physical_memory < ASR_WORKER_BUDGET + reserve:
        raise SystemExit("This Mac has too little memory for CrisperWhisper. Choose bundled Whisper in Scarlet.")
    slot_count = max(1, physical_memory // 2 // ASR_WORKER_BUDGET)
    directory = Path.home() / "Library/Application Support/com.forwardfuture.scarlet"
    directory.mkdir(parents=True, exist_ok=True)
    # A successful claim's non-inheritable descriptor stays open until the worker exits.
    if claim_local_asr_slot(directory, slot_count, ASR_WORKER_BUDGET, reserve, physical_memory) is not None:
        return
    print("local transcription waiting for memory", file=sys.stderr, flush=True)
    while True:
        time.sleep(1)
        if claim_local_asr_slot(directory, slot_count, ASR_WORKER_BUDGET, reserve, physical_memory) is not None:
            return


# The model on the device it last ran on. A worker that serves several requests (--serve) loads it once: started
# again for each ten-minute window, a run spent its first seconds importing torch and moving 3 GB of weights to the GPU.
_recognizer = {}


def recognizer_on(model, cache, device):
    from crisperwhisper import CrisperWhisperModel

    if device not in _recognizer:
        forget_recognizer()
        _recognizer[device] = CrisperWhisperModel(str(model.parent), backend="transformers", device=device,
                                                  compute_type="float32" if device == "cpu" else "float16",
                                                  cache_dir=str(cache))
    return _recognizer[device]


def forget_recognizer():
    _recognizer.clear()


def recognize(pcm, model, cache, language, device):
    import torch

    recognizer = recognizer_on(model, cache, device)
    engine = recognizer._engine
    print(f"crisperwhisper device = {engine.device.type}", file=sys.stderr, flush=True)
    if language == "auto":
        with torch.inference_mode():
            detected = engine.model.detect_language(input_features=engine.extract_features(pcm[:480_000]))
        language = engine.tokenizer.convert_ids_to_tokens(int(detected.item()))[2:-2]
    if engine.get_language_id(language) is None:
        raise ValueError(f"Unsupported CrisperWhisper language code: {language}")
    return recognizer.transcribe(pcm, sr=16000, language=language, mode="verbatim", word_timestamps=True)


def release_device_cache(torch, device):
    gc.collect()
    try:
        getattr(torch, device).empty_cache()
    except (AttributeError, RuntimeError):
        # A device which became unavailable can also refuse cache cleanup.
        pass


def recognize_locally(pcm, model, cache, language, torch, progress):
    device = preferred_device(torch)
    if device != "cpu":
        try:
            return recognize(pcm, model, cache, language, device)
        except (RuntimeError, TypeError) as error:
            # Unavailable operations and GPU allocation failures are RuntimeError. An unsupported
            # MPS tensor dtype raises TypeError during tensor transfer instead.
            # Leave the exception scope before reloading so its traceback releases the model tensors.
            print(f"crisperwhisper fallback = {device}", file=sys.stderr, flush=True)
            reason = str(error).partition("\n")[0][:300] or type(error).__name__
            print(f"GPU recognition failed: {reason}", file=sys.stderr, flush=True)
        forget_recognizer()
        release_device_cache(torch, device)
        if progress:
            print("progress = 0%", file=sys.stderr, flush=True)
    return recognize(pcm, model, cache, language, "cpu")


def transcribe_file(wav, prefix, language, model, cache, torch, load_audio):
    pcm = load_audio(str(wav))
    language = language.lower()
    words = []
    if len(pcm):
        duration = len(pcm) / 16000
        pieces = sounding_pieces(quiet_steps(pcm), duration)
        whole = len(pieces) == 1 and pieces[0].source == 0 and pieces[0].length == duration
        if pieces and not whole:
            heard = sum(p.length for p in pieces)
            print(f"crisperwhisper quiet = {duration - heard:.1f} s of {duration:.1f} s not read", file=sys.stderr, flush=True)
            pcm = compacted(pcm, pieces)
        if pieces:
            result = recognize_locally(pcm, model, cache, language, torch, progress_wanted)
            language = result.language
            words = reconcile(result.text, result.words, len(pcm) / 16000, language)
            if not whole:
                words = restore_times(words, pieces)
    save_json(whisper_json(language, words), prefix)
    if progress_wanted:
        print("progress = 100%", file=sys.stderr, flush=True)


def prepare_runtime(model, threads):
    cache = model.parent.parent / "cache"
    cache.mkdir(exist_ok=True)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      HF_HOME=str(cache / "hf"), XDG_CACHE_HOME=str(cache), TORCH_HOME=str(cache / "torch"),
                      MPLCONFIGDIR=str(cache / "matplotlib"), TOKENIZERS_PARALLELISM="false")
    import torch
    from crisperwhisper.audio import load_audio

    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    logger = logging.getLogger("crisperwhisper.longform.continuation")
    logger.setLevel(logging.INFO)
    logger.addHandler(ChunkProgress())
    logger.propagate = False
    return cache, torch, load_audio


def serve(model, threads, requests=sys.stdin):
    """Answer requests, one JSON line each on stdin, until stdin closes: {"id", "wav", "out", "language", "progress"}
    writes `out`.json as a run with `-f wav -of out` does, and one JSON line goes back on stdout, {"id", "ok": true}
    or {"id", "error"}. Anything else the libraries print goes to stderr. A request that fails ends the worker, so the
    next starts with nothing left over from it."""
    global progress_wanted
    replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    wait_for_local_asr_slot()
    cache, torch, load_audio = prepare_runtime(model, threads)

    def reply(**fields):
        sys.stderr.flush()
        replies.write(json.dumps(fields, ensure_ascii=False) + "\n")
        replies.flush()

    while True:
        line = requests.readline()
        if not line:
            return 0
        if not line.strip():
            continue
        request = {}
        try:
            request = json.loads(line)
            progress_wanted = bool(request.get("progress"))
            transcribe_file(Path(request["wav"]), Path(request["out"]), request.get("language") or "auto",
                            model, cache, torch, load_audio)
        except Exception as error:
            reply(id=request.get("id") if isinstance(request, dict) else None,
                  error=str(error).partition("\n")[0][:500] or type(error).__name__)
            return 1
        # The weights stay. What the decode left in the device's cache goes back while the worker waits.
        release_device_cache(torch, preferred_device(torch))
        reply(id=request.get("id"), ok=True)


def main():
    global progress_wanted
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version="CrisperWhisper 2.0 local Scarlet adapter")
    parser.add_argument("-m", required=True, type=Path, metavar="MODEL_SAFETENSORS")
    parser.add_argument("-f", type=Path, metavar="WAV")
    parser.add_argument("-of", type=Path, metavar="OUTPUT_PREFIX")
    parser.add_argument("-ojf", action="store_true")
    parser.add_argument("-np", action="store_true")
    parser.add_argument("-l", default="auto", metavar="LANGUAGE")
    parser.add_argument("-t", type=int, default=8, metavar="THREADS")
    parser.add_argument("-mc", type=int, choices=[0], metavar="0")
    parser.add_argument("--prompt", help="Scarlet’s disfluency-style prompt uses native verbatim mode.")
    parser.add_argument("-pp", action="store_true", help="Print Scarlet-compatible progress to stderr.")
    parser.add_argument("--serve", action="store_true", help="Keep the model loaded and read requests from stdin.")
    args = parser.parse_args()

    if args.t < 1:
        parser.error("The thread count must be positive.")
    model = args.m.expanduser().resolve()
    if model.name != "model.safetensors" or not model.is_file():
        parser.error("Select this local model's model.safetensors file.")
    if args.serve:
        sys.exit(serve(model, args.t))
    if not (args.f and args.of and args.ojf):
        parser.error("Give -f, -of and -ojf, or --serve.")
    if not args.f.is_file():
        parser.error(f"Input audio does not exist: {args.f}")
    if not args.of.parent.is_dir():
        parser.error(f"Output folder does not exist: {args.of.parent}")
    wait_for_local_asr_slot()
    cache, torch, load_audio = prepare_runtime(model, args.t)
    progress_wanted = args.pp
    transcribe_file(args.f, args.of, args.l, model, cache, torch, load_audio)


if __name__ == "__main__":
    main()
