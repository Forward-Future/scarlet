import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, timelineFromKeepRanges, type Project } from "@scarlet/timeline";
import type { WsEvent, YouTubePublishRequest, YouTubeUploadJob } from "@scarlet/shared";
import { createApp, type ScarletApp } from "../app.js";
import { accessToken, localUser } from "../auth.js";
import { scarletRenderAdapter } from "../render/scarletRender.js";
import { storeVersion } from "./timeline.js";
import { getYouTubeStatus } from "./youtubeAuth.js";
import {
  cancelYouTubeUpload,
  getYouTubeUpload,
  isUploadActive,
  listProjectYouTubeUploads,
  mapYouTubeApiError,
  startYouTubePublish,
} from "./youtubePublish.js";

// Google is a fake fetch that keeps a resumable session the way YouTube does; the render is a stand-in file, so no
// FFmpeg runs. Everything between (the queue, the job, the chunk loop, the stored sign-in) is the real engine.
const GOOGLE = "https://google.test";
const UPLOAD = "https://upload.test";
const SESSION = `${UPLOAD}/upload/session/1`;
const CHUNK = 256 * 1024;

interface Call { url: string; method: string; headers: Headers; body?: RequestInit["body"]; signal?: AbortSignal | null }
type Reply = (call: Call) => Response | Promise<Response>;

let directory: string;
let workspace: ScarletApp;
let project: Project;
let version: string;
let calls: Call[];
let logs: string[];
let events: YouTubeUploadJob[];
let renderBytes: number;
let renderError: string | null;
let openRender: (() => void) | null;
let renderGate: Promise<void> | null;
let onInit: Reply;
let onChunk: Reply;
let onProbe: Reply;
let onToken: Reply;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const rangeOf = (call: Call) => call.headers.get("content-range") ?? "";
const chunks = () => calls.filter(c => c.url === SESSION && !rangeOf(c).startsWith("bytes */"));
const probes = () => calls.filter(c => c.url === SESSION && rangeOf(c).startsWith("bytes */"));
const inits = () => calls.filter(c => c.url.startsWith(`${UPLOAD}/upload/youtube/v3/videos`));

/** YouTube's own answer to a chunk: 308 with what it holds until the last byte, then the video. */
const youtubeChunk: Reply = call => {
  const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(rangeOf(call))!.map(Number);
  return end! + 1 < total! ? new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } }) : json(200, { id: "vid_123" });
};

const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const call: Call = { url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body, signal: init.signal };
  calls.push(call);
  if (call.url === `${GOOGLE}/token`) return onToken(call);
  if (call.url === SESSION) return rangeOf(call).startsWith("bytes */") ? onProbe(call) : onChunk(call);
  if (call.url.startsWith(`${UPLOAD}/upload/youtube/v3/videos`)) return onInit(call);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "scarlet-youtube-publish-test-"));
  calls = [];
  logs = [];
  events = [];
  renderBytes = 2 * CHUNK + 1000;
  renderError = null;
  renderGate = null;
  openRender = null;
  onInit = () => new Response(null, { status: 200, headers: { Location: SESSION } });
  onChunk = youtubeChunk;
  onProbe = () => new Response(null, { status: 200 });
  onToken = () => json(200, { access_token: "ya29.refreshed", expires_in: 3600 });
  workspace = createApp({
    dataDir: directory,
    skillsSeedDir: join(directory, "empty-seed"),
    env: { SCARLET_YOUTUBE_CLIENT_ID: "client-id-1234567890.apps.googleusercontent.com" },
    log: line => logs.push(line),
    render: {
      ...scarletRenderAdapter,
      async renderFullCached(_project, _timeline, _cache, file, opts) {
        opts.onProgress?.(0.5);
        if (renderGate) await renderGate;
        if (renderError) throw new Error(renderError);
        writeFileSync(file, Buffer.alloc(renderBytes, 7));
      },
    },
    youtube: { tokenUrl: `${GOOGLE}/token`, uploadBaseUrl: `${UPLOAD}/`, uploadChunkBytes: 1, fetch: fakeFetch },
  });
  const { ctx } = workspace;
  project = ctx.repos.projects.insert(createProject("Publish"));
  ctx.repos.projects.putMedia(project.id, { id: "camera", kind: "video", name: "Camera", path: "camera.mp4", duration: 30, hasAudio: true }, "ready");
  version = storeVersion(ctx, project.id, timelineFromKeepRanges(project.id, "camera", [{ start: 0, end: 30 }]), { parent: null }).version;
  ctx.repos.projects.update(project.id, { head: version });
  ctx.bus.on("ws", (ev: WsEvent) => { if (ev.type === "youtube.upload.updated") events.push(ev.upload); });
  signIn();
});

