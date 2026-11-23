/**
 * Acoustic boundary primitives for dialogue cuts: quiet/valley extraction,
 * word-on-sound retiming, trough/dip detection, edge padding, and frame snapping.
 */
import type { MediaClip, TimeRange, TranscriptWord } from "@scarlet/timeline";
import { appendInterval, dbfs, isTag, round3 } from "./analysis.js";
import { QUIET_RMS, quietReading, quietRms, roomRms, soundFloor, type HeldBreath } from "./gap-sound.js";

export type Word = Pick<TranscriptWord, "text" | "start" | "end">;
/** A word as the join check reads it: where the recording has it, and, when that is not where the transcript times it, `timed`. */
export type JoinWord = Word & { timed?: TimeRange };
export interface Waveform { from: number; to: number; peaks: number[]; rms?: number[]; speechActivity?: TimeRange[] }
/** Measured RMS level of the source in dBFS, one value per waveform bucket. */
export interface AudioLevels { from: number; step: number; db: number[] }
export interface JoinPage extends TimeRange { mediaId: string; audioStream?: number; edges?: { words: JoinWord[]; quiet: TimeRange[]; valleys: TimeRange[]; voice: TimeRange[]; levels?: AudioLevels;
  /** Breaths after a word that `quiet` holds as part of the pause (quietReading). */
  breaths?: HeldBreath[] } }
export interface SourceEdge { clip: MediaClip; page: NonNullable<JoinPage["edges"]>; at: number; clipped: Word[]; touching: Word[] }
export type Sound = "quiet" | "valley" | "sound";

export function dialogueAudioStream(source: object) {
  return "audioStream" in source && typeof source.audioStream === "number" ? source.audioStream : undefined;
}

/** 85th percentile of dBFS buckets, used as the local speaking level. */
export function percentile85Db(db: readonly number[]): number {
  const sorted = [...db].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * .85)]!;
}

/** Keep short quiet intervals once per scan instead of decoding the recording for each proposed cut. */
export function joinEvidence(words: Word[], wf: Waveform): JoinPage["edges"] {
  if (!wf.speechActivity || !wf.rms?.length || wf.peaks.length !== wf.rms.length || wf.to <= wf.from) return;
  const step = (wf.to - wf.from) / wf.rms.length;
  if (step > 0.031) return; // A coarse waveform cannot locate an edge between syllables.
  const quiet: TimeRange[] = [], valleys: TimeRange[] = [];
  const quietBelow = quietRms(wf.rms, step);
  const spoken = words.filter(w => w.end > w.start && w.text.trim() && !isTag(w.text));
  const { quiet: still, breaths } = quietReading(wf.rms, wf.peaks, wf.from, step, wf.speechActivity, quietBelow, spoken);
  for (let i = 0; i < wf.rms.length; i++) {
    const start = wf.from + i * step, end = wf.from + (i + 1) * step;
    if (still[i]) appendInterval(quiet, start, end);
    // A speech detector can stay active through a real inter-word gap. Offer a deep
    // level trough there for audition, but keep that disagreement explicit.
    // Deep against this recording's floor too: a breath 10 dB over a very quiet room is under any fixed level.
    if (wf.rms[i]! <= Math.min(.002, quietBelow) && wf.peaks[i]! <= .012) appendInterval(valleys, start, end);
  }
  const db = wf.rms.map(dbfs), levels = { from: wf.from, step, db };
  return { voice: wf.speechActivity, valleys, words: onTheirSound(spoken, [...quiet, ...valleys.filter(v => v.end - v.start >= silentValley)], levels),
    quiet, levels, ...(breaths.length && { breaths }) };
}

/**
 * Words placed where the recording has them, when the transcript's timing can't be. A word timed too short to have been
 * said, on sound it shares with a neighbour, beside a stretch of speech that no word explains, was said in that
 * stretch: "Opus 5.5 · and the… · and GPT" was timed with “5.5” in 80 ms at the start of “and”, and the second of
 * “five point five” before it carried no word. A cut of the restart was held for want of a quiet point between
 * “5.5” and “and”, and the closing check then kept the restart, since the edge in the quiet before “and” seemed to take
 * “5.5” with it (2026-11-17). The aligner has spelled numbers since, but a transcript keeps the times it was made with.
 * A moved word keeps its transcript times as `timed`; every edge, note and nearby word reads where it sounds.
 */
