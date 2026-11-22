import { describe, expect, it } from "vitest";
import { describeGapSound, gapSound, quietPhrases, quietRms, roomRms, speakingLevel, type GapLevels } from "./gap-sound.js";

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

  it("reads a range that starts on a level's edge, where rounding leaves the first level no width", () => {
    // 300 s at 20000 levels: the edge at 464.16 s computes as 464.15999999999997, the start the gate passed.
    const rms = Array.from({ length: 20000 }, (_, i) => { const t = 300 + (i + .5) * .015; return (t >= 464.24 && t < 464.37) || (t >= 464.52 && t < 464.85) ? .015 : .0005; });
    const start = 464.15999999999997;
    expect(300 + 10944 * .015).toBe(start);
    expect(gapSound({ from: 300, to: 600, rms }, { start, end: 465.1 }, -37, 0)!.runs.length).toBe(2);
  });

  it("leaves out a sibilant's hiss, a click and each word's own edge", () => {
    // Hiss at -44 dBFS through the gap, a 40 ms click, and the words' sound running 40 ms past their timings.
    const hiss = levels(t => t >= 2.9 && t < 2.94 ? .1 : t >= 4.56 && t < 4.6 ? .1 : t >= 3.7 && t < 3.74 ? .2 : t >= 2.94 && t < 4.56 ? .006 : undefined);
    expect(gapSound(hiss, { start: 2.9, end: 4.6 })).toEqual({ seconds: 0, runs: [] });
    // Levels that do not reach the gap say nothing either way.
    expect(gapSound(hiss, { start: 9.5, end: 10.5 })).toBeUndefined();
  });
});

describe("a voice over a noisy room", () => {
  /** A soft speaker (speech at .018, -35 dBFS) over noise at `noise`, which swings a few dB as noise does; `at` as in levels. */
  const room = (noise: number, at: (t: number) => number | undefined = () => undefined) => {
    const spoken = levels(t => at(t) ?? (t < 2.9 || t >= 4.6 ? .018 : undefined));
    return { ...spoken, rms: spoken.rms.map((v, i) => v === .001 ? noise * (1 + .15 * Math.sin(i * 1.7)) : v) };
  };

  it("doesn't take the noise in a pause for sound no word explains, and still finds a word said there", () => {
    // Pink noise 10 dB under the voice, at -42 dBFS: every pause of a pass read as holding sound, and none was trimmed (2026-11-22).
    const cafe = room(.008);
    expect(gapSound(cafe, { start: 2.9, end: 4.6 })).toEqual({ seconds: 0, runs: [] });
    const missed = room(.008, t => t >= 3.4 && t < 3.8 ? .018 : undefined);
    expect(gapSound(missed, { start: 2.9, end: 4.6 })!.runs).toEqual([{ start: 3.4, end: 3.8 }]);
  });

  it("keeps quiet under the level that counts as speech, so a word's soft end over the noise isn't quiet", () => {
    // Noise at -54 dBFS under a voice at -35: QUIET_RMS (-40 dBFS) alone let a word's end at -42 read as quiet.
    const noisy = room(.002);
    expect(20 * Math.log10(roomRms(noisy.rms, .02))).toBeCloseTo(-55.3, 0);
    expect(quietRms(noisy.rms, .02)).toBeLessThan(10 ** (-42 / 20));
    expect(quietRms(noisy.rms, .02)).toBeGreaterThan(noisy.rms.filter((_, i) => i >= 150 && i < 225).reduce((a, b) => Math.max(a, b)));
  });

  it("reads a quiet studio as it did", () => {
    // Room tone at -60 dBFS, far under speech at -20: quiet is 20 dB over the room, and sound is 12 dB under the voice.
    const studio = levels(() => undefined);
    expect(quietRms(studio.rms, .02)).toBeCloseTo(.01, 6);
    const hushed = { ...studio, rms: studio.rms.map(v => v === .001 ? .0002 : v) };
    expect(quietRms(hushed.rms, .02)).toBeCloseTo(.002, 6);
    expect(gapSound(levels(t => t >= 3.1 && t < 3.5 ? .026 : undefined), { start: 2.9, end: 4.6 })!.runs).toEqual([{ start: 3.1, end: 3.5 }]);
  });
});

describe("quiet transcribed phrases", () => {
  const words = [
    { text: "Watch", start: .8, end: 1.2 }, { text: "here.", start: 1.2, end: 1.6 },
    { text: "move", start: 2.4, end: 2.65 }, { text: "it", start: 2.65, end: 2.65 },
    { text: "over", start: 2.7, end: 3 }, { text: "Ready.", start: 5, end: 5.5 },
  ];
  const recording = (before: number, phrase: number, after: number) => levels(t => {
    if (!words.some(w => w.start <= t && w.end > t)) return 0;
    return t < 2 ? before : t < 4 ? phrase : after;
  });

  it("reports a soft phrase with both local levels, its whole text and stable word references", () => {
    const measured = recording(.1, .004, .08);
    expect(quietPhrases(words, measured)).toEqual([{ start: 2.4, end: 3, text: "move it over", fromWord: 2, toWord: 4,
      levelDbfs: -48, beforeDbfs: -20, afterDbfs: -22 }]);
    // A silent pause on a quiet microphone is commonplace; the neighboring speech needs to be louder on both sides.
    expect(quietPhrases(words, recording(.006, .004, .005))).toEqual([]);
    expect(quietPhrases(words, recording(.1, .004, .008))).toEqual([]);
    expect(quietPhrases(words, recording(.1, .07, .08))).toEqual([]);
    // The waits on either side of ordinary speech are silent even in the last case.
    expect(quietPhrases(words, { ...measured, rms: [] })).toEqual([]);
    expect(quietPhrases(words, { ...measured, rms: measured.rms.filter((_, i) => i % 10 === 0) })).toEqual([]);
  });

  it("requires measured speech on both sides of a candidate within the available reading", () => {
    const full = recording(.1, .004, .08);
    expect(quietPhrases(words, { from: 2, to: 10, rms: full.rms.slice(100) })).toEqual([]);
    expect(quietPhrases(words, { from: 0, to: 4, rms: full.rms.slice(0, 200) })).toEqual([]);
    // A cached reading can reach the following word before its alignment is final.
    expect(quietPhrases(words, full, 5.2)).toEqual([]);
    expect(quietPhrases(words, full, 5.5)).toHaveLength(1);
  });
});
