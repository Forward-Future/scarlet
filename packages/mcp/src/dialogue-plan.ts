/**
 * The planning step of dialogue_apply_cuts, without I/O: resolve word references, validate the plan,
 * verify optional quotes, check every retake, filler and quoted production edge against the recording,
 * and record each change Scarlet makes for the agent's gate report. The MCP tool supplies live reads;
 * offline replay (evals/src/replay.ts) supplies stored ones, so both run the same code.
 */
import { normalizeTranscriptToken, type RepeatOccurrence, type DialogueCutKind, type DialogueDetections, type Task } from "@scarlet/shared";
import { clipsAt, frameAlignedRemoval, mergeRanges, timelineDuration, timelineToSource, type Project, type Timeline, type TimeRange, type TranscriptWord } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import { cutScope, selectedRange } from "./cut-scope.js";
import { quietKeptWords, type QuietKeptWord } from "./quiet-kept-word.js";
import type { GapSound } from "./gap-sound.js";
import type { DialogueEvidence } from "./dialogue-decisions.js";
import { audibleMediaClips, edgeOnFrame, pageAt as scanPageAt, checkKeptWords, type ReadKeptWords, checkDialogueJoin, checkResumeQuote, dialogueCutPreview, dialogueJoinWords, joinEvidence, pageReaches, pauseCutRange, PAUSE_BEAT, dialogueAudioStream, soundBesideEdge, wordCutRange, type JoinPage } from "./dialogue-join.js";

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
  kind: DialogueCutKind;
  decision: "cut" | "review" | "keep";
  resumeWith?: string;
  keepRepeat?: string | string[];
  productionQuote?: string;
  picture?: "safe" | "uncertain" | "protect";
  reason: string;
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
  /** Measure the recording near these source instants when no scan page covers them. */
  measure(points: Array<{ mediaId: string; t: number }>): Promise<void>;
  /** Independent speech reading of the few seconds that would survive beside a cut, when available for replay. */
  readKeptWords?: ReadKeptWords;
  /** Actual duration of a centered dialogue crossfade in project frames, when known. */
  crossfadeFrames?: number;
  /** Sound at speaking level in a stretch of a recording that holds no transcript word, when its levels can be read. */
  sound?(mediaId: string, range: TimeRange): Promise<GapSound | undefined>;
}

/** A word's estimate before alignment can sit a few hundred milliseconds early. Ask for final times this far past it. */
export const SETTLED_MARGIN = 2;
/** An applied cut's edge this close to the sound it removes is flagged for the editor: about two frames at 30 fps. */
export const SPEECH_BESIDE_EDGE = 0.06;

/**
 * How far into each recording a set of cuts reaches: the source time under the end of its furthest cut. A stretch the
 * agent decided from the transcript alone was never paged through dialogue_scan, and cuts saved there reach it all the
 * same, on every recording under them.
 */
export function cutsReach(tl: Timeline, cuts: readonly TimeRange[]) {
  const reach = new Map<string, number>();
  for (const cut of cuts) {
    // The last instant the cut removes. Its end is the first instant kept, which can be past the last clip.
    for (const { clip } of clipsAt(tl, Math.max(cut.start, cut.end - 1e-6))) {
      if (clip.kind === "media") reach.set(clip.mediaId, Math.max(reach.get(clip.mediaId) ?? 0, timelineToSource(clip, cut.end)));
    }
  }
  return reach;
}

/** Each audible source instant under the given timeline times. */
export function audibleSourcePoints(tl: Timeline, times: number[]) {
  return times.flatMap(at => clipsAt(tl, at).flatMap(({ clip, track }) =>
    clip.kind === "media" && !track.muted && clip.enabled && clip.volume > 0 && track.kind !== "caption"
      ? [{ mediaId: clip.mediaId, t: timelineToSource(clip, at) }] : []));
}

/**
 * Resolve a word reference to a timeline range on `tl`: each edge goes in the measured silence
 * beside the removed words (wordCutRange), then maps through the clip that plays it.
 */
