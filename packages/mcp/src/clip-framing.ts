import { clipEnd, Transform as TransformSchema, type MediaAsset, type MediaClip, type Timeline, type Transform, type TransformKeyframe } from "@scarlet/timeline";
import { round2, round3 } from "./analysis.js";
import { clipFramingKey, isClipFramed, pictureBox, type Box } from "./framing.js";

/** A clip an edit added that plays its recording full frame, beside a clip of the same recording that is framed. */
export interface UnframedClip {
  clipId: string;
  trackId: string;
  /** Where the added clip starts, in seconds on the edited timeline. */
  at: number;
  /** The framed clip beside it on the same track, and its framing. */
  beside: { clipId: string; transform?: Transform; keyframes?: TransformKeyframe[] };
}

/**
 * Footage an edit puts back or copies arrives as new clips, which play their recording full frame unless the edit
 * frames them. Beside clips of the same recording that are zoomed or inset, that shows as a jump: a speed-up put a
 * 16 s wait back with the camera filling the frame and the screen unzoomed, between clips with the camera in the corner
 * (2026-11-15), and a cold open's first draft did the same. The agent reads this as evidence; whether the new clip
 * should match is its call.
 */
export function unframedBeside(before: Timeline | null, after: Timeline): UnframedClip[] {
  const existing = new Set(before?.tracks.flatMap(t => t.clips.map(c => c.id)) ?? []);
  const found: UnframedClip[] = [];
  for (const track of after.tracks) {
    if (track.kind !== "video") continue;
    const clips = track.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false)
      .sort((a, b) => a.timelineIn - b.timelineIn);
    clips.forEach((clip, i) => {
      if (existing.has(clip.id) || isClipFramed(clip)) return;
      const near = [clips[i - 1], clips[i + 1]].find(c => c && c.mediaId === clip.mediaId && isClipFramed(c));
      if (!near) return;
      found.push({ clipId: clip.id, trackId: track.id, at: round3(clip.timelineIn),
        beside: { clipId: near.id, ...(near.transform && { transform: near.transform }), ...(near.keyframes?.length && { keyframes: near.keyframes }) } });
    });
  }
  return found;
}

export const UNFRAMED_NEXT = "Each clip in unframedBeside was added by this edit and plays its recording full frame, while the clip beside it on its track, from the same recording, is framed as shown. If it should look the same, give it that transform (and keyframes) with updateClip.";

/** A stretch of the edit where this edit's framing leaves the timeline's background showing. */
export interface BackgroundShown {
  /** Timeline seconds, over the clips in a row that leave the same share showing. */
  from: number; to: number;
  /** The first of those clips, and how many there are. */
  clipId: string; clips: number;
  /** The share of the video that no picture covers there. */
  share: number;
}

