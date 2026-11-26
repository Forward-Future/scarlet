import { describe, expect, it } from "vitest";
import { adjustEdit, editAdjustBounds } from "./adjustEdit.js";
import { applyOps } from "./ops.js";
import { splitJoinOps } from "./splitJoin.js";
import { clipEnd, timelineDuration } from "./time.js";
import { dipKeyframes } from "./volume.js";
import type { MediaAsset } from "./mediaSchema.js";
import type { CaptionClip, Clip, MediaClip, Timeline, Track } from "./timelineSchema.js";

const FPS = 30;

const mc = (id: string, mediaId: string, sourceIn: number, sourceOut: number, timelineIn: number, extra: Partial<MediaClip> = {}): MediaClip => ({
  id, kind: "media", mediaId, sourceIn, sourceOut, timelineIn,
  speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true,
  ...extra,
});
const cap = (id: string, timelineIn: number, timelineOut: number, text = "Hi"): CaptionClip => ({ id, kind: "caption", timelineIn, timelineOut, text, enabled: true });
const track = (id: string, kind: Track["kind"], clips: Clip[]): Track => ({ id, kind, name: id, muted: false, hidden: false, clips });

const assets: MediaAsset[] = [
  { id: "m_main", kind: "video", name: "main.mp4", path: "main.mp4", duration: 20, fps: 30, hasAudio: true },
  { id: "m_broll", kind: "video", name: "broll.mp4", path: "broll.mp4", duration: 10, fps: 30, hasAudio: true },
  { id: "m_music", kind: "audio", name: "music.wav", path: "music.wav", duration: 30, hasAudio: true },
];

const baseTimeline = (tracks: Track[]): Timeline => ({ version: "v1", parent: null, projectId: "p1", name: "Main", tracks, markers: [], background: "#000000" });
const zoomed = { transform: { x: 0, y: 0, scale: 1.25, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } };
const main = () => track("v1", "video", [mc("v_full", "m_main", 0, 20, 0)]);
const media = (tl: Timeline, trackIndex: number, clipIndex: number) => tl.tracks[trackIndex]!.clips[clipIndex] as MediaClip;

describe("which edits can be adjusted", () => {
  it("refuses a range shorter than half a frame and an edit nothing on the timeline matches", () => {
    const tl = baseTimeline([main(), track("c1", "caption", [cap("cap_1", 1, 3)])]);
    expect(editAdjustBounds(tl, { start: 1, end: 1.01 }, FPS, assets)).toBeUndefined();
    expect(editAdjustBounds(tl, { start: 2, end: 2 }, FPS, assets)).toBeUndefined();
    expect(editAdjustBounds(tl, { start: 9, end: 11 }, FPS, assets)).toBeUndefined();
    expect(adjustEdit(tl, { start: 9, end: 11 }, { start: 8, end: 11 }, FPS, assets)).toBeUndefined();
  });

  it("matches a caption with no kind given, and no roll for a kind that can't roll", () => {
    const tl = baseTimeline([main(), track("c1", "caption", [cap("cap_1", 1, 3)])]);
    expect(editAdjustBounds(tl, { start: 1, end: 3 }, FPS)?.mode).toBe("overlay");
    const rolled = baseTimeline([track("v1", "video", [mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, zoomed), mc("c3", "m_main", 8, 20, 8)])]);
    expect(editAdjustBounds(rolled, { start: 5, end: 8 }, FPS, assets, { kind: "text" })).toBeUndefined();
    expect(editAdjustBounds(rolled, { start: 5, end: 8 }, FPS, assets)?.mode).toBe("roll");
  });

  it("finds no split or dip where the timeline has none", () => {
    const tl = baseTimeline([main(), track("a1", "audio", [mc("a_full", "m_main", 0, 20, 0)])]);
    expect(editAdjustBounds(tl, { start: 4, end: 5 }, FPS, assets, { kind: "split" })).toBeUndefined();
    expect(editAdjustBounds(tl, { start: 4, end: 5 }, FPS, assets, { kind: "dip" })).toBeUndefined();
  });
});

