import { expect, it } from "vitest";
import type { Task, TaskEvent } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { runAim, runItems, runLines, runSummary, workTime } from "./taskRun";

const task = { id: "tsk", projectId: "prj", kind: "edit", agent: "codex", instruction: "/dialogue-pass", context: {}, state: "done",
  createdBy: { type: "user", id: "usr", name: "Matt" }, changeIds: ["chg_assembly", "chg_pass"], question: null,
  summary: "I cut the mic checks, rehearsals and repeated takes.", createdAt: "2026-11-05T03:34:17.000Z",
  startedAt: "2026-11-05T03:34:17.000Z", finishedAt: "2026-11-05T03:38:38.000Z" } as unknown as Task;
const at = (s: number) => new Date(Date.parse("2026-11-05T03:34:17.000Z") + s * 1000).toISOString();
const tool = (s: number, name: string, input: object = {}): TaskEvent => ({ at: at(s), type: "tool", text: `scarlet.${name} {}`, data: { tool: `scarlet.${name}`, input } });
const log = (s: number, text: string, data?: TaskEvent["data"]): TaskEvent => ({ at: at(s), type: "log", text, ...(data ? { data } : {}) });
const assembly = { id: "chg_assembly", description: "Placed the full recording at 0:00 so its picture and dialogue can be edited together.", state: "approved" } as unknown as Change;
const pass = { id: "chg_pass", description: "Review 116 optional dialogue cuts", state: "ready",
  cutReasons: [{ start: 10, end: 70, reason: "Mic check" }, { start: 100, end: 112, reason: "Rehearsal" }] } as unknown as Change;

it("turns a run's events into short updates and one line per finished step", () => {
  const events: TaskEvent[] = [
    log(0, "Starting the editing agent."),
    log(4, "I’m using the dialogue-pass workflow to review the full recording."),
    tool(5, "project_get"), tool(6, "timeline_get"), tool(7, "skills_list"),
    tool(9, "task_log", { text: "I’m placing the full recording on the empty timeline." }),
    log(9, "I’m placing the full recording on the empty timeline.", { kind: "editor_progress", activity: "Preparing assembly" }),
    { at: at(10), type: "error", text: "scarlet.timeline_first_cut failed: Input validation error" },
    { at: at(46), type: "change", text: "Proposed change chg_assembly", data: { changeId: "chg_assembly" } },
    log(47, "", { kind: "editor_progress", scanPage: { mediaId: "med", from: 0, to: 600, end: 3467.597 } }),
    tool(60, "frame_contact_sheet_batch", { windows: [{}, {}, {}] }), tool(62, "frame_contact_sheet_batch", { windows: [{}, {}] }),
    tool(64, "waveform_get"),
    log(80, "", { kind: "editor_progress", scanPage: { mediaId: "med", from: 600, to: 3467.597, end: 3467.597 } }),
    log(240, "I found a complete DeepSeek introduction after the mic checks. I’m checking the joins around those takes. Then I’ll write it up."),
    log(261, "I cut the mic checks, rehearsals and repeated takes."),
  ];
  expect(runItems(task, events, [assembly, pass])).toEqual([
    { kind: "note", at: at(4), text: "I’m using the dialogue-pass workflow to review the full recording." },
    { kind: "step", at: at(5), verb: "Read", detail: "the project" },
    { kind: "note", at: at(9), text: "I’m placing the full recording on the empty timeline." },
    { kind: "step", at: at(46), verb: "Placed", detail: "the full recording at 0:00 so its picture and dialogue can be edited together", edit: true },
    { kind: "step", at: at(47), verb: "Scanned", detail: "all 57:47 of dialogue", pending: false, background: true },
    { kind: "step", at: at(60), verb: "Looked at", detail: "the picture in 5 places" },
    { kind: "step", at: at(64), verb: "Checked", detail: "the sound" },
    { kind: "note", at: at(240), text: "I found a complete DeepSeek introduction after the mic checks. I’m checking the joins around those takes." },
  ]);
});

it("takes what the request will come to from the agent's first words, only when it said them before it began", () => {
  const aim = "I’ll take the retakes and dead air out and bring you any cut I’m unsure of.";
  const host = [log(0, "Starting the editing agent."), log(1, "Claude Code session started (opus); Scarlet MCP connected", { kind: "init" })];
  // Said as a message, ahead of its first tool call: the first sentence is the aim, and `note` is the update it makes in runItems.
  const spoken = [...host, log(2, `${aim} First I’ll read the project.`), tool(3, "project_get")];
  expect(runAim(spoken)).toEqual({ text: aim, note: `${aim} First I’ll read the project.` });
  expect(runItems({ ...task, state: "running" }, spoken, [])[0]).toEqual({ kind: "note", at: at(2), text: runAim(spoken)!.note });
  // Said through the tool that speaks: that call is not work begun.
  expect(runAim([...host, tool(2, "task_log", { text: aim }), log(2, aim, { kind: "editor_progress", activity: "Starting" }), tool(3, "project_get")])?.text).toBe(aim);
  // A plan made first changes nothing: making one looks at nothing.
  expect(runAim([...host, { at: at(1), type: "plan", text: "", data: { steps: [] } } as TaskEvent, log(2, aim)])?.text).toBe(aim);
  // An agent that went straight to work said none. Its first update is about a step.
  expect(runAim([...host, tool(2, "project_get"), log(9, "The intro is mapped out.")])).toBeUndefined();
  expect(runAim([...host, log(3, "", { kind: "editor_progress", scanPage: { mediaId: "med", from: 0, to: 600, end: 3467.597 } }), log(9, aim)])).toBeUndefined();
  expect(runAim([...host, { at: at(2), type: "change", text: "Proposed change chg_assembly", data: { changeId: "chg_assembly" } }, log(9, aim)])).toBeUndefined();
  expect(runAim(host)).toBeUndefined();
});

