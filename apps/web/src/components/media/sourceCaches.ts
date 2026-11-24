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

const MOVING_POLL_MS = 1500;
const MOVING_POLL_MAX_MS = 6000;
const IDLE_POLL_MS = 60_000;

/**
 * Polls one project's video caches. The header link and the Media panel share it, so it runs once. One read is in
 * flight at a time: a change meanwhile asks for one more after it. Store changes say when an import or a cache starts,
 * so with nothing caching the poll only checks in now and then, and a hidden window waits until it is shown.
 */
class CachePoll {
  caches?: SourceCacheStatus[];
  private readonly listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private inflight?: Promise<void>;
  private again = false;
  private interval = MOVING_POLL_MS;
  private onVisible?: () => void;
  constructor(readonly projectId: string) {}

  read(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    const sequence = ++this.sequence;
    clearTimeout(this.timer);
    this.stopWaitingForVisible();
    const run = this.fetch(sequence).finally(() => {
      if (this.inflight === run) this.inflight = undefined;
      if (sequence !== this.sequence || !this.listeners.size) return;
      if (this.again) {
        this.again = false;
        void this.read();
      }
    });
    this.inflight = run;
    return run;
  }

  private async fetch(sequence: number) {
    let changed = false;
    try {
      const { caches } = await api.sourceCaches(this.projectId);
      if (sequence !== this.sequence) return;
      const previous = this.caches;
      if (!previous || previous.length !== caches.length || caches.some((c, i) => !shallow(c, previous[i]))) {
        this.caches = caches;
        changed = true;
        this.listeners.forEach(listener => listener());
      }
    } catch {
      if (sequence !== this.sequence) return;
    }
    if (!this.listeners.size || this.again) return;
    const paused = useProjectStore.getState().current?.project.mediaPaused;
    const moving = this.caches?.some(c => c.state === "caching" || (c.queued && !paused));
    // While a cache moves, read soon, and less often while its figure stands still.
    this.interval = !moving ? IDLE_POLL_MS : changed ? MOVING_POLL_MS : Math.min(this.interval * 2, MOVING_POLL_MAX_MS);
    this.timer = setTimeout(() => this.whenVisible(), this.interval);
  }

  private whenVisible() {
    if (typeof document === "undefined" || !document.hidden) { void this.read(); return; }
    this.stopWaitingForVisible();
    const onVisible = () => { if (!document.hidden) { this.stopWaitingForVisible(); void this.read(); } };
    this.onVisible = onVisible;
    document.addEventListener("visibilitychange", onVisible);
  }

  private stopWaitingForVisible() {
    if (!this.onVisible) return;
    document.removeEventListener("visibilitychange", this.onVisible);
    this.onVisible = undefined;
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
      // The read still out is dropped with its sequence: a view put up before it answers starts a read of its own.
      this.inflight = undefined;
      this.again = false;
      clearTimeout(this.timer);
      this.stopWaitingForVisible();
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
  if (paused && (cache.state === "caching" || cache.queued)) return { text: "Caching paused", tone: "idle" };
  if (cache.state === "caching") {
    const percent = cachePercent(cache);
    return { text: percent ? `Caching · ${percent}` : "Caching…", tone: "busy" };
  }
  if (cache.queued) return { text: "Waiting to cache", tone: "busy" };
  return { text: "Not cached", tone: "idle" };
}
