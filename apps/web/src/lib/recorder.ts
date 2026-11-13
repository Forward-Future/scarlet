import { useCallback, useEffect, useRef, useState } from "react";
import { appLog } from "./appLog";

export type RecorderState = "idle" | "requesting" | "recording" | "denied" | "unsupported" | "error";

export interface RecorderResult {
  blob: Blob;
  seconds: number;
  mimeType: string;
}

export const MAX_RECORD_SECONDS = 120;

/** How loud the voice is, from 0 for silence to 1 for clear speech, from the samples' RMS: about -55 dB to -15 dB. */
export function voiceLevel(samples: ArrayLike<number>) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-8);
  return Math.max(0, Math.min(1, (db + 55) / 40));
}

function pickMime(): string {
  const prefs = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const m of prefs) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

/**
 * Microphone capture via MediaRecorder (webm/opus where available). Handles
 * permission denial, shows elapsed time, and auto-stops at MAX_RECORD_SECONDS.
 */
export function useRecorder(onResult: (r: RecorderResult) => void) {
  const [state, setState] = useState<RecorderState>(() =>
    typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia ? "unsupported" : "idle",
  );
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const cancelled = useRef(false);
  const pending = useRef<symbol | null>(null);
  // Reads the microphone's level while recording, for the button's ring. It adds nothing to what is recorded.
  const meter = useRef<{ audio: AudioContext; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> } | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const cleanup = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    rec.current = null;
    void meter.current?.audio.close().catch(() => {});
    meter.current = null;
  }, []);

  /** The voice's level this moment, from 0 to 1. Without a meter, as when audio can't be read here, 0. */
  const readLevel = useCallback(() => {
    const m = meter.current;
    if (!m) return 0;
    m.analyser.getFloatTimeDomainData(m.samples);
    return voiceLevel(m.samples);
  }, []);

  const stop = useCallback(
    (discard = false) => {
      if (pending.current) {
        pending.current = null;
        setState("idle");
      }
      const r = rec.current;
      if (!r) return;
      if (r.state === "inactive") {
        if (discard) cancelled.current = true;
        return;
      }
      cancelled.current = discard;
      r.stop();
    },
    [],
  );

  const start = useCallback(async (stillHeld?: () => boolean) => {
    if (pending.current || rec.current) return;
    if (state === "unsupported") return;
    const request = Symbol();
    pending.current = request;
    const deliver = onResultRef.current;
    setError(null);
    setState("requesting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (pending.current !== request || (stillHeld && !stillHeld())) {
        s.getTracks().forEach((track) => track.stop());
        if (pending.current === request) {
          pending.current = null;
          setState("idle");
        }
        return;
      }
      stream.current = s;
      try {
        const audio = new AudioContext();
        const analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        audio.createMediaStreamSource(s).connect(analyser);
        meter.current = { audio, analyser, samples: new Float32Array(analyser.fftSize) };
        void audio.resume().catch(() => {});
      } catch {
        // No meter: the recording goes on, and the ring stays still.
      }
      const mimeType = pickMime();
      const r = new MediaRecorder(s, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      cancelled.current = false;
      let failed = false;
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        const seconds = (performance.now() - startedAt.current) / 1000;
        const blob = new Blob(chunks.current, { type: r.mimeType || mimeType || "audio/webm" });
        cleanup();
        // A recorder that failed stops too. It has already said so, and what it caught is not a finished message.
        if (!failed) setState("idle");
        setElapsed(0);
        if (!failed && !cancelled.current && blob.size > 0 && seconds >= 0.4) {
          deliver({ blob, seconds, mimeType: blob.type });
        }
      };
      r.onerror = () => {
        failed = true;
        appLog("error", "microphone", { when: "recording" }, { level: "warn" });
        cleanup();
        setError("Recording failed.");
        setState("error");
      };
      rec.current = r;
      startedAt.current = performance.now();
      r.start(250);
      pending.current = null;
      setState("recording");
      timer.current = window.setInterval(() => {
        const e = (performance.now() - startedAt.current) / 1000;
        setElapsed(e);
        if (e >= MAX_RECORD_SECONDS) stop(false);
      }, 200);
    } catch (err) {
      if (pending.current !== request) return;
      pending.current = null;
      cleanup();
      const name = err instanceof DOMException ? err.name : "";
      appLog("error", "microphone", { when: "starting", name: name || (err instanceof Error ? err.name : "unknown") }, { level: "warn" });
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("Microphone access was denied. Allow the microphone for Scarlet and try again.");
        setState("denied");
      } else if (name === "NotFoundError") {
        setError("No microphone found.");
        setState("error");
      } else {
        setError(err instanceof Error ? err.message : "Couldn’t start recording.");
        setState("error");
      }
    }
  }, [cleanup, state, stop]);

  useEffect(() => () => {
    pending.current = null;
    cancelled.current = true;
    if (rec.current) {
      rec.current.onstop = null;
      if (rec.current.state !== "inactive") rec.current.stop();
    }
    cleanup();
  }, [cleanup]);

  return { state, elapsed, error, start, stop, readLevel, recording: state === "recording" };
}
