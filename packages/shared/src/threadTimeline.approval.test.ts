import { expect, it } from "vitest";
import { Change } from "@scarlet/timeline";
import { changeEdits } from "./threadEdits.js";

const partial = Change.parse({ id: "batch", projectId: "project", fromVersion: "base", toVersion: "proposal",
  appliedOnto: "base", appliedVersion: "applied", state: "approved", description: "Tighten the interview",
  author: { type: "agent", name: "Scarlet" },
  ranges: [{ start: 5, end: 5 }, { start: 18, end: 18 }, { start: 28, end: 30 }],
  timelineEdits: [
    { label: "Hold the comparison", range: { start: 28, end: 30 }, summary: "Held the comparison.", reason: "Viewers need time to read both scores." },
    { label: "Trim a false start", range: { start: 17.5, end: 18.5 }, summary: "Trimmed the false start.", reason: "The score comes through cleanly after the restart.",
      check: "Listen for the whole score" },
    { label: "Cut an aside", range: { start: 5, end: 5 }, summary: "Cut the aside to stay on the benchmark." },
  ],
  approvedSpots: [2, 1],
  appliedWindows: [
    { spot: { start: 20, end: 20 }, beforeRange: { start: 19, end: 22 }, range: { start: 19, end: 21 } },
    { spot: { start: 30, end: 32 }, beforeRange: { start: 29, end: 33 }, range: { start: 29, end: 33 } },
  ],
});

it("shows the note for each approved spot at its applied position", () => {
  const [cut, hold] = changeEdits(partial);
  expect(cut).toMatchObject({ spot: 0, label: "Trim a false start", range: { start: 20, end: 20 },
    summary: "Trimmed the false start.", reason: "The score comes through cleanly after the restart.", check: "Listen for the whole score" });
  expect(hold).toMatchObject({ spot: 1, label: "Hold the comparison", range: { start: 30, end: 32 },
    summary: "Held the comparison.", reason: "Viewers need time to read both scores." });
  expect(hold!.check).toBeUndefined();
});

it("uses the whole-change reason when a partially approved edit matches two named edits", () => {
  const reason = "The interview needed a rhythm pass.";
  const ambiguous = { ...partial, timelineEdits: [...partial.timelineEdits!,
    { label: "Another edit at this join", range: { start: 18, end: 18 }, reason: "Explained the other edit." },
  ] };
  const [cut] = changeEdits({ ...ambiguous, reason });
  expect(cut).toMatchObject({ spot: 0, label: partial.description, range: { start: 20, end: 20 } });
  expect(cut!.summary).toBeUndefined();
  expect(cut!.reason).toBe(reason);
  expect(cut!.check).toBeUndefined();
  expect(changeEdits(ambiguous)[0]!.reason).toBeUndefined();
});

it("keeps a shared reason on approved spots of an unnamed edit", () => {
  const reason = "The changes bring the comparison into view.";
  expect(changeEdits({ ...partial, timelineEdits: undefined, reason }).map(edit => edit.reason)).toEqual([reason, reason]);
});

it("finds the note for a named cut using its proposal join after restoring another cut", () => {
  const pass = Change.parse({ ...partial, approvedSpots: undefined, appliedWindows: undefined,
    timelineEdits: [
      { label: "Remove background noise", range: { start: 2, end: 2 }, reason: "The chair squeaks over room tone." },
      { label: "Trim the false start", range: { start: 17.02, end: 17.02 }, summary: "Trimmed the false start.",
        reason: "The score comes through cleanly after the restart.", check: "Listen for the whole score" },
    ],
    restoredCuts: [0],
    appliedReview: { originalVersion: "base", originalDuration: 40, duration: 39,
      joins: [{ at: 18, proposedAt: 17, removed: { start: 18, end: 19 } }] },
  });
  expect(changeEdits(pass)).toMatchObject([{ spot: 0, label: "Trim the false start", range: { start: 18, end: 18 },
    beforeCut: { version: "base", removed: { start: 18, end: 19 } }, summary: "Trimmed the false start.",
    reason: "The score comes through cleanly after the restart.", check: "Listen for the whole score" }]);
});

it("keeps a cut's final recommendation after reviewing or rebasing the pass", () => {
  const pass = Change.parse({ ...partial, approvedSpots: undefined, appliedWindows: undefined, timelineEdits: undefined,
    cutReasons: [{ start: 3, end: 4, reason: "First pause" }, { start: 18, end: 19, reason: "The speaker abandons the first take", summary: "Trim the false start" },
      { start: 30, end: 31, reason: "Staged pause", summary: "Shorten the pause" }, { start: 45, end: 46, reason: "Drop the duplicate" }],
    cutAssessments: [
      { index: 0, start: 3, end: 4, verdict: "keep", reason: "Keep the pause for emphasis." },
      { index: 1, start: 18, end: 19, verdict: "ask", reason: "Cut the abandoned take so the full score lands in one breath.", summary: "Keep the full score" },
      { index: 2, start: 30, end: 31, verdict: "ask", provisional: true, reason: "Waiting to be checked." },
      { index: 3, start: 45, end: 46, verdict: "cut", reason: "Drop the duplicate" },
    ],
    appliedReview: { originalVersion: "base", originalDuration: 60, duration: 56,
      joins: [{ at: 3, removed: { start: 3, end: 4 } }, { at: 17, removed: { start: 18, end: 19 } },
        { at: 28, removed: { start: 30, end: 31 } }, { at: 42, removed: { start: 45, end: 46 } }] },
  });
  const [first, cut, staged, duplicate] = changeEdits(pass);
  expect(cut).toMatchObject({ spot: 1, label: "Keep the full score", summary: "Keep the full score",
    reason: "The speaker abandons the first take. Cut the abandoned take so the full score lands in one breath." });
  expect(cut!.check).toBeUndefined();
  expect(first).toMatchObject({ label: "First pause", reason: "First pause" });
  expect(staged).toMatchObject({ label: "Shorten the pause", summary: "Shorten the pause", reason: "Staged pause" });
  expect(duplicate!.reason).toBe("Drop the duplicate");
  const [rebased] = changeEdits({ ...pass, appliedReview: { ...pass.appliedReview!,
    joins: [{ at: 16, removed: { start: 16, end: 17 }, reviewIndex: 1 }] } });
  expect(rebased).toMatchObject({ spot: 0, label: "Keep the full score", summary: "Keep the full score", reason: cut!.reason });
});
