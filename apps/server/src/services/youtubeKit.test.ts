import { expect, it } from "vitest";
import type { MediaClip, Timeline, Track, Transcript, TranscriptSegment } from "@scarlet/timeline";
import {
  buildFinalCutChapters,
  collectFinalTimelineWords,
  formatChaptersBlock,
  formatYouTubeTimestamp,
  normalizeYouTubeChapters,
  type FinalTimelineWord,
} from "./youtubeKit.js";

function clip(patch: Partial<MediaClip> & Pick<MediaClip, "id" | "timelineIn" | "sourceIn" | "sourceOut">): MediaClip {
  return {
    kind: "media", mediaId: "med_1", speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0,
    videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true, ...patch,
  };
}

function track(kind: Track["kind"], clips: MediaClip[], patch: Partial<Track> = {}): Track {
  return { id: `${kind}_${Math.random().toString(36).slice(2)}`, kind, name: kind, muted: false, hidden: false, clips, ...patch };
}

function timeline(tracks: Track[], markers: Timeline["markers"] = []): Timeline {
  return { version: "ver_1", parent: null, projectId: "prj_1", name: "Main", background: "#000000", markers, tracks } as Timeline;
}

function transcript(segments: Array<Partial<TranscriptSegment> & Pick<TranscriptSegment, "start" | "end" | "text">>, mediaId = "med_1"): Transcript {
  return {
    id: `trn_${mediaId}`, mediaId, language: "en", provider: "whispercpp", createdAt: "2026-11-26T00:00:00.000Z",
    segments: segments.map((s, i) => ({ id: `s${i}`, words: [], ...s })),
  } as Transcript;
}

function word(text: string, start: number, patch: Partial<FinalTimelineWord> = {}): FinalTimelineWord {
  return { mediaId: "med_1", text, start, end: start + 0.4, sourceStart: start, sourceEnd: start + 0.4, ...patch };
}

it("formats chapter times on the edited clock, never below zero", () => {
  expect(formatYouTubeTimestamp(-5)).toBe("0:00");
  expect(formatYouTubeTimestamp(59.9999999)).toBe("1:00");
  expect(formatYouTubeTimestamp(59.4)).toBe("0:59");
  expect(formatYouTubeTimestamp(3600)).toBe("1:00:00");
  expect(formatYouTubeTimestamp(36_005)).toBe("10:00:05");
});

it("joins chapters into the lines pasted into a description", () => {
  expect(formatChaptersBlock([])).toBe("");
  expect(formatChaptersBlock([{ time: 0, timestamp: "0:00", title: "Intro" }, { time: 75, timestamp: "1:15", title: "Demo" }])).toBe("0:00 Intro\n1:15 Demo");
});

it("collects no words when there are no transcripts", () => {
  expect(collectFinalTimelineWords(timeline([track("audio", [clip({ id: "a", timelineIn: 0, sourceIn: 0, sourceOut: 10 })])]), new Map())).toEqual([]);
});

it("reads speech from video clips when no audio clip carries it, skipping muted, hidden, silent and disabled clips", () => {
  const tr = transcript([{ start: 0, end: 4, text: "one two three four", speaker: "A" }]);
  const other = transcript([{ start: 0, end: 2, text: "elsewhere words" }], "med_2");
  const tl = timeline([
    track("caption", []),
    track("audio", [clip({ id: "muted", timelineIn: 0, sourceIn: 0, sourceOut: 4 })], { muted: true }),
    track("audio", [clip({ id: "silent", timelineIn: 0, sourceIn: 0, sourceOut: 4, volume: 0 })]),
    track("video", [clip({ id: "hidden", timelineIn: 0, sourceIn: 0, sourceOut: 4 })], { hidden: true }),
    track("video", [
      clip({ id: "off", timelineIn: 0, sourceIn: 0, sourceOut: 4, enabled: false }),
      clip({ id: "untranscribed", mediaId: "med_3", timelineIn: 0, sourceIn: 0, sourceOut: 4 }),
      clip({ id: "v", timelineIn: 10, sourceIn: 0, sourceOut: 4 }),
    ]),
  ]);
  const words = collectFinalTimelineWords(tl, new Map([["med_1", tr], ["med_2", other]]));
  // Text without word timings is spread evenly over its segment.
  expect(words.map(w => [w.text, w.start, w.end, w.speaker])).toEqual([
    ["one", 10, 11, "A"], ["two", 11, 12, "A"], ["three", 12, 13, "A"], ["four", 13, 14, "A"],
  ]);
});

