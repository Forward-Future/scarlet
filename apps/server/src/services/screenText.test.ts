import { describe, expect, it } from "vitest";
import { findBoxes, letterClasses, overlap, readLetters, type ScreenLine } from "../transcribe/screenTextModel.js";
import { joinSpans, pictureChanged, pictureGrid, sameLine, screenTextMatches, spansFromFrames, type ScreenTextSpan } from "./screenText.js";

const line = (text: string, box: ScreenLine["box"], confidence = 0.95): ScreenLine => ({ text, confidence, box });

describe("choosing which frames to read", () => {
  const frame = (paint?: (x: number, y: number) => number) => {
    const rgb = Buffer.alloc(320 * 180 * 3, 30);
    if (paint) for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const v = paint(x, y);
      if (v >= 0) rgb.fill(v, (y * 320 + x) * 3, (y * 320 + x) * 3 + 3);
    }
    return rgb;
  };

  it("reads a frame again when a word appears, and not for the same picture", () => {
    const still = pictureGrid(frame(), 320, 180);
    expect(pictureChanged(still, pictureGrid(frame(), 320, 180))).toBe(false);
    // A word about 6 by 4 pixels of white in one 10-pixel cell of a 320-wide frame.
    const typed = pictureGrid(frame((x, y) => x >= 100 && x < 106 && y >= 50 && y < 54 ? 255 : -1), 320, 180);
    expect(pictureChanged(still, typed)).toBe(true);
  });
});

describe("turning readings into spans", () => {
  it("makes one span of a line read a little differently from frame to frame, kept in its fullest reading", () => {
    // On a real chart the reader dropped the first word of one formula in some frames and read a comma in others.
    const box: ScreenLine["box"] = [100, 50, 900, 70];
    const spans = spansFromFrames([
      { at: 10, lines: [line("Wnew = Wold - learning rate x gradient", box), line("Loss", [10, 10, 60, 30])] },
      { at: 11, lines: [line("= Wold - learning rate x gradient", [104, 50, 900, 70])] },
      { at: 12, lines: [line(", = Wold - learning rate x gradient", box)] },
      { at: 14, lines: [] },
    ], 20, 1000, 100);
    expect(spans).toEqual([
      { start: 10, end: 11, text: "Loss", confidence: 0.95, box: [0.01, 0.1, 0.06, 0.3] },
      { start: 10, end: 14, text: "Wnew = Wold - learning rate x gradient", confidence: 0.95, box: [0.1, 0.5, 0.9, 0.7] },
    ]);
  });

  it("keeps the same words in two places apart, lasts to the window's end, and leaves out unsure readings and stray marks", () => {
    const spans = spansFromFrames([{ at: 0, lines: [
      line("SoHo", [10, 10, 60, 20]), line("SoHo", [500, 10, 550, 20]),
      line("lll", [10, 40, 30, 50], 0.4), line("—", [10, 60, 30, 70]),
    ] }], 60, 1000, 100);
    expect(spans.map(s => [s.text, s.start, s.end, s.box[0]])).toEqual([["SoHo", 0, 60, 0.01], ["SoHo", 0, 60, 0.5]]);
  });

  it("joins a line that runs across two windows into one span, and not one that left between them", () => {
    const a: ScreenTextSpan = { start: 40, end: 60, text: "Settings", confidence: 0.9, box: [0.1, 0.1, 0.2, 0.12] };
    const b: ScreenTextSpan = { start: 60, end: 75, text: "Settings", confidence: 0.97, box: [0.1, 0.1, 0.2, 0.12] };
    const later: ScreenTextSpan = { start: 90, end: 95, text: "Settings", confidence: 0.9, box: [0.1, 0.1, 0.2, 0.12] };
    expect(joinSpans([later, b, a])).toEqual([{ ...a, end: 75, confidence: 0.97 }, later]);
  });

  it("tells one line from another by place and words", () => {
    const at = (text: string, box: ScreenTextSpan["box"]) => ({ text, box });
    expect(sameLine(at("Bathroom weight", [0.1, 0.1, 0.3, 0.12]), at("Bathroom weiqht", [0.1, 0.1, 0.3, 0.12]))).toBe(true);
    expect(sameLine(at("Bathroom weight", [0.1, 0.1, 0.3, 0.12]), at("Location weight", [0.1, 0.1, 0.3, 0.12]))).toBe(false);
    expect(sameLine(at("Bathroom weight", [0.1, 0.1, 0.3, 0.12]), at("Bathroom weight", [0.5, 0.1, 0.7, 0.12]))).toBe(false);
  });

  it("finds words whatever their case, punctuation or spacing", () => {
    expect(screenTextMatches("Wnew = Wold - learning rate x gradient", "Learning  rate")).toBe(true);
    expect(screenTextMatches("$1,480,000", "1 480 000")).toBe(true);
    expect(screenTextMatches("Size weight", "rate")).toBe(false);
    expect(screenTextMatches("anything", "  ")).toBe(false);
  });
});

describe("reading a frame", () => {
  it("draws a box round each patch of text in the finder's map, grown to take in the letters' edges", () => {
    const map = new Float32Array(40 * 20);
    for (let y = 5; y < 9; y++) for (let x = 4; x < 20; x++) map[y * 40 + x] = 0.9;
    // A faint patch, too unsure to be text, and a single bright pixel.
    for (let y = 12; y < 16; y++) for (let x = 25; x < 35; x++) map[y * 40 + x] = 0.4;
    map[18 * 40 + 2] = 1;
    const [box, ...rest] = findBoxes(map, 40, 20);
    expect(rest).toEqual([]);
    // 16 by 4 pixels grow by 16 × 4 × 1.5 / 40 = 2.4 on each side.
    expect(box).toEqual({ x0: 1.6, y0: 2.6, x1: 22.4, y1: 11.4 });
    expect(overlap([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3);
  });

  it("reads letters from the reader's scores, dropping blanks and repeats", () => {
    const letters = letterClasses("a\nb\nc\n");
    expect(letters).toEqual(["", "a", "b", "c", " "]);
    // Steps: a a blank a b space c, over five classes.
    const best = [1, 1, 0, 1, 2, 4, 3];
    const scores = new Float32Array(best.length * 5).fill(0.01);
    best.forEach((c, t) => { scores[t * 5 + c] = 0.9; });
    expect(readLetters(scores, 0, best.length, 5, letters)).toEqual({ text: "aab c", confidence: expect.closeTo(0.9, 5) });
  });
});
