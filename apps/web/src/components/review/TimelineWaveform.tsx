import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { clipEnd, timelineToSource, type MediaAsset, type Timeline } from "@scarlet/timeline";
import type { WaveformResponse } from "@scarlet/shared";
import { originalClipAt } from "./thumbs";
import { api } from "../../lib/client";
import { useArrival, wavePhase } from "./laneLoading";

type Span = { id: string; start: number; end: number; sourceIn: number; speed: number; gain: number; fadeIn: number; fadeOut: number; ingesting?: boolean };
/**
 * scaleWith: another version on the same clock, such as the other side of a Before/After comparison.
 * Both share one scale, so a level change shows as a change in height instead of being normalized away.
 */
export type WaveformMedia = { source?: MediaAsset; timeline?: Timeline | null; media: MediaAsset[]; mediaPaused?: boolean; original?: boolean; scaleWith?: Timeline | null;
  /** Draw this version's sound instead of the timeline's own, on the same clock. Before uses it for an edit that moves nothing. */
  audioFrom?: Timeline | null };

function audioSpans({ source, timeline, media, original }: WaveformMedia, start: number, end: number): Span[] {
  const hasSound = (m: MediaAsset) => m.hasAudio !== false && (m.kind === "video" || m.kind === "audio") && m.status !== "failed";
  if (source) return hasSound(source) && start < (source.duration ?? end)
    ? [{ id: source.id, start: 0, end: source.duration ?? end, sourceIn: 0, speed: 1, gain: 1, fadeIn: 0, fadeOut: 0, ingesting: source.status === "ingesting" }] : [];
  const assets = new Map(media.filter(hasSound).map(m => [m.id, m]));
  const spans: Span[] = [];
  if (!timeline) return spans;
  if (original) {
    const boundaries = new Set([start, end]);
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        for (const t of [clip.timelineIn, clipEnd(clip)]) if (t > start && t < end) boundaries.add(t);
      }
    }
    const edges = [...boundaries].sort((a, b) => a - b);
    for (let i = 1; i < edges.length; i++) {
      const from = edges[i - 1]!, to = edges[i]!;
      const clip = originalClipAt(timeline, (from + to) / 2, media);
      if (clip?.kind !== "media") continue;
      const asset = assets.get(clip.mediaId);
      if (asset) {
        spans.push({ id: asset.id, start: from, end: to, sourceIn: timelineToSource(clip, from), speed: clip.speed, gain: 1, fadeIn: 0, fadeOut: 0, ingesting: asset.status === "ingesting" });
      }
    }
    return spans;
  }
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || !clip.enabled || !clip.volume) continue;
      const asset = assets.get(clip.mediaId);
      const out = clipEnd(clip);
      if (!asset || clip.timelineIn >= end || out <= start) continue;
      spans.push({ id: clip.mediaId, start: clip.timelineIn, end: out, sourceIn: clip.sourceIn,
        speed: clip.speed, gain: clip.volume, fadeIn: clip.audioFadeIn, fadeOut: clip.audioFadeOut, ingesting: asset.status === "ingesting" });
    }
  }
  return spans;
}

// Completed and in-flight source windows are shared by the cut and comparison views.
const peakCache = new Map<string, Promise<WaveformResponse>>();
function sourcePeaks(id: string, from: number, to: number) {
  const key = JSON.stringify([id, from, to]);
  const cached = peakCache.get(key);
  if (cached) return cached;
  const points = Math.min(8192, Math.max(128, Math.ceil((to - from) * 100)));
  const read = api.waveform(id, from, to, points).catch(error => {
    if (peakCache.get(key) === read) peakCache.delete(key);
    throw error;
  });
  if (peakCache.size >= 32) peakCache.delete(peakCache.keys().next().value!);
  peakCache.set(key, read);
  return read;
}

