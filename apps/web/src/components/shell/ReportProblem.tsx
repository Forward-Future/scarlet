/**
 * Report a problem: the editor says what went wrong, Scarlet saves its logs as a .zip in Downloads and opens a GitHub
 * issue with the details filled in, for the editor to check, attach the .zip to and post.
 * Opened from Help → Report a Problem…, Settings → Advanced, the screen a crash leaves, and the startup problem screen.
 */
import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { desktop, isDesktop, type ProblemReport } from "../../lib/desktop";
import { errorMessage } from "../../lib/client";
import { fileBaseName } from "../../lib/format";
import { problemIssueUrl } from "../../lib/problemReport";
import { InlineError, Modal, SectionTitle, Spinner } from "../ui/primitives";

/** The report form opened from anywhere in the window (the Help menu, Settings). */
export const useProblemReport = create<{ open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

type Phase = { phase: "writing" } | { phase: "saving" } | { phase: "ready"; report: ProblemReport; url: string } | { phase: "failed"; error: string };

export function ReportProblemDialog({ open, onClose, context }: { open: boolean; onClose(): void; context?: string }) {
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
  const saving = state.phase === "saving";
  const close = () => { if (!saving) onClose(); };
  const fail = (e: unknown) => setState({ phase: "failed", error: errorMessage(e) });

  const send = async () => {
    setState({ phase: "saving" });
    try {
      const report = await desktop.reportProblem(words);
      const url = problemIssueUrl(report, words, context);
      setState({ phase: "ready", report, url });
      await desktop.revealPath(report.path).catch(() => undefined);
      await desktop.openUrl(url);
    } catch (e) {
      fail(e);
    }
  };

  if (state.phase === "ready") {
    const file = fileBaseName(state.report.path);
    return (
      <Modal open={open} onClose={close} title="Almost done" width={460} footer={<>
        <button className="btn-ghost" onClick={() => void desktop.revealPath(state.report.path).catch(fail)}>Show file</button>
        <button className="btn-ghost" onClick={() => void desktop.openUrl(state.url).catch(fail)}>Open GitHub again</button>
        <button className="btn-primary" onClick={close}>Done</button>
      </>}>
        <ol className="list-decimal pl-5 space-y-2 text-[13px]" role="status">
          <li>Your browser opened a report on GitHub with the details filled in.</li>
          <li>Drag <span className="text-fg font-medium" title={state.report.path}>{file}</span> from the folder that opened into the report.</li>
          <li>Check it, then press <span className="text-fg">Create</span>.</li>
        </ol>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title="Report a problem" width={460} footer={<>
      <button className="btn-ghost" onClick={close} disabled={saving}>Cancel</button>
      <button className="btn-primary" onClick={() => void send()} disabled={saving}>
        {saving && <Spinner className="size-3" />}
        {saving ? "Preparing…" : "Send report…"}
      </button>
    </>}>
      <label className="label" htmlFor={fieldId}>What happened?</label>
      <textarea id={fieldId} data-log-private className="field min-h-[110px] resize-y" value={words} disabled={saving}
        placeholder="What were you doing, and what went wrong?" onChange={(e) => setWords(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !saving) { e.preventDefault(); void send(); } }} />
      <p className="text-dim text-[12px] mt-2">
        Scarlet adds its logs and system details so we can see what went wrong. No videos, projects, transcripts or sign-ins.
        The report opens on GitHub, where you can check it before posting.
      </p>
      {state.phase === "failed" && <InlineError><span data-log-private>Couldn’t prepare the report. {state.error}</span></InlineError>}
    </Modal>
  );
}

/** The form for the whole window, opened by the Help menu or `useProblemReport().show()`. */
export function ReportProblemHost() {
  const open = useProblemReport((s) => s.open);
  const hide = useProblemReport((s) => s.hide);
  useEffect(() => {
    if (!isDesktop()) return;
    const listening = desktop.onReportProblem(() => useProblemReport.getState().show());
    return () => { void listening.then((off) => off()).catch(() => undefined); };
  }, []);
  return <ReportProblemDialog open={open} onClose={hide} />;
}

/** Settings → Advanced → Report a problem. */
export function ReportProblemCard() {
  const show = useProblemReport((s) => s.show);
  if (!isDesktop()) return null;
  return (
    <section className="card p-5" aria-label="Report a problem">
      <SectionTitle>Report a problem</SectionTitle>
      <p className="text-[13px] text-muted mb-4">Tell us what went wrong. Scarlet adds its logs so we can see what happened.</p>
      <button className="btn-primary" onClick={show}>Report a problem…</button>
    </section>
  );
}
