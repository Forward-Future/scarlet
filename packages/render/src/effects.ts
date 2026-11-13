/**
 * Effect registry: maps `Effect.type` in the cut list to ffmpeg filter
 * strings. Unknown
 * types are skipped with a warning so an agent typo never breaks a render.
 */
import { fileInDirectory } from "./assetPath.js";
import type { Effect } from "@scarlet/timeline";
import { fnum } from "./exec.js";

export type EffectKind = "video" | "audio";

export interface EffectContext {
  /** Absolute directory relative media/LUT paths resolve against. */
  mediaRoot: string;
  warn: (message: string) => void;
}

/** Returns one or more filter strings (without labels), or undefined to skip. */
export type EffectBuilder = (params: Record<string, unknown>, ctx: EffectContext) => string | string[] | undefined;

interface Registered {
  kind: EffectKind;
  build: EffectBuilder;
}

const registry = new Map<string, Registered>();

export function registerEffect(type: string, kind: EffectKind, build: EffectBuilder): void {
  registry.set(type, { kind, build });
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

/** color { brightness, contrast, saturation, gamma } in one eq pass */
registerEffect("color", "video", (p) => {
  const parts = [
    `brightness=${fnum(clamp(pick(p, ["brightness"], 0), -1, 1))}`,
    `contrast=${fnum(clamp(pick(p, ["contrast"], 1), -1000, 1000))}`,
    `saturation=${fnum(clamp(pick(p, ["saturation"], 1), 0, 3))}`,
    `gamma=${fnum(clamp(pick(p, ["gamma"], 1), 0.1, 10))}`,
  ];
  return `eq=${parts.join(":")}`;
});

/** sharpen { amount } 0..5 via unsharp */
registerEffect("sharpen", "video", (p) => `unsharp=la=${fnum(clamp(pick(p, ["amount", "value"], 1), -2, 5))}`);

const lutInterpolations = new Set(["nearest", "trilinear", "tetrahedral", "pyramid", "prism", "0", "1", "2", "3", "4"]);

/** lut { file } (.cube/.3dl, relative to mediaRoot), { interp } optional */
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
  const abs = fileInDirectory(ctx.mediaRoot, file);
  if (!abs) throw new Error("LUT file must be a file inside the project media directory");
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
    out.push(`equalizer=f=${fnum(f)}:t=q:w=${fnum(clamp(num(b.width ?? b.q, 1), 0.1, 100))}:g=${fnum(clamp(num(b.gain, 0), -40, 40))}`);
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
