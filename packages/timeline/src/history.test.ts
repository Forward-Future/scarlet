import { describe, expect, it } from "vitest";
import { emptyTimeline, makeMediaClip } from "./builders.js";
import { applyOps, shiftClip, splitClip, trimHead, type TimelineOp } from "./ops.js";
import { HistoryConflict, historyLineage, planRevert, replayHistoryEdit } from "./history.js";
import { crossfadeJoins, rippleJoins } from "./joinCrossfade.js";
import type { Change, Timeline } from "./schema.js";
import { clipEnd } from "./time.js";

it("keeps a later ripple cut on the same source footage when undoing an earlier cut", () => {
  const original = emptyTimeline("project");
  original.tracks[0]!.clips = [makeMediaClip("take", 0, 20, 0)];
  const base = applyOps(original, [{ op: "rippleDelete", start: 2, end: 4 }]);
  const ops: TimelineOp[] = [{ op: "rippleDelete", start: 10, end: 12 }];
  const later = applyOps(base, ops);
  const result = replayHistoryEdit(base, later, original, { ops, ranges: [] } as unknown as Change, 30);
  expect(result.tracks[0]!.clips).toMatchObject([
    { sourceIn: 0, sourceOut: 12 }, { sourceIn: 14, sourceOut: 20, id: later.tracks[0]!.clips.at(-1)!.id },
  ]);
});

it("keeps the cuts that went in from a pass applied with a call skipped when undoing an earlier cut", () => {
  const original = emptyTimeline("project");
  original.tracks[0]!.clips = [makeMediaClip("take", 0, 20, 0)];
  const cut = (start: number, end: number): TimelineOp => ({ op: "rippleDelete", start, end });
  const sources = (t: Timeline) => t.tracks[0]!.clips.map(c => c.kind === "media" && [c.sourceIn, c.sourceOut]);
  const base = applyOps(original, [cut(2, 4)]);
  // The pass staged three cuts on that version, later ones first, and keeps them all. The first two touch, so its
  // review counted them as one call. The editor skipped that call: the version saved has only the last cut.
  const pass = { ops: [cut(10, 12), cut(6, 7), cut(5, 6)], ranges: [], restoredCuts: [0] } as unknown as Change;
  const later = applyOps(base, [cut(10, 12)]);
  const result = replayHistoryEdit(base, later, original, pass, 30);
  expect(result.tracks[0]!.clips).toMatchObject([
    { sourceIn: 0, sourceOut: 12 }, { sourceIn: 14, sourceOut: 20, id: later.tracks[0]!.clips.at(-1)!.id },
  ]);
  // Skipping the other call instead leaves the two cuts that touch, saved as the one cut the review listed.
  expect(sources(replayHistoryEdit(base, applyOps(base, [cut(5, 7)]), original, { ...pass, restoredCuts: [1] }, 30))).toEqual([[0, 7], [9, 20]]);
  // With every call skipped the pass changed nothing, and there is nothing to keep.
  expect(replayHistoryEdit(base, { ...base, version: "kept" }, original, { ...pass, restoredCuts: [0, 1] }, 30)).toBe(original);

  // Applied onto an edit that had moved since the pass was staged, its cuts are found where they were proposed.
  const trimmed = { ...applyOps(base, [cut(0, 1)]), version: "moved" };
  const moved = replayHistoryEdit(trimmed, applyOps(trimmed, [cut(9, 11)]), applyOps(original, [cut(0, 1)]),
    { ...pass, fromVersion: "staged" }, 30, () => ({ ...base, version: "staged" }));
  expect(sources(moved)).toEqual([[1, 12], [14, 20]]);
});

