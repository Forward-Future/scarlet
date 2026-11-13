import { useEffect, useState } from "react";
import type { TrashedProject } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { trashedLine } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { desktop } from "../../lib/desktop";
import { freedSpace, invalidateStorageScan } from "../../lib/storage";
import { ConfirmDialog, Icon, Modal, Spinner, InlineError } from "../ui/primitives";

/** Deleted projects stay here for 30 days and can be restored with everything in them. */
export function TrashButton() {
  const projectCount = useProjectStore(s => s.list.length);
  const loadList = useProjectStore((s) => s.loadList);
  const [error, setError] = useState("");
  const [items, setItems] = useState<TrashedProject[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [freed, setFreed] = useState("");

  const refresh = () =>
    api
      .trash()
      .then((r) => setItems(r.projects))
      .catch(() => undefined);
  useEffect(() => {
    void refresh();
  }, [projectCount]);

  // Measured while the Trash is open, so the confirmation can say what emptying it frees.
  const trashed = items.map((p) => `${p.id} ${p.deletedAt}`).join();
  useEffect(() => {
    setFreed("");
    if (!open || !items.length) return;
    let stale = false;
    desktop
      .measureProjectStorage(items.map(({ id, deletedAt }) => ({ id, deletedAt, segments: [] })))
      .then((sizes) => {
        if (!stale) setFreed(freedSpace(Object.values(sizes)));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [open, trashed]);

  if (!items.length) return null;

  return (
    <>
      <button className="btn-quiet" onClick={() => { setError(""); setOpen(true); }}>
        <Icon name="trash" size={12} /> Trash ({items.length})
      </button>
      <Modal
        open={open && !emptying}
        onClose={() => setOpen(false)}
        title="Trash"
        // The keyboard starts on the dialog: on the first Restore, Enter would put back a project nobody picked.
        focusSelf
        footer={
          <button className="btn-ghost" disabled={busy !== null} onClick={() => { setError(""); setEmptying(true); }}>
            Empty Trash
          </button>
        }
      >
        <ul className="divide-y divide-line">
          {items.map((p) => (
            <li key={p.id} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate">{p.name}</div>
                <div className="text-[11px] text-dim">{trashedLine(p.deletedAt, p.purgeAt)}</div>
              </div>
              <button
                className="btn-ghost"
                // One restore at a time: a second one's spinner would stop when the first finished.
                disabled={busy !== null}
                onClick={async () => {
                  setError("");
                  setBusy(p.id);
                  try {
                    await api.restoreProject(p.id);
                    await Promise.all([refresh(), loadList()]);
                    if (items.length <= 1) setOpen(false);
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === p.id && <Spinner className="size-3" />} Restore
              </button>
            </li>
          ))}
        </ul>
        <InlineError>{error}</InlineError>
      </Modal>
      {/* The engine refuses the whole selection if a project was restored or is busy, so nothing is half-deleted. */}
      <ConfirmDialog
        open={open && emptying}
        danger
        onClose={() => setEmptying(false)}
        title="Empty Trash?"
        body={`Permanently delete ${items.map((p) => p.name).join(", ")}, with ${items.length === 1 ? "its" : "their"} edits and imported media? This ${freed ? `frees ${freed} and ` : ""}cannot be undone.`}
        confirmLabel="Delete permanently"
        onConfirm={async () => {
          try {
            await api.cleanStorage({ kind: "trash", projects: items.map(({ id, deletedAt }) => ({ id, deletedAt })) });
            setOpen(false);
          } finally {
            invalidateStorageScan();
            await refresh();
          }
        }}
      />
    </>
  );
}
