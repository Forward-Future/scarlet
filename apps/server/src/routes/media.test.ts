import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeWaveformCache } from "@scarlet/render";
import { createProject, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { ffmpeg } from "../render/ffmpeg.js";
import { OpenAIProvider } from "../transcribe/openai.js";
import { transcribeForDialogue } from "../services/ingest.js";
import { previewIdentity } from "../services/previewPictures.js";
import { emissionStorePaths } from "../services/recordingAudio.js";
import { savedSpeakerTurns } from "../services/recordingSpeakers.js";
import { sourcePreviews } from "../services/sourcePreviews.js";
import { createTask, saveTask } from "../services/tasks.js";
import { storeVersion } from "../services/timeline.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-media-routes-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  // Whether speaker analysis runs beside the audio lane depends on the machine's cores. Tests run as a small one does.
  workspace.ctx.speakers.beside = false;
  workspace.ctx.env.openaiKey = "unused-fixture";
  workspace.ctx.repos.settings.update({ transcription: { provider: "openai" } });
  project = workspace.ctx.repos.projects.insert(createProject("Test"));
});
afterEach(async () => {
  if (!workspace.ctx.shutdown.aborted) await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, { method, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
}
const settle = async () => { while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]); };

it.each(["prepare", "dialogue"])("continues saved recognition when a resumed edit requests %s with caching still paused", async entry => {
  const id = "voice";
  const media = workspace.ctx.repos.projects.putMedia(project.id, { id, name: "Voice", path: "voice.wav", kind: "audio", duration: 1200 }, "ready");
  const prepare = () => api("POST", `/projects/${project.id}/media/${id}/prepare`, { kind: "transcript" });
  const first = { id: "segment", text: "bonjour", start: 10, end: 11, words: [] };
  const offsets: number[] = [];
  vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(async ({ checkpoint, signal }) => {
    offsets.push(checkpoint!.through);
    if (offsets.length > 1) return checkpoint!.result;
    checkpoint!.save(600, { language: "fr", segments: [first] }, 0.5);
    return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  expect((await prepare()).status).toBe(202);
  await vi.waitFor(() => expect(offsets).toEqual([0]));
  await api("PATCH", `/projects/${project.id}`, { mediaPaused: true });
  await settle();
  await workspace.ctx.close();
  workspace = createApp({ dataDir: directory, env: { OPENAI_API_KEY: "unused-fixture" }, log: () => {} });
  // An early prepare while idle is still held. It may transfer ownership but must retain the saved chunk.
  expect((await prepare()).status).toBe(202);
  await settle();
  expect(offsets).toEqual([0]);
  createTask(workspace.ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "Read the dialogue", state: "running",
    createdBy: { type: "scarlet", name: "Scarlet" } });
  if (entry === "dialogue") expect(transcribeForDialogue(workspace.ctx, project.id, media)?.state).toBe("running");
  else expect((await prepare()).status).toBe(202);
  await settle();
  expect(offsets).toEqual([0, 600]);
  const savedId = workspace.ctx.repos.projects.getMedia(id)!.transcriptId!;
  expect(workspace.ctx.repos.transcripts.get(savedId)?.segments).toEqual([first]);
});

it("keeps an interrupted local recording off the cloud when automatic preparation finds it", async () => {
  const { ctx } = workspace;
  const media = ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio" }, "ready");
  const last = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", instruction: "Transcribe Voice", state: "running",
    context: { mediaId: media.id, transcribedWith: "whispercpp" }, createdBy: { type: "scarlet", name: "Scarlet" } });
  saveTask(ctx, { ...last, state: "failed", interrupted: true });
  const upload = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  const response = await api("POST", `/projects/${project.id}/media/${media.id}/prepare`, { kind: "transcript" });
  expect(response.status).toBe(409);
  expect(transcribeForDialogue(ctx, project.id, media)).toBeNull();
  expect(upload).not.toHaveBeenCalled();
  expect(ctx.repos.tasks.count("kind = 'transcribe'")).toBe(1);
});

