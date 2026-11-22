import { join } from "node:path";
import type { Ctx } from "../context.js";
import { errorMessage } from "../util.js";

/**
 * Read the colour of videos imported before Scarlet read it (`MediaAsset.color`), one file at a time. An HDR
 * file's previews and cached sections are then made again tone-mapped, and the model is told what the file declares.
 * A file read once records `{}` for ordinary SDR, so this reads each file only once. Projects in the Trash or with
 * media processing paused wait until they come back.
 */
export async function readMissingColors(ctx: Ctx, projectId?: string) {
  const missing = ctx.db.prepare(`SELECT m.id FROM media m JOIN projects p ON p.id = m.project_id
    WHERE (m.status = 'ready' OR m.status IS NULL) AND p.deleted_at IS NULL AND NOT p.media_paused AND (? IS NULL OR p.id = ?)
      AND json_extract(m.json, '$.kind') = 'video' AND json_extract(m.json, '$.color') IS NULL ORDER BY m.created_at`)
    .all(projectId ?? null, projectId ?? null) as Array<{ id: string }>;
  for (const { id } of missing) {
    if (ctx.shutdown.aborted) return;
    const media = ctx.repos.projects.getMedia(id);
    if (!media || media.color || media.kind !== "video") continue;
    let color;
    try { ({ color } = await ctx.render.probeMedia(join(ctx.paths.media(media.projectId), media.path), ctx.shutdown)); }
    catch (error) {
      if (ctx.shutdown.aborted) return;
      ctx.log(`[media] colour of ${media.id} unread: ${errorMessage(error)}`);
      continue;
    }
    // An adapter that doesn't read colour records nothing.
    if (!color) continue;
    ctx.db.transaction(() => {
      const current = ctx.repos.projects.getMedia(id);
      if (!current || current.color) return;
      const { projectId: owner, status, error, ...asset } = current;
      const saved = ctx.repos.projects.putMedia(owner, { ...asset, color }, status ?? "ready", error);
      ctx.bus.publish({ type: "media.updated", projectId: owner, media: saved });
    })();
    if (color.hdr || color.log) ctx.log(`[media] ${media.id} is ${[color.hdr?.toUpperCase(), color.log].filter(Boolean).join(", ")}`);
  }
}
