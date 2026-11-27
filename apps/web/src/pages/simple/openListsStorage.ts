import type { OpenList } from "./types";

const isOpenList = (list: unknown): list is NonNullable<OpenList> => list === "all" || list === "need" || list === "working" || list === "done";

/**
 * The list each request had open in the chat, kept per project: after Scarlet restarts the chat comes back as it was,
 * and a request about one edit still sits under that edit's row instead of dropping below a list that doesn't have it.
 */
const openListsKey = (projectId: string) => `scarlet.openLists.v1:${projectId}`;

export function savedOpenLists(projectId: string): Record<string, OpenList> {
  try {
    const saved = JSON.parse(localStorage.getItem(openListsKey(projectId)) ?? "null") as unknown;
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(Object.entries(saved).filter(([, list]) => isOpenList(list))) as Record<string, OpenList>;
  } catch {
    return {};
  }
}

export function saveOpenLists(projectId: string, lists: Record<string, OpenList>) {
  try {
    const open = Object.fromEntries(Object.entries(lists).filter(([, list]) => isOpenList(list)));
    if (Object.keys(open).length) localStorage.setItem(openListsKey(projectId), JSON.stringify(open));
    else localStorage.removeItem(openListsKey(projectId));
  } catch { /* Without storage the lists last for this session only. */ }
}

/** The requests the editor folded to their headings, kept per project like the lists: the chat comes back as it was left. */
const collapsedKey = (projectId: string) => `scarlet.collapsedRequests.v1:${projectId}`;

export function savedCollapsed(projectId: string): ReadonlySet<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(collapsedKey(projectId)) ?? "null") as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((run): run is string => typeof run === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(projectId: string, runs: ReadonlySet<string>) {
  try {
    if (runs.size) localStorage.setItem(collapsedKey(projectId), JSON.stringify([...runs]));
    else localStorage.removeItem(collapsedKey(projectId));
  } catch { /* Without storage the folds last for this session only. */ }
}

/** Which tab the fixed bottom review dock had open, kept per project across restarts. */
const dockListKey = (projectId: string) => `scarlet.reviewDock.v1:${projectId}`;

export function savedDockList(projectId: string): OpenList {
  try {
    const saved = JSON.parse(localStorage.getItem(dockListKey(projectId)) ?? "null") as unknown;
    return saved === "need" ? undefined : isOpenList(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function saveDockList(projectId: string, list: OpenList) {
  try {
    if (isOpenList(list)) localStorage.setItem(dockListKey(projectId), JSON.stringify(list));
    else localStorage.removeItem(dockListKey(projectId));
  } catch { /* Without storage the tab choice lasts for this session only. */ }
}
