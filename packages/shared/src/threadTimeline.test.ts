import { describe, expect, it } from "vitest";
import { Change, leftOutJoins, timelineDuration, timelineFromKeepRanges } from "@scarlet/timeline";
import { buildThreads } from "./threads.js";
import { changeRemovals, matchesEdit, REVISED_CHECK, threadEditList, threadTimeline } from "./threadTimeline.js";

const head = { ...timelineFromKeepRanges("project", "interview", [{ start: 0, end: 3468 }]), version: "v2" };
const earlier = { ...head, version: "v1" };
const links = [{ version: "v1", parent: null }, { version: "v2", parent: "v1" }];
const change = Change.parse({ id: "batch", projectId: "project", threadId: "request",
  fromVersion: "base", toVersion: "v1", state: "approved", description: "Tighten the interview",
  author: { type: "agent", name: "Scarlet" }, createdAt: "2026-01-01T00:00:00Z" });
function thread(changes: Change[]) { return buildThreads({ changes, notes: [], tasks: [] })[0]!; }

describe("reviewing one thread on the working interview timeline", () => {
  it("keeps 30 independent edits, preserves links through a revision, and excludes other threads and undone work", () => {
    const named = Array.from({ length: 30 }, (_, i) => {
      const start = i < 8 ? 101 : i * 100;
      return { label: "Passage " + i, range: { start, end: start + i + 1 } };
    });
    const batch = { ...change, timelineEdits: named };
    const revision = { ...change, id: "revision", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z",
      timelineEdits: [{ label: "Revised answer", range: { start: 102, end: 106 }, replaces: { changeId: batch.id, spot: 3 } }] };
    const other = { ...batch, id: "another", threadId: "separate" };
    const review = thread([batch, revision, other]);
    const edits = threadTimeline(review, head, links, () => earlier, 30);
    expect(edits).toHaveLength(30);
    expect(edits.filter(e => e.range.start === 101)).toHaveLength(7);
    expect(edits.find(e => matchesEdit(e, { changeId: batch.id, spot: 3 }))).toMatchObject({ changeId: "revision", range: { start: 102, end: 106 } });
    expect(edits.some(e => e.changeId === "another")).toBe(false);
    const undo = { ...head, version: "undo" };
    const restored = threadTimeline(review, undo, [...links, { version: "undo", parent: "v2", revertsVersion: "v2" }], () => earlier, 30);
    expect(restored).toHaveLength(30);
    expect(restored.find(e => e.spot === 3)?.range).toEqual(named[3]!.range);
  });

  it("lists an edit once when a later save of the same request names it again", () => {
    // A pass that saves the video a second time lists every edit it has made so far, not only what that save changed.
    const first = { ...change, timelineEdits: [
      { label: "Remove the delivery aside", range: { start: 99, end: 99 }, check: "Direction: what do I say?" },
      { label: "Shorten the wait", range: { start: 103, end: 103 } },
      { label: "Shorten the wait", range: { start: 240, end: 240 } }] };
    const again = { ...change, id: "refine", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z", timelineEdits: [
      { label: "Remove the delivery aside", range: { start: 99.4, end: 99.4 }, check: "Listen to the join" },
      { label: "Shorten the wait", range: { start: 103, end: 103 } },
      { label: "Shorten the wait", range: { start: 240, end: 240 } },
      { label: "Trim the restarted description", range: { start: 55, end: 55 }, check: "Edge inside a word" }] };
    const edits = threadTimeline(thread([first, again]), head, links, () => earlier, 30);
    expect(edits.map(e => [e.changeId, e.label, e.at])).toEqual([
      ["refine", "Trim the restarted description", 55], ["batch", "Remove the delivery aside", 99],
      ["batch", "Shorten the wait", 103], ["batch", "Shorten the wait", 240]]);
    // One edit to check where the two saves named one, with the latest reason to look.
    expect(edits.filter(e => e.check).map(e => [e.check, e.reviewChangeId ?? e.changeId])).toEqual([
      ["Edge inside a word", "refine"], ["Listen to the join", "refine"]]);
    // The same words somewhere else in the video are another edit, and so are two of one save's own.
    const elsewhere = { ...again, timelineEdits: [{ label: "Shorten the wait", range: { start: 500, end: 500 } }] };
    expect(threadTimeline(thread([first, elsewhere]), head, links, () => earlier, 30)).toHaveLength(4);
    const close = { ...change, timelineEdits: [{ label: "Shorten the wait", range: { start: 103, end: 103 } }, { label: "Shorten the wait", range: { start: 103.5, end: 103.5 } }] };
    expect(threadTimeline(thread([close]), head, links, () => earlier, 30)).toHaveLength(2);
  });

  it("translates surviving footage after an earlier ripple and keeps close dialogue joins distinct on older projects", () => {
    const afterRipple = { ...timelineFromKeepRanges("project", "interview", [{ start: 5, end: 3468 }]), version: "v2" };
    const prior = { ...change, ranges: [{ start: 19, end: 22 }] };
    expect(threadTimeline(thread([prior]), afterRipple, links, () => earlier, 30)[0]?.range).toEqual({ start: 14, end: 17 });
    const reasons = [{ start: 1, end: 1.5, reason: "False start" }, { start: 2, end: 2.5, reason: "Long pause" }];
    const cuts = { ...change, toVersion: head.version, ranges: [{ start: 1, end: 1.5 }], cutReasons: reasons,
      ops: reasons.map(({ start, end }) => ({ op: "rippleDelete", start, end })).reverse() };
    const result = threadTimeline(thread([cuts]), head, links, () => earlier, 30);
    expect(result.map(e => [e.at, e.label])).toEqual([[1, "False start"], [1.5, "Long pause"]]);
    expect(result.map(e => e.beforeCut)).toEqual(reasons.map(({ start, end }) => ({
      version: cuts.fromVersion, removed: { start, end },
    })));
    expect(result.every(e => e.range.start < e.range.end)).toBe(true);
  });

  it("reads a cut named by the footage around its join as a cut, with the footage it removed", () => {
    // Named as the tool asks: the playback either side of the join, which is footage that stayed.
    const gulp = { ...change, toVersion: head.version, ops: [{ op: "rippleDelete", start: 584.05, end: 585.6 }],
      timelineEdits: [{ label: "Cut the gulp gap", range: { start: 583.3, end: 584.8 }, check: "Jump cut on the camera" }] };
    const [edit] = threadTimeline(thread([gulp]), head, links, () => earlier, 30);
    expect(edit).toMatchObject({ kind: "cut", at: 584.05, check: "Jump cut on the camera",
      beforeCut: { version: gulp.fromVersion, removed: { start: 584.05, end: 585.6 } } });

    // The fade that smooths a join moves nothing in time, so the cut still knows what it removed.
    const smoothed = { ...gulp, ops: [{ op: "updateClip", clipId: "cam", patch: { audioFadeOut: 0.03 } }, ...gulp.ops] };
    expect(threadEditList(thread([smoothed]))[0]).toMatchObject({ kind: "cut", beforeCut: { removed: { start: 584.05, end: 585.6 } } });
    // A step that moves footage leaves the removal's times in no saved version's clock.
    const moved = { ...gulp, ops: [{ op: "updateClip", clipId: "cam", patch: { timelineIn: 2 } }, ...gulp.ops] };
    expect(threadEditList(thread([moved]))[0]!.beforeCut).toBeUndefined();

    // Two close cuts each take the join nearest their middle. Later ops come first, in the clock before any of them.
    const close = { ...change, toVersion: head.version,
      ops: [{ op: "rippleDelete", start: 11, end: 12 }, { op: "rippleDelete", start: 10, end: 10.5 }],
      timelineEdits: [{ label: "Second", range: { start: 9.8, end: 11.2 } }, { label: "First", range: { start: 9.2, end: 10.8 } }] };
    expect(threadEditList(thread([close])).map(e => [e.label, e.range.start, e.beforeCut?.removed])).toEqual([
      ["First", 10, { start: 10, end: 10.5 }], ["Second", 10.5, { start: 11, end: 12 }]]);

    // One edit that made several cuts has no single join: it stays the passage it was named as.
    const several = { ...close, timelineEdits: [{ label: "Tighten the answer", range: { start: 9, end: 12 } }] };
    expect(threadEditList(thread([several]))[0]).toMatchObject({ kind: "cut", range: { start: 9, end: 12 } });
    expect(threadEditList(thread([several]))[0]!.beforeCut).toBeUndefined();
  });

  it("reads what a save of the whole video removed and put back from the versions either side of it", () => {
    // Scarlet saved the finished video, not the steps that made it: the change names its edits and has no ops.
    const cut = { ...timelineFromKeepRanges("project", "interview", [{ start: 0, end: 99 }, { start: 101, end: 3468 }]), version: "v1" };
    const refined = { ...timelineFromKeepRanges("project", "interview", [{ start: 0, end: 200 }, { start: 201, end: 3468 }]), version: "v2" };
    const versions: Record<string, typeof cut> = { base: { ...earlier, version: "base" }, v1: cut, v2: refined };
    const read = (version: string) => versions[version];
    const all = [{ version: "base", parent: null }, ...links];
    const pass = { ...change, timelineEdits: [{ label: "Remove the delivery aside", range: { start: 99, end: 99 }, check: "Direction: what do I say?" }] };
    expect(threadTimeline(thread([pass]), cut, all, read, 30)).toMatchObject([{ kind: "cut", at: 99,
      beforeCut: { version: "base", removed: { start: 99, end: 101 } } }]);

    // A later save put the aside back and cut a cough. The video came out longer, and each edit is still what it did.
    const refine = { ...change, id: "refine", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z", timelineEdits: [
      { label: "Keep the complete aside", range: { start: 99, end: 101 } },
      { label: "Cut the cough", range: { start: 200.02, end: 200.02 } },
      { label: "Tighten the score delivery", range: { start: 869, end: 869 } }] };
    const edits = threadTimeline(thread([refine]), refined, all, read, 30);
    expect(edits.map(e => [e.label, e.kind, e.at, e.beforeCut])).toEqual([
      ["Keep the complete aside", "restore", undefined, undefined],
      // Named a frame off its join, it sits on the join. What it removed is in the clock of the version before it.
      ["Cut the cough", "cut", 200, { version: "v1", removed: { start: 198, end: 199 } }],
      ["Tighten the score delivery", "other", 869, undefined]]);

    // A later save that names the first save's cut, to say it needs a look, moved nothing there: it is that cut.
    const flag = { ...change, id: "flag", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z", timelineEdits: [
      { label: "Check the aside's join", range: { start: 99, end: 99 }, check: "Tight speech join", summary: "Removed the aside." }] };
    const kept = { ...refined, tracks: cut.tracks };
    const flagged = threadTimeline(thread([pass, flag]), kept, all, v => v === "v2" ? kept : read(v), 30);
    expect(flagged).toMatchObject([{ changeId: "batch", label: "Remove the delivery aside", kind: "cut", at: 99,
      check: "Tight speech join", reviewChangeId: flag.id, summary: "Removed the aside.", beforeCut: { version: "base", removed: { start: 99, end: 101 } } }]);
    expect(flagged).toHaveLength(1);
  });

  it("shows the footage a change left out as it built the video from the pieces to keep, each stretch a cut", () => {
    // Scarlet built the video by placing what to keep, so what came between was never on a timeline. The engine read
    // it when the change was applied, with a version that plays it (2026-11-12: a first pass on a screen and a camera).
    const built = { ...timelineFromKeepRanges("project", "interview", [{ start: 10, end: 100 }, { start: 130, end: 200 }, { start: 201, end: 300 }, { start: 320, end: 400 }]), version: "v1" };
    const found = leftOutJoins({ ...built, tracks: built.tracks.map(t => ({ ...t, clips: [] })) }, built)!;
    const full = { ...found.original, version: "full" };
    const versions: Record<string, typeof built> = { v1: built, full };
    const clip = { op: "addClip" as const, trackId: "v1", clip: built.tracks[0]!.clips[0]! };
    const pass = { ...change, ops: [clip], leftOut: { version: "full", joins: found.joins }, timelineEdits: [
      // Named by the moment either side of its join, twice over, and once somewhere nothing was left out.
      { label: "Cut the crew handoff", range: { start: 89.8, end: 90.2 }, check: "Direction: crew handoff", summary: "Cut the note about the sound." },
      { label: "Cut the second reveal instruction", range: { start: 89.8, end: 90.2 }, check: "Direction: hold", summary: "Cut “Don’t show this yet”." },
      { label: "Keep the title beat", range: { start: 40, end: 42 }, check: "Hold" }] };
    const edits = threadTimeline(thread([pass]), built, [{ version: "v1", parent: null }], v => versions[v], 30);
    expect(edits.map(e => [e.label, e.kind, e.at, e.beforeCut?.removed, e.check])).toEqual([
      // The start of the recording and the stretches Scarlet named nothing for, each by what it is.
      ["Cut", "cut", 0, { start: 0, end: 10 }, undefined],
      ["Keep the title beat", "other", undefined, undefined, "Hold"],
      // One join, one cut: the second thing Scarlet named on it is said on the same row.
      ["Cut the crew handoff", "cut", 90, { start: 100, end: 130 }, "Direction: crew handoff"],
      ["Cut", "cut", 160, { start: 200, end: 201 }, undefined],
      ["Cut", "cut", 259, { start: 300, end: 320 }, undefined]]);
    expect(edits[2]!.summary).toBe("Cut the note about the sound. Cut “Don’t show this yet”.");
    expect(edits.every(e => !e.beforeCut || e.beforeCut.version === "full")).toBe(true);
    expect(new Set(edits.map(e => e.spot)).size).toBe(edits.length);
    // The figures add up: what the cuts say came out is the recording played in full, less the video.
    const out = edits.reduce((sum, e) => sum + (e.beforeCut ? e.beforeCut.removed.end - e.beforeCut.removed.start : 0), 0);
    expect(out).toBeCloseTo(timelineDuration(full) - timelineDuration(built));
    // Before the engine has read it, the change lists what Scarlet named, as it did.
    expect(threadTimeline(thread([{ ...pass, leftOut: undefined }]), built, [{ version: "v1", parent: null }], v => versions[v], 30)).toHaveLength(3);
  });

  it("leaves out the calls the editor skipped when a pass was applied onto an edit that had moved", () => {
    const cut = (version: string, ...keep: [number, number][]) =>
      ({ ...timelineFromKeepRanges("project", "interview", keep.map(([start, end]) => ({ start, end }))), version });
    // Staged cuts are saved last first, in the clock of the version they cut. The first two touch, so the review counts them as one call.
    const reasons = [{ start: 2, end: 3, reason: "First try" }, { start: 3, end: 4, reason: "Second try" },
      { start: 8, end: 9, reason: "Long pause" }, { start: 12, end: 13, reason: "Repeated aside" }];
    const staged = { ...change, toVersion: "staged", cutReasons: reasons,
      ops: reasons.map(({ start, end }) => ({ op: "rippleDelete", start, end })).reverse() };
    const versions: Record<string, typeof head> = { staged: cut("staged", [0, 2], [4, 8], [9, 12], [13, 20]), v1: cut("v1", [0, 18]) };
    // The editor trimmed the end before applying, then skipped the first call and the last. A pass applied onto an edit
    // that moved keeps the numbers of the calls skipped, not a list of its joins.
    const applied = cut("v2", [0, 8], [9, 18]);
    const window = { spot: { start: 8, end: 8 }, range: { start: 6.5, end: 9.5 }, beforeRange: { start: 6.5, end: 10.5 } };
    const pass = { ...staged, restoredCuts: [0, 2], appliedOnto: "v1", appliedVersion: "v2", appliedWindows: [window] };
    const listed = threadTimeline(thread([pass]), applied, links, version => versions[version], 30);
    expect(listed.map(e => [e.label, e.at, e.kind, e.beforeCut])).toEqual([
      ["Long pause", 8, "cut", { version: pass.fromVersion, removed: { start: 8, end: 9 } }]]);
    expect(changeRemovals(pass)?.removed).toEqual([{ start: 8, end: 9 }]);
    // With every call skipped nothing came out, and nothing is listed.
    const kept = { ...staged, restoredCuts: [0, 1, 2], appliedOnto: "v2", appliedVersion: "v2", appliedWindows: [] };
    expect(threadEditList(thread([kept]))).toEqual([]);

    // A change whose edits the agent named doesn't say which cut each name is for. Its list is what was applied.
    const named = { ...pass, cutReasons: undefined, restoredCuts: [1],
      ops: [{ op: "rippleDelete", start: 12, end: 13 }, { op: "rippleDelete", start: 8, end: 9 }],
      timelineEdits: [{ label: "Drop the long pause", range: { start: 8, end: 8 } }, { label: "Drop the aside", range: { start: 11, end: 11 } }] };
    expect(threadTimeline(thread([named]), applied, links, version => versions[version], 30).map(e => [e.label, e.at, e.kind])).toEqual([
      [named.description, 8, "cut"]]);
  });
});

