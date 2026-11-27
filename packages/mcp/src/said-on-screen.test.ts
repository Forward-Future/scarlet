import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "@scarlet/timeline";
import type { ScreenLine } from "./screen-reading.js";
import { SAID_ON_SCREEN_LISTED, referenceAtSecondary, saidOnScreen, secondaryAtReference } from "./said-on-screen.js";

const said = (text: string, start: number, step = 0.3): TranscriptWord[] =>
  text.split(" ").map((word, i) => ({ text: word, start: start + i * step, end: start + i * step + 0.25 }) as TranscriptWord);
const line = (text: string, start = 0, end = 600): ScreenLine => ({ start, end, text, box: [0.1, 0.4, 0.9, 0.45] });

describe("secondaryAtReference and referenceAtSecondary", () => {
  it("shift by a single match's or a constant sync's offset, both ways", () => {
    for (const fit of [{ kind: "match" as const, offset: 12 }, { kind: "constant" as const, offset: 12 }]) {
      expect(secondaryAtReference(fit)!(20)).toBe(8);
      expect(referenceAtSecondary(fit)!(8)).toBe(20);
    }
  });

  it("follow a drifting clock and return to the same second", () => {
    // The secondary starts 5 s into the reference and gains 60 ms a minute.
    const fit = { kind: "drift" as const, offsetAtStart: 5, msPerMinute: 60, secondarySpeed: 1 };
    const reference = referenceAtSecondary(fit)!;
    const secondary = secondaryAtReference(fit)!;
    expect(reference(0)).toBe(5);
    expect(reference(600)).toBeCloseTo(605.6, 9);
    expect(secondary(605.6)).toBeCloseTo(600, 9);
    expect(secondary(reference(1234)!)).toBeCloseTo(1234, 9);
  });

  it("place a second only in or near a step's part", () => {
    const fit = { kind: "steps" as const, parts: [{ from: 0, to: 100, offset: 10, points: 4 }, { from: 200, to: 300, offset: 40, points: 4 }] };
    const reference = referenceAtSecondary(fit)!;
    const secondary = secondaryAtReference(fit)!;
    expect(reference(50)).toBe(60);
    expect(reference(250)).toBe(290);
    // Up to 15 s either side of a part still counts as that part.
    expect(reference(114)).toBe(124);
    expect(reference(150)).toBeUndefined();
    expect(secondary(60)).toBe(50);
    expect(secondary(290)).toBe(250);
    expect(secondary(175)).toBeUndefined();
  });

  it("give no mapping for an unclear sync", () => {
    const fit = { kind: "unclear" as const, reason: "No passage matched." };
    expect(secondaryAtReference(fit)).toBeUndefined();
    expect(referenceAtSecondary(fit)).toBeUndefined();
  });
});

describe("saidOnScreen", () => {
  const quote = "leave your lineage pure do not investigate";

  it("finds the words said that are on the other recording's screen, in both recordings' seconds", () => {
    const speech = { id: "camera", words: [...said("so it told me this", 1), ...said(quote, 30)] };
    // The screen recording starts 20 s after the camera: its 10 s is the camera's 30 s.
    const picture = { id: "screen", lines: [line("Leave your Lineage pure: do not investigate", 5, 20), line("Settings")], duration: 600 };
    const result = saidOnScreen(speech, picture, t => t - 20);
    expect(result).toMatchObject({ speech: "camera", picture: "screen", readings: 1 });
    expect(result.more).toBeUndefined();
    expect(result.list).toHaveLength(1);
    expect(result.list[0]!.said).toBe(quote);
    expect(result.list[0]!.from).toBe(30);
    expect(result.list[0]!.to).toBe(32.05);
    expect(result.list[0]!.pictureAt[0]).toBeCloseTo(10, 2);
    expect(result.list[0]!.pictureAt[1]).toBeCloseTo(12.05, 2);
  });

  it("finds nothing where the picture isn't playing as the words are said", () => {
    const speech = { id: "camera", words: [...said(quote, 5), ...said(quote, 100)] };
    const picture = { id: "screen", lines: [line(quote)], duration: 50 };
    // 5 s in the camera is before the screen recording starts, and 100 s is after it ends.
    expect(saidOnScreen(speech, picture, t => t - 10)).toEqual({ speech: "camera", picture: "screen", readings: 0, list: [] });
    // A sync that places no second there finds nothing either.
    expect(saidOnScreen(speech, picture, () => undefined).readings).toBe(0);
  });

  it("finds a reading in each part of a stepped sync and none in the jump between", () => {
    const fit = { kind: "steps" as const, parts: [{ from: 0, to: 40, offset: 10, points: 3 }, { from: 100, to: 140, offset: 30, points: 3 }] };
    const pictureAt = secondaryAtReference(fit)!;
    const speech = { id: "camera", words: [...said(quote, 20), ...said(quote, 90), ...said(quote, 150)] };
    const result = saidOnScreen(speech, { id: "screen", lines: [line(quote)], duration: 600 }, pictureAt);
    expect(result.list.map(r => r.from)).toEqual([20, 150]);
    expect(result.list.map(r => r.pictureAt[0])).toEqual([10, 120]);
  });

  it("uses the picture's second at a word's middle when its start falls outside the sync", () => {
    // The first word starts just before the sync places the picture, and its middle is just after.
    const words = said(quote, 9.9);
    words[0] = { ...words[0]!, end: 10.3 };
    const result = saidOnScreen({ id: "camera", words }, { id: "screen", lines: [line(quote)], duration: 600 }, t => (t >= 10 ? t - 10 : undefined));
    expect(result.readings).toBe(1);
    expect(result.list[0]!.pictureAt[0]).toBeCloseTo(0.1, 2);
  });

  it("shortens a long passage to 100 characters", () => {
    const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
    expect(long.length).toBeGreaterThan(100);
    const result = saidOnScreen({ id: "camera", words: said(long, 0) }, { id: "screen", lines: [line(long)], duration: 600 }, t => t);
    const text = result.list[0]!.said;
    expect(text).toHaveLength(98);
    expect(text.endsWith("…")).toBe(true);
    expect(long.startsWith(text.slice(0, 97))).toBe(true);
  });

  it("lists the first readings and counts the rest", () => {
    const count = SAID_ON_SCREEN_LISTED + 3;
    const words = Array.from({ length: count }, (_, i) => said(quote, i * 10)).flat();
    const result = saidOnScreen({ id: "camera", words }, { id: "screen", lines: [line(quote, 0, 1000)], duration: 1000 }, t => t);
    expect(result.readings).toBe(count);
    expect(result.list).toHaveLength(SAID_ON_SCREEN_LISTED);
    expect(result.more).toBe(3);
    expect(result.list.at(-1)!.from).toBe((SAID_ON_SCREEN_LISTED - 1) * 10);
  });
});
