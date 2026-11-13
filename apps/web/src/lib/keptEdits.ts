import { useSyncExternalStore } from "react";
import type { EditRef } from "@scarlet/shared";

/**
 * Applied edits the editor has reviewed and kept, per thread. Keep only records the review: the edit is
 * already in the cut. A revision gets a new identity, so it needs a fresh look.
 */
const PREFIX = "scarlet.kept-edits.v1";
const listeners = new Set<() => void>();
/**
 * The parsed set for each key, with the stored text it came from so a change in storage is noticed.
 * sessionOnly marks a record that storage refused; it stands until storage holds something else.
 */
const cache = new Map<string, { raw: string | null; value: ReadonlySet<string>; sessionOnly?: boolean }>();

export const editKey = (ref: EditRef) => `${ref.changeId}/${ref.spot}`;
const storageKey = (projectId: string, threadId: string) => `${PREFIX}/${projectId}/${threadId}`;

function stored(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function read(key: string): ReadonlySet<string> {
  const raw = stored(key);
  const known = cache.get(key);
  // A record storage refused stands for the session, whatever storage still holds.
  if (known && (known.raw === raw || known.sessionOnly)) return known.value;
  let value: ReadonlySet<string> = new Set();
  try {
    const saved = JSON.parse(raw ?? "null");
    if (Array.isArray(saved)) value = new Set(saved.filter((k): k is string => typeof k === "string"));
  } catch { /* An unreadable record must not block review. */ }
  cache.set(key, { raw, value });
  return value;
}

export function keepEdits(projectId: string, threadId: string, refs: EditRef[]) {
  const key = storageKey(projectId, threadId);
  const before = read(key);
  const next = new Set(before);
  for (const ref of refs) next.add(editKey(ref));
  if (next.size === before.size) return false;
  const raw = JSON.stringify([...next]);
  try {
    localStorage.setItem(key, raw);
    cache.set(key, { raw, value: next });
  } catch {
    cache.set(key, { raw: null, value: next, sessionOnly: true });
  }
  for (const listener of listeners) listener();
  return true;
}

export function useKeptEdits(projectId: string, threadId: string | undefined): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => threadId ? read(storageKey(projectId, threadId)) : empty);
}
const empty: ReadonlySet<string> = new Set();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
