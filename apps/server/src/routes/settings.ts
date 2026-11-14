import { Hono } from "hono";
import { z } from "zod/v3";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest } from "../errors.js";
import { availableTranscriptionProvider } from "../transcribe/index.js";
import { localRuntimeIssue, localRuntimeStatus, resolveLocalRuntime } from "../transcribe/localRuntime.js";
import { jsonBody } from "./util.js";

/** Why nothing can transcribe, in the editor's words, so Media can say it and offer the fix. */
async function transcriptionIssue(ctx: Ctx): Promise<string> {
  const s = ctx.settings().transcription;
  if (s.provider === "openai") return ctx.env.openaiKey ? "OpenAI transcription is unavailable." : "OpenAI transcription needs an API key.";
  // A library is left off only where no local runtime was found: each launch that finds one turns it on.
  return await localRuntimeIssue(resolveLocalRuntime(ctx, { ...s, provider: "whispercpp" })) ?? "Local transcription is unavailable.";
}

export function settingsRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  r.get("/settings", async (c) => {
    const settings = ctx.settings();
    const transcriptionAvailable = !!await availableTranscriptionProvider(ctx);
    return c.json({ settings, transcriptionAvailable, telemetryUnavailable: ctx.telemetry.unavailable,
      ...!transcriptionAvailable && { transcriptionIssue: await transcriptionIssue(ctx) } });
  });

  r.get("/settings/local-model", async (c) => c.json(await localRuntimeStatus(ctx)));

  r.patch("/settings", async (c) => {
    const patch = await jsonBody(c, z.record(z.unknown()));
    if ("dialogue" in patch) throw badRequest("dialogue_settings_moved", "Edit the Dialogue pass skill to change dialogue preferences.");
    const previous = ctx.settings().render;
    const settings = ctx.repos.settings.update(patch);
    ctx.telemetry.refreshPreference();
    if (previous.hwaccel !== settings.render.hwaccel || previous.previewHeight !== settings.render.previewHeight) {
      ctx.bus.publish({ type: "render.settings.updated" });
    }
    return c.json({ settings });
  });

  return r;
}
