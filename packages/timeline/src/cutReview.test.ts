import { describe, expect, it } from "vitest";
import {
  appliedCutReview, appliedReviewChange, applyOps, canStartCutReview, Change, cutPlaybackWindow, cutSummary, describeDialogueRemovals, dialogueReceipt, dialogueRemovals,
  emptyTimeline, isolatedReviewCut, makeMediaClip, planCutReview, reviewedTimeline, reviewReasons, timelineDuration, timelineFromKeepRanges, type MediaAsset,
} from "./index.js";

const media: MediaAsset[] = [{ id: "camera", name: "Interview", path: "interview.mp4", kind: "video", duration: 12 },
  { id: "mic", name: "Mic", path: "mic.wav", kind: "audio", duration: 12 }];
const empty = emptyTimeline("project");
const keep = [{ start: 1, end: 3 }, { start: 5, end: 7 }, { start: 9, end: 11 }];
const proposed = timelineFromKeepRanges("project", "camera", keep, { audioMediaId: "mic", crossfade: 0.06 });

it("gives the decoder its lead-in and final frame within a short file on the source frame grid", () => {
  expect(cutPlaybackWindow(5, 10, 45, 30)).toEqual({ start: 136 / 30, end: 301 / 30 });
  expect(cutPlaybackWindow(0, 4.98, 5.01, 30)).toEqual({ start: 0, end: 5 });
  expect(cutPlaybackWindow(0, 12, 12, 30)).toEqual({ start: 0, end: 12 });
  expect(cutPlaybackWindow(0, 12, 13, 30)).toBeUndefined();
});

it("keeps neighboring removals just outside the audition and isolates one that reaches either edge", () => {
  const review = planCutReview(empty, proposed, media)!;
  const cut = review.cuts[1]!.removed;
  // The previous omission ends at 1 and the next begins at 7. A half-open review may touch either.
  expect(isolatedReviewCut(review, cut, { start: 1, end: 7 })).toBe(true);
  expect(isolatedReviewCut(review, cut, { start: 0.99999, end: 7 })).toBe(false);
  expect(isolatedReviewCut(review, cut, { start: 1, end: 7.00001 })).toBe(false);
});

it("maps first-cut omissions to the original and restores exact source ranges on both tracks", () => {
  const review = planCutReview(empty, proposed, media)!;
  expect(review.cuts.map(c => [c.at, c.removed.start, c.removed.end])).toEqual([[0,0,1],[2,3,5],[4,7,9],[6,11,12]]);
  expect(reviewedTimeline(review, [])).toBe(proposed);
  const draft = reviewedTimeline(review, [0, 2]);
  for (const track of draft.tracks) {
    expect(track.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut])).toEqual([[0,0,3],[3,5,11]]);
  }
  expect(reviewedTimeline(review, [0,1,2,3])).toBe(review.original);
  expect(timelineDuration(review.original)).toBe(12);
  expect(timelineDuration(proposed)).toBe(6);
  expect(() => reviewedTimeline(review, [4])).toThrow();
  expect(() => reviewedTimeline(review, [1,1])).toThrow();
});

it("maps ripple operations issued in successive timeline coordinates and keeps preview and commit identical", () => {
  const original = timelineFromKeepRanges("project", "camera", [{ start: 0, end: 12 }], { audioMediaId: "mic" });
  const ops = [{ op: "rippleDelete" as const, start: 1, end: 2 }, { op: "rippleDelete" as const, start: 3, end: 5 }];
  const cut = applyOps(original, ops);
  const review = planCutReview(original, cut, media, ops)!;
  expect(review.cuts.map(c => [c.at, c.removed.start, c.removed.end])).toEqual([[1,1,2],[3,4,6]]);
  const draft = reviewedTimeline(review, [0]);
  for (const track of draft.tracks) expect(track.clips.map(c => c.kind === "media" && [c.timelineIn,c.sourceIn,c.sourceOut])).toEqual([[0,0,4],[4,6,12]]);
  expect(reviewedTimeline(review, [0])).toEqual(draft);
  expect(reviewedTimeline(review, [0,1])).toBe(original);
  expect(planCutReview(original, cut, media, [{ ...ops[0], trackIds: ["v1"] }])).toBeNull();
});

