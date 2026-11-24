// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { decidedPassCalls, nextWaitingInForYou, passForYouOrder, rejectedCallEdits, rejectedCallIndex, rejectedCallRef, seeAllOrder } from "./passCalls";

const edit = (spot: number, at: number, label = `edit ${spot}`): ThreadEdit => ({
  changeId: "chg_part",
  spot,
  label,
  range: { start: at, end: at + 1 },
  at,
  previous: [],
  check: "Check this.",
});

it("orders For you items by publication number when asks are numbered, else by timeline position", () => {
  const eLate = edit(0, 15, "late edit");
  const eEarly = edit(1, 4, "early edit");
  // Publication numbers: Call A (#1 at 12s), Edit late (#2 at 15s), Call B (#3 at 6s), Edit early (#4 at 4s).
  const byNum = passForYouOrder(
    [
      { call: "A", at: 12, num: 1, waiting: true },
      { call: "B", at: 6, num: 3, waiting: true },
    ],
    [
      { edit: eLate, at: 15, num: 2, waiting: true },
      { edit: eEarly, at: 4, num: 4, waiting: true },
    ],
    true,
  );
  expect(byNum.map(item => (item.kind === "call" ? item.call : item.edit.label))).toEqual([
    "A",
    "late edit",
    "B",
    "early edit",
  ]);

  // Without numbered asks, items follow timeline position (calls and flagged edits interleaved).
  const byTime = passForYouOrder(
    [
      { call: "A", at: 12, num: 1, waiting: true },
      { call: "B", at: 6, num: 3, waiting: true },
    ],
    [
      { edit: eLate, at: 15, num: 2, waiting: true },
      { edit: eEarly, at: 4, num: 4, waiting: true },
    ],
    false,
  );
  expect(byTime.map(item => (item.kind === "call" ? item.call : item.edit.label))).toEqual([
    "early edit",
    "B",
    "A",
    "late edit",
  ]);
});

it("advances to the next waiting For you item in list order and wraps around", () => {
  const e1 = edit(0, 15, "edit 2");
  const e2 = edit(1, 4, "edit 4");
  const items = passForYouOrder(
    [
      { call: "call 1", at: 12, num: 1, waiting: false },
      { call: "call 3", at: 6, num: 3, waiting: true },
    ],
    [
      { edit: e1, at: 15, num: 2, waiting: true },
      { edit: e2, at: 4, num: 4, waiting: true },
    ],
    true,
  );
  // From call 1 (index 0) -> edit 2 (index 1) -> call 3 (index 2) -> edit 4 (index 3) -> wraps to edit 2 (index 1).
  expect(nextWaitingInForYou(items, 0)).toEqual({ edit: e1 });
  expect(nextWaitingInForYou(items, 1)).toEqual({ call: "call 3" });
  expect(nextWaitingInForYou(items, 2)).toEqual({ edit: e2 });
  expect(nextWaitingInForYou(items, 3)).toEqual({ edit: e1 });
  // When nothing else waits, returns undefined.
  const onlyOne = items.map((item, i) => ({ ...item, waiting: i === 2 }));
  expect(nextWaitingInForYou(onlyOne, 2)).toBeUndefined();
});

it("orders a waiting pass's list of every edit as the chat lists it: rows and calls by time, an edit ahead of a call at its time", () => {
  const first = [edit(0, 1)], moment = [edit(2, 6), edit(1, 4)], last = [edit(3, 9)];
  const list = seeAllOrder([first, moment, last], [{ call: "cut 2", at: 6 }, { call: "cut 1", at: 2 }, { call: "cut 3", at: 9 }]);
  // A moment sits at its first edit's time, wherever the edit it is named for comes.
  expect(list).toEqual([{ row: first }, { call: "cut 1" }, { row: moment }, { call: "cut 2" }, { row: last }, { call: "cut 3" }]);
});

