import { describe, expect, it } from "vitest";
import { ZodError } from "zod/v3";
import {
  applyOp, applyOps, clipEnd, emptyTimeline, makeMediaClip, makeTrack, OpError, shiftClip, splitClip, Timeline, trimHead, trimTail, WritableTimeline,
  type CaptionClip, type ColorClip, type Marker, type MediaClip, type TimelineOp,
} from "./index.js";

const caption = (id: string, start: number, end: number, text = id): CaptionClip => ({ id, kind: "caption", enabled: true, timelineIn: start, timelineOut: end, text });
const card = (id: string, start: number, end: number): ColorClip => ({ id, kind: "color", enabled: true, timelineIn: start, timelineOut: end, color: "black", opacity: 1 });
const marker = (id: string, time: number, end?: number): Marker => ({ id, time, end, kind: "note", text: id, resolved: false });

/** V1 holds a (0–10) and b (10–20), A1 holds music (0–20), and a caption track holds one line (2–4). */
function cut(): Timeline {
  const tl = emptyTimeline("project");
  tl.tracks[0]!.clips = [makeMediaClip("cam", 0, 10, 0, { id: "a" }), makeMediaClip("cam", 30, 40, 10, { id: "b" })];
  tl.tracks[1]!.clips = [makeMediaClip("music", 0, 20, 0, { id: "music" })];
  tl.tracks.push({ ...makeTrack("caption", "Captions", "cap"), clips: [caption("line", 2, 4)] });
  return tl;
}
const ids = (tl: Timeline, track: number) => tl.tracks[track]!.clips.map(c => c.id);
const spans = (tl: Timeline, track: number) => tl.tracks[track]!.clips.map(c => [c.id, c.timelineIn, clipEnd(c)]);

describe("moveClip", () => {
  it("moves a clip in time at its own length and keeps the track in time order", () => {
    const moved = applyOps(cut(), [{ op: "moveClip", clipId: "a", timelineIn: 25 }]);
    expect(spans(moved, 0)).toEqual([["b", 10, 20], ["a", 25, 35]]);
    expect(moved.tracks[0]!.clips[1]).toMatchObject({ sourceIn: 0, sourceOut: 10 });
  });

  it("moves a clip to another track, and takes a caption's word timings with it", () => {
    const base = cut();
    const toAudio = applyOps(base, [{ op: "moveClip", clipId: "b", timelineIn: 20, trackId: "a1" }]);
    expect(ids(toAudio, 0)).toEqual(["a"]);
    expect(spans(toAudio, 1)).toEqual([["music", 0, 20], ["b", 20, 30]]);
    (base.tracks[2]!.clips[0] as CaptionClip).words = [{ text: "one", start: 2, end: 3 }, { text: "two", start: 3, end: 4 }];
    const later = applyOps(base, [{ op: "moveClip", clipId: "line", timelineIn: 12 }]);
    expect(later.tracks[2]!.clips[0]).toMatchObject({ timelineIn: 12, timelineOut: 14, words: [{ start: 12, end: 13 }, { start: 13, end: 14 }] });
  });

  it("refuses a clip or a track that isn't there, and a caption on a picture track, leaving the cut as it was", () => {
    const base = cut();
    const before = structuredClone(base);
    expect(() => applyOps(base, [{ op: "moveClip", clipId: "nope", timelineIn: 1 }])).toThrow("clip nope not found");
    expect(() => applyOps(base, [{ op: "moveClip", clipId: "a", timelineIn: 1, trackId: "v9" }])).toThrow("track v9 not found");
    expect(() => applyOps(base, [{ op: "moveClip", clipId: "line", timelineIn: 1, trackId: "v1" }])).toThrow("clip kind caption cannot go on video track");
    expect(() => applyOps(base, [{ op: "moveClip", clipId: "a", timelineIn: 1, trackId: "cap" }])).toThrow("clip kind media cannot go on caption track");
    expect(() => applyOp(base, { op: "moveClip", clipId: "a", timelineIn: 1, trackId: "v9" })).toThrow(OpError);
    expect(base).toEqual(before);
  });
});

