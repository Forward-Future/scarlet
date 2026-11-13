import { indexClipsAt, timelineToSource, type MediaAsset, type Project, type Timeline } from "@scarlet/timeline";
import { api, IS_MOCK } from "../../lib/client";

/** Foreground frames take the next free decoder. */
export function interactiveFrameUrl(src: string | undefined, width?: number) {
  if (!src) return src;
  const url = new URL(src, window.location.href);
  if (!url.pathname.endsWith("/frame")) return src;
  if (width) url.searchParams.set("w", String(width));
  url.searchParams.set("priority", "interactive");
  return url.toString();
}

const clipIndexes = new WeakMap<Timeline, ReturnType<typeof indexClipsAt>>();
const mediaIndexes = new WeakMap<readonly MediaAsset[], Map<string, MediaAsset>>();
/** Scrubbing and the original waveform sample the same immutable media list many times. */
export function mediaAtId(media: readonly MediaAsset[], id: string) {
  let index = mediaIndexes.get(media);
  if (!index) {
    index = new Map(media.map(asset => [asset.id, asset]));
    mediaIndexes.set(media, index);
  }
  return index.get(id);
}

function clipsAt(timeline: Timeline, t: number) {
  let index = clipIndexes.get(timeline);
  if (!index) {
    index = indexClipsAt(timeline);
    clipIndexes.set(timeline, index);
  }
  return index(t);
}

function visibleClip(hits: ReturnType<typeof clipsAt>, media?: readonly MediaAsset[]) {
  // Tracks composite bottom to top. A solid color can also cover a lower video.
  return hits.findLast(({ track, clip }) =>
    track.kind === "video" && !track.hidden && clip.enabled !== false &&
    (clip.kind === "color" || (clip.kind === "media" && (!media || isPicture(mediaAtId(media, clip.mediaId)))))
  )?.clip;
}

function isPicture(asset?: MediaAsset) {
  return !!asset && asset.kind !== "audio";
}

export function visibleClipAt(timeline: Timeline | null, t: number, media?: readonly MediaAsset[]) {
  return timeline && visibleClip(clipsAt(timeline, t), media);
}

/** Source played by the original-footage comparison, including audio-only sources. */
export function originalClipAt(timeline: Timeline, at: number, media: readonly MediaAsset[]) {
  const hits = clipsAt(timeline, at);
  return visibleClip(hits, media) ?? hits.find(({ track, clip }) =>
      track.kind === "audio" && !track.muted && clip.enabled !== false && clip.kind === "media")?.clip;
}

/** A still from the source media under timeline time `t`, if the cut has video there. */
export function thumbUrl(timeline: Timeline | null, t: number, width = 160): string | undefined {
  const clip = visibleClipAt(timeline, t);
  if (clip?.kind === "media") return api.frameUrl(clip.mediaId, timelineToSource(clip, t), width);
}

/** Hover previews share quarter-second stills. Filmstrip samples use the source frame at the selected time. */
export function scrubFrameUrl(source: MediaAsset | undefined, timeline: Timeline | null, media: readonly MediaAsset[], t: number, exact = false) {
  let start = 0;
  if (!source) {
    const clip = visibleClipAt(timeline, t, media);
    if (clip?.kind !== "media") return;
    source = mediaAtId(media, clip.mediaId);
    start = clip.sourceIn;
    t = timelineToSource(clip, t);
  }
  if (!source || source.kind === "audio") return;
  const rate = exact ? source.fps : 4;
  const sample = source.kind === "image" ? 0 : Math.max(start, rate ? Math.floor(t * rate + 1e-7) / rate : t);
  return api.frameUrl(source.id, sample, 160);
}

/** Versioned cut frames include the effects, layers and captions visible in playback. */
export function cutFrameUrl(project: Project, timeline: Timeline | null | undefined, t: number, exact = false, monitor = false) {
  if (!timeline) return;
  if (IS_MOCK) return scrubFrameUrl(undefined, timeline, project.media, t, exact);
  const { width, height, fps } = project.settings;
  const sample = exact ? t : Math.floor(t * 4) / 4;
  const url = new URL(api.fileUrl(`/projects/${encodeURIComponent(project.id)}/versions/${encodeURIComponent(timeline.version)}/frame`));
  if (monitor) url.searchParams.set("view", "monitor");
  url.searchParams.set("frame", String(Math.floor(sample * fps + 1e-7)));
  url.searchParams.set("format", `${width}x${height}@${fps}`);
  return url.toString();
}
