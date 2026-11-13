import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { newId, type TranscriptSegment, type TranscriptWord } from "@scarlet/timeline";
import { extractWav } from "../render/ffmpeg.js";
import { fallbackAdapter } from "../render/adapter.js";
import { clip } from "../logText.js";
import type { TranscribeInput, TranscribeResult, TranscriptionProvider } from "./index.js";

const CHUNK_SECONDS = 600; // 10 minutes of 16k mono wav ≈ 19 MB, under the 25 MB API limit
/** A tenth of a second of that wav after FFmpeg's 78-byte header. The API rejects audio shorter than this. */
const SHORTEST_CHUNK_BYTES = 78 + 3200;

/** Whether FFmpeg decoded next to nothing: a WAV header with under a tenth of a second of audio after it. */
async function emptyDecode(wav: string) {
  if ((await stat(wav)).size >= SHORTEST_CHUNK_BYTES) return false;
  return (await readFile(wav)).toString("latin1", 0, 4) === "RIFF";
}

/**
 * Why OpenAI turned a transcription down, in words the editor can act on. Its answer is JSON written for a program, so
 * that goes to the log. The key is set in the engine's environment (OPENAI_API_KEY), not in Settings.
 */
export function openaiFailure(status: number, answer: string, model: string): string {
  let error: { message?: unknown; code?: unknown; type?: unknown } | undefined;
  try { error = (JSON.parse(answer) as { error?: typeof error }).error; } catch { /* not JSON: a proxy's page, or nothing */ }
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const said = `${error?.code ?? ""} ${error?.type ?? ""} ${message}`;
  if (status === 401) return "OpenAI didn’t accept the API key: check OPENAI_API_KEY, or choose local transcription in Settings.";
  if (/insufficient_quota|exceeded your current quota/i.test(said)) return "Your OpenAI account is out of credit: add credit with OpenAI, or choose local transcription in Settings.";
  if (status === 429) return "OpenAI is getting too many requests from this key: try again in a minute.";
  if (status === 413 || /too large|maximum content size/i.test(said)) return "This audio is too large for OpenAI to transcribe: choose local transcription in Settings.";
  if (status === 404 || /model_not_found/i.test(said)) return `OpenAI doesn’t offer the model “${model}” to this key: change the OpenAI model in Settings → Advanced.`;
  if (status >= 500) return "OpenAI’s transcription service isn’t working right now: try again in a few minutes.";
  // Anything else OpenAI explains in words of its own, such as a language code it doesn't know.
  const own = withoutKeys(clip(message, 200));
  return own ? `OpenAI couldn’t transcribe this audio and said “${/[.!?]$/.test(own) ? own : `${own}.`}”`
    : `OpenAI couldn’t transcribe this audio (error ${status}): try again in a minute.`;
}

/** OpenAI masks most of a key it quotes back. The rest stays out of the log and the window as well. */
const withoutKeys = (text: string) => text.replace(/\bsk-[\w*-]+/g, "sk-…");

interface VerboseJson {
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
  text?: string;
}

/** OpenAI audio transcriptions (`whisper-1` / `gpt-4o-transcribe`) with word timestamps. */
export class OpenAIProvider implements TranscriptionProvider {
  readonly name = "openai";
  constructor(private readonly opts: { apiKey: string; model: string; language?: string; baseUrl?: string; log?: (message: string) => void }) {}

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (input.dialogueWindow) {
      const json = await this.call(input.path, input.language ?? this.opts.language, input);
      if (!json.words?.length) {
        const hasSpeech = json.text?.trim() || json.segments?.some(s => s.text.trim());
        const hasTranscript = typeof json.text === "string" || Array.isArray(json.segments) || Array.isArray(json.words);
        if (hasTranscript && !hasSpeech) return { language: json.language, segments: [] };
        throw new Error("First-cut scans require an OpenAI model that returns word timestamps.");
      }
      return { language: json.language, segments: toSegments(json, 0) };
    }
    const duration = input.duration ?? (await fallbackAdapter.probeMedia(input.path)).duration;
    const segments: TranscriptSegment[] = [];
    let language: string | undefined;
    // Send only the audio track, including for small videos and screen recordings.
    for (let offset = 0; offset < Math.max(duration, 1); offset += CHUNK_SECONDS) {
      input.signal?.throwIfAborted();
      const out = join(input.tmpDir, `${newId("chunk")}.wav`);
      try {
        await extractWav(input.path, out, { start: offset, duration: CHUNK_SECONDS, signal: input.signal });
        // A file can run past its audio. A later chunk that starts there holds no speech, and uploading it would
        // fail the whole transcript.
        if (offset === 0 || !await emptyDecode(out)) {
          const json = await this.call(out, input.language ?? this.opts.language, input);
          language ??= json.language;
          segments.push(...toSegments(json, offset));
        }
        input.onProgress?.(Math.min(1, (offset + CHUNK_SECONDS) / Math.max(duration, 1)));
      } finally {
        await rm(out, { force: true });
      }
    }
    return { language, segments };
  }

  private async call(path: string, language: string | undefined, { signal, beforeUpload, dialogueWindow }: TranscribeInput): Promise<VerboseJson> {
    const fd = new FormData();
    const name = path.split(/[\\/]/).pop() ?? "audio";
    fd.append("file", new Blob([await readFile(path, { signal })], { type: "audio/wav" }), name);
    fd.append("model", this.opts.model);
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");
    fd.append("timestamp_granularities[]", "segment");
    if (language) fd.append("language", language);
    if (dialogueWindow?.prompt) fd.append("prompt", dialogueWindow.prompt);
    beforeUpload?.();
    const res = await fetch(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: fd,
      signal,
    }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      const cause = (error as { cause?: unknown }).cause;
      this.opts.log?.(`[transcribe] couldn’t reach OpenAI: ${error}${cause ? ` (${cause})` : ""}`);
      throw new Error("Scarlet couldn’t reach OpenAI: check your internet connection, then try again.");
    });
    if (!res.ok) {
      const answer = await res.text();
      this.opts.log?.(`[transcribe] OpenAI answered ${res.status}: ${withoutKeys(clip(answer, 500))}`);
      throw new Error(openaiFailure(res.status, answer, this.opts.model));
    }
    return (await res.json()) as VerboseJson;
  }
}

/** Build word-timed segments from verbose_json, offsetting all times by `offset` seconds. */
export function toSegments(json: VerboseJson, offset: number): TranscriptSegment[] {
  const words: TranscriptWord[] = (json.words ?? []).map((w) => ({
    text: w.word.trim(),
    start: Math.max(0, w.start + offset),
    end: Math.max(0, w.end + offset),
  }));
  const rawSegments = json.segments?.length
    ? json.segments
    : [{ start: json.words?.[0]?.start ?? 0, end: json.words?.at(-1)?.end ?? 0, text: json.text ?? "" }];
  const out: TranscriptSegment[] = [];
  let wi = 0;
  for (const s of rawSegments) {
    const start = s.start + offset;
    const end = s.end + offset;
    const segWords: TranscriptWord[] = [];
    while (wi < words.length && words[wi]!.start < end - 1e-3) {
      segWords.push(words[wi]!);
      wi++;
    }
    out.push({ id: newId("seg"), start, end: Math.max(start, end), text: s.text.trim(), words: segWords });
  }
  // Any trailing words (rounding) go on the last segment.
  if (wi < words.length && out.length) out[out.length - 1]!.words.push(...words.slice(wi));
  return out;
}
