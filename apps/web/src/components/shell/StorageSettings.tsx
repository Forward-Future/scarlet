import { useEffect, useState } from "react";
import type { StorageCleanup } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { desktop, type DeveloperStorage } from "../../lib/desktop";
import { fmtBytes, trashedLine } from "../../lib/format";
import { freedSpace, invalidateStorageScan, lastStorageScan, scanStorage, type MeasuredProject } from "../../lib/storage";
import { ConfirmDialog, InlineError, SectionTitle } from "../ui/primitives";

const total = (rows: {bytes: number}[]) => fmtBytes(rows.reduce((sum,r) => sum + r.bytes, 0));

function DeveloperCaches() {
  const [rows, setRows] = useState<DeveloperStorage[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true); setError("");
    try { setRows(await desktop.developerStorage()); } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  };
  return <section className="card p-5 space-y-3" aria-label="Developer caches">
    <div className="flex items-center justify-between gap-3"><SectionTitle>Developer caches</SectionTitle>
      <button className="btn-quiet" disabled={loading} onClick={() => void load()}>{loading ? "Scanning…" : "Scan folders"}</button></div>
    <p className="text-sm text-muted">Registered development folders. Compiler totals cover intermediate build files.</p>
    {error && <InlineError>{error}</InlineError>}
    {rows?.length === 0 && <p className="text-sm text-muted">No build or test folders registered yet.</p>}
    {rows?.map(r => <div className="flex items-center gap-4 border-t border-line py-2" key={r.kind+r.path}>
      <div className="min-w-0 flex-1"><b className="text-sm">{r.kind === "cargo" ? "Compiler cache" : "Test workspace"}</b>
        <div className="break-all text-xs text-muted">{r.path}</div></div>
      <span className="text-sm tabular-nums">{r.estimated ? "≈ " : ""}{fmtBytes(r.bytes)}</span>
      <button className="btn-quiet" onClick={() => void desktop.revealPath(r.path).catch(e => setError(errorMessage(e)))}>Show in folder</button>
    </div>)}
  </section>;
}

export function StorageSettings() {
  const [scan, setScan] = useState(lastStorageScan);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, select] = useState<{kind: StorageCleanup["kind"]; rows: MeasuredProject[]}>();
  async function refresh() {
    setLoading(true); setError("");
    try { setScan(await scanStorage()); } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const trash = scan?.projects.filter(p => p.deletedAt) ?? [];
  const active = scan?.projects.filter(p => !p.deletedAt) ?? [];
  const eligible = scan?.projects.filter(p => !p.busy && !p.missingSource) ?? [];
  const lock = loading || !!error;
  return <div className="space-y-4">
    <section className="card p-5" aria-label="Storage overview">
      {/* The figure is what the two lists under it can give back, not what the projects take up. */}
      <div className="flex items-center justify-between gap-3"><SectionTitle>Space you can free</SectionTitle>
        <button className="btn-quiet" disabled={loading} onClick={() => void refresh()}>{loading ? "Scanning…" : "Rescan"}</button></div>
      <div className="text-3xl font-semibold tabular-nums">{scan ? total(eligible) : "—"}</div>
      <p className="text-sm text-muted">{eligible.some(p => p.estimated) ? "Estimated cleanup size. Shared storage can reduce the space freed." : "From idle projects."}</p>
    </section>
    {error && <InlineError>{error}</InlineError>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {[{kind:"cache" as const,title:"Render cache",rows:active},
      {kind:"trash" as const,title:"Trash",rows:trash,body:"Projects stay here for 30 days. Emptying Trash permanently removes their edits and imported media."}].map(group =>
      <section className="card p-5 space-y-3" key={group.kind} aria-label={group.title}>
        <div className="flex items-center justify-between gap-3"><SectionTitle>{group.title}</SectionTitle>
          {group.kind === "trash" && trash.length > 0 && <button className="btn-ghost" disabled={lock || trash.some(p => p.busy)} onClick={() => select({kind:"trash",rows:trash})}>Empty Trash</button>}</div>
        {group.body && <p className="text-sm text-muted">{group.body}</p>}
        {scan && !group.rows.length && <p className="text-sm text-muted">{group.kind === "trash" ? "Trash is empty." : "No projects in this library."}</p>}
        {group.rows.map(p => <div key={p.id} className="flex items-center gap-3 border-t border-line py-2">
          <div className="min-w-0 flex-1"><div className="break-words text-sm font-medium">{p.name}</div>
          <span className="text-xs text-muted">{p.busy ? "Cleanup paused during active work" : p.missingSource ? "Reconnect missing media to clear this cache" : p.deletedAt ? trashedLine(p.deletedAt, p.purgeAt) : p.files + (p.files === 1 ? " cached file" : " cached files")}</span></div>
          <span className="text-sm tabular-nums">{p.estimated ? "≈ " : ""}{fmtBytes(p.bytes)}</span>
          {group.kind === "cache" && <button className="btn-quiet" disabled={lock || p.busy || p.missingSource || !p.files} onClick={() => select({kind:"cache", rows:[p]})}>Clear cache</button>}
        </div>)}
      </section>)}
    {import.meta.env.DEV && <DeveloperCaches />}
    {selection && <ConfirmDialog open danger={selection.kind === "trash"} onClose={() => select(undefined)}
      title={selection.kind === "trash" ? "Empty Trash?" : "Clear render cache?"}
      body={selection.kind === "trash" ? `Permanently delete ${selection.rows.map(r => r.name).join(", ")}? This ${freedSpace(selection.rows) ? `frees ${freedSpace(selection.rows)} and ` : ""}cannot be undone.` : `Remove generated render segments for ${selection.rows[0]!.name}? Scarlet can rebuild them from the project media.`}
      confirmLabel={selection.kind === "trash" ? "Delete permanently" : "Clear cache"}
      onConfirm={async () => {
        // What the last cleanup said doesn't stand beside this one's failure.
        setNotice("");
        try {
          await api.cleanStorage({kind:selection.kind, projects:selection.rows.map(({id,deletedAt}) => ({id,deletedAt}))});
          setNotice(selection.kind === "trash" ? "Trash emptied." : "Render cache cleared.");
        } finally { invalidateStorageScan(); await refresh(); }
      }}/>}
  </div>;
}
