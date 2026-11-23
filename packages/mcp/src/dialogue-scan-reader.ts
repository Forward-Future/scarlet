/**
 * dialogue_scan's reading: each page's detections, levels, silences and the pictures through them, the pages the
 * background scan saved, and the first-cut batch that holds a read until the section before it is saved.
 */
import {
  DEFAULT_RESULT_CHARS,
  ScarletApiError,
  type AgentCapabilities,
  type DialogueDetections,
  type DialogueScanPage,
  type PictureActivityWindow,
  type ScarletClient,
  type ScarletToolName,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import {
  carriesAudio,
  mergeRanges,
  type MediaAsset,
  type TimeRange,
  type Timeline,
  type TranscriptWord,
} from "@scarlet/timeline";
import { dbfs, firstCutEvidence, firstCutPauses } from "./analysis.js";
import { matchFillers, type DialogueEvidence } from "./dialogue-decisions.js";
import { dialogueAudioStream } from "./dialogue-join.js";
import { dialogueScanPage } from "./dialogue-plan.js";
import { acousticRetakeContinuations, type AcousticRetakePage } from "./dialogue-retake-join.js";
import { acousticRepeatedTakes, findRepeatedTakes } from "./dialogue-retakes.js";
import { DialogueScanBatch } from "./dialogue-scan-batch.js";
import { QUIET_PHRASE_CONTEXT } from "./gap-sound.js";
import type { MediaSession } from "./media-session.js";
import { levelPoints, type SessionErrorHelpers } from "./media-state.js";
import { levelProfile } from "./media-profile.js";
import { assessedCuts, reviewReminderText, type StagedReviewState } from "./staged-review.js";
import { pictureReading, pictureWindows, silences, type Silence } from "./silences.js";
import {
  describeError,
  json,
  MediaPreparing,
  noteEvidenceMiss,
  raceTimeout,
} from "./tool-result.js";

/** Source seconds read without saving a part before dialogue_scan reminds the agent that the editor is waiting. */
const SAVE_REMINDER_SECONDS = 300;
/**
 * Dialogue analysis takes its turn in the engine's audio lane behind transcription, so on a long recording a page
 * request can time out again and again while the transcript is made. After this many failures in a row, a page waits
 * for the transcript instead of starting another request.
 */
const DIALOGUE_FAILURE_LIMIT = 2;

export interface DialogueScanReaderDeps {
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  taskStartedAt?: string;
  task?: Task;
  caps: AgentCapabilities;
  evidence: DialogueEvidence;
  session: MediaSession;
  errors: SessionErrorHelpers;
  scanScopes: Map<string, number>;
  stagedState: StagedReviewState;
  dialogueOperation(): Promise<string> | string;
  waitLeft(margin: number, most?: number): number;
  finished(names: readonly ScarletToolName[]): Promise<void>;
  postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }>;
}

