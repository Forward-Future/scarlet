/**
 * Convenience constructors used by the server, MCP tools and tests.
 */
import type { MediaAsset, MediaClip, Project, ProjectSettings, Timeline, Track, TranscriptWord } from "./schema.js";
import { Project as ProjectSchema, Timeline as TimelineSchema } from "./schema.js";
import { contentHash, newId } from "./ids.js";

export const ASPECT_PRESETS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/** Display size and clock of a video that can supply the project format. */
export function videoFormat({ kind, width, height, fps }: MediaAsset): Partial<ProjectSettings> | undefined {
  if (kind !== "video" || !width || !height) return;
  const preset = Object.entries(ASPECT_PRESETS).find(([, size]) => width * size.height === height * size.width);
  return { width, height, aspect: preset ? preset[0] as ProjectSettings["aspect"] : "custom", ...(fps && fps > 0 ? { fps } : {}) };
}

export function createProject(name: string, settings: Partial<ProjectSettings> = {}): Project {
  const aspect = settings.aspect ?? "16:9";
  const dims = ASPECT_PRESETS[aspect] ?? { width: 1920, height: 1080 };
  const now = new Date().toISOString();
  return ProjectSchema.parse({
    id: newId("prj"),
    name,
    settings: { fps: 30, sampleRate: 48000, audioChannels: 2, ...dims, aspect, ...settings },
    media: [],
    head: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function emptyTimeline(projectId: string, name = "Main"): Timeline {
  return TimelineSchema.parse({
    version: "draft",
    parent: null,
    projectId,
    name,
    tracks: [
      { id: "v1", kind: "video", name: "V1", clips: [] },
      { id: "a1", kind: "audio", name: "A1", clips: [] },
    ],
    markers: [],
  });
}

/** Reading an untouched project can persist its empty timeline without making an edit. */
export function hasInitialTimeline({ id, head }: Pick<Project, "id" | "head">) {
  return !head || head === contentHash(emptyTimeline(id), ["version", "parent", "createdAt"]).slice(0, 16);
}

export function makeTrack(kind: Track["kind"], name: string, id = newId("trk")): Track {
  return { id, kind, name, muted: false, hidden: false, clips: [] };
}

export function makeMediaClip(
  mediaId: string,
  sourceIn: number,
  sourceOut: number,
  timelineIn: number,
  extra: Partial<MediaClip> = {},
): MediaClip {
  return {
    id: extra.id ?? newId("clip"),
    kind: "media",
    mediaId,
    sourceIn,
    sourceOut,
    timelineIn,
    speed: 1,
    opacity: 1,
    volume: 1,
    audioFadeIn: 0,
    audioFadeOut: 0,
    videoFadeIn: 0,
    videoFadeOut: 0,
    effects: [],
    enabled: true,
    ...extra,
  };
}

/** A second recording of the same event, laid above the first where the two overlap. */
export interface SyncedLayer {
  mediaId: string;
  /** Seconds this recording starts after the first one (negative = earlier), as audio_sync measures it. */
  offset: number;
  /** This recording's length. Footage is only placed where it has any. */
  duration: number;
  /** Where the picture sits on the canvas. */
  transform?: MediaClip["transform"];
  /** The sound plays from this recording instead of the first. */
  sound?: boolean;
}

/**
 * Build a straight-cut dialogue timeline from a list of keep-ranges in the
 * source. This is the "first cut" primitive: the agent decides which source
 * ranges to keep, Scarlet lays them end to end on V1/A1. A synced layer goes
 * on a video track of its own above V1, cut at the same moments.
 */
export function timelineFromKeepRanges(
  projectId: string,
  mediaId: string,
  keep: Array<{ start: number; end: number; label?: string }>,
  opts: { audioMediaId?: string; crossfade?: number; layer?: SyncedLayer } = {},
): Timeline {
  const tl = emptyTimeline(projectId);
  const v1 = tl.tracks[0]!;
  const a1 = tl.tracks[1]!;
  const layer = opts.layer;
  const upper = layer && makeTrack("video", "Camera inset", "v2");
  if (upper) tl.tracks.splice(1, 0, upper);
  const xf = opts.crossfade ?? 0;
  // One recording is heard: the separate audio, else the layer when chosen, else the first recording.
  const heard = opts.audioMediaId ? "audio" : layer?.sound ? "layer" : "first";
  const sound = (on: boolean) => ({ volume: on ? 1 : 0, audioFadeIn: on ? xf : 0, audioFadeOut: on ? xf : 0 });
  let cursor = 0;
  for (const r of keep) {
    const dur = r.end - r.start;
    if (dur <= 0) continue;
    v1.clips.push(makeMediaClip(mediaId, r.start, r.end, cursor, { label: r.label, ...sound(heard === "first") }));
    if (opts.audioMediaId) {
      a1.clips.push(
        makeMediaClip(opts.audioMediaId, r.start, r.end, cursor, {
          label: r.label,
          audioFadeIn: xf,
          audioFadeOut: xf,
        }),
      );
    }
    if (layer && upper) {
      // The layer's clock runs `offset` behind the first recording's, and it only has footage inside its own length.
      const from = Math.max(r.start, layer.offset);
      const to = Math.min(r.end, layer.offset + layer.duration);
      if (to - from > 1e-6) {
        upper.clips.push(makeMediaClip(layer.mediaId, from - layer.offset, to - layer.offset, cursor + from - r.start, {
          ...(layer.transform && { transform: layer.transform }),
          ...sound(heard === "layer"),
        }));
      }
    }
    cursor += dur;
  }
  return TimelineSchema.parse(tl);
}

/** Group words by the caption limits, keeping words spoken at the same instant in one cue. */
export function captionsFromWords(
  words: TranscriptWord[],
  opts: { maxWords?: number; maxChars?: number; maxGap?: number; minDuration?: number } = {},
) {
  const maxWords = opts.maxWords ?? 5;
  const maxChars = opts.maxChars ?? 32;
  const maxGap = opts.maxGap ?? 0.8;
  const clips: Array<{ start: number; end: number; text: string; words: TranscriptWord[] }> = [];
  let cur: TranscriptWord[] = [];
  let chars = 0;
  let latestEnd = 0;
  const flush = (nextStart = Infinity) => {
    if (!cur.length) return;
    const start = cur[0]!.start;
    const end = Math.max(latestEnd, start + (opts.minDuration ?? 0));
    clips.push({
      start,
      end: nextStart > start ? Math.min(end, nextStart) : end,
      text: cur.map((w) => w.text).join(" "),
      words: cur,
    });
    cur = [];
    chars = 0;
    latestEnd = 0;
  };
  for (let first = 0; first < words.length;) {
    const word = words[first]!;
    let next = first + 1;
    let groupChars = word.text.length;
    while (next < words.length && words[next]!.start === word.start) {
      groupChars += 1 + words[next]!.text.length;
      next++;
    }
    const groupSize = next - first;
    if (cur.length && (cur.length + groupSize > maxWords || chars + 1 + groupChars > maxChars || word.start - latestEnd > maxGap)) {
      flush(word.start);
    }
    chars += (cur.length ? 1 : 0) + groupChars;
    while (first < next) {
      const member = words[first++]!;
      cur.push(member);
      latestEnd = Math.max(latestEnd, member.end);
    }
  }
  flush();
  return clips;
}
