import type { OpenList } from "./types";

/**
 * The list each request had open in the chat, kept per project: after Scarlet restarts the chat comes back as it was,
 * and a request about one edit still sits under that edit's row instead of dropping below a list that doesn't have it.
 */
const openListsKey = (projectId: string) => `scarlet.openLists.v1:${projectId}`;

export function savedOpenLists(projectId: string): Record<string, OpenList> {
  try {
    const saved = JSON.parse(localStorage.getItem(openListsKey(projectId)) ?? "null") as unknown;
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(Object.entries(saved).filter(([, list]) => list === "all" || list === "need")) as Record<string, OpenList>;
  } catch {
    return {};
  }
}

export function saveOpenLists(projectId: string, lists: Record<string, OpenList>) {
  try {
    const open = Object.fromEntries(Object.entries(lists).filter(([, list]) => list === "all" || list === "need"));
    if (Object.keys(open).length) localStorage.setItem(openListsKey(projectId), JSON.stringify(open));
    else localStorage.removeItem(openListsKey(projectId));
  } catch { /* Without storage the lists last for this session only. */ }
}