export function createDialogueScanReader(deps: DialogueScanReaderDeps) {
  const { client, projectId, taskId, taskStartedAt, task, caps, evidence, session, errors, scanScopes, stagedState,
    dialogueOperation, waitLeft, finished, postEvent } = deps;
  const { waitingOn, ensureTranscriptWait, transcriptState, readPrepared, getTranscript, transcriptWords, showWords, readQuietPhrases } = session;
  const { unavailableOnce, withoutOnce } = errors;

  const acousticRetakePages = new Map<string, AcousticRetakePage>();
  const pendingDetections = new Map<string, Promise<DialogueDetections>>();
  /** Dialogue analysis requests that failed in a row, per recording, and the last reason. */
  const dialogueFailures = new Map<string, { count: number; error: string }>();

  function detectWindow(mediaId: string, from: number, to: number) {
    const key = JSON.stringify([mediaId, from, to]);
    let job = pendingDetections.get(key);
    if (!job) {
      job = client.dialogueDetections(projectId, { mediaId, from, to, taskId, startedAt: taskStartedAt })
        .then(result => { dialogueFailures.delete(mediaId); return result; }, (err: unknown) => {
          dialogueFailures.set(mediaId, { count: (dialogueFailures.get(mediaId)?.count ?? 0) + 1, error: describeError(err) });
          throw err;
        })
        .finally(() => pendingDetections.delete(key));
      pendingDetections.set(key, job);
    }
    return job;
  }

  function scanProgress(asset: MediaAsset, page: Omit<DialogueScanPage, "mediaId">) {
    return postEvent({ type: "log", text: `Dialogue scan · ${asset.name}`,
      data: { kind: "editor_progress", scanPage: { mediaId: asset.id, ...page } } });
  }

  async function scanPages(asset: MediaAsset, from: number, end: number) {
    const key = JSON.stringify([asset.id, end]);
    const previous = scanScopes.get(key);
    const start = Math.min(previous ?? from, from);
    const opening = previous !== start;
    scanScopes.set(key, start);
    if (opening) await scanProgress(asset, { from: start, end });
    const range = { mediaId: asset.id, from: start, to: end };
    let pages;
    let background = false;
    if (taskId) {
      try {
        pages = await client.startDialogueScan(projectId, { ...range, taskId, startedAt: taskStartedAt });
        background = true;
      } catch (err) {
        if (err instanceof ScarletApiError && err.code === "edit_inactive") throw err;
        // An older engine or an unavailable local detector can still serve saved evidence.
        unavailableOnce(`failed to start the background dialogue scan of ${asset.id}`, err);
      }
    }
    pages ??= await client.dialogueCheckpoints(projectId, range).catch(withoutOnce(`failed to read the saved dialogue pages of ${asset.id}`, []));
    const aligned = pages.filter(p => p.end === Math.min(end, p.start + 60)
      && Math.abs((p.start - start) / 58 - Math.round((p.start - start) / 58)) < 1e-8);
    if (opening) for (const page of mergeRanges(aligned)) await scanProgress(asset, { from: page.start, to: page.end, end });
    return { saved: new Map(aligned.map(p => [p.start, p.end])), background };
  }

  // Picture measurements under way or done, by the windows asked, so a page read again collects them.
  const pictureJobs = new Map<string, Promise<PictureActivityWindow[] | null>>();
  let playing: { tl: Timeline | null; media: MediaAsset[]; at: number } | undefined;
  /**
   * What the picture does through each silence, for every video the edit shows there. One request covers the page.
   * A silence whose measurement isn't back within the budget reads "measuring", and the next read of the page has it.
   */
  async function silencePictures(mediaId: string, stretches: Silence[], budgetMs: number) {
    if (!stretches.length) return [];
    // The edit as it stands says which pictures play with this recording. Read it apart from the version the agent
    // last looked at, which its own edits are proposed against.
    if (!playing || Date.now() - playing.at > 30_000) {
      const [tl, media] = await Promise.all([
        client.timeline(projectId, "head").then(r => r.timeline, (err: unknown) => {
          // A project with no edit yet shows no picture. That is not a failure.
          if (!(err instanceof ScarletApiError && err.status === 404)) unavailableOnce("failed to read the edit for the pictures through silences", err);
          return null;
        }),
        client.media(projectId).then(r => r.media, withoutOnce("failed to read the media for the pictures through silences", [] as MediaAsset[]))]);
      playing = { tl, media, at: Date.now() };
    }
    const { tl, media } = playing;
    if (!tl) return [];
    const asked = stretches.map(s => pictureWindows(tl, media, mediaId, { start: s.start, end: Math.min(s.end, s.start + 60) }));
    const flat = asked.flatMap((windows, i) => windows.map(w => ({ i, w }))).slice(0, 24);
    if (!flat.length) return [];
    const key = JSON.stringify(flat.map(f => [f.w.mediaId, f.w.from, f.w.to]));
    let job = pictureJobs.get(key);
    if (!job) {
      // An engine without this measurement, or a source it can't decode, leaves the silences without a picture reading.
      job = client.pictureActivity(projectId, { windows: flat.map(({ w }) => ({ mediaId: w.mediaId, from: w.from, to: w.to })) })
        .then(r => r.windows, err => { pictureJobs.delete(key); unavailableOnce("failed to measure the pictures through silences", err); return null; });
      pictureJobs.set(key, job);
    }
    const done = await raceTimeout(job, Math.max(0, budgetMs), "pending" as const);
    if (!done) return [];
    return stretches.map((_, i) => {
      const mine = flat.flatMap((f, n) => f.i === i ? [n] : []);
      if (!mine.length) return undefined;
      return done === "pending" ? "measuring" as const : mine.map(n => pictureReading(done[n]!, flat[n]!.w.shift));
    });
  }

  async function readDialoguePage(asset: MediaAsset, from: number, end: number, saved: Map<number, number>, background: boolean) {
    const mediaId = asset.id, to = Math.min(end, from + 60);
    const failed = dialogueFailures.get(mediaId);
    if (failed && failed.count >= DIALOGUE_FAILURE_LIMIT && !pendingDetections.has(JSON.stringify([mediaId, from, to]))) {
      const transcript = await transcriptState(mediaId);
      if (transcript && !transcript.ready) {
        // The run now waits on the transcript. If it ends first, Scarlet records that it ended without it.
        ensureTranscriptWait(mediaId);
        throw new MediaPreparing(`Dialogue analysis of ${asset.name} failed ${failed.count} times in a row (last: ${failed.error}) while its transcript is ${transcript.note}. ` +
          "Scarlet won't request it again until the transcript is saved, so waiting here gains nothing. Save the edits you can decide without it and end your run, saying what is left. " +
          "Scarlet records that the run ended without this transcript and offers the editor to finish the request once it is ready.");
      }
    }
    const wait = waitLeft(0) * 1000;
    const pageDeadline = Date.now() + wait + 7_000;
    let detections: DialogueDetections | undefined, detectorIssue: string | undefined;
    try {
      // Allow local inference, a first page's speaker analysis included, to finish within what is left of the MCP call,
      // a margin below the harness's tool deadline (toolWaitSeconds), so a waiting page costs no extra turns.
      const job = detectWindow(mediaId, from, to);
      const ready = await raceTimeout(job, wait, "pending" as const);
      if (ready === "pending") {
        waitingOn("dialogue", mediaId, job);
        const transcript = await transcriptState(mediaId);
        const behind = transcript && !transcript.ready ? ` It takes turns with this recording's transcript, which is ${transcript.note}.` : "";
        throw new MediaPreparing(`Dialogue analysis is still running.${behind} Collect this same window at ${from} seconds after reviewing the available material.`);
      }
      detections = ready;
    } catch (err) {
      if (err instanceof MediaPreparing) throw err;
      noteEvidenceMiss("dialogue detection");
      detectorIssue = describeError(err);
    }
    const wf = await readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, levelPoints(from, to), true, !detections?.speechActivity));
    if (detections?.speechActivity) wf.speechActivity = detections.speechActivity;
    const transcript = detections ? { id: "first-pass", mediaId, segments: detections.segments }
      : await getTranscript(mediaId, { from, to, granularity: "word" }, false);
    const observed = firstCutEvidence(transcript, wf);
    // Use measured words only. The saved transcript's synthesized search timings can
    // differ from this scan. Keep the preceding page's non-overlapping tail on resume. A word goes with the side its
    // middle is on, as a page keeps its words, so one said across the seam is in one of them.
    const timedWords = (segments: DialogueDetections["segments"], start: number, end: number) =>
      segments.flatMap(s => s.words.filter(w => w.end > w.start && (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 < end)
        .map(w => w.speaker || !s.speaker ? w : { ...w, speaker: s.speaker })).sort((a, b) => a.start - b.start);
    const scopeStart = scanScopes.get(JSON.stringify([mediaId, end])) ?? from;
    const previous = evidence.scans.find(s => s.mediaId === mediaId && s.start >= scopeStart && Math.abs(s.start + 58 - from) < 1e-6);
    const earlierWords = timedWords(previous?.segments ?? [], Math.max(scopeStart, from - 25), from);
    const repeatedTakes = findRepeatedTakes([...earlierWords, ...timedWords(transcript?.segments ?? [], from, to)])
      .filter(cue => cue.next.end > from)
      // Independent decodes can move a word across the seam. A cross-page match
      // helps find the takes, but cannot establish an uninterrupted restart.
      .map(cue => cue.first.start < from ? { ...cue, immediateRestart: false } : cue);
    const fillers = matchFillers(observed.fillers, detections?.acoustic ?? []);
    // Measured while the saved transcript's words are found for this page.
    const quiet = silences(transcript, wf, { previous: earlierWords.at(-1) });
    const pictures = silencePictures(mediaId, quiet, Math.min(6000, pageDeadline - Date.now() - 12_000))
      .catch(withoutOnce(`failed to read the pictures through silences of ${mediaId}`, []));
    // Stable word indices from the saved transcript, once its words are placed on the audio through this page, so a
    // cut can name its words. They are matched to the page by time, and an estimate could name the neighbouring word.
    const indexed = await transcriptWords(mediaId, false, to, Math.min(10_000, Math.max(0, pageDeadline - Date.now())))
      .catch(withoutOnce(`failed to read the word indices of ${mediaId}`, null));
    showWords(mediaId, indexed);
    // A quiet phrase can start before the next page's overlap. Return it whole when its last word is reached.
    const audioStream = dialogueAudioStream(asset);
    const soft = indexed && (audioStream ?? 0) === 0
      ? (await readQuietPhrases(mediaId, Math.max(scopeStart, from - QUIET_PHRASE_CONTEXT), to)
        .catch(withoutOnce(`failed to measure quiet phrases on ${mediaId}`, []))).filter(p => p.end > from) : [];
    const indexOf = (start: number, end: number) => {
      if (!indexed) return undefined;
      const inside = indexed.flatMap((w, i) => (w.start + w.end) / 2 >= start - .05 && (w.start + w.end) / 2 <= end + .05 ? [i] : []);
      return inside.length ? [inside[0]!, inside.at(-1)!] as [number, number] : undefined;
    };
    const room = levelProfile({ from: wf.from, to: wf.to, rms: wf.rms ?? [] }, transcript ? transcript.segments.flatMap(s => s.words) : null).roomToneDbfs;
    const scan = detections && dialogueScanPage(mediaId, from, to, audioStream ?? 0, detections.segments, wf);
    const pauses = firstCutPauses(transcript, wf, scan?.edges);
    if (scan) {
      const index = evidence.scans.findIndex(s => s.mediaId === mediaId && s.start === from && s.end === to);
      if (index < 0) evidence.scans.push(scan);
      else evidence.scans[index] = scan;
    }
    if (!background && !saved.has(from) && detections && !detections.speakerIssue && !detections.voiceRoleIssue) {
      await scanProgress(asset, { from, to, end });
    }
    // Read after alignment so a late cache fill or a reread of this page can supply new evidence.
    const wordRuns = await client.dialogueAcousticWords(projectId, { mediaId, audioStream, from: Math.max(scopeStart, from - 25), to })
      .catch((err: unknown) => {
        if (!(err instanceof ScarletApiError && err.status === 404)) unavailableOnce(`failed to read the acoustic words of ${mediaId}`, err);
        return [] as TranscriptWord[][];
      });
    const acousticTakes = acousticRepeatedTakes(wordRuns, from);
    const takes = acousticRetakeContinuations(wordRuns, acousticTakes);
    const pageKey = JSON.stringify([mediaId, from, to, audioStream]);
    if (takes.length) acousticRetakePages.set(pageKey, { mediaId, audioStream, takes });
    else acousticRetakePages.delete(pageKey);
    return { mediaId, from, to, ...(room !== undefined && { roomToneDbfs: room }), ...observed,
      // Each lookup scans the whole recording's transcript.
      passages: observed.passages.map(p => { const words = indexOf(p.start, p.end); return { ...p, ...(words && { words }) }; }),
      repeatedTakes,
      ...(wordRuns.length && { acousticRepeatedTakes: acousticTakes }),
      ...(soft.length && { quietPhrases: soft }),
      fillerCandidates: fillers.map(f => { const words = indexOf(f.start, f.end); return { ...f, ...(words && { words }) }; }),
      detectors: detections ? ["prompted-whisper", "uhm"] : [], detectorIssue, speakerTurns: detections?.speakerTurns, speakerIssue: detections?.speakerIssue, otherVoiceTurns: detections?.otherVoiceTurns, voiceRoleIssue: detections?.voiceRoleIssue,
      pauses: pauses.map(p => "maxPeak" in p ? (({ maxPeak, ...rest }) => ({ ...rest, maxPeakDb: dbfs(maxPeak) }))(p) : p),
      silences: await pictures.then(read => quiet.map((s, i) => ({ ...s, ...(read[i] && { picture: read[i] }) }))) };
  }

  // How far the agent has read in each recording, and where it stood at its last save. The editor reviews saved parts
  // while the run continues, so a long read without saving keeps them waiting.
  const readTo = new Map<string, number>();
  const savedAt = new Map<string, number>();

  async function firstRecommendationNeeded() {
    const id = stagedState.stageWithoutAppliedCuts;
    if (!id) return;
    // The editor can finish or replace this proposal while the model works.
    const record = await client.changeRecord(id).catch((error: unknown) => {
      if (!(error instanceof ScarletApiError && error.status === 404)) throw error;
      return undefined;
    });
    const change = record?.change;
    if (change?.state === "ready" && !change.replacedBy) {
      const prepared = await stagedState.stagedReview;
      const assessed = assessedCuts(change);
      // A replacement review can inherit every recommendation from the preceding section.
      const hasRecommendation = prepared?.changeId === id
        ? prepared.unchecked === 0 || assessed > prepared.total - prepared.unchecked
        : assessed > 0;
      if (!hasRecommendation && stagedState.stageWithoutAppliedCuts === id)
        return `This batch only staged cuts on ${id}. Use dialogue_review_inspect and dialogue_review_save to give the editor a recommendation on a new cut before reading another section.`;
    }
    if (stagedState.stageWithoutAppliedCuts === id) stagedState.stageWithoutAppliedCuts = undefined;
  }

  const scanBatches = new Map<string, DialogueScanBatch>();
  async function scan({ mediaId, from, until, noCutsReadyThrough }: { mediaId: string; from: number; until?: number; noCutsReadyThrough?: number }) {
    const { media } = await client.media(projectId);
    const asset = media.find(m => m.id === mediaId);
    // A video not read yet isn't known to be silent: the line after says to check its import.
    if (!asset || !carriesAudio(asset)) throw new Error("Choose a source with audio from this project.");
    if (!asset.duration) throw new Error("Source duration is unavailable. Check import status before scanning.");
    const end = Math.min(until ?? asset.duration, asset.duration);
    if (from >= end) throw new Error("Choose a nonempty range inside the source.");
    // Saving in sections gets the first cuts to the editor while the pass reads on. A session that opens on a pass
    // with saved work is checking it (the repeat check that finishes a pass, a resumed run): it re-reads what it
    // cut, and the gate, new to that session, refused 27 such reads on one pass (2026-11-15).
    if (!taskId || await dialogueOperation() !== "first-cut" || (task?.changeIds.length ?? 0) > 0) return scanDialogue(asset, from, end);
    let batch = scanBatches.get(mediaId);
    if (!batch) {
      batch = new DialogueScanBatch();
      scanBatches.set(mediaId, batch);
    }
    return batch.reads.run(() => 0, () => scanDialogue(asset, from, end, batch, noCutsReadyThrough));
  }

  async function scanDialogue(asset: MediaAsset, from: number, end: number, batch?: DialogueScanBatch, noCutsReadyThrough?: number) {
    const mediaId = asset.id;
    const firstEnd = Math.min(from + 60, end);
    // A harness can send a save and the next read at once. The read waits for a save or a review under way, so what it
    // asks for first is what they left: sent together, the read was refused for the cuts its save was saving, and
    // after a few refusals the model passed noCutsReadyThrough with every read, cuts or none (2026-11-15).
    if (batch?.isNewPage(from, firstEnd)) {
      // Within this call's time: a save that runs on past it is waited for again on the next read.
      const saved = await raceTimeout(finished(["dialogue_apply_cuts", "dialogue_review_save"]).then(() => true), waitLeft(20) * 1000, false);
      if (!saved) throw new MediaPreparing(`A save you sent is still being made, and this page is read after it. Call dialogue_scan again with from ${from} once it has answered.`);
    }
    const reviewFirst = batch && await firstRecommendationNeeded();
    if (reviewFirst && batch?.isNewPage(from, firstEnd)) throw new Error(reviewFirst);
    batch?.startRead(from, firstEnd, noCutsReadyThrough);
    const { saved, background } = await scanPages(asset, from, end);
    const first = await readDialoguePage(asset, from, end, saved, background);
    batch?.delivered(first.from, first.to);
    const restoredPages = [];
    let nextFrom = first.to < end ? first.to - 2 : null;
    // Leave room for wrapper fields (nextFrom, saveCheckpoint, reminders) so bundled pages stay inline.
    const scanBudget = Math.min(16_000, Math.max(2_000, (caps.resultChars ?? DEFAULT_RESULT_CHARS) - 600));
    let responseSize = JSON.stringify(first).length;
    while (nextFrom !== null && saved.has(nextFrom) && restoredPages.length < 2 && responseSize < scanBudget) {
      const pageEnd = saved.get(nextFrom)!;
      if (batch?.needsSave(nextFrom, pageEnd) || (reviewFirst && batch?.isNewPage(nextFrom, pageEnd))) break;
      // A page still being read is left for the next call to collect: what this call has read is answered now.
      const page = await readDialoguePage(asset, nextFrom, end, saved, background).catch((err: unknown) => {
        if (err instanceof MediaPreparing) return undefined;
        throw err;
      });
      if (!page) break;
      responseSize += JSON.stringify(page).length;
      if (responseSize > scanBudget) break;
      restoredPages.push(page);
      batch?.delivered(page.from, page.to);
      nextFrom = page.to < end ? page.to - 2 : null;
    }
    const reached = Math.max(readTo.get(mediaId) ?? 0, (restoredPages.at(-1) ?? first).to);
    readTo.set(mediaId, reached);
    if (!savedAt.has(mediaId)) savedAt.set(mediaId, from);
    const unsaved = reached - savedAt.get(mediaId)!;
    const saveReminder = !batch && taskId && unsaved >= SAVE_REMINDER_SECONDS
      ? `You have read ${Math.round(unsaved / 60)} minutes since your last save. Save the passages you have decided with dialogue_apply_cuts so the editor can review them while you continue. Leave the last moments open until you have read what follows.`
      : undefined;
    const pending = taskId ? await stagedState.stagedReview : undefined;
    const reviewReminder = pending?.unchecked ? reviewReminderText(pending) : undefined;
    const saveCheckpoint = batch?.checkpoint;
    return json({ ...first, nextFrom, ...(restoredPages.length ? { restoredPages } : {}), ...(saveReminder && { saveReminder }),
      ...(saveCheckpoint && { saveCheckpoint }), ...(reviewReminder && { reviewReminder }) });
  }

  return {
    scan,
    /** Restarts the scan measured, which dialogue_check_join reads for the retake a range removes. */
    acousticRetakePages,
    /** Tells each recording's first-cut batch what a save decided. */
    batchesSaved(tl: Timeline, ranges: TimeRange[]) {
      for (const [mediaId, batch] of scanBatches) batch.saved(tl, mediaId, ranges);
    },
    /** A save decided what the agent had read so far. */
    readSaved() {
      for (const [mediaId, reached] of readTo) savedAt.set(mediaId, reached);
    },
    /** How far the agent has read in this recording. */
    readThrough: (mediaId: string) => readTo.get(mediaId) ?? 0,
  };
}
