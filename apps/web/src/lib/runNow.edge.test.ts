import { expect, it } from "vitest";
import type { TaskEvent } from "@scarlet/shared";
import { runNow, STARTING } from "./runNow";

const tool = (name: string, input?: unknown): TaskEvent => ({ type: "tool", text: name, data: { tool: `scarlet.${name}`, input } as TaskEvent["data"] });
const log = (text: string, data?: TaskEvent["data"]): TaskEvent => ({ type: "log", text, ...(data && { data }) });
const said = (name: string, input?: unknown) => runNow([tool(name, input)]);

it("says every call on the project that has words of its own", () => {
  expect([
    "project_get", "media_list", "notes_list", "media_profile", "source_audio", "lip_sync", "timeline_join_audit",
    "dialogue_review_save", "dialogue_revise_cut", "timeline_get", "timeline_summary", "timeline_at", "timeline_propose",
    "timeline_sync_multicam", "timeline_switch_cameras", "multicam_analyze", "render_request", "render_status", "skills_list",
  ].map(name => said(name))).toEqual([
    "Looking at the project", "Looking through your footage", "Reading your notes", "Measuring the sound", "Checking the original sound",
    "Checking the lip sync", "Checking how the joins sound", "Saving the calls on the flagged cuts", "Moving the cut",
    "Looking at the timeline", "Looking at the timeline", "Looking at the timeline", "Making the edit", "Syncing cameras and audio",
    "Switching camera angles", "Matching speakers to cameras", "Rendering a preview", "Waiting for the preview", "Reading the skills",
  ]);
});

it("says where in the recording a call looks, as a span when it covers a second or more and a moment otherwise", () => {
  expect(said("music_beats", { from: 30, to: 90 })).toBe("Finding the beat of the music 0:30–1:30");
  expect(said("music_beats", { from: 30, to: 30.5 })).toBe("Finding the beat of the music at 0:30");
  expect(said("music_beats", { to: 90 })).toBe("Finding the beat of the music");
  expect(said("transcript_get", { from: 61, to: 125 })).toBe("Reading the transcript 1:01–2:05");
  expect(said("screen_motion", { from: 5 })).toBe("Watching where the screen changes at 0:05");
  expect(said("screen_reading", { from: 0, to: 600 })).toBe("Finding where the screen is read aloud 0:00–10:00");
  expect(said("faces", { from: -3, to: 10 })).toBe("Finding where the faces are");
  expect(said("faces", { from: Number.NaN })).toBe("Finding where the faces are");
  expect(said("frame_contact_sheet", { start: 12, end: 20 })).toBe("Looking at the picture 0:12–0:20");
  expect(said("sound_picture", { start: 4 })).toBe("Looking at the waveform at 0:04");
  expect(said("media_frame")).toBe("Looking at the picture");
  expect(said("media_frame", "not an object")).toBe("Looking at the picture");
  expect(said("dialogue_scan", { from: "12" })).toBe("Reading the dialogue from the start");
});

it("quotes what Scarlet searches for or writes, trimmed and cut short, and says the plain work without it", () => {
  expect(said("transcript_search", { query: "   " })).toBe("Searching the transcript");
  expect(said("transcript_search", { query: `  ${"a".repeat(50)}  ` })).toBe(`Searching the transcript for “${"a".repeat(40)}”`);
  expect(said("transcript_fix", { replace: " Kubernetes " })).toBe("Writing “Kubernetes” in the transcript");
  expect(said("transcript_fix", { replace: "" })).toBe("Correcting the transcript");
  expect(said("transcript_fix", { replace: 4 })).toBe("Correcting the transcript");
  expect(said("screen_text", { query: "Pricing" })).toBe("Searching the screen for “Pricing”");
  expect(said("screen_text", { query: " ", from: 10, to: 20 })).toBe("Reading the text on screen 0:10–0:20");
  expect(said("screen_text")).toBe("Reading the text on screen");
});

it("counts the cuts it saves and says where, from a passage's span or its start", () => {
  expect(said("dialogue_apply_cuts", { cuts: [{}] })).toBe("Saving 1 cut");
  expect(said("dialogue_apply_cuts", {})).toBe("Saving the cuts");
  expect(said("dialogue_apply_cuts", { cuts: [], range: { start: 60, end: 60.4 } })).toBe("Saving the cuts from 1:00");
  expect(said("dialogue_apply_cuts", { cuts: [{}, {}], range: "all" })).toBe("Saving 2 cuts");
  expect(said("dialogue_apply_cuts", { cuts: [{}, {}], range: { end: 30 } })).toBe("Saving 2 cuts");
  expect(said("dialogue_check_join", { cuts: "many" })).toBe("Checking how the join sounds");
});

it("listens to a flagged cut by its time only when the call has one", () => {
  expect(said("dialogue_review_inspect", {})).toBe("Listening to a flagged cut");
  expect(said("dialogue_review_inspect", { index: -1 })).toBe("Listening to a flagged cut");
  expect(said("dialogue_review_inspect", { index: 2 })).toBe("Listening to a flagged cut");
  expect(runNow([tool("dialogue_review_inspect", { index: 2, count: 1 })], undefined, () => undefined)).toBe("Listening to a flagged cut");
  expect(runNow([tool("dialogue_review_inspect", { index: 0, changeId: "chg" })], undefined, (id, index) => id === "chg" && index === 0 ? 5 : undefined)).toBe("Listening to the cut at 0:05");
});

it("walks back past Scarlet's empty or opening notes and log lines with no words to the last thing it said or did", () => {
  const aim = "I’ll tighten the takes.";
  expect(runNow([tool("project_get"), tool("task_log", { text: aim })], aim)).toBe("Looking at the project");
  expect(runNow([tool("media_list"), tool("task_log", { text: 7 })])).toBe("Looking through your footage");
  expect(runNow([tool("media_list"), tool("task_log")])).toBe("Looking through your footage");
  expect(runNow([tool("media_list"), tool("task_log", "text")])).toBe("Looking through your footage");
  expect(runNow([tool("notes_list"), log("   ")])).toBe("Reading your notes");
  expect(runNow([tool("notes_list"), log("Review 3 of 9", { kind: "editor_progress", reviewCounter: "3/9" })])).toBe("Reading your notes");
  expect(runNow([tool("notes_list"), log("Here is something", { kind: "usage" })])).toBe("Reading your notes");
  expect(runNow([tool("notes_list"), log("Trimmed the slow open.", { kind: "editor_progress" })])).toBe("Trimmed the slow open.");
  expect(runNow([tool("notes_list"), { type: "plan", text: "" }])).toBe("Reading your notes");
});

it("says nothing for a run with no events and a getting-started line before the first call", () => {
  expect(runNow([])).toBeUndefined();
  expect(runNow([tool("custom_thing"), log("", { kind: "init" })])).toBe(STARTING);
  expect(runNow([log("", { kind: "init" }), tool("custom_thing")])).toBe(STARTING);
});

it("passes over a wait whose end came later and still says one for another file", () => {
  const wait = (mediaId: string, done?: boolean) => log("Waiting for the transcript", { kind: "media_wait", wait: "transcript", mediaId, ...(done && { done }) });
  expect(runNow([tool("project_get"), wait("cam"), wait("cam", true)])).toBe("Looking at the project");
  expect(runNow([tool("project_get"), wait("mic"), wait("cam", true)])).toBe("Waiting for the transcript");
});
