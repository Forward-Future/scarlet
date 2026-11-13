import { join } from "node:path";
import type { Project, TimeRange } from "@scarlet/timeline";
import type { Render } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { conflict, notFound } from "../errors.js";
import { waitFor } from "../events.js";

export async function waitForPlayback(ctx: Ctx, render: Render, signal: AbortSignal) {
  while (!signal.aborted && (render.state === "queued" || render.state === "running")) {
    // Other engine processes can publish into the same database without firing our bus.
    await waitFor(ctx.bus, "render.finished", 1000, e => e.renderId === render.id, signal);
    if (!signal.aborted) {
      const latest = ctx.repos.renders.get(render.id);
      if (!latest) throw notFound(`render ${render.id}`);
      render = latest;
    }
  }
  if (signal.aborted) return;
  if (render.state !== "done" || !render.path) throw conflict("playback_unavailable", render.error || "Couldn’t prepare this section.");
  return join(ctx.paths.renders(render.projectId), render.path);
}

/** Both the published call and its player acquire the same immutable, self-contained MP4. */
export function requestCutPlaybackFile(ctx: Ctx, project: Pick<Project, "id" | "settings">, version: string, range: TimeRange, owner: string) {
  return ctx.renders.fullPreview(project, version) ?? ctx.renders.request({ projectId: project.id, version,
    kind: "segment", range, quality: "preview", speculative: true }, owner);
}
