/**
 * What a saved part of a dialogue pass still plays once its cuts are out: pauses long enough to hear as a wait, and
 * words said twice in a row. A pass reads the recording, not the edit it leaves, so a wait it trimmed too little, a
 * restart it missed and a word doubled across one of its own joins all went unseen until the editor played the cut.
 * Scarlet reports them; the model decides.
 */
import { adjacentRepeatCandidates, normalizeTranscriptToken } from "@scarlet/shared";
import type { TimeRange, TranscriptWord } from "@scarlet/timeline";
import type { TimelineWord } from "./timeline-perception.js";

/** A pause the part still plays is listed from this length, word to word. */
export const KEPT_PAUSE_SECONDS = 0.75;
/** The second saying starts within this long of the first, as played. */
export const REPEAT_WITHIN = 3;

export interface KeptPause {
  mediaId: string;
  /** The recording's seconds from the word before the pause to the word after it. */
  source: TimeRange;
  /** How long the pause plays, word to word, with this part's cuts out. */
  seconds: number;
  after: string;
  before: string;
  /** The word the pause follows, where nothing of it has been cut: `afterWord` in dialogue_apply_cuts trims it. */
  afterWord?: number;
}

export interface RepeatedWords {
  mediaId: string;
  /** Where the first saying starts in the recording. */
  source: number;
  /** Both sayings as they play. */
  text: string;
  /** The first saying's words by their transcript indices. */
  fromWord: number;
  toWord: number;
  /** A cut of this part sits between the two sayings: its join made the repeat. */
  atJoin: boolean;
}

/** A stretch of a recording the part still plays between two words it keeps, for a reading of what sounds in it. */
export interface KeptGap { mediaId: string; source: TimeRange; after: string; before: string }
/** The shortest stretch between two kept words worth a reading: a syllable. */
const KEPT_GAP_SECONDS = 0.12;

const endsSentence = (text: string) => /[.?!]["'”’)\]]*$/u.test(text.trim());

/**
 * `words` are the planned version's words in playback order inside the part; `cuts` the ranges the part removes and
 * `kept` the ones it keeps on purpose, all in timeline seconds. `transcripts` gives each word's time in its recording.
 */
export function partLeftovers(words: readonly TimelineWord[], cuts: readonly TimeRange[], kept: readonly TimeRange[],
  transcripts: ReadonlyMap<string, readonly TranscriptWord[]>, min = KEPT_PAUSE_SECONDS): { pauses: KeptPause[]; repeats: RepeatedWords[]; gaps: KeptGap[] } {
  const removed = [...cuts].sort((a, b) => a.start - b.start);
  const cutIn = (from: number, to: number) => removed.reduce((sum, c) => sum + Math.max(0, Math.min(c.end, to) - Math.max(c.start, from)), 0);
  // A word plays when its middle does, the rule captions use.
  const heard = words.filter(w => w.end > w.start && !/^\[.*\]$/.test(w.text) && normalizeTranscriptToken(w.text) &&
    !removed.some(c => c.start <= (w.start + w.end) / 2 && (w.start + w.end) / 2 < c.end));
  const sourceOf = (w: TimelineWord) => transcripts.get(w.mediaId)?.[w.index];
  const pauses: KeptPause[] = [];
  // What the part still plays of the recording between each two neighboring words it keeps. A word the transcript
  // missed, a cut-off syllable or a breath sits there, and beside a cut it is what is left of the take that came out.
  const gaps: KeptGap[] = [];
  for (let i = 0; i + 1 < heard.length; i++) {
    const left = heard[i]!, right = heard[i + 1]!;
    const a = sourceOf(left), b = sourceOf(right);
    // One stretch of one recording, played at its own speed, so timeline and recording seconds run together.
    if (a && b && left.mediaId === right.mediaId && right.index > left.index && Math.abs((right.start - left.end) - (b.start - a.end)) < .01) {
      let from = left.end;
      const piece = (to: number) => {
        if (to - from >= KEPT_GAP_SECONDS) gaps.push({ mediaId: left.mediaId, source: { start: a.end + from - left.end, end: a.end + to - left.end }, after: left.text, before: right.text });
      };
      for (const c of removed) {
        if (c.end <= from || c.start >= right.start) continue;
        piece(Math.min(c.start, right.start));
        from = Math.max(from, c.end);
      }
      piece(right.start);
    }
    if (right.start - left.end < min) continue;
    const out = cutIn(left.end, right.start), seconds = right.start - left.end - out;
    // A pause the part decided to keep stays: the agent has already said why.
    if (seconds < min || !a || !b || kept.some(k => k.start < right.start && k.end > left.end)) continue;
    // Untouched, and still one stretch of the recording: across a join an earlier part made, the pause is the join's.
    const whole = out < 1e-6 && left.mediaId === right.mediaId && right.index === left.index + 1 &&
      Math.abs((right.start - left.end) - (b.start - a.end)) < .01;
    pauses.push({ mediaId: left.mediaId, source: { start: a.end, end: b.start }, seconds: Math.round(seconds * 1000) / 1000,
      after: left.text, before: right.text, ...(whole && { afterWord: left.index }) });
  }
  // Compare attempts on the clock the audience hears, including a long removal between the two.
  let cutIndex = 0, removedSeconds = 0;
  const starts = heard.map(w => {
    while (cutIndex < removed.length && removed[cutIndex]!.end <= w.start) {
      const cut = removed[cutIndex++]!;
      removedSeconds += cut.end - cut.start;
    }
    const cut = removed[cutIndex];
    return w.start - removedSeconds - (cut ? Math.max(0, w.start - cut.start) : 0);
  });
  const repeatLengths = adjacentRepeatCandidates(heard.map(w => normalizeTranscriptToken(w.text)), starts);
  const repeats: RepeatedWords[] = [];
  for (let i = 0; i < heard.length - 1;) {
    const found = repeatLengths(i).find(n => {
      const last = heard[i + n - 1]!, next = heard[i + n]!;
      if (next.start - last.end - cutIn(last.end, next.start) >= REPEAT_WITHIN) return false;
      // "…it. It…" ends one sentence and starts the next.
      if (n === 1 && endsSentence(heard[i]!.text)) return false;
      // The first saying is one unbroken run of a recording, so its words can be named.
      return heard.slice(i, i + n).every((w, k) => w.mediaId === heard[i]!.mediaId && w.index === heard[i]!.index + k);
    });
    const first = heard[i]!, at = sourceOf(first);
    if (!found || !at) { i++; continue; }
    repeats.push({ mediaId: first.mediaId, source: at.start, text: heard.slice(i, i + 2 * found).map(w => w.text).join(" "),
      fromWord: first.index, toWord: first.index + found - 1, atJoin: cutIn(first.start, heard[i + 2 * found - 1]!.end) > 1e-6 });
    i += found;
  }
  return { pauses, repeats, gaps };
}
