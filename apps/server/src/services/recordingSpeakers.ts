import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { fileInDirectory } from "@scarlet/render";
import { SpeakerProgress } from "@scarlet/shared";
import { newId, type MediaAsset, type Transcript } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { extractWav, run } from "../render/ffmpeg.js";
import { LocalWhisperModel } from "../transcribe/localModel.js";
import { labelTranscript, numberSpeakers, speakerAnalysisVersion, speakerTurnCacheVersion, type SpeakerTurn } from "../transcribe/speakerLabels.js";
import { AnalysisCache } from "./analysisCache.js";
import { audioLane } from "./audioWork.js";
import { speakerGpuRuntime } from "../transcribe/speakerWorker.js";
import { humanDuration } from "../logText.js";
import { availableParallelism } from "node:os";

/**
 * Whether speaker analysis runs beside the engine's audio lane instead of taking a turn in it. A dialogue pass's
 * first scan page waits for the whole recording's speakers, and in the lane they waited behind Whisper and then
 * ran alone: on 2026-11-07 two recordings' analyses held a pass's first page for five minutes after its transcript.
 * On the CPU the worker uses two to four threads, and a 58-minute recording took 82 s alone and 83 s beside Whisper,
 * which took 20.2 s alone and 20.9 s beside it (M5 Max, 18 cores, Whisper on the GPU). So with cores to spare it
 * runs at once. A small machine keeps it in the lane, and so does the GPU runtime, which would share the GPU with
 * Whisper and hasn't been measured beside it.
 */
export function speakersRunBeside(cores = availableParallelism(), gpuRuntime = !!speakerGpuRuntime()) {
  return !gpuRuntime && cores >= 12;
}

/**
 * How many recordings are analysed at a time. A pass on a camera and a screen recording needs both, and one after
 * the other the second held the pass's first page: with two 58-minute recordings that page came 142 s after the
 * request, and 99 s with both analysed together (same machine, with the lane's Whisper, alignment and pages running).
 */
export function speakersAtOnce(cores = availableParallelism(), beside = speakersRunBeside(cores)) {
  return beside && cores >= 16 ? 2 : 1;
}

const segmentation = {
  name: "speaker-segmentation-220ad67c.onnx", size: 5992913,
  url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx",
  sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
};
const embedding = {
  name: "speaker-eres2net-1a331345.onnx", size: 39593761,
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
  sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
};

/** A transcription job owns this WAV until its speaker analysis settles. */
export interface DecodedRecording {
  wav: string;
  audioStream?: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function speakerStream(media: MediaAsset) {
  const roles = media.voiceRoles;
  return roles ? 3 - (roles.me - 1) - (roles.other - 1) : undefined;
}

const turnsKey = (file: string, info: { size: number; mtimeMs: number; ctimeMs: number }, audioStream?: number) =>
  createHash("sha256").update(JSON.stringify([speakerTurnCacheVersion, file, info.size, info.mtimeMs, info.ctimeMs, audioStream ?? null])).digest("hex");
const turnsFile = (ctx: Pick<Ctx, "paths">, projectId: string, key: string) => join(ctx.paths.waveforms(projectId), `speakers-${key}.json`);

/** Where the speaker turns of a recording are saved, named for its file as it is now. Nothing once the file is gone. */
export async function savedSpeakerTurns(ctx: Pick<Ctx, "paths">, projectId: string, media: MediaAsset) {
  const file = fileInDirectory(ctx.paths.media(projectId), media.path);
  const info = file && await stat(file).catch(() => null);
  return file && info ? turnsFile(ctx, projectId, turnsKey(file, info, speakerStream(media))) : undefined;
}

export function matchesSpeakerStream(media: MediaAsset, decodedStream?: number) {
  const stream = speakerStream(media);
  // An unspecified FFmpeg map may select a different stream on multistream recordings.
  return decodedStream === stream;
}

export class RecordingSpeakers {
  private readonly segmentation: LocalWhisperModel;
  private readonly embedding: LocalWhisperModel;
  private readonly cache = new AnalysisCache<SpeakerTurn[]>(v => v.length * 48, 8 * 1024 * 1024, speakersAtOnce());
  private readonly revisions = new Map<string, Promise<void>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly active = new Map<string, { projectId: string; progress: SpeakerProgress }>();
  /** Analyses asked for and not yet ended, each settled when it ends either way. `priority`: a dialogue pass is waiting for it. */
  private readonly analyses = new Map<Promise<void>, { projectId: string; mediaId: string; priority: boolean }>();
  /** The GPU runtime failed an analysis the CPU then finished, so analysis stays on the CPU until the engine restarts. */
  private gpuFailed = false;
  /** Analysis runs beside the audio lane rather than in it. Decided by the machine; tests set it. */
  beside = speakersRunBeside();
  /** How many of a dialogue pass's requests are waiting for each recording's analysis, by media id. */
  private readonly passWaits = new Map<string, number>();

