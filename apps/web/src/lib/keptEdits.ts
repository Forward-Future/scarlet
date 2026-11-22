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
 * The parsed set for each key, with the stored text it came from so a change in storage is noticed.
 * sessionOnly marks a record that storage refused; it stands until storage holds something else.
 */
const cache = new Map<string, { raw: string | null; value: ReadonlySet<string>; sessionOnly?: boolean }>();

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
  const known = cache.get(key);
  // A record storage refused stands for the session, whatever storage still holds.
  if (known && (known.raw === raw || known.sessionOnly)) return known.value;
  let value: ReadonlySet<string> = new Set();
  try {
    const saved = JSON.parse(raw ?? "null");
    if (Array.isArray(saved)) value = new Set(saved.filter((k): k is string => typeof k === "string"));
  } catch (error) {
    appLog("review", "keep-read-failed", { project: projectId, thread: threadId, name: errorName(error) }, { level: "warn" });
  }
  cache.set(key, { raw, value });
  return value;
}

export type KeptRef = EditRef & { recheck?: string; reviewRef?: EditRef } & Partial<Pick<ThreadEdit, "label" | "check" | "range">>;

export function keepEdits(projectId: string, threadId: string, refs: KeptRef[], version?: string) {
  const key = storageKey(projectId, threadId);
  const before = read(projectId, threadId);
  const next = new Set(before);
  for (const ref of refs) next.add(reviewKey(ref));
  if (next.size === before.size) return false;
  const raw = JSON.stringify([...next]);
  const fields = { project: projectId, thread: threadId, count: next.size - before.size };
  try {
    localStorage.setItem(key, raw);
    cache.set(key, { raw, value: next });
    appLog("review", "kept", fields);
  } catch (error) {
    appLog("review", "keep-persist-failed", { ...fields, name: errorName(error) }, { level: "warn" });
    cache.set(key, { raw: null, value: next, sessionOnly: true });
  }
  const fresh = refs.filter(ref => !before.has(reviewKey(ref)));
  // Sent here with what the editor read, so the hook doesn't send each one again, bare.
  for (const ref of fresh) sent.add(`${projectId}/${threadId}/${reviewKey(ref)}`);
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
    sent.delete(`${projectId}/${threadId}/${k}`);
    unkept.add(`${projectId}/${threadId}/${k}`);
  }
  const raw = JSON.stringify([...next]);
  try {
    localStorage.setItem(key, raw);
    cache.set(key, { raw, value: next });
  } catch (error) {
    appLog("review", "keep-persist-failed", { project: projectId, thread: threadId, count: keys.size, name: errorName(error) }, { level: "warn" });
    cache.set(key, { raw: null, value: next, sessionOnly: true });
  }
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
  for (const edit of edits) unkept.delete(`${projectId}/${threadId}/${edit.changeId}/${edit.spot}${edit.recheck ? `@${edit.recheck}` : ""}`);
  toEngine(() => api.keepEdits(projectId, { threadId, ...(version && { version }), edits }), error => {
    appLog("review", "keep-send-failed", { project: projectId, thread: threadId, count: edits.length, name: errorName(error) }, { level: "warn" });
    // A Keep that didn't reach the engine (it was restarting, or reconnecting) is sent on by the hook at the thread's
    // next update. A few times only: one the engine keeps refusing isn't asked for at every update.
    for (const edit of edits) {
      const key = `${projectId}/${threadId}/${edit.changeId}/${edit.spot}${edit.recheck ? `@${edit.recheck}` : ""}`;
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
      const key = `${change.id}/${kept.spot}`;
      keys.add(kept.recheck ? `${key}@${kept.recheck}` : key);
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
    const missing = [...local].filter(key => !engine.has(key) && !sent.has(`${projectId}/${threadId}/${key}`));
    if (!missing.length) return;
    for (const key of missing) sent.add(`${projectId}/${threadId}/${key}`);
    sendKeeps(projectId, threadId, missing.flatMap(key => {
      const match = /^(.+)\/(\d+)(?:@(.+))?$/.exec(key);
      return match ? [{ changeId: match[1]!, spot: Number(match[2]), ...(match[3] && { recheck: match[3] }) }] : [];
    }));
  }, [projectId, threadId, local, engine]);
  return useMemo(() => engine.size ? new Set([...local, ...engine]) : local, [local, engine]);
}
const empty: ReadonlySet<string> = new Set();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
