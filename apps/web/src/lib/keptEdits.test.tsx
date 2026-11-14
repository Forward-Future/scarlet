// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { editKey, keepEdits, reviewKey, useKeptEdits } from "./keptEdits";
import { useReviewed } from "../components/review/ThreadEdits";
import type { Thread } from "@scarlet/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

function readKept(projectId: string, threadId: string) {
  let value: ReadonlySet<string> = new Set();
  function Probe() { value = useKeptEdits(projectId, threadId); return null; }
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

it("keeps an edit for the session when storage refuses the write, even with an older record stored", () => {
  keepEdits("prj", "full", [{ changeId: "chg", spot: 0 }]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
  keepEdits("prj", "full", [{ changeId: "chg", spot: 1 }]);
  const kept = readKept("prj", "full");
  expect([...kept].sort()).toEqual(["chg/0", "chg/1"]);
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