function onTheirSound(words: Word[], silent: TimeRange[], levels: AudioLevels): JoinWord[] {
  if (!levels.db.length || words.length < 2) return words;
  const end = levels.from + levels.step * levels.db.length;
  const speech = percentile85Db(levels.db);
  const index = (t: number) => Math.min(levels.db.length, Math.max(0, Math.round((t - levels.from) / levels.step)));
  // Runs of speech: what lies between the measured silences, at a syllable's length and level. A silence shorter than
  // a pause is inside a word or between two said in one breath: “five point five” has one.
  const runs: TimeRange[] = [];
  let at = levels.from;
  for (const q of [...silent].filter(q => q.end - q.start >= silentValley).sort((a, b) => a.start - b.start)) {
    if (q.start > at) runs.push({ start: at, end: q.start });
    at = Math.max(at, q.end);
  }
  if (at < end) runs.push({ start: at, end });
  const sounds = runs.filter(r => r.end - r.start >= MIN_WORD_SOUND && Math.max(...levels.db.slice(index(r.start), index(r.end))) >= speech - SYLLABLE_BELOW_DB);
  const middle = (w: TimeRange) => (w.start + w.end) / 2;
  const runOf = (t: number) => sounds.findIndex(r => r.start <= t && t < r.end);
  const owns = (r: TimeRange, w: Word) => middle(w) >= r.start && middle(w) < r.end;
  const placed: JoinWord[] = [...words];
  words.forEach((w, i) => {
    const syllables = spokenSyllables(w.text);
    if (w.end - w.start >= syllables * SHORTEST_SYLLABLE) return;
    const run = runOf(middle(w));
    if (run < 0) return;
    const prev = words[i - 1], next = words[i + 1];
    // On sound a neighbour's timing holds too: the word is not where it is timed.
    const shared = [prev, next].filter((n): n is Word => !!n && owns(sounds[run]!, n));
    if (!shared.length) return;
    // The next run of speech away from that neighbour, if no word is timed in it and it is long enough for this word.
    const toward = shared.includes(next!) && !shared.includes(prev!) ? -1 : shared.includes(prev!) && !shared.includes(next!) ? 1 : 0;
    if (!toward) return;
    const beside = sounds[run + toward];
    if (!beside) return;
    // Of that run, the part no other word's timing reaches: a word said straight before it can share the run.
    const others = words.filter(o => o !== w && o.end > beside.start && o.start < beside.end);
    const free = toward < 0
      ? { start: Math.max(beside.start, ...others.map(o => o.end)), end: beside.end }
      : { start: beside.start, end: Math.min(beside.end, ...others.map(o => o.start)) };
    if (others.some(o => o.end > free.start + WORD_SLACK && o.start < free.end - WORD_SLACK)) return;
    // Nor past the word timed next to it on that side: the words keep the order they were said in.
    const across = toward < 0 ? prev : next;
    if (across && (toward < 0 ? across.end > free.start + WORD_SLACK : across.start < free.end - WORD_SLACK)) return;
    const length = free.end - free.start;
    if (length < syllables * SHORTEST_SYLLABLE || length > syllables * LONGEST_SYLLABLE + WORD_SLACK * 2) return;
    placed[i] = { text: w.text, start: free.start, end: free.end, timed: { start: w.start, end: w.end } };
  });
  return placed;
}

/** How many syllables a transcript word takes to say, at least: a numeral's digits are said too. */
function spokenSyllables(text: string) {
  const t = text.toLowerCase().replace(/[^a-z0-9.%$]/g, "").replace(/\.$/, "");
  const digits = (t.match(/[0-9]/g) ?? []).length + (t.match(/[0-9]\.[0-9]/g) ?? []).length + 2 * (t.match(/[%$]/g) ?? []).length;
  const vowels = (t.replace(/[^a-z]/g, "").replace(/e$/, "").match(/[aeiouy]+/g) ?? []).length;
  return Math.max(1, digits + vowels);
}
/** No syllable is said in less than this. */
const SHORTEST_SYLLABLE = .06;
/** A stretch longer than this per syllable holds more than the word. */
const LONGEST_SYLLABLE = .45;
/** How far a neighbour's timing may reach into a run of speech that still has no word of its own. */
const WORD_SLACK = .05;

export const reach = .75, wordMargin = .02, quietMargin = .03;

/**
 * Padding for a word-addressed removal when the model gives none. When Scarlet places an edge in a quiet run, it leaves
 * AIR_AFTER_SPEECH of room tone after the last kept word (its decay and release) and
 * AIR_BEFORE_SPEECH before kept speech resumes (a natural entrance, no clipped breath onset).
 * A run shorter than both splits proportionally. An edge the model already put in silence stays put:
 * pacing is the model's call, and timeline_join_audit reports the air either side. How long a join's pause plays is
 * pacing too, so the model can say it per cut (`leave`), and how soon the voice comes in after the cut (`voiceIn`),
 * by the pace its skill and the editor ask for.
 * A pause plays on the outgoing side of the cut: the air before the voice is the same short length whatever the
 * pause (splitLeave). It was a share of the pause, 0.10 s of the default beat, and a word takes another 0.03 to 0.05 s
 * to reach speaking level after the quiet ends: on a 105-cut pass the voice came in a median 0.12 s after the picture
 * cut, and 0.21 s after a tenth of them, where the model had asked for a longer pause. The editor heard the wait after
 * each cut (2026-11-16).
 * The air after the word is its decay and no more. At 0.2 s, and the 0.18 s a skill asked for, the picture held on the
 * editor silent, or breathing in, before each cut; he asked for the cut at the end of the word's sound, and chose about a
 * tenth of a second of quiet in all at a cut, with a longer pause only where one earns it (2026-11-20).
 */
export const AIR_AFTER_SPEECH = .05;
export const AIR_BEFORE_SPEECH = .05;
/** The default padding either side of a join, together: what a join plays word to word when the model names no length. */
export const PAUSE_BEAT = AIR_AFTER_SPEECH + AIR_BEFORE_SPEECH;
/**
 * The room tone a join leaves: `after` the last kept word and `before` speech resumes, in the recording's seconds. A
 * skill sets it as a pace; Scarlet's defaults are AIR_AFTER_SPEECH and AIR_BEFORE_SPEECH.
 */
