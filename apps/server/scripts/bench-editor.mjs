// Time a real solo engine over loopback. Each sample uses its own synthetic library.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createProject, makeTrack, timelineFromKeepRanges } from "@scarlet/timeline";
import { createApp } from "../dist/app.js";
import { localUser } from "../dist/auth.js";
import { proposeChange } from "../dist/services/changes.js";
import { createTask } from "../dist/services/tasks.js";
import { storeVersion } from "../dist/services/timeline.js";

const layered = process.argv.includes("--layered");
const includeTools = process.argv.includes("--tools");
const includeMedia = process.argv.includes("--media");
const includeProperties = process.argv.includes("--properties");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const program = process.env.SCARLET_BENCH_ENGINE || process.execPath;
const prefix = process.env.SCARLET_BENCH_ENGINE ? [] : [cli];
const source = fileURLToPath(new URL("../../web/public/sample.mp4", import.meta.url));
const args = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const samples = Number(args[0] ?? 5), clips = Number(args[1] ?? 120), cuts = Number(args[2] ?? 16);
assert([samples, clips, cuts].every(n => Number.isSafeInteger(n) && n > 0) && cuts < clips);
const root = await mkdtemp(join(tmpdir(), "scarlet-bench-editor-"));
const seed = join(root, "seed");
const times = new Map();
let draftResponseBytes;
async function time(label, fn) {
  const start = performance.now();
  const value = await fn();
  if (!times.has(label)) times.set(label, []);
  times.get(label).push(performance.now() - start);
  return value;
}
async function fixture() {
  const { ctx } = createApp({ dataDir: seed, log() {}, env: {} });
  try {
    const project = ctx.repos.projects.insert(createProject("Interview"));
    ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", path: "camera.mp4", name: "Camera", duration: clips * 6 }, "ready");
    ctx.repos.settings.update({transcription: {provider: "none"}});
    ctx.repos.transcripts.put({
      id: "words", mediaId: "camera", projectId: project.id, segments: Array.from({length: clips * 2}, (_, i) => ({
        id: "s" + i, start: i * 3, end: i * 3 + 3, text: "a line of dialogue", words: Array.from({length: 8}, (_, w) => ({
          text: i % 100 === 0 && w === 0 ? "milestone" : "word", start: i * 3 + w * 0.35, end: i * 3 + w * 0.35 + 0.3,
        })),
      })),
    });
    const user = localUser(ctx);
    const author = { type: "human", id: user.id, name: user.name };
    for (let i = 0; i < 32; i++) {
      const instruction = "Mark take " + i;
      const task = createTask(ctx, {projectId: project.id, kind: "edit", agent: "codex", instruction, createdBy: author});
      const edit = proposeChange(ctx, user, project.id, {
        description: instruction, intent: "requested", taskId: task.id,
        ops: [{op: "addMarker", marker: {id: "m" + i, time: i, text: instruction}}],
      });
      ctx.repos.tasks.put({...ctx.repos.tasks.get(task.id), state: "done", finishedAt: new Date().toISOString()});
      ctx.repos.notes.put({id: "n" + i, projectId: project.id, version: edit.change.toVersion,
        time: i, author, text: instruction, state: "resolved", changeId: edit.change.id});
    }
    const tl = timelineFromKeepRanges(project.id, "camera", Array.from({length: clips}, (_, i) => ({start: i * 6, end: i * 6 + 5})));
    if (layered) {
      ctx.repos.projects.putMedia(project.id, { id: "second", kind: "video", path: "second.mp4", name: "Second camera", duration: clips * 6 + 1 }, "ready");
      const video = tl.tracks[0];
      tl.tracks.push({...video, id: "inset", clips: video.clips.map(c => ({
        ...c, id: "inset-" + c.id, mediaId: "second", sourceIn: c.sourceIn + 1, sourceOut: c.sourceOut + 1,
        transform: { scale: 0.5 }, volume: 0,
      }))});
    }
    const { version } = storeVersion(ctx, project.id, tl, { parent: ctx.repos.projects.header(project.id).head });
    ctx.repos.projects.update(project.id, { head: version });
    for (let i = 1; i < 32; i++) ctx.repos.projects.insert(createProject("Other project " + i));
    return { id: project.id, version };
  } finally { await ctx.close(); }
}

