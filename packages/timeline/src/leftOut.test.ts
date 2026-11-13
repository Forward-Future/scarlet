import { describe, expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, timelineFromKeepRanges } from "./builders.js";
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
});