it.each(["waveform", "json"])("keeps a v3 .%s cache available offline and upgrades it when the recording returns", async ext => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  ctx.repos.projects.putMedia(project.id, { id: "mic", kind: "audio", path: "mic.wav", name: "Microphone", duration: 1 }, "ready");
  const old = { duration: 1, pointsPerSecond: 1, peaks: [0.75], rms: [0.5] };
  writeFileSync(join(ctx.paths.waveforms(project.id), "mic.v3." + ext), ext === "json" ? JSON.stringify(old)
    : encodeWaveformCache({ ...old, peaks: Float32Array.from(old.peaks), rms: Float32Array.from(old.rms) }));
  const read = (cachedOnly: boolean) => api("GET", "/media/mic/waveform?points=1&cachedOnly=" + (cachedOnly ? "1" : "0"));
  const decode = vi.spyOn(ctx.render, "extractWaveformFull").mockResolvedValue({
    duration: 1, pointsPerSecond: 1, peaks: Float32Array.of(0.25), rms: Float32Array.of(0.125),
  });
  for (const cachedOnly of [true, false]) expect((await (await read(cachedOnly)).json()).peaks).toEqual([0.75]);
  expect(decode).not.toHaveBeenCalled();
  writeFileSync(join(ctx.paths.media(project.id), "mic.wav"), "fixture");
  expect((await read(true)).status).toBe(404);
  expect((await (await read(false)).json()).peaks).toEqual([0.25]);
  expect((await (await read(true)).json()).peaks).toEqual([0.25]);
  expect(decode).toHaveBeenCalledOnce();
});

it("refuses to transcribe while the project's media processing is paused, and starts once it resumes", async () => {
  const { ctx } = workspace;
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 60 }, "ready");
  await api("PATCH", `/projects/${project.id}`, { mediaPaused: true });
  const refused = await api("POST", "/media/voice/transcribe", {});
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toEqual({ code: "media_paused", message: "Resume caching to transcribe this recording." });
  // No run was started only to be stopped: nothing fails, and nothing is left to retry.
  await settle();
  expect(ctx.repos.tasks.count()).toBe(0);
  expect(cloud).not.toHaveBeenCalled();

  await api("PATCH", `/projects/${project.id}`, { mediaPaused: false });
  expect((await api("POST", "/media/voice/transcribe", {})).status).toBe(202);
  await settle();
  expect(cloud).toHaveBeenCalledTimes(1);
  expect(ctx.repos.projects.getMedia("voice")?.transcriptId).toBeTruthy();
  await api("PATCH", `/projects/${project.id}`, { mediaPaused: true });
  const prepared = await api("POST", `/projects/${project.id}/media/voice/prepare`, { kind: "transcript" });
  expect(await prepared.json()).toEqual({ state: "ready" });
  expect(cloud).toHaveBeenCalledTimes(1);
});

it("refuses a manual transcription if another engine pauses caching before the task is claimed", async () => {
  const { ctx } = workspace;
  const peer = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  try {
    const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
    ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 60 }, "ready");
    const policy = ctx.repos.settings.transcriptionPolicy();
    vi.spyOn(ctx.repos.settings, "transcriptionPolicy").mockImplementationOnce(() => {
      peer.ctx.repos.projects.update(project.id, { mediaPaused: true });
      return policy;
    });
    const refused = await api("POST", "/media/voice/transcribe", {});
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("media_paused");
    expect(ctx.repos.tasks.count()).toBe(0);
    expect(cloud).not.toHaveBeenCalled();
  } finally { await peer.ctx.close(); }
});

it("refuses to transcribe a file with no audio track, as preparing its transcript does", async () => {
  const { ctx } = workspace;
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockResolvedValue({ segments: [] });
  ctx.repos.projects.putMedia(project.id, { id: "silent", name: "Screen capture", path: "silent.mov", kind: "video", duration: 60, hasAudio: false }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "still", name: "Logo", path: "logo.png", kind: "image" }, "ready");
  const noAudio = (name: string) => ({ error: { code: "no_audio", message: `${name} has no audio track.` } });
  for (const [id, name] of [["silent", "Screen capture"], ["still", "Logo"]] as const) {
    const refused = await api("POST", `/media/${id}/transcribe`, {});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual(noAudio(name));
    const prepared = await api("POST", `/projects/${project.id}/media/${id}/prepare`, { kind: "transcript" });
    expect(await prepared.json()).toEqual(noAudio(name));
  }
  await settle();
  expect(ctx.repos.tasks.count()).toBe(0);
  expect(cloud).not.toHaveBeenCalled();
});

