import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Change, createProject, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import { ATTEMPT_HEADER, TASK_HEADER, type ProjectSummary, type Task } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { OpenAIProvider } from "../transcribe/openai.js";
import { appendTaskEvent, createTask, saveTask, taskPrompt } from "../services/tasks.js";
import { storeVersion } from "../services/timeline.js";
import { sourcePreviews } from "../services/sourcePreviews.js";
import { recoverTasks } from "../services/taskRecovery.js";

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

function api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return workspace.app.request("/api" + path, { method, body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }), ...headers } });
}

it("reads live project metadata without loading timelines or counting project activity", async () => {
  const { ctx } = workspace;
  const path = "/projects/" + project.id;
  ctx.repos.projects.putMedia(project.id, { id: "camera", name: "Camera", kind: "video", path: "camera.mov" }, "ready");
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 12 }]), { parent: null });
  const timeline = vi.spyOn(ctx.repos.versions, "get");
  const summary = vi.spyOn(ctx.repos.projects, "summaries");
  const media = vi.spyOn(ctx.repos.projects, "listMedia");
  const header = () => api("GET", path + "?view=header").then(r => r.json());
  expect(await header()).toEqual({ project: { id: project.id, head: null, settings: project.settings } });
  expect(media).not.toHaveBeenCalled();
  ctx.repos.projects.update(project.id, { head: version });
  media.mockClear();
  expect((await header()).project.head).toBe(version);
  expect(media).not.toHaveBeenCalled();
  expect(await (await api("GET", path + "?view=project")).json()).toEqual({ project: ctx.repos.projects.get(project.id) });
  expect(timeline).not.toHaveBeenCalled();
  expect(summary).not.toHaveBeenCalled();
  ctx.repos.projects.softDelete(project.id);
  for (const view of ["project", "header"]) expect((await api("GET", path + "?view=" + view)).status).toBe(404);
});

it("projects simultaneous edit lists from one history read and returns just the requested threads", async () => {
  const { ctx } = workspace;
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 120 }]), { parent: null });
  ctx.repos.projects.update(project.id, { head: version });
  for (const [i, threadId] of ["one", "__proto__", "three"].entries()) {
    ctx.repos.changes.put(Change.parse({ id: "change" + i, threadId, projectId: project.id, state: "approved",
      fromVersion: version, toVersion: version, ranges: [{ start: i, end: i + 1 }], description: "Edit " + i,
      author: { type: "agent", name: "Scarlet" }, createdAt: "2026-01-01T00:00:00Z" }));
  }
  const path = "/projects/" + project.id;
  const one = await (await api("GET", path + "/threads/one/edits")).json();
  const special = await (await api("GET", path + "/threads/__proto__/edits")).json();
  const readHistory = vi.spyOn(ctx.repos.projects, "threads");
  const result = await api("POST", path + "/thread-edits", { threads: ["one", "__proto__", "missing", "one"] });
  expect(result.status).toBe(200);
  expect(readHistory).toHaveBeenCalledTimes(1);
  expect(await result.json()).toEqual({ version, lists: { one: one.edits, ["__proto__"]: special.edits } });
  expect(one.edits[0].changeId).toBe("change0");
  expect(special.edits[0].changeId).toBe("change1");
});

it("fails only the thread whose edit list cannot be projected", async () => {
  const { ctx } = workspace;
  const { version } = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 120 }]), { parent: null });
  ctx.repos.projects.update(project.id, { head: version });
  for (const [i, threadId] of ["one", "broken"].entries()) {
    ctx.repos.changes.put(Change.parse({ id: "change" + i, threadId, projectId: project.id, state: "approved",
      fromVersion: version, toVersion: version, ranges: [{ start: i, end: i + 1 }], description: "Edit " + i,
      author: { type: "agent", name: "Scarlet" }, createdAt: "2026-01-01T00:00:00Z" }));
  }
  const threads = ctx.repos.projects.threads.bind(ctx.repos.projects);
  vi.spyOn(ctx.repos.projects, "threads").mockImplementation(id =>
    threads(id).map(thread => thread.id === "broken" ? { ...thread, tasks: 5 as never } : thread));
  const path = "/projects/" + project.id;
  const result = await api("POST", path + "/thread-edits", { threads: ["one", "broken"] });
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.lists.one[0].changeId).toBe("change0");
  expect(body.lists).not.toHaveProperty("broken");
  expect(body.failed.broken).toMatch(/not a function/);
  expect((await api("GET", path + "/threads/broken/edits")).status).toBe(500);
});