describe("setTimeline", () => {
  it("renames the timeline and sets its background and caption style, and nothing else", () => {
    const base = cut();
    const changed = applyOps(base, [{ op: "setTimeline", patch: { name: "Director's cut", background: "#101010", captionStyle: { uppercase: true } } }]);
    expect(changed).toMatchObject({ name: "Director's cut", background: "#101010", captionStyle: { uppercase: true } });
    expect(changed.tracks).toEqual(base.tracks);
    expect(base.name).toBe("Main");
    expect(applyOps(changed, [{ op: "setTimeline", patch: {} }])).toEqual(changed);
  });

  it("changes only the caption style settings a patch names, on the timeline and on a track", () => {
    const base = cut();
    base.captionStyle = { color: "#FFFF00", outlineWidth: 0.08 };
    base.tracks[2]!.captionStyle = { y: 0.2, uppercase: true };
    const changed = applyOps(base, [
      { op: "setTimeline", patch: { captionStyle: { fontSize: 0.06 } } },
      { op: "updateTrack", trackId: "cap", patch: { captionStyle: { y: 0.3 } } },
    ]);
    expect(changed.captionStyle).toEqual({ color: "#FFFF00", outlineWidth: 0.08, fontSize: 0.06 });
    expect(changed.tracks[2]!.captionStyle).toEqual({ y: 0.3, uppercase: true });
    expect(base.captionStyle).toEqual({ color: "#FFFF00", outlineWidth: 0.08 });
    // Code can still clear the whole style by naming it with no value.
    const cleared = applyOp(changed, { op: "setTimeline", patch: { captionStyle: undefined } });
    expect(cleared.captionStyle).toBeUndefined();
  });

  it("refuses a background that isn't a color", () => {
    expect(() => applyOps(cut(), [{ op: "setTimeline", patch: { background: "red,negate" } }])).toThrow(ZodError);
  });
});

describe("an op that can't be applied", () => {
  const refused: Array<[TimelineOp, string]> = [
    [{ op: "addClip", trackId: "v9", clip: makeMediaClip("cam", 0, 1, 50, { id: "new" }) }, "track v9 not found"],
    [{ op: "addClip", trackId: "a1", clip: makeMediaClip("cam", 0, 1, 50, { id: "a" }) }, "clip a already exists"],
    [{ op: "addClip", trackId: "cap", clip: makeMediaClip("cam", 0, 1, 50, { id: "new" }) }, "clip kind media cannot go on caption track"],
    [{ op: "removeClip", clipId: "nope" }, "clip nope not found"],
    [{ op: "updateClip", clipId: "nope", patch: { volume: 0 } }, "clip nope not found"],
    [{ op: "splitClip", clipId: "nope", at: 5 }, "clip nope not found"],
    // A split on the clip's own edge would leave a clip of no length.
    [{ op: "splitClip", clipId: "b", at: 10 }, "split point 10 outside clip [10, 20)"],
    [{ op: "splitClip", clipId: "b", at: 20 }, "split point 20 outside clip [10, 20)"],
    [{ op: "splitClip", clipId: "b", at: 3 }, "split point 3 outside clip [10, 20)"],
    [{ op: "splitClip", clipId: "b", at: 15, newClipId: "music" }, "clip music already exists"],
    [{ op: "rippleDelete", start: 5, end: 5 }, "end must be > start"],
    [{ op: "rippleDelete", start: 6, end: 5 }, "end must be > start"],
    [{ op: "addTrack", track: makeTrack("video", "V1 again", "v1") }, "track v1 already exists"],
    [{ op: "addTrack", track: { ...makeTrack("video", "V2", "v2"), clips: [makeMediaClip("cam", 0, 1, 0, { id: "music" })] } }, "clip music already exists"],
    [{ op: "removeTrack", trackId: "v9" }, "track v9 not found"],
    [{ op: "updateTrack", trackId: "v9", patch: { muted: true } }, "track v9 not found"],
    [{ op: "addMarker", marker: marker("here", 3) }, "marker here already exists"],
    [{ op: "removeMarker", markerId: "nope" }, "marker nope not found"],
    [{ op: "updateMarker", markerId: "nope", patch: { text: "x" } }, "marker nope not found"],
  ];

  it("fails as an OpError that names the op, and changes nothing", () => {
    const base = cut();
    base.markers = [marker("here", 1)];
    const before = structuredClone(base);
    for (const [op, message] of refused) {
      let error: unknown;
      try { applyOps(base, [op]); } catch (e) { error = e; }
      expect(error, message).toBeInstanceOf(OpError);
      expect(error).toMatchObject({ name: "OpError", message, op });
    }
    expect(base).toEqual(before);
  });
});

