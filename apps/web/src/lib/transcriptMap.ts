/**
 * Map transcript words (source-media time) onto the project timeline through
 * the cut list. A word is "kept" if some media clip referencing its media
 * covers it in source time; its timeline position follows that clip.
 * Words no clip keeps are returned with no placements so the UI can show them
 * struck-through.
 */
import type { MediaAsset, MediaClip, Timeline, Transcript, TranscriptWord } from "@scarlet/timeline";

export interface Placement {
  clipId?: string;
  trackId?: string;
  /** Playback seconds in the displayed source or cut. */
  start: number;
  end: number;
}

export interface MappedWord {
  /** Index in the currently displayed word list. */
  index: number;
  segmentId: string;
  /** Position within the original segment, independent of the loaded time range. */
  indexInSegment: number;
  mediaId: string;
  word: TranscriptWord;
  placements: Placement[];
  /** True when no clip keeps this word. */
  cut: boolean;
}

export function mediaClipsFor(timeline: Timeline, mediaId?: string): Array<{ trackId: string; clip: MediaClip }> {
  const out: Array<{ trackId: string; clip: MediaClip }> = [];
  for (const track of timeline.tracks) {
    if (track.kind === "caption" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind === "media" && (!mediaId || clip.mediaId === mediaId) && clip.enabled !== false && clip.volume !== 0) {
        out.push({ trackId: track.id, clip });
      }
    }
  }
  out.sort((a, b) => a.clip.timelineIn - b.clip.timelineIn);
  return out;
}

export function sourceToTimeline(clip: MediaClip, sourceTime: number): number {
  const speed = clip.speed ?? 1;
  return clip.timelineIn + (sourceTime - clip.sourceIn) / speed;
}

export function flattenWords(transcript: Transcript): Array<{ segmentId: string; indexInSegment: number; word: TranscriptWord }> {
  const out: Array<{ segmentId: string; indexInSegment: number; word: TranscriptWord }> = [];
  for (const seg of transcript.segments) {
    if (seg.words.length) {
      for (const [indexInSegment, word] of seg.words.entries()) out.push({ segmentId: seg.id, indexInSegment, word: seg.speaker && !word.speaker ? { ...word, speaker: seg.speaker } : word });
    } else if (seg.text.trim()) {
      // No word timings: spread the segment text evenly so it is still clickable.
      const tokens = seg.text.trim().split(/\s+/);
      const step = (seg.end - seg.start) / tokens.length;
      tokens.forEach((text, i) => {
        out.push({
          segmentId: seg.id,
          indexInSegment: i,
          word: { text, speaker: seg.speaker, start: seg.start + i * step, end: seg.start + (i + 1) * step },
        });
      });
    }
  }
  return out;
}

/**
 * A word is kept by a clip when its midpoint lies within [sourceIn, sourceOut).
 * Using the midpoint avoids flagging words that merely straddle a cut.
 */
export function mapWords(transcript: Transcript, timeline: Timeline, mediaId: string): MappedWord[] {
  const words: MappedWord[] = flattenWords(transcript).map(({ segmentId, indexInSegment, word }, index) => ({
    index, segmentId, indexInSegment, mediaId, word, placements: [], cut: true,
  }));
  const bySource = words.map(w => ({ mid: (w.word.start + w.word.end) / 2, word: w })).sort((a, b) => a.mid - b.mid);
  for (const { trackId, clip } of mediaClipsFor(timeline, mediaId)) {
    let lo = 0;
    let hi = bySource.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bySource[mid]!.mid < clip.sourceIn) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < bySource.length && bySource[i]!.mid < clip.sourceOut; i++) {
      const mapped = bySource[i]!.word;
      const start = sourceToTimeline(clip, Math.max(mapped.word.start, clip.sourceIn));
      const end = sourceToTimeline(clip, Math.min(mapped.word.end, clip.sourceOut));
      mapped.placements.push({ clipId: clip.id, trackId, start, end: Math.max(end, start) });
      mapped.cut = false;
    }
  }
  // Linked video/audio twins at the same time count once; distinct repeats remain seekable.
  for (const mapped of words) {
    if (mapped.placements.length > 1) {
      mapped.placements = mapped.placements.filter((p, i, all) => all.findIndex(q => Math.abs(q.start - p.start) < 1e-6) === i);
    }
  }
  return words;
}

/** Index the placements once. Overlapping speech keeps the first matching word in transcript order. */
export function indexWordTimes(words: MappedWord[]): (time: number) => number {
  const spans = words.flatMap(w => w.placements.map(p => ({ start: p.start, end: p.end, index: w.index })))
    .sort((a, b) => a.start - b.start);
  let furthest = -Infinity;
  const maxEnd = spans.map(p => {
    furthest = Math.max(furthest, p.end);
    return furthest;
  });
  return time => {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (spans[mid]!.start <= time) lo = mid + 1;
      else hi = mid;
    }
    const last = spans[lo - 1];
    if (!last) return -1;
    let active = Infinity;
    for (let i = lo - 1; i >= 0 && maxEnd[i]! > time; i--) {
      if (spans[i]!.end > time) active = Math.min(active, spans[i]!.index);
    }
    return active !== Infinity ? active : time - last.end < 0.35 ? last.index : -1;
  };
}

/** Timeline range spanned by a selection of words (inclusive indices), ignoring cut words. */
export function selectionRange(words: MappedWord[], from: number, to: number): { start: number; end: number } | null {
  const [a, b] = from <= to ? [from, to] : [to, from];
  let start = Infinity;
  let end = -Infinity;
  for (let i = a; i <= b; i++) {
    const w = words[i];
    if (!w) continue;
    for (const p of w.placements) {
      start = Math.min(start, p.start);
      end = Math.max(end, p.end);
    }
  }
  if (!Number.isFinite(start)) return null;
  return { start, end };
}

/** Each occurrence in the cut is its own seekable word, even when footage repeats. */
export function cutWords(timeline: Timeline, transcripts: Transcript[]): MappedWord[] {
  const words = transcripts.flatMap(transcript =>
    mapWords(transcript, timeline, transcript.mediaId).flatMap(word =>
      word.placements.map(placement => ({
        ...word,
        segmentId: JSON.stringify([transcript.mediaId, placement.clipId, word.segmentId]),
        placements: [placement],
      })),
    ),
  );
  return words.sort((a, b) => a.placements[0]!.start - b.placements[0]!.start)
    .map((word, index) => ({ ...word, index }));
}

/** The source transcript always uses source time, including words omitted from the cut. */
export function sourceWords(transcript: Transcript): MappedWord[] {
  return flattenWords(transcript).map(({ segmentId, indexInSegment, word }, index) => ({
    index, segmentId, indexInSegment, mediaId: transcript.mediaId, word, cut: false,
    placements: [{ start: word.start, end: word.end }],
  }));
}

export function speechAssets(timeline: Timeline | null, media: MediaAsset[]): MediaAsset[] {
  if (!timeline) return [];
  const ids = new Set(mediaClipsFor(timeline).map(({ clip }) => clip.mediaId));
  return media.filter(asset => ids.has(asset.id) && (asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio !== false)));
}