it("stops editing across the project and continues interrupted requests ahead of the queue", async () => {
  const { ctx } = workspace;
  const path = `/projects/${project.id}`;
  const other = ctx.repos.projects.insert(createProject("Other"));
  const make = (kind: Task["kind"], state?: Task["state"], projectId = project.id) => createTask(ctx, {
    projectId, kind, agent: kind === "transcribe" ? "api" : "claude", instruction: "Fixture",
    state, createdBy: { type: "scarlet", name: "Scarlet" },
  });
  const { host } = await (await api("POST", "/hosts/register", { name: "Host", platform: "test", agents: [{ id: "claude", installed: true }] })).json();
  const claim = async (taskId?: string, wait = 0): Promise<Task | null> => {
    const result = await api("POST", `/hosts/${host.id}/claim?wait=${wait}`, { taskId });
    expect(result.status).toBe(200);
    return (await result.json()).task;
  };
  const active = make("edit");
  const running = saveTask(ctx, { ...(await claim(active.id))!, state: "running" });
  const attempt = { [TASK_HEADER]: running.id, [ATTEMPT_HEADER]: running.startedAt! };
  const proposal = { description: "Keep a marker", intent: "requested", skipRender: true,
    ops: [{ op: "addMarker", marker: { id: "marker", time: 0, text: "Keep" } }] };
  const saved = await api("POST", `${path}/changes`, proposal, attempt);
  expect(saved.status).toBe(201);
  const { change } = await saved.json();
  expect((await api("POST", `/changes/${change.id}/approve`, {})).status).toBe(200);
  const beforeStop = ctx.repos.projects.get(project.id)!;
  const claimed = make("revise", "claimed");
  const question = saveTask(ctx, {
    ...appendTaskEvent(ctx, make("note", "running"), { type: "question", text: "Which take?" }).task,
    session: { agent: "claude", id: "existing-session" },
  });
  // Answered and back in line, its CLI session yielded: no worker has it.
  const answered = saveTask(ctx, {
    ...appendTaskEvent(ctx, appendTaskEvent(ctx, make("note", "running"), { type: "question", text: "Which side?" }).task,
      { type: "answer", text: "Left." }).task,
    session: { agent: "claude", id: "answered-session" },
  });
  // A call can work ahead of an older queued edit. Previously active work still comes first after Continue.
  const first = saveTask(ctx, { ...make("edit"), createdAt: "2026-01-01T00:00:00.000Z" });
  const second = make("revise");
  const transcription = make("transcribe", "running");
  const learning = make("learning_check");
  const skill = make("skill_edit", "running");
  const elsewhere = make("edit", "running", other.id);
  const announcements: string[] = [];
  ctx.bus.on("ws", event => {
    if (event.type === "project.updated" && event.project.editingPaused && event.projectId === project.id) announcements.push("paused");
    if (event.type === "task.updated" && event.task.state === "cancelled") announcements.push(event.task.id);
  });

  const stop = await api("POST", `${path}/stop-editing`);
  expect(stop.status).toBe(200);
  const stopped = await stop.json() as { project: Project; tasks: Task[] };
  expect(stopped.project).toMatchObject({ editingPaused: true, head: beforeStop.head, updatedAt: beforeStop.updatedAt,
    rowRevision: beforeStop.rowRevision! + 1 });
  expect(stopped.tasks.filter(task => task.state === "cancelled").map(task => task.id)).toEqual([running.id, claimed.id]);
  const nextFor = (id: string) => stopped.tasks.find(task => task.resumeRootId === id)!;
  for (const original of [running, claimed]) {
    const next = nextFor(original.id);
    expect(next).toMatchObject({ kind: original.kind, agent: original.agent, state: "queued", resumesAfterProjectStop: true });
    expect(next.startedAt).toBeUndefined();
    expect(ctx.repos.tasks.get(original.id)?.retryTaskId).toBe(next.id);
  }
  const [continuing, removed] = [running, claimed].map(task => nextFor(task.id));
  // Neither the question nor the answered run held a worker, so Stop leaves them, their words and their sessions.
  expect(ctx.repos.tasks.get(question.id)).toEqual(question);
  expect(ctx.repos.tasks.get(answered.id)).toEqual(answered);
  expect(continuing!.instruction).toContain(`Saved change ${change.id} [approved]`);
  expect(stopped.tasks).toHaveLength(4);
  expect(announcements[0]).toBe("paused");
  expect(announcements).toHaveLength(3);
  expect(ctx.repos.changes.get(change.id)?.state).toBe("approved");
  expect((await api("POST", `${path}/changes`, proposal, attempt)).status).toBe(409);
  expect(ctx.repos.tasks.get(transcription.id)?.state).toBe("running");
  expect(ctx.repos.tasks.get(skill.id)?.state).toBe("running");
  expect(ctx.repos.tasks.get(elsewhere.id)?.state).toBe("running");
  const { projects } = await (await api("GET", "/projects")).json() as { projects: ProjectSummary[] };
  expect(projects.find(p => p.id === project.id)?.activity).toEqual([{ kind: "transcribing", count: 1 }]);
  expect((await (await api("GET", "/under-way")).json()).queued).toBe(0);

  expect(await claim(first.id)).toBeNull();
  // A read of a request for a rule is held with the requests: it runs on Resume.
  expect(await claim(learning.id)).toBeNull();
  const skillFromChange = make("skill_from_change");
  expect((await claim())?.id).toBe(skillFromChange.id);
  const addedWhilePaused = make("note");
  expect(await claim()).toBeNull();
  expect((await (await api("POST", `${path}/stop-editing`)).json()).tasks).toEqual([]);
  // The editor can answer while editing is stopped. The run waits for Continue.
  expect((await api("POST", `/tasks/${question.id}/answer`, { text: "Use the second take." })).status).toBe(200);
  expect(await claim()).toBeNull();
  expect((await api("POST", `/tasks/${removed!.id}/cancel?queuedOnly=1`)).status).toBe(200);
  expect(ctx.repos.tasks.get(removed!.id)?.state).toBe("cancelled");
  for (const task of [first, second, addedWhilePaused]) expect(ctx.repos.tasks.get(task.id)).toEqual(task);
  for (const task of [elsewhere, transcription, learning, skill, skillFromChange]) {
    saveTask(ctx, { ...ctx.repos.tasks.get(task.id)!, state: "done" });
  }

  await ctx.close();
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  expect((await (await api("GET", `${path}?view=workspace`)).json()).project.editingPaused).toBe(true);
  expect(await claim()).toBeNull();
  const waiting = claim(undefined, 5);
  await vi.waitFor(() => expect(workspace.ctx.bus.listenerCount("task.queued")).toBeGreaterThan(0));
  const resumed = await api("POST", `${path}/resume-editing`);
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ project: { editingPaused: false, rowRevision: beforeStop.rowRevision! + 2 } });
  // Interrupted work goes first, then the runs that were waiting on the editor, each in its own CLI session.
  const next = await waiting;
  expect(next?.id).toBe(continuing!.id);
  expect((await api("POST", `/tasks/${next!.id}/cancel?queuedOnly=1`)).status).toBe(409);
  expect((await api("POST", `/tasks/${next!.id}/complete`, { state: "done", ifStartedAt: next!.startedAt })).status).toBe(200);
  // The runs that were waiting on the editor carry on in their own CLI sessions, in their places in the queue.
  const sessions = new Map([[question.id, ["existing-session", "Use the second take."]], [answered.id, ["answered-session", "Left."]]]);
  const order: string[] = [];
  for (let claimed = await claim(); claimed; claimed = await claim()) {
    order.push(claimed.id);
    const [session, text] = sessions.get(claimed.id) ?? [];
    if (session) {
      expect(taskPrompt(workspace.ctx, claimed)).toMatchObject({ resumeSession: session });
      expect(taskPrompt(workspace.ctx, claimed).instruction).toContain(text);
    }
    expect((await api("POST", `/tasks/${claimed.id}/complete`, { state: "done", ifStartedAt: claimed.startedAt })).status).toBe(200);
  }
  expect(order[0]).toBe(first.id);
  expect(order).toEqual(expect.arrayContaining([question.id, answered.id, second.id, addedWhilePaused.id]));
});

