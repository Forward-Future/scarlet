"""Recover final-to-source dialogue spans from two recordings at their native playback speed.

Requires NumPy, ffprobe and ffmpeg. Run `python match_audio.py --help` for usage.
"""

import argparse
import json
import os
import subprocess
import tempfile
from collections import defaultdict
from fractions import Fraction
from pathlib import Path

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

RATE = 2000
HIGH_RATE = 16000
HOP = 40                   # 20 ms feature hop
WINDOW = 16 * HOP          # 320 ms of audio for a source match


def soundtrack(path, track, rate, band, delay):
    pcm = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(path), '-map', f'0:a:{track}', '-vn',
        '-af', band, '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-'])
    samples = np.frombuffer(pcm, dtype='<f4')
    offset = round(delay * rate)
    return np.pad(samples, (offset, 0)) if offset > 0 else samples[-offset:]


def decode(path, track):
    probe = subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries',
        'format=start_time,duration:stream=codec_type,start_time,avg_frame_rate', '-of', 'json', str(path)])
    meta = json.loads(probe)
    video = next((s for s in meta['streams'] if s['codec_type'] == 'video'), {})
    audio_streams = [s for s in meta['streams'] if s['codec_type'] == 'audio']
    if not 0 <= track < len(audio_streams):
        raise ValueError(f'Audio track {track} is unavailable in {path.name}.')
    # Put late-starting audio on the same zero-based clock as the container timeline.
    start = float(meta['format'].get('start_time', 0))
    delay = float(audio_streams[track].get('start_time', start)) - start
    samples = soundtrack(path, track, RATE, 'highpass=f=180,lowpass=f=850', delay)
    rate = video.get('avg_frame_rate', '0/0')
    fps = float(Fraction(rate)) if rate != '0/0' else 50.0
    return samples, float(meta['format']['duration']), fps, delay


