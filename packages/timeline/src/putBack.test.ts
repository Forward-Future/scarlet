import { expect, it } from "vitest";
import { emptyTimeline, makeMediaClip, makeTrack } from "./builders.js";
import { replayJoinFades } from "./joinCrossfade.js";
import { applyOps } from "./ops.js";
import { putBackCut, putBackLooks } from "./putBack.js";
import type { MediaClip, Timeline } from "./schema.js";
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

const PUNCH = { x: 0, y: 0, scale: 1.15, rotation: 0 };

/** Build a video timeline with `clips` and punch in `clipIds` (default `["occ1"]`). */
function punched(clips: MediaClip[], clipIds: readonly string[] = ["occ1"]) {
  const before = emptyTimeline("project");
  before.tracks[0]!.clips = clips;
  const ops = clipIds.map(clipId => ({ op: "updateClip" as const, clipId, patch: { transform: PUNCH } }));
  const after = applyOps(before, ops);
  const named = clipIds.map(id => {
    const clip = after.tracks[0]!.clips.find(c => c.id === id)!;
    return { start: clip.timelineIn, end: clipEnd(clip) };
  });
  return { before, after, ops, named };
}

/** Build a video timeline with an intro, two occurrences of the same source span [10, 20], and an outro. */
function repeatedFootage() {
  return punched([
    makeMediaClip("take", 0, 10, 0, { id: "intro", volume: 0 }),
    makeMediaClip("take", 10, 20, 10, { id: "occ1", volume: 0 }),
    makeMediaClip("take", 25, 30, 20, { id: "mid", volume: 0 }),
    makeMediaClip("take", 10, 20, 25, { id: "occ2", volume: 0 }),
    makeMediaClip("take", 35, 45, 35, { id: "outro", volume: 0 }),
  ], ["occ1", "occ2"]);
}

const videoScales = (timeline: Timeline) =>
  timeline.tracks[0]!.clips.map(clip => clip.kind === "media" && clip.transform?.scale);

it("reverts only the chosen occurrence when identical source spans share the same look", () => {
  const { before, after, ops, named } = repeatedFootage();
  const snapHead = structuredClone(after);
  const revertFirst = putBackLooks(after, before, after, ops, named[0]!, named, FPS)!;
  expect(videoScales(revertFirst)).toEqual([undefined, undefined, undefined, 1.15, undefined]);
  // Re-rejecting spot 0 does not touch spot 1.
  expect(putBackLooks(revertFirst, before, after, ops, named[0]!, named, FPS)).toBeUndefined();
  // Rejecting spot 1 reverts only spot 1.
  const revertSecond = putBackLooks(after, before, after, ops, named[1]!, named, FPS)!;
  expect(videoScales(revertSecond)).toEqual([undefined, 1.15, undefined, undefined, undefined]);
  // Input timelines are never mutated.
  expect(after).toEqual(snapHead);
});

it("reverts both pieces of a split, ripple-shifted occurrence without touching a repeated occurrence", () => {
  const { before, after, ops, named } = repeatedFootage();
  // Earlier ripple splits intro and shifts both occurrences left by 2 s; middle ripple splits occ1 into two pieces.
  const later = applyOps(after, [
    { op: "rippleDelete", start: 2, end: 4 },
    { op: "rippleDelete", start: 12, end: 13 },
  ]);
  expect(videoScales(later)).toEqual([undefined, undefined, 1.15, 1.15, undefined, 1.15, undefined]);
  const reverted = putBackLooks(later, before, after, ops, named[0]!, named, FPS)!;
  expect(videoScales(reverted)).toEqual([undefined, undefined, undefined, undefined, undefined, 1.15, undefined]);
});

it("reverts the surviving right-hand piece when a split occurrence loses its head clip", () => {
  const { before, after, ops, named } = repeatedFootage();
  const later = applyOps(after, [
    { op: "splitClip", clipId: "occ1", at: 14, newClipId: "occ1_tail" },
    { op: "removeClip", clipId: "occ1" },
  ]);
  expect(later.tracks[0]!.clips.map(c => c.id)).toEqual(["intro", "occ1_tail", "mid", "occ2", "outro"]);
  const reverted = putBackLooks(later, before, after, ops, named[0]!, named, FPS)!;
  expect(videoScales(reverted)).toEqual([undefined, undefined, undefined, 1.15, undefined]);
});

