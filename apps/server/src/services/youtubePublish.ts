/**
 * Direct publish to YouTube Data API v3:
 * 1. Renders the final delivery MP4 via Scarlet's RenderQueue (automatically reusing any
 *    existing completed delivery render for the exact same timeline head and settings!).
 * 2. Uploads via YouTube Data API v3 Resumable Upload (`uploadType=resumable`) in chunks
 *    streamed directly from disk, reporting live progress and supporting cancellation & retry.
 * 3. Maps quota, expired/revoked auth, missing channel, and offline errors into plain English.
 */
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  fullRenderContext,
  type Render,
  type User,
  type WsEvent,
  type YouTubePublishRequest,
  type YouTubeUploadJob,
} from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { actorFor, logActivity } from "./activity.js";
import { getValidYouTubeAccessToken, getYouTubeStatus, markYouTubeNeedsReconnect } from "./youtubeAuth.js";

const DEFAULT_UPLOAD_BASE = "https://www.googleapis.com";
// Google resumable uploads require chunk sizes to be a multiple of 256 KiB (except the final chunk).
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const PROGRESS_THROTTLE_MS = 200;
const MAX_CHUNK_RETRIES = 3;

interface ActiveUpload {
  job: YouTubeUploadJob;
  controller: AbortController;
  renderOwner?: string;
}

interface UploadStore {
  byId: Map<string, ActiveUpload>;
  shutdownBound?: boolean;
}

const stores = new WeakMap<Ctx, UploadStore>();

function uploadStore(ctx: Ctx): UploadStore {
  let store = stores.get(ctx);
  if (!store) {
    store = { byId: new Map() };
    stores.set(ctx, store);
  }
  if (!store.shutdownBound) {
    store.shutdownBound = true;
    ctx.shutdown.addEventListener("abort", () => {
      for (const entry of store!.byId.values()) {
        if (isUploadActive(entry.job.phase)) entry.controller.abort();
      }
    }, { once: true });
  }
  return store;
}

export function isUploadActive(phase: YouTubeUploadJob["phase"]): boolean {
  return phase === "queued" || phase === "rendering" || phase === "uploading";
}

function fetchImpl(ctx: Ctx): typeof fetch {
  return ctx.options.youtube?.fetch ?? globalThis.fetch;
}

function emitUpload(ctx: Ctx, job: YouTubeUploadJob): void {
  ctx.bus.publish({ type: "youtube.upload.updated", projectId: job.projectId, upload: { ...job } });
}

interface ParsedGoogleError {
  reason?: string;
  message?: string;
}

async function parseGoogleError(res: Response): Promise<ParsedGoogleError> {
  try {
    const json = (await res.json()) as {
      error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> };
    };
    const first = json?.error?.errors?.[0];
    return {
      reason: first?.reason,
      message: first?.message ?? json?.error?.message,
    };
  } catch {
    return {};
  }
}

export function mapYouTubeApiError(status: number, parsed: ParsedGoogleError): { code: string; message: string } {
  const reason = (parsed.reason ?? "").toLowerCase();
  const msg = (parsed.message ?? "").toLowerCase();

  if (status === 401 || reason === "autherror" || reason === "unauthorized" || reason === "invalidcredentials") {
    return {
      code: "youtube_reconnect_required",
      message: "Your YouTube sign-in expired or was revoked. Reconnect your account in Settings.",
    };
  }
  if (
    reason === "quotaexceeded"
    || reason === "dailylimitexceeded"
    || reason === "uploadlimitexceeded"
    || msg.includes("quota")
    || msg.includes("upload limit")
  ) {
    return {
      code: "youtube_quota_exceeded",
      message: "YouTube’s daily upload limit was reached. Try again tomorrow or upload directly in YouTube Studio.",
    };
  }
  if (reason === "youtubesignuprequired" || reason === "channelnotfound" || msg.includes("youtube account")) {
    return {
      code: "youtube_no_channel",
      message: "This Google account doesn’t have a YouTube channel yet. Create a channel on YouTube, then try again.",
    };
  }
  if (status === 403) {
    return {
      code: "youtube_forbidden",
      message: "YouTube didn’t allow this upload. Check your channel permissions or reconnect in Settings.",
    };
  }
  if (status === 400 && (msg.includes("title") || reason.includes("title"))) {
    return {
      code: "youtube_invalid_metadata",
      message: "YouTube rejected the video title. Check for unsupported characters or length limits and try again.",
    };
  }
  if (status === 413) {
    return {
      code: "youtube_file_too_large",
      message: "This video exceeds YouTube’s upload size limit for this account.",
    };
  }
  if (status >= 500) {
    return {
      code: "youtube_server_error",
      message: "YouTube had a temporary error while receiving the video. Try again in a moment.",
    };
  }
  return {
    code: "youtube_upload_failed",
    message: "YouTube couldn’t complete the upload. Try again.",
  };
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException & { cause?: { code?: string } }).code
    ?? (err as { cause?: { code?: string } }).cause?.code
    ?? "";
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
    return true;
  }
  return /fetch failed|network|socket|getaddrinfo|offline/i.test(err.message);
}