describe("updateClip", () => {
  it("patches a clip's fields but never its id or kind, and re-sorts the track when it moves", () => {
    const changed = applyOps(cut(), [{ op: "updateClip", clipId: "a", patch: { id: "renamed", kind: "color", volume: 0.25, timelineIn: 30 } }]);
    expect(ids(changed, 0)).toEqual(["b", "a"]);
    expect(changed.tracks[0]!.clips[1]).toMatchObject({ id: "a", kind: "media", volume: 0.25, timelineIn: 30 });
  });

  it("refuses a patch the clip's schema doesn't allow", () => {
    expect(() => applyOps(cut(), [{ op: "updateClip", clipId: "a", patch: { volume: -1 } }])).toThrow(ZodError);
    expect(() => applyOps(cut(), [{ op: "updateClip", clipId: "a", patch: { sourceIn: Number.NaN } }])).toThrow(ZodError);
  });
});

describe("tracks and markers", () => {
  it("adds a track at the end or at an index, patches it and removes it", () => {
    const v2 = makeTrack("video", "V2", "v2");
    expect(applyOps(cut(), [{ op: "addTrack", track: v2 }]).tracks.map(t => t.id)).toEqual(["v1", "a1", "cap", "v2"]);
    const inserted = applyOps(cut(), [{ op: "addTrack", track: v2, index: 1 }, { op: "updateTrack", trackId: "v2", patch: { name: "B-roll", hidden: true } }]);
    expect(inserted.tracks.map(t => t.id)).toEqual(["v1", "v2", "a1", "cap"]);
    expect(inserted.tracks[1]).toMatchObject({ name: "B-roll", hidden: true, muted: false, clips: [] });
    expect(applyOps(inserted, [{ op: "removeTrack", trackId: "a1" }]).tracks.map(t => t.id)).toEqual(["v1", "v2", "cap"]);
  });

  it("keeps markers in time order as they are added, patched and removed", () => {
    const added = applyOps(cut(), [{ op: "addMarker", marker: marker("late", 9) }, { op: "addMarker", marker: marker("early", 2, 3) }]);
    expect(added.markers.map(m => m.id)).toEqual(["early", "late"]);
    const patched = applyOps(added, [{ op: "updateMarker", markerId: "late", patch: { text: "Fix this", resolved: true } }, { op: "removeMarker", markerId: "early" }]);
    expect(patched.markers).toMatchObject([{ id: "late", time: 9, text: "Fix this", resolved: true }]);
  });
});

