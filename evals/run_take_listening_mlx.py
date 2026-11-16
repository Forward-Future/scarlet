"""Generate offline take-listening JSONL receipts with Gemma 3n on Apple Silicon.

Optional eval environment: Python 3.12, mlx==0.32.4, mlx-vlm==0.7.12,
transformers==5.23.0, soundfile==0.14.0. Download the weights once with:
    hf download mlx-community/gemma-3n-E4B-it-4bit \
        --revision 505468a22e5703ff090e222aae9beedec49b383f --local-dir WEIGHTS
Then run:
    python run_take_listening_mlx.py --model WEIGHTS --input requests.jsonl \
        --output responses.jsonl
WAV paths are ordered attachments; an empty audio list is the text control.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import sys
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

import mlx.core as mx
from mlx_vlm import generate, load
from mlx_vlm.utils import load_audio, prepare_inputs, should_add_special_tokens
import numpy as np
import soundfile as sf



def text_digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def file_digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def infer(model, processor, request, letters):
    prompt = request['prompt']
    if not prompt.strip():
        raise ValueError('Expected a nonempty prompt')
    paths = [Path(name).resolve(strict=True) for name in request.get('audio', [])]
    clips = [sf.info(path) for path in paths]
    durations = [clip.frames / clip.samplerate for clip in clips]
    sample_rate = 16000
    separator_samples = 12000  # 750 ms between excerpts, never mixed into speech
    if any(duration <= 0 for duration in durations):
        raise ValueError('Empty audio excerpt')
    if sum(durations) + max(0, len(paths) - 1) * separator_samples / sample_rate > 30:
        raise ValueError('Joined recording exceeds Gemma 3n’s 30-second audio limit')
    content = [{'type': 'text', 'text': prompt}]
    waveform = None
    if paths:
        if processor.feature_extractor is None:
            raise ValueError('Processor has no audio feature extractor')
        pieces = []
        for path in paths:
            if pieces:
                pieces.append(np.zeros(separator_samples, dtype=np.float32))
            pieces.append(load_audio(str(path), sr=sample_rate))
        waveform = np.concatenate(pieces).astype('<f4', copy=False)
        content.append({'type': 'audio'})
    formatted = processor.apply_chat_template(
        [{'role': 'user', 'content': content}], tokenize=False, add_generation_prompt=True
    )
    inputs = dict(prepare_inputs(
        processor, prompts=formatted, audio=[waveform] if paths else None,
        add_special_tokens=should_add_special_tokens(model.config.model_type, processor),
    ))
    audio_tokens = int(mx.sum(inputs['input_ids'] == model.config.audio_token_id).item())
    features = inputs.get('input_features')
    if audio_tokens != int(bool(paths)) * processor.audio_seq_length:
        raise ValueError(f'Unexpected audio token count {audio_tokens} for {len(paths)} attachments')
    if paths and (features is None or features.shape[0] != 1):
        raise ValueError('Missing features for joined recording')
    if features is not None and not mx.all(mx.isfinite(features)).item():
        raise ValueError('Nonfinite audio features')
    if 'attention_mask' in inputs:
        inputs['mask'] = inputs.pop('attention_mask')

    seed = int(request.get('seed', 0))
    temperature = float(request.get('temperature', 0))
    mx.random.seed(seed)
    started = time.monotonic()
    scores = {}
    output_limit = int(request.get('max_tokens', 96))
    decoding = {}
    if letters:
        if temperature != 0:
            raise ValueError('Fixed choices require greedy decoding')
        ids = [processor.tokenizer.encode(letter, add_special_tokens=False) for letter in letters]
        if any(len(tokens) != 1 for tokens in ids) or len(set(letters)) != len(letters):
            raise ValueError('Each allowed choice must be one unique token')
        token_ids = [tokens[0] for tokens in ids]

        def restrict_choices(history, logits):
            if not scores:
                scores.update(zip(letters, logits[0, token_ids].astype(mx.float32).tolist()))
            allowed = mx.full(logits.shape, -float('inf'), dtype=logits.dtype)
            allowed[:, token_ids] = logits[:, token_ids]
            return allowed

        decoding['logits_processors'] = [restrict_choices]
        output_limit = 1
    result = generate(
        model, processor, formatted, max_tokens=output_limit,
        temperature=temperature, top_p=1.0, top_k=0, verbose=False, **inputs, **decoding,
    )
    return {
        'id': request['id'], 'text': result.text,
        'prompt_sha256': text_digest(prompt), 'formatted_sha256': text_digest(formatted),
        'audio_sha256': [file_digest(path) for path in paths], 'audio_count': len(paths),
        'audio_seconds': durations, 'audio_tokens': audio_tokens,
        'audio_feature_shape': list(features.shape) if features is not None else [],
        'choice_logits': scores, 'decoder': 'greedy_choice' if letters else 'unconstrained',
        'sample_rate': sample_rate, 'separator_samples': separator_samples if len(paths) > 1 else 0,
        'joined_pcm_sha256': hashlib.sha256(waveform.tobytes()).hexdigest() if paths else None,
        'seed': seed, 'temperature': temperature, 'new_tokens': result.generation_tokens,
        'prompt_tokens': result.prompt_tokens, 'generation_seconds': round(time.monotonic() - started, 4),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--choice-letters', metavar='ABC', help='Restrict the first generated token to these option letters.')
    args = parser.parse_args()
    if args.choice_letters and not args.choice_letters.isascii():
        parser.error('Option letters must be ASCII.')
    if not args.model.is_dir():
        parser.error('--model must be a local directory')
    rows = [json.loads(line) for line in args.input.read_text().splitlines() if line.strip()]
    if len(rows) != len({row['id'] for row in rows}):
        parser.error('Duplicate request ID')
    artifacts = [p for p in sorted(args.model.iterdir()) if p.is_file()]
    runtime = dict(python=sys.version.split()[0], platform=platform.platform(),
                   packages={name: importlib.metadata.version(name) for name in
                             ("mlx", "mlx-vlm", "transformers", "tokenizers", "soundfile", "numpy")},
                   files_sha256={p.name: file_digest(p) for p in artifacts}, adapter_sha256=file_digest(Path(__file__)))
    # This canonical JSON also identifies the manifest when the grader seals a batch.
    manifest = (json.dumps(runtime, sort_keys=True, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode()
    identity = hashlib.sha256(manifest).hexdigest()
    # Store the measured identity even if inference stops partway through.
    with args.output.with_name(args.output.name + ".runtime.json").open("xb") as output:
        output.write(manifest)
    model, processor = load(str(args.model.resolve()))
    processor.chat_template = (args.model / 'chat_template.jinja').read_text()
    with args.output.open('x') as receipts:
        for row in rows:
            receipt = infer(model, processor, row, args.choice_letters)
            receipt.update(runtime_sha256=identity, allowed_letters=args.choice_letters or '')
            receipts.write(json.dumps(receipt, allow_nan=False, ensure_ascii=False) + '\n')
            receipts.flush()
            print(row['id'], receipt['audio_tokens'], receipt['generation_seconds'], file=sys.stderr, flush=True)

if __name__ == '__main__':
    main()
