/**
 * The planning step of dialogue_apply_cuts, without I/O: resolve word references, validate the plan,
 * verify optional quotes, check every retake, filler and quoted production edge against the recording,
 * and record each change Scarlet makes for the agent's gate report. The MCP tool supplies live reads;
 * offline replay (evals/src/replay.ts) supplies stored ones, so both run the same code.
 */
import { cutScope, normalizeTranscriptToken, selectedRange, type RepeatOccurrence, type DialogueCutKind, type DialogueDetections, type Task } from "@scarlet/shared";
import { clipDuration, clipsAt, indexClipsAt, frameAlignedRemoval, mergeRanges, timelineDuration, timelineToSource, type MediaClip, type Project, type Timeline, type TimeRange, type TranscriptWord } from "@scarlet/timeline";
import { audibleClipsByTrack, round3 } from "./analysis.js";
import { quietKeptWords, type QuietKeptWord } from "./quiet-kept-word.js";
import { edgeOvershoots } from "./edge-overshoot.js";
import { heardOnlyVerbatim, timelineWords } from "./timeline-perception.js";
import type { GapSound } from "./gap-sound.js";
import type { DialogueEvidence } from "./dialogue-decisions.js";
import { edgeOnFrame, pageAt as scanPageAt, checkKeptWords, type ReadKeptWords, dialogueJoinChecker, checkResumeQuote, dialogueCutPreview, dialogueJoinWords, joinEvidence, pageReaches, pauseCutRange, DEFAULT_PACE, splitLeave, type JoinPace, quietFrameNote, dialogueAudioStream, soundBesideEdge, wordCutRange, type JoinPage } from "./dialogue-join.js";

/** Every clip of a recording that sounds on this version, in track and clip order. */
const audibleMediaClips = (tl: Timeline) => audibleClipsByTrack(tl).flat();

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
   * Sound at speaking level in a stretch of a recording that holds no transcript word, when its levels can be read.
   * With `betweenWords`, the stretch runs word to word and is read clear of each word's own edge.
   */
  sound?(mediaId: string, range: TimeRange, betweenWords?: boolean): Promise<GapSound | undefined>;
}

/** A word's estimate before alignment can sit a few hundred milliseconds early. Ask for final times this far past it. */
export const SETTLED_MARGIN = 2;
/** An applied cut's edge this close to the sound it removes is reported to the agent: about two frames at 30 fps. */
export const SPEECH_BESIDE_EDGE = 0.06;
/** How far either side of a join its words are read, in timeline seconds: room for the words a restart is judged by. */
const JOIN_CONTEXT_SECONDS = 12;
/** Words of each side quoted when a join comes back for taking words out of a sentence. */
const EDGE_WORDS_SHOWN = 6;

/**
 * How far into each recording a set of cuts reaches: the source time under the end of its furthest cut. A stretch the
 * agent decided from the transcript alone was never paged through dialogue_scan, and cuts saved there reach it all the
 * same, on every recording under them.
 */
export function cutsReach(tl: Timeline, cuts: readonly TimeRange[]) {
  const reach = new Map<string, number>();
  const at = cuts.length > 1 ? indexClipsAt(tl) : (time: number) => clipsAt(tl, time);
  for (const cut of cuts) {
    // The last instant the cut removes. Its end is the first instant kept, which can be past the last clip.
    for (const { clip } of at(Math.max(cut.start, cut.end - 1e-6))) {
      if (clip.kind === "media") reach.set(clip.mediaId, Math.max(reach.get(clip.mediaId) ?? 0, timelineToSource(clip, cut.end)));
    }
  }
  return reach;
}

/** Each audible source instant under the given timeline times. */
export function audibleSourcePoints(tl: Timeline, times: number[]) {
  const clips = times.length > 2 ? indexClipsAt(tl) : (time: number) => clipsAt(tl, time);
  return times.flatMap(at => clips(at).flatMap(({ clip, track }) =>
    clip.kind === "media" && !track.muted && clip.enabled && clip.volume > 0 && track.kind !== "caption"
      ? [{ mediaId: clip.mediaId, t: timelineToSource(clip, at) }] : []));
}

/**
 * Resolve a word reference to a timeline range on `tl`: each edge goes in the measured silence
 * beside the removed words (wordCutRange), then maps through the clip that plays it.
 */
async function resolveWordCut(tl: Timeline, ref: { mediaId: string; fromWord: number; toWord: number; leave?: number; voiceIn?: number }, sources: DialoguePlanSources, compareTakes = false) {
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
  const clips = audibleMediaClips(tl).filter(c => c.mediaId === ref.mediaId && (!ref.clipId || c.id === ref.clipId));
  const playing = clips.find(c => words[fromWord]!.start < c.sourceOut && words[toWord]!.end > c.sourceIn) ?? clips[0];
  // The pace, `leave` and `voiceIn` are what the editor hears; the quiet is measured in the recording, which the clip plays at its speed.
  const speed = playing?.speed ?? 1, asked = sources.pace ?? DEFAULT_PACE;
  const pace = { after: asked.after * speed, before: asked.before * speed };
  const cut = wordCutRange(words, fromWord, toWord, pageAt, ref.leave === undefined ? undefined : ref.leave * speed, pace, ref.voiceIn === undefined ? undefined : ref.voiceIn * speed);
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
  return { start, end, words: cut.text, problems: cut.problems, dips: [...cut.dips, ...cut.retimed], spoken, source: { start: round3(cut.start), end: Number.isFinite(cut.end) ? round3(cut.end) : null } };
}

/** Where a clip plays an instant of the recording, held to the part of it the clip plays. */
const onClip = (clip: MediaClip) => (source: number) =>
  clip.timelineIn + (Math.min(Math.max(source, clip.sourceIn), clip.sourceOut) - clip.sourceIn) / (clip.speed ?? 1);

