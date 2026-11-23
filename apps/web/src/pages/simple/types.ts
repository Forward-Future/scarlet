import type { Dispatch, MouseEvent, ReactNode, SetStateAction } from "react";
import type { Change, CutAssessment, TimeRange, Timeline } from "@scarlet/timeline";
import type { EditRef, Task, ThreadEdit } from "@scarlet/shared";
import { clock as clockLabel, clockRange } from "../../lib/format";
import { blurOnPointerClick } from "../../lib/hotkeys";
import type { JoinClock } from "../../lib/joinClock";
import { editKey } from "../../lib/keptEdits";
import type { CutChoice, Revision } from "../../lib/passCalls";
import type { Audition } from "../../lib/player";
import { isWorkingTask } from "../../lib/taskRun";
import type { Thread } from "../../lib/threads";
import type { AgentContext } from "../../stores/ui";

export const noEdits: ThreadEdit[] = [];
export const noop = () => {};
export const noRejected: Omit<ThreadEdit, "at">[] = [];
/** How long after the project opens its own changes are still arriving, in ms: one applied by then arrives quietly. */
export const LANDING_SETTLES = 3000;
/** How long an edit counts as just applied, in ms: its marker can take a moment to load after the change lands. */
export const LANDING_SHOWS = 4000;
/** How many versions' timelines the window keeps beyond the ones a waiting pass needs. */
export const KEPT_TIMELINES = 6;
/** What a request paused with the project's editing waits for. */
export const PAUSED_HINT = "Editing is paused. Resume picks this up where it left off.";

/** ↑ ↓ step between the cuts or edits that are open one at a time. ← → are always the player's: they skip. */
export const stepOf = (key: string): 1 | -1 | undefined => key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : undefined;

export type Side = "before" | "after";
/**
 * `take` counts presses of Before and After, so pressing the shown side again plays it from the top. `key` names the
 * call as it was when the listen began: it stays the same when the pass comes back as a new proposal and the cut gets a
 * new number, so the card keeps what the editor opened in it.
 * `at` starts the listen somewhere other than its top: where a click on the timeline pointed, inside the cut.
 */
export interface Listening { changeId: string; index: number; cut: TimeRange; side: Side; take: number; key: string; at?: number }
/** After, played from the version the cut made, where the join is inside the rendered media. */
export interface JoinedListen { version: string; timeline: Timeline; clock: JoinClock }

export type Panel = "media" | "export" | "learnings" | null;

/** Where a call stands: approved, skipped, still open, or being revised. */
type CallState = "approved" | "skipped" | "open" | "revising";
interface PassCall {
  index: number;
  askOrder?: number;
  /** Its number, as on its card and the timeline: the order it reached the editor in. */
  n: number;
  /** Where its row goes in the list. */
  start: number;
  /** Where its cut is on the working cut. None while it isn't there as it was staged, so nothing on the timeline is its. */
  at?: number;
  summary: string;
  state: CallState;
  version: number;
  /** The word its row ends on while it waits: how much its cut takes out, or Check when Scarlet proposes keeping the footage. */
  tag: string;
  /** The request about this cut that Scarlet is on, or the next one waiting, while it's sent back. */
  run?: Task;
  /** What the last version was and the note that sent it back, for a revised call. */
  earlier?: Revision;
}

