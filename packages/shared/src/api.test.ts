import { describe, expect, it } from "vitest";
import { agentTarget, canRetryTask, isSkillEdit, reviewItemPath, skillEditTarget, skillTaskTarget, splitAgentTarget, taskNeedsTranscripts, taskRecoveryAction,
  taskWasStopped, Task } from "./api.js";

const task = (fields: Record<string, unknown> = {}): Task => Task.parse({ id: "t1", projectId: "p1", kind: "edit", agent: "claude", instruction: "Tighten the intro",
  state: "failed", createdBy: { type: "human", name: "Editor" }, ...fields });

describe("an agent target", () => {
  it("is an agent alone or an agent and a model, split at the first colon or slash", () => {
    expect(agentTarget("claude")).toBe("claude");
    expect(agentTarget("codex", "gpt-5:high")).toBe("codex:gpt-5:high");
    expect(splitAgentTarget("claude")).toEqual({ agent: "claude", model: undefined });
    expect(splitAgentTarget(agentTarget("codex", "gpt-5:high"))).toEqual({ agent: "codex", model: "gpt-5:high" });
    expect(splitAgentTarget("gemini/gemini-2.5-pro")).toEqual({ agent: "gemini", model: "gemini-2.5-pro" });
    expect(splitAgentTarget("claude:")).toEqual({ agent: "claude", model: undefined });
    expect(splitAgentTarget("")).toEqual({ agent: "", model: undefined });
  });
});

describe("what a run that ended early offers", () => {
  it("retries a failed editing run only when it saved nothing", () => {
    expect(canRetryTask(task())).toBe(true);
    expect(canRetryTask(task({ changeIds: ["chg_1"] }))).toBe(false);
    expect(canRetryTask(task({ resultSkillId: "skill_1" }))).toBe(false);
    expect(canRetryTask(task({ kind: "transcribe" }))).toBe(false);
    for (const state of ["queued", "claimed", "running", "waiting_for_user", "done", "cancelled"]) expect(canRetryTask(task({ state })), state).toBe(false);
  });

  it("counts a run as stopped when its host marked it, or an older host recorded only a timeout", () => {
    expect(taskWasStopped(task({ interrupted: true }))).toBe(true);
    expect(taskWasStopped(task({ error: "timed out after 45 minutes" }))).toBe(true);
    expect(taskWasStopped(task({ error: "timed out" }))).toBe(true);
    expect(taskWasStopped(task({ error: "The request timed out" }))).toBe(false);
    expect(taskWasStopped(task({ error: "timed_out" }))).toBe(false);
    expect(taskWasStopped(task())).toBe(false);
    expect(taskWasStopped(task({ state: "done", interrupted: true }))).toBe(false);
  });

  it("counts a finished run as waiting on transcripts until it has been resumed", () => {
    expect(taskNeedsTranscripts(task({ state: "done", needsTranscripts: ["m1"] }))).toBe(true);
    expect(taskNeedsTranscripts(task({ state: "done", needsTranscripts: [] }))).toBe(false);
    expect(taskNeedsTranscripts(task({ state: "done" }))).toBe(false);
    expect(taskNeedsTranscripts(task({ state: "done", needsTranscripts: ["m1"], retryTaskId: "t2" }))).toBe(false);
    expect(taskNeedsTranscripts(task({ state: "failed", needsTranscripts: ["m1"] }))).toBe(false);
  });

  it("resumes a run that was stopped, cancelled or short of transcripts, even one that saved an edit", () => {
    expect(taskRecoveryAction(task({ state: "cancelled" }), true)).toBe("resume");
    expect(taskRecoveryAction(task({ interrupted: true, changeIds: ["chg_1"] }), true)).toBe("resume");
    expect(taskRecoveryAction(task({ error: "timed out" }), false)).toBe("resume");
    expect(taskRecoveryAction(task({ state: "done", needsTranscripts: ["m1"] }), true)).toBe("resume");
  });

  it("retries a run that failed before saving anything, resumes one that was already a resumed run, and offers nothing once an edit exists", () => {
    expect(taskRecoveryAction(task(), false)).toBe("retry");
    expect(taskRecoveryAction(task({ resumeRootId: "t0" }), false)).toBe("resume");
    expect(taskRecoveryAction(task(), true)).toBeUndefined();
    expect(taskRecoveryAction(task({ changeIds: ["chg_1"] }), false)).toBeUndefined();
  });

  it("offers nothing for a transcription, a run that produced a skill, or one that finished or still runs", () => {
    expect(taskRecoveryAction(task({ kind: "transcribe", state: "cancelled" }), false)).toBeUndefined();
    expect(taskRecoveryAction(task({ resultSkillId: "skill_1", interrupted: true }), false)).toBeUndefined();
    for (const state of ["queued", "claimed", "running", "waiting_for_user", "done"]) expect(taskRecoveryAction(task({ state }), false), state).toBeUndefined();
  });
});

describe("a skill task's target", () => {
  const authoring = { kind: "skill_from_change", state: "running", hostId: "h1", context: { changeId: "chg_1", skillName: "tight-intros" } };
  const editing = { kind: "skill_edit", state: "claimed", hostId: "h1", context: { skillId: "skill_1" } };

  it("is the skill name, change and host of a live authoring task in this project", () => {
    expect(skillTaskTarget(task(authoring), "p1")).toEqual({ name: "tight-intros", changeId: "chg_1", hostId: "h1" });
    expect(skillTaskTarget(task({ ...authoring, state: "claimed" }), "p1")).toBeDefined();
    expect(skillTaskTarget(task(authoring), "p2")).toBeUndefined();
    expect(skillTaskTarget(task({ ...authoring, kind: "edit" }), "p1")).toBeUndefined();
    expect(skillTaskTarget(task({ ...authoring, hostId: null }), "p1")).toBeUndefined();
    expect(skillTaskTarget(task({ ...authoring, context: { changeId: "chg_1" } }), "p1")).toBeUndefined();
    expect(skillTaskTarget(task({ ...authoring, context: { skillName: "tight-intros" } }), "p1")).toBeUndefined();
    for (const state of ["queued", "waiting_for_user", "done", "failed", "cancelled"]) expect(skillTaskTarget(task({ ...authoring, state }), "p1"), state).toBeUndefined();
  });

  it("is the one skill a live skill-edit task was asked about", () => {
    expect(skillEditTarget(task(editing), "p1")).toEqual({ skillId: "skill_1", hostId: "h1" });
    expect(skillEditTarget(task({ ...editing, state: "running" }), "p1")).toBeDefined();
    expect(skillEditTarget(task(editing), "p2")).toBeUndefined();
    expect(skillEditTarget(task({ ...editing, kind: "skill_from_change" }), "p1")).toBeUndefined();
    expect(skillEditTarget(task({ ...editing, hostId: null }), "p1")).toBeUndefined();
    expect(skillEditTarget(task({ ...editing, context: {} }), "p1")).toBeUndefined();
    for (const state of ["queued", "done", "failed", "cancelled"]) expect(skillEditTarget(task({ ...editing, state }), "p1"), state).toBeUndefined();
    expect(isSkillEdit(task(editing))).toBe(true);
    expect(isSkillEdit(task(authoring))).toBe(false);
  });
});

describe("a link to a review item", () => {
  it("escapes the project and the thread", () => {
    expect(reviewItemPath("p1", "chg_1")).toBe("/p/p1?thread=chg_1");
    expect(reviewItemPath("my project/1", "a&b=c")).toBe("/p/my%20project%2F1?thread=a%26b%3Dc");
  });
});
