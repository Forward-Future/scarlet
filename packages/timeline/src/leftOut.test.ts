import { describe, expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, timelineFromKeepRanges } from "./builders.js";
import { replayJoinFades } from "./joinCrossfade.js";
import { leftOutJoins } from "./leftOut.js";
import { clipEnd, timelineDuration } from "./time.js";
import type { MediaClip, Timeline } from "./schema.js";

/** A screen recording under a camera recorded with it, the camera `offset` seconds ahead, with the camera's sound. */
function screenAndCamera(keep: Array<[number, number]>, { offset = 2, screenFrom = 0 } = {}): Timeline {
  const tl = emptyTimeline("p");
  const [v1, a1] = [tl.tracks[0]!, tl.tracks[1]!];
  const v2 = { ...v1, id: "v2", name: "Camera", clips: [] as MediaClip[] };
  tl.tracks.push(v2);
  let at = 0;
  keep.forEach(([start, end], i) => {
    if (i >= screenFrom) v1.clips.push(makeMediaClip("screen", start, end, at, { volume: 0 }));
    v2.clips.push(makeMediaClip("camera", start + offset, end + offset, at, { volume: 0 }));
    a1.clips.push(makeMediaClip("camera", start + offset, end + offset, at));
    at += end - start;
  });
  return tl;
}

