/**
 * Silence filtering for short voice dictation recordings (`/speech` and voice notes).
 * Whisper often hallucinates short sign-offs ("Thank you.", "Thanks for watching.") when fed
 * silence or steady room tone with no speech. Combining per-segment loudness (`withoutUnheardSegments`)
 * with WebRTC voice activity detection keeps genuine speech while dropping silent hallucinations.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { speechActivityOf } from "@scarlet/render";
import { newId, type TranscriptSegment } from "@scarlet/timeline";
import { clip } from "../logText.js";
import { extractWav } from "../render/ffmpeg.js";
import { SAMPLE_RATE } from "./ctcAlign.js";
import { spokenText } from "./index.js";
import { UNHEARD_DBFS, wavLevels, withoutUnheardSegments } from "./transcriptHoles.js";
import { openWav } from "./wordAlign.js";

/** Quiet room tone ceiling (dBFS) under which zero voice activity means nobody spoke. */
const QUIET_ROOM_DBFS = -45;
/** Minimum WebRTC VAD speech duration (seconds) to treat a recording as containing voice. */
const MIN_VOICE_SECONDS = 0.06;
/** Warm-up frames (0.3 s) fed to WebRTC VAD from the recording's quietest frames so steady room noise adapts before frame 0. */
const VAD_WARMUP_SECONDS = 0.3;
/** Maximum speech window length `speechActivityOf` accepts per call (leaving room for warm-up). */
const VAD_WINDOW_SECONDS = 59;

/** Common Whisper silence hallucinations (normalized: lowercased, no punctuation). */
const SILENCE_HALLUCINATIONS = new Set([
  "thank you",
  "thank you very much",
  "thank you so much",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for listening",
  "thank you for listening",
  "thanks for viewing",
  "thank you for viewing",
  "please subscribe",
  "like and subscribe",
  "see you next time",
  "you",
]);

/** Whether `text` matches a known Whisper silence hallucination once punctuation and casing are stripped. */
export function isSilenceHallucination(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  if (SILENCE_HALLUCINATIONS.has(normalized)) return true;
  return /^(?:subtitles|captions|translated|transcribed) by\b/.test(normalized);
}

const reason = (error: unknown) => clip(error instanceof Error ? error.message : String(error));

