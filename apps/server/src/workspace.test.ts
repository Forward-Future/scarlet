import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clipEnd, createProject, isPlayableMedia, sha256, timelineDuration, timelineFromKeepRanges, Transform, type Change, type Clip, type Project } from "@scarlet/timeline";
import { buildThreads, isThreadDone, taskPlan, threadRevision, type Render, type Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "./app.js";
import { BUNDLED_SKILLS } from "./bundledSkills.js";
import { seedSkillList } from "./services/skills.js";
import { accessToken, localUser } from "./auth.js";
import { Db } from "./db.js";
import { foldStrandedPasses, proposeChange, recordLeftOutFootage } from "./services/changes.js";
import { emissionStore } from "./services/recordingAudio.js";
import { RecordingSpeakers } from "./services/recordingSpeakers.js";
import { CLASSES, SAMPLE_RATE, SEPARATOR, CTC_LETTERS } from "./transcribe/ctcAlign.js";
import { EmissionFile } from "./transcribe/emissions.js";
import { AnalysisCache } from "./services/analysisCache.js";
import { resolveFfmpeg, runCapture } from "@scarlet/render";
import { previewPictures } from "./services/previewPictures.js";
import { createTask, migrateDialogueOperations, appendTaskEvent, cancelTask, saveTask } from "./services/tasks.js";
import { continueReadyRuns, continueWhenReady, recoverTasks } from "./services/taskRecovery.js";
import { OpenAIProvider } from "./transcribe/openai.js";
import { importTranscriptionPolicy } from "./transcribe/index.js";
import { WhisperCppProvider } from "./transcribe/whispercpp.js";
import { speakerAnalysisVersion } from "./transcribe/speakerLabels.js";
import { LocalWhisperModel } from "./transcribe/localModel.js";
import { audioWorker } from "./transcribe/audioWorker.js";
import { recoverIngest, transcribeMedia } from "./services/ingest.js";
import { ensureHead, resolveTimeline, storeVersion } from "./services/timeline.js";
import { purgeTrash } from "./services/trash.js";
import { scarletRenderAdapter } from "./render/scarletRender.js";
import { fallbackAdapter, type RenderAdapter } from "./render/adapter.js";
import * as ffmpeg from "./render/ffmpeg.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

function openWorkspace(render: Partial<RenderAdapter> = {}, env: NodeJS.ProcessEnv = {}) {
  const app = createApp({
    dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env, log: () => {},
    render: {
      ...scarletRenderAdapter,
      async renderFullCached(p, _tl, _cache, file) {
        writeFileSync(file, JSON.stringify(p.settings));
      },
      ...render,
    },
  });
  // Whether speaker analysis runs beside the audio lane depends on the machine's cores. Tests run as a small one does.
  app.ctx.speakers.beside = false;
  return app;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-workspace-test-"));
  workspace = openWorkspace();
  project = workspace.ctx.repos.projects.insert(createProject("Test"));
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

function api(method: string, path: string, body?: unknown) {
  const headers = new Headers({ Authorization: `Bearer ${accessToken(workspace.ctx)}` });
  const repeatTask = method === "POST" && /\/tasks\/([^/]+)\/repeat-audit$/.exec(path)?.[1];
  if (repeatTask) {
    const startedAt = workspace.ctx.repos.tasks.get(repeatTask)?.startedAt;
    headers.set("X-Scarlet-Task", repeatTask);
    if (startedAt) headers.set("X-Scarlet-Task-Started-At", startedAt);
  }
  if (method === "POST" && /\/(?:changes|dialogue-cuts|staged-cuts\/\d+)(?:\?|$)/.test(path) && body && typeof body === "object" &&
      "taskId" in body && typeof body.taskId === "string") {
    let task = workspace.ctx.repos.tasks.get(body.taskId);
    // Fixtures that call an editing tool directly stand in for its host's first claim.
    if (task && !task.startedAt && ["queued", "claimed", "running"].includes(task.state))
      task = workspace.ctx.repos.tasks.put({ ...task, state: "running", startedAt: new Date().toISOString() });
    if (task?.startedAt) {
      headers.set("X-Scarlet-Task", task.id);
      headers.set("X-Scarlet-Task-Started-At", task.startedAt);
    }
  }
  if (body !== undefined && !(body instanceof FormData)) headers.set("Content-Type", "application/json");
  return workspace.app.request("/api" + path, {
    method, headers, body: body instanceof FormData ? body : JSON.stringify(body),
  });
}
const projectsPath = () => `/projects/${project.id}`;

/** Controlled local recognizer output for a synthetic 20 s microphone recording. */
async function micSpeech(speech: Record<number, string> = {}) {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const file = join(ctx.paths.media(project.id), "mic.wav");
  writeFileSync(file, "synthetic source");
  const store = (await EmissionFile.open(await emissionStore(ctx, project.id, realpathSync(file)), 20 * SAMPLE_RATE))!;
  try {
    const rows = new Float32Array(store.frames * CLASSES);
    for (const [start, text] of Object.entries(speech)) {
      let frame = Number(start);
      for (const letter of text) {
        const label = letter === "|" ? SEPARATOR : 5 + CTC_LETTERS.indexOf(letter.toUpperCase());
        rows[frame++ * CLASSES + label] = 1;
      }
    }
    await store.write(0, rows);
  } finally { await store.close(); }
}

async function checkPassAudio(taskId: string) {
  await micSpeech();
  const version = workspace.ctx.repos.projects.header(project.id)!.head;
  const check = await api("POST", projectsPath() + `/tasks/${taskId}/repeat-audit`, { version });
  const result = await check.json();
  expect(result.unavailable).toBeUndefined();
  expect(result).toMatchObject({ version, heard: 0, remaining: 0 });
}

it("returns cancellations missed before a native host subscribed to a new project", async () => {
  const { host } = await (await api("POST", "/hosts/register", {
    name: "test desktop", platform: "test", agents: [{ id: "codex", installed: true }],
  })).json();
  const { project: newProject } = await (await api("POST", "/projects", { name: "After host startup" })).json();
  const { task } = await (await api("POST", `/projects/${newProject.id}/tasks`, { kind: "edit", agent: "codex", instruction: "Fixture" })).json();
  const claim = await (await api("POST", `/hosts/${host.id}/claim`, { taskId: task.id, agents: ["codex"] })).json();
  expect(claim.task.id).toBe(task.id);
  const heartbeat = async (running: string[]) => (await api("POST", `/hosts/${host.id}/heartbeat`, { running })).json();
  expect(await heartbeat([task.id])).toEqual({ cancelled: [] });
  await api("POST", `/tasks/${task.id}/cancel`);
  expect(await heartbeat([task.id])).toEqual({ cancelled: [task.id] });
  expect(await heartbeat([])).toEqual({ cancelled: [] });
});

it("keeps transcription consent and independent settings patches consistent across engines", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ transcription: { provider: "openai" } });
  const peer = openWorkspace();
  peer.ctx.env.openaiKey = "fixture";
  try {
    const original = await importTranscriptionPolicy(peer.ctx);
    expect(original.provider).toBe("openai");
    ctx.repos.settings.update({ transcription: { provider: "none" } });
    ctx.repos.settings.update({ transcription: { provider: "openai" } });
    expect((await importTranscriptionPolicy(peer.ctx)).provider).toBe("openai");
    expect(original.signal.aborted).toBe(true);
    ctx.repos.settings.update({ transcription: { provider: "none" } });
    const stored = peer.ctx.repos.settings.update({ render: { previewHeight: 480 } });
    expect(stored.transcription.provider).toBe("none");
    expect((await importTranscriptionPolicy(peer.ctx)).provider).toBeUndefined();
    expect(ctx.settings().render.previewHeight).toBe(480);
  } finally { await peer.ctx.close(); }
});

it.each(["unchanged", "revoked", "legacy"])("recovers a paused import with %s transcription consent", async consent => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "fixture";
  ctx.repos.settings.update({ transcription: { provider: "openai" } });
  await api("PATCH", projectsPath(), { mediaPaused: true });
  vi.spyOn(ctx.render, "probeMedia").mockResolvedValue({ duration: 1, hasAudio: true, kind: "audio" });
  const source = join(directory, "interview.wav");
  writeFileSync(source, "fixture");
  const { media } = await (await api("POST", projectsPath() + "/media/import", { path: source })).json();
  expect(media).toMatchObject({ status: "ingesting", transcriptionOnImport: "openai", transcriptionRevisionOnImport: expect.any(Number) });
  await Promise.all([...ctx.pending]);
  if (consent === "legacy") {
    ctx.db.prepare("UPDATE media SET json = json_remove(json, '$.transcriptionRevisionOnImport') WHERE id = ?").run(media.id);
  }
  await ctx.close();
  workspace = openWorkspace();
  workspace.ctx.env.openaiKey = "fixture";
  if (consent === "revoked") {
    workspace.ctx.repos.settings.update({ transcription: { provider: "none" } });
    workspace.ctx.repos.settings.update({ transcription: { provider: "openai" } });
  }
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  try {
    await api("PATCH", projectsPath(), { mediaPaused: false });
    await Promise.all([...workspace.ctx.pending]);
    expect(workspace.ctx.repos.projects.getMedia(media.id)?.status).toBe("ready");
    expect(cloud).toHaveBeenCalledTimes(consent === "unchanged" ? 1 : 0);
    expect(workspace.ctx.repos.tasks.count()).toBe(consent === "unchanged" ? 1 : 0);
  } finally { cloud.mockRestore(); }
});

it.each(["missing", "removed"] as const)("imports audio without a transcription job when the custom model is %s", async state => {
  const { ctx } = workspace;
  const model = join(directory, "weights.bin");
  if (state === "removed") writeFileSync(model, "weights");
  ctx.repos.settings.update({ transcription: { provider: "whispercpp", localModel: "custom", whisperCppPath: process.execPath, whisperModelPath: model } });
  await api("PATCH", projectsPath(), { mediaPaused: true });
  vi.spyOn(ctx.render, "probeMedia").mockResolvedValue({ duration: 1, hasAudio: true, kind: "audio" });
  const source = join(directory, "interview.wav");
  writeFileSync(source, "fixture");
  const { media } = await (await api("POST", projectsPath() + "/media/import", { path: source })).json();
  expect(media.transcriptionOnImport).toBe(state === "removed" ? "whispercpp" : undefined);
  await Promise.all([...ctx.pending]);
  if (state === "removed") rmSync(model);
  expect(await (await api("GET", "/settings")).json()).toMatchObject({ transcriptionAvailable: false });
  await api("PATCH", projectsPath(), { mediaPaused: false });
  await Promise.all([...ctx.pending]);
  expect(ctx.repos.projects.getMedia(media.id)?.status).toBe("ready");
  expect(ctx.repos.tasks.count()).toBe(0);
});

function transcriptionRows(mediaId: string) {
  return workspace.ctx.db.prepare(`SELECT
    (SELECT COUNT(*) FROM transcription_work WHERE media_id = ?) AS work,
    (SELECT COUNT(*) FROM transcription_chunks WHERE media_id = ?) AS chunks`).get(mediaId, mediaId);
}

it.each(["local", "peer"])("stops an active cloud transcription after %s task cancellation", async (owner) => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "fixture";
  ctx.repos.settings.update({ transcription: { provider: "openai" } });
  const media = ctx.repos.projects.putMedia(project.id, { id: "cloud-audio", kind: "audio", name: "Recording", path: "input.wav", duration: 1300 }, "ready");
  const peer = owner === "peer" ? openWorkspace() : undefined;
  const extract = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_input, out) => { writeFileSync(out, "fixture"); });
  let signal: AbortSignal | undefined;
  const upload = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ text: "first", words: [{ word: "first", start: 1, end: 2 }] }))
    .mockImplementation((_url, opts) => {
      signal = opts!.signal!;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
  try {
    const { task } = await (await api("POST", `/media/${media.id}/transcribe`, {})).json();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(transcriptionRows(media.id)).toEqual({ work: 1, chunks: 1 });
    const host = peer ?? workspace;
    const cancelled = await host.app.request(`/api/tasks/${task.id}/cancel`, {
      method: "POST", headers: { Authorization: "Bearer " + accessToken(host.ctx) },
    });
    expect((await cancelled.json()).task.state).toBe("cancelled");
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 3000 });
    await Promise.allSettled([...ctx.pending]);
    expect(ctx.repos.tasks.get(task.id)?.state).toBe("cancelled");
    expect(upload).toHaveBeenCalledTimes(2);
    expect(transcriptionRows(media.id)).toEqual({ work: 0, chunks: 0 });
    expect(ctx.repos.projects.getMedia(media.id)?.transcriptId).toBeUndefined();
  } finally {
    ctx.repos.settings.update({ transcription: { provider: "none" } });
    upload.mockRestore(); extract.mockRestore(); await peer?.ctx.close();
  }
});

it("preserves an approval made while a revision request body is arriving", async () => {
  const { change } = await (await api("POST", projectsPath() + "/changes", { description: "Add label", ops: marker })).json();
  let release!: () => void;
  const bodyReady = new Promise<void>(r => { release = r; });
  let started!: () => void;
  const reading = new Promise<void>(r => { started = r; });
  const body = new ReadableStream({
    async pull(controller) {
      started(); await bodyReady;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: "Move the label" })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const request = new Request(`http://engine.test/api/changes/${change.id}/revise`, {
    method: "POST", headers: { Authorization: "Bearer " + accessToken(workspace.ctx) }, body, duplex: "half",
  } as RequestInit);
  const revision = workspace.app.request(request);
  try {
    await reading;
    expect((await api("POST", `/changes/${change.id}/approve`, {})).status).toBe(200);
  } finally { release(); }
  expect((await revision).status).toBe(409);
  expect(workspace.ctx.repos.changes.get(change.id)).toMatchObject({ state: "approved", appliedVersion: change.toVersion });
  expect(workspace.ctx.repos.tasks.count()).toBe(0);
  expect(workspace.ctx.repos.notes.count()).toBe(0);
});

it("rechecks peer cancellation before the next upload without waiting for the peer watcher", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "fixture";
  ctx.repos.settings.update({ transcription: { provider: "openai" } });
  const media = ctx.repos.projects.putMedia(project.id, { id: "chunked", kind: "audio", name: "Recording", path: "input.wav", duration: 601 }, "ready");
  const peer = openWorkspace();
  const extract = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_input, out) => { writeFileSync(out, "fixture"); });
  const upload = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const [task] = peer.ctx.repos.tasks.select("state='running' AND kind='transcribe'");
    cancelTask(peer.ctx, task!);
    return Response.json({ segments: [] });
  });
  try {
    await expect(transcribeMedia(ctx, project.id, media)).rejects.toThrow();
    expect(upload).toHaveBeenCalledOnce();
    expect(ctx.repos.projects.getMedia(media.id)?.transcriptId).toBeUndefined();
  } finally {
    upload.mockRestore(); extract.mockRestore(); await peer.ctx.close();
  }
});

it("discards a final transcription result when a peer revoked consent during the upload", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "fixture";
  ctx.repos.settings.update({ transcription: { provider: "openai" } });
  const media = ctx.repos.projects.putMedia(project.id, { id: "short-recording", kind: "audio", name: "Audio", path: "audio.wav" }, "ready");
  const peer = openWorkspace();
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(async () => {
    peer.ctx.repos.settings.update({ transcription: { provider: "none" } });
    return { segments: [] };
  });
  try {
    await expect(transcribeMedia(ctx, project.id, media)).rejects.toThrow("provider changed");
    expect(ctx.repos.projects.getMedia(media.id)?.transcriptId).toBeUndefined();
  } finally { cloud.mockRestore(); await peer.ctx.close(); }
});

it.each(["cancel", "complete"])("can file an edit after a revision ends without another proposal (%s)", async (action) => {
  const { ctx } = workspace;
  const { change } = await (await api("POST", projectsPath() + "/changes", { description: "Add label", ops: marker })).json();
  const { task } = await (await api("POST", `/changes/${change.id}/revise`, { text: "Move it" })).json();
  const thread = () => buildThreads({ changes: ctx.repos.changes.select(), notes: ctx.repos.notes.select(), tasks: ctx.repos.tasks.select() })[0]!;
  expect(thread().status).toBe("working");
  expect((await api("POST", `/tasks/${task.id}/${action}`, action === "complete" ? { state: "done", summary: "No edit needed" } : {})).status).toBe(200);
  const ended = thread();
  expect(ctx.repos.changes.get(change.id)).toMatchObject({ state: "ready" });
  expect(ended).toMatchObject({ status: "needs_you", needs: "decision", latest: { id: change.id, state: "ready" } });
  expect((await api("POST", `${projectsPath()}/threads/${ended.id}/disposition`, { done: true, revision: threadRevision(ended) })).status).toBe(200);
  expect((await api("POST", `/changes/${change.id}/approve`, {})).status).toBe(200);
});

it.each(["rejected", "failed"] as const)("restores the prior %s proposal only after all revisions end", async state => {
  const { ctx } = workspace;
  const { change } = await (await api("POST", projectsPath() + "/changes", { description: "Add label", ops: marker })).json();
  const previous = ctx.repos.changes.put({ ...change, state, error: state === "failed" ? "Render failed" : undefined,
    rejectReason: state === "rejected" ? "Wrong label" : undefined });
  const revise = async () => (await (await api("POST", `/changes/${change.id}/revise`, { text: "Try again" })).json()).task;
  const first = await revise(), second = await revise();
  await api("POST", `/tasks/${first.id}/cancel`, {});
  expect(ctx.repos.changes.get(change.id)?.state).toBe("revising");
  await api("POST", `/tasks/${second.id}/cancel`, {});
  const restored = ctx.repos.changes.get(change.id)!;
  expect(restored.state).toBe(previous.state);
  expect(restored.error).toBe(previous.error);
  expect(restored.rejectReason).toBe(previous.rejectReason);
  expect(restored.revisionFrom).toBeUndefined();
});

it("keeps a saved replacement and respects a decision made while a revision was active", async () => {
  const { ctx } = workspace;
  const { change } = await (await api("POST", projectsPath() + "/changes", { description: "Label", ops: marker })).json();
  const revise = async () => (await (await api("POST", `/changes/${change.id}/revise`, { text: "Try again" })).json()).task;
  const first = await revise(), sibling = await revise();
  const response = await api("POST", projectsPath() + "/changes", {
    description: "Alternative label", taskId: first.id, ops: [{ op: "addMarker", marker: { id: "alt", time: 1, text: "Alternative" } }],
  });
  expect(response.status).toBe(201);
  await api("POST", `/tasks/${first.id}/cancel`, {});
  await api("POST", `/tasks/${sibling.id}/cancel`, {});
  expect(ctx.repos.changes.get(change.id)?.state).toBe("revising");
  const { change: replacement } = await response.json();
  expect(ctx.repos.changes.get(replacement.id)?.state).toBe("ready");
  const { task } = await (await api("POST", `/changes/${replacement.id}/revise`, { text: "One more try" })).json();
  await api("POST", `/changes/${replacement.id}/reject`, { reason: "No longer wanted" });
  await api("POST", `/tasks/${task.id}/cancel`, {});
  expect(ctx.repos.changes.get(replacement.id)).toMatchObject({ state: "rejected", rejectReason: "No longer wanted" });
  await api("POST", `/changes/${replacement.id}/reopen`, {});
  expect(ctx.repos.changes.get(replacement.id)?.state).toBe("ready");
});

it("recovers an interrupted revision and keeps its resumed attempt reviewable on cancellation", async () => {
  const { ctx } = workspace;
  const { change } = await (await api("POST", projectsPath() + "/changes", { description: "Label", ops: marker })).json();
  const { task } = await (await api("POST", `/changes/${change.id}/revise`, { text: "Try again" })).json();
  ctx.repos.tasks.put({ ...task, state: "running" });
  recoverTasks(ctx);
  // The worker went missing, so the revision carries on by itself under a new task.
  expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "failed", interrupted: true });
  const { task: resumed } = await (await api("POST", `/tasks/${task.id}/retry`, {})).json();
  expect(resumed.id).toBe(ctx.repos.tasks.get(task.id)?.retryTaskId);
  expect(ctx.repos.changes.get(change.id)?.state).toBe("revising");
  await api("POST", `/tasks/${resumed.id}/cancel`, {});
  expect(ctx.repos.changes.get(change.id)?.state).toBe("ready");
});

it("allows filing legacy revisions whose prior review state was never recorded", async () => {
  const { ctx } = workspace;
  const { change } = await (await api("POST", projectsPath() + "/changes", { description: "Label", ops: marker })).json();
  const { task, change: revising } = await (await api("POST", `/changes/${change.id}/revise`, { text: "Try again" })).json();
  ctx.repos.changes.put({ ...revising, revisionFrom: undefined });
  await api("POST", `/tasks/${task.id}/cancel`, {});
  const [ended] = buildThreads({ changes: ctx.repos.changes.select(), notes: ctx.repos.notes.select(), tasks: ctx.repos.tasks.select() });
  expect(ended!.status).toBe("closed");
  expect((await api("POST", `${projectsPath()}/threads/${ended!.id}/disposition`, { done: true, revision: threadRevision(ended!) })).status).toBe(200);
});

it("checks large proposals once outside the write transaction and reuses verified spots for approval", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Camera", kind: "video", path: "camera.mov" }, "ready");
  const tl = timelineFromKeepRanges(project.id, "camera", Array.from({ length: 80 }, (_, i) => ({ start: i, end: i + 1 })));
  const { version } = storeVersion(ctx, project.id, tl, { parent: null });
  ctx.repos.projects.update(project.id, { head: version });
  const ops = [2, 12, 22, 32].map(i => ({ op: "updateClip" as const, clipId: tl.tracks[0]!.clips[i]!.id, patch: { volume: 0.5 } }));
  const mix = proposeChange(ctx, localUser(ctx), project.id, { ops, description: "Mix four regions", skipRender: true });
  expect(mix.change.spotAssignment).toEqual({ fps: 30, owners: [0, 1, 2, 3] });
  const { change } = proposeChange(ctx, localUser(ctx), project.id, {
    ops: ops.map(op => ({ ...op, patch: { transform: { scale: 0.8 } } })), description: "Reframe four regions", skipRender: true,
  });
  expect(change.spotAssignment).toBeUndefined();
  const read = await api("GET", "/changes/" + change.id);
  expect((await read.json()).change.spotAssignment).toEqual({ fps: 30, owners: [0, 1, 2, 3] });
  const worker = vi.spyOn(ctx.spotChecks, "get");
  const result = await api("POST", "/changes/" + change.id + "/approve", { spots: [1] });
  expect((await result.json()).outcome).toBe("partial");
  expect(worker).not.toHaveBeenCalled();
});

it("returns legacy edit history immediately and backfills only open proposals", async () => {
  const { ctx } = workspace;
  const { change } = proposeChange(ctx, localUser(ctx), project.id, { description: "Marker",
    ops: [{ op: "addMarker", marker: { id: "beat", time: 1, text: "Beat" } }] });
  const legacy = { ...change, canApproveSpots: undefined, spotAssignment: undefined, ranges: [{ start: 1, end: 2 }, { start: 4, end: 5 }] };
  ctx.repos.changes.put(legacy);
  ctx.repos.changes.put({ ...legacy, id: "formerly-reviewed", state: "approved" });
  const check = vi.spyOn(ctx.spotChecks, "get").mockResolvedValue(null);
  const versions = vi.spyOn(ctx.repos.versions, "get");
  const record = await (await api("GET", "/changes/" + change.id + "?view=record")).json();
  expect(record.change.id).toBe(change.id);
  expect(record.diff).toBeUndefined();
  expect(versions).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
  const history = (await (await api("GET", projectsPath() + "/changes")).json()).changes as Change[];
  expect(history).toHaveLength(2);
  expect(history.every(c => c.spotAssignment === undefined)).toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
  while (ctx.pending.size) await Promise.all([...ctx.pending]);
  expect(ctx.repos.changes.get(change.id)?.canApproveSpots).toBe(false);
  ctx.repos.projects.softDelete(project.id);
  expect((await api("GET", "/changes/" + change.id + "?view=record")).status).toBe(404);
});

it.each([
  { updateRoles: false, expectedStreams: [undefined] },
  { updateRoles: true, expectedStreams: [undefined, 2] },
])("retains the Whisper decode through speaker analysis and respects stream selection (%j)", async ({ updateRoles, expectedStreams }) => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", name: "Interview", path: "interview.wav", kind: "audio" }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), media.path), "source");
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const decode = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { writeFileSync(wav, silentWav(0.1)); });
  const reader = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockImplementation(async () => {
    if (updateRoles) ctx.repos.projects.putMedia(project.id, { ...media, voiceRoles: { me: 1, other: 2 } }, "ready");
    return { language: "en", segments: [] };
  });
  const models = vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  const speaker = vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
    const wav = args[args.indexOf("diarize-audio") + 1]!;
    expect(readFileSync(wav)).toEqual(silentWav(0.1));
    return Buffer.from("[]");
  });
  try {
    expect(await transcribeMedia(ctx, project.id, media)).toBeTruthy();
    while (ctx.pending.size) await Promise.all([...ctx.pending]);
    expect(decode.mock.calls.map(([, , options]) => options?.audioStream)).toEqual(expectedStreams);
    expect(speaker).toHaveBeenCalledTimes(1);
    for (const [, wav] of decode.mock.calls) expect(existsSync(wav)).toBe(false);
  } finally {
    speaker.mockRestore(); models.mockRestore(); reader.mockRestore(); decode.mockRestore();
  }
});

it("finds a recording's speakers while it is transcribed when the machine has cores for both, and after it otherwise", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const order: string[] = [];
  const decode = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { writeFileSync(wav, silentWav(0.1)); });
  const models = vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  const speaker = vi.spyOn(ffmpeg, "run").mockImplementation(async (_bin, args) => {
    if (args.includes("diarize-audio")) order.push("speakers");
    return Buffer.from("[]");
  });
  const reader = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockImplementation(async () => {
    // Beside the lane the analysis is under way before Whisper has the words.
    if (ctx.speakers.beside) await vi.waitFor(() => expect(order).toEqual(["speakers"]));
    order.push("whisper");
    return { language: "en", segments: [] };
  });
  const transcribe = async (id: string) => {
    order.length = 0;
    const media = ctx.repos.projects.putMedia(project.id, { id, name: id, path: `${id}.wav`, kind: "audio" }, "ready");
    writeFileSync(join(ctx.paths.media(project.id), media.path), id);
    expect(await transcribeMedia(ctx, project.id, media)).toBeTruthy();
    while (ctx.pending.size) await Promise.all([...ctx.pending]);
    return [...order];
  };
  try {
    expect(await transcribe("small")).toEqual(["whisper", "speakers"]);
    ctx.speakers.beside = true;
    // The transcript's labels then use the analysis already made: the worker ran once.
    expect(await transcribe("large")).toEqual(["speakers", "whisper"]);
    expect(ctx.repos.transcripts.get(ctx.repos.projects.getMedia("large")!.transcriptId!)?.speakerAnalysis).toBeTruthy();
  } finally {
    speaker.mockRestore(); models.mockRestore(); reader.mockRestore(); decode.mockRestore();
  }
});

it("transcribes at import with bundled Whisper", async () => {
  const { ctx } = workspace;
  const bundled = ctx.whisperCli;
  ctx.whisperCli = "whisper-cli";
  try {
    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperModelPath: "" } });
    expect((await importTranscriptionPolicy(ctx)).provider).toBe("whispercpp");
    ctx.repos.settings.update({ transcription: { provider: "none" } });
    expect((await importTranscriptionPolicy(ctx)).provider).toBeUndefined();
  } finally { ctx.whisperCli = bundled; }
});

it("saves a transcription's progress on its task while it runs and clears it when done", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", name: "Interview", path: "interview.wav", kind: "audio", duration: 600 }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), media.path), "source");
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const decode = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { writeFileSync(wav, silentWav(0.1)); });
  const seen: Array<Task["progress"]> = [];
  const running = () => ctx.repos.tasks.select("kind = 'transcribe'").at(-1)!;
  const reader = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockImplementation(async (...args) => {
    seen.push(running().progress);
    args[5]?.(0.5);
    seen.push(running().progress);
    return { language: "en", segments: [] };
  });
  try {
    expect(await transcribeMedia(ctx, project.id, media)).toBeTruthy();
    // Whisper is the first third; the aligner has nothing to do for an empty transcript.
    // `words` is the part a dialogue pass waits for: the transcript is saved once it has them.
    expect(seen).toEqual([{ stage: "transcribing", fraction: 0, words: { fraction: 0 } }, { stage: "transcribing", fraction: 1 / 6, words: { fraction: 0.5 } }]);
    expect(running()).toMatchObject({ state: "done" });
    expect(running().progress).toBeUndefined();
  } finally { reader.mockRestore(); decode.mockRestore(); }
});

/** A recording whose two words are far enough apart to take the aligner two turns, with a worker that moves each word 0.1 s. */
function twoTurnTranscription(onTurn: (turn: number) => void | Promise<void> = () => {}, adapterModel?: string) {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", name: "Interview", path: "interview.wav", kind: "audio", duration: 600 }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), media.path), "source");
  const segments = [["hello", 10], ["again", 400]].map(([text, start], i) => ({ id: `seg${i}`, start: start as number, end: start as number + 1, text: text as string,
    words: [{ text: text as string, start: start as number, end: start as number + 0.4 }] }));
  const decode = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => { writeFileSync(wav, silentWav(0.1)); });
  const reader = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockImplementation(async () => ({ language: "en", segments, modelLabel: adapterModel }));
  const models = vi.spyOn(LocalWhisperModel.prototype, "get").mockResolvedValue("model");
  let turns = 0;
  // The speaker worker finds no turns.
  const speakers = vi.spyOn(ffmpeg, "run").mockResolvedValue(Buffer.from("[]"));
  const worker = vi.spyOn(audioWorker, "request").mockImplementation(async message => {
    if (message.kind !== "align") return [] as never;
    await onTurn(++turns);
    const request = JSON.parse(readFileSync(message.request, "utf8")) as { groups: Array<{ words: Array<{ start: number; end: number }> }> };
    return request.groups.map(g => g.words.map(w => ({ start: w.start + 0.1, end: w.end + 0.1, score: 1 }))) as never;
  });
  const linked = () => {
    const id = ctx.repos.projects.getMedia(media.id)?.transcriptId;
    return id ? ctx.repos.transcripts.get(id) : undefined;
  };
  return { ctx, media, reader, linked, task: () => ctx.repos.tasks.select("kind = 'transcribe'", [], "created_at, rowid").at(-1)!,
    restore: () => { worker.mockRestore(); speakers.mockRestore(); models.mockRestore(); reader.mockRestore(); decode.mockRestore(); } };
}

it.each(["custom", "whispercpp", "crisperwhisper"] as const)("saves the transcript with its actual model (%s) and places its words on the audio turn by turn", async localModel => {
  const { ctx } = workspace;
  ctx.whisperCli = process.execPath;
  if (localModel === "crisperwhisper") {
    const base = join(ctx.paths.root, "models", "crisperwhisper");
    const python = join(base, "venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    for (const file of [python, join(base, "crisper_cli.py"), join(base, "model", "model.safetensors")]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixture", { mode: 0o700 });
    }
  }
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", ...(localModel === "custom" && { whisperModelPath: "fixture" }) } });
  const seen: Array<{ through?: number; state: string; localModel?: string; words: number[] }> = [];
  const t = twoTurnTranscription(() => {
    expect(ctx.repos.projects.getMedia(t.media.id)?.lastTranscription).toBeUndefined();
    seen.push({ through: t.linked()?.aligning?.through, state: t.task().state, localModel: t.linked()?.localModel,
      words: t.linked()?.segments.map(s => s.words[0]!.start) ?? [] });
  }, "Interview ASR 1.2");
  try {
    const transcript = await transcribeMedia(t.ctx, project.id, t.media);
    // A pass can read the words while the first turn runs. After it, the first word is final and the second still Whisper's.
    expect(seen).toEqual([{ through: 0, state: "running", localModel, words: [10, 400] }, { through: 10.5, state: "running", localModel, words: [10.1, 400] }]);
    expect(transcript).toMatchObject({ provider: "whispercpp", localModel, segments: [{ words: [{ start: 10.1 }] }, { words: [{ start: 400.1 }] }] });
    expect(transcript?.aligning).toBeUndefined();
    expect(t.task()).toMatchObject({ state: "done", summary: "2 segments", context: { transcribedWith: "whispercpp", localModel } });
    // The speaker labels wait for the last turn, so the copy they save carries the final times.
    while (t.ctx.pending.size) await Promise.all([...t.ctx.pending]);
    expect(t.linked()).toMatchObject({ localModel, speakerAnalysis: {}, segments: [{ words: [{ start: 10.1 }] }, { words: [{ start: 400.1 }] }] });
    expect(t.linked()?.aligning).toBeUndefined();
    const model = { custom: "Interview ASR 1.2", whispercpp: "Whisper large-v3-turbo", crisperwhisper: "CrisperWhisper 2.0 large" }[localModel];
    expect(await (await api("GET", `/media/${t.media.id}/transcript?from=0&to=20`)).json()).toMatchObject({ localModel, modelLabel: model });
    expect(await (await api("GET", `/projects/${project.id}/media`)).json()).toMatchObject({
      media: [{ id: t.media.id, lastTranscription: { completedAt: t.task().finishedAt, model } }],
    });
  } finally { t.restore(); }
});

it("resumes the remaining alignment turn when the library reopens", async () => {
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  let turns = 0;
  const t = twoTurnTranscription(async turn => {
    turns++;
    if (turn === 2) await new Promise<void>(resolve => t.ctx.shutdown.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    expect((await api("POST", "/media/speech/transcribe", {})).status).toBe(202);
    await vi.waitFor(() => expect(turns).toBe(2));
    const id = t.linked()!.id;
    expect(t.linked()).toMatchObject({ aligning: { through: 10.5 }, segments: [{ words: [{ start: 10.1 }] }, { words: [{ start: 400 }] }] });
    await t.ctx.close();
    workspace = openWorkspace();
    while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]);
    expect(t.reader).toHaveBeenCalledOnce();
    // One completed turn, one interrupted attempt, and one turn on reopen.
    expect(turns).toBe(3);
    expect(workspace.ctx.repos.transcripts.get(id)).toMatchObject({ segments: [{ words: [{ start: 10.1 }] }, { words: [{ start: 400.1 }] }] });
    expect(workspace.ctx.repos.transcripts.get(id)?.aligning).toBeUndefined();
    expect(workspace.ctx.repos.tasks.select("kind = 'transcribe'", [], "created_at, rowid").at(-1)?.state).toBe("done");
  } finally { t.restore(); }
});

/** A mono 16 kHz PCM recording like the one FFmpeg hands to the local recognizer. */
function silentWav(seconds: number) {
  const samples = Math.round(seconds * SAMPLE_RATE);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(2 * SAMPLE_RATE, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

it.each(["whispercpp", "openai"] as const)("resumes %s recognition after two app restarts without repeating completed audio", async provider => {
  const { ctx } = workspace;
  const env = { OPENAI_API_KEY: "fixture" };
  ctx.env.openaiKey = env.OPENAI_API_KEY;
  ctx.repos.settings.update({ transcription: { provider, whisperCppPath: process.execPath, localModel: "custom" } });
  // Each chunk has a distinct pulse. The fake recognizers report its time within the audio they actually receive.
  const times = provider === "whispercpp" ? [10, 150, 275] : [10, 650, 1240];
  const audioDuration = times[2]! + 20;
  // A video's pictures can outlast the audio Whisper actually decoded.
  const duration = provider === "whispercpp" ? audioDuration * 2 : audioDuration;
  const words = ["un", "deux", "trois"];
  const pulses = words.map((_, i) => Buffer.alloc(8, i + 1));
  const recording = silentWav(audioDuration);
  times.forEach((time, i) => pulses[i]!.copy(recording, 44 + 2 * SAMPLE_RATE * time));
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", kind: "video", hasAudio: true, name: "Interview", path: "fixture.wav", duration }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), media.path), recording);

  const calls: Array<{ word: string; progress?: number }> = [];
  const interrupted = new Set<string>();
  async function recognize(wav: Buffer, signal: AbortSignal) {
    const data = wav.subarray(wav.indexOf("data") + 8);
    const index = pulses.findIndex(pulse => data.includes(pulse));
    if (index === -1) throw new Error("Expected speech in this chunk");
    const word = words[index]!;
    const start = data.indexOf(pulses[index]!) / (2 * SAMPLE_RATE);
    const task = workspace.ctx.repos.tasks.select("kind = 'transcribe' AND state = 'running'")[0];
    calls.push({ word, progress: task?.progress?.words?.fraction });
    if (index > 0 && !interrupted.has(word)) {
      interrupted.add(word);
      signal.throwIfAborted();
      await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return { word, start, end: start + 0.25 };
  }
  const local = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockImplementation(async (file, _tmp, signal) => {
    const { word: text, start, end } = await recognize(readFileSync(file), signal!);
    return { language: "fr", segments: [{ id: text, text, start, end, words: [{ text, start, end }] }] };
  });
  const cloud = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const file = (init!.body as FormData).get("file") as File;
    const word = await recognize(Buffer.from(await file.arrayBuffer()), init!.signal!);
    return Response.json({ language: "fr", text: word.word, words: [word] });
  });
  const speakers = vi.spyOn(RecordingSpeakers.prototype, "turns").mockResolvedValue([]);
  try {
    expect((await api("POST", "/media/speech/transcribe", {})).status).toBe(202);
    for (const word of words.slice(1)) {
      await vi.waitFor(() => expect(interrupted.has(word)).toBe(true), { timeout: 8000 });
      expect(workspace.ctx.repos.projects.getMedia(media.id)?.transcriptId).toBeUndefined();
      await workspace.ctx.close();
      workspace = openWorkspace({}, env);
    }
    while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]);
    expect(calls.map(c => c.word)).toEqual(["un", "deux", "deux", "trois", "trois"]);
    for (const index of [2, 4]) {
      expect(calls[index]!.progress).toBeGreaterThan(0);
      expect(calls[index]!.progress).toBeCloseTo(calls[index - 1]!.progress!, 3);
    }
    const final = await (await api("GET", "/media/speech/transcript")).json();
    expect(final).toMatchObject({ language: "fr", segments: words.map((text, i) => ({ text, words: [{ text, start: times[i], end: times[i]! + 0.25 }] })) });
    expect(final.aligning).toBeUndefined();
    expect(transcriptionRows(media.id)).toEqual({ work: 0, chunks: 0 });
    expect(workspace.ctx.repos.tasks.select("kind = 'transcribe'", [], "created_at, rowid").at(-1)?.state).toBe("done");
  } finally { speakers.mockRestore(); cloud.mockRestore(); local.mockRestore(); }
}, 30000);

it("starts a changed recording from the beginning after an interrupted transcription", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath, localModel: "custom" } });
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "changed", kind: "audio", name: "Changed", path: "recording.wav", duration: 250 }, "ready");
  const source = join(ctx.paths.media(project.id), media.path);
  writeFileSync(source, "original audio");
  const starts: number[] = [];
  const reader = vi.spyOn(WhisperCppProvider.prototype, "transcribe").mockImplementation(async ({ checkpoint, signal }) => {
    starts.push(checkpoint!.through);
    const text = readFileSync(source, "utf8");
    const chunk = { language: "fr", segments: [{ id: "chunk", text, start: 1, end: 2, words: [] }] };
    if (starts.length === 1) {
      checkpoint!.save(120, chunk);
      await new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    }
    return { language: "fr", segments: [...checkpoint!.result.segments, ...chunk.segments] };
  });
  const speakers = vi.spyOn(RecordingSpeakers.prototype, "turns").mockResolvedValue([]);
  try {
    expect((await api("POST", "/media/changed/transcribe", {})).status).toBe(202);
    await vi.waitFor(() => expect(starts).toEqual([0]));
    await ctx.close();
    writeFileSync(source, "replacement audio");
    workspace = openWorkspace();
    while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]);
    expect(starts).toEqual([0, 0]);
    const transcript = await (await api("GET", "/media/changed/transcript")).json();
    expect(transcript.segments.map((segment: { text: string }) => segment.text)).toEqual(["replacement audio"]);
  } finally { reader.mockRestore(); speakers.mockRestore(); }
});

it("finishes a legacy transcript left part-aligned without recognizing its audio again", async () => {
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const t = twoTurnTranscription();
  const linked = t.ctx.repos.transcripts.put({ id: "legacy", projectId: project.id, mediaId: t.media.id, language: "en", provider: "whispercpp",
    localModel: "custom", modelLabel: "fixture", createdAt: "2020-01-01T00:00:00.000Z", aligning: { through: 10.5 }, segments: [
      { id: "first", text: "hello", start: 10.1, end: 10.5, words: [{ text: "hello", start: 10.1, end: 10.5 }] },
      { id: "second", text: "again", start: 400, end: 401, words: [{ text: "again", start: 400, end: 400.4 }] },
    ] });
  t.ctx.repos.projects.putMedia(project.id, { ...t.media, transcriptId: linked.id }, "ready");
  try {
    expect(await (await api("GET", "/media/speech/transcript")).json()).toMatchObject({ id: linked.id, aligning: { through: 10.5 } });
    while (t.ctx.pending.size) await Promise.allSettled([...t.ctx.pending]);
    expect(t.reader).not.toHaveBeenCalled();
    expect(t.linked()).toMatchObject({ segments: [{ id: "first", words: [{ start: 10.1 }] }, { id: "second", words: [{ start: 400.1 }] }] });
    expect(t.linked()?.aligning).toBeUndefined();
  } finally { t.restore(); }
});

it.each(["failure", "interruption"] as const)("keeps the complete transcript readable during a rerun, after %s, and until a retry commits", async outcome => {
  const { ctx } = workspace;
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", localModel: "custom", whisperCppPath: process.execPath } });
  let reached!: () => void, resume!: () => void;
  const secondTurn = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const t = twoTurnTranscription(async turn => { if (turn === 2) { reached(); await gate; } });
  const old = ctx.repos.transcripts.put({ id: "previous", mediaId: t.media.id, projectId: project.id, provider: "whispercpp", localModel: "whispercpp",
    createdAt: "2020-01-01T00:00:00.000Z", speakerAnalysis: { version: speakerAnalysisVersion, count: 1 },
    segments: [{ id: "before", start: 1, end: 2, text: "Earlier reading", words: [{ text: "Earlier", start: 1, end: 1.2, speaker: "Speaker 1" }] }] });
  // Older libraries could have a readable transcript without a transcriptId on their media row.
  const priorHistory = outcome === "failure" ? { completedAt: old.createdAt, model: "Whisper large-v3-turbo" } : undefined;
  if (priorHistory) ctx.repos.projects.putMedia(project.id, { ...t.media, transcriptId: old.id, lastTranscription: priorHistory }, "ready");
  const peer = openWorkspace();
  const read = async () => (await peer.app.request(`/api/media/${t.media.id}/transcript`, { headers: { Authorization: `Bearer ${accessToken(peer.ctx)}` } })).json();
  const ask = () => api("POST", `/media/${t.media.id}/transcribe`, {});
  try {
    const first = await ask();
    expect(first.status).toBe(202);
    const { task } = await first.json();
    const job = ctx.transcriptions.get(task.id)!;
    await secondTurn;
    expect(await read()).toMatchObject({ id: old.id, localModel: old.localModel, segments: old.segments });
    expect(peer.ctx.repos.projects.getMedia(t.media.id)?.lastTranscription).toEqual(priorHistory);
    expect(await (await ask()).json()).toMatchObject({ task: { id: task.id, state: "running" } });
    expect(ctx.repos.transcripts.count("media_id = ?", [t.media.id])).toBe(1);
    if (outcome === "failure") peer.ctx.repos.settings.update({ transcription: { localModel: "whispercpp" } });
    else job.controller.abort(new Error("Scarlet quit while aligning."));
    resume();
    await expect(job.done).rejects.toThrow(outcome === "failure" ? "local model" : "Scarlet quit");
    expect(t.task().state).toBe("failed");
    expect(t.task().interrupted).toBe(outcome === "interruption" || undefined);
    expect(await read()).toMatchObject({ id: old.id, localModel: old.localModel, segments: old.segments });
    expect(peer.ctx.repos.projects.getMedia(t.media.id)?.lastTranscription).toEqual(priorHistory);
    recoverTasks(ctx);
    if (outcome === "failure") {
      expect(t.task().id).toBe(task.id);
      peer.ctx.repos.settings.update({ transcription: { localModel: "custom" } });
      expect((await ask()).status).toBe(202);
    }
    while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
    expect(t.task()).toMatchObject({ state: "done", context: { localModel: "custom" } });
    expect(t.reader).toHaveBeenCalledTimes(outcome === "interruption" ? 1 : 2);
    const replacement = await read();
    expect(replacement.id).not.toBe(old.id);
    expect(peer.ctx.repos.projects.getMedia(t.media.id)?.lastTranscription).toEqual({
      completedAt: t.task().finishedAt, model: `Model not reported by ${basename(process.execPath)}`,
    });
    expect(replacement).toMatchObject({ localModel: "custom", segments: [{ words: [{ text: "hello", start: 10.1 }] }, { words: [{ text: "again", start: 400.1 }] }] });
    expect(ctx.repos.transcripts.get(old.id)).toEqual(old);
  } finally { resume(); t.restore(); await peer.ctx.close(); }
});

it("stops the old model's alignment after a peer changes the selected local model", async () => {
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const peer = openWorkspace();
  const t = twoTurnTranscription(turn => {
    if (turn === 2) peer.ctx.repos.settings.update({ transcription: { localModel: "crisperwhisper" } });
  });
  try {
    await expect(transcribeMedia(t.ctx, project.id, t.media)).rejects.toThrow("local model");
    expect(t.task()).toMatchObject({ state: "failed", context: { localModel: "custom" } });
    expect(t.task().interrupted).toBeUndefined();
    expect(t.linked()).toMatchObject({ localModel: "custom", segments: [{ words: [{ start: 10.1 }] }, { words: [{ start: 400 }] }] });
    expect(t.linked()?.aligning).toBeUndefined();
  } finally { t.restore(); await peer.ctx.close(); }
});

it("keeps the times a transcript has when its alignment fails or can't be finished", async () => {
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const t = twoTurnTranscription(turn => { if (turn === 2) throw new Error("The aligner stopped."); });
  try {
    const transcript = await transcribeMedia(t.ctx, project.id, t.media);
    expect(transcript).toMatchObject({ segments: [{ words: [{ start: 10.1 }] }, { words: [{ start: 400 }] }] });
    expect(transcript?.aligning).toBeUndefined();
    expect(t.task().state).toBe("done");
    while (t.ctx.pending.size) await Promise.all([...t.ctx.pending]);
    // A transcript left marked by a run that is gone, with transcription since turned off: reading it settles the mark.
    const id = t.ctx.repos.projects.getMedia(t.media.id)!.transcriptId!;
    t.ctx.repos.transcripts.put({ ...t.ctx.repos.transcripts.get(id)!, aligning: { through: 10.5 } });
    await api("PATCH", "/settings", { transcription: { provider: "none" } });
    expect((await (await api("GET", "/media/speech/transcript")).json()).aligning).toEqual({ through: 10.5 });
    expect((await (await api("GET", "/media/speech/transcript")).json()).aligning).toBeUndefined();
    expect(t.reader).toHaveBeenCalledTimes(1);
  } finally { t.restore(); }
});

it("publishes a replacement once with the available word times when optional alignment stops partway", async () => {
  const { ctx } = workspace;
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", localModel: "custom", whisperCppPath: process.execPath } });
  const t = twoTurnTranscription(turn => { if (turn === 2) throw new Error("Optional aligner unavailable"); });
  const old = ctx.repos.transcripts.put({ id: "prior", mediaId: t.media.id, projectId: project.id, provider: "openai", segments: [] });
  ctx.repos.projects.putMedia(project.id, { ...t.media, transcriptId: old.id }, "ready");
  try {
    const replacement = await transcribeMedia(ctx, project.id, t.media);
    expect(replacement?.id).not.toBe(old.id);
    expect(replacement).toMatchObject({ localModel: "custom", segments: [{ words: [{ start: 10.1 }] }, { words: [{ start: 400 }] }] });
    expect(replacement?.aligning).toBeUndefined();
    expect(t.task().state).toBe("done");
    expect(ctx.repos.transcripts.get(old.id)).toEqual(old);
  } finally { t.restore(); }
});

it("removes a partial shared WAV when decoding fails before Whisper starts", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", name: "Interview", path: "interview.wav", kind: "audio" }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), media.path), "source");
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const decode = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_file, wav) => {
    writeFileSync(wav, "partial");
    throw new Error("decode failed");
  });
  try {
    await expect(transcribeMedia(ctx, project.id, media)).rejects.toThrow("decode failed");
    expect(existsSync(decode.mock.calls[0]![1])).toBe(false);
  } finally { decode.mockRestore(); }
});
const marker = [{ op: "addMarker", marker: { id: "marker", time: 0, text: "Start" } }];

it("reads independent normalized snapshots, including after rolling back a cached version", () => {
  const { ctx } = workspace;
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 3 }]), { parent: null });
  const load = () => ctx.repos.versions.get(project.id, version)!.timeline;
  const sql = ctx.db.prepare("UPDATE timeline_versions SET json = ? WHERE project_id = ? AND version = ?");
  const legacy = load();
  const raw = JSON.parse(JSON.stringify(legacy));
  delete raw.tracks[0].clips[0].volume;
  sql.run(JSON.stringify(raw), project.id, version);
  load().tracks[0]!.clips.length = 0;
  expect(load().tracks[0]!.clips[0]).toMatchObject({ volume: 1 });
  expect(() => ctx.db.transaction(() => {
    sql.run(JSON.stringify({ ...raw, name: "Temporary" }), project.id, version);
    expect(load().name).toBe("Temporary");
    throw Error("rollback");
  })()).toThrow("rollback");
  expect(load().name).toBe(legacy.name);
});

it("validates successive playback windows from one plan and replans after a frame-rate change", async () => {
  const { ctx } = workspace;
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 45 }]), { parent: null });
  ctx.repos.projects.update(project.id, { head: version });
  vi.spyOn(ctx.renders, "request").mockImplementation(input => ({ ...input, id: "fragment", key: "key", state: "queued", path: null, progress: 0 }));
  const read = vi.spyOn(ctx.repos.versions, "get");
  const request = (start: number, end: number) => api("POST", projectsPath() + "/renders",
    { kind: "playback", quality: "preview", version, range: { start, end } });
  expect((await request(0, 4)).status).toBe(201);
  expect((await request(4, 8)).status).toBe(201);
  expect((await request(10, 20)).status).toBe(201);
  expect((await request(4, 9)).status).toBe(400);
  expect(read).toHaveBeenCalledTimes(1);
  ctx.repos.projects.update(project.id, { settings: { fps: 29.97 } });
  expect((await request(0, 4)).status).toBe(400);
  expect(read).toHaveBeenCalledTimes(2);
});

it("serves a waiting playback file on completion and releases abandoned readers", async () => {
  const { ctx } = workspace;
  const render = ctx.repos.renders.put({ id: "waiting", projectId: project.id, version: "v1", key: "key",
    kind: "playback", state: "running", path: null, progress: 0, range: { start: 0, end: 2 } });
  const file = "/renders/" + render.id + "/file";
  expect((await api("GET", file)).status).toBe(404);
  const listeners = ctx.bus.listenerCount("render.finished");
  const abort = new AbortController();
  const abandoned = workspace.app.request("/api" + file + "?wait=1", {
    headers: { Authorization: `Bearer ${accessToken(ctx)}` }, signal: abort.signal,
  });
  const watching = api("GET", file + "?wait=1");
  await vi.waitFor(() => expect(ctx.bus.listenerCount("render.finished")).toBe(listeners + 2));
  abort.abort();
  expect((await abandoned).status).toBe(499);
  expect(ctx.bus.listenerCount("render.finished")).toBe(listeners + 1);
  mkdirSync(ctx.paths.renders(project.id), { recursive: true });
  writeFileSync(join(ctx.paths.renders(project.id), "ready.mp4"), "fragment");
  ctx.repos.renders.put({ ...render, state: "done", path: "ready.mp4" });
  ctx.bus.renderFinished({ renderId: render.id, projectId: project.id, state: "done" });
  expect(await (await watching).text()).toBe("fragment");
  expect(ctx.bus.listenerCount("render.finished")).toBe(listeners);
});

it("stops an abandoned playback encode only after its last reader disconnects", async () => {
  const { ctx } = workspace;
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]), { parent: null });
  const encode = vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _t, _r, _c, file, opts) => {
    writeFileSync(file, "partial fragment");
    await new Promise(resolve => opts.signal!.addEventListener("abort", resolve, { once: true }));
  });
  const view = (signal: AbortSignal) => workspace.app.request("/api" + projectsPath() + "/renders?wait=1", {
    method: "POST", signal, headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "playback", quality: "preview", version, range: { start: 0, end: 4 } }),
  });
  const first = new AbortController(), second = new AbortController();
  const a = view(first.signal), b = view(second.signal);
  await vi.waitFor(() => expect(ctx.bus.listenerCount("render.finished")).toBeGreaterThanOrEqual(2));
  expect(encode).toHaveBeenCalledTimes(1);
  first.abort();
  expect((await a).status).toBe(499);
  const signal = encode.mock.calls[0]![5].signal!;
  expect(signal.aborted).toBe(false);
  second.abort();
  expect((await b).status).toBe(499);
  await Promise.all([...ctx.pending]);
  expect(signal.aborted).toBe(true);
  expect(ctx.repos.renders.select("kind='playback'")[0]?.state).toBe("cancelled");
  expect(existsSync(encode.mock.calls[0]![4])).toBe(false);
});

it("pins the export range and options and only reuses a matching file", async () => {
  const { ctx } = workspace;
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 12 }]), { parent: null });
  const encode = vi.spyOn(ctx.render, "renderFullCached");
  const input = { kind: "export", version, quality: "delivery", range: { start: 2, end: 3 },
    owner: crypto.randomUUID(), exportOptions: { height: 720, omitCaptions: true } };
  const request = (body: typeof input) => api("POST", projectsPath() + "/renders", body);
  expect((await request({ ...input, range: { start: 2, end: 20 } })).status).toBe(400);
  const response = await request(input);
  expect(response.status).toBe(201);
  const { render } = await response.json();
  await Promise.all([...ctx.pending]);
  expect(ctx.repos.renders.get(render.id)).toMatchObject({ state: "done", height: 720, durationSeconds: 1 });
  expect(encode.mock.calls[0]?.[4]).toMatchObject({ exportRange: input.range, exportHeight: 720, omitCaptions: true });
  expect((await (await request(input)).json()).render.id).toBe(render.id);
  expect((await (await request({ ...input, exportOptions: { height: 720, omitCaptions: false } })).json()).render.id).not.toBe(render.id);
});

it("puts pending playback ahead of exports and preserves other export owners", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { concurrency: 1 } });
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]), { parent: null });
  const input = { projectId: project.id, version, kind: "full", quality: "delivery", range: null } as const;
  const order: string[] = [];
  let unblock!: () => void;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_p, _t, _r, file) => {
    await new Promise<void>(resolve => { unblock = resolve; });
    writeFileSync(file, "review");
  });
  vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _t, _r, _c, file) => {
    order.push("playback"); writeFileSync(file, "fragment");
  });
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => {
    order.push("export"); writeFileSync(file, "delivery");
  });
  ctx.renders.request({ ...input, kind: "segment", range: { start: 1, end: 3 } });
  const active = ctx.renders.request(input, "first");
  expect(ctx.renders.request(input, "second").id).toBe(active.id);
  ctx.renders.release(active.id, "first");
  ctx.renders.release(active.id, "unknown");
  expect(ctx.repos.renders.get(active.id)?.state).toBe("queued");
  ctx.renders.request(input); // Durable owner joins before the last native export is cancelled.
  ctx.renders.release(active.id, "second");
  expect(ctx.repos.renders.get(active.id)?.state).toBe("queued");
  ctx.renders.request({ ...input, kind: "playback", quality: "preview", range: { start: 0, end: 10 } }, "viewer");
  unblock();
  await vi.waitFor(() => expect(order).toEqual(["playback", "export"]));
});

it("yields the automatic cut cache to playback and resumes the same job", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { concurrency: 1 } });
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]), { parent: null });
  const order: string[] = [];
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _tl, _dir, file, { signal, onCachedRanges }) => {
    order.push("cache");
    if (order.length === 1) {
      onCachedRanges?.([{ start: 8, end: 12 }]);
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return;
    }
    writeFileSync(file, "preview");
  });
  vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _tl, _range, _dir, file) => {
    order.push("playback"); writeFileSync(file, "fragment");
  });
  const owner = crypto.randomUUID();
  const input = { version, kind: "full", quality: "preview", owner };
  const endpoint = projectsPath() + "/renders";
  const response = await api("POST", endpoint, input);
  expect(response.status).toBe(201);
  const { render } = await response.json();
  expect(ctx.repos.renders.get(render.id)?.cachedRanges).toEqual([{ start: 8, end: 12 }]);
  const other = crypto.randomUUID();
  expect((await (await api("POST", endpoint, { ...input, owner: other })).json()).render.id).toBe(render.id);
  await api("DELETE", `/renders/${render.id}/owners/${owner}`);
  ctx.renders.request({ projectId: project.id, version, kind: "playback", quality: "preview", range: { start: 0, end: 10 } }, "viewer");
  await vi.waitFor(() => expect(ctx.repos.renders.get(render.id)?.state).toBe("done"));
  expect(order).toEqual(["cache", "playback", "cache"]);
  expect((await (await api("POST", endpoint, input)).json()).render.id).toBe(render.id);
});

it("keeps an archive across restarts and restores trashed projects to the active library", async () => {
  const path = projectsPath();
  const patch = await api("PATCH", path, { archived: true });
  expect((await patch.json()).project.archived).toBe(true);
  await workspace.ctx.close();
  workspace = openWorkspace();
  const list = async () => (await (await api("GET", "/projects")).json()).projects;
  expect(await list()).toMatchObject([{ id: project.id, archived: true }]);
  expect((await api("GET", path)).status).toBe(200);
  await api("PATCH", path, { name: "Finished interview" });
  expect(await list()).toMatchObject([{ archived: true, name: "Finished interview" }]);
  await api("PATCH", path, { archived: false });
  expect(await list()).toMatchObject([{ archived: false }]);
  await api("PATCH", path, { archived: true });
  await api("DELETE", path);
  expect(await list()).toEqual([]);
  await api("POST", path + "/restore");
  expect(await list()).toMatchObject([{ id: project.id, archived: false }]);
});

it("counts only edit threads ready for a decision in both project summaries", async () => {
  const { ctx } = workspace;
  const camera = createTask(ctx, {
    projectId: project.id, kind: "edit", agent: "codex", instruction: "Frame the camera",
    createdBy: { type: "human", name: "Editor" },
  });
  const draft: Change = {
    id: "draft", projectId: project.id, threadId: camera.id, description: "Camera framing",
    fromVersion: "start", toVersion: "framed", author: camera.createdBy, ranges: [], renders: [],
    noteIds: [], state: "revising", createdAt: new Date(0).toISOString(),
  };
  for (let i = 0; i < 6; i++) ctx.repos.changes.put({ ...draft, id: `draft-${i}` });
  const latest = ctx.repos.changes.put({ ...draft, id: "latest", state: "ready", createdAt: new Date(1000).toISOString() });
  const count = async (expected: number) => {
    expect((await (await api("GET", "/projects")).json()).projects).toMatchObject([{ pendingChanges: expected }]);
    expect((await (await api("GET", projectsPath())).json()).summary.pendingChanges).toBe(expected);
  };

  const reads = vi.spyOn(ctx.repos.changes, "select");
  await count(0); // The editing task is still working.
  expect(reads).toHaveBeenCalledTimes(1);
  ctx.db.prepare("UPDATE tasks SET worker_seen_at = ? WHERE id = ?").run(new Date().toISOString(), camera.id);
  ctx.repos.tasks.put({ ...camera, id: "speech", kind: "transcribe" });
  await count(0);
  expect(reads).toHaveBeenCalledTimes(1);
  ctx.repos.tasks.put({ ...camera, state: "done" });
  await count(1);
  ctx.repos.changes.put({ ...latest, state: "approved" });
  await count(0);
  // An older ready draft can coexist with a newer, already-decided attempt.
  ctx.repos.changes.put({ ...draft, state: "ready" });
  ctx.repos.changes.put({ ...latest, id: "separate", threadId: "intro", state: "ready" });
  await count(1);
});

it("serves the monitor snapshot with live media status without reading review history", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Camera", path: "camera.mov", kind: "video" }, "ingesting");
  const inventory = vi.spyOn(ctx.repos.projects, "listMedia");
  const summaries = vi.spyOn(ctx.repos.projects, "summaries");
  const result = await (await api("GET", projectsPath() + "?view=workspace")).json();
  expect(result).toMatchObject({ project: { media: [{ id: "camera", status: "ingesting" }] }, timeline: null });
  expect(inventory).toHaveBeenCalledTimes(1);
  expect(summaries).not.toHaveBeenCalled();
});

it("keeps the editor's chosen format when the first imported video finishes later", async () => {
  const expectedFormat = { head: project.head, settings: project.settings };
  await api("PATCH", projectsPath(), { settings: { width: 1280, height: 720 } });
  const result = await (await api("PATCH", projectsPath(), { expectedFormat, settings: { width: 3840, height: 2160 } })).json();
  expect(result.project.settings).toMatchObject({ width: 1280, height: 720 });
});

it("estimates first-cut time from comparable completed requests only", () => {
  const { ctx } = workspace;
  const make = (message: string, skillIds?: string[]) => createTask(ctx, {
    projectId: project.id, kind: "edit", agent: "codex", model: "sample", instruction: message, context: { message, skillIds },
    createdBy: { type: "human", name: "Editor" },
  });
  for (const seconds of [70, 90, 80]) {
    const task = make("Edit the dialogue", ["skl_cut", "skl_rules"]);
    expect(task.expectedSeconds).toBeUndefined();
    ctx.repos.tasks.put({ ...task, state: "done", startedAt: new Date(0).toISOString(), finishedAt: new Date(seconds * 1000).toISOString() });
  }
  // Keyed by the selected skills, not the request's wording.
  expect(make("Make first cut", ["skl_rules", "skl_cut"]).expectedSeconds).toBe(80);
  expect(make("Make first cut").expectedSeconds).toBeUndefined();
  expect(make("Make first cut", ["skl_cut"]).expectedSeconds).toBeUndefined();
});

it("attaches a delayed note to the current cut without replacing the first approved edit", async () => {
  let approvedHead: string | undefined;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const response = await api("POST", projectsPath() + "/changes", {
        description: "First approved cut", ops: marker, autoApprove: true, skipRender: true,
      });
      expect(response.status).toBe(201);
      approvedHead = (await response.json()).change.toVersion;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ time: 0, text: "Review the opening" })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const note = new Request(`http://localhost/api${projectsPath()}/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, "Content-Type": "application/json" },
    body, duplex: "half",
  } as RequestInit);

  const response = await workspace.app.request(note);
  expect(response.status).toBe(201);
  expect(approvedHead).toBeTruthy();
  expect((await response.json()).note.version).toBe(approvedHead);
  expect(workspace.ctx.repos.projects.header(project.id)?.head).toBe(approvedHead);
});

it("keeps the head another engine set while creating the first timeline version", async () => {
  const { ctx } = workspace;
  const other = openWorkspace();
  const insert = ctx.repos.versions.insert.bind(ctx.repos.versions);
  let winner: string | undefined;
  vi.spyOn(ctx.repos.versions, "insert").mockImplementationOnce(row => {
    // The second connection wins between the first connection's empty-head read and insert.
    const proposal = proposeChange(other.ctx, localUser(other.ctx), project.id, {
      description: "First cut", autoApprove: true, skipRender: true,
      ops: [{ op: "addMarker", marker: { id: "winner", time: 0, text: "Opening" } }],
    });
    winner = proposal.change.toVersion;
    return insert(row);
  });
  try {
    const current = ensureHead(ctx, project.id);
    expect(winner).toBeTruthy();
    expect(current.head).toBe(winner);
    expect(current.timeline.markers[0]?.id).toBe("winner");
    expect(ctx.repos.versions.list(project.id)).toHaveLength(2);
  } finally {
    await other.ctx.close();
  }
});

it("publishes proposals only after commit and discards their events on rollback", async () => {
  const { ctx } = workspace;
  const { timeline: base } = ensureHead(ctx, project.id);
  const reader = new Db(ctx.paths.db);
  const events: string[] = [];
  const visible: boolean[] = [];
  ctx.bus.on("ws", event => {
    events.push(event.type);
    if (event.type === "change.updated") {
      visible.push(!!reader.prepare("SELECT 1 FROM changes WHERE id = ?").get(event.change.id));
    }
  });
  try {
    const accepted = await api("POST", projectsPath() + "/changes", {
      description: "Move head", ops: marker, autoApprove: true, skipRender: true,
    });
    expect(accepted.status).toBe(201);
    expect(visible).toEqual([true, true]);
    events.length = 0;
    const rejected = await api("POST", projectsPath() + "/changes", {
      description: "Replace an older cut", fromVersion: base.version, autoApprove: true,
      timeline: { ...base, tracks: base.tracks.map(track => track.kind === "video"
        ? { ...track, clips: [{ id: "opening", kind: "color", color: "#ffffff", timelineIn: 0, timelineOut: 2 }] }
        : track) },
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.code).toBe("needs_redo");
    expect(ctx.repos.changes.count()).toBe(1);
    expect(ctx.repos.renders.count()).toBe(0);
    expect(events).toEqual([]);
  } finally {
    reader.close();
  }
});

it("discards a render worker and its notifications when a render request rolls back", () => {
  const { ctx } = workspace;
  const { head } = ensureHead(ctx, project.id);
  const encode = vi.spyOn(ctx.render, "renderFullCached");
  const publish = vi.fn();
  ctx.bus.on("ws", publish);
  const write = ctx.db.transaction(() => {
    ctx.renders.request({ projectId: project.id, version: head, kind: "full", quality: "delivery", range: null });
    throw new Error("rollback");
  });
  expect(write).toThrow("rollback");
  expect(ctx.repos.renders.count()).toBe(0);
  expect(encode).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it("cuts a screen and a synced camera together, and hands the editor the cut Scarlet wasn't sure of on both", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  ctx.repos.projects.putMedia(project.id, { id: "screen", kind: "video", name: "Screen", path: "screen.mp4", duration: 20, hasAudio: true }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Camera", path: "camera.mp4", duration: 17, hasAudio: true }, "ready");
  const pass = (await (await api("POST", projectsPath() + "/tasks", { agent: "codex", instruction: "/first-cut-dialogue" })).json()).task as Task;
  // The first-cut tool lays both out whole: the camera started 2 s after the screen and is the sound.
  const whole = timelineFromKeepRanges(project.id, "screen", [{ start: 0, end: 20 }],
    { layer: { mediaId: "camera", offset: 2, duration: 17, sound: true, transform: Transform.parse({ scale: 0.25, x: 0.35, y: 0.35 }) } });
  const assembled = await api("POST", projectsPath() + "/changes", { intent: "requested", taskId: pass.id, firstCut: true, description: "Assemble", timeline: whole });
  expect(assembled.status).toBe(201);
  const base = (await assembled.json()).change.toVersion as string;
  expect(ctx.repos.projects.get(project.id)?.head).toBe(base);
  const current = () => ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  const places = (timeline: ReturnType<typeof current>, track: string) => timeline.tracks.find(t => t.id === track)!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]);
  const saved = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Pass",
    cuts: [{ start: 5, end: 6, review: false, reason: "a restart" }, { start: 12, end: 13, review: true, reason: "may be the better take" }] });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const changes = (await saved.json()).changes as Change[];
  // The cut Scarlet was sure of is out of both recordings at the same moment.
  const applied = current();
  expect(places(applied, "v1")).toEqual([[0, 0, 5], [5, 6, 20]]);
  expect(places(applied, "v2")).toEqual([[2, 0, 3], [5, 4, 17]]);
  // The other is a call, and Approve takes it out of both as well.
  const staged = changes.find(c => c.state === "ready")!;
  const { review } = await (await api("POST", `/changes/${staged.id}/cut-review`, {})).json();
  expect(review.cuts).toHaveLength(1);
  expect((await api("POST", `/changes/${staged.id}/approve`, { restoredCuts: [] })).status).toBe(200);
  const done = current();
  expect(places(done, "v1")).toEqual([[0, 0, 5], [5, 6, 12], [11, 13, 20]]);
  expect(places(done, "v2")).toEqual([[2, 0, 3], [5, 4, 10], [11, 11, 17]]);
});

it("previews staged restorations, applies that exact version once, and refuses a stale review", async () => {
  workspace.ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Interview", path: "a.mp4", duration: 15 }, "ready");
  const timeline = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 2 }, { start: 4, end: 7 }, { start: 10, end: 15 }]);
  const proposal = await api("POST", projectsPath() + "/changes", { description: "First cut", timeline });
  expect(proposal.status).toBe(201);
  const { change } = await proposal.json();
  const path = "/changes/" + change.id;
  const preview = await api("POST", path + "/cut-review", { restoredCuts: [0] });
  expect(preview.status).toBe(200);
  const { review, draft } = await preview.json();
  expect(review.cuts).toHaveLength(2);
  expect(review.original.version).not.toBe(change.fromVersion);
  expect(draft.tracks[0].clips).toMatchObject([{ sourceIn: 0, sourceOut: 7 }, { sourceIn: 10, sourceOut: 15 }]);
  const onlyDraft = await api("POST", path + "/cut-review?view=draft", { restoredCuts: [0] });
  expect(await onlyDraft.json()).toEqual({ draft });
  // A version can disappear independently of the in-memory selection cache.
  workspace.ctx.db.prepare("DELETE FROM timeline_versions WHERE project_id = ? AND version = ?").run(project.id, draft.version);
  const reopened = await api("POST", path + "/cut-review?view=draft", { restoredCuts: [0] });
  expect((await reopened.json()).draft).toMatchObject({ version: draft.version, tracks: draft.tracks });
  expect(workspace.ctx.repos.projects.get(project.id)?.head).toBe(change.fromVersion);
  expect((await api("POST", path + "/approve", { restoredCuts: [99] })).status).toBe(400);
  const result = await (await api("POST", path + "/approve", { restoredCuts: [0] })).json();
  expect(result.project.head).toBe(draft.version);
  expect(result.change.restoredCuts).toEqual([0]);
  expect(result.change.appliedReview.joins).toEqual([{ at: 7, removed: { start: 7, end: 10 } }]);
  const detail = await (await api("GET", path)).json();
  expect(detail.diff.durationAfter).toBe(12);
  expect((await (await api("POST", path + "/approve", { restoredCuts: [0] })).json()).project.head).toBe(draft.version);
  expect((await api("POST", path + "/approve", { restoredCuts: [1] })).status).toBe(409);
  await api("POST", path + "/unapprove", {});
  const other = await (await api("POST", projectsPath() + "/changes", { description: "Marker", ops: marker })).json();
  await api("POST", "/changes/" + other.change.id + "/approve", {});
  expect((await api("POST", path + "/approve", { restoredCuts: [0] })).status).toBe(409);
  expect(workspace.ctx.repos.projects.get(project.id)?.head).toBe(other.change.toVersion);
});

it("loads library counts and the first video poster without reading each project's asset list", async () => {
  const { repos } = workspace.ctx;
  const add = (id: string, kind: "video" | "audio") =>
    repos.projects.putMedia(project.id, { id, kind, name: id, path: id, duration: 2 }, "ready");
  add("sound", "audio"); add("camera-a", "video"); add("camera-b", "video");
  const empty = repos.projects.insert(createProject("Empty"));
  const deleted = repos.projects.insert(createProject("Deleted"));
  repos.projects.softDelete(deleted.id);
  const list = vi.spyOn(repos.projects, "listMedia");
  const result = await (await api("GET", "/projects")).json();
  expect(list).not.toHaveBeenCalled();
  expect(result.projects).toHaveLength(2);
  expect(result.projects).toContainEqual(expect.objectContaining({ id: project.id, mediaCount: 3, poster: { mediaId: "camera-a", time: 1 } }));
  expect(result.projects).toContainEqual(expect.objectContaining({ id: empty.id, mediaCount: 0, poster: null }));
});

it("slices saved transcripts at exclusive page boundaries, including legacy unlinked media", async () => {
  const { ctx } = workspace;
  const media = ctx.repos.projects.putMedia(project.id, { id: "voice", kind: "audio", name: "Voice", path: "voice.wav" }, "ready");
  const segments = [0, 60, 120].map(start => ({ id: "s" + start, start, end: start + 60, text: "hello",
    words: [{ start, end: start + 1, text: "hello" }] }));
  ctx.repos.transcripts.put({ id: "tr_voice", mediaId: media.id, projectId: project.id, segments });
  const url = "/media/voice/transcript?from=60&to=120";
  expect((await (await api("GET", url)).json()).segments).toEqual([segments[1]]);
  expect((await (await api("GET", url + "&granularity=segment")).json()).segments).toEqual([{ ...segments[1], words: [] }]);
  expect((await (await api("GET", "/media/voice/transcript?from=240")).json()).segments).toEqual([]);
});

it("automatically backfills an unlinked transcript once and retains its original revision", async () => {
  const { ctx } = workspace;
  const media = ctx.repos.projects.putMedia(project.id, { id: "speaker-audio", kind: "audio", name: "Call", path: "call.wav" }, "ready");
  const original = { id: "old", mediaId: media.id, projectId: project.id, segments: [
    { id: "seg", start: 0, end: 1, text: "hello", words: [{ text: "hello", start: 0, end: 1 }] },
  ] };
  ctx.repos.transcripts.put(original);
  const turns = vi.spyOn(ctx.speakers, "turns").mockResolvedValue([{ start: 0, end: 1, speaker: 1 }]);
  const read = async () => (await api("GET", "/media/speaker-audio/transcript?from=0&to=1")).json();
  await api("PATCH", "/settings", { transcription: { provider: "none" } });
  expect((await read()).id).toBe("old");
  expect(turns).not.toHaveBeenCalled();
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp" } });
  await Promise.all([read(), read()]);
  await vi.waitFor(() => expect(ctx.repos.projects.getMedia(media.id)?.transcriptId).toBeTruthy());
  expect(await read()).toMatchObject({ speakerAnalysis: { version: 3, count: 1 }, segments: [{ words: [{ text: "hello", start: 0, end: 1, speaker: "Speaker 1" }] }] });
  expect(ctx.repos.transcripts.get("old")?.segments).toEqual(original.segments);
  expect(turns).toHaveBeenCalledTimes(1);
});

it("keeps conversation events ordered and reserves the complete log for the default task endpoint", async () => {
  const { ctx } = workspace;
  let task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Edit", createdBy: { type: "human", name: "Editor" } });
  task = appendTaskEvent(ctx, task, { type: "log", text: "Comparing the recordings.", data: { kind: "editor_progress" } }).task;
  for (const type of ["log", "question", "answer", "tool"] as const) task = appendTaskEvent(ctx, task, { type, text: type }).task;
  const url = "/tasks/" + task.id;
  expect((await (await api("GET", url + "?events=conversation")).json()).events.map((e: { text: string }) => e.text)).toEqual(["Comparing the recordings.", "question", "answer"]);
  expect((await (await api("GET", url)).json()).events.map((e: { text: string }) => e.text)).toEqual(["Comparing the recordings.", "log", "question", "answer", "tool"]);
  const other = ctx.repos.projects.insert(createProject("Other project"));
  const foreign = createTask(ctx, { ...task, projectId: other.id });
  appendTaskEvent(ctx, foreign, { type: "question", text: "Other project question" });
  const quiet = createTask(ctx, task);
  const list = projectsPath() + "/tasks";
  const saved = await (await api("GET", list + "?events=conversation")).json();
  expect(Object.keys(saved.conversation).sort()).toEqual([task.id, quiet.id].sort());
  expect(saved.conversation[task.id]).toEqual((await (await api("GET", url + "?events=conversation")).json()).events);
  expect(saved.conversation[quiet.id]).toEqual([]);
  expect((await (await api("GET", list)).json()).conversation).toBeUndefined();
});

it("reads peak-only JSON waveforms from existing libraries", async () => {
  const { ctx } = workspace;
  const media = ctx.repos.projects.putMedia(project.id, { id: "voice", kind: "audio", name: "Voice", path: "voice.wav", duration: 2 }, "ready");
  ctx.paths.ensureProject(project.id);
  writeFileSync(join(ctx.paths.waveforms(project.id), `${media.id}.json`), JSON.stringify({
    pointsPerSecond: 1, duration: 2, peaks: [0.125, 0.75],
  }));
  const response = await api("GET", `/media/${media.id}/waveform?points=2`);
  expect(await response.json()).toEqual({ mediaId: media.id, from: 0, to: 2, peaks: [0.125, 0.75] });
});

it("prepares audio on demand, shares waveform extraction, and respects transcription settings", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const asset = ctx.repos.projects.putMedia(project.id, { id: "spoken", kind: "audio", name: "Interview", path: "voice.wav", duration: 2, hasAudio: true }, "ingesting");
  const prepare = (kind: string, projectId = project.id) => api("POST", `/projects/${projectId}/media/${asset.id}/prepare`, { kind });
  const other = ctx.repos.projects.insert(createProject("Other"));
  expect((await prepare("waveform", other.id)).status).toBe(404);
  const off = await prepare("transcript");
  expect(await off.json()).toMatchObject({ error: { code: "transcription_unavailable" } });
  expect(ctx.repos.tasks.select()).toHaveLength(0);

  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const extract = vi.spyOn(ctx.render, "extractWaveformFull").mockImplementation(async () => {
    await gate;
    return { peaks: [0.5] };
  });
  const requests = Promise.all([prepare("waveform"), prepare("waveform")]);
  try {
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
  } finally {
    finish();
  }
  expect((await requests).map(r => r.status)).toEqual([200, 200]);
  expect((await prepare("waveform")).status).toBe(200);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(await (await api("GET", `/media/${asset.id}/waveform?points=1`)).json()).toMatchObject({ peaks: [0.5] });
  // While the project's media work is paused, a waveform read for the timeline waits for resume. One a running edit's
  // tools ask to have prepared is read: pausing the caching isn't stopping that edit.
  for (const id of ["drawn", "asked"]) ctx.repos.projects.putMedia(project.id, { id, kind: "audio", name: id, path: id + ".wav", duration: 2, hasAudio: true }, "ready");
  await api("PATCH", projectsPath(), { mediaPaused: true });
  expect((await api("GET", "/media/drawn/waveform?points=1")).status).toBe(404);
  expect((await api("POST", `/projects/${project.id}/media/asked/prepare`, { kind: "waveform" })).status).toBe(200);
  expect(extract).toHaveBeenCalledTimes(2);
  await api("PATCH", projectsPath(), { mediaPaused: false });
  // An edit's ask joins the build the timeline's drawing began, and the pause then leaves that build to finish. An
  // ask that lands as the pause is stopping that build has it read again.
  const joined = async (id: string, pausedFirst: boolean) => {
    ctx.repos.projects.putMedia(project.id, { id, kind: "audio", name: id, path: id + ".wav", duration: 2, hasAudio: true }, "ready");
    let decoded!: () => void;
    const decoding = new Promise<void>(resolve => { decoded = resolve; });
    // Like the real decode, it ends on its signal, a moment after the signal stops.
    extract.mockImplementation(async (_src, _duration, _points, _onProgress, signal) => {
      await decoding;
      signal?.throwIfAborted();
      return { peaks: [0.5] };
    });
    const before = extract.mock.calls.length;
    const pause = () => api("PATCH", projectsPath(), { mediaPaused: true });
    const drawn = api("GET", `/media/${id}/waveform?points=1`);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(before + 1));
    if (pausedFirst) await pause();
    const asked = api("POST", `/projects/${project.id}/media/${id}/prepare`, { kind: "waveform" });
    await vi.waitFor(() => expect(ctx.waveformsAsked.has(id)).toBe(true));
    if (!pausedFirst) await pause();
    decoded();
    const statuses = [(await asked).status, (await drawn).status];
    await api("PATCH", projectsPath(), { mediaPaused: false });
    return { statuses, decodes: extract.mock.calls.length - before };
  };
  expect(await joined("joined", false)).toEqual({ statuses: [200, 200], decodes: 1 });
  expect(await joined("stopping", true)).toEqual({ statuses: [200, 200], decodes: 2 });
  expect(ctx.waveformsAsked.size).toBe(0);

  ctx.env.openaiKey = "test";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  const transcribe = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  try {
    const started = await prepare("transcript");
    const { taskId } = await started.json();
    expect(started.status).toBe(202);
    await Promise.all(ctx.pending);
    expect(ctx.repos.tasks.get(taskId)?.state).toBe("done");
    expect(await (await prepare("transcript")).json()).toEqual({ state: "ready" });
    expect(transcribe).toHaveBeenCalledTimes(1);
  } finally {
    transcribe.mockRestore();
  }
});

it("applies activity filters and page limits before loading documents", async () => {
  const { activity } = workspace.ctx.repos;
  const dates = ["2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", "2025-01-03T00:00:00.000Z"];
  for (const projectId of [project.id, null]) {
    dates.forEach((createdAt, i) => activity.put({ id: `${projectId}-${i}`, projectId, createdAt,
      type: i === 1 ? "note.added" : "media.added", summary: "test", actor: { type: "scarlet", name: "Scarlet" }, data: {} }));
  }
  const parse = vi.spyOn(activity, "parse");
  const cases = [
    [projectsPath() + "/activity?type=media&limit=1.5", `${project.id}-2`],
    [`/activity?before=${dates[2]}&limit=1`, "null-1"],
  ] as const;
  for (const [path, id] of cases) {
    parse.mockClear();
    const response = await api("GET", path);
    expect((await response.json()).activity.map((a: { id: string }) => a.id)).toEqual([id]);
    expect(parse).toHaveBeenCalledTimes(1);
  }
});

it("uses the project frame rate for proposal previews and version diffs", async () => {
  const { repos } = workspace.ctx;
  repos.projects.update(project.id, { settings: { fps: 60 } });
  repos.projects.putMedia(project.id, { id: "take", kind: "video", name: "Take", path: "take.mp4", duration: 2 }, "ready");
  const changes = projectsPath() + "/changes";
  const seed = await api("POST", changes, {
    description: "First cut", autoApprove: true, skipRender: true,
    ops: [{ op: "addClip", trackId: "v1", clip: { id: "clip", kind: "media", mediaId: "take", sourceIn: 0, sourceOut: 2, timelineIn: 0 } }],
  });
  expect(seed.status).toBe(201);
  const { timeline } = await seed.json();
  const duplicate = { ...timeline, tracks: [...timeline.tracks, { ...timeline.tracks[0], id: "duplicate" }] };
  expect((await api("POST", changes, { description: "Invalid cut", timeline: duplicate })).status).toBe(400);
  const oneFrame = await api("POST", changes, {
    description: "Trim the second frame", skipRender: true,
    ops: [{ op: "rippleDelete", start: 1 / 60, end: 2 / 60 }],
  });
  expect(oneFrame.status).toBe(201);
  const { change } = await oneFrame.json();
  expect(change.ranges).toEqual([{ start: 1 / 60, end: 1 / 60 }]);
  const diff = await api("GET", projectsPath() + `/versions/${change.fromVersion}/diff/${change.toVersion}`);
  expect((await diff.json()).diff.beforeRanges).toEqual([{ start: 1 / 60, end: 2 / 60 }]);
});

it("reads the footage a change left out as it built the video, when it is applied and for one an earlier build applied", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "take", kind: "video", name: "Take", path: "take.mp4", duration: 60 }, "ready");
  const piece = (id: string, sourceIn: number, sourceOut: number, timelineIn: number) =>
    ({ op: "addClip", trackId: "v1", clip: { id, kind: "media", mediaId: "take", sourceIn, sourceOut, timelineIn } });
  // Scarlet places the pieces to keep: what came between them was never on the timeline.
  const built = await api("POST", projectsPath() + "/changes", { description: "Kept the opening", autoApprove: true, skipRender: true,
    ops: [piece("a", 5, 10, 0), piece("b", 20, 30, 5)], timelineEdits: [{ label: "Cut the aside", range: { start: 4.8, end: 5.2 } }] });
  expect(built.status).toBe(201);
  const { change } = await built.json();
  expect(change.leftOut.joins).toEqual([{ at: 0, removed: { start: 0, end: 5 } }, { at: 5, removed: { start: 10, end: 20 } }]);
  // The version that plays them is saved, so the cut's card has footage to show.
  const full = resolveTimeline(ctx, project, change.leftOut.version);
  expect(full.tracks[0]!.clips).toMatchObject([{ sourceIn: 0, sourceOut: 20, timelineIn: 0 }, { sourceIn: 20, sourceOut: 30, timelineIn: 20 }]);
  // The next part adds to the video. The join the first part made is not this part's, and stays shut in its version.
  const next = await api("POST", projectsPath() + "/changes", { description: "Kept the demo", autoApprove: true, skipRender: true, ops: [piece("c", 40, 50, 15)] });
  expect((await next.json()).change.leftOut.joins).toEqual([{ at: 15, removed: { start: 15, end: 25 } }]);
  // A step that leaves nothing out says so, and is not read again.
  const quiet = await api("POST", projectsPath() + "/changes", { description: "Lower the level", autoApprove: true, skipRender: true,
    ops: [{ op: "updateClip", clipId: "a", patch: { volume: 0.5 } }] });
  expect((await quiet.json()).change.leftOut).toEqual({ joins: [] });
  // A change an earlier build applied has nothing read. Starting Scarlet reads it, once.
  ctx.repos.changes.put({ ...change, leftOut: undefined });
  recordLeftOutFootage(ctx);
  expect(ctx.repos.changes.get(change.id)!.leftOut).toEqual(change.leftOut);
  const stamp = ctx.repos.changes.get(change.id)!.updatedAt;
  recordLeftOutFootage(ctx);
  expect(ctx.repos.changes.get(change.id)!.updatedAt).toBe(stamp);
});

it("fills in legacy history metadata once and serves the same version summaries thereafter", async () => {
  const { ctx } = workspace;
  const { head } = ensureHead(ctx, project.id);
  const versions = async () => (await (await api("GET", projectsPath() + "/versions")).json()).versions;
  const original = await versions();
  expect(original[0]).toMatchObject({ version: head, duration: 0, isHead: true });
  ctx.db.prepare("UPDATE timeline_versions SET duration = NULL, timeline_name = NULL WHERE project_id = ?").run(project.id);
  const read = vi.spyOn(ctx.repos.versions, "get");
  expect(await versions()).toEqual(original);
  expect(read).toHaveBeenCalledTimes(1);
  expect(await versions()).toEqual(original);
  expect(read).toHaveBeenCalledTimes(1);
});

it("queues footage requests only when their media and cut version belong to the destination project", async () => {
  const { ctx } = workspace;
  const other = ctx.repos.projects.insert(createProject("Other"));
  const version = ensureHead(ctx, project.id).head;
  const media = ctx.repos.projects.putMedia(project.id, { id: "take", kind: "audio", name: "Take", path: "take.wav" }, "ready");
  const request = (id: string, context: { version?: string; mediaId?: string }) =>
    api("POST", `/projects/${id}/tasks`, { kind: "edit", agent: "codex", instruction: "Trim this take", context });

  expect((await request(other.id, { mediaId: media.id })).status).toBe(400);
  expect((await request(other.id, { version })).status).toBe(400);
  expect(ctx.repos.tasks.select()).toHaveLength(0);
  const accepted = await request(project.id, { mediaId: media.id, version });
  expect(accepted.status).toBe(201);
  expect((await accepted.json()).task).toMatchObject({ projectId: project.id, context: { mediaId: media.id, version } });
});

it.skipIf(process.platform === "win32")("tightens the permissions of an existing token without rotating it", async () => {
  const token = accessToken(workspace.ctx);
  const file = workspace.ctx.paths.accessToken;
  chmodSync(file, 0o644);
  await workspace.ctx.close();
  workspace = openWorkspace();
  expect(accessToken(workspace.ctx)).toBe(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it("recovers an answered task saved by the old host protocol", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Resume", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.tasks.put({ ...task, hostId: "old-host", state: "running" });
  ctx.repos.taskEvents.append({ id: "old-answer", at: new Date().toISOString(), taskId: task.id, type: "answer", text: "Yes" });
  await ctx.close();
  workspace = openWorkspace();
  expect(workspace.ctx.repos.tasks.get(task.id)).toMatchObject({ hostId: null, question: null, state: "queued" });
  expect(workspace.ctx.repos.taskEvents.list(task.id)[0]?.text).toBe("Yes");
});

it("recovers dead workers, keeps saved proposals and lets follow-ups run exactly once", async () => {
  const { ctx } = workspace;
  const agent = "codex";
  const host = (await (await api("POST", "/hosts/register", { name: "Test", platform: "test", agents: [{
    id: agent, installed: true, models: ["test-model"],
    modelOptions: { "test-model": { efforts: [{ id: "high" }], speeds: [] } },
  }] })).json()).host;
  const claim = async (id?: string) => {
    const response = await api("POST", `/hosts/${host.id}/claim`, { taskId: id });
    expect(response.status).toBe(200);
    return (await response.json()).task;
  };
  // A project runs one request at a time, so the runs that are in flight together belong to different projects.
  const elsewhere = () => ctx.repos.projects.insert(createProject("Recovery fixture")).id;
  const make = (instruction: string, threadId?: string, projectId = project.id) => createTask(ctx, {
    projectId, kind: "edit", agent, model: "test-model", effort: "high", fast: true, instruction,
    createdBy: { type: "human", name: "Editor" }, context: { threadId, time: 6 },
  });
  const interrupted = make("Trim the pause");
  appendTaskEvent(ctx, await claim(interrupted.id), { type: "log", text: "Listening" });
  const follow = make("Tighten the intro", interrupted.id);
  const saved = make("Mark the ending", undefined, elsewhere());
  await claim(saved.id);
  const proposal = await api("POST", `/projects/${saved.projectId}/changes`, { description: "End", ops: marker, taskId: saved.id, skipRender: true });
  expect(proposal.status).toBe(201);
  const { change } = await proposal.json();
  // Simulate stopping between persisting the change and updating the task.
  ctx.repos.tasks.put({ ...ctx.repos.tasks.get(saved.id)!, changeIds: [] });
  const unstarted = make("Adjust the title", undefined, elsewhere());
  await claim(unstarted.id);
  const live = make("Still working", undefined, elsewhere());
  await claim(live.id);
  ctx.db.prepare("UPDATE tasks SET worker_pid = ? WHERE id IN (?,?,?)").run(2_000_000_000, saved.id, interrupted.id, unstarted.id);
  await ctx.close();
  workspace = openWorkspace();
  const repos = workspace.ctx.repos;
  expect(repos.tasks.get(live.id)?.state).toBe("claimed");
  expect(repos.tasks.get(unstarted.id)?.state).toBe("queued");
  expect(repos.tasks.get(saved.id)).toMatchObject({ state: "failed", interrupted: true, changeIds: [change.id] });
  expect(repos.tasks.get(interrupted.id)).toMatchObject({ state: "failed", interrupted: true });
  // Scarlet closed mid-run, so each run carries on by itself, ahead of the follow-up asked while it worked.
  const resumed = repos.tasks.get(repos.tasks.get(saved.id)!.retryTaskId!)!;
  expect(resumed).toMatchObject({ state: "queued", resumeRootId: saved.id, changeIds: [], context: { threadId: saved.id } });
  expect(resumed.instruction).toContain(`Saved change ${change.id} [ready]`);
  const retry = async () => (await (await api("POST", `/tasks/${interrupted.id}/retry`)).json()).task;
  const [a, b] = await Promise.all([retry(), retry()]);
  expect(a.id).toBe(b.id);
  expect(a.id).toBe(repos.tasks.get(interrupted.id)!.retryTaskId);
  expect(a).toMatchObject({ state: "queued", resumeRootId: interrupted.id, model: "test-model", effort: "high", fast: true, context: { threadId: interrupted.id, time: 6 } });
  expect((await claim()).id).toBe(a.id);
  expect(repos.tasks.get(follow.id)?.state).toBe("queued");
  expect((await api("POST", projectsPath() + "/changes", { description: "Late result", ops: marker, taskId: interrupted.id })).status).toBe(409);
  expect((await api("POST", `/tasks/${interrupted.id}/complete`, { state: "done" })).status).toBe(409);
  expect(repos.changes.select().map(c => c.id)).toEqual([change.id]);
  // The surviving host confirms only its actual jobs. A stale claim expires even under the same host id.
  workspace.ctx.db.prepare("UPDATE tasks SET worker_seen_at = '2000-01-01' WHERE id IN (?,?)").run(live.id, a.id);
  await api("POST", `/hosts/${host.id}/heartbeat`, { running: [live.id] });
  recoverTasks(workspace.ctx);
  expect(repos.tasks.get(live.id)?.state).toBe("claimed");
  // A worker lost while Scarlet stays open: the run carries on by itself, still ahead of the follow-up.
  expect(repos.tasks.get(a.id)?.interrupted).toBe(true);
  const third = await claim();
  expect(third).toMatchObject({ id: repos.tasks.get(a.id)?.retryTaskId, resumeRootId: interrupted.id });
  // A run that keeps losing its worker stops there and waits for the editor, and the follow-up goes ahead.
  workspace.ctx.db.prepare("UPDATE tasks SET worker_seen_at = '2000-01-01' WHERE id = ?").run(third.id);
  recoverTasks(workspace.ctx);
  expect(repos.tasks.get(third.id)?.interrupted).toBe(true);
  expect(repos.tasks.get(third.id)?.retryTaskId).toBeUndefined();
  expect((await claim()).id).toBe(follow.id);
});

it("resumes an interrupted run ahead of a follow-up asked in the millisecond the run was created", async () => {
  const { ctx } = workspace;
  const host = (await (await api("POST", "/hosts/register", { name: "Test", platform: "test", agents: [{ id: "codex", installed: true }] })).json()).host;
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, {})).json()).task as Task | null;
  const make = (instruction: string, threadId?: string) => createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction,
    createdBy: { type: "human", name: "Editor" }, context: { threadId } });
  // The clock stands still, so the follow-up is asked in the very millisecond the run was.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const run = make("Trim the pause");
    expect((await claim())?.id).toBe(run.id);
    const follow = make("Tighten the intro", run.id);
    expect(follow.createdAt).toBe(run.createdAt);
    // Scarlet quits mid-run. The run carries on under a new task, a later row than the follow-up.
    expect((await api("POST", `/tasks/${run.id}/complete`, { state: "cancelled", interrupted: true })).status).toBe(200);
    const resumed = await claim();
    expect(resumed).toMatchObject({ id: ctx.repos.tasks.get(run.id)!.retryTaskId, resumeRootId: run.id });
    expect(ctx.repos.tasks.get(follow.id)?.state).toBe("queued");
    expect((await api("POST", `/tasks/${resumed!.id}/complete`, { state: "done" })).status).toBe(200);
    expect((await claim())?.id).toBe(follow.id);
  } finally {
    vi.useRealTimers();
  }
});

it("marks a run that ended without the transcripts it waited for, and resumes it once they're saved", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, agent: "codex", kind: "edit", instruction: "/first-cut-dialogue",
    createdBy: { type: "human", name: "Editor" } });
  const wait = (wait: string, mediaId: string, end?: "ok" | "failed") => ctx.repos.taskEvents.append({ id: `w_${wait}_${mediaId}_${end ?? "start"}`,
    taskId: task.id, at: new Date().toISOString(), type: "log", text: "Waiting",
    data: { kind: "media_wait", wait, mediaId, ...(end && { done: true, ...(end === "failed" && { failed: true, error: "Headers Timeout" }) }) } });
  // The camera's transcript never arrived; the screen's arrived but its dialogue analysis failed; the mic's failed but was saved later.
  wait("transcript", "camera");
  wait("transcript", "screen"); wait("transcript", "screen", "ok");
  wait("dialogue", "screen"); wait("dialogue", "screen", "failed");
  wait("dialogue", "mic"); wait("dialogue", "mic", "failed");
  wait("sound", "camera");
  ctx.repos.transcripts.put({ id: "tr_mic", mediaId: "mic", projectId: project.id, segments: [] });
  const done = (await (await api("POST", `/tasks/${task.id}/complete`, { state: "done", summary: "Saved the pauses." })).json()).task as Task;
  expect(done).toMatchObject({ state: "done", needsTranscripts: ["camera", "screen"] });
  expect(done.continueWhenReady).toBeUndefined();

  // Transcripts on their way: asking to finish waits for them.
  const transcribing = ["camera", "screen"].map(mediaId => createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api",
    instruction: `Transcribe ${mediaId}`, context: { mediaId }, createdBy: { type: "scarlet", name: "Scarlet" }, state: "running" }));
  const armed = await (await api("POST", `/tasks/${task.id}/continue-when-ready`, { on: true })).json();
  expect(armed.task.continueWhenReady).toBe(true);
  expect(armed.resumed).toBeUndefined();
  ctx.repos.transcripts.put({ id: "tr_camera", mediaId: "camera", projectId: project.id, segments: [] });
  saveTask(ctx, { ...transcribing[0]!, state: "done", finishedAt: new Date().toISOString() });
  expect(ctx.repos.tasks.get(task.id)?.retryTaskId).toBeUndefined();
  // The last transcript lands and the run resumes on its own, once.
  ctx.repos.transcripts.put({ id: "tr_screen", mediaId: "screen", projectId: project.id, segments: [] });
  saveTask(ctx, { ...transcribing[1]!, state: "done", finishedAt: new Date().toISOString() });
  const resumedId = ctx.repos.tasks.get(task.id)?.retryTaskId;
  expect(resumedId).toBeDefined();
  const resumed = ctx.repos.tasks.get(resumedId!)!;
  expect(resumed).toMatchObject({ state: "queued", resumeRootId: task.id });
  expect(resumed.instruction).toContain("ended without the transcript of camera, screen. Ready now: camera, screen.");
  expect(continueReadyRuns(ctx)).toEqual([]);
  // The finished run no longer offers to wait.
  expect((await api("POST", `/tasks/${task.id}/continue-when-ready`, { on: true })).status).toBe(200);
  expect(ctx.repos.tasks.select("project_id = ? AND kind = 'edit'", [project.id])).toHaveLength(2);
});

it("stops waiting when a run's transcript ends without being saved", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, agent: "codex", kind: "edit", instruction: "Tighten", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.taskEvents.append({ id: "w", taskId: task.id, at: new Date().toISOString(), type: "log", text: "Waiting",
    data: { kind: "media_wait", wait: "transcript", mediaId: "camera" } });
  await api("POST", `/tasks/${task.id}/complete`, { state: "done" });
  // Nothing is transcribing this recording, and this project has no such media to start on.
  expect((await api("POST", `/tasks/${task.id}/continue-when-ready`, { on: true })).status).toBe(409);
  const transcribing = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", instruction: "Transcribe camera",
    context: { mediaId: "camera" }, createdBy: { type: "scarlet", name: "Scarlet" }, state: "running" });
  expect((await api("POST", `/tasks/${task.id}/continue-when-ready`, { on: true })).status).toBe(200);
  saveTask(ctx, { ...transcribing, state: "failed", error: "Transcription was interrupted.", finishedAt: new Date().toISOString() });
  expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "done", needsTranscripts: ["camera"] });
  expect(ctx.repos.tasks.get(task.id)?.continueWhenReady).toBeUndefined();
  expect(ctx.repos.tasks.get(task.id)?.retryTaskId).toBeUndefined();
  // A run that got everything it waited for isn't marked.
  const whole = createTask(ctx, { projectId: project.id, agent: "codex", kind: "edit", instruction: "Tighten", createdBy: { type: "human", name: "Editor" } });
  const finished = (await (await api("POST", `/tasks/${whole.id}/complete`, { state: "done" })).json()).task as Task;
  expect(finished.needsTranscripts).toBeUndefined();
  expect((await api("POST", `/tasks/${whole.id}/continue-when-ready`, { on: true })).status).toBe(409);
});

it("stops waiting for multiple transcripts as soon as one fails, even while another keeps running", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, agent: "codex", kind: "edit", instruction: "Tighten",
    createdBy: { type: "human", name: "Editor" } });
  const transcribing = ["camera", "mic"].map(mediaId => {
    ctx.repos.taskEvents.append({ id: `wait_${mediaId}`, taskId: task.id, at: new Date().toISOString(), type: "log",
      text: "Waiting", data: { kind: "media_wait", wait: "transcript", mediaId } });
    return createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", instruction: `Transcribe ${mediaId}`,
      context: { mediaId }, createdBy: { type: "scarlet", name: "Scarlet" }, state: "running" });
  });
  await api("POST", `/tasks/${task.id}/complete`, { state: "done" });
  const armed = await (await api("POST", `/tasks/${task.id}/continue-when-ready`, { on: true })).json();
  expect(armed.task.continueWhenReady).toBe(true);
  saveTask(ctx, { ...transcribing[0]!, state: "failed", error: "Could not read the recording" });
  expect(ctx.repos.tasks.get(task.id)?.continueWhenReady).toBeUndefined();
  expect(ctx.repos.tasks.get(task.id)?.retryTaskId).toBeUndefined();
  expect(ctx.repos.tasks.get(transcribing[1]!.id)?.state).toBe("running");
});

it("honors Don't wait if the editor turns it off after the recovery sweep has listed a ready request", () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, agent: "codex", kind: "edit", instruction: "Tighten",
    createdBy: { type: "human", name: "Editor" } });
  saveTask(ctx, { ...task, state: "done", needsTranscripts: ["camera"], continueWhenReady: true });
  ctx.repos.transcripts.put({ id: "tr_camera", projectId: project.id, mediaId: "camera", segments: [] });
  const list = ctx.repos.tasks.select.bind(ctx.repos.tasks);
  vi.spyOn(ctx.repos.tasks, "select").mockImplementationOnce((...args) => {
    const candidates = list(...args);
    expect(candidates.map(t => t.id)).toEqual([task.id]);
    continueWhenReady(ctx, task.id, false);
    return candidates;
  });
  expect(continueReadyRuns(ctx, project.id)).toEqual([]);
  expect(ctx.repos.tasks.get(task.id)?.retryTaskId).toBeUndefined();
});

it("resumes a legacy interruption from its saved edits, answers and scanned ranges across multiple stops", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, agent: "codex", kind: "edit", instruction: "/first-cut-dialogue",
    createdBy: { type: "human", name: "Editor" }, context: { skillIds: ["dialogue"] } });
  const { change } = await (await api("POST", projectsPath() + "/changes", {
    description: "Mark the ending", intent: "requested", ops: marker, taskId: task.id, skipRender: true,
  })).json();
  expect(change.state).toBe("approved");
  for (const [i, from] of [0, 58, 150].entries()) {
    ctx.repos.taskEvents.append({ id: `scan_${i}`, taskId: task.id, at: new Date().toISOString(), type: "log", text: "Dialogue scan",
      data: { kind: "editor_progress", scanPage: { mediaId: "camera", from, to: from + 60, end: 300 } } });
  }
  const event = (type: "question" | "answer", text: string) => ctx.repos.taskEvents.append({ id: type, taskId: task.id, at: new Date().toISOString(), type, text });
  event("question", "Keep the intro?");
  event("answer", "Keep the intro.");
  const legacy = { ...task, state: "done" as const, changeIds: [change.id], summary: "The agent was interrupted after saving its proposed changes. You can review them here." };
  ctx.repos.tasks.put(legacy);
  const completed = ctx.repos.tasks.put({ ...legacy, id: "tsk_completed", summary: "Finished." });
  // Reopen the workspace as it was saved by the previous engine.
  for (const { name } of ctx.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'review_revision_*'").all() as { name: string }[]) {
    ctx.db.exec(`DROP TRIGGER ${name}`);
  }
  ctx.db.exec("DROP TABLE engines; DROP TABLE learnings; DROP TABLE task_usage; DROP TRIGGER transcription_provider_changed; ALTER TABLE settings DROP COLUMN transcription_revision;");
  ctx.db.exec("ALTER TABLE projects DROP COLUMN completed_threads; DROP TABLE source_cache_requests; ALTER TABLE projects DROP COLUMN media_paused; DROP TABLE dialogue_scan_pages; DROP INDEX renders_pending; ALTER TABLE projects DROP COLUMN review_revision; DROP TABLE storage_purges;");
  ctx.db.pragma("user_version = 10");
  await ctx.close();
  workspace = openWorkspace();
  expect(workspace.ctx.repos.tasks.get(completed.id)?.state).toBe("done");
  expect((await api("POST", `/tasks/${completed.id}/retry`)).status).toBe(409);
  const resume = async (id: string) => (await (await api("POST", `/tasks/${id}/retry`)).json()).task;
  const [first, duplicate] = await Promise.all([resume(task.id), resume(task.id)]);
  expect(first.id).toBe(duplicate.id);
  expect(first).toMatchObject({ resumeRootId: task.id, context: { message: task.instruction, skillIds: ["dialogue"] } });
  expect(first.instruction).toContain(`Saved change ${change.id} [approved]`);
  expect(first.instruction).toContain("Editor answered: Keep the intro.");
  expect(first.instruction).toContain("Scanned source seconds on camera: 0–118, 150–210");
  appendTaskEvent(workspace.ctx, first, { type: "log", text: "Checking the remaining pauses.", data: { kind: "editor_progress" } });
  await api("POST", `/tasks/${first.id}/cancel`);
  const next = await resume(first.id);
  expect(next.resumeRootId).toBe(task.id);
  expect(next.instruction).toContain("Checking the remaining pauses.");
  expect(next.instruction.split(change.id)).toHaveLength(2);
  expect(workspace.ctx.repos.changes.select().map(c => c.id)).toEqual([change.id]);
});

it("plays a native import before hashing and keeps a preview requested during the hash", async () => {
  const { ctx } = workspace;
  const originalHash = ctx.render.hashFile;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(ctx.render, "hashFile").mockImplementation(async (...args) => { await gate; return originalHash(...args); });
  vi.spyOn(ctx.render, "probeMedia").mockResolvedValue({ kind: "video", duration: 10, hasAudio: true, hasAlpha: false,
    width: 320, height: 180, fps: 30, previewClock: { frameRate: "30/1", startPts: 0, videoStart: 0 }, originalPlaybackType: "video/mp4" });
  const proxy = vi.spyOn(ctx.render, "makeProxy").mockImplementation(async (_input, out) => { writeFileSync(out, "preview"); });
  const source = join(directory, "owned.mp4");
  writeFileSync(source, "original");
  try {
    const result = await api("POST", projectsPath() + "/media/import", { path: source });
    expect(result.status).toBe(201);
    const { media } = await result.json();
    expect(media.hash).toBeUndefined();
    expect(isPlayableMedia(media)).toBe(true);
    expect(await (await api("GET", `/media/${media.id}/file`)).text()).toBe("original");
    await api("POST", `/media/${media.id}/playback-cache`);
    const lookup = previewPictures(ctx.paths.media(project.id));
    await vi.waitFor(async () => expect(await lookup(media, 0, 1, 180)).toBeDefined());
    const early = await lookup(media, 0, 1, 180);
    finish();
    await Promise.all(ctx.pending);
    const finished = ctx.repos.projects.getMedia(media.id)!;
    expect(finished).toMatchObject({ status: "ready", hash: await originalHash(source) });
    expect(await lookup(finished, 0, 1, 180)).toEqual(early);
    // Uploaded recordings can already have their hash but no persisted fingerprint stamp.
    expect(await lookup({ ...finished, fingerprintStamp: undefined }, 0, 1, 180)).toEqual(early);
    expect(await (await api("GET", `/media/${media.id}/playback-cache/file`)).text()).toBe("preview");
    expect(proxy).toHaveBeenCalledTimes(1);
  } finally { finish(); }
});

it("keeps the voice roles saved on a recording while its import is still being fingerprinted", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  ctx.repos.settings.update({ transcription: { provider: "openai" } });
  const provider = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  const speakerAnalysis = vi.spyOn(ctx.speakers, "begin").mockImplementation(() => {});
  const originalHash = ctx.render.hashFile;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(ctx.render, "hashFile").mockImplementation(async (...args) => { await gate; return originalHash(...args); });
  vi.spyOn(ctx.render, "probeMedia").mockResolvedValue({ kind: "audio", duration: 10, hasAudio: true });
  const source = join(directory, "interview.wav");
  writeFileSync(source, "original");
  try {
    const result = await api("POST", projectsPath() + "/media/import", { path: source });
    expect(result.status).toBe(201);
    const { media } = await result.json();
    expect(media).toMatchObject({ status: "ingesting", preparation: { stage: "fingerprint" } });
    // As the voice-roles route saves them, once it has checked the recording's inputs.
    const current = ctx.repos.projects.getMedia(media.id)!;
    ctx.repos.projects.putMedia(current.projectId, { ...current, voiceRoles: { me: 1, other: 2 } }, current.status, current.error);
    finish();
    await Promise.all(ctx.pending);
    expect(speakerAnalysis).toHaveBeenCalledWith(ctx, project.id, expect.objectContaining({ voiceRoles: { me: 1, other: 2 } }));
    expect(ctx.repos.projects.getMedia(media.id)).toMatchObject({ status: "ready", hash: await originalHash(source), voiceRoles: { me: 1, other: 2 } });
  } finally { finish(); provider.mockRestore(); }
});

it("prepares a complete proxy for imported footage only when the GPU can encode it", async () => {
  for (const gpu of [true, false]) {
    await workspace.ctx.close();
    const makeProxy = vi.fn<RenderAdapter["makeProxy"]>(async (_input, out) => { writeFileSync(out, "proxy"); });
    workspace = createApp({
      dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {}, prepareSourceProxies: true,
      render: {
        ...scarletRenderAdapter, makeProxy, hardwareProxies: async () => gpu,
        probeMedia: async () => ({ kind: "video", duration: 10, hasAudio: true, hasAlpha: false, width: 320, height: 180, fps: 30, previewClock: { frameRate: "30/1", startPts: 0, videoStart: 0 }, originalPlaybackType: "video/mp4" }),
      },
    });
    const { ctx } = workspace;
    const source = join(directory, `footage-${gpu}.mp4`);
    writeFileSync(source, "original " + gpu);
    const result = await api("POST", projectsPath() + "/media/import", { path: source });
    expect(result.status).toBe(201);
    const { media } = await result.json();
    while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
    const full = makeProxy.mock.calls.filter(([, , opts]) => !opts.range);
    expect(full.length).toBe(gpu ? 1 : 0);
    if (gpu) expect(full[0]![2].hwaccel).toBe(ctx.settings().render.hwaccel);
    const finished = ctx.repos.projects.getMedia(media.id)!;
    expect(await previewPictures(ctx.paths.media(project.id))(finished, 0, 9.5, 180)).toEqual(
      gpu ? { file: expect.stringMatching(/cached-[0-9a-f]+\.mp4$/), start: 0 } : undefined);
  }
});

it.each(["pause", "trash"])("stops a source encode on %s and resumes its checkpoint only after reactivation", async action => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, {
    id: "camera", name: "Camera", path: "camera.mov", kind: "video", duration: 90, previewMode: "on-demand",
  }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), media.path), "recording");
  const encode = vi.spyOn(ctx.render, "makeProxy").mockImplementation(async (_, file, options) => {
    writeFileSync(file, "partial");
    await new Promise<void>((_, reject) => options.signal!.addEventListener("abort", () => reject(Error("stopped")), { once: true }));
  });
  await api("POST", "/media/camera/playback-cache");
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
  const original = encode.mock.calls[0]![2];
  const neighbor = ctx.repos.projects.insert(createProject("Other"));
  const otherWorker = ctx.mediaSignal(neighbor.id);
  if (action === "pause") await api("PATCH", projectsPath(), { mediaPaused: true });
  else await api("DELETE", projectsPath());
  expect(original.signal!.aborted).toBe(true);
  expect(otherWorker.aborted).toBe(false);
  await ctx.close();
  const restored = vi.fn<RenderAdapter["makeProxy"]>(async (_, file) => { writeFileSync(file, "complete"); });
  workspace = openWorkspace({ makeProxy: restored });
  await Promise.all(workspace.ctx.pending);
  expect(restored).not.toHaveBeenCalled();
  if (action === "pause") await api("PATCH", projectsPath(), { mediaPaused: false });
  else await api("POST", projectsPath() + "/restore");
  await Promise.all(workspace.ctx.pending);
  expect(restored.mock.calls[0]![2].checkpointDir).toBe(original.checkpointDir);
  expect(await (await api("GET", "/media/camera/playback-cache/file")).text()).toBe("complete");
});

it("lists each video's playback cache without starting one", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, {
    id: "camera", name: "Camera", path: "camera.mov", kind: "video", duration: 90, previewMode: "on-demand",
  }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 90 }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), media.path), "recording");
  let finish = false;
  const encode = vi.spyOn(ctx.render, "makeProxy").mockImplementation(async (_, file, options) => {
    options.onProgress?.(0.4);
    if (finish) return writeFileSync(file, "complete");
    await new Promise<void>((_, reject) => options.signal!.addEventListener("abort", () => reject(Error("stopped")), { once: true }));
  });
  const list = async () => (await (await api("GET", projectsPath() + "/playback-caches")).json()).caches;
  expect(await list()).toEqual([{ mediaId: "camera", state: "uncached" }]);
  expect(encode).not.toHaveBeenCalled();
  await api("POST", "/media/camera/playback-cache");
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
  expect(await list()).toEqual([{ mediaId: "camera", state: "caching", progress: 0.4 }]);
  await api("PATCH", projectsPath(), { mediaPaused: true });
  await vi.waitFor(async () => expect(await list()).toEqual([{ mediaId: "camera", state: "uncached", queued: true }]));
  finish = true;
  await api("PATCH", projectsPath(), { mediaPaused: false });
  while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
  expect(await list()).toEqual([{ mediaId: "camera", state: "ready" }]);
});

it("resumes a pending native fingerprint after an engine restart", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const file = join(ctx.paths.media(project.id), "owned.wav");
  writeFileSync(file, "audio");
  ctx.repos.projects.putMedia(project.id, { id: "pending", kind: "audio", name: "Audio", path: "owned.wav", duration: 5,
    preparation: { stage: "fingerprint", fraction: 0.5 }, transcriptId: "manual" }, "ingesting");
  ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = 'pending'").run();
  await ctx.close();
  workspace = openWorkspace();
  await Promise.all(workspace.ctx.pending);
  expect(workspace.ctx.repos.projects.getMedia("pending")).toMatchObject({
    status: "ready", hash: await workspace.ctx.render.hashFile(file), transcriptId: "manual",
  });
});

// Only macOS is asked when a process began: elsewhere an import stays with whatever process has its engine's id.
it.runIf(process.platform === "darwin")("finishes an import a killed engine left once another program has its process id", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const file = join(ctx.paths.media(project.id), "owned.wav");
  writeFileSync(file, "audio");
  ctx.repos.projects.putMedia(project.id, { id: "pending", kind: "audio", name: "Audio", path: "owned.wav", duration: 5,
    preparation: { stage: "fingerprint", fraction: 0.5 } }, "ingesting");
  const program = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    // The engine noted that it began an hour before the program that has its id now did.
    ctx.db.prepare("INSERT INTO engines (pid, started_at) VALUES (?, ?)").run(program.pid, Date.now() - 3_600_000);
    ctx.db.prepare("UPDATE media SET ingest_pid = ? WHERE id = 'pending'").run(program.pid);
    // The first round only asks when that process began. Until that is known the import is still its engine's.
    await recoverIngest(ctx);
    expect(ctx.repos.projects.getMedia("pending")?.status).toBe("ingesting");
    await Promise.all(ctx.pending);
    await recoverIngest(ctx);
    expect(ctx.repos.projects.getMedia("pending")).toMatchObject({ status: "ready", hash: await ctx.render.hashFile(file) });
  } finally { program.kill(); }
});

it("takes up what a killed engine left claimed under the process id this engine was then given", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  // A viewer's render and an export it was encoding.
  const { head } = ensureHead(ctx, project.id);
  const full = { projectId: project.id, version: head, kind: "full", range: null } as const;
  const owner = randomUUID();
  const made = [ctx.renders.request({ ...full, quality: "preview" }, randomUUID()),
    ctx.renders.request({ ...full, quality: "delivery" }, owner, { name: "Cut.mp4", ticket: 7 })];
  await Promise.all([...ctx.pending]);
  const [viewer, exported] = made.map(render => ctx.repos.renders.put({ ...render, id: render.id + "_left", state: "running", progress: 0.4,
    queuePid: process.pid, demandPid: process.pid })) as [Render, Render];
  const partial = join(ctx.paths.renders(project.id), `${viewer.id}.mp4`);
  writeFileSync(partial, "half an encode");
  // An import it was fingerprinting and a video it was caching.
  const file = join(ctx.paths.media(project.id), "owned.wav");
  writeFileSync(file, "audio");
  ctx.repos.projects.putMedia(project.id, { id: "pending", kind: "audio", name: "Audio", path: "owned.wav", duration: 5,
    preparation: { stage: "fingerprint", fraction: 0.5 } }, "ingesting");
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Camera", path: "camera.mov", kind: "video", duration: 90, previewMode: "on-demand" }, "ready");
  writeFileSync(join(ctx.paths.media(project.id), "camera.mov"), "recording");
  ctx.db.prepare("INSERT INTO source_cache_requests VALUES ('camera', ?)").run(process.pid);
  await ctx.close();
  // A clean quit takes an engine's note with it. This one was killed: its note is still beside the id, and says it began earlier.
  const library = new Db(ctx.paths.db);
  expect(library.prepare("SELECT pid FROM engines").all()).toEqual([]);
  library.prepare("INSERT INTO engines (pid, started_at) VALUES (?, ?)").run(process.pid, performance.timeOrigin - 60_000);
  library.close();
  workspace = openWorkspace({ makeProxy: async (_source, out) => { writeFileSync(out, "cached"); } });
  while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]);
  const fresh = workspace.ctx;
  expect(fresh.repos.projects.getMedia("pending")).toMatchObject({ status: "ready", hash: await fresh.render.hashFile(file) });
  expect((await (await api("GET", projectsPath() + "/playback-caches")).json()).caches).toEqual([{ mediaId: "camera", state: "ready" }]);
  expect(fresh.repos.renders.get(viewer.id)?.state).toBe("cancelled");
  expect(existsSync(partial)).toBe(false);
  expect(fresh.repos.renders.get(exported.id)).toMatchObject({ state: "done", export: { owner } });
  // The note beside the id is this engine's now.
  expect(fresh.db.prepare("SELECT started_at FROM engines WHERE pid = ?").get(process.pid)).toEqual({ started_at: performance.timeOrigin });
});

it("reports file checking to the requesting import before publishing the asset", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "probeMedia").mockResolvedValue({ kind: "image", duration: 0, hasAudio: false });
  const publish = vi.spyOn(ctx.bus, "publish");
  const source = join(directory, "still.png");
  writeFileSync(source, "fixture");
  const importId = crypto.randomUUID();
  const result = await api("POST", projectsPath() + "/media/import", { path: source, importId });
  expect(result.status).toBe(201);
  const events = publish.mock.calls.map(([event]) => event);
  const checks = events.filter(event => event.type === "media.import.checking");
  expect(checks).toEqual([0, 1].map(fraction => ({ type: "media.import.checking", projectId: project.id, importId, fraction })));
  expect(events.indexOf(checks[1]!)).toBeLessThan(events.findIndex(event => event.type === "media.updated"));
});

it("joins an interrupted import by its request id during the copy and after the engine reopens", async () => {
  const { ctx } = workspace;
  const source = join(directory, "still.png");
  const importId = crypto.randomUUID();
  const request = () => api("POST", projectsPath() + "/media/import", { path: source, importId });
  expect((await request()).status).toBe(400);
  writeFileSync(source, "fixture");
  let finish!: () => void;
  const probing = new Promise<void>(resolve => { finish = resolve; });
  const probe = vi.spyOn(ctx.render, "probeMedia").mockImplementation(async () => {
    await probing;
    return { kind: "image", duration: 0, hasAudio: false };
  });
  const both = Promise.all([request(), request()]);
  await vi.waitFor(() => expect(probe).toHaveBeenCalled());
  finish();
  const [first, retry] = await Promise.all((await both).map(response => response.json()));
  expect(retry.media.id).toBe(first.media.id);
  expect(probe).toHaveBeenCalledTimes(1);
  await ctx.close();
  workspace = openWorkspace({ probeMedia: async () => ({ kind: "image", duration: 0, hasAudio: false }) });
  expect((await (await request()).json()).media.id).toBe(first.media.id);
  expect(workspace.ctx.repos.projects.listMedia(project.id)).toHaveLength(1);
  const separate = await api("POST", projectsPath() + "/media/import", { path: source, importId: crypto.randomUUID() });
  expect((await separate.json()).media.id).not.toBe(first.media.id);
});

it("keeps a resumed import's identity through an older engine updating the recording", async () => {
  const source = join(directory, "camera.png");
  const body = { path: source, importId: crypto.randomUUID() };
  const request = () => api("POST", projectsPath() + "/media/import", body);
  const probe = async () => ({ kind: "image" as const, duration: 0, hasAudio: false });
  vi.spyOn(workspace.ctx.render, "probeMedia").mockImplementation(probe);
  writeFileSync(source, "original");
  const { media } = await (await request()).json();
  await workspace.ctx.close();
  // The first request-id migration (version 23) already recorded this import.
  const old = new Db(join(directory, "scarlet.db"));
  try {
    old.exec("DROP TRIGGER IF EXISTS media_keep_import_request");
    old.pragma("user_version = 23");
    workspace = openWorkspace({ probeMedia: probe });
    // A pre-upgrade engine on the same database saves the complete media shape it understands.
    old.prepare("UPDATE media SET json = json_set(json_remove(json, '$.importId'), '$.transcriptId', ?) WHERE id = ?")
      .run("tr_from_older_scarlet", media.id);
    rmSync(source); // The camera is no longer connected, so a new copy cannot succeed.
    const resumed = await request();
    expect(resumed.status).toBe(201);
    expect((await resumed.json()).media).toMatchObject({ id: media.id, importId: body.importId, transcriptId: "tr_from_older_scarlet" });
    expect(readdirSync(workspace.ctx.paths.media(project.id))).toEqual([media.path]);
  } finally {
    old.close();
  }
});

it("publishes one original when two engines finish the same resumed import", async () => {
  let probing = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const probe = async () => { probing++; await gate; return { kind: "image" as const, duration: 0, hasAudio: false }; };
  vi.spyOn(workspace.ctx.render, "probeMedia").mockImplementation(probe);
  const second = openWorkspace({ probeMedia: probe });
  const source = join(directory, "two-engines.png");
  writeFileSync(source, "fixture");
  const path = projectsPath() + "/media/import";
  const body = { path: source, importId: crypto.randomUUID() };
  try {
    const firstRequest = api("POST", path, body);
    const secondRequest = second.app.request("/api" + path, { method: "POST", body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${accessToken(second.ctx)}`, "Content-Type": "application/json" } });
    await vi.waitFor(() => expect(probing).toBe(2));
    finish();
    const [first, retry] = await Promise.all([firstRequest.then(r => r.json()), secondRequest.then(r => r.json())]);
    expect(first.media.id).toBe(retry.media.id);
    expect(workspace.ctx.repos.projects.listMedia(project.id)).toHaveLength(1);
    expect(readdirSync(workspace.ctx.paths.media(project.id))).toEqual([first.media.path]);
  } finally {
    finish();
    await second.ctx.close();
  }
});

it("keeps transcription off with a cloud key, including explicit provider requests", async () => {
  workspace.ctx.env.openaiKey = "unused-fixture";
  vi.spyOn(workspace.ctx.render, "probeMedia").mockResolvedValue({ duration: 2, hasAudio: true, kind: "audio" });
  vi.spyOn(workspace.ctx.render, "extractWaveformFull").mockResolvedValue({ peaks: [0.5] });
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  try {
    expect(await (await api("GET", "/settings")).json()).toMatchObject({ transcriptionAvailable: false });
    const source = join(directory, "interview.wav");
    writeFileSync(source, "local synthetic audio");
    const imported = await api("POST", projectsPath() + "/media/import", { path: source });
    expect(imported.status).toBe(201);
    const { media } = await imported.json();
    await Promise.all([...workspace.ctx.pending]);
    expect(workspace.ctx.repos.projects.getMedia(media.id)?.status).toBe("ready");
    expect(workspace.ctx.repos.tasks.select()).toHaveLength(0);
    for (const body of [{}, { provider: "openai" }]) {
      const response = await api("POST", `/media/${media.id}/transcribe`, body);
      expect(await response.json()).toMatchObject({ task: { state: "failed" } });
    }
    expect(cloud).not.toHaveBeenCalled();
  } finally {
    cloud.mockRestore();
  }
});

it("keeps the import-time decision when cloud is enabled while a video preview is preparing", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  vi.spyOn(ctx.render, "probeMedia").mockResolvedValue({ duration: 2, hasAudio: true, kind: "video" });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(ctx.render, "makeProxy").mockImplementation(async () => { await gate; });
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  try {
    const source = join(directory, "video.mp4");
    writeFileSync(source, "test video");
    const imported = await api("POST", projectsPath() + "/media/import", { path: source });
    expect(imported.status).toBe(201);
    await api("PATCH", "/settings", { transcription: { provider: "openai" } });
    finish();
    await Promise.all([...ctx.pending]);
    expect(cloud).not.toHaveBeenCalled();
    expect(ctx.repos.tasks.select()).toHaveLength(0);
  } finally {
    finish();
    cloud.mockRestore();
  }
});

it("refuses to send a recording that held no words", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  const extract = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_input, out) => { writeFileSync(out, "test wav"); });
  const probe = vi.spyOn(fallbackAdapter, "probeMedia").mockResolvedValue({ duration: 1, kind: "audio", hasAudio: true });
  let said = "[BLANK_AUDIO]";
  const cloud = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ text: said, segments: [{ start: 0, end: 1, text: said }] }));
  const voice = () => {
    const form = new FormData();
    form.append("audio", new Blob(["testing"], { type: "audio/wav" }), "voice.wav");
    form.append("time", "1");
    return form;
  };
  try {
    const notesBefore = ctx.repos.notes.select().length;
    const blank = await api("POST", "/speech", voice());
    expect(blank.status).toBe(400);
    expect((await blank.json()).error.code).toBe("no_speech");
    const note = await api("POST", `/projects/${project.id}/notes/voice`, voice());
    expect(note.status).toBe(400);
    expect(ctx.repos.notes.select()).toHaveLength(notesBefore);
    said = " [ Silence ] Trim the intro (music)";
    expect(await (await api("POST", "/speech", voice())).json()).toEqual({ text: "Trim the intro" });
  } finally {
    await api("PATCH", "/settings", { transcription: { provider: "none" } });
    cloud.mockRestore();
    probe.mockRestore();
    extract.mockRestore();
  }
});

it.each(["none", "whispercpp"])("stops active cloud uploads for footage and voice when switched to %s", async (nextProvider) => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  const media = ctx.repos.projects.putMedia(project.id, { id: "long-audio", kind: "audio", name: "Interview", path: "input.wav", duration: 1300 }, "ready");
  const extract = vi.spyOn(ffmpeg, "extractWav").mockImplementation(async (_input, out) => { writeFileSync(out, "test wav"); });
  const probe = vi.spyOn(fallbackAdapter, "probeMedia").mockResolvedValue({ duration: 1, kind: "audio", hasAudio: true });
  const uploads: AbortSignal[] = [];
  const cloud = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
    const signal = opts!.signal!;
    uploads.push(signal);
    if (uploads.length === 1) return Response.json({ segments: [] });
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  try {
    const endpoint = `/media/${media.id}/transcribe`;
    const { task } = await (await api("POST", endpoint, {})).json();
    await vi.waitFor(() => expect(uploads).toHaveLength(2)); // Second chunk of footage is uploading.
    const voice = new FormData();
    voice.append("audio", new Blob(["testing"], { type: "audio/wav" }), "voice.wav");
    const speech = api("POST", "/speech", voice);
    await vi.waitFor(() => expect(uploads).toHaveLength(3));
    await api("PATCH", "/settings", { render: { handleSeconds: 2 } });
    expect(uploads[1]!.aborted).toBe(false);
    await api("PATCH", "/settings", { transcription: { provider: nextProvider, whisperModelPath: "/test/local.bin" } });
    expect((await speech).status).toBe(409);
    await Promise.all([...ctx.pending]);
    expect(uploads.slice(1).every(signal => signal.aborted)).toBe(true);
    expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "failed", error: expect.stringContaining("provider changed") });
    expect(ctx.repos.projects.getMedia(media.id)?.transcriptId).toBeUndefined();
    expect((await (await api("POST", endpoint, { provider: "openai" })).json()).task.state).toBe("failed");
    expect(cloud).toHaveBeenCalledTimes(3); // Neither the third chunk nor an explicit cloud retry was sent.
  } finally {
    await api("PATCH", "/settings", { transcription: { provider: "none" } });
    cloud.mockRestore();
    probe.mockRestore();
    extract.mockRestore();
  }
});

it("offers retry after an interrupted transcription and protects a live or completed transcript", async () => {
  const { ctx } = workspace;
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", name: "Interview", path: "interview.wav", kind: "audio" }, "ready");
  const input = { projectId: project.id, kind: "transcribe" as const, agent: "api" as const, state: "running" as const,
    instruction: "Transcribe Interview", context: { mediaId: media.id }, createdBy: { type: "scarlet" as const, name: "Scarlet" } };
  const interrupted = createTask(ctx, input);
  await ctx.close();
  workspace = openWorkspace();
  expect(workspace.ctx.repos.tasks.get(interrupted.id)).toMatchObject({ state: "failed", interrupted: true });
  workspace.ctx.env.openaiKey = "unused-fixture";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const provider = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(async () => { await gate; return { segments: [] }; });
  try {
    const transcribe = async () => (await (await api("POST", "/media/speech/transcribe", {})).json()).task;
    const [a, b] = await Promise.all([transcribe(), transcribe()]);
    expect(a.id).toBe(b.id);
    expect(provider).toHaveBeenCalledTimes(1);
    workspace.ctx.db.prepare("UPDATE tasks SET worker_seen_at = '2000-01-01' WHERE id = ?").run(a.id);
    recoverTasks(workspace.ctx);
    expect(workspace.ctx.repos.tasks.get(a.id)?.state).toBe("running");
    // A real transcription outlasts the millisecond its task was created in, which is how recovery knows a run's own transcript.
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(a.createdAt)), { interval: 1 });
    finish();
    await Promise.all([...workspace.ctx.pending]);
    const { transcriptId, lastTranscription } = workspace.ctx.repos.projects.getMedia(media.id)!;
    expect(transcriptId).toBeTruthy();
    expect(lastTranscription).toEqual({ completedAt: workspace.ctx.repos.tasks.get(a.id)!.finishedAt, model: "whisper-1" });
    // A pre-upgrade DB could have the transcript but no media link or terminal task.
    workspace.ctx.repos.projects.putMedia(project.id, media, "ready");
    workspace.ctx.repos.tasks.put(a);
    workspace.ctx.db.prepare("UPDATE tasks SET worker_pid = NULL, worker_seen_at = NULL WHERE id = ?").run(a.id);
    recoverTasks(workspace.ctx);
    expect(workspace.ctx.repos.projects.getMedia(media.id)).toMatchObject({ transcriptId, lastTranscription });
    expect(workspace.ctx.repos.tasks.get(a.id)?.state).toBe("done");
    expect(provider).toHaveBeenCalledTimes(1);
    const orphan = createTask(workspace.ctx, { ...input, context: { mediaId: "another-file" } });
    workspace.ctx.db.prepare("UPDATE tasks SET worker_pid = ?, worker_seen_at = '2000-01-01' WHERE id = ?").run(process.pid, orphan.id);
    recoverTasks(workspace.ctx);
    expect(workspace.ctx.repos.tasks.get(orphan.id)?.interrupted).toBe(true);
  } finally {
    finish();
    provider.mockRestore();
  }
});

it("transcribes again after an interruption, but not after a failure or while media is paused", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  const provider = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  const stopped = (id: string, interrupted: boolean) => {
    ctx.repos.projects.putMedia(project.id, { id, name: id, path: id + ".wav", kind: "audio" }, "ready");
    const task = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", state: "running",
      instruction: "Transcribe " + id, context: { mediaId: id }, createdBy: { type: "scarlet", name: "Scarlet" } });
    return saveTask(ctx, { ...task, state: "failed", interrupted: interrupted || undefined, error: "Stopped.", finishedAt: new Date().toISOString() });
  };
  const latest = (id: string) => ctx.repos.tasks.select("kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?", [id], "created_at, rowid").at(-1)!;
  try {
    const interrupted = stopped("quit", true);
    const failed = stopped("broken", false);
    ctx.db.prepare("UPDATE projects SET media_paused = 1 WHERE id = ?").run(project.id);
    recoverTasks(ctx);
    expect(latest("quit").id).toBe(interrupted.id);
    ctx.db.prepare("UPDATE projects SET media_paused = 0 WHERE id = ?").run(project.id);
    recoverTasks(ctx);
    expect(latest("quit").id).not.toBe(interrupted.id);
    expect(latest("broken").id).toBe(failed.id);
    await Promise.all([...ctx.pending]);
    expect(latest("quit").state).toBe("done");
    expect(ctx.repos.projects.getMedia("quit")?.transcriptId).toBeTruthy();
    recoverTasks(ctx);
    expect(provider).toHaveBeenCalledTimes(1);
    // A second transcript the editor asked for, with a provider chosen for it, was interrupted too. It starts again as asked,
    // though the recording already has a transcript.
    const asked = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", state: "running", instruction: "Transcribe quit",
      context: { mediaId: "quit", transcriptionProvider: "openai" }, createdBy: { type: "scarlet", name: "Scarlet" } });
    saveTask(ctx, { ...asked, state: "failed", interrupted: true, error: "Transcription was interrupted.", finishedAt: new Date().toISOString() });
    recoverTasks(ctx);
    expect(latest("quit").id).not.toBe(asked.id);
    expect(latest("quit").context).toMatchObject({ mediaId: "quit", transcriptionProvider: "openai" });
    await Promise.all([...ctx.pending]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(latest("quit").state).toBe("done");
  } finally {
    provider.mockRestore();
  }
});

it("leaves a cut-off transcription for Retry when a cloud service was selected since, or its project is archived", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  const provider = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  const cutOff = (id: string, transcribedWith: string) => {
    ctx.repos.projects.putMedia(project.id, { id, name: id, path: id + ".wav", kind: "audio" }, "ready");
    const task = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", state: "running",
      instruction: "Transcribe " + id, context: { mediaId: id, transcribedWith }, createdBy: { type: "scarlet", name: "Scarlet" } });
    return saveTask(ctx, { ...task, state: "failed", interrupted: true, error: "Transcription was interrupted.", finishedAt: new Date().toISOString() });
  };
  const latest = (id: string) => ctx.repos.tasks.select("kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?", [id], "created_at, rowid").at(-1)!;
  try {
    // It ran on this computer and the cloud service was chosen afterwards: the recording is not uploaded unasked.
    const local = cutOff("local", "whispercpp");
    const cloud = cutOff("cloud", "openai");
    ctx.db.prepare("UPDATE projects SET archived = 1 WHERE id = ?").run(project.id);
    recoverTasks(ctx);
    expect(latest("local").id).toBe(local.id);
    expect(latest("cloud").id).toBe(cloud.id);
    ctx.db.prepare("UPDATE projects SET archived = 0 WHERE id = ?").run(project.id);
    recoverTasks(ctx);
    expect(latest("local").id).toBe(local.id);
    expect(latest("cloud").id).not.toBe(cloud.id);
    // The restarted run records its service in turn.
    expect(latest("cloud").context).toMatchObject({ mediaId: "cloud", transcribedWith: "openai" });
    await Promise.all([...ctx.pending]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(latest("cloud").state).toBe("done");
  } finally {
    provider.mockRestore();
  }
});

it("keeps a part-aligned transcript's times, without transcribing again, after a run that failed by itself or with a cloud service selected", async () => {
  await api("PATCH", "/settings", { transcription: { provider: "whispercpp", whisperModelPath: "fixture" } });
  const t = twoTurnTranscription();
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  const leaveMarked = () => {
    const id = t.ctx.repos.projects.getMedia(t.media.id)!.transcriptId!;
    t.ctx.repos.transcripts.put({ ...t.ctx.repos.transcripts.get(id)!, aligning: { through: 10.5 } });
  };
  const read = async () => (await (await api("GET", "/media/speech/transcript")).json()).aligning;
  try {
    await transcribeMedia(t.ctx, project.id, t.media);
    while (t.ctx.pending.size) await Promise.all([...t.ctx.pending]);
    expect(t.reader).toHaveBeenCalledTimes(1);
    // A later run failed by itself, so the next one is the editor's Retry, not something a read starts.
    const failed = createTask(t.ctx, { projectId: project.id, kind: "transcribe", agent: "api", state: "running",
      instruction: "Transcribe Interview", context: { mediaId: t.media.id }, createdBy: { type: "scarlet", name: "Scarlet" } });
    saveTask(t.ctx, { ...failed, state: "failed", error: "The model file is missing.", finishedAt: new Date().toISOString() });
    leaveMarked();
    expect(await read()).toEqual({ through: 10.5 });
    expect(await read()).toBeUndefined();
    expect(t.task().id).toBe(failed.id);
    // With a cloud service selected, reading doesn't send the recording out either.
    saveTask(t.ctx, { ...t.task(), interrupted: true });
    t.ctx.env.openaiKey = "unused-fixture";
    await api("PATCH", "/settings", { transcription: { provider: "openai" } });
    leaveMarked();
    expect(await read()).toEqual({ through: 10.5 });
    expect(await read()).toBeUndefined();
    expect(t.task().id).toBe(failed.id);
    expect(cloud).not.toHaveBeenCalled();
    expect(t.reader).toHaveBeenCalledTimes(1);
  } finally { cloud.mockRestore(); t.restore(); }
});

it("transcribes again when the interrupted task was created in the millisecond the last transcript was saved", async () => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  const provider = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", name: "Interview", path: "interview.wav", kind: "audio" }, "ready");
  const ask = () => createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", state: "running", instruction: "Transcribe Interview",
    context: { mediaId: media.id, transcriptionProvider: "openai" }, createdBy: { type: "scarlet", name: "Scarlet" } });
  const latest = () => ctx.repos.tasks.select("kind = 'transcribe'", [], "created_at, rowid").at(-1)!;
  // The clock stands still, so each task is created in the very millisecond the transcript before it was saved.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    expect(await transcribeMedia(ctx, project.id, media)).toBeTruthy();
    // A second transcript was asked for and marked interrupted when Scarlet quit.
    const marked = saveTask(ctx, { ...ask(), state: "failed", interrupted: true, error: "Transcription was interrupted.", finishedAt: new Date().toISOString() });
    recoverTasks(ctx);
    expect(latest().id).not.toBe(marked.id);
    await Promise.all([...ctx.pending]);
    expect(provider).toHaveBeenCalledTimes(2);
    // Another was still running when its worker went missing. The earlier transcript doesn't pass for its result.
    const lost = ask();
    recoverTasks(ctx);
    expect(ctx.repos.tasks.get(lost.id)).toMatchObject({ state: "failed", interrupted: true });
    expect(latest().id).not.toBe(lost.id);
    await Promise.all([...ctx.pending]);
    expect(provider).toHaveBeenCalledTimes(3);
    expect(latest().state).toBe("done");
  } finally {
    vi.useRealTimers();
    provider.mockRestore();
  }
});

it.each(["quit", "lost worker"])("transcribes again after a %s when speaker labels for the earlier transcript were saved meanwhile", async stopped => {
  const { ctx } = workspace;
  ctx.env.openaiKey = "unused-fixture";
  await api("PATCH", "/settings", { transcription: { provider: "openai" } });
  const provider = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  let label!: () => void;
  const analysed = new Promise<void>(resolve => { label = resolve; });
  const turns = vi.spyOn(ctx.speakers, "turns").mockImplementation(async () => { await analysed; return []; });
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", name: "Interview", path: "interview.wav", kind: "audio" }, "ready");
  const latest = () => ctx.repos.tasks.select("kind = 'transcribe'", [], "created_at, rowid").at(-1)!;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // The recording has its first transcript, and speaker analysis of it is still running.
    const first = (await transcribeMedia(ctx, project.id, media))!;
    // A millisecond later the editor asks for a second transcript.
    vi.setSystemTime(Date.now() + 1);
    const asked = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", state: "running", instruction: "Transcribe Interview",
      context: { mediaId: media.id, transcriptionProvider: "openai" }, createdBy: { type: "scarlet", name: "Scarlet" } });
    // Another millisecond on, speaker analysis saves its labelled copy of the first transcript, newer than the second's task.
    vi.setSystemTime(Date.now() + 1);
    label();
    await Promise.all([...ctx.pending]);
    const labelled = ctx.repos.transcripts.get(ctx.repos.projects.getMedia(media.id)!.transcriptId!)!;
    expect(labelled.id).not.toBe(first.id);
    expect(labelled.speakerAnalysis).toBeDefined();
    expect(Date.parse(labelled.createdAt!)).toBeGreaterThan(Date.parse(asked.createdAt!));
    // Scarlet stops before the second transcript is made. The labelled copy doesn't pass for it.
    if (stopped === "quit") saveTask(ctx, { ...asked, state: "failed", interrupted: true, error: "Transcription was interrupted.", finishedAt: new Date().toISOString() });
    recoverTasks(ctx);
    expect(ctx.repos.tasks.get(asked.id)).toMatchObject({ state: "failed", interrupted: true });
    expect(latest().id).not.toBe(asked.id);
    expect(latest().context).toMatchObject({ mediaId: media.id, transcriptionProvider: "openai" });
    while (ctx.pending.size) await Promise.all([...ctx.pending]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(latest().state).toBe("done");
  } finally {
    label();
    vi.useRealTimers();
    turns.mockRestore();
    provider.mockRestore();
  }
});

it("imports raw video without encoding, coalesces preview requests and reuses completed chunks after restart", async () => {
  const file = join(directory, "interview.mp4");
  writeFileSync(file, "original");
  const render = workspace.ctx.render;
  vi.spyOn(render, "probeMedia").mockResolvedValue({ kind: "video", duration: 19, height: 2160, hasAudio: false, hasAlpha: false });
  const encode = vi.spyOn(render, "makeProxy").mockImplementation(async (_src, dest) => { writeFileSync(dest, "chunk"); });
  const result = await api("POST", projectsPath() + "/media/import", { path: file });
  expect(result.status).toBe(201);
  const { media } = await result.json();
  expect(media.previewMode).toBe("on-demand");
  await Promise.all([...workspace.ctx.pending]);
  const base = "/media/" + media.id;
  expect(await (await api("GET", base + "/file")).text()).toBe("original");
  expect(encode).not.toHaveBeenCalled();
  const url = base + "/preview/2";
  const hits = await Promise.all([api("GET", url), api("GET", url)]);
  for (const hit of hits) expect(await hit.text()).toBe("chunk");
  expect(encode).toHaveBeenCalledTimes(1);
  expect(encode.mock.calls[0]![2]).toMatchObject({ height: 480, range: { start: 16, end: 19 } });
  expect((await api("GET", base + "/preview/3")).status).toBe(400);
  await workspace.ctx.close();
  const unexpected = vi.fn();
  workspace = openWorkspace({ makeProxy: unexpected });
  expect(await (await api("GET", url)).text()).toBe("chunk");
  expect(unexpected).not.toHaveBeenCalled();
});

it("discards failed partial chunks so the next request can retry", async () => {
  const ctx = workspace.ctx;
  const asset = ctx.repos.projects.putMedia(project.id, { id: "med_retry", kind: "video", name: "Clip", path: "clip.mp4", duration: 16 }, "ready");
  const encode = vi.spyOn(ctx.render, "makeProxy")
    .mockImplementationOnce(async (_src, dest) => { writeFileSync(dest, "partial"); throw new Error("interrupted"); })
    .mockImplementationOnce(async (_src, dest) => { writeFileSync(dest, "finished"); });
  const url = "/media/" + asset.id + "/preview/1";
  expect((await api("GET", url)).status).toBe(500);
  expect(await (await api("GET", url)).text()).toBe("finished");
  expect(encode).toHaveBeenCalledTimes(2);
});

it("never publishes replaced source bytes into a second recording's shared preview cache", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const file = (id: string) => join(ctx.paths.media(project.id), id + ".mp4");
  for (const id of ["first", "second"]) {
    writeFileSync(file(id), "original");
    const { size, mtimeMs, ctimeMs } = statSync(file(id));
    ctx.repos.projects.putMedia(project.id, { id, kind: "video", name: id, path: id + ".mp4", duration: 10,
      hash: "same-original", previewMode: "on-demand", fingerprintStamp: { size, mtimeMs, ctimeMs } }, "ready");
  }
  const encode = vi.spyOn(ctx.render, "makeProxy").mockImplementation(async (source, dest) => {
    writeFileSync(dest, readFileSync(source));
  });
  writeFileSync(file("first"), "replacement");
  const cache = (id: string) => "/media/" + id + "/playback-cache";
  await api("POST", cache("first"));
  await Promise.all([...ctx.pending]);
  expect(await (await api("GET", cache("first") + "/file")).text()).toBe("replacement");
  expect(await (await api("GET", cache("second"))).json()).toMatchObject({ state: "uncached" });
  expect(await (await api("GET", "/media/first/preview/0")).text()).toBe("replacement");
  encode.mockImplementationOnce(async (source, dest) => {
    writeFileSync(dest, "untrusted bytes");
    writeFileSync(source, "changed during encode");
  });
  expect((await api("GET", "/media/second/preview/0")).status).toBe(500);
  expect(await (await api("GET", "/media/second/preview/0")).text()).toBe("changed during encode");
});

function addPreviewCamera(id: string) {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const path = id + ".mp4", file = join(ctx.paths.media(project.id), path);
  writeFileSync(file, id);
  const { size, mtimeMs, ctimeMs } = statSync(file);
  return ctx.repos.projects.putMedia(project.id, { id, path, name: id, kind: "video", previewMode: "on-demand",
    width: 1920, height: 1080, duration: 60, hasAlpha: false, fps: 30000 / 1001,
    previewClock: { frameRate: "30000/1001", startPts: 0, videoStart: 0 }, hash: sha256(id), fingerprintStamp: { size, mtimeMs, ctimeMs },
  }, "ready");
}

async function addClockedPreviewCamera(id: string, width: number, height: number, duration: number) {
  const { ctx } = workspace;
  const input = addPreviewCamera(id), source = join(ctx.paths.media(project.id), input.path);
  await runCapture(resolveFfmpeg(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `color=s=${width}x${height}:r=30000/1001:d=${duration}`,
    "-c:v", "libx264", "-threads", "1", source]);
  const { size, mtimeMs, ctimeMs } = statSync(source);
  return ctx.repos.projects.putMedia(project.id, { ...input, width, height, duration, fingerprintStamp: { size, mtimeMs, ctimeMs } }, "ready");
}

it("samples editor thumbnails from a matching proxy and keeps original inspection independent", async () => {
  const { ctx } = workspace;
  const media = await addClockedPreviewCamera("thumbnails", 320, 180, 6);
  const source = join(ctx.paths.media(project.id), media.path);
  const proxy = join(ctx.paths.proxies(project.id), `cached-${sha256(media.hash!)}.mp4`);
  const bytes = readFileSync(source);
  writeFileSync(proxy, bytes);
  vi.spyOn(ctx.render, "extractFrame").mockImplementation(async file => {
    if (file === proxy && readFileSync(file, "utf8") === "broken") throw new Error("invalid data");
    return Buffer.from(file === proxy ? "proxy" : "original");
  });
  const frame = async (query: string) => (await api("GET", `/media/${media.id}/frame?${query}`)).text();
  expect(await frame("t=3&w=160&preview=1")).toBe("proxy");
  expect(await frame("t=3&w=160")).toBe("original");
  expect(await frame("t=3&w=1920&preview=1")).toBe("original");
  writeFileSync(proxy, "broken");
  expect(await frame("t=5&w=160&preview=1")).toBe("original");
  writeFileSync(proxy, bytes);
  writeFileSync(source, "different source");
  expect(await frame("t=3&w=160&preview=1")).toBe("original");
});

it("builds HD source previews at 540p by default and pins playback through a resolution change", async () => {
  const { ctx } = workspace;
  const media = addPreviewCamera("camera");
  const encode = vi.spyOn(ctx.render, "makeProxy").mockImplementation(async (_, file, options) => {
    writeFileSync(file, String(options.height));
  });
  const url = "/media/camera/playback-cache";
  const picture = previewPictures(ctx.paths.media(project.id));
  const cache = async () => {
    expect((await api("POST", url)).status).toBe(200);
    await Promise.all(ctx.pending);
    const status = await (await api("GET", url)).json();
    expect(status).toMatchObject({ state: "ready", fileKey: expect.any(String) });
    return status.fileKey as string;
  };
  const first = await cache();
  expect(encode.mock.calls[0]![2].height).toBe(540);
  expect(await picture(media, 0, 10, 540)).toEqual({ file: join(ctx.paths.proxies(project.id), first), start: 0 });
  expect(await picture(media, 0, 10, 541)).toBeUndefined();

  await api("PATCH", "/settings", { render: { previewHeight: 720 } });
  expect(await (await api("GET", url)).json()).toMatchObject({ state: "uncached" });
  const second = await cache();
  expect(second).not.toBe(first);
  expect(encode.mock.calls.map(([, , opts]) => opts.height)).toEqual([540, 720]);
  const checkpoints = encode.mock.calls.map(([, , opts]) => opts.checkpointDir);
  expect(checkpoints).toEqual([expect.any(String), expect.any(String)]);
  expect(checkpoints[1]).not.toBe(checkpoints[0]);
  expect(await (await api("GET", url + "/file")).text()).toBe("720");
  const pinned = await workspace.app.request("/api" + url + "/file?fileKey=" + first, {
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, Range: "bytes=0-1" },
  });
  expect(pinned.status).toBe(206);
  expect(await pinned.text()).toBe("54");
  expect(await picture(media, 0, 10, 720)).toEqual({ file: join(ctx.paths.proxies(project.id), second), start: 0 });
  expect(await picture(media, 0, 10, 721)).toBeUndefined();

  await api("PATCH", "/settings", { render: { previewHeight: 360 } });
  expect(await cache()).toBe(first);
  expect(encode).toHaveBeenCalledTimes(2);
  addPreviewCamera("other");
  expect((await api("GET", "/media/other/playback-cache/file?fileKey=" + first)).status).toBe(404);
  expect((await api("GET", url + "/file?fileKey=" + encodeURIComponent("../proxies/" + first))).status).toBe(404);
});

it("reuses a legacy unsuffixed 720p source proxy after reopening with a lower preview height", async () => {
  const { ctx } = workspace;
  const media = await addClockedPreviewCamera("camera", 1280, 720, 1);
  const oldKey = "cached-" + sha256(media.hash!) + ".mp4";
  const file = join(ctx.paths.proxies(project.id), oldKey);
  const original = readFileSync(join(ctx.paths.media(project.id), media.path));
  writeFileSync(file, original);
  await api("PATCH", "/settings", { render: { previewHeight: 480 } });
  await ctx.close();
  const encode = vi.fn();
  workspace = openWorkspace({ makeProxy: encode });
  const url = "/media/camera/playback-cache";
  expect(await (await api("POST", url)).json()).toMatchObject({ state: "ready", fileKey: oldKey });
  expect(Buffer.from(await (await api("GET", url + "/file?fileKey=" + oldKey)).arrayBuffer())).toEqual(original);
  const picture = previewPictures(workspace.ctx.paths.media(project.id));
  expect(await picture(media, 0, 1, 720)).toEqual({ file, start: 0 });
  expect(encode).not.toHaveBeenCalled();
});

it.each(["", "-clock2"])("replaces completed preview files with legacy proxy clocks (%s) during normal full, segment and playback requests", async priorSuffix => {
  const { ctx } = workspace;
  const camera = addPreviewCamera("fractional");
  const tl = timelineFromKeepRanges(project.id, camera.id, [{ start: 24, end: 28 }]);
  const { version } = storeVersion(ctx, project.id, tl, { parent: null });
  await api("PATCH", "/settings", { render: { previewHeight: 480 } });
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_p, _tl, _r, file) => { writeFileSync(file, "segment"); });
  vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _tl, _r, _c, file) => { writeFileSync(file, "playback"); });
  for (const kind of ["full", "segment", "playback"] as const) {
    const input = { projectId: project.id, version, quality: "preview" as const, kind, range: kind === "full" ? null : { start: 0, end: 4 } };
    const current = ctx.renders.request(input);
    while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
    const row = ctx.repos.renders.get(current.id)!;
    expect(row.state).toBe("done");
    expect(row.previewContentKey).toMatch(/-clock3$/);
    const old = ctx.repos.renders.put({ ...row, previewContentKey: row.previewContentKey!.replace(/-clock3$/, priorSuffix) });
    expect(ctx.renders.isCurrent(old, ctx.repos.projects.get(project.id)!)).toBe(false);
    const next = ctx.renders.request(input);
    expect(next.id).not.toBe(old.id);
    expect(next.path).not.toBe(old.path);
    while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
    // An interrupted job can still render against the same source after the upgrade.
    ctx.repos.renders.put({ ...next, state: "queued", path: null, queuePid: undefined, previewContentKey: old.previewContentKey });
    ctx.renders.recover();
    while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
    expect(ctx.repos.renders.get(next.id)).toMatchObject({ state: "done", previewContentKey: row.previewContentKey });
  }
});

it("reuses a 360p source chunk only at adequate resolution and at its verified frame clock", async () => {
  const { ctx } = workspace;
  const media = await addClockedPreviewCamera("camera", 640, 360, 18);
  await api("PATCH", "/settings", { render: { previewHeight: 360 } });
  const response = await api("GET", "/media/camera/preview/1");
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  const picture = previewPictures(ctx.paths.media(project.id));
  const chunk = await picture(media, 8.1, 9, 360);
  expect(chunk?.file).toMatch(/v1-360-1\.mp4$/);
  expect(chunk?.start).toBeCloseTo(240 / media.fps!, 8);
  expect(await picture(media, 8.1, 9, 361)).toBeUndefined();
  expect(await picture(media, 8.1, 17, 360)).toBeUndefined();
  expect(await picture({ ...media, previewClock: { frameRate: "30/1", startPts: 0 } }, 8.1, 9, 360)).toBeUndefined();
  expect(await picture({ ...media, previewClock: { frameRate: "30000/1001", startPts: 1 } }, 8.1, 9, 360)).toBeUndefined();
});

it("caches a whole source only on request and reuses the completed file after restart", async () => {
  await workspace.ctx.close();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const makeProxy: RenderAdapter["makeProxy"] = vi.fn(async (_src, dest, opts) => {
    opts.onProgress?.(0.5);
    await gate;
    writeFileSync(dest, "complete cached video");
  });
  workspace = openWorkspace({ makeProxy });
  const media = { id: "med_cache", name: "Camera", kind: "video" as const, path: "camera.mp4",
    previewMode: "on-demand" as const, duration: 120 };
  workspace.ctx.repos.projects.putMedia(project.id, media, "ready");
  const published = vi.fn();
  workspace.ctx.bus.on("ws", published);
  const url = `/media/${media.id}/playback-cache`;
  expect(await (await api("GET", url)).json()).toMatchObject({ state: "uncached" });
  expect(makeProxy).not.toHaveBeenCalled();
  try {
    await Promise.all([api("POST", url), api("POST", url)]);
    await vi.waitFor(() => expect(makeProxy).toHaveBeenCalledTimes(1));
    expect(await (await api("GET", url)).json()).toMatchObject({ state: "caching", progress: 0.5 });
    expect((await api("GET", url + "/file")).status).toBe(404);
  } finally { finish(); }
  await Promise.all([...workspace.ctx.pending]);
  expect(published).toHaveBeenCalledWith({ type: "media.previewReady", projectId: project.id, mediaId: media.id });
  await workspace.ctx.close();
  workspace = openWorkspace({ makeProxy });
  expect(await (await api("POST", url)).json()).toMatchObject({ state: "ready" });
  expect(await (await api("GET", url + "/file")).text()).toBe("complete cached video");
  expect(makeProxy).toHaveBeenCalledTimes(1);
});

it("recovers a previously interrupted full-file preview as on-demand without serving its partial MP4", async () => {
  const { paths, repos, db } = workspace.ctx;
  paths.ensureProject(project.id);
  const asset = repos.projects.putMedia(project.id, { id: "med_interrupted_long", name: "Recording", path: "recording.mp4",
    kind: "video", duration: 3600, preparation: { stage: "preview", fraction: 0.1 } }, "ingesting");
  writeFileSync(join(paths.media(project.id), asset.path), "original");
  writeFileSync(join(paths.proxies(project.id), asset.id + ".mp4"), "partial");
  db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = ?").run(asset.id);
  await workspace.ctx.close();
  const makeProxy = vi.fn();
  workspace = openWorkspace({ makeProxy });
  await Promise.all([...workspace.ctx.pending]);
  expect(workspace.ctx.repos.projects.getMedia(asset.id)).toMatchObject({ status: "ready", previewMode: "on-demand" });
  expect(await (await api("GET", "/media/" + asset.id + "/proxy")).text()).toBe("original");
  expect(makeProxy).not.toHaveBeenCalled();
});

it("reprepares interrupted footage and serves the original until its proxy is complete", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const asset = {
    id: "med_interrupted", kind: "video" as const, name: "Interview", path: "interview.mov", hasAudio: true,
    preparation: { stage: "preview" as const, fraction: 0.3 },
  };
  writeFileSync(join(ctx.paths.media(project.id), asset.path), "original");
  writeFileSync(join(ctx.paths.proxies(project.id), asset.id + ".mp4"), "partial");
  ctx.repos.projects.putMedia(project.id, asset, "ingesting");
  ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = ?").run(asset.id); // Saved by an older engine.
  ctx.repos.projects.putMedia(project.id, { ...asset, id: "med_still_owned" }, "ingesting");
  await ctx.close();

  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const extractWaveformFull = vi.fn(async () => ({ peaks: [0], rms: [0] }));
  workspace = openWorkspace({ async makeProxy(_src, dest) {
    await gate;
    writeFileSync(dest, "finished proxy");
  }, extractWaveformFull });
  const path = "/media/" + asset.id + "/proxy";
  try {
    expect(await (await api("GET", path)).text()).toBe("original");
  } finally {
    finish();
  }
  await Promise.all([...workspace.ctx.pending]);
  expect(workspace.ctx.repos.projects.getMedia(asset.id)?.status).toBe("ready");
  expect(extractWaveformFull).not.toHaveBeenCalled();
  const wavePath = "/media/" + asset.id + "/waveform";
  const both = await Promise.all([api("GET", wavePath), api("GET", wavePath + "?points=2")]);
  expect(both.map(r => r.status)).toEqual([200, 200]);
  expect(extractWaveformFull).toHaveBeenCalledTimes(1);
  expect(workspace.ctx.repos.projects.getMedia(asset.id)?.preparation).toBeUndefined();
  expect(workspace.ctx.repos.projects.getMedia("med_still_owned")?.status).toBe("ingesting");
  expect(await (await api("GET", path)).text()).toBe("finished proxy");
  // A second interruption during waveform extraction must keep the published proxy intact.
  workspace.ctx.repos.projects.putMedia(project.id, { ...asset, preparation: { stage: "waveform", fraction: 0.25 } }, "ingesting");
  workspace.ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = ?").run(asset.id);
  await workspace.ctx.close();
  const makeProxy = vi.fn();
  workspace = openWorkspace({ makeProxy, extractWaveformFull });
  expect((await api("GET", wavePath)).status).toBe(200);
  expect(extractWaveformFull).toHaveBeenCalledTimes(1);
  await Promise.all([...workspace.ctx.pending]);
  expect(makeProxy).not.toHaveBeenCalled();
  expect(workspace.ctx.repos.projects.getMedia(asset.id)?.status).toBe("ready");
  expect(await (await api("GET", path)).text()).toBe("finished proxy");
});

it("retries a failed first waveform read without failing playable media", async () => {
  const { ctx } = workspace;
  const media = ctx.repos.projects.putMedia(project.id, { id: "speech", kind: "audio", name: "Voice", path: "voice.wav", hasAudio: true, duration: 2 }, "ready");
  ctx.paths.ensureProject(project.id);
  const extract = vi.spyOn(ctx.render, "extractWaveformFull").mockRejectedValueOnce(new Error("decoder failed")).mockResolvedValue({ peaks: [1] });
  const route = "/media/" + media.id + "/waveform?points=2";
  expect((await api("GET", route)).status).toBe(500);
  expect(ctx.repos.projects.getMedia(media.id)?.status).toBe("ready");
  expect((await api("GET", route)).status).toBe(200);
  expect(extract).toHaveBeenCalledTimes(2);
});

it("serves active upload types as sandboxed attachments on both original routes and preserves provenance", async () => {
  const bytes = Buffer.concat([Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"), Buffer.from("<script>window.review=true</script>")]);
  for (const file of ["art.html", "art.gif"]) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), file);
    form.append("kind", "image");
    form.append("provenance", JSON.stringify({ by: "agent", name: "Generator", model: "local", prompt: "A sunset" }));
    const upload = await api("POST", projectsPath() + "/media", form);
    expect(upload.status).toBe(201);
    const { media } = await upload.json();
    expect(media.provenance).toMatchObject({ by: "agent", name: "Generator", model: "local", prompt: "A sunset" });
    expect(media.uploadedBy).toBe(localUser(workspace.ctx).id);
    for (const route of ["file", "proxy"]) {
      const res = await api("GET", `/media/${media.id}/${route}`);
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-type")).toBe(file.endsWith(".gif") ? "image/gif" : "application/octet-stream");
      expect(res.headers.get("content-disposition")).toBe(file.endsWith(".gif") ? null : "attachment");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    }
  }
});

it("rejects invalid skill destinations before changing the old mirror", async () => {
  const created = await api("POST", "/skills", { name: "style", content: "Original" });
  const { skill } = await created.json();
  const path = join(directory, "skills", "team", "style", "SKILL.md");
  for (const body of [{ scope: "project", projectId: project.id }, { projectId: project.id }]) {
    expect((await api("POST", "/skills", { ...body, name: "another", content: "Changed" })).status).toBe(400);
    expect((await api("PUT", "/skills/" + skill.id, { ...body, content: "Changed" })).status).toBe(400);
    expect(workspace.ctx.repos.skills.get(skill.id)?.content).toBe("Original");
    expect(readFileSync(path, "utf8")).toBe("Original");
  }
  const other = join(directory, "unrelated");
  mkdirSync(other);
  symlinkSync(other, join(directory, "skills", "team", "unsafe"), "junction");
  expect((await api("PUT", "/skills/" + skill.id, { name: "unsafe" })).status).toBe(400);
  expect(existsSync(join(other, "SKILL.md"))).toBe(false);
  expect((await api("PUT", "/skills/" + skill.id, { content: "Allowed" })).status).toBe(200);
  expect(readFileSync(path, "utf8")).toBe("Allowed");
});

it("pins an empty timeline and rejects late task output and cross-project links before creating versions", async () => {
  const { timeline } = await (await api("GET", projectsPath() + "/timeline")).json();
  expect(timeline.version).not.toBe("draft");
  expect((await api("GET", projectsPath() + "/timeline?version=" + timeline.version)).status).toBe(200);
  const other = workspace.ctx.repos.projects.insert(createProject("Other"));
  const { note } = await (await api("POST", `/projects/${other.id}/notes`, { text: "Private", time: 0 })).json();
  const makeTask = (id: string) => createTask(workspace.ctx, { projectId: id, kind: "edit", agent: "claude", instruction: "Edit", createdBy: { type: "human", name: "Editor" } });
  const cancelled = cancelTask(workspace.ctx, makeTask(project.id));
  const change = { description: "Marker", fromVersion: timeline.version, ops: marker, skipRender: true, autoApprove: true };
  expect((await api("POST", projectsPath() + "/changes", { ...change, noteIds: [note.id] })).status).toBe(400);
  expect((await api("POST", projectsPath() + "/changes", { ...change, taskId: makeTask(other.id).id })).status).toBe(400);
  expect((await api("POST", projectsPath() + "/changes", { ...change, taskId: cancelled.id })).status).toBe(409);
  expect((await api("POST", "/tasks/" + cancelled.id + "/events", { type: "question", text: "Late?" })).status).toBe(409);
  expect(workspace.ctx.repos.versions.list(project.id)).toHaveLength(1);
  const allowed = await api("POST", projectsPath() + "/changes", change);
  expect(allowed.status).toBe(201);
  expect(workspace.ctx.repos.notes.get(note.id)?.state).toBe("open");
});

it("recovers render workers and keys delivery by the full settings used when queued", async () => {
  const { ctx } = workspace;
  const { head } = ensureHead(ctx, project.id);
  const input = { projectId: project.id, version: head, kind: "full", quality: "delivery", range: null } as const;
  const initial = ctx.renders.request(input);
  await Promise.all([...ctx.pending]);
  const done = ctx.repos.renders.get(initial.id)!;
  expect(done.state).toBe("done");
  ctx.repos.renders.put({ ...done, state: "running", path: null, progress: 0.5 });
  const linked: Change = { id: "fixture-change", projectId: project.id, fromVersion: head, toVersion: head, description: "Test", author: { type: "human", name: "Editor" }, noteIds: [], ranges: [], renders: [{ before: null, after: initial.id, range: { start: 0, end: 1 } }], state: "rendering" };
  ctx.repos.changes.put(linked);
  ctx.repos.projects.update(project.id, { settings: { width: 1080, fps: 60, sampleRate: 44100 } });
  await ctx.close();
  workspace = openWorkspace();
  const fresh = workspace.ctx;
  await Promise.all([...fresh.pending]);
  const recovered = fresh.repos.renders.get(initial.id)!;
  expect(recovered.state).toBe("done");
  expect(fresh.repos.changes.get(linked.id)?.state).toBe("ready");
  expect(JSON.parse(readFileSync(join(fresh.paths.renders(project.id), recovered.path!), "utf8"))).toEqual(project.settings);
  const next = fresh.renders.request(input);
  expect(next.key).not.toBe(initial.key);
  await Promise.all([...fresh.pending]);
  const current = await (await api("GET", projectsPath() + "/renders?currentDelivery=true")).json();
  expect(current.currentDeliveryKey).toBe(next.key);
  const playback = await (await api("GET", projectsPath() + "/renders?kind=full&version=head")).json();
  expect(playback.fullRenderKeys.delivery).toBe(next.key);
  expect(playback.fullRenderKeys.preview).toBe(fresh.renders.keyFor(fresh.repos.projects.header(project.id)!, { ...input, quality: "preview" }));
  expect(current.renders.map((r: { id: string }) => r.id)).toEqual([next.id]);
  expect(fresh.renders.request(input).id).toBe(next.id);
});

it("keeps a promoted export with its live engine and transfers it only after the old encoder drains", async () => {
  const { ctx } = workspace;
  const { head } = ensureHead(ctx, project.id);
  const input = { projectId: project.id, version: head, kind: "full", range: null, quality: "delivery" } as const;
  let drain!: () => void;
  const first = vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _t, _c, file) => {
    writeFileSync(file, "partial");
    await new Promise<void>(resolve => { drain = resolve; });
  });
  const claimed = ctx.renders.request(input, "export-ticket");
  expect(ctx.renders.request(input).id).toBe(claimed.id);
  const second = vi.fn(async (_p: Project, _t: unknown, _c: string, file: string) => { writeFileSync(file, "replacement"); });
  const peer = openWorkspace({ renderFullCached: second });
  workspace = peer;
  try {
    expect(peer.ctx.renders.request(input).id).toBe(claimed.id);
    ctx.renders.release(claimed.id, "export-ticket");
    expect(peer.ctx.renders.cancel(claimed.id)?.state).toBe("running");
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    const closing = ctx.close();
    peer.ctx.renders.recover();
    expect(second).not.toHaveBeenCalled();
    drain();
    await closing;
    expect(peer.ctx.repos.renders.get(claimed.id)?.queuePid).toBeUndefined();
    expect(peer.ctx.renders.request(input).id).toBe(claimed.id);
    await Promise.all([...peer.ctx.pending]);
    expect(second).toHaveBeenCalledOnce();
    const done = peer.ctx.repos.renders.get(claimed.id)!;
    expect(done.state).toBe("done");
    expect(readFileSync(join(ctx.paths.renders(project.id), done.path!), "utf8")).toBe("replacement");
  } finally {
    drain();
    if (!ctx.shutdown.aborted) await ctx.close();
  }
});

it("stops an active export on workspace close and resumes that job and its waiting neighbor on reopen", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({render:{concurrency:1}});
  const { head } = ensureHead(ctx, project.id);
  const input = { projectId:project.id, version:head, kind:"full", range:null } as const;
  const started: string[] = [];
  const interrupted: string[] = [];
  vi.spyOn(ctx.render,"renderFullCached").mockImplementation(async (_p,_tl,_cache,file,opts) => {
    started.push(file);
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve,150);
      opts?.signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        interrupted.push(file);
        resolve();
      },{once:true});
    });
    if (!opts?.signal?.aborted) writeFileSync(file,"finished");
  });
  const first=ctx.renders.request({...input,quality:"delivery"});
  const waiting=ctx.renders.request({...input,quality:"preview"});
  expect(started).toHaveLength(1);
  expect(ctx.repos.renders.get(waiting.id)?.state).toBe("queued");
  await ctx.close();
  workspace=openWorkspace();
  await Promise.all([...workspace.ctx.pending]);
  expect(interrupted).toEqual(started);
  expect(started).toHaveLength(1);
  for (const job of [first,waiting]) {
    const resumed=workspace.ctx.repos.renders.get(job.id);
    expect(resumed).toMatchObject({id:job.id,state:"done",key:job.key});
    expect(readFileSync(join(workspace.ctx.paths.renders(project.id),resumed!.path!),"utf8")).toBe(JSON.stringify(project.settings));
  }
});

it("finishes an export after the workspace closes and reopens, and still cancels a viewer's cache", async () => {
  const { ctx } = workspace;
  ctx.repos.settings.update({ render: { concurrency: 2 } });
  const { head } = ensureHead(ctx, project.id);
  const partial: string[] = [];
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(async (_p, _tl, _cache, file, opts) => {
    writeFileSync(file, "partial");
    partial.push(file);
    await new Promise<void>(resolve => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  const owner = randomUUID();
  const save = { name: "Cut.mp4", ticket: 41, path: "/chosen/Cut.mp4" };
  const requested = await api("POST", projectsPath() + "/renders", { kind: "export", quality: "delivery", exportOptions: { height: 480 }, owner, export: save });
  expect(requested.status).toBe(201);
  const { render: exported } = await requested.json();
  expect(exported.export).toEqual({ ...save, owner });
  const cache = ctx.renders.request({ projectId: project.id, version: head, kind: "full", range: null, quality: "preview" }, randomUUID());
  expect(partial).toHaveLength(2);
  expect((await api("POST", projectsPath() + "/renders", { kind: "segment", range: { start: 0, end: 1 }, export: save })).status).toBe(400);
  await ctx.close();
  expect(partial.filter(file => existsSync(file))).toEqual([]);

  workspace = openWorkspace();
  const fresh = workspace.ctx;
  expect(fresh.repos.renders.get(cache.id)?.state).toBe("cancelled");
  const listed = async () => (await (await api("GET", "/exports")).json()).renders as Render[];
  expect((await listed()).map(r => r.id)).toEqual([exported.id]);
  await Promise.all([...fresh.pending]);
  const done = fresh.repos.renders.get(exported.id)!;
  expect(done).toMatchObject({ id: exported.id, key: exported.key, state: "done", export: { ...save, owner } });
  expect(readFileSync(join(fresh.paths.renders(project.id), done.path!), "utf8")).toBe(JSON.stringify(project.settings));
  // The export stays listed until the desktop app has saved the file and released it.
  expect((await listed())[0]).toMatchObject({ id: exported.id, state: "done" });
  expect((await api("DELETE", `/renders/${exported.id}/owners/${owner}`)).status).toBe(204);
  expect(await listed()).toEqual([]);
  expect(fresh.repos.renders.get(exported.id)).toMatchObject({ state: "done", path: done.path });
});

it("lets the editor cancel an export resumed after a hard stop, and removes a killed viewer's partial file", async () => {
  const { ctx } = workspace;
  const { head } = ensureHead(ctx, project.id);
  const owner = randomUUID();
  const stops: Array<() => void> = [];
  const stop = () => stops.forEach(done => done());
  ctx.repos.settings.update({ render: { concurrency: 2 } });
  vi.spyOn(ctx.render, "renderFullCached").mockImplementation(() => new Promise<void>(resolve => { stops.push(resolve); }));
  const exported = ctx.renders.request({ projectId: project.id, version: head, kind: "full", range: null, quality: "delivery" }, owner, { name: "Cut.mp4", ticket: 7 });
  const viewer = ctx.renders.request({ projectId: project.id, version: head, kind: "full", range: null, quality: "preview" }, randomUUID());
  // Leave both rows as a killed engine would: claimed by a process that no longer exists.
  const dead = 2 ** 22 + 1;
  for (const id of [exported.id, viewer.id]) ctx.repos.renders.put({ ...ctx.repos.renders.get(id)!, state: "running", queuePid: dead, demandPid: dead });
  const dir = ctx.paths.renders(project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${viewer.id}.mp4`), "partial");
  const peer = openWorkspace({ renderFullCached: (_p, _tl, _cache, _file, opts) =>
    new Promise<void>(resolve => opts?.signal?.addEventListener("abort", () => resolve(), { once: true })) });
  try {
    expect(peer.ctx.repos.renders.get(viewer.id)?.state).toBe("cancelled");
    expect(existsSync(join(dir, `${viewer.id}.mp4`))).toBe(false);
    expect(peer.ctx.repos.renders.get(exported.id)).toMatchObject({ state: "running", demandPid: process.pid });
    peer.ctx.renders.release(exported.id, owner);
    expect(peer.ctx.repos.renders.get(exported.id)).toMatchObject({ state: "cancelled" });
    expect(peer.ctx.repos.renders.get(exported.id)?.export).toBeUndefined();
    expect(peer.ctx.renders.exports()).toEqual([]);
  } finally {
    stop();
    await peer.ctx.close();
  }
});

it("migrates scoped skills on restart and keeps their instructions after project deletion", async () => {
  const { ctx } = workspace;
  const { skill: global } = await (await api("POST", "/skills", { name: "style", content: "shared", enabled: false })).json();
  // Recreate the previous storage format, including a same-name override.
  ctx.db.exec("DROP INDEX skills_name");
  for (const [id, name] of [["scoped", "style"], ["unique", "captions"]] as const) {
    const old = { ...global, id, name, scope: "project", projectId: project.id, enabled: true, content: "local" };
    ctx.db.prepare("INSERT INTO skills (id,name,scope,project_id,json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, name, old.scope, project.id, JSON.stringify(old), global.createdAt, global.updatedAt);
    ctx.repos.skillVersions.append(id, { version: 1, content: "local" });
    const folder = join(ctx.paths.skills, "project", project.id, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), old.content);
  }
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Edit",
    context: { skillIds: ["scoped", "unique"] }, createdBy: { type: "human", name: "Editor" } });
  appendTaskEvent(ctx, task, { type: "log", text: "Started" });
  await ctx.close();
  workspace = openWorkspace();
  const fresh = workspace.ctx;
  expect(fresh.repos.skills.select().map(s => s.name).sort()).toEqual(["captions", "style"]);
  expect(fresh.repos.tasks.get(task.id)?.context.skillIds).toEqual([global.id, "unique"]);
  expect(fresh.repos.skills.get(global.id)).toMatchObject({ content: "shared", enabled: false });
  expect(fresh.repos.skillVersions.list(global.id).map(v => v.content)).toEqual(["shared", "local", "shared"]);
  expect(fresh.repos.skills.get("unique")).toMatchObject({ scope: "team", projectId: null });
  expect(existsSync(join(fresh.paths.skills, "project", project.id, "style", "SKILL.md"))).toBe(false);
  fresh.repos.projects.softDelete(project.id);
  expect(purgeTrash(fresh, Date.now() + 32 * 86400000)).toBe(1);
  expect(fresh.repos.taskEvents.list(task.id)).toEqual([]);
  expect(readFileSync(join(fresh.paths.skills, "team", "captions", "SKILL.md"), "utf8")).toBe("local");
  expect(fresh.repos.skills.get("unique")?.enabled).toBe(true);
});

it("retries an ordinary failed edit once with its original source range", async () => {
  const { ctx } = workspace;
  const failed = createTask(ctx, {
    projectId: project.id, kind: "edit", agent: "codex", instruction: "Trim the stumble",
    context: { mediaId: "camera-b", time: 8, end: 12 }, state: "failed", createdBy: { type: "human", name: "Editor" },
  });
  const retry = async () => (await (await api("POST", `/tasks/${failed.id}/retry`)).json()).task;
  const [first, second] = await Promise.all([retry(), retry()]);
  expect(first.id).toBe(second.id);
  expect(first).toMatchObject({ state: "queued", instruction: failed.instruction, agent: "codex",
    context: { mediaId: "camera-b", time: 8, end: 12, threadId: failed.id } });
});

it("retries a failed edit on the model the editor picked since, not the one that failed", async () => {
  const { ctx } = workspace;
  const failed = createTask(ctx, {
    projectId: project.id, kind: "edit", agent: "claude", model: "gone-model", effort: "max", fast: true, instruction: "Cut the repeats",
    state: "failed", createdBy: { type: "human", name: "Editor" },
  });
  const res = await api("POST", `/tasks/${failed.id}/retry`, { agent: "claude", model: "opus", effort: "high" });
  const retry = (await res.json()).task as Task;
  expect(retry).toMatchObject({ state: "queued", agent: "claude", model: "opus", effort: "high", context: { threadId: failed.id } });
  expect(retry.fast).toBeUndefined();
  expect((await api("POST", `/tasks/${failed.id}/retry`, { agent: "nope" })).status).toBe(400);
  await api("POST", `/tasks/${retry.id}/cancel`, {});
});

it("reopens rejected edits without changing the cut or promoting failed renders", async () => {
  const { ctx } = workspace;
  const { change } = await (await api("POST", projectsPath() + "/changes", { description: "Name this moment", ops: marker, skipRender: true })).json();
  const head = ctx.repos.projects.get(project.id)?.head;
  for (const state of ["ready", "failed"] as const) {
    ctx.repos.changes.put({ ...change, state });
    await api("POST", `/changes/${change.id}/reject`, { reason: "Accidental" });
    const res = await api("POST", `/changes/${change.id}/reopen`);
    expect(res.status).toBe(200);
    const reopened = (await res.json()).change;
    expect(reopened.state).toBe(state);
    expect(reopened.decidedBy).toBeUndefined();
    expect(reopened.rejectReason).toBeUndefined();
    expect(ctx.repos.projects.get(project.id)?.head).toBe(head);
  }
  expect((await api("POST", `/changes/${change.id}/reopen`)).status).toBe(409);
});

it("shares in-flight source frames, bounds decoders and evicts by byte size", async () => {
  const cache = new AnalysisCache<Buffer>(frame => frame.length, 80, 1);
  let finish!: (frame: Buffer) => void;
  const first = vi.fn(() => new Promise<Buffer>(resolve => { finish = resolve; }));
  const second = vi.fn(async () => Buffer.from("222"));
  const requests = Array.from({ length: 10 }, () => cache.get("frame1", first));
  const queued = cache.get("frame2", second);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  finish(Buffer.from("11"));
  expect(await Promise.all(requests)).toHaveLength(10);
  await queued;
  await cache.get("frame2", second);
  expect(second).toHaveBeenCalledTimes(1);
  await expect(cache.get("frame1", async () => { throw Error("transient"); })).rejects.toThrow("transient");
  expect(await cache.get("frame1", async () => Buffer.from("ok"))).toEqual(Buffer.from("ok"));
});

it("prioritizes monitor frames and drops unseen filmstrip samples without cancelling another reader", async () => {
  const cache = new AnalysisCache<string>(s => s.length, 1000, 1);
  let resume!: (s: string) => void;
  const blocker = cache.get("busy", () => new Promise<string>(resolve => { resume = resolve; }));
  const decoded: string[] = [];
  const frame = (key: string, signal?: AbortSignal, priority = false) => cache.get(key, async () => {
    decoded.push(key); return key;
  }, { signal, priority });
  const abandoned = new AbortController(), shared = new AbortController();
  const sample = frame("obsolete", abandoned.signal).catch(() => "aborted");
  const reads = [frame("strip", shared.signal).catch(() => "aborted"), frame("strip"), frame("monitor"), frame("monitor", undefined, true)];
  abandoned.abort();
  shared.abort();
  resume("busy");
  await Promise.all([blocker, ...reads]);
  expect(await sample).toBe("aborted");
  expect(decoded).toEqual(["monitor", "strip"]);
});

it("measures a recording's loudness once, answers the same request again from memory, and measures a replaced file again", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const file = join(ctx.paths.media(project.id), "tone.wav");
  // The same second of tone at two levels. Both files are the same size and get the same date, as when
  // another program swaps a recording and puts its date back, so only the file's change time differs.
  const dated = new Date("2026-01-01T00:00:00Z");
  const tone = async (volume: number) => {
    await runCapture(resolveFfmpeg(), ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-af", `volume=${volume}`, file]);
    utimesSync(file, dated, dated);
    const { size, mtimeMs } = statSync(file);
    return { size, mtimeMs };
  };
  const original = await tone(1);
  // Fingerprinted, as after import, so the cache key carries a path and a hash like a real recording's.
  ctx.repos.projects.putMedia(project.id, { id: "tone", kind: "audio", name: "Tone", path: "tone.wav",
    hash: sha256("tone"), duration: 1, hasAudio: true }, "ready");
  // The route hands each measurement to ctx.track, so its calls count the ffmpeg runs.
  const measuring = vi.spyOn(ctx, "track");
  const loudness = async () => (await api("GET", projectsPath() + "/media/tone/loudness")).json();
  const first = await loudness();
  expect(first).toMatchObject({ mediaId: "tone", integratedLufs: expect.any(Number) });
  expect(await loudness()).toEqual(first);
  expect(measuring).toHaveBeenCalledTimes(1);
  expect(await tone(0.25)).toEqual(original);
  expect((await loudness()).integratedLufs).toBeLessThan(first.integratedLufs - 6);
  expect(measuring).toHaveBeenCalledTimes(2);
});

it("encodes one preview across ten simultaneous versions and keeps their identities", async () => {
  const { ctx } = workspace;
  const encode = vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, output) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    writeFileSync(output, "completed sample");
  });
  const versions: string[] = [];
  const base = ensureHead(ctx, project.id).head;
  for (let i = 0; i < 10; i++) {
    const response = await api("POST", projectsPath() + "/changes?summary=true", { description: "Cards", fromVersion: base,
      ops: [{ op: "addClip", trackId: "v1", clip: { id: "intro", kind: "color", color: "red", timelineIn: 0, timelineOut: 10 } },
        { op: "addClip", trackId: "v1", clip: { id: "later", kind: "color", color: "blue", timelineIn: 20, timelineOut: 21 + i } }] });
    expect(response.status).toBe(201);
    const summary = await response.json();
    expect(summary).not.toHaveProperty("timeline");
    expect(summary.change).not.toHaveProperty("ops");
    expect(summary.duration).toBe(21 + i);
    expect(summary.diffDescription.length).toBeGreaterThan(0);
    versions.push(summary.change.toVersion);
  }
  const request = (version: string, start = 0) => ctx.renders.request({ projectId: project.id, version, quality: "preview",
    kind: "segment", range: { start, end: start + 2 } });
  const jobs = versions.map(v => request(v));
  expect(jobs.map(j => j.version)).toEqual(versions);
  while (ctx.pending.size) await Promise.all([...ctx.pending]);
  expect(encode).toHaveBeenCalledTimes(1);
  const saved = jobs.map(j => ctx.repos.renders.get(j.id)!);
  expect(saved.every(r => r.state === "done")).toBe(true);
  expect(new Set(saved.map(r => r.path)).size).toBe(1);
  expect(request(versions[4]!).id).toBe(jobs[4]!.id);
  request(versions[0]!, 20);
  request(versions[9]!, 20);
  while (ctx.pending.size) await Promise.all([...ctx.pending]);
  expect(encode).toHaveBeenCalledTimes(3);
});

it("runs one request at a time per project, in the order asked, across agent types", async () => {
  const { ctx } = workspace;
  const { host } = await (await api("POST", "/hosts/register", { name: "Workers", platform: "test",
    agents: [{ id: "claude", installed: true }, { id: "codex", installed: true }] })).json();
  const make = (agent: "claude" | "codex", threadId?: string) => createTask(ctx, { projectId: project.id, kind: "edit", agent,
    instruction: "Edit", context: { threadId }, createdBy: { type: "human", name: "Editor" } });
  const first = make("claude");
  const follow = make("codex", first.id);
  const independent = make("codex");
  for (let i = 0; i < 40; i++) make("claude");
  const claim = async (body: object) => (await (await api("POST", `/hosts/${host.id}/claim`, body)).json()).task;
  // A separate request in another thread still waits its turn.
  expect(await claim({ agents: ["codex"] })).toBeNull();
  expect(await claim({ taskId: independent.id })).toBeNull();
  const parse = vi.spyOn(ctx.repos.tasks, "parse");
  expect((await claim({ agents: ["claude"] })).id).toBe(first.id);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(await claim({ agents: ["claude", "codex"] })).toBeNull();
  await api("POST", `/tasks/${first.id}/complete`, { state: "done" });
  expect((await claim({ agents: ["codex"] })).id).toBe(follow.id);
  await api("POST", `/tasks/${follow.id}/complete`, { state: "done" });
  expect((await claim({ agents: ["codex"] })).id).toBe(independent.id);
});

it("leaves a request queued when its host hangs up during a claim's long poll", async () => {
  const { ctx } = workspace;
  const { host } = await (await api("POST", "/hosts/register", { name: "Gone", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  const hangUp = new AbortController();
  const poll = workspace.app.request(`/api/hosts/${host.id}/claim?wait=30`, { method: "POST", signal: hangUp.signal,
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" }, body: "{}" });
  await new Promise(resolve => setTimeout(resolve, 50));
  hangUp.abort();
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Edit", createdBy: { type: "human", name: "Editor" } });
  expect((await (await poll).json()).task).toBeNull();
  expect(ctx.repos.tasks.get(task.id)?.state).toBe("queued");
});

it.each(["a1", "alternate"])("requires an audio check of the version that plays, including repeats inside a kept take and across a ripple onto %s", async track => {
  const { ctx } = workspace;
  const { host } = await (await api("POST", "/hosts/register", { name: "Host", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, { taskId: pass.id })).json()).task as Task;
  const finish = async () => (await (await api("POST", `/tasks/${pass.id}/complete`, { state: "done" })).json()).task as Task;
  const check = (version: string, keep?: { id: string; reason: string }[]) => api("POST", projectsPath() + `/tasks/${pass.id}/repeat-audit`, { version, keep });
  await claim();
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "Mic", path: "mic.wav", kind: "audio", hasAudio: true, duration: 20 }, "ready");
  await micSpeech({ 30: "go|", 110: "go|", 150: "now|very|very|fast|" });
  const version = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble two takes", ops: [
    { op: "addTrack", track: { id: "alternate", name: "Other microphone", kind: "audio" } },
    { op: "addClip", trackId: "a1", clip: { id: "one", kind: "media", mediaId: "mic", sourceIn: 0, sourceOut: 1, timelineIn: 0 } },
    { op: "addClip", trackId: track, clip: { id: "two", kind: "media", mediaId: "mic", sourceIn: 2, sourceOut: 8, timelineIn: 1 } },
  ] }).change.toVersion;
  expect((await finish()).state).toBe("queued");
  await claim();
  const found = await (await check(version)).json();
  expect(found.unavailable).toBeUndefined();
  expect(found).toMatchObject({ heard: 2, remaining: 2, repeats: [{ phrase: "go", atJoin: true }, { phrase: "very", atJoin: false }] });
  ctx.repos.settings.update({ dialogue: { aiCuts: { retake: "off" } } });
  expect(await (await check(version)).json()).toMatchObject({ heard: 2, remaining: 0, retakes: "off" });
  ctx.repos.settings.update({ dialogue: { aiCuts: { retake: "cut" } } });
  expect((await finish()).state).toBe("queued");
  await claim();
  const keep = [{ id: found.repeats[1].id, reason: "Spoken emphasis" }];
  expect(await (await check(version, keep)).json()).toMatchObject({ heard: 2, remaining: 1 });
  const repaired = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Keep the second go",
    ops: [{ op: "rippleDelete", start: .5, end: 1 }] }).change.toVersion;
  expect((await check(version)).status).toBe(409);
  expect((await finish()).state).toBe("queued");
  await claim();
  expect(await (await check(repaired)).json()).toMatchObject({ heard: 1, remaining: 0, staged: 0 });
  const proposed = (await (await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: repaired, description: "Shorten the tail",
    cuts: [{ start: 4, end: 5, review: true, reason: "Check the final beat." }] })).json()).changes[0] as Change;
  expect((await finish()).state).toBe("done");
  expect((await api("POST", `/changes/${proposed.id}/approve`, { restoredCuts: [] })).status).toBe(200);
  expect(ctx.repos.tasks.get(pass.id)?.state).toBe("queued");
  await claim();
  const approved = ctx.repos.projects.header(project.id)!.head!;
  expect(await (await check(approved)).json()).toMatchObject({ version: approved, heard: 1, remaining: 0 });
  expect(await finish()).toMatchObject({ state: "done", repeatAudit: { remaining: 0, noFindings: false } });
});

it("finds a six-word opening repeated inside the kept audio and clears it when the pickup is removed", async () => {
  const { ctx } = workspace;
  const { task, base } = dialoguePassInParts();
  saveTask(ctx, { ...task, state: "running", startedAt: new Date().toISOString() });
  const opening = "the|next|train|to|grand|lake|";
  await micSpeech({ 10: opening, 140: opening + "leaves|at|dawn|" });
  const check = async (version: string) => {
    const response = await api("POST", projectsPath() + `/tasks/${task.id}/repeat-audit`, { version });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await check(base)).toMatchObject({ heard: 1, remaining: 1, repeats: [{
    phrase: "the next train to grand lake", first: { start: .2 }, second: { start: 2.8 }, atJoin: false,
    occurrences: { first: { clipId: "raw" }, second: { clipId: "raw", after: { text: "leaves" } } },
  }] });
  const corrected = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Start on the complete take",
    cuts: [{ start: 0, end: 2.6, review: false, kind: "retake", reason: "Keep the opening that continues into the departure time." }] });
  expect(corrected.status).toBe(201);
  expect(await check((await corrected.json()).head)).toMatchObject({ heard: 0, remaining: 0, repeats: [] });
});

it("reports an unreadable recording and leaves its checked work resumable", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "Mic", path: "missing.wav", kind: "audio", hasAudio: true, duration: 2 }, "ready");
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const version = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble", ops: [
    { op: "addClip", trackId: "a1", clip: { id: "clip", kind: "media", mediaId: "mic", sourceIn: 0, sourceOut: 2, timelineIn: 0 } },
  ] }).change.toVersion;
  ctx.repos.tasks.put({ ...ctx.repos.tasks.get(pass.id)!, state: "running", startedAt: new Date().toISOString() });
  const check = await api("POST", projectsPath() + `/tasks/${pass.id}/repeat-audit`, { version });
  expect(await check.json()).toMatchObject({ version, unavailable: [{ mediaId: "mic" }] });
  const done = await api("POST", `/tasks/${pass.id}/complete`, { state: "done" });
  expect(await done.json()).toMatchObject({ task: { state: "failed", interrupted: true } });
});

it("hands a request held by a dialogue pass to a waiting host as soon as the editor decides the pass", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const { host } = await (await api("POST", "/hosts/register", { name: "Editor", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  const submit = async (instruction: string) => (await (await api("POST", projectsPath() + "/tasks", { agent: "codex", instruction })).json()).task as Task;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const pass = await submit("/first-cut-dialogue");
  expect((await (await api("POST", `/hosts/${host.id}/claim`, { taskId: pass.id })).json()).task.id).toBe(pass.id);
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const staged = (await (await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Pass",
    cuts: [{ start: 12, end: 13, review: true, reason: "may be the better take" }] })).json()).changes[0] as Change;
  const zoom = await submit("Zoom into the browser window during the demo.");
  await checkPassAudio(pass.id);
  await api("POST", `/tasks/${pass.id}/complete`, { state: "done" });
  // The host asks for work and waits: the zoom is held until the staged cut is decided.
  const poll = api("POST", `/hosts/${host.id}/claim?wait=30`, {});
  await new Promise(resolve => setTimeout(resolve, 50));
  // The editor makes the call. The host hears at once, not at its next ask up to 25 s later (2026-11-08: 17 s).
  expect((await api("POST", `/changes/${staged.id}/approve`, { restoredCuts: [0] })).status).toBe(200);
  const late = new Promise<"late">(resolve => setTimeout(() => resolve("late"), 2000));
  const answer = await Promise.race([poll.then(r => r.json() as Promise<{ task: Task | null }>), late]);
  expect(answer).not.toBe("late");
  expect((answer as { task: Task | null }).task?.id).toBe(zoom.id);
});

it("holds new requests while a dialogue pass's staged cuts wait for the editor, except ones about that pass", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const { host } = await (await api("POST", "/hosts/register", { name: "Editor", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  const submit = async (instruction: string, context = {}) => (await (await api("POST", projectsPath() + "/tasks",
    { agent: "codex", instruction, context })).json()).task as Task;
  const claim = async (taskId: string) => (await (await api("POST", `/hosts/${host.id}/claim`, { taskId })).json()).task as Task | null;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const pass = await submit("/first-cut-dialogue");
  expect((await claim(pass.id))?.id).toBe(pass.id);
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const staged = (await (await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Pass",
    cuts: [{ start: 12, end: 13, review: true, reason: "may be the better take" }] })).json()).changes[0] as Change;
  // A request typed while the pass runs waits for it.
  const zoom = await submit("Zoom into the browser window during the demo.");
  expect(await claim(zoom.id)).toBeNull();
  await checkPassAudio(pass.id);
  await api("POST", `/tasks/${pass.id}/complete`, { state: "done" });
  // The pass finished, but its staged cut still needs the editor, so the zoom keeps waiting.
  expect(ctx.repos.changes.get(staged.id)?.state).toBe("ready");
  expect(await claim(zoom.id)).toBeNull();
  // A reply in the pass's thread works on the pass itself, so it goes ahead of the zoom.
  const reply = await submit("Keep the second take instead.", { threadId: pass.id });
  expect((await claim(reply.id))?.id).toBe(reply.id);
  await api("POST", `/tasks/${reply.id}/complete`, { state: "done" });
  expect(await claim(zoom.id)).toBeNull();
  // The editor sends the pass back for another look. It is still theirs to decide, so the zoom keeps waiting and
  // the revision goes first: let through, the zoom would move the edit on and leave the revision out of date.
  const { task: revision } = await (await api("POST", `/changes/${staged.id}/revise`, { text: "Start that cut a beat later.", assignTo: "codex" })).json() as { task: Task };
  expect(ctx.repos.changes.get(staged.id)?.state).toBe("revising");
  expect(await claim(zoom.id)).toBeNull();
  expect((await claim(revision.id))?.id).toBe(revision.id);
  // It ends without a new version, which puts the pass back as it was.
  await api("POST", `/tasks/${revision.id}/complete`, { state: "done" });
  expect(ctx.repos.changes.get(staged.id)?.state).toBe("ready");
  expect(await claim(zoom.id)).toBeNull();
  // A second revision saves a new version of the pass. That one waits for the editor now. The version it replaced
  // stays marked as revising, and must not hold the queue once the new one is decided.
  const { task: again } = await (await api("POST", `/changes/${staged.id}/revise`, { text: "A beat later still.", assignTo: "codex" })).json() as { task: Task };
  expect((await claim(again.id))?.id).toBe(again.id);
  const moved = await api("POST", `/changes/${staged.id}/staged-cuts/0`, { taskId: again.id, start: 12.5, end: 13, reason: "Starts a beat later." });
  expect(moved.status).toBe(201);
  const { change: revised } = await moved.json() as { change: Change };
  await api("POST", `/tasks/${again.id}/complete`, { state: "done" });
  expect(ctx.repos.changes.get(staged.id)?.state).toBe("revising");
  expect(ctx.repos.changes.get(revised.id)?.state).toBe("ready");
  expect(await claim(zoom.id)).toBeNull();
  // Once the editor applies the pass, the zoom starts on the decided cut.
  expect((await api("POST", `/changes/${revised.id}/approve`, { restoredCuts: [0] })).status).toBe(200);
  expect((await claim(zoom.id))?.id).toBe(zoom.id);
});

it("starts a request the calls hold back once the editor says to, and still applies the pass after it", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const { host } = await (await api("POST", "/hosts/register", { name: "Editor", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  const submit = async (instruction: string) => (await (await api("POST", projectsPath() + "/tasks", { agent: "codex", instruction })).json()).task as Task;
  const claim = async (taskId: string) => (await (await api("POST", `/hosts/${host.id}/claim`, { taskId })).json()).task as Task | null;
  const startNow = (taskId: string) => api("POST", `/tasks/${taskId}/start-now`, {});
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const pass = await submit("/first-cut-dialogue");
  expect((await claim(pass.id))?.id).toBe(pass.id);
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const staged = (await (await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Pass",
    cuts: [{ start: 12, end: 13, review: true, reason: "may be the better take" }] })).json()).changes[0] as Change;
  const zoom = await submit("Zoom into the browser window during the demo.");
  const captions = await submit("Add captions.");
  // Told to start while the pass still runs, the zoom waits its turn behind that run: only the calls are waived.
  expect((await (await startNow(zoom.id)).json()).task.startsBeforeCalls).toBe(true);
  expect(await claim(zoom.id)).toBeNull();
  await checkPassAudio(pass.id);
  await api("POST", `/tasks/${pass.id}/complete`, { state: "done" });
  // The pass waits on its call. The zoom starts anyway, and the request behind it is held as before.
  expect(ctx.repos.changes.get(staged.id)?.state).toBe("ready");
  expect((await claim(zoom.id))?.id).toBe(zoom.id);
  expect((await startNow(zoom.id)).status).toBe(409);
  await api("POST", `/tasks/${zoom.id}/complete`, { state: "done" });
  expect(await claim(captions.id)).toBeNull();
  // The editor's call still applies the pass, and then the captions start.
  expect((await api("POST", `/changes/${staged.id}/approve`, { restoredCuts: [0] })).status).toBe(200);
  expect((await claim(captions.id))?.id).toBe(captions.id);
});

it("leaves a scheduled pass for the editor when its run stops early, instead of applying it on their next call", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const staged = (await (await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Part",
    cuts: [{ start: 12, end: 13, review: true, reason: "may be the better take" }, { start: 15, end: 16, review: true, reason: "repeated aside" }] })).json()).changes[0] as Change;
  const choose = (body: object) => api("PUT", `/changes/${staged.id}/cut-choices`, { fromVersion: staged.fromVersion, toVersion: staged.toVersion, ...body });
  // The editor makes the one call they know of and asks for the pass to apply when Scarlet finishes.
  expect((await choose({ choices: [{ index: 0, choice: "keep" }], applyWhenDone: true })).status).toBe(200);
  // The run is stopped before it checked the second cut, which is now the editor's call too.
  expect((await api("POST", `/tasks/${task.id}/cancel`)).status).toBe(200);
  expect(ctx.repos.changes.get(staged.id)).toMatchObject({ state: "ready" });
  // Their next call is saved. The pass stays open for the rest, even with the old schedule still on the request.
  const next = await choose({ choices: [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }], applyWhenDone: true });
  expect(next.status).toBe(200);
  expect((await next.json()).change).toMatchObject({ state: "ready", cutChoices: [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }] });
  expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
});

it("hands the editor the staged cuts a finished run never checked, instead of applying its schedule over them", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13), staged(16, 17)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  // The editor answers the one call Scarlet asked, which schedules the pass.
  expect((await choose(one.review, [{ index: 0, choice: "keep" }], true)).status).toBe(200);
  // The run finishes without checking the other two. They are the editor's calls now: nothing comes out unseen.
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "ready", applyWhenDone: { userId: localUser(ctx).id } });
  expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
  // A call on one of them leaves the pass waiting for the other.
  expect((await choose(one.review, [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }])).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)?.state).toBe("ready");
  // The schedule stands, so the call on the last of them applies the pass with every call.
  expect((await choose(one.review, [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }, { index: 2, choice: "keep" }])).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "approved", restoredCuts: [0, 2] });
});

it("doesn't take out a scheduled pass's cuts that a finished run never checked when Scarlet checked none of them", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13)]);
  expect((await choose(one.review, [{ index: 0, choice: "keep" }], true)).status).toBe(200);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)?.state).toBe("ready");
  expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
});

it("holds a scheduled pass whose run paused for its transcripts before checking every cut, and applies it when the resumed run has", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  expect((await choose(one.review, [{ index: 0, choice: "keep" }], true)).status).toBe(200);
  // The run waited for a transcript that never came, and ended there.
  ctx.repos.taskEvents.append({ id: "w", taskId: task.id, at: new Date().toISOString(), type: "log", text: "Waiting",
    data: { kind: "media_wait", wait: "transcript", mediaId: "camera" } });
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "done", needsTranscripts: ["camera"] });
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "ready", applyWhenDone: { userId: localUser(ctx).id } });
  // Resumed, the run checks the cut it hadn't and finishes. The pass applies on the editor's schedule.
  const resumed = (await (await api("POST", `/tasks/${task.id}/retry`, {})).json()).task as Task;
  expect(resumed.resumeRootId).toBe(task.id);
  expect((await assess(one.review, [{ index: 1, start: 12, end: 13, verdict: "cut", reason: "A clean retake." }])).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)?.state).toBe("ready");
  expect((await api("POST", `/tasks/${resumed.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "approved", restoredCuts: [0] });
});

it("passes explicitly chosen skills through notes, revisions, and answers to the agent prompt", async () => {
  seedSkillList(workspace.ctx, BUNDLED_SKILLS);
  const path = projectsPath();
  const library = (await (await api("GET", "/skills?projectId=" + project.id)).json()).skills;
  const first = library.find((s: { name: string }) => s.name === "visual-pass");
  const second = library.find((s: { name: string }) => s.name === "frame-screen");
  const { task } = await (await api("POST", path + "/notes", { time: 0, text: "/visual-pass", assignTo: "codex", skillIds: [first.id] })).json();
  const promptSkills = async (taskId: string) => (await (await api("GET", `/skills?projectId=${project.id}&taskId=${taskId}&view=prompt`)).json()).skills;
  expect(await promptSkills(task.id)).toEqual([first]);
  const available = await (await api("GET", `/skills?projectId=${project.id}&taskId=${task.id}&view=assistant`)).json();
  expect(available.skills.map((skill: { id: string }) => skill.id)).toContain(second.id);
  appendTaskEvent(workspace.ctx, task, { type: "question", text: "Which workflow next?" });
  await api("POST", `/tasks/${task.id}/answer`, { text: "/frame-screen", skillIds: [second.id] });
  expect(await promptSkills(task.id)).toEqual(expect.arrayContaining([first, second]));
  const { change } = await (await api("POST", path + "/changes", { description: "Marker", ops: marker, skipRender: true })).json();
  const revision = await (await api("POST", `/changes/${change.id}/revise`, { text: "/visual-pass Keep the chart.", skillIds: [first.id] })).json();
  expect(await promptSkills(revision.task.id)).toEqual([first]);
});

it("loads stock workflows on demand and leaves explicit selections and custom instructions in the prompt", async () => {
  const { ctx } = workspace;
  seedSkillList(ctx, BUNDLED_SKILLS);
  const url = "/skills?projectId=" + project.id;
  const list = async (query: string) => (await (await api("GET", url + query)).json()).skills as Array<{ id: string; name: string; content: string }>;
  const stock = (await list("")).find(s => s.name === "visual-pass")!;
  expect((await list("&view=prompt")).find(s => s.id === stock.id)?.content).toContain("skills_list");
  expect((await list("&view=assistant")).find(s => s.id === stock.id)?.content).toBe(stock.content);
  const task = createTask(ctx, { projectId: project.id, agent: "codex", kind: "edit", instruction: "Reframe",
    context: { skillIds: [stock.id] }, createdBy: { type: "human", name: "Editor" } });
  const pinned = await list("&view=prompt&taskId=" + task.id);
  expect(pinned).toHaveLength(1);
  expect(pinned[0]?.content).toBe(stock.content);
  expect((await api("POST", "/skills", { name: stock.name, content: "Duplicate" })).status).toBe(409);
  const custom = await api("PUT", "/skills/" + stock.id, { content: "Keep the original framing." });
  expect(custom.status).toBe(200);
  const rules = (await (await api("POST", "/skills", { name: "house-rules", content: "Never cut the sponsor read." })).json()).skill;
  const other = ctx.repos.projects.insert(createProject("Other"));
  for (const id of [project.id, other.id]) {
    const prompt = (await (await api("GET", "/skills?view=prompt&projectId=" + id)).json()).skills as Array<{ id: string; content: string }>;
    // A customized workflow is still read on demand. House rules stay in the prompt.
    expect(prompt.find(s => s.id === stock.id)?.content).toContain("skills_list");
    expect(prompt.find(s => s.id === rules.id)?.content).toBe("Never cut the sponsor read.");
  }
  expect((await list("&view=assistant")).find(s => s.id === stock.id)?.content).toBe("Keep the original framing.");
});

it("applies requested edits and keeps suggestions and competing alternatives out of the cut until chosen", async () => {
  const path = projectsPath();
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Add a marker",
    createdBy: { type: "human", name: "Editor" } });
  const submit = async (id: string, intent: string, taskId: string | undefined = task.id) => {
    const response = await api("POST", path + "/changes", { description: id, intent, taskId, autoApprove: true,
      author: { type: "agent", name: "Codex" }, ops: [{ op: "addMarker", marker: { id, time: 0, text: id } }] });
    expect(response.status).toBe(201);
    return (await response.json()).change as Change;
  };
  const requested = await submit("requested", "requested");
  expect(requested).toMatchObject({ state: "approved", autoApplied: true, decidedBy: { type: "scarlet" } });
  expect(ctx.repos.notifications.count()).toBe(0);
  const suggestion = await submit("suggestion", "suggestion");
  const one = await submit("one", "alternative");
  const two = await submit("two", "alternative");
  expect([suggestion, one, two].map(c => c.state)).toEqual(["ready", "ready", "ready"]);
  expect(ctx.repos.projects.get(project.id)?.head).toBe(requested.appliedVersion);
  await api("POST", "/changes/" + one.id + "/approve", {});
  expect(ctx.repos.changes.get(two.id)?.state).toBe("rejected");
  expect(ctx.repos.changes.get(suggestion.id)?.state).toBe("ready");
  expect((await submit("late option", "alternative")).state).toBe("rejected");
  const stale = await api("POST", path + "/changes", { fromVersion: requested.fromVersion, taskId: task.id,
    author: { type: "agent", name: "Codex" }, description: "Concurrent marker", intent: "requested",
    ops: [{ op: "addMarker", marker: { id: "requested", time: 1, text: "Different marker" } }] });
  expect((await stale.json()).change).toMatchObject({ state: "ready" });
  const branch = await api("POST", path + "/branches", { name: "Second cut", from: one.toVersion, expectedHead: one.toVersion, expectedBranch: "main" });
  expect(branch.status).toBe(200);
  expect((await submit("late requested", "requested")).state).toBe("ready");
});

it("reverts an older edit on its branch, keeps the later edit and records reversible history across restart", async () => {
  const path = projectsPath();
  const submit = async (id: string, ops: unknown[]) => (await (await api("POST", path + "/changes", {
    description: id, ops, autoApprove: true })).json()).change as Change;
  const a = await submit("Opening", marker);
  const b = await submit("Ending", [{ op: "addMarker", marker: { id: "end", time: 4, text: "End" } }]);
  const branch = (name: string, expectedBranch: string, expectedHead: string, from?: string) =>
    api("POST", path + "/branches", { name, expectedBranch, from, expectedHead });
  expect((await branch("Experiment", "main", b.toVersion, b.toVersion)).status).toBe(200);
  const undo = (target: string, expectedHead: string) => api("POST", path + "/versions/" + target + "/revert", { expectedHead, branch: "Experiment" });
  const first = await undo(a.toVersion, b.toVersion);
  expect(first.status).toBe(200);
  const revert = (await first.json()).change as Change;
  expect(revert).toMatchObject({ fromVersion: b.toVersion, revertsVersion: a.toVersion });
  const timeline = async () => (await (await api("GET", path + "/timeline")).json()).timeline;
  expect((await timeline()).markers.map((m: { id: string }) => m.id)).toEqual(["end"]);
  expect((await undo(a.toVersion, b.toVersion)).status).toBe(409);
  expect((await undo(a.toVersion, revert.toVersion)).status).toBe(409);
  const redo = await undo(revert.toVersion, revert.toVersion);
  expect(redo.status).toBe(200);
  const current = (await timeline());
  expect(current.markers).toHaveLength(2);
  expect(current.version).not.toBe(b.toVersion);
  expect(current.parent).toBe(revert.toVersion);
  await workspace.ctx.close();
  workspace = openWorkspace();
  expect((await branch("main", "Experiment", current.version)).status).toBe(200);
  expect((await timeline()).version).toBe(b.toVersion);
  const conflicting = await submit("Rename opening", [{ op: "updateMarker", markerId: "marker", patch: { text: "Changed" } }]);
  const blocked = await api("POST", path + "/versions/" + a.toVersion + "/revert", { expectedHead: conflicting.toVersion, branch: "main" });
  expect(blocked.status).toBe(409);
  expect((await timeline()).version).toBe(conflicting.toVersion);
  const restored = await api("POST", path + "/versions/" + a.toVersion + "/restore", { expectedHead: conflicting.toVersion, branch: "main" });
  expect(restored.status).toBe(200);
  expect((await timeline()).parent).toBe(conflicting.toVersion);
  expect((await (await api("GET", path + "/versions/" + current.version + "/diff/" + b.toVersion)).json()).description).toEqual([]);
});

it("applies verified trims once and offers uncertain cuts at their remapped times on the kept version", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const author = { type: "human" as const, name: "Editor" };
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: author });
  ctx.repos.projects.putMedia(project.id,{ id:"mic",name:"mic",path:"mic.wav",kind:"audio",duration:12,hasAudio:true },"ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent:"requested", taskId:task.id, description:"Assemble",
    ops:[{op:"addClip",trackId:"a1",clip:{id:"raw",kind:"media",mediaId:"mic",timelineIn:0,sourceIn:0,sourceOut:12}}] }).change.toVersion;
  const plan = { taskId:task.id, fromVersion:base, description:"Remove marked retake", cuts:[
    { start:1, end:3, review:false, reason:"retake" }, { start:7, end:8, review:true, reason:"may be a demonstration", originalRange: { start:6.7, end:8.2 } }] };
  const call = () => api("POST",projectsPath()+"/dialogue-cuts",plan);
  // A plan the engine can't apply says which range is wrong, since the message is all the agent sees.
  const refused = async (cuts: object[]) => {
    const res = await api("POST", projectsPath()+"/dialogue-cuts", { ...plan, cuts });
    expect(res.status).toBe(400);
    return (await res.json()).error.message as string;
  };
  expect(await refused([{ start:1, end:3.2, review:false, reason:"retake" }, { start:3, end:4, review:false, reason:"pause" }]))
    .toBe("The ranges 1.00–3.20 s and 3.00–4.00 s overlap. End the first where the second starts, or merge them.");
  expect(await refused([{ start:10, end:12.5, review:false, reason:"retake" }])).toBe("The range 10.00–12.50 s runs past the end of the timeline at 12.00 s.");
  expect(await refused([{ start:0, end:12, review:false, reason:"everything" }])).toBe("These ranges remove the whole timeline. Retain some footage.");
  const manual = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Let me review every cut.",
    context: { reviewAllCuts: true }, createdBy: author });
  const staged = await api("POST", projectsPath()+"/dialogue-cuts", { ...plan, taskId: manual.id });
  expect((await staged.json()).changes).toMatchObject([{ state: "ready", intent: "suggestion" }]);
  const ordinary = proposeChange(ctx, localUser(ctx), project.id, { fromVersion: base, intent: "requested", taskId: manual.id,
    description: "Shorten pickup", ops: [{ op: "rippleDelete", start: 1, end: 3 }] });
  expect(ordinary.change).toMatchObject({ state: "ready", intent: "suggestion" });
  expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
  const first = await call(); expect(first.status).toBe(201);
  const { changes } = await first.json();
  expect(changes.map((c: Change)=>c.state)).toEqual(["approved","ready"]);
  expect(changes[0].description).toBe("Removed 2 s at 0:01.");
  const saved = ctx.repos.changes.get(changes[1].id)!;
  expect(saved.cutReasons).toMatchObject([{ start: 5, end: 6, reason: "may be a demonstration", originalRange: { start:4.7, end:expect.closeTo(6.2) } }]);
  expect(saved.description).toBe("Review 1 optional dialogue cut");
  const head=ctx.repos.projects.get(project.id)!.head;
  expect(head).toBe(changes[0].toVersion);
  const review=await (await api("POST",`/changes/${changes[1].id}/cut-review`,{})).json();
  expect(review.review.cuts.map((c:{removed:unknown})=>c.removed)).toEqual([{start:5,end:6}]);
  const assess = (end: number, verdict: string, inspected = true) => api("POST", `/changes/${saved.id}/cut-assessments`, { fromVersion: saved.fromVersion, toVersion: saved.toVersion,
    assessments: [{ index: 0, start: 5, end, verdict, inspected, reason: "The screen shows a new result." }] });
  const wrongRange = await assess(7, "keep");
  expect(wrongRange.status).toBe(400);
  expect((await wrongRange.json()).error.message).toBe("Cut 0 of this pass is 5.000–6.000 s, not 5.000–7.000 s. Give its range, or the index of the cut you mean.");
  // A range copied with fewer digits, or the range asked for before the cut went onto whole frames, still names this
  // cut, and the cut's own range is what is saved.
  expect((await assess(6.004, "ask", false)).status).toBe(200);
  expect((await assess(6.03, "ask", false)).status).toBe(200);
  expect((await assess(6.05, "ask", false)).status).toBe(400);
  expect(ctx.repos.changes.get(saved.id)!.cutAssessments).toMatchObject([{ index: 0, start: 5, end: 6 }]);
  expect((await assess(6, "ask", false)).status).toBe(200);
  expect(ctx.repos.changes.get(saved.id)!.firstDecisionPreview?.index).toBe(0);
  expect(await (await assess(6, "ask")).json()).toEqual({ total: 1, assessed: 1, needsDecision: 1 });
  const preview = ctx.repos.changes.get(saved.id)!.firstDecisionPreview!;
  expect(ctx.repos.renders.get(preview.renderId)).toMatchObject({ version: saved.toVersion, kind: "segment", range: { start: 3, end: 7 } });
  await vi.waitFor(() => expect(ctx.repos.changes.get(saved.id)!.firstDecisionPreview!.briefToPlayableMs).toBeGreaterThanOrEqual(0));
  expect((await assess(6, "ask")).status).toBe(200);
  expect(ctx.repos.changes.get(saved.id)!.firstDecisionPreview?.renderId).toBe(preview.renderId);
  expect((await api("POST", `/changes/${saved.id}/approve`, {})).status).toBe(409);
  expect((await api("POST", `/changes/${saved.id}/approve`, { restoredCuts: [] })).status).toBe(409);
  expect(await (await assess(6, "keep")).json()).toMatchObject({ total: 1, assessed: 1, needsDecision: 1, heldCalls: [0] });
  expect(ctx.repos.changes.get(saved.id)!.cutAssessments?.[0]?.verdict).toBe("ask");
  expect((await (await call()).json()).changes).toEqual(changes);
  expect(ctx.repos.projects.get(project.id)!.head).toBe(head);
  await checkPassAudio(task.id);
  const completion = await api("POST", `/tasks/${task.id}/complete`, { state: "done", summary: "Removed the demonstration." });
  expect((await completion.json()).task.summary).toContain("Removed 2 s at 0:01. Dialogue cuts are pending review.");
  expect(ctx.repos.tasks.get(task.id)!.summary).not.toContain("Removed the demonstration");
  // What Scarlet said as it finished is kept beside the receipt, for the editor.
  expect(ctx.repos.tasks.get(task.id)!.reply).toBe("Removed the demonstration.");
});

it.each(["dialogue cuts", "whole timeline"])("keeps the first-cut reply when a playback recheck has no findings (%s)", async kind => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  if (kind === "dialogue cuts") expect((await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Pass",
    cuts: [{ start: 12, end: 13, review: false, reason: "slate" }] })).status).toBe(201);
  const run = () => ctx.repos.tasks.put({ ...ctx.repos.tasks.get(pass.id)!, state: "running", startedAt: new Date().toISOString() });
  run();
  // The pass ends before its audio is checked, so the check runs next, in the same request.
  const ended = await api("POST", `/tasks/${pass.id}/complete`, { state: "done", summary: "Review the flagged directions. The sponsor pickup remains after the outro." });
  expect((await ended.json()).task).toMatchObject({ state: "queued", reply: "Review the flagged directions. The sponsor pickup remains after the outro." });
  run();
  await checkPassAudio(pass.id);
  const checked = await api("POST", `/tasks/${pass.id}/complete`, { state: "done", summary: "I listened through the cut again and everything sounds clean." });
  expect((await checked.json()).task).toMatchObject({ state: "done", repeatAudit: { remaining: 0, noFindings: true },
    reply: "Review the flagged directions. The sponsor pickup remains after the outro." });
  expect(ctx.repos.tasks.get(pass.id)!.summary).toEqual(kind === "dialogue cuts" ? expect.stringContaining("Removed 1 s") : null);
});

it("carries a part's staged cuts and their recommendations into the next part of the same pass", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submit = async (fromVersion: string, cuts: object[]) => {
    const res = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion, description: "Part", cuts });
    expect(res.status).toBe(201);
    return await res.json() as { changes: Change[]; carriedForward?: number };
  };
  // Part one stages two cuts late in the edit. The run records a recommendation on one of them.
  const one = await submit(base, [{ start: 12, end: 13, review: true, reason: "may be the better take" },
    { start: 15, end: 16, review: true, reason: "repeated aside", originalRange: { start: 14.8, end: 16.2 } }]);
  const [staged] = one.changes;
  expect((await api("POST", `/changes/${staged!.id}/cut-assessments`, { fromVersion: staged!.fromVersion, toVersion: staged!.toVersion,
    assessments: [{ index: 1, start: 15, end: 16, verdict: "ask", reason: "Both takes land." }] })).status).toBe(200);
  // Part two cuts earlier footage and decides the 12 s range again. Its own decision replaces the staged one.
  const two = await submit(base, [{ start: 2, end: 4, review: false, reason: "false start" }, { start: 12, end: 13.5, review: true, reason: "check the pickup" }]);
  expect(two.carriedForward).toBe(1);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
  const review = ctx.repos.changes.get(two.changes[1]!.id)!;
  expect(review.cutReasons).toEqual([
    { start: 10, end: 11.5, reason: "check the pickup" },
    { start: 13, end: 14, reason: "repeated aside", originalRange: { start: 12.8, end: expect.closeTo(14.2) } },
  ]);
  expect(review.cutAssessments).toEqual([{ index: 1, start: 13, end: 14, verdict: "ask", reason: "Both takes land.", askOrder: 1 }]);
  expect(ctx.repos.changes.get(staged!.id)).toMatchObject({ state: "rejected", rejectReason: "Carried into a later part of the same dialogue pass.",
    replacedBy: review.id });
  expect(ctx.repos.projects.get(project.id)!.head).toBe(two.changes[0]!.toVersion);
  // Part three continues from part two. The editor hears about the pass once: its removals together and the one review.
  const three = await submit(two.changes[0]!.toVersion, [{ start: 0, end: 1, review: false, reason: "slate" }]);
  expect(three.carriedForward).toBe(2);
  expect(ctx.repos.changes.get(review.id)!.replacedBy).toBe(three.changes[1]!.id);
  await checkPassAudio(task.id);
  const completion = await api("POST", `/tasks/${task.id}/complete`, { state: "done" });
  expect((await completion.json()).task.summary).toBe("Applied “Assemble”. Removed 3 s across 2 cuts. Dialogue cuts are pending review.");
});

it("keeps the editor's calls through the pass's next part and applies them as soon as the pass finishes", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submit = async (fromVersion: string, cuts: object[]) => {
    const res = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion, description: "Part", cuts });
    expect(res.status).toBe(201);
    return await res.json() as { changes: Change[]; carriedForward?: number; editorDecided?: unknown };
  };
  const [staged] = (await submit(base, [{ start: 12, end: 13, review: true, reason: "may be the better take" },
    { start: 15, end: 16, review: true, reason: "repeated aside" }])).changes;
  const choose = (change: Change, body: object) => api("PUT", `/changes/${change.id}/cut-choices`, { fromVersion: change.fromVersion, toVersion: change.toVersion, ...body });
  // The editor calls the first cut before Scarlet has assessed anything, and asks for the result once the pass is done.
  const chosen = await choose(staged!, { choices: [{ index: 0, choice: "keep" }], applyWhenDone: true });
  expect(chosen.status).toBe(200);
  expect((await chosen.json()).change).toMatchObject({ state: "ready", cutChoices: [{ index: 0, start: 12, end: 13, choice: "keep" }], applyWhenDone: { userId: localUser(ctx).id } });
  expect((await choose(staged!, { choices: [{ index: 2, choice: "cut" }] })).status).toBe(400);

  // The next part decides that range again. The editor's call stands, and Scarlet says so.
  const two = await submit(base, [{ start: 2, end: 4, review: false, reason: "false start" }, { start: 12, end: 13.5, review: true, reason: "check the pickup" }]);
  expect(two.editorDecided).toEqual([{ start: 12, end: 13.5 }]);
  expect(two.carriedForward).toBe(2);
  const review = ctx.repos.changes.get(two.changes[1]!.id)!;
  expect(review.cutReasons?.map(({ start, end }) => [start, end])).toEqual([[10, 11], [13, 14]]);
  expect(review.cutChoices).toEqual([{ index: 0, start: 10, end: 11, choice: "keep" }]);
  expect(review.applyWhenDone?.userId).toBe(localUser(ctx).id);
  const duplicate = await choose(staged!, { choices: [{ index: 0, choice: "keep" }], applyWhenDone: true });
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).change).toMatchObject({ id: review.id, cutChoices: review.cutChoices, applyWhenDone: review.applyWhenDone });
  expect((await choose(staged!, { choices: [] })).status).toBe(409);
  // Scarlet checks the other cut before it finishes, so nothing waits on the editor.
  expect((await api("POST", `/changes/${review.id}/cut-assessments`, { fromVersion: review.fromVersion, toVersion: review.toVersion,
    assessments: [{ index: 1, start: 13, end: 14, verdict: "cut", reason: "A clean retake." }] })).status).toBe(200);

  const completion = await api("POST", `/tasks/${task.id}/complete`, { state: "done", summary: "Done." });
  expect(completion.status).toBe(200);
  const applied = ctx.repos.changes.get(review.id)!;
  expect(applied).toMatchObject({ state: "approved", restoredCuts: [0] });
  expect(applied.applyWhenDone).toBeUndefined();
  const head = ctx.repos.projects.get(project.id)!.head!;
  expect(head).toBe(applied.appliedVersion);
  expect(timelineDuration(ctx.repos.versions.get(project.id, head)!.timeline)).toBeCloseTo(17);
});

/** A dialogue pass on a 20 s recording (or one of another length) that saves its cuts in parts, with the cut list, calls and notes of each part's review. */
function dialoguePassInParts(length = 20) {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: length, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: length } }] }).change.toVersion;
  const versions = ({ fromVersion, toVersion }: Change) => ({ fromVersion, toVersion });
  return {
    task, base,
    staged: (start: number, end: number) => ({ start, end, review: true, reason: `Retake at ${start} s.` }),
    async submit(fromVersion: string, cuts: object[]) {
      const res = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion, description: "Part", cuts });
      expect(res.status).toBe(201);
      const part = await res.json() as { changes: Change[]; editorDecided?: unknown; alreadyRemoved?: unknown; heldForReview?: unknown };
      return { ...part, review: ctx.repos.changes.get(part.changes.find(c => c.intent === "suggestion")!.id)! };
    },
    listed: async (review: Change) => ((await (await api("POST", `/changes/${review.id}/cut-review`, {})).json()).review.cuts as Array<{ removed: { start: number; end: number } }>)
      .map(c => [c.removed.start, c.removed.end]),
    choose: (review: Change, choices: object[], applyWhenDone?: boolean) => api("PUT", `/changes/${review.id}/cut-choices`, { ...versions(review), choices, applyWhenDone }),
    assess: (review: Change, assessments: object[]) => api("POST", `/changes/${review.id}/cut-assessments`, { ...versions(review), assessments }),
  };
}

/**
 * A track's clips as straight cuts: the crossfade Scarlet puts on each dialogue join (two clips overlapping by the fades
 * they carry there) read back to the cut it smooths. Tests about which footage a pass keeps compare these.
 */
function straightCuts(clips: Clip[]): Clip[] {
  const out = clips.map(c => ({ ...c }));
  for (let i = 0; i + 1 < out.length; i++) {
    const left = out[i]!, right = out[i + 1]!;
    if (left.kind !== "media" || right.kind !== "media") continue;
    const overlap = clipEnd(left) - right.timelineIn;
    if (overlap <= 1e-9 || Math.abs(left.audioFadeOut - overlap) > 1e-6 || Math.abs(right.audioFadeIn - overlap) > 1e-6) continue;
    const half = overlap / 2;
    out[i] = { ...left, sourceOut: left.sourceOut - half * left.speed, audioFadeOut: 0 };
    out[i + 1] = { ...right, timelineIn: right.timelineIn + half, sourceIn: right.sourceIn + half * right.speed, audioFadeIn: 0 };
  }
  return out;
}

/** Scarlet's own edit between two parts of a pass, such as crossfades on the joins it just made: the video moves on, and every frame of footage stays where it was. */
function crossfades(taskId: string) {
  const { ctx } = workspace;
  const head = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  const clip = head.tracks.find(t => t.id === "a1")!.clips[0]!;
  const fade = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId, description: "Crossfades on the joins",
    ops: [{ op: "updateClip", clipId: clip.id, patch: { volume: 0.9 } }] }).change;
  expect(fade.state).toBe("approved");
  return ctx.repos.projects.get(project.id)!.head!;
}

const waitingPasses = () => workspace.ctx.repos.changes.select(`project_id = ? AND state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'`, [project.id]);

it("hands off one call while the pass can still trim and assess its other cuts", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, assess, listed } = dialoguePassInParts();
  const { review } = await submit(base, [staged(2, 3), staged(8, 10), staged(14, 16)]);
  const note = { index: 1, start: 8, end: 10, verdict: "ask", reason: "Does the pause before the answer land?" };
  expect((await assess(review, [note, { index: 2, start: 14, end: 16, verdict: "keep", reason: "Keep the pickup." }])).status).toBe(200);
  const direct = (start: number, end: number) => proposeChange(ctx, localUser(ctx), project.id,
    { intent: "requested", taskId: task.id, description: "Trim", ops: [{ op: "rippleDelete", start, end }] });
  expect(() => direct(8.5, 9)).toThrow(/with the editor/);
  expect(() => direct(3, 8)).toThrow(/join cuts/);
  const ownTrim = (index: number, start: number, end: number) => api("POST", `/changes/${review.id}/staged-cuts/${index}`,
    { taskId: task.id, start, end, reason: "Start after the breath." });
  expect((await ownTrim(1, 8.5, 10)).status).toBe(409);
  expect(ctx.repos.projects.header(project.id)!.head).toBe(base);
  const published: Change[] = [];
  ctx.bus.on("ws", event => {
    if (event.type === "change.updated" && event.change.state === "ready") published.push(event.change);
  });
  const repeat = await submit(base, [{ ...staged(8, 10), review: false }]);
  expect(repeat.heldForReview).toEqual([{ start: 8, end: 10 }]);
  expect(repeat.review.id).toBe(review.id);
  expect(published).toEqual([]);
  const res = await ownTrim(2, 14.5, 16);
  expect(res.status).toBe(201);
  const trimmed = (await res.json()).change as Change;
  expect(trimmed.cutAssessments).toEqual([{ ...note, askOrder: 1 },
    { index: 2, start: 14.5, end: 16, verdict: "ask", provisional: true, reason: "Start after the breath." }]);
  expect(published.filter(c => c.id === trimmed.id)).toEqual([trimmed]);
  // An ordinary save before the call moves its timeline position. The next bulk save can still change a candidate,
  // but neither resubmitting nor adjoining a published call can replace its passage or its note.
  const head = direct(0, 1).change.appliedVersion!;
  const next = await submit(head, [staged(7, 8), staged(9, 10), staged(13, 15)]);
  expect(next.heldForReview).toEqual([{ start: 7, end: 8 }, { start: 9, end: 10 }]);
  expect(await listed(next.review)).toEqual([[1, 2], [7, 9], [13, 15]]);
  expect(next.review.cutAssessments).toEqual([{ ...note, start: 7, end: 9, askOrder: 1 }]);
  expect(published.filter(c => c.id === next.review.id)).toEqual([next.review]);
});

it("reserves a published call's number after an editor revision keeps its footage", async () => {
  const { base, staged, submit, assess } = dialoguePassInParts();
  const { review } = await submit(base, [staged(2, 3), staged(8, 9)]);
  expect((await assess(review, [{ index: 1, start: 8, end: 9, verdict: "ask", reason: "Does this pickup land?" }])).status).toBe(200);
  const { task: request } = await (await api("POST", `/changes/${review.id}/revise`, { text: "Keep the pickup.",
    position: { version: base, time: 8, end: 9, clipIds: [], cutIndex: 1 } })).json();
  const res = await api("POST", `/changes/${review.id}/staged-cuts/1`, { taskId: request.id, start: 8, end: 9,
    keep: true, reason: "The pickup stays." });
  expect(res.status).toBe(201);
  const { change: kept } = await res.json() as { change: Change };
  expect(kept.cutAssessments).toEqual([{ index: 1, start: 8, end: 9, verdict: "keep", reason: "The pickup stays.", askOrder: 1 }]);
  expect((await api("POST", `/tasks/${request.id}/complete`, { state: "done" })).status).toBe(200);
  const two = await submit(base, [staged(14, 15)]);
  expect(two.review.cutAssessments).toEqual(kept.cutAssessments);
  expect((await assess(two.review, [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Is the breath useful?" }])).status).toBe(200);
  expect(workspace.ctx.repos.changes.get(two.review.id)?.cutAssessments?.map(a => [a.index, a.askOrder])).toEqual([[0, 2], [1, 1]]);
});

it.each([false, true])("keeps every unanswered call when a later batch repeats the cuts (revision queued: %s)", async queued => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose, assess } = dialoguePassInParts();
  const cuts = [2, 4, 6, 8, 10, 12, 14].map(start => staged(start, start + 1));
  const { review } = await submit(base, cuts);
  const calls = cuts.map(({ start, end }, index) => ({ index, start, end, verdict: "ask", reason: `Check the pickup at ${start}.` }));
  expect((await assess(review, calls)).status).toBe(200);
  const choices = [0, 1, 2].map(index => ({ index, choice: "cut" }));
  expect((await choose(review, choices)).status).toBe(200);
  const revision = queued && createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Leave the first word.",
    createdBy: { type: "human", name: "Editor" }, context: { threadId: task.id, changeId: review.id, cutIndex: 3, time: 8, end: 9 } });
  const ready: Change[] = [];
  ctx.bus.on("ws", event => {
    if (event.type === "change.updated" && event.change.intent === "suggestion" && event.change.state === "ready") ready.push(event.change);
  });
  // One unrelated cut moves the timeline. The same batch restages some calls and tries to apply the others.
  const repeated = cuts.map((cut, i) => ({ ...cut, review: i % 2 === 0 }));
  const next = await submit(base, [{ start: 0, end: 1, review: false, reason: "Remove the slate." }, ...repeated]);
  const range = ({ start, end }: { start: number; end: number }) => ({ start, end });
  expect(next.editorDecided).toEqual(cuts.slice(0, 3).map(range));
  expect(next.heldForReview).toEqual(cuts.slice(3).map(range));
  const carried = calls.map((call, i) => ({ ...call, start: call.start - 1, end: call.end - 1, askOrder: i + 1 }));
  expect(next.review.cutAssessments).toEqual(carried);
  expect(next.review.cutChoices).toEqual(choices.map((choice, i) => ({ ...choice, ...range(carried[i]!) })));
  expect(ready.filter(c => c.id === next.review.id).map(c => c.cutAssessments)).toEqual([carried]);
  if (revision) {
    const res = await api("POST", `/changes/${review.id}/staged-cuts/3`, { taskId: revision.id, start: 8.5, end: 9, reason: "Leave the first word." });
    expect(res.status).toBe(201);
    const revised = (await res.json()).change as Change;
    expect(revised.cutAssessments?.slice(4)).toEqual(carried.slice(4));
    expect(revised.cutAssessments?.[3]).toMatchObject({ askOrder: 4, verdict: "ask", revised: true });
  }
});

it("publishes finished calls in order and preserves the passage and note through later assessments", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, assess } = dialoguePassInParts();
  const { review } = await submit(base, [staged(1, 2), staged(5, 6), staged(9, 10)]);
  const note = (index: number, verdict: "ask" | "keep", reason: string) => ({ index, start: index * 4 + 1, end: index * 4 + 2, verdict, reason });
  const draft = note(0, "ask", "Recheck the combined range.");
  const late = note(2, "ask", "Keep the pause before the last line?");
  ctx.repos.changes.put({ ...review, cutAssessments: [{ ...draft, provisional: true }] });
  expect(await (await assess(review, [late])).json()).toMatchObject({ total: 3, assessed: 1 });
  const saved = () => ctx.repos.changes.get(review.id)!;
  expect(saved().firstDecisionPreview?.index).toBe(2);
  const middle = note(1, "ask", "Keep this second reading?");
  const early = note(0, "ask", "Does this breath help the opening?");
  const result = await assess(review, [
    { ...late, reason: "A different question about the last line." }, middle, { ...early, provisional: true, askOrder: 99 },
  ]);
  expect(await result.json()).toMatchObject({ assessed: 3, heldCalls: [2] });
  expect(saved().cutAssessments).toEqual([
    { ...early, askOrder: 2 }, { ...middle, askOrder: 3 }, { ...late, askOrder: 1 },
  ]);
  const updates: Change[] = [];
  ctx.bus.on("ws", event => {
    if (event.type === "change.updated" && event.change.id === review.id) updates.push(event.change);
  });
  expect(await (await assess(review, [note(2, "keep", "Keep this take instead.")])).json()).toMatchObject({ heldCalls: [2] });
  expect(updates).toEqual([]);
  // A project saved before call numbers existed keeps the calls the editor already saw ahead of new ones.
  ctx.repos.changes.put({ ...saved(), cutAssessments: [late] });
  await assess(review, [early]);
  expect(saved().cutAssessments).toEqual([{ ...early, askOrder: 2 }, { ...late, askOrder: 1 }]);
});

it("keeps an existing call when Scarlet checks it again and recommends cut or keep", async () => {
  const { base, staged, submit, assess } = dialoguePassInParts();
  const { review } = await submit(base, [staged(2, 3), staged(8, 9), staged(12, 13)]);
  const calls = [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Listen to the breath." },
    { index: 1, start: 8, end: 9, verdict: "ask", reason: "Check the second take." }];
  expect((await assess(review, calls)).status).toBe(200);
  const res = await assess(review, [{ ...calls[0], verdict: "cut" }, { ...calls[1], verdict: "keep" },
    { index: 2, start: 12, end: 13, verdict: "cut", reason: "A clean join." }]);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ needsDecision: 2, heldCalls: [0, 1] });
  const saved = workspace.ctx.repos.changes.get(review.id)!;
  expect(saved.cutAssessments?.map(a => [a.verdict, a.askOrder])).toEqual([["ask", 1], ["ask", 2], ["cut", undefined]]);
});

it("carries the whole call when two adjacent staged ranges share original footage", async () => {
  const { base, staged, submit, assess, listed } = dialoguePassInParts();
  const first = await submit(base, [
    { ...staged(6, 7), originalRange: { start: 5.5, end: 7.5 } },
    { ...staged(7, 8), originalRange: { start: 6.5, end: 8.5 } },
  ]);
  const note = { index: 0, start: 6, end: 8, verdict: "ask", reason: "Check the join across both pickups." };
  expect((await assess(first.review, [note])).status).toBe(200);
  const next = await submit(base, [staged(5.5, 5.8), staged(15, 16)]);
  expect(next.heldForReview).toEqual([{ start: 5.5, end: 5.8 }]);
  expect(await listed(next.review)).toEqual([[6, 8], [15, 16]]);
  expect(next.review.cutAssessments).toEqual([{ ...note, askOrder: 1 }]);
});

it("numbers Scarlet's asks in the order it makes them, and a call keeps its number through the pass's next part", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, listed, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(8, 9), staged(12, 13)]);
  const order = (review: Change) => ctx.repos.changes.get(review.id)!.cutAssessments!.map(a => [a.index, a.verdict, a.askOrder]);
  // Scarlet asks about the cut at 12 s first, then about the one at 2 s, earlier in the video. The later ask comes after.
  expect((await assess(one.review, [{ index: 2, start: 12, end: 13, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  expect((await assess(one.review, [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Check the breath." },
    { index: 1, start: 8, end: 9, verdict: "cut", reason: "A clean retake." }])).status).toBe(200);
  expect(order(one.review)).toEqual([[0, "ask", 2], [1, "cut", undefined], [2, "ask", 1]]);
  // A note saved again on a cut it asked about keeps its place. A cut it asks about only now comes after them all,
  // whatever number the caller sends: only the engine numbers asks.
  expect((await assess(one.review, [{ index: 2, start: 12, end: 13, verdict: "ask", reason: "Both takes still land." },
    { index: 1, start: 8, end: 9, verdict: "ask", reason: "On second thought.", askOrder: 1 }])).status).toBe(200);
  expect(order(one.review)).toEqual([[0, "ask", 2], [1, "ask", 3], [2, "ask", 1]]);
  // The next part carries each call with its number, and Scarlet's ask about the cut it staged there comes after them.
  const two = await submit(base, [staged(16, 17)]);
  expect(await listed(two.review)).toEqual([[2, 3], [8, 9], [12, 13], [16, 17]]);
  expect(order(two.review)).toEqual([[0, "ask", 2], [1, "ask", 3], [2, "ask", 1]]);
  expect((await assess(two.review, [{ index: 3, start: 16, end: 17, verdict: "ask", reason: "Retake at 16 s." }])).status).toBe(200);
  expect(order(two.review)).toEqual([[0, "ask", 2], [1, "ask", 3], [2, "ask", 1], [3, "ask", 4]]);
});

it("numbers a pass's asks saved before the engine numbered them first, in timeline order, once it numbers an ask, so no call moves", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(8, 9), staged(12, 13)]);
  // Saved before the engine numbered asks: Scarlet asked about the cuts at 2 s and 12 s, and the editor sees them as
  // Cut 1 and Cut 2, by their place in the video.
  ctx.repos.changes.put({ ...ctx.repos.changes.get(one.review.id)!, cutAssessments: [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Check the breath." },
    { index: 2, start: 12, end: 13, verdict: "ask", reason: "Both takes land." }] });
  const order = (review: Change) => ctx.repos.changes.get(review.id)!.cutAssessments!.map(a => [a.index, a.verdict, a.askOrder]);
  // The next part carries them, and the cut at 2 s that a new staged cut now touches waits for the editor. None of
  // them is numbered yet: numbering one alone would put it ahead of the others.
  const two = await submit(base, [staged(3, 4), staged(16, 17)]);
  expect(order(two.review)).toEqual([[0, "ask", undefined], [2, "ask", undefined]]);
  // Scarlet's first ask since: the asks the editor has seen are numbered first, in timeline order, and the new one after.
  expect((await assess(two.review, [{ index: 3, start: 16, end: 17, verdict: "ask", reason: "Retake at 16 s." }])).status).toBe(200);
  expect(order(two.review)).toEqual([[0, "ask", 1], [2, "ask", 2], [3, "ask", 3]]);
});

it("leaves a cut no one checked out of Scarlet's asks when the editor sends it back, so it keeps its place among those", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(8, 9)]);
  expect((await assess(one.review, [{ index: 1, start: 8, end: 9, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  // The pass handed the editor the cut at 2 s unchecked, and they send it back. Revised, it waits for their call.
  const revise = await api("POST", `/changes/${one.review.id}/revise`, { text: "Start it later.",
    position: { version: one.review.fromVersion, time: 2, end: 3, clipIds: [], cutIndex: 0 } });
  const { task: revision } = await revise.json();
  const moved = await api("POST", `/changes/${one.review.id}/staged-cuts/0`, { taskId: revision.id, start: 2.2, end: 3, reason: "Starts after the breath." });
  expect(moved.status).toBe(201);
  const { change } = await moved.json() as { change: Change };
  expect(ctx.repos.changes.get(change.id)!.cutAssessments!.map(a => [a.index, a.verdict, a.askOrder, a.revised])).toEqual([[0, "ask", undefined, true], [1, "ask", 1, undefined]]);
});

it("carries a part's staged cuts into the next part when Scarlet's own edit moved the video between them", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, assess } = dialoguePassInParts();
  // Part one is sure of one cut and stages another for a closer look, which Scarlet notes.
  const one = await submit(base, [{ start: 2, end: 3, review: false, reason: "false start" }, staged(12, 13)]);
  expect((await assess(one.review, [{ index: 0, start: 11, end: 12, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  // Part two reads the video after Scarlet's crossfades and stages one more cut. Part one's staged cut and its note join its review.
  const two = await submit(crossfades(task.id), [staged(15, 16)]);
  expect(await listed(two.review)).toEqual([[11, 12], [15, 16]]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 11, end: 12, verdict: "ask", reason: "Both takes land.", askOrder: 1 }]);
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "rejected", replacedBy: two.review.id });
  // One version of the pass waits for the editor.
  expect(waitingPasses().map(c => c.id)).toEqual([two.review.id]);
});

/** An independent edit can still change what survives of a passage in a running pass. */
function trimBetweenParts(start: number, end: number) {
  const { ctx } = workspace;
  const trim = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Trim",
    ops: [{ op: "rippleDelete", start, end }] }).change;
  expect(trim.state).toBe("approved");
  return ctx.repos.projects.get(project.id)!.head!;
}

it("asks the editor again about a cut they approved once another edit between parts took footage out of it", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(4, 5), staged(12, 14)]);
  // The editor approves the second cut while the pass runs, and asks for the result once it is done.
  expect((await choose(one.review, [{ index: 1, choice: "cut" }], true)).status).toBe(200);
  // The other edit takes half a second out of the middle of that cut before its next part.
  const two = await submit(trimBetweenParts(12.5, 13), [staged(15, 16)]);
  // The cut is still in the review, over what is left of its footage. The approval was about the cut as it was, so it
  // waits for the editor again instead of vanishing, and the pass doesn't apply itself.
  expect(await listed(two.review)).toEqual([[4, 5], [12, 13.5], [15, 16]]);
  expect(two.review.cutChoices).toBeUndefined();
  expect(two.review.applyWhenDone).toBeUndefined();
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "rejected", replacedBy: two.review.id });
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)?.state).toBe("ready");
});

it("carries an unanswered call over the surviving footage when another edit trims it between batches", async () => {
  const { base, staged, submit, listed, assess } = dialoguePassInParts();
  const first = await submit(base, [staged(12, 14)]);
  const note = { index: 0, start: 12, end: 14, verdict: "ask", reason: "Check the pause after the pickup." };
  expect((await assess(first.review, [{ ...note, inspected: true }])).status).toBe(200);
  const next = await submit(trimBetweenParts(12.5, 13), [staged(12, 13.5), staged(15, 16)]);
  expect(next.heldForReview).toEqual([{ start: 12, end: 13.5 }]);
  expect(await listed(next.review)).toEqual([[12, 13.5], [15, 16]]);
  expect(next.review.cutAssessments).toEqual([{ ...note, end: 13.5, askOrder: 1 }]);
});

it("keeps footage the editor skipped once another edit between parts took footage out of it", async () => {
  const { base, staged, submit, listed, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(12, 14)]);
  expect((await choose(one.review, [{ index: 0, choice: "keep" }])).status).toBe(200);
  // The other edit takes footage out of the skipped cut, and its next part is sure of a cut inside what is left of it.
  const two = await submit(trimBetweenParts(12.5, 13), [{ start: 13, end: 13.5, review: false, reason: "false start" }, staged(15, 16)]);
  // The editor's call stands over what is left of that footage, and Scarlet is told so.
  expect(two.editorDecided).toEqual([{ start: 13, end: 13.5 }]);
  expect(two.changes.map(c => c.state)).toEqual(["ready"]);
  expect(await listed(two.review)).toEqual([[12, 13.5], [15, 16]]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 12, end: 13.5, choice: "keep" }]);
});

it("folds the parts of a pass that an earlier build left waiting side by side into one, as Scarlet starts", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed } = dialoguePassInParts();
  const one = await submit(base, [{ start: 2, end: 3, review: false, reason: "false start" }, staged(12, 13)]);
  // An earlier build didn't carry part one's staged cut past Scarlet's crossfades: both parts' reviews were left waiting.
  const set = (change: Change) => ctx.repos.changes.put(change);
  set({ ...one.review, state: "rejected" });
  const two = await submit(crossfades(task.id), [staged(15, 16)]);
  set(one.review);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(waitingPasses()).toHaveLength(2);
  foldStrandedPasses(ctx);
  // One review waits now, with every staged cut, under the run that made them. The two it gathered are put away.
  const [folded] = waitingPasses();
  expect(waitingPasses()).toHaveLength(1);
  expect(folded!.taskId).toBe(task.id);
  expect(await listed(folded!)).toEqual([[11, 12], [15, 16]]);
  for (const part of [one.review, two.review]) expect(ctx.repos.changes.get(part.id)).toMatchObject({ state: "rejected", replacedBy: folded!.id });
  // Starting again finds nothing more to fold.
  foldStrandedPasses(ctx);
  expect(waitingPasses().map(c => c.id)).toEqual([folded!.id]);
});

it("keeps a click that arrives after another part shifts and renumbers its cut, leaving the new call open", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, choose } = dialoguePassInParts();
  const { review: first } = await submit(base, [staged(8, 10), staged(12, 14)]);
  const { review: next } = await submit(base, [{ ...staged(0, 1), review: false }, staged(4, 5)]);
  await choose(next, [{ index: 2, choice: "keep" }]);
  const result = await choose(first, [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }], true);
  expect(result.status).toBe(200);
  const live = (await result.json()).change as Change;
  expect(live.id).toBe(next.id);
  expect(live.cutChoices).toEqual([{ index: 1, start: 7, end: 9, choice: "keep" }, { index: 2, start: 11, end: 13, choice: "keep" }]);
  expect(live.applyWhenDone).toBeUndefined();
  expect(ctx.repos.projects.get(project.id)!.head).toBe(next.fromVersion);
});

it("leaves a revised boundary open when an approval of the old boundary arrives late", async () => {
  const { base, staged, submit, assess, choose } = dialoguePassInParts();
  const { review } = await submit(base, [staged(8, 10)]);
  await assess(review, [{ index: 0, start: 8, end: 10, verdict: "ask", reason: "Check the pickup." }]);
  const revised = await api("POST", `/changes/${review.id}/staged-cuts/0`, { start: 7, end: 10, reason: "Include the first word." });
  const { change } = await revised.json();
  const result = await choose(review, [{ index: 0, choice: "cut" }], true);
  expect(result.status).toBe(200);
  const saved = (await result.json()).change as Change;
  expect(saved.id).toBe(change.id);
  expect(saved.cutChoices ?? []).toEqual([]);
  expect(saved.cutAssessments?.[0]?.verdict).toBe("ask");
  expect(saved.applyWhenDone).toBeUndefined();
});

it.each(["current", "earlier"] as const)("carries the recovered footage and decisions when the same pass saves another part on its %s version", async input => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const { review: first } = await submit(base, [staged(2, 3), staged(8, 10), staged(13, 15)]);
  await assess(first, [{ index: 0, start: 2, end: 3, verdict: "keep", reason: "Keep it." },
    { index: 1, start: 8, end: 10, verdict: "ask", reason: "Check the repeated word." },
    { index: 2, start: 13, end: 15, verdict: "ask", reason: "Check this take." }]);
  await choose(first, [{ index: 2, choice: "keep" }]);
  const trim = (start: number, end: number) => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true,
    description: "Trim", ops: [{ op: "rippleDelete", start, end }] }).change.appliedVersion!;
  trim(2, 3);
  const { task: revision } = await (await api("POST", `/changes/${first.id}/revise`, { text: "Include the first word.",
    position: { version: base, time: 8, end: 10, clipIds: [], cutIndex: 1 } })).json();
  const moved = await api("POST", `/changes/${first.id}/staged-cuts/1`, { start: 7.5, end: 10, reason: "Includes the first word.", taskId: revision.id });
  expect(moved.status).toBe(201);
  const { change: recovered } = await moved.json() as { change: Change };
  expect(recovered.cutEdits?.[0]?.range).toEqual({ start: 6.5, end: 9 });
  const current = trim(4, 4.5);
  const headInput = input === "current";
  const repeated = headInput ? { start: 6.5, end: 7 } : { start: 8, end: 8.5 };
  const next = await submit(headInput ? current : base, [{ start: 0, end: 0.5, review: false, reason: "Trim the opening." },
    { ...repeated, review: false, reason: "Another proposal at the recovered call." }, staged(17, 18)]);
  expect(next.editorDecided).toBeUndefined();
  expect(next.heldForReview).toEqual([repeated]);
  expect(next.alreadyRemoved).toEqual([{ changeId: recovered.id, index: 0, version: current, at: 2 }]);
  expect(await listed(next.review)).toEqual([[5.5, 8], [11, 13], headInput ? [16.5, 17.5] : [15, 16]]);
  expect(next.review.cutAssessments).toMatchObject([{ index: 0, verdict: "ask", reason: "Includes the first word." },
    { index: 1, verdict: "ask", reason: "Check this take." }]);
  expect(next.review.cutChoices).toEqual([{ index: 1, choice: "keep", start: 11, end: 13 }]);
  expect(next.review.cutEdits).toEqual([{ index: 0, version: next.review.fromVersion, range: { start: 5.5, end: 8 }, previewVersion: expect.any(String) }]);
  expect(ctx.repos.changes.get(recovered.id)).toMatchObject({ state: "rejected", replacedBy: next.review.id, cutEdits: recovered.cutEdits });
  const approved = await api("POST", `/changes/${next.review.id}/approve`, { restoredCuts: [1, 2] });
  expect(approved.status).toBe(200);
  const applied = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(applied.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([
    { sourceIn: 0.5, sourceOut: 2 }, { sourceIn: 3, sourceOut: 5 }, { sourceIn: 5.5, sourceOut: 7.5 }, { sourceIn: 10, sourceOut: 20 }]);
  expect(next.review.taskId).toBe(task.id);
});

it("carries the recovered footage at its source edges after a subframe manual trim", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit } = dialoguePassInParts();
  const { review } = await submit(base, [staged(8, 10)]);
  const trim = (start: number, end: number) => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true,
    description: "Trim", ops: [{ op: "rippleDelete", start, end }] }).change.appliedVersion!;
  trim(1, 2);
  const moved = await api("POST", `/changes/${review.id}/staged-cuts/0`, { start: 7.5, end: 10, reason: "Include the pickup.", taskId: task.id });
  expect(moved.status).toBe(201);
  const next = await submit(trim(2, 2.505), [staged(15, 16)]);
  expect(next.review.cutEdits?.[0]?.range).toEqual({ start: expect.closeTo(5.995, 7), end: expect.closeTo(8.495, 7) });
  const approved = await api("POST", `/changes/${next.review.id}/approve`, { restoredCuts: [1] });
  expect(approved.status).toBe(200);
  const head = ctx.repos.projects.header(project.id)!.head!;
  expect(straightCuts(ctx.repos.versions.get(project.id, head)!.timeline.tracks.find(t => t.id === "a1")!.clips))
    .toMatchObject([{ sourceIn: 0, sourceOut: 1 }, { sourceIn: 2, sourceOut: 3 }, { sourceIn: 3.505, sourceOut: 7.5 }, { sourceIn: 10, sourceOut: 20 }]);
});

it.each([false, true])("saves a scoped revision after a later part renumbers its cut, with another intervening edit %s", async changed => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose } = dialoguePassInParts();
  const { review: original } = await submit(base, [staged(5, 6), staged(12, 14)]);
  await choose(original, [{ index: 0, choice: "keep" }]);
  const { task: revision } = await (await api("POST", `/changes/${original.id}/revise`, { text: "Remove the first word.",
    position: { version: base, time: 12, end: 14, clipIds: [], cutIndex: 1 } })).json();
  const { review: middle } = await submit(base, [{ start: 0, end: 1, review: false, reason: "Trim opening." }, staged(2, 3)]);
  expect(ctx.repos.changes.get(original.id)).toMatchObject({ state: "rejected", replacedBy: middle.id });
  const merged = await api("POST", projectsPath() + "/dialogue-cuts", { fromVersion: middle.fromVersion, taskId: task.id,
    description: "Join two calls.", cuts: [{ start: 5, end: 11, review: false, reason: "Remove everything between the calls." }] });
  expect(merged.status).toBe(409);
  expect(ctx.repos.changes.get(middle.id)!.state).toBe("ready");
  expect(ctx.repos.projects.header(project.id)!.head).toBe(middle.fromVersion);
  const nextPart = await submit(middle.fromVersion, [{ start: 11, end: 11.5, review: false, reason: "Another proposal at the queued call." },
    staged(13, 14), staged(16, 17)]);
  const next = nextPart.review;
  expect(nextPart.heldForReview).toEqual([{ start: 11, end: 11.5 }, { start: 13, end: 14 }]);
  expect(await listed(next)).toEqual([[1, 2], [4, 5], [11, 13], [16, 17]]);
  let taskId = revision.id;
  const move = (extra: object = {}) => api("POST", `/changes/${original.id}/staged-cuts/1`, { taskId,
    start: 11.5, end: 14, reason: "Remove the first word.", ...extra });
  if (changed) {
    const inserted = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Insert room",
      ops: [{ op: "rippleInsertGap", at: 12, duration: 1 }] }).change.appliedVersion!;
    const failed = await move();
    expect(failed.status).toBe(409);
    expect(ctx.repos.tasks.get(revision.id)?.cutConflict).toMatchObject({ changeId: next.id, index: 2, version: inserted });
    await api("POST", `/tasks/${taskId}/complete`, { state: "failed", error: "Interrupted during recheck." });
    const { task: resumed } = await (await api("POST", `/tasks/${taskId}/retry`, {})).json();
    taskId = resumed.id;
    expect(resumed.cutConflict).toMatchObject({ changeId: next.id, index: 2, version: inserted });
    expect(ctx.repos.changes.get(original.id)?.state).toBe("rejected");
  }
  const saved = await move(changed ? { keep: true } : {});
  expect(saved.status, await saved.clone().text()).toBe(201);
  const { change, index, carried } = await saved.json() as { change: Change; index: number; carried: boolean };
  expect({ index, carried }).toEqual({ index: 2, carried: true });
  expect(change.cutChoices).toContainEqual({ index: 1, choice: "keep", start: 4, end: 5 });
  expect(ctx.repos.changes.get(next.id)).toMatchObject({ state: "rejected", replacedBy: change.id });
  if (changed) {
    expect(change.cutChoices).toContainEqual({ index: 2, choice: "keep", start: 11, end: 13 });
    expect(ctx.repos.tasks.get(taskId)?.cutConflict).toBeUndefined();
  } else {
    expect(change.cutEdits).toMatchObject([{ index: 2, version: next.fromVersion, range: { start: 10.5, end: 13 } }]);
    const repeat = await (await move()).json();
    expect(repeat).toMatchObject({ carried: true, index: 2, change: { id: change.id } });
    const applied = await api("POST", `/changes/${change.id}/approve`, { restoredCuts: [0, 1, 3] });
    expect(applied.status).toBe(200);
    const head = ctx.repos.projects.header(project.id)!.head!;
    expect(straightCuts(ctx.repos.versions.get(project.id, head)!.timeline.tracks.find(t => t.id === "a1")!.clips))
      .toMatchObject([{ sourceIn: 1, sourceOut: 11.5 }, { sourceIn: 14, sourceOut: 20 }]);
  }
});

it("preserves the recovered review and every choice if a later part cannot locate its footage", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose } = dialoguePassInParts();
  const { review } = await submit(base, [staged(6, 8), staged(12, 13)]);
  await choose(review, [{ index: 1, choice: "keep" }]);
  proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Trim",
    ops: [{ op: "rippleDelete", start: 1, end: 2 }] });
  const moved = await api("POST", `/changes/${review.id}/staged-cuts/0`, { start: 5.5, end: 8, taskId: task.id, reason: "Include the pickup." });
  expect(moved.status).toBe(201);
  const { change: recovered } = await moved.json() as { change: Change };
  const later = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Insert room",
    ops: [{ op: "rippleInsertGap", at: 6, duration: 1 }] }).change.appliedVersion!;
  const next = await api("POST", projectsPath() + "/dialogue-cuts", { fromVersion: later, taskId: task.id, description: "Next part",
    cuts: [{ start: 15, end: 16, review: false, reason: "Trim another line." }] });
  expect(next.status).toBe(409);
  expect(await next.text()).toContain(recovered.id);
  expect(ctx.repos.projects.header(project.id)!.head).toBe(later);
  expect(ctx.repos.changes.get(recovered.id)).toMatchObject({ state: "ready", cutChoices: recovered.cutChoices, cutEdits: recovered.cutEdits });
  const separate = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "A separate pass",
    createdBy: { type: "human", name: "Editor" }, context: { threadId: task.id } });
  const independent = await api("POST", projectsPath() + "/dialogue-cuts", { fromVersion: later, taskId: separate.id, description: "Separate pass", cuts: [staged(15, 16)] });
  expect(independent.status).toBe(201);
  expect(ctx.repos.changes.get(recovered.id)!.state).toBe("ready");
});

it("keeps the editor's call on a cut after touching staged cuts through the pass's next part, and applies it to that cut", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose } = dialoguePassInParts();
  // Two of part one's four staged cuts touch, so its review lists them as one cut.
  const one = await submit(base, [staged(2, 3), staged(3, 4), staged(8, 9), staged(12, 13)]);
  expect(await listed(one.review)).toEqual([[2, 4], [8, 9], [12, 13]]);
  // The editor skips the last cut, and asks for the result once the pass is done.
  expect((await choose(one.review, [{ index: 2, choice: "keep" }], true)).status).toBe(200);
  const two = await submit(base, [staged(16, 17)]);
  expect(await listed(two.review)).toEqual([[2, 4], [8, 9], [12, 13], [16, 17]]);
  expect(two.review.cutChoices).toEqual([{ index: 2, start: 12, end: 13, choice: "keep" }]);
  // The run finishes without checking the others, so they are the editor's calls. Their last call applies the pass with
  // the one they made first: the skipped footage stays in and the other cuts come out.
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)?.state).toBe("ready");
  expect((await choose(two.review, [{ index: 0, choice: "cut" }, { index: 1, choice: "cut" }, { index: 2, choice: "keep" }, { index: 3, choice: "cut" }])).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)).toMatchObject({ state: "approved", restoredCuts: [2] });
  const applied = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(applied.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([{ sourceIn: 0, sourceOut: 2 }, { sourceIn: 4, sourceOut: 8 },
    { sourceIn: 9, sourceOut: 16 }, { sourceIn: 17, sourceOut: 20 }]);
});

it("keeps Scarlet's note on a cut after touching staged cuts through the pass's next part", async () => {
  const { base, staged, submit, listed, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(3, 4), staged(8, 9), staged(12, 13)]);
  const note = { index: 1, start: 8, end: 9, verdict: "ask", reason: "Both takes land." };
  expect((await assess(one.review, [note])).status).toBe(200);
  const two = await submit(base, [staged(16, 17)]);
  expect(await listed(two.review)).toEqual([[2, 4], [8, 9], [12, 13], [16, 17]]);
  expect(two.review.cutAssessments).toEqual([{ ...note, askOrder: 1 }]);
});

it("keeps the editor's call on touching staged cuts through the pass's next part, which leaves their footage alone", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, listed, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(3, 4), staged(8, 9)]);
  // The editor skips the two that touch, which the review shows as one cut.
  expect((await choose(one.review, [{ index: 0, choice: "keep" }])).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)!.cutChoices).toEqual([{ index: 0, start: 2, end: 4, choice: "keep" }]);
  // The next part is sure of a cut inside that range. The editor's call stands, and Scarlet says so.
  const two = await submit(base, [{ start: 3, end: 4, review: false, reason: "false start" }, staged(16, 17)]);
  expect(two.editorDecided).toEqual([{ start: 3, end: 4 }]);
  expect(two.changes.map(c => c.state)).toEqual(["ready"]);
  expect(await listed(two.review)).toEqual([[2, 4], [8, 9], [16, 17]]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 2, end: 4, choice: "keep" }]);
});

it("keeps calls and notes on their cuts when the pass's next part applies a cut ahead of touching staged cuts", async () => {
  const { base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(4, 5), staged(5, 6), staged(10, 11), staged(14, 15)]);
  expect((await assess(one.review, [{ index: 0, start: 4, end: 6, verdict: "cut", reason: "Both retakes are clean." },
    { index: 1, start: 10, end: 11, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  expect((await choose(one.review, [{ index: 0, choice: "cut" }, { index: 2, choice: "keep" }])).status).toBe(200);
  // Part two applies a second of earlier footage, so every staged cut moves up by it.
  const two = await submit(base, [{ start: 1, end: 2, review: false, reason: "false start" }]);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
  expect(await listed(two.review)).toEqual([[3, 5], [9, 10], [13, 14]]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 3, end: 5, verdict: "cut", reason: "Both retakes are clean." },
    { index: 1, start: 9, end: 10, verdict: "ask", reason: "Both takes land.", askOrder: 1 }]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 3, end: 5, choice: "cut" }, { index: 2, start: 13, end: 14, choice: "keep" }]);
});

it("asks the editor again about a cut they approved once the pass's next part stages a cut that touches it", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13), staged(16, 17)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "cut", reason: "A clean retake." }])).status).toBe(200);
  // The editor approves two cuts and asks for the result once the pass is done.
  expect((await choose(one.review, [{ index: 0, choice: "cut" }, { index: 2, choice: "cut" }], true)).status).toBe(200);
  // Part two stages the second after the first cut. The two are one cut now, which neither the approval nor the note was about.
  const two = await submit(base, [staged(9, 10)]);
  expect(two.editorDecided).toBeUndefined();
  expect(await listed(two.review)).toEqual([[8, 10], [12, 13], [16, 17]]);
  // It waits for the editor, under what Scarlet staged there.
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 8, end: 10, verdict: "ask", provisional: true, reason: "Retake at 8 s. Retake at 9 s." }]);
  expect(two.review.cutChoices).toEqual([{ index: 2, start: 16, end: 17, choice: "cut" }]);
  // With an approval open again the pass waits for the editor instead of applying itself.
  expect(two.review.applyWhenDone).toBeUndefined();
  // The same for an approved cut Scarlet had no note on. The cut that already waits carries its note.
  const three = await submit(base, [staged(17, 18)]);
  expect(await listed(three.review)).toEqual([[8, 10], [12, 13], [16, 18]]);
  expect(three.review.cutAssessments).toEqual([{ index: 0, start: 8, end: 10, verdict: "ask", provisional: true, reason: "Retake at 8 s. Retake at 9 s." },
    { index: 2, start: 16, end: 18, verdict: "ask", provisional: true, reason: "Retake at 16 s. Retake at 17 s." }]);
  expect(three.review.cutChoices).toBeUndefined();
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(three.review.id)?.state).toBe("ready");
  // Scarlet's recommendation replaces the temporary note on the new footage.
  const note = { index: 0, start: 8, end: 10, verdict: "cut", reason: "One long retake." };
  expect((await assess(ctx.repos.changes.get(three.review.id)!, [note])).status).toBe(200);
  expect(ctx.repos.changes.get(three.review.id)!.cutAssessments).toEqual([note, { index: 2, start: 16, end: 18, verdict: "ask", provisional: true, reason: "Retake at 16 s. Retake at 17 s." }]);
});

it("leaves an approved cut for the editor without a note in a pass Scarlet hasn't assessed, as a revised cut is left", async () => {
  const { base, staged, submit, listed, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(16, 17)]);
  expect((await choose(one.review, [{ index: 0, choice: "cut" }, { index: 1, choice: "cut" }], true)).status).toBe(200);
  const two = await submit(base, [staged(9, 10)]);
  expect(await listed(two.review)).toEqual([[8, 10], [16, 17]]);
  // A note here would make the pass read as assessed, where every cut without a note stays in.
  expect(two.review.cutAssessments).toBeUndefined();
  expect(two.review.cutChoices).toEqual([{ index: 1, start: 16, end: 17, choice: "cut" }]);
  expect(two.review.applyWhenDone).toBeUndefined();
});

it("preserves a skipped call when the next part stages a neighboring cut, and waits on unchecked cuts", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(4, 5), staged(8, 9), staged(16, 17)]);
  expect((await assess(one.review, [{ index: 1, start: 8, end: 9, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  // The editor approves the first cut, skips the one Scarlet asked about, and asks for the result once the pass is done.
  expect((await choose(one.review, [{ index: 0, choice: "cut" }, { index: 1, choice: "keep" }], true)).status).toBe(200);
  // The adjacent proposal would change the published call's passage.
  const two = await submit(base, [staged(9, 10), staged(12, 13)]);
  expect(two.heldForReview).toEqual([{ start: 9, end: 10 }]);
  expect(await listed(two.review)).toEqual([[4, 5], [8, 9], [12, 13], [16, 17]]);
  expect(two.review.cutAssessments).toEqual([{ index: 1, start: 8, end: 9, verdict: "ask", askOrder: 1, reason: "Both takes land." }]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 4, end: 5, choice: "cut" }, { index: 1, start: 8, end: 9, choice: "keep" }]);
  expect(two.review.applyWhenDone).toBeDefined();
  // The run finishes without looking at the two cuts nobody called. They wait for the editor, who skips them.
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)).toMatchObject({ state: "ready", applyWhenDone: { userId: localUser(ctx).id } });
  expect((await choose(two.review, [{ index: 0, choice: "cut" }, { index: 1, choice: "keep" }, { index: 2, choice: "keep" }, { index: 3, choice: "keep" }])).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)).toMatchObject({ state: "approved", restoredCuts: [1, 2, 3] });
  const applied = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(applied.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([{ sourceIn: 0, sourceOut: 4 }, { sourceIn: 5, sourceOut: 20 }]);
});

it("leaves every unchecked cut for the editor when a pass's notes all went with cuts its next part decided again", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13), staged(16, 17)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "keep", reason: "The aside lands." }])).status).toBe(200);
  // The editor approves the last cut and asks for the result once the pass is done. As it stands, only that cut would come out.
  expect((await choose(one.review, [{ index: 2, choice: "cut" }], true)).status).toBe(200);
  // Part two decides the noted cut again. With no note left the pass would read as unassessed, where Approve takes every
  // cut, so the cuts nobody called wait for the editor and the pass doesn't apply itself.
  const two = await submit(base, [staged(8, 8.5)]);
  expect(await listed(two.review)).toEqual([[8, 8.5], [12, 13], [16, 17]]);
  // Each cut left carries the note: the one the editor approved keeps their call, the other two wait for them.
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 8, end: 8.5, verdict: "ask", provisional: true, reason: "Retake at 8 s." },
    { index: 1, start: 12, end: 13, verdict: "ask", provisional: true, reason: "Retake at 12 s." }, { index: 2, start: 16, end: 17, verdict: "ask", provisional: true, reason: "Retake at 16 s." }]);
  expect(two.review.cutChoices).toEqual([{ index: 2, start: 16, end: 17, choice: "cut" }]);
  expect(two.review.applyWhenDone).toBeUndefined();
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)?.state).toBe("ready");
});

it("leaves every unchecked cut for the editor when a pass's only note went with a cut decided again and the editor had made no call", async () => {
  const { base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "keep", reason: "The aside lands." }])).status).toBe(200);
  expect((await choose(one.review, [], true)).status).toBe(200);
  const two = await submit(base, [staged(8, 8.5)]);
  expect(await listed(two.review)).toEqual([[8, 8.5], [12, 13]]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 8, end: 8.5, verdict: "ask", provisional: true, reason: "Retake at 8 s." },
    { index: 1, start: 12, end: 13, verdict: "ask", provisional: true, reason: "Retake at 12 s." }]);
  expect(two.review.cutChoices).toBeUndefined();
  expect(two.review.applyWhenDone).toBeUndefined();
});

it("keeps a pass scheduled whose notes went with a cut the next part is sure of, and hands the editor a cut staged afterwards that nobody checked", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(16, 17)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "cut", reason: "Clean pickup." }])).status).toBe(200);
  expect((await choose(one.review, [{ index: 1, choice: "cut" }], true)).status).toBe(200);
  // Part two is sure of the noted cut's footage. The one cut left has the editor's call, so the pass still applies itself,
  // and it still reads as a pass Scarlet has assessed.
  const two = await submit(base, [{ start: 7.5, end: 9.5, review: false, reason: "dead air" }]);
  expect(await listed(two.review)).toEqual([[14, 15]]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 14, end: 15, verdict: "ask", provisional: true, reason: "Retake at 16 s." }]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 14, end: 15, choice: "cut" }]);
  expect(two.review.applyWhenDone).toBeDefined();
  // Part three stages one more cut, and the run ends before Scarlet has looked at it.
  const three = await submit(ctx.repos.projects.get(project.id)!.head!, [staged(3, 4)]);
  expect(await listed(three.review)).toEqual([[3, 4], [14, 15]]);
  expect(three.review.cutAssessments).toEqual([{ index: 1, start: 14, end: 15, verdict: "ask", provisional: true, reason: "Retake at 16 s." }]);
  expect(three.review.applyWhenDone).toBeDefined();
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  // The cut nobody approved or noted waits for the editor. They skip it, and the approved cut comes out.
  expect(ctx.repos.changes.get(three.review.id)?.state).toBe("ready");
  expect((await choose(three.review, [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }])).status).toBe(200);
  expect(ctx.repos.changes.get(three.review.id)).toMatchObject({ state: "approved", restoredCuts: [0] });
  const applied = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(applied.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([{ sourceIn: 0, sourceOut: 7.5 }, { sourceIn: 9.5, sourceOut: 16 }, { sourceIn: 17, sourceOut: 20 }]);
});

it("keeps a published call separate when a confident removal would join it to another approved cut", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(5, 6), staged(12, 13)]);
  expect((await assess(one.review, [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Both takes land." },
    { index: 2, start: 12, end: 13, verdict: "keep", reason: "The aside lands." }])).status).toBe(200);
  expect((await choose(one.review, [{ index: 0, choice: "cut" }, { index: 1, choice: "cut" }], true)).status).toBe(200);
  const next = await api("POST", projectsPath() + "/dialogue-cuts", { fromVersion: base, taskId: task.id, description: "Next part.",
    cuts: [{ start: 3, end: 5, review: false, reason: "Dead air." }] });
  expect(next.status).toBe(409);
  expect(await next.text()).toContain("merge a cut waiting for review");
  expect(ctx.repos.projects.header(project.id)?.head).toBe(base);
  expect(ctx.repos.changes.get(one.review.id)?.applyWhenDone).toBeDefined();
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "approved", restoredCuts: [2] });
});

it("keeps a staged cut inside an edit that another request shortened to end between two frames", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, listed } = dialoguePassInParts();
  const fps = ctx.repos.projects.get(project.id)!.settings.fps;
  // Another request trims 0.38 s while the part is decided: the edit is 19.62 s long now, which is no whole frame.
  expect(proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Trim",
    ops: [{ op: "rippleDelete", start: 5, end: 5.38 }] }).change.state).toBe("approved");
  // The part, decided on the version before the trim, stages the recording's last frame.
  const one = await submit(base, [staged(8, 9), staged(599 / fps, 20)]);
  const cuts = await listed(one.review);
  expect(cuts).toHaveLength(2);
  expect(cuts[1]![0]).toBeCloseTo(19.6, 9);
  expect(cuts[1]![1]).toBeCloseTo(19.62, 9);
});

it("doesn't apply a scheduled pass by itself while a cut that changed waits for the editor", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "cut", reason: "A clean retake." },
    { index: 1, start: 12, end: 13, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  // The editor answers the one call, which schedules the pass. Done now, it would take the retake out.
  expect((await choose(one.review, [{ index: 1, choice: "keep" }], true)).status).toBe(200);
  // Part two stages a cut against the retake. Scarlet's note was about the retake alone, so the cut they make waits for the editor.
  const two = await submit(base, [staged(9, 10)]);
  expect(await listed(two.review)).toEqual([[8, 10], [12, 13]]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 8, end: 10, verdict: "ask", provisional: true, reason: "Retake at 8 s. Retake at 9 s." },
    { index: 1, start: 12, end: 13, verdict: "ask", reason: "Both takes land.", askOrder: 1 }]);
  expect(two.review.cutChoices).toEqual([{ index: 1, start: 12, end: 13, choice: "keep" }]);
  expect(two.review.applyWhenDone).toBeUndefined();
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)?.state).toBe("ready");
});

it("keeps a pass's cut list, calls and notes when a staged cut at the very end of the edit is shorter than a frame", async () => {
  const { ctx } = workspace;
  // The recording, and so the edit, ends between two frames.
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts(20.02);
  const one = await submit(base, [staged(8, 9), staged(12, 13)]);
  expect((await assess(one.review, [{ index: 0, start: 8, end: 9, verdict: "cut", reason: "A clean retake." },
    { index: 1, start: 12, end: 13, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  expect((await choose(one.review, [{ index: 1, choice: "keep" }], true)).status).toBe(200);
  // Its last 30 ms hold no whole frame, and the frame nearest their end is past the end of the edit. The cut stops at the end.
  const two = await submit(base, [staged(19.99, 20.02)]);
  expect(await listed(two.review)).toEqual([[8, 9], [12, 13], [20, 20.02]]);
  expect(two.review.cutChoices).toEqual([{ index: 1, start: 12, end: 13, choice: "keep" }]);
  expect(two.review.cutAssessments).toHaveLength(2);
  // The cut Scarlet never checked waits for the editor. They skip it, and the pass applies with their calls and Scarlet's
  // note: the retake comes out, the skipped cuts stay.
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)?.state).toBe("ready");
  expect((await choose(two.review, [{ index: 1, choice: "keep" }, { index: 2, choice: "keep" }])).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)).toMatchObject({ state: "approved", restoredCuts: [1, 2] });
  const applied = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(applied.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([{ sourceIn: 0, sourceOut: 8 }, { sourceIn: 9, sourceOut: 20.02 }]);
});

it("keeps the note on a cut that waits for the editor within a note's length, and never empty", async () => {
  const { base, submit, listed, assess } = dialoguePassInParts();
  const long = (n: number) => `Take ${n} of the same line, dropped because the speaker restarts the sentence halfway through and says it again more cleanly.`;
  // Eight touching staged cuts under one note, then a ninth that joins them.
  const one = await submit(base, Array.from({ length: 8 }, (_, n) => ({ start: 2 + n, end: 3 + n, review: true, reason: long(n + 1) })));
  expect(await listed(one.review)).toEqual([[2, 10]]);
  expect((await assess(one.review, [{ index: 0, start: 2, end: 10, verdict: "cut", reason: "Eight tries at one line." }])).status).toBe(200);
  const two = await submit(base, [{ start: 10, end: 11, review: true, reason: long(9) }]);
  expect(await listed(two.review)).toEqual([[2, 11]]);
  const waits = two.review.cutAssessments![0]!;
  expect(waits).toMatchObject({ index: 0, start: 2, end: 11, verdict: "ask" });
  expect(waits.reason.length).toBeGreaterThan(780);
  expect(waits.reason.length).toBeLessThanOrEqual(800);
  expect(waits.reason.startsWith(`${long(1)} ${long(2)}`)).toBe(true);
  // Staged cuts whose reasons are blank: the cut that waits says what the app says of a cut without a reason.
  const three = await submit(base, [{ start: 14, end: 15, review: true, reason: " " }]);
  expect((await assess(three.review, [{ index: 1, start: 14, end: 15, verdict: "cut", reason: "A breath." }])).status).toBe(200);
  const four = await submit(base, [{ start: 15, end: 16, review: true, reason: " " }]);
  expect(await listed(four.review)).toEqual([[2, 11], [14, 16]]);
  expect(four.review.cutAssessments).toEqual([waits, { index: 1, start: 14, end: 16, verdict: "ask", provisional: true, reason: "Staged for a closer look." }]);
});

it("saves a part whose sure cut starts right where a carried cut's original range ends, after another request moved the edit", async () => {
  const { ctx } = workspace;
  const { base, submit } = dialoguePassInParts();
  const fps = ctx.repos.projects.get(project.id)!.settings.fps;
  const frame = (n: number) => n / fps;
  // Part one takes ten frames out near the start and stages a narrowed cut. What Scarlet first proposed there ran two frames longer either side.
  await submit(base, [{ start: frame(7), end: frame(17), review: false, reason: "false start" },
    { start: frame(100), end: frame(110), review: true, reason: "A narrowed retake.", originalRange: { start: frame(98), end: frame(112) } }]);
  const left = ctx.repos.projects.get(project.id)!.head!;
  // Another request trims the edit further on while the next part is decided.
  expect(proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Trim",
    ops: [{ op: "rippleDelete", start: frame(300), end: frame(313) }] }).change.state).toBe("approved");
  // The next part is sure of the footage right after that original range. The two only touch.
  const two = await submit(left, [{ start: frame(102), end: frame(120), review: false, reason: "dead air" }]);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
});

it("keeps footage the editor skipped once the pass's next part stages a cut that touches it, through to the applied pass", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(12, 13)]);
  // The editor skips the first cut and asks for the result once the pass is done.
  expect((await choose(one.review, [{ index: 0, choice: "keep" }], true)).status).toBe(200);
  // Part two stages the second after it. The two are one cut now, and the editor's skip holds for it.
  const two = await submit(base, [staged(9, 10)]);
  expect(await listed(two.review)).toEqual([[8, 10], [12, 13]]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 8, end: 10, choice: "keep" }]);
  // Scarlet is told its cut went with the editor's call.
  expect(two.editorDecided).toEqual([{ start: 9, end: 10 }]);
  // The same when a cut is staged right before the skipped one.
  const three = await submit(base, [staged(7, 8)]);
  expect(await listed(three.review)).toEqual([[7, 10], [12, 13]]);
  expect(three.review.cutChoices).toEqual([{ index: 0, start: 7, end: 10, choice: "keep" }]);
  expect(three.editorDecided).toEqual([{ start: 7, end: 8 }]);
  // The other cut, never checked, is the editor's call once the run finishes. Approving it applies the pass.
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(three.review.id)?.state).toBe("ready");
  expect((await choose(three.review, [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }])).status).toBe(200);
  expect(ctx.repos.changes.get(three.review.id)).toMatchObject({ state: "approved", restoredCuts: [0] });
  const applied = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(applied.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([{ sourceIn: 0, sourceOut: 12 }, { sourceIn: 13, sourceOut: 20 }]);
});

it("reports cuts that joined skipped footage in the request's own times and in order, when the part also applies a cut ahead", async () => {
  const { base, staged, submit, listed, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(8, 9), staged(14, 15)]);
  expect((await choose(one.review, [{ index: 0, choice: "keep" }, { index: 1, choice: "keep" }])).status).toBe(200);
  // Part two takes a second out ahead, stages a cut on either side of the first skipped cut, the later one ending off the
  // frame grid, and is sure of the second skipped cut.
  const two = await submit(base, [{ start: 1, end: 2, review: false, reason: "false start" }, staged(7, 8), staged(9, 10.01),
    { start: 14, end: 15, review: false, reason: "dead air" }]);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
  expect(await listed(two.review)).toEqual([[6, 9], [13, 14]]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 6, end: 9, choice: "keep" }, { index: 1, start: 13, end: 14, choice: "keep" }]);
  expect(two.editorDecided).toEqual([{ start: 7, end: 8 }, { start: 9, end: 10.01 }, { start: 14, end: 15 }]);
});

it("tells Scarlet when a cut it staged earlier ends up against footage the editor skipped", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(5, 6)]);
  expect((await assess(one.review, [{ index: 0, start: 2, end: 3, verdict: "cut", reason: "A clean retake." }])).status).toBe(200);
  // The editor skips the second cut and asks for the result once the pass is done.
  expect((await choose(one.review, [{ index: 1, choice: "keep" }], true)).status).toBe(200);
  // Part two takes out everything between them, so the first cut is one cut with the skipped footage and stays in with it.
  const two = await submit(base, [{ start: 3, end: 5, review: false, reason: "dead air" }]);
  expect(await listed(two.review)).toEqual([[2, 4]]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 2, end: 4, choice: "keep" }]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 2, end: 4, verdict: "ask", provisional: true, reason: "Retake at 2 s. Retake at 5 s." }]);
  expect(two.editorDecided).toEqual([{ start: 2, end: 3 }]);
  // Told once: the next part carries the cut under the editor's call.
  const three = await submit(two.changes[0]!.toVersion, [staged(10, 11)]);
  expect(await listed(three.review)).toEqual([[2, 4], [10, 11]]);
  expect(three.editorDecided).toBeUndefined();
  // The cut staged last, never checked, waits for the editor's call. Skipping it applies the pass.
  await checkPassAudio(task.id);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(three.review.id)?.state).toBe("ready");
  expect((await choose(three.review, [{ index: 0, choice: "keep" }, { index: 1, choice: "keep" }])).status).toBe(200);
  expect(ctx.repos.changes.get(three.review.id)).toMatchObject({ state: "approved", restoredCuts: [0, 1] });
});

it("keeps skipped footage when a cut the pass is sure of brings it together with an approved cut", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed, choose } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 3), staged(5, 6)]);
  // The editor approves the first cut, skips the second, and asks for the result once the pass is done.
  expect((await choose(one.review, [{ index: 0, choice: "cut" }, { index: 1, choice: "keep" }], true)).status).toBe(200);
  // Part two takes out everything between them. On the new version the two staged cuts touch, so they are one cut, and the skip holds for it.
  const two = await submit(base, [{ start: 3, end: 5, review: false, reason: "dead air" }]);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
  expect(await listed(two.review)).toEqual([[2, 4]]);
  expect(two.review.cutChoices).toEqual([{ index: 0, start: 2, end: 4, choice: "keep" }]);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(two.review.id)).toMatchObject({ state: "approved", restoredCuts: [0] });
  const applied = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(applied.tracks.find(t => t.id === "a1")!.clips).toMatchObject([{ sourceIn: 0, sourceOut: 3 }, { sourceIn: 5, sourceOut: 20 }]);
});

it("lists staged cuts as one cut in the part whose applied cut brings them together, rounding or no rounding", async () => {
  const { base, staged, submit, listed } = dialoguePassInParts();
  const fps = workspace.ctx.repos.projects.get(project.id)!.settings.fps;
  const frame = (n: number) => n / fps;
  await submit(base, [staged(frame(18), frame(42)), staged(frame(438), frame(440))]);
  // Taking 13.2 s away from 14.6 s leaves a hair more than 1.4 s. The two cuts still meet at frame 42.
  const two = await submit(base, [{ start: frame(42), end: frame(438), review: false, reason: "dead air" }]);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
  expect(await listed(two.review)).toEqual([[frame(18), frame(44)]]);
});

it("lists staged cuts as one cut when the rounding goes the other way, and leaves a cut shorter than a frame as staged", async () => {
  const { base, staged, submit, listed } = dialoguePassInParts();
  const fps = workspace.ctx.repos.projects.get(project.id)!.settings.fps;
  const frame = (n: number) => n / fps;
  // The last cut is under a frame long and off the frame grid, so it has no frame to be put on.
  await submit(base, [staged(frame(10), frame(20)), staged(frame(52), frame(54)), staged(frame(300.1), frame(300.4))]);
  const two = await submit(base, [{ start: frame(20), end: frame(52), review: false, reason: "dead air" }]);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
  const cuts = await listed(two.review);
  expect(cuts.slice(0, 1)).toEqual([[frame(10), frame(22)]]);
  expect(cuts).toHaveLength(2);
  expect(cuts[1]![0]).toBeCloseTo(frame(268.1), 9);
  expect(cuts[1]![1]).toBeCloseTo(frame(268.4), 9);
});

it("drops Scarlet's note on touching staged cuts once the pass's next part decides one of them again", async () => {
  const { base, staged, submit, listed, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 4), staged(4, 6), staged(8, 9)]);
  const notes = [{ index: 0, start: 2, end: 6, verdict: "cut", reason: "Both retakes are clean." }, { index: 1, start: 8, end: 9, verdict: "keep", reason: "The aside lands." }];
  expect((await assess(one.review, notes)).status).toBe(200);
  // Part two decides inside the first of the two again. The note was about both, so the one that is left waits for the editor.
  const two = await submit(base, [staged(2.5, 3)]);
  expect(await listed(two.review)).toEqual([[2.5, 3], [4, 6], [8, 9]]);
  expect(two.review.cutAssessments).toEqual([{ index: 1, start: 4, end: 6, verdict: "ask", provisional: true, reason: "Retake at 4 s." }, { ...notes[1], index: 2 }]);
});

it("drops Scarlet's note on touching staged cuts when the pass's next part decides the second of them again", async () => {
  const { base, staged, submit, listed, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 4), staged(4, 6), staged(8, 9)]);
  const notes = [{ index: 0, start: 2, end: 6, verdict: "cut", reason: "Both retakes are clean." }, { index: 1, start: 8, end: 9, verdict: "keep", reason: "The aside lands." }];
  expect((await assess(one.review, notes)).status).toBe(200);
  const two = await submit(base, [staged(4.5, 5)]);
  expect(await listed(two.review)).toEqual([[2, 4], [4.5, 5], [8, 9]]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 2, end: 4, verdict: "ask", provisional: true, reason: "Retake at 2 s." }, { ...notes[1], index: 2 }]);
  // A temporary note on the surviving footage leaves it available to the pass's next part.
  const three = await submit(base, [staged(4, 6)]);
  expect(await listed(three.review)).toEqual([[2, 6], [8, 9]]);
  expect(three.review.cutAssessments).toEqual([{ index: 0, start: 2, end: 6, verdict: "ask", provisional: true, reason: "Retake at 2 s. Retake at 4 s." }, { ...notes[1], index: 1 }]);
});

it("drops Scarlet's note on touching staged cuts when the pass's next part stages one of them again over the same range", async () => {
  const { base, staged, submit, listed, assess } = dialoguePassInParts();
  const one = await submit(base, [staged(2, 4), staged(4, 6), staged(8, 9)]);
  const notes = [{ index: 0, start: 2, end: 6, verdict: "cut", reason: "Both retakes are clean." }, { index: 1, start: 8, end: 9, verdict: "keep", reason: "The aside lands." }];
  expect((await assess(one.review, notes)).status).toBe(200);
  // The cut still spans what the note did, but one of its two staged cuts is a new decision.
  const two = await submit(base, [{ ...staged(4, 6), reason: "A longer retake." }]);
  expect(await listed(two.review)).toEqual([[2, 6], [8, 9]]);
  expect(two.review.cutAssessments).toEqual([{ index: 0, start: 2, end: 6, verdict: "ask", provisional: true, reason: "Retake at 2 s. A longer retake." }, { ...notes[1], index: 1 }]);
});

it("carries a note saved with its range rounded to five decimals, on the cuts it was about", async () => {
  const { base, staged, submit, listed, assess } = dialoguePassInParts();
  const fps = workspace.ctx.repos.projects.get(project.id)!.settings.fps;
  const frame = (n: number) => n / fps;
  const one = await submit(base, [staged(frame(61), frame(89)), staged(frame(89), frame(121)), staged(frame(250), frame(260))]);
  const rounded = (t: number) => Math.round(t * 1e5) / 1e5;
  const note = { index: 0, start: rounded(frame(61)), end: rounded(frame(121)), verdict: "cut", reason: "Both retakes are clean." };
  expect(note.start).not.toBe(frame(61));
  expect((await assess(one.review, [note])).status).toBe(200);
  const two = await submit(base, [staged(frame(400), frame(410))]);
  expect(await listed(two.review)).toEqual([[frame(61), frame(121)], [frame(250), frame(260)], [frame(400), frame(410)]]);
  expect(two.review.cutAssessments).toEqual([{ ...note, start: frame(61), end: frame(121) }]);
});

it("saves a pass's next part after an applied cut leaves the edit a rounding error shorter than a staged cut's original range", async () => {
  const { ctx } = workspace;
  // Straight cuts: a crossfade's arithmetic on the join leaves the edit a different hair long.
  ctx.repos.settings.update({ dialogue: { crossfadeFrames: 0 } });
  const { base, staged, submit, listed } = dialoguePassInParts();
  const fps = ctx.repos.projects.get(project.id)!.settings.fps;
  const frame = (n: number) => n / fps;
  // A narrowed cut near the end. What Scarlet first proposed there ran to the end of the edit.
  await submit(base, [{ start: frame(560), end: frame(590), review: true, reason: "Trailing chatter.", originalRange: { start: frame(558), end: 20 } }]);
  // Six frames come out near the start. The clips that are left add up to a hair under 594 frames.
  const two = await submit(base, [{ start: frame(10), end: frame(16), review: false, reason: "false start" }]);
  expect(two.changes.map(c => c.state)).toEqual(["approved", "ready"]);
  const head = ctx.repos.projects.get(project.id)!.head!;
  expect(timelineDuration(ctx.repos.versions.get(project.id, head)!.timeline)).toBeLessThan(frame(594));
  expect(two.review.cutReasons).toMatchObject([{ start: frame(554), end: frame(584), originalRange: { start: frame(552), end: frame(594) } }]);
  // The next part still saves, with the staged cut and its original range carried.
  const three = await submit(head, [staged(frame(300), frame(310))]);
  expect(await listed(three.review)).toEqual([[frame(300), frame(310)], [frame(554), frame(584)]]);
  expect(three.review.cutReasons?.at(-1)).toMatchObject({ originalRange: { start: frame(552), end: frame(594) } });
});

it("puts dialogue cuts on whole frames, rounding inward, so the preview after them stays cached", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const fps = ctx.repos.projects.get(project.id)!.settings.fps;
  const res = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Part", cuts: [
    { start: 4.01, end: 5.02, review: true, reason: "edges between frames" }, { start: 9.001, end: 9.02, review: true, reason: "under a frame" }] });
  expect(res.status).toBe(201);
  const [staged] = (await res.json()).changes as Change[];
  const frames = ctx.repos.changes.get(staged!.id)!.cutReasons!.map(r => [r.start * fps, r.end * fps].map(f => Math.round(f * 1000) / 1000));
  expect(frames).toEqual([[Math.ceil(4.01 * fps), Math.floor(5.02 * fps)], [Math.round(9.001 * fps), Math.round(9.02 * fps)]]);
});

it("carries a pass's next part and the editor's reviewed cuts onto an edit that moved meanwhile", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submit = (fromVersion: string, cuts: object[]) => api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion, description: "Part", cuts });
  const [staged] = (await (await submit(base, [{ start: 12, end: 13, review: true, reason: "may be the better take" },
    { start: 15, end: 16, review: true, reason: "repeated aside" }])).json()).changes as Change[];
  // Meanwhile the editor trims the opening themselves.
  const edit = (start: number, end: number) => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true,
    description: "Trim", ops: [{ op: "rippleDelete", start, end }] }).change;
  expect(edit(2, 4).state).toBe("approved");
  // A cut over the footage the editor removed has to be mapped again; one clear of it moves onto the current edit.
  expect((await submit(base, [{ start: 3, end: 5, review: false, reason: "false start" }])).status).toBe(409);
  const two = await submit(base, [{ start: 6, end: 7, review: false, reason: "false start" }]);
  expect(two.status).toBe(201);
  const [cut, review] = (await two.json()).changes as Change[];
  expect(cut!.state).toBe("approved");
  const pending = ctx.repos.changes.get(review!.id)!;
  expect(pending.cutReasons?.map(({ start, end }) => [start, end])).toEqual([[9, 10], [12, 13]]);
  expect(ctx.repos.changes.get(staged!.id)!.state).toBe("rejected");
  expect((await api("POST", `/changes/${pending.id}/cut-assessments`, { fromVersion: pending.fromVersion, toVersion: pending.toVersion,
    assessments: [{ index: 0, start: 9, end: 10, verdict: "ask", reason: "Both takes land." }] })).status).toBe(200);
  await checkPassAudio(task.id);
  await api("POST", `/tasks/${task.id}/complete`, { state: "done", summary: "Done." });

  // The editor trims again before applying the review. Their calls carry onto the current edit.
  edit(0, 1);
  const approved = await api("POST", `/changes/${pending.id}/approve`, { restoredCuts: [0] });
  expect(approved.status).toBe(200);
  const result = await approved.json();
  expect(result.outcome).toBe("rebased");
  expect(result.change.appliedReview).toMatchObject({ originalVersion: result.change.appliedOnto, joins: [{ reviewIndex: 1 }] });
  const head = ctx.repos.projects.get(project.id)!.head!;
  // 20 s less the editor's 3 s, the agent's 1 s and the one cut the editor kept out.
  expect(timelineDuration(ctx.repos.versions.get(project.id, head)!.timeline)).toBeCloseTo(15);
});

it("lists only the cuts that went in when a pass with a skipped call is applied onto an edit that moved", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, listed } = dialoguePassInParts();
  // Two of the pass's staged cuts touch, so its review counts them as one call.
  const { review: pass } = await submit(base, [staged(2, 3), staged(3, 4), staged(8, 9), staged(12, 13)]);
  expect(await listed(pass)).toEqual([[2, 4], [8, 9], [12, 13]]);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  // The editor trims the end themselves, then applies the pass and skips its first call.
  expect(proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Trim",
    ops: [{ op: "rippleDelete", start: 18, end: 20 }] }).change.state).toBe("approved");
  const approved = await (await api("POST", `/changes/${pass.id}/approve`, { restoredCuts: [0] })).json();
  expect(approved).toMatchObject({ outcome: "rebased", change: { restoredCuts: [0] } });
  // The skipped call's footage is still in the video. The pass's edits are the two cuts that came out, each with its own reason.
  const { edits } = await (await api("GET", `${projectsPath()}/threads/${task.id}/edits`)).json() as
    { edits: Array<{ changeId: string; label: string; at?: number; beforeCut?: { removed: unknown } }> };
  expect(edits.filter(e => e.changeId === pass.id).map(e => [e.label, e.at, e.beforeCut?.removed])).toEqual([
    ["Retake at 8 s.", 8, { start: 8, end: 9 }], ["Retake at 12 s.", 11, { start: 12, end: 13 }]]);
});

it.each(["applied from its line", "applied when Scarlet finished"] as const)("applies the surviving footage of a pass %s when a manual trim shortened its cuts", async how => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose, assess } = dialoguePassInParts();
  // Three staged cuts. Scarlet checks the first and second itself and asks about the third: that one is the pass's
  // only call, "Cut 1". The second is a cut Scarlet settled, which the editor never sees as a call.
  const { review: pass } = await submit(base, [staged(2, 3), staged(6, 7), staged(10, 11)]);
  expect((await assess(pass, [{ index: 0, start: 2, end: 3, verdict: "cut", reason: "False start." },
    { index: 1, start: 6, end: 7, verdict: "cut", reason: "Repeated aside." }, { index: 2, start: 10, end: 11, verdict: "ask", reason: "Both takes land." }])).status).toBe(200);
  const scheduled = how === "applied when Scarlet finished";
  // The editor approves the call. Scheduled, the pass applies as Scarlet finishes; otherwise from its line once Scarlet has.
  expect((await choose(pass, [{ index: 2, choice: "cut" }], scheduled || undefined)).status).toBe(200);
  const finish = async () => {
    await checkPassAudio(task.id);
    expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  };
  if (!scheduled) await finish();
  // Meanwhile the editor trims inside the footage two of the pass's cuts take out: the call's, then Scarlet's own.
  const trim = (start: number, end: number) => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true,
    description: "Trim", ops: [{ op: "rippleDelete", start, end }] }).change;
  trim(10.3, 10.6);
  trim(6.2, 6.4);
  if (scheduled) await finish();
  else expect((await api("POST", `/changes/${pass.id}/approve`, { restoredCuts: [] })).status).toBe(200);
  const approved = ctx.repos.changes.get(pass.id)!;
  expect(approved).toMatchObject({ state: "approved", cutChoices: [{ index: 2, choice: "cut" }] });
  expect(approved.appliedReview?.joins).toHaveLength(3);
  const timeline = ctx.repos.versions.get(project.id, approved.appliedVersion!)!.timeline;
  expect(straightCuts(timeline.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([
    { sourceIn: 0, sourceOut: 2 }, { sourceIn: 3, sourceOut: 6 }, { sourceIn: 7, sourceOut: 10 }, { sourceIn: 11, sourceOut: 20 }]);
});

it.each(["as it was staged", "onto an edit that moved"] as const)("undoes an edit made before a pass that was applied %s with a call skipped, and keeps the cut the pass made", async how => {
  const { ctx } = workspace;
  const { task, staged, submit } = dialoguePassInParts();
  const trim = (start: number, end: number) => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true,
    description: "Trim", ops: [{ op: "rippleDelete", start, end }] }).change;
  // The editor trims the opening themselves. A pass then stages two cuts on that edit.
  const opening = trim(0, 1);
  expect(ctx.repos.projects.get(project.id)!.head).toBe(opening.toVersion);
  const { review: pass } = await submit(opening.toVersion, [staged(5, 6), staged(10, 11)]);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  // In one case they trim the ending too before they apply the pass. In both they skip its first call.
  const moved = how === "onto an edit that moved";
  if (moved) trim(17, 19);
  const applied = await (await api("POST", `/changes/${pass.id}/approve`, { restoredCuts: [0] })).json();
  expect(applied).toMatchObject({ outcome: moved ? "rebased" : "applied", change: { restoredCuts: [0] } });
  // Undoing the first trim puts the opening back under the pass. The cut that went in stays out, and the skipped call stays in.
  const undone = await api("POST", `${projectsPath()}/versions/${opening.toVersion}/revert`, { expectedHead: applied.project.head, branch: "main" });
  expect(await undone.json()).toMatchObject({ change: { revertsVersion: opening.toVersion } });
  const head = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(head.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([{ sourceIn: 0, sourceOut: 11 }, { sourceIn: 12, sourceOut: moved ? 18 : 20 }]);
});

it("resumes a pass interrupted by quitting ahead of a queued revision, and the resumed run carries its staged cuts", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const host = (await (await api("POST", "/hosts/register", { name: "Test", platform: "test", agents: [{ id: "codex", installed: true }] })).json()).host;
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, {})).json()).task as Task | null;
  const author = { type: "human" as const, name: "Editor" };
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: author });
  expect((await claim())?.id).toBe(pass.id);
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submit = async (taskId: string, cuts: object[]) => {
    const res = await api("POST", projectsPath() + "/dialogue-cuts", { taskId, fromVersion: base, description: "Part", cuts });
    expect(res.status).toBe(201);
    return await res.json() as { changes: Change[]; carriedForward?: number };
  };
  const [staged] = (await submit(pass.id, [{ start: 12, end: 13, review: true, reason: "First retake." }, { start: 15, end: 16, review: true, reason: "Second retake." }])).changes;
  expect((await api("PUT", `/changes/${staged!.id}/cut-choices`, { fromVersion: staged!.fromVersion, toVersion: staged!.toVersion,
    choices: [{ index: 0, choice: "cut" }] })).status).toBe(200);
  // The editor sends one cut back while the pass still runs, then quits Scarlet.
  const revision = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Left in an extra “I”", createdBy: author,
    context: { threadId: pass.id, changeId: staged!.id, cutIndex: 1 } });
  expect((await api("POST", `/tasks/${pass.id}/complete`, { state: "cancelled", interrupted: true })).status).toBe(200);
  const interrupted = ctx.repos.tasks.get(pass.id)!;
  expect(interrupted).toMatchObject({ state: "failed", interrupted: true });
  // The pass carries on first: the revision was asked of a pass that hadn't finished.
  const resumed = await claim();
  expect(resumed).toMatchObject({ id: interrupted.retryTaskId, resumeRootId: pass.id });
  expect(ctx.repos.tasks.get(revision.id)?.state).toBe("queued");
  const two = await submit(resumed!.id, [{ start: 2, end: 4, review: false, reason: "false start" }]);
  expect(two.carriedForward).toBe(2);
  const review = ctx.repos.changes.get(two.changes[1]!.id)!;
  expect(review).toMatchObject({ state: "ready", taskId: resumed!.id, cutChoices: [{ index: 0, start: 10, end: 11, choice: "cut" }] });
  expect(review.cutReasons).toEqual([{ start: 10, end: 11, reason: "First retake." }, { start: 13, end: 14, reason: "Second retake." }]);
  expect(ctx.repos.changes.get(staged!.id)).toMatchObject({ state: "rejected", replacedBy: review.id });
  await checkPassAudio(resumed!.id);
  expect((await api("POST", `/tasks/${resumed!.id}/complete`, { state: "done" })).status).toBe(200);
  // Then the revision runs, and its version of the pass replaces the one it revised.
  expect((await claim())?.id).toBe(revision.id);
  const moved = await api("POST", `/changes/${review.id}/staged-cuts/1`, { taskId: revision.id, start: 12.5, end: 14, reason: "Starts before the “I”." });
  expect(moved.status).toBe(201);
  const { change } = await moved.json() as { change: Change };
  expect(ctx.repos.changes.get(review.id)).toMatchObject({ state: "rejected", replacedBy: change.id });
  expect(ctx.repos.changes.select("project_id = ? AND state = 'ready'", [project.id]).map(c => c.id)).toEqual([change.id]);
});

it("removes day-old working files a killed engine left behind, and nothing newer or still in use", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "med_kept", name: "Interview", path: "med_kept.wav", kind: "audio" }, "ready");
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const files = {
    tmp: join(ctx.paths.tmp, "recording_0123456789ab.wav"),
    freshTmp: join(ctx.paths.tmp, "recording_0123456789cd.wav"),
    part: join(ctx.paths.media(project.id), ".med_dl.part"),
    orphan: join(ctx.paths.media(project.id), "med_orphan.mov"),
    original: join(ctx.paths.media(project.id), media.path),
    proxyPart: join(ctx.paths.proxies(project.id), "med_kept.part.mp4"),
    proxy: join(ctx.paths.proxies(project.id), "med_kept.mp4"),
    segmentPart: join(ctx.paths.segments(project.id), "abc.part.m4a"),
  };
  for (const file of Object.values(files)) writeFileSync(file, "x");
  for (const [name, file] of Object.entries(files)) if (name !== "freshTmp") utimesSync(file, old, old);
  await ctx.close();
  workspace = openWorkspace();
  expect(Object.fromEntries(Object.entries(files).map(([name, file]) => [name, existsSync(file)]))).toEqual({
    tmp: false, freshTmp: true, part: false, orphan: false, original: true, proxyPart: false, proxy: true, segmentPart: false });
});

it("carries a run's CLI session to the attempt that resumes it after a quit, and starts cold when the host no longer has it", async () => {
  const { ctx } = workspace;
  const host = (await (await api("POST", "/hosts/register", { name: "Test", platform: "test", agents: [{ id: "claude", installed: true }] })).json()).host;
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, {})).json()).task as Task | null;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Tighten the intro", createdBy: { type: "human", name: "Editor" } });
  const startedAt = (await claim())!.startedAt;
  expect((await api("POST", `/tasks/${task.id}/events`, { startedAt, type: "log", text: "Claude Code session started", data: { kind: "init", sessionId: "session-1" } })).status).toBeLessThan(300);
  expect(ctx.repos.tasks.get(task.id)?.session).toEqual({ agent: "claude", id: "session-1" });
  // A run that wasn't interrupted starts its own session.
  expect((await (await api("GET", `/tasks/${task.id}/prompt`)).json()).resumeSession).toBeUndefined();
  const steps = [{ text: "Find the slow opening", state: "done" }, { text: "Trim it", state: "in_progress" }, { text: "Check the join", state: "pending" }];
  expect((await api("POST", `/tasks/${task.id}/events`, { startedAt, type: "plan", text: "", data: { steps } })).status).toBeLessThan(300);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "cancelled", interrupted: true })).status).toBe(200);
  const resumed = await claim();
  expect(resumed).toMatchObject({ resumeRootId: task.id, session: { agent: "claude", id: "session-1" } });
  // The plan it was working to is on the new attempt as it stood, before the session says anything.
  expect(taskPlan(ctx.repos.taskEvents.list(resumed!.id))).toEqual(steps);
  // Resumed by the editor on another model, it starts a session of its own.
  const other = createTask(ctx, { projectId: project.id, kind: "edit", agent: "claude", instruction: "Trim the outro", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.tasks.put({ ...ctx.repos.tasks.get(other.id)!, state: "cancelled", interrupted: true, session: { agent: "claude", id: "session-2" } });
  const moved = (await (await api("POST", `/tasks/${other.id}/retry`, { agent: "claude", model: "opus" })).json()).task as Task;
  expect(moved).toMatchObject({ resumeRootId: other.id, model: "opus" });
  expect(moved.session).toBeUndefined();
  await api("POST", `/tasks/${moved.id}/cancel`, {});
  const prompt = await (await api("GET", `/tasks/${resumed!.id}/prompt`)).json();
  expect(prompt.resumeSession).toBe("session-1");
  expect(prompt.instruction).toMatch(/^Scarlet closed while you were working/);
  // The host found no such session: the full recap goes to a fresh one.
  const fresh = await (await api("GET", `/tasks/${resumed!.id}/prompt?fresh=1`)).json();
  expect(fresh.resumeSession).toBeUndefined();
  expect(fresh.instruction).toContain("Tighten the intro");
  expect(fresh.instruction).toContain("Resume this interrupted request.");
  expect(fresh.instruction).toContain("Your plan when it stopped:\n[x] Find the slow opening\n[>] Trim it\n[ ] Check the join");
  // A run the editor stopped doesn't keep its session.
  await api("POST", `/tasks/${resumed!.id}/cancel`, {});
  const again = (await (await api("POST", `/tasks/${resumed!.id}/retry`)).json()).task as Task;
  expect(again.session).toBeUndefined();
});

it("holds a pass's apply-when-done through the run that resumes it after a quit, and applies it when that run finishes", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const host = (await (await api("POST", "/hosts/register", { name: "Test", platform: "test", agents: [{ id: "codex", installed: true }] })).json()).host;
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, {})).json()).task as Task | null;
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  await claim();
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submitted = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Part",
    cuts: [{ start: 12, end: 13, review: true, reason: "First retake." }, { start: 15, end: 16, review: true, reason: "Second retake." }] });
  const [staged] = (await submitted.json()).changes as Change[];
  const choose = (body: object) => api("PUT", `/changes/${staged!.id}/cut-choices`, { fromVersion: staged!.fromVersion, toVersion: staged!.toVersion, ...body });
  expect((await choose({ choices: [{ index: 0, choice: "cut" }], applyWhenDone: true })).status).toBe(200);
  // Scarlet quits. The pass carries on under a new task, and the calls keep waiting for it.
  expect((await api("POST", `/tasks/${pass.id}/complete`, { state: "cancelled", interrupted: true })).status).toBe(200);
  const resumed = await claim();
  expect(resumed?.resumeRootId).toBe(pass.id);
  expect((await choose({ choices: [{ index: 0, choice: "cut" }, { index: 1, choice: "keep" }] })).status).toBe(200);
  expect(ctx.repos.changes.get(staged!.id)).toMatchObject({ state: "ready", applyWhenDone: { userId: localUser(ctx).id } });
  // The resumed run finds nothing more to cut. The pass applies with the editor's calls all the same.
  expect((await api("POST", `/tasks/${resumed!.id}/complete`, { state: "done" })).status).toBe(200);
  const applied = ctx.repos.changes.get(staged!.id)!;
  expect(applied.state).toBe("approved");
  expect(ctx.repos.projects.get(project.id)!.head).toBe(applied.appliedVersion ?? applied.toVersion);
});

it("takes a pass off apply-when-done when Scarlet then asks about a cut the editor hasn't called", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const host = (await (await api("POST", "/hosts/register", { name: "Test", platform: "test", agents: [{ id: "codex", installed: true }] })).json()).host;
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  await api("POST", `/hosts/${host.id}/claim`, {});
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submitted = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Part",
    cuts: [{ start: 12, end: 13, review: true, reason: "First retake." }, { start: 15, end: 16, review: true, reason: "Second retake." }] });
  const [staged] = (await submitted.json()).changes as Change[];
  const versions = { fromVersion: staged!.fromVersion, toVersion: staged!.toVersion };
  const assess = (index: number, start: number, reason: string) => api("POST", `/changes/${staged!.id}/cut-assessments`,
    { ...versions, assessments: [{ index, start, end: start + 1, verdict: "ask", reason }] });
  // The editor made the one call there was and set the pass to apply when Scarlet finishes.
  expect((await api("PUT", `/changes/${staged!.id}/cut-choices`, { ...versions, choices: [{ index: 0, choice: "cut" }], applyWhenDone: true })).status).toBe(200);
  // Scarlet asks about the cut they called. Their call stands, and so does the schedule.
  expect((await assess(0, 12, "First retake.")).status).toBe(200);
  expect(ctx.repos.changes.get(staged!.id)?.applyWhenDone).toBeDefined();
  // Then it asks about one they never saw. Applying on schedule would skip it unseen, so the pass waits for them.
  expect((await assess(1, 15, "Second retake.")).status).toBe(200);
  expect(ctx.repos.changes.get(staged!.id)?.applyWhenDone).toBeUndefined();
  await checkPassAudio(pass.id);
  expect((await api("POST", `/tasks/${pass.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(staged!.id)?.state).toBe("ready");
});

it("takes a pass off apply-when-done when the editor sends one of its calls back, so it waits for the revised cut", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const host = (await (await api("POST", "/hosts/register", { name: "Test", platform: "test", agents: [{ id: "codex", installed: true }] })).json()).host;
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, {})).json()).task as Task | null;
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  expect((await claim())?.id).toBe(pass.id);
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submitted = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Part",
    cuts: [{ start: 12, end: 13, review: true, reason: "First retake." }, { start: 15, end: 16, review: true, reason: "Second retake." }] });
  const [staged] = (await submitted.json()).changes as Change[];
  /** The editor's last call on a pass Scarlet still works on, which sets it to apply when Scarlet finishes. */
  const schedule = (change: Change) => api("PUT", `/changes/${change.id}/cut-choices`, { fromVersion: change.fromVersion, toVersion: change.toVersion,
    choices: [{ index: 0, choice: "cut" }, { index: 1, choice: "cut" }], applyWhenDone: true });
  /** A request about the pass's second cut, as the message box sends it while the pass's thread is still at work. */
  const sendBack = async (change: Change, text: string) => {
    const sent = await api("POST", projectsPath() + "/tasks", { kind: "edit", agent: "codex", instruction: text,
      context: { threadId: pass.id, changeId: change.id, version: change.fromVersion, time: 15, end: 16, clipIds: [], cutIndex: 1 } });
    expect(sent.status).toBe(201);
    return (await sent.json()).task as Task;
  };
  expect((await schedule(staged!)).status).toBe(200);
  const told: Array<[string, boolean]> = [];
  ctx.bus.on("ws", event => { if (event.type === "change.updated") told.push([event.change.id, !!event.change.applyWhenDone]); });
  // With the pass scheduled, the editor sends its second call back. The request waits behind the run.
  const first = await sendBack(staged!, "Ends too early");
  // The run finishes. Applied on schedule, the pass would go in with the old cut and leave the request nothing to move.
  await checkPassAudio(pass.id);
  expect((await api("POST", `/tasks/${pass.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(staged!.id)).toMatchObject({ state: "ready" });
  expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
  // The chat's line for the pass heard that it no longer applies by itself.
  expect(told).toEqual([[staged!.id, false]]);
  expect((await claim())?.id).toBe(first.id);
  const moved = await api("POST", `/changes/${staged!.id}/staged-cuts/1`, { taskId: first.id, start: 15, end: 16.5, reason: "Ends after the breath." });
  expect(moved.status).toBe(201);
  const revised = (await moved.json()).change as Change;
  expect(revised.cutReasons).toEqual([{ start: 12, end: 13, reason: "First retake." }, { start: 15, end: 16.5, reason: "Ends after the breath." }]);

  // While that request still checks its cut, the editor calls it, which schedules the revised pass, then sends the cut
  // back once more in a message that names the pass as it was. The pass that waits now is the one held.
  expect((await schedule(revised)).status).toBe(200);
  expect(ctx.repos.changes.get(revised.id)?.applyWhenDone).toBeDefined();
  const second = await sendBack(staged!, "Still clips the breath");
  expect(ctx.repos.changes.get(revised.id)?.applyWhenDone).toBeUndefined();
  expect((await api("POST", `/tasks/${first.id}/complete`, { state: "done" })).status).toBe(200);
  expect(ctx.repos.changes.get(revised.id)).toMatchObject({ state: "ready" });
  expect((await claim())?.id).toBe(second.id);
  expect((await api("POST", `/changes/${staged!.id}/staged-cuts/1`, { taskId: second.id, start: 15, end: 17, reason: "Ends after the breath is out." })).status).toBe(201);
  expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
});

it("keeps two cuts that meet at one instant meeting once they are on whole frames", async () => {
  const { ctx } = workspace;
  const { base, submit, listed } = dialoguePassInParts();
  const fps = ctx.repos.projects.get(project.id)!.settings.fps;
  // A retake ends and a pause starts at 8.35 s, half way between frames 250 and 251. Rounded inward each, the retake
  // would end on 250 and the pause start on 251, leaving a frame nobody chose to keep. They meet on frame 251 instead,
  // so the editor is shown one removal. The second pair meets at 12.333 s, which is frame 370 given to the millisecond.
  const staged = (start: number, end: number) => ({ start, end, review: true, reason: "Retake." });
  const one = await submit(base, [staged(7, 8.35), staged(8.35, 9), staged(12, 12.333), staged(12.333, 13)]);
  expect(await listed(one.review)).toEqual([[7, 9], [12, 13]]);
  expect(one.review.cutReasons!.map(r => [r.start, r.end])).toEqual([[7, 251 / fps], [251 / fps, 9], [12, 370 / fps], [370 / fps, 13]]);
});

it("saves a removal that meets a staged cut between two frames, holding the staged cut's original range beside it", async () => {
  const { ctx } = workspace;
  const { base, task } = dialoguePassInParts();
  const fps = ctx.repos.projects.get(project.id)!.settings.fps;
  // Production talk ends and a stray word starts at 5.46 s, between frames 163 and 164. The word's cut is staged with
  // the range the editor can restore. The removal's end goes to frame 164, 6.7 ms into that range as it was given.
  const plan = (originalRange: { start: number; end: number }) => api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base,
    description: "Part", cuts: [{ start: 2, end: 5.46, review: false, reason: "Production talk." },
      { start: 5.46, end: 5.9, review: true, reason: "Stray word.", originalRange }] });
  const saved = await plan({ start: 5.46, end: 5.96 });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const changes = (await saved.json()).changes as Change[];
  const applied = changes.find(c => c.intent !== "suggestion")!;
  const { timeline } = await (await api("GET", projectsPath() + "/timeline?version=" + applied.toVersion)).json();
  expect((timeline.tracks as Array<{ clips: Array<{ timelineIn: number; sourceIn: number; sourceOut: number }> }>)
    .flatMap(t => t.clips.map(c => [c.timelineIn, c.sourceIn, c.sourceOut]))).toEqual([[0, 0, 2], [2, 164 / fps, 20]]);
  // A range that reaches well into the removal is still refused.
  const { project: fresh } = await (await api("GET", projectsPath())).json();
  expect(fresh.head).toBe(applied.toVersion);
  const refused = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: applied.toVersion, description: "Part",
    cuts: [{ start: 6, end: 7, review: false, reason: "Production talk." }, { start: 7, end: 7.5, review: true, reason: "Stray word.", originalRange: { start: 6.5, end: 7.5 } }] });
  expect(refused.status).toBe(400);
});

it("preserves picture between a new cut and the join made by an earlier part", async () => {
  const { ctx } = workspace;
  const { base, task } = dialoguePassInParts();
  const fps = ctx.repos.projects.get(project.id)!.settings.fps;
  /** Apply one cut and return the version it made, with that version's clips as [timeline start, source start, source end]. */
  const cut = async (fromVersion: string, start: number, end: number) => {
    const res = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion, description: "Part",
      cuts: [{ start, end, review: false, reason: "Stray word." }] });
    expect(res.status).toBe(201);
    const version = ((await res.json()).changes as Change[])[0]!.toVersion;
    const { timeline } = await (await api("GET", projectsPath() + "/timeline?version=" + version)).json();
    // Each join has Scarlet's crossfade: its clips are read as the straight cut it smooths.
    const clips = (timeline.tracks as Array<{ clips: Clip[] }>)
      .flatMap(t => straightCuts(t.clips).map(c => [c.timelineIn, c.kind === "media" ? c.sourceIn : 0, c.kind === "media" ? c.sourceOut : 0]));
    return { version, clips };
  };
  // The first part removes 5 to 8 s, which leaves a join at 5 s.
  const one = await cut(base, 5, 8);
  expect(one.clips).toEqual([[0, 0, 5], [5, 8, 20]]);
  // A stray word starts 10 ms past that join. The next whole frame starts the new removal.
  const two = await cut(one.version, 5.01, 5.5);
  expect(two.clips).toHaveLength(3);
  expect(two.clips[0]).toEqual([0, 0, 5]);
  expect(two.clips[1]![1]).toBeCloseTo(8, 9);
  expect(two.clips[1]![2]).toBeCloseTo(8 + 1 / fps, 9);
  expect(two.clips[2]![1]).toBeCloseTo(8.5, 9);
});

it("keeps selected and protected sub-frame boundaries intact in persisted dialogue removals", async () => {
  const { base, task } = dialoguePassInParts();
  const range = { start: 5.0005, end: 10.9995 };
  const kept = [{ start: 6.9995, end: 7.0005 }];
  const crossing = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Trim pauses", range, kept,
    cuts: [{ start: 7.2, end: 8, originalRange: { start: 6.99, end: 8 }, kind: "pause", review: true, reason: "Check the edge." }] });
  expect(crossing.status).toBe(400);
  expect(workspace.ctx.repos.projects.get(project.id)!.head).toBe(base);
  const plan = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Trim pauses", range, kept,
    cuts: [{ start: range.start, end: kept[0]!.start, kind: "pause", review: false, reason: "Trim air." },
      { start: kept[0]!.end, end: range.end, kind: "pause", review: false, reason: "Trim air." }] });
  expect(plan.status, await plan.clone().text()).toBe(201);
  const changes = (await plan.json()).changes as Change[];
  const intervals = changes.flatMap(c => workspace.ctx.repos.changes.get(c.id)!.ops.filter(op => op.op === "rippleDelete")).sort((a, b) => a.start - b.start);
  expect(intervals.map(r => [r.start, r.end])).toEqual([[151 / 30, 209 / 30], [211 / 30, 329 / 30]]);
});

it("puts an agent's ripple removals on whole frames and leaves the editor's as given", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Cut the stumbles", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 12.01, hasAudio: true }, "ready");
  const assemble = { op: "addClip" as const, trackId: "a1", clip: { id: "raw", kind: "media" as const, mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 12.01 } };
  proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble", ops: [assemble] });
  // At 30 fps: 2.013 s is past frame 60 and 3.387 s is short of frame 102, so the removal is frames 61 to 101.
  // The last removal runs to the end of the edit, which is on no frame, and keeps that end.
  const cut = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Stumbles",
    ops: [{ op: "rippleDelete", start: 8.013, end: 12.01 }, { op: "rippleDelete", start: 2.013, end: 3.387 }] });
  expect(cut.change.ops).toEqual([{ op: "rippleDelete", start: 241 / 30, end: 12.01 }, { op: "rippleDelete", start: 61 / 30, end: 101 / 30 }]);
  expect(cut.duration).toBeCloseTo(241 / 30 - 40 / 30, 9);
  // The editor's own cut is theirs to place.
  const own = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Trim",
    ops: [{ op: "rippleDelete", start: 1.013, end: 1.387 }] });
  expect(own.change.ops).toEqual([{ op: "rippleDelete", start: 1.013, end: 1.387 }]);
});

it("reads an agent's time within a millisecond of a frame as that frame, so later clips stay on the frames", async () => {
  const { ctx } = workspace;
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Put the line back", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 60, hasAudio: true }, "ready");
  proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble", ops: [
    { op: "addClip", trackId: "a1", clip: { id: "one", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } },
    { op: "addClip", trackId: "a1", clip: { id: "two", kind: "media", mediaId: "mic", timelineIn: 20, sourceIn: 30, sourceOut: 50 } }] });
  // Frame 263 is 8.76666… s and 167 frames are 5.56666… s; a tool prints them as 8.7667 and 5.5667.
  const put = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Put the line back", ops: [
    { op: "rippleInsertGap", at: 8.7667, duration: 5.5667 },
    { op: "addClip", trackId: "a1", clip: { id: "line", kind: "media", mediaId: "mic", timelineIn: 8.7667, sourceIn: 52.1333, sourceOut: 57.7 } },
    // A time that is on no frame stays as given.
    { op: "addMarker", marker: { id: "note", time: 3.64, kind: "note", text: "Sync offset" } }] });
  const edges = put.timeline.tracks.flatMap(t => t.clips).flatMap(c => [c.timelineIn, clipEnd(c)]);
  for (const edge of edges) expect(Math.abs(edge * 30 - Math.round(edge * 30))).toBeLessThan(1e-6);
  expect(put.timeline.tracks.flatMap(t => t.clips).every(c => clipEnd(c) - c.timelineIn > 0.01)).toBe(true);
  expect(put.change.ops![0]).toEqual({ op: "rippleInsertGap", at: 263 / 30, duration: 167 / 30 });
});

it("moves one staged cut of a pending pass past its old edges and keeps the other cuts and their calls", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const author = { type: "human" as const, name: "Editor" };
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: author });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submitted = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Pass", cuts: [
    { start: 2, end: 3, review: true, reason: "First retake." }, { start: 6, end: 8, review: true, reason: "Second retake." },
    { start: 12, end: 13, review: true, reason: "Third retake." }] });
  const pass = ((await submitted.json()).changes as Change[]).find(c => c.intent === "suggestion")!;
  // The whole plan is staged, so the agent's own sentence describes it.
  expect(pass.description).toBe("Pass");
  const calls = [{ index: 0, start: 2, end: 3, verdict: "keep", reason: "Keep it." }, { index: 1, start: 6, end: 8, verdict: "ask", reason: "Check the “I”." },
    { index: 2, start: 12, end: 13, verdict: "cut", reason: "Clean." }].map(a => ({ ...a, inspected: true }));
  expect((await api("POST", `/changes/${pass.id}/cut-assessments`, { fromVersion: pass.fromVersion, toVersion: pass.toVersion, assessments: calls })).status).toBe(200);
  const revise = await api("POST", `/changes/${pass.id}/revise`, { text: "I say “I” before and after the cut. Remove the one before.",
    position: { version: pass.fromVersion, time: 6, end: 8, clipIds: [], cutIndex: 1 } });
  const { task: revision } = await revise.json();
  expect(ctx.repos.changes.get(pass.id)!.state).toBe("revising");
  // The editor keeps calling the other cuts while this one is revised.
  const chosen = await api("PUT", `/changes/${pass.id}/cut-choices`, { fromVersion: pass.fromVersion, toVersion: pass.toVersion,
    choices: [{ index: 0, choice: "cut" }, { index: 1, choice: "keep" }] });
  expect(chosen.status).toBe(200);

  const move = (start: number, end = 8) => api("POST", `/changes/${pass.id}/staged-cuts/1`, { taskId: revision.id, start, end,
    reason: "Starts in the pause before the first “I”." });
  // Clear of its neighbors only. The previous cut ends at 3 s.
  expect((await move(2.9)).status).toBe(400);
  // A range between two frames is saved on whole frames, edges inward: 5.487 s is past frame 164, so the cut starts on 165.
  const moved = await move(5.487, 8.01);
  expect(moved.status).toBe(201);
  const { change } = await moved.json() as { change: Change };
  expect(change.id).toMatch(/^chg_[a-f0-9]{64}_review$/);
  expect(change).toMatchObject({ intent: "suggestion", state: "ready", fromVersion: pass.fromVersion, taskId: revision.id, description: pass.description });
  expect(change.cutReasons).toEqual([{ start: 2, end: 3, reason: "First retake." }, { start: 5.5, end: 8, reason: "Starts in the pause before the first “I”." },
    { start: 12, end: 13, reason: "Third retake." }]);
  // The editor's other calls carry over. The moved cut waits for a new call.
  expect(change.cutAssessments).toEqual([calls[0], { index: 1, start: 5.5, end: 8, verdict: "ask", reason: "Starts in the pause before the first “I”.", revised: true, askOrder: 1 }, calls[2]]);
  // Later recommendations preserve the revised call and its note. Only the engine can mark a revision.
  const assess = async (on: Change, assessments: object[]) => {
    const res = await api("POST", `/changes/${on.id}/cut-assessments`, { fromVersion: on.fromVersion, toVersion: on.toVersion, assessments });
    expect(res.status).toBe(200);
    return await res.json() as { needsDecision: number; heldRevised?: number[]; editorRequest?: string };
  };
  const held = await assess(change, [{ index: 1, start: 5.5, end: 8, verdict: "cut", reason: "Clean now.", inspected: true },
    { index: 2, start: 12, end: 13, verdict: "cut", reason: "Still clean.", inspected: true, revised: true }]);
  expect(held).toMatchObject({ heldRevised: [1], editorRequest: expect.stringContaining("sent these cuts back") });
  expect(ctx.repos.changes.get(change.id)!.cutAssessments!.slice(1)).toEqual([
    { index: 1, start: 5.5, end: 8, verdict: "ask", reason: "Starts in the pause before the first “I”.", revised: true, askOrder: 1 },
    { index: 2, start: 12, end: 13, verdict: "cut", reason: "Still clean.", inspected: true }]);
  // A repeated ask with different wording also leaves the published revision alone.
  expect((await assess(change, [{ index: 1, start: 5.5, end: 8, verdict: "ask", reason: "Check the “I”.", inspected: true }])).heldRevised).toBeUndefined();
  expect((await assess(change, [{ index: 1, start: 5.5, end: 8, verdict: "keep", reason: "Leave it in.", inspected: true }])).heldRevised).toEqual([1]);
  // So do the calls made meanwhile, except the one on the revised cut.
  expect(change.cutChoices).toEqual([{ index: 0, start: 2, end: 3, choice: "cut" }]);
  const review = await (await api("POST", `/changes/${change.id}/cut-review`, {})).json();
  expect(review.review.cuts.map((c: { removed: unknown }) => c.removed)).toEqual([{ start: 2, end: 3 }, { start: 5.5, end: 8 }, { start: 12, end: 13 }]);
  expect((await (await move(5.5)).json()).change.id).toBe(change.id);
  // Another attempt from the same run replaces the first, so one pass waits.
  const again = (await (await move(5.4)).json()).change as Change;
  expect(again.id).not.toBe(change.id);
  expect(ctx.repos.changes.get(change.id)!.state).toBe("rejected");
  expect(ctx.repos.changes.get(again.id)!.state).toBe("ready");
  const firstBoundary = (await (await move(5.5)).json()).change as Change;
  expect(firstBoundary.id).not.toBe(change.id);
  expect(firstBoundary.cutReasons?.[1]?.start).toBe(5.5);
  expect(ctx.repos.changes.get(again.id)!.state).toBe("rejected");
  expect((await (await move(5.5)).json()).change.id).toBe(firstBoundary.id);
  expect(ctx.repos.projects.get(project.id)!.head).toBe(pass.fromVersion);
  // A cut the pass moves by itself is still the pass's to check: its verdict settles it.
  const own = (await (await api("POST", `/changes/${again.id}/staged-cuts/2`, { taskId: task.id, start: 12, end: 13.5, reason: "Ends after the breath." })).json()).change as Change;
  expect(own.cutAssessments!.map(a => [a.index, a.verdict, a.revised, a.provisional])).toEqual([
    [0, "keep", undefined, undefined], [1, "ask", true, undefined], [2, "ask", undefined, true],
  ]);
  expect((await assess(own, [{ index: 2, start: 12, end: 13.5, verdict: "cut", reason: "Clean.", inspected: true }])).heldRevised).toBeUndefined();
  expect(ctx.repos.changes.get(own.id)!.cutAssessments!.map(a => a.verdict)).toEqual(["keep", "ask", "cut"]);
});

it.each(["revise", "edit"] as const)("makes a staged cut's move again when its run goes back to a range it gave before, so the latest call is the one that waits (%s request)", async kind => {
  const { ctx } = workspace;
  const { task, base, staged, submit } = dialoguePassInParts();
  const { review: pass } = await submit(base, [staged(2, 3), staged(6, 8), staged(12, 13)]);
  // The cut is sent back from its card, or in a request that waits behind the pass's run.
  const revision = kind === "revise"
    ? (await (await api("POST", `/changes/${pass.id}/revise`, { text: "Remove the “I” before the cut.",
      position: { version: pass.fromVersion, time: 6, end: 8, clipIds: [], cutIndex: 1 } })).json()).task as Task
    : createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Remove the “I” before the cut.", createdBy: { type: "human", name: "Editor" },
      context: { threadId: task.id, changeId: pass.id, cutIndex: 1, time: 6, end: 8 } });
  const move = async (start: number) => {
    const moved = await api("POST", `/changes/${pass.id}/staged-cuts/1`, { taskId: revision.id, start, end: 8, reason: `Starts at ${start} s.` });
    expect(moved.status).toBe(201);
    return (await moved.json()).change as Change;
  };
  /** The passes that wait for the editor, each as its id and where its second cut is. */
  const waiting = () => ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'", [project.id])
    .map(c => [c.id, c.cutReasons![1]]);
  const first = await move(5.5);
  const second = await move(5.4);
  expect(waiting()).toEqual([[second.id, { start: 5.4, end: 8, reason: "Starts at 5.4 s." }]]);
  // The run settles on its first range after all. Its saved pass was replaced, so the move is made again.
  const third = await move(5.5);
  expect(waiting()).toEqual([[third.id, { start: 5.5, end: 8, reason: "Starts at 5.5 s." }]]);
  expect(third.id).not.toBe(first.id);
  expect(third.id).toMatch(/^chg_[a-f0-9]{64}_review$/);
  expect(ctx.repos.changes.get(first.id)).toMatchObject({ state: "rejected", replacedBy: second.id });
  expect(ctx.repos.changes.get(second.id)).toMatchObject({ state: "rejected", replacedBy: third.id });
  // The same call made again returns the pass it made, and so it does after one more round.
  expect((await move(5.5)).id).toBe(third.id);
  const fourth = await move(5.4);
  expect(fourth.id).not.toBe(second.id);
  const fifth = await move(5.5);
  expect((await move(5.5)).id).toBe(fifth.id);
  expect(waiting()).toEqual([[fifth.id, { start: 5.5, end: 8, reason: "Starts at 5.5 s." }]]);
  expect(new Set([first.id, second.id, third.id, fourth.id, fifth.id]).size).toBe(5);
});

it.each(["revise", "edit"] as const)("saves a call made just as a revised cut lands on the version that waits now (%s request)", async kind => {
  const { ctx } = workspace;
  const { task, base, staged, submit, choose } = dialoguePassInParts();
  const { review: pass } = await submit(base, [staged(2, 3), staged(6, 8), staged(12, 13)]);
  expect((await choose(pass, [{ index: 0, choice: "keep" }])).status).toBe(200);
  // Cut 2 is sent back from its card, or in a request that waits behind the pass's run.
  const revision = kind === "revise"
    ? (await (await api("POST", `/changes/${pass.id}/revise`, { text: "Remove the “I” before the cut.",
      position: { version: pass.fromVersion, time: 6, end: 8, clipIds: [], cutIndex: 1 } })).json()).task as Task
    : createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Remove the “I” before the cut.", createdBy: { type: "human", name: "Editor" },
      context: { threadId: task.id, changeId: pass.id, cutIndex: 1, time: 6, end: 8 } });
  const moved = await api("POST", `/changes/${pass.id}/staged-cuts/1`, { taskId: revision.id, start: 5.5, end: 8, reason: "Starts before the “I”." });
  expect(moved.status).toBe(201);
  const revised = (await moved.json()).change as Change;
  // The editor's call on cut 3 left before the app heard of the revision, so it names the pass the revision replaced.
  // It lands on the revised version, with the call carried before it. A late call on the revised cut was about its
  // old footage: that cut waits for a new one.
  const late = await choose(ctx.repos.changes.get(pass.id)!, [{ index: 0, choice: "keep" }, { index: 1, choice: "cut" }, { index: 2, choice: "keep" }]);
  expect(late.status).toBe(200);
  expect((await late.json()).change.id).toBe(revised.id);
  expect(ctx.repos.changes.get(revised.id)!.cutChoices).toEqual([{ index: 0, start: 2, end: 3, choice: "keep" }, { index: 2, start: 12, end: 13, choice: "keep" }]);
});

it("returns the pass a staged cut's move made when a list of moves is sent again, and makes nothing again", async () => {
  const { ctx } = workspace;
  const { base, staged, submit } = dialoguePassInParts();
  const { review: pass } = await submit(base, [staged(2, 3), staged(6, 8), staged(12, 13)]);
  const { task: revision } = await (await api("POST", `/changes/${pass.id}/revise`, { text: "This cut and the next both start late.",
    position: { version: pass.fromVersion, time: 6, end: 8, clipIds: [] } })).json();
  const move = async (changeId: string, index: number, start: number, end: number) => {
    const moved = await api("POST", `/changes/${changeId}/staged-cuts/${index}`, { taskId: revision.id, start, end, reason: `Starts at ${start} s.` });
    expect(moved.status).toBe(201);
    return (await moved.json()).change as Change;
  };
  // A list of moves is made one after another, each on the pass the move before it made.
  const one = await move(pass.id, 1, 5.5, 8);
  const two = await move(one.id, 2, 11.5, 13);
  // The list is sent again. The second move replaced the pass the first one made and still holds that move, so the
  // first is not made again: it would leave the second out.
  expect((await move(pass.id, 1, 5.5, 8)).id).toBe(one.id);
  expect((await move(one.id, 2, 11.5, 13)).id).toBe(two.id);
  expect(ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'", [project.id])
    .map(c => [c.id, c.cutReasons!.map(r => [r.start, r.end])])).toEqual([[two.id, [[2, 3], [5.5, 8], [11.5, 13]]]]);
});

it("keeps a revision's earlier move when its next move names the pass it was asked to revise", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, choose, assess } = dialoguePassInParts();
  const { review: pass } = await submit(base, [staged(2, 3), staged(6, 8), staged(12, 13)]);
  expect((await assess(pass, [{ index: 0, start: 2, end: 3, verdict: "keep", reason: "Keep it." }, { index: 1, start: 6, end: 8, verdict: "cut", reason: "Clean." },
    { index: 2, start: 12, end: 13, verdict: "cut", reason: "Clean too." }])).status).toBe(200);
  const { task: revision } = await (await api("POST", `/changes/${pass.id}/revise`, { text: "This cut and the next both start late.",
    position: { version: pass.fromVersion, time: 6, end: 8, clipIds: [] } })).json();
  // The run's prompt gives it one pass, so each of its moves names that pass.
  const move = async (index: number, start: number, end: number, reason: string) => {
    const moved = await api("POST", `/changes/${pass.id}/staged-cuts/${index}`, { taskId: revision.id, start, end, reason });
    expect(moved.status).toBe(201);
    return await moved.json() as { change: Change; replaced?: string };
  };
  const one = await move(1, 5.5, 8, "Starts before the “I”.");
  // The editor calls the first cut on the version that move made.
  expect((await choose(one.change, [{ index: 0, choice: "cut" }])).status).toBe(200);
  const two = await move(2, 11.5, 13, "Starts before the breath.");
  // The next move is made on the run's own version of the pass, so the first move stays.
  expect(two.change.cutReasons).toEqual([{ start: 2, end: 3, reason: "Retake at 2 s." }, { start: 5.5, end: 8, reason: "Starts before the “I”." },
    { start: 11.5, end: 13, reason: "Starts before the breath." }]);
  // Both moved cuts wait for the editor, and the call they made meanwhile carries.
  expect(two.change.cutAssessments!.map(a => [a.index, a.verdict, a.reason])).toEqual([[0, "keep", "Keep it."], [1, "ask", "Starts before the “I”."],
    [2, "ask", "Starts before the breath."]]);
  expect(two.change.cutChoices).toEqual([{ index: 0, start: 2, end: 3, choice: "cut" }]);
  // The run revised its own version: no other request's revision had replaced the pass it names.
  expect(two.replaced).toBeUndefined();
  expect(ctx.repos.changes.get(one.change.id)).toMatchObject({ state: "rejected", replacedBy: two.change.id });
  expect(ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'", [project.id]).map(c => c.id)).toEqual([two.change.id]);
});

it("revises the pass that waits now when a queued request names one a revision replaced, and puts away a leftover version once the pass is applied", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const author = { type: "human" as const, name: "Editor" };
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: author });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submitted = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Pass", cuts: [
    { start: 2, end: 3, review: true, reason: "First retake." }, { start: 6, end: 8, review: true, reason: "Second retake." },
    { start: 12, end: 13, review: true, reason: "Third retake." }] });
  const pass = ((await submitted.json()).changes as Change[]).find(c => c.intent === "suggestion")!;
  const calls = [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Check it." }, { index: 1, start: 6, end: 8, verdict: "ask", reason: "Check the “I”." },
    { index: 2, start: 12, end: 13, verdict: "ask", reason: "Check the end." }].map(a => ({ ...a, inspected: true }));
  expect((await api("POST", `/changes/${pass.id}/cut-assessments`, { fromVersion: pass.fromVersion, toVersion: pass.toVersion, assessments: calls })).status).toBe(200);
  // The editor sends the second cut back from its card, and the third while that revision runs: it names the pass in front of them.
  const { task: first } = await (await api("POST", `/changes/${pass.id}/revise`, { text: "Remove the “I” before the cut.",
    position: { version: pass.fromVersion, time: 6, end: 8, clipIds: [], cutIndex: 1 } })).json();
  const second = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Ends too early", createdBy: author,
    context: { threadId: task.id, changeId: pass.id, cutIndex: 2, time: 12, end: 13 } });
  const one = (await (await api("POST", `/changes/${pass.id}/staged-cuts/1`, { taskId: first.id, start: 5.5, end: 8, reason: "Starts before the “I”." })).json()).change as Change;
  expect(ctx.repos.changes.get(pass.id)!.state).toBe("revising");
  // The queued request is told about the pass that waits now, and where its own words named another.
  const { systemPrompt } = await (await api("GET", `/tasks/${second.id}/prompt`)).json();
  expect(systemPrompt).toContain(`Staged cut being revised: index 2 of ${one.id}.`);
  expect(systemPrompt).toContain(`The request names this cut in ${pass.id}`);
  expect(systemPrompt).toContain(`Change ${one.id} [ready]`);
  const outdated = await api("POST", `/changes/${pass.id}/staged-cuts/2`, { taskId: second.id, start: 11.8, end: 13,
    requireCurrentCut: true, reason: "Trim the pause measured on this version." });
  expect(outdated.status).toBe(409);
  expect((await outdated.json()).error).toMatchObject({ code: "cut_review_moved", details: { changeId: one.id, index: 2 } });
  // The first request's own prompt names the pass it is revising.
  expect((await (await api("GET", `/tasks/${first.id}/prompt`)).json()).systemPrompt).toContain(`Staged cut being revised: index 1 of ${pass.id}.`);
  // Its move names the replaced pass all the same. It lands on the one that waits, so the first revision stays.
  const move = () => api("POST", `/changes/${pass.id}/staged-cuts/2`, { taskId: second.id, start: 12, end: 13.5, reason: "Ends after the breath." });
  const moved = await move();
  expect(moved.status).toBe(201);
  const two = await moved.json() as { change: Change; replaced?: string };
  expect(two.replaced).toBe(one.id);
  expect(two.change.cutReasons).toEqual([{ start: 2, end: 3, reason: "First retake." }, { start: 5.5, end: 8, reason: "Starts before the “I”." },
    { start: 12, end: 13.5, reason: "Ends after the breath." }]);
  expect(two.change.cutAssessments!.map(a => [a.index, a.verdict, a.reason])).toEqual([[0, "ask", "Check it."], [1, "ask", "Starts before the “I”."], [2, "ask", "Ends after the breath."]]);
  expect(ctx.repos.changes.get(one.id)).toMatchObject({ state: "rejected", replacedBy: two.change.id });
  const waiting = () => ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'", [project.id]).map(c => c.id);
  expect(waiting()).toEqual([two.change.id]);
  // The same call made again returns the pass it made.
  expect((await (await move()).json()).change.id).toBe(two.change.id);
  expect(waiting()).toEqual([two.change.id]);

  // A version an earlier build left waiting beside it is put away when the pass is applied, and so it asks for nothing.
  const leftover = ctx.repos.changes.put({ ...one, id: "chg_leftover_review", state: "ready", rejectedFrom: undefined, rejectReason: undefined, replacedBy: undefined });
  const approved = await api("POST", `/changes/${two.change.id}/approve`, { restoredCuts: [0] });
  expect(approved.status).toBe(200);
  expect(ctx.repos.changes.get(leftover.id)).toMatchObject({ state: "rejected", rejectedFrom: "ready", replacedBy: two.change.id, rejectReason: "Another version of this pass was applied." });
  // The versions its revisions replaced keep their place in its history.
  expect(ctx.repos.changes.get(pass.id)!.state).toBe("revising");
  expect(ctx.repos.changes.get(one.id)).toMatchObject({ state: "rejected", replacedBy: two.change.id });
  expect(waiting()).toEqual([]);
  // One already left behind by an earlier build is put away as Scarlet starts.
  ctx.repos.changes.put({ ...leftover, id: "chg_older_review" });
  expect(waiting()).toEqual(["chg_older_review"]);
  await ctx.close();
  workspace = openWorkspace();
  expect(workspace.ctx.repos.changes.get("chg_older_review")).toMatchObject({ state: "rejected", replacedBy: two.change.id });
  expect(workspace.ctx.repos.changes.get(pass.id)!.state).toBe("revising");
});

it.each(["first", "current"] as const)("shows a queued request its current call and accepts its move on the %s part", async part => {
  const { ctx } = workspace;
  const { task, base, submit, listed } = dialoguePassInParts();
  const one = await submit(base, [{ start: 12, end: 13, review: true, reason: "First retake." }, { start: 15, end: 16, review: true, reason: "Second retake." }]);
  // The editor sends the second call back while the pass still runs. The request waits behind the run.
  const request = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Ends too early", createdBy: { type: "human", name: "Editor" },
    context: { threadId: task.id, changeId: one.review.id, cutIndex: 1, time: 15, end: 16 } });
  // The next part takes out a false start and stages a retake ahead of both: that cut is third in the pass now, 2 s earlier.
  const two = await submit(base, [{ start: 2, end: 4, review: false, reason: "false start" }, { start: 6, end: 7, review: true, reason: "Third retake." }]);
  expect(ctx.repos.changes.get(one.review.id)).toMatchObject({ state: "rejected", replacedBy: two.review.id });
  expect(await listed(two.review)).toEqual([[4, 5], [10, 11], [13, 14]]);
  expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
  // The request is told about the pass that waits now and where its cut is there, not the second cut of that pass.
  const { systemPrompt } = await (await api("GET", `/tasks/${request.id}/prompt`)).json();
  expect(systemPrompt).toContain(`Staged cut being revised: index 2 of ${two.review.id}.`);
  expect(systemPrompt).toContain(`The request names this cut in ${one.review.id}`);
  expect(systemPrompt).toContain(`where the cut is index 2`);
  expect(systemPrompt).toContain(`Change ${two.review.id} [ready]`);
  const old = part === "first";
  const move = await api("POST", `/changes/${old ? one.review.id : two.review.id}/staged-cuts/${old ? 1 : 2}`,
    { taskId: request.id, start: old ? 15 : 13, end: old ? 16.5 : 14.5, reason: "Ends after the breath." });
  expect(move.status).toBe(201);
  const { change, index } = await move.json() as { change: Change; index: number };
  expect(index).toBe(2);
  expect(change.cutReasons?.slice(0, 2)).toEqual([{ start: 4, end: 5, reason: "Third retake." }, { start: 10, end: 11, reason: "First retake." }]);
  expect((old ? change.cutEdits?.[0]?.range : change.cutReasons?.[2])).toMatchObject({ start: 13, end: 14.5 });
  expect(change.cutReasons?.[2]?.reason).toBe("Ends after the breath.");
});

it("resumes a stopped revision of one cut on the pass that waits now, and leaves the pass it names put away once another cut's revision replaced it", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const author = { type: "human" as const, name: "Editor" };
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: author });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submitted = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Pass", cuts: [
    { start: 2, end: 3, review: true, reason: "First retake." }, { start: 6, end: 8, review: true, reason: "Second retake." },
    { start: 12, end: 13, review: true, reason: "Third retake." }] });
  const pass = ((await submitted.json()).changes as Change[]).find(c => c.intent === "suggestion")!;
  const calls = [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Check it." }, { index: 1, start: 6, end: 8, verdict: "ask", reason: "Check the “I”." },
    { index: 2, start: 12, end: 13, verdict: "ask", reason: "Check the end." }].map(a => ({ ...a, inspected: true }));
  expect((await api("POST", `/changes/${pass.id}/cut-assessments`, { fromVersion: pass.fromVersion, toVersion: pass.toVersion, assessments: calls })).status).toBe(200);
  // The editor sends the first cut back from its card, and a note on the third while that revision is theirs to wait
  // for. Then they stop the first: the pass waits again, and the note runs.
  const { task: stopped } = await (await api("POST", `/changes/${pass.id}/revise`, { text: "Start it later.",
    position: { version: pass.fromVersion, time: 2, end: 3, clipIds: [], cutIndex: 0 } })).json();
  const note = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Ends too early", createdBy: author,
    context: { threadId: task.id, changeId: pass.id, cutIndex: 2, time: 12, end: 13 } });
  expect((await api("POST", `/tasks/${stopped.id}/cancel`, {})).status).toBe(200);
  expect(ctx.repos.changes.get(pass.id)!.state).toBe("ready");
  const one = (await (await api("POST", `/changes/${pass.id}/staged-cuts/2`, { taskId: note.id, start: 12, end: 13.5, reason: "Ends after the breath." })).json()).change as Change;
  expect(ctx.repos.changes.get(pass.id)).toMatchObject({ state: "rejected", replacedBy: one.id });
  // Resumed, the stopped revision still names the pass it was sent about. That pass stays put away: marked as revising
  // again it would be the one this request revises, and the note's revision would be left out of the pass it made.
  const { task: resumed } = await (await api("POST", `/tasks/${stopped.id}/retry`, {})).json();
  expect(resumed).toMatchObject({ kind: "revise", state: "queued", resumeRootId: stopped.id, context: { changeId: pass.id, cutIndex: 0 } });
  expect(ctx.repos.changes.get(pass.id)).toMatchObject({ state: "rejected", replacedBy: one.id });
  // It is told about the pass that waits now and moves its cut there, so one pass waits, with both revisions.
  expect((await (await api("GET", `/tasks/${resumed.id}/prompt`)).json()).systemPrompt).toContain(`Staged cut being revised: index 0 of ${one.id}.`);
  const moved = await (await api("POST", `/changes/${pass.id}/staged-cuts/0`, { taskId: resumed.id, start: 2.5, end: 3, reason: "Starts later." })).json() as { change: Change; replaced?: string };
  expect(moved.replaced).toBe(one.id);
  expect(moved.change.cutReasons).toEqual([{ start: 2.5, end: 3, reason: "Starts later." }, { start: 6, end: 8, reason: "Second retake." },
    { start: 12, end: 13.5, reason: "Ends after the breath." }]);
  expect(ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'", [project.id]).map(c => c.id)).toEqual([moved.change.id]);
});

it("resumes a stopped revision of one cut on the pass a later card revision of another cut made", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 20, hasAudio: true }, "ready");
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 20 } }] }).change.toVersion;
  const submitted = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: task.id, fromVersion: base, description: "Pass", cuts: [
    { start: 2, end: 3, review: true, reason: "First retake." }, { start: 6, end: 8, review: true, reason: "Second retake." },
    { start: 12, end: 13, review: true, reason: "Third retake." }] });
  const pass = ((await submitted.json()).changes as Change[]).find(c => c.intent === "suggestion")!;
  const calls = [{ index: 0, start: 2, end: 3, verdict: "ask", reason: "Check it." }, { index: 1, start: 6, end: 8, verdict: "ask", reason: "Check the “I”." },
    { index: 2, start: 12, end: 13, verdict: "ask", reason: "Check the end." }].map(a => ({ ...a, inspected: true }));
  expect((await api("POST", `/changes/${pass.id}/cut-assessments`, { fromVersion: pass.fromVersion, toVersion: pass.toVersion, assessments: calls })).status).toBe(200);
  const sendBack = async (cutIndex: number, time: number, end: number, text: string) => (await (await api("POST", `/changes/${pass.id}/revise`, { text,
    position: { version: pass.fromVersion, time, end, clipIds: [], cutIndex } })).json()).task as Task;
  // The first cut is sent back from its card and stopped. Then the third is sent back from its card, and that revision lands.
  const stopped = await sendBack(0, 2, 3, "Start it later.");
  expect((await api("POST", `/tasks/${stopped.id}/cancel`, {})).status).toBe(200);
  const third = await sendBack(2, 12, 13, "Ends too early");
  const one = (await (await api("POST", `/changes/${pass.id}/staged-cuts/2`, { taskId: third.id, start: 12, end: 13.5, reason: "Ends after the breath." })).json()).change as Change;
  expect((await api("POST", `/tasks/${third.id}/complete`, { state: "done", summary: "Moved the end." })).status).toBe(200);
  // The pass it revised stays marked as revising, and the one it made waits.
  expect([ctx.repos.changes.get(pass.id)!.state, ctx.repos.changes.get(one.id)!.state]).toEqual(["revising", "ready"]);
  // Resumed, the stopped revision is told about the pass that waits now and moves its cut there.
  const { task: resumed } = await (await api("POST", `/tasks/${stopped.id}/retry`, {})).json();
  expect((await (await api("GET", `/tasks/${resumed.id}/prompt`)).json()).systemPrompt).toContain(`Staged cut being revised: index 0 of ${one.id}.`);
  const moved = await (await api("POST", `/changes/${pass.id}/staged-cuts/0`, { taskId: resumed.id, start: 2.5, end: 3, reason: "Starts later." })).json() as { change: Change; replaced?: string };
  expect(moved.replaced).toBe(one.id);
  expect(moved.change.cutReasons).toEqual([{ start: 2.5, end: 3, reason: "Starts later." }, { start: 6, end: 8, reason: "Second retake." },
    { start: 12, end: 13.5, reason: "Ends after the breath." }]);
  // One pass waits, with both revisions, and the one the resumed revision moved on from names it.
  expect(ctx.repos.changes.get(one.id)).toMatchObject({ state: "rejected", replacedBy: moved.change.id });
  expect(ctx.repos.changes.select("project_id = ? AND state = 'ready' AND json_extract(json, '$.intent') = 'suggestion'", [project.id]).map(c => c.id)).toEqual([moved.change.id]);
});

it("saves a staged cut revision after an earlier trim shifts its footage and keeps the editor's other call", async () => {
  const { ctx } = workspace;
  const { base, staged, submit, assess, choose } = dialoguePassInParts();
  const { review } = await submit(base, [staged(1, 3), staged(12, 14)]);
  expect((await assess(review, [{ index: 1, start: 12, end: 14, verdict: "ask", reason: "Check the repeated word." }])).status).toBe(200);
  expect((await choose(review, [{ index: 0, choice: "keep" }])).status).toBe(200);
  // The editor trims inside the first passage. The second passage moves earlier intact.
  const fps = project.settings.fps;
  const earlierEnd = 2 + 9 / fps;
  const trimmed = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true,
    description: "Remove the earlier false start.", ops: [{ op: "rippleDelete", start: 2, end: earlierEnd }] }).change;
  const requested = await api("POST", `/changes/${review.id}/revise`, { text: "Start two frames earlier.",
    position: { version: review.fromVersion, time: 12, end: 14, clipIds: [], cutIndex: 1 } });
  expect(requested.status).toBe(200);
  const { task: revision } = await requested.json();
  const start = 12 - 2 / fps;
  const move = () => api("POST", `/changes/${review.id}/staged-cuts/1`, { taskId: revision.id, start, end: 14, reason: "Remove the first word." });
  const saved = await move();
  expect(saved.status, await saved.clone().text()).toBe(201);
  const { change } = await saved.json() as { change: Change };
  expect(change.cutChoices).toMatchObject([{ index: 0, choice: "keep" }]);
  expect(change.cutAssessments).toMatchObject([{ index: 1, verdict: "ask", reason: "Remove the first word." }]);
  expect((await (await move()).json()).change.id).toBe(change.id);
  expect(ctx.repos.projects.get(project.id)!.head).toBe(trimmed.toVersion);

  expect((await api("POST", `/tasks/${revision.id}/complete`, { state: "done" })).status).toBe(200);
  const called = await choose(change, [...change.cutChoices!, { index: 1, choice: "cut" }], true);
  expect((await called.json()).change).toMatchObject({ state: "approved", restoredCuts: [0] });
  const head = ctx.repos.projects.get(project.id)!.head!;
  const footage = straightCuts(ctx.repos.versions.get(project.id, head)!.timeline.tracks.find(t => t.id === "a1")!.clips);
  expect(footage).toMatchObject([{ mediaId: "mic", sourceIn: 0, sourceOut: 2 },
    { mediaId: "mic", sourceIn: expect.closeTo(earlierEnd, 8), sourceOut: expect.closeTo(start, 8) },
    { mediaId: "mic", sourceIn: 14, sourceOut: 20 }]);
});

it("carries both recovered cuts when a second request opens the first revision and saves against the original pass", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, assess, choose } = dialoguePassInParts();
  const { review } = await submit(base, [staged(3, 4), staged(8, 10), staged(12, 14)]);
  await assess(review, [0, 1, 2].map((index) => ({ index, ...review.cutReasons![index], verdict: "ask" })));
  await choose(review, [{ index: 0, choice: "keep" }]);
  await api("POST", `/tasks/${task.id}/complete`, { state: "done" });
  const head = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Trim opening.",
    ops: [{ op: "rippleDelete", start: 0.5, end: 1.5 }] }).change.toVersion;
  const revise = async (selected: Change, index: number, reason: string, start: number, end: number) => {
    const { task: revision } = await (await api("POST", `/changes/${selected.id}/revise`, { text: reason,
      position: { version: base, time: selected.cutReasons![index]!.start, end, clipIds: [], cutIndex: index } })).json();
    expect(ctx.repos.changes.get(selected.id)?.state).toBe("revising");
    const saved = await api("POST", `/changes/${review.id}/staged-cuts/${index}`, { taskId: revision.id, start, end, reason });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const { change } = await saved.json() as { change: Change };
    await api("POST", `/tasks/${revision.id}/complete`, { state: "done" });
    return change;
  };
  const first = await revise(review, 1, "Remove the first I.", 7.5, 10);
  const second = await revise(first, 2, "Remove the first so.", 11.5, 14);
  expect(second.cutEdits).toMatchObject([{ index: 1, version: head, range: { start: 6.5, end: 9 } },
    { index: 2, version: head, range: { start: 10.5, end: 13 } }]);
  expect(second.cutAssessments?.map(a => a.reason)).toEqual([review.cutReasons![0]!.reason, "Remove the first I.", "Remove the first so."]);
  expect(second.cutChoices).toMatchObject([{ index: 0, choice: "keep" }]);
  const approved = await api("POST", `/changes/${second.id}/approve`, { restoredCuts: [0] });
  expect(approved.status).toBe(200);
  const final = ctx.repos.versions.get(project.id, ctx.repos.projects.get(project.id)!.head!)!.timeline;
  expect(straightCuts(final.tracks.find(t => t.id === "a1")!.clips)).toMatchObject([
    { sourceIn: 0, sourceOut: 0.5 }, { sourceIn: 1.5, sourceOut: 7.5 }, { sourceIn: 10, sourceOut: 11.5 }, { sourceIn: 14, sourceOut: 20 }]);
});

it("shortens a staged cut revision when a frame inside its requested extension has already been removed", async () => {
  const { ctx } = workspace;
  const { base, staged, submit } = dialoguePassInParts();
  const { review } = await submit(base, [staged(12, 14)]);
  const frame = 1 / project.settings.fps;
  const trimmed = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true,
    description: "Trim one frame.", ops: [{ op: "rippleDelete", start: 12 - frame, end: 12 }] }).change;
  // The deleted frame is already accounted for. Only the surviving audio is removed.
  const response = await api("POST", `/changes/${review.id}/staged-cuts/0`, { start: 12 - 2 * frame, end: 14, reason: "Start two frames earlier." });
  expect(response.status).toBe(201);
  const { change } = await response.json();
  expect(change.cutEdits).toMatchObject([{ version: trimmed.toVersion, range: { start: expect.closeTo(12 - 2 * frame), end: expect.closeTo(14 - frame) } }]);
  const approved = await api("POST", `/changes/${change.id}/approve`, { restoredCuts: [] });
  expect(approved.status).toBe(200);
  const { project: applied } = await approved.json();
  const clips = straightCuts(ctx.repos.versions.get(project.id, applied.head)!.timeline.tracks.find(t => t.id === "a1")!.clips);
  expect(clips).toMatchObject([{ sourceIn: 0, sourceOut: expect.closeTo(12 - 2 * frame) }, { sourceIn: 14, sourceOut: 20 }]);
});

it.each(["trim", "keep"])("rechecks a replaced take on approval and uses the editor's answer to %s it", async decision => {
  const { ctx } = workspace;
  const { task, base, staged, submit } = dialoguePassInParts();
  const { review } = await submit(base, [staged(2, 3), staged(12, 14)]);
  await checkPassAudio(task.id);
  await api("POST", `/tasks/${task.id}/complete`, { state: "done" });
  ctx.repos.projects.putMedia(project.id, { id: "pickup", name: "Pickup", path: "pickup.wav", kind: "audio", duration: 1, hasAudio: true }, "ready");
  const replaced = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Use the pickup.",
    ops: [{ op: "splitClip", clipId: "raw", at: 12.5, newClipId: "middle" },
      { op: "splitClip", clipId: "middle", at: 13.5, newClipId: "tail" },
      { op: "updateClip", clipId: "middle", patch: { mediaId: "pickup", sourceIn: 0, sourceOut: 1 } }] }).change;
  const approve = () => api("POST", `/changes/${review.id}/approve`, { restoredCuts: [] });
  const { outcome, task: recheck, change: pending } = await (await approve()).json();
  expect(outcome).toBe("sent_back");
  expect(recheck).toMatchObject({ state: "queued", context: { changeId: review.id, cutIndex: 1, threadId: task.id },
    cutConflict: { version: replaced.toVersion, range: { start: 12, end: 14 } } });
  expect(pending.cutChoices).toMatchObject([{ index: 0, choice: "cut" }]);
  expect((await (await approve()).json()).task.id).toBe(recheck.id);
  const move = (extra: object) => api("POST", `/changes/${review.id}/staged-cuts/1`,
    { taskId: recheck.id, start: 12, end: 14, reason: "Use the current take.", ...extra });
  const host = (await (await api("POST", "/hosts/register", { name: "Recovery", platform: "test", agents: [{ id: "codex", installed: true }] })).json()).host;
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, {})).json()).task;
  expect((await claim()).id).toBe(recheck.id);
  const stale = await move({});
  expect(stale.status).toBe(409);
  expect((await stale.json()).error.details.range).toEqual({ start: 12, end: 14 });
  // A host that finishes without saving gets a fresh look before the editor is asked to decide.
  const retry = await api("POST", `/tasks/${recheck.id}/complete`, { state: "done", summary: "Please restage." });
  expect((await retry.json()).task).toMatchObject({ id: recheck.id, state: "queued", cutConflict: { retried: true } });
  expect((await claim()).id).toBe(recheck.id);
  const waiting = await api("POST", `/tasks/${recheck.id}/complete`, { state: "done", summary: "Please restage." });
  expect((await waiting.json()).task.state).toBe("waiting_for_user");
  expect((await api("POST", `/tasks/${recheck.id}/answer`, { text: decision === "keep" ? "Keep this take." : "Trim just the pickup." })).status).toBe(200);
  expect((await claim()).id).toBe(recheck.id);
  if (decision === "trim") {
    const switched = await api("POST", projectsPath() + "/branches", { name: "alternate", from: base, expectedHead: replaced.toVersion, expectedBranch: "main" });
    expect(switched.status).toBe(200);
  }
  const saved = await move(decision === "keep" ? { keep: true } : { version: replaced.toVersion, start: 12.5, end: 13.5 });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const { change } = await saved.json();
  expect(ctx.repos.tasks.get(recheck.id)?.cutConflict).toBeUndefined();
  expect(change.cutChoices[0]).toMatchObject({ index: 0, choice: "cut" });
  if (decision === "trim") {
    const [edit] = change.cutEdits;
    expect(edit).toMatchObject({ index: 1, version: replaced.toVersion, range: { start: 12.5, end: 13.5 } });
    expect(timelineDuration(ctx.repos.versions.get(project.id, edit.previewVersion)!.timeline)).toBeCloseTo(19);
  }
  await api("POST", `/tasks/${recheck.id}/complete`, { state: "done" });
  if (decision === "trim") {
    expect(ctx.repos.projects.get(project.id)!.head).toBe(base);
    expect(ctx.repos.changes.get(change.id)!.state).toBe("ready");
    const back = await api("POST", projectsPath() + "/branches", { name: "main", expectedHead: base, expectedBranch: "alternate" });
    expect(back.status).toBe(200);
  }
  const applied = ctx.repos.changes.get(change.id)!;
  expect(applied.state).toBe("approved");
  expect(applied.appliedReview?.joins).toHaveLength(decision === "keep" ? 1 : 2);
  const final = ctx.repos.versions.get(project.id, applied.appliedVersion!)!.timeline;
  expect(timelineDuration(final)).toBeCloseTo(decision === "keep" ? 19 : 18);
  expect(final.tracks.flatMap(t => t.clips).some(c => c.kind === "media" && c.mediaId === "pickup")).toBe(decision === "keep");
});

it.each([false, true])("follows the footage when a rechecked cut extends beyond its preview (adjacent take changed: %s)", async changedNeighbor => {
  const { ctx } = workspace;
  const { task, base, staged, submit } = dialoguePassInParts();
  const { review } = await submit(base, [staged(12, 14)]);
  await api("POST", `/tasks/${task.id}/complete`, { state: "done" });
  ctx.repos.projects.putMedia(project.id, { id: "pickup", name: "Pickup", path: "pickup.wav", kind: "audio", duration: 1, hasAudio: true }, "ready");
  const at = changedNeighbor ? 11.5 : 12.5;
  const replacement = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Use the pickup.",
    ops: [{ op: "splitClip", clipId: "raw", at, newClipId: "middle" }, { op: "splitClip", clipId: "middle", at: at + 1, newClipId: "tail" },
      { op: "updateClip", clipId: "middle", patch: { mediaId: "pickup", sourceIn: 0, sourceOut: 1 } }] }).change;
  const { task: recheck } = await (await api("POST", `/changes/${review.id}/approve`, { restoredCuts: [] })).json();
  const result = await api("POST", `/changes/${review.id}/staged-cuts/0`, { taskId: recheck.id, version: replacement.toVersion,
    start: 9, end: 14, reason: "Include the entire repeated line before the pickup." });
  if (changedNeighbor) {
    expect(result.status).toBe(409);
    expect(ctx.repos.projects.get(project.id)!.head).toBe(replacement.toVersion);
  } else {
    expect(result.status).toBe(201);
    expect((await result.json()).change.cutEdits).toMatchObject([{ index: 0, version: replacement.toVersion, range: { start: 9, end: 14 } }]);
  }
});

it("satisfies a staged removal already made by another edit without cutting either neighboring word", async () => {
  const { ctx } = workspace;
  const { base, staged, submit } = dialoguePassInParts();
  const { review } = await submit(base, [staged(12, 14)]);
  const done = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", autoApprove: true, description: "Remove the retake.",
    ops: [{ op: "rippleDelete", start: 12, end: 14 }] }).change;
  const { change } = await (await api("POST", `/changes/${review.id}/staged-cuts/0`, { start: 12, end: 14, reason: "Remove the retake." })).json();
  expect(change.cutChoices).toMatchObject([{ index: 0, choice: "keep" }]);
  expect(change.cutEdits).toMatchObject([{ version: done.toVersion, range: { start: 12, end: 12 } }]);
  const result = await (await api("POST", `/changes/${change.id}/approve`, { restoredCuts: [] })).json();
  expect(result.project.head).toBe(done.toVersion);
  expect(result.change.appliedReview.joins).toEqual([]);
});

it("reads one immutable version for a full render and still rejects a source changed in flight", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const file = join(ctx.paths.media(project.id), "camera.mp4");
  writeFileSync(file, "input");
  ctx.repos.projects.putMedia(project.id, {
    id: "camera", name: "Camera", path: "camera.mp4", kind: "video", hash: "fingerprinted", duration: 5,
  }, "ready");
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 5 }]), { parent: null });
  const reads = vi.spyOn(ctx.repos.versions, "get");
  const encode = vi.spyOn(ctx.render, "renderFullCached").mockImplementationOnce(async (_p, _t, _c, output) => {
    writeFileSync(output, "export");
    writeFileSync(file, "changed while encoding");
  });
  const request = () => ctx.renders.request({ projectId: project.id, version, quality: "delivery", kind: "full", range: null });
  const stale = request();
  await Promise.all([...ctx.pending]);
  expect(ctx.repos.renders.get(stale.id)).toMatchObject({ state: "failed", error: expect.stringContaining("source changed") });
  const next = request();
  expect(next.previewContentKey).not.toBe(stale.previewContentKey);
  await Promise.all([...ctx.pending]);
  expect(request()).toMatchObject({ id: next.id, state: "done" });
  expect(encode).toHaveBeenCalledTimes(2);
  expect(reads).toHaveBeenCalledTimes(1);
});

it.each(["playback", "segment"] as const)("validates the source window before reusing or publishing a %s render", async kind => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = { id: "camera", name: "Camera", path: "camera.mp4", kind: "video" as const, hasAudio: true, duration: 5 };
  const source = join(ctx.paths.media(project.id), media.path);
  writeFileSync(source, "first input");
  ctx.repos.projects.putMedia(project.id, media, "ready");
  const timeline = timelineFromKeepRanges(project.id, media.id, [{ start: 0, end: 5 }]);
  const v1 = storeVersion(ctx, project.id, timeline, { parent: null }).version;
  const v2 = storeVersion(ctx, project.id, { ...timeline, name: "Renamed" }, { parent: v1 }).version;
  let replaceWhileRendering = false;
  const encode = (output: string) => {
    writeFileSync(output, readFileSync(source));
    if (replaceWhileRendering) writeFileSync(source, "changed while rendering");
  };
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_p, _t, _r, output) => encode(output));
  vi.spyOn(ctx.render, "renderPlaybackSegment").mockImplementation(async (_p, _t, _r, _c, output) => encode(output));
  const request = (version: string) => ctx.renders.request({ projectId: project.id, version, kind, quality: "preview", range: { start: 0, end: 5 } });
  const first = request(v1);
  await Promise.all([...ctx.pending]);
  const { size, mtimeMs, ctimeMs } = statSync(source);
  ctx.repos.projects.putMedia(project.id, { ...media, hash: "hash-of-first-input", fingerprintStamp: { size, mtimeMs, ctimeMs } }, "ready");
  expect(request(v1).id).toBe(first.id);
  expect(request(v2).path).toBe(ctx.repos.renders.get(first.id)!.path);
  writeFileSync(source, "new input after replacement");
  replaceWhileRendering = true;
  const changed = request(v1);
  expect(changed.previewContentKey).not.toBe(first.previewContentKey);
  await Promise.all([...ctx.pending]);
  expect(ctx.repos.renders.get(changed.id)).toMatchObject({ state: "failed", error: expect.stringContaining("source changed") });
  replaceWhileRendering = false;
  const retry = request(v2);
  await Promise.all([...ctx.pending]);
  expect(readFileSync(join(ctx.paths.renders(project.id), ctx.repos.renders.get(retry.id)!.path!), "utf8")).toBe("changed while rendering");
  expect(readFileSync(join(ctx.paths.renders(project.id), ctx.repos.renders.get(first.id)!.path!), "utf8")).toBe("first input");
});

it("reads an edit's range that runs past the timeline's end as reaching the end, and names the length when it starts past it", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Interview", kind: "video", path: "camera.mov" }, "ready");
  const base = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 120 }]), { parent: null });
  ctx.repos.projects.update(project.id, { head: base.version });
  const propose = (range: { start: number; end: number }) => api("POST", projectsPath() + "/changes?summary=true", { intent: "requested",
    description: "Outro full frame", timelineEdits: [{ label: "outro", range }], skipRender: true,
    ops: [{ op: "updateClip", clipId: base.tracks[0]!.clips[0]!.id, patch: { opacity: 0.8 } }] });
  const past = await propose({ start: 121, end: 122 });
  expect(past.status).toBe(400);
  expect(JSON.stringify(await past.json())).toContain("120.000 s long");
  const over = (await (await propose({ start: 110, end: 120.5 })).json()).change;
  expect(over.timelineEdits).toEqual([{ label: "outro", range: { start: 110, end: 120 } }]);
});

it("revises an edit saved with an empty list of named edits by its range, as one saved with no list", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Interview", kind: "video", path: "camera.mov" }, "ready");
  const base = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 120 }]), { parent: null });
  ctx.repos.projects.update(project.id, { head: base.version });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Dim the opening", createdBy: { type: "human", name: "Editor" } });
  const propose = (opacity: number, timelineEdits: object[]) => api("POST", projectsPath() + "/changes?summary=true", { taskId: task.id, intent: "requested",
    description: "Dim the opening", timelineEdits, skipRender: true, ops: [{ op: "updateClip", clipId: base.tracks[0]!.clips[0]!.id, patch: { opacity } }] });
  // The agent names no edit, with an empty list. The edit list then shows the change's own range, as its first edit.
  const first = (await (await propose(0.8, [])).json()).change;
  expect(first).toMatchObject({ state: "approved", timelineEdits: [] });
  expect(first.ranges).toHaveLength(1);
  const revision = (spot: number) => propose(0.6, [{ label: "opening shot", range: first.ranges[0], replaces: { changeId: first.id, spot } }]);
  // A second edit was never there to revise.
  const none = await revision(1);
  expect(none.status).toBe(400);
  expect((await none.json()).error.code).toBe("invalid_replacement");
  const revised = await revision(0);
  expect(await revised.json()).toMatchObject({ change: { state: "approved", timelineEdits: [{ label: "opening shot", replaces: { changeId: first.id, spot: 0 } }] } });
  expect(revised.status).toBe(201);
});

it("files a completed thread separately from its applied edits and rejects stale or cross-thread revisions", async () => {
  const { ctx } = workspace;
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Interview", kind: "video", path: "camera.mov" }, "ready");
  const source = timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 120 }]);
  const base = storeVersion(ctx, project.id, source, { parent: null });
  ctx.repos.projects.update(project.id, { head: base.version });
  const editor = { type: "human" as const, name: "Editor" };
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Polish the opening", createdBy: editor });
  const target = projectsPath() + "/threads/" + task.id;
  const snapshot = () => buildThreads({
    changes: ctx.repos.changes.select("project_id = ?", [project.id]), tasks: ctx.repos.tasks.select("project_id = ?", [project.id]), notes: [],
  }).find(t => t.id === task.id)!;
  const post = (done: boolean, revision: string) => api("POST", target + "/disposition", { done, revision });
  const named = [{ label: "opening shot", range: { start: 8, end: 10 } }, { label: "first caption", range: { start: 8, end: 9 } }];
  const change = (await (await api("POST", projectsPath() + "/changes?summary=true", { taskId: task.id, intent: "requested",
    description: "Adjust opening shot and first caption", timelineEdits: named, skipRender: true,
    ops: [{ op: "updateClip", clipId: base.tracks[0]!.clips[0]!.id, patch: { opacity: 0.8 } }] })).json()).change;
  expect(change.state).toBe("approved");
  expect(change.timelineEdits).toEqual(named);
  expect((await post(true, threadRevision(snapshot()))).status).toBe(409);
  ctx.repos.tasks.put({ ...ctx.repos.tasks.get(task.id)!, state: "done", finishedAt: new Date().toISOString() });
  const revision = threadRevision(snapshot());
  const edits = await (await api("GET", target + "/edits")).json();
  expect(edits.edits.map((e: { range: unknown }) => e.range)).toEqual(named.map(e => e.range));
  expect((await post(true, revision)).status).toBe(200);
  const filed = (await (await api("GET", projectsPath() + "?view=workspace")).json()).project;
  expect(filed.head).toBe(edits.version);
  expect(isThreadDone(snapshot(), filed.completedThreads)).toBe(true);
  expect((await post(false, revision)).status).toBe(200);
  expect(isThreadDone(snapshot(), ctx.repos.projects.header(project.id)?.completedThreads)).toBe(false);
  await post(true, revision);
  createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Hold the caption longer", createdBy: editor,
    context: { threadId: task.id, changeId: change.id, editIndex: 1 } });
  expect(isThreadDone(snapshot(), filed.completedThreads)).toBe(false);
  expect((await post(true, revision)).status).toBe(409);
  const other = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Adjust closing shot", createdBy: editor });
  const invalid = await api("POST", projectsPath() + "/changes", { taskId: other.id, intent: "requested", description: "Target another thread",
    ops: [{ op: "addMarker", marker: { id: "replacement", time: 8, text: "opening" } }],
    timelineEdits: [{ ...named[1], replaces: { changeId: change.id, spot: 1 } }] });
  expect(invalid.status).toBe(400);
  expect(ctx.repos.projects.header(project.id)?.head).toBe(edits.version);
});

it("announces a revised pass once, with its notes and the editor's calls on it, before the pass it replaces goes", async () => {
  const { ctx } = workspace;
  const { task, base, staged, submit, assess, choose } = dialoguePassInParts();
  const { review } = await submit(base, [staged(8, 10), staged(13, 14)]);
  expect((await assess(review, [{ index: 0, start: 8, end: 10, verdict: "ask", reason: "Check the pickup." }, { index: 1, start: 13, end: 14, verdict: "ask", reason: "Check the breath." }])).status).toBe(200);
  expect((await choose(review, [{ index: 1, choice: "cut" }])).status).toBe(200);
  const revision = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Include the pickup.",
    createdBy: { type: "human", name: "Editor" }, context: { threadId: task.id, changeId: review.id, cutIndex: 0 } });
  // What a window following the project is told while one call is revised.
  const told: Array<{ id: string; state: string; notes: number; calls: number }> = [];
  ctx.bus.on("ws", event => {
    if (event.type === "change.updated") told.push({ id: event.change.id, state: event.change.state, notes: event.change.cutAssessments?.length ?? 0, calls: event.change.cutChoices?.length ?? 0 });
  });
  const moved = await api("POST", `/changes/${review.id}/staged-cuts/0`, { start: 7.5, end: 10, reason: "Include the pickup.", taskId: revision.id });
  expect(moved.status).toBe(201);
  const { change } = await moved.json() as { change: Change };
  // Never a pass with no notes: the window would list every cut as a call nobody has checked, for the moment until the notes came.
  expect(told).toEqual([{ id: change.id, state: "ready", notes: 2, calls: 1 }, { id: review.id, state: "rejected", notes: 2, calls: 1 }]);
});

it("keeps a pass's own later save from changing footage under a cut that waits for the editor, and refuses several calls under one note", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const { host } = await (await api("POST", "/hosts/register", { name: "Editor", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 60, hasAudio: true }, "ready");
  const pass = (await (await api("POST", projectsPath() + "/tasks", { agent: "codex", instruction: "/first-cut-dialogue" })).json()).task as Task;
  expect((await (await api("POST", `/hosts/${host.id}/claim`, { taskId: pass.id })).json()).task.id).toBe(pass.id);
  const base = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, description: "Assemble",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "raw", kind: "media", mediaId: "mic", timelineIn: 0, sourceIn: 0, sourceOut: 60 } }] }).change.toVersion;
  const staged = (await (await api("POST", projectsPath() + "/dialogue-cuts", { taskId: pass.id, fromVersion: base, description: "Pass",
    cuts: [{ start: 12, end: 13, review: true, reason: "Restart of the letter intro" }, { start: 30, end: 32, review: true, reason: "Restart of the description" }] })).json()).changes
    .find((c: Change) => c.intent === "suggestion") as Change;
  const versions = { fromVersion: staged.fromVersion, toVersion: staged.toVersion };

  // Four calls that each read "The restart should come out; the measured edge needs a listening check." told the
  // editor nothing apart (2026-11-11). The save is refused with the cuts named, and nothing of it is kept.
  const same = "The restart should come out; the measured edge needs a listening check.";
  const refused = await api("POST", `/changes/${staged.id}/cut-assessments`, { ...versions, assessments: [
    { index: 0, start: 12, end: 13, verdict: "ask", reason: same }, { index: 1, start: 30, end: 32, verdict: "ask", reason: ` ${same.toUpperCase()}` }] });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toMatchObject({ code: "same_note", message: expect.stringContaining("Cuts 0, 1") });
  expect(ctx.repos.changes.get(staged.id)!.cutAssessments).toBeUndefined();
  // A note of its own on each goes in, and so does the same verdict in the same words on cuts Scarlet settles itself.
  expect((await api("POST", `/changes/${staged.id}/cut-assessments`, { ...versions, assessments: [
    { index: 0, start: 12, end: 13, verdict: "ask", reason: "Repeats “this letter”; the cut ends inside “now”." },
    { index: 1, start: 30, end: 32, verdict: "ask", reason: "Restarts the description; no quiet point before “it”." }] })).status).toBe(200);
  // A later ask can't take the words of a call already waiting either.
  const repeat = await api("POST", `/changes/${staged.id}/cut-assessments`, { ...versions, assessments: [
    { index: 1, start: 30, end: 32, verdict: "ask", reason: "Repeats “this letter”; the cut ends inside “now”." }] });
  expect(await repeat.json()).toMatchObject({ heldCalls: [1] });
  expect(ctx.repos.changes.get(staged.id)!.cutAssessments?.[1]?.reason).toBe("Restarts the description; no quiet point before “it”.");

  // The run saves the video another way and takes out the footage the first call is about: a pass that rewrote the
  // timeline over its four staged cuts left the editor's calls with nothing under them (2026-11-11).
  const rewrite = () => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, fromVersion: staged.fromVersion,
    description: "Complete the pass", ops: [{ op: "rippleDelete", start: 11, end: 14 }] });
  expect(rewrite).toThrow(/takes away the footage of a staged cut that waits for the editor’s call.*cut 0 at 12\.00–13\.00 s.*dialogue_apply_cuts/s);
  expect(ctx.repos.projects.get(project.id)!.head).toBe(staged.fromVersion);
  expect(ctx.repos.changes.get(staged.id)!.state).toBe("ready");
  // Leaving a sliver of the cut is taking it away all the same.
  expect(() => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, fromVersion: staged.fromVersion,
    description: "Complete the pass", ops: [{ op: "rippleDelete", start: 11, end: 12.95 }] })).toThrow(/takes away the footage of a staged cut/);
  // An edit elsewhere moves the staged cuts and leaves their footage whole: it goes in, and the calls still wait.
  const elsewhere = proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: pass.id, fromVersion: staged.fromVersion,
    description: "Trim the top", ops: [{ op: "rippleDelete", start: 2, end: 4 }] }).change;
  expect(elsewhere.state).toBe("approved");
  expect(ctx.repos.changes.get(staged.id)!.state).toBe("ready");
});

it("puts away a save the video had moved on from once its run has saved the work again", async () => {
  const { ctx } = workspace;
  vi.spyOn(ctx.render, "renderRange").mockImplementation(async (_project, _timeline, _range, file) => { writeFileSync(file, "preview"); });
  const { host } = await (await api("POST", "/hosts/register", { name: "Editor", platform: "test", agents: [{ id: "codex", installed: true }] })).json();
  ctx.repos.projects.putMedia(project.id, { id: "mic", name: "mic", path: "mic.wav", kind: "audio", duration: 60, hasAudio: true }, "ready");
  const run = async (finish: boolean) => {
    const task = (await (await api("POST", projectsPath() + "/tasks", { agent: "codex", instruction: "Tidy the recording." })).json()).task as Task;
    expect((await (await api("POST", `/hosts/${host.id}/claim`, { taskId: task.id })).json()).task.id).toBe(task.id);
    const save = (body: object) => proposeChange(ctx, localUser(ctx), project.id, { intent: "requested", taskId: task.id, ...body } as never).change;
    const start = ctx.repos.projects.get(project.id)!.head ?? undefined;
    const base = save({ description: "Assemble", ops: [{ op: "addClip", trackId: "a1", clip: { id: `raw-${task.id}`, kind: "media", mediaId: "mic", timelineIn: start ? 100 : 0, sourceIn: 0, sourceOut: 20 } }] }).toVersion;
    const { timeline } = await (await api("GET", `${projectsPath()}/timeline?version=${base}`)).json();
    expect(save({ description: "Trim the top", ops: [{ op: "rippleDelete", start: 1, end: 2 }] }).state).toBe("approved");
    // A whole new timeline made from the version before that trim: the video has moved on, so it waits.
    const rewritten = { ...timeline, tracks: timeline.tracks.map((t: { clips: Array<{ sourceOut?: number }> }) => ({ ...t, clips: t.clips.map(c => c.sourceOut === 20 ? { ...c, sourceOut: 18 } : c) })) };
    const stale = save({ fromVersion: base, description: "Save the pass so far", timeline: rewritten });
    expect(stale).toMatchObject({ state: "ready", error: expect.stringContaining("The timeline changed while the edit was running.") });
    const again = finish ? save({ description: "Save the pass", ops: [{ op: "rippleDelete", start: 5, end: 6 }] }) : undefined;
    expect((await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).status).toBe(200);
    return { stale: ctx.repos.changes.get(stale.id)!, again };
  };
  // With nothing saved after it, the refused save is all there is of that work: it still waits for the editor.
  expect((await run(false)).stale.state).toBe("ready");
  const { stale, again } = await run(true);
  expect(stale).toMatchObject({ state: "rejected", rejectedFrom: "ready", replacedBy: again!.id });
});

it("records the editor's dialogue shortcut across rewords, answers, retries, notes and cut revisions", async () => {
  const { ctx } = workspace;
  seedSkillList(ctx, BUNDLED_SKILLS);
  const guide = ctx.repos.skills.select("name = ?", ["dialogue-pass"])[0]!;
  const task = async (instruction: string, context = {}) => (await (await api("POST", projectsPath() + "/tasks",
    { agent: "codex", instruction, context })).json()).task as Task;
  await api("PATCH", `/skills/${guide.id}`, { enabled: false });
  const noGuide = await task("Do /dialogue-pass now");
  expect(noGuide.context.dialogueOperation).toBe("first-cut");
  const rewordedWithoutGuide = await (await api("POST", `/tasks/${noGuide.id}/reword`, { text: "Here /tighten-pauses-here" })).json();
  expect(rewordedWithoutGuide.task.context.dialogueOperation).toBe("local-pauses");
  await api("PATCH", `/skills/${guide.id}`, { enabled: true });
  const pinned = await task("Use the selected guide", { skillIds: [guide.id], dialogueOperation: "first-cut" });
  expect(pinned.context.dialogueOperation).toBe("none");
  const queued = await task("Start here /TIGHTEN-PAUSES-HERE with this pause", { skillIds: [guide.id] });
  expect(queued.context.dialogueOperation).toBe("local-pauses");
  const reworded = (await (await api("POST", `/tasks/${queued.id}/reword`, { text: "Do the entire /dialogue-pass now", skillIds: [guide.id] })).json()).task as Task;
  expect(reworded.context.dialogueOperation).toBe("first-cut");
  appendTaskEvent(ctx, reworded, { type: "question", text: "Which passage?" });
  const answer = (await (await api("POST", `/tasks/${queued.id}/answer`, { text: "Use /tighten-pauses-here instead." })).json()).task as Task;
  expect(answer.context.dialogueOperation).toBe("local-pauses");
  appendTaskEvent(ctx, answer, { type: "question", text: "Which beat?" });
  const same = (await (await api("POST", `/tasks/${queued.id}/answer`, { text: "The first." })).json()).task as Task;
  expect(same.context.dialogueOperation).toBe("local-pauses");
  saveTask(ctx, { ...same, state: "failed", finishedAt: new Date().toISOString() });
  const retry = (await (await api("POST", `/tasks/${queued.id}/retry`, {})).json()).task as Task;
  expect(retry.context.dialogueOperation).toBe("local-pauses");

  const { base, submit, staged } = dialoguePassInParts();
  const note = await (await api("POST", projectsPath() + "/notes", { assignTo: "codex", text: "Here /tighten-pauses-here", version: base, time: 4, end: 8 })).json();
  expect(note.task.context).toMatchObject({ dialogueOperation: "local-pauses", time: 4, end: 8 });
  const review = (await submit(base, [staged(7, 8)])).review;
  const revision = await (await api("POST", `/changes/${review.id}/revise`, { assignTo: "codex", text: "Try /tighten-pauses-here on this cut", position: { version: base, cutIndex: 0, time: 7, end: 8 } })).json();
  expect(revision.task.context).toMatchObject({ dialogueOperation: "local-pauses", cutIndex: 0 });

  await api("POST", "/skills", { name: "tighten-pauses-here", content: "# An editor's custom guide", scope: "team" });
  const custom = await task("/tighten-pauses-here");
  expect(custom.context.dialogueOperation).toBe("none");
  const shadow = ctx.repos.skills.select("name = ?", ["tighten-pauses-here"])[0]!;
  await api("PATCH", `/skills/${shadow.id}`, { enabled: false });
  expect((await task("/tighten-pauses-here")).context.dialogueOperation).toBe("none");
  expect((await task("/dialogue-pass")).context.dialogueOperation).toBe("first-cut");
  await api("PATCH", `/skills/${guide.id}`, { content: "# My first cut" });
  expect((await task("/dialogue-pass")).context.dialogueOperation).toBe("first-cut");
  await api("DELETE", `/skills/${guide.id}`);
  expect((await task("/dialogue-pass")).context.dialogueOperation).toBe("first-cut");
  await api("POST", "/skills", { name: "dialogue-pass", content: "# My different guide", scope: "team" });
  expect((await task("/dialogue-pass")).context.dialogueOperation).toBe("none");
  expect(ctx.repos.tasks.get(reworded.id)!.context.dialogueOperation).toBe("local-pauses");
});

it("limits each part of a local pause task to its first passage and finishes without a whole-edit repeat check", async () => {
  const { ctx } = workspace;
  const { base } = dialoguePassInParts();
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Here /tighten-pauses-here",
    context: { version: base, time: 5 }, createdBy: { type: "human", name: "Editor" } });
  const submit = (fromVersion: string, cut: object, range?: object) => api("POST", projectsPath() + "/dialogue-cuts", {
    taskId: task.id, fromVersion, description: "Tighten the pause.", range, cuts: [{ start: 5, end: 6, review: false, reason: "Quiet beat.", ...cut }],
  });
  const range = { start: 4, end: 8 };
  expect((await submit(base, { kind: "pause" })).status).toBe(400);
  expect((await submit(base, { kind: "retake" }, range)).status).toBe(400);
  expect((await submit(base, {}, range)).status).toBe(400);
  expect((await submit(base, { start: 3, kind: "pause" }, range)).status).toBe(400);
  expect((await api("POST", projectsPath() + "/changes", { fromVersion: base, taskId: task.id, description: "Remove a bit", intent: "requested",
    nonDialogueRemoval: true, ops: [{ op: "rippleDelete", start: 5, end: 6 }] })).status).toBe(400);
  const scoped = ctx.repos.tasks.get(task.id)!;
  const upload = await workspace.app.request("/api" + projectsPath() + "/media/import", { method: "POST",
    headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json",
      "X-Scarlet-Task": scoped.id, "X-Scarlet-Task-Started-At": scoped.startedAt! }, body: JSON.stringify({ path: "/unrelated.mp4" }) });
  expect(upload.status).toBe(400);
  expect(await upload.json()).toMatchObject({ error: { code: "local_pauses" } });
  const saved = await submit(base, { kind: "pause" }, range);
  expect(saved.status).toBe(201);
  const { head } = await saved.json();
  expect(ctx.repos.tasks.get(task.id)!.context.dialogueRange).toEqual({ version: base, ...range });
  expect((await submit(head, { start: 7.5, end: 8, kind: "pause" }, { start: 4, end: 9 })).status).toBe(400);
  expect((await submit(head, { start: 6, end: 6.5, kind: "pause" })).status).toBe(201);
  const current = ctx.repos.projects.header(project.id)!.head;
  expect((await api("POST", projectsPath() + `/tasks/${task.id}/repeat-audit`, { version: current })).status).toBe(400);
  const done = (await (await api("POST", `/tasks/${task.id}/complete`, { state: "done" })).json()).task as Task;
  expect(done.state).toBe("done");
  expect(done.repeatAudit).toBeUndefined();
});

it("recovers legacy shortcut intent, including the answers that changed it before an interrupted retry", async () => {
  const { ctx } = workspace;
  const prior = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: { type: "human", name: "Editor" } });
  const retry = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: prior.createdBy });
  const custom = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "Add a music bed", createdBy: prior.createdBy });
  ctx.repos.taskEvents.append({ id: "answer", at: new Date().toISOString(), taskId: prior.id, type: "answer", text: "Just this beat /tighten-pauses-here" });
  ctx.repos.tasks.put({ ...prior, retryTaskId: retry.id, context: {}, repeatAudit: { version: "old", returns: 1 } });
  ctx.repos.tasks.put({ ...retry, context: {} });
  ctx.repos.tasks.put({ ...custom, context: { skillIds: ["dialogue-guide"] } });
  migrateDialogueOperations(ctx);
  migrateDialogueOperations(ctx);
  expect([prior.id, retry.id, custom.id].map(id => ctx.repos.tasks.get(id)!.context.dialogueOperation)).toEqual(["local-pauses", "local-pauses", "none"]);
  expect(ctx.repos.tasks.get(prior.id)!.repeatAudit).toBeUndefined();
});

it("checks repeats only in the selected placement when the same recording plays twice", async () => {
  const { ctx } = workspace;
  const { task } = dialoguePassInParts();
  await micSpeech({ 150: "now|very|very|fast|" });
  const version = proposeChange(ctx, localUser(ctx), project.id, { taskId: task.id, intent: "requested", description: "Use it twice",
    ops: [{ op: "addClip", trackId: "a1", clip: { id: "again", kind: "media", mediaId: "mic", sourceIn: 0, sourceOut: 20, timelineIn: 20 } }] }).change.toVersion;
  const selected = createTask(ctx, { projectId: project.id, kind: "edit", agent: "codex", instruction: "/first-cut-dialogue", createdBy: task.createdBy, context: { version, time: 0, end: 7 } });
  saveTask(ctx, { ...selected, startedAt: new Date().toISOString(), state: "running" });
  const check = async (version: string) => {
    const response = await api("POST", projectsPath() + `/tasks/${selected.id}/repeat-audit`, { version });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ heard: 1, repeats: [{ phrase: "very" }] });
  };
  await check(version);
  const shortened = await api("POST", projectsPath() + "/dialogue-cuts", { taskId: selected.id, fromVersion: version, description: "Shorten the head",
    cuts: [{ start: 0, end: 1, review: false, kind: "pause", reason: "Quiet beginning." }] });
  expect(shortened.status).toBe(201);
  await check((await shortened.json()).head);
});
