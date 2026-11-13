import { expect, it } from "vitest";
import { adjacentRepeatCandidates } from "./adjacentRepeats.js";

it("tries longer repeats first and leaves shorter alternatives for callers to validate", () => {
  const tokens = "go left go left go left go left ahead".split(" ");
  const candidates = adjacentRepeatCandidates(tokens, tokens.map((_, i) => i / 3));
  expect(candidates(0)).toEqual([4, 2]);
  expect(candidates(6)).toEqual([]);
});

it("bounds longer pickups by elapsed playback time and preserves short matches at a slow pace", () => {
  const phrase = "the morning train leaves this station".split(" ");
  const starts = phrase.map((_, i) => i * .4);
  const repeated = (seconds: number) => adjacentRepeatCandidates([...phrase, ...phrase],
    [...starts, ...starts.map(t => t + seconds)])(0);
  expect(repeated(25)).toEqual([6]);
  expect(repeated(26)).toEqual([]);
  expect(adjacentRepeatCandidates(["one", "two", "one", "two"], [0, 25, 26, 27])(0)).toEqual([2]);
});
