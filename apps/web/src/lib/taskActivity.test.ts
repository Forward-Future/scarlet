import { describe, expect, it } from "vitest";
import type { TaskEvent } from "@scarlet/shared";
import { editConfirmation, mergeTaskEvents, pendingMediaWaits, taskActivityLabel } from "./taskActivity";

const reading: TaskEvent = { id: "r", at: "2026-10-31T12:00:00Z", type: "tool", text: "", data: { tool: "scarlet.transcript_get" } };
const trimming: TaskEvent = { id: "t", at: "2026-10-31T12:00:02Z", type: "log", text: "Trimming dead air: found five pauses." };
/** What the newest event that says anything says, as the working row reads it. */
const latest = (events: readonly TaskEvent[]) => events.map(event => taskActivityLabel(event)).filter(Boolean).at(-1);

describe("working row activity", () => {
  it.each(["mcp__scarlet__waveform_get", "scarlet__waveform_get", "mcp_scarlet_waveform_get", "scarlet.waveform_get", "waveform_get", "waveform.get"])("recognizes tool names from each host: %s", (tool) => {
    expect(latest([reading, { type: "tool", text: tool + " range=0–12" }])).toBe("Checking the sound");
  });

  it("switches to the new step and ignores raw diagnostic output", () => {
    expect(latest([reading])).toBe("Reading transcript");
    expect(latest([reading, { type: "log", text: "Found 3 candidate fillers: two repeats and a pause." }])).toBe("Found candidate fillers");
    expect(latest([{ type: "log", text: "Checking the waveform for the remaining clips" }])).toBe("Checking waveform");
    expect(latest([reading, trimming, { type: "log", text: "warning: transient connection error" }])).toBe("Trimming dead air");
    expect(latest([trimming, { type: "tool", text: "", data: { tool: "captions_generate" } }])).toBe("Generating captions");
  });

  it("says how much a read covers, and that a repeated read is waiting for the transcript", () => {
    const read: TaskEvent = { type: "tool", text: "", data: { tool: "scarlet.transcript_get", input: { mediaId: "cam", from: 0, to: 3467.6 } } };
    expect(taskActivityLabel(read)).toBe("Reading transcript 0:00–57:47");
    const waiting: TaskEvent = { type: "log", text: "Waiting for the transcript", data: { kind: "media_wait", wait: "transcript", mediaId: "cam" } };
    expect(latest([read, waiting])).toBe("Waiting for the transcript");
    expect(taskActivityLabel(read, false, pendingMediaWaits([waiting]))).toBe("Waiting for the transcript");
    const ready: TaskEvent = { ...waiting, data: { ...waiting.data, done: true } };
    expect(taskActivityLabel(read, false, pendingMediaWaits([waiting, ready]))).toBe("Reading transcript 0:00–57:47");
    // Another recording's transcript isn't the one being waited for.
    expect(taskActivityLabel({ ...read, data: { ...read.data, input: { mediaId: "screen", from: 0 } } }, false, pendingMediaWaits([waiting]))).toBe("Reading transcript at 0:00");
  });

  it("names the cuts a multi-cut inspection checks", () => {
    const inspect = (input: object): TaskEvent => ({ type: "tool", text: "", data: { tool: "scarlet.dialogue_review_inspect", input } });
    expect(latest([inspect({ index: 4 })])).toBe("Checking a suggested cut · Cut 5");
    expect(latest([inspect({ index: 4, count: 4 })])).toBe("Checking suggested cuts · Cuts 5–8");
    expect(latest([inspect({ index: 4, count: 4, wholePicture: true })])).toBe("Checking a suggested cut · Cut 5");
  });

  it("shows a dropped model stream as a reconnect", () => {
    expect(latest([reading, { type: "log", text: "Reconnecting... 2/5 (stream disconnected)", data: { kind: "connection" } }]))
      .toBe("Reconnecting to the model");
  });

  it("keeps the current activity through a recoverable scan error", () => {
    expect(latest([reading, { type: "tool", text: "scarlet.dialogue_scan" },
      { type: "error", text: "scarlet.dialogue_scan failed" }])).toBe("Scanning dialogue");
  });

  it("uses a progress tool's activity immediately, without leaking its arguments or reasoning", () => {
    expect(latest([{ type: "tool", text: "", data: { tool: "scarlet.task_log", input: { text: trimming.text } } }])).toBe("Trimming dead air");
    expect(latest([{ type: "log", text: "internal details", data: { kind: "reasoning" } }])).toBe("Planning next step");
    expect(latest([reading, { type: "tool", text: "custom_tool private_arguments" }])).toBe("Reading transcript");
  });

  it("keeps up to three complete result sentences and skips commands, tool output and repeated instructions", () => {
    const request = "Tighten the intro.";
    const result = "I removed the false start at 0:12. I kept the pause before the next line. The music now fades under the cut.";
    expect(editConfirmation([request, "$ ls -la", "Created `chg_123`.", "```sh\necho internal data\n```", result, "Done."].join("\n"), request)).toBe(result);
    expect(editConfirmation("From 0:00 to 29:39, the screen recording fills the frame with your face in the bottom right.")).toContain("your face in the bottom right.");
    expect(editConfirmation("git status\nffmpeg -i movie.mp4")).toBeUndefined();
    // "<1 s" and "> 3 s" are prose. A tag or an arrow is a transcript of the tools.
    expect(editConfirmation("I left both pauses. The one at 2:05 is <1 s, so cutting it would clip the breath. The one at 2:31 runs > 1 s."))
      .toBe("I left both pauses. The one at 2:05 is <1 s, so cutting it would clip the breath. The one at 2:31 runs > 1 s.");
    expect(editConfirmation("Done.\n<system-reminder>internal</system-reminder>\nclip_a -> clip_b\nSaved => ok")).toBe("Done.");
    expect(editConfirmation("The framing is ready.\n\n- Cropped the camera\n- Kept the inset width\n$ ls -la", undefined, "full"))
      .toBe("The framing is ready.\n\n• Cropped the camera.\n• Kept the inset width.");
  });

  it("keeps the newest live step when a slower history request finishes", () => {
    const merged = mergeTaskEvents([reading], [reading, trimming]);
    expect(merged.map((e) => e.id)).toEqual(["r", "t"]);
    expect(latest(merged)).toBe("Trimming dead air");
    expect(latest(mergeTaskEvents([trimming], [reading]))).toBe("Trimming dead air");
  });
});
