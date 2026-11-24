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

  it("matches a find that has its own 's, and keeps the 's only after the last word", () => {
    const said = transcript([["Scarlett's", 0, .6], ["editor", .6, 1], ["says", 1, 1.3], ["it's", 1.3, 1.6], ["new", 1.6, 1.9],
      ["ra,", 1.9, 2.2], ["and", 2.2, 2.5], ["that's", 2.5, 2.9], ["fine.", 2.9, 3.4]]);
    const fixed = (find: string, replace: string) => applyWordFix(said, { find, replace }).places.map(p => [p.before, p.after]);
    expect(fixed("Scarlett's", "Scarlet's")).toEqual([["Scarlett's", "Scarlet's"]]);
    expect(fixed("Scarlett", "Scarlet")).toEqual([["Scarlett's", "Scarlet's"]]);
    expect(fixed("it's", "its")).toEqual([["it's", "its"]]);
    expect(fixed("it's", "it is")).toEqual([["it's", "it is"]]);
    expect(fixed("it's new", "its new")).toEqual([["it's new", "its new"]]);
    expect(fixed("it's new ra", "it's Neura")).toEqual([["it's new ra,", "it's Neura,"]]);
    expect(fixed("that fine", "this fine")).toEqual([]);
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

describe("applyWordFix where the transcript already reads the fix", () => {
  it("leaves a place alone that already says the longer replacement, so the fix doesn't double a word", () => {
    const said = transcript([["Claude", 0, .5], ["Code", .5, 1], ["and", 1, 1.2], ["Claude", 1.2, 2], ["code.", 2, 2.5], ["Claude", 3, 3.5]]);
    const { transcript: out, places, wordsAdded } = applyWordFix(said, { find: "Claude", replace: "Claude Code" });
    // The one that says it in lower case reads the fix's case, word for word, as any other place would.
    expect(texts(out)).toEqual(["Claude", "Code", "and", "Claude", "Code.", "Claude", "Code"]);
    expect(places.map(p => [p.index, p.before, p.after])).toEqual([[3, "Claude code.", "Claude Code."], [5, "Claude", "Claude Code"]]);
    expect(wordsAdded).toBe(1);
    // The same fix made again changes nothing, and so does one whose find ends the replacement.
    expect(applyWordFix(out, { find: "Claude", replace: "Claude Code" }).places).toEqual([]);
    expect(applyWordFix(out, { find: "code", replace: "Claude Code" }).places).toEqual([]);
  });
});
