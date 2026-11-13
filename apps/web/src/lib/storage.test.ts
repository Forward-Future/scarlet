// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StorageProject } from "@scarlet/shared";

/** The engine connection, which the app replaces when the engine restarts. */
const engine = vi.hoisted(() => ({ api: { storage: (): Promise<{ projects: unknown[] }> => Promise.resolve({ projects: [] }) } }));
vi.mock("./client", () => ({ IS_DESKTOP: true, get api() { return engine.api; } }));

import { desktop, type StorageSize } from "./desktop";
import { freedSpace, invalidateStorageScan, lastStorageScan, scanStorage, scheduleStorageScan } from "./storage";

const project = (id: string, extra: Partial<StorageProject> = {}) => ({ id, name: `Film ${id}`, deletedAt: null, busy: false, missingSource: false, segments: [], ...extra }) as unknown as StorageProject;
const size = (bytes: number, estimated = false): StorageSize => ({ bytes, files: 3, estimated });
const measuring = () => vi.spyOn(desktop, "measureProjectStorage").mockResolvedValue({ a: size(1024), b: size(2048, true) });
let measure: ReturnType<typeof measuring>;

beforeEach(() => {
  engine.api = { storage: vi.fn(async () => ({ projects: [project("a"), project("b")] })) };
  measure = measuring();
  invalidateStorageScan();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("says what a delete gives back, as about so much when any of it was estimated, and nothing when nothing was measured", () => {
  expect(freedSpace([])).toBe("");
  expect(freedSpace([size(0)])).toBe("");
  expect(freedSpace([size(1024), size(1024)])).toBe("2 KB");
  expect(freedSpace([size(1024 ** 2), size(1024 ** 2, true)])).toBe("about 2.0 MB");
});

it("measures every project the engine lists and remembers the result", async () => {
  vi.spyOn(Date, "now").mockReturnValue(5000);
  expect(lastStorageScan()).toBeUndefined();
  const scan = await scanStorage();
  expect(measure).toHaveBeenCalledExactlyOnceWith([project("a"), project("b")]);
  expect(scan).toEqual({ at: 5000, projects: [
    { id: "a", name: "Film a", deletedAt: null, busy: false, missingSource: false, ...size(1024) },
    { id: "b", name: "Film b", deletedAt: null, busy: false, missingSource: false, ...size(2048, true) },
  ] });
  // The engine's list of segments is for measuring, not for showing.
  expect(scan.projects[0]).not.toHaveProperty("segments");
  expect(lastStorageScan()).toBe(scan);
  invalidateStorageScan();
  expect(lastStorageScan()).toBeUndefined();
});

it("uses a list it is handed instead of asking the engine, and shares one measurement between callers", async () => {
  let finish!: (sizes: Record<string, StorageSize>) => void;
  measure.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = scanStorage([project("a")]);
  expect(scanStorage()).toBe(first);
  expect(engine.api.storage).not.toHaveBeenCalled();
  finish({ a: size(10) });
  await expect(first).resolves.toMatchObject({ projects: [{ id: "a", bytes: 10 }] });
  // Once it is done, the next call measures again.
  measure.mockResolvedValue({ a: size(20), b: size(30) });
  await expect(scanStorage()).resolves.toMatchObject({ projects: [{ bytes: 20 }, { bytes: 30 }] });
  expect(measure).toHaveBeenCalledTimes(2);
});

it("fails when a project changed under the measurement, keeping the last good result", async () => {
  const good = await scanStorage();
  measure.mockResolvedValue({ a: size(1024) });
  await expect(scanStorage()).rejects.toThrow("Project storage changed. Rescan to refresh.");
  expect(lastStorageScan()).toBe(good);
  // The failure doesn't block the next try.
  measure.mockResolvedValue({ a: size(1), b: size(2) });
  await expect(scanStorage()).resolves.toMatchObject({ projects: [{ bytes: 1 }, { bytes: 2 }] });
});

it("forgets what it measured when the engine was replaced, and doesn't keep a measurement the old one started", async () => {
  await scanStorage();
  let finish!: (sizes: Record<string, StorageSize>) => void;
  measure.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const old = scanStorage();
  await vi.waitFor(() => expect(measure).toHaveBeenCalledTimes(2));
  engine.api = { storage: vi.fn(async () => ({ projects: [project("c")] })) };
  expect(lastStorageScan()).toBeUndefined();
  finish({ a: size(1), b: size(2) });
  await old;
  expect(lastStorageScan()).toBeUndefined();
  measure.mockResolvedValue({ c: size(7) });
  const fresh = await scanStorage();
  expect(fresh.projects.map(p => p.id)).toEqual(["c"]);
  expect(lastStorageScan()).toBe(fresh);
});

it("warms the measurement when the window has been open a while, unless a project is busy or the window is hidden", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const stop = scheduleStorageScan()!;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(engine.api.storage).not.toHaveBeenCalled();
  // Six hours on, with the window showing and a project still importing: it looks, and leaves the disks alone.
  hidden.mockReturnValue(false);
  engine.api.storage = vi.fn(async () => ({ projects: [project("a"), project("b", { busy: true })] }));
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(engine.api.storage).toHaveBeenCalledTimes(1);
  expect(measure).not.toHaveBeenCalled();
  engine.api.storage = vi.fn(async () => ({ projects: [project("a"), project("b")] }));
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(measure).toHaveBeenCalledExactlyOnceWith([project("a"), project("b")]);
  expect(lastStorageScan()?.projects).toHaveLength(2);
  // Stopped, it never looks again.
  stop();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(engine.api.storage).toHaveBeenCalledTimes(1);
});

it("waits for the window to be idle when it can, and for a measurement under way to finish", async () => {
  vi.useFakeTimers();
  let idle: (() => void) | undefined;
  const cancelled: number[] = [];
  vi.stubGlobal("requestIdleCallback", (run: () => void) => { idle = run; return 42; });
  vi.stubGlobal("cancelIdleCallback", (id: number) => cancelled.push(id));
  const stop = scheduleStorageScan()!;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(engine.api.storage).not.toHaveBeenCalled();
  // The editor opened Storage meanwhile: its measurement is the one that counts.
  let finish!: (sizes: Record<string, StorageSize>) => void;
  measure.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const asked = scanStorage([project("a")]);
  idle!();
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.api.storage).not.toHaveBeenCalled();
  finish({ a: size(5) });
  await asked;
  idle!();
  await vi.advanceTimersByTimeAsync(0);
  expect(engine.api.storage).toHaveBeenCalledTimes(1);
  stop();
  expect(cancelled).toEqual([42]);
});

it("keeps quiet when the engine can't be asked", async () => {
  vi.useFakeTimers();
  engine.api.storage = vi.fn(async () => { throw new Error("engine away"); });
  const stop = scheduleStorageScan()!;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(engine.api.storage).toHaveBeenCalledTimes(1);
  expect(measure).not.toHaveBeenCalled();
  stop();
});
