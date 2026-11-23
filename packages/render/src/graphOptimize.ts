/**
 * Filter-graph optimization analyzers: occlusion culling, shared adjacent AVC
 * reads, and direct-picture pass-through eligibility.
 */
import { Transform as TransformSchema, parseColor } from "@scarlet/timeline";
import type { Clip, MediaAsset, MediaClip, Timeline, TimeRange } from "@scarlet/timeline";
import { effectKind } from "./effects.js";
import { fnum } from "./exec.js";
import { clipPlacement, type Placement } from "./graphTransform.js";
import { hasIndexedAvc, matchesCanvasFormat, type ProbeResult } from "./probe.js";
import type { TransitionMotion } from "./transitions.js";

export function hasIndexedClock(source: ProbeResult | undefined, fps: number | undefined): source is ProbeResult {
  return source?.videoCodec === "h264" && !!source.formatName?.split(",").includes("mov") && source.videoStreamCount === 1 &&
    !source.hasAlpha && source.fps === fps && source.previewClock?.startPts === 0 && source.videoStart === 0;
}

export interface SharedPictureRead {
  first: MediaClip;
  start: number;
  end: number;
  count: number;
}

/** A dialogue export often reopens the same 4K GOP on both sides of each
 * small deletion. Let nearby frame-aligned shots trim one bounded video read. */
export async function adjacentPictureReads(
  timeline: Timeline,
  range: TimeRange,
  media: Map<string, MediaAsset>,
  fps: number,
  covered: (track: number, placement: Placement) => boolean,
  getProbe: (asset: MediaAsset) => Promise<ProbeResult | undefined>,
): Promise<Map<MediaClip, SharedPictureRead>> {
  const reads = new Map<MediaClip, SharedPictureRead>();
  for (const [trackIndex, track] of timeline.tracks.entries()) {
    if (track.kind !== "video" || track.hidden) continue;
    let group: SharedPictureRead | undefined;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || clip.speed !== 1) continue;
      const p = clipPlacement(clip, range, 0.5 / fps);
      const asset = media.get(clip.mediaId);
      if (!p || covered(trackIndex, p) || !asset || !hasIndexedAvc(asset) ||
          asset.fps !== fps || (asset.width ?? 0) * (asset.height ?? 0) < 1920 * 1080) continue;
      const first = (clip.sourceIn + p.local0) * fps, last = first + p.vis * fps;
      const start = Math.round(first), end = Math.round(last);
      if (Math.abs(start - first) > 1e-6 || Math.abs(end - last) > 1e-6) continue;
      if (group && group.first.mediaId === clip.mediaId && start >= group.end && start - group.end <= 1.5 * fps &&
          end - group.start <= Math.min(10 * fps, 300) && group.count < 6) {
        group.end = end;
        group.count++;
        reads.set(group.first, group);
        reads.set(clip, group);
      } else {
        group = { first: clip, start, end, count: 1 };
      }
    }
  }
  // Verify candidate inputs once, including imports from before the catalog
  // recorded relative video origins. A lone or distant shot needs no probe.
  const rejected = new Set<string>();
  for (const id of new Set(Array.from(reads.keys(), clip => clip.mediaId))) {
    const source = await getProbe(media.get(id)!);
    if (!hasIndexedClock(source, fps)) rejected.add(id);
  }
  if (rejected.size) for (const clip of reads.keys()) if (rejected.has(clip.mediaId)) reads.delete(clip);
  return reads;
}

/** The contain-fit layer size `transformChain` produces, evaluated in the same order as ffmpeg. */
function fittedSize(iw: number, ih: number, W: number, H: number, scale: number) {
  const fit = Math.min(W / iw, H / ih);
  const s = Number(fnum(scale));
  return { w: Math.max(2, Math.trunc(iw * fit * s / 2) * 2), h: Math.max(2, Math.trunc(ih * fit * s / 2) * 2) };
}

/**
 * True only when every output pixel of the clip's visible window is an opaque
 * pixel of this clip: no alpha source, fade, opacity, keyframe, visual effect,
 * crop, rotation or offset, and a picture that fills the canvas.
 */
