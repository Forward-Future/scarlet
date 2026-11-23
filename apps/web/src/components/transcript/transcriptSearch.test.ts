import { expect, it } from "vitest";
import { findWords, searchTerms } from "./transcriptSearch";

const words = (...texts: string[]) => texts.map(text => ({ word: { text } }));

it("compares words in lower case without their punctuation, and drops a term that is only punctuation", () => {
  expect(searchTerms("  Hello, World! - ")).toEqual(["hello", "world"]);
});

it("finds a run of words, the last matched from its start, and one word anywhere inside another", () => {
  const said = words("So,", "we", "went", "to", "Wendy's.");
  expect(findWords(said, "we wen")).toEqual([1]);
  expect(findWords(said, "en")).toEqual([2, 4]);
  expect(findWords(said, ["went", "to"])).toEqual([2]);
  expect(findWords(said, "...")).toEqual([]);
});
