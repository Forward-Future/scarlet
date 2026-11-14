import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { callNumbers, taskNeedsTranscripts, type SpeakerProgress, type Task, type TaskEvent, type UsageTotals } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { tokenBreakdown, tokenLabel } from "../../lib/format";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { runProgress } from "../../lib/runProgress";
import { runNow } from "../../lib/runNow";
import { runningTranscription, transcriptionProgressLabel, transcriptsProgress } from "../../lib/transcriptionProgress";
import { runAim, runIsActive, runItems, runLines, runSummary, type RunItem, type RunLine } from "../../lib/taskRun";
import { pendingMediaWaits, TRANSCRIPT_WAIT } from "../../lib/taskActivity";

/** Tokens the agent used on this request, with the full breakdown on hover. Shown only when turned on in Settings → Usage. */
function Tokens({ usage }: { usage?: UsageTotals }) {
  if (!usage?.totalTokens) return null;
  return <span className="run-dim run-tokens" title={tokenBreakdown(usage)}>{tokenLabel(usage.totalTokens)}</span>;
}

const voicePhase: Record<SpeakerProgress["phase"], string> = {
  audio: "Preparing audio", models: "Finding voices", segmenting: "Finding voices", identifying: "Finding voices",
  grouping: "Finding voices", matching: "Matching voices",
};

/**
 * Scarlet's words in the chat: two lines at most. A longer reply opens in full on a click and folds again on the
 * next, as a card's note does: there is no button, only the pointer changes over it, and the reply ends in an ellipsis
 * while it's folded. However much Scarlet writes, a request stays a few lines tall.
 */
export function Said({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);
  const opens = clipped || open;
  return <p ref={ref} className={`${className ? `${className} ` : ""}said${open ? " is-open" : clipped ? " is-clipped" : ""}`}
    title={clipped && !open ? "Show all of it" : undefined} aria-expanded={opens ? open : undefined} onClick={opens ? () => setOpen(!open) : undefined}>{text}</p>;
}

/**
 * One request in the chat, under its heading. A long pass and a one-line revision use the same rows:
 *
 * - While it works, for as long as it works: first the one sentence Scarlet said before it began, on what the whole
 *   request will come to. It is written once and stays as it is; a run that said none has none. Then one line, with a
 *   turning ring before it, that says what Scarlet is doing this moment (`runNow`): the latest call it made, in plain
 *   words, or its own latest sentence. The line changes every few seconds and nothing else is there: no stages, no
 *   plan, no list of what it did, and no percent but one: while the recordings are transcribed it says how far along
 *   they are. Its words shimmer. With no heading above it, Stop ends the line.
 * - When Scarlet asks something, or a request waits its turn: one row saying so, with its one action. A block whose
 *   heading already says where it stands (`banded`) leaves a question to the heading: its dot, the question and Answer.
 *   With no heading, the row opens the steps Scarlet took before it asked.
 * - When a run stops early: the row that says what it saved, with its one action.
 * - `say`: Scarlet's words, when it has any for the editor.
 * - `result`: what the request made. A run with nothing listed gets one row of its own: what it amounts to.
 *   A finished request has no time and no steps: it is its heading and what it made.
 */
interface RunBundleProps {
  task: Task;
  events: readonly TaskEvent[];
  changes: readonly Change[];
  /** The number a call of the waiting pass goes by in the window, when the window has numbered it. */
  callNumber?(changeId: string, cutIndex: number): number | undefined;
  finalChange?: Change;
  /** Scarlet's words for the editor: a reply, a question, or why it stopped. */
  say?: ReactNode;
  /** Those words already say what the request came to, so a run that has ended, finished or stopped early, with nothing to list or open adds no row that says it again, cut short. */
  told?: boolean;
  /** The rows that list what the request made, given what goes at the end of the first: the tokens it used, when those show. */
  result?(aside: ReactNode): ReactNode;
  /** What a request about one cut or edit did there, in place of a count of everything it saved. */
  summary?: string;
  /** The request sits under the row of the cut it is about, and that row is what it saved, with Scarlet's note on it. */
  listedAbove?: boolean;
  /** The block's heading says how the run ended ("Stopped"), so its rows don't say it again. */
  banded?: boolean;
  /** Stop is in the heading above these rows, at its right, so no row here carries it. */
  stopAbove?: boolean;
  /** Show what a finished run made, from its own row; or put it away again while it's `showing`. */
  onOpen?(): void;
  showing?: boolean;
  /** Pick a stopped or failed run up again. */
  recovery?: { label: string; run(): void };
  onStop?(): void;
  /** Resume a run that ended without its transcripts, now that they're ready. */
  onResume?(): void;
  /** Resume it once its transcripts are ready, or stop waiting to. */
  onWaitForTranscripts?(on: boolean): void;
}

