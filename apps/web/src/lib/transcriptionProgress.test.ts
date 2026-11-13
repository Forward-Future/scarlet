import { describe, expect, it } from "vitest";
import type { Task } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import { mediaProblems, mediaWarningLabel, projectedFraction, runTranscripts, transcriptionProgressLabel, transcriptsProgress } from "./transcriptionProgress";

const task = (mediaId: string, progress?: Task["progress"], state: Task["state"] = "running") => ({
  id: `tsk_${mediaId}`, projectId: "prj", kind: "transcribe", agent: "api", instruction: `Transcribe ${mediaId}`, context: { mediaId },
  state, createdBy: { type: "scarlet", name: "Scarlet" }, hostId: null, changeIds: [], question: null, summary: null, progress,
}) as Task;

describe("transcription progress", () => {
  it("labels a transcription waiting its turn, and one under way with its percent and no guess at the time left", () => {
    expect(transcriptionProgressLabel(undefined)).toBeUndefined();
    expect(transcriptionProgressLabel({ stage: "queued", fraction: 0 })).toBe("waiting its turn");
    expect(transcriptionProgressLabel({ stage: "transcribing", fraction: 0.2 })).toBe("20%");
    expect(transcriptionProgressLabel({ stage: "aligning", fraction: 0.45, remainingSeconds: 185 })).toBe("45%");
    // A job still running never reads 100%.
    expect(transcriptionProgressLabel({ stage: "aligning", fraction: 0.996 })).toBe("99%");
    expect(transcriptionProgressLabel({ stage: "aligning", fraction: 0.996, remainingSeconds: 0.2 })).toBe("99%");
    expect(transcriptionProgressLabel({ stage: "aligning", fraction: 1, remainingSeconds: 0 })).toBe("100%");
  });

  it("weights the transcripts a run waits for by recording length and adds their time left", () => {
    const media = [{ id: "cam", duration: 3000 }, { id: "mic", duration: 1000 }];
    expect(transcriptsProgress([], media, ["cam"])).toBeUndefined();
    expect(transcriptsProgress([task("cam", { stage: "queued", fraction: 0 })], media, ["cam", "mic"])).toEqual({ stage: "queued", fraction: 0 });
    expect(transcriptsProgress([
      task("cam", { stage: "aligning", fraction: 0.5, remainingSeconds: 120 }),
      task("mic", { stage: "transcribing", fraction: 1, remainingSeconds: 0 }),
      task("old", { stage: "transcribing", fraction: 0.9 }, "done"),
    ], media, ["cam", "mic"])).toEqual({ stage: "transcribing", fraction: 0.625, remainingSeconds: 120 });
    // A transcript still queued has no estimate yet, so the total time left is unknown.
    expect(transcriptsProgress([task("cam", { stage: "aligning", fraction: 0.5, remainingSeconds: 120 }), task("mic", { stage: "queued", fraction: 0 })],
      media, ["cam", "mic"])).toEqual({ stage: "aligning", fraction: 0.375 });
  });

  it("counts the words alone, which is all a run waits for, so the figure doesn't stop at a third", () => {
    const media = [{ id: "cam", duration: 3000 }, { id: "mic", duration: 1000 }];
    // Whisper is a third of the job: 90% of the words are in while the whole job says 30%, with its alignment still to come.
    const whisper = task("cam", { stage: "transcribing", fraction: 0.3, remainingSeconds: 900, words: { fraction: 0.9, remainingSeconds: 30 } });
    expect(transcriptsProgress([whisper], media, ["cam"])).toEqual({ stage: "transcribing", fraction: 0.9, remainingSeconds: 30 });
    expect(transcriptionProgressLabel(transcriptsProgress([whisper], media, ["cam"]))).toBe("90%");
    // The mic's words are saved while its alignment has ten minutes to go: the run has nothing left to wait for there.
    const aligning = task("mic", { stage: "aligning", fraction: 0.4, remainingSeconds: 600, words: { fraction: 1 } });
    expect(transcriptsProgress([whisper, aligning], media, ["cam", "mic"])).toEqual({ stage: "transcribing", fraction: 0.925, remainingSeconds: 30 });
  });

  it("keeps a recording whose transcript is saved as done, so the figure doesn't start again when one of several finishes", () => {
    const media = [{ id: "cam", duration: 3000 }, { id: "mic", duration: 1000 }];
    const micSaved = [media[0]!, { ...media[1]!, transcriptId: "trs_mic" }];
    const words = (mediaId: string, fraction: number, remainingSeconds: number) =>
      task(mediaId, { stage: "transcribing", fraction: fraction / 3, remainingSeconds: remainingSeconds * 3, words: { fraction, remainingSeconds } });
    const waiting = task("cam", { stage: "queued", fraction: 0 });
    // The camera waits its turn behind the mic, which has 90% of its words: 23% of the two.
    expect(transcriptionProgressLabel(transcriptsProgress([waiting, words("mic", 0.9, 20)], media, ["cam", "mic"]))).toBe("23%");
    // The mic's transcript is saved and its task is done. The camera has 3% of its words: with the mic's share still
    // counted that is 27% of the two, and the time left is the camera's alone. With the mic counted as nothing once its
    // task had ended, the figure fell back to 2%.
    const done = task("mic", undefined, "done");
    const after = transcriptsProgress([words("cam", 0.03, 480), done], micSaved, ["cam", "mic"]);
    expect(after).toEqual({ stage: "transcribing", fraction: 0.2725, remainingSeconds: 480 });
    expect(transcriptionProgressLabel(after)).toBe("27%");
    // Saved while its alignment still runs, it counts the same.
    const aligning = task("mic", { stage: "aligning", fraction: 0.4, remainingSeconds: 600, words: { fraction: 1 } });
    expect(transcriptsProgress([words("cam", 0.03, 480), aligning], micSaved, ["cam", "mic"])).toEqual(after);
    // Whether there is a figure at all is up to the recordings still without a transcript. A lone one waiting its turn
    // says so, one whose transcription isn't running has none, and with every transcript saved nothing is left to count.
    expect(transcriptsProgress([waiting, done], micSaved, ["cam", "mic"])).toEqual({ stage: "queued", fraction: 0 });
    expect(transcriptsProgress([done], micSaved, ["cam", "mic"])).toBeUndefined();
    expect(transcriptsProgress([aligning], micSaved, ["mic"])).toBeUndefined();
  });
});

