// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { originalReviewRef } from "../../lib/editReviews";
import { editGroups } from "./ThreadEdits";

const edit = (label: string, spot: number, cut = false): Omit<ThreadEdit, "at"> => ({ changeId: "chg_1", spot, label, range: { start: spot * 10, end: spot * 10 + 5 }, previous: [],
  ...(cut && { beforeCut: { version: "v1", removed: { start: spot * 10, end: spot * 10 + 2 } } }) }) as Omit<ThreadEdit, "at">;

it("reads the same edit made in several places as one edit, and keeps each cut its own", () => {
  const edits = [edit("Zoom in on the camera", 0), edit("Camera full screen", 1), edit("Pause", 2, true), edit("Camera full screen", 3), edit("Pause", 4, true), edit("Camera full screen", 5)];
  expect(editGroups(edits).map(g => [g.label, g.members.map(m => m.i)])).toEqual([
    ["Zoom in on the camera", [0]], ["Camera full screen", [1, 3, 5]], ["Pause", [2]], ["Pause", [4]]]);
});

it("keeps one review identity across revisions and reordered places", () => {
  const original = { changeId: "chg_1", spot: 1 };
  const revision = { ...edit("Captions", 0), changeId: "chg_new", previous: [original, { changeId: "chg_middle", spot: 2 }] };
  const other = edit("Captions", 3);
  expect(originalReviewRef([other, revision])).toEqual(original);
  expect(originalReviewRef([revision, other])).toEqual(original);
  expect(originalReviewRef([revision])).toEqual(original);
});