  constructor(root: string) {
    this.segmentation = new LocalWhisperModel(join(root, "models"), segmentation);
    this.embedding = new LocalWhisperModel(join(root, "models"), embedding);
  }

  progressFor(projectId: string): Record<string, SpeakerProgress> {
    return Object.fromEntries([...this.active].filter(([, job]) => job.projectId === projectId)
      .map(([mediaId, job]) => [mediaId, job.progress]));
  }

  /**
   * `priority`: a dialogue pass is waiting for this recording, so it goes ahead of analyses nobody waits for, and a
   * pause of the project's media work doesn't stop it: the editor asked for that pass, and pausing the caching isn't
   * stopping it. That holds for an analysis the pass joined too, such as the one begun with the recording's
   * transcript. One nobody waits for stops with the pause, like the rest of the work Scarlet does unasked.
   */
  async turns(ctx: Ctx, projectId: string, media: MediaAsset, decoded?: DecodedRecording, priority = false): Promise<SpeakerTurn[]> {
    if (!priority) return this.analysed(ctx, projectId, media, decoded, false);
    // Counted before anything is awaited, so a pause that lands as the pass asks finds it waiting.
    this.passWaits.set(media.id, (this.passWaits.get(media.id) ?? 0) + 1);
    try { return await this.analysed(ctx, projectId, media, decoded, true); }
    finally {
      const left = this.passWaits.get(media.id)! - 1;
      if (left) this.passWaits.set(media.id, left);
      else this.passWaits.delete(media.id);
    }
  }