afterEach(async () => {
  openRender?.();
  vi.useRealTimers();
  await workspace.ctx.close();
  rmSync(directory, { recursive: true, force: true });
});

/** An older engine's plain token file, which the store still reads. */
function signIn(tokens: Record<string, unknown> = {}) {
  writeFileSync(workspace.ctx.paths.youtubeAuth, JSON.stringify({
    version: 1, accessToken: "ya29.current", refreshToken: "1//refresh", expiresAt: Date.now() + 3_600_000, ...tokens,
  }), { mode: 0o600 });
}

function holdRender() {
  renderGate = new Promise<void>(resolve => { openRender = () => { renderGate = null; openRender = null; resolve(); }; });
}

const settle = async () => { while (workspace.ctx.pending.size) await Promise.allSettled([...workspace.ctx.pending]); };

async function api<T>(method: string, path: string, body?: unknown) {
  const res = await workspace.app.request(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken(workspace.ctx)}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as T & { error?: { code: string; message: string } } };
}

const request = (patch: Partial<YouTubePublishRequest> = {}): YouTubePublishRequest =>
  ({ title: "Final cut", description: "Chapters", visibility: "private", quality: "delivery", ...patch });

function publish(patch: Partial<YouTubePublishRequest> = {}) {
  return startYouTubePublish(workspace.ctx, localUser(workspace.ctx), project.id, request(patch));
}

async function publishAndSettle(patch: Partial<YouTubePublishRequest> = {}) {
  const job = publish(patch);
  await settle();
  return getYouTubeUpload(workspace.ctx, job.id)!;
}

/** Render the delivery file once, so publishes reuse it and go straight to uploading. */
async function prerender() {
  workspace.ctx.renders.request({ projectId: project.id, version, kind: "full", range: null, quality: "delivery", exportOptions: undefined });
  await settle();
}

/** Drives the retry pauses with fake timers while the real file reads and fake replies run. */
async function runOut(id: string) {
  for (let i = 0; i < 200 && isUploadActive(getYouTubeUpload(workspace.ctx, id)!.phase); i++) {
    await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(100);
  }
  vi.useRealTimers();
  await settle();
  return getYouTubeUpload(workspace.ctx, id)!;
}