it("keeps reordered takes and independently edited audio in ordinary change review", () => {
  expect(planCutReview(empty, timelineFromKeepRanges("project", "camera", [keep[2]!,keep[0]!]), media)).toBeNull();
  const edited = structuredClone(proposed);
  edited.tracks[1]!.clips[0]!.timelineIn += 0.1;
  expect(planCutReview(empty, edited, media)).toBeNull();
});

describe("what counts as a first cut", () => {
  const plan = (edit: (t: typeof proposed) => void, base = empty, firstCut = false) => {
    const t = structuredClone(proposed);
    edit(t);
    return planCutReview(base, t, media, undefined, firstCut);
  };

  it("is a straight chronological cut of one recording, and nothing with markers, overlays, speed changes or unknown footage", () => {
    expect(plan(() => {})).not.toBeNull();
    expect(planCutReview(empty, empty, media)).toBeNull();
    expect(plan(t => { t.markers = [{ id: "m", time: 1, kind: "note", text: "x", resolved: false }]; })).toBeNull();
    expect(plan(t => { t.tracks.push({ id: "v2", kind: "video", name: "V2", muted: false, hidden: false, clips: [makeMediaClip("camera", 0, 1, 0)] }); })).toBeNull();
    expect(plan(t => { t.tracks.push({ id: "cap", kind: "caption", name: "Captions", muted: false, hidden: false,
      clips: [{ id: "c", kind: "caption", enabled: true, timelineIn: 0, timelineOut: 1, text: "Hi" }] }); })).toBeNull();
    expect(plan(t => { (t.tracks[0]!.clips[1] as { speed: number }).speed = 2; })).toBeNull();
    expect(plan(t => { t.tracks[0]!.clips[1]!.enabled = false; })).toBeNull();
    expect(plan(t => { (t.tracks[1]!.clips[2] as { volume: number }).volume = 0.5; })).toBeNull();
    expect(plan(t => { for (const c of t.tracks[0]!.clips) (c as { mediaId: string }).mediaId = "unknown"; })).toBeNull();
    // A recording shorter than the footage the cut uses can't be its source.
    expect(planCutReview(empty, proposed, [{ ...media[0]!, duration: 10 }, media[1]!])).toBeNull();
    // A cut that keeps everything has nothing to review.
    expect(planCutReview(empty, timelineFromKeepRanges("project", "camera", [{ start: 0, end: 12 }]), media)).toBeNull();
  });

  it("replaces only the untouched recording, unless the request says it is the first cut", () => {
    const raw = timelineFromKeepRanges("project", "camera", [{ start: 0, end: 12 }]);
    expect(plan(() => {}, raw)?.firstCut).toBe(true);
    const trimmed = timelineFromKeepRanges("project", "camera", [{ start: 0, end: 11 }]);
    expect(plan(() => {}, trimmed)).toBeNull();
    expect(plan(() => {}, { ...raw, markers: [{ id: "m", time: 1, kind: "note" as const, text: "x", resolved: false }] })).toBeNull();
    expect(plan(() => {}, trimmed, true)?.cuts).toHaveLength(4);
  });

  it("reads ripple removals only when every op is one, on all tracks, inside the cut", () => {
    const original = timelineFromKeepRanges("project", "camera", [{ start: 0, end: 12 }], { audioMediaId: "mic" });
    const ripple = { op: "rippleDelete" as const, start: 1, end: 2 };
    const cut = applyOps(original, [ripple]);
    expect(planCutReview(original, cut, media, [ripple])?.cuts).toEqual([{ at: 1, removed: { start: 1, end: 2 }, beforeClip: 1 }]);
    expect(planCutReview(original, cut, media, [ripple, { op: "updateClip", clipId: "x", patch: {} }])).toBeNull();
    expect(planCutReview(original, cut, media, [{ op: "rippleDelete", start: 1, end: 13 }])).toBeNull();
    // Removals that touch are one cut for the editor.
    const touching = [ripple, { op: "rippleDelete" as const, start: 1, end: 3 }];
    expect(planCutReview(original, applyOps(original, touching), media, touching)?.cuts).toEqual([{ at: 1, removed: { start: 1, end: 4 }, beforeClip: 1 }]);
  });
});

