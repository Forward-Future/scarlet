import { describe, expect, it } from "vitest";
import {
  applyOps,
  assignSpots,
  canApproveSpots,
  changedSpots,
  clipsAt,
  indexClipsAt,
  independentCutSpots,
  independentClipSpots,
  diffTimelines,
  makeTimeMap,
  removedJoins,
  makeMediaClip,
  makeTrack,
  planApply,
  replayOps,
  timelineDuration,
  timelineFromKeepRanges,
  timelineToSource,
  type MediaClip,
  type Timeline,
  type TimelineOp,
} from "./index.js";

const P = "prj";
/** One 20 s take laid end to end on V1 (and its audio comes with it). */
const take = (): Timeline => timelineFromKeepRanges(P, "m1", [{ start: 0, end: 20 }]);

it("preserves unrelated marker fields and refuses stale changes to the same field", () => {
  const base = take();
  base.markers.push({ id: "beat", time: 12, text: "First", kind: "note", resolved: false });
  const head = applyOps(base, [{ op: "updateMarker", markerId: "beat", patch: { text: "Approved" } }]);
  const approve = (op: TimelineOp) => planApply({ from: base, to: applyOps(base, [op]), head, ops: [op], changeRanges: [] });
  expect(approve({ op: "updateMarker", markerId: "beat", patch: { text: "Older proposal" } }).kind).toBe("conflict");
  expect(approve({ op: "removeMarker", markerId: "beat" }).kind).toBe("conflict");
  expect(approve({ op: "updateMarker", markerId: "beat", patch: { resolved: true } })).toMatchObject({
    kind: "rebased", timeline: { markers: [{ text: "Approved", resolved: true }] },
  });
});

it("conflicts when a pending marker edit targets footage that was cut", () => {
  const base = take();
  const marker = { id: "chapter", time: 1, kind: "chapter" as const, text: "Intro", resolved: false };
  base.markers.push(marker);
  const head = applyOps(base, [{ op: "rippleDelete", start: 6, end: 9 }]);
  const approve = (op: TimelineOp) => planApply({ from: base, to: applyOps(base, [op]), head, ops: [op], changeRanges: [] });
  for (const op of [
    { op: "addMarker", marker: { ...marker, id: "new", time: 8 } },
    { op: "addMarker", marker: { ...marker, id: "new", end: 8 } },
    { op: "updateMarker", markerId: marker.id, patch: { time: 6 } },
    { op: "updateMarker", markerId: marker.id, patch: { end: 8 } },
  ] as const) expect(approve(op).kind).toBe("conflict");
  expect(approve({ op: "updateMarker", markerId: marker.id, patch: { time: 9, end: 11 } })).toMatchObject({
    kind: "rebased", timeline: { markers: [{ time: 6, end: 8 }] },
  });
});

it("keeps marker starts and ends on the intended side of a new gap", () => {
  const base = take();
  const marker = { id: "beat", time: 8, end: 8, kind: "note" as const, text: "", resolved: false };
  base.markers.push(marker);
  const head = applyOps(base, [{ op: "rippleInsertGap", at: 8, duration: 5 }]);
  const approve = (op: TimelineOp) => planApply({ from: base, to: applyOps(base, [op]), head, ops: [op], changeRanges: [] });
  expect(approve({ op: "removeMarker", markerId: marker.id })).toMatchObject({ kind: "rebased", timeline: { markers: [] } });
  for (const [time, end, expectedTime, expectedEnd] of [[7, 8, 7, 8], [8, 8, 13, 13], [8, 9, 13, 14]] as const) {
    const plan = approve({ op: "addMarker", marker: { ...marker, id: "new", time, end } });
    expect(plan.kind).toBe("rebased");
    if (plan.kind === "rebased") expect(plan.timeline.markers.find(m => m.id === "new")).toMatchObject({ time: expectedTime, end: expectedEnd });
  }
});

it("keeps a marker's absolute time on a timeline with only a color card", () => {
  const base = take();
  base.tracks[0]!.clips = [{ id: "card", kind: "color", enabled: true, color: "red", opacity: 1, timelineIn: 0, timelineOut: 10 }];
  const head = applyOps(base, [{ op: "updateClip", clipId: "card", patch: { color: "blue" } }]);
  const op: TimelineOp = { op: "addMarker", marker: { id: "beat", time: 3, end: 6, kind: "note", text: "", resolved: false } };
  expect(planApply({ from: base, to: applyOps(base, [op]), head, ops: [op], changeRanges: [] })).toMatchObject({
    kind: "rebased", timeline: { markers: [{ time: 3, end: 6 }] },
  });
});

it("matches linear clip hits at cuts, gaps and nested overlaps in stored order", () => {
  const timeline = take();
  const track = makeTrack("video", "overlays");
  timeline.tracks.push(track);
  track.clips.push(makeMediaClip("m", 0, 4, 10), makeMediaClip("m", 3, 3.5, 2), makeMediaClip("m", 0, 20, 0));
  const at = indexClipsAt(timeline);
  for (const time of [0, 2, 2.5, 10, 12.5, 14, 20, 25]) expect(at(time)).toEqual(clipsAt(timeline, time));
});