it("renders the edit, uploads it in resumable chunks and links to the finished video", async () => {
  const res = await api<{ upload: YouTubeUploadJob }>("POST", `/projects/${project.id}/youtube/publish`, {
    title: "My cut", description: "0:00 Intro", visibility: "unlisted",
  });
  expect(res.status).toBe(201);
  expect(res.json.upload).toMatchObject({ phase: "rendering", reusedRender: false, title: "My cut", visibility: "unlisted", version });
  await settle();

  const job = (await api<{ upload: YouTubeUploadJob }>("GET", `/youtube/uploads/${res.json.upload.id}`)).json.upload;
  const size = renderBytes;
  expect(job).toMatchObject({
    phase: "done", progress: 1, bytesUploaded: size, bytesTotal: size, videoId: "vid_123",
    studioUrl: "https://studio.youtube.com/video/vid_123/edit", watchUrl: "https://www.youtube.com/watch?v=vid_123",
  });
  expect(job.finishedAt).toBeTruthy();
  expect(events.some(e => e.phase === "rendering" && e.progress === 0.5)).toBe(true);
  expect(events.some(e => e.phase === "uploading" && e.bytesUploaded === 0 && e.bytesTotal === size)).toBe(true);

  const [init] = inits();
  expect(init!.url).toBe(`${UPLOAD}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`);
  expect(init!.headers.get("authorization")).toBe("Bearer ya29.current");
  expect(init!.headers.get("x-upload-content-length")).toBe(String(size));
  expect(init!.headers.get("x-upload-content-type")).toBe("video/mp4");
  expect(JSON.parse(String(init!.body))).toEqual({
    snippet: { title: "My cut", description: "0:00 Intro", categoryId: "22" },
    status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
  });
  // The chunk size is never under 256 KiB, whatever the setting asks.
  expect(chunks().map(rangeOf)).toEqual([`bytes 0-${CHUNK - 1}/${size}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${size}`, `bytes ${2 * CHUNK}-${size - 1}/${size}`]);
  expect(chunks().map(c => (c.body as Uint8Array).byteLength)).toEqual([CHUNK, CHUNK, 1000]);

  const [activity] = workspace.ctx.repos.activity.select("type = ?", ["youtube.published"]);
  expect(activity).toMatchObject({ projectId: project.id, summary: "Uploaded to YouTube (unlisted)", data: { version, videoId: "vid_123", visibility: "unlisted" } });
  expect((activity!.data as Record<string, unknown>).reusedRender).toBeUndefined();
  expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^\\[youtube\\] upload complete id=${job.id} visibility=unlisted size_mb=1 upload=`)));
});

it("uploads a render that is already finished straight away and lists uploads newest first", async () => {
  const first = await publishAndSettle();
  const second = publish({ title: "Again", visibility: "public" });
  expect(second).toMatchObject({ phase: "uploading", progress: 0, reusedRender: true, renderId: first.renderId });
  await settle();
  expect(getYouTubeUpload(workspace.ctx, second.id)).toMatchObject({ phase: "done", reusedRender: true });
  expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^\\[youtube\\] upload complete id=${second.id} visibility=public reusedRender=true size_mb=1 upload=`)));
  const activities = workspace.ctx.repos.activity.select("type = ?", ["youtube.published"]);
  expect(activities.map(a => (a.data as Record<string, unknown>).reusedRender)).toContain(true);

  const listed = await api<{ uploads: YouTubeUploadJob[] }>("GET", `/projects/${project.id}/youtube/uploads`);
  expect(listed.json.uploads.map(u => u.id)).toEqual(listProjectYouTubeUploads(workspace.ctx, project.id).map(u => u.id));
  expect(new Set(listed.json.uploads.map(u => u.id))).toEqual(new Set([first.id, second.id]));
  const created = listed.json.uploads.map(u => u.createdAt);
  expect([...created].sort().reverse()).toEqual(created);
  expect(listProjectYouTubeUploads(workspace.ctx, "prj_other")).toEqual([]);
  expect((await api("GET", "/youtube/uploads/ytup_missing")).status).toBe(404);
});

it("renders a custom export when a height or best quality is asked", async () => {
  const job = await publishAndSettle({ height: 720, bestQuality: true, quality: "preview" });
  expect(job.phase).toBe("done");
  expect(workspace.ctx.repos.renders.get(job.renderId!)).toMatchObject({ kind: "export", quality: "delivery", exportOptions: { height: 720, bestQuality: true } });

  const heightOnly = await publishAndSettle({ height: 480 });
  const render = workspace.ctx.repos.renders.get(heightOnly.renderId!)!;
  expect(render).toMatchObject({ kind: "export", exportOptions: { height: 480 } });
  expect(render.exportOptions?.bestQuality).toBeUndefined();
});