it("answers 404 for a frame, loudness or speech of a recording whose file is gone, without an engine error", async () => {
  const { ctx } = workspace;
  const lines: string[] = [];
  ctx.log = line => lines.push(line);
  // The project still lists the recording, but its file was moved or deleted outside Scarlet.
  ctx.paths.ensureProject(project.id);
  ctx.repos.projects.putMedia(project.id, { id: "gone", name: "Interview", path: "gone.mp4", kind: "video", duration: 60, hasAudio: true, fps: 30, width: 1920, height: 1080 }, "ready");
  writeFileSync(join(ctx.paths.waveforms(project.id), "gone.json"), JSON.stringify({ duration: 60, pointsPerSecond: 1, peaks: Array(60).fill(0.5) }));
  const missing = { error: { code: "not_found", message: "source file not found" } };
  for (const path of ["/media/gone/frame?t=1", `/projects/${project.id}/media/gone/loudness`, "/media/gone/waveform?cachedOnly=1&from=0&to=10&speechActivity=1"]) {
    const res = await api("GET", path);
    expect([path, res.status, await res.json()]).toEqual([path, 404, missing]);
  }
  expect(lines.filter(line => line.startsWith("[error]"))).toEqual([]);
});

it("saves which input is the editor's voice only once the recording shows two isolated inputs and their mix", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const media = ctx.paths.media(project.id);
  const tone = (hz: number, when: string) => `0.3*sin(2*PI*${hz}*t)*(${when})`;
  // The host speaks for the first second, the guest for the second, and both in the third. The mix is the middle stream.
  const host = tone(440, "lt(t\\,1)+gte(t\\,2)"), guest = tone(880, "gte(t\\,1)");
  const source = (expr: string) => ["-f", "lavfi", "-i", `aevalsrc=${expr}:d=3:s=8000`];
  await ffmpeg([...source(host), ...source(`${host}+${guest}`), ...source(guest), "-map", "0:a", "-map", "1:a", "-map", "2:a", "-c:a", "pcm_s16le", "-y", join(media, "podcast.mka")]);
  await ffmpeg([...source(host), "-c:a", "pcm_s16le", "-y", join(media, "single.wav")]);
  ctx.repos.projects.putMedia(project.id, { id: "podcast", name: "Podcast", path: "podcast.mka", kind: "audio", duration: 3 }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "single", name: "Single", path: "single.wav", kind: "audio", duration: 3 }, "ready");
  ctx.repos.projects.putMedia(project.id, { id: "gone", name: "Gone", path: "gone.mka", kind: "audio", duration: 3 }, "ready");
  const published: string[] = [];
  ctx.bus.on("ws", event => { if (event.type === "media.updated") published.push(event.media.id); });
  const choose = async (id: string, roles: object, from = 0, to = 3) => {
    const res = await api("PUT", `/media/${id}/voice-roles`, { roles, from, to });
    const body = await res.json();
    return [res.status, body.error?.code ?? body.media.voiceRoles];
  };
  // The reference has to be a stretch of this recording, a minute at most.
  expect(await choose("podcast", { me: 1, other: 3 }, 2, 2)).toEqual([400, "voice_reference"]);
  expect(await choose("podcast", { me: 1, other: 3 }, 0, 3.5)).toEqual([400, "voice_reference"]);
  ctx.repos.projects.putMedia(project.id, { id: "long", name: "Long", path: "podcast.mka", kind: "audio", duration: 600 }, "ready");
  expect(await choose("long", { me: 1, other: 3 }, 0, 61)).toEqual([400, "voice_reference"]);
  expect(await choose("podcast", { me: 2, other: 2 })).toEqual([400, "validation_error"]);
  expect(await choose("gone", { me: 1, other: 3 })).toEqual([404, "not_found"]);
  expect(await choose("single", { me: 1, other: 3 })).toEqual([400, "voice_inputs"]);
  // The second stream is the mix, so it can be nobody's voice. Nor does a stretch where only one of them speaks show which is which.
  expect(await choose("podcast", { me: 2, other: 3 })).toEqual([400, "voice_inputs"]);
  expect(await choose("podcast", { me: 1, other: 3 }, 1.2, 1.8)).toEqual([400, "voice_inputs"]);
  expect(ctx.repos.projects.getMedia("podcast")?.voiceRoles).toBeUndefined();
  expect(published).toEqual([]);

  expect(await choose("podcast", { me: 3, other: 1 })).toEqual([200, { me: 3, other: 1 }]);
  expect(ctx.repos.projects.getMedia("podcast")).toMatchObject({ voiceRoles: { me: 3, other: 1 }, status: "ready" });
  expect(published).toEqual(["podcast"]);
});

