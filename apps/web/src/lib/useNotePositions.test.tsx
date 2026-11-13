// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Note, Timeline } from "@scarlet/timeline";
import { api } from "./client";
import { buildDb, PRJ } from "./mock/fixtures";
import { useNotePositions } from "./useNotePositions";

const db = buildDb();
// The current edit takes six filler words out of the version before it, the first from 0.8 to 1.1 s.
const before = db.timelines.ver_3!, current = db.timelines.ver_6!;
const note = (id: string, version: string, time: number): Note => ({ id, projectId: PRJ, version, time, clipIds: [], text: id, author: { type: "human", id: "u", name: "Matt" }, state: "open" });
let positions: ReturnType<typeof useNotePositions>;
let root: Root;

function Notes({ timeline, notes }: { timeline: Timeline | null; notes?: Note[] }) {
  positions = useNotePositions(timeline, notes, 30);
  return null;
}
const show = (timeline: Timeline | null, notes?: Note[]) => act(async () => root.render(<Notes timeline={timeline} notes={notes} />));
const placed = () => Object.fromEntries(positions.times);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a note made on the current edit where it is, without reading anything", async () => {
  const read = vi.spyOn(api, "timeline");
  await show(current, [note("now", "ver_6", 4)]);
  expect(placed()).toEqual({ now: 4 });
  expect(positions.failed).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  // With no timeline or no notes there is nothing to place.
  await show(null, [note("now", "ver_6", 4)]);
  expect(placed()).toEqual({});
  await show(current, undefined);
  expect(placed()).toEqual({});
});

it("moves a note from an earlier version to where its footage is now, and leaves out one whose footage was cut", async () => {
  const read = vi.spyOn(api, "timeline").mockImplementation(async (_project, version) => ({ timeline: db.timelines[version!]! }));
  const notes = [note("early", "ver_3", 0.5), note("cut", "ver_3", 0.9), note("later", "ver_3", 2), note("now", "ver_6", 4)];
  await show(current, notes);
  await act(async () => {});
  expect(read).toHaveBeenCalledExactlyOnceWith(PRJ, "ver_3");
  // Before the first cut it stays put; after it, it moves up by the 0.3 s that came out; inside it, it has no place.
  expect(placed().early).toBe(0.5);
  expect(placed().later).toBeCloseTo(1.7, 5);
  expect(placed().cut).toBeNull();
  expect(placed().now).toBe(4);
  expect(positions.failed).toBe(false);
});

it("reads each earlier version once, three at a time, and places nothing from a version until it has arrived", async () => {
  const versions = ["ver_1", "ver_2", "ver_3", "ver_4", "ver_5"];
  const asked: string[] = [];
  const answers = new Map<string, (response: { timeline: Timeline }) => void>();
  vi.spyOn(api, "timeline").mockImplementation((_project, version) => new Promise(resolve => { asked.push(version!); answers.set(version!, resolve); }));
  await show(current, [...versions, "ver_3", "ver_1"].map((version, i) => note(`n${i}`, version, 0.5)));
  expect(asked).toEqual(["ver_1", "ver_2", "ver_3"]);
  expect(placed()).toEqual({});
  await act(async () => { answers.get("ver_2")!({ timeline: db.timelines.ver_2! }); });
  expect(asked).toEqual(["ver_1", "ver_2", "ver_3", "ver_4"]);
  await act(async () => { for (const version of ["ver_1", "ver_3", "ver_4"]) answers.get(version)!({ timeline: db.timelines[version]! }); });
  expect(placed()).toEqual({});
  await act(async () => { answers.get("ver_5")!({ timeline: db.timelines.ver_5! }); });
  expect(asked).toEqual(versions);
  expect(Object.keys(placed())).toHaveLength(7);
  expect(positions.failed).toBe(false);
});

it("says some notes couldn't be placed when a version can't be read, and reads again when asked to retry", async () => {
  const read = vi.spyOn(api, "timeline").mockImplementation(async (_project, version) => {
    if (version === "ver_2") throw new Error("engine away");
    return { timeline: db.timelines[version!]! };
  });
  await show(current, [note("a", "ver_3", 0.5), note("b", "ver_2", 0.5)]);
  await act(async () => {});
  expect(positions.failed).toBe(true);
  expect(Object.keys(placed())).toEqual(["a"]);
  read.mockImplementation(async (_project, version) => ({ timeline: db.timelines[version!]! }));
  await act(async () => positions.retry());
  await act(async () => {});
  expect(positions.failed).toBe(false);
  expect(Object.keys(placed())).toEqual(["a", "b"]);
  expect(read).toHaveBeenCalledTimes(4);
});

it("drops an answer that arrives after the page moved to other notes", async () => {
  const answers = new Map<string, (response: { timeline: Timeline }) => void>();
  vi.spyOn(api, "timeline").mockImplementation((_project, version) => new Promise(resolve => { answers.set(version!, resolve); }));
  await show(current, [note("a", "ver_3", 0.5)]);
  await show(current, [note("b", "ver_2", 0.5)]);
  await act(async () => { answers.get("ver_3")!({ timeline: before }); });
  expect(placed()).toEqual({});
  await act(async () => { answers.get("ver_2")!({ timeline: db.timelines.ver_2! }); });
  expect(Object.keys(placed())).toEqual(["b"]);
});
