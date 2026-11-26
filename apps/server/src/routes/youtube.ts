import {
  YouTubeConfigRequest,
  YouTubePublishRequest,
} from "@scarlet/shared";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, notFound } from "../errors.js";
import { resolveTimeline } from "../services/timeline.js";
import {
  cancelYouTubeConnect,
  disconnectYouTube,
  getYouTubeStatus,
  startYouTubeConnect,
  updateYouTubeConfig,
} from "../services/youtubeAuth.js";
import { computeYouTubeChapters } from "../services/youtubeKit.js";
import {
  cancelYouTubeUpload,
  getYouTubeUpload,
  listProjectYouTubeUploads,
  startYouTubePublish,
} from "../services/youtubePublish.js";
import { jsonBody, requireProject, requireProjectHeader } from "./util.js";

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

  // --- Final-cut chapter timestamps ---

  r.get("/projects/:id/youtube/chapters", (c) => {
    const project = requireProject(ctx, c.req.param("id"));
    const requestedVersion = c.req.query("version");
    const version = requestedVersion && requestedVersion !== "head" ? requestedVersion : project.head;
    if (!version) throw badRequest("no_timeline", "There’s no edited video yet.");
    const timeline = resolveTimeline(ctx, project, version);
    return c.json(computeYouTubeChapters(ctx, project, timeline));
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
