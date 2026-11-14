import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { ScarletClient } from "@scarlet/shared";
import { fileInDirectory } from "@scarlet/render";
import { createProject } from "@scarlet/timeline";
import { createApp } from "../app.js";
import { createTask, cancelTask } from "./tasks.js";
import { accessToken } from "../auth.js";
import { WhisperCppProvider } from "../transcribe/whispercpp.js";
import { UhmDetector } from "../transcribe/uhm.js";
import { EmissionFile } from "../transcribe/emissions.js";
import { CLASSES, CTC_LETTERS, SAMPLE_RATE, SEPARATOR } from "../transcribe/ctcAlign.js";
import { emissionStore } from "./recordingAudio.js";
import { bundledWhisperModel } from "../transcribe/localModel.js";
import * as ffmpeg from "../render/ffmpeg.js";
import * as sources from "./transcriptSources.js";

vi.mock("@scarlet/render", async original => ({
  ...await original<typeof import("@scarlet/render")>(),
  speechActivityOf: async () => [{ start: 4, end: 5 }],
}));
// Word alignment downloads a model and runs a worker; these tests cover scan scheduling, not timing.
vi.mock("../transcribe/wordAlign.js", async original => ({ ...await original<typeof import("../transcribe/wordAlign.js")>(), alignmentVersion: 1, alignWords: async (_ctx: unknown, _wav: string, segments: unknown) => segments }));
vi.mock("../render/ffmpeg.js", async original => ({
  ...await original<typeof import("../render/ffmpeg.js")>(),
  extractWav: async (_file: string, target: string) => {
    const emptyWav = Buffer.alloc(20);
    emptyWav.write("data", 12);
    await writeFile(target, emptyWav);
  },
}));

