#!/usr/bin/env python3
"""Verify presenter cuts against published pixels around audio-nominated joins (OpenCV, NumPy, FFmpeg)."""
import argparse
from functools import lru_cache
import json
from pathlib import Path
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare import encoded, private_path, sha, verify_reference_recordings

W, H = 80, 46


def probe_frames(movie, cache, key, hwaccel=None):
    # Probe packets in presentation order. Packet timestamps avoid decoding a 4K source a second time.
    data = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_packets",
                                    "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(movie)], text=True)
    pts = np.array(sorted(float(line.split(",")[0]) for line in data.splitlines() if line.split(",")[0].strip()))
    # The audio alignment uses seconds relative to the start of the container, even with a delayed video stream.
    origin = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=start_time",
                                      "-of", "default=nw=1:nk=1", str(movie)], text=True).strip()
    pts -= float(origin)
    raw = cache / (key + "-80x46.gray")
    receipt = raw.with_suffix(".sha256")
    source_hash = sha(movie)
    if not (raw.is_file() and receipt.is_file() and receipt.read_text().strip() == source_hash):
        if raw.exists() and not receipt.is_file():
            # A partially written cache cannot be a reference.
            raise ValueError(f"Unverified cache file {raw}. Choose an empty cache directory.")
        temp = raw.with_suffix(".partial")
        with temp.open("xb") as f:
            try:
                accel = ["-hwaccel", hwaccel] if hwaccel else []
                subprocess.run(["ffmpeg", "-v", "error", "-nostdin", *accel, "-threads", "2", "-i", str(movie),
                                "-map", "0:v:0", "-an", "-vf", f"scale={W}:{H}:flags=area,format=gray",
                                "-fps_mode", "passthrough", "-threads", "1", "-f", "rawvideo", "-"], stdout=f, check=True)
                if f.tell() != len(pts) * W * H:
                    raise ValueError("Source packet PTS and decoded picture count differ.")
            except BaseException:
                f.close()
                temp.unlink(missing_ok=True)
                raise
        temp.replace(raw)
        receipt.write_text(source_hash + "\n")
    if raw.stat().st_size != len(pts) * W * H or len(pts) < 2 or np.any(np.diff(pts) <= 0):
        raise ValueError("A unique presentation timestamp is required for every decoded picture.")
    return pts, np.memmap(raw, dtype=np.uint8, mode="r", shape=(len(pts), H, W)), source_hash


