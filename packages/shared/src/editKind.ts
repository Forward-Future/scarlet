import { clipRange, intervalCandidates, timelineDuration, type Change, type Clip, type MediaAsset, type Timeline, type TimeRange, type Track } from "@scarlet/timeline";

/**
 * What an applied edit did to the cut, so the timeline can draw it for what it is:
 * - `cut` took footage out, `restore` put footage back in.
 * - `audio` changed only sound (levels, room tone, a swapped dialogue track).
 * - `zoom` and `reframe` moved or scaled the picture.
 * - `text` added or changed captions and titles.
 * - `broll` laid footage, or a picture taken from the web, over the picture: B-roll.
 * - `overlay` laid anything else over the picture (a logo or a lower third from a file, a colour card), or B-roll mixed with it.
 * - `graphic` laid a graphic Scarlet made (a lower third, a title card) over the picture: a clip whose file is a graphic.
 * - `speed` changed how fast footage plays.
 * - `transition` set how the picture moves from one clip to the next at a join (a swipe, a dissolve, a dip).
 * - `other` did several of these at once, or something else (an assembly, a sync).
 */
export type EditKind = "cut" | "restore" | "audio" | "zoom" | "reframe" | "text" | "broll" | "overlay" | "graphic" | "speed" | "transition" | "other";

type Op = Record<string, unknown>;
/**
 * `picture`: footage placed on the main picture track, which builds the cut rather than laying anything over it.
 * `marker`: a marker left on the timeline, which changes nothing the editor sees or hears.
 */
type Facet = EditKind | "framing" | "picture" | "marker" | "neutral";
/**
 * `ask`: what a to-do marker asks of the editor, in its own words. `restated`: this step wrote those words, as against
 * a move of a marker that only still says them.
 */
type Placed = { facet: Facet; range?: TimeRange; ask?: string; restated?: boolean };
type MarkerFields = { time?: unknown; text?: unknown; kind?: unknown; resolved?: unknown };

const AUDIO_KEYS = new Set(["volume", "audioFadeIn", "audioFadeOut"]);
const FRAMING_KEYS = new Set(["transform", "keyframes"]);
const TEXT_KEYS = new Set(["text", "words", "style"]);
const OVERLAY_KEYS = new Set(["opacity", "videoFadeIn", "videoFadeOut", "color"]);
/** Trims and moves that follow a cut or a restore, and the label, say nothing on their own. */
const NEUTRAL_KEYS = new Set(["sourceIn", "sourceOut", "timelineIn", "timelineOut", "label", "enabled"]);
/** A change this close to the old length kept it. */
const SAME_LENGTH = 0.02;
/** Two stretches that share less than this only touch: an agent's times and a clip's edge differ by rounding. */
const TOUCH = 0.05;

interface Clocks {
  before?: Timeline;
  after?: Timeline;
  /** The project's files, so a clip laid over the picture can be told for a graphic or for B-roll by what its file is. */
  media?: readonly Pick<MediaAsset, "id" | "kind" | "source">[];
}

/**
 * What a clip laid over the picture is, from the project's files: a graphic Scarlet made, B-roll (footage, or a picture
 * taken from the web) or another overlay. Without the files, an overlay.
 */
