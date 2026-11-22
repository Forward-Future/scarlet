// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { decidedPassCalls, nextWaitingInForYou, passForYouOrder } from "./passCalls";

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
  expect(decidedCallRows).toEqual([{ key: "choice/chg_pass/1", at: 10, label: "Aside", approved: false }]);
});