/** The area a set of boxes covers together, inside the unit square. */
function covered(boxes: readonly Box[]) {
  const xs = [...new Set(boxes.flatMap(b => [b[0], b[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap(b => [b[1], b[3]]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    const x = (xs[i]! + xs[i + 1]!) / 2, y = (ys[j]! + ys[j + 1]!) / 2;
    if (boxes.some(b => x > b[0] && x < b[2] && y > b[1] && y < b[3])) total += (xs[i + 1]! - xs[i]!) * (ys[j + 1]! - ys[j]!);
  }
  return total;
}

/**
 * Where the pictures an edit framed leave part of the video uncovered, so the timeline's background shows there. A
 * crop to an area that isn't the canvas's shape does it: a pass framed its screen demos that way and filled 49–80% of
 * the frame's width, and nothing it read back said so (2026-11-16). Read from each clip the edit added or framed, at
 * its first frame, with every opaque picture playing there. Whether the background should show is the agent's call.
 */
export function backgroundShows(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number }): BackgroundShown[] {
  const was = new Map(before?.tracks.flatMap(t => t.clips.map(c => [c.id, c] as const)) ?? []);
  const assets = new Map(media.map(m => [m.id, m]));
  const opaque = (c: MediaClip) => c.enabled !== false && c.opacity > 0 && !!assets.get(c.mediaId) && assets.get(c.mediaId)!.kind !== "graphic" && !assets.get(c.mediaId)!.hasAlpha;
  const tracks = after.tracks.filter(track => track.kind === "video" && !track.hidden)
    .map(track => track.clips.filter((c): c is MediaClip => c.kind === "media" && opaque(c)).sort((a, b) => a.timelineIn - b.timelineIn));
  const layers = tracks.flat();
  const size = (clip: MediaClip) => ({ width: assets.get(clip.mediaId)!.width || canvas.width, height: assets.get(clip.mediaId)!.height || canvas.height });
  const found: BackgroundShown[] = [];
  for (const clips of tracks) {
    let last: BackgroundShown | undefined;
    for (const clip of clips) {
      const old = was.get(clip.id);
      if (!isClipFramed(clip) || (old?.kind === "media" && clipFramingKey(old) === clipFramingKey(clip))) continue;
      const at = clip.timelineIn + Math.min(0.05, (clipEnd(clip) - clip.timelineIn) / 2);
      const playing = layers.filter(l => l.timelineIn <= at && at < clipEnd(l));
      if (playing.some(l => l.transform?.rotation)) continue;
      const boxes = playing.map(l => pictureBox(l, at - l.timelineIn, size(l), canvas))
        .map(([l, t, r, b]): Box => [Math.max(0, l), Math.max(0, t), Math.min(1, r), Math.min(1, b)]).filter(b => b[2] > b[0] && b[3] > b[1]);
      const share = round2(1 - covered(boxes));
      if (share < 0.02) continue;
      if (last && last.share === share && Math.abs(last.to - clip.timelineIn) < 0.05) { last.to = round3(clipEnd(clip)); last.clips++; }
      else found.push(last = { from: round3(clip.timelineIn), to: round3(clipEnd(clip)), clipId: clip.id, clips: 1, share });
    }
  }
  found.sort((a, b) => a.from - b.from);
  return found.slice(0, 20);
}

export const BACKGROUND_NEXT = "Each stretch in backgroundShows plays with that share of the video uncovered by any picture, so the timeline's background shows there: a crop that isn't the video's shape leaves it at the sides. If the picture should fill the video, timeline_framing frames it on an area with none showing.";

/** An inset an edit set: a picture laid over part of another, cropped and sized a way the video didn't have before. */
export interface InsetToLook {
  mediaId: string;
  trackId: string;
  /** The area of its recording the inset shows, as fractions of the source picture: left, top, right, bottom. */
  crop: Box;
  /** Its clips in the edit with this crop and size. */
  clips: number;
  /** Source seconds to look at it, spread over those clips. */
  at: number[];
}

/** Insets an edit set and the moments to look at each, at most this many insets. */
const INSETS_TO_LOOK = 2;
const LOOKS_PER_INSET = 3;

/**
 * The insets an edit set with a crop or size the video didn't have, and when to look at each. A pass cropped the
 * camera inset in a new studio by numbers alone, checked it on contact-sheet tiles where the inset was about 100 px
 * wide, and cut off the top of the editor's head for the whole video (2026-11-18). A close look at what the crop
 * shows of the recording, at a few moments, lets the agent judge it; whether it frames the subject well is its call.
 */
export function insetsToLook(before: Timeline | null, after: Timeline, media: readonly MediaAsset[], canvas: { width: number; height: number }): InsetToLook[] {
  const assets = new Map(media.map(m => [m.id, m]));
  const opaque = (c: MediaClip) => c.enabled !== false && c.opacity > 0 && !!assets.get(c.mediaId) && assets.get(c.mediaId)!.kind !== "graphic" && !assets.get(c.mediaId)!.hasAlpha;
  const size = (clip: MediaClip) => ({ width: assets.get(clip.mediaId)!.width || canvas.width, height: assets.get(clip.mediaId)!.height || canvas.height });
  const key = (clip: MediaClip) => {
    const t = TransformSchema.parse(clip.transform ?? {});
    return JSON.stringify([clip.mediaId, t.cropLeft, t.cropTop, t.cropRight, t.cropBottom, t.scale]);
  };
  /** The insets of a timeline: clips on a video track above the lowest one with pictures, covering part of the video. */
  const insets = (timeline: Timeline) => {
    const tracks = timeline.tracks.filter(track => track.kind === "video" && !track.hidden)
      .map(track => ({ track, clips: track.clips.filter((c): c is MediaClip => c.kind === "media" && opaque(c)) }))
      .filter(t => t.clips.length);
    return tracks.slice(1).flatMap(({ track, clips }) => clips.filter(clip => {
      if (clip.transform?.rotation || assets.get(clip.mediaId)!.kind !== "video") return false;
      const [l, t, r, b] = pictureBox(clip, 0, size(clip), canvas);
      const shown = Math.max(0, Math.min(1, r) - Math.max(0, l)) * Math.max(0, Math.min(1, b) - Math.max(0, t));
      return shown > 0.001 && shown < 0.9;
    }).map(clip => ({ clip, trackId: track.id })));
  };
  const had = new Set(before ? insets(before).map(({ clip }) => key(clip)) : []);
  const groups = new Map<string, { trackId: string; clips: MediaClip[] }>();
  for (const { clip, trackId } of insets(after)) {
    const k = key(clip);
    if (had.has(k)) continue;
    const group = groups.get(k) ?? { trackId, clips: [] };
    group.clips.push(clip);
    groups.set(k, group);
  }
  return [...groups.values()].sort((a, b) => b.clips.length - a.clips.length).slice(0, INSETS_TO_LOOK).map(({ trackId, clips }) => {
    const sorted = [...clips].sort((a, b) => a.timelineIn - b.timelineIn);
    const t = TransformSchema.parse(sorted[0]!.transform ?? {});
    const picks = sorted.length <= LOOKS_PER_INSET ? sorted
      : Array.from({ length: LOOKS_PER_INSET }, (_, i) => sorted[Math.round(i * (sorted.length - 1) / (LOOKS_PER_INSET - 1))]!);
    return {
      mediaId: sorted[0]!.mediaId, trackId, clips: sorted.length,
      crop: [t.cropLeft, t.cropTop, 1 - t.cropRight, 1 - t.cropBottom],
      at: [...new Set(picks.map(c => round3(c.sourceIn + (c.sourceOut - c.sourceIn) / 2)))],
    };
  });
}

/** Pixels wide of a close look at an inset: about the inset's own size in a 1080p video and up, so a head's edge shows. */
export const INSET_LOOK_WIDTH = 640;
export const INSET_LOOK_NEXT = "insetLook lists each inset this edit cropped or sized anew, with its crop in percent of its recording, and the pictures after this result show all of it at those source seconds, close up. The crop holds for every clip listed: look at what it shows of its subject at each moment.";