export interface JoinPace { after: number; before: number }
export const DEFAULT_PACE: JoinPace = { after: AIR_AFTER_SPEECH, before: AIR_BEFORE_SPEECH };
/**
 * The air either side of a join that plays `leave` seconds word to word. `voiceIn` of them, or the pace's `before`,
 * sit between the cut and the voice, and the rest plays before the cut. A pause shorter than twice the pace's `before`
 * is halved. A `voiceIn` the model gives may take more than half, down to the pace's `after` left for the last word's
 * release: halved, a 0.6 s beat asked for after the cut played 0.3 s of it after the last word instead, and on
 * camera that quiet showed the speaker look away (2026-11-20).
 */
export const splitLeave = (leave: number, pace: JoinPace = DEFAULT_PACE, voiceIn?: number): JoinPace => {
  const half = leave / 2;
  const before = voiceIn === undefined ? Math.min(pace.before, half) : Math.min(voiceIn, leave - Math.min(pace.after, half));
  return { after: leave - before, before };
};

/**
 * A cut that asks for less than quietMargin before the voice is asked to land on the word: its edge goes to the end of
 * the quiet before the word, on the frame nearest it, and may sit this far into the word's first sound while that
 * sound is still under speaking level. A soft start (“This”) takes a tenth of a second to rise, and an editor cutting
 * by ear put the cut on its first frame; a hard one (“But”) is at level at once, and the edge stays before it.
 */
const ONSET_REACH = .02;
/** The least a cut can ask for before the voice: none, the cut on the word's first sound. */
export const LEAST_VOICE_IN = 0;
/** Sound this loud is speech or a sound the ear follows: the bar under which quiet runs are measured. */
export const SPEECH_DBFS = dbfs(QUIET_RMS);

/** The latest an edge may sit beside the sound that ends quiet run `run`: its end, or a little into a soft start. */
export function onsetLimit(page: JoinPage["edges"] | undefined, runEnd: number): number {
  const levels = page?.levels;
  if (!levels) return runEnd;
  let limit = runEnd;
  for (let i = Math.floor((runEnd - levels.from) / levels.step + 1e-6); i >= 0 && i < levels.db.length; i++) {
    const from = levels.from + i * levels.step;
    if (from >= runEnd + ONSET_REACH - 1e-9 || levels.db[i]! > SPEECH_DBFS) break;
    limit = Math.min(runEnd + ONSET_REACH, from + levels.step);
  }
  return limit;
}
/** Whether an edge at `t` that starts a clip is on the first sound after a measured silence: nothing of the word is cut off. */
export function onWordOnset(page: NonNullable<JoinPage["edges"]>, t: number): boolean {
  return gaps(page).some(q => q.end - q.start >= 2 * quietMargin && q.end - quietMargin < t && t <= onsetLimit(page, q.end) + 1e-6);
}

/**
 * Where an edge sits in quiet run `run`. A `start` edge follows kept speech; an `end` edge precedes it.
 */
export function padEdge(run: TimeRange, side: "start" | "end", air: JoinPace = DEFAULT_PACE): number {
  const { after, before } = air;
  const length = run.end - run.start;
  const target = length < after + before
    ? run.start + length * after / (after + before)
    : side === "start" ? run.start + after : run.end - before;
  // soundAt only trusts a run's interior.
  return Math.min(Math.max(target, run.start + quietMargin), run.end - quietMargin);
}
/** An audio-confirmed move this short trims a breath or a consonant fragment, never a whole word. */
export const snapLimit = .12;
/** An edge this close to a frame is on it, as the engine's frame rounding treats it (FRAME_SLACK in @scarlet/timeline). */
export const FRAME_TOLERANCE = .001;
/** A shorter quiet run inside a transcript word may be a stop consonant's closure, not a gap between words. */
export const inWordGap = .1;

/** The instant is inside the word's timing, clear of both its edges. */
export const inWord = (w: Word, t: number) => w.start + wordMargin < t && t < w.end - wordMargin;
/** A transcript tag such as [music], which names no spoken word. */
export const plain = (w: Pick<Word, "text">) => w.text.trim().replace(/[.,;:!?]+$/u, "") || w.text.trim();
export const quote = (words: string[]) => [...new Set(words)].map(w => "“" + w + "”").join(" / ");

/** A level trough this long is a real gap even when the speech detector bridges it. */
const silentValley = .1;
const gapCache = new WeakMap<object, TimeRange[]>();
/** Measured silence: quiet runs, plus deep level troughs long enough to be a pause rather than a consonant. */
export function gaps(page: SourceEdge["page"]) {
  let runs = gapCache.get(page);
  if (!runs) {
    runs = [...page.quiet, ...page.valleys.filter(v => v.end - v.start >= silentValley)].sort((a, b) => a.start - b.start);
    gapCache.set(page, runs);
  }
  return runs;
}

/** What the recording itself contains at a source instant. Word timings and the speech detector never override it. */
export function soundAt(page: SourceEdge["page"], t: number): Sound {
  const inside = (q: TimeRange) => q.start + quietMargin <= t && t <= q.end - quietMargin;
  const run = gaps(page).find(inside);
  if (run) {
    const spoken = page.words.some(w => inWord(w, t));
    return spoken && run.end - run.start < inWordGap ? "valley" : "quiet";
  }
  return page.valleys.some(inside) ? "valley" : "sound";
}