/** Where a clip puts an instant of the recording, were the clip long enough to reach it. */
const placedAt = (c: MediaClip, t: number) => c.timelineIn + (t - c.sourceIn) / (c.speed ?? 1);

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
  for (const c of playing.toSorted((a, b) => placedAt(a, word.start) - placedAt(b, word.start))) {
    const end = placedAt(c, word.end);
    const group = times.findLast(g => placedAt(c, word.start) - placedAt(g.clip, word.start) < 1e-3 && Math.max(g.high, end) - Math.min(g.low, end) < 1e-3);
    if (group) {
      group.low = Math.min(group.low, end);
      group.high = Math.max(group.high, end);
    } else times.push({ clip: c, low: end, high: end });
  }
  if (times.length > 1) {
    // Milliseconds, the resolution the times are told apart at.
    const heard = times.map(({ clip: c }) => `${round3(placedAt(c, Math.max(word.start, c.sourceIn))).toFixed(3)}–${round3(placedAt(c, Math.min(word.end, c.sourceOut))).toFixed(3)} s`);
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
  const clip = audibleMediaClips(tl).find(c => c.mediaId === ref.mediaId &&
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
  const asWordAt = (w: { text: string; start: number; end: number }, index: number) => ({ mediaId: ref.mediaId, index, text: w.text.trim(), start: w.start, end: w.end });
  const scanned = scanWords(sources.evidence, ref.mediaId, before.start - HEARD_REACH - 1, after.end + HEARD_REACH + 1);
  const unwritten = scanned.length ? heardOnlyVerbatim(listed.flatMap((w, i) => w.end >= before.start - 2 * HEARD_REACH - 1 && w.start <= after.end + 2 * HEARD_REACH + 1 ? [asWordAt(w, i)] : []),
    scanned.map(asWordAt), w => w).filter(r => r.source.end > before.end && r.source.start < after.start) : [];
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
    const asWord = (w: { text: string; start: number; end: number }, index: number) => ({ mediaId: ref.mediaId, index, text: w.text.trim(), start: w.start, end: w.end });
    const transcript = listed.flatMap((w, i) => w.end >= from - HEARD_REACH && w.start <= to + HEARD_REACH ? [asWord(w, i)] : []);
    return { from, to, said: text, transcript, heard: reading.map(asWord) };
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
async function secondsPauseHolds(tl: Timeline, range: TimeRange, sources: DialoguePlanSources): Promise<string[]> {
  const project = await sources.project();
  const found: string[] = [];
  for (const clip of audibleMediaClips(tl)) {
    const lo = Math.max(range.start, clip.timelineIn), hi = Math.min(range.end, clip.timelineIn + clipDuration(clip));
    if (hi - lo <= 1e-6 || !project.media.some(m => m.id === clip.mediaId && (m.kind === "audio" || m.hasAudio))) continue;
    const from = timelineToSource(clip, lo), to = timelineToSource(clip, hi);
    const words = await sources.words(clip.mediaId, to + SETTLED_MARGIN, false).catch(() => null);
    // A recording with no words, such as music under the talk, is not read for speech.
    if (!words?.length) continue;
    const on = (t: number) => clip.timelineIn + (t - clip.sourceIn) / (clip.speed ?? 1);
    const where = (start: number, end: number) => `${on(start).toFixed(2)}–${on(end).toFixed(2)} s on version ${tl.version} (${start.toFixed(2)}–${end.toFixed(2)} s in ${clip.mediaId})`;
    const middle = (w: TimeRange) => (w.start + w.end) / 2;
    // A word the range only reaches into is its edge's, which the join check measures; one whose middle is inside is in the pause.
    const said = words.filter(w => w.text.trim() && middle(w) > from && middle(w) < to);
    if (said.length) found.push(`It holds “${said.map(w => w.text.trim()).join(" ")}” at ${where(said[0]!.start, said.at(-1)!.end)}.`);
    const asWordAt = (w: TimeRange & { text: string }, index: number) => ({ mediaId: clip.mediaId, index, text: w.text.trim(), start: w.start, end: w.end });
    const scanned = scanWords(sources.evidence, clip.mediaId, from - HEARD_REACH - 1, to + HEARD_REACH + 1);
    const unwritten = scanned.length ? heardOnlyVerbatim(words.flatMap((w, i) => w.end >= from - 2 * HEARD_REACH - 1 && w.start <= to + 2 * HEARD_REACH + 1 ? [asWordAt(w, i)] : []),
      scanned.map(asWordAt), w => w).filter(r => middle(r.source) > from && middle(r.source) < to) : [];
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

/** One dialogue-scan page as join evidence, built the same way for the live tool and for replay. */
export function dialogueScanPage(mediaId: string, from: number, to: number, audioStream: number, segments: DialogueDetections["segments"],
  wf: Parameters<typeof joinEvidence>[1]) {
  return { mediaId, start: from, end: to, audioStream, edges: joinEvidence(segments.flatMap(s => s.words), wf), segments };
}

type ResolvedCut = Omit<DialogueCutInput, "mediaId" | "fromWord" | "toWord" | "afterWord" | "leave"> & {
  start: number;
  end: number;
  /** Index of the range in the submitted list. */
  input: number;
  words?: string;
  wordEdgeProblems?: string[];
  /** Edges Scarlet placed at a dip in the level between two words that run together. */
  wordEdgeDips?: string[];
  /** What Scarlet measured in the range that the agent's words for it do not say. */
  notes?: string[];
  /** Where a word reference's words play. Its edges were placed by Scarlet in the silence beyond them. */
  spoken?: TimeRange;
  /** Other word ranges that leave the same words playing and found measured quiet at both edges. */
  cleanAlternatives?: Array<{ fromWord: number; toWord: number }>;
  /** The room tone a range in seconds asked its join to leave, with `leave` or `voiceIn`. */
  air?: JoinPace;
};
/** One cut as sent to the engine (DialogueCutsRequest). */
interface PlannedDecision extends TimeRange {
  reason: string;
  summary?: string;
  review: boolean;
  kind: DialogueCutKind;
  originalRange: TimeRange | undefined;
  /** Marks an applied cut as needing the editor until they keep it. */
  check?: string;
  /** Why Scarlet held a cut the agent sent to apply: what it measured at the edges. The agent's reason stays its own. */
  held?: string;
  /** Nothing Scarlet measures can settle this join (a same-word join): the cut waits for the editor, and the engine lets no later cut replace it. */
  unheard?: true;
  /** Held for how its join measured, applied as placed only because the agent sent unsureJoins cut. */
  appliedAsPlaced?: true;
}
export type GateLine = Record<string, unknown> & { cut: number };

type DialoguePlan =
  | { outcome: "preserved"; kept?: TimeRange[] }
  | { outcome: "needsRevision"; disputedEdges: Array<Partial<TimeRange> & { reason: string; quietKeptWord?: QuietKeptWord;
      /** The submitted cuts, by index, whose edges make this dispute: set them aside and the rest can be planned. */
      cuts: number[] }> }
  | { outcome: "ready"; removals: ResolvedCut[]; decisions: PlannedDecision[]; gate: Map<number, GateLine>;
      /** Ranges the plan keeps on purpose, in timeline seconds: keep decisions, however they were given, and protected pictures. */
      kept: TimeRange[];
      unreadJoinAudio?: Array<{ cut: number; reasons: string[] }> };

interface DialoguePlanRequest {
  tl: Timeline;
  cuts: DialogueCutInput[];
  /** What the calling tool accepts to resolve a repeated phrase, when it takes keeps instead of removals. */
  repeatHint?: string;
  range?: TimeRange;
  only?: DialogueCutKind;
  /** /tighten-pauses-here: pauses only, in a local passage. */
  localPauses: boolean;
  /** The task's selection, which bounds the plan. */
  anchor?: Task["context"];
  /** Submitted cuts, by index, left out of this plan because their edges were disputed. The rest keep their indices. */
  setAside?: ReadonlySet<number>;
  /**
   * What happens to a cut the model decided when Scarlet can't place its join cleanly: "ask" holds it for the editor
   * with the evidence, "cut" applies it as placed and reports the evidence to the model. Its skill says which.
   */
  unsureJoins?: UnsureJoins;
}
export type UnsureJoins = "ask" | "cut";
const CROSSES_SCOPE = "The measured edge would cross the selected range or footage marked to keep. The requested edges are staged for review.";

/** The removals whose ranges meet a disputed stretch: those either side of a piece it keeps, or those inside a join. */
const owners = (removals: ResolvedCut[], at: TimeRange) =>
  removals.filter(c => c.start <= at.end + 0.05 && c.end >= at.start - 0.05).map(c => c.input);
const phrase = (s: string) => s.trim().split(/\s+/u).map(normalizeTranscriptToken).join(" ");
const r2 = (t: number) => Math.round(t * 100) / 100;

type DisputedEdge = Extract<DialoguePlan, { outcome: "needsRevision" }>["disputedEdges"][number];

/**
 * A batch as dialogue_apply_cuts saves it, shared with offline replay. A dispute names the cuts whose edges make it,
 * and the rest of the batch is saved without them, so a pass resubmits only what was disputed instead of the whole
 * batch: a refused batch cost a pass a turn and every cut again, five to seven times a pass (2026-11-16). A cut Scarlet
 * could not place is named before any edge is measured, so the rest can raise a dispute of its own once it is set
 * aside. Each round sets aside what the last one named.
 */
export async function planDialogueBatch(req: DialoguePlanRequest, sources: DialoguePlanSources): Promise<{ plan: DialoguePlan; setAside?: { cuts: number[]; disputedEdges: DisputedEdge[] } }> {
  const plan = await planDialogueCuts(req, sources);
  if (plan.outcome !== "needsRevision") return { plan };
  const disputed = new Set<number>(), edges = [...plan.disputedEdges];
  let rest: DialoguePlan | undefined = plan;
  for (let round = 0; round < 3 && rest?.outcome === "needsRevision"; round++) {
    const named: number[] = rest.disputedEdges.flatMap(d => d.cuts).filter(i => !disputed.has(i));
    if (round) edges.push(...rest.disputedEdges);
    for (const i of named) disputed.add(i);
    rest = named.length && req.cuts.some((c, i) => !disputed.has(i) && c.decision !== "keep" && c.picture !== "protect")
      ? await planDialogueCuts({ ...req, setAside: disputed }, sources).catch(() => undefined) : undefined;
  }
  return rest?.outcome === "ready" ? { plan: rest, setAside: { cuts: [...disputed].sort((a, b) => a - b), disputedEdges: edges } } : { plan };
}

/** Everything dialogue_apply_cuts decides before it sends the plan to the engine. Throws on an invalid plan. */
export async function planDialogueCuts(req: DialoguePlanRequest, sources: DialoguePlanSources): Promise<DialoguePlan> {
  const { tl, cuts: requested, range, only, localPauses } = req;
  const otherKinds = [...new Set(requested.filter(c => c.kind !== "pause").map(c => c.kind))];
  if (localPauses && ((only && only !== "pause") || otherKinds.length))
    throw new Error(`The editor requested only pauses in the local passage (/tighten-pauses-here). Remove the ${otherKinds.join(" and ") || only} decisions.`);
  if (only && requested.some(c => c.kind !== only)) throw new Error(`only is "${only}", so every decision must be kind "${only}".`);
  // Word references become timeline seconds first; everything after is the same plan.
  const unplaced: Array<{ reason: string; cuts: number[] }> = [];
  const duration = timelineDuration(tl);
  const resolvedCuts = (await Promise.all(requested.map(async (c, i): Promise<ResolvedCut | undefined> => {
    // A cut set aside is not in this plan, so it is not placed again either.
    if (req.setAside?.has(i)) return undefined;
    const { occurrence: _occurrence, mediaId: _m, fromWord: _f, toWord: _t, afterWord, leave: _l, voiceIn: _v, ...rest } = c;
    if (afterWord !== undefined && c.kind !== "pause") throw new Error(`cuts[${i}]: afterWord names a pause. Give a ${c.kind} as its removed words or in seconds.`);
    const resolved = await resolveCutRange(tl, c, `cuts[${i}]`, sources, false, duration).catch(err => {
      // A pause with nothing to trim is a finding about that pause alone, as a cut that can't be placed is: beside
      // other cuts it is set aside with its reason and they save. Asked for on its own it is still refused, which is
      // how a caller placing one pause learns to leave the recording playing there (first-cut-ranges.ts).
      const noTrim = err instanceof NoPauseToTrim && requested.some((_, k) => k !== i && !req.setAside?.has(k));
      if (!(err instanceof CutNotPlaced) && !noTrim) throw err;
      unplaced.push({ reason: `cuts[${i}]: ${err.message}${noTrim ? " It was left out of this save; the other cuts are unaffected." : ""}`, cuts: [i] });
    });
    if (!resolved) return undefined;
    // A pause is quiet, and trimming one takes out quiet. Sound at speaking level in it is words the transcript missed
    // or mistimed, and whether they stay is a decision about words, which nobody made by asking for a shorter pause.
    // Applied with a note, as it once was, a trim after “Opus” took out the “5.5” of “Opus 5.5” (2026-11-16).
    if ("holdsSound" in resolved && resolved.holdsSound) {
      unplaced.push({ reason: `cuts[${i}]: ${resolved.notes.join(" ")} A pause trim removes quiet only, so this one was not saved.` +
        (resolved.heard ? ` ${resolved.heard} Decide on those words as you would on any: a take said again is a retake to cut, ` +
          `and words that belong play as they are.` : ` Nothing more could be read from it.`) +
        ` To remove sound there, give the range in timeline seconds as the kind of cut it is.`, cuts: [i] });
      return undefined;
    }
    // A pause given in seconds is read for what it holds, as one named by its word is.
    if (c.kind === "pause" && c.decision !== "keep" && c.picture !== "protect" && afterWord === undefined && c.mediaId === undefined) {
      const holds = await secondsPauseHolds(tl, resolved, sources);
      if (holds.length) {
        unplaced.push({ reason: `cuts[${i}]: ${holds.join(" ")} A pause trim removes quiet only, so this one was not saved. Decide on those words as you would ` +
          `on any: a take said again is a retake to cut, and words that belong play as they are. To remove them with the wait, give the range as the kind of cut it is.`, cuts: [i] });
        return undefined;
      }
    }
    // A word range whose edges found no measured quiet goes to the editor. When the same words play from another
    // saying of them with quiet at both edges, the agent can pick that one and the cut can apply as decided: on one
    // pass, two of eight such held cuts had one.
    const clean = c.mediaId !== undefined && c.fromWord !== undefined && c.toWord !== undefined && "problems" in resolved && resolved.problems.length
      ? await resolveWordCut(tl, { mediaId: c.mediaId, fromWord: c.fromWord, toWord: c.toWord }, sources, true)
        .then(r => ("alternativeWordRanges" in r ? r.alternativeWordRanges ?? [] : []).filter(a => !a.problems.length)).catch(() => [])
      : [];
    return { ...rest, start: resolved.start, end: resolved.end, input: i, ...("air" in resolved && resolved.air && { air: resolved.air }),
      ...(clean.length && { cleanAlternatives: clean.map(a => ({ fromWord: a.fromWord, toWord: a.toWord })) }),
      ...("wordRef" in resolved && { words: resolved.words, wordEdgeProblems: resolved.problems,
        ...("spoken" in resolved && { spoken: resolved.spoken, wordEdgeDips: resolved.dips }), ...("notes" in resolved && { notes: resolved.notes }) }) };
  }))).filter(c => c !== undefined);
  // Named before anything else is checked, so the caller can set these aside and plan the rest.
  if (unplaced.length) return { outcome: "needsRevision", disputedEdges: unplaced.sort((a, b) => a.cuts[0]! - b.cuts[0]!) };
  const cuts = resolvedCuts;
  const scope = cutScope(tl, req.anchor, range, localPauses);
  for (const c of cuts) {
    if (!c.spoken || c.spoken.start < scope.start || c.spoken.end > scope.end) continue;
    if (c.start < scope.start || c.end > scope.end) {
      c.start = Math.max(c.start, scope.start);
      c.end = Math.min(c.end, scope.end);
      c.wordEdgeProblems = [...(c.wordEdgeProblems ?? []), "The selected range bounds the silence beside the named words. Check the edge at the selection."];
    }
  }
  const outside = cuts.filter(c => c.start < scope.start || c.end > scope.end);
  if (outside.length) throw new Error(`cuts ${outside.map(c => c.input).join(", ")} fall outside the range ${scope.start}–${scope.end} s.`);
  // A range given as words has its edges placed by Scarlet in the silence beside the words. When the agent decides
  // that silence in the range next to it, as a pause cut before a retake, the placed edge lands inside that range
  // and the plan used to be refused: once or twice on most passes, a turn each. The placed edge gives way to the
  // range beside it, and the gate says so. The words themselves reaching into another range is still the agent's overlap to fix.
  for (const placed of cuts) {
    if (!placed.spoken) continue;
    for (const other of cuts) {
      if (other === placed || other.end <= placed.start || other.start >= placed.end) continue;
      const edge = other.end <= placed.spoken.start + 1e-6 ? "start" : other.start >= placed.spoken.end - 1e-6 ? "end" : undefined;
      if (!edge) continue;
      const was = placed[edge];
      placed[edge] = edge === "start" ? Math.max(placed.start, other.end) : Math.min(placed.end, other.start);
      if (Math.abs(placed[edge] - was) > 1e-6) placed.notes = [...(placed.notes ?? []),
        `Scarlet placed its ${edge} at ${r2(was)} s, inside cut ${other.input}; it moved to ${r2(placed[edge])} s to meet that cut.`];
    }
  }
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  // Say which range and where it landed: a range given as words is placed by Scarlet, so the agent can't see that it
  // reached into the one beside it, and "cuts 1" alone cost a pass three tries.
  const placed = (c: ResolvedCut) => `cut ${c.input} (${c.words ? "words placed at " : ""}${r2(c.start)}–${r2(c.end)} s)`;
  const bad = sorted.flatMap((c, i) => c.end <= c.start ? [`${placed(c)} is empty`]
    : c.end > duration ? [`${placed(c)} runs past the edit's end at ${duration.toFixed(2)} s`]
    : i && sorted[i - 1]!.end > c.start ? [`${placed(c)} overlaps ${placed(sorted[i - 1]!)}`] : []);
  if (bad.length) throw new Error(`${bad.join("; ")}. Submit distinct nonoverlapping ranges, protected ranges included.`);
  const removals = sorted.filter(c => c.decision !== "keep" && c.picture !== "protect");
  const kept = sorted.filter(c => c.decision === "keep" || c.picture === "protect").map(({ start, end }) => ({ start, end }));
  if (!removals.length) return { outcome: "preserved", kept };

  // Quotes are opt-in assertions about the exact cut the agent submitted.
  // Return conflicts to the caller before writing any part of the plan.
  const quoted = removals.filter(c => c.decision === "cut" &&
    ((c.kind === "retake" && c.resumeWith) || (c.kind === "coaching" && c.productionQuote)));
  const project = await sources.project();
  if (quoted.length) {
    const disputedEdges = quoted.flatMap(c => {
      let reason: string | undefined;
      if (c.kind === "coaching" && c.productionQuote) {
        reason = sources.evidence.checkProductionQuote(c, c.productionQuote, tl, project);
      } else if (c.resumeWith) {
        const result = checkResumeQuote(tl, project, c.end, sources.evidence.scans, c.resumeWith);
        if (result === "different") reason = "The surviving dialogue starts with different words than the supplied quote.";
        if (result === "unverified") reason = "The scan cannot confirm the supplied quote here.";
      }
      return reason ? [{ start: c.start, end: c.end, reason, cuts: [c.input] }] : [];
    });
    if (disputedEdges.length) return { outcome: "needsRevision", disputedEdges };
  }
  // The recording decides where each edge sits. Word timings only name the words.
  const checkRetakes = !only || only === "retake";
  // Every removal's edges are measured. A production aside given in seconds without its quote used to skip the check
  // and apply as typed: one ended between "this game" and "let me", in continuous speech (2026-11-15).
  if (removals.length) await sources.measure(audibleSourcePoints(tl, removals.flatMap(c => [c.start, c.end])));
  // Every change Scarlet makes to the plan goes back to the agent with its evidence.
  const report: GateLine[] = [];
  const checkJoin = dialogueJoinChecker(tl, project, sources.pages(), sources.pace);
  // An edge Scarlet could not move out of sound. The held cut is the model's to settle: an edge inside a word that is
  // sounding there is never applied as placed, and dialogue_review_save neither asks the editor about it nor cuts it
  // there. Of eighteen calls one pass handed the editor, fifteen were held this way, asked about as "listen for the end
  // of …", and most were a word or a few frames off (2026-11-16).
  const inSound = new Map<number, { reason: string; inWord: boolean }>();
  /** Cuts whose join Scarlet placed without a measurement that says it plays clean: the editor's to hear. */
  const unheard = new Set<number>();
  const decisions = removals.map(c => {
    const decided: PlannedDecision = { start: c.start, end: c.end, reason: c.reason, review: c.decision === "review", kind: c.kind,
      originalRange: undefined, ...(c.check && { check: c.check }), ...(c.summary && { summary: c.summary }) };
    const adjust = (next: PlannedDecision, found: string) => {
      const reach = next.originalRange ?? next;
      if (reach.start < scope.start || reach.end > scope.end || kept.some(k => reach.start < k.end && reach.end > k.start)) {
        const evidence = CROSSES_SCOPE;
        next = { ...decided, review: true, held: evidence };
        found = `The measured range is ${r2(reach.start)}–${r2(reach.end)} s. ${evidence}`;
      }
      const moved = Math.abs(next.start - c.start) > 1e-6 || Math.abs(next.end - c.end) > 1e-6;
      report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: next.review ? "review" : "cut",
        range: [r2(next.start), r2(next.end)], ...(moved && { from: [r2(c.start), r2(c.end)] }), evidence: found });
      return next;
    };
    // A restart that begins on the word the first take broke off after, with no pause for the cut to start in: the
    // cut starts where that word begins, found by matching it to the retake's, and waits for the editor, since
    // nothing here can hear the join (sameWordJoin). A cut already there waits the same way.
    const same = c.kind === "retake" && c.decision !== "keep" ? checkJoin({ start: c.start, end: c.end }, c.spoken, c.air) : undefined;
    const offered = same?.sameWordJoin, said = offered && "“" + offered.word + "”";
    // Said of the cut as saved: the check's own words offer the seconds, and a pass sent the cut again on them.
    const placed = same?.sameWord ? { start: same.start, end: same.end, reason: same.reason ?? "" } : offered && { start: offered.start, end: offered.end,
      reason: `Staged from ${r2(offered.start)} s, where the first ${said} begins: the word before runs into it with no pause, so Scarlet found its start by matching it to the second ${said} on their sound` +
        `${offered.takesFirst ? `, and took out the first ${said} too, which the range as given left playing twice` : ""}. No kept word is cut as measured. ` +
        "Scarlet can't hear the join and neither can you, so it waits for the editor as a call: record ask on it. Nothing else is needed on this cut." };
    if (placed) {
      unheard.add(c.input);
      inSound.set(c.input, { inWord: false, reason: placed.reason });
      return adjust({ ...decided, start: placed.start, end: placed.end, review: true, held: placed.reason, unheard: true }, placed.reason);
    }
    // Word edges without measured silence fall back to word timings, which is not a confident edge.
    const fallback = c.wordEdgeProblems?.length && !decided.review
      ? { review: true, held: c.wordEdgeProblems.join(" ") } : undefined;
    const alternatives = c.cleanAlternatives?.map(a => `#${a.fromWord}–#${a.toWord}`).join(", ");
    const base = fallback ? adjust({ ...decided, ...fallback }, [...c.wordEdgeProblems!, ...(alternatives
      ? [`Words ${alternatives} leave the same words playing and have measured quiet at both edges.`] : [])].join(" ")) : decided;
    // Removed words whose two edges Scarlet placed itself, in the measured silence beside them or at the dip between
    // two words that run together, are not checked a second time: that check takes a brief dip for speech and held
    // every cut of a doubled word for the editor. What was measured at a dip goes back to the agent.
    if (c.spoken && !c.wordEdgeProblems?.length) return c.wordEdgeDips?.length ? adjust(decided, c.wordEdgeDips.join(" ")) : base;
    const join = checkJoin({ start: c.start, end: c.end }, c.spoken, c.air);
    // Without a measurement at the edge there is nothing to act on. The agent's own evidence stands.
    if (join.unmeasured) return base;
    // An edge left in sound: what Scarlet measured goes with the held cut, for the model's review. Named words say what
    // goes, so the quiet or low points that keep or take another word are no help there; a pass offered them resent
    // cuts that broke the sentence (2026-11-16).
    // A pause too: it is quiet from end to end, and one whose edge stays in sound was typed into speech. Applied as
    // typed, a pause given in seconds kept an edge inside a word (found reviewing the planner, 2026-11-20).
    if (join.inSound?.length) {
      const named = c.words !== undefined && c.kind !== "pause" && !join.inWord?.length;
      inSound.set(c.input, { inWord: !!join.inWord?.length, reason: named
        ? `The words named run on into the ones beside them at the ${join.inSound.join(" and ")}: no pause or low point where they part, a join in running speech.`
        : join.reason ?? "" });
    }
    // Both edges in quiet: one whose frame would round onto sound goes on a quiet frame, which the engine's rounding
    // keeps. A move of under a frame that would meet a neighbor, the selection's edge or footage marked to keep stays.
    if (join.status === "unchanged") {
      const i = sorted.indexOf(c), frame = 1 / project.settings.fps;
      const start = (!i || sorted[i-1]!.end <= join.start - frame) && join.start >= scope.start && !kept.some(k => k.end > join.start && k.end <= c.start) ? join.start : c.start;
      const end = (i === sorted.length - 1 || join.end + frame <= sorted[i+1]!.start) && join.end <= scope.end && !kept.some(k => k.start < join.end && k.start >= c.end) ? join.end : c.end;
      // An edge Scarlet moved is reported with what it measured, as every other move is.
      const moved = end > start ? quietFrameNote(c, { start, end }) : undefined;
      return moved ? adjust({ ...base, start, end }, moved) : base;
    }
    // A pause is quiet from end to end, so one whose edge is on sound was placed from a word's timing, which often
    // starts a tenth of a second after the word does. Its edges go onto the measured quiet beside them: that keeps
    // the word and leaves a little more air, so it stays the cut the agent decided. An edge with no quiet in reach
    // stays where the agent put it, and so does a pause whose move would reach into the range beside it.
    if (c.kind === "pause" && !join.inSound?.length) {
      const i = sorted.indexOf(c), frame = 1 / project.settings.fps + 1e-6;
      const removed = (n?: ResolvedCut) => n && n.decision !== "keep" && n.picture !== "protect" ? n : undefined;
      const before = removed(sorted[i-1]), after = removed(sorted[i+1]);
      // An edge that meets the removal beside it stays with it: moved inward it would leave a few frames of picture between the two.
      const start = before && c.start - before.end <= frame ? c.start : join.start;
      const end = after && after.start - c.end <= frame ? c.end : join.end;
      const clear = (!i || sorted[i-1]!.end <= start) && (i === sorted.length - 1 || end <= sorted[i+1]!.start);
      const moved = (join.status === "snapped" || join.status === "adjusted" || join.status === "partial") && (start !== c.start || end !== c.end);
      return moved && clear && end - start > 1e-6 ? adjust({ ...base, start, end },
        (join.reason ?? "").replace("Adjusted retake boundaries", "Moved the pause's edges onto the recording's quiet").replace(" Preview the join in context.", "")) : base;
    }
    // A few frames onto measured silence keeps every word. Apply it as decided unless it would meet a neighbor.
    const i = sorted.indexOf(c);
    if (join.status === "snapped" && (!i || sorted[i-1]!.end <= join.start) && (i === sorted.length - 1 || join.end <= sorted[i+1]!.start))
      return adjust({ ...base, start: join.start, end: join.end }, join.reason ?? "");
    if (join.status === "snapped") return adjust({ ...base, review: true, held: "The nearest silence at an edge overlaps the neighboring range." },
      "The nearest silence at an edge overlaps the neighboring range.");
    // A production aside keeps its verified quote range. Without measured silence at its edges it waits for audition.
    if (c.kind === "coaching") return adjust({ ...base, review: true, held: join.reason ?? "No measured silence at an edge of this production aside." }, join.reason ?? "");
    // The editor can restore the whole proposal. An edge may also move outward into a pause, so the range covers both.
    return adjust({ ...base, start: join.start, end: join.end, review: true,
      originalRange: join.status === "adjusted" || join.status === "partial"
        ? { start: Math.min(c.start, join.start), end: Math.max(c.end, join.end) } : undefined,
      ...(join.reason && { held: join.reason }) }, join.reason ?? "");
  });
  // What a held edge left in sound plays, with what was measured there, for the model's review: the join as placed,
  // and the passage as it plays if the cut is kept instead.
  await Promise.all(removals.map(async (c, i) => {
    const found = inSound.get(c.input), d = decisions[i]!;
    if (!found || !d.review) return;
    const range = { start: d.start, end: d.end };
    const heard = await timelineWordsNear(tl, project, range, mediaId => sources.words(mediaId, undefined, false), 6);
    const plays = joinText(heard, range), kept = keptText(heard, range);
    d.held = [found.reason, plays && `As placed the join plays “${plays}”.`, kept && `Kept, it plays “${kept}”.`]
      .filter(Boolean).join(" ").slice(0, 800);
  }));
  // A cut the model decided that Scarlet held only for how its join measured applies as placed when the model said
  // so. A hold for the selection or footage marked to keep stays: that is the editor's, not a measurement. So does an
  // edge inside a word that is sounding there: offered the way round, one pass sent 21 of its 33 saves with
  // unsureJoins cut and applied ten such edges (2026-11-16).
  if (req.unsureJoins === "cut") decisions.forEach((d, i) => {
    const c = removals[i]!;
    if (c.decision !== "cut" || !d.review || !d.held || d.held === CROSSES_SCOPE || inSound.get(c.input)?.inWord || unheard.has(c.input)) return;
    decisions[i] = { ...d, review: false, held: undefined, originalRange: undefined, appliedAsPlaced: true };
    const line = report.findLast(l => l.cut === c.input);
    if (line) Object.assign(line, { outcome: "cut", evidence: `Applied as placed, as unsureJoins asked: ${line.evidence}` });
  });
  // The submitted ranges don't overlap, but an edge Scarlet moved can reach into the range beside it: two cuts that
  // meet at one instant, and the first one's end moved out into the pause the second removes. The engine rejects
  // overlapping ranges, and the agent can't see which edge moved. Hold each moved edge at its neighbor instead:
  // both stretches are decided either way, so nothing more or less comes out.
  for (let i = 1; i < decisions.length; i++) {
    const before = decisions[i - 1]!, after = decisions[i]!;
    const asked = { before: removals[i - 1]!, after: removals[i]! };
    const reach = (d: PlannedDecision) => ({ start: Math.min(d.start, d.originalRange?.start ?? d.start), end: Math.max(d.end, d.originalRange?.end ?? d.end) });
    if (reach(before).end <= reach(after).start + 1e-9) continue;
    // Somewhere between where the agent ended the first range and began the second, preferring the second's own start.
    const meet = Math.min(Math.max(after.start, asked.before.end), asked.after.start);
    const held = (d: PlannedDecision, c: ResolvedCut, range: TimeRange) => {
      const moved = Math.abs(range.start - d.start) > 1e-9 || Math.abs(range.end - d.end) > 1e-9;
      // An adjustment that leaves nothing of the range falls back to the range as asked, held for the agent's closer
      // look with what Scarlet measured, as every other cut it can't place is.
      const next: PlannedDecision = range.end - range.start > 1e-9 ? { ...d, ...range } : { ...d, start: c.start, end: c.end, review: true,
        ...(!d.review && { held: `Its edges as measured meet the neighboring range at ${r2(meet)} s, which leaves nothing of it to remove.` }) };
      const original = d.originalRange && { start: Math.max(d.originalRange.start, d === before ? -Infinity : meet), end: Math.min(d.originalRange.end, d === before ? meet : Infinity) };
      next.originalRange = original && original.end > original.start ? original : undefined;
      if (moved || next.review !== d.review) report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: next.review ? "review" : "cut",
        range: [r2(next.start), r2(next.end)], from: [r2(c.start), r2(c.end)], evidence: `Held at the neighboring range at ${r2(meet)} s.` });
      return next;
    };
    decisions[i - 1] = held(before, asked.before, { start: before.start, end: Math.min(before.end, meet) });
    decisions[i] = held(after, asked.after, { start: Math.max(after.start, meet), end: after.end });
  }
  // A removal that stops a few frames short of a join an earlier save made leaves those frames playing between the
  // two, a flash of picture and a blip of sound: one pass left four of 1-3 frames, each where a cut given in seconds
  // ended or began just beside an earlier one (2026-11-16). The edge goes on to the join, and the gate says so.
  const joinsHere = versionJoins(tl);
  decisions.forEach((d, i) => {
    if (d.review) return;
    const c = removals[i]!;
    for (const side of ["start", "end"] as const) {
      const at = d[side];
      const join = joinsHere.find(t => side === "end" ? t > at + 1e-6 && t - at < SLIVER_SECONDS : t < at - 1e-6 && at - t < SLIVER_SECONDS);
      if (join === undefined || join < scope.start - 1e-6 || join > scope.end + 1e-6) continue;
      const reach = side === "end" ? { start: at, end: join } : { start: join, end: at };
      if (kept.some(k => k.start < reach.end - 1e-9 && k.end > reach.start + 1e-9)) continue;
      if (decisions.some((o, k) => k !== i && o.start < reach.end - 1e-9 && o.end > reach.start + 1e-9)) continue;
      d[side] = join;
      report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: "cut", range: [r2(d.start), r2(d.end)],
        evidence: `The ${side} met the join at ${r2(join)} s: the ${Math.round(Math.abs(join - at) * 1000)} ms between would have played as a flash between two cuts.` });
    }
  });
  const { media, settings: { fps } } = project;
  const retained = sorted.filter(c => c.decision === "keep" || c.picture === "protect");
  const unreadJoinAudio: Array<{ cut: number; reasons: string[] }> = [];
  const applied = mergeRanges(decisions.filter(d => !d.review), 1e-9);
  const align = (r: TimeRange) => frameAlignedRemoval(r, fps, scope, kept);
  const appliedFrames = applied.map(align);
  const quiet = await quietKeptWords(tl, project, appliedFrames, [...kept, ...decisions.filter(d => d.review)], scope, sources);
  if (quiet.length) return { outcome: "needsRevision", disputedEdges: quiet.map(q => ({ ...q, cuts: owners(removals, q) })) };
  const speechCuts = removals.flatMap((c, i) => c.kind !== "pause" && c.decision === "cut" ? [{ c, d: decisions[i]! }] : []);
  // A pause trim joins the words either side of it. Where they are the same, the pause was the gap of a restart, and
  // the trim plays the word twice: "every single ‖ single pastry" and "equals B7 ‖ equals B7" were saved as pauses on
  // one pass, among twelve pause saves sent at once (2026-11-16). The transcript's words say so; nothing is decoded.
  const pauseCuts = req.localPauses ? [] : removals.flatMap((c, i) => c.kind === "pause" && c.decision === "cut" && !decisions[i]!.review ? [{ c, d: decisions[i]! }] : []);
  if ((speechCuts.length && checkRetakes) || pauseCuts.length) {
    const optional = mergeRanges(decisions.filter(d => d.review), 1e-9);
    const atAfter = (at: number, ranges: TimeRange[]) => at - ranges.reduce((removed, r) =>
      removed + Math.max(0, Math.min(at, r.end) - r.start), 0);
    const onApplied = optional.map(align).map(r => ({ start: atAfter(r.start, appliedFrames), end: atAfter(r.end, appliedFrames) }));
    const fade = (sources.crossfadeFrames ?? 0) / fps;
    let appliedTimeline: Timeline | undefined, stagedTimeline: Timeline | undefined;
    const appliedPreview = () => appliedTimeline ??= dialogueCutPreview(tl, media, appliedFrames, fade);
    const stagedPreview = () => stagedTimeline ??= dialogueCutPreview(appliedPreview(), media, mergeRanges(onApplied, 1e-9), fade);
    const pages = sources.pages();
    const selection = selectedRange(req.anchor) ? scope : undefined;
    const read = sources.readKeptWords;
    // The transcript words each recording plays, in transcript_get order, read once for every join of the plan.
    let transcriptsRead: Promise<Map<string, TranscriptWord[]>> | undefined;
    const transcripts = () => transcriptsRead ??= (async () => {
      const found = new Map<string, TranscriptWord[]>();
      await Promise.all([...new Set(audibleMediaClips(tl).map(c => c.mediaId))].map(async id => {
        const words = await sources.words(id, undefined, false).catch(() => null);
        if (words?.length) found.set(id, words);
      }));
      return found;
    })();
    const middle = (w: TimeRange) => (w.start + w.end) / 2;
    // What one applied join plays and takes out, as words: the ones it removes on this version, and the ones the
    // version with this part's cuts plays up to it and from it on.
    const joinWords = (said: Map<string, TranscriptWord[]>, range: TimeRange, at: number) => {
      const around = timelineWords(appliedPreview(), said, { start: at - JOIN_CONTEXT_SECONDS, end: at + JOIN_CONTEXT_SECONDS });
      return { before: around.filter(w => middle(w) < at).map(w => w.text), after: around.filter(w => middle(w) >= at).map(w => w.text),
        removed: timelineWords(tl, said, range).filter(w => middle(w) >= range.start && middle(w) < range.end).map(w => w.text) };
    };
    const wordsAtJoin = async (range: TimeRange, at: number) => {
      const said = await transcripts();
      return said.size ? joinWords(said, range, at) : undefined;
    };
    // The scan's own reading of each recording, page after page: each page gives the words past the last one taken.
    let scanReading: Map<string, TranscriptWord[]> | undefined;
    const scanned = () => {
      if (scanReading) return scanReading;
      scanReading = new Map();
      for (const page of sources.evidence.scans.filter(s => s.segments?.length).sort((a, b) => a.start - b.start)) {
        const list = scanReading.get(page.mediaId) ?? [];
        const from = list.at(-1)?.end ?? -Infinity;
        list.push(...page.segments!.flatMap(s => s.words).filter(w => w.text.trim() && (w.start + w.end) / 2 >= from).sort((a, b) => a.start - b.start));
        scanReading.set(page.mediaId, list);
      }
      return scanReading;
    };
    /**
     * The same join in the words the scan read, when its pages hold both of the join's edges. A transcript tidies a
     * restart away and times the words it keeps on whichever take it likes: of “which is funny because, which is, uh,
     * which is funny because as a company” it had one “which is” on the take before the last, so a cut that ended
     * right before the last take read as taking “which is” from it (2026-11-19).
     */
    const scanWordsAtJoin = (range: TimeRange, at: number) => {
      const reading = scanned();
      const held = (t: number) => audibleMediaClips(tl).some(c => {
        if (t < c.timelineIn || t >= c.timelineIn + clipDuration(c)) return false;
        const source = timelineToSource(c, t);
        return sources.evidence.scans.some(s => s.mediaId === c.mediaId && s.segments?.length && s.start <= source && source <= s.end);
      });
      return reading.size && held(Math.max(0, range.start - .5)) && held(Math.min(duration - 1e-3, range.end + .5)) ? joinWords(reading, range, at) : undefined;
    };
    // Existing doubled-word checks apply to the version that will actually be kept. A requested cut that
    // placement sends to review can still leave a partial repeat in its preview; return that to its author too.
    const jobs = [{ joins: applied, preview: appliedPreview, forReview: false }];
    if (read && speechCuts.some(({ d }) => d.review))
      jobs.push({ joins: mergeRanges(decisions, 1e-9), preview: stagedPreview, forReview: true });
    const issuesByJoin = await Promise.all(jobs.flatMap(({ joins, preview, forReview }) => {
      const played = joins.map(align);
      return joins.map(async (join, i) => {
        const contributing = checkRetakes ? speechCuts.filter(({ d }) => d.review === forReview && join.start <= d.start && d.end <= join.end) : [];
        const range = played[i]!;
        const previous = Math.max(played[i - 1]?.end ?? 0, selection?.start ?? 0);
        const next = Math.min(played[i + 1]?.start ?? duration, selection?.end ?? duration);
        if (!contributing.length) {
          const trims = forReview ? [] : pauseCuts.filter(({ d }) => join.start <= d.start && d.end <= join.end);
          if (!trims.length) return [];
          const { repeatAtJoin } = await checkKeptWords(tl, project, range, dialogueJoinWords(tl, project, range, pages), undefined, previous, next);
          const kept = trims.flatMap(({ c }) => c.keepRepeat ?? []).map(phrase);
          if (!repeatAtJoin || kept.includes(phrase(repeatAtJoin.words))) return [];
          const { before, after, words } = repeatAtJoin, cut = trims[0]!.c.input;
          return [{ ...range, cut, repeat: repeatAtJoin, cuts: trims.map(({ c }) => c.input),
            reason: `The pause trim plays “${words}” twice, at ${before.start}–${before.end} s before it and ${after.start}–${after.end} s after it: ` +
              `the pause was the gap of a restart. Remove the first saying with the pause (mediaId with fromWord/toWord). If both belong, include “${words}” in keepRepeat on cut ${cut}.` }];
        }
        const playback = { preview, at: atAfter(range.start, played), partialOnly: forReview };
        const { repeatAtJoin, partialWordRepeat, pickupRepeats, unread } = await checkKeptWords(tl, project, range,
          dialogueJoinWords(tl, project, range, pages), read, previous, next, playback);
        if (unread.length) unreadJoinAudio.push({ cut: contributing[0]!.c.input, reasons: unread });
        const acknowledged = contributing.flatMap(({ c }) => c.keepRepeat ?? []).map(phrase);
        const issues = [];
        if (!forReview && repeatAtJoin && acknowledged.includes(phrase(repeatAtJoin.words))) kept.push(repeatAtJoin.before, repeatAtJoin.after);
        if (!forReview && repeatAtJoin && !acknowledged.includes(phrase(repeatAtJoin.words))) {
          const { before, after, words } = repeatAtJoin;
          issues.push({ cut: contributing[0]!.c.input, repeat: repeatAtJoin, words, reason: `The join plays “${words}” twice, at ${before.start}–${before.end} s before the cut and ${after.start}–${after.end} s after it.` });
        }
        for (const pickup of forReview ? [] : pickupRepeats) {
          const { first, second, side, words } = pickup;
          if (acknowledged.includes(phrase(words))) { kept.push(first, second); continue; }
          if (retained.some(r => r.start < second.end && first.start < r.end)) continue;
          const cut = (side === "start" ? contributing[0] : contributing.at(-1))!.c.input;
          issues.push({ cut, pickup, words, reason: `The kept take ${side === "end" ? "starts" : "ends"} with “${words}” twice, at ${first.start}–${first.end} s and ${second.start}–${second.end} s.` });
        }
        if (partialWordRepeat && !acknowledged.includes(phrase(partialWordRepeat.word))) {
          const { heard, word, side } = partialWordRepeat;
          const target = side === "start" ? contributing[0]! : contributing.at(-1)!;
          // Only the cut responsible for this outside edge can repair it. A neighbor may have been staged explicitly.
          if (side === "start" ? target.d.start === join.start : target.d.end === join.end)
            issues.push({ cut: target.c.input, partialWordRepeat, words: word,
              reason: `The ${side === "start" ? "outgoing" : "incoming"} audio plays “${heard}” from a cut-off “${word}” beside another “${word}”.` });
        }
        // A restart cut that runs past the restart takes words the sentence needs, and nothing at the join says them
        // again. Only a tool that takes removals can say they go on purpose (dropWords).
        const said = forReview || req.repeatHint ? undefined : await wordsAtJoin(range, playback.at);
        const dropped = contributing.flatMap(({ c }) => c.dropWords ?? []).map(phrase);
        const joinPlays = said && `…${said.before.slice(-EDGE_WORDS_SHOWN).join(" ")} ‖ ${said.after.slice(0, EDGE_WORDS_SHOWN).join(" ")}…`;
        // An overshoot the transcript shows and the scan's reading of the same join doesn't is the transcript's tidying.
        const asScanned = said ? scanWordsAtJoin(range, playback.at) : undefined;
        const alsoRead = asScanned && new Set(edgeOvershoots(asScanned.before, asScanned.removed, asScanned.after).map(o => o.side));
        for (const { side, words } of said ? edgeOvershoots(said.before, said.removed, said.after) : []) {
          if (dropped.includes(phrase(words)) || (alsoRead && !alsoRead.has(side))) continue;
          const target = side === "out" ? contributing[0]! : contributing.at(-1)!;
          if (side === "out" ? target.d.start !== join.start : target.d.end !== join.end) continue;
          const them = words.includes(" ") ? "them" : "it";
          issues.push({ cut: target.c.input, takenWords: { side, words }, words, joinPlays,
            reason: `The join would play “${joinPlays}”: the cut takes “${words}” ${side === "out"
              ? "from the end of what plays before it" : "from the start of the take it resumes with"}, and nothing either side of the join says ${them} again.`,
            hint: `If the restart ${side === "out" ? "starts after" : "ends before"} “${words}”, move that edge of the removal off ${them}. If “${words}” should go, include it in dropWords on cut ${target.c.input}.` });
        }
        return issues.map(({ cut, words, reason, hint, ...evidence }: { cut: number; words: string; reason: string; hint?: string } & Record<string, unknown>) =>
          ({ ...range, cut, ...evidence, cuts: contributing.map(({ c }) => c.input),
            reason: reason + " " + (hint ?? req.repeatHint ?? `Include one occurrence in the removal using word indices or new edges. If both belong, include “${words}” in keepRepeat on cut ${cut}.`) }));
      });
    }));
    const disputedEdges = issuesByJoin.flat();
    if (disputedEdges.length) return { outcome: "needsRevision", disputedEdges };
  }
  // An applied cut whose edge sits right beside the sound it removes is reported to the agent: the picture can show a
  // word starting that the sound has not reached yet. It is evidence, not a flag. Whether the join needs the editor is
  // the agent's call, made with its own `check` or `edit_flag`: flagging every such join sent 13 of 81 cuts to the
  // editor on one pass (2026-11-14). Edges with no reading there are not reported.
  // A pause takes out a wait, and what sounds in it goes with it; this is about the words a cut takes out.
  const near = SPEECH_BESIDE_EDGE;
  const edgePages = sources.pages();
  removals.forEach((c, i) => {
    const d = decisions[i]!;
    if (d.review || d.check || c.kind === "pause") return;
    const close: string[] = [];
    for (const [at, side] of [[d.start, "out"], [d.end, "in"]] as const) {
      // The clip that plays the removed side: from the start onward, and up to the end. At a clip's edge the end's is
      // the clip that ends there, not the kept one that starts there.
      for (const { clip, track } of clipsAt(tl, side === "out" ? at : Math.max(d.start, at - 1e-6))) {
        if (clip.kind !== "media" || track.muted || !clip.enabled || !clip.volume || track.kind === "caption") continue;
        const asset = media.find(m => m.id === clip.mediaId);
        const stream = dialogueAudioStream(clip) ?? (asset && dialogueAudioStream(asset)) ?? 0;
        // Only what this clip plays of the removal: the recording before or after it isn't in the video.
        const speed = clip.speed ?? 1, inClip = side === "out" ? clip.timelineIn + clipDuration(clip) - at : at - clip.timelineIn;
        const gap = soundBesideEdge(edgePages, clip.mediaId, stream, timelineToSource(clip, at), side, Math.min(near, d.end - d.start, inClip) * speed);
        if (gap === undefined) continue;
        close.push(side === "out" ? `the removed sound starts ${gap.toFixed(2)} s after the cut` : `the removed sound ends ${gap.toFixed(2)} s before the join`);
        break;
      }
    }
    if (!close.length) return;
    report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: "cut",
      range: [r2(d.start), r2(d.end)], evidence: `In the recording ${close.join(" and ")}, close enough for the picture to show it. The cut applies as decided.` });
  });
  removals.forEach((c, i) => {
    const d = decisions[i]!;
    if (c.notes?.length) report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: d.review ? "review" : "cut",
      range: [r2(d.start), r2(d.end)], evidence: c.notes.join(" ") });
  });
  // A retake placed by seconds and applied without a hold is reported with what it takes out and what its join plays.
  // A word reference names its words; seconds don't, and a range meant for the first take can sit on the pause after
  // it or on the retake itself.
  await Promise.all(removals.map(async (c, i) => {
    const d = decisions[i]!;
    if (d.review || c.kind !== "retake" || c.decision !== "cut" || c.words !== undefined) return;
    const heard = await cutReading(tl, project, d, mediaId => sources.words(mediaId, undefined, false));
    if (heard.plays) report.push({ cut: c.input, kind: c.kind, asked: c.decision, outcome: "cut", range: [r2(d.start), r2(d.end)], removes: heard.removes ?? "", plays: heard.plays });
  }));
  // One line per submitted range: a later adjustment replaces an earlier one, keeping both reasons.
  const gate = new Map<number, GateLine>();
  for (const line of report) {
    const prior = gate.get(line.cut);
    gate.set(line.cut, prior ? { ...prior, ...line, evidence: [prior.evidence, line.evidence].filter(Boolean).join(" ") } : line);
  }
  for (const c of removals) if (c.words && !gate.has(c.input)) {
    const d = decisions[removals.indexOf(c)]!;
    gate.set(c.input, { cut: c.input, kind: c.kind, words: c.words, asked: c.decision, outcome: d.review ? "review" : "cut", range: [r2(d.start), r2(d.end)] });
  }
  return { outcome: "ready", removals, decisions, gate, kept,
    ...(unreadJoinAudio.length && { unreadJoinAudio: unreadJoinAudio.sort((a, b) => a.cut - b.cut) }) };
}

