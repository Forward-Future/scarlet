import { useCallback, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from "react";
import { namedTimelineEdits, type ThreadEdit } from "@scarlet/shared";
import { appliedReviewChange, makeTimeMap, timelineDuration, withHandles, type Change, type TimeRange, type Timeline } from "@scarlet/timeline";
import { usePlayerStore } from "../../stores/player";
import { ChangeClip, type ComparisonPanePlayback } from "./ChangeClip";
import { useReviewTimeline } from "./useReviewTimeline";

/** A replacement shot can have no source frames in common with its predecessor. */
function savedBeforeRange(change: Change, edit: ThreadEdit, version: string) {
  const saved = appliedReviewChange(change);
  if (saved.fromVersion !== version) return;
  const spot = (edit.previous[0] ?? edit).spot;
  const named = namedTimelineEdits(change)?.[spot];
  if (!named) return saved.renders[spot]?.beforeRange;
  if (saved.toVersion !== change.toVersion) return;
  // Named edit indices and render slots are independent. Match their saved ranges.
  const slot = saved.ranges.findIndex(r => r.start === named.range.start && r.end === named.range.end);
  return saved.renders[slot]?.beforeRange;
}

export function useEditBefore(projectId: string, working: Timeline | null | undefined, edit: ThreadEdit | undefined,
  change: Change | undefined, fps: number, framing: boolean) {
  const version = edit?.beforeCut?.version ?? change?.appliedOnto ?? change?.fromVersion;
  const original = useReviewTimeline(projectId, version, working);
  const source = original.timeline;
  const duration = useMemo(() => source && timelineDuration(source), [source]);
  const map = useMemo(() => source && working && !edit?.beforeCut ? makeTimeMap(working, source, fps) : undefined,
    [source, working, edit?.beforeCut, fps]);
  const range = useMemo(() => {
    if (!duration || !edit || !change || !version || framing) return;
    if (edit.beforeCut) return withHandles(edit.beforeCut.removed, 1.5, duration);
    const start = map?.(edit.range.start, "right");
    const end = map?.(edit.range.end, "left");
    if (start != null && end != null && start >= 0 && start < end && end <= duration + 1e-6) return { start, end: Math.min(end, duration) };
    const saved = savedBeforeRange(change, edit, version);
    if (saved && saved.start < Math.min(saved.end, duration)) return { start: saved.start, end: Math.min(saved.end, duration) };
  }, [duration, edit, change, version, framing, map]);
  const unavailable = !version ? "No earlier version is available." : duration === 0 ? "The timeline was empty before this edit."
    : source && !framing && !range ? "No matching passage in the earlier version." : undefined;
  return { ...original, duration, map, range, unavailable };
}

export interface BeforePlayback {
  /**
   * Move the Before clip to this time on the page's timeline. False when there is nothing of Before to show there:
   * the time is outside the edit's passage, or the clip hasn't opened.
   */
  seek(time: number): boolean;
  /**
   * Pause the clip for a drag on the page's timeline. `carryOn` goes on as it was, once the drag ends. `playing` says
   * whether that is playing: a clip that played to its end and stopped there was still being played. A drag that
   * ends outside the passage goes on the same way on After.
   */
  scrub(): { playing: boolean; carryOn(): void } | undefined;
  /** Whether the clip is playing, or will be as soon as its section is in. */
  playing(): boolean;
  pause(): void;
}

/**
 * A separate media clock keeps the project ruler and follow-ups anchored to the selected edit. The page's playhead goes
 * with the clip across the edit's `passage`, so the timeline and the clock read as they do on After: second for second
 * when the edit moved nothing, in proportion when the passage ran longer or shorter before it.
 */
export function EditBeforePreview({ change, original, passage, active, aspect, loading, clock, playbackRef }: {
  change: Change; original: ReturnType<typeof useEditBefore>; passage: TimeRange; active: boolean; aspect: number; loading?: boolean;
  clock?: ReactNode; playbackRef?: Ref<BeforePlayback>;
}) {
  const clip = useRef<ComparisonPanePlayback>(null);
  const range = original.range;
  const scale = range && range.end > range.start ? (passage.end - passage.start) / (range.end - range.start) : 1;
  const follow = useCallback((elapsed: number) => usePlayerStore.getState().setTime(Math.min(passage.end, passage.start + elapsed * scale)),
    [passage.start, passage.end, scale]);
  useImperativeHandle(playbackRef, () => ({
    seek(time) {
      if (!clip.current || time < passage.start || time > passage.end) return false;
      clip.current.seek(scale > 0 ? (time - passage.start) / scale : 0);
      return true;
    },
    scrub: () => clip.current?.scrub(),
    playing: () => !!clip.current?.position().playing,
    pause: () => clip.current?.pause(),
  }), [passage.start, passage.end, scale]);
  if (!original.timeline || !range) return <div className="absolute inset-0 grid place-content-center bg-black text-sm text-muted" role="status">
    {original.error ? <button className="btn-quiet" onClick={original.retry}>Retry Before</button> : "Opening Before…"}
  </div>;
  return <ChangeClip change={change} active={active} aspect={aspect} inMonitor loading={loading} clock={clock} previewTimeline={original.timeline}
    playbackRef={clip} onElapsed={follow}
    audition={{ ...range, at: range.start, description: change.description, beforeVersion: original.timeline.version }} />;
}