def fingerprints(samples):
    # Compare short patterns across time and frequency; each retrieved location is subsequently
    # verified against the waveform. A similar phrase or a similar power spectrum alone is insufficient.
    frames = sliding_window_view(samples, 2 * HOP)[::HOP]
    spectrum = abs(np.fft.rfft(frames * np.hanning(2 * HOP)))
    bands = np.log(np.maximum(np.add.reduceat(spectrum, [5, 9, 13, 17, 21, 26, 31], axis=1), 1e-6))
    patterns = sliding_window_view(bands, WINDOW // HOP - 1, axis=0).copy()
    patterns -= patterns.mean(axis=2, keepdims=True)
    features = np.ascontiguousarray(patterns.reshape(len(patterns), -1), dtype=np.float32)
    return features / np.maximum(np.linalg.norm(features, axis=1, keepdims=True), 1e-6)


def find_offsets(raw, final):
    if min(len(raw), len(final)) < WINDOW:
        return []
    source, queries = fingerprints(raw), fingerprints(final)[::10]
    hits = defaultdict(list)
    powers = np.r_[0., np.cumsum(raw.astype(float) ** 2)]
    window_norm = np.sqrt(np.maximum(1e-16, powers[WINDOW:] - powers[:-WINDOW]))
    for batch in range(0, len(queries), 32):
        neighbors = queries[batch:batch + 32] @ source.T
        for j, scores in enumerate(neighbors):
            time = (batch + j) * 10 * HOP
            sample = final[time:time + WINDOW]
            norm = np.linalg.norm(sample)
            if norm < .005:
                continue
            for _ in range(4):
                index = int(scores.argmax())
                if scores[index] < .18:
                    break
                scores[max(0, index - 4):index + 5] = -1
                lo = max(0, (index - 2) * HOP)
                hi = min(len(raw), (index + 2) * HOP + WINDOW)
                corr = np.correlate(raw[lo:hi], sample) / (norm * window_norm[lo:hi - WINDOW + 1])
                best = int(corr.argmax())
                if corr[best] >= .62:
                    lag = lo + best - time
                    hits[lag].append(float(corr[best]))
    # Sample quantization can alternate between adjacent offsets for a single fixed-delay segment.
    groups = []
    for lag, values in sorted(hits.items()):
        if not groups or lag > groups[-1][0][0] + 2:
            groups.append([])
        groups[-1].extend((lag, score) for score in values)
    return [round(float(np.median([lag for lag, _ in group]))) for group in groups
            if len(group) >= 2 or max(score for _, score in group) >= .87]


def frame_correlation(raw, final, edges, lag, final_power):
    shifted = np.zeros_like(final)
    lo, hi = max(0, -lag), min(len(final), len(raw) - lag)
    if hi > lo:
        shifted[lo:hi] = raw[lo+lag:hi+lag]
    source_power = np.add.reduceat(shifted * shifted, edges[:-1])
    cross = np.add.reduceat(final * shifted, edges[:-1])
    corr = cross / np.maximum(np.sqrt(final_power * source_power), 1e-10)
    corr[(edges[:-1] + lag < 0) | (edges[1:] + lag > len(raw))] = -1
    return corr


def runs(path):
    edges = np.r_[0, np.flatnonzero(path[1:] != path[:-1]) + 1, len(path)]
    return [(int(a), int(b), int(path[a])) for a, b in zip(edges, edges[1:])]


def choose_path(scores, fps):
    # Constant-delay states can change in any order. The extra state covers foreign audio.
    n, k = scores.shape
    evidence = np.column_stack((scores, np.full(n, .20)))
    previous = np.zeros(k + 1)
    states = np.arange(k + 1)
    back = np.empty((n, k + 1), dtype=np.int32)
    for i in range(n):
        best = previous.argmax()
        switch = previous[best] - .07 * fps
        back[i] = np.where(previous >= switch, states, best)
        previous = np.maximum(previous, switch) + evidence[i]
    path = np.empty(n, dtype=np.int32)
    state = int(previous.argmax())
    for i in range(n - 1, -1, -1):
        path[i] = state
        state = back[i, state]
    return path


def high_band_evidence(raw, final, times, scores, offsets, path):
    # Refine each known offset on a second, independent band. Only examine its actual passage
    # and flanks so checking all joins costs roughly one extra pass over the finished audio.
    edges = np.rint(times * HIGH_RATE).astype(int)
    final = np.pad(final[:edges[-1]], (0, max(0, edges[-1] - len(final))))
    strongest = scores.copy()
    for a, b, state in runs(path):
        if state == len(offsets) or times[b] - times[a] < .3:
            continue
        lag = round(offsets[state] * HIGH_RATE / RATE)
        width = HIGH_RATE // 4
        starts = np.arange(edges[a], edges[b] - width, width // 2)
        if not len(starts):
            continue
        start = max(starts, key=lambda t: np.sum(final[t:t+width] ** 2))
        lo = max(0, start + lag - 12)
        hi = min(len(raw), start + lag + 12 + width)
        if hi - lo < width:
            continue
        sample = final[start:start+width]
        neighborhood = sliding_window_view(raw[lo:hi], width)
        norms = np.linalg.norm(neighborhood, axis=1) * np.linalg.norm(sample)
        similarity = (neighborhood @ sample) / np.maximum(norms, 1e-10)
        best = int(similarity.argmax())
        if similarity[best] < .5:
            continue
        lag = lo + best - start
        first_frame = int(np.searchsorted(times, max(0., times[a] - .45)))
        end_frame = min(len(times) - 1, int(np.searchsorted(times, times[b] + .45)))
        t0, t1 = edges[first_frame], edges[end_frame]
        window = final[t0:t1]
        frame_edges = edges[first_frame:end_frame + 1] - t0
        power = np.add.reduceat(window * window, frame_edges[:-1])
        hi_corr = frame_correlation(raw, window, frame_edges, lag + t0, power)
        span = slice(first_frame, end_frame)
        strongest[span, state] = np.maximum(strongest[span, state], hi_corr)
        scores[span, state] = .5 * (scores[span, state] + hi_corr)
    return strongest


def reject_unverified(path, scores, strongest, fps):
    k = scores.shape[1]
    for a, b, state in runs(path):
        if state == k:
            continue
        # Indistinguishable digital duplicates are ambiguous even with a perfect best correlation.
        medians = np.median(scores[a:b], axis=0)
        multiple_origins = np.count_nonzero(medians > medians[state] - .045) > 1
        if medians[state] < .5 or multiple_origins:
            path[a:b] = k
            continue
        # Long gaps without supporting samples remain unknown even between matching flanks.
        for i, j, supported in runs((strongest[a:b, state] >= .40).astype(int)):
            if not supported and (j - i) / fps >= .4:
                path[a+i:a+j] = k
    return path


def map_audio(raw, final, raw_duration, final_duration, fps, upper_band=None):
    if not 1 <= fps <= 240 or min(raw_duration, final_duration) <= 0:
        raise ValueError('Provide recordings with positive durations and a valid final frame rate.')
    offsets = find_offsets(raw, final)
    # Keep the fractional last frame on the final clock. AAC tracks can extend past the picture.
    times = np.arange(0., final_duration, 1 / fps)
    times = np.r_[times[times < final_duration - 1 / RATE], final_duration]
    edges = np.rint(times * RATE).astype(int)
    if len(edges) < 2 or edges[-1] == 0:
        raise ValueError('The finished edit is shorter than one audio sample.')
    final = np.pad(final[:edges[-1]], (0, max(0, edges[-1] - len(final))))
    power = np.add.reduceat(final * final, edges[:-1])
    scores = np.empty((len(times) - 1, len(offsets)), dtype=np.float32)
    for i, lag in enumerate(offsets):
        scores[:, i] = frame_correlation(raw, final, edges, lag, power)
    path = choose_path(scores, fps)
    strongest = scores
    if upper_band is not None and offsets:
        # Preserve ambiguity between duplicate takes measured in the full source search.
        original = scores.copy()
        strongest = high_band_evidence(*upper_band(), times, scores, offsets, path)
        path = choose_path(scores, fps)
    else:
        original = scores
    parts = runs(reject_unverified(path, original, strongest, fps))
    segments, unknown, joins = [], [], []
    for a, b, state in parts:
        interval = {'finalStart': float(times[a]), 'finalEnd': float(times[b])}
        if state == len(offsets):
            unknown.append(interval)
            continue
        lag = offsets[state] / RATE
        segments.append({**interval, 'rawStart': max(0., times[a] + lag),
                         'rawEnd': min(raw_duration, times[b] + lag),
                         'correlationMedian': float(np.median(scores[a:b, state]))})
    for (a, i, left), (_, b, right) in zip(parts, parts[1:]):
        if max(left, right) == len(offsets):
            continue
        # Moving the boundary across a quiet frame often gives an equally good fit.
        diff = scores[a:b, left] - scores[a:b, right]
        objective = np.r_[0., np.cumsum(diff)]
        plausible = np.flatnonzero(objective >= objective[i-a] - .5)
        joins.append({'finalTime': times[i], 'rawOut': times[i] + offsets[left] / RATE,
                      'rawIn': times[i] + offsets[right] / RATE, 'earliestFinal': times[a+plausible[0]],
                      'latestFinal': times[a+plausible[-1]]})
    kept = []
    for start, end in sorted((s['rawStart'], s['rawEnd']) for s in segments):
        if kept and start <= kept[-1][1]:
            kept[-1][1] = max(end, kept[-1][1])
        else:
            kept.append([start, end])
    # Unknown finished audio might have come from any source passage. Only a full map labels removals.
    removed = []
    if not unknown:
        ends = [0.] + [end for _, end in kept]
        starts = [start for start, _ in kept] + [raw_duration]
        removed = [[a, b] for a, b in zip(ends, starts) if b > a]
    return {'schema': 1, 'rawDuration': raw_duration, 'finalDuration': final_duration, 'frameRate': fps,
            'mappedFraction': sum(s['finalEnd'] - s['finalStart'] for s in segments) / final_duration,
            'segments': segments, 'joins': joins, 'keptSource': kept,
            'unmappedFinal': unknown, 'removedSource': None if unknown else removed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('raw', type=Path)
    parser.add_argument('final', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='Private JSON path outside the checkout')
    parser.add_argument('--raw-track', type=int, default=0, help='Zero-based audio stream in raw file')
    parser.add_argument('--final-track', type=int, default=0, help='Zero-based audio stream in finished edit')
    args = parser.parse_args()
    output = args.output.resolve()
    if Path(__file__).resolve().parents[2] in output.parents:
        parser.error('Choose a private output path outside the Scarlet checkout.')
    if output in (args.raw.resolve(), args.final.resolve()):
        parser.error('Choose an output path distinct from both inputs.')
    raw, raw_duration, _, raw_delay = decode(args.raw, args.raw_track)
    final, final_duration, fps, final_delay = decode(args.final, args.final_track)

    def upper_band():
        band = 'highpass=f=1500,lowpass=f=5300'
        return (soundtrack(args.raw, args.raw_track, HIGH_RATE, band, raw_delay),
                soundtrack(args.final, args.final_track, HIGH_RATE, band, final_delay))

    result = map_audio(raw, final, raw_duration, final_duration, fps, upper_band)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=output.parent, delete=False) as draft:
        temp = Path(draft.name)
        try:
            json.dump(result, draft, indent=2, allow_nan=False)
            draft.write('\n')
            draft.close()
            os.replace(temp, output)
        finally:
            temp.unlink(missing_ok=True)
    print(f"Mapped {result['mappedFraction']:.1%} of the finished edit in {len(result['segments'])} spans. {output}")
    if result['unmappedFinal']:
        parser.exit(2, 'Incomplete reference. Inspect unmappedFinal before using this pair for scoring.\n')


if __name__ == '__main__':
    main()
