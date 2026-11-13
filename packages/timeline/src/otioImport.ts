/**
 * OpenTimelineIO import: bring a timeline edited by hand in DaVinci Resolve
 * back into Scarlet as a new version of the cut.
 *
 * Resolve keeps the edit (which footage, which part, where) but drops
 * Scarlet's own clip data. So each imported clip is matched to a clip in the
 * version that was exported — by Scarlet id when it survived, then by clip
 * name, then by the footage and the part of it used — and inherits that
 * clip's transform, volume, fades and effects. Captions don't survive Resolve
 * either; they are re-timed onto the edited cut through the footage, and
 * captions on footage that was cut are dropped.
 */
import type { CaptionClip, Clip, ColorClip, MediaAsset, MediaClip, Project, Timeline, TimeRange, Track } from "./schema.js";
import { RenderColor, Timeline as TimelineSchema } from "./schema.js";
import { makeMediaClip } from "./builders.js";
import { newId } from "./ids.js";
import { firstIndex } from "./intervals.js";
import { makeTimeMap, type TimeMap } from "./rebase.js";
import { clipEnd, MAX_TIMELINE_SECONDS, timelinePlanningIssue } from "./time.js";

type Json = Record<string, unknown>;

export class OtioImportError extends Error {
  constructor(
    message: string,
    public readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "OtioImportError";
  }
}

const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const schemaOf = (v: unknown) => String(obj(v).OTIO_SCHEMA ?? "").split(".")[0];
/** A list the file leaves out is empty. One that isn't a list means the file is damaged. */
function list(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new OtioImportError(`This timeline file is damaged: its ${what} aren't a list. Export it again and import the new file.`);
  return v;
}

function seconds(rt: unknown): number {
  const r = obj(rt);
  const rate = Number(r.rate) || 1;
  return (Number(r.value) || 0) / rate;
}
function range(tr: unknown): { start: number; duration: number } {
  const r = obj(tr);
  return { start: seconds(r.start_time), duration: seconds(r.duration) };
}

/** Which version of the cut this OTIO file was exported from (Scarlet writes it into metadata). */
export function otioSourceVersion(otio: unknown): string | undefined {
  const v = obj(obj(obj(otio).metadata).scarlet).version;
  return typeof v === "string" ? v : undefined;
}

function mediaRef(clip: Json): Json {
  const refs = obj(clip.media_references);
  const key = String(clip.active_media_reference_key ?? "DEFAULT_MEDIA");
  return obj(refs[key] ?? clip.media_reference);
}

function basename(path: string): string {
  const clean = path.replace(/\\/g, "/");
  return clean.slice(clean.lastIndexOf("/") + 1).toLowerCase();
}

function decodeFilename(name: string): string {
  try { return decodeURIComponent(name).toLowerCase(); } catch { return name; }
}

/** Keep the same first-match priority as Resolve's path/name/stem fallback.
 * Build filename indexes only when Scarlet media IDs did not survive export. */
function matchProjectMedia(project: Project) {
  const assets = [...project.media].reverse();
  const index = (key: (m: MediaAsset) => string) => new Map(assets.map(m => [key(m), m]));
  const byId = index(m => m.id);
  const indexNames = () => ({
    path: index(m => basename(m.path)), name: index(m => m.name.toLowerCase()),
    idStem: index(m => m.id.toLowerCase()), nameStem: index(m => m.name.toLowerCase().replace(/\.[^.]+$/, "")),
  });
  let names: ReturnType<typeof indexNames> | undefined;
  return (ref: Json) => {
    const id = obj(obj(ref.metadata).scarlet).mediaId;
    const exact = typeof id === "string" && byId.get(id);
    if (exact) return exact;
    const url = String(ref.target_url ?? "");
    if (!url) return;
    names ??= indexNames();
    const raw = basename(url);
    const file = decodeFilename(raw);
    const stem = file.replace(/\.[^.]+$/, "");
    // Older exports and some other editors write an unescaped filename.
    return names.path.get(file) ?? names.path.get(raw) ?? names.name.get(file) ?? names.name.get(raw)
      ?? names.idStem.get(stem) ?? names.nameStem.get(stem);
  };
}