/** The scan's reading of one recording at a source instant. In page overlaps, the one with the most context around it. */
export function pageAt(pages: JoinPage[], mediaId: string, stream: number | undefined, t: number) {
  let best: JoinPage | undefined;
  for (const p of pages) {
    if (p.mediaId !== mediaId || (p.audioStream ?? 0) !== stream || !p.edges || p.start > t || p.end < t) continue;
    if (!best || Math.min(t - p.start, p.end - t) > Math.min(t - best.start, best.end - t)) best = p;
  }
  return best?.edges;
}

/**
 * How close sound at speaking level comes to a cut's edge on the side it removes: after source instant `t` for the
 * cut's start (`out`), before it for its end (`in`), looking no further than `limit` seconds. Undefined when nothing
 * sounds that close or no page measured the recording there. An edge a few hundredths of a second from a removed
 * word can be clean in the sound and still show it in the picture: on one pass a cut ended 38 ms before "and", the
 * join measured silent, and the editor saw the next word starting (2026-11-13).
 */
export function soundBesideEdge(pages: JoinPage[], mediaId: string, stream: number | undefined, t: number, side: "out" | "in", limit: number): number | undefined {
  const page = pageAt(pages, mediaId, stream, t), levels = page?.levels;
  if (!levels || !pageReaches(page, t)) return;
  const { from, step, db } = levels;
  // A bucket is on the side its middle is on: the one the edge falls in holds kept sound as well as removed sound, and
  // is counted as removed only when most of it is.
  if (side === "out") {
    for (let i = Math.max(0, Math.ceil((t - from) / step - .5)); i < db.length && from + i * step < t + limit; i++)
      if (db[i]! > SPEECH_DBFS) return Math.max(0, from + i * step - t);
  } else {
    for (let i = Math.min(db.length - 1, Math.floor((t - from) / step - .5)); i >= 0 && from + (i + 1) * step > t - limit; i--)
      if (db[i]! > SPEECH_DBFS) return Math.max(0, t - from - (i + 1) * step);
  }
}

export function levelStrip(levels: AudioLevels, t: number) {
  const value = (s: number) => {
    const i = Math.floor((s - levels.from) / levels.step);
    return i >= 0 && i < levels.db.length ? String(levels.db[i]) : "·";
  };
  const before: string[] = [], after: string[] = [];
  for (let k = 15; k >= 1; k--) before.push(value(t - k * .02));
  for (let k = 0; k < 15; k++) after.push(value(t + k * .02));
  return before.join(" ") + " | " + after.join(" ");
}

/**
 * How far word timings may be trusted when finding the gap beside removed words. A quiet run may reach only
 * `keptSlack` into the kept word (so the edge never eats it) but up to `removedSlack` into the removed one:
 * ASR often ends a removed word late or starts it early, with no gap at all between the two timings.
 */
export const keptSlack = .05, removedSlack = .3;

/** Whether the stretch a page measured includes source instant `t`. A page that kept no levels can't say, and counts as reaching it. */
export function pageReaches(page: NonNullable<JoinPage["edges"]>, t: number) {
  const { levels } = page;
  return !levels || (levels.from - 1e-6 <= t && t <= levels.from + levels.step * levels.db.length + 1e-6);
}

/** Of the quiet runs in a gap, the one that reaches furthest toward the kept word: the earliest to start after it, or the latest to end before it. */
export function besideWord(runs: TimeRange[], side: "start" | "end") {
  return runs.reduce<TimeRange | undefined>((best, q) => !best || (side === "start" ? q.start < best.start : q.end > best.end) ? q : best, undefined);
}

/** A syllable reaches this close to the level speech sits at on the page. Sound counts as speech as gapSound counts it (soundFloor). */
const SYLLABLE_BELOW_DB = 6;
/** A run of sound this short is a click, not a syllable. */
const MIN_WORD_SOUND = .06;
/** How far from its timing a kept word's sound is looked for. */
const MAX_RETIME = 2;

/**
 * Where a kept word beside a cut really sounds, when the recording is quiet all through its timing. ASR often hangs the
 * first half of a word on the end of the phrase before a pause: on one pass “all right” after a pause was timed
 * “…got you all <1.2 s> right”, three times in one video, and each cut that ended before “all” kept the whole pause.
 * The word is the start of the first run of speaking-level sound after its timing (the last before it, for a word
 * that precedes the cut), provided that sound begins before the next word's timing does (ends after the previous word's), so the sound
 * is the word's and not its neighbour's. A breath is far under speaking level and stays with the pause. Undefined when the word
 * sounds where it is timed, or when the page cannot say.
 */
