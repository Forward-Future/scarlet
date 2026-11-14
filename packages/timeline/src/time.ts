import type { Clip, MediaClip, Project, Timeline, TimeRange, Track } from "./schema.js";

export function clipDuration(clip: Clip): number {
  if (clip.kind === "media") {
    return Math.max(0, (clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1));
  }
  return Math.max(0, clip.timelineOut - clip.timelineIn);
}

export function clipEnd(clip: Clip): number {
  return clip.timelineIn + clipDuration(clip);
}

export function clipRange(clip: Clip): TimeRange {
  return { start: clip.timelineIn, end: clipEnd(clip) };
}

export function trackDuration(track: Track): number {
  let end = 0;
  for (const c of track.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function timelineDuration(timeline: Timeline): number {
  let end = 0;
  for (const t of timeline.tracks) end = Math.max(end, trackDuration(t));
  return end;
}

/** A day of edited program and at most 50,000 source anchors or render sections per plan. */
export const MAX_TIMELINE_SECONDS = 24 * 60 * 60;
const MAX_PLAN_ENTRIES = 50_000;
export class TimelinePlanningError extends RangeError {}
const durationLimit = "A Scarlet timeline can be up to 24 hours long.";
const planLimit = "This timeline needs too many playback sections. Split it into shorter timelines.";
const hasFootage = (track: Track) => track.clips.some(c => c.kind === "media" && c.enabled !== false);
function mainFootage(timeline: Timeline) {
  return timeline.tracks.find(t => t.kind === "video" && hasFootage(t)) ?? timeline.tracks.find(t => t.kind === "audio" && hasFootage(t));
}

function sourceAnchorIssue(track: Track | undefined, seconds: number, limit: number): string | undefined {
  let total = 0;
  for (const clip of track?.clips ?? []) {
    if (clip.kind !== "media" || clip.enabled === false) continue;
    const first = Math.floor(clip.sourceIn / seconds) + 1;
    const stop = Math.ceil(clip.sourceOut / seconds);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(stop)) return planLimit;
    total += Math.max(0, stop - first);
    if (total > limit) return planLimit;
  }
}

export function timelinePlanningIssue(timeline: Timeline): string | undefined {
  const duration = timelineDuration(timeline);
  if (!Number.isFinite(duration) || duration > MAX_TIMELINE_SECONDS) return durationLimit;
  return sourceAnchorIssue(mainFootage(timeline), 4, MAX_PLAN_ENTRIES);
}

/** Snap a time in seconds to the nearest frame boundary. */
export function snapToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps) / fps;
}

/** Map a timeline time inside a media clip to a source time. */
export function timelineToSource(clip: MediaClip, t: number): number {
  const rel = Math.max(0, t - clip.timelineIn);
  return clip.sourceIn + rel * (clip.speed ?? 1);
}

/** Merge overlapping/adjacent ranges. */
export function mergeRanges(ranges: TimeRange[], gap = 0): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function clampRange(r: TimeRange, min: number, max: number): TimeRange {
  const clamp = (t: number) => Math.min(max, Math.max(min, t));
  return { start: clamp(r.start), end: clamp(r.end) };
}

/** Expand a range by `handle` seconds on each side, clamped to [0, max]. */
export function withHandles(r: TimeRange, handle: number, max: number): TimeRange {
  return clampRange({ start: r.start - handle, end: r.end + handle }, 0, max);
}

/** All clips (with their track) that intersect a time. */
export function clipsAt(timeline: Timeline, t: number): Array<{ track: Track; clip: Clip }> {
  const out: Array<{ track: Track; clip: Clip }> = [];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.timelineIn <= t && t < clipEnd(clip)) out.push({ track, clip });
    }
  }
  return out;
}