describe("adjustEdit's guards", () => {
  const tl = baseTimeline([main(), track("c1", "caption", [cap("cap_1", 1, 3), cap("cap_2", 5, 7)])]);
  const range = { start: 1, end: 3 };

  it("refuses edges dragged past their bounds", () => {
    expect(adjustEdit(tl, range, { start: -0.5, end: 3 }, FPS, assets, { kind: "text" })).toBeUndefined();
    expect(adjustEdit(tl, range, { start: 3.5, end: 3.5 }, FPS, assets, { kind: "text" })).toBeUndefined();
    expect(adjustEdit(tl, range, { start: 1, end: 0.5 }, FPS, assets, { kind: "text" })).toBeUndefined();
    expect(adjustEdit(tl, range, { start: 1, end: 5.5 }, FPS, assets, { kind: "text" })).toBeUndefined();
  });

  it("refuses an end dragged before the start", () => {
    expect(adjustEdit(tl, range, { start: 2.5, end: 1.5 }, FPS, assets, { kind: "text" })).toBeUndefined();
  });

  it("does nothing for a drag of less than half a frame", () => {
    expect(adjustEdit(tl, range, { start: 1.01, end: 2.99 }, FPS, assets, { kind: "text" })).toBeUndefined();
  });
});

describe("overlays", () => {
  it("moves a clip's keyframes with its start and shortens its fades to fit", () => {
    const overlay = mc("ov", "m_broll", 2, 6, 4, {
      videoFadeIn: 1.5, videoFadeOut: 1.5, audioFadeIn: 1, audioFadeOut: 2,
      keyframes: [{ time: 1, transform: { scale: 1.1 }, ease: "linear" }],
      volumeKeyframes: [{ time: 2, db: -6, ease: "linear" }],
    });
    const tl = baseTimeline([main(), track("v2", "video", [overlay])]);
    const result = adjustEdit(tl, { start: 4, end: 8 }, { start: 5, end: 7 }, FPS, assets, { kind: "broll" })!;
    const clip = media(result.timeline, 1, 0);
    expect([clip.timelineIn, clip.sourceIn, clip.sourceOut]).toEqual([5, 3, 5]);
    expect(clip.keyframes![0]!.time).toBeCloseTo(0, 9);
    expect(clip.volumeKeyframes![0]!.time).toBeCloseTo(1, 9);
    expect(clip.videoFadeIn + clip.videoFadeOut).toBeLessThan(2);
    expect(clip.videoFadeIn).toBeCloseTo(clip.videoFadeOut, 9);
    expect(clip.audioFadeIn + clip.audioFadeOut).toBeLessThan(2);
    expect(clip.audioFadeOut).toBeCloseTo(2 * clip.audioFadeIn, 9);
  });

  it("keeps keyframes where they are when only the end moves", () => {
    const overlay = mc("ov", "m_broll", 2, 6, 4, { keyframes: [{ time: 1, transform: { scale: 1.1 }, ease: "linear" }] });
    const tl = baseTimeline([main(), track("v2", "video", [overlay])]);
    const result = adjustEdit(tl, { start: 4, end: 8 }, { start: 4, end: 9 }, FPS, assets, { kind: "graphic" })!;
    expect(media(result.timeline, 1, 0).keyframes).toEqual(overlay.keyframes);
    expect(media(result.timeline, 1, 0).sourceOut).toBe(7);
  });

  it("moves a B-roll's own sound with its picture", () => {
    const tl = baseTimeline([
      main(),
      track("v2", "video", [mc("b_pic", "m_broll", 2, 6, 4)]),
      track("a2", "audio", [mc("b_snd", "m_broll", 2, 6, 4)]),
      track("a3", "audio", [mc("music", "m_music", 0, 4, 4)]),
    ]);
    const result = adjustEdit(tl, { start: 4, end: 8 }, { start: 4, end: 9 }, FPS, assets, { kind: "broll" })!;
    expect(result.ops.map(op => op.op === "updateClip" && op.clipId)).toEqual(["b_pic", "b_snd"]);
    expect(media(result.timeline, 2, 0).sourceOut).toBe(7);
    expect(media(result.timeline, 3, 0).sourceOut).toBe(4);
  });

  it("adjusts any matching clip when a B-roll has no picture at that range", () => {
    const tl = baseTimeline([main(), track("a2", "audio", [mc("music", "m_music", 0, 4, 4)])]);
    const bounds = editAdjustBounds(tl, { start: 4, end: 8 }, FPS, assets, { kind: "broll" })!;
    expect(bounds).toMatchObject({ mode: "overlay", minStart: 4, maxEnd: 20 });
  });

  it("adjusts added audio on its own track for an audio edit", () => {
    const tl = baseTimeline([
      main(),
      track("v2", "video", [mc("b_pic", "m_broll", 0, 4, 4)]),
      track("a2", "audio", [mc("music", "m_music", 10, 14, 4)]),
    ]);
    const result = adjustEdit(tl, { start: 4, end: 8 }, { start: 2, end: 8 }, FPS, assets, { kind: "audio" })!;
    expect(result.ops).toEqual([expect.objectContaining({ clipId: "music" })]);
    expect([media(result.timeline, 2, 0).timelineIn, media(result.timeline, 2, 0).sourceIn]).toEqual([2, 8]);
  });

  it("falls back to every match when a text edit finds no caption, or the change's clips aren't among them", () => {
    const tl = baseTimeline([main(), track("v2", "video", [mc("b_pic", "m_broll", 2, 6, 4)])]);
    expect(editAdjustBounds(tl, { start: 4, end: 8 }, FPS, assets, { kind: "text" })?.mode).toBe("overlay");
    expect(editAdjustBounds(tl, { start: 4, end: 8 }, FPS, assets, { kind: "broll", clipIds: ["elsewhere"] })?.mode).toBe("overlay");
  });

  it("lets a clip with no known source length grow only at its start", () => {
    const tl = baseTimeline([main(), track("v2", "video", [mc("b_pic", "m_unknown", 2, 6, 4)])]);
    expect(editAdjustBounds(tl, { start: 4, end: 8 }, FPS)).toMatchObject({ minStart: 2, maxEnd: 8 });
  });

  it("doesn't take a run across a gap, past the range, or into a split edit", () => {
    const gap = baseTimeline([main(), track("v2", "video", [mc("a", "m_broll", 0, 2, 4), mc("b", "m_broll", 3, 5, 7)])]);
    expect(editAdjustBounds(gap, { start: 4, end: 9 }, FPS, assets)).toBeUndefined();
    const past = baseTimeline([main(), track("v2", "video", [mc("a", "m_broll", 0, 4, 4)])]);
    expect(editAdjustBounds(past, { start: 4, end: 6 }, FPS, assets)).toBeUndefined();
    const split = baseTimeline([main(), track("a2", "audio", [
      mc("a", "m_broll", 0, 2, 4),
      mc("b", "m_broll", 2, 4, 6, { splitEdit: { leads: 0.5 } }),
    ])]);
    expect(editAdjustBounds(split, { start: 4, end: 8 }, FPS, assets, { kind: "audio" })).toBeUndefined();
    const splitFirst = baseTimeline([main(), track("a2", "audio", [mc("b", "m_broll", 2, 4, 4, { splitEdit: { trails: 0.5 } })])]);
    expect(editAdjustBounds(splitFirst, { start: 4, end: 6 }, FPS, assets, { kind: "audio" })).toBeUndefined();
  });

  it("won't remove a run of several clips by pulling its edges together", () => {
    const tl = baseTimeline([main(), track("v2", "video", [mc("a", "m_broll", 2, 4, 4), mc("b", "m_broll", 5, 8, 6)])]);
    expect(editAdjustBounds(tl, { start: 4, end: 9 }, FPS, assets)?.canRemove).toBe(false);
    expect(adjustEdit(tl, { start: 4, end: 9 }, { start: 5.9, end: 5.9 }, FPS, assets)).toBeUndefined();
  });

  it("removes every clip of a single-clip match on several tracks", () => {
    const tl = baseTimeline([
      main(),
      track("v2", "video", [mc("b_pic", "m_broll", 2, 6, 4)]),
      track("a2", "audio", [mc("b_snd", "m_broll", 2, 6, 4)]),
    ]);
    const result = adjustEdit(tl, { start: 4, end: 8 }, { start: 6, end: 6 }, FPS, assets, { kind: "broll" })!;
    expect(result).toMatchObject({ removed: true, range: { start: 6, end: 6 } });
    expect(result.timeline.tracks.slice(1).map(t => t.clips.length)).toEqual([0, 0]);
  });
});

