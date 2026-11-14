/**
 * OpenTimelineIO export. DaVinci Resolve imports .otio natively
 * (File → Import → Timeline). We emit the otio_json schema v1 subset that
 * Resolve understands: Timeline → Stack → Track → Clip/Gap with
 * ExternalReference media.
 */
import type { Clip, MediaAsset, Project, Timeline, Track } from "./schema.js";
import { clipDuration, clipEnd } from "./time.js";

type OtioRationalTime = { OTIO_SCHEMA: "RationalTime.1"; rate: number; value: number };
type OtioTimeRange = { OTIO_SCHEMA: "TimeRange.1"; duration: OtioRationalTime; start_time: OtioRationalTime };

function rt(seconds: number, rate: number, preserveSubframes = false): OtioRationalTime {
  return frameTime(seconds * rate, rate, preserveSubframes);
}
function frameTime(frames: number, rate: number, preserveSubframes = false): OtioRationalTime {
  const whole = Math.round(frames);
  return { OTIO_SCHEMA: "RationalTime.1", rate, value: preserveSubframes && Math.abs(frames - whole) > 1e-7 ? frames : whole };
}
function tr(start: number, duration: number, rate: number, preserveSubframes = false): OtioTimeRange {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: rt(start, rate, preserveSubframes), duration: rt(duration, rate, preserveSubframes) };
}
/** A range from a start in seconds, with a length already counted in frames. */
function framesRange(start: number, frames: number, rate: number, preserveSubframes = false): OtioTimeRange {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: rt(start, rate, preserveSubframes), duration: frameTime(frames, rate, preserveSubframes) };
}
/**
 * OTIO plays a track's children end to end, so each item's length runs from the frame nearest its start to the frame
 * nearest its end on the timeline. Rounding each length on its own would add up along the track.
 */
function timelineFrames(start: number, end: number, rate: number): number {
  return Math.max(0, Math.round(end * rate) - Math.round(start * rate));
}

export interface OtioExportOptions {
  /** Resolve media paths relative to this absolute root (file:// URLs). */
  mediaRoot?: string;
  /** Include caption tracks as markers on the timeline (Resolve has no OTIO subtitle import). */
  captionsAsMarkers?: boolean;
}

export function toOtio(project: Project, timeline: Timeline, opts: OtioExportOptions = {}): unknown {
  const rate = project.settings.fps;
  const media = new Map(project.media.map((m) => [m.id, m]));
  const captionsAsMarkers = opts.captionsAsMarkers ?? true;

  const tracks: unknown[] = [];
  // Resolve expects video tracks listed bottom-up (V1 first) then audio tracks.
  const video = timeline.tracks.filter((t) => t.kind === "video");
  const audio = timeline.tracks.filter((t) => t.kind === "audio");
  for (const t of video) tracks.push(...otioTracks(t, "Video", rate, media, opts));
  for (const t of audio) tracks.push(...otioTracks(t, "Audio", rate, media, opts));

  const markers: unknown[] = timeline.markers.map((m) => ({
    OTIO_SCHEMA: "Marker.2",
    name: m.text,
    color: m.kind === "todo" ? "RED" : m.kind === "chapter" ? "BLUE" : "GREEN",
    marked_range: tr(m.time, Math.max(m.end !== undefined ? m.end - m.time : 0, 1 / rate), rate),
    metadata: { scarlet: { id: m.id, kind: m.kind, author: m.author ?? null, noteId: m.noteId ?? null } },
  }));
  if (captionsAsMarkers) {
    for (const t of timeline.tracks.filter((t) => t.kind === "caption")) {
      for (const c of t.clips) {
        if (c.kind !== "caption") continue;
        markers.push({
          OTIO_SCHEMA: "Marker.2",
          name: c.text,
          color: "YELLOW",
          marked_range: tr(c.timelineIn, clipDuration(c), rate),
          metadata: { scarlet: { caption: true, clipId: c.id } },
        });
      }
    }
  }

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: `${project.name} — ${timeline.name}`,
    global_start_time: rt(0, rate),
    metadata: {
      scarlet: {
        projectId: project.id,
        version: timeline.version,
        width: project.settings.width,
        height: project.settings.height,
        fps: rate,
      },
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: tracks,
      markers,
      metadata: {},
      source_range: null,
      effects: [],
    },
  };
}

/** OTIO track children play sequentially. Give overlapping clips parallel
 * tracks, with each new clip above every earlier clip it overlaps. */
function otioTracks(track: Track, kind: "Video" | "Audio", rate: number, media: Map<string, MediaAsset>, opts: OtioExportOptions): unknown[] {
  const lanes: Array<{ clips: Clip[]; end: number }> = [{ clips: [], end: 0 }];
  for (const clip of track.clips) {
    if (clip.enabled === false) continue;
    const end = clipEnd(clip);
    let lane = lanes.length - 1;
    while (lane >= 0) {
      const prior = lanes[lane]!;
      // After ripples, neighbours can overlap in the thirteenth decimal. That is a join, not a second layer.
      if (prior.end > clip.timelineIn + 1e-6 && prior.clips.some((c) => c.timelineIn < end - 1e-6 && clip.timelineIn < clipEnd(c) - 1e-6)) break;
      lane--;
    }
    const target = lanes[lane + 1] ?? (lanes[lane + 1] = { clips: [], end: 0 });
    target.clips.push(clip);
    target.end = Math.max(target.end, end);
  }
  return lanes.map((lane, layer) => otioTrack(track, lane.clips, layer, kind, rate, media, opts));
}

