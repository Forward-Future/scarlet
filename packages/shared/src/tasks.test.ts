import { describe, expect, it } from "vitest";
import {
  CreateTaskRequest, DialogueScanPage, PROJECT_EDIT_TASK_KINDS, SIDE_CHECK_KINDS, Task, TaskKind, canRetryTask, closingCheckFailed, isAsideTask, isProjectEditTask,
  isSideCheck, planText, questionChoicesOf, sideCheckSlots, skillEditTarget, skillTaskTarget, styleGuideEditTarget, taskNeedsTranscripts, taskPlan,
  taskRecoveryAction, taskWasStopped, type TaskEvent,
} from "./tasks.js";

const task = (overrides: Partial<Task> = {}): Task => Task.parse({
  id: "tsk_1", projectId: "prj_1", kind: "edit", agent: "codex", instruction: "Tighten it", state: "running",
  createdBy: { type: "human", name: "Editor" }, ...overrides,
});

describe("Task", () => {
  it("fills in the defaults a stored request may lack", () => {
    const parsed = task();
    expect(parsed).toMatchObject({ context: {}, hostId: null, changeIds: [], question: null, summary: null });
  });

  it("refuses a request with marks but none drawn", () => {
    const marks = { attachmentId: "att_1", time: 1, marks: [] };
    expect(Task.safeParse({ ...task(), context: { pictureMarks: marks } }).success).toBe(false);
    const box = { kind: "box", box: { x: 0.1, y: 0.1, w: 0.5, h: 1 } };
    expect(Task.safeParse({ ...task(), context: { pictureMarks: { ...marks, marks: [box] } } }).success).toBe(true);
    expect(Task.safeParse({ ...task(), context: { pictureMarks: { ...marks, marks: [{ ...box, box: { ...box.box, w: 1.5 } }] } } }).success).toBe(false);
  });
});

describe("CreateTaskRequest", () => {
  it("makes an edit by default and doesn't let the app set the engine's own dialogue fields", () => {
    const parsed = CreateTaskRequest.parse({ agent: "codex", instruction: "Add captions", context: { dialogueOperation: "first-cut", time: 3 } });
    expect(parsed.kind).toBe("edit");
    expect(parsed.context).toEqual({ time: 3 });
    expect(CreateTaskRequest.safeParse({ agent: "codex", instruction: "" }).success).toBe(false);
  });
});

describe("request kinds", () => {
  it("counts edits, notes and revisions as project edits only", () => {
    for (const kind of TaskKind.options) expect(isProjectEditTask({ kind })).toBe(PROJECT_EDIT_TASK_KINDS.includes(kind));
    expect(isProjectEditTask({ kind: "note" })).toBe(true);
    expect(isProjectEditTask({ kind: "skill_edit" })).toBe(false);
  });

  it("names exactly the side-check kinds the engine claims in their own slots", () => {
    expect(TaskKind.options.filter(kind => isSideCheck({ kind }))).toEqual([...SIDE_CHECK_KINDS].sort((a, b) => TaskKind.options.indexOf(a) - TaskKind.options.indexOf(b)));
    expect(isSideCheck({ kind: "skill_edit" })).toBe(false);
  });

  it("keeps every side check, skill and style-guide edit and retired B-roll run out of the conversation", () => {
    const aside = TaskKind.options.filter(kind => isAsideTask({ kind }));
    expect(aside).toEqual(["skill_edit", "style_guide_edit", "learning_check", "area_check", "listen_check", "hand_off", "batch_summary", "broll_make"]);
  });
});

describe("sideCheckSlots", () => {
  it("runs twice as many side checks as requests, at least two and at most twelve", () => {
    expect(sideCheckSlots(0)).toBe(2);
    expect(sideCheckSlots(-3)).toBe(2);
    expect(sideCheckSlots(1)).toBe(2);
    expect(sideCheckSlots(4)).toBe(8);
    expect(sideCheckSlots(6)).toBe(12);
    expect(sideCheckSlots(20)).toBe(12);
  });
});

