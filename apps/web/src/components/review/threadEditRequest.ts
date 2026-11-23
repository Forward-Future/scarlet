import { useMemo } from "react";
import type { Thread } from "@scarlet/shared";
import { api } from "../../lib/client";

/** Names one read of a request's edits on one working cut. Reads under the same name share one request. */
function threadEditKey(projectId: string, head: string | null, thread?: Thread) {
  // A review flag can change the edit list without changing the working cut or saving a new version.
  const changeKey = (change: Thread["changes"][number]) => [change.id, change.state, change.appliedVersion, change.toVersion, change.flags];
  return JSON.stringify([projectId, head, thread?.id, thread?.changes.map(changeKey), thread?.flagged?.map(changeKey)]);
}

export function useThreadEditKey(projectId: string, head: string | null, thread?: Thread) {
  return useMemo(() => threadEditKey(projectId, head, thread), [projectId, head, thread?.id, thread?.changes, thread?.flagged]); // eslint-disable-line react-hooks/exhaustive-deps
}

const pending = new Map<string, ReturnType<typeof api.threadEdits>>();

/** The chat and timeline read the same engine projection. A later visit revalidates it. */
export function requestThreadEdits(key: string, projectId: string, threadId: string) {
  const existing = pending.get(key);
  if (existing) return existing;
  const read = api.threadEdits(projectId, threadId);
  pending.set(key, read);
  // Keep listeners on the original resolution so revised markers arrive with the timeline that plays them.
  const clear = () => pending.delete(key);
  void read.then(clear, clear);
  return read;
}