/** Source time shown at timeline time t on V1. */
function sourceAt(tl: Timeline, t: number): number | null {
  const hit = clipsAt(tl, t).find((c) => c.track.id === "v1" && c.clip.kind === "media");
  return hit ? timelineToSource(hit.clip as MediaClip, t) : null;
}

function close(a: number | null, b: number) {
  expect(a).not.toBeNull();
  expect(Math.abs((a ?? 0) - b)).toBeLessThan(1e-6);
}

describe("removedJoins", () => {
  const whole = timelineFromKeepRanges("p", "m", [{ start: 0, end: 100 }]);

  it("finds each stretch a later version no longer plays, where its two sides now join", () => {
    const cut = timelineFromKeepRanges("p", "m", [{ start: 0, end: 10 }, { start: 12, end: 50 }, { start: 50.5, end: 100 }]);
    expect(removedJoins(whole, cut)).toEqual([
      { at: 10, removed: { start: 10, end: 12 } }, { at: 48, removed: { start: 50, end: 50.5 } }]);
    // A split that keeps every frame is no join, and neither is a version that changed nothing.
    expect(removedJoins(whole, timelineFromKeepRanges("p", "m", [{ start: 0, end: 40 }, { start: 40, end: 100 }]))).toEqual([]);
    expect(removedJoins(whole, whole)).toEqual([]);
  });

  it("finds footage trimmed off the start and the end", () => {
    expect(removedJoins(whole, timelineFromKeepRanges("p", "m", [{ start: 5, end: 95 }]))).toEqual([
      { at: 0, removed: { start: 0, end: 5 } }, { at: 90, removed: { start: 95, end: 100 } }]);
  });

  it("read the other way, finds the footage a later version put back", () => {
    const cut = timelineFromKeepRanges("p", "m", [{ start: 0, end: 10 }, { start: 12, end: 100 }]);
    const refined = timelineFromKeepRanges("p", "m", [{ start: 0, end: 10.5 }, { start: 12, end: 100 }]);
    expect(removedJoins(refined, cut)).toEqual([{ at: 10, removed: { start: 10, end: 10.5 } }]);
    // The join itself stayed, half a second shorter.
    expect(removedJoins(cut, refined)).toEqual([]);
  });
});

describe("makeTimeMap", () => {
  it("preserves stored priority for overlapping occurrences and distinguishes both sides of a cut", () => {
    const before = take();
    const later = makeMediaClip("m1", 4, 8, 6, { id: "later" });
    const earlier = makeMediaClip("m1", 0, 8, 1, { id: "earlier" });
    before.tracks[0]!.clips = [later, earlier];
    const after = { ...before, tracks: [{ ...before.tracks[0]!, clips: [
      { ...earlier, timelineIn: 25 }, { ...later, timelineIn: 12 },
    ] }] };
    const map = makeTimeMap(before, after);
    close(map(7), 13);
    close(map(6, "left"), 30);
    close(map(6, "right"), 12);
    close(map(0), 24); // gap before the first clip
    close(map(12), 18); // gap after the last clip
  });

  it("follows the footage across a cut", () => {
    const before = take();
    const after = applyOps(before, [{ op: "rippleDelete", start: 5, end: 6 }]);
    const map = makeTimeMap(before, after);
    close(map(2), 2); // before the cut: unchanged
    close(map(10), 9); // after the cut: one second earlier
    expect(map(5.5)).toBeNull(); // inside the cut: gone
    const back = makeTimeMap(after, before);
    close(back(9), 10);
  });
});

