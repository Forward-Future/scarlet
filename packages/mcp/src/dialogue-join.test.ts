import { describe, expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip, type MediaAsset } from "@scarlet/timeline";
import { AIR_AFTER_SPEECH, AIR_BEFORE_SPEECH, checkDialogueJoin, clipEdgeSound, joinAudio, joinEvidence, padEdge, pauseCutRange, wordCutRange, type JoinPage } from "./dialogue-join.js";

const words = [
  { start: 1, end: 1.38, text: "finish" }, { start: 1.8, end: 2.2, text: "first" },
  { start: 3.4, end: 3.86, text: "next" },
];
const voice = [{ start: .98, end: 1.44 }, { start: 1.8, end: 2.26 }, { start: 3.4, end: 3.94 }];
const levels = Array.from({ length: 250 }, (_, i) => voice.some(v => v.start <= i/50 && i/50 < v.end) ? .12 : .001);
const page: JoinPage = { mediaId: "mic", start: 0, end: 5, edges: joinEvidence(words, {
  from: 0, to: 5, peaks: levels, rms: levels, speechActivity: voice,
}) };
function fixture() {
  const p = createProject("Retake", { fps: 30 });
  const asset = { id: "mic", kind: "audio", name: "Mic", path: "mic.wav", hasAudio: true } satisfies MediaAsset;
  p.media = [asset, { ...asset, id: "guest" }];
  const tl = emptyTimeline(p.id);
  tl.tracks[1]!.clips = [makeMediaClip("mic", 0, 5, 0)];
  return { p, tl };
}