describe("a clip on a track of the other kind, which the renderer would skip", () => {
  const stray = () => makeMediaClip("cam", 0, 1, 50, { id: "new" });
  /** The cut with a media clip under its caption track, as a version saved before this was refused. */
  const misplaced = () => {
    const tl = cut();
    tl.tracks[2]!.clips.push(stray());
    return tl;
  };

  it("is refused when updateTrack changes a track's kind under its clips", () => {
    expect(() => applyOps(cut(), [{ op: "updateTrack", trackId: "cap", patch: { kind: "video" } }])).toThrow("clip line of kind caption cannot go on video track cap");
  });

  it("is refused when addTrack brings it", () => {
    expect(() => applyOps(cut(), [{ op: "addTrack", track: { ...makeTrack("caption", "x", "t"), clips: [stray()] } }]))
      .toThrow("clip new of kind media cannot go on caption track t");
  });

  it("is refused in a whole timeline that lists a media clip under a caption track", () => {
    expect(WritableTimeline.safeParse(misplaced()).error?.issues).toMatchObject([{ path: ["tracks", 2, "clips", 1], message: "clip new of kind media cannot go on caption track cap" }]);
  });

  it("is refused in a whole timeline that lists a caption under a video or audio track", () => {
    for (const [track, kind, id] of [[0, "video", "v1"], [1, "audio", "a1"]] as const) {
      const captioned = cut();
      // Two of them on the track: the first is the one named.
      captioned.tracks[track]!.clips.push(caption("new", 30, 31), caption("next", 31, 32));
      expect(WritableTimeline.safeParse(captioned).error?.issues).toMatchObject([{ message: `clip new of kind caption cannot go on ${kind} track ${id}` }]);
    }
  });

  it("holds up other edits of a version that already has one, until an edit moves it or removes it", () => {
    expect(() => applyOps(misplaced(), [{ op: "updateTrack", trackId: "a1", patch: { muted: true } }])).toThrow("clip new of kind media cannot go on caption track cap");
    expect(ids(applyOps(misplaced(), [{ op: "moveClip", clipId: "new", timelineIn: 50, trackId: "v1" }]), 0)).toEqual(["a", "b", "new"]);
    expect(ids(applyOps(misplaced(), [{ op: "removeClip", clipId: "new" }]), 2)).toEqual(["line"]);
  });

  it("leaves valid tracks alone, and a saved version that holds one readable", () => {
    expect(WritableTimeline.safeParse(cut()).success).toBe(true);
    expect(applyOps(cut(), [{ op: "updateTrack", trackId: "a1", patch: { kind: "video", muted: true } }]).tracks[1]).toMatchObject({ kind: "video", muted: true });
    expect(Timeline.parse(misplaced())).toEqual(misplaced());
  });
});

describe("a ripple", () => {
  it("moves markers after a removal earlier and pulls ones inside it to where the footage now joins", () => {
    const base = cut();
    base.markers = [marker("before", 1), marker("inside", 5), marker("at end", 6), marker("after", 10), marker("into", 3, 5), marker("across", 3, 9), marker("out of", 5, 9)];
    const removed = applyOps(base, [{ op: "rippleDelete", start: 4, end: 6 }]);
    expect(Object.fromEntries(removed.markers.map(m => [m.id, m.end === undefined ? m.time : [m.time, m.end]]))).toEqual({
      before: 1, inside: 4, "at end": 4, after: 8, into: [3, 4], across: [3, 7], "out of": [4, 7],
    });
  });

  it("removes from, or opens a gap in, only the tracks it names", () => {
    const removed = applyOps(cut(), [{ op: "rippleDelete", start: 4, end: 6, trackIds: ["v1"] }]);
    expect(spans(removed, 0).map(([, start, end]) => [start, end])).toEqual([[0, 4], [4, 8], [8, 18]]);
    expect(spans(removed, 1)).toEqual([["music", 0, 20]]);
    expect(spans(removed, 2)).toEqual([["line", 2, 4]]);
    const gap = applyOps(cut(), [{ op: "rippleInsertGap", at: 10, duration: 2, trackIds: ["a1"] }]);
    expect(spans(gap, 0)).toEqual([["a", 0, 10], ["b", 10, 20]]);
    expect(spans(gap, 1).map(([, start, end]) => [start, end])).toEqual([[0, 10], [12, 22]]);
  });

  it("drops clips of every kind that sit inside a removal and trims the ones across its edges", () => {
    const base = cut();
    base.tracks[0]!.clips.push(card("black", 20, 26));
    base.tracks[2]!.clips.push(caption("gone", 5, 6), caption("tail", 6.5, 8));
    const removed = applyOps(base, [{ op: "rippleDelete", start: 3, end: 7 }, { op: "rippleDelete", start: 15, end: 18 }]);
    // After the first removal the card sits at 16–22; the second trims its head to 18 and closes up to 15.
    expect(spans(removed, 0).filter(([id]) => id === "black")).toEqual([["black", 15, 19]]);
    expect(spans(removed, 2)).toEqual([["line", 2, 3], ["tail", 3, 4]]);
  });
});