function laidFiles(media: Clocks["media"]) {
  const files = new Map(media?.map(m => [m.id, m]));
  return (clip: Clip): "graphic" | "broll" | "overlay" => {
    const file = clip.kind === "media" ? files.get(clip.mediaId) : undefined;
    return file?.kind === "graphic" ? "graphic" : file && (file.kind === "video" || file.source) ? "broll" : "overlay";
  };
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
function opFacets(change: Change, { before, after, media }: Clocks): Placed[] {
  const laid = laidFiles(media);
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
    return trackId === baseVideo ? "picture" : laid(clip);
  };
  const range = (clip: Clip | undefined) => {
    if (!clip) return;
    try { return clipRange(clip); } catch { return; }
  };
  const markerNow = (id: unknown) => typeof id !== "string" ? undefined
    : after?.markers?.find(m => m.id === id) ?? before?.markers?.find(m => m.id === id);
  return ops.flatMap((op, index): Placed[] => {
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
          if (OVERLAY_KEYS.has(key)) return { facet: found && found.track.id !== baseVideo ? laid(found.clip) : "overlay" as const, range: at };
          if (key === "speed") return { facet: "speed" as const, range: at };
          // A transition is at its join, the clip's start, not along the clip.
          if (key === "transitionIn") return { facet: "transition" as const, range: found ? { start: found.clip.timelineIn, end: found.clip.timelineIn } : at };
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
      case "addMarker": case "updateMarker": {
        // A marker added or changed is left on the timeline, at its point. One marked resolved asks nothing more.
        const patch = op.op === "addMarker" ? op.marker as MarkerFields | undefined
          : op.patch && typeof op.patch === "object" ? op.patch as MarkerFields : undefined;
        if (patch?.resolved === true) return [{ facet: "neutral" }];
        const saved = op.op === "updateMarker" ? markerNow(op.markerId) : undefined;
        const time = typeof patch?.time === "number" ? patch.time : saved?.time;
        const text = typeof patch?.text === "string" ? patch.text : saved?.text;
        const kind = patch?.kind ?? saved?.kind;
        const at = time !== undefined ? now(time) : undefined;
        return [{ facet: "marker", range: at !== undefined ? { start: at, end: at } : undefined,
          ...(kind === "todo" && text?.trim() && { ask: text.trim(), restated: typeof patch?.text === "string" }) }];
      }
      case "removeMarker":
        return [{ facet: "neutral" }];
      default:
        return [{ facet: "other" as const }];
    }
  });
}

/** What an edit did, or `marker` when all it did was leave markers for the editor. */
type Verdict = EditKind | "marker";

