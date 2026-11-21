/**
 * What the recording holds between two transcript words. A transcript says nothing there, and a pass that reads only
 * the transcript takes every such stretch for a pause: on one pass "You can <1.7 s> see" was trimmed as a pause that
 * held two bursts of speech the transcript had missed, a first "see" and a second "you can", and half the restart
 * stayed in the cut. An editor cutting by ear and waveform sees it at once. Scarlet measures; the model decides.
 */
import type { TimeRange, TranscriptWord } from "@scarlet/timeline";
import { dbfs, isTag } from "./analysis.js";

export interface GapLevels { from: number; to: number; rms: number[] }
export interface GapSound { seconds: number; runs: TimeRange[] }

/**
 * Where a recording is quiet: RMS and peak at most these (0..1 per bucket), RMS within QUIET_ABOVE_FLOOR_DB of the
 * recording's own floor (quietRms), and no voice detected. Cut edges go in such quiet (dialogue_check_join). Word
 * alignment keeps the words it can't confirm on sound louder than QUIET_RMS.
 */
export const QUIET_RMS = .01, QUIET_PEAK = .05;
/**
 * Quiet sits no more than this above the recording's floor. On a recording whose room tone is near -70 dBFS, a fixed
 * -40 dBFS took the dip between two words said in one breath, 38 dB above the room, for quiet: a pass's cut ended
 * there, between "this game" and "let me", and the gate applied it (2026-11-15).
 */
export const QUIET_ABOVE_FLOOR_DB = 20;
/** No floor is taken as lower than this: digital silence would leave nothing quiet. */
const LOWEST_FLOOR_RMS = 1e-4;

/** The bucket length the floor is read at, whatever the levels' own. */
const FLOOR_BUCKET = .02;

/**
 * The RMS at or under which a bucket of these levels is quiet: QUIET_RMS, or less on a recording with a low floor.
 * `step` is the levels' bucket length. The floor is read on 20 ms buckets whatever it is: finer buckets catch quieter
 * instants, and at 10 ms the floor read 2 dB lower and a breath's soft tail after a word, quiet before, became sound;
 * the edges moved past it and the joins played a quarter-second longer (2026-11-16).
 */
export function quietRms(rms: ArrayLike<number>, step = FLOOR_BUCKET): number {
  if (!rms.length) return QUIET_RMS;
  const k = Math.max(1, Math.round(FLOOR_BUCKET / step));
  const merged = new Float64Array(Math.ceil(rms.length / k));
  for (let i = 0; i < merged.length; i++) {
    let power = 0, n = 0;
    for (let j = i * k; j < Math.min(rms.length, (i + 1) * k); j++) { power += rms[j]! ** 2; n++; }
    merged[i] = Math.sqrt(power / n);
  }
  const sorted = merged.sort();
  // The quietest fiftieth: a minute of dense speech still has a second of pauses, and a tenth of it is already words' tails.
  const floor = Math.max(LOWEST_FLOOR_RMS, sorted[Math.floor(sorted.length * 0.02)]!);
  return Math.min(QUIET_RMS, floor * 10 ** (QUIET_ABOVE_FLOOR_DB / 20));
}

/** A sound this quiet and this brief, with room tone either side, is a lip tick, not a word: it does not end a silence. */
const TICK_RMS = .0056, TICK_SECONDS = .02;
/** The furthest a detector's early start is followed while the level stays quiet. */
const DETECTOR_LEAD = .75;
/** Through a detector's early start the level stays within this of the room just before it: 8 dB. A breath or a soft consonant rises past it. */
const LEAD_ABOVE_ROOM = 2.5;
/**
 * Which buckets of a reading are quiet: at room level (`quietBelow`, QUIET_PEAK) with no voice detected.
 * Two things a silence holds do not end it (2026-11-16, a 90-cut pass whose cuts waited up to 0.6 s before the voice):
 * - A tick. After a breath the quiet before a word was split by three ticks into pieces too short to trust, and the
 *   cut went before the breath instead, half a second early.
 * - The start of a detected voice, for as long as the level has not left the room it was in. A speech detector hears a
 *   word coming and began up to half a second before any sound. The level says where the word starts.
 * Given the transcript's `words`, the quiet after a word starts where the word's sound is back down at room level: what
 * sounds after that, under speaking level and in no word, up to the quiet, is a breath, and part of the pause. After
 * “yeah, it's okay” the level was at the room 0.1 s after the word, then a breath 30 dB under the voice ran 0.2 s more
 * with the detector still on. The quiet began after it, every way of asking for the cut put its edge there, and the
 * editor was already looking away from the camera (2026-11-18).
 */
