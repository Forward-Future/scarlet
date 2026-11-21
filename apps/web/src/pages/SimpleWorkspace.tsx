import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type Dispatch, type MouseEvent, type ReactElement, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { createStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Link, useSearchParams } from "react-router-dom";
import { ChatRail } from "../components/shell/ChatRail";
import { ConnectionStatus } from "../components/shell/StatusIndicators";
import { Dropdown, MenuItem } from "../components/shell/WorkspaceNavigation";
import { appliedReviewChange, isPublishedCall, mapStagedCut, makeTimeMap, timelineDuration, type Change, type CutAssessment, type TimeRange, type Timeline } from "@scarlet/timeline";
import { closingCheckFailed, isAsideTask, fullRenderContext, isProjectEditTask, matchesEdit, queueOrder, queueWaits, requestTargetKey, requestText, REVISED_CHECK, threadEditList, type EditRef, type Learning, type Task, type ThreadEdit } from "@scarlet/shared";
import { EditBadge, editGroups, EditVersion, RejectEdit, RejectedMark, ThreadAction, ThreadEdits, useRejecting, useReviewed, useRevising, useThreadEdits } from "../components/review/ThreadEdits";
import { useKeptEdits } from "../lib/keptEdits";
import { useNearView } from "../lib/useNearView";
import { needNumbers } from "../lib/needNumbers";
import { QueueTray, useRewordingHold, type QueuedRequest } from "../components/chat/QueueTray";
import { TipButton } from "../components/ui/TipButton";
import { recordEditReview } from "../lib/editReviews";
import { lastStep, recordUndo, undoKey, undoLast, undoWords, useUndoStore } from "../lib/undo";
import { editKey, keepEdits, reviewKey } from "../lib/keptEdits";
import { AgentChip, useAgentAvailability } from "../components/agent/AgentChip";
import { Composer, type PausedAt } from "../components/agent/Composer";
import { useImportTranscription } from "../components/media/TranscriptionAction";
import { Dropzone, useImportCount, useUploader } from "../components/media/UploadDropzone";
import { MediaDrawer } from "../components/media/MediaDrawer";
import { CachingMenuItem, MediaButton, useVideoCaching } from "../components/media/MediaMenuItems";
import { LearningsPanel, learningsToReview } from "../components/review/LearningsPanel";
import { usePlaybackCache } from "../components/player/usePlaybackCache";
import { focusAround } from "../components/player/SimpleProgress";
import { useCutReview, useSingleCutDraft, type SingleCutDrafts } from "../components/review/useCutReview";
import { callToPrepare, editToPrepare, usePrepareReviewCuts, type PreparedCut, type CutToPrepare } from "../components/review/usePrepareNextCut";
import { CutMark, CutWordsLine, EditPassage } from "../components/review/CutTranscript";
import { editDetail } from "../lib/editDetail";
import { editSource, SourceLink, SourceRow } from "../components/review/EditSource";
import { useReviewTimeline } from "../components/review/useReviewTimeline";
import { ReviewActions } from "../components/review/ReviewActions";
import { BeforeToggle } from "../components/review/BeforeToggle";
import { ignorePageShortcut, isEditableTarget, useHotkeys } from "../lib/hotkeys";
import { RequestMetrics, RunBundle, runEnded, Said } from "../components/review/RunBundle";
import { OtherTakes } from "../components/review/OtherTakes";
import { ExportSheet } from "../components/review/ExportVideo";
import { ExportButton } from "../components/review/ExportMenuItem";
import { useThreadTimeline } from "../components/review/useThreadTimeline";
import { Icon, Loading } from "../components/ui/primitives";
import { api, errorMessage } from "../lib/client";
import { readTimeline } from "../lib/timelineCache";
import { appLog } from "../lib/appLog";
import { markedFrameUrl } from "../lib/markedFramePictures";
import { clock as clockLabel, clockRange, lengthLabel, plural, removedSeconds } from "../lib/format";
import { editPlaybackRange } from "../lib/editPlaybackRange";
import { listMoments, momentRange, type Moment } from "../lib/editMoments";
import { madeSentence, type SentencePart } from "../lib/madeSentence";
import { editFocus, editKindWord, editNote, editRowWord } from "../lib/editKind";
import { player, type Audition } from "../lib/player";
import { appliedCutClock, appliedCutSource, cutChange } from "../lib/appliedCutPlayback";
import { cutAudition, cutAuditionClock, isolatedReviewCut } from "../lib/cutAudition";
import { besides, removedSince } from "../lib/removedSince";
import { usePlayerStore } from "../stores/player";
import { composeClocks, verifiedJoinClock, type JoinClock } from "../lib/joinClock";
import { buildThreads, firstCutDeliveries, isRedo, requestTarget, revisionTarget, stagedCuts, threadConversation, type Thread, type ThreadEntry } from "../lib/threads";
import { runIsActive, spentLabel } from "../lib/taskRun";
import { aboutOne, aimOf, closingReply, lastAttempt, laterAttempts, notesStillAsked, redoWords, requestRoots, stagingTask, takenFromQueue, threadRuns, waitingToStart, type Run } from "../lib/requestRuns";
import { callGoesTo, callNow, callRevisions, carriedCall, carryingVersions, cutOnWorkingCut, isDialoguePass, isOpenPass, keepGoesTo, noRevisions, openPass, passRevision, reviewCalls, revisedCall, revisedFrom, revisionCut, savedChoices, waitsToPlay,
  type Call, type CutChoice, type Footage, type Revision } from "../lib/passCalls";
import { canPreviewMedia } from "../lib/upload";
import { showingWorkingCut, useShownCut } from "../stores/shownCut";
import { useProjectStore } from "../stores/project";
import { useSkillsStore } from "../stores/skills";
import { messageTimestamps, type MessageClock } from "../lib/messageTimestamps";
import { markedRangeOf, playheadPoints, pointOf, useUiStore, withMarkedRange, type AgentContext, type MarkedRange } from "../stores/ui";
import { CutPreview } from "./WatchPage";
import { EditHoverContext, type TimelineDot, type TimelineGap } from "../components/review/TimelineScrubber";
import "../simple.css";

const narrow = window.matchMedia("(max-width: 767px)");
function subscribeWidth(update: () => void) {
  narrow.addEventListener("change", update);
  return () => narrow.removeEventListener("change", update);
}
/** The chat, until the user drags the divider: room for a conversation without crowding the video. */
const simpleRailWidth = (available: number) => Math.max(380, Math.min(480, available * 0.32));
/** The narrowest the chat stays usable at. */
const SIMPLE_RAIL_MIN = 320;
/** The Transcript's column beside the player: wide enough for a few lines of words, never more of the window than the chat. */
const transcriptRailWidth = (available: number) => Math.max(300, Math.min(400, available * 0.26));
const TRANSCRIPT_RAIL_MIN = 260;

const TranscriptPane = lazy(async () => ({ default: (await import("../components/transcript/TranscriptPane")).TranscriptPane }));
const noEdits: ThreadEdit[] = [];
const noop = () => {};
const ts = (x?: string) => Date.parse(x ?? "") || 0;
/** How long after the project opens its own changes are still arriving, in ms: one applied by then arrives quietly. */
const LANDING_SETTLES = 3000;
/** How long an edit counts as just applied, in ms: its marker can take a moment to load after the change lands. */
const LANDING_SHOWS = 4000;
/** ↑ ↓ step between the cuts or edits that are open one at a time. ← → are always the player's: they skip. */
const stepOf = (key: string): 1 | -1 | undefined => key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : undefined;

type Side = "before" | "after";
/**
 * `take` counts presses of Before and After, so pressing the shown side again plays it from the top. `key` names the
 * call as it was when the listen began: it stays the same when the pass comes back as a new proposal and the cut gets a
 * new number, so the card keeps what the editor opened in it.
 */
/** `at` starts the listen somewhere other than its top: where a click on the timeline pointed, inside the cut. */
interface Listening { changeId: string; index: number; cut: TimeRange; side: Side; take: number; key: string; at?: number }
/** After, played from the version the cut made, where the join is inside the rendered media. */
interface JoinedListen { version: string; timeline: Timeline; clock: JoinClock }

/** Let the new video finish attaching (including StrictMode's effect replay) before giving it a listen.
 * A selection replaced in the same commit never starts playback on the next selection's video. */
function afterPlayerMount(start: () => () => void) {
  let closed = false;
  let stop: (() => void) | undefined;
  queueMicrotask(() => { if (!closed) stop = start(); });
  return () => {
    closed = true;
    stop?.();
  };
}

type Panel = "media" | "export" | "learnings" | null;

/** Each project keeps its own: rewording a request in one project leaves the words kept for another as they are. */
const LEGACY_REWORDING_KEY = "scarlet.rewording.v1";
const rewordingKey = (projectId: string) => `${LEGACY_REWORDING_KEY}:${projectId}`;
function readRewording(key: string, projectId: string): { id: string; text: string } | undefined {
  const saved = JSON.parse(localStorage.getItem(key) ?? "null") as { projectId?: unknown; id?: unknown; text?: unknown } | null;
  return saved && saved.projectId === projectId && typeof saved.id === "string" && typeof saved.text === "string" ? { id: saved.id, text: saved.text } : undefined;
}
/** The queued request whose words were in the message box when the project was last on screen, with those words. */
function savedRewording(projectId: string): { id: string; text: string } | undefined {
  try {
    // Words kept before each project had its own slot are in the one slot all projects shared.
    return readRewording(rewordingKey(projectId), projectId) ?? readRewording(LEGACY_REWORDING_KEY, projectId);
  } catch {
    return undefined;
  }
}
function saveRewording(projectId: string, rewording: { id: string; text: string } | undefined) {
  try {
    if (rewording) localStorage.setItem(rewordingKey(projectId), JSON.stringify({ projectId, ...rewording }));
    else localStorage.removeItem(rewordingKey(projectId));
    // The shared slot is this project's no longer: its words are in the project's own now, or done with.
    if (readRewording(LEGACY_REWORDING_KEY, projectId)) localStorage.removeItem(LEGACY_REWORDING_KEY);
  } catch { /* Without storage the words last for this session only. */ }
}

/** How many versions' timelines the window keeps beyond the ones a waiting pass needs. */
const KEPT_TIMELINES = 6;

/**
 * The timelines a pass's cuts are carried across. Each working cut the window shows is kept as it goes by, so the
 * version before Scarlet's own edit between two parts is at hand the moment the next part arrives, and a card open on
 * a call stays open. Any other version wanted is asked for.
 */
