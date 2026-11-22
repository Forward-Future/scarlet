/**
 * Content-addressed segment cache keying and external LUT fingerprinting.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { sha256, SOURCE_PREVIEW_SECONDS, stableStringify } from "@scarlet/timeline";
import type { Clip, MediaAsset, Project, Timeline, TimeRange, Track, TransitionPlan } from "@scarlet/timeline";
import { fileInDirectory } from "./assetPath.js";
import { effectKind } from "./effects.js";
import { fnum } from "./exec.js";
import { clipPlacement, fillsFrames, holdsFrame, holdsSample, proxyHeightForClip, videoClockStart } from "./graph.js";
import { isMovingAsset, isStillAsset } from "./probe.js";
import { outputSize, type RenderQuality } from "./render.js";
import { motionsIn, planTransitions, type TransitionMotion } from "./transitions.js";

export const RENDER_REVISION = 5;
export const PROXY_CLOCK_REVISION = 3;
export const DELIVERY_AUDIO_REVISION = 4;
export const TRANSITION_RENDER_REVISION = 1;

export interface SegmentKeyOptions {
  quality: RenderQuality;
  /** Preview canvas height actually used. */
  height?: number;
  encoder?: string;
  pictureOnly?: boolean;
  /** Keep proxy-eligible previews separate from renders which require original pictures. */
  allowProxy?: boolean;
}

export interface SegmentInfo {
  range: TimeRange;
  key: string;
  file: string;
  /** True when the segment was already in the cache. */
  cached: boolean;
}

/** Old cache entries did not record whether the graph selected a proxy. Only
 * version windows where it could have selected one with a different origin. */
export function usesRevisedProxyClock(project: Project, timeline: Timeline, range: TimeRange, height?: number,
  assets = new Map(project.media.map(asset => [asset.id, asset]))): boolean {
  const size = outputSize(project.settings, "preview", height);
  return timeline.tracks.some(track => track.kind === "video" && !track.hidden && track.clips.some(clip => {
    if (clip.kind !== "media" || clip.enabled === false) return false;
    const asset = assets.get(clip.mediaId);
    if (!asset || asset.hasAlpha !== false || !asset.fps || !asset.height || !isMovingAsset(asset)) return false;
    const placement = clipPlacement(clip, range, 0.5 / project.settings.fps);
    if (!placement) return false;
    const needed = proxyHeightForClip(clip, asset, size.width, size.height);
    if (needed === undefined || needed > Math.min(720, asset.height)) return false;
    // Stored absolute PTS alone cannot rule out leading audio in an older file.
    if (asset.previewClock?.videoStart !== 0) return true;
    const framesPerChunk = asset.fps * SOURCE_PREVIEW_SECONDS;
    const sourceEnd = clip.sourceIn + (placement.local0 + placement.vis) * clip.speed;
    return asset.previewClock.startPts === 0 && needed <= Math.min(480, asset.height) &&
      Math.abs(framesPerChunk - Math.round(framesPerChunk)) > 1e-6 && sourceEnd > SOURCE_PREVIEW_SECONDS;
  }));
}

function mediaFingerprint(asset: MediaAsset | undefined, format: SegmentKeyOptions) {
  if (!asset) return null;
  // Prefer the content hash; fall back to the path (then edits in place go unnoticed).
  return {
    hash: asset.hash ?? null,
    path: asset.hash ? undefined : asset.path,
    kind: asset.kind,
    hasAudio: format.pictureOnly ? undefined : asset.hasAudio,
    sourceAlpha: format.pictureOnly || format.allowProxy ? asset.hasAlpha : undefined,
    proxyGeometry: format.allowProxy ? [asset.width, asset.height, asset.fps, asset.previewClock] : undefined,
  };
}

/** Fingerprint times at the precision passed to FFmpeg. Include sample offsets
 * separately: adelay rounds to samples before formatting its argument. */
