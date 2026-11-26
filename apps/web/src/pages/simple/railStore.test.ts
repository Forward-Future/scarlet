import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { LINGER_FADE_MS, LINGER_MS } from "./beta/reviewTabsBeta";
import { ARRIVE_MS, RailStore, type RailRow } from "./railStore";

function makeEdit(changeId: string, spot: number, label: string, start: number, end: number, extra: Partial<Omit<ThreadEdit, "at">> = {}): Omit<ThreadEdit, "at"> {
  return { changeId, spot, label, range: { start, end }, previous: [], ...extra };
}

function makeRow(over: Partial<RailRow> & Pick<RailRow, "key" | "threadId" | "threadOrder" | "at" | "label" | "place">): RailRow {
  const edit = over.editRef ?? makeEdit(over.key.split("/")[0] ?? "chg", Number(over.key.split("/")[1] ?? 0), over.rawLabel ?? over.label, over.at, over.at + 3, { kind: over.editKind });
  return {
    displayAt: over.at,
    rawLabel: over.label,
    stretch: edit.range,
    combinable: over.editKind !== "cut",
    needs: over.place === "you",
    asks: false,
    isAskingCurrent: false,
    pending: over.place === "working",
    busy: over.place === "working",
    revised: false,
    decided: over.place === "done",
    rejected: false,
    skipped: false,
    countsAsNeed: over.place === "you",
    hasNeedNest: false,
    on: false,
    version: 0,
    logControl: "open-edit",
    logLabel: "Edit",
    members: [{ threadId: over.threadId, edit, canUnkeep: over.place === "done" }],
    nests: [],
    open: vi.fn(),
    ...over,
  };
}

