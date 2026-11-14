import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { ProjectSummary } from "@scarlet/shared";
import type { MediaAsset } from "@scarlet/timeline";
import { dropTargets, fileDropZone } from "../../lib/dropTargets";
import { engineUnavailable, errorMessage, IS_DESKTOP } from "../../lib/client";
import { canResumeFirstClip, matchAddedClip, resumeFirstClip } from "../../lib/firstClipFormat";
import { fmtBytes } from "../../lib/format";
import { addPendingImports, isLink, markImportStarted, pendingImports, removePendingImport, retryInterruptedImport, type PendingImport } from "../../lib/pendingImports";
import { importLocalFile, uploadMedia } from "../../lib/upload";
import { useProjectStore } from "../../stores/project";
import { Icon, Progress } from "../ui/primitives";

export interface UploadItem {
  id: number;
  name: string;
  size?: number;
  progress: number;
  state: "uploading" | "preparing" | "done" | "error";
  error?: string;
  abort?: () => void;
}

let seq = 1;

export interface LocalImport {
  projectId: string;
  name: string;
  path: string;
  /** Its place among everything asked for since the queue was last empty, and how many that is: more can join while it waits. */
  position: number;
  total: number;
  checked?: number;
}

export type ImportSource = File | string;
/**
 * What a source is called while it's added. A link's last part is its name when that reads as a file's, which is
 * how the engine names it; any other link, such as one to Google Drive, goes by the link itself.
 */
export function filename(source: ImportSource) {
  if (typeof source !== "string") return source.name;
  if (!isLink(source)) return source.split(/[\\/]/).pop() || source;
  try {
    const last = new URL(source).pathname.split("/").pop();
    return last?.includes(".") ? last : source;
  } catch {
    return source;
  }
}

interface ProjectImports {
  items: UploadItem[];
  localImport: LocalImport | null;
  pending: number;
  /** Imports ended since the queue was last empty. */
  ended: number;
}

const empty: ProjectImports = { items: [], localImport: null, pending: 0, ended: 0 };
const useImports = create<Record<string, ProjectImports>>(() => ({}));
const queues = new Map<string, Promise<void>>();
// A lost engine stops every batch queued for that project until a fresh read can resume it.
const disconnected = new Set<string>();
/** Imports this session is already working through, so reopening a project doesn't queue them twice. */
const queued = new Set<string>();
const queueKey = (projectId: string, source: string) => JSON.stringify([projectId, source]);

function update(projectId: string, change: (state: ProjectImports) => Partial<ProjectImports>) {
  useImports.setState(state => {
    const previous = state[projectId] ?? empty;
    const project = { ...previous, ...change(previous) };
    // The file being added counts every import waiting behind it, also a link or files added after it began: until
    // their turn that count is the only place Media shows them.
    if (project.localImport) project.localImport = { ...project.localImport, position: project.ended + 1, total: project.ended + project.pending };
    const next = { ...state };
    if (project.pending || project.items.length) next[projectId] = project;
    else delete next[projectId];
    return next;
  }, true);
}

function dismiss(projectId: string, id: number) {
  update(projectId, state => ({ items: state.items.filter(item => item.id !== id) }));
}

/**
 * Each project's queue outlives its screen. Read one original at a time in selection order. `matchFormat` comes
 * with a new project's first files, which are remembered as such so a quit doesn't lose the match.
 */
