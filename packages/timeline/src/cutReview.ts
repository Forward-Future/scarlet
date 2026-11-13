import { stableStringify } from "./ids.js";
import { intervalCandidates } from "./intervals.js";
import { applyOps } from "./ops.js";
import type { Change, MediaAsset, MediaClip, Timeline, TimeRange } from "./schema.js";
import { mergeRanges, timelineDuration, withHandles } from "./time.js";

/** Both coordinates are immutable: at is on the proposal, removed is on the original. */
export interface ReviewCut {
  at: number;
  removed: TimeRange;
  beforeClip: number;
}
export interface CutReview {
  original: Timeline;
  proposed: Timeline;
  cuts: ReviewCut[];
  firstCut: boolean;
  /** First cuts only: tracks holding a second recording synced to the first, by track id. */
  layers?: Record<string, SyncedSpan>;
}
/** Where a synced recording's footage lies on the first recording's clock: it has footage from start to end, and its own clock reads `offset` less. */
export interface SyncedSpan { offset: number; start: number; end: number }

const eps = 0.00001;

function omissions(keep: TimeRange[], duration: number): ReviewCut[] {
  const cuts: ReviewCut[] = [];
  let previous = 0, at = 0;
  for (let i = 0; i <= keep.length; i++) {
    const span = keep[i];
    const next = span?.start ?? duration;
    if (next > previous + eps) cuts.push({ at, removed: { start: previous, end: next }, beforeClip: i });
    if (span) {
      at += span.end - span.start;
      previous = span.end;
    }
  }
  return cuts;
}

/** The pieces of a synced recording that play under the kept ranges, cut where they are and absent where it has no footage. */
function layerPieces(keep: ReadonlyArray<{ start: number; end: number; at: number }>, span: SyncedSpan) {
  return keep.flatMap(k => {
    const from = Math.max(k.start, span.start), to = Math.min(k.end, span.end);
    return to - from > eps ? [{ from, to, sourceIn: from - span.offset, sourceOut: to - span.offset, timelineIn: k.at + from - k.start }] : [];
  });
}

/** Extend and join the existing synchronized clips so restoring speech removes the artificial fade at that seam. */
function restoreFirstCut(timeline: Timeline, restore: ReviewCut[], layers: Record<string, SyncedSpan> = {}): Timeline {
  const gaps = new Map(restore.map(c => [c.beforeClip, c.removed]));
  const tracks = timeline.tracks.map(track => {
    if (layers[track.id]) return track;
    const clips: MediaClip[] = [];
    let at = 0;
    for (const [i, kept] of (track.clips as MediaClip[]).entries()) {
      const gap = gaps.get(i);
      const previous = clips[clips.length - 1];
      const end = i === track.clips.length - 1 ? gaps.get(i + 1)?.end ?? kept.sourceOut : kept.sourceOut;
      if (previous && gap) {
        previous.sourceOut = end;
        previous.audioFadeOut = kept.audioFadeOut;
        previous.videoFadeOut = kept.videoFadeOut;
      } else {
        clips.push({ ...kept, sourceIn: gap?.start ?? kept.sourceIn, sourceOut: end, timelineIn: at });
      }
      const last = clips[clips.length - 1]!;
      at = last.timelineIn + last.sourceOut - last.sourceIn;
    }
    return { ...track, clips };
  });
  // A synced recording follows the first one: the same moments play, wherever it has footage for them.
  const first = tracks.find(t => t.kind === "video" && t.clips.length && !layers[t.id]);
  const keep = ((first?.clips ?? []) as MediaClip[]).map(c => ({ start: c.sourceIn, end: c.sourceOut, at: c.timelineIn }));
  return { ...timeline, tracks: tracks.map(track => {
    const span = layers[track.id];
    if (!span) return track;
    const old = track.clips as MediaClip[];
    const clips = layerPieces(keep, span).map((piece, i) => {
      // Reuse the clips already there, so a restored stretch keeps its identity and the fades at its outer edges.
      const inside = old.filter(c => c.sourceIn >= piece.sourceIn - eps && c.sourceOut <= piece.sourceOut + eps);
      const head = inside[0], tail = inside[inside.length - 1];
      const { label, ...shape } = head ?? old[0]!;
      return { ...shape, ...(head ? { label } : { id: "review_" + track.id + "_" + i }), sourceIn: piece.sourceIn, sourceOut: piece.sourceOut, timelineIn: piece.timelineIn,
        ...(tail && { audioFadeOut: tail.audioFadeOut, videoFadeOut: tail.videoFadeOut }) };
    });
    return { ...track, clips };
  }) };
}

