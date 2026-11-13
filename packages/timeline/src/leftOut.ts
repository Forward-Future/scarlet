/**
 * Footage a version left out as it was built.
 *
 * A cut is usually made by taking footage out of a version that plays it, and is read from that removal. A version
 * can also be built by placing only the footage to keep: the pieces of a recording, one after another, with whatever
 * came between them never on the timeline at all. Matt's first dialogue pass on a screen and a camera recording was
 * saved that way (2026-11-12): 20 minutes of the recording were left out and the editor was shown one 30 s cut.
 *
 * Wherever two pieces of the same recording meet and the second starts later in the recording than the first ended,
 * the stretch between them was left out. This reads those joins from the version alone, and builds the version that
 * plays them, so a cut made this way has footage to show like any other.
 */
import type { Clip, MediaClip, Timeline, TimeRange } from "./schema.js";
import { shiftClip, splitClip } from "./ops.js";
import { clipEnd, timelineDuration } from "./time.js";

const EPS = 1e-6;

export interface LeftOut {
  /** `after` with every stretch it left out played where it was left out. */
  original: Timeline;
  /** Each stretch, in `original`'s clock, and where its two sides join on `after`. In timeline order. */
  joins: Array<{ at: number; removed: TimeRange }>;
}

interface Pair { track: number; left: MediaClip; right: MediaClip; gap: number }

const plays = (clip: Clip): clip is MediaClip => clip.kind === "media" && clip.enabled !== false && (clip.speed ?? 1) === 1;
const pairKey = (left: MediaClip, right: MediaClip) => `${left.mediaId}:${left.sourceOut.toFixed(3)}:${right.sourceIn.toFixed(3)}`;

/** Every place on a track where one piece of a recording ends and another piece of the same recording begins. */
function pairs(timeline: Timeline): Pair[] {
  const found: Pair[] = [];
  timeline.tracks.forEach((track, index) => {
    const clips = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    for (let i = 1; i < clips.length; i++) {
      const left = clips[i - 1]!, right = clips[i]!;
      if (!plays(left) || !plays(right) || left.mediaId !== right.mediaId || Math.abs(clipEnd(left) - right.timelineIn) > 1e-3) continue;
      found.push({ track: index, left, right, gap: right.sourceIn - left.sourceOut });
    }
  });
  return found;
}

/**
 * The footage `after` left out where its pieces join, as against `before`: a join `before` already had is not this
 * version's. Null when it left nothing out.
 *
 * A join counts when every track that changes piece there skips the same stretch of its recording, as a screen and a
 * camera recorded together do. Tracks that skip different amounts, or step back in the recording, rearranged the
 * footage and took nothing out. Footage before the first piece counts when `before` was empty: the start of the
 * recording was left out. Footage after the last piece doesn't, since a version built in parts has more to come.
 */
export function leftOutJoins(before: Timeline, after: Timeline, fps = 30): LeftOut | null {
  const frame = 1 / fps;
  const known = new Set(pairs(before).map(p => pairKey(p.left, p.right)));
  const byTime = new Map<number, Pair[]>();
  for (const pair of pairs(after)) {
    const key = Math.round(pair.right.timelineIn * fps * 2);
    const group = byTime.get(key);
    if (group) group.push(pair); else byTime.set(key, [pair]);
  }
  const found: Array<{ at: number; gap: number; tracks: Set<number> }> = [];
  const head = timelineDuration(before) <= EPS ? after.tracks.flatMap((track, index) => {
    const first = track.clips.find(c => c.timelineIn <= EPS);
    return first && plays(first) ? [{ index, sourceIn: first.sourceIn }] : [];
  }) : [];
  const lead = head.length ? Math.min(...head.map(h => h.sourceIn)) : 0;
  if (lead > frame / 2) found.push({ at: 0, gap: lead, tracks: new Set(head.map(h => h.index)) });
  for (const group of [...byTime.values()]) {
    const gap = group[0]!.gap;
    if (gap <= frame / 2 || group.some(p => Math.abs(p.gap - gap) > frame) || group.every(p => known.has(pairKey(p.left, p.right)))) continue;
    found.push({ at: group[0]!.right.timelineIn, gap, tracks: new Set(group.map(p => p.track)) });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.at - b.at);

  let shift = 0;
  const joins = found.map(({ at, gap }) => {
    const start = at + shift;
    shift += gap;
    return { at, removed: { start, end: start + gap } };
  });
  const tracks = after.tracks.map((track, index) => {
    let clips = [...track.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    // Last join first, so each is opened at the time it has on `after`.
    for (let j = found.length - 1; j >= 0; j--) {
      const { at, gap, tracks: changing } = found[j]!;
      const next: Clip[] = [];
      for (const clip of clips) {
        if (clip.timelineIn >= at - 1e-3) next.push(shiftClip(clip, gap));
        else if (clipEnd(clip) > at + 1e-3) {
          // A clip that plays on through the join keeps playing through the footage put back, as far as it has any.
          const [left, right] = splitClip(clip, at, `${clip.id}_after${j}`);
          const more = left.kind === "media" && right.kind === "media" ? Math.min(gap, right.sourceOut - right.sourceIn) : 0;
          next.push(left.kind === "media" && more > 0 ? { ...left, sourceOut: left.sourceOut + more * (left.speed ?? 1) } : left, shiftClip(right, gap));
        } else next.push(clip);
      }
      clips = next;
      if (!changing.has(index)) continue;
      if (at <= EPS) {
        // The start of the recording: the first piece begins that much earlier.
        clips = clips.map((clip, i) => i === 0 && clip.kind === "media"
          ? { ...clip, timelineIn: 0, sourceIn: clip.sourceIn - gap, audioFadeIn: 0, videoFadeIn: 0 } : clip);
        continue;
      }
      // The piece before the join plays on to where the piece after it begins.
      const last = clips.findLastIndex(clip => clip.kind === "media" && Math.abs(clipEnd(clip) - at) <= 1e-3);
      const left = clips[last];
      if (left?.kind === "media") clips[last] = { ...left, sourceOut: left.sourceOut + gap, audioFadeOut: 0, videoFadeOut: 0 };
    }
    return { ...track, clips };
  });
  const markers = after.markers.map(marker => {
    const moved = (time: number) => time + found.reduce((sum, f) => f.at <= time + EPS ? sum + f.gap : sum, 0);
    return { ...marker, time: moved(marker.time), ...(marker.end !== undefined && { end: moved(marker.end) }) };
  });
  return { original: { ...after, tracks, markers }, joins };
}