export function RunBundle(props: RunBundleProps) {
  if (props.task.state === "running" || props.task.state === "claimed") return <WorkingRun {...props} />;
  return runIsActive(props.task) ? <WaitingRun {...props} /> : <FinishedRun {...props} />;
}

function useRunUsage(taskId: string) {
  const show = useUiStore(s => s.showRunTokens);
  return useProjectStore(s => show ? s.current?.taskUsage?.[taskId] : undefined);
}

function WorkingRun({ task, events, changes, callNumber, say, result, stopAbove, onStop }: RunBundleProps) {
  const aim = useMemo(() => runAim(events), [events]);
  const progress = useMemo(() => runProgress(events), [events]);
  const voices = useProjectStore(s => s.current?.speakerProgress);
  const voice = progress.read && !progress.read.seconds ? progress.recordings?.map(id => voices?.[id]).find(Boolean) : undefined;
  // A call goes by the number the window shows for it, which it keeps; one the window hasn't numbered, by its place among the asks.
  const numberOf = useRef(callNumber);
  numberOf.current = callNumber;
  const doing = useMemo(() => runNow(events, aim?.note, (changeId, index) => {
    const pass = changes.find(c => c.id === changeId);
    return numberOf.current?.(String(changeId), Number(index)) ?? (pass && callNumbers(pass, 0, false).get(index));
  }), [events, aim, changes]);
  // While the run waits on its recordings' transcripts, the line says how far along they are: the one figure there.
  const tasks = useProjectStore(s => s.current?.tasks);
  const media = useProjectStore(s => s.current?.media);
  const transcripts = useMemo(() => {
    if (doing !== TRANSCRIPT_WAIT) return;
    const ids = [...pendingMediaWaits(events)].flatMap(key => key.startsWith("transcript/") ? [key.slice("transcript/".length)] : []);
    const progress = transcriptsProgress(tasks ?? [], media ?? [], ids);
    return progress && progress.stage !== "queued" ? transcriptionProgressLabel(progress) : undefined;
  }, [doing, events, tasks, media]);
  const words = transcripts ? `Transcribing the recordings · ${transcripts}`
    : doing ?? (voice ? voicePhase[voice.phase] : task.state === "claimed" ? "Getting started" : WORKING);
  return <div className="req" data-state="working" aria-label="Scarlet’s work" aria-busy>
    {aim && <div className="req-said req-lead"><Said className="req-say" text={aim.text} /></div>}
    <div className="req-row req-now">
      <StepMark state="working" />
      {/* The words shimmer while Scarlet works. A narrow chat shortens them to two lines; hovering says them whole. */}
      <span role="status" title={words} className="req-now-text working-text">{words}</span>
      {!stopAbove && onStop && <span className="req-right"><button type="button" className="simple-link run-stop" onClick={onStop}>Stop</button></span>}
    </div>
    {say}
    {result?.(undefined)}
  </div>;
}

function WaitingRun({ task, events, changes, say, result, banded, onStop }: RunBundleProps) {
  const usage = useRunUsage(task.id);
  const asking = task.state === "waiting_for_user";
  const waiting = task.state === "queued";
  const [open, setOpen] = useState(false);
  const shown = useMemo(() => {
    if (!asking || banded) return [];
    const aim = runAim(events);
    return shownItems(runItems(task, events, changes).filter(item => !(item.kind === "note" && item.text === aim?.note)));
  }, [asking, banded, task, events, changes]);
  const lines = useMemo(() => open ? tidy(runLines(task, events, shown, Date.now())) : [], [open, task, events, shown]);
  // A request in line again says Queued, the word its cut's card and the tray use.
  const label = waiting ? "Queued" : "Needs your answer";
  // A question's steps open from its line. A question under a heading has no such line: the heading's dot, the question and Answer say it.
  const line = !(banded && asking);
  const opens = asking && shown.length > 0;
  return <div className="req" data-state={asking ? "asking" : "working"} aria-label="Scarlet’s work" aria-busy={!asking}>
    {line && <div className="req-row req-status">
      <button type="button" className="req-toggle" aria-expanded={opens ? open : undefined} disabled={!opens}
        title={opens ? open ? "Hide the details" : "Show the details" : undefined} onClick={() => setOpen(!open)}>
        {asking && <span className="req-dot" aria-hidden />}
        <span role="status" title={label} className={asking ? "req-ask" : undefined}>{label}</span>
      </button>
      <span className="req-right">
        {asking && <Tokens usage={usage} />}
        {onStop && <button type="button" className="simple-link run-stop" onClick={onStop}>Stop</button>}
      </span>
    </div>}
    {line && lines.length > 0 && <RunList lines={lines} />}
    {say}
    {!line && asking && !!usage?.totalTokens && <div className="req-row"><span className="req-right"><Tokens usage={usage} /></span></div>}
    {result?.(undefined)}
  </div>;
}

