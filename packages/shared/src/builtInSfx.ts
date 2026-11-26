/**
 * Lightweight, royalty-free built-in starter sound effects for Style Guides.
 * Synthesized deterministically as 48 kHz 16-bit PCM WAV so the server, timelines,
 * exports, and renderer preview all share identical, clean audio with zero binary blobs.
 */

export interface BuiltInStyleSound {
  id: string;
  name: string;
  category: "transition" | "accent" | "reveal";
  duration: number;
  defaultVolumeDb: number;
  defaultUsageRule: string;
  /** Normalized 0..1 envelope bars for subtle waveform preview. */
  waveform: number[];
}

export const BUILT_IN_STYLE_SOUNDS: readonly BuiltInStyleSound[] = [
  {
    id: "soft-whoosh",
    name: "Soft whoosh",
    category: "transition",
    duration: 0.45,
    defaultVolumeDb: -14,
    defaultUsageRule: "Paired with push or slide transitions",
    waveform: [0.06, 0.11, 0.18, 0.27, 0.39, 0.54, 0.7, 0.85, 0.96, 1, 0.94, 0.83, 0.7, 0.56, 0.44, 0.34, 0.25, 0.19, 0.14, 0.1, 0.07, 0.05, 0.03, 0.02],
  },
  {
    id: "subtle-pop",
    name: "Subtle pop",
    category: "accent",
    duration: 0.18,
    defaultVolumeDb: -12,
    defaultUsageRule: "When a stat callout or badge appears",
    waveform: [0.18, 0.76, 1, 0.88, 0.68, 0.5, 0.37, 0.27, 0.2, 0.14, 0.1, 0.08, 0.06, 0.04, 0.03, 0.02, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
  },
  {
    id: "airy-slide",
    name: "Airy slide",
    category: "transition",
    duration: 0.38,
    defaultVolumeDb: -15,
    defaultUsageRule: "When a lower third or panel enters",
    waveform: [0.08, 0.17, 0.3, 0.48, 0.68, 0.84, 0.95, 1, 0.92, 0.78, 0.64, 0.51, 0.4, 0.31, 0.24, 0.18, 0.13, 0.1, 0.07, 0.05, 0.04, 0.03, 0.02, 0.01],
  },
  {
    id: "subtle-riser",
    name: "Subtle riser",
    category: "reveal",
    duration: 0.85,
    defaultVolumeDb: -16,
    defaultUsageRule: "Leading into a chapter card or reveal",
    waveform: [0.04, 0.05, 0.07, 0.09, 0.12, 0.15, 0.19, 0.24, 0.3, 0.36, 0.44, 0.52, 0.61, 0.7, 0.79, 0.88, 0.95, 1, 0.93, 0.74, 0.48, 0.26, 0.12, 0.04],
  },
  {
    id: "clean-chime",
    name: "Clean chime",
    category: "accent",
    duration: 0.55,
    defaultVolumeDb: -16,
    defaultUsageRule: "Chapter title or key takeaway",
    waveform: [0.24, 0.92, 1, 0.86, 0.75, 0.66, 0.58, 0.5, 0.44, 0.38, 0.33, 0.28, 0.24, 0.21, 0.18, 0.15, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04, 0.02, 0.01],
  },
  {
    id: "crisp-tick",
    name: "Crisp tick",
    category: "accent",
    duration: 0.09,
    defaultVolumeDb: -14,
    defaultUsageRule: "UI highlight or step change",
    waveform: [0.45, 1, 0.72, 0.44, 0.26, 0.15, 0.09, 0.05, 0.03, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
  },
] as const;

const BUILT_IN_MAP = new Map<string, BuiltInStyleSound>(BUILT_IN_STYLE_SOUNDS.map(s => [s.id, s]));

export function findBuiltInStyleSound(id: string): BuiltInStyleSound | undefined {
  const slug = id.startsWith("builtin:") ? id.slice("builtin:".length) : id;
  return BUILT_IN_MAP.get(slug);
}

/** Convert dB relative to 0 dBFS to a safe linear gain multiplier (e.g. -14 dB -> ~0.1995). */
export function dbToLinearGain(db: number): number {
  const clamped = Math.min(6, Math.max(-48, db));
  return Math.round(Math.pow(10, clamped / 20) * 10000) / 10000;
}

/** Deterministic PRNG (Mulberry32) so synthesized audio bytes are reproducible across runs. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Encode mono float samples (-1..1) at `sampleRate` into a standard 16-bit PCM WAV buffer. */
function encodeMonoWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

const SAMPLE_RATE = 48_000;

/**
 * Synthesize a built-in starter sound effect as a 48 kHz 16-bit PCM WAV.
 * Returns undefined for unknown IDs.
 */
export function synthesizeBuiltInSfxWav(id: string): Uint8Array | undefined {
  const meta = findBuiltInStyleSound(id);
  if (!meta) return undefined;
  const n = Math.max(1, Math.round(meta.duration * SAMPLE_RATE));
  const out = new Float32Array(n);
  const rand = rng(0x5ca1e7 ^ meta.id.split("").reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7));

  if (meta.id === "soft-whoosh") {
    let lp1 = 0, lp2 = 0, hp = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      // Smooth bell envelope peaking slightly before midpoint for a natural whoosh.
      const env = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.85)), 1.6);
      const noise = rand() * 2 - 1;
      const cutoff = 280 + 1850 * Math.sin(Math.PI * u);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
      lp1 += a * (noise - lp1);
      lp2 += a * (lp1 - lp2);
      // Gentle high-pass around 120 Hz to remove sub rumble.
      const hpA = 0.985;
      hp = hpA * (hp + lp2 - prev);
      prev = lp2;
      out[i] = hp * env * 1.45;
    }
  } else if (meta.id === "subtle-pop") {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const u = i / n;
      const freq = 190 + 360 * Math.exp(-t * 34);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      const attack = Math.min(1, t / 0.004);
      const decay = Math.exp(-t * 26) * (1 - u * 0.15);
      out[i] = (Math.sin(phase) * 0.82 + Math.sin(phase * 2) * 0.16) * attack * decay * 0.72;
    }
  } else if (meta.id === "airy-slide") {
    let lp = 0, hp = 0, prev = 0, phase = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const env = Math.sin(Math.PI * Math.pow(u, 0.75)) * (1 - u * 0.25);
      const noise = rand() * 2 - 1;
      const cutoff = 900 + 2600 * Math.sin(Math.PI * u);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
      lp += a * (noise - lp);
      hp = 0.94 * (hp + lp - prev);
      prev = lp;
      const f = 520 + 220 * u;
      phase += (2 * Math.PI * f) / SAMPLE_RATE;
      out[i] = (hp * 0.85 + Math.sin(phase) * 0.12) * env * 0.95;
    }
  } else if (meta.id === "subtle-riser") {
    let lp = 0, hp = 0, prev = 0, phase = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const fadeOut = u > 0.82 ? Math.cos(((u - 0.82) / 0.18) * (Math.PI / 2)) : 1;
      const env = Math.pow(u, 1.8) * fadeOut;
      const noise = rand() * 2 - 1;
      const cutoff = 260 + 2900 * Math.pow(u, 1.7);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
      lp += a * (noise - lp);
      hp = 0.97 * (hp + lp - prev);
      prev = lp;
      const f = 140 + 340 * Math.pow(u, 1.5);
      phase += (2 * Math.PI * f) / SAMPLE_RATE;
      out[i] = (hp * 0.78 + Math.sin(phase) * 0.22) * env * 1.1;
    }
  } else if (meta.id === "clean-chime") {
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const attack = Math.min(1, t / 0.008);
      const d1 = Math.exp(-t * 6.2);
      const d2 = Math.exp(-t * 10.5);
      const s =
        Math.sin(2 * Math.PI * 587.33 * t) * 0.55 * d1 + // D5
        Math.sin(2 * Math.PI * 880.0 * t) * 0.3 * d1 + // A5
        Math.sin(2 * Math.PI * 1760.0 * t) * 0.12 * d2; // A6 shimmer
      out[i] = s * attack * 0.65;
    }
  } else {
    // crisp-tick
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const attack = Math.min(1, t / 0.0015);
      const decay = Math.exp(-t * 58);
      const noise = rand() * 2 - 1;
      lp += 0.35 * (noise - lp);
      const body = Math.sin(2 * Math.PI * (1400 - 500 * Math.min(1, t * 40)) * t);
      out[i] = (body * 0.65 + lp * 0.35) * attack * decay * 0.7;
    }
  }

  // Soft-clip and normalize peak gently to -1.5 dBFS so no sound ever clips.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  const scale = peak > 1e-6 ? 0.84 / peak : 1;
  for (let i = 0; i < n; i++) out[i] = out[i]! * scale;
  return encodeMonoWav(out, SAMPLE_RATE);
}