describe("native retake boundaries", () => {
  it("only moves inward, past complete edge words, onto project frames in quiet audio", () => {
    const { p, tl } = fixture();
    const fixed = checkDialogueJoin(tl,p,{start:1.15,end:3.6},[page]);
    expect(fixed.status).toBe("adjusted");
    expect(fixed.start).toBeGreaterThan(1.44);
    expect(fixed.end).toBeLessThan(3.4);
    expect(fixed.start * 30).toBeCloseTo(Math.round(fixed.start * 30));
    expect(fixed.end * 30).toBeCloseTo(Math.round(fixed.end * 30));
    expect(fixed.reason).toMatch(/finish.*next/);
    expect(checkDialogueJoin(tl,p,{start:fixed.start,end:fixed.end},[page]).status).toBe("unchanged");
  });
  it("maps source evidence through offset and speed and ignores muted scratch sound", () => {
    const { p, tl } = fixture();
    tl.tracks[1]!.clips = [makeMediaClip("mic", 1, 4, 6, { speed: 2 })];
    tl.tracks[0]!.clips = [makeMediaClip("guest", 0, 4, 5, { volume: 0 })];
    const r = checkDialogueJoin(tl,p,{start:6.075,end:7.3},[page]);
    expect(r.status).toBe("adjusted");
    expect(1+(r.start-6)*2).toBeGreaterThan(1.44);
    expect(1+(r.end-6)*2).toBeLessThan(3.4);
    tl.tracks[0]!.clips[0] = makeMediaClip("guest", 0, 4, 5);
    expect(checkDialogueJoin(tl,p,{start:6.075,end:7.3},[page]).status).toBe("review");
  });
  it("keeps the original proposal when the word or acoustic evidence is incomplete", () => {
    const { p, tl } = fixture(); const range = { start:1.15,end:3.6 };
    for (const edges of [undefined, { ...page.edges!, quiet: [], valleys: [] }, { ...page.edges!, voice: [] },
      { ...page.edges!, words: [] }]) {
      expect(checkDialogueJoin(tl,p,range,[{...page,edges}])).toMatchObject({...range,status:"review"});
    }
    expect(checkDialogueJoin(tl,p,{start:1.15,end:1.3},[page]).status).toBe("review");
    expect(checkDialogueJoin(tl,p,{start:0,end:5},[]).status).toBe("unchanged");
  });
  it("places an edge under a second recording that is silent there and has no words, and not under one that sounds", () => {
    const { p, tl } = fixture();
    const second = (level: number): JoinPage => ({ mediaId: "guest", start: 0, end: 5, edges: joinEvidence([], {
      from: 0, to: 5, peaks: Array<number>(250).fill(level), rms: Array<number>(250).fill(level), speechActivity: [] }) });
    // The mic alone: a start 50 ms into “first” snaps onto the pause before it, a retake cut inside two words is narrowed, quiet edges stay.
    const ranges = [{ start: 1.85, end: 2.8 }, { start: 1.15, end: 3.6 }, { start: 1.7, end: 2.8 }];
    const alone = ranges.map(range => checkDialogueJoin(tl, p, range, [page]));
    expect(alone.map(r => r.status)).toEqual(["snapped", "adjusted", "unchanged"]);
    // A screen capture's own audio track plays with the mic: measured, silent from end to end, nothing said on it.
    // Every edge lands where the mic alone puts it.
    tl.tracks[0]!.clips = [makeMediaClip("guest", 0, 5, 0)];
    expect(ranges.map(range => checkDialogueJoin(tl, p, range, [page, second(.001)]))).toEqual(alone);
    // A music bed sounds at the edge and has no words to say what a move would cross: there is still nothing to act on.
    expect(checkDialogueJoin(tl, p, ranges[0]!, [page, second(.12)])).toMatchObject({ ...ranges[0], status: "review", unmeasured: true });
    // One recording is judged as before: its edge on sound, with no voice activity or no words read, stays unmeasured.
    tl.tracks[0]!.clips = [];
    for (const edges of [{ ...page.edges!, voice: [] }, { ...page.edges!, words: [] }]) {
      expect(checkDialogueJoin(tl, p, ranges[1]!, [{ ...page, edges }])).toMatchObject({ ...ranges[1], status: "review", unmeasured: true,
        reason: expect.stringContaining("The scan lacks the voice activity or word timings to place this edge.") });
    }
  });
  it("preserves a repairable edge when the opposite one remains uncertain, and flags speech-detector disagreement", () => {
    const { p, tl } = fixture();
    const edges = { ...page.edges!, quiet: [{ start:1.44,end:1.78 }], valleys: [] };
    const range = {start:1.15,end:3.6};
    const partial = checkDialogueJoin(tl,p,range,[{...page,edges}]);
    expect(partial).toMatchObject({status:"partial",end:3.6});
    expect(partial.start).toBeGreaterThan(1.44);
    expect(partial.reason).toContain("next");
    // A short trough under active voice stays an audition. A long one is measured silence.
    const valley = checkDialogueJoin(tl,p,{start:1.15,end:4.4},[{...page,edges:{...edges,quiet:[],valleys:[{start:1.45,end:1.53}]}}]);
    expect(valley.status).toBe("partial");
    expect(valley.reason).toMatch(/voice activity continues/i);
    const trough = checkDialogueJoin(tl,p,{start:1.15,end:3.6},[{...page,edges:{...edges,quiet:[],valleys:[{start:1.44,end:1.78},{start:2.26,end:3.4}]}}]);
    expect(trough.status).toBe("adjusted");
  });
  it("does not skip a neighboring word or use a coarse waveform", () => {
    const { p, tl } = fixture();
    const edges={...page.edges!,valleys:[],quiet:[{start:1.85,end:2.1}]};
    // The end sits at room tone between words, so only the start, inside “finish”, is left for the editor.
    expect(checkDialogueJoin(tl,p,{start:1.15,end:4.4},[{...page,edges}])).toMatchObject({ status: "partial", start: 1.15 });
    const tiny = { start: 1.40, end: 1.41, text: "a" };
    expect(checkDialogueJoin(tl,p,{start:1.15,end:4.4},[{...page,edges:{...page.edges!,words:[...words,tiny]}}]).status).toBe("review");
    expect(checkDialogueJoin(tl,p,{start:1.15,end:4.4},[{...page,audioStream:2}]).status).toBe("review");
    expect(joinEvidence(words,{from:0,to:5,peaks:[.001],rms:[.001],speechActivity:voice})).toBeUndefined();
  });
  it("checks the recording at an edge the transcript calls a word gap", () => {
    const { p, tl } = fixture();
    // The transcript ends “finish” at 1.38, but the voice runs to 1.44. A cut at 1.40 would clip its tail.
    // The edge lands in the pause 0.15 s after the voice ends (1.59), on the nearest frame.
    const tail = checkDialogueJoin(tl,p,{start:1.40,end:2.8},[page]);
    expect(tail).toMatchObject({ status: "snapped", start: 1.6, end: 2.8 });
    expect(tail.reason).toMatch(/into the pause/);
    expect(checkDialogueJoin(tl,p,{start:tail.start,end:tail.end},[page]).status).toBe("unchanged");
  });
  it("trims a fragment of the removed take onto the silence before it", () => {
    const { p, tl } = fixture();
    // The removal should start before “first”, but begins 50 ms after its onset. The nearest silent frame
    // (53/30) is only a fragment trim, so it still snaps, and the edge then sits 0.15 s after “finish”.
    const fragment = checkDialogueJoin(tl,p,{start:1.85,end:2.8},[page]);
    expect(fragment.status).toBe("snapped");
    expect(fragment.start).toBeCloseTo(48/30);
    expect(fragment.reason).toMatch(/earlier.*first/);
  });
  it("trusts measured silence over a stretched word timing", () => {
    const { p, tl } = fixture();
    const stretched = [...words, { start: 2.3, end: 3.35, text: "um" }];
    const edges = joinEvidence(stretched, { from: 0, to: 5, peaks: levels, rms: levels, speechActivity: voice })!;
    expect(checkDialogueJoin(tl,p,{start:2.8,end:3.2},[{...page,edges}]).status).toBe("unchanged");
  });
  it("describes the audio around each edge for the editing model", () => {
    const { p, tl } = fixture();
    const [start, end] = joinAudio(tl,p,{start:1.40,end:2.8},[page]);
    expect(start).toMatchObject({ edge: "start", at: 1.4, sound: "sound", quietAfter: 1.47 });
    expect(start!.levels).toMatch(/^(-?\d+ ){15}\| -?\d+/);
    expect(start!.words).toContain("finish[1.00-1.38]");
    expect(end).toMatchObject({ edge: "end", sound: "quiet" });
  });
  it("pads an edge it places: air after kept speech, air before speech resumes, split when the pause is short", () => {
    expect(padEdge({ start: 1, end: 2 }, "start")).toBeCloseTo(1 + AIR_AFTER_SPEECH);
    expect(padEdge({ start: 1, end: 2 }, "end")).toBeCloseTo(2 - AIR_BEFORE_SPEECH);
    // 0.2 s is shorter than both; both edges take the same proportional point.
    expect(padEdge({ start: 1, end: 1.2 }, "start")).toBeCloseTo(1.12);
    expect(padEdge({ start: 1, end: 1.2 }, "end")).toBeCloseTo(1.12);
    // An edge already in silence is the model's pacing and stays where it is.
    const { p, tl } = fixture();
    expect(checkDialogueJoin(tl,p,{start:1.7,end:2.8},[page])).toMatchObject({ status: "unchanged", start: 1.7 });
    // Moving an end edge out of “next” leaves 0.10 s before it resumes.
    const end = checkDialogueJoin(tl,p,{start:2.4,end:3.45},[page]);
    expect(end.status).toBe("snapped");
    expect(end.end).toBeCloseTo(3.3);
  });
  it("puts an edge beside the kept word when a deep trough lies inside the quiet run", () => {
    // The room goes almost silent from 2.5 to 2.9 s, inside the quiet that runs from “first” to “next”. The trough is
    // listed beside that run, and the edge before “next” used to land at the trough's end, half a second early.
    const at = () => ({ ...page.edges!, valleys: [{ start: 2.5, end: 2.9 }] });
    const cut = wordCutRange(words, 1, 1, at);
    expect(cut.start).toBeCloseTo(1.44 + AIR_AFTER_SPEECH);
    expect(cut.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
    // A pause named by its word is trimmed the same way: “first” ends at 2.2 s by its timing and sounds until 2.26 s.
    const pause = pauseCutRange(words[1]!, words[2]!, at);
    expect(pause).toMatchObject({ problems: [], plays: expect.closeTo(1.2) });
    expect(pause.start).toBeCloseTo(2.2 + AIR_AFTER_SPEECH);
    expect(pause.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
  });
  it("puts a seconds edge at the room-tone dip between two words said in one breath instead of holding the cut", () => {
    const { p, tl } = fixture();
    // “one two”, run together with a 40 ms dip at 1.48–1.52 s, then a pause and “three”.
    const said = [{ start: 1, end: 1.5, text: "one" }, { start: 1.5, end: 2, text: "two" }, { start: 2.6, end: 3, text: "three" }];
    const rms = Array.from({ length: 250 }, (_, i) => i === 74 || i === 75 ? .0005 : (i >= 50 && i < 100) || (i >= 130 && i < 150) ? .12 : .001);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: 1, end: 2 }, { start: 2.6, end: 3 }] });
    const pages: JoinPage[] = [{ mediaId: "mic", start: 0, end: 5, edges }];
    // The cut starts just inside “two”: the edge goes back to the boundary, not half a second on into the pause.
    expect(checkDialogueJoin(tl, p, { start: 1.53, end: 2.3 }, pages)).toMatchObject({ status: "snapped", start: 1.5, end: 2.3,
      reason: expect.stringContaining("lowest level between the words (-66 dBFS)") });
    // Both edges at dips: a removal from the middle of running speech still goes to the editor.
    const both = Array.from({ length: 250 }, (_, i) => i === 74 || i === 75 || i === 124 || i === 125 ? .0005 : i >= 50 && i < 150 ? .12 : .001);
    const run = [{ start: 1, end: 1.5, text: "one" }, { start: 1.5, end: 2.5, text: "two" }, { start: 2.5, end: 3, text: "three" }];
    const ran = joinEvidence(run, { from: 0, to: 5, peaks: both, rms: both, speechActivity: [{ start: 1, end: 3 }] });
    expect(checkDialogueJoin(tl, p, { start: 1.53, end: 2.47 }, [{ mediaId: "mic", start: 0, end: 5, edges: ran }])).toMatchObject({ status: "review",
      reason: expect.stringContaining("No pause on either side") });
  });

  it("holds a word cut from the middle of running speech, with a dip on both sides and a pause on neither", () => {
    // “at the the base”, said in one breath, with 20 ms dips either side of the first “the”.
    const run = [{ start: 1, end: 1.2, text: "at" }, { start: 1.2, end: 1.4, text: "the" }, { start: 1.4, end: 1.6, text: "the" }, { start: 1.6, end: 2, text: "base" }];
    const rms = Array.from({ length: 150 }, (_, i) => i === 60 || i === 70 ? .001 : i >= 50 && i < 100 ? .12 : .001);
    const edges = joinEvidence(run, { from: 0, to: 3, peaks: rms, rms, speechActivity: [{ start: 1, end: 2 }] });
    const cut = wordCutRange(run, 1, 1, () => edges);
    expect(cut.dips).toHaveLength(2);
    expect(cut.problems).toEqual(["No pause on either side of “the”: both edges sit between words that run together."]);
  });
  it("resolves a word range to padded edges in the measured gaps beside it", () => {
    const at = () => page.edges;
    // Remove “first”: kept “finish” ends at 1.44 by the recording, “next” resumes at 3.4.
    const cut = wordCutRange(words, 1, 1, at);
    expect(cut.problems).toEqual([]);
    expect(cut.text).toBe("first");
    expect(cut.start).toBeCloseTo(1.44 + AIR_AFTER_SPEECH);
    expect(cut.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
    // Without a kept neighbor the cut runs to the start or end of the material.
    expect(wordCutRange(words, 0, 0, at).start).toBe(0);
    expect(wordCutRange(words, 2, 2, at).end).toBe(Infinity);
    // No measured silence: the edge falls back to the word timings and says so.
    const deaf = wordCutRange(words, 1, 1, () => ({ ...page.edges!, quiet: [], valleys: [], levels: undefined }));
    expect(deaf.problems).toHaveLength(2);
    // A stray word with a gap before it and none after: “With” runs straight into “the”. Both edges used to find
    // that one gap and the range came out empty. The gap is the start's; the end uses the word timing and says so.
    const run = [{ start: 9.5, end: 9.7, text: "good." }, { start: 10.0, end: 10.28, text: "With" }, { start: 10.28, end: 10.5, text: "the" }];
    const stray = wordCutRange(run, 1, 1, () => ({ ...page.edges!, quiet: [{ start: 9.72, end: 9.98 }], valleys: [] }));
    expect(stray.start).toBeGreaterThan(9.72);
    expect(stray.start).toBeLessThan(9.98);
    expect(stray.end).toBeCloseTo(10.28);
    expect(stray.problems).toEqual(["No measured silence between “With” and “the”. The end uses the word timing."]);
    expect(deaf.problems[0]).toMatch(/No measured silence between “finish” and “first”/);
    expect(deaf.start).toBeCloseTo((1.38 + 1.8) / 2);
  });
  it("places a word cut outside the utterances the scan resolves inside a stretched word", () => {
    const saved = [{ text: "turn", start: .6, end: 1 }, { text: "Right,", start: 1, end: 2.2 }, { text: "here.", start: 2.2, end: 2.8 }];
    const scan = [saved[0]!, { text: "right", start: 1.02, end: 1.16 }, { text: "right", start: 2, end: 2.18 }, saved[2]!];
    // No full pause on either outside edge. The tempting quiet run between the two sayings would keep one.
    const levels = Array.from({ length: 150 }, (_, i) => i === 49 || i === 110 || (i >= 59 && i < 100) ? .0001 : .1);
    const edges = joinEvidence(scan, { from: 0, to: 3, rms: levels, peaks: levels, speechActivity: [{ start: .6, end: 2.8 }] });
    const removed = wordCutRange(saved, 1, 1, () => edges);
    expect(removed.start).toBeCloseTo(.99);
    expect(removed.end).toBeCloseTo(2.21);
    expect(removed.dips).toHaveLength(2);
    expect(removed.problems).toHaveLength(1); // Two dips without a pause still require audition.
  });
  it("places a word range beside the kept words when a pause is longer than the page read at its middle", () => {
    // One page of levels over `from`–`to`, loud where `voiced` says and room tone elsewhere.
    const read = (from: number, to: number, voiced: Array<{ start: number; end: number }>): JoinPage => {
      const level = Array.from({ length: Math.round((to - from) * 50) }, (_, i) => voiced.some(v => v.start <= from + (i + .5) / 50 && from + (i + .5) / 50 < v.end) ? .12 : .001);
      return { mediaId: "mic", start: from, end: to, edges: joinEvidence([], { from, to, peaks: level, rms: level, speechActivity: voiced }) };
    };
    // The page with the most around an instant, as a word reference picks it.
    const at = (pages: JoinPage[]) => (t: number) => pages.filter(p => p.start <= t && p.end >= t)
      .sort((a, b) => Math.min(t - b.start, b.end - t) - Math.min(t - a.start, a.end - t))[0]?.edges;
    // Eight seconds of silence either side of “two three”. Without a scan Scarlet reads five seconds around the middle
    // of each gap, and neither reading reaches the kept word: each shows the pause from its own first moment to its last.
    const spoken = [{ start: 1, end: 1.4, text: "one" }, { start: 9.4, end: 9.8, text: "two" }, { start: 10.2, end: 10.6, text: "three" }, { start: 18.6, end: 19, text: "four" }];
    const middles = [read(3, 8, spoken), read(12, 17, spoken)];
    // With a reading at each kept word's edge too, the cut takes both pauses down to the air beside “one” and “four”.
    const cut = wordCutRange(spoken, 1, 2, at([...middles, read(0, 4, spoken), read(16, 21, spoken)]));
    expect(cut.problems).toEqual([]);
    expect(cut.start).toBeCloseTo(1.4 + AIR_AFTER_SPEECH);
    expect(cut.end).toBeCloseTo(18.6 - AIR_BEFORE_SPEECH);
    // With nothing read there, the edges stay where the middle readings put them.
    const unread = wordCutRange(spoken, 1, 2, at(middles));
    expect(unread.start).toBeCloseTo(3 + AIR_AFTER_SPEECH);
    expect(unread.end).toBeCloseTo(17 - AIR_BEFORE_SPEECH);
    // A stray word after such a pause: “With” runs straight into “the”, so both its edges find the pause before it.
    // That pause is still the start's, now placed beside “good.”, and the end uses the word timing and says so.
    const run = [{ start: 1, end: 1.4, text: "good." }, { start: 7, end: 7.28, text: "With" }, { start: 7.28, end: 7.5, text: "the" }];
    const sounding = [{ start: 1, end: 1.4 }, { start: 7, end: 7.5 }];
    const stray = wordCutRange(run, 1, 1, at([read(3, 8, sounding), read(0, 4, sounding)]));
    expect(stray.start).toBeCloseTo(1.4 + AIR_AFTER_SPEECH);
    expect(stray.end).toBeCloseTo(7.28);
    expect(stray.problems).toEqual(["No measured silence between “With” and “the”. The end uses the word timing."]);
    // A gap the middle reading shows from word to word is placed from that reading alone, as before. Here another page
    // has more around the end of “finish” and hears its voice run on to 1.5 s, where the middle's hears it stop at 1.44 s.
    const middle = read(1, 5, voice), beside = read(0, 2, [{ start: .98, end: 1.5 }, voice[1]!]);
    expect([at([beside, middle])(1.38), at([beside, middle])(1.59)]).toEqual([beside.edges, middle.edges]);
    const short = wordCutRange(words, 1, 1, at([beside, middle]));
    expect(short.start).toBeCloseTo(1.44 + AIR_AFTER_SPEECH);
    expect(short.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
  });
});

