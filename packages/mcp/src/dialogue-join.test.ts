import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip, type MediaAsset } from "@scarlet/timeline";
import { AIR_AFTER_SPEECH, AIR_BEFORE_SPEECH, checkDialogueJoin, clipEdgeSound, edgeOnFrame, quietFrameNote, soundBesideEdge, splitLeave, joinAudio, joinEvidence, padEdge, pauseCutRange, wordCutRange, type JoinPage } from "./dialogue-join.js";

// The stock guide states the pace a join leaves, and a pass that reads it sends that pace with its cuts. When the
// default moved to 0.20 s and 0.05 s the guide still said 0.15 s and 0.1 s, the wait before the voice the change took out.
it("states the engine's default pace in the stock dialogue guide", () => {
  const guide = readFileSync(new URL("../../../skills/dialogue-pass/SKILL.md", import.meta.url), "utf8");
  expect(guide).toContain(`leave about ${AIR_AFTER_SPEECH} s of room tone after the last kept word, for its decay, and ${AIR_BEFORE_SPEECH} s before speech resumes`);
});

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
  it("moves an edge in running speech onto the trough the recording shows between the words, wherever their timings say", () => {
    // “this game let me throw them”, said in one breath, then a pause and “next”. The transcript ends “game” at 1.56 s,
    // but the level between “game” and “let” falls at 1.49–1.52 s.
    const said = [{ start: 1, end: 1.3, text: "this" }, { start: 1.3, end: 1.56, text: "game" }, { start: 1.56, end: 1.7, text: "let" },
      { start: 1.7, end: 1.8, text: "me" }, { start: 1.8, end: 2.1, text: "throw" }, { start: 2.1, end: 2.4, text: "them" }, { start: 3.6, end: 3.9, text: "next" }];
    const talk = [{ start: 1, end: 2.4 }, { start: 3.6, end: 3.9 }];
    const at = (trough: number): JoinPage => {
      const rms = Array.from({ length: 500 }, (_, i) => i >= 149 && i <= 151 ? trough : talk.some(v => v.start <= i/100 && i/100 < v.end) ? .12 : .001);
      return { mediaId: "mic", start: 0, end: 5, edges: joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: talk }) };
    };
    const { p, tl } = fixture();
    // Cutting “let me throw them” and the pause, from just inside “let”.
    const placed = checkDialogueJoin(tl, p, { start: 1.57, end: 3.5 }, [at(.003)]);
    expect(placed).toMatchObject({ status: "snapped", start: 1.5, end: 3.5 });
    expect(placed.reason).toContain("start moved 0.07 s earlier onto the trough between the words in the recording (-50 dBFS");
    // A low point at -45 dBFS, 27 dB under the words either side, takes an edge within 50 ms of it (2026-11-16). One
    // further off is told of, not taken: the stop before a final “s” reads the same.
    expect(checkDialogueJoin(tl, p, { start: 1.54, end: 3.5 }, [at(.0056)])).toMatchObject({ status: "snapped", start: 1.5 });
    const told = checkDialogueJoin(tl, p, { start: 1.57, end: 3.5 }, [at(.0056)]);
    expect(told).toMatchObject({ status: "review", start: 1.57, inSound: ["start"] });
    expect(told.reason).toContain("The nearest quiet or low point is 0.05 s earlier at 1.515 s (-45 dBFS), with no word between");
    // Given there, the edge is on it.
    expect(checkDialogueJoin(tl, p, { start: 1.515, end: 3.5 }, [at(.0056)])).toMatchObject({ status: "snapped" });
    // A trough no lower than a sibilant's hiss is nowhere to cut. The check says where the sound parts either way,
    // and which words moving there keeps or takes out.
    const held = checkDialogueJoin(tl, p, { start: 1.57, end: 3.5 }, [at(.008)]);
    expect(held).toMatchObject({ status: "review", inSound: ["start"] });
    expect(held.reason).toBe("The start is in sound at -18 dBFS. The nearest quiet or low point is 0.58 s earlier at 0.995 s (-60 dBFS), " +
      "also removes “this” / “game”. Give the edge there, or name the words to remove.");
    // The trough is where the sound parts, not a licence to change which words go: an edge asked for after “let”
    // (1.7 s) has that trough a fifth of a second back, across the whole word, and stays where it was asked.
    expect(checkDialogueJoin(tl, p, { start: 1.7, end: 3.5 }, [at(.003)])).toMatchObject({ status: "review", start: 1.7 });
    // A word reference searches near where the transcript parts the words first. That window reaches only a little way
    // into the kept “game” and sees the trough's wall; the span between the two words' sounds holds its floor, at -50
    // dBFS, and the start goes there.
    const page = at(.003);
    const cut = wordCutRange(said, 2, 5, () => page.edges);
    expect(cut.dips).toEqual(["No pause between “game” and “let”: the start is at the lowest level between them (-50 dBFS)."]);
    expect(cut.start).toBeCloseTo(1.5, 1);
    expect(cut.problems).toEqual([]);
  });
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
    // The edge lands in the pause 0.05 s after the voice ends (1.49), on the nearest frame.
    const tail = checkDialogueJoin(tl,p,{start:1.40,end:2.8},[page]);
    expect(tail).toMatchObject({ status: "snapped", start: expect.closeTo(45/30, 5), end: 2.8 });
    expect(tail.reason).toMatch(/into the pause/);
    expect(checkDialogueJoin(tl,p,{start:tail.start,end:tail.end},[page]).status).toBe("unchanged");
  });
  it("places an end that gives back the start of the kept word, however far into the pause, without asking", () => {
    const { p, tl } = fixture();
    // “next” is timed from 3.4 s, but its sound starts at 3.1 s. An end at 3.38 s, typed from the transcript, is in that
    // sound and in no word; the quiet before it is 0.3 s back. Nothing kept is cut and nothing removed plays.
    const early = [{ start: .98, end: 1.44 }, { start: 1.8, end: 2.26 }, { start: 3.1, end: 3.94 }];
    const rms = Array.from({ length: 250 }, (_, i) => early.some(v => v.start <= i / 50 && i / 50 < v.end) ? .12 : .001);
    const pages = [{ ...page, edges: joinEvidence(words, { from: 0, to: 5, peaks: rms, rms, speechActivity: early }) }];
    const placed = checkDialogueJoin(tl, p, { start: 2.6, end: 3.38 }, pages);
    expect(placed.status).toBe("snapped");
    expect(placed.end).toBeLessThan(3.1);
    expect(placed.reason).toMatch(/end moved 0\.\d+ s earlier into the pause\./);
    // An end inside a word is still a question of which words were meant: it waits for the editor.
    expect(checkDialogueJoin(tl, p, { start: 2.6, end: 3.6 }, pages).status).not.toBe("snapped");
  });
  it("trims a fragment of the removed take onto the silence before it", () => {
    const { p, tl } = fixture();
    // The removal should start before “first”, but begins 50 ms after its onset. The nearest silent frame
    // (53/30) is only a fragment trim, so it still snaps, and the edge then sits 0.05 s after “finish”, on a frame.
    const fragment = checkDialogueJoin(tl,p,{start:1.85,end:2.8},[page]);
    expect(fragment.status).toBe("snapped");
    expect(fragment.start).toBeCloseTo(45/30);
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
    // 0.08 s is shorter than the two together; both edges take the same proportional point.
    expect(padEdge({ start: 1, end: 1.08 }, "start")).toBeCloseTo(1.04);
    expect(padEdge({ start: 1, end: 1.08 }, "end")).toBeCloseTo(1.04);
    // An edge already in silence is the model's pacing and stays where it is.
    const { p, tl } = fixture();
    expect(checkDialogueJoin(tl,p,{start:1.7,end:2.8},[page])).toMatchObject({ status: "unchanged", start: 1.7 });
    // Moving an end edge out of “next” leaves 0.05 s before it resumes, on the nearest frame.
    const end = checkDialogueJoin(tl,p,{start:2.4,end:3.45},[page]);
    expect(end.status).toBe("snapped");
    expect(end.end).toBeCloseTo(101/30);
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
    // No closer to the sound than the quiet's margin: the word sounds to 2.26 s.
    expect(pause.start).toBeCloseTo(Math.max(2.2 + AIR_AFTER_SPEECH, 2.26 + .03));
    expect(pause.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
  });
  it("places a join's room tone by the pace it is given, and keeps its quiet before the voice whatever the pause", () => {
    const at = () => ({ ...page.edges!, valleys: [{ start: 2.5, end: 2.9 }] });
    const pace = { after: .05, before: .05 };
    const cut = wordCutRange(words, 1, 1, at, undefined, pace);
    expect(cut.start).toBeCloseTo(1.44 + .05);
    expect(cut.end).toBeCloseTo(3.4 - .05);
    // A leave of 0.4 s keeps the pace's 0.05 s before the voice. The rest of the pause plays before the cut.
    const pause = pauseCutRange(words[1]!, words[2]!, at, .4, pace);
    expect(pause.start).toBeCloseTo(2.2 + .35);
    expect(pause.end).toBeCloseTo(3.4 - .05);
  });
  it("plays a beat held before the voice after the cut, and keeps the cut tight after the last word", () => {
    // neon 12:42 kept 0.6 s “before the next demo”, and 0.55 s of it played after “Blender”, where he looked down at
    // his laptop (2026-11-20). A beat asked for after the cut plays there, however long.
    const at = () => ({ ...page.edges!, valleys: [{ start: 2.5, end: 2.9 }] });
    const pace = { after: .05, before: .05 };
    // “first” sounds until 2.26 s, so the cut goes just inside the quiet after it.
    const beat = pauseCutRange(words[1]!, words[2]!, at, .6, pace, .55);
    expect(beat.start).toBeCloseTo(2.26 + .03);
    expect(beat.end).toBeCloseTo(3.4 - .55);
    const held = wordCutRange(words, 1, 1, at, .3, pace, .25);
    expect([held.start, held.end]).toEqual([expect.closeTo(1.44 + .05), expect.closeTo(3.4 - .25)]);
  });
  it("trims a pause between its words' sound, wherever their timings put them", () => {
    // “done … I think”: “I” sounds 2.40–2.50 s and is timed 60 ms late. The quiet after it ended a trim of the pause
    // before it, which took “I” out whole.
    const said = [{ start: 1, end: 1.4, text: "done" }, { start: 2.46, end: 2.56, text: "I" }, { start: 3.2, end: 3.6, text: "think" }];
    const sounds = [{ start: 1, end: 1.4 }, { start: 2.4, end: 2.5 }, { start: 3.2, end: 3.6 }];
    const rms = Array.from({ length: 250 }, (_, i) => sounds.some(v => v.start <= i/50 && i/50 < v.end) ? .12 : .001);
    const heard = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: sounds });
    const before = pauseCutRange(said[0]!, said[1]!, () => heard, .25);
    expect(before.end).toBeLessThanOrEqual(2.4);
    // Timed 60 ms early, the quiet before it started a trim of the pause after it.
    const early = [said[0]!, { start: 2.34, end: 2.44, text: "I" }, said[2]!];
    const after = pauseCutRange(early[1]!, early[2]!, () => joinEvidence(early, { from: 0, to: 5, peaks: rms, rms, speechActivity: sounds }), .25);
    expect(after.start).toBeGreaterThanOrEqual(2.5);
  });
  it("trims nothing from a pause asked to play at its full length, whatever sounds in the middle of it", () => {
    // A breath at 2.7–2.9 s splits the quiet between “first” and “next” in two. Each edge used to be pulled into the
    // quiet run beside its word, so a pause asked to stay 1.2 s long still lost the breath and the quiet around it.
    const breath = [...voice, { start: 2.7, end: 2.9 }];
    const rms = Array.from({ length: 250 }, (_, i) => breath.some(v => v.start <= i/50 && i/50 < v.end) ? .12 : .001);
    const split = joinEvidence(words, { from: 0, to: 5, peaks: rms, rms, speechActivity: breath });
    const pause = pauseCutRange(words[1]!, words[2]!, () => split, 1.2);
    expect(pause.end - pause.start).toBeLessThan(.04);
    // Asked for less, the pause is still trimmed, breath and all.
    const shorter = pauseCutRange(words[1]!, words[2]!, () => split, .4);
    expect(shorter.start).toBeLessThan(2.7);
    expect(shorter.end).toBeGreaterThan(2.9);
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
  it("keeps a start edge before the middle of a named word too quiet to locate", () => {
    // “nice you can”: a faint “you” runs on from “nice” with no pause and the room is quiet for the last 40 ms of its
    // timing. The edge went to that quiet, past the middle of the “you” the cut names, and the save was refused for
    // playing “you” twice (2026-11-17).
    const said = [{ start: 1, end: 1.5, text: "nice" }, { start: 1.5, end: 1.62, text: "you" }, { start: 1.62, end: 1.8, text: "can" }, { start: 2.6, end: 3, text: "see" }];
    const rms = Array.from({ length: 250 }, (_, i) => i >= 50 && i < 75 ? .12 : i >= 75 && i < 79 ? .006 : i >= 79 && i < 81 ? .0002 : (i >= 81 && i < 90) || (i >= 130 && i < 150) ? .12 : .001);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: 1, end: 1.8 }, { start: 2.6, end: 3 }] });
    const cut = wordCutRange(said, 1, 2, () => edges);
    expect(cut.start).toBeLessThanOrEqual(1.56);
    // The join check keeps it there too: the quiet is past the middle of “you”, and moving onto it would leave “you” playing.
    const { p, tl } = fixture();
    const joined = checkDialogueJoin(tl, p, { start: cut.start, end: cut.end }, [{ mediaId: "mic", start: 0, end: 5, edges }]);
    expect(joined.start).toBeLessThanOrEqual(1.56);
  });
  it("puts a dip edge in the middle of the room tone between two words, not on its last bucket before the next word", () => {
    // “one two”: room tone from 1.44 to 1.52 s, deepest in its last 20 ms, then “two” starts. A pause, then “three”.
    const said = [{ start: 1, end: 1.5, text: "one" }, { start: 1.5, end: 2, text: "two" }, { start: 2.6, end: 3, text: "three" }];
    const rms = Array.from({ length: 250 }, (_, i) => i === 75 ? .0002 : i >= 72 && i < 75 ? .0008 : (i >= 50 && i < 100) || (i >= 130 && i < 150) ? .12 : .001);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: 1, end: 2 }, { start: 2.6, end: 3 }] });
    const cut = wordCutRange(said, 1, 1, () => edges);
    expect(cut.dips).toEqual(["No pause between “one” and “two”: the start is at the lowest level between them (-74 dBFS)."]);
    // The lowest bucket is 1.50–1.52 s, with “two” sounding from 1.52. The middle of the dip leaves 40 ms either side.
    expect(cut.start).toBeCloseTo(1.48);
    expect(cut.room.start).toEqual({ start: expect.closeTo(1.44), end: expect.closeTo(1.52) });
  });

  it("starts a cut in the silence after the kept word when the first removed word has no sound of its own", () => {
    // “period.” then a “Thank” nobody said, which the aligner leaves with no time right after it, then a long silence
    // and “you” two seconds on. The kept word's tail dips 40 ms before it ends.
    const said = [{ start: 1, end: 1.5, text: "period." }, { start: 1.5, end: 1.5, text: "Thank" }, { start: 3.5, end: 3.8, text: "you." }, { start: 4.4, end: 4.8, text: "And" }];
    const sounds = [{ start: 1, end: 1.5 }, { start: 3.5, end: 3.8 }, { start: 4.4, end: 4.8 }];
    const rms = Array.from({ length: 250 }, (_, i) => i === 73 ? .0008 : sounds.some(v => v.start <= i / 50 && i / 50 < v.end) ? .1 : .0002);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: sounds });
    const cut = wordCutRange(said, 1, 2, () => edges);
    expect(cut.dips).toEqual([]);
    expect(cut.start).toBeCloseTo(1.5 + AIR_AFTER_SPEECH);
  });

  it("takes no breath over a very quiet room for a valley an edge can sit in", () => {
    // Room tone at -80 dBFS, and a breath at -55 dBFS while the voice detector is still on: under the fixed valley level.
    const said = [{ start: 1, end: 1.5, text: "quota." }, { start: 2.5, end: 3, text: "I" }];
    const rms = Array.from({ length: 200 }, (_, i) => (i >= 50 && i < 75) || (i >= 125 && i < 150) ? .1 : i >= 78 && i < 84 ? .0018 : .0001);
    const edges = joinEvidence(said, { from: 0, to: 4, peaks: rms, rms, speechActivity: [{ start: 1, end: 1.7 }, { start: 2.5, end: 3 }] })!;
    expect(edges.valleys.some(v => v.start < 1.6 && 1.6 < v.end)).toBe(false);
    expect(edges.valleys.some(v => v.start <= 1.52 && 1.54 <= v.end)).toBe(true);
  });

  it("ends a cut where a kept word sounds, when the transcript times it in the pause before", () => {
    // “…got you. <1.2 s> Alright, so”, transcribed “got you all <1.2 s> right so”: the “all” of “alright” timed in the
    // quiet straight after “you”. Cutting “got you” used to end before that “all” and keep the whole pause.
    const said = [{ start: .5, end: .9, text: "this" }, { start: 1.4, end: 1.6, text: "got" }, { start: 1.6, end: 1.76, text: "you" },
      { start: 1.76, end: 1.93, text: "all" }, { start: 3.12, end: 3.3, text: "right" }, { start: 3.3, end: 3.46, text: "so" }];
    const sounds = [{ start: .5, end: .9 }, { start: 1.4, end: 1.76 }, { start: 3.0, end: 3.46 }];
    const rms = Array.from({ length: 200 }, (_, i) => sounds.some(v => v.start <= i / 50 && i / 50 < v.end) ? .1 : .0005);
    const edges = joinEvidence(said, { from: 0, to: 4, peaks: rms, rms, speechActivity: sounds });
    const cut = wordCutRange(said, 1, 2, () => edges);
    expect(cut.end).toBeCloseTo(3.0 - AIR_BEFORE_SPEECH);
    expect(cut.problems).toEqual([]);
    expect(cut.retimed).toEqual([expect.stringContaining("its sound starts at 3 s")]);
    // A breath before the word is under speaking level and goes with the pause; a kept word that does sound where it
    // is timed keeps its edge.
    const breath = rms.map((v, i) => i >= 120 && i < 126 ? .015 : v);
    expect(wordCutRange(said, 1, 2, () => joinEvidence(said, { from: 0, to: 4, peaks: breath, rms: breath, speechActivity: sounds })).end).toBeCloseTo(3.0 - AIR_BEFORE_SPEECH);
    const spoken = rms.map((v, i) => i >= 88 && i < 96 ? .1 : v);
    const plain = wordCutRange(said, 1, 2, () => joinEvidence(said, { from: 0, to: 4, peaks: spoken, rms: spoken, speechActivity: [...sounds, { start: 1.76, end: 1.92 }] }));
    expect(plain.end).toBeLessThan(1.8);
    expect(plain.retimed).toEqual([]);
  });

  it("reads a word timed too short to say, on its neighbour's sound, where the speech beside it has no word", () => {
    // “Opus 5.5 · and the… · and GPT”, transcribed with “5.5” in 80 ms at the start of the first “and”, and the
    // “five point five” after “Opus” carrying no word. Cutting the first “and” found no quiet between “5.5” and “and”.
    const said = [{ start: 1, end: 1.3, text: "Opus" }, { start: 2.53, end: 2.61, text: "5.5" }, { start: 2.61, end: 2.85, text: "and" },
      { start: 4, end: 4.16, text: "and" }, { start: 4.16, end: 4.5, text: "GPT" }];
    const sounds = [{ start: 1, end: 2.2 }, { start: 2.5, end: 2.9 }, { start: 4, end: 4.5 }];
    const rms = Array.from({ length: 250 }, (_, i) => sounds.some(v => v.start <= i / 50 && i / 50 < v.end) ? .1 : .0005);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: sounds })!;
    expect(edges.words[1]).toEqual({ text: "5.5", start: expect.closeTo(1.3), end: expect.closeTo(2.2), timed: { start: 2.53, end: 2.61 } });
    const cut = wordCutRange(said, 2, 2, () => edges);
    expect(cut.problems).toEqual([]);
    expect(cut.start).toBeCloseTo(2.2 + AIR_AFTER_SPEECH);
    expect(cut.end).toBeCloseTo(4 - AIR_BEFORE_SPEECH);
    expect(cut.retimed).toEqual([expect.stringContaining("the kept “5.5” at 2.53–2.61 s, too short to say it")]);
    // A word in that speech explains it, and a word as long as it sounds owns its timing: nothing moves.
    const five = [...said.slice(0, 1), { start: 1.3, end: 2.2, text: "five" }, ...said.slice(1)];
    expect(joinEvidence(five, { from: 0, to: 5, peaks: rms, rms, speechActivity: sounds })!.words.some(w => "timed" in w)).toBe(false);
    // Nor does it move past another word: “and you know”, with “you” in 4 ms at the end of “and”, “know” in the quiet after
    // it and both said in the speech that follows.
    const order = [{ start: 1, end: 1.3, text: "and" }, { start: 1.3, end: 1.304, text: "you" }, { start: 1.304, end: 1.48, text: "know" }, { start: 2.3, end: 2.6, text: "right" }];
    const later = [{ start: 1, end: 1.32 }, { start: 1.55, end: 1.95 }, { start: 2.3, end: 2.6 }];
    const levelsLater = Array.from({ length: 250 }, (_, i) => later.some(v => v.start <= i / 50 && i / 50 < v.end) ? .1 : .0005);
    expect(joinEvidence(order, { from: 0, to: 5, peaks: levelsLater, rms: levelsLater, speechActivity: later })!.words.some(w => "timed" in w)).toBe(false);
    const short = said.map((w, i) => i === 1 ? { ...w, text: "a" } : w);
    expect(joinEvidence(short, { from: 0, to: 5, peaks: rms, rms, speechActivity: sounds })!.words.some(w => "timed" in w)).toBe(false);
  });

  it("saves a placed edge on the frame nearest to it inside the quiet it was measured in, and leaves it when none fits", () => {
    const same = (t: number) => t;
    // At 30 fps frames fall at 2.333 and 2.367 s. Rounded inward, a start at 2.35 s would be saved at 2.367.
    expect(edgeOnFrame(2.35, { start: 2.29, end: 3.37 }, 30, same)).toBeCloseTo(70 / 30);
    // A dip narrower than a frame holds none: the edge stays where the level put it.
    expect(edgeOnFrame(1.48, { start: 1.47, end: 1.49 }, 30, same)).toBe(1.48);
    // The frame must be inside the quiet, even when a nearer one is just outside it.
    expect(edgeOnFrame(2.31, { start: 2.305, end: 2.4 }, 30, same)).toBeCloseTo(70 / 30);
    expect(edgeOnFrame(2.35, undefined, 30, same)).toBe(2.35);
    // Frames are the version's, so a clip placed off the recording's clock moves them.
    expect(edgeOnFrame(12.36, { start: 2.29, end: 3.37 }, 30, t => t + 10.01)).toBeCloseTo(371 / 30);
  });

  it("moves an edge given in quiet onto a quiet frame when the frame the engine rounds to has the next word's sound", () => {
    const { p, tl } = fixture();
    // “one”, a pause, “next”, a pause, “end” at 4.0 s.
    const said = [{ start: 1, end: 1.4, text: "one" }, { start: 2.32, end: 2.8, text: "next" }, { start: 4, end: 4.5, text: "end" }];
    const rms = Array.from({ length: 250 }, (_, i) => (i >= 50 && i < 70) || (i >= 116 && i < 140) || (i >= 200 && i < 225) ? .12 : .001);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: 1, end: 1.4 }, { start: 2.32, end: 2.8 }, { start: 4, end: 4.5 }] });
    const pages: JoinPage[] = [{ mediaId: "mic", start: 0, end: 5, edges }];
    // An end at 2.255 s is rounded down to frame 67 (2.233 s), which is quiet too: it stays as given.
    expect(checkDialogueJoin(tl, p, { start: 1.6, end: 2.255 }, pages)).toMatchObject({ status: "unchanged", start: 1.6, end: 2.255 });
    // A start at 3.97 s is rounded up to frame 120 (4.0 s), where “end” begins: it goes on frame 119, inside the quiet.
    const check = checkDialogueJoin(tl, p, { start: 3.97, end: 4.9 }, pages);
    expect(check.status).toBe("unchanged");
    expect(check.start).toBeCloseTo(119 / 30);
    expect(quietFrameNote({ start: 3.97, end: 4.9 }, check)).toBe("Moved the start from 3.970 s to 3.967 s, onto a quiet frame: the recording is quiet at the edge, and the whole frame it would be saved on has sound.");
    expect(quietFrameNote({ start: 1.6, end: 2.255 }, { start: 1.6, end: 2.255 })).toBeUndefined();
  });

  it("counts the sound in the level bucket an edge falls in on the side most of the bucket is on", () => {
    // One loud 20 ms bucket, 1.00–1.02 s.
    const rms = Array.from({ length: 250 }, (_, i) => i === 50 ? .12 : .001);
    const pages: JoinPage[] = [{ mediaId: "mic", start: 0, end: 5, edges: joinEvidence([], { from: 0, to: 5, peaks: rms, rms, speechActivity: [] }) }];
    // A cut starting at 1.015 s keeps most of that bucket: its sound is kept, not removed beside the edge.
    expect(soundBesideEdge(pages, "mic", 0, 1.015, "out", .06)).toBeUndefined();
    // Starting at 1.005 s, most of the bucket goes with the cut.
    expect(soundBesideEdge(pages, "mic", 0, 1.005, "out", .06)).toBe(0);
    // And the same for a cut's end: at 1.005 s most of the bucket plays after it, at 1.015 s most of it is removed.
    expect(soundBesideEdge(pages, "mic", 0, 1.005, "in", .06)).toBeUndefined();
    expect(soundBesideEdge(pages, "mic", 0, 1.015, "in", .06)).toBe(0);
    expect(soundBesideEdge(pages, "mic", 0, 1.05, "in", .06)).toBeCloseTo(.03);
  });

  it("puts a cut that asks for no air before the voice on the word's first sound", () => {
    const at = () => page.edges;
    // “next” is at speaking level the moment it starts (3.4 s): the edge goes to the end of the quiet and no further.
    const hard = wordCutRange(words, 1, 1, at, .3, undefined, 0);
    expect([hard.start, hard.end, hard.room.end!.end]).toEqual([expect.closeTo(1.44 + .3), expect.closeTo(3.4), expect.closeTo(3.4)]);
    expect(edgeOnFrame(hard.end, hard.room.end, 24, t => t)).toBeCloseTo(81 / 24);
    // A soft start takes 60 ms to reach that level. The edge may sit on its first 20 ms, so the nearest frame can be the word's first.
    const rising = levels.map((level, i) => i >= 170 && i < 173 ? .005 : level);
    const soft = joinEvidence(words, { from: 0, to: 5, peaks: rising, rms: rising, speechActivity: voice });
    const onSoft = wordCutRange(words, 1, 1, () => soft, .3, undefined, 0);
    expect([onSoft.end, onSoft.room.end!.end]).toEqual([expect.closeTo(3.4), expect.closeTo(3.42)]);
    expect(edgeOnFrame(onSoft.end, onSoft.room.end, 24, t => t)).toBeCloseTo(82 / 24);
    // A pause named by the word it follows goes the same way.
    const pause = pauseCutRange(words[1]!, words[2]!, at, .3, undefined, 0);
    expect([pause.start, pause.end, pause.room.end!.end]).toEqual([expect.closeTo(2.5), expect.closeTo(3.4), expect.closeTo(3.4)]);
    // The checks read such an edge as the word's start, not a cut through sound.
    const { p, tl } = fixture();
    expect(checkDialogueJoin(tl, p, { start: 2.6, end: 3.4 }, [page])).toMatchObject({ status: "unchanged", end: 3.4 });
    expect(clipEdgeSound([page], "mic", 0, 3.4, "in")).toBeUndefined();
    expect(clipEdgeSound([{ ...page, edges: soft }], "mic", 0, 3.42, "in")).toBeUndefined();
  });

  it("follows the quiet past a detector that starts before the word does, as far as the level stays in the room", () => {
    // The detector calls “next” from 2.9 s. The recording is at room level until the word starts at 3.4 s.
    const early = voice.map(v => v.start === 3.4 ? { ...v, start: 2.9 } : v);
    const run = (rms: number[]) => joinEvidence(words, { from: 0, to: 5, peaks: rms, rms, speechActivity: early })!.quiet.at(-2);
    expect(run(levels)).toEqual({ start: expect.closeTo(2.26), end: expect.closeTo(3.4) });
    // A lone tick in that stretch is not the word. A sound that rises out of the room is: a soft start ends the quiet.
    expect(run(levels.map((l, i) => i === 160 ? .004 : l))!.end).toBeCloseTo(3.4);
    expect(run(levels.map((l, i) => i >= 165 && i < 170 ? .005 : l))!.end).toBeCloseTo(3.3);
    // A breath before the word, then ticks in the quiet that follows it: the quiet beside the word is one silence, and
    // the edge goes after the breath.
    const fine = Array.from({ length: 500 }, (_, i) => voice.some(v => v.start <= i/100 && i/100 < v.end) ? .12 : i >= 290 && i < 320 ? .004 : i === 327 || i === 333 ? .003 : .0004);
    const breath = joinEvidence(words, { from: 0, to: 5, peaks: fine, rms: fine, speechActivity: [...voice.slice(0, 2), { start: 2.9, end: 3.2 }, voice[2]!] })!;
    expect(breath.quiet.at(-2)).toEqual({ start: expect.closeTo(3.2), end: expect.closeTo(3.4) });
    expect(wordCutRange(words, 1, 1, () => breath).end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH, 1);
    // The edge goes beside the word, not half a second before it.
    const cut = wordCutRange(words, 1, 1, () => joinEvidence(words, { from: 0, to: 5, peaks: levels, rms: levels, speechActivity: early }));
    expect(cut.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
  });

  it("cuts in the room right after the kept word, before a breath the speech detector runs on through", () => {
    // “simulation.” sounds to 1.4 s. The room for 80 ms, a breath 30 dB under the voice to 1.6 s, the room again, “I”
    // at 1.82 s. The detector is on from the word to the end of “thought”, so the only gap is the trough after the breath.
    const said = [{ start: 1, end: 1.4, text: "simulation." }, { start: 1.82, end: 2, text: "I" }, { start: 2, end: 2.3, text: "thought" }, { start: 3, end: 3.4, text: "test" }];
    const sound = [[1, 1.4], [1.82, 2.3], [3, 3.4]];
    const rms = Array.from({ length: 250 }, (_, i) => sound.some(([a, b]) => a! <= i/50 && i/50 < b!) ? .12 : i/50 >= 1.48 && i/50 < 1.6 ? .003 : i/50 >= 1.4 && i/50 < 1.82 ? .0008 : .0004);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: 1, end: 2.32 }, { start: 3, end: 3.42 }] })!;
    const cut = wordCutRange(said, 1, 2, () => edges, undefined, { after: .18, before: .06 });
    expect(cut.start).toBeGreaterThan(1.4);
    expect(cut.start).toBeLessThan(1.48);
  });

  it("doesn't take a stop inside the kept word, which sounds on after it, for where the words part", () => {
    // “subscription” runs into “I” with no pause. The stop before its last syllable falls to -52 dBFS at 1.2 s, and the
    // word sounds at full level for 0.36 s after it: an edge there takes off “-tion”.
    const said = [{ start: 1, end: 1.6, text: "subscription." }, { start: 1.6, end: 1.75, text: "I" }, { start: 1.75, end: 2.3, text: "downloaded" }, { start: 3, end: 3.4, text: "the" }];
    const rms = Array.from({ length: 250 }, (_, i) => i/50 >= 1.2 && i/50 < 1.24 ? .0025 : (i/50 >= 1 && i/50 < 2.3) || (i/50 >= 3 && i/50 < 3.4) ? .12 : .0004);
    const edges = joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: 1, end: 2.32 }, { start: 3, end: 3.42 }] })!;
    expect(wordCutRange(said, 1, 2, () => edges).start).toBeCloseTo(1.6, 2);
  });

  it("starts the quiet after a word where its sound is back at room level, with the breath after it in the pause", () => {
    // “finish” sounds to 1.44 s. The room, then a breath 20 dB under the voice to 1.66 s, with the detector on through
    // it, then quiet until “first” at 1.8 s. Later, a soft sound in the quiet between “first” and “next”, after no word.
    const rms = Array.from({ length: 500 }, (_, i) => voice.some(v => v.start <= i/100 && i/100 < v.end) ? .12
      : (i >= 146 && i < 154) || (i >= 156 && i < 166) ? .006 : i >= 260 && i < 270 ? .006 : .0004);
    const heard = [{ start: .98, end: 1.7 }, ...voice.slice(1)];
    const evidence = (said: typeof words) => joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: heard })!;
    const breath = evidence(words);
    expect(breath.quiet[1]).toEqual({ start: expect.closeTo(1.44), end: expect.closeTo(1.8) });
    // Without the words, the quiet waits for the breath and the detector to end.
    expect(evidence([]).quiet[1]).toEqual({ start: expect.closeTo(1.7), end: expect.closeTo(1.8) });
    // A soft sound between two silences that no word or speech comes before stays sound: it may be a word nobody timed.
    expect(breath.quiet.slice(2, 4)).toEqual([{ start: expect.closeTo(2.26), end: expect.closeTo(2.6) }, { start: expect.closeTo(2.7), end: expect.closeTo(3.4) }]);
    // Every way of asking for the cut puts its start before the breath: by words, by the pause, and in seconds.
    const pace = { after: .04, before: .05 };
    expect(wordCutRange(words, 1, 1, () => breath, undefined, pace).start).toBeCloseTo(1.48);
    expect(pauseCutRange(words[0]!, words[1]!, () => breath, .1, pace, .03).start).toBeCloseTo(1.47);
    const { p, tl } = fixture();
    expect(checkDialogueJoin(tl, p, { start: 1.5, end: 3.3 }, [{ ...page, edges: breath }], undefined, pace)).toMatchObject({ status: "unchanged", start: 1.5 });
  });

  it("resolves a word range to padded edges in the measured gaps beside it", () => {
    const at = () => page.edges;
    // Remove “first”: kept “finish” ends at 1.44 by the recording, “next” resumes at 3.4.
    const cut = wordCutRange(words, 1, 1, at);
    expect(cut.problems).toEqual([]);
    expect(cut.text).toBe("first");
    expect(cut.start).toBeCloseTo(1.44 + AIR_AFTER_SPEECH);
    expect(cut.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
    // The agent can say how long the join's pause plays instead: 0.3 s, all but the air before the voice on the outgoing word's side.
    const roomy = wordCutRange(words, 1, 1, at, .3);
    expect(roomy.start).toBeCloseTo(1.44 + .25);
    expect(roomy.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
    // And how soon the voice comes in after the cut: the rest of the pause plays before it.
    const prompt = wordCutRange(words, 1, 1, at, .3, undefined, .03), held = wordCutRange(words, 1, 1, at, .3, undefined, .12);
    expect([prompt.start, prompt.end]).toEqual([expect.closeTo(1.44 + .27), expect.closeTo(3.4 - .03)]);
    expect([held.start, held.end]).toEqual([expect.closeTo(1.44 + .18), expect.closeTo(3.4 - .12)]);
    // Given alone, it changes that side only.
    const alone = wordCutRange(words, 1, 1, at, undefined, undefined, .12);
    expect([alone.start, alone.end]).toEqual([expect.closeTo(1.44 + AIR_AFTER_SPEECH), expect.closeTo(3.4 - .12)]);
    // A pause shorter than twice the air before the voice is halved.
    expect(splitLeave(.06)).toEqual({ after: .03, before: .03 });
    // A voiceIn takes all but the pace's air after the last word: 0.05 s by default.
    expect(splitLeave(.4, undefined, .3)).toEqual({ after: expect.closeTo(.1), before: .3 });
    // A voiceIn the model gives takes the rest of a longer pause once the last word has the pace's air after it.
    expect(splitLeave(.6, { after: .05, before: .05 }, .55)).toEqual({ after: expect.closeTo(.05), before: expect.closeTo(.55) });
    expect(splitLeave(.6, { after: .05, before: .05 }, .7)).toEqual({ after: expect.closeTo(.05), before: expect.closeTo(.55) });
    expect(splitLeave(.065, { after: .05, before: .05 }, .065)).toEqual({ after: .0325, before: .0325 });
    // Without a kept neighbor the cut runs to the start or end of the material.
    expect(wordCutRange(words, 0, 0, at).start).toBe(0);
    expect(wordCutRange(words, 2, 2, at).end).toBe(Infinity);
    // No measured silence: the edge falls back to the word timings and says so.
    const deaf = wordCutRange(words, 1, 1, () => ({ ...page.edges!, quiet: [], valleys: [], levels: undefined }));
    expect(deaf.problems).toHaveLength(2);
    // A stray word with a gap before it and none after: “With” runs straight into “the”. Both edges used to find
    // that one gap and the range came out empty. The gap is the start's; the end goes where the transcript parts the
    // two words, which run together, and says so.
    const run = [{ start: 9.5, end: 9.7, text: "good." }, { start: 10.0, end: 10.28, text: "With" }, { start: 10.28, end: 10.5, text: "the" }];
    const stray = wordCutRange(run, 1, 1, () => ({ ...page.edges!, quiet: [{ start: 9.72, end: 9.98 }], valleys: [] }));
    expect(stray.start).toBeGreaterThan(9.72);
    expect(stray.start).toBeLessThan(9.98);
    expect(stray.end).toBeCloseTo(10.28);
    expect(stray.problems).toEqual([]);
    expect(stray.dips).toEqual(["No pause or low point between “With” and “the”: they run together, and the end is where the transcript parts them."]);
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
    // That pause is still the start's, now placed beside “good.”, and the end is where the transcript parts “With” and “the”.
    const run = [{ start: 1, end: 1.4, text: "good." }, { start: 7, end: 7.28, text: "With" }, { start: 7.28, end: 7.5, text: "the" }];
    const sounding = [{ start: 1, end: 1.4 }, { start: 7, end: 7.5 }];
    const stray = wordCutRange(run, 1, 1, at([read(3, 8, sounding), read(0, 4, sounding)]));
    expect(stray.start).toBeCloseTo(1.4 + AIR_AFTER_SPEECH);
    expect(stray.end).toBeCloseTo(7.28);
    expect(stray.problems).toEqual([]);
    expect(stray.dips).toEqual(["No pause or low point between “With” and “the”: they run together, and the end is where the transcript parts them."]);
    // A gap the middle reading shows from word to word is placed from that reading alone, as before. Here another page
    // has more around the end of “finish” and hears its voice run on to 1.5 s, where the middle's hears it stop at 1.44 s.
    const middle = read(1, 5, voice), beside = read(0, 2, [{ start: .98, end: 1.5 }, voice[1]!]);
    expect([at([beside, middle])(1.38), at([beside, middle])(1.59)]).toEqual([beside.edges, middle.edges]);
    const short = wordCutRange(words, 1, 1, at([beside, middle]));
    expect(short.start).toBeCloseTo(1.44 + AIR_AFTER_SPEECH);
    expect(short.end).toBeCloseTo(3.4 - AIR_BEFORE_SPEECH);
  });
});

