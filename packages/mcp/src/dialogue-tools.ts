import { createHash } from "node:crypto";
import { z } from "zod/v3";
import {
  cutScope,
  DEFAULT_RESULT_CHARS,
  JOIN_WORD_SECONDS,
  ScarletApiError,
  selectedRange,
  RESTART_WITHIN_SECONDS,
  SHORT_PIECE_SECONDS,
  SILENCE_LEFT_SECONDS,
  type AgentCapabilities,
  type DialogueDetections,
  type DialogueScanPage,
  type PictureActivityWindow,
  type RepeatEvidence,
  type ScarletClient,
  type ScarletToolName,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import {
  carriesAudio,
  clipEnd,
  CutAssessment,
  frameAligned,
  makeTimeMap,
  mergeRanges,
  rangesOverlap,
  sourceToTimeline as clipSourceToTimeline,
  timelineDuration,
  timelineToSource,
  type Author,
  type Change,
  type MediaAsset,
  type MediaClip,
  type TimeRange,
  type Timeline,
  type TranscriptWord,
} from "@scarlet/timeline";
import {
  audibleMediaClips,
  dbfs,
  firstCutEvidence,
  firstCutPauses,
  round2,
  round3,
} from "./analysis.js";
import { BRIEF_PICTURE_SECONDS, briefPictures } from "./brief-pictures.js";
import { DialogueEvidence, matchFillers } from "./dialogue-decisions.js";
import {
  checkDialogueJoin,
  checkKeptWords,
  checkResumeQuote,
  dialogueAudioStream,
  dialogueCutPreview,
  dialogueJoinWords,
  DIP_DBFS,
  joinAudio,
} from "./dialogue-join.js";
import { PAUSE_FLOOR_SECONDS, partLeftovers } from "./dialogue-leftovers.js";
import {
  audibleSourcePoints,
  cutReading,
  cutsReach,
  dialogueGate,
  dialogueScanPage,
  planDialogueBatch,
  resolveCutRange,
  SPEECH_BESIDE_EDGE,
} from "./dialogue-plan.js";
import { acousticRetakeContinuations, acousticRetakeJoin, type AcousticRetakePage } from "./dialogue-retake-join.js";
import { acousticRepeatedTakes, findRepeatedTakes } from "./dialogue-retakes.js";
import { DialogueScanBatch, FIRST_CUT_BATCH_SIZE } from "./dialogue-scan-batch.js";
import { QUIET_PHRASE_CONTEXT, type GapSound, type QuietPhrase } from "./gap-sound.js";
import {
  createAudioOption,
  crossfadeFrames,
  breathInput,
  cutCoordinates,
  cutRow,
  paceInput,
  PauseRef,
  repeatedPhrase,
  resumeWith,
  unsureJoinsInput,
  WordRef,
} from "./mcp-schema.js";
import type { MediaSession } from "./media-session.js";
import { levelPoints, type SessionErrorHelpers } from "./media-state.js";
import { levelProfile } from "./media-profile.js";
import { pictureFindings } from "./picture-check.js";
import type { PerceptionApi, ProposePipeline } from "./propose-pipeline.js";
import { keptSilences, pictureReading, pictureWindows, silences, type Silence } from "./silences.js";
import { syncSummary, timelineSync, type PairSync } from "./timeline-sync.js";
import { syncRate } from "./audio-sync.js";
import { sourceToTimeline, timelineWords } from "./timeline-perception.js";
import {
  describeError,
  json,
  MediaPreparing,
  noteEvidenceMiss,
  raceTimeout,
  text,
  type ToolRegistrar,
} from "./tool-result.js";
import { JoinChecks } from "./join-checks.js";

/** Source seconds read without saving a part before dialogue_scan reminds the agent that the editor is waiting. */
const SAVE_REMINDER_SECONDS = 300;
/**
 * Dialogue analysis takes its turn in the engine's audio lane behind transcription, so on a long recording a page
 * request can time out again and again while the transcript is made. After this many failures in a row, a page waits
 * for the transcript instead of starting another request.
 */
const DIALOGUE_FAILURE_LIMIT = 2;

/** The latest staged pass of a run, and how many of its cuts still have no recommendation. */
export interface StagedReview { changeId: string; total: number; unchecked: number }
export interface StagedReviewState {
  stagedReview: Promise<StagedReview | undefined> | undefined;
  stageWithoutAppliedCuts: string | undefined;
}

/** How many of a pass's cuts have a recommendation that isn't provisional. */
export const assessedCuts = (change: Change) => change.cutAssessments?.filter(a => !a.provisional).length ?? 0;

/** dialogue_scan's note while staged cuts wait for a recommendation, which the editor needs before they can call them. */
function reviewReminderText({ changeId, total, unchecked }: StagedReview) {
  const cuts = unchecked === 1 ? "1 cut" : `${unchecked} cuts`;
  return `${cuts} you staged on ${changeId} ${unchecked === 1 ? "has" : "have"} no recommendation yet${unchecked < total ? ` (of ${total})` : ""}. The editor sees a staged cut as a call only once it has one, so they have nothing to decide while you read on. Record them with dialogue_review_inspect and dialogue_review_save, then continue.`;
}

export interface DialogueToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  taskStartedAt?: string;
  task?: Task;
  author: Author;
  caps: AgentCapabilities;
  joinWaitMs?: number;
  evidence: DialogueEvidence;
  session: MediaSession;
  errors: SessionErrorHelpers;
  proposePipeline: ProposePipeline;
  scanScopes: Map<string, number>;
  stagedState: StagedReviewState;
  dialogueOperation(): Promise<string> | string;
  waitLeft(margin: number, most?: number): number;
  finished(names: readonly ScarletToolName[]): Promise<void>;
  readPassage(version: string, range: TimeRange, edges?: boolean): void;
  postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }>;
  prepareReview(changeId: string): Promise<StagedReview | undefined>;
  getPerception(): PerceptionApi;
}

