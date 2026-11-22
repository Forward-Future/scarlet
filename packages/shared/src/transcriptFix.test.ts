import { describe, expect, it } from "vitest";
import type { Transcript } from "@scarlet/timeline";
import { applyWordFix, applyWordFixes } from "./transcriptFix.js";
import { flattenWords } from "./transcriptSearch.js";

function transcript(...lines: Array<Array<[string, number, number]>>): Transcript {
  return { id: "t", mediaId: "m", segments: lines.map((words, i) => ({ id: `s${i}`, start: words[0]![1], end: words.at(-1)![2],
    text: words.map(w => w[0]).join(" "), words: words.map(([text, start, end]) => ({ text, start, end, speaker: "A" })) })) };
}
const texts = (t: Transcript) => flattenWords(t).map(w => w.text);

describe("applyWordFix", () => {
  const t = transcript(
    [["Welcome", 0, .4], ["to", .4, .5], ["Scarlett.", .5, 1]],
    [["Scarlett's", 2, 2.6], ["editor", 2.6, 3], ["is", 3, 3.1], ["scarlett,", 3.1, 3.5], ["new", 4, 4.2], ["ra", 4.2, 4.5]],
  );

  it("replaces every place with its times, punctuation, possessive and sentence case", () => {
    const { transcript: out, places, wordsAdded } = applyWordFix(t, { find: "scarlett", replace: "scarlet" });
    expect(texts(out)).toEqual(["Welcome", "to", "Scarlet.", "Scarlet's", "editor", "is", "scarlet,", "new", "ra"]);
    expect(places.map(p => [p.index, p.start, p.end, p.before, p.after])).toEqual([
      [2, .5, 1, "Scarlett.", "Scarlet."], [3, 2, 2.6, "Scarlett's", "Scarlet's"], [6, 3.1, 3.5, "scarlett,", "scarlet,"]]);
    expect(wordsAdded).toBe(0);
    expect(flattenWords(out).map(w => [w.start, w.end])).toEqual(flattenWords(t).map(w => [w.start, w.end]));
    expect(out.segments[0]!.text).toBe("Welcome to Scarlet.");
    expect(flattenWords(out)[2]!.speaker).toBe("A");
  });

  it("joins a phrase into fewer words over the same stretch", () => {
    const { transcript: out, places, wordsAdded } = applyWordFix(t, { find: "new ra", replace: "Neura" });
    expect(texts(out).slice(-2)).toEqual(["scarlett,", "Neura"]);
    expect(flattenWords(out).at(-1)).toMatchObject({ start: 4, end: 4.5 });
    expect(places).toEqual([{ index: 7, start: 4, end: 4.5, before: "new ra", after: "Neura" }]);
    expect(wordsAdded).toBe(-1);
  });

  it("keeps to a range, and leaves words that already read the fix", () => {
    expect(applyWordFix(t, { find: "Scarlett", replace: "Scarlet", from: 1.5, to: 3 }).places.map(p => p.index)).toEqual([3]);
    expect(applyWordFix(t, { find: "welcome", replace: "Welcome" }).places).toEqual([]);
    expect(applyWordFix(t, { find: "missing", replace: "x" }).transcript).toBe(t);
  });

  it("applies saved fixes in order to a transcription made again", () => {
    const fixes = [{ find: "scarlett", replace: "Scarlet" }, { find: "new ra", replace: "Neura" }];
    const out = applyWordFixes(t, fixes);
    expect(texts(out)).toEqual(["Welcome", "to", "Scarlet.", "Scarlet's", "editor", "is", "Scarlet,", "Neura"]);
    expect(out.wordFixes).toEqual(fixes);
    expect(applyWordFixes(t, undefined)).toBe(t);
  });
});
