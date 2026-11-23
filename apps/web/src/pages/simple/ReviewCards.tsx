import { useEffect, type ReactNode } from "react";
import type { Change, MediaAsset, TimeRange, Timeline } from "@scarlet/timeline";
import type { Task, ThreadEdit } from "@scarlet/shared";
import { BeforeToggle } from "../../components/review/BeforeToggle";
import { CutMark, CutWordsLine, EditPassage } from "../../components/review/CutTranscript";
import { SourceLink, SourceRow } from "../../components/review/EditSource";
import { OtherTakes } from "../../components/review/OtherTakes";
import { ReviewActions } from "../../components/review/ReviewActions";
import { EditVersion, RejectEdit, type RejectedEdit } from "../../components/review/ThreadEdits";
import { Icon } from "../../components/ui/primitives";
import { editNote } from "../../lib/editKind";
import { clock as clockLabel, lengthLabel } from "../../lib/format";
import { useHotkeys } from "../../lib/hotkeys";
import { editKey } from "../../lib/keptEdits";
import type { Call, CutChoice, Revision } from "../../lib/passCalls";
import { isRecheck, type Thread } from "../../lib/threads";
import { useClippedExpand } from "../../lib/uiHooks";
import { useUndoStore } from "../../lib/undo";
import type { AgentContext } from "../../stores/ui";
import { approves, checkSpan, letGo, type Listening, type Side } from "./types";

/**
 * Scarlet's note in the card's row: up to two lines, and a longer note opens in full on a click and folds again on the
 * next. A call Scarlet hasn't checked yet says so first.
 */
export function EditNote({ text, unchecked }: { text: string; unchecked?: boolean }) {
  const { ref, clipped, open, opens, toggle } = useClippedExpand<HTMLHeadingElement>(text, 0);
  // No button: the pointer changes over a clipped note, and the hover title carries it for anyone not clicking.
  return <h2 ref={ref} className={`edit-card-title${open ? " is-open" : clipped ? " is-clipped" : ""}`}
    title={open ? undefined : text}
    aria-expanded={opens ? open : undefined} onClick={opens ? toggle : undefined}>
    {unchecked && <span className="edit-card-unchecked">Not checked yet. </span>}{text}</h2>;
}

/**
 * The icon on a cut's card that opens its words under the card's row, and folds them again. The words are the cut's
 * own, so they sit with its note and decisions, not in the chat. Hovering names it.
 */
export function TranscriptLink({ open, toggle, disabled }: { open: boolean; toggle(): void; disabled?: boolean }) {
  const name = open ? "Hide transcript" : "Show transcript";
  return <button type="button" className="edit-card-icon edit-card-words" data-log-control="toggle-transcript" aria-label={name} title={name} aria-expanded={open} disabled={disabled} onClick={letGo(toggle)}>
    <Icon name="diff" size={14} /></button>;
}

/** Where the decisions were, on a call that's with Scarlet: at work on it, asking about it, or not started yet. */
export function CallStanding({ run, answer }: { run?: Task; answer?(): void }) {
  const state = run?.state;
  return state === "queued" ? <span className="edit-card-status" role="status">Queued</span>
    : state === "waiting_for_user" && answer ? <button type="button" className="simple-link edit-card-status is-ask" aria-label="Answer" onClick={answer}>Needs your answer</button>
    : state === "waiting_for_user" ? <span className="edit-card-status is-ask" role="status">Needs your answer</span>
    : <span className="edit-card-status working-text" role="status">{run && isRecheck(run) ? "Rechecking…" : "Revising…"}</span>;
}

/**
 * A call's decisions and their keys, the same as an applied edit's card: Keep (K) makes the change Scarlet proposed,
 * the × that rejects it (X) leaves it out, and the chosen one stays pressed. A revision that left the cut's footage in
 * proposes keeping it, so there Keep keeps it and Reject edit cuts as first staged. Revise (R) aims the message box at this call, so feedback on it goes ahead of
 * requests waiting for the pass.
 */