def camera_crop(source, published, rect):
    """Fit the camera's scale and translation on a separate frame, before testing cut pictures."""
    height, width = published.shape
    x, y, w, h = rect
    x0, x1 = round(width * (x + .12 * w)), round(width * (x + .88 * w))
    y0, y1 = round(height * (y + .12 * h)), round(height * (y + .88 * h))
    template = published[y0:y1, x0:x1].copy()
    rows, cols = template.shape
    best = None
    for scale in np.geomspace(.44 / h, 1.1 / h, 26):
        for aspect in (.94, 1., 1.06):
            dw, dh = round(cols * scale * aspect), round(rows * scale)
            if not (6 <= dw <= width and 6 <= dh <= height):
                continue
            resized = cv2.resize(template, (dw, dh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
            scores = cv2.matchTemplate(source, resized, cv2.TM_CCOEFF_NORMED)
            _, score, _, (tx, ty) = cv2.minMaxLoc(scores)
            if best is None or score > best[0]:
                sx, sy = dw / cols, dh / rows
                best = score, np.float32([[sx, 0, tx + (sx - 1) * .5], [0, sy, ty + (sy - 1) * .5]])
    if best is None or best[0] < .83:
        return None
    transform = best[1].copy()
    try:
        _, transform = cv2.findTransformECC(template, source, transform, cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 1e-6), None, 1)
    except cv2.error:
        transform = best[1]
    if abs(transform[0, 1]) + abs(transform[1, 0]) > .1 / h or np.max(np.abs(transform[:, :2] - best[1][:, :2])) > .18 / h:
        transform = best[1]
    yy, xx = np.indices(template.shape).astype("float32")
    mx = transform[0, 0] * xx + transform[0, 1] * yy + transform[0, 2]
    my = transform[1, 0] * xx + transform[1, 1] * yy + transform[1, 2]
    return (slice(y0, y1), slice(x0, x1)), mx, my, transform


def correlations(images, target):
    images = images - images.mean(axis=(-2, -1), keepdims=True)
    target = target - target.mean()
    return (images * target).sum(axis=(-2, -1)) / np.maximum(1e-7,
        np.sqrt((images ** 2).sum(axis=(-2, -1)) * (target ** 2).sum()))


def match_three(candidates, target, margin):
    # Score all possible three-frame runs, including offsets one frame away. Common scenery may
    # identify the shot. The movement between the pictures has to identify this exact sequence.
    spatial = np.stack([correlations(candidates[i:i + len(candidates) - 2], target[i]) for i in range(3)])
    motion = correlations(candidates[2:] - candidates[:-2], target[2] - target[0])
    if np.std(target[2] - target[0]) < .5:
        return None
    combined = spatial.mean(axis=0) + .1 * motion
    winner = int(combined.argmax())
    if winner in (0, len(combined) - 1):
        return None
    gap = float(combined[winner] - np.partition(combined, -2)[-2])
    least = float(spatial[:, winner].min())
    movement = float(motion[winner])
    if least < .96 or movement < .72 or gap < margin:
        return None
    return winner, least, movement, gap


def side_matches(source, final, source_pts, final_pts, center, offset, direction, layouts, margin):
    anchor = center + 12 * direction
    source_anchor = int(np.searchsorted(source_pts, final_pts[anchor] + offset))
    if not 0 <= source_anchor < len(source):
        return {}
    matches = {}
    for rect in layouts:
        geometry = camera_crop(source[source_anchor], final[anchor], rect)
        if geometry is None:
            continue
        region, mx, my, transform = geometry

        @lru_cache(maxsize=96)
        def sample(index):
            frame = source[index]
            if transform[1, 1] > 1.4:
                frame = cv2.GaussianBlur(frame, (0, 0), .4 * transform[1, 1])
            return cv2.remap(frame, mx, my, cv2.INTER_LINEAR).astype(np.float32)

        for k in range(center - 6, center + 7):
            first = k - 3 if direction < 0 else k
            estimate = int(np.searchsorted(source_pts, final_pts[first] + offset))
            start, end = estimate - 18, estimate + 21
            if start < 0 or end > len(source):
                continue
            found = match_three(np.stack([sample(i) for i in range(start, end)]),
                                final[first:first + 3, region[0], region[1]].astype(np.float32), margin)
            if found:
                index, spatial, motion, gap = found
                boundary = start + index + (2 if direction < 0 else 0)
                matches.setdefault(k, {})[boundary] = {"layout": list(rect), "spatial": spatial, "motion": motion,
                                                        "margin": gap, "transform": transform.tolist()}
    return matches


def verify(root, cache, insets=(), hwaccel=None, margin=.002):
    cv2.setNumThreads(1)
    cache.mkdir(parents=True, exist_ok=True)
    source_pts, source, source_hash = probe_frames(root / "media/presenter.mp4", cache, "presenter", hwaccel)
    final_pts, final, final_hash = probe_frames(root / "media/published.mp4", cache, "published", hwaccel)
    audio = json.loads((root / "reference-audio.json").read_bytes())
    verify_reference_recordings(audio, source_hash, final_hash)
    observations = []
    layouts = [(0, 0, 1, 1), *insets]
    for i, j in enumerate(audio["joins"]):
        center = int(np.searchsorted(final_pts, j["finalTime"]))
        if center < 12 or center + 12 >= len(final):
            continue
        left = side_matches(source, final, source_pts, final_pts, center, j["rawOut"] - j["finalTime"], -1, layouts, margin)
        right = side_matches(source, final, source_pts, final_pts, center, j["rawIn"] - j["finalTime"], 1, layouts, margin)
        pairs = [(k, [u, v], left[k][u], right[k][v]) for k in left.keys() & right.keys()
                 for u in left[k] for v in right[k] if u + 1 != v]
        if len(pairs) == 1:
            k, pair, outgoing, incoming = pairs[0]
            observations.append({"join": i, "publishedFrame": k, "publishedTime": float(final_pts[k]), "pair": pair, "outgoing": outgoing, "incoming": incoming})
    doc = {"sourceId": source_hash, "publishedSha256": final_hash, "sourceFrames": len(source_pts),
           "publishedFrames": len(final_pts), "referenceJoins": len(audio["joins"]), "minimumMargin": margin,
           "method": "A unique cut with three matching consecutive source pictures on each side. Both spatial detail and motion must match.",
           "pairs": [r["pair"] for r in observations], "observations": observations}
    (root / "pictures.json").write_bytes(encoded(doc))
    (root / "source-pts.json").write_bytes(encoded(source_pts.tolist()))
    print(f"Verified both pictures at {len(observations)}/{len(audio['joins'])} audio-nominated joins.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("episode", type=Path)
    p.add_argument("--cache", type=Path)
    p.add_argument("--inset", type=float, nargs=4, action="append", metavar=("X", "Y", "W", "H"),
                   help="Normalized published rectangle containing the cropped presenter")
    p.add_argument("--hwaccel", choices=["videotoolbox"], help="Optional hardware decoding during preparation")
    args = p.parse_args()
    root = private_path(args.episode)
    for x, y, w, h in args.inset or []:
        if not (0 <= x < x + w <= 1 and 0 <= y < y + h <= 1):
            p.error("Inset must lie inside the published frame.")
    verify(root, private_path(args.cache or root / "preparation/frames"), args.inset or [], args.hwaccel)
