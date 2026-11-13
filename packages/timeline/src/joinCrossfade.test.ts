import { describe, expect, it } from "vitest";
import { applyOps } from "./ops.js";
import { emptyTimeline, makeMediaClip } from "./builders.js";
import { timelineDuration } from "./time.js";
import type { MediaAsset } from "./schema.js";
import { audioCrossfadeOps, crossfadeJoins, playedEdges, replayJoinFades, rippleJoins } from "./joinCrossfade.js";

const media: MediaAsset[] = [{ id: "m", kind: "video", name: "Interview", path: "interview", duration: 12, hasAudio: true }];
const joins = [{ leftClipId: "a", rightClipId: "b" }, { leftClipId: "b", rightClipId: "c" }];

function cut(kind: "video" | "audio") {
  const timeline = emptyTimeline("project");
  const track = timeline.tracks.find(t => t.kind === kind)!;
  track.clips = [
    makeMediaClip("m", 0, 1, 0, { id: "a" }),
    makeMediaClip("m", 4, 6, 1, { id: "b", speed: 2, volume: 0.7, effects: [{ type: "expander", params: {}, enabled: true }] }),
    makeMediaClip("m", 9, 10, 2, { id: "c", audioFadeOut: 0.2 }),
  ];
  return { timeline, track };
}

describe("centered dialogue crossfades", () => {
  it.each(["audio", "video"] as const)("uses real handles and preserves sync and outer fades on %s", kind => {
    const { timeline, track } = cut(kind);
    const result = applyOps(timeline, audioCrossfadeOps(timeline, media, joins, 0.08));
    const sound = kind === "audio" ? result.tracks[1]! : result.tracks.at(-1)!;
    expect(sound.clips).toMatchObject([
      { timelineIn: 0, sourceIn: 0, sourceOut: 1.04, audioFadeIn: 0, audioFadeOut: 0.08 },
      { timelineIn: 0.96, sourceIn: 3.92, sourceOut: 6.08, audioFadeIn: 0.08, audioFadeOut: 0.08, speed: 2, volume: 0.7, effects: [{ type: "expander" }] },
      { timelineIn: 1.96, sourceIn: 8.96, sourceOut: 10, audioFadeIn: 0.08, audioFadeOut: 0.2 },
    ]);
    expect(timelineDuration(result)).toBeCloseTo(timelineDuration(timeline));
    if (kind === "video") expect(result.tracks[0]!.clips).toEqual(track.clips.map(c => ({ ...c, volume: 0 })));
  });

  it("rejects missing source handles, manual fades and duplicate joins before proposing edits", () => {
    const { timeline, track } = cut("audio");
    expect(() => audioCrossfadeOps(timeline, [{ ...media[0]!, duration: 6 }], joins, 0.08)).toThrow(/handles/);
    expect(() => audioCrossfadeOps(timeline, media, [joins[0]!, joins[0]!], 0.08)).toThrow(/twice/);
    const left = track.clips[0]!;
    if (left.kind === "media") left.audioFadeOut = 0.1;
    expect(() => audioCrossfadeOps(timeline, media, joins, 0.08)).toThrow(/already has a fade/);
  });
});

