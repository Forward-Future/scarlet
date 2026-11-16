import { stat } from "node:fs/promises";
import { fileInDirectoryAsync } from "@scarlet/render";
import { Hono, type Context } from "hono";
import type { MediaAsset } from "@scarlet/timeline";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, conflict, HttpError, notFound } from "../errors.js";
import { measuredLoudness } from "../render/loudness.js";
import { faces } from "../services/faces.js";
import { screenText } from "../services/screenText.js";
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
    const result = await measuredLoudness(ctx, file, [media.hash, info.size, info.ctimeMs, info.mtimeMs], { from, to,
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

  // Where the faces are in a range of a video, found once and kept. A range not read yet is read now, as screen text is.
  r.get("/projects/:projectId/media/:mediaId/faces", readPicture("faces", (media, range, opts) => faces(ctx, media, range, opts)));

  return r;
}
