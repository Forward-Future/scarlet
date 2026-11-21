import { fullRenderContext } from "@scarlet/shared";
import { exportCounting, useExports } from "../../lib/exportJobs";
import { pct } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { ProgressLine } from "../ui/ProgressLine";

/**
 * A reason to open Export, or nothing: the project's export stopped and the Export sheet hasn't shown why yet. The
 * header's Export button is marked for it.
 */
function useExportWarning(): string | undefined {
  const projectId = useProjectStore(s => s.current?.id);
  const stopped = useExports(s => { const job = projectId ? s.jobs[projectId] : undefined; return job?.phase === "failed" && !job.seen; });
  return stopped ? "The export didn’t finish" : undefined;
}

/** What the project's export is doing when the editor closes the export sheet. */
function useExportStatus(): { status?: string; file?: string; running?: boolean; progress?: number } {
  const projectId = useProjectStore(s => s.current?.id);
  const context = useProjectStore(s => s.current && fullRenderContext(s.current.project));
  const job = useExports(s => projectId ? s.jobs[projectId] : undefined);
  // A percent only while it moves, as in the sheet.
  if (job && "cancel" in job) {
    if (job.phase === "choosing") return {};
    const progress = exportCounting(job) ? job.progress : undefined;
    return { status: progress === undefined ? "Exporting" : `Exporting ${pct(progress)}`, running: true, progress };
  }
  return job?.phase === "done" && job.context === context ? { status: "Exported", file: job.path.split(/[\\/]/).pop() } : {};
}

/**
 * The header's Export button. While the video exports, a line under its word fills as far as it has got, as Media's
 * does while videos cache. Hover names the export's status, and an export that stopped puts the amber mark on it until
 * the Export sheet has shown why.
 */
export function ExportButton({ onOpen }: { onOpen(): void }) {
  const { status, file, running, progress } = useExportStatus();
  const warning = useExportWarning();
  const description = warning ?? (running ? status : file ? `${status} · ${file}` : status);
  return <button type="button" className={`btn-quiet simple-export${warning ? " needs-you" : ""}`} aria-haspopup="dialog"
    title={description} aria-description={description} onClick={onOpen}>
    Export{warning && <span className="menu-dot" role="img" aria-label={warning} />}
    {running && <ProgressLine progress={progress} />}
  </button>;
}
