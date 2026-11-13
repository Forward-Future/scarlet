import { describe, expect, it } from "vitest";
import { describeGapSound, gapSound, speakingLevel, type GapLevels } from "./gap-sound.js";

/** Ten seconds at 50 levels a second: speech at .1, room tone at .001, and whatever `at` says in between. */
function levels(at: (t: number) => number | undefined): GapLevels {
  const speech = [[0, 2.9], [4.6, 9]];
  return { from: 0, to: 10, rms: Array.from({ length: 500 }, (_, i) => {
    const t = (i + .5) / 50;
    return at(t) ?? (speech.some(([a, b]) => a! <= t && t < b!) ? .1 : .001);
  }) };
}

describe("what sounds between two words", () => {
  it("finds speech the transcript left out of a gap, and calls an empty gap quiet", () => {
    // “You can” ends at 2.9 s and “see” starts at 4.6 s. In between: a first “see” and a second “you can”.
    const said = levels(t => (t >= 3.1 && t < 3.5) || (t >= 4.2 && t < 4.5) ? .08 : undefined);
    expect(speakingLevel(said)).toBe(-20);
    const sound = gapSound(said, { start: 2.9, end: 4.6 })!;
    expect(sound).toEqual({ seconds: .7, runs: [{ start: 3.1, end: 3.5 }, { start: 4.2, end: 4.5 }] });
    expect(describeGapSound(sound)).toBe("0.70 s of it sound at speaking level that no word explains (3.10–3.50, 4.20–4.50)");
    expect(describeGapSound(gapSound(levels(() => undefined), { start: 2.9, end: 4.6 })!)).toBe("quiet");
  });

  it("leaves out a sibilant's hiss, a click and each word's own edge", () => {
    // Hiss at -44 dBFS through the gap, a 40 ms click, and the words' sound running 40 ms past their timings.
    const hiss = levels(t => t >= 2.9 && t < 2.94 ? .1 : t >= 4.56 && t < 4.6 ? .1 : t >= 3.7 && t < 3.74 ? .2 : t >= 2.94 && t < 4.56 ? .006 : undefined);
    expect(gapSound(hiss, { start: 2.9, end: 4.6 })).toEqual({ seconds: 0, runs: [] });
    // Levels that do not reach the gap say nothing either way.
    expect(gapSound(hiss, { start: 9.5, end: 10.5 })).toBeUndefined();
  });
});
