/** Map timelines onto the source clock of the audible dialogue recordings. */
import type { MediaClip, Timeline } from "../../packages/timeline/src/index.ts";
import { merge, type Range } from "./intervals.ts";
import type { MediaEvidence, PlayedWord } from "./metrics.ts";

export interface MediaInfo {
  id: string;
  kind: string;
  name?: string;
  duration?: number;
  hasAudio?: boolean;
  hash?: string;
  /** Storage key inside the project's media folder. */
  path?: string;
  audioStream?: number;
}

export interface SourceRange extends Range { mediaId: string }

export function carriesAudio(media: MediaInfo | undefined): boolean {
  return !!media && (media.kind === "audio" || (media.kind === "video" && media.hasAudio !== false));
}

export function clipLength(clip: Pick<MediaClip, "sourceIn" | "sourceOut" | "speed">): number {
  return Math.max(0, (clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1));
}

/** Clips the viewer hears: unmuted, enabled, nonzero volume, from media with sound. */
export function audibleClips(tl: Timeline, media: readonly MediaInfo[]): MediaClip[] {
  const byId = new Map(media.map(m => [m.id, m]));
  return tl.tracks.filter(t => t.kind !== "caption" && !t.muted).flatMap(t => t.clips)
    .filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && (c.volume ?? 1) > 0 && carriesAudio(byId.get(c.mediaId)));
}

export function audibleMediaIds(tl: Timeline, media: readonly MediaInfo[]): string[] {
  return [...new Set(audibleClips(tl, media).map(c => c.mediaId))];
}

/** Source material each audible recording contributes to this timeline. */
export function keptSource(tl: Timeline, media: readonly MediaInfo[]): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  for (const c of audibleClips(tl, media)) {
    const list = out.get(c.mediaId) ?? [];
    list.push({ start: c.sourceIn, end: c.sourceOut });
    out.set(c.mediaId, list);
  }
  for (const [id, list] of out) out.set(id, merge(list));
  return out;
}

/**
 * The words a version plays, on its timeline, each with the piece of its recording it sits in. A clip that carries
 * straight on from the one before it, as after a split for a change of framing, stays in the same piece.
 */
export function playedWords(tl: Timeline, media: readonly MediaInfo[], evidence: ReadonlyMap<string, MediaEvidence>): PlayedWord[] {
  const out: PlayedWord[] = [];
  const last = new Map<string, { clip: MediaClip; piece: number }>();
  let pieces = 0;
  for (const clip of audibleClips(tl, media).sort((a, b) => a.timelineIn - b.timelineIn)) {
    const speed = clip.speed ?? 1, before = last.get(clip.mediaId);
    const carriesOn = before && (before.clip.speed ?? 1) === speed && Math.abs(before.clip.sourceOut - clip.sourceIn) < 1e-3 &&
      Math.abs(before.clip.timelineIn + clipLength(before.clip) - clip.timelineIn) < 1e-3;
    const piece = carriesOn ? before.piece : pieces++;
    last.set(clip.mediaId, { clip, piece });
    const at = (source: number) => clip.timelineIn + (Math.min(Math.max(source, clip.sourceIn), clip.sourceOut) - clip.sourceIn) / speed;
    for (const w of evidence.get(clip.mediaId)?.words ?? []) {
      const middle = (w.start + w.end) / 2;
      if (middle >= clip.sourceIn && middle < clip.sourceOut) out.push({ text: w.text, start: at(w.start), end: at(w.end), mediaId: clip.mediaId, piece });
    }
  }
  return out;
}

/** A timeline range on each audible recording it plays. */
export function timelineRangeToSource(tl: Timeline, media: readonly MediaInfo[], range: Range): SourceRange[] {
  const out: SourceRange[] = [];
  for (const c of audibleClips(tl, media)) {
    const lo = c.timelineIn, hi = lo + clipLength(c);
    const start = Math.max(range.start, lo), end = Math.min(range.end, hi);
    if (end - start <= 1e-6) continue;
    const speed = c.speed ?? 1;
    out.push({ mediaId: c.mediaId, start: c.sourceIn + (start - lo) * speed, end: c.sourceIn + (end - lo) * speed });
  }
  return out;
}

/** Group source ranges by recording and merge them. */
export function byMedia(ranges: readonly SourceRange[]): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  for (const r of ranges) out.set(r.mediaId, [...(out.get(r.mediaId) ?? []), { start: r.start, end: r.end }]);
  for (const [id, list] of out) out.set(id, merge(list));
  return out;
}

/** Outermost source points of a timeline range on the recording heard longest in it (a range can span clip splits). */
export function sourceSpan(tl: Timeline, media: readonly MediaInfo[], range: Range): SourceRange | undefined {
  const [mediaId, ranges] = [...byMedia(timelineRangeToSource(tl, media, range))]
    .sort((a, b) => b[1].reduce((s, r) => s + r.end - r.start, 0) - a[1].reduce((s, r) => s + r.end - r.start, 0))[0] ?? [];
  return mediaId && ranges?.length ? { mediaId, start: ranges[0]!.start, end: ranges.at(-1)!.end } : undefined;
}