export function soundingWord(page: JoinPage["edges"] | undefined, kept: Word, neighbour: Word | undefined, side: "start" | "end"): Word | undefined {
  const levels = page?.levels;
  if (!page || !levels?.db.length) return;
  const loud = extremeLevel(page, kept.start, kept.end, "highest");
  if (!loud || loud.db > SPEECH_DBFS) return;
  const speech = percentile85Db(levels.db), floor = soundFloor(speech, dbfs(roomRms(levels.db.map(d => 10 ** (d / 20)), levels.step)));
  // A run is a syllable once it gets near the level speech sits at. An inhale before the word can pass the floor,
  // as one did at -38 dBFS beside speech at -20, and it stays with the pause.
  const syllable = (from: number, to: number) => Math.max(...levels.db.slice(from, to)) >= speech - SYLLABLE_BELOW_DB;
  const at = (i: number) => levels.from + i * levels.step, index = (t: number) => Math.floor((t - levels.from) / levels.step);
  const minRun = Math.ceil(MIN_WORD_SOUND / levels.step);
  if (side === "end") {
    // The word follows the cut: its sound is the first speech after the start of its timing.
    const limit = neighbour ? neighbour.start : kept.end + MAX_RETIME;
    for (let i = Math.max(0, index(kept.start)); i < levels.db.length && at(i) < Math.min(limit, kept.start + MAX_RETIME); i++) {
      if (levels.db[i]! < floor) continue;
      let n = i;
      while (n < levels.db.length && levels.db[n]! >= floor) n++;
      if (n - i < minRun || !syllable(i, n)) { i = n; continue; }
      const start = at(i);
      if (start <= kept.end) return;
      return { text: kept.text, start, end: start + (kept.end - kept.start) };
    }
    return;
  }
  // The word precedes the cut: its sound is the last speech before the end of its timing.
  const limit = neighbour ? neighbour.end : kept.start - MAX_RETIME;
  for (let i = Math.min(levels.db.length - 1, index(kept.end)); i >= 0 && at(i + 1) > Math.max(limit, kept.end - MAX_RETIME); i--) {
    if (levels.db[i]! < floor) continue;
    let n = i;
    while (n >= 0 && levels.db[n]! >= floor) n--;
    if (i - n < minRun || !syllable(n + 1, i + 1)) { i = n; continue; }
    const end = at(i + 1);
    if (end >= kept.start) return;
    return { text: kept.text, start: end - (kept.end - kept.start), end };
  }
}

/**
 * A level this low between two words is room tone, only too brief to be a run of silence or bridged by the speech
 * detector: the instant between two words said in one breath. Someone who repeats a word without pausing leaves
 * nothing else to cut in, and a pass's cuts of doubled words all went to the editor for want of it. The bar is far
 * under silence's own (an RMS of .01, -40 dBFS) because a sibilant's hiss sits just below that: of twenty such joins
 * on one pass, the editor heard a leftover “s” at one placed at -47 dBFS, and a transcript of the cut showed a
 * changed neighboring word at two more, at -40 and -44.
 */
export const DIP_DBFS = -55;
/**
 * A trough between two words said in one breath that isn't down at room tone can still be the place an editor cuts:
 * the level falls well under the sound either side, as it shows on a waveform. On a pass whose held cuts all read
 * "no quiet point", eight of nine such edges had one within a tenth of a second, and the editor's own cut at one of
 * them was on it (2026-11-16). The level stays under the -47 dBFS where an editor once heard a leftover “s” (DIP_DBFS).
 */
export const TROUGH_DBFS = -48, TROUGH_DEPTH_DB = 10;
/**
 * A shallower low point, as deep under the sound either side, is where an edge within 50 ms of it goes, an edge given
 * in seconds or the place a word reference's words part, and what an edge left in sound is told of. Scarlet does not go looking for one further off: the
 * stop before a final “s” reads the same, and moving a pause's edge 0.1 s onto it in “21 cents” would have cut the “s”.
 * Edges two and three frames inside “you” and “that” sat beside low points at -45 dBFS, 13 dB under the words either
 * side, and the editor asked for the cut on them (2026-11-16).
 */
export const LOW_POINT_DBFS = -44, LOW_POINT_REACH = .05;
/** How far either side of a trough the sound it lies under is looked for. */
const TROUGH_REACH = .08;
/** How far an edge in sound looks for the trough that bounds the sound it is in. */
export const TROUGH_SEARCH = .2;

/** How far bucket `i` lies under the loudest level within TROUGH_REACH on each side: the shallower of the two. */
export function troughDepth(levels: AudioLevels, i: number) {
  const k = Math.max(1, Math.round(TROUGH_REACH / levels.step));
  let left = -Infinity, right = -Infinity;
  for (let j = Math.max(0, i - k); j < i; j++) left = Math.max(left, levels.db[j]!);
  for (let j = i + 1; j <= Math.min(levels.db.length - 1, i + k); j++) right = Math.max(right, levels.db[j]!);
  return Math.min(left, right) - levels.db[i]!;
}

/** A level an edge can sit at between words: room tone, or a trough deep under the sound either side. */
export function isDip(levels: AudioLevels, i: number, bar = TROUGH_DBFS) {
  const db = levels.db[i]!;
  return db <= DIP_DBFS || db <= bar && troughDepth(levels, i) >= TROUGH_DEPTH_DB;
}

/** Whether `t` sits in measured quiet/valley or at room tone (`<= DIP_DBFS`), where no word is sounding. */
export function atRoomTone(page: NonNullable<JoinPage["edges"]>, t: number): boolean {
  if (soundAt(page, t) !== "sound") return true;
  const levels = page.levels;
  if (!levels) return false;
  const i = Math.floor((t - levels.from) / levels.step);
  return i >= 0 && i < levels.db.length && levels.db[i]! <= DIP_DBFS;
}

