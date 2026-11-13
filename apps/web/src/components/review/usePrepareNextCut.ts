import { useEffect, useRef } from "react";
import { changeRemovals, type ThreadEdit } from "@scarlet/shared";
import { snapToFrame, timelineDuration, type Change, type CutAssessment, type CutReview, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { api, IS_MOCK } from "../../lib/client";
import { cutAudition, cutAuditionClock, isolatedReviewCut } from "../../lib/cutAudition";
import { usePlayerStore } from "../../stores/player";
import { useProjectStore } from "../../stores/project";

type Version = Timeline | string;
const idOf = (version: Version) => typeof version === "string" ? version : version.version;

interface CutToPrepare {
  cut: TimeRange;
  before: Version;
  nearby?: TimeRange[];
  after?: { version: Version; removed: TimeRange[] };
}

export function callToPrepare(pass: Change, call: CutAssessment, placed: TimeRange | undefined, working: Timeline | null | undefined, review?: CutReview | null): CutToPrepare | undefined {
  const revised = pass.cutEdits?.find(c => c.index === call.index);
  if (revised) return { cut: revised.range, before: revised.version,
    after: revised.previewVersion ? { version: revised.previewVersion, removed: [revised.range] } : undefined };
  if (!working || !placed || placed.end <= placed.start) return;
  const target: CutToPrepare = { cut: placed, before: working };
  if (review?.original.version === working.version && isolatedReviewCut(review, placed, cutAudition(placed, "after", timelineDuration(working)))) {
    target.after = { version: review.proposed, removed: review.cuts.map(c => c.removed) };
  }
  return target;
}

export function editToPrepare(edit: ThreadEdit, change: Change | undefined, edits: readonly ThreadEdit[]): CutToPrepare | undefined {
  if (!edit.beforeCut || !edit.check) return;
  const { removed: cut, version } = edit.beforeCut;
  const others = edits.flatMap(e => e !== edit && e.beforeCut?.version === version ? [e.beforeCut.removed] : []);
  const { start, end } = cutAudition(cut, "after", Infinity, { others });
  return { cut, before: version, nearby: others.filter(r => r.end > start && r.start < end), after: change && changeRemovals(change) };
}

export async function prepareCut(projectId: string, fps: number, target: CutToPrepare, signal: AbortSignal) {
  const current = useProjectStore.getState().current;
  const read = async (version: Version) => {
    if (typeof version !== "string") return version;
    if (current?.id === projectId && current.timeline?.version === version) return current.timeline;
    return (await api.timeline(projectId, version, signal)).timeline;
  };
  const [before, after] = await Promise.all([read(target.before), target.after && read(target.after.version).catch(() => undefined)]);
  signal.throwIfAborted();
  const { cut } = target;
  const duration = timelineDuration(before);
  if (cut.start >= duration || cut.end <= cut.start) return;
  const listen = cutAudition(cut, "after", duration, { others: target.nearby });
  const clock = after && target.after && cutAuditionClock(before, after, target.after.removed, fps, cut, listen);
  // Opening a cut plays After first. If the join isn't in that file, the player skips over it in Before.
  if (after && clock) {
    const afterDuration = snapToFrame(timelineDuration(after), fps);
    const times = [clock.toMedia(listen.start), clock.toMedia(cut.end)].filter(t => t < afterDuration);
    if (times.length) await api.preparePlayback(projectId, after.version, times, signal).catch(() => undefined);
  }
  signal.throwIfAborted();
  const beforeDuration = snapToFrame(duration, fps);
  const times = [listen.start, cut.end, cut.start].filter(t => t < beforeDuration);
  if (times.length) await api.preparePlayback(projectId, before.version, times, signal);
}

/** Only the next decision in an open review gets a head start. Preparing never moves the player. */
export function usePrepareNextCut(project: Project, settingsRevision: number | undefined, target?: CutToPrepare, openCut?: ThreadEdit["beforeCut"]) {
  const latest = useRef(target);
  latest.current = target;
  const open = useRef({ projectId: project.id, cut: openCut, paused: project.mediaPaused });
  open.current = { projectId: project.id, cut: openCut, paused: project.mediaPaused };
  const before = target && idOf(target.before);
  const after = target?.after && idOf(target.after.version);
  const nearby = JSON.stringify(target?.nearby);
  const { id, mediaPaused, settings } = project;
  useEffect(() => {
    const next = latest.current;
    if (!next || mediaPaused || IS_MOCK) return;
    let request: AbortController | undefined;
    let delay: ReturnType<typeof setTimeout> | undefined;
    let completed = false;
    const schedule = () => {
      clearTimeout(delay);
      const { playing, playbackReady } = usePlayerStore.getState();
      if (document.hidden || (playing && !playbackReady)) {
        // A cold Play, a seek or a stall belongs to the current cut until its media can advance.
        request?.abort();
        request = undefined;
      } else if (!completed && !request && playing && playbackReady) {
        delay = setTimeout(() => {
          const controller = new AbortController();
          request = controller;
          // Playback will request anything still missing if preparation fails or the user goes elsewhere.
          void prepareCut(id, settings.fps, next, controller.signal).catch(() => undefined).finally(() => {
            if (request === controller) completed = true;
          });
        }, 200);
      }
    };
    schedule();
    const unsubscribe = usePlayerStore.subscribe((state, prior) => {
      if (state.playing !== prior.playing || state.playbackReady !== prior.playbackReady) schedule();
    });
    document.addEventListener("visibilitychange", schedule);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", schedule);
      clearTimeout(delay);
      const controller = request;
      if (!controller) return;
      const card = open.current.cut;
      const handoff = card && !document.hidden && !open.current.paused && open.current.projectId === id
        && card.version === before && card.removed.start === next.cut.start && card.removed.end === next.cut.end;
      // Let the player acquire its own render owner when the editor opens this cut mid-encode.
      if (handoff) setTimeout(() => controller.abort(), 750);
      else controller.abort();
    };
  }, [id, mediaPaused, settings.fps, settings.width, settings.height, settingsRevision, before, after, target?.cut.start, target?.cut.end, nearby]);
}