/** Read each recording once per visible window, even when a dialogue edit has hundreds of cuts. */
async function readPeaks(spans: Span[], start: number, end: number, cancelled: () => boolean) {
  const windows = new Map<string, { from: number; to: number }>();
  for (const span of spans) {
    if (span.ingesting) continue;
    const from = span.sourceIn + (Math.max(start, span.start) - span.start) * span.speed;
    const to = span.sourceIn + (Math.min(end, span.end) - span.start) * span.speed;
    if (to <= from) continue;
    const existing = windows.get(span.id);
    windows.set(span.id, { from: Math.min(existing?.from ?? from, from), to: Math.max(existing?.to ?? to, to) });
  }
  const results = new Map<string, WaveformResponse>();
  const queue = windows.entries();
  async function read() {
    for (const [id, { from, to }] of queue) {
      if (cancelled()) return;
      try {
        results.set(id, await sourcePeaks(id, from, to));
      } catch { /* Missing audio must not block video scrubbing. */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, windows.size) }, read));
  return results;
}

export function waveformBars(spans: Span[], waves: Map<string, WaveformResponse>, start: number, duration: number, count: number) {
  const peaks = new Float32Array(count);
  const energy = new Float32Array(count);
  const cutEdges = new Map<number, { time: number; delta: number }[]>();
  const step = duration / count;
  for (const span of spans) {
    const wave = waves.get(span.id);
    if (!wave?.peaks.length || wave.to <= wave.from || step <= 0) continue;
    const samplesPerSecond = wave.peaks.length / (wave.to - wave.from);
    const first = Math.max(0, Math.floor((span.start - start) / step));
    const last = Math.min(count, Math.ceil((span.end - start) / step));
    for (let i = first; i < last; i++) {
      const a = Math.max(span.start, start + i * step);
      const b = Math.min(span.end, start + (i + 1) * step);
      const sampleAt = (t: number) => (span.sourceIn + (t - span.start) * span.speed - wave.from) * samplesPerSecond;
      const lo = Math.max(0, Math.floor(sampleAt(a)));
      const hi = Math.min(wave.peaks.length, Math.ceil(sampleAt(b)));
      let peak = 0;
      let sumSquares = 0;
      for (let k = lo; k < hi; k++) {
        peak = Math.max(peak, wave.peaks[k]!);
        sumSquares += (wave.rms?.[k] ?? 0) ** 2;
      }
      const mid = (a + b) / 2;
      const fade = Math.min(1, span.fadeIn ? (mid - span.start) / span.fadeIn : 1, span.fadeOut ? (span.end - mid) / span.fadeOut : 1);
      const gain = span.gain * fade;
      const amplitude = peak * gain;
      if (a > start + i * step || b < start + (i + 1) * step) {
        // Two clips meeting inside one pixel are consecutive, not twice as loud.
        const edges = cutEdges.get(i) ?? [];
        edges.push({ time: a, delta: amplitude }, { time: b, delta: -amplitude });
        cutEdges.set(i, edges);
      } else peaks[i] = Math.min(1, peaks[i]! + amplitude);
      if (hi > lo) energy[i] = energy[i]! + gain ** 2 * sumSquares / (hi - lo) * (b - a) / step;
    }
  }
  for (const [i, edges] of cutEdges) {
    let level = 0, max = 0;
    for (const edge of edges.sort((a, b) => a.time - b.time || a.delta - b.delta)) {
      level += edge.delta;
      max = Math.max(max, level);
    }
    peaks[i] = Math.min(1, peaks[i]! + max);
  }
  return { peaks, rms: energy.map((value, i) => Math.min(peaks[i]!, Math.sqrt(value))) };
}

/**
 * Bar height per unit of level. Use the lane height for quiet recordings while leaving near-silence quiet.
 * With a reference (the other side of Before/After), both share the louder one's scale.
 */
export function waveformScale(peaks: ArrayLike<number>, reference?: ArrayLike<number>) {
  let loudest = 0.25;
  for (const set of [peaks, reference ?? []]) for (let i = 0; i < set.length; i++) loudest = Math.max(loudest, set[i]!);
  return 46 / loudest;
}

function barsPath(samples: Float32Array, scale: number) {
  return Array.from(samples, (sample, i) => {
    const height = sample * scale;
    return height > 0 ? `M${i + .5},${(50 - height).toFixed(2)}v${(2 * height).toFixed(2)}` : "";
  }).join("");
}

