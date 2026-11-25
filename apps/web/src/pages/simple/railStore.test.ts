import { describe, expect, it, vi } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { RailStore, type RailRow } from "./railStore";

function makeEdit(changeId: string, spot: number, label: string, start: number, end: number, extra: Partial<Omit<ThreadEdit, "at">> = {}): Omit<ThreadEdit, "at"> {
  return { changeId, spot, label, range: { start, end }, previous: [], ...extra };
}

function makeRow(over: Partial<RailRow> & Pick<RailRow, "key" | "threadId" | "threadOrder" | "at" | "label" | "place">): RailRow {
  const edit = over.editRef ?? makeEdit(over.key.split("/")[0] ?? "chg", Number(over.key.split("/")[1] ?? 0), over.rawLabel ?? over.label, over.at, over.at + 3, { kind: over.editKind });
  return {
    displayAt: over.at,
    rawLabel: over.label,
    stretch: edit.range,
    combinable: true,
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
        makeRow({ key: "c1/0", threadId: "t_old", threadOrder: 0, at: 5, label: "Old cut at 0:05", place: "optional" }),
        makeRow({ key: "c1/1", threadId: "t_old", threadOrder: 0, at: 20, label: "Old cut at 0:20", place: "optional" }),
      ],
    });
    store.report("t_new", {
      you: 0, optional: 2, working: 0, done: 0, threadOrder: 1,
      rows: [
        makeRow({ key: "c2/0", threadId: "t_new", threadOrder: 1, at: 180, label: "New title at 3:00", place: "optional" }),
        makeRow({ key: "c2/1", threadId: "t_new", threadOrder: 1, at: 90, label: "New title at 1:30", place: "optional" }),
      ],
    });
    const view = store.view();
    expect(view.sections.low.map(r => r.label)).toEqual([
      "New title at 1:30",
      "New title at 3:00",
      "Old cut at 0:05",
      "Old cut at 0:20",
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
    expect(view.sections.low.map(r => [r.label, r.value, r.at, r.members.length])).toEqual([
      ["Held the Opus 5.5 title two seconds longer.", "Graphic", 18.92, 3],
      ["Held the Muse Ember title two seconds longer.", "Graphic", 648.11, 3],
    ]);
    expect(view.lowRiskParts().map(p => [p.threadId, p.edits.length])).toEqual([
      ["t_add", 2],
      ["t_move", 2],
      ["t_hold", 2],
    ]);
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
});
