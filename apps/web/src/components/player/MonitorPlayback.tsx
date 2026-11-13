import type { ReactNode, Ref } from "react";
import { clock, playbackClock } from "../../lib/format";
import { usePlayerStore } from "../../stores/player";
import { Icon, Spinner } from "../ui/primitives";

export function PlaybackTime({ time, end, loop }: { time: number; end: number; loop?: boolean }) {
  return <>{loop && "Loop · "}<strong>{playbackClock(time)}</strong> / {playbackClock(end)}</>;
}

/** `coarse` shows whole seconds (1:05 / 3:20); the timeline still gives the exact time where the pointer is. */
export function PlayerTime({ end, coarse = false }: { end: number; coarse?: boolean }) {
  const time = usePlayerStore(s => coarse ? Math.floor(s.time + 1e-6) : s.time);
  if (coarse) return <><strong>{clock(time)}</strong> / {clock(end)}</>;
  return <PlaybackTime time={time} end={end} />;
}

/**
 * `loading`: the picture isn't in yet. The button turns in place of its icon, and still plays and pauses. It is the one
 * sign that the picture loads, so the controls are marked to stay on screen meanwhile, wherever the pointer is.
 */
export function MonitorPlayback({ playing, playable, loading = false, playLabel = "Play", onToggle, clockRef, controls, children }: {
  playing: boolean; playable: boolean; loading?: boolean; playLabel?: string; onToggle(): void; clockRef?: Ref<HTMLSpanElement>; controls?: ReactNode; children?: ReactNode;
}) {
  return <div className="monitor-playback" data-loading={loading || undefined}>
    <button type="button" className="btn-icon" aria-label={playing ? "Pause" : playLabel} title={playing ? "Pause" : playLabel} disabled={!playable} onClick={onToggle}>
      {loading ? <Spinner /> : <Icon name={playing ? "pause" : "play"} size={15} />}
    </button>
    {loading && <span role="status" className="sr-only">Loading this moment…</span>}
    <span ref={clockRef} className="monitor-clock">{children}</span>
    {controls}
  </div>;
}
