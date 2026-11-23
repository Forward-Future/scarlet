import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { applyWordFixes, type Task } from "@scarlet/shared";
import { newId, TranscriptWordFix, type MediaAsset, type Transcript, type TranscriptSegment } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { humanDuration, logId } from "../logText.js";
import { extractWav } from "../render/ffmpeg.js";
import type { MediaWithStatus } from "../repo/projects.js";
import { recordTaskFinished } from "../telemetry/events.js";
import { FRAME_SECONDS } from "../transcribe/ctcAlign.js";
import { EmissionFile } from "../transcribe/emissions.js";
import { availableTranscriptionProvider, effectiveProviderName, getTranscriptionProvider, type TranscriptionProvider } from "../transcribe/index.js";
import { putBackTidiedWords } from "../transcribe/saidWords.js";
import { fillTranscriptHoles } from "../transcribe/transcriptHoles.js";
import { alignmentVersion, alignsLanguage, alignTranscript, measureInTurn, readsEnglishSpeech, type AlignmentCheckpoint } from "../transcribe/wordAlign.js";
import { errorMessage } from "../util.js";
import { audioLane, whisperLane, type AudioLane, type AudioWork } from "./audioWork.js";
import { scanAheadOfPasses } from "./dialoguePrefetch.js";
import { quietProgress } from "./progressSave.js";
import { emissionStore } from "./recordingAudio.js";
import { matchesSpeakerStream } from "./recordingSpeakers.js";
import { createTask, hasTranscript, saveTask } from "./tasks.js";
import { claimTranscriptionWork, openTranscriptionWork, transcriptionIdentity, type TranscriptionResume } from "./transcriptionWork.js";

/**
 * A quit between preparing a recording and beginning its transcription can leave it ready without a job.
 * Check recent imports at startup. An explicit project resume also takes up older authorized imports.
 */
export async function recoverImportTranscriptions(ctx: Ctx, projectId?: string) {
  const since = projectId ? null : new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const waiting = ctx.db.prepare(`SELECT m.id FROM media m JOIN projects p ON p.id = m.project_id
    WHERE m.status = 'ready' AND (? IS NULL OR m.created_at > ?) AND p.deleted_at IS NULL AND NOT p.media_paused AND NOT p.archived
      AND (? IS NULL OR p.id = ?)
      AND json_extract(m.json, '$.transcriptionOnImport') IS NOT NULL AND json_extract(m.json, '$.transcriptId') IS NULL
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.kind = 'transcribe' AND t.project_id = m.project_id AND json_extract(t.json, '$.context.mediaId') = m.id)
      AND NOT EXISTS (SELECT 1 FROM transcripts s WHERE s.media_id = m.id)
    ORDER BY m.created_at`).all(since, since, projectId, projectId) as Array<{ id: string }>;
  for (const { id } of waiting) {
    if (ctx.shutdown.aborted) return;
    const media = ctx.repos.projects.getMedia(id);
    if (!media) continue;
    const job = await startImportTranscription(ctx, media.projectId, media);
    if (job) ctx.track(job.done.catch(() => null), media.projectId);
  }
}

/** The policy, the project and the recording must still qualify when the job is claimed. */
export async function startImportTranscription(ctx: Ctx, projectId: string, asset: MediaAsset) {
  if (!asset.transcriptionOnImport || asset.hasAudio === false || asset.kind === "image") return;
  const policy = ctx.repos.settings.transcriptionPolicy();
  if (asset.transcriptionOnImport !== policy.settings.provider || asset.transcriptionRevisionOnImport !== policy.revision) return;
  const provider = await availableTranscriptionProvider(ctx, policy);
  if (!provider) return;
  const checked = ctx.db.transaction(() => {
    ctx.settings();
    if (ctx.shutdown.aborted || policy.signal.aborted) return;
    const project = ctx.repos.projects.header(projectId);
    const current = ctx.repos.projects.getMedia(asset.id);
    if (!project || project.mediaPaused || project.archived || current?.status !== "ready" || current.projectId !== projectId ||
        current.transcriptionOnImport !== provider.name || current.transcriptionRevisionOnImport !== policy.revision ||
        current.transcriptId || hasTranscript(ctx, asset.id) || latestTranscription(ctx, projectId, asset.id)) return;
    return { current, claim: claimTranscription(ctx, projectId, current, provider, provider.name) };
  }, "immediate")();
  if (checked) return runClaimedTranscription(ctx, projectId, checked.current, checked.claim);
}

