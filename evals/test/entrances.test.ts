import { expect, it } from "vitest";
import { entranceRows, entranceSummary, pairedEntrances } from "../src/entrances.ts";
import type { PictureEntrance } from "../../packages/mcp/src/picture-entrance.ts";

const words = [{ text: "here", start: .2, end: .7 }, { text: "again", start: 4.2, end: 4.5 }];
const reference = { frameRate: 30, joins: [{ finalTime: 1, earliestFinal: 1, latestFinal: 1 }],
  segments: [{ finalStart: 0, finalEnd: 1, rawStart: 0, rawEnd: 1 }, { finalStart: 1, finalEnd: 2, rawStart: 4, rawEnd: 5 }] };
const observations = [{ join: 0, publishedFrame: 39, publishedTime: 1.3 }];
const candidate: PictureEntrance = { status: "measured", previousWordIndex: 0, wordIndex: 1, gapMs: 30 };

it("measures a voice leading the verified picture on the actual soundtrack clock", () => {
  const rows = entranceRows(words, reference, observations, [candidate]);
  expect(rows[0]).toMatchObject({ editorMs: -100, errorMs: 130 });
  expect(entranceSummary(rows)).toMatchObject({ matched: 1, meanAbsoluteErrorMs: 130, meanErrorMs: 130 });
});
it("keeps uncertain editor onsets, different takes, duplicate pairings and clipped entrances out of the mean", () => {
  const score = (c: PictureEntrance[]) => entranceSummary(entranceRows(words, reference, observations, c));
  expect(score([{ ...candidate, previousWordIndex: 1 }]).matched).toBe(0);
  expect(score([candidate, candidate]).meanAbsoluteErrorMs).toBeNull();
  expect(score([{ ...candidate, status: "word-trimmed", gapMs: undefined }])).toMatchObject({ matched: 0, trimmedMatchedWords: 1 });
  expect(entranceRows([words[0]!, { ...words[1]!, start: 4.01 }], reference, observations, [candidate])[0]?.status).toBe("editor-word-at-edge");
  expect(entranceSummary(entranceRows(words, reference, [], [candidate])).verifiedPictures).toBe(0);
});

it("compares timing only on shared entrances and shows one-sided changes in coverage", () => {
  const row = { editorPictureAt: .1, status: "measured" };
  const before = [{ ...row, join: 0, errorMs: 500 }, { ...row, join: 1, errorMs: -64 }];
  const after = [{ ...row, join: 1, errorMs: -31 }, { ...row, join: 2, errorMs: 10 }];
  expect(pairedEntrances(before, after)).toEqual({ baselineMatched: 2, candidateMatched: 2, shared: 1, lost: [0], gained: [2],
    baselineErrorMs: 64, candidateErrorMs: 31, changeMs: -33 });
  expect(pairedEntrances(before, [after[1]!])).toMatchObject({ shared: 0, lost: [0, 1], gained: [2],
    baselineErrorMs: null, candidateErrorMs: null, changeMs: null });
});
