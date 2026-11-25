/**
 * Where the words said in one recording are on the picture of another, once the two are synced.
 *
 * A pass decided from about thirty frames that a 50-minute screen recording held only the speaker's notes, made the
 * video camera-only, and left every quote he read off that screen as a To do for the editor (2026-11-23). The words he
 * said and the text on the screen were both measured, and screen_reading lines them up, but only for a recording whose
 * picture is already in the video. audio_sync is where a pass first learns two recordings belong together, so the sync
 * says where they meet: evidence for the model, never a decision.
 */
import type { TranscriptWord } from "@scarlet/timeline";
import { round2 } from "./analysis.js";
import { readingsAt, type ScreenLine } from "./screen-reading.js";
import type { SyncFit } from "./audio-sync.js";

/** How many readings the sync lists; screen_reading has the rest once the picture is in the video. */
export const SAID_ON_SCREEN_LISTED = 40;
/** Seconds the sync waits for a picture's text not read yet. The reading carries on, and a second sync has the rest. */
export const SAID_ON_SCREEN_WAIT = 20;

/**
 * The secondary's second at each reference second, as a sync measured it, or undefined where it doesn't place one
 * (outside a step's part). `offset` is secondaryStartRelativeToReference for a single match.
 */
export function secondaryAtReference(fit: SyncFit | { kind: "match"; offset: number }): ((t: number) => number | undefined) | undefined {
  switch (fit.kind) {
    case "match": case "constant": { const offset = fit.offset; return t => t - offset; }
    case "drift": {
      // offset(at) = offsetAtStart + slope * at, where `at` is the secondary's second; reference = at + offset(at).
      const slope = fit.msPerMinute / 60_000;
      return t => (t - fit.offsetAtStart) / (1 + slope);
    }
    case "steps": return t => {
      for (const part of fit.parts) {
        const at = t - part.offset;
        if (at >= part.from - 15 && at <= part.to + 15) return at;
      }
      return undefined;
    };
    default: return undefined;
  }
}

/** The reference's second at each secondary second: the other way round from secondaryAtReference. */
export function referenceAtSecondary(fit: SyncFit | { kind: "match"; offset: number }): ((t: number) => number | undefined) | undefined {
  switch (fit.kind) {
    case "match": case "constant": { const offset = fit.offset; return t => t + offset; }
    case "drift": { const slope = fit.msPerMinute / 60_000; return t => t + fit.offsetAtStart + slope * t; }
    case "steps": return t => {
      const part = fit.parts.find(p => t >= p.from - 15 && t <= p.to + 15);
      return part && t + part.offset;
    };
    default: return undefined;
  }
}

export interface SaidOnScreen {
  /** The recording whose words were heard, and the one whose picture holds them. */
  speech: string; picture: string;
  /** How many readings were found. */
  readings: number;
  /** Each in the speech recording's seconds, with the picture's seconds and the words said. */
  list: Array<{ from: number; to: number; pictureAt: [number, number]; said: string }>;
  more?: number;
}

/**
 * The runs of words said in `speech` that are found, in the same order, in the text on `picture`'s screen as they are
 * said. `pictureAt` maps a second of the speech recording to the picture's.
 */
export function saidOnScreen(speech: { id: string; words: readonly TranscriptWord[] }, picture: { id: string; lines: readonly ScreenLine[]; duration: number },
  pictureAt: (t: number) => number | undefined): SaidOnScreen {
  const words = speech.words.map(w => ({ text: w.text, start: w.start, end: w.end }));
  const found = readingsAt(words, new Map([[picture.id, picture.lines]]), t => {
    const at = pictureAt(t);
    if (at === undefined || at < 0 || at > picture.duration) return [];
    return [{ mediaId: picture.id, source: (x: number) => pictureAt(x) ?? at, end: Infinity }];
  });
  const list = found.slice(0, SAID_ON_SCREEN_LISTED).map(r => ({ from: round2(r.from), to: round2(r.to), pictureAt: r.source,
    said: r.said.length > 100 ? `${r.said.slice(0, 97)}…` : r.said }));
  return { speech: speech.id, picture: picture.id, readings: found.length, list,
    ...(found.length > list.length && { more: found.length - list.length }) };
}
