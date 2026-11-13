// Build @scarlet/server... first. Optionally set SCARLET_BENCH_ROOT to another built checkout.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = resolve(process.env.SCARLET_BENCH_ROOT || fileURLToPath(new URL("../../..", import.meta.url)));
const load = file => import(pathToFileURL(join(root, file)).href);
const { createApp } = await load("apps/server/dist/app.js");
const { accessToken } = await load("apps/server/dist/auth.js");
const { createTask, saveTask } = await load("apps/server/dist/services/tasks.js");
const { storeVersion } = await load("apps/server/dist/services/timeline.js");
const { encodeWaveformCache, WAVEFORM_CACHE_VERSION } = await load("packages/render/dist/index.js");
const { createProject, timelineFromKeepRanges } = await load("packages/timeline/dist/index.js");
const { ScarletClient, flattenWords } = await load("packages/shared/dist/index.js");
const { createScarletMcpServer } = await load("packages/mcp/dist/server.js");
const { captionSourceClips, captionWordMapper } = await load("packages/mcp/dist/analysis.js");

const count = Number(process.argv[2] ?? 3), seconds = Number(process.argv[3] ?? 7200);
assert(Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(seconds) && seconds >= 64);
const n = Math.floor(seconds / 4);
const words = "The camera keeps the cadence while another voice moves on.".split(" ");
const segments = Array.from({ length: n }, (_, i) => {
  const utterance = words.map((text, j) => ({ text: j === 0 && i % 47 === 0 ? "Milestone" : text,
    start: i * 4 + j * .4, end: i * 4 + (j + 1) * .4, confidence: .99, detectedSpeaker: i % 2 + 1 }));
  return { id: "s" + i, start: i * 4, end: i * 4 + 4, text: utterance.map(w => w.text).join(" "),
    speaker: "Speaker " + (i % 2 + 1), words: utterance };
});
// Returning speakers overlap. Word midpoint order differs from transcript order.
segments[8].words[0].end += 2;
const transcript = { id: "transcript", mediaId: "mic", language: "en", speakerAnalysis: { version: 3, count: 2 }, segments };
const metrics = {};
let searchWireBytes, captionSummary;
async function measure(label, fn) {
  const start = performance.now(), output = await fn();
  (metrics[label] ??= []).push(performance.now() - start);
  return output;
}
for (let run = 0; run < count; run++) {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-transcript-bench-"));
  const { app, ctx } = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log() {} });
  const editor = new Client({ name: "transcript-benchmark", version: "1" });
  try {
    const project = ctx.repos.projects.insert(createProject("Interview"));
    ctx.repos.projects.putMedia(project.id, { id: "mic", path: "mic.wav", name: "Interview", kind: "audio",
      duration: seconds, transcriptId: transcript.id }, "ready");
    ctx.repos.projects.putMedia(project.id, { id: "camera", path: "camera.mp4", name: "Camera", kind: "video", duration: seconds }, "ready");
    ctx.repos.transcripts.put({ ...transcript, projectId: project.id });
    const timeline = timelineFromKeepRanges(project.id, "camera", Array.from({ length: n }, (_, i) => ({ start: i * 4, end: i * 4 + 3 })), { audioMediaId: "mic" });
    const base = storeVersion(ctx, project.id, timeline, { parent: null });
    ctx.repos.projects.initializeHead(project.id, null, base.version);
    const token = accessToken(ctx);
    let onStatusRead;
    const client = new ScarletClient({ baseUrl: "http://benchmark.invalid", token, fetch: (url, init) => {
      if (onStatusRead && new URL(url).pathname.includes("/tasks/")) {
        const start = onStatusRead;
        onStatusRead = undefined;
        setTimeout(start, 100);
      }
      return app.request(url, init);
    } });
    const tools = createScarletMcpServer(client, { projectId: project.id, author: { type: "agent", name: "Benchmark" } });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await tools.connect(local);
    await editor.connect(remote);
    async function call(name, args) {
      const result = await editor.callTool({ name, arguments: args });
      assert(!result.isError, result.content[0].text);
      return result.content[0].text;
    }
    const page = start => client.transcript("mic", { from: start, to: start + 60, granularity: "word" });
    const first = await measure("firstMinute", () => page(0));
    assert.equal(first.segments.length, 15);
    for (let i = 0; i < 15; i++) await measure("otherMinute", () => page(i * 443 % (seconds - 60)));
    await measure("segmentOverview", () => client.transcript("mic", { granularity: "segment" }));
    const search = () => call("transcript_search", { mediaId: "mic", query: "milestone camera", contextWords: 2 });
    const firstSearch = await measure("firstPhraseSearch", search);
    assert.match(firstSearch, new RegExp("^" + Math.ceil(n / 47) + " exact match"));
    for (let i = 0; i < 8; i++) assert.equal(await measure("repeatPhraseSearch", search), firstSearch);
    const response = await app.request("/api/media/mic/transcript?search=milestone+camera&contextWords=2", { headers: { Authorization: "Bearer " + token } });
    searchWireBytes = (await response.arrayBuffer()).byteLength;
    await measure("captionSourceSelection", () => {
      assert.equal(captionSourceClips(timeline, () => true).length, n);
    });
    const clips = captionSourceClips(timeline, id => id === "mic");
    await measure("mapOverlappingSpeech", () => {
      const map = captionWordMapper(flattenWords(transcript));
      assert(clips.reduce((total, c) => total + map(c).length, 0) > 0);
    });
    captionSummary = (await measure("captionsGenerateProposal", () => call("captions_generate",
      { intent: "suggestion", mediaId: "mic", maxWords: 5 }))).split("\n")[0];
    assert.match(captionSummary, /caption clip/);

    // Two recording clocks share noisy, non-periodic landmarks at a known offset.
    ctx.paths.ensureProject(project.id);
    let seed = 41;
    const peaks = Float32Array.from({ length: Math.min(3600, seconds) * 50 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
    for (const [id, samples] of [["reference", peaks], ["secondary", peaks.subarray(125)]]) {
      const duration = samples.length / 50;
      ctx.repos.projects.putMedia(project.id, { id, path: id + ".wav", name: id, duration, kind: "audio", hasAudio: true }, "ready");
      await writeFile(join(ctx.paths.waveforms(project.id), `${id}.v${WAVEFORM_CACHE_VERSION}.waveform`),
        encodeWaveformCache({ duration, pointsPerSecond: 50, peaks: samples, rms: samples }));
    }
    const sync = await measure("audioSync", () => call("audio_sync", { referenceId: "reference", secondaryId: "secondary" }));
    assert.equal(JSON.parse(sync).secondaryStartRelativeToReference, 2.5);

    // Isolate delivery latency from inference by completing an already running
    // transcription 100 ms after MCP first checks its status.
    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    ctx.repos.projects.putMedia(project.id, { id: "pending", path: "pending.wav", name: "Pending", kind: "audio", duration: 1 }, "ready");
    const job = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", instruction: "Transcribe",
      state: "running", context: { mediaId: "pending" }, createdBy: { type: "scarlet", name: "Scarlet" } });
    let commitAt;
    const done = new Promise(resolve => {
      onStatusRead = () => {
        const saved = ctx.repos.transcripts.put({ id: "ready", mediaId: "pending", projectId: project.id,
          speakerAnalysis: { version: 3, count: 1 }, segments: [segments[0]] });
        saveTask(ctx, { ...job, state: "done" });
        commitAt = performance.now();
        resolve(saved);
      };
    });
    ctx.transcriptions.set(job.id, { controller: new AbortController(), done });
    const timeout = setTimeout(() => {}, 15_000);
    try {
      assert.match(await call("transcript_get", { mediaId: "pending" }), /Milestone/);
      assert(Number.isFinite(commitAt));
      (metrics.committedWordsToWaitingTool ??= []).push(performance.now() - commitAt);
    } finally { clearTimeout(timeout); ctx.transcriptions.delete(job.id); }
  } finally { await editor.close(); await ctx.close(); await rm(dir, { recursive: true, force: true }); }
}
const summary = Object.fromEntries(Object.entries(metrics).map(([name, times]) => {
  times.sort((a, b) => a - b);
  return [name, { medianMs: Number(((times[times.length >>> 1] + times[(times.length - 1) >>> 1]) / 2).toFixed(2)),
    p95Ms: Number(times[Math.ceil(times.length * .95) - 1].toFixed(2)) }];
}));
console.log(JSON.stringify({ runCount: count, seconds, sourceWords: n * 10, sourceClips: n * 2, syncSeconds: Math.min(3600, seconds), searchWireBytes, captionSummary, timings: summary }, null, 2));
