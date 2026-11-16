/**
 * OpenTimelineIO export. DaVinci Resolve imports .otio natively
 * (File → Import → Timeline). We emit the otio_json schema v1 subset that
 * Resolve understands: Timeline → Stack → Track → Clip/Gap with
 * ExternalReference media.
 */
import { sourceStart, type HandoffSource } from "./handoff.js";
import type { Clip, MediaAsset, MediaClip, Project, Timeline, Track } from "./schema.js";
import { carriesAudio, clipDuration, clipEnd } from "./time.js";

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
  /**
   * The copies a hand-off folder links to, by media id: their URLs and the footage's own timecode, which other apps
   * count source times from. Without it the timeline links to Scarlet's library and counts from zero.
   */
  sources?: Map<string, HandoffSource>;
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
  // In Scarlet a picture clip plays its own sound. Other apps put sound on audio tracks, so each picture track that is
  // heard gets one, cut the same way. Scarlet's import drops these again as the clips' linked twins.
  for (const t of video) {
    if (t.muted) continue;
    const heard = t.clips.filter((c): c is MediaClip => c.kind === "media" && c.enabled !== false && c.volume > 0 &&
      (opts.sources ? opts.sources.get(c.mediaId)?.hasAudio === true : !!media.get(c.mediaId) && carriesAudio(media.get(c.mediaId)!)) &&
      media.get(c.mediaId)?.kind !== "audio");
    if (!heard.length) continue;
    const sound: Track = { ...t, kind: "audio", name: `${t.name} sound`, clips: heard };
    for (const lane of otioTracks(sound, "Audio", rate, media, opts) as Array<{ metadata: { scarlet: Record<string, unknown> } }>) {
      lane.metadata = { scarlet: { soundOf: t.id } };
      tracks.push(lane);
    }
  }

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

/**
 * A track's clips can overlap, where one track of another app can't. Give overlapping clips parallel layers.
 * A picture is drawn over the clips stored before it, so on a picture track each clip goes above every earlier clip it
 * overlaps. Sound has no order, so on a sound track each clip takes the lowest layer free for its whole length: a
 * run of crossfades alternates between two layers instead of climbing one a join.
 */
export function trackLayers(clips: Clip[], includeDisabled = false, sound = false): Clip[][] {
  const lanes: Array<{ clips: Clip[]; end: number }> = [{ clips: [], end: 0 }];
  // After ripples, neighbours can overlap in the thirteenth decimal. That is a join, not a second layer.
  const overlaps = (lane: { clips: Clip[]; end: number }, clip: Clip, end: number) =>
    lane.end > clip.timelineIn + 1e-6 && lane.clips.some((c) => c.timelineIn < end - 1e-6 && clip.timelineIn < clipEnd(c) - 1e-6);
  const order = clips.filter((c) => c.enabled !== false || includeDisabled);
  if (sound) order.sort((a, b) => a.timelineIn - b.timelineIn);
  for (const clip of order) {
    const end = clipEnd(clip);
    let target: number;
    if (sound) {
      target = lanes.findIndex((lane) => !overlaps(lane, clip, end));
      if (target < 0) target = lanes.length;
    } else {
      let lane = lanes.length - 1;
      while (lane >= 0 && !overlaps(lanes[lane]!, clip, end)) lane--;
      target = lane + 1;
    }
    const into = lanes[target] ?? (lanes[target] = { clips: [], end: 0 });
    into.clips.push(clip);
    into.end = Math.max(into.end, end);
  }
  return lanes.map(lane => lane.clips);
}

function otioTracks(track: Track, kind: "Video" | "Audio", rate: number, media: Map<string, MediaAsset>, opts: OtioExportOptions): unknown[] {
  return trackLayers(track.clips, false, kind === "Audio").map((clips, layer) => otioTrack(track, clips, layer, kind, rate, media, opts));
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
    const copy = opts.sources?.get(clip.mediaId);
    const url = copy ? copy.url : asset ? toFileUrl(asset.path, opts.mediaRoot) : "";
    const availableDuration = asset?.duration ?? clip.sourceOut;
    // Another app counts a file's times from its timecode, such as 01:00:00:00.
    const origin = sourceStart(copy);
    mediaReference = {
      OTIO_SCHEMA: "ExternalReference.1",
      name: copy?.fileName ?? asset?.name ?? clip.mediaId,
      target_url: url,
      available_range: tr(origin, availableDuration, asset?.fps ?? rate),
      metadata: { scarlet: { mediaId: clip.mediaId, hash: asset?.hash ?? null } },
    };
    // OTIO plays children end to end. Counting each cut in camera frames lets rounding drift accumulate
    // against the audio. Keep genuine subframes when the footage clock or playback speed differs.
    const preserveSubframes = (asset?.fps ?? rate) !== rate || (clip.speed ?? 1) !== 1;
    // The footage it plays is its timeline length at its speed.
    sourceRange = framesRange(origin + clip.sourceIn, frames * (clip.speed ?? 1), rate, preserveSubframes);
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
