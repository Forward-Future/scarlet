import { useState } from "react";
import { appLog, errorName } from "./appLog";
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
    const started = performance.now();
    let heard: string | undefined;
    try {
      const { text } = await api.speechToText(recording.blob);
      const clean = heard = text.trim();
      // How long it took and how much came back, never the words.
      appLog("voice", clean ? "transcribed" : "transcribed-empty", { ms: Math.round(performance.now() - started), bytes: recording.blob.size, chars: clean.length });
      if (!clean) throw new Error("Didn't catch that. Try again, or type it.");
      await onText(clean, recording);
    } catch (e) {
      // A failure after the words came back is the send's, and the message box logs it.
      if (heard === undefined) appLog("voice", "transcribe-failed", { ms: Math.round(performance.now() - started), bytes: recording.blob.size, name: errorName(e) }, { level: "warn" });
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return { busy, handle };
}