describe("leftOutJoins", () => {
  const empty = emptyTimeline("p");

  it("reads the footage a version built from pieces of two recordings left out between them", () => {
    const built = screenAndCamera([[10, 20], [25, 40], [40, 50], [80, 90]]);
    const found = leftOutJoins(empty, built)!;
    // The start of the recording, then each join, in the clock of the version that plays them all. A split that
    // keeps every frame (40) is no join.
    expect(found.joins).toEqual([
      { at: 0, removed: { start: 0, end: 10 } },
      { at: 10, removed: { start: 20, end: 25 } },
      { at: 35, removed: { start: 50, end: 80 } },
    ]);
    expect(timelineDuration(found.original)).toBeCloseTo(90);
    for (const track of found.original.tracks) {
      const clips = track.clips as MediaClip[];
      // Each track plays its own recording straight through, the camera still two seconds ahead.
      const ahead = clips[0]!.mediaId === "camera" ? 2 : 0;
      expect(clips[0]!.sourceIn).toBeCloseTo(ahead);
      for (const clip of clips) expect(clip.sourceIn - clip.timelineIn).toBeCloseTo(ahead);
      for (let i = 1; i < clips.length; i++) expect(clips[i]!.timelineIn).toBeCloseTo(clipEnd(clips[i - 1]!));
    }
  });

  it("leaves a join an earlier version already had to that version", () => {
    const first = screenAndCamera([[10, 20], [25, 40]]);
    const next = screenAndCamera([[10, 20], [25, 40], [60, 70]]);
    expect(leftOutJoins(first, next)!.joins).toEqual([{ at: 25, removed: { start: 25, end: 45 } }]);
    expect(leftOutJoins(next, next)).toBeNull();
  });

  it("finds nothing left out by a screen and an inset laid over a camera already cut where they join", () => {
    // The camera is cut first. The demo then lays the screen and a camera inset over it, piece by piece, following those
    // cuts: the screen recorded with the camera skips the same stretches, and nothing more comes out.
    const cut = screenAndCamera([[10, 20], [25, 40], [60, 70]], { offset: 0 });
    const camera = cut.tracks[2]!;
    const before: Timeline = { ...cut, tracks: [cut.tracks[1]!, camera] };
    const inset = { ...camera, id: "inset", clips: camera.clips.map(c => ({ ...c, id: `${c.id}_inset` })) };
    const framed: Timeline = { ...cut, tracks: [cut.tracks[1]!, camera, cut.tracks[0]!, inset] };
    expect(leftOutJoins(before, framed)).toBeNull();
    // Without the camera's cuts there before, the same pieces left the footage between them out.
    expect(leftOutJoins(empty, framed)!.joins.map(j => j.at)).toEqual([0, 10, 25]);
  });

  it("opens the join on a track that plays through it or has nothing there", () => {
    // The screen comes in at the third piece, and a title holds across the first join.
    const built = screenAndCamera([[0, 10], [14, 20], [30, 40]], { screenFrom: 2, offset: 0 });
    built.tracks.push({ ...built.tracks[0]!, id: "v3", clips: [makeMediaClip("title", 0, 12, 4)] });
    const found = leftOutJoins(empty, built)!;
    expect(found.joins).toEqual([{ at: 10, removed: { start: 10, end: 14 } }, { at: 16, removed: { start: 20, end: 30 } }]);
    const screen = found.original.tracks[0]!.clips as MediaClip[];
    expect(screen.map(c => [c.timelineIn, c.sourceIn])).toEqual([[30, 30]]);
    const title = found.original.tracks.at(-1)!.clips as MediaClip[];
    expect(title.map(c => [c.timelineIn, c.sourceIn, c.sourceOut])).toEqual([[4, 0, 10], [14, 6, 12]]);
  });

  it("finds nothing left out where footage was rearranged, repeated or cut differently on each track", () => {
    expect(leftOutJoins(empty, timelineFromKeepRanges("p", "m", [{ start: 50, end: 60 }, { start: 10, end: 20 }]))!.joins)
      .toEqual([{ at: 0, removed: { start: 0, end: 50 } }]);
    const whole = timelineFromKeepRanges("p", "m", [{ start: 0, end: 100 }]);
    expect(leftOutJoins(whole, timelineFromKeepRanges("p", "m", [{ start: 0, end: 60 }, { start: 30, end: 100 }]))).toBeNull();
    const uneven = screenAndCamera([[0, 10], [14, 20]]);
    (uneven.tracks[0]!.clips[1] as MediaClip).sourceIn = 12;
    (uneven.tracks[0]!.clips[1] as MediaClip).sourceOut = 18;
    expect(leftOutJoins(whole, uneven)).toBeNull();
  });

  it("keeps sound in sync across a crossfaded join when opening the footage it left out", () => {
    // Two cuts with centered audio crossfades; the second cut is then extended 2 s earlier and crossfaded again.
    const before = replayJoinFades(
      screenAndCamera([[10, 20], [25, 42], [48, 60]], { offset: 2 }),
      [{ at: 10, trackId: "a1" }, { at: 27, trackId: "a1" }],
      0.0667,
    );
    const after = replayJoinFades(
      screenAndCamera([[10, 20], [25, 40], [48, 60]], { offset: 2 }),
      [{ at: 10, trackId: "a1" }, { at: 25, trackId: "a1" }],
      0.0667,
    );
    const found = leftOutJoins(before, after, 30)!;
    // Only the extended join at 25 s is new (the whole 8 s stretch 40..48 left out there); 10 s was already cut.
    expect(found.joins).toEqual([{ at: 25, removed: { start: 25, end: 33 } }]);
    expect(timelineDuration(found.original)).toBeCloseTo(45);

    const video = found.original.tracks[2]!.clips as MediaClip[];
    const audio = found.original.tracks[1]!.clips as MediaClip[];
    expect(audio).toHaveLength(3);
    expect(audio.map(c => c.id).some(id => id.includes("_after"))).toBe(false);
    // The opened join at 25..33 s plays straight through in sync with the camera, with its crossfade cleared.
    expect(audio[1]!.timelineIn).toBeCloseTo(10 - 0.0667 / 2);
    expect(clipEnd(audio[1]!)).toBeCloseTo(33);
    expect(audio[1]!.sourceOut).toBeCloseTo(50);
    expect(audio[1]!.audioFadeOut).toBe(0);
    expect(audio[2]!.timelineIn).toBeCloseTo(33);
    expect(audio[2]!.sourceIn).toBeCloseTo(50);
    expect(audio[2]!.audioFadeIn).toBe(0);
    // The untouched cut at 10 s keeps its crossfade.
    expect(audio[0]!.audioFadeOut).toBeCloseTo(0.0667);
    expect(audio[1]!.audioFadeIn).toBeCloseTo(0.0667);
    // Every clip on the audio track stays in exact sync with its camera clip (no 8 s slip across 25..33 s).
    for (let i = 0; i < audio.length; i++) {
      expect(audio[i]!.sourceIn - audio[i]!.timelineIn).toBeCloseTo(video[i]!.sourceIn - video[i]!.timelineIn);
    }
  });

  it("opens multiple adjacent crossfaded joins in sync and treats already-crossfaded joins as known", () => {
    const plain = screenAndCamera([[10, 20], [25, 40], [50, 60]], { offset: 2 });
    const faded = replayJoinFades(plain, [{ at: 10, trackId: "a1" }, { at: 25, trackId: "a1" }], 0.0667);
    // Adding crossfades to cuts `before` already had leaves nothing new out.
    expect(leftOutJoins(plain, faded, 30)).toBeNull();
    // Nudging a video clip at a join `before`'s crossfaded dialogue already had leaves nothing new out.
    const nudged = structuredClone(faded);
    const v2Clip = nudged.tracks[2]!.clips[1] as MediaClip;
    v2Clip.sourceIn -= 0.05;
    v2Clip.sourceOut -= 0.05;
    expect(leftOutJoins(faded, nudged, 30)).toBeNull();
    // Building all pieces with crossfades from empty opens every join cleanly and in sync.
    const found = leftOutJoins(empty, faded, 30)!;
    expect(found.joins).toEqual([
      { at: 0, removed: { start: 0, end: 10 } },
      { at: 10, removed: { start: 20, end: 25 } },
      { at: 25, removed: { start: 40, end: 50 } },
    ]);
    const audio = found.original.tracks[1]!.clips as MediaClip[];
    expect(audio).toHaveLength(3);
    for (const clip of audio) {
      expect(clip.sourceIn - clip.timelineIn).toBeCloseTo(2);
      expect(clip.audioFadeIn).toBe(0);
      expect(clip.audioFadeOut).toBe(0);
    }
    for (let i = 1; i < audio.length; i++) expect(audio[i]!.timelineIn).toBeCloseTo(clipEnd(audio[i - 1]!));
  });
});
