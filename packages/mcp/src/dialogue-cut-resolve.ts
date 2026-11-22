/**
 * Resolving word-addressed, pause-addressed, repeat-addressed, and seconds-addressed
 * dialogue cuts to timeline ranges on a version.
 */
import { normalizeTranscriptToken, type DialogueCutKind, type RepeatOccurrence } from "@scarlet/shared";
import { clipDuration, sourceToTimeline, timelineDuration, timelineToSource, type MediaClip, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import type { DialogueEvidence } from "./dialogue-decisions.js";
import {
  DEFAULT_PACE,
  dialogueAudioStream,
  edgeOnFrame,
  pageAt as scanPageAt,
  pageReaches,
  pauseCutRange,
  splitLeave,
  wordCutRange,
  type Breath,
  type JoinPace,
  type JoinPage,
  type ReadKeptWords,
} from "./dialogue-join.js";
import { audibleClipsInTrackOrder } from "./dialogue-reading.js";
import type { GapSound } from "./gap-sound.js";
import { heardOnlyVerbatim } from "./timeline-perception.js";

/** One range as the agent submits it: timeline seconds, or the removed words of a transcript. */
export interface DialogueCutInput {
  occurrence?: RepeatOccurrence;
  start?: number;
  end?: number;
  mediaId?: string;
  fromWord?: number;
  toWord?: number;
  /** A pause, named by the word it follows. Scarlet trims it to `leave` seconds. */
  afterWord?: number;
  leave?: number;
  /** Seconds of quiet between the cut and the next word, as heard. */
  voiceIn?: number;
  kind: DialogueCutKind;
  decision: "cut" | "review" | "keep";
  resumeWith?: string;
  keepRepeat?: string | string[];
  /** Words at the edge of a speech cut that it takes out on purpose, though the join doesn't say them again. */
  dropWords?: string | string[];
  productionQuote?: string;
  picture?: "safe" | "uncertain" | "protect";
  reason: string;
  summary?: string;
  /** A doubt the editor must settle by listening or looking, for a cut that applies. */
  check?: string;
}

/** The reads planning needs. The MCP server reads live; replay reads a stored case. */
export interface DialoguePlanSources {
  /** Dialogue-scan pages, for quoted words. */
  evidence: DialogueEvidence;
  /** Scan pages plus any windows measured since, for edge checks. */
  pages(): JoinPage[];
  project(): Promise<Project>;
  /**
   * Transcript words in transcript_get order, so word references keep their indices. A transcript can be read while
   * Scarlet is still placing its words on the audio; with `through`, the times are final up to that source second.
   * A recording with no transcript yet gets one made, and the read waits for it, unless `prepare` is false: then it
   * answers null at once.
   */
  words(mediaId: string, through?: number, prepare?: boolean): Promise<TranscriptWord[] | null>;
  /**
   * Throws when `words` is not the list the model last read indices from, or when words `from`–`to` read otherwise in
   * another list it was shown. Placing words can add ones the transcript missed, which moves every later index: a
   * reference read before that names other words now.
   */
  sameWordsAsRead?(mediaId: string, words: readonly TranscriptWord[], from?: number, to?: number): void;
  /** Measure the recording near these source instants when no scan page covers them. */
  measure(points: Array<{ mediaId: string; t: number }>): Promise<void>;
  /** Independent speech reading of the few seconds that would survive beside a cut, when available for replay. */
  readKeptWords?: ReadKeptWords;
  /** Actual duration of a centered dialogue crossfade in project frames, when known. */
  crossfadeFrames?: number;
  /** The room tone the model asked joins to leave either side (its skill's pace). Scarlet's default when absent. */
  pace?: JoinPace;
  /**
   * Whether a word reference's cut starts before or after a breath between the last kept word and the quiet: the
   * model's call, by its skill. "cut", the stock skill's, when absent.
   */
  breath?: Breath;
  /**
   * Sound at speaking level in a stretch of a recording that holds no transcript word, when its levels can be read.
   * With `betweenWords`, the stretch runs word to word and is read clear of each word's own edge.
   */
  sound?(mediaId: string, range: TimeRange, betweenWords?: boolean): Promise<GapSound | undefined>;
}

/** A word's estimate before alignment can sit a few hundred milliseconds early. Ask for final times this far past it. */
export const SETTLED_MARGIN = 2;

/** Seconds read either side of a pause's two words when the pause holds speech, so the reading has the words around it. */
const HEARD_CONTEXT = 0.5;
/** How far past that reading the transcript's words are compared with it: heardOnlyVerbatim's reach for one word. */
const HEARD_REACH = 1.5;

/**
 * A pause reference Scarlet found nothing to take out of: the pause already plays as short as asked, the quiet it could
 * trim in is shorter than the wait, or what would come out is less than a frame. The pause plays as it is.
 */
export class NoPauseToTrim extends Error {}
/** One cut of a batch that Scarlet could not turn into a range to remove. The batch's other cuts are unaffected. */
export class CutNotPlaced extends Error {}

/**
 * Resolve a word reference to a timeline range on `tl`: each edge goes in the measured silence
 * beside the removed words (wordCutRange), then maps through the clip that plays it.
 */
export async function resolveWordCut(tl: Timeline, ref: { mediaId: string; fromWord: number; toWord: number; leave?: number; voiceIn?: number }, sources: DialoguePlanSources, compareTakes = false) {
  let words = await sources.words(ref.mediaId);
  if (!words) throw new Error(`Media ${ref.mediaId} has no transcript words to reference. Use seconds instead.`);
  const { fromWord, toWord } = ref;
  sources.sameWordsAsRead?.(ref.mediaId, words, fromWord, toWord);
  if (fromWord > toWord || toWord >= words.length) {
    throw new Error(`Word range #${fromWord}–#${toWord} is outside ${ref.mediaId}'s transcript (#0–#${words.length - 1}).`);
  }
  const shifts = compareTakes ? equivalentShifts(words, fromWord, toWord).slice(1) : [];
  const last = Math.min(words.length - 1, toWord + 1 + Math.max(0, ...shifts));
  words = await sources.words(ref.mediaId, words[last]!.end + SETTLED_MARGIN) ?? words;
  sources.sameWordsAsRead?.(ref.mediaId, words, fromWord, toWord);
  const cut = await placeWordCut(tl, words, ref, sources);
  if (!shifts.length) return cut;
  // Only the inspection tool compares other performances. Saving always uses the indices submitted.
  const alternatives = await Promise.all(shifts.map(async shift => {
    const option = { mediaId: ref.mediaId, fromWord: fromWord + shift, toWord: toWord + shift };
    const placed = await placeWordCut(tl, words, option, sources).catch(() => undefined);
    return placed && { ...option, start: placed.start, end: placed.end, problems: placed.problems, dips: placed.dips };
  }));
  return { ...cut, alternativeWordRanges: alternatives.filter(option => option !== undefined) };
}

/** How far a removal of words[from..to] can slide and still leave the same words playing: always 0, then each shift. */
export function equivalentShifts(words: ReadonlyArray<Pick<TranscriptWord, "text">>, from: number, to: number) {
  const most = 5;
  const token = (i: number) => words[i] ? normalizeTranscriptToken(words[i]!.text) : "";
  const shifts = [0];
  // Later: the first removed word is said again right after the removal.
  for (let k = 1; k <= most && to + k < words.length && token(from + k - 1) && token(from + k - 1) === token(to + k); k++) shifts.push(k);
  // Earlier: the last removed word was said just before it.
  for (let k = 1; k <= most && from - k >= 0 && token(to - k + 1) && token(to - k + 1) === token(from - k); k++) shifts.push(-k);
  return shifts;
}

async function placeWordCut(tl: Timeline, words: TranscriptWord[], ref: { mediaId: string; fromWord: number; toWord: number; clipId?: string; leave?: number; voiceIn?: number }, sources: DialoguePlanSources) {
  const { fromWord, toWord } = ref;
  const before = words[fromWord - 1], after = words[toWord + 1];
  // The gap either side of the removed words: its middle, and the edge of the kept word beside it.
  const sides = [...(before ? [{ kept: before.end, middle: (before.end + words[fromWord]!.start) / 2 }] : []),
    ...(after ? [{ kept: after.start, middle: (words[toWord]!.end + after.start) / 2 }] : [])];
  await sources.measure(sides.map(s => ({ mediaId: ref.mediaId, t: s.middle })));
  const pageAt = (t: number) => scanPageAt(sources.pages(), ref.mediaId, 0, t);
  // A pause longer than the page read at its middle is placed from the page at the kept word's edge (wordCutRange),
  // so the recording is measured there as well. Every other gap is read once, at its middle.
  const beyond = sides.filter(s => { const page = pageAt(s.middle); return page && !pageReaches(page, s.kept); });
  if (beyond.length) await sources.measure(beyond.map(s => ({ mediaId: ref.mediaId, t: s.kept })));
  const clips = audibleClipsInTrackOrder(tl).filter(c => c.mediaId === ref.mediaId && (!ref.clipId || c.id === ref.clipId));
  const playing = clips.find(c => words[fromWord]!.start < c.sourceOut && words[toWord]!.end > c.sourceIn) ?? clips[0];
  // The pace, `leave` and `voiceIn` are what the editor hears; the quiet is measured in the recording, which the clip plays at its speed.
  const speed = playing?.speed ?? 1, asked = sources.pace ?? DEFAULT_PACE;
  const pace = { after: asked.after * speed, before: asked.before * speed };
  const cut = wordCutRange(words, fromWord, toWord, pageAt, ref.leave === undefined ? undefined : ref.leave * speed, pace, ref.voiceIn === undefined ? undefined : ref.voiceIn * speed, sources.breath);
  if (ref.clipId && clips[0]) {
    // No neighboring recognized word can justify removing a long unmeasured lead-in or tail at a clip boundary.
    const { sourceIn, sourceOut } = clips[0];
    if (!before && words[fromWord]!.start - sourceIn > .5) {
      cut.start = words[fromWord]!.start;
      cut.problems.push("The start has no measured neighboring word. Check the recording before this occurrence.");
    }
    if (!after && sourceOut - words[toWord]!.end > .5) {
      cut.end = words[toWord]!.end;
      cut.problems.push("The end has no measured neighboring word. Check the recording after this occurrence.");
    }
  }
  if (ref.clipId && (cut.end <= cut.start || cut.start >= words[fromWord]!.end || cut.end <= words[toWord]!.start)) {
    cut.start = words[fromWord]!.start;
    cut.end = words[toWord]!.end;
    cut.breath = undefined;
    cut.problems.push("The measured gaps do not bracket the spoken occurrence. Review its word boundaries.");
  }
  const fps = (await sources.project()).settings.fps;
  const place = (source: number, side: "start" | "end", word: TranscriptWord, room?: TimeRange) => {
    // The word itself must play on this version, once; the edge then maps through the same clip.
    const said = `Word #${side === "start" ? fromWord : toWord} “${word.text.trim()}”`;
    const clip = playedOnce(clips, word, `${said} in ${ref.mediaId}`, tl.version);
    if (!clip) throw new Error(`${said} is not in version ${tl.version}. Read timeline_transcript for the words this version plays.`);
    const on = onClip(clip);
    // Saved on the frame inside the measured quiet that is nearest the padded instant, so the engine's rounding keeps it there.
    return round3(edgeOnFrame(on(source), room, fps, on));
  };
  // The last words of an edit end where the timeline does. Rounding to the millisecond must not carry the range past it.
  const start = place(cut.start, "start", words[fromWord]!, cut.room.start), end = Math.min(place(cut.end, "end", words[toWord]!, cut.room.end), timelineDuration(tl));
  // A word of a frame or two in running speech, or one the recording has no sound for, puts both edges on one frame. That is
  // a measurement of this cut alone: the rest of its batch saves without it (CutNotPlaced). One pass sent seven repeat
  // removals, one of them a 60 ms “it”, had all seven refused for it and rewrote the whole timeline instead (2026-11-16).
  if (end <= start) throw new CutNotPlaced(`Words #${fromWord}–#${toWord} (“${cut.text}”) leave no range to remove on version ${tl.version}: ` +
    `the transcript times them at ${Math.max(0, words[toWord]!.end - words[fromWord]!.start).toFixed(2)} s and both edges land on the same frame. ` +
    `Keep them if they play as one word, or remove them with a word beside them.`);
  // Where the words themselves play: the edges sit in the silence either side of them.
  const spoken = { start: Math.max(start, place(words[fromWord]!.start, "start", words[fromWord]!)), end: Math.min(end, place(words[toWord]!.end, "end", words[toWord]!)) };
  return { start, end, words: cut.text, problems: cut.problems, dips: [...cut.dips, ...cut.retimed], ...(cut.breath && { breath: cut.breath }), spoken,
    source: { start: round3(cut.start), end: Number.isFinite(cut.end) ? round3(cut.end) : null } };
}

/** Where a clip plays an instant of the recording, held to the part of it the clip plays. */
const onClip = (clip: MediaClip) => (source: number) =>
  sourceToTimeline(clip, Math.min(Math.max(source, clip.sourceIn), clip.sourceOut));

/**
 * The clip a word index means. A word plays in each clip that keeps its midpoint, as timeline_transcript lists it, and
 * one take can play at more than one time on a version. An index can't say which, so that is refused with each time
 * the word plays, for the model to say which in timeline seconds. Clips that put the word at the same time, as a video
 * clip's sound and an audio clip of the same media do, are one placement, mapped through the first of them in track and
 * clip order.
 */
function playedOnce(clips: readonly MediaClip[], word: TranscriptWord, what: string, version: string) {
  const playing = clips.filter(c => word.start + word.end >= 2 * c.sourceIn && word.start + word.end < 2 * c.sourceOut);
  // In order of where the word starts, a placement joins a group only while the group still puts both ends of the word
  // within a millisecond, so clips a little apart each can't chain into one, in any order. Every group that starts within
  // a millisecond is looked at, as a clip at another speed can fall between two of the same placement.
  const times: Array<{ clip: MediaClip; low: number; high: number }> = [];
  for (const c of playing.toSorted((a, b) => sourceToTimeline(a, word.start) - sourceToTimeline(b, word.start))) {
    const end = sourceToTimeline(c, word.end);
    const group = times.findLast(g => sourceToTimeline(c, word.start) - sourceToTimeline(g.clip, word.start) < 1e-3 && Math.max(g.high, end) - Math.min(g.low, end) < 1e-3);
    if (group) {
      group.low = Math.min(group.low, end);
      group.high = Math.max(group.high, end);
    } else times.push({ clip: c, low: end, high: end });
  }
  if (times.length > 1) {
    // Milliseconds, the resolution the times are told apart at.
    const heard = times.map(({ clip: c }) => `${round3(sourceToTimeline(c, Math.max(word.start, c.sourceIn))).toFixed(3)}–${round3(sourceToTimeline(c, Math.min(word.end, c.sourceOut))).toFixed(3)} s`);
    throw new Error(`${what} plays ${times.length} times on version ${version}, at ${heard.join(", ")}. A word index can't say which: give the range to remove as start/end in timeline seconds.`);
  }
  return playing[0];
}

/**
 * The scan's own word-for-word reading of a stretch of a recording, from the page that holds most of it. The scan read
 * every page of a pass with a prompt in hesitant speech, so it has the false starts a transcript tidies away.
 */
function scanWords(evidence: DialogueEvidence, mediaId: string, from: number, to: number): TranscriptWord[] {
  const pages = evidence.scans.filter(s => s.mediaId === mediaId && s.segments?.length && s.start < to && s.end > from);
  const held = (s: TimeRange) => Math.min(to, s.end) - Math.max(from, s.start);
  const page = pages.sort((a, b) => held(b) - held(a))[0];
  if (!page) return [];
  return page.segments!.flatMap(s => s.words).filter(w => w.text.trim() && w.end > from && w.start < to).sort((a, b) => a.start - b.start);
}

const asIndexedWord = (mediaId: string) => (w: TimeRange & { text: string }, index: number) =>
  ({ mediaId, index, text: w.text.trim(), start: w.start, end: w.end });

/** Compare the dialogue scan's verbatim words around `[from, to]` against `listed` transcript words. */
function unwrittenScanWords(evidence: DialogueEvidence, mediaId: string, listed: readonly TranscriptWord[], from: number, to: number) {
  const toWord = asIndexedWord(mediaId);
  const scanned = scanWords(evidence, mediaId, from - HEARD_REACH - 1, to + HEARD_REACH + 1);
  const unwritten = scanned.length
    ? heardOnlyVerbatim(
      listed.flatMap((w, i) => w.end >= from - 2 * HEARD_REACH - 1 && w.start <= to + 2 * HEARD_REACH + 1 ? [toWord(w, i)] : []),
      scanned.map(toWord),
      w => w,
    )
    : [];
  return { scanned, unwritten };
}

/**
 * Resolve a pause named by the word it follows to a timeline range on `tl`: the pause between that word and the next
 * comes down to `leave` seconds as the clip plays it, or to the default edge padding, with both edges in the measured quiet.
 */
async function resolvePauseCut(tl: Timeline, ref: { mediaId: string; afterWord: number; leave?: number; voiceIn?: number }, sources: DialoguePlanSources) {
  let words = await sources.words(ref.mediaId);
  if (!words) throw new Error(`Media ${ref.mediaId} has no transcript words to reference. Use seconds instead.`);
  sources.sameWordsAsRead?.(ref.mediaId, words, ref.afterWord, ref.afterWord + 1);
  if (ref.afterWord >= words.length - 1) throw new Error(`No word follows #${ref.afterWord} in ${ref.mediaId}'s transcript (#0–#${words.length - 1}). Give the pause in seconds.`);
  words = await sources.words(ref.mediaId, words[ref.afterWord + 1]!.end + SETTLED_MARGIN) ?? words;
  sources.sameWordsAsRead?.(ref.mediaId, words, ref.afterWord, ref.afterWord + 1);
  const listed = words, before = words[ref.afterWord]!, after = words[ref.afterWord + 1]!;
  const said = `“${before.text.trim()}” and “${after.text.trim()}” (#${ref.afterWord}, #${ref.afterWord + 1})`;
  // One clip plays both words: across a join the pause is the join's, and there is no stretch of the recording to take out.
  const clip = audibleClipsInTrackOrder(tl).find(c => c.mediaId === ref.mediaId &&
      before.start + before.end >= 2 * c.sourceIn && after.start + after.end < 2 * c.sourceOut);
  if (!clip) throw new Error(`Version ${tl.version} does not play ${said} one after the other. Read timeline_transcript for the words this version plays.`);
  const middle = (before.end + after.start) / 2;
  await sources.measure([Math.min(before.end + .1, middle), Math.max(after.start - .1, middle)].map(t => ({ mediaId: ref.mediaId, t })));
  const pageAt = (t: number) => scanPageAt(sources.pages(), ref.mediaId, 0, t);
  // `leave` is what the editor hears, and the clip plays the recording at its speed: at 2x, 0.4 s heard is 0.8 s of the
  // recording. The quiet the edges stay in is measured in the recording, so the trim is placed there.
  // Callers inside Scarlet may omit `leave`; the agent's tools require it.
  const speed = clip.speed ?? 1, pace = sources.pace ?? DEFAULT_PACE, leave = ref.leave ?? pace.after + pace.before;
  const cut = pauseCutRange(before, after, pageAt, leave * speed, { after: pace.after * speed, before: pace.before * speed }, ref.voiceIn === undefined ? undefined : ref.voiceIn * speed);
  const plays = cut.plays / speed;
  const on = onClip(clip);
  if ((cut.end - cut.start) / speed < .04) {
    // Already as short as asked, to within what a trim can take out.
    if (plays - leave < .04) throw new NoPauseToTrim(`The pause between ${said} plays ${plays.toFixed(2)} s, which leaves nothing to trim down to ${leave.toFixed(2)} s.`);
    // Longer than asked, and still nothing to take out: each edge stays inside the measured quiet beside its word, and
    // the rest of the wait is sound under speaking level that reaches a word, most often the breath before the next
    // line. Said as "plays 0.50 s, which leaves nothing to trim down to 0.10 s", it read as a contradiction and gave
    // the model nothing to do about a wait it was right to want shorter.
    throw new NoPauseToTrim(`The pause between ${said} plays ${plays.toFixed(2)} s, but a trim stays inside the measured quiet beside the two words, and that quiet ` +
      `is too short to bring it down to ${leave.toFixed(2)} s: the rest of the wait is sound, such as a breath, that runs up to a word. ` +
      `It plays as it is. To take that sound out with the wait, give the range in timeline seconds: the wait is ${on(before.end).toFixed(2)}–${on(after.start).toFixed(2)} s on version ${tl.version}.`);
  }
  const fps = (await sources.project()).settings.fps;
  const place = (source: number, room?: TimeRange) => round3(edgeOnFrame(on(source), room, fps, on));
  // A removal is saved on whole frames inside the quiet its edges sit in. Where that quiet holds one frame, both edges
  // land on it and nothing is left to remove: sent on, the empty range refused the whole batch as "is empty. Submit
  // distinct nonoverlapping ranges", for a range Scarlet placed itself.
  const start = place(cut.start, cut.room.start), end = place(cut.end, cut.room.end);
  if (end <= start) throw new NoPauseToTrim(`The pause between ${said} plays ${plays.toFixed(2)} s, and trimming it to ${leave.toFixed(2)} s would take out ` +
    `${Math.round((cut.end - cut.start) / speed * 1000)} ms: the quiet between the words holds no whole frame of version ${tl.version} to remove. It plays as it is.`);
  // The transcript has no word here, which is not the same as nothing being said: a pause held a missed "see" and a
  // second "you can", and another the "five point five" of a "5.5" the transcript had timed at 80 ms. What sounds in
  // the range goes back to the agent, in this version's seconds as well, since that is how it would cut or keep it.
  const held = await sources.sound?.(ref.mediaId, { start: cut.start, end: cut.end }).catch(() => undefined);
  const spans = (runs: TimeRange[], at: (t: number) => number) => runs.map(r => `${at(r.start).toFixed(2)}–${at(r.end).toFixed(2)}`).join(", ");
  const notes = held?.runs.length ? [`This pause holds ${held.seconds.toFixed(2)} s of sound at speaking level that no word explains (${
    spans(held.runs, t => t)} s in ${ref.mediaId}, ${spans(held.runs, on)} s on version ${tl.version}).`] : [];
  // The quiet a trim takes out can be a small part of what the transcript calls a pause. Whisper had written “what it
  // would do is” over “what it would do, it was, it would, in fact, what it would do is”, stretching its words across
  // the restart; each trim took only the quiet between two of the takes, held no sound, and the pass left all three in
  // as one sentence it had tightened (2026-11-18). Sound in the rest of that stretch is read too, and words the
  // transcript doesn't have there are a decision about words, as sound in the trim itself is.
  // The scan read this stretch word for word before the pass asked for the trim, and what it has there that the
  // transcript doesn't is words, whether or not they reach speaking level: “And it just feel, uh, let's see. It just feels
  // like” was in the transcript as “And it [3.8 s] just feels like”, the abandoned words trailed off under that level,
  // and a trim of the “pause” after “it” took out “let's see” and left the false start playing (2026-11-19).
  const { scanned, unwritten: rawUnwritten } = unwrittenScanWords(sources.evidence, ref.mediaId, listed, before.start, after.end);
  const unwritten = rawUnwritten.filter(r => r.source.end > before.end && r.source.start < after.start);
  if (unwritten.length) notes.push(`The transcript has nothing between ${said} for ${(after.start - before.end).toFixed(2)} s, ` +
    `but the scan read ${unwritten.map(r => `“${r.text}” at ${r.source.start.toFixed(2)}–${r.source.end.toFixed(2)} s in ${ref.mediaId} (${
      on(r.source.start).toFixed(2)}–${on(r.source.end).toFixed(2)} s on version ${tl.version})`).join(" and ")} there, in “${unwritten[0]!.context}”. ` +
    `A trim would cut through those words or leave them playing.`);
  const around = notes.length ? undefined
    : await sources.sound?.(ref.mediaId, { start: before.end, end: after.start }, true).catch(() => undefined);
  const read = !unwritten.length && (notes.length || around?.runs.length) ? await readAround() : undefined;
  // A note says only that sound is there, and the agent can't hear it. Read on its own, the stretch from the word before
  // to the word after says what it is: Whisper had written “great. I'm” where the recording says “great, but it hasn't all
  // been great. I'm”, a restart it smoothed away, and a pass that couldn't trim the pause left both takes in (2026-11-16).
  // Beside the trim, only words count: a breath or a laugh there plays as it did, and the trim saves.
  if (around?.runs.length && read) {
    // Words the transcript stretched over the stretch count with it: “would” ran 1.4 s there, over “in fact, what it”.
    const missed = heardOnlyVerbatim(read.transcript, read.heard, w => w).filter(r => r.source.end > before.start && r.source.start < after.end);
    if (missed.length) notes.push(`The transcript has nothing between ${said} for ${(after.start - before.end).toFixed(2)} s, ` +
      `but the recording says ${missed.map(r => `“${r.text}” at ${r.source.start.toFixed(2)}–${r.source.end.toFixed(2)} s in ${ref.mediaId} (${
        on(r.source.start).toFixed(2)}–${on(r.source.end).toFixed(2)} s on version ${tl.version})`).join(" and ")} there. ` +
      `A trim would take out only the quiet beside those words and leave them playing.`);
  }
  let heard: string | undefined;
  if (unwritten.length) heard = `The scan reads “${scanned.filter(w => w.end > before.start - 1 && w.start < after.end + 1).map(w => w.text.trim()).join(" ")}” there, where the transcript has “${before.text.trim()} ${after.text.trim()}”.`;
  else if (notes.length && read?.said) heard = `Read on its own, ${read.from.toFixed(2)}–${read.to.toFixed(2)} s in ${ref.mediaId} (${on(read.from).toFixed(2)}–${
    on(read.to).toFixed(2)} s on version ${tl.version}) says “${read.said}”, where the transcript has “${before.text.trim()} ${after.text.trim()}”.`;
  async function readAround() {
    if (!sources.readKeptWords) return undefined;
    const project = await sources.project();
    const asset = project.media.find(m => m.id === ref.mediaId);
    const from = Math.max(clip!.sourceIn, before.start - HEARD_CONTEXT), to = Math.min(clip!.sourceOut, after.end + HEARD_CONTEXT);
    const reading = await sources.readKeptWords(ref.mediaId, dialogueAudioStream(clip!) ?? (asset && dialogueAudioStream(asset)) ?? 0, from, to)
      .catch(() => undefined);
    if (!reading) return undefined;
    const text = reading.map(w => w.text.trim()).filter(Boolean).join(" ");
    // Both readings in source seconds, as heardOnlyVerbatim compares them. The transcript's side reaches as far as it
    // matches words, so a word the reading times a little off still finds its counterpart.
    const toWord = asIndexedWord(ref.mediaId);
    const transcript = listed.flatMap((w, i) => w.end >= from - HEARD_REACH && w.start <= to + HEARD_REACH ? [toWord(w, i)] : []);
    return { from, to, said: text, transcript, heard: reading.map(toWord) };
  }
  return { start, end, words: `pause after “${before.text.trim()}”`, problems: cut.problems, notes,
    holdsSound: notes.length > 0, ...(heard && { heard }),
    source: { start: round3(cut.start), end: round3(cut.end) }, plays: round3(plays) };
}

/**
 * What a pause given in timeline seconds holds besides quiet, recording by recording: words the transcript has there,
 * words only the scan read, and sound at speaking level no word explains. A pause named by its word is read for all
 * three (resolvePauseCut); one typed in seconds was applied as typed, words and all (found reviewing the planner,
 * 2026-11-20).
 */
export async function secondsPauseHolds(tl: Timeline, range: TimeRange, sources: DialoguePlanSources): Promise<string[]> {
  const project = await sources.project();
  const found: string[] = [];
  for (const clip of audibleClipsInTrackOrder(tl)) {
    const lo = Math.max(range.start, clip.timelineIn), hi = Math.min(range.end, clip.timelineIn + clipDuration(clip));
    if (hi - lo <= 1e-6 || !project.media.some(m => m.id === clip.mediaId && (m.kind === "audio" || m.hasAudio))) continue;
    const from = timelineToSource(clip, lo), to = timelineToSource(clip, hi);
    const words = await sources.words(clip.mediaId, to + SETTLED_MARGIN, false).catch(() => null);
    // A recording with no words, such as music under the talk, is not read for speech.
    if (!words?.length) continue;
    const where = (start: number, end: number) => `${sourceToTimeline(clip, start).toFixed(2)}–${sourceToTimeline(clip, end).toFixed(2)} s on version ${tl.version} (${start.toFixed(2)}–${end.toFixed(2)} s in ${clip.mediaId})`;
    const middle = (w: TimeRange) => (w.start + w.end) / 2;
    // A word the range only reaches into is its edge's, which the join check measures; one whose middle is inside is in the pause.
    const said = words.filter(w => w.text.trim() && middle(w) > from && middle(w) < to);
    if (said.length) found.push(`It holds “${said.map(w => w.text.trim()).join(" ")}” at ${where(said[0]!.start, said.at(-1)!.end)}.`);
    const unwritten = unwrittenScanWords(sources.evidence, clip.mediaId, words, from, to).unwritten
      .filter(r => middle(r.source) > from && middle(r.source) < to);
    if (unwritten.length) found.push(`The scan read ${unwritten.map(r => `“${r.text}” at ${where(r.source.start, r.source.end)}`).join(" and ")} there, words the transcript doesn't have.`);
    if (said.length || unwritten.length) continue;
    // Sound clear of the words the range reaches into at its edges.
    const start = Math.max(from, ...words.filter(w => w.start < from && w.end > from).map(w => w.end));
    const end = Math.min(to, ...words.filter(w => w.start < to && w.end > to).map(w => w.start));
    const held = end - start > .1 ? await sources.sound?.(clip.mediaId, { start, end }).catch(() => undefined) : undefined;
    if (held?.runs.length) found.push(`It holds ${held.seconds.toFixed(2)} s of sound at speaking level that no word explains, at ${
      held.runs.map(r => where(r.start, r.end)).join(", ")}.`);
  }
  return found;
}

type CutRef = { occurrence?: RepeatOccurrence; start?: number; end?: number; mediaId?: string; fromWord?: number; toWord?: number; afterWord?: number; leave?: number; voiceIn?: number };

/** A cut given in timeline seconds, as removed words, or as the pause after a word, resolved to timeline seconds on `tl`. */
export async function resolveCutRange(tl: Timeline, c: CutRef, label: string, sources: DialoguePlanSources, compareTakes = false, duration?: number) {
  const pause = c.afterWord !== undefined;
  const words = c.mediaId !== undefined || c.fromWord !== undefined || c.toWord !== undefined || pause;
  const seconds = c.start !== undefined || c.end !== undefined;
  if (c.occurrence) {
    // The recording's id beside removeRepeat names nothing new. A range or a word reference would be a second, different removal.
    // `leave` is neither: it says how long the join plays, as it does on a word reference.
    if (c.fromWord !== undefined || c.toWord !== undefined || pause || seconds)
      throw new Error(`${label}: removeRepeat already identifies the range to remove. Leave out start/end, fromWord/toWord and afterWord on that cut.`);
    const { mediaId, clipId, words: heard, before, after } = c.occurrence;
    const around = [...(before ? [before] : []), ...heard, ...(after ? [after] : [])];
    const fromWord = before ? 1 : 0;
    return { ...await placeWordCut(tl, around, { clipId, mediaId, fromWord, toWord: fromWord + heard.length - 1, leave: c.leave, voiceIn: c.voiceIn }, sources), wordRef: true as const };
  }
  if (words === seconds) throw new Error(`${label}: give start/end in timeline seconds or mediaId with fromWord/toWord, not both or neither.`);
  if (pause) {
    if (!c.mediaId || c.fromWord !== undefined || c.toWord !== undefined) throw new Error(`${label}: a pause reference is mediaId with afterWord, without fromWord or toWord.`);
    // How long a pause plays is pacing, and pacing is the agent's call: there is no length Scarlet picks for it.
    if (c.leave === undefined) throw new Error(`${label}: give leave with afterWord, the seconds this pause should still play, word to word. Judge it by the delivery around it and the pace the skill asks for.`);
    return { ...await resolvePauseCut(tl, { mediaId: c.mediaId, afterWord: c.afterWord!, leave: c.leave, voiceIn: c.voiceIn }, sources), wordRef: true as const };
  }
  if (seconds) {
    if (c.start === undefined || c.end === undefined) throw new Error(`${label}: give both start and end.`);
    // Times reach the agent rounded to the millisecond. An edit that ends at 1777.0666… s reads as 1777.067, and a
    // range to that end is a range to the end of the edit, not one that runs past it.
    const total = duration ?? timelineDuration(tl);
    // The pause its join plays, as on a word reference: the edges that sit in quiet go where it puts them (checkEdge).
    const pace = sources.pace ?? DEFAULT_PACE;
    const air = c.leave !== undefined ? splitLeave(c.leave, pace, c.voiceIn) : c.voiceIn !== undefined ? { after: pace.after, before: c.voiceIn } : undefined;
    return { start: c.start, end: c.end > total && c.end - total <= 0.001 ? total : c.end, ...(air && { air }) };
  }
  if (!c.mediaId || c.fromWord === undefined || c.toWord === undefined) throw new Error(`${label}: a word reference needs mediaId, fromWord and toWord.`);
  return { ...await resolveWordCut(tl, { mediaId: c.mediaId, fromWord: c.fromWord, toWord: c.toWord, leave: c.leave, voiceIn: c.voiceIn }, sources, compareTakes), wordRef: true as const };
}
