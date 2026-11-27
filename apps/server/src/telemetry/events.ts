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
  const reason = task.state === "failed" ? taskFailureReason(task) : undefined;
  // Normal interruptions (media pause, project trash, app quit/update) are stored as interrupted failed rows so
  // Scarlet can resume them later, not because anything broke. Report them as cancelled with interrupted: true so
  // `state: "failed"` reflects real errors only.
  const state = task.state === "failed" && reason === "interrupted" ? "cancelled" : task.state;
  // Transcriptions wait in the audio lane after creation; measure active work time rather than queue wait.
  const startedAt = task.kind === "transcribe" ? task.startedAt : (task.startedAt ?? task.createdAt);
  const durationMs = startedAt ? Date.parse(task.finishedAt ?? "") - Date.parse(startedAt) : Number.NaN;
  ctx.db.afterCommit(() => ctx.telemetry.record("task.finished", {
    kind: task.kind,
    agent: task.agent,
    state,
    changeCount: task.changeIds.length,
    interrupted: task.interrupted === true || reason === "interrupted",
    ...(Number.isNaN(durationMs) ? {} : { durationMs: Math.max(0, durationMs) }),
    ...(state === "failed" && reason ? { failureReason: reason } : {}),
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

/** The engine's own code for why an upload failed. Anything else (which shouldn't happen) is `other`. */
const YOUTUBE_FAILURE_CODE = /^(?:youtube|render)_[a-z_]{1,48}$/;

/**
 * A YouTube upload that ended. Its title, description, channel and video id stay on the installation; a success is
 * also an export. Call before the upload's own log entry.
 */
export function recordYouTubeUploadFinished(ctx: Recorder, upload: {
  state: "done" | "failed" | "cancelled";
  visibility: string;
  reusedRender: boolean;
  failureCode?: string;
}): void {
  const exportedBefore = upload.state === "done" && ctx.telemetry.active && libraryHasExported(ctx);
  ctx.db.afterCommit(() => {
    ctx.telemetry.record("youtube.upload_finished", {
      state: upload.state,
      visibility: ["public", "unlisted", "private"].includes(upload.visibility) ? upload.visibility : "other",
      reusedRender: upload.reusedRender,
      ...(upload.state === "failed"
        ? { failureCode: upload.failureCode && YOUTUBE_FAILURE_CODE.test(upload.failureCode) ? upload.failureCode : "other" }
        : {}),
    });
    if (upload.state === "done") ctx.telemetry.recordExport("youtube", exportedBefore);
  });
}

/**
 * The library finished an export before this install kept its marker, so the next one isn't its first: an export made
 * by an earlier release, or while reports were off. `renderId` is the export being reported.
 */
function libraryHasExported(ctx: Pick<Ctx, "db">, renderId = ""): boolean {
  try {
    return !!ctx.db.prepare(`SELECT 1 FROM activity WHERE type IN ('export.completed', 'youtube.published')
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