it("puts Scarlet's crossfade back on a later cut's joins when undoing an earlier cut", () => {
  const original = emptyTimeline("project");
  original.tracks[1]!.clips = [makeMediaClip("take", 0, 20, 0)];
  const base = applyOps(original, [{ op: "rippleDelete", start: 2, end: 4 }]);
  const ops: TimelineOp[] = [{ op: "rippleDelete", start: 10, end: 12 }];
  const { timeline: later, fades } = crossfadeJoins(applyOps(base, ops), undefined, rippleJoins(ops), 0.08);
  const change = { ops, ranges: [], joinFades: { duration: 0.08, fades, plain: [] } } as unknown as Change;
  // Its ops hold only the removal: replayed without the fades, the saved cut doesn't match and the undo is refused.
  expect(() => replayHistoryEdit(base, later, original, { ops, ranges: [] } as unknown as Change, 30)).toThrow(HistoryConflict);
  const result = replayHistoryEdit(base, later, original, change, 30);
  expect(result.tracks[1]!.clips).toMatchObject([
    { timelineIn: 0, sourceIn: 0, sourceOut: 12.04, audioFadeOut: 0.08 },
    { timelineIn: 11.96, sourceIn: 13.96, sourceOut: 20, audioFadeIn: 0.08, id: later.tracks[1]!.clips.at(-1)!.id },
  ]);
});

it("preserves independent properties and refuses dependent edits", () => {
  const original = emptyTimeline("project");
  original.tracks[0]!.clips = [makeMediaClip("take", 0, 20, 0, { id: "take" })];
  const volume = (n: number): TimelineOp => ({ op: "updateClip", clipId: "take", patch: { volume: n } });
  const applied = applyOps(original, [volume(0.5)]);
  const later = applyOps(applied, [{ op: "updateClip", clipId: "take", patch: { opacity: 0.4 } }]);
  expect(replayHistoryEdit(applied, later, original, null, 30).tracks[0]!.clips[0]).toMatchObject({ volume: 1, opacity: 0.4 });
  expect(() => replayHistoryEdit(applied, applyOps(applied, [volume(0.2)]), original, null, 30)).toThrow("volume");
});

it("keeps the restored timeline name when replaying a later ripple", () => {
  const original = emptyTimeline("project", "Original");
  original.tracks[0]!.clips = [makeMediaClip("take", 0, 10, 0)];
  const renamed = { ...original, name: "Renamed" };
  const ops: TimelineOp[] = [{ op: "rippleDelete", start: 2, end: 3 }];
  const later = applyOps(renamed, ops);
  const result = replayHistoryEdit(renamed, later, original, { ops, ranges: [] } as unknown as Change, 30);
  expect(result.name).toBe("Original");
  expect(result.tracks).toEqual(later.tracks);
});

describe("historyLineage", () => {
  const versions = [
    { version: "v0", parent: null }, { version: "v1", parent: "v0" }, { version: "v2", parent: "v1" },
    { version: "side", parent: "v1" },
    { version: "undo", parent: "v2", revertsVersion: "v1" }, { version: "redo", parent: "undo", revertsVersion: "undo" },
  ];

  it("walks one branch back from its head, leaving other branches out", () => {
    expect([...historyLineage(versions, "v2").lineage]).toEqual(["v2", "v1", "v0"]);
    expect([...historyLineage(versions, "side").lineage]).toEqual(["side", "v1", "v0"]);
    expect(historyLineage(versions, "v2").undone.size).toBe(0);
  });

  it("counts an edit as undone by a revert, and as back again once that revert is itself undone", () => {
    expect([...historyLineage(versions, "undo").undone]).toEqual(["v1"]);
    expect([...historyLineage(versions, "redo").undone]).toEqual(["undo"]);
    expect([...historyLineage(versions, "redo").lineage]).toEqual(["redo", "undo", "v2", "v1", "v0"]);
  });

  it("is empty with no head or a head it doesn't know, and stops on a history that loops", () => {
    expect(historyLineage(versions, null).lineage.size).toBe(0);
    expect(historyLineage(versions, "gone").lineage.size).toBe(0);
    const loop = [{ version: "a", parent: "b" }, { version: "b", parent: "a" }];
    expect([...historyLineage(loop, "a").lineage]).toEqual(["a", "b"]);
    // A parent that was never saved ends the walk.
    expect([...historyLineage([{ version: "v1", parent: "lost" }], "v1").lineage]).toEqual(["v1"]);
  });
});