it("stops just one edit and lets the next queued request start", async () => {
  const { ctx } = workspace;
  const make = (kind: Task["kind"]) => createTask(ctx, {
    projectId: project.id, kind, agent: "claude", instruction: "Fixture",
    createdBy: { type: "scarlet", name: "Scarlet" },
  });
  const { host } = await (await api("POST", "/hosts/register", { name: "Host", platform: "test", agents: [{ id: "claude", installed: true }] })).json();
  const claim = async () => (await (await api("POST", `/hosts/${host.id}/claim`, {})).json()).task as Task | null;
  const editing = make("edit");
  expect((await claim())?.id).toBe(editing.id);
  const next = make("note");
  expect((await api("POST", `/tasks/${editing.id}/cancel`)).status).toBe(200);
  expect(ctx.repos.tasks.get(editing.id)?.state).toBe("cancelled");
  expect(ctx.repos.tasks.get(editing.id)?.retryTaskId).toBeUndefined();
  expect(ctx.repos.projects.get(project.id)?.editingPaused).toBe(false);
  expect((await claim())?.id).toBe(next.id);
});

it("removes a request from the queue without stopping an edit that has already started", async () => {
  const { ctx } = workspace;
  const make = (state: Task["state"]) => createTask(ctx, {
    projectId: project.id, kind: "edit", agent: "claude", instruction: "Fixture", state,
    createdBy: { type: "scarlet", name: "Scarlet" },
  });
  const running = make("running");
  const queued = make("queued");
  const remove = (task: Task) => api("POST", `/tasks/${task.id}/cancel?queuedOnly=1`);
  expect((await remove(running)).status).toBe(409);
  expect(ctx.repos.tasks.get(running.id)?.state).toBe("running");
  expect((await remove(queued)).status).toBe(200);
  expect((await remove(queued)).status).toBe(200);
  expect(ctx.repos.tasks.get(queued.id)?.state).toBe("cancelled");
  expect(ctx.repos.projects.get(project.id)?.editingPaused).toBe(false);
});

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