/** Summarize measured adjustments in the order the model submitted its decisions. */
export function dialogueGate(plan: Extract<DialoguePlan, { outcome: "ready" }>) {
  const report = [...plan.gate.values()].sort((a, b) => a.cut - b.cut);
  return { unchangedCuts: plan.removals.length - report.length, decisions: report };
}

/** The transcript words the edit plays within `reach` seconds of a range, and inside it, in playback order. */
export async function timelineWordsNear(tl: Timeline, project: Pick<Project, "media">, range: TimeRange,
  words: (mediaId: string) => Promise<readonly TranscriptWord[] | null>, reach: number) {
  const heard: Array<{ at: number; text: string }> = [];
  for (const clip of audibleMediaClips(tl)) {
    const lo = clip.timelineIn, hi = lo + clipDuration(clip);
    if (hi <= range.start - reach || lo >= range.end + reach) continue;
    if (!project.media.some(m => m.id === clip.mediaId && (m.kind === "audio" || m.hasAudio))) continue;
    for (const w of await words(clip.mediaId).catch(() => null) ?? []) {
      const middle = (w.start + w.end) / 2;
      if (middle < clip.sourceIn || middle >= clip.sourceOut || !w.text.trim()) continue;
      const at = lo + (middle - clip.sourceIn) / (clip.speed ?? 1);
      if (at < range.start - reach || at > range.end + reach) continue;
      // The same recording on two tracks plays each word once.
      if (!heard.some(h => Math.abs(h.at - at) < 1e-3 && h.text === w.text.trim())) heard.push({ at, text: w.text.trim() });
    }
  }
  return heard.sort((a, b) => a.at - b.at);
}