function FinishedRun({ task, finalChange, say, told, result, recovery, summary, listedAbove, showing, banded, onOpen, onResume, onWaitForTranscripts }: RunBundleProps) {
  const usage = useRunUsage(task.id);
  // Finished. A run that ended without the transcripts it waited for says so, since what it saved is only part of the request.
  const paused = taskNeedsTranscripts(task);
  const stopped = task.state === "cancelled";
  const failed = task.state === "failed";
  const state = runEnded(task);
  const aside = <Tokens usage={usage} />;
  const rows = result?.(aside);
  const action = !paused && recovery && <button type="button" className="simple-link req-recover" onClick={recovery.run}>{recovery.label}</button>;
  const made = summary ?? (state ? stoppedSummary(task, finalChange) : runSummary(task, finalChange));
  // Scarlet's note on one cut reads on up to two lines; a count stays on one.
  const madeClass = `req-summary${state ? "" : " run-summary"}${summary ? " is-note" : ""}`;
  // A run that stopped with nothing saved has nothing to show on the timeline: "Nothing saved" is words, not a way in.
  // Nor has one whose version couldn't be prepared: Scarlet's words say so, and no row names the edit under them.
  // Nor has a request that changed nothing and said why: its row would be the first words of that reply, said again.
  const opens = ((state || (told && !summary)) && !finalChange) || finalChange?.state === "failed" ? undefined : onOpen;
  // A run paused for its transcripts that saved nothing has its row about the transcripts, and none that says "Nothing
  // saved". The tokens it used, when those show, end that row: they don't bring the second one back.
  const waits = paused && !finalChange && !summary && !rows;
  // Under the row of the cut it saved, that row is what the run made, in Scarlet's note, and opens it. A row here would
  // say the note a second time, right under it (2026-11-10). It stays only for the tokens, when those show.
  const madeAbove = !!listedAbove && !!finalChange && finalChange.state !== "failed";
  // The row that says what the run saved is there, and it opens nothing: the action sits on it, after its words.
  const actsOnLine = !!state && !!banded && !rows && !opens && !madeAbove && !(told && !usage?.totalTokens);
  return <div className="req" data-state={paused ? "paused" : stopped ? "stopped" : failed ? "failed" : "done"}>
    {state && !banded && <div className="req-row req-status">
      <span className={`req-state run-summary${failed ? " is-bad" : ""}`}>{state}</span>
      <span className="req-right">{action}</span>
    </div>}
    {paused && <TranscriptWait task={task} onResume={onResume} onWait={onWaitForTranscripts} aside={waits && usage?.totalTokens ? aside : undefined} />}
    {say}
    {rows ?? (!(waits || (((told && !opens) || madeAbove) && !usage?.totalTokens)) && <div className="req-row req-result">
      {madeAbove ? null : opens ? <button type="button" className={madeClass} aria-current={showing || undefined}
          title={summary ? `${made}\nShow on the timeline` : "Show on the timeline"} onClick={opens}><span>{made}</span></button>
        : <span className={madeClass} title={summary}><span>{made}</span></span>}
      {/* What a stopped run saved is one line, and its one action follows on it. */}
      {actsOnLine && action}
      <span className="req-right">{aside}</span>
    </div>)}
    {/* Under a heading that says "Stopped", the one action follows what the run left. */}
    {state && banded && action && !actsOnLine && <div className="req-row req-act">{action}</div>}
  </div>;
}

/** What the line says when nothing names the work of the moment. */
const WORKING = "Working on your edit";

/** How a run that didn't finish ended, in the words its block says: paused for its transcripts, stopped, or failed. */
export function runEnded(task: Task) {
  return taskNeedsTranscripts(task) ? `Paused · needs ${task.needsTranscripts!.length > 1 ? "transcripts" : "transcript"}`
    : task.state === "cancelled" ? "Stopped" : task.state === "failed" ? "Couldn’t finish" : undefined;
}

