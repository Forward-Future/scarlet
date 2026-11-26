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