it("refuses to publish with no edit, no sign-in, or while another upload of the project runs", async () => {
  const { ctx } = workspace;
  expect((await api("POST", "/projects/prj_nope/youtube/publish", { title: "x" })).status).toBe(404);

  const empty = ctx.repos.projects.insert(createProject("Empty"));
  const noEdit = await api("POST", `/projects/${empty.id}/youtube/publish`, { title: "x" });
  expect(noEdit.status).toBe(400);
  expect(noEdit.json.error).toMatchObject({ code: "no_timeline", message: "There’s no edited video to publish yet." });
  expect((await api("POST", `/projects/${project.id}/youtube/publish`, { title: "x", version: "ver_missing" })).json.error?.code).toBe("no_timeline");

  // A sign-in marked expired, saved as a plain object.
  writeFileSync(ctx.paths.youtubeAuth, JSON.stringify({ tokens: { accessToken: "a", expiresAt: Date.now() + 3_600_000, connectedAt: "x", needsReconnect: true } }), { mode: 0o600 });
  let res = await api("POST", `/projects/${project.id}/youtube/publish`, { title: "x" });
  expect(res.status).toBe(401);
  expect(res.json.error).toMatchObject({ code: "youtube_reconnect_required", message: "Your YouTube sign-in expired or was revoked. Reconnect your account in Settings." });

  rmSync(ctx.paths.youtubeAuth);
  res = await api("POST", `/projects/${project.id}/youtube/publish`, { title: "x" });
  expect(res.status).toBe(401);
  expect(res.json.error).toMatchObject({ code: "youtube_not_connected", message: "Connect your YouTube account in Settings before uploading." });

  signIn();
  holdRender();
  const running = publish();
  res = await api("POST", `/projects/${project.id}/youtube/publish`, { title: "x", version });
  expect(res.status).toBe(409);
  expect(res.json.error).toMatchObject({ code: "youtube_upload_in_progress", message: "A YouTube upload is already running for this project." });
  cancelYouTubeUpload(ctx, running.id);
});

it("cancels an upload that is still rendering and lets its render go", async () => {
  holdRender();
  const job = publish();
  await vi.waitFor(() => expect(events.some(e => e.id === job.id && e.progress === 0.5)).toBe(true));

  const res = await api<{ upload: YouTubeUploadJob }>("POST", `/youtube/uploads/${job.id}/cancel`, {});
  expect(res.status).toBe(200);
  expect(res.json.upload.phase).toBe("cancelled");
  expect(workspace.ctx.repos.renders.get(job.renderId!)?.state).toBe("cancelled");
  expect(logs).toContain(`[youtube] upload cancelled id=${job.id}`);
  // Cancelling again just reports where it stands.
  expect(cancelYouTubeUpload(workspace.ctx, job.id)).toMatchObject({ phase: "cancelled", finishedAt: res.json.upload.finishedAt });
  expect((await api("POST", "/youtube/uploads/ytup_missing/cancel", {})).status).toBe(404);

  openRender!();
  await settle();
  expect(getYouTubeUpload(workspace.ctx, job.id)?.phase).toBe("cancelled");
  expect(inits()).toHaveLength(0);
  // A finished project is free to publish again.
  expect(publish().phase).toBe("rendering");
});

