import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { withHandles, type Change, type TimelineDiff } from "@scarlet/timeline";
import type { Ctx } from "../../context.js";
import { run } from "../../render/ffmpeg.js";

export async function withSpotCapability(ctx: Ctx, change: Change, projectFps?: number): Promise<Change> {
  if (!change.ops?.length || change.ranges.length < 2) return change;
  const fps = projectFps ?? ctx.repos.projects.header(change.projectId)?.settings.fps;
  if (!fps || change.spotAssignment?.fps === fps) return change;
  const key = JSON.stringify([change.projectId, change.id, change.fromVersion, change.toVersion, fps]);
  const signal = ctx.projectSignal(change.projectId);
  const owners = await ctx.track(ctx.spotChecks.get(key, async () => {
    const entry = isSea() ? "review-spots" : fileURLToPath(new URL("../spotWorker.mjs", import.meta.url));
    const result = await run(process.execPath, [entry, ctx.paths.db, change.id, String(fps)], { signal });
    return JSON.parse(result.toString()) as Array<number | null> | null;
  }), change.projectId);
  signal.throwIfAborted();
  return ctx.db.transaction(() => {
    const current = ctx.repos.changes.get(change.id);
    if (!current || current.fromVersion !== change.fromVersion || current.toVersion !== change.toVersion ||
        current.spotAssignment?.fps === fps || ctx.repos.projects.header(change.projectId)?.settings.fps !== fps) return current ?? change;
    const saved = ctx.repos.changes.put({ ...current, canApproveSpots: owners !== null, spotAssignment: { fps, owners } });
    ctx.bus.publish({ type: "change.updated", projectId: saved.projectId, change: saved });
    return saved;
  }, "immediate")();
}

/** Publish the verified capability when ready, without delaying a history snapshot. */
export function scheduleSpotCheck(ctx: Ctx, change: Change, fps: number): void {
  if (change.state !== "ready" || !change.ops?.length || change.ranges.length < 2 || change.spotAssignment?.fps === fps) return;
  ctx.db.afterCommit(() => {
    ctx.track(withSpotCapability(ctx, change, fps), change.projectId).catch(error => {
      if (!ctx.shutdown.aborted) ctx.log(`[review] Could not check spots for ${change.id}: ${error}`);
    });
  });
}

/** The stretch to play on each side of a spot, padded by the editor's handles and kept inside each version. */
export function spotWindows(diff: TimelineDiff, spot: TimelineDiff["spots"][number], handle: number) {
  return { range: withHandles(spot.after, handle, diff.durationAfter), beforeRange: withHandles(spot.before, handle, diff.durationBefore) };
}
