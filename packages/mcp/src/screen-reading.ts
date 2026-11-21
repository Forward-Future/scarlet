/**
 * Where on screen the speaker reads aloud, and when.
 *
 * A framing pass has to know when the speaker is reading a passage off the screen (push in on it) and when they are
 * demoing (show the whole pane). The words heard and the text on screen are both measured, but matching one against
 * the other by hand across a whole edit is work a model skips: a pass that wrote every framing in one bulk edit never
 * looked (2026-11-17). This lines the two up on a version of the edit.
 */
import { clipEnd, type MediaClip, type Timeline } from "@scarlet/timeline";
import type { TimelineWord } from "./timeline-perception.js";

export interface ScreenLine { start: number; end: number; text: string; box: [number, number, number, number] }

export interface ScreenReading {
  /** Timeline seconds from the first matched word's start to the last one's end. */
  from: number; to: number;
  /** The recording whose picture holds the text. */
  mediaId: string;
  /** Its source seconds over the reading. */
  source: [number, number];
  /** The heard words in order, as transcribed. */
  said: string;
  /** How many of them were found on screen. */
  matched: number;
  /** The lines they were found on, top to bottom. */
  lines: Array<{ text: string; box: [number, number, number, number] }>;
  /** The area those lines cover, as fractions of the source picture. */
  box: [number, number, number, number];
}

/** A run must hold this many consecutive words found in the same order on screen. */
const MIN_RUN = 3;
/** And this many letters, so "and of the" on a page is no reading. */
const MIN_LETTERS = 12;
/** Text read once a second can be on screen up to a second either side of where its span says. */
const SLACK = 1;
/** Runs this close in the edit, with no more heard words between, are one reading. */
const JOIN_SECONDS = 2.5, JOIN_WORDS = 6;

export const tokens = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .split(/[^a-z0-9]+/).filter(Boolean);

interface Played { clip: MediaClip; mediaId: string }

/** The clips of these recordings' pictures that play, in timeline order. */
function pictureClips(tl: Timeline, mediaIds: ReadonlySet<string>): Played[] {
  return tl.tracks.filter(t => t.kind === "video" && !t.hidden)
    .flatMap(t => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && mediaIds.has(c.mediaId)))
    .map(clip => ({ clip, mediaId: clip.mediaId }))
    .sort((a, b) => a.clip.timelineIn - b.clip.timelineIn);
}

const sourceAt = (clip: MediaClip, t: number) => clip.sourceIn + (t - clip.timelineIn) * (clip.speed ?? 1);

/**
 * The readings on a version: runs of heard words found, in order, in the text on screen of a recording whose picture
 * plays as they are said. `lines` holds each recording's screen text in source seconds.
 */
export function screenReadings(tl: Timeline, words: readonly TimelineWord[], lines: ReadonlyMap<string, readonly ScreenLine[]>): ScreenReading[] {
  const played = pictureClips(tl, new Set(lines.keys()));
  if (!played.length) return [];
  return readingsAt(words, lines, t => played.filter(({ clip }) => t >= clip.timelineIn && t < clipEnd(clip))
    .map(({ clip, mediaId }) => ({ mediaId, source: (x: number) => sourceAt(clip, x), end: clipEnd(clip) })));
}

/** Where a recording's text could be read at a moment of the video: its source second there, and the video time it stops playing on. */
export interface ReadPlace { mediaId: string; source: (t: number) => number; end: number }

/**
 * The readings among these words: runs of heard words found, in order, in the text a recording shows where `at` places
 * it as they are said, on picture or not.
 */
export function readingsAt(words: ReadonlyArray<Pick<TimelineWord, "text" | "start" | "end">>, lines: ReadonlyMap<string, readonly ScreenLine[]>, at: (t: number) => ReadPlace[]): ScreenReading[] {
  const heard = words.map(w => ({ ...w, tokens: tokens(w.text) })).filter(w => w.tokens.length);
  // Each heard token, with the word it came from.
  const stream = heard.flatMap((w, word) => w.tokens.map(token => ({ token, word })));
  const tokenized = new Map([...lines].map(([id, spans]) => [id, spans.map(s => ({ ...s, tokens: tokens(s.text) }))]));

  type Run = { mediaId: string; first: number; last: number; source: [number, number]; lines: Set<number> };
  const runs: Run[] = [];
  let i = 0;
  while (i < stream.length) {
    const w = heard[stream[i]!.word]!;
    const t = (w.start + w.end) / 2;
    let best: { length: number; run: Run } | undefined;
    for (const { mediaId, source, end } of at(t)) {
      const s = source(t);
      const spans = tokenized.get(mediaId);
      if (!spans) continue;
      // What is on screen as the word is said, read top to bottom, left to right: a sentence runs on to the next line.
      const shown = spans.map((span, index) => ({ span, index })).filter(({ span }) => span.start - SLACK <= s && s <= span.end + SLACK)
        .sort((a, b) => a.span.box[1] - b.span.box[1] || a.span.box[0] - b.span.box[0]);
      const page = shown.flatMap(({ span, index }) => span.tokens.map(token => ({ token, line: index })));
      for (let p = 0; p < page.length; p++) {
        if (page[p]!.token !== stream[i]!.token) continue;
        let k = 0;
        while (i + k < stream.length && p + k < page.length && page[p + k]!.token === stream[i + k]!.token) k++;
        const letters = stream.slice(i, i + k).reduce((n, x) => n + x.token.length, 0);
        if (k < MIN_RUN || letters < MIN_LETTERS || (best && best.length >= k)) continue;
        const lastWord = heard[stream[i + k - 1]!.word]!;
        best = { length: k, run: { mediaId, first: stream[i]!.word, last: stream[i + k - 1]!.word,
          source: [source(w.start), source(Math.min(lastWord.end, end))],
          lines: new Set(page.slice(p, p + k).map(x => x.line)) } };
      }
    }
    if (best) { runs.push(best.run); i += best.length; } else i++;
  }

  // Runs of one passage, read with a word or a pause between, are one reading.
  const joined: Run[] = [];
  for (const run of runs) {
    const prev = joined.at(-1);
    if (prev && prev.mediaId === run.mediaId && run.first - prev.last <= JOIN_WORDS && heard[run.first]!.start - heard[prev.last]!.end <= JOIN_SECONDS) {
      prev.last = run.last; prev.source[1] = run.source[1];
      for (const l of run.lines) prev.lines.add(l);
    } else joined.push({ ...run, source: [...run.source], lines: new Set(run.lines) });
  }

  const r2 = (n: number) => Math.round(n * 100) / 100, r3 = (n: number) => Math.round(n * 1000) / 1000;
  return joined.map(run => {
    const spans = [...run.lines].map(l => lines.get(run.mediaId)![l]!).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    const box: [number, number, number, number] = [Math.min(...spans.map(s => s.box[0])), Math.min(...spans.map(s => s.box[1])),
      Math.max(...spans.map(s => s.box[2])), Math.max(...spans.map(s => s.box[3]))];
    const said = heard.slice(run.first, run.last + 1);
    const found = runs.filter(r => r.mediaId === run.mediaId && r.first >= run.first && r.last <= run.last)
      .reduce((n, r) => n + r.last - r.first + 1, 0);
    return { from: r3(said[0]!.start), to: r3(said.at(-1)!.end), mediaId: run.mediaId, source: [r2(run.source[0]), r2(run.source[1])] as [number, number],
      said: said.map(w => w.text).join(" "), matched: found,
      lines: spans.map(s => ({ text: s.text, box: s.box })), box };
  });
}