function useCarryingFootage(projectId: string, working: Timeline | null | undefined, wanted: readonly string[], fps: number): Footage {
  const kept = useRef<{ projectId: string; timelines: Map<string, Timeline>; asked: Set<string> }>(undefined);
  if (kept.current?.projectId !== projectId) kept.current = { projectId, timelines: new Map(), asked: new Set() };
  const store = kept.current;
  const [fetched, setFetched] = useState(0);
  const remember = (timeline: Timeline) => {
    const { timelines } = store;
    timelines.delete(timeline.version);
    timelines.set(timeline.version, timeline);
    for (const version of [...timelines.keys()]) {
      if (timelines.size <= KEPT_TIMELINES + wanted.length) break;
      if (!wanted.includes(version)) timelines.delete(version);
    }
  };
  if (working?.version && store.timelines.get(working.version) !== working) remember(working);
  const key = wanted.join("\n");
  useEffect(() => {
    const missing = wanted.filter(v => !store.timelines.has(v) && !store.asked.has(v));
    for (const version of missing) {
      store.asked.add(version);
      readTimeline(projectId, version).then(timeline => {
        if (kept.current !== store) return;
        remember(timeline);
        setFetched(n => n + 1);
      }, () => { store.asked.delete(version); });
    }
  }, [projectId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({ at: version => store.timelines.get(version), fps }), [store, working, fetched, fps]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The dialogue pass waiting on the editor, as the chat's summary card needs it. */
interface OpenPass {
  change: Change;
  threadId: string;
  /** How many cuts the pass proposes. */
  cuts: number;
  /** Every call in the pass, numbered, with where it stands: the progress the summary card shows. */
  calls: PassCall[];
  /** The numbers of the request's edits that ask for a look, by `editKey`: they count on from the calls. */
  editNumbers: ReadonlyMap<string, { n: number; name: string }>;
  openCall(index: number): void;
  running: boolean;
  /** Scarlet is still on the pass and has checked none of its staged cuts, so there is nothing yet to apply or schedule. */
  unchecked: boolean;
  /** The calls are made and the pass goes in when Scarlet finishes. */
  scheduled: boolean;
  /** Scarlet is revising one cut. The other calls stay open meanwhile. */
  revising: boolean;
  deciding: boolean;
  error: string;
  /** Try again to apply the pass, after an apply that failed. It otherwise goes in by itself once no call is left. */
  apply(): void;
}

type HoveredReviewRow = { threadId: string; editKey?: string; call?: number };
type ReviewMarker = { edit: ThreadEdit; number: number; total: number };
type LocatedReview = { head: string | null; markers: ReviewMarker[] };
type ReportReviewMarkers = (threadId: string, review?: LocatedReview) => void;

interface ChatActions {
  /** How many requests about one cut or edit Scarlet is working on at this moment. It works on several at once when each is about its own. */
  atOnce?: number;
  showing?: ThreadEdit;
  /** The request whose own row opened the edit that's showing. Opened from a list or the timeline, there is none. */
  showingFrom?: string;
  /** The request whose edits the timeline marks. Its band is a shade lighter. */
  marked?: string;
  /** Put a request's edits on the timeline, from a press on its band. */
  mark?(threadId: string): void;
  /** Show the whole timeline, from a press on any request's band. */
  fitTimeline?(): void;
  pass?: OpenPass;
  reviewingId?: string;
  listening?: Listening;
  listen(change: Change, assessment: CutAssessment): void;
  play(thread: Thread, change: Change): void;
  /** Open an edit as ↑ ↓ and Keep reach it: its moment, or with `single` that edit alone. */
  playEdit(edit: ThreadEdit, single?: boolean): void;
  /** The edit that's showing was picked on its own from under its moment's row, not as the moment. */
  showingSingle?: boolean;
  /**
   * Open one edit of a thread in its card on the timeline, loading the thread's markers first if needed. `from` is the
   * request whose row asked. A moment's main edit opens the whole moment; `single` opens that edit on its own, as a
   * row under the moment's does.
   */
  openEdit(thread: Thread, ref: EditRef, from?: string, single?: boolean): void;
  review(change: Change): void;
  /** Turn off whatever the player is showing and go back to the whole timeline. */
  stopShowing(): void;
  /**
   * A pass's full list opened or closed in the chat. While it's open, the timeline shows the pass's settled edits too.
   * `moved` is a list that was open already and only moved with its request: it doesn't take the timeline again.
   */
  listOpen(threadId: string, open: boolean, moved?: boolean): void;
  /** Light the timeline's marker at this time, or none: the pointer is over that edit's row in the chat. */
  lightMark(time?: number, target?: HoveredReviewRow): void;
  reply(thread: Thread): void;
  revise(thread: Thread, change: Change): void;
  /**
   * What a request about one cut is called while that cut is a call of the pass waiting now, or an edit of its request
   * that asks for a look: "Cut 2", its number, the same on its line in the list, on its card and on the timeline. Any
   * other cut goes by its time.
   */
  cutName?(about: { changeId?: string; cutIndex?: number; editIndex?: number }): string | undefined;
  /** The number a call of the waiting pass goes by, for a line that names it ("Listening to Cut 2"). */
  callNumber?(changeId: string, cutIndex: number): number | undefined;
  /** Open Learnings with this rule in view, from the line under the request it came from. */
  reviewLearning?(learningId: string): void;
}

/**
 * A rule Scarlet picked up from this request, under what the request did: the skill it is for and the rule in quotes,
 * then Review, which opens Learnings at it, and Decline, which turns the rule down from here. The line goes once the
 * editor decides, here or in Learnings.
 */
function LearnedLine({ learning, onReview }: { learning: Learning; onReview?(id: string): void }) {
  const skill = useSkillsStore(s => s.skills.find(k => k.id === learning.skillId)?.name);
  // The line names the skill, so the library is read once if nothing has read it yet. A read that failed isn't asked
  // again from here: the line says "Learned:" without the name, and Learnings tries again as it opens.
  const loadSkills = useSkillsStore(s => s.load);
  useEffect(() => { if (useSkillsStore.getState().status === "idle") void loadSkills(); }, [loadSkills]);
  const [declining, setDeclining] = useState(false);
  const [failed, setFailed] = useState("");
  const decline = () => {
    setDeclining(true);
    setFailed("");
    useProjectStore.getState().declineLearning(learning.id)
      .catch(e => setFailed(errorMessage(e)))
      .finally(() => setDeclining(false));
  };
  return <p className="simple-learned">
    <Icon name="bulb" size={13} />
    <span>{skill ? `Learned for ${skill}: ` : "Learned: "}<span className="simple-learned-rule">“{learning.rule}”</span>
      {onReview && <> <button type="button" className="simple-learned-review" onClick={() => onReview(learning.id)}
        title="Approve or revise it in Learnings">Review</button></>}
      {" "}<button type="button" className="simple-learned-decline" disabled={declining} onClick={decline}
        title="Don't learn this">Decline</button>
      {failed && <span className="simple-learned-failed" role="alert"> Couldn't decline. {failed}</span>}</span>
  </p>;
}

/**
 * Scarlet's note in the card's row: up to two lines, and a longer note opens in full on a click and folds again on the
 * next. A call Scarlet hasn't checked yet says so first.
 */
function EditNote({ text, unchecked }: { text: string; unchecked?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);
  const opens = clipped || open;
  // No button: the pointer changes over a clipped note, and the hover title carries it for anyone not clicking.
  return <h2 ref={ref} className={`edit-card-title${open ? " is-open" : clipped ? " is-clipped" : ""}`}
    title={open ? undefined : text}
    aria-expanded={opens ? open : undefined} onClick={opens ? () => setOpen(!open) : undefined}>
    {unchecked && <span className="edit-card-unchecked">Not checked yet. </span>}{text}</h2>;
}

/**
 * A control that stays on screen after it's pressed lets go of the focus when it was pressed with the mouse: WebView2
 * leaves the focus on a clicked button, and Space would then press it again instead of playing the video. Pressed
 * with the keyboard it keeps the focus, so Tab goes on from there.
 */
const letGo = (act: () => void) => (e: MouseEvent<HTMLElement>) => { if (e.detail) e.currentTarget.blur(); act(); };

/**
 * The icon on a cut's card that opens its words under the card's row, and folds them again. The words are the cut's
 * own, so they sit with its note and decisions, not in the chat. Hovering names it.
 */
function TranscriptLink({ open, toggle, disabled }: { open: boolean; toggle(): void; disabled?: boolean }) {
  const name = open ? "Hide transcript" : "Show transcript";
  return <button type="button" className="edit-card-icon edit-card-words" data-log-control="toggle-transcript" aria-label={name} title={name} aria-expanded={open} disabled={disabled} onClick={letGo(toggle)}>
    <Icon name="diff" size={14} /></button>;
}

/** Where the decisions were, on a call that's with Scarlet: at work on it, asking about it, or not started yet. */
function CallStanding({ run, answer }: { run?: Task; answer?(): void }) {
  const state = run?.state;
  return state === "queued" ? <span className="edit-card-status" role="status">Queued</span>
    : state === "waiting_for_user" && answer ? <button type="button" className="simple-link edit-card-status is-ask" aria-label="Answer" onClick={answer}>Needs your answer</button>
    : state === "waiting_for_user" ? <span className="edit-card-status is-ask" role="status">Needs your answer</span>
    : <span className="edit-card-status working-text" role="status">Revising…</span>;
}

/** What Keep chooses on a call: the cut, or for a revision that left the footage in, keeping it. */
const approves = (call: Pick<CutAssessment, "proposes"> | undefined): CutChoice => call?.proposes ?? "cut";

/**
 * A call's decisions and their keys, the same as an applied edit's card: Keep (K) makes the change Scarlet proposed,
 * the × that rejects it (X) leaves it out, and the chosen one stays pressed. A revision that left the cut's footage in
 * proposes keeping it, so there Keep keeps it and Reject edit cuts as first staged. Revise (R) aims the message box at this call, so feedback on it goes ahead of
 * requests waiting for the pass.
 */
function CallActions({ choice, proposes = "cut", disabled, decide, revise }: { choice?: CutChoice; proposes?: CutChoice; disabled: boolean; decide(choice: CutChoice): void; revise(): void }) {
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

/** Where a call stands: approved, skipped, still open, or being revised. */
type CallState = "approved" | "skipped" | "open" | "revising";
interface PassCall { index: number; askOrder?: number;
  /** Its number, as on its card and the timeline: the order it reached the editor in. */
  n: number;
  /** Where its row goes in the list. */
  start: number;
  /** Where its cut is on the working cut. None while it isn't there as it was staged, so nothing on the timeline is its. */
  at?: number;
  summary: string; state: CallState; version: number;
  /** The request about this cut that Scarlet is on, or the next one waiting, while it's sent back. */
  run?: Task;
  /** What the last version was and the note that sent it back, for a revised call. */
  earlier?: Revision }

const callRowKey = (c: PassCall) => `call/${c.n}`;

/**
 * An edit by its first version. A revision that lands takes the edit's place in the list under a new identity, and
 * is still that edit to the editor: what they started on its open card stays theirs.
 */
const firstKey = (edit: ThreadEdit) => editKey(edit.previous[0] ?? edit);

/** True when this edit is the one in the player, including an earlier attempt that a revision replaced. */
function belongsTo(edit: ThreadEdit | undefined, change: Change) {
  return !!edit && (edit.changeId === change.id || edit.previous.some(ref => ref.changeId === change.id));
}

/** A request's words, short enough to lead a hover note: its first line, up to 32 characters. */
const shortTitle = (title: string) => {
  const line = title.split("\n")[0]!.trim();
  return line.length > 32 ? `${line.slice(0, 31).trimEnd()}…` : line;
};

/**
 * Scarlet's words about a change. Applied edits are listed once for the whole thread, after the last reply,
 * so a reply carries only what needs the editor and, for a proposal, how to play it.
 */
function ChangeReply({ thread, entry, actions }: { thread: Thread; entry: Extract<ThreadEntry, { kind: "change" }>; actions: ChatActions }) {
  const { change } = entry;
  const pending = waitsToPlay(change, thread);
  // A dialogue pass's calls are counted on the thread's summary card and made in the card on the timeline.
  const pass = pending && isDialoguePass(change);
  const reviewing = actions.reviewingId === change.id;
  return <div className="simple-msg from-scarlet">
    <span className="simple-who">Scarlet</span>
    {/* A suggestion still waiting has no Play link under it: its one line is the control, led by the play mark. */}
    {pending && !pass ? <button type="button" className={reviewing ? "simple-suggest is-on" : "simple-suggest"} aria-pressed={reviewing}
      title={reviewing ? "Stop showing this suggestion" : "Play this suggestion"} onClick={() => reviewing ? actions.stopShowing() : actions.review(change)}>
      <Icon name="play" size={11} /><span title={entry.text}>{entry.text}</span></button> : <Said text={entry.text} />}
  </div>;
}

/** Scarlet is on a request now, as against one waiting its turn or for an answer. */
const isWorking = (state?: Task["state"]) => state === "claimed" || state === "running";
const noRejected: Omit<ThreadEdit, "at">[] = [];

/**
 * Which of a request's lists is open: every edit, or just the ones that need the editor. A pass's calls are listed
 * without a click for as long as they wait.
 */
type OpenList = "all" | "need" | undefined;
type PassList = [open: OpenList, setOpen: Dispatch<SetStateAction<OpenList>>];

/** A request about one cut or edit that is still in the chat, drawn directly under the row it is about. `key` is that row's. */
interface Nest { key: string; node: ReactNode }
const noNests: readonly Nest[] = [];
/** What the requests about each row's cut or edit took, by the row's key, for the hover of the word the row ends on. */
type Spent = ReadonlyMap<string, string>;
const noSpent: Spent = new Map();

/**
 * A finished request with one result opens its edit on the timeline. A collection opens a list to choose from. One
 * edit, or the edits so far while Scarlet works, is a link after the sentence (`place` "inline"). A finished
 * collection is See all, a tab in the row where For you and See all sit when something waits on the editor
 * (`place` "tab"), so it is in the same place either way. Each place draws only its own.
 */
function EditResultLink({ thread, actions, single, count, soFar, list: [open, setOpen], reveal, place }: {
  thread: Thread; actions: ChatActions; single?: EditRef; count: number; soFar?: boolean; list: PassList; reveal(): void; place: "inline" | "tab";
}) {
  const expanded = open === "all";
  const current = !!single && !!actions.showing && matchesEdit(actions.showing, single);
  const isLink = (!!single && (!expanded || current)) || !!soFar;
  if (isLink !== (place === "inline")) return null;
  if (!soFar && !isLink) {
    const label = count === 2 ? "See both" : "See all";
    return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
      <button type="button" className="simple-review-tab" aria-pressed={expanded} title={expanded ? "Hide the edits" : "Show the edits in order"}
        onClick={letGo(() => { if (!expanded) reveal(); setOpen(expanded ? undefined : "all"); })}>{label}</button>
    </div>;
  }
  if (single && (!expanded || current)) {
    const toggleEdit = () => {
      if (!current) return actions.openEdit(thread, single);
      setOpen(undefined);
      actions.stopShowing();
    };
    return <button type="button" className="simple-pass-toggle" aria-current={current || undefined}
      title={current ? "Close this edit (Esc)" : "Show on the timeline"} onClick={letGo(toggleEdit)}>{current ? "Close edit" : "See edit"}</button>;
  }
  return <button type="button" className="simple-pass-toggle" data-so-far aria-expanded={expanded}
    title={expanded ? "Hide the edits" : "Show the edits Scarlet has made so far, in order"}
    onClick={() => { if (!expanded) reveal(); setOpen(expanded ? undefined : "all"); }}>{expanded ? "Hide" : `See ${count} ${count === 1 ? "edit" : "edits"} so far`}</button>;
}

function ReviewListTabs({ need, canSeeAll, list: [open, setOpen], reveal, showNeeded }: {
  need: number; canSeeAll: boolean; list: PassList; reveal(): void; showNeeded(): void;
}) {
  const all = open === "all";
  const showAll = () => {
    if (all) return;
    reveal();
    setOpen("all");
  };
  return <div className="simple-review-tabs" role="group" aria-label="Edit lists">
    <button type="button" className="simple-review-tab simple-pass-need" aria-label="For you" aria-pressed={!all}
      title={need ? `${need} ${need === 1 ? "needs" : "need"} you` : undefined} onClick={letGo(showNeeded)}>
      For you{need > 0 && <span className="simple-review-tab-count" aria-hidden="true">{need}</span>}
    </button>
    {canSeeAll && <button type="button" className="simple-review-tab" aria-pressed={all} onClick={letGo(showAll)}>See all</button>}
  </div>;
}

/**
 * A list the editor opens is brought into view. The conversation sits at its latest message, so a list opened on the
 * last request grows downward, under the message box, and the click would seem to do nothing. Only a press asks for
 * it: a list that is open already when its block is drawn again moves nothing.
 */
function useReveal(open: unknown) {
  const host = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current) return;
    asked.current = false;
    if (open) {
      const rows = host.current?.querySelector(".simple-pass-list, .simple-edits");
      const row = rows?.querySelector(':scope > li > button[aria-current="true"]') ?? rows?.querySelector(":scope > li > button");
      row?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open]);
  return [host, () => { asked.current = true; }] as const;
}

/** What a request changed in the video: one sentence, its figures in bold, and on the same line the link that opens its edits. */
function Made({ parts, link }: { parts: readonly SentencePart[]; link?: ReactNode }) {
  if (!parts.length) return null;
  return <p className="simple-made-line"><span className="simple-made">{parts.map((part, i) => typeof part === "string" ? part : <b key={i}>{part.strong}</b>)}</span>{link}</p>;
}

/**
 * What a dialogue pass made, as the rows of its block. While its calls wait they are listed without a click, each by
 * its number with Scarlet's note and, once decided or sent back, a word for where it stands. For you shows that list
 * by default and opens the first one still waiting when pressed. See all lists every edit, calls included, in timeline
 * order. Once Scarlet is done, what the pass applied is one sentence above the list. A row is one line and opens its
 * edit or call in the card on the timeline, where Keep and Reject edit move on to the next call. A request about one cut
 * or edit that is still in the chat (`nests`) sits directly under that cut's or edit's row. `aside` is what the run
 * used, when that shows.
 */
function PassSummary({ projectId, thread, edits, rejected = noRejected, actions, aside, list: listState, listedNeed, working, nests = noNests, spent = noSpent }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[];
  /** Edits the editor rejected: out of the video, each keeps a row in the list of every edit, with a × and "Rejected". */
  rejected?: Omit<ThreadEdit, "at">[];
  actions: ChatActions; aside?: ReactNode; list: PassList; listedNeed: RefObject<Set<string>>; working?: boolean; nests?: readonly Nest[]; spent?: Spent }) {
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  const rejecting = useRejecting(thread);
  const kept = useKeptEdits(projectId, thread);
  const [open, setOpen] = listState;
  const [host, reveal] = useReveal(open);
  // The list follows the cut or edit that's open, so stepping with the arrows never leaves its row out of sight.
  const list = useRef<HTMLOListElement>(null);
  const onRow = actions.showing ? editKey(actions.showing) : actions.listening?.key;
  useEffect(() => { list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [onRow, open]);
  const pass = actions.pass?.threadId === thread.id ? actions.pass : undefined;
  // An edit sent back for revision waits on Scarlet, not on the editor.
  const flagged = useMemo(() => edits.filter(e => e.check && !reviewed(e) && !revising(e)), [edits, reviewed, revising]);
  const openCalls = pass?.calls.filter(c => c.state === "open").length ?? 0;
  const need = openCalls + flagged.length;
  // One sent back for revision waits on Scarlet, and keeps its row in the list of what needs the editor until it is back.
  const sentBack = useMemo(() => edits.filter(e => e.check && !reviewed(e) && revising(e)).length, [edits, reviewed, revising]);
  const totalRows = edits.length + (pass?.calls.length ?? 0);
  // While the pass makes its final check of the finished cut, the fixes it applies are marked New in the list: nothing
  // else tells them from the cuts that went in before (2026-11-14).
  const rerun = working ? thread.tasks.find(t => !!t.repeatAudit?.returns && !!t.startedAt && (t.state === "running" || t.state === "claimed")) : undefined;
  const fresh = useMemo(() => new Set(rerun ? thread.changes.filter(c => c.taskId === rerun.id && (c.createdAt ?? "") >= rerun.startedAt!).map(c => c.id) : []),
    [rerun, thread.changes]);
  // In the list of every edit, edits that play as one change are one row, a moment. Its own edits open under it on a
  // press of "+ 4 edits", and fold again on the next.
  const moments = useMemo(() => listMoments(edits), [edits]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const single = !working && !pass?.running && totalRows === 1 ? edits[0] : undefined;
  // A single preview follows the open card. An explicitly opened list keeps the timeline on the whole pass.
  const fullList = open === "all" && edits.length > 0;
  const listed = fullList || (!!single && !need && open !== "need" && !!actions.showing && matchesEdit(actions.showing, single));
  // The list of what needs the editor has nothing to show once nothing does.
  useEffect(() => { if (open === "need" && !need && !sentBack) setOpen(undefined); }, [open, need, sentBack]); // eslint-disable-line react-hooks/exhaustive-deps
  // A line mounted with its list already open is the same list, moved with its request between the conversation and
  // the place above the message box. It leaves the timeline where it is, so an edit of another request the editor has
  // open stays open. The list has the timeline back when that edit closes.
  const moved = useRef(fullList);
  useEffect(() => {
    if (!fullList) { moved.current = false; return; }
    actions.listOpen(thread.id, true, moved.current);
    return () => { actions.listOpen(thread.id, false); actions.lightMark(); };
  }, [fullList, thread.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A pass that has only just begun has nothing to sum up yet. Its rows appear with its first calls, or once it is done.
  // Every hook is above this line: the pass's first cuts arriving must not change how many hooks run.
  if (!edits.length && !pass) return null;
  const count = edits.length || pass?.cuts || 0;
  // While Scarlet is still on a pass that has asked about no cut, nothing needs the editor. The block is the pass's
  // stages then: no count of the cuts staged so far, which would sit still between its parts, and nothing to schedule.
  const quiet = !!pass?.running && !pass.calls.length;
  // Every call is made but the pass isn't applied: it applies now or, while Scarlet still checks, when it finishes.
  // Under revision it waits for the revised cut to come back as a call. Before Scarlet has checked any staged cut there
  // is nothing to schedule: its calls haven't arrived. Only its calls hold it: a cut it already applied that asks for a
  // look is kept on its own card, and waits there whether or not the rest of the pass has gone in.
  const waiting = pass && !quiet && !openCalls && !pass.scheduled && !pass.revising && !pass.unchecked;
  const showing = actions.showing, listening = actions.listening;
  const rows = [
    ...edits.flatMap(e => {
      const key = editKey(e);
      const seen = reviewed(e);
      // A folded pass only needs rows that can appear in its call or flagged list.
      if (!listed && (!e.check || seen) && !(open !== "all" && listedNeed.current.has(key))) return [];
      // A revision on its way: the row says so until the new version lands, whether or not the editor had kept the
      // edit. A cut the pass applied through its calls counts as kept, so a guard on that left its row as it was.
      const sent = revising(e);
      // One that came back revised with no reason from Scarlet says so until it is kept, as any other list's row does.
      const revised = e.check === REVISED_CHECK && !seen && !sent;
      // Where it stands, when it isn't simply waiting: the word a row among the calls ends on. In the list of every edit
      // it follows the row's amount, as in any other request's list, and the amount stays.
      const word = sent ? rejecting(e) ? "Rejecting…" : "Revising…" : revised ? REVISED_CHECK : undefined;
      const at = (e as ThreadEdit).at ?? e.range.start;
      const displayAt = (!seen && !sent ? e.reviewRange?.start : undefined) ?? at;
      // Listed with the calls, it has the number it has among them.
      return [{ key, at, displayAt, mark: displayAt as number | undefined, hover: { threadId: thread.id, editKey: key }, label: (e.reason && e.summary) || e.label, n: 0, num: pass?.editNumbers.get(key)?.n,
        state: word, value: editRemoved(e) ?? editRowWord(e), word, revised, rejected: false,
        // Scarlet is on that revision now, so its word moves; one still waiting its turn sits still.
        busy: isWorking(sent),
        needs: !!e.check && !seen && !sent, sentBack: !!e.check && !seen && !!sent,
        // Ticked once the editor has kept it: a flagged edit they reviewed, or any edit they pressed Keep on.
        decided: (!!e.check && seen) || kept.has(reviewKey(e)),
        version: e.previous.length ? e.previous.length + 1 : 0, title: revised || e.reason ? undefined : e.check,
        on: !!showing && matchesEdit(showing, e), open: () => actions.openEdit(thread, e), fresh: fresh.has(e.changeId) }];
    }),
    // A call goes by its number, as on its card and on the timeline.
    ...(pass?.calls ?? []).map(c => ({ key: callRowKey(c), at: c.start, displayAt: c.start, mark: c.at, hover: { threadId: thread.id, call: c.index }, label: c.summary, n: c.n, num: c.n as number | undefined, needs: c.state === "open", sentBack: c.state === "revising",
      decided: c.state === "approved" || c.state === "skipped",
      state: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : c.state === "revising" ? "Revising…" : c.version > 1 ? `v${c.version}` : undefined,
      value: c.state === "approved" ? "Kept" : c.state === "skipped" ? "Rejected" : c.state === "revising" ? "Revising…" : undefined,
      busy: c.state === "revising" && isWorking(c.run?.state),
      version: c.version > 1 ? c.version : 0, title: c.earlier && `v${c.version - 1}: ${c.earlier.reason ?? "Scarlet’s earlier version."}${c.earlier.note ? `\nYou: “${c.earlier.note}”` : ""}`,
      on: listening?.changeId === pass!.change.id && listening.index === c.index, word: undefined, revised: false, rejected: false, fresh: false,
      open: c.state === "revising" ? undefined : () => pass!.openCall(c.index) })),
    // An edit the editor rejected is out of the video. Its row stays where it was in the list of every edit, with a ×
    // where a kept one has its tick and "Rejected" where it said how much it took. A press shows it again: where it was
    // on the timeline, with its note, over the video as it plays without it (2026-11-19).
    ...(listed ? rejected : []).map(e => ({ key: editKey(e), at: e.range.start, displayAt: e.range.start, mark: undefined as number | undefined,
      hover: { threadId: thread.id, editKey: editKey(e) }, label: e.label, n: 0, num: undefined as number | undefined, state: "Rejected" as string | undefined,
      value: "Rejected" as string | undefined, word: undefined as string | undefined, revised: false, rejected: true, busy: false, needs: false, sentBack: false, decided: false, version: 0,
      title: undefined as string | undefined, on: !!showing && (matchesEdit(showing, e) || matchesEdit(e as ThreadEdit, showing)), open: (() => actions.openEdit(thread, e)) as (() => void) | undefined, fresh: false })),
  ].sort((a, b) => a.at - b.at);
  // While the pass waits on the editor, its calls are listed: every one of them, so a call keeps its place once it is
  // decided or sent back, with any edit that asks for a look. N counts only what still waits on the editor.
  const calls = pass ? rows.filter(r => r.n > 0 || r.needs || r.sentBack) : [];
  // The short list keeps each published row in the order it reached the editor. The full list follows the timeline.
  if (pass?.calls.some(c => c.askOrder !== undefined)) calls.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity));
  // With no calls to list, For you lists just the edits that ask for a look: the same rows as the full list, only
  // those. `listedNeed` are the rows listed since it was opened: one the editor keeps stays where it was, ticked,
  // until the list closes, so the list doesn't jump under them.
  const filter = listed ? "all" : calls.length ? "calls" : open !== "all" && need + sentBack > 0 ? "need" : undefined;
  if (filter !== "need") listedNeed.current.clear();
  const shown = filter === "calls" ? calls : filter === "need" ? rows.filter(r => r.needs || r.sentBack || listedNeed.current.has(r.key)) : rows;
  if (filter === "need") for (const row of shown) listedNeed.current.add(row.key);
  // For you opens the first waiting row on the timeline, or leaves it open if the editor is already on one.
  const showNeeded = () => {
    setOpen(undefined);
    if (!rows.some(row => row.on && row.needs)) (calls.length ? calls : rows).find(row => row.needs)?.open?.();
  };
  // What it came to, once Scarlet is done, while calls still wait too: what it applied so far, with the link that opens
  // every edit after it. Until its cuts are applied, a pass that finished with no call to make says how many it proposes.
  const made: SentencePart[] | undefined = edits.length ? working ? undefined : madeSentence(edits, lengthLabel, true)
    : calls.length || quiet ? undefined : [{ strong: plural(count, "cut") }, " proposed."];
  // The list of every edit goes by moments, at the time of the first of its edits. The moment's row stands for all of
  // them: ticked once they're all kept, Revising… while Scarlet is on one, and lit while the moment is open. Its own
  // edits show only once it is unfolded, or while one of them is open on its own, each without a time: they all play
  // in the moment's stretch. For you and the calls stay one edit a row.
  type Row = (typeof rows)[number];
  const momentOf = new Map<string, Moment<Omit<ThreadEdit, "at">>>();
  if (filter === "all") for (const m of moments) if (m.edits.length > 1) for (const e of m.edits) momentOf.set(editKey(e), m);
  const byKey = new Map(rows.map(row => [row.key, row]));
  const drawn: { row: Row; members?: Row[]; more?: string; moment?: string; unfolded?: boolean }[] = [];
  const momentsDrawn = new Set<string>();
  for (const row of shown) {
    const moment = momentOf.get(row.key);
    if (!moment) { drawn.push({ row }); continue; }
    if (momentsDrawn.has(moment.key)) continue;
    momentsDrawn.add(moment.key);
    const members = moment.members.flatMap(e => {
      const member = byKey.get(editKey(e));
      // One of its edits opened on its own from here is that edit alone: Keep and Revise are about it.
      return member ? [{ ...member, on: member.on && !!actions.showingSingle, open: member.open && (() => actions.openEdit(thread, e, undefined, true)) } as Row] : [];
    });
    const main = byKey.get(moment.key) ?? row;
    const others = moment.edits.filter(e => e !== moment.main);
    const sent = members.find(m => m.word === "Revising…" || m.word === "Rejecting…");
    const more = others.length === 1 ? `+ ${(others[0]!.beforeCut ? "cut" : editKindWord(others[0] as ThreadEdit)?.toLowerCase()) ?? "1 edit"}` : `+ ${others.length} edits`;
    drawn.push({ row: { ...main, displayAt: Math.min(...members.map(m => m.displayAt)), on: main.on && !actions.showingSingle,
      decided: members.every(m => m.decided), word: sent?.word ?? main.word, busy: members.some(m => m.busy), revised: members.some(m => m.revised),
      title: members.map(m => m.label).join("\n") } as Row, members, more, moment: moment.key,
      unfolded: unfolded.has(moment.key) || members.some(m => m.on) });
  }
  const placed = new Set(filter ? drawn.flatMap(({ row, members }) => [row.key, ...members?.map(m => m.key) ?? []]) : []);
  const fold = (key: string) => setUnfolded(was => { const next = new Set(was); if (!next.delete(key)) next.add(key); return next; });
  // A list that leads with times widens their column for all its rows once one of them is past an hour ("1:02:07").
  const hours = filter !== "calls" && shown.some(row => clockLabel(row.displayAt).length > 5);
  const rowList = filter && <ol ref={list} className={filter === "calls" ? "simple-pass-list is-short" : hours ? "simple-pass-list has-hours" : "simple-pass-list"}
    aria-label={filter === "calls" ? "Calls that need you" : filter === "need" ? "Edits that need you" : "Every edit"}>
    {drawn.map(({ row, members, more, moment, unfolded: open }) => <li key={row.key}><button type="button" className={[row.on && "is-on", row.rejected && "is-rejected", !row.on && !row.rejected && row.decided && "is-decided"].filter(Boolean).join(" ") || undefined} aria-current={row.on || undefined}
      data-log-control="open-pass-item" data-log-label={moment ? "Moment" : "Pass item"} disabled={!row.open} title={row.title || row.label} onClick={letGo(() => row.open?.())}
      aria-label={more ? `${clockLabel(row.displayAt)} ${row.label}, ${more.replace("+ ", "and ")}` : row.rejected ? `${clockLabel(row.displayAt)} ${row.label}, rejected` : undefined}
      onPointerEnter={() => actions.lightMark(row.mark, row.hover)} onPointerLeave={() => actions.lightMark()}>
      {/* The calls are the short list: a call is its number, Scarlet's note and, once it's settled, sent back or
          revised, a word for where it stands. An edit that asks for a look is listed with them by its number too,
          counted on from the calls, so the list is one run of numbers. The full list keeps each row's time, version
          and amount: the time is bold amber on a tint while the row needs the editor, and a decided row is ticked. */}
      {filter === "calls" && row.num ? <EditBadge n={row.num} check={row.needs} />
        : <span className={row.needs ? "simple-pass-time is-need" : "simple-pass-time"}>{clockLabel(row.displayAt)}{row.needs && <span>, needs you</span>}</span>}
      <span className="simple-pass-label">{filter === "calls" ? row.label : <>{row.rejected && <RejectedMark />}{row.decided && !row.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}<span className="simple-pass-words">{row.label}</span>
        {row.version > 0 && <EditVersion n={row.version} hover={spent.get(row.key)} />}{row.fresh && <small className="edit-version is-new">New</small>}
        {/* What else the moment holds, which unfolds its edits under the row and folds them again. */}
        {more && moment && <span className="simple-pass-more" aria-expanded={!!open} title={open ? "Hide its edits" : "Show its edits"}
          onClick={e => { e.stopPropagation(); fold(moment); }}>{more}</span>}</>}</span>
      {/* The word a row ends on (v2, Kept, Revising…) says on hover what the requests about its cut or edit took:
          their time and tokens, nothing else. The rest of the row keeps the row's own hover. */}
      {filter === "calls" ? row.state && <span className={row.busy ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{row.state}</span>
        : row.value && <span className={row.busy && !row.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(row.key)}>{row.value}</span>}
      {/* An applied edit sent back, or come back revised, says so after its amount, as a row of any other request's
          list does: amber once it is back and waits on the editor, quiet while Scarlet is on it. */}
      {filter !== "calls" && row.word && <span className={`simple-pass-check${row.revised ? "" : " is-kept"}${row.busy ? " working-text" : ""}`} title={spent.get(row.key)}>{row.word}</span>}
    </button>
    {/* Folded, a request about any of the moment's edits sits under the moment's row; unfolded, under its edit's. */}
    {nests.filter(nest => nest.key === row.key || (!open && !!members?.some(m => m.key === nest.key))).map(nest => nest.node)}
    {open && members && <ol className="simple-pass-list is-moment" aria-label="Edits in this moment">
      {members.map(m => <li key={m.key}><button type="button" className={m.on ? "is-on" : m.decided ? "is-decided" : undefined} aria-current={m.on || undefined}
        data-log-control="open-pass-item" data-log-label="Edit in a moment" disabled={!m.open} title={m.title || m.label} onClick={letGo(() => m.open?.())}
        onPointerEnter={() => actions.lightMark(m.mark, m.hover)} onPointerLeave={() => actions.lightMark()}>
        <span className="simple-pass-label">{m.decided && !m.needs && <span className="simple-pass-tick" aria-label="Decided"><Icon name="check" size={10} /></span>}<span className="simple-pass-words">{m.label}</span>
          {m.version > 0 && <EditVersion n={m.version} hover={spent.get(m.key)} />}</span>
        {m.value && <span className={m.busy && !m.word ? "simple-pass-value working-text" : "simple-pass-value"} title={spent.get(m.key)}>{m.value}</span>}
        {m.word && <span className={`simple-pass-check${m.revised ? "" : " is-kept"}${m.busy ? " working-text" : ""}`} title={spent.get(m.key)}>{m.word}</span>}
      </button>{nests.filter(nest => nest.key === m.key && m.key !== row.key).map(nest => nest.node)}</li>)}
    </ol>}</li>)}
  </ol>;
  // The full list includes the pass's calls. A pass with no applied edits has only the calls to show.
  const soFar = (!!working || !!pass?.running) && !made;
  const canSeeAll = edits.length > 0 && (fullList || need < totalRows);
  const hasReview = need > 0 || sentBack > 0 || calls.some(row => row.sentBack);
  const seeProps = { thread, actions, single, count: totalRows, soFar, list: listState, reveal };
  const seeEvery = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="tab" />;
  const tabs = hasReview && <ReviewListTabs need={need} canSeeAll={canSeeAll} list={listState} reveal={reveal} showNeeded={showNeeded} />;
  const outsideList = <>
    {/* A request about a cut or edit whose row isn't listed right now still shows, under what the pass made. */}
    {nests.filter(nest => !placed.has(nest.key)).map(nest => nest.node)}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      {/* The pass goes in once its calls are decided and Scarlet finishes checking. Only a failed apply offers Retry. */}
      {pass?.scheduled && <span className="simple-pass-ok">Goes in when Scarlet finishes</span>}
      {waiting && pass.deciding && <span className="simple-pass-ok">Applying…</span>}
      {waiting && !pass.deciding && !!pass.error && <button type="button" className="simple-link" onClick={pass.apply}>Retry</button>}
      <span className="req-right">{aside}</span>
    </div>
  </>;
  return <div ref={host} className="simple-pass" role="group" aria-label="Dialogue pass">
    {made && <Made parts={made} link={seeEvery} />}
    {filter !== "calls" && outsideList}
    {filter !== "calls" && seeTab}
    {filter && <>{tabs}{rowList}</>}
    {filter === "calls" && outsideList}
    {pass?.error && <p className="simple-error" role="alert">{pass.error}</p>}
  </div>;
}

/**
 * What any other request made, as the rows of its block: one sentence, then a link that opens the edits themselves,
 * numbered as on the timeline. An edit made in several places is one edit. For you counts the flagged edits not yet
 * kept and lists them by default with their own numbers. A request about an edit that is still in the chat (`nests`)
 * sits directly under that edit's row.
 */
function ThreadResult({ projectId, thread, edits, rejected, actions, aside, working, nests = noNests, spent = noSpent, list, listedNeed, wasShowing: heldShowing }: { projectId: string; thread: Thread; edits: Omit<ThreadEdit, "at">[]; rejected?: Omit<ThreadEdit, "at">[]; actions: ChatActions;
  aside?: ReactNode; working?: boolean; nests?: readonly Nest[]; spent?: Spent;
  /** Which list is open and what For you has listed, held by the turn: the block is mounted anew when it moves
   *  between the conversation and the place above the message box, and a list the editor opened must not close then,
   *  nor turn into the list of every edit. `wasShowing` is whether one of the edits was open when the block last drew. */
  list: PassList; listedNeed: RefObject<Set<string>>; wasShowing?: RefObject<boolean> }) {
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  const [open, setOpen] = list;
  const [host, reveal] = useReveal(open);
  // An edit open on the timeline shows in a list: the one that's open, or one that opens with it when none is. For an
  // edit that still waits on the editor that is the For you list, where ↑ and ↓ step to the others that
  // wait, as its card's "1 of N" says. For any other edit it is every edit.
  const showing = actions.showing;
  const shownEdit = showing && edits.find(e => matchesEdit(showing, e));
  const flagged = useMemo(() => edits.filter(e => e.check && !reviewed(e) && !revising(e)), [edits, reviewed, revising]);
  // An edit made in several places is one edit, on one row of the list: For you counts the rows that wait.
  const groups = useMemo(() => editGroups(edits), [edits]);
  const need = useMemo(() => groups.filter(group => group.members.some(m => flagged.includes(m.edit))).length, [groups, flagged]);
  // Every edit waits on the editor: For you already lists them all.
  const allNeed = need > 0 && need === groups.length;
  const single = !working && groups.length === 1 ? shownEdit ?? edits[0] : undefined;
  const showingInList = !!shownEdit && (!single || allNeed);
  // Only an edit the editor has just opened does that. The same edit still open when its request moves between the
  // conversation and the place above the message box, mounted anew, leaves the lists as they were.
  const ownShowing = useRef(false);
  const wasShowing = heldShowing ?? ownShowing;
  useEffect(() => {
    if (showingInList && !wasShowing.current) setOpen(o => shownEdit!.check && !reviewed(shownEdit!) ? o ?? "need" : "all");
    wasShowing.current = showingInList;
  }, [showingInList]); // eslint-disable-line react-hooks/exhaustive-deps
  // One sent back for revision waits on Scarlet, and keeps its row in the list of what needs the editor until it is back.
  const sentBack = useMemo(() => edits.filter(e => e.check && !reviewed(e) && revising(e)).length, [edits, reviewed, revising]);
  // The list of what needs the editor has nothing to show once nothing does.
  useEffect(() => { if (open === "need" && !flagged.length && !sentBack) setOpen(undefined); }, [open, flagged.length, sentBack]); // eslint-disable-line react-hooks/exhaustive-deps
  // The edits that need the editor are listed without a click, until "See all" lists every edit in their place. One the
  // editor keeps stays where it was, ticked, until nothing needs them.
  const needing = open !== "all" && flagged.length + sentBack > 0;
  if (!needing) listedNeed.current.clear();
  const only = needing ? (edit: Omit<ThreadEdit, "at">) => (!!edit.check && !reviewed(edit)) || listedNeed.current.has(editKey(edit)) : undefined;
  if (only) for (const edit of edits) if (only(edit)) listedNeed.current.add(editKey(edit));
  const made = useMemo(() => {
    if (working) return undefined;
    const said = madeSentence(edits, lengthLabel);
    // A request that only flagged an edit another one made has made nothing to say.
    return said.length ? said : undefined;
  }, [working, edits]);
  const showsList = open === "all" || needing || (!!single && !!shownEdit && !allNeed);
  // An edit made in several places is one row, listed when any of its places is picked, and a request about any of
  // them sits under that row: every place of a row the list shows counts as listed, as the list itself picks its rows.
  const listed = new Set(showsList ? groups.filter(group => !only || group.members.some(m => only(m.edit))).flatMap(group => group.members.map(m => editKey(m.edit))) : []);
  const canSeeAll = open === "all" || !allNeed;
  const hasReview = need > 0 || sentBack > 0;
  const seeProps = { thread, actions, single, count: groups.length, soFar: working && !made, list, reveal };
  const seeEvery = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="inline" />;
  const seeTab = !hasReview && canSeeAll && <EditResultLink {...seeProps} place="tab" />;
  const showNeeded = () => {
    setOpen(undefined);
    if (flagged.length && !flagged.some(edit => !!actions.showing && matchesEdit(actions.showing, edit))) actions.openEdit(thread, flagged[0]!);
  };
  return <div ref={host} className="simple-pass" role="group" aria-label="Edits">
    {made && <Made parts={made} link={seeEvery} />}
    <div className="simple-pass-line req-row">
      {!made && seeEvery}
      <span className="req-right">{aside}
        {/* Undo these edits and File this thread have no place in the chat for now. What they reported still shows. */}
        <ThreadAction projectId={projectId} thread={thread} edits={edits} onPlay={ref => actions.openEdit(thread, ref)} menuOnly menu={false} /></span>
    </div>
    {showsList && hasReview && <ReviewListTabs need={need} canSeeAll={canSeeAll} list={list} reveal={reveal} showNeeded={showNeeded} />}
    {seeTab}
    {showsList && <ThreadEdits projectId={projectId} thread={thread} edits={edits} rejected={rejected} showing={actions.showing} only={only}
      onPlay={ref => actions.openEdit(thread, ref)}
      onHover={ref => actions.lightMark(undefined, ref && { threadId: thread.id, editKey: editKey(ref) })}
      under={edit => nests.filter(nest => nest.key === editKey(edit)).map(nest => nest.node)} spent={edit => spent.get(editKey(edit))} />}
    {nests.filter(nest => !listed.has(nest.key)).map(nest => nest.node)}
  </div>;
}

function editRemoved(edit: Omit<ThreadEdit, "at">) {
  return edit.beforeCut ? removedSeconds(edit.beforeCut.removed.end - edit.beforeCut.removed.start) : undefined;
}

/** What a request revises, as the tag on its message and in the message box: "the cut at 2:05" reads "Cut at 2:05". */
const tagOf = (label: string) => { const text = label.replace(/^the /, ""); return text.charAt(0).toUpperCase() + text.slice(1); };

/**
 * Every passage a listen steps over: its own skips, and the cuts beyond it it steps over once the editor plays on. The
 * playhead jumps across each of them, as the picture does, and never glides through one.
 */
const stepsOver = (listen: Audition | undefined) => listen?.beyond?.length ? [...listen.skips, ...listen.beyond] : listen?.skips;
/** The player fills the screen, by the window's own full screen or the page's stand-in for it. Esc leaves that first. */
const inFullScreen = () => !!document.fullscreenElement || !!document.querySelector(".cut-preview[data-expanded]");

/** What a request paused with the project's editing waits for. */
const PAUSED_HINT = "Editing is paused. Resume picks this up where it left off.";

/**
 * One thread's requests. Each is the editor's message, then what Scarlet is doing about it or what it made. The request
 * Scarlet is on now, or the pass waiting on the editor's calls, is `pinned`: it draws above the message box, in
 * `pinHost`, and takes its place in the chat when it's done. A request still waiting its turn isn't here at all; it's in
 * the tray on the message box.
 */
function Turn({ projectId, thread, actions, pinned, pinHost, list: passList, reportReviewMarkers }: { projectId: string; thread: Thread; actions: ChatActions; pinned?: string; pinHost: HTMLElement | null;
  reportReviewMarkers?: ReportReviewMarkers;
  /** Which of this request's lists is open. */
  list: PassList }) {
  const notes = useProjectStore(s => s.current?.notes ?? []);
  // Only this thread's runs: every streamed event replaces the project's map, and this thread rebuilds only for its own.
  const events = useProjectStore(useShallow(s => Object.fromEntries(thread.tasks.flatMap(t => {
    const own = s.current?.taskEvents[t.id];
    return own ? [[t.id, own] as const] : [];
  }))));
  const loadTaskEvents = useProjectStore(s => s.loadTaskEvents);
  const cancelTask = useProjectStore(s => s.cancelTask);
  const editingPaused = useProjectStore(s => s.current?.id === projectId && s.current.project.editingPaused);
  const stopEditing = useProjectStore(s => s.stopEditing);
  const resumeEditing = useProjectStore(s => s.resumeEditing);
  const retryRun = useProjectStore(s => s.retryTask);
  // Retry and Resume run on the model picked now, which may not be the one that failed.
  const { effective } = useAgentAvailability();
  const retryTask = (taskId: string) => retryRun(taskId, effective ?? undefined);
  const continueWhenReady = useProjectStore(s => s.continueWhenReady);
  const allTasks = useProjectStore(s => s.current?.tasks ?? []);
  // The tokens each run reported, while those show (Settings → Usage).
  const showTokens = useUiStore(s => s.showRunTokens);
  const usage = useProjectStore(s => showTokens ? s.current?.taskUsage : undefined);
  // The changes a request about one cut or edit can name, to tell which edit it is across its revisions (`requestTargetKey`).
  const threadChanges = useMemo(() => [...thread.changes, ...thread.flagged ?? []], [thread.changes, thread.flagged]);
  const historyKey = useMemo(() => JSON.stringify(thread.tasks.filter(t => !waitingToStart(t)).map(t => [t.id, runIsActive(t)])), [thread.tasks]);
  useEffect(() => {
    const scopes = useProjectStore.getState().current?.taskEventScopes;
    for (const task of thread.tasks) {
      if (waitingToStart(task)) continue;
      // Live activity and an open question can use tool events. Finished requests keep their conversation and result.
      const scope = runIsActive(task) ? "all" : "conversation";
      if (scopes?.[task.id] !== "all" && scopes?.[task.id] !== scope) void loadTaskEvents(task.id, scope).catch(noop);
    }
  }, [historyKey, loadTaskEvents]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstCuts = useMemo(() => firstCutDeliveries(thread), [thread]);
  // A request's list is read again for each new working cut only while it is used: in the chat's view, above the
  // message box, open, on the timeline, or carrying an edit that asks for a look, which the timeline marks from this
  // list. Out of view it keeps its last list until it comes back.
  const section = useRef<HTMLElement>(null);
  const inView = useNearView(section, ".simple-chat");
  const asksForALook = useRef(false);
  const { listed, rejected, located, head } = useThreadEdits(projectId, thread, inView || !!passList[0] || actions.marked === thread.id
    || (!!pinned && thread.tasks.some(t => t.id === pinned)) || (!!reportReviewMarkers && asksForALook.current));
  asksForALook.current = listed.some(edit => !!edit.check);
  const reviewed = useReviewed(projectId, thread);
  const revising = useRevising(thread);
  useEffect(() => {
    if (!reportReviewMarkers || !located) return;
    const waiting = located.filter(edit => edit.check && !reviewed(edit) && !revising(edit));
    if (!waiting.length) return;
    const numbers = new Map(editGroups(located).flatMap(({ members }) => members.map(({ edit }) => [edit, members[0]!.i + 1] as const)));
    const markers = waiting.map(edit => ({ edit, number: numbers.get(edit)!, total: located.length }));
    reportReviewMarkers(thread.id, { head, markers });
    return () => reportReviewMarkers(thread.id);
  }, [thread.id, head, located, reviewed, revising, reportReviewMarkers]);
  // A thread with a dialogue pass sums it up on one line instead of listing every cut.
  const waitingPass = openPass(thread, allTasks);
  const pendingPass = !!waitingPass;
  const passTasks = useMemo(() => new Set([...firstCuts.keys()]), [firstCuts]);
  const summed = passTasks.size > 0 || pendingPass;
  const { entries } = useMemo(() => threadConversation(thread, notesStillAsked(notes, allTasks), events, firstCuts), [thread, notes, allTasks, events, firstCuts]);
  // Why a press on one of this thread's requests failed (Stop, Resume, Retry), and which request. The line is that
  // request's own: it reads at the end of its block and goes where the block goes, above the message box too.
  const [failed, setFailed] = useState<{ run: string; text: string }>();
  // The calls listed in the pass's open list. Held here and not on the pass's line: a request that moves between the
  // conversation and the place above the message box is mounted anew, and a list the editor opened must not close by
  // itself then. Which list is open is held by the workspace, for the same reason.
  const passListed = useRef(new Set<string>());
  // Whether one of the request's edits was open when its line last drew.
  const wasShowing = useRef(false);
  // Edits saved along the way belong to their run. Only the run's last edit is a result to Play, Revise or Undo.
  const { finals, folded } = useMemo(() => {
    const finals = new Map<string, Change | undefined>();
    const folded = new Set<string>();
    for (const t of thread.tasks) {
      const own = thread.changes.filter(c => c.taskId === t.id || t.changeIds.includes(c.id));
      const final = runIsActive(t) ? undefined : own.at(-1);
      finals.set(t.id, final);
      for (const c of own) if (c !== final && c.state !== "ready") folded.add(c.id);
    }
    // A proposal whose revision already arrived isn't still "being revised". The revision below replaces it.
    for (const c of thread.changes) {
      if (c.state === "revising" && thread.changes.some(r => r.taskId && thread.tasks.some(t => t.id === r.taskId && t.context.changeId === c.id)))
        folded.add(c.id);
    }
    return { finals, folded };
  }, [thread]);
  const runs = useMemo(() => threadRuns(thread), [thread]);
  const runOf = new Map(runs.flatMap(run => run.attempts.map(t => [t.id, run] as const)));
  // The rules this thread's requests taught Scarlet that still wait on the editor's call.
  const learned = useProjectStore(useShallow(s => (s.current?.learnings ?? []).filter(l => l.state === "suggested" && runOf.has(l.taskId))));
  // The thread's edits list on the card of the run that made them: the dialogue pass, else the first request. A
  // request about one cut never holds the pass: when its revision is the latest proposal, the pass stays on the card
  // of the request that asked for it, and the revision's card says what it did to its cut.
  const owner = runs.find(run => run.attempts.some(t => passTasks.has(t.id)))
    ?? (pendingPass ? runs.find(run => !aboutOne(run) && run.attempts.some(t => t.id === waitingPass?.taskId)) ?? runs.find(run => !aboutOne(run)) : undefined)
    ?? runs[0];
  const hasRows = summed ? listed.length > 0 || actions.pass?.threadId === thread.id : listed.length > 0;
  // With no line for the pass (it was thrown away), its list is closed: a pass staged again starts folded. A pass that
  // went in leaves the thread's edits, and the list of those still waiting on the editor stays open: their place in
  // the chat must not go with the calls (2026-11-16).
  const passLine = summed && hasRows;
  useEffect(() => { if (!passLine) passList[1](open => open === "need" && hasRows ? open : undefined); }, [passLine]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each press starts clean: the last failure's line doesn't stay under a request once the same action works.
  const attempt = (run: string, job: Promise<unknown>) => { setFailed(undefined); void job.catch(e => setFailed({ run, text: errorMessage(e) })); };
  // Nor once the request has moved on by itself: a Stop refused because the run had just ended has nothing left to press.
  const runStates = thread.tasks.map(t => `${t.id}:${t.state}`).join();
  useEffect(() => setFailed(undefined), [runStates]);

  /** Something that belongs to no run: a note left on a change, a decision the engine recorded. Part of the request's own conversation. */
  const loose = (entry: ThreadEntry, i: number) => {
    switch (entry.kind) {
      // The editor's words keep to two lines, as a request's do, and a click opens the rest.
      case "request":
        return <div key={i} className="simple-msg from-you"><span className="simple-who">You</span>
          {entry.revisionLabel && <span className="simple-revising">{tagOf(tagFor(entry) ?? entry.revisionLabel)}</span>}<Said text={entry.text} /></div>;
      case "answer":
        return <div key={i} className="simple-msg from-you"><span className="simple-who">You</span><Said text={entry.text} /></div>;
      case "agent":
        return <div key={i} className="simple-msg from-scarlet"><span className="simple-who">Scarlet</span><Said text={entry.fullText ?? entry.text} /></div>;
      case "change":
        // An applied change with no request behind it says what it did once: in the sentence over its edits.
        if (entry.change.state === "approved" && hasRows) return null;
        return <ChangeReply key={i} thread={thread} entry={entry} actions={actions} />;
      case "system":
        return <div key={i} className={`simple-note${entry.tone === "bad" ? " is-bad" : ""}`}>{entry.text}</div>;
      default:
        return null;
    }
  };

  // A request's tag names its edit as the list does: the engine's list knows where each edit sits in the cut now.
  const tagFor = (entry: ThreadEntry) => {
    const asked = entry.taskId ? thread.tasks.find(t => t.id === entry.taskId) : undefined;
    return asked && revisionTarget(asked, thread.changes, listed);
  };
  // The one cut or edit each request was about.
  const targets = new Map(runs.map(run => [run.root, run !== owner ? requestTarget(aimOf(run), finals.get(run.task.id), thread.changes, listed, thread.tasks) : undefined] as const));

  // The cut or edit a request is about, as its row's key, whether or not that row is listed now: an applied edit, or a
  // call of the pass that waits.
  const subject = (run: Run) => {
    const target = targets.get(run.root);
    if (target?.edit) return editKey(target.edit);
    return target?.call !== undefined && target.changeId === waitingPass?.id ? `call/${target.call}` : undefined;
  };
  // A request that stopped early is overtaken once Scarlet has begun a later request about the same cut or edit, or the
  // pass it was a call of has been applied or put away. Picking it up again would then work on something already asked
  // again or settled. A call on its cut alone doesn't take it away: nothing records when a call was made, so one made
  // before the cut was sent back reads the same as one made since, and a revision of an approved cut that couldn't
  // finish would leave without a word (2026-11-09).
  const overtaken = (run: Run) => {
    const { cutIndex } = aimOf(run).context, about = subject(run), aim = requestTargetKey(aimOf(run), threadChanges);
    const later = runs.some(other => other !== run && other !== owner && aboutOne(other) && ts(other.attempts[0]!.createdAt) > ts(run.task.createdAt)
      && ((!!about && subject(other) === about) || (!!aim && requestTargetKey(aimOf(other), threadChanges) === aim)));
    if (later || cutIndex === undefined) return later;
    const target = targets.get(run.root);
    if (target?.edit) return true;
    const version = target?.call !== undefined ? thread.changes.find(c => c.id === target.changeId) : undefined;
    return !!version && (version.state === "approved" || (version.state === "rejected" && !version.replacedBy));
  };

  // A request about one cut or edit leaves the conversation once it's done: what it did is on that cut or edit, in its
  // list and on its card. One that stopped early, or left a suggestion to play, stays with its one action. So does one
  // that changed nothing and said why, or whose new version couldn't be prepared: Scarlet's words are the only place
  // that says so. One that stopped early leaves once it is overtaken: left there it would have no action to offer.
  const settled = (run: Run) => {
    if (run === owner || !aboutOne(run) || pinned === run.root) return false;
    if (run.task.state === "cancelled" || run.task.state === "failed") return overtaken(run);
    // One paused for its transcripts ended as done, and stopped early all the same: it stays, with its way to finish.
    if (run.task.state !== "done" || !!runEnded(run.task) || !targets.get(run.root)) return false;
    const final = finals.get(run.task.id);
    // Done with no change and not a word from Scarlet: there is nothing for it to say by staying.
    if (!final) return !entries.some(e => (e.kind === "agent" || e.kind === "question" || e.kind === "system") && !!e.taskId && run.attempts.some(t => t.id === e.taskId));
    // A version that couldn't be prepared changed nothing either, and only Scarlet's words here say so. Nor has a
    // suggestion Scarlet is to make again changed anything yet: the request stays to say so while that redo waits.
    if (final.state === "failed" || thread.tasks.some(t => isRedo(t) && runIsActive(t) && t.context.changeId === final.id)) return false;
    return !(final.state === "ready" && !isOpenPass(final, allTasks));
  };
  // While such a request is still in the chat it sits inside the block that lists its cut or edit, directly under that
  // row: this is the row's key for each. With nothing listed, or no row for it, it keeps a block of its own.
  const rowOf = (run: Run) => {
    const target = targets.get(run.root);
    if (target?.edit) return editKey(target.edit);
    const open = actions.pass?.threadId === thread.id ? actions.pass : undefined;
    const call = open?.calls.find(c => !!c.run && run.attempts.some(t => t.id === c.run!.id))
      ?? (target?.call !== undefined && target.changeId === open?.change.id ? open?.calls.find(c => c.index === target.call) : undefined);
    return call && callRowKey(call);
  };
  const nested = new Map(owner && hasRows ? runs.flatMap(run => {
    const key = run !== owner && aboutOne(run) && !settled(run) ? rowOf(run) : undefined;
    return key ? [[run.root, key] as const] : [];
  }) : []);
  // What the requests about each listed cut or edit took: their active time and, when those show, tokens. A request
  // about one cut or edit leaves the chat once it's done, and its figures went with it; the word its row ends on
  // (v2, Kept, Revising…) says them on hover.
  const spent = new Map<string, string>();
  if (owner && hasRows) {
    const about = new Map<string, Task[]>();
    for (const run of runs) {
      const key = run !== owner && aboutOne(run) ? rowOf(run) : undefined;
      if (key) about.set(key, [...about.get(key) ?? [], ...run.attempts]);
    }
    for (const [key, attempts] of about) { const took = spentLabel(attempts, events, usage); if (took) spent.set(key, took); }
  }
  // A rule reads at the end of the block of the request it came from. A request about one cut or edit that has left the
  // chat, or sits under its row inside another block, hands its rule to the block it belongs to.
  const learnedIn = (run: Run) => learned.filter(l => {
    const from = runOf.get(l.taskId)!;
    return from === run || (run === owner && (settled(from) || nested.has(from.root)));
  });

  const unit = (run: Run, inside = false): ReactElement => {
    const { task } = run;
    const ids = new Set(run.attempts.map(t => t.id));
    const mine = entries.filter(e => !!e.taskId && ids.has(e.taskId) && !(e.kind === "change" && folded.has(e.change.id)));
    const request = mine.find((e): e is Extract<ThreadEntry, { kind: "request" }> => e.kind === "request");
    // Scarlet's words for the editor: its reply, a question and the answer it got, a suggestion to play, why it stopped.
    const said: ReactNode[] = [];
    // Whether those words say what the request came to: a reply, or a suggestion to play.
    let told = false;
    // A suggestion of this request's is waiting to be played: its heading says so.
    let proposing = false;
    let recovery: { label: string; run(): void } | undefined;
    // While Scarlet is on a request about one cut or edit, the request shows its work and not what Scarlet wrote about
    // it: that reads on the cut or edit once it lands, and the request then leaves. Scarlet's redo of the request's
    // suggestion is the exception: nothing lands to say why the request is at work again, so its one line stays.
    const quiet = run !== owner && aboutOne(run) && runIsActive(task) && !isRedo(task);
    // Scarlet answers the editor's note and then closes the request, mostly in the same words. The closing message is
    // the reply; what it wrote on the note shows only while there is no other.
    const closed = entries.some(e => e.kind === "agent" && !e.onNote && ids.has((e.taskId ?? e.replyTo)!));
    // While every edit is listed, the list takes the place of Scarlet's reply; putting it away brings the reply back. The
    // short list of what needs the editor, shown without a click, leaves the reply where it is.
    const listing = run === owner && hasRows && passList[0] === "all";
    mine.forEach((e, i) => {
      // All of what Scarlet said: folded it keeps to two lines, and a click opens the rest.
      if (e.kind === "agent") { if (!quiet && !(e.onNote && closed)) { told = true; if (!listing) said.push(<Said key={i} className="req-say" text={e.fullText ?? e.text} />); } }
      else if (e.kind === "question") said.push(<p key={i} className={e.answered ? "req-say is-quiet" : "req-say"}>{e.text}
        {!e.answered && <button type="button" className="simple-link is-warn" onClick={() => actions.reply(thread)}>Answer</button>}</p>);
      // The editor's answer is their message: two lines at most, and a click opens the rest.
      else if (e.kind === "answer") said.push(<Said key={i} className="req-say is-yours" text={e.text} />);
      // An applied change is on the card's last row. A suggestion still says what it is and how to play it. A pass's
      // own proposals are its line, except a suggestion it left that isn't cuts to call: nothing else would show it.
      else if (e.kind === "change" && e.change.state !== "approved" && !isOpenPass(e.change, allTasks)
          && (!passTasks.has(e.taskId!) || (e.change.state === "ready" && !e.change.cutReasons?.length))) {
        told = true;
        if (waitsToPlay(e.change, thread) && !isDialoguePass(e.change)) proposing = true;
        // A pass's closing message is its reply, so its suggestion goes by what it changes.
        said.push(<ChangeReply key={i} thread={thread} entry={passTasks.has(e.taskId!) ? { ...e, text: e.change.description } : e} actions={actions} />);
      }
      // A finished pass whose closing check couldn't run: the pass stands, and the line says just that, with Retry after it.
      else if (e.kind === "system" && e.taskId === task.id && closingCheckFailed(task)) {
        const action = e.action;
        said.push(<p key={i} className="req-say is-note">{e.text}
          {action && <button type="button" className="simple-link req-recover" onClick={() => attempt(run.root, retryTask(action.taskId))}>Retry</button>}</p>);
      }
      else if (e.kind === "system" && e.taskId === task.id) {
        // The card's own row says it stopped or couldn't finish; only a specific reason adds to that.
        if (!/^(?:Edit stopped\.|Edit resumed\.|I couldn’t finish this edit\.)$/.test(e.text)) said.push(<p key={i} className={`req-say is-note${e.tone === "bad" ? " is-bad" : ""}`}>{e.text}</p>);
        const action = e.action;
        // Asked again since, and done: picking the old one up would do the same work a second time. The same words
        // about another cut or edit were other work, and leave this one to pick up.
        const redone = allTasks.some(t => t.state === "done" && Date.parse(t.createdAt ?? "") > Date.parse(task.createdAt ?? "") && requestText(t) === requestText(task)
          && requestTargetKey(t, threadChanges) === requestTargetKey(task, threadChanges));
        if (action && !redone) recovery = { label: action.label === "Resume agent" ? "Resume" : "Retry", run: () => attempt(run.root, retryTask(action.taskId)) };
      }
    });
    const final = finals.get(task.id);
    // The requests about one of this block's cuts or edits, each drawn under its row.
    const nests: Nest[] = !inside && run === owner ? [...nested].map(([root, key]) => ({ key, node: unit(runs.find(r => r.root === root)!, true) })) : [];
    const rows = run === owner && hasRows ? (aside: ReactNode) => summed
      ? <PassSummary projectId={projectId} thread={thread} edits={listed} rejected={rejected} actions={actions} aside={aside} list={passList} listedNeed={passListed} working={runIsActive(task)} nests={nests} spent={spent} />
      : <ThreadResult projectId={projectId} thread={thread} edits={listed} rejected={rejected} actions={actions} aside={aside} working={runIsActive(task)} nests={nests} spent={spent} list={passList} listedNeed={passListed} wasShowing={wasShowing} /> : undefined;
    // A request about one cut or edit says what it did there, and its row opens that cut or edit on the timeline.
    const target = targets.get(run.root);
    const pass = actions.pass?.threadId === thread.id ? actions.pass : undefined;
    const call = target && !target.edit && pass?.change.id === target.changeId
      ? pass!.calls.find(c => c.index === target.call && c.state !== "revising") : undefined;
    const aimed = target?.edit;
    // The same edit can be open from the list on the request that made it. Then this card isn't the one that's open.
    const showingIt = aimed ? actions.showingFrom === run.root && !!actions.showing && matchesEdit(actions.showing, aimed)
      : !!call && actions.listening?.changeId === pass!.change.id && actions.listening.index === call.index;
    const open = aimed ? () => actions.openEdit(thread, aimed, run.root) : call ? () => pass!.openCall(call.index)
      : final?.state === "approved" && run !== owner ? () => actions.play(thread, final) : undefined;
    // The block holds the place above the message box while Scarlet is on it, or on a request drawn inside it.
    const isPinned = !inside && (pinned === run.root || (!!pinned && nests.length > 0 && nested.has(pinned)));
    // The heading is the editor's words, with no name or number: "Edit 14" anywhere is an edit Scarlet made. A request
    // about one cut or edit says which before its words, in the tag the message box showed: "Cut 2" for a call, by its
    // time otherwise. A request about a whole edit says which the same way.
    const tag = request?.revisionLabel ? tagOf(tagFor(request) ?? request.revisionLabel) : undefined;
    const about = aboutOne(run) ? actions.cutName?.(aimOf(run).context) ?? tag : undefined;
    // Where the request stands, at the right of its heading: a dot while Scarlet asks, a word once it stopped early or
    // left a suggestion, and Paused while editing waits for Resume. The review count appears on For you.
    const ended = runEnded(task);
    const editsProject = isProjectEditTask(task);
    const paused = editingPaused && editsProject && task.state === "queued";
    const stands = runIsActive(task) ? task.state === "waiting_for_user" ? <span className="unit-dot" aria-hidden />
        : paused ? <span className="unit-word" title={PAUSED_HINT}>Paused</span> : null
      : ended ? <span className="unit-word">{ended.replace(/ · .*$/, "")}</span> : proposing ? <span className="unit-word">Suggestion</span> : null;
    // Scarlet works on several cuts or edits at once, an agent on each. The block that holds one of them says how many
    // there are, in the heading's place for where a request stands: each has its own row, and some may be out of view.
    const atOnce = actions.atOnce ?? 0;
    const among = !inside && atOnce > 1 && [run, ...(run === owner ? runs.filter(r => nested.has(r.root)) : [])]
      .some(r => aboutOne(r) && isWorking(r.task.state));
    const standing = stands ?? (among ? <span className="unit-word" title={`Scarlet is working on ${atOnce} cuts or edits at the same time.`}>Working on {atOnce} at once</span> : null);
    const stop = runIsActive(task) && !(waitingToStart(task) && run.root === task.id) ? () => attempt(run.root, cancelTask(task.id)) : undefined;
    // A request that edits the video has its controls at the band's right for as long as Scarlet has it: Pause, which
    // holds all editing in the project, then Resume once it is paused, which picks the paused work up first; and Stop,
    // which ends just this one, paused or not. Each is an icon alone, named the moment the pointer rests on it.
    const hold = editingPaused ? () => attempt(run.root, resumeEditing(projectId)) : () => attempt(run.root, stopEditing(projectId));
    const editActions = editsProject && stop ?
      <div className="unit-actions">
        <TipButton className="unit-pause-edit" tip={editingPaused ? "Resume editing" : "Pause editing"}
          aria-description={editingPaused ? "Paused work picks up first, where it left off."
            : "All editing in this project stops. Nothing new starts, and edits already made stay."}
          onClick={hold}><Icon name={editingPaused ? "play" : "pause"} size={13} /></TipButton>
        <TipButton className="unit-stop-edit" tip="Stop this edit" aria-label={request ? `Stop this edit: ${request.text}` : "Stop this edit"}
          aria-description="What it already changed stays, and the next request can start." onClick={stop}><Icon name="stop" size={13} /></TipButton></div> : undefined;
    const requestControl = editsProject ? editActions : stop && <button type="button" className="simple-link unit-stop" onClick={stop}>Stop</button>;
    const headingEnd = <><RequestMetrics attempts={run.attempts} events={events} />{requestControl}</>;
    const bundle = <RunBundle task={task} events={events[task.id] ?? []} changes={thread.changes} finalChange={final} banded={!!request} callNumber={actions.callNumber}
        say={said.length ? <div className="req-said">{said}</div> : undefined} told={told} result={rows} recovery={recovery}
        // Under its call's row, that row is the cut it saved, with Scarlet's note: the note isn't said again under it.
        // A pass's calls are listed for as long as it waits, so a request keyed to one is always under its row.
        summary={target?.note} listedAbove={inside && !!nested.get(run.root)?.startsWith("call/")} showing={showingIt} onOpen={proposing ? undefined : open}
        // Scarlet's own requests have no heading. Their menu stays with the active run's row.
        actions={request ? undefined : editActions} onStop={request || editsProject ? undefined : stop} paused={paused}
        // Only the thread's last run can be finished, and not while another request in it is under way.
        {...(task === thread.tasks.at(-1) && !thread.active && !thread.question && {
          onResume: () => attempt(run.root, retryTask(task.id)),
          onWaitForTranscripts: (on: boolean) => attempt(run.root, continueWhenReady(task.id, on)),
        })} />;
    const wrong = failed?.run === run.root && <p className="simple-error unit-error" role="alert">{failed.text}</p>;
    // Inside another request's block, under the row it is about: its tag and the editor's words, with where it stands
    // at their right, as in a block's heading, and its work. Under its row the row names it, and the tag is hidden.
    if (inside) return <div key={run.root} className="subunit" data-run={run.root}>
      {request && <div className="subunit-msg"><span className="simple-who">You</span>
        <Said lead={<span className="simple-revising">{about ?? "Revision"}</span>} text={request.text} /><span className="unit-state">{standing}</span>{headingEnd}</div>}
      {bundle}
      {wrong}
    </div>;
    // A press on any request's band shows the whole timeline. On the band of a request that applied edits it also puts
    // them on the timeline; its band is a shade lighter while they are the ones marked. Its links and Stop keep their
    // own presses.
    const markable = !!actions.mark && thread.changes.some(c => c.state === "approved");
    const marked = markable && actions.marked === thread.id;
    const pressable = markable || !!actions.fitTimeline;
    const block = <div key={run.root} className="unit" data-run={run.root} data-pinned={isPinned || undefined}>
      {request && <div className={`unit-msg${pressable ? " is-markable" : ""}${marked ? " is-marked" : ""}`}
        aria-current={marked || undefined} onClick={pressable ? e => {
          // A press on long words opens or folds them, and leaves the timeline as it is.
          if ((e.target as Element).closest('button, a, input, textarea, [role="menu"], .said.is-clipped, .said.is-open') || window.getSelection()?.toString()) return;
          if (markable) actions.mark!(thread.id);
          actions.fitTimeline?.();
        } : undefined}><span className="simple-who">You</span>
        <Said lead={<>{(about ?? tag) && <span className="simple-revising">{about ?? tag}</span>}<MarkedFrameOnRequest projectId={projectId} task={task} /></>} text={request.text} />
        <span className="unit-state">{standing}</span>{headingEnd}</div>}
      {bundle}
      {learnedIn(run).map(l => <LearnedLine key={l.id} learning={l} onReview={actions.reviewLearning} />)}
      {wrong}
    </div>;
    // Scarlet's closing words on what it applied read under the block and go where it goes: above the message box
    // with it, and out of the chat with a request about one cut or edit that has left. The open list takes their place.
    const replies = listing ? [] : entries.flatMap((e, i) => closingReply(e) && ids.has(e.replyTo!) ? [loose(e, i)] : []);
    // Always the same shape, so the block isn't mounted anew when its replies give way to its list and come back.
    const node = <Fragment key={run.root}>{block}{replies}</Fragment>;
    return isPinned && pinHost ? createPortal(node, pinHost, run.root) : node;
  };
  const placed = new Set<string>();
  const nodes = entries.flatMap((item, i) => {
    if (item.kind === "change" && folded.has(item.change.id)) return [];
    const run = item.taskId ? runOf.get(item.taskId) : undefined;
    if (run) {
      if (placed.has(run.root)) return [];
      placed.add(run.root);
      return settled(run) || nested.has(run.root) ? [] : [unit(run)];
    }
    // A closing reply is drawn with the request it answers.
    if (closingReply(item) && runOf.has(item.replyTo!)) return [];
    // An applied edit no request made is said once, by the sentence that lists it below, with its link (2026-11-14:
    // "Put the camera in the bottom-right corner" read twice).
    if (!owner && hasRows && item.kind === "change" && item.change.state === "approved") return [];
    // What a queued request says is in the tray.
    return item.taskId ? [] : [loose(item, i)];
  });
  // A run that has said nothing yet still shows.
  for (const run of runs) if (!placed.has(run.root) && !settled(run) && !nested.has(run.root)) nodes.push(unit(run));
  // Edits with no request behind them, such as an older change, still list in a card of their own.
  if (!owner && hasRows) nodes.push(<div key="edits" className="req">{summed
    ? <PassSummary projectId={projectId} thread={thread} edits={listed} rejected={rejected} actions={actions} list={passList} listedNeed={passListed} />
    : <ThreadResult projectId={projectId} thread={thread} edits={listed} rejected={rejected} actions={actions} list={passList} listedNeed={passListed} />}</div>);
  return <section ref={section} className="simple-turn" data-log-label="Edit thread" aria-label={thread.title} data-thread={thread.id}>
    {nodes}
  </section>;
}

/** Track a new edit's point in the message box without rebuilding the rest of the conversation on each pick. */
function WorkspaceComposer({ newEdit, playerVersion, mediaId, ...props }: ComponentProps<typeof Composer> & {
  newEdit: boolean; playerVersion?: string; mediaId?: string;
}) {
  const point = useUiStore(s => newEdit ? pointOf(s.agentContext) : undefined);
  const written = useUiStore(s => !!point && !!s.agentDraft.trim());
  const speaking = useUiStore(s => !!point && s.speaking);
  // Leave a picked moment behind when playback or a seek takes the editor away. Once a message is being
  // written or recorded, its explicit target stays with it. N can attach while the player's pause is settling.
  // Before publishes the clock for a keyboard seek as its clip commits. Check after those layout effects.
  useEffect(() => {
    if (!point || written || speaking) return;
    const release = () => {
      const box = useUiStore.getState();
      if (box.agentContext === point && !box.agentDraft.trim() && !box.speaking) box.setAgentContext(null);
    };
    const moved = (time: number) => Math.abs(time - point.time) >= .1;
    if (point.version !== playerVersion || point.mediaId !== mediaId || moved(usePlayerStore.getState().time)) {
      release();
      return;
    }
    return usePlayerStore.subscribe((now, was) => {
      if ((now.playing && !was.playing) || moved(now.time)) release();
    });
  }, [point, written, speaking, playerVersion, mediaId]);
  const pointTag = point && !point.fromMessage ? `At ${clockLabel(point.time)}` : undefined;
  return <Composer {...props} targetTag={props.targetTag ?? pointTag} targetIsPoint={!props.targetTag && !!pointTag} />;
}

/**
 * The workspace: speak or type an edit, then watch each change with Before and After.
 * Every request is in one conversation, oldest first. The player on the right shows whatever the chat points at.
 */
export function SimpleWorkspace() {
  const current = useProjectStore(useShallow(s => {
    if (!s.current) return null;
    const { id, project, changes, tasks, notes, timeline, media, renderSettingsRevision, reviewStatus, reviewError, headError } = s.current;
    return { id, project, changes, tasks, notes, timeline, media, renderSettingsRevision, reviewStatus, reviewError, headError };
  }))!;
  const { changes, tasks, notes, media } = current;
  // While the videos cache, an empty chat says the editor needn't wait for it to finish.
  const caching = useVideoCaching().active;
  // The working cut on screen. While the video plays, the saves a pass makes under it wait until it stops.
  const { head, timeline } = useShownCut();
  const fps = current.project.settings.fps;
  const approve = useProjectStore(s => s.approve);
  const setupOpen = useUiStore(s => s.agentSetupOpen);
  const openDraft = useUiStore(s => s.openDraft);
  const uploads = useUploader(current.id);
  const importing = useImportCount(current.id);
  const importFailed = uploads.items.some(item => item.state === "error");
  // What the menu is marked for: a rule to review in Learnings. Media, Export and Model mark their own header buttons.
  const toLearn = useProjectStore(s => learningsToReview(s.current?.learnings));
  const { notice, local } = useImportTranscription();
  // A new project opens on Media, arriving as ?panel=media. It is read once and taken off the address, so a reload
  // or the way back doesn't open the drawer again.
  const [search, setSearch] = useSearchParams();
  // The rule a line in the chat opened Learnings at.
  const [learnFocus, setLearnFocus] = useState<string>();
  const [panel, setPanel] = useState<Panel>(() => (search.get("panel") === "media" ? "media" : null));
  // The cut, edit or call that was open when Scarlet last closed arrives the same way, as ?open=, and is read once too.
  const [reopen, setReopen] = useState(() => search.get("open") ?? undefined);
  useEffect(() => {
    if (!search.has("panel") && !search.has("open")) return;
    const rest = new URLSearchParams(search);
    rest.delete("panel");
    rest.delete("open");
    setSearch(rest, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // What Scarlet opens again by itself at launch doesn't start playing: its card comes back with the video paused on
  // it, as if the editor had paused there. Anything the editor then does opens and plays as ever.
  const quietOpen = useRef(false);
  useEffect(() => {
    const byEditor = () => { quietOpen.current = false; };
    window.addEventListener("pointerdown", byEditor, true);
    window.addEventListener("keydown", byEditor, true);
    return () => { window.removeEventListener("pointerdown", byEditor, true); window.removeEventListener("keydown", byEditor, true); };
  }, []);

  const threads = useMemo(() => {
    // A retry taken out of line before it began still belongs to its request, which then says it stopped.
    const again = laterAttempts(tasks);
    return buildThreads({ changes, tasks: tasks.filter(t => !takenFromQueue(t) || again.has(t.id)), notes: notesStillAsked(notes, tasks) });
  }, [changes, tasks, notes]);
  const ordered = useMemo(() => [...threads].sort((a, b) => ts(a.createdAt) - ts(b.createdAt)), [threads]);
  // An edit applied while the editor watches arrives on the timeline with a moment. One applied before the project opened
  // arrives quietly: a change counts as just applied when it was seen waiting first, or turned up applied once the
  // project's own changes were in. The clock starts once the history is read: on a slow open the changes arrive long
  // after the project mounted, and every one there then was applied before it opened.
  const landing = useRef<{ opened: number; states: Map<string, string>; at: Map<string, number> }>(undefined);
  if (!current.reviewStatus) landing.current ??= { opened: Date.now(), states: new Map(changes.map(c => [c.id, c.state])), at: new Map() };
  if (landing.current) for (const change of changes) {
    const was = landing.current.states.get(change.id);
    if (change.state === "approved" && was !== "approved" && (was !== undefined || Date.now() - landing.current.opened > LANDING_SETTLES)
      && !landing.current.at.has(change.id)) landing.current.at.set(change.id, Date.now());
    landing.current.states.set(change.id, change.state);
  }
  const justLanded = (changeId: string) => Date.now() - (landing.current?.at.get(changeId) ?? -Infinity) < LANDING_SHOWS;
  // Once its moment is over the marker is drawn as any other, so a zoom that draws it again doesn't play the moment twice.
  const landingEnds = Math.max(0, ...landing.current?.at.values() ?? []) + LANDING_SHOWS;
  const [, endLanding] = useState(0);
  useEffect(() => {
    const left = landingEnds - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => endLanding(n => n + 1), left + 50);
    return () => window.clearTimeout(timer);
  }, [landingEnds]);

  // The request Scarlet is asking about: the question at the front of the line. With no cut or edit open, the next
  // message answers it.
  const asking = tasks.find(t => t.kind !== "transcribe" && t.state === "waiting_for_user");
  const askThread = asking && threads.find(t => t.question?.id === asking.id);
  // Opening an edit clears what the message box was aimed at, also when it is the edit already open. This asks for the
  // box to be aimed at what's open again.
  const [aimAgain, setAimAgain] = useState(0);
  // The request the editor went to, and an edit of it waiting to play once its markers load.
  const [focus, setFocus] = useState<{ threadId: string; changeId?: string; spot?: number; single?: boolean }>();
  // The list each request has open in the chat: every edit, or just the ones that need the editor. ↑ and ↓ read it.
  const [lists, setLists] = useState<Record<string, OpenList>>({});
  // One list of every edit is open at a time, so two "Hide" links never stand for one timeline: opening another
  // request's closes it. The list of what needs the editor is a review list, and leaves the others as they are.
  const listOf = (threadId: string): PassList => [lists[threadId], next => setLists(all => {
    const open = typeof next === "function" ? next(all[threadId]) : next;
    if (open === all[threadId]) return all;
    const others = open !== "all" ? all : Object.fromEntries(Object.entries(all).filter(([, list]) => list !== "all"));
    return { ...others, [threadId]: open };
  })];
  // The pass whose full list is open in the chat, and the row the pointer is over there.
  const [openList, setOpenList] = useState<string>();
  // The request whose own row opened an edit, and which edit. Moving to another edit leaves it behind.
  const [openedFrom, setOpenedFrom] = useState<{ run: string; ref: EditRef }>();
  const [hoveredEdit] = useState(() => createStore<number | undefined>(() => undefined));
  const [hoveredRow] = useState(() => createStore<HoveredReviewRow | undefined>(() => undefined));
  // The request whose band the editor pressed in the chat, to see its edits on the timeline. The latest request takes the
  // timeline back when it is new or applies an edit. A second press on the marked band takes its edits off (null), and
  // then no request's edits are marked until the editor presses a band or the latest request moves on.
  const [picked, setPicked] = useState<string | null>();
  // Counts the presses on a band, each of which shows the whole timeline.
  const [fitTimeline, setFitTimeline] = useState(0);
  // The request whose edits the timeline numbers when nothing is open: the one picked, else the latest, unless the
  // editor took them off.
  const marked = picked === null ? undefined : threads.find(t => t.id === picked) ?? ordered.at(-1);
  // The timeline is on the request the editor went to: an edit they opened, or a pass's full list. Otherwise it is on the
  // request picked in the chat, else the latest, so that request's edits are marked from the start.
  const focusThread = threads.find(t => t.id === focus?.threadId) ?? marked;
  const firstCuts = useMemo(() => focusThread && firstCutDeliveries(focusThread), [focusThread]);
  // The request's own edits and the ones it flagged that another request made.
  const focusChanges = useMemo(() => [...focusThread?.changes ?? [], ...focusThread?.flagged ?? []], [focusThread]);
  // A proposal Scarlet is waiting on. A dialogue pass waits where it is until its calls are made; a suggestion opens in
  // the card on the timeline when its line is pressed. Neither stands in for the other: a suggestion that plays
  // leaves the pass its calls, its block and its place above the message box (2026-11-08: they went until Esc).
  const [reviewId, setReviewId] = useState<string>();
  const pendingPass = useMemo(() => ordered.map(t => openPass(t, tasks)).findLast(c => !!c), [ordered, tasks]);
  const played = changes.find(c => c.id === reviewId && c.state === "ready");
  const livePass = played && isOpenPass(played, tasks) ? played : pendingPass;
  // The call open on the card, by the pass it was opened on. `listening` follows it onto each new part of the pass.
  const [listenedTo, setListening] = useState<Listening>();
  // While a call plays, the part of the pass it plays on holds, as the working cut on screen does (`useShownCut`). A pass
  // that's still running saves a part every few hundred milliseconds, each a new proposal on the newest working cut, and
  // following each put up a new player before the last had played a frame. Once the video stops, the call goes onto the
  // newest part, as it does whenever a part arrives while it's paused.
  const passPlaying = usePlayerStore(s => s.playing) && !!listenedTo;
  const heldPass = useRef<Change>(undefined);
  const held = heldPass.current;
  const holdPass = passPlaying && !!livePass && !!held && held.id !== livePass.id && held.fromVersion === head &&
    !!threads.find(t => t.changes.some(c => c.id === livePass.id))?.changes.some(c => c.id === held.id);
  if (!holdPass) heldPass.current = livePass;
  const pass = holdPass ? held : livePass;
  const passThread = pass && threads.find(t => t.changes.some(c => c.id === pass.id));
  const passFocused = !!firstCuts?.size || (!!passThread && passThread.id === focusThread?.id);
  const threadTimeline = useThreadTimeline(current.id, head, focusThread, firstCuts, passFocused);
  const chooseEdit = useRef(threadTimeline.choose);
  chooseEdit.current = threadTimeline.choose;
  useEffect(() => {
    if (!focus?.changeId || threadTimeline.threadId !== focus.threadId || threadTimeline.loading) return;
    // A rejected edit's row opens it too: it is looked for after the edits that are in the video.
    const edit = focus.spot !== undefined
      ? [...threadTimeline.edits, ...threadTimeline.rejected].find(e => matchesEdit(e, { changeId: focus.changeId!, spot: focus.spot! }))
      : threadTimeline.edits.find(e => belongsTo(e, { id: focus.changeId } as Change));
    if (edit) { chooseEdit.current(edit, "chat", focus.single); setAimAgain(n => n + 1); }
    setFocus({ threadId: focus.threadId });
  }, [focus, threadTimeline.edits, threadTimeline.rejected, threadTimeline.loading, threadTimeline.threadId]);

  // One cut of the pass is being revised. Its other calls stay open; the revision carries them.
  const revision = pass && passRevision(pass, tasks);
  const cutReview = useCutReview(pass?.id);
  const suggestion = played !== pass ? played : undefined;
  const suggestionThread = suggestion && threads.find(t => t.changes.some(c => c.id === suggestion.id));
  const viewed = useMemo(() => suggestion && appliedReviewChange(suggestion), [suggestion]);
  const [side, setSide] = useState<"before" | "after">("after");
  // A suggestion can change several places. The player is on one of them at a time, starting with the first.
  const [place, setPlace] = useState(0);
  useEffect(() => { setSide("after"); setPlace(0); }, [reviewId]);
  // Its places on the side that's playing: Before plays the working cut, where a place can sit elsewhere.
  const places = useMemo(() => viewed?.ranges.map((range, i) => side === "after" ? range : viewed.renders[i]?.beforeRange ?? range) ?? [], [viewed, side]);
  const shownPlace = place < places.length ? place : 0;
  // The editor's presses on a suggestion's line in the chat, counted: each plays it. A card that comes back by itself,
  // after an apply the engine refused, comes back paused.
  const [reviewPlays, setReviewPlays] = useState(0);
  const closeReview = () => { player.pause(); setReviewId(undefined); setListening(undefined); };
  // What the editor is on now: the change whose call or suggestion is open, or something that is no change waiting on
  // them (`other`): an applied edit's card, a clip from Media.
  const onScreen = useRef<{ other: boolean; change?: string }>({ other: false });
  // The passes already applied, or set to go in, without the editor pressing anything: each is tried once.
  const autoApplied = useRef(new Set<string>());

  // Keep or Cut for each staged cut. Undecided ones follow Scarlet: once it has assessed the pass,
  // footage stays unless it said cut. Without assessments every proposed cut applies.
  // Calls are saved on the proposal, so a reload or the pass's next part keeps them. This holds them until the save lands.
  const [unsaved, setUnsaved] = useState<Record<string, { calls: Record<number, CutChoice>; applyWhenDone?: boolean }>>({});
  const choicesOf = (change: Change) => unsaved[change.id]?.calls ?? savedChoices(change);
  const applyWhenDone = (change: Change) => unsaved[change.id]?.applyWhenDone ?? !!change.applyWhenDone;
  // Only a pass Scarlet is still working on can be set to apply when it finishes. Once its run has stopped, the staged
  // cuts it never checked are the editor's calls, and a schedule sent along with one of them would apply over the rest.
  // The last save sent for each pass, what a save that failed said, and the calls of each pass that the last failed save
  // carried and no save has carried since: those are back with the editor, and the line saying why stays until they're saved.
  // Saves are numbered as they are sent, and `landed` holds the latest of each pass's that has landed.
  const saves = useRef<{ last: Record<string, object>; failed?: string; unsent: Record<string, Set<number>>; sent: number; landed: Record<string, number> }>(
    { last: {}, unsent: {}, sent: 0, landed: {} });
  async function saveChoices(change: Change, calls: Record<number, CutChoice>, apply = passRunning && applyWhenDone(change)) {
    const sent = { calls, applyWhenDone: apply };
    const order = ++saves.current.sent;
    saves.current.last[change.id] = sent;
    setUnsaved(all => ({ ...all, [change.id]: sent }));
    try {
      const { change: saved } = await api.saveCutChoices(change.id, { fromVersion: change.fromVersion, toVersion: change.toVersion, applyWhenDone: apply,
        choices: Object.entries(calls).map(([index, choice]) => ({ index: Number(index), choice })) });
      const unsent = saves.current.unsent[change.id];
      for (const index of Object.keys(calls)) unsent?.delete(Number(index));
      saves.current.landed[change.id] = Math.max(saves.current.landed[change.id] ?? 0, order);
      if (saves.current.last[change.id] !== sent) return;
      // A part may have landed before the click reached the engine. Its response carries the choices at their live
      // indices. A project event can beat that response, including one that supersedes this proposal again.
      const held = useProjectStore.getState().current?.changes.find(c => c.id === saved.id);
      const alreadyMoved = held && saved.state === "ready" && ["approved", "rejected", "revising", "failed"].includes(held.state);
      // An assessment can publish another call at the same updatedAt as the save. Published calls persist: a call
      // in the live proposal that the response hasn't seen distinguishes the later event even on that clock.
      const inResponse = new Set(saved.cutAssessments?.filter(isPublishedCall).map(a => a.index));
      const newerCall = held?.cutAssessments?.some(a => isPublishedCall(a) && !inResponse.has(a.index));
      const live = held && (ts(held.updatedAt) > ts(saved.updatedAt) ||
        ((alreadyMoved || newerCall) && ts(held.updatedAt) === ts(saved.updatedAt))) ? held : saved;
      if (live !== held)
        useProjectStore.getState().applyEvent({ type: "change.updated", projectId: saved.projectId, change: saved });
      // The latest save carries every call made so far. Landed, an earlier save's failure lost nothing, unless a call it
      // carried is still undecided: then its line stays, so the decision doesn't vanish without a word.
      if (!unsent?.size) setDecideError(shown => shown === saves.current.failed ? "" : shown);
      return live;
    } catch (e) {
      // A later save that has landed carried every call this one did: nothing was lost, and nothing is said.
      if ((saves.current.landed[change.id] ?? 0) > order) return;
      saves.current.unsent[change.id] = new Set(Object.keys(calls).map(Number));
      saves.current.failed = errorMessage(e);
      setDecideError(saves.current.failed);
    } finally {
      // Drop only this optimistic copy. A save sent since carries its own calls and may still land.
      setUnsaved(all => {
        if (all[change.id] !== sent) return all;
        const { [change.id]: _sent, ...rest } = all;
        return rest;
      });
    }
  }
  // A pass interrupted when Scarlet quit carries on under a new task. One with a cut revised belongs to that revision's
  // task, which leads back to the run that staged it: that run says whether the pass is still being worked on or
  // stopped early, and it is the request that holds the place above the message box.
  const passTask = pass && lastAttempt(stagingTask(pass, changes, tasks), tasks);
  // The request that made this version of the pass. For a pass with a cut revised that is the revision, which checks
  // its new cut after staging it and says what it found. Until it ends the pass is still Scarlet's: the last call
  // schedules it, and the engine applies it when that request finishes or asks the editor about the cut instead
  // (2026-11-09: the last call applied the pass over a revision still at work, and its verdict was refused as stale).
  const passMaker = pass && lastAttempt(tasks.find(t => t.id === pass.taskId), tasks);
  const passRunning = (!!passTask && runIsActive(passTask)) || (!!passMaker && runIsActive(passMaker));
  // A pass whose run is over, finished or stopped early, left the staged cuts it never checked to the editor. One still
  // running, or carrying on, will check them.
  const passOver = passTask?.state === "done" || passTask?.state === "failed" || passTask?.state === "cancelled";
  // Revising one cut replaces the pass. Calls already made on its other cuts carry over.
  useEffect(() => {
    const task = pass && !pass.cutChoices?.length && !unsaved[pass.id] ? tasks.find(t => t.id === pass.taskId) : undefined;
    const { changeId: from, cutIndex } = task?.kind === "revise" ? task.context : {};
    const previous = from && changes.find(c => c.id === from);
    if (!pass || !previous || cutIndex === undefined) return;
    const { [cutIndex]: _revised, ...kept } = choicesOf(previous);
    if (Object.keys(kept).length) void saveChoices(pass, kept);
  }, [pass?.id, tasks]); // eslint-disable-line react-hooks/exhaustive-deps
  const carrying = useMemo(() => carryingVersions(pass, passThread?.changes ?? [], changes), [pass, passThread, changes]);
  const footage = useCarryingFootage(current.id, timeline, carrying, fps);
  const passIndex = (task: Task) => pass && callNow(pass, revisionCut(task), passThread?.changes ?? [], changes, tasks, footage);
  const revisingIndex = revision && passIndex(revision);
  // A scoped revision can save the same cut several times before it finishes. Show the version the editor sent
  // back through those saves, including after reloading the project. Calls on its siblings use the live proposal.
  const revisionInput = useMemo(() => {
    if (!pass || !passThread || !passMaker || !runIsActive(passMaker) || passMaker.context.cutIndex === undefined) return;
    const named = changes.find(c => c.id === passMaker.context.changeId);
    if (!named || named.id === pass.id) return;
    const previous = revisedFrom(pass, passMaker, passThread.changes).previous ?? named;
    const namedOrder = named.cutAssessments?.find(a => a.index === passMaker.context.cutIndex)?.askOrder;
    const current = namedOrder && pass.cutAssessments?.find(a => a.askOrder === namedOrder);
    const index = callNow(previous, passMaker.context, passThread.changes, changes, tasks, footage);
    const activeIndex = current ? current.index : passIndex(passMaker) ?? index;
    if (index === undefined || activeIndex === undefined) return;
    const cuts = stagedCuts(previous).map(removed => ({ removed }));
    const call = reviewCalls(previous, cuts, passOver).find(c => c.index === index);
    if (call) return { call, index: activeIndex, previous };
  }, [passMaker, pass, passThread, changes, tasks, passOver, footage]); // eslint-disable-line react-hooks/exhaustive-deps
  // A revision sent while the pass still runs can't replace it yet, so it waits in the queue as a request about one cut.
  // That call waits on Scarlet now, not on the editor, just like the cut being revised.
  // For each such cut, the request on it: the one Scarlet has started, else the first one waiting.
  const cutRuns = new Map<number, Task>();
  if (pass) for (const t of tasks) {
    if (!runIsActive(t) || (!t.cutConflict && (t.id === pass.taskId || t.id === passTask?.id))) continue;
    const index = passIndex(t);
    if (index === undefined) continue;
    const had = cutRuns.get(index);
    if (!had || (had.state === "queued" && t.state !== "queued")) cutRuns.set(index, t);
  }
  if (revision && revisingIndex !== undefined && cutRuns.get(revisingIndex)?.state !== "running") cutRuns.set(revisingIndex, revision);
  if (revisionInput && passMaker) cutRuns.set(revisionInput.index, passMaker);
  // A pass that saves its next part, or gets one cut revised, comes back as a new proposal. The listen is on its cut
  // there from the first render, so its card stays on the page with its script, note and picker as they were. A listen
  // whose cut is gone from the pass is over.
  const listening = useMemo(() => {
    if (!listenedTo || !pass) return listenedTo;
    if (revisionInput && ((listenedTo.changeId === revisionInput.previous.id && listenedTo.index === revisionInput.call.index) ||
        (listenedTo.changeId === pass.id && listenedTo.index === revisionInput.index))) {
      return { ...listenedTo, changeId: pass.id, index: revisionInput.index, cut: revisionInput.call };
    }
    if (listenedTo.changeId === pass.id) return listenedTo;
    if (!passThread?.changes.some(c => c.id === listenedTo.changeId)) return undefined;
    // A call that was sent back and is open when its new version arrives stays open, on that version.
    const carried = carriedCall(pass, listenedTo, changes, tasks, footage) ?? revisedCall(pass, listenedTo, passThread.changes, changes, tasks, footage);
    return carried && { ...listenedTo, changeId: pass.id, ...carried };
  }, [listenedTo, pass, passThread, changes, tasks, footage, revisionInput]);
  const cutDuration = useMemo(() => timeline && timelineDuration(timeline), [timeline]);
  // The timeline zooms to the place the player is on, as it does to any edit that opens, with the suggestion's band on it.
  const placeOnScreen = places[shownPlace];
  const suggestionLine = placeOnScreen && focusAround(placeOnScreen, cutDuration ?? 0);
  const returningCall = revisionInput && listening?.changeId === pass?.id && listening?.index === revisionInput.index ? revisionInput : undefined;
  const priorReview = useCutReview(returningCall?.previous.id);
  const listenReview = returningCall ? priorReview : cutReview;
  const review = listenReview.review;
  const listenPass = returningCall?.previous ?? pass;
  const listenIndex = returningCall?.call.index ?? listening?.index ?? -1;
  const liveReview = cutReview.review;
  const passRemovals = useMemo(() => liveReview?.cuts.map(c => c.removed), [liveReview]);
  const listenRemovals = useMemo(() => review === liveReview ? passRemovals : review?.cuts.map(c => c.removed), [review, liveReview, passRemovals]);
  // The pass's cuts are timed on the version it was staged on. A request in its own thread (an undo, a revision of an
  // applied cut) can move the working cut on while its calls wait: each call is then marked, shaded and played where
  // its footage sits on the working cut, which is the footage Approve takes out. A pass on the head whose working cut
  // hasn't arrived yet is not behind it: its listen waits for that cut, below.
  const passBehind = !!pass && !!head && pass.fromVersion !== head && !!timeline && timeline.version !== pass.fromVersion;
  // The version the pass is staged on. Its cut list has it. A pass with no list of its own, or one whose list
  // couldn't be loaded, is asked for it by itself, so its calls are placed all the same.
  const stagedOn = useReviewTimeline(current.id, passBehind ? pass!.fromVersion : undefined, liveReview?.original);
  const toWorkingCut = useMemo(() => stagedOn.timeline && timeline ? { map: makeTimeMap(stagedOn.timeline, timeline, fps), timeline } : undefined,
    [stagedOn.timeline, timeline, fps]);
  // Until that version is in there is nothing to place the pass's cuts by, so none is marked or played at a guess.
  const placing = passBehind && !toWorkingCut;
  // Each cut is placed once for a working cut, however many places ask where it is.
  const placedCuts = useMemo(() => new WeakMap<TimeRange, TimeRange | undefined>(), [toWorkingCut]);
  const placeCut = (cut: TimeRange) => {
    if (placing) return undefined;
    if (!toWorkingCut) return cut;
    if (!placedCuts.has(cut)) placedCuts.set(cut, cutOnWorkingCut(cut, toWorkingCut, fps));
    return placedCuts.get(cut);
  };
  // When that version couldn't be loaded, a call that is open asks for it again, once: the one that was open as the
  // load failed, and each one opened after.
  const askedAgain = useRef<string>(undefined);
  useEffect(() => {
    if (!listening) { askedAgain.current = undefined; return; }
    if (!placing || !stagedOn.error || listening.changeId !== pass?.id || askedAgain.current === listening.key) return;
    askedAgain.current = listening.key;
    stagedOn.retry();
  }, [listening?.key, placing, stagedOn.error]); // eslint-disable-line react-hooks/exhaustive-deps
  // The open call's cut on the working cut. None while it can't be placed, or once footage inside it changed.
  const placed = useMemo(() => {
    if (!listening || !pass || listening.changeId !== pass.id) return listening?.cut;
    if (!returningCall || returningCall.previous.fromVersion === pass.fromVersion) return placeCut(listening.cut);
    if (!timeline || !review?.original) return;
    if (review.original.version === timeline.version) return listening.cut;
    return cutOnWorkingCut(listening.cut, { map: makeTimeMap(review.original, timeline, fps), timeline }, fps);
  }, [listening?.cut, listening?.changeId, pass, returningCall, review, timeline, toWorkingCut, placing, fps]); // eslint-disable-line react-hooks/exhaustive-deps
  // A changed passage can be heard on the working cut when Scarlet asks about it. A subsequent revision
  // can have its own recorded Before and After, even though the other calls still use the original pass.
  const overrideForCall = (index: number) => revisionInput?.index === index
    ? revisionInput.previous.cutEdits?.find(c => c.index === revisionInput.call.index)
    : pass?.cutEdits?.find(c => c.index === index);
  const cutOverride = listening && pass?.id === listening.changeId ? overrideForCall(listening.index) : undefined;
  const rechecking = listening && pass?.id === listening.changeId ? cutRuns.get(listening.index) : undefined;
  const conflict = rechecking?.cutConflict;
  const answeringCut = !!conflict && rechecking.state === "waiting_for_user";
  const versionBefore = !conflict ? cutOverride?.version : undefined;
  const callPlaybackKey = (index: number, version: string) => {
    const prior = revisionInput?.index === index ? revisionInput : undefined;
    const source = prior?.previous ?? pass;
    return JSON.stringify([current.id, source?.id, prior?.call.index ?? index, version, source?.toVersion, overrideForCall(index)?.previewVersion]);
  };
  // The version an applied cut's After plays: the one its change made, or the video as it runs now once anything
  // has changed it since. An undone cut, whose version before it is the video now, keeps its own.
  const afterOf = (made: { version: string; removed?: TimeRange[] } | undefined, before: string | undefined) =>
    made && head && made.version !== head && before !== head ? { version: head, removed: undefined } : made;
  const editPlaybackKey = (edit: ThreadEdit, after?: string) => JSON.stringify([current.id, firstKey(edit), edit.beforeCut?.version, after,
    edit.beforeCut?.removed.start, edit.beforeCut?.removed.end]);
  // Cuts are prepared and drafted on the working cut on screen: one saved under a playing listen waits with it, so the
  // listen's own version isn't thrown away and asked for again with each save.
  const shownProject = useMemo(() => head && head !== current.project.head ? { ...current.project, head } : current.project, [current.project, head]);
  const reviewContext = useMemo(() => fullRenderContext(shownProject), [shownProject]);
  const draftCache = useMemo<SingleCutDrafts>(() => new Map(),
    [reviewContext, pass?.id, pass?.toVersion, current.renderSettingsRevision]);
  const preparedCandidates = useMemo(() => new Map<string, PreparedCut>(), [draftCache]);
  const beforeVersion = versionBefore ?? timeline?.version;
  const preparedCall = !conflict && listening && pass?.id === listening.changeId && beforeVersion ? preparedCandidates.get(callPlaybackKey(listening.index, beforeVersion)) : undefined;
  const savedBefore = useReviewTimeline(current.id, conflict?.range ? conflict.version : versionBefore, preparedCall?.before.timeline ?? timeline);
  const placedCall = useMemo(() => {
    if (!conflict) return cutOverride?.range ?? placed;
    if (!conflict.range || !timeline || head !== timeline.version) return;
    if (conflict.version === head) return conflict.range;
    if (!savedBefore.timeline) return;
    const mapped = mapStagedCut(savedBefore.timeline, timeline, conflict.range, fps);
    return mapped.kind === "gone" ? { start: mapped.at, end: mapped.at } : mapped.range;
  }, [conflict, cutOverride, placed, timeline, head, savedBefore.timeline, fps]);
  const callTimeline = conflict ? (timeline && head === timeline.version ? timeline : undefined)
    : versionBefore ? savedBefore.timeline ?? undefined : timeline ?? undefined;
  const callDuration = useMemo(() => callTimeline && timelineDuration(callTimeline), [callTimeline]);
  const pinnedCallVersion = versionBefore && (head !== versionBefore || timeline?.version !== versionBefore) ? versionBefore : undefined;
  const versionAfter = !conflict ? cutOverride?.previewVersion : undefined;
  const savedAfter = useReviewTimeline(current.id, listening?.side === "after" ? versionAfter : undefined, preparedCall?.after.timeline);
  const passJoin = useMemo(() => {
    if (!review || !listenRemovals || !placedCall || !callTimeline || review.original.version !== callTimeline.version || !callDuration ||
        cutOverride || conflict || listening?.side !== "after" || listening.changeId !== pass?.id) return;
    const listen = cutAudition(placedCall, "after", callDuration);
    if (!isolatedReviewCut(review, placedCall, listen)) return;
    if (preparedCall?.after.version === review.proposed.version) return preparedCall.after;
    const clock = cutAuditionClock(callTimeline, review.proposed, listenRemovals, fps, placedCall, listen);
    if (clock) return { version: review.proposed.version, timeline: review.proposed, clock };
  }, [review, listenRemovals, preparedCall, placedCall, callTimeline, callDuration, cutOverride, conflict, listening?.side, listening?.changeId, pass?.id, fps]);
  // A neighboring staged cut must remain audible. When the working version has moved, the pass's rendered
  // joins also sit on the wrong footage. Ask the engine for the selected call on the version being reviewed.
  const needsSingleCut = !!placedCall && !passJoin && !cutOverride && !conflict && !!pass &&
    listening?.side === "after" && listening.changeId === pass.id && !!review?.cuts[listenIndex];
  const single = useSingleCutDraft(needsSingleCut && !preparedCall && timeline?.version === head ? listenPass?.id : undefined,
    listenIndex, review?.cuts.length ?? 0, head ?? undefined, draftCache);
  const heard = (needsSingleCut ? preparedCall?.cut ?? single.preview?.range : undefined) ?? placedCall;
  const audition = useMemo(() => {
    if (!listening || !heard || !callDuration) return;
    // A click inside the cut plays from that point, through all of it: a long cut's middle isn't stepped over then.
    const from = !conflict && listening.side === "before" && listening.at !== undefined && listening.at >= heard.start && listening.at <= heard.end
      ? listening.at : undefined;
    const listen = cutAudition(heard, conflict ? "before" : listening.side, callDuration, { whole: !!conflict || from !== undefined });
    return from === undefined ? listen : { ...listen, from, through: true };
  }, [heard?.start, heard?.end, listening?.side, listening?.take, listening?.at, callDuration, !!conflict, callTimeline?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  // A listen keeps the join it started with. The pass's next part swaps the proposal under it, and what plays around
  // this cut is the same, so the listen doesn't start again while the new proposal's cuts load or when they arrive.
  const heldJoin = useRef<{ audition: Audition; base: string; join: JoinedListen }>(undefined);
  const listenJoined = useMemo(() => {
    const held = heldJoin.current;
    if (held && held.audition === audition && held.base === callTimeline?.version && (!cutOverride || held.join.version === versionAfter)) return held.join;
    heldJoin.current = undefined;
    if (!audition || conflict || !heard || !callTimeline) return;
    if (cutOverride) {
      const after = savedAfter.timeline;
      if (listening?.side !== "after" || !after) return;
      const clock = verifiedJoinClock(callTimeline, after, [heard], fps, [audition.start, heard.start, heard.end, audition.end]);
      if (clock) return { version: after.version, timeline: after, clock };
      return;
    }
    let join = passJoin ?? (needsSingleCut && preparedCall ? {
      version: preparedCall.after.version, timeline: preparedCall.after.timeline, clock: preparedCall.after.clock,
    } : undefined);
    if (single.preview) {
      const { draft, range } = single.preview;
      const clock = cutAuditionClock(callTimeline, draft, [range], fps, heard, audition);
      if (clock) join = { version: draft.version, timeline: draft, clock };
    }
    if (join) heldJoin.current = { audition, base: callTimeline.version, join };
    return join;
  }, [audition, passJoin, single.preview, needsSingleCut, preparedCall, callTimeline, heard, fps, savedAfter.timeline, versionAfter, cutOverride, conflict]);
  // The call plays on the working cut, where the cuts already in the video around it have no footage left to show. When
  // the stretch the card zooms to has some, the call is shown on a version that still has their footage, as an applied
  // cut is on the version before it: each is a grey gap there, After steps over it as the video runs now, and a click
  // in one plays it in Before from that point. That version is the one before the earliest of the cuts joined there,
  // so it holds all of them. A call on another version, or one Scarlet is checking again, stays as it is.
  const { listed: listedPassEdits, located: locatedPassEdits } = useThreadEdits(current.id, passThread);
  const callOnHead = !!listening && !!pass && listening.changeId === pass.id && !conflict && !versionBefore && !!heard && !!callDuration
    && !!timeline && timeline.version === head && callTimeline === timeline;
  const callBaseVersion = useMemo(() => {
    const view = callOnHead ? focusAround(heard!, callDuration!)?.view : undefined;
    if (!view) return;
    let base: { version: string; made: number } | undefined;
    const lists: [Thread | undefined, readonly ThreadEdit[] | undefined][] = [[passThread, locatedPassEdits],
      [focusThread, threadTimeline.loading || threadTimeline.error ? undefined : threadTimeline.edits]];
    for (const [thread, edits] of lists) for (const e of edits ?? []) {
      if (!thread || !e.beforeCut || e.at === undefined || e.at < view.start || e.at > view.end || e.beforeCut.version === head) continue;
      const made = Date.parse(cutChange(e, thread.changes)?.createdAt ?? "");
      const at = Number.isFinite(made) ? made : Infinity;
      if (!base || at < base.made) base = { version: e.beforeCut.version, made: at };
    }
    return base?.version;
  }, [callOnHead, heard?.start, heard?.end, callDuration, passThread, locatedPassEdits, focusThread, threadTimeline.loading, threadTimeline.error, threadTimeline.edits, head]); // eslint-disable-line react-hooks/exhaustive-deps
  const callBase = useReviewTimeline(current.id, callBaseVersion);
  // What that version has that the working cut doesn't, each passage in its clock with its join on the working cut.
  const baseRemovals = useMemo(() => callBase.timeline && timeline && callBase.timeline.version !== timeline.version
    ? removedSince(callBase.timeline, timeline, fps) : undefined, [callBase.timeline, timeline, fps]);
  const baseCuts = useMemo(() => baseRemovals?.map(r => r.removed), [baseRemovals]);
  const callView = useMemo(() => {
    const base = callBase.timeline;
    if (!callOnHead || !base || !baseRemovals?.length || !baseCuts || !timeline || !heard) return;
    const duration = timelineDuration(base);
    const toBase = makeTimeMap(timeline, base, fps);
    const start = toBase(heard.start, "right"), end = toBase(heard.end, "left");
    if (start === null || end === null || end < start) return;
    const cut = { start, end };
    const after = cutAudition(cut, "after", duration, { others: baseCuts, beyond: true });
    const focus = focusAround(cut, duration, `Removed · ${lengthLabel(heard.end - heard.start)}`, { playbackEnd: after.end });
    const shown = focus && baseRemovals.filter(r => r.removed.end > focus.view.start && r.removed.start < focus.view.end);
    if (!focus || !shown?.length) return;
    // The working cut must be this version with exactly those passages out. One that differs here in any other way
    // keeps the call on the working cut, with nothing drawn, rather than shown or played in the wrong place.
    const toWorking = verifiedJoinClock(base, timeline, baseCuts, fps, [focus.view.start, after.start, cut.start, cut.end, after.end, focus.view.end]);
    if (!toWorking) return;
    return { version: base.version, timeline: base, duration, cut, after, focus, shown, toWorking,
      toBase: (t: number) => toBase(t, "right") ?? toBase(t, "left") };
  }, [callOnHead, callBase.timeline, baseRemovals, baseCuts, timeline, heard?.start, heard?.end, fps]); // eslint-disable-line react-hooks/exhaustive-deps
  // Until that version is in, the call doesn't start on the working cut only to change players once it arrives.
  const callViewWaiting = callOnHead && !!callBaseVersion && !callBase.timeline && !callBase.error;
  // A gap clicked while the call is open plays that footage in Before from the click. Back to After then picks up where
  // the footage ends. Either belongs to the one take it was chosen for.
  const [callVisit, setCallVisit] = useState<{ key: string; take: number; side: Side; at: number; start: number; end: number; label: string }>();
  const visit = callView && listening && callVisit?.key === listening.key && callVisit.take === listening.take ? callVisit : undefined;
  const viewAudition = useMemo((): Audition | undefined => {
    if (!callView || !listening) return;
    const { cut, duration, after } = callView;
    if (visit?.side === "before") return { ...cutAudition(cut, "before", duration, { whole: true, tailFrom: visit.end }), from: visit.at, through: true };
    if (visit) return { ...cutAudition(cut, "after", duration, { others: baseCuts, whole: true, tailFrom: visit.at, beyond: true }), from: visit.at };
    if (listening.side === "after") return after;
    // A click inside the call's own passage plays from there, through all of it, as on the working cut.
    const from = listening.at !== undefined && heard && listening.at >= heard.start && listening.at <= heard.end ? callView.toBase(listening.at) : null;
    const listen = cutAudition(cut, "before", duration, { whole: from !== null });
    return from === null ? listen : { ...listen, from, through: true };
  }, [callView, listening?.side, listening?.take, listening?.at, visit, baseCuts]); // eslint-disable-line react-hooks/exhaustive-deps
  // After plays the same version with the call's cut in it, by way of the working cut: this version's gaps land on
  // their joins there, then the call's own join.
  const viewJoined = useMemo(() => callView && listenJoined && listening?.side === "after"
    ? { version: listenJoined.version, timeline: listenJoined.timeline, clock: composeClocks(callView.toWorking, listenJoined.clock) } : undefined,
  [callView, listenJoined, listening?.side]);
  const playedAudition = callView ? viewAudition : audition;
  const callViewNow = useRef(callView);
  callViewNow.current = callView;
  // Whether that version has a saved file is known before its player goes up. Otherwise the listen starts on the
  // stream, and the picture and sound break when the file takes over. Asked as soon as the pass's cuts are in,
  // on either side, so After rarely waits for it.
  const listenFile = usePlaybackCache(current.project, { version: conflict ? undefined : cutOverride ? versionAfter : listenJoined?.version ?? (pass && !needsSingleCut ? review?.proposed.version : undefined),
    settingsRevision: current.renderSettingsRevision });
  const listenCache = listenFile.cache ?? (listenJoined && preparedCall?.after.version === listenJoined.version
    ? { url: preparedCall.after.file, state: preparedCall.after.file ? "ready" : "uncached" } : undefined);
  // A listen waits for the working cut its pass is on, and After for the pass's cut list too, so it doesn't start in
  // the wrong place or change players partway. A listen that has started isn't held back again.
  // When the engine couldn't build that one-cut version, After isn't held behind a Retry that asks for the same thing
  // again: it plays over the working cut, stepping over the cut's footage, as it did before the engine built them.
  const singleFailed = needsSingleCut && !preparedCall && !listenJoined && (!!single.error || !!single.preview);
  const openingJoin = needsSingleCut && !singleFailed && (!listenJoined || !listenCache);
  const startedListen = useRef<Audition>(undefined);
  const listenPending = !!audition && startedListen.current !== audition && !!pass && listening?.changeId === pass.id && (
    (!cutOverride && !conflict && pass.fromVersion === head && timeline?.version !== head)
    || (!conflict && !listenJoined && listening.side === "after" && (cutOverride ? !!versionAfter && !savedAfter.timeline && !savedAfter.error : review === undefined && !listenReview.error))
    || openingJoin || (!!listenJoined && !listenCache) || callViewWaiting);
  // One listen per cut and side. The timeline can scrub anywhere meanwhile. Only the editor starts it: opening the
  // call, choosing a side or pressing the same side again. When the pass or the video around it changes instead,
  // the listen stays where it is, and stays paused if the editor paused it.
  const playedListen = useRef<string>(undefined);
  const playedOn = useRef<{ timeline: Timeline; listen: Audition; cut: number }>(undefined);
  useLayoutEffect(() => {
    if (!audition || !listening) {
      // An open call that can't be placed on the working cut just now keeps its listen: once it can, the listen is
      // taken up where it was, not started over.
      if (!listening || heard) playedListen.current = undefined;
      return;
    }
    if (listenPending) return;
    return afterPlayerMount(() => {
      startedListen.current = audition;
      const sample = conflict ?? cutOverride;
      const chosen = `${listening.key}/${listening.side}/${listening.take}` + (sample ? `/${sample.version}/${heard?.start}/${heard?.end}` : "");
      const again = quietOpen.current || playedListen.current === chosen;
      quietOpen.current = false;
      playedListen.current = chosen;
      // The working cut changed under a listen already begun. A playhead inside that listen follows the footage it was
      // on, or keeps its place against the cut where that footage is gone. One the editor scrubbed elsewhere stays put,
      // as it does whenever the working cut changes. A call that came back revised on the same working cut moves nothing.
      // The same holds when the call goes onto the version that still has the footage of the cuts around it, or off it.
      const was = again ? playedOn.current : undefined;
      const time = usePlayerStore.getState().time;
      const shownOn = callView?.timeline ?? callTimeline, cut = callView?.cut ?? heard, listen = playedAudition ?? audition;
      if (was && cut && shownOn && was.timeline !== shownOn && time >= was.listen.start && time <= was.listen.end) {
        const at = makeTimeMap(was.timeline, shownOn, fps)(time, "right") ?? time + cut.start - was.cut;
        if (Math.abs(at - time) > 1e-6) player.seek(at, true);
      }
      playedOn.current = cut && shownOn ? { timeline: shownOn, listen, cut: cut.start } : undefined;
      return again ? player.audition(listen, fps, true) : player.audition(listen, fps);
    });
  }, [audition, playedAudition, fps, listenPending, listenJoined?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const listenSide = (side: Side) => {
    player.pause();
    if (listening && visit?.side === "before" && side === "after") setCallVisit({ ...visit, take: listening.take + 1, side: "after", at: visit.end });
    setListening(l => l && { ...l, side, take: l.take + 1, at: undefined });
  };
  // A click inside a grey gap: the footage another cut took out there plays in Before from that point, through to its end.
  const hearGapInCall = (gap: TimelineGap, time: number) => {
    if (!callView || !listening) return;
    player.pause();
    const take = listening.take + 1;
    setCallVisit({ key: listening.key, take, side: "before", at: Math.max(gap.start, Math.min(gap.end, time)), start: gap.start, end: gap.end, label: gap.shortLabel ?? gap.label });
    setListening(l => l && { ...l, side: "before", take, at: undefined });
  };
  // A click inside the call's cut on the timeline: After steps over that footage, so it plays in Before from there.
  const listenFrom = (time: number) => { player.pause(); setListening(l => l && { ...l, side: "before", take: l.take + 1, at: time }); };
  // The proposed version a suggestion would produce. Before shows the working cut at the same spot.
  const draftVersion = side === "after" && viewed && viewed.state !== "failed" && viewed.toVersion !== head ? viewed.toVersion : undefined;
  const [draftState, setDraftState] = useState<{ version: string; timeline?: Timeline; failed?: boolean }>();
  const [draftAttempt, setDraftAttempt] = useState(0);
  useEffect(() => {
    if (!draftVersion) return;
    let live = true;
    setDraftState(state => state?.version === draftVersion && state.timeline ? state : { version: draftVersion });
    readTimeline(current.id, draftVersion).then(
      timeline => { if (live) setDraftState({ version: draftVersion, timeline }); },
      () => { if (live) setDraftState({ version: draftVersion, failed: true }); });
    return () => { live = false; };
  }, [current.id, draftVersion, draftAttempt]);
  const draft = draftState?.version === draftVersion ? draftState?.timeline : undefined;
  const beforeAt = side === "before" ? places[shownPlace]?.start : undefined;
  useLayoutEffect(() => { if (beforeAt !== undefined) player.seek(Math.max(0, beforeAt - 1), true); }, [beforeAt, suggestion?.id]);

  const hasCut = !!head && !!cutDuration;
  const workingCache = usePlaybackCache(current.project, {
    version: hasCut && timeline?.version === head ? timeline.version : undefined,
    automatic: true, settingsRevision: current.renderSettingsRevision,
  });
  // A clip chosen in Media plays here. Before there is a cut, show the footage that came in.
  const [sourceChoice, setSourceChoice] = useState({ id: "", play: false });
  // Playing a clip from Media starts it once. It isn't a standing order: once the clip plays, a pause holds when its
  // saved file takes over from the stream, and when Media, History or Export opens and closes over it.
  useEffect(() => {
    if (!sourceChoice.play) return;
    return usePlayerStore.subscribe((now, was) => { if (now.playing && !was.playing) setSourceChoice(c => c.play ? { ...c, play: false } : c); });
  }, [sourceChoice.play]);
  const previewable = media.filter(canPreviewMedia);
  const chosenSource = previewable.find(m => m.id === sourceChoice.id);
  const source = draftVersion ? undefined : chosenSource
    ?? (hasCut ? undefined : previewable.find(m => m.kind === "video" && m.status !== "failed") ?? previewable[0]);
  const [transcript, setTranscript] = useState(false);
  const [menuError, setMenuError] = useState("");
  const menuSays = toLearn > 0 ? `${plural(toLearn, "rule")} to review in Learnings` : "";
  // A clip from Media and the cut each keep their own place: the clip opens at its start, not at the cut's time on
  // it, and going back returns the cut to where it was left.
  const cutPlace = useRef<number>(undefined);
  function previewSource(id: string, play: boolean) {
    player.pause();
    // With an applied cut open the player is on the version before it, and its time isn't one on the working cut.
    // The place to come back to is that cut's join, where closing it goes.
    if (!chosenSource) cutPlace.current = cutKey ? shownAt : usePlayerStore.getState().time;
    usePlayerStore.getState().setTime(0);
    setReviewId(undefined);
    setListening(undefined);
    threadTimeline.clear();
    setSourceChoice({ id, play });
    setPanel(null);
    if (source?.id === id) {
      player.seek(0);
      if (play) player.play();
    }
  }
  const backToVideo = () => {
    player.pause();
    if (chosenSource) usePlayerStore.getState().setTime(cutPlace.current ?? 0);
    cutPlace.current = undefined;
    setSourceChoice({ id: "", play: false });
  };

  // Reply and Answer aim the box at one request. Sending clears it. Scarlet's own work in that request doesn't:
  // a run that resumes or asks a question while the editor types leaves their message aimed where it was.
  const [replyTo, setReplyTo] = useState<string>();
  const replyThread = threads.find(t => t.id === replyTo);
  const replyGone = !!replyTo && !replyThread;
  // Words chosen in the transcript that just took the box off a call to start a new edit: they are the message's, even
  // before anything is typed, so the move they made doesn't take them off again.
  const askedWords = useRef<AgentContext | undefined>(undefined);
  // Words chosen in the passage of the call that's open, which the box is aimed at as that call's revision.
  const wordsInCall = useRef<AgentContext | undefined>(undefined);
  // The box may already have moved on to another request by the time this runs: only an aim still on the missing one goes.
  useEffect(() => { if (replyGone) setReplyTo(aimed => aimed === replyTo ? undefined : aimed); }, [replyGone]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    openDraft(current.id, replyTo);
    // A point picked on the timeline, or words chosen in the transcript, are for the message written then. An empty
    // box doesn't come back still aimed at them.
    const box = useUiStore.getState();
    const aimed = box.agentContext;
    const asked = askedWords.current;
    askedWords.current = undefined;
    if (!replyTo && !box.agentDraft.trim() && aimed && aimed !== "whole" && !aimed.changeId && !aimed.markedRange && aimed !== asked) box.setAgentContext(null);
  }, [current.id, replyTo, openDraft]);
  // What the next message revises: one cut, one edit, or the whole request. Shown above the box.
  const [targetLabel, setTargetLabel] = useState<string>();
  const agentContext = useUiStore(s => replyTo ? s.agentContext : undefined);
  useEffect(() => { if (!replyTo) setTargetLabel(undefined); }, [replyTo]);
  // Each time the editor aims the box. A message that lands clears the aim it was sent under, never one made since.
  // Every aim renders the page, also one that changes nothing else, so the box always holds the count it is sent under.
  const aims = useRef(0);
  const [, renderForAim] = useState(0);
  const countAim = () => renderForAim(++aims.current);
  // Whether the box's aim was made for a cut, an edit or a suggestion that was open. Such an aim goes when that closes.
  // One the editor made on a whole request (the whole pass, an answer) stays until the chat moves on.
  const aimForItem = useRef(false);
  const itemIsOpen = useRef(false);
  /** The aim Backspace or the tag's × just took off the box, which ⌘Z puts back. */
  const tagTakenOff = useRef<{ aim: number; restore(): void }>(undefined);
  /** Aim the message box at one cut, one edit or a whole proposal of a request, as the editor asked. */
  function aimAt(thread: Thread, target: AgentContext, label: string) {
    aimForItem.current = itemIsOpen.current;
    countAim();
    openDraft(current.id, thread.id);
    setReplyTo(thread.id);
    setTargetLabel(label);
    useUiStore.getState().setAgentContext(target);
  }
  const [writeRequest, setWriteRequest] = useState(0);
  function startRevision(thread: Thread, target: AgentContext, label: string) {
    // A message being spoken is in the box until it is out. Aiming the box builds it again, which would drop the
    // recording without a word: Revise waits, as the tag's × does.
    if (useUiStore.getState().speaking) return;
    player.pause();
    aimAt(thread, target, label);
    setWriteRequest(n => n + 1);
    useUiStore.getState().focusComposer();
  }
  /**
   * What a revision of one staged cut is aimed at, and how the line above the box names it. The aim is on the pass's
   * version, where the cut is staged. The line names the cut by its time on the working cut, as the label on the video
   * and its dot do.
   */
  const cutTarget = (change: Change, index: number, cut: TimeRange) => {
    const override = change.cutEdits?.find(c => c.index === index);
    if (override) cut = override.range;
    const target: AgentContext = { changeId: change.id, version: override?.version ?? change.fromVersion, time: cut.start, end: cut.end, clipIds: [], cutIndex: index,
      label: `Cut at ${clockLabel(cut.start)}` };
    return { target, label: `the cut at ${clockLabel((override ? cut : placeCut(cut) ?? cut).start)}` };
  };
  /** Revise is about what's in the player: the suggestion on its card, else the call that's open. */
  function reviseReview() {
    if (suggestion) {
      const range = viewed?.ranges[shownPlace];
      if (suggestionThread) startRevision(suggestionThread, { changeId: suggestion.id, version: viewed?.toVersion ?? suggestion.toVersion, time: range?.start ?? 0, end: range?.end,
        clipIds: [], label: "Suggestion" }, "this suggestion");
      return;
    }
    if (!pass || !passThread) return;
    if (listening?.changeId === pass.id) {
      const { target, label } = cutTarget(pass, listening.index, listening.cut);
      return startRevision(passThread, target, label);
    }
    startRevision(passThread, { changeId: pass.id, version: pass.fromVersion, time: 0, clipIds: [], label: "Whole pass" }, "the whole dialogue pass");
  }
  // When the pass comes back as a new proposal, a revision the message box is aimed at stays on its cut too, so Revise
  // still means that cut. The listen's own state catches up with where the card already is, or ends.
  useLayoutEffect(() => {
    const ui = useUiStore.getState();
    const aimed = ui.agentContext && ui.agentContext !== "whole" ? ui.agentContext : undefined;
    const index = pass && aimed && aimed.changeId !== pass.id ? callNow(pass, aimed, passThread?.changes ?? [], changes, tasks, footage) : undefined;
    const cut = pass && index !== undefined ? stagedCuts(pass)[index] : undefined;
    if (pass && aimed && index !== undefined && index !== revisionInput?.index && cut) {
      const { target: cutAim, label } = cutTarget(pass, index, cut);
      // Words chosen in the cut's passage still say where the editor was looking: only the cut they're about moves.
      const words = aimed === wordsInCall.current;
      const moved = words ? { ...cutAim, version: aimed.version, time: aimed.time, end: aimed.end, clipIds: aimed.clipIds, label: aimed.label } : cutAim;
      const target = aimed.markedRange ? { ...moved, markedRange: aimed.markedRange } : moved;
      if (words) wordsInCall.current = target;
      ui.setAgentContext(target, aimed);
      setTargetLabel(shown => shown && label);
    }
    if (!listenedTo || listenedTo.changeId === pass?.id || returningCall) return;
    if (pass && listening) return setListening(listening);
    player.pause();
    setListening(undefined);
  }, [pass?.id, revisionInput?.index]); // eslint-disable-line react-hooks/exhaustive-deps

  // The proposal being applied, by id: the pass or the suggestion on its card. One applies at a time, and only its
  // own card says Applying… and waits for it to land.
  const [deciding, setDeciding] = useState<string>();
  // Why a call or the pass didn't go through reads with the pass; why the suggestion didn't, on its card.
  const [decideError, setDecideError] = useState("");
  const [stripError, setStripError] = useState("");
  useEffect(() => { setDecideError(""); }, [pass?.id]);
  useEffect(() => { setStripError(""); }, [suggestion?.id]);
  /**
   * Approve or skip the call that's playing, then move on to the next item: the next call still waiting on For you,
   * or the next item in the list (edit or call) when See all is open. The last call applies the pass, with Scarlet's
   * picks for the rest, or schedules it for when Scarlet finishes checking.
   */
  async function decideCut(choice: CutChoice) {
    if (!pass || !listening || listening.changeId !== pass.id || deciding) return;
    const decidedNow = { ...choicesOf(pass), [listening.index]: choice };
    // A and S reach the log as a bare key: this says which call it decided and how many still wait.
    appLog("action", choice === approves(allCalls.find(a => a.index === listening.index)) ? "approve-call" : "skip-call", { change: pass.id, cut: listening.index, at: listening.cut.start, left: remainingCalls.length });
    const next = nextAfterCallDecision;
    player.pause();
    if (next && "call" in next) {
      setListening({ changeId: pass.id, index: next.call.index, cut: { start: next.call.start, end: next.call.end }, side: "after", take: 0, key: `${pass.id}/${next.call.index}` });
      return void saveChoices(pass, decidedNow);
    }
    const nextEdit = next && "edit" in next && passThread ? next.edit : undefined;
    if (nextEdit) actions.openEdit(passThread!, nextEdit);
    else setListening(undefined);
    if (remainingCalls.length > 0) return void saveChoices(pass, decidedNow);
    // The last call is made. The revised cut comes back as a new call, so a pass under revision waits for it before
    // applying. A queued revision of a cut isn't applied over either; the line's Apply stays available.
    // A call changed after every call was made applies the pass as the last call does: nothing holds it back.
    if (revision || queuedCuts.size) return void saveChoices(pass, decidedNow);
    if (passRunning) return void saveChoices(pass, decidedNow, true);
    await approveReview(pass, decidedNow, !!nextEdit);
  }
  /**
   * Apply one proposal: the pass, with the editor's calls and Scarlet's picks for the rest, or the suggestion on its card.
   * `movedOn`: the editor is on an edit by the time the pass applies, which then stays open and goes on playing.
   */
  async function approveReview(change: Change | undefined, choices?: Record<number, CutChoice>, movedOn = false) {
    if (!change || deciding) return;
    const calls = change.id === pass?.id ? pass : undefined;
    const say = calls ? setDecideError : setStripError;
    // Without the pass's cut list nothing would be restored, so every cut would apply, skipped ones included.
    if (calls && cutReview.review === undefined) {
      // The editor's last call is saved all the same. Once the list is in, the pass goes in by itself (`autoApply`).
      if (choices) {
        void saveChoices(calls, choices);
        if (!cutReview.error) return;
      }
      setDecideError(cutReview.error ? `Couldn’t load this pass’s cuts: ${cutReview.error}` : "Still loading this pass’s cuts. Try again in a moment.");
      // One failed load would otherwise answer every Apply until the project was reopened.
      if (cutReview.error) cutReview.retry();
      return;
    }
    // Once applied by hand or by the last call, the pass isn't applied again by itself, nor is the part it became.
    autoApplied.current.add(`${change.id}:apply`);
    setDeciding(change.id);
    say("");
    try {
      const saved = calls && choices ? await saveChoices(calls, choices) : undefined;
      if (choices && saved?.state !== "ready") return;
      const target = saved ?? change;
      const applied = target.id;
      let restored: number[] | undefined;
      if (calls) {
        const review = target.id === calls.id ? cutReview.review : (await api.cutReview(target.id)).review;
        if (!review) return;
        const project = useProjectStore.getState().current;
        const live = project?.changes.find(c => c.id === target.id);
        if (!project || !live || (saved && live.state !== "ready")) return;
        const decided = saved ? savedChoices(live) : choicesOf(live);
        if (saved) {
          const original = lastAttempt(stagingTask(live, project.changes, project.tasks), project.tasks);
          const maker = lastAttempt(project.tasks.find(t => t.id === live.taskId), project.tasks);
          const over = live.id !== calls.id || original?.state === "done" || original?.state === "cancelled" || original?.state === "failed";
          if ((original && runIsActive(original)) || (maker && runIsActive(maker)) || reviewCalls(live, review.cuts, over).some(c => !decided[c.index])) return;
          const thread = buildThreads(project).find(t => t.changes.some(c => c.id === live.id));
          if (!thread || openPass(thread, project.tasks)?.id !== live.id || project.tasks.some(t => runIsActive(t) &&
              callNow(live, revisionCut(t), thread.changes, project.changes, project.tasks, footage) !== undefined)) return;
        }
        const verdicts = new Map<number, CutAssessment["verdict"]>();
        for (const assessment of live.cutAssessments ?? []) {
          if (!verdicts.has(assessment.index)) verdicts.set(assessment.index, assessment.verdict);
        }
        restored = [];
        for (let i = 0; i < review.cuts.length; i++) {
          const keep = decided[i] ? decided[i] === "keep" : verdicts.size > 0 && verdicts.get(i) !== "cut";
          if (keep) restored.push(i);
        }
      }
      autoApplied.current.add(`${applied}:apply`);
      const result = await approve(applied, undefined, restored);
      if (calls && result?.outcome === "sent_back") return;
      // A suggestion the video had moved on from is sent back: it is with Scarlet again, and its request says so in
      // the chat, so nothing is said here.
      if (result?.outcome === "conflict") throw new Error("The video changed while this was waiting. Scarlet is redoing it on the video as it is now.");
      // By the time it lands the editor may be on something else. A call, an edit, another suggestion or a clip from
      // Media they opened meanwhile isn't the change that was applied: the landing neither closes nor pauses it. A pass
      // applied with none of its calls open has nothing on screen that names it, and closes as the change applied.
      const { other, change: shown } = onScreen.current;
      if (!movedOn && !other && (shown ?? applied) === applied) closeReview();
      // Left as it is, what's on screen still isn't the applied suggestion's card: that one doesn't come back by itself.
      else setReviewId(id => id === applied ? undefined : id);
    } catch (e) {
      say(errorMessage(e));
    } finally {
      setDeciding(undefined);
    }
  }

  // The latest request's markers are asked for as the project opens. If that failed, opening one of its edits asks again.
  const reloadFailedMarkers = (thread: Thread) => { if (thread.id === threadTimeline.threadId && threadTimeline.error) threadTimeline.retry(); };
  const showing = !suggestion && !listening && threadTimeline.threadId === focus?.threadId ? threadTimeline.selected : undefined;
  onScreen.current = { other: !!showing || !!chosenSource, change: listening?.changeId ?? reviewId };
  // An applied cut's side, and whose words are open under the card. `at` starts the listen somewhere other than its
  // top. `visit` is footage another cut in this pass took out, which a click on the timeline went to Before to hear.
  const [cutSide, setCutSide] = useState<{ key: string; side: Side; take: number; at?: number; picked?: boolean; visit?: { at: string; start: number; end: number } }>();
  const [scriptFor, setScriptFor] = useState<string>();
  // Before, and a cut's open words, belong to one visit: the next cut opens unlit and folded, and so does this one
  // when the editor opens it again. A card that only reloads under them, as when a new working cut lands, keeps both.
  const startVisit = () => { setCutSide(undefined); setScriptFor(undefined); };
  const actions: ChatActions = {
    reviewLearning(id) { setLearnFocus(id); setPanel("learnings"); },
    atOnce: tasks.filter(t => isWorking(t.state) && t.kind !== "transcribe" && !isAsideTask(t)
      && !!t.context.changeId && (t.context.cutIndex !== undefined || t.context.editIndex !== undefined)).length,
    pass: undefined,
    showing,
    showingSingle: threadTimeline.single,
    showingFrom: openedFrom && showing && matchesEdit(showing, openedFrom.ref) ? openedFrom.run : undefined,
    marked: focusThread?.id,
    mark(threadId) {
      // Pressed again with nothing open, the marked band lets go: its edits come off the timeline and it is plain again.
      if (threadId === focusThread?.id && !showing && !listening && !suggestion) {
        // Its full list goes with them, since an open list keeps its request on the timeline.
        setLists(all => all[threadId] === "all" ? Object.fromEntries(Object.entries(all).filter(([id]) => id !== threadId)) : all);
        if (openList === threadId) setOpenList(undefined);
        setPicked(null);
        setFocus(undefined);
        return;
      }
      // Whatever was open goes with the timeline it was on, and so does another request's list of every edit.
      actions.stopShowing();
      setLists(all => Object.entries(all).some(([id, list]) => id !== threadId && list === "all")
        ? Object.fromEntries(Object.entries(all).filter(([id, list]) => id === threadId || list !== "all")) : all);
      if (openList !== threadId) setOpenList(undefined);
      setPicked(threadId === ordered.at(-1)?.id ? undefined : threadId);
      setFocus(undefined);
    },
    fitTimeline() { setFitTimeline(n => n + 1); },
    reviewingId: suggestion?.id,
    listening,
    listen(change, a) {
      // The same call opened again while it's open keeps its words where they are.
      if (listening?.changeId !== change.id || listening.index !== a.index) startVisit();
      setSourceChoice({ id: "", play: false });
      setReviewId(undefined);
      threadTimeline.clear();
      player.pause();
      const prior = revisionInput?.index === a.index && pass?.id === change.id ? revisionInput : undefined;
      setListening(prev => {
        // Opened again while it's open, it plays from the top as the video runs: Before is unlit until chosen again.
        const same = prev?.changeId === change.id && prev.index === a.index;
        return { changeId: prior?.previous.id ?? change.id, index: prior?.call.index ?? a.index, cut: { start: a.start, end: a.end }, side: "after", take: (prev?.take ?? 0) + 1,
          key: same ? prev.key : `${change.id}/${a.index}` };
      });
    },
    play(thread, change) {
      // The request's line pressed again while its edit is open plays that edit again as its row does: on the side it
      // was on, with its words left open. The message box is aimed at it again, as on any press of the line.
      const first = thread.id === focus?.threadId ? threadTimeline.edits.find(e => belongsTo(e, change)) : undefined;
      if (first && showing && matchesEdit(showing, first)) { actions.openEdit(thread, first); setAimAgain(n => n + 1); return; }
      startVisit();
      player.pause();
      setSourceChoice({ id: "", play: false });
      setReviewId(undefined);
      setListening(undefined);
      if (thread.id === focus?.threadId && !threadTimeline.loading) {
        const edit = threadTimeline.edits.find(e => belongsTo(e, change));
        if (edit) { threadTimeline.choose(edit, "chat"); setAimAgain(n => n + 1); return; }
      }
      reloadFailedMarkers(thread);
      if (thread.id !== focus?.threadId) wentSince.current = newest;
      setFocus({ threadId: thread.id, changeId: change.id });
    },
    playEdit(edit, single) {
      startVisit();
      player.pause();
      setSourceChoice({ id: "", play: false });
      setReviewId(undefined);
      setListening(undefined);
      threadTimeline.choose(edit, "chat", single);
      setAimAgain(n => n + 1);
    },
    openEdit(thread, ref, from, single) {
      // The edit that's open, pressed again, plays again from the top: its card and the timeline's zoom stay. A cut
      // starts over as the video runs, unlit; any other edit keeps its side. Esc is what closes it. A cut plays under
      // this view's own listen; any other edit under the player's. A moment's main edit picked on its own from under
      // the moment's row, or the moment picked again from its row, is opened anew.
      const sameWay = threadTimeline.single === !!single;
      if (showing && matchesEdit(showing, ref) && thread.id === focus?.threadId && sameWay) {
        setOpenedFrom(from ? { run: from, ref: { changeId: ref.changeId, spot: ref.spot } } : undefined);
        player.pause();
        if (cutKey) setCutSide(prev => ({ key: cutKey, side: "after", take: (prev?.key === cutKey ? prev.take : 0) + 1 }));
        // Choosing it again takes the aim off an empty message box, so the box is aimed at the edit again.
        else { threadTimeline.choose(showing, "chat"); setAimAgain(n => n + 1); }
        return;
      }
      startVisit();
      setOpenedFrom(from ? { run: from, ref: { changeId: ref.changeId, spot: ref.spot } } : undefined);
      player.pause();
      setSourceChoice({ id: "", play: false });
      setReviewId(undefined);
      setListening(undefined);
      if (thread.id === focus?.threadId && !threadTimeline.loading) {
        const edit = threadTimeline.edits.find(e => matchesEdit(e, ref)) ?? threadTimeline.rejected.find(e => matchesEdit(e, ref));
        if (edit) { threadTimeline.choose(edit, "chat", single); setAimAgain(n => n + 1); return; }
      }
      reloadFailedMarkers(thread);
      if (thread.id !== focus?.threadId) wentSince.current = newest;
      setFocus({ threadId: thread.id, changeId: ref.changeId, spot: ref.spot, ...single && { single } });
    },
    listOpen(threadId, open, moved) {
      setOpenList(current => open ? threadId : current === threadId ? undefined : current);
      if (open && !moved) setFocus(f => f?.threadId === threadId ? f : { threadId });
    },
    lightMark: (time, row) => {
      // A row's dot is where its footage is on the version the timeline shows.
      const view = callViewNow.current;
      hoveredEdit.setState(time !== undefined && view ? view.toBase(time) ?? time : time, true);
      hoveredRow.setState(row, true);
    },
    stopShowing() {
      setOpenedFrom(undefined);
      player.pause();
      threadTimeline.clear();
      setListening(undefined);
      setReviewId(undefined);
    },
    review(change) {
      player.pause();
      setSourceChoice({ id: "", play: false });
      threadTimeline.clear();
      setListening(undefined);
      setReviewId(change.id);
      setReviewPlays(n => n + 1);
    },
    revise(thread, change) {
      const edit = actions.showing && belongsTo(actions.showing, change) ? actions.showing : undefined;
      const target = edit && threadTimeline.selectedTarget;
      if (edit && target) return startRevision(thread, target, `“${edit.label}” at ${clockLabel(edit.at ?? edit.range.start)}`);
      const range = change.ranges[0];
      startRevision(thread, { changeId: change.id, version: change.appliedVersion ?? change.toVersion, time: range?.start ?? 0, end: range?.end,
        clipIds: [], label: "Revision" }, "this whole edit");
    },
    reply(thread) {
      // As Revise does, Answer waits for a message being spoken to go out: aiming the box now would drop it.
      if (useUiStore.getState().speaking) return;
      const question = thread.question;
      if (pass && question?.cutConflict?.range) {
        const index = passIndex(question);
        const call = allCalls.find(a => a.index === index);
        if (call) actions.listen(pass, call);
      }
      aimForItem.current = false;
      countAim();
      openDraft(current.id, thread.id);
      setTargetLabel(undefined);
      setReplyTo(thread.id);
      const ui = useUiStore.getState();
      // The answer goes to the question. A cut or an edit the box was on would make it a revision of that instead.
      ui.setAgentContext(null);
      ui.focusComposer();
    },
  };

  const settingsOpen = useUiStore(s => s.projectSettingsOpen);
  const workspaceActive = !setupOpen && !panel && !settingsOpen;
  // A pass can stage hundreds of cuts: work out its calls and their revisions only when the pass or its tasks change.
  // Until the pass's cut list arrives, its staged cuts stand in for it. They are the same cuts, so a call on screen
  // stays there through the moment a new part or a revised cut replaces the proposal.
  const passCuts = useMemo(() => pass && cutReview.review === undefined ? stagedCuts(pass).map(removed => ({ removed })) : cutReview.review?.cuts,
    [pass, cutReview.review]);
  const allCalls = useMemo(() => pass ? reviewCalls(pass, passCuts, passOver,
    revisionInput && { ...revisionInput.call, index: revisionInput.index }) : [], [pass, passCuts, passOver, revisionInput]);
  const passEdits = passThread ? listedPassEdits : noEdits;
  // While a pass waits on the editor, its calls and the edits of its request that ask for a look are one run of
  // numbers: each says the same number in the list, on the timeline and on its card, and is named as what it is,
  // "Cut 6", or "Edit 6" for one that took no footage out. Shown for the first time together, the calls come first, in
  // the order they reached the editor, then the edits in timeline order. From then on each keeps the
  // number it was shown under (`needNumbers`): a call or an edit that arrives later takes the next one, wherever it is
  // in the video, so nothing the editor has seen is renumbered while the pass is still at work.
  const passRoot = pass ? (stagingTask(pass, changes, tasks) ?? tasks.find(t => t.id === pass.taskId)) : undefined;
  const { callNo, passEditNo } = useMemo(() => {
    const callNo = new Map<number, number>(), passEditNo = new Map<string, { n: number; name: string }>();
    if (!pass || !passThread) return { callNo, passEditNo };
    // A legacy pass receives publication numbers on the first new ask. Match the row it already showed by
    // the slot in that same proposal; the same index in a later proposal can belong to different footage.
    const callKeys = allCalls.map(a => {
      const slot = `slot/${pass.id}/${a.index}`;
      return a.askOrder === undefined ? { key: `cut/${a.index}`, rememberAs: slot } : { key: `ask/${a.askOrder}`, previous: slot };
    });
    const at = (e: { range: { start: number } }) => (e as { at?: number }).at ?? e.range.start;
    const edits = passEdits.filter(e => !!e.check).sort((a, b) => at(a) - at(b));
    const editKeyOf = (e: (typeof edits)[number]) => `edit/${editKey(e.previous[0] ?? e)}`;
    const numbers = needNumbers(current.id, passThread.id, passRoot?.resumeRootId ?? passRoot?.id ?? pass.id, [...callKeys, ...edits.map(editKeyOf)]);
    allCalls.forEach((call, i) => callNo.set(call.index, numbers.get(callKeys[i]!.key)!));
    for (const e of edits) {
      const n = numbers.get(editKeyOf(e))!;
      const name = `${e.beforeCut || editKindWord(e) === "Cut" ? "Cut" : "Edit"} ${n}`;
      for (const ref of [e, ...e.previous]) passEditNo.set(editKey(ref), { n, name });
    }
    return { callNo, passEditNo };
  }, [pass, passThread?.id, passRoot?.id, allCalls, passEdits, current.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A call says its place among the calls ("Cut 2 of 5") while its number is one of theirs. A call that arrived after
  // the edits were numbered has a number past them, and says the number alone.
  const ofCalls = (n?: number) => n !== undefined && n <= allCalls.length ? ` of ${allCalls.length}` : "";
  const revisions = useMemo(() => pass ? callRevisions(pass, tasks, changes) : undefined, [pass, tasks, changes]);
  const queuedCuts = new Set(cutRuns.keys());
  const sentBack = (index: number) => index === revisingIndex || queuedCuts.has(index);
  const asks = allCalls.filter(a => !sentBack(a.index));
  const cutCount = passCuts?.length ?? pass?.cutReasons?.length ?? 0;
  const passChoices = pass ? choicesOf(pass) : {};
  // The calls still waiting on the editor: the ones For you counts.
  const waiting = (a: Call) => !sentBack(a.index) && passChoices[a.index] === undefined;
  const waitingCalls = allCalls.filter(waiting);
  const remainingCalls = listening ? waitingCalls.filter(a => a.index !== listening.index) : [];
  const currentIndex = listening ? allCalls.findIndex(a => a.index === listening.index) : -1;
  const nextCallAfterDecision = listening ? allCalls.slice(currentIndex + 1).find(waiting) ?? remainingCalls[0] : undefined;
  // A call's number is the order it reached the editor in: a later ask, or the cuts the pass hands over
  // when it ends, never renumber the calls the editor has seen. A request about that cut, its card, its line in the
  // list and its dot on the timeline all say "Cut 2".
  const callNumber = (about: { changeId?: string; cutIndex?: number }) => {
    if (!pass) return undefined;
    const index = callNow(pass, about, passThread?.changes ?? [], changes, tasks, footage);
    return index === undefined ? undefined : callNo.get(index);
  };
  const cutName = (about: { changeId?: string; cutIndex?: number; editIndex?: number }) => {
    if (about.editIndex !== undefined && about.changeId) return passEditNo.get(`${about.changeId}/${about.editIndex}`)?.name;
    const n = callNumber(about);
    return n ? `Cut ${n}` : undefined;
  };
  actions.cutName = cutName;
  actions.callNumber = (changeId, cutIndex) => callNumber({ changeId, cutIndex });
  // Where each call goes in the list: at its time on the working cut, among the edits made there. One that isn't there
  // as it was staged goes where what is left of its footage sits, or else with the call before it, so the calls keep
  // their order. Until the pass's version is in, the calls keep the pass's own times.
  const listedAt = new Map<number, number>();
  for (const a of allCalls) {
    const override = overrideForCall(a.index);
    listedAt.set(a.index, override ? override.range.start : placing ? a.start
      : placeCut(a)?.start ?? toWorkingCut?.map(a.start, "right") ?? toWorkingCut?.map(a.end, "left") ?? [...listedAt.values()].at(-1) ?? 0);
  }
  if (pass && passThread) actions.pass = {
    change: pass, threadId: passThread.id, cuts: cutCount,
    running: passRunning, unchecked: passRunning && !allCalls.length &&
      (!pass.cutAssessments?.length || pass.cutAssessments.some(a => a.provisional)), scheduled: passRunning && applyWhenDone(pass), deciding: deciding === pass.id,
    revising: !!revision, error: decideError || pass.error || "",
    editNumbers: passEditNo,
    calls: allCalls.map(a => {
      const history = revisions?.get(a.index) ?? noRevisions;
      const past = revisionInput?.index === a.index ? history.slice(0, -1) : history;
      const edit = overrideForCall(a.index);
      const at = edit ? (edit.version === head ? edit.range.start : undefined) : placeCut(a)?.start;
      return { index: a.index, askOrder: a.askOrder, n: callNo.get(a.index)!, start: listedAt.get(a.index)!, at, summary: a.summary || a.reason, version: past.length + 1, earlier: past.at(-1),
        run: cutRuns.get(a.index),
        state: sentBack(a.index) ? "revising" : passChoices[a.index] === undefined ? "open" : passChoices[a.index] === approves(a) ? "approved" : "skipped" };
    }),
    openCall: index => { const call = allCalls.find(a => a.index === index); if (call) actions.listen(pass, call); },
    apply: () => void (passRunning ? saveChoices(pass, choicesOf(pass), true) : approveReview(pass)),
  };
  // The pass goes in once nothing is left to decide: no call waits on the editor and no cut is with Scarlet. The editor's
  // last call does this itself; this covers a pass that gets there another way, such as a run that ends with every
  // call made, or one that asked nothing. While Scarlet still checks, it is set to go in when it finishes. Each state is
  // tried once: an apply that fails says why, with Retry, instead of trying again by itself.
  const autoApply = !current.project.editingPaused && pass && passThread && pass.state === "ready" && !revision && !queuedCuts.size && !waitingCalls.length
    // It waits for the pass's cut list, and once that fails to load, tries so the reason shows, with Retry.
    && (cutReview.review !== undefined || !!cutReview.error) && !deciding && !decideError && !pass.error
    && (passRunning ? !!pass.cutAssessments?.length && asks.length > 0 && !applyWhenDone(pass) : true)
    ? `${pass.id}:${passRunning ? "schedule" : "apply"}` : undefined;
  useEffect(() => {
    if (!autoApply || !pass || autoApplied.current.has(autoApply)) return;
    autoApplied.current.add(autoApply);
    if (passRunning) void saveChoices(pass, choicesOf(pass), true);
    else void approveReview(pass);
  }, [autoApply]); // eslint-disable-line react-hooks/exhaustive-deps
  const span = (r: { start: number; end: number }) => `${clockLabel(r.start)}–${clockLabel(r.end)} · ${lengthLabel(r.end - r.start)}`;
  // Only the calls still waiting on the editor are marked, each with its number, amber as in the chat. A decided call's dot goes.
  // A call's dot never shares a pill with an edit's: the two count apart.
  // A dot sits where the cut's footage is on the working cut. A cut that can't be placed there has no dot.
  // While a suggestion plays the timeline is the suggestion's, as it is a call's or an edit's while that is open: After
  // is on the version it proposes, where the pass's cuts sit elsewhere. The calls' dots are back when it closes.
  // The calls are on the timeline while the timeline is the pass's, while one of them is open, and while the editor
  // hasn't picked a request in the chat or gone to another's edit: they hold the next request. Another request picked,
  // or the marked band let go, the timeline marks only that request's edits, or nothing, and For you leads to them.
  const callsShown = !!pass && (passThread?.id === focusThread?.id || listening?.changeId === pass.id || (picked === undefined && !focus));
  const marks: TimelineDot[] = pass && !suggestion
    ? !callsShown ? [] : allCalls.flatMap(a => {
      const override = pass.cutEdits?.find(c => c.index === a.index);
      const at = sentBack(a.index) || passChoices[a.index] !== undefined ? undefined
        : override ? override.version === (pinnedCallVersion ?? head) ? override.range : undefined
        : pinnedCallVersion ? undefined : placeCut(a);
      return at ? [{ time: at.start, n: callNo.get(a.index), group: "call", title: `Cut ${callNo.get(a.index)}${ofCalls(callNo.get(a.index))} · ${clockLabel(at.start)}`, summary: a.reason,
        detail: `Removes ${lengthLabel(a.end - a.start)}`, context: pass.description, state: "check" as const, need: `Cut ${callNo.get(a.index)}`,
        current: listening?.changeId === pass.id && listening.index === a.index, open: () => actions.listen(pass, a) }] : [];
    })
    // A suggestion's band is on the place the player is on. Each of its other places is a dot beside it, and a press
    // on one moves the player and the band there. The place on screen has a dot only when it has no band, as when it
    // runs over most of the video: a press on that one scrubs, as on any point of the timeline.
    : places.flatMap((r, i): TimelineDot[] => i === shownPlace && suggestionLine ? [] : [{ time: r.start, title: `Suggestion · ${clockLabel(r.start)}`, summary: suggestion?.description,
      detail: span(r), ...i !== shownPlace && { open: () => { player.pause(); setPlace(i); } } }]);
  // The call that's open, also one sent back for revision: it keeps its note, Before and After while Scarlet works on it.
  const openCall = listening && listening.changeId === pass?.id ? allCalls.find(a => a.index === listening.index) : undefined;
  const openCallBack = !!openCall && sentBack(openCall.index);
  // What the video shows of the open call. Nothing, while its cut isn't on the working cut to be shown.
  const cutPosition = openCall && heard ? `cut at ${clockLabel(heard.start)} · ${callNo.get(openCall.index)}${ofCalls(callNo.get(openCall.index))}` : "";
  const shownEdit = actions.showing;
  const reviewed = useReviewed(current.id, focusThread);
  const revisingEdit = useRevising(focusThread);
  const reviewRange = shownEdit?.check && !reviewed(shownEdit) && !revisingEdit(shownEdit) ? shownEdit.reviewRange : undefined;
  const shownAt = shownEdit && (shownEdit.at ?? shownEdit.range.start);
  // The applied edit on screen, so Revise is about it and not a proposal still waiting.
  // An edit another request made is open here when this request flagged it (`Thread.flagged`).
  const shownChange = shownEdit && focusChanges.find(c => belongsTo(shownEdit, c));
  // Keep (K) records that the edit was reviewed and moves on to the next flagged edit that hasn't been; Revise (R) changes this one.
  const reviewingEdit = shownEdit && shownChange && focusThread ? shownEdit : undefined;
  const threadEdits = threadTimeline.edits;
  // An applied cut is gone from the working cut, so it plays on the version before it, where the timeline shades
  // what came out. After steps over it, as the video plays now; Before plays through it.
  const beforeCut = reviewingEdit?.beforeCut;
  const madeBy = useMemo(() => {
    const change = reviewingEdit?.beforeCut && focusThread && cutChange(reviewingEdit, focusThread.changes);
    return change && appliedCutSource(change);
  }, [reviewingEdit, focusThread]);
  // After plays the version the cut made. Once later batches, revisions or other requests have changed the video
  // since, it plays the video as it runs now, which has this cut's join and theirs: the same version for the card,
  // for the file and window prepared ahead of it, and for the clock that maps it onto this timeline.
  const latestAfter = useMemo(() => afterOf(madeBy, beforeCut?.version), [madeBy, beforeCut?.version, head]); // eslint-disable-line react-hooks/exhaustive-deps
  // While the cut plays, After stays on the version it started on. A pass applying its next cuts moves the video on
  // every moment, and following it put up a new player each time, before the last had played a frame: nothing
  // played. Once the editor pauses, or the cut changes or another opens, it takes up the video as it runs now.
  const playingNow = usePlayerStore(s => s.playing);
  const heldAfter = useRef<{ key?: string; source?: typeof latestAfter }>(undefined);
  const afterKey = reviewingEdit && editPlaybackKey(reviewingEdit);
  // A cut the editor just rejected holds it too, for the moment it takes to leave the timeline: the video without it
  // lands meanwhile, and its card would start on a version it isn't in.
  const afterSource = (playingNow || threadTimeline.leaving) && latestAfter && heldAfter.current?.source && heldAfter.current.key === afterKey
    ? heldAfter.current.source : latestAfter;
  heldAfter.current = { key: afterKey, source: afterSource };
  const holdingAfter = afterSource !== latestAfter;
  const appliedAfterVersion = afterSource?.version;
  const preparedEdit = reviewingEdit ? preparedCandidates.get(editPlaybackKey(reviewingEdit, appliedAfterVersion)) : undefined;
  const cutBefore = useReviewTimeline(current.id, beforeCut?.version, preparedEdit?.before.timeline ?? timeline);
  const beforeTimeline = cutBefore.timeline ?? undefined;
  const beforeDuration = useMemo(() => beforeTimeline ? timelineDuration(beforeTimeline) : 0, [beforeTimeline]);
  // The side the editor chose and the listen they started belong to this opening of this edit, whichever version of
  // it is on the card: `openPick` is the same until the edit closes, another opens, or its row is pressed again.
  const openPick = reviewingEdit ? `${firstKey(reviewingEdit)}/${threadTimeline.request}` : undefined;
  const cutKey = reviewingEdit && beforeCut && beforeDuration > 0 ? firstKey(reviewingEdit) : undefined;
  const appliedCut = cutKey ? beforeCut!.removed : undefined;
  const shownSide = cutKey && cutSide?.key === cutKey ? cutSide : undefined;
  const appliedSide: Side = shownSide?.side ?? "after";
  const visiting = shownSide?.side === "before" ? shownSide.visit : undefined;
  const cutAfter = useReviewTimeline(current.id, appliedAfterVersion,
    appliedAfterVersion === timeline?.version ? timeline : preparedEdit?.after.timeline ?? timeline);
  const afterTimeline = cutAfter.timeline;
  const workingAfter = holdingAfter ? afterTimeline?.version === afterSource?.version ? afterTimeline : undefined
    : afterTimeline?.version === head ? afterTimeline : timeline?.version === head ? timeline : undefined;
  // The pass's other cuts, in this cut's clock. Each goes by its time in the video as it runs now, as its row in the
  // pass's list and its tag in the message box do: "Cut at 3:04".
  const sameVersion = useMemo(() => appliedCut ? threadEdits.flatMap(e => e !== reviewingEdit && e.beforeCut?.version === beforeCut!.version
    ? [{ at: clockLabel(e.at ?? e.range.start), label: e.label as string | undefined, removed: e.beforeCut.removed }] : []) : [], [appliedCut, threadEdits, reviewingEdit, beforeCut]);
  // A pass applies its cuts in batches, and this cut's version is the one before its own batch. What came out since,
  // in later batches, revisions or other requests, isn't in the video as it runs now either: it's shaded here the
  // same way, by its time now, and After steps over it.
  const since = useMemo(() => appliedCut && beforeTimeline && workingAfter && workingAfter.version !== beforeTimeline.version
    ? removedSince(beforeTimeline, workingAfter, fps) : undefined, [appliedCut, beforeTimeline, workingAfter, fps]);
  const otherEdits = useMemo(() => !since || !appliedCut ? sameVersion : [...sameVersion,
    ...besides(since, [appliedCut, ...sameVersion.map(o => o.removed)], fps).map(({ removed, at }) => ({ at: clockLabel(at), removed,
      label: threadEdits.find(e => e.beforeCut && Math.abs((e.at ?? e.range.start) - at) < 1.5 / fps)?.label }))]
    .sort((a, b) => a.removed.start - b.removed.start), [sameVersion, since, appliedCut, threadEdits, fps]);
  const otherCuts = useMemo(() => otherEdits.map(o => o.removed), [otherEdits]);
  const othersKey = useMemo(() => JSON.stringify(otherCuts), [otherCuts]);
  // Both sides use the same review window. After can travel farther on the source clock to play its kept tail. A
  // moment led by this cut plays on through the edits that run on from its join, so the moment is seen once, whole.
  const momentJoin = reviewingEdit?.at ?? reviewingEdit?.range.start;
  const momentTail = threadTimeline.selectedMoment && momentJoin !== undefined ? Math.max(0, threadTimeline.selectedMoment.end - momentJoin) : 0;
  const afterListen = useMemo(() => appliedCut && cutAudition(appliedCut, "after", beforeDuration,
    { others: otherCuts, beyond: true, ...momentTail > 0 && { tailFrom: appliedCut.end + momentTail } }),
    [cutKey, appliedCut?.start, appliedCut?.end, beforeDuration, othersKey, momentTail]); // eslint-disable-line react-hooks/exhaustive-deps
  const appliedListen = useMemo(() => {
    if (!appliedCut) return;
    if (appliedSide === "after" && shownSide?.at === undefined) return afterListen;
    const listen = cutAudition(appliedCut, appliedSide, beforeDuration, {
      others: otherCuts, whole: true, tailFrom: shownSide?.visit?.end ?? shownSide?.at, beyond: true,
    });
    // A point picked on the timeline plays on from there until the editor pauses it.
    return shownSide?.at === undefined ? listen : shownSide.picked ? { ...listen, from: shownSide.at, through: true } : { ...listen, from: shownSide.at };
  }, [afterListen, appliedSide, shownSide?.take]); // eslint-disable-line react-hooks/exhaustive-deps
  // After plays the version the cut made, where its join is inside the rendered media, through a clock that keeps
  // the timeline on the version before it. Seeking past the shaded passage while it played let the removed
  // footage's first sounds through before the jump landed.
  // When later batches or requests have changed the video since this cut's own save, After plays the video as it
  // runs now, which has this cut's join and theirs. Its clock compares the two versions, so footage put back
  // elsewhere lines up too.
  // The version the cut made and whether it has a saved file are asked for with the version before it, not after,
  // so After starts as soon as that one arrives.
  const appliedJoined = useMemo(() => {
    if (!appliedListen || appliedSide !== "after" || !appliedCut || !afterSource || !beforeTimeline || !afterTimeline) return;
    const clock = appliedCutClock(beforeTimeline, afterTimeline, afterSource.removed, fps, appliedCut, appliedListen);
    return clock ? { version: afterSource.version, timeline: afterTimeline, clock } : undefined;
  }, [appliedListen, appliedCut, afterSource, beforeTimeline, afterTimeline, fps]); // eslint-disable-line react-hooks/exhaustive-deps
  const appliedFile = usePlaybackCache(current.project, { version: appliedAfterVersion, settingsRevision: current.renderSettingsRevision });
  // Wait for the version the cut made, and to know whether it has a saved file, before starting After, so the listen
  // doesn't change players partway.
  const appliedCache = appliedFile.cache ?? (appliedJoined && preparedEdit?.after.version === appliedJoined.version
    ? { url: preparedEdit.after.file, state: preparedEdit.after.file ? "ready" : "uncached" } : undefined);
  // A file or window prepared ahead belongs to one version. It plays only under the clock made for that version.
  const preparedAfter = appliedJoined && preparedEdit?.after.version === appliedJoined.version ? preparedEdit.after : undefined;
  const joinPending = appliedSide === "after" && !!afterSource && (!afterTimeline || (!!appliedJoined && !appliedCache));
  const cutLoadError = cutBefore.error ? { message: "Couldn’t load the earlier version.", reason: cutBefore.error, retry: cutBefore.retry }
    : appliedSide === "after" && cutAfter.error ? { message: "Couldn’t load the version for After.", reason: cutAfter.error, retry: cutAfter.retry } : undefined;
  // The player for After: the version with the join in its media, once it's known how it plays.
  const joinedListen = appliedCut ? appliedJoined : callView ? viewJoined : listenJoined;
  const joinedFile = appliedCut ? appliedCache : listenCache;
  const joinedPlayer = useMemo(() => joinedListen && joinedFile ? { ...joinedListen, file: joinedFile.url, cache: joinedFile.state } : undefined,
    [joinedListen, joinedFile?.url, joinedFile?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // An applied cut plays on the version before it. Until that version arrives nothing plays: the working edit
  // starting on the passage and stopping a moment later is a flash of the wrong picture and a clipped sound. If it
  // fails, the editor can retry from the monitor or the transcript.
  const cutWaits = !!beforeCut && !beforeTimeline;
  // As with a call, only the editor starts the listen. A new working cut landing under it leaves it where it is, and
  // so does a revision of the open cut: it is taken up as it was, paused if the editor paused it, also when its new
  // version takes a moment to arrive. `heardPick` is shared with the player's own passage, which plays an edit that
  // isn't a cut: an edit that changes from one to the other when its revision lands isn't started again either.
  const playedApplied = useRef<{ pick: string; chosen: string }>(undefined);
  const heardPick = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (playedApplied.current?.pick !== openPick) playedApplied.current = undefined;
    if (heardPick.current !== openPick) heardPick.current = undefined;
    if (!appliedListen || !openPick || joinPending) return;
    return afterPlayerMount(() => {
      const chosen = `${appliedSide}/${shownSide?.take ?? 0}`;
      const again = quietOpen.current || (playedApplied.current ? playedApplied.current.chosen === chosen : !shownSide && heardPick.current === openPick);
      quietOpen.current = false;
      playedApplied.current = { pick: openPick, chosen };
      heardPick.current = openPick;
      return again ? player.audition(appliedListen, fps, true) : player.audition(appliedListen, fps);
    });
  }, [appliedListen, fps, joinPending, appliedJoined?.version, openPick, shownSide?.take]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pressing the side on screen again plays it from the top. Back to After from another cut's footage picks up at
  // that cut's join, so it plays as the edit does.
  const chooseCutSide = (side: Side) => {
    if (!cutKey) return;
    player.pause();
    const at = side === "after" && visiting ? visiting.end : undefined;
    setCutSide(prev => ({ key: cutKey, side, take: (prev?.key === cutKey ? prev.take : 0) + 1, at }));
  };
  // On After the pass's other cuts are out of the media: they grey out, and a click plays one in Before from that point.
  // The grey and its name already say After skips it, so the hover note only says how much it took and Scarlet's words for it.
  // On Before they play, so they're only outlined.
  const gaps: TimelineGap[] = otherEdits.map(({ at, label, removed }) => ({ start: removed.start, end: removed.end,
    title: `Cut at ${at} · ${lengthLabel(removed.end - removed.start)}`, summary: label, label: `Cut at ${at}`, shortLabel: at,
    skipped: appliedSide === "after" }));
  // A call shown where the cuts around it still have their footage marks them the same way, by their time on the
  // working cut and with Scarlet's words for the one that made each.
  const callGaps: TimelineGap[] | undefined = callView?.shown.map(({ at, removed }) => {
    const made = [...locatedPassEdits ?? [], ...threadEdits].find(e => e.beforeCut && e.at !== undefined && Math.abs(e.at - at) < 1.5 / fps);
    return { start: removed.start, end: removed.end, title: `Cut at ${clockLabel(at)} · ${lengthLabel(removed.end - removed.start)}`, summary: made?.label,
      label: `Cut at ${clockLabel(at)}`, shortLabel: clockLabel(at), skipped: listening?.side === "after" };
  });
  const hearInBefore = (gap: TimelineGap, time: number) => {
    if (callGaps) return hearGapInCall(gap, time);
    const other = otherEdits.find(o => o.removed.start === gap.start && o.removed.end === gap.end);
    if (!cutKey || !other) return;
    player.pause();
    setCutSide(prev => ({ key: cutKey, side: "before", take: (prev?.key === cutKey ? prev.take : 0) + 1, at: time, picked: true,
      visit: { at: other.at, start: gap.start, end: gap.end } }));
  };
  // A click inside this cut's own passage on the timeline: After steps over it, so it plays in Before from there.
  const hearCutFrom = (time: number) => {
    if (!cutKey) return;
    player.pause();
    setCutSide(prev => ({ key: cutKey, side: "before", take: (prev?.key === cutKey ? prev.take : 0) + 1, at: time, picked: true }));
  };
  // The shaded passage takes a click only while the playing side steps over it. On Before it plays, and scrubs as any footage.
  const onBand = cutKey ? (appliedSide === "after" ? hearCutFrom : undefined)
    : openCall && !conflict && listening?.side === "after" ? callView ? (time: number) => listenFrom(callView.toWorking.toMedia(time)) : listenFrom : undefined;
  // Closing a call shown on an earlier version goes back to the working cut at the same footage, or at the join of the
  // cut whose footage was playing.
  const leftCallView = useRef<JoinClock>(undefined);
  useEffect(() => {
    if (callView) { leftCallView.current = callView.toWorking; return; }
    const clock = leftCallView.current;
    leftCallView.current = undefined;
    if (clock && !listening && !reviewingEdit && !suggestion && !source) player.seek(clock.toMedia(usePlayerStore.getState().time), true);
  }, [callView?.toWorking, !!listening]); // eslint-disable-line react-hooks/exhaustive-deps
  // Closing the cut goes back to the working cut at its join, not at the same time on the earlier version.
  const leftCut = useRef<number>(undefined);
  useEffect(() => {
    if (cutKey) { leftCut.current = shownAt; return; }
    const at = leftCut.current;
    leftCut.current = undefined;
    // A call, a suggestion or a clip opened straight from the cut has the player now: it starts where it means to.
    if (at !== undefined && !reviewingEdit && !listening && !suggestion && !source) player.seek(at, true);
  }, [cutKey, !!reviewingEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  // Settings and a restart to update come back to this page, and first ask it where the editor is. The answer is a
  // time on the working cut, which the player's own time isn't while something else plays: an open cut is on the
  // version before it, so its place is its join, as when it closes; behind a clip from Media it is where the cut was
  // left. A suggestion's After is a version that isn't the working cut yet, so it has no time to give. The speed
  // they were watching at goes with the place.
  const placeOnCut = () => draftVersion ? undefined : chosenSource ? cutPlace.current : cutKey ? shownAt : usePlayerStore.getState().time;
  const placeNow = useRef(placeOnCut);
  placeNow.current = placeOnCut;
  const openNow = useRef<() => string | undefined>(() => undefined);
  openNow.current = () => openCall && pass ? `call:${pass.id}:${openCall.index}`
    // Until it has been opened again, what is to be opened is still what was open.
    : reviewingEdit && focusThread ? `edit:${focusThread.id}:${reviewingEdit.changeId}:${reviewingEdit.spot}` : reopen;
  const panelNow = useRef(panel);
  panelNow.current = panel === "media" ? panel : null;
  // Open again what was open at the last quit, once its request and its calls are here. One that is gone since, a call
  // decided or a pass applied meanwhile, opens nothing.
  const reviewRead = cutReview.review !== undefined || !!cutReview.error;
  useEffect(() => {
    // At launch the project's requests and edits are read a moment after the page is up: until they are, nothing is gone.
    if (!reopen || current.reviewStatus === "loading") return;
    const [kind, first, second, third] = reopen.split(":");
    if (kind === "edit") {
      const thread = threads.find(t => t.id === first);
      const spot = Number(third);
      if (thread && second && Number.isInteger(spot)) { quietOpen.current = true; actions.openEdit(thread, { changeId: second, spot }); }
    } else if (kind === "call" && pass && pass.id === first) {
      const call = allCalls.find(a => a.index === Number(second));
      // Its calls are still being read: wait for them.
      if (!call && !reviewRead) return;
      if (call) { quietOpen.current = true; actions.listen(pass, call); }
    }
    setReopen(undefined);
  }, [reopen, current.reviewStatus, pass?.id, allCalls.length, reviewRead]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const bookmark = (event: Event) => {
      const at = placeNow.current();
      if (at === undefined) return;
      const place = (event as CustomEvent<URL>).detail.searchParams;
      place.set("t", String(at));
      const { rate } = usePlayerStore.getState();
      if (rate !== 1) place.set("speed", String(rate));
      // What is open goes with the place: the drawer, and the call, cut or edit on its card.
      const open = openNow.current();
      if (open) place.set("open", open);
      if (panelNow.current) place.set("panel", panelNow.current);
    };
    window.addEventListener("scarlet:bookmark-project", bookmark);
    return () => window.removeEventListener("scarlet:bookmark-project", bookmark);
  }, []);
  const onVideo = openCall && conflict ? (heard && callTimeline ? `Current passage at ${clockLabel(heard.start)}` : undefined)
    : openCall && visit?.side === "before" ? `Showing what the cut at ${visit.label} took out · Before`
    : openCall ? (cutPosition ? `Showing ${cutPosition} · ${listening!.side === "after" ? "After" : "Before"}${pinnedCallVersion ? " · As reviewed" : ""}` : undefined)
    : suggestion ? `Showing the suggestion · ${side === "after" ? "After" : "Before"}`
    : shownEdit && visiting ? `Showing what the cut at ${visiting.at} took out · Before`
    : shownEdit && appliedCut ? `Showing “${shownEdit.label}” · ${appliedSide === "after" ? "After" : "Before"}`
    : shownEdit ? `Showing “${shownEdit.label}” at ${clockLabel(reviewRange?.start ?? shownEdit.at ?? shownEdit.range.start)}`
    : chosenSource && source === chosenSource ? `Showing ${chosenSource.name}` : undefined;
  // A call's passage is shaded where its footage is on the working cut. One that can't be placed there shades nothing.
  // A call's cut isn't in the video until the editor approves it, so its band is drawn as any cut's with a dashed edge.
  const callFocus = listening ? callView ? callView.focus : heard && callTimeline && focusAround(heard, callDuration ?? 0, conflict ? "Current passage" : `Removed · ${lengthLabel(heard.end - heard.start)}`) : undefined;
  const lineFocus = listening ? callFocus ? { ...callFocus, tone: "proposed" as const } : undefined
    : places.length ? suggestionLine
    : appliedCut ? focusAround(appliedCut, beforeDuration, `Removed · ${lengthLabel(appliedCut.end - appliedCut.start)}`, { playbackEnd: afterListen?.end })
    // Until the earlier version arrives, a line marks the join in the working cut and says how much came out there.
    : shownEdit?.beforeCut ? focusAround({ start: shownAt!, end: shownAt! }, cutDuration ?? 0,
      `Removed · ${lengthLabel(shownEdit.beforeCut.removed.end - shownEdit.beforeCut.removed.start)}`)
    // A rejected edit is out of the video: its band is where it was, outlined, over the video as it runs without it.
    : shownEdit?.rejected ? focusAround(shownEdit.at !== undefined ? { start: shownEdit.at, end: shownEdit.at } : shownEdit.range, cutDuration ?? 0, "Rejected", { tone: "kept" })
    // Any other edit is drawn for what it did: a sound fix or a zoom keeps its footage, so After plays it.
    // A doubt Scarlet left is the passage it asks the editor to look at or hear: amber, as what waits on them is.
    : reviewRange ? focusAround(reviewRange, cutDuration ?? 0, "Check", { tone: "check" })
    // A moment is drawn across all of its edits, as it plays.
    : shownEdit ? editFocus(threadTimeline.selectedMoment ? { ...shownEdit, range: momentRange(threadTimeline.selectedMoment) } : shownEdit, cutDuration ?? 0) : undefined;
  const playerView = suggestion || appliedCut ? undefined : !listening && focusThread && !source ? threadTimeline : undefined;
  // Each applied edit's dot names it, says where it sits and how long it runs, and quotes the change it came from.
  const editDot = (thread: Thread, e: ThreadEdit, title: string, at: number): TimelineDot => {
    const landed = justLanded(e.changeId) ? e.beforeCut || e.at !== undefined ? "cut" as const : "edit" as const : undefined;
    return { time: at, landed, landedAt: landed && landing.current?.at.get(e.changeId), title, summary: e.label, edit: `${e.changeId}/${e.spot}`,
      detail: e.beforeCut ? `Removed ${lengthLabel(e.beforeCut.removed.end - e.beforeCut.removed.start)}`
        : e.at !== undefined ? editKindWord(e) ?? "Cut" : [editKindWord(e), span(e.range)].filter(Boolean).join(" · "),
      context: [...thread.changes, ...thread.flagged ?? []].find(c => belongsTo(e, c))?.description,
      // A press on the edit's marker opens it, as its row in the chat does.
      open: () => actions.openEdit(thread, e) };
  };
  /** A pass's edit by its time, as its row in the pass's list and the message box's tag say it: "Cut at 2:05". */
  const passEditName = (e: ThreadEdit, at: number) => `${e.beforeCut ? "Cut" : "Edit"} at ${clockLabel(at)}`;
  /** One that asks for a look while the pass waits has its number, counted on from the calls: "Cut 6 · 8:52". */
  const passEditDot = (thread: Thread, e: ThreadEdit, at: number) => {
    const numbered = passEditNo.get(editKey(e));
    return numbered ? { ...editDot(thread, e, `${numbered.name} · ${clockLabel(at)}`, at), n: numbered.n } : editDot(thread, e, passEditName(e, at), at);
  };

  const [compareHost, setCompareHost] = useState<HTMLElement | null>(null);

  const passReviewed = useReviewed(current.id, passThread);
  const passRevising = useRevising(passThread);
  const [backgroundReview, setBackgroundReview] = useState<ReadonlyMap<string, LocatedReview>>(() => new Map());
  const reportReviewMarkers = useCallback<ReportReviewMarkers>((id, review) => setBackgroundReview(previous => {
    if (!review && !previous.has(id)) return previous;
    const next = new Map(previous);
    if (review) next.set(id, review);
    else next.delete(id);
    return next;
  }), []);
  // The timeline numbers the edits of the request picked in the chat, or of the one that's open, as the chat does:
  // filled once kept and amber while it asks for a look. With nothing picked it marks nothing, and another request's
  // edits draw nothing. An edit sent back for revision doesn't ask for a look until its new version arrives.
  const onLatest = !firstCuts?.size && marked?.id === focusThread?.id;
  const listShown = !!focusThread && openList === focusThread.id;
  // A pass's edits are numbered in timeline order, as its list goes, except while the pass waits on the editor: then
  // only the ones that ask for a look are marked, with the numbers they have among its calls, and its other edits go
  // in with the last call. They share a pill only with others like them.
  // An edit made in several places is one edit: each of its places carries the number its row has in the chat.
  const passWaits = !!passThread && passThread.id === focusThread?.id && (waitingCalls.length > 0 ||
    passEdits.some(e => e.check && !passReviewed(e) && !passRevising(e)));
  const dotNumbers = new Map((playerView && focusThread && !passFocused ? editGroups(playerView.edits) : []).flatMap(g => g.members.map(m => [m.edit, g.members[0]!.i + 1] as const)));
  const numberedDots: TimelineDot[] = playerView && focusThread ? playerView.edits.flatMap((e, i): TimelineDot[] => {
    const state = reviewed(e) ? "kept" as const : e.check && !revisingEdit(e) ? "check" as const : undefined;
    const current = e === shownEdit;
    const at = (state === "check" ? e.reviewRange?.start : undefined) ?? e.at ?? e.range.start;
    const need = state === "check" ? passEditNo.get(editKey(e))?.name ?? passEditName(e, at) : undefined;
    if (passWaits) return state === "check" || current ? [{ ...passEditDot(focusThread, e, at), group: "pass", state, current, need }] : [];
    // The hover note names the request first: "Edit 3" alone would read as the chat's third request.
    const dot = editDot(focusThread, e, `${shortTitle(focusThread.title)} · ${dotNumbers.get(e) ?? i + 1} of ${playerView.edits.length} · ${clockLabel(at)}`, at);
    return [{ ...dot, n: dotNumbers.get(e) ?? i + 1, state, current, need }];
  }) : [];
  // The waiting pass's edits that ask for a look are with its calls when the timeline is on another request, numbered
  // after the calls as For you counts them. While the timeline is the pass's own, its dots above draw them.
  const passDots: TimelineDot[] = !callsShown || !passThread || suggestion || (playerView && focusThread?.id === passThread.id) ? []
    : passEdits.flatMap(e => {
      if (!e.check || passReviewed(e) || passRevising(e)) return [];
      const at = e.reviewRange?.start ?? (e as ThreadEdit).at ?? e.range.start;
      return [{ ...passEditDot(passThread, e, at), group: "pass", state: "check" as const, need: passEditNo.get(editKey(e))?.name ?? passEditName(e, at) }];
    });
  // In the default full timeline, unresolved flags from older requests also need a way in. Their chat lists already
  // load positions on the current working cut. Use those positions only, so old versions cannot put a dot at the wrong time.
  const showOtherFlags = picked === undefined && !focus && !suggestion && !listening && !source;
  const drawnChecks = new Set([...numberedDots, ...passDots].filter(dot => dot.state === "check").map(dot => dot.edit));
  const otherFlags = showOtherFlags ? [...ordered].reverse().flatMap(thread => {
    const review = backgroundReview.get(thread.id);
    if (!review || review.head !== head || thread.id === focusThread?.id || thread.id === passThread?.id) return [];
    return review.markers.flatMap(({ edit, number, total }) => {
      const key = editKey(edit);
      if (drawnChecks.has(key)) return [];
      drawnChecks.add(key);
      const at = edit.reviewRange?.start ?? edit.at ?? edit.range.start;
      return [{ ...editDot(thread, edit, `${shortTitle(thread.title)} · ${number} of ${total} · ${clockLabel(at)}`, at),
        n: number, group: thread.id, state: "check" as const, need: passEditName(edit, at) }];
    });
  }) : [];
  const olderFlaggedEdits = new Set(otherFlags.map(dot => dot.edit));
  const workingMarks = [...marks, ...numberedDots.filter(dot => !olderFlaggedEdits.has(dot.edit)), ...passDots, ...otherFlags];
  // A call shown on the version that still has the footage around it: each dot sits where its footage is there.
  const shownMarks = callView ? workingMarks.flatMap(dot => {
    const time = callView.toBase(dot.time);
    return time === null ? [] : [{ ...dot, time }];
  }) : workingMarks;
  // Once the edit or the list closes, the timeline stays with that request only while it still has an edit to check.
  // Otherwise it goes back: to a pass whose full list is still open in the chat, else to the latest request. The latest
  // request also takes it when it is new or has just applied an edit: the editor asked for something else.
  const latest = ordered.at(-1);
  const newest = latest && `${latest.id}/${latest.changes.filter(c => c.state === "approved").length}`;
  const followed = useRef(newest);
  // A request that is new or has just applied an edit takes the timeline from the one picked in the chat.
  const pickedAt = useRef(newest);
  if (pickedAt.current !== newest) { pickedAt.current = newest; if (picked !== undefined) setPicked(undefined); }
  // The latest arrival the editor has since gone elsewhere from: opening an edit of another request is where they want to be.
  const wentSince = useRef<string>(undefined);
  const flaggedEdits = useMemo(() => threadEdits.filter(e => !!e.check && !reviewed(e) && !revisingEdit(e)), [threadEdits, reviewed, revisingEdit]);
  const toCheck = flaggedEdits.length > 0;
  // What a request's markers last said. If they then fail to load, only a request known to have an edit to check stays.
  const known = useRef<{ threadId?: string; toCheck: boolean }>({ toCheck: false });
  if (focusThread && !threadTimeline.loading && !threadTimeline.error) known.current = { threadId: focusThread.id, toCheck };
  const settled = !threadTimeline.loading && (threadTimeline.error ? !(known.current.threadId === focusThread?.id && known.current.toCheck) : !toCheck);
  useEffect(() => {
    // The timeline has caught up with the latest request when it is on it. A request that arrives while it is
    // elsewhere stays to be followed until then.
    if (!focus || focus.threadId === latest?.id) followed.current = newest;
    if (!focus) {
      // A list that opened in the moment its request's last edit closed: the list has the timeline while it is open.
      if (openList) setFocus({ threadId: openList });
      return;
    }
    const arrived = followed.current !== newest && wentSince.current !== newest;
    // An open edit keeps the timeline, also while its markers load again. If they failed, an arrival takes it.
    if (focus.changeId || openList === focus.threadId || (threadTimeline.chosen && !(arrived && threadTimeline.error))) return;
    // An edit that is no longer in its request's list is let go, so it can't come back half open later.
    threadTimeline.clear();
    if (openList) {
      // The open list has the timeline while it is open. The latest request gets its turn back when the list closes.
      wentSince.current = undefined;
      if (focus.threadId === latest?.id) followed.current = undefined;
      return setFocus({ threadId: openList });
    }
    if (arrived || settled) setFocus(undefined);
  }, [focus, threadTimeline.chosen, threadTimeline.error, openList, newest, settled]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownIndex = reviewingEdit ? threadEdits.indexOf(reviewingEdit) : -1;
  // An edit made in several places is one edit, as the request's list shows it: one row, counted once in "1 of 3" and
  // in For you, and ↑ ↓ and Keep go from edit to edit. A pass lists each of its edits on a line of its own.
  // A pass's list goes by moments: edits that play as one change are one row, kept together, and ↑ ↓ step from moment
  // to moment. An edit of a moment opened on its own from under the moment's row is a row of its own, beside the
  // moment's other edits, and Keep keeps just that one.
  const openMoment = threadTimeline.single && reviewingEdit ? threadTimeline.moments?.find(m => m.edits.includes(reviewingEdit)) : undefined;
  const editsByRow = useMemo(() => threadTimeline.moments
    ? threadTimeline.moments.flatMap(m => m === openMoment ? m.members.map(e => [e]) : [m.edits]) : threadTimeline.rows,
  [threadTimeline.moments, threadTimeline.rows, openMoment]);
  const openOnItsOwn = (edit: ThreadEdit) => !!openMoment?.edits.includes(edit);
  const shownRow = reviewingEdit ? editsByRow.findIndex(row => row.includes(reviewingEdit)) : -1;
  const waitingEdit = (e: ThreadEdit) => !!e.check && !reviewed(e) && !revisingEdit(e);
  // A flagged edit not yet kept says its place among the ones still to check, as a call does.
  const flaggedRows = useMemo(() => editsByRow.filter(row => row.some(waitingEdit)), [editsByRow, reviewed, revisingEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const editPlace = reviewingEdit && waitingEdit(reviewingEdit) ? flaggedRows.indexOf(editsByRow[shownRow]!) : -1;
  const shownPassNo = reviewingEdit ? passEditNo.get(editKey(reviewingEdit))?.name : undefined;
  // When the timeline is on another request, use the flags the pass's own review list shows.
  const passFlagged = !pass || !passThread ? [] : passThread.id === focusThread?.id ? flaggedEdits
    : passEdits.filter(e => !!e.check && !passReviewed(e) && !passRevising(e));
  const closeEdit = () => { player.pause(); threadTimeline.clear(); };
  function editBeside(delta: number) {
    // From an edit that leads with its place among the ones still to check ("1 of 3"), ↑ and ↓ step to the others of
    // those: the next of every edit would be one of a pass's hundreds of settled cuts, and the count would go. One of
    // them sent back for revision has no card to say so and steps the same way, to the ones that still wait. While
    // the chat lists every edit of the request, and from any other edit, they step through them all. The arrows go by
    // the list the chat shows, however it came to be open, which is why a flagged edit opened from the timeline opens
    // the list of the ones that wait and not every edit.
    const every = !!focusThread && lists[focusThread.id] === "all";
    const among = !!reviewingEdit?.check && !reviewed(reviewingEdit) && !every;
    // A row stands for its first place that waits, else its first, as in the list.
    const beside = delta > 0 ? editsByRow.slice(shownRow + 1) : editsByRow.slice(0, Math.max(0, shownRow)).reverse();
    // A rejected edit is no row of the list, just rejected or open again from its row: from it they step to the edit
    // after or before where it was.
    if (reviewingEdit && shownRow < 0) {
      const was = reviewingEdit.at ?? reviewingEdit.range.start, timeOf = (other: ThreadEdit[]) => other[0]!.at ?? other[0]!.range.start;
      // An edit at the very place it was, as the rest of its moment can be, is the one after it.
      return (delta > 0 ? editsByRow.find(other => timeOf(other) >= was) : editsByRow.findLast(other => timeOf(other) < was))?.[0];
    }
    const row = among ? beside.find(other => other.some(waitingEdit)) : editsByRow[shownRow + delta];
    return row && (row.find(waitingEdit) ?? row[0]);
  }
  function stepEdit(delta: number) {
    const next = editBeside(delta);
    if (!next) return;
    // ↑ and ↓ reach the log as a bare key: this says which edit they went to.
    appLog("action", "step", { to: "edit", edit: threadEdits.indexOf(next) + 1, of: threadEdits.length, change: next.changeId });
    actions.playEdit(next, openOnItsOwn(next));
  }
  // On See all (and from any unflagged edit), Keep goes to the next row of the list that hasn't been kept: an
  // unflagged edit, a flagged one that still waits or a call that does, going past the ones that have and wrapping to
  // earlier ones. On For you, Keep wraps through the flagged rows that still wait, then reaches the request’s first
  // waiting call. The card closes once nothing is left.
  const seeAll = !!focusThread && lists[focusThread.id] === "all";
  const passSeeAll = !!passThread && lists[passThread.id] === "all";
  const unkeptEdit = (e: ThreadEdit) => !e.check && !reviewed(e) && !revisingEdit(e);
  const rowAfterKeep = (still: (e: ThreadEdit) => boolean) => editsByRow.slice(shownRow + 1).find(row => row.some(still))
    ?? editsByRow.slice(0, Math.max(0, shownRow)).find(row => row.some(still));
  const callsToKeepTo = pass && passThread?.id === focusThread?.id ? waitingCalls : [];
  const afterListKeep = reviewingEdit && (seeAll || !reviewingEdit.check)
    ? keepGoesTo(editsByRow, shownRow, e => unkeptEdit(e) || waitingEdit(e),
      callsToKeepTo.map(call => ({ call, at: listedAt.get(call.index) ?? call.start })))
    : undefined;
  const nextRowAfterKeep = !reviewingEdit || seeAll || !reviewingEdit.check ? undefined : rowAfterKeep(waitingEdit);
  // Keep reaches a moment as ↑ ↓ do: whole, at the edit it is named for, however much of it is kept already. The
  // first of its edits still to keep would open alone and unfold the moment.
  const momentLead = (edit: ThreadEdit) => threadTimeline.moments ? editsByRow.find(row => row.includes(edit))?.[0] ?? edit : edit;
  const nextEditAfterKeep = afterListKeep && "edit" in afterListKeep ? momentLead(afterListKeep.edit)
    : nextRowAfterKeep && (nextRowAfterKeep.find(waitingEdit) ?? nextRowAfterKeep[0]);
  const nextCallAfterKeep = afterListKeep ? "call" in afterListKeep ? afterListKeep.call : undefined
    : !nextEditAfterKeep && !seeAll && reviewingEdit?.check && passThread?.id === focusThread?.id ? waitingCalls[0] : undefined;
  // On See all, approving or skipping a call moves on to the next item in the full list (edit or call), regardless of
  // whether it is a For you item. On For you, it moves to the next waiting call, then the first flagged edit.
  const passEditList = passThread?.id === focusThread?.id && threadTimeline.edits.length > 0 ? threadTimeline.edits : passEdits;
  const passEditRows = useMemo(() => passThread?.id === focusThread?.id && threadTimeline.edits.length > 0 && threadTimeline.moments
    ? threadTimeline.moments.map(m => m.edits) : listMoments(passEdits).map(m => m.edits),
  [passThread?.id, focusThread?.id, threadTimeline.edits.length, threadTimeline.moments, passEdits]);
  const afterSeeAllCall = listening && pass && passThread && passSeeAll
    ? callGoesTo(passEditRows, e => !passReviewed(e) && !passRevising(e),
      remainingCalls.map(call => ({ call, at: listedAt.get(call.index) ?? call.start, after: allCalls.indexOf(call) > currentIndex })),
      listedAt.get(listening.index) ?? listening.cut.start)
    : undefined;
  const nextAfterCallDecision: { call: Call } | { edit: ThreadEdit } | undefined = !listening ? undefined
    : passSeeAll
      ? afterSeeAllCall && "edit" in afterSeeAllCall
        ? { edit: passEditRows.find(row => row.includes(afterSeeAllCall.edit))?.[0] ?? afterSeeAllCall.edit }
        : afterSeeAllCall
      : nextCallAfterDecision ? { call: nextCallAfterDecision }
      : passFlagged[0] ? { edit: passFlagged[0] } : undefined;
  const onCall = !!openCall && !openCallBack && !reviewingEdit;
  const upcomingCall = onCall ? (nextAfterCallDecision && "call" in nextAfterCallDecision ? nextAfterCallDecision.call : undefined) : nextCallAfterKeep;
  const upcomingEdit = onCall ? (nextAfterCallDecision && "edit" in nextAfterCallDecision ? nextAfterCallDecision.edit : undefined)
    : nextEditAfterKeep && (seeAll || waitingEdit(nextEditAfterKeep)) ? nextEditAfterKeep : undefined;
  const editSentBack = !!reviewingEdit && !!revisingEdit(reviewingEdit);
  const activeReview = workspaceActive && !source && !editSentBack;
  const [priorityRow, setPriorityRow] = useState<HoveredReviewRow>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = hoveredRow.subscribe(row => {
      clearTimeout(timer);
      // A pointer passing over the list on its way elsewhere doesn't displace a parked cut.
      timer = setTimeout(() => setPriorityRow(row), 120);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [hoveredRow]);
  const waitingOrder = waitingCalls.map(c => c.index).join(",");
  const flaggedOrder = passFlagged.map(editKey).join(",");
  // Where ↑ goes from the open edit or call, so going back isn't cold either.
  const previousEdit = reviewingEdit ? editBeside(-1) : undefined;
  const previousCall = onCall ? allCalls[allCalls.indexOf(openCall!) - 1] : undefined;
  const reviewQueue = useMemo(() => {
    if (!activeReview || !timeline || head !== timeline.version) return [];
    const queue = new Map<string, CutToPrepare>();
    const add = (key: string, target?: CutToPrepare) => {
      if (target && !queue.has(key)) queue.set(key, { ...target, key });
    };
    const addCall = (call?: CutAssessment) => {
      if (!pass || !call) return;
      const prior = returningCall?.index === call.index ? returningCall : undefined;
      const availableReview = prior ? review : liveReview;
      if (!availableReview) return;
      const target = callToPrepare(prior?.previous ?? pass, prior?.call ?? call, prior ? placed : placeCut(call), timeline,
        availableReview, cutDuration ?? undefined, prior ? listenRemovals : passRemovals);
      if (!target) return;
      if (openCall?.index === call.index && !preparedCall) {
        // The card already owns its cold draft and historical-version reads. Reuse them when they arrive.
        if (!callTimeline || (needsSingleCut && !single.preview) || (listening?.side === "after" && versionAfter && !savedAfter.timeline)) return;
        target.before = callTimeline;
        if (target.after && savedAfter.timeline) target.after = { ...target.after, version: savedAfter.timeline };
      }
      add(callPlaybackKey(call.index, typeof target.before === "string" ? target.before : target.before.version), target);
    };
    const addEdit = (edit: ThreadEdit, thread: Thread | undefined, edits: ThreadEdit[]) => {
      if (!edit.beforeCut || !thread) return;
      const target = editToPrepare(edit, cutChange(edit, thread.changes), edits, afterOf);
      if (!target) return;
      if (edit === reviewingEdit) {
        if (!beforeTimeline || (appliedSide === "after" && afterSource && !afterTimeline)) return;
        target.before = beforeTimeline;
        if (target.after && afterTimeline) target.after = { ...target.after, version: afterTimeline };
      }
      add(editPlaybackKey(edit, target.after && (typeof target.after.version === "string" ? target.after.version : target.after.version.version)), target);
    };
    // An editor can open a cold card before its row is reached. Finish that audition file while its stream plays.
    if (openCall && (!openCallBack || returningCall) && !conflict) addCall(openCall);
    if (reviewingEdit) addEdit(reviewingEdit, focusThread, threadEdits);
    if (priorityRow) {
      if (priorityRow.call !== undefined && priorityRow.threadId === passThread?.id)
        addCall(allCalls.find(call => call.index === priorityRow.call && !sentBack(call.index)));
      if (priorityRow.editKey) {
        const thread = focusThread?.id === priorityRow.threadId ? focusThread : passThread?.id === priorityRow.threadId ? passThread : undefined;
        const edits = thread === focusThread ? threadEdits : passEdits;
        const hovered = thread && edits.find(e => !!e.beforeCut && editKey(e) === priorityRow.editKey);
        if (hovered && !(thread === focusThread ? revisingEdit : passRevising)(hovered)) addEdit(hovered, thread, edits);
      }
    }
    addCall(upcomingCall);
    if (upcomingEdit) addEdit(upcomingEdit, onCall ? passThread : focusThread, onCall ? passEditList : threadEdits);
    // After the next one, the one before: the editor steps back less often than on.
    if (previousCall && !sentBack(previousCall.index)) addCall(previousCall);
    if (previousEdit && !revisingEdit(previousEdit)) addEdit(previousEdit, focusThread, threadEdits);
    waitingCalls.forEach(addCall);
    if (passThread?.id !== focusThread?.id) passFlagged.forEach(edit => addEdit(edit, passThread, passEdits));
    flaggedEdits.forEach(edit => addEdit(edit, focusThread, threadEdits));
    // Among settled cuts warm the first visible row, then the one reached by Keep or the arrow keys.
    const visible = !openCall && (listShown || onLatest) && (reviewingEdit ? nextEditAfterKeep : threadEdits.find(e => !!e.beforeCut && !revisingEdit(e)));
    if (visible) addEdit(visible, focusThread, threadEdits);
    return [...queue.values()];
  }, [activeReview, timeline, head, pass, review, liveReview, returningCall, placed, waitingOrder, flaggedOrder, openCall?.index, openCallBack, conflict, onCall, reviewingEdit, upcomingCall, upcomingEdit,
    flaggedEdits, threadEdits, passEditList, passEdits, passThread, focusThread, toWorkingCut, placing, priorityRow, listShown, onLatest, nextEditAfterKeep, previousEdit, previousCall,
    beforeTimeline, afterTimeline, appliedSide, madeBy, callTimeline, needsSingleCut, single.preview, listening?.side, versionAfter, savedAfter.timeline, !!preparedCall]); // eslint-disable-line react-hooks/exhaustive-deps
  const openVersion = versionBefore ?? head;
  const openCut = !activeReview ? undefined : beforeCut ?? (openCall && openVersion && heard ? { version: openVersion, removed: heard } : undefined);
  const openPlaybackKey = reviewingEdit ? editPlaybackKey(reviewingEdit, appliedAfterVersion)
    : listening && beforeVersion ? callPlaybackKey(listening.index, beforeVersion) : undefined;
  const nextCutPlayback = usePrepareReviewCuts(shownProject, current.renderSettingsRevision, reviewQueue, draftCache, preparedCandidates,
    openCut && { ...openCut, key: openPlaybackKey });

  function keepShown() {
    if (!reviewingEdit || !focusThread) return;
    // K reaches the log as a bare key, and the button as "Keep": this says which edit was kept.
    appLog("action", "keep-edit", { edit: shownIndex + 1, of: threadEdits.length, change: reviewingEdit.changeId, flagged: !!reviewingEdit.check || undefined });
    // An edit made in several places is kept in all of them: it is one edit, on one row.
    const row = editsByRow[shownRow] ?? [reviewingEdit];
    if (keepEdits(current.id, focusThread.id, row, head ?? undefined)) {
      recordEditReview(current.id, threadTimeline.selectedTarget, "keep");
      // ⌘Z takes it back, and opens this edit again. It goes by the name its tag in the box has.
      const target = threadTimeline.selectedTarget;
      const named = target && (cutName(target) ?? targetName(target));
      recordUndo({ kind: "keep", word: reviewingEdit.marker ? "Done" : "Keep", projectId: current.id, threadId: focusThread.id, refs: row,
        edit: { changeId: reviewingEdit.changeId, spot: reviewingEdit.spot, ...(threadTimeline.single && { single: true }) },
        ...(named && { name: threadTimeline.selectedMoment ? `${threadTimeline.selectedMoment.edits.length} edits` : tagOf(named) }) });
    }
    moveOnFromShown();
  }
  // Keep and Reject edit go on to the same place: the next edit or call that still waits, else the card closes.
  function moveOnFromShown() {
    if (nextEditAfterKeep) actions.playEdit(nextEditAfterKeep, openOnItsOwn(nextEditAfterKeep));
    else if (nextCallAfterKeep) actions.listen(pass!, nextCallAfterKeep);
    else closeEdit();
  }
  // ⌘Z takes back the editor's last Keep or revision, and the one before it on the next press. A Keep taken back opens
  // its edit again, where it waits on the editor. The label in the timeline's bottom row says what the next ⌘Z takes back.
  const threadsNow = useRef(threads);
  threadsNow.current = threads;
  const latestActions = useRef(actions);
  latestActions.current = actions;
  const undoKeys = useRef({ undo: async () => {} });
  undoKeys.current.undo = async () => {
    const project = useProjectStore.getState().current;
    if (!project || project.id !== current.id) return;
    const step = await undoLast(current.id, project, version => useProjectStore.getState().historyEdit(version, "revert"));
    // A Keep or a Reject edit moved the card on: taken back, the card goes back to the edit it was about.
    const opened = step?.kind === "keep" ? step : step?.edit && step.threadId ? { threadId: step.threadId, edit: step.edit } : undefined;
    const thread = opened && threadsNow.current.find(t => t.id === opened.threadId);
    if (opened && thread) latestActions.current.openEdit(thread, opened.edit, undefined, opened.edit.single);
  };
  useEffect(() => {
    if (!workspaceActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.defaultPrevented) return;
      // Words being written keep their own ⌘Z. The message box, once empty, leaves it here when it had no tag to put back.
      const box = e.target instanceof HTMLTextAreaElement && e.target.closest(".composer-box") && !e.target.value;
      if (isEditableTarget(e.target) && !box) return;
      if (document.querySelector('dialog[open], [role="dialog"], [role="menu"]')) return;
      if (!lastStep(useUndoStore.getState().steps, current.id)) return;
      e.preventDefault();
      if (!e.repeat) void undoKeys.current.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaceActive, current.id]);
  const undoFoot = <UndoLabel projectId={current.id} onUndo={() => void undoKeys.current.undo()} />;
  // With a pass's list of every edit open, watching the video is the review: a moment the video plays through, from
  // before it starts to past its end without a jump, is kept, all its edits at once. Only the moments that need no
  // decision of the editor's are: one that asks for a look, or a spot marked for them, waits for their own Keep. While
  // a cut, an edit or a call is open the player is on its own passage, and nothing is kept this way.
  const watchedMoments = useMemo(() => {
    if (!focusThread || lists[focusThread.id] !== "all" || !threadTimeline.moments || !passFocused) return [];
    return threadTimeline.moments.filter(m => m.edits.every(e => !e.check && !e.marker) && m.edits.some(e => !reviewed(e) && !revisingEdit(e)));
  }, [focusThread, lists, threadTimeline.moments, passFocused, reviewed, revisingEdit]);
  const watching = watchedMoments.length > 0 && !reviewingEdit && !listening && !suggestion && !source;
  const watchKeep = useRef({ watchedMoments, keep: (refs: ThreadEdit[]) => { if (focusThread) keepEdits(current.id, focusThread.id, refs, head ?? undefined); } });
  watchKeep.current = { watchedMoments, keep: refs => { if (focusThread) keepEdits(current.id, focusThread.id, refs, head ?? undefined); } };
  useEffect(() => {
    if (!watching) return;
    // Where the run of play now under way began. A seek, a skip or a pause starts a new one.
    let from: number | undefined;
    const done = new Set<string>();
    return usePlayerStore.subscribe((now, was) => {
      if (!now.playing) { from = undefined; return; }
      if (!was.playing) from = Math.min(was.time, now.time);
      else if (now.time < was.time - 0.05 || now.time - was.time > 1.5) from = now.time;
      else from ??= was.time;
      const start = from;
      const seen = watchKeep.current.watchedMoments.filter(m => !done.has(m.key) && start <= m.start + 0.05 && now.time >= m.end - 0.05);
      if (!seen.length) return;
      for (const m of seen) done.add(m.key);
      appLog("review", "watched", { moments: seen.length, at: now.time });
      watchKeep.current.keep(seen.flatMap(m => m.edits));
    });
  }, [watching]);
  const editKeys = useRef({ stepEdit, closeEdit });
  editKeys.current = { stepEdit, closeEdit };
  useEffect(() => {
    if (!workspaceActive || !reviewingEdit) return;
    // Capture phase, so ↑ and ↓ step between edits before anything else takes them. ← and → pass through to the player.
    const onKey = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e) || e.shiftKey) return;
      const step = stepOf(e.key);
      if (step) {
        e.preventDefault();
        if (!e.repeat) editKeys.current.stepEdit(step);
      } else if (e.key === "Escape") {
        // Full screen takes the first Esc: it leaves full screen, and the edit stays open.
        if (inFullScreen()) return;
        e.preventDefault();
        editKeys.current.closeEdit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [workspaceActive, !!reviewingEdit]);

  // ↑ and ↓ step through the cuts that need a call, one at a time.
  const stopListening = () => { player.pause(); setListening(undefined); };
  function stepCut(delta: number) {
    if (!allCalls.length) return;
    // From nothing, it starts on a call still waiting on the editor, as For you does: the first with ↓, the last
    // with ↑. With none waiting, on one they can decide again. From a call, it goes to the one beside it in the list.
    const at = openCall ? allCalls.indexOf(openCall) : -1;
    const next = at < 0 ? (delta > 0 ? waitingCalls[0] ?? asks[0] ?? allCalls[0] : waitingCalls.at(-1) ?? asks.at(-1) ?? allCalls.at(-1)) : allCalls[at + delta];
    if (next && pass) appLog("action", "step", { to: "call", call: callNo.get(next.index), of: allCalls.length, change: pass.id, cut: next.index });
    if (next && pass) actions.listen(pass, next);
  }
  // The suggestion on the card is the one being applied: it stays up until that lands.
  const applyingShown = !!suggestion && deciding === suggestion.id;
  const reviewKeys = useRef({ stepCut, stopListening, closeReview, listening: !!listening, suggestion: !!suggestion, applying: applyingShown, calls: allCalls.length > 0 });
  reviewKeys.current = { stepCut, stopListening, closeReview, listening: !!listening, suggestion: !!suggestion, applying: applyingShown, calls: allCalls.length > 0 };
  // Capture phase, so ↑ and ↓ step between cuts while a pass waits for a call. ← and → pass through to the player.
  const reviewKeysOn = workspaceActive && !!(passThread || suggestionThread) && !reviewingEdit;
  useEffect(() => {
    if (!reviewKeysOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e) || e.shiftKey) return;
      const keys = reviewKeys.current;
      const step = stepOf(e.key);
      // With no call to step to, the arrows stay the player's: a pass still running, or one with nothing to ask. They
      // stay the player's while a suggestion is on its card too: no key acts on a call that isn't on screen.
      if (pass && !keys.suggestion && step && keys.calls) {
        e.preventDefault();
        if (!e.repeat) keys.stepCut(step);
      } else if (e.key === "Escape" && (keys.listening || keys.suggestion) && !inFullScreen()) {
        e.preventDefault();
        // Esc is the card's Close: neither closes a suggestion while it is being applied.
        if (keys.listening) keys.stopListening(); else if (!keys.applying) keys.closeReview();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reviewKeysOn, !!pass]);

  // Esc closes the Transcript beside the player. A cut, an edit or a suggestion that's open takes Esc first.
  const escClosesTranscript = workspaceActive && transcript && !reviewingEdit && !(reviewKeysOn && (!!listening || !!suggestion));
  useEffect(() => {
    if (!escClosesTranscript) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || ignorePageShortcut(e) || inFullScreen()) return;
      e.preventDefault();
      setTranscript(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escClosesTranscript]);

  // Keep the newest message in view as replies arrive, unless the editor scrolled up to read.
  const chat = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastActivity = ordered.at(-1)?.updatedAt;
  useLayoutEffect(() => {
    const pane = chat.current;
    if (pane && follow.current) pane.scrollTop = pane.scrollHeight;
  }, [ordered.length, lastActivity, current.tasks.length]);
  // The spot above the message box grows and shrinks with what it holds, and the chat's room with it. The latest
  // message stays in view through that too.
  useEffect(() => {
    const pane = chat.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (follow.current) pane.scrollTop = pane.scrollHeight; });
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  // The open edit's card sits right on top of the timeline, above the passage it cut, so watching the join and deciding
  // happen in one place. It is one row: how many still wait, Scarlet's note as a small caption, then the controls. Its
  // words open under that row, behind Show transcript. Keys show on hover, not in boxes.
  const removedLength = beforeCut ? beforeCut.removed.end - beforeCut.removed.start : 0;
  // Before was reached by a click on the timeline, in this cut's passage or another's.
  const cutSwitched = shownSide?.side === "before" && shownSide.at !== undefined;
  // A marker left for the editor changed nothing in the video: its card says what it is, and has nothing to compare or undo.
  const shownMarker = !!reviewingEdit?.marker;
  const shownKind = reviewingEdit && (shownMarker ? "To do" : editKindWord(reviewingEdit));
  // The card's first line says exactly what the edit did: a cut's words, struck, or for any other edit what its steps
  // set (a caption's words, the file laid over the picture, how far a zoom goes). A moment holds several edits, and a
  // spot marked for the editor changed nothing, so neither has one.
  const editDid = !reviewingEdit || threadTimeline.selectedMoment || shownMarker ? undefined
    : beforeCut ? cutBefore.timeline && <CutWordsLine key={editKey(reviewingEdit)} timeline={cutBefore.timeline} media={media}
      range={beforeCut.removed} length={lengthLabel(removedLength)} verb="Took out" />
    : (detail => detail && <p className="edit-card-what">{detail}</p>)(editDetail(shownChange, reviewingEdit, { timeline, media }));
  // The transcript stays folded away. Its icon on the card opens it for this edit only.
  const scriptKey = reviewingEdit && beforeCut ? editKey(reviewingEdit) : undefined;
  const scriptOpen = !!scriptKey && scriptFor === scriptKey;
  // B-roll from the web says where it came from, behind its own icon, and folds again on the next edit as a cut's words do.
  const shownSource = reviewingEdit && !beforeCut ? editSource(reviewingEdit, timeline ?? undefined, media) : undefined;
  const sourceKey = shownSource && `source ${editKey(reviewingEdit!)}`;
  const sourceOpen = !!sourceKey && scriptFor === sourceKey;
  // Reject edit is about the open edit, whatever the message box is aimed at just then: a message
  // still being written may be about another one.
  const openTarget = reviewingEdit && shownChange && focusThread ? threadTimeline.selectedTarget : undefined;
  // An edit another request made, open here because this request flagged it, is saved or rejected from here too.
  const appliedTarget = openTarget && focusChanges
    .some(c => c.id === openTarget.changeId && c.state === "approved") ? openTarget : undefined;
  // An edit sent back for revision has no card until its new version lands: its note and its decisions are about the
  // version on its way out, and its row in the chat says Scarlet is on it. It stays open meanwhile: the message box is
  // still aimed at it, ↑ ↓ step on and Esc closes it.
  // One × rejects one edit (2026-11-19: the editor rejected a moment of two pause cuts, meaning one). On a moment's
  // card that is the edit the card is named for, and the card then stays on what is left of the moment.
  const rejectTarget = appliedTarget && threadTimeline.selectedAlone;
  // The engine puts back what it can with no request to Scarlet: the open edit, placed on the video as it runs now. A
  // cut says where its join is and what it took out.
  const rejectedEdits = useMemo(() => {
    if (!appliedTarget?.version || !threadTimeline.located || !reviewingEdit) return;
    return [reviewingEdit].map(e => ({ changeId: e.changeId, spot: e.spot, label: e.label, range: e.range,
      ...(e.previous.length > 0 && { revised: true }),
      ...(e.beforeCut && e.at !== undefined && { at: e.at, before: { version: e.beforeCut.version, removed: e.beforeCut.removed } }) }));
  }, [appliedTarget?.version, threadTimeline.located, reviewingEdit]);
  const editOpen = !!reviewingEdit;
  const openEditKey = reviewingEdit && editKey(reviewingEdit);
  // The edit that's open, for a rejection that lands after the editor stepped on: only the edit it was sent from moves on.
  const openEditNow = useRef(openEditKey);
  openEditNow.current = openEditKey;
  // An edit the engine put back leaves the timeline and nothing else moves (the editor asked on 2026-11-19, so the
  // edit is seen going): its band fades where it is, on the timeline as it was and at the same zoom, and its card stays
  // and says Rejected. The card doesn't go on by itself: ↑ ↓, a row or Esc is the editor's. Going on at once put the
  // next edit up on the video as it was, then again on the video without the rejected one, and the timeline changed
  // scale under the editor each time.
  const [leavingEdit, setLeavingEdit] = useState<{ key: string; version: string; dot?: TimelineDot }>();
  const leavingNow = !!leavingEdit && leavingEdit.key === openEditKey && threadTimeline.leaving;
  // The editor closed it or went to another edit: it has left.
  useEffect(() => { if (leavingEdit && !leavingNow) setLeavingEdit(undefined); }, [leavingEdit, leavingNow]);
  // A cut plays on the version before it. The ones ↑ and ↓ lead to from here are read ahead, so the timeline goes from
  // this cut to that one in one move, with no moment on the video in between.
  const besideVersions = leavingNow ? [editBeside(1), editBeside(-1)].flatMap(e => e?.beforeCut ? [e.beforeCut.version] : []).join(" ") : "";
  useEffect(() => {
    for (const version of besideVersions.split(" ").filter(Boolean)) void readTimeline(current.id, version).catch(() => {});
  }, [current.id, besideVersions]);
  // Play, from there, is the video as it runs now: the rejected edit opens as its row would open it, where it was, and
  // plays through what was put back. The card it was on plays a cut that is no longer in the video.
  const playRejected = useRef(noop);
  playRejected.current = () => {
    const gone = reviewingEdit && threadTimeline.rejected.find(e => matchesEdit(e, reviewingEdit));
    if (gone) actions.playEdit(gone); else player.pause();
  };
  useEffect(() => {
    if (!leavingNow) return;
    return usePlayerStore.subscribe((now, was) => { if (now.playing && !was.playing) playRejected.current(); });
  }, [leavingNow]);
  // Its dot goes with its band: the one it had, where it was, also once the list without it is in.
  const leavingMarks = leavingNow && leavingEdit?.dot
    ? [...shownMarks.filter(dot => dot.edit !== leavingEdit.key), { ...leavingEdit.dot, current: true, leaving: true, open: undefined }] : shownMarks;
  const playCheck = () => {
    if (!reviewRange) return;
    player.seek(editPlaybackRange(reviewRange, cutDuration ?? 0).start, true);
    player.play();
  };
  // A rejected edit shows where it was and says so, just rejected or opened again from its row: nothing of it is left
  // to keep, revise or reject.
  const rejectedCard = reviewingEdit && (reviewingEdit.rejected || leavingNow) && focusThread ? <section className="edit-card is-rejected" role="region" aria-label="Rejected edit">
    <div className="edit-card-bar">
      <EditNote key={editKey(reviewingEdit)} text={editNote(reviewingEdit)} />
      <span className="edit-card-length is-kind">Rejected</span>
    </div>
  </section> : undefined;
  const editCard = reviewingEdit && !reviewingEdit.rejected && !leavingNow && shownChange && focusThread && !editSentBack ? <section className="edit-card" role="region" aria-label="Applied edit">
    {/* Whose footage is playing, and nothing else: the lit icon in the row under it is the way back, and names its key. */}
    {visiting && <div className="edit-card-switched" role="status">
      <span className="edit-card-switched-side">Before</span>
      <span className="edit-card-switched-text">The cut at {visiting.at} took this part out.</span>
    </div>}
    <div className="edit-card-bar">
      {/* One the pass still waits on leads with its number, as on its line in the chat and its dot; its place among the
          ones still to check is on hover. Any other flagged edit leads with that place. */}
      {shownPassNo ? <span className="edit-card-count" title={editPlace >= 0 ? `${editPlace + 1} of ${flaggedRows.length} still to check` : undefined}>{shownPassNo}</span>
        : editPlace >= 0 && <span className="edit-card-count" title="Edits still to check">{editPlace + 1} of {flaggedRows.length}</span>}
      {/* The note explains the choice and includes any cue for the editor to check. */}
      {/* It's on up to two lines, so an edit with a short note is a single line. A clipped note opens on a click. */}
      {editDid ? <div className="edit-card-text">{editDid}<EditNote key={editKey(reviewingEdit)} text={editNote(reviewingEdit, !!reviewRange)} /></div>
        : <EditNote key={editKey(reviewingEdit)} text={editNote(reviewingEdit, !!reviewRange)} />}
      {/* A moment of a pass's list is its edits together: the pill says how many, and names them on hover. */}
      {threadTimeline.selectedMoment ? <span className="edit-card-length is-kind" title={threadTimeline.selectedMoment.members.map(e => e.label).join("\n")}>
        {threadTimeline.selectedMoment.edits.length} edits</span>
        : !beforeCut && shownKind && <span className={reviewingEdit.kind === "restore" ? "edit-card-length is-added" : "edit-card-length is-kind"}>{shownKind}</span>}
      {/* Scarlet asks the editor to look or listen at a part of the video, which the timeline marks. It is a pill like the
          edit's kind, in amber: a press plays just that part, and its times are on hover. */}
      {reviewRange && <button type="button" className="edit-card-length is-check" onClick={playCheck}
        title={`Play the part to check, ${checkSpan(reviewRange)}`}>Check</button>}
    </div>
    {/* A cut reads from the version before it. Until that arrives the mark stands alone and says the words are on their
        way, as a call's does. When it couldn't be read the passage offers to ask again, with why on hover. */}
    {scriptOpen && beforeCut && <div className="thread-passage">{cutBefore.timeline
      ? <EditPassage key={editKey(reviewingEdit)} timeline={cutBefore.timeline} media={media} range={beforeCut.removed} length={lengthLabel(removedLength)} others={otherCuts} />
      : <div className="edit-passage"><p className="review-spoken"><CutMark length={lengthLabel(removedLength)} />{" "}
        {cutBefore.error ? <button type="button" className="btn-quiet" title={cutBefore.error} onClick={cutBefore.retry}>Retry transcript</button>
          : <span className="edit-passage-wait working-text" role="status">Loading the words…</span>}</p></div>}</div>}
    {sourceOpen && shownSource && <SourceRow key={sourceKey} file={shownSource} />}
    {/* The controls are a row of their own under the note: Before/After and the transcript at the left, the decisions at
        the right, the same on every card. */}
    <div className="edit-card-controls">
      <span className="edit-card-side">
        {beforeCut ? <BeforeToggle key={cutSwitched ? `click-${shownSide!.take}` : "sides"} on={appliedSide === "before"} flash={cutSwitched}
          shortcutActive={workspaceActive} disabled={!cutKey} toggle={() => chooseCutSide(appliedSide === "after" ? "before" : "after")} />
          : !shownMarker && <span ref={setCompareHost} className="review-compare" />}
        {/* A cut's words open above this row, behind a small icon. An edit that isn't a cut has none. */}
        {scriptKey && <TranscriptLink open={scriptOpen} toggle={() => setScriptFor(scriptOpen ? undefined : scriptKey)} />}
        {/* B-roll from the web says where it came from behind an icon in the same place. */}
        {sourceKey && <SourceLink open={sourceOpen} toggle={() => setScriptFor(sourceOpen ? undefined : sourceKey)} />}
      </span>
      <span className="edit-card-acts">
        <ReviewActions revise={() => actions.revise(focusThread, shownChange)} approve={keepShown}
          approveLabel={shownMarker ? "Done" : "Keep"} approveKey={shownMarker ? "D" : "K"} />
        {/* Reject edit is a small × after Keep, as on a call's card: it puts back just this edit, also on
            a moment's card. The edit leaves the timeline where it is and the card stays, saying Rejected. A spot marked for the editor changed nothing, so
            it has none. Each edit has its own: one on its way for the edit before doesn't hold this one's back. */}
        {appliedTarget && rejectTarget && !shownMarker && <RejectEdit key={`reject ${openEditKey}`} projectId={current.id} thread={focusThread} target={rejectTarget}
          edits={rejectedEdits} editsOn={appliedTarget.version}
          // From the press, the card holds on the edit as it is: the video without it can land before the engine answers.
          onEngine={asked => asked ? threadTimeline.leave() : threadTimeline.stay()} onSent={sent => {
          follow.current = true;
          appLog("action", "reject-edit", { edit: shownIndex + 1, of: threadEdits.length, change: reviewingEdit.changeId });
          // ⌘Z takes the rejection back as it does a revision, and the card goes back to this edit.
          const named = cutName(rejectTarget) ?? targetName(rejectTarget);
          recordUndo({ kind: "revision", word: "Reject", projectId: current.id, taskId: sent.task?.id, version: sent.version, threadId: focusThread.id,
            edit: { changeId: reviewingEdit.changeId, spot: reviewingEdit.spot, ...(threadTimeline.single && { single: true }) },
            ...(named && { name: tagOf(named) }) });
          // An edit the editor stepped to meanwhile stays open: the rejection wasn't about it.
          if (openEditNow.current !== openEditKey) return;
          // One Scarlet was asked to put back stays in the video meanwhile, its row saying Rejecting…: the card goes on,
          // to the rest of its moment first, whose other edits are still the editor's to look at.
          const rest = threadTimeline.selectedMoment?.edits.find(e => e !== reviewingEdit);
          if (!sent.version) return rest ? actions.playEdit(rest, true) : moveOnFromShown();
          player.pause();
          // The box was aimed at the whole moment: what is open now is the one edit that was rejected.
          const ui = useUiStore.getState();
          if (threadTimeline.selectedMoment && !ui.agentDraft.trim() && ui.agentContext && ui.agentContext !== "whole") ui.setAgentContext(rejectTarget);
          setLeavingEdit({ key: openEditKey!, version: sent.version, dot: shownMarks.find(dot => dot.edit === openEditKey) });
        }} />}
      </span>
    </div>
  </section> : undefined;

  // A call the pass wasn't sure about opens the same card, as the same single row: Scarlet's reason, then Revise (R),
  // Keep (K) and Reject edit (X), the × after them. The last call applies the pass. A call sent back for revision keeps its
  // note and Before/After, and says Scarlet is on it where the decisions were.
  const savedHistory = (openCall && revisions?.get(openCall.index)) ?? noRevisions;
  const callHistory = returningCall ? savedHistory.slice(0, -1) : savedHistory;
  const callLength = heard ? lengthLabel(heard.end - heard.start) : openCall && lengthLabel(openCall.end - openCall.start);
  const callKey = pass && openCall && listening ? listening.key : undefined;
  // A call's range is on the pass's version. Its words are read on the working cut while that is the pass's version,
  // or once the cut is placed on a working cut that has moved on. A cut that isn't there as it was staged is read
  // on the pass's own version, which still has its footage.
  const callWords = !pass || !openCall || !listening || !timeline ? undefined
    : conflict || cutOverride ? heard && callTimeline && { timeline: callTimeline, range: heard }
    : heard && (timeline.version === pass.fromVersion || toWorkingCut) ? { timeline, range: heard }
    : stagedOn.timeline && !heard ? { timeline: stagedOn.timeline, range: listening.cut } : undefined;
  const callScriptOpen = !!callKey && scriptFor === callKey && (!conflict || !!heard);
  // Where the call's cut is in the video, as its dot on the timeline says.
  const callAt = openCall ? (heard ?? placeCut(openCall))?.start : undefined;
  const callCard = !editOpen && pass && openCall && listening ? <section className="edit-card is-call" role="region" aria-label="Call">
    {/* A grey gap clicked: whose footage is playing, as on an applied cut's card. The lit icon is the way back. */}
    {visit?.side === "before" && <div className="edit-card-switched" role="status">
      <span className="edit-card-switched-side">Before</span>
      <span className="edit-card-switched-text">The cut at {visit.label} took this part out.</span>
    </div>}
    {(decideError || pass.error) && <p className="text-bad" role="alert">{decideError || pass.error}</p>}
    <div className="edit-card-bar">
      {/* The call's number, the same as on its line in the chat and its dot on the timeline. */}
      {/* Hovered, it says where the cut is in the video. */}
      <span className="edit-card-count" title={callAt !== undefined ? `Cut at ${clockLabel(callAt)}` : undefined}>Cut {callNo.get(openCall.index)}</span>
      {callHistory.length > 0 && <EditVersion n={callHistory.length + 1}
        title={`v${callHistory.length}: ${callHistory.at(-1)!.reason ?? "Scarlet’s earlier version."}${callHistory.at(-1)!.note ? `\nYou: “${callHistory.at(-1)!.note}”` : ""}`} />}
      {/* What Keep would take out, struck, over Scarlet's reason. A revision that leaves the footage in has no such line. */}
      {callWords && !conflict && approves(openCall) === "cut" ? <div className="edit-card-text">
        <CutWordsLine key={callKey} timeline={callWords.timeline} media={media} range={callWords.range} length={callLength!} verb="Takes out" />
        <EditNote key={callKey} text={openCall.reason} unchecked={openCall.unchecked} /></div>
        : <EditNote key={callKey} text={openCall.reason} unchecked={openCall.unchecked} />}
    </div>
    {/* A call hasn't come out yet, so its words are marked in amber. When the pass's version couldn't be loaded there
        is nothing to read them on: the passage stops waiting and offers to ask again, as it does for the words. */}
    {callScriptOpen && <div className="thread-passage is-call">{callWords ? <>
      <EditPassage key={callKey} current={!!conflict} timeline={callWords.timeline} media={media} range={callWords.range} length={callLength!} />
      {!conflict && <OtherTakes projectId={current.id} timeline={callWords.timeline} media={media} range={callWords.range} />}
    </> : <div className="edit-passage"><p className="review-spoken"><CutMark length={callLength!} />{" "}
      {placing && stagedOn.error ? <button type="button" className="btn-quiet" title={stagedOn.error} onClick={stagedOn.retry}>Retry transcript</button>
        : <span className="edit-passage-wait working-text" role="status">Loading the words…</span>}</p></div>}</div>}
    <div className="edit-card-controls">
      <span className="edit-card-side">
        {/* Until the cut is placed on the working cut there is nothing to play it on, as with an applied cut. */}
        <BeforeToggle key={listening.at === undefined && visit?.side !== "before" ? "sides" : `click-${listening.take}`} on={!conflict && listening.side === "before"} shortcutActive={workspaceActive} disabled={!heard || !!conflict}
          flash={!conflict && listening.side === "before" && (listening.at !== undefined || visit?.side === "before")} toggle={() => listenSide(listening.side === "after" ? "before" : "after")} />
        <TranscriptLink open={callScriptOpen} disabled={!!conflict && !heard} toggle={() => setScriptFor(callScriptOpen ? undefined : callKey)} />
      </span>
      {openCallBack ? <CallStanding run={cutRuns.get(openCall.index)} answer={answeringCut && passThread ? () => actions.reply(passThread) : undefined} />
        : <CallActions choice={passChoices[openCall.index]} proposes={approves(openCall)} disabled={!!deciding} decide={choice => void decideCut(choice)} revise={reviseReview} />}
    </div>
  </section> : undefined;

  // A suggestion that isn't a dialogue pass opens the same card on top of the timeline, as the same single row:
  // Scarlet's words for it, the Before icon, then Revise (R) and Apply (A). Esc closes it.
  const suggestionNote = suggestion && (suggestion.reason
    || [...new Set(suggestion.timelineEdits?.flatMap(edit => edit.reason ? [edit.reason] : []))].join(" ")
    || suggestion.description);
  const suggestCard = !editOpen && !callCard && suggestion && suggestionThread ? <section className="edit-card is-suggestion" role="region" aria-label="Suggestion">
    {stripError && <p className="text-bad" role="alert">{stripError}</p>}
    <div className="edit-card-bar">
      <EditNote key={suggestion.id} text={suggestionNote!} />
    </div>
    <div className="edit-card-controls">
      <span className="edit-card-side">
        <BeforeToggle on={side === "before"} shortcutActive={workspaceActive}
          toggle={() => setSide(side === "after" ? "before" : "after")} />
      </span>
      <span className="edit-card-acts">
        {/* While another change is applied this one waits its turn: it can still be revised or closed. */}
        <ReviewActions revise={reviseReview} disabled={applyingShown} approvalDisabled={!!deciding} approveLabel={applyingShown ? "Applying…" : "Apply"} approve={() => void approveReview(suggestion)} />
      </span>
    </div>
  </section> : undefined;

  // The chat is one conversation and stays where it is. A cut or an edit that's open has its words and its controls on
  // its card; the message box is aimed at it.
  const itemThread = callCard ? passThread : editOpen ? focusThread : undefined;
  const selected = answeringCut && callCard ? `ask:${rechecking.id}` : callCard ? `call:${listening!.key}/${versionBefore ?? ""}` : editOpen ? `edit:${editKey(reviewingEdit!)}` : askThread ? `ask:${askThread.id}` : "new";

  // The message box talks to the cut or edit that's open; with none open it answers Scarlet's question, else starts a
  // new edit. A message being written stays aimed where it was, so moving to another cut never sends a half-written
  // note there; once it lands, the box follows again.
  // A suggestion's card isn't what the box talks to until Revise (R) on it aims the box there. That aim is for the card,
  // and goes when it closes.
  const openSuggestion = suggestCard ? suggestion!.id : undefined;
  itemIsOpen.current = !!itemThread || !!openSuggestion;
  const editAim = (edit: ThreadEdit, change: Change): { target: AgentContext; label: string } => {
    const target = threadTimeline.selectedTarget;
    const moment = threadTimeline.selectedMoment;
    if (target) return { target, label: `${moment ? `${moment.edits.length} edits` : `“${edit.label}”`} at ${clockLabel(edit.at ?? edit.range.start)}` };
    const range = change.ranges[0];
    return { label: "this whole edit", target: { changeId: change.id, version: change.appliedVersion ?? change.toVersion, time: range?.start ?? 0, end: range?.end,
      clipIds: [], label: "Revision" } };
  };
  /**
   * Aim the box at what's open. "moved": something else opened or closed. "sent": a message landed and the box is free.
   * "take": the editor asked for the message being written to come along. "new": the editor took the tag off the box,
   * so the message starts a new edit, whatever is open.
   */
  const settleAim = useRef<(why: "moved" | "sent" | "take" | "new") => void>(noop);
  // What opened, closed or was sent while a spoken message held the box. Once it is out, the box follows that.
  const heldForVoice = useRef<{ why: "moved" | "sent"; aim: number }>(undefined);
  settleAim.current = why => {
    const ui = useUiStore.getState();
    const carry = why === "take" || why === "new";
    // A message being spoken can't be brought along: its recording is in this box, and aiming the box elsewhere builds
    // it again, which would drop it. The tag's × waits until it is out.
    if (carry && ui.speaking) return;
    // Only spaces or line breaks are no message to keep aimed: opening an edit takes the aim off such a box, as off an
    // empty one, so it follows what's open the same way.
    if (!carry && ui.agentDraft.trim()) return;
    // A message being spoken is held the same way, from the moment the microphone is asked for until it is sent:
    // aiming the box elsewhere builds it again, which would drop the recording, or send the rest of what is said as an
    // answer to a question that arrived meanwhile. Words typed and sent while it is recorded don't free the box either.
    // Once it has gone out, or was dropped, the box follows what opened.
    if (ui.speaking) {
      heldForVoice.current = { why: why === "sent" ? "sent" : heldForVoice.current?.why ?? "moved", aim: aims.current };
      return;
    }
    heldForVoice.current = undefined;
    // The box is built again when its request changes, which drops the caret. When the editor moved the message by
    // hand, or was typing in the box, what they type next still goes into it, not to A, S, R or K on the open card.
    const typing = carry || !!document.activeElement?.closest(".composer-input");
    const aim: { thread?: Thread; target?: AgentContext; label?: string } = why === "new" ? {} : answeringCut && callCard ? { thread: passThread } : callCard && passThread
      ? { thread: passThread, ...cutTarget(pass!, listening!.index, listening!.cut) }
      : editOpen && focusThread && shownChange ? { thread: focusThread, ...editAim(reviewingEdit!, shownChange) } : { thread: askThread };
    // The box is already on this request (or on New edit). An aim the editor made there by hand stays as it is; one
    // left from a cut or an edit that has since closed doesn't.
    if (why === "moved" && !aim.target && replyTo === aim.thread?.id && !aimForItem.current) return;
    const text = carry ? ui.agentDraft : "";
    // A stretch marked on the ruler stays with the box as it is aimed elsewhere, until it is sent or taken off.
    const marked = why === "sent" ? undefined : markedRangeOf(ui.agentContext);
    // The message moves with the aim: nothing of it is left behind for the request it was on.
    if (carry) { ui.setAgentContext(null); ui.setAgentDraft(""); }
    countAim();
    openDraft(current.id, aim.thread?.id);
    const box = useUiStore.getState();
    aimForItem.current = !!aim.target;
    setReplyTo(aim.thread?.id);
    if (typing) ui.focusComposer();
    // A message saved for this request comes back as it was aimed.
    if (!carry && box.agentDraft.trim()) return setTargetLabel(undefined);
    setTargetLabel(aim.target ? aim.label : undefined);
    // A message the editor made a new edit, by the tag's × or the line above the box, is about the whole video: typing
    // on doesn't pin it to the playhead.
    box.setAgentContext(marked ? withMarkedRange(aim.target, marked) : aim.target ?? (carry && !aim.thread ? "whole" : null));
    if (text) box.setAgentDraft(box.agentDraft ? `${box.agentDraft} ${text}` : text);
  };
  // Before the page is drawn, so the box never shows a moment of what it was aimed at before.
  useLayoutEffect(() => { settleAim.current("moved"); }, [selected, aimAgain]);
  // Revise (R) on a suggestion's card aimed the box there. That aim goes when the card closes, as one made for a cut
  // or an edit does.
  useLayoutEffect(() => { if (aimForItem.current) settleAim.current("moved"); }, [openSuggestion]);
  // An answer being written when its question goes away, as when the request is stopped, has no question to go to. With
  // nothing open it starts a new edit, as the box does then, and keeps its words: no tag names a reply to that request.
  const asked = replyThread?.question ? replyThread.id : undefined;
  const wasAsked = useRef(asked);
  useLayoutEffect(() => {
    const was = wasAsked.current;
    wasAsked.current = asked;
    // An answer on its way out takes the question with it too, and then Scarlet is at work on the request again: those
    // words are the answer being sent, not a message left behind.
    if (was && !asked && replyTo === was && !replyThread?.active && !itemIsOpen.current && !aimForItem.current && useUiStore.getState().agentDraft.trim()) settleAim.current("new");
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  const speaking = useUiStore(s => s.speaking);
  useLayoutEffect(() => {
    const held = heldForVoice.current;
    if (speaking || !held) return;
    heldForVoice.current = undefined;
    // The editor aimed the box themselves since (Revise, a row's message): that aim stands.
    if (aims.current !== held.aim) return;
    settleAim.current(held.why);
  }, [speaking]);
  /**
   * Words chosen in the transcript ("Ask about this"), with a call open. Words in the call's passage on the working cut
   * are about that call: the message revises that one cut, and says where the editor was looking. Words anywhere else
   * start a new edit about them, as they do with nothing open. Either way the message being written comes along. Left
   * on the call's request, the words would name no cut, and the message would send the whole pass back.
   */
  const askAbout = (words: AgentContext) => {
    if (!callCard || !pass || !listening) return;
    const passage = callView?.cut ?? heard;
    const inCall = !!passage && !words.mediaId && words.version === (callView?.version ?? pinnedCallVersion ?? head) && words.end !== undefined && words.time < passage.end && words.end > passage.start;
    settleAim.current(inCall ? "take" : "new");
    // Only a box that leaves a request gets taken off words by that move; one already on a new edit keeps no note.
    if (!inCall && replyTo) askedWords.current = words;
    const aim = inCall ? { ...cutTarget(pass, listening.index, listening.cut).target,
      version: words.version, time: words.time, end: words.end, clipIds: words.clipIds, label: words.label } : words;
    if (inCall) wordsInCall.current = aim;
    useUiStore.getState().setAgentContext(aim);
  };
  // A request about an edit is named as that edit's row is: "the cut at 2:05". The row is in hand while its request
  // has the timeline, so the name is kept from then. With the timeline on another request, or on none, the name must
  // not turn into "the edit at" where the request's passage starts: the box, the queue and the chat say the same words.
  const targetNames = useRef(new Map<string, string>());
  const targetName = (about: AgentContext & object | Task["context"]) => {
    const { changeId, editIndex } = about;
    const key = changeId !== undefined && editIndex !== undefined ? `${changeId}/${editIndex}` : undefined;
    // A rejected edit open from its row is placed on the video as it runs now too: its tag has its row's time.
    const placedEdits = threadTimeline.rejected.length ? [...threadEdits, ...threadTimeline.rejected] : threadEdits;
    if (key && !placedEdits.some(e => matchesEdit(e, { changeId: changeId!, spot: editIndex! }))) {
      const kept = targetNames.current.get(key);
      if (kept) return kept;
      // Not listed since Scarlet opened: the request's own saved list still says whether it took footage out.
      const own = threads.find(t => t.changes.some(c => c.id === changeId));
      return revisionTarget({ context: about } as Task, changes, own && threadEditList(own));
    }
    const name = revisionTarget({ context: about } as Task, changes, placedEdits);
    if (key && name) targetNames.current.set(key, name);
    return name;
  };
  // The tag in the box says which cut or edit it is aimed at, so the line that names the aim is for screen readers only.
  const aimed = agentContext && agentContext !== "whole" ? agentContext : undefined;
  const aimedAtItem = !!aimed && (aimed.cutIndex !== undefined || aimed.editIndex !== undefined);
  // The tag reads as the same request does in the queue and on its message once sent: "Cut at 2:05".
  const aimedAt = aimed && replyThread ? targetName(aimed) : undefined;
  const written = useUiStore(s => !!s.agentDraft.trim());
  // A message being written keeps the box aimed where it was while the editor moves on to another cut or edit. Once
  // they delete it, nothing is being written: the box talks to what is open again, as an empty box does. Left on the
  // cut they came from, the next note typed would revise that one with another cut's card on screen.
  const wasWritten = useRef(written);
  const emptied = useRef<() => void>(noop);
  useLayoutEffect(() => {
    const cleared = wasWritten.current && !written;
    wasWritten.current = written;
    if (written) tagTakenOff.current = undefined;
    if (cleared) emptied.current();
  }, [written]);
  // An answer says so too, so a message meant as a new edit isn't sent to Scarlet's question by mistake.
  const boxTag = aimedAt ? (aimed && cutName(aimed)) ?? tagOf(aimedAt) : replyThread ? replyThread.question ? "Answer" : "Reply" : undefined;
  const aimOnOpen = callCard ? answeringCut ? !aimed : aimed?.changeId === pass!.id && aimed.cutIndex === listening!.index
    : editOpen && !!aimed && aimed.cutIndex === undefined && (aimed.changeId === reviewingEdit!.changeId || aimed.changeId === shownChange!.id)
      && (aimed.editIndex === undefined || aimed.editIndex === reviewingEdit!.spot);
  const aimMatches = itemThread ? replyThread?.id === itemThread.id && aimOnOpen
    // A suggestion that's open is what the box is on once Revise (R) aims it there.
    : openSuggestion && aimed?.changeId === openSuggestion ? replyThread?.id === suggestionThread!.id
    : askThread ? replyThread?.id === askThread.id && !aimedAtItem : !replyThread;
  // Only an aim made for a cut or an edit follows what's open. One the editor made on a whole request stays theirs.
  emptied.current = () => { if (aimForItem.current && !aimMatches) settleAim.current("moved"); };
  // A call of the waiting pass is named by where it is on the working cut now, as the label on the video and its dot
  // say it: the working cut can move after the box was aimed. The call's own range is used: an aim made from words
  // chosen in its passage has the words' times, not the cut's.
  const aimedCall = pass && aimed && aimed.changeId === pass.id && aimed.cutIndex !== undefined
    ? allCalls.find(a => a.index === aimed.cutIndex) ?? (aimed.end !== undefined ? { start: aimed.time, end: aimed.end } : undefined) : undefined;
  // A call's tag is only its number ("Cut 3"), so the box's tag line says where that cut is.
  const aimTime = boxTag && aimedCall && aimed && cutName(aimed) === boxTag ? (placeCut(aimedCall) ?? aimedCall).start : undefined;
  const aimLabel = !replyThread ? "Starting a new edit"
    : aimedCall && (targetLabel || aimedAtItem) ? `Revising the cut at ${clockLabel((placeCut(aimedCall) ?? aimedCall).start)}`
    : targetLabel ? `Revising ${targetLabel}`
    // A message that came back with its aim names it from the aim itself: a cut by where it is, an edit by its name.
    : aimedAtItem ? `Revising ${aimed!.cutIndex !== undefined ? `the cut at ${clockLabel(aimed!.time)}` : aimed!.label ? `“${aimed!.label}”` : "this edit"}`
    : `${replyThread.question ? "Answering" : "Replying to"} “${replyThread.title}”`;
  /**
   * What a queued request is waiting for. Held by the pass whose calls are all made, it waits on Scarlet and not the
   * editor: the pass goes in once Scarlet's revisions or rechecks of its cuts are done.
   */
  const waitOf = useMemo(() => queueWaits(tasks, changes), [tasks, changes]);
  const waitFor = (task: Task) => {
    const wait = waitOf(task);
    const called = wait?.kind === "review" && actions.pass?.change.id === wait.change.id && !actions.pass.calls.some(c => c.state === "open");
    return called ? { kind: "run" as const } : wait;
  };
  const waitHint = (task: Task) => {
    const wait = waitFor(task);
    return !wait ? undefined : wait.kind === "review" ? "Starts once you’ve made your calls on the dialogue pass"
      : wait.kind === "question" ? "Starts once you’ve answered Scarlet" : "Starts when Scarlet finishes what it’s on";
  };

  /**
   * What the next request waits for when that is the editor. It is said on the tray's line, where Next would be: it
   * doesn't start until they act, whatever Scarlet is on meanwhile.
   */
  const waitsOnEditor = (task: Task) => {
    const wait = waitFor(task);
    return wait?.kind === "review" ? "Waits for your calls" : wait?.kind === "question" ? "Waits for your answer" : undefined;
  };

  const compact = useSyncExternalStore(subscribeWidth, () => narrow.matches);
  // What stays put above the message box: the request Scarlet is on now, else the pass waiting on the editor's calls.
  // Everything queued waits behind it, so it holds the same place until it's done and then joins the chat.
  const [pinHost, setPinHost] = useState<HTMLElement | null>(null);
  const editingPaused = current.project.editingPaused;
  // A request in line again after its question was answered is still the one Scarlet is on: it holds its place for the
  // moment before Scarlet picks it back up, instead of dropping into the conversation and coming back.
  const front = tasks.find(t => t.kind !== "transcribe" && (t.state === "claimed" || t.state === "running" || t.state === "waiting_for_user"))
    ?? tasks.find(t => t.kind !== "transcribe" && t.state === "queued" && !!t.startedAt && !(editingPaused && isProjectEditTask(t)));
  const rootOf = useMemo(() => requestRoots(tasks), [tasks]);
  // A request in the chat that Scarlet has, whose band holds Pause or Resume and Stop. A new one waiting its turn is
  // in the tray instead.
  const editing = tasks.some(task => isProjectEditTask(task) && runIsActive(task) && !(waitingToStart(task) && rootOf(task) === task.id));
  const pinned = front ? rootOf(front) : pass && passTask ? rootOf(passTask) : undefined;
  // The requests waiting their turn, in the order Scarlet will run them: a note on a call of the pass that waits goes
  // ahead of a new edit asked before it, which the calls hold back. An interrupted request keeps its place here.
  const cancelTask = useProjectStore(s => s.cancelTask);
  const resumeEditing = useProjectStore(s => s.resumeEditing);
  const holdForRewording = useProjectStore(s => s.holdForRewording);
  const rewordTask = useProjectStore(s => s.rewordTask);
  const startBeforeCalls = useProjectStore(s => s.startBeforeCalls);
  // What the tray couldn't do is said in the banner, as Stop's is: most often, Scarlet began the request first.
  const queueAction = (action: Promise<void>) => { setMenuError(""); return action.catch(e => { setMenuError(errorMessage(e)); throw e; }); };
  // The line is about a request as it stood. Once any request moves on it has nothing left to say, and the tray may
  // have no row left whose press would take it away.
  const taskStates = tasks.map(t => `${t.id}:${t.state}`).join();
  useEffect(() => setMenuError(""), [taskStates]);
  const queued = useMemo(() => queueOrder(tasks, changes).filter(t => waitingToStart(t) && rootOf(t) === t.id), [tasks, changes, rootOf]);
  const queuedItems = useMemo((): QueuedRequest[] => queued.map(t => {
    const target = targetName(t.context);
    return { id: t.id, text: isRedo(t) ? redoWords(t, tasks, changes) : requestText(t), target: cutName(t.context) ?? (target && tagOf(target)),
      fixed: t.createdBy.type !== "human" };
  }), [queued, tasks, changes, threadEdits, pass, allCalls]); // eslint-disable-line react-hooks/exhaustive-deps
  const queueHint = !editingPaused && queued[0] ? waitHint(queued[0]) : undefined;
  // The queued request whose words are in the message box to change, and the words as they stand there. Scarlet
  // doesn't start it meanwhile. A message being written waits, and is in the box again once these words are done.
  // They are kept as they are typed, as an unsent message is: after a quit the request is in the box again with the
  // words as they stood, and held again, instead of starting a minute later with the words it was first given.
  const [rewording, setRewording] = useState<{ id: string; text: string } | undefined>(() => savedRewording(current.id));
  useEffect(() => saveRewording(current.id, rewording), [current.id, rewording]);
  // Whether the tray is open. Held here: the box it sits on is built again whenever it is aimed somewhere else.
  const trayOpen = useState(false);
  const rewordingItem = rewording && queuedItems.find(item => item.id === rewording.id);
  const previewVersion = appliedCut ? beforeCut!.version : callView ? callView.version : pinnedCallVersion ?? draftVersion;
  // The player is on the working cut's own clock: nothing open that plays another version or a clip.
  const onWorkingClock = !source && !draftVersion && !appliedCut && !listening;
  useLayoutEffect(() => {
    showingWorkingCut(onWorkingClock);
    return () => showingWorkingCut(false);
  }, [onWorkingClock]);
  const playerVersion = previewVersion ?? timeline?.version ?? head ?? undefined;
  const seekFromMessage = useRef<((time: number) => void) | null>(null);
  const previewTimeline = appliedCut ? beforeTimeline : callView ? callView.timeline : pinnedCallVersion ? callTimeline : draft;
  const messageTimeline = previewVersion ? previewTimeline : timeline?.version === head ? timeline : undefined;
  const messageDuration = useMemo(() => source ? source.duration ?? 0 : messageTimeline ? timelineDuration(messageTimeline) : 0, [source, messageTimeline]);
  const messageClock: MessageClock | undefined = messageDuration > 0 && !replyTo && !rewordingItem
    ? { duration: messageDuration, timeline: messageTimeline, version: playerVersion, mediaId: source?.id, seek: time => seekFromMessage.current?.(time) }
    : undefined;
  const typedTimes = useUiStore(useShallow(s => {
    const point = messageClock && pointOf(s.agentContext);
    return point?.fromMessage && point.version === playerVersion && point.mediaId === source?.id
      ? [...new Set(messageTimestamps(s.agentDraft, messageDuration).map(stamp => stamp.time))] : [];
  }));


  /**
   * A stretch marked on the timeline's ruler, or taken off there. It goes on the message as it is aimed: a cut or an
   * edit the box talks to stays its target, and Scarlet is told both. With nothing aimed it is a new edit about that
   * stretch. A queued request's words and a message being spoken are left as they are.
   */
  const markRange = (marked: MarkedRange | undefined, byKey?: boolean) => {
    const box = useUiStore.getState();
    if (rewordingItem || box.speaking) return;
    const was = box.agentContext && box.agentContext !== "whole" ? box.agentContext : undefined;
    if (!marked && !was?.markedRange) return;
    const next = withMarkedRange(box.agentContext, marked);
    if (was && was === wordsInCall.current && next) wordsInCall.current = next;
    box.setAgentContext(next, next && was?.changeId ? was : undefined);
    // A handle stepped a frame by ← or → keeps the keys, so the next press steps it again.
    if (marked && !byKey) box.focusComposer();
  };
  // A click anywhere but the message box and the timeline takes a marked range off: the timeline says for itself
  // which of its presses do. A drag, a scroll or a press held and moved isn't a click.
  const hasMarkedRange = useUiStore(s => !!markedRangeOf(s.agentContext));
  const clearRange = useRef(markRange);
  clearRange.current = markRange;
  useEffect(() => {
    if (!hasMarkedRange) return;
    let down: { x: number; y: number; id: number; away: boolean } | undefined;
    const away = (target: EventTarget | null) => target instanceof Element && !target.closest(".composer-dock, .timeline-panel, .timeline-range-loupe");
    const press = (e: PointerEvent) => { down = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId, away: away(e.target) } : undefined; };
    const release = (e: PointerEvent) => {
      const was = down;
      down = undefined;
      if (was?.away && was.id === e.pointerId && Math.hypot(e.clientX - was.x, e.clientY - was.y) <= 4) clearRange.current(undefined);
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
    };
  }, [hasMarkedRange]);
  // The time a pause wrote into the box, while it is all the box holds.
  const pausedTime = useRef<string | undefined>(undefined);
  // With a cut or an edit open, a pause puts its time in the box's tag instead, and the message stays the cut's or the
  // edit's. It goes when the video plays on with nothing written, and when another cut or edit opens.
  const [pausedAt, setPausedAt] = useState<PausedAt>();
  const pausedAtRef = useRef(pausedAt);
  pausedAtRef.current = pausedAt;
  useEffect(() => usePlayerStore.subscribe((now, was) => {
    if (!now.playing || was.playing) return;
    const box = useUiStore.getState();
    if (pausedAtRef.current && !box.agentDraft.trim()) setPausedAt(undefined);
    if (!pausedTime.current) return;
    if (box.agentDraft === pausedTime.current) {
      box.setAgentDraft("");
      box.setAgentContext(null);
    }
    pausedTime.current = undefined;
  }), []);
  useLayoutEffect(() => () => setPausedAt(undefined), [replyTo]);
  // A press, a scrub or a skip on the timeline, or N, aims a new edit at that moment at once: the box shows it as its
  // edit-point icon. A message aimed at a cut or an edit, or one being written, stays where it was. Words chosen in the
  // transcript or a stretch marked on the ruler stay through a seek; only N takes their place.
  // A pause writes its time into an empty box as the start of the message ("0:04 "), as if the editor had typed it.
  // While the box holds only that, the next pause or seek moves it, and playing on takes it out again.
  // With a cut or an edit open, a pause into an empty box shows its time in the tag, and the next seek moves it there:
  // the message stays the cut's or the edit's, and Scarlet is told the frame the editor stopped on besides.
  const pickPoint = (picked: AgentContext, how: "seek" | "n" | "pause") => {
    const box = useUiStore.getState();
    if (rewordingItem || box.speaking) return;
    const onlyPaused = !!pausedTime.current && box.agentDraft === pausedTime.current;
    const written = onlyPaused ? "" : box.agentDraft.trim();
    const target = box.agentContext;
    if (replyTo) {
      if (!aimedAtChange(target) || box.agentDraft.trim() || how === "n" || (how === "seek" && !pausedAtRef.current)) return;
      setPausedAt({ time: picked.time, version: picked.version, ...picked.mediaId && { mediaId: picked.mediaId } });
      return;
    }
    if (target && target !== "whole" && (target.changeId || written)) return;
    // A message being written about the whole video, aimed or not yet, stays so through a seek: the line above the
    // box offers to bring it along.
    if (how !== "n" && (!target || target === "whole" ? written : !pointOf(target))) return;
    if (how === "pause" || onlyPaused) {
      const text = `${clockLabel(picked.time)} `;
      pausedTime.current = text;
      box.setAgentDraft(text);
      box.setAgentContext({ ...picked, fromMessage: true });
      return;
    }
    playheadPoints.add(picked);
    box.setAgentContext(picked);
  };
  // It left the queue meanwhile, taken out or begun: the box goes back to the message being written. Not while the
  // project's requests are still loading: the queue then reads empty, and the words restored from before would be lost.
  useEffect(() => {
    if (!current.reviewStatus && rewording && !queued.some(t => t.id === rewording.id)) setRewording(undefined);
  }, [queued, rewording, current.reviewStatus]);
  useRewordingHold(rewording?.id, (id, on) => on ? queueAction(holdForRewording(id, true))
    // Letting go of a hold says nothing when it fails: the hold lapses by itself.
    : holdForRewording(id, false), () => setRewording(undefined));
  // What a message does when it lands, sent while the box was aimed as it is in this render. The Transcript stays open
  // beside the player: the chat, where the message went, is in view with it.
  const sentUnder = (aim: number) => () => {
    if (aims.current === aim) {
      settleAim.current("sent");
    }
  };
  // Taking the tag off (Backspace in an empty box, or its ×) makes the message a new edit about the whole video. ⌘Z in
  // the empty box puts the aim back as it was, until the box is aimed again or written in.
  const clearTarget = () => {
    const ui = useUiStore.getState();
    const was = { replyTo, label: targetLabel, forItem: aimForItem.current, context: ui.agentContext };
    const before = aims.current;
    settleAim.current("new");
    tagTakenOff.current = aims.current === before ? undefined : { aim: aims.current, restore: () => {
      const box = useUiStore.getState();
      // The new edit's own box keeps no "whole video" aim left from the tag taken off.
      if (!box.agentDraft) box.setAgentContext(null);
      aimForItem.current = was.forItem;
      countAim();
      openDraft(current.id, was.replyTo);
      setReplyTo(was.replyTo);
      setTargetLabel(was.label);
      useUiStore.getState().setAgentContext(was.context);
      useUiStore.getState().focusComposer();
    } };
  };
  const restoreTarget = () => {
    const taken = tagTakenOff.current;
    tagTakenOff.current = undefined;
    const ui = useUiStore.getState();
    if (!taken || taken.aim !== aims.current || ui.agentDraft.trim() || ui.speaking) return false;
    taken.restore();
    return true;
  };
  const composer = <WorkspaceComposer newEdit={!replyTo} playerVersion={playerVersion} mediaId={source?.id} key={JSON.stringify([current.id, replyTo])} thread={replyThread}
    // A new request is the latest thing said, so the chat goes to it. A cut or an edit that's open stays open.
    onCreated={() => { follow.current = true; }} onSent={sentUnder(aims.current)}
    // The box carries a tag naming the cut or edit it revises, or the point a new edit is about. Taking the tag off
    // makes the message a new edit about the whole video.
    messageClock={messageClock} pausedAt={replyTo ? pausedAt : undefined} aimTime={aimTime}
    targetTag={boxTag} onClearTarget={clearTarget} onRestoreTarget={restoreTarget}
    // A queued request's words have the box to themselves: its row in the tray, lit, says which request they are.
    rewording={rewordingItem && { id: rewordingItem.id, text: rewording!.text,
      onChange: text => setRewording(r => r && { ...r, text }),
      onSave: async (text, skillIds) => {
        if (text !== rewordingItem.text.trim()) await rewordTask(rewordingItem.id, text, skillIds);
        setRewording(active => active === rewording ? undefined : active);
      },
      onCancel: () => setRewording(undefined) }}
    // Pause, Resume and Stop are at the right of the band of the request Scarlet has. Only with no such band, editing
    // paused while requests wait their turn, does the tray hold Resume.
    tray={queuedItems.length > 0 || (editingPaused && !editing) ? <QueueTray items={queuedItems} hint={queueHint} waits={!editingPaused && queued[0] ? waitsOnEditor(queued[0]) : undefined} rewording={rewordingItem?.id} opened={trayOpen}
      onRemove={id => void queueAction(cancelTask(id, true)).catch(() => {})}
      paused={editingPaused}
      onContinue={editingPaused && !editing ? () => queueAction(resumeEditing(current.id)).catch(() => {}) : undefined}
      // The editor's calls are theirs to put off: the request they hold back can start without them.
      onStart={!editingPaused && queued[0] && waitFor(queued[0])?.kind === "review" ? id => void queueAction(startBeforeCalls(id)).catch(() => {}) : undefined}
      // The pencil of the request whose words are in the box puts them back as they were.
      onReword={id => {
        // A message being spoken is the box's until it is out: it would be saved over this request's words.
        if (useUiStore.getState().speaking) return;
        const item = queuedItems.find(i => i.id === id);
        setRewording(item && rewording?.id !== id ? { id, text: item.text } : undefined);
      }} /> : undefined} />;

  return <EditHoverContext.Provider value={hoveredEdit}>
    <main className="min-h-0 flex flex-1 flex-col">
      <Dropzone className="edit-workspace simple-workspace" label="Add footage to this project" notice={notice}
        onPaths={paths => { void uploads.startPaths(paths); setPanel("media"); }}
        onFiles={files => { uploads.start(files); setPanel("media"); }}>
        <ChatRail compact={compact} id="simple-chat" className="simple-rail" label="Chat" storageKey="scarlet.simpleChatWidth" initialWidth={simpleRailWidth} minWidth={SIMPLE_RAIL_MIN}>
          <header className="simple-header">
            <Link to="/" className="simple-back" onClick={() => player.pause()} title="All projects" aria-label="All projects">
              <span className="rotate-180 inline-flex"><Icon name="arrow" size={13} /></span></Link>
            <h1 title={current.project.name}>{current.project.name}</h1>
            <ConnectionStatus />
            {/* The menu's button is marked when something inside needs the editor, and the row that does carries the
                same mark. Media, Export and Model mark their own header buttons. */}
            <div className="simple-tools">
              <MediaButton importing={importing} importFailed={importFailed} onOpen={() => setPanel("media")} />
              <ExportButton onOpen={() => setPanel("export")} />
              <AgentChip variant="header" direction="down" threadInput={replyThread ? replyThread.question ? "answer" : "reply" : undefined} />
              <Dropdown label="More" align="right" width={240} description={menuSays || undefined}
                button={<span className={`btn-icon simple-more${menuSays ? " needs-you" : ""}`} title={menuSays || "More"}>
                  <Icon name="more" /></span>}>
                {close => <>
                  <MenuItem onClick={() => { close(); setLearnFocus(undefined); setPanel("learnings"); }} title={toLearn ? `${plural(toLearn, "rule")} to review` : undefined}>
                    <Icon name="bulb" />Learnings{toLearn > 0 && <span className="menu-dot" role="img" aria-label={`${plural(toLearn, "rule")} to review`} />}</MenuItem>
                  <CachingMenuItem close={close} />
                  <MenuItem onClick={() => { close(); setTranscript(v => !v); }}><Icon name="diff" />{transcript ? "Hide transcript" : "Transcript"}</MenuItem>
                  <div role="separator" className="my-1 border-t border-line" />
                  <MenuItem onClick={() => { close(); useUiStore.getState().setProjectSettingsOpen(true); }}><Icon name="monitor" />Project settings</MenuItem>
                  <MenuItem to="/settings" onClick={close}><Icon name="settings" />App settings</MenuItem>
                </>}
              </Dropdown>
            </div>
          </header>
          {panel === "learnings" && <LearningsPanel focus={learnFocus} onClose={() => { setPanel(null); setLearnFocus(undefined); }} />}
          {/* A pause of caching isn't said here: the editor chose it, and the menu's Resume caching row says it. */}
          {(importFailed || menuError) && <div className="simple-banner" role="status">
            <span>{menuError || "Some files need attention."}</span>
            {importFailed && !menuError && <button type="button" className="simple-link" onClick={() => setPanel("media")}>View media</button>}
          </div>}
          <div className="simple-thread">
            <div ref={chat} className="simple-chat" onScroll={e => {
              const pane = e.currentTarget;
              follow.current = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 48;
            }}>
              {current.reviewStatus === "loading" ? <Loading label="Loading edits…" />
                : current.reviewStatus === "error" ? <p className="simple-error" role="alert">{current.reviewError}{" "}
                  <button type="button" className="simple-link" onClick={() => void useProjectStore.getState().load(current.id)}>Retry</button></p>
                : ordered.length ? ordered.map(thread => <Turn key={thread.id} projectId={current.id} thread={thread} actions={actions}
                  pinned={pinned} pinHost={pinHost} list={listOf(thread.id)}
                  reportReviewMarkers={showOtherFlags && thread.id !== focusThread?.id && thread.id !== passThread?.id
                    ? reportReviewMarkers : undefined} />)
                : !media.length ? <p className="simple-empty">Drop footage here, then say what you want.</p>
                : caching && <p className="simple-empty" role="status">You can start editing while the video caches.</p>}
              {/* A new timeline that keeps failing to read is said after the conversation, which stays where it is. */}
              {!current.reviewStatus && current.headError && <p className="simple-error" role="alert">{current.headError}{" "}
                <button type="button" className="simple-link" onClick={() => void useProjectStore.getState().load(current.id)}>Retry</button></p>}
            </div>
            <div ref={setPinHost} className="simple-pin" aria-label="Working on now" />
            {/* The tag in the box shows where a message goes. This line says it for screen readers only. */}
            {!rewordingItem && (replyThread || !aimMatches) && <div className="simple-target" role="status">
              <span>{aimLabel}</span>
            </div>}
            {composer}
          </div>
        </ChatRail>
        <div className="workspace-stage simple-stage">
          {/* An applied cut plays on the version before it, where the working cut's times don't hold, and a suggestion's
              dots are all its own: neither has dots beside its band. */}
          <CutPreview simple={{ seekFromMessage, typedTimes, marks: source || beforeCut ? [] : suggestion && lineFocus ? marks : leavingMarks, fit: fitTimeline, focus: leavingNow && lineFocus ? { ...lineFocus, leaving: true } : lineFocus, label: onVideo, compareHost: reviewingEdit ? compareHost : undefined, above: rejectedCard ?? editCard ?? callCard ?? suggestCard, foot: undoFoot,
            gaps: cutKey ? gaps : callGaps, skippedRanges: joinedPlayer?.clock.removed ?? stepsOver(appliedListen ?? playedAudition),
            nextCutPlayback, cutPlayback: appliedListen && beforeTimeline && cutKey && appliedCut
              ? { key: editPlaybackKey(reviewingEdit!, appliedAfterVersion), start: appliedListen.start, side: appliedSide,
                beforeWindow: preparedEdit?.before.window, afterWindow: preparedAfter?.window,
                beforeFile: preparedEdit?.before.file, afterFile: preparedAfter?.file }
              // On the version that still has the footage around the call, Before plays that version, and After the
              // same file as on the working cut, prepared ahead or not, through its own clock.
              : callView && viewAudition && listening
                ? { key: `${callPlaybackKey(listening.index, head ?? "")}@${callView.version}`, start: viewAudition.start, side: listening.side,
                  ...preparedCall && preparedCall.after.version === viewJoined?.version && { afterWindow: preparedCall.after.window, afterFile: preparedCall.after.file } }
              : audition && listening && callTimeline && heard && !conflict
                ? { key: callPlaybackKey(listening.index, callTimeline.version), start: audition.start, side: listening.side,
                  beforeWindow: preparedCall?.before.window, afterWindow: preparedCall?.after.window,
                  beforeFile: preparedCall?.before.file, afterFile: preparedCall?.after.file } : undefined,
            onGap: hearInBefore, onBand, onPick: pickPoint, onRange: markRange, holdPassage: cutWaits, reviewRange, writeRequest, heard: heardPick, quiet: quietOpen }} threadView={playerView}
            workingCache={workingCache} draftVersion={previewVersion} draft={previewTimeline}
            openingJoin={!source && (appliedCut ? joinPending : openingJoin)} cutLoadError={cutLoadError}
            draftFailed={openingJoin ? !!single.error || (!!single.preview && !listenJoined) : pinnedCallVersion ? !!savedBefore.error : !appliedCut && !!draftVersion && draftState?.version === draftVersion && !!draftState.failed}
            onRetryDraft={openingJoin ? single.retry : pinnedCallVersion ? savedBefore.retry : () => setDraftAttempt(n => n + 1)} source={source} autoPlaySource={sourceChoice.play && source === chosenSource} hasCut={hasCut}
            change={draftVersion && !appliedCut ? viewed : undefined} spot={shownPlace} approval={!!draftVersion && !appliedCut} playChange={reviewPlays}
            active={workspaceActive} onMedia={() => setPanel("media")} joined={joinedPlayer} />
          {chosenSource && hasCut && source === chosenSource && <div className="simple-decide" role="region" aria-label="Source preview">
            <span className="simple-decide-text"><small>Source clip</small>{chosenSource.name}</span>
            <button type="button" className="btn-ghost" onClick={backToVideo}>Back to the video</button>
          </div>}
        </div>
        {/* The Transcript is its own column on the right of the player, so the chat stays in view beside it. */}
        {transcript && <ChatRail compact={compact} id="simple-transcript" className="simple-transcript-rail" label="Transcript" side="right" resizes="transcript"
          storageKey="scarlet.simpleTranscriptWidth" initialWidth={transcriptRailWidth} minWidth={TRANSCRIPT_RAIL_MIN} maxWidth={available => available * 0.4}>
          {/* Headed as the chat is: its name, and the × that closes it. */}
          <header className="simple-header"><h1 title={source?.name}>Transcript{source && <span className="simple-header-sub"> · {source.name}</span>}</h1>
            <button type="button" className="btn-icon" aria-label="Close transcript" title="Close transcript (Esc)"
              onClick={() => setTranscript(false)}><Icon name="x" /></button></header>
          <div className="simple-transcript"><Suspense fallback={<Loading label="Opening transcript…" />}>
            {/* An applied cut plays on the version before it, so its transcript is that version's: the working cut's
                would highlight and seek early by everything the pass took out before that point. */}
            <TranscriptPane key={source?.id ?? (appliedCut ? beforeCut!.version : draftVersion) ?? head} draft={appliedCut ? beforeTimeline : draft} source={source}
              onAsk={askAbout} />
          </Suspense></div>
        </ChatRail>}
      </Dropzone>
    </main>
    {panel === "media" && <MediaDrawer uploads={uploads} notice={local ? undefined : notice}
      onPlay={id => previewSource(id, true)} onClose={() => setPanel(null)} />}
    {panel === "export" && <ExportSheet hasCut={hasCut} onClose={() => setPanel(null)} />}
  </EditHoverContext.Provider>;
}

/**
 * What the next ⌘Z takes back, in the timeline's bottom row, while there is something to take back: "Undo Keep ⌘Z".
 * Its hover names the cut or edit. A press does what ⌘Z does.
 */
function UndoLabel({ projectId, onUndo }: { projectId: string; onUndo(): void }) {
  const step = useUndoStore(s => lastStep(s.steps, projectId));
  const undoing = useUndoStore(s => s.undoing !== undefined);
  const error = useUndoStore(s => s.error?.projectId === projectId ? s.error : undefined);
  // The reason goes after a while, as soon as anything else is done or taken back.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => useUndoStore.setState(s => s.error === error ? { error: undefined } : s), 10_000);
    return () => clearTimeout(timer);
  }, [error]);
  if (!step && !error) return null;
  const words = step && undoWords(step);
  return <span className="timeline-undo">
    {/* Why the last one couldn't be taken back. It went from the list, so the next press goes on to the one before. */}
    {error && <span className="timeline-undo-error" role="alert" title={error.text}>{error.text}</span>}
    {step && words && <button type="button" className="timeline-undo-button" data-key={undoKey()} aria-keyshortcuts="Meta+Z Control+Z" title={words.title}
      disabled={undoing} onClick={e => { if (e.detail) e.currentTarget.blur(); onUndo(); }}>
      <Icon name="undo" size={12} />{undoing ? "Undoing…" : words.label}</button>}
  </span>;
}

/** The passage Scarlet asks the editor to check, as the clock reads it: one time for a moment, from and to for a stretch. */
/** The box is aimed at a cut or an edit, not at a moment or the whole video. */
function aimedAtChange(aim: AgentContext | "whole" | null) {
  return !!aim && aim !== "whole" && !!aim.changeId;
}

function checkSpan({ start, end }: TimeRange) {
  return end - start < 0.05 ? clockLabel(start) : clockRange(start, end);
}

/** The frame the editor drew on for a request, with their marks, before their words in its band. */
function MarkedFrameOnRequest({ projectId, task }: { projectId: string; task: Task }) {
  const drawn = task.context.pictureMarks;
  if (!drawn) return null;
  const count = drawn.marks.length;
  return <img className="unit-marked-frame" src={markedFrameUrl(projectId, drawn.attachmentId)} alt=""
    title={`Marked frame ${clockLabel(drawn.time)} · ${count === 1 ? "1 mark" : `${count} marks`}`} />;
}
