/**
 * Report a problem. Beside an error, Report sends in one press (`ReportLink`); this form is for adding the editor's
 * words to that report afterwards, and for a report from the Help menu or Settings, where no error is on screen and
 * their words are the report. Sent from Scarlet at once to the Scarlet team with Scarlet's cleaned logs. When it can't
 * be sent, it can be saved as a file instead.
 */
import { useEffect, useId, useState } from "react";
import { desktop, isDesktop } from "../../lib/desktop";
import { errorMessage } from "../../lib/client";
import { fileBaseName } from "../../lib/format";
import { reportWords, useProblemReport, type SentReport } from "../../lib/problemReportStore";
import { InlineError, Modal, Spinner } from "../ui/primitives";

export { useProblemReport };
export { ReportLink } from "./ReportLink";

type Phase =
  | { phase: "writing" }
  | { phase: "sending" }
  | { phase: "sent"; reference: string }
  | { phase: "failed"; error: string }
  | { phase: "saving"; error: string }
  | { phase: "saved"; path: string };

export function ReportProblemDialog({ open, onClose, follows }: { open: boolean; onClose(): void; follows?: SentReport }) {
  const [words, setWords] = useState("");
  const [state, setState] = useState<Phase>({ phase: "writing" });
  const fieldId = useId();
  // Closed and opened again, the form starts clean.
  useEffect(() => {
    if (!open) {
      setWords("");
      setState({ phase: "writing" });
    }
  }, [open]);
  const busy = state.phase === "sending" || state.phase === "saving";
  const close = () => { if (!busy) onClose(); };
  const empty = !words.trim();

  const send = async () => {
    setState({ phase: "sending" });
    try {
      if (follows) {
        await desktop.sendProblemDetails({ reportId: follows.id, description: words });
        useProblemReport.getState().markDetailed(follows.id);
        onClose();
        return;
      }
      const { reference } = await desktop.sendProblemReport(reportWords(words));
      setState({ phase: "sent", reference });
    } catch (e) {
      setState({ phase: "failed", error: errorMessage(e) });
    }
  };
  const save = async (error: string) => {
    setState({ phase: "saving", error });
    try {
      const path = await desktop.saveProblemReport(reportWords(words, follows?.about));
      setState({ phase: "saved", path });
      await desktop.revealPath(path).catch(() => undefined);
    } catch (e) {
      setState({ phase: "failed", error: errorMessage(e) });
    }
  };

  if (state.phase === "sent") return (
    <Modal open={open} onClose={close} title="Report sent" width={460} footer={<button className="btn-primary" onClick={close}>Done</button>}>
      <p className="text-[13px]" role="status">Thanks. The Scarlet team has your report and what Scarlet logged.</p>
      <p className="text-dim text-[12px] mt-2">Reference <span className="text-muted font-mono select-text">{state.reference}</span></p>
    </Modal>
  );

  if (state.phase === "saved") return (
    <Modal open={open} onClose={close} title="Report saved" width={460} footer={<>
      <button className="btn-ghost" onClick={() => void desktop.revealPath(state.path).catch(() => undefined)}>Show file</button>
      <button className="btn-primary" onClick={close}>Done</button>
    </>}>
      <p className="text-[13px]" role="status">
        Saved <span className="text-fg" title={state.path}>{fileBaseName(state.path)}</span>. If the Scarlet team asks for it, send them this file.
      </p>
    </Modal>
  );

  const failed = state.phase === "failed" || state.phase === "saving" ? state.error : undefined;
  return (
    <Modal open={open} onClose={close} title={follows ? "Add details" : "Report a problem"} width={460} footer={<>
      <button className="btn-ghost" onClick={close} disabled={busy}>Cancel</button>
      {failed !== undefined && !follows && <button className="btn-ghost" onClick={() => void save(failed)} disabled={busy}>
        {state.phase === "saving" && <Spinner className="size-3" />}Save as file
      </button>}
      <button className="btn-primary" onClick={() => void send()} disabled={busy || (!!follows && empty)}>
        {state.phase === "sending" && <Spinner className="size-3" />}
        {state.phase === "sending" ? "Sending…" : failed !== undefined ? "Try again" : follows ? "Send details" : "Send report"}
      </button>
    </>}>
      {follows && <div className="mb-3 rounded-lg border border-line px-3 py-2">
        <div className="label mb-0.5">Report {follows.reference} · sent</div>
        {follows.about && <p className="text-[12.5px] text-muted break-words line-clamp-3 select-text" title={follows.about} data-log-private>{follows.about}</p>}
      </div>}
      <label className="label" htmlFor={fieldId}>{follows ? "What were you doing when it happened?" : "What happened?"}</label>
      <textarea id={fieldId} data-log-private className="field min-h-[96px] resize-y" value={words} disabled={busy}
        placeholder={follows ? "Anything that helps the team see it happen" : "What were you doing, and what went wrong?"}
        onChange={(e) => setWords(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy && !(follows && empty)) { e.preventDefault(); void send(); } }} />
      {!follows && <p className="text-dim text-[12px] mt-2">
        Sends what you write and Scarlet’s logs to the Scarlet team. No videos, projects, transcripts or sign-ins.
      </p>}
      {failed !== undefined && <InlineError><span data-log-private>Couldn’t send{follows ? " your note" : " the report"}. {failed}</span></InlineError>}
    </Modal>
  );
}

/** The form for the whole window: the Help menu, Settings, and Add details after a one-press report. */
export function ReportProblemHost() {
  const open = useProblemReport((s) => s.open);
  const follows = useProblemReport((s) => s.follows);
  const hide = useProblemReport((s) => s.hide);
  useEffect(() => {
    if (!isDesktop()) return;
    const listening = desktop.onReportProblem(() => useProblemReport.getState().show());
    return () => { void listening.then((off) => off()).catch(() => undefined); };
  }, []);
  return <ReportProblemDialog open={open} onClose={hide} follows={follows} />;
}

/** Settings › About → Report a problem. */
export function ReportProblemCard() {
  const show = useProblemReport((s) => s.show);
  if (!isDesktop()) return null;
  return (
    <section className="card about-telemetry" aria-labelledby="report-problem-heading">
      <h2 id="report-problem-heading">Report a problem</h2>
      <p>Tell the Scarlet team what went wrong. Scarlet sends its logs with it: no videos, projects, transcripts or sign-ins.</p>
      <div className="mt-3"><button className="btn-primary" onClick={() => show()}>Report a problem…</button></div>
    </section>
  );
}