describe("planRevert", () => {
  type Entry = Parameters<typeof planRevert>[0][number];
  /** v0 is one 20 s take. Each step is an edit on the version before it: v1, v2, … with changes c1, c2, … */
  function story(steps: Array<TimelineOp[] | ((latest: Timeline) => TimelineOp[])>) {
    const first = emptyTimeline("project");
    first.tracks[0]!.clips = [makeMediaClip("take", 0, 20, 0, { id: "take" })];
    const timelines = new Map<string, Timeline>([["v0", { ...first, version: "v0" }]]);
    const changes = new Map<string, Change>();
    const versions: Entry[] = [{ version: "v0", parent: null, changeId: null }];
    let head = "v0";
    const latest = () => timelines.get(head)!;
    const add = (timeline: Timeline, entry: Omit<Entry, "version" | "parent">, ops?: TimelineOp[]) => {
      const parent = head, version = `v${versions.length}`;
      timelines.set(version, { ...timeline, version, parent });
      if (entry.changeId) changes.set(entry.changeId, { id: entry.changeId, ops, ranges: [], fromVersion: parent } as unknown as Change);
      versions.push({ version, parent, ...entry });
      return head = version;
    };
    const edit = (step: (typeof steps)[number]) => {
      const ops = typeof step === "function" ? step(latest()) : step;
      return add(applyOps(latest(), ops), { changeId: `c${versions.length}`, description: `Edit ${versions.length}` }, ops);
    };
    steps.forEach(edit);
    const revert = (target: string) => planRevert(versions, head, target, 30, id => timelines.get(id)!, id => changes.get(id) ?? null);
    /** Undo `target` and save the result as the next version, as the engine does. */
    const undo = (target: string) => add(revert(target), { changeId: null, revertsVersion: target, description: `Undo ${target}` });
    return { versions, timelines, revert, undo, add, edit, latest };
  }
  const sources = (t: Timeline) => t.tracks[0]!.clips.map(c => c.kind === "media" && [c.sourceIn, c.sourceOut]);
  const removeEarly: TimelineOp = { op: "rippleDelete", start: 2, end: 4 };
  const removeLate: TimelineOp = { op: "rippleDelete", start: 10, end: 12 };
  const quiet: TimelineOp = { op: "updateClip", clipId: "take", patch: { volume: 0.5 } };
  /** Turn down the last piece of the take, which neither removal touches. */
  const quietEnding = (t: Timeline): TimelineOp[] => [{ op: "updateClip", clipId: t.tracks[0]!.clips.at(-1)!.id, patch: { volume: 0.5 } }];
  const note: TimelineOp = { op: "addMarker", marker: { id: "note", time: 15, kind: "note", text: "Check", resolved: false } };

  it("returns the version before the latest edit when that is the one undone", () => {
    const { revert, timelines } = story([[removeEarly], [removeLate]]);
    expect(revert("v2")).toBe(timelines.get("v1"));
  });

  it("undoes an earlier edit and keeps the later ones on the same footage", () => {
    const { revert, timelines } = story([[removeEarly], [removeLate], quietEnding, [note]]);
    const result = revert("v1");
    // The first removal is back; the later one took source 12–14, and still does.
    expect(sources(result)).toEqual([[0, 12], [14, 20]]);
    expect(result.tracks[0]!.clips[1]).toMatchObject({ id: timelines.get("v4")!.tracks[0]!.clips[2]!.id, volume: 0.5 });
    // The marker was put 15 s into a cut that was 2 s shorter: it stays on the same footage.
    expect(result.markers).toMatchObject([{ id: "note", time: 17 }]);
  });

  it("refuses when a later edit changed a clip the undone edit had split", () => {
    const { revert } = story([[removeEarly], [quiet]]);
    expect(() => revert("v1")).toThrow(/Couldn’t keep “Edit 2” while undoing this edit: .*clip take changed since/);
  });

  it("refuses a version that isn't an edit on this branch", () => {
    const { revert, versions } = story([[removeEarly], [removeLate]]);
    versions.push({ version: "side", parent: "v1", changeId: null });
    for (const target of ["gone", "side", "v0"]) {
      expect(() => revert(target), target).toThrow(HistoryConflict);
      expect(() => revert(target)).toThrow("outside the current branch");
    }
  });

  it("refuses to undo the same edit twice", () => {
    const { revert, undo, timelines } = story([[removeEarly], [removeLate]]);
    expect(sources(timelines.get(undo("v1"))!)).toEqual([[0, 12], [14, 20]]);
    expect(() => revert("v1")).toThrow("already been undone");
    expect(() => revert("v1")).toThrow(HistoryConflict);
  });

  it("undoes an undo, bringing the edit back under the work done since", () => {
    const { revert, undo, edit, timelines } = story([[removeEarly], [removeLate]]);
    const undone = undo("v1");
    // Undone straight away, the cut is as it was before the undo.
    expect(revert(undone)).toBe(timelines.get("v2"));
    edit(quietEnding);
    const result = revert(undone);
    expect(sources(result)).toEqual(sources(timelines.get("v2")!));
    expect(result.tracks[0]!.clips.map(c => c.kind === "media" && c.volume)).toEqual([1, 1, 0.5]);
    // And the edit that came back can be undone again.
    undo(undone);
    expect(sources(revert("v1"))).toEqual([[0, 12], [14, 20]]);
  });

  it("says which later edit stands in the way, by its description or else its version, and why", () => {
    const louder: TimelineOp = { op: "updateClip", clipId: "take", patch: { volume: 0.2 } };
    const named = story([[quiet], [louder]]);
    expect(() => named.revert("v1")).toThrow(HistoryConflict);
    expect(() => named.revert("v1")).toThrow("Couldn’t keep “Edit 2” while undoing this edit: a later edit also depends on take.volume. The edit is unchanged.");
    delete named.versions[2]!.description;
    expect(() => named.revert("v1")).toThrow("Couldn’t keep “v2” while undoing");
  });

  it("keeps a later edit that was saved without its ops when it only touched other things", () => {
    const { revert, add, timelines } = story([[quiet]]);
    const marked = applyOps(timelines.get("v1")!, [{ op: "addMarker", marker: { id: "note", time: 5, kind: "note", text: "Check", resolved: false } },
      { op: "setTimeline", patch: { name: "Renamed" } }]);
    add(marked, { changeId: null });
    const result = revert("v1");
    expect(result).toMatchObject({ name: "Renamed", markers: [{ id: "note", time: 5 }] });
    expect(result.tracks[0]!.clips[0]).toMatchObject({ volume: 1 });
  });
});

