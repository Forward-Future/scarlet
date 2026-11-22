import type { MediaClip, TimeRange, TransformKeyframe, VolumeKeyframe } from "./schema.js";
import { clipEnd } from "./time.js";

/** Where an eased move is, from 0 to 1, a share `p` of the way through it: the curves a transform keyframe moves on. */
export function eased(ease: TransformKeyframe["ease"], p: number): number {
  const x = Math.min(1, Math.max(0, p));
  switch (ease) {
    case "easeIn": return x * x;
    case "easeOut": return 1 - (1 - x) * (1 - x);
    case "easeInOut": return x * x * (3 - 2 * x);
    case "hold": return 0;
    default: return x;
  }
}

/** The level in dB a clip's volume keyframes give it `time` seconds from its start: 0 with none. */
export function volumeDbAt(keys: readonly VolumeKeyframe[] | undefined, time: number): number {
  if (!keys?.length) return 0;
  const sorted = keys.length > 1 ? [...keys].sort((a, b) => a.time - b.time) : keys;
  if (time <= sorted[0]!.time) return sorted[0]!.db;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    if (time >= b.time) continue;
    const span = b.time - a.time;
    return span > 0 ? a.db + (b.db - a.db) * eased(a.ease, (time - a.time) / span) : b.db;
  }
  return sorted.at(-1)!.db;
}

/** A clip's linear gain at a timeline second: its volume with its keyframes on top. */
export function clipGainAt(clip: Pick<MediaClip, "timelineIn" | "volume" | "volumeKeyframes">, at: number): number {
  return clip.volume * Math.pow(10, volumeDbAt(clip.volumeKeyframes, at - clip.timelineIn) / 20);
}

/** How a clip's level dips: how deep, and over how long it goes down before each stretch and back up after it. */
export interface DipShape {
  /** dB under the clip's own level while a stretch plays (negative). */
  depth: number;
  /** Seconds the level takes to go down, ending as the stretch starts. */
  down: number;
  /** Seconds the level takes to come back up, starting as the stretch ends. */
  up: number;
}

/** One dip as placed, in timeline seconds: down at `start`, back up from `end`. */
export interface PlacedDip { start: number; end: number; depth: number }

/**
 * Stretches merged where the level couldn't come back up between them: where the gap is shorter than going up and down
 * again takes, the dip holds through it. Sorted, in timeline seconds.
 */
export function dipStretches(stretches: readonly TimeRange[], shape: Pick<DipShape, "down" | "up">): TimeRange[] {
  const sorted = stretches.filter(s => s.end > s.start).map(s => ({ ...s })).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start - last.end < shape.down + shape.up) last.end = Math.max(last.end, s.end);
    else out.push(s);
  }
  return out;
}

/**
 * The volume keyframes that dip a clip under `stretches` (timeline seconds). They take the place of the clip's keyframes
 * in `within` (timeline seconds), and of all of them without it. Each dip goes down over `down` seconds to reach `depth` as its stretch starts, holds, and comes
 * back up over `up` seconds once it ends, easing in and out. Times are the clip's own, from its start.
 */
export function dipKeyframes(clip: Pick<MediaClip, "timelineIn" | "volumeKeyframes"> & Parameters<typeof clipEnd>[0],
  stretches: readonly TimeRange[], shape: DipShape, within?: TimeRange): { keys: VolumeKeyframe[]; dips: PlacedDip[] } {
  const start = clip.timelineIn, end = clipEnd(clip);
  const dips = dipStretches(stretches, shape).filter(s => s.end + shape.up > start && s.start - shape.down < end)
    .map(s => ({ start: s.start, end: s.end, depth: shape.depth }));
  const local = (t: number) => t - start;
  const kept = within ? (clip.volumeKeyframes ?? []).filter(k => start + k.time < within.start - 1e-6 || start + k.time > within.end + 1e-6)
    .map(k => ({ ...k })) : [];
  const made: VolumeKeyframe[] = dips.flatMap(d => [
    { time: local(d.start - shape.down), db: 0, ease: "easeInOut" as const },
    { time: local(d.start), db: d.depth, ease: "linear" as const },
    { time: local(d.end), db: d.depth, ease: "easeInOut" as const },
    { time: local(d.end + shape.up), db: 0, ease: "linear" as const },
  ]);
  const keys = [...kept, ...made].sort((a, b) => a.time - b.time);
  return { keys, dips };
}

/**
 * A clip's level from `from` to `to` seconds of the clip as straight lines between points, for an app that draws a
 * level only that way: an eased move becomes `steps` straight pieces, and a hold steps to the next key `gap` seconds
 * before it. Each point's level is what Scarlet plays there.
 */
export function levelLines(keys: readonly VolumeKeyframe[] | undefined, from: number, to: number, gap: number, steps = 8): { time: number; db: number }[] {
  if (!keys?.length || to < from) return [];
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  const times = new Set<number>([from, to]);
  sorted.forEach((a, i) => {
    times.add(a.time);
    const b = sorted[i + 1];
    if (!b || b.time <= a.time) return;
    if (a.ease === "hold") times.add(Math.max(a.time, b.time - gap));
    else if (a.ease !== "linear") for (let s = 1; s < steps; s++) times.add(a.time + (b.time - a.time) * s / steps);
  });
  return [...times].filter(t => t >= from - 1e-9 && t <= to + 1e-9).sort((a, b) => a - b).map(time => ({ time, db: volumeDbAt(sorted, time) }));
}