/** What a run that stopped early still made, if anything. */
function stoppedSummary(task: Task, change?: Change) {
  return change ? runSummary({ ...task, state: "done" }, change) : "Nothing saved";
}

/** The steps worth a row: a look at the project and a scan say nothing the stages don't. */
function shownItems(items: readonly RunItem[]): RunItem[] {
  return items.filter(item => item.kind !== "step"
    || !(item.verb === "Scanned" || (item.verb === "Read" && item.detail === "the project") || item.pending));
}

/** One row for a step done more than once. */
function tidy(lines: RunLine[]): RunLine[] {
  const seen = new Set<string>();
  return lines.filter(line => {
    if (line.kind !== "step" || line.live) return true;
    if (seen.has(line.text)) return false;
    seen.add(line.text);
    return true;
  });
}

/**
 * Under a run that ended without its transcripts: how far along they are, as a percent with no guess at the time left,
 * and one action. Finish when ready resumes the run by itself once they're saved; with them ready already, Finish edit
 * resumes it now. While no transcript is being made there is nothing to wait for, so the action is the one that gets it
 * going, in the words its Media row uses: Retry after one that stopped, Transcribe where none was made. The run then
 * finishes when the transcript is ready. Where Scarlet can't start one, the press says why at the end of the request's
 * block, as any press that failed does. `aside` ends the row: the tokens the run used.
 */
function TranscriptWait({ task, onResume, onWait, aside }: { task: Task; onResume?(): void; onWait?(on: boolean): void; aside?: ReactNode }) {
  const tasks = useProjectStore(s => s.current?.tasks);
  const media = useProjectStore(s => s.current?.media);
  const pending = (task.needsTranscripts ?? []).filter(id => !media?.find(m => m.id === id)?.transcriptId);
  // Named for what the run waits on, so two that are both ready don't read "Transcript ready".
  const noun = (pending.length || (task.needsTranscripts?.length ?? 0)) > 1 ? "Transcripts" : "Transcript";
  const making = pending.some(id => runningTranscription(tasks ?? [], id));
  // The figure is of every recording the run waited for. Counted over the ones still pending, it started again each
  // time a transcript was saved.
  const progress = transcriptionProgressLabel(transcriptsProgress(tasks ?? [], media ?? [], task.needsTranscripts ?? []));
  let status: string, action: { label: string; run(): void } | undefined;
  if (!pending.length) {
    status = `${noun} ready`;
    action = onResume && { label: "Finish edit", run: onResume };
  } else if (task.continueWhenReady) {
    status = `Finishes when ready${progress ? ` · ${progress}` : ""}`;
    action = onWait && { label: "Don’t wait", run: () => onWait(false) };
  } else if (making) {
    status = `${noun} ${progress ?? "in progress"}`;
    action = onWait && { label: "Finish when ready", run: () => onWait(true) };
  } else {
    // A transcription that was started and isn't running ended without its transcript. Asked to finish once the
    // transcript is ready, the engine starts one that isn't being made.
    const stopped = pending.some(id => (tasks ?? []).some(t => t.kind === "transcribe" && t.context.mediaId === id));
    status = stopped ? `${noun} stopped` : `No ${noun.toLowerCase()}`;
    action = onWait && { label: stopped ? "Retry" : "Transcribe", run: () => onWait(true) };
  }
  return <div className="req-row run-wait">
    <span className="run-dim">{status}</span>
    {action && <button type="button" className="simple-link" onClick={action.run}>{action.label}</button>}
    {aside && <span className="req-right">{aside}</span>}
  </div>;
}

/** Where a step stands, as the mark before it: a tick once done, a turning ring while under way. */
function StepMark({ state }: { state: "done" | "working" }) {
  return <span className="req-mark" data-state={state} aria-hidden>
    {state === "done" && <svg viewBox="0 0 16 16"><path d="m4 8.4 2.6 2.6L12 5.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
  </span>;
}

/** The steps so far: what Scarlet did, each with its mark and no time beside it. Its own updates read in full. */
function RunList({ lines }: { lines: RunLine[] }) {
  return <div className="req-steps run-list">
    {lines.map((line, i) => <div key={i} className={`req-step run-row is-${line.kind}${line.live ? " run-live" : ""}`}>
      {line.kind === "step" ? <StepMark state={line.live ? "working" : "done"} /> : <span className="req-mark-gap" aria-hidden />}
      <span className="simple-row-text">{line.text}</span>
    </div>)}
  </div>;
}
