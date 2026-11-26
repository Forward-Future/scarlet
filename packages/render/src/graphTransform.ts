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
import { even, ffmpegFilters, fnum } from "./exec.js";
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
  /** Maximum scale reached across base and all keyframes. */
  maxScale: number;
  /** Every resolved keyframe (or base) pose, for canvas-coverage checks. */
  poses: Array<{ x: number; y: number; scale: number }>;
}

export function resolveTransform(
  clip: { transform?: Transform; keyframes?: TransformKeyframe[]; id: string },
  warn: (m: string) => void,
): AnimatedTransform {
  const base = TransformSchema.parse(clip.transform ?? {});
  const kfs = (clip.keyframes ?? []).slice().sort((a, b) => a.time - b.time);
  const out: AnimatedTransform = {
    base,
    x: null,
    y: null,
    scale: null,
    maxScale: base.scale,
    poses: [{ x: base.x, y: base.y, scale: base.scale }],
  };
  if (!kfs.length) return out;
  if (kfs.some((k) => ["rotation", "cropLeft", "cropRight", "cropTop", "cropBottom"].some((p) => p in k.transform))) {
    warn(`clip ${clip.id}: keyframed rotation/crop are not supported; base values used`);
  }
  out.poses = kfs.map((k) => ({
    x: k.transform.x ?? base.x,
    y: k.transform.y ?? base.y,
    scale: k.transform.scale ?? base.scale,
  }));
  out.maxScale = out.poses.reduce((hi, p) => Math.max(hi, p.scale), 0) || base.scale;
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

/** True when x, y or scale actually moves across the clip's keyframes. */
export function isAnimatedTransform(tf: AnimatedTransform): boolean {
  return tf.x !== null || tf.y !== null || tf.scale !== null;
}

/** Whether a clip has an animated transform (used by both graph building and segment keying). */
export function hasAnimatedTransform(clip: { transform?: Transform; keyframes?: TransformKeyframe[] }): boolean {
  if (!clip.keyframes?.length) return false;
  return isAnimatedTransform(resolveTransform({ id: "", transform: clip.transform, keyframes: clip.keyframes }, () => {}));
}

/** Whether this ffmpeg build has the `perspective` filter used for subpixel-smooth animated transforms. */
export async function canPerspective(ffmpegPath?: string): Promise<boolean> {
  try {
    const filters = await ffmpegFilters(ffmpegPath);
    return filters.size === 0 || filters.has("perspective");
  } catch { return true; }
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a)), y = Math.abs(Math.round(b));
  while (y !== 0) { const r = x % y; x = y; y = r; }
  return x || 1;
}

/**
 * Pick an aspect-exact working canvas `(width, height)` for subpixel `perspective` zooms:
 * - Preserves source detail up to `min(maxScale, sourceHeadroom, 2)` without exceeding 4K (unless canvas > 4K).
 * - When `maxScale <= 1`, keeps the exact canvas size and pre-scales down cleanly (`sRel`) to avoid aliasing.
 */
export function smoothWorkingSize(
  W: number,
  H: number,
  maxScale: number,
  croppedSource?: { width: number; height: number },
): { width: number; height: number; sRel: number } {
  if (maxScale <= 1) {
    const sRel = maxScale * Math.min(W, H) < 64 ? 1 : Math.max(0.25, maxScale);
    return { width: W, height: H, sRel };
  }
  const headroom = croppedSource ? Math.max(croppedSource.width / W, croppedSource.height / H) : 1;
  const dimCap = Math.max(W, H, 3840) / Math.max(W, H);
  const m = Math.max(1, Math.min(maxScale, headroom, 2, dimCap));
  if (m <= 1.01) return { width: W, height: H, sRel: 1 };
  const g = gcd(W, H);
  const uw = W / g, uh = H / g;
  const parity = (uw % 2 === 0 && uh % 2 === 0) ? 1 : 2;
  const stepW = uw * parity, stepH = uh * parity;
  if (stepW <= W / 2) {
    const k = Math.max(1, Math.ceil((W * m) / stepW));
    const wp = k * stepW, hp = k * stepH;
    if (Math.max(wp, hp) <= Math.max(W, H, 3840) + stepW) return { width: wp, height: hp, sRel: 1 };
  }
  return m >= 1.5 && Math.max(W * 2, H * 2) <= Math.max(W, H, 3840)
    ? { width: even(W * 2), height: even(H * 2), sRel: 1 }
    : { width: W, height: H, sRel: 1 };
}