it("skips empty segments and blank words, and keeps one copy of a word two microphones heard", () => {
  const tr = transcript([
    { start: 0, end: 1, text: "   " },
    { start: 1, end: 3, text: "hello there", words: [{ text: "hello", start: 1, end: 1.5 }, { text: "  ", start: 1.5, end: 2 }, { text: "there", start: 2, end: 3 }] },
  ]);
  const tl = timeline([
    track("audio", [clip({ id: "a1", timelineIn: 0, sourceIn: 0, sourceOut: 5 })]),
    track("audio", [clip({ id: "a2", timelineIn: 0.01, sourceIn: 0, sourceOut: 5 })]),
  ]);
  const words = collectFinalTimelineWords(tl, new Map([["med_1", tr]]));
  expect(words.map(w => w.text)).toEqual(["hello", "there"]);
  expect(words[0]).toMatchObject({ start: 1, sourceStart: 1, sourceEnd: 1.5 });
  expect(words[0]!.speaker).toBeUndefined();
});

it("fits words into the clip at its speed and drops those outside it", () => {
  const tr = transcript([{
    start: 0, end: 20, text: "x", words: [
      { text: "before", start: 1, end: 2 },
      { text: "edge", start: 4.5, end: 6 },
      { text: "inside", start: 8, end: 9 },
      { text: "tail", start: 13.2, end: 14.4 },
      { text: "after", start: 16, end: 17 },
    ],
  }]);
  const tl = timeline([track("audio", [clip({ id: "a", timelineIn: 100, sourceIn: 5, sourceOut: 14, speed: 0 as unknown as number })])]);
  const words = collectFinalTimelineWords(tl, new Map([["med_1", tr]]));
  // A clip with no usable speed plays at normal speed; words straddling an edge are clamped to the clip.
  expect(words.map(w => [w.text, w.start, w.end])).toEqual([["edge", 100, 101], ["inside", 103, 104], ["tail", 108.2, 109]]);
});

it("opens chapters at 0:00 with the first title when it starts in the first seconds", () => {
  expect(normalizeYouTubeChapters([{ time: 3, title: "Welcome" }, { time: 40, title: "Main" }], 120).map(c => `${c.timestamp} ${c.title}`))
    .toEqual(["0:00 Welcome", "0:40 Main"]);
});

it("adds an Intro at 0:00 and drops a first chapter too close to it", () => {
  expect(normalizeYouTubeChapters([{ time: 7, title: "Too soon" }, { time: 30, title: "Next" }], 120).map(c => c.title)).toEqual(["Intro", "Next"]);
  expect(normalizeYouTubeChapters([], 120)).toEqual([{ time: 0, timestamp: "0:00", title: "Intro" }]);
  expect(normalizeYouTubeChapters([{ time: Number.NaN, title: "Bad" }, { time: -1, title: "Negative" }], 120).map(c => c.title)).toEqual(["Intro"]);
});

it("keeps chapters apart, ascending, and away from the very end", () => {
  const chapters = normalizeYouTubeChapters([
    { time: 0, title: "Start" },
    { time: 0.5, title: "Same second" },
    { time: 6, title: "Too close" },
    { time: 20, title: "Kept" },
    { time: 118, title: "At the end" },
    { time: 500, title: "Past the end" },
  ], 120);
  expect(chapters.map(c => [c.time, c.title])).toEqual([[0, "Start"], [20, "Kept"]]);
  // Shorter videos allow closer chapters: 5 s under 35 s, 2 s under 15 s.
  expect(normalizeYouTubeChapters([{ time: 0, title: "A" }, { time: 5, title: "B" }, { time: 10, title: "C" }], 20).map(c => c.time)).toEqual([0, 5, 10]);
  expect(normalizeYouTubeChapters([{ time: 0, title: "A" }, { time: 2, title: "B" }, { time: 4, title: "C" }], 10).map(c => c.time)).toEqual([0, 2, 4]);
  expect(normalizeYouTubeChapters([{ time: 0, title: "A" }, { time: 3, title: "B" }], 40, { minSpacingSeconds: 3 }).map(c => c.time)).toEqual([0, 3]);
});

it("cleans chapter titles of numbering, quotes and line breaks, and shortens long ones", () => {
  const long = "word ".repeat(30);
  const chapters = normalizeYouTubeChapters([
    { time: 0, title: "1. \"The\nopening\"" },
    { time: 20, title: "— ‘“Quoted”’ `bit`" },
    { time: 40, title: "  - 3) " },
    { time: 60, title: long },
  ], 120);
  expect(chapters.map(c => c.title)).toEqual(["The opening", "‘Quoted’ bit", "Section", `${long.trim().slice(0, 67).trimEnd()}…`]);
  expect(chapters[3]!.title.length).toBeLessThanOrEqual(68);
});

it("uses chapter markers on the edit first, in order, skipping empty and out-of-range ones", () => {
  const tl = timeline([], [
    { id: "m3", time: 42, kind: "chapter", text: "  Wrap up ", resolved: false },
    { id: "m1", time: 0, kind: "chapter", text: "Hello", resolved: false },
    { id: "m2", time: 20, kind: "chapter", text: "   ", resolved: false },
    { id: "m4", time: 21, kind: "note", text: "Not a chapter", resolved: false },
    { id: "m5", time: 90, kind: "chapter", text: "Beyond", resolved: false },
    { id: "m6", time: 43, kind: "chapter", text: "One second later", resolved: false },
  ]);
  expect(buildFinalCutChapters(tl, [word("ignored", 1)], 60).map(c => `${c.timestamp} ${c.title}`))
    .toEqual(["0:00 Hello", "0:42 Wrap up", "0:43 One second later"]);
});

