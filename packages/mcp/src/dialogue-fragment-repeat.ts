import { normalizeTranscriptToken } from "@scarlet/shared";
import type { TimeRange } from "@scarlet/timeline";
import { REPEAT_WITHIN } from "./dialogue-leftovers.js";

type Word = readonly [start: number, end: number, text: string];
type Side = "start" | "end";
const EPS = 1e-6;
const span = ([start, end]: Word): TimeRange => ({ start, end });
const token = (w: Word) => normalizeTranscriptToken(w[2]);

/** Times are on the timeline before removal. The heard words come from decoding only the
 * samples that play, through the physical edge of this clip's fade. Scan words can cross it. */
export interface FragmentSide {
  mediaId: string;
  audioStream?: number;
  trackId: string;
  clipId: string;
  speed: number;
  edge: number;
  sourceAtEdge?: number;
  bounds: TimeRange;
  scan: readonly Word[];
  heard: readonly Word[];
}

export interface PartialRepeat {
  mediaId: string;
  audioStream?: number;
  trackId: string;
  side: Side;
  word: string;
  heard: string;
  fragment: TimeRange;
  splitWord: TimeRange;
  complete: TimeRange;
}

function retainedWords(s: FragmentSide, side: Side) {
  return s.heard.filter(([start, end, text]) => end > start && normalizeTranscriptToken(text) &&
    start >= s.bounds.start - EPS && end <= s.bounds.end + EPS &&
    (side === "start" ? end <= s.edge + EPS : start >= s.edge - EPS));
}

function overlap(a: Word, b: Word) {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

function checkSide(side: Side, s: FragmentSide, twin: FragmentSide): PartialRepeat | undefined {
  const out = side === "start";
  const heard = retainedWords(s, side);
  const piece = out ? heard.at(-1) : heard[0];
  const across = retainedWords(twin, out ? "end" : "start");
  const complete = out ? across[0] : across.at(-1);
  if (!piece || !complete) return;
  // CTC locates letters in 20 ms source frames. The last (or first) letter must actually run up to the cut,
  // and the independent scan must put that same word on BOTH sides of the physical edge.
  const frame = .02 / s.speed;
  if (Math.abs((out ? piece[1] : piece[0]) - s.edge) > frame + EPS) return;
  const crossing = s.scan.filter(([start, end]) => start <= s.edge - frame + EPS && end >= s.edge + frame - EPS);
  if (crossing.length !== 1) return;
  const split = crossing[0]!, full = token(split), part = token(piece);
  if (!part || !full || full !== token(complete) || !(out ? full.startsWith(part) : full.endsWith(part))) return;
  if (overlap(split, piece) < .5 * (piece[1] - piece[0]) - EPS) return;
  // A very short word can emit all its letters before its sound ends. Require a short emission right at
  // the edge and at least two more frames of the word on the discarded side before treating it as a fragment.
  if (part === full && (Math.abs((out ? piece[1] : piece[0]) - s.edge) > EPS ||
    (piece[1] - piece[0]) * s.speed > .10 + EPS ||
    (out ? split[1] - s.edge : s.edge - split[0]) < 2 * frame - EPS)) return;
  const twinWord = out
    ? twin.scan.find(w => w[1] > twin.edge + EPS && w[1] > w[0])
    : twin.scan.findLast(w => w[0] < twin.edge - EPS && w[1] > w[0]);
  if (!twinWord || token(twinWord) !== full || overlap(twinWord, complete) < .5 * (complete[1] - complete[0]) - EPS) return;
  if (twinWord[0] < twin.bounds.start - EPS || twinWord[1] > twin.bounds.end + EPS ||
    (out ? twinWord[0] < twin.edge - EPS || twinWord[0] < split[1] - EPS :
      twinWord[1] > twin.edge + EPS || twinWord[1] > split[0] + EPS)) return;
  if (s.clipId !== twin.clipId) {
    if (s.sourceAtEdge === undefined || twin.sourceAtEdge === undefined) return;
    const inSource = (w: Word, edge: FragmentSide, source: number): Word =>
      [source + (w[0] - edge.edge) * edge.speed, source + (w[1] - edge.edge) * edge.speed, w[2]];
    if (overlap(inSource(split, s, s.sourceAtEdge), inSource(twinWord, twin, twin.sourceAtEdge)) > EPS) return;
  }
  if (Math.abs((out ? complete[0] : complete[1]) - twin.edge) >= REPEAT_WITHIN) return;
  return { mediaId: s.mediaId, ...(s.audioStream !== undefined && { audioStream: s.audioStream }), trackId: s.trackId, side,
    word: full, heard: part, fragment: span(piece), splitWord: span(split), complete: span(complete) };
}

/** A spoken prefix or suffix left beside another, complete occurrence of the same word. */
export function partialRepeatAtJoin(cut: TimeRange, out: FragmentSide, incoming: FragmentSide): PartialRepeat | undefined {
  // Unspecified uses the recording's default stream, which need not be its first explicit stream.
  if (out.trackId !== incoming.trackId || out.mediaId !== incoming.mediaId || out.audioStream !== incoming.audioStream) return;
  if (out.speed <= 0 || incoming.speed <= 0 || out.edge < cut.start - EPS || incoming.edge > cut.end + EPS ||
    out.edge >= incoming.edge || cut.start >= cut.end) return;
  return checkSide("start", out, incoming) ?? checkSide("end", incoming, out);
}