describe("replaying an edit onto a cut that moved", () => {
  const base = () => {
    const t = emptyTimeline("project");
    t.tracks[0]!.clips = [makeMediaClip("take", 0, 20, 0, { id: "one" }), makeMediaClip("take", 30, 40, 20, { id: "two" })];
    return t;
  };

  it("returns the edit itself when the cut didn't move", () => {
    const from = base();
    const next = applyOps(from, [{ op: "removeClip", clipId: "two" }]);
    expect(replayHistoryEdit(from, next, { ...from, version: "other", parent: "p" }, null, 30)).toBe(next);
  });

  it("merges clips added and removed on each side, and refuses when both sides changed or removed the same one", () => {
    const from = base();
    const add = (id: string, at: number): TimelineOp => ({ op: "addClip", trackId: "a1", clip: makeMediaClip("music", 0, 5, at, { id }) });
    const onto = applyOps(from, [add("theirs", 0)]);
    const next = applyOps(from, [add("mine", 10), { op: "removeClip", clipId: "two" }]);
    const merged = replayHistoryEdit(from, next, onto, null, 30);
    expect(merged.tracks.map(t => t.clips.map(c => c.id).sort())).toEqual([["one"], ["mine", "theirs"]]);
    // The clip the edit removed was changed since.
    const changed = applyOps(from, [{ op: "updateClip", clipId: "two", patch: { opacity: 0.5 } }]);
    expect(() => replayHistoryEdit(from, next, changed, null, 30)).toThrow(HistoryConflict);
    // The clip the edit changed is gone.
    const edited = applyOps(from, [{ op: "updateClip", clipId: "two", patch: { volume: 0.3 } }]);
    const gone = applyOps(from, [{ op: "removeClip", clipId: "two" }, add("theirs", 0)]);
    expect(() => replayHistoryEdit(from, edited, gone, null, 30)).toThrow(HistoryConflict);
    // Both sides added a clip under the same id.
    expect(() => replayHistoryEdit(from, applyOps(from, [add("same", 0)]), applyOps(from, [add("same", 8)]), null, 30)).toThrow("depends on same");
  });

  it("refuses an edit that changed timing when its ops weren't saved or can't be replayed exactly", () => {
    const from = base();
    const onto = applyOps(from, [{ op: "rippleDelete", start: 2, end: 4 }]);
    const moved = applyOps(from, [{ op: "moveClip", clipId: "two", timelineIn: 25 }]);
    expect(() => replayHistoryEdit(from, moved, onto, null, 30)).toThrow("the timing of this edit");
    const saved = { ops: [{ op: "moveClip", clipId: "two", timelineIn: 25 }], ranges: [] } as unknown as Change;
    expect(() => replayHistoryEdit(from, moved, onto, saved, 30)).toThrow("the timing of this edit");
    // Ops that no longer produce the saved version aren't trusted.
    const stale = { ops: [{ op: "updateClip", clipId: "two", patch: { volume: 0.3 } }], ranges: [] } as unknown as Change;
    expect(() => replayHistoryEdit(from, applyOps(from, [{ op: "updateClip", clipId: "two", patch: { volume: 0.4 } }]), onto, stale, 30)).toThrow("the recorded edit");
  });

  it("still replays a cut saved with a clip of no length after it, as ripples once left", () => {
    // The clip the cut ends in runs on in the thirteenth decimal past it. The ripple used to split it there, and saved
    // what was left of its right half after the join.
    const cut: TimelineOp = { op: "rippleDelete", start: 1112.4666666666667, end: 1114.6333333333334 };
    const from = emptyTimeline("project", "Renamed");
    const one = makeMediaClip("take", 0, 1114.6333333333337 - 1019.93, 1019.93, { id: "one" });
    from.tracks[0]!.clips = [one, makeMediaClip("take", 200, 300, 1114.6333333333332, { id: "two" })];
    const [, right] = splitClip(one, cut.start, "left-over");
    const leftOver = shiftClip(trimHead(right, cut.end), cut.start - cut.end);
    expect(clipEnd(leftOver) - leftOver.timelineIn).toBeLessThan(1e-9);
    const saved = applyOps(from, [cut]);
    saved.tracks[0]!.clips.push(leftOver);
    const change = { ops: [cut], ranges: [] } as unknown as Change;
    const result = replayHistoryEdit(from, saved, { ...from, name: "Original" }, change, 30);
    expect(result.name).toBe("Original");
    expect(result.tracks[0]!.clips.map(c => c.id)).toEqual(["one", "two"]);
    expect(clipEnd(result.tracks[0]!.clips[0]!)).toBeCloseTo(cut.start, 9);
    // A saved version with footage the ops don't make is still not trusted.
    const more = structuredClone(saved);
    more.tracks[0]!.clips.push(makeMediaClip("take", 400, 400.5, 1300, { id: "extra" }));
    expect(() => replayHistoryEdit(from, more, { ...from, name: "Original" }, change, 30)).toThrow("the recorded edit");
  });
});
