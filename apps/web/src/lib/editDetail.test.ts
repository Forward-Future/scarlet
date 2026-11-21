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

  it("gives a level in decibels and names the clip it is on", () => {
    expect(editDetail(change([{ op: "updateClip", clipId: "clp_music", patch: { volume: 0.5 } }]), { kind: "audio", range: at }, { timeline, media }))
      .toBe("Warm bed −6 dB");
    expect(editDetail(change([{ op: "updateTrack", trackId: "trk_a2", patch: { muted: true } }]), { kind: "audio", range: at }, { timeline, media }))
      .toBe("Muted Music");
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
