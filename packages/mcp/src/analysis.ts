/**
 * Pure helpers used by the MCP tools: silence detection, sparklines,
 * caption mapping and timeline summaries.
 * No I/O here so everything is unit-testable.
 */
import type { Clip, MediaAsset, MediaClip, Project, TimeRange, Timeline, Transcript, TranscriptWord } from "@scarlet/timeline";
import { clipEnd, formatTimecode, mergeRanges, rangesOverlap, timelineDuration } from "@scarlet/timeline";
import { normalizeTranscriptToken } from "@scarlet/shared";

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

interface Silence {
  start: number;
  end: number;
  duration: number;
}

/**
 * Find runs of low peaks. `peaks` cover [from, to] evenly; a bucket is silent
 * when its peak is below `threshold` (0..1). Runs shorter than `minDuration`
 * seconds are ignored.
 */
export function detectSilences(
  peaks: number[],
  from: number,
  to: number,
  opts: { threshold?: number; minDuration?: number } = {},
): Silence[] {
  const threshold = opts.threshold ?? 0.05;
  const minDuration = opts.minDuration ?? 0.25;
  const n = peaks.length;
  if (n === 0 || to <= from) return [];
  const bucket = (to - from) / n;
  const out: Silence[] = [];
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const silent = i < n && (peaks[i] ?? 1) < threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      const start = from + runStart * bucket;
      const end = from + i * bucket;
      if (end - start >= minDuration) {
        out.push({ start: round3(start), end: round3(end), duration: round3(end - start) });
      }
      runStart = -1;
    }
  }
  return out;
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Compact textual sparkline; downsamples to at most `width` characters. */
export function sparkline(peaks: number[], width = 80): string {
  if (peaks.length === 0) return "";
  const buckets = downsample(peaks, width);
  return buckets.map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, Math.floor(v * BLOCKS.length)))]).join("");
}

/** Reduce an array to at most `n` buckets by taking the max of each group. */
export function downsample(values: number[], n: number): number[] {
  if (values.length <= n) return values.slice();
  const out: number[] = [];
  const size = values.length / n;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * size);
    const b = Math.max(a + 1, Math.floor((i + 1) * size));
    let m = 0;
    for (let j = a; j < b && j < values.length; j++) m = Math.max(m, values[j] ?? 0);
    out.push(round3(m));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Captions through the timeline
// ---------------------------------------------------------------------------

/**
 * Map transcript words (in source time of `clip.mediaId`) into timeline time
 * through a media clip. Words outside the clip's source range are dropped.
 */
export function mapWordsThroughClip(clip: MediaClip, words: TranscriptWord[]): TranscriptWord[] {
  const speed = clip.speed ?? 1;
  const out: TranscriptWord[] = [];
  for (const w of words) {
    // Keep words whose midpoint lands inside the kept source range.
    const mid = (w.start + w.end) / 2;
    if (mid < clip.sourceIn || mid >= clip.sourceOut) continue;
    const start = clip.timelineIn + Math.max(0, w.start - clip.sourceIn) / speed;
    const end = clip.timelineIn + Math.min(clip.sourceOut - clip.sourceIn, w.end - clip.sourceIn) / speed;
    out.push({ ...w, start: round3(start), end: round3(Math.max(start, end)) });
  }
  return out;
}

/**
 * Index words by midpoint once. The result lists, in transcript order, the indices of the words whose
 * midpoint is in [sourceIn, sourceOut): the words a clip keeps.
 */