function segmentClip(clip: Clip, range: TimeRange, media: Map<string, MediaAsset>, settings: Project["settings"], track: Pick<Track, "kind" | "hidden" | "muted">, format: SegmentKeyOptions,
  motions?: readonly TransitionMotion[]) {
  const p = clipPlacement(clip, range, 0.5 / settings.sampleRate);
  if (!p) return undefined;
  // A transition's movement in this section, on the section's own clock. Absent for every clip none moves, so their
  // part of the key is as it was.
  const moving = motionsIn(motions, range.start, range.end).map(m => ({ ...m, start: fnum(m.start), end: fnum(m.end) }));
  const motion = moving.length ? moving : undefined;
  const source = clip.kind === "media" ? media.get(clip.mediaId) : undefined;
  const still = !!source && isStillAsset(source);
  // As the graph places it: a clip is in a section for a frame of its picture or, with less than that, for a sample
  // of sound that is heard, from a file that has some.
  const heard = clip.kind === "media" && !format.pictureOnly && !track.muted && clip.volume > 0 && !!source && !still &&
    (source.kind === "audio" || source.hasAudio !== false) && holdsSample(p.vis * (clip.speed ?? 1), settings.sampleRate);
  if (track.kind !== "audio" && !holdsFrame(p, settings.fps, still) && !heard) return undefined;
  const { id: _id, label: _label, timelineIn, ...rest } = clip;
  const placement = { start: fnum(p.pos), end: fnum(p.pos + p.vis), duration: fnum(p.vis) };
  if (rest.kind !== "media") {
    const { timelineOut: _out, ...visual } = rest;
    return { ...visual, placement, motion };
  }
  // The transition into a clip is drawn from `motion`, where it shows; elsewhere it changes nothing.
  delete (rest as Partial<typeof rest> & { transitionIn?: unknown }).transitionIn;
  const asset = media.get(rest.mediaId);
  // Footage off the project's frames is drawn filled to them. Saying so here sets its sections apart from the ones
  // cached before it was, and leaves every other clip's part of the key as it has been.
  const frameFill = (track.kind === "video" && !track.hidden && !!asset && fillsFrames(rest, asset, settings.fps)) || undefined;
  if (!asset?.hash || rest.effects.some(effect => effect.enabled && effect.type === "lut")) {
    // Pending/legacy sources and external LUTs retain the old placement-sensitive identity.
    return { ...rest, timelineIn, range, media: mediaFingerprint(asset, format), frameFill, motion };
  }
  const { sourceIn, sourceOut: _out, ...input } = rest;
  const videoStart = videoClockStart(rest, p.local0);
  const audioStart = rest.audioFadeIn || rest.audioFadeOut ? p.local0 : 0;
  const fadeStart = (duration: number) => {
    const start = Math.max(0, p.clipDur - duration);
    return duration > 0 && start <= p.local0 + p.vis + 1 / settings.fps ? fnum(start) : undefined;
  };
  return { ...input, placement, media: mediaFingerprint(asset, format),
    seek: fnum(sourceIn + p.local0 * rest.speed), sourceDuration: fnum(p.vis * rest.speed),
    videoStart: fnum(videoStart), audioStart: fnum(audioStart), shift: fnum(p.pos - videoStart), delaySamples: format.pictureOnly ? undefined : Math.round(p.pos * settings.sampleRate),
    videoFadeStart: fadeStart(rest.videoFadeOut), audioFadeStart: fadeStart(rest.audioFadeOut), frameFill, motion };
}

/** Fingerprint the rendered window independently of its absolute timeline position. */
export function segmentKey(
  project: Project,
  timeline: Timeline,
  range: TimeRange,
  quality: RenderQuality | SegmentKeyOptions,
  media = new Map(project.media.map(asset => [asset.id, asset])),
  legacyTransitions = false,
): string {
  // As the graph draws it: transitions add layers around their joins and move the clips either side.
  const transitions = planTransitions(timeline, media, project.settings.fps);
  return plannedSegmentKey(project, transitions.timeline, range, typeof quality === "string" ? { quality } : quality, media, transitions, legacyTransitions);
}

