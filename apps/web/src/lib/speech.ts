import { useState } from "react";
import { api, errorMessage } from "./client";
import type { RecorderResult } from "./recorder";

/**
 * Push-to-talk → text. Records with MicButton, transcribes through the
 * engine's /speech route, then hands the text to `onText`.
 */
export function useSpeech(onText: (text: string, recording: RecorderResult) => void | Promise<void>, onError: (message: string) => void) {
  const [busy, setBusy] = useState(false);

  const handle = async (recording: RecorderResult) => {
    setBusy(true);
    try {
      const { text } = await api.speechToText(recording.blob);
      const clean = text.trim();
      if (!clean) throw new Error("Didn't catch that. Try again, or type it.");
      await onText(clean, recording);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return { busy, handle };
}