describe("rolls", () => {
  const roll = (clips: MediaClip[]) => baseTimeline([track("v1", "video", clips)]);

  it("rolls the start against the clip before when the one after isn't the same recording", () => {
    const tl = roll([mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, zoomed), mc("c3", "m_broll", 0, 10, 8)]);
    const bounds = editAdjustBounds(tl, { start: 5, end: 8 }, FPS, assets, { kind: "zoom" })!;
    expect(bounds).toMatchObject({ mode: "roll", maxStart: 8, minEnd: 8, maxEnd: 8, canRemove: true });
    const result = adjustEdit(tl, { start: 5, end: 8 }, { start: 6, end: 8 }, FPS, assets, { kind: "zoom" })!;
    expect(result.timeline.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut])).toEqual([[0, 0, 6], [6, 6, 8], [8, 0, 10]]);
  });

  it("gives the zoomed footage back to the clip before when pulled to zero", () => {
    const tl = roll([mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, zoomed), mc("c3", "m_broll", 0, 10, 8)]);
    const result = adjustEdit(tl, { start: 5, end: 8 }, { start: 8, end: 8 }, FPS, assets, { kind: "zoom" })!;
    expect(result.removed).toBe(true);
    expect(result.timeline.tracks[0]!.clips.map(c => c.id)).toEqual(["c1", "c3"]);
    expect(media(result.timeline, 0, 0).sourceOut).toBe(8);
  });

  it("gives the zoomed footage to the clip after, keyframes and all, when there is none before", () => {
    const tl = roll([
      mc("c2", "m_main", 0, 3, 0, zoomed),
      mc("c3", "m_main", 3, 20, 3, { keyframes: [{ time: 1, transform: { scale: 1.1 }, ease: "linear" }], volumeKeyframes: [{ time: 2, db: -3, ease: "linear" }] }),
    ]);
    const bounds = editAdjustBounds(tl, { start: 0, end: 3 }, FPS, assets, { kind: "reframe" })!;
    expect(bounds).toMatchObject({ minStart: 0, maxStart: 0, minEnd: 0 });
    const result = adjustEdit(tl, { start: 0, end: 3 }, { start: 0, end: 0 }, FPS, assets, { kind: "reframe" })!;
    expect(result.removed).toBe(true);
    const next = media(result.timeline, 0, 0);
    expect([next.id, next.timelineIn, next.sourceIn, next.sourceOut]).toEqual(["c3", 0, 0, 20]);
    expect(next.keyframes![0]!.time).toBe(4);
    expect(next.volumeKeyframes![0]!.time).toBe(5);
  });

  it("keeps the clip after on its frames when its sound level keys move with a roll", () => {
    const tl = roll([
      mc("c1", "m_main", 0, 5, 0),
      mc("c2", "m_main", 5, 8, 5, zoomed),
      mc("c3", "m_main", 8, 20, 8, { volumeKeyframes: [{ time: 3, db: -3, ease: "linear" }] }),
    ]);
    const result = adjustEdit(tl, { start: 5, end: 8 }, { start: 5, end: 10 }, FPS, assets, { kind: "zoom" })!;
    expect(media(result.timeline, 0, 2).volumeKeyframes![0]!.time).toBeCloseTo(1, 9);
  });

  it("keeps a zoom's ramp keys at its edges as it rolls, and its fades inside it", () => {
    const ramp = [{ time: 0, transform: { scale: 1 }, ease: "linear" as const }, { time: 0.5, transform: { scale: 1.25 }, ease: "linear" as const },
      { time: 2.5, transform: { scale: 1.25 }, ease: "linear" as const }, { time: 3, transform: { scale: 1 }, ease: "linear" as const }];
    const tl = roll([
      mc("c1", "m_main", 0, 5, 0),
      mc("c2", "m_main", 5, 8, 5, { ...zoomed, keyframes: ramp, videoFadeIn: 1, videoFadeOut: 1 }),
      mc("c3", "m_main", 8, 20, 8),
    ]);
    const later = adjustEdit(tl, { start: 5, end: 8 }, { start: 6.5, end: 8 }, FPS, assets, { kind: "zoom" })!;
    const zoom = media(later.timeline, 0, 1);
    expect(zoom.timelineIn).toBe(6.5);
    expect(zoom.keyframes!.map(k => k.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(zoom.videoFadeIn + zoom.videoFadeOut).toBeLessThan(1.5);
    const longer = adjustEdit(tl, { start: 5, end: 8 }, { start: 5, end: 9 }, FPS, assets, { kind: "zoom" })!;
    expect(media(longer.timeline, 0, 1).keyframes!.map(k => k.time)).toEqual([0, 0.5, 3.5, 4]);
  });

  it("rolls both edges of a single clip at once", () => {
    const tl = roll([mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, zoomed), mc("c3", "m_main", 8, 20, 8)]);
    const result = adjustEdit(tl, { start: 5, end: 8 }, { start: 6, end: 7 }, FPS, assets, { kind: "zoom" })!;
    expect(result.timeline.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut])).toEqual([[0, 0, 6], [6, 6, 7], [7, 7, 20]]);
    expect(timelineDuration(result.timeline)).toBe(20);
  });

  it("rolls the outer edges of a run of several clips and keeps a frame of each", () => {
    const tilted = { transform: { ...zoomed.transform, rotation: 2 } };
    const tl = roll([
      mc("c1", "m_main", 0, 5, 0),
      mc("c2", "m_main", 5, 6.5, 5, zoomed),
      mc("c3", "m_main", 6.5, 8, 6.5, tilted),
      mc("c4", "m_main", 8, 20, 8),
    ]);
    const bounds = editAdjustBounds(tl, { start: 5, end: 8 }, FPS, assets, { kind: "zoom" })!;
    expect(bounds.canRemove).toBe(false);
    expect(bounds.maxStart).toBeCloseTo(6.5 - 1 / FPS, 9);
    expect(bounds.minEnd).toBeCloseTo(6.5 + 1 / FPS, 9);
    const result = adjustEdit(tl, { start: 5, end: 8 }, { start: 4, end: 9 }, FPS, assets, { kind: "zoom" })!;
    expect(result.timeline.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
      .toEqual([[0, 0, 4], [4, 4, 6.5], [6.5, 6.5, 9], [9, 9, 20]]);
    // A run can be narrowed to a sliver of each clip.
    expect(adjustEdit(tl, { start: 5, end: 8 }, { start: 6.45, end: 6.55 }, FPS, assets, { kind: "zoom" })).toBeDefined();
  });

  it("refuses to roll a single clip down to under a frame", () => {
    const tl = roll([mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, zoomed), mc("c3", "m_broll", 0, 10, 8)]);
    expect(adjustEdit(tl, { start: 5, end: 8 }, { start: 8 - 0.025, end: 8 }, FPS, assets, { kind: "zoom" })).toBeUndefined();
    const after = roll([mc("c0", "m_broll", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, zoomed), mc("c3", "m_main", 8, 20, 8)]);
    expect(adjustEdit(after, { start: 5, end: 8 }, { start: 5, end: 5.025 }, FPS, assets, { kind: "zoom" })).toBeUndefined();
  });

  it("won't roll a clip with tracked motion, sound level keys or no continuous neighbour", () => {
    const tracked = [0.2, 1, 1.5, 2, 2.8].map(time => ({ time, transform: { x: time }, ease: "linear" as const }));
    const cases: MediaClip[][] = [
      [mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, { keyframes: tracked }), mc("c3", "m_main", 8, 20, 8)],
      [mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 11, 5, { keyframes: [{ time: 3, transform: { x: 1 }, ease: "linear" }] }), mc("c3", "m_main", 11, 20, 11)],
      [mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, { volumeKeyframes: [{ time: 1, db: -3, ease: "linear" }] }), mc("c3", "m_main", 8, 20, 8)],
      // Same look on both sides: nothing to roll.
      [mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5), mc("c3", "m_main", 8, 20, 8)],
      // Not continuous footage either side.
      [mc("c1", "m_main", 0, 4, 0), mc("c2", "m_main", 5, 8, 4, zoomed), mc("c3", "m_main", 9, 20, 7)],
    ];
    for (const clips of cases) {
      const end = clipEnd(clips[1]!);
      expect(editAdjustBounds(roll(clips), { start: clips[1]!.timelineIn, end }, FPS, assets, { kind: "zoom" })).toBeUndefined();
    }
  });

  it("doesn't roll a run across a gap, past the range, or into a still", () => {
    const gap = roll([mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 6, 5, zoomed), mc("c3", "m_main", 6, 8, 6.5), mc("c4", "m_main", 8, 20, 8.5)]);
    expect(editAdjustBounds(gap, { start: 5, end: 8.5 }, FPS, assets, { kind: "zoom" })).toBeUndefined();
    const past = roll([mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 10, 5, zoomed)]);
    expect(editAdjustBounds(past, { start: 5, end: 8 }, FPS, assets, { kind: "zoom" })).toBeUndefined();
    const still = baseTimeline([track("v1", "video", [mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 7, 5, zoomed),
      { id: "black", kind: "color", color: "#000000", timelineIn: 7, timelineOut: 8, enabled: true } as Clip])]);
    expect(editAdjustBounds(still, { start: 5, end: 8 }, FPS, assets, { kind: "zoom" })).toBeUndefined();
  });

  it("rolls only the clips the change made when it names them", () => {
    const tl = roll([mc("c1", "m_main", 0, 5, 0), mc("c2", "m_main", 5, 8, 5, zoomed), mc("c3", "m_main", 8, 20, 8)]);
    expect(editAdjustBounds(tl, { start: 5, end: 8 }, FPS, assets, { kind: "zoom", clipIds: ["c2"] })?.mode).toBe("roll");
    expect(editAdjustBounds(tl, { start: 5, end: 8 }, FPS, assets, { kind: "zoom", clipIds: ["other"] })).toBeUndefined();
  });

  it("rolls a voice edit on an audio track", () => {
    const tl = baseTimeline([
      track("v1", "video", [mc("v_full", "m_broll", 0, 10, 0)]),
      track("a1", "audio", [mc("a1", "m_main", 0, 4, 0), mc("a2", "m_main", 4, 6, 4, { volume: 1.5 }), mc("a3", "m_main", 6, 20, 6)]),
    ]);
    const result = adjustEdit(tl, { start: 4, end: 6 }, { start: 3, end: 6 }, FPS, assets, { kind: "voice" })!;
    expect(result.ops.map(op => op.op === "updateClip" && op.clipId)).toEqual(["a1", "a2"]);
    expect(media(result.timeline, 1, 1).timelineIn).toBe(3);
  });
});

