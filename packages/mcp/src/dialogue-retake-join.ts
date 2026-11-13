import { normalizeTranscriptToken } from "@scarlet/shared";
import { clipDuration, timelineToSource, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { dialogueAudioStream, dialogueClips } from "./dialogue-join.js";
import type { RepeatedTake } from "./dialogue-retakes.js";

type Word = Pick<TranscriptWord, "text" | "start" | "end">;
interface ContinuedTake extends RepeatedTake { followingWord: Word }
export interface AcousticRetakePage { mediaId: string; audioStream?: number; takes: ContinuedTake[] }

/** The following word must come from the same uninterrupted measurement as both attempts. */
export function acousticRetakeContinuations(wordRuns: Word[][], repeats: RepeatedTake[]): ContinuedTake[] {
  return repeats.flatMap(take => {
    if (!take.immediateRestart || !take.next.continuation) return [];
    const run = wordRuns.find(words => words.length && words[0]!.start <= take.first.start && words.at(-1)!.end >= take.next.end);
    const followingWord = run?.find(w => w.start >= take.next.end);
    if (!followingWord || followingWord.start - take.next.end > 1.2) return [];
    // A third attempt can start with the same word. Its continuation belongs to the next pair.
    if (normalizeTranscriptToken(followingWord.text) === normalizeTranscriptToken(take.phrase.split(" ")[0]!)) return [];
    return [{ ...take, followingWord }];
  });
}

// A greedy CTC word edge is approximate to within a few 20 ms buckets. Report any
// overlap with retained speech; a word-clock match says nothing about a clean seam.
const edgeTolerance = .04 + 1e-8;
const overlap = (a: TimeRange, b: TimeRange) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const covers = (cut: TimeRange, take: TimeRange) => cut.start <= take.start + edgeTolerance && cut.end >= take.end - edgeTolerance;

function cutEffect(cut: TimeRange, { phrase, first, next, followingWord }: ContinuedTake) {
  const removeFirst = covers(cut, first) && overlap(cut, next) <= edgeTolerance;
  const removeSecond = covers(cut, next) && overlap(cut, first) <= edgeTolerance;
  const followingOverlap = overlap(cut, followingWord);
  if (removeFirst === removeSecond || followingOverlap > edgeTolerance || followingOverlap >= followingWord.end - followingWord.start) return;
  const retained = removeFirst ? next : first, removed = removeFirst ? first : next;
  const retainedOverlap = overlap(cut, retained);
  return { phrase, removedOccurrence: removeFirst ? "first" : "second", retainedOccurrence: removeFirst ? "second" : "first",
    followingWord: { text: followingWord.text, start: followingWord.start, end: followingWord.end },
    followingWordConnection: removeFirst ? "uninterrupted original delivery" : "across the proposed join",
    ...(retainedOverlap > 0 && { cutTouchesRetainedPhraseByMs: Math.round(1000 * retainedOverlap) }),
    ...(followingOverlap > 0 && { cutTouchesFollowingWordByMs: Math.round(1000 * followingOverlap) }),
    ...(cut.start > removed.start || cut.end < removed.end ? { cutTouchesEdgeOfRemovedPhrase: true } : {}) };
}

/** Project the proposed removal through this version. A previous edit between the
 * attempts, a muted clip or a different stream cannot establish the original delivery. */
export function acousticRetakeJoin(tl: Timeline, project: Project, range: TimeRange, pages: Iterable<AcousticRetakePage>) {
  const { clips } = dialogueClips(tl, project);
  // FFmpeg's default input and an explicit stream 0 need not be the same microphone.
  const streams = new Map(project.media.map(m => [m.id, dialogueAudioStream(m)]));
  const results = new Map<string, NonNullable<ReturnType<typeof cutEffect>> & { mediaId: string; audioStream?: number }>();
  for (const { mediaId, audioStream, takes } of pages) {
    for (const clip of clips) {
      if (clip.mediaId !== mediaId || (dialogueAudioStream(clip) ?? streams.get(mediaId)) !== audioStream) continue;
      if (range.end <= clip.timelineIn || range.start >= clip.timelineIn + clipDuration(clip)) continue;
      const cut = { start: timelineToSource(clip, range.start), end: Math.min(clip.sourceOut, timelineToSource(clip, range.end)) };
      for (const take of takes) {
        if (take.first.start < clip.sourceIn || take.followingWord.end > clip.sourceOut) continue;
        const effect = cutEffect(cut, take);
        if (!effect) continue;
        const timelineAt = clip.timelineIn + (take.first.start - clip.sourceIn) / (clip.speed ?? 1);
        const key = JSON.stringify([mediaId, audioStream, take.first.start, take.next.start, timelineAt]);
        results.set(key, { mediaId, ...(audioStream !== undefined && { audioStream }), ...effect });
      }
    }
  }
  return [...results.values()];
}
