import { describe, expect, it } from "vitest";
import { DialogueRangeRequest, DialogueScanRequest, DialogueWindowRequest, InspectionReviewRequest, PictureActivityRequest, SheetRequest, SourceAudioRequest } from "./inspection.js";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const reason = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } }, value: unknown) =>
  schema.safeParse(value).error?.issues.map(i => i.message).join("; ");

describe("a contact sheet request", () => {
  it("defaults to nine evenly spaced frames", () => {
    expect(SheetRequest.parse({ mediaId: "m1", from: 0, to: 30 })).toEqual({ mediaId: "m1", from: 0, to: 30, count: 9, mode: "uniform" });
  });

  it("is of a source or a version of the cut, never both", () => {
    expect(ok(SheetRequest, { from: 0, to: 30 })).toBe(true);
    expect(ok(SheetRequest, { version: "v1", from: 0, to: 30 })).toBe(true);
    expect(reason(SheetRequest, { mediaId: "m1", version: "v1", from: 0, to: 30 })).toBe("Choose source mediaId or timeline version");
  });

  it("covers a positive window of up to two minutes, twelve seconds when checking screen activity", () => {
    expect(ok(SheetRequest, { from: 10, to: 130 })).toBe(true);
    expect(reason(SheetRequest, { from: 10, to: 130.5 })).toBe("Choose a positive window up to 120 seconds");
    expect(reason(SheetRequest, { from: 10, to: 10 })).toBe("Choose a positive window up to 120 seconds");
    expect(reason(SheetRequest, { from: 10, to: 5 })).toBe("Choose a positive window up to 120 seconds");
    expect(ok(SheetRequest, { from: 10, to: 22, mode: "activity" })).toBe(true);
    expect(reason(SheetRequest, { from: 10, to: 22.5, mode: "activity" })).toBe("Check screen activity in windows up to twelve seconds");
    expect(ok(SheetRequest, { from: 10, to: 22.5, mode: "scene" })).toBe(true);
  });

  it("takes six to twelve frames and a focus inside the window", () => {
    expect(ok(SheetRequest, { from: 0, to: 30, count: 6 })).toBe(true);
    expect(ok(SheetRequest, { from: 0, to: 30, count: 12 })).toBe(true);
    for (const count of [5, 13, 7.5]) expect(ok(SheetRequest, { from: 0, to: 30, count }), String(count)).toBe(false);
    expect(ok(SheetRequest, { from: 10, to: 30, focus: 10 })).toBe(true);
    expect(reason(SheetRequest, { from: 10, to: 30, focus: 30 })).toBe("Focus must be within the window");
    expect(reason(SheetRequest, { from: 10, to: 30, focus: 9.9 })).toBe("Focus must be within the window");
    expect(ok(SheetRequest, { from: -1, to: 30 })).toBe(false);
    expect(ok(SheetRequest, { from: 0, to: Infinity })).toBe(false);
  });
});

describe("the other inspection requests", () => {
  it("measure picture activity in one to twenty-four source windows of up to two minutes", () => {
    const window = { mediaId: "m1", from: 0, to: 120 };
    expect(ok(PictureActivityRequest, { windows: [window] })).toBe(true);
    expect(ok(PictureActivityRequest, { windows: Array(24).fill(window) })).toBe(true);
    expect(ok(PictureActivityRequest, { windows: Array(25).fill(window) })).toBe(false);
    expect(ok(PictureActivityRequest, { windows: [] })).toBe(false);
    expect(reason(PictureActivityRequest, { windows: [{ ...window, to: 120.1 }] })).toBe("Choose a positive window up to 120 seconds");
    expect(ok(PictureActivityRequest, { windows: [{ ...window, mediaId: "" }] })).toBe(false);
  });

  it("audition up to eight seconds of a source, of the mix or one confirmed voice", () => {
    expect(ok(SourceAudioRequest, { mediaId: "m1", from: 2, to: 10 })).toBe(true);
    expect(ok(SourceAudioRequest, { mediaId: "m1", from: 2, to: 10, voice: "other voices" })).toBe(true);
    expect(reason(SourceAudioRequest, { mediaId: "m1", from: 2, to: 10.1 })).toBe("Choose a source audio window up to eight seconds");
    expect(reason(SourceAudioRequest, { mediaId: "m1", from: 2, to: 2 })).toBe("Choose a source audio window up to eight seconds");
    expect(ok(SourceAudioRequest, { mediaId: "m1", from: 2, to: 10, voice: "guest" })).toBe(false);
  });

  it("read dialogue in a positive source range: any length to scan for a task, up to a minute for one window", () => {
    expect(ok(DialogueRangeRequest, { mediaId: "m1", from: 0, to: 3600 })).toBe(true);
    expect(reason(DialogueRangeRequest, { mediaId: "m1", from: 5, to: 5 })).toBe("Choose a positive source range");
    // The voice picker belongs to auditions only.
    expect(DialogueRangeRequest.parse({ mediaId: "m1", from: 0, to: 9, voice: "me" })).toEqual({ mediaId: "m1", from: 0, to: 9 });
    expect(ok(DialogueScanRequest, { mediaId: "m1", from: 0, to: 3600, taskId: "t1", startedAt: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(ok(DialogueScanRequest, { mediaId: "m1", from: 0, to: 3600 })).toBe(false);
    expect(ok(DialogueScanRequest, { mediaId: "m1", from: 0, to: 3600, taskId: "t1", startedAt: "yesterday" })).toBe(false);
    expect(ok(DialogueWindowRequest, { mediaId: "m1", from: 30, to: 90 })).toBe(true);
    expect(ok(DialogueWindowRequest, { mediaId: "m1", from: 30, to: 38, keptSide: {} })).toBe(true);
    expect(reason(DialogueWindowRequest, { mediaId: "m1", from: 30, to: 38.1, keptSide: {} })).toBe("A kept-side reading covers up to 8 seconds");
    expect(reason(DialogueWindowRequest, { mediaId: "m1", from: 30, to: 90.5 })).toBe("Choose up to sixty source seconds");
    expect(ok(DialogueWindowRequest, { mediaId: "m1", from: 30, to: 90, taskId: "" })).toBe(false);
  });

  it("review a cut at its start with a second and a half either side unless told otherwise", () => {
    expect(InspectionReviewRequest.parse({ changeId: "chg_1" })).toEqual({ changeId: "chg_1", index: 0, edge: "start", handles: 1.5, includeAudio: false });
    expect(ok(InspectionReviewRequest, { changeId: "chg_1", index: 3, edge: "end", handles: 3, includeAudio: true })).toBe(true);
    for (const bad of [{ changeId: "" }, { changeId: "c", index: -1 }, { changeId: "c", index: 1.5 }, { changeId: "c", handles: 0.2 }, { changeId: "c", handles: 3.5 }, { changeId: "c", edge: "middle" }]) {
      expect(ok(InspectionReviewRequest, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