it("shows the first frame of a file that is still being imported, and only of a file given by its full path", async () => {
  const { ctx } = workspace;
  const clip = join(directory, "incoming.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=red:size=320x180:rate=30:duration=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip]);
  const frame = (path: unknown, id = project.id) => api("POST", `/projects/${id}/media/import-frame`, { path });
  const shown = await frame(clip);
  expect([shown.status, shown.headers.get("Content-Type"), shown.headers.get("Cache-Control")]).toEqual([200, "image/jpeg", "no-store"]);
  const jpeg = Buffer.from(await shown.arrayBuffer());
  expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  // Nothing is added to the project by looking.
  expect(ctx.repos.projects.listMedia(project.id)).toEqual([]);

  const missing = { error: { code: "not_found", message: "source file not found" } };
  for (const path of [join(directory, "nothing.mp4"), "incoming.mp4", directory]) {
    const res = await frame(path);
    expect([path, res.status, await res.json()]).toEqual([path, 404, missing]);
  }
  expect((await frame(42)).status).toBe(400);
  expect((await frame(clip, "prj_gone")).status).toBe(404);
});

it("takes a file Scarlet couldn't read out of the project with everything kept for it, and refuses one it read or one the video or its history uses", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  const linkedMedia = join(directory, "linked-media");
  symlinkSync(ctx.paths.media(project.id), linkedMedia, "junction");
  vi.spyOn(ctx.paths, "media").mockReturnValue(linkedMedia);
  const dir = { media: ctx.paths.media(project.id), proxies: ctx.paths.proxies(project.id), waveforms: ctx.paths.waveforms(project.id) };
  const add = (id: string, status: "ready" | "failed") => {
    writeFileSync(join(dir.media, `${id}.mov`), id);
    return ctx.repos.projects.putMedia(project.id, { id, name: `${id}.mov`, path: `${id}.mov`, kind: "video", duration: 60, hasAudio: true, height: 1080 },
      status, status === "failed" ? "Source changed while fingerprinting. Reimport the recording." : undefined);
  };
  add("read", "ready");
  add("placed", "failed");
  const broken = add("broken", "failed");
  // What preparing and previewing the file left: a waveform, a proxy, preview chunks, a transcript and scan pages.
  const { local } = await previewIdentity(dir.media, broken);
  mkdirSync(join(dir.proxies, `source-${local}`));
  for (const kept of [join(dir.waveforms, "broken.json"), join(dir.proxies, "broken.mp4"), join(dir.proxies, `source-${local}`, "v1-480-0.mp4"), join(dir.proxies, `cached-${local}.mp4`)]) writeFileSync(kept, "x");
  ctx.repos.transcripts.put({ id: "trs_broken", projectId: project.id, mediaId: "broken", segments: [] });
  ctx.db.prepare("INSERT INTO dialogue_scan_pages VALUES ('broken', 'f', 0, 60, '{}')").run();
  // Emissions include older files named for the import path. Another recording's stores and speaker turns stay.
  const emissions = (id: string) => {
    const imported = join(dir.media, `${id}.mov`);
    return emissionStorePaths(ctx, project.id, realpathSync(imported), imported);
  };
  const others = [...await emissions("read"), (await savedSpeakerTurns(ctx, project.id, ctx.repos.projects.getMedia("read")!))!];
  const brokenStores = await emissions("broken");
  expect(brokenStores.length).toBeGreaterThan(1);
  for (const kept of [...brokenStores, (await savedSpeakerTurns(ctx, project.id, broken))!, ...others]) writeFileSync(kept, "x");
  // A clip from a file placed while it was still being added. This version is in the history, not the working video.
  storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "placed", [{ start: 0, end: 4 }]), { parent: null });
  const events: string[] = [];
  ctx.bus.on("ws", event => { if (event.type === "media.removed") events.push(event.mediaId); });
  const remove = async (id: string, from = project.id) => {
    const res = await api("DELETE", `/projects/${from}/media/${id}`);
    return [res.status, (await res.json()).error?.message];
  };

  expect(await remove("read")).toEqual([409, "Scarlet read read.mov, and can only remove a file it couldn’t read."]);
  expect(await remove("placed")).toEqual([409, "placed.mov is in the video or its history, so it can’t be removed."]);
  expect(await remove("broken", "prj_other")).toEqual([404, "project prj_other not found"]);
  expect(ctx.repos.projects.listMedia(project.id).map(m => m.id)).toEqual(["read", "placed", "broken"]);
  expect(events).toEqual([]);

  expect(await remove("broken")).toEqual([200, undefined]);
  expect(events).toEqual(["broken"]);
  expect(ctx.repos.projects.listMedia(project.id).map(m => m.id)).toEqual(["read", "placed"]);
  expect(ctx.repos.transcripts.count("media_id = 'broken'")).toBe(0);
  expect(ctx.db.prepare("SELECT count(*) AS n FROM dialogue_scan_pages").get()).toEqual({ n: 0 });
  // Its original is gone with the rest. The other files' originals are untouched.
  expect(readdirSync(dir.media).sort()).toEqual(["placed.mov", "read.mov"]);
  expect([readdirSync(dir.proxies), readdirSync(dir.waveforms).map(name => join(dir.waveforms, name)).sort()]).toEqual([[], [...new Set(others)].sort()]);
  expect(existsSync(join(dir.media, "broken.mov"))).toBe(false);
  // The project's history says who took it out.
  expect(ctx.repos.activity.select("type = 'media.removed'").map(a => a.summary)).toEqual([expect.stringMatching(/^\S.* removed “broken\.mov”, which couldn't be read$/)]);
  // It is gone, so asking again finds nothing.
  expect(await remove("broken")).toEqual([404, "media broken not found"]);
});

it("stops a transcription the editor started on an unreadable file before taking the file out", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  writeFileSync(join(ctx.paths.media(project.id), "broken.wav"), "x");
  ctx.repos.projects.putMedia(project.id, { id: "broken", name: "broken.wav", path: "broken.wav", kind: "audio", duration: 60, hasAudio: true }, "failed", "Unreadable");
  let stopped = false;
  vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(({ signal }) => new Promise((_, reject) => {
    signal!.addEventListener("abort", () => { stopped = true; reject(new Error("aborted")); });
  }));
  const { task } = await (await api("POST", "/media/broken/transcribe", {})).json();
  expect(task.state).toBe("running");
  expect((await api("DELETE", `/projects/${project.id}/media/broken`)).status).toBe(200);
  expect(stopped).toBe(true);
  await settle();
  // The run ended as cancelled, not as a failure to retry, and left no transcript for a file that is gone.
  expect(ctx.repos.tasks.get(task.id)?.state).toBe("cancelled");
  expect(ctx.repos.transcripts.count()).toBe(0);
  expect(ctx.repos.projects.getMedia("broken")).toBeNull();
});

