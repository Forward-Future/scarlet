import { Hono } from "hono";
import { z } from "zod/v3";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { availableTranscriptionProvider } from "../transcribe/index.js";
import { localRuntimeStatus } from "../transcribe/localRuntime.js";
import { jsonBody } from "./util.js";

export function settingsRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  r.get("/settings", async (c) => {
    const settings = ctx.settings();
    const transcriptionAvailable = !!await availableTranscriptionProvider(ctx);
    return c.json({ settings, transcriptionAvailable });
  });

  r.get("/settings/local-model", async (c) => c.json(await localRuntimeStatus(ctx)));

  r.patch("/settings", async (c) => {
    const patch = await jsonBody(c, z.record(z.unknown()));
    const previous = ctx.settings().render;
    const settings = ctx.repos.settings.update(patch);
    if (previous.hwaccel !== settings.render.hwaccel || previous.previewHeight !== settings.render.previewHeight) {
      ctx.bus.publish({ type: "render.settings.updated" });
    }
    return c.json({ settings });
  });

  return r;
}