export async function resolveWordCut(tl: Timeline, ref: { mediaId: string; fromWord: number; toWord: number }, sources: DialoguePlanSources, compareTakes = false) {
  let words = await sources.words(ref.mediaId);
  if (!words) throw new Error(`Media ${ref.mediaId} has no transcript words to reference. Use seconds instead.`);
  const { fromWord, toWord } = ref;
  if (fromWord > toWord || toWord >= words.length) {
    throw new Error(`Word range #${fromWord}–#${toWord} is outside ${ref.mediaId}'s transcript (#0–#${words.length - 1}).`);
  }
  const shifts = compareTakes ? equivalentShifts(words, fromWord, toWord).slice(1) : [];
  const last = Math.min(words.length - 1, toWord + 1 + Math.max(0, ...shifts));
  words = await sources.words(ref.mediaId, words[last]!.end + SETTLED_MARGIN) ?? words;
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
export function equivalentShifts(words: ReadonlyArray<Pick<TranscriptWord, "text">>, from: number, to: number, most = 5) {
  const token = (i: number) => words[i] ? normalizeTranscriptToken(words[i]!.text) : "";
  const shifts = [0];
  // Later: the first removed word is said again right after the removal.
  for (let k = 1; k <= most && to + k < words.length && token(from + k - 1) && token(from + k - 1) === token(to + k); k++) shifts.push(k);
  // Earlier: the last removed word was said just before it.
  for (let k = 1; k <= most && from - k >= 0 && token(to - k + 1) && token(to - k + 1) === token(from - k); k++) shifts.push(-k);
  return shifts;
}

async function placeWordCut(tl: Timeline, words: TranscriptWord[], ref: { mediaId: string; fromWord: number; toWord: number; clipId?: string }, sources: DialoguePlanSources) {
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
  const cut = wordCutRange(words, fromWord, toWord, pageAt);
  const clips = audibleMediaClips(tl).filter(c => c.mediaId === ref.mediaId && (!ref.clipId || c.id === ref.clipId));
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
    // The word itself must play on this version; the edge then maps through the same clip.
    const clip = clips.find(c => word.start + word.end >= 2 * c.sourceIn && word.start + word.end < 2 * c.sourceOut);
    if (!clip) throw new Error(`Word #${side === "start" ? fromWord : toWord} “${word.text.trim()}” is not in version ${tl.version}. Read timeline_transcript for the words this version plays.`);
    const on = (s: number) => clip.timelineIn + (Math.min(Math.max(s, clip.sourceIn), clip.sourceOut) - clip.sourceIn) / (clip.speed ?? 1);
    // Saved on the frame inside the measured quiet that is nearest the padded instant, so the engine's rounding keeps it there.
    return round3(edgeOnFrame(on(source), room, fps, on));
  };
  // The last words of an edit end where the timeline does. Rounding to the millisecond must not carry the range past it.
  const start = place(cut.start, "start", words[fromWord]!, cut.room.start), end = Math.min(place(cut.end, "end", words[toWord]!, cut.room.end), timelineDuration(tl));
  if (end <= start) throw new Error(`Words #${fromWord}–#${toWord} do not form one forward range on version ${tl.version}.`);
  // Where the words themselves play: the edges sit in the silence either side of them.
  const spoken = { start: Math.max(start, place(words[fromWord]!.start, "start", words[fromWord]!)), end: Math.min(end, place(words[toWord]!.end, "end", words[toWord]!)) };
  return { start, end, words: cut.text, problems: cut.problems, dips: cut.dips, spoken, source: { start: round3(cut.start), end: Number.isFinite(cut.end) ? round3(cut.end) : null } };
}

export class NoPauseToTrim extends Error {}

/**
 * Resolve a pause named by the word it follows to a timeline range on `tl`: the pause between that word and the next
 * comes down to `leave` seconds, or to the default edge padding, with both edges in the measured quiet.
 */