it("leaves an unreadable file alone while Scarlet is working on a request, which may be reading it", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  writeFileSync(join(ctx.paths.media(project.id), "broken.wav"), "x");
  ctx.repos.projects.putMedia(project.id, { id: "broken", name: "broken.wav", path: "broken.wav", kind: "audio", duration: 60, hasAudio: true }, "failed", "Unreadable");
  // A dialogue pass scans a file of any status: it has saved a page of this one and started its transcript.
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "First cut", createdBy: { type: "scarlet", name: "Scarlet" }, state: "running" });
  ctx.db.prepare("INSERT INTO dialogue_scan_pages VALUES ('broken', 'f', 0, 60, '{}')").run();
  let stopped = false;
  vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(({ signal }) => new Promise((_, reject) => {
    signal!.addEventListener("abort", () => { stopped = true; reject(new Error("aborted")); });
  }));
  const { task } = await (await api("POST", "/media/broken/transcribe", {})).json();
  const remove = async () => {
    const res = await api("DELETE", `/projects/${project.id}/media/broken`);
    return [res.status, (await res.json()).error];
  };
  const busy = [409, { code: "media_busy", message: "Scarlet is working on a request, so broken.wav can’t be removed until it’s done." }];

  expect(await remove()).toEqual(busy);
  // A request waiting on the editor can carry on with the file once they answer.
  saveTask(ctx, { ...ctx.repos.tasks.get(pass.id)!, state: "waiting_for_user" });
  expect(await remove()).toEqual(busy);
  // Nothing of the pass's was stopped or deleted: its transcription runs on, and its next page still has a file to belong to.
  expect([stopped, ctx.repos.tasks.get(task.id)?.state]).toEqual([false, "running"]);
  expect(ctx.db.prepare("SELECT count(*) AS n FROM dialogue_scan_pages").get()).toEqual({ n: 1 });
  expect(() => ctx.db.prepare("INSERT INTO dialogue_scan_pages VALUES ('broken', 'f', 60, 120, '{}')").run()).not.toThrow();
  expect(existsSync(join(ctx.paths.media(project.id), "broken.wav"))).toBe(true);
  expect(ctx.repos.activity.count("type = 'media.removed'")).toBe(0);

  // Another project's request doesn't hold it, and neither does this one once it has ended.
  const elsewhere = ctx.repos.projects.insert(createProject("Other"));
  createTask(ctx, { projectId: elsewhere.id, kind: "edit", agent: "api", instruction: "Cut", createdBy: { type: "scarlet", name: "Scarlet" }, state: "running" });
  saveTask(ctx, { ...ctx.repos.tasks.get(pass.id)!, state: "done" });
  expect(await remove()).toEqual([200, undefined]);
  expect(ctx.repos.projects.getMedia("broken")).toBeNull();
  await settle();
});

