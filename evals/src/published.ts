/**
 * A published video as the reference: what its editor kept of the raw recordings, and how it plays.
 *
 * The finished video's words are matched to the recordings' words by text and time together
 * (packages/mcp/src/reference-match.ts), so of a line said twice only the take that was used counts. The words
 * say which speech was kept. Where each cut edge sat in the silence between two words is not known: only how
 * long a pause the finished video plays there.
 */
import { matchReference, type MatchSource } from "../../packages/mcp/src/reference-match.ts";
import { normalizeTranscriptToken as token } from "../../packages/shared/src/transcriptSearch.ts";
import { merge, quantile, type Range } from "./intervals.ts";
import { round, type MediaEvidence, type PlayedWord, type Word } from "./metrics.ts";
import type { PictureSample } from "./picture.ts";
import type { TimelineWord } from "./timeline.ts";

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

function rememberUnique<K, V>(map: Map<K, V | null>, key: K, value: V) {
  map.set(key, map.has(key) ? null : value);
}

function spokenInOrder<W extends PlayedWord>(words: readonly W[]): W[] {
  return words.filter(w => token(w.text) && !/^\[.*\]$/.test(w.text.trim())).sort((a, b) => a.start - b.start);
}

/** Compare the silence between the very same two retained words on both playback clocks.
 * Source times and text distinguish repeated takes. The published alignment only identifies the
 * outer words of a stretch with certainty. A seam with an unmatched word is left unscored.
 */
export function comparePublishedJoinSpacing(reference: PublishedReference, candidate: readonly TimelineWord[]) {
  const millis = (s: number) => Math.round(1000 * s);
  const key = (media: string, out: number, left: string, into: number, right: string) =>
    JSON.stringify([media, millis(out), token(left), millis(into), token(right)]);
  const ending = new Map<number, PublishedPiece | null>(), starting = new Map<number, PublishedPiece | null>();
  for (const piece of reference.pieces) {
    rememberUnique(ending, millis(piece.finalEnd), piece);
    rememberUnique(starting, millis(piece.finalStart), piece);
  }
  const anchors = new Map<string, { at: number; after: string; before: string; referenceMs: number } | null>();
  const published = spokenInOrder(reference.played);
  let referenceJoins = 0;
  for (let i = 1; i < published.length; i++) {
    const left = published[i - 1]!, right = published[i]!;
    if (left.piece === right.piece) continue;
    referenceJoins++;
    const a = ending.get(millis(left.end)), b = starting.get(millis(right.start));
    if (!a || !b || a.mediaId !== b.mediaId || left.end <= left.start || right.end <= right.start) continue;
    rememberUnique(anchors, key(a.mediaId, a.sourceEnd, left.text, b.sourceStart, right.text), {
      at: left.end, after: left.text, before: right.text, referenceMs: millis(Math.max(0, right.start - left.end)),
    });
  }

  const pairs = new Map<string, { edited: boolean; candidateMs: number } | null>();
  const played = spokenInOrder(candidate);
  let candidateJoins = 0;
  for (let i = 1; i < played.length; i++) {
    const left = played[i - 1]!, right = played[i]!;
    if (left.mediaId !== right.mediaId) continue;
    const edited = left.piece !== right.piece;
    if (edited) candidateJoins++;
    const id = key(left.mediaId, left.sourceEnd, left.text, right.sourceStart, right.text);
    if (anchors.has(id)) rememberUnique(pairs, id, { edited, candidateMs: millis(Math.max(0, right.start - left.end)) });
  }

  let eligible = 0, unedited = 0;
  const matched = [];
  for (const [id, anchor] of anchors) {
    if (!anchor) continue;
    eligible++;
    const pair = pairs.get(id);
    if (!pair) continue;
    if (!pair.edited) { unedited++; continue; }
    matched.push({ ...anchor, candidateMs: pair.candidateMs, errorMs: pair.candidateMs - anchor.referenceMs });
  }
  const errors = matched.map(m => m.errorMs), absolute = errors.map(Math.abs);
  const percentile = (values: number[], q: number) => values.length ? Math.round(quantile(values, q)!) : null;
  return {
    referenceJoins, eligible, candidateJoins, shared: matched.length, unedited,
    medianErrorMs: percentile(errors, 0.5), medianAbsErrorMs: percentile(absolute, 0.5), p90AbsErrorMs: percentile(absolute, 0.9),
    matched,
  };
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
