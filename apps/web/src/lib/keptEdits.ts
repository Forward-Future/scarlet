import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { EditRef, KeepEditsRequest, Thread, ThreadEdit } from "@scarlet/shared";
import { appLog, errorName } from "./appLog";
import { api } from "./client";
import { editKey } from "./editMoments";

export { editKey };

/**
 * Applied edits the editor has reviewed and kept, per thread. Keep only records the review: the edit is
 * already in the cut. A revision gets a new identity, so it needs a fresh look. The engine records each Keep on the
 * edit's change too, so the runs of the request hear of it and don't ask about it again; this window's own record
 * also stands while the engine's is on its way, and Keeps it made before the engine kept them are sent on.
 */
const PREFIX = "scarlet.kept-edits.v1";
const listeners = new Set<() => void>();
/**
 * A stored set of keys as parsed, with the stored text it came from so a change in storage is noticed.
 * sessionOnly marks a record that storage refused; it stands until storage holds something else.
 */
type StoredSet = { raw: string | null; value: ReadonlySet<string>; sessionOnly?: boolean };
/** The parsed set for each key. */
const cache = new Map<string, StoredSet>();

/** The set `raw` holds under `key`, parsed once. `unreadable` hears of stored text that isn't JSON. */
function cachedSet(sets: Map<string, StoredSet>, key: string, raw: string | null, unreadable?: (error: unknown) => void): ReadonlySet<string> {
  const known = sets.get(key);
  // A record storage refused stands for the session, whatever storage still holds.
  if (known && (known.raw === raw || known.sessionOnly)) return known.value;
  let value: ReadonlySet<string> = new Set();
  try {
    const saved = JSON.parse(raw ?? "null");
    if (Array.isArray(saved)) value = new Set(saved.filter((k): k is string => typeof k === "string"));
  } catch (error) {
    unreadable?.(error);
  }
  sets.set(key, { raw, value });
  return value;
}

/** Store `value` under `key`. A set storage refuses stands for the session: `refused` hears why, and it returns false. */
function storeSet(sets: Map<string, StoredSet>, key: string, value: ReadonlySet<string>, refused?: (error: unknown) => void): boolean {
  const raw = JSON.stringify([...value]);
  try {
    localStorage.setItem(key, raw);
    sets.set(key, { raw, value });
    return true;
  } catch (error) {
    refused?.(error);
    sets.set(key, { raw: null, value, sessionOnly: true });
    return false;
  }
}

/**
 * What a Keep records. An edit that a later save gave a new reason to look is kept under that save's edit, and a doubt
 * a later request raised about an edit already in the video (`recheck`, when it was raised) is a new one, so a Keep
 * before it doesn't settle it.
 */
export const reviewKey = (ref: EditRef & { recheck?: string; reviewRef?: EditRef }) => {
  const key = editKey(ref.reviewRef ?? ref);
  return ref.recheck ? `${key}@${ref.recheck}` : key;
};
const storageKey = (projectId: string, threadId: string) => `${PREFIX}/${projectId}/${threadId}`;
/** A Keep's `reviewKey` in one thread of one project, for what this session has sent or taken back. */
const sessionKey = (projectId: string, threadId: string, key: string) => `${projectId}/${threadId}/${key}`;

let lastReadFailure: string | undefined;

function read(projectId: string, threadId: string): ReadonlySet<string> {
  const key = storageKey(projectId, threadId);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
    lastReadFailure = undefined;
  } catch (error) {
    const name = errorName(error);
    if (name !== lastReadFailure) appLog("review", "keep-read-failed", { project: projectId, thread: threadId, name }, { level: "warn" });
    lastReadFailure = name;
  }
  return cachedSet(cache, key, raw, error => {
    appLog("review", "keep-read-failed", { project: projectId, thread: threadId, name: errorName(error) }, { level: "warn" });
  });
}

export type KeptRef = EditRef & { recheck?: string; reviewRef?: EditRef } & Partial<Pick<ThreadEdit, "label" | "check" | "range">>;

/** The edits among `refs` that aren't kept yet: the ones a Keep of them all would newly keep, and ⌘Z would take back. */
export function notYetKept<T extends KeptRef>(projectId: string, threadId: string, refs: readonly T[]): T[] {
  const kept = read(projectId, threadId);
  return refs.filter(ref => !kept.has(reviewKey(ref)));
}

