import type { RetakeGroup } from "@scarlet/shared";
import type { MediaAsset, TimeRange, Timeline } from "@scarlet/timeline";
import { mediaClipsFor, sourceToTimeline, speechAssets } from "../../lib/transcriptMap";

export interface CutSource extends TimeRange { mediaId: string }
export interface OtherTake extends TimeRange {
  text: string;
  /** Where this take plays on the timeline, when the timeline still has it. */
  at?: number;
}

/** The transcribed recording a staged cut removes, in source seconds. */
export function cutSource(timeline: Timeline, media: MediaAsset[], cut: TimeRange): CutSource | undefined {
  const speech = new Set(speechAssets(timeline, media).filter(m => m.transcriptId).map(m => m.id));
  let best: { overlap: number; source: CutSource } | undefined;
  for (const { clip } of mediaClipsFor(timeline)) {
    if (!speech.has(clip.mediaId)) continue;
    const speed = clip.speed ?? 1;
    const clipEnd = clip.timelineIn + (clip.sourceOut - clip.sourceIn) / speed;
    const start = Math.max(cut.start, clip.timelineIn), end = Math.min(cut.end, clipEnd);
    if (end - start <= (best?.overlap ?? 0)) continue;
    best = { overlap: end - start, source: { mediaId: clip.mediaId,
      start: clip.sourceIn + (start - clip.timelineIn) * speed, end: clip.sourceIn + (end - clip.timelineIn) * speed } };
  }
  return best?.source;
}

/**
 * The other attempts at the line this cut removes: the retake group with a take the cut mostly covers.
 * A short cut inside a take (a filler, a breath) is not a take of its own.
 */
export function otherTakes(groups: RetakeGroup[], source: CutSource, timeline: Timeline): OtherTake[] {
  const covered = (t: TimeRange) => Math.max(0, Math.min(t.end, source.end) - Math.max(t.start, source.start)) >= (t.end - t.start) / 2;
  const group = groups.find(g => g.takes.some(covered));
  if (!group) return [];
  const clips = mediaClipsFor(timeline, source.mediaId).map(({ clip }) => clip);
  return group.takes.filter(t => !covered(t) && !(t.end > source.start && t.start < source.end)).map(t => {
    const clip = clips.find(c => t.start >= c.sourceIn - 1e-6 && t.start < c.sourceOut);
    return { start: t.start, end: t.end, text: t.text, ...(clip && { at: sourceToTimeline(clip, t.start) }) };
  });
}