async function initializeTools(ready, projectId) {
  const started = performance.now();
  const child = spawn(program, [...prefix, "mcp", "--server", ready.url, "--project", projectId], {
    env: {...process.env, SCARLET_TOKEN: ready.token}, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const done = once(child, "exit");
  child.stderr.resume();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let nextId = 0;
    async function rpc(method, params) {
      const id = ++nextId;
      child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
      for (;;) {
        const line = await lines.next();
        if (line.done) throw Error("Tool server stopped before " + method);
        const reply = JSON.parse(line.value);
        if (reply.id !== id) continue;
        if (reply.error || reply.result?.isError) throw Error(JSON.stringify(reply.error ?? reply.result.content));
        return reply.result;
      }
    }
    const initialized = await rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "editor-benchmark", version: "1"},
    });
    assert(initialized?.serverInfo);
    if (!times.has("agentToolConnection")) times.set("agentToolConnection", []);
    times.get("agentToolConnection").push(performance.now() - started);
    if (includeTools) {
      child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
      const call = (name, args) => time(name, () => rpc("tools/call", { name, arguments: args }));
      await call("project_get", {});
      await call("timeline_summary", {});
      await call("transcript_search", {mediaId: "camera", query: "milestone"});
      const result = await call("captions_generate", {mediaId: "camera", intent: "suggestion"});
      assert.match(result.content[0].text, /[1-9]\d* caption clip/);
    }
  } finally {
    child.stdin.end();
    await done;
    clearTimeout(timeout);
  }
}

