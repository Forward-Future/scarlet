import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { snapToFrame } from "@scarlet/timeline";
import { clock, parsePlaybackClock, playbackClock } from "../../lib/format";
import { isComposing, useHotkeys } from "../../lib/hotkeys";
import { usePlayerStore } from "../../stores/player";
import { Icon, Spinner } from "../ui/primitives";

export function PlaybackTime({ time, end }: { time: number; end: number }) {
  return <><strong>{playbackClock(time)}</strong> / {playbackClock(end)}</>;
}

/** Where a typed time on this clock should seek, and whether this player may open the jump field. */
export type ClockJump = {
  fps: number;
  playable: boolean;
  active: boolean;
  onSeek(time: number): void;
};

function JumpClock({ end, coarse, jump, time }: { end: number; coarse: boolean; jump: ClockJump; time: number }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const canOpen = jump.active && jump.playable && end > 0;
  if (open && !canOpen) {
    setOpen(false);
    setError("");
  }
  const showField = open && canOpen;
  const shown = end > 0 ? Math.min(time, end) : time;
  const shownClock = coarse ? clock(shown) : playbackClock(shown);
  const endClock = coarse ? clock(end) : playbackClock(end);
  const bound = `Enter a time between 0:00 and ${endClock}.`;

  function close() {
    setOpen(false);
    setError("");
    field.current?.blur();
  }

  function openJump() {
    const at = usePlayerStore.getState().time;
    setValue(playbackClock(end > 0 ? Math.min(at, end) : at));
    setError("");
    setOpen(true);
  }

  function submit() {
    const parsed = parsePlaybackClock(value);
    // Half a millisecond covers the clock's own rounding, so the pre-filled end still takes.
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > end + 5e-4) {
      setError(bound);
      return;
    }
    jump.onSeek(snapToFrame(parsed, jump.fps));
    close();
  }

  useHotkeys(e => {
    if (e.shiftKey || isComposing(e)) return;
    if (showField && e.key === "Escape") {
      e.preventDefault();
      if (!e.repeat) close();
      return;
    }
    if (!canOpen || e.key.toLowerCase() !== "g") return;
    e.preventDefault();
    if (e.repeat) return;
    if (showField) close();
    else openJump();
  });

  useLayoutEffect(() => {
    if (!showField) return;
    field.current?.focus();
    field.current?.select();
  }, [showField]);

  const readout = coarse ? <><strong>{clock(shown)}</strong> / {clock(end)}</> : <PlaybackTime time={shown} end={end} />;
  if (!jump.active) return readout;
  if (showField) {
    return <>
      <input ref={field} className="monitor-jump-field tnum" value={value} aria-label="Jump to a time" aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined} spellCheck={false} autoComplete="off"
        onChange={e => { setValue(e.target.value); setError(""); }}
        onBlur={close}
        onKeyDown={e => {
          if (isComposing(e)) return;
          if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) submit(); }
          else if (e.key === "Escape") { e.preventDefault(); close(); }
          else if (e.key.toLowerCase() === "g" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            close();
          }
        }} />
      {` / ${endClock}`}
      {error && <span id={errorId} role="alert" className="monitor-jump-error">{error}</span>}
    </>;
  }
  return <button type="button" className="monitor-jump" aria-label={`Jump to a time, ${shownClock} of ${endClock}`}
    title="Jump to a time" disabled={!canOpen} onClick={() => { if (canOpen) openJump(); }}>{readout}</button>;
}

/** `coarse` shows whole seconds (1:05 / 3:20); the timeline still gives the exact time where the pointer is. */
export function PlayerTime({ end, coarse = false, jump }: { end: number; coarse?: boolean; jump?: ClockJump }) {
  const time = usePlayerStore(s => {
    const at = end > 0 ? Math.min(s.time, end) : s.time;
    return coarse ? Math.floor(at + 1e-6) : at;
  });
  if (jump) return <JumpClock end={end} coarse={coarse} jump={jump} time={time} />;
  if (coarse) return <><strong>{clock(time)}</strong> / {clock(end)}</>;
  return <PlaybackTime time={time} end={end} />;
}

/**
 * `loading`: the picture isn't in yet. The button turns in place of its icon, and still plays and pauses. It is the one
 * sign that the picture loads, so the controls are marked to stay on screen meanwhile, wherever the pointer is.
 */
export function MonitorPlayback({ playing, playable, loading = false, playLabel = "Play", onToggle, children }: {
  playing: boolean; playable: boolean; loading?: boolean; playLabel?: string; onToggle(): void; children?: ReactNode;
}) {
  return <div className="monitor-playback" data-loading={loading || undefined}>
    <button type="button" className="btn-icon" aria-label={playing ? "Pause" : playLabel} title={playing ? "Pause" : playLabel} disabled={!playable} onClick={onToggle}>
      {loading ? <Spinner /> : <Icon name={playing ? "pause" : "play"} size={15} />}
    </button>
    {loading && <span role="status" className="sr-only">Loading this moment…</span>}
    <span className="monitor-clock">{children}</span>
  </div>;
}
