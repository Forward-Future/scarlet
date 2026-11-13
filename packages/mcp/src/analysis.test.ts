import { describe, expect, it } from "vitest";
import type { Transcript } from "@scarlet/timeline";
import { makeMediaClip } from "@scarlet/timeline";
import {
  captionWordMapper,
  dedupeWords,
  detectSilences,
  dialogueCutSuggestions,
  firstCutEvidence,
  firstCutPauses,
  downsample,
  flattenWords,
  formatTranscriptText,
  mapWordsThroughClip,
  searchTranscript,
  sparkline,
} from "./analysis.js";
import { joinEvidence } from "./dialogue-join.js";

const transcript: Transcript = {
  id: "t1",
  mediaId: "m1",
  segments: [
    {
      id: "s1",
      start: 0,
      end: 3,
      text: "Hello there, welcome back.",
      speaker: "Matt",
      words: [
        { text: "Hello", start: 0.1, end: 0.4 },
        { text: "there,", start: 0.45, end: 0.7 },
        { text: "welcome", start: 1.0, end: 1.4 },
        { text: "back.", start: 1.45, end: 1.8 },
      ],
    },
    {
      id: "s2",
      start: 4,
      end: 7,
      text: "Welcome back to the channel.",
      words: [
        { text: "Welcome", start: 4.0, end: 4.4 },
        { text: "back", start: 4.45, end: 4.7 },
        { text: "to", start: 4.8, end: 4.9 },
        { text: "the", start: 4.95, end: 5.1 },
        { text: "channel.", start: 5.2, end: 5.8 },
      ],
    },
  ],
};

describe("detectSilences", () => {
  it("finds runs of low peaks at least minDuration long", () => {
    // 100 buckets over 10 s = 0.1 s each. Silence at buckets 20..29 (1.0 s) and 60..61 (0.2 s, too short).
    const peaks = Array.from({ length: 100 }, (_, i) => (i >= 20 && i < 30 ? 0.01 : i >= 60 && i < 62 ? 0.0 : 0.6));
    const s = detectSilences(peaks, 0, 10, { threshold: 0.05, minDuration: 0.25 });
    expect(s).toEqual([{ start: 2, end: 3, duration: 1 }]);
  });
  it("handles a silence that runs to the end and offsets by from", () => {
    const peaks = [0.5, 0.5, 0.0, 0.0, 0.0, 0.0];
    const s = detectSilences(peaks, 10, 13, { minDuration: 0.25 });
    expect(s).toEqual([{ start: 11, end: 13, duration: 2 }]);
  });
  it("returns nothing for empty input", () => {
    expect(detectSilences([], 0, 1)).toEqual([]);
  });
});

describe("sparkline/downsample", () => {
  it("renders one glyph per bucket and downsamples by max", () => {
    expect(sparkline([0, 0.5, 1])).toBe("▁▅█");
    expect(downsample([0.1, 0.9, 0.2, 0.3], 2)).toEqual([0.9, 0.3]);
  });
});

describe("searchTranscript", () => {
  it("finds phrases regardless of case and punctuation, with context", () => {
    const words = flattenWords(transcript);
    const matches = searchTranscript(words, "welcome back", 2);
    expect(matches.length).toBe(2);
    expect(matches[0]).toMatchObject({ start: 1.0, end: 1.8, text: "welcome back.", speaker: "Matt" });
    expect(matches[1]).toMatchObject({ start: 4.0, end: 4.7 });
    expect(matches[0]!.context).toContain("[ welcome back. ]");
    expect(searchTranscript(words, "nope at all")).toEqual([]);
  });
  it("synthesizes word timings when a segment has none", () => {
    const t: Transcript = { id: "t", mediaId: "m", segments: [{ id: "s", start: 0, end: 2, text: "one two", words: [] }] };
    const words = flattenWords(t);
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([
      ["one", 0, 1],
      ["two", 1, 2],
    ]);
  });
});

describe("formatTranscriptText", () => {
  it("renders compact word lines under segment headers with speaker", () => {
    const out = formatTranscriptText(transcript, "word", 0, 2);
    expect(out.split("\n")[0]).toBe("## [0.00-3.00] Matt:");
    expect(out).toContain("[0.10-0.40] Hello");
    expect(out).not.toContain("channel");
    const seg = formatTranscriptText(transcript, "segment");
    expect(seg).toContain("[4.00-7.00] Welcome back to the channel.");
  });
});

