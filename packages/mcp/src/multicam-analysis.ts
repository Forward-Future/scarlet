/**
 * Pure multi-camera measurement and speaker-to-camera evidence correlation.
 *
 * Scarlet measures; the model decides. Everything here computes objective facts
 * from the timeline, transcripts, waveforms, face tracks, and per-face mouth
 * movement — never hardcoded switching rules or pacing heuristics.
 */
import { carriesAudio, clipEnd, sourceAt, timelineDuration, type MediaAsset, type MediaClip, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { dbfs, pct1, round2, round3 } from "./analysis.js";
import { timelineWords } from "./timeline-perception.js";

const EPS = 1e-6;
const MEET = 0.05;

export interface CameraAngleInfo {
  mediaId: string;
  name: string;
  trackId: string;
  hidden: boolean;
  clips: MediaClip[];
  coverage: TimeRange[];
  coveredSeconds: number;
}

export interface AudibleSourceInfo {
  mediaId: string;
  name: string;
  trackId: string;
  trackName: string;
  clips: MediaClip[];
  coveredSeconds: number;
}

export interface SpeakerTurn {
  from: number;
  to: number;
  duration: number;
  speaker: string;
  sourceMediaId: string;
  words?: number;
  text?: string;
  /** True when another speaker overlaps meaningfully during this turn. */
  hasOverlap?: boolean;
}

export interface CrosstalkSpan {
  from: number;
  to: number;
  duration: number;
  speakers: string[];
}

export interface SpeakerSummary {
  speaker: string;
  sourceMediaIds: string[];
  speakingSeconds: number;
  turnCount: number;
  shareOfSpeech: number;
}

export interface CameraFaceSummary {
  track: number;
  seconds: number;
  shareOfCoverage: number;
  box: [number, number, number, number];
  /** Face width as a percentage of the video frame width (higher = tighter close-up). */
  widthPct: number;
  /** Face height as a percentage of the video frame height. */
  heightPct: number;
  /** Horizontal center position in the frame. */
  position: "left" | "center" | "right";
  confidence: number;
  yaw?: number;
}

export interface FaceTrackReading {
  track: number;
  start: number;
  end: number;
  seconds: number;
  box: [number, number, number, number];
  eyes: [number, number];
  confidence: number;
}

export interface FaceSpanReading {
  track: number;
  start: number;
  end: number;
  yaw: number;
}

export interface MouthActivityReading {
  mediaId: string;
  sampleRate: number;
  faces: Array<{
    track: number;
    box: [number, number, number, number];
    mouth: [number, number, number, number];
    seconds: number;
    confidence: number;
    stretches: Array<{ from: number; to: number; values: number[] }>;
  }>;
  done: boolean;
  error?: string;
}

export interface SpeakerCameraEvidence {
  speaker: string;
  /** True when this speaker's audio comes directly from this camera's own recording. */
  directMicMatch?: boolean;
  /** Per-face mouth movement measured during this speaker's solo turns vs other speakers' solo turns. */
  mouthActivity?: {
    faceTrack: number;
    duringOwnTurns: number;
    duringOtherTurns: number;
    ratio: number;
    correlation: number;
    samplesOwn: number;
    samplesOther: number;
  };
  /** Camera's own scratch audio level during this speaker's solo turns vs other speakers' solo turns. */
  scratchAudio?: {
    duringOwnTurnsDb: number;
    duringOtherTurnsDb: number;
    advantageDb: number;
  };
  /** Qualitative strength of the measured evidence (evidence summary, not a binding assignment). */
  strength: "high" | "medium" | "low";
}

export interface CameraAnalysisReport {
  mediaId: string;
  name: string;
  trackId: string;
  coveredSeconds: number;
  coverage: TimeRange[];
  prominentFaceCount: number;
  faces: CameraFaceSummary[];
  /** Measured correlation evidence for each detected speaker, strongest first. */
  speakerEvidence: SpeakerCameraEvidence[];
}

/** Merge touching or overlapping timeline ranges into sorted intervals. */
function mergeIntervals(ranges: readonly TimeRange[], gap = MEET): TimeRange[] {
  const sorted = [...ranges].filter(r => r.end > r.start + EPS).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const prev = out.at(-1);
    if (prev && r.start <= prev.end + gap) prev.end = Math.max(prev.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** Discover all synced camera video angles on the timeline (preferring hidden reference tracks over switched Program clips). */
export function discoverMulticamCameras(timeline: Timeline, media: readonly MediaAsset[]): CameraAngleInfo[] {
  const assets = new Map(media.map(m => [m.id, m]));
  // Prefer hidden synced reference tracks (`mc_*`) per mediaId since they hold full coverage even after switching.
  const byMedia = new Map<string, { trackId: string; hidden: boolean; clips: MediaClip[] }>();
  const videoTracks = timeline.tracks.filter(t => t.kind === "video");
  // Pass 1: hidden reference tracks first.
  for (const track of videoTracks) {
    if (!track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false) continue;
      if (assets.get(clip.mediaId)?.kind !== "video") continue;
      const cur = byMedia.get(clip.mediaId);
      if (!cur) byMedia.set(clip.mediaId, { trackId: track.id, hidden: true, clips: [clip] });
      else if (cur.trackId === track.id) cur.clips.push(clip);
    }
  }
  // Pass 2: visible video tracks for any camera without a hidden reference track.
  for (const track of videoTracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false) continue;
      if (assets.get(clip.mediaId)?.kind !== "video") continue;
      const cur = byMedia.get(clip.mediaId);
      if (!cur) byMedia.set(clip.mediaId, { trackId: track.id, hidden: false, clips: [clip] });
      else if (!cur.hidden && cur.trackId === track.id) cur.clips.push(clip);
    }
  }

  return [...byMedia.entries()].map(([mediaId, info]) => {
    const clips = [...info.clips].sort((a, b) => a.timelineIn - b.timelineIn);
    const coverage = mergeIntervals(clips.map(c => ({ start: c.timelineIn, end: clipEnd(c) })), 0.01)
      .map(r => ({ start: round3(r.start), end: round3(r.end) }));
    const coveredSeconds = round3(coverage.reduce((sum, r) => sum + (r.end - r.start), 0));
    return {
      mediaId,
      name: assets.get(mediaId)?.name ?? mediaId,
      trackId: info.trackId,
      hidden: info.hidden,
      clips,
      coverage,
      coveredSeconds,
    };
  });
}

