import { useId, useRef, useState } from "react";
import { player } from "../../lib/player";
import { usePopoverDismiss } from "../../lib/uiHooks";
import { SPEED_UP_RATES, usePlayerStore, type SpeedUpRate } from "../../stores/player";
import { PreferenceSelect } from "../../components/ui/PreferenceSelect";
import { Icon, Kbd } from "../../components/ui/primitives";

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const RATE_STEP = 0.25;

export const SPEED_UP_OPTIONS: { value: SpeedUpRate; label: string }[] = SPEED_UP_RATES.map(rate => ({
  value: rate,
  label: `${rate}×`,
}));

export function stepPlaybackRate(direction: -1 | 1, wrap = false) {
  const rate = usePlayerStore.getState().rate;
  let next = rate + direction * RATE_STEP;
  // Shift+L wraps from the slowest speed to the fastest.
  if (wrap && next > MAX_RATE) next = MIN_RATE;
  else if (wrap && next < MIN_RATE) next = MAX_RATE;
  next = Math.min(MAX_RATE, Math.max(MIN_RATE, next));
  if (next !== rate) player.setRate(next);
}

/** Plain L toggles between 1× and the editor's chosen fast playback speed (1.5× by default) in one keypress. */
export function toggleFastPlaybackRate() {
  const { rate, speedUpRate } = usePlayerStore.getState();
  const next = rate === speedUpRate ? 1 : speedUpRate;
  if (next !== rate) player.setRate(next);
}

export function PlaybackSpeed({ playable }: { playable: boolean }) {
  const rate = usePlayerStore(s => s.rate);
  const speedUpRate = usePlayerStore(s => s.speedUpRate);
  const setSpeedUpRate = usePlayerStore(s => s.setSpeedUpRate);
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pointerSelect = useRef(false);
  const panelId = useId();
  const shortcutId = useId();

  usePopoverDismiss(open, control, trigger, () => setOpen(false));

  return <div ref={control} className="playback-speed" onClick={e => {
    // A pointer adjustment hands Space back to the player. Keyboard users keep their place.
    // Don't blur the shortcut picker on click or its portaled listbox closes immediately on blur.
    if (e.detail > 0 && e.target instanceof Element && !e.target.closest('[role="combobox"], [role="listbox"]')) {
      e.target.closest("button")?.blur();
    }
  }}>
    <button type="button" className="btn-icon playback-speed-trigger" ref={trigger}
      aria-label={`Playback speed, ${rate}×`} title="Playback speed" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(shown => !shown)}>{rate}×<Icon name="down" size={10} /></button>
    {open && <div className="playback-speed-panel" id={panelId} role="group" aria-label="Playback speed" data-escape-owner>
      <div className="playback-speed-stepper">
        <button type="button" className="btn-icon" aria-label="Decrease playback speed" aria-keyshortcuts="Shift+L" title="Decrease playback speed (Shift L)"
          disabled={!playable || rate <= MIN_RATE} onClick={() => stepPlaybackRate(-1)}>−</button>
        <output>{rate}×</output>
        <button type="button" className="btn-icon" aria-label="Increase playback speed" title="Increase playback speed"
          disabled={!playable || rate >= MAX_RATE} onClick={() => stepPlaybackRate(1)}>+</button>
      </div>
      <div className="playback-speed-shortcut"
        onPointerDown={() => { pointerSelect.current = true; }}
        onKeyDown={() => { pointerSelect.current = false; }}>
        <label className="playback-speed-shortcut-label" htmlFor={shortcutId}><Kbd>L</Kbd> shortcut</label>
        <PreferenceSelect id={shortcutId} compact label="Speed-up shortcut speed" value={speedUpRate} options={SPEED_UP_OPTIONS}
          onChange={setSpeedUpRate}
          onClose={() => {
            if (pointerSelect.current) {
              pointerSelect.current = false;
              document.getElementById(shortcutId)?.blur();
            }
          }} />
      </div>
    </div>}
  </div>;
}
