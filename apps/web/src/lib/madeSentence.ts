import type { EditKind, ThreadEdit } from "@scarlet/shared";
import { plural } from "./format";

type Listed = Pick<ThreadEdit, "label" | "beforeCut" | "kind" | "summary" | "elsewhere" | "marker">;

/** A stretch of the sentence: plain words, or a figure that reads in bold. */
export type SentencePart = string | { strong: string };

/** What each kind of edit is called when the sentence counts it. A kind with no word of its own counts as an edit. */
const NOUNS: Partial<Record<EditKind, [one: string, many: string]>> = {
  restore: ["passage put back", "passages put back"], audio: ["sound fix", "sound fixes"], zoom: ["zoom", "zooms"], reframe: ["reframe", "reframes"],
  text: ["text edit", "text edits"], broll: ["B-roll shot", "B-roll shots"], overlay: ["overlay", "overlays"], graphic: ["graphic", "graphics"], speed: ["speed change", "speed changes"],
  transition: ["transition", "transitions"],
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
export function madeSentence(listed: readonly Listed[], length: (seconds: number) => string, eachPlace = false): SentencePart[] {
  // An edit another request made is listed for a doubt this one raised about it. This request didn't make it.
  // A marker changed nothing in the video: it is a spot left for the editor, counted on its own.
  const cuts: Listed[] = [];
  const places = new Map<string, { edit: Listed; places: number }>(), spots = new Map<string, { edit: Listed; places: number }>();
  listed.forEach((edit, i) => {
    if (edit.elsewhere) return;
    if (edit.beforeCut) return void cuts.push(edit);
    const group = edit.marker ? spots : places;
    const key = eachPlace ? String(i) : edit.label, same = group.get(key);
    if (same) same.places++; else group.set(key, { edit, places: 1 });
  });
  const others = [...places.values()], marked = [...spots.values()];
  if (cuts.length + others.length + marked.length === 0) return [];
  if (cuts.length + others.length + marked.length === 1) {
    const { edit: only, places: many } = cuts[0] ? { edit: cuts[0], places: 1 } : others[0] ?? marked[0]!;
    const said = (only.summary || only.label).trim();
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
    // Graphics are counted however few: their names are the words on them, which say little in a sentence.
    if (!cuts.length && others.length <= NAMED && !others.every(o => o.edit.kind === "graphic")) {
      parts.push("Made ", { strong: String(others.length) }, ` ${others.length === 1 ? "edit" : "edits"}: ${others.map(o => o.edit.label.replace(/[.!?]+$/, "")).join(", ")}`);
    } else {
      // Counted by what they did, in the order each kind first appears.
      const counts = new Map<string, { n: number; noun: [string, string] }>();
      const plain: [string, string] = cuts.length || others.some(o => o.edit.kind && NOUNS[o.edit.kind]) ? ["other edit", "other edits"] : ["edit", "edits"];
      for (const { edit } of others) {
        const noun = (edit.kind && NOUNS[edit.kind]) || plain;
        const count = counts.get(noun[0]);
        if (count) count.n++; else counts.set(noun[0], { n: 1, noun });
      }
      // Footage put back is said as what was done to it ("put back 1 passage"), never as a thing made.
      const restored = counts.get(NOUNS.restore![0]);
      counts.delete(NOUNS.restore![0]);
      const listed = [...counts.values()];
      if (restored) parts.push(cuts.length ? (listed.length ? ", put back " : " and put back ") : "Put back ",
        { strong: String(restored.n) }, ` ${restored.n === 1 ? "passage" : "passages"}`);
      if (listed.length) parts.push(cuts.length ? ", and made " : restored ? " and made " : "Made ");
      listed.forEach(({ n, noun }, i) => {
        if (i) parts.push(i === listed.length - 1 ? " and " : ", ");
        parts.push({ strong: String(n) }, ` ${n === 1 ? noun[0] : noun[1]}`);
      });
    }
  }
  if (marked.length) parts.push(parts.length ? ", and marked " : "Marked ", { strong: plural(marked.length, "spot") }, " for you");
  parts.push(".");
  return parts;
}

/** The sentence as plain text, for a title or a label. */
export const sentenceText = (parts: readonly SentencePart[]) => parts.map(part => typeof part === "string" ? part : part.strong).join("");