async function cloudScanFixture(env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "test-key" }) {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-provider-"));
  const open = () => createApp({ dataDir: dir, skillsSeedDir: dir, env, log: () => {} });
  const app = open(), peer = open();
  const { ctx } = app;
  onTestFinished(async () => {
    await ctx.close();
    await peer.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const project = ctx.repos.projects.insert(createProject("Provider selection"));
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "mic", name: "Mic", path: "mic.wav", kind: "audio", duration: 180 }, "ready");
  // An existing transcript keeps the scan's own Whisper calls countable.
  ctx.repos.transcripts.put({ id: "trs_mic", projectId: project.id, mediaId: media.id, segments: [] });
  await writeFile(join(ctx.paths.media(project.id), media.path), "original recording");
  ctx.repos.settings.update({ transcription: { provider: "openai", language: "en" } });
  const speaker = vi.spyOn(ctx.speakers, "turns").mockResolvedValue([{ start: 0, end: 180, speaker: 1 }]);
  vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
  const request = (route: string, from: number, taskId?: string, window?: { to: number; keptSide: { audioStream?: number } }) => app.app.request(`/api/projects/${project.id}/dialogue-${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: media.id, from, to: from + 60, taskId, ...window }),
  });
  const client = new ScarletClient({ baseUrl: "https://dialogue.local", token: accessToken(ctx), fetch: (url, init) => app.app.request(url, init) });
  return { ctx, peer: peer.ctx, project, media, speaker, request, client };
}

it("reads the selected input's existing acoustic words with transcription off", async () => {
  const { ctx, project, media, speaker, client } = await cloudScanFixture({});
  ctx.repos.settings.update({ transcription: { provider: "none", language: "auto" } });
  const root = ctx.paths.media(project.id);
  await mkdir(join(root, "takes"));
  await rename(join(root, media.path), join(root, "takes", media.path));
  await symlink(join(root, "takes"), join(root, "linked"), "junction");
  ctx.repos.projects.putMedia(project.id, { ...media, path: join("linked", media.path) }, "ready");
  const imported = join(root, "linked", media.path), file = await realpath(imported);
  const request = { mediaId: media.id, from: 0, to: 3 };
  const words = (audioStream?: number) => client.dialogueAcousticWords(project.id, { ...request, audioStream });
  const kept = (audioStream?: number, from = 0, to = 3) => client.dialogueDetections(project.id, {
    ...request, from, to, keptSide: { audioStream, cachedOnly: true } });
  const decode = vi.spyOn(ffmpeg, "extractWav");
  const unavailable = { segments: [], acoustic: [], keptSideUnavailable: true };
  expect(await words()).toEqual([]);
  expect(await kept()).toEqual(unavailable);
  // The older engine used the path as imported. Seed its exact filename independently of the current writer.
  const info = await stat(imported);
  const legacy = createHash("sha256").update(JSON.stringify([1, [imported, info.size, info.mtimeMs, info.ctimeMs, 1]])).digest("hex");
  const legacyFile = join(ctx.paths.waveforms(project.id), `emissions-${legacy.slice(0, 32)}.bin`);
  const canonical = await emissionStore(ctx, project.id, file, 1);
  expect(legacyFile).not.toBe(canonical);
  const save = async (path: string, letter: string) => {
    const store = (await EmissionFile.open(path, 3 * SAMPLE_RATE))!;
    try {
      const rows = new Float32Array(store.frames * CLASSES);
      rows[CLASSES + 5 + CTC_LETTERS.indexOf(letter)] = 1;
      await store.write(0, rows);
    } finally { await store.close(); }
  };
  await save(await emissionStore(ctx, project.id, file), "A");
  await save(legacyFile, "B");
  expect(await words()).toEqual([[{ text: "a", start: .02, end: .04 }]]);
  expect(await words(1)).toEqual([[{ text: "b", start: .02, end: .04 }]]);
  expect(await words(0)).toEqual([]);
  expect(await kept()).toMatchObject({ segments: [{ id: "kept", words: [{ text: "a", start: .02, end: .04 }] }] });
  expect(await kept(1)).toMatchObject({ segments: [{ id: "kept", words: [{ text: "b" }] }] });
  await expect(stat(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  await save(canonical, "C");
  expect(await words(1)).toEqual([[{ text: "c", start: .02, end: .04 }]]);
  expect(await kept(1)).toMatchObject({ segments: [{ id: "kept", words: [{ text: "c" }] }] });
  expect(await kept(0)).toEqual(unavailable);
  expect(await kept(undefined, 1, 2)).toEqual({ segments: [], acoustic: [] });
  await expect(kept(undefined, 1, 9.5)).rejects.toMatchObject({ status: 400 });
  await expect(client.dialogueDetections(project.id, { ...request, keptSide: { cachedOnly: true },
    taskId: "missing-edit" })).rejects.toMatchObject({ status: 404 });
  await expect(client.dialogueAcousticWords("another-project", request)).rejects.toMatchObject({ status: 404 });
  await expect(client.dialogueAcousticWords(project.id, { ...request, to: 86 })).rejects.toMatchObject({ status: 400 });
  // Sources imported before a selected transcript was recorded use their latest saved transcript.
  ctx.repos.transcripts.put({ id: "trs_mic", projectId: project.id, mediaId: media.id, language: "es", segments: [] });
  expect(await words()).toEqual([]);
  expect(await kept()).toEqual(unavailable);
  expect(decode).not.toHaveBeenCalled();
  expect(speaker).not.toHaveBeenCalled();
});

it("reads only the kept speech frames, including a word missing from the transcript", async () => {
  const { ctx, project, media, speaker, request } = await cloudScanFixture();
  const file = fileInDirectory(ctx.paths.media(project.id), media.path)!;
  const store = (await EmissionFile.open(await emissionStore(ctx, project.id, file), 5 * SAMPLE_RATE))!;
  try {
    const rows = new Float32Array(store.frames * CLASSES);
    for (const first of [26, 53, 96]) {
      for (const [i, ch] of [..."the|"].entries()) rows[(first + i) * CLASSES + (ch === "|" ? SEPARATOR : 5 + CTC_LETTERS.indexOf(ch.toUpperCase()))] = 1;
    }
    await store.write(0, rows);
  } finally { await store.close(); }
  const upload = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upload"));
  const response = await request("detections", 1, undefined, { to: 2.3, keptSide: {} });
  expect(response.status, await response.clone().text()).toBe(200);
  const { segments } = await response.json();
  expect(segments[0].words.map((w: { text: string }) => w.text)).toEqual(["the", "the"]);
  expect(upload).not.toHaveBeenCalled();
  expect(speaker).not.toHaveBeenCalled();
  expect(await (await request("checkpoints", 0)).json()).toEqual([]);
});

it("transcribes and caches just the surviving window when acoustic frames are unavailable", async () => {
  const { request, client, project, media, speaker } = await cloudScanFixture();
  const upload = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ text: "the the", words: [
    { word: "the", start: .1, end: .3 }, { word: "the", start: .4, end: .6 }] }));
  const check = () => request("detections", 8, undefined, { to: 10, keptSide: { audioStream: 0 } });
  for (const result of await Promise.all([check(), check()])) {
    expect(result.status).toBe(200);
    const { segments } = await result.json();
    expect(segments[0].words).toMatchObject([{ text: "the", start: 8.1 }, { text: "the", start: 8.4 }]);
  }
  expect((await check()).status).toBe(200);
  // A previous ASR fallback for the exact same range must not satisfy a request for cached emissions.
  expect(await client.dialogueDetections(project.id, { mediaId: media.id, from: 8, to: 10,
    keptSide: { audioStream: 0, cachedOnly: true } })).toEqual({ segments: [], acoustic: [], keptSideUnavailable: true });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(speaker).not.toHaveBeenCalled();
  expect(await (await request("checkpoints", 0)).json()).toEqual([]);
});

it("sends only extracted dialogue windows to the selected cloud provider and gets speaker labels locally", async () => {
  const { ctx, project, media, speaker, request } = await cloudScanFixture();
  ctx.repos.projects.putMedia(project.id, { ...media, voiceRoles: { me: 1, other: 2 } }, "ready");
  vi.spyOn(sources, "readSourceEnergy").mockResolvedValue({ mix: 2, energy: Array.from({ length: 50 }, () => [0, 20000, 20000]) });
  const extract = vi.spyOn(ffmpeg, "extractWav");
  const sizes: number[] = [];
  const upload = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
    expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
    const fields = opts!.body as FormData;
    expect(fields.get("model")).toBe("whisper-1");
    expect(fields.get("language")).toBe("en");
    expect(fields.getAll("timestamp_granularities[]")).toContain("word");
    const audio = fields.get("file") as File;
    expect(audio.type).toBe("audio/wav");
    sizes.push(audio.size);
    return Response.json({ text: "hello", words: [{ word: "hello", start: 0.1, end: 0.5 }] });
  });
  const result = await request("detections", 60);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ segments: [{ words: [{ start: 60.1, end: 60.5, detectedSpeaker: 1 }] }],
    otherVoiceTurns: [{ text: "hello" }], speakerTurns: [{ speaker: 1 }] });
  // The recording is decoded once, whole, and stays on this machine. The window cut from it is uploaded (a WAV
  // header here, since the fixture's decode is empty), then the other voice's window.
  expect(extract.mock.calls.map(call => call[2])).toEqual([{ audioStream: undefined }, expect.objectContaining({ start: 60, duration: 60, audioStream: 1 })]);
  expect(sizes).toEqual([44, 20]);
  expect((upload.mock.calls[0]![1]!.body as FormData).get("prompt")).toContain("Um");
  expect((upload.mock.calls[1]![1]!.body as FormData).has("prompt")).toBe(false);
  expect((await request("detections", 60)).ok).toBe(true);
  expect(speaker).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledTimes(2);
  ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
  expect(await (await request("checkpoints", 60)).json()).toEqual([]);
});

it("rejects missing cloud credentials and respects Off before contacting either provider", async () => {
  const { ctx, request, speaker } = await cloudScanFixture({});
  const upload = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upload"));
  expect((await request("detections", 0)).status).toBe(409);
  ctx.repos.settings.update({ transcription: { provider: "none" } });
  expect((await request("detections", 0)).status).toBe(409);
  expect(upload).not.toHaveBeenCalled();
  expect(speaker).not.toHaveBeenCalled();
});

it("caches silence and retries speech when the configured model omits word timings", async () => {
  const { ctx, request } = await cloudScanFixture();
  ctx.repos.settings.update({ transcription: { openaiModel: "configured-model" } });
  const upload = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ text: "speech without timings" }))
    .mockResolvedValueOnce(Response.json({ text: "", segments: [] }));
  expect((await request("detections", 0)).ok).toBe(false);
  expect((upload.mock.calls[0]![1]!.body as FormData).get("model")).toBe("configured-model");
  expect(await (await request("checkpoints", 0)).json()).toEqual([]);
  expect(await (await request("detections", 0)).json()).toMatchObject({ segments: [] });
  expect(await (await request("checkpoints", 0)).json()).toEqual([{ start: 0, end: 60 }]);
  ctx.repos.settings.update({ transcription: { openaiModel: "whisper-1" } });
  expect(await (await request("checkpoints", 0)).json()).toEqual([]);
});

it("rechecks another engine's settings after extraction and before sending audio", async () => {
  const { request, peer } = await cloudScanFixture();
  const upload = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected upload"));
  vi.spyOn(ffmpeg, "extractWav").mockImplementationOnce(async (_file, target) => {
    await writeFile(target, "prepared");
    peer.repos.settings.update({ transcription: { provider: "none" } });
  });
  expect((await request("detections", 0)).ok).toBe(false);
  expect(upload).not.toHaveBeenCalled();
});

it.each(["cancel", "provider"] as const)("aborts an in-flight upload after a peer changes %s", async action => {
  const { ctx, peer, project, request } = await cloudScanFixture();
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
    state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });
  let signal: AbortSignal | undefined;
  const upload = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
    signal = opts!.signal!;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  expect((await request("scan", 0, task.id)).ok).toBe(true);
  const reader = request("detections", 0, task.id);
  await vi.waitFor(() => expect(signal).toBeDefined());
  if (action === "cancel") cancelTask(peer, task);
  else peer.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
  expect((await reader).ok).toBe(false);
  expect(signal?.aborted).toBe(true);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(ctx.db.prepare("SELECT count(*) AS pages FROM dialogue_scan_pages").get()).toEqual({ pages: 0 });
});

it("goes on with a running edit's upload when a peer pauses the project, and stops one nobody asked for", async () => {
  const { ctx, peer, project, request } = await cloudScanFixture();
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
    state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });
  const uploads: Array<{ signal: AbortSignal; finish(): void }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => new Promise((resolve, reject) => {
    const signal = opts!.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    uploads.push({ signal, finish: () => resolve(Response.json({ text: "", segments: [] })) });
  }));
  // A page no edit asked for is part of the work the pause stops.
  const unasked = request("detections", 60);
  await vi.waitFor(() => expect(uploads).toHaveLength(1));
  peer.repos.projects.update(project.id, { mediaPaused: true });
  expect((await unasked).ok).toBe(false);
  expect(uploads[0]!.signal.aborted).toBe(true);
  // The editor asked for the edit, and pausing the caching isn't stopping it: its page starts while the project is
  // paused, and is still going after the engine has looked at the project several times more.
  const asked = request("detections", 0, task.id);
  await vi.waitFor(() => expect(uploads).toHaveLength(2));
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(uploads[1]!.signal.aborted).toBe(false);
  uploads[1]!.finish();
  expect((await asked).ok).toBe(true);
  expect(ctx.db.prepare("SELECT count(*) AS pages FROM dialogue_scan_pages").get()).toEqual({ pages: 1 });
});

it("keeps reading for a running edit while the project's media work is paused, and stops when the project goes to Trash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-paused-dialogue-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  const { ctx } = app;
  let release = () => {};
  onTestFinished(async () => {
    release();
    await ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });
  const project = ctx.repos.projects.insert(createProject("Paused pass"));
  ctx.paths.ensureProject(project.id);
  const media = ctx.repos.projects.putMedia(project.id, { id: "mic", name: "Mic", kind: "audio", path: "mic.wav", duration: 300 }, "ready");
  ctx.repos.transcripts.put({ id: "trs_mic", projectId: project.id, mediaId: media.id, segments: [] });
  await writeFile(join(ctx.paths.media(project.id), media.path), "recording");
  ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
  vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
  vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
  // Whisper reads one page, then holds each page until the test lets it go. Like the real program, it stops when its signal does.
  const result = { language: "en", segments: [] };
  const held: AbortSignal[] = [];
  let gate = new Promise<void>(resolve => { release = resolve; });
  const whisper = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockImplementation(async (_wav, _tmp, signal) => {
    if (whisper.mock.calls.length === 1) return result;
    held.push(signal!);
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    });
    return result;
  });
  const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
    state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });
  const headers = { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" };
  const request = (route: string, from: number, to: number, asked = true) => app.app.request(`/api/projects/${project.id}/dialogue-${route}`, {
    method: "POST", headers, body: JSON.stringify({ ...(asked && { taskId: task.id }), mediaId: media.id, from, to }) });
  const patch = (body: unknown) => app.app.request(`/api/projects/${project.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  const read = () => ctx.repos.taskEvents.list(task.id).flatMap(e => e.data?.scanPage ? [(e.data.scanPage as { from: number }).from] : []);
  const settle = async () => { while (ctx.pending.size) await Promise.allSettled([...ctx.pending]); };

  // The pass has read its first page and is on its second when the editor pauses the caching.
  expect((await request("scan", 0, 180)).ok).toBe(true);
  await vi.waitFor(() => expect(held).toHaveLength(1));
  expect(read()).toEqual([0]);
  expect((await patch({ mediaPaused: true })).ok).toBe(true);
  expect(held[0]!.aborted).toBe(false);
  // Its next requests are answered as before: the engine goes on reading, and reads the minute the pass asks for.
  const scan = await request("scan", 0, 180);
  expect([scan.status, await scan.json()]).toEqual([200, [{ start: 0, end: 60 }]]);
  const page = request("detections", 58, 118);
  // A page nobody asked for is still part of what the pause stops.
  const unasked = await request("detections", 240, 300, false);
  expect([unasked.status, (await unasked.json() as { error: { message: string } }).error.message]).toEqual([500, "Project media processing stopped."]);
  release();
  expect((await page).status).toBe(200);
  await settle();
  expect(read()).toEqual([0, 58, 116, 174]);
  expect(await (await request("checkpoints", 0, 180)).json()).toHaveLength(4);

  // Trash stops the pass's reading where the pause didn't.
  gate = new Promise<void>(resolve => { release = resolve; });
  expect((await request("scan", 180, 300)).ok).toBe(true);
  await vi.waitFor(() => expect(held).toHaveLength(4));
  expect((await app.app.request(`/api/projects/${project.id}`, { method: "DELETE", headers })).ok).toBe(true);
  expect(held[3]!.aborted).toBe(true);
  await settle();
  expect(read()).toEqual([0, 58, 116, 174]);
});

it("restores committed dialogue evidence after restarting the engine and retries unfinished windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-test-"));
  const open = () => createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  let app = open();
  const whisper = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockResolvedValue({ language: "en", segments: [] });
  const uhm = vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([{ start: 4, end: 5, confidence: .9 }]);
  try {
    const project = app.ctx.repos.projects.insert(createProject("Scan test"));
    app.ctx.paths.ensureProject(project.id);
    const media = app.ctx.repos.projects.putMedia(project.id,
      { id: "mic", name: "Mic", kind: "audio", path: "mic.wav", duration: 180 }, "ready");
    const source = join(app.ctx.paths.media(project.id), media.path);
    await writeFile(source, "first recording");
    app.ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    vi.spyOn(app.ctx.speakers, "turns").mockResolvedValue([{ start: 0, end: 30, speaker: 1 }]);
    const request = (route: string, from: number, to: number) => app.app.request(`/api/projects/${project.id}/dialogue-${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(app.ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mediaId: media.id, from, to }),
    });
    const first = await Promise.all([request("detections", 0, 60), request("detections", 0, 60)]);
    expect(first.map(r => r.status)).toEqual([200, 200]);
    const evidence = await first[0]!.json();
    expect(evidence).toMatchObject({ speechActivity: [{ start: 4, end: 5 }], acoustic: [{ confidence: .9 }], speakerTurns: [{ speaker: 1 }] });
    expect(whisper).toHaveBeenCalledTimes(1);
    uhm.mockRejectedValueOnce(new Error("interrupted detector"));
    expect((await request("detections", 58, 118)).ok).toBe(false);
    await app.ctx.close();
    app = open();
    const turns = vi.spyOn(app.ctx.speakers, "turns").mockResolvedValue([]);
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([{ start: 0, end: 60 }]);
    expect(await (await request("detections", 0, 60)).json()).toEqual(evidence);
    expect(whisper).toHaveBeenCalledTimes(2);
    turns.mockRejectedValueOnce(new Error("speaker model unavailable"));
    expect(await (await request("detections", 58, 118)).json()).toMatchObject({ speakerIssue: "speaker model unavailable" });
    expect(await (await request("checkpoints", 58, 180)).json()).toEqual([]);
    expect((await request("detections", 58, 118)).ok).toBe(true);
    expect(await (await request("checkpoints", 58, 180)).json()).toEqual([{ start: 58, end: 118 }]);
    // Pages the bundled model read are not another bundled model's: a new one reads them again.
    const bundled = bundledWhisperModel.name;
    bundledWhisperModel.name = "ggml-next.bin";
    try {
      expect(await (await request("checkpoints", 0, 180)).json()).toEqual([]);
    } finally { bundledWhisperModel.name = bundled; }
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([{ start: 0, end: 60 }, { start: 58, end: 118 }]);
    // The same library can switch engines without reading the previous engine's dialogue evidence.
    const crisper = join(dir, "models", "crisperwhisper"), script = join(crisper, "crisper_cli.py");
    const python = join(crisper, "venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
    for (const file of [python, script, join(crisper, "model", "model.safetensors")]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "fixture", { mode: 0o700 });
    }
    app.ctx.repos.settings.update({ transcription: { localModel: "crisperwhisper" } });
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([]);
    expect((await request("detections", 0, 60)).ok).toBe(true);
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([{ start: 0, end: 60 }]);
    await writeFile(script, "replacement adapter");
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([]);
    app.ctx.repos.settings.update({ transcription: { localModel: "custom" } });
    // An explicitly self-contained adapter receives no weights, even when the editor used this same program with
    // bundled weights before. Updating unused GGML weights does not invalidate the adapter's pages.
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([]);
    expect((await request("detections", 0, 60)).ok).toBe(true);
    bundledWhisperModel.name = "another-ggml.bin";
    try {
      expect(await (await request("checkpoints", 0, 180)).json()).toEqual([{ start: 0, end: 60 }]);
    } finally { bundledWhisperModel.name = bundled; }
    app.ctx.repos.settings.update({ transcription: { localModel: null } });
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([{ start: 0, end: 60 }, { start: 58, end: 118 }]);
    app.ctx.repos.settings.update({ transcription: { language: "fr" } });
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([]);
    expect((await request("detections", 0, 60)).ok).toBe(true);
    await writeFile(source, "different recording at the same path");
    expect(await (await request("checkpoints", 0, 180)).json()).toEqual([]);
  } finally {
    try {
      // If reopening failed, app still refers to the engine we already closed.
      if (!app.ctx.shutdown.aborted) await app.ctx.close();
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it("scans the requested range without a reader, shares foreground work and stops when its edit stops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-background-dialogue-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  let release: (() => void) | undefined;
  let releaseLabels: (() => void) | undefined;
  try {
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Background scan"));
    ctx.paths.ensureProject(project.id);
    const media = ctx.repos.projects.putMedia(project.id,
      { id: "mic", name: "Mic", kind: "audio", path: "mic.wav", duration: 360 }, "ready");
    ctx.repos.transcripts.put({ id: "trs_mic", projectId: project.id, mediaId: media.id, segments: [] });
    await writeFile(join(ctx.paths.media(project.id), media.path), "recording");
    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    const speaker = vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
    vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
    const result = { language: "en", segments: [] };
    const whisper = vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockResolvedValue(result);
    const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
      state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });
    const request = (route: string, from: number, to: number) => app.app.request(`/api/projects/${project.id}/dialogue-${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, mediaId: media.id, from, to }),
    });
    const events = () => ctx.repos.taskEvents.list(task.id).map(e => e.data?.scanPage);
    const holdPage = () => {
      const gate = new Promise<void>(resolve => { release = resolve; });
      whisper.mockImplementationOnce(async () => { await gate; return result; });
    };

    expect((await request("detections", 90, 150)).ok).toBe(true);
    const labels = new Promise<[]>(resolve => { releaseLabels = () => resolve([]); });
    speaker.mockReturnValue(labels);
    holdPage();
    for (const res of await Promise.all([request("scan", 32, 210), request("scan", 32, 210)])) {
      expect(await res.json()).toEqual([{ start: 90, end: 150 }]);
    }
    const reader = request("detections", 32, 92);
    await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(2));
    expect(events()).toEqual([]);
    release!();
    // The scan goes no further than its first page while recording-wide speaker matching is still running: no page
    // can be read before it ends, and it ends sooner alone. Only complete pages count as reviewed evidence.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(whisper).toHaveBeenCalledTimes(2);
    expect(events()).toEqual([]);
    expect(await (await request("checkpoints", 32, 210)).json()).toEqual([{ start: 90, end: 150 }]);
    releaseLabels!();
    expect((await reader).ok).toBe(true);
    await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(4));
    await Promise.all([...ctx.pending]);
    expect(whisper).toHaveBeenCalledTimes(4);
    expect(events()).toEqual([32, 148, 206].map(from => ({ mediaId: media.id, from, to: Math.min(from + 60, 210), end: 210 })));
    const saved = await (await request("scan", 32, 210)).json();
    expect(saved).toHaveLength(4);
    expect(events()).toHaveLength(3);

    holdPage();
    expect((await request("scan", 220, 360)).ok).toBe(true);
    await vi.waitFor(() => expect(whisper).toHaveBeenCalledTimes(5));
    cancelTask(ctx, task);
    release!();
    await Promise.all([...ctx.pending]);
    expect(events()).toHaveLength(3);
    expect(whisper).toHaveBeenCalledTimes(5);
    expect((await request("scan", 220, 360)).status).toBe(409);
  } finally {
    release?.();
    releaseLabels?.();
    await app.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});

