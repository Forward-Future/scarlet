import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ATTEMPT_HEADER, TASK_HEADER, type AgentHost, type Task } from "@scarlet/shared";
import { createProject } from "@scarlet/timeline";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken } from "../auth.js";
import { badRequest } from "../errors.js";
import { cancelTask, createTask } from "../services/tasks.js";
import { claimTask } from "../services/taskQueue.js";

// The readings and runs behind these routes spawn FFmpeg, native models or other agents: the test says what they answer.
const engine = vi.hoisted(() => ({
  screenMotion: vi.fn(), pictureCuts: vi.fn(), faces: vi.fn(), screenText: vi.fn(), lipSync: vi.fn(), mouthActivity: vi.fn(),
  showArea: vi.fn(), editShowAreas: vi.fn(), askAreas: vi.fn(), listenFor: vi.fn(), handOff: vi.fn(),
}));
vi.mock("../services/screenMotion.js", async real => ({ ...await real<object>(), screenMotion: engine.screenMotion }));
vi.mock("../services/pictureCuts.js", async real => ({ ...await real<object>(), pictureCuts: engine.pictureCuts }));
vi.mock("../services/faces.js", async real => ({ ...await real<object>(), faces: engine.faces }));
vi.mock("../services/screenText.js", async real => ({ ...await real<object>(), screenText: engine.screenText }));
vi.mock("../services/lipSync.js", async real => ({ ...await real<object>(), lipSync: engine.lipSync }));
vi.mock("../services/mouthActivity.js", async real => ({ ...await real<object>(), mouthActivity: engine.mouthActivity }));
vi.mock("../services/showArea.js", async real => ({ ...await real<object>(), showArea: engine.showArea, editShowAreas: engine.editShowAreas, askAreas: engine.askAreas }));
vi.mock("../services/listening.js", async real => ({ ...await real<object>(), listenFor: engine.listenFor }));
vi.mock("../services/taskModels.js", async real => ({ ...await real<object>(), handOff: engine.handOff }));

let directory: string;
let workspace: ScarletApp;
let projectId: string;
let otherProjectId: string;
let host: AgentHost;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-perception-edge-test-"));
  workspace = createApp({ dataDir: directory, skillsSeedDir: join(directory, "empty-seed"), env: {}, log: () => {} });
  const { ctx } = workspace;
  projectId = ctx.repos.projects.insert(createProject("Interview")).id;
  otherProjectId = ctx.repos.projects.insert(createProject("Elsewhere")).id;
  ctx.paths.ensureProject(projectId);
  writeFileSync(join(ctx.paths.media(projectId), "clip.mp4"), "");
  ctx.repos.projects.putMedia(projectId, { id: "clip", name: "Clip", path: "clip.mp4", kind: "video", duration: 60, width: 1280, height: 720, fps: 30, hasAudio: true }, "ready");
  ctx.repos.projects.putMedia(projectId, { id: "mute", name: "Mute", path: "clip.mp4", kind: "video", duration: 60, hasAudio: false }, "ready");
  ctx.repos.projects.putMedia(projectId, { id: "fresh", name: "Fresh", path: "clip.mp4", kind: "video" }, "ready");
  ctx.repos.projects.putMedia(projectId, { id: "gone", name: "Gone", path: "gone.mp4", kind: "video", duration: 60 }, "ready");
  ctx.repos.projects.putMedia(projectId, { id: "lost-voice", name: "Lost voice", path: "lost.wav", kind: "audio" }, "ready");
  ctx.repos.projects.putMedia(projectId, { id: "voice", name: "Voice", path: "voice.wav", kind: "audio", duration: 30 }, "ready");
  host = ctx.repos.hosts.put({ id: "host", name: "Mac", userId: "user", platform: "darwin", online: true, agents: [{ id: "claude", installed: true }],
    lastSeenAt: new Date().toISOString() });
});
afterAll(async () => {
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  for (const mock of Object.values(engine)) mock.mockReset();
});

