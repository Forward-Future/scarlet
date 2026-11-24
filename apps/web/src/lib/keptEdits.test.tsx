// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startAppLog, stopAppLog } from "./appLog";
import { editKey, keepEdits, notYetKept, reviewKey, unkeepEdits, useKeptEdits } from "./keptEdits";
import { useReviewed } from "../components/review/threadEditState";
import { api } from "./client";
import type { Thread } from "@scarlet/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeEach(() => {
  vi.spyOn(api, "keepEdits").mockResolvedValue(undefined);
  vi.spyOn(api, "unkeepEdits").mockResolvedValue(undefined);
});
afterEach(() => { stopAppLog(); vi.restoreAllMocks(); localStorage.clear(); });

function readKept(projectId: string, threadId: string, changes: Thread["changes"] = []) {
  let value: ReadonlySet<string> = new Set();
  const thread = { id: threadId, changes } as unknown as Thread;
  function Probe() { value = useKeptEdits(projectId, thread); return null; }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return value;
}

it("remembers kept edits per thread and notices storage changing underneath", () => {
  expect(keepEdits("prj", "thr", [{ changeId: "chg", spot: 0 }])).toBe(true);
  expect(keepEdits("prj", "thr", [{ changeId: "chg", spot: 0 }])).toBe(false);
  expect(readKept("prj", "thr").has(editKey({ changeId: "chg", spot: 0 }))).toBe(true);
  expect(readKept("prj", "other").size).toBe(0);
  localStorage.clear();
  expect(readKept("prj", "thr").size).toBe(0);
});

it("says which edits of a row a Keep would newly keep, so taking it back leaves the ones kept before it", () => {
  const row = [{ changeId: "chg", spot: 0 }, { changeId: "chg", spot: 1 }, { changeId: "chg", spot: 2 }];
  keepEdits("prj", "row", [row[1]!]);
  expect(notYetKept("prj", "row", row)).toEqual([row[0], row[2]]);
  expect(notYetKept("prj", "elsewhere", row)).toEqual(row);
  keepEdits("prj", "row", row);
  expect(notYetKept("prj", "row", row)).toEqual([]);
});

it("tells the engine what the editor kept, under the identity the Keep is recorded by, so the request's runs hear of it", () => {
  const send = vi.mocked(api.keepEdits);
  keepEdits("prj", "pass", [{ changeId: "round6", spot: 2, reviewRef: { changeId: "round4", spot: 2 }, label: "Held the cube solve",
    check: "The cube animates before Matt speaks.", range: { start: 830.77, end: 832.83 } }], "v9");
  expect(send).toHaveBeenCalledWith("prj", { threadId: "pass", version: "v9", edits: [{ changeId: "round4", spot: 2, label: "Held the cube solve",
    check: "The cube animates before Matt speaks.", range: { start: 830.77, end: 832.83 } }] });
  // Kept again, nothing new is sent.
  send.mockClear();
  keepEdits("prj", "pass", [{ changeId: "round6", spot: 2, reviewRef: { changeId: "round4", spot: 2 } }]);
  expect(send).not.toHaveBeenCalled();
});

it("sends a Keep once: the list that shows it doesn't send it again without what the editor read", () => {
  keepEdits("prj", "once", [{ changeId: "chg", spot: 4, label: "Tightened the pause" }]);
  readKept("prj", "once");
  expect(api.keepEdits).toHaveBeenCalledTimes(1);
});

it("counts a Keep the engine recorded, and sends on one this window made that the engine doesn't have", () => {
  localStorage.setItem("scarlet.kept-edits.v1/prj/older", JSON.stringify(["chg/1"]));
  const recorded = [{ id: "chg", kept: [{ spot: 0, threadId: "older", at: "2026-11-16T22:25:32Z" }, { spot: 3, threadId: "elsewhere", at: "2026-11-16T22:25:32Z" }] }];
  const kept = readKept("prj", "older", recorded as unknown as Thread["changes"]);
  expect([...kept].sort()).toEqual(["chg/0", "chg/1"]);
  expect(api.keepEdits).toHaveBeenCalledWith("prj", { threadId: "older", edits: [{ changeId: "chg", spot: 1 }] });
});

