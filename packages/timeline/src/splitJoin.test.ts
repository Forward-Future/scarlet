import { describe, expect, it } from "vitest";
import { createProject, emptyTimeline, makeMediaClip } from "./builders.js";
import { audioCrossfadeOps } from "./joinCrossfade.js";
import { applyOps } from "./ops.js";
import { toOtio } from "./otio.js";
import { toFcpxml } from "./fcpxml.js";
import type { HandoffSource } from "./handoff.js";
import type { MediaAsset, MediaClip, Timeline } from "./schema.js";
import { putBackSplit, splitEditWords, splitJoinOps } from "./splitJoin.js";
import { clipEnd, timelineDuration } from "./time.js";

const FPS = 25;
const media: MediaAsset[] = [
  { id: "host", kind: "video", name: "Host", path: "host.mov", duration: 20, hasAudio: true },
  { id: "guest", kind: "video", name: "Guest", path: "guest.mov", duration: 20, hasAudio: true },
  { id: "broll", kind: "video", name: "Street", path: "street.mov", duration: 20, hasAudio: false },
];

/** Host asks (0–4 s), guest answers (4–8 s), host reacts (8–11 s): three shots that meet at 4 and 8. */
function conversation(): Timeline {
  const timeline = emptyTimeline("p");
  timeline.tracks[0]!.clips = [
    makeMediaClip("host", 2, 6, 0, { id: "ask" }),
    makeMediaClip("guest", 10, 14, 4, { id: "answer" }),
    makeMediaClip("host", 9, 12, 8, { id: "react" }),
  ];
  return timeline;
}