const auth = () => ({ Authorization: `Bearer ${accessToken(workspace.ctx)}` });
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const res = await workspace.app.request(`/api/projects/${projectId}${path}`, {
    method, signal,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...auth(), ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as Record<string, any> : undefined;
  return { status: res.status, body: json, code: json?.error?.code as string | undefined };
}
const get = (path: string, signal?: AbortSignal) => call("GET", path, undefined, {}, signal);
const post = (path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) => call("POST", path, body, headers, signal);

/** A request at work, claimed by its host, and the headers its run sends. */
function runningRequest(project = projectId): { task: Task; headers: Record<string, string> } {
  // One request works in a project at a time: those left by earlier tests are stopped first.
  for (const left of workspace.ctx.repos.tasks.select("project_id = ? AND state IN ('queued', 'claimed', 'running')", [project])) {
    workspace.ctx.db.transaction(() => cancelTask(workspace.ctx, left), "immediate")();
  }
  const created = createTask(workspace.ctx, { projectId: project, kind: "edit", agent: "claude", instruction: "Tighten the intro",
    context: {}, createdBy: { type: "human", name: "Editor" } });
  const task = claimTask(workspace.ctx, host, created.id)!;
  expect(task.state).toBe("claimed");
  return { task, headers: { [TASK_HEADER]: task.id, [ATTEMPT_HEADER]: task.startedAt! } };
}
/** A request that isn't at work: queued, never claimed. */
function queuedRequest(project = projectId): Task {
  return createTask(workspace.ctx, { projectId: project, kind: "edit", agent: "claude", instruction: "Later", context: {}, createdBy: { type: "human", name: "Editor" } });
}

it("refuses loudness for a recording whose file isn't in the project, before measuring anything", async () => {
  expect(await get("/media/lost-voice/loudness")).toMatchObject({ status: 404, code: "not_found" });
  expect(await get("/media/lost-voice/loudness?from=1&to=2")).toMatchObject({ status: 404, code: "not_found" });
});

it("refuses music beats for a range that isn't one and for media of another project", async () => {
  expect(await get("/media/voice/music-beats?from=2&to=1")).toMatchObject({ status: 400, code: "bad_range" });
  expect(await get("/media/voice/music-beats?from=-1")).toMatchObject({ status: 400, code: "bad_range" });
  expect(await get("/media/voice/music-beats?to=often")).toMatchObject({ status: 400, code: "bad_param" });
  const res = await workspace.app.request(`/api/projects/${otherProjectId}/media/voice/music-beats`, { headers: auth() });
  expect(res.status).toBe(404);
});

it("reads screen motion, picture cuts and faces over the range asked for, waiting at most a minute", async () => {
  const readers = [["screen-motion", engine.screenMotion], ["picture-cuts", engine.pictureCuts], ["faces", engine.faces]] as const;
  for (const [route, reader] of readers) {
    reader.mockResolvedValue({ mediaId: "clip", done: true, route });
    expect(await get(`/media/clip/${route}?from=5&to=15`)).toEqual({ status: 200, body: { mediaId: "clip", done: true, route }, code: undefined });
    expect(reader.mock.calls[0]![1]).toMatchObject({ id: "clip", projectId });
    expect(reader.mock.calls[0]![2]).toEqual({ from: 5, to: 15 });
    expect(reader.mock.calls[0]![3]).toMatchObject({ waitMs: 30_000 });
    await get(`/media/clip/${route}?wait=600`);
    expect(reader.mock.calls[1]![3]).toMatchObject({ waitMs: 60_000 });
    await get(`/media/clip/${route}?wait=-5`);
    expect(reader.mock.calls[2]![3]).toMatchObject({ waitMs: 0 });
  }
  // A range that starts before the recording still reaches into it, and is read.
  engine.faces.mockResolvedValue({ done: true });
  expect((await get("/media/clip/faces?to=10")).status).toBe(200);
});

it("passes a search for screen text on, and reads the whole text when the search is empty", async () => {
  engine.screenText.mockResolvedValue({ mediaId: "clip", matches: [] });
  expect((await get("/media/clip/screen-text?q=Subscribe")).status).toBe(200);
  expect(engine.screenText.mock.calls[0]![3]).toMatchObject({ query: "Subscribe", waitMs: 30_000 });
  await get("/media/clip/screen-text?q=");
  expect(engine.screenText.mock.calls[1]![3].query).toBeUndefined();
});

it("refuses a picture reading of a video with no picture, a recording being prepared, a lost file or a range outside it", async () => {
  for (const route of ["screen-motion", "picture-cuts"]) {
    expect(await get(`/media/voice/${route}`)).toMatchObject({ status: 400, code: "no_picture" });
    expect(await get(`/media/fresh/${route}`)).toMatchObject({ status: 409, code: "not_ready" });
    expect(await get(`/media/gone/${route}`)).toMatchObject({ status: 404, code: "not_found" });
    expect(await get(`/media/clip/${route}?from=60`)).toMatchObject({ status: 400, code: "bad_range" });
    expect(await get(`/media/clip/${route}?from=1&to=1`)).toMatchObject({ status: 400, code: "bad_range" });
    expect(await get(`/media/clip/${route}?wait=soon`)).toMatchObject({ status: 400, code: "bad_param" });
    expect(await get(`/media/nothing/${route}`)).toMatchObject({ status: 404, code: "not_found" });
  }
  expect(engine.screenMotion).not.toHaveBeenCalled();
  expect(engine.pictureCuts).not.toHaveBeenCalled();
});

it("answers a reading's own refusal as it is, and names the reading when the engine fails", async () => {
  engine.pictureCuts.mockRejectedValueOnce(badRequest("bad_range", "That range is too long to read at once."));
  expect(await get("/media/clip/picture-cuts")).toMatchObject({ status: 400, code: "bad_range", body: { error: { message: "That range is too long to read at once." } } });
  engine.screenMotion.mockRejectedValueOnce(new Error("decoder crashed"));
  expect(await get("/media/clip/screen-motion")).toMatchObject({ status: 500, code: "internal_error", body: { error: { message: "screen motion: decoder crashed" } } });
  engine.faces.mockRejectedValueOnce("model file missing");
  expect(await get("/media/clip/faces")).toMatchObject({ status: 500, body: { error: { message: "faces: model file missing" } } });
});

it("answers 499 to a caller that left while its reading finished", async () => {
  const gone = new AbortController();
  engine.faces.mockImplementation(async () => { gone.abort(); return { done: true }; });
  expect((await get("/media/clip/faces", gone.signal)).status).toBe(499);
});

it("checks how many lip-sync stretches and how long, and that the video has a sound of its own", async () => {
  for (const query of ["count=0", "count=21", "count=2.5"]) expect(await get(`/media/clip/lip-sync?${query}`)).toMatchObject({ status: 400, code: "bad_count" });
  for (const query of ["seconds=4", "seconds=121"]) expect(await get(`/media/clip/lip-sync?${query}`)).toMatchObject({ status: 400, code: "bad_seconds" });
  expect(await get("/media/mute/lip-sync")).toMatchObject({ status: 400, code: "no_audio" });
  expect(engine.lipSync).not.toHaveBeenCalled();
});

it("measures lip sync with the stretches asked for, waiting a minute by default and at most four", async () => {
  engine.lipSync.mockResolvedValue({ mediaId: "clip", offsetMs: 40, done: true });
  expect(await get("/media/clip/lip-sync?from=10&to=50&count=3&seconds=20")).toMatchObject({ status: 200, body: { offsetMs: 40 } });
  expect(engine.lipSync.mock.calls[0]![2]).toEqual({ from: 10, to: 50, count: 3, seconds: 20 });
  expect(engine.lipSync.mock.calls[0]![3]).toMatchObject({ waitMs: 60_000 });
  await get("/media/clip/lip-sync?wait=1000&count=20&seconds=120");
  expect(engine.lipSync.mock.calls[1]![3]).toMatchObject({ waitMs: 240_000 });
  await get("/media/clip/lip-sync?wait=0&count=1&seconds=5");
  expect(engine.lipSync.mock.calls[2]![3]).toMatchObject({ waitMs: 0 });
});

it("refuses mouth activity for a recording being prepared or whose file is lost", async () => {
  const stretches = [{ from: 0, to: 5 }];
  expect(await post("/media/fresh/mouth-activity", { stretches })).toMatchObject({ status: 409, code: "not_ready" });
  expect(await post("/media/gone/mouth-activity", { stretches })).toMatchObject({ status: 404, code: "not_found" });
  expect(await post("/media/nothing/mouth-activity", { stretches })).toMatchObject({ status: 404, code: "not_found" });
});

it("refuses mouth activity stretches that aren't a list of one to six ranges inside the limits", async () => {
  const refused = async (body: unknown) => { const res = await post("/media/clip/mouth-activity", body); return [res.status, res.code]; };
  expect(await refused("not json")).toEqual([400, "bad_request"]);
  expect(await refused({})).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: [] })).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: "0-5" })).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: Array.from({ length: 7 }, (_, i) => ({ from: i, to: i + 1 })) })).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: [null] })).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: [5] })).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: [{ from: "0", to: 5 }] })).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: [{ from: 0 }] })).toEqual([400, "bad_request"]);
  expect(await refused({ stretches: [{ from: -1, to: 5 }] })).toEqual([400, "bad_range"]);
  expect(await refused({ stretches: [{ from: 5, to: 5 }] })).toEqual([400, "bad_range"]);
  // JSON reads 1e400 as Infinity.
  expect(await refused('{"stretches":[{"from":0,"to":1e400}]}')).toEqual([400, "bad_range"]);
  expect(await refused({ stretches: [{ from: 0, to: 30.1 }] })).toEqual([400, "bad_range"]);
  expect(await refused({ stretches: [0, 25, 50, 75].map(from => ({ from, to: from + 25 })) })).toEqual([400, "bad_range"]);
  expect(engine.mouthActivity).not.toHaveBeenCalled();
});

