/**
 * Where one reading of a recording hands over to the next. Whisper reads the edges of the audio it is given worst: given
 * audio that stops mid-sentence it finishes the sentence itself. A window that ended in the quarter-second pause after
 * "…is that it is" read "it is insane.", and ended 40 ms later "it is incredible.", where the speaker said "it is a fine
 * model" (2026-11-18); the aligner squeezed the made-up word into the pause, and a pass cut the real words around it as
 * an abandoned wording. The first words it hears it can leave out, or rebuild from a clipped syllable ("And fable are
 * far superior" for "…Opus and fable are far superior"). So each reading takes in audio past both ends of the stretch
 * it is kept for, and readings that overlap hand over at a word both have.
 */
import { normalizeTranscriptToken } from "@scarlet/shared";
import type { TranscriptSegment } from "@scarlet/timeline";

/**
 * Seconds a reading takes in past each end of the stretch its words are kept for. Read on past the edge, Whisper hears
 * how the sentence goes, and the words near the edge come from audio that has what came before and after them.
 */
export const SEAM_CONTEXT = 8;
/** Seconds two readings' times for one word may differ by and still be the same word said once. */
const SAME_WORD_SECONDS = 1;

type Timed = { text: string; start: number; end: number };
type Segment<W extends Timed> = Omit<TranscriptSegment, "words"> & { words: W[] };

const midpoint = (w: Timed) => (w.start + w.end) / 2;

/**
 * Where two readings that overlap round `seam` hand over: the earlier one's words run through `before[last]` and the
 * later one's go on from `after[first]`. Where both have a word near the seam, at about the same time, the hand-over is
 * at the one nearest it, so nothing is written twice or left out, whatever times each reading gave. With no word in
 * common there (quiet, or two readings of a garbled stretch), each keeps the words whose middle is on its own side.
 * `through` is where the earlier words end.
 */
export function handOver(before: readonly Timed[], after: readonly Timed[], seam: number) {
  const ia = before.flatMap((w, i) => midpoint(w) >= seam - SEAM_CONTEXT ? [i] : []);
  const ib = after.flatMap((w, j) => midpoint(w) < seam + SEAM_CONTEXT ? [j] : []);
  const ta = ia.map(i => normalizeTranscriptToken(before[i]!.text)), tb = ib.map(j => normalizeTranscriptToken(after[j]!.text));
  // Longest run of words both readings have in order, from the end, so the walk below goes forward.
  const n = ta.length, m = tb.length, lcs = new Uint16Array((n + 1) * (m + 1)), at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[at(i, j)] = ta[i] && ta[i] === tb[j] ? lcs[at(i + 1, j + 1)]! + 1 : Math.max(lcs[at(i + 1, j)]!, lcs[at(i, j + 1)]!);
  }
  let best: { i: number; j: number; off: number } | undefined;
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ta[i] && ta[i] === tb[j] && lcs[at(i, j)] === lcs[at(i + 1, j + 1)]! + 1) {
      const wa = before[ia[i]!]!, wb = after[ib[j]!]!;
      const off = Math.abs((midpoint(wa) + midpoint(wb)) / 2 - seam);
      if (Math.abs(midpoint(wa) - midpoint(wb)) <= SAME_WORD_SECONDS && (!best || off < best.off)) best = { i: ia[i]!, j: ib[j]!, off };
      i++; j++;
    } else if (lcs[at(i + 1, j)]! >= lcs[at(i, j + 1)]!) i++;
    else j++;
  }
  if (best) return { last: best.i, first: best.j + 1, through: before[best.i]!.end };
  const last = before.findLastIndex(w => midpoint(w) < seam);
  const first = after.findIndex(w => midpoint(w) >= seam);
  return { last, first: first < 0 ? after.length : first, through: seam };
}

/** The segments with only the words `kept` holds; a segment with no words stays when `side` holds its middle. */
function keepWords<W extends Timed>(segments: ReadonlyArray<Segment<W>>, kept: ReadonlySet<W>, side: (time: number) => boolean) {
  const out: Array<Segment<W>> = [];
  for (const segment of segments) {
    if (!segment.words.length) {
      if (side((segment.start + segment.end) / 2)) out.push(segment);
      continue;
    }
    const words = segment.words.filter(w => kept.has(w));
    if (!words.length) continue;
    if (words.length === segment.words.length) { out.push(segment); continue; }
    out.push({ ...segment, text: words.map(w => w.text).join(" "),
      start: words[0] === segment.words[0] ? segment.start : words[0]!.start,
      end: words.at(-1) === segment.words.at(-1) ? segment.end : words.at(-1)!.end, words });
  }
  return out;
}

/** The segments with only the words whose middle is in [from, to). */
export function segmentsWithin<W extends Timed>(segments: ReadonlyArray<Segment<W>>, from: number, to: number) {
  const inside = (t: number) => t >= from && t < to;
  return keepWords(segments, new Set(segments.flatMap(s => s.words).filter(w => inside(midpoint(w)))), inside);
}

/** Words split by where their middle falls: before `seam` or from it on. */
function sideOfSeam<W extends Timed>(segments: ReadonlyArray<Segment<W>>, seam: number) {
  return { before: segmentsWithin(segments, -Infinity, seam), after: segmentsWithin(segments, seam, Infinity) };
}

/** Two overlapping windows' segments, handed over round `seam` (see handOver). */
export function seamWindows<W extends Timed>(before: ReadonlyArray<Segment<W>>, after: ReadonlyArray<Segment<W>>, seam: number) {
  const a = before.flatMap(s => s.words), b = after.flatMap(s => s.words);
  const { last, first, through } = handOver(a, b, seam);
  return {
    before: keepWords(before, new Set(a.slice(0, last + 1)), t => t < through),
    after: keepWords(after, new Set(b.slice(first)), t => t >= through),
    through,
  };
}

/**
 * Windows of a recording read one after another, each past both of its ends, saved as they are read. A window's words
 * are saved as soon as no later window reads them again, so a quit costs no more than the window under way: everything
 * but its last SEAM_CONTEXT, which waits for the next window to say where they hand over. `save` gets the words up to
 * `through` and returns nothing; `add` returns how far the saved words reach.
 */
export function savedWindows(start: number, save: (through: number, segments: TranscriptSegment[]) => void) {
  let held: { segments: TranscriptSegment[]; seam: number } | undefined, through = start;
  return {
    /** A window's words, on the recording's clock, read for [from, seam); `last` when nothing follows it. */
    add(segments: TranscriptSegment[], from: number, seam: number, last: boolean) {
      if (held) {
        const joined = seamWindows(held.segments, segments, held.seam);
        save(through = joined.through, joined.before);
        segments = joined.after;
      } else if (from > 0) segments = sideOfSeam(segments, from).after;
      if (last) {
        save(through = seam, segments);
        held = undefined;
        return through;
      }
      const settled = Math.max(through, seam - SEAM_CONTEXT);
      const split = sideOfSeam(segments, settled);
      save(through = settled, split.before);
      held = { segments: split.after, seam };
      return through;
    },
  };
}
