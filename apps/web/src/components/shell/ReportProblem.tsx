/**
 * Report a problem: from where the editor sees it go wrong (a Report beside the error, the screen a crash leaves), or
 * from the Help menu or Settings. They say what happened, and Scarlet sends it to the Scarlet team at once with the
 * error on screen and its cleaned logs. When it can't be sent, it can be saved as a file instead.
 */
import { useEffect, useId, useState } from "react";
import { desktop, isDesktop } from "../../lib/desktop";
import { errorMessage } from "../../lib/client";
import { logPath } from "../../lib/appLog";
import { fileBaseName } from "../../lib/format";
import { recentOnScreenErrors, useProblemReport } from "../../lib/problemReportStore";
import { InlineError, Modal, SectionTitle, Spinner } from "../ui/primitives";

export { useProblemReport };

type Phase =
  | { phase: "writing" }
  | { phase: "sending" }
  | { phase: "sent"; reference: string }
  | { phase: "failed"; error: string }
  | { phase: "saving"; error: string }
  | { phase: "saved"; path: string };

export function ReportProblemDialog({ open, onClose, about }: { open: boolean; onClose(): void; about?: string }) {
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
  const report = () => ({ description: words, about, page: logPath(location.href), onScreen: recentOnScreenErrors() });

  const send = async () => {
    setState({ phase: "sending" });
    try {
      const { reference } = await desktop.sendProblemReport(report());
      setState({ phase: "sent", reference });
    } catch (e) {
      setState({ phase: "failed", error: errorMessage(e) });
    }
  };
  const save = async (error: string) => {
    setState({ phase: "saving", error });
    try {
      const path = await desktop.saveProblemReport(report());
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
    <Modal open={open} onClose={close} title="Report a problem" width={460} footer={<>
      <button className="btn-ghost" onClick={close} disabled={busy}>Cancel</button>
      {failed !== undefined && <button className="btn-ghost" onClick={() => void save(failed)} disabled={busy}>
        {state.phase === "saving" && <Spinner className="size-3" />}Save as file
      </button>}
      <button className="btn-primary" onClick={() => void send()} disabled={busy}>
        {state.phase === "sending" && <Spinner className="size-3" />}
        {state.phase === "sending" ? "Sending…" : failed !== undefined ? "Try again" : "Send report"}
      </button>
    </>}>
      {about && <div className="mb-3 rounded-lg border border-line px-3 py-2">
        <div className="label mb-0.5">About</div>
        <p className="text-[12.5px] text-muted break-words line-clamp-3 select-text" title={about} data-log-private>{about}</p>
      </div>}
      <label className="label" htmlFor={fieldId}>What happened?</label>
      <textarea id={fieldId} data-log-private className="field min-h-[96px] resize-y" value={words} disabled={busy}
        placeholder={about ? "What were you doing when this happened? (optional)" : "What were you doing, and what went wrong?"}
        onChange={(e) => setWords(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) { e.preventDefault(); void send(); } }} />
      <p className="text-dim text-[12px] mt-2">
        Sends what you write{about ? ", the error above" : ""} and Scarlet’s logs to the Scarlet team. No videos, projects, transcripts or sign-ins.
      </p>
      {failed !== undefined && <InlineError><span data-log-private>Couldn’t send the report. {failed}</span></InlineError>}
    </Modal>
  );
}

/** The form for the whole window, opened by a Report beside an error, the Help menu or `useProblemReport().show()`. */
export function ReportProblemHost() {
  const open = useProblemReport((s) => s.open);
  const about = useProblemReport((s) => s.about);
  const hide = useProblemReport((s) => s.hide);
  useEffect(() => {
    if (!isDesktop()) return;
    const listening = desktop.onReportProblem(() => useProblemReport.getState().show());
    return () => { void listening.then((off) => off()).catch(() => undefined); };
  }, []);
  return <ReportProblemDialog open={open} onClose={hide} about={about} />;
}

/** A quiet Report beside an error, where the editor sees it. It opens the form about that error. */
export function ReportLink({ about, className = "btn-quiet", label = "Report" }: { about: string; className?: string; label?: string }) {
  if (!isDesktop()) return null;
  return <button type="button" className={className} data-log-control="report-problem" title="Tell the Scarlet team about this"
    onClick={(e) => { e.stopPropagation(); useProblemReport.getState().show(about); }}>{label}</button>;
}

/** Settings → Advanced → Report a problem. */
export function ReportProblemCard() {
  const show = useProblemReport((s) => s.show);
  if (!isDesktop()) return null;
  return (
    <section className="card p-5" aria-label="Report a problem">
      <SectionTitle>Report a problem</SectionTitle>
      <p className="text-[13px] text-muted mb-4">Tell the Scarlet team what went wrong. Scarlet sends its logs with it.</p>
      <button className="btn-primary" onClick={() => show()}>Report a problem…</button>
    </section>
  );
}
