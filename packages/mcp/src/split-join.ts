import { clipEnd, type MediaClip, type SplitJoinPlaced, type Timeline, type TranscriptWord } from "@scarlet/timeline";

/** The amount a split moves a join's sound when the call gives none: the stock split-edits skill's. */
export const SPLIT_DEFAULT = 0.25;

/** What one split join will sound like, measured from the transcript of each side's recording, for the model to judge. */
export interface SplitJoinEvidence {
  /** The picture cut and the sound cut, timeline seconds. */
  at: number;
  soundAt: number;
  /** "J" when the incoming sound leads, "L" when the outgoing sound carries on, "straight" when they cut together. */
  split: "J" | "L" | "straight";
  /** Seconds from the picture cut to the first word of the incoming shot as it plays now: negative is heard before its picture. */
  voiceIn?: number;
  /** Seconds from the picture cut to the end of the outgoing shot's last word: positive is heard over the next picture. */
  voiceOut?: number;
  /** Words the split now plays that the join didn't, from footage either side outside the picture. */
  nowHeard: string[];
  /** Words the join played that the split takes away. */
  noLongerHeard: string[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const isWord = (w: TranscriptWord) => w.end > w.start && /\w/.test(w.text);
const between = (words: readonly TranscriptWord[], from: number, to: number) =>
  words.filter(w => isWord(w) && w.start >= Math.min(from, to) - 1e-3 && w.end <= Math.max(from, to) + 1e-3).map(w => w.text.trim());

/**
 * What each split join will sound like, read from the transcripts: how soon the voice comes in and goes out against
 * the picture cut, and which whole words the split brings in or takes away. A word cut while it sounds is refused
 * before this, from the recording itself. `words` gives each recording's transcript, or null where it has none.
 */
export function splitJoinEvidence(after: Timeline, joins: readonly SplitJoinPlaced[],
  words: (mediaId: string) => readonly TranscriptWord[] | null | undefined): SplitJoinEvidence[] {
  const clip = (tl: Timeline, id: string) => tl.tracks.flatMap(t => t.clips).find((c): c is MediaClip => c.id === id && c.kind === "media");
  return joins.map(join => {
    const soundAt = join.at + join.shift;
    const evidence: SplitJoinEvidence = { at: round(join.at), soundAt: round(soundAt),
      split: join.shift < -1e-6 ? "J" : join.shift > 1e-6 ? "L" : "straight", nowHeard: [], noLongerHeard: [] };
    const left = clip(after, join.left.clipId), right = clip(after, join.right.clipId);
    // Before the split each side's sound ended or started where the join's sound cut then.
    const wasAt = join.at + join.was;
    if (left) {
      const said = words(left.mediaId);
      if (said) {
        const wasOut = left.sourceIn + (wasAt - left.timelineIn) * left.speed;
        const last = said.findLast(w => isWord(w) && w.end <= left.sourceOut + 1e-3 && w.start >= left.sourceIn - 1e-3);
        if (last) evidence.voiceOut = round(left.timelineIn + (last.end - left.sourceIn) / left.speed - join.at);
        (left.sourceOut > wasOut ? evidence.nowHeard : evidence.noLongerHeard).push(...between(said, wasOut, left.sourceOut));
      }
    }
    if (right) {
      const said = words(right.mediaId);
      if (said) {
        const wasIn = right.sourceIn + (wasAt - right.timelineIn) * right.speed;
        const first = said.find(w => isWord(w) && w.start >= right.sourceIn - 1e-3 && w.end <= right.sourceOut + 1e-3);
        if (first && first.start < right.sourceIn + (clipEnd(right) - right.timelineIn) * right.speed)
          evidence.voiceIn = round(right.timelineIn + (first.start - right.sourceIn) / right.speed - join.at);
        (right.sourceIn < wasIn ? evidence.nowHeard : evidence.noLongerHeard).push(...between(said, right.sourceIn, wasIn));
      }
    }
    return evidence;
  });
}
