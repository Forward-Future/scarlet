/**
 * Cut list → ffmpeg filter graph.
 *
 * One range of the timeline becomes: a `color` canvas at the project size and
 * frame rate, every visible video/colour clip overlaid bottom track first,
 * captions drawn on top with drawtext, and every audible clip trimmed,
 * positioned with adelay and summed with amix. Each media clip is its own
 * `-ss/-t` input so long sources are only decoded where they are used.
 *
 * Time 0 of the output is `range.start`. Clip-local effects (fades, keyframes)
 * are evaluated in clip time by shifting PTS so that a clip's first visible
 * frame carries the timestamp it would have had if the clip were not trimmed.
 *
 * The graph is written to a temp file and passed with `-/filter_complex`
 * (ffmpeg >= 7; `-filter_complex_script` before that) to stay clear of the
 * Windows command-line length limit.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CaptionStyle as CaptionStyleSchema,
  Transform as TransformSchema,
  clipEnd,
  parseColor,
} from "@scarlet/timeline";
import type {
  CaptionStyle,
  Clip,
  ColorClip,
  MediaAsset,
  MediaClip,
  Project,
  Timeline,
  TimeRange,
  Track,
  Transform,
  TransformKeyframe,
} from "@scarlet/timeline";
import { INDEXED_MP4_INPUT, LOCAL_MEDIA_INPUT, SOURCE_AUDIO_CLOCK, ffmpegMajor, fnum } from "./exec.js";
import { effectFilters, effectKind, escapeFilterPath } from "./effects.js";
import { resolveFontFile, type FontOptions } from "./fonts.js";
import { hasIndexedAvc, isImagePath, probeMedia, storedAsShown, type ProbeResult } from "./probe.js";

export interface GraphOptions extends FontOptions {
  decoder?: "videotoolbox" | "videotoolbox-hevc" | "cuda";
  /** Reuse probed movie headers for seeks when the caller supports discovery fallback. */
  indexedInputs?: boolean;
  signal?: AbortSignal;
  pictureSource?: (asset: MediaAsset, from: number, to: number, minimumHeight: number) => Promise<{ file: string; start: number } | undefined>;
  audioOnly?: boolean;
  /** Exact sample count for a lossless delivery mix segment. */
  audioSamples?: number;
  pictureOnly?: boolean;
  /** Internal analysis filters applied to the completed picture, before the output map. */
  pictureFilter?: string;
  /** Absolute directory that relative `MediaAsset.path`s resolve against. */
  mediaRoot: string;
  /** Output canvas; defaults to the project settings. Previews pass a smaller size. */
  width?: number;
  height?: number;
  fps?: number;
  /** Sample a single picture at range.start, without decoding audio. */
  singleFrame?: boolean;
  /** Where the filter script and caption text files are written (default os.tmpdir()). */
  tempDir?: string;
  /** Probe cache keyed by media id, consulted when an asset lacks `hasAudio`. */
  probes?: Map<string, ProbeResult>;
  ffprobePath?: string;
  ffmpegPath?: string;
  /** Override the option used to load the script; auto-detected from the ffmpeg version. */
  filterScriptFlag?: "-/filter_complex" | "-filter_complex_script";
}

export interface FilterGraph {
  /** ffmpeg argv after the binary: inputs, the filter script option and output maps. */
  args: string[];
  /** Input files in `-i` order (one per media clip). */
  inputs: string[];
  warnings: string[];
  /** The filter graph text (also written to `scriptPath`). */
  graph: string;
  scriptPath: string;
  videoLabel: string;
  audioLabel: string;
  /** False when the audio output is generated silence. */
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  duration: number;
  range: TimeRange;
  /** Remove the temp directory holding the script and caption files. */
  cleanup: () => Promise<void>;
}

/** Where a clip sits inside the render range. */
interface Placement {
  /** Clip-local time at the first visible frame (>0 when the range starts mid-clip). */
  local0: number;
  /** Output time of the first visible frame. */
  pos: number;
  /** Visible duration. */
  vis: number;
  /** Full clip duration on the timeline. */
  clipDur: number;
}

/** The same intersection and minimum span must drive both the graph and its cache key. */
export function clipPlacement(clip: Clip, range: TimeRange, minimum: number): Placement | undefined {
  const end = clipEnd(clip);
  const a = Math.max(clip.timelineIn, range.start);
  const b = Math.min(end, range.end);
  if (b - a < minimum) return undefined;
  return { local0: a - clip.timelineIn, pos: a - range.start, vis: b - a, clipDur: end - clip.timelineIn };
}

/** Plain clips can run entirely in segment time after the input seek. Keeping
 * their old clip origin would introduce two unnecessary PTS rounding steps. */
export function videoClockStart(clip: Pick<MediaClip, "keyframes" | "videoFadeIn" | "videoFadeOut" | "effects">, localStart: number): number {
  return clip.keyframes?.length || clip.videoFadeIn || clip.videoFadeOut || clip.effects.some(effect => effect.enabled)
    ? localStart : 0;
}

