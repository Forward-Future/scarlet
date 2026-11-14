import { expect, it, vi } from "vitest";
import type { Ctx } from "../context.js";
import type { Task } from "@scarlet/shared";
import { transcriptionProgress } from "./ingest.js";
import { quietProgress } from "./progressSave.js";

it("logs a progress figure that couldn't be saved and carries on, since the job itself is fine", () => {
  const log = vi.fn();
  expect(() => quietProgress({ log }, "render progress", () => { throw new Error("database is locked"); })).not.toThrow();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("render progress"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("database is locked"));
  const saved = vi.fn();
  quietProgress({ log }, "render progress", saved);
  expect(saved).toHaveBeenCalledTimes(1);
});

it("doesn't throw into the transcriber's output when a transcription's progress can't be saved", () => {
  // These are called from a child process's output listener: a throw there is uncaught, and stops the engine.
  const log = vi.fn();
  const ctx = { log, db: { transaction: () => () => { throw new Error("database is locked"); } } } as unknown as Ctx;
  const progress = transcriptionProgress(ctx, { id: "task" } as Task, "whispercpp");
  expect(() => { progress.queued(); progress.transcribing(.5); progress.aligning(.5); }).not.toThrow();
  expect(log).toHaveBeenCalledTimes(3);
});