async function totalVoiceSeconds(wavPath: string, signal?: AbortSignal, log?: (message: string) => void): Promise<number | undefined> {
  const wav = await openWav(wavPath);
  try {
    if (wav.samples === 0) return 0;
    const frameSamples = SAMPLE_RATE / 50; // 20 ms
    const warmupSamples = Math.round(VAD_WARMUP_SECONDS * SAMPLE_RATE);
    // Estimate the room's noise floor from the quietest 20 ms frame in the first chunk so WebRTC VAD
    // adapts to steady mic hiss/AC hum before classifying frame 0 (matching waveform.ts's 0.3 s warm-up).
    const probeLen = Math.min(wav.samples, VAD_WINDOW_SECONDS * SAMPLE_RATE);
    const probeFloats = await wav.read(0, probeLen);
    let quietStart = 0, quietEnergy = Infinity;
    for (let off = 0; off + frameSamples <= probeFloats.length; off += frameSamples) {
      let e = 0;
      for (let k = off; k < off + frameSamples; k++) e += probeFloats[k]! * probeFloats[k]!;
      if (e < quietEnergy) { quietEnergy = e; quietStart = off; }
    }
    const warmup = new Int16Array(warmupSamples);
    if (probeFloats.length >= frameSamples) {
      for (let i = 0; i < warmupSamples; i++) {
        const s = probeFloats[quietStart + (i % frameSamples)]!;
        warmup[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
      }
    }

    let voiceSeconds = 0;
    const chunkSamples = VAD_WINDOW_SECONDS * SAMPLE_RATE;
    for (let offset = 0; offset < wav.samples; offset += chunkSamples) {
      signal?.throwIfAborted();
      const end = Math.min(wav.samples, offset + chunkSamples);
      const floats = offset === 0 && end === probeLen ? probeFloats : await wav.read(offset, end);
      const pcm = new Int16Array(warmupSamples + floats.length);
      pcm.set(warmup, 0);
      for (let i = 0; i < floats.length; i++) {
        pcm[warmupSamples + i] = Math.max(-32768, Math.min(32767, Math.round(floats[i]! * 32768)));
      }
      const duration = floats.length / SAMPLE_RATE;
      if (duration <= 0) continue;
      // `start = 0`, `from = VAD_WARMUP_SECONDS`, `to = VAD_WARMUP_SECONDS + duration` warms up on the noise floor
      // and reports speech spans strictly within the actual recording window.
      const spans = await speechActivityOf(pcm, 0, VAD_WARMUP_SECONDS, VAD_WARMUP_SECONDS + duration);
      for (const span of spans) voiceSeconds += span.end - span.start;
    }
    return voiceSeconds;
  } catch (error) {
    if (!signal?.aborted) log?.(`[transcribe] dictation: couldn't detect voice, so loudness alone decides: ${reason(error)}`);
    return undefined;
  } finally {
    await wav.close();
  }
}

/**
 * Filter a short dictation recording's Whisper segments against the recorded audio so silent recordings
 * stay empty instead of returning hallucinations such as "Thank you.".
 */
export async function filterDictationText(input: {
  audioPath: string;
  segments: TranscriptSegment[];
  tmpDir: string;
  signal?: AbortSignal;
  wavPath?: string;
  /** Where a dictation left empty, and checks that couldn't run, go. Never its words. The engine's log is its console. */
  log?: (message: string) => void;
}): Promise<string> {
  const log = input.log ?? ((message: string) => console.log(message));
  const initial = spokenText(input.segments);
  if (!initial) return "";

  let wav = input.wavPath && existsSync(input.wavPath) ? input.wavPath : undefined;
  let ownedWav = false;
  if (!wav) {
    const scratch = join(input.tmpDir, `${newId("dict")}.wav`);
    try {
      await extractWav(input.audioPath, scratch, { signal: input.signal });
      wav = scratch;
      ownedWav = true;
    } catch (error) {
      // If ffmpeg isn't available or fails, check whether the input itself is already a readable 16 kHz mono WAV;
      // unreadable fixture blobs in mocked tests fall back to text-only filtering.
      const usable = input.audioPath.toLowerCase().endsWith(".wav") && existsSync(input.audioPath);
      if (!input.signal?.aborted) {
        log(`[transcribe] dictation: couldn't decode the recording, ${usable ? "so it is read as it is" : "so its words are kept unchecked"}: ${reason(error)}`);
      }
      if (usable) wav = input.audioPath;
      else return initial;
    }
  }

  try {
    let levels: Awaited<ReturnType<typeof wavLevels>>;
    try {
      levels = await wavLevels(wav, input.signal);
    } catch (error) {
      if (!input.signal?.aborted) log(`[transcribe] dictation: couldn't measure the recording's loudness, so its words are kept unchecked: ${reason(error)}`);
      return initial;
    }
    if (!levels.rms.length) {
      log("[transcribe] dictation: the recording held no audio, so it is left empty");
      return "";
    }

    let peak = 0;
    for (let i = 0; i < levels.rms.length; i++) {
      if (levels.rms[i]! > peak) peak = levels.rms[i]!;
    }
    const peakDb = 20 * Math.log10(Math.max(peak, 1e-10));
    const loudest = `loudest ${peakDb.toFixed(0)} dBFS`;
    if (peakDb < UNHEARD_DBFS) {
      log(`[transcribe] dictation: heard nothing (${loudest}), so it is left empty`);
      return "";
    }

    const { segments, dropped } = withoutUnheardSegments(input.segments, levels);
    const text = spokenText(segments);
    if (!text) {
      log(`[transcribe] dictation: every line was over silence (${loudest}), so it is left empty`);
      return "";
    }
    if (dropped.length) log(`[transcribe] dictation: left out ${dropped.length} of ${input.segments.length} lines written over silence`);

    const voiceSeconds = await totalVoiceSeconds(wav, input.signal, log);
    if (voiceSeconds !== undefined && voiceSeconds < MIN_VOICE_SECONDS) {
      if (peakDb < QUIET_ROOM_DBFS || isSilenceHallucination(text)) {
        log(`[transcribe] dictation: no voice detected (${loudest}), so it is left empty`);
        return "";
      }
    }
    return text;
  } finally {
    if (ownedWav && wav) await rm(wav, { force: true });
  }
}