export async function resolvePauseCut(tl: Timeline, ref: { mediaId: string; afterWord: number; leave?: number }, sources: DialoguePlanSources) {
  let words = await sources.words(ref.mediaId);
  if (!words) throw new Error(`Media ${ref.mediaId} has no transcript words to reference. Use seconds instead.`);
  if (ref.afterWord >= words.length - 1) throw new Error(`No word follows #${ref.afterWord} in ${ref.mediaId}'s transcript (#0–#${words.length - 1}). Give the pause in seconds.`);
  words = await sources.words(ref.mediaId, words[ref.afterWord + 1]!.end + SETTLED_MARGIN) ?? words;
  const before = words[ref.afterWord]!, after = words[ref.afterWord + 1]!;
  const said = `“${before.text.trim()}” and “${after.text.trim()}” (#${ref.afterWord}, #${ref.afterWord + 1})`;
  const middle = (before.end + after.start) / 2;
  await sources.measure([Math.min(before.end + .1, middle), Math.max(after.start - .1, middle)].map(t => ({ mediaId: ref.mediaId, t })));
  const pageAt = (t: number) => scanPageAt(sources.pages(), ref.mediaId, 0, t);
  const leave = ref.leave ?? PAUSE_BEAT;
  const cut = pauseCutRange(before, after, pageAt, leave);
  if (cut.end - cut.start < .04) throw new NoPauseToTrim(`The pause between ${said} plays ${cut.plays.toFixed(2)} s, which leaves nothing to trim down to ${leave.toFixed(2)} s.`);
  // One clip plays both words: across a join the pause is the join's, and there is no stretch of the recording to take out.
  const clip = audibleMediaClips(tl).find(c => c.mediaId === ref.mediaId &&
      before.start + before.end >= 2 * c.sourceIn && after.start + after.end < 2 * c.sourceOut);
  if (!clip) throw new Error(`Version ${tl.version} does not play ${said} one after the other. Read timeline_transcript for the words this version plays.`);
  const on = (source: number) => clip.timelineIn + (Math.min(Math.max(source, clip.sourceIn), clip.sourceOut) - clip.sourceIn) / (clip.speed ?? 1);
  const fps = (await sources.project()).settings.fps;
  const place = (source: number, room?: TimeRange) => round3(edgeOnFrame(on(source), room, fps, on));
  // The transcript has no word here, which is not the same as nothing being said. What comes out with the pause goes
  // back to the agent: a pause that held a missed "see" and a second "you can" was trimmed with half the restart left in.
  const held = await sources.sound?.(ref.mediaId, { start: cut.start, end: cut.end }).catch(() => undefined);
  const notes = held?.runs.length ? [`This pause holds ${held.seconds.toFixed(2)} s of sound at speaking level that no word explains (${
    held.runs.map(r => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`).join(", ")} s in ${ref.mediaId}). It comes out with the pause.`] : [];
  return { start: place(cut.start, cut.room.start), end: place(cut.end, cut.room.end), words: `pause after “${before.text.trim()}”`, problems: cut.problems, notes,
    source: { start: round3(cut.start), end: round3(cut.end) }, plays: round3(cut.plays) };
}

type CutRef = { occurrence?: RepeatOccurrence; start?: number; end?: number; mediaId?: string; fromWord?: number; toWord?: number; afterWord?: number; leave?: number };

/** A cut given in timeline seconds, as removed words, or as the pause after a word, resolved to timeline seconds on `tl`. */
export async function resolveCutRange(tl: Timeline, c: CutRef, label: string, sources: DialoguePlanSources, compareTakes = false) {
  const pause = c.afterWord !== undefined;
  const words = c.mediaId !== undefined || c.fromWord !== undefined || c.toWord !== undefined || pause;
  const seconds = c.start !== undefined || c.end !== undefined;
  if (c.leave !== undefined && !pause) throw new Error(`${label}: leave goes with afterWord. A range in seconds or words already says what plays.`);
  if (c.occurrence) {
    if (words || seconds || c.leave !== undefined) throw new Error(`${label}: a measured occurrence already identifies the range to remove.`);
    const { mediaId, clipId, words: heard, before, after } = c.occurrence;
    const around = [...(before ? [before] : []), ...heard, ...(after ? [after] : [])];
    const fromWord = before ? 1 : 0;
    return { ...await placeWordCut(tl, around, { clipId, mediaId, fromWord, toWord: fromWord + heard.length - 1 }, sources), wordRef: true as const };
  }
  if (words === seconds) throw new Error(`${label}: give start/end in timeline seconds or mediaId with fromWord/toWord, not both or neither.`);
  if (pause) {
    if (!c.mediaId || c.fromWord !== undefined || c.toWord !== undefined) throw new Error(`${label}: a pause reference is mediaId with afterWord, without fromWord or toWord.`);
    return { ...await resolvePauseCut(tl, { mediaId: c.mediaId, afterWord: c.afterWord!, leave: c.leave }, sources), wordRef: true as const };
  }
  if (seconds) {
    if (c.start === undefined || c.end === undefined) throw new Error(`${label}: give both start and end.`);
    // Times reach the agent rounded to the millisecond. An edit that ends at 1777.0666… s reads as 1777.067, and a
    // range to that end is a range to the end of the edit, not one that runs past it.
    const total = timelineDuration(tl);
    return { start: c.start, end: c.end > total && c.end - total <= 0.001 ? total : c.end };
  }
  if (!c.mediaId || c.fromWord === undefined || c.toWord === undefined) throw new Error(`${label}: a word reference needs mediaId, fromWord and toWord.`);
  return { ...await resolveWordCut(tl, { mediaId: c.mediaId, fromWord: c.fromWord, toWord: c.toWord }, sources, compareTakes), wordRef: true as const };
}

/** One dialogue-scan page as join evidence, built the same way for the live tool and for replay. */
export function dialogueScanPage(mediaId: string, from: number, to: number, audioStream: number, segments: DialogueDetections["segments"],
  wf: Parameters<typeof joinEvidence>[1]) {
  return { mediaId, start: from, end: to, audioStream, edges: joinEvidence(segments.flatMap(s => s.words), wf), segments };
}

export type ResolvedCut = Omit<DialogueCutInput, "mediaId" | "fromWord" | "toWord" | "afterWord" | "leave"> & {
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
};
/** One cut as sent to the engine (DialogueCutsRequest). */
export interface PlannedDecision extends TimeRange {
  reason: string;
  review: boolean;
  kind: DialogueCutKind;
  originalRange: TimeRange | undefined;
  /** Marks an applied cut as needing the editor until they keep it. */
  check?: string;
}
export type GateLine = Record<string, unknown> & { cut: number };

export type DialoguePlan =
  | { outcome: "preserved"; kept?: TimeRange[] }
  | { outcome: "needsRevision"; disputedEdges: Array<TimeRange & { reason: string; quietKeptWord?: QuietKeptWord }> }
  | { outcome: "ready"; removals: ResolvedCut[]; decisions: PlannedDecision[]; gate: Map<number, GateLine>;
      /** Ranges the plan keeps on purpose, in timeline seconds: keep decisions, however they were given, and protected pictures. */
      kept: TimeRange[];
      unreadJoinAudio?: Array<{ cut: number; reasons: string[] }> };

export interface DialoguePlanRequest {
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
}

const phrase = (s: string) => s.trim().split(/\s+/u).map(normalizeTranscriptToken).join(" ");
const r2 = (t: number) => Math.round(t * 100) / 100;

/** Everything dialogue_apply_cuts decides before it sends the plan to the engine. Throws on an invalid plan. */
export async function planDialogueCuts(req: DialoguePlanRequest, sources: DialoguePlanSources): Promise<DialoguePlan> {
  const { tl, cuts: requested, range, only, localPauses } = req;
  const otherKinds = [...new Set(requested.filter(c => c.kind !== "pause").map(c => c.kind))];
  if (localPauses && ((only && only !== "pause") || otherKinds.length))
    throw new Error(`The editor requested only pauses in the local passage (/tighten-pauses-here). Remove the ${otherKinds.join(" and ") || only} decisions.`);
  if (only && requested.some(c => c.kind !== only)) throw new Error(`only is "${only}", so every decision must be kind "${only}".`);
  // Word references become timeline seconds first; everything after is the same plan.
  const cuts: ResolvedCut[] = await Promise.all(requested.map(async (c, i) => {
    const { occurrence: _occurrence, mediaId: _m, fromWord: _f, toWord: _t, afterWord, leave: _l, ...rest } = c;
    if (afterWord !== undefined && c.kind !== "pause") throw new Error(`cuts[${i}]: afterWord names a pause. Give a ${c.kind} as its removed words or in seconds.`);
    const resolved = await resolveCutRange(tl, c, `cuts[${i}]`, sources);
    // A word range whose edges found no measured quiet goes to the editor. When the same words play from another
    // saying of them with quiet at both edges, the agent can pick that one and the cut can apply as decided: on one
    // pass, two of eight such held cuts had one.
    const clean = c.mediaId !== undefined && c.fromWord !== undefined && c.toWord !== undefined && "problems" in resolved && resolved.problems.length
      ? await resolveWordCut(tl, { mediaId: c.mediaId, fromWord: c.fromWord, toWord: c.toWord }, sources, true)
        .then(r => ("alternativeWordRanges" in r ? r.alternativeWordRanges ?? [] : []).filter(a => !a.problems.length)).catch(() => [])
      : [];
    return { ...rest, start: resolved.start, end: resolved.end, input: i,
      ...(clean.length && { cleanAlternatives: clean.map(a => ({ fromWord: a.fromWord, toWord: a.toWord })) }),
      ...("wordRef" in resolved && { words: resolved.words, wordEdgeProblems: resolved.problems,
        ...("spoken" in resolved && { spoken: resolved.spoken, wordEdgeDips: resolved.dips }), ...("notes" in resolved && { notes: resolved.notes }) }) };
  }));
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
  const duration = timelineDuration(tl);
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
  if (quoted.length) {
    const project = await sources.project();
    const disputedEdges = quoted.flatMap(c => {
      let reason: string | undefined;
      if (c.kind === "coaching" && c.productionQuote) {
        reason = sources.evidence.checkProductionQuote(c, c.productionQuote, tl, project);
      } else if (c.resumeWith) {
        const result = checkResumeQuote(tl, project, c.end, sources.evidence.scans, c.resumeWith);
        if (result === "different") reason = "The surviving dialogue starts with different words than the supplied quote.";
        if (result === "unverified") reason = "The scan cannot confirm the supplied quote here.";
      }
      return reason ? [{ start: c.start, end: c.end, reason }] : [];
    });
    if (disputedEdges.length) return { outcome: "needsRevision", disputedEdges };
  }
  // The recording decides where each edge sits. Word timings only name the words.
  const edged = (c: ResolvedCut) => c.kind === "retake" || c.kind === "filler" || c.kind === "pause" || (c.kind === "coaching" && !!c.productionQuote);
  const checkRetakes = !only || only === "retake";
  const project = await sources.project();
  const toMeasure = removals.filter(c => edged(c) ||
    (checkRetakes && c.decision === "cut"));
  if (toMeasure.length) await sources.measure(audibleSourcePoints(tl, toMeasure.flatMap(c => [c.start, c.end])));
  // Every change Scarlet makes to the plan goes back to the agent with its evidence.
  const report: GateLine[] = [];
  const decisions = removals.map(c => {
    const decided: PlannedDecision = { start: c.start, end: c.end, reason: c.reason, review: c.decision === "review", kind: c.kind,
      originalRange: undefined, ...(c.check && { check: c.check }) };
    const adjust = (next: PlannedDecision, found: string) => {
      const reach = next.originalRange ?? next;
      if (reach.start < scope.start || reach.end > scope.end || kept.some(k => reach.start < k.end && reach.end > k.start)) {
        const evidence = "The measured edge would cross the selected range or footage marked to keep. The requested edges are staged for review.";
        next = { ...decided, review: true, reason: c.reason + " " + evidence };
        found = `The measured range is ${r2(reach.start)}–${r2(reach.end)} s. ${evidence}`;
      }
      const moved = Math.abs(next.start - c.start) > 1e-6 || Math.abs(next.end - c.end) > 1e-6;
      report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: next.review ? "review" : "cut",
        range: [r2(next.start), r2(next.end)], ...(moved && { from: [r2(c.start), r2(c.end)] }), evidence: found });
      return next;
    };
    // Word edges without measured silence fall back to word timings, which is not a confident edge.
    const fallback = c.wordEdgeProblems?.length && !decided.review
      ? { review: true, reason: c.reason + " " + c.wordEdgeProblems.join(" ") } : undefined;
    const alternatives = c.cleanAlternatives?.map(a => `#${a.fromWord}–#${a.toWord}`).join(", ");
    const base = fallback ? adjust({ ...decided, ...fallback }, [...c.wordEdgeProblems!, ...(alternatives
      ? [`Words ${alternatives} leave the same words playing and have measured quiet at both edges.`] : [])].join(" ")) : decided;
    if (!edged(c)) return base;
    // Removed words whose two edges Scarlet placed itself, in the measured silence beside them or at the dip between
    // two words that run together, are not checked a second time: that check takes a brief dip for speech and held
    // every cut of a doubled word for the editor. What was measured at a dip goes back to the agent.
    if (c.spoken && !c.wordEdgeProblems?.length) return c.wordEdgeDips?.length ? adjust(decided, c.wordEdgeDips.join(" ")) : base;
    const join = checkDialogueJoin(tl, project, { start: c.start, end: c.end }, sources.pages(), c.spoken);
    // Without a measurement at the edge there is nothing to act on. The agent's own evidence stands.
    if (join.unmeasured) return base;
    // Both edges in quiet: one whose frame would round onto sound goes on a quiet frame, which the engine's rounding
    // keeps. A move of under a frame that would meet a neighbor, the selection's edge or footage marked to keep stays.
    if (join.status === "unchanged") {
      const i = sorted.indexOf(c), frame = 1 / project.settings.fps;
      const start = (!i || sorted[i-1]!.end <= join.start - frame) && join.start >= scope.start && !kept.some(k => k.end > join.start && k.end <= c.start) ? join.start : c.start;
      const end = (i === sorted.length - 1 || join.end + frame <= sorted[i+1]!.start) && join.end <= scope.end && !kept.some(k => k.start < join.end && k.start >= c.end) ? join.end : c.end;
      return end > start ? { ...base, start, end } : base;
    }
    // A pause is quiet from end to end, so one whose edge is on sound was placed from a word's timing, which often
    // starts a tenth of a second after the word does. Its edges go onto the measured quiet beside them: that keeps
    // the word and leaves a little more air, so it stays the cut the agent decided. An edge with no quiet in reach
    // stays where the agent put it, and so does a pause whose move would reach into the range beside it.
    if (c.kind === "pause") {
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
    if (join.status === "snapped") return adjust({ ...base, review: true,
      reason: c.reason + " The nearest silence at an edge overlaps the neighboring range. Audition that edge." },
      "The nearest silence at an edge overlaps the neighboring range.");
    // A production aside keeps its verified quote range. Without measured silence at its edges it waits for audition.
    if (c.kind === "coaching") return adjust({ ...base, review: true,
      reason: c.reason + " Check the words on both sides of this production aside before removing it." }, join.reason ?? "");
    // The editor can restore the whole proposal. An edge may also move outward into a pause, so the range covers both.
    return adjust({ ...base, start: join.start, end: join.end, review: true,
      originalRange: join.status === "adjusted" || join.status === "partial"
        ? { start: Math.min(c.start, join.start), end: Math.max(c.end, join.end) } : undefined,
      reason: c.reason + " " + join.reason }, join.reason ?? "");
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
      // An adjustment that leaves nothing of the range falls back to the range as asked, for the editor to audition.
      const next: PlannedDecision = range.end - range.start > 1e-9 ? { ...d, ...range } : { ...d, start: c.start, end: c.end, review: true };
      const original = d.originalRange && { start: Math.max(d.originalRange.start, d === before ? -Infinity : meet), end: Math.min(d.originalRange.end, d === before ? meet : Infinity) };
      next.originalRange = original && original.end > original.start ? original : undefined;
      if (moved || next.review !== d.review) report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: next.review ? "review" : "cut",
        range: [r2(next.start), r2(next.end)], from: [r2(c.start), r2(c.end)], evidence: `Held at the neighboring range at ${r2(meet)} s.` });
      return next;
    };
    decisions[i - 1] = held(before, asked.before, { start: before.start, end: Math.min(before.end, meet) });
    decisions[i] = held(after, asked.after, { start: Math.max(after.start, meet), end: after.end });
  }
  const { media, settings: { fps } } = project;
  const retained = sorted.filter(c => c.decision === "keep" || c.picture === "protect");
  const unreadJoinAudio: Array<{ cut: number; reasons: string[] }> = [];
  const applied = mergeRanges(decisions.filter(d => !d.review), 1e-9);
  const align = (r: TimeRange) => frameAlignedRemoval(r, fps, scope, kept);
  const appliedFrames = applied.map(align);
  const quiet = await quietKeptWords(tl, project, appliedFrames, [...kept, ...decisions.filter(d => d.review)], scope, sources);
  if (quiet.length) return { outcome: "needsRevision", disputedEdges: quiet };
  const speechCuts = removals.flatMap((c, i) => c.kind !== "pause" && c.decision === "cut" ? [{ c, d: decisions[i]! }] : []);
  if (speechCuts.length && checkRetakes) {
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
    // Existing doubled-word checks apply to the version that will actually be kept. A requested cut that
    // placement sends to review can still leave a partial repeat in its preview; return that to its author too.
    const jobs = [{ joins: applied, preview: appliedPreview, forReview: false }];
    if (read && speechCuts.some(({ d }) => d.review))
      jobs.push({ joins: mergeRanges(decisions, 1e-9), preview: stagedPreview, forReview: true });
    const issuesByJoin = await Promise.all(jobs.flatMap(({ joins, preview, forReview }) => {
      const played = joins.map(align);
      return joins.map(async (join, i) => {
        const contributing = speechCuts.filter(({ d }) => d.review === forReview && join.start <= d.start && d.end <= join.end);
        if (!contributing.length) return [];
        const range = played[i]!;
        const previous = Math.max(played[i - 1]?.end ?? 0, selection?.start ?? 0);
        const next = Math.min(played[i + 1]?.start ?? duration, selection?.end ?? duration);
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
        return issues.map(({ cut, words, reason, ...evidence }) => ({ ...range, cut, ...evidence,
          reason: reason + " " + (req.repeatHint ?? `Include one occurrence in the removal using word indices or new edges. If both belong, include “${words}” in keepRepeat on cut ${cut}.`) }));
      });
    }));
    const disputedEdges = issuesByJoin.flat();
    if (disputedEdges.length) return { outcome: "needsRevision", disputedEdges };
  }
  // An applied cut whose edge sits right beside the sound it removes goes to the editor to watch and hear: the picture
  // can show a word starting that the sound has not reached yet. The cut still applies, as the agent decided it. Its
  // edges were measured with its other checks; one with no reading there is not flagged.
  // A pause takes out a wait, and what sounds in it goes with it; this is about the words a cut takes out.
  const near = SPEECH_BESIDE_EDGE;
  const edgePages = sources.pages();
  removals.forEach((c, i) => {
    const d = decisions[i]!;
    if (d.review || d.check || c.kind === "pause") return;
    const close: string[] = [];
    for (const [at, side] of [[d.start, "out"], [d.end, "in"]] as const) {
      for (const { clip, track } of clipsAt(tl, at)) {
        if (clip.kind !== "media" || track.muted || !clip.enabled || !clip.volume || track.kind === "caption") continue;
        const asset = media.find(m => m.id === clip.mediaId);
        const stream = dialogueAudioStream(clip) ?? (asset && dialogueAudioStream(asset)) ?? 0;
        const gap = soundBesideEdge(edgePages, clip.mediaId, stream, timelineToSource(clip, at), side, Math.min(near, d.end - d.start));
        if (gap === undefined) continue;
        close.push(side === "out" ? `the removed sound starts ${gap.toFixed(2)} s after the cut` : `the removed sound ends ${gap.toFixed(2)} s before the join`);
        break;
      }
    }
    if (!close.length) return;
    decisions[i] = { ...d, check: close.length === 2 ? "Speech sits right beside both edges: watch and listen at the join."
      : close[0]!.startsWith("the removed sound starts") ? "A removed word starts right after the cut: watch and listen at the join."
      : "A removed word ends right before the join: watch and listen there." };
    report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: "cut",
      range: [r2(d.start), r2(d.end)], evidence: `In the recording ${close.join(" and ")}. The cut applies; the editor is asked to check it (${decisions[i]!.check}).` });
  });
  removals.forEach((c, i) => {
    const d = decisions[i]!;
    if (c.notes?.length) report.push({ cut: c.input, kind: c.kind, ...(c.words && { words: c.words }), asked: c.decision, outcome: d.review ? "review" : "cut",
      range: [r2(d.start), r2(d.end)], evidence: c.notes.join(" ") });
  });
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
