import { stat } from "node:fs/promises";
import { fileInDirectoryAsync } from "@scarlet/render";
import { Hono, type Context } from "hono";
import type { MediaAsset } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { measuredLoudness } from "../render/loudness.js";
import { faces } from "../services/faces.js";
import { lipSync } from "../services/lipSync.js";
import { pictureCuts } from "../services/pictureCuts.js";
import { screenMotion } from "../services/screenMotion.js";
import { screenText } from "../services/screenText.js";
import { askAreas, editShowAreas, showArea, type ShowAreaEdit } from "../services/showArea.js";
import { requestAttempt, requireActiveAttempt } from "../services/taskAttempt.js";
import { optionalNumberParam, requireMedia } from "./util.js";

function requireSourceRange(from: number | undefined, to: number | undefined) {
  if ((from !== undefined && from < 0) || (from !== undefined && to !== undefined && to <= from)) {
    throw badRequest("bad_range", "Choose a positive source range in seconds.");
  }
}

/** Read-only measurements the agent tools need beyond waveforms and transcripts. */
export function perceptionRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  // Integrated loudness (EBU R128) of a source's first audio stream, optionally for a range.
  r.get("/projects/:projectId/media/:mediaId/loudness", async c => {
    const media = requireMedia(ctx, c.req.param("mediaId"), c.req.param("projectId"));
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "This media has no audio to measure.");
    const from = optionalNumberParam(c.req.query("from"), "from"), to = optionalNumberParam(c.req.query("to"), "to");
    requireSourceRange(from, to);
    const file = await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path);
    if (!file) throw notFound("source file");
    const info = await stat(file);
    // A measurement someone asked for, such as a running edit's, isn't stopped by a pause of the project's media work.
    const result = await measuredLoudness(ctx, file, [media.hash, info.size, info.ctimeMs, info.mtimeMs], { from, to, projectId: media.projectId,
      stop: ctx.projectSignal(media.projectId) });
    return c.json({ mediaId: media.id, ...(from !== undefined && { from }), ...(to !== undefined && { to }), ...result });
  });

  /**
   * A reading of a video's picture over a range. What the caller asked wrong is a 400 and a recording not ready to read
   * is a 409; a caller that went away gets 499. Anything else is the engine's fault and goes to the error handler as a 500.
   */
  const readPicture = <T>(name: string, read: (media: MediaAsset & { projectId: string }, range: { from?: number; to?: number },
    opts: { waitMs: number; signal: AbortSignal }, c: Context<AppEnv>) => Promise<T>) => async (c: Context<AppEnv>) => {
    const media = requireMedia(ctx, c.req.param("mediaId") ?? "", c.req.param("projectId") ?? "");
    if (media.kind !== "video") throw badRequest("no_picture", "Only a video has a picture to read.");
    const number = (key: string) => optionalNumberParam(c.req.query(key), key);
    const from = number("from"), to = number("to"), wait = number("wait");
    requireSourceRange(from, to);
    // The reading checks these too: asked here first, they are answered for what they are rather than as a fault.
    const duration = media.duration;
    if (!duration) throw conflict("not_ready", "The recording is still being prepared. Ask again in a moment.");
    if (!await fileInDirectoryAsync(ctx.paths.media(media.projectId), media.path)) throw notFound("source file");
    if (!(Math.min(duration, to ?? duration) > Math.max(0, from ?? 0))) {
      throw badRequest("bad_range", `Choose a range inside the recording's ${duration.toFixed(2)} s.`);
    }
    const signal = c.req.raw.signal;
    try {
      const result = await read(media, { from, to }, { waitMs: Math.max(0, Math.min(60, wait ?? 30)) * 1000, signal }, c);
      return signal.aborted ? new Response(null, { status: 499 }) : c.json(result as object);
    } catch (error) {
      if (signal.aborted) return new Response(null, { status: 499 });
      if (error instanceof HttpError) throw error;
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };

  // The text on screen in a range of a video, read once and kept. A range not read yet is read now: the answer waits up
  // to `wait` seconds (default 30) and says how much it has read, and the reading carries on for the next ask.
  r.get("/projects/:projectId/media/:mediaId/screen-text", readPicture("screen text", (media, range, opts, c) =>
    screenText(ctx, media, range, { ...opts, query: c.req.query("q") || undefined })));

  // Where a video's picture changes in a range, second by second, read once and kept as screen text is.
  r.get("/projects/:projectId/media/:mediaId/screen-motion", readPicture("screen motion", (media, range, opts) => screenMotion(ctx, media, range, opts)));

  // Where a video's picture cuts in a range: much of it changing at once and holding either side. Read once and kept.
  r.get("/projects/:projectId/media/:mediaId/picture-cuts", readPicture("picture cuts", (media, range, opts) => pictureCuts(ctx, media, range, opts)));

  // Where the faces are in a range of a video, found once and kept. A range not read yet is read now, as screen text is.
  r.get("/projects/:projectId/media/:mediaId/faces", readPicture("faces", (media, range, opts) => faces(ctx, media, range, opts)));

  // Whether a video's sound keeps time with its own picture, from a face talking in it: a few stretches across the range,
  // each measured once and kept. Waits up to `wait` seconds (default 60); stretches not done yet carry on.
  r.get("/projects/:projectId/media/:mediaId/lip-sync", readPicture("lip sync", (media, range, opts, c) => {
    const count = optionalNumberParam(c.req.query("count"), "count"), seconds = optionalNumberParam(c.req.query("seconds"), "seconds");
    if (count !== undefined && !(Number.isInteger(count) && count >= 1 && count <= 20)) throw badRequest("bad_count", "count is 1 to 20 stretches.");
    if (seconds !== undefined && !(seconds >= 5 && seconds <= 120)) throw badRequest("bad_seconds", "seconds is 5 to 120 a stretch.");
    if (media.hasAudio === false) throw badRequest("no_audio", "This video has no sound of its own to measure against its picture.");
    const wait = optionalNumberParam(c.req.query("wait"), "wait");
    return lipSync(ctx, media, { ...range, count, seconds }, { waitMs: Math.max(0, Math.min(240, wait ?? 60)) * 1000, signal: opts.signal });
  }));

  // What of a video's picture viewers may see: the areas given for it and where each holds. A first ask reads the
  // recording's edges and waits up to `wait` seconds (default 30); `done` is false until they are read.
  const areaWait = (c: Context<AppEnv>) => Math.max(0, Math.min(240, optionalNumberParam(c.req.query("wait"), "wait") ?? 30)) * 1000;
  const videoFor = (c: Context<AppEnv>) => {
    const media = requireMedia(ctx, c.req.param("mediaId") ?? "", c.req.param("projectId") ?? "");
    if (media.kind !== "video") throw badRequest("no_picture", "Only a video has a picture to show.");
    if (!media.duration) throw conflict("not_ready", "The recording is still being prepared. Ask again in a moment.");
    return media;
  };
  r.get("/projects/:projectId/media/:mediaId/show-area", async c => c.json(await showArea(ctx, videoFor(c), { waitMs: areaWait(c) })));
  r.post("/projects/:projectId/media/:mediaId/show-area", async c => {
    const media = videoFor(c);
    const body = await c.req.json().catch(() => null) as ShowAreaEdit | null;
    const listOf = (value: unknown, fits: (item: any) => boolean) => value === undefined || (Array.isArray(value) && value.every(fits));
    if (!body || !listOf(body.set, item => typeof item?.at === "number" && Array.isArray(item.area)) || !listOf(body.remove, at => typeof at === "number")) {
      throw badRequest("bad_request", "Send set: [{ at, area }] and/or remove: [at].");
    }
    // A run sets areas only while it is the run at work: a look stopped with the request that asked for it says nothing.
    requireActiveAttempt(ctx, requestAttempt(c.req.raw), media.projectId);
    await editShowAreas(ctx, media, body);
    return c.json(await showArea(ctx, media, { waitMs: areaWait(c) }));
  });

  // Have the frames at these source seconds looked at for what viewers may see, each by a short run of its own, and
  // wait for the answers. Only a running request asks: its agent and model do the looking.
  r.post("/projects/:projectId/media/:mediaId/show-area/ask", async c => {
    const media = videoFor(c);
    const body = await c.req.json().catch(() => null) as { seconds?: unknown; taskId?: unknown; again?: unknown } | null;
    if (!body || !Array.isArray(body.seconds) || body.seconds.some(n => typeof n !== "number") || typeof body.taskId !== "string") {
      throw badRequest("bad_request", "Send seconds: [source second] and taskId.");
    }
    // A run asks for looks for itself, while it is at work: one stopped or put back in line starts none.
    const attempt = requestAttempt(c.req.raw);
    if (attempt) requireActiveAttempt(ctx, attempt, media.projectId, body.taskId);
    const asked = await askAreas(ctx, media, { seconds: body.seconds as number[], taskId: body.taskId, waitMs: areaWait(c), again: body.again === true });
    return c.json({ ...asked, ...await showArea(ctx, media, { waitMs: 5000 }) });
  });

  return r;
}
