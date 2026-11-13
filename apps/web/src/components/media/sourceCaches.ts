import { useCallback, useMemo, useSyncExternalStore } from "react";
import { shallow } from "zustand/shallow";
import type { PlaybackCacheStatus, SourceCacheStatus } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { useProjectStore } from "../../stores/project";

function sameImportStates(media: MediaAsset[], previous: MediaAsset[]) {
  return media === previous || (media.length === previous.length &&
    media.every((m, i) => m.id === previous[i]!.id && m.status === previous[i]!.status));
}

/** Polls one project's video caches. The header link and the Media panel share it, so it runs once. */
class CachePoll {
  caches?: SourceCacheStatus[];
  private readonly listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  constructor(readonly projectId: string) {}

  async read() {
    const sequence = ++this.sequence;
    clearTimeout(this.timer);
    try {
      const { caches } = await api.sourceCaches(this.projectId);
      if (sequence !== this.sequence) return;
      const previous = this.caches;
      if (!previous || previous.length !== caches.length || caches.some((c, i) => !shallow(c, previous[i]))) {
        this.caches = caches;
        this.listeners.forEach(listener => listener());
      }
    } catch {
      if (sequence !== this.sequence) return;
    }
    if (!this.listeners.size) return;
    const paused = useProjectStore.getState().current?.project.mediaPaused;
    const moving = this.caches?.some(c => c.state === "caching" || (c.queued && !paused));
    this.timer = setTimeout(() => void this.read(), moving ? 1500 : 10_000);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      // Both views share the same invalidation. An agent event leaves the media
      // array alone, so a busy project doesn't scan its entire library at each step.
      this.unsubscribe = useProjectStore.subscribe(({ current }, { current: before }) => {
        if (current?.id !== this.projectId || current === before) return;
        if (current.id !== before?.id || current.project.mediaPaused !== before.project.mediaPaused ||
            current.sourcePreviewRevisions !== before.sourcePreviewRevisions || !sameImportStates(current.media, before.media)) {
          void this.read();
        }
      });
      void this.read();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.unsubscribe?.();
      this.sequence++;
      clearTimeout(this.timer);
    };
  }
}

const polls = new Map<string, CachePoll>();

function poll(projectId: string) {
  let found = polls.get(projectId);
  if (!found) polls.set(projectId, found = new CachePoll(projectId));
  return found;
}

/** Each video's full-length playback cache in the open project, by media id. */
export function useSourceCaches() {
  const projectId = useProjectStore(s => s.current?.id ?? "");
  const subscribe = useCallback((listener: () => void) => projectId ? poll(projectId).subscribe(listener) : () => {}, [projectId]);
  const caches = useSyncExternalStore(subscribe, () => projectId ? poll(projectId).caches : undefined);
  const byMedia = useMemo(() => new Map((caches ?? []).map(c => [c.mediaId, c])), [caches]);
  const start = useCallback(async (mediaId: string) => {
    await api.sourceCache(mediaId, true);
    if (projectId) await poll(projectId).read();
  }, [projectId]);
  return { caches: byMedia, loaded: !!caches, start };
}

/** How far a cache under way has got, as it reads; nothing until the engine has a figure. It says 100% only as Cached. */
export function cachePercent(cache: Pick<PlaybackCacheStatus, "progress">): string | undefined {
  return cache.progress == null ? undefined : `${Math.min(99, Math.floor(cache.progress * 100))}%`;
}

/** A video's cache in a few words, for the Media link's card and the Media panel. While it caches, a percent and no time left. */
export function cacheLabel(cache: (PlaybackCacheStatus & { queued?: boolean }) | undefined, paused: boolean): { text: string; tone: "ok" | "busy" | "idle" | "bad" } | undefined {
  if (!cache) return undefined;
  if (cache.state === "ready") return { text: "Cached", tone: "ok" };
  if (cache.state === "failed") return { text: "Couldn’t cache", tone: "bad" };
  if (cache.state === "caching") {
    const percent = cachePercent(cache);
    return { text: percent ? `Caching · ${percent}` : "Caching…", tone: "busy" };
  }
  if (cache.queued) return paused ? { text: "Caching paused", tone: "idle" } : { text: "Waiting to cache", tone: "busy" };
  return { text: "Not cached", tone: "idle" };
}
