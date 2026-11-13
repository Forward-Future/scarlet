import { useEffect } from "react";

/** Native WebKit can take several frames to open its output device, even with a decoded
 * picture waiting. A silent clock keeps that device ready for the duration of cut review.
 * Audio from every file and MediaSource continues through its own native media element. */
export function useCutAudio(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !window.AudioContext) return;
    let context: AudioContext;
    try { context = new AudioContext(); } catch { return; }
    const gain = context.createGain();
    gain.gain.value = 0;
    const clock = context.createOscillator();
    clock.connect(gain);
    gain.connect(context.destination);
    clock.start();
    const resume = () => { if (context.state === "suspended") void context.resume().catch(() => {}); };
    resume();
    // A new WebView can defer audio until the first real pointer or keyboard gesture.
    window.addEventListener("pointerdown", resume, true);
    window.addEventListener("keydown", resume, true);
    return () => {
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("keydown", resume, true);
      clock.stop();
      clock.disconnect();
      gain.disconnect();
      void context.close().catch(() => {});
    };
  }, [enabled]);
}
