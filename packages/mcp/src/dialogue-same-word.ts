/**
 * Level-correlation join finder for retakes that begin on the same word the
 * first take broke off after, with no quiet gap before the first delivery.
 */
import { clipDuration, sourceToTimeline, timelineToSource, type MediaClip, type Project, type TimeRange, type Timeline } from "@scarlet/timeline";
import { normalizeTranscriptToken } from "@scarlet/shared";
import { isTag, round2, round3 } from "./analysis.js";
import { DIP_DBFS, SPEECH_DBFS, dialogueAudioStream, gaps, pageAt, pageReaches, plain, wordMargin, type JoinPage, type Word } from "./dialogue-acoustics.js";
import { dialogueClips } from "./dialogue-kept-words.js";

/** Two deliveries of one word match on their sound when their levels follow each other at least this closely (Pearson r). */
const SAME_WORD_MATCH = .6;
/** How far the recording's offset between the two deliveries may sit from the transcript's. */
const SAME_WORD_SEARCH = .12;
/** Levels under this are room tone to the match, so the depth of a silence doesn't decide it. */
const SAME_WORD_FLOOR = -60;
/** What a same-word join's measurement leaves open, and who settles it. */
export const SAME_WORD_UNHEARD = "Nothing Scarlet measures says how the join plays: like any join it can't place cleanly, a cut there applies as placed with unsureJoins cut " +
  "and otherwise waits in review, where cut, ask or keep is your call.";

export interface SameWordJoin extends TimeRange {
  word: string;
  /** The two deliveries of the word, in timeline seconds. */
  first: TimeRange;
  second: TimeRange;
  /** Seconds from a sound in the first delivery to the same sound in the second, and how closely their levels match. */
  lag: number;
  match: number;
  /** The words the range as given keeps and the take says again right after it, so they play twice: this start takes them out. */
  takesFirst?: string;
}

/**
 * Where a removal can switch takes inside a word said on either side of it. A restart often begins on the word the
 * first take broke off after: "there was a time where would … where you would occasionally see". When the word before
 * runs into the first "where" with no pause, the cut has no quiet to start in. The trough between them is the "m" of
 * "time", and an edge placed there played "time" clipped; a pass then cut the retake instead, kept both takes, or
 * dropped the sentence (2026-11-17). An editor cuts as the first "where" begins and lets the second follow: auditioned
 * on that recording, an edge 0.05 s past the trough played clean. The second delivery starts out of a pause, so its
 * first sound is measurable, and matching the two deliveries on their levels says where the first one's is: word
 * timings at a restart are tens of milliseconds off.
 *
 * The range keeps its end, in the quiet before the second delivery, and gets this start. Undefined when the removal's
 * first word isn't the next kept word, when there is quiet to start in, or when the two deliveries don't match.
 */