function speedOf(clip: Json): number {
  for (const e of list(clip.effects, "clip effects")) {
    const fx = obj(e);
    if (schemaOf(fx) === "LinearTimeWarp" && Number(fx.time_scalar) > 0) return Number(fx.time_scalar);
  }
  return 1;
}

/** Index once for a round trip. Resolve can drop IDs, repeat names or split a
 * take, so source overlap and unused-clip tie breaks still apply. */
function indexBaseClips(base: Timeline) {
  type Source = { clips: MediaClip[]; ids: Map<string, MediaClip>; names: Map<string, MediaClip[]> };
  const sources = new Map<string, Source>();
  const colorsById = new Map<string, ColorClip>();
  const colorsByName = new Map<string, ColorClip | null>();
  for (const track of base.tracks) {
    if (track.kind === "caption") continue;
    for (const clip of track.clips) {
      const name = clip.label ?? clip.id;
      if (clip.kind === "color") {
        colorsById.set(clip.id, clip);
        // A name identifies a generator in a metadata-free export only if it is unique.
        colorsByName.set(name, colorsByName.has(name) ? null : clip);
      }
      if (clip.kind !== "media") continue;
      let source = sources.get(clip.mediaId);
      if (!source) {
        source = { clips: [], ids: new Map(), names: new Map() };
        sources.set(clip.mediaId, source);
      }
      source.clips.push(clip);
      if (!source.ids.has(clip.id)) source.ids.set(clip.id, clip);
      const named = source.names.get(name);
      if (named) named.push(clip);
      else source.names.set(name, [clip]);
    }
  }
  return { sources, colorsById, colorsByName };
}

function matchBase(sources: ReturnType<typeof indexBaseClips>["sources"], used: Set<string>, preferredIds: Set<string>,
  imported: { name: string; scarletId?: string; mediaId: string; sourceIn: number; sourceOut: number }): MediaClip | undefined {
  const source = sources.get(imported.mediaId);
  if (!source) return;
  const exact = imported.scarletId && source.ids.get(imported.scarletId);
  if (exact) return exact;
  const named = source.names.get(imported.name);
  if (named?.length === 1) return named[0];
  let best: MediaClip | undefined;
  let bestOverlap = 0;
  let bestRank = -1;
  for (const clip of named ?? source.clips) {
    const overlap = Math.min(clip.sourceOut, imported.sourceOut) - Math.max(clip.sourceIn, imported.sourceIn);
    if (overlap <= 0) continue;
    // A linked camera twin may share both its name and its start with a
    // shorter dialogue take. Rank a complete source match before track ties.
    const sameRange = Math.abs(clip.sourceIn - imported.sourceIn) < 1e-6 && Math.abs(clip.sourceOut - imported.sourceOut) < 1e-6;
    const rank = (sameRange ? 2 : 0) + (preferredIds.has(clip.id) ? 1 : 0);
    if (rank < bestRank) continue;
    if (rank > bestRank || overlap > bestOverlap || (overlap === bestOverlap && best && used.has(best.id) && !used.has(clip.id))) {
      bestRank = rank;
      bestOverlap = overlap;
      best = clip;
    }
  }
  return best ?? named?.find(clip => !used.has(clip.id)) ?? named?.[0];
}

/** Map each stretch of a caption through its footage. A reordered shot, or a newly inserted gap,
 * can put the surviving stretches in different places on the edited timeline. */
