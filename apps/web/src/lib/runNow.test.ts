import { expect, it } from "vitest";
import type { TaskEvent } from "@scarlet/shared";
import { runNow } from "./runNow";

const tool = (name: string, input: object = {}): TaskEvent => ({ type: "tool", text: name, data: { tool: `scarlet.${name}`, input } });
const log = (text: string, data?: TaskEvent["data"]): TaskEvent => ({ type: "log", text, ...(data && { data }) });

it("says the latest call on the project as the work it is, with where in the recording", () => {
  const said = (event: TaskEvent) => runNow([event]);
  expect(said(tool("audio_sync"))).toBe("Lining up the recordings");
  expect(said(tool("dialogue_scan", { mediaId: "cam", from: 0 }))).toBe("Reading the dialogue from the start");
  expect(said(tool("dialogue_scan", { mediaId: "cam", from: 1914 }))).toBe("Reading the dialogue at 31:54");
  expect(said(tool("transcript_search", { query: "board investigation" }))).toBe("Searching the transcript for “board investigation”");
  expect(said(tool("media_frame", { mediaId: "screen", t: 152.9 }))).toBe("Looking at the picture at 2:32");
  expect(said(tool("frame_contact_sheet_batch", { windows: [{}, {}, {}] }))).toBe("Looking at the picture in 3 passages");
  expect(said(tool("frame_contact_sheet_batch", { batchId: "b", cursor: 2 }))).toBe("Looking at the picture");
  expect(said(tool("waveform_get", { mediaId: "cam", start: 62, end: 70 }))).toBe("Looking at the waveform 1:02–1:10");
  expect(said(tool("dialogue_check_join", { cuts: [{}] }))).toBe("Checking how the join sounds");
  expect(said(tool("dialogue_check_join", { cuts: [{}, {}, {}] }))).toBe("Checking how 3 joins sound");
  expect(said(tool("dialogue_apply_cuts", { range: { start: 0, end: 155 }, cuts: [{}, {}, {}, {}] }))).toBe("Saving 4 cuts in 0:00–2:35");
  // A cut is named by its call's number, the one on its card. One Scarlet hasn't asked about has no number to say.
  expect(said(tool("dialogue_review_inspect", { index: 4, count: 4 }))).toBe("Listening to 4 flagged cuts");
  expect(said(tool("dialogue_review_inspect", { index: 4, count: 4, wholePicture: true }))).toBe("Listening to a flagged cut");
  expect(runNow([tool("dialogue_review_inspect", { changeId: "chg", index: 57 })], undefined, (id, index) => id === "chg" && index === 57 ? 2 : undefined)).toBe("Listening to Cut 2");
  // A call with no words of its own here reads as it does elsewhere; one Scarlet can't name says nothing.
  expect(said(tool("captions_generate"))).toBe("Making captions");
  expect(said(tool("export_otio"))).toBe("Exporting timeline");
  expect(said(tool("custom_tool"))).toBeUndefined();
  // The whole video is the video, never the edit. A rule Scarlet picked up is offered in Learnings, not said in the chat.
  expect(said(tool("timeline_transcript"))).toBe("Reading the video’s words");
  expect(runNow([tool("audio_sync"), tool("learning_suggest")])).toBe("Lining up the recordings");
});

it("puts Scarlet's own latest sentence on the line, but not the one it opened with, and passes over the engine's background counts", () => {
  const aim = "I’ll tighten the takes.";
  expect(runNow([log("Starting the editing agent."), log(aim)], aim)).toBeUndefined();
  expect(runNow([log(aim), tool("project_get"), log("The opening is saved.")], aim)).toBe("The opening is saved.");
  expect(runNow([log("The opening is saved."), tool("dialogue_scan", { from: 58 })])).toBe("Reading the dialogue at 0:58");
  expect(runNow([tool("task_log", { text: "Trimming the long pause." })])).toBe("Trimming the long pause.");
  const behind = [tool("dialogue_check_join", { cuts: [{}, {}] }),
    log("Dialogue scan · a.mp4", { kind: "editor_progress", scanPage: { mediaId: "cam", from: 0, to: 60, end: 600 } }),
    log("", { kind: "join_progress", mediaId: "cam", through: 90 }), log("", { kind: "pass_progress", mediaId: "cam", through: 90 }),
    { type: "change", text: "Proposed change chg_1", data: { changeId: "chg_1" } } as TaskEvent];
  expect(runNow(behind)).toBe("Checking how 2 joins sound");
});

it("says when Scarlet starts, thinks, waits or reconnects", () => {
  expect(runNow([log("Codex session started", { kind: "init" })])).toBe("Getting started");
  expect(runNow([tool("project_get"), log("", { kind: "reasoning" })])).toBe("Thinking");
  expect(runNow([log("Reconnecting… 2/5", { kind: "connection" })])).toBe("Reconnecting to the model");
  const waiting = log("Waiting for the transcript", { kind: "media_wait", wait: "transcript", mediaId: "cam" });
  expect(runNow([waiting])).toBe("Waiting for the transcript");
  expect(runNow([tool("transcript_get", { mediaId: "cam" }), waiting, { ...waiting, data: { ...waiting.data, done: true } }])).toBe("Reading the transcript");
  expect(runNow([waiting, tool("transcript_get", { mediaId: "cam" })])).toBe("Waiting for the transcript");
  expect(runNow([{ type: "answer", text: "White" }])).toBe("Reading your answer");
});
