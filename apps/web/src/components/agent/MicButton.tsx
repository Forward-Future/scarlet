import { useEffect, useRef } from "react";
import { MAX_RECORD_SECONDS, useRecorder, type RecorderResult } from "../../lib/recorder";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../ui/primitives";

/**
 * Mic toggle. Click toggles recording; holding V (uiStore.voiceHold) records
 * push-to-talk style when `followHold` is set. Shows a red dot and elapsed
 * time while recording and auto-stops at the 2 minute cap.
 */
export function MicButton({ onResult, onStart, onRecording, onError, disabled, disabledReason, followHold = false, size = "md", label = "Record a voice note" }: { onResult: (r: RecorderResult) => void; onStart?(): void; onRecording?(on: boolean): void; onError?(message: string): void; disabled?: boolean; disabledReason?: string; followHold?: boolean; size?: "md" | "lg"; label?: string }) {
  const rec = useRecorder(onResult);
  useEffect(() => { if (rec.error) onError?.(rec.error); }, [onError, rec.error]);
  const hold = useUiStore((s) => s.voiceHold);
  const heldRef = useRef(false);
  const button = useRef<HTMLButtonElement>(null);

  // While it records, a ring round the button moves with the voice, so the editor sees it hears them. It is set on the
  // button each frame, not through React. It rises at once and falls back gently between words.
  const { recording, readLevel } = rec;
  useEffect(() => {
    const el = button.current;
    if (!recording || !el) return;
    let shown = 0, frame = requestAnimationFrame(function draw() {
      shown = Math.max(readLevel(), shown * 0.86);
      el.style.setProperty("--voice", shown.toFixed(3));
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

  const unsupported = rec.state === "unsupported";
  const isDisabled = disabled || unsupported;
  const title = unsupported ? "Scarlet can’t record audio on this computer" : disabled ? disabledReason : rec.recording ? "Stop recording" : followHold ? `${label} (hold V)` : label;
  const dim = size === "lg" ? "size-10" : "size-8";

  return (
    <div className="flex items-center gap-2">
      <button
        ref={button}
        type="button"
        aria-label={rec.recording ? "Stop recording" : label}
        aria-pressed={rec.recording}
        title={title}
        disabled={isDisabled}
        onClick={() => { if (rec.recording) rec.stop(); else { onStart?.(); void rec.start(); } }}
        className={`${dim} inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${rec.recording ? "bg-bad text-white mic-voice" : rec.state === "requesting" ? "bg-raised text-muted" : "mic-ready"}`}
      >
        <Icon name={rec.recording ? "stop" : "mic"} size={size === "lg" ? 18 : 15} />
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
