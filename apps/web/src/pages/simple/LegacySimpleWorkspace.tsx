import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useSearchParams } from "react-router-dom";
import { ChatRail } from "../../components/shell/ChatRail";
import { appliedReviewChange, timelineDuration, type Change, type CutAssessment, type TimeRange } from "@scarlet/timeline";
import { isAsideTask, fullRenderContext, isProjectEditTask, matchesEdit, queueOrder, queueWaits, requestText, threadEditList, type EditRef, type LearningDecision, type Task, type ThreadEdit } from "@scarlet/shared";
import { useReviewed, useRevising } from "../../components/review/threadEditState";
import { QueueTray, useRewordingHold, type QueuedRequest } from "../../components/chat/QueueTray";
import { recordEditReview, recordEditReviews } from "../../lib/editReviews";
import { forgetCalls, recordUndo, undoLast, type CallStep } from "../../lib/undo";
import { editKey, keepEdits, notYetKept } from "../../lib/keptEdits";
import { resumeRunChoice, useAgentAvailability } from "../../components/agent/AgentChip";
import type { PausedAt } from "../../components/agent/Composer";
import { useImportTranscription } from "../../components/media/TranscriptionAction";
import { Dropzone, useImportCount, useUploader } from "../../components/media/UploadDropzone";
import { MediaDrawer } from "../../components/media/MediaDrawer";
import { useVideoCaching } from "../../components/media/MediaMenuItems";
import { LearningsPanel, learningsToReview } from "../../components/review/LearningsPanel";
import { usePlaybackCache } from "../../components/player/usePlaybackCache";
import { focusAround } from "../../components/player/SimpleProgress";
import { useCutReview, type SingleCutDrafts } from "../../components/review/useCutReview";
import { callToPrepare, editToPrepare, usePrepareReviewCuts, type PreparedCut, type CutToPrepare } from "../../components/review/usePrepareNextCut";
import { CutWordsLine } from "../../components/review/CutTranscript";
import { editDetail } from "../../lib/editDetail";
import { editSource } from "../../components/review/EditSource";
import { useReviewTimeline } from "../../components/review/useReviewTimeline";
import { ExportSheet } from "../../components/review/ExportVideo";
import { useThreadTimeline } from "../../components/review/useThreadTimeline";
import { Loading } from "../../components/ui/primitives";
import { api, errorMessage } from "../../lib/client";
import { readTimeline } from "../../lib/timelineCache";
import { appLog } from "../../lib/appLog";
import { clock as clockLabel, lengthLabel, parseTimestamp, plural, removedSeconds, distinctClock } from "../../lib/format";
import { editPlaybackRange } from "../../lib/editPlaybackRange";
import { listMoments, momentRange } from "../../lib/editMoments";
import { reviewStops, rowAfter, rowBeside, rowNext, rowPlace, rowsOfTab, stopsShown, tabShown, type ListOrder, type ReviewStop } from "../../lib/reviewTabs";
import { editFocus, editKindWord } from "../../lib/editKind";
import { player } from "../../lib/player";
import { cutChange } from "../../lib/appliedCutPlayback";
import { cutViewBase } from "../../lib/cutViewBase";
import { usePlayerStore } from "../../stores/player";
import type { JoinClock } from "../../lib/joinClock";
import { buildThreads, firstCutDeliveries, isRedo, revisionTarget, stagedCuts, type Thread } from "../../lib/threads";
import { runIsActive } from "../../lib/taskRun";
import { lastAttempt, laterAttempts, notesStillAsked, redoWords, requestRoots, stagingTask, takenFromQueue, threadRuns, waitingToStart } from "../../lib/requestRuns";
import { callRevisions, decidedPassCalls, isOpenPass, keepGoesTo, noRevisions, openPass, passForYouOrder, passRevision, reviewCalls, revisedFrom, revisionCut, savedChoices,
  type Call, type CutChoice, type PassForYouItem } from "../../lib/passCalls";
import { callNow, carriedCall, carryingVersions, revisedCall } from "../../lib/carriedCuts";
import { canPreviewMedia } from "../../lib/upload";
import { showingWorkingCut, useShownCut } from "../../stores/shownCut";
import { useProjectStore } from "../../stores/project";
import { messageTimestamps, type MessageClock } from "../../lib/messageTimestamps";
import { markedRangeOf, playheadPoints, pointOf, useUiStore, withMarkedRange, type AgentContext, type MarkedRange } from "../../stores/ui";
import { CutPreview } from "../WatchPage";
import { EditHoverContext, type TimelineDot, type TimelineGap } from "../../components/review/TimelineScrubber";
import { aimedAtChange, approves, belongsTo, changeForEdit, firstKey, isWorking, noEdits, noop, shortTitle, stepsOver, tagOf,
  type ChatActions, type HoveredReviewRow, type Listening, type LocatedReview, type OpenList, type OpenPass, type Panel, type PassList, type ReportReviewMarkers } from "./types";
import { WorkspaceComposer } from "./WorkspaceComposer";
import { SimpleHeader } from "./SimpleHeader";
import { TRANSCRIPT_RAIL_MIN, TranscriptRail } from "./TranscriptRail";
import { savedRewording, saveRewording } from "./rewordingStorage";
import { savedCollapsed, savedDockList, savedOpenLists, saveCollapsed, saveDockList, saveOpenLists } from "./openListsStorage";
import { AppliedEditCard, CallCard, RejectedEditCard, SuggestionCard, UndoError } from "./ReviewCards";
import { ReviewDock } from "./ReviewDock";
import { ReviewDockContext, ReviewDockStore, stepInDock, type DockEntry } from "./reviewDockStore";
import { TimelineWorking } from "../../components/review/TimelineWorking";
import { Turn } from "./Turn";
import { useCallListen } from "./useCallListen";
import { useAppliedCut, type AppliedCutSide, type StagedCall } from "./useAppliedCut";
import { useCutAdjust } from "./useCutAdjust";
import { useCallCardShortcuts, useCarryingFootage, useChatAutoFollow, useDraftTimeline, useEditCardShortcuts, useLandingTracker, useOutsideClearMarkedRange, usePassCallNumbers, usePassChoices, useProjectBookmark, useEscapeCloses, useUndoShortcut, useWatchedMomentAutoKeep } from "./workspaceHooks";
import "../../simple.css";

const narrow = window.matchMedia("(max-width: 767px)");
function subscribeWidth(update: () => void) {
  narrow.addEventListener("change", update);
  return () => narrow.removeEventListener("change", update);
}
/** A revision of a whole applied edit, aimed at the version it made, from its first place. */
function wholeEdit(change: Change): AgentContext {
  const range = change.ranges[0];
  return { changeId: change.id, version: change.appliedVersion ?? change.toVersion, time: range?.start ?? 0, end: range?.end,
    clipIds: [], label: "Revision" };
}
/** The chat, until the user drags the divider: room for a conversation without crowding the video. */
const simpleRailWidth = (available: number) => Math.max(380, Math.min(480, available * 0.32));
/** The narrowest the chat stays usable at. */
const SIMPLE_RAIL_MIN = 320;

/**
 * The workspace: speak or type an edit, then watch each change with Before and After.
 * Every request is in one conversation, oldest first. The player on the right shows whatever the chat points at.
 */
