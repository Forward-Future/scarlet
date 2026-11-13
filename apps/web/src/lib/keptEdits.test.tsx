// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { editKey, keepEdits, useKeptEdits } from "./keptEdits";
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