describe("recovering a request", () => {
  it("retries a failed edit that saved nothing, and never a transcription or one that saved a skill", () => {
    expect(canRetryTask(task({ state: "failed" }))).toBe(true);
    expect(canRetryTask(task({ state: "done" }))).toBe(false);
    expect(canRetryTask(task({ state: "failed", kind: "transcribe" }))).toBe(false);
    expect(canRetryTask(task({ state: "failed", changeIds: ["chg_1"] }))).toBe(false);
    expect(canRetryTask(task({ state: "failed", resultSkillId: "skl_1" }))).toBe(false);
    expect(canRetryTask(task({ state: "failed", resultStyleGuideId: "sty_1" }))).toBe(false);
  });

  it("treats an interrupted run, or an older host's time-out, as stopped", () => {
    expect(taskWasStopped(task({ state: "failed", interrupted: true }))).toBe(true);
    expect(taskWasStopped(task({ state: "failed", error: "timed out after 45 minutes" }))).toBe(true);
    expect(taskWasStopped(task({ state: "failed", error: "it timed out" }))).toBe(false);
    expect(taskWasStopped(task({ state: "failed" }))).toBe(false);
    expect(taskWasStopped(task({ state: "running", interrupted: true }))).toBe(false);
  });

  it("knows a finished run still waits for transcripts until it is resumed", () => {
    expect(taskNeedsTranscripts(task({ state: "done", needsTranscripts: ["med_1"] }))).toBe(true);
    expect(taskNeedsTranscripts(task({ state: "done", needsTranscripts: [] }))).toBe(false);
    expect(taskNeedsTranscripts(task({ state: "done", needsTranscripts: ["med_1"], retryTaskId: "tsk_2" }))).toBe(false);
    expect(taskNeedsTranscripts(task({ state: "failed", needsTranscripts: ["med_1"] }))).toBe(false);
  });

  it("offers resume or retry as each kind of ending allows", () => {
    expect(taskRecoveryAction(task({ state: "failed", kind: "transcribe" }), false)).toBeUndefined();
    expect(taskRecoveryAction(task({ state: "failed", resultSkillId: "skl_1" }), false)).toBeUndefined();
    expect(taskRecoveryAction(task({ state: "done", resultStyleGuideId: "sty_1" }), false)).toBeUndefined();
    expect(taskRecoveryAction(task({ state: "cancelled" }), false)).toBe("resume");
    expect(taskRecoveryAction(task({ state: "failed", interrupted: true }), false)).toBe("resume");
    expect(taskRecoveryAction(task({ state: "done", needsTranscripts: ["med_1"] }), false)).toBe("resume");
    expect(taskRecoveryAction(task({ state: "failed" }), false)).toBe("retry");
    expect(taskRecoveryAction(task({ state: "failed", resumeRootId: "tsk_0" }), false)).toBe("resume");
    // A change linked elsewhere, or one it saved, means it picks up where it left off.
    expect(taskRecoveryAction(task({ state: "failed" }), true)).toBe("resume");
    expect(taskRecoveryAction(task({ state: "failed", changeIds: ["chg_1"] }), false)).toBe("resume");
    expect(taskRecoveryAction(task({ state: "done" }), false)).toBeUndefined();
    expect(taskRecoveryAction(task({ state: "running" }), false)).toBeUndefined();
  });

  it("knows a finished pass whose old closing check couldn't run", () => {
    const audit = { version: "v1", returns: 0 };
    expect(closingCheckFailed(task({ state: "done", repeatAudit: { ...audit, failed: "no transcript" } }))).toBe(true);
    expect(closingCheckFailed(task({ state: "done", repeatAudit: audit }))).toBe(false);
    expect(closingCheckFailed(task({ state: "done" }))).toBe(false);
    expect(closingCheckFailed(task({ state: "failed", repeatAudit: { ...audit, failed: "no transcript" } }))).toBe(false);
  });
});

describe("live authoring targets", () => {
  const live = { hostId: "hst_1", state: "running" as const };

  it("lets a live skill-from-change run write only the skill the editor named", () => {
    const authoring = task({ ...live, kind: "skill_from_change", context: { changeId: "chg_1", skillName: "tight-joins" } });
    expect(skillTaskTarget(authoring, "prj_1")).toEqual({ name: "tight-joins", changeId: "chg_1", hostId: "hst_1" });
    expect(skillTaskTarget({ ...authoring, state: "claimed" }, "prj_1")).toBeDefined();
    expect(skillTaskTarget(authoring, "prj_2")).toBeUndefined();
    expect(skillTaskTarget({ ...authoring, hostId: null }, "prj_1")).toBeUndefined();
    expect(skillTaskTarget({ ...authoring, state: "done" }, "prj_1")).toBeUndefined();
    expect(skillTaskTarget({ ...authoring, kind: "edit" }, "prj_1")).toBeUndefined();
    expect(skillTaskTarget({ ...authoring, context: { skillName: "tight-joins" } }, "prj_1")).toBeUndefined();
    expect(skillTaskTarget({ ...authoring, context: { changeId: "chg_1" } }, "prj_1")).toBeUndefined();
  });

  it("lets a live skill edit revise only the skill it is about", () => {
    const editing = task({ ...live, kind: "skill_edit", context: { skillId: "skl_1" } });
    expect(skillEditTarget(editing, "prj_1")).toEqual({ skillId: "skl_1", hostId: "hst_1" });
    expect(skillEditTarget({ ...editing, state: "claimed" }, "prj_1")).toBeDefined();
    expect(skillEditTarget({ ...editing, state: "queued" }, "prj_1")).toBeUndefined();
    expect(skillEditTarget({ ...editing, context: {} }, "prj_1")).toBeUndefined();
    expect(skillEditTarget({ ...editing, kind: "style_guide_edit" }, "prj_1")).toBeUndefined();
    expect(skillEditTarget(editing, "prj_2")).toBeUndefined();
    expect(skillEditTarget({ ...editing, hostId: null }, "prj_1")).toBeUndefined();
  });

  it("lets a live style-guide edit revise only the guide it is about", () => {
    const editing = task({ ...live, kind: "style_guide_edit", context: { styleGuideId: "sty_1" } });
    expect(styleGuideEditTarget(editing, "prj_1")).toEqual({ styleGuideId: "sty_1", hostId: "hst_1" });
    expect(styleGuideEditTarget({ ...editing, state: "claimed" }, "prj_1")).toBeDefined();
    expect(styleGuideEditTarget({ ...editing, state: "waiting_for_user" }, "prj_1")).toBeUndefined();
    expect(styleGuideEditTarget({ ...editing, context: {} }, "prj_1")).toBeUndefined();
    expect(styleGuideEditTarget({ ...editing, kind: "skill_edit" }, "prj_1")).toBeUndefined();
    expect(styleGuideEditTarget(editing, "prj_2")).toBeUndefined();
    expect(styleGuideEditTarget({ ...editing, hostId: null }, "prj_1")).toBeUndefined();
  });
});

