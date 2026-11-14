import { describe, expect, it } from "vitest";
import { doubledSound, emptyTimeline, introducedDoubledSound, makeMediaClip, type MediaClip, type Timeline } from "./index.js";

const media = [
  { id: "media-a", kind: "video" as const, hasAudio: true },
  { id: "media-b", kind: "video" as const, hasAudio: true },
  { id: "silent", kind: "video" as const, hasAudio: false },
  { id: "still", kind: "image" as const },
];

function timeline(video: MediaClip[], audio: MediaClip[] = []): Timeline {
  const tl = emptyTimeline("project");
  tl.tracks[0]!.clips = video;
  tl.tracks[1]!.clips = audio;
  return tl;
}

// The saved edit from #18: the whole recording on V1 and again on A1, both at unity gain.
const reported = () => timeline(
  [makeMediaClip("media-a", 0, 5.75, 0, { id: "video-clip" })],
  [makeMediaClip("media-a", 0, 5.75, 0, { id: "audio-clip" })],
);

describe("doubled sound", () => {
  it("finds the report's video and audio clips playing the same moment of one recording", () => {
    expect(doubledSound(reported(), media)).toEqual([
      { mediaId: "media-a", clipIds: ["video-clip", "audio-clip"], overlap: { start: 0, end: 5.75 } },
    ]);
  });

  it("finds a partial overlap, at the timeline range both clips play", () => {
    const tl = timeline(
      [makeMediaClip("media-a", 2, 8, 2, { id: "v" })],
      [makeMediaClip("media-a", 0, 5, 0, { id: "a" })],
    );
    expect(doubledSound(tl, media)).toEqual([{ mediaId: "media-a", clipIds: ["a", "v"], overlap: { start: 2, end: 5 } }]);
  });

  it("compares where the overlap starts on each clip's own clock, at its speed", () => {
    // Both play source 4 s at timeline 2 s at double speed, from different places on the timeline.
    const tl = timeline(
      [makeMediaClip("media-a", 0, 8, 0, { id: "v", speed: 2 })],
      [makeMediaClip("media-a", 4, 8, 2, { id: "a", speed: 2 })],
    );
    expect(doubledSound(tl, media)).toEqual([{ mediaId: "media-a", clipIds: ["v", "a"], overlap: { start: 2, end: 4 } }]);
  });

  it("leaves the edit as it should have been: the video clip at volume 0 with the sound on A1", () => {
    const tl = reported();
    (tl.tracks[0]!.clips[0] as MediaClip).volume = 0;
    expect(doubledSound(tl, media)).toEqual([]);
  });

  it("leaves a copy offset by less than a frame, which can be a deliberate audio offset", () => {
    const tl = reported();
    // 5 ms is under a frame at any common rate.
    tl.tracks[1]!.clips[0] = makeMediaClip("media-a", 0.005, 5.75, 0, { id: "audio-clip" });
    expect(doubledSound(tl, media)).toEqual([]);
    tl.tracks[1]!.clips[0] = makeMediaClip("media-a", 0, 5.75, 0.005, { id: "audio-clip" });
    expect(doubledSound(tl, media)).toEqual([]);
  });

  it("leaves a copy at another speed, a muted track, a disabled clip and two different recordings", () => {
    const speed = timeline([makeMediaClip("media-a", 0, 5, 0)], [makeMediaClip("media-a", 0, 10, 0, { speed: 2 })]);
    const muted = reported();
    muted.tracks[1]!.muted = true;
    const disabled = reported();
    disabled.tracks[1]!.clips[0]!.enabled = false;
    const other = timeline([makeMediaClip("media-a", 0, 5, 0)], [makeMediaClip("media-b", 0, 5, 0)]);
    for (const tl of [speed, muted, disabled, other]) expect(doubledSound(tl, media)).toEqual([]);
  });

  it("leaves media with no sound, and the picture of a hidden track still counts as heard", () => {
    const silent = timeline([makeMediaClip("silent", 0, 5, 0)], [makeMediaClip("silent", 0, 5, 0)]);
    const still = timeline([makeMediaClip("still", 0, 5, 0)], [makeMediaClip("still", 0, 5, 0)]);
    expect(doubledSound(silent, media)).toEqual([]);
    expect(doubledSound(still, media)).toEqual([]);
    // The renderer mixes a hidden video track's sound, so hiding the picture doesn't take the second copy out.
    const hidden = reported();
    hidden.tracks[0]!.hidden = true;
    expect(doubledSound(hidden, media)).toHaveLength(1);
  });

  it("leaves a crossfade between two clips that continue the same source", () => {
    // Split at 5 s with nothing removed, then crossfaded over two frames at 30 fps: each fades across the overlap.
    const fade = 2 / 30;
    const tl = timeline([], [
      makeMediaClip("media-a", 0, 5 + fade / 2, 0, { id: "left", audioFadeOut: fade }),
      makeMediaClip("media-a", 5 - fade / 2, 10, 5 - fade / 2, { id: "right", audioFadeIn: fade }),
    ]);
    expect(doubledSound(tl, media)).toEqual([]);
    // Without the fades it's the same sound twice.
    (tl.tracks[1]!.clips[0] as MediaClip).audioFadeOut = 0;
    expect(doubledSound(tl, media)).toHaveLength(1);
  });

  it("reports only the pairs an edit introduced", () => {
    const before = reported();
    const next = reported();
    next.tracks[1]!.clips.push(makeMediaClip("media-a", 0, 2, 10, { id: "late-a" }));
    next.tracks[0]!.clips.push(makeMediaClip("media-a", 0, 2, 10, { id: "late-v" }));
    expect(introducedDoubledSound(before, next, media)).toEqual([
      { mediaId: "media-a", clipIds: ["late-v", "late-a"], overlap: { start: 10, end: 12 } },
    ]);
    expect(introducedDoubledSound(null, before, media)).toHaveLength(1);
  });
});
