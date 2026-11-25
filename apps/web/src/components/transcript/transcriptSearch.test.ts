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

it("finds a word with either apostrophe, whichever one the search was typed with", () => {
  expect(findWords(words("we", "went", "to", "Wendy's."), "Wendy’s")).toEqual([3]);
  expect(findWords(words("I", "don’t", "know"), "don't know")).toEqual([1]);
  expect(findWords(words("I", "don’t", "know"), "dont")).toEqual([]);
  expect(findWords(words("she", "said", "‘hello’", "twice"), "said hello twice")).toEqual([1]);
  expect(findWords(words("the", "80’s", "sound"), "80's")).toEqual([1]);
  expect(findWords(words("她说‘你好’。"), "她说你好")).toEqual([0]);
  expect(findWords(words("她说‘你好’然后走了"), "你好然后")).toEqual([0]);
  expect(findWords(words("她说‘Wendy’吗"), "她说wendy吗")).toEqual([0]);
});

it("keeps the marks that make a word in Hindi or Thai, so a different word isn't matched", () => {
  // काम (work) is not कम (less): the vowel sign is part of the word.
  expect(findWords(words("काम"), "कम")).toEqual([]);
  expect(findWords(words("काम"), "काम")).toEqual([0]);
  expect(findWords(words("ไก่"), "ไก่")).toEqual([0]);
  // An accent written as a letter and a mark finds the same word written as one letter.
  expect(findWords(words("cafe\u0301"), "café")).toEqual([0]);
});