it("starts the editor's transcript of a scanned source once per pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-transcript-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  try {
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("First pass"));
    ctx.paths.ensureProject(project.id);
    const media = ctx.repos.projects.putMedia(project.id,
      { id: "mic", name: "Mic", kind: "audio", path: "mic.wav", duration: 360 }, "ready");
    await writeFile(join(ctx.paths.media(project.id), media.path), "recording");
    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
    vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
    vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockResolvedValue({ language: "en", segments: [] });
    const task = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut",
      state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });
    const scan = (from: number) => app.app.request(`/api/projects/${project.id}/dialogue-scan`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, mediaId: media.id, from, to: from + 60 }),
    });
    const transcriptions = () => ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe'", [project.id]);

    expect((await scan(0)).ok).toBe(true);
    expect(transcriptions()).toHaveLength(1);
    expect(transcriptions()[0]).toMatchObject({ context: { mediaId: media.id }, instruction: "Transcribe Mic" });
    await Promise.all([...ctx.pending]);
    expect((await scan(60)).ok).toBe(true);
    expect(transcriptions()).toHaveLength(1);
    cancelTask(ctx, task);
    await Promise.all([...ctx.pending]);
  } finally {
    await app.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});

it("scans for a request sent about a point and for a revision as it does for a whole edit, and for no other task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scarlet-dialogue-kinds-"));
  const app = createApp({ dataDir: dir, skillsSeedDir: dir, env: {}, log: () => {} });
  try {
    const { ctx } = app;
    const project = ctx.repos.projects.insert(createProject("Pinned request"));
    ctx.paths.ensureProject(project.id);
    const media = ctx.repos.projects.putMedia(project.id,
      { id: "mic", name: "Mic", kind: "audio", path: "mic.wav", duration: 360 }, "ready");
    await writeFile(join(ctx.paths.media(project.id), media.path), "recording");
    ctx.repos.settings.update({ transcription: { provider: "whispercpp", whisperCppPath: process.execPath } });
    vi.spyOn(ctx.speakers, "turns").mockResolvedValue([]);
    vi.spyOn(UhmDetector.prototype, "detect").mockResolvedValue([]);
    vi.spyOn(WhisperCppProvider.prototype, "transcribeWav").mockResolvedValue({ language: "en", segments: [] });
    // The background scan and each page the agent reads go through the same door.
    const post = (route: "dialogue-scan" | "dialogue-detections", taskId: string) => app.app.request(`/api/projects/${project.id}/${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken(ctx)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, mediaId: media.id, from: 0, to: 60 }),
    });
    const running = (kind: "note" | "revise" | "skill_edit" | "skill_from_change") => createTask(ctx, { projectId: project.id, kind, agent: "api",
      instruction: "Tighten the pauses here", state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });

    // The message box sends a request about a point as a note, and a call sent back is a revision.
    for (const kind of ["note", "revise"] as const) {
      const task = running(kind);
      expect((await post("dialogue-scan", task.id)).status, kind).toBe(200);
      expect((await post("dialogue-detections", task.id)).status, kind).toBe(200);
      cancelTask(ctx, task);
      await Promise.all([...ctx.pending]);
    }
    // A task that edits no video has no scan: one that writes a skill from an approved edit, or revises a skill.
    for (const kind of ["skill_from_change", "skill_edit"] as const) {
      const task = running(kind);
      for (const route of ["dialogue-scan", "dialogue-detections"] as const) {
        const refused = await post(route, task.id);
        expect(refused.status, `${kind} ${route}`).toBe(404);
        expect(await refused.json()).toMatchObject({ error: { code: "not_found" } });
      }
      cancelTask(ctx, task);
      await Promise.all([...ctx.pending]);
    }
  } finally {
    await app.ctx.close();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
