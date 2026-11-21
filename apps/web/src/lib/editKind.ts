import { REVISED_CHECK, type EditKind, type ThreadEdit } from "@scarlet/shared";
import { focusAround, type ProgressFocus } from "../components/player/SimpleProgress";
import { lengthLabel } from "./format";

const WORDS: Partial<Record<EditKind, string>> = {
  cut: "Cut", restore: "Added", audio: "Audio", zoom: "Zoom", reframe: "Reframe", text: "Text", broll: "B-roll", overlay: "Overlay", graphic: "Graphic", speed: "Speed", transition: "Transition",
};

/** One word for what an edit did, the same in the list, on the timeline and on the card. None for an assembly or a mix. */
export function editKindWord(edit: Pick<ThreadEdit, "kind">): string | undefined {
  return edit.kind && WORDS[edit.kind];
}

/**
 * The word at the end of an edit's row in a list, so every row has one: what it did, "To do" for a marker left for the
 * editor, or "Edit" for an assembly or a mix of several things.
 */
export function editRowWord(edit: Pick<ThreadEdit, "kind" | "marker">): string {
  return editKindWord(edit) ?? (edit.marker ? "To do" : "Edit");
}

/** The card shows why Scarlet made the edit and what to check. */
export function editNote(edit: Pick<ThreadEdit, "label" | "check" | "summary" | "reason" | "recheck" | "marker" | "todo" | "reviewSays">, reviewFirst = false): string {
  // A marker changed nothing the editor sees or hears: what it asks of them is the point, so it comes first. A revision
  // only says it was revised, so what the marker asks is kept apart from it.
  const todo = edit.marker ? edit.todo ?? (edit.check !== REVISED_CHECK ? edit.check : undefined) : undefined;
  if (todo) {
    const why = edit.reason || edit.summary;
    if (!why) return todo;
    return said(why, todo) ? why : `${todo.replace(/[.!?]*$/, ".")} ${why.replace(/[.!?]*$/, ".")}`;
  }
  // A located review starts with what the editor should look for in the passage. The card says where that passage is
  // now, so times the words gave in an older clock are left out.
  if (reviewFirst && edit.check) {
    const why = edit.reason || edit.summary || edit.label;
    const look = edit.reviewSays || edit.check;
    return said(why, look) ? why : `${endSentence(look)} ${endSentence(why)}`;
  }
  if (edit.reason) {
    if (!edit.check || edit.reason.includes(edit.check)) return edit.reason;
    return `${/[.!?]$/.test(edit.reason) ? edit.reason : `${edit.reason}.`} ${edit.check}`;
  }
  // Older summaries may already include the original review cue. A later doubt still needs to be shown.
  if (edit.summary && edit.recheck && edit.check) return `${edit.summary.replace(/[.!?]*$/, ".")} ${edit.check.replace(/[.!?]*$/, ".")}`;
  if (edit.summary) return edit.summary;
  return edit.check ? `${edit.label.replace(/[.!?]+$/, "")}. ${edit.check}` : edit.label;
}

const endSentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;

/** Whether a sentence already says a few words, whatever their case, spacing and closing stop. */
function said(sentence: string | undefined, words: string) {
  const plain = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  return !!sentence && plain(sentence).includes(plain(words));
}

/**
 * Where an edit sits on the timeline, drawn for what it did. A removal has no frames left, so a line marks its join.
 * Footage put back reads as added. Anything else keeps its footage, so After plays it: it's outlined and named, never
 * hatched like removed footage.
 */
export function editFocus(edit: ThreadEdit, duration: number): ProgressFocus | undefined {
  const word = editKindWord(edit);
  // A marker at a point took nothing out, so it isn't drawn or named as a cut.
  if (edit.at !== undefined) return focusAround({ start: edit.at, end: edit.at }, duration, word ?? (edit.marker ? undefined : "Cut"),
    edit.marker ? { tone: "kept" } : undefined);
  const restored = edit.kind === "restore";
  return focusAround(edit.range, duration, restored ? `Added · ${lengthLabel(edit.range.end - edit.range.start)}` : word,
    { tone: restored ? "added" : "kept" });
}