  private async analysed(ctx: Ctx, projectId: string, media: MediaAsset, decoded: DecodedRecording | undefined, priority: boolean): Promise<SpeakerTurn[]> {
    const pause = ctx.mediaSignal(projectId);
    // Trash, a quit and a change of the transcription settings stop an analysis whoever waits for it.
    const always = AbortSignal.any([ctx.projectSignal(projectId), ctx.repos.settings.transcriptionSignal]);
    if (!priority) pause.throwIfAborted();
    always.throwIfAborted();
    const file = fileInDirectory(ctx.paths.media(projectId), media.path);
    if (!file) throw new Error("Could not find the recording for speaker analysis.");
    const info = await stat(file);
    const audioStream = speakerStream(media);
    const key = turnsKey(file, info, audioStream);
    const dir = ctx.paths.waveforms(projectId);
    const saved = turnsFile(ctx, projectId, key);
    const analyse = async (signal: AbortSignal): Promise<SpeakerTurn[]> => {
      signal.throwIfAborted();
      try {
        const result: SpeakerTurn[] = JSON.parse(await readFile(saved, "utf8"));
        if (Array.isArray(result) && result.every(t => t && Number.isFinite(t.start) && Number.isFinite(t.end) && t.end > t.start && Number.isInteger(t.speaker) && t.speaker >= 0)) return result;
      } catch { /* An absent or incomplete cache can be rebuilt from the source. */ }
      const reuse = decoded && decoded.size === info.size && decoded.mtimeMs === info.mtimeMs && decoded.ctimeMs === info.ctimeMs &&
        matchesSpeakerStream(media, decoded.audioStream);
      const wav = reuse ? decoded.wav : join(ctx.paths.tmp, randomUUID() + ".wav");
      const tmp = saved + "." + randomUUID() + ".tmp";
      const report = (progress: SpeakerProgress | null) => {
        const previous = this.active.get(media.id)?.progress;
        if (progress && previous?.phase === progress.phase && previous.percent === progress.percent) return;
        if (progress) this.active.set(media.id, { projectId, progress });
        else this.active.delete(media.id);
        ctx.bus.publish({ type: "media.speakerProgress", projectId, active: this.progressFor(projectId) });
      };
      try {
        // Follow the program audio used to transcribe this file. For confirmed
        // three-input recordings, the two isolated microphones identify its mix.
        if (!reuse) {
          report({ phase: "audio" });
          await extractWav(file, wav, { audioStream, signal, progress: media.duration ? {
            duration: media.duration, onProgress: part => report({ phase: "audio", percent: Math.floor(part * 100) }),
          } : undefined });
        }
        report({ phase: "models" });
        const models = await Promise.all([this.segmentation.get(signal), this.embedding.get(signal)]);
        const args = isSea() ? [] : [fileURLToPath(new URL("../../dist/cli.js", import.meta.url))];
        const diarize = (cpuOnly: boolean) => run(process.execPath, [...args, "diarize-audio", wav, ...models, ...(cpuOnly ? ["cpu"] : [])], { signal,
          onMessage: message => {
            const progress = SpeakerProgress.safeParse(message);
            if (progress.success) report(progress.data);
          },
        });
        // Speaker analysis is a long local model run. It takes its turn in the engine's audio lane unless the machine
        // has cores for both. It runs on the GPU runtime when one is bundled, and again on the CPU in a fresh worker
        // if that fails.
        const started = Date.now();
        const turn = <T>(job: () => Promise<T>) => this.beside ? job() : audioLane(ctx).run({ mediaId: media.id, kind: "speakers" }, signal, job);
        const bytes = await turn(async () => {
          if (this.gpuFailed || !speakerGpuRuntime()) return diarize(this.gpuFailed);
          try { return await diarize(false); }
          catch (error) {
            signal.throwIfAborted();
            ctx.log(`[speakers] An analysis failed on the GPU runtime and runs again on the CPU: ${(error as Error).message}`);
            // Only the same analysis finishing on the CPU shows the failure was the GPU runtime's. Audio the worker
            // can't read fails there too: that error is thrown, and the next recording tries the GPU runtime again.
            const onCpu = await diarize(true);
            this.gpuFailed = true;
            ctx.log("[speakers] That analysis finished on the CPU, so speaker analysis uses the CPU until Scarlet restarts.");
            return onCpu;
          }
        });
        const turns = numberSpeakers(JSON.parse(bytes.toString()));
        if (Date.now() - started >= 30_000) ctx.log(`[speakers] ${media.id}: analysed in ${humanDuration(Date.now() - started)}`);
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, JSON.stringify(turns));
        signal.throwIfAborted();
        await rename(tmp, saved);
        return turns;
      } finally {
        report(null);
        await Promise.all([!reuse && rm(wav, { force: true }), rm(tmp, { force: true })]);
      }
    };
    const analysis = this.cache.get(key, async () => {
      const stop = new AbortController();
      const stopped = () => stop.abort(always.reason);
      const paused = () => { if (!this.passWaits.has(media.id)) stop.abort(pause.reason); };
      if (always.aborted) stopped(); else always.addEventListener("abort", stopped, { once: true });
      if (pause.aborted) paused(); else pause.addEventListener("abort", paused, { once: true });
      try { return await analyse(stop.signal); }
      finally {
        always.removeEventListener("abort", stopped);
        pause.removeEventListener("abort", paused);
      }
    }, { priority });
    const ended = analysis.then(() => undefined, () => undefined);
    this.analyses.set(ended, { projectId, mediaId: media.id, priority });
    void ended.then(() => this.analyses.delete(ended));
    return analysis;
  }

  /**
   * Resolves once no analysis a dialogue pass is waiting for is still running. A pass's first scan page of each
   * recording waits for that recording's speakers, and the analysis slows beside other audio work: 15 s alone for
   * ten minutes of audio, 19 to 25 s beside the aligner, and nearly three minutes for a 58-minute recording while a
   * second recording's alignment and pages ran. So a pass's alignment turns and the pages after its first let the
   * speakers finish. Nothing past that first page can be read sooner anyway.
   *
   * That covers the analyses already running for the pass's project too. A pass asks for one recording's pages, then
   * the next one's minutes later, and until it asked, the second recording's analysis ran beside the first one's
   * whole scan: 3 min 24 s for the 58-minute camera recording, whose first page the pass then waited a minute for.
   * An analysis still queued behind others isn't waited for unless a pass asked for it.
   */
  async awaitedByPass(projectId?: string): Promise<void> {
    const asked = () => [...this.analyses].filter(([, a]) => a.priority).map(([ended]) => ended);
    await Promise.all([...asked(), ...[...this.analyses].filter(([, a]) => a.projectId === projectId && this.active.has(a.mediaId)).map(([ended]) => ended)]);
    while (asked().length) await Promise.all(asked());
  }

