import { useState } from "react";
import { desktop } from "../../lib/desktop";
import { ReportProblemDialog } from "./ReportProblem";

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

  return (
    <main className="h-full grid place-items-center p-6">
      <section className="max-w-lg space-y-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p role="status" className="text-muted whitespace-pre-wrap break-words select-text">{detail}</p>
        <div className="flex flex-wrap gap-2">
          {showLogs && <button className="btn-ghost" onClick={openLogs}>Open logs</button>}
          <button className="btn-ghost" onClick={copyDiagnostics}>Copy diagnostics</button>
          <button className="btn-ghost" onClick={() => setReporting(true)}>Report this problem</button>
        </div>
        {feedback && <p role="status" className="text-muted">{feedback}</p>}
      </section>
      <ReportProblemDialog open={reporting} onClose={() => setReporting(false)} context={`${title}\n${detail}`} />
    </main>
  );
}
