import { useEffect, useMemo, useRef, useState } from "react";
import { fullRenderContext, type ThreadEdit } from "@scarlet/shared";
import { cutPlaybackWindow, firstIndex, mergeRanges, CUT_LEAD_SECONDS, snapToFrame, timelineDuration, type Change, type CutAssessment, type CutReview, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { appliedCutClock, appliedCutSource } from "../../lib/appliedCutPlayback";
import { api, IS_MOCK } from "../../lib/client";
import { cutAudition, cutAuditionClock, isolatedReviewCut } from "../../lib/cutAudition";
import { besides, removedSince } from "../../lib/removedSince";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";
import { singleCutDraft, type SingleCutDrafts } from "./useCutReview";

type Version = Timeline | string;
const idOf = (version: Version) => typeof version === "string" ? version : version.version;

export interface CutToPrepare {
  key?: string;
  cut: TimeRange;
  before: Version;
  nearby?: TimeRange[];
  after?: { version: Version; removed?: TimeRange[] };
  applied?: boolean;
  single?: { changeId: string; index: number; count: number };
}

export function callToPrepare(pass: Change, call: CutAssessment, placed: TimeRange | undefined, working: Timeline | null | undefined, review?: CutReview | null,
  duration?: number, removals?: TimeRange[]): CutToPrepare | undefined {
  const revised = pass.cutEdits?.find(c => c.index === call.index);
  if (revised) return { cut: revised.range, before: revised.version,
    after: revised.previewVersion ? { version: revised.previewVersion, removed: [revised.range] } : undefined };
  if (!working || !placed || placed.end <= placed.start) return;
  const target: CutToPrepare = { cut: placed, before: working };
  if (review?.original.version === working.version && isolatedReviewCut(review, placed, cutAudition(placed, "after", duration ?? timelineDuration(working)))) {
    target.after = { version: review.proposed, removed: removals ?? review.cuts.map(c => c.removed) };
  } else if (review && call.index >= 0 && call.index < review.cuts.length) {
    target.single = { changeId: pass.id, index: call.index, count: review.cuts.length };
  }
  return target;
}

// A pass may have hundreds of applied cuts on one version. Group and merge them only once for that list.
const editNeighbors = new WeakMap<readonly ThreadEdit[], Map<string, { ranges: TimeRange[]; ends: number[] }>>();
function nearbyCuts(edits: readonly ThreadEdit[], version: string, cut: TimeRange) {
  let byVersion = editNeighbors.get(edits);
  if (!byVersion) {
    byVersion = new Map();
    for (const { beforeCut } of edits) {
      if (!beforeCut) continue;
      let entry = byVersion.get(beforeCut.version);
      if (!entry) { entry = { ranges: [], ends: [] }; byVersion.set(beforeCut.version, entry); }
      entry.ranges.push(beforeCut.removed);
    }
    for (const entry of byVersion.values()) {
      entry.ranges = mergeRanges(entry.ranges);
      entry.ends = entry.ranges.map(r => r.end);
    }
    editNeighbors.set(edits, byVersion);
  }
  const entry = byVersion.get(version);
  if (!entry) return [];
  const { ranges, ends } = entry;
  const first = firstIndex(ends, t => t > cut.start - CUT_LEAD_SECONDS);
  function* overlaps() {
    for (let i = first; i < ranges.length; i++) yield ranges[i]!;
  }
  const { skips } = cutAudition(cut, "after", Infinity, { merged: overlaps() });
  return skips.filter(r => r.start !== cut.start || r.end !== cut.end).map(({ start, end }) => ({ start, end }));
}

type AppliedAfter = NonNullable<CutToPrepare["after"]> & { version: string };

/** `afterOf` names the version After plays, when the video has changed since the cut's own save. */
export function editToPrepare(edit: ThreadEdit, change: Change | undefined, edits: readonly ThreadEdit[],
  afterOf: (made: AppliedAfter | undefined, before: string) => AppliedAfter | undefined = made => made): CutToPrepare | undefined {
  if (!edit.beforeCut) return;
  const { removed: cut, version } = edit.beforeCut;
  return { cut, before: version, nearby: nearbyCuts(edits, version, cut), applied: true, after: afterOf(change && appliedCutSource(change), version) };
}

export interface CutPlaybackWindow extends TimeRange { url: string }

export interface PreparedCut {
  key: string;
  cut: TimeRange;
  before: { version: string; timeline: Timeline; start: number; file?: string; window?: CutPlaybackWindow };
  after: { version: string; timeline: Timeline; start: number; end: number; file?: string; window?: CutPlaybackWindow; clock: NonNullable<ReturnType<typeof cutAuditionClock>> };
}

interface PreparedMedia {
  timelines: Map<string, Timeline>;
  files: Map<string, { checked: number; url?: string }>;
  windows: Map<string, CutPlaybackWindow>;
}

function remember<T>(cache: Map<string, T> | undefined, key: string, value: T) {
  if (!cache) return;
  cache.set(key, value);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
}

export async function prepareCut(projectId: string, fps: number, target: CutToPrepare, signal: AbortSignal,
  drafts?: SingleCutDrafts, onPlan?: (cut: PreparedCut) => void, media?: PreparedMedia) {
  const current = useProjectStore.getState().current;
  const read = async (version: Version) => {
    if (typeof version !== "string") return version;
    if (current?.id === projectId && current.timeline?.version === version) return current.timeline;
    const cached = media?.timelines.get(version);
    if (cached) return cached;
    const { timeline } = await api.timeline(projectId, version, signal);
    remember(media?.timelines, version, timeline);
    return timeline;
  };
  const readAfter = async () => {
    if (target.single) {
      const { changeId, index, count } = target.single;
      const { draft, range } = await singleCutDraft(changeId, index, count, idOf(target.before), signal, drafts);
      return { timeline: draft, cut: range, removed: [range] };
    }
    if (target.after) return { timeline: await read(target.after.version), cut: target.cut, removed: target.after.removed };
  };
  const [before, edited] = await Promise.all([read(target.before), readAfter().catch(() => undefined)]);
  signal.throwIfAborted();
  const cut = edited?.cut ?? target.cut;
  const duration = timelineDuration(before);
  if (cut.start >= duration || cut.end <= cut.start) return;
  // An applied cut whose After is the video as it runs now also steps over what came out since its own batch, as
  // its card does: the clock is made for that listen.
  const since = target.applied && edited && !edited.removed
    ? besides(removedSince(before, edited.timeline, fps), [cut, ...(target.nearby ?? [])], fps).map(r => r.removed) : [];
  const listen = cutAudition(cut, "after", duration, { others: since.length ? [...(target.nearby ?? []), ...since] : target.nearby });
  const after = edited?.timeline;
  const clock = edited && (target.applied ? appliedCutClock(before, edited.timeline, edited.removed, fps, cut, listen)
    : edited.removed && cutAuditionClock(before, edited.timeline, edited.removed, fps, cut, listen));
  const afterDuration = after ? snapToFrame(timelineDuration(after), fps) : 0;
  const beforeDuration = snapToFrame(duration, fps);
  let plan: PreparedCut | undefined;
  if (after && clock && target.key && onPlan) {
    const file = async (version: string) => {
      const cached = media?.files.get(version);
      if (cached && (cached.url || Date.now() - cached.checked < 5_000)) return cached.url;
      const { renders, fullRenderKeys } = await api.renders(projectId, { kind: "full", version });
      const ready = renders.find(r => r.key === fullRenderKeys?.preview && r.state === "done");
      const url = ready && api.renderFileUrl(ready.id);
      remember(media?.files, version, { url, checked: Date.now() });
      return url;
    };
    const [beforeFile, afterFile] = await Promise.all([file(before.version).catch(() => undefined), file(after.version).catch(() => undefined)]);
    signal.throwIfAborted();
    plan = { key: target.key, cut,
      before: { version: before.version, timeline: before, start: listen.start, file: beforeFile },
      after: { version: after.version, timeline: after, start: clock.toMedia(listen.start), end: clock.toMedia(listen.end), file: afterFile, clock } };
    onPlan(plan); // A first click can take the ordinary stream immediately while its short file is being rendered.
  }
  async function prepareWindow(side: "before" | "after", end: number, duration: number) {
    if (!plan || !onPlan) return false;
    const source = plan[side];
    if (source.file) return true;
    const range = cutPlaybackWindow(source.start, end, duration, fps);
    if (!range) return false;
    const key = JSON.stringify([source.version, range.start, range.end]);
    const file: Awaited<ReturnType<typeof api.cutPlaybackFile>> | undefined = media?.windows.get(key) ??
      await api.cutPlaybackFile(projectId, source.version, range, signal).catch(() => undefined);
    signal.throwIfAborted();
    if (!file?.url || !Number.isFinite(file.start) || !Number.isFinite(file.end) ||
        file.start > range.start + 1e-6 || file.end < range.end - 1e-6) return false;
    // A full preview can finish after the initial lookup. It can serve every cut on its timeline.
    if (file.full) {
      remember(media?.files, source.version, { url: file.url, checked: Date.now() });
      plan = { ...plan, [side]: { ...source, file: file.url } };
    } else {
      remember(media?.windows, key, file);
      plan = { ...plan, [side]: { ...source, window: file } };
    }
    onPlan(plan);
    return true;
  }
  // A whole file or an audible audition file serves this side directly. A long Before or an unavailable
  // encoder still warms the canonical fragments for the ordinary streaming player.
  if (after && clock && !await prepareWindow("after", clock.toMedia(listen.end), afterDuration)) {
    const join = clock.toMedia(cut.end);
    const tail = Math.min(afterDuration, clock.toMedia(listen.end)) - 1 / fps;
    const times = [clock.toMedia(listen.start), join, ...(tail > join ? [tail] : [])].filter(t => t < afterDuration);
    if (times.length) await api.preparePlayback(projectId, after.version, times, signal).catch(() => undefined);
  }
  signal.throwIfAborted();
  const original = cutAudition(cut, "before", duration, { whole: target.applied });
  if (!await prepareWindow("before", original.end, beforeDuration)) {
    const times = [original.start, cut.end, cut.start].filter(t => t < beforeDuration);
    if (times.length) await api.preparePlayback(projectId, before.version, times, signal);
  }
}

/** Prepare one decision at a time. The open decoder takes priority when playback is waiting for media. */
export function usePrepareReviewCuts(project: Project, settingsRevision: number | undefined, targets: CutToPrepare[],
  drafts: SingleCutDrafts, plans: Map<string, PreparedCut>, openCut?: { version: string; removed: TimeRange; key?: string }) {
  const context = useMemo(() => fullRenderContext(project) + "/" + (settingsRevision ?? 0), [project, settingsRevision]);
  const queue = useMemo(() => targets.map(target => ({ target, key: JSON.stringify([target.key, idOf(target.before), target.after && idOf(target.after.version),
    target.cut.start, target.cut.end, target.single, target.nearby]) })), [targets]);
  const order = useMemo(() => JSON.stringify(queue.map(entry => entry.key)), [queue]);
  const latest = useRef({ queue, openCut });
  latest.current = { queue, openCut };
  const reconcile = useRef<() => void>(undefined);
  const [parked, setParked] = useState<{ key: string; context: string; plan: PreparedCut }>();
  const [, refreshOpen] = useState(0);
  const openKey = openCut && JSON.stringify([openCut.version, openCut.removed.start, openCut.removed.end]);
  const { id, mediaPaused, settings: { fps } } = project;
  useEffect(() => {
    if (mediaPaused || IS_MOCK) return;
    let closed = false;
    let previousFirst: string | undefined;
    let running: { key: string; target: CutToPrepare; controller: AbortController } | undefined;
    let handoff: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | undefined;
    const finishHandoff = () => {
      if (!handoff) return;
      clearTimeout(handoff.timer);
      handoff.controller.abort();
      handoff = undefined;
    };
    const prepared = new Set<string>();
    // Several calls often use the same Before/After versions. Reuse those reads across their preparations.
    const media: PreparedMedia = { timelines: new Map(), files: new Map(), windows: new Map() };
    const schedule = () => {
      if (closed) return;
      const { queue, openCut } = latest.current;
      const { playing, playbackReady } = usePlayerStore.getState();
      const available = !document.hidden && (!playing || playbackReady);
      if (document.hidden) finishHandoff();
      const upcoming = queue.find(entry => !openCut?.key || entry.target.key !== openCut.key);
      const first = upcoming?.key;
      const firstCut = upcoming?.target.key;
      const plan = firstCut && plans.get(firstCut);
      if (first && first !== previousFirst && firstCut && prepared.has(first) && !plan) prepared.delete(first);
      previousFirst = first;
      if (first && plan) setParked(was => was?.plan === plan ? was : { key: first, context, plan });

      const next = available && queue.find(entry => !prepared.has(entry.key));
      if (running && (!next || next.key !== running.key)) {
        const { controller, target, key } = running;
        running = undefined;
        // The engine and source time map can disagree by a fraction of a frame on a moved call.
        const sameCut = openCut?.key && target.key ? openCut.key === target.key : openCut && idOf(target.before) === openCut.version &&
          target.cut.start === openCut.removed.start && target.cut.end === openCut.removed.end;
        // Give the foreground stream time to acquire its own owner on an in-flight render.
        if (sameCut && !document.hidden && !queue.some(entry => entry.key === key)) {
          finishHandoff();
          handoff = { controller, timer: setTimeout(finishHandoff, 750) };
        } else controller.abort();
      }
      if (!next || running) return;
      const { key, target } = next;
      const controller = new AbortController();
      running = { key, target, controller };
      void prepareCut(id, fps, target, controller.signal, drafts, plan => {
        if (controller.signal.aborted || closed || (running?.controller !== controller && handoff?.controller !== controller)) return;
        plans.set(plan.key, plan);
        // Preserve the first candidate while filling the rest of a long pass.
        if (plans.size > 8) {
          const keep = new Set(latest.current.queue.slice(0, 7).map(entry => entry.target.key));
          keep.add(latest.current.openCut?.key);
          const lowest = [...plans.keys()].find(k => !keep.has(k));
          if (lowest) plans.delete(lowest);
        }
        if (latest.current.openCut?.key === plan.key) refreshOpen(n => n + 1);
        else if (latest.current.queue.find(entry => entry.target.key !== latest.current.openCut?.key)?.key === key) setParked({ key, context, plan });
      }, media).catch(() => {}).finally(() => {
        if (running?.controller !== controller || closed) return;
        prepared.add(key);
        running = undefined;
        schedule();
      });
    };
    reconcile.current = schedule;
    // Give all of this commit's mounts a chance to settle before starting speculative work.
    queueMicrotask(schedule);
    const unsubscribe = usePlayerStore.subscribe((state, prior) => {
      if (state.playing !== prior.playing || state.playbackReady !== prior.playbackReady) schedule();
    });
    document.addEventListener("visibilitychange", schedule);
    return () => {
      closed = true;
      reconcile.current = undefined;
      running?.controller.abort();
      finishHandoff();
      unsubscribe();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [context, id, fps, drafts, plans, mediaPaused]);
  useEffect(() => { queueMicrotask(() => reconcile.current?.()); }, [order, openKey]);
  const upcoming = queue.find(entry => !openCut?.key || entry.target.key !== openCut.key);
  return !mediaPaused && parked?.context === context && parked.key === upcoming?.key ? parked.plan : undefined;
}
