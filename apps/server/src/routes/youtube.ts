import { parseMultipartRequest } from "@remix-run/multipart-parser/future";
import {
  YouTubeConfigRequest,
  YouTubeKitRequest,
  YouTubePublishRequest,
} from "@scarlet/shared";
import { Hono } from "hono";
import { z } from "zod/v3";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, HttpError, notFound } from "../errors.js";
import { serveFile } from "../files.js";
import { resolveTimeline } from "../services/timeline.js";
import {
  cancelYouTubeConnect,
  disconnectYouTube,
  getYouTubeStatus,
  startYouTubeConnect,
  updateYouTubeConfig,
} from "../services/youtubeAuth.js";
import {
  capturePlayheadThumbnail,
  generateYouTubePublishingKit,
  resolveStoredThumbnail,
  saveCustomThumbnail,
} from "../services/youtubeKit.js";
import {
  cancelYouTubeUpload,
  getYouTubeUpload,
  listProjectYouTubeUploads,
  startYouTubePublish,
} from "../services/youtubePublish.js";
import { jsonBody, multipartError, requireProject, requireProjectHeader } from "./util.js";

const MAX_CUSTOM_THUMB_UPLOAD = 25 * 1024 * 1024;

export function youtubeRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  // --- Account connection & OAuth configuration (Settings) ---

  r.get("/settings/youtube", (c) => c.json({ status: getYouTubeStatus(ctx) }));

  r.put("/settings/youtube/config", async (c) => {
    const body = await jsonBody(c, YouTubeConfigRequest);
    const status = updateYouTubeConfig(ctx, body);
    return c.json({ status });
  });

  r.post("/settings/youtube/connect", async (c) => {
    const result = await startYouTubeConnect(ctx);
    return c.json(result);
  });

  r.post("/settings/youtube/cancel", (c) => c.json({ status: cancelYouTubeConnect(ctx) }));

  r.post("/settings/youtube/disconnect", async (c) => {
    const status = await disconnectYouTube(ctx);
    return c.json({ status });
  });

  // --- Publishing Kit & Thumbnails ---

  r.post("/projects/:id/youtube/kit", async (c) => {
    const body = await jsonBody(c, YouTubeKitRequest);
    const project = requireProject(ctx, c.req.param("id"));
    const version = body.version && body.version !== "head" ? body.version : project.head;
    if (!version) throw badRequest("no_timeline", "There’s no edited video to draft a Publishing Kit for yet.");
    const timeline = resolveTimeline(ctx, project, version);
    const kit = await generateYouTubePublishingKit(ctx, project, timeline, {
      useAi: body.useAi,
      signal: c.req.raw.signal,
    });
    return c.json({ kit });
  });

  r.post("/projects/:id/youtube/thumbnail-frame", async (c) => {
    const body = await jsonBody(c, z.object({
      version: z.string().min(1).optional(),
      time: z.number().finite().nonnegative(),
    }));
    const project = requireProject(ctx, c.req.param("id"));
    const version = body.version && body.version !== "head" ? body.version : project.head;
    if (!version) throw badRequest("no_timeline", "There’s no edited video yet.");
    const timeline = resolveTimeline(ctx, project, version);
    const thumbnail = await capturePlayheadThumbnail(ctx, project, timeline, body.time, c.req.raw.signal);
    return c.json({ thumbnail });
  });

  r.post("/projects/:id/youtube/thumbnail-upload", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      let bytes: Buffer | undefined;
      let mime: string | undefined;
      let name: string | undefined;
      try {
        for await (const part of parseMultipartRequest(c.req.raw, { maxFileSize: MAX_CUSTOM_THUMB_UPLOAD, maxParts: 4 })) {
          if (part.name === "file" && part.isFile) {
            bytes = Buffer.from(await part.bytes());
            mime = part.mediaType;
            name = part.filename;
          }
        }
      } catch (err) {
        multipartError(err, {
          tooLarge: () => new HttpError(413, "thumbnail_too_large", "Choose an image smaller than 25 MB."),
          invalid: () => badRequest("invalid_thumbnail", "Couldn’t read the uploaded thumbnail image."),
        });
      }
      if (!bytes || !bytes.length) throw badRequest("invalid_thumbnail", "Choose an image file to upload.");
      const thumbnail = await saveCustomThumbnail(ctx, project.id, { bytes, mime, name }, c.req.raw.signal);
      return c.json({ thumbnail });
    }
    const body = await jsonBody(c, z.object({ path: z.string().min(1).max(4096) }));
    const thumbnail = await saveCustomThumbnail(ctx, project.id, { path: body.path }, c.req.raw.signal);
    return c.json({ thumbnail });
  });

  r.get("/projects/:id/youtube/thumbnails/:thumbId", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const found = resolveStoredThumbnail(ctx, project.id, c.req.param("thumbId"));
    if (!found) throw notFound("thumbnail");
    return serveFile(c.req.raw, found.path, { cacheControl: "private, max-age=3600" });
  });

  // --- Direct Upload / Publish ---

  r.post("/projects/:id/youtube/publish", async (c) => {
    const body = await jsonBody(c, YouTubePublishRequest);
    const upload = startYouTubePublish(ctx, c.var.user, c.req.param("id"), body);
    return c.json({ upload }, 201);
  });

  r.get("/projects/:id/youtube/uploads", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json({ uploads: listProjectYouTubeUploads(ctx, project.id) });
  });

  r.get("/youtube/uploads/:uploadId", (c) => {
    const upload = getYouTubeUpload(ctx, c.req.param("uploadId"));
    if (!upload) throw notFound(`YouTube upload ${c.req.param("uploadId")}`);
    return c.json({ upload });
  });

  r.post("/youtube/uploads/:uploadId/cancel", (c) => {
    const upload = cancelYouTubeUpload(ctx, c.req.param("uploadId"));
    return c.json({ upload });
  });

  return r;
}
