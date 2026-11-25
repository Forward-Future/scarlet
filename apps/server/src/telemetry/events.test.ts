import type { Render, Task } from "@scarlet/shared";
import { describe, expect, it, vi } from "vitest";
import { recordMediaAdded, recordRenderFinished, recordTaskFinished } from "./events.js";

function recorder(options: { exportedBefore?: boolean } = {}) {
  const record = vi.fn();
  const recordExport = vi.fn();
  const ctx = {
    db: { afterCommit: (effect: () => void) => effect(), prepare: () => ({ get: () => options.exportedBefore ? { 1: 1 } : undefined }) },
    telemetry: { active: true, record, recordExport },
  } as unknown as Parameters<typeof recordTaskFinished>[0];
  return { ctx, record, recordExport };
}

const task = (extra: Partial<Task>): Task => ({
  id: "tsk_private", projectId: "prj_private", kind: "edit", agent: "claude", instruction: "Cut the secret scene", context: {},
  state: "failed", createdBy: { type: "human", name: "Ed" }, hostId: null, changeIds: [], question: null, summary: null,
  createdAt: "2026-11-23T10:00:00.000Z", startedAt: "2026-11-23T10:00:00.000Z", finishedAt: "2026-11-23T10:00:01.500Z", ...extra,
}) as Task;

