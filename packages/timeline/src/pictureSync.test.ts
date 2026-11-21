import { describe, expect, it } from "vitest";
import { applyOps } from "./ops.js";
import { emptyTimeline, makeMediaClip } from "./builders.js";
import type { Clip, MediaAsset, MediaClip, Timeline } from "./schema.js";
import { pictureSyncOps } from "./pictureSync.js";

const media: MediaAsset[] = [
  { id: "cam", kind: "video", name: "Camera", path: "cam", duration: 100, hasAudio: true },
  { id: "screen", kind: "video", name: "Screen", path: "screen", duration: 100, hasAudio: true },
];

/** Camera clips that play their own sound, a cut between them, and the screen above with its sound off. */
function edit(): Timeline {
  const tl = emptyTimeline("p");
  tl.tracks[0]!.clips.push(
    makeMediaClip("cam", 10, 20, 0, { id: "c1" }),
    makeMediaClip("cam", 25, 40, 10, { id: "c2", keyframes: [{ time: 2, transform: { scale: 1.1 }, ease: "linear" }] }),
  );
  tl.tracks.push({ id: "v2", kind: "video", name: "V2", muted: false, hidden: false, clips: [makeMediaClip("screen", 12, 37, 0, { id: "s1", volume: 0 })] });
  return tl;
}

const sync = (tl: Timeline, soundLeads: number) => {
  const { ops, report } = pictureSyncOps(tl, media, "cam", soundLeads);
  return { timeline: applyOps(tl, ops), report };
};
const clip = (tl: Timeline, id: string) => tl.tracks.flatMap(t => t.clips).find(c => c.id === id) as MediaClip;
const trackOf = (tl: Timeline, id: string) => tl.tracks.find(t => t.clips.some(c => c.id === id))!;
const dialogue = (id: string, muted: boolean, clips: Clip[] = []) => ({
  id, kind: "audio" as const, name: "V1 dialogue", muted, hidden: false, clips,
});