/**
 * Whether a pause of the project's media work holds its transcriptions, and the speaker labels of its transcripts. It
 * doesn't while Scarlet is working on a request there: the editor asked for that request, a pass can't plan or cut
 * without its transcripts, and pausing the caching isn't stopping it. With no request under way the pause stops a
 * transcription, also as it starts, and resume starts it again. Only a request that edits the project counts: a
 * skill's edit only borrows the project, and the read of a request for a standing rule uses no transcript.
 */
export function transcriptionHeld(ctx: Ctx, projectId: string): boolean {
  return !!ctx.repos.projects.header(projectId)?.mediaPaused &&
    !ctx.repos.tasks.count("project_id = ? AND kind IN ('edit','revise','note') AND state IN ('claimed','running')", [projectId]);
}

/** Stop the transcriptions a pause of the project holds. Each reads as interrupted, and starts again on resume. */
export function holdTranscriptions(ctx: Ctx, projectId: string): void {
  if (!transcriptionHeld(ctx, projectId)) return;
  for (const task of ctx.repos.tasks.runningTranscriptions(projectId)) {
    ctx.transcriptions.get(task.id)?.controller.abort(new Error("Project media processing stopped."));
  }
}

/** The recording's most recent transcription task in the project, whatever state it is in. */
export function latestTranscription(ctx: Ctx, projectId: string, mediaId: string): Task | undefined {
  return ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?",
    [projectId, mediaId], "created_at DESC, rowid DESC LIMIT 1")[0];
}

/** `startTranscription(...).done`, for tests and benchmarks. */
export function transcribeMedia(ctx: Ctx, projectId: string, asset: MediaAsset, providerOverride?: string): Promise<Transcript | null> {
  return startTranscription(ctx, projectId, asset, providerOverride).done;
}

/**
 * Run transcription for an asset as a server-side `transcribe` task, store the transcript and link it on the asset.
 * Hands back the task row at once, and a promise for the transcript.
 */
export function startTranscription(
  ctx: Ctx,
  projectId: string,
  asset: MediaAsset,
  providerOverride?: string,
  whilePaused: "interrupt" | "refuse" = "interrupt",
  resume?: TranscriptionResume | "missing",
): { task: Task; done: Promise<Transcript | null> } {
  const policy = ctx.repos.settings.transcriptionPolicy();
  const name = effectiveProviderName(policy.settings.provider, providerOverride);
  return startWithProvider(ctx, projectId, asset, getTranscriptionProvider(ctx, providerOverride, policy), name, providerOverride, whilePaused, resume);
}

/**
 * The first-cut dialogue scan keeps its own window transcripts. Start the editor's transcript of the same
 * source alongside it, so Media and the transcript pane don't wait for a separate Transcribe click.
 */
export function transcribeForDialogue(ctx: Ctx, projectId: string, media: MediaAsset): Task | null {
  if (media.kind === "image" || media.hasAudio === false || transcriptionHeld(ctx, projectId)) return null;
  if (hasTranscript(ctx, media.id)) return null;
  const provider = getTranscriptionProvider(ctx);
  if (!provider) return null;
  const { task, done } = startWithProvider(ctx, projectId, media, provider, provider.name, undefined, "interrupt", "missing");
  ctx.track(done.catch(() => null), projectId);
  return task.state === "failed" ? null : task;
}

function startWithProvider(ctx: Ctx, projectId: string, asset: MediaAsset, provider: TranscriptionProvider | null, name: string, chosen?: string,
  whilePaused: "interrupt" | "refuse" = "interrupt", resume?: TranscriptionResume | "missing") {
  const claim = ctx.db.transaction(() => claimTranscription(ctx, projectId, asset, provider, name, chosen, whilePaused, resume), "immediate")();
  return runClaimedTranscription(ctx, projectId, asset, claim);
}

