import { fullRenderContext } from "@scarlet/shared";
import { exportCounting, useExports } from "../../lib/exportJobs";
import { pct } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { MenuItem } from "../shell/WorkspaceNavigation";
import { Icon } from "../ui/primitives";

/**
 * A reason to open Export, or nothing: the project's export stopped and the Export sheet hasn't shown why yet. The menu
 * that leads there is marked for it. It reads that alone, so an export's count doesn't draw the workspace again as it moves.
 */
export function useExportWarning(): string | undefined {
  const projectId = useProjectStore(s => s.current?.id);
  const stopped = useExports(s => { const job = projectId ? s.jobs[projectId] : undefined; return job?.phase === "failed" && !job.seen; });
  return stopped ? "The export didn’t finish" : undefined;
}

/** What the project's export is doing, for its row: a word or two while it runs or once the video as it is now has been exported. */
function useExportStatus(): { status?: string; file?: string } {
  const projectId = useProjectStore(s => s.current?.id);
  const context = useProjectStore(s => s.current && fullRenderContext(s.current.project));
  const job = useExports(s => projectId ? s.jobs[projectId] : undefined);
  // A percent only while it moves, as in the sheet.
  if (job && "cancel" in job) return { status: exportCounting(job) ? `Exporting ${pct(job.progress)}` : "Exporting" };
  return job?.phase === "done" && job.context === context ? { status: "Exported", file: job.path.split(/[\\/]/).pop() } : {};
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
