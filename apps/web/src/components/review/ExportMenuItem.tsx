import { fullRenderContext } from "@scarlet/shared";
import { exportCounting, useExports } from "../../lib/exportJobs";
import { pct } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";
import { ProgressRing } from "../ui/ProgressRing";

/**
 * A reason to open Export, or nothing: the project's export stopped and the Export sheet hasn't shown why yet. The menu
 * that leads there is marked for it. It reads that alone, so an export's count doesn't draw the workspace again as it moves.
 */
export function useExportWarning(): string | undefined {
  const projectId = useProjectStore(s => s.current?.id);
  const stopped = useExports(s => { const job = projectId ? s.jobs[projectId] : undefined; return job?.phase === "failed" && !job.seen; });
  return stopped ? "The export didn’t finish" : undefined;
}

/** The header button and menu row follow the same job when the editor closes the export sheet. */
function useExportStatus(): { status?: string; file?: string; running?: boolean; progress?: number } {
  const projectId = useProjectStore(s => s.current?.id);
  const context = useProjectStore(s => s.current && fullRenderContext(s.current.project));
  const job = useExports(s => projectId ? s.jobs[projectId] : undefined);
  // A percent only while it moves, as in the sheet.
  if (job && "cancel" in job) {
    const progress = exportCounting(job) ? job.progress : undefined;
    return { status: progress === undefined ? "Exporting" : `Exporting ${pct(progress)}`, running: job.phase !== "choosing", progress };
  }
  return job?.phase === "done" && job.context === context ? { status: "Exported", file: job.path.split(/[\\/]/).pop() } : {};
}

export function ExportButton({ onOpen }: { onOpen(): void }) {
  const { status, running, progress } = useExportStatus();
  const description = running ? status : undefined;
  return <button type="button" className="btn-quiet" aria-haspopup="dialog" title={description} aria-description={description} onClick={onOpen}>
    {running && <ProgressRing className="simple-export-ring" progress={progress} />}Export
  </button>;
}

/**
 * Export's row in the simple view's menu. Like the Media row, it says what is going on in a word or two and carries the
 * menu's mark when something needs the editor. The sheet it opens has the rest: the file, the reason, Retry.
 */
export function ExportMenuItem({ onOpen, close }: { onOpen(): void; close(): void }) {
  const { status, file } = useExportStatus();
  const warning = useExportWarning();
  return <MenuItem onClick={() => { close(); onOpen(); }} title={warning ?? file}>
    <Icon name="export" />Export
    {status && <span className="menu-value">{status}</span>}
    {warning && <span className="menu-dot" role="img" aria-label={warning} />}
  </MenuItem>;
}
