import { carriesAudio, clipEnd, sourceAt, type MediaAsset, type MediaClip, type Timeline } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import { syncRate } from "./audio-sync.js";

// Two recordings of the same event that play together (a camera inset over a screen capture, a separate mic
// under a camera, or synced multi-cam angles) stay in line only while every pair of their clips keeps one
// offset. A cut that trims one track and not the other, or a timeline rewritten by hand, breaks that without
// anything sounding wrong.

export interface OutOfLine { from: number; to: number; offset: number; differsBy: number }
export interface HeardSpot { at: number; late: number }
export interface PairSync {
  reference: string;
  secondary: string;
  /** The offset most of their shared time plays at: secondary source seconds (divided by speed) plus this = reference source seconds (divided by speed). */
  offset: number;
  togetherSeconds: number;
  /** Stretches, in timeline seconds, where the two play at another offset. */
  outOfLine: OutOfLine[];
  /** Where the shared sound was compared: `late` is the seconds the secondary's sound comes after the reference's. */
  heard: HeardSpot[];
  /** Long shared stretches (4 s or more) with too little sound in one recording to compare. */
  unheard: number;
}

type Levels = (mediaId: string, from: number, to: number) => Promise<number[]>;

interface Together { reference: MediaClip; secondary: MediaClip; from: number; to: number; offset: number }

const r3 = round3;
/** Clock-drift speed adjustments stay close to 1x; speed-up effects (e.g. 2x–4x) are left out of sync checks. */
const MAX_DRIFT_SPEED_DELTA = 0.02;
const isSyncSpeed = (speed: number | undefined) => Math.abs((speed ?? 1) - 1) <= MAX_DRIFT_SPEED_DELTA;
/** Where a clip's source 0 lands relative to timeline 0, invariant across cuts even with drift-compensated speed. */
const placement = (clip: MediaClip) => clip.sourceIn / (clip.speed ?? 1) - clip.timelineIn;

/** Every stretch where clips of two different recordings play at once, both at normal or drift-compensated speed. */
function together(timeline: Timeline, media: Map<string, MediaAsset>) {
  const firstTrack = new Map<string, number>();
  const clips: MediaClip[] = [];
  timeline.tracks.forEach((track, index) => {
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || !isSyncSpeed(clip.speed)) continue;
      const kind = media.get(clip.mediaId)?.kind;
      if (kind !== "video" && kind !== "audio") continue;
      clips.push(clip);
      if (!firstTrack.has(clip.mediaId)) firstTrack.set(clip.mediaId, index);
    }
  });
  clips.sort((a, b) => a.timelineIn - b.timelineIn);
  const pairs = new Map<string, Together[]>();
  const open: MediaClip[] = [];
  for (const clip of clips) {
    for (let i = open.length - 1; i >= 0; i--) if (clipEnd(open[i]!) <= clip.timelineIn) open.splice(i, 1);
    for (const other of open) {
      if (other.mediaId === clip.mediaId) continue;
      const from = clip.timelineIn, to = Math.min(clipEnd(clip), clipEnd(other));
      if (to - from < 0.1) continue;
      // The recording that starts on the lower track is the reference, so the pair reads the same way every time.
      const order = firstTrack.get(other.mediaId)! - firstTrack.get(clip.mediaId)! || (other.mediaId < clip.mediaId ? -1 : 1);
      const [reference, secondary] = order < 0 ? [other, clip] : [clip, other];
      const key = `${reference.mediaId}\u0000${secondary.mediaId}`;
      const list = pairs.get(key) ?? [];
      const offset = placement(reference) - placement(secondary);
      // A camera's picture on Program and on its hidden angle track (or picture and detached sound) meet the other
      // recording at the same offset over overlapping stretches: collapse covered stretches at the same offset so
      // `togetherSeconds` and `heard` spots aren't double-counted, while keeping any out-of-line stretch distinct.
      const sameOffset = (t: Together) => Math.abs(t.offset - offset) < 1e-3;
      const enclosing = list.find(t => sameOffset(t) && t.from <= from + 1e-3 && t.to >= to - 1e-3);
      if (!enclosing) {
        // Drop smaller stretches already contained inside this new same-offset stretch.
        for (let i = list.length - 1; i >= 0; i--) {
          const prev = list[i]!;
          if (sameOffset(prev) && from <= prev.from + 1e-3 && to >= prev.to - 1e-3) list.splice(i, 1);
        }
        list.push({ reference, secondary, from, to, offset });
      }
      pairs.set(key, list);
    }
    open.push(clip);
  }
  return pairs;
}