/** Parse Google's `Range: bytes=0-1048575` header returned on 308 Resume Incomplete responses. */
function parseCommittedOffset(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const match = /bytes=\d+-(\d+)/i.exec(rangeHeader);
  if (!match) return null;
  const lastByte = Number(match[1]);
  return Number.isSafeInteger(lastByte) && lastByte >= 0 ? lastByte + 1 : null;
}

export function getYouTubeUpload(ctx: Ctx, uploadId: string): YouTubeUploadJob | null {
  const entry = uploadStore(ctx).byId.get(uploadId);
  return entry ? { ...entry.job } : null;
}

export function listProjectYouTubeUploads(ctx: Ctx, projectId: string): YouTubeUploadJob[] {
  return [...uploadStore(ctx).byId.values()]
    .filter(e => e.job.projectId === projectId)
    .map(e => ({ ...e.job }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function cancelYouTubeUpload(ctx: Ctx, uploadId: string): YouTubeUploadJob {
  const entry = uploadStore(ctx).byId.get(uploadId);
  if (!entry) throw notFound(`YouTube upload ${uploadId}`);
  if (!isUploadActive(entry.job.phase)) return { ...entry.job };

  entry.controller.abort();
  if (entry.job.renderId && entry.renderOwner) {
    ctx.renders.release(entry.job.renderId, entry.renderOwner);
  }
  entry.job = {
    ...entry.job,
    phase: "cancelled",
    finishedAt: now(),
  };
  emitUpload(ctx, entry.job);
  ctx.log(`[youtube] upload cancelled id=${uploadId}`);
  return { ...entry.job };
}

export function startYouTubePublish(
  ctx: Ctx,
  user: User,
  projectId: string,
  req: YouTubePublishRequest,
): YouTubeUploadJob {
  const project = ctx.repos.projects.get(projectId);
  if (!project) throw notFound(`project ${projectId}`);
  const version = req.version && req.version !== "head" ? req.version : project.head;
  if (!version || !ctx.repos.versions.exists(projectId, version)) {
    throw badRequest("no_timeline", "There’s no edited video to publish yet.");
  }

  const authStatus = getYouTubeStatus(ctx);
  if (authStatus.state !== "connected" || authStatus.needsReconnect) {
    throw new HttpError(
      401,
      authStatus.needsReconnect ? "youtube_reconnect_required" : "youtube_not_connected",
      authStatus.needsReconnect
        ? "Your YouTube sign-in expired or was revoked. Reconnect your account in Settings."
        : "Connect your YouTube account in Settings before uploading.",
    );
  }

  // Prevent overlapping active uploads on the same project.
  const store = uploadStore(ctx);
  const existingActive = [...store.byId.values()].find(e => e.job.projectId === projectId && isUploadActive(e.job.phase));
  if (existingActive) {
    throw new HttpError(409, "youtube_upload_in_progress", "A YouTube upload is already running for this project.");
  }

  const customExport = !!req.height || !!req.bestQuality;
  const exportOptions = customExport
    ? { ...(req.height ? { height: req.height } : {}), ...(req.bestQuality ? { bestQuality: true } : {}) }
    : undefined;
  const renderOwner = randomUUID();
  const render = ctx.renders.request(
    {
      projectId,
      version,
      kind: customExport ? "export" : "full",
      range: null,
      quality: req.bestQuality ? "delivery" : req.quality,
      exportOptions,
    },
    renderOwner,
  );
  const reusedRender = render.state === "done";
  const context = fullRenderContext({ ...project, head: version });
  const job: YouTubeUploadJob = {
    id: newId("ytup"),
    projectId,
    version,
    context,
    renderId: render.id,
    reusedRender,
    phase: reusedRender ? "uploading" : "rendering",
    progress: reusedRender ? 0 : render.progress,
    title: req.title,
    visibility: req.visibility,
    createdAt: now(),
  };

  const entry: ActiveUpload = {
    job,
    controller: new AbortController(),
    renderOwner,
  };
  store.byId.set(job.id, entry);
  // Keep at most 40 recent upload records in memory.
  while (store.byId.size > 40) {
    const oldestKey = [...store.byId.entries()].find(([, v]) => !isUploadActive(v.job.phase))?.[0];
    if (!oldestKey) break;
    store.byId.delete(oldestKey);
  }

  emitUpload(ctx, entry.job);
  const signal = AbortSignal.any([entry.controller.signal, ctx.projectSignal(projectId), ctx.shutdown]);

  const pipeline = runPublishPipeline(ctx, user, entry, render, req, signal).finally(() => {
    ctx.renders.release(render.id, renderOwner);
  });
  void ctx.track(pipeline, projectId);
  return { ...entry.job };
}

async function waitForRenderReady(
  ctx: Ctx,
  render: Render,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
): Promise<Render> {
  if (render.state === "done") return render;
  if (render.state === "failed" || render.state === "cancelled") {
    throw new HttpError(500, "render_failed", render.error || "Rendering the video stopped before uploading.");
  }

  return new Promise<Render>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      ctx.bus.off("ws", onWs);
      ctx.bus.off("render.finished", onFinished);
      signal.removeEventListener("abort", onAbort);
      clearInterval(poll);
      fn();
    };
    const check = (current: Render | null | undefined) => {
      if (!current) return;
      if (current.state === "running") onProgress(current.progress);
      if (current.state === "done") finish(() => resolve(current));
      else if (current.state === "failed" || current.state === "cancelled") {
        finish(() => reject(new HttpError(500, "render_failed", current.error || "Rendering the video stopped before uploading.")));
      }
    };
    const onWs = (ev: WsEvent) => {
      if (ev.type === "render.updated" && ev.render.id === render.id) check(ev.render);
    };
    const onFinished = (ev: { renderId: string }) => {
      if (ev.renderId === render.id) check(ctx.repos.renders.get(render.id));
    };
    const onAbort = () => finish(() => reject(new DOMException("Upload cancelled", "AbortError")));

    ctx.bus.on("ws", onWs);
    ctx.bus.on("render.finished", onFinished);
    signal.addEventListener("abort", onAbort, { once: true });
    // Safety check in case render finished between request() and listener registration.
    const poll = setInterval(() => check(ctx.repos.renders.get(render.id)), 500);
    poll.unref();
    check(ctx.repos.renders.get(render.id));
  });
}