export function planCutReview(base: Timeline, proposed: Timeline, media: MediaAsset[], ops?: Change["ops"], firstCut = false): CutReview | null {
  const duration = timelineDuration(base);
  if (!timelineDuration(proposed)) return null;
  if (ops?.length) {
    // Each ripple operation is expressed in the cut left by the previous operation.
    let keep: TimeRange[] = [{ start: 0, end: duration }];
    for (const op of ops) {
      if (op.op !== "rippleDelete" || op.trackIds !== undefined || typeof op.start !== "number" || typeof op.end !== "number") return null;
      const { start, end } = op;
      let cursor = 0;
      const remaining: TimeRange[] = [];
      for (const range of keep) {
        const length = range.end - range.start;
        if (cursor + length <= start || cursor >= end) remaining.push(range);
        else {
          if (start > cursor) remaining.push({ start: range.start, end: range.start + start - cursor });
          if (end < cursor + length) remaining.push({ start: range.start + end - cursor, end: range.end });
        }
        cursor += length;
      }
      if (end > cursor + eps) return null;
      keep = remaining;
    }
    const cuts = omissions(keep, duration);
    return cuts.length ? { original: base, proposed, cuts, firstCut: false } : null;
  }
  // Recognize existing chronological first cuts as well as newly proposed ones.
  // Overlays, overlapping takes and edited clip properties need ordinary change review.
  if (proposed.markers.length) return null;
  const populated = proposed.tracks.filter(t => t.clips.length);
  const video = populated.find(t => t.kind === "video");
  if (!video || populated.some(t => t.kind !== "video" && t.kind !== "audio")) return null;
  const keep: Array<TimeRange & { at: number }> = [];
  let cursor = 0, previous = 0;
  for (const c of video.clips) {
    if (c.kind !== "media" || c.sourceIn < previous - eps || Math.abs(c.timelineIn - cursor) > eps || c.sourceOut <= c.sourceIn) return null;
    keep.push({ start: c.sourceIn, end: c.sourceOut, at: cursor });
    cursor += c.sourceOut - c.sourceIn;
    previous = c.sourceOut;
  }
  const firstMedia = (video.clips[0] as MediaClip).mediaId;
  let sourceDuration = Infinity;
  const layers: Record<string, SyncedSpan> = {};
  for (const track of populated) {
    let shape: string | undefined;
    for (const c of track.clips) {
      if (c.kind !== "media" || !c.enabled || c.speed !== 1 || c.keyframes?.length || c.effects.length) return null;
      const { id, label, timelineIn, sourceIn, sourceOut, ...settings } = c;
      const key = stableStringify(settings);
      if (shape !== undefined && shape !== key) return null;
      shape = key;
    }
    const first = track.clips[0] as MediaClip;
    const length = media.find(m => m.id === first.mediaId)?.duration;
    if (!length) return null;
    // A recording on its own clock: the first recording reads `offset` more than it at every moment they share.
    const under = keep.findLast(k => k.at <= first.timelineIn + eps);
    const offset = under ? under.start + first.timelineIn - under.at - first.sourceIn : 0;
    if (track !== video && first.mediaId !== firstMedia && Math.abs(offset) > eps) {
      // It plays the same moments as the first recording, in full wherever it has footage for them.
      const span = { offset, start: Math.max(0, offset), end: offset + length };
      const pieces = layerPieces(keep, span);
      if (pieces.length !== track.clips.length) return null;
      for (const [i, c] of (track.clips as MediaClip[]).entries()) {
        const piece = pieces[i]!;
        if (Math.abs(c.sourceIn - piece.sourceIn) > eps || Math.abs(c.sourceOut - piece.sourceOut) > eps || Math.abs(c.timelineIn - piece.timelineIn) > eps) return null;
      }
      layers[track.id] = span;
      continue;
    }
    if (track.clips.length !== keep.length) return null;
    for (const [i, c] of (track.clips as MediaClip[]).entries()) {
      if (Math.abs(c.sourceIn - keep[i]!.start) > eps || Math.abs(c.sourceOut - keep[i]!.end) > eps ||
          Math.abs(c.timelineIn - video.clips[i]!.timelineIn) > eps) return null;
    }
    if (length < previous - eps) return null;
    sourceDuration = Math.min(sourceDuration, length);
  }
  const cuts = omissions(keep, sourceDuration);
  if (!cuts.length) return null;
  const synced = Object.keys(layers).length ? layers : undefined;
  const original = restoreFirstCut(proposed, cuts, synced);
  if (duration && !firstCut) {
    const rawVideo = base.tracks.find(t => t.kind === "video")?.clips;
    const raw = rawVideo?.[0];
    if (rawVideo?.length !== 1 || raw?.kind !== "media" || raw.mediaId !== (video.clips[0] as MediaClip).mediaId ||
        raw.sourceIn !== 0 || raw.timelineIn !== 0 || Math.abs(raw.sourceOut - sourceDuration) > eps ||
        Math.abs(duration - sourceDuration) > eps || base.markers.length ||
        base.tracks.some(t => t.clips.length && (t.kind !== "video" || t.clips !== rawVideo))) return null;
  }
  return { original, proposed, cuts, firstCut: true, ...(synced && { layers: synced }) };
}

