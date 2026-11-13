import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { timelineDuration, type MediaAsset, type Timeline, type Transcript } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";
import { mediaClipsFor, speechAssets } from "../../lib/transcriptMap";
import { usePlayerStore } from "../../stores/player";

const SECONDS = 60;
const VISIBLE_PAGES = 5;
type Chunk = { key: string; mediaId: string; from: number; to: number };
type Page = { data?: Transcript; error?: string; done: Promise<void> };

// Requests use fixed source-time chunks so linked tracks, repeated footage and adjacent cut pages share reads.
export function transcriptChunks(source: MediaAsset | undefined, assets: MediaAsset[], clips: ReturnType<typeof mediaClipsFor>, from: number, to: number) {
  const chunks = new Map<string, Chunk>();
  const add = (asset: MediaAsset | undefined, start: number, stop: number) => {
    if (!asset?.transcriptId || stop <= start) return;
    for (let i = Math.floor(start / SECONDS); i < Math.ceil(stop / SECONDS); i++) {
      const key = JSON.stringify([asset.id, asset.transcriptId, i]);
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

const hasSpeech = (asset: MediaAsset) => asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio !== false);

export function useTranscriptWindow(source: MediaAsset | undefined, timeline: Timeline | null, media: MediaAsset[], fixedRange?: { start: number; end: number }, audioSources = false) {
  // A source with no sound has no transcript to show or to make, like a silent clip in the edit.
  const assets = useMemo(() => source ? [source].filter(hasSpeech) : speechAssets(timeline, media), [source, timeline, media]);
  const clips = useMemo(() => !source && timeline ? mediaClipsFor(timeline) : [], [source, timeline]);
  const duration = useMemo(() => source ? source.duration : timeline ? timelineDuration(timeline) : 0, [source, timeline]);
  const playerDuration = usePlayerStore(s => s.duration);
  const end = duration || playerDuration || SECONDS;
  const lastPage = Math.max(0, Math.ceil(end / SECONDS) - 1);
  const [span, setWindow] = useState(() => {
    const at = Math.min(lastPage, Math.floor(usePlayerStore.getState().time / SECONDS));
    return { first: at, last: at };
  });
  const first = Math.min(span.first, lastPage);
  const last = Math.min(span.last, lastPage);
  const from = fixedRange?.start ?? first * SECONDS;
  const to = fixedRange?.end ?? Math.min(end, (last + 1) * SECONDS);
  useEffect(() => {
    if (fixedRange) return;
    let timer: number | undefined, pendingPage: number | undefined;
    const follow = (at: number) => setWindow(w => at >= w.first && at <= w.last ? w : { first: at, last: at });
    const unsubscribe = usePlayerStore.subscribe((state, previous) => {
      if (state.time === previous.time && state.scrubGesture === previous.scrubGesture) return;
      const at = Math.min(lastPage, Math.max(0, Math.floor(state.time / SECONDS)));
      if (state.scrubGesture) {
        // A fast drag can cross a minute on every paint. Follow a held position
        // while dragging, and fetch the final page immediately on release.
        if (pendingPage !== at) {
          clearTimeout(timer);
          pendingPage = at;
          timer = window.setTimeout(() => follow(at), 100);
        }
        return;
      }
      if (!previous.scrubGesture && state.playing && Math.floor(previous.time / SECONDS) === at && Math.abs(state.time - previous.time) < 1) return;
      if (pendingPage !== undefined) {
        clearTimeout(timer);
        pendingPage = undefined;
      }
      follow(at);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [lastPage, fixedRange]);
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
      const page: Page = { done: api.transcript(chunk.mediaId, { from: chunk.from, to: chunk.to, granularity: "word", ...(audioSources ? { audioSources } : {}) })
        .then(data => { page.data = data; }, err => { page.error = errorMessage(err); }) };
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
      const page = cache.current.get(chunk.key);
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
  }, [visible, revision]);
  return { ...result, assets, from, to, earlier: first > 0, later: last < lastPage,
    extend(direction: -1 | 1, keepSelection: boolean) {
      setWindow(w => {
        const first = Math.max(0, w.first + Math.min(direction, 0));
        const last = Math.min(lastPage, w.last + Math.max(direction, 0));
        if (keepSelection || last - first < VISIBLE_PAGES) return { first, last };
        return direction < 0 ? { first, last: first + VISIBLE_PAGES - 1 } : { first: last - VISIBLE_PAGES + 1, last };
      });
    },
    retry() { for (const c of visible) if (cache.current.get(c.key)?.error) cache.current.delete(c.key); retry(); },
  };
}
