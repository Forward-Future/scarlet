import { useEffect, useRef } from "react";
import { usePlayerStore } from "../../stores/player";

/** How long the output device stays open after the editor's last press or move with nothing playing. */
export const AUDIO_REST_MS = 120_000;

/** Native WebKit can take several frames to open its output device, even with a decoded
 * picture waiting. A silent clock keeps that device ready for the duration of cut review.
 * Audio from every file and MediaSource continues through its own native media element.
 *
 * `nearby` keeps the device open outside review too, while the editor is at the video: from a press, a key or a move
 * of the pointer until two minutes without one, and for as long as the video plays. Without it the video's clock
 * held for 267 ms about 0.3 s after Play, on 61 of 142 plays started with Space and 65 of 86 passages opened, against
 * 1 of 227 steps to the next cut in review (a week of playback logs to 2026-11-14). It closes when they leave, so an
 * open project doesn't hold the device for hours. */
export function useCutAudio(enabled: boolean, nearby = false) {
  const always = useRef(enabled);
  always.current = enabled;
  const wake = useRef<() => void>(undefined);
  const on = enabled || nearby;
  useEffect(() => {
    if (!on || !window.AudioContext) return;
    let close: (() => void) | undefined;
    let context: AudioContext | undefined;
    let rest: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (close) return;
      let made: AudioContext;
      try { made = new AudioContext(); } catch { return; }
      const gain = made.createGain();
      gain.gain.value = 0;
      const clock = made.createOscillator();
      clock.connect(gain);
      gain.connect(made.destination);
      clock.start();
      context = made;
      close = () => {
        close = context = undefined;
        clock.stop();
        clock.disconnect();
        gain.disconnect();
        void made.close().catch(() => {});
      };
    };
    const resume = () => { if (context?.state === "suspended") void context.resume().catch(() => {}); };
    const idle = () => {
      if (always.current || usePlayerStore.getState().playing) rest = setTimeout(idle, AUDIO_REST_MS);
      else close?.();
    };
    let stayed = -Infinity;
    const stay = () => {
      open();
      // A moving pointer asks hundreds of times a second.
      if (performance.now() - stayed < 1000) return;
      stayed = performance.now();
      clearTimeout(rest);
      rest = setTimeout(idle, AUDIO_REST_MS);
    };
    // A new WebView can defer audio until the first real pointer or keyboard gesture.
    const gesture = () => { stay(); resume(); };
    wake.current = () => { stayed = -Infinity; stay(); resume(); };
    if (always.current) wake.current();
    window.addEventListener("pointerdown", gesture, true);
    window.addEventListener("keydown", gesture, true);
    window.addEventListener("pointermove", stay, { capture: true, passive: true });
    return () => {
      clearTimeout(rest);
      window.removeEventListener("pointerdown", gesture, true);
      window.removeEventListener("keydown", gesture, true);
      window.removeEventListener("pointermove", stay, true);
      wake.current = undefined;
      close?.();
    };
  }, [on]);
  // Review that opens after the device rested opens it again.
  useEffect(() => { if (enabled) wake.current?.(); }, [enabled]);
}
