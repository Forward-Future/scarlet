import type { MediaAsset, MediaClip, Timeline, TimeRange } from "./schema.js";
import { carriesAudio, clipEnd, findClipLocation, sourceToTimeline, timelineToSource } from "./time.js";

/** Two audible clips playing the same moment of the same recording at once, which the mix sums. */
export interface DoubledSound {
  mediaId: string;
  clipIds: [string, string];
  /** Timeline seconds where both play. */
  overlap: TimeRange;
  /** Seconds of the recording both play there. */
  source: TimeRange;
}

/**
 * A stretch where copies an edit made louder play: their volumes add up in the mix to more than the edit's base played
 * there. `overlap` and `source` are that stretch only, in exact seconds, not everywhere the two clips play together.
 */
export interface LouderDoubledSound extends DoubledSound {
  /**
   * The combined linear gain the copies play at over the stretch, and what the base played that moment of the recording
   * at: its own layering, its loudest clip, or for a moment it didn't play, the louder of unity and the loudest single
   * copy.
   */
  level: { before: number; after: number };
  /** Every clip playing that moment in sync over the stretch, whose volumes add up to `level.after`. */
  copies: string[];
  /**
   * The clips to turn down over the stretch, and the volume for each that brings the copies back to the base's level
   * there: first the clip the edit added or changed, so what the base already played elsewhere stays as it was, then as
   * many more as it takes when that one at 0 still leaves the stretch louder, as three copies where the base played one.
   */
  turnDown: { clipId: string; volume: number }[];
}

// The two copies line up to well under an audio sample at 48 kHz. Any farther apart is an offset someone placed, which
// can be shorter than a frame, so a frame is far too coarse a test.
const SAME_MOMENT = 1e-5;
// Shorter than half a sample at 48 kHz plays nothing.
const PLAYS = 0.5 / 48_000;
// Gains closer than this are the same level.
const SAME_LEVEL = 1e-6;

type Audio = Pick<MediaAsset, "id" | "kind" | "hasAudio">;
interface Heard { clip: MediaClip; start: number; end: number; source: TimeRange }
interface Pair { mediaId: string; a: Heard; b: Heard; overlap: TimeRange; source: TimeRange }
interface Layering { heard: Map<string, Heard[]>; pairs: Pair[] }

/** The clips the renderer mixes: enabled media with sound, at a volume above zero, on an unmuted video or audio track. */
function heardClips(timeline: Timeline, media: ReadonlyMap<string, Audio>): Map<string, Heard[]> {
  const byMedia = new Map<string, Heard[]>();
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || !(clip.volume > 0)) continue;
      const asset = media.get(clip.mediaId);
      if (!asset || !carriesAudio(asset)) continue;
      const heard = byMedia.get(clip.mediaId) ?? [];
      const start = clip.timelineIn, end = clipEnd(clip);
      heard.push({ clip, start, end, source: { start: timelineToSource(clip, start), end: timelineToSource(clip, end) } });
      byMedia.set(clip.mediaId, heard);
    }
  }
  return byMedia;
}

/** A crossfade overlaps its clips while one fades out and the other fades in, which is a join and not a second copy. */
function crossfades(a: Heard, b: Heard, overlap: TimeRange): boolean {
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  return overlap.start >= first.end - first.clip.audioFadeOut - PLAYS && overlap.end <= second.start + second.clip.audioFadeIn + PLAYS;
}

/** Every pair of audible clips that play the same moment of the same recording together, at the same speed. */
function layering(timeline: Timeline, media: ReadonlyMap<string, Audio>): Layering {
  const heardBy = heardClips(timeline, media);
  const pairs: Pair[] = [];
  for (const [mediaId, heard] of heardBy) {
    heard.sort((a, b) => a.start - b.start);
    for (let i = 0; i < heard.length; i++) {
      const a = heard[i]!;
      // Sorted by start, so the first clip that starts after this one ends ends the clips it can overlap.
      for (let j = i + 1; j < heard.length && heard[j]!.start < a.end - PLAYS; j++) {
        const b = heard[j]!;
        const overlap = { start: b.start, end: Math.min(a.end, b.end) };
        if (overlap.end - overlap.start < PLAYS) continue;
        if (Math.abs((a.clip.speed ?? 1) - (b.clip.speed ?? 1)) > 1e-9) continue;
        // Where the overlap starts, both clips play the same second of the recording.
        if (Math.abs(timelineToSource(a.clip, overlap.start) - timelineToSource(b.clip, overlap.start)) > SAME_MOMENT) continue;
        if (crossfades(a, b, overlap)) continue;
        pairs.push({ mediaId, a, b, overlap, source: { start: timelineToSource(a.clip, overlap.start), end: timelineToSource(a.clip, overlap.end) } });
      }
    }
  }
  return { heard: heardBy, pairs };
}

