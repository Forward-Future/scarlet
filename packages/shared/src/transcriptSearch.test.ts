import { describe, expect, it } from "vitest";
import type { Transcript, TranscriptWord } from "@scarlet/timeline";
import { flattenWords, fuzzySearchTranscript, indexTranscriptWords, normalizeTranscriptToken, sameToken, searchTranscript, sequenceSimilarity, tokenSimilarity } from "./transcriptSearch.js";

describe("sameToken", () => {
  it("agrees with tokenSimilarity >= 0.8", () => {
    const words = ["", "a", "ab", "the", "they", "them", "word", "words", "worded", "colour", "color", "recognise", "recognize",
      "um", "umm", "uhm", "okay", "ok", "going", "gonna", "interview", "interviews", "interviewer", "café", "cafe", "naïve", "naive",
      "favourite", "favorite", "wouldnt", "wouldn", "aaaaa", "aaaab", "abcde", "abcdef", "abcdefgh", "abcdefghij"];
    for (const a of words) for (const b of words) expect(sameToken(a, b), `${a} / ${b}`).toBe(tokenSimilarity(a, b) >= 0.8);
  });

  it("agrees on every pair of short strings over a small alphabet", () => {
    const all: string[] = [""];
    for (let n = 1; n <= 6; n++) for (let i = 0; i < 2 ** n; i++) all.push(i.toString(2).padStart(n, "0").replace(/0/g, "a").replace(/1/g, "b"));
    for (const a of all) for (const b of all) if (sameToken(a, b) !== tokenSimilarity(a, b) >= 0.8) throw new Error(`${a} / ${b}`);
  });
});

const words = (text: string, speaker?: string): TranscriptWord[] => text.split(" ").map((w, i) => ({ text: w, start: i, end: i + 0.5, speaker }));

describe("flattenWords", () => {
  const segment = (fields: Partial<Transcript["segments"][number]>) => ({ start: 0, end: 0, text: "", words: [], ...fields });

  it("gives each word its segment's speaker unless the word has its own", () => {
    const t = { mediaId: "m", segments: [segment({ speaker: "A", words: [{ text: "Hi", start: 0, end: 1 }, { text: "there", start: 1, end: 2, speaker: "B" }] })] } as Transcript;
    expect(flattenWords(t)).toEqual([{ text: "Hi", start: 0, end: 1, speaker: "A" }, { text: "there", start: 1, end: 2, speaker: "B" }]);
  });

  it("spaces a segment's words evenly when it has no word timings, and skips an empty segment", () => {
    const t = { mediaId: "m", segments: [
      segment({ start: 10, end: 13, text: "  one two\ttwo-and-a-half   three ", speaker: "A" }),
      segment({ start: 20, end: 21, text: "   " }),
    ] } as Transcript;
    expect(flattenWords(t)).toEqual([
      { text: "one", start: 10, end: 10.75, speaker: "A" }, { text: "two", start: 10.75, end: 11.5, speaker: "A" },
      { text: "two-and-a-half", start: 11.5, end: 12.25, speaker: "A" }, { text: "three", start: 12.25, end: 13, speaker: "A" },
    ]);
  });

  it("puts every word in time order, whatever order the segments came in", () => {
    const t = { mediaId: "m", segments: [segment({ words: [{ text: "later", start: 5, end: 6 }] }), segment({ start: 0, end: 2, text: "at first" })] } as Transcript;
    expect(flattenWords(t).map(w => w.text)).toEqual(["at", "first", "later"]);
  });
});

