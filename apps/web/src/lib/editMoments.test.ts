import { describe, expect, it } from "vitest";
import { editPlaces, listMoments, overlapSignificantly, passRows } from "./editMoments";

const cut = (spot: number, at: number, removed = 2) => ({ changeId: "chg_pass", spot, range: { start: at - 1, end: at + 1 }, at, beforeCut: { removed: { start: 100, end: 100 + removed } } });
const edit = (spot: number, start: number, end: number, extra: object = {}) => ({ changeId: "chg_pass", spot, range: { start, end }, ...extra });
const spots = (moments: { members: { spot: number }[] }[]) => moments.map(m => m.members.map(e => e.spot));

describe("listMoments", () => {
  it("puts edits that play as one change in one moment, named for its largest cut", () => {
    // The opening of a Rubik's Cube demo: a long cut, the cut of a stumble on its join, and the zooms that run on from it.
    const moments = listMoments([
      cut(0, 17), cut(1, 21), edit(2, 21, 24), cut(3, 30, 61), cut(4, 30.4, 3), edit(5, 30, 33), edit(6, 30.5, 33), cut(7, 41),
    ]);
    expect(spots(moments)).toEqual([[0], [1, 2], [3, 5, 4, 6], [7]]);
    expect(moments[2]!.main.spot).toBe(3);
    expect(moments[2]!.edits.map(e => e.spot)).toEqual([3, 5, 4, 6]);
    expect(moments[2]).toMatchObject({ key: "chg_pass/3", start: 30, end: 33 });
  });

  it("names a moment for the cut Scarlet described, between two as large", () => {
    const moments = listMoments([{ ...cut(0, 37, 1.4), label: "Cut" }, { ...cut(1, 37, 1.4), label: "Keep the response close to the cube movement." }]);
    expect(moments.map(m => m.main.spot)).toEqual([1]);
  });

  it("keeps apart edits that only touch, and an edit that runs much longer than another in it", () => {
    expect(listMoments([edit(0, 10, 14), edit(1, 14, 18)]).length).toBe(2);
    // A music bed under the whole video doesn't take every edit in it.
    expect(listMoments([edit(0, 0, 600), cut(1, 30), edit(2, 30, 33)]).map(m => m.members.length)).toEqual([1, 2]);
  });

  it("keeps edits in different places apart, however close", () => {
    // A run of cuts a couple of seconds apart is a row each.
    expect(listMoments([0, 2, 4, 6, 8, 10, 12].map((at, spot) => cut(spot, 30 + at))).length).toBe(7);
    // Two cuts a frame apart are the same join; half a second apart they aren't.
    expect(spots(listMoments([cut(0, 30), cut(1, 30.02), cut(2, 30.5)]))).toEqual([[0, 1], [2]]);
    // A zoom that starts a second after a cut's join, and two edits side by side, are somewhere else.
    expect(spots(listMoments([cut(0, 30), edit(1, 31, 34), edit(2, 34.5, 37)]))).toEqual([[0], [1], [2]]);
  });

  it("never folds an edit that asks for a look, or a spot marked for the editor, into a moment", () => {
    const moments = listMoments([cut(0, 30), edit(1, 30, 33, { check: "Is the zoom late?" }), edit(2, 30, 32, { marker: { kind: "footage" } }), edit(3, 30, 32)]);
    expect(spots(moments)).toEqual([[0, 3], [2], [1]]);
  });

  it("weighs the overlap against the shorter stretch, and keeps a much longer one apart", () => {
    expect(overlapSignificantly({ start: 0, end: 10 }, { start: 2, end: 8 })).toBe(true);
    expect(overlapSignificantly({ start: 0, end: 10 }, { start: 2, end: 6 })).toBe(true);
    expect(overlapSignificantly({ start: 0, end: 10 }, { start: 2, end: 4 })).toBe(false);
    expect(overlapSignificantly({ start: 0, end: 4 }, { start: 3, end: 8 })).toBe(false);
    expect(overlapSignificantly({ start: 0, end: 4 }, { start: 4, end: 8 })).toBe(false);
  });
});

describe("passRows", () => {
  const fade = (spot: number, start: number, extra: object = {}) => edit(spot, start, start + 2, { label: "Softened every dialogue join", ...extra });

  it("lists an edit made in many places as one row at its first place, apart from the moments its places would join", () => {
    // A fade on every join: its first place starts beside a cut, which would make a moment of the two.
    const edits = [cut(0, 3), fade(1, 2), fade(2, 8), cut(3, 9), fade(4, 14), edit(5, 20, 22, { label: "Title card" })];
    expect(spots(listMoments(edits))).toEqual([[1, 0], [2, 3], [4], [5]]);
    const rows = passRows(edits);
    expect(spots(rows)).toEqual([[1, 2, 4], [0], [3], [5]]);
    expect(rows[0]).toMatchObject({ key: "chg_pass/1", places: true, start: 2, end: 16 });
    expect(rows[0]!.main.spot).toBe(1);
    expect(rows.slice(1).some(row => row.places)).toBe(false);
    // Each place answers with the same row.
    const places = editPlaces(edits);
    expect([1, 2, 4].map(spot => places.get(`chg_pass/${spot}`)?.first)).toEqual(Array(3).fill("chg_pass/1"));
    expect([0, 3, 5].map(spot => places.has(`chg_pass/${spot}`))).toEqual([false, false, false]);
  });

  it("keeps a cut, a spot left for the editor, an edit that asks for a look and another request's edit one each, and is the moments with none", () => {
    const named = { label: "Tightened the pause" };
    const edits = [{ ...cut(0, 5), ...named }, { ...cut(1, 15), ...named }, edit(2, 20, 22, { ...named, check: "Listen to the join" }),
      edit(3, 30, 32, { ...named, marker: { kind: "footage" } }), edit(4, 40, 42, { ...named, elsewhere: true }), edit(5, 50, 52, named)];
    expect(editPlaces(edits).size).toBe(0);
    expect(passRows(edits)).toEqual(listMoments(edits));
  });
});