describe("RailStore", () => {
  it("gives each request one place in each list, and tells its readers when a place arrives or goes", () => {
    const store = new RailStore();
    const heard = vi.fn();
    store.subscribe(heard);
    // The ref of a place is the same function each time, so React sets it once and a redraw of the column moves nothing.
    expect(store.ref("you", "a")).toBe(store.ref("you", "a"));
    expect(store.ref("you", "a")).not.toBe(store.ref("working", "a"));
    const place = {} as HTMLElement;
    store.ref("you", "a")(place);
    expect([store.host("you", "a"), store.host("working", "a"), heard.mock.calls.length]).toEqual([place, null, 1]);
    // Set again with the same element, nothing has changed.
    store.ref("you", "a")(place);
    expect(heard).toHaveBeenCalledTimes(1);
    store.ref("you", "a")(null);
    expect([store.host("you", "a"), heard.mock.calls.length]).toEqual([null, 2]);
  });

  it("adds up what every request has in a list, and says so only when a count changes", () => {
    const store = new RailStore();
    const heard = vi.fn();
    store.subscribe(heard);
    store.report("a", { you: 2, optional: 5, working: 1, done: 0 });
    store.report("b", { you: 1, optional: 0, working: 0, done: 4 });
    expect([store.total("you"), store.total("optional"), store.total("working"), store.total("done"), heard.mock.calls.length]).toEqual([3, 5, 1, 4, 2]);
    // The same counts with a new way to open its first row: the row to open is the latest, and nobody is told.
    const openFirst = vi.fn();
    store.report("a", { you: 2, optional: 5, working: 1, done: 0, openFirst });
    expect(heard).toHaveBeenCalledTimes(2);
    store.info("a")!.openFirst!();
    expect(openFirst).toHaveBeenCalledTimes(1);
    // A request that has left takes its rows out of every count.
    store.report("a");
    expect([store.total("you"), store.total("optional"), heard.mock.calls.length]).toEqual([1, 0, 3]);
    store.report("a");
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("unifies all four sections into single lists sorted by video time rather than stacked by request", () => {
    const store = new RailStore();
    store.report("t1", {
      you: 1, optional: 1, working: 1, done: 1, threadOrder: 0,
      rows: [
        makeRow({ key: "c1/0", threadId: "t1", threadOrder: 0, at: 30, label: "Old need at 0:30", place: "you" }),
        makeRow({ key: "c1/1", threadId: "t1", threadOrder: 0, at: 60, label: "Old low at 1:00", place: "optional" }),
        makeRow({ key: "c1/2", threadId: "t1", threadOrder: 0, at: 90, label: "Old working at 1:30", place: "working" }),
        makeRow({ key: "c1/3", threadId: "t1", threadOrder: 0, at: 120, label: "Old done at 2:00", place: "done" }),
      ],
    });
    store.report("t2", {
      you: 1, optional: 1, working: 1, done: 1, threadOrder: 1,
      rows: [
        makeRow({ key: "c2/0", threadId: "t2", threadOrder: 1, at: 10, label: "New need at 0:10", place: "you" }),
        makeRow({ key: "c2/1", threadId: "t2", threadOrder: 1, at: 20, label: "New low at 0:20", place: "optional" }),
        makeRow({ key: "c2/2", threadId: "t2", threadOrder: 1, at: 40, label: "New working at 0:40", place: "working" }),
        makeRow({ key: "c2/3", threadId: "t2", threadOrder: 1, at: 50, label: "New done at 0:50", place: "done" }),
      ],
    });
    const view = store.view();
    expect(view.sections.you.map(r => r.label)).toEqual(["New need at 0:10", "Old need at 0:30"]);
    expect(view.sections.low.map(r => r.label)).toEqual(["New low at 0:20", "Old low at 1:00"]);
    expect(view.sections.working.map(r => r.label)).toEqual(["New working at 0:40", "Old working at 1:30"]);
    expect(view.sections.done.map(r => r.label)).toEqual(["New done at 0:50", "Old done at 2:00"]);
  });

  it("orders Confident edits newest request first while keeping timeline order within each request", () => {
    const store = new RailStore();
    store.report("t_old", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 0,
      rows: [
        makeRow({ key: "c1/0", threadId: "t_old", threadOrder: 0, at: 5, label: "Old cut at 0:05", place: "optional", editKind: "cut" }),
        makeRow({ key: "c1/1", threadId: "t_old", threadOrder: 0, at: 20, label: "Old cut at 0:20", place: "optional", editKind: "cut" }),
      ],
    });
    store.report("t_new", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 1,
      rows: [
        makeRow({ key: "c2/0", threadId: "t_new", threadOrder: 1, at: 180, label: "New title at 3:00", place: "optional", editKind: "graphic" }),
        makeRow({ key: "c2/1", threadId: "t_new", threadOrder: 1, at: 90, label: "New title at 1:30", place: "optional", editKind: "graphic" }),
      ],
    });
    const view = store.view();
    expect(view.optional).toBe(4);
    expect(view.sections.low.map(r => [r.label, r.batch?.map(b => b.label)])).toEqual([
      ["2 Graphics: New title at 1:30, New title at 3:00", ["New title at 1:30", "New title at 3:00"]],
      ["2 Cuts: Old cut at 0:05, Old cut at 0:20", ["Old cut at 0:05", "Old cut at 0:20"]],
    ]);
  });

  it("combines a multi-request graphic chain (add -> move -> extend/shift) into one Graphic row while keeping distinct clips separate", () => {
    const store = new RailStore();
    store.report("t_add", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 0,
      rows: [
        makeRow({ key: "c_add/0", threadId: "t_add", threadOrder: 0, at: 18.92, label: "Opus 5.5 title", place: "optional", editKind: "graphic", value: "Graphic", stretch: { start: 18.92, end: 22.26 }, clipIds: ["model_intro_opus"], overlayClipIds: ["model_intro_opus"] }),
        makeRow({ key: "c_add/1", threadId: "t_add", threadOrder: 0, at: 646.14, label: "Muse Ember title", place: "optional", editKind: "graphic", value: "Graphic", stretch: { start: 646.14, end: 649.48 }, clipIds: ["model_intro_ember"], overlayClipIds: ["model_intro_ember"] }),
      ],
    });
    store.report("t_move", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 1,
      rows: [
        makeRow({ key: "c_move/0", threadId: "t_move", threadOrder: 1, at: 18.92, label: "Moved the Opus 5.5 title to the bottom left.", rawLabel: "Opus 5.5 title", place: "optional", editKind: "graphic", value: "Graphic", stretch: { start: 18.92, end: 22.26 }, clipIds: ["model_intro_opus"], overlayClipIds: ["model_intro_opus"] }),
        makeRow({ key: "c_move/1", threadId: "t_move", threadOrder: 1, at: 646.14, label: "Moved the Muse Ember title to the bottom left.", rawLabel: "Muse Ember title", place: "optional", editKind: "graphic", value: "Graphic", stretch: { start: 646.14, end: 649.48 }, clipIds: ["model_intro_ember"], overlayClipIds: ["model_intro_ember"] }),
      ],
    });
    store.report("t_hold", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 2,
      rows: [
        makeRow({ key: "c_hold/0", threadId: "t_hold", threadOrder: 2, at: 18.92, label: "Held the Opus 5.5 title two seconds longer.", rawLabel: "Opus 5.5 title", place: "optional", editKind: "graphic", value: "Graphic", stretch: { start: 18.92, end: 24.26 }, clipIds: ["model_intro_opus"], overlayClipIds: ["model_intro_opus"] }),
        makeRow({ key: "c_hold/1", threadId: "t_hold", threadOrder: 2, at: 648.11, label: "Held the Muse Ember title two seconds longer.", rawLabel: "Muse Ember title", place: "optional", editKind: "graphic", value: "Graphic", stretch: { start: 648.11, end: 653.45 }, clipIds: ["model_intro_ember"], overlayClipIds: ["model_intro_ember"] }),
      ],
    });

    const view = store.view();
    expect(view.optional).toBe(2);
    // Both distinct combined graphics belong to t_hold and collapse into one expanded "2 Graphics: …" batch row.
    expect(view.sections.low).toHaveLength(1);
    const batchRow = view.sections.low[0]!;
    expect(batchRow.label).toBe("2 Graphics: Opus 5.5 title, Muse Ember title");
    expect(batchRow.value).toBe("Graphic");
    expect(batchRow.members).toHaveLength(6);
    expect(batchRow.batch?.map(r => [r.label, r.value, r.at, r.members.length])).toEqual([
      ["Held the Opus 5.5 title two seconds longer.", "Graphic", 18.92, 3],
      ["Held the Muse Ember title two seconds longer.", "Graphic", 648.11, 3],
    ]);
    expect(view.lowRiskParts().map(p => [p.threadId, p.edits.length])).toEqual([
      ["t_add", 2],
      ["t_move", 2],
      ["t_hold", 2],
    ]);
  });

  it("batches repeated safe and kept Done edits inline while leaving Needs you, Working, Rejected, Markers, and v2 rows individual", () => {
    const store = new RailStore();
    store.report("t1", {
      you: 2, optional: 4, working: 2, done: 5, threadOrder: 0,
      rows: [
        // Needs you: never batched even with identical kind & thread.
        makeRow({ key: "n/0", threadId: "t1", threadOrder: 0, at: 10, label: "Flagged cut 1", place: "you", editKind: "cut", value: "Cut" }),
        makeRow({ key: "n/1", threadId: "t1", threadOrder: 0, at: 20, label: "Flagged cut 2", place: "you", editKind: "cut", value: "Cut" }),
        // Working: never batched.
        makeRow({ key: "w/0", threadId: "t1", threadOrder: 0, at: 30, label: "Revising gfx 1", place: "working", editKind: "graphic", value: "Graphic" }),
        makeRow({ key: "w/1", threadId: "t1", threadOrder: 0, at: 40, label: "Revising gfx 2", place: "working", editKind: "graphic", value: "Graphic" }),
        // Safe edits: 3 graphics collapse into 1 "3 Graphics" row, while 1 v2 graphic stays its own row.
        makeRow({ key: "s/0", threadId: "t1", threadOrder: 0, at: 50, label: "Opus title", place: "optional", editKind: "graphic", value: "Graphic" }),
        makeRow({ key: "s/1", threadId: "t1", threadOrder: 0, at: 70, label: "Fable title", place: "optional", editKind: "graphic", value: "Graphic" }),
        makeRow({ key: "s/2", threadId: "t1", threadOrder: 0, at: 90, label: "Haiku title", place: "optional", editKind: "graphic", value: "Graphic" }),
        makeRow({ key: "s/3", threadId: "t1", threadOrder: 0, at: 60, label: "Revised title", place: "optional", editKind: "graphic", value: "Graphic", version: 2 }),
        // Done: 2 kept cuts collapse into 1 "2 Cuts" row, while rejected, marker, and v2 stay individual.
        makeRow({ key: "d/0", threadId: "t1", threadOrder: 0, at: 100, label: "Cut silence 1", place: "done", editKind: "cut", value: "Kept", decision: "Kept" }),
        makeRow({ key: "d/1", threadId: "t1", threadOrder: 0, at: 120, label: "Cut silence 2", place: "done", editKind: "cut", value: "Kept", decision: "Kept" }),
        makeRow({ key: "d/2", threadId: "t1", threadOrder: 0, at: 110, label: "Rejected cut", place: "done", editKind: "cut", value: "Rejected", decision: "Rejected", decided: false, rejected: true }),
        makeRow({ key: "d/3", threadId: "t1", threadOrder: 0, at: 130, label: "Add B-roll marker", place: "done", value: "Done", decision: "Done", isMarker: true }),
        makeRow({ key: "d/4", threadId: "t1", threadOrder: 0, at: 140, label: "Kept v2 cut", place: "done", editKind: "cut", value: "Kept", decision: "Kept", version: 2 }),
      ],
    });

    const view = store.view();
    expect(view.sections.you).toHaveLength(2);
    expect(view.sections.you.every(r => !r.batch)).toBe(true);
    expect(view.sections.working).toHaveLength(2);
    expect(view.sections.working.every(r => !r.batch)).toBe(true);

    // Safe edits: total count = 4, rendered rows = 2 (1 batch of 3 + 1 v2 row).
    expect(view.optional).toBe(4);
    expect(view.sections.low.map(r => [r.label, r.batch?.length ?? 1, r.version])).toEqual([
      ["3 Graphics: Opus title, Fable title, Haiku title", 3, 0],
      ["Revised title", 1, 2],
    ]);
    expect(view.sections.low[0]!.tipText).toBe("3 Graphics");
    expect(view.sections.low[0]!.tipMeta).toBeUndefined();
    expect(view.sections.low[0]!.tipDetail).toBe("Opus title\nFable title\nHaiku title");

    // Done: total count = 5, rendered rows = 4 (1 batch of 2 + 1 rejected + 1 marker + 1 v2).
    expect(view.done).toBe(5);
    expect(view.sections.done.map(r => [r.label, r.batch?.length ?? 1, r.rejected, !!r.isMarker, r.unkeepTip])).toEqual([
      ["2 Cuts: silence 1, silence 2", 2, false, false, "Unkeep all 2"],
      ["Rejected cut", 1, true, false, undefined],
      ["Add B-roll marker", 1, false, true, undefined],
      ["Kept v2 cut", 1, false, false, undefined],
    ]);
    expect(view.sections.done[0]!.tipText).toBe("2 Cuts");
    expect(view.sections.done[0]!.tipMeta).toBe("Kept");
    expect(view.sections.done[0]!.tipDetail).toBe("Cut silence 1\nCut silence 2");
  });

  it("names dialogue pass cut batches with cut length or cut kind and shows sample items in tooltips", () => {
    const store = new RailStore();
    store.report("t_pass", {
      you: 0, optional: 4, working: 0, done: 0, threadOrder: 0,
      rows: [
        makeRow({ key: "p/0", threadId: "t_pass", threadOrder: 0, at: 11, label: "Cut “I can only compare this…”", place: "optional", editKind: "cut", isDialoguePass: true, removedSeconds: 1.5 }),
        makeRow({ key: "p/1", threadId: "t_pass", threadOrder: 0, at: 24, label: "Cut “um, wait”", place: "optional", editKind: "cut", isDialoguePass: true, removedSeconds: 2.0 }),
        makeRow({ key: "p/2", threadId: "t_pass", threadOrder: 0, at: 40, label: "Cut “so basically”", place: "optional", editKind: "cut", isDialoguePass: true, removedSeconds: 1.0 }),
        makeRow({ key: "p/3", threadId: "t_pass", threadOrder: 0, at: 55, label: "Cut “like I said”", place: "optional", editKind: "cut", isDialoguePass: true, removedSeconds: 0.5 }),
      ],
    });
    store.report("t_pauses", {
      you: 0, optional: 3, working: 0, done: 0, threadOrder: 1,
      rows: [
        makeRow({ key: "q/0", threadId: "t_pauses", threadOrder: 1, at: 5, label: "Shortened a pause", place: "optional", editKind: "cut", isDialoguePass: true, removedSeconds: 1.5 }),
        makeRow({ key: "q/1", threadId: "t_pauses", threadOrder: 1, at: 15, label: "Shortened a pause", place: "optional", editKind: "cut", isDialoguePass: true, removedSeconds: 1.5 }),
        makeRow({ key: "q/2", threadId: "t_pauses", threadOrder: 1, at: 25, label: "Shortened a pause", place: "optional", editKind: "cut", isDialoguePass: true, removedSeconds: 1.5 }),
      ],
    });
    const [pauseRow, row] = store.view().sections.low;
    expect(pauseRow!.label).toBe("3 Pause Cuts · −4.5 s");
    expect(pauseRow!.tipText).toBe("3 Pause Cuts");
    expect(row!.label).toBe("4 Dialogue Cuts · −5.0 s");
    expect(row!.tipText).toBe("4 Dialogue Cuts");
    expect(row!.tipMeta).toBe("Cut · −5.0 s");
    expect(row!.tipDetail).toBe("Cut “I can only compare this…”\nCut “um, wait”\nand 2 more");
  });

  it("expands cut batch names from item labels, shared change descriptions, or cut length", () => {
    const store = new RailStore();
    store.report("t_named", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 0,
      rows: [
        makeRow({ key: "c/0", threadId: "t_named", threadOrder: 0, at: 4, label: "Cut false start", place: "optional", editKind: "cut", removedSeconds: 1.5 }),
        makeRow({ key: "c/1", threadId: "t_named", threadOrder: 0, at: 14, label: "Cut tangent", place: "optional", editKind: "cut", removedSeconds: 2.0 }),
      ],
    });
    store.report("t_desc", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 1,
      rows: [
        makeRow({ key: "d/0", threadId: "t_desc", threadOrder: 1, at: 0, label: "Cut", place: "optional", editKind: "cut", batchContext: "Cut the false start and the tangent at 14 s" }),
        makeRow({ key: "d/1", threadId: "t_desc", threadOrder: 1, at: 14, label: "Cut", place: "optional", editKind: "cut", batchContext: "Cut the false start and the tangent at 14 s" }),
      ],
    });
    store.report("t_bare", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 2,
      rows: [
        makeRow({ key: "b/0", threadId: "t_bare", threadOrder: 2, at: 2, label: "Cut", place: "optional", editKind: "cut", removedSeconds: 1.5 }),
        makeRow({ key: "b/1", threadId: "t_bare", threadOrder: 2, at: 9, label: "Cut", place: "optional", editKind: "cut", removedSeconds: 2.0 }),
      ],
    });
    const [bareRow, descRow, namedRow] = store.view().sections.low;
    expect(namedRow!.label).toBe("2 Cuts: false start, tangent");
    expect(namedRow!.tipText).toBe("2 Cuts");
    expect(namedRow!.tipMeta).toBe("Cut · −3.5 s");
    expect(namedRow!.tipDetail).toBe("Cut false start\nCut tangent");

    expect(descRow!.label).toBe("2 Cuts: the false start and the tangent at 14 s");
    expect(descRow!.tipText).toBe("2 Cuts");
    expect(descRow!.tipDetail).toBe("Cut the false start and the tangent at 14 s");

    expect(bareRow!.label).toBe("2 Cuts · −3.5 s");
    expect(bareRow!.tipText).toBe("2 Cuts");
    expect(bareRow!.tipMeta).toBe("Cut · −3.5 s");
    expect(bareRow!.tipDetail).toBeUndefined();
  });

  it("prefers AI-generated batch summaries over authored batchTitle over fallback labels, and delays AI input while working", () => {
    const store = new RailStore();
    store.report("t_authored", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 0,
      rows: [
        makeRow({ key: "a/0", threadId: "t_authored", threadOrder: 0, at: 5, label: "Opus title", place: "optional", editKind: "graphic", batchTitle: "2 model title cards" }),
        makeRow({ key: "a/1", threadId: "t_authored", threadOrder: 0, at: 20, label: "Sonnet title", place: "optional", editKind: "graphic", batchTitle: "2 model title cards" }),
      ],
    });
    store.report("t_working", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 1,
      rows: [
        makeRow({ key: "w/0", threadId: "t_working", threadOrder: 1, at: 10, label: "Cut false start", place: "optional", editKind: "cut", threadWorking: true }),
        makeRow({ key: "w/1", threadId: "t_working", threadOrder: 1, at: 30, label: "Cut tangent", place: "optional", editKind: "cut", threadWorking: true }),
      ],
    });
    store.report("t_settled", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 2,
      rows: [
        makeRow({ key: "s/0", threadId: "t_settled", threadOrder: 2, at: 2, label: "Cut false start", place: "optional", editKind: "cut", removedSeconds: 1.5, requestText: "Tighten the opening" }),
        makeRow({ key: "s/1", threadId: "t_settled", threadOrder: 2, at: 14, label: "Cut tangent", place: "optional", editKind: "cut", removedSeconds: 2.0, requestText: "Tighten the opening" }),
      ],
    });

    const [settled, working, authored] = store.view().sections.low;
    // Authored Change.batchTitle shows right away without needing an extra AI call.
    expect(authored!.label).toBe("2 model title cards");
    expect(authored!.batchSummaryInput).toBeUndefined();
    // Working thread waits until finished before emitting batchSummaryInput.
    expect(working!.batchSummaryInput).toBeUndefined();
    // Settled batch without batchTitle emits batchSummaryInput and upgrades live when setBatchSummaries supplies an AI title.
    expect(settled!.label).toBe("2 Cuts: false start, tangent");
    expect(settled!.batchSummaryInput?.request).toBe("Tighten the opening");
    const key = settled!.batchSummaryKey!;
    const heard = vi.fn();
    store.subscribe(heard);
    store.setBatchSummaries({ [key]: "2 cuts: false start & tangent" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.view().sections.low[0]!.label).toBe("2 cuts: false start & tangent");
    expect(store.view().sections.low[0]!.batchSummaryInput).toBeUndefined();
    // Same summaries map does not notify listeners again.
    store.setBatchSummaries({ [key]: "2 cuts: false start & tangent" });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("requests and applies AI summaries for any non-cut batch kind (zooms, graphics, B-roll, audio, general edits)", () => {
    const store = new RailStore();
    store.report("t_zooms", {
      you: 0, optional: 3, working: 0, done: 0, threadOrder: 0,
      rows: [
        makeRow({ key: "z/0", threadId: "t_zooms", threadOrder: 0, at: 10, label: "Zoom on terminal", place: "optional", editKind: "zoom", requestText: "Punch in on the demos" }),
        makeRow({ key: "z/1", threadId: "t_zooms", threadOrder: 0, at: 40, label: "Zoom on browser", place: "optional", editKind: "zoom", requestText: "Punch in on the demos" }),
        makeRow({ key: "z/2", threadId: "t_zooms", threadOrder: 0, at: 80, label: "Zoom on results", place: "optional", editKind: "zoom", requestText: "Punch in on the demos" }),
      ],
    });
    store.report("t_broll", {
      you: 0, optional: 0, working: 0, done: 2, threadOrder: 1,
      rows: [
        makeRow({ key: "b/0", threadId: "t_broll", threadOrder: 1, at: 15, label: "Keyboard closeup", place: "done", editKind: "broll", decision: "Kept" }),
        makeRow({ key: "b/1", threadId: "t_broll", threadOrder: 1, at: 55, label: "Studio wide shot", place: "done", editKind: "broll", decision: "Kept" }),
      ],
    });
    store.report("t_other", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 2,
      rows: [
        makeRow({ key: "chg_mix/0", threadId: "t_other", threadOrder: 2, at: 5, label: "Warm intro grade", place: "optional", editKind: "other" }),
        makeRow({ key: "chg_mix/1", threadId: "t_other", threadOrder: 2, at: 95, label: "Warm outro grade", place: "optional", editKind: "other" }),
      ],
    });

    const initial = store.view();
    const otherRow = initial.sections.low[0]!;
    const zoomRow = initial.sections.low[1]!;
    const brollRow = initial.sections.done[0]!;
    expect(zoomRow.batchSummaryInput?.kind).toBe("zoom");
    expect(zoomRow.batchSummaryInput?.count).toBe(3);
    expect(brollRow.batchSummaryInput?.kind).toBe("broll");
    expect(otherRow.batchSummaryInput?.kind).toBeUndefined();
    expect(otherRow.batchSummaryInput?.count).toBe(2);

    store.setBatchSummaries({
      [zoomRow.batchSummaryKey!]: "3 zooms on demo screens",
      [brollRow.batchSummaryKey!]: "2 B-roll studio cutaways",
      [otherRow.batchSummaryKey!]: "2 warm color grades",
    });
    const updated = store.view();
    expect(updated.sections.low[0]!.label).toBe("2 warm color grades");
    expect(updated.sections.low[0]!.tipMeta).toBe("2 Edits");
    expect(updated.sections.low[1]!.label).toBe("3 zooms on demo screens");
    expect(updated.sections.low[1]!.tipMeta).toBe("3 Zooms");
    expect(updated.sections.done[0]!.label).toBe("2 B-roll studio cutaways");
    expect(updated.sections.done[0]!.tipMeta).toBe("2 B-roll Shots · Kept");
  });

  it("keeps a combined row in Low risk when an older request was kept but a follow-up request has not been kept yet", () => {
    const store = new RailStore();
    store.report("t1", {
      you: 0, optional: 0, working: 0, done: 1, threadOrder: 0,
      rows: [makeRow({ key: "c1/0", threadId: "t1", threadOrder: 0, at: 18, label: "Opus 5.5 title", place: "done", editKind: "graphic", value: "Kept", decision: "Kept", clipIds: ["g1"], overlayClipIds: ["g1"] })],
    });
    store.report("t2", {
      you: 0, optional: 1, working: 0, done: 0, threadOrder: 1,
      rows: [makeRow({ key: "c2/0", threadId: "t2", threadOrder: 1, at: 18, label: "Moved the Opus 5.5 title", rawLabel: "Opus 5.5 title", place: "optional", editKind: "graphic", value: "Graphic", clipIds: ["g1"], overlayClipIds: ["g1"] })],
    });
    const view = store.view();
    expect([view.optional, view.done]).toEqual([1, 0]);
    expect(view.sections.low[0]!.label).toBe("Moved the Opus 5.5 title");
    expect(view.sections.low[0]!.members).toHaveLength(2);
  });

  it("prefers a specific kind tag over a generic Edit follow-up when combining rows across requests", () => {
    const store = new RailStore();
    store.report("t1", {
      you: 0, optional: 1, working: 0, done: 0, threadOrder: 0,
      rows: [makeRow({ key: "c1/0", threadId: "t1", threadOrder: 0, at: 18, label: "Opus 5.5 title", place: "optional", editKind: "graphic", value: "Graphic", clipIds: ["g1"], overlayClipIds: ["g1"] })],
    });
    store.report("t2", {
      you: 0, optional: 1, working: 0, done: 0, threadOrder: 1,
      rows: [makeRow({ key: "c2/0", threadId: "t2", threadOrder: 1, at: 18, label: "Adjusted title timing", rawLabel: "Opus 5.5 title", place: "optional", value: "Edit", clipIds: ["g1"], overlayClipIds: ["g1"] })],
    });
    const view = store.view();
    expect(view.sections.low[0]!.value).toBe("Graphic");
  });

  it("refreshes row callbacks without notifying listeners when the reported row data is unchanged", () => {
    const store = new RailStore();
    const heard = vi.fn();
    store.subscribe(heard);
    const firstOpen = vi.fn();
    const secondOpen = vi.fn();
    store.report("t1", {
      you: 0, optional: 1, working: 0, done: 0, threadOrder: 0,
      rows: [makeRow({ key: "c1/0", threadId: "t1", threadOrder: 0, at: 10, label: "Title", place: "optional", open: firstOpen })],
    });
    expect(heard).toHaveBeenCalledTimes(1);
    store.report("t1", {
      you: 0, optional: 1, working: 0, done: 0, threadOrder: 0,
      rows: [makeRow({ key: "c1/0", threadId: "t1", threadOrder: 0, at: 10, label: "Title", place: "optional", open: secondOpen })],
    });
    expect(heard).toHaveBeenCalledTimes(1);
    store.view().sections.low[0]!.open!();
    expect(firstOpen).not.toHaveBeenCalled();
    expect(secondOpen).toHaveBeenCalledTimes(1);
  });

  describe("lingering transitions", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("holds kept and revised rows in place without duplicating them in Done or Working, then fades and moves them over", () => {
      vi.useFakeTimers();
      const store = new RailStore();
      store.report("t1", {
        you: 2, optional: 0, working: 0, done: 0, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "c/0", threadId: "t1", threadOrder: 0, at: 5, label: "Flagged cut", place: "you" }),
          makeRow({ key: "c/1", threadId: "t1", threadOrder: 0, at: 15, label: "Flagged graphic", place: "you" }),
        ],
      });

      // Keep c/0 -> Done, revise c/1 -> Working.
      store.report("t1", {
        you: 0, optional: 0, working: 1, done: 1, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "c/0", threadId: "t1", threadOrder: 0, at: 5, label: "Flagged cut", place: "done", value: "Kept", decision: "Kept" }),
          makeRow({ key: "c/1", threadId: "t1", threadOrder: 0, at: 15, label: "Flagged graphic", place: "working", word: "Revising…", busy: true }),
        ],
      });

      // Logical sections updated at once; display sections keep both rows in Needs review without duplicating them in Working/Done.
      let v = store.view();
      expect([v.need, v.working, v.done]).toEqual([0, 1, 1]);
      expect(v.display.sections.you.map(r => [r.label, r.decision ?? r.word, !!r.leaving])).toEqual([
        ["Flagged cut", "Kept", false],
        ["Flagged graphic", "Revising…", false],
      ]);
      expect(v.display.sections.working).toHaveLength(0);
      expect(v.display.sections.done).toHaveLength(0);
      expect([v.display.working, v.display.done]).toEqual([0, 0]);

      // After LINGER_MS both enter their fade-out phase.
      vi.advanceTimersByTime(LINGER_MS);
      v = store.view();
      expect(v.display.sections.you.map(r => r.leaving)).toEqual([true, true]);
      expect([v.display.working, v.display.done]).toEqual([0, 0]);

      // After LINGER_FADE_MS both leave Needs review and arrive cleanly in Working and Done with arriving flag.
      vi.advanceTimersByTime(LINGER_FADE_MS);
      v = store.view();
      expect(v.display.sections.you).toHaveLength(0);
      expect(v.display.sections.working.map(r => [r.label, !!r.arriving])).toEqual([["Flagged graphic", true]]);
      expect(v.display.sections.done.map(r => [r.label, !!r.arriving])).toEqual([["Flagged cut", true]]);
      expect([v.display.working, v.display.done]).toEqual([1, 1]);

      // After ARRIVE_MS the arriving flag clears.
      vi.advanceTimersByTime(ARRIVE_MS);
      v = store.view();
      expect(v.display.sections.working[0]!.arriving).toBeFalsy();
      expect(v.display.sections.done[0]!.arriving).toBeFalsy();
      store.dispose();
    });

    it("keeps a Done -> Working revision lingering in Done only when Done is expanded, and resets timer when queued work becomes busy", () => {
      vi.useFakeTimers();
      const store = new RailStore();
      store.setDoneOpen(true);
      store.report("t1", {
        you: 0, optional: 0, working: 0, done: 2, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "d/0", threadId: "t1", threadOrder: 0, at: 5, label: "Kept A", place: "done", value: "Kept", decision: "Kept" }),
          makeRow({ key: "d/1", threadId: "t1", threadOrder: 0, at: 15, label: "Kept B", place: "done", value: "Kept", decision: "Kept" }),
        ],
      });

      // Revise d/0 while queued (busy: false) -> lingers in Done, not duplicated in Working.
      store.report("t1", {
        you: 0, optional: 0, working: 1, done: 1, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "d/0", threadId: "t1", threadOrder: 0, at: 5, label: "Kept A", place: "working", word: "Up next", busy: false }),
          makeRow({ key: "d/1", threadId: "t1", threadOrder: 0, at: 15, label: "Kept B", place: "done", value: "Kept", decision: "Kept" }),
        ],
      });
      expect(store.view().display.sections.done.map(r => r.label)).toEqual(["Kept A", "Kept B"]);
      expect(store.view().display.working).toBe(0);

      // 1.5s later Scarlet starts working (busy: true) -> linger timer restarts so editor sees active work for a full window.
      vi.advanceTimersByTime(1500);
      store.report("t1", {
        you: 0, optional: 0, working: 1, done: 1, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "d/0", threadId: "t1", threadOrder: 0, at: 5, label: "Kept A", place: "working", word: "Revising…", busy: true }),
          makeRow({ key: "d/1", threadId: "t1", threadOrder: 0, at: 15, label: "Kept B", place: "done", value: "Kept", decision: "Kept" }),
        ],
      });
      vi.advanceTimersByTime(1500);
      expect(store.view().display.sections.done.find(r => r.label === "Kept A")?.leaving).toBe(false);

      vi.advanceTimersByTime(LINGER_MS - 1500 + LINGER_FADE_MS);
      expect(store.view().display.sections.done.map(r => r.label)).toEqual(["Kept B"]);
      expect(store.view().display.sections.working.map(r => r.label)).toEqual(["Kept A"]);

      // When Done is closed, revising d/1 moves straight to Working without lingering unseen in Done.
      store.setDoneOpen(false);
      store.report("t1", {
        you: 0, optional: 0, working: 2, done: 0, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "d/0", threadId: "t1", threadOrder: 0, at: 5, label: "Kept A", place: "working", word: "Revising…", busy: true }),
          makeRow({ key: "d/1", threadId: "t1", threadOrder: 0, at: 15, label: "Kept B", place: "working", word: "Revising…", busy: true }),
        ],
      });
      expect(store.view().display.sections.done).toHaveLength(0);
      expect(store.view().display.sections.working.map(r => r.label)).toEqual(["Kept A", "Kept B"]);
      store.dispose();
    });

    it("preserves the same batch key when keeping a safe batch together while unfolded, splits out a revised edit, and skips lingering while Safe edits is folded", () => {
      vi.useFakeTimers();
      const store = new RailStore();
      store.report("t1", {
        you: 0, optional: 3, working: 0, done: 0, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "s/0", threadId: "t1", threadOrder: 0, at: 10, label: "Gfx 1", place: "optional", editKind: "graphic", value: "Graphic" }),
          makeRow({ key: "s/1", threadId: "t1", threadOrder: 0, at: 20, label: "Gfx 2", place: "optional", editKind: "graphic", value: "Graphic" }),
          makeRow({ key: "s/2", threadId: "t1", threadOrder: 0, at: 30, label: "Gfx 3", place: "optional", editKind: "graphic", value: "Graphic" }),
        ],
      });
      // Safe edits starts folded -> unfolding marks rows visible so subsequent actions linger cleanly.
      store.setLowOpen(true);
      const initialKey = store.view().display.sections.low[0]!.key;

      // Revise just s/1 out of the batch -> s/0+s/2 remain a 2-graphic batch, s/1 lingers as its own Revising row in Safe edits.
      store.report("t1", {
        you: 0, optional: 2, working: 1, done: 0, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "s/0", threadId: "t1", threadOrder: 0, at: 10, label: "Gfx 1", place: "optional", editKind: "graphic", value: "Graphic" }),
          makeRow({ key: "s/1", threadId: "t1", threadOrder: 0, at: 20, label: "Gfx 2", place: "working", editKind: "graphic", word: "Revising…", busy: true }),
          makeRow({ key: "s/2", threadId: "t1", threadOrder: 0, at: 30, label: "Gfx 3", place: "optional", editKind: "graphic", value: "Graphic" }),
        ],
      });
      expect(store.view().display.sections.low.map(r => [r.label, r.batch?.length ?? 1, r.word ?? r.value])).toEqual([
        ["2 Graphics: Gfx 1, Gfx 3", 2, "Graphic"],
        ["Gfx 2", 1, "Revising…"],
      ]);
      expect(store.view().display.working).toBe(0);
      vi.advanceTimersByTime(LINGER_MS + LINGER_FADE_MS);
      expect(store.view().display.working).toBe(1);

      // Keep the remaining batch together -> preserves the exact batch key in Safe edits while lingering as Kept.
      store.report("t1", {
        you: 0, optional: 0, working: 1, done: 2, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "s/0", threadId: "t1", threadOrder: 0, at: 10, label: "Gfx 1", place: "done", editKind: "graphic", value: "Kept", decision: "Kept" }),
          makeRow({ key: "s/1", threadId: "t1", threadOrder: 0, at: 20, label: "Gfx 2", place: "working", editKind: "graphic", word: "Revising…", busy: true }),
          makeRow({ key: "s/2", threadId: "t1", threadOrder: 0, at: 30, label: "Gfx 3", place: "done", editKind: "graphic", value: "Kept", decision: "Kept" }),
        ],
      });
      const keptBatch = store.view().display.sections.low[0]!;
      expect(keptBatch.key).toBe(initialKey);
      expect(keptBatch.decision).toBe("Kept");
      expect(keptBatch.batch).toHaveLength(2);
      expect(store.view().display.done).toBe(0);

      // ⌘Z undo returns both to Safe edits immediately without waiting for the timer.
      store.report("t1", {
        you: 0, optional: 2, working: 1, done: 0, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "s/0", threadId: "t1", threadOrder: 0, at: 10, label: "Gfx 1", place: "optional", editKind: "graphic", value: "Graphic" }),
          makeRow({ key: "s/1", threadId: "t1", threadOrder: 0, at: 20, label: "Gfx 2", place: "working", editKind: "graphic", word: "Revising…", busy: true }),
          makeRow({ key: "s/2", threadId: "t1", threadOrder: 0, at: 30, label: "Gfx 3", place: "optional", editKind: "graphic", value: "Graphic" }),
        ],
      });
      expect(store.view().display.sections.low[0]!.decided).toBe(false);
      expect(store.view().display.sections.low[0]!.leaving).toBeFalsy();

      // Folding Safe edits and keeping them moves them straight to Done without lingering unseen.
      store.setLowOpen(false);
      store.report("t1", {
        you: 0, optional: 0, working: 1, done: 2, threadOrder: 0, listLoaded: true,
        rows: [
          makeRow({ key: "s/0", threadId: "t1", threadOrder: 0, at: 10, label: "Gfx 1", place: "done", editKind: "graphic", value: "Kept", decision: "Kept" }),
          makeRow({ key: "s/1", threadId: "t1", threadOrder: 0, at: 20, label: "Gfx 2", place: "working", editKind: "graphic", word: "Revising…", busy: true }),
          makeRow({ key: "s/2", threadId: "t1", threadOrder: 0, at: 30, label: "Gfx 3", place: "done", editKind: "graphic", value: "Kept", decision: "Kept" }),
        ],
      });
      expect(store.view().display.sections.low).toHaveLength(0);
      expect(store.view().display.done).toBe(2);
      store.dispose();
    });
  });
});