/** Discover all audible audio sources playing on the timeline (unmuted tracks with enabled clips at volume > 0). */
export function discoverAudibleSources(timeline: Timeline, media: readonly MediaAsset[]): AudibleSourceInfo[] {
  const assets = new Map(media.map(m => [m.id, m]));
  const byTrackMedia = new Map<string, AudibleSourceInfo>();
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.enabled === false || !(clip.volume > 0)) continue;
      const asset = assets.get(clip.mediaId);
      if (!asset || !carriesAudio(asset)) continue;
      const key = `${track.id}\0${clip.mediaId}`;
      let entry = byTrackMedia.get(key);
      if (!entry) {
        entry = {
          mediaId: clip.mediaId,
          name: asset.name ?? clip.mediaId,
          trackId: track.id,
          trackName: track.name,
          clips: [],
          coveredSeconds: 0,
        };
        byTrackMedia.set(key, entry);
      }
      entry.clips.push(clip);
      entry.coveredSeconds = round3(entry.coveredSeconds + (clipEnd(clip) - clip.timelineIn));
    }
  }
  for (const entry of byTrackMedia.values()) entry.clips.sort((a, b) => a.timelineIn - b.timelineIn);
  return [...byTrackMedia.values()];
}

/**
 * Group diarized timeline transcript words into speaker turns and identify overlapping speech (crosstalk).
 * Merges consecutive words from the same speaker across short intra-turn pauses (<= `maxPauseSeconds`).
 */
