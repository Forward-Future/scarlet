import { useEffect, useMemo, useState } from "react";
import type { Thread, ThreadEdit } from "@scarlet/shared";
import { requestThreadEdits, threadEditKey } from "./threadEditRequest";

export interface ProjectEdit { thread: Thread; edit: ThreadEdit }

const none: ProjectEdit[] = [];

/**
 * Every applied edit on the working cut, whichever request made it, each where it sits on the working cut. Each request
 * lists its own, as the engine projects them onto the working cut (`threadTimeline`); one another request only flagged
 * is left to the request that made it. A request whose list is still on its way, or that failed, or that was read on an
 * earlier working cut, draws nothing rather than draw an edit in the wrong place.
 */
export function useProjectEdits(projectId: string, head: string | null, threads: readonly Thread[]): ProjectEdit[] {
  const applied = useMemo(() => threads.filter(t => t.changes.some(c => c.state === "approved")), [threads]);
  const keys = useMemo(() => applied.map(t => threadEditKey(projectId, head, t)), [applied, projectId, head]);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, ThreadEdit[]>>(new Map());
  const signature = keys.join("\n");
  useEffect(() => {
    if (!head) return;
    let live = true;
    applied.forEach((thread, i) => {
      const key = keys[i]!;
      if (loaded.has(key)) return;
      requestThreadEdits(key, projectId, thread.id).then(({ edits, version }) => {
        if (live && version === head) setLoaded(had => had.has(key) ? had : new Map([...had].filter(([k]) => keys.includes(k)).concat([[key, edits]])));
      }, () => {});
    });
    return () => { live = false; };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!head) return none;
    const all = applied.flatMap((thread, i) => (loaded.get(keys[i]!) ?? []).filter(edit => !edit.elsewhere).map(edit => ({ thread, edit })));
    return all.length ? all : none;
  }, [applied, keys, loaded, head]);
}
