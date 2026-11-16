import type { MediaClip, Timeline, Transform, TransformKeyframe } from "@scarlet/timeline";

/** A clip an edit added that plays its recording full frame, beside a clip of the same recording that is framed. */
export interface UnframedClip {
  clipId: string;
  trackId: string;
  /** Where the added clip starts, in seconds on the edited timeline. */
  at: number;
  /** The framed clip beside it on the same track, and its framing. */
  beside: { clipId: string; transform?: Transform; keyframes?: TransformKeyframe[] };
}

const framed = (clip: MediaClip) => !!clip.transform || !!clip.keyframes?.length;

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
      if (existing.has(clip.id) || framed(clip)) return;
      const near = [clips[i - 1], clips[i + 1]].find(c => c && c.mediaId === clip.mediaId && framed(c));
      if (!near) return;
      found.push({ clipId: clip.id, trackId: track.id, at: Math.round(clip.timelineIn * 1000) / 1000,
        beside: { clipId: near.id, ...(near.transform && { transform: near.transform }), ...(near.keyframes?.length && { keyframes: near.keyframes }) } });
    });
  }
  return found;
}

export const UNFRAMED_NEXT = "Each clip in unframedBeside was added by this edit and plays its recording full frame, while the clip beside it on its track, from the same recording, is framed as shown. If it should look the same, give it that transform (and keyframes) with updateClip.";