describe("task.finished", () => {
  it("says why a request failed, as a category and never in its words", () => {
    const { ctx, record } = recorder();
    recordTaskFinished(ctx, task({ error: "claude CLI not found on PATH at /Users/ed/bin" }));
    expect(record).toHaveBeenCalledWith("task.finished", {
      kind: "edit", agent: "claude", state: "failed", changeCount: 0, interrupted: false, durationMs: 1500,
      failureReason: "agent_not_installed",
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("/Users/ed");
  });

  it("has no reason for a request that didn't fail", () => {
    const { ctx, record } = recorder();
    recordTaskFinished(ctx, task({ state: "done" }));
    recordTaskFinished(ctx, task({ state: "cancelled", error: "cancelled" }));
    for (const [, properties] of record.mock.calls) expect(properties).not.toHaveProperty("failureReason");
  });

  it("reports clean interruptions as cancelled with interrupted: true instead of failed", () => {
    const { ctx, record } = recorder();
    recordTaskFinished(ctx, task({
      kind: "transcribe", agent: "api", state: "failed", interrupted: true,
      error: "Transcription was interrupted.",
      createdAt: "2026-11-23T10:00:00.000Z", startedAt: "2026-11-23T10:05:00.000Z", finishedAt: "2026-11-23T10:05:12.000Z",
    }));
    expect(record).toHaveBeenCalledWith("task.finished", {
      kind: "transcribe", agent: "api", state: "cancelled", changeCount: 0, interrupted: true, durationMs: 12_000,
    });

    // A lost worker or timeout is still a real failure even when marked interrupted.
    record.mockClear();
    recordTaskFinished(ctx, task({ state: "failed", interrupted: true, lostWorker: true, error: "The agent was interrupted." }));
    recordTaskFinished(ctx, task({ state: "failed", interrupted: true, error: "stalled: the agent wrote nothing for 10 minutes" }));
    expect(record.mock.calls[0]![1]).toMatchObject({ state: "failed", interrupted: true, failureReason: "crashed" });
    expect(record.mock.calls[1]![1]).toMatchObject({ state: "failed", interrupted: true, failureReason: "timeout" });
  });

  it("measures transcription duration from active work start and omits duration if ended while queued", () => {
    const { ctx, record } = recorder();
    // Waited 1 hour in the audio queue, ran for 25 s.
    recordTaskFinished(ctx, task({
      kind: "transcribe", agent: "api", state: "done",
      createdAt: "2026-11-23T10:00:00.000Z", startedAt: "2026-11-23T11:00:00.000Z", finishedAt: "2026-11-23T11:00:25.000Z",
    }));
    expect(record.mock.calls[0]![1]).toMatchObject({ state: "done", durationMs: 25_000 });

    // Interrupted while still queued (startedAt unset): queue wait is not reported as work duration.
    recordTaskFinished(ctx, task({
      kind: "transcribe", agent: "api", state: "failed", interrupted: true, error: "Transcription was interrupted.",
      createdAt: "2026-11-23T10:00:00.000Z", startedAt: undefined, finishedAt: "2026-11-23T11:00:00.000Z",
    }));
    expect(record.mock.calls[1]![1]).toEqual({
      kind: "transcribe", agent: "api", state: "cancelled", changeCount: 0, interrupted: true,
    });
  });
});

describe("render.finished and export.finished", () => {
  const render = (extra: Partial<Render>): Render => ({
    id: "rnd_private", projectId: "prj_private", version: "v1", kind: "export", key: "k", path: null, state: "done", progress: 1,
    range: null, quality: "delivery", ...extra,
  }) as Render;

  it("reports a finished export as the unified export and keeps render.finished as it was", () => {
    const { ctx, record, recordExport } = recorder();
    recordRenderFinished(ctx, render({}));
    expect(record).toHaveBeenCalledWith("render.finished", { kind: "export", state: "done", quality: "delivery" });
    expect(recordExport).toHaveBeenCalledWith("render", false);
  });

  it("passes on that the library exported before", () => {
    const { ctx, recordExport } = recorder({ exportedBefore: true });
    recordRenderFinished(ctx, render({}));
    expect(recordExport).toHaveBeenCalledWith("render", true);
  });

  it("says why an export failed, and counts no export", () => {
    const { ctx, record, recordExport } = recorder();
    recordRenderFinished(ctx, render({ state: "failed", error: "There isn’t enough free disk space to render this: free some space, then try again." }));
    expect(record).toHaveBeenCalledWith("render.finished", { kind: "export", state: "failed", quality: "delivery", failureReason: "out_of_disk" });
    recordRenderFinished(ctx, render({ state: "cancelled" }));
    expect(recordExport).not.toHaveBeenCalled();
  });

  it("leaves out playback and preview renders", () => {
    const { ctx, record, recordExport } = recorder();
    recordRenderFinished(ctx, render({ kind: "full" }));
    expect(record).not.toHaveBeenCalled();
    expect(recordExport).not.toHaveBeenCalled();
  });
});

describe("media.added", () => {
  it.each([
    [30, "lt_1m"], [59.9, "lt_1m"], [60, "1_10m"], [599, "1_10m"], [600, "10_30m"], [1799, "10_30m"], [1800, "30_60m"],
    [3599, "30_60m"], [3600, "gt_60m"], [4 * 3600, "gt_60m"],
  ] as const)("puts %d s in %s", (duration, durationBucket) => {
    const { ctx, record } = recorder();
    recordMediaAdded(ctx, { kind: "video", duration, provenance: { by: "human", name: "Ed" } });
    expect(record).toHaveBeenCalledWith("media.added", { kind: "video", durationBucket, addedBy: "editor" });
  });

  it("has no length for a picture, and says when Scarlet added the file", () => {
    const { ctx, record } = recorder();
    recordMediaAdded(ctx, { kind: "image", duration: 0, provenance: { by: "agent", name: "Claude", prompt: "a secret" } });
    recordMediaAdded(ctx, { kind: "audio", duration: 125, provenance: { by: "scarlet" } });
    recordMediaAdded(ctx, { kind: "video", duration: undefined });
    expect(record.mock.calls).toEqual([
      ["media.added", { kind: "image", addedBy: "scarlet" }],
      ["media.added", { kind: "audio", durationBucket: "1_10m", addedBy: "scarlet" }],
      ["media.added", { kind: "video", addedBy: "editor" }],
    ]);
  });
});