it("does not revert a later duplicate clip added after the edit", () => {
  const { before, after, ops, named } = punched([
    makeMediaClip("take", 0, 10, 0, { id: "intro", volume: 0 }),
    makeMediaClip("take", 10, 20, 10, { id: "occ1", volume: 0 }),
  ]);
  const later = applyOps(after, [
    { op: "addClip", trackId: "v1", clip: makeMediaClip("take", 10, 20, 20, { id: "dup", volume: 0, transform: PUNCH }) },
  ]);
  const reverted = putBackLooks(later, before, after, ops, named[0]!, named, FPS)!;
  expect(videoScales(reverted)).toEqual([undefined, undefined, 1.15]);
});

it("ignores an unrelated longer clip of the same source elsewhere, but refuses when the edited clip joined outside footage", () => {
  const { before, after, ops, named } = punched([
    makeMediaClip("take", 10, 20, 0, { id: "occ1", volume: 0 }),
    makeMediaClip("take", 0, 30, 10, { id: "long_elsewhere", volume: 0 }),
  ]);
  // Unrelated longer clip elsewhere does not trigger a false refusal.
  const reverted = putBackLooks(after, before, after, ops, named[0]!, named, FPS)!;
  expect(videoScales(reverted)).toEqual([undefined, undefined]);
  // Extending occ1 itself with outside footage refuses.
  const joined = applyOps(after, [
    { op: "updateClip", clipId: "occ1", patch: { sourceIn: 5 } },
  ]);
  expect(putBackLooks(joined, before, after, ops, named[0]!, named, FPS)).toBeUndefined();
});

it("returns undefined when occurrence lineage is ambiguous or the edited clip moved tracks", () => {
  const { before, after, ops, named } = repeatedFootage();

  // (a) Both occurrences lose IDs and appear as fresh clips in the same gap.
  const bothFresh = applyOps(after, [
    { op: "removeClip", clipId: "occ1" },
    { op: "removeClip", clipId: "mid" },
    { op: "removeClip", clipId: "occ2" },
    { op: "addClip", trackId: "v1", clip: makeMediaClip("take", 10, 20, 10, { id: "fresh1", volume: 0, transform: PUNCH }) },
    { op: "addClip", trackId: "v1", clip: makeMediaClip("take", 10, 20, 20, { id: "fresh2", volume: 0, transform: PUNCH }) },
  ]);
  expect(putBackLooks(bothFresh, before, after, ops, named[0]!, named, FPS)).toBeUndefined();

  // (b) First occurrence tail-trimmed while second occurrence loses ID and leaves a fresh tail in the same gap.
  const tailAmbiguous = applyOps(after, [
    { op: "updateClip", clipId: "occ1", patch: { sourceOut: 14 } },
    { op: "removeClip", clipId: "mid" },
    { op: "removeClip", clipId: "occ2" },
    { op: "addClip", trackId: "v1", clip: makeMediaClip("take", 16, 20, 14, { id: "fresh_tail", volume: 0, transform: PUNCH }) },
  ]);
  expect(putBackLooks(tailAmbiguous, before, after, ops, named[0]!, named, FPS)).toBeUndefined();

  // (c) Edited clip moved to another video track.
  const movedTrack = applyOps(after, [
    { op: "addTrack", track: makeTrack("video", "B-roll", "v2") },
    { op: "moveClip", clipId: "occ1", timelineIn: 10, trackId: "v2" },
  ]);
  expect(putBackLooks(movedTrack, before, after, ops, named[0]!, named, FPS)).toBeUndefined();
});

it("returns undefined instead of reverting a second occurrence when the first was modified or deleted", () => {
  const { before, after, ops, named } = repeatedFootage();
  const modifiedFirst = applyOps(after, [
    { op: "updateClip", clipId: "occ1", patch: { transform: { x: 0, y: 0, scale: 1.3, rotation: 0 } } },
  ]);
  expect(putBackLooks(modifiedFirst, before, after, ops, named[0]!, named, FPS)).toBeUndefined();

  const deletedFirst = applyOps(after, [{ op: "removeClip", clipId: "occ1" }]);
  expect(putBackLooks(deletedFirst, before, after, ops, named[0]!, named, FPS)).toBeUndefined();
});

