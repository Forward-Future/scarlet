import type { TimeRange } from "@scarlet/timeline";
import { usePlayerStore } from "../../stores/player";
import { playbackClock } from "../../lib/format";

const label = (t: number) => playbackClock(t).replace(/\.\d+$/, "");

export interface ProgressFocus {
  /** The stretch of the video the line zooms to. */
  view: TimeRange;
  /** What the change touches: removed footage, or the edited passage. */
  band?: TimeRange;
  bandLabel?: string;
  /**
   * Removed footage is hatched red (the default). `kept`: the footage stays in the edit (a sound fix, a zoom, a title), so After
   * plays it and it’s only outlined. `added`: footage an edit put back.
   */
  tone?: "kept" | "added";
}

/** Above this share of the video a band says nothing about where the change is, so the line stays whole. */
const MOST_OF_THE_VIDEO = 0.8;

/** The context to show around a change: enough to see what comes before and after it. */
export function focusAround(range: TimeRange, duration: number, bandLabel?: string,
  { tone, playbackEnd }: { tone?: ProgressFocus["tone"]; playbackEnd?: number } = {}): ProgressFocus | undefined {
  if (duration > 0 && range.end - range.start >= duration * MOST_OF_THE_VIDEO) return undefined;
  // Center the band with room past the last played frame, including any neighboring cuts the audition skips.
  const pad = Math.max(5, (range.end - range.start) * 0.15, (playbackEnd ?? range.end) - range.end + 2);
  return {
    view: { start: Math.max(0, range.start - pad), end: Math.min(duration || range.end + pad, range.end + pad) },
    band: range, bandLabel, tone,
  };
}

/**
 * A thin line for the simple workspace. With no focus it spans the whole video and marks each change.
 * With a focus it zooms to that change and shades what it touches. Click to seek.
 */
export function SimpleProgress({ duration, marks, selected, focus, onSeek }: {
  duration: number; marks: number[]; selected?: number; focus?: ProgressFocus; onSeek(time: number): void;
}) {
  const time = usePlayerStore(s => s.time);
  if (!duration) return null;
  const view = focus && focus.view.end > focus.view.start ? focus.view : { start: 0, end: duration };
  const span = view.end - view.start;
  const x = (t: number) => (t - view.start) / span * 100;
  const at = (t: number) => `${Math.max(0, Math.min(100, x(t)))}%`;
  const inView = (t: number) => t >= view.start && t <= view.end;
  const band = focus?.band;
  return <div className={focus ? "simple-progress is-focused" : "simple-progress"} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={duration}
    aria-valuenow={time} aria-valuetext={label(time)} tabIndex={-1}
    onPointerDown={e => {
      const box = e.currentTarget.getBoundingClientRect();
      onSeek(Math.max(0, Math.min(duration, view.start + (e.clientX - box.left) / box.width * span)));
    }}>
    <span className="simple-progress-line" />
    {!focus && <span className="simple-progress-done" style={{ width: at(time) }} />}
    {band && (band.end > band.start
      ? <span className={focus?.tone ? `simple-progress-band is-${focus.tone}` : "simple-progress-band"} style={{ left: at(band.start), width: `calc(${at(band.end)} - ${at(band.start)})` }}>
          {focus?.bandLabel && <span>{focus.bandLabel}</span>}</span>
      : <span className="simple-progress-cut" style={{ left: at(band.start) }}>
          {focus?.bandLabel && <span>{focus.bandLabel}</span>}</span>)}
    {!focus && [...new Set(marks)].filter(inView).map(t => <i key={t} className={t === selected ? "simple-progress-mark is-on" : "simple-progress-mark"} style={{ left: at(t) }} />)}
    {inView(time) && <span className="simple-progress-head" style={{ left: at(time) }} />}
    <span className="simple-progress-time">{label(view.start)}</span>
    {focus && <span className="simple-progress-now">{label(time)}</span>}
    <span className="simple-progress-total">{label(view.end)}</span>
  </div>;
}