it("keeps an edit for the session when storage refuses the write, even with an older record stored", () => {
  keepEdits("prj", "full", [{ changeId: "chg", spot: 0 }]);
  const lines: string[] = [];
  startAppLog(batch => lines.push(...batch));
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("details", "QuotaExceededError"); });
  keepEdits("prj", "full", [{ changeId: "chg", spot: 1 }]);
  const kept = readKept("prj", "full");
  expect([...kept].sort()).toEqual(["chg/0", "chg/1"]);
  expect(lines).toEqual([expect.stringContaining("keep-persist-failed project=prj thread=full count=1 name=QuotaExceededError")]);
});

it("asks again about a cut the editor called once a later save gives it a new reason to look", () => {
  // The pass was applied through the editor's calls, so each of its cuts counts as reviewed.
  const thread = { id: "thr", changes: [{ id: "pass", state: "approved", appliedReview: { joins: [] } }] } as unknown as Thread;
  let reviewed!: ReturnType<typeof useReviewed>;
  function Probe() { reviewed = useReviewed("prj", thread); return null; }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  const cut = { changeId: "pass", spot: 3 };
  // A later save moved the cut's join and asked for a listen: that is its own thing to keep.
  const flagged = { ...cut, reviewRef: { changeId: "trim", spot: 0 } };
  expect(reviewed(cut)).toBe(true);
  expect(reviewed(flagged)).toBe(false);
  expect(reviewKey(flagged)).toBe("trim/0");
  act(() => { keepEdits("prj", "thr", [flagged]); });
  expect(reviewed(flagged)).toBe(true);
  act(() => root.unmount());
});


it("takes a Keep back (⌘Z) here and on the engine, whose record no longer counts until it lets go", async () => {
  const sent: string[] = [];
  vi.mocked(api.keepEdits).mockImplementation(async () => { sent.push("keep"); });
  vi.mocked(api.unkeepEdits).mockImplementation(async () => { sent.push("unkeep"); });
  keepEdits("prj", "undo", [{ changeId: "chg", spot: 2, reviewRef: { changeId: "first", spot: 2 } }]);
  const recorded = [{ id: "first", kept: [{ spot: 2, threadId: "undo", at: "2026-11-18T22:25:32Z" }] }] as unknown as Thread["changes"];
  expect(readKept("prj", "undo", recorded).has("first/2")).toBe(true);
  unkeepEdits("prj", "undo", [{ changeId: "chg", spot: 2, reviewRef: { changeId: "first", spot: 2 } }]);
  // The engine still holds it for now: it doesn't count.
  expect(readKept("prj", "undo", recorded).size).toBe(0);
  await vi.waitFor(() => expect(sent).toEqual(["keep", "unkeep"]));
  expect(api.unkeepEdits).toHaveBeenCalledWith("prj", { threadId: "undo", edits: [{ changeId: "first", spot: 2 }] });
  // Once the engine lets go and the editor keeps it again, it is kept and sent again.
  expect(readKept("prj", "undo").size).toBe(0);
  keepEdits("prj", "undo", [{ changeId: "chg", spot: 2, reviewRef: { changeId: "first", spot: 2 } }]);
  expect(readKept("prj", "undo", recorded).has("first/2")).toBe(true);
  await vi.waitFor(() => expect(sent).toEqual(["keep", "unkeep", "keep"]));
});

it("sends a Keep that didn't reach the engine again at the thread's next update, a few times at most", async () => {
  const send = vi.mocked(api.keepEdits).mockRejectedValue(new Error("offline"));
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  keepEdits("prj", "resend", [{ changeId: "chg", spot: 4 }]);
  await settle();
  expect(send).toHaveBeenCalledTimes(1);
  // The list that shows it sends it on, bare, while the engine still has no record of it.
  for (const calls of [2, 3, 3]) {
    readKept("prj", "resend");
    await settle();
    expect(send).toHaveBeenCalledTimes(calls);
  }
  expect(send.mock.calls[1]![1]).toEqual({ threadId: "resend", edits: [{ changeId: "chg", spot: 4 }] });
});
