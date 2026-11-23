import { mediaDurationBucket, type ExportRoute, type Render, type Task } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { renderFailureReason, taskFailureReason } from "./failureReason.js";

type Recorder = Pick<Ctx, "db" | "telemetry">;

// Each of these waits for the write to commit, so a change that is rolled back reports nothing.

export function recordTaskRequested(ctx: Recorder, task: Task): void {
  ctx.db.afterCommit(() => ctx.telemetry.record("task.requested", {
    kind: task.kind,
    agent: task.agent,
    fast: task.fast === true,
  }));
}

/** For a task that has just reached done, failed or cancelled. */
export function recordTaskFinished(ctx: Recorder, task: Task): void {
  const durationMs = Date.parse(task.finishedAt ?? "") - Date.parse(task.startedAt ?? task.createdAt ?? "");
  ctx.db.afterCommit(() => ctx.telemetry.record("task.finished", {
    kind: task.kind,
    agent: task.agent,
    state: task.state,
    changeCount: task.changeIds.length,
    interrupted: task.interrupted === true,
    ...(Number.isNaN(durationMs) ? {} : { durationMs: Math.max(0, durationMs) }),
    ...(task.state === "failed" ? { failureReason: taskFailureReason(task) } : {}),
  }));
}

/** Exports only. The other renders are playback and preview work the app starts on its own. */
export function recordRenderFinished(ctx: Recorder, render: Render): void {
  if (render.kind !== "export") return;
  // Asked now, before this export's own entry in the project's log is written.
  const exportedBefore = render.state === "done" && ctx.telemetry.active && libraryHasExported(ctx, render.id);
  ctx.db.afterCommit(() => {
    ctx.telemetry.record("render.finished", {
      kind: render.kind,
      state: render.state,
      ...(render.quality ? { quality: render.quality } : {}),
      ...(render.state === "failed" ? { failureReason: renderFailureReason(render) } : {}),
    });
    if (render.state === "done") ctx.telemetry.recordExport("render", exportedBefore);
  });
}

/** A timeline, captions or a handoff folder written out for the editor. Call before the export's log entry. */
export function recordExportFinished(ctx: Recorder, route: Exclude<ExportRoute, "render">): void {
  const exportedBefore = ctx.telemetry.active && libraryHasExported(ctx);
  ctx.db.afterCommit(() => ctx.telemetry.recordExport(route, exportedBefore));
}

/**
 * The library finished an export before this install kept its marker, so the next one isn't its first: an export made
 * by an earlier release, or while reports were off. `renderId` is the export being reported.
 */
function libraryHasExported(ctx: Pick<Ctx, "db">, renderId = ""): boolean {
  try {
    return !!ctx.db.prepare(`SELECT 1 FROM activity WHERE type = 'export.completed'
      UNION ALL SELECT 1 FROM renders WHERE kind = 'export' AND state = 'done' AND id != ? LIMIT 1`).get(renderId);
  } catch {
    return false;
  }
}

/**
 * A file added to a project, as soon as its length is known: its kind, a bucket for how long it runs, and whether the
 * editor or Scarlet added it. Never its name, its path or its exact length.
 */
export function recordMediaAdded(ctx: Recorder, asset: Pick<MediaAsset, "kind" | "duration" | "provenance">): void {
  const duration = asset.duration ?? 0;
  const timed = (asset.kind === "video" || asset.kind === "audio") && Number.isFinite(duration) && duration > 0;
  ctx.db.afterCommit(() => ctx.telemetry.record("media.added", {
    kind: asset.kind,
    ...(timed ? { durationBucket: mediaDurationBucket(duration) } : {}),
    addedBy: !asset.provenance || asset.provenance.by === "human" ? "editor" : "scarlet",
  }));
}