async function runPublishPipeline(
  ctx: Ctx,
  user: User,
  entry: ActiveUpload,
  initialRender: Render,
  req: YouTubePublishRequest,
  signal: AbortSignal,
): Promise<void> {
  const update = (patch: Partial<YouTubeUploadJob>) => {
    if (entry.job.phase === "cancelled") return;
    entry.job = { ...entry.job, ...patch };
    emitUpload(ctx, entry.job);
  };

  try {
    let lastProgressAt = 0;
    const render = await waitForRenderReady(ctx, initialRender, progress => {
      const t = Date.now();
      if (t - lastProgressAt < PROGRESS_THROTTLE_MS && progress < 1) return;
      lastProgressAt = t;
      update({ phase: "rendering", progress });
    }, signal);
    signal.throwIfAborted();

    if (!render.path) throw new HttpError(500, "render_missing", "The exported video file could not be found.");
    const videoFile = join(ctx.paths.renders(entry.job.projectId), render.path);
    const info = await stat(videoFile);
    if (!info.isFile() || info.size <= 0) {
      throw new HttpError(500, "render_empty", "The rendered video file was empty.");
    }

    update({ phase: "uploading", progress: 0, bytesUploaded: 0, bytesTotal: info.size });

    const { videoId } = await uploadVideoResumable(ctx, {
      filePath: videoFile,
      fileSize: info.size,
      title: req.title,
      description: req.description,
      visibility: req.visibility,
      signal,
      onProgress: (uploaded, total) => {
        const t = Date.now();
        if (t - lastProgressAt < PROGRESS_THROTTLE_MS && uploaded < total) return;
        lastProgressAt = t;
        update({
          phase: "uploading",
          bytesUploaded: uploaded,
          bytesTotal: total,
          progress: total > 0 ? Math.min(1, uploaded / total) : 1,
        });
      },
    });
    signal.throwIfAborted();

    const studioUrl = `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/edit`;
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    update({
      phase: "done",
      progress: 1,
      bytesUploaded: info.size,
      bytesTotal: info.size,
      videoId,
      studioUrl,
      watchUrl,
      finishedAt: now(),
    });
    ctx.log(`[youtube] upload complete id=${entry.job.id} visibility=${req.visibility}${entry.job.reusedRender ? " reusedRender=true" : ""}`);
    logActivity(ctx, {
      projectId: entry.job.projectId,
      actor: actorFor(user),
      type: "youtube.published",
      summary: `Uploaded to YouTube (${req.visibility})`,
      data: {
        version: entry.job.version,
        videoId,
        visibility: req.visibility,
        studioUrl,
        ...(entry.job.reusedRender && { reusedRender: true }),
      },
    });
  } catch (err) {
    if (signal.aborted || entry.job.phase === "cancelled" || (err instanceof Error && err.name === "AbortError")) {
      if (entry.job.phase !== "cancelled") {
        entry.job = { ...entry.job, phase: "cancelled", finishedAt: now() };
        emitUpload(ctx, entry.job);
      }
      return;
    }
    let code = "youtube_upload_failed";
    let message = "Couldn’t upload to YouTube. Try again.";
    if (err instanceof HttpError) {
      code = err.code;
      message = err.message;
    } else if (isNetworkFailure(err)) {
      code = "youtube_offline";
      message = "Couldn’t reach YouTube. Check your internet connection and try again.";
    }
    ctx.log(`[youtube] upload failed id=${entry.job.id} code=${code}`);
    update({
      phase: "failed",
      error: message,
      errorCode: code,
      finishedAt: now(),
    });
  }
}

