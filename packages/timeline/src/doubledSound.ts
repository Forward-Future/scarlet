import type { MediaAsset, MediaClip, Timeline, TimeRange } from "./schema.js";
import { clipEnd, timelineToSource } from "./time.js";

/** Two audible clips playing the same moment of the same recording at once, which the mix sums. */
export interface DoubledSound {
  mediaId: string;
  clipIds: [string, string];
  /** Timeline seconds where both play. */
  overlap: TimeRange;
  /** Seconds of the recording both play there. */
  source: TimeRange;
}

// The two copies line up to well under an audio sample at 48 kHz. Any farther apart is an offset someone placed, which
// can be shorter than a frame, so a frame is far too coarse a test.
const SAME_MOMENT = 1e-5;
// Shorter than half a sample at 48 kHz plays nothing.
const PLAYS = 0.5 / 48_000;

type Audio = Pick<MediaAsset, "id" | "kind" | "hasAudio">;
interface Heard { clip: MediaClip; start: number; end: number }

/** The clips the renderer mixes: enabled media with sound, at a volume above zero, on an unmuted video or audio track. */
function heardClips(timeline: Timeline, media: ReadonlyMap<string, Audio>): Map<string, Heard[]> {
  const byMedia = new Map<string, Heard[]>();
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || !(clip.volume > 0)) continue;
      const asset = media.get(clip.mediaId);
      if (!asset || (asset.kind !== "video" && asset.kind !== "audio") || asset.hasAudio === false) continue;
      const heard = byMedia.get(clip.mediaId) ?? [];
      heard.push({ clip, start: clip.timelineIn, end: clipEnd(clip) });
      byMedia.set(clip.mediaId, heard);
    }
  }
  return byMedia;
}

/** A crossfade overlaps its clips while one fades out and the other fades in, which is a join and not a second copy. */
function crossfades(a: Heard, b: Heard, overlap: TimeRange): boolean {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return overlap.start >= first.end - first.clip.audioFadeOut - PLAYS && overlap.end <= second.start + second.clip.audioFadeIn + PLAYS;
}

/** Every pair of audible clips that play the same moment of the same recording together, at the same speed. */
export function doubledSound(timeline: Timeline, media: Iterable<Audio>): DoubledSound[] {
  const assets = new Map([...media].map(m => [m.id, m] as const));
  const found: DoubledSound[] = [];
  for (const [mediaId, heard] of heardClips(timeline, assets)) {
    heard.sort((a, b) => a.start - b.start);
    for (let i = 0; i < heard.length; i++) {
      const a = heard[i]!;
      // Sorted by start, so the first clip that starts after this one ends ends the clips it can overlap.
      for (let j = i + 1; j < heard.length && heard[j]!.start < a.end - PLAYS; j++) {
        const b = heard[j]!;
        const overlap = { start: b.start, end: Math.min(a.end, b.end) };
        if (overlap.end - overlap.start < PLAYS) continue;
        if (Math.abs((a.clip.speed ?? 1) - (b.clip.speed ?? 1)) > 1e-9) continue;
        // Where the overlap starts, both clips play the same second of the recording.
        if (Math.abs(timelineToSource(a.clip, overlap.start) - timelineToSource(b.clip, overlap.start)) > SAME_MOMENT) continue;
        if (crossfades(a, b, overlap)) continue;
        found.push({ mediaId, clipIds: [a.clip.id, b.clip.id], overlap: { start: round3(overlap.start), end: round3(overlap.end) },
          source: { start: round3(timelineToSource(a.clip, overlap.start)), end: round3(timelineToSource(a.clip, overlap.end)) } });
      }
    }
  }
  return found;
}

/**
 * Doubled sound in `next` that `before` didn't already play: where an edit doubles a stretch of a recording more times
 * than `before` did. Clips layered on purpose that an edit splits or ripples get new ids, but they double nothing more,
 * so they aren't reported. Where a stretch is doubled more, the pairs `before` didn't have are the ones reported.
 */
export function introducedDoubledSound(before: Timeline | null, next: Timeline, media: Iterable<Audio>): DoubledSound[] {
  const assets = [...media];
  const had = before ? doubledSound(before, assets) : [];
  const now = doubledSound(next, assets);
  const pair = (d: DoubledSound) => [...d.clipIds].sort().join(" ");
  const oldPairs = new Set(had.map(pair));
  // How many pairs double the recording's second `at`.
  const copies = (pairs: DoubledSound[], mediaId: string, at: number) =>
    pairs.filter(d => d.mediaId === mediaId && d.source.start < at && d.source.end > at).length;
  const more = now.filter(d => {
    const edges = [...had, ...now].filter(o => o.mediaId === d.mediaId).flatMap(o => [o.source.start, o.source.end])
      .filter(t => t > d.source.start && t < d.source.end);
    const points = [d.source.start, ...edges.sort((a, b) => a - b), d.source.end];
    return points.slice(1).some((end, i) => {
      const at = (points[i]! + end) / 2;
      return end - points[i]! > 1e-6 && copies(now, d.mediaId, at) > copies(had, d.mediaId, at);
    });
  });
  // A pair `before` already had is reported only when no new pair doubles the same stretch: that one is the addition.
  return more.filter(d => !oldPairs.has(pair(d)) || !more.some(o => !oldPairs.has(pair(o)) && o.mediaId === d.mediaId &&
    o.source.start < d.source.end && o.source.end > d.source.start));
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
