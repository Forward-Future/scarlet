// Run against a private native-playback fixture. The fixture engine creates its own token.
// node apps/server/scripts/bench-playback-cache-load.mjs --fixture <new-trial-root>
//   --ready <native-ready.json> --mode idle|pressure|warm [--seconds 600] [--until-complete]
// Warm prepares a fully seeded full edit and validates the resulting media response.
// A stop-cache-monitor file in this trial root ends the observation and pauses its workers.
// The JSONL records wall times so overlapping native input and presentation windows can be checked.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

const { values: v } = parseArgs({ options: {
  fixture: { type: "string" }, ready: { type: "string" }, mode: { type: "string" },
  seconds: { type: "string", default: "600" }, "until-complete": { type: "boolean" },
} });
assert(v.fixture && v.ready && ["idle", "pressure", "warm"].includes(v.mode));
const seconds = Number(v.seconds);
assert(Number.isFinite(seconds) && seconds > 0);
const root = await realpath(v.fixture), data = await realpath(join(root, "data"));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
assert(await realpath(manifest.data) === data && manifest.cache.pausedInitially && (v.mode !== "pressure" || manifest.cache.target));
assert(!existsSync(join(root, "stop-cache-monitor")), "Select a fresh trial.");
const ready = JSON.parse(await readFile(v.ready, "utf8")), origin = new URL(ready.apiOrigin);
assert(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname) && !origin.username && !origin.password);
const token = (await readFile(join(data, "access-token"), "utf8")).trim();
assert(/^sct_[a-f0-9]{64}$/.test(token), "Unexpected fixture token format");
const db = new DatabaseSync(join(data, "scarlet.db"), { readOnly: true });
db.exec("PRAGMA query_only=ON");
const claim = db.prepare("SELECT worker_pid FROM source_cache_requests WHERE media_id=?");
const task = (path, method = "GET", body) => fetch(new URL("/api" + path, origin), {
  method, redirect: "error", signal: AbortSignal.timeout(5000),
  headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async response => {
  if (!response.ok) throw new Error(method + " " + path + " returned " + response.status);
  return response.json();
});
const monitorTarget = manifest.cache.target ?? manifest.cache.proxyReady[0];
assert(monitorTarget, "No cached or uncached video source to monitor");
const projectPath = "/projects/" + encodeURIComponent(manifest.projectId);
const sourcePath = id => "/media/" + encodeURIComponent(id) + "/playback-cache";
const project = (await task(projectPath + "?view=workspace")).project;
assert(project.id === manifest.projectId && project.head === manifest.version && project.name === "Native playback fixture" && project.mediaPaused === true,
  "This engine must have the pristine disposable project open with background work paused.");
const videos = manifest.assets.filter(a => a.kind ? a.kind === "video" : a.fps > 0);
for (const asset of videos) {
  const { state } = await task(sourcePath(asset.id));
  assert.equal(state, manifest.cache.proxyReady.includes(asset.id) ? "ready" : "uncached", "Source did not match the seed manifest");
}

const run = promisify(execFile);
async function encoderStats(roots) {
  if (process.platform === "win32") return null; // Progress and worker ownership are still sampled.
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,%cpu=,nice=,comm="]);
  const rows = stdout.split("\n").flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(-?\d+)\s+(.+)$/.exec(line);
    return m ? [{ id: Number(m[1]), parent: Number(m[2]), cpu: Number(m[3]), nice: Number(m[4]), name: basename(m[5]) }] : [];
  });
  const parents = new Map(rows.map(row => [row.id, row.parent]));
  const owned = rows.filter(row => {
    if (!/^(?:scarlet-)?ffmpeg(?:-.+)?$/i.test(row.name)) return false;
    for (let pid = row.parent; pid > 1; pid = parents.get(pid)) if (roots.has(pid)) return true;
    return false;
  });
  const outputs = { sourceProxies: 0, editSegments: 0, renderFiles: 0, other: 0 };
  const priorities = {};
  if (owned.length) {
    const priorityByPid = new Map(owned.map(row => [row.id, row.nice]));
    // Inspect only these fixture descendants. Keep media names and complete command lines out of the log.
    const detail = await run("ps", ["-ww", "-p", owned.map(row => row.id).join(","), "-o", "pid=,command="])
      .catch(error => { if (error.code === 1) return { stdout: error.stdout ?? "" }; throw error; });
    for (const line of detail.stdout.split("\n").filter(Boolean)) {
      const output = /\/(proxies|segments|renders)\/[^\s]+\.mp4\s*$/.exec(line)?.[1];
      const role = ({ proxies: "sourceProxies", segments: "editSegments", renders: "renderFiles" })[output] ?? "other";
      outputs[role]++;
      const nice = priorityByPid.get(Number(line.trim().split(/\s+/, 1)[0]));
      if (nice !== undefined && !(priorities[role] ??= []).includes(nice)) priorities[role].push(nice);
    }
  }
  return { processes: owned.length, cpuPercent: Math.round(owned.reduce((n, row) => n + row.cpu, 0)), outputs, priorities };
}

