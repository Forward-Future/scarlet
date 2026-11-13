/** What a timeline version shows at a moment, read from its clips' transforms: the same figures `locate` measures from a frame. */
import type { MediaClip, Timeline } from "../../packages/timeline/src/index.ts";
import { layerPlacement, type LayerTransform, type PictureSample, type Placement } from "./picture.ts";
import { clipLength } from "./timeline.ts";

type Keyed = MediaClip & { keyframes?: Array<{ time: number; transform: LayerTransform; ease?: string }> };

/** A clip's transform at a second of its own clock: keyframes blend in a straight line, and a hold keeps its value. */
export function transformAt(clip: Keyed, local: number): LayerTransform {
  const base: LayerTransform = { ...(clip.transform ?? {}) };
  const keys = [...(clip.keyframes ?? [])].sort((a, b) => a.time - b.time);
  if (!keys.length) return base;
  const out: Record<string, number> = { ...base } as Record<string, number>;
  for (const prop of new Set(keys.flatMap(k => Object.keys(k.transform)))) {
    const with_ = keys.filter(k => prop in k.transform) as Array<{ time: number; transform: Record<string, number>; ease?: string }>;
    const after = with_.findIndex(k => k.time > local);
    const a = with_[after < 0 ? with_.length - 1 : Math.max(0, after - 1)]!, b = after <= 0 ? undefined : with_[after];
    out[prop] = !b || a.ease === "hold" || b.time === a.time ? (after === 0 ? with_[0]! : a).transform[prop]!
      : a.transform[prop]! + (b.transform[prop]! - a.transform[prop]!) * (local - a.time) / (b.time - a.time);
  }
  return out;
}

/** Video layers on screen at a timeline second, lowest track first, with the recording second each plays. */
function layersAt(tl: Timeline, at: number): Array<{ clip: MediaClip; source: number }> {
  const out: Array<{ clip: MediaClip; source: number }> = [];
  for (const track of tl.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || clip.opacity === 0) continue;
      if (at < clip.timelineIn - 1e-6 || at >= clip.timelineIn + clipLength(clip) - 1e-6) continue;
      out.push({ clip, source: clip.sourceIn + (at - clip.timelineIn) * (clip.speed ?? 1) });
    }
  }
  return out;
}

/** The timeline second at which a version plays this second of a recording, if it does. */
export function timelineSecond(tl: Timeline, mediaId: string, source: number): number | undefined {
  for (const track of tl.tracks) {
    if (track.kind === "caption") continue;
    for (const clip of track.clips) {
      if (clip.kind === "media" && clip.enabled !== false && clip.mediaId === mediaId && source >= clip.sourceIn - 1e-6 && source < clip.sourceOut - 1e-6) {
        return clip.timelineIn + (source - clip.sourceIn) / (clip.speed ?? 1);
      }
    }
  }
  return undefined;
}

/** The recording second every layer plays while the presenter's recording plays `source`: their sync, from a version that has them together. */
export function syncedSources(tl: Timeline, mediaId: string, source: number): Record<string, number> | undefined {
  const at = timelineSecond(tl, mediaId, source);
  return at === undefined ? undefined : Object.fromEntries(layersAt(tl, at).map(l => [l.clip.mediaId, l.source]));
}

/** What a version shows while the presenter's recording plays `source`. A layer under one that covers the frame is hidden. */
export function pictureAt(tl: Timeline, mediaId: string, source: number): PictureSample | undefined {
  const t = timelineSecond(tl, mediaId, source);
  if (t === undefined) return undefined;
  const layers: Record<string, Placement> = {};
  for (const { clip } of layersAt(tl, t).reverse()) {
    const placed = layerPlacement(transformAt(clip as Keyed, t - clip.timelineIn));
    if (!placed) continue;
    layers[clip.mediaId] ??= placed;
    if (placed.rect.w * placed.rect.h >= 0.98) break;
  }
  return { t, mediaId, source, layers };
}
