import { clipEnd, makeTrack, newId, Transform, type MediaAsset, type Project, type Timeline, type TimelineOp } from "@scarlet/timeline";
import { z } from "zod/v3";

export const InsetFraming = z.object({
  scale: z.number().finite().positive(), x: z.number().finite(), y: z.number().finite(),
  ...Transform.pick({ cropLeft: true, cropRight: true, cropTop: true, cropBottom: true, cornerRadius: true }).partial().shape,
});

/**
 * The presenter in an inset, in the terms an editor's skill uses. Scarlet places the crop on where `faces` finds them:
 * the model names how much of them to show and the inset's shape, never the arithmetic.
 */
export const InsetPresenter = z.object({
  show: z.enum(["head", "shoulders", "chest", "desk"]).optional()
    .describe("How far down the presenter the inset reaches, from clear room above their hair: head (to the chin), shoulders (the default), chest, or desk (as far as the camera shows, hands and desk in)"),
  aspect: z.number().finite().min(.5).max(3).optional().describe("The inset's width over its height, e.g. 1.5 for 1.5:1. Default: the video's shape"),
  size: z.number().finite().min(.4).max(2.5).optional().describe("The inset's size against the preset quarter-size inset: 1.2 is 20% larger in both dimensions. Default 1"),
  cornerRadius: z.number().min(0).max(.5).optional().describe("Rounds the inset's four corners, as a fraction of its shorter side (about 0.06 reads as rounded). Default square"),
});
export type InsetPresenter = z.infer<typeof InsetPresenter>;

type SyncPicture = "asPlaced" | { screenClipId: string; cameraClipId: string; framing?: z.infer<typeof InsetFraming> };

/** The inset's place: `size` times a quarter of the canvas, fitted to a picture of `aspect`, in the bottom-right corner. */
function insetPlace(project: Project, aspect: number, size = 1): Pick<Transform, "scale" | "x" | "y"> {
  const canvas = project.settings.width / project.settings.height;
  const scale = 0.25 * size, margin = 0.025;
  const x = 0.5 - margin - scale * Math.min(1, aspect / canvas) / 2;
  const y = 0.5 - margin - scale * Math.min(1, canvas / aspect) / 2;
  return { scale: round(scale), x: round(x), y: round(y) };
}

/** The preset inset: a quarter of the canvas, in its bottom-right corner. */
export function insetFraming(project: Project, asset: Pick<MediaAsset, "width" | "height">): Pick<Transform, "scale" | "x" | "y"> {
  const canvas = project.settings.width / project.settings.height;
  return insetPlace(project, asset.width && asset.height ? asset.width / asset.height : canvas);
}

/** What `faces` found in a stretch of the camera: its spans, with the track each belongs to. */
export interface FaceReading {
  /** The source seconds read. A span can run on past them: only its seconds inside count. */
  from?: number; to?: number;
  /** False while the stretch is still being read. */
  done?: boolean;
  spans: ReadonlyArray<{ track: number; start: number; end: number; box: readonly [number, number, number, number]; eyes: readonly [number, number]; confidence: number }>;
}

/** The preset inset over a camera, and what its framing rests on. */
export interface PresetInset {
  framing: z.infer<typeof InsetFraming>;
  /** The presenter the crop holds, in fractions of the source picture, and the seconds of footage it was measured over. */
  presenter?: { box: [number, number, number, number]; eyes: [number, number]; seconds: number };
  /** Why the crop isn't placed on the presenter: the inset shows the camera's whole height, or the middle of its width. */
  whole?: string;
}

/**
 * How far below the eyes each `show` reaches, and the room above them that holds the hair, in face widths. Read off a
 * 4K talking head (2026-11-20): hair 0.8 of a face width above the eyes, chin 0.45 below, shoulders in by 1.1, mid-chest 1.6.
 * A tenth of a face width over the hair left it touching the inset's top edge (2026-11-20), so the room above is a fifth.
 */
const BELOW_EYES = { head: .6, shoulders: 1.1, chest: 1.6, desk: 2.6 } as const;
const ABOVE_EYES = 1;
/** The share of the footage the presenter's eyes may sit higher than the room above them is measured from. */
const HIGHEST = .02;
/** A crop this close to the whole picture isn't worth the camera's resolution. */
const WHOLE = .97;

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, size: number) => Math.min(Math.max(n, 0), 1 - size);