/**
 * The transcript words a join plays either side of a removal, as the viewer hears them: the last few kept before it,
 * ‖ for the cut, and the first few kept after it, across whichever clips play them. A cut that took "it a very simple"
 * out of "I gave it a very simple prompt" read as a restart in the transcript; this is what it plays: "I gave ‖
 * prompt" (2026-11-16).
 */
export async function joinPlays(tl: Timeline, project: Pick<Project, "media">, range: TimeRange,
  words: (mediaId: string) => Promise<readonly TranscriptWord[] | null>, count = 6) {
  return joinText(await timelineWordsNear(tl, project, range, words, 6), range, count);
}

type Heard = ReadonlyArray<{ at: number; text: string }>;

/**
 * What a removal takes out and what its join then plays, as the viewer hears them. A revision placed by seconds on the
 * only span with quiet at both edges took out the whole retake "where you would" and kept the broken first take: the
 * result listed the words at each edge, and nothing said the line now played "a time where would ‖ occasionally see"
 * (2026-11-17).
 */
export async function cutReading(tl: Timeline, project: Pick<Project, "media">, range: TimeRange,
  words: (mediaId: string) => Promise<readonly TranscriptWord[] | null>, inside = 16) {
  const heard = await timelineWordsNear(tl, project, range, words, 6);
  const removed = heard.filter(h => h.at > range.start && h.at < range.end).map(h => h.text);
  const removes = (removed.length > inside ? [...removed.slice(0, inside / 2), "…", ...removed.slice(-inside / 2)] : removed).join(" ");
  const plays = joinText(heard, range);
  return { ...(removes && { removes }), ...(plays && { plays }) };
}

