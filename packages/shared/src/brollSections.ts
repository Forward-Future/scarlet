import { clipRange, type MediaAsset, type Timeline, type TimeRange } from "@scarlet/timeline";

/** Maximum gap (in seconds) between consecutive B-roll clips that still read as one continuous section. */
export const BROLL_CONTIGUOUS_GAP = 0.12;
const SECTION_OVERLAP = 0.05;

export interface BrollSection {
  /** Stable identifier for this continuous B-roll section on the timeline. */
  id: string;
  /** Full timeline range from the first clip's start to the last clip's end. */
  range: TimeRange;
  /** Every B-roll clip ID in this continuous section, ordered by start time. */
  clipIds: string[];
}

/** Whether two non-empty timeline stretches overlap or sit back-to-back within `maxGap` seconds. */
export function stretchesContiguous(a?: TimeRange, b?: TimeRange, maxGap = BROLL_CONTIGUOUS_GAP): boolean {
  return !!a && !!b && a.end > a.start && b.end > b.start
    && Math.max(a.start, b.start) <= Math.min(a.end, b.end) + maxGap;
}

/**
 * Find every continuous B-roll section currently on `timeline`: runs of back-to-back or overlapping B-roll clips
 * (footage or web pictures laid over the main picture) with no gap back to the main footage. Motion graphics,
 * disabled clips, hidden tracks, and shrunk picture-in-picture insets of the main camera are excluded.
 */
export function continuousBrollSections(
  timeline: Timeline | null | undefined,
  media: readonly Pick<MediaAsset, "id" | "kind" | "source">[] | undefined,
): BrollSection[] {
  if (!timeline || !media?.length) return [];
  const baseVideo = timeline.tracks.find(t => t.kind === "video");
  const baseMediaIds = new Set<string>();
  if (baseVideo) {
    for (const clip of baseVideo.clips) {
      if (clip.kind === "media") baseMediaIds.add(clip.mediaId);
    }
  }
  const files = new Map(media.map(m => [m.id, m]));
  const items: { id: string; range: TimeRange }[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || track.id === baseVideo?.id || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.enabled === false || clip.kind !== "media") continue;
      const file = files.get(clip.mediaId);
      if (!file || file.kind === "graphic" || (file.kind !== "video" && !file.source)) continue;
      // A shrunk inset of the base camera (e.g. presenter PiP over a screen or graphic) is not standalone B-roll.
      if (baseMediaIds.has(clip.mediaId) && (clip.transform?.scale ?? 1) < 0.99) continue;
      let range: TimeRange;
      try { range = clipRange(clip); } catch { continue; }
      if (range.end <= range.start) continue;
      items.push({ id: clip.id, range });
    }
  }
  if (!items.length) return [];
  items.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.id.localeCompare(b.id));
  const groups: { start: number; end: number; clipIds: string[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && item.range.start <= last.end + BROLL_CONTIGUOUS_GAP) {
      last.end = Math.max(last.end, item.range.end);
      last.clipIds.push(item.id);
    } else {
      groups.push({ start: item.range.start, end: item.range.end, clipIds: [item.id] });
    }
  }
  return groups.map(g => ({
    id: `broll:${Math.round(g.start * 1000)}:${Math.round(g.end * 1000)}`,
    range: { start: g.start, end: g.end },
    clipIds: g.clipIds,
  }));
}

/**
 * Find the active continuous B-roll section an edit belongs to, preferring direct clip-ID matches and falling back
 * to timeline overlap. Returns `undefined` when no active B-roll plays there (e.g. an edit that removed B-roll).
 */
export function brollSectionForEdit(
  sections: readonly BrollSection[],
  range: TimeRange | undefined,
  clipIds?: readonly string[],
): BrollSection | undefined {
  if (!sections.length) return undefined;
  const overlapOf = (s: BrollSection) =>
    range && range.end > range.start ? Math.min(s.range.end, range.end) - Math.max(s.range.start, range.start) : 0;
  if (clipIds?.length) {
    const matched = sections.filter(s => clipIds.some(id => s.clipIds.includes(id)));
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) {
      return matched.reduce((best, s) => overlapOf(s) > overlapOf(best) ? s : best);
    }
  }
  if (!range || range.end <= range.start) return undefined;
  let best: { section: BrollSection; overlap: number } | undefined;
  for (const section of sections) {
    const overlap = overlapOf(section);
    if (overlap > SECTION_OVERLAP && (!best || overlap > best.overlap)) {
      best = { section, overlap };
    }
  }
  return best?.section;
}