describe("changedSpots", () => {
  it.each([24, 29.97, 30, 59.94, 60])("finds single-frame trims at %s fps", (fps) => {
    const lastFrame = 300;
    const before = timelineFromKeepRanges(P, "m1", [{ start: 0, end: lastFrame / fps }]);
    for (const frame of [0, 5, lastFrame - 1]) {
      const start = frame / fps;
      const end = (frame + 1) / fps;
      const after = applyOps(before, [{ op: "rippleDelete", start, end }]);
      const { spots } = diffTimelines(before, after, fps);
      expect(spots).toHaveLength(1);
      close(spots[0]!.before.start, start);
      close(spots[0]!.before.end, end);
      close(spots[0]!.after.start, start);
      close(spots[0]!.after.end, start);
    }
  });

  it("ignores a leading trim that still rounds to the same project frame", () => {
    const before = take();
    const after = applyOps(before, [{ op: "rippleDelete", start: 0, end: 0.005 }]);
    expect(diffTimelines(before, after, 60).spots).toEqual([]);
  });

  it("reports a cut as one spot at the cut point, with the removed part as 'before'", () => {
    const before = take();
    const after = applyOps(before, [{ op: "rippleDelete", start: 5, end: 6.5 }]);
    const spots = changedSpots(before, after);
    expect(spots).toHaveLength(1);
    expect(spots[0]!.after.start).toBeCloseTo(5, 5);
    expect(spots[0]!.after.end).toBeCloseTo(5, 5);
    expect(spots[0]!.before.start).toBeCloseTo(5, 5);
    expect(spots[0]!.before.end).toBeCloseTo(6.5, 5);
  });

  it("limits a fade-in change to the fade itself", () => {
    const before = take();
    const id = before.tracks[0]!.clips[0]!.id;
    const after = applyOps(before, [{ op: "updateClip", clipId: id, patch: { videoFadeIn: 1.5 } }]);
    const spots = changedSpots(before, after);
    expect(spots).toHaveLength(1);
    expect(spots[0]!.after.start).toBe(0);
    expect(spots[0]!.after.end).toBeCloseTo(1.5, 5);
  });

  it("leaves an untouched audio crossfade out of a later cut's spots", () => {
    // The picture cuts at 28.2 while the sound crossfades across it, 28.18 to
    // 28.22 on one track, so the picture cut splits the crossfade in half.
    const before = take();
    const [picture, sound] = before.tracks;
    const join = 28.2 + (383.37333333333333 - 378.006667);
    picture!.clips = [
      makeMediaClip("cam", 369.20666666666665, 376.24, 21.166666666666657, { volume: 0 }),
      makeMediaClip("cam", 378.006667, 383.37333333333333, 28.2, { volume: 0 }),
      makeMediaClip("cam", 400, 420, join, { volume: 0 }),
    ];
    sound!.clips = [
      makeMediaClip("mic", 374.40000000000003, 379.92, 22.7, { audioFadeOut: 0.04 }),
      makeMediaClip("mic", 381.64666700000004, 387.03333333333336, 28.18, { audioFadeIn: 0.04 }),
      makeMediaClip("mic", 400, 420, join),
    ];
    const after = applyOps(before, [{ op: "rippleDelete", start: 40, end: 41.5 }]);
    const { ranges, beforeRanges } = diffTimelines(before, after);
    expect(ranges).toHaveLength(1);
    close(ranges[0]!.start, 40);
    close(ranges[0]!.end, 40);
    close(beforeRanges[0]!.start, 40);
    close(beforeRanges[0]!.end, 41.5);
    // A crossfade that did change still shows, and only where it differs.
    const changed = applyOps(after, [{ op: "updateClip", clipId: sound!.clips[0]!.id, patch: { audioFadeOut: 0.03 } }]);
    const [fade, cut] = diffTimelines(before, changed).ranges;
    close(fade!.start, 28.18);
    close(fade!.end, 28.22);
    close(cut!.start, 40);
  });

  it("feeds diffTimelines ranges so change clips stay short", () => {
    const before = take();
    const after = applyOps(before, [{ op: "rippleDelete", start: 3, end: 3.4 }]);
    const d = diffTimelines(before, after);
    expect(d.ranges).toHaveLength(1);
    expect(d.ranges[0]!.end - d.ranges[0]!.start).toBeLessThan(0.01);
    expect(d.beforeRanges[0]!.end - d.beforeRanges[0]!.start).toBeCloseTo(0.4, 5);
  });

  it("reports the overlap where video tracks or clips trade stacking order", () => {
    const before = take();
    const track = before.tracks[0]!;
    const base = { id: "red", enabled: true, kind: "color" as const, color: "red", opacity: 1, timelineIn: 0, timelineOut: 4 };
    const overlay = { ...base, id: "blue", color: "blue", timelineIn: 1, timelineOut: 3 };
    const expected = [{ start: 1, end: 3 }];
    before.tracks = [{ ...track, clips: [base] }, { ...track, id: "upper", clips: [overlay] }];
    const swappedTracks = diffTimelines(before, { ...before, tracks: [...before.tracks].reverse() });
    expect(swappedTracks.ranges).toEqual(expected);
    expect(swappedTracks.tracks).toContainEqual({ type: "trackModified", trackId: "upper", fields: ["track order"] });
    before.tracks = [{ ...track, clips: [base, overlay] }];
    const swappedClips = diffTimelines(before, { ...before, tracks: [{ ...track, clips: [overlay, base] }] });
    expect(swappedClips.ranges).toEqual(expected);
    expect(swappedClips.tracks).toContainEqual({ type: "trackModified", trackId: track.id, fields: ["clip order"] });
    // Changing the order of disjoint clips cannot change a frame.
    overlay.timelineIn = 4;
    overlay.timelineOut = 5;
    expect(changedSpots(before, { ...before, tracks: [{ ...track, clips: [overlay, base] }] })).toEqual([]);
  });

  it("reports nothing for identical content", () => {
    expect(changedSpots(take(), take())).toHaveLength(0);
  });
});

