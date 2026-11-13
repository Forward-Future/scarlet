import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type Project } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { OpenAIProvider } from "../transcribe/openai.js";
import { createTask, saveTask } from "../services/tasks.js";
import { sourcePreviews } from "../services/sourcePreviews.js";

let directory: string;
let workspace: ScarletApp;
let project: Project;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-project-routes-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  // Whether speaker analysis runs beside the audio lane depends on the machine's cores. Tests run as a small one does.
  workspace.ctx.speakers.beside = false;
  workspace.ctx.env.openaiKey = "unused-fixture";
  workspace.ctx.repos.settings.update({ transcription: { provider: "openai" } });
  project = workspace.ctx.repos.projects.insert(createProject("Test"));
});
afterEach(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function api(method: string, path: string, body?: unknown) {
  return workspace.app.request("/api" + path, { method, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) } });
}

it("starts a transcription the pause cut off again as soon as media processing resumes", async () => {
  const { ctx } = workspace;
  // The first run goes on until it is stopped, as a long recording's does. The one that replaces it finishes.
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe")
    .mockImplementationOnce(({ signal }) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })))
    .mockResolvedValue({ segments: [] });
  ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 60 }, "ready");
  const latest = () => ctx.repos.tasks.select("kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = 'voice'", [], "created_at, rowid").at(-1)!;
  const { task } = await (await api("POST", "/media/voice/transcribe", {})).json();
  await vi.waitFor(() => expect(cloud).toHaveBeenCalledTimes(1));

  await api("PATCH", `/projects/${project.id}`, { mediaPaused: true });
  await vi.waitFor(() => expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "failed", interrupted: true }));
  expect(latest().id).toBe(task.id);

  // Resume answers with the new run already going, without the 30 s recovery sweep.
  await api("PATCH", `/projects/${project.id}`, { mediaPaused: false });
  expect(latest().id).not.toBe(task.id);
  while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
  expect(latest().state).toBe("done");
  expect(cloud).toHaveBeenCalledTimes(2);
  expect(ctx.repos.projects.getMedia("voice")?.transcriptId).toBeTruthy();
});

it("leaves transcription running through a pause while Scarlet is working on a request, and stops it when nothing is under way", async () => {
  const { ctx } = workspace;
  // Each run goes on until the test finishes it or its signal stops it, as a long recording's does.
  const runs: Array<{ signal: AbortSignal; finish(): void }> = [];
  vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(({ signal }) => new Promise((resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    runs.push({ signal: signal!, finish: () => resolve({ segments: [] }) });
  }));
  for (const id of ["camera", "screen", "broll"]) ctx.repos.projects.putMedia(project.id, { id, name: id, path: id + ".wav", kind: "audio", duration: 60 }, "ready");
  const latest = (id: string) => ctx.repos.tasks.select("kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?", [id], "created_at, rowid").at(-1)!;
  const settle = async () => { while (ctx.pending.size) await Promise.allSettled([...ctx.pending]); };
  const pause = (mediaPaused: boolean) => api("PATCH", `/projects/${project.id}`, { mediaPaused });

  // The editor asked for a pass while the camera's transcript was still being made, then paused the caching.
  await api("POST", "/media/camera/transcribe", {});
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  const pass = createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "/first-cut-dialogue",
    state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });
  await pause(true);
  // The pass can't plan or cut without that transcript, so the pause leaves it running.
  expect([runs[0]!.signal.aborted, latest("camera").state]).toEqual([false, "running"]);
  // The pass asks for its other recording's transcript, which starts though the project is paused.
  expect((await api("POST", `/projects/${project.id}/media/screen/prepare`, { kind: "transcript" })).status).toBe(202);
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1]!.signal.aborted).toBe(false);
  for (const run of runs) run.finish();
  await settle();
  expect([latest("camera").state, latest("screen").state]).toEqual(["done", "done"]);

  // With no request under way, a transcript asked for while paused stops as it starts, before anything is sent. The
  // short run that reads a request for a standing rule isn't one: it edits nothing and uses no transcript.
  saveTask(ctx, { ...ctx.repos.tasks.get(pass.id)!, state: "done", finishedAt: new Date().toISOString() });
  createTask(ctx, { projectId: project.id, kind: "learning_check", agent: "api", instruction: "Read the request for a rule",
    state: "running", createdBy: { type: "scarlet", name: "Scarlet" } });
  expect((await api("POST", `/projects/${project.id}/media/broll/prepare`, { kind: "transcript" })).status).toBe(202);
  await vi.waitFor(() => expect(latest("broll")).toMatchObject({ state: "failed", interrupted: true }));
  expect(runs).toHaveLength(2);
  // Resume starts it, and the next pause stops it where it is.
  await pause(false);
  await vi.waitFor(() => expect(runs).toHaveLength(3));
  const resumed = latest("broll").id;
  await pause(true);
  await vi.waitFor(() => expect(ctx.repos.tasks.get(resumed)).toMatchObject({ state: "failed", interrupted: true }));
  expect(runs[2]!.signal.aborted).toBe(true);
  // Resume starts it again, and it finishes.
  await pause(false);
  await vi.waitFor(() => expect(runs).toHaveLength(4));
  runs[3]!.finish();
  await settle();
  expect(latest("broll").state).toBe("done");
});

