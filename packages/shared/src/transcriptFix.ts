import type { Transcript, TranscriptSegment, TranscriptWord, TranscriptWordFix } from "@scarlet/timeline";
import { normalizeTranscriptToken } from "./transcriptSearch.js";

/** One place a fix changed, by the index the word had before (the index transcript_get showed). */
export interface WordFixPlace {
  index: number;
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface WordFixResult {
  transcript: Transcript;
  places: WordFixPlace[];
  /** How many words the transcript gained (negative: lost) where the fix has another number of words than it replaced. */
  wordsAdded: number;
}

const tokens = (s: string) => s.trim().split(/\s+/).map(normalizeTranscriptToken).filter(Boolean);
const LEAD = /^[^\p{L}\p{N}]*/u;
const TRAIL = /[^\p{L}\p{N}]*$/u;
const POSSESSIVE = /['’]s$/iu;

/** A word's text in three parts: what comes before its letters, its letters, and what comes after (with a possessive 's, unless told to keep it in). */
function parts(text: string, splitPossessive = true) {
  const lead = LEAD.exec(text)![0];
  let rest = text.slice(lead.length);
  let trail = TRAIL.exec(rest)![0];
  rest = rest.slice(0, rest.length - trail.length);
  const possessive = splitPossessive && POSSESSIVE.exec(rest);
  if (possessive && rest.length > possessive[0].length) {
    trail = possessive[0] + trail;
    rest = rest.slice(0, -possessive[0].length);
  }
  return { lead, core: rest, trail };
}

/** The replacement in the case the original word had at its start: "there" at the head of a sentence reads "There". */
function cased(original: string, replacement: string) {
  const first = original.charAt(0), second = replacement.charAt(0);
  return first && first === first.toUpperCase() && first !== first.toLowerCase() && second === second.toLowerCase() && second !== second.toUpperCase()
    ? second.toUpperCase() + replacement.slice(1) : replacement;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Replace a word or phrase everywhere it is said in a transcript, keeping each word's time. Matching reads words as
 * transcript search does, case and punctuation aside, and a possessive 's on the last word stays. Where the fix has
 * as many words as it replaces, each keeps its own time; otherwise the new words share the stretch the old ones took,
 * by length, and every word index after them moves. Words already reading the fix are left alone.
 */
export function applyWordFix(transcript: Transcript, fix: TranscriptWordFix): WordFixResult {
  const find = tokens(fix.find);
  const replace = fix.replace.trim().split(/\s+/).filter(Boolean);
  if (!find.length || !replace.length) return { transcript, places: [], wordsAdded: 0 };
  // The order transcript readers give the words (flattenWords): by start, stable. Segments without word times are
  // read as evenly spaced words there; they have no words to fix and keep their places in the order.
  type Entry = { segment: number; word: number; w: TranscriptWord } | { segment: number; word: -1; w: { start: number; end: number; text: string } };
  const entries: Entry[] = [];
  transcript.segments.forEach((segment, s) => {
    if (segment.words.length) segment.words.forEach((w, i) => entries.push({ segment: s, word: i, w }));
    else if (segment.text.trim()) {
      const n = segment.text.trim().split(/\s+/).length, step = (segment.end - segment.start) / n;
      for (let i = 0; i < n; i++) entries.push({ segment: s, word: -1, w: { text: "", start: round3(segment.start + i * step), end: round3(segment.start + (i + 1) * step) } });
    }
  });
  entries.sort((a, b) => a.w.start - b.w.start);
  // Words read as transcript search reads them; the last word of find also matches a word with a possessive 's after it.
  const normalized = entries.map(e => e.word < 0 ? "" : normalizeTranscriptToken(e.w.text));
  const stems = entries.map(e => e.word < 0 ? "" : normalizeTranscriptToken(parts(e.w.text).core));
  const full = tokens(fix.replace);
  /** Whether the words from `at` read `want`, the last of them with or without a possessive 's. */
  const reads = (at: number, want: readonly string[]) => at >= 0 && at + want.length <= entries.length &&
    want.every((t, j) => normalized[at + j] === t || (j === want.length - 1 && stems[at + j] === t));
  const places: WordFixPlace[] = [];
  let wordsAdded = 0;
  /** New words by segment and word position, and the words taken out. */
  const replaced = new Map<string, TranscriptWord[]>();
  const removed = new Set<string>();
  const key = (e: Entry) => `${e.segment}/${e.word}`;
  /** The first word no earlier place took in. */
  let done = 0;
  for (let i = 0; i + find.length <= entries.length; i++) {
    if (!reads(i, find)) continue;
    // A place that already says the whole fix around the words found ("Claude Code" for Claude → Claude Code) is
    // that fix's place: read as it, it keeps its words, where reading the find alone would say a word twice.
    let begin = i, want = find;
    for (let o = 0; full.length > find.length && o + find.length <= full.length; o++) {
      if (find.every((t, j) => full[o + j] === t) && i - o >= done && reads(i - o, full)) { begin = i - o; want = full; break; }
    }
    const lastWord = want.length - 1;
    const possessive = normalized[begin + lastWord] !== want[lastWord];
    const span = entries.slice(begin, begin + want.length) as Array<Extract<Entry, { word: number }> & { w: TranscriptWord }>;
    const first = span[0]!.w, last = span.at(-1)!.w;
    if ((fix.from !== undefined && last.end <= fix.from) || (fix.to !== undefined && first.start >= fix.to)) continue;
    const head = parts(first.text), tail = parts(last.text, possessive);
    let words: TranscriptWord[];
    if (replace.length === span.length) {
      words = span.map(({ w }, k) => {
        const p = parts(w.text, k === lastWord && possessive);
        return { ...w, text: p.lead + cased(p.core, replace[k]!) + p.trail };
      });
    } else {
      const total = replace.reduce((n, r) => n + r.length, 0);
      let at = first.start;
      const { confidence: _c, ...like } = first;
      words = replace.map((r, k) => {
        const start = at;
        at = k === replace.length - 1 ? last.end : round3(at + (last.end - first.start) * r.length / total);
        const text = (k === 0 ? head.lead : "") + (k === 0 ? cased(head.core, r) : r) + (k === replace.length - 1 ? tail.trail : "");
        return { ...like, text, start: round3(start), end: at };
      });
    }
    const before = span.map(e => e.w.text.trim()).join(" "), after = words.map(w => w.text.trim()).join(" ");
    i = begin + want.length - 1;
    done = i + 1;
    if (before === after) continue;
    places.push({ index: begin, start: first.start, end: last.end, before, after });
    wordsAdded += words.length - span.length;
    // A word for each word stays in the line it was in, where a phrase runs from one line into the next.
    if (words.length === span.length) span.forEach((e, k) => replaced.set(key(e), [words[k]!]));
    else {
      replaced.set(key(span[0]!), words);
      for (const e of span.slice(1)) removed.add(key(e));
    }
  }
  if (!places.length) return { transcript, places, wordsAdded: 0 };
  const segments = transcript.segments.map((segment, s): TranscriptSegment => {
    if (!segment.words.length) return segment;
    let changed = false;
    const words = segment.words.flatMap((w, i) => {
      const k = `${s}/${i}`;
      if (removed.has(k)) { changed = true; return []; }
      const fixed = replaced.get(k);
      if (!fixed) return [w];
      changed = true;
      return fixed;
    });
    return changed ? { ...segment, words, text: words.map(w => w.text.trim()).filter(Boolean).join(" ") } : segment;
  });
  return { transcript: { ...transcript, segments }, places, wordsAdded };
}

/** Apply each fix in the order the editor made them: a transcription made again reads as the one it replaced did. */
export function applyWordFixes(transcript: Transcript, fixes: readonly TranscriptWordFix[] | undefined): Transcript {
  let out = transcript;
  for (const fix of fixes ?? []) out = applyWordFix(out, fix).transcript;
  return fixes?.length ? { ...out, wordFixes: [...fixes] } : out;
}