describe("an applied cut review", () => {
  const original = { ...timelineFromKeepRanges("project", "camera", [{ start: 0, end: 12 }], { audioMediaId: "mic" }), version: "v_original" };
  const ops = [{ op: "rippleDelete" as const, start: 1, end: 2 }, { op: "rippleDelete" as const, start: 3, end: 5 }];
  const review = planCutReview(original, applyOps(original, ops), media, ops)!;

  it("records where each kept cut joins once restored footage has pushed it later", () => {
    expect(appliedCutReview(review, [])).toEqual({ originalVersion: "v_original", originalDuration: 12, duration: 9,
      joins: [{ at: 1, removed: { start: 1, end: 2 } }, { at: 3, removed: { start: 4, end: 6 } }] });
    // Putting the first second back moves the second join from 3 s to 4 s and makes the cut a second longer.
    expect(appliedCutReview(review, [0])).toEqual({ originalVersion: "v_original", originalDuration: 12, duration: 10,
      joins: [{ at: 4, removed: { start: 4, end: 6 } }] });
    expect(appliedCutReview(review, [0, 1])).toMatchObject({ joins: [], duration: 12 });
    // The record agrees with the timeline the same choices build.
    expect(timelineDuration(reviewedTimeline(review, [0]))).toBe(10);
  });

  const change = (fields: Record<string, unknown>) => Change.parse({ id: "chg", projectId: "project", fromVersion: "v1", toVersion: "v2", description: "Cuts",
    author: { type: "agent", name: "Scarlet" }, state: "approved", appliedVersion: "v_applied", ...fields });

  it("is shown as the joins it left, each with two seconds either side, inside both versions", () => {
    const applied = change({ appliedReview: { originalVersion: "v_original", originalDuration: 12, duration: 9,
      joins: [{ at: 1, removed: { start: 1, end: 2 } }, { at: 8, removed: { start: 9, end: 11.5 } }] } });
    const shown = appliedReviewChange(applied);
    expect(shown).toMatchObject({ fromVersion: "v_original", toVersion: "v_applied", ranges: [{ start: 1, end: 1 }, { start: 8, end: 8 }] });
    expect(shown.renders).toEqual([
      { before: null, after: null, beforeRange: { start: 0, end: 4 }, range: { start: 0, end: 3 } },
      { before: null, after: null, beforeRange: { start: 7, end: 12 }, range: { start: 6, end: 9 } },
    ]);
  });

  it("is shown by its applied windows when it was rebased or partly applied, and left alone otherwise", () => {
    const window = { spot: { start: 4, end: 5 }, range: { start: 2, end: 7 }, beforeRange: { start: 3, end: 9 } };
    const rebased = change({ appliedOnto: "v_head", appliedWindows: [window] });
    expect(appliedReviewChange(rebased)).toMatchObject({ fromVersion: "v_head", toVersion: "v_applied", ranges: [window.spot],
      renders: [{ range: window.range, beforeRange: window.beforeRange, before: null, after: null }] });
    for (const untouched of [change({}), change({ appliedWindows: [window] }), change({ state: "ready", appliedOnto: "v_head", appliedWindows: [window] }),
      change({ appliedVersion: undefined, appliedOnto: "v_head", appliedWindows: [window] })]) {
      expect(appliedReviewChange(untouched)).toBe(untouched);
    }
  });

  it("can start only from a ready change made of whole-timeline removals, or one with no ops", () => {
    expect(canStartCutReview(change({ state: "ready" }))).toBe(true);
    expect(canStartCutReview(change({ state: "ready", ops: [] }))).toBe(true);
    expect(canStartCutReview(change({ state: "ready", ops }))).toBe(true);
    expect(canStartCutReview(change({ state: "ready", ops: [{ ...ops[0], trackIds: ["v1"] }] }))).toBe(false);
    expect(canStartCutReview(change({ state: "ready", ops: [...ops, { op: "updateClip", clipId: "c", patch: {} }] }))).toBe(false);
    for (const state of ["proposed", "rendering", "approved", "rejected", "revising", "failed"]) expect(canStartCutReview(change({ state, ops })), state).toBe(false);
  });
});