it("gives a short video one chapter named from its first words", () => {
  const words = [word("Um,", 0), word("so", 0.5), word("today", 1), word("we", 1.5), word("ship.", 2), word("Then", 3)];
  expect(buildFinalCutChapters(timeline([]), words, 10)).toEqual([{ time: 0, timestamp: "0:00", title: "Today we ship" }]);
  expect(buildFinalCutChapters(timeline([]), [], 10)).toEqual([{ time: 0, timestamp: "0:00", title: "Intro" }]);
  expect(buildFinalCutChapters(timeline([]), [word("!!!", 0), word("...", 1)], 10)[0]!.title).toBe("Intro");
});

it("places chapters at strong breaks in the speech near evenly spaced points", () => {
  // 100 s of speech, a word every 2 s; sentence ends, a long pause and a jump in the source mark the breaks.
  const words: FinalTimelineWord[] = [];
  for (let t = 0; t < 100; t += 2) words.push(word(`w${t}`, t));
  const at = (t: number) => words.findIndex(w => w.start === t);
  words[at(22)] = word("done.", 22);
  words[at(24)] = word("Second", 24, { sourceStart: 300, sourceEnd: 300.4 });
  words[at(26)] = word("part", 26, { sourceStart: 302, sourceEnd: 302.4 });
  words[at(48)] = word("over.", 48, { speaker: "A" });
  words[at(50)] = word("Third", 51, { speaker: "B" });
  words[at(74)] = word("Fourth", 74.5, { mediaId: "med_2" });
  const chapters = buildFinalCutChapters(timeline([]), words, 100);
  expect(chapters[0]).toMatchObject({ time: 0, title: "W0 w2 w4 w6 w8 w10" });
  expect(chapters.map(c => c.time)).toEqual([0, 24, 51, 74]);
  expect(chapters[1]!.title).toMatch(/^Second part/);
  expect(chapters[2]!.title).toMatch(/^Third/);
  for (let i = 1; i < chapters.length; i++) expect(chapters[i]!.time - chapters[i - 1]!.time).toBeGreaterThanOrEqual(10);
});

it("falls back to evenly spaced words when the speech has no breaks", () => {
  // Words a second apart with no sentence ends, pauses, speaker changes or source jumps.
  const words: FinalTimelineWord[] = [];
  for (let t = 0; t < 60; t += 1) words.push(word(`word${t}`, t, { end: t + 1, sourceEnd: t + 1 }));
  const chapters = buildFinalCutChapters(timeline([]), words, 60);
  expect(chapters.map(c => c.time)).toEqual([0, 15, 30, 45]);
  expect(chapters[1]!.title).toBe("Word15 word16 word17 word18 word19 word20");
});

it("names chapters after video clips when there is no transcript", () => {
  const tl = timeline([
    track("video", [
      clip({ id: "b", timelineIn: 30, sourceIn: 0, sourceOut: 30, label: "  Demo  " }),
      clip({ id: "a", timelineIn: 0, sourceIn: 0, sourceOut: 30 }),
      clip({ id: "off", timelineIn: 45, sourceIn: 0, sourceOut: 5, enabled: false }),
    ]),
    track("video", [clip({ id: "c", timelineIn: 60, sourceIn: 0, sourceOut: 30 })]),
    track("video", [clip({ id: "hidden", timelineIn: 15, sourceIn: 0, sourceOut: 5, label: "Hidden" })], { hidden: true }),
  ]);
  expect(buildFinalCutChapters(tl, [], 90).map(c => `${c.timestamp} ${c.title}`)).toEqual(["0:00 Intro", "0:30 Demo", "1:00 Section 3"]);
  // One clip, or none, gives a single Intro.
  expect(buildFinalCutChapters(timeline([track("video", [clip({ id: "a", timelineIn: 0, sourceIn: 0, sourceOut: 90 })])]), [], 90))
    .toEqual([{ time: 0, timestamp: "0:00", title: "Intro" }]);
});

it("chooses more chapters for longer videos", () => {
  const count = (duration: number) => {
    const words: FinalTimelineWord[] = [];
    for (let t = 0; t < duration; t += 3) words.push(word(t % 30 === 27 ? `end${t}.` : `w${t}`, t));
    return buildFinalCutChapters(timeline([]), words, duration).length;
  };
  expect(count(20)).toBeLessThanOrEqual(3);
  expect(count(300)).toBeLessThanOrEqual(5);
  expect(count(600)).toBeLessThanOrEqual(6);
  expect(count(1200)).toBe(8);
  expect(count(1200)).toBeGreaterThan(count(300));
});