function joinText(heard: Heard, range: TimeRange, count = 6) {
  const before = heard.filter(h => h.at <= range.start).slice(-count).map(h => h.text);
  const after = heard.filter(h => h.at >= range.end).slice(0, count).map(h => h.text);
  return before.length || after.length ? `${before.length ? "… " + before.join(" ") : ""} ‖ ${after.length ? after.join(" ") + " …" : ""}`.trim() : "";
}

/**
 * The words a removal plays if it is kept: a few either side and the ones it would take out, as the viewer hears them,
 * with the middle of a long passage elided. A held restart's note said only what its join would play, and a pass kept
 * "you can see the rough, you can see the shadows" rather than clip the release of "nice" (2026-11-17).
 */
export function keptText(heard: Heard, range: TimeRange, count = 3, inside = 16) {
  const removed = heard.filter(h => h.at > range.start && h.at < range.end).map(h => h.text);
  if (!removed.length) return "";
  const before = heard.filter(h => h.at <= range.start).slice(-count).map(h => h.text);
  const after = heard.filter(h => h.at >= range.end).slice(0, count).map(h => h.text);
  const middle = removed.length > inside ? [...removed.slice(0, inside / 2), "…", ...removed.slice(-inside / 2)] : removed;
  return `${before.length ? "… " : ""}${[...before, ...middle, ...after].join(" ")}${after.length ? " …" : ""}`;
}

