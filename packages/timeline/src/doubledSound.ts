import type { MediaAsset, MediaClip, Timeline, TimeRange } from "./schema.js";
import { clipEnd, timelineToSource } from "./time.js";

/** Two audible clips playing the same moment of the same recording at once, which the mix sums. */
export interface DoubledSound {
  mediaId: string;
  clipIds: [string, string];
  /** Timeline seconds where both play. */
  overlap: TimeRange;
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
    for (const [i, a] of heard.entries()) {
      for (const b of heard.slice(i + 1)) {
        if (b.start >= a.end - PLAYS) break;
        const overlap = { start: b.start, end: Math.min(a.end, b.end) };
        if (overlap.end - overlap.start < PLAYS) continue;
        if (Math.abs((a.clip.speed ?? 1) - (b.clip.speed ?? 1)) > 1e-9) continue;
        // Where the overlap starts, both clips play the same second of the recording.
        if (Math.abs(timelineToSource(a.clip, overlap.start) - timelineToSource(b.clip, overlap.start)) > SAME_MOMENT) continue;
        if (crossfades(a, b, overlap)) continue;
        found.push({ mediaId, clipIds: [a.clip.id, b.clip.id], overlap: { start: round3(overlap.start), end: round3(overlap.end) } });
      }
    }
  }
  return found;
}

/** Doubled sound in `next` that `before` didn't already play: the pairs an edit introduced. */
export function introducedDoubledSound(before: Timeline | null, next: Timeline, media: Iterable<Audio>): DoubledSound[] {
  const assets = [...media];
  const pair = (d: DoubledSound) => [...d.clipIds].sort().join(" ");
  const had = new Set(before ? doubledSound(before, assets).map(pair) : []);
  return doubledSound(next, assets).filter(d => !had.has(pair(d)));
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