  /**
   * Start finding a recording's speakers as its transcription starts, when that can run beside it. The analysis
   * needs only the audio, and a pass that begins before the transcript is done finds its first page's speakers ready.
   */
  begin(ctx: Ctx, projectId: string, media: MediaAsset): void {
    if (!this.beside || ctx.settings().transcription.provider === "none" || (!media.hasAudio && media.kind !== "audio")) return;
    void ctx.track(this.turns(ctx, projectId, media).catch(err => {
      if (!ctx.mediaSignal(projectId).aborted) ctx.log(`[speakers] ${media.id}: ${err instanceof Error ? err.message : err}`);
    }));
  }

  /** Publish a new transcript revision so already-open transcript pages refresh.
   * The original text remains available throughout inference and after a failure.
   * A transcript still being aligned is rewritten in place each turn, so its labelled copy waits for the last.
   * `held`: a pause of the project's media work holds the project's transcripts (`transcriptionHeld`), and their
   * labels with them. Paused but not held, a request under way reads these labels, so they are made as a pass's are. */
  ensure(ctx: Ctx, projectId: string, media: MediaAsset, t: Pick<Transcript, "id" | "speakerAnalysis" | "aligning">, decoded: DecodedRecording | undefined, held: boolean): Promise<void> {
    if (t.aligning || t.speakerAnalysis?.version === speakerAnalysisVersion || ctx.settings().transcription.provider === "none" ||
        (!media.hasAudio && media.kind !== "audio") || held || ctx.projectSignal(projectId).aborted) return Promise.resolve();
    const key = JSON.stringify([projectId, media.id, t.id, speakerStream(media)]);
    const running = this.revisions.get(key);
    if (running) return running;
    if ((this.retryAfter.get(key) ?? 0) > Date.now()) return Promise.resolve();
    const awaited = !!ctx.repos.projects.header(projectId)?.mediaPaused;
    const job = ctx.track((async () => {
      const turns = await this.turns(ctx, projectId, media, decoded, awaited);
      ctx.db.transaction(() => {
        const current = ctx.repos.projects.getMedia(media.id);
        if (!current || current.projectId !== projectId || current.path !== media.path || speakerStream(current) !== speakerStream(media)) return;
        const linkedId = current.transcriptId ?? (ctx.db.prepare(
          "SELECT id FROM transcripts WHERE media_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(media.id, projectId) as { id: string } | undefined)?.id;
        if (linkedId !== t.id) return;
        const original = ctx.repos.transcripts.get(t.id);
        if (!original || original.aligning || original.speakerAnalysis?.version === speakerAnalysisVersion) return;
        const annotated = labelTranscript(original, turns);
        const id = newId("trs");
        ctx.repos.transcripts.put({ ...annotated, id, projectId, createdAt: new Date().toISOString() });
        const saved = ctx.repos.projects.putMedia(projectId, { ...current, transcriptId: id }, current.status, current.error);
        ctx.bus.publish({ type: "media.updated", projectId, media: saved });
      }, "immediate")();
      this.retryAfter.delete(key);
    })().catch(err => {
      // A pause can't have stopped an analysis made for a request under way, so its failure is one.
      if (!(awaited ? ctx.projectSignal(projectId) : ctx.mediaSignal(projectId)).aborted) {
        if (this.retryAfter.size >= 256) this.retryAfter.delete(this.retryAfter.keys().next().value!);
        this.retryAfter.set(key, Date.now() + 5 * 60_000);
        ctx.log(`[speakers] ${media.id}: ${err instanceof Error ? err.message : err}`);
      }
    }).finally(() => this.revisions.delete(key)));
    this.revisions.set(key, job);
    return job;
  }
}
