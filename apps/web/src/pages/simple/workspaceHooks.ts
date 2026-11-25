import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { isPublishedCall, type Change, type Timeline } from "@scarlet/timeline";
import { ScarletApiError, type Task, type ThreadEdit } from "@scarlet/shared";
import { appLog } from "../../lib/appLog";
import { api, errorMessage, UNEXPLAINED } from "../../lib/client";
import { editKindWord } from "../../lib/editKind";
import type { Moment } from "../../lib/editMoments";
import { parseTimestamp } from "../../lib/format";
import { ignorePageShortcut, isAltClearRangeKey, isComposing, isEditableTarget } from "../../lib/hotkeys";
import { editKey, keepEdits } from "../../lib/keptEdits";
import { needNumbers } from "../../lib/needNumbers";
import { savedChoices, type Call, type CutChoice } from "../../lib/passCalls";
import type { Footage } from "../../lib/carriedCuts";
import { readTimeline } from "../../lib/timelineCache";
import { isClippedInScrollAncestors } from "../../lib/uiHooks";
import { lastStep, useUndoStore } from "../../lib/undo";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";
import type { Thread } from "../../lib/threads";
import { marksTakeEscape } from "../../components/player/PictureMarks";
import { inFullScreen, KEPT_TIMELINES, LANDING_SETTLES, LANDING_SHOWS, stepOf, type Panel } from "./types";

/**
 * The timelines a pass's cuts are carried across. Each working cut the window shows is kept as it goes by, so the
 * version before Scarlet's own edit between two parts is at hand the moment the next part arrives, and a card open on
 * a call stays open. Any other version wanted is asked for.
 */
export function useCarryingFootage(projectId: string, working: Timeline | null | undefined, wanted: readonly string[], fps: number): Footage {
  const kept = useRef<{ projectId: string; timelines: Map<string, Timeline>; asked: Set<string>; failed: Map<string, number> }>(undefined);
  if (kept.current?.projectId !== projectId) kept.current = { projectId, timelines: new Map(), asked: new Set(), failed: new Map() };
  const store = kept.current;
  const [fetched, setFetched] = useState(0);
  const [retry, setRetry] = useState(0);
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
      }, () => {
        store.asked.delete(version);
        // Asked again shortly, a few times: the engine may be restarting, and nothing else asks until the pass saves
        // another part, while a call open on that version waits for its footage.
        const tries = (store.failed.get(version) ?? 0) + 1;
        store.failed.set(version, tries);
        if (tries < 4) setTimeout(() => { if (kept.current === store) setRetry(n => n + 1); }, 1500 * tries);
      });
    }
  }, [projectId, key, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({ at: version => store.timelines.get(version), fps }), [store, working, fetched, fps]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * An edit applied while the editor watches arrives on the timeline with a moment. One applied before the project opened
 * arrives quietly: a change counts as just applied when it was seen waiting first, or turned up applied once the
 * project's own changes were in.
 */
export function useLandingTracker(changes: readonly Change[], reviewStatus?: "loading" | "error") {
  const landing = useRef<{ opened: number; states: Map<string, string>; at: Map<string, number> }>(undefined);
  if (!reviewStatus) landing.current ??= { opened: Date.now(), states: new Map(changes.map(c => [c.id, c.state])), at: new Map() };
  if (landing.current) for (const change of changes) {
    const was = landing.current.states.get(change.id);
    if (change.state === "approved" && was !== "approved" && (was !== undefined || Date.now() - landing.current.opened > LANDING_SETTLES)
      && !landing.current.at.has(change.id)) landing.current.at.set(change.id, Date.now());
    landing.current.states.set(change.id, change.state);
  }
  const justLanded = (changeId: string) => Date.now() - (landing.current?.at.get(changeId) ?? -Infinity) < LANDING_SHOWS;
  const landedAt = (changeId: string) => landing.current?.at.get(changeId);
  // Once its moment is over the marker is drawn as any other, so a zoom that draws it again doesn't play the moment twice.
  const landingEnds = Math.max(0, ...landing.current?.at.values() ?? []) + LANDING_SHOWS;
  const [, endLanding] = useState(0);
  useEffect(() => {
    const left = landingEnds - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => endLanding(n => n + 1), left + 50);
    return () => window.clearTimeout(timer);
  }, [landingEnds]);
  return { justLanded, landedAt };
}

