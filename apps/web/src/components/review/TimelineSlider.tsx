import { useLayoutEffect, useRef, type ComponentProps, type RefObject } from "react";
import type { TimeRange } from "@scarlet/timeline";
import { clock, playbackClock } from "../../lib/format";
import { arrowSeekTime } from "../../lib/hotkeys";
import { usePlayerStore } from "../../stores/player";
import { timelinePosition } from "./useTimelineZoom";
import { GLIDE_FROM_SECONDS, GLIDE_FROM_SHARE, GLIDE_MS } from "./timelineMarkerLayout";

/** Only the slider value, label and playhead change on an ordinary playback tick. */
export function TimelineSlider({ playhead, start, end, from, span, width, zoomSpace, selectPosition, drag, skippedRanges, loupe, children, ...props }: ComponentProps<"div"> & {
  playhead?: number; start: number; end: number; from: number; span: number; selectPosition(time: number): void;
  width: number; zoomSpace: number;
  drag: RefObject<unknown>; skippedRanges?: TimeRange[]; loupe: boolean;
}) {
  const position = usePlayerStore(s => timelinePosition(playhead ?? s.time, start, end));
  const percent = span ? (position - from) / span * 100 : 0;
  const stamp = playbackClock(position);
  const rulerWidth = width - zoomSpace;
  const stampAnchor = rulerWidth > 0 ? Math.min(100, percent * width / rulerWidth) : percent;
  // Navigation can glide. At a cut, even a glide already in flight must land with the first frame after the join.
  const motion = useRef({ position, glideUntil: 0 });
  const previous = motion.current.position;
  const now = Date.now();
  const jump = Math.abs(position - previous) > Math.max(GLIDE_FROM_SECONDS, span * GLIDE_FROM_SHARE);
  let glideUntil = jump ? now + GLIDE_MS : motion.current.glideUntil;
  if (glideUntil > now && position !== previous) {
    const low = Math.min(previous, position), high = Math.max(previous, position);
    if (drag.current || skippedRanges?.some(range => low < range.end && range.start < high)) glideUntil = 0;
  }
  useLayoutEffect(() => { motion.current = { position, glideUntil }; }, [position, glideUntil]);
  const gliding = glideUntil > now;
  return <div {...props} role="slider" aria-valuemin={start} aria-valuemax={end} aria-valuenow={position} aria-valuetext={stamp}
    onKeyDown={e => {
      // With ⌘, Ctrl or Alt held the key isn't the timeline's, as it isn't the page's.
      if (end <= start || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        selectPosition(arrowSeekTime(position, e.key, e.shiftKey));
        return;
      }
      const target = { Home: start, End: end, PageDown: position + span, PageUp: position - span }[e.key];
      if (target === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      selectPosition(target);
    }}>
    {children}
    {position >= from && position <= from + span && <>
      {!loupe && <span aria-hidden="true" className={gliding ? "timeline-playhead-time is-gliding" : "timeline-playhead-time"}
        style={{ left: `min(${percent}%, calc(100% - ${zoomSpace}px))`, transform: `translateX(-${stampAnchor}%)` }}>{stamp}</span>}
      <div aria-hidden="true" className={gliding ? "timeline-playhead is-gliding" : "timeline-playhead"} style={{ left: `${percent}%` }} />
    </>}
  </div>;
}

/** Where the playhead is, out of the video's length. Only this re-renders on a playback tick. */
export function TimelineClock({ playhead, start, end, total }: { playhead?: number; start: number; end: number; total: number }) {
  const position = usePlayerStore(s => timelinePosition(playhead ?? s.time, start, end));
  return <span className="timeline-clock" aria-label="Playhead time">{clock(Math.floor(position - start))} <span>/ {clock(Math.floor(total))}</span></span>;
}
