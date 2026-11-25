import { useId, useRef, useState } from "react";
import { player } from "../../lib/player";
import { usePopoverDismiss } from "../../lib/uiHooks";
import { usePlayerStore } from "../../stores/player";
import { ariaKeyShortcut, formatBinding, useShortcutsStore } from "../../stores/shortcuts";
import { Icon } from "../../components/ui/primitives";

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const RATE_STEP = 0.25;

export function stepPlaybackRate(direction: -1 | 1, wrap = false) {
  const rate = usePlayerStore.getState().rate;
  let next = rate + direction * RATE_STEP;
  // L goes round: past the fastest speed it starts again from the slowest, and Shift+L the other way.
  if (wrap && next > MAX_RATE) next = MIN_RATE;
  else if (wrap && next < MIN_RATE) next = MAX_RATE;
  next = Math.min(MAX_RATE, Math.max(MIN_RATE, next));
  if (next !== rate) player.setRate(next);
}

export function PlaybackSpeed({ playable }: { playable: boolean }) {
  const rate = usePlayerStore(s => s.rate);
  const shuttleRate = usePlayerStore(s => s.shuttleRate);
  const speedDown = useShortcutsStore(s => s.bindings.speedDown);
  const speedUp = useShortcutsStore(s => s.bindings.speedUp);
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  usePopoverDismiss(open, control, trigger, () => setOpen(false));

  const shownRate = shuttleRate !== 0
    ? (shuttleRate < 0 ? `−${Math.abs(shuttleRate)}×` : `${shuttleRate}×`)
    : `${rate}×`;
  const downHint = speedDown === "Shift+L" ? "Shift L" : formatBinding(speedDown);
  const upHint = formatBinding(speedUp);

  return <div ref={control} className="playback-speed" onClick={e => {
    // A pointer adjustment hands Space back to the player. Keyboard users keep their place.
    if (e.detail > 0 && e.target instanceof Element) e.target.closest("button")?.blur();
  }}>
    <button type="button" className="btn-icon playback-speed-trigger" ref={trigger}
      aria-label={`Playback speed, ${shownRate}`} title="Playback speed" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(shown => !shown)}>{shownRate}<Icon name="down" size={10} /></button>
    {open && <div className="playback-speed-panel" id={panelId} role="group" aria-label="Playback speed" data-escape-owner>
      <button type="button" className="btn-icon" aria-label="Decrease playback speed" aria-keyshortcuts={ariaKeyShortcut(speedDown)} title={downHint ? `Decrease playback speed (${downHint})` : "Decrease playback speed"}
        disabled={!playable || rate <= MIN_RATE} onClick={() => stepPlaybackRate(-1)}>−</button>
      <output>{rate}×</output>
      <button type="button" className="btn-icon" aria-label="Increase playback speed" aria-keyshortcuts={ariaKeyShortcut(speedUp)} title={upHint ? `Increase playback speed (${upHint})` : "Increase playback speed"}
        disabled={!playable || rate >= MAX_RATE} onClick={() => stepPlaybackRate(1)}>+</button>
    </div>}
  </div>;
}
