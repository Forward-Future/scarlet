/**
 * Pure filter-graph building blocks: clip placement, timing helpers, color
 * normalization, atempo factoring, and keyframed transform filter chains.
 */
import {
  Transform as TransformSchema,
  clipEnd,
  parseColor,
} from "@scarlet/timeline";
import type {
  Clip,
  MediaAsset,
  MediaClip,
  TimeRange,
  Transform,
  TransformKeyframe,
} from "@scarlet/timeline";
import { fnum } from "./exec.js";
import { isMovingAsset } from "./probe.js";

/** Where a clip sits inside the render range. */
export interface Placement {
  /** Clip-local time at the first visible frame (>0 when the range starts mid-clip). */
  local0: number;
  /** Output time of the first visible frame. */
  pos: number;
  /** Visible duration. */
  vis: number;
  /** Full clip duration on the timeline. */
  clipDur: number;
}

/** An edge within a millisecond of a frame is on it, as on the timeline. Times are written to six decimals,
 * so a start written as 0.666667 is a hair after its own frame at 20/30 s, and an end written as 0.5 is on
 * the first frame past it. Testing a millisecond early puts both frames on the right side. */
export const FRAME_SLACK = 0.001;

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
  // Crops that add up to the whole frame or more leave the 1 percent the render draws (`transformChain`), not less.
  const croppedWidth = Math.max(0.01, 1 - (t?.cropLeft ?? 0) - (t?.cropRight ?? 0));
  const croppedHeight = Math.max(0.01, 1 - (t?.cropTop ?? 0) - (t?.cropBottom ?? 0));
  return Math.ceil(Math.min(height / croppedHeight, width * asset.height / (asset.width * croppedWidth)) * (t?.scale ?? 1));
}

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
  return isMovingAsset(asset) && ((clip.speed ?? 1) !== 1 || (asset.fps !== undefined && asset.fps !== fps));
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
export function signed(n: number, unit = ""): string {
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

export interface AnimatedTransform {
  base: Transform;
  /** Expressions in `__T__` (clip-local seconds) or null when static. */
  x: string | null;
  y: string | null;
  scale: string | null;
}

export function resolveTransform(
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
export function transformChain(tf: AnimatedTransform, W: number, H: number): string[] {
  const { base } = tf;
  const chain: string[] = [];
  if (base.cropLeft || base.cropRight || base.cropTop || base.cropBottom) {
    const w = Math.max(0.01, 1 - base.cropLeft - base.cropRight);
    const h = Math.max(0.01, 1 - base.cropTop - base.cropBottom);
    chain.push(
      `crop=w='trunc(iw*${fnum(w)})':h='trunc(ih*${fnum(h)})':x='trunc(iw*${fnum(base.cropLeft)})':y='trunc(ih*${fnum(base.cropTop)})'`,
    );
  }
  // Contain-fit uses the displayed width (iw*sar) so non-square pixels keep their true shape.
  const fit = `min(${W}/(iw*sar),${H}/ih)`;
  // In scale expressions `t` is the input frame's timestamp (clip-local after setpts).
  const s = tf.scale ? `(${tf.scale.replaceAll(T, "t")})` : fnum(base.scale);
  const eval_ = tf.scale ? ":eval=frame" : "";
  chain.push(
    `scale=w='max(2,trunc(iw*sar*${fit}*${s}/2+1e-9)*2)':h='max(2,trunc(ih*${fit}*${s}/2+1e-9)*2)'${eval_}:flags=bicubic`,
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
export function overlayPosition(tf: AnimatedTransform, localT: string): { x: string; y: string } {
  const x = tf.x ? `(W-w)/2+(${tf.x.replaceAll(T, localT)})*W` : `(W-w)/2${signed(tf.base.x, "*W")}`;
  const y = tf.y ? `(H-h)/2+(${tf.y.replaceAll(T, localT)})*H` : `(H-h)/2${signed(tf.base.y, "*H")}`;
  return { x, y };
}