async function run(dir, { id, version }) {
  const start = performance.now();
  const child = spawn(program, [...prefix, "serve", "--solo", "--port", "0", "--data", dir],
    { env: { ...process.env, SCARLET_TELEMETRY_ENABLED: "false" }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const done = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const lines = createInterface({ input: child.stdout });
  try {
    let ready;
    for await (const line of lines) {
      if (line.startsWith("SCARLET_READY ")) { ready = JSON.parse(line.slice(14)); break; }
    }
    assert(ready, "Engine exited before readiness");
    if (!times.has("engineReady")) times.set("engineReady", []);
    times.get("engineReady").push(performance.now() - start);
    async function request(path, body) {
      const response = await fetch(ready.url + "/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: "Bearer " + ready.token, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw Error(path + " returned " + response.status + ": " + await response.text());
      return response;
    }
    async function api(path, body) {
      return (await request(path, body)).json();
    }
    const project = "/projects/" + id, workspace = project + "?view=workspace";
    await time("auth", () => api("/auth/me"));
    await time("library32", () => api("/projects"));
    const opened = await time("workspaceFirstRead", () => api(workspace));
    assert.equal(opened.timeline.tracks[0].clips.length, clips);
    await time("workspaceRepeatRead", () => api(workspace));
    if (includeProperties) {
      // A dialogue editor fixes separated subtitle lines or adjusts the level of several takes.
      const captions = makeTrack("caption", "Subtitles");
      captions.clips = Array.from({ length: clips }, (_, i) => ({ id: "line" + i, kind: "caption",
        timelineIn: i * 5 + 0.1, timelineOut: i * 5 + 3.2, enabled: true, text: "Original line " + i }));
      const { change: assembly } = await api(project + "/changes?summary=true", {
        ops: [{ op: "addTrack", track: captions }], description: "Add subtitles", autoApprove: true,
      });
      for (const kind of ["caption", "gain"]) {
        const ops = Array.from({ length: cuts }, (_, i) => {
          const index = i * Math.floor(clips / cuts);
          return kind === "caption" ? { op: "updateClip", clipId: captions.clips[index].id, patch: { text: "Corrected line " + index } }
            : { op: "updateClip", clipId: opened.timeline.tracks[0].clips[index].id, patch: { volume: 0.5 } };
        });
        const url = project + "/changes?summary=true";
        const { change } = await time(kind + "BatchProposal", () => api(url, { fromVersion: assembly.toVersion,
          description: "Review " + kind + " edits", intent: "suggestion", ops }));
        const path = "/changes/" + change.id;
        const detail = await time(kind + "BatchOpen", () => api(path));
        assert.equal(detail.change.canApproveSpots, true);
        assert.equal(detail.change.ranges.length, cuts);
        await api(path + "/reject", { reason: "End of benchmark" });
      }
      return;
    }
    const history = await time("reviewHistory", () => Promise.all(["changes", "notes", "tasks"].map(k => api(project + "/" + k))));
    assert.equal(history[0].changes.length, 32);
    const page = "/media/camera/transcript?from=30&to=60";
    await time("transcript30s", () => api(page));
    await time("transcriptNextPage", () => api("/media/camera/transcript?from=60&to=90"));
    const {host} = await api("/hosts/register", {name: "Local bench", platform: process.platform, agents: [{id: "codex", installed: true}]});
    const {task} = await time("queueFirstCut", () => api(project + "/tasks", {
      kind: "edit", agent: "codex", instruction: "Make first cut", context: {message: "Make first cut"},
    }));
    const claimed = await time("claimFirstCut", () => api("/hosts/" + host.id + "/claim", {}));
    assert.equal(claimed.task.id, task.id);
    const step = Math.floor(clips / cuts) * 5;
    const ranges = Array.from({length: cuts}, (_, i) => ({start: i * step + 1, end: i * step + 2, review: true, reason: "Pause"}));
    const batch = await time("dialogueProposal", () => api(project + "/dialogue-cuts", {fromVersion: version, taskId: task.id, description: "Trim pauses", cuts: ranges}));
    const change = "/changes/" + batch.changes[0].id;
    const detail = await time("openDiffAfterProposal", () => api(change));
    assert.equal(detail.change.ranges.length, cuts);
    const record = await time("readChangeForAssessment", () => api(change + "?view=record"));
    assert.equal(record.change.id, batch.changes[0].id);
    const review = await time("openCutReview", () => api(change + "/cut-review", {}));
    assert.equal(review.review.cuts.length, cuts);
    const preview = await time("previewRestoredCut", () => api(change + "/cut-review?view=draft", {restoredCuts: [0]}));
    assert(preview.draft);
    draftResponseBytes = Buffer.byteLength(JSON.stringify(preview));
    const sameChoice = await time("reopenRestoredCut", () => api(change + "/cut-review?view=draft", {restoredCuts: [0]}));
    assert.equal(sameChoice.draft.version, preview.draft.version);
    const approved = await time("approveWithOneRestore", () => api(change + "/approve", {restoredCuts: [0]}));
    assert.equal(approved.change.state, "approved");
    const single = await time("singleCut", () => api(project + "/changes?summary=true", {
      ops: [{op: "rippleDelete", start: 0.1, end: 0.5}], description: "Trim start", autoApprove: true,
    }));
    assert.equal(single.change.state, "approved");
    await time("undoLastCut", () => api(project + "/versions/" + single.change.toVersion + "/revert", {
      branch: approved.project.branch, expectedHead: single.change.toVersion,
    }));
    await time("versionList", () => api(project + "/versions"));
    await initializeTools(ready, id);
    if (includeMedia) {
      const frame = await time("importFirstFrame", async () => {
        const response = await request(project + "/media/import-frame", {path: source});
        return new Uint8Array(await response.arrayBuffer());
      });
      assert.equal(frame[0], 0xff);
      const {media} = await time("importPlayable", () => api(project + "/media/import", {path: source}));
      assert(media.duration >= 19 && media.previewMode === "on-demand");
      const wave = "/media/" + media.id + "/waveform?from=0&to=5&points=512";
      const cold = await time("firstWaveform", () => api(wave));
      const cached = await time("cachedWaveform", () => api(wave));
      assert.deepEqual(cached.peaks, cold.peaks);
      const footage = timelineFromKeepRanges(id, media.id, [{ start: 1, end: 5 }, { start: 8, end: 13 }]);
      const result = await time("assembleSourceRanges", () => api(project + "/changes?summary=true", {
        timeline: footage, description: "Preview imported footage", autoApprove: true,
      }));
      const framePath = project + "/versions/" + result.change.toVersion + "/frame?view=monitor&frame=61";
      const readFrame = async () => {
        const bytes = new Uint8Array(await (await request(framePath)).arrayBuffer());
        assert.equal(bytes[0], 0xff);
        return bytes;
      };
      const first = await time("firstMonitorFrame", readFrame);
      const repeated = await time("cachedMonitorFrame", readFrame);
      assert.deepEqual(first, repeated);
    }
  } finally {
    child.stdin.end();
    await done;
    clearTimeout(timer);
  }
}
try {
  const project = await fixture();
  for (let i = 0; i < samples; i++) {
    const dir = join(root, String(i));
    await mkdir(dir);
    await cp(join(seed, "scarlet.db"), join(dir, "scarlet.db"));
    await run(dir, project);
  }
  const stats = Object.fromEntries([...times].map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [name, {p50: +sorted[Math.ceil(samples * 0.5) - 1].toFixed(2), p95: +sorted[Math.ceil(samples * 0.95) - 1].toFixed(2)}];
  }));
  console.log(JSON.stringify({samples, clips, cuts, layered, properties: includeProperties, draftResponseBytes, unit: "ms", stats}, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