it("restarts transcription after abort cleanup when media processing is already resumed", async () => {
  const { ctx } = workspace;
  const finishAbort = Promise.withResolvers<void>();
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe")
    .mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => void finishAbort.promise.then(() => reject(signal!.reason)), { once: true });
    }))
    .mockResolvedValue({ segments: [] });
  ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 60 }, "ready");
  const { task } = await (await api("POST", "/media/voice/transcribe", {})).json();
  try {
    await vi.waitFor(() => expect(cloud).toHaveBeenCalledTimes(1));
    await api("PATCH", `/projects/${project.id}`, { mediaPaused: true });
    await api("PATCH", `/projects/${project.id}`, { mediaPaused: false });
    expect(ctx.repos.tasks.get(task.id)?.state).toBe("running");
  } finally {
    finishAbort.resolve();
  }
  while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
  expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "failed", interrupted: true });
  expect(cloud).toHaveBeenCalledTimes(2);
  expect(ctx.repos.projects.getMedia("voice")?.transcriptId).toBeTruthy();
});

it("interrupts a transcription when the project goes to the trash, and starts it again after Restore", async () => {
  const { ctx } = workspace;
  const cloud = vi.spyOn(OpenAIProvider.prototype, "transcribe")
    .mockImplementationOnce(({ signal }) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })))
    .mockResolvedValue({ segments: [] });
  ctx.repos.projects.putMedia(project.id, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 60 }, "ready");
  const latest = () => ctx.repos.tasks.select("kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = 'voice'", [], "created_at, rowid").at(-1)!;
  const { task } = await (await api("POST", "/media/voice/transcribe", {})).json();
  await vi.waitFor(() => expect(cloud).toHaveBeenCalledTimes(1));

  // A cancelled transcription is final, so the trash only interrupts it.
  expect((await api("DELETE", `/projects/${project.id}`)).status).toBe(200);
  await vi.waitFor(() => expect(ctx.repos.tasks.get(task.id)).toMatchObject({ state: "failed", interrupted: true }));
  // Nothing starts it again while the project is in the trash.
  recoverTasks(ctx);
  expect(latest().id).toBe(task.id);

  expect((await api("POST", `/projects/${project.id}/restore`)).status).toBe(200);
  recoverTasks(ctx);
  expect(latest().id).not.toBe(task.id);
  while (ctx.pending.size) await Promise.allSettled([...ctx.pending]);
  expect(latest().state).toBe("done");
  expect(cloud).toHaveBeenCalledTimes(2);
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
  // The import is held once the engine reading it lets go of it, as a stopped import does.
  expect((await activity())[project.id]).toContainEqual({ kind: "importing", count: 1 });
  ctx.db.prepare("UPDATE media SET ingest_pid = NULL WHERE id = 'incoming'").run();
  expect((await activity())[project.id]).toContainEqual({ kind: "importing", count: 1, paused: true });
  expect((await activity())[project.id]).toContainEqual({ kind: "transcribing", count: 2, fraction: 0.125 });

  // Resumed, the import goes on.
  ctx.repos.projects.update(project.id, { mediaPaused: false });
  expect((await activity())[project.id]).toContainEqual({ kind: "importing", count: 1 });
});