/** Whether `t` sits in measured quiet/valley or at a dip (room tone or deep trough) between words. */
export function atQuietOrDip(page: NonNullable<JoinPage["edges"]>, t: number): boolean {
  if (soundAt(page, t) !== "sound") return true;
  const levels = page.levels;
  if (!levels) return false;
  const i = Math.floor((t - levels.from) / levels.step);
  return i >= 0 && i < levels.db.length && isDip(levels, i);
}

/** A level and its frame centre, read from the same buckets that locate silence. */
export function extremeLevel(page: NonNullable<JoinPage["edges"]>, from: number, to: number, kind: "lowest" | "highest") {
  const levels = page.levels;
  if (!levels) return;
  let best: { at: number; db: number } | undefined;
  for (let i = Math.max(0, Math.ceil((from - levels.from) / levels.step - .5)); i < levels.db.length; i++) {
    const at = levels.from + (i + .5) * levels.step, db = levels.db[i]!;
    if (at > to) break;
    if (!best || (kind === "lowest" ? db < best.db : db > best.db)) best = { at, db };
  }
  return best;
}

/** Peak sound time inside `word`, or `fallback` when the recording is quiet all through the word's timing. */
export function wordPeakAt(page: NonNullable<JoinPage["edges"]>, word: Word, fallback: number): number {
  const peak = extremeLevel(page, word.start, word.end, "highest");
  return peak && peak.db > SPEECH_DBFS ? peak.at : fallback;
}

/**
 * Where an edge sits in the dip between two words that run together: the middle of the stretch at room tone around
 * the lowest level, not the lowest bucket itself. The lowest bucket is as often the last one before the next word
 * starts, and an edge there has that word's first sound inside the join's crossfade: of seven such edges on one
 * pass, six had speech within 20 ms.
 *
 * Given the kept word beside the edge (`beside`), the dip is the one beside that word, where its sound ends or before
 * it starts, as a quiet run is (besideWord), not the lowest level further off. After “cube simulation.” the speech
 * detector stayed on through the pause and a breath, so no quiet run was found; the lowest level was the room after
 * the breath, and the cut held on the editor breathing for a third of a second. The room right after the word's sound
 * was 3 frames long (2026-11-20). And a dip the kept word sounds past at speaking level is inside that word, not where
 * it ends: the stop of the “p” in “subscription” sat 0.24 s before the word's end, under its loudest sound by 20 dB,
 * and the cut there took “-tion” off (2026-11-20). Since 2026-11-21 a breath after that room is the model's to keep
 * (`breath`, in wordCutRange); the default is the skill's, this room.
 */
export function dipBetween(page: NonNullable<JoinPage["edges"]>, from: number, to: number, boundary?: number, beside?: { side: "start" | "end"; kept: Word }) {
  const levels = page.levels, low = extremeLevel(page, from, to, "lowest");
  const at = levels && low ? Math.floor((low.at - levels.from) / levels.step) : -1;
  if (!levels || !low) return low && { ...low, room: undefined, dip: false };
  const centre = (i: number) => levels.from + (i + .5) * levels.step;
  const room = (first: number, last: number) => ({ start: levels.from + first * levels.step, end: levels.from + (last + 1) * levels.step });
  if (beside) {
    // Each stretch at room tone in the window, nearest the kept word first.
    const stretches: Array<[number, number]> = [];
    for (let i = Math.max(0, Math.ceil((from - levels.from) / levels.step - .5)); i < levels.db.length && centre(i) <= to; i++) {
      if (levels.db[i]! > DIP_DBFS) continue;
      const last = stretches.at(-1);
      if (last && last[1] === i - 1) last[1] = i; else stretches.push([i, i]);
    }
    if (beside.side === "end") stretches.reverse();
    for (const [first, last] of stretches) {
      if (keptSoundsPast(page, room(first, last), beside.kept, beside.side)) continue;
      let db = Infinity;
      for (let i = first; i <= last; i++) db = Math.min(db, levels.db[i]!);
      return { at: (centre(first) + centre(last)) / 2, db, dip: true, room: room(first, last) };
    }
  }
  const roomTone = low.db <= DIP_DBFS;
  // A trough above room tone is a dip only when its floor is inside the stretch searched: the lowest level at the
  // stretch's end is the wall of a trough beyond it, still in sound. On one pass that edge was saved 70 ms past the
  // trough between “game” and “let”, in “let” (2026-11-16).
  const inside = centre(at - 1) >= from && centre(at + 1) <= to && levels.db[at - 1]! >= low.db && levels.db[at + 1]! >= low.db;
  const bar = boundary !== undefined && Math.abs(low.at - boundary) <= LOW_POINT_REACH ? LOW_POINT_DBFS : TROUGH_DBFS;
  if (!roomTone && !(inside && isDip(levels, at, bar))) return { ...low, room: undefined, dip: false };
  // The stretch around the lowest level that is still down in it: at room tone, or within a few dB of a trough's floor.
  const floor = roomTone ? DIP_DBFS : low.db + 6;
  let first = at, last = at;
  while (first > 0 && centre(first - 1) >= from && levels.db[first - 1]! <= floor) first--;
  while (last + 1 < levels.db.length && centre(last + 1) <= to && levels.db[last + 1]! <= floor) last++;
  if (beside && keptSoundsPast(page, room(first, last), beside.kept, beside.side)) return { ...low, room: undefined, dip: false };
  // At room tone the middle of the quiet; in a trough its floor, where the sound either side is furthest.
  return { at: roomTone ? (centre(first) + centre(last)) / 2 : centre(at), db: low.db, dip: true, room: room(first, last) };
}

