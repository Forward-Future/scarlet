/**
 * Pure helpers used by the MCP tools: silence detection, sparklines,
 * transcript search/formatting, caption mapping and timeline summaries.
 * No I/O here so everything is unit-testable.
 */
import type { Clip, MediaClip, Project, TimeRange, Timeline, Transcript, TranscriptWord } from "@scarlet/timeline";
import { clipEnd, formatTimecode, mergeRanges, rangesOverlap, timelineDuration } from "@scarlet/timeline";
import { normalizeTranscriptToken } from "@scarlet/shared";
export { flattenWords, searchTranscript, type TranscriptMatch } from "@scarlet/shared";

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

export interface Silence {
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
// Transcript
// ---------------------------------------------------------------------------

/** `[12.34-12.80] word` lines, grouped under a segment/speaker header. */
export function formatTranscriptText(t: Transcript, granularity: "word" | "segment", from?: number, to?: number): string {
  const lines: string[] = [];
  for (const seg of t.segments) {
    if (from !== undefined && seg.end < from) continue;
    if (to !== undefined && seg.start > to) continue;
    const spk = seg.speaker ? ` ${seg.speaker}:` : "";
    if (granularity === "segment" || seg.words.length === 0) {
      lines.push(`[${fmt(seg.start)}-${fmt(seg.end)}]${spk} ${seg.text.trim()}`);
      continue;
    }
    lines.push(`## [${fmt(seg.start)}-${fmt(seg.end)}]${spk}`);
    for (const w of seg.words) {
      if (from !== undefined && w.end < from) continue;
      if (to !== undefined && w.start > to) continue;
      const wspk = w.speaker && w.speaker !== seg.speaker ? ` ${w.speaker}:` : "";
      lines.push(`[${fmt(w.start)}-${fmt(w.end)}]${wspk} ${w.text}`);
    }
  }
  return lines.join("\n");
}

function fmt(s: number): string {
  return s.toFixed(2);
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

/** Media clips whose audio is actually heard (enabled, unmuted track, volume > 0). */
export function audibleMediaClips(timeline: Timeline, mediaId?: string): MediaClip[] {
  const clips: MediaClip[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false) continue;
      if (mediaId && clip.mediaId !== mediaId) continue;
      if ((clip.volume ?? 1) <= 0) continue;
      clips.push(clip);
    }
  }
  return clips.sort((a, b) => a.timelineIn - b.timelineIn);
}

/** Use the audible edit by default. A named source also includes its enabled, muted placements. */
export function captionSourceClips(timeline: Timeline, available: (id: string) => boolean, mediaId?: string): MediaClip[] {
  if (!mediaId) return audibleMediaClips(timeline).filter(c => available(c.mediaId));
  return timeline.tracks.filter(t => t.kind !== "caption").flatMap(t => t.clips)
    .filter((c): c is MediaClip => c.kind === "media" && c.enabled && c.mediaId === mediaId && available(c.mediaId))
    .sort((a, b) => a.timelineIn - b.timelineIn);
}

/** Drop words that duplicate an earlier one at (almost) the same timeline time. */
export function dedupeWords(words: TranscriptWord[], tolerance = 0.02): TranscriptWord[] {
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

export function describeClip(clip: Clip, fps = 30): string {
  const range = `${formatTimecode(clip.timelineIn, fps)}–${formatTimecode(clipEnd(clip), fps)}`;
  const label = clip.label ? ` "${clip.label}"` : "";
  const off = clip.enabled === false ? " (disabled)" : "";
  if (clip.kind === "media") {
    const speed = clip.speed && clip.speed !== 1 ? ` x${clip.speed}` : "";
    const vol = clip.volume === 0 ? " muted" : "";
    const fades = clip.audioFadeIn || clip.audioFadeOut ? ` fades ${clip.audioFadeIn}/${clip.audioFadeOut}` : "";
    return `${clip.id}${label} ${range} <- ${clip.mediaId} ${clip.sourceIn.toFixed(2)}–${clip.sourceOut.toFixed(2)}${speed}${vol}${fades}${off}`;
  }
  if (clip.kind === "caption") {
    return `${clip.id} ${range} caption "${truncate(clip.text, 60)}"${off}`;
  }
  return `${clip.id}${label} ${range} color ${clip.color}${off}`;
}

export function summarizeTimeline(timeline: Timeline, fps = 30): string {
  const lines: string[] = [];
  lines.push(
    `Timeline "${timeline.name}" version ${timeline.version} — duration ${formatTimecode(timelineDuration(timeline), fps)} (${timelineDuration(timeline).toFixed(2)} s), ${timeline.tracks.length} tracks, ${timeline.markers.length} markers`,
  );
  for (const t of timeline.tracks) {
    const flags = [t.muted ? "muted" : "", t.hidden ? "hidden" : ""].filter(Boolean).join(", ");
    lines.push(`Track ${t.id} (${t.kind}) "${t.name}" — ${t.clips.length} clips${flags ? ` [${flags}]` : ""}`);
    for (const c of [...t.clips].sort((a, b) => a.timelineIn - b.timelineIn)) lines.push(`  ${describeClip(c, fps)}`);
  }
  if (timeline.markers.length) {
    lines.push("Markers:");
    for (const m of timeline.markers) {
      lines.push(`  ${m.id} @${formatTimecode(m.time, fps)} [${m.kind}] ${truncate(m.text, 80)}${m.resolved ? " (resolved)" : ""}`);
    }
  }
  return lines.join("\n");
}

export function summarizeProject(project: Project, timeline: Timeline | null): string {
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
      m.transcriptId ? "transcript" : "no transcript",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${m.id} ${m.kind} "${m.name}" ${dur}${extra ? ` (${extra})` : ""}`);
  }
  if (timeline) lines.push(summarizeTimeline(timeline, s.fps));
  // The empty timeline's tracks are stated: three passes in three began by adding a video track "v1" and were refused.
  else lines.push("No timeline yet. The first edit starts from an empty one that already has a video track v1 and an audio track a1.");
  return lines.join("\n");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

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