describe("listing a thread's edits in the chat", () => {
  it("numbers edits in timeline order, folds a revision into the edit it replaces, and keeps the reason to check", () => {
    const batch = { ...change, timelineEdits: [
      { label: "Raise narration volume", range: { start: 14, end: 18 }, check: "Room tone comes up with it",
        summary: "Raised the narration 4 dB, which brings the room tone up with it" },
      { label: "Trim the false start", range: { start: 1.8, end: 1.8 } },
    ] };
    const revision = { ...change, id: "revision", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z",
      timelineEdits: [{ label: "Raise narration volume", range: { start: 14, end: 18 }, replaces: { changeId: batch.id, spot: 0 } }] };
    const listed = threadEditList(thread([batch, revision]));
    expect(listed.map(e => e.label)).toEqual(["Trim the false start", "Raise narration volume"]);
    expect(listed[1]).toMatchObject({ changeId: "revision", previous: [{ changeId: batch.id, spot: 0 }] });
    // The edit was the editor's to check and they sent it back, so its new version is theirs to check too.
    expect(listed[1]!.check).toBe(REVISED_CHECK);
    // A revision of an edit Scarlet didn't flag asks for a look only if Scarlet flags it.
    const plain = { ...revision, id: "plain", timelineEdits: [{ label: "Trim the false start", range: { start: 1.8, end: 1.8 }, replaces: { changeId: batch.id, spot: 1 } }] };
    expect(threadEditList(thread([batch, plain]))[0]).toMatchObject({ changeId: "plain" });
    expect(threadEditList(thread([batch, plain]))[0]!.check).toBeUndefined();
    // A reason Scarlet gives the new version is the one it carries, also when that version is revised again.
    const flaggedAgain = { ...revision, timelineEdits: [{ ...revision.timelineEdits[0]!, check: "Peaks at the laugh" }] };
    expect(threadEditList(thread([batch, flaggedAgain]))[1]!.check).toBe("Peaks at the laugh");
    const third = { ...revision, id: "third", fromVersion: "v2", toVersion: "v3", createdAt: "2026-01-03T00:00:00Z",
      timelineEdits: [{ label: "Raise narration volume", range: { start: 14, end: 18 }, replaces: { changeId: "revision", spot: 0 } }] };
    expect(threadEditList(thread([batch, revision, third]))[1]).toMatchObject({ changeId: "third", check: REVISED_CHECK });
    expect(threadEditList(thread([batch]))[1]).toMatchObject({ check: "Room tone comes up with it",
      summary: "Raised the narration 4 dB, which brings the room tone up with it" });
    // A revision's card says what the revision did, not what the edit it replaced did.
    expect(listed[1]!.summary).toBeUndefined();
  });
});
