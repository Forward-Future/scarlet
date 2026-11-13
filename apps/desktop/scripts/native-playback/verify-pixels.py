#!/usr/bin/env python3
"""Match target-only ScreenCaptureKit samples to the exact versioned monitor JPEG.

Use after timing a native trial while its isolated engine is still running. The
reference requests and offline image comparison do not affect native measurements.
Requires the native ready file, the trial's manifest, results (a suite/ folder or
individual results), geometry probe and window-samples.txt.
"""
import argparse
import json
import math
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
from urllib.parse import urlencode, urlsplit, quote
from urllib.request import Request, urlopen


def load(path):
    return json.loads(path.read_text())


def signature(image, window, grid, view, box, aspect, ffmpeg):
    # Render the reference at the capture stream's effective resolution before
    # sampling. This reproduces object-fit: contain and excludes letterboxing.
    ww, wh = window
    gw, gh = grid
    vw, vh = view
    w, h = box["width"] - 2, box["height"] - 2
    iw, ih = min(w, h * aspect), min(h, w / aspect)
    left, top = box["x"] + (box["width"] - iw) / 2, wh - vh + box["y"] + (box["height"] - ih) / 2
    sw, sh = round(iw * gw / ww), round(ih * gh / wh)
    rgb = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-threads", "1", "-i", "pipe:0", "-frames:v", "1",
                          "-vf", f"scale={sw}:{sh}:flags=area", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
                         input=image, stdout=subprocess.PIPE, check=True).stdout
    result = bytearray()
    for y in range(12):
        for x in range(20):
            cx = (math.floor((0.55 + 0.36*(x + .5)/20) * gw) + .5) * ww/gw
            cy = (math.floor((0.25 + 0.28*(y + .5)/12) * gh) + .5) * wh/gh
            ix, iy = math.floor((cx - left) / iw * sw), math.floor((cy - top) / ih * sh)
            if not (0 <= ix < sw and 0 <= iy < sh):
                raise ValueError("The sampling grid extends outside the actual target picture")
            i = 3*(iy*sw + ix)
            result.extend(rgb[i:i+3])
    return result


def errors(sample, ref):
    residual = [x-y for x,y in zip(sample, ref)]
    return sum(map(abs,residual))/len(residual)