export function keepEdits(projectId: string, threadId: string, refs: KeptRef[], version?: string) {
  const key = storageKey(projectId, threadId);
  const before = read(projectId, threadId);
  const next = new Set(before);
  for (const ref of refs) next.add(reviewKey(ref));
  if (next.size === before.size) return false;
  const fields = { project: projectId, thread: threadId, count: next.size - before.size };
  const stored = storeSet(cache, key, next, error => {
    appLog("review", "keep-persist-failed", { ...fields, name: errorName(error) }, { level: "warn" });
  });
  if (stored) appLog("review", "kept", fields);
  const fresh = refs.filter(ref => !before.has(reviewKey(ref)));
  // Sent here with what the editor read, so the hook doesn't send each one again, bare.
  for (const ref of fresh) sent.add(sessionKey(projectId, threadId, reviewKey(ref)));
  for (const listener of listeners) listener();
  sendKeeps(projectId, threadId, fresh.map(ref => {
    const { changeId, spot } = ref.reviewRef ?? ref;
    return { changeId, spot, ...(ref.recheck && { recheck: ref.recheck }), ...(ref.label && { label: ref.label }),
      ...(ref.check && { check: ref.check }), ...(ref.range && version && { range: ref.range }) };
  }), version);
  return true;
}

/**
 * Take back the editor's Keep of these edits (⌘Z): they wait on the editor again, here and on the engine. Until the
 * engine says it has let go, its record of them doesn't count here.
 */
export function unkeepEdits(projectId: string, threadId: string, refs: KeptRef[]) {
  const key = storageKey(projectId, threadId);
  const before = read(projectId, threadId);
  const keys = new Set(refs.map(reviewKey));
  const next = new Set([...before].filter(k => !keys.has(k)));
  for (const k of keys) {
    sent.delete(sessionKey(projectId, threadId, k));
    unkept.add(sessionKey(projectId, threadId, k));
  }
  storeSet(cache, key, next, error => {
    appLog("review", "keep-persist-failed", { project: projectId, thread: threadId, count: keys.size, name: errorName(error) }, { level: "warn" });
  });
  appLog("review", "unkept", { project: projectId, thread: threadId, count: keys.size });
  for (const listener of listeners) listener();
  const edits = refs.map(ref => {
    const { changeId, spot } = ref.reviewRef ?? ref;
    return { changeId, spot, ...(ref.recheck && { recheck: ref.recheck }) };
  });
  // After any Keep of the same edits still on its way, so the engine hears them in the order the editor made them.
  toEngine(() => api.unkeepEdits(projectId, { threadId, edits }), error => {
    appLog("review", "unkeep-send-failed", { project: projectId, thread: threadId, count: edits.length, name: errorName(error) }, { level: "warn" });
  });
}

/** Keeps and their undoing go to the engine in the order the editor made them: at once, or after the one still on its way. */
let outbox: Promise<unknown> = Promise.resolve();
let onTheWay = 0;
function toEngine(send: () => Promise<unknown>, failed: (error: unknown) => void) {
  const sending = (onTheWay ? outbox.then(send) : send()).catch(failed);
  onTheWay++;
  outbox = sending.finally(() => { onTheWay--; });
}
/** Keeps taken back on this session, which the engine's record may still hold until it hears of it. */
const unkept = new Set<string>();

function sendKeeps(projectId: string, threadId: string, edits: KeepEditsRequest["edits"], version?: string) {
  if (!edits.length) return;
  for (const edit of edits) unkept.delete(sessionKey(projectId, threadId, reviewKey(edit)));
  toEngine(() => api.keepEdits(projectId, { threadId, ...(version && { version }), edits }), error => {
    appLog("review", "keep-send-failed", { project: projectId, thread: threadId, count: edits.length, name: errorName(error) }, { level: "warn" });
    // A Keep that didn't reach the engine (it was restarting, or reconnecting) is sent on by the hook at the thread's
    // next update. A few times only: one the engine keeps refusing isn't asked for at every update.
    for (const edit of edits) {
      const key = sessionKey(projectId, threadId, reviewKey(edit));
      const tries = (failedSends.get(key) ?? 0) + 1;
      failedSends.set(key, tries);
      if (tries < SEND_TRIES) sent.delete(key);
    }
  });
}
/** How many times a Keep is sent before this session leaves it as the engine has it. */
const SEND_TRIES = 3;
const failedSends = new Map<string, number>();

