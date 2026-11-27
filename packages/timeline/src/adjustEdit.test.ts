import { describe, expect, it } from "vitest";
import { adjustEdit, editAdjustBounds } from "./adjustEdit.js";
import { clipEnd, timelineDuration } from "./time.js";
import { splitJoinOps } from "./splitJoin.js";
import { applyOps } from "./ops.js";
import { dipKeyframes } from "./volume.js";
import type { MediaAsset } from "./mediaSchema.js";
import type { CaptionClip, MediaClip, Timeline } from "./timelineSchema.js";

const FPS = 30;

const mc = (id: string, mediaId: string, sourceIn: number, sourceOut: number, timelineIn: number, extra: Partial<MediaClip> = {}): MediaClip => ({
  id, kind: "media", mediaId, sourceIn, sourceOut, timelineIn,
  speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0, effects: [], enabled: true,
  ...extra,
});

const cap = (id: string, timelineIn: number, timelineOut: number, text: string): CaptionClip => ({
  id, kind: "caption", timelineIn, timelineOut, text, enabled: true,
});

const assets: MediaAsset[] = [
  { id: "m_main", kind: "video", name: "main.mp4", path: "main.mp4", duration: 20, fps: 30, hasAudio: true },
  { id: "m_broll", kind: "video", name: "broll.mp4", path: "broll.mp4", duration: 10, fps: 30, hasAudio: false },
  { id: "m_logo", kind: "image", name: "logo.png", path: "logo.png", width: 512, height: 512, hasAlpha: true },
  { id: "m_music", kind: "audio", name: "music.wav", path: "music.wav", duration: 30, hasAudio: true },
];

const baseTimeline = (tracks: Timeline["tracks"]): Timeline => ({
  version: "v1", parent: null, projectId: "p1", name: "Main", tracks, markers: [], background: "#000000",
});