/** A breath sits at least this far under the word before it. */
const BREATH_UNDER_WORD_DB = 20;
/**
 * What a cut that starts after a kept word does with a breath between the word and the quiet: `cut` starts it in the
 * room right after the word, so the breath goes; `keep` starts it in the quiet after the breath, so the breath plays.
 * Until 2026-11-21 Scarlet always cut it, a rule of taste the stock skill states too (“cut … before any breath”), so an
 * editor who wanted the breath kept could not have it. The model decides; the default is the skill's.
 */
export type Breath = "cut" | "keep";
/** A breath after a kept word, as measured: where it sounds, its loudest level, and how far that is under the word. */
export interface BreathAfterWord { breath: TimeRange; db: number; underWord?: number }

/**
 * Whether what lies between two stretches at room tone after a kept word is a breath: sound far under the word, in no
 * word. The level reading of it, when it is.
 */
export function breathBetween(page: NonNullable<JoinPage["edges"]>, kept: Word, before: TimeRange, after: TimeRange): BreathAfterWord | undefined {
  const levels = page.levels, loudest = extremeLevel(page, kept.start, kept.end, "highest");
  if (!levels || !loudest || after.start <= before.end + 1e-6) return;
  if (page.words.some(w => w.start < after.start && w.end > before.end)) return;
  const index = (t: number) => Math.floor((t - levels.from) / levels.step + 1e-6);
  let db = -Infinity;
  for (let i = index(before.end); i < Math.min(levels.db.length, index(after.start)); i++) {
    if (levels.db[i]! > loudest.db - BREATH_UNDER_WORD_DB) return;
    db = Math.max(db, levels.db[i]!);
  }
  // Shorter than a level bucket, it has no level of its own.
  return { breath: { start: before.end, end: after.start }, db, ...(Number.isFinite(db) && { underWord: loudest.db - db }) };
}

/** The first stretch at room tone that starts after `from`, in buckets whose middle is before `until`. */
export function roomToneAfter(page: NonNullable<JoinPage["edges"]>, from: number, until: number): TimeRange | undefined {
  const levels = page.levels;
  if (!levels) return;
  const centre = (i: number) => levels.from + (i + .5) * levels.step;
  let first = -1, last = -1;
  for (let i = Math.max(0, Math.ceil((from - levels.from) / levels.step - 1e-6)); i < levels.db.length && centre(i) <= until; i++) {
    if (levels.db[i]! <= DIP_DBFS) { if (first < 0) first = i; last = i; } else if (first >= 0) break;
  }
  return first < 0 ? undefined : { start: levels.from + first * levels.step, end: levels.from + (last + 1) * levels.step };
}

/**
 * The room right after a kept word's sound, when what follows it up to the quiet run `run` is a breath: sound far under
 * the word, in no word. A breath keeps the speech detector on and the level over the room, so the quiet run the edge
 * would pad into starts after it, and the cut held on the editor breathing in. After “cube simulation.” the room came
 * back for 80 ms, a breath ran 0.12 s at -50 dBFS, and the cut came 0.36 s after the word (2026-11-20).
 * Whether the cut starts in that room or after the breath is the model's call since 2026-11-21 (`breath`): this only
 * measures, and wordCutRange places the edge as asked and says what was found.
 */
export function roomBeforeBreath(page: NonNullable<JoinPage["edges"]>, kept: Word, run: TimeRange): (BreathAfterWord & { room: TimeRange }) | undefined {
  const levels = page.levels;
  if (!levels || run.start <= kept.end) return;
  const index = (t: number) => Math.floor((t - levels.from) / levels.step + 1e-6);
  let first = -1, last = -1;
  for (let i = Math.max(0, index(kept.end - keptSlack)); i < Math.min(levels.db.length, index(run.start)); i++) {
    if (levels.db[i]! <= DIP_DBFS) { if (first < 0) first = i; last = i; } else if (first >= 0) break;
  }
  if (first < 0) return;
  const quiet = { start: levels.from + first * levels.step, end: levels.from + (last + 1) * levels.step };
  if (quiet.end - quiet.start < 2 * quietMargin || quiet.end >= run.start - 1e-6 || keptSoundsPast(page, quiet, kept, "start")) return;
  const found = breathBetween(page, kept, quiet, run);
  return found && { ...found, room: quiet };
}

/**
 * The room right before a kept word's sound, when what precedes it from the quiet run `run` is an intake breath or click:
 * sound far under the word, in no word. Mirror of roomBeforeBreath on the incoming edge.
 */
export function roomAfterBreath(page: NonNullable<JoinPage["edges"]>, kept: Word, run: TimeRange): (BreathAfterWord & { room: TimeRange }) | undefined {
  const levels = page.levels;
  if (!levels || run.end >= kept.start) return;
  const index = (t: number) => Math.floor((t - levels.from) / levels.step + 1e-6);
  let first = -1, last = -1;
  const from = Math.max(0, index(run.end));
  const to = Math.min(levels.db.length - 1, index(kept.start + keptSlack));
  for (let i = to; i >= from; i--) {
    if (levels.db[i]! <= DIP_DBFS) { if (last < 0) last = i; first = i; } else if (last >= 0) break;
  }
  if (last < 0) return;
  const quiet = { start: levels.from + first * levels.step, end: levels.from + (last + 1) * levels.step };
  if (quiet.end - quiet.start < 2 * quietMargin || quiet.start <= run.end + 1e-6 || keptSoundsPast(page, quiet, kept, "end")) return;
  const found = breathBetween(page, kept, run, quiet);
  return found && { ...found, room: quiet };
}

