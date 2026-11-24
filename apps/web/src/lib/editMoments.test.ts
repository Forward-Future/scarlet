import { describe, expect, it } from "vitest";
import { listMoments, samePlace } from "./editMoments";

const cut = (spot: number, at: number, removed = 2) => ({ changeId: "chg_pass", spot, range: { start: at - 1, end: at + 1 }, at, beforeCut: { removed: { start: 100, end: 100 + removed } } });
const edit = (spot: number, start: number, end: number, extra: object = {}) => ({ changeId: "chg_pass", spot, range: { start, end }, ...extra });
const spots = (moments: { members: { spot: number }[] }[]) => moments.map(m => m.members.map(e => e.spot));

describe("listMoments", () => {
  it("combines edits only when they overlap on the timeline exactly, named for the largest cut or longest edit", () => {
    const moments = listMoments([
      cut(0, 17),
      cut(1, 21),
      edit(2, 21, 24),
      cut(3, 30, 61),
      cut(4, 30.02, 3),
      edit(5, 30, 33),
      edit(6, 30.01, 33.02),
      cut(7, 41),
    ]);
    expect(spots(moments)).toEqual([[0], [1], [2], [3, 4], [5, 6], [7]]);
    expect(moments[3]!.main.spot).toBe(3);
    expect(moments[3]!.edits.map(e => e.spot)).toEqual([3, 4]);
    expect(moments[3]).toMatchObject({ key: "chg_pass/3", start: 30, end: 30.02 });
    expect(moments[4]!.main.spot).toBe(6);
    expect(moments[4]).toMatchObject({ key: "chg_pass/6", start: 30, end: 33.02 });
  });

  it("names a moment for the cut Scarlet described, between two as large", () => {
    const moments = listMoments([{ ...cut(0, 37, 1.4), label: "Cut" }, { ...cut(1, 37, 1.4), label: "Keep the response close to the cube movement." }]);
    expect(moments.map(m => m.main.spot)).toEqual([1]);
  });

  it("keeps apart cuts and ranged edits, partial overlaps, adjacent edits, and same-label edits in different places", () => {
    // Adjacent edits that only touch.
    expect(listMoments([edit(0, 10, 14), edit(1, 14, 18)]).length).toBe(2);
    // Partial overlaps, including one edit inside another or sharing one edge.
    expect(listMoments([edit(0, 4, 7), edit(1, 4, 8), edit(2, 4.5, 6.5)]).length).toBe(3);
    // A music bed under the whole video doesn't take edits in it.
    expect(listMoments([edit(0, 0, 600), cut(1, 30), edit(2, 30, 33)]).length).toBe(3);
    // Same-label edits at different places on the timeline stay separate rows.
    const fades = [2, 8, 14].map((start, i) => edit(i, start, start + 2, { label: "Softened every dialogue join" }));
    expect(spots(listMoments(fades))).toEqual([[0], [1], [2]]);
  });

  it("keeps edits in different places apart and never chains across steps", () => {
    // A run of cuts a couple of seconds apart is a row each.
    expect(listMoments([0, 2, 4, 6, 8, 10, 12].map((at, spot) => cut(spot, 30 + at))).length).toBe(7);
    // Two cuts within a frame are the same join; half a second apart they aren't.
    expect(spots(listMoments([cut(0, 30), cut(1, 30.02), cut(2, 30.5)]))).toEqual([[0, 1], [2]]);
    // A two-frame fade centered on a cut join shares that exact point; a longer range does not.
    expect(samePlace(cut(0, 7.36), edit(1, 7.33, 7.39))).toBe(true);
    expect(samePlace(cut(0, 7.36), edit(1, 7.36, 10))).toBe(false);
    // Never transitively chains across small steps beyond a single frame from the first member.
    expect(spots(listMoments([cut(0, 30), cut(1, 30.04), cut(2, 30.08)]))).toEqual([[0, 1], [2]]);
  });

  it("never folds an edit that asks for a look, or a spot marked for the editor, into a moment", () => {
    const moments = listMoments([
      edit(0, 30, 32),
      edit(1, 30, 32, { check: "Is the zoom late?" }),
      edit(2, 30, 32, { marker: { kind: "footage" } }),
      edit(3, 30, 32),
    ]);
    expect(spots(moments)).toEqual([[0, 3], [1], [2]]);
  });
});
