// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { originalReviewRef } from "../../lib/editReviews";
import { editGroups } from "./threadEditState";

const edit = (label: string, spot: number, range = { start: spot * 10, end: spot * 10 + 5 }, extra: Partial<Omit<ThreadEdit, "at">> = {}): Omit<ThreadEdit, "at"> =>
  ({ changeId: "chg_1", spot, label, range, previous: [], ...extra }) as Omit<ThreadEdit, "at">;

it("combines edits only when they share a label and overlap on the timeline exactly, keeping non-overlapping places, cuts, checks, and markers separate", () => {
  const edits = [
    edit("Zoom in on the camera", 0, { start: 0, end: 5 }),
    edit("Camera full screen", 1, { start: 10, end: 15 }),
    edit("Camera full screen", 2, { start: 10, end: 15 }),
    edit("Camera full screen", 3, { start: 10, end: 16 }),
    edit("Camera full screen", 4, { start: 30, end: 35 }),
    edit("Pause", 5, { start: 40, end: 40 }, { beforeCut: { version: "v1", removed: { start: 40, end: 42 } } }),
    edit("Pause", 6, { start: 40, end: 40 }, { beforeCut: { version: "v1", removed: { start: 42, end: 44 } } }),
    edit("Camera full screen", 7, { start: 10, end: 15 }, { check: "Check the framing" }),
    edit("Camera full screen", 8, { start: 10, end: 15 }, { marker: true }),
  ];
  expect(editGroups(edits).map(g => [g.label, g.members.map(m => m.i)])).toEqual([
    ["Zoom in on the camera", [0]],
    ["Camera full screen", [1, 2]],
    ["Camera full screen", [3]],
    ["Camera full screen", [4]],
    ["Pause", [5]],
    ["Pause", [6]],
    ["Camera full screen", [7]],
    ["Camera full screen", [8]],
  ]);
});

it("keeps one review identity across revisions and reordered places", () => {
  const original = { changeId: "chg_1", spot: 1 };
  const revision = { ...edit("Captions", 0), changeId: "chg_new", previous: [original, { changeId: "chg_middle", spot: 2 }] };
  const other = edit("Captions", 3);
  expect(originalReviewRef([other, revision])).toEqual(original);
  expect(originalReviewRef([revision, other])).toEqual(original);
  expect(originalReviewRef([revision])).toEqual(original);
});

it("combines contiguous B-roll edits in one continuous section into one group while keeping separate B-roll sections apart", () => {
  const edits = [
    edit("Wright Flyer ground", 0, { start: 149.8, end: 152.4 }, { kind: "broll", check: "Revised" }),
    edit("Wright Flyer front", 1, { start: 152.4, end: 155.0 }, { kind: "broll" }),
    edit("Wright Flyer flight", 2, { start: 155.0, end: 158.0 }, { kind: "broll" }),
    edit("Return to camera", 3, { start: 158.0, end: 160.0 }, { kind: "broll" }),
    edit("Boeing 747 liftoff", 4, { start: 186.6, end: 190.4 }, { kind: "broll", check: "Revised" }),
    edit("747 climbs", 5, { start: 190.4, end: 198.0 }, { kind: "broll" }),
  ];
  const sections = [
    { id: "broll:149800:158000", range: { start: 149.8, end: 158.0 }, clipIds: ["c1", "c2", "c3"] },
    { id: "broll:186600:198000", range: { start: 186.6, end: 198.0 }, clipIds: ["c4", "c5"] },
  ];
  const grouped = editGroups(edits, sections);
  expect(grouped.map(g => ({
    label: g.label,
    indices: g.members.map(m => m.i),
    continuousBroll: !!g.continuousBroll,
    stretch: g.stretch,
  }))).toEqual([
    { label: "Wright Flyer ground", indices: [0, 1, 2], continuousBroll: true, stretch: { start: 149.8, end: 158.0 } },
    { label: "Return to camera", indices: [3], continuousBroll: false, stretch: undefined },
    { label: "Boeing 747 liftoff", indices: [4, 5], continuousBroll: true, stretch: { start: 186.6, end: 198.0 } },
  ]);
});
