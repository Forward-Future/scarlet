import type { EditKind, ThreadEdit } from "@scarlet/shared";
import { focusAround, type ProgressFocus } from "../components/player/SimpleProgress";
import { lengthLabel } from "./format";

const WORDS: Partial<Record<EditKind, string>> = {
  cut: "Cut", restore: "Added", audio: "Audio", zoom: "Zoom", reframe: "Reframe", text: "Text", overlay: "Overlay", speed: "Speed",
};

/** One word for what an edit did, the same in the list, on the timeline and on the card. None for an assembly or a mix. */
export function editKindWord(edit: Pick<ThreadEdit, "kind">): string | undefined {
  return edit.kind && WORDS[edit.kind];
}

/**
 * The one note an applied edit's card shows: Scarlet's sentence on what the edit did. An edit saved before Scarlet wrote
 * one reads as its title, then its reason to look, as plain text.
 */
export function editNote(edit: Pick<ThreadEdit, "label" | "check" | "summary">): string {
  if (edit.summary) return edit.summary;
  return edit.check ? `${edit.label.replace(/[.!?]+$/, "")}. ${edit.check}` : edit.label;
}

/**
 * Where an edit sits on the timeline, drawn for what it did. A removal has no frames left, so a line marks its join.
 * Footage put back reads as added. Anything else keeps its footage, so After plays it: it's outlined and named, never
 * hatched like removed footage.
 */
export function editFocus(edit: ThreadEdit, duration: number): ProgressFocus | undefined {
  const word = editKindWord(edit);
  if (edit.at !== undefined) return focusAround({ start: edit.at, end: edit.at }, duration, word ?? "Cut");
  const restored = edit.kind === "restore";
  return focusAround(edit.range, duration, restored ? `Added · ${lengthLabel(edit.range.end - edit.range.start)}` : word,
    { tone: restored ? "added" : "kept" });
}
