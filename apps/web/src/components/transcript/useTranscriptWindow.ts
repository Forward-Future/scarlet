import { useEffect, useMemo, useReducer, useRef } from "react";
import { carriesAudio, timelineDuration, type MediaAsset, type Timeline, type Transcript } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";
import { mediaClipsFor, speechAssets } from "../../lib/transcriptMap";
import { usePlayerStore } from "../../stores/player";

const SECONDS = 60;
type Chunk = { key: string; mediaId: string; from: number; to: number };
type Page = { data?: Transcript; error?: string; done: Promise<void> };

/**
 * Pages of finished transcripts already read. A chunk's key names its transcript, and a transcript that has been
 * aligned never changes under its ID, so neither do its pages. The Transcript column is mounted again for each new
 * working cut, and without these it read the whole transcript again every time: 60 requests for an hour of footage,
 * on every edit Scarlet saved while the column was open.
 */
const readPages = new Map<string, Transcript>();
/** About four hours of footage. */
const READ_PAGES = 240;
const pageKey = (chunk: Chunk, audioSources: boolean) => JSON.stringify([chunk.key, audioSources]);
function keepPage(key: string, data: Transcript) {
  readPages.delete(key);
  readPages.set(key, data);
  while (readPages.size > READ_PAGES) readPages.delete(readPages.keys().next().value!);
}
/** For tests: forget every page read. */
export function forgetTranscriptPages() { readPages.clear(); }

// Requests use fixed source-time chunks so linked tracks, repeated footage and adjacent cut pages share reads.
export function transcriptChunks(source: MediaAsset | undefined, assets: MediaAsset[], clips: ReturnType<typeof mediaClipsFor>, from: number, to: number) {
  const chunks = new Map<string, Chunk>();
  const add = (asset: MediaAsset | undefined, start: number, stop: number) => {
    if (!asset?.transcriptId || stop <= start) return;
    for (let i = Math.floor(start / SECONDS); i < Math.ceil(stop / SECONDS); i++) {
      // The first transcript is readable before its word alignment finishes under the same ID.
      const key = JSON.stringify([asset.id, asset.transcriptId, asset.lastTranscription?.completedAt, i]);
      chunks.set(key, { key, mediaId: asset.id, from: i * SECONDS, to: (i + 1) * SECONDS });
    }
  };
  if (source) add(source, from, to);
  else {
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    for (const { clip } of clips) {
      const speed = clip.speed ?? 1;
      add(byId.get(clip.mediaId), Math.max(clip.sourceIn, clip.sourceIn + (from - clip.timelineIn) * speed),
        Math.min(clip.sourceOut, clip.sourceIn + (to - clip.timelineIn) * speed));
    }
  }
  return [...chunks.values()];
}

/** The transcript of `range`, read in pages with the page either side of it read ahead. */
export function useTranscriptWindow(source: MediaAsset | undefined, timeline: Timeline | null, media: MediaAsset[], range: { start: number; end: number }, audioSources = false) {
  // A source with no sound has no transcript to show or to make, like a silent clip in the edit.
  const assets = useMemo(() => source ? [source].filter(carriesAudio) : speechAssets(timeline, media), [source, timeline, media]);
  const clips = useMemo(() => !source && timeline ? mediaClipsFor(timeline) : [], [source, timeline]);
  const duration = useMemo(() => source ? source.duration : timeline ? timelineDuration(timeline) : 0, [source, timeline]);
  const playerDuration = usePlayerStore(s => s.duration);
  const end = duration || playerDuration || SECONDS;
  const from = range.start;
  // The range is clamped to the footage, so the whole of it can be asked for with an open end.
  const to = Math.min(range.end, end);
  const visible = useMemo(() => transcriptChunks(source, assets, clips, from, to), [source, assets, clips, from, to]);
  const adjacent = useMemo(() => [
    ...transcriptChunks(source, assets, clips, Math.max(0, from - SECONDS), from),
    ...transcriptChunks(source, assets, clips, to, Math.min(end, to + SECONDS)),
  ], [source, assets, clips, from, to, end]);
  const cache = useRef(new Map<string, Page>());
  const [revision, redraw] = useReducer(n => n + 1, 0);
  const [attempt, retry] = useReducer(n => n + 1, 0);
  useEffect(() => {
    let active = true;
    const retained = new Set([...visible, ...adjacent].map(chunk => chunk.key));
    for (const key of cache.current.keys()) if (!retained.has(key)) cache.current.delete(key);
    const load = (chunk: Chunk) => {
      const stored = cache.current.get(chunk.key);
      if (stored) return stored.done;
      const kept = readPages.get(pageKey(chunk, audioSources));
      const page: Page = kept ? { data: kept, done: Promise.resolve() }
        : { done: api.transcript(chunk.mediaId, { from: chunk.from, to: chunk.to, granularity: "word", ...(audioSources ? { audioSources } : {}) })
          .then(data => {
            page.data = data;
            // Words still being aligned move under the same ID until they are final.
            if (!data.aligning) keepPage(pageKey(chunk, audioSources), data);
          }, err => { page.error = errorMessage(err); }) };
      cache.current.set(chunk.key, page);
      return page.done;
    };
    void Promise.all(visible.map(load)).then(() => {
      if (!active) return;
      redraw();
      for (const chunk of adjacent) void load(chunk);
    });
    return () => { active = false; };
  }, [visible, adjacent, attempt, audioSources]);

  const result = useMemo(() => {
    const transcripts = new Map<string, Transcript>();
    const segments = new Map<string, Set<string>>();
    let loading = false, error = "";
    for (const chunk of visible) {
      // A page read before this mount shows at once, with no "Loading transcript…" in between.
      const page = cache.current.get(chunk.key) ?? { data: readPages.get(pageKey(chunk, audioSources)), error: undefined };
      if (page?.error) { error = page.error; continue; }
      if (!page?.data) { loading = true; continue; }
      const t = page.data;
      if (!transcripts.has(t.mediaId)) {
        transcripts.set(t.mediaId, { ...t, segments: [] });
        segments.set(t.mediaId, new Set());
      }
      const seen = segments.get(t.mediaId)!;
      for (const segment of t.segments) {
        if (seen.has(segment.id)) continue;
        seen.add(segment.id);
        transcripts.get(t.mediaId)!.segments.push(segment);
      }
    }
    for (const t of transcripts.values()) t.segments.sort((a, b) => a.start - b.start);
    return { transcripts: [...transcripts.values()], loading, error };
  }, [visible, revision, audioSources]);
  return { ...result, assets, from, to,
    retry() { for (const c of visible) if (cache.current.get(c.key)?.error) cache.current.delete(c.key); retry(); },
  };
}