export function quietBuckets(rms: ArrayLike<number>, peaks: ArrayLike<number>, from: number, step: number, voice: ReadonlyArray<{ start: number; end: number }>, quietBelow = quietRms(rms, step), words?: ReadonlyArray<TimeRange>): boolean[] {
  return quietReading(rms, peaks, from, step, voice, quietBelow, words).quiet;
}

/** A breath the quiet after a word holds: the sound over the room between the word and the quiet, and its loudest level in dBFS. */
export interface HeldBreath extends TimeRange { db: number }

/**
 * quietBuckets, and the breaths that quiet holds. The quiet is the same; the breaths it counted as part of a pause are
 * a measurement too. Whether a cut after the word plays the breath is the model's call (`breath` on a word reference,
 * 2026-11-21): with the breath folded into the quiet, the edge padded from the word cut it whatever was asked, and nothing
 * said one was there.
 */
export function quietReading(rms: ArrayLike<number>, peaks: ArrayLike<number>, from: number, step: number, voice: ReadonlyArray<{ start: number; end: number }>, quietBelow = quietRms(rms, step), words?: ReadonlyArray<TimeRange>): { quiet: boolean[]; breaths: HeldBreath[] } {
  const n = rms.length;
  const level = Array.from({ length: n }, (_, i) => rms[i]! <= quietBelow && peaks[i]! <= QUIET_PEAK);
  // Ticks: a short run above the room, still far under speech, between two buckets at room level.
  const most = Math.max(1, Math.round(TICK_SECONDS / step));
  for (let i = 1; i < n; i++) {
    if (level[i] || !level[i - 1]) continue;
    let k = i;
    while (k < n && k - i < most && !level[k] && rms[k]! <= TICK_RMS && peaks[k]! <= QUIET_PEAK) k++;
    if (k < n && k > i && level[k]) for (let t = i; t < k; t++) level[t] = true;
  }
  const quiet: boolean[] = [], recent: number[] = [];
  let v = 0, leading = -1, led = 0, ceiling = 0;
  for (let i = 0; i < n; i++) {
    const start = from + i * step, end = start + step;
    // A span that only touches a bucket boundary (within float error) does not voice it.
    while (v < voice.length && voice[v]!.end <= start + 1e-6) v++;
    if (!(v < voice.length && voice[v]!.start < end - 1e-6)) {
      quiet.push(level[i]!);
      if (quiet[i] && rms[i]! <= quietBelow) { recent.push(rms[i]!); if (recent.length > 10) recent.shift(); } else if (!quiet[i]) recent.length = 0;
      continue;
    }
    // The detector is on. The quiet before it carries on while the level stays in that room.
    if (leading !== v) {
      leading = quiet[i - 1] && recent.length ? v : -2 - v;
      led = 0;
      ceiling = Math.min(quietBelow, LEAD_ABOVE_ROOM * recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length));
    }
    // Above that room only as a tick is: briefly, with the room after it.
    const brief = () => {
      let k = i;
      while (k < n && k - i < most && level[k] && rms[k]! > ceiling) k++;
      return k < n && level[k]! && rms[k]! <= ceiling;
    };
    const still = leading === v && led < DETECTOR_LEAD - 1e-9 && level[i]! && (rms[i]! <= ceiling || brief());
    if (!still) leading = -2 - v;
    led += step;
    quiet.push(still);
  }
  const breaths: HeldBreath[] = [];
  if (words?.length) {
    const spoken = (k: number) => words.some(w => w.start < from + (k + 1) * step - 1e-6 && w.end > from + k * step + 1e-6);
    for (let i = 1; i < n; i++) {
      if (!quiet[i] || quiet[i - 1]) continue;
      // Back from the quiet over sound under speaking level, to the earliest bucket at room level: where the word ended.
      // A soft sound between two silences, with no word or speech before it, stays sound: it may be a word nobody timed.
      let room = i, k = i - 1;
      for (; k >= 0 && !quiet[k] && rms[k]! <= QUIET_RMS && !spoken(k); k--) if (rms[k]! <= quietBelow && peaks[k]! <= QUIET_PEAK) room = k;
      if (k < 0 || quiet[k]) continue;
      for (let j = room; j < i; j++) quiet[j] = true;
      // What rises over the room in that stretch, a tick aside, is the breath the quiet now holds.
      let first = -1, last = -1, loudest = 0;
      for (let j = room; j < i; j++) if (!level[j]) { if (first < 0) first = j; last = j; loudest = Math.max(loudest, rms[j]!); }
      if (first >= 0) breaths.push({ start: from + first * step, end: from + (last + 1) * step, db: dbfs(loudest) });
    }
  }
  return { quiet, breaths };
}

