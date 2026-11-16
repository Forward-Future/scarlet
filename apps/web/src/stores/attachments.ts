import { create } from "zustand";
import type { TaskAttachment } from "@scarlet/shared";
import { api, errorMessage } from "../lib/client";

/** A file dropped or pasted on the message box, on its way into the project or there, waiting for the next message. */
export interface PendingAttachment {
  key: string;
  name: string;
  state: "adding" | "ready" | "failed";
  attachment?: TaskAttachment;
  /** Why it couldn't be added. */
  error?: string;
}

/** How many files one message can carry, as the engine takes them. */
const MAX_ATTACHMENTS = 20;

interface AttachmentsState {
  /** By project: the next message there carries them, whichever request the box is aimed at. */
  byProject: Record<string, PendingAttachment[]>;
  /** Add files: a browser's or a pasted file's bytes, or a path on this computer, as the desktop app's drops give. */
  add(projectId: string, files: ReadonlyArray<File | { path: string }>): void;
  remove(projectId: string, key: string): void;
  /** The files ready to go, once any still being added have landed. */
  settled(projectId: string): Promise<PendingAttachment[]>;
  /** Take the files a message carried off the line, with any that failed. */
  sent(projectId: string, keys: readonly string[]): void;
}

const uploads = new Map<string, Promise<void>>();
let next = 0;
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export const useAttachmentsStore = create<AttachmentsState>((set, get) => {
  const patch = (projectId: string, key: string, change: Partial<PendingAttachment>) => set(state => ({
    byProject: { ...state.byProject, [projectId]: (state.byProject[projectId] ?? []).map(a => a.key === key ? { ...a, ...change } : a) },
  }));
  return {
    byProject: {},
    add: (projectId, files) => {
      const room = MAX_ATTACHMENTS - (get().byProject[projectId]?.length ?? 0);
      const taken = files.slice(0, Math.max(0, room));
      if (!taken.length) return;
      const rows = taken.map(file => ({ file, row: { key: `att-${++next}`, name: "path" in file ? baseName(file.path) : file.name || "Pasted file", state: "adding" as const } }));
      set(state => ({ byProject: { ...state.byProject, [projectId]: [...state.byProject[projectId] ?? [], ...rows.map(r => r.row)] } }));
      for (const { file, row } of rows) {
        const upload = ("path" in file ? api.uploadAttachment(projectId, { path: file.path }) : api.uploadAttachment(projectId, file, file.name || undefined))
          .then(({ attachment }) => patch(projectId, row.key, { state: "ready", attachment, name: attachment.name }),
            (e: unknown) => patch(projectId, row.key, { state: "failed", error: errorMessage(e) }))
          .finally(() => uploads.delete(row.key));
        uploads.set(row.key, upload);
      }
    },
    remove: (projectId, key) => set(state => ({
      byProject: { ...state.byProject, [projectId]: (state.byProject[projectId] ?? []).filter(a => a.key !== key) },
    })),
    settled: async projectId => {
      const waiting = (get().byProject[projectId] ?? []).flatMap(a => uploads.get(a.key) ?? []);
      await Promise.all(waiting);
      return (get().byProject[projectId] ?? []).filter(a => a.state === "ready");
    },
    sent: (projectId, keys) => set(state => ({
      byProject: { ...state.byProject, [projectId]: (state.byProject[projectId] ?? []).filter(a => !keys.includes(a.key) && a.state !== "failed") },
    })),
  };
});