it("measures mouth activity over the stretches given, within a little of each limit", async () => {
  engine.mouthActivity.mockResolvedValue({ mediaId: "clip", sampleRate: 5, faces: [], done: true });
  // 30.04 s is within rounding of 30 s, and three stretches of 30 s make the 90 s allowed.
  const stretches = [{ from: 0, to: 30.04 }, { from: 30.04, to: 60 }];
  expect(await post("/media/clip/mouth-activity", { stretches })).toMatchObject({ status: 200, body: { sampleRate: 5, done: true } });
  expect(engine.mouthActivity.mock.calls[0]![2]).toEqual(stretches);
  expect(engine.mouthActivity.mock.calls[0]![3]).toMatchObject({ waitMs: 30_000 });
  await post("/media/clip/mouth-activity?wait=500", { stretches: [{ from: 0, to: 30 }, { from: 30, to: 60 }, { from: 60, to: 90 }] });
  expect(engine.mouthActivity.mock.calls[1]![3]).toMatchObject({ waitMs: 120_000 });
});

it("answers a failed mouth measure as the caller's mistake, the engine's fault, or a caller who left", async () => {
  const stretches = [{ from: 0, to: 5 }];
  engine.mouthActivity.mockRejectedValueOnce(badRequest("bad_range", "Too far."));
  expect(await post("/media/clip/mouth-activity", { stretches })).toMatchObject({ status: 400, code: "bad_range" });
  engine.mouthActivity.mockRejectedValueOnce(new Error("ffmpeg exited 1"));
  expect(await post("/media/clip/mouth-activity", { stretches })).toMatchObject({ status: 500, body: { error: { message: "mouth activity: ffmpeg exited 1" } } });
  engine.mouthActivity.mockRejectedValueOnce(42);
  expect(await post("/media/clip/mouth-activity", { stretches })).toMatchObject({ status: 500, body: { error: { message: "mouth activity: 42" } } });

  const left = new AbortController();
  engine.mouthActivity.mockImplementationOnce(async () => { left.abort(); return { done: true }; });
  expect((await post("/media/clip/mouth-activity", { stretches }, {}, left.signal)).status).toBe(499);
  const stopped = new AbortController();
  engine.mouthActivity.mockImplementationOnce(async () => { stopped.abort(); throw new Error("killed"); });
  expect((await post("/media/clip/mouth-activity", { stretches }, {}, stopped.signal)).status).toBe(499);
});