export function CallActions({ choice, proposes = "cut", disabled, decide, revise }: { choice?: CutChoice; proposes?: CutChoice; disabled: boolean; decide(choice: CutChoice): void; revise(): void }) {
  const skips: CutChoice = proposes === "cut" ? "keep" : "cut";
  useHotkeys(event => {
    if (disabled || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "r") { event.preventDefault(); revise(); return; }
    const chosen = key === "k" ? proposes : key === "x" ? skips : undefined;
    if (chosen) { event.preventDefault(); decide(chosen); }
  });
  // The decisions stay on the card for the next call. Clicked, one lets go of the focus (WebView2 leaves it there), or
  // Space would press it again on the next call while the video is paused. Pressed by keyboard, it keeps it.
  return <div className="review-actions">
    <button type="button" className="btn-ghost" data-key="R" data-log-control="revise-call" aria-keyshortcuts="R" title="Revise (R)" disabled={disabled} onClick={revise}>Revise</button>
    <button type="button" className="btn-primary" data-key="K" data-log-control="approve-call" aria-keyshortcuts="K" title="Keep (K)" aria-pressed={choice === proposes} disabled={disabled}
      onClick={letGo(() => decide(proposes))}>Keep</button>
    {/* Reject edit is a small × after the decision, named on hover, as on an applied edit's card, so the row's one button is Keep. */}
    <button type="button" className="edit-card-icon edit-card-skip" data-log-control="skip-call" aria-label="Reject edit" aria-keyshortcuts="X" title="Reject edit (X)" aria-pressed={choice === skips}
      disabled={disabled} onClick={letGo(() => decide(skips))}><Icon name="x" size={12} /></button>
  </div>;
}

/**
 * Why the last ⌘Z couldn't take its step back, in the timeline's bottom row.
 */
export function UndoError({ projectId }: { projectId: string }) {
  const error = useUndoStore(s => s.error?.projectId === projectId ? s.error : undefined);
  // The reason goes after a while, as soon as anything else is done or taken back.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => useUndoStore.setState(s => s.error === error ? { error: undefined } : s), 10_000);
    return () => clearTimeout(timer);
  }, [error]);
  if (!error) return null;
  return <span className="timeline-undo">
    {/* Why the last one couldn't be taken back. It went from the list, so the next press goes on to the one before. */}
    <span className="timeline-undo-error" role="alert" title={error.text}>{error.text}</span>
  </span>;
}

/** A rejected edit shows where it was and says so, just rejected or opened again from its row. */
export function RejectedEditCard({ edit }: { edit: ThreadEdit }) {
  return <section className="edit-card is-rejected" role="region" aria-label="Rejected edit">
    <div className="edit-card-bar">
      <EditNote key={editKey(edit)} text={editNote(edit)} />
      <span className="edit-card-length is-kind">Rejected</span>
    </div>
  </section>;
}

