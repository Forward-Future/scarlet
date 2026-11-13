import type { LocalTranscriptionModel, ServerSettings } from "@scarlet/shared";
import type { TranscriptSegment } from "@scarlet/timeline";
import { win32 } from "node:path";
import type { Ctx } from "../context.js";
import { FfmpegError } from "../render/ffmpeg.js";
import { bundledWhisperModel } from "./localModel.js";
import { OpenAIProvider } from "./openai.js";
import { hasCrisperWhisper, localRuntimeIssue, resolveLocalRuntime, type LocalRuntime } from "./localRuntime.js";
import { WhisperCppProvider } from "./whispercpp.js";

export interface TranscribeInput {
  signal?: AbortSignal;
  /** Recheck durable authorization immediately before sending an audio chunk. */
  beforeUpload?: () => void;
  /** Any media file ffmpeg can read. */
  path: string;
  /** Caller-owned, pre-extracted mono WAV of at most one minute for dialogue analysis. */
  dialogueWindow?: { prompt?: string };
  duration?: number;
  language?: string;
  /** Scratch directory for wav chunks. */
  tmpDir: string;
  /** Optional caller-owned destination for the full 16 kHz mono decode produced by local Whisper. */
  keepWavAt?: string;
  /** How much of the recording the provider has transcribed so far, 0..1. */
  onProgress?: (fraction: number) => void;
}

export interface TranscribeResult {
  language?: string;
  /** Optional model display name reported by a custom adapter for this recording. */
  modelLabel?: string;
  segments: TranscriptSegment[];
}

export interface TranscriptionProvider {
  readonly name: Exclude<ProviderName, "none">;
  readonly localModel?: LocalTranscriptionModel;
  /** Human-readable identity of the model or adapter selected for this run, without local directories. */
  readonly modelLabel?: string;
  /** Local Whisper that runs on the GPU while Scarlet's other audio models run on the CPU, so it need not wait for them. */
  readonly gpu?: boolean;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

export type ProviderName = ServerSettings["transcription"]["provider"];

/** A saved preset identifies its model. A generic local or cloud provider alone does not. */
export function presetLabel(preset?: LocalTranscriptionModel): string | undefined {
  if (preset === "crisperwhisper") return "CrisperWhisper 2.0 large";
  if (preset === "whispercpp") return bundledWhisperModel.displayName;
}

/** Off also applies to explicit API requests, regardless of installed credentials. */
export function effectiveProviderName(provider: ProviderName, override?: string): ProviderName {
  return provider === "none" ? "none" : (override as ProviderName | undefined) ?? provider;
}

/** Null when transcription is not configured. */
export function getTranscriptionProvider(ctx: Ctx, override?: string, snapshot = ctx.repos.settings.transcriptionPolicy(), local?: LocalRuntime): TranscriptionProvider | null {
  const { settings: s, signal: policy } = snapshot;
  const name = effectiveProviderName(s.provider, override);
  let provider: TranscriptionProvider;
  let localModel: LocalTranscriptionModel | undefined;
  let modelLabel: string | undefined;
  let gpu = false;
  switch (name) {
    case "openai":
      if (s.provider !== "openai" || !ctx.env.openaiKey) return null;
      if (s.openaiModel && !win32.isAbsolute(s.openaiModel)) modelLabel = s.openaiModel;
      provider = new OpenAIProvider({ apiKey: ctx.env.openaiKey, model: s.openaiModel, language: s.language, log: message => ctx.log(message) });
      break;
    case "whispercpp": {
      const runtime = local ?? resolveLocalRuntime(ctx, s);
      if (!runtime.binary) return null;
      localModel = runtime.active;
      modelLabel = presetLabel(localModel) ?? (runtime.model ? win32.basename(runtime.model)
        : runtime.adapterOwnsModel ? `Model not reported by ${win32.basename(runtime.binary)}` : bundledWhisperModel.displayName);
      gpu = runtime.gpu ?? false;
      const model = runtime.model || (runtime.adapterOwnsModel ? undefined
        : (signal?: AbortSignal) => ctx.whisperModel.get(signal ?? AbortSignal.any([policy, ctx.shutdown])));
      provider = new WhisperCppProvider({
        binary: runtime.binary, model, binaryArgs: runtime.script ? ["-I", "-B", runtime.script] : undefined,
        beforeRun: runtime.script ? () => {
          // The audio lane or decoding may have taken minutes since this run captured its model identity.
          if (!hasCrisperWhisper(ctx.paths.root)) throw new Error("The CrisperWhisper installation changed while this recording waited. Retry transcription after setup finishes.");
        } : undefined,
        gpuBinary: runtime.gpuBinary, language: s.language, log: message => ctx.log(message),
      });
      break;
    }
    default:
      return null;
  }
  // Capture the setting at selection time, including while a voice file is being staged.
  return {
    name: provider.name,
    localModel,
    modelLabel,
    gpu,
    async transcribe(input) {
      const signals = [policy, ctx.shutdown];
      if (input.signal && input.signal !== ctx.shutdown) signals.push(input.signal);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      try {
        const result = await provider.transcribe({ ...input, signal, beforeUpload() {
          ctx.settings();
          input.beforeUpload?.();
          signal.throwIfAborted();
        } });
        ctx.settings(); // A peer can revoke consent while the final response is arriving.
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        // ffmpeg's or whisper-cli's own output, when one of them fails on the recording, means nothing to the editor,
        // who reads this error under the message box or on the recording. It goes to the log.
        if (error instanceof FfmpegError) {
          ctx.log(`[transcribe] ${provider.name} failed: ${error.message}`);
          throw new Error("Scarlet couldn’t transcribe this recording: export the logs from Settings → Advanced to report it.");
        }
        throw error;
      }
    },
  };
}

/** Settings and automatic imports agree on which configured runtime can take work now. */
export async function availableTranscriptionProvider(ctx: Ctx, policy = ctx.repos.settings.transcriptionPolicy()) {
  const local = policy.settings.provider === "whispercpp" ? resolveLocalRuntime(ctx, policy.settings) : undefined;
  if (local && await localRuntimeIssue(local)) return null;
  return getTranscriptionProvider(ctx, undefined, policy, local);
}

/**
 * Snapshot before reading the import request, which may stream footage for several minutes.
 * Every configured provider, bundled Whisper included, transcribes at import: a dialogue pass reads
 * the transcript first, and starting it then left a long recording's pass waiting for many minutes.
 * Import transcripts rank behind the recording a pass is reading, so a pass waits at most for the step
 * already running.
 */
export async function importTranscriptionPolicy(ctx: Ctx) {
  const policy = ctx.repos.settings.transcriptionPolicy();
  const { revision, signal } = policy;
  return { provider: (await availableTranscriptionProvider(ctx, policy))?.name, revision, signal };
}

// Whisper labels silence and sounds instead of words: "[BLANK_AUDIO]", "[ Silence ]", "(music)", "*coughs*".
const SOUND_LABEL = /\[[^\]]*\]|\(\s*(?:blank[ _]audio|silence|silent|no speech|inaudible|music|noise|static|background noise|breathing|coughs?|laughs?|sighs?|applause)\s*\)|\*[^*]*\*/gi;

/** What someone actually said in a short recording. Empty when the recording held no words. */
export function spokenText(segments: Pick<TranscriptSegment, "text">[]): string {
  return segments.map(s => s.text).join(" ").replace(SOUND_LABEL, " ").replace(/\s+/g, " ").trim();
}
