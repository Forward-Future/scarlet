import { clipRange, intervalCandidates, timelineDuration, type Change, type Clip, type Timeline, type TimeRange, type Track } from "@scarlet/timeline";

/**
 * What an applied edit did to the cut, so the timeline can draw it for what it is:
 * - `cut` took footage out, `restore` put footage back in.
 * - `audio` changed only sound (levels, room tone, a swapped dialogue track).
 * - `zoom` and `reframe` moved or scaled the picture.
 * - `text` added or changed captions and titles, `overlay` laid b-roll, images or graphics over the picture.
 * - `speed` changed how fast footage plays.
 * - `other` did several of these at once, or something else (an assembly, a sync).
 */
export type EditKind = "cut" | "restore" | "audio" | "zoom" | "reframe" | "text" | "overlay" | "speed" | "other";

type Op = Record<string, unknown>;
/** `picture`: footage placed on the main picture track, which builds the cut rather than laying anything over it. */
type Facet = EditKind | "framing" | "picture" | "neutral";

const AUDIO_KEYS = new Set(["volume", "audioFadeIn", "audioFadeOut"]);
const FRAMING_KEYS = new Set(["transform", "keyframes"]);
const TEXT_KEYS = new Set(["text", "words", "style"]);
const OVERLAY_KEYS = new Set(["opacity", "videoFadeIn", "videoFadeOut", "color"]);
/** Trims and moves that follow a cut or a restore, and the label, say nothing on their own. */
const NEUTRAL_KEYS = new Set(["sourceIn", "sourceOut", "timelineIn", "timelineOut", "label", "enabled"]);
/** A change this close to the old length kept it. */
const SAME_LENGTH = 0.02;

interface Clocks {
  before?: Timeline;
  after?: Timeline;
}

function clipFinder(timeline: Timeline | undefined, batch: boolean) {
  let byId: Map<string, { clip: Clip; track: Track }> | undefined;
  return (id: unknown) => {
    if (!timeline || typeof id !== "string") return;
    if (batch && !byId) {
      byId = new Map();
      for (const track of timeline.tracks) for (const clip of track.clips) {
        // Historical timelines can repeat an id. A lookup takes the first clip in track order.
        if (!byId.has(clip.id)) byId.set(clip.id, { clip, track });
      }
    }
    if (byId) return byId.get(id);
    for (const track of timeline.tracks) {
      const clip = track.clips.find(c => c.id === id);
      if (clip) return { clip, track };
    }
  };
}

/**
 * Where a time in the cut, as one step left it, sits once the steps after it have run. A change's removals are stored
 * last to first, each in the clock it was made in, so an earlier one has since moved up by every later one before it.
 */
function settled(time: number, later: Op[]): number {
  for (const op of later) {
    if (op.trackIds !== undefined) continue;
    if (op.op === "rippleDelete" && typeof op.start === "number" && typeof op.end === "number") {
      if (time > op.start) time -= Math.min(time, op.end) - op.start;
    } else if (op.op === "rippleInsertGap" && typeof op.at === "number" && typeof op.duration === "number") {
      if (time >= op.at) time += op.duration;
    }
  }
  return time;
}

/** Each op's facet, and where it lands on the finished cut when that can be told. */
function opFacets(change: Change, { before, after }: Clocks): { facet: Facet; range?: TimeRange }[] {
  const ops = (change.ops ?? []) as Op[];
  const beforeClip = clipFinder(before, ops.length > 1);
  const afterClip = before === after ? beforeClip : clipFinder(after, ops.length > 1);
  const added = new Map<string, Track["kind"]>();
  for (const op of ops) {
    const track = op.op === "addTrack" ? op.track as Partial<Track> | undefined : undefined;
    if (track?.id && track.kind) added.set(track.id, track.kind);
  }
  const trackKind = (id: unknown) => typeof id !== "string" ? undefined
    : added.get(id) ?? after?.tracks.find(t => t.id === id)?.kind ?? before?.tracks.find(t => t.id === id)?.kind;
  // The bottom video track carries the picture; clips on any track above it are laid over it.
  const baseVideo = (after ?? before)?.tracks.find(t => t.kind === "video")?.id;
  const placed = (clip: Clip, trackId: unknown): Facet => {
    if (clip.kind === "caption") return "text";
    if (clip.kind === "color") return "overlay";
    const kind = trackKind(trackId);
    if (kind === "audio") return "audio";
    if (kind === "caption") return "text";
    if (kind !== "video") return "neutral";
    return trackId === baseVideo ? "picture" : "overlay";
  };
  const range = (clip: Clip | undefined) => {
    if (!clip) return;
    try { return clipRange(clip); } catch { return; }
  };
  return ops.flatMap((op, index): { facet: Facet; range?: TimeRange }[] => {
    const now = (time: number) => settled(time, ops.slice(index + 1));
    switch (op.op) {
      case "rippleDelete": {
        const at = typeof op.start === "number" ? now(op.start) : undefined;
        return [{ facet: "cut", range: at !== undefined ? { start: at, end: at } : undefined }];
      }
      case "rippleInsertGap":
        return [{ facet: "restore", range: typeof op.at === "number" && typeof op.duration === "number"
          ? { start: now(op.at), end: now(op.at + op.duration) } : undefined }];
      case "addClip": {
        const clip = op.clip as Clip | undefined;
        return clip ? [{ facet: placed(clip, op.trackId), range: range(clip) }] : [];
      }
      case "removeClip": {
        const found = beforeClip(op.clipId);
        if (!found) return [{ facet: "neutral" }];
        // Off the main picture, the length check decides whether it shortened the cut.
        const facet = placed(found.clip, found.track.id);
        return [{ facet: facet === "picture" ? "neutral" : facet, range: range(found.clip) }];
      }
      case "updateClip": {
        const patch = op.patch && typeof op.patch === "object" ? op.patch as Record<string, unknown> : {};
        const found = afterClip(op.clipId) ?? beforeClip(op.clipId);
        const at = range(found?.clip);
        const keys = Object.keys(patch).filter(k => !NEUTRAL_KEYS.has(k));
        if (!keys.length) return [{ facet: "neutral", range: at }];
        return keys.map(key => {
          if (AUDIO_KEYS.has(key)) return { facet: "audio" as const, range: at };
          if (FRAMING_KEYS.has(key)) return { facet: "framing" as const, range: at };
          if (TEXT_KEYS.has(key)) return { facet: "text" as const, range: at };
          if (OVERLAY_KEYS.has(key)) return { facet: "overlay" as const, range: at };
          if (key === "speed") return { facet: "speed" as const, range: at };
          if (key === "effects") return { facet: found?.track.kind === "audio" ? "audio" as const : "overlay" as const, range: at };
          return { facet: "other" as const, range: at };
        });
      }
      case "updateTrack": {
        const patch = op.patch && typeof op.patch === "object" ? Object.keys(op.patch) : [];
        return patch.every(k => k === "muted" || k === "name") && patch.includes("muted") ? [{ facet: "audio" }] : [{ facet: "neutral" }];
      }
      case "addTrack": case "splitClip": case "moveClip": case "removeTrack":
        return [{ facet: "neutral" }];
      case "addMarker": case "removeMarker": case "updateMarker":
        return [];
      default:
        return [{ facet: "other" as const }];
    }
  });
}

