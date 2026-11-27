import { describe, expect, it } from "vitest";
import { EXACT_WORD_TIMES, LINE_WORDS, shortSeconds, transcriptWordLines, type LineWord } from "./word-lines.js";

/** `count` words a quarter second apart, each 0.2 s long, from `from` seconds. */
function said(count: number, from = 10, first = 0, speaker?: string): LineWord[] {
  return Array.from({ length: count }, (_, i) => ({ index: first + i, start: from + i * .25, end: from + i * .25 + .2, text: `w${first + i}`, ...(speaker && { speaker }) }));
}
const read = (words: LineWord[], notes = new Map<number, string>()) =>
  transcriptWordLines(words, { note: w => notes.get(w.index), said: w => w.text, gapSeconds: .4 });

describe("word lines", () => {
  it("gives times to the hundredth with no trailing zeros", () => {
    expect([580.1, 583, 563.76, 0, 1.006, 12.999, 0.001].map(shortSeconds)).toEqual(["580.1", "583", "563.76", "0", "1.01", "13", "0"]);
  });

  it("keeps every word's index and says a line's start once, opening a line after a gap, a sentence and every few words", () => {
    const words = said(30, 10, 100, "Speaker 1");
    words[4]!.text = "end.";
    // A gap of 0.55 s before #110 that the levels describe, and one of 0.45 s before #120 they don't.
    for (const w of words.slice(10)) { w.start += .5; w.end += .5; }
    for (const w of words.slice(20)) { w.start += .4; w.end += .4; }
    const lines = read(words, new Map([[110, "  · 0.55 s gap, quiet"]]));
    expect(lines).toEqual([
      "10 #100 Speaker 1: w100 #101 w101 #102 w102 #103 w103 #104 end.",
      "11.25 #105 w105 #106 w106 #107 w107 #108 w108 #109 w109",
      "  · 0.55 s gap, quiet",
      "13 #110 w110 #111 w111 #112 w112 #113 w113 #114 w114 #115 w115 #116 w116 #117 w117 #118 w118 #119 w119",
      "  · 0.45 s gap, levels unread",
      "15.9 #120 w120 #121 w121 #122 w122 #123 w123 #124 w124 #125 w125 #126 w126 #127 w127 #128 w128 #129 w129",
    ]);
    // Every word is there once, by its index.
    expect([...lines.join(" ").matchAll(/#(\d+) /g)].map(m => Number(m[1]))).toEqual(words.map(w => w.index));
  });

  it("opens a line every LINE_WORDS words and names a speaker only where it changes", () => {
    const words = said(EXACT_WORD_TIMES + 10, 0, 0, "Speaker 1");
    for (const w of words.slice(LINE_WORDS + 3)) w.speaker = "Speaker 2";
    delete words[LINE_WORDS + 5]!.speaker; // A word with no label doesn't end the speaker's turn.
    const lines = read(words);
    expect(lines[0]!.split(" #")).toHaveLength(LINE_WORDS + 1);
    expect(lines[0]).toMatch(/^0 #0 Speaker 1: w0 #1 w1 /);
    expect(lines[1]).toBe(`3 #${LINE_WORDS} w${LINE_WORDS} #13 w13 #14 w14`);
    expect(lines[2]).toMatch(/^3.75 #15 Speaker 2: w15 #16 w16 #17 w17 #18 w18/);
    expect(lines.join("\n").match(/Speaker/g)).toHaveLength(2);
  });

  it("gives every word its own start and end on a short page", () => {
    const words = said(3, 2, 7, "Speaker 1");
    expect(read(words, new Map([[8, "  · 0.05 s gap, quiet"]]))).toEqual(["#7 2-2.2 Speaker 1: w7", "  · 0.05 s gap, quiet", "#8 2.25-2.45 w8", "#9 2.5-2.7 w9"]);
    expect(read(said(EXACT_WORD_TIMES))).toHaveLength(EXACT_WORD_TIMES);
    expect(read(said(EXACT_WORD_TIMES + 1)).length).toBeLessThan(EXACT_WORD_TIMES);
  });
});