/** `whole`: the facets are all the change's, so how much longer or shorter it left the cut is this edit's doing. */
function decide(facets: Facet[], framing: "zoom" | "reframe", { before, after }: Clocks, whole = false): Verdict {
  const set = new Set(facets.filter(f => f !== "neutral"));
  const lengths = () => before && after ? timelineDuration(after) - timelineDuration(before) : 0;
  // A marker beside anything that changed the video is a note on that edit, which is what the edit is.
  if (set.has("marker")) {
    if (set.size > 1) set.delete("marker");
    else {
      // Markers alone take nothing out, so a change that left the cut shorter did it with steps that say nothing.
      const moved = whole ? lengths() : 0;
      return moved < -SAME_LENGTH ? "cut" : moved > SAME_LENGTH ? "restore" : "marker";
    }
  }
  // A cut can carry the trims and room tone that smooth its join; it is still a cut.
  if (set.has("cut") && !set.has("restore")) return "cut";
  if (set.has("restore") && !set.has("cut")) return "restore";
  // A graphic laid over the picture is a graphic, and B-roll is B-roll, with or without sound. Laid together, or with
  // another overlay, they are overlays.
  if (set.has("graphic") && [...set].every(f => f === "graphic" || f === "audio")) return "graphic";
  if (set.has("broll") && [...set].every(f => f === "broll" || f === "audio")) return "broll";
  const laidOver = (f: Facet) => f === "overlay" || f === "broll" || f === "graphic" || f === "audio";
  if ((set.has("overlay") || set.has("broll") || set.has("graphic")) && [...set].every(laidOver)) return "overlay";
  if (set.size === 0) {
    // Only neutral steps: a removed or re-timed clip. Whether the cut got shorter or longer says which it was.
    const moved = lengths();
    return moved < -SAME_LENGTH ? "cut" : moved > SAME_LENGTH ? "restore" : "other";
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
 * cut unless it says it put footage back: they are read in place of the ops, beside any markers the ops left.
 */
export function editKinds(change: Change, ranges: TimeRange[], clocks: Clocks = {},
  rippleJoins?: readonly { range: TimeRange; facet?: "restore" }[]): EditKind[] {
  return classifyEdits(change, ranges, clocks, rippleJoins).kinds;
}

/**
 * `editKinds`, and for each edit whether all it did was leave markers for the editor, such as a spot for footage the
 * project doesn't have. Nothing the editor sees or hears changed there: such an edit's kind is `other`, and `asks`
 * holds what its to-do markers ask of the editor, in their own words, when they say. `restated` says whether this change
 * wrote those words, rather than only moving a marker that already said them.
 */
export function classifyEdits(change: Change, ranges: TimeRange[], clocks: Clocks = {},
  rippleJoins?: readonly { range: TimeRange; facet?: "restore" }[]): {
  kinds: EditKind[]; markers: boolean[]; asks: (string | undefined)[]; restated: boolean[];
} {
  // Known joins stand for the steps, so only the markers are read from them, and only when there are any.
  const marks = rippleJoins && ((change.ops ?? []) as Op[]).some(op => op.op === "addMarker" || op.op === "updateMarker");
  const steps = !rippleJoins || marks ? opFacets(change, clocks).filter(f => f.facet !== "neutral") : [];
  const facets: Placed[] = rippleJoins ? [...rippleJoins.map(({ range, facet }) => ({ facet: facet ?? "cut" as const, range })),
    ...steps.filter(f => f.facet === "marker")] : steps;
  const framing = facets.some(f => f.facet === "framing") && zooms(change) ? "zoom" : "reframe";
  const verdict = (here: Placed[], all = false) => ({ verdict: decide(here.map(f => f.facet), framing, clocks, all), here });
  let found: { verdict: Verdict; here: Placed[] }[];
  if (ranges.length <= 1 || !facets.length) {
    const whole = verdict(facets, true);
    // A save of the whole video has no steps to place, so what it did is read from how much longer or shorter it left
    // the cut. That is the doing of the edits where the video changed, not of every edit it names: on Matt's pass a
    // save that lengthened one pickup at 9:05 also named "Pricing and model names", a passage it left as it was, and
    // the card called that passage "Added" (2026-11-16). Where the change says nothing looks or sounds different, an
    // edit it names changed nothing a word names.
    const changed = !facets.length && ranges.length > 1 && change.ranges?.length ? change.ranges : undefined;
    const still = { verdict: "other" as const, here: [] as Placed[] };
    found = ranges.map(range => !changed || changed.some(c => c.start <= range.end + 0.5 && c.end >= range.start - 0.5) ? whole : still);
  } else {
    const anywhere = facets.filter(f => !f.range);
    const unplaced = anywhere.length ? verdict(anywhere) : { verdict: "other" as const, here: [] };
    const placed = facets.filter((f): f is Placed & { range: TimeRange } => !!f.range);
    const candidates = intervalCandidates(placed, f => f.range.start, f => f.range.end + 0.5);
    found = ranges.map(range => {
      const near = candidates(range.start, range.end + 0.5);
      // The slack reaches a join or a marker at an edit's edge. A stretch that only touches the edit there belongs to
      // the edit beside it: Scarlet names its edits end to end, and a punch-in that ended where a demo's picture began
      // took the demo's overlay too and read as neither (2026-11-17).
      const here = range.end - range.start > TOUCH ? near.filter(f => f.range.end - f.range.start <= TOUCH
        || Math.min(f.range.end, range.end) - Math.max(f.range.start, range.start) > TOUCH) : near;
      const own = here.length ? here : near;
      return own.length ? verdict(own) : unplaced;
    });
  }
  return {
    kinds: found.map(({ verdict }) => verdict === "marker" ? "other" : verdict),
    markers: found.map(({ verdict }) => verdict === "marker"),
    asks: found.map(({ verdict, here }) => {
      if (verdict !== "marker") return;
      const asked = [...new Set(here.flatMap(f => f.ask ? [f.ask] : []))];
      return asked.length ? asked.join(" ") : undefined;
    }),
    restated: found.map(({ verdict, here }) => verdict === "marker" && here.some(f => f.ask && f.restated)),
  };
}