it("checks again as the file goes, so a clip placed or a second removal sent meanwhile doesn't lose or double it", async () => {
  const { ctx } = workspace;
  ctx.paths.ensureProject(project.id);
  for (const id of ["placed", "twice"]) {
    writeFileSync(join(ctx.paths.media(project.id), `${id}.mov`), id);
    ctx.repos.projects.putMedia(project.id, { id, name: `${id}.mov`, path: `${id}.mov`, kind: "video", duration: 60, hasAudio: true, height: 1080 }, "failed", "Unreadable");
  }
  const events: string[] = [];
  ctx.bus.on("ws", event => { if (event.type === "media.removed") events.push(event.mediaId); });
  const remove = async (id: string) => {
    const res = await api("DELETE", `/projects/${project.id}/media/${id}`);
    return [res.status, (await res.json()).error?.message];
  };

  // The clip is placed after the removal was let through, while it looks up what the file left on disk.
  const filesOf = sourcePreviews.filesOf.bind(sourcePreviews);
  const lookup = vi.spyOn(sourcePreviews, "filesOf").mockImplementationOnce(async (...args) => {
    storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "placed", [{ start: 0, end: 4 }]), { parent: null });
    return filesOf(...args);
  });
  expect(await remove("placed")).toEqual([409, "placed.mov is in the video or its history, so it can’t be removed."]);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(ctx.repos.projects.getMedia("placed")?.status).toBe("failed");
  expect(existsSync(join(ctx.paths.media(project.id), "placed.mov"))).toBe(true);

  // Two removals of one file sent together take it out once: the second finds it gone.
  expect((await Promise.all([remove("twice"), remove("twice")])).sort()).toEqual([[200, undefined], [404, "media twice not found"]]);
  expect(events).toEqual(["twice"]);
  expect(ctx.repos.activity.count("type = 'media.removed'")).toBe(1);
  expect(ctx.repos.projects.listMedia(project.id).map(m => m.id)).toEqual(["placed"]);
});

it("returns a retryable shutdown response for an import interrupted during its probe", async () => {
  const { ctx } = workspace;
  const file = join(directory, "interview.mov");
  writeFileSync(file, "fixture");
  let probing!: () => void;
  const began = new Promise<void>(resolve => { probing = resolve; });
  vi.spyOn(ctx.render, "probeMedia").mockImplementation(async (_file, signal) => {
    probing();
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const request = api("POST", `/projects/${project.id}/media/import`, { path: file });
  await began;
  const closing = ctx.close();
  const response = await request;
  await closing;
  expect(response.status).toBe(503);
  expect(readdirSync(ctx.paths.media(project.id))).toEqual([]);
});