export function enqueueImports(projectId: string, sources: ImportSource[], matchFormat?: (media: MediaAsset) => Promise<void>) {
  if (!sources.length) return Promise.resolve();
  sources = sources.filter(source => {
    if (typeof source !== "string") return true;
    const key = queueKey(projectId, source);
    if (queued.has(key)) return false;
    queued.add(key);
    return true;
  });
  if (!sources.length) return queues.get(projectId) ?? Promise.resolve();
  // Files by path are remembered until each is in the project, so a quit picks up where it stopped.
  const paths = sources.filter((source): source is string => typeof source === "string");
  addPendingImports(projectId, paths, !!matchFormat);
  update(projectId, state => ({ pending: state.pending + sources.length }));
  const job = (queues.get(projectId) ?? Promise.resolve()).then(async () => {
    for (const source of sources) {
      const id = seq++;
      const name = filename(source);
      const patch = (changes: Partial<UploadItem>) => update(projectId, state => ({
        items: state.items.map(item => item.id === id ? { ...item, ...changes } : item),
      }));
      let keepPending = typeof source === "string" && disconnected.has(projectId);
      try {
        if (keepPending) continue;
        let media: MediaAsset;
        // Check when this file gets its turn: earlier files may have finished without yielding any video.
        const deferFormat = !matchFormat && pendingImports(projectId).some(i => i.setsFormat);
        if (typeof source === "string") {
          const current = { projectId, name, path: source, position: 1, total: 1 };
          update(projectId, () => ({ localImport: current }));
          const importId = markImportStarted(projectId, source);
          media = await importLocalFile(projectId, source, checked => update(projectId, () => ({ localImport: { ...current, checked } })), importId, deferFormat);
        } else {
          const upload = uploadMedia(projectId, source, progress => patch({ progress, state: progress === 1 ? "preparing" : "uploading" }), deferFormat);
          update(projectId, state => ({ items: [...state.items, { id, name, size: source.size, progress: 0, state: "uploading", abort: upload.abort }] }));
          media = await upload.promise;
        }
        useProjectStore.getState().upsertMedia(projectId, media);
        await matchFormat?.(media);
        if (typeof source !== "string") {
          patch({ state: "done", progress: 1 });
          window.setTimeout(() => dismiss(projectId, id), 6000);
        }
      } catch (error) {
        if (typeof source === "string" && engineUnavailable(error)) {
          disconnected.add(projectId);
          keepPending = retryInterruptedImport(projectId, source);
        }
        if (keepPending) continue;
        if (error instanceof DOMException && error.name === "AbortError") dismiss(projectId, id);
        else update(projectId, state => ({ items: [...state.items.filter(item => item.id !== id),
          { id, name, progress: 0, state: "error", error: errorMessage(error) }] }));
      } finally {
        if (typeof source === "string") {
          if (!keepPending) removePendingImport(projectId, source);
          queued.delete(queueKey(projectId, source));
        }
        update(projectId, state => ({ pending: state.pending - 1, ended: state.pending > 1 ? state.ended + 1 : 0, localImport: null }));
      }
    }
  }).finally(() => {
    if (queues.get(projectId) === job) queues.delete(projectId);
  });
  queues.set(projectId, job);
  return job;
}

/**
 * Carry on with the imports that were waiting or copying when Scarlet last closed. A file being copied that reached the
 * project just before the quit isn't added twice. A new project's first files still give it its format, so they
 * wait, still saved, until it is on screen to show whether it is still new.
 */
export function resumeImports(projectId: string, media: readonly MediaAsset[]) {
  disconnected.delete(projectId);
  // The new engine can answer the project read before the old import rejects. Recheck when its
  // queue settles, so that late rejection still gets this reconnect's single retry.
  const running = queues.get(projectId);
  if (running) void running.then(() => {
    if (disconnected.has(projectId)) return resumeImports(projectId, media);
  });
  const waiting = pendingImports(projectId).filter(i => !queued.has(queueKey(projectId, i.source)) && (!i.setsFormat || canResumeFirstClip(projectId)));
  // Only a file whose copy had begun can already be in the project. One still waiting its turn is imported, also when
  // a file of the same name from another folder arrived meanwhile.
  const added = (i: PendingImport) => {
    if (i.started === false) return;
    if (i.importId) return media.find(m => m.importId === i.importId);
    // Older queues recorded only the filename and when the file was chosen.
    return media.find(m => m.name === filename(i.source) && (m.provenance?.createdAt ?? "") >= i.at);
  };
  const matchFormat = waiting.some(i => i.setsFormat) ? resumeFirstClip(projectId) : undefined;
  const jobs: Promise<void>[] = [];
  const first: string[] = [], later: string[] = [];
  for (const entry of waiting) {
    const asset = added(entry);
    if (!asset) {
      (entry.setsFormat ? first : later).push(entry.source);
    } else if (entry.setsFormat && matchFormat) {
      // A second quit can interrupt this last step even when the file itself has arrived.
      const key = queueKey(projectId, entry.source);
      queued.add(key);
      jobs.push(matchFormat(asset).finally(() => {
        removePendingImport(projectId, entry.source);
        queued.delete(key);
      }));
    } else {
      removePendingImport(projectId, entry.source);
    }
  }
  // Only a project's first files set its format. They were chosen before anything added later, so the saved order holds.
  jobs.push(enqueueImports(projectId, first, matchFormat), enqueueImports(projectId, later));
  return Promise.all(jobs).then(() => undefined);
}