describe("dips", () => {
  const music = mc("mus", "m_music", 0, 20, 0, { volume: 0.4 });
  const shape = { depth: -12, down: 0.5, up: 0.5 };
  const twoDips = (clipIds?: string[]) => {
    const { keys } = dipKeyframes(music, [{ start: 4, end: 8 }, { start: 12, end: 15 }], shape);
    return { tl: baseTimeline([main(), track("a1", "audio", [{ ...music, volumeKeyframes: keys }])]), clipIds };
  };

  it("bounds a dip by the dips either side of it", () => {
    const { tl } = twoDips();
    const first = editAdjustBounds(tl, { start: 4, end: 8 }, FPS, assets)!;
    expect(first.mode).toBe("dip");
    expect(first.maxEnd).toBeCloseTo(11, 9);
    const second = editAdjustBounds(tl, { start: 12, end: 15 }, FPS, assets, { kind: "dip" })!;
    expect(second.minStart).toBeCloseTo(9, 9);
    expect(second.maxEnd).toBeCloseTo(19.5, 9);
  });

  it("moves the dip named by its outer edges and leaves the other dip alone", () => {
    const { tl } = twoDips();
    const result = adjustEdit(tl, { start: 11.5, end: 15.5 }, { start: 10.5, end: 16.5 }, FPS, assets, { kind: "dip" })!;
    const times = media(result.timeline, 1, 0).volumeKeyframes!.map(k => k.time);
    expect(times.slice(0, 4)).toEqual([3.5, 4, 8, 8.5]);
    expect(times.slice(4)).toEqual([10.5, 11, 16, 16.5]);
  });

  it("removes one of two dips and keeps the other", () => {
    const { tl } = twoDips();
    const result = adjustEdit(tl, { start: 12, end: 15 }, { start: 13, end: 13 }, FPS, assets, { kind: "dip" })!;
    expect(result.removed).toBe(true);
    expect(media(result.timeline, 1, 0).volumeKeyframes!.map(k => k.time)).toEqual([3.5, 4, 8, 8.5]);
  });

  it("prefers the clip the change made when two dips match", () => {
    const { keys } = dipKeyframes(music, [{ start: 4, end: 8 }], shape);
    const tl = baseTimeline([
      main(),
      track("a1", "audio", [{ ...music, volumeKeyframes: keys }]),
      track("a2", "audio", [{ ...music, id: "mus2", volumeKeyframes: keys }]),
      track("a3", "audio", [{ ...music, id: "far", timelineIn: 40, volumeKeyframes: keys }]),
    ]);
    const result = adjustEdit(tl, { start: 4, end: 8 }, { start: 3, end: 8 }, FPS, assets, { kind: "dip", clipIds: ["mus2"] })!;
    expect(result.ops).toEqual([expect.objectContaining({ clipId: "mus2" })]);
  });

  it("skips level keys that aren't a dip", () => {
    const keys = [0, 1, 2, 3].map(time => ({ time: time + 4, db: -1, ease: "linear" as const }));
    const tl = baseTimeline([main(), track("a1", "audio", [{ ...music, volumeKeyframes: keys }])]);
    expect(editAdjustBounds(tl, { start: 5, end: 6 }, FPS, assets, { kind: "dip" })).toBeUndefined();
  });
});