it("shows a video's areas, waiting up to four minutes, and only for a video that is ready", async () => {
  engine.showArea.mockResolvedValue({ mediaId: "clip", areas: [], done: false });
  expect(await get("/media/clip/show-area")).toMatchObject({ status: 200, body: { mediaId: "clip", done: false } });
  expect(engine.showArea.mock.calls[0]![2]).toEqual({ waitMs: 30_000 });
  await get("/media/clip/show-area?wait=9999");
  expect(engine.showArea.mock.calls[1]![2]).toEqual({ waitMs: 240_000 });
  expect(await get("/media/voice/show-area")).toMatchObject({ status: 400, code: "no_picture" });
  expect(await get("/media/fresh/show-area")).toMatchObject({ status: 409, code: "not_ready" });
  expect(await get("/media/clip/show-area?wait=x")).toMatchObject({ status: 400, code: "bad_param" });
});

it("refuses an area edit that isn't a list of areas to set or seconds to remove", async () => {
  for (const body of ["nope", { set: "all" }, { set: [{ at: "1", area: [] }] }, { set: [{ at: 1 }] }, { set: [null] }, { remove: [1, "2"] }, { remove: 3 }]) {
    expect(await post("/media/clip/show-area", body)).toMatchObject({ status: 400, code: "bad_request" });
  }
  expect(engine.editShowAreas).not.toHaveBeenCalled();
});

