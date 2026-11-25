import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "@scarlet/shared";
import { openDb } from "../db.js";
import { UsageRepo } from "./usage.js";

const zone = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const task = (id: string) => ({ id, projectId: "prj_1", agent: "claude", model: "opus", context: {} }) as Task;
const tokens = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });

// The engine runs on the editor's own machine: "Today" in Settings → Usage is their day, not the day in UTC.
it("groups runs by the day on the editor's own clock, not the UTC day", () => {
  process.env.TZ = "America/Los_Angeles";
  const usage = new UsageRepo(openDb(":memory:"));
  vi.useFakeTimers();
  // 4:30 pm on November 23 in Los Angeles, which is already November 24 in UTC.
  vi.setSystemTime(new Date("2026-11-24T00:30:00.000Z"));
  usage.record(task("tsk_evening"), tokens(100), "2026-11-24T00:29:00.000Z");
  // 9 am that same day there.
  vi.setSystemTime(new Date("2026-11-23T17:00:00.000Z"));
  usage.record(task("tsk_morning"), tokens(10), "2026-11-23T16:59:00.000Z");
  // And 10 am the next morning.
  vi.setSystemTime(new Date("2026-11-24T18:00:00.000Z"));
  usage.record(task("tsk_next"), tokens(1), "2026-11-24T17:59:00.000Z");
  const days = usage.summary("day").groups;
  expect(days.map(g => [g.key, g.runs, g.totalTokens])).toEqual([["2026-11-24", 1, 1], ["2026-11-23", 2, 110]]);
});