describe("the transcripts a run waits on", () => {
  const media = [{ id: "cam", duration: 3000 }, { id: "mic", duration: 1000 }];
  const since = "2026-11-06T21:43:33.000Z";
  const finished = (mediaId: string, finishedAt: string) => ({ ...task(mediaId, undefined, "done"), finishedAt });

  it("counts a transcript still waiting its turn at the pace of the one running", () => {
    // 30% of the camera in, 1260 s left: 0.6 s of work per second of recording. The mic adds 600 s.
    expect(runTranscripts([task("cam", { stage: "aligning", fraction: 0.3, remainingSeconds: 1260 }), task("mic", { stage: "queued", fraction: 0 })],
      media, ["cam", "mic"], since)).toEqual({ fraction: 0.225, total: 4000, queued: false, done: false, remainingSeconds: 1860, key: "tsk_cam,tsk_mic" });
    // Before either has an estimate there is no time left to show.
    expect(runTranscripts([task("cam", { stage: "transcribing", fraction: 0.01 }), task("mic", { stage: "queued", fraction: 0 })],
      media, ["cam", "mic"], since)).toEqual({ fraction: 0.0075, total: 4000, queued: false, done: false, key: "tsk_cam,tsk_mic" });
    expect(runTranscripts([task("cam", { stage: "queued", fraction: 0 })], media, ["cam"], since)?.queued).toBe(true);
  });

  it("keeps a transcript finished during the run as done, and leaves out one finished before it", () => {
    expect(runTranscripts([finished("cam", "2026-11-06T22:10:00.000Z"), task("mic", { stage: "aligning", fraction: 0.5, remainingSeconds: 60 })],
      media, ["cam", "mic"], since)).toEqual({ fraction: 0.875, total: 4000, queued: false, done: false, remainingSeconds: 60, key: "tsk_cam,tsk_mic" });
    expect(runTranscripts([finished("cam", "2026-11-06T22:10:00.000Z")], media, ["cam"], since)).toEqual({ fraction: 1, total: 3000, queued: false, done: true, key: "tsk_cam" });
    expect(runTranscripts([finished("cam", "2026-11-06T20:00:00.000Z")], media, ["cam"], since)).toBeUndefined();
    expect(runTranscripts([task("cam", { stage: "queued", fraction: 0 })], media, ["cam"], undefined)).toBeUndefined();
  });

  it("counts a transcript as done once its words are saved, while their alignment goes on", () => {
    // Whisper is a third of the job, and all a pass waits for: 40% of the words in, 90 s of Whisper left.
    const whisper = task("cam", { stage: "transcribing", fraction: 0.13, remainingSeconds: 900, words: { fraction: 0.4, remainingSeconds: 90 } });
    expect(runTranscripts([whisper], media, ["cam"], since)).toEqual({ fraction: 0.4, total: 3000, queued: false, done: false, remainingSeconds: 90, key: "tsk_cam" });
    // The words are saved and the pass reads them. Alignment has ten minutes to go, and the run doesn't wait for it.
    const aligning = task("cam", { stage: "aligning", fraction: 0.4, remainingSeconds: 600, words: { fraction: 1 } });
    expect(runTranscripts([aligning], media, ["cam"], since)).toEqual({ fraction: 1, total: 3000, queued: false, done: true, key: "tsk_cam" });
    expect(runTranscripts([aligning, task("mic", { stage: "queued", fraction: 0, words: { fraction: 0 } })], media, ["cam", "mic"], since))
      .toMatchObject({ fraction: 0.75, done: false, queued: false });
  });

  it("names the transcriptions it counts, so one that starts again as a new task is a different job", () => {
    const mic = task("mic", { stage: "queued", fraction: 0 });
    const key = (tasks: Task[]) => runTranscripts(tasks, media, ["cam", "mic"], since)?.key;
    // The same tasks are the same job however far along they are, named in the order the run asked for its recordings.
    expect(key([task("cam", { stage: "aligning", fraction: 0.3, remainingSeconds: 1260 }), mic])).toBe("tsk_cam,tsk_mic");
    expect(key([mic, task("cam", { stage: "aligning", fraction: 0.97, remainingSeconds: 60 })])).toBe("tsk_cam,tsk_mic");
    // An interrupted transcription isn't counted. The task that starts it again is, under its own id.
    const restarted = { ...task("cam", { stage: "aligning", fraction: 0.02, remainingSeconds: 1470 }), id: "tsk_cam_again" };
    expect(key([restarted, task("cam", undefined, "failed"), mic])).toBe("tsk_cam_again,tsk_mic");
  });

  it("counts a recording's newest transcription whichever way the task list is ordered", () => {
    // The camera's transcript finished during the run, and the editor then asked for it again.
    const first = { ...finished("cam", "2026-11-06T22:10:00.000Z"), createdAt: "2026-11-06T21:50:00.000Z" };
    const again = { ...task("cam", { stage: "transcribing", fraction: 0.1, remainingSeconds: 900 }), id: "tsk_cam_again", createdAt: "2026-11-06T22:15:00.000Z" };
    const stage = { fraction: 0.1, total: 3000, queued: false, done: false, remainingSeconds: 900, key: "tsk_cam_again" };
    expect(runTranscripts([first, again], media, ["cam"], since)).toEqual(stage);
    // After a reload the list is newest first.
    expect(runTranscripts([again, first], media, ["cam"], since)).toEqual(stage);
  });

  it("moves a figure between reports at the pace its time left implies, for a while, and never past 99%", () => {
    expect(projectedFraction(0.3, 700, 0)).toBe(0.3);
    expect(projectedFraction(0.3, 700, 70)).toBeCloseTo(0.37);
    // Past the horizon the bar stops, so a stalled transcript shows as stalled.
    expect(projectedFraction(0.3, 700, 600)).toBeCloseTo(projectedFraction(0.3, 700, 240));
    expect(projectedFraction(0.98, 10, 200)).toBe(0.99);
    expect(projectedFraction(0.3, undefined, 70)).toBe(0.3);
  });

  it("flags media whose last transcription failed or that couldn't be read, but not a retried or finished one", () => {
    const asset = (id: string, extra: Partial<MediaAsset> = {}) => ({ id, name: `${id}.mov`, kind: "video", status: "ready", ...extra }) as MediaAsset;
    const at = (t: Task, createdAt: string) => ({ ...t, createdAt });
    const media = [asset("cam"), asset("mic"), asset("done", { transcriptId: "tr" }), asset("broken", { status: "failed" }), asset("still")];
    const tasks = [
      at(task("cam", undefined, "failed"), "2026-11-06T10:00:00Z"),
      at(task("mic", undefined, "failed"), "2026-11-06T10:00:00Z"), at(task("mic"), "2026-11-06T11:00:00Z"),
      at(task("done", undefined, "failed"), "2026-11-06T10:00:00Z"),
    ];
    expect(mediaProblems(tasks, media).map(p => [p.asset.id, p.problem])).toEqual([["cam", "transcription"], ["broken", "unreadable"]]);
  });

  it("leaves out a transcription the pause stopped while the project is paused", () => {
    const cam = { id: "cam", name: "cam.mov", kind: "video", status: "ready" } as MediaAsset;
    const stopped = { ...task("cam", undefined, "failed"), interrupted: true };
    expect(mediaProblems([stopped], [cam], true)).toEqual([]);
    // Resumed, it starts again by itself. One still cut off then is a problem like any other.
    expect(mediaProblems([stopped], [cam]).map(p => p.problem)).toEqual(["transcription"]);
    // One that failed by itself needs the editor, paused or not.
    expect(mediaProblems([task("cam", undefined, "failed")], [cam], true).map(p => p.problem)).toEqual(["transcription"]);
  });

  it("doesn't flag a failed transcription of a file with no audio track, which Media offers no transcript for", () => {
    const screen = { id: "screen", name: "screen.mov", kind: "video", status: "ready", hasAudio: false } as MediaAsset;
    expect(mediaProblems([task("screen", undefined, "failed")], [screen])).toEqual([]);
    expect(mediaProblems([task("screen", undefined, "failed")], [{ ...screen, hasAudio: true }]).map(p => p.problem)).toEqual(["transcription"]);
  });

  it("names the one file with a problem for the Media button, and counts several", () => {
    const unreadable = { asset: { id: "broken", name: "broken.mov", kind: "video", status: "failed" } as MediaAsset, problem: "unreadable" as const };
    const stopped = { asset: { id: "cam", name: "cam.mov", kind: "video" } as MediaAsset, problem: "transcription" as const };
    expect(mediaWarningLabel([])).toBeUndefined();
    expect(mediaWarningLabel([unreadable])).toBe("Couldn’t read broken.mov");
    expect(mediaWarningLabel([stopped])).toBe("Transcription stopped for cam.mov");
    expect(mediaWarningLabel([stopped, unreadable])).toBe("2 files need attention");
  });
});