it("fails with the render's own reason when rendering stops", async () => {
  renderError = "ffmpeg exited with code 1";
  const job = await publishAndSettle();
  const render = workspace.ctx.repos.renders.get(job.renderId!)!;
  expect(render.state).toBe("failed");
  expect(job).toMatchObject({ phase: "failed", errorCode: "render_failed", error: render.error });
  expect(job.error).toBeTruthy();
  expect(inits()).toHaveLength(0);
  expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^\\[youtube\\] upload failed id=${job.id} code=render_failed phase=rendering after=`)));
});

it("ends as cancelled when the project goes to the trash during the upload", async () => {
  onChunk = call => new Promise<Response>((_resolve, reject) => {
    call.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    workspace.ctx.stopMedia(project.id, true);
  });
  const job = await publishAndSettle();
  expect(job.phase).toBe("cancelled");
  expect(job.finishedAt).toBeTruthy();
  expect(chunks()).toHaveLength(1);
  expect(events.at(-1)?.phase).toBe("cancelled");
});

it("refreshes the sign-in once when YouTube turns down the first upload request", async () => {
  let n = 0;
  onInit = () => (n++ === 0 ? json(401, { error: { message: "Invalid Credentials" } }) : new Response(null, { status: 200, headers: { Location: SESSION } }));
  const job = await publishAndSettle();
  expect(job.phase).toBe("done");
  expect(inits().map(c => c.headers.get("authorization"))).toEqual(["Bearer ya29.current", "Bearer ya29.refreshed"]);
  const refresh = new URLSearchParams(String(calls.find(c => c.url === `${GOOGLE}/token`)!.body));
  expect(refresh.get("grant_type")).toBe("refresh_token");
  expect(getYouTubeStatus(workspace.ctx).state).toBe("connected");
});

it("asks to reconnect when YouTube keeps turning down the sign-in", async () => {
  onInit = () => json(401, { error: { message: "Invalid Credentials" } });
  const job = await publishAndSettle();
  expect(job).toMatchObject({
    phase: "failed", errorCode: "youtube_reconnect_required",
    error: "Your YouTube sign-in expired or was revoked. Reconnect your account in Settings.",
  });
  expect(inits()).toHaveLength(2);
  expect(getYouTubeStatus(workspace.ctx).needsReconnect).toBe(true);
});

it("reports being offline when the upload request can't reach YouTube", async () => {
  onInit = () => { throw new TypeError("fetch failed"); };
  const job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_offline", error: "Couldn’t reach YouTube. Check your internet connection and try again." });
});

it("fails plainly when YouTube's error reply can't be read", async () => {
  onInit = () => new Response("<html>Bad Request</html>", { status: 400 });
  const job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_upload_failed", error: "YouTube couldn’t complete the upload. Try again." });
  expect(chunks()).toHaveLength(0);
});

it("fails when YouTube gives no upload address", async () => {
  onInit = () => new Response(null, { status: 200 });
  const job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_missing_session", error: "YouTube didn’t return an upload session address. Try again." });
});

it("needs a video id from YouTube's last reply, and accepts it with 201", async () => {
  renderBytes = 1000;
  onChunk = () => json(200, {});
  let job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_missing_video_id", error: "YouTube finished the upload, but didn’t return a video ID." });

  onChunk = () => new Response("not json", { status: 200 });
  expect((await publishAndSettle()).errorCode).toBe("youtube_missing_video_id");

  onChunk = () => json(201, { id: "vid_created" });
  job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "done", videoId: "vid_created", bytesUploaded: 1000, progress: 1 });
});

it("stops with YouTube's reason when a chunk is turned down", async () => {
  onChunk = () => json(413, { error: { message: "Request Entity Too Large" } });
  let job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_file_too_large", error: "This video exceeds YouTube’s upload size limit for this account." });
  expect(getYouTubeStatus(workspace.ctx).needsReconnect).toBeUndefined();

  onChunk = () => json(401, { error: { errors: [{ reason: "authError" }] } });
  job = await publishAndSettle();
  expect(job.errorCode).toBe("youtube_reconnect_required");
  expect(getYouTubeStatus(workspace.ctx).needsReconnect).toBe(true);
});

it("treats an unexpected chunk status as a failed upload", async () => {
  onChunk = () => new Response(null, { status: 302 });
  const job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_upload_failed", error: "YouTube couldn’t complete the upload. Try again." });
});

it("resends from the byte YouTube says it holds and counts a reply without a Range as the whole chunk", async () => {
  const size = renderBytes;
  const replies = [
    () => new Response(null, { status: 308 }),
    () => new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK + 99}` } }),
    () => new Response(null, { status: 308, headers: { Range: "items=whatever" } }),
  ];
  onChunk = call => (replies.shift() ?? youtubeChunk)(call);
  const job = await publishAndSettle();
  expect(job.phase).toBe("done");
  expect(chunks().map(rangeOf)).toEqual([
    `bytes 0-${CHUNK - 1}/${size}`,
    `bytes ${CHUNK}-${2 * CHUNK - 1}/${size}`,
    `bytes ${CHUNK + 100}-${2 * CHUNK + 99}/${size}`,
    `bytes ${2 * CHUNK + 100}-${size - 1}/${size}`,
  ]);
});

it("fails when YouTube holds every byte but never confirms the video", async () => {
  const size = renderBytes;
  onChunk = () => new Response(null, { status: 308, headers: { Range: `bytes=0-${size + 50}` } });
  const job = await publishAndSettle();
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_upload_incomplete", error: "The upload ended before YouTube confirmed the video." });
  expect(chunks()).toHaveLength(1);
});