describe("a dialogue pass's receipt", () => {
  const id = `chg_${"0a".repeat(32)}`;
  const pass = (fields: Record<string, unknown>, suffix = "applied") => Change.parse({ id: `${id}_${suffix}`, projectId: "project", fromVersion: "v1", toVersion: "v2",
    description: "The whole requested plan", author: { type: "agent", name: "Scarlet" }, ...fields });
  const ops = [{ op: "rippleDelete", start: 125.9, end: 127.4 }, { op: "rippleDelete", start: 300, end: 301.75 }];

  it("says how much came out, and where when it was one cut", () => {
    expect(describeDialogueRemovals([{ start: 125.9, end: 127.4 }])).toBe("Removed 1.5 s at 2:05.");
    expect(describeDialogueRemovals([{ start: 3, end: 3.333333 }])).toBe("Removed 0.33 s at 0:03.");
    expect(describeDialogueRemovals([{ start: 3600, end: 3601 }])).toBe("Removed 1 s at 60:00.");
    expect(describeDialogueRemovals([{ start: 125.9, end: 127.4 }, { start: 300, end: 301.75 }])).toBe("Removed 3.25 s across 2 cuts.");
  });

  it("counts the footage an applied pass removed: its kept joins after review, else its own removals", () => {
    expect(dialogueRemovals(pass({ state: "approved", ops }))).toEqual([{ start: 125.9, end: 127.4 }, { start: 300, end: 301.75 }]);
    const reviewed = { originalVersion: "v0", originalDuration: 400, duration: 398.5, joins: [{ at: 125.9, removed: { start: 125.9, end: 127.4 } }] };
    expect(dialogueRemovals(pass({ state: "approved", ops, appliedReview: reviewed }))).toEqual([{ start: 125.9, end: 127.4 }]);
    // Not counted: a pass applied in part, one with other ops, one that kept everything, one not applied, and any other change.
    expect(dialogueRemovals(pass({ state: "approved", ops, approvedSpots: [0] }))).toBeUndefined();
    expect(dialogueRemovals(pass({ state: "approved", ops, appliedWindows: [] }))).toBeUndefined();
    expect(dialogueRemovals(pass({ state: "approved", ops: [...ops, { op: "updateClip", clipId: "c", patch: {} }] }))).toBeUndefined();
    expect(dialogueRemovals(pass({ state: "approved" }))).toBeUndefined();
    expect(dialogueRemovals(pass({ state: "approved", ops, appliedReview: { ...reviewed, joins: [] } }))).toBeUndefined();
    expect(dialogueRemovals(pass({ state: "ready", ops }))).toBeUndefined();
    expect(dialogueRemovals({ ...pass({ state: "approved", ops }), id: "chg_other" })).toBeUndefined();
  });

  it("reads by the pass's state, and is absent for a part a later part replaced or a change that isn't a dialogue pass", () => {
    expect(dialogueReceipt(pass({ state: "approved", ops }))).toBe("Removed 3.25 s across 2 cuts.");
    expect(dialogueReceipt(pass({ state: "approved", ops: [ops[0]] }, "review"))).toBe("Removed 1.5 s at 2:05.");
    expect(dialogueReceipt(pass({ state: "approved", ops, approvedSpots: [0] }))).toBe("Applied the reviewed dialogue edit.");
    expect(dialogueReceipt(pass({ state: "approved", ops, appliedReview: { originalVersion: "v0", originalDuration: 400, duration: 400, joins: [] } })))
      .toBe("Kept all the reviewed footage.");
    expect(dialogueReceipt(pass({ state: "ready" }))).toBe("Dialogue cuts are pending review.");
    expect(dialogueReceipt(pass({ state: "rejected" }))).toBe("The dialogue proposal was rejected.");
    expect(dialogueReceipt(pass({ state: "revising" }))).toBe("The dialogue proposal is being revised.");
    expect(dialogueReceipt(pass({ state: "failed" }))).toBe("The dialogue preview failed.");
    expect(dialogueReceipt(pass({ state: "proposed" }))).toBeUndefined();
    expect(dialogueReceipt(pass({ state: "rendering" }))).toBeUndefined();
    expect(dialogueReceipt(pass({ state: "approved", ops, replacedBy: "chg_next" }))).toBeUndefined();
    for (const other of ["chg_other", `${id}_draft`, `chg_${"0A".repeat(32)}_applied`, `x${id}_applied`]) {
      expect(dialogueReceipt({ ...pass({ state: "approved", ops }), id: other }), other).toBeUndefined();
    }
  });

  it("gives an older pass's summary in place of its list of reasons", () => {
    expect(cutSummary("Optional dialogue cuts · 1.00 s: False start")).toBe("Optional dialogue cuts are ready to review.");
    expect(cutSummary("Tighten the intro")).toBe("Tighten the intro");
    expect(cutSummary("")).toBe("");
  });
});

