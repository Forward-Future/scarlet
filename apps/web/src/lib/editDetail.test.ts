import { describe, expect, it } from "vitest";
import type { Change, Timeline } from "@scarlet/timeline";
import { editDetail } from "./editDetail";

const media = [{ id: "med_broll", name: "city-skyline.mp4" }, { id: "med_music", name: "Warm bed.wav" }, { id: "med_main", name: "Interview.mov" }];
const timeline = {
  version: "v2",
  tracks: [
    { id: "trk_v1", kind: "video", name: "Main", clips: [{ id: "clp_main", kind: "media", mediaId: "med_main", timelineIn: 0, sourceIn: 0, sourceOut: 60, speed: 1 }] },
    { id: "trk_v2", kind: "video", name: "Overlay", clips: [] },
    { id: "trk_a2", kind: "audio", name: "Music", clips: [{ id: "clp_music", kind: "media", mediaId: "med_music", timelineIn: 0, sourceIn: 0, sourceOut: 60, speed: 1 }] },
  ],
} as unknown as Timeline;
const change = (ops: unknown[]) => ({ ops }) as unknown as Pick<Change, "ops">;
const at = { start: 10, end: 14 };

describe("editDetail", () => {
  it("names the file an overlay lays over the picture, without its extension", () => {
    const ops = [{ op: "addClip", trackId: "trk_v2", clip: { id: "c1", kind: "media", mediaId: "med_broll", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } }];
    expect(editDetail(change(ops), { kind: "overlay", range: at }, { timeline, media })).toBe("city-skyline");
  });

  it("prefers a clip's label over a raw recording filename, and omits unhelpful camera/date filenames", () => {
    const rawMedia = [
      { id: "med_board", name: "2026-11-24 10-26-50.mp4" },
      { id: "med_cam", name: "2026-11-24 10-26-49.mp4" },
      { id: "med_phone", name: "IMG_4821.MOV" },
      { id: "med_screen", name: "Screen Recording 2026-11-24 at 10.26.50 AM.mov" },
      { id: "med_named", name: "2026-11-24 keynote intro.mp4" },
    ];
    const labeledOps = [
      { op: "addClip", trackId: "trk_v2", clip: { id: "b1", kind: "media", mediaId: "med_board", label: "Tier board", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } },
      { op: "addClip", trackId: "trk_v2", clip: { id: "i1", kind: "media", mediaId: "med_cam", label: "Matt at the tier board", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } },
    ];
    expect(editDetail(change(labeledOps), { kind: "overlay", range: at }, { timeline, media: rawMedia }))
      .toBe("Tier board · Matt at the tier board");

    const unlabeledRawOps = [
      { op: "addClip", trackId: "trk_v2", clip: { id: "b2", kind: "media", mediaId: "med_board", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } },
      { op: "addClip", trackId: "trk_v2", clip: { id: "p1", kind: "media", mediaId: "med_phone", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } },
      { op: "addClip", trackId: "trk_v2", clip: { id: "s1", kind: "media", mediaId: "med_screen", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } },
    ];
    expect(editDetail(change(unlabeledRawOps), { kind: "overlay", range: at }, { timeline, media: rawMedia })).toBeUndefined();

    // A date followed by real words stays readable.
    expect(editDetail(change([{ op: "addClip", trackId: "trk_v2", clip: { id: "k1", kind: "media", mediaId: "med_named", timelineIn: 10, sourceIn: 0, sourceOut: 4, speed: 1 } }]),
      { kind: "overlay", range: at }, { timeline, media: rawMedia })).toBe("2026-11-24 keynote intro");

    // Audio updates on a raw recording fall back to plain "Sound" phrasing instead of printing the timestamp filename.
    const rawTimeline = { ...timeline, tracks: [
      { id: "trk_v1", kind: "video", name: "Main", clips: [{ id: "clp_raw", kind: "media", mediaId: "med_cam", timelineIn: 0, sourceIn: 0, sourceOut: 60, speed: 1 }] },
    ] } as unknown as Timeline;
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_raw", patch: { volume: 0.5 } }]), { kind: "audio", range: at }, { timeline: rawTimeline, media: rawMedia }))
      .toBe("Sound −6 dB");
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_raw", patch: { effects: [{ type: "voiceCleanup", params: {}, enabled: true }] } }]),
      { kind: "voice", range: at }, { timeline: rawTimeline, media: rawMedia })).toBe("Voice cleanup");
  });

  it("quotes a caption's words and counts the rest of a run", () => {
    const caption = (id: string, text: string, t: number) => ({ op: "addClip", trackId: "trk_c", clip: { id, kind: "caption", timelineIn: t, timelineOut: t + 1, text } });
    const ops = [caption("a", "Welcome back", 10), caption("b", "to the  show", 11), caption("c", "today", 12), caption("d", "far away", 40)];
    expect(editDetail(change(ops), { kind: "text", range: at }, { timeline, media })).toBe("“Welcome back” · “to the show” · 1 more");
  });

  it("says how far a zoom goes, as a still scale or from its first keyframe to its last", () => {
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_main", patch: { transform: { scale: 1.4 } } }]), { kind: "zoom", range: at }, { timeline, media }))
      .toBe("Zoom to 140%");
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_main", patch: { keyframes: [{ transform: { scale: 1 } }, { transform: { scale: 1.25 } }] } }]),
      { kind: "zoom", range: at }, { timeline, media })).toBe("Zooms 100% → 125%");
  });

  it("says how far a music dip goes and in how many places, from its keyframes and the clip's own level", () => {
    const dips = (n: number, db: number) => Array.from({ length: n }, (_, i) => [
      { time: i * 10, db: 0, ease: "easeInOut" }, { time: i * 10 + 0.3, db, ease: "linear" },
      { time: i * 10 + 4, db, ease: "easeInOut" }, { time: i * 10 + 4.8, db: 0, ease: "linear" }]).flat();
    const dip = (patch: Record<string, unknown>) => editDetail(change([{ op: "updateClip", clipId: "clp_music", patch }]), { kind: "dip", range: at }, { timeline, media });
    expect(dip({ volumeKeyframes: dips(4, -18) })).toBe("Warm bed down to −18 dB in 4 places");
    // With the clip's own level set too, both are said, and the dip's depth counts from where the level now sits.
    expect(dip({ volumeKeyframes: dips(1, -12), volume: 0.5 })).toBe("Warm bed −6 dB · Warm bed down to −18 dB");
    expect(dip({ volumeKeyframes: [] })).toBe("Warm bed back to a steady level");
  });

  it("names a voice cleanup and the clip it is on, and how much of it plays", () => {
    const clean = (params: Record<string, unknown>) => editDetail(change([{ op: "updateClip", clipId: "clp_main",
      patch: { effects: [{ type: "voiceCleanup", params, enabled: true }] } }]), { kind: "voice", range: at }, { timeline, media });
    expect(clean({})).toBe("Voice cleanup on Interview");
    expect(clean({ mix: 0.6 })).toBe("Voice cleanup on Interview at 60%");
  });

  it("names voice cleanup only where the edit put it on or changed it, read against the version it was made on", () => {
    const cleanup = (mix: number) => ({ type: "voiceCleanup", params: { mix }, enabled: true });
    const eq = { type: "eq", params: { highpass: 80 }, enabled: true };
    const on = (effects: unknown[]) => ({ ...timeline, version: "v1", tracks: timeline.tracks.map(t => ({ ...t,
      clips: t.clips.map(c => c.id === "clp_main" ? { ...c, effects } : c) })) }) as unknown as Timeline;
    const said = (effects: unknown[], before: Timeline | undefined, kind: "audio" | "voice" = "audio") =>
      editDetail(change([{ op: "updateClip", clipId: "clp_main", patch: { effects } }]), { kind, range: at }, { timeline, before, media });
    // An EQ added to a clip already cleaned says nothing of the cleanup, with or without the earlier version read.
    expect(said([cleanup(1), eq], on([cleanup(1)]))).toBeUndefined();
    expect(said([cleanup(1), eq], undefined)).toBeUndefined();
    // Put on, or turned down, it is named.
    expect(said([cleanup(1), eq], on([eq]))).toBe("Voice cleanup on Interview");
    expect(said([cleanup(0.5)], on([cleanup(1)]))).toBe("Voice cleanup on Interview at 50%");
    expect(said([cleanup(1)], undefined, "voice")).toBe("Voice cleanup on Interview");
  });

  it("gives a level in decibels and names the clip it is on", () => {
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_music", patch: { volume: 0.5 } }]), { kind: "audio", range: at }, { timeline, media }))
      .toBe("Warm bed −6 dB");
    expect(editDetail(change([{ op: "updateTrack", trackId: "trk_a2", patch: { muted: true } }]), { kind: "audio", range: at }, { timeline, media }))
      .toBe("Muted Music");
  });

  it("says how far a split edit's sound leads or trails its picture, and nothing of the copy and the silenced picture", () => {
    const ops = [
      { op: "addTrack", track: { id: "trk_v1_dialogue", kind: "audio", name: "Main dialogue", clips: [] } },
      { op: "addClip", trackId: "trk_v1_dialogue", clip: { id: "c_a", kind: "media", mediaId: "med_main", timelineIn: 0, sourceIn: 0, sourceOut: 11.76, speed: 1, volume: 1 } },
      { op: "updateClip", clipId: "clp_main", patch: { volume: 0 } },
      { op: "addClip", trackId: "trk_v1_dialogue", clip: { id: "c_b", kind: "media", mediaId: "med_main", timelineIn: 11.76, sourceIn: 30, sourceOut: 40, speed: 1, volume: 1, splitEdit: { leads: 0.24 } } },
    ];
    expect(editDetail(change(ops), { kind: "split", range: { start: 11.76, end: 12 } }, { timeline, media, fps: 25 })).toBe("Sound leads by 6 frames");
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_music", patch: { sourceOut: 14.4, splitEdit: { trails: 0.4 } } }]),
      { kind: "split", range: { start: 14, end: 14.4 } }, { timeline, media })).toBe("Sound carries 0.4 s past the cut");
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_music", patch: { sourceOut: 14, splitEdit: null } }]),
      { kind: "split", range: { start: 14, end: 14 } }, { timeline, media })).toBe("Sound cuts with the picture");
  });

  it("says only what a framing save did to its own edit, not to the clip that starts where that edit ends", () => {
    // A camera inset over 0–10 s and a punch-in on the full-screen clip from 10 s, framed in one save as two edits.
    const framed = { ...timeline, tracks: [
      { id: "trk_v1", kind: "video", name: "Main", clips: [
        { id: "a", kind: "media", mediaId: "med_main", timelineIn: 0, sourceIn: 0, sourceOut: 10, speed: 1 },
        { id: "b", kind: "media", mediaId: "med_main", timelineIn: 10, sourceIn: 10, sourceOut: 20, speed: 1 }] },
      { id: "trk_v2", kind: "video", name: "Camera inset", clips: [
        { id: "inset", kind: "media", mediaId: "med_main", timelineIn: 0, sourceIn: 0, sourceOut: 10, speed: 1 }] },
    ] } as unknown as Timeline;
    const save = change([
      { op: "updateClip", clipId: "inset", patch: { transform: { scale: 0.3, cropLeft: 0.2, cropRight: 0.2 } } },
      { op: "updateClip", clipId: "b", patch: { transform: { scale: 1.3 } } },
    ]);
    expect(editDetail(save, { kind: "reframe", range: { start: 0, end: 10 } }, { timeline: framed, media })).toBe("Inset at 30%");
    expect(editDetail(save, { kind: "zoom", range: { start: 10, end: 20 } }, { timeline: framed, media })).toBe("Zoom to 130%");
    // A reframe edit never prints "Zoom to ..." or scale-up keyframes from another clip overlapping its range.
    const overlapped = change([
      { op: "updateClip", clipId: "a", patch: { transform: { scale: 1.15 } } },
      { op: "updateClip", clipId: "inset", patch: { transform: { scale: 1, cropLeft: 0.2, cropRight: 0.2 } } },
    ]);
    expect(editDetail(overlapped, { kind: "reframe", range: { start: 0, end: 10 } }, { timeline: framed, media })).toBeUndefined();
    const scaleUpKeys = change([
      { op: "updateClip", clipId: "a", patch: { keyframes: [{ transform: { scale: 1 } }, { transform: { scale: 1.2 } }] } },
    ]);
    expect(editDetail(scaleUpKeys, { kind: "reframe", range: { start: 0, end: 10 } }, { timeline: framed, media })).toBeUndefined();
    const scaleDownKeys = change([
      { op: "updateClip", clipId: "inset", patch: { keyframes: [{ transform: { scale: 1 } }, { transform: { scale: 0.4 } }] } },
    ]);
    expect(editDetail(scaleDownKeys, { kind: "reframe", range: { start: 0, end: 10 } }, { timeline: framed, media })).toBe("Scales 100% → 40%");
  });

  it("names a transition and a speed", () => {
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_main", patch: { transitionIn: { type: "push", duration: 0.4, direction: "right" } } }]),
      { kind: "transition", range: at }, { timeline, media })).toBe("Push right, 0.4 s");
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_main", patch: { speed: 1.5 } }]), { kind: "speed", range: at }, { timeline, media }))
      .toBe("1.5× speed");
  });

  it("says nothing for a cut, a mix, or steps it can't name", () => {
    const ops = [{ op: "rippleDelete", start: 10, end: 12 }];
    expect(editDetail(change(ops), { kind: "cut", range: at }, { timeline, media })).toBeUndefined();
    expect(editDetail(change(ops), { kind: "other", range: at }, { timeline, media })).toBeUndefined();
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_main", patch: { transform: { x: 0.1 } } }]), { kind: "reframe", range: at }, { timeline, media }))
      .toBeUndefined();
  });
});
