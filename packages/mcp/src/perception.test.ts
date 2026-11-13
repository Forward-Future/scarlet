import { describe, expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, makeTrack, type Timeline, type TimeRange, type TranscriptWord } from "@scarlet/timeline";
import { fuzzySearchTranscript, normalizeTranscriptToken } from "@scarlet/shared";
import { auditJoin, formatTimelineTranscript, newJoins, round, sourceRangeToTimeline, sourceToTimeline, timelineJoins, timelineWords, type Reading } from "./timeline-perception.js";
import { captionSourceClips } from "./analysis.js";
import { levelProfile, pauseStats, retakeGroups } from "./media-profile.js";

const words = (list: Array<[string, number, number, string?]>): TranscriptWord[] =>
  list.map(([text, start, end, speaker]) => ({ text, start, end, ...(speaker && { speaker }) }));

/** Two cuts of one mic: source 0–4 then 6–10, so one join at timeline 4 jumping source 4 → 6. */
function cutTimeline() {
  const tl = emptyTimeline("p");
  tl.version = "v2";
  tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 4, 0, { volume: 0 }), makeMediaClip("cam", 6, 10, 4, { volume: 0 })];
  tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 4, 0), makeMediaClip("mic", 6, 10, 4)];
  return tl;
}

describe("timeline perception", () => {
  it("finds joins on audible tracks only and the joins a change created", () => {
    const tl = cutTimeline();
    const joins = timelineJoins(tl);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ at: 4, tracks: [{ trackId: "a1", out: { mediaId: "mic", source: 4 }, in: { mediaId: "mic", source: 6 } }] });
    const before = emptyTimeline("p");
    before.tracks[1]!.clips = [makeMediaClip("mic", 0, 10, 0)];
    expect(newJoins(before, tl)).toHaveLength(1);
    expect(newJoins(tl, tl)).toHaveLength(0);
    // A split that keeps the source continuous is not a join.
    before.tracks[1]!.clips = [makeMediaClip("mic", 0, 5, 0), makeMediaClip("mic", 5, 10, 5)];
    expect(timelineJoins(before)).toHaveLength(0);
  });

  it("maps source times and ranges onto the edit, including what was cut", () => {
    const tl = cutTimeline();
    expect(sourceToTimeline(tl, "mic", 7)).toEqual([{ trackId: "a1", clipId: tl.tracks[1]!.clips[1]!.id, time: 5, audible: true }]);
    expect(sourceToTimeline(tl, "mic", 5)).toEqual([]);
    const { placed, missing } = sourceRangeToTimeline(tl, "mic", 3, 8);
    expect(placed.map(p => [p.start, p.end])).toEqual([[3, 4], [4, 6]]);
    expect(missing).toEqual([{ start: 4, end: 6 }]);
  });

  it("reads the edit's words in playback order with stable indices and marks each join", () => {
    const tl = cutTimeline();
    const mic = words([["So", .5, .7], ["today", .8, 1.1], ["we", 1.2, 1.3], ["uh", 4.5, 4.8], ["Today", 6.3, 6.6], ["we", 6.7, 6.8], ["build.", 6.9, 7.3]]);
    const placed = timelineWords(tl, new Map([["mic", mic]]));
    expect(placed.map(w => [w.index, w.text, w.start])).toEqual([[0, "So", .5], [1, "today", .8], [2, "we", 1.2], [4, "Today", 4.3], [5, "we", 4.7], [6, "build.", 4.9]]);
    const text = formatTimelineTranscript(placed, timelineJoins(tl), { detail: "lines", fps: 30 });
    expect(text.split("\n")).toEqual([
      "mediaId mic",
      "0.50 #0 So today we",
      "‖ join 1 at 4.00 (0:04.00) mic 4.00→6.00 “we” | “Today”",
      "4.30 #4 Today we build.",
    ]);
    expect(formatTimelineTranscript(placed, timelineJoins(tl), { detail: "words", fps: 30 })).toContain("4.30-4.60 #4 Today");
    const page = [placed[3]!, { ...placed[4]!, mediaId: "guest", index: 0 }, placed[5]!];
    for (const detail of ["lines", "words"] as const) {
      const listed = formatTimelineTranscript(page, [], { detail, fps: 30 }).split("\n");
      expect(listed.filter(line => line.startsWith("mediaId "))).toEqual(["mediaId mic", "mediaId guest", "mediaId mic"]);
      expect(listed[1]).toContain("#4 Today"); // The source index survives the cut and the page offset.
      expect(listed[3]).toContain("#0 we");
    }
  });
});

/** A 20 ms reading: `loud` ranges at -20 dBFS, the rest at the given floor. */
function reading(from: number, to: number, loud: Array<[number, number]>, floor = .001, voice = loud): Reading {
  const n = Math.round((to - from) / .02);
  const rms = Array.from({ length: n }, (_, i) => {
    const t = from + (i + .5) * .02;
    return loud.some(([a, b]) => t >= a && t < b) ? .1 : floor;
  });
  return { from, to, rms, peaks: rms.map(r => r * 2), speechActivity: voice.map(([start, end]) => ({ start, end })) };
}