describe("split edits", () => {
  const raw = () => baseTimeline([track("v1", "video", [mc("shot1", "m_main", 0, 5, 0), mc("shot2", "m_main", 8, 16, 5)])]);
  const lCut = () => applyOps(raw(), splitJoinOps(raw(), assets, FPS, [{ at: 5, shift: 0.5 }]).ops);
  const jCut = () => applyOps(raw(), splitJoinOps(raw(), assets, FPS, [{ at: 5, shift: -0.5 }]).ops);

  it("finds an L cut's trailing sound with no kind given and drags its free edge", () => {
    const tl = lCut();
    const bounds = editAdjustBounds(tl, { start: 5, end: 5.5 }, FPS, assets)!;
    expect(bounds).toMatchObject({ mode: "split", splitSide: "l", minStart: 5, maxStart: 5, minEnd: 5 });
    expect(bounds.maxEnd).toBeGreaterThan(5.5);
    const longer = adjustEdit(tl, { start: 5, end: 5.5 }, { start: 5, end: 6.5 }, FPS, assets, { kind: "split" })!;
    expect(longer.range).toEqual({ start: 5, end: 6.5 });
    const sound = longer.timeline.tracks.find(t => t.kind === "audio")!;
    expect(clipEnd(sound.clips[0]!)).toBeCloseTo(6.5, 5);
  });

  it("puts the sound cut back with the picture cut when an L cut is pulled to zero", () => {
    const result = adjustEdit(lCut(), { start: 5, end: 5.5 }, { start: 5, end: 5 }, FPS, assets, { kind: "split" })!;
    expect(result).toMatchObject({ removed: true, range: { start: 5, end: 5 } });
    const sound = result.timeline.tracks.find(t => t.kind === "audio")!;
    expect(clipEnd(sound.clips[0]!)).toBeCloseTo(5, 5);
  });

  it("puts a J cut's sound back with the picture when pulled to zero, with no kind given", () => {
    const tl = jCut();
    expect(editAdjustBounds(tl, { start: 4.5, end: 5 }, FPS, assets)?.splitSide).toBe("j");
    const result = adjustEdit(tl, { start: 4.5, end: 5 }, { start: 5, end: 5 }, FPS, assets)!;
    expect(result.removed).toBe(true);
    expect(result.timeline.tracks.find(t => t.kind === "audio")!.clips[1]!.timelineIn).toBeCloseTo(5, 5);
  });

  it("lets an L cut run no further than the sound's own recording when its length is known", () => {
    const short: MediaAsset[] = [{ ...assets[0]!, duration: 5.6 }];
    const tl = lCut();
    expect(editAdjustBounds(tl, { start: 5, end: 5.5 }, FPS, short, { kind: "split" })!.maxEnd).toBeCloseTo(5.6, 5);
    expect(editAdjustBounds(tl, { start: 5, end: 5.5 }, FPS, undefined, { kind: "split" })!.maxEnd).toBeCloseTo(5.5, 5);
  });

  it("finds no split edit whose sound meets nothing on the other side", () => {
    const lone = baseTimeline([main(), track("a1", "audio", [mc("a", "m_main", 0, 5, 3, { splitEdit: { leads: 0.5 } }), mc("b", "m_main", 6, 9, 9, { splitEdit: { trails: 0.5 } })])]);
    expect(editAdjustBounds(lone, { start: 3, end: 3.5 }, FPS, assets, { kind: "split" })).toBeUndefined();
    expect(editAdjustBounds(lone, { start: 11.5, end: 12 }, FPS, assets, { kind: "split" })).toBeUndefined();
  });
});