/** The offset the most shared time plays at, to within a frame. */
function usual(list: Together[], frame: number) {
  const weight = new Map<number, number>();
  for (const t of list) {
    const key = Math.round(t.offset / frame);
    weight.set(key, (weight.get(key) ?? 0) + t.to - t.from);
  }
  const [key] = [...weight].sort((a, b) => b[1] - a[1])[0]!;
  const near = list.filter(t => Math.round(t.offset / frame) === key);
  return near.reduce((s, t) => s + t.offset * (t.to - t.from), 0) / near.reduce((s, t) => s + t.to - t.from, 0);
}

/** Lag in seconds of `secondary` behind `reference`, within ±search, or undefined when there is too little sound to tell. */
export function lagBetween(reference: number[], secondary: number[], search: number): number | undefined {
  const width = reference.length;
  const mean = reference.reduce((s, n) => s + n, 0) / width;
  const centered = reference.map(n => n - mean);
  const energy = centered.reduce((s, n) => s + n * n, 0);
  if (energy < 1e-6) return;
  let best = -Infinity, bestLag = 0, second = -Infinity;
  const scores: number[] = [];
  for (let lag = 0; lag + width <= secondary.length && lag <= 2 * search; lag++) {
    const window = secondary.slice(lag, lag + width);
    const m = window.reduce((s, n) => s + n, 0) / width;
    let dot = 0, own = 0;
    for (let i = 0; i < width; i++) { const v = window[i]! - m; dot += centered[i]! * v; own += v * v; }
    scores[lag] = own > 1e-6 ? dot / Math.sqrt(energy * own) : 0;
    if (scores[lag]! > best) { best = scores[lag]!; bestLag = lag; }
  }
  for (let lag = 0; lag < scores.length; lag++) if (Math.abs(lag - bestLag) > 3) second = Math.max(second, scores[lag]!);
  if (best < 0.7 || best - second < 0.05) return;
  return (bestLag - search) / syncRate;
}

/**
 * Check that recordings of the same event stay in line through the edit: from the placements alone, then by
 * comparing their sound at up to `spots` places spread across the edit.
 */
export async function timelineSync(timeline: Timeline, assets: MediaAsset[], fps: number, levels: Levels, spots = 5): Promise<PairSync[]> {
  const media = new Map(assets.map(a => [a.id, a]));
  const frame = 1 / fps;
  const result: PairSync[] = [];
  for (const list of together(timeline, media).values()) {
    const total = list.reduce((s, t) => s + t.to - t.from, 0);
    if (total < 1) continue;
    const offset = usual(list, frame);
    // Most of their shared time at one offset is what makes two recordings one event. B-roll laid over
    // a camera from all over its source plays at a different offset every time and is not checked.
    const inLine = list.filter(t => Math.abs(t.offset - offset) < frame - 1e-3);
    if (inLine.reduce((s, t) => s + t.to - t.from, 0) < 0.6 * total) continue;
    const outOfLine: OutOfLine[] = [];
    for (const t of list) {
      const differsBy = t.offset - offset;
      if (Math.abs(differsBy) < frame - 1e-3) continue;
      const last = outOfLine.at(-1);
      if (last && Math.abs(last.to - t.from) < 1e-3 && Math.abs(last.offset - r3(t.offset)) < 1e-3) last.to = r3(t.to);
      else outOfLine.push({ from: r3(t.from), to: r3(t.to), offset: r3(t.offset), differsBy: r3(differsBy) });
    }

    const { reference, secondary } = list[0]!;
    const heard: HeardSpot[] = [];
    let unheard = 0;
    const ref = media.get(reference.mediaId)!, sec = media.get(secondary.mediaId)!;
    if (carriesAudio(ref) && carriesAudio(sec)) {
      // Each long shared stretch is compared at its liveliest 3 s in both recordings. A screen capture often
      // hears the room only now and then, so the spots are spread across the stretches that have sound in both.
      const [a, b] = await Promise.all([whole(ref, levels), whole(sec, levels)]);
      const long = list.filter(t => t.to - t.from >= 4).sort((x, y) => x.from - y.from);
      const found = long.map(t => compare(t, a, b));
      const sounding = found.filter((h): h is HeardSpot => h !== undefined);
      unheard = long.length - sounding.length;
      for (const index of spreadOrder(sounding.length).slice(0, spots)) heard.push(sounding[index]!);
      heard.sort((a, b) => a.at - b.at);
    }
    result.push({ reference: reference.mediaId, secondary: secondary.mediaId, offset: r3(offset), togetherSeconds: Math.round(total),
      outOfLine, heard, unheard });
  }
  return result;
}