function decide(facets: Facet[], framing: "zoom" | "reframe", { before, after }: Clocks): EditKind {
  const set = new Set(facets.filter(f => f !== "neutral"));
  // A cut can carry the trims and room tone that smooth its join; it is still a cut.
  if (set.has("cut") && !set.has("restore")) return "cut";
  if (set.has("restore") && !set.has("cut")) return "restore";
  if (set.has("overlay") && [...set].every(f => f === "overlay" || f === "audio")) return "overlay";
  if (set.size === 0) {
    // Only neutral steps: a removed or re-timed clip. Whether the cut got shorter or longer says which it was.
    const lengths = before && after ? timelineDuration(after) - timelineDuration(before) : 0;
    return lengths < -SAME_LENGTH ? "cut" : lengths > SAME_LENGTH ? "restore" : "other";
  }
  if (set.size > 1) return "other";
  const only = [...set][0]!;
  return only === "framing" ? framing : only === "picture" ? "other" : only;
}

/** Scaling the picture up is a zoom; moving, cropping or shrinking it (an inset) is a reframe. */
function zooms(change: Change): boolean {
  return ((change.ops ?? []) as Op[]).some(op => {
    const patch = op.op === "updateClip" && op.patch && typeof op.patch === "object" ? op.patch as Record<string, unknown> : undefined;
    if (!patch) return false;
    const transform = patch.transform as { scale?: unknown } | undefined;
    const keyframes = Array.isArray(patch.keyframes) ? patch.keyframes as { transform?: { scale?: unknown } }[] : [];
    const scaledUp = (scale: unknown) => typeof scale === "number" && scale > 1.001;
    return scaledUp(transform?.scale) || keyframes.some(k => scaledUp(k.transform?.scale));
  });
}

/**
 * The kind of each of a change's edits, given each edit's range in the change's own clock. An edit takes the kind of the
 * ops that land on it. One that none lands on takes the kind of the ops that couldn't be placed, which may be its own.
 * When every op that says something was placed on another edit, this one did nothing a word names: a cut made
 * elsewhere in the change doesn't make it a cut. `rippleJoins` are a change's joins when they are already known, each a
 * cut unless it says it put footage back: they are read in place of the ops.
 */
export function editKinds(change: Change, ranges: TimeRange[], clocks: Clocks = {},
  rippleJoins?: readonly { range: TimeRange; facet?: "restore" }[]): EditKind[] {
  const facets = rippleJoins ? rippleJoins.map(({ range, facet }) => ({ facet: facet ?? "cut" as const, range }))
    : opFacets(change, clocks).filter(f => f.facet !== "neutral");
  const framing = facets.some(f => f.facet === "framing") && zooms(change) ? "zoom" : "reframe";
  const whole = decide(facets.map(f => f.facet), framing, clocks);
  if (ranges.length <= 1 || !facets.length) return ranges.map(() => whole);
  const anywhere = facets.filter(f => !f.range);
  const unplaced = anywhere.length ? decide(anywhere.map(f => f.facet), framing, clocks) : "other";
  const placed = facets.filter((f): f is { facet: Facet; range: TimeRange } => !!f.range);
  const candidates = intervalCandidates(placed, f => f.range.start, f => f.range.end + 0.5);
  return ranges.map(range => {
    const here = candidates(range.start, range.end + 0.5);
    return here.length ? decide(here.map(f => f.facet), framing, clocks) : unplaced;
  });
}
