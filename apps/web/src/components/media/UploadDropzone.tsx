import type { ReactNode } from "react";
import { fmtBytes } from "../../lib/format";
import { useFileDropTarget } from "../../lib/uiHooks";
import { Icon, Progress } from "../ui/primitives";
import type { UploadItem } from "./importQueue";

export { enqueueImports, filename, resumeAllImports, resumeImports, useImportCount, useUploader, type ImportSource, type LocalImport, type UploadItem } from "./importQueue";

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
  const { over, dropProps } = useFileDropTarget(onPaths, onFiles);
  return (
    <div {...dropProps} className={`relative ${className}`}>
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
