import { describe, expect, it } from "vitest";
import { Change } from "@scarlet/timeline";
import { Task, type Render } from "./api.js";
import { beginRevision, restoredReviewState } from "./revisionState.js";

const change = (fields: Record<string, unknown> = {}): Change => Change.parse({ id: "chg", projectId: "p", fromVersion: "v0", toVersion: "v1", description: "Cuts",
  author: { type: "agent", name: "Scarlet" }, state: "ready", ...fields });
const task = (id: string): Task => Task.parse({ id, projectId: "p", kind: "revise", agent: "claude", instruction: "Shorter", state: "queued", createdBy: { type: "human", name: "Editor" } });

describe("beginRevision", () => {
  it("marks the change revising and remembers the state, error and task to return to", () => {
    const failed = change({ state: "failed", error: "render failed" });
    expect(beginRevision(failed, task("rev1"))).toEqual({ ...failed, state: "revising", revisionFrom: { state: "failed", error: "render failed", taskId: "rev1" } });
    expect(beginRevision(change(), task("rev1")).revisionFrom).toEqual({ state: "ready", error: undefined, taskId: "rev1" });
    expect(failed.state).toBe("failed");
  });

  it("keeps what the first revision remembered when a second starts before it ends", () => {
    const first = beginRevision(change(), task("rev1"));
    expect(beginRevision(first, task("rev2"))).toEqual(first);
  });
});

describe("restoredReviewState", () => {
  const renders = [{ range: { start: 0, end: 1 }, before: "b1", after: "a1" }, { range: { start: 4, end: 5 }, before: null, after: "a2" }];
  const states = (table: Record<string, Render["state"]>) => (id: string) => table[id];

  it("returns to a settled state as it was", () => {
    for (const state of ["ready", "approved", "rejected", "revising", "failed"] as const) {
      expect(restoredReviewState(change({ renders }), state, () => "failed")).toBe(state);
    }
  });

  it("works out a state that was still rendering from the previews as they are now", () => {
    const pending = change({ renders });
    for (const from of ["rendering", "proposed", undefined] as const) {
      expect(restoredReviewState(pending, from, states({ b1: "done", a1: "done", a2: "done" }))).toBe("ready");
      expect(restoredReviewState(pending, from, states({ b1: "done", a1: "running", a2: "queued" }))).toBe("rendering");
      expect(restoredReviewState(pending, from, states({ b1: "done", a1: "failed", a2: "done" }))).toBe("failed");
      expect(restoredReviewState(pending, from, states({ b1: "done", a1: "cancelled", a2: "done" }))).toBe("failed");
      // A preview that no longer exists can't finish.
      expect(restoredReviewState(pending, from, states({ b1: "done", a1: "done" }))).toBe("failed");
    }
    expect(restoredReviewState(change({ renders, error: "could not apply" }), "rendering", () => "done")).toBe("failed");
    // A change with no previews to wait for is ready.
    expect(restoredReviewState(change(), "rendering", () => undefined)).toBe("ready");
  });
});
