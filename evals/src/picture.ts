/**
 * Where a recording's picture sits inside a finished frame: how large, where, and which part of it shows.
 *
 * Both pictures are small grayscale images of the same moment. The recording is tried at many sizes and places, and
 * the one whose pixels follow the frame's most closely wins (zero-mean normalized correlation, so a grade or an
 * exposure change doesn't matter). Blocks of the frame that agree with the placed recording then say which part of
 * it is on screen: an inset is cropped, a zoom shows a corner, a card is covered by the presenter. Pure functions:
 * the caller decodes the frames.
 */

export interface Gray { width: number; height: number; data: Float32Array }
/** Fractions of the frame (or of the recording's picture): 0,0 is the top left. */
export interface Rect { x: number; y: number; w: number; h: number }

export interface Placement {
  /** Size of the recording's picture in the frame: 1 fills it edge to edge, as a clip's `scale` does. */
  scale: number;
  /** Where the recording's centre sits, as offsets from the frame's centre in fractions of its width and height (a clip's `x` and `y`). */
  x: number;
  y: number;
  /** The part of the frame that shows the recording. */
  rect: Rect;
  /** The part of the recording's picture that shows there. */
  shown: Rect;
  /** How closely the pixels in `rect` follow the recording's, -1 to 1. */
  score: number;
}

export interface LocateOptions {
  minScale: number;
  maxScale: number;
  /** A placement scoring under this is not the recording. */
  minScore: number;
  /** The recording must show in at least this share of the frame. */
  minArea: number;
  /** Parts of the frame already known to show something else. */
  ignore?: Rect[];
}
export const DEFAULT_LOCATE: LocateOptions = { minScale: 0.14, maxScale: 3.6, minScore: 0.55, minArea: 0.05 };

/** Average blocks of `factor` pixels. */
export function shrink(image: Gray, factor: number): Gray {
  const width = Math.floor(image.width / factor), height = Math.floor(image.height / factor);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += image.data[(y * factor + dy) * image.width + x * factor + dx]!;
    data[y * width + x] = sum / (factor * factor);
  }
  return { width, height, data };
}

/** Resample to any size, averaging the source pixels under each new one. */
export function resize(image: Gray, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  const sx = image.width / width, sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy, y1 = Math.min(image.height, (y + 1) * sy);
    for (let x = 0; x < width; x++) {
      const x0 = x * sx, x1 = Math.min(image.width, (x + 1) * sx);
      let sum = 0, weight = 0;
      for (let v = Math.floor(y0); v < y1; v++) {
        const wy = Math.min(v + 1, y1) - Math.max(v, y0);
        for (let u = Math.floor(x0); u < x1; u++) {
          const w = wy * (Math.min(u + 1, x1) - Math.max(u, x0));
          sum += w * image.data[v * image.width + u]!;
          weight += w;
        }
      }
      data[y * width + x] = weight ? sum / weight : 0;
    }
  }
  return { width, height, data };
}

/**
 * Correlation of the frame with a template whose top left is at (tx, ty), over the pixels they share, reading every
 * `step`th pixel. Flat areas correlate with anything, so a region with next to no detail on either side scores 0.
 */
function correlate(frame: Gray, template: Gray, tx: number, ty: number, step: number, masked?: Uint8Array): number {
  const x0 = Math.max(0, tx), y0 = Math.max(0, ty), x1 = Math.min(frame.width, tx + template.width), y1 = Math.min(frame.height, ty + template.height);
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y += step) {
    const fr = y * frame.width, tr = (y - ty) * template.width - tx;
    for (let x = x0; x < x1; x += step) {
      if (masked && masked[fr + x]) continue;
      const a = frame.data[fr + x]!, b = template.data[tr + x]!;
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
  }
  if (n < 24) return 0;
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va < n * 9 || vb < n * 9) return 0;
  return (sab - sa * sb / n) / Math.sqrt(va * vb);
}

interface Candidate { scale: number; tx: number; ty: number; score: number }