/** Smallest source picture that preserves the layer at this canvas size. */
export function proxyHeightForClip(clip: MediaClip, asset: MediaAsset, width: number, height: number): number | undefined {
  if (!asset.width || !asset.height || clip.keyframes?.length || clip.effects.length) return;
  const t = clip.transform;
  const croppedWidth = 1 - (t?.cropLeft ?? 0) - (t?.cropRight ?? 0);
  const croppedHeight = 1 - (t?.cropTop ?? 0) - (t?.cropBottom ?? 0);
  return Math.ceil(Math.min(height / croppedHeight, width * asset.height / (asset.width * croppedWidth)) * (t?.scale ?? 1));
}

function hasIndexedClock(source: ProbeResult | undefined, fps: number | undefined): source is ProbeResult {
  return source?.videoCodec === "h264" && !!source.formatName?.split(",").includes("mov") && source.videoStreamCount === 1 &&
    !source.hasAlpha && source.fps === fps && source.previewClock?.startPts === 0 && source.videoStart === 0;
}

/** A dialogue export often reopens the same 4K GOP on both sides of each
 * small deletion. Let nearby frame-aligned shots trim one bounded video read. */
async function adjacentPictureReads(timeline: Timeline, range: TimeRange, media: Map<string, MediaAsset>, fps: number,
  covered: (track: number, placement: Placement) => boolean, getProbe: (asset: MediaAsset) => Promise<ProbeResult | undefined>) {
  type Read = { first: MediaClip; start: number; end: number; count: number };
  const reads = new Map<MediaClip, Read>();
  for (const [trackIndex, track] of timeline.tracks.entries()) {
    if (track.kind !== "video" || track.hidden) continue;
    let group: Read | undefined;
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

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/** An edge within a millisecond of a frame is on it, as on the timeline. Times are written to six decimals,
 * so a start written as 0.666667 is a hair after its own frame at 20/30 s, and an end written as 0.5 is on
 * the first frame past it. Testing a millisecond early puts both frames on the right side. */
const FRAME_SLACK = 0.001;

/** Whether a placed clip has a frame of the range to draw. One there for half a frame or more always did. A shorter
 * one does when a frame's time falls inside it: a take that runs a fraction of a frame into a section is still the
 * picture on the section's first frame, which the take after it does not draw. A still's length is counted in whole
 * frames, so less than half of one is none of it. The graph and its cache key share this. */
export function holdsFrame(p: Placement, fps: number, still = false): boolean {
  return p.vis >= 0.5 / fps || (!still && Math.ceil((p.pos - FRAME_SLACK) * fps) / fps < p.pos + p.vis - FRAME_SLACK);
}

/** Whether a span of sound, written as it is passed to ffmpeg, is a sample or more. ffmpeg reads a length of no
 * samples as no limit, and the clip would play on to the end of the range. The graph and its cache key share this. */
export function holdsSample(seconds: number, sampleRate: number): boolean {
  return Math.round(Number(fnum(seconds)) * sampleRate) >= 1;
}

/** Footage has one picture for each of the project's frames only at the project's rate and at normal speed. At any
 * other rate or speed it has too few or too many, so its layer is filled: one picture on every frame, each held until
 * the next. A file with no rate on record is taken to be at the project's. The graph and its cache key share this. */
export function fillsFrames(clip: Pick<MediaClip, "speed">, asset: Pick<MediaAsset, "kind" | "path" | "fps">, fps: number): boolean {
  const moving = asset.kind === "video" || (asset.kind === "graphic" && !isImagePath(asset.path));
  return moving && ((clip.speed ?? 1) !== 1 || (asset.fps !== undefined && asset.fps !== fps));
}

/**
 * Normalize CSS-ish colours ("#RGB", "#RRGGBB", "#RRGGBBAA", "0x...", names)
 * to ffmpeg syntax, optionally multiplying in an extra alpha.
 */
export function ffColor(color: string, alpha = 1): string {
  const parsed = parseColor(color);
  if (!parsed || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error("Invalid render color or opacity");
  const opacity = parsed.alpha * alpha;
  return opacity < 1 || parsed.explicitAlpha ? `${parsed.color}@${fnum(opacity, 4)}` : parsed.color;
}

/** `+x` / `-x` so expressions never contain "+-". */
function signed(n: number, unit = ""): string {
  if (n === 0) return "";
  return `${n < 0 ? "-" : "+"}${fnum(Math.abs(n))}${unit}`;
}

/** Split a playback speed into atempo factors inside the filter's 0.5..2 sweet spot. */
export function atempoFactors(speed: number): number[] {
  const out: number[] = [];
  let s = speed;
  if (!Number.isFinite(s) || s <= 0 || s === 1) return out;
  while (s > 2) {
    out.push(2);
    s /= 2;
  }
  while (s < 0.5) {
    out.push(0.5);
    s /= 0.5;
  }
  out.push(s);
  return out;
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

const T = "__T__";

function easeExpr(ease: TransformKeyframe["ease"], p: string): string {
  switch (ease) {
    case "easeIn":
      return `pow(${p},2)`;
    case "easeOut":
      return `(1-pow(1-${p},2))`;
    case "easeInOut":
      return `(${p}*${p}*(3-2*${p}))`;
    default:
      return p;
  }
}

interface KeyPoint {
  time: number;
  value: number;
  ease: TransformKeyframe["ease"];
}

/**
 * Piecewise expression in the placeholder time variable: nested `if(lt(T, t_i+1), seg_i, ...)`
 * with the last value held after the final keyframe. A segment uses the ease
 * of the keyframe it starts from; "hold" keeps the start value.
 */
export function keyframeExpr(points: KeyPoint[], tVar: string): string {
  const n = points.length;
  if (n === 0) return "0";
  if (n === 1) return fnum(points[0]!.value);
  let expr = fnum(points[n - 1]!.value);
  for (let i = n - 2; i >= 0; i--) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const dt = p1.time - p0.time;
    let seg: string;
    if (dt <= 0 || p0.ease === "hold" || p0.value === p1.value) {
      seg = fnum(p0.value);
    } else {
      const p = `clip((${tVar}${signed(-p0.time)})/${fnum(dt)},0,1)`;
      seg = `(${fnum(p0.value)}${signed(p1.value - p0.value)}*${easeExpr(p0.ease, p)})`;
    }
    expr = `if(lt(${tVar},${fnum(p1.time)}),${seg},${expr})`;
  }
  return expr;
}

interface AnimatedTransform {
  base: Transform;
  /** Expressions in `__T__` (clip-local seconds) or null when static. */
  x: string | null;
  y: string | null;
  scale: string | null;
}

function resolveTransform(
  clip: { transform?: Transform; keyframes?: TransformKeyframe[]; id: string },
  warn: (m: string) => void,
): AnimatedTransform {
  const base = TransformSchema.parse(clip.transform ?? {});
  const kfs = (clip.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
  const out: AnimatedTransform = { base, x: null, y: null, scale: null };
  if (!kfs.length) return out;
  if (kfs.some((k) => ["rotation", "cropLeft", "cropRight", "cropTop", "cropBottom"].some((p) => p in k.transform))) {
    warn(`clip ${clip.id}: keyframed rotation/crop are not supported; base values used`);
  }
  for (const prop of ["x", "y", "scale"] as const) {
    const points: KeyPoint[] = kfs.map((k) => ({
      time: k.time,
      value: k.transform[prop] ?? base[prop],
      ease: k.ease ?? "linear",
    }));
    const first = points[0]!.value;
    if (points.every((p) => p.value === first)) {
      if (first !== base[prop]) base[prop] = first;
      continue;
    }
    out[prop] = keyframeExpr(points, T);
  }
  return out;
}

/** crop → scale (contain-fit × scale) → round corners → rotate, as filter strings. */
function transformChain(tf: AnimatedTransform, W: number, H: number): string[] {
  const { base } = tf;
  const chain: string[] = [];
  if (base.cropLeft || base.cropRight || base.cropTop || base.cropBottom) {
    const w = Math.max(0.01, 1 - base.cropLeft - base.cropRight);
    const h = Math.max(0.01, 1 - base.cropTop - base.cropBottom);
    chain.push(
      `crop=w='trunc(iw*${fnum(w)})':h='trunc(ih*${fnum(h)})':x='trunc(iw*${fnum(base.cropLeft)})':y='trunc(ih*${fnum(base.cropTop)})'`,
    );
  }
  const fit = `min(${W}/iw,${H}/ih)`;
  // In scale expressions `t` is the input frame's timestamp (clip-local after setpts).
  const s = tf.scale ? `(${tf.scale.replaceAll(T, "t")})` : fnum(base.scale);
  const eval_ = tf.scale ? ":eval=frame" : "";
  chain.push(
    `scale=w='max(2,trunc(iw*${fit}*${s}/2)*2)':h='max(2,trunc(ih*${fit}*${s}/2)*2)'${eval_}:flags=bicubic`,
  );
  chain.push("format=yuva420p");
  if (base.cornerRadius) {
    // Only pixels in the four corner squares need the distance to the arc.
    // Fade the source alpha across one displayed pixel at its boundary.
    const radius = `min(W,H)*${fnum(base.cornerRadius)}`;
    const edgeX = "min(X+0.5,W-X-0.5)", edgeY = "min(Y+0.5,H-Y-0.5)";
    const arc = `clip(${radius}+0.5-hypot(${radius}-${edgeX},${radius}-${edgeY}),0,1)`;
    const coverage = `if(lt(max(${edgeX},${edgeY}),${radius}),${arc},1)`;
    chain.push(`geq=lum='p(X,Y)':a='alpha(X,Y)*${coverage}':i=nearest`);
  }
  if (base.rotation) {
    const a = `${fnum(base.rotation)}*PI/180`;
    chain.push(`rotate=a=${a}:ow='rotw(${a})':oh='roth(${a})':c=none`);
  }
  return chain;
}

/** overlay x/y expressions centring the layer, offset by normalized x/y (static or keyframed). */
function overlayPosition(tf: AnimatedTransform, localT: string): { x: string; y: string } {
  const x = tf.x ? `(W-w)/2+(${tf.x.replaceAll(T, localT)})*W` : `(W-w)/2${signed(tf.base.x, "*W")}`;
  const y = tf.y ? `(H-h)/2+(${tf.y.replaceAll(T, localT)})*H` : `(H-h)/2${signed(tf.base.y, "*H")}`;
  return { x, y };
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/** Greedy word wrap; drawtext does not wrap on its own. */
export function wrapText(text: string, maxChars: number): string {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (cur && cur.length + 1 + word.length > maxChars) {
        lines.push(cur);
        cur = word;
      } else {
        cur = cur ? `${cur} ${word}` : word;
      }
    }
    lines.push(cur);
  }
  return lines.join("\n");
}

export function mergeCaptionStyle(
  ...layers: Array<Partial<CaptionStyle> | undefined>
): CaptionStyle {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) merged[k] = v;
  }
  return CaptionStyleSchema.parse(merged);
}

// ---------------------------------------------------------------------------
// Occlusion
// ---------------------------------------------------------------------------

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
export function coversCanvas(clip: Clip, p: Placement, media: Map<string, MediaAsset>, W: number, H: number, picture?: ProbeResult): boolean {
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

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildFilterGraph(
  project: Project,
  timeline: Timeline,
  range: TimeRange,
  opts: GraphOptions,
): Promise<FilterGraph> {
  const tmp = await fs.mkdtemp(path.join(opts.tempDir ?? os.tmpdir(), "scarlet-graph-"));
  const cleanup = () => fs.rm(tmp, { recursive: true, force: true });
  try {
    return await writeFilterGraph(project, timeline, range, opts, tmp, cleanup);
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function writeFilterGraph(
  project: Project, timeline: Timeline, range: TimeRange, opts: GraphOptions,
  tmp: string, cleanup: () => Promise<void>,
): Promise<FilterGraph> {
  const settings = project.settings;
  const W = even(opts.width ?? settings.width);
  const H = even(opts.height ?? settings.height);
  const fps = opts.fps ?? settings.fps;
  const SR = settings.sampleRate;
  const layout = settings.audioChannels === 1 ? "mono" : "stereo";
  const R0 = range.start;
  const R1 = range.end;
  const D = R1 - R0;
  if (!(D > 0)) throw new Error(`empty render range ${R0}..${R1}`);

  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const media = new Map(project.media.map((m) => [m.id, m]));
  const probes = opts.probes ?? new Map<string, ProbeResult>();
  const effectCtx = { mediaRoot: opts.mediaRoot, warn };

  const inputs: string[] = [];
  const inputArgs: string[] = [];
  const opened = new Map<string, number>();
  const addInput = (pre: string[], file: string): number => {
    const key = JSON.stringify([file, pre]);
    const previous = opened.get(key);
    if (previous !== undefined) return previous;
    opened.set(key, inputs.length);
    inputArgs.push(...pre, ...LOCAL_MEDIA_INPUT, "-i", file);
    inputs.push(file);
    return inputs.length - 1;
  };

  const lines: string[] = [];
  let labelN = 0;
  const label = (p: string) => `[${p}${labelN++}]`;

  const mediaPath = (asset: MediaAsset) =>
    path.isAbsolute(asset.path) ? asset.path : path.join(opts.mediaRoot, asset.path);

  const isStill = (asset: MediaAsset, file: string) =>
    asset.kind === "image" || (asset.kind === "graphic" && isImagePath(file));

  const probeAsset = async (asset: MediaAsset) => {
    const cached = probes.get(asset.id);
    if (cached) return cached;
    const result = await probeMedia(mediaPath(asset), { ffprobePath: opts.ffprobePath, signal: opts.signal });
    probes.set(asset.id, result);
    return result;
  };

  const hasAudio = async (asset: MediaAsset, file: string): Promise<boolean> => {
    if (asset.kind === "audio") return true;
    if (asset.kind === "image") return false;
    if (asset.hasAudio !== undefined) return asset.hasAudio;
    if (isStill(asset, file)) return false;
    try { return (await probeAsset(asset)).hasAudio; }
    catch (e) {
      opts.signal?.throwIfAborted();
      warn(`could not probe ${asset.path}: ${(e as Error).message.split("\n")[0]}`);
      return false;
    }
  };

  // Canvas.
  if (!opts.audioOnly) lines.push(`color=c=${ffColor(timeline.background)}:s=${W}x${H}:r=${fnum(fps)}:d=${fnum(D)}[base]`);
  let stack = "[base]";
  const audioLabels: string[] = [];
  const includeAudio = !opts.singleFrame && !opts.pictureOnly;

  const overlay = (layer: string, x: string, y: string, p: Placement, filled = false) => {
    const out = label("s");
    // The layer's own end stops it. Its start needs the test: overlay shows a layer from the base frame
    // nearest its first picture, which can be the frame before. A filled layer holds its last picture for as
    // long as its source showed it, which can be past the clip, so its window also ends on the clip's last
    // frame, as a caption's does. Any other layer keeps the frame it has when its clip ends just after one.
    lines.push(
      `${stack}${layer}overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${fnum(p.pos - FRAME_SLACK)},${fnum(p.pos + p.vis - (filled ? FRAME_SLACK : 0))})'${out}`,
    );
    stack = out;
  };

  const videoForMedia = (clip: MediaClip, idx: number, still: boolean, p: Placement, cudaScale: boolean, sharedStart?: number, held = false, filled = false) => {
    const speed = clip.speed ?? 1;
    const tf = resolveTransform(clip, warn);
    const chain: string[] = [];
    // Repeat the first picture on the clock the image demuxer's loop gives a still: one tick a frame.
    if (held) chain.push("loop=loop=-1:size=1:start=0", "settb=AVTB", `setpts=N/${fnum(fps)}/TB`, `fps=${fnum(fps)}`);
    // Download only the preview-sized picture for the CPU compositor.
    if (cudaScale) chain.push(`scale_cuda=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:format=yuv420p:interp_algo=bicubic`, "hwdownload", "format=yuv420p");
    // Source → clip-local time (speed applied, shifted so the first visible frame
    // sits at local0, which keeps fades and keyframes in clip time).
    chain.push(sharedStart === undefined ? `trim=duration=${fnum(still ? p.vis : p.vis * speed)}`
      : `trim=start=${fnum(sharedStart)}:end=${fnum(sharedStart + p.vis)}`);
    const div = speed !== 1 && !still ? `/${fnum(speed)}` : "";
    const localStart = videoClockStart(clip, p.local0);
    // A still's clock ticks once a frame and setpts drops the fraction, so 0.033333 s would land a frame early.
    const offset = (seconds: number) => still ? `${seconds < 0 ? "-" : "+"}round(${fnum(Math.abs(seconds))}/TB)` : signed(seconds, "/TB");
    chain.push(`setpts=(PTS-STARTPTS)${div}${localStart > 0 ? offset(localStart) : ""}`);
    chain.push(...effectFilters(clip.effects, "video", effectCtx));
    chain.push(...transformChain(tf, W, H));
    if (clip.videoFadeIn > 0) chain.push(`fade=t=in:st=0:d=${fnum(clip.videoFadeIn)}:alpha=1`);
    if (clip.videoFadeOut > 0) {
      chain.push(`fade=t=out:st=${fnum(Math.max(0, p.clipDur - clip.videoFadeOut))}:d=${fnum(clip.videoFadeOut)}:alpha=1`);
    }
    if (clip.opacity < 1) chain.push(`format=rgba,colorchannelmixer=aa=${fnum(clip.opacity)},format=yuva420p`);
    // Clip-local → output time.
    const shift = p.pos - localStart;
    if (shift !== 0) chain.push(`setpts=PTS${offset(shift)}`);
    // Overlay shows a layer's last picture for one project frame, however long its source showed it, and of two
    // pictures that land on one frame it shows the first. Filled, the layer has one picture on every frame: each
    // held until the next, and the last to the end of its stream.
    if (filled) chain.push(`fps=${fnum(fps)}`);
    const lbl = label("v");
    lines.push(`[${idx}:v]${chain.join(",")}${lbl}`);
    const pos = overlayPosition(tf, shift ? `(t${signed(-shift)})` : "t");
    overlay(lbl, pos.x, pos.y, p, filled);
  };

  const videoForColor = (clip: ColorClip, p: Placement) => {
    const tf = resolveTransform({ id: clip.id, transform: clip.transform }, warn);
    // Pin an alpha format right at the source so the colour's alpha survives negotiation.
    const chain = [
      `color=c=${ffColor(clip.color, clip.opacity)}:s=${W}x${H}:r=${fnum(fps)}:d=${fnum(p.vis)}`,
      "format=yuva420p",
      ...transformChain(tf, W, H),
    ];
    if (p.pos > 0) chain.push(`setpts=PTS+round(${fnum(p.pos)}/TB)`);
    const lbl = label("c");
    lines.push(`${chain.join(",")}${lbl}`);
    const pos = overlayPosition(tf, "t");
    overlay(lbl, pos.x, pos.y, p);
  };

  const audioForMedia = (clip: MediaClip, idx: number, p: Placement, skip: number) => {
    const speed = clip.speed ?? 1;
    // Keep a delayed microphone on the input seek clock. Fill its leading
    // silence before trimming, changing speed or mixing it with other clips.
    const chain: string[] = [SOURCE_AUDIO_CLOCK, `atrim=start=${fnum(skip)}:duration=${fnum(p.vis * speed)}`, "asetpts=PTS-STARTPTS"];
    for (const f of atempoFactors(speed)) chain.push(`atempo=${fnum(f)}`);
    chain.push(...effectFilters(clip.effects, "audio", effectCtx));
    if (clip.volume !== 1) chain.push(`volume=${fnum(clip.volume)}`);
    if (clip.audioFadeIn > 0 || clip.audioFadeOut > 0) {
      if (p.local0 > 0) chain.push(`asetpts=PTS+${fnum(p.local0)}/TB`);
      if (clip.audioFadeIn > 0) chain.push(`afade=t=in:st=0:d=${fnum(clip.audioFadeIn)}`);
      if (clip.audioFadeOut > 0) {
        chain.push(`afade=t=out:st=${fnum(Math.max(0, p.clipDur - clip.audioFadeOut))}:d=${fnum(clip.audioFadeOut)}`);
      }
      chain.push("asetpts=PTS-STARTPTS");
    }
    chain.push(`aformat=sample_rates=${SR}:channel_layouts=${layout}`);
    if (p.pos > 0) chain.push(`adelay=${Math.round(p.pos * SR)}S:all=1`);
    const lbl = label("a");
    lines.push(`[${idx}:a]${chain.join(",")}${lbl}`);
    audioLabels.push(lbl);
  };

  // An opaque picture that fills the canvas hides every lower layer for as long as it is
  // shown. Those layers still contribute sound, but their pictures need no decode.
  const verifiedProbe = async (asset: MediaAsset) => {
    try { return await probeAsset(asset); }
    catch { opts.signal?.throwIfAborted(); return; }
  };
  const assetStoredAsShown = async (asset: MediaAsset) => {
    const probe = await verifiedProbe(asset);
    return !!probe && storedAsShown(probe);
  };
  const covers: Array<{ track: number; start: number; end: number }> = [];
  if (!opts.audioOnly) {
    for (const [trackIndex, track] of timeline.tracks.entries()) {
      if (trackIndex === 0 || track.kind !== "video" || track.hidden) continue;
      for (const clip of track.clips) {
        if (clip.enabled === false) continue;
        const p = clipPlacement(clip, range, 0.5 / fps);
        if (!p) continue;
        const asset = clip.kind === "media" ? media.get(clip.mediaId) : undefined;
        const picture = asset?.kind === "video" && asset.hasAlpha === false ? await verifiedProbe(asset) : undefined;
        if (coversCanvas(clip, p, media, W, H, picture)) covers.push({ track: trackIndex, start: p.pos, end: p.pos + p.vis });
      }
    }
  }
  const covered = (trackIndex: number, p: Placement) =>
    covers.some(c => c.track > trackIndex && c.start <= p.pos + 1e-6 && c.end >= p.pos + p.vis - 1e-6);

  const sharedReads = opts.indexedInputs && opts.pictureOnly && !opts.singleFrame && !opts.pictureSource && !opts.decoder && W * H <= 1920 * 1080
    ? await adjacentPictureReads(timeline, range, media, fps, covered, verifiedProbe) : undefined;
  // Video and audio tracks, bottom first so later tracks composite on top.
  for (const [trackIndex, track] of timeline.tracks.entries()) {
    if (track.kind === "caption") continue;
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      // Half a sample places a clip, so the sound of a sliver at the range's edge stays. Its picture needs a frame to be on.
      const p = clipPlacement(clip, range, 0.5 / SR);
      if (!p) continue;
      const showVideo = !opts.audioOnly && track.kind === "video" && !track.hidden && holdsFrame(p, fps) && !covered(trackIndex, p);

      if (clip.kind === "color") {
        if (showVideo) videoForColor(clip, p);
        continue;
      }
      if (clip.kind !== "media") continue;

      const asset = media.get(clip.mediaId);
      if (!asset) {
        warn(`clip ${clip.id}: media ${clip.mediaId} not in project; skipped`);
        continue;
      }
      const file = mediaPath(asset);
      const still = isStill(asset, file);
      const wantVideo = showVideo && asset.kind !== "audio" && holdsFrame(p, fps, still);
      const speed = clip.speed ?? 1;
      const wantAudio = includeAudio && !track.muted && clip.volume > 0 && holdsSample(p.vis * speed, SR) && (await hasAudio(asset, file));
      if (!wantVideo && !wantAudio) continue;

      const srcStart = clip.sourceIn + p.local0 * speed;
      const firstPicture = still || asset.kind === "audio" ? 0 :
        asset.previewClock?.videoStart ?? (await verifiedProbe(asset))?.videoStart ?? 0;
      // A timeline frame can land between source frames, including just past the
      // last source frame's timestamp. Seek to the frame displayed at that time.
      const seek = opts.singleFrame && asset.fps && srcStart >= firstPicture
        ? firstPicture + Math.floor((srcStart - firstPicture) * asset.fps + 1e-7) / asset.fps : srcStart;
      // Import records carry the probed video codec in their playback MIME type.
      const codec = /\bcodecs="(avc1|hvc1)[.,"]/i.exec(asset.originalPlaybackType ?? "")?.[1]?.toLowerCase();
      const accelerate = opts.decoder && wantVideo && asset.kind === "video" && codec &&
        (opts.decoder !== "videotoolbox-hevc" || codec === "hvc1");
      // The last test reads the file: these frames stay on the GPU, where a clip stored sideways is not turned.
      const cudaScale = !!accelerate && opts.decoder === "cuda" && asset.hasAlpha === false &&
        !!asset.width && !!asset.height && asset.height > H && asset.width * H === asset.height * W &&
        !clip.transform && !clip.keyframes?.length && !clip.effects.length && await assetStoredAsShown(asset);
      // FFmpeg's packet scan can discover AAC priming that is absent from the
      // movie index. Preserve it whenever the graph reads sound.
      const shared = sharedReads?.get(clip);
      const indexedPicture = opts.indexedInputs && !includeAudio;
      let indexedOriginal = !!asset.previewClock && hasIndexedAvc(asset);
      const open = (input: string, start: number, hardware: boolean, duration = p.vis * speed) => addInput([
        ...(indexedPicture && (input !== file || shared || indexedOriginal) ? INDEXED_MP4_INPUT : []),
        ...(hardware && cudaScale ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] :
          hardware && accelerate && opts.decoder !== "cuda" ? ["-hwaccel", "videotoolbox"] : []),
        ...(start > 0 ? ["-ss", fnum(start)] : []), "-t", fnum(duration),
      ], input);
      const pictureDelay = Math.max(0, firstPicture - srcStart) / speed;
      if (wantVideo && pictureDelay < p.vis) {
        const visible = pictureDelay > 0 ? { ...p, local0: p.local0 + pictureDelay, pos: p.pos + pictureDelay, vis: p.vis - pictureDelay } : p;
        const pictureSeek = Math.max(seek, firstPicture);
        let proxy: { file: string; start: number } | undefined;
        if (opts.pictureSource && !still) {
          const needed = proxyHeightForClip(clip, asset, W, H);
          if (needed !== undefined) proxy = await opts.pictureSource(asset, pictureSeek, pictureSeek + visible.vis * speed, needed);
        }
        // Older imports lack a saved picture clock. Validate the current file once
        // before allowing header-only seeks for stills. Probe results follow file changes.
        if (opts.singleFrame && indexedPicture && !asset.previewClock && !proxy && hasIndexedAvc(asset)) {
          const source = await verifiedProbe(asset);
          indexedOriginal = hasIndexedClock(source, asset.fps) && source.rotation === 0 && source.pixFmt === "yuv420p" &&
            source.width === asset.width && source.height === asset.height;
        }
        // Only the image demuxer repeats a picture at the input. A GIF, or a movie
        // holding one picture, is read once and repeated in the graph.
        const held = still && (!isImagePath(file) || /\.gif$/i.test(file));
        const idx = held ? addInput(["-t", fnum(p.vis)], file)
          : still ? addInput(["-loop", "1", "-framerate", fnum(fps), "-t", fnum(p.vis)], file)
          : shared ? open(file, shared.start / fps, true, (shared.end - shared.start) / fps)
          : open(proxy?.file ?? file, Math.max(0, pictureSeek - (proxy?.start ?? 0)), !proxy, visible.vis * speed);
        // A single frame already seeks to the picture shown at its time.
        videoForMedia(clip, idx, still, visible, cudaScale && !proxy, shared ? pictureSeek - shared.start / fps : undefined, held,
          !opts.singleFrame && fillsFrames(clip, asset, fps));
      }
      if (wantAudio) {
        // Seeking before a movie's first video keyframe can discard earlier
        // audio packets. Read that prefix from the beginning and trim by PTS.
        const skip = srcStart < firstPicture ? srcStart : 0;
        audioForMedia(clip, open(file, srcStart - skip, true, p.vis * speed + skip), p, skip);
      }
    }
  }

  // Captions, always above video.
  let captionN = 0;
  const drawtexts: string[] = [];
  for (const track of timeline.tracks) {
    if (opts.audioOnly || track.kind !== "caption" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "caption" || clip.enabled === false) continue;
      const p = clipPlacement(clip, range, 0.5 / SR);
      if (!p || !holdsFrame(p, fps)) continue;
      const style = mergeCaptionStyle(timeline.captionStyle, track.captionStyle, clip.style);
      const fontsize = Math.max(1, Math.round(style.fontSize * H));
      const text = style.uppercase ? clip.text.toUpperCase() : clip.text;
      // ~0.5em average glyph width; good enough to keep lines inside maxWidth.
      const maxChars = Math.max(1, Math.floor((style.maxWidth * W) / (fontsize * 0.5)));
      const textFile = path.join(tmp, `caption-${captionN++}.txt`);
      await fs.writeFile(textFile, wrapText(text, maxChars), "utf8");

      const o: string[] = [];
      const font = resolveFontFile(style.fontFamily, opts);
      if (font) {
        o.push(`fontfile=${escapeFilterPath(font.file)}`);
        if (!font.exact) warn(`font "${style.fontFamily}" not found; using ${path.basename(font.file)}`);
      } else {
        const family = /^[\p{L}\p{N} _.-]+$/u.test(style.fontFamily) ? style.fontFamily : "sans-serif";
        o.push(`font='${family}'`);
        warn(`no font file found for "${style.fontFamily}"; relying on fontconfig`);
      }
      o.push(`textfile=${escapeFilterPath(textFile)}`, "expansion=none");
      o.push(`fontsize=${fontsize}`, `fontcolor=${ffColor(style.color)}`, `line_spacing=${Math.round(fontsize * 0.2)}`);
      if (style.backgroundColor) {
        o.push("box=1", `boxcolor=${ffColor(style.backgroundColor)}`, `boxborderw=${Math.round(fontsize * 0.25)}`);
      }
      if (style.outlineWidth > 0) {
        // < 1 reads as a fraction of the font size, otherwise pixels at project resolution.
        const px = style.outlineWidth < 1 ? style.outlineWidth * fontsize : (style.outlineWidth * H) / settings.height;
        o.push(`borderw=${Math.max(1, Math.round(px))}`, `bordercolor=${ffColor(style.outlineColor ?? "#000000")}`);
      }
      const margin = Math.round(((1 - style.maxWidth) / 2) * W);
      o.push(
        `x=${style.align === "left" ? margin : style.align === "right" ? `w-text_w-${margin}` : "(w-text_w)/2"}`,
        `y=${fnum(style.y * H)}-text_h/2`,
        `enable='between(t,${fnum(p.pos - FRAME_SLACK)},${fnum(p.pos + p.vis - FRAME_SLACK)})'`,
      );
      if (style.highlightColor && clip.words?.length) {
        warn("per-word caption highlighting is not supported by the ffmpeg renderer; captions drawn without highlight");
      }
      drawtexts.push(`drawtext=${o.join(":")}`);
    }
  }
  if (drawtexts.length) {
    const out = label("s");
    lines.push(`${stack}${drawtexts.join(",")}${out}`);
    stack = out;
  }

  if (!opts.audioOnly) lines.push(`${stack}trim=duration=${fnum(D)},setpts=PTS-STARTPTS,format=yuv420p${opts.pictureFilter ? "," + opts.pictureFilter : ""}[vout]`);

  // Audio mix, padded/trimmed to the exact duration.
  if (includeAudio) {
    const tail = opts.audioSamples !== undefined ? `apad,atrim=end_sample=${opts.audioSamples},asetpts=PTS-STARTPTS[aout]` : `apad=whole_dur=${fnum(D)},atrim=duration=${fnum(D)},asetpts=PTS-STARTPTS[aout]`;
    if (audioLabels.length === 0) {
      lines.push(opts.audioSamples === undefined ? `anullsrc=r=${SR}:cl=${layout}:d=${fnum(D)}[aout]` : `anullsrc=r=${SR}:cl=${layout},${tail}`);
    } else if (audioLabels.length === 1) {
      lines.push(`${audioLabels[0]}${tail}`);
    } else {
      lines.push(
        `${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest:dropout_transition=0,${tail}`,
      );
    }
  }

  const graph = lines.join(";\n") + "\n";
  const scriptPath = path.join(tmp, "graph.txt");
  await fs.writeFile(scriptPath, graph, "utf8");

  let flag = opts.filterScriptFlag;
  if (!flag) {
    const major = await ffmpegMajor(opts.ffmpegPath).catch(() => undefined);
    flag = (major ?? 7) >= 7 ? "-/filter_complex" : "-filter_complex_script";
  }

  return {
    args: [...inputArgs, flag, scriptPath, ...(opts.audioOnly ? [] : ["-map", "[vout]"]), ...(includeAudio ? ["-map", "[aout]"] : [])],
    inputs,
    warnings,
    graph,
    scriptPath,
    videoLabel: "[vout]",
    audioLabel: "[aout]",
    hasAudio: audioLabels.length > 0,
    width: W,
    height: H,
    fps,
    duration: D,
    range: { start: R0, end: R1 },
    cleanup,
  };
}

/** Tracks in compositing order (as stored: index 0 is the bottom video track). */
export function videoTracks(timeline: Timeline): Track[] {
  return timeline.tracks.filter((t) => t.kind === "video");
}
