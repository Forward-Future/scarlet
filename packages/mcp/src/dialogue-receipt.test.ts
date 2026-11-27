import { describe, expect, it } from "vitest";
import { fitRepeatPage, receiptChanges, receiptEdit, receiptGate, receiptOnFrames, shortWords, thousandthsText } from "./dialogue-receipt.js";

describe("dialogue_apply_cuts receipt", () => {
  it("names each saved edit by its summary and range, without the model's reason or the summary twice", () => {
    const summary = "Cut false start ‘And at that time, they put out’ before ‘and at that time, they all said’";
    expect(receiptEdit({ label: summary, summary, range: { start: 33.70033333333333, end: 33.70033333333333 },
      reason: "Removes the abandoned start so the sentence opens on the completed line.", check: "Listen to the join" }))
      .toEqual({ summary, range: { start: 33.7, end: 33.7 }, check: "Listen to the join" });
    // An earlier edit with no summary is named by its label.
    expect(receiptEdit({ label: "Cut a pause", range: { start: 1.23456, end: 2 } })).toEqual({ label: "Cut a pause", range: { start: 1.235, end: 2 } });
    const [change] = receiptChanges([{ id: "chg_1", state: "approved", fromVersion: "a", toVersion: "b", description: "Cut 6 s across 2 cuts.", intent: "requested",
      timelineEdits: [{ label: summary, summary, range: { start: 1, end: 1 }, reason: "Why" }] }]);
    expect(change).toEqual({ id: "chg_1", state: "approved", fromVersion: "a", toVersion: "b", description: "Cut 6 s across 2 cuts.", intent: "requested",
      timelineEdits: [{ summary, range: { start: 1, end: 1 } }] });
  });

  it("gives a long removal named by indices by its first and last words, and Scarlet's reading of seconds whole", () => {
    const long = "And so the company meter, and so the company meter, which is an, so the company meter, so,";
    expect(shortWords(long)).toBe("And so the company meter, and … an, so the company meter, so,");
    expect(shortWords("and got got nearly unfettered at,")).toBe("and got got nearly unfettered at,");
    const gate = receiptGate({ unchangedCuts: 0, decisions: [{ cut: 0, words: long, outcome: "cut" }, { cut: 1, removes: long, plays: "… a ‖ b …" }] });
    expect(gate.decisions).toEqual([{ cut: 0, words: "And so the company meter, and … an, so the company meter, so,", outcome: "cut" }, { cut: 1, removes: long, plays: "… a ‖ b …" }]);
  });

  it("says why cuts moved onto whole frames on the first save only", () => {
    const onFrames = { cuts: 4, largestShift: 0.014, why: "Cuts are saved on whole frames at 29.97 fps." };
    expect(receiptOnFrames(onFrames, false)).toEqual(onFrames);
    expect(receiptOnFrames(onFrames, true)).toEqual({ cuts: 4, largestShift: 0.014 });
    expect(receiptOnFrames(undefined, true)).toBeUndefined();
  });
});

describe("results within resultChars", () => {
  it("gives a JSON part's seconds to the millisecond and leaves other text alone", () => {
    expect(thousandthsText('{"start":154.92130908417218,"index":3,"words":[[658.8800000000001,659.48,"hands-on,"]],"db":-45}'))
      .toBe('{"start":154.921,"index":3,"words":[[658.88,659.48,"hands-on,"]],"db":-45}');
    expect(thousandthsText("Open this WAV file at 1.23456 s")).toBe("Open this WAV file at 1.23456 s");
    expect(thousandthsText("{not json")).toBe("{not json");
  });

  it("pages the repeat check's lists together in fewer than 25 when they don't fit", () => {
    const pair = (i: number) => ({ id: `rep_${i}`, phrase: "and so the company meter which is a well regarded", first: { start: i, end: i + 1 }, second: { start: i + 2, end: i + 3 } });
    const result = { version: "v1", remaining: 40, repeats: Array.from({ length: 25 }, (_, i) => pair(i)), fragments: [{ id: "frag_1" }],
      silences: Array.from({ length: 3 }, (_, i) => ({ id: `sil_${i}` })), nextOffset: 25 };
    const page = fitRepeatPage(result, 25, 2000);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(2000);
    expect(page.repeats!.length).toBeLessThan(25);
    expect(page.repeats).toEqual(result.repeats.slice(0, page.repeats!.length));
    // The next page starts after what this one shows; the lists not paged by offset stay whole.
    expect(page.nextOffset).toBe(25 + page.repeats!.length);
    expect(page.fragments).toEqual(result.fragments);
    expect(page.silences).toEqual(result.silences);
    expect(fitRepeatPage(result, 25, 100_000)).toBe(result);
  });
});