describe("parallel changes", () => {
  const footageChanged = (id: string) => ({ kind: "conflict", reason: `the footage under clip ${id} changed since` });

  const A: TimelineOp[] = [{ op: "rippleDelete", start: 2, end: 3 }];
  const B: TimelineOp[] = [{ op: "rippleDelete", start: 10, end: 11 }];

  it("merges two non-overlapping cuts made against the same version, in either order", () => {
    const base = take();
    const afterA = applyOps(base, A);
    const afterB = applyOps(base, B);
    const aThenB = replayOps(base, B, afterA);
    const bThenA = replayOps(base, A, afterB);
    for (const tl of [aThenB, bThenA]) {
      expect(timelineDuration(tl)).toBeCloseTo(18, 5);
      close(sourceAt(tl, 1), 1);
      close(sourceAt(tl, 2.5), 3.5); // A removed 2–3
      close(sourceAt(tl, 9.5), 11.5); // B removed 10–11 (source), now at 9 after A
    }
  });

  it("re-applies onto a moved cut through planApply", () => {
    const base = take();
    const head = applyOps(base, A);
    const to = applyOps(base, B);
    const plan = planApply({ from: base, to, head, ops: B, changeRanges: diffTimelines(base, to).ranges });
    expect(plan.kind).toBe("rebased");
    if (plan.kind === "rebased") close(sourceAt(plan.timeline, 9.5), 11.5);
  });

  it("fast-forwards when the cut hasn't moved", () => {
    const base = take();
    const to = applyOps(base, B);
    const plan = planApply({ from: base, to, head: base, ops: B, changeRanges: diffTimelines(base, to).ranges });
    expect(plan.kind).toBe("fast-forward");
  });

  it("refuses overlapping edits so the agent can redo them", () => {
    const base = take();
    const head = applyOps(base, [{ op: "rippleDelete", start: 2, end: 3 }]);
    const overlapping: TimelineOp[] = [{ op: "rippleDelete", start: 2.5, end: 3.5 }];
    const to = applyOps(base, overlapping);
    const plan = planApply({ from: base, to, head, ops: overlapping, changeRanges: diffTimelines(base, to).ranges });
    expect(plan.kind).toBe("conflict");
  });

  it("refuses a clip trim when a cut approved since split that clip", () => {
    const base = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 10 }]);
    const clipId = base.tracks[0]!.clips[0]!.id;
    const trim: TimelineOp[] = [{ op: "updateClip", clipId, patch: { sourceOut: 8 } }];
    const to = applyOps(base, trim);
    // The cut keeps the clip's id on the left piece, which now ends at source 5.
    const head = applyOps(base, [{ op: "rippleDelete", start: 5, end: 6 }]);
    const plan = planApply({ from: base, to, head, ops: trim, changeRanges: diffTimelines(base, to).ranges });
    expect(plan).toMatchObject(footageChanged(clipId));
  });

  it("still re-applies a clip trim when a cut approved since left the clip's footage alone", () => {
    const base = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 10 }, { start: 12, end: 20 }]);
    const [first, second] = base.tracks[0]!.clips.map(c => c.id);
    const approve = (trim: TimelineOp, cut: TimelineOp) => {
      const to = applyOps(base, [trim]);
      const plan = planApply({ from: base, to, head: applyOps(base, [cut]), ops: [trim], changeRanges: diffTimelines(base, to).ranges });
      expect(plan.kind).toBe("rebased");
      return plan.kind === "rebased" ? plan.timeline.tracks[0]!.clips : [];
    };
    // A cut in the other clip, after the trim.
    expect(approve({ op: "updateClip", clipId: first!, patch: { sourceOut: 8 } }, { op: "rippleDelete", start: 15, end: 16 })).toMatchObject([
      { id: first, timelineIn: 0, sourceIn: 0, sourceOut: 8 }, { id: second, timelineIn: 10, sourceIn: 12, sourceOut: 17 }, { timelineIn: 15, sourceIn: 18 },
    ]);
    // A cut before the trimmed clip only moves it.
    expect(approve({ op: "updateClip", clipId: second!, patch: { sourceOut: 18 } }, { op: "rippleDelete", start: 2, end: 3 })).toMatchObject([
      { id: first, timelineIn: 0, sourceOut: 2 }, { timelineIn: 2, sourceIn: 3, sourceOut: 10 }, { id: second, timelineIn: 9, sourceIn: 12, sourceOut: 18 },
    ]);
  });

  it("still re-applies a clip trim when a clip approved since moved on another track", () => {
    const base = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 10 }]);
    base.tracks[0]!.clips = [makeMediaClip("m1", 0, 6, 0, { id: "primary" })];
    const overlay = makeTrack("video", "Overlay", "overlay");
    overlay.clips.push(makeMediaClip("m2", 0, 10, 0, { id: "c" }));
    base.tracks.push(overlay);
    const trim: TimelineOp[] = [{ op: "updateClip", clipId: "c", patch: { sourceOut: 8 } }];
    const to = applyOps(base, trim);
    // Only the clip on V1 moved; `c` sits where it was, holding the same footage.
    const head = applyOps(base, [{ op: "moveClip", clipId: "primary", timelineIn: 1 }]);
    const plan = planApply({ from: base, to, head, ops: trim, changeRanges: diffTimelines(base, to).ranges });
    expect(plan.kind).toBe("rebased");
    expect(plan.kind === "rebased" ? plan.timeline.tracks.find(t => t.id === "overlay")!.clips : []).toMatchObject([
      { id: "c", timelineIn: 0, sourceIn: 0, sourceOut: 8 },
    ]);
  });

  it("refuses a clip trim when the clip's id now holds footage it didn't hold when the change was made", () => {
    const base = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 10 }]);
    const track = base.tracks[0]!;
    track.clips = [{ id: "card", kind: "color", enabled: true, timelineIn: 0, timelineOut: 10, color: "black", opacity: 1 }];
    // The source field does nothing on a card; the label makes the change real.
    const ops: TimelineOp[] = [{ op: "updateClip", clipId: "card", patch: { sourceOut: 8, label: "Rename card" } }];
    const to = applyOps(base, ops);
    // Since then the card became footage under the same id, and a cut split it.
    const head = applyOps(base, [
      { op: "removeClip", clipId: "card" },
      { op: "addClip", trackId: track.id, clip: makeMediaClip("m1", 0, 10, 0, { id: "card" }) },
      { op: "rippleDelete", start: 5, end: 6 },
    ]);
    const plan = planApply({ from: base, to, head, ops, changeRanges: diffTimelines(base, to).ranges });
    expect(plan).toMatchObject(footageChanged("card"));
  });

  it("approves either of two trims of one clip on its own", () => {
    const base = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 10 }, { start: 12, end: 22 }]);
    const [first, second] = base.tracks[0]!.clips.map(c => c.id);
    const ops: TimelineOp[] = [
      { op: "updateClip", clipId: second!, patch: { sourceIn: 14 } },
      { op: "updateClip", clipId: second!, patch: { sourceOut: 20 } },
    ];
    const to = applyOps(base, ops);
    const changeRanges = diffTimelines(base, to).ranges;
    expect(changeRanges).toHaveLength(2);
    expect(assignSpots(base, ops, changeRanges)).toEqual([0, 1]);
    expect(canApproveSpots(base, ops, changeRanges)).toBe(true);
    const approve = (head: Timeline, spot: number) => {
      const plan = planApply({ from: base, to, head, ops, spots: [spot], changeRanges });
      expect(plan.kind).toBe("partial");
      return plan.kind === "partial" ? plan.timeline.tracks[0]!.clips.find(c => c.id === second) : undefined;
    };
    expect(approve(base, 0)).toMatchObject({ timelineIn: 10, sourceIn: 14, sourceOut: 22 });
    expect(approve(base, 1)).toMatchObject({ timelineIn: 10, sourceIn: 12, sourceOut: 20 });
    // A cut approved since in the other clip only moves this one.
    const head = applyOps(base, [{ op: "rippleDelete", start: 2, end: 3 }]);
    expect(head.tracks[0]!.clips.map(c => c.id)).toEqual([first, expect.any(String), second]);
    expect(approve(head, 0)).toMatchObject({ timelineIn: 9, sourceIn: 14, sourceOut: 22 });
    expect(approve(head, 1)).toMatchObject({ timelineIn: 9, sourceIn: 12, sourceOut: 20 });
  });

  it("refuses one of two trims of a clip on its own when a cut approved since split that clip", () => {
    const base = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 10 }]);
    const clipId = base.tracks[0]!.clips[0]!.id;
    const ops: TimelineOp[] = [
      { op: "updateClip", clipId, patch: { sourceIn: 2 } },
      { op: "updateClip", clipId, patch: { sourceOut: 8 } },
    ];
    const to = applyOps(base, ops);
    const changeRanges = diffTimelines(base, to).ranges;
    const head = applyOps(base, [{ op: "rippleDelete", start: 5, end: 6 }]);
    const approve = (spot: number) => planApply({ from: base, to, head, ops, spots: [spot], changeRanges });
    // Either trim alone would stretch the left piece back over the right one.
    for (const spot of [0, 1]) expect(approve(spot)).toMatchObject(footageChanged(clipId));
  });

  it("refuses a trim no spot shows, approved with a later spot, when a cut approved since split its clip", () => {
    const base = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 30 }]);
    const hidden = makeTrack("video", "B-roll", "v2");
    hidden.hidden = hidden.muted = true;
    hidden.clips.push(makeMediaClip("m2", 0, 10, 10, { id: "c" }));
    const captions = makeTrack("caption", "Captions", "cc");
    captions.clips.push({ kind: "caption", id: "a", enabled: true, timelineIn: 0, timelineOut: 2, text: "a" },
      { kind: "caption", id: "z", enabled: true, timelineIn: 25, timelineOut: 27, text: "z" });
    base.tracks.push(hidden, captions);
    const ops: TimelineOp[] = [
      { op: "updateClip", clipId: "a", patch: { text: "changed a" } },
      { op: "updateClip", clipId: "c", patch: { sourceOut: 8 } },
      { op: "updateClip", clipId: "z", patch: { text: "changed z" } },
    ];
    const to = applyOps(base, ops);
    const changeRanges = diffTimelines(base, to).ranges;
    expect(assignSpots(base, ops, changeRanges)).toEqual([0, null, 1]);
    const head = applyOps(base, [{ op: "rippleDelete", start: 15, end: 16, trackIds: ["v2"] }]);
    const plan = planApply({ from: base, to, head, ops, spots: [1], changeRanges });
    expect(plan).toMatchObject(footageChanged("c"));
  });

  it("refuses to merge a whole-timeline replacement onto a moved cut", () => {
    const base = take();
    const head = applyOps(base, A);
    const to = timelineFromKeepRanges(P, "m1", [{ start: 0, end: 8 }]);
    const plan = planApply({ from: base, to, head, changeRanges: diffTimelines(base, to).ranges });
    expect(plan.kind).toBe("conflict");
  });
});

