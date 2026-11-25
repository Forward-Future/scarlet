import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { makeTimeMap, mapStagedCut, timelineDuration, type Change, type TimeRange, type Timeline } from "@scarlet/timeline";
import type { Task, ThreadEdit } from "@scarlet/shared";
import { useThreadEdits } from "../../components/review/threadEditState";
import { usePlaybackCache } from "../../components/player/usePlaybackCache";
import { focusAround } from "../../components/player/SimpleProgress";
import { useCutReview, useSingleCutDraft, type SingleCutDrafts } from "../../components/review/useCutReview";
import type { PreparedCut } from "../../components/review/usePrepareNextCut";
import { useReviewTimeline } from "../../components/review/useReviewTimeline";
import type { useThreadTimeline } from "../../components/review/useThreadTimeline";
import type { TimelineGap } from "../../components/review/TimelineScrubber";
import { lengthLabel } from "../../lib/format";
import { player, type Audition } from "../../lib/player";
import { cutChange } from "../../lib/appliedCutPlayback";
import { cutAudition, cutAuditionClock, isolatedReviewCut } from "../../lib/cutAudition";
import { removedSince } from "../../lib/removedSince";
import { composeClocks, verifiedJoinClock } from "../../lib/joinClock";
import type { Thread } from "../../lib/threads";
import { cutOnWorkingCut, type Call } from "../../lib/passCalls";
import type { ShownCut } from "../../stores/shownCut";
import type { ProjectData } from "../../stores/project";
import { usePlayerStore } from "../../stores/player";
import { afterPlayerMount, type JoinedListen, type Listening, type Side } from "./types";

/** A revision of one call that is still at work: the call as the editor sent it back, and where it sits in the pass now. */
interface RevisionInput { call: Call; index: number; previous: Change }

/**
 * A pass's cuts, staged on `stagedOn`, placed on `shownOn` by their footage. One that can't be placed there is
 * undefined, and so is each one when the version they were staged on isn't known.
 */
export function cutsOnVersion(cuts: readonly TimeRange[], stagedOn: Timeline | undefined, shownOn: Timeline, fps: number): (TimeRange | undefined)[] {
  if (!stagedOn) return cuts.map(() => undefined);
  if (stagedOn.version === shownOn.version) return [...cuts];
  const onto = { map: makeTimeMap(stagedOn, shownOn, fps), timeline: shownOn };
  return cuts.map(cut => cutOnWorkingCut(cut, onto, fps));
}

interface CallListenInputs {
  current: Pick<ProjectData, "id" | "project" | "renderSettingsRevision">;
  pass: Change | undefined;
  passThread: Thread | undefined;
  revisionInput: RevisionInput | undefined;
  listening: Listening | undefined;
  setListening: Dispatch<SetStateAction<Listening | undefined>>;
  cutReview: ReturnType<typeof useCutReview>;
  cutRuns: ReadonlyMap<number, Task>;
  head: ShownCut["head"];
  timeline: ShownCut["timeline"];
  fps: number;
  focusThread: Thread | undefined;
  threadTimeline: ReturnType<typeof useThreadTimeline>;
  draftCache: SingleCutDrafts;
  preparedCandidates: ReadonlyMap<string, PreparedCut>;
  /** Set when Scarlet opens the call by itself at launch: its listen then starts paused. */
  quietOpen: RefObject<boolean>;
}

/**
 * The call open on the card, and how it plays: where its cut sits on the working cut, the versions its Before and
 * After play, the join After plays through, and the listen the editor started on it.
 */
export function useCallListen({ current, pass, passThread, revisionInput, listening, setListening, cutReview, cutRuns, head, timeline, fps,
  focusThread, threadTimeline, draftCache, preparedCandidates, quietOpen }: CallListenInputs) {
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
  // The pass's other cuts where the open call's cut is, so its edges stop short of them: on the working cut as the call
  // is placed, or on the version a changed call is heard on.
  const callSiblings = useMemo(() => {
    if (!passRemovals) return;
    if (!versionBefore) return passRemovals.map(r => placeCut(r));
    if (!callTimeline) return passRemovals.map(() => undefined);
    const staged = stagedOn.timeline ?? (liveReview && liveReview.original.version === pass?.fromVersion ? liveReview.original : undefined);
    return cutsOnVersion(passRemovals, staged, callTimeline, fps);
  }, [passRemovals, versionBefore, callTimeline, stagedOn.timeline, liveReview, pass?.fromVersion, toWorkingCut, placing, fps]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const { listed: listedPassEdits, rejected: rejectedPassEdits, located: locatedPassEdits } = useThreadEdits(current.id, passThread);
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
    const focus = focusAround(cut, duration, `Takes out · ${lengthLabel(heard.end - heard.start)}`, { playbackEnd: after.end });
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
  return {
    returningCall, review, liveReview, passRemovals, listenRemovals, callSiblings, stagedOn, toWorkingCut, placing, placeCut, placed,
    overrideForCall, cutOverride, rechecking, conflict, answeringCut, versionBefore, callPlaybackKey, beforeVersion, preparedCall, savedBefore,
    callTimeline, callDuration, pinnedCallVersion, versionAfter, savedAfter, needsSingleCut, single, heard, audition, listenJoined,
    listedPassEdits, rejectedPassEdits, locatedPassEdits, callView, visit, viewAudition, viewJoined, playedAudition, callViewNow,
    listenCache, openingJoin, listenSide, hearGapInCall, listenFrom,
  };
}