/** Called with the write lock held. Keep an explicitly selected provider for an interrupted job. */
function claimTranscription(ctx: Ctx, projectId: string, asset: MediaAsset, provider: TranscriptionProvider | null, name: string, chosen?: string,
  whilePaused: "interrupt" | "refuse" = "interrupt", resume?: TranscriptionResume | "missing") {
  const project = ctx.repos.projects.header(projectId);
  if (!project) throw notFound(`project ${projectId}`);
  if (whilePaused === "refuse" && project.mediaPaused) throw conflict("media_paused", "Resume caching to transcribe this recording.");
  const [active] = ctx.repos.tasks.runningTranscriptions(projectId, asset.id);
  if (active) return { task: active, started: false };
  let inherit = resume === "missing" ? undefined : resume;
  if (resume === "missing" || inherit?.interrupted) {
    // Another engine may have recovered and even finished this job since the recovery sweep listed it.
    const latest = latestTranscription(ctx, projectId, asset.id);
    if (inherit?.interrupted && latest && latest.id !== inherit.interrupted.id) return { task: latest, started: false };
    if (resume === "missing" && latest?.state === "done" && hasTranscript(ctx, asset.id)) return { task: latest, started: false };
    // A resumed pass can ask for its missing transcript while caching is paused, before the recovery sweep runs.
    // Its preparation is the same interrupted job, including when a pause stops it again before its first chunk.
    if (resume === "missing" && latest?.state === "failed" && latest.interrupted) {
      chosen = latest.context.transcriptionProvider;
      if (chosen && chosen !== name) {
        const policy = ctx.repos.settings.transcriptionPolicy();
        name = effectiveProviderName(policy.settings.provider, chosen);
        provider = getTranscriptionProvider(ctx, chosen, policy);
      }
      const ranWith = latest.context.transcribedWith;
      if (!provider || (name !== "whispercpp" && ranWith && name !== ranWith)) {
        return { task: latest, started: false };
      }
      inherit = { interrupted: latest };
    }
  }
  const task = createTask(ctx, {
    projectId, kind: "transcribe", agent: "api", instruction: `Transcribe ${asset.name}`,
    context: { mediaId: asset.id, transcribedWith: name, localModel: provider?.localModel, ...(chosen && { transcriptionProvider: chosen }) }, createdBy: { type: "scarlet", name: "Scarlet" }, state: "running",
  });
  ctx.db.prepare("UPDATE tasks SET worker_pid = ?, worker_seen_at = ? WHERE id = ?").run(process.pid, now(), task.id);
  claimTranscriptionWork(ctx, asset.id, task, inherit);
  return { task, started: true, provider, name };
}

function runClaimedTranscription(ctx: Ctx, projectId: string, asset: MediaAsset, { task, started, provider, name }: ReturnType<typeof claimTranscription>) {
  if (!started) return { task, done: ctx.transcriptions.get(task.id)?.done ?? Promise.resolve(null) };
  if (!provider) {
    const failed = saveTask(ctx, {
      ...task,
      state: "failed",
      error: `transcription provider "${name}" is not configured`,
      finishedAt: now(),
    });
    recordTaskFinished(ctx, failed);
    ctx.log(`[transcribe] ${asset.id} failed: ${failed.error}`);
    return { task: failed, done: Promise.resolve(null) };
  }
  const controller = new AbortController();
  const done = runTranscription(ctx, projectId, asset, provider, task, controller).finally(() => ctx.transcriptions.delete(task.id));
  ctx.transcriptions.set(task.id, { controller, done });
  return { task, done };
}

/**
 * One progress figure for a transcription and its word alignment, saved on the task so Media and a run
 * waiting for the transcript can show it. Ten minutes of dialogue took about 25 s in local Whisper and
 * 50 s in word alignment on a Core Ultra 9, so Whisper is the first third. A cloud provider only uploads.
 * `rereads`: local Whisper reads an English recording again a minute at a time for the words its transcript tidied
 * away (saidWords.ts), which took as long as alignment on 45-minute recordings (2026-11-19), so it is the last third
 * and alignment the middle one. Without it, a bar at 100% sat there for a quarter of an hour.
 * `words` is the same figure for the words alone, which is all a dialogue pass waits for.
 */
