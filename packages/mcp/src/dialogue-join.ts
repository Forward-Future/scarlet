import { applyReviewRemovals, clipDuration, crossfadeJoins, timelineDuration, timelineToSource, type MediaAsset, type MediaClip, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { JOIN_WORD_SECONDS, normalizeTranscriptToken } from "@scarlet/shared";
import { dbfs, round3 } from "./analysis.js";
import { REPEAT_WITHIN } from "./dialogue-leftovers.js";
import { partialRepeatAtJoin, type FragmentSide } from "./dialogue-fragment-repeat.js";
import { MAX_CROSSFADE, QUIET_PEAK, QUIET_RMS, timelineJoins, type JoinSide } from "./timeline-perception.js";

type Word = Pick<TranscriptWord, "text" | "start" | "end">;
interface Waveform { from: number; to: number; peaks: number[]; rms?: number[]; speechActivity?: TimeRange[] }
/** Measured RMS level of the source in dBFS, one value per waveform bucket. */
export interface AudioLevels { from: number; step: number; db: number[] }
export interface JoinPage extends TimeRange { mediaId: string; audioStream?: number; edges?: { words: Word[]; quiet: TimeRange[]; valleys: TimeRange[]; voice: TimeRange[]; levels?: AudioLevels } }
export interface JoinCheck extends TimeRange {
  /** `snapped` moved an edge a few frames onto measured silence and is safe to apply as proposed. */
  status: "unchanged" | "snapped" | "adjusted" | "partial" | "review";
  reason?: string;
  /** The scan has no audio measurements at a failing edge, so the check found nothing either way. */
  unmeasured?: boolean;
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
  let voice = 0;
  for (let i = 0; i < wf.rms.length; i++) {
    const start = wf.from + i * step, end = wf.from + (i + 1) * step;
    while (voice < wf.speechActivity.length && wf.speechActivity[voice]!.end <= start) voice++;
    if (wf.rms[i]! <= QUIET_RMS && wf.peaks[i]! <= QUIET_PEAK && (wf.speechActivity[voice]?.start ?? Infinity) >= end)
      appendInterval(quiet, start, end);
    // A speech detector can stay active through a real inter-word gap. Offer a deep
    // level trough there for audition, but keep that disagreement explicit.
    if (wf.rms[i]! <= .002 && wf.peaks[i]! <= .012) appendInterval(valleys, start, end);
  }
  const db = wf.rms.map(dbfs);
  return { voice: wf.speechActivity, valleys, words: words.filter(w => w.end > w.start && w.text.trim() && !isTag(w.text)),
    quiet, levels: { from: wf.from, step, db } };
}

const reach = .75, wordMargin = .02, quietMargin = .03;

/**
 * Default padding for a word-addressed removal. When Scarlet places an edge in a quiet run, it leaves
 * AIR_AFTER_SPEECH of room tone after the last kept word (its decay and release) and
 * AIR_BEFORE_SPEECH before kept speech resumes (a natural entrance, no clipped breath onset).
 * A run shorter than both splits proportionally. An edge the model already put in silence stays put:
 * pacing is the model's call, and timeline_join_audit reports the air either side.
 */
export const AIR_AFTER_SPEECH = .15;
export const AIR_BEFORE_SPEECH = .10;

/**
 * Where an edge sits in quiet run `run`. A `start` edge follows kept speech; an `end` edge precedes it.
 */
export function padEdge(run: TimeRange, side: "start" | "end"): number {
  const after = AIR_AFTER_SPEECH, before = AIR_BEFORE_SPEECH;
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
interface Edge { at: number; label?: string; problem?: string; note?: string; snapped?: boolean; unmeasured?: boolean; dip?: boolean }
type Sound = "quiet" | "valley" | "sound";

/** The instant is inside the word's timing, clear of both its edges. */
const inWord = (w: Word, t: number) => w.start + wordMargin < t && t < w.end - wordMargin;
/** A transcript tag such as [music], which names no spoken word. */
const isTag = (text: string) => /^\s*\[.*\]\s*$/.test(text);
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
const SPEECH_DBFS = -40;

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
  const here = Math.floor((t - from) / step);
  if (side === "out") {
    for (let i = Math.max(0, here); i < db.length && from + i * step < t + limit; i++)
      if (db[i]! > SPEECH_DBFS) return Math.max(0, from + i * step - t);
  } else {
    for (let i = Math.min(db.length - 1, here); i >= 0 && from + (i + 1) * step > t - limit; i--)
      if (db[i]! > SPEECH_DBFS) return Math.max(0, t - from - (i + 1) * step);
  }
}

function checkEdge(at: number, direction: 1 | -1, clips: MediaClip[], pages: JoinPage[], fps: number, streams: Map<string, number>, namedEdge?: number): Edge {
  const sources: SourceEdge[] = [];
  const nearby = clips.filter(c => c.timelineIn <= at + reach && c.timelineIn + clipDuration(c) >= at - reach);
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
  // The measured audio decides. A quiet gap is a clean edge even if a stretched word timing spans it. The engine saves
  // a removal on whole frames, rounded inward, and the inward frame can be the first sound of the word beside it.
  if (sound(at) === "quiet") {
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

  /** Move a quiet frame to the padded position in its run, on the frame grid, without crossing a clip edge. */
  const padInRun = (t: number, side: "start" | "end") => {
    const run = runAt(t);
    if (!run) return t;
    const target = padEdge(run, side);
    let best = t;
    for (let f = Math.ceil((run.start + quietMargin) * fps - 1e-7); f / fps <= run.end - quietMargin + 1e-7; f++) {
      if (Math.abs(f / fps - target) < Math.abs(best - target)) best = f / fps;
    }
    return !crossesClip(t, best) && sound(best) === "quiet" ? best : t;
  };
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
  // Not inside a word, and not past a whole one: a dip moves an edge to a word boundary, never across a word.
  const betweenWords = (timeline: number) => sources.every(s => {
    const t = timelineToSource(s.clip, timeline), from = Math.min(s.at, t), to = Math.max(s.at, t);
    return !s.page.words.some(w => inWord(w, t) || (from <= w.start && w.end <= to));
  });
  for (const next of [at, ...frames]) {
    if (Math.abs(next - at) > snapLimit + 1e-7 || (next !== at && crossesClip(at, next)) || !betweenWords(next)) continue;
    // An edge inside a word goes to the boundary it is nearer: in the half by the removal, the word was meant to go;
    // in the half by the kept side, it was meant to stay.
    if (Math.sign(next - at) === -direction && sources.some(s => s.clipped.some(w =>
      direction === 1 ? s.at - w.start + wordMargin >= w.end - s.at : w.end - s.at + wordMargin >= s.at - w.start))) continue;
    const db = levelAt(next);
    if (db <= DIP_DBFS && (!dip || db < dip.db)) dip = { at: next, db, dip: true, snapped: true,
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
    if (state === "quiet") return distance > snapLimit + 1e-7 && dip && acrossWord(dip) ? dip : { at: placed, label: words || undefined, note, snapped: distance <= snapLimit + 1e-7 };
    fallback ??={ at: next, label: words || undefined, note, problem: "Voice activity continues through the low-level gap"+(words ? " near "+words : "")+". Audition that edge." };
  }
  if (dip) return dip;
  if (fallback) return fallback;
  return fail("The recording has speech at this edge and no quiet point within "+reach+" s.");
}

export function dialogueClips(tl: Timeline, project: Pick<Project, "media">) {
  const streams = new Map(project.media.filter(m => m.kind === "audio" || m.hasAudio).map(m =>
    [m.id, dialogueAudioStream(m) ?? 0] as const));
  return { clips: audibleMediaClips(tl).filter(c => streams.has(c.mediaId)), streams };
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
    const timelineAt = (source: number) => clip.timelineIn + (source - clip.sourceIn) / clip.speed;
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
export function dialogueJoinRepeats(nearby: RepeatReadings, cut: TimeRange, previousEnd = 0, nextStart = Infinity) {
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
export function checkDialogueJoin(tl: Timeline, project: Project, range: TimeRange, pages: JoinPage[], namedWords?: TimeRange): JoinCheck {
  const { clips, streams } = dialogueClips(tl, project);
  const fps = project.settings.fps;
  const left: Edge = range.start > 1e-6 ? checkEdge(range.start, 1, clips, pages, fps, streams, namedWords?.start) : { at: range.start };
  const right: Edge = range.end < timelineDuration(tl) - 1e-6 ? checkEdge(range.end, -1, clips, pages, fps, streams, namedWords?.end) : { at: range.end };
  const problems = [...new Set([left.problem, right.problem].filter(Boolean))].join(" ");
  if (!left.note && !right.note && problems) return { ...range, status: "review", reason: problems,
    ...([left, right].every(e => !e.problem || e.unmeasured) && { unmeasured: true }) };
  if (!left.note && !right.note) return { start: left.at, end: right.at, status: "unchanged", reason: "The recording is quiet at both boundaries." };
  if (right.at-left.at < Math.max(.10, 2/fps))
    return { ...range, status: "review", reason: "Preserving the neighboring words leaves too little of this retake to trim." };
  const notes = [left.note, right.note].filter(Boolean);
  // One edge between words that run together leaves the other in silence, where the ear resets. With both there, a
  // short removal comes out of the middle of running speech, as with word references (wordCutRange).
  if (left.dip && right.dip) return { start: left.at, end: right.at, status: "review",
    reason: `No pause on either side: ${notes.join(", ")}. Audition the join.` };
  const snapped = !problems && [left, right].every(e => !e.note || e.snapped);
  return { start: left.at, end: right.at, status: problems ? "partial" : snapped ? "snapped" : "adjusted",
    reason: [(snapped ? (left.dip || right.dip ? "Placed on the recording: " : "Snapped to the recording's silence: ") : "Adjusted retake boundaries: ")+notes.join(", ")+".", problems,
      snapped ? "" : "Preview the join in context."].filter(Boolean).join(" ") };
}

/** Every clip of a recording that sounds on this version. */
export function audibleMediaClips(tl: Timeline) {
  return tl.tracks.filter(t => t.kind !== "caption" && !t.muted).flatMap(t => t.clips)
    .filter((c): c is MediaClip => c.kind === "media" && c.enabled && c.volume > 0);
}

export interface EdgeAudio {
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
export interface EdgeInSound {
  /** The transcript word the edge falls inside, while that word is sounding. */
  word?: string;
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
  const page = pageAt(pages, mediaId, stream, t);
  if (!page || soundAt(page, t) !== "sound") return;
  // Room tone under the edge, too brief to be a run of silence: the instant between two words said in one breath.
  const levels = page.levels, here = levels && levels.db[Math.floor((t - levels.from) / levels.step)];
  if (here !== undefined && here <= DIP_DBFS) return;
  const split = page.words.find(w => inWord(w, t));
  const fragment = edgeFragment(page, t, side);
  if (!split && !fragment) return;
  return { ...(split && { word: plain(split) }), ...(fragment && { fragment }), ...(page.levels && { levels: levelStrip(page.levels, t) }) };
}

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

export interface WordCut extends TimeRange {
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
 */
function dipBetween(page: NonNullable<JoinPage["edges"]>, from: number, to: number) {
  const levels = page.levels, low = extremeLevel(page, from, to, "lowest");
  if (!levels || !low || low.db > DIP_DBFS) return low && { ...low, room: undefined };
  const centre = (i: number) => levels.from + (i + .5) * levels.step;
  const at = Math.floor((low.at - levels.from) / levels.step);
  let first = at, last = at;
  while (first > 0 && centre(first - 1) >= from && levels.db[first - 1]! <= DIP_DBFS) first--;
  while (last + 1 < levels.db.length && centre(last + 1) <= to && levels.db[last + 1]! <= DIP_DBFS) last++;
  return { at: (centre(first) + centre(last)) / 2, db: low.db, room: { start: levels.from + first * levels.step, end: levels.from + (last + 1) * levels.step } };
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
  return { start: anchor(left, left.start), end: anchor(right, right.end) };
}

/**
 * The source range that removes words[from..to] (indices into one transcript, sorted by start).
 * Each edge goes in the measured silence between a removed word and its kept neighbor, padded by
 * the default edge padding. `pageAt` returns measured evidence covering a source time. Without a kept
 * neighbor the edge runs to the start or end of the material.
 */
export function wordCutRange(words: Word[], from: number, to: number, pageAt: (t: number) => JoinPage["edges"] | undefined): WordCut {
  const first = words[from]!, last = words[to]!, before = words[from - 1], after = words[to + 1];
  const problems: string[] = [], dips: string[] = [];
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
        const at = padEdge(q, side);
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
      room[side] = { start: run.start + quietMargin, end: run.end - quietMargin };
      return padEdge(run, side);
    }
    // No run of silence: the two words run together. The lowest level between them, reaching a little way into each
    // word's timing and no further into the kept one than a quiet run may.
    const bounds = page && betweenWords(page, kept, removed, side);
    const low = page && bounds && dipBetween(page, Math.max(bounds.start, Math.min(lo, hi) - keptSlack), Math.min(bounds.end, Math.max(lo, hi) + keptSlack));
    if (low && low.db <= DIP_DBFS) {
      dips.push(`No pause between “${plain(side === "start" ? kept : removed)}” and “${plain(side === "start" ? removed : kept)}”: the ${side} is at the lowest level between them (${Math.round(low.db)} dBFS).`);
      room[side] = low.room;
      return low.at;
    }
    problems.push(`No measured silence between “${plain(side === "start" ? kept : removed)}” and “${plain(side === "start" ? removed : kept)}”${
      page ? "" : " (no level reading)"}. The ${side} uses the word timing.`);
    return lo <= hi ? (lo + hi) / 2 : side === "start" ? removed.start : removed.end;
  };
  let start = edge(before, first, "start"), end = edge(after, last, "end");
  // A short word with a gap on one side only: both edges found that one gap, and the range came out empty
  // ("Words #1424–#1424 do not form one forward range", on three passes). The gap belongs to the edge on its side of
  // the words; the other edge has no silence of its own and uses the word timing, which says so.
  if (used.start && used.end && used.start.start === used.end.start && used.start.end === used.end.end) {
    if ((used.start.start + used.start.end) / 2 < (first.start + last.end) / 2) end = edge(after, last, "end", true);
    else start = edge(before, first, "start", true);
  }
  const text = words.slice(from, to + 1).map(w => w.text.trim()).join(" ");
  // One edge between words that run together leaves the other in silence, where the ear resets. With both there, a
  // short word comes out of the middle of running speech: a doubled “the” cut that way took the kept “the” with it.
  if (dips.length === 2) problems.push(`No pause on either side of “${text}”: both edges sit between words that run together.`);
  return { start, end, problems, dips, text, room };
}

/** Default word-to-word duration when a pause is explicitly shortened without a target. */
export const PAUSE_BEAT = AIR_AFTER_SPEECH + AIR_BEFORE_SPEECH;
/**
 * The source range that trims the pause between two neighboring words down to `leave` seconds, word to word. The
 * beat is split as edge padding is, more after the outgoing word than before the incoming one, and each edge stays
 * inside the measured quiet beside its word: where a word's sound runs past its timing, the pause plays that much
 * longer rather than clip it. Sound in the middle of the pause, such as typing or a breath, goes with it.
 */
export function pauseCutRange(before: Word, after: Word, pageAt: (t: number) => JoinPage["edges"] | undefined, leave = PAUSE_BEAT): TimeRange & { problems: string[]; plays: number; room: WordCut["room"] } {
  const share = AIR_AFTER_SPEECH / PAUSE_BEAT;
  const problems: string[] = [];
  const long = (q: TimeRange) => q.end - q.start >= 2 * quietMargin;
  const between = (page: JoinPage["edges"] | undefined) => (page ? gaps(page) : []).filter(q => long(q) && q.end > before.end - keptSlack && q.start < after.start + keptSlack);
  // A long pause can run across two scan pages. Each edge reads the page that covers it.
  const first = besideWord(between(pageAt(Math.min(before.end + .1, (before.end + after.start) / 2))), "start");
  const last = besideWord(between(pageAt(Math.max(after.start - .1, (before.end + after.start) / 2))), "end");
  const inside = (run: TimeRange, t: number) => Math.min(Math.max(t, run.start + quietMargin), run.end - quietMargin);
  let start = before.end + leave * share, end = after.start - leave * (1 - share);
  // Asked to play its whole length or more, the pause has nothing to trim. With a breath or a click in the middle the
  // quiet runs either side would each pull an edge in, and the pause lost the sound between them.
  if (start >= end - 1e-6) return { start, end: start, problems, plays: Math.max(0, after.start - before.end), room: {} };
  if (first) start = inside(first, start);
  else problems.push(`No measured silence after “${plain(before)}”. The pause's start uses the word timing.`);
  if (last) end = inside(last, end);
  else problems.push(`No measured silence before “${plain(after)}”. The pause's end uses the word timing.`);
  const within = (run: TimeRange | undefined) => run && { start: run.start + quietMargin, end: run.end - quietMargin };
  return { start, end, problems, plays: Math.max(0, after.start - before.end), room: { start: within(first), end: within(last) } };
}