describe("phrase search", () => {
  const spoken = words("Well, I DON'T think that’s right — is it? I don't think so.", "A");

  it("ignores case, punctuation and apostrophes, and finds every place the phrase is said", () => {
    expect(normalizeTranscriptToken("Don’t!")).toBe("dont");
    expect(normalizeTranscriptToken("café—au-lait")).toBe("caféaulait");
    expect(normalizeTranscriptToken("—")).toBe("");
    const found = searchTranscript(spoken, "i dont THINK", 2);
    expect(found.map(m => [m.wordIndex, m.start, m.end, m.text])).toEqual([[1, 1, 3.5, "I DON'T think"], [9, 9, 11.5, "I don't think"]]);
    expect(found[0]).toMatchObject({ speaker: "A", context: "Well, [ I DON'T think ] that’s right" });
    expect(found[1]!.context).toBe("is it? [ I don't think ] so.");
  });

  it("finds nothing for an empty phrase, one of only punctuation, or one longer than the transcript", () => {
    expect(searchTranscript(spoken, "")).toEqual([]);
    expect(searchTranscript(spoken, " — ?! ")).toEqual([]);
    expect(searchTranscript(words("too short"), "too short by far")).toEqual([]);
    expect(searchTranscript([], "anything")).toEqual([]);
  });

  it("searches an index built once as it would the words", () => {
    const search = indexTranscriptWords(spoken);
    expect(search("think so")).toEqual(searchTranscript(spoken, "think so"));
    expect(search("think", 0).map(m => m.context)).toEqual(["[ think ]", "[ think ]"]);
  });
});

describe("sequenceSimilarity", () => {
  it("is 1 for the same words, 0 for none shared or nothing to compare, and counts near-spellings as the same", () => {
    expect(sequenceSimilarity(["we", "should", "go"], ["we", "should", "go"])).toBe(1);
    expect(sequenceSimilarity(["we", "should", "go"], ["they", "left"])).toBe(0);
    expect(sequenceSimilarity([], ["go"])).toBe(0);
    expect(sequenceSimilarity(["go"], [])).toBe(0);
    expect(sequenceSimilarity(["favourite", "colour"], ["favorite", "color"])).toBe(1);
  });

  it("scores shared words in order, twice the common run over both lengths", () => {
    expect(sequenceSimilarity(["a", "b", "c", "d"], ["a", "x", "c", "d"])).toBe(0.75);
    expect(sequenceSimilarity(["a", "b"], ["a", "b", "c", "d"])).toBeCloseTo(2 / 3, 10);
    // Order matters: the same two words swapped share a run of one.
    expect(sequenceSimilarity(["alpha", "bravo"], ["bravo", "alpha"])).toBe(0.5);
  });
});

describe("fuzzy phrase search", () => {
  const spoken = words("so the first thing we wanted to build was a recogniser for interviews and then the second thing we built was search");

  it("finds a paraphrase or a different spelling, best match first, and scores an exact phrase 1", () => {
    const exact = fuzzySearchTranscript(spoken, "wanted to build");
    expect(exact[0]).toMatchObject({ text: "wanted to build", wordIndex: 5, start: 5, end: 7.5, score: 1 });
    const loose = fuzzySearchTranscript(spoken, "a recognizer for interview");
    expect(loose[0]).toMatchObject({ text: "a recogniser for interviews", score: 1 });
    expect(loose[0]!.context).toBe("thing we wanted to build was [ a recogniser for interviews ] and then the second thing we");
    const paraphrase = fuzzySearchTranscript(spoken, "the second thing built was search");
    expect(paraphrase[0]!.text).toBe("the second thing we built was search");
    expect(paraphrase[0]!.score).toBeGreaterThan(0.9);
  });

  it("returns matches that don't overlap, no more than the limit, and none below the score asked for", () => {
    const things = fuzzySearchTranscript(spoken, "thing we");
    expect(things.map(m => m.wordIndex)).toEqual([3, 17]);
    expect(fuzzySearchTranscript(spoken, "thing we", { limit: 1 })).toHaveLength(1);
    expect(fuzzySearchTranscript(spoken, "thing we", { limit: 0 })).toEqual([]);
    expect(fuzzySearchTranscript(spoken, "thing we", { contextWords: 1 })[0]!.context).toBe("first [ thing we ] wanted");
    expect(fuzzySearchTranscript(spoken, "completely unrelated words")).toEqual([]);
    expect(fuzzySearchTranscript(spoken, "the first banana", { minScore: 0.9 })).toEqual([]);
    expect(fuzzySearchTranscript(spoken, "the first banana", { minScore: 0.6 })[0]!.wordIndex).toBe(1);
    expect(fuzzySearchTranscript(spoken, " ?! ")).toEqual([]);
    expect(fuzzySearchTranscript([], "thing")).toEqual([]);
  });
});
