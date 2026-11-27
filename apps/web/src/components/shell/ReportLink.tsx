/**
 * Report, beside an error where the editor sees it. One press sends the report to the Scarlet team at once: the error,
 * the page, what the window showed lately and Scarlet's cleaned logs. It then says so where it was, with Add details
 * for the editor's own words. One that couldn't be sent says why, with Try again and Save as file.
 */
import { useState } from "react";
import { desktop, isDesktop } from "../../lib/desktop";
import { errorMessage } from "../../lib/client";
import { fileBaseName } from "../../lib/format";
import { reportWords, useProblemReport } from "../../lib/problemReportStore";

type Phase =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; id: string; reference: string }
  | { phase: "failed"; error: string }
  | { phase: "saving" }
  | { phase: "saved"; path: string };

export function ReportLink({ about, className = "btn-quiet", label = "Report" }: { about: string; className?: string; label?: string }) {
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const detailed = useProblemReport(s => state.phase === "sent" && s.detailed.includes(state.id));
  if (!isDesktop()) return null;

  const send = async () => {
    setState({ phase: "sending" });
    try {
      const { id, reference } = await desktop.sendProblemReport(reportWords("", about));
      setState({ phase: "sent", id, reference });
    } catch (e) {
      setState({ phase: "failed", error: errorMessage(e) });
    }
  };
  const save = async () => {
    setState({ phase: "saving" });
    try {
      const path = await desktop.saveProblemReport(reportWords("", about));
      setState({ phase: "saved", path });
      await desktop.revealPath(path).catch(() => undefined);
    } catch (e) {
      setState({ phase: "failed", error: errorMessage(e) });
    }
  };

  switch (state.phase) {
    case "idle":
      return <button type="button" className={className} data-log-control="report-problem" title="Send a report of this to the Scarlet team"
        onClick={(e) => { e.stopPropagation(); void send(); }}>{label}</button>;
    case "sending":
    case "saving":
      return <span className="report-status" role="status">{state.phase === "sending" ? "Sending report…" : "Saving…"}</span>;
    case "sent":
      return <span className="report-status" role="status" title={`Reference ${state.reference}`}>
        {detailed ? "Report sent with your note" : "Report sent"}
        {!detailed && <> · <button type="button" data-log-control="report-details"
          onClick={(e) => { e.stopPropagation(); useProblemReport.getState().addDetails({ id: state.id, reference: state.reference, about }); }}>Add details</button></>}
      </span>;
    case "failed":
      return <span className="report-status is-bad" role="alert">
        <span title={state.error} data-log-private>Couldn’t send</span>
        {" · "}<button type="button" onClick={(e) => { e.stopPropagation(); void send(); }}>Try again</button>
        {" · "}<button type="button" onClick={(e) => { e.stopPropagation(); void save(); }}>Save as file</button>
      </span>;
    case "saved":
      return <span className="report-status" role="status" title={state.path}>Saved {fileBaseName(state.path)}</span>;
  }
}
