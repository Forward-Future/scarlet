import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { callNumbers, taskNeedsTranscripts, type SpeakerProgress, type Task, type TaskEvent } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import { useProjectStore } from "../../stores/project";
import { useUiStore } from "../../stores/ui";
import { blurOnPointerClick } from "../../lib/hotkeys";
import { runProgress } from "../../lib/runProgress";
import { runNow, STARTING } from "../../lib/runNow";
import { runningTranscription, transcriptionProgressLabel, transcriptsProgress } from "../../lib/transcriptionProgress";
import { isWorkingTask, PAUSED_HINT, runAim, runIsActive, runItems, runLines, runSummary, type RunItem, type RunLine } from "../../lib/taskRun";
import { toolName, TRANSCRIPT_WAIT } from "../../lib/taskActivity";
import { useClippedExpand } from "../../lib/uiHooks";
import { usePublishWorkingLine } from "../../lib/workingLines";
import { Linked } from "../ui/Linked";
import { Icon } from "../ui/primitives";
import { RequestMetrics, Tokens } from "./RequestMetrics";

export { RequestMetrics };

const voicePhase: Record<SpeakerProgress["phase"], string> = {
  audio: "Preparing audio", models: "Finding voices", segmenting: "Finding voices", identifying: "Finding voices",
  grouping: "Finding voices", matching: "Matching voices",
};

/**
 * Scarlet's words in the chat: two lines at most. A longer reply opens in full on a click and folds again on the
 * next, as a card's note does: there is no button, only the pointer changes over it, and the reply ends in an ellipsis
 * while it's folded. However much Scarlet writes, a request stays a few lines tall.
 */
