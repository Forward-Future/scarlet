import { useEffect, useMemo, useState } from "react";
import type { StorageCleanup } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { desktop, type DeveloperStorage } from "../../lib/desktop";
import { fmtBytes, plural, trashedLine } from "../../lib/format";
import { freedSpace, invalidateStorageScan, lastStorageScan, scanStorage, type MeasuredProject } from "../../lib/storage";
import { ConfirmDialog, Icon, InlineError } from "../ui/primitives";

const INITIAL_STORAGE_ROWS = 6;

const sumBytes = (rows: { bytes: number }[]) => rows.reduce((sum, r) => sum + r.bytes, 0);
const totalLabel = (rows: { bytes: number }[]) => fmtBytes(sumBytes(rows));

function DeveloperCaches() {
  const [rows, setRows] = useState<DeveloperStorage[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await desktop.developerStorage());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="card usage-dev" aria-label="Developer caches">
      <summary className="usage-dev-summary">
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-fg">Developer caches</span>
          <span className="text-[12px] text-dim truncate">Build and test folders</span>
        </span>
        <Icon name="chevron" size={12} />
      </summary>
      <div className="usage-dev-body">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-muted">Registered development folders. Compiler totals cover intermediate build files.</p>
          <button type="button" className="btn-quiet usage-row-action shrink-0" disabled={loading} onClick={() => void load()}>
            {loading ? "Scanning…" : "Scan folders"}
          </button>
        </div>
        {error && <div className="mt-2"><InlineError>{error}</InlineError></div>}
        {rows?.length === 0 && <p className="mt-3 text-[12.5px] text-dim">No build or test folders registered yet.</p>}
        {rows && rows.length > 0 && (
          <div className="usage-storage-list mt-3">
            {rows.map(r => (
              <div className="usage-storage-row" key={r.kind + r.path}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg">{r.kind === "cargo" ? "Compiler cache" : "Test workspace"}</div>
                  <div className="break-all text-[11.5px] text-dim font-mono mt-0.5">{r.path}</div>
                </div>
                <span className="text-[13px] font-medium tabular-nums text-fg shrink-0">
                  {r.estimated ? "≈ " : ""}{fmtBytes(r.bytes)}
                </span>
                <button
                  type="button"
                  className="btn-quiet usage-row-action shrink-0"
                  onClick={() => void desktop.revealPath(r.path).catch(e => setError(errorMessage(e)))}
                >
                  Show in folder
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export function StorageSettings() {
  const [scan, setScan] = useState(lastStorageScan);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showAllCache, setShowAllCache] = useState(false);
  const [selection, select] = useState<{ kind: StorageCleanup["kind"]; rows: MeasuredProject[] }>();

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setScan(await scanStorage());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  const trash = useMemo(
    () => [...(scan?.projects.filter(p => p.deletedAt) ?? [])].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
    [scan],
  );
  const active = useMemo(
    () => [...(scan?.projects.filter(p => !p.deletedAt) ?? [])].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
    [scan],
  );
  const eligible = useMemo(() => scan?.projects.filter(p => !p.busy && !p.missingSource) ?? [], [scan]);
  const eligibleCache = useMemo(() => active.filter(p => !p.busy && !p.missingSource && p.files > 0), [active]);
  const eligibleCacheBytes = sumBytes(eligible.filter(p => !p.deletedAt));
  const eligibleTrashBytes = sumBytes(eligible.filter(p => p.deletedAt));
  const eligibleTotalBytes = eligibleCacheBytes + eligibleTrashBytes;

  const notableCache = useMemo(
    () => active.filter(p => p.files > 0 || p.bytes > 0),
    [active],
  );
  const cleanCacheCount = active.length - notableCache.length;
  const cacheTotalBytes = sumBytes(active);
  const trashTotalBytes = sumBytes(trash);

  const visibleCache = showAllCache ? notableCache : notableCache.slice(0, INITIAL_STORAGE_ROWS);
  const lock = loading || !!error;

  const confirmBody = selection
    ? selection.kind === "trash"
      ? `Permanently delete ${selection.rows.map(r => r.name).join(", ")}? This ${freedSpace(selection.rows) ? `frees ${freedSpace(selection.rows)} and ` : ""}cannot be undone.`
      : selection.rows.length === 1
        ? `Remove generated render segments for ${selection.rows[0]!.name}? Scarlet can rebuild them from the project media.`
        : `Remove generated render segments for ${plural(selection.rows.length, "project")}? ${freedSpace(selection.rows) ? `This frees ${freedSpace(selection.rows)}. ` : ""}Scarlet can rebuild them from the project media.`
    : "";

  return (
    <div className="usage-stack">
      <section className="card usage-card" aria-label="Storage">
        <div className="usage-band" aria-label="Storage overview">
          <div className="usage-head">
            <h3>Storage</h3>
            <button type="button" className="btn-quiet usage-refresh" disabled={loading} onClick={() => void refresh()}>
              <span className={loading ? "inline-flex animate-spin" : "inline-flex"}>
                <Icon name="refresh" size={13} />
              </span>
              <span>{loading ? "Scanning…" : "Rescan"}</span>
            </button>
          </div>

          <div className="usage-storage-hero">
            <div className="usage-eyebrow">Space you can free</div>
            <div className="usage-figure">{scan ? totalLabel(eligible) : "—"}</div>
            <p className="usage-meta">
              {!scan && loading
                ? "Scanning project storage…"
                : eligible.some(p => p.estimated)
                  ? "Estimated cleanup size. Shared storage can reduce the space freed."
                  : "From idle projects."}
            </p>

            {eligibleTotalBytes > 0 && (
              <div className="usage-mix">
                <div className="usage-mix-bar" aria-hidden="true">
                  {eligibleCacheBytes > 0 && (
                    <span
                      className="usage-mix-seg is-input"
                      style={{ flexGrow: eligibleCacheBytes }}
                      title={`Render cache: ${fmtBytes(eligibleCacheBytes)}`}
                    />
                  )}
                  {eligibleTrashBytes > 0 && (
                    <span
                      className="usage-mix-seg is-warn"
                      style={{ flexGrow: eligibleTrashBytes }}
                      title={`Trash: ${fmtBytes(eligibleTrashBytes)}`}
                    />
                  )}
                </div>
                <div className="usage-mix-legend">
                  {eligibleCacheBytes > 0 && (
                    <span className="usage-legend-item">
                      <span className="usage-legend-dot is-input" aria-hidden="true" />
                      <span className="text-muted">Render cache</span>
                      <span className="font-medium text-fg tabular-nums">{fmtBytes(eligibleCacheBytes)}</span>
                    </span>
                  )}
                  {eligibleTrashBytes > 0 && (
                    <span className="usage-legend-item">
                      <span className="usage-legend-dot is-warn" aria-hidden="true" />
                      <span className="text-muted">Trash</span>
                      <span className="font-medium text-fg tabular-nums">{fmtBytes(eligibleTrashBytes)}</span>
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
          {notice && (
            <p role="status" className="usage-notice">
              <span className="text-ok inline-flex"><Icon name="check" size={13} /></span>
              <span>{notice}</span>
            </p>
          )}
        </div>

        <section className="usage-band" aria-label="Render cache">
          <div className="usage-subhead-row">
            <div className="usage-head-title">
              <h3 className="usage-subhead">Render cache</h3>
              {scan && (
                <span className="usage-head-meta tabular-nums">
                  {notableCache.length > 0
                    ? `${plural(notableCache.length, "project")} · ${fmtBytes(cacheTotalBytes)}`
                    : "Clean"}
                </span>
              )}
            </div>
            {eligibleCache.length > 1 && (
              <button
                type="button"
                className="btn-quiet usage-row-action"
                disabled={lock}
                onClick={() => select({ kind: "cache", rows: eligibleCache })}
              >
                Clear all
              </button>
            )}
          </div>

          {scan && !active.length && <p className="usage-empty">No projects in this library.</p>}
          {scan && active.length > 0 && !notableCache.length && (
            <p className="usage-empty">No cached render files across {plural(active.length, "project")}.</p>
          )}

          {visibleCache.length > 0 && (
            <div className="usage-storage-list">
              {visibleCache.map(p => {
                const barPct = cacheTotalBytes > 0 && p.bytes > 0
                  ? Math.max(1.5, Math.min(100, (p.bytes / cacheTotalBytes) * 100))
                  : 0;
                return (
                  <div key={p.id} className="usage-storage-item">
                    <div className="usage-storage-row">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-fg">{p.name}</div>
                        <div className={`text-[11.5px] mt-0.5 ${!p.busy && p.missingSource ? "text-warn" : "text-muted"}`}>
                          {p.busy
                            ? "Cleanup paused during active work"
                            : p.missingSource
                              ? "Reconnect missing media to clear this cache"
                              : `${p.files} ${p.files === 1 ? "cached file" : "cached files"}`}
                        </div>
                      </div>
                      <span className="text-[13px] font-medium tabular-nums text-fg shrink-0">
                        {p.estimated ? "≈ " : ""}{fmtBytes(p.bytes)}
                      </span>
                      <button
                        type="button"
                        className="btn-quiet usage-row-action shrink-0"
                        disabled={lock || p.busy || p.missingSource || !p.files}
                        onClick={() => select({ kind: "cache", rows: [p] })}
                      >
                        Clear cache
                      </button>
                    </div>
                    {barPct > 0 && (
                      <div className="usage-row-bar" aria-hidden="true">
                        <span className="usage-row-bar-fill" style={{ width: `${barPct}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}

              {notableCache.length > INITIAL_STORAGE_ROWS && (
                <button
                  type="button"
                  className="usage-expand-btn"
                  onClick={() => setShowAllCache(v => !v)}
                >
                  {showAllCache ? "Show fewer" : `Show all ${notableCache.length}`}
                </button>
              )}
            </div>
          )}

          {notableCache.length > 0 && cleanCacheCount > 0 && (
            <p className="usage-clean-note">
              {plural(cleanCacheCount, "other project")} with no cached files.
            </p>
          )}
        </section>

        <section className="usage-band" aria-label="Trash">
          <div className="usage-subhead-row">
            <div className="usage-head-title">
              <h3 className="usage-subhead">Trash</h3>
              {trash.length > 0 && (
                <span className="usage-head-meta tabular-nums">
                  {plural(trash.length, "project")} · {totalLabel(trash)}
                </span>
              )}
            </div>
            {trash.length > 0 && (
              <button
                type="button"
                className="btn-danger usage-row-action"
                disabled={lock || trash.some(p => p.busy)}
                onClick={() => select({ kind: "trash", rows: trash })}
              >
                Empty Trash
              </button>
            )}
          </div>

          {scan && !trash.length && <p className="usage-empty">Trash is empty.</p>}

          {trash.length > 0 && (
            <>
              <p className="usage-trash-note">
                Projects stay here for 30 days. Emptying Trash permanently removes their edits and imported media.
              </p>
              <div className="usage-storage-list">
                {trash.map(p => {
                  const barPct = trashTotalBytes > 0 && p.bytes > 0
                    ? Math.max(1.5, Math.min(100, (p.bytes / trashTotalBytes) * 100))
                    : 0;
                  return (
                    <div key={p.id} className="usage-storage-item">
                      <div className="usage-storage-row">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-fg">{p.name}</div>
                          <div className="text-[11.5px] text-muted mt-0.5">
                            {p.busy
                              ? "Cleanup paused during active work"
                              : trashedLine(p.deletedAt!, p.purgeAt)}
                          </div>
                        </div>
                        <span className="text-[13px] font-medium tabular-nums text-fg shrink-0">
                          {p.estimated ? "≈ " : ""}{fmtBytes(p.bytes)}
                        </span>
                      </div>
                      {barPct > 0 && (
                        <div className="usage-row-bar" aria-hidden="true">
                          <span className="usage-row-bar-fill is-warn" style={{ width: `${barPct}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </section>

      {import.meta.env.DEV && <DeveloperCaches />}

      {selection && (
        <ConfirmDialog
          open
          danger={selection.kind === "trash"}
          onClose={() => select(undefined)}
          title={selection.kind === "trash" ? "Empty Trash?" : "Clear render cache?"}
          body={confirmBody}
          confirmLabel={selection.kind === "trash" ? "Delete permanently" : "Clear cache"}
          onConfirm={async () => {
            // What the last cleanup said doesn't stand beside this one's failure.
            setNotice("");
            try {
              await api.cleanStorage({
                kind: selection.kind,
                projects: selection.rows.map(({ id, deletedAt }) => ({ id, deletedAt })),
              });
              setNotice(selection.kind === "trash" ? "Trash emptied." : "Render cache cleared.");
            } finally {
              invalidateStorageScan();
              await refresh();
            }
          }}
        />
      )}
    </div>
  );
}