export const TimelineWaveform = memo(function TimelineWaveform({ timeline, source, media, mediaPaused, original, scaleWith, audioFrom, start, duration,
  visibleStart = start, visibleSpan = duration, hold, onLoading }: WaveformMedia & { start: number; duration: number; visibleStart?: number; visibleSpan?: number;
  /** Keep the ripple a moment longer while the picture lane is about to land, so both arrive together. */
  hold?: boolean; onLoading?(loading: boolean): void }) {
  const lane = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const shown = useMemo(() => audioSpans({ timeline: audioFrom ?? timeline, source, media, original }, start, start + duration), [audioFrom, timeline, source, media, original, start, duration]);
  const reference = useMemo(() => scaleWith && !source ? audioSpans({ timeline: scaleWith, media }, start, start + duration) : [],
    [scaleWith, source, media, start, duration]);
  // One read covers both versions; the reference only sets the scale.
  const spans = useMemo(() => reference.length ? [...shown, ...reference] : shown, [shown, reference]);
  const preparing = useMemo(() => spans.some(span => span.ingesting), [spans]);
  const [loaded, setLoaded] = useState<{ spans: Span[]; waves: Map<string, WaveformResponse> }>();
  useLayoutEffect(() => {
    const el = lane.current!;
    const measure = () => setCount(Math.min(1600, Math.ceil(el.clientWidth / 2.4)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let stale = false;
    // Warm the ready sources while the rest import. Draw only once the whole mix is available.
    if (duration > 0 && shown.length) void readPeaks(spans, start, start + duration, () => stale)
      .then(waves => { if (!stale && !preparing) setLoaded({ spans, waves }); });
    return () => { stale = true; };
  }, [spans, shown, preparing, start, duration, mediaPaused]);
  const paths = useMemo(() => {
    if (!count || loaded?.spans !== spans) return;
    const { peaks, rms } = waveformBars(shown, loaded.waves, start, duration, count);
    const other = reference.length ? waveformBars(reference, loaded.waves, start, duration, count).peaks : undefined;
    const scale = waveformScale(peaks, other);
    return { peak: barsPath(peaks, scale), rms: rms.some(sample => sample > 0) ? barsPath(rms, scale) : undefined };
  }, [loaded, spans, shown, reference, count, start, duration]);
  const loading = duration > 0 && shown.length > 0 && loaded?.spans !== spans && !(preparing && mediaPaused);
  useLayoutEffect(() => onLoading?.(loading), [onLoading, loading]);
  const waiting = loading || !!hold;
  const arriving = useArrival(waiting);
  // Each ripple starts at the shared wave's current point, so it moves with the picture lane's glow.
  const phase = useMemo(() => waiting ? wavePhase() : undefined, [waiting]);
  // Project the sampled peaks through the moving viewport while retaining their on-screen stroke width.
  const scale = duration > 0 ? visibleSpan / duration : 1;
  const x = duration > 0 ? (visibleStart - start) / duration * count : 0;
  return <div ref={lane} className={`timeline-waveform${waiting ? " is-loading" : ""}`}
    role={waiting ? "img" : undefined} aria-label={waiting ? "Loading audio waveform" : undefined} aria-hidden={waiting ? undefined : true}>
    {waiting ? <div className="waveform-ripple" style={{ "--wave-phase": phase } as CSSProperties} /> :
      // After a wait the bars grow out of the line the ripple ran along.
      <svg className={arriving ? "is-arriving" : undefined} width="100%" height="100%" viewBox={`${x} 0 ${(count || 1) * scale} 100`} preserveAspectRatio="none">
        <path d={paths?.peak} stroke="currentColor" strokeWidth={0.7 * scale} opacity={paths?.rms ? ".83" : "1"} />
        {paths?.rms && <path d={paths.rms} stroke="currentColor" strokeWidth=".7" />}
        <line x2={count} y1="50" y2="50" stroke="currentColor" opacity=".3" vectorEffect="non-scaling-stroke" />
      </svg>}
  </div>;
});
