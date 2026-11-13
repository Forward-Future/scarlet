import { useMemo } from "react";
import type { Thread } from "@scarlet/shared";
import { api } from "../../lib/client";

export function useThreadEditKey(projectId: string, head: string | null, thread?: Thread) {
  return useMemo(() => JSON.stringify([projectId, head, thread?.id, thread?.changes.map(c =>
    [c.id, c.state, c.appliedVersion, c.toVersion])]), [projectId, head, thread?.id, thread?.changes]);
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