export function transcriptionProgress(ctx: Ctx, task: Task, provider: TranscriptionProvider["name"], rereads = false) {
  type Stage = NonNullable<Task["progress"]>["stage"];
  const share = provider === "whispercpp" ? 1 / 3 : 1 / 2;
  const aligned = provider === "whispercpp" && rereads ? 2 / 3 : 1;
  let started: { at: number; fraction: number; words: number } | undefined;
  let saved: { stage: Stage; percent: number; at: number } | undefined;
  function save(stage: Stage, fraction: number, words: number) {
    const at = performance.now();
    if (stage !== "queued") started ??= { at, fraction, words };
    const percent = Math.floor(fraction * 100);
    // A new stage saves at once. Within one, a whole percent more at most once a second, or a jump of five.
    if (saved?.stage === stage && (percent <= saved.percent || (at - saved.at < 1000 && percent < saved.percent + 5))) return;
    saved = { stage, percent, at };
    const elapsed = started === undefined ? 0 : (at - started.at) / 1000;
    const left = (done: number, initial = 0) => elapsed >= 5 && done - initial >= 0.02 && done < 1
      ? Math.ceil(elapsed * (1 - done) / (done - initial)) : undefined;
    quietProgress(ctx, `transcription progress (${task.id})`, () => ctx.db.transaction(() => {
      const current = ctx.repos.tasks.get(task.id);
      if (current?.state === "running") saveTask(ctx, { ...current, progress: { stage, fraction: Math.min(1, fraction), remainingSeconds: left(fraction, started?.fraction),
        words: { fraction: Math.min(1, words), remainingSeconds: left(words, started?.words) } } });
    }, "immediate")());
  }
  return {
    queued: () => save("queued", 0, 0),
    transcribing: (fraction: number) => save("transcribing", fraction * share, fraction),
    aligning: (fraction: number) => save("aligning", share + fraction * (aligned - share), 1),
    rereading: (fraction: number) => save("aligning", aligned + fraction * (1 - aligned), 1),
  };
}

interface PostAlignContext {
  ctx: Ctx;
  projectId: string;
  asset: MediaAsset;
  src: string;
  wav: string | undefined;
  provider: TranscriptionProvider;
  language: string | undefined;
  lane: AudioLane;
  work: AudioWork;
  alignment: AudioWork;
  signal: AbortSignal;
}

/**
 * Once the words are placed, the recording shows what their times still miss. A word the aligner couldn't place
 * keeps the provider's time, which can run over a wait, so it is brought in to its sound. Local Whisper can also
 * skip a remark after a long wait: sound at speaking level with no word on it. Those stretches are read again, and
 * the transcript is saved with what they held. A read that fails leaves the transcript as it was aligned.
 */
async function fillAlignedHoles(p: PostAlignContext, alignable: boolean, segments: TranscriptSegment[]): Promise<TranscriptSegment[]> {
  if (!alignable) return segments;
  const full = p.wav ?? join(p.ctx.paths.tmp, newId("recording") + ".wav");
  try {
    if (!p.wav) await extractWav(p.src, full, { signal: p.signal, audioStream: p.asset.audioTrack, audioStreamCount: p.asset.audioStreams?.length });
    return await fillTranscriptHoles({
      wav: full, segments, tmpDir: p.ctx.paths.tmp, signal: p.signal,
      log: message => p.ctx.log(`${message} (${p.asset.id})`),
      read: p.provider.name !== "whispercpp" ? undefined : async laid =>
        (await p.lane.run(p.work, p.signal, () => p.provider.transcribe({ path: laid, dialogueWindow: {}, tmpDir: p.ctx.paths.tmp, signal: p.signal, language: p.language }))).segments,
      align: async found => alignTranscript(p.ctx, {
        source: p.src, wav: full, audioStream: p.asset.audioTrack, audioStreamCount: p.asset.audioStreams?.length,
        language: p.language, segments: found, signal: p.signal,
        emissions: await emissionStore(p.ctx, p.projectId, p.src, p.asset.audioTrack), work: p.alignment,
      }),
    });
  } catch (error) {
    p.signal.throwIfAborted();
    p.ctx.log(`[transcribe] ${p.asset.id}: couldn’t read the stretches without words again: ${errorMessage(error)}`);
    return segments;
  } finally {
    if (!p.wav) await rm(full, { force: true });
  }
}

/**
 * Whisper writes what was meant: "the logo, the Coco, the Coca-Cola logo" came out "the logo, the Coca-Cola logo",
 * the second take's sound read as a pause, and a pass trimmed it and left both takes playing. Read again a minute
 * at a time in hesitant speech, what the transcript tidied away goes back where the aligner hears it (saidWords.ts).
 */