function described(p: Pair): DoubledSound {
  return { mediaId: p.mediaId, clipIds: [p.a.clip.id, p.b.clip.id], overlap: { start: round3(p.overlap.start), end: round3(p.overlap.end) },
    source: { start: round3(p.source.start), end: round3(p.source.end) } };
}

/** Every pair of audible clips that play the same moment of the same recording together, at the same speed. */
export function doubledSound(timeline: Timeline, media: Iterable<Audio>): DoubledSound[] {
  return layering(timeline, new Map([...media].map(m => [m.id, m] as const))).pairs.map(described);
}

const covers = (range: TimeRange, at: number) => range.start <= at && range.end > at;

/**
 * How one recording plays its second `at`: each set of copies in sync there, with their volumes added up as the mix
 * does, and the loudest clip playing it at all.
 */
function playedAt(heard: readonly Heard[], pairs: readonly Pair[], at: number) {
  const playing = heard.filter(h => covers(h.source, at));
  const loudest = Math.max(0, ...playing.map(h => h.clip.volume));
  // Pairs chain into the copies in sync with each other: a and b, and b and c, are three copies of one moment.
  const group = new Map<Heard, Heard>();
  const root = (h: Heard): Heard => { const up = group.get(h) ?? h; return up === h ? h : root(up); };
  const layered = pairs.filter(p => covers(p.source, at));
  for (const p of layered) group.set(root(p.a), root(p.b));
  const stacks = new Map<Heard, { level: number; pairs: Pair[]; copies: Heard[] }>();
  for (const h of new Set(layered.flatMap(p => [p.a, p.b]))) {
    const stack = stacks.get(root(h)) ?? { level: 0, pairs: [], copies: [] };
    stack.level += h.clip.volume;
    stack.copies.push(h);
    stacks.set(root(h), stack);
  }
  for (const p of layered) stacks.get(root(p.a))!.pairs.push(p);
  return { played: playing.length > 0, loudest, stacks: [...stacks.values()] };
}

interface Stretch { start: number; end: number; before: number; after: number; copies: Heard[] }

/** Whether `next` has `clip` as `before` had it: same place, same piece of the same recording, same volume. */
function unchanged(before: Timeline | null, next: Timeline, clip: MediaClip): boolean {
  const was = before && findClipLocation(before, clip.id), now = findClipLocation(next, clip.id);
  if (!was || !now || was.track.id !== now.track.id || was.clip.kind !== "media") return false;
  const c = was.clip;
  return c.mediaId === clip.mediaId && c.sourceIn === clip.sourceIn && c.sourceOut === clip.sourceOut &&
    c.timelineIn === clip.timelineIn && (c.speed ?? 1) === (clip.speed ?? 1) && c.volume === clip.volume &&
    (c.enabled !== false) === (clip.enabled !== false);
}

/**
 * Sound `next` plays louder than `before` did by layering copies of it: wherever copies of one moment of a recording
 * play in sync, their volumes add up, and that's compared against what `before` played that moment of the recording at,
 * wherever on the timeline it was. Splitting, rippling or moving copies layered on purpose leaves their level, so they
 * aren't reported, and nor is one clip's own volume. Each stretch that got louder is reported on its own, so a layer
 * extended past where it was layered is reported only where it was extended. Where a stack is louder, the pairs `before`
 * didn't have are the ones reported: an edit that only turns up copies `before` already layered is reported by those
 * pairs.
 */