function maskOf(frame: Gray, ignore: Rect[] | undefined): Uint8Array | undefined {
  if (!ignore?.length) return undefined;
  const masked = new Uint8Array(frame.width * frame.height);
  for (const r of ignore) {
    const x0 = Math.max(0, Math.floor(r.x * frame.width)), x1 = Math.min(frame.width, Math.ceil((r.x + r.w) * frame.width));
    const y0 = Math.max(0, Math.floor(r.y * frame.height)), y1 = Math.min(frame.height, Math.ceil((r.y + r.h) * frame.height));
    for (let y = y0; y < y1; y++) masked.fill(1, y * frame.width + x0, y * frame.width + x1);
  }
  return masked;
}

/** The best placements of `source` in `frame` at one size of both, tried at every scale and position. */
function search(frame: Gray, source: Gray, opts: LocateOptions, masked: Uint8Array | undefined, keep: number): Candidate[] {
  const found: Candidate[] = [];
  for (let scale = opts.minScale; scale <= opts.maxScale * 1.0001; scale *= 1.07) {
    const w = Math.round(frame.width * scale), h = Math.round(frame.height * scale);
    if (w < 8 || h < 5) continue;
    const template = resize(source, w, h);
    // At least this much of the smaller of the two must overlap, so a sliver at the frame's edge can't win.
    const need = 0.55 * Math.min(w, frame.width) * Math.min(h, frame.height);
    const stride = w > 56 ? 2 : 1, step = w * h > 2400 ? 2 : 1;
    let best: Candidate | undefined;
    for (let ty = -h + 4; ty < frame.height - 4; ty += stride) {
      const oh = Math.min(frame.height, ty + h) - Math.max(0, ty);
      for (let tx = -w + 4; tx < frame.width - 4; tx += stride) {
        const ow = Math.min(frame.width, tx + w) - Math.max(0, tx);
        if (ow * oh < need) continue;
        const score = correlate(frame, template, tx, ty, step, masked);
        if (!best || score > best.score) best = { scale, tx, ty, score };
      }
    }
    if (best) found.push(best);
  }
  return found.sort((a, b) => b.score - a.score).slice(0, keep);
}

/** Climb from a placement to the best one near it, at this size of frame. */
function refine(frame: Gray, source: Gray, from: Candidate, masked: Uint8Array | undefined): Candidate {
  let best = from;
  const templates = new Map<string, Gray>();
  const at = (scale: number, tx: number, ty: number): Candidate => {
    const w = Math.max(8, Math.round(frame.width * scale)), h = Math.max(5, Math.round(frame.height * scale));
    const key = `${w}x${h}`;
    let template = templates.get(key);
    if (!template) { template = resize(source, w, h); templates.set(key, template); }
    return { scale, tx, ty, score: correlate(frame, template, tx, ty, w * h > 20000 ? 2 : 1, masked) };
  };
  best = at(best.scale, best.tx, best.ty);
  for (let round = 0; round < 12; round++) {
    let moved = false;
    for (const ds of [1, 1.015, 1 / 1.015, 1.04, 1 / 1.04]) {
      const scale = best.scale * ds;
      // Scaling about the template's centre keeps what is under it in place.
      const cx = best.tx + frame.width * best.scale / 2, cy = best.ty + frame.height * best.scale / 2;
      const bx = Math.round(cx - frame.width * scale / 2), by = Math.round(cy - frame.height * scale / 2);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (ds === 1 && !dx && !dy) continue;
        const next = at(scale, bx + dx, by + dy);
        if (next.score > best.score + 1e-4) { best = next; moved = true; }
      }
    }
    if (!moved) break;
  }
  return best;
}

const BLOCK = 8;

/**
 * The part of the frame that shows the placed recording: the largest patch of blocks whose pixels follow it, and how
 * closely that patch does overall.
 */