describe("the reasons for each cut in a review", () => {
  const cuts = [{ removed: { start: 1, end: 3 } }, { removed: { start: 4, end: 6 } }, { removed: { start: 8, end: 9 } }];

  it("are the saved reasons that start inside the cut, once each", () => {
    const cutReasons = [{ start: 1, end: 2, reason: "False start" }, { start: 2, end: 3, reason: "Long pause" }, { start: 2.5, end: 3, reason: "False start" },
      { start: 3.999995, end: 6, reason: "Retake" }, { start: 6, end: 7, reason: "Past the end" }, { start: 8, end: 9, reason: "" }];
    expect(reviewReasons({ cutReasons, description: "Cuts" }, cuts)).toEqual([["False start", "Long pause"], ["Retake"], []]);
  });

  it("are the change's description for every cut when no reasons were saved", () => {
    expect(reviewReasons({ description: "Tighten the intro" }, cuts)).toEqual([["Tighten the intro"], ["Tighten the intro"], ["Tighten the intro"]]);
    expect(reviewReasons({ description: "" }, cuts)).toEqual([[], [], []]);
  });

  it("are read back out of an older pass's description, at each removal's exact start", () => {
    const description = "Optional dialogue cuts · 1.00 s: False start · he restarts · 4.01 s: Long pause · 8.5 s: Aside";
    // 4.01 is the rounded label of a removal that starts at 4.0051, inside the second cut; 8.5 has no op and is taken as given.
    const ops = [{ op: "rippleDelete", start: 4.0051, end: 6 }, { op: "rippleDelete", start: 1.004, end: 3 }, { op: "updateClip", clipId: "c", patch: {} }];
    expect(reviewReasons({ description, ops }, cuts)).toEqual([["False start · he restarts"], ["Long pause"], ["Aside"]]);
    expect(reviewReasons({ description }, cuts)).toEqual([["False start · he restarts"], ["Long pause"], ["Aside"]]);
    expect(reviewReasons({ description: "Optional dialogue cuts · no times here" }, cuts)).toEqual([[], [], []]);
  });
});