describe("pictureSyncOps", () => {
  it("keeps the sound where it was and plays the picture later in the recording", () => {
    const { timeline, report } = sync(edit(), 0.65);
    // The sound goes to the dialogue track, as it was: the cuts heard stay where they were.
    expect(trackOf(timeline, "c1_audio")).toMatchObject({ id: "v1_dialogue", kind: "audio" });
    expect(clip(timeline, "c1_audio")).toMatchObject({ sourceIn: 10, sourceOut: 20, timelineIn: 0, volume: 1 });
    expect(clip(timeline, "c2_audio")).toMatchObject({ sourceIn: 25, sourceOut: 40, timelineIn: 10, volume: 1 });
    // The picture is silent and shows what was filmed 0.65 s later, at the same place in the edit.
    expect(clip(timeline, "c1")).toMatchObject({ sourceIn: 10.65, sourceOut: 20.65, timelineIn: 0, volume: 0 });
    expect(clip(timeline, "c2")).toMatchObject({ sourceIn: 25.65, sourceOut: 40.65, timelineIn: 10, volume: 0 });
    expect(clip(timeline, "c2").keyframes).toEqual([{ time: 2, transform: { scale: 1.1 }, ease: "linear" }]);
    // Another recording synced by sound is left alone.
    expect(clip(timeline, "s1")).toMatchObject({ sourceIn: 12, sourceOut: 37, timelineIn: 0 });
    expect(report.soundMoved).toEqual(["c1", "c2"]);
    expect(report.moved.map(m => m.by)).toEqual([0.65, 0.65]);
  });

  it("sets the offset rather than adding to it, and 0 puts the picture back", () => {
    const once = sync(edit(), 0.65).timeline;
    const again = sync(once, 0.5);
    expect(clip(again.timeline, "c1")).toMatchObject({ sourceIn: expect.closeTo(10.5, 9), sourceOut: expect.closeTo(20.5, 9) });
    expect(again.report.soundMoved).toEqual([]);
    expect(again.report.moved[0]!.by).toBeCloseTo(-0.15);
    const back = sync(again.timeline, 0).timeline;
    expect(clip(back, "c1")).toMatchObject({ sourceIn: expect.closeTo(10, 9), sourceOut: expect.closeTo(20, 9) });
    expect(clip(back, "c2")).toMatchObject({ sourceIn: expect.closeTo(25, 9), sourceOut: expect.closeTo(40, 9) });
    const same = pictureSyncOps(once, media, "cam", 0.65);
    expect(same.ops).toEqual([]);
    expect(same.report.unchanged).toBe(2);
  });

  it("moves a picture with none of its own sound beside it by the whole offset, and says so", () => {
    const tl = edit();
    clip(tl, "c1").volume = 0;
    const { timeline, report } = sync(tl, 0.65);
    expect(clip(timeline, "c1")).toMatchObject({ sourceIn: 10.65, volume: 0 });
    expect(report.pictureOnly).toEqual(["c1"]);
  });

  it("shortens a clip where the recording's picture runs out", () => {
    const tl = edit();
    clip(tl, "c2").sourceOut = 99.8;
    const { timeline, report } = sync(tl, 0.65);
    expect(clip(timeline, "c2")).toMatchObject({ sourceIn: 25.65, sourceOut: 100 });
    expect(report.shortened).toEqual([{ clipId: "c2", seconds: expect.closeTo(0.45, 6), at: expect.closeTo(84.8, 6) }]);
    // Sound heard after the picture: the first clip starts where the recording's picture does, later in the edit.
    const late = pictureSyncOps(edit(), media, "cam", -10.5);
    const early = applyOps(edit(), late.ops);
    expect(clip(early, "c1")).toMatchObject({ sourceIn: 0, timelineIn: 0.5 });
    expect(late.report.shortened[0]).toMatchObject({ clipId: "c1", seconds: expect.closeTo(0.5, 6) });
  });

  it("puts sound on a free track when the dialogue track already has sound there", () => {
    const tl = edit();
    tl.tracks.push(dialogue("v1_dialogue", false, [makeMediaClip("screen", 0, 5, 2, { id: "busy" })]));
    const { timeline } = sync(tl, 0.65);
    expect(trackOf(timeline, "c1_audio").id).toBe("v1_dialogue_");
    expect(trackOf(timeline, "c2_audio").id).toBe("v1_dialogue");
  });

  it("skips a muted dialogue track, keeps it untouched, and allows a 0 reset to restore timing", () => {
    const tl = edit();
    const earlier = makeMediaClip("screen", 0, 8, 0, { id: "old_dialogue" });
    tl.tracks.push(dialogue("v1_dialogue", true, [earlier]));

    const { timeline, report } = sync(tl, 0.65);
    expect(report.soundMoved).toEqual(["c1", "c2"]);
    expect(timeline.tracks.filter(t => t.id.startsWith("v1_dialogue")).map(t => t.id)).toEqual(["v1_dialogue", "v1_dialogue_"]);
    expect(timeline.tracks.find(t => t.id === "v1_dialogue")).toMatchObject({ muted: true, clips: [earlier] });
    expect(trackOf(timeline, "c1_audio")).toMatchObject({ id: "v1_dialogue_", kind: "audio", muted: false });
    expect(trackOf(timeline, "c2_audio")).toMatchObject({ id: "v1_dialogue_", kind: "audio", muted: false });

    const reset = sync(timeline, 0);
    expect(reset.report.pictureOnly).toEqual([]);
    expect(clip(reset.timeline, "c1")).toMatchObject({ sourceIn: expect.closeTo(10, 9), sourceOut: expect.closeTo(20, 9) });
    expect(clip(reset.timeline, "c2")).toMatchObject({ sourceIn: expect.closeTo(25, 9), sourceOut: expect.closeTo(40, 9) });
  });

  it("reuses an unmuted fallback dialogue track where free, falls through where occupied, and skips consecutive muted tracks", () => {
    const tl = edit();
    tl.tracks.push(
      dialogue("v1_dialogue", true),
      dialogue("v1_dialogue_", false, [makeMediaClip("screen", 0, 5, 2, { id: "busy" })]),
    );
    const { timeline } = sync(tl, 0.65);
    expect(trackOf(timeline, "c1_audio")).toMatchObject({ id: "v1_dialogue__", muted: false });
    expect(trackOf(timeline, "c2_audio")).toMatchObject({ id: "v1_dialogue_", muted: false });

    const twoMuted = edit();
    twoMuted.tracks.push(dialogue("v1_dialogue", true), dialogue("v1_dialogue_", true));
    const syncedTwoMuted = sync(twoMuted, 0.65).timeline;
    expect(trackOf(syncedTwoMuted, "c1_audio")).toMatchObject({ id: "v1_dialogue__", muted: false });
    expect(trackOf(syncedTwoMuted, "c2_audio")).toMatchObject({ id: "v1_dialogue__", muted: false });
    expect(syncedTwoMuted.tracks.find(t => t.id === "v1_dialogue")!.muted).toBe(true);
    expect(syncedTwoMuted.tracks.find(t => t.id === "v1_dialogue_")!.muted).toBe(true);
  });

  it("refuses a recording with no picture in the edit or no sound of its own", () => {
    expect(() => pictureSyncOps(edit(), [...media, { id: "mic", kind: "audio", name: "Mic", path: "mic", duration: 9, hasAudio: true }], "mic", 0.2)).toThrow(/only a video/);
    expect(() => pictureSyncOps(edit(), [{ ...media[0]!, hasAudio: false }], "cam", 0.2)).toThrow(/no sound of its own/);
    expect(() => pictureSyncOps(emptyTimeline("p"), media, "cam", 0.2)).toThrow(/No clip of cam/);
  });
});