/** How far from a staged cut, in timeline seconds, the words a call's note quotes may start. */
export const NOTE_QUOTE_REACH = 3;
/**
 * Phrases of two words or more a call's note quotes that neither start inside the cut nor within NOTE_QUOTE_REACH of
 * it, where the edit plays them. `heard` is the edit's words near the cut, in playback order. A note is the editor's
 * only account of a call: one pass's note on a cut of "it a very simple" told the editor to keep "the completed ‘is it
 * able to build’ question", a restart four seconds on (2026-11-16).
 */
export function quotesAwayFromCut(note: string, heard: ReadonlyArray<{ at: number; text: string }>, range: TimeRange, reach = NOTE_QUOTE_REACH) {
  const tokens = heard.map(h => ({ at: h.at, token: normalizeTranscriptToken(h.text) })).filter(t => t.token);
  const quoted = [...note.matchAll(/[‘“"]([^‘“"”]+?)[’”"](?=[\s.,;:!?)]|$)/gu)].map(m => m[1]!.trim());
  // What the cut leaves playing: a note that says what the join should sound like quotes words from both sides of
  // it, which are not next to each other until the cut is made. “Listen to ‘a time where you would’” was refused on a
  // cut that plays exactly that (2026-11-17).
  const played = tokens.filter(t => t.at <= range.start || t.at >= range.end);
  return quoted.filter(q => {
    const phrase = q.split(/\s+/u).map(normalizeTranscriptToken).filter(Boolean);
    if (phrase.length < 2) return false;
    return ![tokens, played].some(said => said.some((t, i) => t.at >= range.start - reach && t.at <= range.end + reach &&
      phrase.every((p, k) => said[i + k]?.token === p)));
  });
}

/** Footage shorter than this between two cuts plays as a flash, not as something seen or heard: about three frames. */
export const SLIVER_SECONDS = .1;
/** Timeline seconds where the footage an audible track plays jumps: the joins earlier cuts left on this version. */
export function versionJoins(tl: Timeline) {
  const joins = new Set<number>();
  for (const track of audibleClipsByTrack(tl)) {
    const clips = [...track].sort((a, b) => a.timelineIn - b.timelineIn);
    for (let k = 1; k < clips.length; k++) {
      const a = clips[k - 1]!, b = clips[k]!;
      // An audio crossfade overlaps the two clips by a frame or two around the cut, which is the overlap's middle: a cut
      // extended only to where the incoming clip's sound begins still left a frame of picture there (2026-11-16).
      const aEnd = a.timelineIn + clipDuration(a);
      if (Math.abs(aEnd - b.timelineIn) > .1) continue;
      if (a.mediaId === b.mediaId && Math.abs(a.sourceOut - b.sourceIn) < .01) continue;
      joins.add(round3(aEnd > b.timelineIn ? (aEnd + b.timelineIn) / 2 : b.timelineIn));
    }
  }
  return [...joins].sort((a, b) => a - b);
}

