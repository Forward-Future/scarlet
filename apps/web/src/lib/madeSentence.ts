import type { EditKind, ThreadEdit } from "@scarlet/shared";
import { editNote } from "./editKind";
import { plural } from "./format";

type Listed = Pick<ThreadEdit, "label" | "beforeCut" | "kind" | "summary" | "check">;

/** A stretch of the sentence: plain words, or a figure that reads in bold. */
export type SentencePart = string | { strong: string };

/** What each kind of edit is called when the sentence counts it. A kind with no word of its own counts as an edit. */
const NOUNS: Partial<Record<EditKind, [one: string, many: string]>> = {
  restore: ["passage put back", "passages put back"], audio: ["sound fix", "sound fixes"], zoom: ["zoom", "zooms"], reframe: ["reframe", "reframes"],
  text: ["text edit", "text edits"], overlay: ["overlay", "overlays"], speed: ["speed change", "speed changes"],
};

/** How many of a request's edits are named in its sentence before it counts them by kind instead. */
const NAMED = 3;

/**
 * What a request changed in the video, as one sentence with its figures in bold. Every figure is counted from the
 * request's edits, so the sentence is right whatever the request was: cuts say how much came out, and anything else
 * is counted by what it did. A few edits that aren't cuts are named instead of counted. A request that made one edit
 * says what Scarlet said about that edit. An edit made in several places is one edit, unless the list under the
 * sentence has a row for each place (`eachPlace`): then the sentence counts what that list shows.
 */
export function madeSentence(edits: readonly Listed[], length: (seconds: number) => string, eachPlace = false): SentencePart[] {
  const cuts = edits.filter(e => e.beforeCut);
  const places = new Map<string, { edit: Listed; places: number }>();
  edits.forEach((edit, i) => {
    if (edit.beforeCut) return;
    const key = eachPlace ? String(i) : edit.label, same = places.get(key);
    if (same) same.places++; else places.set(key, { edit, places: 1 });
  });
  const others = [...places.values()];
  if (!cuts.length && !others.length) return [];
  if (cuts.length + others.length === 1) {
    const only = cuts[0] ?? others[0]!.edit, many = others[0]?.places ?? 1;
    const said = editNote(only).trim();
    if (many === 1) return [/[.!?]$/.test(said) ? said : `${said}.`];
    return [`${only.label.replace(/[.!?]+$/, "")}, in `, { strong: plural(many, "place") }, "."];
  }
  const parts: SentencePart[] = [];
  if (cuts.length) {
    const removed = cuts.reduce((sum, e) => sum + Math.max(0, e.beforeCut!.removed.end - e.beforeCut!.removed.start), 0);
    if (removed > 0) parts.push("Took out ", { strong: length(removed) }, " in ", { strong: plural(cuts.length, "cut") });
    else parts.push("Made ", { strong: plural(cuts.length, "cut") });
  }
  if (others.length) {
    if (!cuts.length && others.length <= NAMED) {
      parts.push("Made ", { strong: String(others.length) }, ` edits: ${others.map(o => o.edit.label.replace(/[.!?]+$/, "")).join(", ")}`);
    } else {
      // Counted by what they did, in the order each kind first appears.
      const counts = new Map<string, { n: number; noun: [string, string] }>();
      const plain: [string, string] = cuts.length || others.some(o => o.edit.kind && NOUNS[o.edit.kind]) ? ["other edit", "other edits"] : ["edit", "edits"];
      for (const { edit } of others) {
        const noun = (edit.kind && NOUNS[edit.kind]) || plain;
        const count = counts.get(noun[0]);
        if (count) count.n++; else counts.set(noun[0], { n: 1, noun });
      }
      const listed = [...counts.values()];
      parts.push(cuts.length ? ", and made " : "Made ");
      listed.forEach(({ n, noun }, i) => {
        if (i) parts.push(i === listed.length - 1 ? " and " : ", ");
        parts.push({ strong: String(n) }, ` ${n === 1 ? noun[0] : noun[1]}`);
      });
    }
  }
  parts.push(".");
  return parts;
}

/** The sentence as plain text, for a title or a label. */
export const sentenceText = (parts: readonly SentencePart[]) => parts.map(part => typeof part === "string" ? part : part.strong).join("");