const WINDOW = 3 * syncRate, SEARCH = Math.round(0.5 * syncRate);

const variance = (values: number[], from: number, width: number) => {
  let sum = 0, squares = 0;
  for (let i = from; i < from + width; i++) { sum += values[i]!; squares += values[i]! * values[i]!; }
  return squares / width - (sum / width) ** 2;
};

/** A recording's levels from start to end, 50 a second, read in the pieces the engine serves. */
async function whole(asset: MediaAsset, levels: Levels) {
  const count = Math.floor((asset.duration ?? 0) * syncRate);
  const parts: Array<Promise<number[]>> = [];
  for (let start = 0; start < count; start += 10_000) parts.push(levels(asset.id, start / syncRate, Math.min(start + 10_000, count) / syncRate));
  return (await Promise.all(parts)).flat();
}

/** Compare one shared stretch at the 3 s where both recordings vary most. */
function compare(t: Together, a: number[], b: number[]): HeardSpot | undefined {
  const first = Math.ceil(t.from * syncRate), last = Math.floor(t.to * syncRate) - WINDOW;
  let best: number | undefined, bestScore = 1e-5;
  for (let i = first; i <= last; i += syncRate / 2) {
    const tlSec = i / syncRate;
    const r = Math.round(sourceAt(t.reference, tlSec) * syncRate);
    const s = Math.round(sourceAt(t.secondary, tlSec) * syncRate);
    if (r < 0 || s - SEARCH < 0 || r + WINDOW > a.length || s + WINDOW + SEARCH > b.length) continue;
    const score = Math.min(variance(a, r, WINDOW), variance(b, s, WINDOW));
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best === undefined) return;
  const tlSec = best / syncRate;
  const r = Math.round(sourceAt(t.reference, tlSec) * syncRate);
  const s = Math.round(sourceAt(t.secondary, tlSec) * syncRate);
  const lag = lagBetween(a.slice(r, r + WINDOW), b.slice(s - SEARCH, s + WINDOW + SEARCH), SEARCH);
  return lag === undefined ? undefined : { at: r3((best + WINDOW / 2) / syncRate), late: r3(lag) };
}

/** Indices 0..n-1 in an order that covers the range evenly first: ends, middle, quarters, then the rest. */
function spreadOrder(n: number) {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let parts = 1; order.length < n; parts *= 2) {
    for (let k = 0; k <= parts; k++) {
      const i = Math.round(k * (n - 1) / parts);
      if (!seen.has(i)) { seen.add(i); order.push(i); }
    }
    if (parts > n) for (let i = 0; i < n; i++) if (!seen.has(i)) { seen.add(i); order.push(i); }
  }
  return order;
}

/** One line for the editor: what was checked and how it came out. */
export function syncSummary(pairs: PairSync[], names: Map<string, string>, fps: number): string | undefined {
  if (!pairs.length) return;
  const frame = 1 / fps;
  return pairs.map(p => {
    const label = `${names.get(p.reference) ?? p.reference} and ${names.get(p.secondary) ?? p.secondary}`;
    const placed = p.outOfLine.length ? `${p.outOfLine.length} stretch${p.outOfLine.length === 1 ? "" : "es"} placed out of line` : "placed in line throughout";
    const off = p.heard.filter(h => Math.abs(h.late) >= frame - 1e-3);
    const heard = !p.heard.length ? (p.unheard ? "not compared by sound, as too little of it is shared in the kept parts" : "not compared by sound, as one has none")
      : off.length ? `heard ${off.length} of ${p.heard.length} spots off by a frame or more`
      : `heard in line at ${p.heard.length} spot${p.heard.length === 1 ? "" : "s"}, within a frame`;
    return `${label}: ${placed}; ${heard}.`;
  }).join(" ");
}
