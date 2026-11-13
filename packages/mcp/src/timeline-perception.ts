/**
 * Perception of an edited timeline: what plays in order, where the joins are and how each join
 * sounds. Everything here is measured and deterministic, so a model that cannot hear audio can
 * still verify its own edit. Scarlet reports; the model decides.
 */
import { clipDuration, formatTimecode, type MediaClip, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { normalizeTranscriptToken } from "@scarlet/shared";
import { captionSourceClips, dbfs, wordsByMidpoint } from "./analysis.js";

// ---------------------------------------------------------------------------
// Joins and time mapping
// ---------------------------------------------------------------------------

export interface JoinSide { trackId: string; clipId: string; mediaId: string; /** Source seconds at the edge. */ source: number }
/** A discontinuity on one track: the outgoing source stops and another source position starts. */
export interface TrackJoin {
  trackId: string; out: JoinSide; in: JoinSide;
  outClip?: Pick<MediaClip, "sourceIn" | "speed"> & { joinSource: number };
  /** Seconds of empty timeline between them. */ gap?: number;
  /** Seconds the two clips overlap in an audio crossfade; out/in are then the ends of the faded handles. */ overlap?: number;
}
/** `at` is where the incoming material takes over: its first frame, or the center of a crossfade. */
export interface TimelineJoin { at: number; tracks: TrackJoin[] }

const eps = 1e-4;
/** A longer overlap, or one clip inside another, is a layer rather than a crossfaded cut. */
export const MAX_CROSSFADE = 1;

function audible(project: Project | undefined, clip: MediaClip, muted: boolean) {
  if (muted || !clip.enabled || clip.volume <= 0) return false;
  const asset = project?.media.find(m => m.id === clip.mediaId);
  return !asset || asset.kind === "audio" || asset.hasAudio !== false;
}

/** Every join between kept source ranges on the audible tracks, in playback order. */
export function timelineJoins(tl: Timeline, project?: Project): TimelineJoin[] {
  const found: Array<TrackJoin & { at: number }> = [];
  for (const track of tl.tracks) {
    if (track.kind === "caption") continue;
    const clips = track.clips.filter((c): c is MediaClip => c.kind === "media" && audible(project, c, track.muted))
      .sort((a, b) => a.timelineIn - b.timelineIn);
    for (let i = 1; i < clips.length; i++) {
      const a = clips[i - 1]!, b = clips[i]!;
      const end = a.timelineIn + clipDuration(a);
      const gap = b.timelineIn - end;
      // A short overlap where the second clip outlasts the first is a crossfaded cut; anything else is a layer.
      const crossfade = gap < -eps && -gap <= MAX_CROSSFADE && b.timelineIn + clipDuration(b) > end;
      if (gap < -eps && !crossfade) continue;
      if (gap <= eps && a.mediaId === b.mediaId && Math.abs(a.sourceOut - b.sourceIn) < 1e-3) continue; // a split, not a cut
      found.push({ at: crossfade ? round((b.timelineIn + end) / 2) : b.timelineIn, trackId: track.id,
        ...(gap > eps && { gap: round(gap) }), ...(crossfade && { overlap: round(-gap) }),
        outClip: { sourceIn: a.sourceIn, speed: a.speed, joinSource: crossfade ? a.sourceOut + gap / 2 * a.speed : a.sourceOut },
        out: { trackId: track.id, clipId: a.id, mediaId: a.mediaId, source: a.sourceOut },
        in: { trackId: track.id, clipId: b.id, mediaId: b.mediaId, source: b.sourceIn } });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const joins: TimelineJoin[] = [];
  for (const { at, ...join } of found) {
    const last = joins.at(-1);
    if (last && Math.abs(last.at - at) < 1e-3) last.tracks.push(join);
    else joins.push({ at, tracks: [join] });
  }
  return joins;
}

const joinKey = (j: TrackJoin) => JSON.stringify([j.out.mediaId, round(j.out.source), j.in.mediaId, round(j.in.source)]);

/** Joins on `after` that `before` does not already have: the joins a change created. */
export function newJoins(before: Timeline, after: Timeline, project?: Project): TimelineJoin[] {
  const old = new Set(timelineJoins(before, project).flatMap(j => j.tracks.map(joinKey)));
  return timelineJoins(after, project).flatMap(j => {
    const tracks = j.tracks.filter(t => !old.has(joinKey(t)));
    return tracks.length ? [{ at: j.at, tracks }] : [];
  });
}

export interface Placement { trackId: string; clipId: string; time: number; audible: boolean }

/** Every timeline position where a source instant plays (none if it was cut). */
export function sourceToTimeline(tl: Timeline, mediaId: string, t: number): Placement[] {
  const out: Placement[] = [];
  for (const track of tl.tracks) for (const clip of track.clips) {
    if (clip.kind !== "media" || clip.mediaId !== mediaId || t < clip.sourceIn - eps || t > clip.sourceOut + eps) continue;
    out.push({ trackId: track.id, clipId: clip.id, time: round(clip.timelineIn + (t - clip.sourceIn) / (clip.speed ?? 1)),
      audible: track.kind !== "caption" && audible(undefined, clip, track.muted) });
  }
  return out.sort((a, b) => a.time - b.time);
}

export interface RangePlacement extends TimeRange { source: TimeRange; trackIds: string[] }

/** Where a source range plays on the timeline, split by clip, plus the source portions no longer in the edit. */
export function sourceRangeToTimeline(tl: Timeline, mediaId: string, from: number, to: number) {
  const byRange = new Map<string, RangePlacement>();
  for (const track of tl.tracks) for (const clip of track.clips) {
    if (clip.kind !== "media" || clip.mediaId !== mediaId) continue;
    const s = Math.max(from, clip.sourceIn), e = Math.min(to, clip.sourceOut);
    if (e <= s + eps) continue;
    const speed = clip.speed ?? 1;
    const range = { start: round(clip.timelineIn + (s - clip.sourceIn) / speed), end: round(clip.timelineIn + (e - clip.sourceIn) / speed) };
    const key = JSON.stringify(range);
    const hit = byRange.get(key);
    if (hit) hit.trackIds.push(track.id);
    else byRange.set(key, { ...range, source: { start: round(s), end: round(e) }, trackIds: [track.id] });
  }
  const placed = [...byRange.values()].sort((a, b) => a.start - b.start);
  const covered = placed.map(p => p.source).sort((a, b) => a.start - b.start);
  const missing: TimeRange[] = [];
  let cursor = from;
  for (const c of covered) {
    if (c.start > cursor + 1e-3) missing.push({ start: round(cursor), end: round(c.start) });
    cursor = Math.max(cursor, c.end);
  }
  if (to > cursor + 1e-3) missing.push({ start: round(cursor), end: round(to) });
  return { placed, missing };
}

// ---------------------------------------------------------------------------
// Words in playback order
// ---------------------------------------------------------------------------

/** A transcript word placed on the timeline. `index` is its stable index in transcript_get for `mediaId`. */
export interface TimelineWord { mediaId: string; index: number; text: string; start: number; end: number; speaker?: string }

/** Words heard on a version, in playback order. `transcripts` holds each media's words in transcript_get order. */
export function timelineWords(tl: Timeline, transcripts: Map<string, TranscriptWord[]>, range?: TimeRange): TimelineWord[] {
  const clips = captionSourceClips(tl, id => transcripts.has(id));
  const out: TimelineWord[] = [];
  // A long pass leaves hundreds of clips per recording. Index each recording once instead of scanning it per clip.
  const indexes = new Map<string, ReturnType<typeof wordsByMidpoint>>();
  for (const clip of clips) {
    const words = transcripts.get(clip.mediaId)!;
    const speed = clip.speed ?? 1;
    let inClip = indexes.get(clip.mediaId);
    if (!inClip) indexes.set(clip.mediaId, inClip = wordsByMidpoint(words));
    // A word belongs to the clip that keeps its midpoint, the same rule captions use.
    for (const index of inClip(clip.sourceIn, clip.sourceOut)) {
      const w = words[index]!;
      const start = round(clip.timelineIn + Math.max(0, w.start - clip.sourceIn) / speed);
      const end = round(clip.timelineIn + Math.min(clip.sourceOut - clip.sourceIn, w.end - clip.sourceIn) / speed);
      if (range && (end < range.start || start > range.end)) continue;
      out.push({ mediaId: clip.mediaId, index, text: w.text.trim(), start, end: Math.max(start, end), ...(w.speaker && { speaker: w.speaker }) });
    }
  }
  out.sort((a, b) => a.start - b.start);
  // Two transcribed mics of one voice read the same word twice.
  return out.filter((w, i) => !out.slice(Math.max(0, i - 3), i).some(p => Math.abs(p.start - w.start) < .03 &&
    normalizeTranscriptToken(p.text) === normalizeTranscriptToken(w.text)));
}

/**
 * Compact playback-order transcript. `lines` groups words between joins and pauses; `words` lists
 * each word with its index and timeline times. Join lines show the source jump and the words
 * either side, so a cut reads like the audience hears it. With `all`, the edit's whole list that
 * `joins` was taken from, a join keeps its number among them, the one timeline_join_audit gives it.
 */
export function formatTimelineTranscript(words: TimelineWord[], joins: TimelineJoin[],
  opts: { detail: "lines" | "words"; fps: number; pause?: number; all?: TimelineJoin[] }) {
  const pause = opts.pause ?? .6;
  const lines: string[] = [];
  let j = 0, line: TimelineWord[] = [];
  const flush = () => {
    if (!line.length) return;
    const head = line[0]!, who = line.find(w => w.speaker)?.speaker;
    lines.push(`${head.start.toFixed(2)} #${head.index}${who ? ` ${who}:` : ""} ${line.map(w => w.text).join(" ")}`);
    line = [];
  };
  const joinLine = (join: TimelineJoin, before?: TimelineWord, after?: TimelineWord) => {
    const t = join.tracks[0]!;
    const jump = t.out.mediaId === t.in.mediaId ? `${t.out.mediaId} ${t.out.source.toFixed(2)}→${t.in.source.toFixed(2)}`
      : `${t.out.mediaId} ${t.out.source.toFixed(2)}→${t.in.mediaId} ${t.in.source.toFixed(2)}`;
    const either = `“${before?.text ?? "…"}” | “${after?.text ?? "…"}”`;
    return `‖ join ${(opts.all ?? joins).indexOf(join) + 1} at ${join.at.toFixed(2)} (${formatTimecode(join.at, opts.fps)}) ${jump}${t.gap ? ` gap ${t.gap} s` : ""}${t.overlap ? ` crossfade ${t.overlap} s` : ""} ${either}`;
  };
  let previous: TimelineWord | undefined;
  for (const w of words) {
    while (j < joins.length && joins[j]!.at <= w.start + 1e-3) {
      flush();
      lines.push(joinLine(joins[j]!, previous, w));
      j++;
    }
    const gap = previous ? w.start - previous.end : 0;
    if (opts.detail === "words") {
      if (previous && gap >= pause) lines.push(`  (${gap.toFixed(2)} s)`);
      lines.push(`${w.start.toFixed(2)}-${w.end.toFixed(2)} #${w.index}${w.speaker && w.speaker !== previous?.speaker ? ` ${w.speaker}:` : ""} ${w.text}`);
    } else {
      // Word-level speaker labels flicker on a shared mic; a new line needs a real handoff (a speaker change at a gap).
      const last = line.at(-1);
      const handoff = !!last && w.speaker !== undefined && last.speaker !== undefined && w.speaker !== last.speaker && gap >= .3;
      if (line.length && (gap >= pause || line.length >= 14 || handoff)) {
        flush();
        if (gap >= pause) lines.push(`  (${gap.toFixed(2)} s)`);
      }
      line.push(w);
      if (/[.?!]["”’)]*$/.test(w.text)) flush();
    }
    previous = w;
  }
  flush();
  for (; j < joins.length; j++) lines.push(joinLine(joins[j]!, previous));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Join audit
// ---------------------------------------------------------------------------

/** One measured source window: RMS and peaks 0..1 per bucket, and voice activity. */
export interface Reading { from: number; to: number; peaks: number[]; rms?: number[]; speechActivity?: TimeRange[] }

/** Same thresholds as dialogue_check_join's quiet runs: low RMS, low peak and no detected voice. */
export const QUIET_RMS = .01, QUIET_PEAK = .05;
/** Less air than this after the last kept word usually clips its decay or the breath. */
export const MIN_AIR_AFTER = .06;
/** Less air than this before kept speech resumes usually clips the onset. */
export const MIN_AIR_BEFORE = .04;
/** A room-tone step this large between two quiet edges is audible as a change of room. */
export const ROOM_TONE_JUMP_DB = 6;
/** Room tone below this level (a gated or very quiet mic) is inaudible, so a step between two such floors is not reported. */
export const AUDIBLE_ROOM_TONE_DB = -70;
/** A transcript word that spans an edge with at least this much measured quiet beside it is a stretched timing, not a clipped word. */
export const STRETCHED_WORD_AIR = .1;
/** Strip resolution and reach either side of the join. */
export const STRIP_STEP = .02, STRIP_REACH = .3;
const wordMargin = .03;

export interface JoinAudit {
  join: number;
  at: number;
  trackId: string;
  /** A crossfade: the fades blend the handle ends measured as out/in, so their air is what the fade passes through. */
  overlap?: number;
  out: { mediaId: string; source: number; voice?: boolean; clipped?: string; lastWord?: string; lastWordEnd?: number; wordEndToJoin?: number; levelQuiet?: number; stretchedWord?: string };
  in: { mediaId: string; source: number; voice?: boolean; clipped?: string; firstWord?: string; levelQuiet?: number; stretchedWord?: string };
  /** dBFS (RMS) in 20 ms steps as heard: 0.3 s of the outgoing source, `|`, 0.3 s of the incoming source. */
  levels: string;
  /** Seconds of quiet after the last sound before the join, and before the next sound after it. */
  airAfter?: number;
  airBefore?: number;
  /** Incoming minus outgoing level over the 60 ms either side, dB. */
  jumpDb?: number;
  verdict: string;
}

function bucketing(r: Reading) {
  const n = (r.rms ?? r.peaks).length;
  const step = (r.to - r.from) / Math.max(1, n);
  // A span that only touches a bucket boundary (within float error) does not voice it.
  const voiced = (s: number, e: number) => (r.speechActivity ?? []).some(v => v.start < e - 1e-6 && v.end > s + 1e-6);
  const low = (i: number) => i >= 0 && i < n && (r.rms?.[i] ?? 0) <= QUIET_RMS && r.peaks[i]! <= QUIET_PEAK;
  return {
    step,
    level: (i: number) => (i >= 0 && i < n ? dbfs(r.rms?.[i] ?? r.peaks[i]!) : undefined),
    low,
    quiet: (i: number) => low(i) && !voiced(r.from + i * step, r.from + (i + 1) * step),
    index: (t: number) => Math.floor((t - r.from) / step + 1e-6),
    voiced,
  };
}

/** Audit one track's join from two measured windows, one around each source edge. */
export function auditJoin(join: number, at: number, side: TrackJoin, out: Reading, inn: Reading,
  words: { out?: TranscriptWord[]; in?: TranscriptWord[] } = {}): JoinAudit {
  const o = bucketing(out), n = bucketing(inn);
  const oEdge = o.index(side.out.source), nEdge = n.index(side.in.source);
  const reach = Math.round(STRIP_REACH / STRIP_STEP);
  // Resample both windows to the strip's 20 ms grid by nearest bucket.
  const sample = (b: ReturnType<typeof bucketing>, r: Reading, t: number) => b.level(Math.floor((t - r.from) / b.step + 1e-6));
  const before: string[] = [], after: string[] = [];
  for (let k = reach; k >= 1; k--) before.push(String(sample(o, out, side.out.source - k * STRIP_STEP + 1e-6) ?? "·"));
  for (let k = 0; k < reach; k++) after.push(String(sample(n, inn, side.in.source + k * STRIP_STEP + 1e-6) ?? "·"));
  let airAfter = 0;
  for (let i = oEdge - 1; o.quiet(i); i--) airAfter += o.step;
  let airBefore = 0;
  for (let i = nEdge; n.quiet(i); i++) airBefore += n.step;
  let outQuiet = 0, inQuiet = 0;
  for (let i = oEdge - 1; o.low(i); i--) outQuiet += o.step;
  for (let i = nEdge; n.low(i); i++) inQuiet += n.step;
  const mean = (values: Array<number | undefined>) => {
    const v = values.filter((x): x is number => x !== undefined);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
  };
  const span = Math.max(1, Math.round(.06 / o.step));
  const outLevel = mean(Array.from({ length: span }, (_, k) => o.level(oEdge - 1 - k)));
  const inLevel = mean(Array.from({ length: Math.max(1, Math.round(.06 / n.step)) }, (_, k) => n.level(nEdge + k)));
  const jumpDb = outLevel !== undefined && inLevel !== undefined ? Math.round(inLevel - outLevel) : 0;
  const straddles = (list: TranscriptWord[] | undefined, t: number) =>
    list?.find(w => w.start + wordMargin < t && t < w.end - wordMargin);
  // The recording decides: a word spanning a measured pause at the edge is a stretched timing, not a clipped word.
  const spanOut = straddles(words.out, side.out.source), spanIn = straddles(words.in, side.in.source);
  const clippedOut = airAfter < STRETCHED_WORD_AIR ? spanOut : undefined, clippedIn = airBefore < STRETCHED_WORD_AIR ? spanIn : undefined;
  const speed = side.outClip?.speed ?? 1;
  const center = side.outClip?.joinSource ?? side.out.source - (side.overlap ?? 0) / 2 * speed;
  const lastWord = words.out?.findLast(w => w.end > w.start && w.end <= center + 1e-6 && w.start >= (side.outClip?.sourceIn ?? 0)
    && w.text.trim() && !/^\s*\[.*\]\s*$/.test(w.text));
  const wordEndToJoin = lastWord && !words.out?.some(w => w.start >= lastWord.end && w.start < center - 1e-6 && w.end > center + 1e-6)
    ? round((center - lastWord.end) / speed + (side.gap ?? 0)) : undefined;
  const firstWord = words.in?.find(w => w.start >= side.in.source - wordMargin);
  const voiceOut = o.voiced(side.out.source - .02, side.out.source), voiceIn = n.voiced(side.in.source, side.in.source + .02);
  const name = (w?: TranscriptWord) => (w ? "“" + w.text.trim() + "”" : "");
  const issues: string[] = [];
  if (clippedOut) issues.push(`cuts off ${name(clippedOut)}`);
  if (clippedIn) issues.push(`starts inside ${name(clippedIn)}`);
  if (!clippedOut && airAfter < 1e-6) issues.push(voiceOut ? "outgoing edge on speech" : "outgoing edge on sound");
  else if (!clippedOut && airAfter < MIN_AIR_AFTER) issues.push(`only ${airAfter.toFixed(2)} s after ${name(lastWord) || "the last sound"}`);
  if (!clippedIn && airBefore < 1e-6) issues.push(voiceIn ? "incoming edge on speech" : "incoming edge on sound");
  else if (!clippedIn && airBefore < MIN_AIR_BEFORE) issues.push(`only ${airBefore.toFixed(2)} s before ${name(firstWord) || "the next sound"}`);
  // Room tone is only comparable when both 60 ms windows are quiet.
  if (airAfter >= .06 - 1e-6 && airBefore >= .06 - 1e-6 && Math.abs(jumpDb) >= ROOM_TONE_JUMP_DB &&
      Math.max(outLevel ?? -99, inLevel ?? -99) > AUDIBLE_ROOM_TONE_DB) issues.push(`room tone ${jumpDb > 0 ? "rises" : "drops"} ${Math.abs(jumpDb)} dB`);
  return {
    join, at: round(at), trackId: side.trackId, ...(side.overlap && { overlap: side.overlap }),
    out: { mediaId: side.out.mediaId, source: round(side.out.source), voice: voiceOut, ...(clippedOut && { clipped: clippedOut.text.trim() }),
      ...(lastWord && { lastWord: lastWord.text.trim(), lastWordEnd: round(lastWord.end), wordEndToJoin }),
      ...(out.rms?.length && { levelQuiet: round(outQuiet, 2) }), ...(spanOut && !clippedOut && { stretchedWord: spanOut.text.trim() }) },
    in: { mediaId: side.in.mediaId, source: round(side.in.source), voice: voiceIn, ...(clippedIn && { clipped: clippedIn.text.trim() }),
      ...(firstWord && { firstWord: firstWord.text.trim() }), ...(inn.rms?.length && { levelQuiet: round(inQuiet, 2) }), ...(spanIn && !clippedIn && { stretchedWord: spanIn.text.trim() }) },
    levels: before.join(" ") + " | " + after.join(" "),
    airAfter: round(airAfter, 2), airBefore: round(airBefore, 2), jumpDb,
    verdict: issues.length ? "check: " + issues.join("; ") : "clean",
  };
}

export function round(t: number, digits = 3) {
  const f = 10 ** digits;
  return Math.round(t * f) / f;
}