export function wordsByMidpoint(words: readonly TranscriptWord[]): (sourceIn: number, sourceOut: number) => number[] {
  const midpoints = words.map(w => (w.start + w.end) / 2);
  // With overlapping speakers the midpoint order may differ from transcript
  // order. Index the former for selection, then restore the latter for output.
  const order = midpoints.some((mid, i) => i > 0 && mid < midpoints[i - 1]!)
    ? midpoints.map((_, i) => i).sort((a, b) => midpoints[a]! - midpoints[b]!) : undefined;
  const times = order ? order.map(i => midpoints[i]!) : midpoints;
  function lowerBound(time: number): number {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (times[mid]! < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  return (sourceIn, sourceOut) => {
    const from = lowerBound(sourceIn), to = lowerBound(sourceOut);
    if (order) return order.slice(from, to).sort((a, b) => a - b);
    const out: number[] = [];
    for (let i = from; i < to; i++) out.push(i);
    return out;
  };
}

/** Index one recording's words once, then map only the words inside each cut. */
export function captionWordMapper(words: readonly TranscriptWord[]): (clip: MediaClip) => TranscriptWord[] {
  const inClip = wordsByMidpoint(words);
  return clip => mapWordsThroughClip(clip, inClip(clip.sourceIn, clip.sourceOut).map(i => words[i]!));
}

/** Each track's media clips whose audio is actually heard (enabled, unmuted track, volume > 0), track by track. */
export function audibleClipsByTrack(timeline: Timeline): MediaClip[][] {
  return timeline.tracks.filter(track => track.kind !== "caption" && !track.muted)
    .map(track => track.clips.filter((clip): clip is MediaClip => clip.kind === "media" && clip.enabled !== false && (clip.volume ?? 1) > 0));
}

/** Media clips whose audio is actually heard, in timeline order (track order for clips that start together). */
export function audibleMediaClips(timeline: Timeline): MediaClip[] {
  return audibleClipsByTrack(timeline).flat().sort((a, b) => a.timelineIn - b.timelineIn);
}

/** Use the audible edit by default. A named source also includes its enabled, muted placements. */
export function captionSourceClips(timeline: Timeline, available: (id: string) => boolean, mediaId?: string): MediaClip[] {
  if (!mediaId) return audibleMediaClips(timeline).filter(c => available(c.mediaId));
  return timeline.tracks.filter(t => t.kind !== "caption").flatMap(t => t.clips)
    .filter((c): c is MediaClip => c.kind === "media" && c.enabled && c.mediaId === mediaId && available(c.mediaId))
    .sort((a, b) => a.timelineIn - b.timelineIn);
}

/** Drop words that duplicate an earlier one at (almost) the same timeline time. */
export function dedupeWords(words: TranscriptWord[]): TranscriptWord[] {
  const tolerance = 0.02;
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const out: TranscriptWord[] = [];
  const lastStart = new Map<string, number>();
  for (const w of sorted) {
    const token = normalizeTranscriptToken(w.text);
    const previous = lastStart.get(token);
    if (previous !== undefined && w.start - previous < tolerance) continue;
    lastStart.set(token, w.start);
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timeline summaries
// ---------------------------------------------------------------------------

/** A transform's fields that move the picture, as " framed scale 1.4 x 0.1 crop l0.1 r0.2"; "" for none. */
function describeTransform(t: MediaClip["transform"]): string {
  if (!t) return "";
  const parts: string[] = [];
  if (t.scale !== undefined && t.scale !== 1) parts.push(`scale ${round3(t.scale)}`);
  if (t.x) parts.push(`x ${round3(t.x)}`);
  if (t.y) parts.push(`y ${round3(t.y)}`);
  if (t.rotation) parts.push(`rot ${round3(t.rotation)}`);
  const crops = ([["l", t.cropLeft], ["r", t.cropRight], ["t", t.cropTop], ["b", t.cropBottom]] as const).filter(([, v]) => v);
  if (crops.length) parts.push(`crop ${crops.map(([k, v]) => `${k}${round3(v!)}`).join(" ")}`);
  if (t.cornerRadius) parts.push(`corners ${round3(t.cornerRadius)}`);
  return parts.length ? ` framed ${parts.join(" ")}` : "";
}

/** Clip fields left out of format full when they hold their default. */
const CLIP_DEFAULTS: Record<string, unknown> = { enabled: true, speed: 1, opacity: 1, volume: 1, audioFadeIn: 0, audioFadeOut: 0, videoFadeIn: 0, videoFadeOut: 0 };
const TRANSFORM_DEFAULTS: Record<string, unknown> = { x: 0, y: 0, scale: 1, rotation: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
/** What format full's description says an omitted field holds. */
export const FULL_TIMELINE_DEFAULTS = "Clip fields at their default are left out: enabled true, speed 1, opacity 1, volume 1, fades 0, effects none; in a transform x, y, rotation and crops 0, scale 1; a track's muted and hidden false; a marker's resolved false.";

const withoutDefaults = (o: Record<string, unknown>, defaults: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => !(k in defaults && defaults[k] === v)));

function compactClip(clip: Clip): Record<string, unknown> {
  const out = withoutDefaults(clip as Record<string, unknown>, clip.kind === "media" ? CLIP_DEFAULTS : { enabled: true, opacity: 1 });
  if (Array.isArray(out.effects) && !out.effects.length) delete out.effects;
  if (out.transform) out.transform = withoutDefaults(out.transform as Record<string, unknown>, TRANSFORM_DEFAULTS);
  return out;
}

/**
 * The complete timeline for `timeline_get` format full, without fields at their default, optionally scoped to
 * `[from, to]` in timeline seconds and paged by clip start when it would exceed `maxChars`. Codex read the whole
 * timeline this way about 120 times in the editor's runs, at up to 150,000 characters each, and the runs that read it
 * most were the costliest (2026-11-24). A result past Claude Code's 50,000-character spill point isn't read at all.
 */
export function fullTimelinePage(timeline: Timeline, opts: { from?: number; to?: number; maxChars?: number } = {}): string {
  const { from, to, maxChars } = opts;
  const windowFrom = from ?? 0;
  const scoped = from !== undefined || to !== undefined;
  const inWindow = (c: Clip) => !scoped || (clipEnd(c) > windowFrom && (to === undefined || c.timelineIn < to));
  const total = timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
  const render = (cutoff?: number) => {
    let shown = 0;
    const tracks = timeline.tracks.map(t => {
      const clips = [...t.clips].sort((a, b) => a.timelineIn - b.timelineIn)
        .filter(c => inWindow(c) && (cutoff === undefined || c.timelineIn < cutoff)).map(compactClip);
      shown += clips.length;
      return { ...withoutDefaults(t as Record<string, unknown>, { muted: false, hidden: false }), clips };
    });
    const markers = timeline.markers
      .filter(m => (!scoped || (m.time >= windowFrom && (to === undefined || m.time < to))) && (cutoff === undefined || m.time < cutoff))
      .map(m => withoutDefaults(m as Record<string, unknown>, { resolved: false }));
    const page = cutoff !== undefined
      ? { page: `Clips starting before ${round3(cutoff)} s: ${shown} of ${total}. Call timeline_get with format full and from=${Math.floor(cutoff * 1000) / 1000}${to !== undefined ? ` and to=${round3(to)}` : ""} to read on.` }
      : scoped ? { page: `Clips in ${round3(windowFrom)}–${to !== undefined ? round3(to) : "end"} s: ${shown} of ${total}.` } : {};
    return JSON.stringify({ ...timeline, tracks, markers, ...page });
  };
  const whole = render();
  if (!maxChars || whole.length <= maxChars) return whole;
  const starts = [...new Set(timeline.tracks.flatMap(t => t.clips.filter(inWindow).map(c => c.timelineIn)).filter(t => t > windowFrom))].sort((a, b) => a - b);
  if (!starts.length) return whole;
  let lo = 0, hi = starts.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (render(starts[mid]!).length <= maxChars) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return render(starts[best]!);
}

function describeClip(clip: Clip, fps = 30): string {
  const range = `${formatTimecode(clip.timelineIn, fps)}–${formatTimecode(clipEnd(clip), fps)}`;
  const label = clip.label ? ` "${clip.label}"` : "";
  const off = clip.enabled === false ? " (disabled)" : "";
  if (clip.kind === "media") {
    const speed = clip.speed && clip.speed !== 1 ? ` x${clip.speed}` : "";
    const vol = clip.volume === 0 ? " muted" : "";
    const fades = clip.audioFadeIn || clip.audioFadeOut ? ` fades ${round3(clip.audioFadeIn ?? 0)}/${round3(clip.audioFadeOut ?? 0)}` : "";
    // A level that moves, and a voice cleaned, are said in a word: format full gives the keys and the effect.
    const level = clip.volumeKeyframes?.length ? ` level keys ${clip.volumeKeyframes.length}` : "";
    const voice = clip.effects?.some(e => e.type === "voiceCleanup" && e.enabled !== false) ? " voice cleanup" : "";
    // The picture's framing, other effects and a transition, in a word each, so reading them needn't take format full,
    // whose whole timeline was 59% of every tool result's characters in the editor's runs (2026-11-24).
    const framed = describeTransform(clip.transform);
    const keys = clip.keyframes?.length ? ` moves ${clip.keyframes.length} keys` : "";
    const others = (clip.effects ?? []).filter(e => e.type !== "voiceCleanup" && e.enabled !== false).map(e => e.type);
    const effects = others.length ? ` effects ${others.join(",")}` : "";
    const transition = clip.transitionIn ? ` ${clip.transitionIn.type} in ${round3(clip.transitionIn.duration)} s` : "";
    return `${clip.id}${label} ${range} <- ${clip.mediaId} ${clip.sourceIn.toFixed(2)}–${clip.sourceOut.toFixed(2)}${speed}${vol}${fades}${level}${voice}${framed}${keys}${effects}${transition}${off}`;
  }
  if (clip.kind === "caption") {
    return `${clip.id} ${range} caption "${truncate(clip.text, 60)}"${off}`;
  }
  return `${clip.id}${label} ${range} color ${clip.color}${off}`;
}

/**
 * A timeline track by track, each clip on a line. Given `brief`, a timeline with more clips than that lists only the
 * clips near `near` (or none): the prompt is read again on every turn of a run, and a finished video's 300 clips cost
 * a revision of one cut about a third of its tokens (2026-11-18). The tools read the rest when a request needs it.
 */
export function summarizeTimeline(timeline: Timeline, fps = 30, brief?: { most: number; near?: TimeRange }): string {
  const lines: string[] = [];
  lines.push(
    `Timeline "${timeline.name}" version ${timeline.version} — duration ${formatTimecode(timelineDuration(timeline), fps)} (${timelineDuration(timeline).toFixed(2)} s), ${timeline.tracks.length} tracks, ${timeline.markers.length} markers`,
  );
  const total = timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
  const short = brief && total > brief.most ? brief : undefined;
  const pad = 15;
  const shown = (c: Clip) => !short || (!!short.near && c.timelineIn < short.near.end + pad && clipEnd(c) > short.near.start - pad);
  for (const t of timeline.tracks) {
    const flags = [t.muted ? "muted" : "", t.hidden ? "hidden" : ""].filter(Boolean).join(", ");
    const span = short && t.clips.length ? `, ${formatTimecode(Math.min(...t.clips.map(c => c.timelineIn)), fps)}–${formatTimecode(Math.max(...t.clips.map(clipEnd)), fps)}` : "";
    lines.push(`Track ${t.id} (${t.kind}) "${t.name}" — ${t.clips.length} clips${span}${flags ? ` [${flags}]` : ""}`);
    for (const c of [...t.clips].sort((a, b) => a.timelineIn - b.timelineIn)) if (shown(c)) lines.push(`  ${describeClip(c, fps)}`);
  }
  if (short) {
    lines.push(short.near
      ? `Listed: the clips within ${pad} s of ${formatTimecode(short.near.start, fps)}–${formatTimecode(short.near.end, fps)}, of ${total}. \`timeline_get\` lists every clip and \`timeline_at\` reads what plays at a time.`
      : `The ${total} clips aren't listed here: \`timeline_get\` lists every clip and \`timeline_at\` reads what plays at a time.`);
  }
  if (timeline.markers.length) {
    lines.push("Markers:");
    for (const m of timeline.markers) {
      lines.push(`  ${m.id} @${formatTimecode(m.time, fps)} [${m.kind}] ${truncate(m.text, 80)}${m.resolved ? " (resolved)" : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * Summarize a timeline for `timeline_get`, optionally scoped to `[from, to]` in timeline seconds
 * and paged by clip start time when the summary would exceed `maxChars`.
 */
export function summarizeTimelinePage(
  timeline: Timeline,
  fps = 30,
  opts: { from?: number; to?: number; maxChars?: number } = {},
): string {
  const { from, to, maxChars } = opts;
  if (from === undefined && to === undefined) {
    const full = summarizeTimeline(timeline, fps);
    if (!maxChars || full.length <= maxChars) return full;
  }
  const duration = timelineDuration(timeline);
  const windowFrom = from ?? 0;
  const scoped = from !== undefined || to !== undefined;
  const total = timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
  const inWindow = (c: Clip) => clipEnd(c) > windowFrom && (to === undefined || c.timelineIn < to);
  const trackClips = timeline.tracks.map(t => ({
    track: t,
    clips: [...t.clips].sort((a, b) => a.timelineIn - b.timelineIn).filter(inWindow),
  }));
  const inWindowTotal = trackClips.reduce((n, t) => n + t.clips.length, 0);
  const render = (cutoff?: number) => {
    const lines: string[] = [
      `Timeline "${timeline.name}" version ${timeline.version} — duration ${formatTimecode(duration, fps)} (${duration.toFixed(2)} s), ${timeline.tracks.length} tracks, ${timeline.markers.length} markers`,
    ];
    let shown = 0;
    for (const { track: t, clips } of trackClips) {
      const flags = [t.muted ? "muted" : "", t.hidden ? "hidden" : ""].filter(Boolean).join(", ");
      lines.push(`Track ${t.id} (${t.kind}) "${t.name}" — ${t.clips.length} clips${flags ? ` [${flags}]` : ""}`);
      for (const c of clips) {
        if (cutoff !== undefined && c.timelineIn >= cutoff) continue;
        lines.push(`  ${describeClip(c, fps)}`);
        shown++;
      }
    }
    const markers = timeline.markers.filter(m =>
      m.time >= windowFrom && (cutoff !== undefined ? m.time < cutoff : to === undefined || m.time < to),
    );
    if (markers.length) {
      lines.push("Markers:");
      for (const m of markers) {
        lines.push(`  ${m.id} @${formatTimecode(m.time, fps)} [${m.kind}] ${truncate(m.text, 80)}${m.resolved ? " (resolved)" : ""}`);
      }
    }
    if (cutoff !== undefined) {
      const floored = Math.floor(cutoff * 1000) / 1000;
      const nextFrom = floored > windowFrom ? floored : cutoff;
      lines.push(
        `Showing ${shown} of ${inWindowTotal} clips${scoped ? " in range" : ""} (through ${cutoff.toFixed(2)} s); call timeline_get with from=${nextFrom}${to !== undefined ? ` and to=${round3(to)}` : ""} to read on, or timeline_at for one time.`,
      );
    } else if (scoped) {
      lines.push(`Showing ${shown} clips in ${windowFrom.toFixed(2)}–${(to ?? duration).toFixed(2)} s (of ${total} total).`);
    }
    return lines.join("\n");
  };
  const whole = render();
  if (!maxChars || whole.length <= maxChars) return whole;
  const starts = [...new Set(trackClips.flatMap(t => t.clips.map(c => c.timelineIn)).filter(t => t > windowFrom))].sort((a, b) => a - b);
  if (!starts.length) return whole;
  let lo = 0, hi = starts.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (render(starts[mid]!).length <= maxChars) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return render(starts[best]!);
}

export function summarizeProject(project: Project, timeline: Timeline | null, brief?: { most: number; near?: TimeRange; requestedAt?: string }): string {
  const s = project.settings;
  const lines = [
    `Project "${project.name}" (${project.id}) — ${s.width}x${s.height} ${s.aspect} @ ${s.fps} fps, head version ${project.head ?? "none"}`,
    `Media (${project.media.length}):`,
  ];
  for (const m of project.media) {
    const dur = m.duration !== undefined ? `${m.duration.toFixed(2)} s` : "duration unknown";
    const extra = [
      m.fps ? `${m.fps} fps` : "",
      m.width && m.height ? `${m.width}x${m.height}` : "",
      m.hasAudio ? "audio" : "",
      m.kind === "graphic" ? "" : m.transcriptId ? "transcript" : "no transcript",
      m.graphic ? `drawn from ${m.graphic.source}` : "",
      colorEvidence(m.color) ?? "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${m.id} ${m.kind} "${m.name}" ${dur}${extra ? ` (${extra})` : ""}${mediaWords(m, brief?.requestedAt)}`);
  }
  if (timeline) lines.push(summarizeTimeline(timeline, s.fps, brief));
  // The empty timeline's tracks are stated: three passes in three began by adding a video track "v1" and were refused.
  else lines.push("No timeline yet. The first edit starts from an empty one that already has a video track v1 and an audio track a1.");
  return lines.join("\n");
}

/** Added after the request was sent: a file the editor brought in while Scarlet worked, or while the request waited. */
export function addedAfterRequest(m: Pick<MediaAsset, "addedAt">, requestedAt: string | undefined): boolean {
  return !!(requestedAt && m.addedAt && Date.parse(m.addedAt) > Date.parse(requestedAt));
}

/** The editor's own words on a file, and whether it came in after the request, as the media list says them. */
function mediaWords(m: MediaAsset, requestedAt: string | undefined): string {
  return (m.editorNote ? `; the editor's note on this file: "${m.editorNote.replace(/\s+/g, " ")}"` : "") +
    (addedAfterRequest(m, requestedAt) ? "; added after this request was sent, so not part of it unless the editor's words name it" : "");
}

/**
 * What a file declares about its picture's colour, when it isn't ordinary SDR: HDR, which Scarlet tone-maps to SDR
 * itself, a camera Log curve, which stays as shot, or colour tags other than BT.709.
 */
export function colorEvidence(color: MediaAsset["color"]): string | undefined {
  if (!color) return undefined;
  const parts: string[] = [];
  if (color.hdr) parts.push(`HDR ${color.hdr === "hlg" ? "HLG" : "PQ"}, shown, read and exported tone-mapped to SDR BT.709`);
  if (color.log) parts.push(`camera Log (${color.log}), flat and low in contrast as shot, no look applied`);
  if (!parts.length && (color.primaries || color.transfer)) {
    parts.push(`colour tagged ${[color.primaries && `primaries ${color.primaries}`, color.transfer && `transfer ${color.transfer}`].filter(Boolean).join(", ")}`);
  }
  return parts.length ? parts.join("; ") : undefined;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Format a 0..1 fraction as a percentage rounded to one decimal place (0..100). */
export function pct1(n: number): number {
  return Math.round(n * 1000) / 10;
}

/** Append `[start, end]` to sorted contiguous intervals, merging when adjacent within `epsilon`. */
export function appendInterval(runs: TimeRange[], start: number, end: number, epsilon = 1e-6): void {
  const previous = runs.at(-1);
  if (previous && Math.abs(previous.end - start) < epsilon) previous.end = end;
  else runs.push({ start, end });
}

/** A transcript word that is a bracketed tag, such as [BLANK_AUDIO], and not something said. */
export const isTag = (text: string) => /^\s*\[.*\]\s*$/.test(text);

/** How a transcript read marks a word heard only on the input a recording's dialogue isn't on: it is not the speaker. */
export const OTHER_INPUT = "[other input]";

/** Linear level 0..1 → dBFS, floored at -99. Every audio tool reports levels this way. */
export function dbfs(v: number): number {
  return Math.max(-99, Math.round(20 * Math.log10(v + 1e-7)));
}

/** Suggest only the removable middle of pauses between observed words. Treat
 * untimed transcript segments, overlapping speakers and loud breaths as active. */
export function dialogueCutSuggestions(t: Transcript | null, wf: { from: number; to: number; peaks: number[]; rms?: number[]; speechActivity?: Array<{ start: number; end: number }> },
  opts: { threshold: number; minSilence: number }) {
  const speech = t?.segments.flatMap(segment => segment.words.length
    ? segment.words
    : segment.text.trim() ? [{ start: segment.start, end: segment.end, text: "" }] : [])
    .filter(w => w.end > w.start).sort((a, b) => a.start - b.start) ?? [];
  const candidates: Array<{ remove: { start: number; end: number }; before: string; after: string;
    airBefore: number; airAfter: number; maxPeak: number; timingWarning?: string }> = [];
  const method = wf.speechActivity ? "Word timings, WebRTC voice activity and local levels" : "Word timings and local levels";
  if (!speech.length || !wf.peaks.length) return { method, candidates, reason: "No timed speech to anchor a dialogue cut." };
  const sorted = (wf.rms ?? []).slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const quietRms = Math.max(0.003, Math.min(0.025, floor * 2.5));
  const step = (wf.to - wf.from) / wf.peaks.length;
  const guard = Math.max(0.10, step);
  // Walk disjoint gaps in the union of speech intervals. In overlapping
  // dialogue, the last word to finish controls the outgoing boundary.
  const activity = wf.speechActivity ?? [];
  function weakWordTiming(word: TranscriptWord) {
    if (!wf.speechActivity || word.start < wf.from || word.end > wf.to) return false;
    const voiced = activity.reduce((sum, span) => sum + Math.max(0, Math.min(word.end, span.end) - Math.max(word.start, span.start)), 0);
    return voiced < (word.end - word.start) * 0.2;
  }
  let spanIndex = 0;
  let left = speech[0]!;
  for (const right of speech.slice(1)) {
    const start = Math.max(wf.from, left.end + guard);
    const end = Math.min(wf.to, right.start - guard);
    if (left.text && right.text && end - start >= opts.minSilence) {
      const first = Math.max(0, Math.ceil((start - wf.from) / step));
      const limit = Math.min(wf.peaks.length, Math.floor((end - wf.from) / step));
      let run = first, maxPeak = 0;
      for (let i = first; i <= limit; i++) {
        const at = wf.from + i * step;
        while (activity[spanIndex] && activity[spanIndex]!.end + guard <= at) spanIndex++;
        const voiced = activity[spanIndex] && activity[spanIndex]!.start - guard < at + step;
        if (i < limit && !voiced && wf.peaks[i]! < opts.threshold && (!wf.rms || wf.rms[i]! <= quietRms)) {
          maxPeak = Math.max(maxPeak, wf.peaks[i]!);
          continue;
        }
        // Leave an extra analysis bucket either side of untranscribed sounds.
        const a = wf.from + (run + 1) * step, b = wf.from + (i - 1) * step;
        if (b - a >= Math.max(0.06, opts.minSilence)) {
          const previousVoice = activity.findLast(span => span.end <= a);
          const nextVoice = activity.find(span => span.start >= b);
          candidates.push({
            remove: { start: round3(a), end: round3(b) }, before: left.text, after: right.text,
            airBefore: round3(a - Math.max(left.end, previousVoice?.end ?? left.end)),
            airAfter: round3(Math.min(right.start, nextVoice?.start ?? right.start) - b),
            maxPeak: round3(maxPeak),
            timingWarning: weakWordTiming(left) || weakWordTiming(right)
              ? "Word timings disagree with detected speech. Audition this boundary to identify the neighboring words." : undefined,
          });
        }
        run = i + 1;
        maxPeak = 0;
      }
    }
    if (right.end >= left.end) left = right;
  }
  return { method, candidates, reason: candidates.length ? undefined : "No quiet interior with timed words and sufficient breathing room on both sides." };
}

/** Return usable pause interiors outside already accounted-for material. */
export function remainingPauseRanges(range: TimeRange, accounted: TimeRange[]): TimeRange[] {
  const remaining: TimeRange[] = [];
  let start = range.start;
  for (const blocked of mergeRanges(accounted.filter(r => rangesOverlap(range, r)))) {
    if (blocked.start - start >= .25) remaining.push({ start, end: blocked.start });
    start = Math.max(start, blocked.end);
  }
  if (range.end - start >= .25) remaining.push({ start, end: range.end });
  return remaining;
}

/** ASR can omit room tone at either end, or stretch a word over a long silence.
 * The independent quiet runs require both low levels and no voice activity. */
export function firstCutPauses(transcript: Transcript | null, wf: Parameters<typeof dialogueCutSuggestions>[1],
  acoustic?: { quiet: TimeRange[]; valleys: TimeRange[] }) {
  const { candidates } = dialogueCutSuggestions(transcript, wf, { minSilence: 0.25, threshold: 0.05 });
  if (!acoustic) return candidates;
  const segments = transcript?.segments.filter(s => s.text.trim() && !/^\[(?:blank_audio|silence)\]$/i.test(s.text.trim())) ?? [];
  const words = segments.flatMap(s => s.words).filter(w => w.text.trim());
  const anchored = candidates.map(c => c.remove);
  const missing = acoustic.quiet.flatMap(run => remainingPauseRanges({ start: round3(run.start + .12), end: round3(run.end - .12) }, anchored));
  const additional = missing.map(remove => {
    const crossing = words.filter(w => rangesOverlap(w, remove));
    // Whisper sometimes holds one word through room tone. Only trust its silent
    // interior if that word has actual voice elsewhere and the levels reach a deep trough.
    const held = crossing.length === 1 ? crossing[0] : undefined;
    const quietTail = held && remove.end - remove.start >= .75 &&
      wf.speechActivity?.some(v => Math.min(v.end, held.end) - Math.max(v.start, held.start) >= .10) &&
      acoustic.valleys.some(v => v.start <= remove.start && v.end >= remove.end);
    const conflict = (crossing.length > 0 && !quietTail) || segments.some(s => !s.words.length && rangesOverlap(s, remove));
    return { remove, evidence: "Low levels and no detected voice", timingWarning: conflict
      ? "Transcript timing crosses this quiet stretch. Review the words before trimming." : undefined };
  });
  return [...candidates, ...additional].sort((a, b) => a.remove.start - b.remove.start);
}

/** Keep segment context for take selection. Only observed word timings can
 * identify a filler. Coarse segments protect their entire spoken interval. */
export function firstCutEvidence(transcript: Transcript | null, wf: {
  from: number; to: number; speechActivity?: Array<{ start: number; end: number }>;
}) {
  const passages: Array<{ start: number; end: number; text: string; speaker?: string; timing: "word" | "segment"; correctionCue?: string }> = [];
  const fillers: TranscriptWord[] = [];
  const covered: Array<{ start: number; end: number }> = [];
  for (const segment of transcript?.segments ?? []) {
    if (segment.end <= wf.from || segment.start >= wf.to) continue;
    const words = segment.words.filter(w => w.end > wf.from && w.start < wf.to);
    if (!words.length && segment.words.length) continue;
    const first = words[0], last = words.at(-1);
    const text = words.length ? words.map(w => w.text).join(" ") : segment.text;
    // An explicit reset can precede a completely reworded take. Flag the passage
    // for comparison even when ASR supplied only segment timing.
    const correctionCue = text.match(/\b(?:nope|scratch that|(?:sorry|no)[, —-]+I mean(?:t)?|let me (?:start (?:that )?(?:again|over)|(?:try|do|say) that (?:again|one more time))|that came out wrong)\b/i)?.[0];
    passages.push({ start: first?.start ?? segment.start, end: last?.end ?? segment.end,
      text, speaker: segment.speaker, timing: words.length ? "word" : "segment", ...(correctionCue && { correctionCue }) });
    for (const interval of words.length ? words : [segment]) {
      if (interval.text.trim()) covered.push({ start: interval.start - 0.1, end: interval.end + 0.1 });
    }
    for (const word of words) {
      if (word.end > word.start && /^(?:u+h+|a+h+|u+m+|e+rm+|e+hm+)$/.test(normalizeTranscriptToken(word.text))) fillers.push(word);
    }
  }

  // Subtract timed speech from VAD, allowing for imprecise word edges. The
  // remainder can include breaths, overlapping talk, or words ASR omitted.
  covered.sort((a, b) => a.start - b.start);
  const unmatchedVoice: Array<{ start: number; end: number }> = [];
  const add = (start: number, end: number) => {
    if (end - start >= 0.16) unmatchedVoice.push({ start: round3(start), end: round3(end) });
  };
  for (const voice of wf.speechActivity ?? []) {
    let start = Math.max(wf.from, voice.start);
    const end = Math.min(wf.to, voice.end);
    for (const spoken of covered) {
      if (spoken.end <= start) continue;
      if (spoken.start >= end) break;
      add(start, spoken.start);
      start = Math.max(start, spoken.end);
      if (start >= end) break;
    }
    add(start, end);
  }
  return { passages, fillers, unmatchedVoice, voiceDetectionAvailable: wf.speechActivity !== undefined };
}
