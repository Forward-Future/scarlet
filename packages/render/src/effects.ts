/**
 * Effect registry: maps `Effect.type` in the cut list to ffmpeg filter
 * strings. Unknown
 * types are skipped with a warning so an agent typo never breaks a render.
 */
import { fileInDirectory } from "./assetPath.js";
import type { Effect } from "@scarlet/timeline";
import { fnum } from "./exec.js";
import { voiceModelFile } from "./voiceModel.js";

export type EffectKind = "video" | "audio";

export interface EffectContext {
  /** Absolute directory relative media/LUT paths resolve against. */
  mediaRoot: string;
  /** Optional extra trusted directories (such as library-wide style guides) where `.cube`/`.3dl` LUTs may live. */
  lutRoots?: readonly string[];
  warn: (message: string) => void;
}

/** Returns one or more filter strings (without labels), or undefined to skip. */
export type EffectBuilder = (params: Record<string, unknown>, ctx: EffectContext) => string | string[] | undefined;

interface Registered {
  kind: EffectKind;
  build: EffectBuilder;
  /** Seconds the filter plays its sound late by. */
  delay?: number;
}

const registry = new Map<string, Registered>();

export function registerEffect(type: string, kind: EffectKind, build: EffectBuilder, delay?: number): void {
  registry.set(type, { kind, build, delay });
}

/**
 * Seconds a clip's enabled audio effects play its sound late by, together. The graph reads that much more footage and
 * drops it from the front, so the sound stays where the picture has it.
 */
export function audioEffectDelay(effects: Effect[] | undefined): number {
  let delay = 0;
  for (const e of effects ?? []) {
    const reg = e.enabled === false ? undefined : registry.get(e.type);
    if (reg?.kind === "audio") delay += reg.delay ?? 0;
  }
  return delay;
}

export function effectKind(type: string): EffectKind | undefined {
  return registry.get(type)?.kind;
}