/** The dialogue pass waiting on the editor, as the chat's summary card needs it. */
export interface OpenPass {
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

export type HoveredReviewRow = { threadId: string; editKey?: string; call?: number };
type ReviewMarker = { edit: ThreadEdit; number: number; total: number };
export type LocatedReview = { head: string | null; markers: ReviewMarker[] };
export type ReportReviewMarkers = (threadId: string, review?: LocatedReview) => void;

export interface ChatActions {
  /** How many requests about one cut or edit Scarlet is working on at this moment. It works on several at once when each is about its own. */
  atOnce?: number;
  /** The queued request Scarlet will take up next, matching the tray's Next line. */
  nextQueuedId?: string;
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
  /** Aim the message box at the request Scarlet is working on, as a note to it ("Add a note" on its working line). */
  addNote?(taskId: string): void;
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
 * Which of a request's lists is open: every edit, or just the ones that need the editor. A pass's calls are listed
 * without a click for as long as they wait.
 */
export type OpenList = "all" | "need" | undefined;
export type PassList = [open: OpenList, setOpen: Dispatch<SetStateAction<OpenList>>];

/** A request about one cut or edit that is still in the chat, drawn directly under the row it is about. `key` is that row's. */
export interface Nest { key: string; node: ReactNode }
export const noNests: readonly Nest[] = [];
/** What the requests about each row's cut or edit took, by the row's key, for the hover of the word the row ends on. */
export type Spent = ReadonlyMap<string, string>;
export const noSpent: Spent = new Map();

/** Whether For you has listed this edit, or a version of it it replaced, so it keeps its row there once decided. */
export const listedBefore = (listed: ReadonlySet<string>, e: Omit<ThreadEdit, "at">) =>
  listed.has(editKey(e)) || e.previous.some(p => listed.has(editKey(p)));

/** Let the new video finish attaching (including StrictMode's effect replay) before giving it a listen.
 * A selection replaced in the same commit never starts playback on the next selection's video. */
export function afterPlayerMount(start: () => () => void) {
  let closed = false;
  let stop: (() => void) | undefined;
  queueMicrotask(() => { if (!closed) stop = start(); });
  return () => {
    closed = true;
    stop?.();
  };
}

/**
 * A control that stays on screen after it's pressed lets go of the focus when it was pressed with the mouse: WebView2
 * leaves the focus on a clicked button, and Space would then press it again instead of playing the video. Pressed
 * with the keyboard it keeps the focus, so Tab goes on from there.
 */
export const letGo = (act: () => void) => (e: MouseEvent<HTMLElement>) => { blurOnPointerClick(e); act(); };

/** What Keep chooses on a call: the cut, or for a revision that left the footage in, keeping it. */
export const approves = (call: Pick<CutAssessment, "proposes"> | undefined): CutChoice => call?.proposes ?? "cut";

export const callRowKey = (c: PassCall) => `call/${c.n}`;

/**
 * An edit by its first version. A revision that lands takes the edit's place in the list under a new identity, and
 * is still that edit to the editor: what they started on its open card stays theirs.
 */
export const firstKey = (edit: ThreadEdit) => editKey(edit.previous[0] ?? edit);

/** True when this edit is the one in the player, including an earlier attempt that a revision replaced. */
export function belongsTo(edit: ThreadEdit | undefined, change: Change) {
  return !!edit && (edit.changeId === change.id || edit.previous.some(ref => ref.changeId === change.id));
}

/** A request's words, short enough to lead a hover note: its first line, up to 32 characters. */
export const shortTitle = (title: string) => {
  const line = title.split("\n")[0]!.trim();
  return line.length > 32 ? `${line.slice(0, 31).trimEnd()}…` : line;
};

/** Scarlet is on a request now, as against one waiting its turn or for an answer. */
export const isWorking = (state?: Task["state"]) => !!state && isWorkingTask(state);

/** What a request revises, as the tag on its message and in the message box: "the cut at 2:05" reads "Cut at 2:05". */
export const tagOf = (label: string) => { const text = label.replace(/^the /, ""); return text.charAt(0).toUpperCase() + text.slice(1); };

/**
 * Every passage a listen steps over: its own skips, and the cuts beyond it it steps over once the editor plays on. The
 * playhead jumps across each of them, as the picture does, and never glides through one.
 */
export const stepsOver = (listen: Audition | undefined) => listen?.beyond?.length ? [...listen.skips, ...listen.beyond] : listen?.skips;

/** The player fills the screen, by the window's own full screen or the page's stand-in for it. Esc leaves that first. */
export const inFullScreen = () => !!document.fullscreenElement || !!document.querySelector(".cut-preview[data-expanded]");

/** The box is aimed at a cut or an edit, not at a moment or the whole video. */
export function aimedAtChange(aim: AgentContext | "whole" | null) {
  return !!aim && aim !== "whole" && !!aim.changeId;
}

/** The passage Scarlet asks the editor to check, as the clock reads it: one time for a moment, from and to for a stretch. */
export function checkSpan({ start, end }: TimeRange) {
  return end - start < 0.05 ? clockLabel(start) : clockRange(start, end);
}
