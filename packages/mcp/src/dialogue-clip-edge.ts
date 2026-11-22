/**
 * Clip-edge audio inspection for source-second cuts (`timeline_propose` / `timeline_first_cut`).
 */
import { round3 } from "./analysis.js";
import { DIP_DBFS, inWord, levelStrip, onWordOnset, pageAt, pageReaches, plain, snapLimit, soundAt, type JoinPage } from "./dialogue-acoustics.js";

/** A level this low ends a piece of sound: room tone, or the closure before the next word. */
const FRAGMENT_QUIET_DBFS = -45;
/** The piece is sound, not room tone, when it stands this far above the quiet that ends it. */
const FRAGMENT_DROP_DB = 12;
/** A piece quieter than this is the last of a word's decay, which a fade covers. */
const FRAGMENT_SOUND_DBFS = -42;
/** How far from a split word's edge a clean edge is looked for, and in what steps. */
const WHOLE_WORD_REACH = .6, WHOLE_WORD_STEP = .01;

/** What a clip edge given in source seconds leaves playing that an editor would hear as a mistake. */
export interface EdgeInSound {
  /** The transcript word the edge falls inside, while that word is sounding. */
  word?: string;
  /** The nearest source second where this edge is clean and plays the split word whole, and where it leaves the word out. */
  wholeAt?: number;
  withoutAt?: number;
  /**
   * A piece of a sound the edge cuts through: how long the piece left playing is, its level in dBFS, and the source
   * second and level of the quiet it ends at, where the edge would leave none of it.
   */
  fragment?: { seconds: number; db: number; quietAt: number; quietDb: number };
  /** RMS dBFS in 20 ms steps from 0.3 s before to 0.3 s after the edge; `|` marks it. */
  levels?: string;
}

/**
 * A short piece of sound between a clip's edge and the quiet beside it, on the side that plays, when the sound runs
 * on past the edge into what was removed: the tail of an “uh” before the sentence that follows, the first consonant
 * of the next word after the last one kept. The transcript need not have a word for it, and often has none: a pass
 * began a clip 40 ms before an “uh” ended because no word said an “uh” was there, with the recording quiet 60 ms
 * later. Only the levels are read. A word the transcript does have keeps its own sounds: a dip inside a kept word is
 * a stop consonant, and a short kept word between the edge and the quiet is that word.
 */
function edgeFragment(page: NonNullable<JoinPage["edges"]>, t: number, side: "in" | "out"): EdgeInSound["fragment"] {
  const levels = page.levels;
  if (!levels) return;
  const { db, step, from } = levels, toward = side === "out" ? -1 : 1;
  const first = Math.floor((t - from) / step + toward * 1e-6), removed = first - toward;
  if (first < 0 || first >= db.length || removed < 0 || removed >= db.length) return;
  let peak = -Infinity;
  for (let k = 0; k <= Math.round(snapLimit / step); k++) {
    const i = first + toward * k;
    if (i < 0 || i >= db.length) return;
    const level = db[i]!;
    if (k && level <= FRAGMENT_QUIET_DBFS && level <= peak - FRAGMENT_DROP_DB) {
      // Sound on both sides of the edge: the cut goes through it. Quiet on the removed side is a whole sound, kept.
      if (peak < FRAGMENT_SOUND_DBFS || db[removed]! < peak - FRAGMENT_DROP_DB) return;
      const quietAt = from + (i + .5) * step, lo = Math.min(t, quietAt), hi = Math.max(t, quietAt);
      // The sound that plays, up to where the quiet begins. Under a level step of it is the step's own rounding.
      const seconds = Math.abs(from + (toward > 0 ? i : i + 1) * step - t);
      if (seconds < step - 1e-6) return;
      if (page.words.some(w => inWord(w, quietAt) ||
        Math.min(w.end, hi) - Math.max(w.start, lo) > .5 * (w.end - w.start))) return;
      return { seconds: round3(seconds), db: Math.round(peak), quietAt: round3(quietAt), quietDb: Math.round(level) };
    }
    peak = Math.max(peak, level);
  }
}

/** What an edge at `t` cuts through, without where it would be clean. */
function soundUnderEdge(pages: JoinPage[], mediaId: string, stream: number, t: number, side: "in" | "out") {
  const page = pageAt(pages, mediaId, stream, t);
  if (!page || soundAt(page, t) !== "sound") return;
  // A clip that starts on the first sound after a silence plays that sound whole.
  if (side === "in" && onWordOnset(page, t)) return;
  // Room tone under the edge, too brief to be a run of silence: the instant between two words said in one breath.
  const levels = page.levels, here = levels && levels.db[Math.floor((t - levels.from) / levels.step)];
  if (here !== undefined && here <= DIP_DBFS) return;
  const split = page.words.find(w => inWord(w, t));
  const fragment = edgeFragment(page, t, side);
  if (!split && !fragment) return;
  return { page, split, fragment };
}

/**
 * Whether a clip that starts (`in`) or ends (`out`) at source second `t` cuts through sound there: inside a
 * transcript word that is sounding, or through a sound it leaves a piece of. Undefined when the edge is clean, or
 * when no page measured the recording there.
 */
export function clipEdgeSound(pages: JoinPage[], mediaId: string, stream: number, t: number, side: "in" | "out"): EdgeInSound | undefined {
  const found = soundUnderEdge(pages, mediaId, stream, t, side);
  if (!found) return;
  const { page, split, fragment } = found;
  // Where the edge would be clean either side of the word, by this same check. Given only the levels, a pass guessed:
  // eight edges took two or three saves each to land (2026-11-15).
  const clean = (s: number) => !!page.levels && pageReaches(page, s) && !soundUnderEdge(pages, mediaId, stream, s, side);
  const nearest = (from: number, toward: 1 | -1) => {
    for (let k = 0; k <= Math.round(WHOLE_WORD_REACH / WHOLE_WORD_STEP); k++) {
      const s = round3(from + toward * k * WHOLE_WORD_STEP);
      if (clean(s)) return s;
    }
  };
  // A clip that ends (out) plays the word before its edge: later takes it in whole. One that starts (in) plays it after.
  const whole = split && nearest(side === "out" ? split.end : split.start, side === "out" ? 1 : -1);
  const without = split && nearest(side === "out" ? split.start : split.end, side === "out" ? -1 : 1);
  return { ...(split && { word: plain(split) }), ...(whole !== undefined && { wholeAt: whole }), ...(without !== undefined && { withoutAt: without }),
    ...(fragment && { fragment }), ...(page.levels && { levels: levelStrip(page.levels, t) }) };
}