export function registerDialogueTools(deps: DialogueToolsDeps) {
  const {
    tool, client, projectId, taskId, taskStartedAt, task, author, caps, joinWaitMs,
    evidence, session, errors, proposePipeline, scanScopes, stagedState,
    dialogueOperation, waitLeft, finished, readPassage, postEvent, prepareReview, getPerception,
  } = deps;
  const {
    getProject, peekTimeline, moveBase, cutAnchor, waitingOn, ensureTranscriptWait,
    transcriptState, readPrepared, getTranscript, transcriptWords, showWords,
    gapSounds, readQuietPhrases, measureAround, joinPages, measureTimeline,
    refusalNext, planSources,
  } = session;
  const { without, unavailableOnce, withoutOnce, together } = errors;
  const { framedOn } = proposePipeline;
  const hearing = caps.audio;
  const audioOption = createAudioOption(hearing);

  const acousticRetakePages = new Map<string, AcousticRetakePage>();
  const joinChecks = new JoinChecks(caps.resultChars);
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

  // How far into each recording the furthest saved cut reaches.
  const cutTo = new Map<string, number>();
  // How far into each recording the joins the agent has checked reach. It checks a part's joins before it saves the
  // part, minutes ahead on a long recording, so the editor's cut figure moves from the first check instead of sitting
  // at nothing until the first save. Reported only when it moves on.
  const checkedTo = new Map<string, number>();
  async function reportChecked(tl: Timeline, ranges: ReadonlyArray<{ start: number; end: number }>) {
    if (!taskId) return;
    for (const [mediaId, to] of cutsReach(tl, ranges)) {
      if (to <= (checkedTo.get(mediaId) ?? 0)) continue;
      checkedTo.set(mediaId, to);
      await postEvent({ type: "log", text: "", data: { kind: "join_progress", mediaId, through: to } });
    }
  }

  const scanBatches = new Map<string, DialogueScanBatch>();
  tool("dialogue_scan",
    "Read a dialogue recording in pages (60 s pages overlapping by 2 s, source seconds). Start at the beginning of the requested range, also when resuming; read the page and any restoredPages, then call again with nextFrom until it is null. On a first dialogue cut, save decided cuts when a page returns saveCheckpoint before reading the next section. During a task Scarlet scans the whole range in the background, so later pages often return at once; a page still analyzing says so, and you can collect it after reviewing other material. Each page: passages (spoken text, with `words` = [first, last] transcript_get indices once the saved transcript's words are placed on the audio that far), repeatedTakes (attempts at the same line with the source times and continuation of each; evidence, not a decision), acousticRepeatedTakes (adjacent deliveries independently decoded from cached English speech, with approximate source times and continuation), fillers and fillerCandidates (each with the detectors that heard it: whisper = verbatim transcription, uhm = acoustic filler model; both agreeing is the strongest evidence), pauses (quiet interiors that could be removed, with the air either side), silences (every stretch of 1.5 s or more with no transcript word, whatever sounds in it: the words either side, voiceSeconds the voice detector fired inside it with no word, as typing or a breath does, and, where the current edit shows video through it, picture per video source: changedFrames of frames, the typical and the largest changed region in percent of the frame, and when the largest and the last change happen in this recording's seconds; `measuring` is ready on the next read of the page), unmatchedVoice (voice activity no transcript word explains: breaths, overlapping talk or missed words), speakerTurns (recording-local voice numbers; a number marks a distinct voice, and only confirmed input roles say which is the presenter), otherVoiceTurns (on a recording with a mix and two isolated inputs: each stretch of sound on the input the dialogue is not on, such as a remote voice or a system sound, with the words heard only there and meAlsoActive when the dialogue input sounded too), roomToneDbfs, and quietPhrases (transcribed words much quieter than the speech on both sides, with source seconds, fromWord/toWord, and the phrase and neighboring levels in dBFS). detectorIssue names incomplete evidence.",
    { mediaId: z.string(), from: z.number().finite().nonnegative().default(0),
      until: z.number().finite().positive().optional().describe("Exclusive end of the requested source range. Defaults to the end of this recording."),
      noCutsReadyThrough: z.number().finite().nonnegative().optional().describe("The through value of a saveCheckpoint, only if this section has no settled cuts to save yet.") },
    async ({ mediaId, from, until, noCutsReadyThrough }) => {
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
    });

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

  let checkedVersion: string | undefined;
  const checkedRepeats = new Map<string, RepeatEvidence>();
  const syncChecks = new Map<string, Promise<{ pairs: Array<PairSync & { outOfLineCount?: number }>; summary?: string } | undefined>>();
  /** Whether recordings of the same event stay in line through this version: placements, then their sound at a few spots. */
  const syncLevels = new Map<string, Promise<number[]>>();
  function checkSync(version: string) {
    let job = syncChecks.get(version);
    if (!job) {
      job = (async () => {
        const [{ project }, timeline] = await Promise.all([getProject(), peekTimeline(version)]);
        // Each new version is checked again; the recordings' levels don't change, so they are read once.
        const levels = (mediaId: string, from: number, to: number) => {
          const key = `${mediaId}/${from}/${to}`;
          let read = syncLevels.get(key);
          if (!read) {
            read = readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, Math.round((to - from) * syncRate), true)).then(w => w.peaks);
            read.catch(() => syncLevels.delete(key));
            syncLevels.set(key, read);
          }
          return read;
        };
        const fps = project.settings.fps;
        const pairs = await timelineSync(timeline, project.media, fps, levels);
        if (!pairs.length) return undefined;
        const summary = syncSummary(pairs, new Map(project.media.map(m => [m.id, m.name])), fps);
        // A badly placed track can be out of line at every cut: the first 20 stretches say enough to fix it.
        return { pairs: pairs.map(p => p.outOfLine.length > 20 ? { ...p, outOfLine: p.outOfLine.slice(0, 20), outOfLineCount: p.outOfLine.length } : p), summary };
      })();
      // Only an answer is kept: a read that failed (a waveform still being prepared) is made again at the next check.
      const made = job;
      made.catch(() => { if (syncChecks.get(version) === made) syncChecks.delete(version); });
      syncChecks.set(version, job);
    }
    return job.catch(without("the sync check", undefined));
  }

  // The silence and piece lengths the model last asked the check for: the checks Scarlet runs after a save count by them too.
  let silencesAsked: number | undefined, piecesAsked: number | undefined;
  /**
   * What the picture does on a version, for the closing check: the brief pictures on it, and where a recording laid
   * over the main picture is off it while it still shows what it showed. Read for the whole video, since the check is.
   */
  const pictureChecks = new Map<string, Promise<{ version: string; findings: ReturnType<typeof pictureFindings> } | undefined>>();
  function checkPictures(version: string) {
    let job = pictureChecks.get(version);
    if (!job) {
      job = (async () => {
        const [{ project }, tl] = await Promise.all([getProject(), peekTimeline(version)]);
        const [framed, cuts] = await Promise.all([framedOn(null, tl),
          getPerception().cutsOn(tl, project, { wait: 0 }).catch(without("where the recordings cut", undefined))]);
        const brief = briefPictures(tl, project.media, project.settings, BRIEF_PICTURE_SECONDS, cuts?.cuts);
        return { version: tl.version, findings: pictureFindings(tl, brief, framed.framed, framed.words) };
      })();
      // "head" names a different version after each save: only a named one is kept, and only an answer, so a read
      // that failed is made again at the next check.
      const made = job;
      made.catch(() => { if (pictureChecks.get(version) === made) pictureChecks.delete(version); });
      if (version !== "head") pictureChecks.set(version, job);
    }
    return job.catch(without("what the picture does", undefined));
  }

  async function checkRepeats(version: string, keep?: Array<{ id: string; reason: string }>, offset?: number, asked?: number, piecesUnderAsked?: number) {
    if (asked !== undefined) silencesAsked = asked;
    if (piecesUnderAsked !== undefined) piecesAsked = piecesUnderAsked;
    const silencesFrom = silencesAsked, piecesUnder = piecesAsked;
    if (!taskId) throw new Error("Check repeated dialogue from an editing task.");
    // The check reads the edit as it is now unless it keeps something heard on the version named: the picture too.
    const pictures = await checkPictures(keep?.length ? version : "head");
    const found = await client.checkDialogueRepeats(projectId, taskId, { version: !keep?.length && pictures ? pictures.version : version,
      keep, offset, silencesFrom, piecesUnder, startedAt: task?.startedAt, ...(pictures && { pictures }) });
    const sync = offset ? undefined : await checkSync(found.version);
    const result = { ...found, ...(sync && { sync }) };
    if (checkedVersion !== result.version) checkedRepeats.clear();
    checkedVersion = result.version;
    for (const k of keep ?? []) checkedRepeats.delete(k.id);
    return { ...result, repeats: result.repeats.map(r => {
      checkedRepeats.set(r.id, r);
      const { occurrences, ...words } = r;
      return { ...words, removable: Object.keys(occurrences) };
    }) };
  }

  tool("dialogue_check_repeats",
    `Check what the audible dialogue plays across the current timeline, including kept takes and joins. Give its version. A check that keeps nothing reads the edit as it is now, and when that is not the version you gave, \`readInsteadOf\` names yours: use the returned \`version\` for removeRepeat. A check that keeps repeats needs the version they were heard on. The independent speech reading returns repeated phrases, both occurrences in timeline seconds, and their surrounding words. Use dialogue_apply_cuts with removeRepeat to remove either measured occurrence listed under removable. The save checks playback again. Keep an intentional repeat by passing its measured id and a short editorial reason: it plays on, and the editor is not shown it. To leave one to the editor, stage the occurrence with removeRepeat and decision review, which settles it here. Kept decisions belong to this pass. offset pages through the outstanding pairs and the joins in \`fragments\`, 25 at a time, and nextOffset is set while either has more. A pair marked \`restart\` is a phrase the transcript plays again after other words, within ${RESTART_WITHIN_SECONDS} s: \`first\` is the whole first attempt, the phrase and what followed it (\`between\`), up to where the phrase starts again, so removing \`first\` takes out the abandoned attempt and keeps the one that replaced it. A restart, a retake left beside its replacement and a deliberate parallel all read this way: which it is takes the sentence, and that call is yours. \`silences\` lists each stretch of silencesFrom seconds or more (${SILENCE_LEFT_SECONDS} s when omitted; how long a silence may play is the skill's pace) the edit still plays without a word, in timeline seconds, with the words either side and where it starts in the recording. Cut or shorten one as any pause, or keep it by its id with what the viewer sees or hears through it. \`shortPieces\` lists each stretch of one recording the edit plays for under piecesUnder seconds (${SHORT_PIECE_SECONDS} s when omitted; how short a piece plays as a stutter is the skill's pace) between two cuts in it, such as a word or a reaction left alone between a retake and a trimmed wait: from and to in timeline seconds, \`plays\` the words in it, \`before\` and \`after\` the words played either side, and \`cutBefore\` and \`cutAfter\` the seconds of the recording each of the two cuts takes out. Take it out with the cuts either side, put back what one of them took so it plays on with the speech beside it, or keep it by its id with why it plays that way. \`fragments\` lists each join that took words out of a sentence and that dialogue_apply_cuts did not place: one made by timeline_propose, as a ripple or a saved timeline, or by timeline_first_cut. \`before\` and \`after\` are the words the edit plays either side of it at \`at\` (timeline seconds), \`removedStart\` and \`removedEnd\` the first and last of the \`removed\` words it took out between \`out\` and \`in\` in the recording, and \`split\` the side whose sentence the transcript says was divided (out = the words before began one, in = the words after finish one). Read each as the viewer hears it. A join that reads as a whole thought is kept by its id, with the sentence as it now reads. One that leaves a stray word, a sentence without its end, or a clause without the words it depends on is repaired: remove the leftover words (mediaId with fromWord/toWord, counted from \`lastWord\` or \`firstWord\`, the transcript indices of the last word played before the join and the first after it), or put back the words the sentence needs. Restarts, silences, short pieces and these joins count in \`remaining\` with the repeats. The same reading hears each played join, letter by letter from the sound rather than the transcript: \`joins\` lists one whose edge cuts through a kept word (issue clipped: heard is what plays, expected the transcript's word) or plays a sound outside the kept words (issue fragment: a leftover of a removed take, a sigh, a breath, with keptWord, the first or last kept word, which plays whole, and keptWordAt where it starts or ends), with the side (out = before the join, in = after) and where it starts in the recording. A clipped word needs the edge moved out to take it in whole before you finish: the editor hears it. A fragment is moved past, toward keptWordAt, or kept, as the skill says of breaths and sounds at a join; a leftover of a removed take always goes. \`unheardJoins\` counts, per recording, the joins with a side in a language this reading can't hear letter by letter, between from and to in timeline seconds, so it checked nothing there: measure them with timeline_join_audit from/to. \`sync\` checks recordings of the same event that play together (a camera over a screen capture, a separate mic): \`outOfLine\` lists stretches in timeline seconds placed at another offset than the rest, with differsBy in seconds, and \`heard\` compares their sound at a few spots spread through the edit (late = seconds the secondary sounds after the reference; a frame or more is visible on lips and clicks). A stretch out of line on purpose, such as a cutaway to another moment of the screen, stays; put any other back in line before you finish. When a stretch stays out of line or the sound is a frame or more off, tell the editor in your closing reply, with \`summary\` and why. \`pictures\` lists what the picture does across the video, in timeline seconds, 25 at a time, and counts in \`remaining\`: \`brief\`, a picture on screen for under a second between two others (\`shows\`, \`before\` and \`after\` name the clips; an end in \`recordingCuts\` is a cut in the recording itself); \`offPicture\`, a recording laid over the main picture elsewhere that is off it here while it still shows what it showed beside it: lines of its text still there (\`showing\`) or nothing in its frame changed (\`unchanged\`), the words heard (\`said\`) and the passages of its text read aloud word for word (\`reads\`). Change the picture there, or keep one by its id with why it plays that way, as the skill and the editor ask.`,
    { version: z.string(), keep: z.array(z.object({ id: z.string(), reason: z.string().trim().min(1).max(300) })).max(100).optional(), offset: z.number().int().nonnegative().optional(),
      silencesFrom: z.number().finite().min(0.3).max(30).optional().describe(`List in silences, and count in remaining, each wordless stretch at least this many seconds long. From the pace the skill asks for; ${SILENCE_LEFT_SECONDS} s when omitted.`),
      piecesUnder: z.number().finite().min(0.1).max(10).optional().describe(`List in shortPieces, and count in remaining, each piece between two cuts shorter than this many seconds. From the pace the skill asks for; ${SHORT_PIECE_SECONDS} s when omitted.`) },
    async ({ version, keep, offset, silencesFrom, piecesUnder }) => json(await checkRepeats(version, keep, offset, silencesFrom, piecesUnder)));

  tool("dialogue_check_join",
    `Check proposed dialogue removals on a timeline version before submitting them. Give one range, or list up to 100 as \`cuts\` to check them in one call; each is given the same way. ${cutCoordinates} Where two words run together with no pause, the edge goes at the lowest level between them if that is down at room tone (${DIP_DBFS} dBFS or lower) or a trough well under the sound either side, and the removal's other edge has a pause; an edge in sound with no quiet nearby moves to the nearest such trough, as the recording places it, and the result says what was measured. A word reference keeps its exact performance. alternativeWordRanges lists other indices that leave the same transcript text, with measured edge problems and dips. Submit the indices of the performance you choose. Slow checks return status "measuring", the completed readings and the zero-based pendingCuts. Repeat the same arguments on the returned version after retryAfterSeconds to collect the full readings. This changes nothing. Returns status (unchanged = both edges quiet; snapped = an edge moved a few frames onto silence and applies as given; adjusted/partial = a larger move that narrows the removal and goes to review; review = no safe edge), the resulting range, per edge the source second, sound (quiet | valley | sound), RMS dBFS in 20 ms steps from 0.3 s before to 0.3 s after the edge (\`|\` marks it) and the nearest quiet points either side, and nearbyWords as [timeline start, timeline end, text] from the scan. removes and plays give the words the removal takes out and its join as the viewer hears it: read them before choosing which delivery goes. sameWordJoin gives the seconds for a restart that begins on the word the first take broke off after, where no pause lets the cut start: where the first delivery begins, matched to the second on their sound, and as takesFirst the kept words the range leaves playing twice that a cut from there takes out too. Nothing Scarlet measures says how that join plays: a cut saved there applies as placed with unsureJoins cut and otherwise waits in review for your cut, ask or keep. The kept audio is independently read for up to ${JOIN_WORD_SECONDS} source seconds on each side of the proposed removal. unreadJoinAudio names a reading that was unavailable. repeatAtJoin identifies a word or phrase that the proposed join would play twice, with both occurrences in timeline seconds. partialWordRepeat identifies a fragment of a word beside another complete delivery, including sound inside the audio crossfade. Its side and ranges locate the fragment on the input timeline. pickupRepeats lists a doubled word or phrase opening or ending the kept take, with each occurrence and the side of the removal. When a prior scan measured an immediate restart, acousticRetakeContinuity reports which delivery the original range removes and whether the word following the second delivery stays connected to the retained take. Its source word times are approximate. An optional resumeWith quote is checked at the original end. With \`cuts\`, the result has \`joins\` in the same order, and a range that cannot be checked carries its own \`error\`. A list too long to return whole leaves out nearbyWords, per-edge readings (\`audio\`) and alternativeWordRanges, on unchanged joins first and then on the others from the end of the list. If needed, it then omits acousticRetakeContinuity and partialWordRepeat details. Every join keeps its status and range, and \`evidenceLeftOut\` lists the indices of the joins that came back without some of it: check the ones you need again in a shorter list.`,
    { version: z.string(), crossfadeFrames, pace: paceInput, breath: breathInput("fromWord/toWord", "The result's breath names any found, either way."), ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(), resumeWith,
      cuts: z.array(z.object({ ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(), resumeWith }))
        .min(1).max(100).optional().describe("Several removals to check in one call, instead of start/end or a word reference"),
      ...audioOption("Attach about two seconds of the original recording around each edge as WAV, for a single range") },
    async ({ version, includeAudio, resumeWith, cuts, crossfadeFrames = 0, pace, breath, ...cut }) => {
      const tl = await peekTimeline(version);
      const snapshot = tl.version === "draft" ? createHash("sha256").update(JSON.stringify(tl)).digest("hex") : tl.version;
      const key = JSON.stringify([snapshot, cuts, cut, resumeWith, crossfadeFrames, pace, breath, !!includeAudio]);
      return joinChecks.collect(key, tl.version, cuts?.length ?? 1, async publish => {
        const { project } = await getProject();
        const resolve = async (c: typeof cut, label: string) => {
          const resolved = await resolveCutRange(tl, c, label, { ...planSources, pace, breath }, true);
          if (resolved.start >= resolved.end || resolved.end > timelineDuration(tl)) {
            throw new Error(`${label} ${resolved.start}–${resolved.end} s is not a nonempty range inside version ${tl.version} (0–${timelineDuration(tl).toFixed(2)} s).`);
          }
          return resolved;
        };
        const report = async (resolved: Awaited<ReturnType<typeof resolve>>, quote: string | undefined) => {
          const range = { start: resolved.start, end: resolved.end };
          // Edges placed beside the named words stand as placed, here as in dialogue_apply_cuts.
          const pages = joinPages();
          const checked = "dips" in resolved && !resolved.problems.length
            ? { ...range, status: "unchanged" as const, reason: resolved.dips.length ? resolved.dips.join(" ") : "Scarlet placed both edges in the measured silence beside the words." }
            : checkDialogueJoin(tl, project, range, pages, "spoken" in resolved ? resolved.spoken : undefined, pace, "air" in resolved ? resolved.air : undefined);
          const played = frameAligned(checked, project.settings.fps);
          const nearbyWords = dialogueJoinWords(tl, project, played, pages);
          const heard = await cutReading(tl, project, played, mediaId => transcriptWords(mediaId, false).catch(() => null));
          const continuity = acousticRetakeJoin(tl, project, range, acousticRetakePages.values());
          const { repeatAtJoin, partialWordRepeat, pickupRepeats, unread } = await checkKeptWords(tl, project, played, nearbyWords, planSources.readKeptWords,
            undefined, undefined, { at: played.start, preview: () => dialogueCutPreview(tl, project.media, [played], crossfadeFrames / project.settings.fps) });
          const audio = joinAudio(tl, project, range, pages);
          const inspected = audio.some(edge => edge.levels || edge.words) ? () => {
            readPassage(tl.version, range, true);
            readPassage(tl.version, checked, true);
          } : undefined;
          return { inspected, reading: { originalRange: range,
            ...("wordRef" in resolved && { words: resolved.words, sourceRange: resolved.source, ...(resolved.problems.length && { wordEdgeProblems: resolved.problems }) }),
            ...("breath" in resolved && resolved.breath && { breath: resolved.breath }),
            ...("notes" in resolved && resolved.notes.length && { notes: resolved.notes }),
            ...("alternativeWordRanges" in resolved && { alternativeWordRanges: resolved.alternativeWordRanges }),
            ...checked, ...heard, audio, nearbyWords, ...(partialWordRepeat && { partialWordRepeat }), ...(continuity.length && { acousticRetakeContinuity: continuity }), ...(unread.length && { unreadJoinAudio: unread }), ...(repeatAtJoin && { repeatAtJoin }), ...(pickupRepeats.length && { pickupRepeats }),
            ...(quote && { resumeAtOriginalEnd: checkResumeQuote(tl, project, range.end, evidence.scans, quote) }) } };
        };
        if (cuts) {
          if (Object.values(cut).some(value => value !== undefined) || resumeWith) {
            throw new Error("Give either one range or a cuts list, not both.");
          }
          const checkedRanges = await Promise.all(cuts.map(async ({ resumeWith: quote, ...c }, i) => {
            try {
              const resolved = await resolve(c, `cuts[${i}]`);
              await measureAround(audibleSourcePoints(tl, [resolved.start, resolved.end]), project.media);
              const { reading, inspected } = await report(resolved, quote);
              publish(i, reading, inspected);
              return [resolved];
            } catch (err) {
              publish(i, { error: describeError(err) });
              return [];
            }
          }));
          await reportChecked(tl, checkedRanges.flat());
          return;
        }
        const resolved = await resolve(cut, "Range");
        await measureTimeline(tl, [resolved.start, resolved.end]);
        await reportChecked(tl, [resolved]);
        const { reading: checked, inspected } = await report(resolved, resumeWith);
        publish(0, checked, inspected);
        const result = json({ version: tl.version, ...checked });
        if (!includeAudio || !hearing) return result;
        for (const edge of checked.audio) {
          const from = Math.max(0, edge.at - 1);
          try {
            const { wav } = await client.sourceAudio(projectId, { mediaId: edge.mediaId, from, to: edge.at + 1 });
            result.content.push({ type: "text", text: `Original ${edge.edge} edge of ${edge.mediaId}: the boundary is ${(edge.at - from).toFixed(2)} s into this clip (source ${edge.at} s).` },
              { type: "audio", mimeType: "audio/wav", data: wav });
          } catch (err) {
            noteEvidenceMiss("join audio");
            result.content.push({ type: "text", text: `Audio for the ${edge.edge} edge is unavailable: ${describeError(err)}. Judge it from the levels.` });
          }
        }
        return result;
      }, joinWaitMs ?? 40_000);
    });

  /** Silences of two seconds or more inside this part that none of its decisions covers, on the version it was planned on. */
  async function passedSilences(tl: Timeline, kept: Array<{ start: number; end: number }>,
    decisions: Array<{ start: number; end: number }>, range?: { start: number; end: number }) {
    const decided = [...decisions.map(d => ({ start: d.start, end: d.end })), ...kept];
    if (!decided.length) return [];
    // Without a range, the part reaches from its first decision to its last.
    const scope = range ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) };
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const id of new Set(audibleMediaClips(tl).map(c => c.mediaId))) {
      const words = await transcriptWords(id, false).catch(without(`failed to read the words of ${id} for the silences a part keeps`, null));
      if (words) transcripts.set(id, words);
    }
    // From the silence length the pass last asked the closing check for, so both list the same stretches.
    return keptSilences(tl, timelineWords(tl, transcripts, scope), decided, silencesAsked);
  }

  /**
   * What earlier saves of this pass already listed as still playing. A later part reaches back over the earlier ones,
   * and on one pass its last save listed 58 things of which a handful were new: a chime and a 1.7 s wait among them
   * went unread. Each save lists a thing once; a pause comes back only if it now plays a different length.
   */
  const listed = new Set<string>();
  const listing = (kind: string, mediaId: string, source: number, seconds?: number) =>
    `${kind}/${mediaId}/${source.toFixed(1)}${seconds === undefined ? "" : `/${seconds.toFixed(1)}`}`;
  const fresh = (...thing: Parameters<typeof listing>) => !listed.has(listing(...thing));
  /** Only what a save actually returns counts as listed: items trimmed to fit resultChars stay fresh for the next save. */
  const candidate = <T>(item: T, ...key: Parameters<typeof listing>) => ({ item, key: listing(...key) });

  /** Pauses and doubled words this part still plays once its cuts are out, on the version it was planned on. */
  async function passedLeftovers(tl: Timeline, kept: Array<{ start: number; end: number }>,
    decisions: Array<{ start: number; end: number; review: boolean }>, range?: { start: number; end: number }, pausesFrom?: number) {
    const decided = [...decisions, ...kept];
    if (!decided.length) return { pauses: [], repeats: [], gaps: [] };
    const scope = range ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) };
    const transcripts = new Map<string, TranscriptWord[]>();
    for (const id of new Set(audibleMediaClips(tl).map(c => c.mediaId))) {
      const words = await transcriptWords(id, false).catch(without(`failed to read the words of ${id} for what a part still plays`, null));
      // keptPauses and repeatedWords name their words by these indices.
      showWords(id, words);
      if (words) transcripts.set(id, words);
    }
    // A range staged for review still plays until the editor approves it.
    return partLeftovers(timelineWords(tl, transcripts, scope), decisions.filter(d => !d.review), kept, transcripts, pausesFrom ?? PAUSE_FLOOR_SECONDS);
  }

  /** The version a part continues on, read once however many lists are placed on it. */
  const continued = new Map<string, Promise<Timeline>>();
  const timelineAt = (version: string, planned: Timeline) => {
    if (version === planned.version) return Promise.resolve(planned);
    let read = continued.get(version);
    if (!read) { continued.clear(); continued.set(version, read = client.timeline(projectId, version).then(r => r.timeline)); read.catch(() => continued.delete(version)); }
    return read;
  };

  /** Where those silences sit on the version the pass continues on, longest thirty at most, in playback order. */
  async function placeSilences(found: Awaited<ReturnType<typeof passedSilences>>, version: string, planned: Timeline) {
    if (!found.length) return [];
    const after = await timelineAt(version, planned);
    return found.flatMap(k => {
      const at = sourceToTimeline(after, k.mediaId, k.source.start).find(p => p.audible)?.time;
      return at === undefined ? [] : [{ at, seconds: k.seconds, after: k.after, before: k.before, ...(k.afterWord !== undefined && { afterWord: k.afterWord }) }];
    }).sort((a, b) => b.seconds - a.seconds).slice(0, 30).sort((a, b) => a.at - b.at);
  }

  /** Quiet words still playing in the submitted part. Compare levels on the recording the editor actually hears. */
  async function keptQuietPhrases(tl: Timeline, version: string, decided: TimeRange[], span: TimeRange) {
    const { media } = await client.media(projectId);
    const firstStream = (clip: MediaClip) => {
      const asset = media.find(m => m.id === clip.mediaId);
      return asset && asset.kind !== "image" && asset.hasAudio !== false && (dialogueAudioStream(clip) ?? dialogueAudioStream(asset) ?? 0) === 0;
    };
    const clips = audibleMediaClips(tl).filter(c => firstStream(c) && rangesOverlap(span, { start: c.timelineIn, end: clipEnd(c) }));
    const phrases = (await Promise.all(clips.map(async clip => {
      const from = timelineToSource(clip, Math.max(clip.timelineIn, span.start));
      const to = Math.min(clip.sourceOut, timelineToSource(clip, span.end));
      const found = await readQuietPhrases(clip.mediaId, from, to)
        .catch(withoutOnce(`failed to measure the quiet phrases in ${clip.mediaId}`, [] as QuietPhrase[]));
      return found.flatMap(p => {
        const placed = { start: clipSourceToTimeline(clip, p.start), end: clipSourceToTimeline(clip, p.end) };
        if (!fresh("quietPhrase", clip.mediaId, p.start) || decided.some(d => rangesOverlap(d, placed))) return [];
        return [{ mediaId: clip.mediaId, phrase: p, at: placed.start }];
      });
    }))).flat();
    if (!phrases.length) return [];
    const after = await timelineAt(version, tl);
    const map = makeTimeMap(tl, after);
    const audible = audibleMediaClips(after).filter(firstStream);
    const placed = phrases.flatMap(p => {
      const at = map(p.at, "right");
      // A still-visible picture can anchor this time even if a concurrent edit removed its dialogue.
      if (at === null || !audible.some(c => c.mediaId === p.mediaId && p.phrase.start >= c.sourceIn && p.phrase.end <= c.sourceOut &&
        Math.abs(clipSourceToTimeline(c, p.phrase.start) - at) <= .001)) return [];
      return [{ ...p, at: round3(at) }];
    }).sort((a, b) => a.at - b.at);
    const result = [];
    const seen = new Set<string>();
    for (const { at, mediaId, phrase } of placed) {
      const key = listing("quietPhrase", mediaId, phrase.start);
      if (fresh("quietPhrase", mediaId, phrase.start) && !seen.has(key)) {
        seen.add(key);
        result.push({ item: { at, mediaId, ...phrase }, key });
      }
      if (result.length === 30) break;
    }
    return result;
  }

  tool("dialogue_apply_cuts",
    `Save your decisions on an assembled version: cut, review or keep ranges, sorted and nonoverlapping. ${cutCoordinates} Cut ranges apply together; review stages a range for the editor; keep or omission retains it. Scarlet measures each retake, filler, pause and quoted production edge. An edge on sound moves a few frames onto silence, or onto the low point between two words said in one breath, and applies; an edge between named words said straight through, with no low point, goes where the transcript parts them and applies; a larger move narrows the cut and stages it, unless unsureJoins is cut. An edge Scarlet can't move out of sound stays held, and its held reason says what the join plays, what the passage plays if the cut is kept and, for a range given in seconds, the nearest quiet or low point either side and the words moving there keeps or removes. A pause's edge moves onto the quiet beside it. A retake cut with no quiet to start in, where the take resumes on the word the first take broke off on, starts where the first delivery of that word begins, matched on the sound of the two; nothing measured says how that join plays, so it is staged, unless unsureJoins is cut. A range that leaves kept words playing twice that way is placed as given, and the gate says from where a cut takes them out too. A short piece between cuts with a transcript word at room-tone level returns quietKeptWord with nearby measured sound in source seconds. Footage between separate removals stays in the timeline. \`gate\` lists changes to the measured plan with their evidence. Its ranges describe placement before the engine rounds to project frames. The returned timelineEdits describe the saved edits. A resumeWith quote the scan reads differently doesn't hold its cut: the cut is placed as given and its gate line says what the scan reads after it. A coaching cut whose production quote doesn't verify, or a cut whose join would play words twice or a kept word too quietly, or that removes a restart and runs on past it, taking words at its edge that nothing either side of the join says again, or a pause trim whose range holds sound at speaking level that no word explains or whose pause holds words the transcript doesn't have, is left out with its evidence in \`notSaved\`, and the rest of the part saves. Save a long pass in parts and continue on \`continueFrom\`. For a first dialogue pass, send at most ${FIRST_CUT_BATCH_SIZE} nearby cut or review decisions as soon as they are ready, with any keep or protected ranges they depend on. The gate reports an applied cut whose edge sits within ${SPEECH_BESIDE_EDGE} s of the sound it removes, since the picture can show a word starting that the sound has not reached; whether that needs the editor is yours to judge. Each applied retake or coaching cut is listed with removes and plays: the words it takes out and its join as the viewer hears it. What Scarlet changed on its own comes back with why: \`stagedForEditor\` (confident cuts that wait for the editor), \`onFrames\` (edges put on whole frames), \`droppedFromReview\` (an earlier part's staged cuts whose footage a later edit broke up) and \`heldCutsStay\` (cuts not saved because, sent with unsureJoins cut, they would have replaced a staged cut held for its join with other edges Scarlet couldn't place either). For a requested crossfade, \`joinCrossfades\` reports how many joins were faded and why any stayed straight. The result also lists what this part still plays, each thing once per pass, at \`at\` on continueFrom: keptSilences (${SILENCE_LEFT_SECONDS} s or more without words that no decision covers, the silences dialogue_check_repeats lists, or from the length you last gave it as silencesFrom, with the afterWord that trims an untouched one), keptPauses (the longest thirty of ${PAUSE_FLOOR_SECONDS} s or more, or from the length you give as pausesFrom, with the afterWord that trims an untouched one), repeatedWords (said twice in a row, with the pause the edit plays between them, atJoin when a cut made it; fromWord/toWord name the first) unexplainedSound (speaking-level sound the transcript has no word for, often what is left of a take beside a cut) and heardNotInTranscript (words the scan read in what this part still plays that the transcript has no word for, such as a false start or a repeat it tidied away: where and how long they play on the version the part continues on, the words, and the words round them as the scan read them; they have no word index, so a cut of them is given in timeline seconds). These are evidence, not decisions: a pause can be a beat, a repeat emphasis, a sound a breath. Ranges your previous part staged on that version join this part's review (carriedForward). Cuts already handed to the editor keep their passage and note (heldForReview). \`description\` is your one-sentence summary for the editor.`,
    { version: z.string(), description: z.string().min(1), crossfadeFrames, pace: paceInput, breath: breathInput("fromWord/toWord or removeRepeat", "The gate names any found, either way."), unsureJoins: unsureJoinsInput, noteIds: z.array(z.string()).optional(),
      range: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).optional().describe("Requested TIMELINE range if only part of the edit is in scope"),
      only: z.enum(["pause", "filler", "retake", "coaching"]).optional().describe("For a request limited to one type of removal. Omit for a full dialogue pass."),
      pausesFrom: z.number().finite().min(0.1).max(10).optional().describe(`List in keptPauses the pauses this part still plays from this length in seconds, word to word (${PAUSE_FLOOR_SECONDS} s when omitted). Yours to set from the pace the skill and the editor ask for; omit to see the longest ones`),
      cuts: z.array(z.object({ ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(),
        removeRepeat: z.object({ id: z.string(), occurrence: z.enum(["first", "second"]) }).optional().describe("For a retake, identify the occurrence heard by dialogue_check_repeats on this version. Scarlet places both edges using its measured words and waveform."),
        kind: z.enum(["pause", "filler", "retake", "coaching"]), decision: z.enum(["cut", "review", "keep"]),
        resumeWith,
        keepRepeat: z.union([repeatedPhrase, z.array(repeatedPhrase).min(1)]).optional().describe("For speech cuts and pause trims, quote a word or phrase that deliberately repeats across the join or at the beginning or end of the kept take. Pass a list to keep several. An unacknowledged repeat comes back to you before the plan is saved."),
        dropWords: z.union([repeatedPhrase, z.array(repeatedPhrase).min(1)]).optional().describe("For speech cuts, quote the words at an edge of the removal that you mean to take out though nothing either side of the join says them again, as a returned dispute names them. Pass a list for several."),
        productionQuote: z.string().trim().min(1).optional().describe("Optional check for a coaching cut: verify all the words in the removed production aside against the scan."),
        picture: z.enum(["safe", "uncertain", "protect"]).optional().describe("Protect preserves this range. For all other picture verdicts, decision controls whether the range is cut or staged for review."),
        reason: z.string().trim().min(1).describe("One short sentence on why you chose to cut, stage or keep this passage, shown on its card"),
        summary: CutAssessment.shape.summary.describe(`Required for a cut or review. ${cutRow}`),
        check: z.string().trim().min(1).max(120).optional().describe("For a cut that applies: a few words naming a doubt the editor must settle by listening or looking. Marks the cut as needing them until they keep it; omit when nothing is in doubt") }))
        .describe("For a faint line that still plays, keptQuietPhrases returns mediaId and fromWord/toWord for use here, its position on continueFrom (at), and the phrase and neighboring speech levels in dBFS.") },
    async ({ version, description, cuts: requested, noteIds, range, only, crossfadeFrames, pausesFrom, pace, breath, unsureJoins }) => {
      const unnamed = requested.flatMap((c, i) => c.decision !== "keep" && c.picture !== "protect" && !c.summary ? [i] : []);
      if (unnamed.length) throw new Error(`Give a summary for each cut and review: what it takes out and where, by the words beside it. Missing at cuts ${unnamed.join(", ")} (zero-based). Nothing was saved.`);
      const operation = await dialogueOperation();
      if (taskId && operation === "first-cut" && requested.filter(c => c.decision !== "keep" && c.picture !== "protect").length > FIRST_CUT_BATCH_SIZE)
        throw new Error(`Save up to ${FIRST_CUT_BATCH_SIZE} nearby cut or review decisions in each first-pass batch, with their keep and protected ranges. Send the first settled group now. For the next group use source word references or map its positions on continueFrom with timeline_at.`);
      const localPauses = operation === "local-pauses";
      const tl = await peekTimeline(version);
      // Edge checks, snapping, word references, quotes and the gate report: dialogue-plan.ts, shared with offline replay.
      const cuts = requested.map(({ removeRepeat, ...cut }) => {
        if (!removeRepeat) return cut;
        const occurrence = checkedVersion === tl.version && checkedRepeats.get(removeRepeat.id)?.occurrences[removeRepeat.occurrence];
        if (!occurrence || cut.kind !== "retake") throw new Error("Read dialogue_check_repeats on this version and select a removable occurrence for a retake.");
        return { ...cut, occurrence };
      });
      const anchor = await cutAnchor(tl);
      const scope = range || localPauses || selectedRange(anchor) ? cutScope(tl, anchor, range, localPauses) : undefined;
      const request = { tl, cuts, range: scope, only, localPauses, anchor, unsureJoins };
      // A dispute sets aside only the cuts it names; the rest of the batch is saved (planDialogueBatch).
      const batch = await planDialogueBatch(request, { ...planSources, crossfadeFrames, pace, breath });
      const plan = batch.plan;
      const setAside = batch.setAside && {
        cuts: batch.setAside.cuts, disputedEdges: batch.setAside.disputedEdges.map(({ cuts: _cuts, ...edge }) => edge),
        next: `These cuts were not saved; the rest of the batch was. ${refusalNext(batch.setAside.disputedEdges)} Resubmit only these on continueFrom.`,
      };
      const recordKept = (ranges: TimeRange[]) => ranges.length && taskId
        ? postEvent({ type: "log", text: "", data: { kind: "dialogue_preserved", version: tl.version, ranges } }) : undefined;
      if (plan.outcome === "preserved") {
        await recordKept(plan.kept ?? []);
        for (const [mediaId, batch] of scanBatches) batch.saved(tl, mediaId, plan.kept ?? []);
        return text("All listed passages were preserved.");
      }
      if (plan.outcome === "needsRevision") return json({ needsRevision: true, disputedEdges: plan.disputedEdges,
        next: `Nothing was saved. ${refusalNext(plan.disputedEdges)}` });
      // A ripple affects every track. Check the whole batch, including any edge adjustment, against the sayings it must retain.
      const retainedRepeats = requested.flatMap(c => {
        if (!c.removeRepeat || c.decision === "keep" || c.picture === "protect") return [];
        // A check of the repeats that ran meanwhile may have dropped the pair this cut named.
        const pair = checkedRepeats.get(c.removeRepeat.id);
        if (!pair) throw new Error("Read dialogue_check_repeats on this version and select a removable occurrence for a retake.");
        const kept = c.removeRepeat.occurrence === "first" ? pair.second : pair.first;
        return [{ start: kept.start, end: kept.end, reason: `The planned cuts also reach the delivery of “${pair.phrase}” you chose to keep.` }];
      });
      const clipped = retainedRepeats.filter(kept => plan.decisions.some(d => {
        const reach = d.originalRange ?? d;
        return reach.start < kept.end && reach.end > kept.start;
      }));
      if (clipped.length) return json({ needsRevision: true, disputedEdges: clipped, next: "Both deliveries would be affected. Choose boundaries that preserve one complete occurrence." });
      plan.kept.push(...retainedRepeats.map(({ start, end }) => ({ start, end })));
      const all = plan.decisions;
      await postEvent({ type: "log", text: "I’m applying the dialogue decisions to the timeline.", data: { kind: "editor_progress" } });
      // Stretches without words, pauses and doubled words this part still plays and leaves undecided, read on the version
      // it was planned on while the engine saves it: the save changes neither that version nor the transcripts.
      const leftBehind = together(
        async () => only && only !== "pause" ? [] : await passedSilences(tl, plan.kept, all, range)
          .catch(without("failed to find the silences this part keeps", [])),
        () => passedLeftovers(tl, plan.kept, all, range, pausesFrom)
          .catch(without("failed to read what this part still plays", { pauses: [], repeats: [], gaps: [] })));
      // A save that fails still waits for them, so its result says what they went without.
      const result = await client.submitDialogueCuts(projectId, { fromVersion: tl.version, description, cuts: all, range: scope, kept: plan.kept, crossfadeFrames,
        taskId, author, noteIds }).finally(() => leftBehind);
      const [undecided, left] = await leftBehind;
      const suggestion = result.changes.find(c => c.intent === "suggestion");
      if (result.changes.length) {
        stagedState.stageWithoutAppliedCuts = suggestion && !result.changes.some(c => c.state === "approved") ? suggestion.id : undefined;
        // Prepare the next review while the agent reads its save receipt.
        stagedState.stagedReview = suggestion && prepareReview(suggestion.id);
      }
      if (localPauses && !session.localRange && scope) session.localRange = { ...scope, version: tl.version };
      await recordKept(plan.kept);
      for (const [mediaId, batch] of scanBatches) batch.saved(tl, mediaId, [...all, ...plan.kept]);
      for (const [mediaId, reached] of readTo) savedAt.set(mediaId, reached);
      const reach = cutsReach(tl, all);
      for (const [mediaId, to] of reach) cutTo.set(mediaId, Math.max(cutTo.get(mediaId) ?? 0, to));
      // How far into each recording the saved cuts reach, so the editor's cut figure moves with every part: to the end
      // of the furthest cut, on the recordings the pass cuts. A pass that reads a whole recording before it saves its
      // first part has read to the end by then, and reporting the read finished the cut at that first save. The read
      // counts only where this part's cuts come within a page of it: a pass that saves as it reads has decided what it
      // read, and the last part finishes the cut though its last cut stops a little short of the recording's end.
      for (const [mediaId, to] of cutTo) {
        const read = readTo.get(mediaId) ?? 0, here = reach.get(mediaId);
        await postEvent({ type: "log", text: "", data: { kind: "pass_progress", mediaId, through: here !== undefined && here >= read - 60 ? Math.max(read, to) : to } });
      }
      moveBase(undefined);
      for (const c of result.changes) await postEvent({ type: "change", text: c.description,
        data: { changeId: c.id, toVersion: c.toVersion, state: c.state } });
      // Applied cuts move the edit forward. A part that only stages cuts leaves it where it was.
      const { head, ...reported } = result;
      const continueFrom = head ?? result.changes.find(c => c.intent !== "suggestion")?.toVersion ?? tl.version;
      const decided = [...all, ...plan.kept, ...(result.editorDecided ?? [])];
      // A stretch already listed as a kept silence is not listed again as a pause.
      const pauses = (only && only !== "pause" ? [] : left.pauses.filter(p => !undecided.some(u => u.mediaId === p.mediaId && u.source.start < p.source.end && u.source.end > p.source.start)))
        .filter(p => fresh("pause", p.mediaId, p.source.start, p.seconds));
      const repeats = (only && only !== "retake" && only !== "filler" ? [] : left.repeats).filter(r => fresh("repeat", r.mediaId, r.source));
      // The lists read at once: each lists its own kind of thing once per pass (`listed`), and they share one read of the
      // version the pass continues on (`timelineAt`).
      const [quiet, { kept, keptPauses, repeatedWords, unexplainedSound }, [heardNotInTranscript, audioRecheck]] = await together(
        async () => localPauses || only === "pause" || only === "filler" ? [] : await keptQuietPhrases(tl, continueFrom, decided,
          scope ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) })
          .catch(without("failed to place the quiet phrases the part still plays", [])),
        async () => {
          // One read of the version the pass continues on places all three lists.
          // Sound the part still plays between two words it keeps, beside its own cuts first: what is left of a take that came out.
          const sounding = only && only !== "retake" && only !== "filler" ? [] : (await Promise.all([...new Set(left.gaps.map(g => g.mediaId))].map(async mediaId => {
            const mine = left.gaps.filter(g => g.mediaId === mediaId);
            const read = await gapSounds(mediaId, mine.map(g => g.source)).catch(withoutOnce(`failed to read the levels between the words ${mediaId} still plays`, [] as Array<GapSound | undefined>));
            return mine.flatMap((g, i) => read[i]?.runs.length ? [{ mediaId, source: read[i]!.runs[0]!, seconds: read[i]!.seconds, after: g.after, before: g.before }] : []);
          }))).flat().filter(s => fresh("sound", s.mediaId, s.source.start));
          return await (async () => {
            const kept = await placeSilences(undecided, continueFrom, tl);
            const after = pauses.length || repeats.length || sounding.length ? await timelineAt(continueFrom, tl) : tl;
            const placed = <T extends { mediaId: string }>(items: T[], source: (item: T) => number) => items.flatMap(item => {
              const at = sourceToTimeline(after, item.mediaId, source(item)).find(p => p.audible)?.time;
              return at === undefined ? [] : [{ at, item }];
            });
            return { kept,
              // The longest thirty, in playback order.
              keptPauses: placed(pauses, p => p.source.start).sort((a, b) => b.item.seconds - a.item.seconds).slice(0, 30).sort((a, b) => a.at - b.at)
                .map(({ at, item: { source, ...p } }) => candidate({ at, ...p }, "pause", p.mediaId, source.start, p.seconds)),
              repeatedWords: placed(repeats, r => r.source).slice(0, 30).map(({ at, item: { source, atJoin, ...r } }) => candidate({ at, ...r, ...(atJoin && { atJoin }) }, "repeat", r.mediaId, source)),
              unexplainedSound: placed(sounding, s => s.source.start).sort((a, b) => b.item.seconds - a.item.seconds).slice(0, 30).sort((a, b) => a.at - b.at)
                .map(({ at, item: { source, ...s } }) => candidate({ at, ...s, sourceSeconds: [source.start, source.end] }, "sound", s.mediaId, source.start)),
            };
          })().catch(without(`failed to place the kept silences on ${continueFrom}`, { kept: [], keptPauses: [], repeatedWords: [], unexplainedSound: [] }));
        },
        async () => {
          // Words the scan read in what this part still plays that the transcript has no word for. A false start the
          // transcript tidied away has no index to cut it by and is in none of the lists above: a pass left “And it just
          // feel, uh” playing before “It just feels like”, and “a conscious conscientious objector”, having cut by a
          // transcript that read “And it just feels like” and “a conscientious objector” (2026-11-19).
          const heard = only && only !== "retake" && only !== "filler" ? [] : await (async () => {
            const after = await timelineAt(continueFrom, tl);
            const part = scope ?? { start: Math.min(...decided.map(d => d.start)), end: Math.max(...decided.map(d => d.end)) };
            // The part's stretch on the version it continues on: its applied cuts closed up that much of it.
            const removed = result.changes.some(c => c.intent !== "suggestion" && c.state === "approved")
              ? all.reduce((n, d) => d.review ? n : n + Math.max(0, Math.min(d.end, part.end) - Math.max(d.start, part.start)), 0) : 0;
            const found = await getPerception().heardOnlyOn(after, { start: part.start, end: Math.max(part.start, part.end - removed) });
            return found.filter(h => fresh("heard", h.mediaId, h.source.start)).slice(0, 30)
              .map(h => candidate({ at: h.start, seconds: round2(h.end - h.start), text: h.text, context: h.context,
                mediaId: h.mediaId, sourceSeconds: [h.source.start, h.source.end] }, "heard", h.mediaId, h.source.start));
          // An extra reading: a version or an engine that can't give it leaves the receipt as it was.
          })().catch(() => []);
          // The repeat check comes after those words: where it reads a language from the scan, it saves pages they'd read.
          const recheck = checkedVersion === tl.version || task?.repeatAudit?.version === tl.version
            ? await checkRepeats(continueFrom).catch((error: Error) => {
              noteEvidenceMiss("repeat audit");
              return { version: continueFrom, error: error.message, next: "The edit was saved. Retry dialogue_check_repeats on this version." };
            })
            : undefined;
          return [heard, recheck] as const;
        });
      const maxChars = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      const gate = dialogueGate(plan);
      const next = result.changes.some(c => c.intent === "suggestion")
        ? "Pending ranges are on the kept version. The editor sees a staged cut as a call only once it has your recommendation, so record them on this part before you read on: dialogue_review_inspect gives their context, up to four at once with count while Scarlet prepares the next ones, and dialogue_review_save records a recommendation. Recommendations carry into the review of your next part."
        : undefined;
      let recheckOut: unknown = audioRecheck;
      const keptOut = kept.slice();
      const pausesOut = keptPauses.slice();
      const repeatsOut = repeatedWords.slice();
      const soundOut = unexplainedSound.slice();
      const heardOut = heardNotInTranscript.slice();
      const quietOut = quiet.slice();
      const trimmed: Record<string, number> = {};
      const buildReceipt = () => ({
        ...reported, continueFrom,
        ...(recheckOut ? { audioRecheck: recheckOut } : {}),
        gate,
        ...(plan.unreadJoinAudio && { unreadJoinAudio: plan.unreadJoinAudio }),
        ...(keptOut.length && { keptSilences: keptOut }),
        ...(pausesOut.length && { keptPauses: pausesOut.map(c => c.item) }),
        ...(repeatsOut.length && { repeatedWords: repeatsOut.map(c => c.item) }),
        ...(soundOut.length && { unexplainedSound: soundOut.map(c => c.item) }),
        ...(heardOut.length && { heardNotInTranscript: heardOut.map(c => c.item) }),
        ...(quietOut.length && { keptQuietPhrases: quietOut.map(c => c.item) }),
        ...(Object.keys(trimmed).length && { leftoversOmitted: trimmed }),
        ...(setAside && { notSaved: setAside }),
        next,
      });
      let receipt = buildReceipt();
      if (JSON.stringify(receipt).length > maxChars && audioRecheck && !("error" in audioRecheck)) {
        const picturesCount = audioRecheck.pictures?.length ?? 0;
        recheckOut = {
          version: audioRecheck.version,
          remaining: audioRecheck.remaining,
          ...(audioRecheck.readInsteadOf && { readInsteadOf: audioRecheck.readInsteadOf }),
          ...(audioRecheck.repeats.length && { repeatsCount: audioRecheck.repeats.length }),
          ...(audioRecheck.silences?.length && { silencesCount: audioRecheck.silences.length }),
          ...(audioRecheck.shortPieces?.length && { shortPiecesCount: audioRecheck.shortPieces.length }),
          ...(audioRecheck.fragments?.length && { fragmentsCount: audioRecheck.fragments.length }),
          ...(audioRecheck.joins?.length && { joinsCount: audioRecheck.joins.length }),
          ...(picturesCount && { picturesCount }),
          ...(audioRecheck.sync && { syncSummary: audioRecheck.sync.summary }),
          next: "Abbreviated to fit result size; call dialogue_check_repeats on continueFrom for the full list.",
        };
        receipt = buildReceipt();
      }
      if (JSON.stringify(receipt).length > maxChars) {
        // Trim secondary leftover lists from the end before recording them in `listed`, so omitted items stay fresh.
        const lists: Array<[string, Array<unknown>]> = [
          ["keptPauses", pausesOut],
          ["unexplainedSound", soundOut],
          ["keptSilences", keptOut],
          ["keptQuietPhrases", quietOut],
          ["repeatedWords", repeatsOut],
          ["heardNotInTranscript", heardOut],
        ];
        for (const [name, list] of lists) {
          while (list.length > 0 && JSON.stringify(receipt).length > maxChars) {
            list.pop();
            trimmed[name] = (trimmed[name] ?? 0) + 1;
            receipt = buildReceipt();
          }
          if (JSON.stringify(receipt).length <= maxChars) break;
        }
      }
      for (const list of [pausesOut, repeatsOut, soundOut, heardOut, quietOut]) {
        for (const entry of list) listed.add(entry.key);
      }
      return json(receipt);
    });
}