it("stops a transcription when another engine pauses the project", async () => {
  const { ctx } = workspace;
  const peer = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  try {
    let stopped = false;
    const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe").mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => { stopped = true; reject(signal!.reason); }, { once: true });
    }));
    ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 60 }, "ready");
    const { task } = await (await api("POST", "/media/voice/transcribe", {})).json() as { task: { id: string } };
    await vi.waitFor(() => expect(cloud).toHaveBeenCalledTimes(1));
    // The other engine's window paused the caching. This engine sees it within a second or so, and nothing is running here to spare.
    peer.ctx.repos.projects.update(project.id, { mediaPaused: true });
    await vi.waitFor(() => expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "failed", interrupted: true }), { timeout: 5000 });
    expect(stopped).toBe(true);
  } finally {
    await peer.ctx.close();
  }
});

it("lists what Scarlet is doing in each project: a request it is on, then files importing, transcribing and caching", async () => {
  const { ctx } = workspace;
  const other = ctx.repos.projects.insert(createProject("Idle"));
  const activity = async () => Object.fromEntries(((await (await api("GET", "/projects")).json()).projects as Array<{ id: string; activity?: unknown }>)
    .map(p => [p.id, p.activity]));
  expect(await activity()).toEqual({ [project.id]: undefined, [other.id]: undefined });

  const scarlet = { type: "scarlet", name: "Scarlet" } as const;
  createTask(ctx, { projectId: project.id, kind: "edit", agent: "api", instruction: "/first-cut-dialogue", state: "running", createdBy: scarlet });
  // A question waits on the editor, so it is counted with what needs them, not as work under way; a skill's edit isn't the project's.
  createTask(ctx, { projectId: other.id, kind: "edit", agent: "api", instruction: "Tighten it", state: "waiting_for_user", createdBy: scarlet });
  createTask(ctx, { projectId: other.id, kind: "skill_edit", agent: "api", instruction: "Shorter pauses", state: "running", createdBy: scarlet });
  ctx.repos.projects.putMedia(project.id, { id: "incoming", name: "Incoming", path: "incoming.mov", kind: "video" }, "ingesting");
  // Two transcriptions, one a quarter done and one waiting its turn: an eighth of the work.
  const running = createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", instruction: "", state: "running", createdBy: scarlet,
    context: { mediaId: "incoming" } });
  saveTask(ctx, { ...running, progress: { stage: "transcribing", fraction: 0.25 } });
  createTask(ctx, { projectId: project.id, kind: "transcribe", agent: "api", instruction: "", state: "queued", createdBy: scarlet });
  // Two videos of the same length: one cached earlier, one waiting to cache. Half the footage is cached.
  for (const id of ["camera", "screen"]) {
    ctx.repos.projects.putMedia(project.id, { id, name: id, path: id + ".mov", kind: "video", duration: 60, previewMode: "on-demand" }, "ready");
  }
  vi.spyOn(sourcePreviews, "full").mockImplementation(async (_, media) => ({ status: { state: media.id === "camera" ? "ready" : "uncached" } }));
  ctx.db.prepare("INSERT INTO source_cache_requests VALUES ('screen', NULL)").run();

  expect(await activity()).toEqual({
    [project.id]: [
      { kind: "editing", count: 1 },
      { kind: "importing", count: 1 },
      { kind: "transcribing", count: 2, fraction: 0.125 },
      { kind: "caching", count: 1, fraction: 0.5 },
    ],
    [other.id]: undefined,
  });

  // Paused, the caching is held; the transcription still running goes on, as a pass waiting for it needs.
  ctx.repos.projects.update(project.id, { mediaPaused: true });
  expect((await activity())[project.id]).toContainEqual({ kind: "caching", count: 1, fraction: 0.5, paused: true });
  expect((await activity())[project.id]).toContainEqual({ kind: "transcribing", count: 2, fraction: 0.125 });
});
