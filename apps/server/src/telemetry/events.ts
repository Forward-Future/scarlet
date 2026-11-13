import type { Render, Task } from "@scarlet/shared";
import type { Ctx } from "../context.js";

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
  }));
}

/** Exports only. The other renders are playback and preview work the app starts on its own. */
export function recordRenderFinished(ctx: Recorder, render: Render): void {
  if (render.kind !== "export") return;
  ctx.db.afterCommit(() => ctx.telemetry.record("render.finished", {
    kind: render.kind,
    state: render.state,
    ...(render.quality ? { quality: render.quality } : {}),
  }));
}