export function AppliedEditCard({ projectId, focusThread, reviewingEdit, shownPassNo, editPlace, flaggedCount, editDid, selectedMoment,
  shownKind, shownMarker, reviewRange, onPlayCheck, visiting, beforeCut, cutBeforeTimeline, cutBeforeError, onRetryCutBefore,
  media, removedLength, otherCuts, scriptKey, scriptOpen, onToggleScript, shownSource, sourceKey, sourceOpen, onToggleSource, cutSwitched, cutTake, appliedSide, workspaceActive,
  cutKey, onChooseCutSide, setCompareHost, onRevise, onKeep, appliedTarget, rejectTarget, openEditKey, rejectedEdits, onEngineReject, onSentReject }: {
  projectId: string;
  focusThread: Thread;
  reviewingEdit: ThreadEdit;
  shownPassNo?: string;
  editPlace: number;
  flaggedCount: number;
  editDid?: ReactNode;
  selectedMoment?: { edits: ThreadEdit[]; members: ThreadEdit[] };
  shownKind?: string;
  shownMarker: boolean;
  reviewRange?: TimeRange;
  onPlayCheck(): void;
  visiting?: { at: string };
  beforeCut?: NonNullable<ThreadEdit["beforeCut"]>;
  cutBeforeTimeline?: Timeline | null;
  cutBeforeError?: string;
  onRetryCutBefore(): void;
  media: MediaAsset[];
  removedLength: number;
  otherCuts: TimeRange[];
  scriptKey?: string;
  scriptOpen: boolean;
  onToggleScript(): void;
  shownSource?: MediaAsset;
  sourceKey?: string;
  sourceOpen: boolean;
  onToggleSource(): void;
  cutSwitched: boolean;
  cutTake?: number;
  appliedSide: Side;
  workspaceActive: boolean;
  cutKey?: string;
  onChooseCutSide(side: Side): void;
  setCompareHost: (el: HTMLElement | null) => void;
  onRevise(): void;
  onKeep(): void;
  appliedTarget?: AgentContext;
  rejectTarget?: AgentContext;
  openEditKey?: string;
  rejectedEdits?: RejectedEdit[];
  onEngineReject(asked: boolean): void;
  onSentReject(sent: { task?: Task; version?: string }): void;
}) {
  return <section className="edit-card" role="region" aria-label="Applied edit">
    {/* Whose footage is playing, and nothing else: the lit icon in the row under it is the way back, and names its key. */}
    {visiting && <div className="edit-card-switched" role="status">
      <span className="edit-card-switched-side">Before</span>
      <span className="edit-card-switched-text">The cut at {visiting.at} took this part out.</span>
    </div>}
    <div className="edit-card-bar">
      {/* One the pass still waits on leads with its number, as on its line in the chat and its dot; its place among the
          ones still to check is on hover. Any other flagged edit leads with that place. */}
      {shownPassNo ? <span className="edit-card-count" title={editPlace >= 0 ? `${editPlace + 1} of ${flaggedCount} still to check` : undefined}>{shownPassNo}</span>
        : editPlace >= 0 && <span className="edit-card-count" title="Edits still to check">{editPlace + 1} of {flaggedCount}</span>}
      {/* The note explains the choice and includes any cue for the editor to check. */}
      {/* It's on up to two lines, so an edit with a short note is a single line. A clipped note opens on a click. */}
      {editDid ? <div className="edit-card-text">{editDid}<EditNote key={editKey(reviewingEdit)} text={editNote(reviewingEdit, !!reviewRange)} /></div>
        : <EditNote key={editKey(reviewingEdit)} text={editNote(reviewingEdit, !!reviewRange)} />}
      {/* A moment of a pass's list is its edits together: the pill says how many, and names them on hover. */}
      {selectedMoment ? <span className="edit-card-length is-kind" title={selectedMoment.members.map(e => e.label).join("\n")}>
        {selectedMoment.edits.length} edits</span>
        : !beforeCut && shownKind && <span className={reviewingEdit.kind === "restore" ? "edit-card-length is-added" : "edit-card-length is-kind"}>{shownKind}</span>}
      {/* Scarlet asks the editor to look or listen at a part of the video, which the timeline marks. It is a pill like the
          edit's kind, in amber: a press plays just that part, and its times are on hover. */}
      {reviewRange && <button type="button" className="edit-card-length is-check" onClick={onPlayCheck}
        title={`Play the part to check, ${checkSpan(reviewRange)}`}>Check</button>}
    </div>
    {/* A cut reads from the version before it. Until that arrives the mark stands alone and says the words are on their
        way, as a call's does. When it couldn't be read the passage offers to ask again, with why on hover. */}
    {scriptOpen && beforeCut && <div className="thread-passage">{cutBeforeTimeline
      ? <EditPassage key={editKey(reviewingEdit)} timeline={cutBeforeTimeline} media={media} range={beforeCut.removed} length={lengthLabel(removedLength)} others={otherCuts} />
      : <div className="edit-passage"><p className="review-spoken"><CutMark length={lengthLabel(removedLength)} />{" "}
        {cutBeforeError ? <button type="button" className="btn-quiet" title={cutBeforeError} onClick={onRetryCutBefore}>Retry transcript</button>
          : <span className="edit-passage-wait working-text" role="status">Loading the words…</span>}</p></div>}</div>}
    {sourceOpen && shownSource && <SourceRow key={sourceKey} file={shownSource} />}
    {/* The controls are a row of their own under the note: Before/After and the transcript at the left, the decisions at
        the right, the same on every card. */}
    <div className="edit-card-controls">
      <span className="edit-card-side">
        {beforeCut ? <BeforeToggle key={cutSwitched ? `click-${cutTake}` : "sides"} on={appliedSide === "before"} flash={cutSwitched}
          shortcutActive={workspaceActive} disabled={!cutKey} toggle={() => onChooseCutSide(appliedSide === "after" ? "before" : "after")} />
          : !shownMarker && <span ref={setCompareHost} className="review-compare" />}
        {/* A cut's words open above this row, behind a small icon. An edit that isn't a cut has none. */}
        {scriptKey && <TranscriptLink open={scriptOpen} toggle={onToggleScript} />}
        {/* B-roll from the web says where it came from behind an icon in the same place. */}
        {sourceKey && <SourceLink open={sourceOpen} toggle={onToggleSource} />}
      </span>
      <span className="edit-card-acts">
        <ReviewActions revise={onRevise} approve={onKeep}
          approveLabel={shownMarker ? "Done" : "Keep"} approveKey={shownMarker ? "D" : "K"} />
        {/* Reject edit is a small × after Keep, as on a call's card: it puts back just this edit, also on
            a moment's card. The edit leaves the timeline where it is and the card stays, saying Rejected. A spot marked for the editor changed nothing, so
            it has none. Each edit has its own: one on its way for the edit before doesn't hold this one's back. */}
        {appliedTarget && rejectTarget && !shownMarker && <RejectEdit key={`reject ${openEditKey}`} projectId={projectId} thread={focusThread} target={rejectTarget}
          edits={rejectedEdits} editsOn={appliedTarget.version}
          onEngine={onEngineReject} onSent={onSentReject} />}
      </span>
    </div>
  </section>;
}