describe("a clip edge in sound", () => {
  // “…logo” runs straight into “by” with one 20 ms dip between. Seconds later an “uh” the transcript has no word
  // for ends 100 ms before “obviously”. “apple” has a stop inside it and “tree” follows with no pause.
  const said = [{ start: 1, end: 1.36, text: "logo," }, { start: 1.36, end: 1.6, text: "by" }, { start: 2.28, end: 2.9, text: "obviously" },
    { start: 3, end: 3.4, text: "apple" }, { start: 3.4, end: 3.8, text: "tree" }];
  const loud: Array<[number, number]> = [[1, 1.36], [1.38, 1.6], [2, 2.18], [2.28, 2.9], [3, 3.3], [3.32, 3.8], [4, 4.06]];
  const rms = Array.from({ length: 250 }, (_, i) => loud.some(([a, b]) => i / 50 >= a - 1e-9 && i / 50 < b - 1e-9) ? .06 : .0015);
  const heard: JoinPage = { mediaId: "mic", start: 0, end: 5, edges: joinEvidence(said, { from: 0, to: 5, peaks: rms, rms,
    speechActivity: [{ start: .95, end: 1.65 }, { start: 1.95, end: 2.95 }, { start: 2.98, end: 3.85 }] }) };
  const edge = (t: number, side: "in" | "out") => clipEdgeSound([heard], "mic", 0, t, side);

  it("finds the piece of an unexplained sound a clip starts inside, and the quiet that ends it", () => {
    expect(edge(2.142, "in")).toMatchObject({ fragment: { seconds: expect.closeTo(.038, 3), db: -24, quietAt: 2.19, quietDb: -56 }, levels: expect.stringContaining("|") });
    expect(edge(2.142, "in")).not.toHaveProperty("word");
    // In the quiet after it, or before the sound begins, the same clip is clean.
    expect(edge(2.22, "in")).toBeUndefined();
    expect(edge(1.9, "in")).toBeUndefined();
  });

  it("finds the first sound of the next word a clip ends one frame into, and leaves the dip between the words alone", () => {
    expect(edge(1.41, "out")).toMatchObject({ word: "by", fragment: { seconds: expect.closeTo(.03, 3), quietAt: 1.37 } });
    // Half a frame in is still inside the word. A few milliseconds past the dip is the dip.
    expect(edge(1.397, "out")).toMatchObject({ word: "by" });
    expect(edge(1.363, "out")).toBeUndefined();
    expect(edge(1.379, "out")).toBeUndefined();
  });

  it("keeps a kept word's own stop consonant, a whole short sound, and an edge no page measured", () => {
    expect(edge(3.4, "out")).toBeUndefined();
    expect(edge(4, "in")).toBeUndefined();
    expect(clipEdgeSound([heard], "guest", 0, 2.142, "in")).toBeUndefined();
    expect(clipEdgeSound([heard], "mic", 1, 2.142, "in")).toBeUndefined();
  });

  it("names a word split through its middle with no quiet in reach", () => {
    expect(edge(2.6, "out")).toMatchObject({ word: "obviously" });
    expect(edge(2.6, "out")).not.toHaveProperty("fragment");
  });
});