export function turnsFromTranscripts(
  timeline: Timeline,
  transcripts: Map<string, TranscriptWord[]>,
  audibleSources: readonly AudibleSourceInfo[],
  opts: { range?: TimeRange; maxPauseSeconds?: number } = {},
): { turns: SpeakerTurn[]; crosstalk: CrosstalkSpan[]; speakers: SpeakerSummary[] } {
  const maxPause = opts.maxPauseSeconds ?? 1.5;
  const words = timelineWords(timeline, transcripts, opts.range);
  if (!words.length) return { turns: [], crosstalk: [], speakers: [] };

  // When multiple distinct audible mics are transcribed and words lack speaker diarization labels,
  // use each mic's track/asset name as the speaker label so per-mic transcripts stay distinct.
  const distinctAudibleMedia = new Set(audibleSources.map(s => s.mediaId));
  const labelForMedia = new Map(audibleSources.map(s => [s.mediaId, s.trackName || s.name]));
  const speakerOf = (w: (typeof words)[number]) => {
    if (distinctAudibleMedia.size >= 2) {
      return w.speaker && !/^Speaker \d+$/.test(w.speaker) ? w.speaker : (labelForMedia.get(w.mediaId) ?? w.speaker ?? w.mediaId);
    }
    return w.speaker ?? labelForMedia.get(w.mediaId) ?? "Speaker 1";
  };

  // Build per-speaker continuous runs first so simultaneous speech from two speakers is preserved cleanly.
  const bySpeaker = new Map<string, Array<{ from: number; to: number; sourceMediaId: string; texts: string[] }>>();
  for (const w of words) {
    const spk = speakerOf(w);
    const list = bySpeaker.get(spk) ?? [];
    const last = list.at(-1);
    if (last && last.sourceMediaId === w.mediaId && w.start - last.to <= maxPause) {
      last.to = Math.max(last.to, w.end);
      last.texts.push(w.text);
    } else {
      list.push({ from: w.start, to: Math.max(w.start + 0.05, w.end), sourceMediaId: w.mediaId, texts: [w.text] });
    }
    bySpeaker.set(spk, list);
  }

  const rawTurns: SpeakerTurn[] = [];
  for (const [speaker, runs] of bySpeaker) {
    for (const r of runs) {
      const full = r.texts.join(" ").trim();
      const preview = full.length > 90 ? `${full.slice(0, 87)}…` : full;
      rawTurns.push({
        from: round3(r.from),
        to: round3(r.to),
        duration: round3(r.to - r.from),
        speaker,
        sourceMediaId: r.sourceMediaId,
        words: r.texts.length,
        text: preview,
      });
    }
  }
  rawTurns.sort((a, b) => a.from - b.from || a.to - b.to);

  // Detect crosstalk: stretches where 2+ distinct speakers' turns overlap by at least 0.2 s.
  const crosstalk = findCrosstalk(rawTurns, 0.2);
  markOverlaps(rawTurns, crosstalk);

  return { turns: rawTurns, crosstalk, speakers: summarizeSpeakers(rawTurns) };
}

/**
 * Derive active speaker turns and crosstalk directly from isolated multi-mic waveform levels
 * (e.g., Host mic on A1 and Guest mic on A2). Works even before transcription finishes or when
 * a diarizer isn't needed because each person has their own microphone.
 */
