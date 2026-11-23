/**
 * Dialogue join checking & audio evidence, plus re-exports of the dialogue join
 * sub-modules (acoustics, kept-words, same-word, clip-edge, word-range).
 */
import { clipDuration, clipEnd, intervalCandidates, sourceToTimeline, timelineDuration, timelineToSource, type MediaClip, type Project, type TimeRange, type Timeline } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import {
  AIR_AFTER_SPEECH,
  AIR_BEFORE_SPEECH,
  DEFAULT_PACE,
  DIP_DBFS,
  FRAME_TOLERANCE,
  LEAST_VOICE_IN,
  LOW_POINT_DBFS,
  LOW_POINT_REACH,
  PAUSE_BEAT,
  TROUGH_DBFS,
  TROUGH_DEPTH_DB,
  TROUGH_SEARCH,
  atRoomTone,
  dialogueAudioStream,
  edgeOnFrame,
  gaps,
  inWord,
  isDip,
  joinEvidence,
  keptSoundsPast,
  levelStrip,
  onWordOnset,
  padEdge,
  pageAt,
  pageReaches,
  plain,
  quietFrameNote,
  quietMargin,
  quote,
  reach,
  snapLimit,
  soundAt,
  soundBesideEdge,
  splitLeave,
  troughDepth,
  wordMargin,
  type AudioLevels,
  type Breath,
  type JoinPace,
  type JoinPage,
  type Sound,
  type SourceEdge,
} from "./dialogue-acoustics.js";
import { clipEdgeSound } from "./dialogue-clip-edge.js";
import { NoCachedSpeech, checkKeptWords, checkResumeQuote, dialogueClips, dialogueCutPreview, dialogueJoinWords, readResumeQuote, type ReadKeptWords } from "./dialogue-kept-words.js";
import { SAME_WORD_UNHEARD, sameWordJoin, type SameWordJoin } from "./dialogue-same-word.js";
import { RUN_ON_GAP, pauseCutRange, wordCutRange } from "./dialogue-word-range.js";

export {
  AIR_AFTER_SPEECH,
  AIR_BEFORE_SPEECH,
  DEFAULT_PACE,
  DIP_DBFS,
  LEAST_VOICE_IN,
  LOW_POINT_DBFS,
  LOW_POINT_REACH,
  NoCachedSpeech,
  PAUSE_BEAT,
  SAME_WORD_UNHEARD,
  TROUGH_DBFS,
  TROUGH_DEPTH_DB,
  checkKeptWords,
  checkResumeQuote,
  clipEdgeSound,
  dialogueAudioStream,
  dialogueClips,
  dialogueCutPreview,
  dialogueJoinWords,
  edgeOnFrame,
  joinEvidence,
  padEdge,
  pageAt,
  pageReaches,
  pauseCutRange,
  quietFrameNote,
  readResumeQuote,
  sameWordJoin,
  soundBesideEdge,
  splitLeave,
  wordCutRange,
  type AudioLevels,
  type Breath,
  type JoinPace,
  type JoinPage,
  type ReadKeptWords,
  type SameWordJoin,
};

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
  sameWordJoin?: TimeRange & { word: string; reason: string; takesFirst?: string };
}

interface Edge {
  at: number;
  label?: string;
  problem?: string;
  note?: string;
  snapped?: boolean;
  unmeasured?: boolean;
  dip?: boolean;
  inSound?: boolean;
  inWord?: boolean;
  /** Placed further than a snap, by giving footage back up to a pause with no word between. */
  gaveBack?: boolean;
}

/** A trough an edge was not moved to, because it lies inside the kept word beside the edge and the word sounds on past it. */
interface InsideKeptWord { word: SourceEdge["page"]["words"][number]; source: SourceEdge; move: number; db: number }

/**
 * An edge given in seconds where the transcript parts two words said straight through, whose only trough is inside
 * the kept word: it stays there and applies, as an edge between named words does (wordCutRange). The published
 * editor's cuts in running speech sat 13–35 ms from that boundary, and here the editor's own was 6 ms from it.
 */
function runOnBoundary(found: InsideKeptWord, at: number, direction: 1 | -1): Edge | undefined {
  const { word: kept, source: s, move, db } = found;
  const beside = direction === 1 ? kept.end : kept.start;
  if (Math.abs(s.at - beside) > wordMargin) return;
  const removed = direction === 1
    ? s.page.words.find(w => w.start >= kept.end - 1e-6 && w.start - kept.end <= RUN_ON_GAP && w !== kept)
    : s.page.words.findLast(w => w.end <= kept.start + 1e-6 && kept.start - w.end <= RUN_ON_GAP && w !== kept);
  if (!removed) return;
  const side = direction === 1 ? "start" : "end";
  return { at, dip: true, snapped: true,
    note: `${side} stays where the transcript parts “${plain(direction === 1 ? kept : removed)}” and “${plain(direction === 1 ? removed : kept)}”, said straight through: ` +
      `the low point ${move.toFixed(2)} s ${direction === 1 ? "earlier" : "later"} (${Math.round(db)} dBFS) is inside “${plain(kept)}”, which sounds on ${direction === 1 ? "after" : "before"} it` };
}