function roundedCornersFilter(cornerRadius: number): string {
  // Only pixels in the four corner squares need the distance to the arc.
  // Fade the source alpha across one displayed pixel at its boundary.
  const radius = `min(W,H)*${fnum(cornerRadius)}`;
  const edgeX = "min(X+0.5,W-X-0.5)", edgeY = "min(Y+0.5,H-Y-0.5)";
  const arc = `clip(${radius}+0.5-hypot(${radius}-${edgeX},${radius}-${edgeY}),0,1)`;
  const coverage = `if(lt(max(${edgeX},${edgeY}),${radius}),${arc},1)`;
  return `geq=lum='p(X,Y)':a='alpha(X,Y)*${coverage}':i=nearest`;
}

export interface SmoothTransformContext {
  fps: number;
  /** Clip-local time in seconds at `perspective`'s first frame (`on = 1`). */
  startTime: number;
  source?: { width?: number; height?: number; hasAlpha?: boolean };
}

export interface SmoothTransformStages {
  /** Static per-image preparation (crop, pre-scale, optional corner radius & transparent pad). For stills, runs once before looping. */
  prepare: string[];
  /** Per-frame subpixel transform (`perspective`, optional crop/post-scale/unpremultiply, `format=yuva420p`). */
  animate: string[];
}

/**
 * Subpixel-accurate animated transform pipeline using FFmpeg's `perspective` filter with cubic interpolation.
 * Replaces integer-quantized `scale:eval=frame` + integer `overlay` positioning so slow zooms and pans never
 * stair-step or wobble, while keeping exact Scarlet contain-fit / normalized-offset / rotation / cornerRadius geometry.
 *
 * Output is always a full canvas-sized (`W x H`) `yuva420p` layer ready to overlay at `(0, 0)`.
 */