it("sets and removes areas for the editor or the run at work, and refuses a run that has stopped", async () => {
  engine.showArea.mockResolvedValue({ mediaId: "clip", areas: [{ at: 0, area: [0, 0, 1, 1] }], done: true });
  const edit = { set: [{ at: 0, area: [0, 0, 1, 1] }], remove: [12] };
  expect(await post("/media/clip/show-area", edit)).toMatchObject({ status: 200, body: { done: true } });
  expect(engine.editShowAreas.mock.calls[0]![2]).toEqual(edit);
  // An empty edit changes nothing, and still answers what holds.
  expect((await post("/media/clip/show-area", {})).status).toBe(200);

  const { headers } = runningRequest();
  expect((await post("/media/clip/show-area", { remove: [3] }, headers)).status).toBe(200);
  const queued = queuedRequest();
  expect(await post("/media/clip/show-area", { remove: [3] }, { [TASK_HEADER]: queued.id, [ATTEMPT_HEADER]: "2026-01-01T00:00:00.000Z" }))
    .toMatchObject({ status: 409, code: "inactive_task_attempt" });
  expect(await post("/media/clip/show-area", { remove: [3] }, { [TASK_HEADER]: "tsk_none" })).toMatchObject({ status: 400, code: "invalid_task" });
  expect(engine.editShowAreas).toHaveBeenCalledTimes(3);
});

it("asks for looks at frames for a request, again when asked, and refuses a run that isn't at work", async () => {
  engine.showArea.mockResolvedValue({ mediaId: "clip", areas: [], done: true });
  engine.askAreas.mockResolvedValue({ asked: 2, answered: 1, waiting: 1 });
  for (const body of [null, { seconds: 5, taskId: "t" }, { seconds: [1, "2"], taskId: "t" }, { seconds: [1] }, { seconds: [1], taskId: 7 }]) {
    expect(await post("/media/clip/show-area/ask", body === null ? "null" : body)).toMatchObject({ status: 400, code: "bad_request" });
  }
  const { task, headers } = runningRequest();
  expect(await post("/media/clip/show-area/ask?wait=10", { seconds: [4, 8], taskId: task.id, again: true }, headers))
    .toMatchObject({ status: 200, body: { asked: 2, answered: 1, waiting: 1, mediaId: "clip", done: true } });
  expect(engine.askAreas.mock.calls[0]![2]).toEqual({ seconds: [4, 8], taskId: task.id, waitMs: 10_000, again: true });
  expect(engine.showArea.mock.calls[0]![2]).toEqual({ waitMs: 5000 });
  // Without a run's headers the engine asks on the request's behalf; "again" is only ever true.
  await post("/media/clip/show-area/ask", { seconds: [4], taskId: task.id, again: "yes" });
  expect(engine.askAreas.mock.calls[1]![2]).toMatchObject({ again: false, waitMs: 30_000 });

  const queued = queuedRequest();
  expect(await post("/media/clip/show-area/ask", { seconds: [4], taskId: queued.id }, { [TASK_HEADER]: queued.id }))
    .toMatchObject({ status: 409, code: "inactive_task_attempt" });
  expect(await post("/media/clip/show-area/ask", { seconds: [4], taskId: "tsk_none" }, headers)).toMatchObject({ status: 400, code: "invalid_task" });
  expect(engine.askAreas).toHaveBeenCalledTimes(2);
});

it("refuses a listen that isn't a passage of a source with a question, or is too long", async () => {
  const ok = { taskId: "t", mediaId: "voice", from: 1, to: 5, question: "Who laughs here?" };
  for (const body of [null, { ...ok, taskId: 1 }, { ...ok, mediaId: undefined }, { ...ok, from: "1" }, { ...ok, to: null }, { ...ok, question: 3 }, { ...ok, question: "   " }]) {
    expect(await post("/listen", body ?? "null")).toMatchObject({ status: 400, code: "bad_request" });
  }
  expect(await post("/listen", { ...ok, from: -1 })).toMatchObject({ status: 400, code: "bad_range" });
  expect(await post("/listen", { ...ok, to: 1 })).toMatchObject({ status: 400, code: "bad_range" });
  expect(await post("/listen", { ...ok, from: 0, to: 20.1 })).toMatchObject({ status: 400, code: "bad_range" });
  expect(await post("/listen", { ...ok, question: "?".repeat(2001) })).toMatchObject({ status: 400, code: "bad_request" });
  expect(engine.listenFor).not.toHaveBeenCalled();
});