/** Reads the proposed timeline for a suggestion's After view. */
export function useDraftTimeline(projectId: string, draftVersion?: string) {
  const [draftState, setDraftState] = useState<{ version: string; timeline?: Timeline; failed?: boolean }>();
  const [draftAttempt, setDraftAttempt] = useState(0);
  useEffect(() => {
    if (!draftVersion) return;
    let live = true;
    setDraftState(state => state?.version === draftVersion && state.timeline ? state : { version: draftVersion });
    readTimeline(projectId, draftVersion).then(
      timeline => { if (live) setDraftState({ version: draftVersion, timeline }); },
      () => { if (live) setDraftState({ version: draftVersion, failed: true }); });
    return () => { live = false; };
  }, [projectId, draftVersion, draftAttempt]);
  return {
    draft: draftState?.version === draftVersion ? draftState?.timeline : undefined,
    draftFailed: !!draftVersion && draftState?.version === draftVersion && !!draftState.failed,
    retryDraft: () => setDraftAttempt(n => n + 1),
  };
}

/**
 * A call's Keep or Reject edit that wasn't saved: why, when the engine said, and what to do about it. The call is back
 * with the editor, undecided, so making the decision again is what saves it. A pass that has moved on since (the
 * engine's conflict) says only that: pressing again wouldn't save it.
 */
export function callNotSaved(error: unknown) {
  const reason = errorMessage(error).trim();
  const why = !reason || reason === UNEXPLAINED ? "." : `: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`;
  const movedOn = error instanceof ScarletApiError && error.status === 409;
  return `Couldn’t save this call${why}${movedOn ? "" : " Press Keep or Reject edit again."}`;
}

/**
 * Optimistic cut-choice persistence for dialogue passes, keeping each save ordered and surfacing failures only while
 * their calls remain unsaved.
 */