/**
 * What an editor does with words said in one breath: cut at the trough the waveform shows between them, wherever the
 * transcript's timings put the words. At a restart those timings are often tens of milliseconds off, and the
 * transcript can squeeze in or invent a word there, so the recording alone locates the boundary. The nearest trough
 * either way bounds the sound the edge is in; the move never passes another, so it never takes or leaves a sound of
 * its own. On one pass, eight of nine held edges with no quiet point had such a trough within a tenth of a second.
 */
function findTrough(
  sources: SourceEdge[],
  at: number,
  direction: 1 | -1,
  fps: number,
  namedEdge: number | undefined,
  crossesClip: (a: number, b: number) => boolean,
  insideKept?: InsideKeptWord[],
): Edge | undefined {
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
  const toTimeline = (t: number) => sourceToTimeline(s.clip, t);
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
    // Nor is a trough the place two words part when the kept one sounds on past it: the stop before a final consonant
    // falls as low as the gap between words. An edge typed where “complaints” ends went 0.11 s back onto the closure
    // of its “t”, at -59 dBFS, and the cut took the “s”; the editor asked for those frames back, twice (2026-11-22).
    // A word reference's edge is held to the same test (keptSoundsPast in dipBetween).
    const taking = (landed - s.at) * direction < 0;
    const dip = { start: levels.from + first * levels.step, end: levels.from + (last + 1) * levels.step };
    const cutShort = taking ? s.page.words.find(w => w.start < landed && landed < w.end &&
      keptSoundsPast(s.page, dip, w, direction === 1 ? "start" : "end")) : undefined;
    if (cutShort) { insideKept?.push({ word: cutShort, source: s, move: Math.abs(best - at), db: db[i]! }); continue; }
    const move = Math.abs(best - at), side = direction === 1 ? "start" : "end";
    return { at: best, dip: true, snapped: move <= snapLimit + 1e-7,
      note: side + (move < 1e-6 ? " stays" : " moved " + move.toFixed(2) + " s " + (best > at ? "later" : "earlier")) +
        (db[i]! <= DIP_DBFS ? ` onto the lowest level between the words in the recording (${Math.round(db[i]!)} dBFS)`
          : ` onto the trough between the words in the recording (${Math.round(db[i]!)} dBFS, ${Math.round(troughDepth(levels, i))} dB under the sound either side)`) };
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
      const end = s.clip.timelineIn + clipDuration(s.clip);
      lo = Math.max(lo, s.clip.timelineIn, sourceToTimeline(s.clip, run.start));
      hi = Math.min(hi, end, sourceToTimeline(s.clip, run.end));
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
  const insideKept: InsideKeptWord[] = [];
  const onTrough = findTrough(sources, at, direction, fps, namedEdge, crossesClip, insideKept);
  if (onTrough) return onTrough;
  // Only for an edge given in seconds: where named words part is wordCutRange's to place, and a restart that begins
  // on the word the first take broke off on stays held for its join (sameWordJoin).
  const runOn = namedEdge === undefined && insideKept[0] ? runOnBoundary(insideKept[0], at, direction) : undefined;
  if (runOn) return runOn;
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
    // Saved where Scarlet put it, the join is what it is: neither edge moves, and no kept word is cut. Nothing measured
    // says how it plays. Such a join used to be the editor's alone, whatever the pass asked; since 2026-11-21 it is held
    // as any join Scarlet can't place cleanly is: the model decides, and the default is in the skill.
    if (Math.abs(same.start - range.start) < 2e-3) return { start: same.start, end: same.end, status: "review", sameWord: same.word,
      reason: `The cut starts as the first ${said} begins and the second ${said} follows it. The word before runs into the first with no pause, so its start was found by matching the two ` +
        `${said}s on their sound. No kept word is cut as measured. ${SAME_WORD_UNHEARD}` };
    const checked = judge(range, namedWords, air, true);
    // A removal with quiet at both edges needs no other way in.
    if (checked.status === "unchanged" || checked.status === "snapped") return checked;
    const twice = same.takesFirst && "“" + same.takesFirst + "”";
    return { ...checked, sameWordJoin: { start: same.start, end: same.end, word: same.word, ...(same.takesFirst && { takesFirst: same.takesFirst }),
      reason: `${said} is said again right after this removal, and the word before runs into the first one with no pause. Matched on their sound, the first ${said} begins at ` +
        `${same.start.toFixed(3)} s: removing ${same.start.toFixed(3)}–${same.end.toFixed(3)} s ${twice ? `also takes out the first ${twice}, which this range leaves playing twice,` : "takes out the same words"} ` +
        `and plays the word before whole. ${SAME_WORD_UNHEARD}` } };
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
      // Measured quiet or room tone under the edge means the word is not sounding there (e.g. a scan timing
      // stretched across a dip over an omitted syllable), matching clipEdgeSound's soundUnderEdge.
      const split = atRoomTone(page, t) ? undefined : page.words.find(w => inWord(w, t));
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