it("fails without uploading when the finished render was emptied or removed", async () => {
  await prerender();
  const render = workspace.ctx.repos.renders.select("project_id = ? AND state = 'done'", [project.id])[0]!;
  const file = join(workspace.ctx.paths.renders(project.id), render.path!);
  const size = statSync(file).size;

  let job = publish();
  expect(job.reusedRender).toBe(true);
  truncateSync(file, 0);
  await settle();
  job = getYouTubeUpload(workspace.ctx, job.id)!;
  expect(job).toMatchObject({ phase: "failed", errorCode: "render_empty", error: "The rendered video file was empty." });

  writeFileSync(file, Buffer.alloc(size, 7));
  job = publish();
  expect(job.reusedRender).toBe(true);
  rmSync(file);
  await settle();
  job = getYouTubeUpload(workspace.ctx, job.id)!;
  expect(job).toMatchObject({ phase: "failed", errorCode: "youtube_upload_failed", error: "Couldn’t upload to YouTube. Try again." });
  expect(inits()).toHaveLength(0);
});

it("keeps only the 40 most recent finished uploads in memory", async () => {
  renderBytes = 1000;
  await prerender();
  const ids: string[] = [];
  for (let i = 0; i < 41; i++) ids.push((await publishAndSettle({ title: `Take ${i}` })).id);
  const kept = listProjectYouTubeUploads(workspace.ctx, project.id);
  expect(kept).toHaveLength(40);
  expect(getYouTubeUpload(workspace.ctx, ids[0]!)).toBeNull();
  expect(getYouTubeUpload(workspace.ctx, ids[40]!)?.phase).toBe("done");
});

it("skips ahead after a dropped chunk when YouTube already holds it", async () => {
  await prerender();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let dropped = false;
  onChunk = call => {
    if (!dropped) { dropped = true; throw new TypeError("fetch failed"); }
    return youtubeChunk(call);
  };
  onProbe = () => new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK - 1}` } });
  const job = await runOut(publish().id);
  expect(job.phase).toBe("done");
  const size = renderBytes;
  expect(chunks().map(rangeOf)).toEqual([`bytes 0-${CHUNK - 1}/${size}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${size}`, `bytes ${2 * CHUNK}-${size - 1}/${size}`]);
  expect(probes().map(rangeOf)).toEqual([`bytes */${size}`]);
  expect(probes()[0]!.headers.get("content-length")).toBe("0");
});

it("retries a chunk after a temporary server error when YouTube shows no new bytes", async () => {
  await prerender();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const replies: Reply[] = [() => json(503, {}), () => json(502, {})];
  onChunk = call => (replies.shift() ?? youtubeChunk)(call);
  const probeReplies: Reply[] = [() => { throw new TypeError("fetch failed"); }, () => new Response(null, { status: 308 })];
  onProbe = call => (probeReplies.shift() ?? (() => new Response(null, { status: 200 })))(call);
  const job = await runOut(publish().id);
  expect(job.phase).toBe("done");
  expect(chunks().slice(0, 3).map(rangeOf)).toEqual(Array(3).fill(`bytes 0-${CHUNK - 1}/${renderBytes}`));
  expect(probes()).toHaveLength(2);
});

it("resumes from the byte YouTube reports after a temporary server error", async () => {
  await prerender();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let failed = false;
  onChunk = call => {
    if (!failed) { failed = true; return json(500, {}); }
    return youtubeChunk(call);
  };
  onProbe = () => new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK + 9}` } });
  const job = await runOut(publish().id);
  expect(job.phase).toBe("done");
  expect(chunks().map(rangeOf)[1]).toBe(`bytes ${CHUNK + 10}-${2 * CHUNK + 9}/${renderBytes}`);
  expect(events.some(e => e.id === job.id && e.bytesUploaded === CHUNK + 10)).toBe(true);
});

it("gives up with an offline message when the connection keeps dropping", async () => {
  await prerender();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onChunk = () => { throw new TypeError("fetch failed"); };
  const job = await runOut(publish().id);
  expect(job).toMatchObject({
    phase: "failed", errorCode: "youtube_offline",
    error: "Connection to YouTube dropped during upload. Check your internet connection and try again.",
  });
  expect(chunks()).toHaveLength(4);
  expect(probes()).toHaveLength(3);
});