/** A gap between two words is described from this length. */
export const GAP_SECONDS = 0.4;
/** Sound counts when it is within this of the level speech sits at. A sibilant's hiss and room tone fall well under it. */
const BELOW_SPEECH_DB = 12;
/** In a stretch with little speech the 85th percentile is room tone. Nothing quieter than this counts as sound. */
const QUIETEST_SOUND_DBFS = -45;
const MIN_RUN = 0.1;
/** A word's sound runs a little past its timing either way. */
const WORD_EDGE = 0.05;

/** The level speech sits at in a stretch of a recording: the 85th percentile of its levels, in dBFS. */
export function speakingLevel(levels: GapLevels): number {
  return typicalLevel([...levels.rms]);
}

function typicalLevel(samples: number[]) {
  samples.sort((a, b) => a - b);
  return dbfs(samples[Math.floor(samples.length * 0.85)] ?? 0);
}

export interface QuietPhrase extends TimeRange {
  text: string;
  fromWord: number;
  toWord: number;
  /** 85th-percentile RMS during the timed words, in dBFS. The comparisons use the nearest two seconds of each phrase. */
  levelDbfs: number;
  beforeDbfs: number;
  afterDbfs: number;
}

const NEIGHBOR_SECONDS = 2, MAX_NEIGHBOR_GAP = 12, MAX_PHRASE_SECONDS = 8;
const isSpoken = (text: string) => !!text.trim() && !isTag(text);
/** Enough overlap to compare a phrase at the boundary of two level readings. */
export const QUIET_PHRASE_CONTEXT = MAX_PHRASE_SECONDS + MAX_NEIGHBOR_GAP + NEIGHBOR_SECONDS;