describe("a restart that begins on the word the first take broke off after", () => {
  // “there was a time where would … where you would occasionally see”, with the levels of the recording it came from
  // in 20 ms steps: “time” runs into the first “where” through its “m” (-37 dBFS), and the second “where” starts out of
  // a pause. An edge at that trough played “time” clipped; one 0.05 s later played clean (2026-11-17).
  const first = [-45.4, -51.4, -53.1, -47.7, -45.4, -43, -42, -32.7, -30.4, -29.2, -28.1, -27.5, -29.2, -37.2, -36.7, -37, -35.6, -33.3, -33.7, -37.9, -40.9, -40.4,
    -39.1, -38.5, -38.1, -39.4, -39.9, -38.9, -37.9, -36.6, -36.4, -42.7, -42.8, -45, -51.2, -58.4, -64.8, -66.6, -60.9, -66.7, -67.6, -71, -73.7];
  const second = [-74.6, -44.4, -37.4, -33.7, -31.9, -32.4, -36.7, -39.5, -40.3, -41.7, -42.3, -40.7];
  const page = (again = "where"): JoinPage => {
    // The recording from 770.5 s: the first table starts at 771.40 s (0.9 here), the second at 772.86 s (2.36).
    const db = Array.from({ length: 250 }, (_, i) => {
      const t = i * .02;
      if (t >= .9 - 1e-9 && i - 45 < first.length) return first[i - 45]!;
      if (i >= 118 && i - 118 < second.length) return second[i - 118]!;
      return (t >= .4 && t < .9) || (i >= 130 && t < 3.3) ? -36 : -70;
    });
    const rms = db.map(v => 10 ** (v / 20));
    const said = [{ start: .62, end: .76, text: "there" }, { start: .76, end: .9, text: "was" }, { start: .9, end: .98, text: "a" }, { start: .98, end: 1.22, text: "time" },
      { start: 1.22, end: 1.42, text: "where" }, { start: 1.42, end: 1.62, text: "would" }, { start: 2.34, end: 2.54, text: again }, { start: 2.54, end: 2.7, text: "you" },
      { start: 2.8, end: 3.3, text: "would" }];
    return { mediaId: "mic", start: 0, end: 5, edges: joinEvidence(said, { from: 0, to: 5, peaks: rms, rms, speechActivity: [{ start: .4, end: 1.64 }, { start: 2.38, end: 3.3 }] }) };
  };

  it("offers a start where the first delivery begins, matched to the second on their sound", () => {
    const { p, tl } = fixture();
    // The words “where would”, by their timings, which sit 20 ms late: no quiet to start in.
    const held = checkDialogueJoin(tl, p, { start: 1.22, end: 2.34 }, [page()]);
    expect(held.status).toBe("review");
    // The second “where” sounds from 2.40 s and the two match 1.20 s apart, so the first begins at 1.20 s: the cut
    // starts on the frame nearest it, with no margin added.
    expect(held.sameWordJoin).toMatchObject({ start: expect.closeTo(36 / 30, 5), end: 2.34, word: "where" });
    expect(held.sameWordJoin!.reason).toContain("the editor's to hear");
  });

  it("holds a cut saved there for the editor, with no word clipped", () => {
    const { p, tl } = fixture();
    const placed = checkDialogueJoin(tl, p, { start: 36 / 30, end: 2.34 }, [page()]);
    expect(placed).toMatchObject({ status: "review", sameWord: "where", start: expect.closeTo(36 / 30, 5), end: 2.34 });
    expect(placed.inWord).toBeUndefined();
    expect(placed.reason).toContain("the editor hears it");
  });

  it("offers nothing when the take resumes on another word", () => {
    const { p, tl } = fixture();
    expect(checkDialogueJoin(tl, p, { start: 1.22, end: 2.34 }, [page("when")]).sameWordJoin).toBeUndefined();
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

  it("gives the nearest clean second that plays a split word whole, and the one that leaves it out", () => {
    // A clip ending inside “obviously” is clean once it ends after the word, or before it begins.
    const out = edge(2.6, "out")!;
    expect(out.wholeAt).toBeGreaterThanOrEqual(2.9);
    expect(edge(out.wholeAt!, "out")).toBeUndefined();
    expect(out.withoutAt).toBeLessThanOrEqual(2.28);
    expect(edge(out.withoutAt!, "out")).toBeUndefined();
    // A clip starting inside it plays it whole from before it begins.
    const start = edge(2.6, "in")!;
    expect(start.wholeAt).toBeLessThanOrEqual(2.28);
    expect(edge(start.wholeAt!, "in")).toBeUndefined();
  });
});