function coversCanvas(clip: Clip, p: Placement, media: Map<string, MediaAsset>, W: number, H: number, picture?: ProbeResult): boolean {
  if (clip.kind !== "media" && clip.kind !== "color") return false;
  if (clip.opacity < 1 || (clip.kind === "media" && clip.keyframes?.length)) return false;
  const tf = TransformSchema.parse(clip.transform ?? {});
  if (tf.rotation || tf.cropLeft || tf.cropRight || tf.cropTop || tf.cropBottom || tf.cornerRadius || tf.x || tf.y) return false;
  if (clip.kind === "color") {
    const color = parseColor(clip.color);
    if (!color || color.alpha < 1) return false;
    const { w, h } = fittedSize(W, H, W, H, tf.scale);
    return w >= W && h >= H;
  }
  if (clip.effects.some(effect => effect.enabled && effectKind(effect.type) !== "audio")) return false;
  if (clip.videoFadeIn > p.local0 + 1e-9) return false;
  if (clip.videoFadeOut > 0 && p.local0 + p.vis > p.clipDur - clip.videoFadeOut - 1e-9) return false;
  const asset = media.get(clip.mediaId);
  if (!asset || (asset.kind !== "video" && asset.kind !== "image") || asset.hasAlpha !== false || !asset.width || !asset.height) return false;
  // Overlay passes the lower layers through once a source runs out of pictures.
  if (asset.kind === "video") {
    const sourceStart = clip.sourceIn + p.local0 * clip.speed;
    const sourceEnd = sourceStart + p.vis * clip.speed;
    if (picture?.videoStart === undefined || !picture.videoDuration || !asset.duration ||
        sourceStart < picture.videoStart - 1e-6 || sourceEnd > Math.min(asset.duration, picture.videoStart + picture.videoDuration) + 1e-6) return false;
  }
  const { w, h } = fittedSize(asset.width, asset.height, W, H, tf.scale);
  return w >= W && h >= H;
}

/** Collect every opaque full-canvas clip interval on tracks above 0 so lower layers can skip video decode. */
export async function collectCanvasCovers(
  timeline: Timeline,
  range: TimeRange,
  media: Map<string, MediaAsset>,
  W: number,
  H: number,
  fps: number,
  motionsOf: (id: string) => TransitionMotion[],
  verifiedProbe: (asset: MediaAsset) => Promise<ProbeResult | undefined>,
): Promise<Array<{ track: number; start: number; end: number }>> {
  const covers: Array<{ track: number; start: number; end: number }> = [];
  for (const [trackIndex, track] of timeline.tracks.entries()) {
    if (trackIndex === 0 || track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.enabled === false || motionsOf(clip.id).length) continue;
      const p = clipPlacement(clip, range, 0.5 / fps);
      if (!p) continue;
      const asset = clip.kind === "media" ? media.get(clip.mediaId) : undefined;
      const picture = asset?.kind === "video" && asset.hasAlpha === false ? await verifiedProbe(asset) : undefined;
      if (coversCanvas(clip, p, media, W, H, picture)) covers.push({ track: trackIndex, start: p.pos, end: p.pos + p.vis });
    }
  }
  return covers;
}

/** A single opaque original can bypass the compositor when its unmodified frames occupy the entire section. */
export function directExportPicture(clip: MediaClip, p: Placement, asset: MediaAsset, probe: ProbeResult | undefined,
  width: number, height: number, fps: number, duration: number): boolean {
  if (asset.kind !== "video" || asset.hasAlpha !== false || asset.fps !== fps || clip.speed !== 1 || clip.opacity !== 1 ||
      clip.keyframes?.length || clip.videoFadeIn || clip.videoFadeOut || clip.effects.some(e => e.enabled && effectKind(e.type) !== "audio") ||
      p.pos !== 0 || Math.abs(p.vis - duration) > 1e-7) return false;
  if (clip.transform) return false;
  if (!probe || !matchesCanvasFormat(probe) || probe.width !== width || probe.height !== height || probe.videoStreamCount !== 1 ||
      probe.videoCodec !== "h264" || probe.videoCodecTag !== "avc1" || !probe.formatName?.split(",").includes("mov") ||
      probe.previewClock?.startPts !== 0 || probe.videoStart !== 0 || probe.fps !== fps || !probe.videoTimeBase ||
      !probe.videoDuration || !probe.videoFrameCount || Math.abs(probe.videoDuration * fps - probe.videoFrameCount) > 0.001) return false;
  const start = (clip.sourceIn + p.local0) * fps, frames = duration * fps;
  return Math.abs(start - Math.round(start)) < 1e-5 && Math.abs(frames - Math.round(frames)) < 1e-5 &&
    Math.round(start) + Math.round(frames) <= probe.videoFrameCount;
}