it("counts every cut a multi-cut inspection checks, and a whole-picture look as one", () => {
  const events = [tool(1, "dialogue_review_inspect", { index: 0, count: 4 }), tool(3, "dialogue_review_inspect", { index: 4, count: 3 }),
    tool(5, "dialogue_review_inspect", { index: 2, count: 4, wholePicture: true })];
  expect(runItems({ ...task, state: "running" }, events, [])).toEqual([{ kind: "step", at: at(1), verb: "Checked", detail: "8 suggested cuts" }]);
});

it("keeps an unfinished scan pending so the live row can show it", () => {
  const events = [log(1, "", { kind: "editor_progress", scanPage: { mediaId: "med", from: 0, to: 600, end: 3467.597 } })];
  expect(runItems({ ...task, state: "running" }, events, [])).toEqual([
    { kind: "step", at: at(1), verb: "Scanned", detail: "10:00 of 57:47 of dialogue", pending: true, background: true },
  ]);
});

it("says where each step looked, and drops repeats of the same call", () => {
    const transcript = { mediaId: "cam", from: 0, to: 3467.597, granularity: "segment" };
    const events = [
      tool(1, "transcript_get", transcript),
      tool(2, "media_frame", { mediaId: "cam", t: 24 }), tool(3, "media_frame", { mediaId: "cam", t: 93 }), tool(4, "media_frame", { mediaId: "cam", t: 185 }),
      tool(5, "transcript_get", transcript),
      tool(6, "frame_contact_sheet_batch", { windows: [{ from: 360, to: 372 }, { from: 3280, to: 3290 }] }),
      tool(7, "frame_contact_sheet_batch", { batchId: "pictures_1", cursor: 2 }),
      tool(8, "transcript_get", transcript),
      tool(9, "transcript_search", { mediaId: "cam", query: "DeepSeek" }),
    ];
    expect(runItems({ ...task, state: "running" }, events, []).map(i => i.kind === "step" ? `${i.verb} ${i.detail}` : i.text)).toEqual([
      "Read the transcript from 0:00 to 57:47",
      "Looked at the picture in 5 places from 0:24 to 54:50",
      "Searched the transcript for “DeepSeek”",
    ]);
    const few = runItems({ ...task, state: "running" }, events.slice(1, 4), []);
    expect(few).toEqual([{ kind: "step", at: at(2), verb: "Looked at", detail: "the picture at 0:24, 1:33 and 3:05" }]);
});

it("shows a wait for the transcript as one row instead of every call that checks on it", () => {
    const read = { mediaId: "cam", from: 0, to: 3467.597 };
    const wait = (s: number, done?: boolean) => log(s, "", { kind: "media_wait", wait: "transcript", mediaId: "cam", ...(done ? { done } : {}) });
    const events = [
      tool(10, "transcript_get", read), wait(25),
      tool(30, "media_frame", { mediaId: "cam", t: 24 }), tool(40, "transcript_get", read), tool(41, "transcript_get", { mediaId: "cam", from: 60 }),
      tool(50, "media_frame", { mediaId: "cam", t: 93 }),
    ];
    const running = { ...task, state: "running" } as Task;
    expect(runItems(running, events, [])).toEqual([
      { kind: "step", at: at(10), verb: "Waiting", detail: "for the transcript", background: true },
      { kind: "step", at: at(30), verb: "Looked at", detail: "the picture at 0:24 and 1:33" },
    ]);
    const done = [...events, wait(370, true), tool(371, "transcript_get", read)];
    expect(runItems(running, done, []).map(i => i.kind === "step" && `${i.verb} ${i.detail}`)).toEqual([
      "Waited 6:00 for the transcript", "Looked at the picture at 0:24 and 1:33", "Read the transcript from 0:00 to 57:47",
    ]);
    // The wait ran alongside the other steps, so it takes no time of its own in the list.
    expect(runLines(running, done, runItems(running, done, []), Date.parse(at(400))).map(l => l.took)).toEqual([undefined, 341_000, 29_000]);
});