const file = await open(join(root, v.mode === "warm" ? "prepare-warm.jsonl" : "cache-load.jsonl"), "wx", 0o600);
const log = async obj => { await file.write(JSON.stringify({ wallMs: Date.now(), ...obj }) + "\n"); };
let paused = false, renderId, stopping = false, finished = false;
const pressure = v.mode === "pressure", warm = v.mode === "warm";
if (warm) assert(!manifest.cache.target && manifest.cache.segments > 0, "Warm control requires all source proxies and segment seeds");
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
try {
  await log({ event: "start", mode: v.mode, sourceCount: manifest.assets.length, seededProxies: manifest.cache.proxyReady.length, seededSegments: manifest.cache.segments });
  if (pressure || warm) {
    paused = true; // Always return the trial to its paused state, even after a failed request.
    await task(projectPath, "PATCH", { mediaPaused: false });
    if (pressure) assert.equal((await task(sourcePath(monitorTarget), "POST")).state, "caching");
    // Desktop auto-cache uses an owner so interactive playback can preempt the full-cut encoder.
    const { render } = await task(projectPath + "/renders", "POST", { kind: "full", version: manifest.version, quality: "preview", owner: randomUUID() });
    assert(render.id && (["queued", "running"].includes(render.state) || (warm && render.state === "done")),
      "Expected an uncached full edit");
    renderId = render.id;
  }
  const start = performance.now();
  let previousRanges = "";
  do {
    const [sources, response] = await Promise.all([
      Promise.all(videos.map(asset => task(sourcePath(asset.id)))),
      renderId ? task("/renders/" + encodeURIComponent(renderId)) : Promise.resolve(null),
    ]);
    const source = sources[videos.findIndex(asset => asset.id === monitorTarget)];
    const sourcePid = claim.get(monitorTarget)?.worker_pid, render = response?.render;
    const roots = new Set([ready.nativePid, sourcePid, render?.queuePid].filter(Boolean));
    const encoders = await encoderStats(roots);
    const state = { event: "sample", elapsedMs: Math.round(performance.now() - start), source: source.state,
      sourceProgress: source.progress ?? null, sources: sources.map(s => ({ state: s.state, progress: s.progress ?? null })), claimed: !!sourcePid, fullEdit: render?.state ?? null,
      fullEditProgress: render?.progress ?? null,
      completedSeconds: render?.cachedRanges?.reduce((n, r) => n + r.end - r.start, 0) ?? null, encoders };
    if (render?.cachedRanges) {
      const ranges = render.cachedRanges.map(r => [r.start, r.end]);
      const signature = JSON.stringify(ranges);
      if (signature !== previousRanges) state.completedRanges = ranges;
      previousRanges = signature;
    }
    await log(state);
    if (state.elapsedMs < 1000) console.log(JSON.stringify({ event: "observing", sample: state }));
    if ((render && ["failed", "cancelled"].includes(render.state)) || sources.some(s => s.state === "failed")) throw new Error("Cache workload failed");
    finished = source.state === "ready" && !sources.some(s => s.state === "caching") && render?.state === "done";
    if (finished && warm) {
      const info = await task("/renders/" + encodeURIComponent(render.id) + "?inspectFile=true");
      const response = await fetch(new URL("/api/renders/" + encodeURIComponent(render.id) + "/file", origin), {
        headers: { Authorization: "Bearer " + token, Range: "bytes=0-511" }, redirect: "error", signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 206);
      assert.equal((await response.arrayBuffer()).byteLength, 512);
      // Container duration can include an AAC priming packet beyond the frame-snapped picture.
      const pictureDuration = Math.round(manifest.duration * manifest.settings.fps) / manifest.settings.fps;
      assert(Math.abs(info.fileInfo.duration - pictureDuration) <= 1024 / manifest.settings.sampleRate + 0.002);
      const verified = { height: info.fileInfo.height, duration: info.fileInfo.duration, contentRange: response.headers.get("content-range") };
      await log({ event: "fileVerified", ...verified });
      manifest.cache.finishedRenders = 1;
      manifest.cache.completedFile = verified;
      const next = join(root, "manifest." + randomUUID() + ".tmp");
      await writeFile(next, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(next, join(root, "manifest.json"));
    }
    if (finished || stopping || existsSync(join(root, "stop-cache-monitor"))) break;
    await sleep(1000);
  } while (performance.now() - start < seconds * 1000);
  if (warm || v["until-complete"]) assert(finished, "Cache observation ended before both workers completed");
} finally {
  try {
    if (paused) await task(projectPath, "PATCH", { mediaPaused: true });
    await log({ event: "end", finished });
  } finally { await file.close(); db.close(); }
}
