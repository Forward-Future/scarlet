import { describe, expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, makeTrack, type MediaAsset, type Transcript } from "@scarlet/timeline";
import { firstCutPauses } from "./analysis.js";
import { keptSilences, pictureReading, pictureWindows, silences } from "./silences.js";
import { timelineWords } from "./timeline-perception.js";

const word = (text: string, start: number, end: number) => ({ text, start, end });
const page = (words: ReturnType<typeof word>[]): Transcript => ({ id: "t", mediaId: "cam",
  segments: [{ id: "s", start: words[0]!.start, end: words.at(-1)!.end, text: words.map(w => w.text).join(" "), words }] });
/** 20 ms buckets over a page: room tone, with speech-level peaks wherever `loud` says. */
const levels = (from: number, to: number, loud: (t: number) => boolean) => {
  const n = Math.round((to - from) * 50);
  const peaks = Array.from({ length: n }, (_, i) => loud(from + i * .02) ? .3 : .004);
  return { from, to, peaks, rms: peaks.map(p => p / 2) };
};

describe("silences", () => {
  // The shape of a real miss: eight seconds with no words while a note is typed, and the keys register as voice.
  const typing = [{ start: 12.2, end: 12.72 }, { start: 13.3, end: 15.06 }, { start: 15.32, end: 16.72 }];
  const said = [word("add", 9.5, 9.7), word("a", 9.7, 9.8), word("text", 9.82, 10.18), word("note.", 10.18, 10.52),
    word("You", 18.72, 18.92), word("have", 18.92, 19.12), word("signatures,", 19.2, 19.8)];
  const wf = { ...levels(0, 30, t => (t >= 9.5 && t < 10.52) || (t >= 18.72 && t < 19.8) || typing.some(v => t >= v.start && t < v.end)),
    speechActivity: [{ start: 9.4, end: 10.6 }, ...typing, { start: 18.7, end: 19.9 }] };

  it("lists a stretch without words whole when typing splits its pauses into slivers", () => {
    const pauses = firstCutPauses(page(said), wf);
    expect(Math.max(...pauses.map(p => p.remove.end - p.remove.start))).toBeLessThan(2);
    const found = silences(page(said), wf).filter(s => !s.open);
    expect(found).toEqual([{ start: 10.52, end: 18.72, seconds: 8.2, after: "note.", before: "You", voiceSeconds: 3.78, maxPeakDb: expect.any(Number) }]);
    expect(found[0]!.maxPeakDb).toBeGreaterThan(-15);
  });

  it("starts a page's first silence at the previous page's last word, and marks one that runs past the page", () => {
    const found = silences(page([word("So", 62, 62.2), word("here.", 62.2, 62.6)]), levels(58, 118, () => false),
      { previous: word("done.", 56.9, 57.4) });
    expect(found[0]).toMatchObject({ start: 57.4, end: 62, seconds: 4.6, after: "done.", before: "So" });
    expect(found[1]).toMatchObject({ start: 62.6, end: 118, after: "here.", open: "end" });
    expect(silences(page([word("So", 62, 62.2)]), levels(58, 118, () => false))[0]).toMatchObject({ start: 58, end: 62, open: "start" });
  });

  it("leaves out shorter gaps and blank-audio markers", () => {
    const t = page([word("One", 1, 1.3), word("two", 2.5, 2.8), word("[BLANK_AUDIO]", 3, 13), word("three", 14, 14.3)]);
    expect(silences(t, levels(1, 14.3, () => false)).map(s => [s.start, s.end])).toEqual([[2.8, 14]]);
  });
});

describe("pictureWindows", () => {
  const media = [{ id: "cam", kind: "video", duration: 100 }, { id: "screen", kind: "video", duration: 100 }, { id: "music", kind: "audio", duration: 100 }] as MediaAsset[];
  const tl = emptyTimeline("p");
  const camera = makeTrack("video", "Camera");
  // The screen recording started 3.64 s before the camera. A cut took source 40–50 of both out.
  tl.tracks[0]!.clips = [makeMediaClip("screen", 6.36, 36.36, 0, { volume: 0 }), makeMediaClip("screen", 46.36, 86.36, 30, { volume: 0 })];
  camera.clips = [makeMediaClip("cam", 10, 40, 0), makeMediaClip("cam", 50, 90, 30)];
  tl.tracks.push(camera);

  it("finds every picture playing through a source range, on its own clock", () => {
    expect(pictureWindows(tl, media, "cam", { start: 60, end: 68.2 })).toEqual([
      { mediaId: "screen", from: 56.36, to: 64.56, shift: expect.closeTo(3.64, 6) },
      { mediaId: "cam", from: 60, to: 68.2, shift: 0 }]);
  });

  it("has none for a range that was cut or that crosses a join", () => {
    expect(pictureWindows(tl, media, "cam", { start: 42, end: 45 })).toEqual([]);
    expect(pictureWindows(tl, media, "cam", { start: 38, end: 52 })).toEqual([]);
  });

  it("reports a reading in percent of the frame and the scanned recording's seconds", () => {
    expect(pictureReading({ mediaId: "screen", from: 56.36, to: 64.56, changedFrames: 59, frames: 246, largestArea: .2677, typicalArea: .0004,
      largestAt: 56.54, lastChangeAt: 64.2 }, 3.64)).toEqual({ mediaId: "screen", changedFrames: 59, frames: 246, typicalAreaPct: .04, largestAreaPct: 26.77,
      largestAt: 60.18, lastChangeAt: 67.84 });
    expect(pictureReading({ mediaId: "screen", from: 1, to: 3, changedFrames: 0, frames: 60 }, 0)).toEqual({ mediaId: "screen", changedFrames: 0, frames: 60 });
  });
});

describe("keptSilences", () => {
  const tl = emptyTimeline("p");
  tl.tracks[0]!.clips = [makeMediaClip("cam", 100, 160, 0)];
  const words = timelineWords(tl, new Map([["cam", [word("note.", 109.6, 110), word("You", 118.2, 118.4), word("have", 118.4, 118.6),
    word("it.", 121, 121.3), word("Next", 124.4, 124.7), word("up.", 126.2, 126.5)]]]));

  it("lists each silence of two seconds or more that no decision covers, with its source", () => {
    // The second silence is cut, the third is too short.
    expect(keptSilences(tl, words, [{ start: 21.5, end: 24.2 }])).toEqual([{ mediaId: "cam", source: { start: 110, end: 118.2 },
      start: 10, end: 18.2, seconds: 8.2, after: "note.", before: "You" }, { mediaId: "cam", source: { start: 118.6, end: 121 }, start: 18.6, end: 21, seconds: 2.4, after: "have", before: "it." }]);
  });

  it("drops a silence a decision trims below two seconds, and one that is kept or staged on purpose", () => {
    expect(keptSilences(tl, words, [{ start: 10.4, end: 17.8 }, { start: 18.6, end: 21 }, { start: 21.3, end: 24.4 }])).toEqual([]);
  });
});