def verified_stalls(report, cut_times, captures):
    stalls=[]
    fps=report["fps"]
    for field in ("cuts", "sustained"):
        for row in report[field]:
            played=False
            waiting=None
            first_frame=row.get("firstPlaybackFrameMs")
            epoch=row.get("timeOrigin",report["timeOrigin"])+row["wallStart"]
            events=[*row["waits"],{"event":"end","wall":row["wallEnd"]-row["wallStart"]}]
            for event in events:
                kind=event["event"]
                if kind=="waiting" and played and first_frame is not None and event["wall"] >= first_frame:
                    waiting=waiting or event
                if kind not in ("playing","end"):
                    continue
                if waiting is not None:
                    at=waiting["media"]
                    duration=event["wall"]-waiting["wall"]
                    # Trim one or two capture ticks from either edge so the stream can
                    # present the final held picture and the next moving picture.
                    pixels=[px for t,px in captures if epoch+waiting["wall"]+70 <= t <= epoch+event["wall"]-70]
                    nearest=min(cut_times,key=lambda cut:abs(cut-at)) if cut_times else None
                    stalls.append({"window":field,"target":row["cut"],"media":at,"durationMs":duration,
                                   "rightCensored":kind=="end","sameMediaOnResume":kind=="playing" and abs(event["media"]-at)<1/fps,
                                   "savedCutOffsetSeconds":None if nearest is None else at-nearest,
                                   "nativeSamples":len(pixels),"identicalNativePixels":len(pixels)>=3 and len(set(pixels))==1})
                    waiting=None
                if kind=="playing":played=True
    return stalls


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("trial", type=Path)
    p.add_argument("ready", type=Path)
    p.add_argument("--limit", type=int)
    p.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "/Applications/Scarlet.app/Contents/MacOS/ffmpeg")
    args = p.parse_args()
    trial, ready = args.trial.resolve(), load(args.ready)
    if "/private/tmp/" not in str(trial) and "/tmp/" not in str(trial):
        raise ValueError("Expected a disposable trial")
    manifest = load(trial / "manifest.json")
    if Path(manifest["data"]).resolve() != (trial / "data").resolve():
        raise ValueError("Private trial and library differ")
    origin = urlsplit(ready["apiOrigin"])
    if origin.scheme != "http" or origin.hostname != "127.0.0.1" or not ready.get("underDesktop") or not ready.get("muted"):
        raise ValueError("Use only a muted isolated loopback benchmark")
    combined = trial/"suite"/"combined.json"
    if combined.exists():
        first = load(combined)["results"]
        geom = {"timeOrigin":first["timeOrigin"], "viewport":first["viewport"], "monitor":first["monitorRect"]}
    else:
        geom = load(trial / "geometry.json")["results"]
    text = (trial / "window-samples.txt").read_text().splitlines()
    header = text.pop(0).split()
    ww, wh = map(float,header[2:4])
    gw, gh = map(int,header[5:7])
    captures = [(float(parts[0]), bytes.fromhex(parts[2])) for row in text if len(parts := row.split()) == 3]
    files = [combined] if combined.exists() else sorted((trial/"suite").glob("scrubTimes-*-results.json"))
    records = []
    for f in files:
        records.extend(load(f)["results"]["scrub"])
    if args.limit is not None:
        records = records[:args.limit]
    token = (trial / "data/access-token").read_text().strip()
    s, epoch = manifest["settings"], geom["timeOrigin"]
    report = []
    for r in records:
        row_epoch = r.get("timeOrigin", epoch)
        start, end = row_epoch+r["wallStart"], row_epoch+r["wallEnd"]
        relevant = [(ts, sample) for ts,sample in captures if start-250 <= ts <= end+110]
        if not relevant: continue
        base = f'{ready["apiOrigin"]}/api/projects/{quote(manifest["projectId"])}/versions/{quote(manifest["version"])}/frame'
        q = urlencode(dict(frame=r["frame"], view="monitor", format=f'{s["width"]}x{s["height"]}@{s["fps"]}'))
        net = Request(base+"?"+q, headers={"Authorization":"Bearer "+token})
        with urlopen(net, timeout=20) as response:
            if response.headers.get_content_type() != "image/jpeg":
                raise ValueError("Expected a composed JPEG")
            reference = response.read()
        sig = signature(reference, (ww,wh),(gw,gh),geom["viewport"],geom["monitor"],s["width"]/s["height"],args.ffmpeg)
        diffs=[(ts-start, errors(sample,sig)) for ts,sample in relevant]
        before=next((errors(sample,sig) for ts,sample in reversed(captures) if ts < start),None)
        post=[d for d in diffs if d[0] >= 0]
        if not post: continue
        best=min(post,key=lambda d:d[1])
        # Require both a close RGB match and an independently distinguishable
        # transition from the pixels preceding this seek.
        identified = (r["endpoint"] in ("video", "videoCallback") or
                      (str(r["frame"]) == r.get("stillFrame") and r.get("stillOpacity") == "1"))
        match=next((d for d in post if identified and d[1] <= 13 and before is not None and before >= d[1]+5),None)
        report.append(dict(frame=r["frame"],inputToPaintUpperMs=r["latencyMs"],nativePixelMs=round(match[0],1) if match else None,
                       bestMAE=round(best[1],2),priorMAE=round(before,2) if before is not None else None,
                       identifiedTarget=identified,captureCount=len(post)))
    (trial/"pixel-verification.json").write_text(json.dumps(report,indent=2))
    good=[r["nativePixelMs"] for r in report if r["nativePixelMs"] is not None]
    pixels={r["frame"]:r["nativePixelMs"] for r in report if r["nativePixelMs"] is not None}
    native=[pixels[r["frame"]] if r["frame"] in pixels else r["latencyMs"] for r in records
            if r["frame"] in pixels or r["endpoint"] in ("video","videoCallback")]
    def p95(values):
        return sorted(values)[math.ceil(.95*len(values))-1] if values else None
    summary={"requested":len(records),"compared":len(report),"distinctPixelMatches":len(good),
             "matchingStillPaints":sum(r["frame"] in pixels and r["endpoint"] in ("stillPaintUpperBound","stillPaintEstimate") for r in records),
             "nativeFrameOrPixelMatches":len(native),"nativeVerifiedP50Ms":statistics.median(native) if native else None,
             "nativeVerifiedP95Ms":p95(native),"pixelMatchesP50Ms":statistics.median(good) if good else None,
             "pixelMatchesP95Ms":p95(good)}
    (trial/"pixel-summary.json").write_text(json.dumps(summary,indent=2))
    if combined.exists():
        stalls=verified_stalls(first, manifest["cutTimes"], captures)
        (trial/"post-start-stalls.json").write_text(json.dumps(stalls,indent=2))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