export function introducedDoubledSound(before: Timeline | null, next: Timeline, media: Iterable<Audio>): LouderDoubledSound[] {
  const assets = new Map([...media].map(m => [m.id, m] as const));
  const was: Layering = before ? layering(before, assets) : { heard: new Map(), pairs: [] };
  const now = layering(next, assets);
  // Each pair's louder stretches of the recording, in order; neighbours at the same levels are one stretch.
  const louder = new Map<Pair, Stretch[]>();
  for (const mediaId of new Set(now.pairs.map(p => p.mediaId))) {
    const nowPairs = now.pairs.filter(p => p.mediaId === mediaId), wasPairs = was.pairs.filter(p => p.mediaId === mediaId);
    const nowHeard = now.heard.get(mediaId) ?? [], wasHeard = was.heard.get(mediaId) ?? [];
    // Every second of the recording a clip or a pair starts or stops playing; between two, nothing changes.
    const edges = [...nowPairs, ...wasPairs, ...nowHeard, ...wasHeard].flatMap(r => [r.source.start, r.source.end]).sort((a, b) => a - b);
    for (let i = 1; i < edges.length; i++) {
      if (edges[i]! - edges[i - 1]! < PLAYS) continue;
      const at = (edges[i - 1]! + edges[i]!) / 2;
      const n = playedAt(nowHeard, nowPairs, at);
      if (!n.stacks.length) continue;
      const w = playedAt(wasHeard, wasPairs, at);
      const base = w.played ? Math.max(w.loudest, ...w.stacks.map(s => s.level)) : Math.max(1, n.loudest);
      for (const stack of n.stacks) {
        if (stack.level <= base + SAME_LEVEL) continue;
        for (const p of stack.pairs) {
          const stretches = louder.get(p) ?? [];
          const last = stretches.at(-1);
          if (last && Math.abs(last.end - edges[i - 1]!) < PLAYS && Math.abs(last.before - base) < SAME_LEVEL &&
            Math.abs(last.after - stack.level) < SAME_LEVEL && sameCopies(last.copies, stack.copies)) last.end = edges[i]!;
          else stretches.push({ start: edges[i - 1]!, end: edges[i]!, before: base, after: stack.level, copies: stack.copies });
          louder.set(p, stretches);
        }
      }
    }
  }
  const key = (a: string, b: string) => [a, b].sort().join(" ");
  const oldPairs = new Set(was.pairs.map(p => key(p.a.clip.id, p.b.clip.id)));
  const found = now.pairs.flatMap(p => (louder.get(p) ?? []).map(s => ({ p, s, isNew: !oldPairs.has(key(p.a.clip.id, p.b.clip.id)) })));
  const changed = (h: Heard) => !unchanged(before, next, h.clip);
  // Three copies are three pairs over one stretch, and one report with its whole fix says it once.
  const said = new Set<string>();
  // A pair `before` already had is reported only when no new pair layers the same stretch: that one is the addition.
  return found.filter(f => f.isNew || !found.some(o => o.isNew && o.p.mediaId === f.p.mediaId && o.s.start < f.s.end && o.s.end > f.s.start))
    .filter(({ p, s }) => {
      const stretch = [p.mediaId, s.start, s.end, ...s.copies.map(h => h.clip.id).sort()].join(" ");
      return !said.has(stretch) && !!said.add(stretch);
    })
    .map(({ p, s }) => {
      // Turn down the copy the edit added or changed, so the mix the base had stays; with both or neither, the later one.
      // When that one at 0 still leaves the stretch louder, the next copy the edit added or changed, the later first,
      // and only then one the base had: each named copy alone would leave the model refused again.
      const quiet = [p.b, p.a].find(changed) ?? p.b;
      const rest = s.copies.filter(h => h !== quiet).sort((x, y) => Number(changed(y)) - Number(changed(x)) || y.start - x.start);
      const turnDown: { clipId: string; volume: number }[] = [];
      let excess = s.after - s.before;
      for (const h of [quiet, ...rest]) {
        if (excess <= SAME_LEVEL) break;
        const by = Math.min(h.clip.volume, excess);
        turnDown.push({ clipId: h.clip.id, volume: Math.round((h.clip.volume - by) * 1e6) / 1e6 });
        excess -= by;
      }
      const overlap = { start: sourceToTimeline(p.a.clip, s.start), end: sourceToTimeline(p.a.clip, s.end) };
      return { mediaId: p.mediaId, clipIds: [p.a.clip.id, p.b.clip.id] as [string, string],
        // Exact seconds, so a split there leaves no sliver of either copy louder or turned down.
        overlap, source: { start: s.start, end: s.end },
        level: { before: round3(s.before), after: round3(s.after) },
        copies: s.copies.map(h => h.clip.id), turnDown };
    });
}

function sameCopies(a: readonly Heard[], b: readonly Heard[]) {
  return a.length === b.length && a.every(h => b.includes(h));
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
