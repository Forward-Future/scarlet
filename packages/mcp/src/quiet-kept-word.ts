import { normalizeTranscriptToken } from "@scarlet/shared";
import { clipEnd, rangesOverlap, timelineToSource, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import { dialogueAudioStream, dialogueClips, type AudioLevels } from "./dialogue-join.js";
import type { DialoguePlanSources } from "./dialogue-plan.js";
import { timelineJoins } from "./timeline-perception.js";

const SHORT_PIECE = .5;
const CONTEXT = 1.5;
const MIN_SOUND = .06;
// A whole retained syllable this quiet needs a stronger neighboring sound before its timing is disputed.
const ROOM_TONE_DBFS = -48;
const MIN_CONTRAST_DB = 18;
const EPS = 1e-6;

export interface QuietKeptWord {
  mediaId: string;
  word: string;
  /** Source times of the transcript word, the piece the cuts leave, and nearby sound, respectively. */
  source: TimeRange;
  retainedSource: TimeRange;
  peakRmsDbfs: number;
  nearbySound: TimeRange;
  heardNearby?: TimeRange;
}

type SourcePiece = TimeRange & { mediaId: string; audioStream?: number; timeline?: TimeRange };
type MeasuredPiece = TimeRange & { quietKeptWord: QuietKeptWord; reason: string };
const shortEnough = (duration: number) => duration >= MIN_SOUND - EPS && duration <= SHORT_PIECE + EPS;
const rounded = (r: TimeRange) => ({ start: round3(r.start), end: round3(r.end) });

/** Only pieces newly isolated by this save. A join already on the timeline may form the other edge. */
function isolatedPieces(tl: Timeline, project: Project, cuts: TimeRange[], held: TimeRange[], scope: TimeRange): SourcePiece[] {
  if (!cuts.length) return [];
  const { clips, streams } = dialogueClips(tl, project);
  const existingIn = new Map<string, number>(), existingOut = new Map<string, number>();
  for (const join of timelineJoins(tl, project)) {
    for (const side of join.tracks) {
      if (side.gap || side.in.mediaId !== side.out.mediaId || side.in.source <= side.out.source) continue;
      existingIn.set(side.in.clipId, join.at);
      existingOut.set(side.out.clipId, join.at);
    }
  }
  const audible = clips.map(clip => ({
    clip, start: existingIn.get(clip.id) ?? clip.timelineIn, end: existingOut.get(clip.id) ?? clipEnd(clip),
  })).sort((a, b) => a.start - b.start);
  const pieces: SourcePiece[] = [];
  let cutIndex = 0;
  for (const { clip, start: from, end: to } of audible) {
    // Source transcripts and prepared RMS describe stream zero.
    if ((dialogueAudioStream(clip) ?? streams.get(clip.mediaId)) !== 0) continue;
    const previous = existingIn.get(clip.id), next = existingOut.get(clip.id);
    const add = (start: number, end: number) => {
      if (!shortEnough(end - start) || start < scope.start - EPS || end > scope.end + EPS) return;
      const timeline = { start, end };
      if (held.some(h => rangesOverlap(h, timeline))) return;
      // Within a prior crossfade use the same handover time as the player. Any other layer overlapping
      // the piece can carry the missing speech, even if its clip ends before the midpoint.
      const layered = audible.some(other => other.clip !== clip && other.start < end - EPS && other.end > start + EPS);
      if (!layered) pieces.push({ mediaId: clip.mediaId, start: timelineToSource(clip, start), end: timelineToSource(clip, end), timeline });
    };
    let left = previous;
    while (cutIndex < cuts.length && cuts[cutIndex]!.end <= from) cutIndex++;
    for (let i = cutIndex; i < cuts.length; i++) {
      const cut = cuts[i]!;
      if (cut.start >= to) break;
      if (left !== undefined) add(left, cut.start);
      left = cut.end;
    }
    if (next !== undefined && left !== undefined && left !== previous) add(left, next);
  }
  return pieces;
}

/** Locate sustained sound next to the proposed hold. A level rise alone does not identify the words. */
function nearbySound(levels: AudioLevels, kept: TimeRange, peak: number): TimeRange | undefined {
  const { from, step, db } = levels;
  const floor = Math.max(-40, peak + MIN_CONTRAST_DB);
  const runs: TimeRange[] = [];
  const first = Math.max(0, Math.floor((kept.start - CONTEXT - from) / step));
  const last = Math.min(db.length, Math.ceil((kept.end + CONTEXT - from) / step));
  for (let i = first; i < last; i++) {
    const start = from + i * step, end = start + step;
    if (!(db[i]! >= floor) || (start < kept.end && end > kept.start)) continue;
    const lastRun = runs.at(-1);
    if (lastRun && Math.abs(lastRun.end - start) < EPS) lastRun.end = end;
    else runs.push({ start, end });
  }
  const sustained = runs.filter(r => r.end - r.start >= MIN_SOUND - EPS);
  return sustained.find(r => r.start >= kept.end - EPS) ?? sustained.at(-1);
}

/** Compare the claimed surviving word with the audio, before either cut goes to the engine. */
export function quietKeptWords(tl: Timeline, project: Project, cuts: TimeRange[], held: TimeRange[], scope: TimeRange, sources: DialoguePlanSources) {
  return measureQuietKeptWords(isolatedPieces(tl, project, cuts, held, scope), sources);
}

/** Source-second pieces for an ordered assembly, or their placed equivalents for an edit on the timeline. */
export async function measureQuietKeptWords(pieces: SourcePiece[], sources: DialoguePlanSources): Promise<MeasuredPiece[]> {
  const short = pieces.filter(({ start, end, timeline, audioStream }) => {
    const duration = timeline ? timeline.end - timeline.start : end - start;
    return (audioStream ?? 0) === 0 && shortEnough(duration);
  });
  if (!short.length) return [];
  // This read supplements the required edge measurements. Already prepared pages can still be used if it fails.
  await sources.measure(short.map(p => ({ mediaId: p.mediaId, t: (p.start + p.end) / 2 }))).catch(() => undefined);
  const pages = sources.pages();
  const results = await Promise.all(short.map(async ({ start, end, mediaId, timeline }) => {
    const retained = { start, end };
    const covering = pages.filter(p => p.mediaId === mediaId && (p.audioStream ?? 0) === 0 && p.edges?.levels &&
      p.start <= retained.start + EPS && p.end >= retained.end - EPS).sort((a, b) =>
      Math.min(retained.start - b.start, b.end - retained.end) - Math.min(retained.start - a.start, a.end - retained.end));
    const page = covering[0];
    if (!page) return;
    const levels = page.edges?.levels;
    if (!levels || levels.step <= 0 || levels.step > .031 || levels.from > retained.start + EPS ||
      levels.from + levels.step * levels.db.length < retained.end - EPS) return;
    const bucket = (t: number) => Math.max(0, Math.ceil((t - levels.from) / levels.step - .5));
    const retainedDb = levels.db.slice(bucket(retained.start), bucket(retained.end));
    if (!retainedDb.length) return;
    const peak = Math.max(...retainedDb);
    if (!Number.isFinite(peak) || peak > ROOM_TONE_DBFS) return;
    const nearby = nearbySound(levels, retained, peak);
    if (!nearby) return;
    const words = await sources.words(mediaId, retained.end, false).catch(() => null);
    const kept = words?.filter(w => {
      const middle = (w.start + w.end) / 2;
      return middle >= retained.start && middle < retained.end && !/^\s*\[.*\]\s*$/.test(w.text) && normalizeTranscriptToken(w.text);
    });
    if (kept?.length !== 1) return;
    const word = kept[0]!;
    if (Math.min(word.end, retained.end) - Math.max(word.start, retained.start) < MIN_SOUND - EPS) return;
    // The independent cached speech reading can confirm a very quiet voice or locate the same word nearby.
    // Missing emissions leave the waveform evidence available to the agent without starting transcription.
    const heard = await sources.readKeptWords?.(mediaId, 0, Math.max(0, retained.start - CONTEXT), Math.min(page.end, retained.end + CONTEXT), true).catch(() => []);
    const speech = heard?.filter(w => normalizeTranscriptToken(w.text) && !/^\s*\[.*\]\s*$/.test(w.text));
    if (speech?.some(w => (w.start + w.end) / 2 >= retained.start && (w.start + w.end) / 2 < retained.end)) return;
    const candidates = speech?.filter(w => normalizeTranscriptToken(w.text) === normalizeTranscriptToken(word.text) && rangesOverlap(w, nearby));
    const heardNearby = candidates?.length === 1 ? rounded(candidates[0]!) : undefined;
    const quietKeptWord: QuietKeptWord = { mediaId, word: word.text.trim(), source: rounded(word), retainedSource: rounded(retained),
      peakRmsDbfs: peak, nearbySound: rounded(nearby), ...(heardNearby && { heardNearby }) };
    const reason = `The transcript places “${quietKeptWord.word}” at source ${quietKeptWord.source.start}–${quietKeptWord.source.end} s in ${mediaId}. ` +
      `The retained piece peaks at ${peak} dBFS. Inspect the nearby sound at source ${quietKeptWord.nearbySound.start}–${quietKeptWord.nearbySound.end} s and adjust the edges to keep the spoken word.`;
    return { ...rounded(timeline ?? retained), quietKeptWord, reason };
  }));
  return results.filter(r => r !== undefined);
}
