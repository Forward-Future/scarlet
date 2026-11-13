// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addPendingImports, clearSetsFormat, isLink, markImportStarted, pendingImports, removePendingImport } from "./pendingImports";

const KEY = "scarlet.imports.v1";
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps the files still to import for each project, each once, until they are done", () => {
  addPendingImports("prj_1", ["/cards/A001.mov", "/cards/A002.mov"]);
  addPendingImports("prj_2", ["/cards/A001.mov"]);
  // Asked for again: it is already waiting.
  vi.setSystemTime(new Date("2026-11-01T11:00:00Z"));
  addPendingImports("prj_1", ["/cards/A002.mov", "https://example.com/b-roll.mp4"]);
  expect(pendingImports("prj_1")).toEqual([
    { projectId: "prj_1", source: "/cards/A001.mov", at: "2026-11-01T10:00:00.000Z", started: false },
    { projectId: "prj_1", source: "/cards/A002.mov", at: "2026-11-01T10:00:00.000Z", started: false },
    { projectId: "prj_1", source: "https://example.com/b-roll.mp4", at: "2026-11-01T11:00:00.000Z", started: false },
  ]);
  removePendingImport("prj_1", "/cards/A001.mov");
  expect(pendingImports("prj_1").map(i => i.source)).toEqual(["/cards/A002.mov", "https://example.com/b-roll.mp4"]);
  // The same file in another project is its own import.
  expect(pendingImports("prj_2")).toHaveLength(1);
  removePendingImport("prj_1", "/cards/A002.mov");
  removePendingImport("prj_1", "https://example.com/b-roll.mp4");
  removePendingImport("prj_2", "/cards/A001.mov");
  // Nothing waiting leaves nothing saved.
  expect(localStorage.getItem(KEY)).toBeNull();
});

it("marks a file whose copy has begun, and a new project's first files until its format is settled", () => {
  addPendingImports("prj_1", ["/cards/A001.mov", "/cards/A002.mov"], true);
  addPendingImports("prj_2", ["/cards/B001.mov"], true);
  const importId = markImportStarted("prj_1", "/cards/A001.mov");
  expect(pendingImports("prj_1")).toEqual([
    { projectId: "prj_1", source: "/cards/A001.mov", at: "2026-11-01T10:00:00.000Z", started: true, setsFormat: true, importId },
    { projectId: "prj_1", source: "/cards/A002.mov", at: "2026-11-01T10:00:00.000Z", started: false, setsFormat: true },
  ]);
  const saved = localStorage.getItem(KEY);
  // Already started, or not waiting at all: nothing is written again.
  markImportStarted("prj_1", "/cards/A001.mov");
  markImportStarted("prj_1", "/cards/unknown.mov");
  expect(localStorage.getItem(KEY)).toBe(saved);
  clearSetsFormat("prj_1");
  expect(pendingImports("prj_1").map(i => [i.started, i.setsFormat])).toEqual([[true, undefined], [false, undefined]]);
  // Another project's first files still set its format.
  expect(pendingImports("prj_2")[0]!.setsFormat).toBe(true);
  const settled = localStorage.getItem(KEY);
  clearSetsFormat("prj_1");
  expect(localStorage.getItem(KEY)).toBe(settled);
});

it("reads what an older Scarlet saved, and drops entries it can't use", () => {
  localStorage.setItem(KEY, JSON.stringify([
    { projectId: "prj_1", source: "/cards/old.mov", at: "2026-10-01T10:00:00.000Z" },
    { projectId: "prj_1", source: "/cards/odd.mov", at: "2026-10-01T10:00:00.000Z", setsFormat: "yes", started: "no", extra: 1 },
    { projectId: "prj_1", source: 42, at: "2026-10-01T10:00:00.000Z" },
    { projectId: "prj_1", source: "/cards/undated.mov" },
    null,
    "a string",
  ]));
  expect(pendingImports("prj_1")).toEqual([
    // Without `started` it isn't known whether the copy had begun.
    { projectId: "prj_1", source: "/cards/old.mov", at: "2026-10-01T10:00:00.000Z" },
    { projectId: "prj_1", source: "/cards/odd.mov", at: "2026-10-01T10:00:00.000Z" },
  ]);
  // Clearing the format keeps "not known" as it is.
  localStorage.setItem(KEY, JSON.stringify([{ projectId: "prj_1", source: "/cards/old.mov", at: "2026-10-01T10:00:00.000Z", setsFormat: true }]));
  clearSetsFormat("prj_1");
  expect(pendingImports("prj_1")).toEqual([{ projectId: "prj_1", source: "/cards/old.mov", at: "2026-10-01T10:00:00.000Z" }]);
  for (const broken of ["not json", JSON.stringify({ projectId: "prj_1" })]) {
    localStorage.setItem(KEY, broken);
    expect(pendingImports("prj_1")).toEqual([]);
  }
});

it("carries on for the session when nothing can be saved", () => {
  const save = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  expect(() => addPendingImports("prj_1", ["/cards/A001.mov"])).not.toThrow();
  expect(save).toHaveBeenCalledOnce();
  expect(pendingImports("prj_1")).toEqual([]);
});

it("tells a link from a path on this computer", () => {
  expect(isLink("https://example.com/clip.mp4")).toBe(true);
  expect(isLink("HTTP://example.com/clip.mp4")).toBe(true);
  expect(isLink("/Volumes/Cards/https://clip.mp4")).toBe(false);
  expect(isLink("C:\\\\footage\\\\clip.mp4")).toBe(false);
  expect(isLink("ftp://example.com/clip.mp4")).toBe(false);
});
