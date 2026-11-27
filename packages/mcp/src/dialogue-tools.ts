import { createHash } from "node:crypto";
import { z } from "zod/v3";
import {
  cutScope,
  DEFAULT_RESULT_CHARS,
  JOIN_WORD_SECONDS,
  selectedRange,
  RESTART_WITHIN_SECONDS,
  SHORT_PIECE_SECONDS,
  SILENCE_LEFT_SECONDS,
  SMALL_TEXT_PERCENT,
  type AgentCapabilities,
  type ScarletClient,
  type ScarletToolName,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import {
  CutAssessment,
  frameAligned,
  timelineDuration,
  type Author,
  type TimeRange,
  type Timeline,
  type TranscriptWord,
} from "@scarlet/timeline";
import { round2 } from "./analysis.js";
import { DialogueEvidence } from "./dialogue-decisions.js";
import {
  checkDialogueJoin,
  checkKeptWords,
  checkResumeQuote,
  dialogueCutPreview,
  dialogueJoinWords,
  DIP_DBFS,
  joinAudio,
} from "./dialogue-join.js";
import { PAUSE_FLOOR_SECONDS, shortPiecesInPart } from "./dialogue-leftovers.js";
import { deliverWav, listening } from "./inspection-tools.js";
import {
  cutReading,
  cutsReach,
  dialogueGate,
  planDialogueBatch,
  resolveCutRange,
  SPEECH_BESIDE_EDGE,
} from "./dialogue-plan.js";
import { audibleSourcePoints } from "./dialogue-reading.js";
import { acousticRetakeJoin } from "./dialogue-retake-join.js";
import { FIRST_CUT_BATCH_SIZE } from "./dialogue-scan-batch.js";
import type { GapSound } from "./gap-sound.js";
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
  undescribed,
  unsureJoinsInput,
  WordRef,
} from "./mcp-schema.js";
import type { MediaSession } from "./media-session.js";
import type { SessionErrorHelpers } from "./media-state.js";
import type { PerceptionApi, ProposePipeline } from "./propose-pipeline.js";
import { sourceToTimeline } from "./timeline-perception.js";
import {
  describeError,
  json,
  noteEvidenceMiss,
  text,
  type ToolRegistrar,
} from "./tool-result.js";
import { JoinChecks } from "./join-checks.js";
import { createDialoguePartLeftovers, spanOf } from "./dialogue-part-leftovers.js";
import { createDialogueRepeatCheck } from "./dialogue-repeat-check.js";
import { createDialogueScanReader } from "./dialogue-scan-reader.js";
import { fitRepeatPage, receiptChanges, receiptGate, receiptOnFrames } from "./dialogue-receipt.js";
import type { StagedReview, StagedReviewState } from "./staged-review.js";

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
  writeArtifact?(path: string, data: Uint8Array): Promise<string>;
  getPerception(): PerceptionApi;
}