function otioTrack(
  track: Track, clips: Clip[], layer: number, kind: "Video" | "Audio", rate: number,
  media: Map<string, MediaAsset>, opts: OtioExportOptions,
): unknown {
  const children: unknown[] = [];
  let cursor = 0;
  clips.sort((a, b) => a.timelineIn - b.timelineIn);
  for (const clip of clips) {
    if (clip.timelineIn > cursor + 1e-6) {
      children.push({
        OTIO_SCHEMA: "Gap.1",
        name: "",
        source_range: framesRange(0, timelineFrames(cursor, clip.timelineIn, rate), rate),
        effects: [],
        markers: [],
        metadata: {},
      });
    }
    children.push(otioClip(clip, timelineFrames(clip.timelineIn, clipEnd(clip), rate), rate, media, opts));
    cursor = clipEnd(clip);
  }
  return {
    OTIO_SCHEMA: "Track.1",
    name: layer ? `${track.name} (layer ${layer + 1})` : track.name,
    kind,
    children,
    source_range: null,
    effects: [],
    markers: [],
    metadata: { scarlet: { id: track.id, muted: track.muted, hidden: track.hidden, ...(layer ? { layer } : {}) } },
  };
}

/** `frames` is the clip's length on the timeline in project frames. */
function otioClip(clip: Clip, frames: number, rate: number, media: Map<string, MediaAsset>, opts: OtioExportOptions): unknown {
  const effects: unknown[] = [];
  let mediaReference: unknown;
  let sourceRange: OtioTimeRange;

  if (clip.kind === "media") {
    const asset = media.get(clip.mediaId);
    const url = asset ? toFileUrl(asset.path, opts.mediaRoot) : "";
    const availableDuration = asset?.duration ?? clip.sourceOut;
    mediaReference = {
      OTIO_SCHEMA: "ExternalReference.1",
      name: asset?.name ?? clip.mediaId,
      target_url: url,
      available_range: tr(0, availableDuration, asset?.fps ?? rate),
      metadata: { scarlet: { mediaId: clip.mediaId, hash: asset?.hash ?? null } },
    };
    // OTIO plays children end to end. Counting each cut in camera frames lets rounding drift accumulate
    // against the audio. Keep genuine subframes when the footage clock or playback speed differs.
    const preserveSubframes = (asset?.fps ?? rate) !== rate || (clip.speed ?? 1) !== 1;
    // The footage it plays is its timeline length at its speed.
    sourceRange = framesRange(clip.sourceIn, frames * (clip.speed ?? 1), rate, preserveSubframes);
    if ((clip.speed ?? 1) !== 1) {
      effects.push({
        OTIO_SCHEMA: "LinearTimeWarp.1",
        name: "speed",
        effect_name: "LinearTimeWarp",
        time_scalar: clip.speed,
        metadata: {},
      });
    }
  } else {
    // Colour and caption clips: emit a generator reference so Resolve creates a
    // solid; the colour and text ride along in metadata.
    mediaReference = {
      OTIO_SCHEMA: "GeneratorReference.1",
      name: clip.kind === "color" ? "Solid Color" : "Text",
      generator_kind: clip.kind === "color" ? "SolidColor" : "Text",
      parameters:
        clip.kind === "color" ? { color: clip.color } : { text: clip.text, style: clip.style ?? {} },
      available_range: framesRange(0, frames, rate),
      metadata: {},
    };
    sourceRange = framesRange(0, frames, rate);
  }

  const transform = clip.kind !== "caption" ? clip.transform : undefined;
  return {
    OTIO_SCHEMA: "Clip.2",
    name: clip.label ?? clip.id,
    source_range: sourceRange,
    media_references: { DEFAULT_MEDIA: mediaReference },
    active_media_reference_key: "DEFAULT_MEDIA",
    effects,
    markers: [],
    metadata: {
      scarlet: {
        clipId: clip.id,
        kind: clip.kind,
        transform: transform ?? null,
        opacity: clip.kind !== "caption" ? clip.opacity : 1,
        volume: clip.kind === "media" ? clip.volume : null,
        audioFadeIn: clip.kind === "media" ? clip.audioFadeIn : 0,
        audioFadeOut: clip.kind === "media" ? clip.audioFadeOut : 0,
      },
    },
  };
}

function toFileUrl(path: string, root?: string): string {
  const joined = root ? `${root.replace(/[\\/]+$/, "")}/${path}` : path;
  const normalized = joined.replace(/\\/g, "/");
  const encoded = encodeURI(normalized).replace(/[#?]/g, encodeURIComponent);
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${encoded}`;
  if (normalized.startsWith("//")) return `file:${encoded}`;
  if (normalized.startsWith("/")) return `file://${encoded}`;
  return encoded;
}
