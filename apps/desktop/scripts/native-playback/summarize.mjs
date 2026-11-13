// Summarize one or two matched native runs. A timeout is right-censored, so
// it must stay in the denominator even when no matching picture was observed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { positionals:paths, values } = parseArgs({ allowPositionals:true, options:{ manifest:{type:"string"} } });
assert(paths.length === 1 || paths.length === 2, "Supply a native run, optionally followed by its matched rerun.");
const savedCuts = values.manifest ? JSON.parse(await readFile(values.manifest, "utf8")).cutTimes : undefined;
const runs = await Promise.all(paths.map(async path => {
  const report = JSON.parse(await readFile(path, "utf8"));
  const result = report.results ?? report.result ?? report;
  return { ...result, timelineCuts:savedCuts ?? result.timelineCuts, inputFailures:report.inputFailures?.length ?? 0 };
}));
const round = value => value === null ? null : Math.round(value * 10) / 10;
function percentile(values, p) {
  if (!values.length) return null;
  return round([...values].sort((a,b) => a-b)[Math.ceil(p*values.length)-1]);
}
function durations(rows) {
  const completed = rows.filter(r => Number.isFinite(r.latencyMs));
  const lower = rows.map(r => r.latencyMs ?? r.timeoutMs);
  const upper = rows.map(r => r.latencyMs ?? Infinity);
  const quantile = p => {
    const lo = percentile(lower,p), hi = percentile(upper,p);
    return lo === hi ? lo : { lowerBoundMs:lo, upperBoundMs:Number.isFinite(hi) ? hi : null };
  };
  return { attempts:rows.length, timeouts:rows.length-completed.length, p50Ms:quantile(.5), p95Ms:quantile(.95),
    videoFrames:completed.filter(r => r.endpoint === "video" || r.endpoint === "videoCallback").length,
    observedAtCallback:completed.filter(r => r.endpoint === "videoCallback").length,
    stillPaintEstimates:completed.filter(r => ["stillPaintEstimate","stillPaintUpperBound"].includes(r.endpoint)).length };
}
function drops(rows) {
  // Keep measured counters from interrupted windows. Excluding them would
  // preferentially discard the most starved playback attempts.
  const valid = rows.filter(r => r.total > 0 && r.dropped !== null && r.dropped <= r.total);
  const count = key => valid.reduce((sum,r) => sum+r[key],0);
  const total = count("total"), dropped = count("dropped");
  return {validWindows:valid.length, finished:rows.filter(r=>r.finished).length, attemptedWindows:rows.length, total, dropped,
    droppedPercent:total ? +(100*dropped/total).toFixed(3) : null};
}
function stationaryWaits(windows, cuts, fps) {
  const waits = [], unfinished = [];
  for (const w of windows) {
    if (!Number.isFinite(w.firstPlaybackFrameMs)) continue;
    let started = false, waiting;
    for (const event of w.waits ?? []) {
      if (event.event === "waiting" && started && event.wall >= w.firstPlaybackFrameMs) waiting ??= event;
      if (event.event !== "playing") continue;
      if (waiting && Math.abs(event.media-waiting.media) <= 1/fps) {
        waits.push({ms:event.wall-waiting.wall, nearCut:cuts.some(t=>Math.abs(t-waiting.media) <= 0.15)});
      }
      started = true;
      waiting = undefined;
    }
    if (waiting && w.wallEnd >= w.wallStart + waiting.wall) unfinished.push(w.wallEnd-w.wallStart-waiting.wall);
  }
  return { count:waits.length, totalMs:round(waits.reduce((n,w)=>n+w.ms,0)), maxMs:waits.length ? round(Math.max(...waits.map(w=>w.ms))) : null,
    nearKnownCut:waits.filter(w=>w.nearCut).length, openWaitEvents:unfinished.length, maxOpenWaitAgeMs:unfinished.length ? round(Math.max(...unfinished)) : null };
}
function summary(r) {
  const gaps = r.cuts.flatMap(c => c.consecutive && c.excessMs !== null ? [c.excessMs] : []);
  const windows = [...r.cuts,...(r.sustained ?? [])];
  const starts = windows.flatMap(w=>Number.isFinite(w.firstPlaybackFrameMs) ? [w.firstPlaybackFrameMs] : []);
  const delays = windows.flatMap(w=>Number.isFinite(w.worstFrameGapMs) ? [w.worstFrameGapMs] : []);
  const active = r.cacheSamples.filter(entry => entry.sources.length && entry.sources.some(s => s.state === "caching"));
  return {fps:r.fps, documentHidden:r.hidden, animationFrameP50Ms:percentile(r.animationIntervalsMs ?? [],.5), input:r.pointerInput, driverInputFailures:r.inputFailures,
    cacheSamples:r.cacheSamples.length, sourceCacheActiveSamples:active.length, scrubs:durations(r.scrub),
    cuts:{attempts:r.cuts.length, crossed:r.cuts.filter(c=>c.crossed).length, observed:gaps.length, unobserved:r.cuts.length-gaps.length,
      observedExcessP50Ms:percentile(gaps,.5), observedExcessP95Ms:percentile(gaps,.95),
      overOneExtraFrame:gaps.filter(ms => ms>1000/r.fps).length},
    playback:{started:starts.length, attempts:windows.length, playToFirstFrameP95Ms:percentile(starts,.95),
      worstObservedGapMs:delays.length ? round(Math.max(...delays)) : null, stationaryWaits:stationaryWaits(windows,r.timelineCuts ?? r.cuts.map(c=>c.cut),r.fps)}, cutWindowDrops:drops(r.cuts), sustainedDrops:drops(r.sustained ?? [])};
}
const result = { runs:runs.map(summary) };
if (runs.length === 2) {
  const [before,after] = runs;
  assert.equal(before.fps,after.fps);
  assert.deepEqual(before.scrub.map(r=>r.requested), after.scrub.map(r=>r.requested), "Scrub schedules differ");
  assert.deepEqual(before.cuts.map(r=>r.cut), after.cuts.map(r=>r.cut), "Cut schedules differ");
  assert.deepEqual(before.scrub.map(r=>r.timeoutMs),after.scrub.map(r=>r.timeoutMs),"Scrub deadlines differ");
  const ranked = before.scrub.flatMap((r,i)=>Number.isFinite(r.latencyMs) ? [{i,ms:r.latencyMs}] : []).sort((a,b)=>b.ms-a.ms);
  const selected = ranked.slice(0,Math.ceil(ranked.length*.05)).map(v=>v.i);
  result.slowestCompletedBaselineTargets = { baselineHadTimeouts:ranked.length !== before.scrub.length, before:durations(selected.map(i=>before.scrub[i])), after:durations(selected.map(i=>after.scrub[i])) };
  result.matchedDeadlines = [...new Set(before.scrub.map(r=>r.timeoutMs))].map(timeoutMs=>({timeoutMs,
    before:durations(before.scrub.filter(r=>r.timeoutMs===timeoutMs)), after:durations(after.scrub.filter(r=>r.timeoutMs===timeoutMs))}));
}
console.log(JSON.stringify(result,null,2));