export function plannedSegmentKey(project: Project, timeline: Timeline, range: TimeRange, o: SegmentKeyOptions,
  media: Map<string, MediaAsset>, transitions: TransitionPlan, legacyTransitions = false): string {
  const tracks = timeline.tracks
    .map((t) => {
      const clips = t.clips.filter(c => c.enabled !== false)
        .map(c => segmentClip(c, range, media, project.settings, t, o,
          legacyTransitions && c.kind !== "media" ? undefined : transitions.motions.get(c.id))).filter(c => c !== undefined);
      return { kind: t.kind, muted: t.muted, hidden: t.hidden, captionStyle: t.captionStyle, clips };
    })
    .filter((t) => t.clips.length > 0);
  return createHash("sha256").update(stableStringify({
    v: RENDER_REVISION,
    transitions: !legacyTransitions && tracks.some(track => track.clips.some(clip => clip.motion)) ? TRANSITION_RENDER_REVISION : undefined,
    proxyClock: o.allowProxy && o.quality === "preview" && !o.pictureOnly && usesRevisedProxyClock(project, timeline, range, o.height, media) ? PROXY_CLOCK_REVISION : undefined,
    pictureOnly: o.pictureOnly || undefined,
    allowProxy: o.allowProxy || undefined,
    settings: o.pictureOnly ? { width: project.settings.width, height: project.settings.height, fps: project.settings.fps } : project.settings,
    background: timeline.background,
    captionStyle: timeline.captionStyle ?? null,
    quality: o.quality,
    height: o.height ?? null,
    encoder: o.encoder ?? null,
    duration: fnum(range.end - range.start),
    tracks,
  })).digest("hex");
}

/** Plan and key delivery picture independently of audio cuts, gain, channel routing and fades. */
export function deliveryPicture(project: Project, timeline: Timeline): Timeline {
  const audioAssets = new Set(project.media.filter(asset => asset.kind === "audio").map(asset => asset.id));
  const tracks = timeline.tracks
    .filter(track => track.kind !== "audio" && !track.hidden)
    .map(track => {
      const clips = track.clips
        .filter(clip => clip.enabled !== false && (clip.kind !== "media" || !audioAssets.has(clip.mediaId)))
        .map(clip => clip.kind !== "media" ? clip : {
          ...clip, volume: 0, audioFadeIn: 0, audioFadeOut: 0,
          effects: clip.effects.filter(effect => effectKind(effect.type) !== "audio"),
        });
      return { ...track, muted: false, clips };
    });
  return { ...timeline, tracks };
}

/** A LUT is an external file rather than an immutable media row. Include its current identity in cached pictures. */
export function lutFileStamps(timeline: Timeline, mediaRoot: string) {
  const names = new Set<string>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.kind !== "media" || clip.enabled === false) continue;
    for (const effect of clip.effects) {
      if (effect.type !== "lut" || !effect.enabled) continue;
      const name = typeof effect.params.file === "string" ? effect.params.file : effect.params.path;
      if (typeof name === "string") names.add(name);
    }
  }
  return [...names].sort().map(name => {
    const file = fileInDirectory(mediaRoot, name);
    const info = file && statSync(file, { throwIfNoEntry: false });
    return [name, info ? [file, info.size, info.mtimeMs, info.ctimeMs] : null];
  });
}

export function segmentInfo(project: Project, timeline: Timeline, range: TimeRange, cacheDir: string, format: SegmentKeyOptions,
  mediaRoot: string, media: Map<string, MediaAsset>, transitions: TransitionPlan): SegmentInfo {
  let key = plannedSegmentKey(project, timeline, range, format, media, transitions);
  const luts = lutFileStamps(timeline, mediaRoot);
  if (luts.length) key = sha256(stableStringify([key, luts]));
  const file = path.join(cacheDir, `${key}.mp4`);
  return { range, key, file, cached: false };
}