describe("parallel clip properties", () => {
  it("reanchors all clips and timed words of a new track after an earlier ripple", () => {
    const base = take();
    const track = makeTrack("caption", "Captions");
    track.clips.push({ id: "line", kind: "caption", enabled: true, text: "hello", timelineIn: 7, timelineOut: 8,
      words: [{ text: "hello", start: 7, end: 8 }] });
    const ops: TimelineOp[] = [{ op: "addTrack", track }];
    const to = applyOps(base, ops);
    const approveAfterCut = (start: number, end: number) => planApply({ from: base, to, ops,
      head: applyOps(base, [{ op: "rippleDelete", start, end }]), changeRanges: diffTimelines(base, to).ranges });
    const plan = approveAfterCut(1, 3);
    expect(plan.kind).toBe("rebased");
    if (plan.kind === "rebased") expect(plan.timeline.tracks.at(-1)?.clips).toMatchObject([
      { timelineIn: 5, timelineOut: 6, words: [{ start: 5, end: 6 }] },
    ]);
    expect(approveAfterCut(7.1, 7.9).kind).toBe("conflict");
  });

  function scene() {
    const base = take();
    const captions = makeTrack("caption", "Captions", "subs");
    captions.clips.push({ kind: "caption", id: "line", enabled: true, timelineIn: 5, timelineOut: 8, text: "helo" });
    base.tracks.push(captions);
    base.tracks[1]!.clips.push(makeMediaClip("song", 0, 20, 0, { id: "music" }));
    return base;
  }

  const update = (clipId: string, patch: Record<string, unknown>): TimelineOp => ({ op: "updateClip", clipId, patch });
  const correct = update("line", { text: "hello" });
  const lower = update("music", { volume: 0.4 });

  function approve(base: Timeline, head: Timeline, ops: TimelineOp[], spots?: number[]) {
    const to = applyOps(base, ops);
    return planApply({ from: base, to, head, ops, changeRanges: diffTimelines(base, to).ranges, spots });
  }

  it("preserves a caption correction and a music level change in either order", () => {
    const base = scene();
    for (const [first, second] of [[correct, lower], [lower, correct]] as const) {
      expect(approve(base, applyOps(base, [first]), [second])).toEqual({ kind: "rebased", timeline: applyOps(base, [first, second]) });
    }
  });

  it("merges different properties on one clip and rejects competing writes", () => {
    const base = scene();
    const clip = base.tracks[0]!.clips[0]!.id;
    const gain = update(clip, { volume: 0.6 });
    const head = applyOps(base, [gain]);
    const dim = update(clip, { opacity: 0.8 });
    expect(approve(base, head, [dim])).toEqual({ kind: "rebased", timeline: applyOps(head, [dim]) });
    expect(approve(base, head, [update(clip, { volume: 0.2 })]).kind).toBe("conflict");
    const wordChange = update("line", { words: [{ text: "hi", start: 5, end: 6 }] });
    expect(approve(base, applyOps(base, [wordChange]), [correct]).kind).toBe("conflict");
  });

  it("requires review if the underlying dialogue changed even when the caption and music survive", () => {
    const base = scene();
    const cut: TimelineOp = { op: "rippleDelete", start: 6, end: 7, trackIds: ["v1"] };
    expect(approve(base, applyOps(base, [cut]), [correct]).kind).toBe("conflict");
    expect(approve(base, applyOps(base, [correct]), [cut]).kind).toBe("conflict");
    const replace = update(base.tracks[0]!.clips[0]!.id, { mediaId: "other-speaker" });
    expect(approve(base, applyOps(base, [replace]), [correct]).kind).toBe("conflict");
  });

  it("carries corrected word timings along with a caption after an earlier cut", () => {
    const base = scene();
    const head = applyOps(base, [{ op: "rippleDelete", start: 1, end: 2 }]);
    const plan = approve(base, head, [update("line", { text: "hello", words: [{ text: "hello", start: 5, end: 6 }] })]);
    expect(plan.kind).toBe("rebased");
    if (plan.kind === "rebased") expect(plan.timeline.tracks[2]!.clips[0]).toMatchObject({
      timelineIn: 4, text: "hello", words: [{ text: "hello", start: 4, end: 5 }],
    });
  });

  it("carries word timings with a caption that is retimed too, after an earlier cut", () => {
    const base = scene();
    const head = applyOps(base, [{ op: "rippleDelete", start: 0, end: 1 }]);
    const plan = approve(base, head, [update("line", { timelineIn: 5, timelineOut: 6.5, words: [{ text: "hi", start: 5, end: 6.5 }] })]);
    expect(plan.kind).toBe("rebased");
    if (plan.kind === "rebased") expect(plan.timeline.tracks[2]!.clips[0]).toMatchObject({
      timelineIn: 4, timelineOut: 5.5, words: [{ text: "hi", start: 4, end: 5.5 }],
    });
  });

  it("keeps word timings where the caption is when only the caption part of a cut and a retiming is approved", () => {
    const base = scene();
    const ops: TimelineOp[] = [{ op: "rippleDelete", start: 1, end: 2 }, update("line", { text: "hi", words: [{ text: "hi", start: 4, end: 5 }] })];
    const to = applyOps(base, ops);
    const ranges = diffTimelines(base, to).ranges;
    const captionSpot = ranges.findIndex((r) => r.start >= 3);
    expect(captionSpot).toBeGreaterThanOrEqual(0);
    const plan = planApply({ from: base, to, head: base, ops, changeRanges: ranges, spots: [captionSpot] });
    expect(plan.kind).toBe("partial");
    if (plan.kind === "partial") expect(plan.timeline.tracks[2]!.clips[0]).toMatchObject({
      timelineIn: 5, timelineOut: 8, text: "hi", words: [{ text: "hi", start: 5, end: 6 }],
    });
  });

  it("preserves ten independent corrections submitted against one cut, in reverse approval order", () => {
    const base = scene();
    const track = base.tracks[2]!;
    track.clips = Array.from({ length: 10 }, (_, i) => ({
      kind: "caption", id: `line-${i}`, timelineIn: i, timelineOut: i + 1, enabled: true, text: "draft",
    }));
    const ops = track.clips.map((c, i) => update(c.id, { text: `final ${i}` }));
    let head = base;
    for (const edit of [...ops].reverse()) {
      const plan = approve(base, head, [edit]);
      expect(plan.kind).toBe(head === base ? "fast-forward" : "rebased");
      if (plan.kind === "conflict") throw Error(plan.reason);
      head = plan.timeline;
    }
    expect(head).toEqual(applyOps(base, ops));
  });

  it("checks only the selected caption when partially approving a batch", () => {
    const base = scene();
    base.tracks[2]!.clips.push({ kind: "caption", id: "later", enabled: true, timelineIn: 12, timelineOut: 15, text: "later" });
    const head = applyOps(base, [lower, update("later", { text: "approved" })]);
    const edits = [correct, update("later", { text: "competing" })];
    expect(approve(base, head, edits, [0])).toEqual({ kind: "partial", timeline: applyOps(head, [correct]) });
    expect(approve(base, head, edits, [1]).kind).toBe("conflict");
  });
});