it("maps approved pass calls to their applied edit keys and keeps skipped calls as decided rows", () => {
  const applied = { ...edit(0, 5, "cut 1"), changeId: "chg_pass", check: undefined };
  const thread = {
    changes: [{
      id: "chg_pass",
      state: "approved",
      cutChoices: [
        { index: 0, choice: "cut" as const, start: 5 },
        { index: 1, choice: "keep" as const, start: 10 },
      ],
      cutAssessments: [
        { index: 0, start: 5, end: 6, verdict: "ask" as const, reason: "Retake.", summary: "Retake" },
        { index: 1, start: 10, end: 11, verdict: "ask" as const, reason: "Aside.", summary: "Aside" },
      ],
      appliedReview: { joins: [{ at: 5, removed: { start: 5, end: 6 }, reviewIndex: 0 }] },
    }],
  } as Parameters<typeof decidedPassCalls>[0];
  const { decidedCallEditKeys, decidedCallRows } = decidedPassCalls(thread, [applied]);
  expect([...decidedCallEditKeys]).toEqual(["chg_pass/0"]);
  // The call left out sits where its footage is now: a second earlier, by the cut the pass applied ahead of it.
  expect(decidedCallRows).toEqual([{ key: "choice/chg_pass/1", changeId: "chg_pass", index: 1, at: 9, length: 1, label: "Aside", note: "Aside.", approved: false }]);
  // A press on its row opens it as a rejected edit's row does. It made no edit, so it stands in as one that isn't in
  // the video, under a spot no edit has: where its footage plays now, with Scarlet's note, and For you's to step from.
  const calls = rejectedCallEdits(thread, [applied]);
  expect(calls).toEqual([{ changeId: "chg_pass", spot: -2, label: "Aside", range: { start: 9, end: 10 }, previous: [], rejected: true, wasCheck: true, reason: "Aside." }]);
  expect([rejectedCallRef("chg_pass", 1), rejectedCallIndex(calls[0]!), rejectedCallIndex(applied)]).toEqual([{ changeId: "chg_pass", spot: -2 }, 1, undefined]);
  // Listed with the rejected edits, it is no edit a call could have made: the rows stay as they were.
  expect(decidedPassCalls(thread, [applied], calls).decidedCallRows.map(row => row.key)).toEqual(["choice/chg_pass/1"]);
});

it("has no stand-in for a call the editor kept: only a rejected call's row opens", () => {
  const thread = {
    changes: [{
      id: "chg_pass", state: "approved",
      cutChoices: [{ index: 0, choice: "keep" as const, start: 5 }],
      cutAssessments: [{ index: 0, start: 5, end: 6, verdict: "ask" as const, proposes: "keep" as const, reason: "The pause reads as a beat.", summary: "Beat" }],
    }],
  } as Parameters<typeof decidedPassCalls>[0];
  expect(decidedPassCalls(thread, []).decidedCallRows.map(row => [row.label, row.approved])).toEqual([["Beat", true]]);
  expect(rejectedCallEdits(thread, [])).toEqual([]);
});

it("links each approved call to its applied edit when the pass's joins carry no review index", () => {
  // As a pass applied onto the version it was made on records them: each join lands earlier by the footage cut before it.
  const cut = (spot: number, at: number) => ({ ...edit(spot, at, `cut ${spot + 1}`), changeId: "chg_pass", range: { start: at, end: at }, check: undefined });
  const thread = {
    changes: [{
      id: "chg_pass",
      state: "approved",
      cutChoices: [
        { index: 0, choice: "cut" as const, start: 5, end: 6 },
        { index: 1, choice: "cut" as const, start: 10, end: 11 },
        { index: 2, choice: "keep" as const, start: 20, end: 21 },
      ],
      cutAssessments: [
        { index: 0, start: 5, end: 6, verdict: "ask" as const, reason: "Retake.", summary: "Retake" },
        { index: 1, start: 10, end: 11, verdict: "ask" as const, reason: "Restart.", summary: "Restart" },
        { index: 2, start: 20, end: 21, verdict: "ask" as const, reason: "Aside.", summary: "Aside" },
      ],
      appliedReview: { joins: [{ at: 5, removed: { start: 5, end: 6 } }, { at: 9, removed: { start: 10, end: 11 } }] },
    }],
  } as Parameters<typeof decidedPassCalls>[0];
  const { decidedCallEditKeys, decidedCallRows } = decidedPassCalls(thread, [cut(0, 5), cut(1, 9)]);
  expect([...decidedCallEditKeys]).toEqual(["chg_pass/0", "chg_pass/1"]);
  expect(decidedCallRows).toEqual([{ key: "choice/chg_pass/2", changeId: "chg_pass", index: 2, at: 18, length: 1, label: "Aside", note: "Aside.", approved: false }]);
});