async function uploadVideoResumable(
  ctx: Ctx,
  opts: {
    filePath: string;
    fileSize: number;
    title: string;
    description: string;
    visibility: YouTubePublishRequest["visibility"];
    signal: AbortSignal;
    onProgress: (uploaded: number, total: number) => void;
  },
): Promise<{ videoId: string }> {
  const uploadBase = (ctx.options.youtube?.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE).replace(/\/+$/, "");
  const initUrl = `${uploadBase}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`;
  const metadata = JSON.stringify({
    snippet: {
      title: opts.title,
      description: opts.description,
      categoryId: "22",
    },
    status: {
      privacyStatus: opts.visibility,
      selfDeclaredMadeForKids: false,
    },
  });

  // 1. Initiate resumable session (refresh token once if 401).
  let accessToken = await getValidYouTubeAccessToken(ctx);
  let initRes: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      initRes = await fetchImpl(ctx)(initUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(opts.fileSize),
          "X-Upload-Content-Type": "video/mp4",
        },
        body: metadata,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal.aborted) throw err;
      throw new HttpError(503, "youtube_offline", "Couldn’t reach YouTube. Check your internet connection and try again.");
    }
    if (initRes.status === 401 && attempt === 0) {
      accessToken = await getValidYouTubeAccessToken(ctx, { forceRefresh: true });
      continue;
    }
    break;
  }

  if (!initRes || !initRes.ok) {
    const status = initRes?.status ?? 502;
    const parsed = initRes ? await parseGoogleError(initRes) : {};
    if (status === 401) markYouTubeNeedsReconnect(ctx);
    const mapped = mapYouTubeApiError(status, parsed);
    throw new HttpError(status >= 400 && status < 600 ? status : 502, mapped.code, mapped.message);
  }

  const sessionUri = initRes.headers.get("location");
  if (!sessionUri) {
    throw new HttpError(502, "youtube_missing_session", "YouTube didn’t return an upload session address. Try again.");
  }

  // 2. Stream file in resumable chunks.
  const chunkBytes = Math.max(256 * 1024, ctx.options.youtube?.uploadChunkBytes ?? DEFAULT_CHUNK_BYTES);
  const fh = await open(opts.filePath, "r");
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, opts.fileSize));
  let offset = 0;

  try {
    while (offset < opts.fileSize) {
      opts.signal.throwIfAborted();
      const remaining = opts.fileSize - offset;
      const toRead = Math.min(buffer.length, remaining);
      const { bytesRead } = await fh.read(buffer, 0, toRead, offset);
      if (bytesRead <= 0) throw new HttpError(500, "render_truncated", "The exported video file ended unexpectedly.");
      const chunk = buffer.subarray(0, bytesRead);
      const endByte = offset + bytesRead - 1;

      let putRes: Response | undefined;
      for (let retry = 0; retry <= MAX_CHUNK_RETRIES; retry++) {
        opts.signal.throwIfAborted();
        try {
          putRes = await fetchImpl(ctx)(sessionUri, {
            method: "PUT",
            headers: {
              "Content-Length": String(bytesRead),
              "Content-Range": `bytes ${offset}-${endByte}/${opts.fileSize}`,
              "Content-Type": "video/mp4",
            },
            body: new Uint8Array(chunk),
            signal: opts.signal,
          });
        } catch (err) {
          if (opts.signal.aborted) throw err;
          if (retry < MAX_CHUNK_RETRIES) {
            await sleepWithSignal(400 * (retry + 1), opts.signal);
            const resumed = await queryUploadOffset(ctx, sessionUri, opts.fileSize, opts.signal);
            if (resumed !== null && resumed > offset) {
              offset = resumed;
              putRes = undefined;
              break;
            }
            continue;
          }
          throw new HttpError(503, "youtube_offline", "Connection to YouTube dropped during upload. Check your internet connection and try again.");
        }

        if (putRes.status >= 500 && retry < MAX_CHUNK_RETRIES) {
          await sleepWithSignal(400 * (retry + 1), opts.signal);
          const resumed = await queryUploadOffset(ctx, sessionUri, opts.fileSize, opts.signal);
          if (resumed !== null && resumed > offset) {
            offset = resumed;
            putRes = undefined;
            break;
          }
          continue;
        }
        break;
      }

      // Resumed ahead via status probe — continue outer loop from new offset.
      if (!putRes) {
        opts.onProgress(offset, opts.fileSize);
        continue;
      }

      if (putRes.status === 308) {
        const committed = parseCommittedOffset(putRes.headers.get("range"));
        offset = committed !== null ? Math.min(opts.fileSize, committed) : offset + bytesRead;
        opts.onProgress(offset, opts.fileSize);
        continue;
      }

      if (putRes.status === 200 || putRes.status === 201) {
        const json = (await putRes.json().catch(() => ({}))) as { id?: string };
        if (!json.id) {
          throw new HttpError(502, "youtube_missing_video_id", "YouTube finished the upload, but didn’t return a video ID.");
        }
        opts.onProgress(opts.fileSize, opts.fileSize);
        return { videoId: json.id };
      }

      const parsed = await parseGoogleError(putRes);
      if (putRes.status === 401) markYouTubeNeedsReconnect(ctx);
      const mapped = mapYouTubeApiError(putRes.status, parsed);
      throw new HttpError(putRes.status >= 400 && putRes.status < 600 ? putRes.status : 502, mapped.code, mapped.message);
    }
  } finally {
    await fh.close();
  }

  throw new HttpError(502, "youtube_upload_incomplete", "The upload ended before YouTube confirmed the video.");
}

async function queryUploadOffset(ctx: Ctx, sessionUri: string, totalSize: number, signal: AbortSignal): Promise<number | null> {
  try {
    const res = await fetchImpl(ctx)(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
        "Content-Range": `bytes */${totalSize}`,
      },
      signal,
    });
    if (res.status === 308) return parseCommittedOffset(res.headers.get("range"));
  } catch {
    // Ignore probe errors; main loop will retry or fail cleanly.
  }
  return null;
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