describe("clip pieces", () => {
  const clip = makeMediaClip("cam", 10, 30, 100, { id: "c", speed: 2, audioFadeIn: 0.2, audioFadeOut: 0.3, videoFadeIn: 0.4, videoFadeOut: 0.5 });

  it("trim at the clip's speed, and leave a clip alone when the trim point is outside it", () => {
    // 20 s of source at double speed plays for 10 s: 100–110.
    expect(clipEnd(clip)).toBe(110);
    expect(trimHead(clip, 104)).toMatchObject({ timelineIn: 104, sourceIn: 18, sourceOut: 30 });
    expect(trimTail(clip, 104)).toMatchObject({ timelineIn: 100, sourceIn: 10, sourceOut: 18 });
    expect(trimHead(clip, 100)).toBe(clip);
    expect(trimHead(clip, 90)).toBe(clip);
    expect(trimTail(clip, 110)).toBe(clip);
    expect(trimTail(clip, 120)).toBe(clip);
    expect(trimHead(card("k", 2, 6), 3)).toMatchObject({ timelineIn: 3, timelineOut: 6 });
    expect(trimTail(card("k", 2, 6), 3)).toMatchObject({ timelineIn: 2, timelineOut: 3 });
  });

  it("split into two that keep their fades only on the outer edges", () => {
    const [left, right] = splitClip(clip, 104, "c2") as [MediaClip, MediaClip];
    expect(left).toMatchObject({ id: "c", sourceIn: 10, sourceOut: 18, audioFadeIn: 0.2, videoFadeIn: 0.4, audioFadeOut: 0, videoFadeOut: 0 });
    expect(right).toMatchObject({ id: "c2", timelineIn: 104, sourceIn: 18, sourceOut: 30, audioFadeIn: 0, videoFadeIn: 0, audioFadeOut: 0.3, videoFadeOut: 0.5 });
    expect(clip).toMatchObject({ audioFadeOut: 0.3, videoFadeIn: 0.4 });
  });

  it("shift without going before the start of the timeline, where a caption keeps only the words still on it", () => {
    expect(shiftClip(clip, -30)).toMatchObject({ timelineIn: 70, sourceIn: 10 });
    expect(shiftClip(clip, -130).timelineIn).toBe(0);
    expect(shiftClip(card("k", 2, 6), -3)).toMatchObject({ timelineIn: 0, timelineOut: 3 });
    const words = [{ text: "one", start: 2, end: 3 }, { text: "two", start: 3, end: 4 }, { text: "three", start: 4, end: 5 }];
    const line: CaptionClip = { ...caption("line", 2, 5, "one two three"), words };
    expect(shiftClip(line, 1)).toMatchObject({ timelineIn: 3, timelineOut: 6, text: "one two three", words: [{ start: 3 }, { start: 4 }, { start: 5 }] });
    expect(shiftClip(line, -3.5)).toMatchObject({ timelineIn: 0, timelineOut: 1.5, text: "two three", words: [{ text: "two", start: 0, end: 0.5 }, { text: "three", start: 0.5, end: 1.5 }] });
  });
});
