import { expect, it, vi } from "vitest";
import type { Ctx } from "../context.js";
import type { Task } from "@scarlet/shared";
import { transcriptionProgress } from "./transcription.js";
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

it("keeps the last third of local Whisper's bar for reading an English recording again, so it doesn't sit at 100%", async () => {
  const tasks = await import("./tasks.js");
  const saved: number[] = [];
  const spy = vi.spyOn(tasks, "saveTask").mockImplementation((_ctx, t) => { saved.push(t.progress!.fraction); return t; });
  const ctx = { log: vi.fn(), db: { transaction: (fn: () => void) => fn }, repos: { tasks: { get: () => ({ id: "task", state: "running" }) } } } as unknown as Ctx;
  const progress = transcriptionProgress(ctx, { id: "task" } as Task, "whispercpp", true);
  progress.transcribing(1); progress.aligning(1); progress.rereading(.5); progress.rereading(1);
  expect(saved.map(f => Math.round(f * 100))).toEqual([33, 67, 83, 100]);
  saved.length = 0;
  const once = transcriptionProgress(ctx, { id: "task" } as Task, "whispercpp", false);
  once.aligning(1);
  expect(saved).toEqual([1]);
  spy.mockRestore();
});
