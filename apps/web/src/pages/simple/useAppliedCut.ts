import { useLayoutEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { timelineDuration, type TimeRange } from "@scarlet/timeline";
import type { ThreadEdit } from "@scarlet/shared";
import { usePlaybackCache } from "../../components/player/usePlaybackCache";
import type { PreparedCut } from "../../components/review/usePrepareNextCut";
import { useReviewTimeline } from "../../components/review/useReviewTimeline";
import type { useThreadTimeline } from "../../components/review/useThreadTimeline";
import { clock as clockLabel } from "../../lib/format";
import { player } from "../../lib/player";
import { appliedCutClock, appliedCutSource, cutChange } from "../../lib/appliedCutPlayback";
import { cutAudition } from "../../lib/cutAudition";
import { besides, removedSince } from "../../lib/removedSince";
import { rebaseCut } from "../../lib/cutViewBase";
import type { Thread } from "../../lib/threads";
import type { ShownCut } from "../../stores/shownCut";
import type { ProjectData } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { afterPlayerMount, firstKey, type Side } from "./types";

/** The side of an applied cut the editor chose, and where its listen starts (see `useAppliedCut`). */
export interface CutSide { key: string; side: Side; take: number; at?: number; picked?: boolean; visit?: { at: string; start: number; end: number } }

/** The version an applied cut's After plays, and the removals saved with it. */
interface AfterSource { version: string; removed?: TimeRange[] }

interface AppliedCutInputs {
  current: Pick<ProjectData, "id" | "project" | "renderSettingsRevision">;
  reviewingEdit: ThreadEdit | undefined;
  focusThread: Thread | undefined;
  threadTimeline: ReturnType<typeof useThreadTimeline>;
  threadEdits: readonly ThreadEdit[];
  head: ShownCut["head"];
  timeline: ShownCut["timeline"];
  fps: number;
  cutSide: CutSide | undefined;
  setCutSide: Dispatch<SetStateAction<CutSide | undefined>>;
  preparedCandidates: ReadonlyMap<string, PreparedCut>;
  afterOf: (made: AfterSource | undefined, before: string | undefined) => AfterSource | undefined;
  editPlaybackKey: (edit: ThreadEdit, after?: string, base?: string) => string;
  viewBaseOf: (edit: ThreadEdit, thread: Thread | undefined, edits: readonly ThreadEdit[]) => string | undefined;
  /** Set when Scarlet opens the edit by itself at launch: its listen then starts paused. */
  quietOpen: RefObject<boolean>;
}

/**
 * The applied cut open on the card, and how it plays: the version before it it opens on, the version its After
 * plays, the pass's other cuts around it, and the listen the editor started on it.
 */
export function useAppliedCut({ current, reviewingEdit, focusThread, threadTimeline, threadEdits, head, timeline, fps, cutSide, setCutSide,
  preparedCandidates, afterOf, editPlaybackKey, viewBaseOf, quietOpen }: AppliedCutInputs) {
  // An applied cut is gone from the working cut, so it plays on the version before it, where the timeline shades
  // what came out. After steps over it, as the video plays now; Before plays through it. When an earlier batch made a
  // cut round it, that's the version before the earliest of them, so every cut round it shows (`cutViewBase`).
  const ownCut = reviewingEdit?.beforeCut;
  const cutBase = useMemo(() => reviewingEdit && viewBaseOf(reviewingEdit, focusThread, threadEdits),
    [reviewingEdit, focusThread, threadEdits, head]); // eslint-disable-line react-hooks/exhaustive-deps
  const madeBy = useMemo(() => {
    const change = reviewingEdit?.beforeCut && focusThread && cutChange(reviewingEdit, focusThread.changes);
    return change && appliedCutSource(change);
  }, [reviewingEdit, focusThread]);
  // After plays the version the cut made. Once later batches, revisions or other requests have changed the video
  // since, it plays the video as it runs now, which has this cut's join and theirs: the same version for the card,
  // for the file and window prepared ahead of it, and for the clock that maps it onto this timeline.
  const latestAfter = useMemo(() => afterOf(madeBy, ownCut?.version), [madeBy, ownCut?.version, head]); // eslint-disable-line react-hooks/exhaustive-deps
  // While the cut plays, After stays on the version it started on. A pass applying its next cuts moves the video on
  // every moment, and following it put up a new player each time, before the last had played a frame: nothing
  // played. Once the editor pauses, or the cut changes or another opens, it takes up the video as it runs now.
  const playingNow = usePlayerStore(s => s.playing);
  const heldAfter = useRef<{ key?: string; source?: typeof latestAfter }>(undefined);
  const afterKey = reviewingEdit && editPlaybackKey(reviewingEdit, undefined, cutBase);
  // A cut the editor just rejected holds it too, for the moment it takes to leave the timeline: the video without it
  // lands meanwhile, and its card would start on a version it isn't in.
  const afterSource = (playingNow || threadTimeline.leaving) && latestAfter && heldAfter.current?.source && heldAfter.current.key === afterKey
    ? heldAfter.current.source : latestAfter;
  heldAfter.current = { key: afterKey, source: afterSource };
  const holdingAfter = afterSource !== latestAfter;
  const appliedAfterVersion = afterSource?.version;
  const preparedEdit = reviewingEdit ? preparedCandidates.get(editPlaybackKey(reviewingEdit, appliedAfterVersion, cutBase)) : undefined;
  // The cut's footage on that earlier version. Until both versions are in, nothing plays, so the card doesn't start on
  // its own version and change players; one that can't be placed there stays on its own.
  const ownBefore = useReviewTimeline(current.id, cutBase && ownCut?.version, timeline);
  const baseBefore = useReviewTimeline(current.id, cutBase, preparedEdit?.before.timeline ?? timeline);
  const rebasedCut = useMemo(() => cutBase && ownCut && ownBefore.timeline && baseBefore.timeline
    ? rebaseCut(ownBefore.timeline, baseBefore.timeline, ownCut.removed, fps) : undefined,
  [cutBase, ownCut, ownBefore.timeline, baseBefore.timeline, fps]);
  const rebasing = !!cutBase && !!ownCut && !rebasedCut && !ownBefore.error && !baseBefore.error && !(ownBefore.timeline && baseBefore.timeline);
  const beforeCut = useMemo(() => ownCut && rebasedCut ? { version: cutBase!, removed: rebasedCut } : ownCut, [ownCut, rebasedCut, cutBase]);
  const cutBefore = useReviewTimeline(current.id, rebasing ? undefined : beforeCut?.version,
    rebasedCut ? baseBefore.timeline : preparedEdit?.before.timeline ?? timeline);
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
    // The removals saved with the cut's change are in its own version's clock, not the earlier one it opens on.
    const clock = appliedCutClock(beforeTimeline, afterTimeline, rebasedCut ? undefined : afterSource.removed, fps, appliedCut, appliedListen);
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
  return {
    cutBase, madeBy, afterSource, appliedAfterVersion, preparedEdit, rebasedCut, beforeCut, cutBefore, beforeTimeline, beforeDuration,
    cutKey, appliedCut, shownSide, appliedSide, visiting, afterTimeline, otherEdits, otherCuts, afterListen, appliedListen, appliedJoined,
    appliedCache, preparedAfter, joinPending, cutLoadError, heardPick, chooseCutSide,
  };
}
