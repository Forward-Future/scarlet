import { useState } from "react";
import { desktop, isDesktop } from "../../lib/desktop";
import { exportLogsAndReport, openProblemReport } from "../../lib/reportProblem";

export function StartupRecovery({ title, detail, showLogs = false }: { title: string; detail: string; showLogs?: boolean }) {
  const [feedback, setFeedback] = useState("");
  const [reporting, setReporting] = useState(false);

  async function openLogs() {
    try {
      const { logDir } = await desktop.info();
      await desktop.openPath(logDir);
      setFeedback("");
    } catch (error) {
      setFeedback(`Couldn’t open logs. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(`${title}\n${detail}`);
      setFeedback("Diagnostics copied.");
    } catch {
      setFeedback("Select the error message above and copy it manually.");
    }
  }

  async function reportProblem() {
    setReporting(true);
    setFeedback("");
    try {
      if (showLogs && isDesktop()) {
        const result = await exportLogsAndReport({ summary: title, detail });
        if (result) setFeedback("Saved log zip and opened the report page. Drag the zip into the issue.");
      } else {
        await openProblemReport({ summary: title, detail });
      }
    } catch (error) {
      setFeedback(`Couldn’t open the report page. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setReporting(false);
    }
  }

  return (
    <main className="h-full grid place-items-center p-6">
      <section className="max-w-lg space-y-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p role="status" className="text-muted whitespace-pre-wrap break-words select-text">{detail}</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={reporting} onClick={() => void reportProblem()}>
            {reporting ? "Preparing…" : "Report a problem"}
          </button>
          {showLogs && <button className="btn-ghost" onClick={openLogs}>Open logs</button>}
          <button className="btn-ghost" onClick={copyDiagnostics}>Copy diagnostics</button>
        </div>
        {feedback && <p role="status" className="text-muted">{feedback}</p>}
      </section>
    </main>
  );
}
