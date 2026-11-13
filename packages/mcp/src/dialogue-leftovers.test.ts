import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "@scarlet/timeline";
import { partLeftovers } from "./dialogue-leftovers.js";
import type { TimelineWord } from "./timeline-perception.js";

/** A recording played from its start, so timeline and source seconds agree. Each word is 0.3 s long. */
function said(line: Array<[text: string, start: number]>) {
  const source: TranscriptWord[] = line.map(([text, start]) => ({ text, start, end: start + .3 }));
  const words: TimelineWord[] = source.map((w, index) => ({ mediaId: "mic", index, text: w.text, start: w.start, end: w.end }));
  return { words, transcripts: new Map([["mic", source]]) };
}

describe("what a saved part still plays", () => {
  it("lists a pause by how long it plays with the cuts out, and names the word that trims an untouched one", () => {
    const { words, transcripts } = said([["one", 0], ["two", .4], ["three", 2], ["four", 5.3], ["five", 5.7], ["six", 6.6]]);
    // “two” to “three” plays 1.3 s untouched. “three” to “four” was 3 s and a cut leaves 1 s of it. “five” to “six” is 0.6 s.
    const { pauses } = partLeftovers(words, [{ start: 2.8, end: 4.8 }], [], transcripts);
    expect(pauses).toEqual([
      { mediaId: "mic", source: { start: .7, end: 2 }, seconds: 1.3, after: "two", before: "three", afterWord: 1 },
      { mediaId: "mic", source: { start: 2.3, end: 5.3 }, seconds: 1, after: "three", before: "four" },
    ]);
    // Trimmed to the beat it is gone, and a pause the part chose to keep is not brought up again.
    expect(partLeftovers(words, [{ start: 2.45, end: 5.2 }], [{ start: .8, end: 1.9 }], transcripts).pauses).toEqual([]);
  });

  it("reports a long phrase doubled by a ripple on the clock of the saved part", () => {
    const phrase = "listen for the bell at noon".split(" ");
    const take = (start: number): Array<[string, number]> => phrase.map((text, i) => [text, start + .4 * i]);
    const { words, transcripts } = said([...take(1), ...take(63), ["tomorrow.", 65.4]]);
    // There is a minute between takes in the recording, one second once the cut is out.
    expect(partLeftovers(words, [], [], transcripts).repeats).toEqual([]);
    expect(partLeftovers(words, [{ start: 3.5, end: 62.2 }], [], transcripts).repeats).toEqual([
      { mediaId: "mic", source: 1, fromWord: 0, toWord: 5, text: [...phrase, ...phrase].join(" "), atJoin: true },
    ]);
  });

  it("finds words said twice in a row, a restart the part left and a word its own join doubled", () => {
    const { words, transcripts } = said([["here's", 0], ["the", .35], ["plate", .7], ["here's", 1.2], ["the", 1.55], ["plate.", 1.9],
      ["It", 2.4], ["is", 2.8], ["uh", 3.2], ["is", 3.6], ["good.", 4], ["Good", 4.5], ["then.", 4.9]]);
    // The cut takes “uh” out and leaves “is is”.
    const { repeats } = partLeftovers(words, [{ start: 3.15, end: 3.55 }], [], transcripts);
    expect(repeats).toEqual([
      { mediaId: "mic", source: 0, text: "here's the plate here's the plate.", fromWord: 0, toWord: 2, atJoin: false },
      { mediaId: "mic", source: 2.8, text: "is is", fromWord: 7, toWord: 7, atJoin: true },
    ]);
    // “good. Good” ends one sentence and starts the next. With the first saying cut, nothing repeats.
    expect(partLeftovers(words, [{ start: -1, end: 1.1 }, { start: 2.75, end: 3.55 }], [], transcripts).repeats).toEqual([]);
  });
});