const clip = (tl: Timeline, id: string) => tl.tracks.flatMap(t => t.clips).find(c => c.id === id) as MediaClip;
const sounds = (tl: Timeline) => tl.tracks.find(t => t.id === "v1_dialogue")!.clips as MediaClip[];
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("splitJoinOps", () => {
  it("leads the next shot's sound into its picture (a J cut), leaving the picture and the runtime as they were", () => {
    const before = conversation();
    const { ops, joins } = splitJoinOps(before, media, FPS, [{ at: 4, shift: -0.24 }]);
    const after = applyOps(before, ops);
    expect(after.tracks[0]!.clips.map(c => [c.id, c.timelineIn, clipEnd(c)])).toEqual(before.tracks[0]!.clips.map(c => [c.id, c.timelineIn, clipEnd(c)]));
    close(timelineDuration(after), timelineDuration(before));
    expect(clip(after, "ask").volume).toBe(0);
    expect(clip(after, "answer").volume).toBe(0);
    const [host, guest] = sounds(after);
    close(host!.timelineIn, 0); close(clipEnd(host!), 3.76); close(host!.sourceOut, 5.76);
    close(guest!.timelineIn, 3.76); close(guest!.sourceIn, 9.76); close(clipEnd(guest!), 8);
    expect(host!.splitEdit).toBeUndefined();
    expect(guest!.splitEdit).toEqual({ leads: 0.24 });
    expect(joins[0]).toMatchObject({ at: 4, was: 0, shift: -0.24, leftClipId: "ask", rightClipId: "answer" });
    // The reaction still plays its own sound on its picture.
    expect(clip(after, "react").volume).toBe(1);
  });

  it("carries a line over the next picture (an L cut), and a second call sets the join anew rather than adding", () => {
    const l = applyOps(conversation(), splitJoinOps(conversation(), media, FPS, [{ clipId: "react", shift: 0.5 }]).ops);
    const [guest, host] = sounds(l);
    close(clipEnd(guest!), 8.5); close(guest!.sourceOut, 14.5); expect(guest!.splitEdit).toEqual({ trails: 0.5 });
    close(host!.timelineIn, 8.5); close(host!.sourceIn, 9.5);

    const j = applyOps(l, splitJoinOps(l, media, FPS, [{ at: 8, shift: -0.2 }]).ops);
    const [g, h] = sounds(j);
    close(clipEnd(g!), 7.8); expect(g!.splitEdit).toBeUndefined();
    close(h!.timelineIn, 7.8); close(h!.sourceIn, 8.8); expect(h!.splitEdit).toEqual({ leads: 0.2 });

    const straight = applyOps(j, splitJoinOps(j, media, FPS, [{ at: 8, shift: 0 }]).ops);
    const [g0, h0] = sounds(straight);
    close(clipEnd(g0!), 8); close(h0!.timelineIn, 8);
    expect(g0!.splitEdit).toBeUndefined(); expect(h0!.splitEdit).toBeUndefined();
  });

  it("splits both ends of one shot in one call", () => {
    const tl = conversation();
    const after = applyOps(tl, splitJoinOps(tl, media, FPS, [{ clipId: "answer", shift: -0.2 }, { clipId: "react", shift: 0.4 }]).ops);
    const guest = sounds(after).find(c => c.mediaId === "guest")!;
    expect(guest.splitEdit).toEqual({ leads: 0.2, trails: 0.4 });
    close(guest.timelineIn, 3.8); close(clipEnd(guest), 8.4);
    expect(sounds(after)).toHaveLength(3);
  });

  it("refuses sound that wasn't recorded, and says how far it can go", () => {
    const tl = conversation();
    (tl.tracks[0]!.clips[1] as MediaClip).sourceIn = 0.1;
    (tl.tracks[0]!.clips[1] as MediaClip).sourceOut = 4.1;
    expect(() => splitJoinOps(tl, media, FPS, [{ at: 4, shift: -0.25 }])).toThrow(/lead the cut at 0:04.00 by at most 0.100 s/);
    const end = conversation();
    (end.tracks[0]!.clips[1] as MediaClip).sourceIn = 15.8;
    (end.tracks[0]!.clips[1] as MediaClip).sourceOut = 19.8;
    expect(() => splitJoinOps(end, media, FPS, [{ at: 8, shift: 0.5 }])).toThrow(/carry on at most 0.200 s past the cut/);
  });

  it("refuses a join whose sound is not a straight cut, footage that runs on, and a shot with no sound", () => {
    const tl = conversation();
    const faded = applyOps(tl, audioCrossfadeOps(tl, media, [{ leftClipId: "ask", rightClipId: "answer" }], 0.08));
    expect(() => splitJoinOps(faded, media, FPS, [{ at: 4, shift: -0.2 }])).toThrow(/isn't a straight cut \(a crossfade overlaps it\)/);
    const runOn = emptyTimeline("p");
    runOn.tracks[0]!.clips = [makeMediaClip("host", 0, 2, 0, { id: "a" }), makeMediaClip("host", 2, 4, 2, { id: "b" })];
    expect(() => splitJoinOps(runOn, media, FPS, [{ at: 2, shift: -0.2 }])).toThrow(/footage runs on/);
    const silent = emptyTimeline("p");
    silent.tracks[0]!.clips = [makeMediaClip("host", 0, 2, 0, { id: "a" }), makeMediaClip("broll", 2, 4, 2, { id: "b" })];
    expect(() => splitJoinOps(silent, media, FPS, [{ at: 2, shift: -0.2 }])).toThrow(/no recorded sound/);
    expect(() => splitJoinOps(tl, media, FPS, [{ at: 5, shift: -0.2 }])).toThrow(/No join on v1 at 0:05.00. The nearest is at 0:04.00/);
  });

  it("refuses a split longer than the sound it shortens", () => {
    const tl = conversation();
    expect(() => splitJoinOps(tl, media, FPS, [{ at: 4, shift: 3.99 }])).toThrow(/too soon to start/);
  });
});

describe("putBackSplit", () => {
  it("puts the sound back on its picture exactly, with no dialogue track left behind", () => {
    const before = conversation();
    const { ops } = splitJoinOps(before, media, FPS, [{ at: 4, shift: -0.24 }]);
    const after = applyOps(before, ops);
    const back = putBackSplit(after, before, after, ops as never, { start: 3.76, end: 4 });
    expect(back?.tracks).toEqual(before.tracks);
  });

  it("puts back one join of several, and keeps the other", () => {
    const before = conversation();
    const { ops } = splitJoinOps(before, media, FPS, [{ at: 4, shift: -0.2 }, { at: 8, shift: 0.4 }]);
    const after = applyOps(before, ops);
    const back = putBackSplit(after, before, after, ops as never, { start: 8, end: 8.4 })!;
    const guest = sounds(back).find(c => c.mediaId === "guest")!;
    expect(guest.splitEdit).toEqual({ leads: 0.2 });
    close(clipEnd(guest), 8);
    // The reaction's sound is its own again.
    expect(clip(back, "react").volume).toBe(1);
    expect(sounds(back).some(c => c.mediaId === "host" && c.timelineIn >= 7.9)).toBe(false);
  });

  it("answers nothing once a later edit has moved the sound, so Scarlet is asked instead", () => {
    const before = conversation();
    const { ops } = splitJoinOps(before, media, FPS, [{ at: 4, shift: -0.24 }]);
    const after = applyOps(before, ops);
    const guest = sounds(after).find(c => c.mediaId === "guest")!;
    const later = applyOps(after, [{ op: "updateClip", clipId: guest.id, patch: { timelineIn: 3.7, sourceIn: 9.7 } }]);
    expect(putBackSplit(later, before, after, ops as never, { start: 3.76, end: 4 })).toBeUndefined();
    expect(putBackSplit(after, before, after, [{ op: "rippleDelete", start: 1, end: 2 }], { start: 3.76, end: 4 })).toBeUndefined();
  });
});

describe("a split edit's record", () => {
  it("goes from the end a later trim or split cuts through, and stays at the other", () => {
    const before = conversation();
    const after = applyOps(before, splitJoinOps(before, media, FPS, [{ clipId: "answer", shift: -0.2 }, { clipId: "react", shift: 0.4 }]).ops);
    const guest = sounds(after).find(c => c.mediaId === "guest")!;
    const halves = applyOps(after, [{ op: "splitClip", clipId: guest.id, at: 6, newClipId: "rest" }]);
    expect(clip(halves, guest.id).splitEdit).toEqual({ leads: 0.2 });
    expect(clip(halves, "rest").splitEdit).toEqual({ trails: 0.4 });
  });

  it("reads in frames under a second when the frame rate is known, else in seconds", () => {
    expect(splitEditWords({ leads: 0.24 }, 25)).toEqual(["Sound leads by 6 frames"]);
    expect(splitEditWords({ trails: 0.4 })).toEqual(["Sound carries 0.4 s past the cut"]);
    expect(splitEditWords({ leads: 0.2, trails: 1.5 }, 25)).toEqual(["Sound leads by 5 frames", "Sound carries 1.5 s past the cut"]);
  });
});

describe("handing a split edit to another editor", () => {
  const source = (over: Partial<HandoffSource> = {}): HandoffSource => ({
    url: "file:///Edit/host.mov", fileName: "host.mov", hasVideo: true, hasAudio: true,
    rate: { num: 25, den: 1 }, width: 1920, height: 1080, audioChannels: 2, audioRate: 48000, duration: 20, ...over,
  });

  function project() {
    const p = createProject("Talk", { fps: FPS });
    p.media.push(...media.slice(0, 2).map(m => ({ ...m, fps: FPS })));
    return p;
  }

  it("carries the sound's own timing in OTIO and FCPXML: picture at the cut, sound before it", () => {
    const before = conversation();
    const after = applyOps(before, splitJoinOps(before, media, FPS, [{ at: 4, shift: -0.24 }]).ops);
    const otio = JSON.stringify(toOtio(project(), after));
    // The guest's sound starts 0.24 s (6 frames) before the guest's picture, on an audio track.
    expect(otio).toContain('"splitEdit":{"leads":0.24}');
    const sources = new Map([["host", source()], ["guest", source({ url: "file:///Edit/guest.mov", fileName: "guest.mov" })]]);
    const xml = toFcpxml(project(), after, sources);
    // The guest's picture still cuts in at 4 s from 10 s of its recording, with no sound of its own.
    expect(xml).toContain('offset="4s" name="Guest" start="10s" duration="4s" srcEnable="video"');
    // Its sound is connected below the host's shot, 3.76 s in (the host's clip starts at 2 s of its recording), from 9.76 s.
    expect(xml).toContain('offset="144/25s" name="Guest" start="244/25s" duration="106/25s" srcEnable="audio"');
    expect(xml).toContain('offset="2s" name="Host" start="2s" duration="94/25s" srcEnable="audio"');
  });
});