export function turnsFromIsolatedMics(
  audibleSources: readonly AudibleSourceInfo[],
  levelsByMedia: ReadonlyMap<string, { peaks: ArrayLike<number>; sampleRate: number }>,
  opts: { range?: TimeRange; stepSeconds?: number; minTurnSeconds?: number; bleedMarginDb?: number } = {},
): { turns: SpeakerTurn[]; crosstalk: CrosstalkSpan[]; speakers: SpeakerSummary[] } {
  if (audibleSources.length < 2) return { turns: [], crosstalk: [], speakers: [] };
  const step = opts.stepSeconds ?? 0.2;
  const minTurn = opts.minTurnSeconds ?? 0.4;
  const bleedMarginDb = opts.bleedMarginDb ?? 6;

  const start = opts.range?.start ?? Math.min(...audibleSources.flatMap(s => s.clips.map(c => c.timelineIn)));
  const end = opts.range?.end ?? Math.max(...audibleSources.flatMap(s => s.clips.map(c => clipEnd(c))));
  if (!(end > start + step)) return { turns: [], crosstalk: [], speakers: [] };

  const count = Math.floor((end - start) / step);
  // Measure each mic's level (in dBFS) per `step` bin and estimate its noise floor (15th percentile).
  const series = audibleSources.map(src => {
    const data = levelsByMedia.get(src.mediaId);
    const db = new Float64Array(count).fill(-96);
    if (data && data.peaks.length) {
      const sr = data.sampleRate;
      for (let i = 0; i < count; i++) {
        const t0 = start + i * step;
        const t1 = t0 + step;
        const clip = src.clips.find(c => c.timelineIn < t1 - EPS && clipEnd(c) > t0 + EPS);
        if (!clip) continue;
        const s0 = Math.max(0, Math.floor(sourceAt(clip, Math.max(t0, clip.timelineIn)) * sr));
        const s1 = Math.min(data.peaks.length, Math.ceil(sourceAt(clip, Math.min(t1, clipEnd(clip))) * sr));
        if (s1 <= s0) continue;
        let sumSq = 0;
        for (let k = s0; k < s1; k++) { const v = data.peaks[k]!; sumSq += v * v; }
        const rms = Math.sqrt(sumSq / (s1 - s0));
        db[i] = dbfs(rms * clip.volume);
      }
    }
    const sorted = [...db].filter(v => v > -95).sort((a, b) => a - b);
    const floorDb = sorted.length ? sorted[Math.floor(sorted.length * 0.15)]! : -60;
    const peakDb = sorted.length ? sorted[Math.floor(sorted.length * 0.95)]! : -20;
    // Active speech threshold: at least 12 dB above room floor, capped at -42 dBFS floor.
    const activeThreshold = Math.max(-42, Math.min(peakDb - 14, floorDb + 12));
    return { src, speaker: src.trackName || src.name, db, floorDb, activeThreshold };
  });

  // For each time bin, determine which mics are speaking (above their own threshold AND within bleed margin of the loudest mic).
  const activePerMic = series.map(() => new Uint8Array(count));
  for (let i = 0; i < count; i++) {
    let loudest = -96;
    for (const s of series) if (s.db[i]! > loudest) loudest = s.db[i]!;
    for (let m = 0; m < series.length; m++) {
      const s = series[m]!;
      if (s.db[i]! >= s.activeThreshold && s.db[i]! >= loudest - bleedMarginDb) {
        activePerMic[m]![i] = 1;
      }
    }
  }

  // Smooth brief 1-2 bin pauses inside a mic's speaking run (up to 0.6 s) into turns.
  const bridgeBins = Math.max(1, Math.round(0.6 / step));
  const rawTurns: SpeakerTurn[] = [];
  for (let m = 0; m < series.length; m++) {
    const active = activePerMic[m]!;
    let runStart = -1;
    let lastOn = -1;
    for (let i = 0; i < count; i++) {
      if (active[i]) {
        if (runStart < 0) runStart = i;
        lastOn = i;
      } else if (runStart >= 0 && i - lastOn > bridgeBins) {
        const from = start + runStart * step;
        const to = start + (lastOn + 1) * step;
        if (to - from >= minTurn) {
          rawTurns.push({
            from: round3(from),
            to: round3(to),
            duration: round3(to - from),
            speaker: series[m]!.speaker,
            sourceMediaId: series[m]!.src.mediaId,
          });
        }
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      const from = start + runStart * step;
      const to = start + (lastOn + 1) * step;
      if (to - from >= minTurn) {
        rawTurns.push({
          from: round3(from),
          to: round3(to),
          duration: round3(to - from),
          speaker: series[m]!.speaker,
          sourceMediaId: series[m]!.src.mediaId,
        });
      }
    }
  }
  rawTurns.sort((a, b) => a.from - b.from || a.to - b.to);
  const crosstalk = findCrosstalk(rawTurns, 0.3);
  markOverlaps(rawTurns, crosstalk);
  return { turns: rawTurns, crosstalk, speakers: summarizeSpeakers(rawTurns) };
}

function findCrosstalk(turns: readonly SpeakerTurn[], minOverlap: number): CrosstalkSpan[] {
  const edges = [...new Set(turns.flatMap(t => [t.from, t.to]))].sort((a, b) => a - b);
  const spans: CrosstalkSpan[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i]!, b = edges[i + 1]!;
    if (b - a <= EPS) continue;
    const mid = (a + b) / 2;
    const active = [...new Set(turns.filter(t => t.from <= mid && t.to > mid).map(t => t.speaker))].sort();
    if (active.length < 2) continue;
    const prev = spans.at(-1);
    if (prev && Math.abs(prev.to - a) <= 0.05 && prev.speakers.join("\0") === active.join("\0")) {
      prev.to = round3(b);
      prev.duration = round3(prev.to - prev.from);
    } else {
      spans.push({ from: round3(a), to: round3(b), duration: round3(b - a), speakers: active });
    }
  }
  return spans.filter(s => s.duration >= minOverlap);
}