describe("approving some spots of a batch", () => {
  it("recognizes descending dialogue cuts only when the saved diff matches each original removal and join", () => {
    const base = take();
    const ops: TimelineOp[] = [{ op: "rippleDelete", start: 12.11, end: 13.24 }, { op: "rippleDelete", start: 3.13, end: 4.41 }];
    const to = applyOps(base, ops);
    const diff = diffTimelines(base, to, 29.97);
    const owners = independentCutSpots(base, ops, diff.spots, 29.97);
    expect(owners).toEqual([1, 0]);
    for (const i of [0, 1]) {
      const plan = planApply({ from: base, to, head: base, ops, spots: [i], changeRanges: diff.ranges, fps: 29.97 }, owners);
      expect(plan.kind).toBe("partial");
      if (plan.kind === "partial") expect(changedSpots(base, plan.timeline)[0]!.before.start).toBeCloseTo(diff.spots[i]!.before.start, 8);
    }
    expect(independentCutSpots(base, [...ops].reverse(), diff.spots, 29.97)).toBeUndefined();
    expect(independentCutSpots(base, ops, [diff.spots[1]!, diff.spots[0]!], 29.97)).toBeUndefined();
    expect(independentCutSpots(base, [{ op: "rippleDelete", start: 12.11, end: 13.24, trackIds: ["v1"] }, ops[1]!], diff.spots, 29.97)).toBeUndefined();
    const edited = applyOps(base, [{ op: "updateClip", clipId: base.tracks[0]!.clips[0]!.id, patch: { audioFadeIn: 0.3 } }]);
    expect(independentCutSpots(edited, ops, diff.spots, 29.97)).toBeUndefined();
  });

  it("uses the replay verifier for sub-frame cuts whose skipped removal can round away", () => {
    const base = take();
    const ops: TimelineOp[] = [{ op: "rippleDelete", start: 2.004, end: 2.021 }, { op: "rippleDelete", start: .5, end: .54 }];
    const to = applyOps(base, ops);
    const diff = diffTimelines(base, to);
    expect(diff.spots.length).toBe(2);
    expect(independentCutSpots(base, ops, diff.spots, 30)).toBeUndefined();
    expect(canApproveSpots(base, ops, diff.ranges)).toBe(false);
  });

  it.each([[166, 171, 40, 42, 0], [166, 169, 42, 45.5, 0], [166, 171, 42, 50, 1 - 1e-7 / 30]])(
    "keeps a retained half-frame midpoint identical while approving separate cuts (%i–%i, %i–%i, offset %f)",
    (a, b, c, d, offset) => {
      const base = timelineFromKeepRanges(P, "take", [{ start: offset, end: offset + 10 }]);
      const fps = 30;
      const ops: TimelineOp[] = [
        { op: "rippleDelete", start: a / fps, end: b / fps },
        { op: "rippleDelete", start: c / fps, end: d / fps },
      ];
      const to = applyOps(base, ops);
      const diff = diffTimelines(base, to, fps);
      const owners = independentCutSpots(base, ops, diff.spots, fps);
      expect(owners).toEqual([1, 0]);
      expect(assignSpots(base, ops, diff.ranges, undefined, fps)).toEqual(owners);
      for (const spot of [0, 1]) {
        const plan = planApply({ from: base, to, head: base, ops, spots: [spot], changeRanges: diff.ranges, fps }, owners);
        expect(plan.kind).toBe("partial");
        if (plan.kind === "partial") {
          const skipped = changedSpots(plan.timeline, to, { fps });
          expect(skipped).toHaveLength(1);
          expect(skipped[0]!.after.end).toBe(skipped[0]!.after.start);
        }
      }
    },
  );

  it("requires a single decision for a track operation that changes two spots", () => {
    const base = take();
    const clips = [0, 5].map((start) => ({
      kind: "caption" as const, id: `c${start}`, enabled: true, timelineIn: start, timelineOut: start + 1, text: "caption",
    }));
    base.tracks.push({ id: "cap", kind: "caption", name: "Captions", muted: false, hidden: false, clips });
    const ops: TimelineOp[] = [{ op: "updateTrack", trackId: "cap", patch: { hidden: true } }];
    const to = applyOps(base, ops);
    const changeRanges = diffTimelines(base, to).ranges;
    expect(changeRanges).toEqual([{ start: 0, end: 1 }, { start: 5, end: 6 }]);
    expect(canApproveSpots(base, ops, changeRanges)).toBe(false);
    for (const head of [base, applyOps(base, [{ op: "rippleDelete", start: 12, end: 13 }])]) {
      for (const spots of [[0], [1]]) {
        expect(planApply({ from: base, to, head, ops, changeRanges, spots })).toMatchObject({ kind: "conflict", spotsUnsupported: true });
      }
    }
    expect(planApply({ from: base, to, head: base, ops, changeRanges, spots: [0, 1] })).toEqual({ kind: "fast-forward", timeline: to });
    const masked: TimelineOp[] = [{ op: "removeClip", clipId: "c0" }, ...ops];
    const maskedTarget = applyOps(base, masked);
    expect(canApproveSpots(base, masked, changeRanges)).toBe(false);
    expect(planApply({ from: base, to: maskedTarget, head: base, ops: masked, changeRanges, spots: [1] })).toMatchObject({ kind: "conflict", spotsUnsupported: true });
  });

  it("assigns separated caption corrections in operation order and verifies a partial approval", () => {
    const base = take();
    const clip = (id: string, start: number) => ({ kind: "caption" as const, id, enabled: true,
      timelineIn: start, timelineOut: start + 1, text: "Draft" });
    const track = makeTrack("caption", "Subtitles");
    track.clips = [clip("first", 0.1), { ...clip("last", 6.1), timelineOut: 7.2 }];
    base.tracks.push(track);
    const edits: TimelineOp[] = [
      { op: "updateClip", clipId: "last", patch: { text: "Last correction" } },
      { op: "updateClip", clipId: "first", patch: { text: "First correction" } },
    ];
    const to = applyOps(base, edits);
    const diff = diffTimelines(base, to);
    const owners = independentClipSpots(base, edits, diff.ranges, 0.3, 30, diff.spots);
    expect(owners).toEqual([1, 0]);
    const plan = planApply({ from: base, to, head: base, ops: edits, changeRanges: diff.ranges, spots: [0] }, owners);
    expect(plan).toEqual({ kind: "partial", timeline: applyOps(base, [edits[1]!]) });
    expect(independentClipSpots(base, [edits[0]!, edits[0]!], diff.ranges, 0.3, 30, diff.spots)).toBeUndefined();
    track.clips.reverse();
    expect(independentClipSpots(base, edits, diff.ranges, 0.3, 30, diff.spots)).toBeUndefined();
  });

  it("applies only the chosen cuts, even when later cuts were written after earlier ones", () => {
    const base = take();
    // Three filler-word cuts written front to back, each in the coordinates
    // left by the previous one (source 2.0–2.3, 8.0–8.4, 12.0–12.5).
    const ops: TimelineOp[] = [
      { op: "rippleDelete", start: 2, end: 2.3 },
      { op: "rippleDelete", start: 7.7, end: 8.1 },
      { op: "rippleDelete", start: 11.3, end: 11.8 },
    ];
    const to = applyOps(base, ops);
    const ranges = diffTimelines(base, to).ranges;
    expect(ranges).toHaveLength(3);
    expect(canApproveSpots(base, ops, ranges)).toBe(true);
    const plan = planApply({ from: base, to, head: base, ops, spots: [0, 2], changeRanges: ranges });
    expect(plan.kind).toBe("partial");
    if (plan.kind !== "partial") return;
    const tl = plan.timeline;
    expect(timelineDuration(tl)).toBeCloseTo(20 - 0.3 - 0.5, 5);
    close(sourceAt(tl, 1), 1);
    close(sourceAt(tl, 7.9), 8.2); // the middle cut (8.0–8.4) was kept out, so its words remain
    close(sourceAt(tl, 11.8), 12.6); // the last cut (12.0–12.5) applied

    // The current head already contains the skipped middle cut.
    const head = applyOps(base, [{ op: "rippleDelete", start: 8, end: 8.4 }]);
    const moved = planApply({ from: base, to, head, ops, spots: [0, 2], changeRanges: ranges });
    expect(moved.kind).toBe("partial");
    if (moved.kind === "partial") expect(changedSpots(moved.timeline, to)).toEqual([]);
  });
});
