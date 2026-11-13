import { expect, it } from "vitest";
import { applyOps, emptyTimeline, makeMediaClip, makeStagedCutMapper, mapStagedCut, timelineFromKeepRanges } from "./index.js";

const range = { start: 5, end: 10 };
const original = () => timelineFromKeepRanges("project", "camera", [{ start: 0, end: 20 }], { audioMediaId: "mic" });
const remove = (start: number, end: number) => ({ op: "rippleDelete" as const, start, end });

it("locates the same source after an earlier cut and across existing joins", () => {
  const from = timelineFromKeepRanges("project", "camera", [{ start: 0, end: 8 }, { start: 12, end: 24 }], { audioMediaId: "mic" });
  const head = applyOps(from, [remove(1, 2)]);
  expect(mapStagedCut(from, head, range, 30)).toEqual({ kind: "exact", range: { start: 4, end: 9 } });
});

it("finds only the remaining footage when the head, tail, or middle was already taken out", () => {
  const from = original();
  const head = applyOps(from, [remove(7, 9)]);
  const map = makeStagedCutMapper(from, head, 30);
  expect(map({ start: 8, end: 11 })).toEqual({ kind: "shortened", range: { start: 7, end: 9 } });
  expect(map({ start: 4, end: 8 })).toEqual({ kind: "shortened", range: { start: 4, end: 7 } });
  expect(map(range)).toEqual({ kind: "shortened", range: { start: 5, end: 8 } });
  expect(map({ start: 8, end: 9 })).toEqual({ kind: "gone", at: 7 });
  expect(map({ start: 9, end: 10 })).toEqual({ kind: "exact", range: { start: 7, end: 8 } });
});

it("can prove a removed opening or ending from the adjacent source and the timeline edge", () => {
  const from = original();
  const head = applyOps(from, [remove(18, 20), remove(0, 3)]);
  expect(mapStagedCut(from, head, { start: 0.5, end: 2 }, 30)).toEqual({ kind: "gone", at: 0 });
  expect(mapStagedCut(from, head, { start: 18.5, end: 20 }, 30)).toEqual({ kind: "gone", at: 15 });
  expect(mapStagedCut(from, emptyTimeline("project"), range, 30)).toEqual({ kind: "gone", at: 0 });
});

it("bounds inserted and replacement footage by the surrounding recording, even when no original frames survive", () => {
  const from = original();
  const insert = { op: "rippleInsertGap" as const, at: 6, duration: 2 };
  const added = { op: "addClip" as const, trackId: "v1", clip: makeMediaClip("other", 0, 2, 6) };
  const head = applyOps(from, [insert, added]);
  expect(mapStagedCut(from, head, range, 30)).toMatchObject({ kind: "conflict", range: { start: 5, end: 12 } });
  const replaced = applyOps(from, [remove(6, 8), insert, added]);
  expect(mapStagedCut(from, replaced, range, 30)).toMatchObject({ kind: "conflict", range });
  expect(mapStagedCut(from, replaced, { start: 6, end: 8 }, 30)).toMatchObject({ kind: "conflict", range: { start: 6, end: 8 } });
});

it("rejects repeated source occurrences in either version even when one copy kept its clip ID", () => {
  const from = original();
  const head = applyOps(from, [{ op: "addClip", trackId: "v1", clip: makeMediaClip("camera", 5, 10, 22) }]);
  expect(mapStagedCut(from, head, range, 30)).toMatchObject({ kind: "conflict" });
  expect(mapStagedCut(head, from, range, 30)).toMatchObject({ kind: "conflict" });
});

it("detects a changed sound, hidden overlay, or disabled clip on otherwise identical footage", () => {
  const from = original();
  const mic = from.tracks[1]!.clips[0]!;
  const mixed = applyOps(from, [{ op: "updateClip", clipId: mic.id, patch: { volume: 0.5 } }]);
  expect(mapStagedCut(from, mixed, range, 30)).toMatchObject({ kind: "conflict", range });
  const hidden = applyOps(from, [{ op: "addTrack", track: { id: "overlay", kind: "video", name: "Overlay", hidden: true, muted: true,
    clips: [makeMediaClip("overlay", 0, 1, 7, { enabled: false })] } }]);
  expect(mapStagedCut(from, hidden, range, 30)).toMatchObject({ kind: "conflict", range });
});

it("refuses a full-track cut when the picture disappeared and the same sound survived elsewhere", () => {
  const from = original();
  const head = applyOps(from, [remove(5, 10), { op: "addClip", trackId: "a1", clip: makeMediaClip("mic", 5, 10, 16) }]);
  expect(mapStagedCut(from, head, range, 30)).toMatchObject({ kind: "conflict" });
});

it("uses sound to locate a changed passage when its picture was replaced", () => {
  const from = original();
  const head = applyOps(from, [{ op: "updateClip", clipId: from.tracks[0]!.clips[0]!.id, patch: { mediaId: "other-camera" } }]);
  expect(mapStagedCut(from, head, range, 30)).toMatchObject({ kind: "conflict", range });
});

it("keeps a unique passage on a recording whose other frames were reused", () => {
  const from = original();
  const before = applyOps(from, [{ op: "addClip", trackId: "v1", clip: makeMediaClip("camera", 15, 18, 21) }]);
  const after = applyOps(before, [remove(1, 2)]);
  expect(mapStagedCut(before, after, range, 30)).toEqual({ kind: "exact", range: { start: 4, end: 9 } });
});
