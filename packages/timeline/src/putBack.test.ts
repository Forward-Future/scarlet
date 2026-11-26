import { expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, makeTrack } from "./builders.js";
import { replayJoinFades } from "./joinCrossfade.js";
import { applyOps } from "./ops.js";
import { adjustCut, cutAdjustBounds, putBackCut, putBackLooks, putBackMarkers } from "./putBack.js";
import type { Timeline } from "./timelineSchema.js";
import { clipEnd, timelineDuration } from "./time.js";

const FPS = 30;

/** One 60 s take, picture and sound, cut at 10–12 s and at 30–31 s, with a crossfade on each join's sound. */
function cutTwice() {
  const first = emptyTimeline("project");
  first.tracks[0]!.clips = [makeMediaClip("take", 0, 60, 0, { id: "picture", volume: 0 })];
  first.tracks[1]!.clips = [makeMediaClip("take", 0, 60, 0, { id: "sound" })];
  const cut = applyOps(first, [{ op: "rippleDelete", start: 30, end: 31 }, { op: "rippleDelete", start: 10, end: 12 }]);
  const faded = replayJoinFades(cut, [{ at: 10, trackId: "a1" }, { at: 28, trackId: "a1" }], 0.04);
  return { first, faded };
}

/** What plays, without the clips' names: a clip put back together keeps the first one's. */
const played = (timeline: Timeline) => timeline.tracks.map(track => track.clips.map(({ id: _id, ...clip }) => clip));