export function CallCard({ projectId, pass, openCall, listening, callNum, callAt, callHistory, callWords, callLength, callKey,
  callScriptOpen, media, conflict, heard, visit, decideError, placing, stagedOnError, onRetryStagedOn, workspaceActive,
  onToggleSide, onToggleScript, openCallBack, callRun, onAnswerCut, choice, deciding, onDecide, onRevise }: {
  projectId: string;
  pass: Change;
  openCall: Call;
  listening: Listening;
  callNum?: number;
  callAt?: number;
  callHistory: readonly Revision[];
  callWords?: { timeline: Timeline; range: TimeRange };
  callLength: string;
  callKey?: string;
  callScriptOpen: boolean;
  media: MediaAsset[];
  conflict: boolean;
  heard?: TimeRange;
  visit?: { side: Side; label: string };
  decideError: string;
  placing: boolean;
  stagedOnError?: string;
  onRetryStagedOn(): void;
  workspaceActive: boolean;
  onToggleSide(): void;
  onToggleScript(): void;
  openCallBack: boolean;
  callRun?: Task;
  onAnswerCut?: () => void;
  choice?: CutChoice;
  deciding: boolean;
  onDecide(choice: CutChoice): void;
  onRevise(): void;
}) {
  return <section className="edit-card is-call" role="region" aria-label="Call">
    {/* A grey gap clicked: whose footage is playing, as on an applied cut's card. The lit icon is the way back. */}
    {visit?.side === "before" && <div className="edit-card-switched" role="status">
      <span className="edit-card-switched-side">Before</span>
      <span className="edit-card-switched-text">The cut at {visit.label} took this part out.</span>
    </div>}
    {(decideError || pass.error) && <p className="text-bad" role="alert">{decideError || pass.error}</p>}
    <div className="edit-card-bar">
      {/* The call's number, the same as on its line in the chat and its dot on the timeline. */}
      {/* Hovered, it says where the cut is in the video. */}
      <span className="edit-card-count" title={callAt !== undefined ? `Cut at ${clockLabel(callAt)}` : undefined}>Cut {callNum}</span>
      {callHistory.length > 0 && <EditVersion n={callHistory.length + 1}
        title={`v${callHistory.length}: ${callHistory.at(-1)!.reason ?? "Scarlet’s earlier version."}${callHistory.at(-1)!.note ? `\nYou: “${callHistory.at(-1)!.note}”` : ""}`} />}
      {/* What Keep would take out, struck, over Scarlet's reason. A revision that leaves the footage in has no such line. */}
      {callWords && !conflict && approves(openCall) === "cut" ? <div className="edit-card-text">
        <CutWordsLine key={`what ${callKey}`} timeline={callWords.timeline} media={media} range={callWords.range} length={callLength} verb="Takes out" />
        <EditNote key={callKey} text={openCall.reason} unchecked={openCall.unchecked} /></div>
        : <EditNote key={callKey} text={openCall.reason} unchecked={openCall.unchecked} />}
    </div>
    {/* A call hasn't come out yet, so its words are marked in amber. When the pass's version couldn't be loaded there
        is nothing to read them on: the passage stops waiting and offers to ask again, as it does for the words. */}
    {callScriptOpen && <div className="thread-passage is-call">{callWords ? <>
      <EditPassage key={callKey} current={conflict} timeline={callWords.timeline} media={media} range={callWords.range} length={callLength} />
      {!conflict && <OtherTakes projectId={projectId} timeline={callWords.timeline} media={media} range={callWords.range} />}
    </> : <div className="edit-passage"><p className="review-spoken"><CutMark length={callLength} />{" "}
      {placing && stagedOnError ? <button type="button" className="btn-quiet" title={stagedOnError} onClick={onRetryStagedOn}>Retry transcript</button>
        : <span className="edit-passage-wait working-text" role="status">Loading the words…</span>}</p></div>}</div>}
    <div className="edit-card-controls">
      <span className="edit-card-side">
        {/* Until the cut is placed on the working cut there is nothing to play it on, as with an applied cut. */}
        <BeforeToggle key={listening.at === undefined && visit?.side !== "before" ? "sides" : `click-${listening.take}`} on={!conflict && listening.side === "before"} shortcutActive={workspaceActive} disabled={!heard || conflict}
          flash={!conflict && listening.side === "before" && (listening.at !== undefined || visit?.side === "before")} toggle={onToggleSide} />
        <TranscriptLink open={callScriptOpen} disabled={conflict && !heard} toggle={onToggleScript} />
      </span>
      {openCallBack ? <CallStanding run={callRun} answer={onAnswerCut} />
        : <CallActions choice={choice} proposes={approves(openCall)} disabled={deciding} decide={onDecide} revise={onRevise} />}
    </div>
  </section>;
}

export function SuggestionCard({ suggestionId, note, stripError, side, workspaceActive, onToggleSide, onRevise, applyingShown, deciding, onApply }: {
  suggestionId: string;
  note: string;
  stripError: string;
  side: Side;
  workspaceActive: boolean;
  onToggleSide(): void;
  onRevise(): void;
  applyingShown: boolean;
  deciding: boolean;
  onApply(): void;
}) {
  return <section className="edit-card is-suggestion" role="region" aria-label="Suggestion">
    {stripError && <p className="text-bad" role="alert">{stripError}</p>}
    <div className="edit-card-bar">
      <EditNote key={suggestionId} text={note} />
    </div>
    <div className="edit-card-controls">
      <span className="edit-card-side">
        <BeforeToggle on={side === "before"} shortcutActive={workspaceActive} toggle={onToggleSide} />
      </span>
      <span className="edit-card-acts">
        {/* While another change is applied this one waits its turn: it can still be revised or closed. */}
        <ReviewActions revise={onRevise} disabled={applyingShown} approvalDisabled={deciding} approveLabel={applyingShown ? "Applying…" : "Apply"} approve={onApply} />
      </span>
    </div>
  </section>;
}
