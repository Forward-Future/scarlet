import { applyReviewRemovals, clipDuration, clipEnd, intervalCandidates, crossfadeJoins, sourceToTimeline, timelineDuration, timelineToSource, type MediaAsset, type MediaClip, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { JOIN_WORD_SECONDS, normalizeTranscriptToken } from "@scarlet/shared";
import { audibleClipsByTrack, dbfs, isTag, round3 } from "./analysis.js";
import { REPEAT_WITHIN } from "./dialogue-leftovers.js";
import { partialRepeatAtJoin, type FragmentSide } from "./dialogue-fragment-repeat.js";
import { QUIET_RMS, quietBuckets, quietRms } from "./gap-sound.js";
import { MAX_CROSSFADE, timelineJoins, type JoinSide } from "./timeline-perception.js";

type Word = Pick<TranscriptWord, "text" | "start" | "end">;
/** A word as the join check reads it: where the recording has it, and, when that is not where the transcript times it, `timed`. */
type JoinWord = Word & { timed?: TimeRange };
interface Waveform { from: number; to: number; peaks: number[]; rms?: number[]; speechActivity?: TimeRange[] }
/** Measured RMS level of the source in dBFS, one value per waveform bucket. */
export interface AudioLevels { from: number; step: number; db: number[] }
export interface JoinPage extends TimeRange { mediaId: string; audioStream?: number; edges?: { words: JoinWord[]; quiet: TimeRange[]; valleys: TimeRange[]; voice: TimeRange[]; levels?: AudioLevels } }
export interface JoinCheck extends TimeRange {
  /** `snapped` moved an edge a few frames onto measured silence and is safe to apply as proposed. */
  status: "unchanged" | "snapped" | "adjusted" | "partial" | "review";
  reason?: string;
  /** The scan has no audio measurements at a failing edge, so the check found nothing either way. */
  unmeasured?: boolean;
  /** Edges left in sound at speaking level, with no quiet or low point Scarlet could move them to within the words asked for. */
  inSound?: Array<"start" | "end">;
  /** Of those, the edges inside a transcript word that is sounding there. */
  inWord?: Array<"start" | "end">;
  /** Both edges are where sameWordJoin puts them: inside the word said on either side of the cut. */
  sameWord?: string;
  /** Where this removal could switch takes inside the word said on either side of it, when its start has no quiet. */
  sameWordJoin?: TimeRange & { word: string; reason: string; takesFirst?: true };
}

export function dialogueAudioStream(source: object) {
  return "audioStream" in source && typeof source.audioStream === "number" ? source.audioStream : undefined;
}

function appendInterval(runs: TimeRange[], start: number, end: number) {
  const previous = runs.at(-1);
  if (previous && Math.abs(previous.end - start) < 1e-6) previous.end = end;
  else runs.push({ start, end });
}

/** Keep short quiet intervals once per scan instead of decoding the recording for each proposed cut. */
export function joinEvidence(words: Word[], wf: Waveform): JoinPage["edges"] {
  if (!wf.speechActivity || !wf.rms?.length || wf.peaks.length !== wf.rms.length || wf.to <= wf.from) return;
  const step = (wf.to - wf.from) / wf.rms.length;
  if (step > 0.031) return; // A coarse waveform cannot locate an edge between syllables.
  const quiet: TimeRange[] = [], valleys: TimeRange[] = [];
  const quietBelow = quietRms(wf.rms, step);
  const spoken = words.filter(w => w.end > w.start && w.text.trim() && !isTag(w.text));
  const still = quietBuckets(wf.rms, wf.peaks, wf.from, step, wf.speechActivity, quietBelow, spoken);
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
    quiet, levels };
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
  const sorted = [...levels.db].sort((a, b) => a - b);
  const speech = sorted[Math.floor(sorted.length * .85)]!;
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

const reach = .75, wordMargin = .02, quietMargin = .03;

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
/** The latest an edge may sit beside the sound that ends quiet run `run`: its end, or a little into a soft start. */
function onsetLimit(page: JoinPage["edges"] | undefined, runEnd: number): number {
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
function onWordOnset(page: NonNullable<JoinPage["edges"]>, t: number): boolean {
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
const snapLimit = .12;
/** An edge this close to a frame is on it, as the engine's frame rounding treats it (FRAME_SLACK in @scarlet/timeline). */
const FRAME_TOLERANCE = .001;
/** A shorter quiet run inside a transcript word may be a stop consonant's closure, not a gap between words. */
const inWordGap = .1;
interface SourceEdge { clip: MediaClip; page: NonNullable<JoinPage["edges"]>; at: number; clipped: Word[]; touching: Word[] }
interface Edge { at: number; label?: string; problem?: string; note?: string; snapped?: boolean; unmeasured?: boolean; dip?: boolean; inSound?: boolean; inWord?: boolean;
  /** Placed further than a snap, by giving footage back up to a pause with no word between. */
  gaveBack?: boolean }
type Sound = "quiet" | "valley" | "sound";

/** The instant is inside the word's timing, clear of both its edges. */
const inWord = (w: Word, t: number) => w.start + wordMargin < t && t < w.end - wordMargin;
/** A transcript tag such as [music], which names no spoken word. */
const plain = (w: Pick<Word, "text">) => w.text.trim().replace(/[.,;:!?]+$/u, "") || w.text.trim();
const quote = (words: string[]) => [...new Set(words)].map(w => "“" + w + "”").join(" / ");

/** A level trough this long is a real gap even when the speech detector bridges it. */
const silentValley = .1;
const gapCache = new WeakMap<object, TimeRange[]>();
/** Measured silence: quiet runs, plus deep level troughs long enough to be a pause rather than a consonant. */
function gaps(page: SourceEdge["page"]) {
  let runs = gapCache.get(page);
  if (!runs) {
    runs = [...page.quiet, ...page.valleys.filter(v => v.end - v.start >= silentValley)].sort((a, b) => a.start - b.start);
    gapCache.set(page, runs);
  }
  return runs;
}

/** What the recording itself contains at a source instant. Word timings and the speech detector never override it. */
function soundAt(page: SourceEdge["page"], t: number): Sound {
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

/** Sound this loud is speech or a sound the ear follows: the bar under which quiet runs are measured. */
const SPEECH_DBFS = dbfs(QUIET_RMS);

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

/**
 * `paced`: the edge belongs to a range given in seconds with the pause its join should play (`leave`), so an edge in
 * quiet goes where `pace` puts it in that quiet, as a word reference's edge does, instead of staying where it was typed.
 */
function checkEdge(at: number, direction: 1 | -1, nearby: MediaClip[], pages: JoinPage[], fps: number, streams: Map<string, number>, namedEdge?: number, pace: JoinPace = DEFAULT_PACE, paced = false): Edge {
  const sources: SourceEdge[] = [];
  for (const clip of nearby) {
    const lo = clip.timelineIn, hi = lo + clipDuration(clip);
    if (at <= lo + 1e-6 || at >= hi - 1e-6) continue; // An existing clip edge doesn't bisect this clip.
    const t = timelineToSource(clip, at);
    const stream = dialogueAudioStream(clip) ?? streams.get(clip.mediaId);
    const edges = pageAt(pages, clip.mediaId, stream, t);
    if (!edges) return { at, problem: "A dialogue source at this boundary has no timed acoustic scan.", unmeasured: true };
    const clipped = edges.words.filter(w => inWord(w, t));
    // The edge belongs to any word it touches. Moving onto silence beside that word skips nothing.
    const touching = edges.words.filter(w => w.start - wordMargin <= t && t <= w.end + wordMargin);
    sources.push({ clip, page: edges, at: t, clipped, touching });
  }
  // Crossing a clip transition could introduce an unexamined mic or a different source clock.
  const crossesClip = (a: number, b: number) => nearby.some(c => [c.timelineIn, c.timelineIn + clipDuration(c)].some(e =>
    e >= Math.min(a, b) - 1e-6 && e <= Math.max(a, b) + 1e-6));
  const sound = (timeline: number) => sources.reduce<Sound>((worst, s) => {
    const here = soundAt(s.page, timelineToSource(s.clip, timeline));
    return worst === "sound" || here === "sound" ? "sound" : worst === "valley" || here === "valley" ? "valley" : "quiet";
  }, "quiet");
  /** The quiet run under timeline time `t`, shared by every audible source and kept inside each clip. */
  const runAt = (t: number): TimeRange | undefined => {
    let lo = -Infinity, hi = Infinity;
    for (const s of sources) {
      const source = timelineToSource(s.clip, t);
      const run = gaps(s.page).find(q => q.start <= source && source <= q.end);
      if (!run) return;
      const speed = s.clip.speed ?? 1, clipEnd = s.clip.timelineIn + clipDuration(s.clip);
      lo = Math.max(lo, s.clip.timelineIn, s.clip.timelineIn + (run.start - s.clip.sourceIn) / speed);
      hi = Math.min(hi, clipEnd, s.clip.timelineIn + (run.end - s.clip.sourceIn) / speed);
    }
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { start: lo, end: hi } : undefined;
  };
  /** Move a quiet frame to the padded position in its run, on the frame grid, without crossing a clip edge. */
  const padInRun = (t: number, side: "start" | "end") => {
    const run = runAt(t);
    if (!run) return t;
    const target = padEdge(run, side, pace);
    let best = t;
    for (let f = Math.ceil((run.start + quietMargin) * fps - 1e-7); f / fps <= run.end - quietMargin + 1e-7; f++) {
      if (Math.abs(f / fps - target) < Math.abs(best - target)) best = f / fps;
    }
    return !crossesClip(t, best) && sound(best) === "quiet" ? best : t;
  };
  // A removal that ends on the first sound of the word it resumes with was asked to (voiceIn): the word plays whole.
  if (direction === -1 && sources.length && sources.every(s => onWordOnset(s.page, s.at))) return { at };
  // The measured audio decides. A quiet gap is a clean edge even if a stretched word timing spans it. The engine saves
  // a removal on whole frames, rounded inward, and the inward frame can be the first sound of the word beside it.
  if (sound(at) === "quiet") {
    // Seconds typed from word timings sit wherever those timings put them: two joins a pass placed that way played
    // 0.45 s and 0.4 s of quiet after the last word where its skill asked for 0.14 s (2026-11-17). Given the pause,
    // the edge goes where it puts it in this quiet, which takes out or keeps only quiet.
    if (paced) {
      const placed = padInRun(at, direction === 1 ? "start" : "end"), move = Math.abs(placed - at);
      if (move > 1e-6) return { at: placed, snapped: true, note: (direction === 1 ? "start" : "end") + " moved " + move.toFixed(2) + " s " +
        (placed > at ? "later" : "earlier") + " in its quiet, for the pause leave asks" };
    }
    // The frame the engine would round to: later for a start, earlier for an end. When it is quiet too, the edge stays as given.
    const inward = (direction === 1 ? Math.ceil((at - FRAME_TOLERANCE) * fps) : Math.floor((at + FRAME_TOLERANCE) * fps)) / fps;
    const run = runAt(at);
    if (!run || (sound(inward) === "quiet" && !crossesClip(at, inward))) return { at };
    const framed = edgeOnFrame(at, { start: run.start + quietMargin, end: run.end - quietMargin }, fps, t => t);
    return { at: framed !== at && sound(framed) === "quiet" && !crossesClip(at, framed) ? framed : at };
  }

  const clippedLabel = quote(sources.flatMap(s => s.clipped.map(plain)));
  const fail = (problem: string): Edge => ({ at, problem: clippedLabel ? "A boundary falls inside "+clippedLabel+". "+problem : problem });
  // Voice activity and word timings place an edge that is on sound, so they are asked of the sources that sound here.
  // One that is quiet at the edge, such as a screen capture's silent audio track, only has to be quiet where the edge lands.
  if (sources.some(s => soundAt(s.page, s.at) !== "quiet" && (!s.page.voice.length || !s.page.words.length)))
    return { ...fail("The scan lacks the voice activity or word timings to place this edge."), unmeasured: true };

  const lowest = Math.ceil((at - reach) * fps - 1e-7), highest = Math.floor((at + reach) * fps + 1e-7);
  const frames: number[] = [];
  for (let frame = lowest; frame <= highest; frame++) if (Math.abs(frame / fps - at) > 1e-7) frames.push(frame / fps);
  // Nearest first. On a tie keep the material: narrowing preserves the kept side's sound.
  frames.sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || (Math.sign(b - at) === direction ? 1 : 0) - (Math.sign(a - at) === direction ? 1 : 0));
  let fallback: Edge | undefined;
  // Words said in one breath leave no quiet run, only a dip in the level between them. Of the frames a fragment trim
  // can reach that sit between words, the lowest when it is down at room tone. Every edge the agent gave in seconds at
  // such a restart went to the editor to audition, and most came back as "cut too soon" or "slightly off".
  let dip: (Edge & { db: number }) | undefined;
  const levelAt = (timeline: number) => Math.max(...sources.map(s => {
    const levels = s.page.levels, t = timelineToSource(s.clip, timeline);
    const i = levels ? Math.floor((t - levels.from) / levels.step) : -1;
    return levels && i >= 0 && i < levels.db.length ? levels.db[i]! : 0;
  }));
  /**
   * What an editor does with words said in one breath: cut at the trough the waveform shows between them, wherever the
   * transcript's timings put the words. At a restart those timings are often tens of milliseconds off, and the
   * transcript can squeeze in or invent a word there, so the recording alone locates the boundary. The nearest trough
   * either way bounds the sound the edge is in; the move never passes another, so it never takes or leaves a sound of
   * its own. On one pass, eight of nine held edges with no quiet point had such a trough within a tenth of a second.
   */
  const trough = (): Edge | undefined => {
    const sounding = sources.filter(s => soundAt(s.page, s.at) !== "quiet");
    if (sounding.length !== 1) return;
    const s = sounding[0]!, levels = s.page.levels;
    if (!levels || !pageReaches(s.page, s.at)) return;
    const { db } = levels, centre = (i: number) => levels.from + (i + .5) * levels.step;
    const here = Math.floor((s.at - levels.from) / levels.step), k = Math.round(TROUGH_SEARCH / levels.step);
    const near = Math.round(LOW_POINT_REACH / levels.step);
    const floorOf = (way: 1 | -1) => {
      for (let d = 0; d <= k; d++) {
        let i = here + way * d;
        if (i < 0 || i >= db.length) return;
        if (!isDip(levels, i, d <= near ? LOW_POINT_DBFS : TROUGH_DBFS)) continue;
        while (i + way >= 0 && i + way < db.length && db[i + way]! <= db[i]!) i += way;
        return i;
      }
    };
    const toTimeline = (t: number) => s.clip.timelineIn + (t - s.clip.sourceIn) / (s.clip.speed ?? 1);
    const narrowing = direction as 1 | -1;
    const options = [floorOf(narrowing), floorOf(-narrowing as 1 | -1)].filter((i): i is number => i !== undefined)
      .map(i => ({ i, distance: Math.abs(centre(i) - s.at) }));
    // Nearest first; on a tie keep the material.
    for (const { i } of options.sort((a, b) => a.distance - b.distance)) {
      const floor = db[i]! <= DIP_DBFS ? DIP_DBFS : db[i]! + 6;
      let first = i, last = i;
      while (first > 0 && db[first - 1]! <= floor) first--;
      while (last + 1 < db.length && db[last + 1]! <= floor) last++;
      const lo = toTimeline(levels.from + first * levels.step) - levels.step, hi = toTimeline(levels.from + (last + 1) * levels.step) + levels.step;
      const target = toTimeline(centre(i));
      let best: number | undefined;
      for (let f = Math.ceil(lo * fps - 1e-7); f / fps <= hi + 1e-7; f++)
        if (best === undefined || Math.abs(f / fps - target) < Math.abs(best - target)) best = f / fps;
      if (best === undefined || crossesClip(at, best)) continue;
      if (namedEdge !== undefined && (best - namedEdge) * direction > 1e-6) continue;
      // The trough says where the sound parts, not which words part there. A move past the middle of a word would
      // take that word out, or leave it in, against the range asked for: an edge at “it, | now” went to the trough
      // between “asked” and “it”, a fifth of a second earlier, and would have left “it” playing twice (2026-11-16).
      const landed = timelineToSource(s.clip, best), from = Math.min(s.at, landed), to = Math.max(s.at, landed);
      if (s.page.words.some(w => { const middle = (w.start + w.end) / 2; return from < middle && middle < to; })) continue;
      const move = Math.abs(best - at), side = direction === 1 ? "start" : "end";
      return { at: best, dip: true, snapped: move <= snapLimit + 1e-7,
        note: side + (move < 1e-6 ? " stays" : " moved " + move.toFixed(2) + " s " + (best > at ? "later" : "earlier")) +
          (db[i]! <= DIP_DBFS ? ` onto the lowest level between the words in the recording (${Math.round(db[i]!)} dBFS)`
            : ` onto the trough between the words in the recording (${Math.round(db[i]!)} dBFS, ${Math.round(troughDepth(levels, i))} dB under the sound either side)`) };
    }
  };
  // Room tone, or a deep trough, on every source that sounds here.
  const dipAt = (timeline: number) => sources.every(s => {
    const levels = s.page.levels, t = timelineToSource(s.clip, timeline);
    const i = levels ? Math.floor((t - levels.from) / levels.step) : -1;
    return !!levels && i >= 0 && i < levels.db.length && isDip(levels, i);
  });
  // Not inside a word, and not past a whole one or its middle: a dip moves an edge to a word boundary, never across a
  // word, and so never takes out a word the range keeps or keeps one it takes out, as the trough's move above.
  const betweenWords = (timeline: number) => sources.every(s => {
    const t = timelineToSource(s.clip, timeline), from = Math.min(s.at, t), to = Math.max(s.at, t);
    return !s.page.words.some(w => inWord(w, t) || (from <= w.start && w.end <= to) || (from < (w.start + w.end) / 2 && (w.start + w.end) / 2 < to));
  });
  for (const next of [at, ...frames]) {
    if (Math.abs(next - at) > snapLimit + 1e-7 || (next !== at && crossesClip(at, next)) || !betweenWords(next)) continue;
    // An edge inside a word goes to the boundary it is nearer: in the half by the removal, the word was meant to go;
    // in the half by the kept side, it was meant to stay.
    if (Math.sign(next - at) === -direction && sources.some(s => s.clipped.some(w =>
      direction === 1 ? s.at - w.start + wordMargin >= w.end - s.at : w.end - s.at + wordMargin >= s.at - w.start))) continue;
    const db = levelAt(next);
    if (dipAt(next) && (!dip || db < dip.db)) dip = { at: next, db, dip: true, snapped: true,
      note: (direction === 1 ? "start" : "end") + (next === at ? " stays" : " moved " + Math.abs(next - at).toFixed(2) + " s " + (next > at ? "later" : "earlier")) +
        ` onto the lowest level between the words (${Math.round(db)} dBFS)` };
  }
  for (const next of frames) {
    const narrowing = Math.sign(next - at) === direction, distance = Math.abs(next - at);
    // Removing kept sound is only a fragment trim. Anything longer may take a kept word.
    if (!narrowing && distance > snapLimit + 1e-7) continue;
    if (crossesClip(at, next)) continue;
    const crossed: string[] = [];
    const fits = sources.every(s => {
      const t = timelineToSource(s.clip, next);
      const from = Math.min(s.at, t), to = Math.max(s.at, t);
      if (narrowing) {
        if (s.clipped.some(w => direction === 1 ? t < w.end : t > w.start)) return false;
        // Never skip another word to reach a nicer-looking gap.
        if (s.page.words.some(w => !s.touching.includes(w) && (
          (from <= w.start && w.end <= to) || Math.min(w.end, to) - Math.max(w.start, from) > wordMargin))) return false;
      } else if (s.page.words.some(w => from <= w.start && w.end <= to)) return false;
      crossed.push(...s.page.words.filter(w => Math.min(w.end, to) - Math.max(w.start, from) > wordMargin).map(plain));
      return true;
    });
    if (!fits) continue;
    const state = sound(next);
    if (state === "sound") continue;
    const side = direction === 1 ? "start" : "end";
    const words = quote(narrowing ? sources.flatMap(s => s.clipped.map(plain)) : crossed);
    // Whether the move keeps every word is decided by the nearest silent frame; the padding only moves within that silence.
    const placed = state === "quiet" ? padInRun(next, side) : next;
    // A word-addressed removal must still contain the words the agent named after a repair.
    if (namedEdge !== undefined && (placed - namedEdge) * direction > 1e-6) continue;
    const move = Math.abs(placed - at), way = placed > at ? "later" : "earlier";
    const note = side+" moved "+move.toFixed(2)+" s "+way+" into the pause" +
      (words ? (narrowing ? " to preserve " : ", trimming the remaining sound of ") + words : "");
    // A long move into a pause keeps part of the take being removed. A dip at the word boundary keeps exactly the words.
    // A pause in the same gap as the dip is the same boundary, with more air: that move stands as it always did.
    const acrossWord = (d: Edge) => sources.some(s => {
      const a = timelineToSource(s.clip, d.at), b = timelineToSource(s.clip, next);
      return s.page.words.some(w => Math.min(a, b) < (w.start + w.end) / 2 && (w.start + w.end) / 2 < Math.max(a, b));
    });
    // A move that gives footage back and passes no word the scan read takes nothing the cut was asked to keep and leaves
    // nothing it was asked to take: the sound between is the kept word's own start, timed late by the transcript, or a
    // breath before it. It is placed, not in doubt. Held for the editor instead, a 19 s cut of four false starts waited on
    // them as a call because its end had gone 0.20 s back into the pause before the take it kept (2026-11-19).
    if (state === "quiet") return distance > snapLimit + 1e-7 && dip && acrossWord(dip) ? dip
      : { at: placed, label: words || undefined, note, snapped: distance <= snapLimit + 1e-7 || (narrowing && !words),
        ...(distance > snapLimit + 1e-7 && narrowing && !words && { gaveBack: true }) };
    fallback ??={ at: next, label: words || undefined, note, problem: "Voice activity continues through the low-level gap"+(words ? " near "+words : "")+". Audition that edge." };
  }
  if (dip) return dip;
  if (fallback) return fallback;
  const onTrough = trough();
  if (onTrough) return onTrough;
  return { ...fail(inSoundEvidence(sources, at, direction) ?? "The recording has speech at this edge and no quiet point within "+reach+" s."), inSound: true,
    ...(clippedLabel && { inWord: true }) };
}

/**
 * Where the sound an edge is in parts, either way, and what moving the edge there does to the words: the nearest quiet
 * or low point within reach on each side, at its timeline second, with the transcript words between. An edge given in
 * seconds a word off sat 0.27 s from silence and was reported as having no quiet point, since reaching it meant keeping
 * a word the range removed; the model then sent the cut to the editor to listen for the word (2026-11-16).
 */
function inSoundEvidence(sources: SourceEdge[], at: number, direction: 1 | -1) {
  const sounding = sources.filter(s => soundAt(s.page, s.at) !== "quiet");
  if (sounding.length !== 1) return;
  const s = sounding[0]!, levels = s.page.levels;
  if (!levels || !pageReaches(s.page, s.at)) return;
  const side = direction === 1 ? "start" : "end";
  const here = Math.floor((s.at - levels.from) / levels.step);
  if (here < 0 || here >= levels.db.length) return;
  const speed = s.clip.speed ?? 1, k = Math.round(reach / levels.step);
  const centre = (i: number) => levels.from + (i + .5) * levels.step;
  const point = (way: 1 | -1) => {
    for (let d = 1; d <= k; d++) {
      let i = here + way * d;
      const t = centre(i);
      if (i < 0 || i >= levels.db.length || t < s.clip.sourceIn || t > s.clip.sourceOut) return;
      const quiet = soundAt(s.page, t) === "quiet" || levels.db[i]! <= DIP_DBFS;
      if (!quiet && !isDip(levels, i, LOW_POINT_DBFS)) continue;
      // A trough's floor, where the sound either side is furthest. Room tone's near side, where the sound stops.
      if (!quiet) while (i + way >= 0 && i + way < levels.db.length && levels.db[i + way]! < levels.db[i]!) i += way;
      const found = centre(i);
      const between = s.page.words.filter(w => { const middle = (w.start + w.end) / 2; return Math.min(s.at, found) < middle && middle < Math.max(s.at, found); }).map(plain);
      // Moving a start later, or an end earlier, plays the words between. The other way removes them.
      const keeps = (way === 1) === (direction === 1);
      const what = between.length ? (keeps ? "keeps " : "also removes ") + quote(between) : "with no word between";
      return `${Math.abs(found - s.at).toFixed(2)} s ${way === 1 ? "later" : "earlier"} at ${round3(at + (found - s.at) / speed)} s (${Math.round(levels.db[i]!)} dBFS), ${what}`;
    }
  };
  const points = [point(-1), point(1)].filter(Boolean);
  return `The ${side} is in sound at ${Math.round(levels.db[here]!)} dBFS` + (points.length
    ? `. The nearest quiet or low point is ${points.join("; or ")}. Give the edge there, or name the words to remove.`
    : ` with no quiet or low point within ${reach} s.`);
}

export function dialogueClips(tl: Timeline, project: Pick<Project, "media">) {
  const streams = new Map(project.media.filter(m => m.kind === "audio" || m.hasAudio).map(m =>
    [m.id, dialogueAudioStream(m) ?? 0] as const));
  return { clips: audibleClipsByTrack(tl).flat().filter(c => streams.has(c.mediaId)), streams };
}

/** Exact timeline word edges from the same scan that judges the join. */
export function dialogueJoinWords(tl: Timeline, project: Pick<Project, "media">, range: TimeRange, pages: JoinPage[]) {
  const { clips, streams } = dialogueClips(tl, project);
  const wordsAt = (at: number) => clips.flatMap(clip => {
    if (at < clip.timelineIn || at > clip.timelineIn + clipDuration(clip)) return [];
    const t = timelineToSource(clip, at);
    const stream = dialogueAudioStream(clip) ?? streams.get(clip.mediaId);
    const page = pageAt(pages, clip.mediaId, stream, t);
    const words = page?.words.filter(w => w.end > t - JOIN_WORD_SECONDS && w.start < t + JOIN_WORD_SECONDS && w.start >= clip.sourceIn && w.end <= clip.sourceOut);
    if (!words?.length) return [];
    const timelineAt = (source: number) => sourceToTimeline(clip, source);
    return [{ mediaId: clip.mediaId, clipId: clip.id, ...(stream && { audioStream: stream }), words: words.map(w => [timelineAt(w.start), timelineAt(w.end), w.text] as const) }];
  });
  return { start: wordsAt(range.start), end: wordsAt(range.end) };
}

type TimedWord = readonly [start: number, end: number, text: string];
type NearbyWords = ReturnType<typeof dialogueJoinWords>;
type RepeatReadings = { start: Pick<NearbyWords["start"][number], "mediaId" | "audioStream" | "words">[];
  end: Pick<NearbyWords["end"][number], "mediaId" | "audioStream" | "words">[] };
interface JoinRepeat { mediaId: string; words: string; before: TimeRange; after: TimeRange }
interface PickupRepeat { mediaId: string; words: string; side: "start" | "end"; first: TimeRange; second: TimeRange }

function samePhrase(left: TimedWord[], right: TimedWord[], removedSeconds = 0) {
  const gap = right[0]![0] - left.at(-1)![1] - removedSeconds;
  if (gap < -2 * wordMargin || gap >= REPEAT_WITHIN) return;
  if (!left.every((w, i) => {
    const token = normalizeTranscriptToken(w[2]);
    return token && token === normalizeTranscriptToken(right[i]![2]);
  })) return;
  const span = (words: TimedWord[]) => ({ start: round3(words[0]![0]), end: round3(words.at(-1)![1]) });
  return { words: left.map(w => plain({ text: w[2] })).join(" "), first: span(left), second: span(right) };
}

/** Words doubled across an edit, or an immediately repeated phrase at the beginning or end of a kept take. */
function dialogueJoinRepeats(nearby: RepeatReadings, cut: TimeRange, previousEnd = 0, nextStart = Infinity) {
  const kept = (readings: RepeatReadings["start"], side: "start" | "end") => readings.map(r => ({
    ...r, words: r.words.filter(([s, e]) => side === "start"
      ? s >= previousEnd && (s + e) / 2 < cut.start : (s + e) / 2 >= cut.end && e <= nextStart),
  })).filter(r => r.words.length && (side === "start" ? r.words.at(-1)![1] <= cut.start + wordMargin : r.words[0]![0] >= cut.end - wordMargin));
  const before = kept(nearby.start, "start"), after = kept(nearby.end, "end");
  let repeatAtJoin: JoinRepeat | undefined;
  for (const out of before) {
    for (const incoming of after) {
      if (repeatAtJoin || incoming.mediaId !== out.mediaId || incoming.audioStream !== out.audioStream) continue;
      for (let n = Math.min(out.words.length, incoming.words.length); n > 0; n--) {
        const match = samePhrase(out.words.slice(-n), incoming.words.slice(0, n), cut.end - cut.start);
        if (match) { repeatAtJoin = { mediaId: out.mediaId, words: match.words, before: match.first, after: match.second }; break; }
      }
    }
  }
  const pickupRepeats: PickupRepeat[] = [];
  for (const [side, readings] of [["start", before], ["end", after]] as const) {
    for (const { mediaId, words } of readings) {
      // A pickup belongs to this cut when it opens or closes the take, within one second of its edge.
      if ((side === "start" ? cut.start - words.at(-1)![1] : words[0]![0] - cut.end) > 1) continue;
      for (let n = Math.floor(words.length / 2); n >= 1; n--) {
        const pair = side === "start" ? words.slice(-2 * n) : words.slice(0, 2 * n);
        const match = samePhrase(pair.slice(0, n), pair.slice(n));
        if (match) { pickupRepeats.push({ mediaId, side, ...match }); break; }
      }
    }
  }
  return { repeatAtJoin, pickupRepeats };
}

export type ReadKeptWords = (mediaId: string, stream: number | undefined, from: number, to: number, cachedOnly?: true) => Promise<Word[]>;
/**
 * A `cachedOnly` read found no reading to answer from, as for a language the aligner has no model for. Nothing failed:
 * the check that wanted it, the partial-word check, doesn't run.
 */
export class NoCachedSpeech extends Error {}

/** Use the engine's ripple and fade operations so unavailable handles and existing edits are respected. */
export function dialogueCutPreview(tl: Timeline, media: MediaAsset[], ranges: TimeRange[], fadeSeconds: number) {
  const straight = applyReviewRemovals(tl, ranges, "join");
  let removed = 0;
  const joins = ranges.map(r => {
    const at = r.start - removed;
    removed += r.end - r.start;
    return at;
  });
  return crossfadeJoins(straight, media, joins, fadeSeconds).timeline;
}

type JoinPlayback = { preview: () => Timeline; at: number; partialOnly?: boolean };

/** Read the real handles only for a join whose aligned words could put the same word on both sides. */
async function checkPartialWord(tl: Timeline, project: Pick<Project, "media">, cut: TimeRange, nearby: NearbyWords,
  read: ReadKeptWords, playback: JoinPlayback, previousEnd: number, nextStart: number) {
  // A physical edge may sit half an overlap beyond the picture cut. Avoid building a preview for unrelated words.
  const handle = MAX_CROSSFADE / 2;
  const plausible = nearby.start.some(left => nearby.end.some(right => {
    if (left.mediaId !== right.mediaId || left.audioStream !== right.audioStream) return false;
    const outgoing = left.words.filter(([s, e]) => s < cut.start + handle && e > cut.start - REPEAT_WITHIN);
    const incoming = right.words.filter(([s, e]) => s < cut.end + REPEAT_WITHIN && e > cut.end - handle);
    return outgoing.some(a => incoming.some(b =>
      (a[1] >= cut.start || b[0] <= cut.end) && normalizeTranscriptToken(a[2]) === normalizeTranscriptToken(b[2])));
  }));
  if (!plausible) return;
  const preview = playback.preview();
  const join = timelineJoins(preview).find(j => Math.abs(j.at - playback.at) < .001);
  if (!join) return;
  const originals = new Map(dialogueClips(tl, project).clips.map(c => [c.id, c]));
  for (const track of join.tracks) {
    if (track.gap || track.out.mediaId !== track.in.mediaId) continue;
    const clips = preview.tracks.find(t => t.id === track.trackId)!.clips;
    const side = async (which: "start" | "end", played: JoinSide): Promise<FragmentSide | undefined> => {
      const out = which === "start", at = cut[which];
      const clip = clips.find(c => c.id === played.clipId);
      if (clip?.kind !== "media") return;
      const asset = project.media.find(m => m.id === clip.mediaId);
      if (!asset) return;
      const stream = dialogueAudioStream(clip) ?? dialogueAudioStream(asset);
      // Scan words describe the asset's selected stream. A different clip override needs its own transcript.
      if (stream !== dialogueAudioStream(asset)) return;
      const centerSource = timelineToSource(clip, playback.at);
      // Match by placement as well as recording. A ripple can split a clip, and a fade can move its sound to another track.
      const candidates = nearby[which].filter(r => r.mediaId === played.mediaId).flatMap(r => {
        const before = originals.get(r.clipId);
        if (!before || before.speed !== clip.speed || (dialogueAudioStream(before) ?? dialogueAudioStream(asset)) !== stream ||
          Math.abs(timelineToSource(before, at) - centerSource) > 1e-5) return [];
        return [{ before, scan: r.words }];
      });
      if (candidates.length !== 1) return;
      const { before, scan } = candidates[0]!;
      const clock = (source: number) => at + (source - centerSource) / clip.speed;
      const edge = clock(played.source);
      const from = out ? Math.max(clip.sourceIn, played.source - JOIN_WORD_SECONDS,
        centerSource + (previousEnd - at) * clip.speed) : played.source;
      const to = out ? played.source : Math.min(clip.sourceOut, played.source + JOIN_WORD_SECONDS,
        centerSource + (nextStart - at) * clip.speed);
      if (to <= from) return;
      const words = await read(clip.mediaId, stream, from, to, true).catch(err => {
        if (err instanceof NoCachedSpeech) return undefined;
        throw err;
      });
      if (!words) return;
      const heard = words.filter(w => w.end > w.start && !isTag(w.text)).map(w => [clock(w.start), clock(w.end), w.text] as const);
      return { trackId: track.trackId, clipId: before.id, mediaId: clip.mediaId, audioStream: stream, speed: clip.speed,
        sourceAtEdge: played.source, edge, bounds: { start: clock(from), end: clock(to) }, scan, heard };
    };
    const [out, incoming] = await Promise.all([side("start", track.out), side("end", track.in)]);
    if (out && incoming) {
      const found = partialRepeatAtJoin(cut, out, incoming);
      if (found) return found;
    }
  }
}

/** Read the two pieces that would play, clipping the listening windows at adjacent removals and source clip edges. */
export async function checkKeptWords(tl: Timeline, project: Pick<Project, "media">, cut: TimeRange, nearby: NearbyWords,
  read?: ReadKeptWords, previousEnd = 0, nextStart = Infinity, playback?: JoinPlayback) {
  const scan = playback?.partialOnly ? { repeatAtJoin: undefined, pickupRepeats: [] }
    : dialogueJoinRepeats(nearby, cut, previousEnd, nextStart);
  const unread = new Set<string>();
  if (!read) return { ...scan, partialWordRepeat: undefined, unread: [...unread] };
  const readWindow: ReadKeptWords = async (id, stream, from, to, cachedOnly) => {
    try { return await read(id, stream, from, to, cachedOnly); }
    catch (err) {
      if (cachedOnly && err instanceof NoCachedSpeech) throw err;
      unread.add(id + ": " + (err instanceof Error ? err.message : String(err)));
      return [];
    }
  };
  const partial = playback && checkPartialWord(tl, project, cut, nearby, readWindow, playback, previousEnd, nextStart);
  if (playback?.partialOnly) return { ...scan, partialWordRepeat: await partial, unread: [...unread] };
  const { clips } = dialogueClips(tl, project);
  const side = async (which: "start" | "end") => {
    const at = cut[which], out = which === "start";
    const audible = clips.filter(clip => {
      const lo = clip.timelineIn, hi = lo + clipDuration(clip);
      return out ? lo < at && at <= hi : lo <= at && at < hi;
    });
    return Promise.all(audible.map(async clip => {
      const lo = clip.timelineIn, hi = lo + clipDuration(clip), edge = timelineToSource(clip, at);
      const from = out ? Math.max(edge - JOIN_WORD_SECONDS, timelineToSource(clip, Math.max(previousEnd, lo))) : edge;
      const to = out ? edge : Math.min(edge + JOIN_WORD_SECONDS, timelineToSource(clip, Math.min(nextStart, hi)));
      const asset = project.media.find(m => m.id === clip.mediaId)!;
      const stream = dialogueAudioStream(clip) ?? dialogueAudioStream(asset);
      const words = to > from + 1e-6 ? await readWindow(clip.mediaId, stream, from, to) : [];
      const time = (s: number) => lo + (s - clip.sourceIn) / clip.speed;
      return { mediaId: clip.mediaId, ...(stream && { audioStream: stream }),
        words: words.filter(w => w.start >= from - 1e-6 && w.end <= to + 1e-6 && w.end > w.start && normalizeTranscriptToken(w.text) && !isTag(w.text))
          .map(w => [time(w.start), time(w.end), w.text] as const) };
    }));
  };
  const [start, end, partialWordRepeat] = await Promise.all([side("start"), side("end"), partial]);
  const heard = dialogueJoinRepeats({ start, end }, cut, previousEnd, nextStart);
  // Both are readings of the same take. Give the agent the scan's spelling when both find its repeat.
  const pickupRepeats = [...scan.pickupRepeats];
  for (const p of heard.pickupRepeats) {
    if (!pickupRepeats.some(s => s.mediaId === p.mediaId && s.side === p.side &&
      s.first.start < p.second.end && p.first.start < s.second.end)) pickupRepeats.push(p);
  }
  return { repeatAtJoin: scan.repeatAtJoin ?? heard.repeatAtJoin, pickupRepeats, partialWordRepeat, unread: [...unread] };
}

/** Check the start of the chosen delivery, including the continuation that distinguishes it from a rehearsal. */
export function checkResumeQuote(tl: Timeline, project: Project, end: number, pages: JoinPage[], quote: string) {
  const { clips, streams } = dialogueClips(tl, project);
  const tokens = (s: string) => s.split(/\s+/u).map(normalizeTranscriptToken).filter(Boolean);
  const expected = tokens(quote);
  if (!expected.length) return "unverified";
  let matched = false;
  for (const clip of clips) {
    if (end < clip.timelineIn || end >= clip.timelineIn + clipDuration(clip)) continue;
    const t = timelineToSource(clip, end);
    const page = pageAt(pages, clip.mediaId, dialogueAudioStream(clip) ?? streams.get(clip.mediaId), t);
    if (!page) return "unverified";
    const words = page.words.filter(w => w.start >= t - wordMargin && w.end > t && w.end <= clip.sourceOut);
    if (!words.length) return "unverified";
    const heard = words.slice(0, expected.length).flatMap(w => tokens(w.text));
    if (heard.some((word, i) => i < expected.length && expected[i] !== word)) return "different";
    if (heard.length < expected.length) return "unverified";
    matched = true;
  }
  return matched ? "matches" : "unverified";
}

/**
 * Only narrow a retake by more than a fragment. The caller still owns its meaning, visual review and approval.
 */
/** `air`: the room tone a range in seconds asked its join to leave (`leave`, `voiceIn`); its edges in quiet go there. */
/** Two deliveries of one word match on their sound when their levels follow each other at least this closely (Pearson r). */
const SAME_WORD_MATCH = .6;
/** How far the recording's offset between the two deliveries may sit from the transcript's. */
const SAME_WORD_SEARCH = .12;
/** Levels under this are room tone to the match, so the depth of a silence doesn't decide it. */
const SAME_WORD_FLOOR = -60;

export interface SameWordJoin extends TimeRange {
  word: string;
  /** The two deliveries of the word, in timeline seconds. */
  first: TimeRange;
  second: TimeRange;
  /** Seconds from a sound in the first delivery to the same sound in the second, and how closely their levels match. */
  lag: number;
  match: number;
  /** The range as given kept the first delivery, which would have played twice: this start takes it out. */
  takesFirst?: true;
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
  // where you would", as a repeat found by its last word alone is given; the cut then takes them too.
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
  const length = Math.min(15, Math.max(5, Math.round((second.end - centre(onset)) / step) + 2));
  const heard = Array.from({ length }, (_, k) => level(onset + k));
  if (heard.some(v => v === undefined)) return;
  const correlation = (shift: number) => {
    const before = heard.map((_, k) => level(onset + k - shift));
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
  const begins = from + onset * step - lag, fps = project.settings.fps;
  const start = Math.round(sourceToTimeline(out, begins) * fps) / fps, source = timelineToSource(out, start), end = range.end;
  if (source >= middle(first) || source <= out.sourceIn || end - start < 2 / fps) return;
  const span = (clip: MediaClip, w: Word) => ({ start: round3(sourceToTimeline(clip, w.start)), end: round3(sourceToTimeline(clip, w.end)) });
  return { start, end, word: plain(second), first: span(out, first), second: span(back, second), lag: round3(lag), match: Math.round(match * 100) / 100, ...(takesFirst && { takesFirst }) };
}

export function checkDialogueJoin(tl: Timeline, project: Project, range: TimeRange, pages: JoinPage[], namedWords?: TimeRange, pace: JoinPace = DEFAULT_PACE, air?: JoinPace): JoinCheck {
  return dialogueJoinChecker(tl, project, pages, pace)(range, namedWords, air);
}

/** Reuse the audible clip and stream indexes while checking a batch on one version. */
export function dialogueJoinChecker(tl: Timeline, project: Project, pages: JoinPage[], pace: JoinPace = DEFAULT_PACE) {
  const { clips, streams } = dialogueClips(tl, project);
  const near = intervalCandidates(clips, c => c.timelineIn, clipEnd);
  const fps = project.settings.fps, duration = timelineDuration(tl);
  const edge = (at: number, direction: 1 | -1, named?: number, air?: JoinPace) =>
    checkEdge(at, direction, near(at - reach, at + reach), pages, fps, streams, named, air ?? pace, !!air);
  // `near` counts only a snap as placed: a same-word join asks whether both edges sit in quiet as given.
  const judge = (range: TimeRange, namedWords?: TimeRange, air?: JoinPace, near = false): JoinCheck => {
    const left: Edge = range.start > 1e-6 ? edge(range.start, 1, namedWords?.start, air) : { at: range.start };
    const right: Edge = range.end < duration - 1e-6 ? edge(range.end, -1, namedWords?.end, air) : { at: range.end };
    const problems = [...new Set([left.problem, right.problem].filter(Boolean))].join(" ");
    const inSound = ([["start", left], ["end", right]] as const).filter(([, e]) => e.inSound).map(([side]) => side);
    const inWord = ([["start", left], ["end", right]] as const).filter(([, e]) => e.inWord).map(([side]) => side);
    if (!left.note && !right.note && problems) return { ...range, status: "review", reason: problems,
      ...([left, right].every(e => !e.problem || e.unmeasured) && { unmeasured: true }), ...(inSound.length && { inSound }), ...(inWord.length && { inWord }) };
    if (!left.note && !right.note) return { start: left.at, end: right.at, status: "unchanged", reason: "The recording is quiet at both boundaries." };
    if (right.at-left.at < Math.max(.10, 2/fps))
      return { ...range, status: "review", reason: "Preserving the neighboring words leaves too little of this retake to trim." };
    const notes = [left.note, right.note].filter(Boolean);
    // One edge between words that run together leaves the other in silence, where the ear resets. With both there, a
    // short removal comes out of the middle of running speech, as with word references (wordCutRange).
    if (left.dip && right.dip) return { start: left.at, end: right.at, status: "review",
      reason: `No pause on either side: ${notes.join(", ")}. Audition the join.` };
    const snapped = !problems && [left, right].every(e => !e.note || (e.snapped && !(near && e.gaveBack)));
    return { start: left.at, end: right.at, status: problems ? "partial" : snapped ? "snapped" : "adjusted", ...(inSound.length && { inSound }), ...(inWord.length && { inWord }),
      reason: [(snapped ? (left.dip || right.dip ? "Placed on the recording: " : "Snapped to the recording's silence: ") : "Adjusted retake boundaries: ")+notes.join(", ")+".", problems,
        snapped ? "" : "Preview the join in context."].filter(Boolean).join(" ") };
  };
  return (range: TimeRange, namedWords?: TimeRange, air?: JoinPace): JoinCheck => {
    const same = sameWordJoin(tl, project, range, pages);
    if (!same) return judge(range, namedWords, air);
    const said = "“" + same.word + "”";
    // Saved where Scarlet put it, the join is what it is: neither edge moves, and no kept word is cut.
    if (Math.abs(same.start - range.start) < 2e-3) return { start: same.start, end: same.end, status: "review", sameWord: same.word,
      reason: `The cut starts as the first ${said} begins and the second ${said} follows it. The word before runs into the first with no pause, so its start was found by matching the two ` +
        `${said}s on their sound. No kept word is cut as measured. Scarlet can't hear the join, and neither can you: the editor hears it.` };
    const checked = judge(range, namedWords, air, true);
    // A removal with quiet at both edges needs no other way in.
    if (checked.status === "unchanged" || checked.status === "snapped") return checked;
    return { ...checked, sameWordJoin: { start: same.start, end: same.end, word: same.word, ...(same.takesFirst && { takesFirst: true as const }),
      reason: `${said} is said again right after this removal, and the word before runs into the first one with no pause. Matched on their sound, the first ${said} begins at ` +
        `${same.start.toFixed(3)} s: removing ${same.start.toFixed(3)}–${same.end.toFixed(3)} s ${same.takesFirst ? `also takes out the first ${said}, which this range leaves playing twice,` : "takes out the same words"} ` +
        "and plays the word before whole. Scarlet can't hear the result, so a cut saved on those seconds is the editor's to hear, as a call." } };
  };
}


interface EdgeAudio {
  edge: "start" | "end";
  mediaId: string;
  /** Source second of the boundary. */
  at: number;
  sound: Sound;
  /** RMS dBFS in 20 ms steps from 0.3 s before to 0.3 s after the boundary; `|` marks the edge. */
  levels?: string;
  /** Source seconds of the closest audio-confirmed quiet points. */
  quietBefore?: number;
  quietAfter?: number;
  /** Transcript words near the edge. Their timings are approximate; use them to name words, not to place the cut. */
  words: string;
  transcriptSplitsWord?: string;
}

/** The measured audio around each boundary, so a model can place and judge the edge from the recording itself. */
export function joinAudio(tl: Timeline, project: Project, range: TimeRange, pages: JoinPage[]): EdgeAudio[] {
  const { clips, streams } = dialogueClips(tl, project);
  const out: EdgeAudio[] = [];
  for (const [edge, at] of [["start", range.start], ["end", range.end]] as const) {
    for (const clip of clips) {
      const lo = clip.timelineIn, hi = lo + clipDuration(clip);
      if (at <= lo + 1e-6 || at >= hi - 1e-6) continue;
      const t = timelineToSource(clip, at);
      const stream = dialogueAudioStream(clip) ?? streams.get(clip.mediaId);
      const page = pageAt(pages, clip.mediaId, stream, t);
      if (!page) continue;
      const levels = page.levels && levelStrip(page.levels, t);
      const confirmed = (q: TimeRange) => q.end - q.start >= 2 * quietMargin;
      const before = gaps(page).filter(q => confirmed(q) && q.start + quietMargin <= t).at(-1);
      const after = gaps(page).find(q => confirmed(q) && q.end - quietMargin >= t);
      const split = page.words.find(w => inWord(w, t));
      out.push({ edge, mediaId: clip.mediaId, at: round3(t), sound: soundAt(page, t), ...(levels && { levels }),
        ...(before && { quietBefore: round3(Math.min(t, before.end - quietMargin)) }),
        ...(after && { quietAfter: round3(Math.max(t, after.start + quietMargin)) }),
        words: page.words.filter(w => w.end > t - 1.2 && w.start < t + 1.2)
          .map(w => (w.end <= t ? "" : w.start >= t ? "" : "▸") + w.text.trim() + "[" + w.start.toFixed(2) + "-" + w.end.toFixed(2) + "]").join(" "),
        ...(split && { transcriptSplitsWord: plain(split) }) });
    }
  }
  return out;
}

/** A level this low ends a piece of sound: room tone, or the closure before the next word. */
const FRAGMENT_QUIET_DBFS = -45;
/** The piece is sound, not room tone, when it stands this far above the quiet that ends it. */
const FRAGMENT_DROP_DB = 12;
/** A piece quieter than this is the last of a word's decay, which a fade covers. */
const FRAGMENT_SOUND_DBFS = -42;

/** What a clip edge given in source seconds leaves playing that an editor would hear as a mistake. */
interface EdgeInSound {
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

/** How far from a split word's edge a clean edge is looked for, and in what steps. */
const WHOLE_WORD_REACH = .6, WHOLE_WORD_STEP = .01;

function levelStrip(levels: AudioLevels, t: number) {
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
const keptSlack = .05, removedSlack = .3;

/** Whether the stretch a page measured includes source instant `t`. A page that kept no levels can't say, and counts as reaching it. */
export function pageReaches(page: NonNullable<JoinPage["edges"]>, t: number) {
  const { levels } = page;
  return !levels || (levels.from - 1e-6 <= t && t <= levels.from + levels.step * levels.db.length + 1e-6);
}

/** Of the quiet runs in a gap, the one that reaches furthest toward the kept word: the earliest to start after it, or the latest to end before it. */
function besideWord(runs: TimeRange[], side: "start" | "end") {
  return runs.reduce<TimeRange | undefined>((best, q) => !best || (side === "start" ? q.start < best.start : q.end > best.end) ? q : best, undefined);
}

interface WordCut extends TimeRange {
  /** The removed words, for the editor-facing reason and the model's own check. */
  text: string;
  /** Edges that found no measured silence and fell back to the word timings. */
  problems: string[];
  /** Edges placed at a dip in the level between two words that run together, with what was measured there. */
  dips: string[];
  /**
   * The stretch of the recording each placed edge can sit anywhere in and still be on what was measured: the quiet
   * run it was padded in, or the dip at room tone between two words. A version's frames rarely fall on the padded
   * instant, and the frame the edge is saved on should be one of these.
   */
  room: { start?: TimeRange; end?: TimeRange };
  /** Kept words beside the cut that sound somewhere other than their timing, and where the edge found them. */
  retimed: string[];
}

/** Sound counts as speech within this of the level speech sits at on the page, as gapSound counts it. */
const SPEECH_BELOW_DB = 12, QUIETEST_SPEECH_DBFS = -45, SYLLABLE_BELOW_DB = 6;

/**
 * Where a kept word beside a cut really sounds, when the recording is quiet all through its timing. ASR often hangs the
 * first half of a word on the end of the phrase before a pause: on one pass “all right” after a pause was timed
 * “…got you all <1.2 s> right”, three times in one video, and each cut that ended before “all” kept the whole pause.
 * The word is the start of the first run of speaking-level sound after its timing (the last before it, for a word
 * that precedes the cut), provided that sound begins before the next word's timing does (ends after the previous word's), so the sound
 * is the word's and not its neighbour's. A breath is far under speaking level and stays with the pause. Undefined when the word
 * sounds where it is timed, or when the page cannot say.
 */
function soundingWord(page: JoinPage["edges"] | undefined, kept: Word, neighbour: Word | undefined, side: "start" | "end"): Word | undefined {
  const levels = page?.levels;
  if (!page || !levels?.db.length) return;
  const loud = extremeLevel(page, kept.start, kept.end, "highest");
  if (!loud || loud.db > dbfs(QUIET_RMS)) return;
  const sorted = [...levels.db].sort((a, b) => a - b);
  const speech = sorted[Math.floor(sorted.length * .85)]!, floor = Math.max(speech - SPEECH_BELOW_DB, QUIETEST_SPEECH_DBFS);
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
/** A run of sound this short is a click, not a syllable. */
const MIN_WORD_SOUND = .06;
/** How far from its timing a kept word's sound is looked for. */
const MAX_RETIME = 2;

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
const TROUGH_SEARCH = .2;

/** How far bucket `i` lies under the loudest level within TROUGH_REACH on each side: the shallower of the two. */
function troughDepth(levels: AudioLevels, i: number) {
  const k = Math.max(1, Math.round(TROUGH_REACH / levels.step));
  let left = -Infinity, right = -Infinity;
  for (let j = Math.max(0, i - k); j < i; j++) left = Math.max(left, levels.db[j]!);
  for (let j = i + 1; j <= Math.min(levels.db.length - 1, i + k); j++) right = Math.max(right, levels.db[j]!);
  return Math.min(left, right) - levels.db[i]!;
}

/** A level an edge can sit at between words: room tone, or a trough deep under the sound either side. */
function isDip(levels: AudioLevels, i: number, bar = TROUGH_DBFS) {
  const db = levels.db[i]!;
  return db <= DIP_DBFS || db <= bar && troughDepth(levels, i) >= TROUGH_DEPTH_DB;
}

/** A level and its frame centre, read from the same buckets that locate silence. */
function extremeLevel(page: NonNullable<JoinPage["edges"]>, from: number, to: number, kind: "lowest" | "highest") {
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
 * and the cut there took “-tion” off (2026-11-20).
 */
function dipBetween(page: NonNullable<JoinPage["edges"]>, from: number, to: number, boundary?: number, beside?: { side: "start" | "end"; kept: Word }) {
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
 * The room right after a kept word's sound, when what follows it up to the quiet run `run` is a breath: sound far under
 * the word, in no word. A breath keeps the speech detector on and the level over the room, so the quiet run the edge
 * would pad into starts after it, and the cut held on the editor breathing in. After “cube simulation.” the room came
 * back for 80 ms, a breath ran 0.12 s at -50 dBFS, and the cut came 0.36 s after the word (2026-11-20).
 */
function roomBeforeBreath(page: NonNullable<JoinPage["edges"]>, kept: Word, run: TimeRange): TimeRange | undefined {
  const levels = page.levels, loudest = extremeLevel(page, kept.start, kept.end, "highest");
  if (!levels || !loudest || run.start <= kept.end) return;
  const index = (t: number) => Math.floor((t - levels.from) / levels.step + 1e-6);
  let first = -1, last = -1;
  for (let i = Math.max(0, index(kept.end - keptSlack)); i < Math.min(levels.db.length, index(run.start)); i++) {
    if (levels.db[i]! <= DIP_DBFS) { if (first < 0) first = i; last = i; } else if (first >= 0) break;
  }
  if (first < 0) return;
  const quiet = { start: levels.from + first * levels.step, end: levels.from + (last + 1) * levels.step };
  if (quiet.end - quiet.start < 2 * quietMargin || quiet.end >= run.start - 1e-6 || keptSoundsPast(page, quiet, kept, "start")) return;
  if (page.words.some(w => w.start < run.start && w.end > quiet.end)) return;
  for (let i = index(quiet.end); i < Math.min(levels.db.length, index(run.start)); i++) if (levels.db[i]! > loudest.db - BREATH_UNDER_WORD_DB) return;
  return quiet;
}

/** Sound this close to a word's loudest, for this long, is the word still speaking. */
const STILL_SPEAKING_DB = 15, STILL_SPEAKING_SECONDS = .06;
/**
 * Whether the kept word sounds on at speaking level between a dip and where the transcript ends it (`side` start), or
 * before the dip from where it starts it (`side` end): then the dip is inside the word, such as the stop before a
 * consonant, and an edge there cuts the word short.
 */
function keptSoundsPast(page: NonNullable<JoinPage["edges"]>, dip: TimeRange, kept: Word, side: "start" | "end") {
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
  const s3 = (t: number) => `${(Math.round(t * 1000) / 1000).toFixed(3)} s`;
  return `${moved.map(side => `Moved the ${side} from ${s3(asked[side])} to ${s3(placed[side])}`).join(" and ")}, onto a quiet frame: the recording is quiet at the edge, and the whole frame it would be saved on has sound.`;
}

/** Where the page places a transcript word that it moved onto its sound (onTheirSound), if it did. */
function onSound(word: Word, page: JoinPage["edges"] | undefined): Word | undefined {
  const moved = page?.words.find(w => w.timed && w.text === word.text && Math.abs(w.timed.start - word.start) < 1e-6 && Math.abs(w.timed.end - word.end) < 1e-6);
  return moved && { text: moved.text, start: moved.start, end: moved.end };
}

function movedNote(word: Word, moved: Word, role: "kept" | "removed") {
  return `The transcript times the ${role} “${plain(word)}” at ${round3(word.start)}–${round3(word.end)} s, too short to say it and on another word's sound; the recording has speech no word explains at ${
    round3(moved.start)}–${round3(moved.end)} s beside it, and the edge is placed with “${plain(word)}” there.`;
}

/** A short word's far side can fall inside ASR's slack. Keep its strongest sound on the side the agent named. */
function betweenWords(page: NonNullable<JoinPage["edges"]>, kept: Word, removed: Word, side: "start" | "end"): TimeRange {
  // A stretched timing can contain several attempts at the same word. The first and last resolved utterances
  // bound the removal even if the transcript counted them as one.
  const same = normalizeTranscriptToken(removed.text);
  const spoken = page.words.filter(w => w.start >= removed.start - wordMargin && w.end <= removed.end + wordMargin &&
    (w.start + w.end) / 2 >= removed.start && (w.start + w.end) / 2 < removed.end && normalizeTranscriptToken(w.text) === same);
  const outer = (side === "start" ? spoken[0] : spoken.at(-1)) ?? removed;
  const left = side === "start" ? kept : outer, right = side === "start" ? outer : kept;
  const anchor = (word: Word, fallback: number) => {
    const peak = extremeLevel(page, word.start, word.end, "highest");
    // Below the level that counts as quiet, the recording cannot locate the word inside its timing.
    return peak && peak.db > dbfs(QUIET_RMS) ? peak.at : fallback;
  };
  const bounds = { start: anchor(left, left.start), end: anchor(right, right.end) };
  // A named word comes out when its middle does: that is how the cut's words, what it plays and the check for a word
  // played twice all read it. A word too quiet to locate left its far end as the bound, and the edge went to the quiet
  // after it: “nice you ‖ you can see” was placed past the “you” the model named, then refused for playing it twice (2026-11-17).
  const named = (outer.start + outer.end) / 2;
  return side === "start" ? { start: bounds.start, end: Math.min(bounds.end, named) } : { start: Math.max(bounds.start, named), end: bounds.end };
}

/**
 * The source range that removes words[from..to] (indices into one transcript, sorted by start).
 * Each edge goes in the measured silence between a removed word and its kept neighbor, padded by
 * the default edge padding. `pageAt` returns measured evidence covering a source time. Without a kept
 * neighbor the edge runs to the start or end of the material.
 */
/** Two words the transcript times this close are said as one: their edge goes where it parts them. */
const RUN_ON_GAP = .06;

export function wordCutRange(words: Word[], from: number, to: number, pageAt: (t: number) => JoinPage["edges"] | undefined, leave?: number, pace: JoinPace = DEFAULT_PACE, voiceIn?: number): WordCut {
  const first = words[from]!, last = words[to]!;
  // The pause the join should play, word to word, and how much of it follows the cut, in the recording's seconds.
  const air = leave === undefined ? { after: pace.after, before: voiceIn ?? pace.before } : splitLeave(leave, pace, voiceIn);
  const problems: string[] = [], dips: string[] = [], retimed: string[] = [];
  // The kept word beside each edge, where the recording says it is.
  const heard = (kept: Word | undefined, neighbour: Word | undefined, side: "start" | "end") => {
    if (!kept) return kept;
    const moved = onSound(kept, pageAt(side === "end" ? kept.start : kept.end));
    if (moved) {
      retimed.push(movedNote(kept, moved, "kept"));
      return moved;
    }
    const found = soundingWord(pageAt(side === "end" ? kept.start : kept.end), kept, neighbour, side);
    if (!found) return kept;
    retimed.push(`The recording is quiet where the transcript times the kept “${plain(kept)}” (${round3(kept.start)}–${round3(kept.end)} s); its sound ${
      side === "end" ? "starts" : "ends"} at ${round3(side === "end" ? found.start : found.end)} s, and the ${side} is placed beside that.`);
    return found;
  };
  const before = heard(words[from - 1], words[from - 2], "start"), after = heard(words[to + 1], words[to + 2], "end");
  const used: { start?: TimeRange; end?: TimeRange } = {}, room: WordCut["room"] = {};
  const edge = (kept: Word | undefined, removed: Word, side: "start" | "end", timed = false) => {
    room[side] = undefined;
    if (!kept) return side === "start" ? 0 : Infinity;
    const lo = side === "start" ? kept.end : removed.end, hi = side === "start" ? removed.start : kept.start;
    const inGap = (page: JoinPage["edges"]) => {
      if (!page || timed) return [];
      const bounds = betweenWords(page, kept, removed, side);
      return gaps(page).filter(q => {
        if (q.end - q.start < 2 * quietMargin) return false;
        const fits = side === "start" ? q.end > lo - keptSlack && q.start < hi + removedSlack : q.start < hi + keptSlack && q.end > lo - removedSlack;
        const at = padEdge(q, side, air);
        return fits && bounds.start < at && at < bounds.end;
      });
    };
    // The run beside the kept word: the air after kept speech, or the air before it resumes. A deep trough is listed
    // beside the quiet run it lies in, so the run that reaches furthest toward the kept word is the one beside it:
    // taking the last to start put the edge at the trough's end, up to a second before the word.
    const nearest = (runs: TimeRange[]) => besideWord(runs, side);
    const page = pageAt((lo + hi) / 2), beside = side === "start" ? lo : hi;
    const seen = nearest(inGap(page));
    // A pause can be longer than the page read at its middle. That page stops short of the kept word, so its quiet run
    // begins or ends where the page does, and an edge padded from there left seconds of dead air beside the word.
    // The page that reaches the kept word shows the pause from the word itself. Which gap the edge found is still
    // told by the middle page's run, the one both edges of a stray word would share.
    const run = (page && !pageReaches(page, beside) ? nearest(inGap(pageAt(beside))) : undefined) ?? seen;
    if (run) {
      used[side] = seen ?? run;
      // Asked for less than the margin before the voice, the edge goes to the end of the quiet, where the word starts.
      if (side === "end" && air && air.before < quietMargin) {
        room[side] = { start: run.start + quietMargin, end: onsetLimit(pageAt(run.end) ?? page, run.end) };
        return Math.max(run.start + quietMargin, run.end - air.before);
      }
      // A breath after the kept word, with the quiet only after it: the edge goes in the room before the breath.
      const quiet = (side === "start" && page && roomBeforeBreath(pageAt(run.start) ?? page, kept, run)) || run;
      room[side] = { start: quiet.start + quietMargin, end: quiet.end - quietMargin };
      return padEdge(quiet, side, air);
    }
    // No run of silence: the two words run together. The lowest level between them, reaching a little way into each
    // word's timing and no further into the kept one than a quiet run may.
    const bounds = page && betweenWords(page, kept, removed, side);
    // Near where the transcript parts the words first. A word stretched over the pause after it hides the pause from
    // that window: of 31 word edges one pass had handed back in sound, 9 had a trough at -48 dBFS or lower between the
    // two words' sounds, some of them silence, outside it (2026-11-16). So the whole span between their loudest points
    // is searched too, at the deep bar only, since the stop before a final “s” is a shallower trough in the same span.
    const near = page && bounds && dipBetween(page, Math.max(bounds.start, Math.min(lo, hi) - keptSlack), Math.min(bounds.end, Math.max(lo, hi) + keptSlack), (lo + hi) / 2, { side, kept });
    const low = near?.dip ? near : (page && bounds && bounds.end > bounds.start && dipBetween(page, bounds.start, bounds.end, undefined, { side, kept })) || near;
    if (low?.dip) {
      dips.push(`No pause between “${plain(side === "start" ? kept : removed)}” and “${plain(side === "start" ? removed : kept)}”: the ${side} is at the lowest level between them (${Math.round(low.db)} dBFS).`);
      room[side] = low.room;
      return low.at;
    }
    const at = lo <= hi ? (lo + hi) / 2 : side === "start" ? removed.start : removed.end;
    // Spoken straight through, the words part where the transcript parts them: the published editor's cuts in running
    // speech on Muse were 13–35 ms from it, all five, and the editor's own pick on another recording 12 ms, where the
    // lowest level and the sharpest change in the sound were up to 96 ms off (2026-11-18). Held there instead, a pass
    // cut other words to get round the join and nobody heard it. An edge whose words share one gap, or with no level
    // reading, isn't placed from the recording, and stays the agent's to settle. So does a gap the transcript leaves
    // between them that the recording fills with sound: that is not two words said as one.
    if (page?.levels && !timed && hi - lo <= RUN_ON_GAP) {
      dips.push(`No pause or low point between “${plain(side === "start" ? kept : removed)}” and “${plain(side === "start" ? removed : kept)}”: they run together, and the ${side} is where the transcript parts them.`);
      return at;
    }
    problems.push(`No measured silence between “${plain(side === "start" ? kept : removed)}” and “${plain(side === "start" ? removed : kept)}”${
      page ? "" : " (no level reading)"}. The ${side} uses the word timing.`);
    return at;
  };
  // A removed word the recording has no sound for takes no time, right after the word before it (the aligner puts a
  // word Whisper invented over a silence there). The removal's sound starts at its first word that has some: measured
  // from the soundless one, "period." and a "Thank" nobody said had no pause between them, and the edge went to a dip
  // in the kept word's tail with half a second of silence just after it (2026-11-15).
  const sounds = (w: Word) => w.end > w.start;
  const removed = words.slice(from, to + 1).map(w => {
    const moved = onSound(w, pageAt((w.start + w.end) / 2));
    if (moved) retimed.push(movedNote(w, moved, "removed"));
    return moved ?? w;
  });
  const firstHeard = removed.find(sounds) ?? (after ? { ...first, start: after.start, end: after.start } : first);
  const lastHeard = removed.findLast(sounds) ?? (before ? { ...last, start: before.end, end: before.end } : last);
  let start = edge(before, firstHeard, "start"), end = edge(after, lastHeard, "end");
  // A short word with a gap on one side only: both edges found that one gap, and the range came out empty
  // ("Words #1424–#1424 do not form one forward range", on three passes). The gap belongs to the edge on its side of
  // the words; the other edge has no silence of its own and uses the word timing, which says so.
  if (used.start && used.end && used.start.start === used.end.start && used.start.end === used.end.end) {
    if ((used.start.start + used.start.end) / 2 < (firstHeard.start + lastHeard.end) / 2) end = edge(after, lastHeard, "end", true);
    else start = edge(before, firstHeard, "start", true);
  }
  const text = words.slice(from, to + 1).map(w => w.text.trim()).join(" ");
  // One edge between words that run together leaves the other in silence, where the ear resets. With both there, a
  // short word comes out of the middle of running speech: a doubled “the” cut that way took the kept “the” with it.
  if (dips.length === 2) problems.push(`No pause on either side of “${text}”: both edges sit between words that run together.`);
  return { start, end, problems, dips, text, room, retimed };
}

/** The default padding either side of a join, together: what a join plays word to word when the model names no length. */
export const PAUSE_BEAT = AIR_AFTER_SPEECH + AIR_BEFORE_SPEECH;
/**
 * The source range that trims the pause between two neighboring words down to `leave` seconds, word to word. The
 * beat plays after the outgoing word but for `voiceIn` before the incoming one (splitLeave), and each edge stays
 * inside the measured quiet beside its word: where a word's sound runs past its timing, the pause plays that much
 * longer rather than clip it. Sound in the middle of the pause, such as typing or a breath, goes with it.
 */
export function pauseCutRange(before: Word, after: Word, pageAt: (t: number) => JoinPage["edges"] | undefined, leave = PAUSE_BEAT, pace: JoinPace = DEFAULT_PACE, voiceIn?: number): TimeRange & { problems: string[]; plays: number; room: WordCut["room"] } {
  const air = splitLeave(leave, pace, voiceIn);
  const problems: string[] = [];
  const long = (q: TimeRange) => q.end - q.start >= 2 * quietMargin;
  const inside = (run: TimeRange, t: number) => Math.min(Math.max(t, run.start + quietMargin), run.end - quietMargin);
  // The edge a run gives must fall between the two words' loudest points, as a word range's must (betweenWords): a word
  // timed a little late let the quiet after it pass for the pause before it, and the trim took the whole word out.
  const loudest = (page: NonNullable<JoinPage["edges"]>, word: Word, fallback: number) => {
    const peak = extremeLevel(page, word.start, word.end, "highest");
    return peak && peak.db > dbfs(QUIET_RMS) ? peak.at : fallback;
  };
  const between = (page: JoinPage["edges"] | undefined, side: "start" | "end") => (page ? gaps(page) : []).filter(q => {
    if (!long(q) || q.end <= before.end - keptSlack || q.start >= after.start + keptSlack) return false;
    const at = side === "start" ? inside(q, before.end + air.after)
      : air.before < quietMargin ? Math.max(q.start + quietMargin, q.end - air.before) : inside(q, after.start - air.before);
    return loudest(page!, before, before.start) < at && at < loudest(page!, after, after.end);
  });
  // A long pause can run across two scan pages. Each edge reads the page that covers it.
  const first = besideWord(between(pageAt(Math.min(before.end + .1, (before.end + after.start) / 2)), "start"), "start");
  const last = besideWord(between(pageAt(Math.max(after.start - .1, (before.end + after.start) / 2)), "end"), "end");
  let start = before.end + air.after, end = after.start - air.before;
  // Asked to play its whole length or more, the pause has nothing to trim. With a breath or a click in the middle the
  // quiet runs either side would each pull an edge in, and the pause lost the sound between them.
  if (start >= end - 1e-6) return { start, end: start, problems, plays: Math.max(0, after.start - before.end), room: {} };
  if (first) start = inside(first, start);
  else problems.push(`No measured silence after “${plain(before)}”. The pause's start uses the word timing.`);
  // Asked for less than the margin before the voice, the end goes to the end of the quiet, where the word starts.
  const onWord = !!last && air.before < quietMargin;
  if (onWord) end = Math.max(last.start + quietMargin, last.end - air.before);
  else if (last) end = inside(last, end);
  else problems.push(`No measured silence before “${plain(after)}”. The pause's end uses the word timing.`);
  const within = (run: TimeRange | undefined) => run && { start: run.start + quietMargin, end: run.end - quietMargin };
  return { start, end, problems, plays: Math.max(0, after.start - before.end),
    room: { start: within(first), end: onWord ? { start: last.start + quietMargin, end: onsetLimit(pageAt(last.end), last.end) } : within(last) } };
}
