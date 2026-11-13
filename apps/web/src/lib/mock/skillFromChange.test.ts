import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockClient } from "./MockClient";
import { PRJ } from "./fixtures";

describe("mock skill authoring from a change", () => {
  let api: MockClient;
  beforeEach(() => {
    vi.useFakeTimers();
    api = new MockClient(() => "mock");
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("creates one team skill from the approved version, even if two tasks request the name", async () => {
    const changeId = "chg_approved_2";
    const name = "wrap-cut";
    const queued = Promise.all([api.skillFromChange(changeId, name), api.skillFromChange(changeId, name)]);
    await vi.advanceTimersByTimeAsync(4300);
    const [{ task: first }, { task: duplicate }] = await queued;
    expect(first).toMatchObject({ state: "done", context: { changeId, version: "ver_3", skillName: name } });
    expect(duplicate.state).toBe("failed");
    const read = api.skills();
    await vi.advanceTimersByTimeAsync(200);
    const saved = (await read).skills.filter((s) => s.name === name);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: first.resultSkillId, scope: "team", source: `change:${changeId}` });
    await expect(api.skillFromChange(changeId, name)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an unapproved change, a malformed name, and an ordinary task requesting skill authority", async () => {
    await expect(api.skillFromChange("chg_ready", "wrap-cut")).rejects.toMatchObject({ status: 409 });
    await expect(api.skillFromChange("chg_approved_2", "../outside")).rejects.toMatchObject({ status: 400 });
    await expect(api.createTask(PRJ, { kind: "skill_from_change", agent: "claude", instruction: "Save it" })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps cancelled and no-longer-approved tasks from saving a skill", async () => {
    const queued = Promise.all([api.skillFromChange("chg_approved_2", "cancel-me"), api.skillFromChange("chg_approved_2", "undo-me")]);
    await vi.advanceTimersByTimeAsync(1000);
    const [{ task: cancelled }, { task: undone }] = await queued;
    const stopped = Promise.all([api.cancelTask(cancelled.id), api.unapproveChange("chg_approved_2")]);
    await vi.advanceTimersByTimeAsync(4000);
    await stopped;
    expect(cancelled.state).toBe("cancelled");
    expect(undone.state).toBe("failed");
    const read = api.skills();
    await vi.advanceTimersByTimeAsync(200);
    expect((await read).skills.filter((s) => s.name === "cancel-me" || s.name === "undo-me")).toEqual([]);
  });
});