describe("DialogueScanPage", () => {
  it("accepts a page still being scanned and one finished inside its stretch", () => {
    expect(DialogueScanPage.safeParse({ mediaId: "med_1", from: 0, end: 10 }).success).toBe(true);
    expect(DialogueScanPage.safeParse({ mediaId: "med_1", from: 0, end: 10, to: 10 }).success).toBe(true);
  });

  it("refuses a page that ends before it starts or finishes outside its stretch", () => {
    expect(DialogueScanPage.safeParse({ mediaId: "med_1", from: 5, end: 5 }).success).toBe(false);
    expect(DialogueScanPage.safeParse({ mediaId: "med_1", from: 0, end: 10, to: 0 }).success).toBe(false);
    expect(DialogueScanPage.safeParse({ mediaId: "med_1", from: 0, end: 10, to: 11 }).success).toBe(false);
  });
});

describe("questionChoicesOf", () => {
  it("returns two to four short trimmed answers", () => {
    expect(questionChoicesOf({ choices: [" Keep it ", "Cut it"] })).toEqual(["Keep it", "Cut it"]);
  });

  it("returns nothing for a malformed set", () => {
    expect(questionChoicesOf(undefined)).toBeUndefined();
    expect(questionChoicesOf({})).toBeUndefined();
    expect(questionChoicesOf({ choices: ["Only one"] })).toBeUndefined();
    expect(questionChoicesOf({ choices: ["a", "b", "c", "d", "e"] })).toBeUndefined();
    expect(questionChoicesOf({ choices: ["a", "  "] })).toBeUndefined();
    expect(questionChoicesOf({ choices: ["a", "x".repeat(81)] })).toBeUndefined();
  });
});

describe("planText", () => {
  it("writes one step a line with its state", () => {
    expect(planText([
      { text: "Find the retakes", state: "done" },
      { text: "Cut them", state: "in_progress" },
      { text: "Check the joins", state: "pending" },
    ])).toBe("[x] Find the retakes\n[>] Cut them\n[ ] Check the joins");
  });

  it("says the plan was cleared when it has no steps", () => {
    expect(planText([])).toBe("Plan cleared");
  });
});

describe("taskPlan", () => {
  const plan = (steps: unknown): Pick<TaskEvent, "type" | "data"> => ({ type: "plan", data: { steps } });
  const step = { text: "Cut it", state: "pending" };

  it("is the last plan the harness reported", () => {
    expect(taskPlan([plan([step]), { type: "log" }, plan([{ ...step, state: "done" }]), { type: "tool" }])).toEqual([{ text: "Cut it", state: "done" }]);
  });

  it("is none after the editor answers, until a new plan arrives", () => {
    expect(taskPlan([plan([step]), { type: "answer" }])).toBeUndefined();
    expect(taskPlan([plan([step]), { type: "answer" }, plan([step])])).toEqual([step]);
  });

  it("is none when the last plan was cleared or malformed, or there was none", () => {
    expect(taskPlan([plan([step]), plan([])])).toBeUndefined();
    expect(taskPlan([plan([step]), plan([{ text: "", state: "pending" }])])).toBeUndefined();
    expect(taskPlan([plan([step]), { type: "plan" }])).toBeUndefined();
    expect(taskPlan([{ type: "log" }])).toBeUndefined();
    expect(taskPlan([])).toBeUndefined();
  });
});