export function Said({ text, lead, className, fixed, children }: { text: string; lead?: ReactNode; className?: string;
  /** A request's heading: its words stay folded, and a press there is the heading's. Resting on them says them whole. */
  fixed?: boolean; children?: ReactNode }) {
  const { ref, clipped, open, opens, toggle } = useClippedExpand<HTMLParagraphElement>(text);
  if (fixed) return <p ref={ref} className={`${className ? `${className} ` : ""}said`} title={clipped ? text : undefined}>{lead}{children ?? text}</p>;
  // An address in the words is a link that opens in the browser; the rest of the words fold and open as before.
  return <p ref={ref} className={`${className ? `${className} ` : ""}said${open ? " is-open" : clipped ? " is-clipped" : ""}`}
    title={clipped && !open ? "Show all of it" : undefined} aria-expanded={opens ? open : undefined} onClick={opens ? toggle : undefined}>{lead}{children ?? <Linked text={text} />}</p>;
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
 *   heading already says where it stands (`banded`) leaves a question to the heading's dot: the question itself sits on
 *   top of the message box.
 *   With no heading, the row opens the steps Scarlet took before it asked.
 * - When a run stops early: the row that says what it saved, with its one action.
 * - `say`: Scarlet's words, when it has any for the editor.
 * - `result`: what the request made. A run with nothing listed gets one row of its own: what it amounts to.
 *   A finished request is its heading with its final metrics, and what it made.
 */
interface RunBundleProps {
  task: Task;
  events: readonly TaskEvent[];
  /** The history of the attempt Scarlet opened the request in, once the request was picked up again under this one. */
  opening?: readonly TaskEvent[];
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
  /** Under the row of the cut or edit it is about: the row says what it is, so Scarlet's opening sentence isn't shown. */
  under?: boolean;
  banded?: boolean;
  /** The project's editing is paused, so a run in line waits for Continue. */
  paused?: boolean;
  /**
   * What a run in line waits for when that is the editor, in the queue's own words ("Waits for your calls"), and the
   * way to start it without them when there is one. A request picked up again isn't in the queue's tray, so its block
   * says it.
   */
  held?: { words: string; startNow?(): void };
  /** Show what a finished run made, from its own row; or put it away again while it's `showing`. */
  onOpen?(): void;
  showing?: boolean;
  /** Pick a stopped or failed run up again. */
  recovery?: { label: string; run(): void };
  onStop?(): void;
  /** Edit actions for Scarlet's own request, which has no heading. */
  actions?: ReactNode;
  /** Resume a run that ended without its transcripts, now that they're ready. */
  onResume?(): void;
  /** Resume it once its transcripts are ready, or stop waiting to. */
  onWaitForTranscripts?(on: boolean): void;
}

/** What a pass sent back to check the video for repeats is doing, whatever it said on its way in. */
const FINAL_CHECK = "Closing check for repeats";
/** The events of a pass's latest run, once the engine has sent it back to check for repeats; every event otherwise. */
const sinceRerun = (task: Task, events: readonly TaskEvent[]) => {
  const from = task.repeatAudit?.returns ? task.startedAt : undefined;
  return from ? events.filter(e => (e.at ?? "") >= from) : events;
};

export function RunBundle(props: RunBundleProps) {
  if (isWorkingTask(props.task.state)) return <WorkingRun {...props} />;
  return runIsActive(props.task) ? <WaitingRun {...props} /> : <FinishedRun {...props} />;
}

/** The tokens a run used, when those show. A run under a heading has them in the heading, so its rows don't. */
function useRunUsage(taskId: string, shown = true) {
  const show = useUiStore(s => s.showRunTokens) && shown;
  return useProjectStore(s => show ? s.current?.taskUsage?.[taskId] : undefined);
}

function WorkingRun({ task, events: all, opening, changes, callNumber, say, result, onStop, actions, under }: RunBundleProps) {
  // A pass sent back to check the finished cut for repeats runs again as the same request, in a new session. Its line
  // and its first sentence are that session's: what it said an hour ago on the first run isn't what it is doing now.
  const events = useMemo(() => sinceRerun(task, all), [task, all]);
  // That check is named for what it is, above the line that says what it's on this moment.
  const rerun = !!task.repeatAudit?.returns;
  // The sentence is written once: a request picked up after a pause or a restart keeps the one it opened with.
  const aim = useMemo(() => rerun ? { text: FINAL_CHECK, note: "" } : (opening && runAim(opening)) ?? runAim(events), [events, rerun, opening]);
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
    // The figure is of every recording the run has waited for, saved or not. Counted over the ones still pending, it
    // dropped back each time one of several transcripts was saved. One whose transcript couldn't be made is left out.
    const ids = new Set<string>();
    for (const { type, data } of events) {
      if (type !== "log" || data?.kind !== "media_wait" || data.wait !== "transcript" || typeof data.mediaId !== "string") continue;
      if (data.done && data.failed) ids.delete(data.mediaId);
      else ids.add(data.mediaId);
    }
    const progress = transcriptsProgress(tasks ?? [], media ?? [], [...ids]);
    return progress && progress.stage !== "queued" ? transcriptionProgressLabel(progress) : undefined;
  }, [doing, events, tasks, media]);
  // A run cut short, by Scarlet closing or restarting or by a pause, carries on under a new task. Until that attempt
  // makes its first call the line says so: the editor who just reopened Scarlet sees the edit wasn't started over.
  // A model that thinks before that call hasn't made it: "Thinking" doesn't take the words away.
  const pickingUp = !!task.resumeRootId && !rerun && !voice && !events.some(e => e.type === "tool" && toolName(e) !== "task_log");
  const words = transcripts ? `Transcribing the recordings · ${transcripts}`
    : pickingUp ? PICKING_UP
    : doing ?? (voice ? voicePhase[voice.phase] : task.state === "claimed" ? STARTING : WORKING);
  // The timeline's status says the same words, so the editor can tell what Scarlet is on without the chat in view.
  usePublishWorkingLine(task.id, words);
  return <div className="req" data-state="working" aria-label="Scarlet’s work" aria-busy>
    {aim && !under && <div className="req-said req-lead"><Said className="req-say" text={aim.text} /></div>}
    <div className="req-row req-now">
      <StepMark state="working" />
      {/* The words shimmer while Scarlet works. A narrow chat shortens them to two lines; hovering says them whole. */}
      <span role="status" title={words} className="req-now-text working-text">{words}</span>
      {(actions || onStop) && <div className="req-right">{actions || <button type="button" className="simple-link run-stop" onClick={onStop}>Stop</button>}</div>}
    </div>
    {say}
    {result?.(undefined)}
  </div>;
}