/** The value at fraction `p` of the seconds given, each value weighted by its seconds. */
function weighted(values: ReadonlyArray<[number, number]>, p: number): number {
  const sorted = [...values].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((n, [, w]) => n + w, 0);
  let seen = 0;
  for (const [v, w] of sorted) if ((seen += w) >= p * total) return v;
  return sorted.at(-1)![0];
}

/**
 * The inset over a camera, holding the presenter as `want` asks: head and shoulders in the video's shape at the preset
 * size unless it says otherwise. A wide camera shrunk whole into the corner left the presenter a small figure beside a
 * mic arm and a shelf, and every model left it uncropped (2026-11-20); the editor's skill asked for an inset 20% larger,
 * 1.5:1, from above the hair to the desk, with rounded corners, which no run made by hand. The crop is placed on where
 * `faces` found the presenter across the footage the inset plays, and one crop holds them throughout, since a crop can't
 * be keyframed. A second face that shares the picture, or none, leaves who to show to the model: the inset then keeps
 * the camera's whole height, cut to the shape asked from the middle.
 */
export function presetInset(project: Project, asset: Pick<MediaAsset, "width" | "height">, readings: readonly FaceReading[], want: InsetPresenter = {}): PresetInset {
  const canvas = project.settings.width / project.settings.height;
  const aspect = want.aspect ?? canvas;
  const corner = want.cornerRadius ? { cornerRadius: want.cornerRadius } : {};
  const width = asset.width, height = asset.height;
  const crop = (left: number, top: number, w: number, h: number) => w >= WHOLE && h >= WHOLE ? {} :
    { cropLeft: round(left), cropRight: round(1 - left - w), cropTop: round(top), cropBottom: round(1 - top - h) };
  const whole = (why: string): PresetInset => {
    if (!width || !height) return { framing: { ...insetFraming(project, asset), ...corner }, whole: why };
    const source = width / height;
    // The camera's middle, cut to the shape asked.
    const w = Math.min(1, aspect / source), h = Math.min(1, source / aspect);
    const cut = crop((1 - w) / 2, (1 - h) / 2, w, h);
    return { framing: { ...insetPlace(project, "cropLeft" in cut ? aspect : source, want.size), ...cut, ...corner }, whole: why };
  };
  if (!width || !height) return whole("the camera's picture size isn't known yet");
  const spans = readings.flatMap(r => r.spans.map(s => ({ ...s, start: Math.max(s.start, r.from ?? s.start), end: Math.min(s.end, r.to ?? s.end) })))
    .filter(s => s.end > s.start);
  const seconds = new Map<number, number>();
  for (const s of spans) seconds.set(s.track, (seconds.get(s.track) ?? 0) + s.end - s.start);
  const ranked = [...seconds].sort((a, b) => b[1] - a[1]);
  const [main, mainSeconds = 0] = ranked[0] ?? [];
  if (main === undefined || mainSeconds < 3) return whole(readings.some(r => r.done === false)
    ? "its faces weren't read in time" : "no face was found in the camera's picture");
  const other = ranked.slice(1).find(([track, n]) => n >= mainSeconds / 4 &&
    weighted(spans.filter(s => s.track === track).map(s => [s.confidence, s.end - s.start]), .5) >= .6);
  if (other) return whole(`a second face shares the camera's picture for ${other[1].toFixed(0)} s`);
  const own = spans.filter(s => s.track === main);
  const at = (f: (s: (typeof own)[number]) => number, p: number) => weighted(own.map(s => [f(s), s.end - s.start]), p);
  // Where the presenter keeps to: the box edges and eye line they hold for all but a tenth of the footage.
  const held: [number, number, number, number] = [at(s => s.box[0], .1), at(s => s.box[1], .1), at(s => s.box[2], .9), at(s => s.box[3], .9)];
  const eyes: [number, number] = [at(s => s.eyes[0], .5), at(s => s.eyes[1], .5)];
  const source = width / height;
  // A face's width in fractions of the picture's height: the unit the margins above and below the eyes are in.
  const face = at(s => s.box[2] - s.box[0], .5) * source;
  const top = Math.max(0, at(s => s.eyes[1], HIGHEST) - ABOVE_EYES * face);
  const need = Math.min(1, at(s => s.eyes[1], .9) + BELOW_EYES[want.show ?? "shoulders"] * face) - top;
  // The crop's width and height in fractions of the source picture, in the shape asked, wide enough for where the
  // presenter moves and never past the picture.
  let w = Math.max(need * aspect / source, (held[2] - held[0]) * 1.5), h = w * source / aspect;
  if (h > 1) { h = 1; w = aspect / source; }
  if (w > 1) { w = 1; h = source / aspect; }
  const cut = crop(clamp((held[0] + held[2]) / 2 - w / 2, w), clamp(top - Math.max(0, h - need) * .3, h), w, h);
  return {
    framing: { ...insetPlace(project, "cropLeft" in cut ? aspect : source, want.size), ...cut, ...corner },
    ...(!("cropLeft" in cut) && { whole: "the presenter already fills the camera's picture" }),
    presenter: { box: held, eyes, seconds: Math.round(mainSeconds) },
  };
}