/**
 * A breath the quiet run `run` beside a kept word holds: after the outgoing word (`side === "start"`) or before the
 * incoming word (`side === "end"`).
 */
export function breathInRun(page: NonNullable<JoinPage["edges"]>, kept: Word, run: TimeRange, side: "start" | "end" = "start"): BreathAfterWord | undefined {
  const held = side === "start"
    ? page.breaths?.find(b => b.side !== "before" && b.start >= run.start - 1e-6 && b.end <= run.end + 1e-6 && b.start >= kept.start)
    : page.breaths?.findLast(b => b.side === "before" && b.start >= run.start - 1e-6 && b.end <= run.end + 1e-6 && b.end <= kept.end);
  if (!held) return;
  const loudest = extremeLevel(page, kept.start, kept.end, "highest");
  return { breath: { start: held.start, end: held.end }, db: held.db, ...(loudest && { underWord: loudest.db - held.db }) };
}

/** What a cut's edge found beside the kept word, and where the edge is beside it. `unkept` says why a breath asked to play doesn't. */
export function breathNote(kept: Word, found: BreathAfterWord, at: number, breath: Breath, unkept?: string, side: "start" | "end" = "start") {
  const { start, end } = found.breath;
  const where = side === "start"
    ? (at <= start + 1e-6 ? "before it" : at >= end - 1e-6 ? "after it, so it plays" : `${(at - start).toFixed(2)} s into it, so that much of it plays`)
    : (at >= end - 1e-6 ? "after it" : at <= start + 1e-6 ? "before it, so it plays" : `${(end - at).toFixed(2)} s before its end, so that much of it plays`);
  const level = Number.isFinite(found.db) ? ` at up to ${Math.round(found.db)} dBFS${found.underWord === undefined ? "" : ` (${Math.round(found.underWord)} dB under the word)`}` : "";
  const relation = side === "start" ? "follows" : "precedes";
  const edge = side === "start" ? "starts" : "ends";
  return `A breath ${relation} “${plain(kept)}”: ${(end - start).toFixed(2)} s${level}, in no word; the cut ${edge} ${where}${unkept ? `, ${unkept}` : ""} (breath ${breath}).`;
}

/** Sound this close to a word's loudest, for this long, is the word still speaking. */
const STILL_SPEAKING_DB = 15, STILL_SPEAKING_SECONDS = .06;
/**
 * Whether the kept word sounds on at speaking level between a dip and where the transcript ends it (`side` start), or
 * before the dip from where it starts it (`side` end): then the dip is inside the word, such as the stop before a
 * consonant, and an edge there cuts the word short.
 */
export function keptSoundsPast(page: NonNullable<JoinPage["edges"]>, dip: TimeRange, kept: Word, side: "start" | "end") {
  const levels = page.levels, loudest = extremeLevel(page, kept.start, kept.end, "highest");
  if (!levels || !loudest) return false;
  const from = side === "start" ? dip.end : kept.start, to = side === "start" ? kept.end : dip.start;
  const most = Math.round(STILL_SPEAKING_SECONDS / levels.step);
  let run = 0;
  for (let i = Math.max(0, Math.floor((from - levels.from) / levels.step)); i < levels.db.length; i++) {
    if (levels.from + (i + .5) * levels.step > to) break;
    run = levels.db[i]! >= loudest.db - STILL_SPEAKING_DB ? run + 1 : 0;
    if (run >= most) return true;
  }
  return false;
}

/**
 * The whole frame of a version nearest to a placed edge, when the stretch the edge may sit in holds one. A removal is
 * saved on whole frames, rounded inward: up to a frame of what was to come out stays. Beside a word that is the
 * word's first or last sound, left playing at the join. `toTimeline` maps a source second through the clip that plays it.
 */
export function edgeOnFrame(at: number, room: TimeRange | undefined, fps: number, toTimeline: (source: number) => number): number {
  if (!room) return at;
  const lo = toTimeline(room.start), hi = toTimeline(room.end);
  let best: number | undefined;
  for (let f = Math.ceil(lo * fps - 1e-7); f / fps <= hi + 1e-7; f++) {
    if (best === undefined || Math.abs(f / fps - at) < Math.abs(best - at)) best = f / fps;
  }
  return best ?? at;
}

/**
 * What a join check that found both edges in quiet (`unchanged`) did to the range asked for: an edge whose whole frame
 * would round onto sound moves onto a quiet frame. Undefined when neither edge moved.
 */
export function quietFrameNote(asked: TimeRange, placed: TimeRange): string | undefined {
  const moved = (["start", "end"] as const).filter(side => Math.abs(placed[side] - asked[side]) > 1e-6);
  if (!moved.length) return undefined;
  const s3 = (t: number) => `${round3(t).toFixed(3)} s`;
  return `${moved.map(side => `Moved the ${side} from ${s3(asked[side])} to ${s3(placed[side])}`).join(" and ")}, onto a quiet frame: the recording is quiet at the edge, and the whole frame it would be saved on has sound.`;
}
