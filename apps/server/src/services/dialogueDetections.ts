import { labelTranscript, speakerAnalysisVersion, speakerTurnCacheVersion } from "../transcribe/speakerLabels.js";
import { createHash, randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileInDirectory, speechActivityOf, speechActivityStart } from "@scarlet/render";
import type { DialogueDetections, ServerSettings } from "@scarlet/shared";
import type { MediaAsset, TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { extractWav } from "../render/ffmpeg.js";
import { UhmDetector } from "../transcribe/uhm.js";
import { getTranscriptionProvider } from "../transcribe/index.js";
import { readAcousticWindow } from "../transcribe/acousticWords.js";
import { alignmentVersion, alignsLanguage, alignWords } from "../transcribe/wordAlign.js";
import { bundledWhisperModel } from "../transcribe/localModel.js";
import { resolveLocalRuntime, resolvedBinary, type LocalRuntime } from "../transcribe/localRuntime.js";
import { transcriptLanguage } from "./transcriptReader.js";
import { readSourceEnergy } from "./transcriptSources.js";
import { otherVoiceTurns } from "./otherVoiceTurns.js";
import { appendTaskEvent } from "./tasks.js";
import { AnalysisCache } from "./analysisCache.js";
import { audioLane, whisperLane, type AudioWork } from "./audioWork.js";
import { emissionStore, recordingWav } from "./recordingAudio.js";

const verbatim = "Um, well, uh, I think, I think we should go ahead. Hmm. Yeah.";

function onSourceClock(segments: DialogueDetections["segments"], from: number, to: number) {
  const at = (s: number) => Math.min(to, from + Math.max(0, s));
  return segments.map(s => ({ ...s, start: at(s.start), end: at(s.end),
    words: s.words.map(w => ({ ...w, start: at(w.start), end: at(w.end) })) }));
}

async function fileStamp(path: string) {
  const info = await stat(path);
  return [path, info.size, info.mtimeMs, info.ctimeMs];
}

type ScanEdit = { taskId: string; startedAt?: string };

async function localModelIdentity(runtime: LocalRuntime) {
  if (!runtime.binary) throw conflict("transcription_unavailable", runtime.reason ?? "The local transcription runtime is unavailable.");
  const binary = await resolvedBinary(runtime.binary);
  if (!binary) throw conflict("transcription_unavailable", "The local transcription executable could not be found.");
  // Preserve existing Whisper checkpoints. The preset also depends on its adapter script.
  const model = runtime.model ? fileStamp(runtime.model) : runtime.adapterOwnsModel ? "adapter-owned" : `bundled:${bundledWhisperModel.name}`;
  return Promise.all([fileStamp(binary), model,
    ...(runtime.script ? [fileStamp(runtime.script)] : [])]);
}

/** First-cut-only evidence, kept separate from the editor's transcript and captions. */
export function dialogueDetector(ctx: Ctx) {
  const uhm = new UhmDetector(join(ctx.paths.root, "models"));
  // SQLite owns completed pages. Share in-flight work and run one cold window at a time.
  const acousticWindows = new AnalysisCache<DialogueDetections>(() => 0, 0, 1);
  const keptWindows = new AnalysisCache<DialogueDetections>(r => r.segments.reduce((n, s) => n + 100 * s.words.length, 0), 2 * 1024 * 1024);
  type Page = { analyzed: Promise<DialogueDetections>; ready: Promise<DialogueDetections> };
  const pending = new Map<string, Page>();
  const unalignedPages = new WeakSet<DialogueDetections>();
  function scanEdit(projectId: string, taskId: string, startedAt?: string): ScanEdit {
    const owner = ctx.repos.tasks.get(taskId);
    // A request sent about a point is a note and one sent back is a revision. Both edit, as a whole request does.
    if (!owner || owner.projectId !== projectId || !["edit", "revise", "note"].includes(owner.kind)) throw notFound("edit in this project");
    return { taskId, startedAt: startedAt ?? owner.startedAt };
  }
  function activeEdit(edit: ScanEdit) {
    const task = ctx.repos.tasks.get(edit.taskId);
    if (task && task.startedAt === edit.startedAt && (task.state === "claimed" || task.state === "running")) return task;
  }
  /**
   * What stops a page besides its transcription settings. A page a running edit asked for goes on while the project's
   * media work is paused: the editor asked for that edit, and pausing the caching isn't stopping it. It ends when the
   * edit does, or when the project goes to Trash. A page no edit asked for stops with the pause, like the rest of the
   * work Scarlet does unasked.
   */
  const stops = (projectId: string, edit?: ScanEdit) => edit ? ctx.projectSignal(projectId) : ctx.mediaSignal(projectId);
  function sourceFile(projectId: string, media: MediaAsset, to: number) {
    if (media.kind !== "audio" && !media.hasAudio) throw badRequest("no_audio", "Choose a source with dialogue.");
    if (!media.duration || to > media.duration + 0.000001) throw badRequest("outside_media", "Window exceeds source duration.");
    const file = fileInDirectory(ctx.paths.media(projectId), media.path);
    if (!file) throw notFound("source file");
    return file;
  }
  async function cachedSpeech(projectId: string, media: MediaAsset, file: string, from: number, to: number,
    stream: number | undefined, defaultLanguage: string | undefined): Promise<DialogueDetections | undefined> {
    const language = transcriptLanguage(ctx, projectId, media) || defaultLanguage;
    if (language !== "auto" && !alignsLanguage(language)) return;
    const words = await readAcousticWindow(await emissionStore(ctx, projectId, file, stream), from, to);
    if (words) return { acoustic: [], segments: words.length ? [{
      id: "kept", start: from, end: to, text: words.map(w => w.text).join(" "), words,
    }] : [] };
  }
  async function source(projectId: string, media: MediaAsset, to: number, settings: ServerSettings["transcription"]) {
    if (settings.provider === "none") throw conflict("transcription_unavailable", "Transcription isn't available in this build of Scarlet.");
    const file = sourceFile(projectId, media, to);
    // Bump the format for changes to the bundled models, prompt, VAD or detection algorithm.
    const runtime = settings.provider === "whispercpp" ? resolveLocalRuntime(ctx, settings) : undefined;
    const model = runtime ? await localModelIdentity(runtime) : ["openai", settings.openaiModel];
    const identity = [await fileStamp(file), ...model];
    const fingerprint = createHash("sha256").update(JSON.stringify([1, speakerTurnCacheVersion, speakerAnalysisVersion,
      identity, media.hash, media.voiceRoles, settings.language, verbatim, alignmentVersion])).digest("hex");
    return { file, fingerprint, runtime };
  }

  async function checkpoints(projectId: string, media: MediaAsset, from: number, to: number, settings = ctx.settings().transcription) {
    const { fingerprint } = await source(projectId, media, to, settings);
    return ctx.db.prepare(`SELECT start, end FROM dialogue_scan_pages
      WHERE media_id = ? AND fingerprint = ? AND start >= ? AND end <= ? ORDER BY start, end`)
      .all(media.id, fingerprint, from, to) as TimeRange[];
  }

  async function openPage(projectId: string, media: MediaAsset, from: number, to: number, edit?: ScanEdit,
    policy = ctx.repos.settings.transcriptionPolicy(), keptSide?: { audioStream?: number; cachedOnly?: true }) {
    const signal = AbortSignal.any([stops(projectId, edit), policy.signal]);
    signal.throwIfAborted();
    if (edit && !activeEdit(edit)) throw conflict("edit_inactive", "This edit is no longer running.");
    if (keptSide?.cachedOnly) {
      // Never reuse a transcribed reading. A missing emissions window may be filled between checks.
      const file = sourceFile(projectId, media, to);
      const ready = ctx.track(cachedSpeech(projectId, media, file, from, to, keptSide.audioStream, policy.settings.language)
        .then(result => result ?? { acoustic: [], segments: [], keptSideUnavailable: true as const }));
      return { analyzed: ready, ready };
    }
    const { file, fingerprint, runtime } = await source(projectId, media, to, policy.settings);
    const params = [media.id, fingerprint, from, to];
    const saved = keptSide ? undefined : ctx.db.prepare("SELECT result FROM dialogue_scan_pages WHERE media_id = ? AND fingerprint = ? AND start = ? AND end = ?")
      .get(...params) as { result: string } | undefined;
    if (saved) {
      const ready = Promise.resolve(JSON.parse(saved.result) as DialogueDetections);
      return { analyzed: ready, ready };
    }
    // A cancelled edit cannot authorize another edit's upload. Completed pages remain shared. A page an edit asked for
    // doesn't join one nobody asked for, which the pause would stop under it.
    const key = JSON.stringify([...params, keptSide, ...(policy.settings.provider === "openai" ? [policy.revision, edit] : [!!edit])]);
    const existing = pending.get(key);
    if (existing) return existing;
    const provider = getTranscriptionProvider(ctx, undefined, policy, runtime);
    if (!provider) throw conflict("transcription_unavailable", policy.settings.provider === "openai"
      ? "Set OPENAI_API_KEY to use OpenAI for dialogue scans." : "The local Whisper runtime is unavailable.");
    function checkCloudAuthorization() {
      // Refresh durable state: another engine may have revoked consent, trashed or paused the project, or cancelled this attempt.
      ctx.settings();
      signal.throwIfAborted();
      stops(projectId, edit).throwIfAborted();
      if (edit && !activeEdit(edit)) throw conflict("edit_inactive", "This edit is no longer running.");
    }
    const transcribeWindow = async (wav: string, prompt?: string) => {
      const input = { path: wav, tmpDir: ctx.paths.tmp, dialogueWindow: { prompt }, signal };
      if (provider.name !== "openai") return provider.transcribe(input);
      const revoked = new AbortController();
      const timer = setInterval(() => {
        try { checkCloudAuthorization(); } catch (err) { revoked.abort(err); }
      }, 250);
      try {
        return await provider.transcribe({ ...input, signal: AbortSignal.any([signal, revoked.signal]), beforeUpload: checkCloudAuthorization });
      } finally { clearInterval(timer); }
    };
    // Each page takes its turn in the engine's audio lane, so a page never runs beside a transcript. Where Whisper
    // shares that lane, the page's detectors and its word alignment are one turn: taken separately, a turn of the
    // transcript's alignment ran between them, and again before the next page.
    // Where Whisper has a lane of its own, the page's Whisper runs there while the other lane detects fillers and
    // speech, and its words are aligned in a second turn once both are in. A turn of the transcript's alignment in
    // between is no loss: it saves the emissions this page's alignment then reads.
    const work: AudioWork = { mediaId: media.id, kind: "page" };
    const lane = audioLane(ctx);
    const local = provider.name !== "openai";
    const whisper = local ? whisperLane(ctx, provider.separateWhisperLane) : undefined;
    const inLane = <T>(job: () => Promise<T>) => lane.run(work, signal, job);
    const inWhisperLane = <T>(job: () => Promise<T>) => whisper ? whisper.run(work, signal, job) : job();
    const analyzed = ctx.track((keptSide ? keptWindows : acousticWindows).get(key, async () => {
      signal.throwIfAborted();
      const stream = keptSide?.audioStream;
      if (keptSide) {
        const measured = await cachedSpeech(projectId, media, file, from, to, stream, policy.settings.language);
        if (measured) return measured;
      }
      const wav = join(ctx.paths.tmp, randomUUID() + ".wav");
      // The page's minute, its speech detection and any emissions its alignment lacks all come from one decode of
      // the recording, shared with the pages before and after it.
      const recording = await recordingWav(ctx, file, signal, stream);
      try {
        await recording.writeWindow(wav, from, to);
        if (keptSide) {
          const speech = await inWhisperLane(() => transcribeWindow(wav));
          return { acoustic: [], segments: onSourceClock(speech.segments, from, to) };
        }
        const detectors = () => Promise.allSettled([uhm.detect(wav, from, signal),
          recording.pcm(speechActivityStart(from), to).then(pcm => speechActivityOf(pcm, speechActivityStart(from), from, to))]);
        type Speech = Awaited<ReturnType<typeof transcribeWindow>>;
        const align = async (speech: PromiseSettledResult<Speech>, [acoustic, activity]: Awaited<ReturnType<typeof detectors>>) => {
          signal.throwIfAborted();
          if (speech.status === "rejected") throw speech.reason;
          if (acoustic.status === "rejected") throw acoustic.reason;
          if (activity.status === "rejected") throw activity.reason;
          // Whisper word times run 100-300 ms off; refine them against the audio before any edge uses them. The
          // model's output for this audio is the recording's: what its transcript's alignment has saved is read, and
          // the rest is inferred from the whole recording's decode and saved for the transcript.
          try {
            const emissions = { file: await emissionStore(ctx, projectId, file), offset: from, duration: to - from, wav: async () => recording.wav };
            const words = await alignWords(ctx, wav, speech.value.segments, { language: speech.value.language ?? policy.settings.language, signal, emissions });
            return { acoustic, activity, words, unaligned: false };
          } catch (err) {
            signal.throwIfAborted();
            ctx.log(`[dialogue] word alignment unavailable for ${media.id} ${from}-${to}: ${(err as Error).message}`);
            return { acoustic, activity, words: speech.value.segments, unaligned: true };
          }
        };
        const settled = <T>(job: Promise<T>): Promise<PromiseSettledResult<T>> =>
          job.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        let page: Awaited<ReturnType<typeof align>>;
        if (whisper && whisper !== lane) {
          const [speech, detected] = await Promise.all([settled(inWhisperLane(() => transcribeWindow(wav, verbatim))), inLane(detectors)]);
          page = await inLane(() => align(speech, detected));
        } else {
          page = await inLane(async () => {
            const [speech, detected] = await Promise.all([settled(transcribeWindow(wav, verbatim)), detectors()]);
            return align(speech, detected);
          });
        }
        const { acoustic, activity, words, unaligned } = page;
        const segments = onSourceClock(words, from, to);
        const result: DialogueDetections = { segments, acoustic: acoustic.value, speechActivity: activity.value };
        if (unaligned) unalignedPages.add(result);
        if (media.voiceRoles) {
          try {
            const measured = await readSourceEnergy(file, from, to, signal);
            const roles = media.voiceRoles;
            if (measured.mix === roles.me - 1 || measured.mix === roles.other - 1) throw new Error("The source layout conflicts with its saved roles.");
            const turns = otherVoiceTurns(measured.energy, roles, from, to);
            result.otherVoiceTurns = [];
            if (turns.length) {
              await extractWav(file, wav, { start: from, duration: to - from, audioStream: roles.other - 1, signal });
              const isolated = await inWhisperLane(() => transcribeWindow(wav));
              const words = isolated.segments.flatMap(s => s.words);
              result.otherVoiceTurns = turns.map(turn => ({ ...turn, text: words.filter(w => {
                const mid = from + (w.start + w.end) / 2;
                return mid >= turn.start - .12 && mid < turn.end + .12;
              }).map(w => w.text).join(" ") }));
            }
          } catch (err) {
            signal.throwIfAborted();
            result.voiceRoleIssue = (err as Error).message;
          }
        }
        return result;
      } finally {
        recording.release();
        await rm(wav, { force: true });
      }
    }, { signal }));
    // A cut reads only its surviving words. Its short window is never a completed dialogue-scan page.
    if (keptSide) return { analyzed, ready: analyzed };
    // The expensive window detectors share one worker. Whole-recording speaker
    // matching runs independently so the next window can start before labels arrive.
    const speakers = ctx.track(ctx.speakers.turns(ctx, projectId, media, undefined, !!edit));
    const ready = ctx.track(analyzed.then(async result => {
      try {
        const turns = await speakers;
        const windowTurns = turns.filter(t => t.end > from && t.start < to)
          .map(t => ({ ...t, start: Math.max(from, t.start), end: Math.min(to, t.end) }));
        result.speakerTurns = windowTurns.filter(t => t.speaker > 0);
        result.segments = labelTranscript({ id: "window", mediaId: media.id, segments: result.segments }, windowTurns).segments;
      } catch (err) {
        signal.throwIfAborted();
        result.speakerIssue = (err as Error).message;
      }
      signal.throwIfAborted();
      if (provider.name === "openai") checkCloudAuthorization();
      // Unaligned pages are served but not saved, so a later scan retries alignment.
      if (!result.speakerIssue && !result.voiceRoleIssue && !unalignedPages.has(result)) {
        ctx.db.prepare("INSERT OR IGNORE INTO dialogue_scan_pages (media_id, fingerprint, start, end, result) VALUES (?, ?, ?, ?, ?)")
          .run(...params, JSON.stringify(result));
      }
      return result;
    }).finally(() => pending.delete(key)));
    const page = { analyzed, ready };
    pending.set(key, page);
    return page;
  }

  async function detect(projectId: string, media: MediaAsset, from: number, to: number, taskId?: string, startedAt?: string, keptSide?: { audioStream?: number; cachedOnly?: true }) {
    return (await openPage(projectId, media, from, to, taskId ? scanEdit(projectId, taskId, startedAt) : undefined, undefined, keptSide)).ready;
  }
  // The engine owns the requested range. A slow reader or an MCP timeout does
  // not stall the next page. Foreground requests join the same detector window.
  const activeScans = new Set<string>();
  async function start(projectId: string, media: MediaAsset, from: number, end: number, taskId: string, startedAt?: string) {
    const edit = scanEdit(projectId, taskId, startedAt);
    const policy = ctx.repos.settings.transcriptionPolicy();
    const signal = AbortSignal.any([stops(projectId, edit), policy.signal]);
    function currentEdit() {
      if (signal.aborted) return;
      return activeEdit(edit);
    }
    if (!currentEdit()) throw conflict("edit_inactive", "This edit is no longer running.");
    const saved = await checkpoints(projectId, media, from, end, policy.settings);
    const key = JSON.stringify([taskId, edit.startedAt, media.id, from, end, policy.revision]);
    if (activeScans.has(key)) return saved;
    const pages = new Map(saved.map(page => [page.start, page.end]));
    activeScans.add(key);
    // While the pass reads this recording, its transcript, speakers and pages go ahead of other audio work.
    const unfocus = audioLane(ctx).focus(media.id);
    async function scan() {
      // Bound the pages waiting for recording-wide speaker labels. Log only
      // fully labeled windows, including when the foreground reader joins one.
      const labeling = new Set<Promise<void>>();
      let failure: Error | undefined;
      /** The scan has analysed a page and seen it labelled, so later pages run ahead of their labels. */
      let ahead = false;
      try {
        for (let start = from; start < end;) {
          const to = Math.min(end, start + 60);
          if (pages.get(start) !== to) {
            if (failure || !currentEdit()) break;
            const page = await openPage(projectId, media, start, to, edit, policy);
            const pageStart = start;
            const report = page.ready.then(result => {
              const task = currentEdit();
              if (!task || failure) return;
              if (result.speakerIssue || result.voiceRoleIssue) throw new Error(result.speakerIssue || result.voiceRoleIssue);
              appendTaskEvent(ctx, task, { type: "log", text: `Dialogue scan · ${media.name}`,
                data: { kind: "editor_progress", scanPage: { mediaId: media.id, from: pageStart, to, end } } });
            }).catch(err => { failure = err instanceof Error ? err : new Error(String(err)); });
            labeling.add(report);
            void report.then(() => labeling.delete(report));
            await page.analyzed;
            // No page can be read before the recording's speakers are known, and their analysis runs slower beside
            // page after page of Whisper and alignment: a pass's first page came at 48 to 53 s instead of 25 to 37 s.
            // So the scan goes no further than its first page until that page has its labels, and until the speakers
            // of the other recordings the pass reads are in too (RecordingSpeakers.awaitedByPass).
            if (!ahead) {
              await report;
              if (ctx.speakers.beside) await ctx.speakers.awaitedByPass(projectId);
            }
            ahead = true;
            if (labeling.size >= 64) await Promise.race(labeling);
          }
          if (to === end) break;
          start = to - 2;
        }
      } finally { await Promise.all(labeling); }
      if (failure) throw failure;
    }
    ctx.track(scan().catch(err => {
      const task = currentEdit();
      if (task) {
        ctx.log(`[dialogue-scan] ${media.id}: ${(err as Error).message}`);
        appendTaskEvent(ctx, task, { type: "log", text: "The background dialogue scan paused. Completed sections are saved.",
          data: { kind: "editor_progress" } });
      }
    }).finally(() => { activeScans.delete(key); unfocus(); }));
    return saved;
  }
  return { detect, checkpoints, start };
}