export function canStartCutReview(change: Change): boolean {
  return change.state === "ready" && (!change.ops?.length || change.ops.every(op => op.op === "rippleDelete" && op.trackIds === undefined));
}

/** Restored source shifts the remaining joins on the approved cut. Preserve the proposed coordinates for Undo. */
export function appliedCutReview(review: CutReview, restored: number[]): NonNullable<Change["appliedReview"]> {
  const indices = new Set(restored);
  let shift = 0;
  const joins = review.cuts.flatMap((cut, i) => {
    if (!indices.has(i)) return [{ at: cut.at + shift, removed: cut.removed }];
    shift += cut.removed.end - cut.removed.start;
    return [];
  });
  return { originalVersion: review.original.version, joins, originalDuration: timelineDuration(review.original), duration: timelineDuration(review.proposed) + shift };
}

export function appliedReviewChange(change: Change): Change {
  const review = change.appliedReview;
  if (change.state !== "approved" || !change.appliedVersion) return change;
  if (!review) {
    if (!change.appliedWindows || !change.appliedOnto) return change;
    return { ...change, fromVersion: change.appliedOnto, toVersion: change.appliedVersion,
      ranges: change.appliedWindows.map(w => w.spot),
      renders: change.appliedWindows.map(w => ({ range: w.range, beforeRange: w.beforeRange, before: null, after: null })) };
  }
  const ranges = review.joins.map(({ at }) => ({ start: at, end: at }));
  return { ...change, fromVersion: review.originalVersion, toVersion: change.appliedVersion, ranges,
    renders: review.joins.map((join, i) => ({ before: null, after: null, beforeRange: withHandles(join.removed, 2, review.originalDuration), range: withHandles(ranges[i]!, 2, review.duration) })) };
}

export function reviewedTimeline(review: CutReview, restored: number[]): Timeline {
  const indices = new Set(restored);
  if (indices.size !== restored.length || restored.some(i => !Number.isInteger(i) || i < 0 || i >= review.cuts.length)) {
    throw new Error("Unknown or duplicate cut in review");
  }
  if (!indices.size) return review.proposed;
  if (indices.size === review.cuts.length) return review.original;
  if (review.firstCut) return restoreFirstCut(review.proposed, restored.map(i => review.cuts[i]!), review.layers);
  const kept = review.cuts.filter((_, i) => !indices.has(i));
  return applyReviewRemovals(review.original, kept.map(c => c.removed), review.proposed.version);
}

/** Remove ordered, nonoverlapping ranges with repeatable clip identities for preview, approval and reopen. */
export function applyReviewRemovals(original: Timeline, ranges: readonly TimeRange[], reviewId: string): Timeline {
  if (!ranges.length) return original;
  const result = applyOps(original, [...ranges].reverse().map(r => ({ op: "rippleDelete", ...r })));
  // A retry or a preview of the same choices must produce the same immutable version.
  const originalIds = new Set(original.tracks.flatMap(t => t.clips.map(c => c.id)));
  for (const track of result.tracks) for (const [i, clip] of track.clips.entries()) {
    if (!originalIds.has(clip.id)) {
      let id = "review_" + reviewId + "_" + track.id + "_" + i;
      while (originalIds.has(id)) id += "_";
      clip.id = id;
    }
  }
  return result;
}

