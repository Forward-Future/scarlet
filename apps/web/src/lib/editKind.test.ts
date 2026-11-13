import { describe, expect, it } from "vitest";
import type { ThreadEdit } from "@scarlet/shared";
import { editFocus, editKindWord, editNote } from "./editKind";

const edit = (extra: Partial<ThreadEdit>): ThreadEdit => ({ changeId: "c", spot: 0, label: "An edit", range: { start: 27, end: 200 }, previous: [], ...extra });

describe("drawing an applied edit on the timeline", () => {
  it("outlines a sound fix and names it, instead of hatching it like removed footage", () => {
    expect(editFocus(edit({ kind: "audio" }), 3000)).toMatchObject({ band: { start: 27, end: 200 }, bandLabel: "Audio", tone: "kept" });
    expect(editFocus(edit({ kind: "zoom", range: { start: 40, end: 44 } }), 3000)).toMatchObject({ bandLabel: "Zoom", tone: "kept" });
  });

  it("marks footage put back as added, with how much", () => {
    expect(editFocus(edit({ kind: "restore", range: { start: 555.4, end: 556.6 } }), 3000))
      .toMatchObject({ bandLabel: "Added · 1.2 s", tone: "added" });
    // A hair under ten seconds reads as ten, not "10.0".
    expect(editFocus(edit({ kind: "restore", range: { start: 100, end: 109.97 } }), 3000)).toMatchObject({ bandLabel: "Added · 10 s" });
    expect(editFocus(edit({ kind: "restore", range: { start: 100, end: 112.4 } }), 3000)).toMatchObject({ bandLabel: "Added · 12 s" });
  });

  it("marks a removal with a line at its join", () => {
    expect(editFocus(edit({ kind: "cut", at: 61, range: { start: 59.5, end: 62.5 } }), 3000))
      .toMatchObject({ band: { start: 61, end: 61 }, bandLabel: "Cut" });
  });

  it("leaves an assembly or a mixed edit unnamed", () => {
    expect(editKindWord(edit({ kind: "other" }))).toBeUndefined();
    expect(editKindWord(edit({}))).toBeUndefined();
  });
});

describe("the note on an applied edit's card", () => {
  it("is Scarlet's summary of the edit and nothing else, flagged or not", () => {
    const summary = "Muted the call audio and the screen recording's demo sound, leaving only the camera mic";
    expect(editNote(edit({ label: "Use camera mic, mute call audio", check: "Screen recording's demo sound is muted too", summary }))).toBe(summary);
    expect(editNote(edit({ label: "Trim the false start", summary: "Trimmed the false start" }))).toBe("Trimmed the false start");
  });

  it("reads an edit saved without a summary as its title, then its reason to look", () => {
    expect(editNote(edit({ label: "Trim the false start" }))).toBe("Trim the false start");
    expect(editNote(edit({ label: "Raise narration volume.", check: "Room tone comes up with it" }))).toBe("Raise narration volume. Room tone comes up with it");
  });
});