it("puts back the footage one cut took out and leaves the other cut as it was", () => {
  const { first, faded } = cutTwice();
  // The sound's join is a crossfade: its clips overlap round the cut.
  expect(faded.tracks[1]!.clips.map(c => [c.timelineIn, clipEnd(c)])).toEqual([[0, 10.02], [9.98, 28.02], [27.98, 57]]);
  const back = putBackCut(faded, 10, 2, FPS)!;
  expect(timelineDuration(back)).toBeCloseTo(59);
  // The same as cutting only at 30–31 s and fading that join.
  const only = replayJoinFades(applyOps(first, [{ op: "rippleDelete", start: 30, end: 31 }]), [{ at: 30, trackId: "a1" }], 0.04);
  expect(JSON.parse(JSON.stringify(played(back), (_k, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)))
    .toEqual(JSON.parse(JSON.stringify(played(only), (_k, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v)));
  // Both put back, it is the take again.
  const whole = putBackCut(back, 30, 1, FPS)!;
  expect(whole.tracks.map(t => t.clips.map(c => [c.timelineIn, clipEnd(c), c.kind === "media" && c.audioFadeIn, c.kind === "media" && c.audioFadeOut])))
    .toEqual([[[0, 60, 0, 0]], [[0, 60, 0, 0]]]);
});

it("keeps a later edit's look on the clip after the join, and moves markers along", () => {
  const { faded } = cutTwice();
  const punched = applyOps(faded, [{ op: "updateClip", clipId: faded.tracks[0]!.clips[1]!.id, patch: { transform: { x: 0, y: 0, scale: 1.1, rotation: 0 } } },
    { op: "addMarker", marker: { id: "m", time: 20, text: "Here" } }]);
  const back = putBackCut(punched, 10, 2, FPS)!;
  const [before, after] = back.tracks[0]!.clips;
  // The footage put back plays in the clip before the join; the punch-in still starts where it did in the take.
  expect([before!.timelineIn, clipEnd(before!), after!.timelineIn]).toEqual([0, 12, 12]);
  expect(after!.kind === "media" && [after.sourceIn, after.transform?.scale]).toEqual([12, 1.1]);
  expect(back.markers.map(m => m.time)).toEqual([22]);
});

it("answers nothing where the join isn't the cut's own any more", () => {
  const { faded } = cutTwice();
  // No join there, or not that much footage missing at it.
  expect(putBackCut(faded, 15, 2, FPS)).toBeUndefined();
  expect(putBackCut(faded, 10, 5, FPS)).toBeUndefined();
  // A clip a later edit laid across the join.
  const music = makeTrack("audio", "Music", "a2");
  music.clips = [makeMediaClip("song", 0, 40, 0)];
  expect(putBackCut({ ...faded, tracks: [...faded.tracks, music] }, 10, 2, FPS)).toBeUndefined();
});

it("takes one punch-in off again, wherever its footage is now, and leaves what was set since", () => {
  const { faded } = cutTwice();
  const [a, b, c] = faded.tracks[0]!.clips.map(clip => clip.id);
  const punch = { x: 0, y: 0, scale: 1.1, rotation: 0 };
  const ops = [{ op: "updateClip" as const, clipId: b!, patch: { transform: punch } }, { op: "updateClip" as const, clipId: c!, patch: { transform: punch, opacity: 0.5 } }];
  const punched = applyOps(faded, ops);
  // Since then the second stretch was cut in two, and the editor's later request set the third clip's opacity again.
  const later = applyOps(punched, [{ op: "rippleDelete", start: 20, end: 21 }, { op: "updateClip", clipId: c!, patch: { opacity: 0.8 } }]);
  const both = [{ start: 10, end: 28 }, { start: 28, end: 57 }];
  const looks = (timeline: Timeline) => timeline.tracks[0]!.clips.map(clip => clip.kind === "media" && [clip.transform?.scale, clip.opacity]);
  expect(looks(later)).toEqual([[undefined, 1], [1.1, 1], [1.1, 1], [1.1, 0.8]]);
  // The punch-in on the second stretch (10–28 s as the change saved it) comes off both of its pieces, and only them.
  expect(looks(putBackLooks(later, faded, punched, ops, { start: 10, end: 28 }, both, FPS)!)).toEqual([[undefined, 1], [undefined, 1], [undefined, 1], [1.1, 0.8]]);
  // The third stretch's punch-in comes off; the opacity set since stays.
  expect(looks(putBackLooks(later, faded, punched, ops, { start: 28, end: 57 }, both, FPS)!)).toEqual([[undefined, 1], [1.1, 1], [1.1, 1], [undefined, 0.8]]);
  // Nothing of the change plays in the first stretch, and a change that moved footage isn't only a look.
  expect(putBackLooks(later, faded, punched, ops, { start: 0, end: 10 }, [...both, { start: 0, end: 10 }], FPS)).toBeUndefined();
  expect(putBackLooks(later, faded, punched, [...ops, { op: "rippleDelete", start: 1, end: 2 }], { start: 10, end: 28 }, both, FPS)).toBeUndefined();
  // A change that also set a clip outside the edits it named did more than those edits: Scarlet is asked.
  expect(putBackLooks(later, faded, punched, ops, { start: 10, end: 28 }, [{ start: 10, end: 28 }], FPS)).toBeUndefined();
  expect(a).toBe("picture");
});

it("takes off the marker a to-do left, wherever later edits moved it, and leaves the others", () => {
  const { faded: before } = cutTwice();
  const after = applyOps(before, [{ op: "addMarker", marker: { id: "boats", time: 5, kind: "todo", text: "Add B-roll of the boats" } },
    { op: "addMarker", marker: { id: "harbour", time: 20, kind: "todo", text: "Add B-roll of the harbour" } }]);
  // A later edit moved the marker and added one of its own.
  const head = { ...after, markers: [...after.markers.map(m => m.id === "boats" ? { ...m, time: 7 } : m), { ...after.markers[0]!, id: "later", time: 5 }] };
  expect(putBackMarkers(head, before, after, { start: 4, end: 6 }, FPS)!.markers.map(m => m.id)).toEqual(["harbour", "later"]);
  // No marker of the change's in that stretch, or the marker is already gone.
  expect(putBackMarkers(head, before, after, { start: 10, end: 12 }, FPS)).toBeUndefined();
  expect(putBackMarkers({ ...head, markers: [] }, before, after, { start: 4, end: 6 }, FPS)).toBeUndefined();
});

it("adjusts an applied cut's left and right edges locally, preserves crossfades, and refuses spanned joins", () => {
  const { faded } = cutTwice();
  const bounds = cutAdjustBounds(faded, 10, 2, FPS)!;
  expect(bounds.minStartDelta).toBeLessThan(-9);
  expect(bounds.maxStartDelta).toBeCloseTo(2);
  expect(bounds.minEndDelta).toBeCloseTo(-2);
  expect(bounds.maxEndDelta).toBeGreaterThan(17);

  // Pull left edge right by 0.5 s (restores 0.5 s onto clip before join): duration grows 57 -> 57.5 s, join moves to 10.5 s.
  const restoredLeft = adjustCut(faded, 10, 2, 0.5, 0, FPS)!;
  expect(timelineDuration(restoredLeft)).toBeCloseTo(57.5);
  expect(restoredLeft.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
    .toEqual([[0, 0, 10.5], [10.5, 12, 30], [28.5, 31, 60]]);
  // Sound crossfade is re-centered on the moved join at 10.5 s.
  expect(restoredLeft.tracks[1]!.clips.map(c => [Math.round(c.timelineIn * 1000) / 1000, Math.round(clipEnd(c) * 1000) / 1000]))
    .toEqual([[0, 10.52], [10.48, 28.52], [28.48, 57.5]]);

  // Pull right edge right by 0.4 s (trims 0.4 s more off clip after join): duration shrinks 57 -> 56.6 s, join stays at 10 s.
  const trimmedRight = adjustCut(faded, 10, 2, 0, 0.4, FPS)!;
  expect(timelineDuration(trimmedRight)).toBeCloseTo(56.6);
  expect(trimmedRight.tracks[0]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]))
    .toEqual([[0, 0, 10], [10, 12.4, 30], [27.6, 31, 60]]);

  // Pull edges together (deltaStart = 2): puts back the whole cut cleanly.
  const pulledToZero = adjustCut(faded, 10, 2, 2, 0, FPS)!;
  expect(timelineDuration(pulledToZero)).toBeCloseTo(59);
  expect(pulledToZero.tracks[0]!.clips.length).toBe(2);

  // Spanning clip on another track refuses adjustment safely.
  const music = makeTrack("audio", "Music", "a2");
  music.clips = [makeMediaClip("song", 0, 40, 0)];
  expect(cutAdjustBounds({ ...faded, tracks: [...faded.tracks, music] }, 10, 2, FPS)).toBeUndefined();
  expect(adjustCut({ ...faded, tracks: [...faded.tracks, music] }, 10, 2, 0.5, 0, FPS)).toBeUndefined();
});

it("adjusts an opening cut and a closing cut cleanly", () => {
  const open = emptyTimeline("project");
  open.tracks[0]!.clips = [makeMediaClip("take", 2.5, 20, 0, { id: "v" })];
  const openBounds = cutAdjustBounds(open, 0, 2.5, FPS)!;
  expect(openBounds).toMatchObject({ minStartDelta: 0, maxStartDelta: 0, minEndDelta: -2.5 });
  const restoredOpen = adjustCut(open, 0, 2.5, 0, -1, FPS)!;
  expect(timelineDuration(restoredOpen)).toBeCloseTo(18.5);
  expect(restoredOpen.tracks[0]!.clips[0]).toMatchObject({ timelineIn: 0, sourceIn: 1.5, sourceOut: 20 });

  const close = emptyTimeline("project");
  close.tracks[0]!.clips = [makeMediaClip("take", 0, 18, 0, { id: "v" })];
  const closeBounds = cutAdjustBounds(close, 18, 2, FPS)!;
  expect(closeBounds).toMatchObject({ maxStartDelta: 2, minEndDelta: 0, maxEndDelta: 0 });
  const restoredClose = adjustCut(close, 18, 2, 1, 0, FPS)!;
  expect(timelineDuration(restoredClose)).toBeCloseTo(19);
  expect(restoredClose.tracks[0]!.clips[0]).toMatchObject({ timelineIn: 0, sourceIn: 0, sourceOut: 19 });
});

it("adjusts and puts back cuts whose audio crossfades drifted sub-millisecond or were cleaned asymmetrically", () => {
  const rate = 29.970037204161414;
  const twoFrames = 2 / rate;
  const oneFrame = 1 / rate;
  // Sub-millisecond rounded crossfade (e.g. 0.57 ms shorter overlap than audioFadeOut/audioFadeIn, as after frame-snapping).
  const drifted = emptyTimeline("project");
  drifted.tracks[0]!.clips = [
    makeMediaClip("take", 0, 10, 0, { id: "v_l", volume: 0 }),
    makeMediaClip("take", 26, 40, 10, { id: "v_r", volume: 0 }),
  ];
  drifted.tracks[1]!.clips = [
    makeMediaClip("take", 0, 10 + oneFrame - 0.00057, 0, { id: "a_l", audioFadeOut: twoFrames }),
    makeMediaClip("take", 26 - oneFrame, 40, 10 - oneFrame, { id: "a_r", audioFadeIn: twoFrames }),
  ];
  const bounds = cutAdjustBounds(drifted, 10, 16, rate)!;
  expect(bounds.maxStartDelta).toBeCloseTo(16, 4);
  expect(bounds.minEndDelta).toBeCloseTo(-16, 4);
  const moved = adjustCut(drifted, 10, 16, 0, -1, rate)!;
  expect(timelineDuration(moved)).toBeCloseTo(25, 2);
  // Crossfade is replayed cleanly on the audio track, and a second consecutive drag succeeds too.
  const [aLeft, aRight] = moved.tracks[1]!.clips;
  expect(aLeft!.kind === "media" && aLeft.audioFadeOut).toBeGreaterThan(0.05);
  expect(aRight!.kind === "media" && aRight.audioFadeIn).toBeGreaterThan(0.05);
  expect(cutAdjustBounds(moved, 10, 15, rate)).toBeDefined();
  expect(putBackCut(drifted, 10, 16, rate)).toBeDefined();

  // Asymmetric cleaned audio join: left ends right at join with a 1-frame fade out; right still leads 1 frame early with a 2-frame fade in.
  const asym = emptyTimeline("project");
  asym.tracks[0]!.clips = [
    makeMediaClip("take", 0, 10, 0, { id: "v_l", volume: 0 }),
    makeMediaClip("take", 14, 24, 10, { id: "v_r", volume: 0 }),
  ];
  asym.tracks[1]!.clips = [
    makeMediaClip("take", 0, 10, 0, { id: "a_l", audioFadeOut: oneFrame }),
    makeMediaClip("take", 14 - oneFrame, 24, 10 - oneFrame, { id: "a_r", audioFadeIn: twoFrames }),
  ];
  expect(cutAdjustBounds(asym, 10, 4, rate)).toBeDefined();
  const movedAsym = adjustCut(asym, 10, 4, 0.5, 0, rate)!;
  expect(timelineDuration(movedAsym)).toBeCloseTo(20.5, 2);
  const [al2, ar2] = movedAsym.tracks[1]!.clips;
  expect(al2!.kind === "media" && [clipEnd(al2), al2.audioFadeOut]).toEqual([expect.closeTo(10.5, 3), expect.closeTo(oneFrame, 3)]);
  expect(ar2!.kind === "media" && [ar2.timelineIn, ar2.audioFadeIn]).toEqual([expect.closeTo(10.5 - oneFrame, 3), expect.closeTo(twoFrames, 3)]);
  expect(cutAdjustBounds(movedAsym, 10.5, 3.5, rate)).toBeDefined();
  expect(putBackCut(asym, 10, 4, rate)).toBeDefined();
});

it("adjusts synced multi-track opening cuts and closing cuts with an audio fade-out tail", () => {
  // Opening cut: camera track has full 10 s pre-roll while synced screen recording started 1.5 s later (8.5 s pre-roll).
  const open = emptyTimeline("project");
  const cam = makeTrack("video", "Camera", "v2");
  open.tracks[0]!.clips = [makeMediaClip("screen", 8.5, 30, 0, { id: "s0", volume: 0 })];
  cam.clips = [makeMediaClip("cam", 10, 31.5, 0, { id: "c0", volume: 0 })];
  open.tracks[1]!.clips = [makeMediaClip("cam", 10, 31.5, 0, { id: "a0" })];
  open.tracks.push(cam);
  const openBounds = cutAdjustBounds(open, 0, 10, FPS)!;
  expect(openBounds.minEndDelta).toBeCloseTo(-8.5, 4);
  expect(openBounds.maxEndDelta).toBeGreaterThan(20);
  const movedOpen = adjustCut(open, 0, 10, 0, -2, FPS)!;
  expect(timelineDuration(movedOpen)).toBeCloseTo(23.5, 4);
  expect(movedOpen.tracks[0]!.clips[0]).toMatchObject({ timelineIn: 0, sourceIn: 6.5 });
  expect(movedOpen.tracks[2]!.clips[0]).toMatchObject({ timelineIn: 0, sourceIn: 8 });

  // Closing cut: video ends at 18 s while dialogue track carries a 1-frame fade-out tail to 18 + 1/30 s.
  const close = emptyTimeline("project");
  const tail = 1 / FPS;
  close.tracks[0]!.clips = [makeMediaClip("take", 0, 18, 0, { id: "v", volume: 0 })];
  close.tracks[1]!.clips = [makeMediaClip("take", 0, 18 + tail, 0, { id: "a", audioFadeOut: 2 / FPS })];
  const closeBounds = cutAdjustBounds(close, 18, 5, FPS)!;
  expect(closeBounds.maxStartDelta).toBeCloseTo(5, 4);
  const movedClose = adjustCut(close, 18, 5, 1, 0, FPS)!;
  expect(movedClose.tracks[0]!.clips[0]).toMatchObject({ sourceOut: 19 });
  expect(clipEnd(movedClose.tracks[1]!.clips[0]!)).toBeCloseTo(19 + tail, 4);
  expect(movedClose.tracks[1]!.clips[0]!.kind === "media" && movedClose.tracks[1]!.clips[0]!.audioFadeOut).toBeCloseTo(2 / FPS, 4);
});
