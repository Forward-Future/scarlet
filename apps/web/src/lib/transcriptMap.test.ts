import { describe, expect, it } from "vitest";
import type { Timeline, Transcript } from "@scarlet/timeline";
import { cutWords, sourceWords, speechAssets, mapWords, selectionRange, indexWordTimes } from "./transcriptMap";

const transcript: Transcript = {
  id: "tr",
  mediaId: "m1",
  segments: [
    {
      id: "s1",
      start: 0,
      end: 6,
      text: "zero one two three four five",
      words: [
        { text: "zero", start: 0, end: 1 },
        { text: "one", start: 1, end: 2 },
        { text: "two", start: 2, end: 3 },
        { text: "three", start: 3, end: 4 },
        { text: "four", start: 4, end: 5 },
        { text: "five", start: 5, end: 6 },
      ],
    },
    { id: "s2", start: 6, end: 8, text: "six seven", words: [] },
  ],
};

function tl(clips: Timeline["tracks"][number]["clips"], extraTracks: Timeline["tracks"] = []): Timeline {
  return {
    version: "v",
    parent: null,
    projectId: "p",
    name: "Main",
    tracks: [{ id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips }, ...extraTracks],
    markers: [],
    background: "#000",
  };
}

const media = (id: string, sourceIn: number, sourceOut: number, timelineIn: number, speed = 1) =>
  ({
    id,
    kind: "media" as const,
    mediaId: "m1",
    sourceIn,
    sourceOut,
    timelineIn,
    speed,
    enabled: true,
    opacity: 1,
    volume: 1,
    audioFadeIn: 0,
    audioFadeOut: 0,
    videoFadeIn: 0,
    videoFadeOut: 0,
    effects: [],
  });

describe("mapWords", () => {
  it("maps kept words to timeline time and marks cut words", () => {
    // Keep source 1–3 at timeline 0, and source 4–6 at timeline 2 (source 0–1 and 3–4 are cut).
    const words = mapWords(transcript, tl([media("a", 1, 3, 0), media("b", 4, 6, 2)]), "m1");
    expect(words.map((w) => w.cut)).toEqual([true, false, false, true, false, false, true, true]);
    expect(words[1]!.placements[0]).toMatchObject({ clipId: "a", start: 0, end: 1 });
    expect(words[2]!.placements[0]).toMatchObject({ clipId: "a", start: 1, end: 2 });
    expect(words[4]!.placements[0]).toMatchObject({ clipId: "b", start: 2, end: 3 });
    expect(words[5]!.placements[0]).toMatchObject({ clipId: "b", start: 3, end: 4 });
  });

  it("accounts for clip speed", () => {
    const words = mapWords(transcript, tl([media("fast", 0, 6, 10, 2)]), "m1");
    expect(words[2]!.placements[0]).toMatchObject({ start: 11, end: 11.5 });
  });

  it("spreads segments without word timings evenly", () => {
    const words = mapWords(transcript, tl([media("a", 6, 8, 0)]), "m1");
    const six = words.find((w) => w.word.text === "six")!;
    const seven = words.find((w) => w.word.text === "seven")!;
    expect(six.cut).toBe(false);
    expect(six.placements[0]).toMatchObject({ start: 0, end: 1 });
    expect(seven.placements[0]).toMatchObject({ start: 1, end: 2 });
  });

  it("dedups placements when video and audio tracks carry the same cut", () => {
    const audio: Timeline["tracks"] = [
      { id: "a1", kind: "audio", name: "A1", muted: false, hidden: false, clips: [media("a-audio", 1, 3, 0)] },
    ];
    const words = mapWords(transcript, tl([media("a", 1, 3, 0)], audio), "m1");
    expect(words[1]!.placements).toHaveLength(1);
  });

  it("ignores muted tracks and disabled clips", () => {
    const hidden: Timeline["tracks"] = [
      { id: "v2", kind: "video", name: "V2", muted: true, hidden: false, clips: [media("h", 0, 6, 0)] },
    ];
    const words = mapWords(transcript, tl([{ ...media("d", 0, 6, 0), enabled: false }], hidden), "m1");
    expect(words.every((w) => w.cut)).toBe(true);
  });
});

describe("indexWordTimes / selectionRange", () => {
  const words = mapWords(transcript, tl([media("a", 1, 3, 0), media("b", 4, 6, 2)]), "m1");

  it("finds the word under the playhead", () => {
    const at = indexWordTimes(words);
    expect(at(0.5)).toBe(1);
    expect(at(1.2)).toBe(2);
    expect(at(3.9)).toBe(5);
  });

  it("holds the previous word briefly across a tiny gap, then nothing", () => {
    const gappy = mapWords(transcript, tl([media("a", 1, 2, 0), media("b", 5, 6, 5)]), "m1");
    const at = indexWordTimes(gappy);
    expect(at(1.2)).toBe(1); // within 0.35 s after "one" ended
    expect(at(3)).toBe(-1);
  });

  it("keeps the first active word across overlapping, repeated and out-of-order spans", () => {
    const at = indexWordTimes([
      { ...words[0]!, index: 0, placements: [{ start: 3, end: 5 }, { start: 8, end: 9 }] },
      { ...words[1]!, index: 1, placements: [{ start: 1, end: 8 }] },
      { ...words[2]!, index: 2, placements: [{ start: 3, end: 4 }] },
    ]);
    expect([0, 2, 3.5, 4.5, 6, 8.5, 9.1, 9.5].map(at)).toEqual([-1, 1, 0, 0, 1, 0, 0, -1]);
  });

  it("returns the timeline range for a span of words, skipping cut words", () => {
    expect(selectionRange(words, 1, 5)).toEqual({ start: 0, end: 4 });
    expect(selectionRange(words, 5, 1)).toEqual({ start: 0, end: 4 });
    expect(selectionRange(words, 0, 0)).toBeNull();
  });
});

describe("cut and source transcripts", () => {
  it("reads multiple sources in playback order, retaining distinct occurrences and their own selection ranges", () => {
    const second: Transcript = { ...transcript, mediaId: "m2", segments: [{ id: "s1", text: "other", start: 0, end: 1, words: [] }] };
    const timeline = tl([media("late", 1, 2, 3), media("early", 4, 5, 0), { ...media("b", 0, 1, 1), mediaId: "m2" }, media("repeat", 4, 5, 2)]);
    const words = cutWords(timeline, [transcript, second]);
    expect(words.map(w => w.word.text)).toEqual(["four", "other", "four", "one"]);
    expect(selectionRange(words, 2, 3)).toEqual({ start: 2, end: 4 });
    expect(indexWordTimes(words)(2.4)).toBe(2);
    expect(words[2]!.placements[0]!.clipId).toBe("repeat");
    const raw = sourceWords(transcript);
    expect(raw.map(w => w.word.text)).toEqual(["zero", "one", "two", "three", "four", "five", "six", "seven"]);
    expect(selectionRange(raw, 4, 4)).toEqual({ start: 4, end: 5 });
  });

  it("only requests transcripts for audible media in the cut", () => {
    const timeline = tl([{ ...media("a", 1, 3, 0), volume: 0 }, { ...media("b", 1, 3, 0), mediaId: "m2" }]);
    const assets = ["m1", "m2"].map(id => ({ id, kind: "video" as const, name: id, path: id }));
    expect(speechAssets(timeline, assets).map(a => a.id)).toEqual(["m2"]);
  });
});
