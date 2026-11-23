import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project } from "@scarlet/timeline";
import { Trash } from "./trash";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const project = (id: string) => ({ id, name: `Project ${id}` }) as Project;

it("lists deleted projects newest first, each kept 30 days", () => {
  const trash = new Trash();
  trash.add(project("a"));
  vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
  trash.add(project("b"));
  expect(trash.rows()).toEqual([
    { id: "b", name: "Project b", deletedAt: "2026-01-02T00:00:00.000Z", purgeAt: "2026-02-01T00:00:00.000Z" },
    { id: "a", name: "Project a", deletedAt: "2026-01-01T00:00:00.000Z", purgeAt: "2026-01-31T00:00:00.000Z" },
  ]);
  expect([trash.has("a"), trash.has("c")]).toEqual([true, false]);
});

it("takes a project back out, and purges others for good", () => {
  const trash = new Trash();
  for (const id of ["a", "b", "c"]) trash.add(project(id));
  expect(trash.take("b")?.project.id).toBe("b");
  expect(trash.take("b")).toBeUndefined();
  trash.purge(new Set(["a"]));
  expect(trash.rows().map(r => r.id)).toEqual(["c"]);
});