/** Escape both parsers: filter option values first, then the containing graph. */
export function escapeFilterPath(p: string): string {
  const value = p.replace(/[\\':]/g, "\\$&");
  return value.replace(/[\\'[\],;]/g, "\\$&");
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function pick(params: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const k of keys) if (params[k] !== undefined) return num(params[k], fallback);
  return fallback;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dbToLinear = (db: number) => Math.pow(10, db / 20);

/**
 * Filters for a clip's effects of the given kind, in order. Effects registered
 * for the other kind are silently skipped (a clip lists both audio and video
 * effects); unknown types warn once.
 */
export function effectFilters(effects: Effect[] | undefined, kind: EffectKind, ctx: EffectContext): string[] {
  const out: string[] = [];
  for (const e of effects ?? []) {
    if (e.enabled === false) continue;
    const reg = registry.get(e.type);
    if (!reg) {
      ctx.warn(`unknown effect type "${e.type}" ignored`);
      continue;
    }
    if (reg.kind !== kind) continue;
    const f = reg.build(e.params ?? {}, ctx);
    if (!f) continue;
    out.push(...(Array.isArray(f) ? f : [f]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/** blur { sigma | amount | radius } (pixels, default 5) */
registerEffect("blur", "video", (p) => `gblur=sigma=${fnum(clamp(pick(p, ["sigma", "amount", "radius"], 5), 0.1, 1024))}`);

/** brightness { value | amount } -1..1 (0 = unchanged) */
registerEffect("brightness", "video", (p) => `eq=brightness=${fnum(clamp(pick(p, ["value", "amount"], 0), -1, 1))}`);

/** contrast { value | amount } -1000..1000 (1 = unchanged) */
registerEffect("contrast", "video", (p) => `eq=contrast=${fnum(clamp(pick(p, ["value", "amount"], 1), -1000, 1000))}`);

/** saturation { value | amount } 0..3 (1 = unchanged) */
registerEffect("saturation", "video", (p) => `eq=saturation=${fnum(clamp(pick(p, ["value", "amount"], 1), 0, 3))}`);

const LUT_EXTENSION = /\.(?:cube|3dl)$/i;

/**
 * Safely resolve a LUT file path inside the project's `mediaRoot` or an extra trusted LUT root
 * (such as the library-wide style guides folder). Extra roots only permit `.cube`/`.3dl` files,
 * and `fileInDirectory` enforces realpath containment so symlinks and `..` cannot escape.
 */
export function resolveLutFile(file: string, mediaRoot: string, lutRoots?: readonly string[]): string | undefined {
  const inMedia = fileInDirectory(mediaRoot, file);
  if (inMedia) return inMedia;
  for (const root of lutRoots ?? []) {
    const inRoot = fileInDirectory(root, file);
    if (inRoot && LUT_EXTENSION.test(inRoot)) return inRoot;
  }
  return undefined;
}

function exposureFilter(exposure: number, black = 0): string | undefined {
  const e = clamp(exposure, -3, 3);
  const b = clamp(black, -1, 1);
  if (Math.abs(e) < 1e-4 && Math.abs(b) < 1e-4) return undefined;
  return `exposure=exposure=${fnum(e)}${Math.abs(b) >= 1e-4 ? `:black=${fnum(b)}` : ""}`;
}

function whiteBalanceFilters(warmth: number, tint: number, kelvin?: number): string[] {
  const out: string[] = [];
  if (kelvin !== undefined && Number.isFinite(kelvin)) {
    const k = clamp(kelvin, 1000, 40000);
    if (Math.abs(k - 6500) >= 1) out.push(`colortemperature=temperature=${fnum(k)}:pl=1`);
  }
  const w = clamp(warmth, -1, 1);
  const t = clamp(tint, -1, 1);
  if (Math.abs(w) >= 1e-4 || Math.abs(t) >= 1e-4) {
    // Positive warmth shifts toward amber (+R, -B); positive tint shifts toward magenta (+R, -G, +B).
    const r = clamp(w * 0.28 + t * 0.14, -1, 1);
    const g = clamp(-t * 0.28, -1, 1);
    const b = clamp(-w * 0.28 + t * 0.14, -1, 1);
    const edge = 0.75;
    out.push([
      `colorbalance=rs=${fnum(r * edge)}`,
      `gs=${fnum(g * edge)}`,
      `bs=${fnum(b * edge)}`,
      `rm=${fnum(r)}`,
      `gm=${fnum(g)}`,
      `bm=${fnum(b)}`,
      `rh=${fnum(r * edge)}`,
      `gh=${fnum(g * edge)}`,
      `bh=${fnum(b * edge)}`,
      "pl=true",
    ].join(":"));
  }
  return out;
}

function shadowsHighlightsFilter(shadows: number, highlights: number, blacks = 0, whites = 0): string | undefined {
  const s = clamp(shadows, -1, 1);
  const h = clamp(highlights, -1, 1);
  const bl = clamp(blacks, -1, 1);
  const wh = clamp(whites, -1, 1);
  if (Math.abs(s) < 1e-4 && Math.abs(h) < 1e-4 && Math.abs(bl) < 1e-4 && Math.abs(wh) < 1e-4) return undefined;
  const x0 = bl < 0 ? clamp(-bl * 0.08, 0, 0.12) : 0;
  const y0 = bl > 0 ? clamp(bl * 0.08, 0, 0.12) : 0;
  const x1 = wh > 0 ? clamp(1 - wh * 0.08, 0.88, 1) : 1;
  const y1 = wh < 0 ? clamp(1 + wh * 0.08, 0.88, 1) : 1;
  const y25 = clamp(0.25 + s * 0.14 + bl * 0.04, Math.max(0.03, y0 + 0.02), 0.46);
  const y75 = clamp(0.75 + h * 0.14 + wh * 0.04, 0.54, Math.min(0.97, y1 - 0.02));
  const pts: string[] = [];
  if (x0 > 0) pts.push("0/0");
  pts.push(`${fnum(x0)}/${fnum(y0)}`, `0.25/${fnum(y25)}`, "0.5/0.5", `0.75/${fnum(y75)}`, `${fnum(x1)}/${fnum(y1)}`);
  if (x1 < 1) pts.push("1/1");
  return `curves=m='${pts.join(" ")}':interp=pchip`;
}

function rgbTriple(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  return [clamp(num(v[0], 0), -1, 1), clamp(num(v[1], 0), -1, 1), clamp(num(v[2], 0), -1, 1)];
}

/** exposure { exposure | value | amount (-3..3 stops), black (-1..1) } */
registerEffect("exposure", "video", (p) => exposureFilter(pick(p, ["exposure", "value", "amount"], 0), pick(p, ["black"], 0)));

/** whiteBalance { warmth | temperature (-1..1), tint (-1..1), kelvin (1000..40000, 6500 neutral) } */
registerEffect("whiteBalance", "video", (p) => {
  const filters = whiteBalanceFilters(
    pick(p, ["warmth", "temperature"], 0),
    pick(p, ["tint"], 0),
    p.kelvin !== undefined ? num(p.kelvin, 6500) : undefined,
  );
  return filters.length ? filters : undefined;
});

/** shadowsHighlights { shadows (-1..1), highlights (-1..1), blacks (-1..1), whites (-1..1) } */
registerEffect("shadowsHighlights", "video", (p) =>
  shadowsHighlightsFilter(
    pick(p, ["shadows"], 0),
    pick(p, ["highlights"], 0),
    pick(p, ["blacks"], 0),
    pick(p, ["whites"], 0),
  ),
);

/** colorBalance { rs, gs, bs, rm, gm, bm, rh, gh, bh (-1..1) | shadows/midtones/highlights [r,g,b], preserveLightness } */
registerEffect("colorBalance", "video", (p) => {
  const s = rgbTriple(p.shadows);
  const m = rgbTriple(p.midtones);
  const h = rgbTriple(p.highlights);
  const rs = clamp(s ? s[0] : pick(p, ["rs"], 0), -1, 1);
  const gs = clamp(s ? s[1] : pick(p, ["gs"], 0), -1, 1);
  const bs = clamp(s ? s[2] : pick(p, ["bs"], 0), -1, 1);
  const rm = clamp(m ? m[0] : pick(p, ["rm"], 0), -1, 1);
  const gm = clamp(m ? m[1] : pick(p, ["gm"], 0), -1, 1);
  const bm = clamp(m ? m[2] : pick(p, ["bm"], 0), -1, 1);
  const rh = clamp(h ? h[0] : pick(p, ["rh"], 0), -1, 1);
  const gh = clamp(h ? h[1] : pick(p, ["gh"], 0), -1, 1);
  const bh = clamp(h ? h[2] : pick(p, ["bh"], 0), -1, 1);
  if ([rs, gs, bs, rm, gm, bm, rh, gh, bh].every(v => Math.abs(v) < 1e-4)) return undefined;
  const pl = p.preserveLightness === false || p.pl === false ? "false" : "true";
  return `colorbalance=rs=${fnum(rs)}:gs=${fnum(gs)}:bs=${fnum(bs)}:rm=${fnum(rm)}:gm=${fnum(gm)}:bm=${fnum(bm)}:rh=${fnum(rh)}:gh=${fnum(gh)}:bh=${fnum(bh)}:pl=${pl}`;
});

/**
 * color { brightness, contrast, saturation, gamma, exposure, black, warmth/temperature, kelvin, tint, shadows, highlights, blacks, whites }
 * Keeps the single `eq=...` pass when only eq parameters are given, and composes exposure, curves, eq, and white balance cleanly when extended grading params are present.
 */
registerEffect("color", "video", (p) => {
  const hasExtended = ["exposure", "black", "warmth", "temperature", "kelvin", "tint", "shadows", "highlights", "blacks", "whites"]
    .some(k => p[k] !== undefined);
  const brightness = clamp(pick(p, ["brightness"], 0), -1, 1);
  const contrast = clamp(pick(p, ["contrast"], 1), -1000, 1000);
  const saturation = clamp(pick(p, ["saturation"], 1), 0, 3);
  const gamma = clamp(pick(p, ["gamma"], 1), 0.1, 10);
  const eq = `eq=brightness=${fnum(brightness)}:contrast=${fnum(contrast)}:saturation=${fnum(saturation)}:gamma=${fnum(gamma)}`;
  if (!hasExtended) return eq;

  const filters: string[] = [];
  const exp = exposureFilter(pick(p, ["exposure"], 0), pick(p, ["black"], 0));
  if (exp) filters.push(exp);
  const curve = shadowsHighlightsFilter(
    pick(p, ["shadows"], 0),
    pick(p, ["highlights"], 0),
    pick(p, ["blacks"], 0),
    pick(p, ["whites"], 0),
  );
  if (curve) filters.push(curve);
  const eqActive = Math.abs(brightness) >= 1e-4 || Math.abs(contrast - 1) >= 1e-4 || Math.abs(saturation - 1) >= 1e-4 || Math.abs(gamma - 1) >= 1e-4;
  if (eqActive) filters.push(eq);
  filters.push(...whiteBalanceFilters(
    pick(p, ["warmth", "temperature"], 0),
    pick(p, ["tint"], 0),
    p.kelvin !== undefined ? num(p.kelvin, 6500) : undefined,
  ));
  return filters.length ? filters : eq;
});

/** sharpen { amount } 0..5 via unsharp */
registerEffect("sharpen", "video", (p) => `unsharp=la=${fnum(clamp(pick(p, ["amount", "value"], 1), -2, 5))}`);

const lutInterpolations = new Set(["nearest", "trilinear", "tetrahedral", "pyramid", "prism", "0", "1", "2", "3", "4"]);

/** lut { file } (.cube/.3dl, relative to mediaRoot or a trusted style guide root), { interp } optional */
registerEffect("lut", "video", (p, ctx) => {
  const file = typeof p.file === "string" ? p.file : typeof p.path === "string" ? p.path : undefined;
  if (!file) {
    ctx.warn('lut effect without a "file" parameter ignored');
    return undefined;
  }
  const mode = typeof p.interp === "number" ? String(p.interp) : p.interp;
  if (mode !== undefined && !(typeof mode === "string" && lutInterpolations.has(mode))) {
    throw new Error("Invalid LUT interpolation");
  }
  const abs = resolveLutFile(file, ctx.mediaRoot, ctx.lutRoots);
  if (!abs) throw new Error("LUT file must be a file inside the project media or style guides directory");
  const interp = mode === undefined ? "" : `:interp=${mode}`;
  return `lut3d=file=${escapeFilterPath(abs)}${interp}`;
});

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** denoise { amount (dB reduction, default 12), noiseFloor (dBFS, default -25) } */
registerEffect("denoise", "audio", (p) => {
  const nr = clamp(pick(p, ["amount", "nr"], 12), 0.01, 97);
  const nf = clamp(pick(p, ["noiseFloor", "nf"], -25), -80, -20);
  return `afftdn=nr=${fnum(nr)}:nf=${fnum(nf)}`;
});

/**
 * voiceCleanup { mix (0–1, default 1) }: the voice separated from the noise and the room by a speech model (FFmpeg's
 * arnndn with a bundled RNNoise model). mix is how much of the cleaned sound plays, the rest the sound as recorded.
 * The model hears in 480-sample frames at 48 kHz and plays each one a frame late: 10 ms.
 */
registerEffect("voiceCleanup", "audio", (p) => {
  const mix = clamp(pick(p, ["mix", "amount"], 1), 0, 1);
  return `arnndn=m=${escapeFilterPath(voiceModelFile())}${mix < 1 ? `:mix=${fnum(mix)}` : ""}`;
}, 480 / 48000);

/** Downward expansion below threshold. rangeDb caps attenuation to retain room tone. */
registerEffect("expander", "audio", (p) => {
  const threshold = dbToLinear(clamp(pick(p, ["thresholdDb", "threshold"], -45), -96, 0));
  const range = dbToLinear(clamp(pick(p, ["rangeDb"], -12), -96, 0));
  return [
    "agate=mode=downward",
    `threshold=${fnum(threshold)}`,
    `range=${fnum(range)}`,
    `ratio=${fnum(clamp(pick(p, ["ratio"], 2), 1, 20))}`,
    `attack=${fnum(clamp(pick(p, ["attack"], 5), 0.01, 9000))}`,
    `release=${fnum(clamp(pick(p, ["release"], 150), 0.01, 9000))}`,
  ].join(":");
});

/**
 * eq { highpass?: Hz, lowpass?: Hz, bands?: [{ frequency, gain (dB), width (Q, default 1) }] }
 * A single { frequency, gain } is accepted as a one-band shorthand.
 */
registerEffect("eq", "audio", (p, ctx) => {
  const out: string[] = [];
  if (p.highpass !== undefined) out.push(`highpass=f=${fnum(clamp(num(p.highpass, 80), 1, 20000))}`);
  if (p.lowpass !== undefined) out.push(`lowpass=f=${fnum(clamp(num(p.lowpass, 12000), 1, 20000))}`);
  const bands = Array.isArray(p.bands) ? p.bands : p.frequency !== undefined ? [p] : [];
  for (const b of bands as Array<Record<string, unknown>>) {
    const f = num(b.frequency ?? b.f, 0);
    if (!f) {
      ctx.warn("eq band without frequency ignored");
      continue;
    }
    out.push(`equalizer=f=${fnum(clamp(f, 1, 20000))}:t=q:w=${fnum(clamp(num(b.width ?? b.q, 1), 0.1, 100))}:g=${fnum(clamp(num(b.gain, 0), -40, 40))}`);
  }
  return out;
});

/**
 * compressor { thresholdDb (default -18) | threshold (linear), ratio (default 3),
 *              attack ms (default 20), release ms (default 250), makeupDb (default 0), knee (default 2.8) }
 */
registerEffect("compressor", "audio", (p) => {
  const threshold =
    p.threshold !== undefined ? clamp(num(p.threshold, 0.125), 0.001, 1) : clamp(dbToLinear(pick(p, ["thresholdDb"], -18)), 0.001, 1);
  const makeup = p.makeup !== undefined ? clamp(num(p.makeup, 1), 1, 64) : clamp(dbToLinear(pick(p, ["makeupDb"], 0)), 1, 64);
  return [
    `acompressor=threshold=${fnum(threshold)}`,
    `ratio=${fnum(clamp(pick(p, ["ratio"], 3), 1, 20))}`,
    `attack=${fnum(clamp(pick(p, ["attack"], 20), 0.01, 2000))}`,
    `release=${fnum(clamp(pick(p, ["release"], 250), 0.01, 9000))}`,
    `makeup=${fnum(makeup)}`,
    `knee=${fnum(clamp(pick(p, ["knee"], 2.8), 1, 8))}`,
  ].join(":");
});

/** limiter { limitDb (default -1) | limit (linear), attack ms, release ms } */
registerEffect("limiter", "audio", (p) => {
  const limit = p.limit !== undefined ? clamp(num(p.limit, 0.89), 0.0625, 1) : clamp(dbToLinear(pick(p, ["limitDb"], -1)), 0.0625, 1);
  return `alimiter=limit=${fnum(limit)}:attack=${fnum(clamp(pick(p, ["attack"], 5), 0.1, 80))}:release=${fnum(clamp(pick(p, ["release"], 50), 1, 8000))}:level=false`;
});

/** loudnorm { i (LUFS, default -16), tp (dBTP, default -1.5), lra (LU, default 11) } — single pass */
registerEffect("loudnorm", "audio", (p) => {
  const i = clamp(pick(p, ["i", "I", "target"], -16), -70, -5);
  const tp = clamp(pick(p, ["tp", "TP", "truePeak"], -1.5), -9, 0);
  const lra = clamp(pick(p, ["lra", "LRA"], 11), 1, 50);
  return `loudnorm=I=${fnum(i)}:TP=${fnum(tp)}:LRA=${fnum(lra)}`;
});