it("reverts both pieces of split descendants joined by a centered audio crossfade", () => {
  const before = emptyTimeline("project");
  before.tracks[1]!.clips = [
    makeMediaClip("take", 10, 30, 0, { id: "a_occ1", volume: 1 }),
    makeMediaClip("take", 10, 30, 20, { id: "a_occ2", volume: 1 }),
  ];
  const ops = [
    { op: "updateClip" as const, clipId: "a_occ1", patch: { volume: 0.5 } },
    { op: "updateClip" as const, clipId: "a_occ2", patch: { volume: 0.5 } },
  ];
  const after = applyOps(before, ops);
  const named = [{ start: 0, end: 20 }, { start: 20, end: 40 }];
  // A 0.02 s cut with a 0.08 s centered crossfade causes the split pieces' source spans to overlap by 0.06 s (> 1/30 s).
  const split = applyOps(after, [{ op: "rippleDelete", start: 8, end: 8.02 }]);
  const faded = replayJoinFades(split, [{ at: 8, trackId: "a1" }], 0.08);
  const [p1, p2] = faded.tracks[1]!.clips;
  expect(p1!.kind === "media" && p2!.kind === "media" && p1.sourceOut > p2.sourceIn + 1 / FPS).toBe(true);
  const reverted = putBackLooks(faded, before, after, ops, named[0]!, named, FPS)!;
  expect(reverted.tracks[1]!.clips.map(c => c.kind === "media" && c.volume)).toEqual([1, 1, 0.5]);
});

it("refuses a head-trimmed anchor when a fresh overlapping clip of the same source sits to its left", () => {
  const { before, after, ops, named } = punched([
    makeMediaClip("take", 0, 10, 0, { id: "intro", volume: 0 }),
    makeMediaClip("take", 10, 20, 10, { id: "occ1", volume: 0 }),
  ]);
  const headTrimmed = applyOps(after, [
    { op: "updateClip", clipId: "occ1", patch: { timelineIn: 14, sourceIn: 14 } },
  ]);
  expect(videoScales(putBackLooks(headTrimmed, before, after, ops, named[0]!, named, FPS)!)).toEqual([undefined, undefined]);
  const withFreshLeft = applyOps(headTrimmed, [
    { op: "addClip", trackId: "v1", clip: makeMediaClip("take", 10, 13, 10, { id: "fresh_head", volume: 0, transform: PUNCH }) },
  ]);
  expect(putBackLooks(withFreshLeft, before, after, ops, named[0]!, named, FPS)).toBeUndefined();
});

it("reverts both split pieces of a double-speed repeated clip without touching the second occurrence", () => {
  const { before, after, ops, named } = punched([
    makeMediaClip("take", 10, 30, 0, { id: "occ1", speed: 2, volume: 0 }),
    makeMediaClip("take", 35, 45, 10, { id: "mid", volume: 0 }),
    makeMediaClip("take", 10, 30, 20, { id: "occ2", speed: 2, volume: 0 }),
  ], ["occ1", "occ2"]);
  const later = applyOps(after, [{ op: "rippleDelete", start: 4, end: 5 }]);
  expect(videoScales(later)).toEqual([1.15, 1.15, undefined, 1.15]);
  const reverted = putBackLooks(later, before, after, ops, named[0]!, named, FPS)!;
  expect(videoScales(reverted)).toEqual([undefined, undefined, undefined, 1.15]);
});

it("reverts both split pieces across picture and sound tracks with a centered audio crossfade while leaving neighbours untouched", () => {
  const before = emptyTimeline("project");
  before.tracks[0]!.clips = [
    makeMediaClip("take", 10, 30, 0, { id: "v_prev", volume: 0, transform: PUNCH }),
    makeMediaClip("take", 10, 30, 20, { id: "v_mid", volume: 0 }),
    makeMediaClip("take", 10, 30, 40, { id: "v_next", volume: 0, transform: PUNCH }),
  ];
  before.tracks[1]!.clips = [
    makeMediaClip("take", 10, 30, 0, { id: "a_prev", volume: 0.5 }),
    makeMediaClip("take", 10, 30, 20, { id: "a_mid", volume: 1 }),
    makeMediaClip("take", 10, 30, 40, { id: "a_next", volume: 0.5 }),
  ];
  const ops = [
    { op: "updateClip" as const, clipId: "v_mid", patch: { transform: PUNCH } },
    { op: "updateClip" as const, clipId: "a_mid", patch: { volume: 0.5 } },
  ];
  const after = applyOps(before, ops);
  const named = [{ start: 20, end: 40 }];
  const split = applyOps(after, [{ op: "rippleDelete", start: 28, end: 28.02 }]);
  const faded = replayJoinFades(split, [{ at: 28, trackId: "a1" }], 0.08);
  const reverted = putBackLooks(faded, before, after, ops, named[0]!, named, FPS)!;
  expect(videoScales(reverted)).toEqual([1.15, undefined, undefined, 1.15]);
  expect(reverted.tracks[1]!.clips.map(c => c.kind === "media" && c.volume)).toEqual([0.5, 1, 1, 0.5]);
});