describe("mapWordsThroughClip", () => {
  it("indexes repeated source cuts with half-open midpoint bounds and preserves overlapping speech order", () => {
    for (const end of [1, 8]) {
      const recording = { ...transcript, segments: [{ ...transcript.segments[0]!, words: [
        { text: "first", start: 0, end },
        { text: "second", start: 1, end: 2 },
        { text: "third", start: 2, end: 3 },
      ] }] };
      const map = captionWordMapper(flattenWords(recording));
      for (const [start, stop] of [[1.5, 2.5], [0, 1.5], [1.5, 4.1]] as const) {
        const clip = makeMediaClip("m1", start, stop, 10, { speed: 2 });
        expect(map(clip)).toEqual(mapWordsThroughClip(clip, flattenWords(recording)));
      }
    }
  });
  it("maps source words into timeline time and drops cut words", () => {
    // keep source 4.0..5.0 placed at timeline 10
    const clip = makeMediaClip("m1", 4.0, 5.0, 10);
    const words = mapWordsThroughClip(clip, flattenWords(transcript));
    // "the" (4.95-5.1) straddles the cut at 5.0 with its midpoint outside, so it is dropped.
    expect(words.map((w) => w.text)).toEqual(["Welcome", "back", "to"]);
    expect(words[0]).toMatchObject({ start: 10, end: 10.4 });
    expect(words[2]).toMatchObject({ start: 10.8, end: 10.9 });
    // a word straddling the end with its midpoint inside is clamped to the clip end
    const clamped = mapWordsThroughClip(makeMediaClip("m1", 4.0, 5.05, 10), flattenWords(transcript));
    expect(clamped[3]).toMatchObject({ text: "the", start: 10.95, end: 11.05 });
  });
  it("accounts for speed", () => {
    const clip = makeMediaClip("m1", 4.0, 6.0, 0, { speed: 2 });
    const words = mapWordsThroughClip(clip, flattenWords(transcript));
    expect(words[1]).toMatchObject({ text: "back", start: 0.225, end: 0.35 });
  });
  it("dedupes words from overlapping clips of the same media", () => {
    const a = mapWordsThroughClip(makeMediaClip("m1", 4, 5, 10), flattenWords(transcript));
    const b = mapWordsThroughClip(makeMediaClip("m1", 4, 5, 10), flattenWords(transcript));
    expect(dedupeWords([...a, ...b]).length).toBe(a.length);
  });
  it("dedupes the same recorded words when overlapping voices interleave their copies", () => {
    const first = { text: "Right.", start: 1, end: 1.6 };
    const second = { text: "Yes!", start: 1.002, end: 1.2 };
    const later = { ...first, start: 1.1 };
    expect(dedupeWords([first, second, { ...first, text: "right", start: 1.01 },
      { ...second, start: 1.012 }, later])).toEqual([first, second, later]);
  });
});

describe("dialogueCutSuggestions", () => {
  it("finds quiet at the head, tail and inside a stretched word while protecting disputed speech", () => {
    const word = { start: 2, end: 5, text: "Ready" };
    const segment = { id: "take", ...word, words: [word] };
    const t = { id: "t", mediaId: "mic", segments: [segment] };
    const voice = [{ start: 2, end: 2.5 }, { start: 5, end: 5.3 }];
    const levels = Array.from({ length: 400 }, (_, i) => voice.some(v => i/50 >= v.start && i/50 < v.end) ? .2 : .0005);
    const wf = { from: 0, to: 8, peaks: levels, rms: levels, speechActivity: voice };
    const edges = joinEvidence([word], wf);
    const pauses = firstCutPauses(t, wf, edges);
    expect(pauses.map(p => p.remove)).toEqual([{ start: .12, end: 1.88 }, { start: 2.62, end: 4.88 }, { start: 5.42, end: 7.88 }]);
    expect(pauses.every(p => !p.timingWarning)).toBe(true);
    segment.words.push({ start: 3.2, end: 3.8, text: "now" });
    expect(firstCutPauses(t, wf, edges)[1]?.timingWarning).toMatch(/timing/i);
    expect(firstCutPauses(t, wf, undefined)).toEqual([]);
  });

  it("recognizes ah and extended hesitations as candidates and preserves whole words", () => {
    const words = ["Ah!", "aahh", "Um,", "uhh", "ahead", "huh", "uh-huh"].map((text, i) => ({ text, start: i, end: i + .2 }));
    const t = { id: "t", mediaId: "m", segments: [{ id: "s", start: 0, end: 7, text: words.map(w => w.text).join(" "), words }] };
    expect(firstCutEvidence(t, { from: 0, to: 7 }).fillers.map(w => w.text)).toEqual(["Ah!", "aahh", "Um,", "uhh"]);
  });

  it("retains consonant margins and splits around an audible breath between timed words", () => {
    const rms = Array.from({ length: 350 }, (_, i) => i >= 135 && i < 148 ? 0.02 : 0.001);
    const wf = { from: 0, to: 7, peaks: rms.map(x => 2 * x), rms };
    const { candidates } = dialogueCutSuggestions(transcript, wf, { minSilence: 0.25, threshold: 0.05 });
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect([c.before, c.after]).toEqual(["back.", "Welcome"]);
      expect(c.airBefore).toBeGreaterThanOrEqual(0.1);
      expect(c.airAfter).toBeGreaterThanOrEqual(0.1);
      expect(c.remove.end <= 2.7 || c.remove.start >= 2.96).toBe(true);
    }
    const guarded = dialogueCutSuggestions(transcript, { ...wf, speechActivity: [{ start: 1.8, end: 4 }] },
      { minSilence: 0.25, threshold: 0.05 });
    expect(guarded.candidates).toEqual([]);
    const untimed = { ...transcript, segments: transcript.segments.map(s => ({ ...s, words: [] })) };
    expect(dialogueCutSuggestions(untimed, wf, { minSilence: 0.25, threshold: 0.05 }).candidates).toEqual([]);
  });
});