function markOverlaps(turns: SpeakerTurn[], crosstalk: readonly CrosstalkSpan[]) {
  for (const t of turns) {
    if (crosstalk.some(c => c.from < t.to - EPS && c.to > t.from + EPS)) t.hasOverlap = true;
  }
}

function summarizeSpeakers(turns: readonly SpeakerTurn[]): SpeakerSummary[] {
  const stats = new Map<string, { seconds: number; count: number; media: Set<string> }>();
  for (const t of turns) {
    const cur = stats.get(t.speaker) ?? { seconds: 0, count: 0, media: new Set() };
    cur.seconds += t.duration;
    cur.count++;
    cur.media.add(t.sourceMediaId);
    stats.set(t.speaker, cur);
  }
  const total = [...stats.values()].reduce((s, v) => s + v.seconds, 0) || 1;
  return [...stats.entries()]
    .map(([speaker, v]) => ({
      speaker,
      sourceMediaIds: [...v.media],
      speakingSeconds: round2(v.seconds),
      turnCount: v.count,
      shareOfSpeech: round2(v.seconds / total),
    }))
    .sort((a, b) => b.speakingSeconds - a.speakingSeconds);
}

/**
 * Compute non-overlapping solo speaking stretches for each speaker (excluding crosstalk)
 * so camera mouth movement and scratch audio are compared on clean, unambiguous speech.
 */
export function soloSpeakingRanges(turns: readonly SpeakerTurn[], crosstalk: readonly CrosstalkSpan[]): Map<string, TimeRange[]> {
  const bySpeaker = new Map<string, TimeRange[]>();
  for (const t of turns) {
    let pieces: TimeRange[] = [{ start: t.from, end: t.to }];
    for (const c of crosstalk) {
      if (c.to <= t.from || c.from >= t.to) continue;
      pieces = pieces.flatMap(p => {
        if (c.to <= p.start || c.from >= p.end) return [p];
        const next: TimeRange[] = [];
        if (c.from > p.start + 0.1) next.push({ start: p.start, end: c.from });
        if (c.to < p.end - 0.1) next.push({ start: c.to, end: p.end });
        return next;
      });
    }
    const list = bySpeaker.get(t.speaker) ?? [];
    for (const p of pieces) if (p.end - p.start >= 0.3) list.push(p);
    bySpeaker.set(t.speaker, list);
  }
  for (const [spk, list] of bySpeaker) bySpeaker.set(spk, mergeIntervals(list, 0.05));
  return bySpeaker;
}

/**
 * Choose up to `maxStretches` timeline windows (each up to `stretchSeconds`) that together
 * cover solo speaking turns for every detected speaker, prioritizing stretches where speakers
 * alternate so mouth-movement contrast is clearest.
 */
