// Time the engine's real committed-seek work under an independently verified cache load.
// node apps/server/scripts/bench-playback-pressure.mjs <fresh-fixture> <ready.json> <frame[,frame...]>
// Use equal disposable fixtures, source/auto full-cache jobs, and frame lists for each variant.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const [root, readyPath, frameList] = process.argv.slice(2);
assert(root && readyPath && frameList);
const m = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")), ready = JSON.parse(await readFile(readyPath, "utf8"));
const token = (await readFile(join(root, "data", "access-token"), "utf8")).trim();
const origin = new URL(ready.apiOrigin);
assert(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname) && /^sct_[a-f0-9]{64}$/.test(token));
const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
const project = "/api/projects/" + encodeURIComponent(m.projectId);
const request = (path, body) => fetch(new URL(path, origin), { headers, redirect: "error", signal: AbortSignal.timeout(30000),
  method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) }).then(r => {
    if (!r.ok) throw Error("Engine request returned " + r.status);
    return r;
  });
const detail = (await (await request(project + "?view=workspace")).json()).project;
assert(detail.name === "Native playback fixture" && detail.head === m.version && detail.mediaPaused === false);
const source = async () => (await request("/api/media/" + encodeURIComponent(m.cache.target) + "/playback-cache")).json();
async function timed(path, body) {
  const start = performance.now(), response = await request(path, body);
  const headersMs = Math.round(performance.now() - start), data = Buffer.from(await response.arrayBuffer());
  return { headersMs, completeMs: Math.round(performance.now() - start), bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}
for (const frame of frameList.split(",").map(Number)) {
  assert(Number.isSafeInteger(frame) && frame >= 0);
  const at = frame / m.settings.fps, range = m.playbackRanges.find(r => r.start <= at && at < r.end);
  assert(range);
  const before = await source();
  assert.equal(before.state, "caching", "Source must be actively caching");
  const wallStart = Date.now();
  const [still, fragment] = await Promise.all([
    timed(project + "/versions/" + encodeURIComponent(m.version) + "/frame?view=monitor&frame=" + frame),
    timed(project + "/renders?wait=1", { version: m.version, kind: "playback", quality: "preview", range }),
  ]);
  assert(still.bytes > 0 && fragment.bytes > 0);
  const after = await source();
  console.log(JSON.stringify({ frame, range, wallStart, wallEnd: Date.now(), still, fragment,
    sourceBefore: before.progress, sourceAfter: after.progress, sourceAfterState: after.state }));
}