function captionRangeMap(base: Timeline, draft: Timeline, fps: number, map: TimeMap) {
  const back = makeTimeMap(draft, base, fps);
  const edges = new Set<number>();
  for (const timeline of [base, draft]) {
    for (const track of timeline.tracks) for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false) continue;
      const start = timeline === base ? clip.timelineIn : back(clip.timelineIn, "right");
      const end = timeline === base ? clipEnd(clip) : back(clipEnd(clip), "left");
      if (start !== null) edges.add(start);
      if (end !== null) edges.add(end);
    }
  }
  const cuts = [...edges].sort((a, b) => a - b);
  function retained(time: number, side: "left" | "right") {
    const at = map(time, side);
    // A repetition of the same take has the same source time. Keep only this occurrence.
    const original = at === null ? null : back(at, side);
    return original !== null && Math.abs(original - time) < 1e-6 ? at : null;
  }
  return (from: number, to: number): TimeRange[] => {
    const spans: TimeRange[] = [];
    let left = from;
    for (let i = firstIndex(cuts, t => t > from); left < to; i++) {
      const right = Math.min(cuts[i] ?? to, to);
      const start = retained(left, "right"), end = retained(right, "left");
      if (start !== null && end !== null && end > start) spans.push({ start, end });
      left = right;
    }
    // Adjacent pieces of a ripple trim still make one caption. Keep disjoint pieces separate.
    const groups: TimeRange[] = [];
    for (const span of spans.sort((a, b) => a.start - b.start)) {
      const last = groups.at(-1);
      if (last && span.start <= last.end + 1e-6) last.end = Math.max(last.end, span.end);
      else groups.push(span);
    }
    return groups;
  };
}

function retimeCaption(clip: CaptionClip, ranges: ReturnType<typeof captionRangeMap>, frame: number) {
  const groups = ranges(clip.timelineIn, clip.timelineOut);
  const words = clip.words?.flatMap((word, index) =>
    ranges(Math.max(clip.timelineIn, word.start), Math.min(clip.timelineOut, word.end)).map(span => ({ ...span, text: word.text, index }))
  ).sort((a, b) => a.start - b.start);
  const clips: CaptionClip[] = [];
  let nextWord = 0;
  for (const { start, end } of groups) {
    const first = nextWord;
    while (words && nextWord < words.length && words[nextWord]!.start < end) nextWord++;
    if (end - start < frame || (clip.words?.length && first === nextWord)) continue;
    const piece = { ...clip, id: clips.length ? newId("clip") : clip.id, timelineIn: start, timelineOut: end };
    if (words?.length) {
      const picked = words.slice(first, nextWord);
      piece.words = picked.map(({ index, ...word }) => word);
      // Preserve manual punctuation and line breaks while the same words remain in order.
      if (picked.length !== clip.words!.length || picked.some((word, i) => word.index !== i)) {
        piece.text = picked.map(word => word.text).join(" ");
      }
    }
    clips.push(piece);
  }
  return clips;
}

/**
 * Build a Scarlet timeline from an OTIO document, using `base` (the version
 * that was exported) for clip looks, track ids and captions.
 */
