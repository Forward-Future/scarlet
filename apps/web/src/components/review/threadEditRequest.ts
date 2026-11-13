import { useMemo } from "react";
import type { Thread, ThreadEdit } from "@scarlet/shared";
import { api } from "../../lib/client";
import { runIsActive } from "../../lib/taskRun";

/** Applied edits stay playable while their request runs, but it can still replace them before review. */
export function useReviewableEditFlags(thread: Thread | undefined, edits: ThreadEdit[]) {
  return useMemo(() => {
    if (!thread || !edits.some(edit => edit.check)) return edits;
    const working = new Set(thread.tasks.filter(runIsActive).map(task => task.resumeRootId ?? task.id));
    if (!working.size) return edits;
    const attempts = thread.tasks.filter(task => working.has(task.resumeRootId ?? task.id));
    const taskIds = new Set(attempts.map(task => task.id));
    // Older changes may be linked only from their task.
    const held = new Set(attempts.flatMap(task => task.changeIds));
    for (const change of thread.changes) if (change.taskId && taskIds.has(change.taskId)) held.add(change.id);
    return edits.map(edit => edit.check && (held.has(edit.changeId) || held.has(edit.reviewChangeId ?? edit.changeId))
      ? { ...edit, check: undefined } : edit);
  }, [thread, edits]);
}

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
