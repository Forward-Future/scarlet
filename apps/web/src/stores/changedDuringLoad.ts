/**
 * What live updates reported about a list while reads of it were on their way: newer than those reads. Each read
 * records from when it starts, so a change reported while two reads overlap is laid over both. `null` is removed.
 */
export function changedDuringLoad<T extends { id: string }>() {
  const open = new Set<Map<string, T | null>>();
  return {
    /** Starts recording for one read. Its `merge` lays what was reported since over what the read returned; `end` stops recording. */
    begin() {
      const changed = new Map<string, T | null>();
      open.add(changed);
      return {
        merge: (read: T[]) => [...read.filter(item => !changed.has(item.id)), ...[...changed.values()].filter((item): item is T => !!item)],
        end: () => { open.delete(changed); },
      };
    },
    set(id: string, item: T | null) { for (const changed of open) changed.set(id, item); },
  };
}