export function formatTimecode(seconds: number, fps = 30): string {
  // A frame-aligned time such as 69 / 30 can land a few ulps below its frame; floor would show the frame before.
  const total = Math.max(0, seconds) + 1e-6;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * fps);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(f)}` : `${m}:${pad(s)}.${pad(f)}`;
}

/** Where something is in the video, for people, to the second: 0:05, 1:02:07. Minutes alone would read 62:07 past an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/**
 * Split the timeline into render segments of roughly `segmentSeconds`,
 * preferring to cut at a clip boundary in the second half of each segment.
 * A short tail (< half a segment) is merged into the previous segment.
 */
export function planSegments(project: Pick<Project, "settings">, timeline: Timeline, segmentSeconds = 10, programSeconds = timelineDuration(timeline),
  anchors?: number[]): TimeRange[] {
  const fps = project.settings.fps;
  if (!Number.isFinite(programSeconds) || programSeconds > MAX_TIMELINE_SECONDS) throw new TimelinePlanningError(durationLimit);
  if (!(fps > 0 && Number.isFinite(fps) && Number.isFinite(segmentSeconds))) throw new TimelinePlanningError(planLimit);
  const total = snapToFrame(programSeconds, fps);
  if (!(total > 0)) return [];
  const seg = Math.max(1 / fps, segmentSeconds);
  if (!Number.isFinite(total) || total / seg > MAX_PLAN_ENTRIES || (anchors?.length ?? 0) > MAX_PLAN_ENTRIES) throw new TimelinePlanningError(planLimit);

  const boundaries = new Set<number>();
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const r = clipRange(clip);
      for (const t of [r.start, r.end]) {
        const s = snapToFrame(t, fps);
        if (s > 0 && s < total) boundaries.add(s);
      }
    }
  }
  for (const t of anchors ?? []) {
    const s = snapToFrame(t, fps);
    if (s > 0 && s < total) boundaries.add(s);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const out: TimeRange[] = [];
  const minLen = seg / 2;
  let start = 0;
  let nextBoundary = 0;
  while (start < total) {
    if (out.length >= MAX_PLAN_ENTRIES) throw new TimelinePlanningError(planLimit);
    const target = start + seg;
    if (target >= total - minLen) {
      out.push({ start, end: total });
      break;
    }
    let cut = snapToFrame(target, fps);
    let found = false;
    while (nextBoundary < sorted.length && sorted[nextBoundary]! <= target) {
      const boundary = sorted[nextBoundary++]!;
      if (boundary > start + minLen) { cut = boundary; found = true; }
    }
    // With anchors, a section runs a little long rather than leave the grid: the next anchor is never more than a section away.
    if (anchors && !found && nextBoundary < sorted.length && sorted[nextBoundary]! <= start + seg * 1.5 && sorted[nextBoundary]! < total - minLen) {
      cut = sorted[nextBoundary++]!;
    }
    if (!(cut > start)) throw new TimelinePlanningError(planLimit);
    out.push({ start, end: cut });
    start = cut;
  }
  return out;
}

/**
 * Where the main picture's source clock crosses whole multiples of `seconds`, in timeline seconds. The main picture
 * is the first video track with footage, else the first audio track. A cut moves everything after it on the timeline but
 * not on the source clock, so sections placed here cover the same footage before and after the cut.
 */
export function sourceClockAnchors(timeline: Timeline, seconds: number, limit = MAX_PLAN_ENTRIES): number[] {
  // Track order, not the amount of footage: a cut can change which track holds more, and the grid must not jump.
  const main = mainFootage(timeline);
  if (!main) return [];
  if (!(seconds > 0 && Number.isFinite(seconds))) throw new TimelinePlanningError(planLimit);
  const issue = sourceAnchorIssue(main, seconds, Math.min(limit, MAX_PLAN_ENTRIES));
  if (issue) throw new TimelinePlanningError(issue);
  const out: number[] = [];
  for (const clip of main.clips) {
    if (clip.kind !== "media" || clip.enabled === false) continue;
    const speed = clip.speed || 1;
    const end = clipEnd(clip);
    const stop = Math.ceil(clip.sourceOut / seconds);
    for (let k = Math.floor(clip.sourceIn / seconds) + 1; k < stop; k++) {
      const t = clip.timelineIn + (k * seconds - clip.sourceIn) / speed;
      if (t >= end) break;
      if (t > clip.timelineIn) out.push(t);
    }
  }
  return out;
}

/**
 * Shared by the cut player, the playback endpoint and the background preview encoder. Sections of about 4 s start
 * where the main picture's source clock crosses a multiple of 4 s, so approving a cut re-renders only the sections
 * around it: the ones after it cover the same footage as before and keep their cached renders.
 */
export function planPlaybackSegments(project: Pick<Project, "settings">, timeline: Timeline): TimeRange[] {
  const duration = timelineDuration(timeline);
  if (!Number.isFinite(duration) || duration > MAX_TIMELINE_SECONDS) throw new TimelinePlanningError(durationLimit);
  return planSegments(project, timeline, 4, duration, sourceClockAnchors(timeline, 4));
}

/** Bound simultaneous decoders when sampling distant frames in a cached preview. */
export const FILMSTRIP_SEEK_BATCH = 4;
export function sparseFilmstrip(frames: number[], fps: number) {
  return frames.length > 1 && frames.at(-1)! - frames[0]! >= (frames.length - 1) * fps * 3;
}

export function filmstripBatches(frames: number[], fps: number) {
  // The preview endpoint accepts up to 20 frames per sheet, including on wider timelines.
  const size = new Set(frames).size < frames.length ? 1
    : sparseFilmstrip(frames, fps) ? FILMSTRIP_SEEK_BATCH : 20;
  const batches: number[][] = [];
  for (let i = 0; i < frames.length; i += size) batches.push(frames.slice(i, i + size));
  return batches;
}

/** How near a frame an edge counts as on it, in seconds. */
const FRAME_SLACK = 0.001;

/** A time within a millisecond of a frame is that frame. Any other time is returned as it is. */
export function onFrame(t: number, fps: number): number {
  const frame = Math.round(t * fps) / fps;
  return Math.abs(frame - t) <= FRAME_SLACK ? frame : t;
}

/**
 * A cut on whole frames of the timeline: edges move inward, at most one frame each; a cut under a frame rounds to the nearest.
 * An edge within a millisecond of a frame is on it. Times reach an agent rounded to the millisecond, and a frame at
 * 30 fps is a repeating decimal: an end given as 122.333 for frame 3,670 used to round inward a whole frame, and the
 * frame left behind cost a pass a minute to find and cut.
 */
export function frameAligned<R extends { start: number; end: number }>(r: R, fps: number): { start: number; end: number } {
  const start = Math.ceil((r.start - FRAME_SLACK) * fps) / fps, end = Math.floor((r.end + FRAME_SLACK) * fps) / fps;
  if (end > start) return { start, end };
  const near = { start: Math.round(r.start * fps) / fps, end: Math.round(r.end * fps) / fps };
  return near.end > near.start ? near : { start: r.start, end: r.end };
}

/** Align a validated removal while keeping the selection edges and each explicitly retained interval intact. */
export function frameAlignedRemoval(r: TimeRange, fps: number, scope?: TimeRange, kept: readonly TimeRange[] = []): TimeRange {
  const aligned = frameAligned(r, fps);
  let from = scope?.start ?? 0, to = scope?.end ?? Infinity;
  for (const k of kept) {
    if (k.end <= r.start) from = Math.max(from, k.end);
    if (k.start >= r.end) to = Math.min(to, k.start);
  }
  const start = aligned.start < from ? Math.ceil(from * fps) / fps : aligned.start;
  const end = aligned.end > to ? Math.floor(to * fps) / fps : aligned.end;
  // A sub-frame request may have no pair of frame edges inside its limits.
  return end > start ? { start, end } : { start: r.start, end: r.end };
}