export function sameWordJoin(tl: Timeline, project: Pick<Project, "media" | "settings">, range: TimeRange, pages: JoinPage[]): SameWordJoin | undefined {
  const { clips, streams } = dialogueClips(tl, project);
  const clipAt = (at: number) => {
    const found = clips.filter(c => c.timelineIn + 1e-6 < at && at < c.timelineIn + clipDuration(c) - 1e-6);
    // One recording at one source second: several mics would each need their own match.
    const [clip] = found;
    return clip && found.every(c => c.mediaId === clip.mediaId && Math.abs(timelineToSource(c, at) - timelineToSource(clip, at)) < 1e-3) ? clip : undefined;
  };
  const out = clipAt(range.start), back = clipAt(range.end);
  if (!out || !back || out.mediaId !== back.mediaId || Math.abs((out.speed ?? 1) - 1) > 1e-6 || Math.abs((back.speed ?? 1) - 1) > 1e-6) return;
  const stream = dialogueAudioStream(out) ?? streams.get(out.mediaId);
  if ((dialogueAudioStream(back) ?? streams.get(back.mediaId)) !== stream) return;
  const tS = timelineToSource(out, range.start), tE = timelineToSource(back, range.end);
  const page = [tS, tE].map(t => pageAt(pages, out.mediaId, stream, t)).find(p => p?.levels && pageReaches(p, tS - .3) && pageReaches(p, tE + .5));
  const levels = page?.levels;
  if (!page || !levels) return;
  const words = [...page.words].sort((a, b) => a.start - b.start), middle = (w: Word) => (w.start + w.end) / 2;
  // The word the take resumes on, and its first delivery: the first word the range removes, or, when the range starts
  // right after them, the words it keeps that the take then says again. Those would play twice, "a time where you ‖
  // where you would", as a repeat found by its last word alone is given. This start would take them out too; whether
  // the cut does is the model's to say, so it is only reported (`takesFirst`, 2026-11-21).
  const after = words.filter(w => middle(w) > tE), second = after[0], removed = words.find(w => middle(w) > tS), before = words.filter(w => middle(w) <= tS);
  const token = (w?: Word) => w && !isTag(w.text) ? normalizeTranscriptToken(w.text) : "";
  if (!second || !token(second)) return;
  const same = (w?: Word) => !!w && w !== second && token(w) === token(second) && w.end <= second.start + wordMargin;
  // The longest run of words kept before the cut that the take says again right after it, up to three.
  let repeated = 0;
  if (!same(removed) && before.length && tS - before.at(-1)!.end < 3 * wordMargin)
    for (let k = Math.min(3, before.length, after.length); k > 0 && !repeated; k--)
      if (before.slice(-k).every((w, i) => token(w) && token(w) === token(after[i])) && before.at(-1)!.end <= second.start + wordMargin) repeated = k;
  const takesFirst = repeated > 0, first = same(removed) ? removed! : takesFirst ? before.at(-repeated)! : undefined;
  if (!first || (!takesFirst && first.start > tS + .1)) return;
  if (first.start < out.sourceIn || second.end > back.sourceOut) return;
  // A pause before the first delivery is a clean place to start, and the usual placement finds it.
  if (gaps(page).some(q => q.start < first.start + wordMargin && q.end > first.start - 3 * wordMargin)) return;
  const { from, step, db } = levels;
  const index = (t: number) => Math.floor((t - from) / step), centre = (i: number) => from + (i + .5) * step;
  const level = (i: number) => i >= 0 && i < db.length ? Math.max(SAME_WORD_FLOOR, db[i]!) : undefined;
  // The second delivery starts out of a pause: its first sound is where the level rises from quiet.
  let onset = index(second.start - .1);
  if (onset < 0 || db[onset]! > SPEECH_DBFS) return;
  while (onset < db.length && centre(onset) < second.end && db[onset]! <= SPEECH_DBFS) onset++;
  // The range ends in that pause, before the second delivery sounds.
  if (onset >= db.length || centre(onset) >= second.end || tE > from + onset * step + 1e-6) return;
  // Keep the match window inside the second delivery rather than spilling into the next word, where a gap after one
  // take and not the other can pull the match onto the pause before the next word. For short words (< 5 buckets),
  // include up to two buckets of the word's rising edge out of room tone.
  const wordEnd = Math.min(onset + 15, Math.round((second.end - from) / step));
  let matchStart = onset;
  while (wordEnd - matchStart < 5 && matchStart > 0 && onset - matchStart < 2 && db[matchStart - 1]! > DIP_DBFS) matchStart--;
  const length = Math.min(15, Math.max(5, wordEnd - matchStart));
  const heard = Array.from({ length }, (_, k) => level(matchStart + k));
  if (heard.some(v => v === undefined)) return;
  const correlation = (shift: number) => {
    const before = heard.map((_, k) => level(matchStart + k - shift));
    if (before.some(v => v === undefined)) return -1;
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const x = before as number[], y = heard as number[], mx = mean(x), my = mean(y);
    const spread = Math.sqrt(x.reduce((a, v) => a + (v - mx) ** 2, 0) * y.reduce((a, v) => a + (v - my) ** 2, 0));
    return spread > 1e-9 ? x.reduce((a, v, k) => a + (v - mx) * (y[k]! - my), 0) / spread : -1;
  };
  const timed = Math.round((second.start - first.start) / step), search = Math.round(SAME_WORD_SEARCH / step);
  let shift = timed, match = -1;
  for (let k = -search; k <= search; k++) {
    const r = correlation(timed + k);
    if (r > match + 1e-9) { match = r; shift = timed + k; }
  }
  if (match < SAME_WORD_MATCH) return;
  const lag = shift * step;
  // Where the first delivery begins in the recording: the second's first sound, the matched distance earlier. The word
  // before has ended there, which no trough or word timing says when the two run together. The cut starts on the
  // frame nearest that point, with nothing added. It first went to the first frame 15 ms or more past it, a margin
  // taken from one line ("time where", where an edge 0.03 s early played "time" clipped and 0.02 s late played clean).
  // On "which is nice you can see the rough, you can see the shadows" that put the cut 0.04 s into the first "you":
  // the editor heard himself start a word before the cut, and picked the frame nearest the matched start by ear. That
  // frame is within the range he called clean on the first line too (2026-11-17). Scarlet still can't hear either.
  const begins = from + matchStart * step - lag, fps = project.settings.fps;
  const start = Math.round(sourceToTimeline(out, begins) * fps) / fps, source = timelineToSource(out, start), end = range.end;
  if (source >= middle(first) || source <= out.sourceIn || end - start < 2 / fps) return;
  const span = (clip: MediaClip, w: Word) => ({ start: round3(sourceToTimeline(clip, w.start)), end: round3(sourceToTimeline(clip, w.end)) });
  return { start, end, word: plain(second), first: span(out, first), second: span(back, second), lag: round3(lag), match: round2(match),
    ...(takesFirst && { takesFirst: before.slice(-repeated).map(plain).join(" ") }) };
}