export function fromOtio(otio: unknown, project: Project, base: Timeline): Timeline {
  const root = obj(otio);
  if (schemaOf(root) !== "Timeline") throw new OtioImportError("This isn't an OpenTimelineIO timeline (.otio). In Resolve use File → Export → Timeline… and pick OpenTimelineIO.");
  const stack = obj(root.tracks);
  const otioTracks = list(stack.children, "tracks").map(obj).filter((t) => schemaOf(t) === "Track");
  const missing = new Set<string>();

  const findMedia = matchProjectMedia(project);
  const { sources, colorsById, colorsByName } = indexBaseClips(base);
  const used = new Set<string>();
  const idsTaken = new Set<string>();
  function importedId(match?: Clip | null) {
    const id = match && !idsTaken.has(match.id) ? match.id : newId("clip");
    idsTaken.add(id);
    return id;
  }
  const baseByKind = { video: base.tracks.filter((t) => t.kind === "video"), audio: base.tracks.filter((t) => t.kind === "audio") };
  const audioIds = new Set(baseByKind.audio.flatMap(track => track.clips.map(clip => clip.id)));
  const videoIds = new Set(baseByKind.video.flatMap(track => track.clips.map(clip => clip.id)));
  const importedNames = new Set(otioTracks.map(t => `${String(t.kind ?? "Video").toLowerCase()}/${String(t.name)}`));
  const independentAudio = new Set<string>();
  const counters = { video: 0, audio: 0 };
  const tracks: Track[] = [];

  for (const ot of otioTracks) {
    const kind = String(ot.kind ?? "Video").toLowerCase() === "audio" ? "audio" : "video";
    const scarletTrack = obj(obj(ot.metadata).scarlet);
    const positional = baseByKind[kind][counters[kind]];
    const named = baseByKind[kind].filter(track => track.name === ot.name);
    const baseTrack =
      (typeof scarletTrack.id === "string" ? baseByKind[kind].find(t => t.id === scarletTrack.id) : undefined) ??
      (named.length === 1 ? named[0] : undefined) ??
      (positional && (positional.name === ot.name || !importedNames.has(`${kind}/${positional.name}`)) ? positional : undefined);
    const preferredIds = baseTrack ? new Set(baseTrack.clips.map(c => c.id)) : videoIds;
    counters[kind]++;
    const track: Track = {
      id: baseTrack && !tracks.some((t) => t.id === baseTrack.id) ? baseTrack.id : newId("trk"),
      kind,
      name: String(ot.name || baseTrack?.name || `${kind === "video" ? "V" : "A"}${counters[kind]}`),
      muted: baseTrack?.muted ?? false,
      hidden: baseTrack?.hidden ?? false,
      clips: [],
    };
    let cursor = 0;
    for (const raw of list(ot.children, "clips")) {
      const item = obj(raw);
      const schema = schemaOf(item);
      if (schema === "Transition") continue; // transitions overlap neighbours; they don't take track time
      // A clip with no range of its own plays all of its footage, from the footage's own start.
      const sr = item.source_range == null ? { start: 0, duration: seconds(obj(mediaRef(item).available_range).duration) } : range(item.source_range);
      const unusable = () => new OtioImportError(`This timeline has a ${schema === "Gap" ? "gap" : "clip"}${item.name ? ` (${String(item.name)})` : ""} whose start or length isn't a time Scarlet can use. Export it again and import the new file.`);
      // A length moves everything after it on the track. A start matters only where footage is read from it, below.
      if ((schema === "Gap" || schema === "Clip") && !(sr.duration >= 0 && Number.isFinite(sr.duration))) throw unusable();
      if (schema === "Gap") {
        cursor += sr.duration;
        if (cursor > MAX_TIMELINE_SECONDS) throw new OtioImportError("A Scarlet timeline can be up to 24 hours long.");
        continue;
      }
      if (schema !== "Clip") continue;
      const at = cursor;
      const speed = speedOf(item);
      cursor += sr.duration / speed;
      if (!Number.isFinite(speed) || !Number.isFinite(cursor) || cursor > MAX_TIMELINE_SECONDS) throw new OtioImportError("A Scarlet timeline can be up to 24 hours long and needs a finite playback speed.");
      if (item.enabled === false) continue;
      const ref = mediaRef(item);
      const name = String(item.name ?? "");
      const sc = obj(obj(item.metadata).scarlet);
      const scarletId = typeof sc.clipId === "string" ? sc.clipId : undefined;
      const refSchema = schemaOf(ref);
      if (refSchema === "GeneratorReference") {
        const params = obj(ref.parameters);
        if (String(ref.generator_kind ?? "").toLowerCase().includes("solid") && kind === "video") {
          const color = RenderColor.safeParse(params.color ?? "#000000");
          if (!color.success) throw new OtioImportError("The solid-color generator contains an invalid color.");
          const match = (scarletId && colorsById.get(scarletId)) || colorsByName.get(name);
          track.clips.push({ ...match, id: importedId(match), kind: "color", timelineIn: at, timelineOut: cursor,
            color: color.data, opacity: match?.opacity ?? 1, enabled: true });
        }
        continue;
      }
      const asset = findMedia(ref);
      if (!asset) {
        missing.add(decodeFilename(basename(String(ref.target_url ?? item.name ?? "unknown"))) || String(item.name ?? "unknown"));
        continue;
      }
      // A clip's range is on its footage's own clock, and another editor starts that clock at the camera's timecode,
      // such as 01:00:00:00. Scarlet counts from the footage's first frame. The two starts can be written at
      // different rates, so a clip on the first frame may come out a rounding error before it.
      const fromStart = item.source_range == null ? 0 : sr.start - seconds(obj(ref.available_range).start_time);
      const sourceIn = Math.abs(fromStart) < 1e-6 ? 0 : fromStart;
      if (!(sourceIn >= 0 && Number.isFinite(sourceIn + sr.duration))) throw unusable();
      const sourceOut = sourceIn + sr.duration;
      const match = matchBase(sources, used, preferredIds, { name, scarletId, mediaId: asset.id, sourceIn, sourceOut });
      if (match) used.add(match.id);
      const id = importedId(match);
      if (kind === "audio" && match && audioIds.has(match.id)) independentAudio.add(id);
      const inherited: Partial<MediaClip> = match
        ? {
            label: match.label,
            transform: match.transform,
            keyframes: match.keyframes?.map(k => ({ ...k, time: (match.sourceIn - sourceIn + k.time * match.speed) / speed })),
            opacity: match.opacity,
            volume: match.volume,
            audioFadeIn: match.audioFadeIn,
            audioFadeOut: match.audioFadeOut,
            videoFadeIn: match.videoFadeIn,
            videoFadeOut: match.videoFadeOut,
            effects: match.effects,
          }
        : { label: name || undefined };
      track.clips.push(makeMediaClip(asset.id, sourceIn, sourceOut, at, { ...inherited, id, speed }));
    }
    // Unedited Scarlet overflow lanes can share their original track again.
    // Other editors may remove the metadata; the parallel tracks still play in place.
    const previous = tracks.at(-1);
    if (typeof scarletTrack.layer === "number" && previous && previous.id === scarletTrack.id && previous.kind === kind &&
        track.name === `${previous.name} (layer ${scarletTrack.layer + 1})`) {
      previous.clips.push(...track.clips);
    } else {
      tracks.push(track);
    }
  }

  if (missing.size) {
    throw new OtioImportError(`The timeline uses footage Scarlet doesn't have: ${[...missing].join(", ")}. Add those files under Media first, then import again.`, [...missing]);
  }

  // Resolve exports each video clip's sound as a linked clip on an audio
  // track. In Scarlet a video clip carries its own sound, so drop those twins.
  const videoClips = tracks.filter((t) => t.kind === "video" && !t.muted).flatMap((t) => t.clips.filter((c): c is MediaClip => c.kind === "media" && c.volume > 0));
  const halfFrame = 0.5 / project.settings.fps;
  for (const t of tracks) {
    if (t.kind !== "audio") continue;
    t.clips = t.clips.filter((c) => {
      if (c.kind !== "media" || independentAudio.has(c.id)) return true;
      return !videoClips.some(v => v.mediaId === c.mediaId && v.speed === c.speed &&
        Math.abs(v.timelineIn - c.timelineIn) < halfFrame && Math.abs(v.sourceIn - c.sourceIn) < halfFrame &&
        Math.abs(v.sourceOut - c.sourceOut) < halfFrame);
    });
  }
  const audioTracks = tracks.filter((t) => t.kind !== "audio" || t.clips.length || base.tracks.some((b) => b.id === t.id));

  // Captions and markers ride along from the exported version, re-timed through the footage.
  const draft = TimelineSchema.parse({ ...base, tracks: audioTracks, markers: [] });
  const issue = timelinePlanningIssue(draft);
  if (issue) throw new OtioImportError(issue);
  const map = makeTimeMap(base, draft, project.settings.fps);
  let captionRange: ReturnType<typeof captionRangeMap> | undefined;
  // Shorter than a frame of this project can't show. Mapping can leave an exact frame a few ulps short.
  const frame = 1 / project.settings.fps - 1e-6;
  const captionTracks: Track[] = base.tracks
    .filter((t) => t.kind === "caption")
    .map((t) => ({
      ...t,
      clips: t.clips.flatMap(c => {
        if (c.kind !== "caption") return [];
        captionRange ??= captionRangeMap(base, draft, project.settings.fps, map);
        return retimeCaption(c, captionRange, frame);
      }),
    }));
  const markers = base.markers.flatMap((m) => {
    const time = map(m.time);
    return time === null ? [] : [{ ...m, time, end: m.end !== undefined ? (map(m.end) ?? undefined) : undefined }];
  });

  return TimelineSchema.parse({ ...base, version: "draft", parent: base.version, tracks: [...audioTracks, ...captionTracks], markers });
}
