import type { MediaClip, Timeline, TimeRange, Track } from "./schema.js";
import { intervalCandidates } from "./intervals.js";
import { clipEnd, mergeRanges, timelineDuration, timelineToSource } from "./time.js";
import { shiftClip, trimHead, trimTail } from "./ops.js";
import { stableStringify } from "./ids.js";
import { sameContent } from "./rebase.js";

export type StagedCutMapping =
  | { kind: "exact"; range: TimeRange }
  | { kind: "shortened"; range: TimeRange }
  | { kind: "gone"; at: number }
  | { kind: "conflict"; reason: string; range?: TimeRange };

const EPS = 1e-6;
const mediaClips = (track: Track) => track.clips.filter((c): c is MediaClip => c.kind === "media");
const meet = (a: number, b: number) => Math.abs(a - b) <= EPS;

function bySource(clips: MediaClip[]) {
  const groups = new Map<string, MediaClip[]>();
  for (const clip of clips) {
    const list = groups.get(clip.mediaId);
    if (list) list.push(clip);
    else groups.set(clip.mediaId, [clip]);
  }
  return new Map([...groups].map(([id, list]) => [id, intervalCandidates(list, c => c.sourceIn, c => c.sourceOut)]));
}

interface Fragment extends TimeRange {
  /** Offset from the original timeline to the current one. */
  shift: number;
  ambiguous: boolean;
}

