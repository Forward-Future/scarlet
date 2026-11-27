import { describe, expect, it } from "vitest";
import { compactScanPage, pauseRow, round } from "./dialogue-scan-page.js";
import { DialogueScanBatch } from "./dialogue-scan-batch.js";

const page = {
  mediaId: "m1", from: 812, to: 872, roomToneDbfs: -76,
  passages: [
    { start: 812.08, end: 829.96, text: "But even with that, these findings are incredible.", speaker: "Speaker 1", timing: "word", words: [636, 676] },
    { start: 840.32, end: 847.46, text: "Okay.", speaker: "Speaker 1", timing: "segment" },
  ],
  fillers: [], unmatchedVoice: [{ start: 822.94, end: 823.12 }], voiceDetectionAvailable: true,
  repeatedTakes: [{ phrase: "I'm sorry.", first: { start: 213.32999999999998, end: 216.31, continuation: "" }, next: { start: 219.73, end: 221.91, continuation: "" }, immediateRestart: true }],
  acousticRepeatedTakes: [], fillerCandidates: [], detectors: ["prompted-whisper", "uhm"], detectorIssue: undefined,
  speakerTurns: [{ start: 812, end: 822.9235229492188, speaker: 1 }, { start: 823.8516235351562, end: 826.6866455078125, speaker: 1 }],
  pauses: [
    { remove: { start: 818.48, end: 818.74 }, evidence: "Low levels and no detected voice" },
    { remove: { start: 823.23, end: 823.76 }, before: "didn't.", after: "But", airBefore: .11, airAfter: .12, maxPeakDb: -60 },
    { remove: { start: 831.87, end: 832.45 }, evidence: "Low levels and no detected voice", timingWarning: "Transcript timing crosses this quiet stretch. Review the words before trimming." },
    { remove: { start: 850.4, end: 850.65 }, before: "go?", after: "Oh,", airBefore: .12, airAfter: .11, maxPeakDb: -99, timingWarning: "Word timings disagree with detected speech." },
  ],
  silences: [
    { start: 829.96, end: 840.32, seconds: 10.36, after: "incredible.", before: "Okay.", voiceSeconds: .963, maxPeakDb: -30, picture: [
      { mediaId: "m1", changedFrames: 59, frames: 135, typicalAreaPct: 7.87, largestAreaPct: 22.88, largestAt: 832.375, lastChangeAt: 839.475 },
      { mediaId: "m3", changedFrames: 0, frames: 135 }] },
    { start: 864.62, end: 870.48, seconds: 5.86, after: "said.", before: "Okay.", voiceSeconds: .26, picture: "measuring" as const },
  ],
};

describe("compactScanPage", () => {
  it("keeps every range and measurement, written compactly", () => {
    expect(compactScanPage(page)).toEqual({
      mediaId: "m1", from: 812, to: 872, roomToneDbfs: -76,
      passages: [
        { start: 812.08, end: 829.96, text: "But even with that, these findings are incredible.", speaker: "Speaker 1", words: [636, 676] },
        { start: 840.32, end: 847.46, text: "Okay.", speaker: "Speaker 1", timing: "segment" },
      ],
      unmatchedVoice: [[822.94, 823.12]], voiceDetectionAvailable: true,
      repeatedTakes: [{ phrase: "I'm sorry.", first: { start: 213.33, end: 216.31, continuation: "" }, next: { start: 219.73, end: 221.91, continuation: "" }, immediateRestart: true }],
      // An acoustic reading that found nothing still says it was made.
      acousticRepeatedTakes: [], detectors: ["prompted-whisper", "uhm"],
      speaker: 1,
      pauses: [[818.48, 818.74], [823.23, 823.76, "didn't.", "But", .11, .12, -60], [831.87, 832.45, "timing"], [850.4, 850.65, "go?", "Oh,", .12, .11, -99, "timing"]],
      silences: [
        { start: 829.96, end: 840.32, seconds: 10.36, after: "incredible.", before: "Okay.", voiceSeconds: .96, maxPeakDb: -30, picture: [
          { changedFrames: 59, frames: 135, typicalAreaPct: 7.87, largestAreaPct: 22.88, largestAt: 832.38, lastChangeAt: 839.48 },
          { mediaId: "m3", changedFrames: 0, frames: 135 }] },
        { start: 864.62, end: 870.48, seconds: 5.86, after: "said.", before: "Okay.", voiceSeconds: .26, picture: "measuring" },
      ],
    });
  });

  it("keeps the turns of a page with several voices, to the hundredth", () => {
    const turns = [{ start: 855.8972778320312, end: 857.5341186523438, speaker: 3 }, { start: 857.5341186523438, end: 864.6891479492188, speaker: 1 }];
    const shown = compactScanPage({ ...page, speakerTurns: turns });
    expect(shown.speakerTurns).toEqual([{ start: 855.9, end: 857.53, speaker: 3 }, { start: 857.53, end: 864.69, speaker: 1 }]);
    expect(shown).not.toHaveProperty("speaker");
    expect(compactScanPage({ ...page, speakerTurns: [] })).not.toHaveProperty("speakerTurns");
  });

  it("says what a call shares once, and a restored page only where it differs", () => {
    const first = compactScanPage(page);
    const restored = compactScanPage({ ...page, from: 870, to: 930 }, first);
    for (const key of ["mediaId", "detectors", "voiceDetectionAvailable"]) expect(restored).not.toHaveProperty(key);
    expect(restored).toMatchObject({ from: 870, to: 930 });
    expect(compactScanPage({ ...page, voiceDetectionAvailable: false, detectors: [] }, first)).toMatchObject({ voiceDetectionAvailable: false, detectors: [] });
  });

  it("is less than two thirds the size of the page it compacts", () => {
    const before = JSON.stringify(page).length, after = JSON.stringify(compactScanPage(page)).length;
    expect(after).toBeLessThan(before * 2 / 3);
  });

  it("rounds numbers but not indices or levels", () => {
    expect(round({ a: 1.23456, b: [636, -60, 0.004], c: "x", d: undefined })).toEqual({ a: 1.23, b: [636, -60, 0], c: "x" });
    expect(pauseRow({ remove: { start: 1, end: 2 }, before: "a", after: "b", airBefore: .1, airAfter: .2, maxPeakDb: -50 })).toEqual([1, 2, "a", "b", .1, .2, -50]);
  });
});

describe("DialogueScanBatch.checkpointShown", () => {
  it("gives the whole sentence the first time and a short one after, with the same through", () => {
    const batch = new DialogueScanBatch();
    batch.delivered(0, 60);
    expect(batch.checkpointShown()).toBeUndefined();
    batch.delivered(58, 118);
    const first = batch.checkpointShown()!;
    expect(first).toEqual(batch.checkpoint);
    expect(first.next).toContain("continueFrom");
    const again = batch.checkpointShown()!;
    expect(again.through).toBe(118);
    expect(again.next).toContain("noCutsReadyThrough: 118");
    expect(again.next.length).toBeLessThan(first.next.length / 2);
    // A read past the checkpoint without a save is still refused with the whole sentence.
    expect(() => batch.startRead(116, 176)).toThrow(first.next);
  });
});