it("gives up with YouTube's temporary-error message after repeated server errors", async () => {
  await prerender();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onChunk = () => json(500, { error: { message: "Backend Error" } });
  const job = await runOut(publish().id);
  expect(job).toMatchObject({
    phase: "failed", errorCode: "youtube_server_error",
    error: "YouTube had a temporary error while receiving the video. Try again in a moment.",
  });
  expect(chunks()).toHaveLength(4);
});

it("stops waiting to retry when the editor cancels", async () => {
  await prerender();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onChunk = () => { throw new TypeError("fetch failed"); };
  const job = publish();
  await vi.waitFor(() => expect(chunks()).toHaveLength(1));
  expect(cancelYouTubeUpload(workspace.ctx, job.id).phase).toBe("cancelled");
  vi.useRealTimers();
  await settle();
  expect(getYouTubeUpload(workspace.ctx, job.id)?.phase).toBe("cancelled");
  expect(chunks()).toHaveLength(1);
  expect(probes()).toHaveLength(0);
});

it("stops at once when a server error arrives just after the editor cancels", async () => {
  await prerender();
  let id = "";
  onChunk = () => { cancelYouTubeUpload(workspace.ctx, id); return json(503, {}); };
  id = publish().id;
  await settle();
  expect(getYouTubeUpload(workspace.ctx, id)?.phase).toBe("cancelled");
  expect(chunks()).toHaveLength(1);
  expect(probes()).toHaveLength(0);
});

it("maps YouTube's error replies to plain messages for the editor", () => {
  const cases: Array<[number, { reason?: string; message?: string }, string]> = [
    [401, {}, "youtube_reconnect_required"],
    [403, { reason: "authError" }, "youtube_reconnect_required"],
    [400, { reason: "unauthorized" }, "youtube_reconnect_required"],
    [400, { reason: "invalidCredentials" }, "youtube_reconnect_required"],
    [403, { reason: "quotaExceeded" }, "youtube_quota_exceeded"],
    [403, { reason: "dailyLimitExceeded" }, "youtube_quota_exceeded"],
    [400, { reason: "uploadLimitExceeded" }, "youtube_quota_exceeded"],
    [403, { message: "You have exceeded your Quota." }, "youtube_quota_exceeded"],
    [400, { message: "The user has exceeded the number of videos they may upload (upload limit)." }, "youtube_quota_exceeded"],
    [401, { reason: "quotaExceeded" }, "youtube_reconnect_required"],
    [403, { reason: "youtubeSignupRequired" }, "youtube_no_channel"],
    [404, { reason: "channelNotFound" }, "youtube_no_channel"],
    [403, { message: "The user doesn't have a YouTube account." }, "youtube_no_channel"],
    [403, { reason: "forbidden" }, "youtube_forbidden"],
    [400, { message: "Invalid video title" }, "youtube_invalid_metadata"],
    [400, { reason: "invalidTitle" }, "youtube_invalid_metadata"],
    [400, { reason: "invalidDescription" }, "youtube_upload_failed"],
    [413, {}, "youtube_file_too_large"],
    [500, {}, "youtube_server_error"],
    [503, { reason: "backendError" }, "youtube_server_error"],
    [404, {}, "youtube_upload_failed"],
  ];
  for (const [status, parsed, code] of cases) expect([status, parsed, mapYouTubeApiError(status, parsed).code]).toEqual([status, parsed, code]);
  expect(mapYouTubeApiError(403, { reason: "quotaExceeded" }).message).toBe("YouTube’s daily upload limit was reached. Try again tomorrow or upload directly in YouTube Studio.");
  expect(mapYouTubeApiError(403, { reason: "youtubeSignupRequired" }).message).toBe("This Google account doesn’t have a YouTube channel yet. Create a channel on YouTube, then try again.");
  expect(mapYouTubeApiError(403, {}).message).toBe("YouTube didn’t allow this upload. Check your channel permissions or reconnect in Settings.");
  expect(mapYouTubeApiError(400, { message: "title too long" }).message).toBe("YouTube rejected the video title. Check for unsupported characters or length limits and try again.");
});

it("counts queued, rendering and uploading as running and nothing else", () => {
  expect((["queued", "rendering", "uploading"] as const).every(isUploadActive)).toBe(true);
  expect((["done", "failed", "cancelled"] as const).some(isUploadActive)).toBe(false);
});