export function selectMouthActivityStretches(
  turns: readonly SpeakerTurn[],
  crosstalk: readonly CrosstalkSpan[],
  totalDuration: number,
  maxStretches = 4,
  stretchSeconds = 15,
): TimeRange[] {
  const solo = soloSpeakingRanges(turns, crosstalk);
  const speakers = [...solo.keys()];
  if (!speakers.length || !(totalDuration > 1)) return [];

  // Candidate windows centered on speaker-change boundaries and on each speaker's longest solo turns.
  const candidates: TimeRange[] = [];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i]!.speaker !== turns[i - 1]!.speaker) {
      const mid = (turns[i - 1]!.to + turns[i]!.from) / 2;
      const start = Math.max(0, Math.min(totalDuration - stretchSeconds, mid - stretchSeconds / 2));
      const end = Math.min(totalDuration, start + stretchSeconds);
      if (end - start >= 2) candidates.push({ start: round3(start), end: round3(end) });
    }
  }
  for (const ranges of solo.values()) {
    const longest = [...ranges].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 3);
    for (const r of longest) {
      const mid = (r.start + r.end) / 2;
      const start = Math.max(0, Math.min(totalDuration - stretchSeconds, mid - stretchSeconds / 2));
      const end = Math.min(totalDuration, start + stretchSeconds);
      if (end - start >= 2) candidates.push({ start: round3(start), end: round3(end) });
    }
  }
  if (!candidates.length) return [{ start: 0, end: round3(Math.min(totalDuration, stretchSeconds)) }];

  // Greedy set-cover: pick windows that maximize uncovered solo seconds across the least-covered speakers.
  const coveredBySpeaker = new Map<string, number>(speakers.map(s => [s, 0]));
  const picked: TimeRange[] = [];
  const overlapLen = (a: TimeRange, b: TimeRange) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

  for (let k = 0; k < maxStretches; k++) {
    let best: TimeRange | undefined;
    let bestScore = 0;
    for (const cand of candidates) {
      if (picked.some(p => overlapLen(p, cand) > 2)) continue;
      let score = 0;
      let speakersPresent = 0;
      for (const spk of speakers) {
        const secs = (solo.get(spk) ?? []).reduce((n, r) => n + overlapLen(cand, r), 0);
        if (secs >= 0.5) speakersPresent++;
        const need = 1 / (1 + (coveredBySpeaker.get(spk) ?? 0));
        score += secs * need;
      }
      // Slight bonus for windows showing 2+ speakers alternating in the same stretch.
      if (speakersPresent >= 2) score *= 1.35;
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    if (!best) break;
    picked.push(best);
    for (const spk of speakers) {
      const secs = (solo.get(spk) ?? []).reduce((n, r) => n + overlapLen(best, r), 0);
      coveredBySpeaker.set(spk, (coveredBySpeaker.get(spk) ?? 0) + secs);
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** Map timeline windows onto a camera's source seconds (only where the camera has continuous clips). */
export function mapStretchesToCameraSource(camera: CameraAngleInfo, timelineWindows: readonly TimeRange[]): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const win of timelineWindows) {
    for (const clip of camera.clips) {
      const lo = Math.max(win.start, clip.timelineIn);
      const hi = Math.min(win.end, clipEnd(clip));
      if (hi - lo < 1) continue;
      const from = round3(sourceAt(clip, lo));
      const to = round3(sourceAt(clip, hi));
      if (to > from + 0.5) out.push({ from, to });
    }
  }
  return out.slice(0, 6);
}

/** Pearson correlation between two equal-length numeric arrays. */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma, y = b[i]! - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 1e-12 && db > 1e-12 ? num / Math.sqrt(da * db) : 0;
}

/** Summarize a camera's prominent faces from `faces` tracks/spans. */
function summarizeCameraFaces(
  camera: CameraAngleInfo,
  tracks: readonly FaceTrackReading[] | undefined,
  spans: readonly FaceSpanReading[] | undefined,
): CameraFaceSummary[] {
  if (!tracks?.length) return [];
  const totalCov = Math.max(camera.coveredSeconds, 1);
  const ranked = [...tracks]
    .filter(t => t.seconds >= 1 && t.confidence >= 0.45)
    .sort((a, b) => b.seconds - a.seconds);
  if (!ranked.length) return [];
  const longest = ranked[0]!.seconds;
  return ranked
    .filter(t => t.seconds >= Math.min(3, longest * 0.2))
    .slice(0, 4)
    .map(t => {
      const [x0, y0, x1, y1] = t.box;
      const cx = (x0 + x1) / 2;
      const position: "left" | "center" | "right" = cx < 0.38 ? "left" : cx > 0.62 ? "right" : "center";
      const trackSpans = spans?.filter(s => s.track === t.track) ?? [];
      let yaw: number | undefined;
      if (trackSpans.length) {
        const yaws = trackSpans.map(s => s.yaw).sort((a, b) => a - b);
        yaw = yaws[Math.floor(yaws.length / 2)]!;
      }
      return {
        track: t.track,
        seconds: round2(t.seconds),
        shareOfCoverage: round2(Math.min(1, t.seconds / totalCov)),
        box: t.box,
        widthPct: pct1(x1 - x0),
        heightPct: pct1(y1 - y0),
        position,
        confidence: round2(t.confidence),
        ...(yaw !== undefined && { yaw }),
      };
    });
}