/** What a Keep the engine recorded on a change reads as here (`reviewKey`). */
function engineKeys(thread: Thread | undefined): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!thread) return keys;
  for (const change of [...thread.changes, ...thread.flagged ?? []]) {
    for (const kept of change.kept ?? []) {
      if (kept.threadId !== thread.id) continue;
      keys.add(reviewKey({ changeId: change.id, spot: kept.spot, recheck: kept.recheck }));
    }
  }
  return keys;
}

/** Keeps sent on this session, so a record the engine hasn't echoed yet isn't sent twice. */
const sent = new Set<string>();

export function useKeptEdits(projectId: string, thread: Thread | undefined): ReadonlySet<string> {
  const threadId = thread?.id;
  const local = useSyncExternalStore(subscribe, () => threadId ? read(projectId, threadId) : empty);
  const engine = useMemo(() => {
    const keys = new Set(engineKeys(thread));
    if (!threadId) return keys;
    // A Keep taken back here counts no more, whatever the engine's record still says; once that lets go, it is forgotten.
    for (const key of [...unkept]) {
      const [project, id, ...rest] = key.split("/");
      if (project !== projectId || id !== threadId) continue;
      const own = rest.join("/");
      if (keys.has(own)) keys.delete(own); else unkept.delete(key);
    }
    return keys;
    // Taking a Keep back changes this window's record, which is when the engine's has to be read again.
  }, [thread, projectId, threadId, local]); // eslint-disable-line react-hooks/exhaustive-deps
  // A Keep made before the engine recorded them, or that didn't reach it, is sent on.
  useEffect(() => {
    if (!threadId) return;
    const missing = [...local].filter(key => !engine.has(key) && !sent.has(sessionKey(projectId, threadId, key)));
    if (!missing.length) return;
    for (const key of missing) sent.add(sessionKey(projectId, threadId, key));
    sendKeeps(projectId, threadId, missing.flatMap(key => {
      const match = /^(.+)\/(\d+)(?:@(.+))?$/.exec(key);
      return match ? [{ changeId: match[1]!, spot: Number(match[2]), ...(match[3] && { recheck: match[3] }) }] : [];
    }));
  }, [projectId, threadId, local, engine]);
  return useMemo(() => engine.size ? new Set([...local, ...engine]) : local, [local, engine]);
}

/**
 * To-do markers the editor parked for later ("Later") in this window, per thread. Kept separate from Keeps so the
 * engine does not treat them as finished; marking a deferred to-do Done still overrides it and sends the Keep.
 */
const DEFER_PREFIX = "scarlet.deferred-edits.v1";
const deferListeners = new Set<() => void>();
const deferCache = new Map<string, StoredSet>();
const deferStorageKey = (projectId: string, threadId: string) => `${DEFER_PREFIX}/${projectId}/${threadId}`;

function readDeferred(projectId: string, threadId: string): ReadonlySet<string> {
  const key = deferStorageKey(projectId, threadId);
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { /* ignore */ }
  return cachedSet(deferCache, key, raw);
}

export function deferEdits(projectId: string, threadId: string, refs: KeptRef[]) {
  const key = deferStorageKey(projectId, threadId);
  const before = readDeferred(projectId, threadId);
  const next = new Set(before);
  for (const ref of refs) next.add(reviewKey(ref));
  if (next.size === before.size) return false;
  storeSet(deferCache, key, next);
  appLog("review", "deferred", { project: projectId, thread: threadId, count: next.size - before.size });
  for (const listener of deferListeners) listener();
  return true;
}

export function undeferEdits(projectId: string, threadId: string, refs: KeptRef[]) {
  const key = deferStorageKey(projectId, threadId);
  const before = readDeferred(projectId, threadId);
  const keys = new Set(refs.map(reviewKey));
  const next = new Set([...before].filter(k => !keys.has(k)));
  storeSet(deferCache, key, next);
  appLog("review", "undeferred", { project: projectId, thread: threadId, count: keys.size });
  for (const listener of deferListeners) listener();
}

export function useDeferredEdits(projectId: string, thread: Thread | undefined): ReadonlySet<string> {
  const threadId = thread?.id;
  return useSyncExternalStore(subscribeDeferred, () => threadId ? readDeferred(projectId, threadId) : empty);
}

const empty: ReadonlySet<string> = new Set();
const subscriber = (to: Set<() => void>) => (listener: () => void) => {
  to.add(listener);
  return () => { to.delete(listener); };
};
const subscribe = subscriber(listeners);
const subscribeDeferred = subscriber(deferListeners);