describe("the editor's crossfade on dialogue joins", () => {
  /** A 12 s recording on A1 with 2–4 s and 7–8 s rippled out: joins at 2 s and 6 s. */
  function rippled(kind: "video" | "audio" = "audio") {
    const timeline = emptyTimeline("project");
    timeline.tracks.find(t => t.kind === kind)!.clips = [makeMediaClip("m", 0, 12, 0, { id: "raw" })];
    const ops = [{ op: "rippleDelete" as const, start: 7, end: 8 }, { op: "rippleDelete" as const, start: 2, end: 4 }];
    return { timeline: applyOps(timeline, ops), joins: rippleJoins(ops) };
  }

  it("finds where ripple removals leave joins", () => {
    expect(rippleJoins([{ op: "rippleDelete", start: 7, end: 8 }, { op: "rippleDelete", start: 2, end: 4 }])).toEqual([2, 5]);
    // A removal that takes out the footage between two joins leaves one join.
    expect(rippleJoins([{ op: "rippleDelete", start: 5, end: 6 }, { op: "rippleDelete", start: 4, end: 5 }])).toEqual([4]);
  });

  it.each(["audio", "video"] as const)("fades every join on %s from real handles, keeping sync and runtime", kind => {
    const { timeline, joins } = rippled(kind);
    const { timeline: faded, fades, report } = crossfadeJoins(timeline, media, joins, 0.08);
    expect(report).toEqual({ faded: [2, 5], plain: [] });
    expect(fades.map(f => f.at)).toEqual([2, 5]);
    expect(timelineDuration(faded)).toBeCloseTo(timelineDuration(timeline));
    const sound = kind === "audio" ? faded.tracks.find(t => t.kind === "audio")! : faded.tracks.at(-1)!;
    expect(sound.clips).toMatchObject([
      { timelineIn: 0, sourceIn: 0, sourceOut: 2.04, audioFadeIn: 0, audioFadeOut: 0.08 },
      { timelineIn: 1.96, sourceIn: 3.96, sourceOut: 7.04, audioFadeIn: 0.08, audioFadeOut: 0.08 },
      { timelineIn: 4.96, sourceIn: 7.96, sourceOut: 12, audioFadeIn: 0.08, audioFadeOut: 0 },
    ]);
    // The same fades replay onto the same cut exactly, as undoing an earlier edit does.
    expect(replayJoinFades(timeline, fades, 0.08)).toEqual(faded);
  });

  it.each(["audio", "video"] as const)("replays different recorded overlaps on both sides of one %s clip", kind => {
    const { timeline, track } = cut(kind);
    const { timeline: faded, fades } = crossfadeJoins(timeline, media, [1, 2], 0.04, { durations: new Map([[2, 0.12]]) });
    expect(fades).toEqual([{ trackId: track.id, at: 1 }, { trackId: track.id, at: 2, duration: 0.12 }]);
    const joined = faded.tracks.at(-1)!;
    expect(joined.clips[1]).toMatchObject({ audioFadeIn: 0.04, audioFadeOut: 0.12 });
    expect(replayJoinFades(timeline, fades, 0.04)).toEqual(faded);
  });

  it("leaves a join plain, and says why, when a clip lacks handles or already has a fade", () => {
    const timeline = emptyTimeline("project");
    timeline.tracks[1]!.clips = [
      makeMediaClip("m", 0, 2, 0, { id: "a" }),
      // Starts at the very start of its recording: nothing before it to fade in from.
      makeMediaClip("n", 0, 3, 2, { id: "b" }),
      makeMediaClip("m", 6, 8, 5, { id: "c", audioFadeIn: 0.1 }),
      makeMediaClip("m", 9, 12, 7, { id: "d" }),
    ];
    const both = [...media, { id: "n", kind: "audio" as const, name: "Mic", path: "mic", duration: 10, hasAudio: true }];
    const { timeline: faded, report } = crossfadeJoins(timeline, both, [2, 5, 7, 9.5], 0.08);
    expect(report.faded).toEqual([7]);
    expect(report.plain).toEqual([
      { at: 2, reason: "not enough recorded sound past the cut for the crossfade" },
      { at: 5, reason: "already has a fade" },
    ]);
    // 9.5 s is inside a clip: no join, nothing to report. The plain joins keep their clips as they were.
    expect(faded.tracks[1]!.clips.slice(0, 2)).toEqual(timeline.tracks[1]!.clips.slice(0, 2));
    expect(faded.tracks[1]!.clips[2]).toMatchObject({ sourceOut: 8.04, audioFadeIn: 0.1, audioFadeOut: 0.08 });
  });

  it("straightens a crossfade a later removal reaches, so that removal's join can take its own", () => {
    const { timeline, joins } = rippled();
    const faded = crossfadeJoins(timeline, media, joins, 0.08).timeline;
    expect(playedEdges(faded)).toEqual(expect.arrayContaining([2, 5]));
    expect(playedEdges(faded)).not.toContain(1.96);
    // A word right after the join at 2 s comes out too.
    const cut = applyOps(faded, [{ op: "rippleDelete", start: 2, end: 2.5 }]);
    const sound = cut.tracks.find(t => t.kind === "audio")!.clips;
    expect(sound.slice(0, 2)).toMatchObject([
      { timelineIn: 0, sourceIn: 0, sourceOut: 2, audioFadeOut: 0 },
      { timelineIn: 2, sourceIn: 4.5, audioFadeIn: 0 },
    ]);
    expect(sound).toHaveLength(3);
    const again = crossfadeJoins(cut, media, [2], 0.08);
    expect(again.report).toEqual({ faded: [2], plain: [] });
  });

  it("does nothing when the editor turned it off", () => {
    const { timeline, joins } = rippled();
    expect(crossfadeJoins(timeline, media, joins, 0).timeline).toBe(timeline);
  });
});
