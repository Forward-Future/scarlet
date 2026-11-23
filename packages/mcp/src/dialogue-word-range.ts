/**
 * Word-addressed and pause-addressed source-range placement on measured silence.
 */
import type { TimeRange } from "@scarlet/timeline";
import { normalizeTranscriptToken } from "@scarlet/shared";
import { round3 } from "./analysis.js";
import {
  DEFAULT_PACE,
  levelBars,
  PAUSE_BEAT,
  besideWord,
  breathBetween,
  breathInRun,
  breathNote,
  dipBetween,
  gaps,
  keptSlack,
  onsetLimit,
  padEdge,
  pageReaches,
  plain,
  quietMargin,
  removedSlack,
  roomBeforeBreath,
  roomToneAfter,
  soundingWord,
  splitLeave,
  wordMargin,
  wordPeakAt,
  type Breath,
  type JoinPace,
  type JoinPage,
  type Word,
} from "./dialogue-acoustics.js";

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
  /** Kept words beside the cut that sound somewhere other than their timing, and where the edge found them. */
  retimed: string[];
  /** A breath measured after the last kept word, where the start looked for quiet or room tone, and where the start is beside it. */
  breath?: string;
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
  // Below the level that counts as quiet, the recording cannot locate the word inside its timing.
  const bounds = { start: wordPeakAt(page, left, left.start), end: wordPeakAt(page, right, right.end) };
  // A named word comes out when its middle does: that is how the cut's words, what it plays and the check for a word
  // played twice all read it. A word too quiet to locate left its far end as the bound, and the edge went to the quiet
  // after it: “nice you ‖ you can see” was placed past the “you” the model named, then refused for playing it twice (2026-11-17).
  const named = (outer.start + outer.end) / 2;
  return side === "start" ? { start: bounds.start, end: Math.min(bounds.end, named) } : { start: Math.max(bounds.start, named), end: bounds.end };
}

/** Two words the transcript times this close are said as one: their edge goes where it parts them. */
export const RUN_ON_GAP = .06;

/**
 * The source range that removes words[from..to] (indices into one transcript, sorted by start).
 * Each edge goes in the measured silence between a removed word and its kept neighbor, padded by
 * the default edge padding. `pageAt` returns measured evidence covering a source time. Without a kept
 * neighbor the edge runs to the start or end of the material.
 */
export function wordCutRange(words: Word[], from: number, to: number, pageAt: (t: number) => JoinPage["edges"] | undefined, leave?: number, pace: JoinPace = DEFAULT_PACE, voiceIn?: number, breath: Breath = "cut"): WordCut {
  const first = words[from]!, last = words[to]!;
  // The pause the join should play, word to word, and how much of it follows the cut, in the recording's seconds.
  const air = leave === undefined ? { after: pace.after, before: voiceIn ?? pace.before } : splitLeave(leave, pace, voiceIn);
  const problems: string[] = [], dips: string[] = [], retimed: string[] = [];
  let breathFound: string | undefined;
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
    if (side === "start") breathFound = undefined;
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
      // A breath after the kept word: before the quiet, which then starts after it, or held in the quiet from its
      // start. Until 2026-11-21 the edge always went before it, in the room right after the word; now the model
      // decides (`breath`), the default is the skill's and the same as before, and the breath is reported either way.
      const runPage = side === "start" && page ? pageAt(run.start) ?? page : undefined;
      const outside = runPage && roomBeforeBreath(runPage, kept, run);
      const inside = runPage && !outside ? breathInRun(runPage, kept, run) : undefined;
      // Kept, the edge goes in the quiet after the breath, padded as any edge in quiet is: for a breath the run holds,
      // the rest of the run, when that is long enough to place an edge in.
      const afterInside = inside && { start: inside.breath.end, end: run.end };
      const roomAfter = afterInside && afterInside.end - afterInside.start >= 2 * quietMargin ? afterInside : undefined;
      const quiet = outside && breath === "cut" ? outside.room : roomAfter && breath === "keep" ? roomAfter : run;
      room[side] = { start: quiet.start + quietMargin, end: quiet.end - quietMargin };
      const at = padEdge(quiet, side, air);
      const found = outside ?? inside;
      if (found) breathFound = breathNote(kept, found, at, breath, inside && breath === "keep" && !roomAfter ? "since the quiet after it is too short to start a cut in" : undefined);
      return at;
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
      // The room right after the kept word, then a breath up to the next room tone before the removed word's sound: the
      // default is the skill's, this room; kept (`breath`), the start goes to the middle of the room after the breath,
      // as it does in any stretch at room tone (2026-11-21).
      const next = side === "start" && page && bounds && low.room && low.db <= levelBars(page.levels).dip ? roomToneAfter(page, low.room.end, bounds.end) : undefined;
      const found = next && breathBetween(page!, kept, low.room!, next);
      const at = found && breath === "keep" ? (next.start + next.end) / 2 : low.at;
      room[side] = found && breath === "keep" ? next : low.room;
      if (found) breathFound = breathNote(kept, found, at, breath);
      return at;
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
  return { start, end, problems, dips, text, room, retimed, ...(breathFound && { breath: breathFound }) };
}

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
  const between = (page: JoinPage["edges"] | undefined, side: "start" | "end") => (page ? gaps(page) : []).filter(q => {
    if (!long(q) || q.end <= before.end - keptSlack || q.start >= after.start + keptSlack) return false;
    const at = side === "start" ? inside(q, before.end + air.after)
      : air.before < quietMargin ? Math.max(q.start + quietMargin, q.end - air.before) : inside(q, after.start - air.before);
    return wordPeakAt(page!, before, before.start) < at && at < wordPeakAt(page!, after, after.end);
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
