// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop, type UpdateStatus } from "./desktop";
import { buildPercent, enableUpdateStatus, refreshUpdateStatus, useUpdateStatus } from "./updateStatus";

const NONE: UpdateStatus = { ready: null, building: null };
/** Each read of the updater, answered by hand. */
let reads: { answer(status: UpdateStatus): void; fail(error: Error): void }[];
let shown: UpdateStatus[];
let root: Root | undefined;

function Shows() {
  const status = useUpdateStatus();
  shown.push(status);
  return null;
}
const mount = async () => { root = createRoot(document.createElement("div")); await act(async () => root!.render(<Shows />)); };
const unmount = async () => { await act(async () => root?.unmount()); root = undefined; };
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  reads = [];
  shown = [];
  vi.spyOn(desktop, "updateStatus").mockImplementation(() => new Promise((answer, fail) => { reads.push({ answer, fail }); }));
  enableUpdateStatus();
});
afterEach(async () => {
  await unmount();
  // Let a read still in flight finish with nobody listening, so the next test starts from nothing.
  for (const read of reads) read.answer(NONE);
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("asks the updater every five seconds while something shows it, and draws only when the answer changes", async () => {
  await mount();
  expect(reads).toHaveLength(1);
  const building = { ready: null, building: { revision: "abc", done: 0.2, step: 0.5, stepStarted: 100, stepSeconds: 60 } };
  reads[0]!.answer(building);
  await settle();
  expect(shown.at(-1)).toEqual(building);
  const draws = shown.length;
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(reads).toHaveLength(2);
  reads[1]!.answer(structuredClone(building));
  await settle();
  expect(shown).toHaveLength(draws);
  // Nothing is asked once nothing shows it.
  await unmount();
  vi.advanceTimersByTime(20_000);
  expect(reads).toHaveLength(2);
});

it("reads a failed answer as no update, and keeps asking", async () => {
  await mount();
  reads[0]!.answer({ ready: "abc", building: null });
  await settle();
  expect(shown.at(-1)).toEqual({ ready: "abc", building: null });
  await act(async () => { vi.advanceTimersByTime(5000); });
  reads[1]!.fail(new Error("updater not running"));
  await settle();
  expect(shown.at(-1)).toEqual(NONE);
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(reads).toHaveLength(3);
});

it("keeps one round of asking when it is shown again, or asked to look now, while an answer is still on its way", async () => {
  await mount();
  await unmount();
  await mount();
  // Two reads are out: the one from before and the one for the new mount. Only the newer one carries on.
  expect(reads).toHaveLength(2);
  reads[0]!.answer(NONE);
  reads[1]!.answer(NONE);
  await settle();
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(reads).toHaveLength(3);
  // A restart was refused while that read is out: ask again now, still as one round.
  refreshUpdateStatus();
  expect(reads).toHaveLength(4);
  reads[2]!.answer({ ready: "old", building: null });
  reads[3]!.answer(NONE);
  await settle();
  // The answer that was overtaken is not shown over the newer one.
  expect(shown.at(-1)).toEqual(NONE);
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(reads).toHaveLength(5);
  await act(async () => { vi.advanceTimersByTime(4999); });
  expect(reads).toHaveLength(5);
});

it("works out how far along a build is from the part under way, and never shows 100 before it is verified", () => {
  const build = { revision: "abc", done: 0.2, step: 0.5, stepStarted: 1000, stepSeconds: 60 };
  expect(buildPercent(build, 1_000_000)).toBe(20);
  expect(buildPercent(build, 1_030_000)).toBe(45);
  // A part that runs longer than last time waits at its end.
  expect(buildPercent(build, 1_600_000)).toBe(70);
  // The clock can be behind the updater's.
  expect(buildPercent(build, 0)).toBe(20);
  expect(buildPercent({ ...build, done: 0.6, stepSeconds: 0 }, 1_000_000)).toBe(99);
  expect(buildPercent({ ...build, done: 1, step: 0 }, 1_000_000)).toBe(99);
});