describe("join audit", () => {
  const side = { trackId: "a1", out: { trackId: "a1", clipId: "a", mediaId: "mic", source: 4 }, in: { trackId: "a1", clipId: "b", mediaId: "mic", source: 6 } };

  it("measures the kept word to the crossfade center at playback speed when voice activity bridges its quiet tail", () => {
    const out = reading(3, 4.3, [[3, 3.7]], .001, [[3, 4.1]]);
    const audit = auditJoin(1, 2, { ...side, overlap: .1, outClip: { speed: 2, sourceIn: 1, joinSource: 3.9 } },
      out, reading(5.7, 7, [[6.1, 7]]), { out: words([["old", 0, .9], ["kept", 3.3, 3.7], ["handle", 3.91, 3.99]]) });
    expect(audit.airAfter).toBe(0);
    expect(audit.out).toMatchObject({ lastWord: "kept", lastWordEnd: 3.7, wordEndToJoin: .1, levelQuiet: .3 });
  });

  it("calls a join with air on both sides and matching room tone clean", () => {
    const audit = auditJoin(1, 4, side, reading(3, 4.3, [[3, 3.8]]), reading(5.7, 7, [[6.12, 7]]));
    expect(audit.verdict).toBe("clean");
    expect(audit.airAfter).toBeCloseTo(.2);
    expect(audit.airBefore).toBeCloseTo(.12);
    expect(audit.levels.split(" | ").map(s => s.split(" ").length)).toEqual([15, 15]);
    expect(audit.levels).toMatch(/^-20 .* -60 \| -60 .* -20/);
    expect(audit.jumpDb).toBe(0);
  });

  it("reports a clipped word, an edge on speech, tight air and a room-tone jump", () => {
    const clipped = auditJoin(1, 4, side, reading(3, 4.3, [[3.5, 4.2]]), reading(5.7, 7, [[6.2, 7]]),
      { out: words([["really", 3.6, 4.2]]), in: words([["next", 6.2, 6.5]]) });
    expect(clipped.verdict).toBe("check: cuts off “really”");
    expect(clipped.out.clipped).toBe("really");
    const onSpeech = auditJoin(1, 4, side, reading(3, 4.3, [[3.5, 3.97]]), reading(5.7, 7, [[5.9, 7]]));
    expect(onSpeech.verdict).toBe("check: only 0.02 s after the last sound; incoming edge on speech");
    const room = auditJoin(1, 4, side, reading(3, 4.3, [[3, 3.7]], .001), reading(5.7, 7, [[6.3, 7]], .004));
    expect(room.verdict).toBe("check: room tone rises 12 dB");
    // Two inaudible floors (a gated mic) differ without anyone hearing it.
    expect(auditJoin(1, 4, side, reading(3, 4.3, [[3, 3.7]], .00005), reading(5.7, 7, [[6.3, 7]], .0002)).verdict).toBe("clean");
    // Whisper stretched “really” over a measured pause: the recording decides, the timing is only noted.
    const stretched = auditJoin(1, 4, side, reading(3, 4.3, [[3, 3.6]]), reading(5.7, 7, [[6.2, 7]]), { out: words([["really", 3.2, 4.3]]) });
    expect(stretched.verdict).toBe("clean");
    expect(stretched.out).toMatchObject({ stretchedWord: "really" });
  });
});

describe("media profile", () => {
  it("measures room tone away from words and per-speaker pauses", () => {
    const list = words([["a", 0, .5, "S1"], ["b", .8, 1.2, "S1"], ["c", 1.6, 2, "S1"], ["d", 6, 6.4, "S1"], ["e", 6.5, 7, "S2"]]);
    expect(pauseStats(list)).toEqual([{ speaker: "S1", pauses: 2, median: .4, p90: .4, over3s: 1 }]);
    const rms = Array.from({ length: 80 }, (_, i) => (list.some(w => i / 10 >= w.start && i / 10 < w.end) ? .1 : .001));
    expect(levelProfile({ from: 0, to: 8, rms }, list)).toMatchObject({ roomToneDbfs: -60, speechDbfs: -20 });
  });

  it("groups nearby repeats of a line as retake evidence with word ranges", () => {
    const list = words([
      ["So", 0, .2], ["today", .3, .6], ["we're", .7, .9], ["going.", 1, 1.2],
      ["So", 2, 2.2], ["today", 2.3, 2.6], ["we're", 2.7, 2.9], ["going", 3, 3.2], ["to", 3.3, 3.4], ["build", 3.5, 3.8], ["it.", 3.9, 4.1],
      ["Something", 6, 6.4], ["else", 6.5, 6.8], ["entirely", 6.9, 7.3], ["here.", 7.4, 7.6],
    ]);
    const groups = retakeGroups(list);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.takes.map(t => t.words)).toEqual([[0, 3], [4, 10]]);
    expect(groups[0]!.score).toBeGreaterThan(.9);
  });

  it("finds a paraphrased line by token similarity", () => {
    const list = words([["we", 0, .1], ["are", .2, .3], ["gonna", .4, .6], ["build", .7, .9], ["the", 1, 1.1], ["thing", 1.2, 1.4]]);
    const [hit] = fuzzySearchTranscript(list, "we are going to build the things");
    expect(hit).toMatchObject({ wordIndex: 0, text: "we are gonna build the thing" });
    expect(hit!.score).toBeGreaterThanOrEqual(.6);
    expect(fuzzySearchTranscript(list, "completely unrelated words")).toEqual([]);
  });
});

