import { describe, expect, it } from "vitest";
import {
  clampRange, clipDuration, clock, clipEnd, clipRange, clipsAt, emptyTimeline, frameAlignedRemoval, filmstripBatches, FILMSTRIP_SEEK_BATCH, makeMediaClip, planSegments,
  rangesOverlap, mergeRanges, snapToFrame, sourceClockAnchors, sparseFilmstrip, timelineDuration, timelineToSource, trackDuration, withHandles,
  MAX_TIMELINE_SECONDS, planPlaybackSegments, WritableTimeline, type ColorClip, type Timeline,
} from "./index.js";

const settings = { settings: { fps: 30 } } as Parameters<typeof planSegments>[0];
const card = (start: number, end: number): ColorClip => ({ id: `card${start}`, kind: "color", enabled: true, timelineIn: start, timelineOut: end, color: "black", opacity: 1 });
function timeline(...clips: Timeline["tracks"][number]["clips"]): Timeline {
  const tl = emptyTimeline("project");
  tl.tracks[0]!.clips = clips;
  return tl;
}

it("rejects new and historical versions beyond the planning budget before enumerating sections", () => {
  const stored = timeline(card(0, MAX_TIMELINE_SECONDS + 1));
  expect(WritableTimeline.safeParse(stored).success).toBe(false);
  expect(() => planPlaybackSegments(settings, stored)).toThrow("24 hours");
  expect(() => planSegments(settings, stored)).toThrow("24 hours");
  const shortEdit = timeline(makeMediaClip("m", 0, 24, 0, { speed: 2 }));
  expect(() => sourceClockAnchors(shortEdit, 4, 3)).toThrow("too many playback sections");
});

it("reads a clock for people to the second, with hours only past an hour", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(125.9)).toBe("2:05");
  expect(clock(3599)).toBe("59:59");
  expect(clock(3600)).toBe("1:00:00");
  expect(clock(4503)).toBe("1:15:03");
  expect(clock(59.9999999)).toBe("1:00");
  expect(clock(-3)).toBe("0:00");
});

describe("clip and timeline lengths", () => {
  it("measure a media clip by its source at its speed, and never as less than nothing", () => {
    const fast = makeMediaClip("m", 10, 30, 5, { speed: 2 });
    expect(clipDuration(fast)).toBe(10);
    expect(clipRange(fast)).toEqual({ start: 5, end: 15 });
    expect(timelineToSource(fast, 8)).toBe(16);
    // A time before the clip maps to its first source frame.
    expect(timelineToSource(fast, 1)).toBe(10);
    expect(clipDuration(makeMediaClip("m", 30, 10, 0))).toBe(0);
    expect(clipDuration(card(6, 2))).toBe(0);
    expect(clipEnd(card(2, 6))).toBe(6);
  });

  it("take the latest clip end on any track", () => {
    const tl = timeline(makeMediaClip("m", 0, 4, 0), card(10, 12));
    tl.tracks[1]!.clips = [makeMediaClip("m", 0, 20, 1)];
    expect(trackDuration(tl.tracks[0]!)).toBe(12);
    expect(timelineDuration(tl)).toBe(21);
    expect(timelineDuration(emptyTimeline("project"))).toBe(0);
  });

  it("find the clips under a time, counting a clip's first instant but not its last", () => {
    const tl = timeline(makeMediaClip("m", 0, 4, 0, { id: "a" }), makeMediaClip("m", 4, 8, 4, { id: "b" }));
    tl.tracks[1]!.clips = [makeMediaClip("m", 0, 8, 0, { id: "music" })];
    expect(clipsAt(tl, 4).map(x => [x.track.id, x.clip.id])).toEqual([["v1", "b"], ["a1", "music"]]);
    expect(clipsAt(tl, 3.999).map(x => x.clip.id)).toEqual(["a", "music"]);
    expect(clipsAt(tl, 8)).toEqual([]);
  });
});

