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
import { PAUSE_FLOOR_SECONDS } from "./dialogue-leftovers.js";
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
import { createDialoguePartLeftovers } from "./dialogue-part-leftovers.js";
import { createDialogueRepeatCheck } from "./dialogue-repeat-check.js";
import { createDialogueScanReader } from "./dialogue-scan-reader.js";
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
  getPerception(): PerceptionApi;
}

export function registerDialogueTools(deps: DialogueToolsDeps) {
  const {
    tool, client, projectId, taskId, task, author, caps, joinWaitMs,
    evidence, session, errors, stagedState,
    dialogueOperation, readPassage, postEvent, prepareReview, getPerception,
  } = deps;
  const {
    getProject, peekTimeline, moveBase, cutAnchor, transcriptWords,
    gapSounds, measureAround, joinPages, measureTimeline,
    refusalNext, planSources,
  } = session;
  const { without, withoutOnce, together } = errors;
  const hearing = caps.audio;
  const audioOption = createAudioOption(hearing);

  const joinChecks = new JoinChecks(caps.resultChars);
  const scanReader = createDialogueScanReader(deps);
  const { checkRepeats, checkedRepeats, checkedVersion, silencesAsked } = createDialogueRepeatCheck(deps);
  const { passedSilences, listed, fresh, candidate, passedLeftovers, timelineAt, placeSilences, keptQuietPhrases } =
    createDialoguePartLeftovers({ ...deps, silencesAsked });

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

  tool("dialogue_scan",
    "Read a dialogue recording in pages (60 s pages overlapping by 2 s, source seconds). Start at the beginning of the requested range, also when resuming; read the page and any restoredPages, then call again with nextFrom until it is null. On a first dialogue cut, save decided cuts when a page returns saveCheckpoint before reading the next section. During a task Scarlet scans the whole range in the background, so later pages often return at once; a page still analyzing says so, and you can collect it after reviewing other material. Each page: passages (spoken text, with `words` = [first, last] transcript_get indices once the saved transcript's words are placed on the audio that far), repeatedTakes (attempts at the same line with the source times and continuation of each; evidence, not a decision), acousticRepeatedTakes (adjacent deliveries independently decoded from cached English speech, with approximate source times and continuation), fillers and fillerCandidates (each with the detectors that heard it: whisper = verbatim transcription, uhm = acoustic filler model; both agreeing is the strongest evidence), pauses (quiet interiors that could be removed, with the air either side), silences (every stretch of 1.5 s or more with no transcript word, whatever sounds in it: the words either side, voiceSeconds the voice detector fired inside it with no word, as typing or a breath does, and, where the current edit shows video through it, picture per video source: changedFrames of frames, the typical and the largest changed region in percent of the frame, and when the largest and the last change happen in this recording's seconds; `measuring` is ready on the next read of the page), unmatchedVoice (voice activity no transcript word explains: breaths, overlapping talk or missed words), speakerTurns (recording-local voice numbers; a number marks a distinct voice, and only confirmed input roles say which is the presenter), otherVoiceTurns (on a recording with a mix and two isolated inputs: each stretch of sound on the input the dialogue is not on, such as a remote voice or a system sound, with the words heard only there and meAlsoActive when the dialogue input sounded too), roomToneDbfs, and quietPhrases (transcribed words much quieter than the speech on both sides, with source seconds, fromWord/toWord, and the phrase and neighboring levels in dBFS). detectorIssue names incomplete evidence.",
    { mediaId: z.string(), from: z.number().finite().nonnegative().default(0),
      until: z.number().finite().positive().optional().describe("Exclusive end of the requested source range. Defaults to the end of this recording."),
      noCutsReadyThrough: z.number().finite().nonnegative().optional().describe("The through value of a saveCheckpoint, only if this section has no settled cuts to save yet.") },
    args => scanReader.scan(args));

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

  tool("dialogue_apply_cuts",
    `Save your decisions on an assembled version: cut, review or keep ranges, sorted and nonoverlapping. ${cutCoordinates} Cut ranges apply together; review stages a range for the editor; keep or omission retains it. Scarlet measures each retake, filler, pause and quoted production edge. An edge on sound moves a few frames onto silence, or onto the low point between two words said in one breath, and applies; an edge between named words said straight through, with no low point, goes where the transcript parts them and applies; a larger move narrows the cut and stages it, unless unsureJoins is cut. An edge Scarlet can't move out of sound stays held, and its held reason says what the join plays, what the passage plays if the cut is kept and, for a range given in seconds, the nearest quiet or low point either side and the words moving there keeps or removes. A pause's edge moves onto the quiet beside it. A retake cut with no quiet to start in, where the take resumes on the word the first take broke off on, starts where the first delivery of that word begins, matched on the sound of the two; nothing measured says how that join plays, so it is staged, unless unsureJoins is cut. A range that leaves kept words playing twice that way is placed as given, and the gate says from where a cut takes them out too. A short piece between cuts with a transcript word at room-tone level returns quietKeptWord with nearby measured sound in source seconds. Footage between separate removals stays in the timeline. \`gate\` lists changes to the measured plan with their evidence. Its ranges describe placement before the engine rounds to project frames. The returned timelineEdits describe the saved edits. A cut whose optional quote doesn't verify, whose join would play words twice or a kept word too quietly, or that removes a restart and runs on past it, taking words at its edge that nothing either side of the join says again, or a pause trim whose range holds sound at speaking level that no word explains or whose pause holds words the transcript doesn't have, is left out with its evidence in \`notSaved\`, and the rest of the part saves. Save a long pass in parts and continue on \`continueFrom\`. For a first dialogue pass, send at most ${FIRST_CUT_BATCH_SIZE} nearby cut or review decisions as soon as they are ready, with any keep or protected ranges they depend on. The gate reports an applied cut whose edge sits within ${SPEECH_BESIDE_EDGE} s of the sound it removes, since the picture can show a word starting that the sound has not reached; whether that needs the editor is yours to judge. Each applied retake or coaching cut is listed with removes and plays: the words it takes out and its join as the viewer hears it. What Scarlet changed on its own comes back with why: \`stagedForEditor\` (confident cuts that wait for the editor), \`onFrames\` (edges put on whole frames), \`droppedFromReview\` (an earlier part's staged cuts whose footage a later edit broke up) and \`heldCutsStay\` (cuts not saved because, sent with unsureJoins cut, they would have replaced a staged cut held for its join with other edges Scarlet couldn't place either). For a requested crossfade, \`joinCrossfades\` reports how many joins were faded and why any stayed straight. The result also lists what this part still plays, each thing once per pass, at \`at\` on continueFrom: keptSilences (${SILENCE_LEFT_SECONDS} s or more without words that no decision covers, the silences dialogue_check_repeats lists, or from the length you last gave it as silencesFrom, with the afterWord that trims an untouched one), keptPauses (the longest thirty of ${PAUSE_FLOOR_SECONDS} s or more, or from the length you give as pausesFrom, with the afterWord that trims an untouched one), repeatedWords (said twice in a row, with the pause the edit plays between them, atJoin when a cut made it; fromWord/toWord name the first) unexplainedSound (speaking-level sound the transcript has no word for, often what is left of a take beside a cut) and heardNotInTranscript (words the scan read in what this part still plays that the transcript has no word for, such as a false start or a repeat it tidied away: where and how long they play on the version the part continues on, the words, and the words round them as the scan read them; they have no word index, so a cut of them is given in timeline seconds). These are evidence, not decisions: a pause can be a beat, a repeat emphasis, a sound a breath. Ranges your previous part staged on that version join this part's review (carriedForward). Cuts already handed to the editor keep their passage and note (heldForReview). \`description\` is your one-sentence summary for the editor.`,
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
        const occurrence = checkedVersion() === tl.version && checkedRepeats.get(removeRepeat.id)?.occurrences[removeRepeat.occurrence];
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
        scanReader.batchesSaved(tl, plan.kept ?? []);
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
          const recheck = checkedVersion() === tl.version || task?.repeatAudit?.version === tl.version
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
