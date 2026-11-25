import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { cutAdjustBounds, editAdjustBounds, timelineDuration, withHandles, type Change, type MediaAsset, type TimeRange, type Timeline } from "@scarlet/timeline";
import type { ThreadEdit } from "@scarlet/shared";
import type { CutAdjustOptions, CutEdgeReadout } from "../../components/review/TimelineCutTrim";
import { useTranscriptWindow } from "../../components/transcript/useTranscriptWindow";
import { cutWords } from "../../lib/transcriptMap";
import { editRowWord } from "../../lib/editKind";
import { errorMessage } from "../../lib/client";
import type { Call, CutChoice } from "../../lib/passCalls";
import type { Thread } from "../../lib/threads";
import { recordUndo, useUndoStore } from "../../lib/undo";
import { appLog } from "../../lib/appLog";
import { player } from "../../lib/player";
import { useProjectStore } from "../../stores/project";
import type { AppliedCutSide } from "./useAppliedCut";
import type { Listening } from "./types";

const WORD_WINDOW_HANDLES = 8;
const MAX_READOUT_WORDS = 4;

interface UseCutAdjustInputs {
  projectId: string;
  head: string | null;
  timeline: Timeline | null;
  media: MediaAsset[];
  fps: number;
  // Applied edit / cut context
  focusThread?: Thread;
  shownChange?: Change;
  reviewingEdit?: ThreadEdit;
  selectedMoment?: boolean;
  hasReviewRange?: boolean;
  singleEdit?: boolean;
  leaving?: boolean;
  cutKey?: string;
  appliedCut?: TimeRange;
  beforeTimeline?: Timeline;
  otherCuts: readonly TimeRange[];
  stagedAround: readonly { removed: TimeRange }[];
  setCutSide: Dispatch<SetStateAction<AppliedCutSide | undefined>>;
  onAppliedRejected(version: string): void;
  onEngineLeave?(asked: boolean): void;
  cutName?: string;
  // Waiting dialogue-pass call context
  pass?: Change;
  openCall?: Call;
  listening?: Listening;
  setListening: Dispatch<SetStateAction<Listening | undefined>>;
  conflict?: boolean;
  openCallBack?: boolean;
  deciding?: boolean;
  heard?: TimeRange;
  callTimeline?: Timeline;
  callView?: {
    timeline: Timeline;
    cut: TimeRange;
    duration: number;
    toWorking: { toMedia(t: number): number };
    shown: readonly { removed: TimeRange }[];
  };
  /**
   * The pass's cuts by index, placed on the version `heard` is on. One that can't be placed there is undefined, and
   * then the call's edges don't move: there is nothing to stop them short of it.
   */
  passRemovals?: readonly (TimeRange | undefined)[];
  /** Decides the open call. Pulling its cut to nothing puts the whole cut back: the footage stays, whatever the call proposes. */
  onDecideCall(choice: CutChoice): void;
}

function clipIdsOf(change: Change | undefined): string[] | undefined {
  if (!change?.ops?.length) return undefined;
  const ids = new Set<string>();
  for (const op of change.ops) {
    if (op.op === "addClip" && op.clip && typeof op.clip === "object" && typeof (op.clip as { id?: unknown }).id === "string") {
      ids.add((op.clip as { id: string }).id);
    } else if (op.op === "updateClip" && typeof op.clipId === "string") {
      ids.add(op.clipId);
    }
  }
  return ids.size ? [...ids] : undefined;
}

/**
 * Provides quiet hover-only timeline edge-drag adjustment for any open edit that can be updated directly by the engine
 * without asking the AI model again:
 * - An applied cut (`adjustCut`, zero model round-trip, ⌘Z undo)
 * - A waiting dialogue-pass call (`reviseStagedCut`, ⌘Z undo)
 * - Any timed non-cut edit (`adjustEdit`: captions, B-roll, graphics, overlays, added audio clips, split-clip zooms/reframes/voice edits, music dips, J/L split edits)
 * Returns `undefined` whenever no edit is open, another edit spans a cut join, or the edit needs Scarlet to rethink.
 */