export function LegacySimpleWorkspace() {
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
  const ordered = useMemo(() => [...threads].sort((a, b) => parseTimestamp(a.createdAt) - parseTimestamp(b.createdAt)), [threads]);
  const threadIds = useMemo(() => ordered.map(t => t.id), [ordered]);
  const { justLanded, landedAt } = useLandingTracker(changes, current.reviewStatus);

  // The fixed bottom review lists dock: merges For you / Working / Done (and untabbed See all) across requests so
  // edit lists stay fixed at the bottom above the message box while new messages flow above them.
  const [dock] = useState(() => new ReviewDockStore());
  const dockHasTabs = useSyncExternalStore(dock.subscribeHasTabs, dock.hasTabsSnapshot, dock.hasTabsSnapshot);
  const [dockList, setDockList] = useState<OpenList>(() => savedDockList(current.id));
  const [flashedThread, setFlashedThread] = useState<string>();
  const flashTimer = useRef<number>(0);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const flashThreadInDock = useCallback((threadId: string) => {
    clearTimeout(flashTimer.current);
    setFlashedThread(threadId);
    flashTimer.current = window.setTimeout(() => setFlashedThread(undefined), 1150);
  }, []);
  const dockListOf = useRef(current.id);
  useEffect(() => {
    if (dockListOf.current === current.id) return saveDockList(current.id, dockList);
    dockListOf.current = current.id;
    setDockList(savedDockList(current.id));
  }, [current.id, dockList]);

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
  // They are kept across a restart, so the chat comes back as the editor left it.
  const [lists, setLists] = useState<Record<string, OpenList>>(() => savedOpenLists(current.id));
  const listsOf = useRef(current.id);
  useEffect(() => {
    if (listsOf.current === current.id) return saveOpenLists(current.id, lists);
    listsOf.current = current.id;
    setLists(savedOpenLists(current.id));
  }, [current.id, lists]);
  // The requests folded to their headings with the arrow at a heading's left, kept across a restart as the lists are.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => savedCollapsed(current.id));
  const collapsedOf = useRef(current.id);
  useEffect(() => {
    if (collapsedOf.current === current.id) return saveCollapsed(current.id, collapsed);
    collapsedOf.current = current.id;
    setCollapsed(savedCollapsed(current.id));
  }, [current.id, collapsed]);
  const collapse = useCallback((run: string) => setCollapsed(all => {
    const next = new Set(all);
    if (!next.delete(run)) next.add(run);
    return next;
  }), []);
  // A request whose cut or edit is opened is unfolded, so the row that says which one is open is in view.
  const unfold = useCallback((thread: Thread) => setCollapsed(all => {
    const runs = new Set(threadRuns(thread).map(run => run.root));
    return [...runs].some(run => all.has(run)) ? new Set([...all].filter(run => !runs.has(run))) : all;
  }), []);
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
  // timeline back when it is new or applies an edit. A second press on the picked band, or Esc, lets go (null), and
  // then the timeline marks every request's edits until the editor presses a band or the latest request moves on.
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

  // Why a call or the pass didn't go through reads with the pass; why the suggestion didn't, on its card.
  const [decideError, setDecideError] = useState("");
  const [stripError, setStripError] = useState("");
  // Keep or Cut for each staged cut. Undecided ones follow Scarlet: once it has assessed the pass,
  // footage stays unless it said cut. Without assessments every proposed cut applies.
  const { unsaved, choicesOf, applyWhenDone, saveChoices: persistChoices } = usePassChoices(setDecideError);
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
  const saveChoices = (change: Change, calls: Record<number, CutChoice>, apply?: boolean) => persistChoices(change, calls, passRunning, apply);
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
  const suggestionLine = placeOnScreen && focusAround(placeOnScreen, cutDuration ?? 0, undefined, { undecided: true });
  // The version an applied cut's After plays: the one its change made, or the video as it runs now once anything
  // has changed it since. An undone cut, whose version before it is the video now, keeps its own.
  const afterOf = (made: { version: string; removed?: TimeRange[] } | undefined, before: string | undefined) =>
    made && head && made.version !== head && before !== head ? { version: head, removed: undefined } : made;
  const editPlaybackKey = (edit: ThreadEdit, after?: string, base?: string) => JSON.stringify([current.id, firstKey(edit), edit.beforeCut?.version, after,
    edit.beforeCut?.removed.start, edit.beforeCut?.removed.end, base]);
  // The earlier version an applied cut opens on, so the cuts earlier batches made round it show too (`cutViewBase`).
  const viewBaseOf = (edit: ThreadEdit, thread: Thread | undefined, edits: readonly ThreadEdit[]) => thread && cutViewBase(edit, edits, e => {
    const made = Date.parse(cutChange(e, thread.changes)?.createdAt ?? "");
    return Number.isFinite(made) ? made : NaN;
  }, head ?? undefined);
  // Cuts are prepared and drafted on the working cut on screen: one saved under a playing listen waits with it, so the
  // listen's own version isn't thrown away and asked for again with each save.
  const shownProject = useMemo(() => head && head !== current.project.head ? { ...current.project, head } : current.project, [current.project, head]);
  const reviewContext = useMemo(() => fullRenderContext(shownProject), [shownProject]);
  const draftCache = useMemo<SingleCutDrafts>(() => new Map(),
    [reviewContext, pass?.id, pass?.toVersion, current.renderSettingsRevision]);
  const preparedCandidates = useMemo(() => new Map<string, PreparedCut>(), [draftCache]);
  const {
    returningCall, review, liveReview, passRemovals, listenRemovals, stagedOn, toWorkingCut, placing, placeCut, placed,
    overrideForCall, cutOverride, rechecking, conflict, answeringCut, versionBefore, callPlaybackKey, beforeVersion, preparedCall, savedBefore,
    callTimeline, callDuration, pinnedCallVersion, versionAfter, savedAfter, needsSingleCut, single, heard, audition, listenJoined,
    listedPassEdits, rejectedPassEdits, locatedPassEdits, callView, visit, viewAudition, viewJoined, playedAudition, callViewNow,
    listenCache, openingJoin, listenSide, hearGapInCall, listenFrom,
  } = useCallListen({ current, pass, passThread, revisionInput, listening, setListening, cutReview, cutRuns, head, timeline, fps,
    focusThread, threadTimeline, draftCache, preparedCandidates, quietOpen });
  // The proposed version a suggestion would produce. Before shows the working cut at the same spot.
  const draftVersion = side === "after" && viewed && viewed.state !== "failed" && viewed.toVersion !== head ? viewed.toVersion : undefined;
  const { draft, draftFailed, retryDraft } = useDraftTimeline(current.id, draftVersion);
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
    player.pause(true);
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
  useEffect(() => { setDecideError(""); }, [pass?.id]);
  useEffect(() => { setStripError(""); }, [suggestion?.id]);
  /**
   * Approve or skip the call that's playing, then move on to the next row still waiting in For you, a call or a
   * flagged edit. The last call applies the pass, with Scarlet's picks for the rest, or schedules it for when Scarlet
   * finishes checking.
   */
  async function decideCut(choice: CutChoice) {
    if (!pass || !listening || listening.changeId !== pass.id || deciding) return;
    const was = choicesOf(pass)[listening.index];
    const decidedNow = { ...choicesOf(pass), [listening.index]: choice };
    // ⌘Z takes this call back: it waits on the editor again, or is decided as it was before this press changed it.
    if (was !== choice) recordUndo({ kind: "call", word: choice === approves(allCalls.find(a => a.index === listening.index)) ? "Keep" : "Reject",
      projectId: current.id, changeId: pass.id, index: listening.index, ...(was && { was }) });
    // A and S reach the log as a bare key: this says which call it decided and how many still wait.
    appLog("action", choice === approves(allCalls.find(a => a.index === listening.index)) ? "approve-call" : "skip-call", { change: pass.id, cut: listening.index, at: listening.cut.start, left: remainingCalls.length });
    const nextDock = dockHasTabs ? nextDockAfterKeep(listedAt.get(listening.index) ?? listening.cut.start) : undefined;
    const next = nextAfterCallDecision;
    player.pause();
    if (dockHasTabs) {
      if (nextDock?.row.callIndex !== undefined) {
        const nextCall = allCalls.find(a => a.index === nextDock.row.callIndex);
        if (nextCall) {
          setListening({ changeId: pass.id, index: nextCall.index, cut: { start: nextCall.start, end: nextCall.end }, side: "after", take: 0, key: `${pass.id}/${nextCall.index}` });
          return void saveChoices(pass, decidedNow);
        }
      }
      if (nextDock?.row.open) nextDock.row.open();
      else setListening(undefined);
      if (remainingCalls.length > 0) return void saveChoices(pass, decidedNow);
      if (revision || queuedCuts.size) return void saveChoices(pass, decidedNow);
      if (passRunning) return void saveChoices(pass, decidedNow, true);
      await approveReview(pass, decidedNow, !!nextDock?.row.open);
      return;
    }
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
  const [cutSide, setCutSide] = useState<AppliedCutSide>();
  const [scriptFor, setScriptFor] = useState<string>();
  // Before, and a cut's open words, belong to one visit: the next cut opens unlit and folded, and so does this one
  // when the editor opens it again. A card that only reloads under them, as when a new working cut lands, keeps both.
  const startVisit = () => { setCutSide(undefined); setScriptFor(undefined); };
  // The picked request lets go: its band is plain again and the timeline marks every request's edits.
  function letGo(threadId: string) {
    // Its full list goes with it, since an open list keeps its request on the timeline.
    setLists(all => all[threadId] === "all" ? Object.fromEntries(Object.entries(all).filter(([id]) => id !== threadId)) : all);
    if (openList === threadId) setOpenList(undefined);
    setPicked(null);
    setFocus(undefined);
  }
  // A press anywhere else in the chat, with nothing open, lets the picked band go too, as Esc does. Presses on the
  // message box, on a band, and on anything with its own press (links, buttons, menus) keep theirs.
  function letGoOnChatPress(e: React.MouseEvent<HTMLElement>) {
    if (e.defaultPrevented || e.button !== 0 || !focusThread || showing || listening || suggestion) return;
    const target = e.target as Element;
    if (target.closest('.unit-msg, .composer-dock, .simple-review-dock, button, a, input, textarea, select, label, [role="button"], [role="menu"], [role="menuitem"], [role="dialog"], .said.is-clipped, .said.is-open')) return;
    if (window.getSelection()?.toString()) return;
    if (!e.currentTarget.querySelector(".unit-msg.is-marked")) return;
    letGo(focusThread.id);
  }
  function markThread(threadId: string) {
    // Pressed again with nothing open, the picked band lets go.
    if (threadId === focusThread?.id && !showing && !listening && !suggestion) return letGo(threadId);
    // Whatever was open goes with the timeline it was on, and so does another request's list of every edit.
    stopShowing();
    setLists(all => Object.entries(all).some(([id, list]) => id !== threadId && list === "all")
      ? Object.fromEntries(Object.entries(all).filter(([id, list]) => id === threadId || list !== "all")) : all);
    if (openList !== threadId) setOpenList(undefined);
    setPicked(threadId === ordered.at(-1)?.id ? undefined : threadId);
    setFocus(undefined);
  }
  function listenCall(change: Change, a: CutAssessment) {
    if (passThread) unfold(passThread);
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
    setAimAgain(n => n + 1);
  }
  /** Opening an edit takes whatever else had the player: a call, a suggestion, a clip from Media, the last visit's side and words. */
  function leaveForEdit() {
    startVisit();
    player.pause();
    setSourceChoice({ id: "", play: false });
    setReviewId(undefined);
    setListening(undefined);
  }
  function playChange(thread: Thread, change: Change) {
    // The request's line pressed again while its edit is open plays that edit again as its row does: on the side it
    // was on, with its words left open. The message box is aimed at it again, as on any press of the line.
    const first = thread.id === focus?.threadId ? threadTimeline.edits.find(e => belongsTo(e, change)) : undefined;
    if (first && showing && matchesEdit(showing, first)) { openEdit(thread, first); setAimAgain(n => n + 1); return; }
    leaveForEdit();
    if (thread.id === focus?.threadId && !threadTimeline.loading) {
      const edit = threadTimeline.edits.find(e => belongsTo(e, change));
      if (edit) { threadTimeline.choose(edit, "chat"); setAimAgain(n => n + 1); return; }
    }
    reloadFailedMarkers(thread);
    if (thread.id !== focus?.threadId) wentSince.current = newest;
    setFocus({ threadId: thread.id, changeId: change.id });
  }
  function playEdit(edit: ThreadEdit, single?: boolean) {
    leaveForEdit();
    threadTimeline.choose(edit, "chat", single);
    setAimAgain(n => n + 1);
  }
  function openEdit(thread: Thread, ref: EditRef, from?: string, single?: boolean) {
    unfold(thread);
    // The edit that's open, pressed again, plays again from the top: its card and the timeline's zoom stay. A cut
    // starts over as the video runs, unlit; any other edit keeps its side. Esc is what closes it. A cut plays under
    // this view's own listen; any other edit under the player's. A moment's main edit picked on its own from under
    // the moment's row, or the moment picked again from its row, is opened anew.
    const sameWay = threadTimeline.single === !!single;
    if (showing && !threadTimeline.leaving && matchesEdit(showing, ref) && thread.id === focus?.threadId && sameWay) {
      setOpenedFrom(from ? { run: from, ref: { changeId: ref.changeId, spot: ref.spot } } : undefined);
      player.pause();
      // Choosing it again takes the aim off an empty message box, so the box is aimed at the cut or edit again.
      if (cutKey) setCutSide(prev => ({ key: cutKey, side: "after", take: (prev?.key === cutKey ? prev.take : 0) + 1 }));
      else threadTimeline.choose(showing, "chat");
      setAimAgain(n => n + 1);
      return;
    }
    setOpenedFrom(from ? { run: from, ref: { changeId: ref.changeId, spot: ref.spot } } : undefined);
    if (threadTimeline.leaving) threadTimeline.stay();
    leaveForEdit();
    if (thread.id === focus?.threadId && !threadTimeline.loading) {
      const edit = threadTimeline.edits.find(e => matchesEdit(e, ref)) ?? threadTimeline.rejected.find(e => matchesEdit(e, ref));
      if (edit) { threadTimeline.choose(edit, "chat", single); setAimAgain(n => n + 1); return; }
    }
    reloadFailedMarkers(thread);
    if (thread.id !== focus?.threadId) wentSince.current = newest;
    setFocus({ threadId: thread.id, changeId: ref.changeId, spot: ref.spot, ...single && { single } });
  }
  /** A decision a rule in Learnings came from, pressed there: its cut or edit opens on the timeline, or the player goes to where it was. */
  function openDecision(decision: LearningDecision) {
    const thread = decision.threadId ? threads.find(t => t.id === decision.threadId) : undefined;
    if (thread && decision.ref) return openEdit(thread, decision.ref);
    if (decision.time === undefined) return;
    stopShowing();
    player.seek(decision.time, true);
  }
  const chosenRef = useRef(false);
  chosenRef.current = threadTimeline.chosen;
  function listOpen(threadId: string, open: boolean, moved?: boolean) {
    setOpenList(current => open ? threadId : current === threadId ? undefined : current);
    if (open && !moved) setFocus(f => f?.threadId === threadId ? f : { threadId });
    else if (!open && !chosenRef.current) setFocus(f => f?.threadId === threadId && !f.changeId ? undefined : f);
  }
  const lightMark = (time?: number, row?: HoveredReviewRow) => {
    // A row's dot is where its footage is on the version the timeline shows.
    const view = callViewNow.current;
    hoveredEdit.setState(time !== undefined && view ? view.toBase(time) ?? time : time, true);
    hoveredRow.setState(row, true);
  };
  function stopShowing() {
    setOpenedFrom(undefined);
    player.pause();
    threadTimeline.clear();
    setListening(undefined);
    setReviewId(undefined);
  }
  function reviewSuggestion(change: Change) {
    player.pause();
    setSourceChoice({ id: "", play: false });
    threadTimeline.clear();
    setListening(undefined);
    setReviewId(change.id);
    setReviewPlays(n => n + 1);
  }
  function reviseChange(thread: Thread, change: Change) {
    const edit = showing && belongsTo(showing, change) ? showing : undefined;
    const target = edit && threadTimeline.selectedTarget;
    if (edit && target) return startRevision(thread, target, `“${edit.label}” at ${clockLabel(edit.at ?? edit.range.start)}`);
    startRevision(thread, wholeEdit(change), "this whole edit");
  }
  function replyToThread(thread: Thread) {
    // As Revise does, Answer waits for a message being spoken to go out: aiming the box now would drop it.
    if (useUiStore.getState().speaking) return;
    const question = thread.question;
    if (pass && question?.cutConflict?.range) {
      const index = passIndex(question);
      const call = allCalls.find(a => a.index === index);
      if (call) listenCall(pass, call);
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
  }

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
  // While a pass waits on the editor, its calls and the edits of its request that ask for a look go by their times:
  // each is named the same in the list, on its card and in the box's tag, as what it is and where it is, "Cut at 8:52",
  // or "Edit at 8:52" for one that took no footage out. The order they reached the editor in is kept, but never shown.
  const passRoot = pass ? (stagingTask(pass, changes, tasks) ?? tasks.find(t => t.id === pass.taskId)) : undefined;
  const { callNo, passEditNo } = usePassCallNumbers(current.id, pass, passThread, passRoot, allCalls, passEdits, passThread ? rejectedPassEdits : noEdits);
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
  // A call goes by its time on the working cut, where its row is in the list. A request about that cut, its card, its
  // row and its tag in the box all say "Cut at 2:47".
  const callAtTime = (about: { changeId?: string; cutIndex?: number }) => {
    if (!pass) return undefined;
    const index = callNow(pass, about, passThread?.changes ?? [], changes, tasks, footage);
    const call = index === undefined ? undefined : allCalls.find(a => a.index === index);
    return call && (listedAt.get(call.index) ?? call.start);
  };
  const cutName = (about: { changeId?: string; cutIndex?: number; editIndex?: number }) => {
    if (about.editIndex !== undefined && about.changeId) return passEditNo.get(`${about.changeId}/${about.editIndex}`)?.name;
    const at = callAtTime(about);
    // Two calls in one second are told apart to the millisecond.
    return at !== undefined ? `Cut at ${distinctClock(at, [...listedAt.values()])}` : undefined;
  };
  // Where each call goes in the list: at its time on the working cut, among the edits made there. One that isn't there
  // as it was staged goes where what is left of its footage sits, or else with the call before it, so the calls keep
  // their order. Until the pass's version is in, the calls keep the pass's own times.
  const listedAt = new Map<number, number>();
  for (const a of allCalls) {
    const override = overrideForCall(a.index);
    listedAt.set(a.index, override ? override.range.start : placing ? a.start
      : placeCut(a)?.start ?? toWorkingCut?.map(a.start, "right") ?? toWorkingCut?.map(a.end, "left") ?? [...listedAt.values()].at(-1) ?? 0);
  }
  const openPassState: OpenPass | undefined = pass && passThread ? {
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
        tag: approves(a) === "cut" ? removedSeconds(a.end - a.start) : "Check",
        run: cutRuns.get(a.index),
        state: sentBack(a.index) ? "revising" : passChoices[a.index] === undefined ? "open" : passChoices[a.index] === approves(a) ? "approved" : "skipped" };
    }),
    openCall: index => { const call = allCalls.find(a => a.index === index); if (call) listenCall(pass, call); },
    unkeepCall: index => {
      if (deciding === pass.id) return;
      const choices = choicesOf(pass);
      const was = choices[index];
      if (was === undefined) return;
      const { [index]: _decided, ...rest } = choices;
      recordUndo({ kind: "call", word: "Unkeep", projectId: current.id, changeId: pass.id, index, was,
        name: cutName({ changeId: pass.id, cutIndex: index }) });
      appLog("action", "unkeep-call", { change: pass.id, index });
      void saveChoices(pass, rest, false);
    },
    apply: () => void (passRunning ? saveChoices(pass, choicesOf(pass), true) : approveReview(pass)),
  } : undefined;
  const actions: ChatActions = {
    reviewLearning(id) { setLearnFocus(id); setPanel("learnings"); },
    atOnce: tasks.filter(t => isWorking(t.state) && t.kind !== "transcribe" && !isAsideTask(t)
      && !!t.context.changeId && (t.context.cutIndex !== undefined || t.context.editIndex !== undefined)).length,
    pass: openPassState,
    showing,
    showingSingle: threadTimeline.single,
    showingFrom: openedFrom && showing && matchesEdit(showing, openedFrom.ref) ? openedFrom.run : undefined,
    marked: focusThread?.id,
    mark: markThread,
    collapsed,
    collapse,
    fitTimeline() { setFitTimeline(n => n + 1); },
    reviewingId: suggestion?.id,
    listening,
    listen: listenCall,
    play: playChange,
    playEdit,
    openEdit,
    listOpen,
    lightMark,
    stopShowing,
    review: reviewSuggestion,
    revise: reviseChange,
    reply: replyToThread,
    // The one question that waits, while the box is on it and says Answer. Answer on a question about a cut also opens
    // that cut, and with several waiting it says which the box is on: those keep their link.
    answering: replyThread?.question && !replyThread.question.cutConflict?.range && (!agentContext || agentContext === "whole")
      && tasks.filter(t => t.kind !== "transcribe" && t.state === "waiting_for_user" && !!t.question).length === 1 ? replyThread.question.id : undefined,
    cutName,
    callTime: (changeId, cutIndex) => callAtTime({ changeId, cutIndex }),
    showThread(threadId) {
      const report = dock.get(threadId);
      if (!report) return;
      const waiting = report.entries.find(e => e.place === "you" && !e.row.rejected && !!e.row.open);
      const confident = report.entries.find(e => e.place === "optional" && !e.row.rejected && !!e.row.open);
      const workingEntry = report.entries.find(e => e.place === "working" && !!(e.row.stepOpen ?? e.row.open));
      const doneEntry = report.entries.find(e => e.place === "done" && !!e.row.open);
      if (waiting) {
        if (tabShown(dockList) !== "you") setDockList(undefined);
        waiting.row.open?.();
      } else if (confident) {
        setDockList(undefined);
        confident.row.open?.();
      } else if (workingEntry) {
        setDockList("working");
        (workingEntry.row.stepOpen ?? workingEntry.row.open)?.();
      } else if (doneEntry) {
        setDockList("done");
        doneEntry.row.open?.();
      }
      flashThreadInDock(threadId);
    },
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
  // Only the calls still waiting on the editor are marked, each with an amber dot. A decided call's dot goes.
  // A call's dot never shares a pill with an edit's.
  // A dot sits where the cut's footage is on the working cut. A cut that can't be placed there has no dot.
  // While a suggestion plays the timeline is the suggestion's, as it is a call's or an edit's while that is open: After
  // is on the version it proposes, where the pass's cuts sit elsewhere. The calls' dots are back when it closes.
  // The calls are on the timeline while the timeline is the pass's, while one of them is open, and while the editor
  // hasn't picked a request in the chat or gone to another's edit: they hold the next request. Another request picked,
  // or the marked band let go, the timeline marks only that request's edits, or nothing, and For you leads to them.
  const callsShown = !!pass && (passThread?.id === focusThread?.id || listening?.changeId === pass.id || (typeof picked !== "string" && !focus));
  const marks: TimelineDot[] = pass && !suggestion
    ? !callsShown ? [] : allCalls.flatMap(a => {
      const override = pass.cutEdits?.find(c => c.index === a.index);
      const at = sentBack(a.index) || passChoices[a.index] !== undefined ? undefined
        : override ? override.version === (pinnedCallVersion ?? head) ? override.range : undefined
        : pinnedCallVersion ? undefined : placeCut(a);
      return at ? [{ time: at.start, group: "call", title: `Cut at ${clockLabel(at.start)}`, summary: a.reason,
        detail: `Takes out ${lengthLabel(a.end - a.start)}`, context: pass.description, state: "check" as const, need: `Cut at ${clockLabel(at.start)}`,
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
  const cutPosition = openCall && heard ? `cut at ${clockLabel(heard.start)}` : "";
  const shownEdit = actions.showing;
  const reviewed = useReviewed(current.id, focusThread);
  const revisingEdit = useRevising(focusThread);
  const reviewRange = shownEdit?.check && !reviewed(shownEdit) && !revisingEdit(shownEdit) ? shownEdit.reviewRange : undefined;
  const shownAt = shownEdit && (shownEdit.at ?? shownEdit.range.start);
  // The applied edit on screen, so Revise is about it and not a proposal still waiting.
  // An edit another request made is open here when this request flagged it (`Thread.flagged`).
  const shownChange = changeForEdit(focusChanges, shownEdit);
  // The card names voice cleanup only where its edit put it on or changed it, read against the version the edit was made on.
  const shownCleanup = !!shownChange?.ops?.some(o => o.op === "updateClip" && JSON.stringify(o.patch).includes("voiceCleanup"));
  const shownChangeBefore = useReviewTimeline(current.id, shownCleanup ? shownChange!.fromVersion : undefined, timeline).timeline;
  // Keep (K) records that the edit was reviewed and moves on to the next flagged edit that hasn't been; Revise (R) changes this one.
  const reviewingEdit = shownEdit && shownChange && focusThread ? shownEdit : undefined;
  const threadEdits = threadTimeline.edits;
  // While another edit is open, the calls still waiting on the editor play as Scarlet staged them, their footage
  // stepped over on After, and the timeline shows each as a gap at its time: the video round the edit is the one
  // it will be, and a retake a call takes out doesn't look missed (the editor asked for it, 2026-11-23). A call Scarlet
  // would leave in, one revised into an edit of its own, or one that can't be placed on the video now plays as it is.
  const stagedKey = reviewingEdit && pass && !suggestion && !listening && !pinnedCallVersion && !placing
    ? waitingCalls.flatMap(a => {
      if (approves(a) !== "cut" || pass.cutEdits?.some(c => c.index === a.index)) return [];
      const at = placeCut(a);
      return at && at.end > at.start ? [`${a.index}:${at.start}:${at.end}`] : [];
    }).join(",") : "";
  const stagedCalls = useMemo<StagedCall[]>(() => !stagedKey || !pass ? [] : stagedKey.split(",").map(part => {
    const [index, start, end] = part.split(":");
    const call = allCalls.find(a => a.index === Number(index));
    return { removed: { start: Number(start), end: Number(end) },
      open: () => { if (call) actions.listen(pass, call); } };
  }), [stagedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const {
    cutBase, madeBy, afterSource, appliedAfterVersion, preparedEdit, rebasedCut, beforeCut, cutBefore, beforeTimeline, beforeDuration,
    cutKey, appliedCut, shownSide, appliedSide, visiting, afterTimeline, otherEdits, otherCuts, afterListen, appliedListen, appliedJoined,
    appliedCache, preparedAfter, joinPending, cutLoadError, heardPick, chooseCutSide, stagedAround, playedListen,
  } = useAppliedCut({ current, reviewingEdit, focusThread, threadTimeline, threadEdits, head, timeline, fps, cutSide, setCutSide,
    preparedCandidates, afterOf, editPlaybackKey, viewBaseOf, quietOpen, stagedCalls });
  // The player for After: the version with the join in its media, once it's known how it plays.
  const joinedListen = appliedCut ? appliedJoined : callView ? viewJoined : listenJoined;
  const joinedFile = appliedCut ? appliedCache : listenCache;
  const joinedPlayer = useMemo(() => joinedListen && joinedFile ? { ...joinedListen, file: joinedFile.url, cache: joinedFile.state } : undefined,
    [joinedListen, joinedFile?.url, joinedFile?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // An applied cut plays on the version before it. Until that version arrives nothing plays: the working edit
  // starting on the passage and stopping a moment later is a flash of the wrong picture and a clipped sound. If it
  // fails, the editor can retry from the monitor or the transcript.
  const cutWaits = !!beforeCut && !beforeTimeline;
  // On After the pass's other cuts are out of the media: they grey out, and a click plays one in Before from that point.
  // The grey and its name already say After skips it, so the hover note only says how much it took and Scarlet's words for it.
  // On Before they play, so they're only outlined; clicking one opens its edit instead of scrubbing.
  const gaps: TimelineGap[] = otherEdits.map(({ at, label, removed, edit }) => ({ start: removed.start, end: removed.end,
    title: `Cut at ${at} · ${lengthLabel(removed.end - removed.start)}`, summary: label, label: `Cut at ${at}`, shortLabel: at,
    skipped: appliedSide === "after",
    open: edit && focusThread ? () => actions.openEdit(focusThread, edit, undefined, true) : undefined }));
  // A waiting call's cut round the open edit, played as staged: grey as a cut, edged in amber, named by its time.
  // A press opens the call, on either side.
  const stagedGap = (c: StagedCall, skipped: boolean): TimelineGap => ({ start: c.removed.start, end: c.removed.end,
    title: `Cut at ${clockLabel(c.removed.start)} · ${lengthLabel(c.removed.end - c.removed.start)}`, summary: "Waits for your call",
    label: `Cut at ${clockLabel(c.removed.start)}`, shortLabel: clockLabel(c.removed.start), skipped, call: true, open: c.open });
  const stagedGaps = cutKey ? stagedAround.map(c => stagedGap(c, appliedSide === "after"))
    : !callView ? stagedCalls.map(c => stagedGap(c, true)) : [];
  // A call shown where the cuts around it still have their footage marks them the same way, by their time on the
  // working cut and with Scarlet's words for the one that made each.
  const callGaps: TimelineGap[] | undefined = callView?.shown.map(({ at, removed }) => {
    const made = [...(locatedPassEdits ?? []).map(edit => ({ edit, thread: passThread })),
      ...threadEdits.map(edit => ({ edit, thread: focusThread }))]
      .find(({ edit }) => edit.beforeCut && edit.at !== undefined && Math.abs(edit.at - at) < 1.5 / fps);
    return { start: removed.start, end: removed.end, title: `Cut at ${clockLabel(at)} · ${lengthLabel(removed.end - removed.start)}`, summary: made?.edit.label,
      label: `Cut at ${clockLabel(at)}`, shortLabel: clockLabel(at), skipped: listening?.side === "after",
      open: made?.thread ? () => actions.openEdit(made.thread!, made.edit, undefined, true) : undefined };
  });
  const hearInBefore = (gap: TimelineGap, time: number) => {
    if (gap.call) return gap.open?.();
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
  const openBookmark = () => openCall && pass ? `call:${pass.id}:${openCall.index}`
    // Until it has been opened again, what is to be opened is still what was open.
    : reviewingEdit && focusThread ? `edit:${focusThread.id}:${reviewingEdit.changeId}:${reviewingEdit.spot}` : reopen;
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
  useProjectBookmark(placeOnCut, openBookmark, panel);
  const onVideo = openCall && conflict ? (heard && callTimeline ? `Current passage at ${clockLabel(heard.start)}` : undefined)
    : openCall && visit?.side === "before" ? `Showing what the cut at ${visit.label} took out · Before`
    : openCall ? (cutPosition ? `Showing ${cutPosition} · ${listening!.side === "after" ? "After" : "Before"}${pinnedCallVersion ? " · As reviewed" : ""}` : undefined)
    : suggestion ? `Showing the suggestion · ${side === "after" ? "After" : "Before"}`
    : shownEdit && visiting ? `Showing what the cut at ${visiting.at} took out · Before`
    : shownEdit && appliedCut ? `Showing “${shownEdit.label}” · ${appliedSide === "after" ? "After" : "Before"}`
    : shownEdit ? `Showing “${shownEdit.label}” at ${clockLabel(reviewRange?.start ?? shownEdit.at ?? shownEdit.range.start)}`
    : chosenSource && source === chosenSource ? `Showing ${chosenSource.name}` : undefined;
  // A call's passage is shaded where its footage is on the working cut. One that can't be placed there shades nothing.
  // Anything still waiting on the editor's decision (an undecided call, suggestion, or flagged edit) gets a dashed edge;
  // once decided, or for any settled edit, its edge is solid.
  const callUndecided = !openCall || openCallBack || passChoices[openCall.index] === undefined;
  const editUndecided = !!shownEdit?.check && !reviewed(shownEdit);
  const callFocus = listening ? callView ? callView.focus : heard && callTimeline && focusAround(heard, callDuration ?? 0, conflict ? "Current passage" : `Takes out · ${lengthLabel(heard.end - heard.start)}`) : undefined;
  const editLine = shownEdit && !appliedCut && !shownEdit.beforeCut && !shownEdit.rejected && !reviewRange
    ? threadTimeline.selectedMoment
      ? editFocus({ ...shownEdit, range: momentRange(threadTimeline.selectedMoment) }, cutDuration ?? 0, `${threadTimeline.selectedMoment.edits.length} edits`, firstKey(shownEdit))
      : editFocus(shownEdit, cutDuration ?? 0, undefined, firstKey(shownEdit))
    : undefined;
  const lineFocus = listening ? callFocus ? { ...callFocus, ...callUndecided && { undecided: true }, ...(openCall && { key: `call:${openCall.askOrder ?? openCall.index}` }) } : undefined
    : places.length ? suggestionLine
    : appliedCut ? focusAround(appliedCut, beforeDuration, `Took out · ${lengthLabel(appliedCut.end - appliedCut.start)}`, { undecided: editUndecided, playbackEnd: afterListen?.end, key: cutKey })
    // Until the earlier version arrives, a line marks the join in the working cut and says how much came out there.
    : shownEdit?.beforeCut ? focusAround({ start: shownAt!, end: shownAt! }, cutDuration ?? 0,
      `Took out · ${lengthLabel(shownEdit.beforeCut.removed.end - shownEdit.beforeCut.removed.start)}`, { undecided: editUndecided })
    // A rejected edit is out of the video: its band is where it was, outlined, over the video as it runs without it.
    : shownEdit?.rejected ? focusAround(shownEdit.at !== undefined ? { start: shownEdit.at, end: shownEdit.at } : shownEdit.range, cutDuration ?? 0, "Rejected", { tone: "kept" })
    // Any other edit is drawn for what it did: a sound fix or a zoom keeps its footage, so After plays it.
    // A doubt Scarlet left is the passage it asks the editor to look at or hear: amber, as what waits on them is.
    : reviewRange ? focusAround(reviewRange, cutDuration ?? 0, "Check", { tone: "check" })
    // A moment is drawn across all of its edits, as it plays.
    : editLine ? editUndecided ? { ...editLine, undecided: true } : editLine : undefined;
  const playerView = suggestion || appliedCut ? undefined : !listening && focusThread && !source ? threadTimeline : undefined;
  // Each applied edit's dot names it, says where it sits and how long it runs, and quotes the change it came from.
  const editDot = (thread: Thread, e: ThreadEdit, title: string, at: number): TimelineDot => {
    const landed = justLanded(e.changeId) ? e.beforeCut || e.at !== undefined ? "cut" as const : "edit" as const : undefined;
    return { time: at, landed, landedAt: landed ? landedAt(e.changeId) : undefined, title, summary: e.label, edit: `${e.changeId}/${e.spot}`,
      detail: e.beforeCut ? `Took out ${lengthLabel(e.beforeCut.removed.end - e.beforeCut.removed.start)}`
        : e.at !== undefined ? editKindWord(e) ?? "Cut" : [editKindWord(e), span(e.range)].filter(Boolean).join(" · "),
      context: changeForEdit([...thread.changes, ...thread.flagged ?? []], e)?.description,
      // A press on the edit's marker opens it, as its row in the chat does.
      open: () => actions.openEdit(thread, e) };
  };
  /** A pass's edit by its time, as its row in the pass's list and the message box's tag say it: "Cut at 2:05". */
  const passEditName = (e: ThreadEdit, at: number) => `${e.beforeCut ? "Cut" : "Edit"} at ${clockLabel(at)}`;
  const passEditDot = (thread: Thread, e: ThreadEdit, at: number) => editDot(thread, e, passEditName(e, at), at);

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
  // The timeline marks the edits of the request picked in the chat, or of the one that's open, as the chat does:
  // filled once kept and amber while it asks for a look. With nothing picked it marks nothing, and another request's
  // edits draw nothing. An edit sent back for revision doesn't ask for a look until its new version arrives.
  const onLatest = !firstCuts?.size && marked?.id === focusThread?.id;
  const listShown = !!focusThread && openList === focusThread.id;
  // A pass's edits are all marked, except while the pass waits on the editor: then only the ones that ask for a look
  // are, and its other edits go in with the last call. They share a pill only with others like them.
  const passWaits = !!passThread && passThread.id === focusThread?.id && (waitingCalls.length > 0 ||
    passEdits.some(e => e.check && !passReviewed(e) && !passRevising(e)));
  const numberedDots: TimelineDot[] = playerView && focusThread ? playerView.edits.flatMap((e): TimelineDot[] => {
    const state = reviewed(e) ? "kept" as const : e.check && !revisingEdit(e) ? "check" as const : undefined;
    const current = e === shownEdit;
    const at = (state === "check" ? e.reviewRange?.start : undefined) ?? e.at ?? e.range.start;
    const need = state === "check" ? passEditNo.get(editKey(e))?.name ?? passEditName(e, at) : undefined;
    if (passWaits) return state === "check" || current ? [{ ...passEditDot(focusThread, e, at), group: "pass", state, current, need }] : [];
    // The hover note names the request, then where the edit is.
    const dot = editDot(focusThread, e, `${shortTitle(focusThread.title)} · ${clockLabel(at)}`, at);
    return [{ ...dot, state, current, need }];
  }) : [];
  // The waiting pass's edits that ask for a look are with its calls when the timeline is on another request. While the
  // timeline is the pass's own, its dots above draw them.
  const passDots: TimelineDot[] = !callsShown || !passThread || suggestion || (playerView && focusThread?.id === passThread.id) ? []
    : passEdits.flatMap(e => {
      if (!e.check || passReviewed(e) || passRevising(e)) return [];
      const at = e.reviewRange?.start ?? (e as ThreadEdit).at ?? e.range.start;
      return [{ ...passEditDot(passThread, e, at), group: "pass", state: "check" as const, need: passEditNo.get(editKey(e))?.name ?? passEditName(e, at) }];
    });
  // In the default full timeline, unresolved flags from older requests also need a way in. Their chat lists already
  // load positions on the current working cut. Use those positions only, so old versions cannot put a dot at the wrong time.
  const showOtherFlags = picked === undefined && !focus && !suggestion && !listening && !source;
  // With no request picked, the timeline marks every request's edits:
  // the editor let go of the picked band to see them all (2026-11-23). The waiting pass keeps its calls' dots.
  const showEvery = picked === null && !focus && !suggestion && !listening && !source;
  const drawnChecks = new Set([...numberedDots, ...passDots].filter(dot => dot.state === "check").map(dot => dot.edit));
  const otherFlags = showOtherFlags || showEvery ? [...ordered].reverse().flatMap(thread => {
    const review = backgroundReview.get(thread.id);
    if (!review || review.head !== head || thread.id === focusThread?.id || thread.id === passThread?.id) return [];
    return review.markers.flatMap(({ edit, state }) => {
      if (!showEvery && state !== "check") return [];
      const key = editKey(edit);
      if (drawnChecks.has(key)) return [];
      drawnChecks.add(key);
      const at = (state === "check" ? edit.reviewRange?.start : undefined) ?? edit.at ?? edit.range.start;
      return [{ ...editDot(thread, edit, `${shortTitle(thread.title)} · ${clockLabel(at)}`, at),
        group: thread.id, state, need: state === "check" ? passEditName(edit, at) : undefined }];
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
  // Which of each request's lists the chat shows: ↑ ↓ and Keep go by the rows of that tab.
  const explicitAllDock = dock.explicitAllReport(threadIds);
  const focusList = focusThread ? lists[focusThread.id] : undefined;
  const passList = dockHasTabs && !explicitAllDock ? dockList : passThread ? lists[passThread.id] : undefined;
  const passIsFocus = !!pass && !!passThread && passThread.id === focusThread?.id;
  const passEditList = passThread?.id === focusThread?.id && threadTimeline.edits.length > 0 ? threadTimeline.edits : passEdits;
  const passEditNum = (e: Omit<ThreadEdit, "at">) => passEditNo.get(editKey(e))?.n
    ?? e.previous.map(p => passEditNo.get(editKey(p))?.n).find(n => n !== undefined);
  // The waiting pass's calls and flagged edits together, in the order For you lists them: by time, as its rows lead
  // with their times (the editor's call, 2026-11-24).
  const passForYouItems = pass && passThread ? passForYouOrder(
    allCalls.map(call => ({ call, at: listedAt.get(call.index) ?? call.start, num: callNo.get(call.index), waiting: waiting(call) })),
    passEditList.filter(e => !!e.check).map(edit => ({
      edit, at: (edit as ThreadEdit).at ?? edit.range.start, num: passEditNum(edit), waiting: !passReviewed(edit) && !passRevising(edit),
    })),
    false,
  ) : [];
  const { decidedCallEditKeys, decidedCallRows } = useMemo(
    () => decidedPassCalls(pass && passThread?.id === focusThread?.id ? undefined : focusThread, threadEdits, threadTimeline.rejected),
    [pass, passThread?.id, focusThread, threadEdits, threadTimeline.rejected],
  );
  // Whether the request has something for the editor to review, now or decided: its rows are then under For you,
  // Working and Done in the chat, as its block there works it out. With nothing to review it has one list of every edit.
  const asksEditor = (run?: { state: Task["state"] }) => run?.state === "waiting_for_user";
  const focusTabbed = (passIsFocus && allCalls.length > 0) || decidedCallRows.length > 0
    || threadEdits.some(e => !!e.check || decidedCallEditKeys.has(editKey(e)))
    || threadTimeline.rejected.some(e => !!e.wasCheck || decidedCallEditKeys.has(editKey(e)));
  const activeFocusList = dockHasTabs && !explicitAllDock && focusTabbed ? dockList : focusList;
  // A flagged edit not yet kept says its place among the ones still to check, as a call does.
  const flaggedRows = useMemo(() => editsByRow.filter(row => row.some(waitingEdit)), [editsByRow, reviewed, revisingEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const waitingPassForYouEdits = passIsFocus ? passForYouItems.filter((item): item is Extract<PassForYouItem<Call, ThreadEdit>, { kind: "edit" }> => item.kind === "edit" && item.waiting) : [];
  const editPlace = reviewingEdit && waitingEdit(reviewingEdit)
    ? (passIsFocus ? waitingPassForYouEdits.findIndex(item => matchesEdit(item.edit, reviewingEdit)) : flaggedRows.indexOf(editsByRow[shownRow]!))
    : -1;
  const closeEdit = () => { player.pause(); threadTimeline.clear(); };
  // Every row of a request's lists is under exactly one tab (`rowPlace`), and the stops below are those rows as ↑ ↓
  // and Keep go through them: the chat draws its tabs by the same rule, so both agree on a tab's rows. A request that
  // asks the editor a question about a cut or an edit waits on them, so its row is For you's.
  const passWaitingEdit = (e: ThreadEdit) => !!e.check && !passReviewed(e) && !passRevising(e);
  // A flagged edit whose revision has stopped to ask the editor something waits on them again, as a call that asks does.
  const waitsOrAsks = (e: ThreadEdit) => waitingEdit(e) || (!!e.check && asksEditor(revisingEdit(e)));
  const passWaitsOrAsks = (e: ThreadEdit) => passWaitingEdit(e) || (!!e.check && asksEditor(passRevising(e)));
  const callWaitsOrAsks = (call: Call) => waiting(call) || (sentBack(call.index) && asksEditor(cutRuns.get(call.index)));
  const passEditRows = useMemo(() => passThread?.id === focusThread?.id && threadTimeline.edits.length > 0 && threadTimeline.moments
    ? threadTimeline.moments.map(m => m.edits) : listMoments(passEdits).map(m => m.edits) as ThreadEdit[][],
  [passThread?.id, focusThread?.id, threadTimeline.edits.length, threadTimeline.moments, passEdits]);
  const callStops = () => allCalls.map(call => ({ call, at: listedAt.get(call.index) ?? call.start, num: callNo.get(call.index),
    place: waiting(call) ? "you" as const : !sentBack(call.index) ? "done" as const : asksEditor(cutRuns.get(call.index)) ? "you" as const : "working" as const }));
  type Stop = ReviewStop<ThreadEdit, Call>;
  /** The focused request's stops: its rows of edits, the pass's calls when it is the pass's, and what was rejected. */
  const focusStopsNow = (): Stop[] => reviewStops({
    rows: editsByRow,
    place: row => rowPlace(row, { waits: waitsOrAsks, sent: e => !!revisingEdit(e),
      kept: e => reviewed(e) || decidedCallEditKeys.has(editKey(e)) }),
    num: passIsFocus ? passEditNum : undefined,
    calls: passIsFocus ? callStops() : [],
    gone: threadTimeline.rejected.map(e => ({ at: e.range.start, num: passIsFocus ? passEditNum(e) : undefined })),
  });
  /** The waiting pass's stops, also while the timeline is on another request. */
  const passStopsNow = (): Stop[] => passIsFocus ? focusStopsNow() : reviewStops({
    rows: passEditRows,
    place: row => rowPlace(row, { waits: passWaitsOrAsks, sent: e => !!passRevising(e), kept: e => passReviewed(e) }),
    num: passEditNum, calls: callStops(),
    gone: (passThread ? rejectedPassEdits : noEdits).map(e => ({ at: e.range.start, num: passEditNum(e) })),
  });
  // A pass's lists go by time, the order their rows are drawn in, so ↑ ↓ and Keep step down the list; any other
  // request's keep the order its edits are listed in.
  const focusOrder: ListOrder = threadTimeline.moments ? { numbers: false } : undefined;
  const passOrder: ListOrder = { numbers: false };
  const focusStops = reviewingEdit && focusTabbed ? focusStopsNow() : [];
  const hereStop = reviewingEdit ? focusStops.find(stop => stop.row?.includes(reviewingEdit)) : undefined;
  const here = reviewingEdit ? { at: reviewingEdit.at ?? reviewingEdit.range.start, num: passIsFocus ? passEditNum(reviewingEdit) : undefined } : undefined;
  /** What ↑, ↓ or Keep opens for a stop: its call, or the edit its row is opened by. */
  const stopTarget = (stop: Stop | undefined, lead: (row: readonly ThreadEdit[]) => ThreadEdit): { call: Call } | { edit: ThreadEdit } | undefined =>
    !stop ? undefined : stop.call ? { call: stop.call } : stop.row ? { edit: lead(stop.row) } : undefined;
  function editBeside(delta: number): { edit: ThreadEdit } | { call: Call } | undefined {
    if (!reviewingEdit) return undefined;
    // Under the tabs, ↑ and ↓ step through the rows of the tab shown, in its order: For you's waiting rows, then the
    // optional ones while that line is open; Working's; Done's. From an edit that isn't a row there (one just rejected,
    // or one of another tab) they step to the row after or before where it is.
    if (focusTabbed) return stopTarget(rowBeside(stopsShown(focusStops, activeFocusList, focusOrder), hereStop, here!, delta, focusOrder),
      row => row.find(waitsOrAsks) ?? row[0]!);
    // With one list of every edit they step through them all. A rejected edit is no row of the list, just rejected or
    // open again from its row: from it they step to the edit after or before where it was.
    if (shownRow < 0) {
      const was = reviewingEdit.at ?? reviewingEdit.range.start, timeOf = (other: ThreadEdit[]) => other[0]!.at ?? other[0]!.range.start;
      // An edit at the very place it was, as the rest of its moment can be, is the one after it.
      const row = delta > 0 ? editsByRow.find(other => timeOf(other) >= was) : editsByRow.findLast(other => timeOf(other) < was);
      return row && { edit: row[0]! };
    }
    const row = editsByRow[shownRow + delta];
    return row && { edit: row.find(waitsOrAsks) ?? row[0]! };
  }
  // ↑ and ↓ reach the log as a bare key: this says which call they went to.
  function stepToCall(change: Change, call: Call) {
    appLog("action", "step", { to: "call", call: callNo.get(call.index), of: allCalls.length, change: change.id, cut: call.index });
    actions.listen(change, call);
  }
  function openSteppedDockEntry(next: DockEntry | undefined) {
    if (!next) return;
    if (next.row.callIndex !== undefined && pass) {
      const call = allCalls.find(a => a.index === next.row.callIndex);
      if (call) { stepToCall(pass, call); return; }
    }
    if (next.row.edit) {
      const order = next.row.editOrder;
      appLog("action", "step", { to: "edit", edit: order?.index ?? 1, of: order?.of ?? 1, change: next.row.edit.changeId });
    }
    (next.row.stepOpen ?? next.row.open)?.();
  }
  function stepEdit(delta: number) {
    const explicitAll = dock.explicitAllReport(threadIds);
    if (dockHasTabs && !explicitAll && reviewingEdit) {
      // Stepping inside an unfolded moment's individual edits stays within that moment first.
      if (openMoment) {
        const at = openMoment.members.indexOf(reviewingEdit);
        const member = at >= 0 ? openMoment.members[at + delta] : undefined;
        if (member) {
          appLog("action", "step", { to: "edit", edit: threadEdits.indexOf(member) + 1, of: threadEdits.length, change: member.changeId });
          actions.playEdit(member, true);
          return;
        }
      }
      const nav = dock.tabNavigable(threadIds, dockList);
      const current = nav.find(e => e.row.on || e.members?.some(m => m.on));
      const hereAt = reviewingEdit.at ?? reviewingEdit.range.start;
      const tier = reviewingEdit.check || reviewingEdit.wasCheck ? "you" : "optional";
      const next = stepInDock(nav, current, { at: hereAt, threadId: focusThread?.id, tier }, delta);
      openSteppedDockEntry(next);
      return;
    }
    const next = editBeside(delta);
    if (!next) return;
    if ("call" in next && pass) return stepToCall(pass, next.call);
    if ("edit" in next) {
      // ↑ and ↓ reach the log as a bare key: this says which edit they went to.
      appLog("action", "step", { to: "edit", edit: threadEdits.indexOf(next.edit) + 1, of: threadEdits.length, change: next.edit.changeId });
      actions.playEdit(next.edit, openOnItsOwn(next.edit));
    }
  }
  function callBeside(delta: number): { call: Call } | { edit: ThreadEdit } | undefined {
    if (!pass || !passThread) return undefined;
    // The rows of the tab the pass's block shows, a call or an edit. From nothing, ↓ starts on its first row and ↑ on its last.
    const stops = passStopsNow();
    const list = stopsShown(stops, passList, passOrder);
    const next = openCall
      ? rowBeside(list, stops.find(stop => stop.call?.index === openCall.index), { at: listedAt.get(openCall.index) ?? openCall.start, num: callNo.get(openCall.index) }, delta, passOrder)
      : delta > 0 ? list[0] : list.at(-1);
    return stopTarget(next, row => row.find(passWaitsOrAsks) ?? row[0]!);
  }
  // Keep goes to the next row in For you's list: with low risk edits included, the very next row down that one list
  // (flagged edit, call or low risk edit alike), wrapping to what still waits at the end, and closing once none is
  // left; with low risk edits off, the next row that waits, wrapping to earlier ones. A request with one list of
  // every edit goes down that list to the next row that hasn't been kept.
  const unkeptEdit = (e: ThreadEdit) => !e.check && !reviewed(e) && !revisingEdit(e);
  const stillWaits = (waits: (e: ThreadEdit) => boolean) => (stop: Stop) => stop.call ? callWaitsOrAsks(stop.call) : !!stop.row?.some(waits);
  const reviewable = (waits: (e: ThreadEdit) => boolean) => (stop: Stop) => stop.place === "optional" ? !!stop.row : stillWaits(waits)(stop);
  const waitingStops = rowsOfTab(focusStops, "you", false, focusOrder).filter(stillWaits(waitsOrAsks));
  const keepStops = activeFocusList === "all" ? rowsOfTab(focusStops, "you", true, focusOrder).filter(reviewable(waitsOrAsks)) : waitingStops;
  const afterKeep = !reviewingEdit || !focusTabbed ? undefined
    : activeFocusList === "all"
      ? rowNext(keepStops, hereStop, here!, focusOrder) ?? waitingStops.find(stop => stop !== hereStop)
      : rowAfter(waitingStops, hereStop, here!, focusOrder);
  const afterListKeep = reviewingEdit && !focusTabbed ? keepGoesTo<Call>(editsByRow, shownRow, e => unkeptEdit(e) || waitsOrAsks(e), []) : undefined;
  // Keep reaches a moment as ↑ ↓ do: whole, at the edit it is named for, however much of it is kept already. The
  // first of its edits still to keep would open alone and unfold the moment.
  const momentLead = (edit: ThreadEdit) => threadTimeline.moments ? editsByRow.find(row => row.includes(edit))?.[0] ?? edit : edit;
  const nextAfterKeep = stopTarget(afterKeep, row => row.find(waitsOrAsks) ?? momentLead(row.find(unkeptEdit) ?? row[0]!)) ?? afterListKeep;
  const nextEditAfterKeep = nextAfterKeep && "edit" in nextAfterKeep ? afterKeep ? nextAfterKeep.edit : momentLead(nextAfterKeep.edit) : undefined;
  const nextCallAfterKeep = nextAfterKeep && "call" in nextAfterKeep ? nextAfterKeep.call : undefined;
  // Keep or Reject edit on a call goes on the same way: to the next row in For you's list (including low risk edits when shown).
  const openStops = listening && pass ? passStopsNow() : [];
  const callHereStop = listening ? openStops.find(stop => stop.call?.index === listening.index) : undefined;
  const callHere = listening ? { at: listedAt.get(listening.index) ?? listening.cut.start, num: callNo.get(listening.index) } : undefined;
  const passWaitingStops = rowsOfTab(openStops, "you", false, passOrder).filter(stillWaits(passWaitsOrAsks));
  const passKeepStops = passList === "all" ? rowsOfTab(openStops, "you", true, passOrder).filter(reviewable(passWaitsOrAsks)) : passWaitingStops;
  const afterCallDecision = !listening || !pass ? undefined
    : passList === "all"
      ? rowNext(passKeepStops, callHereStop, callHere!, passOrder) ?? passWaitingStops.find(stop => stop !== callHereStop)
      : rowAfter(passWaitingStops, callHereStop, callHere!, passOrder);
  const nextAfterCallDecision = stopTarget(afterCallDecision, row => row.find(passWaitsOrAsks) ?? row[0]!);
  const onCall = !!openCall && !openCallBack && !reviewingEdit;
  const upcomingCall = onCall ? (nextAfterCallDecision && "call" in nextAfterCallDecision ? nextAfterCallDecision.call : undefined) : nextCallAfterKeep;
  const upcomingEdit = onCall ? (nextAfterCallDecision && "edit" in nextAfterCallDecision ? nextAfterCallDecision.edit : undefined) : nextEditAfterKeep;
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
  const forYouOrder = passForYouItems.map(item => `${item.kind}:${item.kind === "call" ? item.call.index : editKey(item.edit)}:${item.waiting ? 1 : 0}`).join(",");
  // Where ↑ goes from the open edit or call, so going back isn't cold either.
  const prevFromEdit = reviewingEdit ? editBeside(-1) : undefined;
  const prevFromCall = onCall ? callBeside(-1) : undefined;
  const previousEdit = reviewingEdit ? (prevFromEdit && "edit" in prevFromEdit ? prevFromEdit.edit : undefined)
    : prevFromCall && "edit" in prevFromCall ? prevFromCall.edit : undefined;
  const previousCall = onCall ? (prevFromCall && "call" in prevFromCall ? prevFromCall.call : undefined)
    : prevFromEdit && "call" in prevFromEdit ? prevFromEdit.call : undefined;
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
      const base = edit === reviewingEdit ? cutBase : viewBaseOf(edit, thread, edits);
      const target = editToPrepare(edit, cutChange(edit, thread.changes), edits, afterOf, base);
      if (!target) return;
      if (edit === reviewingEdit) {
        if (!beforeTimeline || !appliedCut || (appliedSide === "after" && afterSource && !afterTimeline)) return;
        // The card has already placed it, on its earlier version or its own.
        target.before = beforeTimeline;
        target.cut = appliedCut;
        delete target.base;
        if (rebasedCut) target.nearby = [];
        if (target.after && afterTimeline) target.after = { ...target.after, version: afterTimeline, ...rebasedCut && { removed: undefined } };
      }
      add(editPlaybackKey(edit, target.after && (typeof target.after.version === "string" ? target.after.version : target.after.version.version), base), target);
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
    if (previousEdit && !(onCall ? passRevising : revisingEdit)(previousEdit)) addEdit(previousEdit, onCall ? passThread : focusThread, onCall ? passEditList : threadEdits);
    for (const item of passForYouItems) {
      if (!item.waiting) continue;
      if (item.kind === "call") addCall(item.call);
      else addEdit(item.edit, passThread, passEditList);
    }
    if (passThread?.id !== focusThread?.id) flaggedEdits.forEach(edit => addEdit(edit, focusThread, threadEdits));
    // Among settled cuts warm the first visible row, then the one reached by Keep or the arrow keys.
    const visible = !openCall && (listShown || onLatest) && (reviewingEdit ? nextEditAfterKeep : threadEdits.find(e => !!e.beforeCut && !revisingEdit(e)));
    if (visible) addEdit(visible, focusThread, threadEdits);
    return [...queue.values()];
  }, [activeReview, timeline, head, pass, review, liveReview, returningCall, placed, forYouOrder, openCall?.index, openCallBack, conflict, onCall, reviewingEdit, upcomingCall, upcomingEdit,
    flaggedEdits, threadEdits, passEditList, passEdits, passThread, focusThread, toWorkingCut, placing, priorityRow, listShown, onLatest, nextEditAfterKeep, previousEdit, previousCall,
    beforeTimeline, afterTimeline, appliedSide, madeBy, callTimeline, needsSingleCut, single.preview, listening?.side, versionAfter, savedAfter.timeline, !!preparedCall]); // eslint-disable-line react-hooks/exhaustive-deps
  const openVersion = versionBefore ?? head;
  const openCut = !activeReview ? undefined : beforeCut ?? (openCall && openVersion && heard ? { version: openVersion, removed: heard } : undefined);
  const openPlaybackKey = reviewingEdit ? editPlaybackKey(reviewingEdit, appliedAfterVersion, cutBase)
    : listening && beforeVersion ? callPlaybackKey(listening.index, beforeVersion) : undefined;
  const nextCutPlayback = usePrepareReviewCuts(shownProject, current.renderSettingsRevision, reviewQueue, draftCache, preparedCandidates,
    openCut && { ...openCut, key: openPlaybackKey });

  // ⌘Z takes a Keep back, and opens this edit again. It goes by the name its tag in the box has.
  const undoneEdit = (edit: ThreadEdit) => {
    const target = threadTimeline.selectedTarget;
    const named = target && (cutName(target) ?? targetName(target));
    return { edit: { changeId: edit.changeId, spot: edit.spot, ...(threadTimeline.single && { single: true }) },
      ...(named && { name: threadTimeline.selectedMoment ? `${threadTimeline.selectedMoment.edits.length} edits` : tagOf(named) }) };
  };
  function keepShown() {
    if (!reviewingEdit || !focusThread) return;
    // K reaches the log as a bare key, and the button as "Keep": this says which edit was kept.
    appLog("action", "keep-edit", { edit: shownIndex + 1, of: threadEdits.length, change: reviewingEdit.changeId, flagged: !!reviewingEdit.check || undefined });
    // An edit made in several places is kept in all of them: it is one edit, on one row.
    const row = editsByRow[shownRow] ?? [reviewingEdit];
    // ⌘Z takes back what this Keep kept, and no more: an edit of the row kept on its own earlier stays kept.
    const fresh = notYetKept(current.id, focusThread.id, row);
    if (keepEdits(current.id, focusThread.id, row, head ?? undefined)) {
      recordEditReview(current.id, threadTimeline.selectedTarget, "keep");
      recordUndo({ kind: "keep", word: reviewingEdit.marker ? "Done" : "Keep", projectId: current.id, threadId: focusThread.id, refs: fresh, ...undoneEdit(reviewingEdit) });
    }
    moveOnFromShown();
  }
  /** Next row in the unified fixed bottom dock's For you Priority list. */
  function nextDockAfterKeep(hereAt: number): DockEntry | undefined {
    const waitingList = dock.waitingEntries(threadIds);
    const includeConfident = dockList !== "need" || waitingList.length === 0;
    const keepList = dock.keepEntries(threadIds, includeConfident);
    const current = keepList.find(e => e.row.on || e.members?.some(m => m.on));
    const confident = keepList.filter(e => e.place === "optional");
    // While on a waiting item, finish remaining waiting items first (wrapping to earlier ones),
    // then move into confident edits when All is active.
    if (!current || current.place === "you") {
      return rowAfter(waitingList, current, { at: hereAt }, { numbers: false })
        ?? (includeConfident ? confident[0] : undefined);
    }
    // While on a confident edit, advance strictly down Confident edits, wrapping back to anything still waiting at the end.
    return rowNext(confident, current, { at: hereAt }, { numbers: false })
      ?? waitingList.find(e => e !== current);
  }
  /** Keep all confident edits across requests at once, with one-press ⌘Z undo. */
  function keepConfident() {
    const parts = dock.confidentEdits(threadIds).flatMap(({ threadId, refs }) => {
      const fresh = notYetKept(current.id, threadId, refs);
      return fresh.length ? [{ threadId, refs: fresh }] : [];
    });
    if (!parts.length) return;
    const wasOnConfident = !!reviewingEdit && !reviewingEdit.check && !reviewingEdit.wasCheck;
    for (const part of parts) if (keepEdits(current.id, part.threadId, part.refs, head ?? undefined)) recordEditReviews(current.id, part.refs, "keep");
    recordUndo({ kind: "keepAll", word: "Keep all", projectId: current.id, parts });
    appLog("action", "keep-low-risk", { count: parts.reduce((n, part) => n + part.refs.length, 0), requests: parts.length });
    if (wasOnConfident) {
      const firstWaiting = dock.waitingEntries(threadIds)[0];
      if (firstWaiting?.row.open) firstWaiting.row.open();
      else closeEdit();
    }
  }
  // Keep, Add and Reject edit go on to the same place: the next edit or call that still waits, else the card closes.
  function moveOnFromShown() {
    if (dockHasTabs && !dock.explicitAllReport(threadIds) && reviewingEdit) {
      const next = nextDockAfterKeep(reviewingEdit.at ?? reviewingEdit.range.start);
      if (next?.row.open) { next.row.open(); return; }
      closeEdit();
      return;
    }
    if (nextEditAfterKeep) actions.playEdit(nextEditAfterKeep, openOnItsOwn(nextEditAfterKeep));
    else if (nextCallAfterKeep) actions.listen(pass!, nextCallAfterKeep);
    else closeEdit();
  }
  // A revision sent from a row of For you goes on as Keep does (the editor chose this on 2026-11-23): the row is
  // Working's now, and the card moves to the next one that waits. From Working or Done, and in a request with one
  // list of every edit, the card stays on the edit it revised.
  function moveOnFromRevised() {
    if (dockHasTabs && !dock.explicitAllReport(threadIds)) {
      if (tabShown(dockList) !== "you") return;
      if (reviewingEdit) { moveOnFromShown(); return; }
      if (!openCall || !pass) return;
      const next = nextDockAfterKeep(listedAt.get(openCall.index) ?? openCall.start);
      player.pause();
      if (next?.row.open) next.row.open();
      else setListening(undefined);
      return;
    }
    if (reviewingEdit) { if (focusTabbed && tabShown(activeFocusList) === "you") moveOnFromShown(); return; }
    if (!openCall || !pass || !passThread || tabShown(passList) !== "you") return;
    const next = nextAfterCallDecision;
    player.pause();
    if (next && "call" in next) listenCall(pass, next.call);
    else if (next && "edit" in next) actions.openEdit(passThread, next.edit);
    else setListening(undefined);
  }
  // ⌘Z takes back the editor's last Keep or revision, and the one before it on the next press. A Keep
  // taken back opens its edit again, where it waits on the editor.
  const threadsNow = useRef(threads);
  threadsNow.current = threads;
  const latestActions = useRef(actions);
  latestActions.current = actions;
  // A call's Keep or Reject edit is taken back on the pass as it waits now: the call waits on the editor again, or is
  // decided as it was before, and opens on its card. A pass that has gone in holds every cut of it, so ⌘Z says why instead.
  const takeBackCall = (step: CallStep) => {
    // With no pass waiting, none of its calls can be taken back: it says so once, and the next ⌘Z goes on past them.
    if (!pass) forgetCalls(current.id);
    if (!pass || deciding === pass.id) throw new Error("its pass has been applied since.");
    const index = callNow(pass, { changeId: step.changeId, cutIndex: step.index }, passThread?.changes ?? [], changes, tasks, footage);
    const call = allCalls.find(a => a.index === index);
    if (!call) throw new Error("that cut isn’t in the pass any more.");
    const { [call.index]: _decided, ...rest } = choicesOf(pass);
    // With a call waiting again, the pass is no longer set to go in when Scarlet finishes: its last call sets that.
    void saveChoices(pass, step.was ? { ...rest, [call.index]: step.was } : rest, step.was ? undefined : false);
    listenCall(pass, call);
  };
  const undoKeys = useRef({ undo: async () => {} });
  undoKeys.current.undo = async () => {
    const project = useProjectStore.getState().current;
    if (!project || project.id !== current.id) return;
    const step = await undoLast(current.id, project, version => useProjectStore.getState().historyEdit(version, "revert"), takeBackCall);
    // A call taken back is open on its card already.
    if (step?.kind === "call") return;
    if (step?.kind === "callAdjust") {
      const prior = useProjectStore.getState().current?.changes.find(c => c.id === step.replacedId);
      const cut = prior && stagedCuts(prior)[step.index];
      if (prior && cut) {
        player.pause();
        setListening(prev => ({ changeId: prior.id, index: step.index, cut, side: "after", take: (prev?.take ?? 0) + 1, key: `${prior.id}/${step.index}` }));
      }
      return;
    }
    // A Keep, Add or Reject edit moved the card on: taken back, the card goes back to the edit it was about.
    const opened = step?.kind === "keep" ? step : step?.kind === "revision" && step.edit && step.threadId ? { threadId: step.threadId, edit: step.edit } : undefined;
    const thread = opened && threadsNow.current.find(t => t.id === opened.threadId);
    if (opened && thread) latestActions.current.openEdit(thread, opened.edit, undefined, opened.edit.single);
  };
  useUndoShortcut(workspaceActive, current.id, undoKeys);
  const undoFoot = <UndoError projectId={current.id} />;
  // With a pass's list of every edit open, watching the video is the review: a moment the video plays through, from
  // before it starts to past its end without a jump, is kept, all its edits at once. Only the moments that need no
  // decision of the editor's are: one that asks for a look, or a spot marked for them, waits for their own Keep. While
  // a cut, an edit or a call is open the player is on its own passage, and nothing is kept this way.
  const watchedMoments = useMemo(() => {
    const lowIncluded = dockHasTabs && !explicitAllDock ? dockList !== "need" : !!focusThread && lists[focusThread.id] === "all";
    if (!focusThread || !lowIncluded || !threadTimeline.moments || !passFocused) return [];
    return threadTimeline.moments
      .filter(m => m.edits.every(e => !e.check && !e.marker) && m.edits.some(e => !reviewed(e) && !revisingEdit(e)));
  }, [focusThread, lists, dockHasTabs, explicitAllDock, dockList, threadTimeline.moments, passFocused, reviewed, revisingEdit]);
  const watching = watchedMoments.length > 0 && !reviewingEdit && !listening && !suggestion && !source;
  useWatchedMomentAutoKeep(watching, watchedMoments, current.id, focusThread?.id, head);
  useEditCardShortcuts(workspaceActive && !!reviewingEdit, stepEdit, closeEdit);

  // ↑ and ↓ step through the pass's For you items (calls and flagged edits), one at a time.
  const stopListening = () => { player.pause(); setListening(undefined); };
  function stepCut(delta: number) {
    if (dockHasTabs && !dock.explicitAllReport(threadIds)) {
      const nav = dock.tabNavigable(threadIds, dockList);
      if (!nav.length) return;
      const current = nav.find(e => e.row.on || e.members?.some(m => m.on));
      const next = openCall
        ? stepInDock(nav, current, { at: listedAt.get(openCall.index) ?? openCall.start, threadId: passThread?.id, tier: "you" }, delta)
        : delta > 0 ? nav[0] : nav.at(-1);
      openSteppedDockEntry(next);
      return;
    }
    const next = callBeside(delta);
    if (!next || !pass || !passThread) return;
    if ("call" in next) return stepToCall(pass, next.call);
    appLog("action", "step", { to: "edit", edit: passEditList.indexOf(next.edit) + 1, of: passEditList.length, change: next.edit.changeId });
    actions.openEdit(passThread, next.edit);
  }
  // The suggestion on the card is the one being applied: it stays up until that lands.
  const applyingShown = !!suggestion && deciding === suggestion.id;
  // Capture phase, so ↑ and ↓ step between cuts while a pass waits for a call. ← and → pass through to the player.
  const reviewKeysOn = workspaceActive && !!(passThread || suggestionThread) && !reviewingEdit;
  useCallCardShortcuts(reviewKeysOn, !!pass, { stepCut, stopListening, closeReview, listening: !!listening, suggestion: !!suggestion, applying: applyingShown,
    calls: dockHasTabs && !explicitAllDock ? dock.tabNavigable(threadIds, dockList).length > 0 : passForYouItems.length > 0 });

  // Esc closes the Transcript beside the player. A cut, an edit or a suggestion that's open takes Esc first.
  const escClosesTranscript = workspaceActive && transcript && !reviewingEdit && !(reviewKeysOn && (!!listening || !!suggestion));
  useEscapeCloses(escClosesTranscript, () => setTranscript(false));
  // With nothing else for Esc to close, it lets go of the picked request, as a second press on its band does.
  const escLetsGo = workspaceActive && !!focusThread && !transcript && !reviewingEdit && !listening && !suggestion && !showing;
  useEscapeCloses(escLetsGo, () => { if (focusThread) letGo(focusThread.id); });

  // Keep the newest message in view as replies arrive, unless the editor scrolled up to read.
  const chat = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastActivity = ordered.at(-1)?.updatedAt;
  useChatAutoFollow(chat, follow, ordered.length, lastActivity, current.tasks.length);

  // The open edit's card sits right on top of the timeline, above the passage it cut, so watching the join and deciding
  // happen in one place. It is one row: how many still wait, Scarlet's note as a small caption, then the controls. Its
  // words open under that row, behind Show transcript. Keys show on hover, not in boxes.
  const removedLength = beforeCut ? beforeCut.removed.end - beforeCut.removed.start : 0;
  // Before was reached by a click on the timeline, in this cut's passage or another's.
  const cutSwitched = shownSide?.side === "before" && shownSide.at !== undefined;
  // A marker left for the editor changed nothing in the video: its card says what it is, and has nothing to compare or keep.
  const shownMarker = !!reviewingEdit?.marker;
  const shownKind = reviewingEdit && (shownMarker ? "To do" : reviewingEdit.onlyCheck ? (reviewRange ? undefined : "Check") : editKindWord(reviewingEdit));
  // The card's first line says exactly what the edit did: a cut's words, struck, or for any other edit what its steps
  // set (a caption's words, the file laid over the picture, how far a zoom goes). A moment holds several edits, and a
  // spot marked for the editor changed nothing, so neither has one.
  const editDid = !reviewingEdit || threadTimeline.selectedMoment || shownMarker ? undefined
    : beforeCut ? cutBefore.timeline && <CutWordsLine key={`what ${editKey(reviewingEdit)}`} timeline={cutBefore.timeline} media={media}
      range={beforeCut.removed} length={lengthLabel(removedLength)} verb="Took out" />
    : (detail => detail && <p className="edit-card-what">{detail}</p>)(editDetail(shownChange, reviewingEdit, { timeline, before: shownChangeBefore, media, fps })
      ?? (shownChange?.author.type === "human" && threadTimeline.originalChange !== shownChange ? editDetail(threadTimeline.originalChange, reviewingEdit, { timeline, before: shownChangeBefore, media, fps }) : undefined));
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
      ...(e.marker && { marker: true }),
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
  const besideVersions = leavingNow ? [editBeside(1), editBeside(-1)].flatMap(t => t && "edit" in t && t.edit.beforeCut ? [t.edit.beforeCut.version] : []).join(" ") : "";
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
  const rejectedCard = reviewingEdit && (reviewingEdit.rejected || leavingNow) && focusThread
    ? <RejectedEditCard edit={reviewingEdit} /> : undefined;
  const editCard = reviewingEdit && !reviewingEdit.rejected && !leavingNow && shownChange && focusThread && !editSentBack
    ? <AppliedEditCard projectId={current.id} focusThread={focusThread} reviewingEdit={reviewingEdit}
        editPlace={editPlace} flaggedCount={passIsFocus ? waitingPassForYouEdits.length : flaggedRows.length} editDid={editDid} selectedMoment={threadTimeline.selectedMoment}
        shownKind={shownKind} shownMarker={shownMarker} reviewRange={reviewRange} onPlayCheck={playCheck} visiting={visiting}
        beforeCut={beforeCut} cutBeforeTimeline={cutBefore.timeline} cutBeforeError={cutBefore.error} onRetryCutBefore={cutBefore.retry}
        media={media} removedLength={removedLength} otherCuts={otherCuts} scriptKey={scriptKey} scriptOpen={scriptOpen}
        onToggleScript={() => setScriptFor(scriptOpen ? undefined : scriptKey)} shownSource={shownSource} sourceKey={sourceKey}
        sourceOpen={sourceOpen} onToggleSource={() => setScriptFor(sourceOpen ? undefined : sourceKey)} cutSwitched={cutSwitched} cutTake={shownSide?.take}
        appliedSide={appliedSide} workspaceActive={workspaceActive} cutKey={cutKey} onChooseCutSide={chooseCutSide}
        setCompareHost={setCompareHost} onRevise={() => actions.revise(focusThread, shownChange)}
        onKeep={keepShown} madeBy={shownChange.handedOff}
        // Add asks Scarlet to make or find what the to-do says to add. Its row says Adding… meanwhile, ⌘Z takes the request
        // back as it does a revision, and the card goes on as Keep does, so a run of to-dos is one press each.
        onSentAdd={shownMarker && !reviewed(reviewingEdit) ? task => {
          follow.current = true;
          appLog("action", "add-todo", { edit: shownIndex + 1, of: threadEdits.length, change: reviewingEdit.changeId });
          const named = rejectTarget && (cutName(rejectTarget) ?? targetName(rejectTarget));
          recordUndo({ kind: "revision", word: "Add", projectId: current.id, taskId: task.id, threadId: focusThread.id,
            edit: { changeId: reviewingEdit.changeId, spot: reviewingEdit.spot, ...(threadTimeline.single && { single: true }) },
            ...(named && { name: tagOf(named) }) });
          if (openEditNow.current === openEditKey) moveOnFromShown();
        } : undefined}
        appliedTarget={appliedTarget} rejectTarget={rejectTarget} openEditKey={openEditKey} rejectedEdits={rejectedEdits}
        // From the press, the card holds on the edit as it is: the video without it can land before the engine answers.
        onEngineReject={asked => asked ? threadTimeline.leave() : threadTimeline.stay()}
        onSentReject={sent => {
          follow.current = true;
          appLog("action", "reject-edit", { edit: shownIndex + 1, of: threadEdits.length, change: reviewingEdit.changeId });
          // ⌘Z takes the rejection back as it does a revision, and the card goes back to this edit.
          const named = cutName(rejectTarget!) ?? targetName(rejectTarget!);
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
          if (threadTimeline.selectedMoment && !ui.agentDraft.trim() && ui.agentContext && ui.agentContext !== "whole") ui.setAgentContext(rejectTarget!);
          setLeavingEdit({ key: openEditKey!, version: sent.version, dot: shownMarks.find(dot => dot.edit === openEditKey) });
        }} /> : undefined;

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
  // Where the call's cut is in the video: the time its row in the list leads with, so its card names it the same way.
  const callAt = openCall ? listedAt.get(openCall.index) ?? (heard ?? placeCut(openCall))?.start : undefined;
  const callCard = !editOpen && pass && openCall && listening
    ? <CallCard projectId={current.id} pass={pass} openCall={openCall} listening={listening}
        callAt={callAt !== undefined ? distinctClock(callAt, [...listedAt.values()]) : undefined} callHistory={callHistory} callWords={callWords} callLength={callLength!} callKey={callKey}
        callScriptOpen={callScriptOpen} media={media} conflict={!!conflict} heard={heard} visit={visit} decideError={decideError}
        placing={placing} stagedOnError={stagedOn.error} onRetryStagedOn={stagedOn.retry} workspaceActive={workspaceActive}
        onToggleSide={() => listenSide(listening.side === "after" ? "before" : "after")}
        onToggleScript={() => setScriptFor(callScriptOpen ? undefined : callKey)} openCallBack={openCallBack}
        callRun={cutRuns.get(openCall.index)} onAnswerCut={answeringCut && passThread ? () => actions.reply(passThread) : undefined}
        choice={passChoices[openCall.index]} deciding={!!deciding} onDecide={choice => void decideCut(choice)} onRevise={reviseReview} /> : undefined;

  // A suggestion that isn't a dialogue pass opens the same card on top of the timeline, as the same single row:
  // Scarlet's words for it, the Before icon, then Revise (R) and Apply (A). Esc closes it.
  const suggestionNote = suggestion && (suggestion.reason
    || [...new Set(suggestion.timelineEdits?.flatMap(edit => edit.reason ? [edit.reason] : []))].join(" ")
    || suggestion.description);
  const suggestCard = !editOpen && !callCard && suggestion && suggestionThread
    ? <SuggestionCard suggestionId={suggestion.id} note={suggestionNote!} stripError={stripError} side={side}
        workspaceActive={workspaceActive} onToggleSide={() => setSide(side === "after" ? "before" : "after")}
        onRevise={reviseReview} applyingShown={applyingShown} deciding={!!deciding} onApply={() => void approveReview(suggestion)} /> : undefined;

  // The chat is one conversation and stays where it is. A cut or an edit that's open has its words and its controls on
  // its card; the message box is aimed at it.
  const itemThread = callCard ? passThread : editOpen ? focusThread : undefined;
  const selected = answeringCut && callCard ? `ask:${rechecking!.id}` : callCard ? `call:${listening!.key}/${versionBefore ?? ""}` : editOpen ? `edit:${editKey(reviewingEdit!)}` : askThread ? `ask:${askThread.id}` : "new";

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
    return { label: "this whole edit", target: wholeEdit(change) };
  };
  /**
   * Aim the box at what's open. "moved": something else opened or closed. "sent": a message landed and the box is free.
   * "take": the editor asked for the message being written to come along. "new": the editor took the tag off the box,
   * so the message starts a new edit, whatever is open.
   */
  const settleAim = useRef<(why: "moved" | "sent" | "take" | "new") => void>(noop);
  // What opened, closed or was sent while a spoken message held the box. Once it is out, the box follows that.
  const heldForVoice = useRef<{ why: "moved" | "sent"; aim: number }>(undefined);
  // Whether a queued request's words are in the box to change. They hold it too.
  const heldForWords = useRef(false);
  settleAim.current = why => {
    const ui = useUiStore.getState();
    const carry = why === "take" || why === "new";
    // A message being spoken can't be brought along: its recording is in this box, and aiming the box elsewhere builds
    // it again, which would drop it. The tag's × waits until it is out.
    if (carry && ui.speaking) return;
    // Only spaces or line breaks are no message to keep aimed: opening an edit takes the aim off such a box, as off an
    // empty one, so it follows what's open the same way.
    if (!carry && ui.agentDraft.trim()) return;
    // A queued request's words being changed keep the box as well: aiming it elsewhere builds it again, which pulls the
    // caret back into it, and the next Esc would throw the new words away. The box follows what opened once they are done.
    if (!carry && heldForWords.current) return;
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
   * Words chosen in the transcript ("Ask about this"), with a call or an edit open. Words in the open cut or edit's
   * passage (including the words flanking a cut in its audition, outside other cuts) are about it: the message revises
   * that one cut or edit, and says where the editor was looking. Words anywhere else start a new edit about them, as
   * they do with nothing open. Either way the message being written comes along. Left on the open request, the words
   * would name no cut or edit, and the message would go to the whole request.
   */
  const askAbout = (words: AgentContext) => {
    const overlaps = (r: TimeRange) => words.end !== undefined && words.time < r.end && words.end > r.start;
    if (callCard && pass && listening) {
      const cut = callView?.cut ?? heard;
      const listen = playedAudition ?? audition;
      const otherCallCuts = [
        ...(callView ? callView.shown.map(r => r.removed) : []),
        ...allCalls.flatMap(c => {
          if (c.index === listening.index) return [];
          const placed = placeCut(c);
          if (!placed) return [];
          if (!callView) return [placed];
          const start = callView.toBase(placed.start), end = callView.toBase(placed.end);
          return start !== null && end !== null && end > start ? [{ start, end }] : [];
        }),
      ];
      const inCall = !!cut && !words.mediaId && words.version === (callView?.version ?? pinnedCallVersion ?? head)
        && (overlaps(cut) || (!!listen && overlaps(listen) && !otherCallCuts.some(overlaps)));
      settleAim.current(inCall ? "take" : "new");
      // Only a box that leaves a request gets taken off words by that move; one already on a new edit keeps no note.
      if (!inCall && replyTo) askedWords.current = words;
      const aim = inCall ? { ...cutTarget(pass, listening.index, listening.cut).target,
        version: words.version, time: words.time, end: words.end, clipIds: words.clipIds, label: words.label } : words;
      if (inCall) wordsInCall.current = aim;
      useUiStore.getState().setAgentContext(aim);
      return;
    }
    if (editOpen && reviewingEdit && shownChange && focusThread) {
      const version = appliedCut ? beforeCut!.version : draftVersion ?? head;
      const inEdit = !words.mediaId && words.version === version && (appliedCut
        ? overlaps(appliedCut) || (!!appliedListen && overlaps(appliedListen) && !otherCuts.some(overlaps))
        : overlaps(reviewingEdit.range));
      settleAim.current(inEdit ? "take" : "new");
      if (!inEdit && replyTo) askedWords.current = words;
      const aim = inEdit ? { ...editAim(reviewingEdit, shownChange).target,
        version: words.version, time: words.time, end: words.end, clipIds: words.clipIds, label: words.label } : words;
      useUiStore.getState().setAgentContext(aim);
    }
  };
  // A request about an edit is named as that edit's row is: "the cut at 2:05". The row is in hand while its request
  // has the timeline, so the name is kept from then. With the timeline on another request, or on none, the name must
  // not turn into "the edit at" where the request's passage starts: the box, the queue and the chat say the same words.
  const targetNames = useRef(new Map<string, string>());
  const targetTimes = useRef(new Map<string, number>());
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
    if (key) {
      const edit = placedEdits.find(e => matchesEdit(e, { changeId: changeId!, spot: editIndex! }));
      if (edit) targetTimes.current.set(key, edit.at ?? edit.range.start);
    }
    return name;
  };
  // Exact time for a time-bearing tag ("Cut at 2:05", "Edit at 0:11"), so the pill above the box shows milliseconds.
  const targetTimeOf = (about: AgentContext & object) => {
    const { changeId, editIndex, cutIndex } = about;
    if (editIndex !== undefined && changeId !== undefined) {
      const key = `${changeId}/${editIndex}`;
      const placedEdits = threadTimeline.rejected.length ? [...threadEdits, ...threadTimeline.rejected] : threadEdits;
      const edit = placedEdits.find(e => matchesEdit(e, { changeId, spot: editIndex }));
      if (edit) return edit.at ?? edit.range.start;
      const kept = targetTimes.current.get(key);
      if (kept !== undefined) return kept;
      const own = threads.find(t => t.changes.some(c => c.id === changeId));
      const ownEdit = own && threadEditList(own).find(e => matchesEdit(e, { changeId, spot: editIndex }));
      return ownEdit ? ownEdit.range.start : about.time;
    }
    if (cutIndex !== undefined) return about.time;
    return undefined;
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
  const sentMovesOn = useRef<() => void>(noop);
  useLayoutEffect(() => {
    const cleared = wasWritten.current && !written;
    wasWritten.current = written;
    if (written) tagTakenOff.current = undefined;
    if (cleared) emptied.current();
  }, [written]);
  // An answer says so too, so a message meant as a new edit isn't sent to Scarlet's question by mistake.
  const boxTag = aimedAt ? (aimed && cutName(aimed)) ?? tagOf(aimedAt) : replyThread ? replyThread.question ? "Answer" : "Reply" : undefined;
  // Scarlet can have several questions waiting, one from each cut or edit it works on. The box answers them one at a
  // time, in the order asked, and its tag says which this one is: "Answer 1 of 2".
  const questions = tasks.filter(t => t.kind !== "transcribe" && t.state === "waiting_for_user" && !!t.question);
  const answerNote = boxTag === "Answer" && questions.length > 1 && replyThread?.question
    ? `${questions.findIndex(t => t.id === replyThread.question!.id) + 1} of ${questions.length}` : undefined;
  const aimOnOpen = callCard ? answeringCut ? !aimed : aimed?.changeId === pass!.id && aimed.cutIndex === listening!.index
    : editOpen && !!aimed && aimed.cutIndex === undefined && (aimed.changeId === reviewingEdit!.changeId || aimed.changeId === shownChange!.id)
      && (aimed.editIndex === undefined || aimed.editIndex === reviewingEdit!.spot);
  const aimMatches = itemThread ? replyThread?.id === itemThread.id && aimOnOpen
    // A suggestion that's open is what the box is on once Revise (R) aims it there.
    : openSuggestion && aimed?.changeId === openSuggestion ? replyThread?.id === suggestionThread!.id
    : askThread ? replyThread?.id === askThread.id && !aimedAtItem : !replyThread;
  // Only an aim made for a cut or an edit follows what's open. One the editor made on a whole request stays theirs.
  emptied.current = () => { if (aimForItem.current && !aimMatches) settleAim.current("moved"); };
  // A message sent while the box is aimed at the cut or edit that's open is a revision of it.
  sentMovesOn.current = aimForItem.current && aimMatches && itemThread ? moveOnFromRevised : noop;
  // A call of the waiting pass is named by where it is on the working cut now, as the label on the video and its dot
  // say it: the working cut can move after the box was aimed. The call's own range is used: an aim made from words
  // chosen in its passage has the words' times, not the cut's.
  const aimedCall = pass && aimed && aimed.changeId === pass.id && aimed.cutIndex !== undefined
    ? allCalls.find(a => a.index === aimed.cutIndex) ?? (aimed.end !== undefined ? { start: aimed.time, end: aimed.end } : undefined) : undefined;
  // A call's tag is its time ("Cut at 2:47"), to the millisecond on a click, where its row is in the list.
  const targetTime = aimed && replyThread && boxTag
    ? (aimedCall && cutName(aimed) === boxTag ? callAtTime(aimed) : undefined) ?? targetTimeOf(aimed) : undefined;
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
  const editingPaused = current.project.editingPaused;
  // A request in line again after its question was answered is still the one Scarlet is on: it holds its place for the
  // moment before Scarlet picks it back up, instead of dropping into the conversation and coming back.
  const front = tasks.find(t => t.kind !== "transcribe" && (t.state === "claimed" || t.state === "running" || t.state === "waiting_for_user"))
    ?? tasks.find(t => t.kind !== "transcribe" && t.state === "queued" && !!t.startedAt && !(editingPaused && isProjectEditTask(t)));
  const rootOf = useMemo(() => requestRoots(tasks), [tasks]);
  // A request in the chat that Scarlet has, whose band holds Pause or Resume and Stop. A new one waiting its turn is
  // in the tray instead.
  const editing = tasks.some(task => isProjectEditTask(task) && runIsActive(task) && !(waitingToStart(task) && rootOf(task) === task.id));
  // Active edit work on the video shown here (not paused, not waiting on an answer, and not previewing a Media clip),
  // said under the timeline in the order Scarlet started it.
  const timelineWork = useMemo(() => editingPaused || chosenSource ? [] : tasks
    .filter(task => isProjectEditTask(task) && isWorking(task.state))
    .sort((a, b) => (a.startedAt ?? a.createdAt ?? "").localeCompare(b.startedAt ?? b.createdAt ?? "")), [editingPaused, chosenSource, tasks]);
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
  }), [queued, tasks, changes, threadEdits, threadTimeline.rejected, threads, pass, allCalls, passEditNo, callNo, footage]); // eslint-disable-line react-hooks/exhaustive-deps
  const queueHint = !editingPaused && queued[0] ? waitHint(queued[0]) : undefined;
  const queueWaitsOn = !editingPaused && queued[0] ? waitsOnEditor(queued[0]) : undefined;
  const nextQueuedId = !editingPaused && queued[0] && !queueWaitsOn ? queued[0].id : undefined;
  // Exporting is the next step once the video has edits and nothing waits: no question, no pass, no flagged edit the
  // editor hasn't decided, and no request Scarlet is on or has waiting its turn. The header's Export is white until
  // this version of the video is exported (the editor approved it on 2026-11-23).
  const flagsWait = threadTimeline.edits.some(waitingEdit)
    || passEdits.some(e => !!e.check && !passReviewed(e) && !passRevising(e))
    || [...backgroundReview.values()].some(review => review.head === head && review.markers.some(marker => marker.state === "check"));
  const exportReady = hasCut && changes.some(c => c.state === "approved") && !asking && !pass && !front && !editing
    && !queued.length && !flagsWait;
  // A request picked up again waits in its own block, not in the tray: the block says what it waits for as the tray
  // would, and starts it before the calls the same way.
  const waitsOn = (task: Task) => {
    const words = editingPaused ? undefined : waitsOnEditor(task);
    return words ? { words, startNow: waitFor(task)?.kind === "review" ? () => void queueAction(startBeforeCalls(task.id)).catch(() => {}) : undefined } : undefined;
  };
  const chatActions: ChatActions = { ...actions, waitsOn, ...(nextQueuedId && { nextQueuedId }) };
  // The queued request whose words are in the message box to change, and the words as they stand there. Scarlet
  // doesn't start it meanwhile. A message being written waits, and is in the box again once these words are done.
  // They are kept as they are typed, as an unsent message is: after a quit the request is in the box again with the
  // words as they stood, and held again, instead of starting a minute later with the words it was first given.
  const [rewording, setRewording] = useState<{ id: string; text: string } | undefined>(() => savedRewording(current.id));
  useEffect(() => saveRewording(current.id, rewording), [current.id, rewording]);
  // Whether the tray is open. Held here: the box it sits on is built again whenever it is aimed somewhere else.
  const trayOpen = useState(false);
  const rewordingItem = rewording && queuedItems.find(item => item.id === rewording.id);
  // While those words are in the box it stays aimed as it was. Once they are done with, it follows what opened meanwhile.
  const rewordingOn = !!rewordingItem;
  heldForWords.current = rewordingOn;
  const wasRewording = useRef(rewordingOn);
  useLayoutEffect(() => {
    const was = wasRewording.current;
    wasRewording.current = rewordingOn;
    if (was && !rewordingOn) settleAim.current("moved");
  }, [rewordingOn]);
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
  useOutsideClearMarkedRange(hasMarkedRange, () => markRange(undefined));
  // With a cut or an edit open, a pause puts its time in the box's tag instead, and the message stays the cut's or the
  // edit's. It goes when the video plays on with nothing written, and when another cut or edit opens.
  const [pausedAt, setPausedAt] = useState<PausedAt>();
  const pausedAtRef = useRef(pausedAt);
  pausedAtRef.current = pausedAt;
  useEffect(() => usePlayerStore.subscribe((now, was) => {
    if (!now.playing || was.playing) return;
    const box = useUiStore.getState();
    if (pausedAtRef.current && !box.agentDraft.trim()) setPausedAt(undefined);
  }), []);
  // Words erased while the video plays leave nothing written either, and the video has moved on: the time goes then too.
  useLayoutEffect(() => { if (!written && usePlayerStore.getState().playing) setPausedAt(undefined); }, [written]);
  useLayoutEffect(() => () => setPausedAt(undefined), [replyTo]);
  // A press, a scrub, a skip on the timeline, a pause, or N aims a new edit at that moment at once in the box's tag,
  // without writing anything into the input box. A message aimed at a cut or an edit, or one being written, stays where
  // it was. Words chosen in the transcript or a stretch marked on the ruler stay through a seek or pause; only N takes
  // their place. With a cut or an edit open, a pause or N into an empty box shows its time in the tag, and the next seek
  // moves it there: the message stays the cut's or the edit's, and Scarlet is told the frame the editor stopped on.
  const pickPoint = (picked: AgentContext, how: "seek" | "n" | "pause") => {
    const box = useUiStore.getState();
    if (rewordingItem || box.speaking) return;
    const written = box.agentDraft.trim();
    const target = box.agentContext;
    if (replyTo) {
      // N takes the frame as a pause does.
      if (!aimedAtChange(target) || written || (how === "seek" && !pausedAtRef.current)) return;
      setPausedAt({ time: picked.time, version: picked.version, ...picked.mediaId && { mediaId: picked.mediaId } });
      return;
    }
    if (target && target !== "whole" && (target.changeId || written)) return;
    // A message being written about the whole video, aimed or not yet, stays so through a seek: the line above the
    // box offers to bring it along.
    if (how !== "n" && (!target || target === "whole" ? written : !pointOf(target))) return;
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
      const moveOn = sentMovesOn.current;
      settleAim.current("sent");
      moveOn();
    }
  };
  // Taking the tag off (Backspace in an empty box, or its ×) makes the message a new edit about the whole video. ⌘Z in
  // the empty box puts the aim back as it was, until the box is aimed again or written in. Taken off a box with words in
  // it, the tag isn't ⌘Z's to put back: the words keep their own ⌘Z, also once the editor has deleted them.
  const clearTarget = () => {
    const ui = useUiStore.getState();
    const was = { replyTo, label: targetLabel, forItem: aimForItem.current, context: ui.agentContext };
    const before = aims.current;
    settleAim.current("new");
    tagTakenOff.current = aims.current === before || ui.agentDraft.trim() ? undefined : { aim: aims.current, restore: () => {
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
  // The × on a queued request takes it out of the queue. Its words aren't lost: they land in the message box when that
  // is empty, to send again, change or clear, aimed as the box is. A request Scarlet made itself has no words of the
  // editor's to keep, and a message being written or spoken keeps the box.
  const removeQueued = async (id: string) => {
    const item = queuedItems.find(i => i.id === id);
    // The words as they stand in the box, when it is this request's being reworded.
    const words = item?.fixed ? undefined : rewording?.id === id ? rewording.text : rewordingItem ? undefined : item?.text;
    const boxIsEmpty = () => { const box = useUiStore.getState(); return !box.agentDraft.trim() && !box.speaking; };
    const keep = !!words?.trim() && boxIsEmpty();
    try { await queueAction(cancelTask(id, true)); } catch { return; }
    if (!keep || !boxIsEmpty()) return;
    const box = useUiStore.getState();
    box.setAgentDraft(words!);
    box.focusComposer();
  };
  const { effective } = useAgentAvailability();
  const resumeRunWith = resumeRunChoice(tasks, effective);
  const composer = <WorkspaceComposer newEdit={!replyTo} playerVersion={playerVersion} mediaId={source?.id} key={JSON.stringify([current.id, replyTo])} thread={replyThread}
    // A new request is the latest thing said, so the chat goes to it. A cut or an edit that's open stays open.
    onCreated={() => { follow.current = true; }} onSent={sentUnder(aims.current)}
    // The box carries a tag naming the cut or edit it revises, or the point a new edit is about. Taking the tag off
    // makes the message a new edit about the whole video.
    messageClock={messageClock} pausedAt={replyTo ? pausedAt : undefined} targetTime={targetTime}
    targetTag={boxTag} targetTagNote={answerNote} onClearTarget={clearTarget} onRestoreTarget={restoreTarget}
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
    tray={queuedItems.length > 0 || (editingPaused && !editing) ? <QueueTray items={queuedItems} hint={queueHint} waits={queueWaitsOn} rewording={rewordingItem?.id} opened={trayOpen}
      onRemove={id => void removeQueued(id)}
      paused={editingPaused}
      onContinue={editingPaused && !editing ? () => queueAction(resumeRunWith ? resumeEditing(current.id, resumeRunWith) : resumeEditing(current.id)).catch(() => {}) : undefined}
      // The editor's calls are theirs to put off: the request they hold back can start without them.
      onStart={!editingPaused && queued[0] && waitFor(queued[0])?.kind === "review" ? id => void queueAction(startBeforeCalls(id)).catch(() => {}) : undefined}
      // The pencil of the request whose words are in the box puts them back as they were.
      onReword={id => {
        // A message being spoken is the box's until it is out: it would be saved over this request's words.
        if (useUiStore.getState().speaking) return;
        const item = queuedItems.find(i => i.id === id);
        setRewording(item && rewording?.id !== id ? { id, text: item.text } : undefined);
      }} /> : undefined} />;

  const adjustName = rejectTarget ? cutName(rejectTarget) ?? targetName(rejectTarget) : openCall && pass ? cutName({ changeId: pass.id, cutIndex: openCall.index }) : undefined;
  const cutAdjust = useCutAdjust({
    projectId: current.id, head, timeline, media, fps,
    focusThread, shownChange: threadTimeline.originalChange ?? shownChange, reviewingEdit: editSentBack ? undefined : reviewingEdit,
    selectedMoment: !!threadTimeline.selectedMoment, hasReviewRange: !!reviewRange, singleEdit: threadTimeline.single, leaving: threadTimeline.leaving,
    cutKey, appliedCut, beforeTimeline, otherCuts, stagedAround, setCutSide,
    onEngineLeave: asked => asked ? threadTimeline.leave() : threadTimeline.stay(),
    onAppliedRejected: version => {
      if (openEditNow.current !== openEditKey) return;
      player.pause();
      setLeavingEdit({ key: openEditKey!, version, dot: shownMarks.find(dot => dot.edit === openEditKey) });
    },
    ...(adjustName && { cutName: tagOf(adjustName) }),
    pass, openCall, listening, setListening, conflict: !!conflict, openCallBack, deciding: !!deciding,
    heard, callTimeline, callView, passRemovals,
    onSkipCall: () => { if (openCall) void decideCut(approves(openCall) === "cut" ? "keep" : "cut"); },
  });

  return <ReviewDockContext.Provider value={dock}><EditHoverContext.Provider value={hoveredEdit}>
    <main className="min-h-0 flex flex-1 flex-col">
      <Dropzone className="edit-workspace simple-workspace" label="Add footage to this project" notice={notice}
        onPaths={paths => { void uploads.startPaths(paths); setPanel("media"); }}
        onFiles={files => { uploads.start(files); setPanel("media"); }}>
        <ChatRail compact={compact} id="simple-chat" className="simple-rail" label="Chat" storageKey="scarlet.simpleChatWidth" initialWidth={simpleRailWidth} minWidth={SIMPLE_RAIL_MIN}
          // With the Transcript open the chat leaves it its narrowest, so the two never take the player's room between them.
          reserve={transcript ? TRANSCRIPT_RAIL_MIN : 0}>
          <SimpleHeader projectName={current.project.name} importing={importing} importFailed={importFailed}
            threadInput={replyThread ? replyThread.question ? "answer" : "reply" : undefined} menuSays={menuSays} toLearn={toLearn}
            transcript={transcript} setTranscript={setTranscript} setPanel={setPanel} openLearnings={() => { setLearnFocus(undefined); setPanel("learnings"); }}
            exportReady={exportReady} />
          {panel === "learnings" && <LearningsPanel focus={learnFocus} onOpenDecision={openDecision} onClose={() => { setPanel(null); setLearnFocus(undefined); }} />}
          {/* A pause of caching isn't said here: the editor chose it, and the menu's Resume caching row says it. */}
          {(importFailed || menuError) && <div className="simple-banner" role="status">
            <span>{menuError || "Some files need attention."}</span>
            {importFailed && !menuError && <button type="button" className="simple-link" onClick={() => setPanel("media")}>View media</button>}
          </div>}
          <div className="simple-thread" onClick={letGoOnChatPress}>
            <div ref={chat} className="simple-chat">
              {current.reviewStatus === "loading" ? <Loading label="Loading edits…" />
                : current.reviewStatus === "error" ? <p className="simple-error" role="alert">{current.reviewError}{" "}
                  <button type="button" className="simple-link" onClick={() => void useProjectStore.getState().load(current.id)}>Retry</button></p>
                : ordered.length ? ordered.map((thread, i) => <Turn key={thread.id} projectId={current.id} thread={thread} actions={chatActions}
                  list={listOf(thread.id)} laterRequests={ordered.length - 1 - i}
                  reportReviewMarkers={(showOtherFlags || showEvery) && thread.id !== focusThread?.id && thread.id !== passThread?.id
                    ? reportReviewMarkers : undefined} reportEvery={showEvery} />)
                : !media.length ? <p className="simple-empty">Drop footage here, then say what you want.</p>
                : caching && <p className="simple-empty" role="status">You can start editing while the video caches.</p>}
              {/* A new timeline that keeps failing to read is said after the conversation, which stays where it is. */}
              {!current.reviewStatus && current.headError && <p className="simple-error" role="alert">{current.headError}{" "}
                <button type="button" className="simple-link" onClick={() => void useProjectStore.getState().load(current.id)}>Retry</button></p>}
            </div>
            <ReviewDock key={current.id} store={dock} threadIds={threadIds} list={[dockList, setDockList]} laterRequests={ordered.length}
              onListOpen={listOpen} onKeepConfident={keepConfident} flashedThreadId={flashedThread} />
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
          <CutPreview simple={{ seekFromMessage, typedTimes, marks: source || beforeCut ? [] : suggestion && lineFocus ? marks : leavingMarks, fit: fitTimeline, focus: leavingNow && lineFocus ? { ...lineFocus, leaving: true } : lineFocus, label: onVideo, compareHost: reviewingEdit ? compareHost : undefined, above: rejectedCard ?? editCard ?? callCard ?? suggestCard, foot: <><TimelineWorking tasks={timelineWork} rootOf={rootOf} />{undoFoot}</>,
            gaps: cutKey ? [...gaps, ...stagedGaps] : callGaps ?? (stagedGaps.length ? stagedGaps : undefined),
            skippedRanges: cutKey || callView || !stagedCalls.length
              ? joinedPlayer?.clock.removed && playedListen !== appliedListen ? [...joinedPlayer.clock.removed, ...stagedAround.map(c => c.removed)]
                : joinedPlayer?.clock.removed ?? stepsOver(playedListen ?? playedAudition)
              : stagedCalls.map(c => c.removed),
            passageSkips: !cutKey && !callView && stagedCalls.length ? stagedCalls.map(c => c.removed) : undefined,
            nextCutPlayback, cutPlayback: appliedListen && beforeTimeline && cutKey && appliedCut
              ? { key: editPlaybackKey(reviewingEdit!, appliedAfterVersion, cutBase), start: appliedListen.start, side: appliedSide,
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
            onGap: hearInBefore, onBand, cutAdjust, onPick: pickPoint, onRange: markRange, holdPassage: cutWaits, reviewRange, writeRequest, heard: heardPick, quiet: quietOpen }} threadView={playerView}
            workingCache={workingCache} draftVersion={previewVersion} draft={previewTimeline}
            openingJoin={!source && (appliedCut ? joinPending : openingJoin)} cutLoadError={cutLoadError}
            draftFailed={openingJoin ? !!single.error || (!!single.preview && !listenJoined) : pinnedCallVersion ? !!savedBefore.error : !appliedCut && draftFailed}
            onRetryDraft={openingJoin ? single.retry : pinnedCallVersion ? savedBefore.retry : retryDraft} source={source} autoPlaySource={sourceChoice.play && source === chosenSource} hasCut={hasCut}
            change={draftVersion && !appliedCut ? viewed : undefined} spot={shownPlace} approval={!!draftVersion && !appliedCut} playChange={reviewPlays}
            active={workspaceActive} onMedia={() => setPanel("media")} joined={joinedPlayer} />
          {chosenSource && hasCut && source === chosenSource && <div className="simple-decide" role="region" aria-label="Source preview">
            <span className="simple-decide-text"><small>Source clip</small>{chosenSource.name}</span>
            <button type="button" className="btn-ghost" onClick={backToVideo}>Back to the video</button>
          </div>}
        </div>
        {transcript && <TranscriptRail compact={compact} paneKey={source?.id ?? previewVersion ?? head}
          draft={previewTimeline} source={source} onAsk={askAbout} onClose={() => setTranscript(false)} />}
      </Dropzone>
    </main>
    {panel === "media" && <MediaDrawer uploads={uploads} notice={local ? undefined : notice}
      onPlay={id => previewSource(id, true)} onClose={() => setPanel(null)} />}
    {panel === "export" && <ExportSheet hasCut={hasCut} onClose={() => setPanel(null)} />}
  </EditHoverContext.Provider></ReviewDockContext.Provider>;
}