function WaitingRun({ task, events, changes, say, result, banded, paused, held, onStop, actions }: RunBundleProps) {
  const usage = useRunUsage(task.id, !banded);
  const asking = task.state === "waiting_for_user";
  const waiting = task.state === "queued";
  const [open, setOpen] = useState(false);
  const shown = useMemo(() => {
    if (!asking || banded) return [];
    const aim = runAim(events);
    return shownItems(runItems(task, events, changes).filter(item => !(item.kind === "note" && item.text === aim?.note)));
  }, [asking, banded, task, events, changes]);
  const lines = useMemo(() => open ? tidy(runLines(task, events, shown, Date.now())) : [], [open, task, events, shown]);
  // A request in line again says Queued, the word its cut's card and the tray use, or Paused while it waits for Resume.
  // One the editor holds back says so, as the tray does of the request that's next: it won't start by itself.
  const waitsOnEditor = waiting && !paused ? held : undefined;
  const label = waiting ? paused ? "Paused" : waitsOnEditor?.words ?? "Queued" : "Needs your answer";
  // A question's steps open from its line. A question under a heading has no such line: the heading's dot says it, and
  // the question is on top of the message box. Nor has a paused request: its heading says Paused.
  const line = !(banded && (asking || (waiting && paused)));
  const opens = asking && shown.length > 0;
  return <div className="req" data-state={asking ? "asking" : "working"} aria-label="Scarlet’s work" aria-busy={!asking}>
    {line && <div className="req-row req-status">
      <button type="button" className="req-toggle" aria-expanded={opens ? open : undefined} disabled={!opens}
        title={opens ? open ? "Hide the details" : "Show the details" : undefined} onClick={() => setOpen(!open)}>
        {asking && <span className="req-dot" aria-hidden />}
        <span role="status" title={waiting && paused ? PAUSED_HINT : label}
          className={asking || waitsOnEditor ? "req-ask" : undefined}>{label}</span>
      </button>
      <div className="req-right">
        {asking && <Tokens usage={usage} />}
        {waitsOnEditor?.startNow && <button type="button" className="queue-start" aria-label="Start now" title="Start now, before your calls"
          onClick={waitsOnEditor.startNow}><Icon name="play" size={10} /></button>}
        {actions || (onStop && <button type="button" className="simple-link run-stop" onClick={onStop}>Stop</button>)}
      </div>
    </div>}
    {line && lines.length > 0 && <RunList lines={lines} />}
    {say}
    {result?.(undefined)}
  </div>;
}

function FinishedRun({ task, finalChange, say, told, result, recovery, summary, listedAbove, showing, banded, onOpen, onResume, onWaitForTranscripts }: RunBundleProps) {
  const usage = useRunUsage(task.id, !banded);
  const summaryBtn = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (showing) summaryBtn.current?.scrollIntoView?.({ block: "nearest" });
  }, [showing]);
  // Finished. A run that ended without the transcripts it waited for says so, since what it saved is only part of the request.
  const paused = taskNeedsTranscripts(task);
  const stopped = task.state === "cancelled";
  const failed = task.state === "failed";
  const state = runEnded(task);
  const aside = usage?.totalTokens ? <Tokens usage={usage} /> : undefined;
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
      {/* The line stays on screen once pressed: clicked, it lets go of the focus, so Space plays instead of pressing it again. */}
      {madeAbove ? null : opens ? <button ref={summaryBtn} type="button" className={madeClass} aria-current={showing || undefined}
          title={summary ? `${made}\nShow on the timeline` : "Show on the timeline"} onClick={e => { blurOnPointerClick(e); opens(); }}><span>{made}</span></button>
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
const PICKING_UP = "Picking up where it left off";

/**
 * How a run that didn't finish ended, in the words its block says: waiting for its transcripts, stopped, or failed.
 * "Paused" is kept for editing the editor paused with Pause, which Resume picks up; this one waits on a transcript.
 */
export function runEnded(task: Task) {
  return taskNeedsTranscripts(task) ? `Needs ${task.needsTranscripts!.length > 1 ? "transcripts" : "transcript"}`
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
export function StepMark({ state }: { state: "done" | "working" }) {
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