export function useCutAdjust({
  projectId, head, timeline, media, fps,
  focusThread, shownChange, reviewingEdit, selectedMoment, hasReviewRange, singleEdit, leaving, cutKey, appliedCut, beforeTimeline, otherCuts, stagedAround, setCutSide, onAppliedRejected, onEngineLeave, cutName,
  pass, openCall, listening, setListening, conflict, openCallBack, deciding, heard, callTimeline, callView, passRemovals, onDecideCall,
}: UseCutAdjustInputs): CutAdjustOptions | undefined {
  const busy = useRef(false);

  const activeMode = appliedCut && beforeTimeline && timeline && reviewingEdit && focusThread && !leaving && !reviewingEdit.rejected && !reviewingEdit.marker && reviewingEdit.at !== undefined && reviewingEdit.beforeCut
    ? "applied" as const
    : !appliedCut && timeline && reviewingEdit && focusThread && !leaving && !reviewingEdit.rejected && !reviewingEdit.marker && !reviewingEdit.beforeCut && reviewingEdit.at === undefined && !selectedMoment && !hasReviewRange && reviewingEdit.range.end > reviewingEdit.range.start
      ? "edit" as const
      : openCall && pass && listening && !conflict && !openCallBack && !deciding && heard && callTimeline
        ? "call" as const
        : undefined;

  const displayedTimeline = activeMode === "applied"
    ? beforeTimeline
    : activeMode === "edit"
      ? timeline ?? undefined
      : activeMode === "call"
        ? (callView?.timeline ?? callTimeline)
        : undefined;
  const displayedBand = activeMode === "applied"
    ? appliedCut
    : activeMode === "edit"
      ? reviewingEdit?.range
      : activeMode === "call"
        ? (callView?.cut ?? heard)
        : undefined;
  const transcriptRange = useMemo(() => {
    if (!displayedTimeline || !displayedBand) return undefined;
    return withHandles(displayedBand, WORD_WINDOW_HANDLES, timelineDuration(displayedTimeline));
  }, [displayedTimeline, displayedBand?.start, displayedBand?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const { transcripts } = useTranscriptWindow(undefined, displayedTimeline ?? null, media, transcriptRange ?? { start: 0, end: 0 });
  const words = useMemo(() => {
    if (!displayedTimeline || !transcripts.length) return [];
    return cutWords(displayedTimeline, transcripts).map(w => ({
      text: w.word.text,
      start: w.placements[0]!.start,
      end: w.placements[0]!.end,
      mid: (w.placements[0]!.start + w.placements[0]!.end) / 2,
    }));
  }, [displayedTimeline, transcripts]);

  const describeCutEdge = useCallback((edge: "start" | "end", oldTime: number, newTime: number, nextRange: TimeRange): CutEdgeReadout => {
    if (nextRange.end - nextRange.start <= 0.5 / fps) {
      return { text: "Put back whole cut", tone: "put-back" };
    }
    const delta = newTime - oldTime;
    if (Math.abs(delta) < 0.5 / fps) return { text: edge === "start" ? "Cut start" : "Cut end", tone: "neutral" };
    const restoring = (edge === "start" && delta > 0) || (edge === "end" && delta < 0);
    const lo = Math.min(oldTime, newTime), hi = Math.max(oldTime, newTime);
    const crossed = words.filter(w => w.mid >= lo && w.mid <= hi);
    const signed = `${restoring ? "+" : "−"}${Math.abs(delta).toFixed(2)} s`;
    if (crossed.length) {
      const shown = crossed.slice(0, MAX_READOUT_WORDS).map(w => w.text).join(" ");
      const more = crossed.length > MAX_READOUT_WORDS ? " …" : "";
      return {
        text: `${restoring ? "Put back" : "Take out"} “${shown}${more}”`,
        tone: restoring ? "put-back" : "take-out",
        delta: signed,
      };
    }
    return {
      text: restoring ? "Put back" : "Take out",
      tone: restoring ? "put-back" : "take-out",
      delta: signed,
    };
  }, [words, fps]);

  const describeEditEdge = useCallback((edge: "start" | "end", oldTime: number, newTime: number, nextRange: TimeRange): CutEdgeReadout => {
    const isSplit = reviewingEdit?.kind === "split";
    if (nextRange.end - nextRange.start <= 0.5 / fps) {
      return { text: isSplit ? "Straight cut" : `Remove ${editRowWord(reviewingEdit ?? {}).toLowerCase()}`, tone: "take-out" };
    }
    const delta = newTime - oldTime;
    if (Math.abs(delta) < 0.5 / fps) return { text: edge === "start" ? "Starts here" : "Ends here", tone: "neutral" };
    const longer = (edge === "start" && delta < 0) || (edge === "end" && delta > 0);
    const action = edge === "start"
      ? (delta < 0 ? "Starts earlier" : "Starts later")
      : (delta > 0 ? "Ends later" : "Ends earlier");
    const signed = `${longer ? "+" : "−"}${Math.abs(delta).toFixed(2)} s`;
    const nearWord = words.find(w => newTime >= w.start - 0.08 && newTime <= w.end + 0.08);
    return {
      text: nearWord ? `${action} · on “${nearWord.text}”` : action,
      tone: longer ? "put-back" : "neutral",
      delta: signed,
    };
  }, [words, fps, reviewingEdit]);

  // 1. Applied cut bounds (strictly checks live working cut via cutAdjustBounds — refuses spanned joins silently).
  const appliedBounds = useMemo(() => {
    if (activeMode !== "applied" || !timeline || !reviewingEdit?.beforeCut || reviewingEdit.at === undefined || !appliedCut || !beforeTimeline) return;
    const ownRemoved = reviewingEdit.beforeCut.removed;
    const ownLen = ownRemoved.end - ownRemoved.start;
    if (ownLen <= 0.5 / fps) return;
    const raw = cutAdjustBounds(timeline, reviewingEdit.at, ownLen, fps, media);
    if (!raw) return;
    const beforeDur = timelineDuration(beforeTimeline);
    const neighbors = [...otherCuts, ...stagedAround.map(s => s.removed)];
    const prevEnd = neighbors.reduce((max, r) => r.end <= appliedCut.start + 0.5 / fps ? Math.max(max, r.end) : max, 0);
    const nextStart = neighbors.reduce((min, r) => r.start >= appliedCut.end - 0.5 / fps ? Math.min(min, r.start) : min, beforeDur);
    const pad = 1 / fps;
    const minStart = Math.max(prevEnd > 0 ? prevEnd + pad : 0, appliedCut.start + raw.minStartDelta);
    const maxStart = Math.min(appliedCut.end, appliedCut.start + raw.maxStartDelta);
    const minEnd = Math.max(appliedCut.start, appliedCut.end + raw.minEndDelta);
    const maxEnd = Math.min(nextStart < beforeDur ? nextStart - pad : beforeDur, appliedCut.end + raw.maxEndDelta);
    if (minStart >= appliedCut.start - 0.5 / fps && maxStart <= appliedCut.start + 0.5 / fps &&
        minEnd >= appliedCut.end - 0.5 / fps && maxEnd <= appliedCut.end + 0.5 / fps) return;
    return { minStart, maxStart, minEnd, maxEnd };
  }, [activeMode, timeline, reviewingEdit, appliedCut, beforeTimeline, otherCuts, stagedAround, fps, media]);

  // 2. Non-cut applied edit bounds (captions, B-roll, graphics, overlays, added audio, split zooms/reframes/voice, music dips, J/L split edits).
  const editBounds = useMemo(() => {
    if (activeMode !== "edit" || !timeline || !reviewingEdit) return;
    const clipIds = clipIdsOf(shownChange);
    return editAdjustBounds(timeline, reviewingEdit.range, fps, media, { kind: reviewingEdit.kind, clipIds });
  }, [activeMode, timeline, reviewingEdit, shownChange, fps, media]);

  // 3. Waiting dialogue-pass call bounds (clamped between neighboring staged cuts and any already-applied cuts).
  const callBounds = useMemo(() => {
    if (activeMode !== "call" || !pass || !openCall || !heard || !displayedTimeline || !displayedBand) return;
    const dur = timelineDuration(displayedTimeline);
    const pad = 1 / fps;
    let minStart = 0, maxEnd = dur;
    const siblings = passRemovals ?? [];
    for (let i = 0; i < siblings.length; i++) {
      if (i === openCall.index) continue;
      const other = siblings[i];
      if (!other) return;
      if (other.end <= heard.start + 0.5 / fps) {
        const delta = heard.start - other.end - pad;
        minStart = Math.max(minStart, displayedBand.start - Math.max(0, delta));
      } else if (other.start >= heard.end - 0.5 / fps) {
        const delta = other.start - heard.end - pad;
        maxEnd = Math.min(maxEnd, displayedBand.end + Math.max(0, delta));
      }
    }
    if (callView) {
      for (const gap of callView.shown) {
        if (gap.removed.end <= displayedBand.start + 0.5 / fps) minStart = Math.max(minStart, gap.removed.end + pad);
        if (gap.removed.start >= displayedBand.end - 0.5 / fps) maxEnd = Math.min(maxEnd, gap.removed.start - pad);
      }
    }
    return {
      minStart: Math.min(minStart, displayedBand.start),
      maxStart: displayedBand.end,
      minEnd: displayedBand.start,
      maxEnd: Math.max(maxEnd, displayedBand.end),
    };
  }, [activeMode, pass, openCall, heard, displayedTimeline, displayedBand, passRemovals, callView, fps]);

  const commitApplied = useCallback(async (next: TimeRange) => {
    if (busy.current || !head || !focusThread || !reviewingEdit?.beforeCut || reviewingEdit.at === undefined || !appliedCut || !cutKey) return;
    busy.current = true;
    const own = reviewingEdit.beforeCut.removed;
    const deltaStart = next.start - appliedCut.start;
    const deltaEnd = next.end - appliedCut.end;
    const nextRemoved: TimeRange = {
      start: Math.max(0, own.start + deltaStart),
      end: Math.max(0, own.end + deltaEnd),
    };
    const pullsToZero = nextRemoved.end - nextRemoved.start <= 0.5 / fps;
    if (pullsToZero) onEngineLeave?.(true);
    try {
      const res = await useProjectStore.getState().adjustCut(
        focusThread.id,
        head,
        {
          changeId: reviewingEdit.changeId,
          spot: reviewingEdit.spot,
          label: reviewingEdit.label,
          range: reviewingEdit.range,
          at: reviewingEdit.at,
          before: reviewingEdit.beforeCut,
        },
        nextRemoved,
      );
      if (res.rejected) {
        recordUndo({
          kind: "revision",
          word: "Reject",
          projectId,
          version: res.version,
          threadId: focusThread.id,
          edit: { changeId: reviewingEdit.changeId, spot: reviewingEdit.spot, ...(singleEdit && { single: true }) },
          ...(cutName && { name: cutName }),
        });
        onAppliedRejected(res.version);
      } else {
        recordUndo({
          kind: "revision",
          word: "Adjust",
          projectId,
          version: res.version,
          threadId: focusThread.id,
          edit: { changeId: reviewingEdit.changeId, spot: reviewingEdit.spot, ...(singleEdit && { single: true }) },
          ...(cutName && { name: cutName }),
        });
        player.pause();
        setCutSide(prev => ({ key: cutKey, side: "after", take: (prev?.key === cutKey ? prev.take : 0) + 1 }));
      }
      appLog("action", "adjust-cut", { change: reviewingEdit.changeId, spot: reviewingEdit.spot, rejected: res.rejected });
    } catch (e) {
      if (pullsToZero) onEngineLeave?.(false);
      useUndoStore.setState({ error: { projectId, text: errorMessage(e) } });
    } finally {
      busy.current = false;
    }
  }, [head, focusThread, reviewingEdit, appliedCut, cutKey, fps, projectId, singleEdit, cutName, onEngineLeave, onAppliedRejected, setCutSide]);

  const commitEdit = useCallback(async (next: TimeRange) => {
    if (busy.current || !head || !focusThread || !reviewingEdit) return;
    busy.current = true;
    const pullsToZero = next.end - next.start <= 0.5 / fps;
    const startMoved = Math.abs(next.start - reviewingEdit.range.start) >= 0.5 / fps;
    const movedEdge = startMoved ? next.start : next.end;
    if (pullsToZero) onEngineLeave?.(true);
    try {
      const res = await useProjectStore.getState().adjustEdit(
        focusThread.id,
        head,
        {
          changeId: reviewingEdit.changeId,
          spot: reviewingEdit.spot,
          label: reviewingEdit.label,
          range: reviewingEdit.range,
          ...(reviewingEdit.kind && { kind: reviewingEdit.kind }),
        },
        next,
      );
      if (res.rejected) {
        recordUndo({
          kind: "revision",
          word: "Reject",
          projectId,
          version: res.version,
          threadId: focusThread.id,
          edit: { changeId: reviewingEdit.changeId, spot: reviewingEdit.spot, ...(singleEdit && { single: true }) },
          ...(cutName && { name: cutName }),
        });
        onAppliedRejected(res.version);
      } else {
        recordUndo({
          kind: "revision",
          word: "Adjust",
          projectId,
          version: res.version,
          threadId: focusThread.id,
          edit: { changeId: reviewingEdit.changeId, spot: reviewingEdit.spot, ...(singleEdit && { single: true }) },
          ...(cutName && { name: cutName }),
        });
        player.seek(Math.max(0, movedEdge - 1), true);
        player.play();
      }
      appLog("action", "adjust-edit", { change: reviewingEdit.changeId, spot: reviewingEdit.spot, kind: reviewingEdit.kind, rejected: res.rejected });
    } catch (e) {
      if (pullsToZero) onEngineLeave?.(false);
      useUndoStore.setState({ error: { projectId, text: errorMessage(e) } });
    } finally {
      busy.current = false;
    }
  }, [head, focusThread, reviewingEdit, fps, projectId, singleEdit, cutName, onEngineLeave, onAppliedRejected]);

  const commitCall = useCallback(async (next: TimeRange) => {
    if (busy.current || !pass || !openCall || !listening || !heard) return;
    if (next.end - next.start <= 0.5 / fps) {
      onDecideCall("keep");
      return;
    }
    busy.current = true;
    try {
      const nextWorking: TimeRange = callView
        ? { start: callView.toWorking.toMedia(next.start), end: callView.toWorking.toMedia(next.end) }
        : next;
      const version = callTimeline?.version ?? pass.fromVersion;
      const { change: revised, index: newIndex } = await useProjectStore.getState().reviseStagedCut(pass.id, openCall.index, {
        start: Math.min(nextWorking.start, nextWorking.end),
        end: Math.max(nextWorking.start, nextWorking.end),
        version,
        reason: openCall.reason,
        ...(openCall.summary && { summary: openCall.summary }),
      });
      recordUndo({
        kind: "callAdjust",
        word: "Adjust",
        projectId,
        changeId: revised.id,
        replacedId: pass.id,
        index: newIndex,
        ...(cutName && { name: cutName }),
      });
      player.pause();
      setListening(prev => ({
        changeId: revised.id,
        index: newIndex,
        cut: { start: Math.min(nextWorking.start, nextWorking.end), end: Math.max(nextWorking.start, nextWorking.end) },
        side: "after",
        take: (prev?.take ?? 0) + 1,
        key: `${revised.id}/${newIndex}`,
      }));
      appLog("action", "adjust-call", { change: revised.id, cut: newIndex, start: nextWorking.start, end: nextWorking.end });
    } catch (e) {
      useUndoStore.setState({ error: { projectId, text: errorMessage(e) } });
    } finally {
      busy.current = false;
    }
  }, [pass, openCall, listening, heard, callView, callTimeline?.version, fps, projectId, cutName, onDecideCall, setListening]);

  return useMemo<CutAdjustOptions | undefined>(() => {
    if (activeMode === "applied" && appliedBounds) {
      return {
        bounds: appliedBounds,
        tone: "cut",
        bandPrefix: "Took out",
        removeLabel: "Put back",
        describeEdge: describeCutEdge,
        onCommit: next => { void commitApplied(next); },
      };
    }
    if (activeMode === "edit" && editBounds && reviewingEdit) {
      return {
        bounds: editBounds,
        tone: "edit",
        bandPrefix: editRowWord(reviewingEdit),
        removeLabel: reviewingEdit.kind === "split" ? "Straight cut" : "Remove",
        describeEdge: describeEditEdge,
        onCommit: next => { void commitEdit(next); },
      };
    }
    if (activeMode === "call" && callBounds) {
      return {
        bounds: callBounds,
        tone: "call",
        bandPrefix: "Takes out",
        removeLabel: "Put back",
        describeEdge: describeCutEdge,
        onCommit: next => { void commitCall(next); },
      };
    }
    return undefined;
  }, [activeMode, appliedBounds, editBounds, callBounds, reviewingEdit, describeCutEdge, describeEditEdge, commitApplied, commitEdit, commitCall]);
}

export type { CutChoice };