/** Source stretches spread across `from`-`to` where the faces an inset preset rests on are read. */
export function insetStretches(from: number, to: number, count = 6, seconds = 10): Array<{ from: number; to: number }> {
  if (to - from <= count * seconds) return [{ from, to }];
  return Array.from({ length: count }, (_, i) => {
    const middle = from + (i + .5) * (to - from) / count;
    return { from: middle - seconds / 2, to: middle + seconds / 2 };
  });
}

/** Resolve the editor's picture roles after all source offsets have been placed. */
export function syncPictureOps(project: Project, placed: Timeline, layout?: SyncPicture): TimelineOp[] {
  if (!layout || layout === "asPlaced") return [];
  const videos = new Map(project.media.filter(m => m.kind === "video").map(m => [m.id, m]));
  const layers = placed.tracks.flatMap((track, index) => {
    if (track.kind !== "video" || track.hidden) return [];
    return track.clips.flatMap(clip => clip.kind === "media" && clip.enabled && clip.opacity > 0 && videos.has(clip.mediaId)
      ? [{ clip, track, index }] : []);
  });
  const screen = layers.find(l => l.clip.id === layout.screenClipId);
  const camera = layers.find(l => l.clip.id === layout.cameraClipId);
  if (!screen || !camera || screen.track === camera.track || screen.clip.mediaId === camera.clip.mediaId) {
    throw new Error("Choose a screen clip and a separate camera recording on visible video tracks.");
  }
  const clip = camera.clip;
  const start = Math.max(clip.timelineIn, screen.clip.timelineIn);
  const end = Math.min(clipEnd(clip), clipEnd(screen.clip));
  if (end <= start) throw new Error("The screen and camera clips must overlap after sync.");
  const tf = Transform.parse(clip.transform ?? {});
  if (clip.keyframes?.length || tf.scale !== 1 || tf.x || tf.y || tf.rotation || tf.cropLeft || tf.cropRight || tf.cropTop || tf.cropBottom || tf.cornerRadius ||
      clip.effects.some(effect => effect.enabled) || clip.videoFadeIn || clip.videoFadeOut || clip.audioFadeIn || clip.audioFadeOut) {
    throw new Error("The camera already has framing, effects or fades. Use 'asPlaced' to preserve them.");
  }

  // Isolate only the overlap. The ordinary timeline splits retain source clocks,
  // playback speed and gain through the camera-only lead and tail.
  const ops: TimelineOp[] = [];
  let insetId = clip.id;
  // Edges that differ only by floating-point error are the same edge. Two recordings laid in sync end together to
  // the thirteenth decimal, and a split there left a clip of no length that the agent then spent a turn removing.
  const apart = 1e-6;
  if (start > clip.timelineIn + apart) {
    insetId = newId("clip");
    ops.push({ op: "splitClip", clipId: clip.id, at: start, newClipId: insetId });
  }
  if (end < clipEnd(clip) - apart) ops.push({ op: "splitClip", clipId: insetId, at: end, newClipId: newId("clip") });
  if (camera.index < screen.index) {
    const track = { ...makeTrack("video", "Camera inset"), muted: camera.track.muted };
    ops.push({ op: "addTrack", track, index: screen.index + 1 }, { op: "moveClip", clipId: insetId, timelineIn: start, trackId: track.id });
  }
  ops.push({ op: "updateClip", clipId: insetId, patch: { transform: layout.framing ?? insetFraming(project, videos.get(clip.mediaId)!) } });
  return ops;
}
