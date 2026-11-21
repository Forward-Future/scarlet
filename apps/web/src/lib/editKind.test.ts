import { describe, expect, it } from "vitest";
import { REVISED_CHECK, type ThreadEdit } from "@scarlet/shared";
import { editFocus, editKindWord, editNote, editRowWord } from "./editKind";

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

  it("names a graphic Scarlet laid over the picture apart from B-roll, and B-roll apart from other overlays", () => {
    expect(editKindWord(edit({ kind: "graphic" }))).toBe("Graphic");
    expect(editKindWord(edit({ kind: "broll" }))).toBe("B-roll");
    expect(editKindWord(edit({ kind: "overlay" }))).toBe("Overlay");
  });

  it("leaves an assembly or a mixed edit unnamed", () => {
    expect(editKindWord(edit({ kind: "other" }))).toBeUndefined();
    expect(editKindWord(edit({}))).toBeUndefined();
  });

  it("gives every row in a list a word, a mix included", () => {
    expect(editRowWord(edit({ kind: "zoom" }))).toBe("Zoom");
    expect(editRowWord(edit({ kind: "other" }))).toBe("Edit");
    expect(editRowWord(edit({ kind: "other", marker: true }))).toBe("To do");
  });
});

describe("the note on an applied edit's card", () => {
  it("shows the reason with a review cue, separately from the summary", () => {
    const reason = "The restart carries the full score.";
    const edited = { label: "Mute the false start", summary: "Muted 0.1 seconds.", reason };
    expect(editNote(edited)).toBe(reason);
    expect(editNote({ ...edited, check: "Listen for the full score" })).toBe(`${reason} Listen for the full score`);
  });
  it("is Scarlet's summary of the edit and nothing else, flagged or not", () => {
    const summary = "Muted the call audio and the screen recording's demo sound, leaving only the camera mic";
    expect(editNote(edit({ label: "Use camera mic, mute call audio", check: "Screen recording's demo sound is muted too", summary }))).toBe(summary);
    expect(editNote(edit({ label: "Trim the false start", summary: "Trimmed the false start" }))).toBe("Trimmed the false start");
    // A doubt a later request raised about it follows the sentence written when it was made.
    expect(editNote({ ...edit({ label: "Carry the quotation", summary: "Kept the quotation into the reaction", check: "Black gap and overlapping lines" }),
      recheck: "2026-11-14T17:52:00.000Z" })).toBe("Kept the quotation into the reaction. Black gap and overlapping lines.");
  });

  it("leads a marker's note with what it asks of the editor, said once", () => {
    const marked = "Marked “throw it on the screen now” where the boat comparison belongs.";
    expect(editNote(edit({ label: "Boat comparison footage", check: "Add the other boat renders", summary: marked, marker: true })))
      .toBe("Add the other boat renders. Marked “throw it on the screen now” where the boat comparison belongs.");
    expect(editNote(edit({ label: "Boat comparison footage", check: "Add the other boat renders", reason: "You asked for it on screen here.", marker: true })))
      .toBe("Add the other boat renders. You asked for it on screen here.");
    // Said already, it isn't said twice.
    const asked = "Marked where the boat comparison belongs: add the other boat renders.";
    expect(editNote(edit({ label: "Boat comparison footage", check: "Add the other boat renders", summary: asked, marker: true }))).toBe(asked);
  });

  it("keeps leading a revised marker's note with what it asks, not with the word for the revision", () => {
    const why = "Moved to where you say the boat line.";
    expect(editNote(edit({ label: "Boat comparison footage", check: REVISED_CHECK, todo: "Add the other boat renders", summary: why, marker: true })))
      .toBe("Add the other boat renders. Moved to where you say the boat line.");
    // A marker the model gave no reason to look asks what the marker itself says.
    expect(editNote(edit({ label: "Boat comparison footage", check: "Comparison footage needed", todo: "Comparison footage needed", marker: true })))
      .toBe("Comparison footage needed");
  });

  it("draws a marker at a point as a plain line, not a red cut", () => {
    const focus = editFocus(edit({ kind: "other", marker: true, at: 144, range: { start: 142.5, end: 145.5 } }), 3000);
    expect(focus).toMatchObject({ band: { start: 144, end: 144 }, tone: "kept" });
    expect(focus?.bandLabel).toBeUndefined();
  });

  it("reads an edit saved without a summary as its title, then its reason to look", () => {
    expect(editNote(edit({ label: "Trim the false start" }))).toBe("Trim the false start");
    expect(editNote(edit({ label: "Raise narration volume.", check: "Room tone comes up with it" }))).toBe("Raise narration volume. Room tone comes up with it");
  });
});