const legacyPrefix = "Optional dialogue cuts · ";

export function describeDialogueRemovals(cuts: readonly TimeRange[]): string {
  const seconds = cuts.reduce((total, cut) => total + cut.end - cut.start, 0);
  const duration = Number(seconds.toFixed(2));
  if (cuts.length === 1) {
    const at = Math.floor(cuts[0]!.start);
    return `Removed ${duration} s at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}.`;
  }
  return `Removed ${duration} s across ${cuts.length} cuts.`;
}

const dialogueChangeId = /^chg_[a-f0-9]{64}_(applied|review)$/;

/** Older dialogue batches saved the description of the entire requested plan on the applied subset.
 * A part that a later part of the same run replaced has no receipt of its own. */
export function dialogueReceipt(change: Change): string | undefined {
  if (!dialogueChangeId.test(change.id) || change.replacedBy) return;
  if (change.state === "ready") return "Dialogue cuts are pending review.";
  if (change.state === "rejected") return "The dialogue proposal was rejected.";
  if (change.state === "revising") return "The dialogue proposal is being revised.";
  if (change.state === "failed") return "The dialogue preview failed.";
  if (change.state !== "approved") return;
  if (change.appliedReview && !change.appliedReview.joins.length) return "Kept all the reviewed footage.";
  const cuts = dialogueRemovals(change);
  return cuts ? describeDialogueRemovals(cuts) : "Applied the reviewed dialogue edit.";
}

/** The footage an applied dialogue change removed, when its receipt counts it. */
export function dialogueRemovals(change: Change): TimeRange[] | undefined {
  if (!dialogueChangeId.test(change.id) || change.state !== "approved") return;
  if (change.appliedReview) return change.appliedReview.joins.length ? change.appliedReview.joins.map(j => j.removed) : undefined;
  const cuts = change.ops?.flatMap(op => op.op === "rippleDelete" && typeof op.start === "number" && typeof op.end === "number"
    ? [{ start: op.start, end: op.end }] : []);
  return cuts?.length && cuts.length === change.ops?.length && !change.approvedSpots && !change.appliedWindows ? cuts : undefined;
}

export function cutSummary(description: string) {
  return description.startsWith(legacyPrefix) ? "Optional dialogue cuts are ready to review." : description;
}

/** Older engines put all reasons in one string. Recover the original ops' exact
 * starts from the rounded labels before associating them with coalesced cuts. */
export function reviewReasons(change: Pick<Change, "cutReasons" | "ops" | "description">, cuts: ReadonlyArray<Pick<ReviewCut, "removed"> & { reviewIndex?: number }>) {
  let items = change.cutReasons;
  if (!items && change.description.startsWith(legacyPrefix)) {
    const ops = (change.ops ?? []).filter(op => op.op === "rippleDelete" && typeof op.start === "number" && typeof op.end === "number")
      .sort((a, b) => Number(a.start) - Number(b.start));
    const parts = change.description.slice(legacyPrefix.length).split(/ · (?=\d+(?:\.\d+)? s: )/);
    items = parts.flatMap((part, index) => {
      const match = /^(\d+(?:\.\d+)?) s: ([\s\S]+)$/.exec(part);
      if (!match) return [];
      const op = ops[index];
      const rounded = Number(match[1]);
      const start = op && Math.abs(Number(op.start) - rounded) < 0.005001 ? Number(op.start) : rounded;
      return [{ start, end: start, reason: match[2]! }];
    });
  }
  if (!items) return cuts.map(() => change.description ? [change.description] : []);
  const reasons = items;
  const candidates = cuts.length > 1 ? intervalCandidates(reasons, r => r.start, r => r.start) : () => reasons;
  const original = cuts.some(c => c.reviewIndex !== undefined) ? mergeRanges(reasons, eps) : [];
  return cuts.map(c => {
    const removed = c.reviewIndex === undefined ? c.removed : original[c.reviewIndex] ?? c.removed;
    const start = removed.start - eps;
    return [...new Set(candidates(start, removed.end).filter(r => r.start >= start && r.start < removed.end)
      .map(r => r.reason).filter(Boolean))];
  });
}
