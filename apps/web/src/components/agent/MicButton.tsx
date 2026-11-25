import { useEffect, useRef } from "react";
import { appLog } from "../../lib/appLog";
import { MAX_RECORD_SECONDS, useRecorder, type RecorderResult } from "../../lib/recorder";
import { isComposing } from "../../lib/hotkeys";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../ui/primitives";

/** What the red button is named while it records: a press sends what was said, and Esc throws it away. */
export const SEND_RECORDING = "Send (Esc to discard)";

/**
 * The recordings Esc throws away. That press is the recording's alone: it closes no card, clears no tag and leaves a
 * queued request's words in the box. So it is heard here first, by a listener in place before any the page adds later,
 * and goes no further.
 */
const discards = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !discards.size || e.metaKey || e.ctrlKey || e.altKey || isComposing(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // This Esc goes no further, so nothing after it hears or logs it: it is said here.
    appLog("voice", "discard-key", { recordings: discards.size });
    for (const discard of [...discards]) discard();
  }, true);
}

/**
 * Mic toggle. Click toggles recording; holding V (uiStore.voiceHold) records
 * push-to-talk style when `followHold` is set. Shows a red dot and elapsed
 * time while recording and auto-stops at the 2 minute cap. A press on the red
 * button, letting go of V and the cap all send what was said. Esc throws the
 * recording away instead, and that press does nothing else.
 */
export function MicButton({ onResult, onStart, onRecording, onError, disabled, disabledReason, followHold = false, label = "Record a voice note" }: { onResult: (r: RecorderResult) => void; onStart?(): void; onRecording?(on: boolean): void; onError?(message: string): void; disabled?: boolean; disabledReason?: string; followHold?: boolean; label?: string }) {
  const rec = useRecorder(onResult);
  useEffect(() => { if (rec.error) onError?.(rec.error); }, [onError, rec.error]);
  const hold = useUiStore((s) => s.voiceHold);
  const heldRef = useRef(false);
  const button = useRef<HTMLButtonElement>(null);

  // While it records, a ring round the button moves with the voice, so the editor sees it hears them. It is set on the
  // button each frame, not through React. It rises at once and falls back gently between words. With motion reduced it
  // rests at its width and doesn't move.
  const { recording, readLevel } = rec;
  useEffect(() => {
    const el = button.current;
    if (!recording || !el) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let shown = 0, frame = requestAnimationFrame(function draw() {
      shown = Math.max(readLevel(), shown * 0.86);
      if (reduceMotion.matches) el.style.removeProperty("--voice"); else el.style.setProperty("--voice", shown.toFixed(3));
      frame = requestAnimationFrame(draw);
    });
    return () => { cancelAnimationFrame(frame); el.style.removeProperty("--voice"); };
  }, [recording, readLevel]);

  // From asking for the microphone until the recording stops, what is said is a message on its way.
  const live = rec.state === "requesting" || rec.state === "recording";
  const onRecordingRef = useRef(onRecording);
  onRecordingRef.current = onRecording;
  useEffect(() => { onRecordingRef.current?.(live); }, [live]);

  useEffect(() => {
    // A hold starts from wherever a click can: a microphone that failed or was refused once is asked again.
    if (hold && followHold && !disabled && !["recording", "requesting", "unsupported"].includes(rec.state)) {
      heldRef.current = true;
      onStart?.();
      void rec.start(() => heldRef.current && useUiStore.getState().voiceHold);
    } else if ((!hold || !followHold || disabled) && heldRef.current) {
      heldRef.current = false;
      rec.stop(!followHold || disabled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold, followHold, disabled]);

  const stop = rec.stop;
  useEffect(() => {
    const cancelHold = () => {
      if (!heldRef.current) return;
      heldRef.current = false;
      stop(true);
      useUiStore.getState().setVoiceHold(false);
    };
    const onVisibility = () => { if (document.hidden) cancelHold(); };
    window.addEventListener("blur", cancelHold);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", cancelHold);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stop]);

  // Esc while it records throws the recording away: nothing is sent and nothing lands in the box.
  useEffect(() => {
    if (!recording) return;
    const discard = () => {
      heldRef.current = false;
      stop(true);
    };
    discards.add(discard);
    return () => { discards.delete(discard); };
  }, [recording, stop]);

  const unsupported = rec.state === "unsupported";
  const isDisabled = disabled || unsupported;
  const title = unsupported ? "Scarlet can’t record audio on this computer" : disabled ? disabledReason : rec.recording ? SEND_RECORDING : followHold ? `${label} (hold V)` : label;

  return (
    <div className="flex items-center gap-2">
      <button
        ref={button}
        type="button"
        aria-label={rec.recording ? SEND_RECORDING : label}
        aria-pressed={rec.recording}
        title={title}
        disabled={isDisabled}
        onClick={() => { if (rec.recording) rec.stop(); else { onStart?.(); void rec.start(); } }}
        className={`size-8 inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${rec.recording ? "bg-bad text-white mic-voice" : rec.state === "requesting" ? "bg-raised text-muted" : "mic-ready"}`}
      >
        <Icon name={rec.recording ? "stop" : "mic"} size={15} />
      </button>
      {rec.recording && (
        <span className="inline-flex items-center gap-1.5 text-[12px] tnum" aria-live="polite">
          <span className="size-2 rounded-full bg-bad pulse" aria-hidden />
          {Math.floor(rec.elapsed / 60)}:{String(Math.floor(rec.elapsed % 60)).padStart(2, "0")}
          <span className="text-dim">/ {MAX_RECORD_SECONDS / 60}:00</span>
        </span>
      )}
      {rec.state === "requesting" && <span className="text-[12px] text-muted">Waiting for microphone…</span>}
      {rec.error && !rec.recording && !onError && (
        <span role="alert" className="text-[12px] text-bad max-w-[260px] leading-tight">
          {rec.error}
        </span>
      )}
    </div>
  );
}