async function restoreTidiedWords(
  p: PostAlignContext,
  alignable: boolean,
  alignmentFailed: boolean,
  onProgress: (fraction: number) => void,
  segments: TranscriptSegment[],
): Promise<TranscriptSegment[]> {
  if (!alignable || alignmentFailed || p.provider.name !== "whispercpp" || !readsEnglishSpeech(p.language)) return segments;
  const full = p.wav ?? join(p.ctx.paths.tmp, newId("recording") + ".wav");
  const file = await emissionStore(p.ctx, p.projectId, p.src, p.asset.audioTrack);
  let store: EmissionFile | null = null;
  const opened = async () => store ??= await EmissionFile.open(file);
  try {
    if (!p.wav) await extractWav(p.src, full, { signal: p.signal, audioStream: p.asset.audioTrack, audioStreamCount: p.asset.audioStreams?.length });
    return await putBackTidiedWords({
      wav: full, segments, tmpDir: p.ctx.paths.tmp, signal: p.signal,
      log: message => p.ctx.log(`${message} (${p.asset.id})`),
      onProgress,
      read: async (page, prompt) =>
        (await p.lane.run(p.work, p.signal, () => p.provider.transcribe({ path: page, dialogueWindow: { prompt }, tmpDir: p.ctx.paths.tmp, signal: p.signal, language: p.language }))).segments,
      frames: async (start, end) => {
        let emissions = await opened();
        if (!emissions) return undefined;
        const [from, to] = emissions.frameRange(start, end);
        if (emissions.missing(from, to).length) {
          await measureInTurn(p.ctx, { file, wav: async () => full }, [{ start, end }], p.signal, p.alignment);
          await emissions.close();
          store = null;
          emissions = await opened();
          if (!emissions || emissions.missing(from, to).length) return undefined;
        }
        return { logProbs: await emissions.read(from, to), frames: to - from, origin: from * FRAME_SECONDS };
      },
    });
  } catch (error) {
    p.signal.throwIfAborted();
    p.ctx.log(`[transcribe] ${p.asset.id}: couldn’t read the recording again for the words its transcript tidied away: ${errorMessage(error)}`);
    return segments;
  } finally {
    await (store as EmissionFile | null)?.close();
    if (!p.wav) await rm(full, { force: true });
  }
}

