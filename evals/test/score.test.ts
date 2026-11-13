import { describe, expect, it } from "vitest";
import type { Change } from "../../packages/timeline/src/index.ts";
import type { ReviewChangeExport } from "../src/engine.ts";
import { scoreRun } from "../src/score.ts";
import { cut, lines, media } from "./fixtures.ts";

const MIC = "med_mic";
const change = (c: Partial<Change>) => ({ noteIds: [], ranges: [], renders: [], state: "ready", author: { type: "agent", name: "test" },
  description: "", projectId: "prj_test", ...c }) as Change;

describe("a plan given as words", () => {
  it("takes each cut's kind and decision from the words it names", () => {
    // Line 2 is words 4 and 5 of the transcript. The agent asked to cut it, and Scarlet staged it instead.
    const S = cut("S", MIC, [[0, 20]]), R = cut("R", MIC, [[0, 4], [6, 20]]);
    const review = change({ id: "chg_r", intent: "suggestion", fromVersion: "S", toVersion: "R", cutReasons: [{ start: 4, end: 6, reason: "No quiet point at this edge." }] });
    const score = scoreRun({
      media: [media(MIC), media("med_screen")], timelines: { source: S, applied: S, proposed: R }, reviewChange: review,
      plan: { version: "S", cuts: [{ start: 0, end: 0, mediaId: MIC, fromWord: 4, toWord: 5, kind: "retake", decision: "cut" }] },
      evidence: new Map([[MIC, lines(MIC, 10)]]),
    });
    expect(score.review!.removal.byCategory).toMatchObject({ retake: { cuts: 1 } });
    expect(score.review!.heldByScarlet).toBe(1);
    expect(score.headline.heldByScarlet).toBe(1);
  });
});

describe("scoring a synthetic run", () => {
  // Ten spoken lines. The agent cuts line 2 outright and stages line 5 (a detector hit Scarlet added) for review.
  const S = cut("S", MIC, [[0, 20]]);
  const A = cut("A", MIC, [[0, 4], [6, 20]]);
  const R = cut("R", MIC, [[0, 4], [6, 10], [12, 20]]);
  const applied = change({ id: "chg_a", intent: "requested", state: "approved", fromVersion: "S", toVersion: "A", appliedVersion: "A",
    cutReasons: [{ start: 4, end: 6, reason: "Earlier take of line 2." }] });
  // Review reasons are on A's timeline: source 10–12 plays at 8–10.
  const review = change({ id: "chg_r", intent: "suggestion", fromVersion: "A", toVersion: "R",
    cutReasons: [{ start: 8, end: 10, reason: "Whisper only: possible filler left in the edit." }] });
  const exported: ReviewChangeExport = { id: "chg_r", state: "approved", fromVersion: "A", toVersion: "R", firstCut: false, cuts: [
    { index: 0, removed: { start: 8, end: 10 }, sources: [{ mediaId: MIC, start: 10, end: 12 }], reasons: [], decision: "approved",
      assessment: { verdict: "cut", reason: "Repeated line.", inspected: true } }] };
  const score = scoreRun({
    media: [media(MIC), media("med_screen")],
    timelines: { source: S, applied: A, proposed: R },
    appliedChange: applied, reviewChange: review, review: exported,
    plan: { version: "S", cuts: [{ start: 4, end: 6, kind: "retake", decision: "cut" }, { start: 14, end: 14.5, kind: "pause", decision: "keep" }] },
    evidence: new Map([[MIC, lines(MIC, 10)]]),
    reference: { label: "editor", timeline: R },
  });

  it("splits applied and review removals by category", () => {
    expect(score.applied.removal).toMatchObject({ cuts: 1, joins: 1, seconds: 2, byCategory: { retake: { cuts: 1, seconds: 2 } } });
    expect(score.review!.removal).toMatchObject({ cuts: 1, seconds: 2, byCategory: { filler: { cuts: 1, seconds: 2 } } });
    expect(score.review!.cuts[0]).toMatchObject({ auto: true, start: 10, end: 12 });
  });

  it("measures each tier's new joins in silence", () => {
    expect(score.applied.edgeList.map(e => [e.at, e.side])).toEqual([[4, "out"], [6, "in"]]);
    expect(score.review!.edgeList.map(e => [e.at, e.side])).toEqual([[10, "out"], [12, "in"]]);
    expect(score.applied.edges).toMatchObject({ total: 2, silence: 2, speech: 0 });
  });

  it("counts AI recommendations against editor decisions", () => {
    expect(score.review).toMatchObject({ items: 1, ai: { cut: 1, inspected: 1 }, editor: { approved: 1 }, aiVsEditor: { "cut→approved": 1 } });
  });

  it("counts the gaps and doubled words each version still plays", () => {
    // A second passes between every two lines. The applied cut joins line 1 to line 3 across one of them.
    expect(score.pacing.source.gaps).toMatchObject({ inside: 9, atJoins: 0 });
    expect(score.pacing.applied).toMatchObject({ joins: 1, medianJoinGapSeconds: 1, gaps: { inside: 7, atJoins: 1 }, repeats: { total: 0 } });
    expect(score.pacing.reference).toMatchObject({ joins: 2, gaps: { inside: 5, atJoins: 2 } });
    expect(score.pacing.appliedGaps).toHaveLength(8);
    expect(score.headline).toMatchObject({ gapsLeft: 8, looseJoins: 1, repeatsLeft: 0, heldByScarlet: 0 });
  });

  it("scores each operating point against the reference", () => {
    const { applied: a, recommended, proposed } = score.reference!.operatingPoints;
    expect(proposed.cut!.words.f1).toBe(1);
    expect(recommended.cut!.time.f1).toBe(1);
    expect(a.cut!.words).toMatchObject({ tp: 2, fn: 2, recall: 0.5 });
    expect(score.headline).toMatchObject({ appliedCuts: 1, reviewCuts: 1, wordF1: 1, edgeF1At20ms: 1, requiredLinesMissing: 0 });
  });
});
