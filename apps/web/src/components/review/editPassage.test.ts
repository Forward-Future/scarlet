// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { MappedWord } from "../../lib/transcriptMap";
import { sentencesAfter, sentencesBefore } from "./CutTranscript";

const words = (text: string) => text.split(" ").map((t, index) =>
  ({ index, word: { text: t }, placements: [{ start: index, end: index + 1 }] }) as unknown as MappedWord);
const read = (items: MappedWord[]) => items.map(w => w.word.text).join(" ");

it("reads back to the start of the sentence a cut sits in, and one sentence further when that one is short", () => {
  const before = words("We tried it last week. It broke. So DeepSeek says this model has a few different capabilities,");
  // The sentence the cut sits in is 10 words, under 12, so it reaches back one more.
  expect(read(sentencesBefore(before).items)).toBe("It broke. So DeepSeek says this model has a few different capabilities,");
  const enough = words("We tried it. So DeepSeek says this new model has a few really different capabilities,");
  expect(read(sentencesBefore(enough).items)).toBe("So DeepSeek says this new model has a few really different capabilities,");
  expect(sentencesBefore(before).clipped).toBe(false);
  // A cut that starts a sentence reads the sentence before it, and that one's too short, so one more.
  const atStart = words("This is the first sentence here, it runs on. Then a short one.");
  expect(read(sentencesBefore(atStart).items)).toBe("This is the first sentence here, it runs on. Then a short one.");
  // Without a sentence start in reach, it reads at most 32 words and says it starts partway.
  const long = words(Array.from({ length: 50 }, (_, i) => `w${i}`).join(" "));
  expect(sentencesBefore(long).items).toHaveLength(32);
  expect(sentencesBefore(long).clipped).toBe(true);
});

it("reads on through the end of the sentence after a cut, reaching past a short one", () => {
  const after = words("including its ability to build a full scene. That's what I want to test first. Then more.");
  expect(read(sentencesAfter(after).items)).toBe("including its ability to build a full scene. That's what I want to test first.");
  expect(sentencesAfter(after).clipped).toBe(false);
  expect(sentencesAfter(words("and then it")).clipped).toBe(true);
  expect(sentencesAfter([])).toEqual({ items: [], clipped: false });
});
