import { useEffect, useRef, useState } from "react";
import { fullRenderContext, type PlaybackCacheStatus, type Render } from "@scarlet/shared";
import type { Project } from "@scarlet/timeline";
import { api } from "../../lib/client";
import { useProjectStore } from "../../stores/project";
import { renderCompletion } from "../../lib/renderCompletion";

interface Cache extends PlaybackCacheStatus { url?: string; renderId?: string }

function renderStatus(render?: Render): Cache {
  if (!render || render.state === "cancelled") return { state: "uncached" };
  if (render.state === "done") return { state: "ready", url: api.renderFileUrl(render.id), renderId: render.id };
  if (render.state === "failed") return { state: "failed" };
  return { state: "caching", progress: render.progress };
}

export function usePlaybackCache(project: Project, { version, mediaId, automatic = false, settingsRevision = 0 }: {
  version?: string; mediaId?: string; automatic?: boolean; settingsRevision?: number;
}) {
  const id = project.id;
  const sourceRevision = useProjectStore(s => mediaId && s.current?.id === id ? s.current.sourcePreviewRevisions?.[mediaId] : undefined);
  const key = mediaId ? JSON.stringify([id, mediaId, settingsRevision]) : version ? settingsRevision + fullRenderContext({ ...project, head: version }) : "";
  const [result, setResult] = useState<{ key: string; cache: Cache }>();
  const start = useRef<() => void>(() => {});
  useEffect(() => {
    if (!key) return;
    let live = true, generation = 0;
    let reconnectDelay = 1200;
    let waiting: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const owner = automatic ? crypto.randomUUID() : undefined;
    let ownedId: string | undefined;
    const release = (renderId: string) => { if (owner) void api.releaseRender(renderId, owner).catch(() => {}); };
    async function read(action: "open" | "automatic" | "manual" | "poll", pendingId?: string) {
      const sequence = ++generation;
      waiting?.abort();
      clearTimeout(timer);
      const prepare = action === "automatic" || action === "manual";
      if (prepare) setResult({ key, cache: { state: "caching" } });
      try {
        let cache: Cache;
        if (mediaId) {
          const status = await api.sourceCache(mediaId, prepare);
          cache = status.state === "ready" ? { ...status, url: api.sourceCacheUrl(mediaId, status.fileKey) } : status;
        } else if (pendingId) {
          const { render } = await api.render(pendingId);
          cache = renderStatus(render);
        } else if (prepare) {
          const { render } = await api.requestRender(id, { version, kind: "full", quality: "preview",
            ...(action === "automatic" ? { owner } : {}) });
          pendingId = render.id;
          if (action === "automatic" && (render.state === "running" || render.state === "queued")) {
            if (!live) { release(render.id); return; }
            ownedId = render.id;
          }
          cache = renderStatus(render);
        } else {
          const { renders, fullRenderKeys } = await api.renders(id, { kind: "full", version });
          const matches = renders.filter(r => r.key === fullRenderKeys?.preview && r.state !== "cancelled");
          const render = matches.find(r => r.state === "done") ?? matches.find(r => r.state !== "failed") ?? matches[0];
          cache = renderStatus(render);
          pendingId = render?.id;
        }
        if (!live || sequence !== generation) return;
        reconnectDelay = 1200;
        if (ownedId === pendingId && cache.state !== "caching") ownedId = undefined;
        const needsPreparation = action === "open" ? cache.state !== "ready"
          : action === "poll" && mediaId && cache.state === "uncached";
        const prepareSoon = !project.mediaPaused && automatic && needsPreparation;
        setResult({ key, cache: prepareSoon && cache.state === "failed" ? { state: "uncached" } : cache });
        if (!prepareSoon && cache.state !== "caching") return;

        // Debounce speculative work on cut switches. If a known job finishes
        // during that grace period, use it immediately without requesting it again.
        const delay = prepareSoon ? 750 : 1200;
        const resume = () => prepareSoon ? read("automatic") : read("poll", pendingId);
        if (!pendingId || mediaId || cache.state !== "caching") {
          timer = setTimeout(() => void resume(), delay);
          return;
        }
        waiting = new AbortController();
        const completed = await renderCompletion(id, pendingId, delay, waiting.signal);
        if (!live || sequence !== generation) return;
        if (!completed || (prepareSoon && completed.state !== "done")) { void resume(); return; }
        ownedId = undefined;
        setResult({ key, cache: renderStatus(completed) });
      } catch (error) {
        if (!live || sequence !== generation) return;
        if (action === "poll" && error instanceof TypeError) {
          // A dropped connection need not discard a render the engine is still writing.
          timer = setTimeout(() => void read("poll", pendingId), reconnectDelay);
          reconnectDelay = Math.min(8000, reconnectDelay * 2);
        } else setResult({ key, cache: { state: "failed" } });
      }
    }
    start.current = () => { void read("manual"); };
    void read("open");
    return () => {
      live = false;
      waiting?.abort();
      clearTimeout(timer);
      if (ownedId) release(ownedId);
      start.current = () => {};
    };
  }, [key, id, version, mediaId, sourceRevision, automatic, project.mediaPaused]);
  const cache = result?.key === key ? result.cache : undefined;
  return { cache, startCache: () => start.current() };
}