export function useImportCount(projectId: string) {
  return useImports(state => state[projectId]?.pending ?? 0);
}

/**
 * Add files to a project. While it is still new, its first video gives it its format, as files chosen with a new
 * project do. The project on screen is read from the store; a card passes its summary.
 */
export function useUploader(projectId: string, summary?: ProjectSummary) {
  const { items, localImport } = useImports(state => state[projectId] ?? empty);
  // Read as the files are added, so the match sees the project as it is then.
  const matchFormat = () => {
    const current = useProjectStore.getState().current;
    if (current?.id === projectId) return matchAddedClip(current.project, current.media.some(m => m.kind === "video"));
    // The poster is the project's first video. Older engines leave it out, so then any file counts.
    if (summary) return matchAddedClip(summary, summary.poster === undefined ? summary.mediaCount > 0 : !!summary.poster);
  };
  return {
    items, localImport,
    start: (files: FileList | File[]) => { void enqueueImports(projectId, Array.from(files), matchFormat()); },
    startPaths: (paths: string[]) => enqueueImports(projectId, paths, matchFormat()),
    dismiss: (id: number) => dismiss(projectId, id),
  };
}

export function UploadList({ items, onDismiss }: { items: UploadItem[]; onDismiss: (id: number) => void }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5 mb-3">
      {items.map((it) => (
        <li key={it.id} className="card p-2 text-[12px]">
          <div className="flex items-center gap-2">
            <Icon name="upload" size={12} />
            <span className="truncate flex-1">{it.name}</span>
            {it.size !== undefined && <span className="text-dim">{fmtBytes(it.size)}</span>}
            <span className={it.state === "error" ? "text-bad" : "text-muted"}>
              {it.state === "uploading" ? `${Math.floor(it.progress * 100)}%` : { preparing: "Preparing…", done: "Added", error: "Failed" }[it.state]}
            </span>
            {it.state === "uploading" && (
              <button className="btn-quiet py-0.5" onClick={it.abort}>
                Cancel
              </button>
            )}
            {(it.state === "done" || it.state === "error") && (
              <button className="btn-icon size-5" aria-label="Dismiss" title="Dismiss" onClick={() => onDismiss(it.id)}>
                <Icon name="x" size={10} />
              </button>
            )}
          </div>
          {it.state === "uploading" && <Progress value={it.progress} className="mt-1.5" />}
          {it.error && <div className="text-bad mt-1">{it.error}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Highlight the drop target and add files dropped anywhere inside it. */
export function Dropzone({ onFiles, onPaths, children, className = "", label = "Drop media here", notice }: { onFiles: (files: FileList) => void; onPaths: (paths: string[]) => void; children: ReactNode; className?: string; label?: string; notice?: string }) {
  const [over, setOver] = useState(false);
  const zone = useRef<HTMLDivElement>(null);
  const handlePaths = useRef(onPaths);
  useLayoutEffect(() => { handlePaths.current = onPaths; }, [onPaths]);
  useLayoutEffect(() => {
    const el = zone.current!;
    dropTargets.set(el, { highlight: setOver, drop: paths => handlePaths.current(paths) });
    return () => { dropTargets.delete(el); };
  }, []);
  return (
    <div
      ref={zone} data-file-drop="" className={`relative ${className}`}
      onDragOver={(e) => {
        if (!IS_DESKTOP && e.dataTransfer.types.includes("Files") && fileDropZone(e.target) === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!IS_DESKTOP && e.dataTransfer.files.length && fileDropZone(e.target) === e.currentTarget) {
          e.stopPropagation();
          onFiles(e.dataTransfer.files);
        }
      }}
    >
      {children}
      {over && (
        <div className="absolute inset-0 z-10 rounded-lg border-2 border-dashed border-fg/40 bg-panel/95 flex flex-col gap-1 items-center justify-center text-center text-fg font-medium pointer-events-none">
          {label}
          {notice && <span className="text-xs text-muted">{notice}</span>}
        </div>
      )}
    </div>
  );
}