it("gives each step the time until the next one starts, so the steps add up to the header", () => {
    const events = [
      tool(6, "project_get"),
      tool(16, "audio_sync"), tool(16.4, "frame_contact_sheet_batch", { windows: [{ from: 16, to: 18 }] }),
      log(30, "The presenter and screen are synced."),
      tool(60, "waveform_get", { mediaId: "cam", from: 25, to: 31 }),
      { at: at(70), type: "question" as const, text: "Keep the intro?" }, { at: at(170), type: "answer" as const, text: "Yes" },
      tool(180, "dialogue_check_join", { joins: [{}] }),
    ];
    const running = { ...task, state: "running" } as Task;
    const lines = runLines(running, events, runItems(running, events, []), Date.parse(at(200)));
    expect(lines).toEqual([
      { kind: "step", text: "Read the project", took: 10_000 },
      // Started together, so their time can't be split.
      { kind: "step", text: "Lined up the sound and looked at the picture from 0:16 to 0:18", took: 44_000 },
      { kind: "note", text: "The presenter and screen are synced." },
      // Time spent waiting for your answer never counts.
      { kind: "step", text: "Checked the sound from 0:25 to 0:31", took: 20_000 },
      { kind: "step", text: "Checking a join", took: 20_000, live: true },
    ]);
    const finished = { ...task, finishedAt: at(190) } as Task;
    expect(runLines(finished, events, runItems(finished, events, []), Date.now()).at(-1)).toEqual({ kind: "step", text: "Checked a join", took: 10_000 });
    // Three steps started together read as one sentence. An edit always keeps its own line.
    const together = [tool(1, "dialogue_check_join"), tool(1.2, "project_get"), tool(1.4, "media_frame", { t: 5 }),
      { at: at(1.6), type: "change" as const, text: "", data: { changeId: "chg_assembly" } }];
    expect(runLines(finished, together, runItems(finished, together, [assembly]), Date.now()).map(l => l.text)).toEqual([
      "Checked a join, read the project and looked at the picture at 0:05",
      "Placed the full recording at 0:00 so its picture and dialogue can be edited together",
    ]);
});

it("sums up a run in a few words", () => {
  expect(runSummary(task, pass)).toBe("Suggested 1:12 in 2 cuts");
  expect(runSummary(task, { ...pass, state: "approved" } as Change)).toBe("Removed 1:12 in 2 cuts");
  // It reads as a cut's own length does: to a tenth under ten seconds, and what rounds up to a minute as one, never "60 s".
  const removing = (seconds: number) => runSummary(task, { ...pass, cutReasons: [{ ...pass.cutReasons![0]!, start: 10, end: 10 + seconds }] } as Change);
  expect(removing(0.2)).toBe("Suggested 0.2 s in 1 cut");
  expect(removing(59.4)).toBe("Suggested 59 s in 1 cut");
  expect(removing(59.6)).toBe("Suggested 1:00 in 1 cut");
  expect(removing(65.7)).toBe("Suggested 1:06 in 1 cut");
  expect(runSummary(task, assembly)).toBe("Placed the full recording at 0:00…");
  expect(runSummary(task, { ...assembly, timelineEdits: [{ label: "Synchronized camera and screen", range: { start: 0, end: 1 } }] } as Change))
    .toBe("Synchronized camera and screen");
  expect(runSummary({ ...task, state: "failed" } as Task)).toBe("Couldn’t finish");
  expect(runSummary({ ...task, state: "failed" } as Task, assembly)).toBe("Placed the full recording at 0:00…");
  const zoom = { ...assembly, description: "From 0:03 to 56:41, a fixed 14% zoom enlarges the app windows and trims the taskbar.",
    timelineEdits: [{ label: "the screen demonstrations", range: { start: 3, end: 3401 } }] } as Change;
  expect(runSummary(task, zoom)).toBe("A fixed 14% zoom enlarges the app…");
});

it("never counts time spent waiting for your answer", () => {
  const ev = (s: number, type: "question" | "answer"): TaskEvent => ({ at: at(s), type, text: "" });
  // Finished run: 261 s start to finish, 200 s of it waiting on a question.
  expect(workTime(task, [ev(30, "question"), ev(230, "answer")], Date.now())).toBe(61_000);
  // Still waiting: the clock stopped when the question was asked, however long you take.
  const asking = { ...task, state: "waiting_for_user", finishedAt: null } as unknown as Task;
  expect(workTime(asking, [ev(30, "question")], Date.parse(at(5000)))).toBe(30_000);
});

it("leaves a message shown as the run's reply out of its updates", () => {
  const closing = "The first pass is saved.\n\n- **Applied:** the mic check.";
  const events = [log(1, "Reading the dialogue."), tool(5, "dialogue_apply_cuts"), log(9, closing)];
  expect(runItems(task, events, [], closing).flatMap(item => item.kind === "note" ? [item.text] : [])).toEqual(["Reading the dialogue."]);
});