it("listens only for a request at work in this project, for itself", async () => {
  engine.listenFor.mockResolvedValue({ state: "done", answer: "The guest laughs at 3 s." });
  const { task, headers } = runningRequest();
  const ask = { taskId: task.id, mediaId: "voice", from: 0, to: 20.04, question: "Who laughs here?" };
  expect(await post("/listen", { ...ask, voice: "me" }, headers)).toMatchObject({ status: 200, body: { answer: "The guest laughs at 3 s." } });
  expect(engine.listenFor.mock.calls[0]!.slice(1)).toEqual([task.id, { mediaId: "voice", from: 0, to: 20.04, voice: "me", question: "Who laughs here?" }, 60_000]);
  await post("/listen?wait=300", { ...ask, voice: "other voices" }, headers);
  expect(engine.listenFor.mock.calls[1]!.slice(2)).toEqual([expect.objectContaining({ voice: "other voices" }), 240_000]);
  // A voice it doesn't know is left out.
  await post("/listen?wait=2", { ...ask, voice: "the guest" }, headers);
  expect(engine.listenFor.mock.calls[2]![2].voice).toBeUndefined();
  expect(engine.listenFor.mock.calls[2]![3]).toBe(2000);

  expect(await post("/listen", ask)).toMatchObject({ status: 409, code: "inactive_task_attempt" });
  expect(await post("/listen", { ...ask, taskId: "tsk_none" })).toMatchObject({ status: 400, code: "invalid_task" });
  const elsewhere = runningRequest(otherProjectId);
  expect(await post("/listen", { ...ask, taskId: elsewhere.task.id }, elsewhere.headers)).toMatchObject({ status: 400, code: "invalid_task" });
  expect(engine.listenFor).toHaveBeenCalledTimes(3);
});

it("refuses a hand-off without its request and either a kind of work with a brief or the hand-off to wait on", async () => {
  for (const body of [null, {}, { taskId: 3, type: "cutting", brief: "Cut it" }, { taskId: "t", type: "cutting" }, { taskId: "t", brief: "Cut it" }, { taskId: "t", handoffId: 4 }]) {
    expect(await post("/hand-off", body ?? "null")).toMatchObject({ status: 400, code: "bad_request" });
  }
  expect(await post("/hand-off", { taskId: "t", type: "cutting", brief: "x".repeat(8001) })).toMatchObject({ status: 400, code: "bad_request" });
  expect(engine.handOff).not.toHaveBeenCalled();
});

it("hands work off for a request at work, or waits on a hand-off it started", async () => {
  engine.handOff.mockResolvedValue({ state: "working", handoffId: "tsk_run" });
  const { task, headers } = runningRequest();
  expect(await post("/hand-off", { taskId: task.id, type: "Motion graphics", brief: "A lower third for Ana" }, headers))
    .toMatchObject({ status: 200, body: { state: "working", handoffId: "tsk_run" } });
  expect(engine.handOff.mock.calls[0]!.slice(1)).toEqual([task.id, { type: "Motion graphics", brief: "A lower third for Ana", handoffId: undefined }, 120_000]);
  await post("/hand-off?wait=1000", { taskId: task.id, handoffId: "tsk_run", type: 5 }, headers);
  expect(engine.handOff.mock.calls[1]!.slice(2)).toEqual([{ type: undefined, brief: undefined, handoffId: "tsk_run" }, 240_000]);
  await post("/hand-off?wait=-1", { taskId: task.id, handoffId: "tsk_run" }, headers);
  expect(engine.handOff.mock.calls[2]![3]).toBe(0);
  expect(await post("/hand-off", { taskId: task.id, handoffId: "tsk_run" })).toMatchObject({ status: 409, code: "inactive_task_attempt" });
  expect(await post("/hand-off?wait=soon", { taskId: task.id, handoffId: "tsk_run" }, headers)).toMatchObject({ status: 400, code: "bad_param" });
  expect(engine.handOff).toHaveBeenCalledTimes(3);
});
