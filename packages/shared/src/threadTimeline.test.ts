import { describe, expect, it } from "vitest";
import { Change, emptyTimeline, leftOutJoins, timelineDuration, timelineFromKeepRanges } from "@scarlet/timeline";
import { buildThreads, type Thread } from "./threads.js";
import { Task } from "./api.js";
import { changeRemovals, matchesEdit, namedTimelineEdits, REVISED_CHECK, threadEditList, threadTimeline } from "./threadTimeline.js";

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

  it("reads each cut an agent named to the second as the cut it made, wherever its join falls between hundredths", () => {
    // A fit-length request named its five cuts to the hundredth of a second, and the joins its removals made fell between
    // those: three of them listed as edits that weren't cuts, and the request said it made edits, not what it took out (2026-11-15).
    const removals = [{ start: 60.1234, end: 70.4567 }, { start: 120.3333, end: 135.6789 }, { start: 300.1111, end: 318.2222 }];
    const cuts = { ...change, toVersion: head.version, ops: removals.map(({ start, end }) => ({ op: "rippleDelete", start, end })).reverse(),
      timelineEdits: [{ label: "Cut the aside", range: { start: 60.12, end: 60.12 } }, { label: "Cut the walkthrough", range: { start: 110, end: 110 } },
        { label: "Cut the side note", range: { start: 274.43, end: 274.43 } }] };
    const edits = threadTimeline(thread([cuts]), head, links, () => earlier, 30);
    expect(edits.map(e => [e.label, e.kind, e.beforeCut?.removed])).toEqual([
      ["Cut the aside", "cut", removals[0]], ["Cut the walkthrough", "cut", removals[1]], ["Cut the side note", "cut", removals[2]]]);
    // A cut named by the seconds around the join a point named a hair off it already took doesn't take it too: the
    // footage is counted once.
    const both = { ...cuts, timelineEdits: [...cuts.timelineEdits, { label: "Tighten the opening", range: { start: 59, end: 61.5 } }] };
    const once = threadTimeline(thread([both]), head, links, () => earlier, 30).filter(e => e.beforeCut?.removed.start === removals[0]!.start);
    expect(once.map(e => e.label)).toEqual(["Cut the aside"]);
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

  it("lists a flagged edit once when its own run names it again on the same footage in other words", () => {
    // Matt's pass named the cube solve it held three times, each save in new words, and keeping it brought up the next (2026-11-16).
    const save = (id: string, at: string, label: string, check: string, taskId = "run") => ({ ...change, id, taskId, createdAt: at,
      fromVersion: "v1", toVersion: "v1", timelineEdits: [{ label, range: { start: 830.77, end: 832.83 }, check }] });
    const first = save("round4", "2026-01-02T00:00:00Z", "Kept the cube solve animation", "The cube animates for 2.1 seconds before Matt speaks.");
    const again = save("round5", "2026-01-03T00:00:00Z", "Held the cube solve animation", "The cube animates for 2.1 seconds before Matt speaks.");
    const reworded = save("round6", "2026-01-04T00:00:00Z", "Held the cube solve", "The solve animation plays for 2.1 seconds before Matt speaks.");
    const edits = threadTimeline(thread([first, again, reworded]), head, links, () => earlier, 30);
    // One edit, under the identity the editor kept, with the latest words for why to look.
    expect(edits.map(e => [e.changeId, e.spot, e.reviewRef, e.check])).toEqual([
      ["round4", 0, undefined, "The solve animation plays for 2.1 seconds before Matt speaks."]]);
    // A later request's doubt about it is new, and so is one about different footage.
    const later = save("revise", "2026-01-05T00:00:00Z", "Kept the cube solve animation", "Matt starts talking over the solve.", "another");
    expect(threadTimeline(thread([first, later]), head, links, () => earlier, 30).map(e => e.reviewRef))
      .toEqual([{ changeId: "revise", spot: 0 }]);
    const longer = { ...reworded, timelineEdits: [{ ...reworded.timelineEdits[0]!, range: { start: 830.77, end: 834 } }] };
    expect(threadTimeline(thread([first, longer]), head, links, () => earlier, 30)).toHaveLength(2);
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

  it("flags an applied dialogue cut that carries a reason to check, and only that one", () => {
    const reasons = [{ start: 1, end: 1.5, reason: "False start", check: "A removed word starts right after the cut: watch and listen at the join." },
      { start: 2, end: 2.5, reason: "Repeated line" }];
    const cuts = { ...change, toVersion: head.version, ranges: [{ start: 1, end: 1.5 }], cutReasons: reasons,
      ops: reasons.map(({ start, end }) => ({ op: "rippleDelete", start, end })).reverse() };
    const result = threadTimeline(thread([cuts]), head, links, () => earlier, 30);
    expect(result.map(e => [e.label, e.check])).toEqual([["False start", reasons[0]!.check], ["Repeated line", undefined]]);
  });

  it("drops a cut whose footage a later save put back, and moves its reason to look to the cut that is there now", () => {
    // A pause trim took out “five point five”; a later cut was made beside it; a save of the whole timeline then put the
    // words back without naming the trim. The flag was raised on the last version, about the join that is left.
    const keep = (version: string, ranges: Array<{ start: number; end: number }>) => ({ ...timelineFromKeepRanges("project", "interview", ranges), version });
    const base = keep("base", [{ start: 0, end: 100 }]);
    const trimmed = keep("v1", [{ start: 0, end: 10 }, { start: 11, end: 100 }]);
    const both = keep("v2", [{ start: 0, end: 10 }, { start: 11, end: 20 }, { start: 21, end: 100 }]);
    const restored = keep("v3", [{ start: 0, end: 20 }, { start: 21, end: 100 }]);
    const versions = new Map([base, trimmed, both, restored].map(tl => [tl.version, tl]));
    const lineage = [{ version: "base", parent: null }, { version: "v1", parent: "base" }, { version: "v2", parent: "v1" }, { version: "v3", parent: "v2" }];
    const cut = (id: string, from: string, to: string, start: number, end: number, summary: string, createdAt: string) => ({ ...change, id, fromVersion: from, toVersion: to,
      createdAt, ops: [{ op: "rippleDelete", start, end }], ranges: [{ start, end: start }], cutReasons: [{ start, end, reason: summary, summary, kind: "pause" }] });
    const trim = { ...cut("trim", "base", "v1", 10, 11, "Tightened the pause", "2026-01-01T00:00:00Z"),
      flags: [{ spot: 0, check: "Listen to ‘and and’.", taskId: "pass", at: "2026-01-01T00:05:00Z", location: { version: "v3", range: { start: 19, end: 20.5 } } }] };
    const beside = cut("beside", "v1", "v2", 19, 20, "Cut the wait", "2026-01-01T00:01:00Z");
    const pass = Task.parse({ id: "pass", projectId: "project", kind: "edit", agent: "codex", instruction: "pass", state: "done",
      createdBy: { type: "human", name: "Editor" }, createdAt: "2026-01-01T00:00:00Z", context: { threadId: "request" } });
    const of = (changes: object[]) => buildThreads({ changes: changes.map(item => Change.parse(item)), notes: [], tasks: [pass] })[0]!;
    const listed = threadTimeline(of([trim, beside]), restored, lineage, version => versions.get(version), 30);
    expect(listed.map(e => [e.changeId, e.at, e.check])).toEqual([["beside", 20, "Listen to ‘and and’."]]);
    // Keeping it answers the flag that was raised, under that flag's own identity.
    expect(listed[0]).toMatchObject({ reviewRef: { changeId: "trim", spot: 0 }, beforeCut: { version: "v1", removed: { start: 19, end: 20 } } });
    // With no cut left at the flagged place, the flag stays as a passage to check, not as a cut.
    const whole = keep("v3", [{ start: 0, end: 100 }]);
    const alone = threadTimeline(of([trim]), whole, [{ version: "base", parent: null }, { version: "v1", parent: "base" }, { version: "v3", parent: "v1" }],
      version => version === "v3" ? whole : versions.get(version), 30);
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatchObject({ changeId: "trim", kind: "other", check: "Listen to ‘and and’." });
    expect(alone[0]).not.toHaveProperty("beforeCut");
    expect(alone[0]).not.toHaveProperty("at");
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

  it("reads a later save made of steps that rolled a cut's join as that cut, on one track or on all", () => {
    // A pass cut a false start, then listened back and saved again with steps that rolled the join 0.3 s on: its row
    // “Extend end of ‘subscription.’” showed beside the cut, which stayed flagged and played its old clipped join (2026-11-20).
    const keep = (version: string, media: string, ...ranges: Array<[number, number]>) =>
      ({ ...timelineFromKeepRanges("project", media, ranges.map(([start, end]) => ({ start, end }))), version });
    const camera = { base: keep("base", "camera", [0, 3468]), v1: keep("v1", "camera", [0, 99], [101, 3468]), v2: keep("v2", "camera", [0, 99.3], [101.3, 3468]) };
    const all = ["base", "v1", "v2"].map((version, i, list) => ({ version, parent: list[i - 1] ?? null }));
    const pass = { ...change, id: "batch", fromVersion: "base", toVersion: "v1", ops: [{ op: "rippleDelete" as const, start: 99, end: 101 }],
      timelineEdits: [{ label: "Cut the false start", range: { start: 99, end: 99 }, check: "Tight outgoing edge" }] };
    const roll = { ...change, id: "roll", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z",
      ops: [{ op: "updateClip" as const, clipId: camera.v1.tracks[0]!.clips[0]!.id, patch: { sourceOut: 99.3 } }],
      leftOut: { version: "base", joins: [{ at: 99.3, removed: { start: 99.3, end: 101.3 } }] },
      timelineEdits: [{ label: "Extend end of the word", range: { start: 99.3, end: 99.3 }, summary: "Let the word finish." }] };
    const one = threadTimeline(thread([pass, roll]), camera.v2, all, v => camera[v as keyof typeof camera], 30);
    expect(one.map(e => [e.changeId, e.label, e.kind, e.at, e.check, e.summary])).toEqual([["batch", "Cut the false start", "cut", 99.3, "Tight outgoing edge", "Let the word finish."]]);
    expect(one[0]!.beforeCut!.removed.start).toBeCloseTo(99.3);
    expect(one[0]!.beforeCut!.removed.end).toBeCloseTo(101.3);

    // A screen recording above the camera kept its join where the cut put it, and the camera's rolled a frame earlier:
    // the join named is the camera's, where the screen plays straight through, and the screen's says what the cut removes.
    const frame = 1 / 30;
    const both = (version: string, screen: Array<[number, number]>, cam: Array<[number, number]>) =>
      ({ ...keep(version, "camera", ...cam), tracks: [{ ...keep(version, "screen", ...screen).tracks[0]!, id: "screen" }, ...keep(version, "camera", ...cam).tracks] });
    const cut: Array<[number, number]> = [[0, 99], [101, 3468]];
    const layered = { base: both("base", [[0, 3468]], [[0, 3468]]), v1: both("v1", cut, cut), v2: both("v2", cut, [[0, 99 - frame], [101 - frame, 3468]]) };
    const nudge = { ...roll, leftOut: { version: "base", joins: [{ at: 99 - frame, removed: { start: 99 - frame, end: 101 - frame } }] },
      timelineEdits: [{ label: "Clean the clipped b", range: { start: 98.97, end: 98.97 }, summary: "Rolled the join back a frame." }] };
    const two = threadTimeline(thread([pass, nudge]), layered.v2, all, v => layered[v as keyof typeof layered], 30);
    expect(two.map(e => [e.changeId, e.label, e.check])).toEqual([["batch", "Cut the false start", "Tight outgoing edge"]]);
  });

  it("reads a later save that only moved a cut's join as that cut, revised", () => {
    const keep = (version: string, ...ranges: Array<[number, number]>) =>
      ({ ...timelineFromKeepRanges("project", "interview", ranges.map(([start, end]) => ({ start, end }))), version });
    const versions: Record<string, ReturnType<typeof keep>> = {
      base: keep("base", [0, 3468]),
      v1: keep("v1", [0, 99], [101, 3468]),
      // Listening back, the pass started 0.2 s earlier after the join, then let the line before it run 0.3 s longer,
      // then took the breath after it out as well.
      v2: keep("v2", [0, 99], [100.8, 3468]),
      v3: keep("v3", [0, 99.3], [100.8, 3468]),
      v4: keep("v4", [0, 99.3], [101.5, 3468]),
    };
    const read = (version: string) => versions[version];
    const all = ["base", "v1", "v2", "v3", "v4"].map((version, i, list) => ({ version, parent: list[i - 1] ?? null }));
    const save = (id: string, fromVersion: string, toVersion: string, timelineEdits: NonNullable<Change["timelineEdits"]>) =>
      ({ ...change, id, fromVersion, toVersion, createdAt: `2026-01-0${toVersion[1]}T00:00:00Z`, timelineEdits });
    const pass = save("batch", "base", "v1", [{ label: "Remove the delivery aside", range: { start: 99, end: 99 } }]);
    const right = save("right", "v1", "v2", [{ label: "Keep the price whole", range: { start: 99, end: 99 },
      check: "Listen for the start of “fifteen”", summary: "Started in the quiet before “fifteen.”" }]);
    const left = save("left", "v2", "v3", [{ label: "Finish the model number", range: { start: 99.3, end: 99.3 }, summary: "Kept the final “three.”" }]);
    const more = save("more", "v3", "v4", [{ label: "Close the breath", range: { start: 99.3, end: 99.3 }, summary: "Took out the breath after it." }]);

    // Footage put back on the right of the join: the cut is still the pass's, at the same place, and removes less.
    const once = threadTimeline(thread([pass, right]), versions.v2!, all, read, 30);
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ changeId: "batch", label: "Remove the delivery aside", kind: "cut", at: 99,
      check: "Listen for the start of “fifteen”", reviewChangeId: "right", summary: "Started in the quiet before “fifteen.”",
      // Its reason to look is the later save's, so a Keep is recorded under that save's edit.
      reviewRef: { changeId: "right", spot: 0 }, beforeCut: { version: "base" } });
    expect(once[0]!.beforeCut!.removed.start).toBeCloseTo(99);
    expect(once[0]!.beforeCut!.removed.end).toBeCloseTo(100.8);

    // Put back on the left, the join moves along with it. Taking more out there is the same cut again.
    const twice = threadTimeline(thread([pass, right, left]), versions.v3!, all, read, 30);
    expect(twice.map(e => [e.changeId, e.kind, e.at, e.summary])).toEqual([["batch", "cut", 99.3, "Kept the final “three.”"]]);
    const thrice = threadTimeline(thread([pass, right, left, more]), versions.v4!, all, read, 30);
    expect(thrice.map(e => [e.changeId, e.kind, e.at, e.reviewChangeId])).toEqual([["batch", "cut", 99.3, "more"]]);
    expect(thrice[0]!.beforeCut!.removed.start).toBeCloseTo(99.3);
    expect(thrice[0]!.beforeCut!.removed.end).toBeCloseTo(101.5);

    // Put back whole, the cut is not in the video and neither is the footage an addition to it.
    const whole = { ...versions.base!, version: "v2" };
    const undo = save("undo", "v1", "v2", [{ label: "Keep the complete aside", range: { start: 99, end: 101 } }]);
    expect(threadTimeline(thread([pass, undo]), whole, all.slice(0, 3), v => v === "v2" ? whole : read(v), 30)).toEqual([]);

    // With no cut of this request at the join, footage named at a point is still a stretch of the video.
    const alone = threadTimeline(thread([right]), versions.v2!, all, read, 30);
    expect(alone).toMatchObject([{ changeId: "right", kind: "restore" }]);
    expect(alone[0]!.at).toBeUndefined();
    expect(alone[0]!.range.start).toBeCloseTo(99);
    expect(alone[0]!.range.end).toBeCloseTo(99.2);

    // A save of the whole video that took footage out somewhere else, with a punch-in named on the cut's join, didn't
    // move that join: the punch-in is an edit of its own, and the cut keeps its own sentence. What it took out
    // elsewhere and named nothing for is a cut, by what it is.
    const elsewhere = keep("v2", [0, 99], [101, 200], [210, 3468]);
    const punch = save("punch", "v1", "v2", [{ label: "Punch in", range: { start: 99, end: 99 }, summary: "Punched in on the answer." }]);
    const named = { ...pass, timelineEdits: [{ label: "Remove the delivery aside", range: { start: 99, end: 99 }, summary: "Took out the aside." }] };
    const both = threadTimeline(thread([named, punch]), elsewhere, all.slice(0, 3), v => v === "v2" ? elsewhere : read(v), 30);
    expect(both.map(e => [e.changeId, e.label, e.summary])).toEqual([["batch", "Remove the delivery aside", "Took out the aside."],
      ["punch", "Punch in", "Punched in on the answer."], ["punch", "Cut", undefined]]);
  });

  it("lists every stretch a save of the whole video took out, the ones Scarlet named no edit for as cuts", () => {
    // A first pass rewrote the timeline to tighten the dialogue: it named one edit and took footage out in three places
    // (2026-11-16: ten edits named for some two hundred joins, and the rest could not be opened).
    const keep = (version: string, ...ranges: Array<[number, number]>) =>
      ({ ...timelineFromKeepRanges("project", "interview", ranges.map(([start, end]) => ({ start, end }))), version });
    const versions: Record<string, ReturnType<typeof keep>> = {
      base: keep("base", [0, 3468]),
      v1: keep("v1", [0, 99], [101, 200], [210, 300], [300.5, 3468]),
      // A second save, naming nothing there, took 0.3 s more out before the first of those joins and cut a breath at 500.
      v2: keep("v2", [0, 98.7], [101, 200], [210, 300], [300.5, 512.5], [513, 3468]),
    };
    const read = (version: string) => versions[version];
    const all = ["base", "v1", "v2"].map((version, i, list) => ({ version, parent: list[i - 1] ?? null }));
    const save = (id: string, fromVersion: string, toVersion: string, timelineEdits: NonNullable<Change["timelineEdits"]>) =>
      ({ ...change, id, fromVersion, toVersion, createdAt: `2026-01-0${toVersion[1]}T00:00:00Z`, timelineEdits });
    const pass = save("batch", "base", "v1", [{ label: "Tighten the watch demo", range: { start: 180, end: 205 }, summary: "Cut the wait for the page." }]);
    const edits = threadTimeline(thread([pass]), versions.v1!, all, read, 30);
    expect(edits.map(e => [e.label, e.kind, e.at, e.beforeCut?.removed])).toEqual([
      ["Cut", "cut", 99, { start: 99, end: 101 }],
      // The join inside the stretch Scarlet named is that edit's, and is counted once.
      ["Tighten the watch demo", "cut", 198, { start: 200, end: 210 }],
      ["Cut", "cut", 288, { start: 300, end: 300.5 }]]);
    expect(edits.every(e => e.beforeCut?.version === "base")).toBe(true);
    expect(new Set(edits.map(e => e.spot)).size).toBe(edits.length);
    const out = edits.reduce((sum, e) => sum + (e.beforeCut!.removed.end - e.beforeCut!.removed.start), 0);
    expect(out).toBeCloseTo(timelineDuration(versions.base!) - timelineDuration(versions.v1!));

    // The second save's unnamed trim at the first join is that cut, moved; its new cut is a row of its own.
    const tidy = save("tidy", "v1", "v2", [{ label: "Hold the result", range: { start: 700, end: 705 } }]);
    const after = threadTimeline(thread([pass, tidy]), versions.v2!, all, read, 30);
    expect(after.map(e => [e.changeId, e.label])).toEqual([["batch", "Cut"], ["batch", "Tighten the watch demo"],
      ["batch", "Cut"], ["tidy", "Cut"], ["tidy", "Hold the result"]]);
    expect(after.filter(e => e.label === "Cut").every(e => e.kind === "cut" && e.beforeCut)).toBe(true);
    expect(after[0]!.beforeCut!.removed.start).toBeCloseTo(98.7);
    expect(after[0]!.beforeCut!.removed.end).toBeCloseTo(101);
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
  it("keeps sibling reasons and replaces the revised edit's reason", () => {
    const sibling = "Viewers need time to read both scores.";
    const original = "The false start interrupts the score.";
    const revised = "The fade preserves the last syllable of the score.";
    const batch = Change.parse({ ...change, timelineEdits: [
      { label: "Hold the scorecard", range: { start: 9, end: 13 }, summary: "Held the scorecard.", reason: sibling },
      { label: "Mute the false start", range: { start: 10, end: 10.1 }, summary: "Muted the false start.", reason: original },
    ] });
    const revision = Change.parse({ ...change, id: "revision", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z",
      timelineEdits: [{ label: "Fade the false start", range: { start: 10, end: 10.1 }, summary: "Faded the false start.", reason: revised,
        replaces: { changeId: batch.id, spot: 1 } }] });
    expect(threadEditList(thread([batch])).map(edit => edit.reason)).toEqual([sibling, original]);
    const edits = threadTimeline(thread([batch, revision]), head, links, () => earlier, 30);
    expect(edits.map(edit => [edit.summary, edit.reason, edit.check])).toEqual([
      ["Held the scorecard.", sibling, undefined], ["Faded the false start.", revised, undefined],
    ]);
    expect(matchesEdit(edits[1]!, { changeId: batch.id, spot: 1 })).toBe(true);
  });

  it("lists an edit the editor rejected under its own words, marked rejected, with nothing left to check", () => {
    const batch = Change.parse({ ...change, timelineEdits: [
      { label: "Hold the scorecard", range: { start: 9, end: 13 }, summary: "Held the scorecard." },
      { label: "Mute the false start", range: { start: 10, end: 10.1 }, summary: "Muted the false start.", check: "Listen to the last syllable" },
    ] });
    const back = { ...change, id: "back", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-02T00:00:00Z",
      timelineEdits: [{ label: "Restored the false start", range: { start: 10, end: 10.1 }, reason: "Put back what the rejected edit changed.",
        replaces: { changeId: batch.id, spot: 1 } }] };
    // The engine's own put-back says it is a rejection; one Scarlet made is known by the request the × sent.
    const rows = (changes: Change[], tasks: Thread["tasks"] = []) => threadTimeline({ ...thread(changes), tasks }, head, links, () => earlier, 30)
      .map(edit => [edit.label, edit.summary, edit.check, edit.rejected]);
    const rejected = [["Hold the scorecard", "Held the scorecard.", undefined, undefined], ["Mute the false start", "Muted the false start.", undefined, true]];
    // The engine names its put-back as the row read when the editor rejected it, and the row keeps those words.
    const engine = { ...back, rejects: true, timelineEdits: [{ ...back.timelineEdits[0]!, label: "Mute the false start after “score”" }] };
    expect(rows([batch, Change.parse(engine)])).toEqual([rejected[0], ["Mute the false start after “score”", "Muted the false start.", undefined, true]]);
    const asked = { id: "task_reject", instruction: "The editor rejected edit 2.", context: { message: "Reject edit" } } as Thread["tasks"][number];
    expect(rows([batch, Change.parse({ ...back, taskId: asked.id })], [asked])).toEqual(rejected);
    // The same change from a revision the editor typed is a revision: theirs to check again.
    expect(rows([batch, Change.parse(back)])[1]).toEqual(["Restored the false start", undefined, "Revised", undefined]);
  });

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

describe("a doubt a later request raises about an edit already in the video", () => {
  const run = (id: string, threadId: string) => Task.parse({ id, projectId: "project", kind: "edit", agent: "codex", instruction: id,
    state: "done", createdBy: { type: "human", name: "Editor" }, createdAt: "2026-01-01T00:00:00Z", context: { threadId } });
  const pass = { ...change, id: "pass", threadId: "dialogue", taskId: "cutting", timelineEdits: [
    { label: "Keep the list cue", range: { start: 724, end: 724 } },
    { label: "Carry the quotation into the reaction", range: { start: 724, end: 728 } }] };
  const zooms = { ...change, id: "zooms", threadId: "framing", taskId: "framing-run", fromVersion: "v1", toVersion: "v2",
    createdAt: "2026-01-02T00:00:00Z", timelineEdits: [{ label: "Frame the spreadsheet", range: { start: 623, end: 724 } }] };
  const flags = [{ spot: 1, check: "Black gap and overlapping lines", taskId: "framing-run", at: "2026-01-02T00:05:00.000Z" }];

  it("lists the edit with the request that raised it, as one that needs the editor, and leaves the one that made it as it was", () => {
    const threads = buildThreads({ changes: [{ ...pass, flags }, zooms], notes: [], tasks: [run("cutting", "dialogue"), run("framing-run", "framing")] });
    const framing = threads.find(t => t.id === "framing")!, dialogue = threads.find(t => t.id === "dialogue")!;
    expect(framing.flagged?.map(c => c.id)).toEqual(["pass"]);
    expect(dialogue.flagged).toBeUndefined();
    const listed = threadTimeline(framing, head, links, () => earlier, 30);
    expect(listed.map(e => [e.changeId, e.label, e.check, e.elsewhere, e.recheck])).toEqual([
      ["zooms", "Frame the spreadsheet", undefined, undefined, undefined],
      ["pass", "Carry the quotation into the reaction", "Black gap and overlapping lines", true, flags[0]!.at]]);
    expect(threadTimeline(dialogue, head, links, () => earlier, 30).map(e => e.check)).toEqual([undefined, undefined]);
  });

  it("raises it on the request's own edit, as a new doubt a Keep before it doesn't settle", () => {
    const own = { ...pass, flags: [{ ...flags[0]!, taskId: "cutting" }] };
    const [dialogue] = buildThreads({ changes: [own], notes: [], tasks: [run("cutting", "dialogue")] });
    expect(dialogue!.flagged).toBeUndefined();
    expect(threadEditList(dialogue!).map(e => [e.spot, e.check, e.recheck, e.elsewhere])).toEqual([
      [0, undefined, undefined, undefined], [1, "Black gap and overlapping lines", flags[0]!.at, undefined]]);
  });

  it("opens a broad edit at the flagged footage after later cuts move it", () => {
    const working = { ...timelineFromKeepRanges("project", "interview", [{ start: 0, end: 80 }, { start: 100, end: 3468 }]), version: "v3" };
    const history = [
      { ...links[0]!, createdAt: "2026-01-01T00:00:00Z" },
      { ...links[1]!, createdAt: "2026-01-02T00:00:00Z" },
      { version: "v3", parent: "v2", createdAt: "2026-01-03T00:00:00Z" },
    ];
    const blank = { ...emptyTimeline("project"), version: "base" };
    const versions = { base: blank, v1: earlier, v2: head };
    const at = "2026-01-02T00:05:00Z";
    const edit = { ...pass, timelineEdits: [{ label: "Assemble the video", range: { start: 0, end: 3468 } }] };
    const project = (check: string, location?: NonNullable<Change["flags"]>[number]["location"]) => {
      const [review] = buildThreads({
        changes: [{ ...edit, flags: [{ spot: 0, taskId: "cutting", at, check, location }] }],
        notes: [], tasks: [run("cutting", "dialogue")],
      });
      return threadTimeline(review!, working, history, version => versions[version as keyof typeof versions], 30)[0]!;
    };
    expect(project("Check the phone comparison.", { version: "v2", range: { start: 518.4, end: 524.5 } })).toMatchObject({
      changeId: "pass", spot: 0, range: { start: 0, end: 3448 }, reviewRange: { start: 498.4, end: 504.5 },
    });
    expect(project("The comparison at 8:38.4 needs different footage.").reviewRange).toEqual({ start: 498.4, end: 498.4 });
    expect(project("Compare the moments at 8:38.4 and 8:42.").reviewRange).toBeUndefined();
    expect(project("The source recording at 8:38.4 needs a look.").reviewRange).toBeUndefined();
    expect(project("Look at 8:38.4 in the source recording.").reviewRange).toBeUndefined();
    expect(project("Check the removed footage.", { version: "v2", range: { start: 85, end: 90 } }).reviewRange).toBeUndefined();
  });

  it("opens a flag at the span its words name inside its passage, where that span is now", () => {
    const working = { ...timelineFromKeepRanges("project", "interview", [{ start: 0, end: 80 }, { start: 100, end: 3468 }]), version: "v3" };
    const history = [{ ...links[0]!, createdAt: "2026-01-01T00:00:00Z" }, { ...links[1]!, createdAt: "2026-01-02T00:00:00Z" },
      { version: "v3", parent: "v2", createdAt: "2026-01-03T00:00:00Z" }];
    const versions = { base: { ...emptyTimeline("project"), version: "base" }, v1: earlier, v2: head };
    const edit = { ...pass, timelineEdits: [{ label: "Pricing and model names", range: { start: 0, end: 3468 } }] };
    const project = (check: string) => {
      const [review] = buildThreads({
        changes: [{ ...edit, flags: [{ spot: 0, taskId: "cutting", at: "2026-01-02T00:05:00Z", check, location: { version: "v2", range: { start: 460, end: 523 } } }] }],
        notes: [], tasks: [run("cutting", "dialogue")],
      });
      return threadTimeline(review!, working, history, version => versions[version as keyof typeof versions], 30)[0]!;
    };
    // Matt's flag gave 56 seconds and named the three it meant, in the clock of the version it flagged.
    expect(project("Check the ends of ‘GLM 5.3’ and the Lithos pickup and prices at 8:38.5–8:41.6.")).toMatchObject({
      reviewRange: { start: 498.5, end: 501.6 }, reviewSays: "Check the ends of ‘GLM 5.3’ and the Lithos pickup and prices.",
      check: "Check the ends of ‘GLM 5.3’ and the Lithos pickup and prices at 8:38.5–8:41.6." });
    expect(project("Listen around 8:39 for a doubled pickup.")).toMatchObject({ reviewRange: { start: 499, end: 499 }, reviewSays: "Listen for a doubled pickup." });
    // Words with no time, or a time outside the passage, leave the passage as flagged.
    expect(project("Check the price pickup.")).toMatchObject({ reviewRange: { start: 440, end: 503 } });
    expect(project("Check the price pickup.").reviewSays).toBeUndefined();
    expect(project("Same pickup as at 2:10.").reviewRange).toEqual({ start: 440, end: 503 });
    expect(project("The source take at 8:39 is cleaner.").reviewRange).toEqual({ start: 440, end: 503 });
  });

  it("puts a revision the raising request made of it in its place", () => {
    const revision = { ...zooms, id: "fix", timelineEdits: [{ label: "Close the gap", range: { start: 724, end: 726 }, replaces: { changeId: "pass", spot: 1 } }] };
    const [framing] = buildThreads({ changes: [{ ...pass, flags }, revision], notes: [], tasks: [run("framing-run", "framing")] })
      .filter(t => t.id === "framing");
    expect(threadEditList(framing!).map(e => [e.changeId, e.check, e.previous])).toEqual([["fix", REVISED_CHECK, [{ changeId: "pass", spot: 1 }]]]);
    // The editor's request about it from that request's card stays there, and doesn't join the two requests.
    const revise = Task.parse({ ...run("revise-run", "framing"), kind: "revise", context: { threadId: "framing", changeId: "pass", editIndex: 1 } });
    const threads = buildThreads({ changes: [{ ...pass, flags }, revision], notes: [], tasks: [run("cutting", "dialogue"), run("framing-run", "framing"), revise] });
    expect(threads.map(t => [t.id, t.tasks.map(x => x.id)])).toEqual(expect.arrayContaining([["dialogue", ["cutting"]], ["framing", ["framing-run", "revise-run"]]]));
  });

  it("lists the edit as it is now once the request that made it revised it, and not the version it replaced", () => {
    // The dialogue request revised its own edit after the framing request raised the doubt.
    const own = { ...change, id: "own-fix", threadId: "dialogue", taskId: "cutting-fix", fromVersion: "v1", toVersion: "v2", createdAt: "2026-01-03T00:00:00Z",
      timelineEdits: [{ label: "Close the gap", range: { start: 724, end: 726 }, replaces: { changeId: "pass", spot: 1 } }] };
    const threads = buildThreads({ changes: [{ ...pass, flags }, zooms, own], notes: [], tasks: [run("cutting", "dialogue"), run("framing-run", "framing"), run("cutting-fix", "dialogue")] });
    const framing = threads.find(t => t.id === "framing")!, dialogue = threads.find(t => t.id === "dialogue")!;
    expect(framing.flagged?.map(c => c.id)).toEqual(["pass", "own-fix"]);
    expect(dialogue.changes.map(c => c.id)).toEqual(["pass", "own-fix"]);
    expect(threadEditList(framing).map(e => [e.changeId, e.label, e.check, e.elsewhere, e.previous])).toEqual([
      ["zooms", "Frame the spreadsheet", undefined, undefined, []],
      ["own-fix", "Close the gap", REVISED_CHECK, true, [{ changeId: "pass", spot: 1 }]]]);
    // Undoing the revision puts the version with the doubt back in the video, and back in the list.
    const undone = threadTimeline(framing, { ...head, version: "undo" }, [...links, { version: "undo", parent: "v2", revertsVersion: "v2" }], () => earlier, 30);
    expect(undone.filter(e => e.elsewhere).map(e => [e.changeId, e.check])).toEqual([["pass", flags[0]!.check]]);
  });

  it("tells an edit that only left a marker for the editor from one that changed the video", () => {
    // Asked on camera to put comparison footage on screen, Scarlet had none and marked the spots instead (Nov 16 2026).
    const marks = { ...change, id: "marks", fromVersion: "v1", toVersion: "v2", ops: [
      { op: "addMarker", marker: { id: "fall", time: 118.28, kind: "todo", text: "Comparison footage needed", resolved: false } },
      { op: "addMarker", marker: { id: "boat", time: 144.21, kind: "todo", text: "Comparison footage needed", resolved: false } }],
      timelineEdits: [
        { label: "Fall Guys comparison footage", range: { start: 118.28, end: 120.07 }, check: "Add the Opus and Sol gameplay captures" },
        { label: "Boat comparison footage", range: { start: 144.21, end: 144.21 }, check: "Add the other boat renders" }] };
    const edits = threadTimeline(thread([marks]), head, links, () => earlier, 30);
    expect(edits.map(e => [e.label, e.marker])).toEqual([["Fall Guys comparison footage", true], ["Boat comparison footage", true]]);

    // A zoom named where a marker also sits changed the picture there: it is a zoom, not a marker.
    const zoomed = { ...marks, id: "zoomed", ops: [marks.ops[0]!, { op: "updateClip", clipId: "missing", patch: { transform: { scale: 1.2 } } }],
      timelineEdits: [marks.timelineEdits[0]!] };
    expect(threadTimeline(thread([zoomed]), head, links, () => earlier, 30)[0]?.marker).toBeUndefined();
  });

  it("keeps what a marker asks of the editor through a revision, and keeps it waiting on them", () => {
    const boat = { op: "addMarker", marker: { id: "boat", time: 144.21, kind: "todo", text: "Comparison footage needed", resolved: false } };
    const marks = { ...change, id: "marks", fromVersion: "v1", toVersion: "v2", ops: [boat],
      timelineEdits: [{ label: "Boat comparison footage", range: { start: 144.21, end: 144.21 }, check: "Add the other boat renders" }] };
    expect(threadEditList(thread([marks]))[0]).toMatchObject({ marker: true, todo: "Add the other boat renders", check: "Add the other boat renders" });
    // Moved by updateMarker, the revision is still a marker, still asks what it asked, and waits on the editor as revised.
    const moved = { ...change, id: "moved", fromVersion: "v2", toVersion: "v3", createdAt: "2026-01-02T00:00:00Z",
      ops: [{ op: "updateMarker", markerId: "boat", patch: { time: 146 } }],
      timelineEdits: [{ label: "Boat comparison footage", range: { start: 146, end: 146 }, replaces: { changeId: "marks", spot: 0 } }] };
    expect(threadEditList(thread([marks, moved]))).toMatchObject([{ changeId: "moved", marker: true,
      todo: "Add the other boat renders", check: REVISED_CHECK, previous: [{ changeId: "marks", spot: 0 }] }]);
    // Replaced by a new marker, it asks what the new one says.
    const replaced = { ...moved, id: "replaced", ops: [{ op: "removeMarker", markerId: "boat" },
      { op: "addMarker", marker: { id: "boat2", time: 146, kind: "todo", text: "Add the Sol boat render", resolved: false } }] };
    expect(threadEditList(thread([marks, replaced]))).toMatchObject([{ marker: true, todo: "Add the Sol boat render", check: REVISED_CHECK }]);
  });

  it("keeps Scarlet's to-do through a move when the saved timeline only says what the marker still says", () => {
    const boat = { id: "boat", time: 144.21, kind: "todo" as const, text: "Comparison footage needed", resolved: false };
    const v2 = { ...head, version: "v2", markers: [boat] }, v3 = { ...head, version: "v3", markers: [{ ...boat, time: 146 }] };
    const versions: Record<string, typeof head> = { v1: earlier, v2, v3 };
    const read = (version: string) => versions[version];
    const marks = { ...change, id: "marks", fromVersion: "v1", toVersion: "v2", ops: [{ op: "addMarker", marker: boat }],
      timelineEdits: [{ label: "Boat comparison footage", range: { start: 144.21, end: 144.21 }, check: "Add the other boat renders" }] };
    const moved = { ...change, id: "moved", fromVersion: "v2", toVersion: "v3", createdAt: "2026-01-02T00:00:00Z",
      ops: [{ op: "updateMarker", markerId: "boat", patch: { time: 146 } }],
      timelineEdits: [{ label: "Boat comparison footage", range: { start: 146, end: 146 }, replaces: { changeId: "marks", spot: 0 } }] };
    const tree = [...links, { version: "v3", parent: "v2" }];
    expect(threadTimeline(thread([marks, moved]), v3, tree, read, 30)).toMatchObject([{ changeId: "moved", marker: true,
      todo: "Add the other boat renders", check: REVISED_CHECK }]);
    // Rewritten by the revision, it asks what the marker now says.
    const reworded = { ...moved, ops: [{ op: "updateMarker", markerId: "boat", patch: { time: 146, text: "Add the Sol boat render" } }] };
    const v3b = { ...v3, markers: [{ ...boat, time: 146, text: "Add the Sol boat render" }] };
    expect(threadTimeline(thread([marks, reworded]), v3b, tree, (v: string) => v === "v3" ? v3b : read(v), 30))
      .toMatchObject([{ marker: true, todo: "Add the Sol boat render" }]);
  });

  it("holds a to-do marker Scarlet gave no reason to look among what needs the editor, asking what the marker says", () => {
    const marks = { ...change, id: "marks", fromVersion: "v1", toVersion: "v2",
      ops: [{ op: "addMarker", marker: { id: "boat", time: 144.21, kind: "todo", text: "Add the other boat renders", resolved: false } }],
      timelineEdits: [{ label: "Boat comparison footage", range: { start: 144.21, end: 144.21 } }] };
    expect(threadTimeline(thread([marks]), head, links, () => earlier, 30)[0]).toMatchObject({ marker: true,
      todo: "Add the other boat renders", check: "Add the other boat renders" });
    // A note that isn't a to-do asks nothing of them.
    const note = { ...marks, ops: [{ op: "addMarker", marker: { id: "n", time: 144.21, kind: "chapter", text: "Boats", resolved: false } }] };
    expect(threadTimeline(thread([note]), head, links, () => earlier, 30)[0]?.check).toBeUndefined();
  });
});

it("names a cut saved without a summary by what came out, not by why it was made", () => {
  const pass = Change.parse({ ...change, ops: [{ op: "rippleDelete", start: 30, end: 31 }, { op: "rippleDelete", start: 10, end: 10.6 }],
    ranges: [{ start: 10, end: 10 }, { start: 29.4, end: 29.4 }], cutReasons: [
      { start: 10, end: 10.6, reason: "Kept a short beat between parts of the same thought.", kind: "pause" },
      { start: 30, end: 31, reason: "Kept the completed line.", summary: "Cut the false start ‘so the’", kind: "retake" }] });
  expect(namedTimelineEdits(pass)?.map(e => [e.label, e.reason])).toEqual([
    ["Shortened a pause", "Kept a short beat between parts of the same thought."],
    ["Cut the false start ‘so the’", "Kept the completed line."]]);
});