async function runTranscription(ctx: Ctx, projectId: string, asset: MediaAsset, provider: TranscriptionProvider, task: Task, controller: AbortController): Promise<Transcript | null> {
  // Trash and a quit stop it. So does `controller`: its task was cancelled, or a pause holds the project's transcriptions.
  const interrupted = AbortSignal.any([ctx.projectSignal(projectId), controller.signal]);
  // A local model can be changed while its audio is queued or while the old model's first words are being aligned.
  const signal = AbortSignal.any([interrupted, ctx.repos.settings.transcriptionSignal]);
  if (transcriptionHeld(ctx, projectId)) controller.abort(new Error("Project media processing stopped."));
  const wav = provider.name === "whispercpp" && matchesSpeakerStream(asset)
    ? join(ctx.paths.tmp, newId("recording") + ".wav") : undefined;
  const work: AudioWork = { mediaId: asset.id, kind: "transcript" };
  const alignment: AudioWork = { mediaId: asset.id, kind: "alignment" };
  let labeling: Promise<void> | undefined;
  /** The transcript was saved with its alignment still to come. */
  let early = false;
  const started = Date.now();
  const target = `media=${logId(asset.id)} project=${logId(projectId)} task=${logId(task.id)}`;
  try {
    const src = join(ctx.paths.media(projectId), asset.path);
    const stamp = statSync(src, { throwIfNoEntry: false });
    const checkRunning = () => {
      ctx.settings(); // Another engine may have changed the selected model or cancelled this job.
      if (ctx.repos.tasks.get(task.id)?.state !== "running") controller.abort();
      signal.throwIfAborted();
    };
    const identity = await transcriptionIdentity(ctx, asset, stamp, provider);
    const saved = ctx.db.transaction(() => {
      checkRunning();
      return openTranscriptionWork(ctx, task, identity, checkRunning);
    }, "immediate")();
    early = !!saved.alignment;
    // Whether the recording is read again is known once Whisper names its language; until then the setting says.
    const progress = transcriptionProgress(ctx, task, provider.name, readsEnglishSpeech(ctx.settings().transcription.language === "auto" ? undefined : ctx.settings().transcription.language));
    ctx.speakers.begin(ctx, projectId, asset);
    const recognized = saved.fraction ?? (asset.duration ? Math.min(1, saved.recognition.through / asset.duration) : 0);
    const transcribe = () => {
      ctx.log(`[transcribe] recognition_started ${target} provider=${provider.name}`);
      progress.transcribing(recognized);
      return provider.transcribe({ path: src, audioStream: asset.audioTrack, audioStreamCount: asset.audioStreams?.length,
        duration: asset.duration, tmpDir: ctx.paths.tmp, signal, keepWavAt: wav,
        checkpoint: saved.recognition, onProgress: progress.transcribing, beforeUpload: checkRunning,
      });
    };
    // Local Whisper takes its turn in the audio lane. A cloud provider only uploads, so it runs right away.
    if (saved.alignment) progress.aligning(saved.alignment.fraction ?? 0);
    else if (recognized > 0) progress.transcribing(recognized);
    else if (provider.name === "whispercpp") progress.queued();
    // Word alignment follows. In the same lane, the lane waits for it rather than starting another recording.
    const lane = whisperLane(ctx, provider.separateWhisperLane);
    if (saved.aligned) ctx.log(`[transcribe] recognition_reused ${target} provider=${provider.name}`);
    else if (provider.name === "whispercpp") ctx.log(`[transcribe] recognition_queued ${target} provider=${provider.name}`);
    const result = saved.aligned ?? (provider.name === "whispercpp" ? await lane.run(work, signal, transcribe, { more: lane === audioLane(ctx) }) : await transcribe());
    const configuredLanguage = ctx.settings().transcription.language;
    const language = result.language || (configuredLanguage === "auto" ? undefined : configuredLanguage);
    const alignable = alignsLanguage(language) && result.segments.some(s => s.words.length);
    // A rerun keeps the readable transcript, including a speaker-labelled revision or an older unlinked one,
    // until the replacement is complete. A first transcript can publish its words while alignment runs.
    const previous = ctx.db.prepare(`SELECT t.id, json_extract(t.json, '$.aligning') IS NULL AS complete
      FROM media m JOIN transcripts t ON t.media_id = m.id AND t.project_id = m.project_id
      WHERE m.id = ? AND m.project_id = ? AND t.id = COALESCE(json_extract(m.json, '$.transcriptId'), t.id)
      ORDER BY t.created_at DESC LIMIT 1`).get(asset.id, projectId) as { id: string; complete: number } | undefined;
    const replacing = previous?.complete === 1;
    const id = replacing ? newId("trs") : previous?.id ?? newId("trs");
    const model = provider.localModel === "custom" ? result.modelLabel ?? provider.modelLabel : provider.modelLabel;
    let alignmentFailed = false;
    /** Save the transcript and link it on the recording. `aligning`: how far its word times are final. Absent, the job is done. */
    const save = (segments: TranscriptSegment[], aligning?: AlignmentCheckpoint) => ctx.db.transaction(() => {
      ctx.settings(); // Observe a model change saved by another engine before committing this revision.
      signal.throwIfAborted();
      if (ctx.repos.tasks.get(task.id)?.state !== "running") return null;
      if (aligning) {
        saved.saveAlignment(aligning, { segments, language, modelLabel: model }, replacing ? undefined : id);
        if (replacing) return null; // The previous completed transcript remains the readable one.
      }
      const savedAt = now();
      // Spellings the editor corrected on the transcript this one replaces, or on this one while it was aligned, read the same.
      const fixes = editorWordFixes(ctx, projectId, asset.id, id);
      const transcript: Transcript = { id, mediaId: asset.id, language, provider: provider.name, localModel: provider.localModel, modelLabel: model,
        segments: fixes ? applyWordFixes({ id, mediaId: asset.id, segments }, fixes).segments : segments, ...(fixes && { wordFixes: fixes }),
        createdAt: savedAt, ...(aligning ? { aligning: { through: aligning.through } } : alignable && !alignmentFailed && { alignment: alignmentVersion }) };
      ctx.repos.transcripts.put({ ...transcript, projectId });
      const current = ctx.repos.projects.getMedia(asset.id);
      let speakerSource: MediaAsset | undefined;
      if (current) {
        speakerSource = current;
        // Each turn of alignment rewrites the same transcript. Tell open pages when it appears and when it is final.
        if (current.transcriptId !== id || !aligning) {
          const { status, error, projectId: _p, ...a } = current;
          speakerSource = ctx.repos.projects.putMedia(projectId, { ...a, transcriptId: id,
            ...(!aligning && { lastTranscription: { completedAt: savedAt, model } }) }, status, error);
          ctx.bus.publish({ type: "media.updated", projectId, media: speakerSource });
        }
      }
      if (!aligning) recordTaskFinished(ctx, saveTask(ctx, { ...task, state: "done", summary: `${segments.length} segments`, finishedAt: savedAt }));
      return { transcript, speakerSource };
    }, "immediate")();
    // ASR word times drift by 100–300 ms, and alignment places each word on the recorded audio. On a long recording
    // that takes several times as long as Whisper, so the words are saved first: a dialogue pass reads them and its
    // scan pages run while alignment goes on. `aligning.through` says how far the times are final, and whatever
    // turns a word into a cut edge waits for alignment to pass it.
    // Whisper kept the lane for alignment, which this recording won't have: its speakers needn't wait out the hold.
    if (!alignable && provider.name === "whispercpp") lane.finish(work);
    if (alignable && !saved.alignment) early = !!save(result.segments, { through: 0, nextWord: 0, fraction: 0 });
    progress.aligning(saved.alignment?.fraction ?? 0);
    // The old process's scratch WAV is gone. Recreate the shared decode before alignment or the gap check reads it.
    if (saved.aligned && wav) await extractWav(src, wav, { signal, audioStream: asset.audioTrack, audioStreamCount: asset.audioStreams?.length });
    // While a pass is reading this recording, its alignment lets the speakers a pass waits for finish first
    // (RecordingSpeakers.awaitedByPass). Nothing a pass reads needs word times before its first page.
    // A pass reading any recording of the project counts: it turns to this one next, and its first page here waits
    // for these speakers just the same.
    const passReading = () => ctx.repos.projects.hasAnyMedia(projectId, audioLane(ctx).focusedMediaIds());
    const speakersFirst = () => ctx.speakers.beside && passReading() ? ctx.speakers.awaitedByPass(projectId) : undefined;
    let publishedThrough = saved.alignment?.through ?? 0;
    const finishedAlignment = saved.alignment?.complete;
    const aligned = finishedAlignment ? result.segments : await alignTranscript(ctx, { source: src, wav, audioStream: asset.audioTrack, audioStreamCount: asset.audioStreams?.length, language, segments: result.segments, signal, resume: saved.alignment,
      emissions: alignable ? await emissionStore(ctx, projectId, src, asset.audioTrack) : undefined, hold: speakersFirst,
      work: alignment, onProgress: progress.aligning,
      onFailure: () => { alignmentFailed = true; },
      onTurn: (soFar, through, cursor) => {
        publishedThrough = through;
        save(soFar, cursor);
      } });
    // A gap reread may still insert words. Keep the public boundary where readers last saw it while saving
    // the finished alignment so a quit during the reread only repeats that final check.
    if (alignable && provider.name === "whispercpp" && !finishedAlignment && !alignmentFailed) {
      save(aligned, { through: publishedThrough, fraction: 1, complete: true });
    }
    const postCtx: PostAlignContext = { ctx, projectId, asset, src, wav, provider, language, lane, work, alignment, signal };
    const stored = save(await restoreTidiedWords(postCtx, alignable, alignmentFailed, progress.rereading, await fillAlignedHoles(postCtx, alignable, aligned)));
    // The run was cancelled while it aligned, so nobody will finish: the saved transcript keeps the times it has.
    if (!stored && early) keepTimes(ctx, asset.id, task.id);
    if (stored?.speakerSource) {
      const decoded = wav && stamp && asset.path === stored.speakerSource.path
        ? { wav, size: stamp.size, mtimeMs: stamp.mtimeMs, ctimeMs: stamp.ctimeMs } : undefined;
      labeling = ctx.speakers.ensure(ctx, projectId, stored.speakerSource, stored.transcript, decoded, transcriptionHeld(ctx, projectId));
    }
    // The first pass on this recording finds its pages read.
    if (stored && !interrupted.aborted) scanAheadOfPasses(ctx, projectId);
    ctx.log(stored
      ? `[transcribe] ${asset.id} done in ${humanDuration(Date.now() - started)}: ${stored.transcript.segments.length} segments`
      : `[transcribe] ${asset.id} finished in ${humanDuration(Date.now() - started)} but was discarded: ${task.id} was no longer running`);
    return stored?.transcript ?? null;
  } catch (e) {
    const message = errorMessage(e);
    ctx.log(`[transcribe] ${asset.id} ${interrupted.aborted ? "interrupted" : "failed"} after ${humanDuration(Date.now() - started)}: ${message}`);
    const running = ctx.repos.tasks.get(task.id)?.state === "running";
    if (running) {
      recordTaskFinished(ctx, saveTask(ctx, { ...task, state: "failed", interrupted: interrupted.aborted || undefined,
        error: interrupted.aborted ? "Transcription was interrupted." : message, finishedAt: now() }));
    }
    // An interruption keeps the cursor. Any other ending leaves nobody to finish the
    // alignment, so the transcript keeps the times it has.
    if (early && !(running && interrupted.aborted)) keepTimes(ctx, asset.id, task.id);
    throw e;
  } finally {
    audioLane(ctx).finish(work, alignment);
    if (wav) {
      const remove = () => rm(wav, { force: true });
      // Make the transcript available immediately, and retain the scratch file for the worker reading it.
      if (labeling) ctx.track(labeling.finally(remove), projectId).catch(error => ctx.log(`[speakers] audio cleanup: ${error}`));
      else await remove();
    }
  }
}

