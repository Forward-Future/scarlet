import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/client";
import { desktop } from "../../lib/desktop";
import { fileBaseName } from "../../lib/format";
import { useUiStore, type ExportNotice } from "../../stores/ui";
import { Icon } from "../ui/primitives";

function exportLabel(format?: ExportNotice["format"]) {
  if (format === "folder") return "Exported for Resolve, Final Cut or Premiere";
  if (format === "srt" || format === "vtt") return "Captions exported";
  if (format === "otio") return "Exported";
  return "Video exported";
}

export function ExportStarNotice() {
  const notice = useUiStore(s => s.exportNotice);
  const starVisible = useUiStore(s => s.exportStarNotice === "visible");
  const dismissNotice = useUiStore(s => s.dismissExportNotice);
  const dismissStar = useUiStore(s => s.dismissExportStar);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    setActionError("");
  }, [notice?.path, starVisible]);

  function dismiss() {
    setActionError("");
    dismissNotice();
    if (starVisible) dismissStar();
  }

  async function reveal() {
    if (!notice) return;
    setActionError("");
    try {
      await desktop.revealPath(notice.path);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function openRepository() {
    setActionError("");
    try {
      await desktop.openUrl("https://github.com/Forward-Future/scarlet");
      dismiss();
    } catch {
      setActionError("Couldn’t open GitHub. Try again.");
    }
  }

  if (!notice && !starVisible) return null;
  return <aside aria-label="Export complete" className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-4 py-1.5">
    <span role="status" className="mr-auto flex min-w-0 items-center gap-2 font-medium">
      <span className="inline-flex shrink-0 items-center gap-2">
        <Icon name="check" /> {exportLabel(notice?.format)}
      </span>
      {notice && <>
        <span className="shrink-0 font-normal text-muted" aria-hidden>·</span>
        <span className="truncate font-normal text-muted" title={notice.path} data-log-private>{fileBaseName(notice.path)}</span>
      </>}
    </span>
    {actionError && <span className="truncate text-muted" data-log-private>{actionError}</span>}
    {notice && <button type="button" className="btn-quiet shrink-0 text-fg" data-log-control="reveal-export" onClick={reveal}>Show in folder</button>}
    {starVisible && <button type="button" className="btn-quiet shrink-0 text-fg" onClick={openRepository}><Icon name="star" /> Star on GitHub</button>}
    <button
      type="button"
      className="btn-icon shrink-0"
      aria-label={starVisible ? "Dismiss GitHub invitation" : "Dismiss export notice"}
      title="Dismiss"
      onClick={dismiss}
    >
      <Icon name="x" />
    </button>
  </aside>;
}