function visible(frame: Gray, source: Gray, c: Candidate, masked: Uint8Array | undefined): { rect: Rect; score: number } | undefined {
  const w = Math.round(frame.width * c.scale), h = Math.round(frame.height * c.scale);
  const template = resize(source, w, h);
  const cols = Math.floor(frame.width / BLOCK), rows = Math.floor(frame.height / BLOCK);
  const agree = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const x0 = q * BLOCK, y0 = r * BLOCK;
    if (x0 < c.tx || y0 < c.ty || x0 + BLOCK > c.tx + w || y0 + BLOCK > c.ty + h) continue;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, skipped = 0;
    for (let y = y0; y < y0 + BLOCK; y++) for (let x = x0; x < x0 + BLOCK; x++) {
      if (masked?.[y * frame.width + x]) { skipped++; continue; }
      const a = frame.data[y * frame.width + x]!, b = template.data[(y - c.ty) * w + x - c.tx]!;
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (skipped > n) continue;
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    // A flat block agrees when both sides are flat and about as bright; a detailed one when the detail lines up.
    const flat = va < n * 16 && vb < n * 16;
    agree[r * cols + q] = flat ? (Math.abs(sa - sb) / n < 28 ? 1 : 0) : (va > 0 && vb > 0 && (sab - sa * sb / n) / Math.sqrt(va * vb) > 0.5 ? 2 : 0);
  }
  // The largest connected patch that has real detail in it. Flat blocks join a patch but can't make one alone.
  const seen = new Uint8Array(cols * rows);
  let bestBox: [number, number, number, number] | undefined, bestDetail = 0;
  for (let start = 0; start < agree.length; start++) {
    if (!agree[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let q0 = cols, q1 = -1, r0 = rows, r1 = -1, detail = 0;
    while (stack.length) {
      const i = stack.pop()!, q = i % cols, r = (i - q) / cols;
      if (agree[i] === 2) { detail++; q0 = Math.min(q0, q); q1 = Math.max(q1, q); r0 = Math.min(r0, r); r1 = Math.max(r1, r); }
      for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nq = q + dq, nr = r + dr, j = nr * cols + nq;
        if (nq < 0 || nr < 0 || nq >= cols || nr >= rows || !agree[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (detail > bestDetail) { bestDetail = detail; bestBox = [q0, r0, q1, r1]; }
  }
  if (!bestBox || bestDetail < 3) return undefined;
  const [q0, r0, q1, r1] = bestBox;
  const x0 = q0 * BLOCK, y0 = r0 * BLOCK, x1 = (q1 + 1) * BLOCK, y1 = (r1 + 1) * BLOCK;
  // Score the patch alone: what lies outside it is another picture.
  const patch: Gray = { width: x1 - x0, height: y1 - y0, data: new Float32Array((x1 - x0) * (y1 - y0)) };
  const part: Gray = { width: patch.width, height: patch.height, data: new Float32Array(patch.data.length) };
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    patch.data[(y - y0) * patch.width + x - x0] = frame.data[y * frame.width + x]!;
    part.data[(y - y0) * patch.width + x - x0] = template.data[(y - c.ty) * w + x - c.tx]!;
  }
  return { rect: { x: x0 / frame.width, y: y0 / frame.height, w: (x1 - x0) / frame.width, h: (y1 - y0) / frame.height }, score: correlate(patch, part, 0, 0, 1) };
}

/**
 * Find `source` in `frame`. Both are the same moment at the same size (320 by 180 works well), the source as it
 * would fill the frame at scale 1. Returns nothing when the frame doesn't show it.
 */
export function locate(frame: Gray, source: Gray, options: Partial<LocateOptions> = {}): Placement | undefined {
  const opts = { ...DEFAULT_LOCATE, ...options };
  if (frame.width !== source.width || frame.height !== source.height) throw new Error("Give the frame and the recording's picture at the same size.");
  const factor = Math.max(1, Math.round(frame.width / 80));
  const small = shrink(frame, factor), smallSource = shrink(source, factor);
  const smallMask = maskOf(small, opts.ignore), mask = maskOf(frame, opts.ignore);
  // An inset is often cropped, and its middle still shows: the recording's central part is tried as well as the whole.
  const crop = 0.5;
  const centre: Gray = { width: Math.round(smallSource.width * crop), height: Math.round(smallSource.height * crop), data: new Float32Array(0) };
  centre.data = new Float32Array(centre.width * centre.height);
  const ox = Math.round((smallSource.width - centre.width) / 2), oy = Math.round((smallSource.height - centre.height) / 2);
  for (let y = 0; y < centre.height; y++) for (let x = 0; x < centre.width; x++) centre.data[y * centre.width + x] = smallSource.data[(y + oy) * smallSource.width + x + ox]!;
  const candidates = search(small, smallSource, opts, smallMask, 4);
  // The central part at scale s is the whole at scale s / crop, shifted to share its centre.
  for (const c of searchPart(small, centre, opts, smallMask, 4)) {
    const scale = c.scale;
    candidates.push({ scale, tx: Math.round(c.tx - ox * scale), ty: Math.round(c.ty - oy * scale), score: c.score });
  }
  let best: Placement | undefined;
  for (const c of candidates) {
    if (c.score < 0.25) continue;
    const fine = refine(frame, source, { scale: c.scale, tx: c.tx * factor, ty: c.ty * factor, score: c.score }, mask);
    const seen = visible(frame, source, fine, mask);
    // A sliver that happens to line up, such as one edge of a window, is not the picture.
    if (!seen || seen.score < opts.minScore || seen.rect.w < 0.12 || seen.rect.h < 0.12) continue;
    // A small patch can line up by chance, so it has to follow the recording closely to count.
    const size = seen.rect.w * seen.rect.h;
    if (size < opts.minArea || (size < 0.12 && seen.score < 0.75)) continue;
    if (best && best.score * Math.sqrt(best.rect.w * best.rect.h) >= seen.score * Math.sqrt(seen.rect.w * seen.rect.h)) continue;
    const w = frame.width * fine.scale, h = frame.height * fine.scale;
    best = {
      scale: round(fine.scale), x: round((fine.tx + w / 2) / frame.width - 0.5), y: round((fine.ty + h / 2) / frame.height - 0.5),
      rect: { x: round(seen.rect.x), y: round(seen.rect.y), w: round(seen.rect.w), h: round(seen.rect.h) },
      shown: { x: round((seen.rect.x * frame.width - fine.tx) / w), y: round((seen.rect.y * frame.height - fine.ty) / h),
        w: round(seen.rect.w * frame.width / w), h: round(seen.rect.h * frame.height / h) },
      score: round(seen.score),
    };
  }
  return best;
}

/** Like `search`, for a part of the recording: the template is the part drawn at the recording's scale. */
function searchPart(frame: Gray, part: Gray, opts: LocateOptions, masked: Uint8Array | undefined, keep: number): Candidate[] {
  const found: Candidate[] = [];
  for (let scale = opts.minScale; scale <= Math.min(opts.maxScale, 1.3) * 1.0001; scale *= 1.07) {
    const w = Math.round(part.width * scale), h = Math.round(part.height * scale);
    if (w < 8 || h < 5) continue;
    const template = resize(part, w, h);
    const step = w * h > 2400 ? 2 : 1;
    let best: Candidate | undefined;
    // The part lies wholly inside the frame.
    for (let ty = 0; ty + h <= frame.height; ty++) for (let tx = 0; tx + w <= frame.width; tx++) {
      const score = correlate(frame, template, tx, ty, step, masked);
      if (!best || score > best.score) best = { scale, tx, ty, score };
    }
    if (best) found.push(best);
  }
  return found.sort((a, b) => b.score - a.score).slice(0, keep);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function intersection(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}
/** Shared area over combined area: 1 for the same rectangle, 0 for two that don't touch. */
export function iou(a: Rect, b: Rect): number {
  const shared = intersection(a, b), all = a.w * a.h + b.w * b.h - shared;
  return all > 0 ? shared / all : 0;
}

// ---------------------------------------------------------------------------
// Layouts: what a moment shows, and how two cuts of the same moment compare
// ---------------------------------------------------------------------------

/** A clip's transform, as far as the picture's place goes (packages/timeline Transform). */
export interface LayerTransform { x?: number; y?: number; scale?: number; cropLeft?: number; cropRight?: number; cropTop?: number; cropBottom?: number }

/**
 * Where a timeline layer draws, as `locate` would report it from the rendered frame. The cropped picture is fitted
 * to the canvas and then scaled, so `scale` here is the whole recording's, as if it had not been cropped. Assumes
 * the recording and the canvas have the same shape.
 */
export function layerPlacement(t: LayerTransform = {}): Placement | undefined {
  const crop = { x: t.cropLeft ?? 0, y: t.cropTop ?? 0, w: Math.max(0.01, 1 - (t.cropLeft ?? 0) - (t.cropRight ?? 0)), h: Math.max(0.01, 1 - (t.cropTop ?? 0) - (t.cropBottom ?? 0)) };
  const whole = (t.scale ?? 1) * Math.min(1 / crop.w, 1 / crop.h);
  const drawn = { w: crop.w * whole, h: crop.h * whole, x: 0.5 + (t.x ?? 0) - crop.w * whole / 2, y: 0.5 + (t.y ?? 0) - crop.h * whole / 2 };
  const x0 = Math.max(0, drawn.x), y0 = Math.max(0, drawn.y), x1 = Math.min(1, drawn.x + drawn.w), y1 = Math.min(1, drawn.y + drawn.h);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return {
    scale: round(whole),
    // The whole recording's centre: the crop's centre, moved back by how far the crop sits off the middle.
    x: round((t.x ?? 0) - (crop.x + crop.w / 2 - 0.5) * whole), y: round((t.y ?? 0) - (crop.y + crop.h / 2 - 0.5) * whole),
    rect: { x: round(x0), y: round(y0), w: round(x1 - x0), h: round(y1 - y0) },
    shown: { x: round(crop.x + (x0 - drawn.x) / whole), y: round(crop.y + (y0 - drawn.y) / whole), w: round((x1 - x0) / whole), h: round((y1 - y0) / whole) },
    score: 1,
  };
}

/** One moment of a cut: the presenter's recording second, and where each recording's picture sits in the frame. */
export interface PictureSample {
  /** Seconds on the cut's own clock. */
  t: number;
  /** The presenter's recording and the second of it that plays. */
  mediaId: string;
  source: number;
  layers: Record<string, Placement>;
}

/** camera: the presenter fills the frame. inset: the presenter sits over something else. screen: no presenter. other: neither recording shows. */
export type Layout = "camera" | "inset" | "screen" | "other";

const area = (r: Rect) => r.w * r.h;
/** The picture under or instead of the presenter: the largest other layer. */
export function mainLayer(sample: PictureSample): Placement | undefined {
  return Object.entries(sample.layers).filter(([id]) => id !== sample.mediaId).map(([, p]) => p).sort((a, b) => area(b.rect) - area(a.rect))[0];
}
export function layoutOf(sample: PictureSample): Layout {
  const camera = sample.layers[sample.mediaId], main = mainLayer(sample);
  if (camera && area(camera.rect) >= 0.6) return "camera";
  if (camera) return "inset";
  return main ? "screen" : "other";
}

export interface PictureSummary {
  samples: number;
  /** Share of the samples in each layout. */
  layouts: Record<Layout, number>;
  /** The presenter's inset, where there is one: its middle and size in the frame, and the part of the camera it shows. Medians. */
  inset: null | { x: number; y: number; width: number; height: number; shown: Rect };
  /** How far the camera is punched in when it fills the frame. */
  cameraScale: number | null;
  /** How large the picture under the presenter is drawn (1 fits it to the frame), and how much of its width shows. */
  mainScale: { median: number; p10: number; p90: number } | null;
  mainShownWidth: number | null;
  /** Times the layout changes, and times the main picture's framing moves, per minute. */
  layoutChangesPerMinute: number;
  framingChangesPerMinute: number;
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};
const med = (values: number[]) => quantile(values, 0.5);

/** The same framing drawn again reads a little differently: these are apart only when the shown part really moved. */
const sameFraming = (a: Placement, b: Placement) => iou(a.shown, b.shown) >= 0.7;

export function summarizePicture(samples: readonly PictureSample[]): PictureSummary {
  const layouts: Record<Layout, number> = { camera: 0, inset: 0, screen: 0, other: 0 };
  const insets: Placement[] = [], full: number[] = [], mains: Placement[] = [];
  let layoutChanges = 0, framingChanges = 0;
  samples.forEach((s, i) => {
    const layout = layoutOf(s), camera = s.layers[s.mediaId], main = mainLayer(s);
    layouts[layout]++;
    if (layout === "inset") insets.push(camera!);
    if (layout === "camera") full.push(camera!.scale);
    if (layout !== "camera" && main) mains.push(main);
    const prev = samples[i - 1];
    if (!prev) return;
    if (layoutOf(prev) !== layout) layoutChanges++;
    const before = mainLayer(prev);
    if (main && before && layout !== "camera" && layoutOf(prev) !== "camera" && !sameFraming(before, main)) framingChanges++;
  });
  const n = samples.length || 1;
  const minutes = samples.length > 1 ? (samples.at(-1)!.t - samples[0]!.t) / 60 : 0;
  const r = (v: number | null) => v === null ? 0 : round(v);
  return {
    samples: samples.length,
    layouts: { camera: round(layouts.camera / n), inset: round(layouts.inset / n), screen: round(layouts.screen / n), other: round(layouts.other / n) },
    inset: insets.length ? { x: r(med(insets.map(p => p.rect.x + p.rect.w / 2))), y: r(med(insets.map(p => p.rect.y + p.rect.h / 2))),
      width: r(med(insets.map(p => p.rect.w))), height: r(med(insets.map(p => p.rect.h))),
      shown: { x: r(med(insets.map(p => p.shown.x))), y: r(med(insets.map(p => p.shown.y))), w: r(med(insets.map(p => p.shown.w))), h: r(med(insets.map(p => p.shown.h))) } } : null,
    cameraScale: full.length ? r(med(full)) : null,
    mainScale: mains.length ? { median: r(med(mains.map(p => p.scale))), p10: r(quantile(mains.map(p => p.scale), 0.1)), p90: r(quantile(mains.map(p => p.scale), 0.9)) } : null,
    mainShownWidth: mains.length ? r(med(mains.map(p => p.shown.w))) : null,
    layoutChangesPerMinute: minutes ? round(layoutChanges / minutes) : 0,
    framingChangesPerMinute: minutes ? round(framingChanges / minutes) : 0,
  };
}

export interface PictureComparison {
  /** Reference moments the candidate also plays, where the reference shows a recording. */
  compared: number;
  /** Share of them with the same layout. */
  layoutAgreement: number | null;
  /** Reference layout, then candidate layout: how many moments. */
  confusion: Record<string, number>;
  /** Where both have an inset: how far apart the two insets' middles are (fractions of the frame), the candidate's width over the reference's, and how much of the camera both show (overlap over union). */
  inset: null | { moments: number; distance: number; widthRatio: number; shownOverlap: number };
  /** Where both show the picture under the presenter: how much of it both show (overlap over union), and the candidate's scale over the reference's. */
  main: null | { moments: number; shownOverlap: number; scaleRatio: number; sameFraming: number };
}

/** Compare two cuts moment by moment. `candidateAt` gives the candidate's picture at a reference sample's recording second, if it plays it. */
export function comparePicture(reference: readonly PictureSample[], candidateAt: (sample: PictureSample) => PictureSample | undefined): PictureComparison {
  const confusion: Record<string, number> = {};
  const distance: number[] = [], widthRatio: number[] = [], insetShown: number[] = [], mainShown: number[] = [], scaleRatio: number[] = [];
  let compared = 0, same = 0, framed = 0;
  for (const ref of reference) {
    const want = layoutOf(ref);
    if (want === "other") continue;
    const cand = candidateAt(ref);
    if (!cand) continue;
    const got = layoutOf(cand);
    compared++;
    if (got === want) same++;
    confusion[`${want}→${got}`] = (confusion[`${want}→${got}`] ?? 0) + 1;
    const a = ref.layers[ref.mediaId], b = cand.layers[cand.mediaId];
    if (want === "inset" && got === "inset" && a && b) {
      distance.push(Math.hypot(a.rect.x + a.rect.w / 2 - b.rect.x - b.rect.w / 2, a.rect.y + a.rect.h / 2 - b.rect.y - b.rect.h / 2));
      widthRatio.push(b.rect.w / a.rect.w);
      insetShown.push(iou(a.shown, b.shown));
    }
    const ma = mainLayer(ref), mb = mainLayer(cand);
    if (want !== "camera" && got !== "camera" && ma && mb) {
      mainShown.push(iou(ma.shown, mb.shown));
      scaleRatio.push(mb.scale / ma.scale);
      if (sameFraming(ma, mb)) framed++;
    }
  }
  const r = (v: number | null) => v === null ? 0 : round(v);
  return {
    compared, layoutAgreement: compared ? round(same / compared) : null,
    confusion: Object.fromEntries(Object.entries(confusion).sort((x, y) => y[1] - x[1])),
    inset: distance.length ? { moments: distance.length, distance: r(med(distance)), widthRatio: r(med(widthRatio)), shownOverlap: r(med(insetShown)) } : null,
    main: mainShown.length ? { moments: mainShown.length, shownOverlap: r(med(mainShown)), scaleRatio: r(med(scaleRatio)), sameFraming: round(framed / mainShown.length) } : null,
  };
}