export function usePassChoices(setDecideError: Dispatch<SetStateAction<string>>) {
  const [unsaved, setUnsaved] = useState<Record<string, { calls: Record<number, CutChoice>; applyWhenDone?: boolean }>>({});
  const choicesOf = (change: Change) => unsaved[change.id]?.calls ?? savedChoices(change);
  const applyWhenDone = (change: Change) => unsaved[change.id]?.applyWhenDone ?? !!change.applyWhenDone;
  const saves = useRef<{ last: Record<string, object>; failed?: string; unsent: Record<string, Set<number>>; sent: number; landed: Record<string, number> }>(
    { last: {}, unsent: {}, sent: 0, landed: {} });

  async function saveChoices(change: Change, calls: Record<number, CutChoice>, passRunning: boolean, apply = passRunning && applyWhenDone(change)) {
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
      const live = held && (parseTimestamp(held.updatedAt) > parseTimestamp(saved.updatedAt) ||
        ((alreadyMoved || newerCall) && parseTimestamp(held.updatedAt) === parseTimestamp(saved.updatedAt))) ? held : saved;
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
      saves.current.failed = callNotSaved(e);
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

  return { unsaved, choicesOf, applyWhenDone, saveChoices };
}

/**
 * Stable numbering for a waiting dialogue pass's calls and its flagged edits, so nothing shown to the editor is
 * renumbered while the pass is still at work.
 */
export function usePassCallNumbers(
  projectId: string,
  pass: Change | undefined,
  passThread: Thread | undefined,
  passRoot: Task | undefined,
  allCalls: readonly Call[],
  passEdits: readonly Omit<ThreadEdit, "at">[],
  rejectedPassEdits: readonly Omit<ThreadEdit, "at">[] = [],
) {
  return useMemo(() => {
    const callNo = new Map<number, number>(), passEditNo = new Map<string, { n: number; name: string }>();
    if (!pass || !passThread) return { callNo, passEditNo };
    // A legacy pass receives publication numbers on the first new ask. Match the row it already showed by
    // the slot in that same proposal; the same index in a later proposal can belong to different footage.
    const callKeys = allCalls.map(a => {
      const slot = `slot/${pass.id}/${a.index}`;
      return a.askOrder === undefined ? { key: `cut/${a.index}`, rememberAs: slot } : { key: `ask/${a.askOrder}`, previous: slot };
    });
    const at = (e: { range: { start: number } }) => (e as { at?: number }).at ?? e.range.start;
    const edits = [
      ...passEdits.filter(e => !!e.check),
      ...rejectedPassEdits.filter(e => !!e.wasCheck),
    ].sort((a, b) => at(a) - at(b));
    const editKeyOf = (e: (typeof edits)[number]) => `edit/${editKey(e.previous[0] ?? e)}`;
    const numbers = needNumbers(projectId, passThread.id, passRoot?.resumeRootId ?? passRoot?.id ?? pass.id, [...callKeys, ...edits.map(editKeyOf)]);
    allCalls.forEach((call, i) => callNo.set(call.index, numbers.get(callKeys[i]!.key)!));
    for (const e of edits) {
      const n = numbers.get(editKeyOf(e))!;
      const name = `${e.beforeCut || editKindWord(e) === "Cut" ? "Cut" : "Edit"} ${n}`;
      for (const ref of [e, ...e.previous]) passEditNo.set(editKey(ref), { n, name });
    }
    return { callNo, passEditNo };
  }, [pass, passThread?.id, passRoot?.id, allCalls, passEdits, rejectedPassEdits, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Responds to `scarlet:bookmark-project` when leaving for Settings or restarting for an update. */
export function useProjectBookmark(placeOnCut: () => number | undefined, openNow: () => string | undefined, panel: Panel) {
  const placeRef = useRef(placeOnCut);
  placeRef.current = placeOnCut;
  const openRef = useRef(openNow);
  openRef.current = openNow;
  const panelRef = useRef(panel);
  panelRef.current = panel === "media" ? panel : null;
  useEffect(() => {
    const bookmark = (event: Event) => {
      const at = placeRef.current();
      if (at === undefined) return;
      const place = (event as CustomEvent<URL>).detail.searchParams;
      place.set("t", String(at));
      const { rate } = usePlayerStore.getState();
      if (rate !== 1) place.set("speed", String(rate));
      // What is open goes with the place: the drawer, and the call, cut or edit on its card.
      const open = openRef.current();
      if (open) place.set("open", open);
      if (panelRef.current) place.set("panel", panelRef.current);
    };
    window.addEventListener("scarlet:bookmark-project", bookmark);
    return () => window.removeEventListener("scarlet:bookmark-project", bookmark);
  }, []);
}

/** With a pass's full list open, playing straight through an unflagged moment keeps its edits automatically. */
export function useWatchedMomentAutoKeep(
  watching: boolean,
  watchedMoments: readonly Moment<ThreadEdit>[],
  projectId: string,
  focusThreadId: string | undefined,
  head: string | null,
) {
  const watchKeep = useRef({ watchedMoments, keep: (refs: ThreadEdit[]) => { if (focusThreadId) keepEdits(projectId, focusThreadId, refs, head ?? undefined); } });
  watchKeep.current = { watchedMoments, keep: refs => { if (focusThreadId) keepEdits(projectId, focusThreadId, refs, head ?? undefined); } };
  useEffect(() => {
    if (!watching) return;
    // Where the run of play now under way began. A seek, a skip or a pause starts a new one.
    let from: number | undefined;
    const done = new Set<string>();
    return usePlayerStore.subscribe((now, was) => {
      if (!now.playing) { from = undefined; return; }
      if (!was.playing) from = Math.min(was.time, now.time);
      else if (now.seeks !== was.seeks || now.time < was.time - 0.05 || now.time - was.time > 1.5) from = now.time;
      else from ??= was.time;
      const start = from;
      // Play has to begin clearly before a moment to count: a card closed without a decision leaves the playhead on its
      // cut's join, and playing on from there isn't watching the cut. Only the very start of the video has nothing before it.
      const seen = watchKeep.current.watchedMoments.filter(m => !done.has(m.key) && (start <= m.start - 0.2 || start <= 0.05) && now.time >= m.end - 0.05);
      if (!seen.length) return;
      for (const m of seen) done.add(m.key);
      appLog("review", "watched", { moments: seen.length, at: now.time });
      watchKeep.current.keep(seen.flatMap(m => m.edits));
    });
  }, [watching]);
}

/** Handles workspace-level ⌘Z / Ctrl+Z for undoing Keeps and revisions when no text box or dialog owns it. */
export function useUndoShortcut(workspaceActive: boolean, projectId: string, undoRef: RefObject<{ undo(): Promise<void> }>) {
  useEffect(() => {
    if (!workspaceActive) return;
    // A message box the editor has just emptied still has those words to bring back, so its own ⌘Z goes first. A box a
    // send emptied, one built again for another aim, or one its own ⌘Z ran back to empty has none.
    const emptiedByHand = new WeakSet<EventTarget>();
    const onInput = (e: Event) => {
      const field = e.target;
      if (!(field instanceof HTMLTextAreaElement) || !field.closest(".composer-box")) return;
      if (!field.value && (e as InputEvent).inputType !== "historyUndo") emptiedByHand.add(field);
      else emptiedByHand.delete(field);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.defaultPrevented) return;
      // Words being written keep their own ⌘Z. The message box, once empty, leaves it here when it had no tag to put back.
      const box = e.target instanceof HTMLTextAreaElement && e.target.closest(".composer-box") && !e.target.value && !emptiedByHand.has(e.target);
      if (isEditableTarget(e.target) && !box) return;
      if (document.querySelector('dialog[open], [role="dialog"], [role="menu"]')) return;
      if (!lastStep(useUndoStore.getState().steps, projectId)) {
        // The key is left to the page, and nothing is taken back: said so the log shows the press did nothing.
        appLog("action", "undo-skipped", { project: projectId, reason: "empty" });
        return;
      }
      e.preventDefault();
      if (!e.repeat) void undoRef.current.undo();
    };
    window.addEventListener("input", onInput, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("input", onInput, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [workspaceActive, projectId, undoRef]);
}

/** Capture-phase ↑/↓/Esc shortcuts while an applied edit card is open. */
export function useEditCardShortcuts(active: boolean, stepEdit: (delta: number) => void, closeEdit: () => void) {
  const editKeys = useRef({ stepEdit, closeEdit });
  editKeys.current = { stepEdit, closeEdit };
  useEffect(() => {
    if (!active) return;
    // Capture phase, so ↑ and ↓ step between edits before anything else takes them. ← and → pass through to the player.
    const onKey = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e) || e.shiftKey) return;
      const step = stepOf(e.key);
      if (step) {
        e.preventDefault();
        if (!e.repeat) editKeys.current.stepEdit(step);
      } else if (e.key === "Escape") {
        // Full screen takes the first Esc: it leaves full screen, and the edit stays open. So does the marking of a
        // frame, which ends on it.
        if (inFullScreen() || marksTakeEscape(e)) return;
        e.preventDefault();
        editKeys.current.closeEdit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
}

/** Capture-phase ↑/↓/Esc shortcuts while a dialogue pass or suggestion card is open. */
export function useCallCardShortcuts(reviewKeysOn: boolean, hasPass: boolean, state: {
  stepCut(delta: number): void; stopListening(): void; closeReview(): void;
  listening: boolean; suggestion: boolean; applying: boolean; calls: boolean;
}) {
  const reviewKeys = useRef(state);
  reviewKeys.current = state;
  useEffect(() => {
    if (!reviewKeysOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (ignorePageShortcut(e) || e.shiftKey) return;
      const keys = reviewKeys.current;
      const step = stepOf(e.key);
      // With no call to step to, the arrows stay the player's: a pass still running, or one with nothing to ask. They
      // stay the player's while a suggestion is on its card too: no key acts on a call that isn't on screen.
      if (hasPass && !keys.suggestion && step && keys.calls) {
        e.preventDefault();
        if (!e.repeat) keys.stepCut(step);
      } else if (e.key === "Escape" && (keys.listening || keys.suggestion) && !inFullScreen() && !marksTakeEscape(e)) {
        e.preventDefault();
        // Esc is the card's Close: neither closes a suggestion while it is being applied.
        if (keys.listening) keys.stopListening(); else if (!keys.applying) keys.closeReview();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reviewKeysOn, hasPass]);
}

/** Esc closes what is behind every card: the Transcript column, then the picked request. An edit, call or suggestion card takes Esc first. */
export function useEscapeCloses(enabled: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || ignorePageShortcut(e) || inFullScreen()) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Clears a timeline marked range on Esc, Delete/Backspace, or Option/Alt+X (ahead of anything else Esc would close),
 *  or on a short click outside the composer and the stage (the player, its card and the timeline), so the editor can
 *  play the range, pause and adjust it without losing it. */
export function useOutsideClearMarkedRange(hasMarkedRange: boolean, onClear: () => void) {
  const clearRef = useRef(onClear);
  clearRef.current = onClear;
  useEffect(() => {
    if (!hasMarkedRange) return;
    let down: { x: number; y: number; id: number; away: boolean } | undefined;
    const away = (target: EventTarget | null) => target instanceof Element && !target.closest(".composer-dock, .simple-stage, .timeline-range-loupe, .timeline-range-menu");
    const press = (e: PointerEvent) => { down = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId, away: away(e.target) } : undefined; };
    const release = (e: PointerEvent) => {
      const was = down;
      down = undefined;
      if (was?.away && was.id === e.pointerId && Math.hypot(e.clientX - was.x, e.clientY - was.y) <= 4) {
        appLog("timeline", "range-cleared", { via: "click-away" });
        clearRef.current();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target) || isComposing(e)) return;
      // An open dialog, menu, popover, full screen, or frame marking takes its own keys first.
      if (document.querySelector('dialog[open], [role="dialog"], [role="menu"], [data-escape-owner], [data-shortcut-overlay]')) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      const escape = plain && e.key === "Escape";
      const erase = plain && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace");
      const clearInOut = isAltClearRangeKey(e);
      if (!escape && !erase && !clearInOut) return;
      if ((escape && inFullScreen()) || marksTakeEscape(e)) return;
      e.preventDefault();
      appLog("timeline", "range-cleared", { via: "key", key: clearInOut ? "alt+x" : e.key });
      clearRef.current();
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("pointerup", release, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("pointerup", release, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [hasMarkedRange]);
}

const SELECTED_REVISION_ROW = '.simple-pass-list [aria-current="true"], .simple-edits [aria-current="true"], button.req-summary[aria-current="true"]';

/** Keeps the chat scrolled to the newest message while `follow` is true, unless a revision row in the chat is selected. */
export function useChatAutoFollow(
  chat: RefObject<HTMLDivElement | null>,
  follow: RefObject<boolean>,
  threadCount: number,
  lastActivity: string | undefined,
  taskCount: number,
) {
  const prevCounts = useRef({ threadCount, taskCount });
  useLayoutEffect(() => {
    const grew = threadCount > prevCounts.current.threadCount || taskCount > prevCounts.current.taskCount;
    prevCounts.current = { threadCount, taskCount };
    const pane = chat.current;
    if (!pane || !follow.current) return;
    // Keeping or deciding an edit bumps `updatedAt` via the engine; never yank the chat away from the selected row
    // unless a brand-new message or task arrived.
    if (!grew && pane.querySelector(SELECTED_REVISION_ROW)) return;
    pane.scrollTop = pane.scrollHeight;
  }, [chat, follow, threadCount, lastActivity, taskCount]);
  // The spot above the message box grows and shrinks with what it holds, and the chat's room with it. While a
  // revision row in the chat is selected, keep that row in view; otherwise keep the latest message in view.
  useEffect(() => {
    const pane = chat.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const selected = pane.querySelector(SELECTED_REVISION_ROW);
      if (selected) {
        if (isClippedInScrollAncestors(selected)) selected.scrollIntoView?.({ block: "nearest" });
        return;
      }
      if (follow.current) pane.scrollTop = pane.scrollHeight;
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [chat, follow]);
}