/** Short transcribed phrases between pauses that are very soft on this recording compared with the words on both sides. */
export function quietPhrases(words: readonly TranscriptWord[], levels: GapLevels, settledThrough = Infinity): QuietPhrase[] {
  const step = (levels.to - levels.from) / levels.rms.length;
  if (!(step > 0 && step <= .031)) return [];
  const until = Math.min(levels.to, settledThrough);
  type Phrase = TimeRange & { fromWord: number; toWord: number };
  const phrases: Phrase[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.start >= until) break;
    if (w.start < levels.from || w.end > until || w.end < w.start || !isSpoken(w.text)) continue;
    const previous = phrases.at(-1);
    if (previous && w.start - previous.end < GAP_SECONDS - 1e-6) {
      previous.toWord = i;
      previous.end = Math.max(previous.end, w.end);
    } else phrases.push({ fromWord: i, toWord: i, start: w.start, end: w.end });
  }
  // Count each measured bucket inside a word once. The waits between words cannot lower the phrase's level.
  const measure = (p: Phrase, from: number, to: number) => {
    const samples: number[] = [];
    const index = (t: number) => Math.ceil((t - levels.from) / step - .5);
    let next = Math.max(0, index(from));
    for (let i = p.fromWord; i <= p.toWord; i++) {
      const w = words[i]!;
      if (!isSpoken(w.text)) continue;
      next = Math.max(next, index(w.start));
      const until = Math.min(index(Math.min(to, w.end)), levels.rms.length);
      while (next < until) samples.push(levels.rms[next++]!);
    }
    return samples.length * step >= MIN_RUN - 1e-6 ? typicalLevel(samples) : undefined;
  };
  const found: QuietPhrase[] = [];
  for (let i = 1; i < phrases.length - 1; i++) {
    const p = phrases[i]!, before = phrases[i - 1]!, after = phrases[i + 1]!;
    if (p.end - p.start > MAX_PHRASE_SECONDS || p.start - before.end > MAX_NEIGHBOR_GAP || after.start - p.end > MAX_NEIGHBOR_GAP) continue;
    const levelDbfs = measure(p, p.start, p.end);
    if (levelDbfs === undefined || levelDbfs > QUIETEST_SOUND_DBFS) continue;
    const beforeDbfs = measure(before, before.end - NEIGHBOR_SECONDS, before.end);
    const afterDbfs = measure(after, after.start, after.start + NEIGHBOR_SECONDS);
    // At least eight times quieter in amplitude than both neighboring deliveries.
    if (beforeDbfs === undefined || afterDbfs === undefined || Math.min(beforeDbfs, afterDbfs) - levelDbfs < 18) continue;
    const text = words.slice(p.fromWord, p.toWord + 1).filter(w => isSpoken(w.text)).map(w => w.text.trim()).join(" ");
    found.push({ ...p, text, levelDbfs, beforeDbfs, afterDbfs });
  }
  return found;
}

/**
 * Sound at speaking level between two words: every run of a tenth of a second or more, clear of each word's own
 * edge. A stretch that does not end on words, such as a range being removed, is read whole with `edge` 0. Undefined
 * when the levels do not cover the gap.
 */
export function gapSound(levels: GapLevels, gap: TimeRange, speechDb = speakingLevel(levels), edge = WORD_EDGE): GapSound | undefined {
  const step = (levels.to - levels.from) / levels.rms.length;
  const start = gap.start + edge, end = gap.end - edge;
  if (!levels.rms.length || step <= 0 || gap.start < levels.from - 1e-6 || gap.end > levels.to + 1e-6) return undefined;
  const floor = Math.max(speechDb - BELOW_SPEECH_DB, QUIETEST_SOUND_DBFS);
  const runs: TimeRange[] = [];
  let open: number | undefined;
  const close = (at: number) => {
    if (open !== undefined && at - open >= MIN_RUN - 1e-6) runs.push({ start: Math.round(open * 100) / 100, end: Math.round(at * 100) / 100 });
    open = undefined;
  };
  for (let i = Math.max(0, Math.floor((start - levels.from) / step)); i < levels.rms.length; i++) {
    const from = Math.max(start, levels.from + i * step), to = Math.min(end, levels.from + (i + 1) * step);
    // A start on a bucket's edge can round into the bucket before it, which then has no width here: read on. Stopping
    // there read the “five point five” after “Opus” as quiet, and a pause trim took it out (2026-11-16).
    if (to <= from) {
      if (levels.from + i * step >= end) break;
      continue;
    }
    if (dbfs(levels.rms[i]!) >= floor) open ??= from;
    else close(from);
  }
  close(end);
  return { seconds: Math.round(runs.reduce((sum, r) => sum + r.end - r.start, 0) * 100) / 100, runs };
}

/** One clause for the model: how much of a gap is sound, and where. */
export function describeGapSound(sound: GapSound): string {
  return sound.runs.length
    ? `${sound.seconds.toFixed(2)} s of it sound at speaking level that no word explains (${sound.runs.map(r => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`).join(", ")})`
    : "quiet";
}
