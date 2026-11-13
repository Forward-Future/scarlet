/**
 * A published video as the reference: what its editor kept of the raw recordings, and how it plays.
 *
 * The finished video's words are matched to the recordings' words by text and time together
 * (packages/mcp/src/reference-match.ts), so of a line said twice only the take that was used counts. The words
 * say which speech was kept. Where each cut edge sat in the silence between two words is not known: only how
 * long a pause the finished video plays there.
 */
import { matchReference, type MatchSource } from "../../packages/mcp/src/reference-match.ts";
import { merge, type Range } from "./intervals.ts";
import { round, type MediaEvidence, type PlayedWord, type Word } from "./metrics.ts";
import type { PictureSample } from "./picture.ts";

/** The id the finished video's own words carry, where a recording's would be. */
export const PUBLISHED = "published";

/** Recording and finished video keep time to within this across two stretches when nothing was taken out between them. */
const CONTINUOUS = 0.15;

/** A stretch of the published video that plays one recording straight through. */
export interface PublishedPiece { mediaId: string; finalStart: number; finalEnd: number; sourceStart: number; sourceEnd: number; rate: number }

export interface PublishedReference {
  /** Recording seconds per finished second: 1 unless the finished video was retimed. */
  rate: number;
  finishedWords: number;
  matchedWords: number;
  /** Speech of the finished video that no recording has, such as narration added later. */
  addedPassages: number;
  addedSeconds: number;
  /** A join that plays an earlier piece of the same recording: the editor moved a passage. */
  reordered: number;
  /** What the finished video plays of each recording, in source seconds. */
  kept: Record<string, Range[]>;
  /** The finished video's words on its own clock. A new piece starts where it jumps in the recordings. */
  played: PlayedWord[];
  /** Each matched stretch on both clocks, first word to last: which recording second a published second plays. */
  pieces: PublishedPiece[];
  /** Where each recording sits in the published frame at regular moments, when its picture was measured. */
  picture?: PictureSample[];
}

/**
 * Match a finished video's words against the recordings it was cut from. A kept range reaches past its first and
 * last word by half the pause the finished video plays at that join, as far as the recording is silent there.
 */
export function publishedReference(finished: readonly Word[], evidence: ReadonlyMap<string, MediaEvidence>, mediaIds: readonly string[]): PublishedReference {
  const sources: MatchSource[] = mediaIds.map(mediaId => ({ mediaId, words: evidence.get(mediaId)?.words ?? [] }));
  const match = matchReference(finished, sources);
  const wordsOf = new Map(sources.map(s => [s.mediaId, s.words]));
  // Two matched stretches with nothing taken out between them are one piece: the two transcripts heard a few words
  // differently there, and the recording plays straight through.
  const pieceOf: number[] = [];
  match.stretches.forEach((s, i) => {
    const prev = match.stretches[i - 1];
    const removed = prev && prev.mediaId === s.mediaId ? (s.sourceStart - prev.sourceEnd) - match.rate * (s.finalStart - prev.finalEnd) : Infinity;
    pieceOf.push(i && Math.abs(removed) <= CONTINUOUS ? pieceOf[i - 1]! : i ? pieceOf[i - 1]! + 1 : 0);
  });
  const pieces = pieceOf.length ? pieceOf.at(-1)! + 1 : 0;
  const kept: Record<string, Range[]> = {};
  for (let p = 0; p < pieces; p++) {
    const from = pieceOf.indexOf(p), to = pieceOf.lastIndexOf(p);
    const first = match.stretches[from]!, last = match.stretches[to]!;
    const words = wordsOf.get(first.mediaId)!;
    const before = words[first.sourceWords[0] - 1], after = words[last.sourceWords[1] + 1];
    const pause = (finalOut: number | undefined, finalIn: number | undefined) =>
      finalOut === undefined || finalIn === undefined ? Infinity : Math.max(0, finalIn - finalOut) * match.rate / 2;
    // The head and tail of the video keep whatever silence the recording has there.
    const lead = Math.min(pause(match.stretches[from - 1]?.finalEnd, first.finalStart), Math.max(0, first.sourceStart - (before?.end ?? 0)));
    const trail = Math.min(pause(last.finalEnd, match.stretches[to + 1]?.finalStart), Math.max(0, (after?.start ?? last.sourceEnd) - last.sourceEnd));
    (kept[first.mediaId] ??= []).push({ start: round(first.sourceStart - lead, 3), end: round(last.sourceEnd + trail, 3) });
  }
  for (const id of Object.keys(kept)) kept[id] = merge(kept[id]!);

  // Each word plays in the piece it was matched in. Words between two stretches of one piece are that piece's, and a
  // word or two the transcripts heard differently at a join stays with the piece before it. Speech no recording has
  // is a piece of its own.
  const piece = new Array<number | undefined>(finished.length);
  match.stretches.forEach((s, i) => {
    const until = pieceOf[i + 1] === pieceOf[i] ? match.stretches[i + 1]!.finalWords[0] - 1 : s.finalWords[1];
    for (let w = s.finalWords[0]; w <= until; w++) piece[w] = pieceOf[i];
  });
  const added = match.unmatched.filter(u => piece[u.finalWords[0]] === undefined);
  added.forEach((u, i) => { for (let w = u.finalWords[0]; w <= u.finalWords[1]; w++) piece[w] = pieces + i; });
  const played: PlayedWord[] = [];
  let current = piece.find(p => p !== undefined) ?? 0;
  finished.forEach((w, i) => {
    current = piece[i] ?? current;
    played.push({ text: w.text, start: w.start, end: w.end, mediaId: PUBLISHED, piece: current });
  });
  return {
    rate: match.rate, finishedWords: match.finalWords, matchedWords: match.matchedWords,
    addedPassages: added.length, addedSeconds: round(added.reduce((sum, u) => sum + u.finalEnd - u.finalStart, 0), 1),
    reordered: match.joins.filter(j => j.kind === "back").length,
    kept, played,
    pieces: match.stretches.map(s => ({ mediaId: s.mediaId, finalStart: s.finalStart, finalEnd: s.finalEnd, sourceStart: s.sourceStart, sourceEnd: s.sourceEnd, rate: match.rate })),
  };
}