export function smoothTransformStages(
  tf: AnimatedTransform,
  W: number,
  H: number,
  ctx: SmoothTransformContext,
): SmoothTransformStages {
  const { base } = tf;
  const prepare: string[] = [];
  const cropW = Math.max(0.01, 1 - base.cropLeft - base.cropRight);
  const cropH = Math.max(0.01, 1 - base.cropTop - base.cropBottom);
  const hasCrop = !!(base.cropLeft || base.cropRight || base.cropTop || base.cropBottom);
  if (hasCrop) {
    prepare.push(
      `crop=w='trunc(iw*${fnum(cropW)})':h='trunc(ih*${fnum(cropH)})':x='trunc(iw*${fnum(base.cropLeft)})':y='trunc(ih*${fnum(base.cropTop)})'`,
    );
  }
  const croppedSource = ctx.source?.width && ctx.source?.height
    ? {
      width: Math.max(1, Math.trunc(ctx.source.width * (hasCrop ? cropW : 1))),
      height: Math.max(1, Math.trunc(ctx.source.height * (hasCrop ? cropH : 1))),
    }
    : undefined;
  const { width: Wp, height: Hp, sRel } = smoothWorkingSize(W, H, tf.maxScale, croppedSource);

  // Stay on the fast unpadded `yuva420p` path when the opaque fitted image fills the entire working canvas
  // at every keyframe pose (typical 16:9 B-roll zoom or full-screen recording zoom): zero RGB round-trip
  // and zero edge clamping against transparent padding.
  let opaqueFullCanvas = false;
  if (
    ctx.source?.hasAlpha === false &&
    !base.cornerRadius &&
    !base.rotation &&
    sRel === 1 &&
    croppedSource
  ) {
    const fitP = Math.min(Wp / croppedSource.width, Hp / croppedSource.height);
    const fittedW = Math.max(2, Math.trunc(croppedSource.width * fitP / 2) * 2);
    const fittedH = Math.max(2, Math.trunc(croppedSource.height * fitP / 2) * 2);
    if (fittedW === Wp && fittedH === Hp) {
      const fwFrac = (croppedSource.width * fitP) / Wp;
      const fhFrac = (croppedSource.height * fitP) / Hp;
      opaqueFullCanvas = tf.poses.every(
        (pose) =>
          0.5 * fwFrac * pose.scale - Math.abs(pose.x) >= 0.5 - 1e-6 &&
          0.5 * fhFrac * pose.scale - Math.abs(pose.y) >= 0.5 - 1e-6,
      );
    }
  }

  const fit = `min(${Wp}/iw,${Hp}/ih)`;
  const sRelStr = sRel === 1 ? "" : `*${fnum(sRel)}`;
  prepare.push(
    `scale=w='max(2,trunc(iw*${fit}${sRelStr}/2)*2)':h='max(2,trunc(ih*${fit}${sRelStr}/2)*2)':flags=bicubic`,
  );

  const B = opaqueFullCanvas ? 0 : 2;
  const PW = Wp + 2 * B;
  const PH = Hp + 2 * B;
  if (opaqueFullCanvas) {
    prepare.push("format=yuva420p");
  } else {
    if (base.cornerRadius) {
      prepare.push("format=yuva420p", roundedCornersFilter(base.cornerRadius));
    }
    // Pad with a 2px transparent border in planar RGB+A and premultiply so out-of-bounds pixels stay
    // transparent and subpixel cubic edges composite without dark halos.
    prepare.push(
      "format=gbrap",
      `pad=w=${PW}:h=${PH}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0`,
      "premultiply=inplace=1",
    );
  }

  // `perspective` exposes 1-based output frame count `on` (no `t`), so map `(on-1)/fps` to clip-local time.
  const tExpr = ctx.startTime === 0
    ? `((on-1)/${fnum(ctx.fps)})`
    : `(${fnum(ctx.startTime)}+(on-1)/${fnum(ctx.fps)})`;
  const sExpr = tf.scale
    ? `max(0.001,${tf.scale.replaceAll(T, tExpr)})`
    : fnum(Math.max(0.001, base.scale));
  const txExpr = tf.x ? `(${tf.x.replaceAll(T, tExpr)})` : null;
  const tyExpr = tf.y ? `(${tf.y.replaceAll(T, tExpr)})` : null;
  const halfW = PW / 2, halfH = PH / 2;
  const pxL = txExpr ? `(-${fnum(halfW)}-(${txExpr})*${Wp})` : fnum(-halfW - base.x * Wp);
  const pxR = txExpr ? `(${fnum(halfW)}-(${txExpr})*${Wp})` : fnum(halfW - base.x * Wp);
  const pyT = tyExpr ? `(-${fnum(halfH)}-(${tyExpr})*${Hp})` : fnum(-halfH - base.y * Hp);
  const pyB = tyExpr ? `(${fnum(halfH)}-(${tyExpr})*${Hp})` : fnum(halfH - base.y * Hp);
  const sMul = sRel === 1 ? "" : `*${fnum(sRel)}`;

  const corner = (px: string, py: string): [string, string] => {
    let rx = px, ry = py;
    if (base.rotation) {
      const a = (base.rotation * Math.PI) / 180;
      const c = fnum(Math.cos(a), 8), s = fnum(Math.sin(a), 8);
      rx = `((${px})*${c}+(${py})*${s})`;
      ry = `(-(${px})*${s}+(${py})*${c})`;
    }
    return [
      `${fnum(halfW)}+(${rx})${sMul}/(${sExpr})`,
      `${fnum(halfH)}+(${ry})${sMul}/(${sExpr})`,
    ];
  };
  const [x0, y0] = corner(pxL, pyT);
  const [x1, y1] = corner(pxR, pyT);
  const [x2, y2] = corner(pxL, pyB);
  const [x3, y3] = corner(pxR, pyB);

  const animate: string[] = [
    `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y1}':x2='${x2}':y2='${y2}':x3='${x3}':y3='${y3}':interpolation=cubic:sense=source:eval=frame`,
  ];
  if (B > 0) animate.push(`crop=${Wp}:${Hp}:${B}:${B}`);
  if (Wp !== W || Hp !== H) animate.push(`scale=${W}:${H}:flags=bicubic`);
  if (!opaqueFullCanvas) animate.push("unpremultiply=inplace=1", "format=yuva420p");
  return { prepare, animate };
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
  const fit = `min(${W}/iw,${H}/ih)`;
  // In scale expressions `t` is the input frame's timestamp (clip-local after setpts).
  const s = tf.scale ? `(${tf.scale.replaceAll(T, "t")})` : fnum(base.scale);
  const eval_ = tf.scale ? ":eval=frame" : "";
  chain.push(
    `scale=w='max(2,trunc(iw*${fit}*${s}/2)*2)':h='max(2,trunc(ih*${fit}*${s}/2)*2)'${eval_}:flags=bicubic`,
  );
  chain.push("format=yuva420p");
  if (base.cornerRadius) chain.push(roundedCornersFilter(base.cornerRadius));
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