/** Place every surviving source interval on this track, including fragments on either side of a deletion. */
function survivingFragments(before: MediaClip[], after: MediaClip[]): Fragment[] {
  const sources = bySource(before), current = bySource(after);
  const fragments: Fragment[] = [];
  for (const old of before) {
    const candidates = current.get(old.mediaId)?.(old.sourceIn, old.sourceOut) ?? [];
    for (const clip of candidates) {
      const s = Math.max(old.sourceIn, clip.sourceIn), e = Math.min(old.sourceOut, clip.sourceOut);
      if (e <= s + EPS) continue;
      const from = (source: number) => old.timelineIn + (source - old.sourceIn) / old.speed;
      const shift = clip.timelineIn + (s - clip.sourceIn) / clip.speed - from(s);
      // A repeated source elsewhere matters only for the frames that actually repeat.
      const repeated = mergeRanges(sources.get(old.mediaId)!(s, e).filter(c => c !== old && c.sourceIn < e - EPS && c.sourceOut > s + EPS)
        .map(c => ({ start: Math.max(s, c.sourceIn), end: Math.min(e, c.sourceOut) })), EPS);
      let edge = s;
      for (const duplicate of repeated) {
        if (duplicate.start > edge + EPS) fragments.push({ start: from(edge), end: from(duplicate.start), shift, ambiguous: old.speed !== clip.speed });
        fragments.push({ start: from(duplicate.start), end: from(duplicate.end), shift, ambiguous: true });
        edge = duplicate.end;
      }
      if (e > edge + EPS) fragments.push({ start: from(edge), end: from(e), shift, ambiguous: old.speed !== clip.speed });
    }
  }
  return fragments.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Compare the actual stack a ripple removes, including hidden tracks and disabled clips. A clip split
// by an earlier ripple can have a new ID while still carrying exactly the same frames and properties.
function passageReader(timeline: Timeline) {
  const layers = timeline.tracks.map(track => ({ track, clipsIn: intervalCandidates(track.clips, c => c.timelineIn, clipEnd) }));
  return (start: number, end: number) => {
    const tracks = layers.flatMap(({ track, clipsIn }) => {
      const clips = clipsIn(start, end).filter(c => c.timelineIn < end - EPS && clipEnd(c) > start + EPS).map(c => {
        const { id, label, ...part } = shiftClip(trimTail(trimHead(c, start), end), -start);
        if (part.kind !== "media" || c.kind !== "media") return part;
        // A split elsewhere can reset a distant fade. Only its active part belongs to the passage.
        for (const key of ["audioFadeIn", "videoFadeIn"] as const) if (start >= c.timelineIn + c[key] - EPS) part[key] = 0;
        for (const key of ["audioFadeOut", "videoFadeOut"] as const) if (end <= clipEnd(c) - c[key] + EPS) part[key] = 0;
        return { ...part, fadeStart: part.audioFadeIn || part.videoFadeIn ? c.timelineIn - start : undefined,
          fadeEnd: part.audioFadeOut || part.videoFadeOut ? clipEnd(c) - start : undefined };
      });
      return clips.length ? [{ id: track.id, kind: track.kind, hidden: track.hidden, muted: track.muted, captionStyle: track.captionStyle, clips }] : [];
    });
    // Source in/out and relative clip positions can differ by a few ulps after a ripple.
    return JSON.stringify(JSON.parse(stableStringify([timeline.background, timeline.captionStyle, tracks])),
      (_, value) => typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value);
  };
}

/** Share source and interval indexes when mapping several calls from one immutable proposal. */
export function makeStagedCutMapper(from: Timeline, head: Timeline, fps: number): (range: TimeRange) => StagedCutMapping {
  const duration = timelineDuration(head), originalDuration = timelineDuration(from);
  const unchanged = sameContent(from, head);
  const clocks = from.tracks.map(track => {
    const media = mediaClips(track);
    const coverage = mergeRanges(media.map(c => ({ start: c.timelineIn, end: clipEnd(c) })), EPS);
    let fragments: Fragment[] | undefined;
    return { coverage, fragments: () => {
      const current = head.tracks.find(t => t.id === track.id && t.kind === track.kind);
      return fragments ??= survivingFragments(media, current ? mediaClips(current) : []);
    } };
  });
  const originalMedia = from.tracks.flatMap(mediaClips);
  const current = bySource(head.tracks.flatMap(mediaClips));
  const originalPassage = passageReader(from), currentPassage = passageReader(head);
  const originalClipsIn = intervalCandidates(originalMedia, c => c.timelineIn, clipEnd);
  return range => {
    const conflict = (reason: string, bounds?: TimeRange): StagedCutMapping =>
      ({ kind: "conflict", reason, ...(bounds && bounds.end > bounds.start + EPS && { range: bounds }) });
    if (from.projectId !== head.projectId || !(fps > 0 && Number.isFinite(range.start) && range.start >= 0 && range.end > range.start &&
        range.end <= originalDuration + EPS)) return conflict("The original passage is outside this timeline.");
    if (unchanged || from.tracks === head.tracks && from.background === head.background && from.captionStyle === head.captionStyle)
      return { kind: "exact", range: { ...range } };

    // One continuous recording track supplies the clock. Every layer on its surviving intervals must agree.
    const covering = clocks.filter(c => c.coverage.some(r => r.start <= range.start + EPS && r.end >= range.end - EPS));
    if (!covering.length) return conflict("This passage has no continuous recording to locate it by.");
    // If the picture was wholly replaced, for example, surviving sound still locates it for inspection.
    const clock = covering.find(c => c.fragments().some(p => p.start < range.end - EPS && p.end > range.start + EPS))
      ?? covering.find(c => c.fragments().length) ?? covering[0]!;
    const fragments = clock.fragments();
    const inside = fragments.filter(r => r.start < range.end - EPS && r.end > range.start + EPS)
      .map(r => ({ ...r, start: Math.max(range.start, r.start), end: Math.min(range.end, r.end) }));
    const first = inside[0], last = inside.at(-1);
    if (inside.some((p, i) => p.ambiguous || i > 0 && p.start < inside[i - 1]!.end - EPS))
      return conflict("The source occurs more than once or plays at a different speed.");

    function outside(at: number, left: boolean): number | undefined {
      let distance = Infinity, position: number | undefined;
      for (const part of fragments) {
        if (left ? part.start >= at - EPS : part.end <= at + EPS) continue;
        const edge = left ? Math.min(part.end, at) : Math.max(part.start, at);
        const gap = Math.abs(edge - at);
        if (gap < distance - EPS) {
          distance = gap;
          position = part.ambiguous ? undefined : edge + part.shift;
        } else if (meet(gap, distance)) position = undefined;
      }
      return distance === Infinity ? (left ? 0 : duration) : position;
    }
    const start = first && meet(first.start, range.start) ? first.start + first.shift : outside(range.start, true);
    const end = last && meet(last.end, range.end) ? last.end + last.shift : outside(range.end, false);
    if (start === undefined || end === undefined || end < start - EPS || !fragments.length && duration > EPS)
      return conflict("The passage has no unambiguous position on the current timeline.");

    const bounds = { start: Math.max(0, Math.min(start, duration)), end: Math.max(0, Math.min(end, duration)) };
    const missing: TimeRange[] = [];
    let oldEdge = range.start, currentEdge = bounds.start;
    for (const part of inside) {
      if (part.start > oldEdge + EPS) missing.push({ start: oldEdge, end: part.start });
      const here = part.start + part.shift, there = part.end + part.shift;
      if (!meet(currentEdge, here) || originalPassage(part.start, part.end) !== currentPassage(here, there))
        return conflict("Footage was inserted, replaced or changed inside the passage.", bounds);
      currentEdge = there;
      oldEdge = part.end;
    }
    if (!meet(currentEdge, bounds.end)) return conflict("Different footage now occupies this passage.", bounds);
    if (oldEdge < range.end - EPS) missing.push({ start: oldEdge, end: range.end });
    if (!missing.length) return { kind: "exact", range: bounds };

    // The clock can disappear while another layer survives, or a source clip can move to a different
    // track. Neither is proof of removal. Check every original media layer, across every current track.
    for (const lost of missing) for (const clip of originalClipsIn(lost.start, lost.end)) {
      const a = Math.max(clip.timelineIn, lost.start), b = Math.min(clipEnd(clip), lost.end);
      if (a >= b - EPS) continue;
      const s = timelineToSource(clip, a), e = timelineToSource(clip, b);
      if (current.get(clip.mediaId)?.(s, e).some(c => c.sourceIn < e - EPS && c.sourceOut > s + EPS))
        return conflict("Part of the original recording is still present in a different place.", bounds);
    }
    return inside.length ? { kind: "shortened", range: bounds } : { kind: "gone", at: bounds.start };
  };
}

/** Map a staged removal by its recorded source, accepting only unique, chronological surviving footage. */
export function mapStagedCut(from: Timeline, head: Timeline, range: TimeRange, fps: number): StagedCutMapping {
  return makeStagedCutMapper(from, head, fps)(range);
}