/**
 * The fixes the editor made to a recording's words: on the transcript being written (fixed while it was aligned), else
 * on the one it replaces. Applied to Whisper's words as each save writes them.
 */
function editorWordFixes(ctx: Ctx, projectId: string, mediaId: string, id: string): TranscriptWordFix[] | undefined {
  const row = ctx.db.prepare(`SELECT json_extract(t.json, '$.wordFixes') AS fixes FROM transcripts t
    WHERE t.project_id = ? AND t.media_id = ? AND json_extract(t.json, '$.wordFixes') IS NOT NULL
      AND (t.id = ? OR t.id = (SELECT json_extract(m.json, '$.transcriptId') FROM media m WHERE m.id = ?))
    ORDER BY t.id = ? DESC, t.created_at DESC LIMIT 1`).get(projectId, mediaId, id, mediaId, id) as { fixes: string } | undefined;
  if (!row) return undefined;
  const fixes = TranscriptWordFix.array().safeParse(JSON.parse(row.fixes));
  return fixes.success && fixes.data.length ? fixes.data : undefined;
}

/** Stop waiting for word alignment on a recording's transcript: its times are as final as they will get. */
function keepTimes(ctx: Ctx, mediaId: string, owner?: string) {
  ctx.db.transaction(() => {
    if (owner && ctx.repos.tasks.select("kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?",
      [mediaId], "created_at DESC, rowid DESC LIMIT 1")[0]?.id !== owner) return;
    for (const { aligning: _a, ...transcript } of ctx.repos.transcripts.select("media_id = ? AND json_extract(json, '$.aligning') IS NOT NULL", [mediaId])) {
      ctx.repos.transcripts.put(transcript);
    }
  }, "immediate")();
}