/**
 * Combine face composition, per-face mouth movement, camera scratch audio, and direct audio
 * ownership into objective speaker-to-camera evidence for each camera angle.
 */
export function correlateSpeakersToCameras(params: {
  cameras: readonly CameraAngleInfo[];
  speakers: readonly SpeakerSummary[];
  turns: readonly SpeakerTurn[];
  crosstalk: readonly CrosstalkSpan[];
  facesByCamera: ReadonlyMap<string, { tracks: readonly FaceTrackReading[]; spans?: readonly FaceSpanReading[] }>;
  mouthByCamera?: ReadonlyMap<string, MouthActivityReading>;
  scratchLevelsByCamera?: ReadonlyMap<string, { peaks: ArrayLike<number>; sampleRate: number }>;
}): CameraAnalysisReport[] {
  const { cameras, speakers, turns, crosstalk, facesByCamera, mouthByCamera, scratchLevelsByCamera } = params;
  const solo = soloSpeakingRanges(turns, crosstalk);
  const inRanges = (ranges: readonly TimeRange[], t: number) => ranges.some(r => t >= r.start - EPS && t < r.end + EPS);

  return cameras.map(camera => {
    const faceData = facesByCamera.get(camera.mediaId);
    const faces = summarizeCameraFaces(camera, faceData?.tracks, faceData?.spans);
    const mouth = mouthByCamera?.get(camera.mediaId);
    const scratch = scratchLevelsByCamera?.get(camera.mediaId);

    // Map a camera source second to its timeline second using the camera's clips.
    const sourceToTl = (srcSec: number): number | undefined => {
      for (const c of camera.clips) {
        if (srcSec >= c.sourceIn - 0.05 && srcSec <= c.sourceOut + 0.05) {
          return c.timelineIn + (srcSec - c.sourceIn) / (c.speed ?? 1);
        }
      }
      return undefined;
    };

    const evidenceList: SpeakerCameraEvidence[] = [];
    for (const spk of speakers) {
      const ownRanges = solo.get(spk.speaker) ?? [];
      const otherRanges = [...solo.entries()].filter(([k]) => k !== spk.speaker).flatMap(([, v]) => v);
      const directMicMatch = spk.sourceMediaIds.includes(camera.mediaId);

      // 1. Mouth activity evidence (check every measured face on this camera and pick the best matching face).
      let bestMouth: SpeakerCameraEvidence["mouthActivity"] | undefined;
      if (mouth?.faces.length && ownRanges.length) {
        for (const f of mouth.faces) {
          const ownVals: number[] = [];
          const otherVals: number[] = [];
          const motionSeries: number[] = [];
          const spkIndicator: number[] = [];
          for (const st of f.stretches) {
            const dt = (st.to - st.from) / Math.max(1, st.values.length);
            for (let i = 0; i < st.values.length; i++) {
              const tlTime = sourceToTl(st.from + (i + 0.5) * dt);
              if (tlTime === undefined) continue;
              const val = st.values[i]!;
              const isOwn = inRanges(ownRanges, tlTime);
              const isOther = inRanges(otherRanges, tlTime);
              if (isOwn) {
                ownVals.push(val);
                motionSeries.push(val);
                spkIndicator.push(1);
              } else if (isOther) {
                otherVals.push(val);
                motionSeries.push(val);
                spkIndicator.push(0);
              }
            }
          }
          if (ownVals.length < 3) continue;
          const meanOwn = ownVals.reduce((a, b) => a + b, 0) / ownVals.length;
          const meanOther = otherVals.length ? otherVals.reduce((a, b) => a + b, 0) / otherVals.length : 0;
          const ratio = meanOther > 1e-4 ? meanOwn / meanOther : (meanOwn > 0.5 ? 2 : 1);
          const corr = otherVals.length >= 3 ? pearson(motionSeries, spkIndicator) : 0;
          if (!bestMouth || corr > bestMouth.correlation || (Math.abs(corr - bestMouth.correlation) < 0.05 && ratio > bestMouth.ratio)) {
            bestMouth = {
              faceTrack: f.track,
              duringOwnTurns: round2(meanOwn),
              duringOtherTurns: round2(meanOther),
              ratio: round2(ratio),
              correlation: round2(corr),
              samplesOwn: ownVals.length,
              samplesOther: otherVals.length,
            };
          }
        }
      }

      // 2. Camera scratch audio level advantage during speaker's solo turns vs other speakers' solo turns.
      let scratchAudio: SpeakerCameraEvidence["scratchAudio"] | undefined;
      if (scratch && scratch.peaks.length && ownRanges.length && otherRanges.length) {
        const meanDbOver = (ranges: readonly TimeRange[]) => {
          let sumSq = 0;
          let n = 0;
          for (const r of ranges) {
            for (const c of camera.clips) {
              const lo = Math.max(r.start, c.timelineIn);
              const hi = Math.min(r.end, clipEnd(c));
              if (hi - lo < 0.1) continue;
              const s0 = Math.max(0, Math.floor(sourceAt(c, lo) * scratch.sampleRate));
              const s1 = Math.min(scratch.peaks.length, Math.ceil(sourceAt(c, hi) * scratch.sampleRate));
              for (let k = s0; k < s1; k++) { const v = scratch.peaks[k]!; sumSq += v * v; n++; }
            }
          }
          return n > 0 ? dbfs(Math.sqrt(sumSq / n)) : undefined;
        };
        const ownDb = meanDbOver(ownRanges);
        const otherDb = meanDbOver(otherRanges);
        if (ownDb !== undefined && otherDb !== undefined && ownDb > -80) {
          scratchAudio = {
            duringOwnTurnsDb: round2(ownDb),
            duringOtherTurnsDb: round2(otherDb),
            advantageDb: round2(ownDb - otherDb),
          };
        }
      }

      // Qualitative strength summary based purely on the measurements above.
      let strength: "high" | "medium" | "low" = "low";
      if (
        directMicMatch ||
        (bestMouth && bestMouth.correlation >= 0.35 && bestMouth.ratio >= 1.35) ||
        (scratchAudio && scratchAudio.advantageDb >= 6)
      ) {
        strength = "high";
      } else if (
        (bestMouth && (bestMouth.correlation >= 0.18 || bestMouth.ratio >= 1.2)) ||
        (scratchAudio && scratchAudio.advantageDb >= 3)
      ) {
        strength = "medium";
      }

      if (directMicMatch || bestMouth || scratchAudio) {
        evidenceList.push({
          speaker: spk.speaker,
          ...(directMicMatch && { directMicMatch: true }),
          ...(bestMouth && { mouthActivity: bestMouth }),
          ...(scratchAudio && { scratchAudio }),
          strength,
        });
      }
    }

    const scoreOf = (e: SpeakerCameraEvidence) =>
      (e.directMicMatch ? 10 : 0) +
      (e.mouthActivity ? e.mouthActivity.correlation * 4 + (e.mouthActivity.ratio - 1) : 0) +
      (e.scratchAudio ? e.scratchAudio.advantageDb / 6 : 0);
    evidenceList.sort((a, b) => scoreOf(b) - scoreOf(a));

    return {
      mediaId: camera.mediaId,
      name: camera.name,
      trackId: camera.trackId,
      coveredSeconds: camera.coveredSeconds,
      coverage: camera.coverage,
      prominentFaceCount: faces.length,
      faces,
      speakerEvidence: evidenceList,
    };
  });
}

/** Helper to read timeline duration cleanly. */
export function multicamDuration(timeline: Timeline): number {
  return round3(timelineDuration(timeline));
}
