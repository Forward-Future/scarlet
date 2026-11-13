import { describe, expect, it } from "vitest";
import { pacing } from "../src/metrics.ts";
import { publishedReference } from "../src/published.ts";
import { scoreRun } from "../src/score.ts";
import { playedWords } from "../src/timeline.ts";
import { cut, media, recording } from "./fixtures.ts";

const MIC = "med_mic";
// Twenty different words, one a second: word n is spoken from n+0.2 to n+0.7 s.
const raw = recording(MIC, 20, Array.from({ length: 20 }, (_, n) => [`word${n}`, n + 0.2, n + 0.7] as [string, number, number]));
const evidence = new Map([[MIC, raw]]);
const info = [media(MIC), media("med_screen")];
// What a finished video of a cut sounds like: its words on its own clock.
const finished = (keep: Array<[number, number]>) => playedWords(cut("F", MIC, keep), info, evidence).map(({ text, start, end }) => ({ text, start, end }));

describe("a published video as the reference", () => {
  it("finds what the editor kept of the recording from the words alone", () => {
    // Words 8 to 10 are gone, and the pause at the join is half a second.
    const ref = publishedReference(finished([[0, 8], [11, 20]]), evidence, [MIC]);
    expect(ref).toMatchObject({ rate: 1, finishedWords: 17, matchedWords: 17, addedPassages: 0, reordered: 0 });
    // Each kept piece reaches half that pause past its last word and before its first.
    expect(ref.kept[MIC]).toEqual([{ start: 0, end: 7.95 }, { start: 10.95, end: 19.7 }]);
    expect(pacing(ref.played)).toMatchObject({ words: 17, joins: 1, medianJoinGapSeconds: 0.5 });
  });

  it("sets apart speech that is in no recording", () => {
    const intro = ["welcome", "to", "the", "show"].map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const ref = publishedReference([...intro, ...finished([[0, 8], [11, 20]]).map(w => ({ ...w, start: w.start + 2, end: w.end + 2 }))], evidence, [MIC]);
    expect(ref).toMatchObject({ finishedWords: 21, matchedWords: 17, addedPassages: 1 });
    expect(ref.kept[MIC]).toHaveLength(2);
    expect(new Set(ref.played.map(w => w.piece)).size).toBe(3);
  });

  it("scores a cut against it by words and pacing, and leaves edges out", () => {
    const S = cut("S", MIC, [[0, 20]]), A = cut("A", MIC, [[0, 8], [10, 20]]);
    const published = publishedReference(finished([[0, 8], [11, 20]]), evidence, [MIC]);
    const score = scoreRun({ media: info, timelines: { source: S, applied: A, proposed: A }, evidence, reference: { label: "the published video", published } });
    // The cut took out words 8 and 9; the editor also took out word 10.
    expect(score.reference!.operatingPoints.applied.cut!.words).toMatchObject({ tp: 2, fp: 0, fn: 1 });
    expect(score.reference!.published).toMatchObject({ matchedWords: 17 });
    expect(score.pacing.reference).toMatchObject({ joins: 1 });
    expect(score.headline.edgeF1At20ms).toBeNull();
    expect(score.headline.wordF1).toBe(0.8);
  });
});