export function registerDialogueTools(deps: DialogueToolsDeps) {
  const {
    tool, client, projectId, taskId, task, author, caps, joinWaitMs,
    evidence, session, errors, stagedState,
    dialogueOperation, readPassage, postEvent, prepareReview, writeArtifact, getPerception,
  } = deps;
  const {
    getProject, peekTimeline, moveBase, cutAnchor, transcriptWords,
    gapSounds, measureAround, joinPages, measureTimeline,
    refusalNext, planSources,
  } = session;
  const { without, withoutOnce, together } = errors;
  const listen = listening(caps, !!writeArtifact);
  const defaultAudio = listen?.by === "file";
  const audioOption = createAudioOption(!!listen, defaultAudio);

  const joinChecks = new JoinChecks(caps.resultChars);
  const scanReader = createDialogueScanReader(deps);
  const { checkRepeats, checkedRepeats, checkedVersion, silencesAsked, piecesAsked } = createDialogueRepeatCheck(deps);
  const { passedSilences, listed, fresh, candidate, passedLeftovers, timelineAt, placeSilences, keptQuietPhrases } =
    createDialoguePartLeftovers({ ...deps, silencesAsked });

  // How far into each recording the furthest saved cut reaches.
  const cutTo = new Map<string, number>();
  // Whether a save has already said why its cuts moved onto whole frames: the reason is the same every time.
  let framesExplained = false;
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

  tool("dialogue_scan",
    "Read a dialogue recording in pages (60 s pages overlapping by 2 s, source seconds). Start at the beginning of the requested range, also when resuming; read the page and any restoredPages, then call again with nextFrom until it is null. On a first dialogue cut, save decided cuts when a page returns saveCheckpoint before reading the next section. During a task Scarlet scans the whole range in the background, so later pages often return at once; a page still analyzing says so, and you can collect it after reviewing other material. Times are source seconds to the hundredth. mediaId, detectors and voiceDetectionAvailable are given once a call: a restored page repeats one only where it differs. A list a page found nothing in is left out (fillers, fillerCandidates, repeatedTakes, unmatchedVoice, pauses, silences). Each page: passages (spoken text, with `words` = [first, last] transcript_get indices once the saved transcript's words are placed on the audio that far; timing segment where only the segment's time is known, otherwise each word is timed), repeatedTakes (attempts at the same line with the source times and continuation of each; evidence, not a decision), acousticRepeatedTakes (adjacent deliveries independently decoded from cached English speech, with approximate source times and continuation), fillers and fillerCandidates (each with the detectors that heard it: whisper = verbatim transcription, uhm = acoustic filler model; both agreeing is the strongest evidence), pauses (quiet stretches that could be removed: [start, end, before, after, airBefore, airAfter, maxPeakDb] for a quiet interior between the words before and after, with the air either side in seconds and its loudest peak in dBFS, or [start, end] for a quiet run found by low levels and no detected voice alone; a last item \"timing\" means the words' timing disagrees with the detected voice there: audition the boundary, or review the words before trimming), silences (every stretch of 1.5 s or more with no transcript word, whatever sounds in it: the words either side, voiceSeconds the voice detector fired inside it with no word, as typing or a breath does, and, where the current edit shows video through it, picture per video source (mediaId only on a video other than this recording): changedFrames of frames, the typical and the largest changed region in percent of the frame, and when the largest and the last change happen in this recording's seconds; `measuring` is ready on the next read of the page), unmatchedVoice ([start, end] of voice activity no transcript word explains: breaths, overlapping talk or missed words), speakerTurns (recording-local voice numbers; a number marks a distinct voice, and only confirmed input roles say which is the presenter; a page with one voice gives its number as speaker instead), otherVoiceTurns (on a recording with a mix and two isolated inputs: each stretch of sound on the input the dialogue is not on, such as a remote voice or a system sound, with the words heard only there and meAlsoActive when the dialogue input sounded too), roomToneDbfs, and quietPhrases (transcribed words much quieter than the speech on both sides, with source seconds, fromWord/toWord, and the phrase and neighboring levels in dBFS). detectorIssue names incomplete evidence.",
    { mediaId: z.string(), from: z.number().finite().nonnegative().default(0),
      until: z.number().finite().positive().optional().describe("Exclusive end of the requested source range. Defaults to the end of this recording."),
      noCutsReadyThrough: z.number().finite().nonnegative().optional().describe("The through value of a saveCheckpoint, only if this section has no settled cuts to save yet.") },
    args => scanReader.scan(args));

  tool("dialogue_check_repeats",
    `Check what the audible dialogue plays across the current timeline, kept takes and joins included. Give its version. A check that keeps nothing reads the edit as it is now; when that isn't your version, \`readInsteadOf\` names yours: use the returned \`version\` for removeRepeat. A check that keeps repeats needs the version they were heard on. Repeats, \`silences\`, \`shortPieces\`, \`fragments\` and \`pictures\` count in \`remaining\`; keep any of them by its id with a short reason (it plays on, and the editor isn't shown it), and kept decisions belong to this pass. offset pages through the outstanding pairs, \`fragments\` and \`pictures\`, 25 at a time or fewer when 25 wouldn't fit in one result, with nextOffset set while any has more.

Repeats: an independent speech reading lists repeated phrases, both occurrences in timeline seconds, with the words around them. Remove either occurrence listed under removable with dialogue_apply_cuts removeRepeat (the save checks playback again), or leave it to the editor by staging it with removeRepeat and decision review, which settles it here. A pair marked \`restart\` is a phrase played again after other words, within ${RESTART_WITHIN_SECONDS} s: \`first\` is the whole first attempt, the phrase and what followed it (\`between\`) up to where it starts again, so removing \`first\` takes out the abandoned attempt. A restart, a retake left beside its replacement and a deliberate parallel all read this way: which it is depends on the sentence, and is your call.

\`silences\`: each wordless stretch of silencesFrom seconds or more (${SILENCE_LEFT_SECONDS} s when omitted) the edit still plays, in timeline seconds, with the words either side and where it starts in the recording. Cut or shorten one as any pause, or keep it with what the viewer sees or hears through it.

\`shortPieces\`: each stretch of one recording played for under piecesUnder seconds (${SHORT_PIECE_SECONDS} s when omitted) between two cuts in it: from and to in timeline seconds, \`plays\` its words, \`before\` and \`after\` the words either side, \`cutBefore\` and \`cutAfter\` the seconds each cut takes out. Take it out with the cuts either side, restore what one took so it plays on with the speech beside it, or keep it with why.

\`fragments\`: each join that took words out of a sentence that dialogue_apply_cuts didn't place (timeline_propose or timeline_first_cut made it): \`before\` and \`after\`, the words played either side at \`at\` (timeline seconds); \`removedStart\` and \`removedEnd\`, the first and last \`removed\` words, between \`out\` and \`in\` in the recording; \`split\`, the side whose sentence the transcript says was divided (out = the words before began one, in = the words after finish one). Keep one that reads as a whole thought, with the sentence as it now reads. Repair one that leaves a stray word, a sentence without its end or a clause without what it depends on: remove the leftover words (mediaId with fromWord/toWord, counted from \`lastWord\` or \`firstWord\`, the indices of the last word before the join and the first after), or put back what the sentence needs.

\`joins\`: the same reading hears each played join letter by letter from the sound: an edge that cuts through a kept word (issue clipped: heard is what plays, expected the transcript's word) or plays a sound outside the kept words (issue fragment: a leftover take, a sigh, a breath, with keptWord, which plays whole, and keptWordAt where it starts or ends), with the side (out = before the join, in = after) and where it starts in the recording. Move a clipped edge out to take the word in whole before you finish. Move past a fragment toward keptWordAt, or keep it as the skill says of breaths and sounds; a leftover take always goes. \`unheardJoins\` counts, per recording, joins with a side in a language this reading can't hear, between from and to (timeline seconds): measure them with timeline_join_audit.

\`sync\`, for recordings of one event that play together (a camera over a screen capture, a separate mic): \`outOfLine\` lists stretches placed at another offset than the rest, with differsBy in seconds, and \`heard\` compares their sound at a few spots (late = seconds the secondary sounds after the reference; a frame or more shows on lips and clicks). A stretch out of line on purpose, such as a cutaway to another moment of the screen, stays; put any other back in line. When one stays out of line or the sound is a frame or more off, tell the editor in your closing reply, with \`summary\` and why.

\`pictures\`, in timeline seconds: \`brief\`, a picture on screen under a second between two others (\`shows\`, \`before\`, \`after\`; an end in \`recordingCuts\` is a cut in the recording itself); \`offPicture\`, a recording laid over the main picture elsewhere that is off it here while it still shows what it showed beside it (\`showing\`, \`unchanged\`, \`said\`, \`reads\`); \`moveAcrossCut\`, a gliding zoom or pan across a switch to a new screen, page or demo (\`screenChangeAt\`, \`fromFrame\`, \`toFrame\`; cut straight with \`over: 0\` instead); \`clippedText\`, text sliced by the frame's edges (\`sides\`, \`lines\`) or read-aloud text left outside it (\`reads\`); \`underCover\`, text, read-aloud words or detail hidden under an inset such as the camera (\`lines\`, \`cornersClearOfText\`, \`coverHides\`, \`detailInCorners\`, \`reads\`, \`action\`); \`smallText\`, framed text whose usual line height is under smallTextUnder percent of the video's height (${SMALL_TEXT_PERCENT}% when omitted; \`heightPct\`, \`heightPx\`, \`videoHeight\`, \`sample\`, \`readSaid\`); \`playerControls\`, an embedded player's controls, such as a timer \`0:02 / 0:14\`, visible in the framed picture (\`showing\`, \`frame\`); \`blankScreen\`, a framed screen showing almost nothing, such as a loading screen (\`detailPct\`, \`showing\`). Change the picture there, or keep one with why, as the skill and the editor ask.`,
    { version: z.string(), keep: z.array(z.object({ id: z.string(), reason: z.string().trim().min(1).max(300) })).max(100).optional(), offset: z.number().int().nonnegative().optional(),
      silencesFrom: z.number().finite().min(0.3).max(30).optional().describe("Shortest silence to list, in seconds, from the pace the skill asks for"),
      piecesUnder: z.number().finite().min(0.1).max(10).optional().describe("Longest short piece to list, in seconds, from the pace the skill asks for"),
      smallTextUnder: z.number().finite().min(0.5).max(10).optional().describe("Line height, in percent of the video's height, under which framed text is listed as smallText, from the readability the skill asks for") },
    async ({ version, keep, offset, silencesFrom, piecesUnder, smallTextUnder }) =>
      json(fitRepeatPage(await checkRepeats(version, keep, offset, silencesFrom, piecesUnder, smallTextUnder), offset ?? 0, caps.resultChars ?? DEFAULT_RESULT_CHARS)));

  tool("dialogue_check_join",
    `Check dialogue removals on a timeline version before saving them; this changes nothing. Give one range, or up to 100 as \`cuts\`, each given the same way. ${cutCoordinates} Where two words run together with no pause, an edge goes at the lowest level between them when that is at room tone (${DIP_DBFS} dBFS or lower) or a trough well under the sound either side, and the removal's other edge has a pause; an edge in sound with no quiet nearby moves to the nearest such trough. A word reference keeps its exact performance; alternativeWordRanges lists other indices that leave the same transcript text, with their edge problems and dips: submit the indices of the delivery you choose. A slow check returns status "measuring", the readings done and the zero-based pendingCuts: repeat the same arguments on the returned version after retryAfterSeconds.

Each join returns status (unchanged = both edges quiet; snapped = an edge moved a few frames onto silence and applies as given; adjusted/partial = a larger move that narrows the removal and goes to review; review = no safe edge), the resulting range, per edge (\`audio\`) its source second, sound (quiet | valley | sound), RMS dBFS in 20 ms steps from 0.3 s before to 0.3 s after it (\`|\` marks it) and the nearest quiet points either side, and nearbyWords as [timeline start, timeline end, text]. removes and plays are the words the removal takes out and its join as heard: read them before choosing which delivery goes. sameWordJoin, for a restart that begins on the word the first take broke off after with no pause to start in, gives where the first delivery begins, matched on sound, and as takesFirst the kept words the range leaves playing twice that a cut from there also takes; nothing measures how that join plays, so a cut saved there applies with unsureJoins cut and otherwise waits in review. The kept audio is read independently for up to ${JOIN_WORD_SECONDS} source seconds each side (unreadJoinAudio names a reading that was unavailable): repeatAtJoin, a word or phrase the join plays twice, both in timeline seconds; partialWordRepeat, a word fragment beside a complete delivery, crossfade included, its side and ranges on the input timeline; pickupRepeats, a doubled word or phrase opening or ending the kept take, with the side. acousticRetakeContinuity, where a scan measured an immediate restart, says which delivery the range removes and whether the word after the second stays joined to the kept take (source times approximate). resumeWith is checked at the original end.

With \`cuts\`, \`joins\` come back in order, and a range that can't be checked carries its own \`error\`. A list too long to return whole leaves out nearbyWords, \`audio\` and alternativeWordRanges, unchanged joins first, then the others from the end of the list, and then acousticRetakeContinuity and partialWordRepeat details. Every join keeps its status and range, and \`evidenceLeftOut\` lists those missing some: check them again in a shorter list.`,
    { version: z.string(), crossfadeFrames, pace: paceInput, breath: breathInput("fromWord/toWord", "The result's breath names any found, either way."), ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(), resumeWith,
      cuts: z.array(z.object(undescribed({ ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(), resumeWith })))
        .min(1).max(100).optional().describe("Several removals to check in one call, each with the fields a single range takes (described above)"),
      ...audioOption(listen?.by === "file"
        ? "Write WAV files of about two seconds of the original recording around each edge to your task folder to open with your file viewer, for a single range"
        : "Attach about two seconds of the original recording around each edge as WAV, for a single range") },
    async ({ version, includeAudio, resumeWith, cuts, crossfadeFrames = 0, pace, breath, ...cut }) => {
      const tl = await peekTimeline(version);
      const snapshot = tl.version === "draft" ? createHash("sha256").update(JSON.stringify(tl)).digest("hex") : tl.version;
      const wantAudio = !!listen && (includeAudio ?? defaultAudio);
      const key = JSON.stringify([snapshot, cuts, cut, resumeWith, crossfadeFrames, pace, breath, wantAudio]);
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
          const heard = await cutReading(tl, project, played, mediaId => transcriptWords(mediaId, false).catch(withoutOnce(`failed to read the words of ${mediaId} beside a cut`, null)));
          const continuity = acousticRetakeJoin(tl, project, range, scanReader.acousticRetakePages.values());
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
        if (!wantAudio || !listen) return result;
        for (const edge of checked.audio) {
          const from = Math.max(0, edge.at - 1), to = edge.at + 1;
          try {
            const { wav } = await client.sourceAudio(projectId, { mediaId: edge.mediaId, from, to });
            const note = `Original ${edge.edge} edge of ${edge.mediaId}: the boundary is ${(edge.at - from).toFixed(2)} s into this clip (source ${edge.at} s).`;
            if (listen.by === "file") {
              result.content.push(...await deliverWav(listen, wav, `listen/edge-${edge.edge}-${edge.mediaId}-${edge.at.toFixed(2)}.wav`,
                { edge: edge.edge, mediaId: edge.mediaId, at: edge.at, from, to, boundaryOffset: +(edge.at - from).toFixed(2) },
                `${note} Open this WAV file with your own file viewer to hear it.`, writeArtifact));
            } else {
              result.content.push({ type: "text", text: note }, { type: "audio", mimeType: "audio/wav", data: wav });
            }
          } catch (err) {
            noteEvidenceMiss("join audio");
            result.content.push({ type: "text", text: `Audio for the ${edge.edge} edge is unavailable: ${describeError(err)}. Judge it from the levels.` });
          }
        }
        return result;
      }, joinWaitMs ?? 40_000);
    });

  tool("dialogue_apply_cuts",
    `Save your decisions on an assembled version: cut, review (staged for the editor) or keep ranges, sorted and nonoverlapping; cuts apply together, and a range left out stays, as does footage between removals. ${cutCoordinates} Save a long pass in parts, each on the last part's \`continueFrom\`; on a first dialogue pass, send at most ${FIRST_CUT_BATCH_SIZE} nearby cut or review decisions as soon as they are ready, with the keep or protected ranges they depend on.

Scarlet measures every edge. One on sound moves a few frames onto silence, or onto the low point between two words said in one breath, and applies; between named words said straight through it goes where the transcript parts them. A larger move narrows the cut and stages it. An edge that can't leave sound is held; its reason says what the join plays and, for a range in seconds, the nearest quiet or low point either side. A retake with no quiet to start in, resuming on the word the first take broke off on, starts where that word's first delivery begins, matched on sound, and is staged; with unsureJoins cut it and a narrowed cut apply. If such a range leaves kept words playing twice, it is placed as given and the gate says from where a cut also takes them. A resumeWith quote the scan reads differently doesn't hold its cut: its gate line says what the scan reads. Left out with evidence in \`notSaved\`, while the rest saves: a coaching cut whose productionQuote doesn't verify; a cut whose join would play words twice or a kept word too quietly, or that removes a restart and runs on past it, taking edge words nothing either side of the join says again; a pause trim whose range holds speaking-level sound no word explains, or words the transcript doesn't have; a removeRepeat retake whose pair this version's check doesn't list.

Returns \`gate\`: changes to the measured plan with evidence, ranges before rounding to frames, and each applied cut with an edge within ${SPEECH_BESIDE_EDGE} s of the sound it removes (the picture can show a word start before its sound; yours to judge). timelineEdits: each saved edit's summary and range, to the millisecond. removes and plays, per applied retake or coaching cut: the words taken out and the join as heard; a cut named by indices gives its words (the first and last six if over fourteen). quietKeptWord: a short piece between cuts whose word is at room-tone level, with nearby measured sound in source seconds. What Scarlet changed on its own comes back with why (stagedForEditor, onFrames (its why on the first save only), droppedFromReview, heldCutsStay, settledApplied), as does joinCrossfades for a requested crossfade. carriedForward counts your previous part's staged ranges joining this review; heldForReview lists cuts already with the editor, which keep their passage and note.

Also what this part still plays, each once per pass, at \`at\` on continueFrom: keptSilences (undecided, wordless, from ${SILENCE_LEFT_SECONDS} s or your last silencesFrom) and keptPauses (the longest thirty from ${PAUSE_FLOOR_SECONDS} s or pausesFrom), each with the afterWord that trims it; repeatedWords (said twice in a row, with the pause between, atJoin when a cut made it; fromWord/toWord name the first); shortPieces (under ${SHORT_PIECE_SECONDS} s between two cuts of one recording, with plays, before, after, cutBefore and cutAfter); keptQuietPhrases (a faint line, with mediaId, fromWord/toWord, the phrase and levels beside it in dBFS); unexplainedSound (speaking-level sound with no transcript word, often a leftover take); heardNotInTranscript (words the scan read that the transcript lacks, such as a false start, with where they play and the words round them; cut them in timeline seconds). Evidence, not decisions: a pause can be a beat, a repeat emphasis, a sound a breath.`,
    { version: z.string(), description: z.string().min(1).describe("Your one-sentence summary of this save for the editor"), batchTitle: z.string().trim().min(1).max(80).optional().describe("Short plain-English title for these cuts together in the edits list, such as 'Filler word cuts'"), crossfadeFrames, pace: paceInput, breath: breathInput("fromWord/toWord or removeRepeat", "The gate names any found, either way."), unsureJoins: unsureJoinsInput, noteIds: z.array(z.string()).optional(),
      range: z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).optional().describe("Requested TIMELINE range if only part of the edit is in scope"),
      only: z.enum(["pause", "filler", "retake", "coaching"]).optional().describe("For a request limited to one kind of removal"),
      pausesFrom: z.number().finite().min(0.1).max(10).optional().describe(`Shortest pause, word to word in seconds, to list in keptPauses, from the pace the skill and the editor ask for; omitted, the longest from ${PAUSE_FLOOR_SECONDS} s`),
      cuts: z.array(z.object({ ...WordRef, ...PauseRef, start: z.number().finite().nonnegative().optional(), end: z.number().finite().positive().optional(),
        removeRepeat: z.object({ id: z.string(), occurrence: z.enum(["first", "second"]) }).optional().describe("For a retake: the occurrence dialogue_check_repeats heard on this version; Scarlet places both edges."),
        kind: z.enum(["pause", "filler", "retake", "coaching"]), decision: z.enum(["cut", "review", "keep"]),
        resumeWith,
        keepRepeat: z.union([repeatedPhrase, z.array(repeatedPhrase).min(1)]).optional().describe("Quote a word or phrase meant to repeat across the join or at either end of the kept take, or a list of them. A repeat not named here comes back to you unsaved."),
        dropWords: z.union([repeatedPhrase, z.array(repeatedPhrase).min(1)]).optional().describe("Quote words at an edge of the removal you mean to take out though nothing either side of the join says them again, as a returned dispute names them, or a list of them."),
        productionQuote: z.string().trim().min(1).optional().describe("For a coaching cut: the removed production aside's words, checked against the scan."),
        picture: z.enum(["safe", "uncertain", "protect"]).optional().describe("protect keeps this range; otherwise decision says whether it is cut or staged."),
        reason: z.string().trim().min(1).describe("One short sentence on why you chose to cut, stage or keep this passage, shown on its card"),
        summary: CutAssessment.shape.summary.describe(`Required for a cut or review. ${cutRow}`),
        check: z.string().trim().min(1).max(120).optional().describe("For a cut that applies: a few words naming a doubt the editor must settle by listening or looking, which holds it for them; omit when nothing is in doubt") })) },
    async ({ version, description, batchTitle, cuts: requested, noteIds, range, only, crossfadeFrames, pausesFrom, pace, breath, unsureJoins }) => {
      const unnamed = requested.flatMap((c, i) => c.decision !== "keep" && c.picture !== "protect" && !c.summary ? [i] : []);
      if (unnamed.length) throw new Error(`Give a summary for each cut and review: what it takes out and where, by the words beside it. Missing at cuts ${unnamed.join(", ")} (zero-based). Nothing was saved.`);
      const operation = await dialogueOperation();
      if (taskId && operation === "first-cut" && requested.filter(c => c.decision !== "keep" && c.picture !== "protect").length > FIRST_CUT_BATCH_SIZE)
        throw new Error(`Save up to ${FIRST_CUT_BATCH_SIZE} nearby cut or review decisions in each first-pass batch, with their keep and protected ranges. Send the first settled group now. For the next group use source word references or map its positions on continueFrom with timeline_at.`);
      const localPauses = operation === "local-pauses";
      const tl = await peekTimeline(version);
      // Edge checks, snapping, word references, quotes and the gate report: dialogue-plan.ts, shared with offline replay.
      // A retake cut named by a pair the repeat check of this version doesn't list can't be placed. Beside other cuts it
      // is set aside with that reason and they save, as a disputed cut is (planDialogueBatch); on its own it is refused.
      // A keep named that way is still refused with the batch: what it keeps is what the other cuts must not reach.
      const unpaired = new Set<number>();
      const pairs = new Map<number, NonNullable<ReturnType<typeof checkedRepeats.get>>>();
      const cuts = requested.map(({ removeRepeat, ...cut }, i) => {
        if (!removeRepeat) return cut;
        const pair = checkedVersion() === tl.version ? checkedRepeats.get(removeRepeat.id) : undefined;
        const occurrence = pair?.occurrences[removeRepeat.occurrence];
        if (cut.kind === "retake" && !occurrence && cut.decision !== "keep" && cut.picture !== "protect") {
          unpaired.add(i);
          return cut;
        }
        if (!occurrence || cut.kind !== "retake") throw new Error("Read dialogue_check_repeats on this version and select a removable occurrence for a retake.");
        pairs.set(i, pair!);
        return { ...cut, occurrence };
      });
      if (unpaired.size && requested.every((c, i) => unpaired.has(i) || c.decision === "keep" || c.picture === "protect"))
        throw new Error("Read dialogue_check_repeats on this version and select a removable occurrence for a retake.");
      const anchor = await cutAnchor(tl);
      const scope = range || localPauses || selectedRange(anchor) ? cutScope(tl, anchor, range, localPauses) : undefined;
      const request = { tl, cuts, range: scope, only, localPauses, anchor, unsureJoins, ...(unpaired.size && { setAside: unpaired }) };
      // A dispute sets aside only the cuts it names; the rest of the batch is saved (planDialogueBatch).
      const batch = await planDialogueBatch(request, { ...planSources, crossfadeFrames, pace, breath });
      const plan = batch.plan;
      const unpairedNext = (restSaved: boolean) => unpaired.size ? `The repeat check of version ${tl.version} doesn't list the pair cuts ${[...unpaired].join(", ")} name, ` +
        `so they were not saved${restSaved ? "; the rest of the batch was" : ""}. Read dialogue_check_repeats on ${restSaved ? "continueFrom" : "this version"} and resubmit them with a pair it lists.` : "";
      const setAside = (batch.setAside || unpaired.size) ? {
        cuts: [...new Set([...(batch.setAside?.cuts ?? []), ...unpaired])].sort((a, b) => a - b),
        ...(batch.setAside && { disputedEdges: batch.setAside.disputedEdges.map(({ cuts: _cuts, ...edge }) => edge) }),
        next: [batch.setAside && `These cuts were not saved; the rest of the batch was. ${refusalNext(batch.setAside.disputedEdges)} Resubmit only these on continueFrom.`, unpairedNext(true)].filter(Boolean).join(" "),
      } : undefined;
      const recordKept = (ranges: TimeRange[]) => ranges.length && taskId
        ? postEvent({ type: "log", text: "", data: { kind: "dialogue_preserved", version: tl.version, ranges } }) : undefined;
      if (plan.outcome === "preserved") {
        await recordKept(plan.kept ?? []);
        scanReader.batchesSaved(tl, plan.kept ?? []);
        return text("All listed passages were preserved.");
      }
      if (plan.outcome === "needsRevision") return json({ needsRevision: true, disputedEdges: plan.disputedEdges,
        next: [`Nothing was saved. ${refusalNext(plan.disputedEdges)}`, unpairedNext(false)].filter(Boolean).join(" ") });
      // A ripple affects every track. Check the whole batch, including any edge adjustment, against the sayings it must retain.
      // The pair each cut was placed from, as it was read then: a check of the repeats that ran meanwhile may have dropped it.
      const retainedRepeats = requested.flatMap((c, i) => {
        const pair = pairs.get(i);
        if (!c.removeRepeat || !pair || c.decision === "keep" || c.picture === "protect") return [];
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
          .catch(without("failed to read what this part still plays", { pauses: [], repeats: [], gaps: [], transcripts: new Map<string, TranscriptWord[]>() })));
      // A save that fails still waits for them, so its result says what they went without.
      const result = await client.submitDialogueCuts(projectId, { fromVersion: tl.version, description, ...(batchTitle && { batchTitle }), cuts: all, range: scope, kept: plan.kept, crossfadeFrames,
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
      scanReader.batchesSaved(tl, [...all, ...plan.kept]);
      scanReader.readSaved();
      const reach = cutsReach(tl, all);
      for (const [mediaId, to] of reach) cutTo.set(mediaId, Math.max(cutTo.get(mediaId) ?? 0, to));
      // How far into each recording the saved cuts reach, so the editor's cut figure moves with every part: to the end
      // of the furthest cut, on the recordings the pass cuts. A pass that reads a whole recording before it saves its
      // first part has read to the end by then, and reporting the read finished the cut at that first save. The read
      // counts only where this part's cuts come within a page of it: a pass that saves as it reads has decided what it
      // read, and the last part finishes the cut though its last cut stops a little short of the recording's end.
      for (const [mediaId, to] of cutTo) {
        const read = scanReader.readThrough(mediaId), here = reach.get(mediaId);
        await postEvent({ type: "log", text: "", data: { kind: "pass_progress", mediaId, through: here !== undefined && here >= read - 60 ? Math.max(read, to) : to } });
      }
      moveBase(undefined);
      for (const c of result.changes) await postEvent({ type: "change", text: c.description,
        data: { changeId: c.id, toVersion: c.toVersion, state: c.state } });
      // Applied cuts move the edit forward. A part that only stages cuts leaves it where it was.
      const { head, changes: savedChanges, onFrames, ...saved } = result;
      const reported = { changes: receiptChanges(savedChanges), ...saved, ...(onFrames && { onFrames: receiptOnFrames(onFrames, framesExplained) }) };
      if (onFrames) framesExplained = true;
      const continueFrom = head ?? result.changes.find(c => c.intent !== "suggestion")?.toVersion ?? tl.version;
      const decided = [...all, ...plan.kept, ...(result.editorDecided ?? [])];
      // A stretch already listed as a kept silence is not listed again as a pause.
      const pauses = (only && only !== "pause" ? [] : left.pauses.filter(p => !undecided.some(u => u.mediaId === p.mediaId && u.source.start < p.source.end && u.source.end > p.source.start)))
        .filter(p => fresh("pause", p.mediaId, p.source.start, p.seconds));
      const repeats = (only && only !== "retake" && only !== "filler" ? [] : left.repeats).filter(r => fresh("repeat", r.mediaId, r.source));
      // The lists read at once: each lists its own kind of thing once per pass (`listed`), and they share one read of the
      // version the pass continues on (`timelineAt`).
      const [quiet, { kept, keptPauses, repeatedWords, unexplainedSound }, [heardNotInTranscript, shortPieces, audioRecheck]] = await together(
        async () => localPauses || only === "pause" || only === "filler" ? [] : await keptQuietPhrases(tl, continueFrom, decided, scope ?? spanOf(decided))
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
          const part = scope ?? spanOf(decided);
          // The part's stretch on the version it continues on: its applied cuts closed up that much of it.
          const removed = result.changes.some(c => c.intent !== "suggestion" && c.state === "approved")
            ? all.reduce((n, d) => d.review ? n : n + Math.max(0, Math.min(d.end, part.end) - Math.max(d.start, part.start)), 0) : 0;
          const partAfter = { start: part.start, end: Math.max(part.start, part.end - removed) };
          // Words the scan read in what this part still plays that the transcript has no word for. A false start the
          // transcript tidied away has no index to cut it by and is in none of the lists above: a pass left “And it just
          // feel, uh” playing before “It just feels like”, and “a conscious conscientious objector”, having cut by a
          // transcript that read “And it just feels like” and “a conscientious objector” (2026-11-19).
          const heard = only && only !== "retake" && only !== "filler" ? [] : await (async () => {
            const after = await timelineAt(continueFrom, tl);
            const found = await getPerception().heardOnlyOn(after, partAfter);
            return found.filter(h => fresh("heard", h.mediaId, h.source.start)).slice(0, 30)
              .map(h => candidate({ at: h.start, seconds: round2(h.end - h.start), text: h.text, context: h.context,
                mediaId: h.mediaId, sourceSeconds: [h.source.start, h.source.end] }, "heard", h.mediaId, h.source.start));
          // An extra reading: a version or an engine that can't give it leaves the receipt as it was.
          })().catch(withoutOnce(`failed to read the words heard only in the part on ${continueFrom}`, []));
          // Short pieces left stranded between two cuts on the continued timeline, under the pace the pass last gave the
          // repeat check (piecesUnder), so this list and the closing check agree on what a stutter piece is.
          const short = await (async () => {
            if (!decided.length) return [];
            const after = await timelineAt(continueFrom, tl);
            const under = piecesAsked() ?? SHORT_PIECE_SECONDS;
            const margin = { start: Math.max(0, partAfter.start - under), end: partAfter.end + under };
            return shortPiecesInPart(after, margin, left.transcripts, under)
              .filter(p => fresh("shortPiece", p.mediaId, p.source.start)).slice(0, 30)
              .map(({ source, ...p }) => candidate(p, "shortPiece", p.mediaId, source.start));
          })().catch(withoutOnce(`failed to find the short pieces left in the part on ${continueFrom}`, []));
          // The repeat check comes after those words: where it reads a language from the scan, it saves pages they'd read.
          const recheck = checkedVersion() === tl.version || task?.repeatAudit?.version === tl.version
            ? await checkRepeats(continueFrom).catch((error: Error) => {
              noteEvidenceMiss("repeat audit");
              return { version: continueFrom, error: error.message, next: "The edit was saved. Retry dialogue_check_repeats on this version." };
            })
            : undefined;
          return [heard, short, recheck] as const;
        });
      const maxChars = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      const gate = receiptGate(dialogueGate(plan));
      const next = result.changes.some(c => c.intent === "suggestion")
        ? "Pending ranges are on the kept version. The editor sees a staged cut as a call only once it has your recommendation, so record them on this part before you read on: dialogue_review_inspect gives their context, up to four at once with count while Scarlet prepares the next ones, and dialogue_review_save records a recommendation. Recommendations carry into the review of your next part."
        : undefined;
      let recheckOut: unknown = audioRecheck;
      const keptOut = kept.slice();
      const pausesOut = keptPauses.slice();
      const repeatsOut = repeatedWords.slice();
      const shortOut = shortPieces.slice();
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
        ...(shortOut.length && { shortPieces: shortOut.map(c => c.item) }),
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
          ["shortPieces", shortOut],
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
      for (const list of [pausesOut, repeatsOut, shortOut, soundOut, heardOut, quietOut]) {
        for (const entry of list) listed.add(entry.key);
      }
      return json(receipt);
    });
}
