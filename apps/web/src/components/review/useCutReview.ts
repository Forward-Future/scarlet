import { useEffect, useMemo, useState } from "react";
import type { CutReview, Timeline, TimeRange } from "@scarlet/timeline";
import { api, errorMessage } from "../../lib/client";

export function useCutReview(changeId?: string) {
  const [result, setResult] = useState<{ id: string; review?: CutReview | null; error?: string }>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let live = true;
    if (!changeId) return;
    setResult(undefined);
    api.cutReview(changeId).then(({ review }) => { if (live) setResult({ id: changeId, review }); },
      err => { if (live) setResult({ id: changeId, error: errorMessage(err) }); });
    return () => { live = false; };
  }, [changeId, attempt]);
  return { ...(result?.id === changeId ? result : undefined), retry: () => retry(i => i + 1) };
}

/** A bounded cache for one project's current review and render settings. Only successful preparations enter it. */
export type SingleCutDrafts = Map<string, { draft: Timeline; range: TimeRange }>;
const draftKey = (changeId: string, index: number, count: number, head: string) => JSON.stringify([changeId, index, count, head]);

/** The preview has the same placement and audio handles as approving just this call on the working cut. */
export async function singleCutDraft(changeId: string, index: number, count: number, head: string, signal: AbortSignal, cache?: SingleCutDrafts) {
  const key = draftKey(changeId, index, count, head);
  const cached = cache?.get(key);
  if (cached) return cached;
  const restored = Array.from({ length: count }, (_, i) => i).filter(i => i !== index);
  const { draft, ontoVersion, removed } = await api.cutReviewDraft(changeId, restored, head, signal);
  if (!draft || ontoVersion !== head || removed?.length !== 1) throw new Error("This cut could not be previewed on the current edit.");
  signal.throwIfAborted();
  const preview = { draft, range: removed[0]! };
  if (cache) {
    cache.set(key, preview);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
  }
  return preview;
}

export function useSingleCutDraft(changeId: string | undefined, index: number, count: number, head: string | undefined, cache: SingleCutDrafts) {
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => changeId && head && index >= 0 && index < count
    ? { changeId, index, count, head } : undefined, [changeId, index, count, head, attempt, cache]);
  const [result, setResult] = useState<{ request: NonNullable<typeof request>; preview?: Awaited<ReturnType<typeof singleCutDraft>>; error?: string }>();
  const cached = request && cache.get(draftKey(request.changeId, request.index, request.count, request.head));
  useEffect(() => {
    if (!request || cached || result?.request === request) return;
    const controller = new AbortController();
    void singleCutDraft(request.changeId, request.index, request.count, request.head, controller.signal, cache).then(
      preview => { if (!controller.signal.aborted) setResult({ request, preview }); },
      err => { if (!controller.signal.aborted) setResult({ request, error: errorMessage(err) }); });
    return () => controller.abort();
  }, [request, cached, result, cache]);
  return { ...(result?.request === request ? result : undefined), ...(cached && { preview: cached }),
    retry: () => { if (request) cache.delete(draftKey(request.changeId, request.index, request.count, request.head)); setAttempt(n => n + 1); } };
}