/**
 * A transcript still marked as aligning with no transcription running was left by a run that ended early. Readers
 * wait on that mark, so settle it: continue aligning the saved words when that can start now,
 * and otherwise keep the times it has. A paused project resumes its own transcriptions.
 */
export function settleAlignment(ctx: Ctx, media: MediaWithStatus & { projectId: string }, transcriptId: string) {
  const { projectId } = media;
  if (ctx.repos.tasks.runningTranscriptions(projectId, media.id).length) return;
  if (transcriptionHeld(ctx, projectId)) return;
  const provider = media.status === "ready" ? getTranscriptionProvider(ctx) : null;
  // Reading a transcript never sends a recording to a cloud service, and never repeats a run that failed by itself:
  // both wait for the editor's Retry, and the transcript keeps the times it has.
  const last = latestTranscription(ctx, projectId, media.id);
  if (!provider || provider.name !== "whispercpp" || last?.state === "cancelled" || (last?.state === "failed" && !last.interrupted)) return keepTimes(ctx, media.id);
  // A read may continue an existing local transcript, but a different preset is a new transcription request.
  const partial = ctx.db.prepare(`SELECT json_extract(json, '$.provider') AS provider, json_extract(json, '$.localModel') AS model
    FROM transcripts WHERE id = ? AND media_id = ? AND json_extract(json, '$.aligning') IS NOT NULL`).get(transcriptId, media.id) as
    { provider: string | null; model: string | null } | undefined;
  if (!partial) return;
  if ((partial.provider && partial.provider !== provider.name) || (partial.model && partial.model !== provider.localModel)) return keepTimes(ctx, media.id);
  const { projectId: _p, status: _s, error: _e, ...asset } = media;
  const { task, done } = startWithProvider(ctx, projectId, asset, provider, provider.name, undefined, "interrupt",
    { interrupted: last?.interrupted ? last : undefined, stranded: transcriptId });
  ctx.track(done.catch(() => null), projectId);
  ctx.log(`[transcribe] ${media.id} is continuing its word alignment as ${task.id}`);
}
