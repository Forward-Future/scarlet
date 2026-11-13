#!/usr/bin/env python3
"""Run repeatable real-project measurements in an already-running private macOS preview.

The independent cache workload and private-window pixel sampler should already be
running for a heavy trial. No source asset or access token is included in reports.
"""
import argparse
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys

HERE=Path(__file__).resolve().parent


def save(path,data):
    staged=path.with_suffix(".new")
    staged.write_text(json.dumps(data))
    staged.replace(path)


def workload(m,cut_count,play_seconds,scrub_count,cut_repeats):
    cuts=[x for x in m["cutTimes"] if 5 < x < m["duration"]-5]
    if len(m["cutTimes"])<=cut_count:
        cuts=[x for x in m["cutTimes"] if .15 < x < m["duration"]-.65]
    targets=random.Random(78534).sample(cuts,min(cut_count,len(cuts)))
    targets*=cut_repeats
    scrubs=m["scrubTimes"][:scrub_count]
    sustained=[{"start":min(x,m["duration"]-play_seconds-1),"seconds":play_seconds} for x in [60,700] if m["duration"]>play_seconds+1]
    jobs=[]
    def add(key,values,size):
        for i in range(0,len(values),size):
            jobs.append((key,values[i:i+size]))
    add("cutTimes",targets[:3],1)
    add("playWindows",sustained[:1],1)
    add("scrubTimes",scrubs,8)
    add("cutTimes",targets[3:],3)
    add("playWindows",sustained[1:],1)
    return jobs


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("scratch",type=Path)
    p.add_argument("manifest",type=Path)
    p.add_argument("--output",type=Path,required=True)
    p.add_argument("--resume",action="store_true",help="Resume this exact plan in its original running native window.")
    p.add_argument("--match",type=Path,help="Use a prior suite's measurement script, job order and per-job deadlines.")
    p.add_argument("--schedule",type=Path,help="Use a preregistered native input schedule for this saved edit.")
    p.add_argument("--cuts",type=int,default=24)
    p.add_argument("--cut-repeats",type=int,default=1)
    p.add_argument("--scrubs",type=int,default=64)
    p.add_argument("--seconds",type=float,default=12)
    p.add_argument("--timeout-ms",type=int,default=5500)
    p.add_argument("--scrub-timeout-ms",type=int,default=12000)
    args=p.parse_args()
    out=args.output.resolve();out.mkdir(mode=0o700,parents=True,exist_ok=True)
    if any(out.iterdir()) and not args.resume:raise ValueError("Use a fresh report directory")
    m=json.loads(args.manifest.read_text())
    data=Path(m["data"]).resolve()
    ready=json.loads((args.scratch/"ready.json").read_text())
    if ready["path"]!="/p/"+m["projectId"]:raise ValueError("Native editor loaded a different project")
    media_id=m["cache"]["target"] or next(iter(m["cache"]["proxyReady"]),None)
    template=dict(projectId=m["projectId"],fps=m["settings"]["fps"],width=m["settings"]["width"],height=m["settings"]["height"],
                  expectedDataDir=str(data),cacheMediaIds=[media_id] if media_id else [],timelineCuts=m["cutTimes"],
                  scrubTimes=[],cutTimes=[],playWindows=[],timeoutMs=args.timeout_ms)
    jobs=workload(m,args.cuts,args.seconds,args.scrubs,args.cut_repeats)
    if args.schedule:
        schedule=json.loads(args.schedule.read_text())
        if schedule["projectId"]!=m["projectId"] or schedule["version"]!=m["version"]:
            raise ValueError("Input schedule belongs to a different saved edit")
        jobs=schedule["jobs"]
    if args.match:
        reference=json.loads((args.match/"plan.json").read_text())
        source_manifest=json.loads((args.match.parent/"manifest.json").read_text())
        if (source_manifest["version"]!=m["version"] or source_manifest["settings"]!=m["settings"] or
            reference["template"]["projectId"]!=m["projectId"]):
            raise ValueError("Reference workload does not match this saved edit")
        jobs=reference["jobs"]
    if args.resume:
        plan=json.loads((out/"plan.json").read_text())
        old=json.loads((out/"combined.json").read_text())
        if (plan["template"]["expectedDataDir"]!=str(data)
            or old["surface"]["nativePid"]!=ready["nativePid"]):
            raise ValueError("Fixture, window or native plan changed")
        jobs=plan["jobs"]
    else:save(out/"plan.json",dict(template=template,jobs=jobs))
    source=out/"measure.js"
    if not args.resume:shutil.copyfile((args.match or HERE)/"measure.js",source)
    cmd=[sys.executable,"-B",str(HERE/"macos.py"),"run",str(args.scratch)]
    combined=None; errors=[]
    for index,(key,targets) in enumerate(jobs):
        # Preserve all completed samples even if WebKit can't deliver one input.
        left=targets[:]; attempt=0
        field={"scrubTimes":"scrub","cutTimes":"cuts","playWindows":"sustained"}[key]
        while left:
            tag=f"{index:02}-{key}-{attempt:02}"
            config=out/(tag+".json"); raw=out/(tag+"-results.json")
            previous=args.resume and raw.exists()
            if not previous:
                timeout=args.scrub_timeout_ms if key=="scrubTimes" else args.timeout_ms
                if args.match:timeout=json.loads((args.match/f"{index:02}-{key}-00.json").read_text())["timeoutMs"]
                save(config,{**template,key:left,"timeoutMs":timeout})
                subprocess.run(cmd+[str(config),str(raw),"--measure",str(source),"--timeout","180"])
            wrapper=json.loads(raw.read_text()) if raw.exists() else {}
            res=wrapper.get("results")
            n=len(res[field]) if res else 0
            if res:
                if combined is None:combined={**res,"scrub":[],"cuts":[],"sustained":[],"cacheSamples":[]}
                for f in ["scrub","cuts","sustained","cacheSamples"]:
                    combined[f].extend({**row,"timeOrigin":res["timeOrigin"]} for row in res[f])
            if not raw.exists() or wrapper.get("incomplete"):
                reason=wrapper.get("error","Native surface did not return a result")
                if n>=len(left) or "Native slider did not receive trusted" not in reason:raise RuntimeError(reason)
                errors.append({"stage":field,"target":left[n],"error":reason})
                left=left[n+1:]
                if len(errors)>3:raise RuntimeError("Multiple native inputs missed; capture retained for diagnosis")
                reset=out/(tag+"-reset.json")
                if not previous:subprocess.run(cmd+[str(config),str(reset),"--measure",str(HERE/"release-pointer.js"),"--timeout","10"],check=True)
            else:left=[]
            if combined is not None:
                save(out/"combined.json",{"surface":ready,"results":combined,"inputFailures":errors})
            print(f"{tag} complete: {n} {field}, {len(errors)} missed inputs",flush=True)
            attempt+=1


if __name__=="__main__":main()
