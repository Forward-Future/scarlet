/**
 * Word-level transcript lines that keep every word's index and say each time once. Gemini reads a number digit by
 * digit, so a start and an end on every word were most of a word read. A line gives the start of its first word; a
 * word's end is the next word's start or the start of the gap after it. A short read still gives every word both.
 */
import { round2 } from "./analysis.js";

/** A page of this many words or fewer gives each word its own start and end. */
export const EXACT_WORD_TIMES = 20;
/** The most words on one line: the next word opens a new line with its start. */
export const LINE_WORDS = 12;

/** Seconds to the hundredth with no trailing zeros: 580.1, 583, 563.76. */
export function shortSeconds(t: number): string {
  return String(round2(t) || 0);
}

/** A word that ends a sentence. */
export function endsSentence(text: string): boolean {
  return /[.?!]["”’)]*$/.test(text.trim());
}

export interface LineWord { index: number; start: number; end: number; text: string; speaker?: string }

/**
 * transcript_get's text lines for word granularity. `note` is the line that goes before a word (what the gap before it
 * holds), `said` the word as shown. With more than EXACT_WORD_TIMES words, one line per phrase, `start #index word
 * #index word …`, opened at the first word, after a gap, at a new sentence or speaker, and every LINE_WORDS words;
 * otherwise `#index start-end word` lines. A speaker is named where it changes.
 */
export function transcriptWordLines<W extends LineWord>(shown: readonly W[],
  opts: { note: (w: W) => string | undefined; said: (w: W) => string; gapSeconds: number }): string[] {
  const lines: string[] = [];
  let speaker: string | undefined;
  const label = (w: W) => {
    const changed = !!w.speaker && w.speaker !== speaker;
    if (w.speaker) speaker = w.speaker;
    return changed ? ` ${w.speaker}:` : "";
  };
  if (shown.length <= EXACT_WORD_TIMES) {
    for (const w of shown) {
      const note = opts.note(w);
      if (note) lines.push(note);
      lines.push(`#${w.index} ${shortSeconds(w.start)}-${shortSeconds(w.end)}${label(w)} ${opts.said(w)}`);
    }
    return lines;
  }
  let line = "", count = 0;
  let previous: W | undefined;
  for (const w of shown) {
    const note = opts.note(w);
    const who = label(w);
    const gap = previous ? w.start - previous.end : 0;
    if (!previous || note || gap >= opts.gapSeconds || who || count >= LINE_WORDS || endsSentence(previous.text)) {
      if (line) lines.push(line);
      // A gap whose sound wasn't read still says how long it is: the word before it has no end of its own here.
      if (note || (previous && gap >= opts.gapSeconds)) lines.push(note ?? `  · ${gap.toFixed(2)} s gap, levels unread`);
      line = `${shortSeconds(w.start)} #${w.index}${who} ${opts.said(w)}`;
      count = 1;
    } else {
      line += ` #${w.index} ${opts.said(w)}`;
      count++;
    }
    previous = w;
  }
  if (line) lines.push(line);
  return lines;
}