describe("ranges", () => {
  it("keeps a bounded sub-frame removal exact when rounding would consume a retained frame", () => {
    const tiny = { start: .012, end: .022 };
    expect(frameAlignedRemoval(tiny, 30)).toEqual({ start: 0, end: 1 / 30 });
    expect(frameAlignedRemoval(tiny, 30, tiny)).toEqual(tiny);
    expect(frameAlignedRemoval(tiny, 30, undefined, [{ start: 0, end: tiny.start }, { start: tiny.end, end: 1 }])).toEqual(tiny);
  });

  it("clamp both ends into the limits, even a range wholly outside them", () => {
    expect(clampRange({ start: -2, end: 5 }, 0, 10)).toEqual({ start: 0, end: 5 });
    expect(clampRange({ start: 4, end: 15 }, 0, 10)).toEqual({ start: 4, end: 10 });
    expect(clampRange({ start: 12, end: 15 }, 0, 10)).toEqual({ start: 10, end: 10 });
    expect(clampRange({ start: -5, end: -1 }, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  it("grow by a handle each side without leaving the timeline", () => {
    expect(withHandles({ start: 5, end: 6 }, 2, 60)).toEqual({ start: 3, end: 8 });
    expect(withHandles({ start: 1, end: 59 }, 2, 60)).toEqual({ start: 0, end: 60 });
    // A join is a range of no length: its handles are the whole preview.
    expect(withHandles({ start: 30, end: 30 }, 2, 60)).toEqual({ start: 28, end: 32 });
  });

  it("overlap only when they share more than an edge, and merge when they touch or sit within the gap allowed", () => {
    expect(rangesOverlap({ start: 0, end: 2 }, { start: 2, end: 4 })).toBe(false);
    expect(rangesOverlap({ start: 0, end: 2.001 }, { start: 2, end: 4 })).toBe(true);
    expect(rangesOverlap({ start: 1, end: 2 }, { start: 0, end: 10 })).toBe(true);
    const ranges = [{ start: 5, end: 6 }, { start: 0, end: 2 }, { start: 2, end: 3 }, { start: 6.4, end: 7 }];
    expect(mergeRanges(ranges)).toEqual([{ start: 0, end: 3 }, { start: 5, end: 6 }, { start: 6.4, end: 7 }]);
    expect(mergeRanges(ranges, 0.5)).toEqual([{ start: 0, end: 3 }, { start: 5, end: 7 }]);
    // The input is left as it was, and a range inside another doesn't shorten it.
    expect(ranges[0]).toEqual({ start: 5, end: 6 });
    expect(mergeRanges([{ start: 0, end: 10 }, { start: 2, end: 3 }])).toEqual([{ start: 0, end: 10 }]);
  });
});

describe("frames", () => {
  it("snap a time to the nearest frame", () => {
    expect(snapToFrame(1.01, 30)).toBe(30 / 30);
    expect(snapToFrame(1.02, 30)).toBe(31 / 30);
    expect(snapToFrame(122.333, 30)).toBe(3670 / 30);
    expect(snapToFrame(0.49, 1)).toBe(0);
    expect(snapToFrame(10, 23.976)).toBeCloseTo(10.01, 2);
  });

  it("decode a filmstrip's frames together when they are close, four at a time when far apart, and one at a time when any repeats", () => {
    // Sparse means at least three seconds between frames on average.
    expect(sparseFilmstrip([0, 90], 30)).toBe(true);
    expect(sparseFilmstrip([0, 89], 30)).toBe(false);
    expect(sparseFilmstrip([0, 10, 180], 30)).toBe(true);
    expect(sparseFilmstrip([500], 30)).toBe(false);
    expect(sparseFilmstrip([], 30)).toBe(false);
    const near = [0, 10, 20, 30, 40, 50];
    expect(filmstripBatches(near, 30)).toEqual([near]);
    const far = [0, 100, 200, 300, 400, 500];
    expect(FILMSTRIP_SEEK_BATCH).toBe(4);
    expect(filmstripBatches(far, 30)).toEqual([[0, 100, 200, 300], [400, 500]]);
    expect(filmstripBatches([0, 100, 100, 300], 30)).toEqual([[0], [100], [100], [300]]);
    expect(filmstripBatches([], 30)).toEqual([]);
  });
});

describe("render sections", () => {
  it("are none for an empty timeline, and one for a cut shorter than a section and a half", () => {
    expect(planSegments(settings, emptyTimeline("project"))).toEqual([]);
    expect(planSegments(settings, timeline(makeMediaClip("m", 0, 14, 0)))).toEqual([{ start: 0, end: 14 }]);
  });

  it("run about ten seconds, with a tail under half a section joined to the one before", () => {
    expect(planSegments(settings, timeline(makeMediaClip("m", 0, 34, 0)))).toEqual([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 34 }]);
    expect(planSegments(settings, timeline(makeMediaClip("m", 0, 36, 0)))).toEqual([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }, { start: 30, end: 36 }]);
  });

  it("end on the last clip boundary in the second half of a section, on any track, and ignore one in the first half", () => {
    const tl = timeline(makeMediaClip("m", 0, 7, 0), makeMediaClip("m", 20, 38, 7));
    expect(planSegments(settings, tl)).toEqual([{ start: 0, end: 7 }, { start: 7, end: 17 }, { start: 17, end: 25 }]);
    // Music that starts at 9 s is a later boundary in the first section's reach.
    tl.tracks[1]!.clips = [makeMediaClip("music", 0, 16, 9)];
    expect(planSegments(settings, tl)).toEqual([{ start: 0, end: 9 }, { start: 9, end: 19 }, { start: 19, end: 25 }]);
    // A boundary 3 s into a section would leave a section under half length, so the section runs its ten seconds.
    const early = timeline(makeMediaClip("m", 0, 25, 0));
    early.tracks[1]!.clips = [makeMediaClip("music", 0, 22, 3)];
    expect(planSegments(settings, early)).toEqual([{ start: 0, end: 10 }, { start: 10, end: 25 }]);
  });

  it("cover a given program length rather than the timeline's, in sections no shorter than a frame", () => {
    const tl = timeline(makeMediaClip("m", 0, 100, 0));
    expect(planSegments(settings, tl, 10, 12)).toEqual([{ start: 0, end: 12 }]);
    expect(planSegments(settings, tl, 0, 3 / 30).map(r => Math.round((r.end - r.start) * 30))).toEqual([1, 1, 1]);
    expect(planSegments(settings, tl, 10, 0)).toEqual([]);
  });

  it("anchor to the first picture track's source clock, or the first audio track's when there is no picture", () => {
    const tl = timeline(makeMediaClip("cam", 3, 11, 0), makeMediaClip("cam", 20, 26, 8, { speed: 2 }));
    // Source seconds 4 and 8 of the first clip, then 20 (its own start, not counted), 24 at double speed.
    expect(sourceClockAnchors(tl, 4)).toEqual([1, 5, 10]);
    const sound = emptyTimeline("project");
    sound.tracks[1]!.clips = [makeMediaClip("mic", 2, 10, 0)];
    expect(sourceClockAnchors(sound, 4)).toEqual([2, 6]);
    sound.tracks[0]!.clips = [{ ...makeMediaClip("cam", 0, 10, 0), enabled: false }, card(0, 10)];
    expect(sourceClockAnchors(sound, 4)).toEqual([2, 6]);
    expect(sourceClockAnchors(emptyTimeline("project"), 4)).toEqual([]);
  });
});
