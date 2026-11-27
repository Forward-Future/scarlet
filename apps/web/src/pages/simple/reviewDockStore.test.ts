import { describe, expect, it, vi } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { dedupeDockEntries, ReviewDockStore, type DockEntry, type DockRow } from "./reviewDockStore";

const makeEdit = (changeId: string, spot: number, start: number, end: number, label: string, check?: string): Omit<ThreadEdit, "at"> => ({
  changeId, spot, label, range: { start, end }, kind: "broll", previous: [], ...(check && { check }),
});

function makeDockEntry(overrides: Partial<DockEntry> & {
  key: string;
  threadId: string;
  at: number;
  label: string;
  stretch?: { start: number; end: number };
  edit?: Omit<ThreadEdit, "at">;
  rowOverrides?: Partial<DockRow>;
}): DockEntry {
  const { key, threadId, at, label, stretch = { start: at, end: at + 3 }, edit, rowOverrides, ...rest } = overrides;
  const place = rest.place ?? "optional";
  const needs = rowOverrides?.needs ?? place === "you";
  const decided = rowOverrides?.decided ?? place === "done";
  return {
    key: `${threadId}/${key}`,
    threadId,
    place,
    at,
    isPass: false,
    ...rest,
    row: {
      key: `${threadId}/${key}`,
      rawKey: key,
      threadId,
      id: `${threadId}/${key}`,
      at,
      displayAt: at,
      label,
      n: 0,
      value: decided ? "Kept" : "B-roll",
      decision: decided ? "Kept" : undefined,
      revised: false,
      rejected: false,
      skipped: false,
      forYou: needs,
      busy: false,
      pending: false,
      needs,
      asks: false,
      decided,
      version: 0,
      fresh: false,
      on: false,
      open: vi.fn(),
      dataLogControl: "open-edit",
      dataLogLabel: "Edit",
      edit: edit ?? makeEdit(`chg_${key}`, 0, stretch.start, stretch.end, label, needs ? "Revised" : undefined),
      editKind: "broll",
      stretch,
      nests: [],
      ...rowOverrides,
    },
  };
}

describe("dedupeDockEntries continuous B-roll collapsing", () => {
  it("merges contiguous cross-request B-roll rows into one dock entry while keeping non-contiguous sections separate", () => {
    const e1 = makeDockEntry({
      key: "b1/0", threadId: "t1", place: "you", at: 186.6, label: "Added a Boeing 747 taking off.",
      stretch: { start: 186.6, end: 190.4 },
      rowOverrides: { brollSectionId: "broll:186600:204050", version: 2 },
    });
    const e2 = makeDockEntry({
      key: "b2/0", threadId: "t2", place: "you", at: 190.4, label: "747 climbs into the sky",
      stretch: { start: 190.4, end: 198.0 },
      rowOverrides: { brollSectionId: "broll:186600:204050", version: 2 },
    });
    const e3 = makeDockEntry({
      key: "b3/0", threadId: "t3", place: "optional", at: 198.0, label: "747 cockpit",
      stretch: { start: 198.0, end: 204.05 },
      rowOverrides: { brollSectionId: "broll:186600:204050" },
    });
    const separate = makeDockEntry({
      key: "b4/0", threadId: "t3", place: "optional", at: 260, label: "Later B-roll",
      stretch: { start: 260, end: 264 },
      rowOverrides: { brollSectionId: "broll:260000:264000" },
    });

    const merged = dedupeDockEntries([e1, e2, e3, separate]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.place).toBe("you");
    expect(merged[0]!.row.label).toBe("Added a Boeing 747 taking off.");
    expect(merged[0]!.row.stretch).toEqual({ start: 186.6, end: 204.05 });
    expect(merged[0]!.row.continuousBroll).toBe(true);
    expect(merged[0]!.row.extraThreadEdits?.map(p => p.threadId)).toEqual(["t2", "t3"]);
    expect(merged[1]!.row.label).toBe("Later B-roll");
  });

  it("finds and unkeeps all contributing threads when a continuous B-roll section is kept in Done", () => {
    const store = new ReviewDockStore();
    const unkeep1 = vi.fn();
    const unkeep2 = vi.fn();
    const e1 = makeDockEntry({
      key: "b1/0", threadId: "t1", place: "done", at: 10, label: "Shot 1",
      stretch: { start: 10, end: 13 },
      rowOverrides: { unkeep: unkeep1 },
    });
    const e2 = makeDockEntry({
      key: "b2/0", threadId: "t2", place: "done", at: 13, label: "Shot 2",
      stretch: { start: 13, end: 16 },
      rowOverrides: { unkeep: unkeep2 },
    });
    store.report("t1", { threadId: "t1", isPass: false, hasCalls: false, hasForYou: true, need: 0, entries: [e1], allOpen: false, allLabel: "See all", soFar: false, onlyRejected: false, singleOpen: false, onRowHover: () => {} });
    store.report("t2", { threadId: "t2", isPass: false, hasCalls: false, hasForYou: true, need: 0, entries: [e2], allOpen: false, allLabel: "See all", soFar: false, onlyRejected: false, singleOpen: false, onRowHover: () => {} });

    const found = store.findForEdit(["t1", "t2"], "t2", e2.row.edit!);
    expect(found?.row.continuousBroll).toBe(true);
    expect(found?.row.stretch).toEqual({ start: 10, end: 16 });
    store.unkeepRow(found!.threadId, found!.key, ["t1", "t2"]);
    expect(unkeep1).toHaveBeenCalledTimes(1);
    expect(unkeep2).toHaveBeenCalledTimes(1);
  });
});
