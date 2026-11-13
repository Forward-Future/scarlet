import { describe, expect, it } from "vitest";
import { wordSelection } from "../src/wordEdges.ts";

describe("reference-selected word removals", () => {
  const times = [.5, 1.2, 1.7, 2.5];
  const join = { finalTime: 1, earliestFinal: .98, latestFinal: 1.02, rawOut: 1, rawIn: 2 };
  it("scores a forward removal only when its complete set of word labels survives the boundary uncertainty", () => {
    expect(wordSelection(times, join, 1 / 30)).toEqual({ fromWord: 1, toWord: 2 });
    expect(wordSelection(times, { ...join, rawOut: 1.21 }, 1 / 30)).toBe("uncertain");
    expect(wordSelection(times, { ...join, rawIn: 1.5, highBandLatestFinal: 1.21 }, 1 / 30)).toBe("uncertain");
    expect(wordSelection(times, { ...join, rawOut: 1.16 }, 1 / 30)).toBe("uncertain");
    expect(wordSelection(times, { ...join, rawIn: .8 }, 1 / 30)).toBe("backward");
    expect(wordSelection(times, { ...join, rawIn: 1.1 }, 1 / 30)).toBe("pause");
    expect(wordSelection(times, { ...join, rawOut: .2 }, 1 / 30)).toBe("terminal");
  });
});