describe("editAdjustBounds and adjustEdit", () => {
  it("adjusts a caption clip's start and end edges without crossing neighbors, and removes when pulled to zero", () => {
    const tl = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [mc("v_full", "m_main", 0, 20, 0)] },
      { id: "c1", kind: "caption", name: "Captions", muted: false, hidden: false, clips: [cap("cap_1", 1, 3, "Hello"), cap("cap_2", 5, 7, "World")] },
    ]);
    const bounds = editAdjustBounds(tl, { start: 1, end: 3 }, FPS, assets, { kind: "text" });
    expect(bounds).toEqual({ mode: "overlay", minStart: 0, maxStart: 3, minEnd: 1, maxEnd: 5, canRemove: true });

    const extended = adjustEdit(tl, { start: 1, end: 3 }, { start: 0.5, end: 4.2 }, FPS, assets, { kind: "text" });
    expect(extended?.range).toEqual({ start: 0.5, end: 4.2 });
    const updated = extended!.timeline.tracks[1]!.clips[0] as CaptionClip;
    expect([updated.timelineIn, updated.timelineOut]).toEqual([0.5, 4.2]);

    const removed = adjustEdit(tl, { start: 1, end: 3 }, { start: 3, end: 3 }, FPS, assets, { kind: "text" });
    expect(removed?.removed).toBe(true);
    expect(removed!.timeline.tracks[1]!.clips.map(c => c.id)).toEqual(["cap_2"]);
  });

  it("respects video source duration bounds for B-roll overlays and allows arbitrary extension for still image overlays", () => {
    const tl = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [mc("v_full", "m_main", 0, 20, 0)] },
      { id: "v2", kind: "video", name: "V2", muted: false, hidden: false, clips: [
        mc("broll", "m_broll", 2, 6, 4), // 2s available before, 4s available after
        mc("logo", "m_logo", 0, 2, 12), // still image
      ] },
    ]);
    const brollBounds = editAdjustBounds(tl, { start: 4, end: 8 }, FPS, assets, { kind: "broll" });
    expect(brollBounds).toEqual({ mode: "overlay", minStart: 2, maxStart: 8, minEnd: 4, maxEnd: 12, canRemove: true });

    const trimmed = adjustEdit(tl, { start: 4, end: 8 }, { start: 3, end: 10 }, FPS, assets, { kind: "broll" });
    const b = trimmed!.timeline.tracks[1]!.clips[0] as MediaClip;
    expect([b.timelineIn, b.sourceIn, b.sourceOut]).toEqual([3, 1, 8]);

    const logoBounds = editAdjustBounds(tl, { start: 12, end: 14 }, FPS, assets, { kind: "overlay" });
    expect(logoBounds).toEqual({ mode: "overlay", minStart: 8, maxStart: 14, minEnd: 12, maxEnd: 20, canRemove: true });
    const stretched = adjustEdit(tl, { start: 12, end: 14 }, { start: 10, end: 18 }, FPS, assets, { kind: "overlay" });
    const l = stretched!.timeline.tracks[1]!.clips[1] as MediaClip;
    expect([l.timelineIn, l.sourceIn, l.sourceOut]).toEqual([10, 0, 8]);
  });

  it("rolls a split zoom/reframe clip cleanly against adjacent continuous main-track clips without changing duration", () => {
    const tl = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [
        mc("c1", "m_main", 0, 5, 0),
        mc("c2", "m_main", 5, 8, 5, { transform: { x: 0, y: 0, scale: 1.25, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } }),
        mc("c3", "m_main", 8, 20, 8),
      ] },
    ]);
    const bounds = editAdjustBounds(tl, { start: 5, end: 8 }, FPS, assets, { kind: "zoom" });
    expect(bounds?.mode).toBe("roll");
    expect(bounds!.minStart).toBeCloseTo(1 / FPS, 5);
    expect(bounds!.maxEnd).toBeCloseTo(20 - 1 / FPS, 5);

    const rolled = adjustEdit(tl, { start: 5, end: 8 }, { start: 4, end: 9.5 }, FPS, assets, { kind: "zoom" });
    expect(timelineDuration(rolled!.timeline)).toBeCloseTo(20, 5);
    const [a, b, c] = rolled!.timeline.tracks[0]!.clips as MediaClip[];
    expect([a!.sourceOut, b!.timelineIn, b!.sourceIn, b!.sourceOut, c!.timelineIn, c!.sourceIn]).toEqual([4, 4, 4, 9.5, 9.5, 9.5]);

    // Pulling zoom to zero merges c1 + c2 + c3 back into one continuous clip.
    const gone = adjustEdit(tl, { start: 5, end: 8 }, { start: 5, end: 5 }, FPS, assets, { kind: "zoom" });
    expect(gone?.removed).toBe(true);
    expect(gone!.timeline.tracks[0]!.clips).toHaveLength(1);
    expect((gone!.timeline.tracks[0]!.clips[0] as MediaClip).sourceOut).toBe(20);

    // Rolling when the next clip holds keyframes shifts those keyframes so they stay pinned to the same frames.
    const tlWithNextKf = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [
        mc("c1", "m_main", 0, 5, 0),
        mc("c2", "m_main", 5, 8, 5, { transform: { x: 0, y: 0, scale: 1.25, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 } }),
        mc("c3", "m_main", 8, 20, 8, { keyframes: [{ time: 2, transform: { scale: 1.1 }, ease: "linear" }] }),
      ] },
    ]);
    const rolledKf = adjustEdit(tlWithNextKf, { start: 5, end: 8 }, { start: 5, end: 9 }, FPS, assets, { kind: "zoom" });
    const nextAfterRoll = rolledKf!.timeline.tracks[0]!.clips[2] as MediaClip;
    expect(nextAfterRoll.timelineIn).toBe(9);
    expect(nextAfterRoll.keyframes?.[0]?.time).toBeCloseTo(1, 5);
  });

  it("adjusts a music dip's volume keyframes cleanly and removes the dip when pulled to zero", () => {
    const music = mc("mus", "m_music", 0, 20, 0, { volume: 0.4 });
    const { keys } = dipKeyframes(music, [{ start: 4, end: 8 }], { depth: -12, down: 0.5, up: 0.5 });
    const tl = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [mc("v_full", "m_main", 0, 20, 0)] },
      { id: "a1", kind: "audio", name: "A1", muted: false, hidden: false, clips: [{ ...music, volumeKeyframes: keys }] },
    ]);
    const bounds = editAdjustBounds(tl, { start: 4, end: 8 }, FPS, assets, { kind: "dip" });
    expect(bounds?.mode).toBe("dip");
    expect(bounds!.minStart).toBeCloseTo(0.5, 5);
    expect(bounds!.maxEnd).toBeCloseTo(19.5, 5);

    const moved = adjustEdit(tl, { start: 4, end: 8 }, { start: 3, end: 10 }, FPS, assets, { kind: "dip" });
    const nextKeys = (moved!.timeline.tracks[1]!.clips[0] as MediaClip).volumeKeyframes!;
    expect(nextKeys.map(k => k.time)).toEqual([2.5, 3, 10, 10.5]);

    // Narrowing an outer-matched dip tightly keeps all 4 keyframes strictly non-decreasing within clip bounds.
    const narrowOuter = adjustEdit(tl, { start: 3.5, end: 8.5 }, { start: 8.2, end: 8.5 }, FPS, assets, { kind: "dip" });
    const tightKeys = (narrowOuter!.timeline.tracks[1]!.clips[0] as MediaClip).volumeKeyframes!.map(k => k.time);
    expect(tightKeys[0]!).toBeLessThanOrEqual(tightKeys[1]!);
    expect(tightKeys[1]!).toBeLessThanOrEqual(tightKeys[2]!);
    expect(tightKeys[2]!).toBeLessThanOrEqual(tightKeys[3]!);

    const cleared = adjustEdit(tl, { start: 4, end: 8 }, { start: 6, end: 6 }, FPS, assets, { kind: "dip" });
    expect(cleared?.removed).toBe(true);
    expect((cleared!.timeline.tracks[1]!.clips[0] as MediaClip).volumeKeyframes).toEqual([]);
  });

  it("adjusts a J/L split edit's free audio edge while keeping the picture cut pinned", () => {
    const raw = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [
        mc("shot1", "m_main", 0, 5, 0),
        mc("shot2", "m_main", 8, 16, 5),
      ] },
    ]);
    const { ops } = splitJoinOps(raw, assets, FPS, [{ at: 5, shift: -0.5 }]);
    const tl = applyOps(raw, ops);
    const bounds = editAdjustBounds(tl, { start: 4.5, end: 5 }, FPS, assets, { kind: "split" });
    expect(bounds?.mode).toBe("split");
    expect(bounds?.splitSide).toBe("j");
    expect(bounds!.minEnd).toBe(5);
    expect(bounds!.maxEnd).toBe(5);
    expect(bounds!.minStart).toBeLessThan(4.5);

    const deeper = adjustEdit(tl, { start: 4.5, end: 5 }, { start: 3.5, end: 5 }, FPS, assets, { kind: "split" });
    expect(deeper?.range).toEqual({ start: 3.5, end: 5 });
    const dialogue = deeper!.timeline.tracks.find(t => t.kind === "audio")!;
    expect(clipEnd(dialogue.clips[0]!)).toBeCloseTo(3.5, 5);
    expect(dialogue.clips[1]!.timelineIn).toBeCloseTo(3.5, 5);
  });

  it("adjusts multi-clip overlay and B-roll runs split across dialogue cuts on both outer edges", () => {
    const tl = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [mc("v_a", "m_main", 0, 6, 0), mc("v_b", "m_main", 8, 20, 6)] },
      { id: "v2", kind: "video", name: "Screen", muted: false, hidden: false, clips: [
        mc("screen_1", "m_broll", 2, 4, 4), // 4..6 (2 s before available)
        mc("screen_2", "m_broll", 5, 8, 6), // 6..9 (2 s after available)
      ] },
      { id: "v3", kind: "video", name: "Inset", muted: false, hidden: false, clips: [
        mc("inset_1", "m_main", 4, 6, 4),
        mc("inset_2", "m_main", 8, 11, 6),
      ] },
    ]);
    const bounds = editAdjustBounds(tl, { start: 4, end: 9 }, FPS, assets, { kind: "broll", clipIds: ["screen_1", "screen_2", "inset_1", "inset_2"] })!;
    expect(bounds.mode).toBe("overlay");
    expect(bounds.canRemove).toBe(false);
    expect(bounds.minStart).toBeCloseTo(2, 5);
    expect(bounds.maxStart).toBeCloseTo(6 - 1 / FPS, 5);
    expect(bounds.minEnd).toBeCloseTo(6 + 1 / FPS, 5);
    expect(bounds.maxEnd).toBeCloseTo(11, 5);

    // Drag start edge earlier by 1 s: moves only the first clip on each overlay track, leaving interior join intact.
    const movedStart = adjustEdit(tl, { start: 4, end: 9 }, { start: 3, end: 9 }, FPS, assets, { kind: "broll", clipIds: ["screen_1", "screen_2", "inset_1", "inset_2"] })!;
    expect(movedStart.range).toEqual({ start: 3, end: 9 });
    expect(movedStart.timeline.tracks[1]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
      .toEqual([[3, 1, 4], [6, 5, 8]]);
    expect(movedStart.timeline.tracks[2]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
      .toEqual([[3, 3, 6], [6, 8, 11]]);

    // A second drag on the end edge still matches both overlay tracks even when `clipIds` only lists the clips from drag #1.
    const firstDragClipIds = movedStart.ops.flatMap(op => op.op === "updateClip" ? [op.clipId] : []);
    const movedEnd = adjustEdit(movedStart.timeline, { start: 3, end: 9 }, { start: 3, end: 10.5 }, FPS, assets, { kind: "broll", clipIds: firstDragClipIds })!;
    expect(movedEnd.range).toEqual({ start: 3, end: 10.5 });
    expect(movedEnd.timeline.tracks[1]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
      .toEqual([[3, 1, 4], [6, 5, 9.5]]);
    expect(movedEnd.timeline.tracks[2]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
      .toEqual([[3, 3, 6], [6, 8, 12.5]]);
  });

  it("refuses disallowed kinds like speed, insert, or transition", () => {
    const tl = baseTimeline([
      { id: "v1", kind: "video", name: "V1", muted: false, hidden: false, clips: [mc("v_full", "m_main", 0, 20, 0)] },
      { id: "c1", kind: "caption", name: "Captions", muted: false, hidden: false, clips: [cap("cap_1", 1, 3, "Hi")] },
    ]);
    expect(editAdjustBounds(tl, { start: 1, end: 3 }, FPS, assets, { kind: "speed" })).toBeUndefined();
    expect(editAdjustBounds(tl, { start: 1, end: 3 }, FPS, assets, { kind: "insert" })).toBeUndefined();
    expect(editAdjustBounds(tl, { start: 1, end: 3 }, FPS, assets, { kind: "transition" })).toBeUndefined();
  });
});