it("reads a short overlap as a crossfaded join at its center, and a long one as a layer", () => {
  const tl = emptyTimeline("p");
  tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 4.033, 0), makeMediaClip("mic", 5.967, 10, 3.967)];
  expect(timelineJoins(tl)).toEqual([{ at: 4, tracks: [expect.objectContaining({ overlap: .066, out: expect.objectContaining({ source: 4.033 }),
    in: expect.objectContaining({ source: 5.967 }) })] }]);
  tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 10, 0), makeMediaClip("mic", 20, 22, 4)];
  expect(timelineJoins(tl)).toEqual([]);
});

/** timelineWords before it indexed each recording: every clip scans every word. */
function scanEveryWord(tl: Timeline, transcripts: Map<string, TranscriptWord[]>, range?: TimeRange) {
  const out: Array<{ mediaId: string; index: number; text: string; start: number; end: number; speaker?: string }> = [];
  for (const clip of captionSourceClips(tl, id => transcripts.has(id))) {
    const speed = clip.speed ?? 1;
    transcripts.get(clip.mediaId)!.forEach((w, index) => {
      const mid = (w.start + w.end) / 2;
      if (mid < clip.sourceIn || mid >= clip.sourceOut) return;
      const start = round(clip.timelineIn + Math.max(0, w.start - clip.sourceIn) / speed);
      const end = round(clip.timelineIn + Math.min(clip.sourceOut - clip.sourceIn, w.end - clip.sourceIn) / speed);
      if (range && (end < range.start || start > range.end)) return;
      out.push({ mediaId: clip.mediaId, index, text: w.text.trim(), start, end: Math.max(start, end), ...(w.speaker && { speaker: w.speaker }) });
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out.filter((w, i) => !out.slice(Math.max(0, i - 3), i).some(p => Math.abs(p.start - w.start) < .03 &&
    normalizeTranscriptToken(p.text) === normalizeTranscriptToken(w.text)));
}

it("lists the same timeline words as scanning every word per clip, across many clips and recordings", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const vocabulary = ["so", "today", "we're", "going", "to", "build", "it.", "um", "the", "thing"];
  const recording = (overlapping: boolean) => {
    const list: TranscriptWord[] = [];
    for (let t = 0; t < 120; t += .2 + random() * .4) {
      const start = Math.round(t * 1000) / 1000, end = Math.round((t + .1 + random() * .3) * 1000) / 1000;
      list.push({ text: vocabulary[Math.floor(random() * vocabulary.length)]!, start, end, ...(random() < .3 && { speaker: random() < .5 ? "S1" : "S2" }) });
      // A second speaker talking over the first puts midpoints out of transcript order.
      if (overlapping && random() < .15) list.push({ text: "yeah", start: Math.max(0, start - .5), end: start - .2 > 0 ? start - .2 : start, speaker: "S2" });
    }
    return list;
  };
  const transcripts = new Map([["mic", recording(true)], ["mic2", recording(false)]]);
  const tl = emptyTimeline("p");
  const a2 = makeTrack("audio", "A2", "a2");
  tl.tracks.push(a2);
  let at = 0;
  for (let source = 0; source < 110; ) {
    const length = .5 + random() * 2.5;
    tl.tracks[0]!.clips.push(makeMediaClip("mic", source, source + length, at, { volume: random() < .3 ? 1 : 0 }));
    tl.tracks[1]!.clips.push(makeMediaClip("mic", source, source + length, at));
    source += length + random() * 2;
    at += length;
  }
  // A faster second mic, and a passage of the first used twice.
  a2.clips.push(makeMediaClip("mic2", 10, 40, 0, { speed: 1.5 }), makeMediaClip("mic2", 50, 70, 30));
  tl.tracks[1]!.clips.push(makeMediaClip("mic", 20, 30, at));
  // Clip edges exactly on word midpoints: a word there belongs to the clip that starts at it.
  const mid = (list: TranscriptWord[], i: number) => (list[i]!.start + list[i]!.end) / 2;
  for (const [media, track, i] of [["mic2", a2, 150], ["mic", tl.tracks[1]!, 40]] as const) {
    const list = transcripts.get(media)!;
    track.clips.push(makeMediaClip(media, mid(list, i), mid(list, i + 6), at + 20), makeMediaClip(media, mid(list, i + 6), mid(list, i + 12), at + 40));
  }
  expect(tl.tracks[1]!.clips.length).toBeGreaterThan(30);
  for (const range of [undefined, { start: 0, end: at + 10 }, { start: 12.5, end: 47.3 }]) {
    const listed = timelineWords(tl, transcripts, range);
    expect(listed.length).toBeGreaterThan(20);
    expect(listed).toEqual(scanEveryWord(tl, transcripts, range));
  }
});
