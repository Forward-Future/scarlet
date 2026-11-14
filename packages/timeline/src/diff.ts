/**
 * Diff two timeline versions and compute the time ranges a viewer must
 * re-watch to see every difference. Those ranges drive partial re-renders
 * and the "change clips" in the review UI.
 */
import type { Clip, Timeline, TimeRange, Track } from "./schema.js";
import { clipEnd, timelineDuration } from "./time.js";
import { changedSpots, type ChangedSpot } from "./rebase.js";
import { stableStringify } from "./ids.js";

export type ClipDiff =
  | { type: "added"; trackId: string; clip: Clip }
  | { type: "removed"; trackId: string; clip: Clip }
  | { type: "modified"; trackId: string; before: Clip; after: Clip; fields: string[] }
  | { type: "movedTrack"; fromTrackId: string; toTrackId: string; before: Clip; after: Clip };

export type TrackDiff =
  | { type: "trackAdded"; track: Track }
  | { type: "trackRemoved"; track: Track }
  | { type: "trackModified"; trackId: string; fields: string[] };

export interface TimelineDiff {
  clips: ClipDiff[];
  tracks: TrackDiff[];
  markersChanged: boolean;
  timelineFieldsChanged: string[];
  /** Merged ranges on the *after* timeline where something looks or sounds different. */
  ranges: TimeRange[];
  /** The matching ranges on the *before* timeline, index for index with `ranges`. */
  beforeRanges: TimeRange[];
  /** ranges[i] paired with beforeRanges[i]. */
  spots: ChangedSpot[];
  /** Duration of each version. A duration change implies a ripple. */
  durationBefore: number;
  durationAfter: number;
}

function indexClips(tl: Timeline): Map<string, { trackId: string; clip: Clip }> {
  const m = new Map<string, { trackId: string; clip: Clip }>();
  for (const t of tl.tracks) for (const c of t.clips) m.set(c.id, { trackId: t.id, clip: c });
  return m;
}

function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (a[k] !== b[k] && stableStringify(a[k]) !== stableStringify(b[k])) out.push(k);
  }
  return out;
}

/** Compare the relative order of items present on both sides of the diff. */
function reorderedIds(before: Array<{ id: string }>, after: Array<{ id: string }>): string[] {
  const oldIds = new Set(before.map((x) => x.id));
  const newIds = new Set(after.map((x) => x.id));
  const oldOrder = before.filter((x) => newIds.has(x.id));
  return after.filter((x) => oldIds.has(x.id)).filter((x, i) => x.id !== oldOrder[i]?.id).map((x) => x.id);
}

export function diffTimelines(before: Timeline, after: Timeline, fps = 30): TimelineDiff {
  const a = indexClips(before);
  const b = indexClips(after);
  const clips: ClipDiff[] = [];

  for (const [id, { trackId, clip }] of a) {
    const nb = b.get(id);
    if (!nb) {
      clips.push({ type: "removed", trackId, clip });
      // On the after timeline, the removal is visible at the point where it was.
      continue;
    }
    if (nb.trackId !== trackId) {
      clips.push({ type: "movedTrack", fromTrackId: trackId, toTrackId: nb.trackId, before: clip, after: nb.clip });
      continue;
    }
    const fields = changedFields(clip as Record<string, unknown>, nb.clip as Record<string, unknown>);
    if (fields.length) {
      clips.push({ type: "modified", trackId, before: clip, after: nb.clip, fields });
    }
  }
  for (const [id, { trackId, clip }] of b) {
    if (!a.has(id)) {
      clips.push({ type: "added", trackId, clip });
    }
  }

  const tracks: TrackDiff[] = [];
  const ta = new Map(before.tracks.map((t) => [t.id, t]));
  const tb = new Map(after.tracks.map((t) => [t.id, t]));
  const reordered = new Set(reorderedIds(before.tracks, after.tracks));
  for (const [id, t] of ta) {
    const nt = tb.get(id);
    if (!nt) tracks.push({ type: "trackRemoved", track: t });
    else {
      const { clips: _a, ...ra } = t;
      const { clips: _b, ...rb } = nt;
      const fields = changedFields(ra as Record<string, unknown>, rb as Record<string, unknown>);
      if (reordered.has(id)) fields.push("track order");
      if (reorderedIds(t.clips, nt.clips).length) fields.push("clip order");
      if (fields.length) tracks.push({ type: "trackModified", trackId: id, fields });
    }
  }
  for (const [id, t] of tb) if (!ta.has(id)) tracks.push({ type: "trackAdded", track: t });

  const markersChanged = stableStringify(before.markers) !== stableStringify(after.markers);
  const { tracks: _t1, markers: _m1, version: _v1, parent: _p1, createdAt: _c1, ...fa } = before;
  const { tracks: _t2, markers: _m2, version: _v2, parent: _p2, createdAt: _c2, ...fb } = after;
  const timelineFieldsChanged = changedFields(fa as Record<string, unknown>, fb as Record<string, unknown>);

  const durationBefore = timelineDuration(before);
  const durationAfter = timelineDuration(after);

  const spots = changedSpots(before, after, { fps });

  return {
    clips,
    tracks,
    markersChanged,
    timelineFieldsChanged,
    ranges: spots.map((s) => s.after),
    beforeRanges: spots.map((s) => s.before),
    spots,
    durationBefore,
    durationAfter,
  };
}

/** Operations address clips by ID. Show that ID alongside any human-readable label in agent diffs. */
export const clipById = (clip: Clip): string => clip.label ? `${clip.id} “${clip.label}”` : clip.id;

/** Describe each change using the clip's label for editor-facing output. */
export function describeDiff(
  d: TimelineDiff,
  fmt: (s: number) => string = (s) => s.toFixed(2),
  name: (clip: Clip) => string = clip => clip.label ?? clip.id,
): string[] {
  const out: string[] = [];
  for (const c of d.clips) {
    switch (c.type) {
      case "added":
        out.push(`Added ${c.clip.kind} clip ${name(c.clip)} at ${fmt(c.clip.timelineIn)}`);
        break;
      case "removed":
        out.push(`Removed ${c.clip.kind} clip ${name(c.clip)} (${fmt(c.clip.timelineIn)}–${fmt(clipEnd(c.clip))})`);
        break;
      case "modified":
        out.push(`Changed ${c.fields.join(", ")} on ${name(c.after)} at ${fmt(c.after.timelineIn)}`);
        break;
      case "movedTrack":
        out.push(`Moved ${name(c.after)} to track ${c.toTrackId}`);
        break;
    }
  }
  for (const t of d.tracks) {
    if (t.type === "trackAdded") out.push(`Added track ${t.track.name}`);
    else if (t.type === "trackRemoved") out.push(`Removed track ${t.track.name}`);
    else out.push(`Changed ${t.fields.join(", ")} on track ${t.trackId}`);
  }
  for (const field of d.timelineFieldsChanged) out.push(`Changed timeline ${field}`);
  if (d.markersChanged) out.push("Markers changed");
  if (d.durationBefore !== d.durationAfter) {
    out.push(`Duration ${fmt(d.durationBefore)} → ${fmt(d.durationAfter)}`);
  }
  return out;
}