describe("a first cut of two recordings in sync", () => {
  // A screen capture, and a camera that started 2 s after it and stopped a second before it did.
  const both: MediaAsset[] = [{ id: "screen", name: "Screen", path: "screen.mp4", kind: "video", duration: 12 },
    { id: "camera", name: "Camera", path: "camera.mp4", kind: "video", duration: 9 }];
  const inset = { scale: 0.25, x: 0.35, y: 0.35 };
  const layer = { mediaId: "camera", offset: 2, duration: 9, sound: true, transform: inset };
  const lay = (ranges: Array<{ start: number; end: number }>) => timelineFromKeepRanges("project", "screen", ranges, { layer, crossfade: 0.06 });
  const places = (t: ReturnType<typeof lay>, track: number) => t.tracks[track]!.clips.map(c => c.kind === "media" && [c.timelineIn, c.sourceIn, c.sourceOut]);

  it("lays the second recording above the first on its own clock, only where it has footage, and plays one sound", () => {
    const whole = lay([{ start: 0, end: 12 }]);
    expect(whole.tracks.map(t => [t.id, t.kind])).toEqual([["v1", "video"], ["v2", "video"], ["a1", "audio"]]);
    expect(places(whole, 0)).toEqual([[0, 0, 12]]);
    // The camera has nothing for the first 2 s or the last second.
    expect(places(whole, 1)).toEqual([[2, 0, 9]]);
    expect(whole.tracks[0]!.clips[0]).toMatchObject({ volume: 0, audioFadeIn: 0 });
    expect(whole.tracks[1]!.clips[0]).toMatchObject({ volume: 1, audioFadeIn: 0.06, transform: inset });
    const quiet = timelineFromKeepRanges("project", "screen", [{ start: 0, end: 12 }], { layer: { ...layer, sound: false } });
    expect([quiet.tracks[0]!.clips[0], quiet.tracks[1]!.clips[0]]).toMatchObject([{ volume: 1 }, { volume: 0 }]);
    // A camera that started first is cut to where the screen begins.
    const early = timelineFromKeepRanges("project", "screen", [{ start: 0, end: 5 }], { layer: { ...layer, offset: -1.5 } });
    expect(places(early, 1)).toEqual([[0, 1.5, 6.5]]);
    // Laid out whole, there is nothing to review yet.
    expect(planCutReview(empty, whole, both, undefined, true)).toBeNull();
  });

  it("takes the same stretch out of every layer when a dialogue pass cuts it, and puts it back in both", () => {
    const whole = lay([{ start: 0, end: 12 }]);
    const ops = [{ op: "rippleDelete" as const, start: 1, end: 3 }, { op: "rippleDelete" as const, start: 4, end: 5 }];
    const cut = applyOps(whole, ops);
    expect(places(cut, 0)).toEqual([[0, 0, 1], [1, 3, 6], [4, 7, 12]]);
    expect(places(cut, 1)).toEqual([[1, 1, 4], [4, 5, 9]]);
    const review = planCutReview(whole, cut, both, ops)!;
    expect(review.cuts.map(c => [c.at, c.removed.start, c.removed.end])).toEqual([[1, 1, 3], [4, 6, 7]]);
    // Skipping the first call restores it on the screen and the camera alike.
    const draft = reviewedTimeline(review, [0]);
    expect(places(draft, 0)).toEqual([[0, 0, 6], [6, 7, 12]]);
    expect(places(draft, 1)).toEqual([[2, 0, 4], [6, 5, 9]]);
    expect(reviewedTimeline(review, [0, 1])).toBe(whole);
  });

  it("reads a cut built from keep ranges as cuts, and restores each on both recordings", () => {
    const ranges = [{ start: 1, end: 3 }, { start: 5, end: 7 }, { start: 9, end: 11.5 }];
    const built = lay(ranges);
    expect(places(built, 1)).toEqual([[1, 0, 1], [2, 3, 5], [4, 7, 9]]);
    const review = planCutReview(empty, built, both, undefined, true)!;
    expect(review.firstCut).toBe(true);
    expect(review.cuts.map(c => [c.at, c.removed.start, c.removed.end])).toEqual([[0, 0, 1], [2, 3, 5], [4, 7, 9], [6.5, 11.5, 12]]);
    expect(review.layers).toEqual({ v2: { offset: 2, start: 2, end: 11 } });
    // Before: both recordings whole, the camera where it has footage.
    expect(places(review.original, 0)).toEqual([[0, 0, 12]]);
    expect(places(review.original, 1)).toEqual([[2, 0, 9]]);
    expect(review.original.tracks[1]!.clips[0]).toMatchObject({ id: built.tracks[1]!.clips[0]!.id, volume: 1, transform: inset, audioFadeIn: 0.06, audioFadeOut: 0.06 });
    expect(reviewedTimeline(review, [])).toBe(built);
    // Skipping the second and last calls joins the footage either side of each, on both.
    const draft = reviewedTimeline(review, [1, 3]);
    expect(places(draft, 0)).toEqual([[0, 1, 7], [6, 9, 12]]);
    expect(places(draft, 1)).toEqual([[1, 0, 5], [6, 7, 9]]);
    expect(reviewedTimeline(review, [1, 3])).toEqual(draft);
    // Putting back the opening, where the camera wasn't rolling yet, leaves the camera as it was.
    expect(places(reviewedTimeline(review, [0]), 1)).toEqual([[2, 0, 1], [3, 3, 5], [5, 7, 9]]);
  });

  it("leaves a second recording that isn't cut with the first to ordinary review", () => {
    const ranges = [{ start: 1, end: 3 }, { start: 5, end: 7 }];
    const edit = (change: (t: ReturnType<typeof lay>) => void) => {
      const t = lay(ranges);
      change(t);
      return planCutReview(empty, t, both, undefined, true);
    };
    expect(edit(() => {})).not.toBeNull();
    // Out of sync on one clip, trimmed short of its footage, framed differently, or of unknown length.
    expect(edit(t => { (t.tracks[1]!.clips[1] as { sourceIn: number }).sourceIn += 0.2; })).toBeNull();
    expect(edit(t => { t.tracks[1]!.clips.pop(); })).toBeNull();
    expect(edit(t => { (t.tracks[1]!.clips[1] as { transform: object }).transform = { ...inset, scale: 0.5 }; })).toBeNull();
    expect(planCutReview(empty, lay(ranges), [both[0]!, { ...both[1]!, duration: undefined }], undefined, true)).toBeNull();
  });
});
